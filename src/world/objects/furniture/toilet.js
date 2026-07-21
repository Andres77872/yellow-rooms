import { TOILET_W, TOILET_D, TOILET_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Toilet: tank against the wall (back), bowl base, seat + raised lid, flush
// button. Porcelain over a small chrome floor flange.
export function toilet(f, out) {
  const b = builder(f, out)
  const W = TOILET_W
  const D = TOILET_D
  b(0, 0.02, -(D / 2 - 0.2), 0.3, 0.04, 0.3, FURN_TINT.chrome) // floor flange
  b(0, TOILET_H - 0.19, -(D / 2 - 0.1), W, 0.38, 0.2, FURN_TINT.porcelain) // tank
  b(0, TOILET_H + 0.015, -(D / 2 - 0.1), 0.09, 0.03, 0.09, FURN_TINT.chrome) // flush button
  b(0, 0.19, 0.06, W - 0.12, 0.38, D - 0.34, FURN_TINT.porcelain) // pedestal
  b(0, 0.41, 0.08, W, 0.07, D - 0.26, FURN_TINT.porcelain) // bowl rim + seat
  b(0, 0.52, -(D / 2 - 0.26), W - 0.04, 0.16, 0.05, FURN_TINT.porcelain) // raised lid
}
