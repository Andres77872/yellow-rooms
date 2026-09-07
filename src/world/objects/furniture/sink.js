import { SINK_W, SINK_D, SINK_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Vanity sink: cabinet base, porcelain basin with tap, and a mirror panel
// floating on the wall above — the piece backs onto a wall by placement, so
// the mirror always lands on real wall.
export function sink(f, out) {
  const b = builder(f, out)
  const W = SINK_W
  const D = SINK_D
  b(0, (SINK_H - 0.1) / 2, 0, W - 0.06, SINK_H - 0.1, D - 0.06, FURN_TINT.woodDark) // vanity
  b(0, (SINK_H - 0.1) / 2 + 0.02, (D - 0.06) / 2 + 0.008, W - 0.12, SINK_H - 0.24, 0.015, FURN_TINT.woodMid) // door
  b(0, SINK_H - 0.42, (D - 0.06) / 2 + 0.028, 0.03, 0.16, 0.02, FURN_TINT.chrome) // door handle
  b(0, SINK_H - 0.08, 0, W, 0.06, D, FURN_TINT.porcelain) // counter
  for (const side of [-1, 1]) {
    b(side * 0.235, SINK_H, 0.02, 0.04, 0.1, 0.35, FURN_TINT.porcelain)
    b(0, SINK_H, 0.02 + side * 0.155, 0.43, 0.1, 0.04, FURN_TINT.porcelain)
  }
  b(0, SINK_H - 0.045, 0.02, 0.43, 0.014, 0.27, FURN_TINT.porcelain) // recessed basin
  b(0, SINK_H - 0.032, 0.02, 0.04, 0.012, 0.04, FURN_TINT.chrome) // drain
  b(0, SINK_H + 0.09, -(D / 2 - 0.09), 0.05, 0.18, 0.05, FURN_TINT.chrome) // tap riser
  b(0, SINK_H + 0.16, -(D / 2 - 0.17), 0.04, 0.04, 0.16, FURN_TINT.chrome) // spout
  b(0, 1.62, -(D / 2 - 0.02), W - 0.08, 0.72, 0.03, FURN_TINT.mirror) // mirror
  b(0, 1.24, -(D / 2 - 0.02), W - 0.02, 0.04, 0.05, FURN_TINT.woodDark) // mirror shelf
  b(W / 2 + 0.03, 1.2, 0, 0.05, 0.03, 0.26, FURN_TINT.chrome) // towel bar
  b(W / 2 + 0.02, 1.05, 0, 0.03, 0.32, 0.22, FURN_TINT.towel) // hung towel
}
