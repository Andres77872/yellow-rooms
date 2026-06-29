import { ZONE_OFFICE, ZONE_PILLARS, ZONE_WAREHOUSE } from '../constants.js'
import { valueNoise2D } from '../core/noise.js'
import * as office from './office.js'
import * as pillars from './pillars.js'
import * as warehouse from './warehouse.js'

// Zone registry: id -> generator module ({ id, generate(data, ctx) }).
export const ZONES = {
  [ZONE_OFFICE]: office,
  [ZONE_PILLARS]: pillars,
  [ZONE_WAREHOUSE]: warehouse,
}

// Pick a chunk's zone from the low-frequency region field. Pure function of
// (cx, cz, seed) so neighbours usually share a style and both sides of a seam
// agree on each other's zone (needed by border reconciliation).
export function selectZone(cx, cz, seed, config) {
  const { scale, salt } = config.region
  const v = valueNoise2D(cx / scale, cz / scale, (seed ^ salt) | 0)
  for (const band of config.zoneBands) {
    if (v < band.max) return band.id
  }
  return config.zoneBands[config.zoneBands.length - 1].id
}
