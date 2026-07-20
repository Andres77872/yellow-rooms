import { WHITEBOARD_W, WHITEBOARD_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Whiteboard: wall-hugging meeting board — framed enamel panel with a marker
// tray, markers, an eraser, and faint half-erased writing: the meeting
// room's landmark read.
export function whiteboard(f, out) {
  const b = builder(f, out)
  const W = WHITEBOARD_W
  const H = WHITEBOARD_H
  const cy = 0.7 + H / 2 // panel centre height (bottom edge at 0.7)
  b(0, cy, 0, W, H, 0.04, FURN_TINT.boardWhite) // enamel panel
  // Frame rails + side caps.
  b(0, cy + H / 2 + 0.015, 0, W + 0.04, 0.05, 0.05, FURN_TINT.legMetal)
  b(0, cy - H / 2 - 0.015, 0, W + 0.04, 0.05, 0.05, FURN_TINT.legMetal)
  for (const s of [-1, 1]) {
    b(s * (W / 2 + 0.01), cy, 0, 0.04, H + 0.08, 0.05, FURN_TINT.legMetal)
  }
  // Half-erased writing: a few faint lines and one red diagram box.
  b(-0.35, cy + 0.28, 0.022, 0.6, 0.03, 0.004, FURN_TINT.keyDark)
  b(-0.45, cy + 0.16, 0.022, 0.35, 0.03, 0.004, FURN_TINT.keyDark)
  b(-0.3, cy + 0.04, 0.022, 0.45, 0.03, 0.004, FURN_TINT.keyDark)
  b(0.5, cy + 0.1, 0.022, 0.28, 0.2, 0.004, FURN_TINT.bookRed)
  // Marker tray with a marker and an eraser.
  b(0, 0.66, 0.05, W - 0.4, 0.03, 0.09, FURN_TINT.legMetal)
  b(-0.35, 0.695, 0.05, 0.12, 0.025, 0.03, FURN_TINT.keyDark)
  b(0.4, 0.7, 0.05, 0.1, 0.04, 0.05, FURN_TINT.panel)
}
