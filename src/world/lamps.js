import { CHUNK, fmod } from './constants.js'
import { hash2i } from './core/hash.js'

// Fluorescent ceiling lamps on a GLOBAL module grid (every `step` cells in world
// space), so the grid is perfectly regular AND continuous across chunk seams
// (the old per-chunk stepping jumped at boundaries). Seeded from an independent
// stream so lamp layout never perturbs the wall grid. Lit lamps drive the
// dynamic light pool; some are dead/dark so the world has unlit zones.
export function placeLights(data, ctx) {
  const { seed, cx, cz, zone, config } = ctx
  const { step, salt, deadChance } = config.lamps
  const chance = config.lamps.chance[zone] ?? 0.7
  data.lamps.length = 0
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const gx = cx * CHUNK + x
      const gz = cz * CHUNK + z
      if (fmod(gx, step) !== 0 || fmod(gz, step) !== 0) continue
      if (data.colAt(x, z)) continue // no lamp inside a column
      const h = hash2i((seed ^ salt) | 0, gx, gz)
      if (h / 4294967296 >= chance) continue // present?
      const lit = (h >>> 8) / 16777216 >= deadChance // independent bits for lit/dead
      data.lamps.push({ lx: x, lz: z, lit })
    }
  }
}
