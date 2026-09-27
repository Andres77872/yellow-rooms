import { CHUNK, cIdx } from '../world/constants.js'
import { validateLethalVoidHalf } from '../world/structures/contract.js'

// Per-chunk slab-opening masks for the editor's plan, section and review
// passes. ChunkData derives its holes from the stair/structure/lethal
// descriptors on every query, and a lethal half re-validates its whole
// descriptor per call — ~1.3 µs per cell on a Lattice chunk, paid again on
// every redraw. The editor never rewrites descriptor fields in place (edits
// touch rasters; bakes/undo swap whole ChunkData objects), so a mask keyed on
// the chunk AND the identity of every descriptor it was derived from can
// never go stale: a changed carrier recomputes.
//
//   floor/ceil  1 where the floor/ceiling slab is open (hasFloorHole/CeilHole)
//   lethal      1 where a VALID lethalVoidDown half drops to a death plane,
//               2 where a lethal half exists but fails validation (a bug)
//   deathYmm    per-cell death plane (mm) for lethal cells, else 0
//   stair       bit flags: 1 stairUp landing, 2 stairUp run (ceiling opening
//               above the ramp), 4 stairDown run (floor opening the ramp
//               rises through), 8 stairDown exit (arrival cell)

const SOURCES = [
  'stairUp', 'stairDown', 'structure', 'structureUp', 'structureDown',
  'lethalVoidUp', 'lethalVoidDown',
]

export const STAIR_UP_LANDING = 1
export const STAIR_UP_RUN = 2
export const STAIR_DOWN_RUN = 4
export const STAIR_DOWN_EXIT = 8

const CACHE = new WeakMap()

function markCell(mask, cell, bit) {
  if (!Number.isInteger(cell?.lx) || !Number.isInteger(cell?.lz)) return
  if (cell.lx < 0 || cell.lx >= CHUNK || cell.lz < 0 || cell.lz >= CHUNK) return
  mask[cIdx(cell.lx, cell.lz)] |= bit
}

function compute(d) {
  const n = CHUNK * CHUNK
  const floor = new Uint8Array(n)
  const ceil = new Uint8Array(n)
  const lethal = new Uint8Array(n)
  const deathYmm = new Int32Array(n)
  const stair = new Uint8Array(n)
  let floorCount = 0
  let ceilCount = 0
  let lethalCount = 0
  const described = SOURCES.some((f) => d[f] != null)
  if (described) {
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const i = cIdx(lx, lz)
        if (d.hasFloorHole(lx, lz)) { floor[i] = 1; floorCount++ }
        if (d.hasCeilHole(lx, lz)) { ceil[i] = 1; ceilCount++ }
      }
    }
    const half = d.lethalVoidDown
    if (half && Array.isArray(half.cells)) {
      const ok = validateLethalVoidHalf(d, half, 'down').ok
      for (const cell of half.cells) {
        if (!Number.isInteger(cell?.lx) || !Number.isInteger(cell?.lz)) continue
        if (cell.lx < 0 || cell.lx >= CHUNK || cell.lz < 0 || cell.lz >= CHUNK) continue
        const i = cIdx(cell.lx, cell.lz)
        lethal[i] = ok ? 1 : 2
        deathYmm[i] = Number.isInteger(cell.deathYmm) ? cell.deathYmm : 0
        lethalCount++
      }
    }
    markCell(stair, d.stairUp?.landing, STAIR_UP_LANDING)
    for (const cell of d.stairUp?.run ?? []) markCell(stair, cell, STAIR_UP_RUN)
    for (const cell of d.stairDown?.run ?? []) markCell(stair, cell, STAIR_DOWN_RUN)
    markCell(stair, d.stairDown?.exit, STAIR_DOWN_EXIT)
  }
  return {
    refs: SOURCES.map((f) => d[f]),
    floor, ceil, lethal, deathYmm, stair,
    floorCount, ceilCount, lethalCount,
  }
}

export function holeMasks(d) {
  const hit = CACHE.get(d)
  if (hit && SOURCES.every((f, i) => hit.refs[i] === d[f])) return hit
  const masks = compute(d)
  CACHE.set(d, masks)
  return masks
}

// Walkability exactly as the layered audit and pathfinder see it: a column or
// furniture blocks its cell, an open floor slab is not standable, and both
// ends of a stair ramp (lower run, upper run holes) are traversed only through
// the stair edge.
export function cellWalkable(d, lx, lz) {
  const i = cIdx(lx, lz)
  if (d.cols[i] !== 0) return false
  const m = holeMasks(d)
  return m.floor[i] === 0 && (m.stair[i] & (STAIR_UP_RUN | STAIR_DOWN_RUN)) === 0
}
