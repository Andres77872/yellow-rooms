import { TUB_W, TUB_D, TUB_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Bathtub: enamel shell along the wall, proud rim, inner water hollow read as
// a dark inset, wall-end taps. Long side backs onto the wall.
export function tub(f, out) {
  const b = builder(f, out)
  const W = TUB_W
  const D = TUB_D
  b(0, (TUB_H - 0.08) / 2, 0, W, TUB_H - 0.08, D, FURN_TINT.porcelain) // shell
  b(0, TUB_H - 0.04, 0, W + 0.06, 0.08, D + 0.06, FURN_TINT.porcelain) // rim
  b(0, TUB_H - 0.015, 0, W - 0.22, 0.03, D - 0.22, FURN_TINT.mirror) // water inset
  b(-(W / 2 - 0.14), TUB_H + 0.1, -(D / 2 - 0.1), 0.04, 0.2, 0.04, FURN_TINT.chrome) // tap riser
  b(-(W / 2 - 0.14), TUB_H + 0.19, -(D / 2 - 0.2), 0.035, 0.035, 0.16, FURN_TINT.chrome) // spout
}
