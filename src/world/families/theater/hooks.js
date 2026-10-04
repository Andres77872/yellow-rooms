import { CHUNK } from '../../constants.js'
import { exitCellClear, spawnCellOk } from '../../tiles/cells.js'
import { bakeExitsAt } from '../../tiles/familyChunk.js'
import { cellWalkable } from '../../tiles/holeMasks.js'
import {
  EXIT_MAX_CHUNKS,
  EXIT_MIN_CHUNKS,
  GROUND,
  TILE,
  bandKey,
  exitAnchor,
  exitAnchorOfTile,
  exitFallbackTiles,
  exitTileOf,
  spawnCellsOfWorld,
} from './geometry.js'

// The theater spawn and exit hooks (spec §8.1, §8.2, §12.8).
//   spawn: tile (0,0), its stalls (cy 0): a gangway where it meets a cross
//          aisle, centre first (the scheme's spawn cells, which every
//          theatre rolls for itself);
//   exit:  the trap room (cy −1) of a theatre at Chebyshev distance 2 from
//          tile (0,0) (geometry.exitTileOf), the cell its bake marks.
// The exit tile is a function of the world seed alone, so every level of a
// seed shares it (as in the pilots).
export { exitAnchor }

export const stub = false

// §8.2: incremented on the last-resort path only; the harness asserts 0.
export const exitHookStats = { lastResort: 0 }

// §12.8: the exit chunk is 4..9 chunks (Chebyshev) from the spawn chunk (the
// ring of tiles at distance 2 keeps only the theatres whose trap-room exit
// cells all lie inside the bound: geometry.exitTileOf) — on the trap room
// storey.
export const exitBounds = Object.freeze({ minChunks: EXIT_MIN_CHUNKS, maxChunks: EXIT_MAX_CHUNKS, cy: Object.freeze([-1, -1]) })

const toChunkCell = (gx, gz) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { cx, cz, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}

export function spawn({ worldSeed = 0, generate } = {}) {
  const cy = GROUND - 1 // kind storey 1 = world storey 0
  const cells = spawnCellsOfWorld(worldSeed >>> 0)
  for (const c of cells) {
    const s = toChunkCell(c.gx, c.gz)
    let d = null
    try {
      d = generate?.(s.cx, cy, s.cz) ?? null
    } catch {
      d = null
    }
    if (!d || (cellWalkable(d, s.lx, s.lz) && spawnCellOk(d, s.lx, s.lz))) return { ...s, yaw: null }
  }
  return { ...toChunkCell(cells[0].gx, cells[0].gz), yaw: null }
}

const pick = (e) => ({ cx: e.cx, cy: e.cy, cz: e.cz, lx: e.lx, lz: e.lz })

// §8.2: the bake's exit candidates of the exit tile, then those of the
// other tiles on the ring (deterministic order); the first that is walkable
// and clear wins. Never throws.
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

// The proof box (§8.3): the bounding rectangle of the spawn tile and the exit
// tile, over the three band storeys (basement cy −1, ground cy 0, first
// floor cy 1). Every theatre joins each neighbour through one or two ground
// ports per seam (geometry.ports), and every band storey is one connected
// graph reaching the house's stair core, so a monotone walk of tiles from
// spawn to exit stays inside the rectangle.
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
    cy: [-1, 1],
  }
}
