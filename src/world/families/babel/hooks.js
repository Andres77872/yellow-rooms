import { CHUNK } from '../../constants.js'
import { exitCellClear, spawnCellOk } from '../../tiles/cells.js'
import { bakeExitsAt } from '../../tiles/familyChunk.js'
import { cellWalkable } from '../../tiles/holeMasks.js'
import { SPAWN_CELLS, TILE, exitAnchor, exitAnchorGallery, exitCellsOf, keyAt } from './geometry.js'

// The babel spawn and exit hooks (spec §8.1, §8.2, §12.5).
//   spawn: block (0,0), storey 0, the stair hall of chunk (0,0) (the kind's
//          site on every slab), off the flight's strip (geometry.SPAWN_CELLS);
//   exit:  the Crimson Hexagon — a gallery of the procedural layout of a
//          block at Chebyshev distance 2..3 from block (0,0), on storey
//          ±(2..6), all hashed (geometry.exitAnchorGallery); its bake marks
//          the walkway cell west of the shaft, under the red globe.
// The exit block and storey are pure in the world seed, so every level of a
// seed shares them (accepted, as for the pilots).
export { exitAnchor }

export const stub = false

// §8.2: incremented on the last-resort path only; the harness asserts 0.
export const exitHookStats = { lastResort: 0 }

// The exit chunk is 3..7 chunks (Chebyshev) from the spawn chunk (0,0) — the
// exit block's chunks lie 2·2 − 1 .. 2·3 + 1 chunks out — on storey ±(2..6).
export const exitBounds = Object.freeze({ minChunks: 3, maxChunks: 8, cy: Object.freeze([-6, 6]) })

const toCell = (gx, gz, cy) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { cx, cy, cz, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}

export function spawn({ generate } = {}) {
  let d = null
  try {
    d = generate?.(0, 0, 0) ?? null
  } catch {
    d = null
  }
  for (const c of SPAWN_CELLS) {
    if (!d || (cellWalkable(d, c.lx, c.lz) && spawnCellOk(d, c.lx, c.lz))) return { cx: 0, cz: 0, lx: c.lx, lz: c.lz, yaw: null }
  }
  return { cx: 0, cz: 0, lx: SPAWN_CELLS[0].lx, lz: SPAWN_CELLS[0].lz, yaw: null }
}

// §8.2: the exit block's bake candidates (the marked walkway cell), then the
// rest of the Crimson Hexagon's walkway on the same storey; the first that
// is walkable and clear wins. Never throws.
export function exit({ worldSeed = 0, config, generate } = {}) {
  const seed = worldSeed >>> 0
  const g = exitAnchorGallery(seed)
  const ok = (e) => {
    let d = null
    try {
      d = generate?.(e.cx, e.cy, e.cz) ?? null
    } catch {
      d = null
    }
    return !!d && cellWalkable(d, e.lx, e.lz) && exitCellClear(d, e.lx, e.lz)
  }
  let marked = []
  try {
    marked = config ? bakeExitsAt(seed, keyAt(g.tx, g.tz, g.cy), config) : []
  } catch {
    marked = []
  }
  const candidates = [...marked, ...exitCellsOf(g)].map((c) => toCell(c.gx, c.gz, c.cy))
  for (const c of candidates) if (ok(c)) return c
  exitHookStats.lastResort++
  return candidates[0]
}

// The proof box (§8.3): the bounding rectangle of the spawn block and the
// exit block, over the storeys between spawn (0) and the exit storey. Every
// storey of every block is one connected plan (each storey's chain reaches
// every room and every open seam stub) and every seam opens at least one
// port per storey, and every chunk climbs (or descends) one slab on
// alternate storeys, so a walk along storey 0 to the exit block and a climb
// inside it stays in the box.
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
    cy: [Math.min(0, anchor.cy), Math.max(0, anchor.cy)],
  }
}
