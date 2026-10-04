import { CHUNK } from '../../constants.js'
import { exitCellClear, spawnCellOk } from '../../tiles/cells.js'
import { bakeExitsAt } from '../../tiles/familyChunk.js'
import { cellWalkable } from '../../tiles/holeMasks.js'
import {
  BASEMENT_CY,
  DECK_CY,
  DISTRICT,
  anchorDistrict,
  districtKey,
  exitAnchor,
  kioskExitCells,
  spawnCells,
  spawnChunkCell,
} from './geometry.js'

// The nightlot spawn and exit hooks (spec §8.1, §8.2, §12.2).
//   spawn: the gas-station refuge of district (0,0): the middle row of its
//          canopy apron under the canopy lamps, on the lot (cy 0);
//   exit:  the plant room of the kiosk-with-basement module of the exit
//          district (Chebyshev distance 2 from district (0,0), hashed among
//          the 16 on that ring), on the basement storey (cy −1). The exit
//          district is shared by every level of a world seed.
export { exitAnchor }

export const stub = false

// §8.2: incremented on the last-resort path only; the harness asserts 0.
export const exitHookStats = { lastResort: 0 }

// The exit chunk is the kiosk chunk (local 1..3) of a district on the
// distance-2 ring and the spawn chunk one of district (0,0)'s chunks 0..3, so
// the Chebyshev chunk distance is 5..11 (east/south: 9..11 − 0..3 ≥ 6;
// west/north: 0..3 + 5..7 ≤ 10); always on the basement storey.
export const exitBounds = Object.freeze({ minChunks: 5, maxChunks: 11, cy: Object.freeze([BASEMENT_CY, BASEMENT_CY]) })

export function spawn({ worldSeed = 0, generate } = {}) {
  const cells = spawnCells(worldSeed >>> 0)
  for (const c of cells) {
    const s = spawnChunkCell(c.gx, c.gz)
    let d = null
    try {
      d = generate?.(s.cx, DECK_CY, s.cz) ?? null
    } catch {
      d = null
    }
    if (!generate || (d && cellWalkable(d, s.lx, s.lz) && spawnCellOk(d, s.lx, s.lz))) return { cx: s.cx, cz: s.cz, lx: s.lx, lz: s.lz, yaw: null }
  }
  const s = spawnChunkCell(cells[0].gx, cells[0].gz)
  return { cx: s.cx, cz: s.cz, lx: s.lx, lz: s.lz, yaw: null }
}

const pick = (e) => ({ cx: e.cx, cy: e.cy, cz: e.cz, lx: e.lx, lz: e.lz })
const asExit = (c) => {
  const cx = Math.floor(c.gx / CHUNK)
  const cz = Math.floor(c.gz / CHUNK)
  return { cx, cy: c.cy, cz, lx: c.gx - cx * CHUNK, lz: c.gz - cz * CHUNK }
}

// §8.2: the exit district's bake candidates (markExit), then the same cells
// from the pure geometry; the first walkable and clear wins. Never throws.
export function exit({ worldSeed = 0, config, generate } = {}) {
  const seed = worldSeed >>> 0
  const a = anchorDistrict(seed)
  let marked = []
  try {
    marked = config ? bakeExitsAt(seed, districtKey(a.tx, a.tz), config) : []
  } catch {
    marked = []
  }
  const pure = kioskExitCells(seed, a.tx, a.tz) ?? []
  const candidates = [...marked, ...pure].map(asExit)
  for (const e of candidates) {
    let d = null
    try {
      d = generate?.(e.cx, e.cy, e.cz) ?? null
    } catch {
      d = null
    }
    if (d && cellWalkable(d, e.lx, e.lz) && exitCellClear(d, e.lx, e.lz)) return pick(e)
  }
  exitHookStats.lastResort++
  return pick(candidates[0] ?? exitAnchor(seed))
}

// The proof box (§8.3): the bounding rectangle of the spawn district and the
// exit district, over the lot and the undercroft (the upper storey is never
// on the way: the refuge and the kiosks stand on the lot). Every district owns open
// seam roads on its west and north and open verges on its east and south
// (full-seam ports), buildings stand inside the parcel with clearance round
// them, so a walk along the roads from the refuge to the exit kiosk stays
// inside the rectangle; the kiosk's stair takes it down to the plant room.
export function proofBox(anchor, sp) {
  const ax = Math.floor(anchor.cx / DISTRICT)
  const az = Math.floor(anchor.cz / DISTRICT)
  const sx = Math.floor((sp?.cx ?? 0) / DISTRICT)
  const sz = Math.floor((sp?.cz ?? 0) / DISTRICT)
  return {
    chunks: {
      x0: Math.min(ax, sx) * DISTRICT,
      z0: Math.min(az, sz) * DISTRICT,
      x1: (Math.max(ax, sx) + 1) * DISTRICT - 1,
      z1: (Math.max(az, sz) + 1) * DISTRICT - 1,
    },
    cy: [BASEMENT_CY, DECK_CY],
  }
}
