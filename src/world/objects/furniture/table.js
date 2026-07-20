import { TABLE_W, TABLE_D, TABLE_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Conference table: long top on two panel legs + a stretcher beam, with
// power/data grommets along the centre line.
export function table(f, out) {
  const b = builder(f, out)
  b(0, TABLE_H - 0.03, 0, TABLE_W, 0.06, TABLE_D, FURN_TINT.laminate)
  b(-(TABLE_W / 2 - 0.15), (TABLE_H - 0.06) / 2, 0, 0.08, TABLE_H - 0.06, TABLE_D - 0.1, FURN_TINT.panel)
  b(TABLE_W / 2 - 0.15, (TABLE_H - 0.06) / 2, 0, 0.08, TABLE_H - 0.06, TABLE_D - 0.1, FURN_TINT.panel)
  b(0, 0.3, 0, TABLE_W - 0.5, 0.08, 0.06, FURN_TINT.legMetal) // stretcher
  // Flush power/data grommets down the centre of the top.
  for (const s of [-1, 1]) {
    b(s * (TABLE_W / 4), TABLE_H + 0.002, 0, 0.14, 0.012, 0.14, FURN_TINT.keyDark)
  }
}
