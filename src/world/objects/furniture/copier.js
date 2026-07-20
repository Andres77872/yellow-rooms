import { COPIER_W, COPIER_D, COPIER_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Photocopier: body, scanner lid with raised feeder lip, output slot, paper
// tray with a finished paper stack.
export function copier(f, out) {
  const b = builder(f, out)
  b(0, (COPIER_H - 0.12) / 2, 0, COPIER_W, COPIER_H - 0.12, COPIER_D, FURN_TINT.copierBody)
  b(0, COPIER_H - 0.06, -0.02, COPIER_W - 0.06, 0.1, COPIER_D - 0.08, FURN_TINT.panel) // lid
  // Feeder lip raised at the back of the lid.
  b(0, COPIER_H + 0.025, -(COPIER_D / 2 - 0.1), COPIER_W - 0.2, 0.05, 0.14, FURN_TINT.panel)
  b(0, 0.62, COPIER_D / 2 + 0.006, COPIER_W - 0.2, 0.09, 0.02, FURN_TINT.slotDark) // output slot
  b(0, 0.3, COPIER_D / 2 + 0.01, COPIER_W - 0.14, 0.16, 0.03, FURN_TINT.drawerFace) // tray
  // Finished copies stacked in the output tray.
  b(0, 0.4, COPIER_D / 2 + 0.02, COPIER_W - 0.22, 0.04, 0.04, FURN_TINT.paperWhite)
  b(COPIER_W / 2 - 0.1, COPIER_H - 0.02, 0.12, 0.14, 0.03, 0.2, FURN_TINT.keyDark) // control strip
}
