import { CHUNK } from '../constants.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import {
  LATTICE_STRUCTURE_KIND,
  hasCanonicalLatticeOwnershipShape,
  latticeStructureAt,
} from './lattice.js'
import { deepFreeze, resolveMapFamily } from '../mapFamily.js'
import {
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_TOWER,
} from '../mapTypes.js'
import { multilevelStructureAt } from './multilevel.js'
import { TOWER_STRUCTURE_KIND, towerStructureAt } from './tower.js'

export const STRUCTURE_KIND_OFFICE = 'officeMultilevel'
export const STRUCTURE_KIND_TOWER = TOWER_STRUCTURE_KIND
export const STRUCTURE_KIND_LATTICE = LATTICE_STRUCTURE_KIND

const LEGACY_OFFICE_STRUCTURE_KINDS = Object.freeze([
  'bridged',
  'openVoid',
  STRUCTURE_KIND_OFFICE,
])

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const hasOwn = (value, key) =>
  value !== null &&
  typeof value === 'object' &&
  Object.prototype.hasOwnProperty.call(value, key)

export function structureFamily(structure) {
  return hasOwn(structure, 'family') && structure.family !== undefined
    ? structure.family
    : MAP_FAMILY_OFFICE
}

export function structureKind(structure) {
  const family = structureFamily(structure)
  const kind = structure?.kind ?? null
  if (
    family === MAP_FAMILY_OFFICE &&
    LEGACY_OFFICE_STRUCTURE_KINDS.includes(kind)
  ) {
    return STRUCTURE_KIND_OFFICE
  }
  return kind
}

// Canonical participant arrays sort by (cz, cx). Consumers import this one
// comparator rather than silently choosing a different coordinate priority.
export function compareStructureParticipants(a, b) {
  return a.cz - b.cz || a.cx - b.cx
}

function noStructure(family, levelCy) {
  return deepFreeze({ family, levelCy, hasRoom: false })
}

// Resolve the selected family's canonical descriptor without consulting
// generated ChunkData. Tower planning is still release-inert: only a valid,
// explicitly enabled forced profile can reach it until the activation gate.
export function structureAt(
  seed,
  cx,
  cz,
  cy,
  config = DEFAULT_WORLD_CONFIG
) {
  const profile = resolveMapFamily(config)
  const { family } = profile
  // Hotel is an office-fabric family: it plans and stamps the same canonical
  // multilevel descriptors (atria read as hotel light wells), which carry no
  // family field and therefore validate through the office adapter.
  const structure = family === MAP_FAMILY_OFFICE || family === MAP_FAMILY_HOTEL
    ? multilevelStructureAt(seed, cx, cz, cy, config)
    : family === MAP_FAMILY_TOWER
      ? towerStructureAt(seed, cx, cz, cy, profile) ?? noStructure(family, cy)
      : family === MAP_FAMILY_LATTICE
        ? latticeStructureAt(seed, cx, cz, cy, profile) ?? noStructure(family, cy)
    : noStructure(family, cy)
  return deepFreeze(structure)
}

// Canonical ownership is evidence from a family lookup, not an inference from
// a descriptor's non-empty participant list. The identity field is always
// `id`; legacy `canonicalId` aliases are deliberately not projected here.
export function structureOwnershipAt(
  seed,
  cx,
  cz,
  cy,
  config = DEFAULT_WORLD_CONFIG
) {
  const structure = structureAt(seed, cx, cz, cy, config)
  const ownsChunk = structure?.hasRoom === true &&
    Array.isArray(structure.participants) &&
    structure.participants.some(
      (participant) => participant?.cx === cx && participant?.cz === cz
    )
  if (!ownsChunk) return null

  return deepFreeze({
    cx,
    cz,
    id: structure.id,
    family: structureFamily(structure),
    baseCy: structure.baseCy,
    topCy: structure.topCy,
  })
}

const EMPTY_PARTICIPANTS = Object.freeze([])
const EMPTY_REGIONS = Object.freeze([])
const UINT32_MAX = 0xffffffff
export const LETHAL_VOID_REASON_ORDER = Object.freeze([
  'canonical-id-mismatch',
  'family-mismatch',
  'lower-floor-mismatch',
  'cell-mismatch',
  'death-plane-mismatch',
  'void-ownership-mismatch',
])
const REASON_ORDER = Object.freeze([
  'participant-cardinality',
  'duplicate-participant',
  'missing-participant',
  'participant-alias-mismatch',
  'canonical-id-mismatch',
  'participant-shape',
  'vertical-band',
  'family-mismatch',
])

const participantKey = (participant) => `${participant.cx},${participant.cz}`

const validParticipant = (participant) =>
  isRecord(participant) &&
  Number.isInteger(participant.cx) &&
  Number.isInteger(participant.cz)

const sameParticipantCoordinates = (a, b) =>
  validParticipant(a) &&
  validParticipant(b) &&
  a.cx === b.cx &&
  a.cz === b.cz

function sameParticipantValue(a, b) {
  if (!isRecord(a) || !isRecord(b)) return false
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()
  return aKeys.length === bKeys.length &&
    aKeys.every((key, index) => key === bKeys[index] && Object.is(a[key], b[key]))
}

function sameParticipantList(a, b) {
  return Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((participant, index) => sameParticipantValue(participant, b[index]))
}

function validCanonicalId(id) {
  return Number.isInteger(id) && id >= 0 && id <= UINT32_MAX
}

function validBand(baseCy, topCy) {
  return Number.isInteger(baseCy) &&
    Number.isInteger(topCy) &&
    topCy >= baseCy
}

function canonicalParticipantOrder(participants) {
  return participants.every(
    (participant, index) =>
      index === 0 ||
        compareStructureParticipants(participants[index - 1], participant) < 0
  )
}

function exactAdjacentPair(_structure, participants) {
  if (participants.length !== 2 || !canonicalParticipantOrder(participants)) {
    return false
  }
  const [a, b] = participants
  return Math.abs(a.cx - b.cx) + Math.abs(a.cz - b.cz) === 1
}

function addReason(reasons, reason) {
  reasons.add(reason)
}

function orderedReasons(family, reasons) {
  return REASON_ORDER
    .filter((reason) => reasons.has(reason))
    .map((reason) => `${family}:${reason}`)
}

function validationResult(policy, structure, reasons) {
  const participants = Array.isArray(structure?.participants)
    ? structure.participants
    : EMPTY_PARTICIPANTS
  const ordered = orderedReasons(policy.family, reasons)
  return {
    ok: ordered.length === 0,
    family: policy.family,
    kind: policy.kind,
    participants,
    reasons: ordered,
  }
}

function validateOwnership(structure, participants, ownership, policy, reasons) {
  if (!Array.isArray(ownership)) {
    addReason(reasons, 'missing-participant')
    return
  }

  const declaredKeys = new Set(participants.map(participantKey))
  const claims = new Map()
  let invalidClaimShape = false
  let undeclaredClaim = false
  for (const claim of ownership) {
    if (!validParticipant(claim)) {
      invalidClaimShape = true
      continue
    }
    const key = participantKey(claim)
    if (!declaredKeys.has(key)) undeclaredClaim = true
    const existing = claims.get(key)
    if (existing) {
      addReason(reasons, 'duplicate-participant')
    } else {
      claims.set(key, claim)
    }
  }

  if (invalidClaimShape) addReason(reasons, 'participant-shape')
  if (
    undeclaredClaim ||
    claims.size !== participants.length ||
    participants.some((participant) => !claims.has(participantKey(participant)))
  ) {
    addReason(reasons, 'missing-participant')
  }

  for (const participant of participants) {
    const claim = claims.get(participantKey(participant))
    if (!claim) continue
    if (claim.family !== policy.family) addReason(reasons, 'family-mismatch')
    if (!hasOwn(claim, 'id') || claim.id !== structure.id) {
      addReason(reasons, 'canonical-id-mismatch')
    }
    if (
      claim.baseCy !== structure.baseCy ||
      claim.topCy !== structure.topCy
    ) {
      addReason(reasons, 'vertical-band')
    }
  }
}

function validateStructureWithPolicy(structure, { ownership } = {}, policy) {
  const reasons = new Set()
  const participants = Array.isArray(structure?.participants)
    ? structure.participants
    : EMPTY_PARTICIPANTS

  if (
    structureFamily(structure) !== policy.family ||
    structureKind(structure) !== policy.kind
  ) {
    addReason(reasons, 'family-mismatch')
  }

  if (!policy.cardinality(participants.length)) {
    addReason(reasons, 'participant-cardinality')
  }

  const coordinatesValid = participants.every(validParticipant)
  if (!coordinatesValid) addReason(reasons, 'participant-shape')

  let hasDuplicates = false
  if (coordinatesValid) {
    const keys = new Set()
    for (const participant of participants) {
      const key = participantKey(participant)
      if (keys.has(key)) hasDuplicates = true
      keys.add(key)
    }
    if (hasDuplicates) addReason(reasons, 'duplicate-participant')
  }

  if (
    hasOwn(structure, 'participantChunks') &&
    !sameParticipantList(participants, structure.participantChunks)
  ) {
    addReason(reasons, 'participant-alias-mismatch')
  }

  const cardinalityValid = policy.cardinality(participants.length)
  if (
    coordinatesValid &&
    cardinalityValid &&
    !hasDuplicates &&
    !policy.shape(structure, participants)
  ) {
    addReason(reasons, 'participant-shape')
  }

  if (
    coordinatesValid &&
    cardinalityValid &&
    !hasDuplicates &&
    !sameParticipantCoordinates(structure?.anchor, participants[0])
  ) {
    addReason(reasons, 'participant-shape')
  }

  if (!validCanonicalId(structure?.id)) {
    addReason(reasons, 'canonical-id-mismatch')
  }
  if (
    !validBand(structure?.baseCy, structure?.topCy) ||
    (policy.band && !policy.band(structure))
  ) {
    addReason(reasons, 'vertical-band')
  }

  // Ownership evidence is meaningful only after the descriptor declares one
  // valid canonical participant set. Otherwise the descriptor defect is the
  // sole failure; do not cascade a duplicate/cardinality error into a spurious
  // missing-ownership reason.
  if (coordinatesValid && cardinalityValid && !hasDuplicates) {
    validateOwnership(structure, participants, ownership, policy, reasons)
  }
  return validationResult(policy, structure, reasons)
}

function validateSliceWithPolicy(slice, structure, context, policy) {
  const result = validateStructureWithPolicy(structure, context, policy)
  const reasons = new Set(result.reasons.map((reason) => reason.slice(policy.family.length + 1)))

  if (!isRecord(slice) || slice.hasRoom !== true) {
    addReason(reasons, 'participant-shape')
  } else {
    if (slice.id !== structure?.id) addReason(reasons, 'canonical-id-mismatch')
    if (
      slice.baseCy !== structure?.baseCy ||
      slice.topCy !== structure?.topCy ||
      !Number.isInteger(slice.lowerCy) ||
      slice.lowerCy < structure?.baseCy ||
      slice.lowerCy >= structure?.topCy
    ) {
      addReason(reasons, 'vertical-band')
    }
  }

  return validationResult(policy, structure, reasons)
}

function expectedParticipants(structure) {
  if (!Array.isArray(structure?.participants)) return EMPTY_PARTICIPANTS
  return Object.freeze(structure.participants
    .map(({ cx, cz }) => Object.freeze({ cx, cz }))
    .sort(compareStructureParticipants))
}

function rectilinearApertureRegions(slice) {
  const bounds = slice?.bounds
  if (
    slice?.hasRoom !== true ||
    !isRecord(bounds) ||
    !Number.isInteger(bounds.x0) ||
    !Number.isInteger(bounds.z0) ||
    !Number.isInteger(bounds.x1) ||
    !Number.isInteger(bounds.z1) ||
    bounds.x1 < bounds.x0 ||
    bounds.z1 < bounds.z0
  ) return EMPTY_REGIONS

  const full = {
    x0: bounds.x0,
    z0: bounds.z0,
    x1: bounds.x1 + 1,
    z1: bounds.z1 + 1,
  }
  if (slice.globalBridgeLine === null) return [full]

  if (slice.bridgeAxis === 'x' && Number.isInteger(slice.bridgeLine)) {
    return [
      { ...full, z1: slice.bridgeLine },
      { ...full, z0: slice.bridgeLine + 1 },
    ].filter((region) => region.z0 < region.z1)
  }
  if (slice.bridgeAxis === 'z' && Number.isInteger(slice.bridgeLine)) {
    return [
      { ...full, x1: slice.bridgeLine },
      { ...full, x0: slice.bridgeLine + 1 },
    ].filter((region) => region.x0 < region.x1)
  }
  return EMPTY_REGIONS
}

function noHardVoid() {
  return null
}

function lethalVoidFamily(family) {
  return family === MAP_FAMILY_TOWER || family === MAP_FAMILY_LATTICE
}

function orderedLethalVoidReasons(reasons) {
  return LETHAL_VOID_REASON_ORDER.filter((reason) => reasons.has(reason))
}

function validateLethalVoidCells(cells, reasons) {
  if (!Array.isArray(cells) || cells.length === 0) {
    addReason(reasons, 'cell-mismatch')
    return
  }

  let previous = null
  for (const cell of cells) {
    const coordinatesValid = isRecord(cell) &&
      Number.isInteger(cell.lx) &&
      Number.isInteger(cell.lz) &&
      cell.lx >= 0 &&
      cell.lx < CHUNK &&
      cell.lz >= 0 &&
      cell.lz < CHUNK
    if (!coordinatesValid) {
      addReason(reasons, 'cell-mismatch')
    } else if (
      previous &&
      (previous.lz > cell.lz ||
        (previous.lz === cell.lz && previous.lx >= cell.lx))
    ) {
      addReason(reasons, 'cell-mismatch')
    }
    if (!Number.isInteger(cell?.deathYmm)) {
      addReason(reasons, 'death-plane-mismatch')
    }
    if (coordinatesValid) previous = cell
  }
}

function descriptorOwnershipClaims(structure, family) {
  if (!Array.isArray(structure?.participants)) return EMPTY_PARTICIPANTS
  return structure.participants.map((participant) => ({
    cx: participant?.cx,
    cz: participant?.cz,
    id: structure.id,
    family,
    baseCy: structure.baseCy,
    topCy: structure.topCy,
  }))
}

function addStructureValidationReasons(result, reasons) {
  for (const qualified of result?.reasons ?? []) {
    const reason = qualified.slice(qualified.indexOf(':') + 1)
    if (reason === 'canonical-id-mismatch') {
      addReason(reasons, 'canonical-id-mismatch')
    } else if (reason === 'family-mismatch') {
      addReason(reasons, 'family-mismatch')
    } else {
      addReason(reasons, 'void-ownership-mismatch')
    }
  }
}

// Local lethal-half validation is intentionally descriptor-scoped. Runtime
// callers still have to prove canonical lookup ownership before dispatching to
// an adapter; this local layer prevents malformed or unowned ChunkData from
// widening a slab mask or authorizing a death plane on its own.
export function validateLethalVoidHalf(data, half, direction) {
  const reasons = new Set()
  if (!isRecord(half)) {
    addReason(reasons, 'cell-mismatch')
    return { ok: false, reasons: orderedLethalVoidReasons(reasons) }
  }

  if (!validCanonicalId(half.id)) addReason(reasons, 'canonical-id-mismatch')
  if (!lethalVoidFamily(half.family) || data?.mapFamily !== half.family) {
    addReason(reasons, 'family-mismatch')
  }
  if (
    !Number.isInteger(half.lowerCy) ||
    (direction === 'up' && data?.cy !== half.lowerCy) ||
    (direction === 'down' && data?.cy !== half.lowerCy + 1) ||
    (direction !== 'up' && direction !== 'down')
  ) {
    addReason(reasons, 'lower-floor-mismatch')
  }
  validateLethalVoidCells(half.cells, reasons)

  const structure = data?.structure
  const adapter = structureAdapterFor(structure)
  if (isRecord(structure)) {
    if (structure.id !== half.id) addReason(reasons, 'canonical-id-mismatch')
    if (structureFamily(structure) !== half.family) {
      addReason(reasons, 'family-mismatch')
    }
  }
  if (!isRecord(structure) || !adapter || !lethalVoidFamily(adapter.family)) {
    addReason(reasons, 'void-ownership-mismatch')
  } else {
    if (adapter.family !== half.family) {
      addReason(reasons, 'family-mismatch')
    }
    if (
      !validBand(structure.baseCy, structure.topCy) ||
      !Number.isInteger(half.lowerCy) ||
      half.lowerCy < structure.baseCy ||
      half.lowerCy >= structure.topCy ||
      !Number.isInteger(data?.cy) ||
      data.cy < structure.baseCy ||
      data.cy > structure.topCy
    ) {
      addReason(reasons, 'void-ownership-mismatch')
    }

    const participants = Array.isArray(structure.participants)
      ? structure.participants
      : EMPTY_PARTICIPANTS
    if (!participants.some(
      (participant) => participant?.cx === data?.cx && participant?.cz === data?.cz
    )) {
      addReason(reasons, 'void-ownership-mismatch')
    }
    addStructureValidationReasons(
      adapter.validateStructure(structure, {
        ownership: descriptorOwnershipClaims(structure, adapter.family),
      }),
      reasons
    )
  }

  const ordered = orderedLethalVoidReasons(reasons)
  return { ok: ordered.length === 0, reasons: ordered }
}

export function lethalVoidCellAt(data, direction, lx, lz) {
  if (
    !Number.isInteger(lx) ||
    !Number.isInteger(lz) ||
    lx < 0 ||
    lx >= CHUNK ||
    lz < 0 ||
    lz >= CHUNK
  ) return null

  const half = direction === 'up'
    ? data?.lethalVoidUp
    : direction === 'down'
      ? data?.lethalVoidDown
      : null
  if (half == null) return null
  if (!validateLethalVoidHalf(data, half, direction).ok) return null
  return half.cells.find((cell) => cell.lx === lx && cell.lz === lz) ?? null
}

function hardVoidAt(policy, data, lx, lz) {
  const cell = lethalVoidCellAt(data, 'down', lx, lz)
  const half = data?.lethalVoidDown
  if (!cell || half?.family !== policy.family) return null
  return {
    id: half.id,
    family: half.family,
    deathYmm: cell.deathYmm,
  }
}

function makeAdapter(policy, apertureRegions, exposesHardVoid = false) {
  return Object.freeze({
    family: policy.family,
    kind: policy.kind,
    validateStructure(structure, context = {}) {
      return validateStructureWithPolicy(structure, context, policy)
    },
    validateSlice(slice, structure, context = {}) {
      return validateSliceWithPolicy(slice, structure, context, policy)
    },
    apertureRegions,
    expectedParticipants,
    hardVoidAt: exposesHardVoid
      ? (data, lx, lz) => hardVoidAt(policy, data, lx, lz)
      : noHardVoid,
  })
}

const OFFICE_POLICY = Object.freeze({
  family: MAP_FAMILY_OFFICE,
  kind: STRUCTURE_KIND_OFFICE,
  cardinality: (count) => count === 2,
  shape: exactAdjacentPair,
})

const TOWER_POLICY = Object.freeze({
  family: MAP_FAMILY_TOWER,
  kind: STRUCTURE_KIND_TOWER,
  cardinality: (count) => count === 2,
  shape: exactAdjacentPair,
})

const LATTICE_POLICY = Object.freeze({
  family: MAP_FAMILY_LATTICE,
  kind: STRUCTURE_KIND_LATTICE,
  cardinality: (count) => count === 16,
  shape: hasCanonicalLatticeOwnershipShape,
  band: (structure) =>
    structure?.levelCount === 5 && structure?.topCy === structure?.baseCy + 4,
})

export const OFFICE_STRUCTURE_ADAPTER = makeAdapter(
  OFFICE_POLICY,
  rectilinearApertureRegions
)
export const TOWER_STRUCTURE_ADAPTER = makeAdapter(
  TOWER_POLICY,
  rectilinearApertureRegions,
  true
)
export const LATTICE_STRUCTURE_ADAPTER = makeAdapter(
  LATTICE_POLICY,
  () => EMPTY_REGIONS,
  true
)

export const STRUCTURE_ADAPTERS = Object.freeze({
  [STRUCTURE_KIND_OFFICE]: OFFICE_STRUCTURE_ADAPTER,
  [STRUCTURE_KIND_TOWER]: TOWER_STRUCTURE_ADAPTER,
  [STRUCTURE_KIND_LATTICE]: LATTICE_STRUCTURE_ADAPTER,
})

export function structureAdapterFor(structure) {
  const family = structureFamily(structure)
  const kind = structureKind(structure)
  const adapter = STRUCTURE_ADAPTERS[kind]
  return adapter?.family === family ? adapter : null
}

// Streaming re-validates every loaded structure chunk each frame, and chunks
// of one district share the same frozen descriptor. The verdict is pure over
// (seed, config, descriptor, level), so cache it by those identities; frozen
// results keep the shared evidence safe from caller mutation.
const RUNTIME_VALIDATION_CACHE = new WeakMap()

function cachedRuntimeValidation(structure, config) {
  if (!Object.isFrozen(structure)) return null
  let byConfig = RUNTIME_VALIDATION_CACHE.get(structure)
  if (!byConfig) {
    byConfig = new WeakMap()
    RUNTIME_VALIDATION_CACHE.set(structure, byConfig)
  }
  let verdicts = byConfig.get(config)
  if (!verdicts) {
    verdicts = new Map()
    byConfig.set(config, verdicts)
  }
  return verdicts
}

// Runtime ownership must be resolved through the same explicit adapter and
// canonical structure lookup for apertures, residency, visibility, and lethal
// planes. Keep that fail-closed evidence construction in one place so runtime
// callers cannot drift back to family/kind inference or participant-only trust.
export function validatedRuntimeStructure(
  seed,
  config,
  structure,
  levelCy
) {
  if (!Number.isInteger(levelCy)) return null
  const adapter = structureAdapterFor(structure)
  if (!adapter) return null

  const verdicts = config !== null && typeof config === 'object'
    ? cachedRuntimeValidation(structure, config)
    : null
  const verdictKey = `${seed >>> 0}:${levelCy}`
  if (verdicts?.has(verdictKey)) return verdicts.get(verdictKey)
  const verdict = computeRuntimeStructureValidation(
    seed,
    config,
    structure,
    levelCy,
    adapter
  )
  verdicts?.set(verdictKey, verdict)
  return verdict
}

function computeRuntimeStructureValidation(seed, config, structure, levelCy, adapter) {
  try {
    const participants = adapter.expectedParticipants(structure)
    const ownership = participants.flatMap((participant) => {
      if (
        !Number.isInteger(participant?.cx) ||
        !Number.isInteger(participant?.cz)
      ) return []
      const claim = structureOwnershipAt(
        seed,
        participant.cx,
        participant.cz,
        levelCy,
        config
      )
      return claim ? [claim] : []
    })
    if (!adapter.validateStructure(structure, { ownership }).ok) return null
    return Object.freeze({
      adapter,
      ownership: Object.freeze(ownership),
      participants,
    })
  } catch {
    return null
  }
}

// Public module dispatcher. `validateStructure` remains deliberately scoped to
// explicit adapter objects so callers cannot drift between two public names.
export function validateStructureDescriptor(structure, context = {}) {
  const adapter = structureAdapterFor(structure)
  if (adapter) return adapter.validateStructure(structure, context)

  const family = structureFamily(structure)
  const kind = structureKind(structure)
  const participants = Array.isArray(structure?.participants)
    ? structure.participants
    : EMPTY_PARTICIPANTS
  return {
    ok: false,
    family,
    kind,
    participants,
    reasons: [`${family}:family-mismatch`],
  }
}
