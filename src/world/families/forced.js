import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { deepFreeze, worldConfigForFamily } from '../mapFamily.js'

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// A deep-frozen world config that selects family `id` with its profile forced
// on, whatever its activation flag says. For tests, audits and the DEV
// `?family=<id>&forceFamily=1` path (spec §8.4) while the liminal families are
// still disabled; the shipped config is never touched. `base` is cloned, never
// mutated. Unknown ids throw MapFamilyConfigError('unknown') exactly like
// worldConfigForFamily, and an invalid profile still fails normalisation.
export function forcedFamilyConfig(id, base = DEFAULT_WORLD_CONFIG) {
  const clone = structuredClone(base)
  if (isRecord(clone)) {
    if (!isRecord(clone.mapFamily)) clone.mapFamily = structuredClone(DEFAULT_WORLD_CONFIG.mapFamily)
    if (!isRecord(clone.mapFamily.profiles)) {
      clone.mapFamily.profiles = structuredClone(DEFAULT_WORLD_CONFIG.mapFamily.profiles)
    }
    const profiles = clone.mapFamily.profiles
    if (isRecord(profiles[id])) profiles[id].enabled = true
    else if (profiles[id] === undefined) profiles[id] = { enabled: true }
  }
  return deepFreeze(worldConfigForFamily(id, clone))
}
