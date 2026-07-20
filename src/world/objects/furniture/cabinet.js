import { CABINET_W, CABINET_D, CABINET_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Cabinet: tall two-door storage with handles, label holders, and a kick base.
export function cabinet(f, out) {
  const b = builder(f, out)
  b(0, 0.05, 0, CABINET_W - 0.06, 0.1, CABINET_D - 0.04, FURN_TINT.legMetal) // kick
  b(0, CABINET_H / 2 + 0.04, 0, CABINET_W, CABINET_H - 0.1, CABINET_D, FURN_TINT.cabinetPaint)
  for (const s of [-1, 1]) {
    b(s * (CABINET_W / 4 - 0.01), CABINET_H / 2 + 0.04, CABINET_D / 2 + 0.008,
      CABINET_W / 2 - 0.04, CABINET_H - 0.24, 0.015, FURN_TINT.panel) // door
    b(s * 0.05, CABINET_H / 2 + 0.04, CABINET_D / 2 + 0.025, 0.03, 0.18, 0.02, FURN_TINT.legMetal) // handle
    // Recessed label holder high on each door.
    b(s * (CABINET_W / 4 - 0.01), CABINET_H - 0.4, CABINET_D / 2 + 0.018, 0.18, 0.06, 0.012, FURN_TINT.slotDark)
  }
}
