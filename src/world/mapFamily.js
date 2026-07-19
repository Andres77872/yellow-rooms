import { DEFAULT_WORLD_CONFIG } from './config.js'
import {
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
} from './mapTypes.js'

// Keep one canonical family order. Codes, audit rows, and deterministic family
// projections derive from this order instead of maintaining parallel lists.
export const MAP_FAMILY_ORDER = Object.freeze([
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  MAP_FAMILY_LATTICE,
])

export const MAP_FAMILY_CODES = Object.freeze(Object.fromEntries(
  MAP_FAMILY_ORDER.map((family, code) => [family, code])
))

const VOID_SAFETY_FAMILIES = Object.freeze([
  MAP_FAMILY_TOWER,
  MAP_FAMILY_LATTICE,
])

// Void safety is a release prerequisite only for families that expose authored
// lethal planes. Keeping this policy here prevents audit/report callers from
// accidentally extending the gate to Office or Sewer.
export function requiresVoidSafety(family) {
  return VOID_SAFETY_FAMILIES.includes(family)
}

export class MapFamilyConfigError extends Error {
  constructor(reason) {
    super(`Invalid map family configuration: ${reason}`)
    this.name = 'MapFamilyConfigError'
    this.reason = reason
  }
}

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

function failIncomplete() {
  throw new MapFamilyConfigError('incomplete')
}

function requireConstraint(condition) {
  if (!condition) failIncomplete()
}

// Profiles and canonical descriptors share this immutability boundary. The
// helper freezes in place so it never creates a competing identity/DTO.
export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function normalizeZoneBands(zoneBands) {
  requireConstraint(Array.isArray(zoneBands) && zoneBands.length > 0)

  const ids = new Set()
  let previousMax = -Infinity
  const normalized = zoneBands.map((band) => {
    requireConstraint(
      isRecord(band) &&
      Number.isInteger(band.id) &&
      band.id >= 0 &&
      Number.isFinite(band.max) &&
      band.max > previousMax &&
      !ids.has(band.id)
    )
    ids.add(band.id)
    previousMax = band.max
    return { id: band.id, max: band.max }
  })

  requireConstraint(previousMax >= 1)
  return normalized
}

function normalizeProfile(family, profile, requireEnabled) {
  requireConstraint(isRecord(profile) && typeof profile.enabled === 'boolean')
  if (requireEnabled && !profile.enabled) {
    throw new MapFamilyConfigError('disabled')
  }

  let normalized
  if (family === MAP_FAMILY_OFFICE) {
    normalized = { family, enabled: profile.enabled }
  } else if (family === MAP_FAMILY_SEWER) {
    requireConstraint(
      Number.isInteger(profile.maxLoops) &&
      profile.maxLoops >= 0 &&
      profile.rightTurnChance === 0.65 &&
      Number.isInteger(profile.lampPhase) &&
      Number.isFinite(profile.lampChance) &&
      profile.lampChance > 0 &&
      profile.lampChance < 1
    )
    normalized = {
      family,
      enabled: profile.enabled,
      zoneBands: normalizeZoneBands(profile.zoneBands),
      maxLoops: profile.maxLoops,
      rightTurnChance: profile.rightTurnChance,
      lampPhase: profile.lampPhase,
      lampChance: profile.lampChance,
    }
  } else if (family === MAP_FAMILY_TOWER) {
    requireConstraint(
      profile.levels === 3 &&
      profile.participants === 2 &&
      profile.skybridgeLevelOffset === 1
    )
    normalized = {
      family,
      enabled: profile.enabled,
      levels: profile.levels,
      participants: profile.participants,
      skybridgeLevelOffset: profile.skybridgeLevelOffset,
    }
  } else if (family === MAP_FAMILY_LATTICE) {
    requireConstraint(
      profile.districtChunks === 3 &&
      profile.levels === 3 &&
      profile.anchorsPerAxis === 5 &&
      Array.isArray(profile.cycleRate) &&
      profile.cycleRate.length === 2 &&
      Number.isFinite(profile.cycleRate[0]) &&
      Number.isFinite(profile.cycleRate[1]) &&
      profile.cycleRate[0] >= 0.08 &&
      profile.cycleRate[1] <= 0.15 &&
      profile.cycleRate[0] <= profile.cycleRate[1] &&
      profile.defaultExposureM === 5 &&
      profile.maxExposureM === 20 &&
      Number.isInteger(profile.minimumCueCells) &&
      profile.minimumCueCells >= 8
    )
    normalized = {
      family,
      enabled: profile.enabled,
      districtChunks: profile.districtChunks,
      levels: profile.levels,
      anchorsPerAxis: profile.anchorsPerAxis,
      cycleRate: [...profile.cycleRate],
      defaultExposureM: profile.defaultExposureM,
      maxExposureM: profile.maxExposureM,
      minimumCueCells: profile.minimumCueCells,
    }
  } else {
    throw new MapFamilyConfigError('unknown')
  }

  return deepFreeze(normalized)
}

function selectedProfile(config) {
  const familyConfig = isRecord(config?.mapFamily) ? config.mapFamily : null
  const explicitSelection = familyConfig !== null &&
    hasOwn(familyConfig, 'selected') &&
    familyConfig.selected !== undefined
  const family = explicitSelection
    ? familyConfig.selected
    : MAP_FAMILY_OFFICE

  if (!hasOwn(MAP_FAMILY_CODES, family)) {
    throw new MapFamilyConfigError('unknown')
  }

  const profiles = isRecord(familyConfig?.profiles)
    ? familyConfig.profiles
    : null
  const profile = profiles?.[family]

  if (profile === undefined && !explicitSelection && family === MAP_FAMILY_OFFICE) {
    return {
      family,
      profile: DEFAULT_WORLD_CONFIG.mapFamily.profiles[MAP_FAMILY_OFFICE],
    }
  }

  return { family, profile }
}

// Resolve exactly one selected family. Invalid explicit selections fail before
// generation can construct or partially stamp ChunkData.
export function resolveMapFamily(config = DEFAULT_WORLD_CONFIG) {
  const { family, profile } = selectedProfile(config)
  return normalizeProfile(family, profile, true)
}

function applySewerSettings(config, profile) {
  config.zoneBands = structuredClone(profile.zoneBands)

  if (!isRecord(config.lamps)) {
    config.lamps = structuredClone(DEFAULT_WORLD_CONFIG.lamps)
  }
  if (!isRecord(config.lamps.phase)) config.lamps.phase = {}
  if (!isRecord(config.lamps.chance)) config.lamps.chance = {}

  for (const { id } of profile.zoneBands) {
    config.lamps.phase[id] = profile.lampPhase
    config.lamps.chance[id] = profile.lampChance
  }
}

function isRollbackFamily(kind) {
  return kind === MAP_FAMILY_SEWER ||
    kind === MAP_FAMILY_TOWER ||
    kind === MAP_FAMILY_LATTICE
}

function restoreOfficeSettingsAfterSewerRollback(config, profile) {
  // Sewer is the only family whose selection projects settings onto the shared
  // zone surface. Falling back to Office must remove that projection even when
  // the failed Sewer profile itself is no longer valid enough to normalize.
  config.zoneBands = structuredClone(DEFAULT_WORLD_CONFIG.zoneBands)

  const zoneBands = Array.isArray(profile?.zoneBands) ? profile.zoneBands : []
  for (const band of zoneBands) {
    if (!isRecord(band) || !Number.isInteger(band.id)) continue
    const { id } = band
    for (const key of ['phase', 'chance']) {
      const values = config.lamps?.[key]
      if (!isRecord(values)) continue
      const defaults = DEFAULT_WORLD_CONFIG.lamps?.[key]
      if (isRecord(defaults) && hasOwn(defaults, id)) {
        values[id] = defaults[id]
      } else {
        delete values[id]
      }
    }
  }
}

// Build a mutable family-specific config without changing activation flags.
// resolveMapFamily remains the fail-closed eligibility boundary.
export function worldConfigForFamily(kind, base = DEFAULT_WORLD_CONFIG) {
  if (!hasOwn(MAP_FAMILY_CODES, kind)) {
    throw new MapFamilyConfigError('unknown')
  }
  if (!isRecord(base)) failIncomplete()

  const config = structuredClone(base)
  if (!isRecord(config.mapFamily)) {
    config.mapFamily = structuredClone(DEFAULT_WORLD_CONFIG.mapFamily)
  }
  if (!isRecord(config.mapFamily.profiles)) {
    config.mapFamily.profiles = structuredClone(DEFAULT_WORLD_CONFIG.mapFamily.profiles)
  }

  const profile = normalizeProfile(
    kind,
    config.mapFamily.profiles[kind],
    false
  )
  config.mapFamily.selected = kind

  if (kind === MAP_FAMILY_SEWER) applySewerSettings(config, profile)

  return config
}

// Untrusted family selection (URL param, title UI, debug tools) -> runnable
// world config. Falls back to Office instead of throwing; release gating stays
// in worldConfigForFamily/resolveMapFamily. The extra resolveMapFamily call
// matters: worldConfigForFamily normalizes without requiring `enabled`, and a
// disabled family must fall back here rather than explode inside buildChunk.
export function worldConfigForFamilyOrOffice(kind, base = DEFAULT_WORLD_CONFIG) {
  try {
    const config = worldConfigForFamily(kind, base)
    resolveMapFamily(config)
    return { family: config.mapFamily.selected, config, fellBack: false }
  } catch (err) {
    if (!(err instanceof MapFamilyConfigError)) throw err
    return {
      family: MAP_FAMILY_OFFICE,
      config: worldConfigForFamily(MAP_FAMILY_OFFICE, base),
      fellBack: true,
    }
  }
}

// Rollback is a configuration action, not a dependency cascade. Disable only
// the named non-office emitter, preserve every unrelated activation flag, and
// return to the established Office path only when that emitter was selected.
export function rollbackMapFamily(kind, base = DEFAULT_WORLD_CONFIG) {
  if (!isRollbackFamily(kind)) {
    throw new MapFamilyConfigError('unknown')
  }
  if (
    !isRecord(base) ||
    !isRecord(base.mapFamily) ||
    !isRecord(base.mapFamily.profiles) ||
    !isRecord(base.mapFamily.profiles[kind])
  ) {
    failIncomplete()
  }

  const office = normalizeProfile(
    MAP_FAMILY_OFFICE,
    base.mapFamily.profiles[MAP_FAMILY_OFFICE],
    true
  )
  const { family: selected } = selectedProfile(base)
  if (selected !== kind) resolveMapFamily(base)

  const config = structuredClone(base)
  config.mapFamily.profiles[kind].enabled = false
  if (selected === kind) {
    config.mapFamily.selected = office.family
    if (kind === MAP_FAMILY_SEWER) {
      restoreOfficeSettingsAfterSewerRollback(
        config,
        base.mapFamily.profiles[kind]
      )
    }
  }

  // The returned selection must itself be release-eligible; malformed rollback
  // input never produces a partially usable configuration.
  resolveMapFamily(config)
  return config
}
