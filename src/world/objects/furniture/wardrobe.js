import { WARDROBE_W, WARDROBE_D, WARDROBE_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Wardrobe: tall two-door bedroom storage — the residential cabinet. Wood
// carcass, door fronts with long handles, a proud cornice and a kick base.
export function wardrobe(f, out) {
  const b = builder(f, out)
  const W = WARDROBE_W
  const D = WARDROBE_D
  b(0, 0.05, 0, W - 0.08, 0.1, D - 0.06, FURN_TINT.woodDark) // kick
  b(0, WARDROBE_H / 2 + 0.04, 0, W, WARDROBE_H - 0.1, D, FURN_TINT.woodDark)
  b(0, WARDROBE_H - 0.03, 0, W + 0.06, 0.06, D + 0.04, FURN_TINT.woodMid) // cornice
  for (const s of [-1, 1]) {
    b(s * (W / 4 - 0.01), WARDROBE_H / 2, D / 2 + 0.008,
      W / 2 - 0.05, WARDROBE_H - 0.3, 0.015, FURN_TINT.woodMid) // door
    b(s * 0.06, WARDROBE_H / 2 + 0.1, D / 2 + 0.028, 0.03, 0.34, 0.02, FURN_TINT.chrome) // handle
  }
}
