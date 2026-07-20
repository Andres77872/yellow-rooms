import { COOLER_W, COOLER_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Water cooler: base unit, blue bottle (body + neck), tap, and a cup
// dispenser tube on the flank.
export function cooler(f, out) {
  const b = builder(f, out)
  b(0, 0.45, 0, COOLER_W, 0.9, COOLER_W, FURN_TINT.coolerWhite)
  b(0, 0.98, 0, COOLER_W - 0.1, 0.2, COOLER_W - 0.1, FURN_TINT.bottleBlue) // bottle body
  b(0, 0.9 + (COOLER_H - 0.9) / 2, 0, 0.18, COOLER_H - 1.08, 0.18, FURN_TINT.bottleBlue) // neck
  b(0, 0.78, COOLER_W / 2 + 0.02, 0.1, 0.05, 0.05, FURN_TINT.legMetal) // tap
  b(0, 0.68, COOLER_W / 2 + 0.01, 0.2, 0.03, 0.06, FURN_TINT.slotDark) // drip tray
  // Cup dispenser tube on the right flank.
  b(COOLER_W / 2 + 0.025, 0.72, 0.04, 0.05, 0.26, 0.07, FURN_TINT.coolerWhite)
  b(COOLER_W / 2 + 0.025, 0.58, 0.04, 0.04, 0.03, 0.05, FURN_TINT.slotDark)
}
