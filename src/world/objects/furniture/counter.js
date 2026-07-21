import { COUNTER_W, COUNTER_D, COUNTER_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Kitchen counter: base cabinet run with two door fronts, worktop, and a low
// backsplash strip against the wall. Runs of these read as the kitchen line.
export function counter(f, out) {
  const b = builder(f, out)
  const W = COUNTER_W
  const D = COUNTER_D
  b(0, 0.05, 0, W - 0.08, 0.1, D - 0.06, FURN_TINT.legMetal) // kick
  b(0, (COUNTER_H - 0.06) / 2 + 0.04, 0, W, COUNTER_H - 0.14, D - 0.04, FURN_TINT.woodDark)
  for (const s of [-1, 1]) {
    b(s * (W / 4 - 0.01), (COUNTER_H - 0.06) / 2, (D - 0.04) / 2 + 0.008,
      W / 2 - 0.06, COUNTER_H - 0.3, 0.015, FURN_TINT.woodMid) // door
    b(s * (W / 4 - 0.01), COUNTER_H - 0.2, (D - 0.04) / 2 + 0.028, 0.14, 0.025, 0.02, FURN_TINT.chrome) // handle
  }
  b(0, COUNTER_H - 0.03, 0, W + 0.03, 0.06, D, FURN_TINT.counterTop) // worktop
  b(0, COUNTER_H + 0.09, -(D / 2 - 0.02), W, 0.18, 0.03, FURN_TINT.counterTop) // backsplash
}
