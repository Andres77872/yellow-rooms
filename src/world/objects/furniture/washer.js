import { WASHER_W, WASHER_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Washer: front-loading cube — enamel body, dark porthole door with a chrome
// ring, control strip along the top. Rows of them read as the laundry room.
export function washer(f, out) {
  const b = builder(f, out)
  const W = WASHER_W
  b(0, (WASHER_H - 0.04) / 2, 0, W, WASHER_H - 0.04, W, FURN_TINT.applianceWhite)
  b(0, WASHER_H - 0.015, 0, W - 0.03, 0.03, W - 0.03, FURN_TINT.applianceSteel) // top plate
  b(0, WASHER_H - 0.085, W / 2 + 0.005, W - 0.08, 0.09, 0.012, FURN_TINT.applianceSteel) // control strip
  b(-(W / 2 - 0.11), WASHER_H - 0.085, W / 2 + 0.02, 0.06, 0.06, 0.015, FURN_TINT.burner) // dial
  b(0, 0.38, W / 2 + 0.008, 0.4, 0.4, 0.015, FURN_TINT.chrome) // porthole ring
  b(0, 0.38, W / 2 + 0.02, 0.3, 0.3, 0.012, FURN_TINT.burner) // porthole glass
}
