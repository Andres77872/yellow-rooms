import {
  CELL,
  CHUNK,
  WALL_H,
  COL_HALF,
  MONUMENTAL_COL_HALF,
  COL_BASE_H,
  COL_BASE_WIDEN,
  COL_CAP_H,
  COL_CAP_WIDEN,
  cIdx,
} from '../../constants.js'
import { COLUMN_MONUMENTAL, COLUMN_FURNITURE } from '../../mapTypes.js'

// Column dressing: bases and capitals so freestanding posts and monumental
// piers read as designed structure instead of bare extrusions.
export function dressColumns(data, trim) {
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const kind = data.cols[cIdx(x, z)]
      // Furniture cells are dressed by their own models (objects/furniture/);
      // only structural columns get a base + capital.
      if (!kind || kind === COLUMN_FURNITURE) continue
      const half = kind === COLUMN_MONUMENTAL ? MONUMENTAL_COL_HALF : COL_HALF
      const px = (x + 0.5) * CELL
      const pz = (z + 0.5) * CELL
      const baseW = (half + COL_BASE_WIDEN) * 2
      const capW = (half + COL_CAP_WIDEN) * 2
      // Base: a stepped plinth (lower wide step + narrower neck); capital: a
      // flare + abacus slab, so piers read as designed structure.
      trim.push({ px, py: COL_BASE_H / 2, pz, sx: baseW, sy: COL_BASE_H, sz: baseW })
      trim.push({ px, py: COL_BASE_H + 0.05, pz, sx: (half + 0.06) * 2, sy: 0.1, sz: (half + 0.06) * 2 })
      trim.push({ px, py: WALL_H - COL_CAP_H / 2, pz, sx: capW, sy: COL_CAP_H, sz: capW })
      trim.push({ px, py: WALL_H - COL_CAP_H - 0.05, pz, sx: (half + 0.08) * 2, sy: 0.1, sz: (half + 0.08) * 2 })
    }
  }
}
