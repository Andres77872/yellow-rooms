import {
  CHUNK,
  ZONE_OFFICE,
  ZONE_PILLARS,
  ZONE_SEWER,
  ZONE_WAREHOUSE,
} from './constants.js'
import { hash2i } from './core/hash.js'
import {
  PASSAGE_DOOR,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
} from './mapTypes.js'
import { selectZone } from './regions.js'
import {
  chunksShareOfficeDistrict,
  officeDistrictHContract,
  officeDistrictVContract,
  officeInternalHContract,
  officeInternalVContract,
} from './zones/officePlan.js'

// Per-edge border reconciliation. A shared border is identified by its lower
// chunk coordinate, so both neighbours compute an identical wall + passage
// contract from the same key without communication.
//
// The seam style is ZONE-PAIR-AWARE (see config.border.pairModes) so the world
// reads as a continuation rather than a grid of walled boxes. Unlisted,
// unrelated pairs preserve the established config.border.openness fallback:
//   - both OPEN  (pillars/warehouse): seam left open so halls merge into one
//     liminal space; two warehouses may get a short wall STUB as a landmark.
//   - one OPEN   (office<->open): a walled partition with a wide transition
//     MOUTH, so rooms open into the hall instead of via a single door.
//   - both WALLED: an exact internal plan slice, a canonical district portal,
//     or a deterministic fallback partition for custom zone openness settings.

const isOpen = (zone, b) => (b.openness[zone] ?? 0) >= 1
const PAIR_MODES = new Set(['mouth', 'open'])
const REQUIRED_SEWER_NEIGHBOURS = new Set([
  ZONE_OFFICE,
  ZONE_PILLARS,
  ZONE_WAREHOUSE,
])
const doorPos = (salt, kx, kz) => 1 + (hash2i(salt | 0, kx, kz) % (CHUNK - 2)) // [1, CHUNK-2]

const pairKey = (za, zb) => [za, zb].sort((a, b) => a - b).join('<->')
const configuredPairMode = (pairModes, za, zb) => pairModes?.[za]?.[zb]
const isRequiredSewerPair = (za, zb) =>
  (za === ZONE_SEWER && REQUIRED_SEWER_NEIGHBOURS.has(zb)) ||
  (zb === ZONE_SEWER && REQUIRED_SEWER_NEIGHBOURS.has(za))

// Pair rules are physically symmetric even though configuration entries are
// ordered. One direction governs both queries; equal reverse duplicates are
// harmless, while conflicting duplicates are rejected with an order-stable
// reason. Only unrelated pairs may use the legacy scalar fallback.
export function borderPairMode(za, zb, config) {
  const pairModes = config?.border?.pairModes
  const forward = configuredPairMode(pairModes, za, zb)
  const reverse = configuredPairMode(pairModes, zb, za)
  const key = pairKey(za, zb)

  if (forward !== undefined && reverse !== undefined && forward !== reverse) {
    throw new Error(`conflicting border pair modes: ${key}`)
  }

  const explicit = forward ?? reverse
  if (explicit !== undefined) {
    if (!PAIR_MODES.has(explicit)) throw new Error(`invalid border pair mode: ${key}`)
    return explicit
  }

  if (isRequiredSewerPair(za, zb)) {
    throw new Error(`missing border pair mode: ${key}`)
  }

  const border = config.border
  const openA = isOpen(za, border)
  const openB = isOpen(zb, border)
  if (openA && openB) return 'open'
  if (openA || openB) return 'mouth'
  return 'office'
}

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
function mouth(out, kx, kz, seed, salt, config) {
  const b = config.border
  out.fill(1)
  const h = hash2i((seed ^ salt ^ b.mouthSalt) | 0, kx, kz)
  const w = b.mouthWidth[0] + (h % (b.mouthWidth[1] - b.mouthWidth[0] + 1))
  const lo = 1
  const hi = CHUNK - 2
  const half = w >> 1
  const room = Math.max(1, hi - half - (lo + half) + 1)
  const center = lo + half + ((h >>> 8) % room)
  for (let i = 0; i < w; i++) {
    const p = center - half + i
    if (p >= lo && p <= hi) out[p] = 0
  }
  return out
}

// Fallback for custom configurations that mark a non-office style as walled.
// Office-to-office seams use the district planner and never reach this path.
function partition(out, kx, kz, seed, salt) {
  out.fill(1)
  out[doorPos((seed ^ salt) | 0, kx, kz)] = 0
  return out
}

function reconcile(za, zb, kx, kz, seed, salt, config) {
  const b = config.border
  const out = new Uint8Array(CHUNK)
  const mode = borderPairMode(za, zb, config)
  if (mode === 'open') {
    if (za === ZONE_WAREHOUSE && zb === ZONE_WAREHOUSE) addStub(out, kx, kz, seed, salt, b)
    return makeContract('open', out)
  }
  if (mode === 'mouth') return makeContract('mouth', mouth(out, kx, kz, seed, salt, config))
  return makeContract('office', partition(out, kx, kz, seed, salt))
}

function makeContract(kind, walls) {
  const passages = new Uint8Array(CHUNK)
  const openKind = kind === 'office' ? PASSAGE_DOOR : kind === 'mouth' ? PASSAGE_WIDE : PASSAGE_OPEN
  for (let i = 0; i < CHUNK; i++) passages[i] = walls[i] ? PASSAGE_WALL : openKind
  return { kind, walls, passages }
}

// Vertical border between chunk (kx,kz)[east face] and (kx+1,kz)[west face].
// Rows run along z; office seams are exact district-plan slices or macro portals.
// `layerContext` is {rootSeed, layerSeed, cy}; it keeps plan-aware stair
// reservations identical between seam compilation and chunk slicing.
export function vBorderContract(kx, kz, seed, config, layerContext = null) {
  const za = selectZone(kx, kz, seed, config)
  const zb = selectZone(kx + 1, kz, seed, config)
  if (za === ZONE_OFFICE && zb === ZONE_OFFICE) {
    if (chunksShareOfficeDistrict(kx, kz, kx + 1, kz, config)) {
      return officeInternalVContract(seed, kx, kz, config, layerContext)
    }
    return officeDistrictVContract(seed, kx, kz, config)
  }
  return reconcile(za, zb, kx, kz, seed, config.border.saltV, config)
}

// Horizontal border between chunk (kx,kz)[south face] and (kx,kz+1)[north face].
// Columns run along x; office seams are exact district-plan slices or macro portals.
export function hBorderContract(kx, kz, seed, config, layerContext = null) {
  const za = selectZone(kx, kz, seed, config)
  const zb = selectZone(kx, kz + 1, seed, config)
  if (za === ZONE_OFFICE && zb === ZONE_OFFICE) {
    if (chunksShareOfficeDistrict(kx, kz, kx, kz + 1, config)) {
      return officeInternalHContract(seed, kx, kz, config, layerContext)
    }
    return officeDistrictHContract(seed, kx, kz, config)
  }
  return reconcile(za, zb, kx, kz, seed, config.border.saltH, config)
}

export const vBorder = (kx, kz, seed, config, layerContext = null) =>
  vBorderContract(kx, kz, seed, config, layerContext).walls
export const hBorder = (kx, kz, seed, config, layerContext = null) =>
  hBorderContract(kx, kz, seed, config, layerContext).walls
