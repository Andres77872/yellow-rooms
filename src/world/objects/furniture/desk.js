import { DESK_W, DESK_D, DESK_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Desk: worktop on leg panels, modesty panel, drawer stack with handles,
// monitor + keyboard on top, plus a desk lamp and a paper stack — the
// occupied-workstation read.
export function desk(f, out) {
  const b = builder(f, out)
  const W = DESK_W
  const D = DESK_D
  b(0, DESK_H - 0.025, 0, W, 0.05, D, FURN_TINT.laminate) // top
  b(-(W / 2 - 0.05), (DESK_H - 0.05) / 2, 0, 0.06, DESK_H - 0.05, D - 0.06, FURN_TINT.legMetal)
  b(W / 2 - 0.05, (DESK_H - 0.05) / 2, 0, 0.06, DESK_H - 0.05, D - 0.06, FURN_TINT.legMetal)
  b(0, 0.42, -(D / 2 - 0.06), W - 0.16, 0.42, 0.03, FURN_TINT.panel) // modesty panel
  // Drawer stack on the right, two drawer fronts + handle nubs.
  b(W / 2 - 0.3, 0.32, 0, 0.44, 0.58, D - 0.1, FURN_TINT.panel)
  b(W / 2 - 0.3, 0.47, D / 2 - 0.065, 0.38, 0.2, 0.02, FURN_TINT.drawerFace)
  b(W / 2 - 0.3, 0.2, D / 2 - 0.065, 0.38, 0.28, 0.02, FURN_TINT.drawerFace)
  b(W / 2 - 0.3, 0.4, D / 2 - 0.04, 0.12, 0.02, 0.03, FURN_TINT.legMetal)
  b(W / 2 - 0.3, 0.34, D / 2 - 0.04, 0.12, 0.02, 0.03, FURN_TINT.legMetal)
  // Monitor (screen + stand) and keyboard — the occupied-desk read.
  b(-0.18, DESK_H + 0.2, -0.12, 0.55, 0.34, 0.04, FURN_TINT.screen)
  b(-0.18, DESK_H + 0.03, -0.1, 0.08, 0.06, 0.12, FURN_TINT.legMetal)
  b(-0.05, DESK_H + 0.008, 0.16, 0.45, 0.015, 0.16, FURN_TINT.keyDark)
  // Desk lamp at the back-left corner: base, arm, head.
  b(-(W / 2 - 0.15), DESK_H + 0.015, -(D / 2 - 0.12), 0.14, 0.03, 0.14, FURN_TINT.legMetal)
  b(-(W / 2 - 0.15), DESK_H + 0.17, -(D / 2 - 0.12), 0.03, 0.28, 0.03, FURN_TINT.legMetal)
  b(-(W / 2 - 0.15), DESK_H + 0.32, -(D / 2 - 0.2), 0.12, 0.06, 0.16, FURN_TINT.keyDark)
  // Paper stack by the front-left corner.
  b(-(W / 2 - 0.25), DESK_H + 0.02, D / 2 - 0.18, 0.3, 0.04, 0.21, FURN_TINT.paperWhite)
}
