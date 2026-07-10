import { ZONE_OFFICE } from '../constants.js'
import { PASSAGE_WIDE } from '../mapTypes.js'
import { carveBorderThresholds } from './ZoneGenerator.js'
import { applyOfficeDistrictPlan } from './officePlan.js'

export const id = ZONE_OFFICE

// Compile a slice of a multi-chunk office district. The plan reserves a sparse
// corridor hierarchy first, partitions the remaining bays into rooms, and then
// realizes explicit doors from a connected space graph. Border contracts are
// already installed by the orchestrator.
export function generate(data, ctx) {
  const { config, borders, borderZones } = ctx
  applyOfficeDistrictPlan(data, ctx)
  const needsThreshold = (side) => !borderZones || borderZones[side] !== ZONE_OFFICE
  carveBorderThresholds(data, borders, config, needsThreshold, PASSAGE_WIDE, true)
}
