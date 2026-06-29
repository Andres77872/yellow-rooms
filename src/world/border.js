import { CHUNK, ZONE_WAREHOUSE } from './constants.js'
import { hash2i } from './core/hash.js'
import { nearestOfficeGuideLocal, officeGuidePositions } from './layoutGuides.js'
import { selectZone } from './zones/index.js'

// Per-edge border reconciliation. A shared border is identified by its LOWER
// chunk coordinate, so both neighbours compute the IDENTICAL doorway array from
// the same key — seams are consistent with no communication. Returns a
// Uint8Array(CHUNK): 1 = wall at that row/col, 0 = doorway/open.
//
// The seam style is ZONE-AWARE (see config.border.openness) so the world reads
// as a continuation rather than a grid of walled boxes:
//   - both OPEN  (pillars/warehouse): seam left open so halls merge into one
//     liminal space; two warehouses may get a short wall STUB as a landmark.
//   - one OPEN   (office<->open): a walled partition with a wide transition
//     MOUTH, so rooms open into the hall instead of via a single door.
//   - both WALLED(office<->office): a partition whose doorways snap to the
//     GLOBAL office corridor guide field, so openings line up across seam after
//     seam — corridors of doorways run for miles. Corners always stay walled.
// Every branch leaves >=1 open cell, so the infinite graph stays connected.

const isOpen = (zone, b) => (b.openness[zone] ?? 0) >= 1
const doorPos = (salt, kx, kz) => 1 + (hash2i(salt | 0, kx, kz) % (CHUNK - 2)) // [1, CHUNK-2]

// warehouse<->warehouse only: drop a short wall fragment along the open seam as a
// navigational landmark (kept well inside the interior; corners stay open).
function addStub(out, kx, kz, seed, salt, b) {
  const h = hash2i((seed ^ salt ^ b.stubSalt) | 0, kx, kz)
  if (h / 4294967296 >= b.stubChance) return
  const len = b.stubLen[0] + ((h >>> 4) % (b.stubLen[1] - b.stubLen[0] + 1))
  const span = Math.max(1, CHUNK - 2 - len + 1) // start positions keeping the stub in [1, CHUNK-2]
  const start = 1 + ((h >>> 12) % span)
  for (let i = 0; i < len; i++) out[start + i] = 1
}

// office<->open: wall the seam but carve a wide contiguous mouth (a threshold the
// rooms spill through), centred in the interior so the corners stay walled.
function mouth(out, kx, kz, gBase, axis, seed, salt, config) {
  const b = config.border
  out.fill(1)
  const h = hash2i((seed ^ salt ^ b.mouthSalt) | 0, kx, kz)
  const w = b.mouthWidth[0] + (h % (b.mouthWidth[1] - b.mouthWidth[0] + 1))
  const lo = 1
  const hi = CHUNK - 2
  const half = w >> 1
  const room = Math.max(1, hi - half - (lo + half) + 1)
  let center = lo + half + ((h >>> 8) % room)
  center = nearestOfficeGuideLocal(gBase, center, seed, config, axis)
  center = Math.max(lo + half, Math.min(hi - half, center))
  for (let i = 0; i < w; i++) {
    const p = center - half + i
    if (p >= lo && p <= hi) out[p] = 0
  }
  return out
}

// office<->office: partition with doorways on the GLOBAL office guide field.
// `gBase` is the global index of the seam's first cell (kz*CHUNK for a vertical
// seam, kx*CHUNK for a horizontal one), and the axis selects guide rows/columns.
function partition(out, gBase, kx, kz, seed, salt, config, axis) {
  const b = config.border
  out.fill(1)
  let n = 0
  for (const i of officeGuidePositions(gBase, seed, config, axis, true)) {
    out[i] = 0
    n++
  }
  // Safety net: guarantee >= officeMinDoors even if the lattice landed sparse.
  for (let g = 0; n < b.officeMinDoors && g < CHUNK; g++) {
    const p = doorPos((seed ^ salt) | 0, kx + g, kz)
    if (out[p] === 1) {
      out[p] = 0
      n++
    }
  }
  return out
}

function reconcile(za, zb, kx, kz, gBase, axis, seed, salt, config) {
  const b = config.border
  const out = new Uint8Array(CHUNK)
  const openA = isOpen(za, b)
  const openB = isOpen(zb, b)
  if (openA && openB) {
    if (za === ZONE_WAREHOUSE && zb === ZONE_WAREHOUSE) addStub(out, kx, kz, seed, salt, b)
    return out // open seam (halls merge); maybe one short stub landmark
  }
  if (openA || openB) return mouth(out, kx, kz, gBase, axis, seed, salt, config) // transition threshold
  return partition(out, gBase, kx, kz, seed, salt, config, axis) // office<->office
}

// Vertical border between chunk (kx,kz)[east face] and (kx+1,kz)[west face].
// Rows run along z, so the lattice aligns on global rows (gBase = kz*CHUNK).
export function vBorder(kx, kz, seed, config) {
  const za = selectZone(kx, kz, seed, config)
  const zb = selectZone(kx + 1, kz, seed, config)
  return reconcile(za, zb, kx, kz, kz * CHUNK, 'z', seed, config.border.saltV, config)
}

// Horizontal border between chunk (kx,kz)[south face] and (kx,kz+1)[north face].
// Columns run along x, so the lattice aligns on global cols (gBase = kx*CHUNK).
export function hBorder(kx, kz, seed, config) {
  const za = selectZone(kx, kz, seed, config)
  const zb = selectZone(kx, kz + 1, seed, config)
  return reconcile(za, zb, kx, kz, kx * CHUNK, 'x', seed, config.border.saltH, config)
}
