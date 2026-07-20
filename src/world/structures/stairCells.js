import { CHUNK, CHUNK_WORLD, CELL, STAIR_RUN, cIdx } from '../constants.js'
import { STAIR_E, STAIR_S, STAIR_W } from './slab.js'

// Precompute the canonical per-cell stair descriptors (the ChunkManager.stairAt
// contract shared by collision, AI, minimap and debug): one frozen object per
// participating cell, so queries are map lookups with zero per-call allocation.
//   { baseCy, part: 'landing'|'run'|'exit'|'hole', dir, axis, sign, rampStart,
//     landing: {gx,gz}, exit: {gx,gz}, runLen }
// `rampStart` is the world coord (along `axis`) of the landing->run0 edge; the
// walk surface over the run/hole cells is baseCy*LAYER_H + t*LAYER_H with
// t = clamp(sign*(along - rampStart) / (2*CELL), 0, 1). THREE-free so the
// collision/ground tests exercise the real generator output headless.
export function buildStairCells(data, cx, cy, cz) {
  const cells = new Map()
  const add = (s, baseCy, parts) => {
    const horiz = s.dir === STAIR_E || s.dir === STAIR_W
    const base = {
      baseCy,
      dir: s.dir,
      axis: horiz ? 'x' : 'z',
      sign: s.dir === STAIR_E || s.dir === STAIR_S ? 1 : -1,
      rampStart: horiz
        ? cx * CHUNK_WORLD + Math.max(s.landing.lx, s.run[0].lx) * CELL
        : cz * CHUNK_WORLD + Math.max(s.landing.lz, s.run[0].lz) * CELL,
      landing: { gx: cx * CHUNK + s.landing.lx, gz: cz * CHUNK + s.landing.lz },
      exit: { gx: cx * CHUNK + s.exit.lx, gz: cz * CHUNK + s.exit.lz },
      runLen: STAIR_RUN,
    }
    for (const [cell, part] of parts) {
      cells.set(cIdx(cell.lx, cell.lz), Object.freeze({ ...base, part }))
    }
  }
  if (data.stairUp) {
    const s = data.stairUp
    add(s, cy, [
      [s.landing, 'landing'],
      [s.run[0], 'run'],
      [s.run[1], 'run'],
    ])
  }
  if (data.stairDown) {
    const s = data.stairDown
    add(s, cy - 1, [
      [s.run[0], 'hole'],
      [s.run[1], 'hole'],
      [s.exit, 'exit'],
    ])
  }
  return cells
}
