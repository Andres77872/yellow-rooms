import { SOFA_W, SOFA_D, SOFA_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Lobby sofa: low two-seat couch — base, arms, back, loose cushions, short
// feet. The break room's "people waited here" read.
export function sofa(f, out) {
  const b = builder(f, out)
  const W = SOFA_W
  const D = SOFA_D
  // Short feet at the corners.
  for (const [su, sv] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    b(su * (W / 2 - 0.08), 0.03, sv * (D / 2 - 0.06), 0.06, 0.06, 0.06, FURN_TINT.legMetal)
  }
  b(0, 0.22, 0, W - 0.16, 0.26, D - 0.12, FURN_TINT.sofa) // base platform
  // Arms and back rise from the base; the back tops out at SOFA_H.
  for (const s of [-1, 1]) {
    b(s * (W / 2 - 0.07), 0.45, 0, 0.14, 0.78, D, FURN_TINT.sofa) // arm
  }
  b(0, SOFA_H - 0.38, -(D / 2 - 0.08), W - 0.16, 0.76, 0.16, FURN_TINT.sofa) // back
  // Loose seat + back cushions, two seats wide.
  for (const s of [-1, 1]) {
    b(s * (W / 4 - 0.02), 0.41, 0.05, W / 2 - 0.18, 0.14, D - 0.36, FURN_TINT.sofaCushion)
    b(s * (W / 4 - 0.02), 0.66, -(D / 2 - 0.22), W / 2 - 0.18, 0.32, 0.14, FURN_TINT.sofaCushion)
  }
}
