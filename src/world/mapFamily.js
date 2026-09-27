import { DEFAULT_WORLD_CONFIG, FAMILY_CATALOG_PROFILES } from './config.js'
import {
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
} from './mapTypes.js'

// Keep one canonical family order. Codes, audit rows, and deterministic family
// projections derive from this order instead of maintaining parallel lists.
// New families append at the end so established codes never re-number.
export const MAP_FAMILY_ORDER = Object.freeze([
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_HOTEL,
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
  } else if (family === MAP_FAMILY_HOTEL) {
    // Hotel supplies its own guest-wing grammar inside the shared district
    // contract (portals, stairs, multilevel atria). The shipped grammar has
    // no profile-specific structural knobs to validate.
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
      profile.districtChunks === 4 &&
      profile.levels === 5 &&
      profile.anchorsPerAxis === 8 &&
      Array.isArray(profile.cycleRate) &&
      profile.cycleRate.length === 2 &&
      Number.isFinite(profile.cycleRate[0]) &&
      Number.isFinite(profile.cycleRate[1]) &&
      profile.cycleRate[0] >= 0.12 &&
      profile.cycleRate[1] <= 0.25 &&
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

// Chunk builds and per-frame structure validation resolve the same profile
// thousands of times. Raw profiles are static once a config is built, so cache
// the frozen normalized profile by raw-profile identity; a stable identity
// also lets downstream planner caches key on the resolved profile object.
const RESOLVED_PROFILE_CACHE = new WeakMap()

// Cheap content check for the resolve cache (profiles are flat records of
// primitives plus small arrays of primitives or flat records).
const snapshotValue = (v) => Array.isArray(v)
  ? v.map((e) => (isRecord(e) ? { ...e } : e))
  : v
function profileSnapshot(profile) {
  return Object.keys(profile).map((k) => [k, snapshotValue(profile[k])])
}
function sameValue(a, b) {
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      const x = a[i]
      const y = b[i]
      if (isRecord(x)) {
        if (!isRecord(y)) return false
        const keys = Object.keys(x)
        if (keys.length !== Object.keys(y).length || keys.some((k) => !Object.is(x[k], y[k]))) return false
      } else if (!Object.is(x, y)) return false
    }
    return true
  }
  return Object.is(a, b)
}
function sameProfileSnapshot(snapshot, profile) {
  let n = 0
  for (const k in profile) {
    if (Object.prototype.hasOwnProperty.call(profile, k)) n++
  }
  if (n !== snapshot.length) return false
  for (const [k, v] of snapshot) {
    if (!sameValue(v, profile[k])) return false
  }
  return true
}

// Resolve exactly one selected family. Invalid explicit selections fail before
// generation can construct or partially stamp ChunkData.
export function resolveMapFamily(config = DEFAULT_WORLD_CONFIG) {
  const { family, profile } = selectedProfile(config)
  if (!isRecord(profile)) return normalizeProfile(family, profile, true)

  // The entry keeps a content fingerprint: a profile edited in place (tests,
  // tools) must re-normalize — and fail closed if it became invalid or
  // disabled — rather than return the stale frozen result.
  const cached = RESOLVED_PROFILE_CACHE.get(profile)?.get(family)
  if (cached && sameProfileSnapshot(cached.snapshot, profile)) return cached.value
  const normalized = normalizeProfile(family, profile, true)
  let byFamily = RESOLVED_PROFILE_CACHE.get(profile)
  if (!byFamily) {
    byFamily = new Map()
    RESOLVED_PROFILE_CACHE.set(profile, byFamily)
  }
  byFamily.set(family, { snapshot: profileSnapshot(profile), value: normalized })
  return normalized
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
    kind === MAP_FAMILY_LATTICE ||
    kind === MAP_FAMILY_HOTEL
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
  applyFamilySkeleton(config, kind)

  return config
}

// v26 — every family owns its SKELETON, not just its dressing. Before v26 the
// Office, Hotel, Tower and Lattice worlds of one seed shared the same zone
// map, district edges, door positions, stair shafts and lamp grid (measured
// by scripts/family-distinctness.mjs: 69–79% chance-corrected seam agreement,
// Office~Hotel layouts statistically indistinguishable). The projection below
// gives each family its own random streams (every shared salt is re-keyed)
// and its own proportions: district size, portal rhythm and width, room
// sizes, stair density, lamp module and landmark-hall frequency. Office keeps
// the base config untouched; Sewer already owns its zone and seams.
export const FAMILY_SKELETONS = Object.freeze({
  [MAP_FAMILY_HOTEL]: Object.freeze({
    salt: 0x48074807,
    districtChunks: 4,
    districtOffset: 2,
    portals: { jitter: 1, minSpacing: 7, width: 1 },
    office: {
      roomShapeChance: 0,
      roomMin: 2,
      roomMax: 4,
      braid: 0.05,
      hotel: { wingSpacing: [8, 9], bay: [2, 3], suiteChance: 0.12 },
    },
    stairs: { chance: 0.24 },
    lamps: { step: 3, corridorStep: 3, deadChance: 0.1 },
    dominance: { chance: 0.5, heroChance: 0.15 },
    multilevel: { longSpan: 18, shortSpan: 10, minLevels: 5, maxLevels: 13, bridgeChance: 0.35 },
  }),
  [MAP_FAMILY_TOWER]: Object.freeze({
    salt: 0x74077407,
    districtChunks: 4,
    districtOffset: 1,
    portals: { jitter: 4, minSpacing: 4, width: 3 },
    office: { roomMin: 5, roomMax: 12, roomShapeChance: 0.2 },
    stairs: { chance: 0.16 },
    // The tower landmark's fixture socket sits on the corridor lamp module
    // (tower.js TOWER_FIXTURE_LAMP_STEP/SALT), so only the room grid moves.
    lamps: { step: 5, deadChance: 0.3 },
    keepSalts: ['lamps.corridorSalt'],
    dominance: { chance: 0.95, maxSpanChunks: 3, heroChance: 0.5 },
  }),
  [MAP_FAMILY_LATTICE]: Object.freeze({
    salt: 0x1a071a07,
    districtChunks: 4,
    districtOffset: 3,
    portals: { jitter: 5, minSpacing: 4, width: 2 },
    office: { roomMin: 3, roomMax: 6, lattice: { alleyPitch: [5, 7], extraPlazas: 2, openBlockChance: 0.45 } },
    stairs: { chance: 0.16 },
    lamps: { step: 6, corridorStep: 4, deadChance: 0.34 },
    dominance: { chance: 0.9, heroChance: 0.4 },
  }),
  [MAP_FAMILY_SEWER]: Object.freeze({ salt: 0x5e075e07 }),
})

const SALT_PATHS = Object.freeze([
  ['region', 'salt'],
  ['region', 'roomDominance', 'salt'],
  ['region', 'roomDominance', 'spanSalt'],
  ['region', 'roomDominance', 'heroSalt'],
  ['region', 'roomDominance', 'signatureSalt'],
  ['region', 'roomDominance', 'positionSalt'],
  ['region', 'roomDominance', 'shapeSalt'],
  ['border', 'saltV'],
  ['border', 'saltH'],
  ['border', 'mouthSalt'],
  ['border', 'stubSalt'],
  ['office', 'portals', 'salt'],
  ['stairs', 'salt'],
  ['stairs', 'posSalt'],
  ['stairs', 'layoutSalt'],
  ['stairs', 'fallbackSalt'],
  ['multilevel', 'salt'],
  ['multilevel', 'baseSalt'],
  ['multilevel', 'posSalt'],
  ['multilevel', 'fallbackSalt'],
  ['multilevel', 'heightSalt'],
  ['multilevel', 'kindSalt'],
  ['multilevel', 'deckSalt'],
  ['lamps', 'salt'],
  ['lamps', 'deadSalt'],
  ['lamps', 'corridorSalt'],
  ['pillars', 'monumentalSalt'],
])

function rekeySalts(config, familySalt, keep = []) {
  for (const path of SALT_PATHS) {
    if (keep.includes(path.join('.'))) continue
    let node = config
    for (const key of path.slice(0, -1)) node = isRecord(node) ? node[key] : null
    const leaf = path.at(-1)
    if (isRecord(node) && Number.isFinite(node[leaf])) {
      node[leaf] = (node[leaf] ^ familySalt) | 0
    }
  }
}

const assignRecord = (target, patch) => {
  if (!isRecord(target) || !isRecord(patch)) return
  Object.assign(target, patch)
}

function applyFamilySkeleton(config, kind) {
  if (FAMILY_CATALOG_PROFILES[kind]) {
    config.catalog = structuredClone(FAMILY_CATALOG_PROFILES[kind])
  }
  const skeleton = FAMILY_SKELETONS[kind]
  if (!skeleton) return
  rekeySalts(config, skeleton.salt, skeleton.keepSalts)
  if (skeleton.districtChunks && isRecord(config.office)) config.office.districtChunks = skeleton.districtChunks
  if (skeleton.districtOffset !== undefined && isRecord(config.office)) config.office.districtOffset = skeleton.districtOffset
  if (skeleton.portals && isRecord(config.office)) {
    config.office.portals = { ...(config.office.portals ?? {}), ...skeleton.portals }
  }
  assignRecord(config.office, skeleton.office)
  assignRecord(config.stairs, skeleton.stairs)
  assignRecord(config.lamps, skeleton.lamps)
  assignRecord(config.region?.roomDominance, skeleton.dominance)
  assignRecord(config.multilevel, skeleton.multilevel)
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
