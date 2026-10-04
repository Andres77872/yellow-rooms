import { CHUNK } from '../../constants.js'
import { exitCellClear, spawnCellOk } from '../../tiles/cells.js'
import { bakeExitsAt } from '../../tiles/familyChunk.js'
import { cellWalkable } from '../../tiles/holeMasks.js'
import {
  SPAWN_CELLS,
  TILE,
  TILE_D,
  TILE_W,
  bandKey,
  exitAnchor,
  exitAnchorOfTile,
  exitCellsOfTile,
  exitFallbackTiles,
  exitTileOf,
} from './geometry.js'

// The house spawn and exit hooks (spec §8.1, §8.2, §12.11).
//   spawn: tile (0,0), the path of the hedged front yard at the front door
//          (the kind's spawn), cy 0;
//   exit:  the Great Hall's floor (cy 0), its corner under the void farthest
//          from the gallery, in the exit tile: depth 3..5 from the front door
//          (geometry.EXIT_TILES, every chunk 6..16 chunks from the spawn
//          chunk), which is always a hall. The hall's chunk and shape are the
//          tile's own (geometry.hallOf).
// The exit tile is pure in the world seed, so every level of a seed shares it.
export { exitAnchor }

export const stub = false

// §8.2: incremented on the last-resort path only; the harness asserts 0.
export const exitHookStats = { lastResort: 0 }

// §12.11: the exit chunk is 6..16 chunks (Chebyshev) from the spawn chunk
// (EXIT_TILES is filtered to exactly that), on the ground storey.
export const exitBounds = Object.freeze({ minChunks: 6, maxChunks: 16, cy: Object.freeze([0, 0]) })

const toChunkCell = (gx, gz) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { cx, cz, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}

export function spawn({ generate } = {}) {
  for (const c of SPAWN_CELLS) {
    const s = toChunkCell(c.gx, c.gz)
    let d = null
    try {
      d = generate?.(s.cx, 0, s.cz) ?? null
    } catch {
      d = null
    }
    if (!d || (cellWalkable(d, s.lx, s.lz) && spawnCellOk(d, s.lx, s.lz))) return { ...s, yaw: null }
  }
  return { ...toChunkCell(SPAWN_CELLS[0].gx, SPAWN_CELLS[0].gz), yaw: null }
}

const pick = (e) => ({ cx: e.cx, cy: e.cy, cz: e.cz, lx: e.lx, lz: e.lz })

// §8.2: the exit tile's bake candidates, then the same hall floor's fallback
// cells, then the other candidate tiles' halls (deterministic order); the
// first that is walkable and clear wins. Never throws.
export function exit({ worldSeed = 0, config, generate } = {}) {
  const seed = worldSeed >>> 0
  const tiles = [exitTileOf(seed), ...exitFallbackTiles(seed)]
  let first = null
  const ok = (e) => {
    let d = null
    try {
      d = generate?.(e.cx, e.cy, e.cz) ?? null
    } catch {
      d = null
    }
    return !!d && cellWalkable(d, e.lx, e.lz) && exitCellClear(d, e.lx, e.lz)
  }
  for (const [i, t] of tiles.entries()) {
    let cells = []
    try {
      cells = bakeExitsAt(seed, bandKey(t.tx, t.tz), config)
    } catch {
      cells = []
    }
    for (const c of cells) {
      const e = { ...toChunkCell(c.gx, c.gz), cy: c.cy }
      first ??= e
      if (ok(e)) return pick(e)
    }
    // The exit tile's hall floor: the next cells under the void.
    if (i === 0) {
      for (const c of exitCellsOfTile(seed, t.tx, t.tz).slice(1)) {
        const e = { ...toChunkCell(t.tx * TILE_W + c.gx, t.tz * TILE_D + c.gz), cy: 0 }
        if (ok(e)) return pick(e)
      }
    }
    if (i >= 8) break
  }
  exitHookStats.lastResort++
  if (first) return pick(first)
  const t = tiles[0]
  return pick(exitAnchorOfTile(seed, t.tx, t.tz))
}

// The proof box (§8.3): the bounding rectangle of the spawn tile and the
// exit tile, on the ground storey only. Every tile joins its four
// neighbours through one ground door per seam and its hallway graph links
// all four (and the Great Hall's ground door) on storey 0, so a monotone
// walk of tiles from the front yard to the exit tile's hall stays inside the
// rectangle; the upper storeys are never on the route.
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
    cy: [0, 0],
  }
}
