import { CHUNK } from '../../constants.js'
import { exitCellClear, spawnCellOk } from '../../tiles/cells.js'
import { bakeExitsAt } from '../../tiles/familyChunk.js'
import { cellWalkable } from '../../tiles/holeMasks.js'
import {
  DEP,
  TILE,
  bandKey,
  exitAnchor,
  exitAnchorOfTile,
  exitFallbackTiles,
  exitTileOf,
  spawnCells,
} from './geometry.js'

// The terminal spawn and exit hooks (spec §8.1, §8.2, §12.7).
//   spawn: tile 0, departures (cy 0), the landside check-in hall (its middle,
//          geometry.spawnCells: the hall's size and rows are the seed's);
//   exit:  the arrivals door off the baggage hall (cy −1) of tile
//          tx = ±(2..3) (geometry.exitTileOf), the cell its bake marks.
export { exitAnchor }

export const stub = false

// §8.2: incremented on the last-resort path only; the harness asserts 0.
export const exitHookStats = { lastResort: 0 }

// §12.7: the spawn is in chunk column 0 of tile 0; the arrivals door of tile
// tx lies in chunk column 4·tx + 0..3 (west of the origin, in the tile's
// west half: 0..1), so the exit chunk is Chebyshev 7..15 from the spawn
// (bound 7..16), on the baggage storey.
export const exitBounds = Object.freeze({ minChunks: 7, maxChunks: 16, cy: Object.freeze([-1, -1]) })

const toChunkCell = (gx, gz) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { cx, cz, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}

export function spawn({ worldSeed = 0, generate } = {}) {
  const depCy = DEP - 1 // kind storey 1 = world storey 0
  const cells = spawnCells(worldSeed >>> 0)
  for (const c of cells) {
    const s = toChunkCell(c.gx, c.gz)
    let d = null
    try {
      d = generate?.(s.cx, depCy, s.cz) ?? null
    } catch {
      d = null
    }
    if (!d || (cellWalkable(d, s.lx, s.lz) && spawnCellOk(d, s.lx, s.lz))) return { ...s, yaw: null }
  }
  return { ...toChunkCell(cells[0].gx, cells[0].gz), yaw: null }
}

// §8.2: the bake's exit candidates of the exit tile, then those of the other
// three exit tiles (deterministic order); the first that is walkable and
// clear wins. Never throws.
export function exit({ worldSeed = 0, config, generate } = {}) {
  const seed = worldSeed >>> 0
  const tiles = [exitTileOf(seed), ...exitFallbackTiles(seed)]
  let first = null
  for (const tx of tiles) {
    let cells = []
    try {
      cells = bakeExitsAt(seed, bandKey(tx), config)
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
  return pick(exitAnchorOfTile(seed, tiles[0]))
}

const pick = (e) => ({ cx: e.cx, cy: e.cy, cz: e.cz, lx: e.lx, lz: e.lz })

// The proof box (§8.3): exactly the bounding rectangle of the spawn tile and
// the exit tile (the tile row's four chunk rows), over the two storeys the
// route uses (departures, cy 0, and baggage, cy −1). Every tile carries the
// spine to both seams and at least one pier with its service stair down to
// the baggage level, whose corridors reach the arrivals door, so a walk
// along the spine to the exit tile and down a pier stair stays inside the
// rectangle; the mezzanine (cy +1) is never on the route.
export function proofBox(anchor, sp) {
  const ax = Math.floor(anchor.cx / TILE.w)
  const sx = Math.floor((sp?.cx ?? 0) / TILE.w)
  return {
    chunks: {
      x0: Math.min(ax, sx) * TILE.w,
      z0: 0,
      x1: (Math.max(ax, sx) + 1) * TILE.w - 1,
      z1: TILE.d - 1,
    },
    cy: [-1, 0],
  }
}
