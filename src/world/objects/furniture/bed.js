import { BED_W, BED_D, BED_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Bed: headboard against the wall (back, -v), frame, mattress, a folded
// blanket band across the foot, two pillows at the head. The made-but-empty
// hotel-room read.
export function bed(f, out) {
  const b = builder(f, out)
  const W = BED_W
  const D = BED_D
  b(0, BED_H + 0.08, -(D / 2 - 0.04), W, 1.12, 0.08, FURN_TINT.bedFrame) // headboard (drops into the deck)
  // Frame corner feet + side rails.
  for (const [su, sv] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    b(su * (W / 2 - 0.06), 0.09, sv * (D / 2 - 0.07), 0.09, 0.18, 0.09, FURN_TINT.bedFrame)
  }
  b(0, 0.24, 0, W, 0.14, D, FURN_TINT.bedFrame) // frame deck
  b(0, 0.42, 0.02, W - 0.08, 0.24, D - 0.14, FURN_TINT.mattress) // mattress
  b(0, 0.555, D / 2 - 0.48, W - 0.06, 0.05, 0.85, FURN_TINT.blanket) // blanket band
  for (const s of [-1, 1]) {
    b(s * (W / 4 - 0.02), 0.585, -(D / 2 - 0.32), W / 2 - 0.16, 0.1, 0.4, FURN_TINT.pillow)
  }
}
