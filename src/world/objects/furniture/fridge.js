import { FRIDGE_W, FRIDGE_D, FRIDGE_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Refrigerator: tall enamel box, freezer/fridge door split with long
// handles, dark plinth vent. The kitchen's landmark silhouette.
export function fridge(f, out) {
  const b = builder(f, out)
  const W = FRIDGE_W
  const D = FRIDGE_D
  b(0, 0.05, 0, W - 0.06, 0.1, D - 0.06, FURN_TINT.slotDark) // plinth vent
  b(0, FRIDGE_H / 2 + 0.04, 0, W, FRIDGE_H - 0.1, D, FURN_TINT.applianceWhite)
  b(0, FRIDGE_H - 0.28, D / 2 + 0.008, W - 0.04, 0.5, 0.015, FURN_TINT.applianceWhite) // freezer door
  b(0, (FRIDGE_H - 0.62) / 2 + 0.08, D / 2 + 0.008, W - 0.04, FRIDGE_H - 0.72, 0.015, FURN_TINT.applianceWhite) // main door
  b(0, FRIDGE_H - 0.56, D / 2 + 0.012, W - 0.08, 0.02, 0.02, FURN_TINT.slotDark) // door split
  for (const y of [FRIDGE_H - 0.3, FRIDGE_H - 0.95]) {
    b(-(W / 2 - 0.08), y, D / 2 + 0.035, 0.035, 0.34, 0.03, FURN_TINT.applianceSteel) // handle
  }
}
