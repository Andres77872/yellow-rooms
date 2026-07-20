import { RACK_W, RACK_D, RACK_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Server rack: tall dark cabinet, slotted front, blinking-free LEDs.
export function rack(f, out) {
  const b = builder(f, out)
  b(0, 0.05, 0, RACK_W - 0.06, 0.1, RACK_D - 0.04, FURN_TINT.legMetal) // kick
  b(0, RACK_H / 2 + 0.04, 0, RACK_W, RACK_H - 0.1, RACK_D, FURN_TINT.rackDark)
  // Front panel with horizontal ventilation slots.
  b(0, RACK_H / 2 + 0.04, RACK_D / 2 + 0.006, RACK_W - 0.1, RACK_H - 0.2, 0.015, FURN_TINT.rackFace)
  for (let s = 0; s < 5; s++) {
    b(0, 0.45 + s * 0.28, RACK_D / 2 + 0.016, RACK_W - 0.2, 0.05, 0.008, FURN_TINT.rackDark)
  }
  // Status LEDs down one edge — the only "alive" detail in the room.
  for (let s = 0; s < 3; s++) {
    b(-(RACK_W / 2 - 0.12), 0.6 + s * 0.42, RACK_D / 2 + 0.02, 0.04, 0.04, 0.01, FURN_TINT.ledGreen)
  }
}
