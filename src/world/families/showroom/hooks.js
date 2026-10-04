import { CHUNK } from '../../constants.js'
import { exitCellClear, spawnCellOk } from '../../tiles/cells.js'
import { bakeExitsAt } from '../../tiles/familyChunk.js'
import { cellWalkable } from '../../tiles/holeMasks.js'
import { TILE, UP, bandKey, exitTileOf, globalCell, spawnCellsOf } from './geometry.js'
import { exitAnchor, hallExitOf } from './layout.js'

// The showroom spawn and exit hooks (spec §8.1, §8.2, §12.3).
//   spawn: the route entrance of tile (0,0) on cy 0, outside stair A's door
//          (geometry.spawnCellsOf: the door cell, then the lane cells
//          nearest it);
//   exit:  the lower store's fire exit on cy −1 of tile (2 + hash % 3, 0)
//          (geometry.exitTileOf; the cell layout.hallExitOf picks in the
//          district's east chunk column), the cell its bake marks. The route
//          there is the store's own: along each district's serpentine to
//          stair B, through its departments and checkouts, across the x seam
//          into the next district's lobby corridor and up its stair A, tile
//          by tile along tz 0 (proofBox).
export { exitAnchor }

export const stub = false

// §8.2: incremented on the last-resort path only; the harness asserts 0.
export const exitHookStats = { lastResort: 0 }

// §12.3: exit bounds. The exit chunk is in the east chunk column of tile
// tx ∈ 2..4 (chunk x 5, 7 or 9) and the spawn in tile (0,0) (chunk x 0..1),
// so the exit lies 4..9 chunks (Chebyshev) from the spawn chunk.
export const exitBounds = Object.freeze({ minChunks: 4, maxChunks: 10, cy: Object.freeze([-1, -1]) })

const routeCy = UP - 1 // kind storey 1 = world storey 0

export function spawn({ worldSeed = 0, generate } = {}) {
  const cells = spawnCellsOf(worldSeed >>> 0)
  for (const c of cells) {
    const s = globalCell(0, 0, { ...c, cy: UP })
    let d = null
    try {
      d = generate?.(s.cx, routeCy, s.cz) ?? null
    } catch {
      d = null
    }
    if (!d || (cellWalkable(d, s.lx, s.lz) && spawnCellOk(d, s.lx, s.lz))) return { cx: s.cx, cz: s.cz, lx: s.lx, lz: s.lz, yaw: null }
  }
  const s = globalCell(0, 0, { ...cells[0], cy: UP })
  return { cx: s.cx, cz: s.cz, lx: s.lx, lz: s.lz, yaw: null }
}

const asExit = (gx, gz, cy) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { cx, cy, cz, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}
const pick = (e) => ({ cx: e.cx, cy: e.cy, cz: e.cz, lx: e.lx, lz: e.lz })

// §8.2: the exit tile's bake candidates, then its layout's fire exit, then
// the same in the other two candidate tiles (tx 2..4, tz 0; deterministic
// order). The first walkable, clear cell wins. Never throws.
export function exit({ worldSeed = 0, config, generate } = {}) {
  const seed = worldSeed >>> 0
  const first = exitTileOf(seed)
  const tiles = [first, ...[2, 3, 4].filter((tx) => tx !== first.tx).map((tx) => ({ tx, tz: 0 }))]
  const ok = (e) => {
    let d = null
    try {
      d = generate?.(e.cx, e.cy, e.cz) ?? null
    } catch {
      d = null
    }
    return !!d && cellWalkable(d, e.lx, e.lz) && exitCellClear(d, e.lx, e.lz)
  }
  let marked0 = null
  for (const t of tiles) {
    let cells = []
    try {
      cells = config ? bakeExitsAt(seed, bandKey(t.tx, t.tz), config) : []
    } catch {
      cells = []
    }
    for (const c of cells) {
      const e = asExit(c.gx, c.gz, c.cy)
      marked0 ??= e
      if (ok(e)) return pick(e)
    }
    const c = hallExitOf(seed, t.tx, t.tz)
    if (c) {
      const e = globalCell(t.tx, t.tz, c)
      if (ok(e)) return pick(e)
    }
  }
  exitHookStats.lastResort++
  return pick(marked0 ?? exitAnchor(seed))
}

// The proof box (§8.3): the bounding rectangle of the spawn tile and the
// exit tile (tz 0, tx 0..2-4), over the two storeys of the band. Each tile
// joins its east neighbour on the hall storey (checkouts → x seam → lobby
// corridor → stair A), so the store's own route walks the tiles
// monotonically inside the box.
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
