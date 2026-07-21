import { STOVE_W, STOVE_D, STOVE_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Stove: freestanding range — enamel body, steel hob plate with four dark
// burners, oven door with window and handle, and a control backsplash.
export function stove(f, out) {
  const b = builder(f, out)
  const W = STOVE_W
  const D = STOVE_D
  b(0, (STOVE_H - 0.05) / 2, 0, W, STOVE_H - 0.05, D, FURN_TINT.applianceWhite) // body
  b(0, STOVE_H - 0.02, 0, W - 0.04, 0.04, D - 0.04, FURN_TINT.applianceSteel) // hob plate
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      b(su * (W / 4 - 0.03), STOVE_H + 0.005, sv * (D / 4 - 0.03),
        0.16, 0.015, 0.16, FURN_TINT.burner)
    }
  }
  b(0, STOVE_H + 0.13, -(D / 2 - 0.025), W, 0.24, 0.05, FURN_TINT.applianceWhite) // control back
  b(0, STOVE_H + 0.14, -(D / 2 - 0.055), W - 0.2, 0.1, 0.02, FURN_TINT.burner) // dials strip
  b(0, 0.42, D / 2 + 0.008, W - 0.1, 0.4, 0.015, FURN_TINT.applianceSteel) // oven door
  b(0, 0.45, D / 2 + 0.02, W - 0.24, 0.22, 0.012, FURN_TINT.burner) // oven window
  b(0, 0.66, D / 2 + 0.035, W - 0.14, 0.03, 0.03, FURN_TINT.chrome) // door handle
}
