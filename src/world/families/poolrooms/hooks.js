import { CHUNK } from '../../constants.js'
import { exitCellClear, spawnCellOk } from '../../tiles/cells.js'
import { bakeExitsAt } from '../../tiles/familyChunk.js'
import { cellWalkable } from '../../tiles/holeMasks.js'
import {
  DECK,
  TILE,
  bandKey,
  exitAnchor,
  exitAnchorOfTile,
  exitFallbackTiles,
  exitTileOf,
} from './geometry.js'
import { spawnCells } from './grammar.js'

// The poolrooms spawn and exit hooks (spec §8.1, §8.2, §12.4).
//   spawn: tile (0,0), on the deck (cy 0): the channel cells of that tile's
//          grammar whose eight neighbours are all floor, nearest the tile's
//          middle first (grammar.spawnCells), off the basin rims;
//   exit:  the floor of the pit well (cy −1) of a tile at Chebyshev distance
//          2 from tile (0,0) (geometry.exitTileOf), the cell its bake marks.
export { exitAnchor }

export const stub = false

// §8.2: incremented on the last-resort path only; the harness asserts 0.
export const exitHookStats = { lastResort: 0 }

// §12.4: the exit chunk is 5..9 chunks (Chebyshev) from the spawn chunk —
// 3..8 in practice: the pit is anywhere in a tile on the distance-2 ring
// (chunks 6..8 off on the ring's axis, 3..8 on its diagonals measured from a
// spawn anywhere in tile (0,0)) — on the basin storey.
export const exitBounds = Object.freeze({ minChunks: 5, maxChunks: 9, cy: Object.freeze([-1, -1]) })

const toChunkCell = (gx, gz) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { cx, cz, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}

export function spawn({ worldSeed = 0, generate } = {}) {
  const deckCy = DECK - 1 // kind storey 1 = world storey 0
  const cells = spawnCells(worldSeed >>> 0)
  for (const c of cells) {
    const s = toChunkCell(c.gx, c.gz)
    const d = generate?.(s.cx, deckCy, s.cz)
    if (!d || (cellWalkable(d, s.lx, s.lz) && spawnCellOk(d, s.lx, s.lz))) return { ...s, yaw: null }
  }
  return { ...toChunkCell(cells[0].gx, cells[0].gz), yaw: null }
}

// §8.2: the bake's exit candidates of the exit tile, then those of the
// other tiles on the distance-2 ring (deterministic order); the first that
// is walkable and clear wins. Never throws.
export function exit({ worldSeed = 0, config, generate } = {}) {
  const seed = worldSeed >>> 0
  const tiles = [exitTileOf(seed), ...exitFallbackTiles(seed)]
  let first = null
  for (const t of tiles) {
    let cells = []
    try {
      cells = bakeExitsAt(seed, bandKey(t.tx, t.tz), config)
    } catch {
      cells = []
    }
    for (const c of cells) {
      const e = { ...toChunkCell(c.gx, c.gz), cy: c.cy }
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
  if (first) return pick(first)
  const t = tiles[0]
  return pick(exitAnchorOfTile(seed, t.tx, t.tz))
}

const pick = (e) => ({ cx: e.cx, cy: e.cy, cz: e.cz, lx: e.lx, lz: e.lz })

// The proof box (§8.3): exactly the bounding rectangle of the spawn tile
// and the exit tile, over the two storeys the route uses (the deck, cy 0,
// and the basin, cy −1). Every tile's deck is one connected grammar with at
// least one port on each of its four seams, so a monotone walk of tiles from
// spawn to exit stays inside the rectangle; the gallery (cy +1) is a
// cul-de-sac over a natatio and never on the route. A margin tile or the
// gallery storey only triples the bake (spec §11.1: 10 s per family file).
export function proofBox(anchor, sp) {
  const ax = Math.floor(anchor.cx / TILE.w)
  const az = Math.floor(anchor.cz / TILE.d)
  const sx = Math.floor((sp?.cx ?? 0) / TILE.w)
  const sz = Math.floor((sp?.cz ?? 0) / TILE.d)
  return {
    chunks: {
      x0: Math.min(ax, sx) * TILE.w,
      z0: Math.min(az, sz) * TILE.d,
      x1: (Math.max(ax, sx) + 1) * TILE.w - 1,
      z1: (Math.max(az, sz) + 1) * TILE.d - 1,
    },
    cy: [-1, 0],
  }
}
