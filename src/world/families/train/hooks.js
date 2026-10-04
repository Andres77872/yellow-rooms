import { CHUNK } from '../../constants.js'
import { exitCellClear, spawnCellOk } from '../../tiles/cells.js'
import { bakeExitsAt } from '../../tiles/familyChunk.js'
import { cellWalkable } from '../../tiles/holeMasks.js'
import { CONC, TILE, TRAIN, cellOfTile, exitAnchor, exitCellsOf, spawnCells, stationsEast, trainKey } from './geometry.js'

// The train's spawn and exit hooks (spec §8.1, §8.2, §12.10).
//   spawn: the aisle of tile 0's first car (a commuter car), storey 0
//          (geometry.spawnCells: its row is the seam's hashed gangway row);
//   exit:  the concourse closet (storey 1) of the second station east of
//          tile 0 (geometry.exitTileOf, tile 2..6 by the station gap rule).
// The route: east along the aisle through the gangways, off a station car's
// wide doors onto the platform, up a stair core, through the gate line to
// the closet (storey 1 has no seam ports: the upper works are dead-end
// pockets, each reached by its own stairs) — all inside tiles 0..exit
// (proofBox).
export { exitAnchor }

export const stub = false

// §8.2: incremented on the last-resort path only; the harness asserts 0.
export const exitHookStats = { lastResort: 0 }

// The closet lies in the exit tile (tx 2..6), 8..27 chunks (Chebyshev) from
// the spawn chunk; the fallback station (the first east, tx 1..3) keeps it
// ≥ 4. Storey 1 only.
export const exitBounds = Object.freeze({ minChunks: 4, maxChunks: 28, cy: Object.freeze([CONC, CONC]) })

const toChunkCell = (gx, gz) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { cx, cz, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}

export function spawn({ worldSeed = 0, generate } = {}) {
  const cells = spawnCells(worldSeed >>> 0)
  for (const c of cells) {
    const s = toChunkCell(c.gx, c.gz)
    let d = null
    try {
      d = generate?.(s.cx, TRAIN, s.cz) ?? null
    } catch {
      d = null
    }
    if (!d || (cellWalkable(d, s.lx, s.lz) && spawnCellOk(d, s.lx, s.lz))) return { ...s, yaw: null }
  }
  return { ...toChunkCell(cells[0].gx, cells[0].gz), yaw: null }
}

const pick = (e) => ({ cx: e.cx, cy: e.cy, cz: e.cz, lx: e.lx, lz: e.lz })

// §8.2: the exit station's marked closet cells, then the closet of the first
// station east (deterministic fallback, still inside the bounds and the
// proof box); the first walkable, clear cell wins. Never throws.
export function exit({ worldSeed = 0, config, generate } = {}) {
  const seed = worldSeed >>> 0
  const [first, second] = stationsEast(seed, 2)
  let marked = null
  for (const tx of [second, first]) {
    let cells = []
    try {
      cells = config ? bakeExitsAt(seed, trainKey(tx), config) : []
    } catch {
      cells = []
    }
    if (!cells.length) cells = exitCellsOf(seed, tx).map((c) => ({ gx: tx * TILE.w * CHUNK + c.gx, gz: c.gz, cy: CONC }))
    for (const c of cells) {
      const e = { ...toChunkCell(c.gx, c.gz), cy: c.cy }
      marked ??= e
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
  const c0 = exitCellsOf(seed, second)[0]
  return pick(marked ?? cellOfTile(second, c0.gx, c0.gz, CONC))
}

// The proof box (§8.3): tiles 0..exit tile (the train row, chunk row 0) over
// both storeys.
export function proofBox(anchor, sp) {
  const ax = Math.floor(anchor.cx / TILE.w)
  const sx = Math.floor((sp?.cx ?? 0) / TILE.w)
  return {
    chunks: { x0: Math.min(ax, sx) * TILE.w, z0: 0, x1: (Math.max(ax, sx) + 1) * TILE.w - 1, z1: 0 },
    cy: [TRAIN, CONC],
  }
}
