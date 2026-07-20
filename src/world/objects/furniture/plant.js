import { PLANT_W, PLANT_H } from '../../constants.js'
import { FURN_TINT } from './palette.js'
import { builder } from './frame.js'

// Plant: clay pot (tapered), soil, crossed leaf slabs.
export function plant(f, out) {
  const b = builder(f, out)
  b(0, 0.16, 0, PLANT_W - 0.08, 0.32, PLANT_W - 0.08, FURN_TINT.potClay) // pot base
  b(0, 0.35, 0, PLANT_W, 0.1, PLANT_W, FURN_TINT.potClay) // pot rim
  b(0, 0.4, 0, PLANT_W - 0.1, 0.04, PLANT_W - 0.1, FURN_TINT.soil)
  b(0, 0.42 + (PLANT_H - 0.42) / 2 - 0.08, 0, 0.07, PLANT_H - 0.5, 0.07, FURN_TINT.leafGreen) // stem
  b(0, PLANT_H - 0.3, 0, PLANT_W + 0.15, 0.16, 0.1, FURN_TINT.leafGreen) // leaf cross u
  b(0, PLANT_H - 0.18, 0, 0.1, 0.16, PLANT_W + 0.15, FURN_TINT.leafGreen) // leaf cross v
  b(0, PLANT_H - 0.06, 0, PLANT_W - 0.05, 0.14, 0.09, FURN_TINT.leafGreen) // top leaf
}
