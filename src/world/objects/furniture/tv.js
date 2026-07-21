import { TV_W, TV_D, TV_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Media console: low sideboard with sliding fronts and a dark flat TV panel
// standing on it — the living room's focal wall piece.
export function tv(f, out) {
  const b = builder(f, out)
  const W = TV_W
  const D = TV_D
  for (const s of [-1, 1]) {
    b(s * (W / 2 - 0.09), 0.05, 0, 0.07, 0.1, D - 0.1, FURN_TINT.legMetal) // feet
  }
  b(0, 0.28, 0, W, 0.36, D, FURN_TINT.woodDark) // console body
  for (const s of [-1, 1]) {
    b(s * (W / 4 - 0.01), 0.28, D / 2 + 0.008, W / 2 - 0.05, 0.26, 0.015, FURN_TINT.woodMid)
  }
  b(0, 0.6, -0.04, 0.34, 0.28, 0.2, FURN_TINT.tvBlack) // TV neck (rises into the panel)
  b(0, TV_H - 0.32, -0.06, W - 0.28, 0.62, 0.045, FURN_TINT.tvBlack) // TV panel
  b(0, TV_H - 0.32, -0.035, W - 0.36, 0.54, 0.01, FURN_TINT.screen) // screen glass
}
