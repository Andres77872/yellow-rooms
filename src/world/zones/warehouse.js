import { CHUNK, ZONE_WAREHOUSE } from '../constants.js'
import { warehouseWallH, warehouseWallV } from '../layoutGuides.js'
import { carveTransitionThresholds, clearTransitionColumns } from './ZoneGenerator.js'

export const id = ZONE_WAREHOUSE

// Big open liminal space: mostly empty, with a few short STRAIGHT wall fragments
// and rare freestanding columns. Wall fragments are generated from global edge
// coordinates, so a run can continue across chunk seams without neighbour
// communication. Connectivity is still guarded by the multi-chunk flood tests.
export function generate(data, ctx) {
  const { seed, cx, cz, rng, zone, config, borders, borderZones } = ctx
  const cfg = config.warehouse

  for (let lz = 1; lz < CHUNK; lz++) {
    const lineGz = cz * CHUNK + lz
    for (let x = 0; x < CHUNK; x++) {
      const gx = cx * CHUNK + x
      if (warehouseWallH(gx, lineGz, seed, config)) data.setH(x, lz, 1)
    }
  }
  for (let lx = 1; lx < CHUNK; lx++) {
    const lineGx = cx * CHUNK + lx
    for (let z = 0; z < CHUNK; z++) {
      const gz = cz * CHUNK + z
      if (warehouseWallV(lineGx, gz, seed, config)) data.setV(lx, z, 1)
    }
  }

  carveTransitionThresholds(data, borders, borderZones, zone, config)

  for (let z = 1; z < CHUNK - 1; z++) {
    for (let x = 1; x < CHUNK - 1; x++) {
      if (rng.chance(cfg.colChance)) data.setCol(x, z, 1)
    }
  }
  clearTransitionColumns(data, borders, borderZones, zone, config)
}
