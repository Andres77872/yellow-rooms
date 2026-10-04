import { CHUNK } from '../constants.js'
import { stairStrip } from '../structures/slab.js'
import { cellWalkable } from './holeMasks.js'

// Per-cell placement rules the family spawn and exit hooks share.

// A cell an exit (or spawn) may stand on: standable floor, no column or
// furniture, and more than `margin` cells (Chebyshev) from every cell of the
// chunk's stair strips. Copied verbatim from core/exitPlacement.js (its
// inline clearOf), with the strips taken from the chunk.
export function exitCellClear(data, lx, lz, margin = 0) {
  const strips = [data.stairUp, data.stairDown].filter(Boolean).flatMap(stairStrip)
  const clearOf = (x, z, margin) =>
    !data.hasFloorHole(x, z) && data.colAt(x, z) === 0 &&
    strips.every((cell) => Math.max(Math.abs(cell.lx - x), Math.abs(cell.lz - z)) > margin)
  return clearOf(lx, lz, margin)
}

const RING = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]

// A spawn cell: exit-clear, with at least 3 walkable cells among its 8
// neighbours inside the chunk (so the player never spawns boxed in).
export function spawnCellOk(data, lx, lz) {
  if (!exitCellClear(data, lx, lz)) return false
  let open = 0
  for (const [dx, dz] of RING) {
    const x = lx + dx
    const z = lz + dz
    if (x < 0 || z < 0 || x >= CHUNK || z >= CHUNK) continue
    if (cellWalkable(data, x, z)) open++
  }
  return open >= 3
}
