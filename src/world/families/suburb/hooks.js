import { CHUNK } from '../../constants.js'
import { exitCellClear, spawnCellOk } from '../../tiles/cells.js'
import { bakeExitsAt } from '../../tiles/familyChunk.js'
import { cellWalkable } from '../../tiles/holeMasks.js'
import {
  GROUND,
  SPAWN_CELLS,
  TILE,
  bandKey,
  exitAnchor,
  exitAnchorOfTile,
  exitFallbackTiles,
  exitTileOf,
  forcedHouses,
  globalCell,
  houseCellOf,
} from './geometry.js'

// The suburb spawn and exit hooks (spec §8.1, §8.2, §12.6).
//   spawn: tile (0,0), on its spine's centre line (geometry.SPAWN_CELLS: the
//          spawn tile always lays its spine on rows 9..13), cy 0;
//   exit:  the attic (cy 1) of the first two-storey house of the anchor
//          tile, a tile at Chebyshev distance 2 with |tx| = 2
//          (geometry.exitTileOf), where that house is the only lit one; the
//          cell its bake marks (the attic hall's far end).
// The anchor tile is per world seed, so every level of a seed shares it.
export { exitAnchor }

export const stub = false

// §8.2: incremented on the last-resort path only; the harness asserts 0.
export const exitHookStats = { lastResort: 0 }

// §12.6: the exit chunk is 6..16 chunks (Chebyshev) from the spawn chunk —
// 7..13 in practice (|tx| = 2 puts it 7..13 chunk columns away) — on the
// attic storey.
export const exitBounds = Object.freeze({ minChunks: 6, maxChunks: 16, cy: Object.freeze([1, 1]) })

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
      d = generate?.(s.cx, GROUND, s.cz) ?? null
    } catch {
      d = null
    }
    if (!d || (cellWalkable(d, s.lx, s.lz) && spawnCellOk(d, s.lx, s.lz))) return { ...s, yaw: null }
  }
  return { ...toChunkCell(SPAWN_CELLS[0].gx, SPAWN_CELLS[0].gz), yaw: null }
}

// §8.2: the anchor tile's bake candidates, then the other cells of the same
// attic hall, then the attics of the other tiles on the ring (deterministic
// order); the first walkable, clear cell wins. Never throws.
export function exit({ worldSeed = 0, config, generate } = {}) {
  const seed = worldSeed >>> 0
  const tiles = [exitTileOf(seed), ...exitFallbackTiles(seed)]
  const ok = (e) => {
    let d = null
    try {
      d = generate?.(e.cx, e.cy, e.cz) ?? null
    } catch {
      d = null
    }
    return !!d && cellWalkable(d, e.lx, e.lz) && exitCellClear(d, e.lx, e.lz)
  }
  let first = null
  for (const t of tiles) {
    let cells = []
    try {
      cells = config ? bakeExitsAt(seed, bandKey(t.tx, t.tz), config) : []
    } catch {
      cells = []
    }
    const marked = cells.map((c) => ({ ...toChunkCell(c.gx, c.gz), cy: c.cy }))
    const house = forcedHouses(seed, bandKey(t.tx, t.tz))[0]
    const hall = house.fallbacks.map((uv) => globalCell(t.tx, t.tz, { ...houseCellOf(house, uv.u, uv.v), cy: house.exit.cy }))
    for (const e of [...marked, ...hall]) {
      first ??= e
      if (ok(e)) return pick(e)
    }
  }
  exitHookStats.lastResort++
  if (first) return pick(first)
  const t = tiles[0]
  return pick(exitAnchorOfTile(seed, t.tx, t.tz))
}

const pick = (e) => ({ cx: e.cx, cy: e.cy, cz: e.cz, lx: e.lx, lz: e.lz })

// The proof box (§8.3): the bounding rectangle of the spawn tile and the
// exit tile, over storeys 0..1. Every seam carries 1-2 street crossings
// (geometry.xSeamPorts, zSeamPorts) and every tile's streets join all of its
// ports in one piece (suburbPlan checks it), so a monotone walk of tiles from
// spawn to exit stays inside the rectangle; the attic is reached through the
// anchor house's own stair.
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
    cy: [0, 1],
  }
}
