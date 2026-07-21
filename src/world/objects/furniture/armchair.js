import { ARMCHAIR_W, ARMCHAIR_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Armchair: single upholstered seat — the sofa language at one-seat scale,
// with a draped throw accent over one arm.
export function armchair(f, out) {
  const b = builder(f, out)
  const W = ARMCHAIR_W
  const D = ARMCHAIR_W
  for (const [su, sv] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    b(su * (W / 2 - 0.07), 0.03, sv * (D / 2 - 0.06), 0.06, 0.06, 0.06, FURN_TINT.legMetal)
  }
  b(0, 0.22, 0, W - 0.14, 0.26, D - 0.1, FURN_TINT.sofa) // base
  for (const s of [-1, 1]) {
    b(s * (W / 2 - 0.07), 0.44, 0, 0.14, 0.72, D, FURN_TINT.sofa) // arms
  }
  b(0, ARMCHAIR_H - 0.36, -(D / 2 - 0.08), W - 0.14, 0.72, 0.16, FURN_TINT.sofa) // back
  b(0, 0.4, 0.04, W - 0.3, 0.12, D - 0.32, FURN_TINT.sofaCushion) // seat cushion
  b(-(W / 2 - 0.07), 0.815, 0.02, 0.16, 0.03, D - 0.2, FURN_TINT.rug) // draped throw
}
