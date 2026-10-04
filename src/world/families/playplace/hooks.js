import { CHUNK } from '../../constants.js'
import { exitCellClear, spawnCellOk } from '../../tiles/cells.js'
import { bakeExitsAt } from '../../tiles/familyChunk.js'
import { cellWalkable } from '../../tiles/holeMasks.js'
import {
  DECK,
  FLOOR,
  TILE,
  bandKey,
  exitAnchor,
  exitAnchorOfTile,
  exitFallbackTiles,
  exitTileOf,
  spawnCells,
} from './geometry.js'

// The playplace spawn and exit hooks (spec §8.1, §8.2, §12.9).
//   spawn: module (0,0), the floor (cy 0), on its first hall's floor, as
//          near the main gate as the pit and posts allow; else a corridor or
//          room cell off the chunk edges (geometry.spawnCells, in tiers);
//   exit:  the far pod of the crawl-tube block on the deck (cy 1) of the
//          anchor module, at Chebyshev distance 2–3 from module (0,0)
//          (geometry.exitTileOf), the cell its bake marks.
export { exitAnchor }

export const stub = false

// §8.2: incremented on the last-resort path only; the harness asserts 0.
export const exitHookStats = { lastResort: 0 }

// §12.9: the exit chunk is 3..7 chunks (Chebyshev) from the spawn chunk (the
// pod is chunk (1, 0) of a module on ring 2 or 3; the spawn is chunk (0, 1)),
// on the deck storey.
export const exitBounds = Object.freeze({ minChunks: 3, maxChunks: 7, cy: Object.freeze([DECK, DECK]) })

const toChunkCell = (gx, gz) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { cx, cz, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}

export function spawn({ worldSeed = 0, generate } = {}) {
  const cells = spawnCells(worldSeed >>> 0)
  const chunks = new Map()
  const chunkOf = (s) => {
    const k = `${s.cx},${s.cz}`
    if (!chunks.has(k)) {
      let d = null
      try {
        d = generate?.(s.cx, FLOOR, s.cz) ?? null
      } catch {
        d = null
      }
      chunks.set(k, d)
    }
    return chunks.get(k)
  }
  // The first candidate that is walkable and passes spawnCellOk (§8.1).
  for (const c of cells) {
    const s = toChunkCell(c.gx, c.gz)
    const d = chunkOf(s)
    if (!d || (cellWalkable(d, s.lx, s.lz) && spawnCellOk(d, s.lx, s.lz))) return { ...s, yaw: null }
  }
  // Never seen: the first walkable cell of the candidates, else the first.
  for (const c of cells) {
    const s = toChunkCell(c.gx, c.gz)
    const d = chunkOf(s)
    if (d && cellWalkable(d, s.lx, s.lz)) return { ...s, yaw: null }
  }
  return { ...toChunkCell(cells[0].gx, cells[0].gz), yaw: null }
}

// §8.2: the bake's exit candidates of the anchor module, then those of the
// other modules on rings 2–3 (deterministic order); the first that is
// walkable and clear wins. Never throws.
export function exit({ worldSeed = 0, config, generate } = {}) {
  const seed = worldSeed >>> 0
  const tiles = [exitTileOf(seed), ...exitFallbackTiles(seed)]
  let first = null
  for (const t of tiles) {
    let cells = []
    try {
      cells = bakeExitsAt(seed, bandKey(t.tx, t.tz), config) ?? []
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

// The proof box (§8.3): exactly the bounding rectangle of the spawn module
// and the anchor module, over the two storeys the route uses (the floor, cy
// 0, and the deck, cy 1). Every module joins its four neighbours on the floor
// (one or two hashed ports per seam, every port routed into the module's one
// corridor tree), so a monotone walk of modules from spawn to anchor stays inside the
// rectangle; the anchor module's halls climb to its deck, whose corridors and
// tube mouths reach the exit pod. The top deck (cy 2) is a cul-de-sac.
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
    cy: [FLOOR, DECK],
  }
}
