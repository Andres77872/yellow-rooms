import { CHUNK, ZONE_WAREHOUSE, fmod } from '../constants.js'
import { hash2i } from '../core/hash.js'
import { warehouseWallH, warehouseWallV } from './warehouseFragments.js'
import { carveTransitionThresholds, clearTransitionColumns } from './ZoneGenerator.js'

export const id = ZONE_WAREHOUSE

function structuralColumn(gx, gz, seed, config) {
  const cfg = config.warehouse.columns
  if (!cfg || cfg.chance <= 0) return false
  const px = hash2i((seed ^ cfg.phaseSalt) | 0, 0x58, 0) % cfg.spacing
  const pz = hash2i((seed ^ cfg.phaseSalt) | 0, 0x5a, 0) % cfg.spacing
  if (fmod(gx - px, cfg.spacing) !== 0 || fmod(gz - pz, cfg.spacing) !== 0) return false
  return hash2i((seed ^ cfg.salt) | 0, gx, gz) / 4294967296 < cfg.chance
}

// Big open liminal space: mostly empty, with a few short STRAIGHT wall fragments
// and rare freestanding columns. Wall fragments are generated from global edge
// coordinates, so a run can continue across chunk seams without neighbour
// communication. Connectivity is still guarded by the multi-chunk flood tests.
export function generate(data, ctx) {
  const { seed, cx, cz, zone, config, borders, borderZones } = ctx
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

  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const gx = cx * CHUNK + x
      const gz = cz * CHUNK + z
      if (structuralColumn(gx, gz, seed, config)) data.setCol(x, z, 1)
    }
  }
  clearTransitionColumns(data, borders, borderZones, zone, config)
}
