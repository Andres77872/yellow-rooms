import { CHUNK, ZONE_PILLARS, fmod } from '../constants.js'
import { hash2i } from '../core/hash.js'
import {
  COLUMN_MONUMENTAL,
  COLUMN_NONE,
  COLUMN_STANDARD,
} from '../mapTypes.js'
import { regionLandmarkAt, regionLandmarkContains } from './regions.js'
import { clearTransitionColumns } from './ZoneGenerator.js'

export const id = ZONE_PILLARS

// Bounded hypostyle hall with wide structural bays phased on GLOBAL coordinates,
// so columns line up across every seam inside one landmark pocket. No interior
// wall edges → the thin-wall graph is the full 4-connected grid. The separate
// column-aware navigation graph still accounts for each typed support.
const latticeBelow = (value, spacing, phase) =>
  phase + Math.floor((value - phase) / spacing) * spacing

function landmarkCenter(landmark, axis) {
  const lo = (axis === 'x' ? landmark.x0 : landmark.z0) * CHUNK
  const hi = ((axis === 'x' ? landmark.x1 : landmark.z1) + 1) * CHUNK - 1
  return (lo + hi) / 2
}

// Pure global-cell signature shared by every chunk slice of one landmark.
// Forced/custom pillar-only profiles have no bounded macro descriptor and use
// the legacy per-support probability fallback.
export function pillarColumnKindAt(seed, gx, gz, landmark, config) {
  const {
    spacing,
    phase,
    monumentalChance = 0,
    monumentalSalt = 0x5049,
  } = config.pillars
  if (fmod(gx, spacing) !== phase || fmod(gz, spacing) !== phase) {
    return COLUMN_NONE
  }

  if (landmark) {
    if (landmark.pierPattern === 'processionalAisle') {
      const crossCenter = landmarkCenter(landmark, landmark.axis === 'x' ? 'z' : 'x')
      const lowerFlank = latticeBelow(crossCenter, spacing, phase)
      const cross = landmark.axis === 'x' ? gz : gx
      return cross === lowerFlank || cross === lowerFlank + spacing
        ? COLUMN_MONUMENTAL
        : COLUMN_STANDARD
    }
    if (landmark.pierPattern === 'brokenBay') {
      const missingX = phase + Math.round(
        (landmarkCenter(landmark, 'x') - phase) / spacing
      ) * spacing
      const missingZ = phase + Math.round(
        (landmarkCenter(landmark, 'z') - phase) / spacing
      ) * spacing
      if (gx === missingX && gz === missingZ) return COLUMN_NONE
    }
    // Monumental grids, broken-bay remainders, and court colonnades use one
    // coherent pier scale instead of independently speckled post sizes.
    return COLUMN_MONUMENTAL
  }

  const roll = hash2i((seed ^ monumentalSalt) | 0, gx, gz) / 4294967296
  return roll < monumentalChance ? COLUMN_MONUMENTAL : COLUMN_STANDARD
}

export function generate(data, ctx) {
  const { seed, cx, cz, zone, config, borders, borderZones } = ctx
  const forcedProfile = config.zoneBands?.length === 1
  const candidate = forcedProfile ? null : regionLandmarkAt(cx, cz, seed, config)
  const landmark = regionLandmarkContains(candidate, cx, cz) ? candidate : null
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const gx = cx * CHUNK + x
      const gz = cz * CHUNK + z
      data.setCol(x, z, pillarColumnKindAt(seed, gx, gz, landmark, config))
    }
  }
  clearTransitionColumns(data, borders, borderZones, zone, config)
}
