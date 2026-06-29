import { CHUNK, DOOR_SALT, vIdx, hIdx } from './constants.js'
import { hash2i } from './core/hash.js'

// Decorative-door detection (THREE-free, so it runs headless under Vitest).
//
// A "doorway" is a single-cell gap punched through a wall line: an open edge
// (value 0) whose two ALONG-LINE neighbours are walls. Out-of-range neighbours
// count as walls, so a seam door at row 0 / CHUNK-1 still registers. This rule
// selects office room doors and office-seam lattice doors, and naturally rejects
// wide office<->open transition mouths (their middle cells have OPEN neighbours)
// and open pillar/warehouse halls (no wall neighbours at all).
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

// Resolve the per-door cosmetic flags. `lo`/`hi` mark whether a REAL in-range
// wall exists on the low / high side, so the open leaf always lies against an
// actual wall (never floats off the chunk edge).
function decorate(axis, line, cell, lo, hi, ga, gb, salt, fraction) {
  const h = hash2i(salt, ga, gb)
  const leaf = h / 4294967296 < fraction
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
      if (data.wallV[vIdx(lx, z)] !== 0) continue
      const lo = z > 0 && data.wallV[vIdx(lx, z - 1)] === 1
      const hi = z < CHUNK - 1 && data.wallV[vIdx(lx, z + 1)] === 1
      if (!(z === 0 || lo) || !(z === CHUNK - 1 || hi)) continue
      out.push(decorate('v', lx, z, lo, hi, cx * CHUNK + lx, cz * CHUNK + z, SALT_V, fraction))
    }
  }

  // Horizontal lines (lz): a gap runs along x; neighbours are the line at x +/- 1.
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let x = 0; x < CHUNK; x++) {
      if (data.wallH[hIdx(x, lz)] !== 0) continue
      const lo = x > 0 && data.wallH[hIdx(x - 1, lz)] === 1
      const hi = x < CHUNK - 1 && data.wallH[hIdx(x + 1, lz)] === 1
      if (!(x === 0 || lo) || !(x === CHUNK - 1 || hi)) continue
      out.push(decorate('h', lz, x, lo, hi, cx * CHUNK + x, cz * CHUNK + lz, SALT_H, fraction))
    }
  }

  return out
}
