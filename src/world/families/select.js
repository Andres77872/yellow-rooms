import { MAP_FAMILY_ORDER } from '../mapFamily.js'

// Families a player may pick (title MAP list, WorldMapTool): MAP_FAMILY_ORDER
// filtered by "profile enabled" in `config`. Reads the raw profile flag only
// (`profiles[f]?.enabled === true`) and never normalises, so an invalid or
// missing profile simply drops its family instead of throwing. The DEV forced
// family (spec §8.4) is not added here; Engine adds that option itself.
//
// MAP_FAMILY_ORDER is read inside the call, never at module top level, so an
// import cycle through mapFamily.js can never hit its TDZ (spec §4.4).
export function selectableFamilies(config) {
  const profiles = config?.mapFamily?.profiles
  if (!profiles || typeof profiles !== 'object') return []
  return MAP_FAMILY_ORDER.filter((family) =>
    Object.hasOwn(profiles, family) && profiles[family]?.enabled === true)
}
