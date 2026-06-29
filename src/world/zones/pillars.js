import { CHUNK, ZONE_PILLARS, fmod } from '../constants.js'
import { clearTransitionColumns } from './ZoneGenerator.js'

export const id = ZONE_PILLARS

// Open hall with a column lattice phased on GLOBAL coordinates, so columns line
// up perfectly across chunk seams ("columns for miles"). No interior wall edges
// at all → the cell graph is the full 4-connected grid (columns block a small
// AABB but never a cell edge, so connectivity is untouched).
export function generate(data, ctx) {
  const { cx, cz, zone, config, borders, borderZones } = ctx
  const { spacing, phase } = config.pillars
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const gx = cx * CHUNK + x
      const gz = cz * CHUNK + z
      if (fmod(gx, spacing) === phase && fmod(gz, spacing) === phase) {
        data.setCol(x, z, 1)
      }
    }
  }
  clearTransitionColumns(data, borders, borderZones, zone, config)
}
