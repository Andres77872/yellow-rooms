import { CHUNK } from '../../constants.js'
import { exitCellClear, spawnCellOk } from '../../tiles/cells.js'
import { bakeExitsAt } from '../../tiles/familyChunk.js'
import { cellWalkable } from '../../tiles/holeMasks.js'
import {
  GROUND,
  SPAWN_CELLS,
  TILE,
  exitAnchor,
  exitCandidatesOf,
  exitTileOf,
  globalCell,
  pavilionKey,
} from './geometry.js'

// The funhouse spawn and exit hooks (spec §8.1, §8.2, §12.12).
//   spawn: pavilion 0, storey 0, on the midway outside the lobby
//          (geometry.SPAWN_CELLS);
//   exit:  the ride's unload walkway (storey 1) of pavilion
//          tx = 2 + hash % 3 (geometry.exitTileOf): a hashed cell of that
//          pavilion's walkway A past the pane (geometry.skeletonOf rolls the
//          walkway with the pavilion), the cell its bake marks first. The
//          route: east along the midway through the pavilions' lobbies to
//          the exit pavilion, in at a facade mouth or the lobby door,
//          through the woven field to stair B, up to the load platform,
//          round the whole one-way ride loop and off on the unload side
//          onto the walkway (stair A only reaches a landing behind glass
//          there) — all inside the proof box.
export { exitAnchor }

export const stub = false

// §8.2: incremented on the last-resort path only; the harness asserts 0.
export const exitHookStats = { lastResort: 0 }

// §12.12: the walkway lies inside a pavilion tx ∈ 2..4 (chunk columns
// 6..14), so the exit is 6..14 chunks (Chebyshev) from the spawn chunk
// (0, 0), on storey 1.
export const exitBounds = Object.freeze({ minChunks: 5, maxChunks: 14, cy: Object.freeze([1, 1]) })

export function spawn({ generate } = {}) {
  for (const c of SPAWN_CELLS) {
    const s = globalCell(0, { ...c, cy: GROUND })
    let d = null
    try {
      d = generate?.(s.cx, GROUND, s.cz) ?? null
    } catch {
      d = null
    }
    if (!d || (cellWalkable(d, s.lx, s.lz) && spawnCellOk(d, s.lx, s.lz))) return { cx: s.cx, cz: s.cz, lx: s.lx, lz: s.lz, yaw: null }
  }
  const s = globalCell(0, { ...SPAWN_CELLS[0], cy: GROUND })
  return { cx: s.cx, cz: s.cz, lx: s.lx, lz: s.lz, yaw: null }
}

const pick = (e) => ({ cx: e.cx, cy: e.cy, cz: e.cz, lx: e.lx, lz: e.lz })

// The global unload-walkway candidates of pavilion tx: the bake's markExit
// cells (the hashed one first), or the same pure list if the bake throws.
function candidatesOf(seed, tx, config) {
  let cells = null
  try {
    cells = config ? bakeExitsAt(seed, pavilionKey(tx), config) : null
  } catch {
    cells = null
  }
  if (cells?.length) {
    return cells.map((c) => {
      const cx = Math.floor(c.gx / CHUNK)
      const cz = Math.floor(c.gz / CHUNK)
      return { cx, cy: c.cy, cz, lx: c.gx - cx * CHUNK, lz: c.gz - cz * CHUNK }
    })
  }
  return exitCandidatesOf(seed, tx).map((c) => globalCell(tx, c))
}

// §8.2: the exit pavilion's candidates, then (still inside the exit bounds
// and the proof box) those of the pavilions between it and pavilion 2; the
// first that is walkable and clear wins. Never throws.
export function exit({ worldSeed = 0, config, generate } = {}) {
  const seed = worldSeed >>> 0
  const exitTx = exitTileOf(seed)
  let first = null
  for (let tx = exitTx; tx >= 2; tx--) {
    for (const e of candidatesOf(seed, tx, config)) {
      first ??= e
      let d = null
      try {
        d = generate?.(e.cx, e.cy, e.cz) ?? null
      } catch {
        d = null
      }
      if (d && cellWalkable(d, e.lx, e.lz) && exitCellClear(d, e.lx, e.lz)) return pick(e)
    }
  }
  exitHookStats.lastResort++
  return pick(first ?? exitAnchor(seed))
}

// The proof box (§8.3): the bounding rectangle of the spawn pavilion and the
// exit pavilion (the anchor's), both chunk rows of the chain, over the two
// storeys. The route runs east along the chain (the midway through every
// pavilion's lobby) and then stays inside the exit pavilion (maze, stair B,
// ride), so the box holds it; the exit fallbacks stay at or west of the
// anchor pavilion, inside it too.
export function proofBox(anchor, sp) {
  const ax = Math.floor(anchor.cx / TILE.w)
  const sx = Math.floor((sp?.cx ?? 0) / TILE.w)
  return {
    chunks: { x0: Math.min(ax, sx) * TILE.w, z0: 0, x1: (Math.max(ax, sx) + 1) * TILE.w - 1, z1: TILE.d - 1 },
    cy: [0, 1],
  }
}
