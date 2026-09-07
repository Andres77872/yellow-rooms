import { TUB_W, TUB_D, TUB_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Bathtub: open enamel shell with a recessed floor and wall-end taps.
export function tub(f, out) {
  const b = builder(f, out)
  const W = TUB_W
  const D = TUB_D
  b(0, 0.075, 0, W - 0.08, 0.15, D - 0.08, FURN_TINT.porcelain)
  for (const side of [-1, 1]) {
    b(0, (TUB_H + 0.1) / 2, side * (D / 2 - 0.055), W, TUB_H - 0.1, 0.11, FURN_TINT.porcelain)
    b(side * (W / 2 - 0.055), (TUB_H + 0.1) / 2, 0, 0.11, TUB_H - 0.1, D - 0.22, FURN_TINT.porcelain)
    b(0, TUB_H - 0.015, side * (D / 2 - 0.035), W + 0.06, 0.05, 0.13, FURN_TINT.porcelain)
    b(side * (W / 2 - 0.035), TUB_H - 0.015, 0, 0.13, 0.05, D - 0.2, FURN_TINT.porcelain)
  }
  b(-(W / 2 - 0.26), 0.156, 0, 0.045, 0.012, 0.045, FURN_TINT.chrome) // drain
  b(-(W / 2 - 0.14), TUB_H + 0.1, -(D / 2 - 0.1), 0.04, 0.2, 0.04, FURN_TINT.chrome) // tap riser
  b(-(W / 2 - 0.14), TUB_H + 0.19, -(D / 2 - 0.2), 0.035, 0.035, 0.16, FURN_TINT.chrome) // spout
}
