import { NIGHTSTAND_W, NIGHTSTAND_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Nightstand: small bedside unit — carcass, drawer front + knob, and a tiny
// table lamp (base, stem, shade) so the top reads lived-in.
export function nightstand(f, out) {
  const b = builder(f, out)
  const W = NIGHTSTAND_W
  b(0, 0.03, 0, W - 0.08, 0.06, W - 0.1, FURN_TINT.legMetal) // plinth
  b(0, NIGHTSTAND_H / 2 + 0.04, 0, W, NIGHTSTAND_H - 0.08, W - 0.04, FURN_TINT.woodDark)
  b(0, NIGHTSTAND_H - 0.16, (W - 0.04) / 2 + 0.008, W - 0.1, 0.14, 0.015, FURN_TINT.woodMid) // drawer
  b(0, NIGHTSTAND_H - 0.16, (W - 0.04) / 2 + 0.03, 0.05, 0.03, 0.025, FURN_TINT.chrome) // knob
  b(0, NIGHTSTAND_H + 0.015, 0, 0.12, 0.03, 0.12, FURN_TINT.chrome) // lamp base
  b(0, NIGHTSTAND_H + 0.1, 0, 0.03, 0.16, 0.03, FURN_TINT.chrome) // lamp stem
  b(0, NIGHTSTAND_H + 0.22, 0, 0.14, 0.1, 0.14, FURN_TINT.shade) // lamp shade
}
