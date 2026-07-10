import { CHUNK, DOOR_SALT, vIdx, hIdx } from './constants.js'
import { hash2i } from './core/hash.js'
import { PASSAGE_DOOR, PASSAGE_WIDE } from './mapTypes.js'

// Decorative-door detection (THREE-free, so it runs headless under Vitest).
//
// Doorways are explicit generation metadata. Earlier versions inferred them
// from one-cell raster gaps, which produced fake frames on warehouse chunk
// boundaries because the detector could not inspect the neighbouring chunk.
//
// Returns descriptors in GRID space — mesh.js turns them into instance
// transforms. `leaf` (show an open door panel?), `hinge` (which side the panel
// lies against) and `face` (which wall face) are derived deterministically from
// the doorway's GLOBAL edge coordinate, so a given doorway always looks identical
// across chunk reloads; it varies between seeds only because the wall layout does.
//
//   { axis: 'v'|'h', line, cell, leaf, hinge: -1|1, face: -1|1 }
//     v: line = lx (vertical grid line), cell = z (row along the line)
//     h: line = lz (horizontal grid line), cell = x (column along the line)

const SALT_V = DOOR_SALT
const SALT_H = (DOOR_SALT ^ 0x68f1) | 0

// Late anomaly and transition carving can remove the last wall beside a door.
// Preserve the opening, but reclassify it as a wide threshold so rendering
// never places an unsupported frame into open floor.
export function normalizeDoorPassages(data) {
  let normalized = 0
  for (let lx = 0; lx < CHUNK; lx++) {
    for (let z = 0; z < CHUNK; z++) {
      if (data.passageV[vIdx(lx, z)] !== PASSAGE_DOOR) continue
      const lo = z > 0 && data.wallV[vIdx(lx, z - 1)] === 1
      const hi = z < CHUNK - 1 && data.wallV[vIdx(lx, z + 1)] === 1
      if (lo || hi) continue
      data.setPassageV(lx, z, PASSAGE_WIDE)
      normalized++
    }
  }
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let x = 0; x < CHUNK; x++) {
      if (data.passageH[hIdx(x, lz)] !== PASSAGE_DOOR) continue
      const lo = x > 0 && data.wallH[hIdx(x - 1, lz)] === 1
      const hi = x < CHUNK - 1 && data.wallH[hIdx(x + 1, lz)] === 1
      if (lo || hi) continue
      data.setPassageH(x, lz, PASSAGE_WIDE)
      normalized++
    }
  }
  return normalized
}

// Resolve the per-door cosmetic flags. `lo`/`hi` mark whether a REAL in-range
// wall exists on the low / high side, so the open leaf always lies against an
// actual wall (never floats off the chunk edge).
function decorate(axis, line, cell, lo, hi, ga, gb, salt, fraction) {
  const h = hash2i(salt, ga, gb)
  const leaf = (lo || hi) && h / 4294967296 < fraction
  const hinge = lo && hi ? ((h & 1) === 1 ? 1 : -1) : hi ? 1 : -1
  const face = (h & 2) === 2 ? 1 : -1
  return { axis, line, cell, leaf, hinge, face }
}

export function collectDoorways(data, fraction) {
  const out = []
  const cx = data.cx
  const cz = data.cz

  // Vertical lines (lx): a gap runs along z; neighbours are the line at z +/- 1.
  for (let lx = 0; lx < CHUNK; lx++) {
    for (let z = 0; z < CHUNK; z++) {
      if (data.passageV[vIdx(lx, z)] !== PASSAGE_DOOR) continue
      const lo = z > 0 && data.wallV[vIdx(lx, z - 1)] === 1
      const hi = z < CHUNK - 1 && data.wallV[vIdx(lx, z + 1)] === 1
      out.push(decorate('v', lx, z, lo, hi, cx * CHUNK + lx, cz * CHUNK + z, SALT_V, fraction))
    }
  }

  // Horizontal lines (lz): a gap runs along x; neighbours are the line at x +/- 1.
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let x = 0; x < CHUNK; x++) {
      if (data.passageH[hIdx(x, lz)] !== PASSAGE_DOOR) continue
      const lo = x > 0 && data.wallH[hIdx(x - 1, lz)] === 1
      const hi = x < CHUNK - 1 && data.wallH[hIdx(x + 1, lz)] === 1
      out.push(decorate('h', lz, x, lo, hi, cx * CHUNK + x, cz * CHUNK + lz, SALT_H, fraction))
    }
  }

  return out
}
