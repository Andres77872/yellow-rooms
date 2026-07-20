import { CHAIR_W, CHAIR_H, CHAIR_SEAT_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Task chair: upholstered seat + back on a gas-lift post with a four-star
// caster base — the office read, not a dining chair.
export function chair(f, out) {
  const b = builder(f, out)
  const W = CHAIR_W
  b(0, CHAIR_SEAT_H, 0, W - 0.04, 0.07, W - 0.04, FURN_TINT.fabric) // seat
  b(0, CHAIR_SEAT_H + 0.07 + (CHAIR_H - CHAIR_SEAT_H - 0.07) / 2, -(W / 2 - 0.04),
    W - 0.06, CHAIR_H - CHAIR_SEAT_H - 0.07, 0.05, FURN_TINT.fabric) // back
  // Gas-lift post under the seat centre.
  b(0, (CHAIR_SEAT_H - 0.035) / 2 + 0.02, 0, 0.06, CHAIR_SEAT_H - 0.075, 0.06, FURN_TINT.legMetal)
  // Four-star base: two crossed slabs at floor level.
  b(0, 0.045, 0, W - 0.03, 0.045, 0.09, FURN_TINT.legMetal)
  b(0, 0.045, 0, 0.09, 0.045, W - 0.03, FURN_TINT.legMetal)
  // Caster nubs at the four star tips.
  const tip = (W - 0.03) / 2 - 0.03
  for (const [cu, cv] of [[tip, 0], [-tip, 0], [0, tip], [0, -tip]]) {
    b(cu, 0.015, cv, 0.05, 0.03, 0.05, FURN_TINT.keyDark)
  }
}
