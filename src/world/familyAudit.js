import {
  CHUNK,
  LAYER_H,
  ZONE_OFFICE,
  ZONE_PILLARS,
  ZONE_SEWER,
  ZONE_WAREHOUSE,
  cIdx,
} from './constants.js'
import { DEFAULT_WORLD_CONFIG } from './config.js'
import {
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_LOBBY,
  CELL_STAIR,
  CELL_VOID,
  PASSAGE_DOOR,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  SEWER_DIRECTIONS,
  SEWER_MODULE_MANHOLE_DOWN,
  SEWER_MODULE_MANHOLE_UP,
  SEWER_MODULE_KINDS,
  WALL_PLAIN,
  WALL_RAIL,
} from './mapTypes.js'
import { MAP_FAMILY_ORDER, requiresVoidSafety } from './mapFamily.js'
import { borderPairMode } from './border.js'
import {
  LETHAL_VOID_REASON_ORDER,
  structureAdapterFor,
  validateLethalVoidHalf,
} from './structures/contract.js'
import {
  STRUCTURE_KIND_LATTICE,
  STRUCTURE_KIND_OFFICE,
  STRUCTURE_KIND_TOWER,
} from './structures/contract.js'
import {
  TOWER_FLOOR_OFFSETS,
  TOWER_LANDMARK_SOCKET_KINDS,
  TOWER_NETWORK_FIELDS,
  hasExactTowerSocketKinds,
  sameTowerCell,
  towerChunkKey,
  towerDeckEndpoints,
  towerParticipantKey,
  towerSliceCoordinates,
} from './structures/tower.js'
import {
  LATTICE_DESCRIPTOR_REASONS,
  LATTICE_FLOOR_OFFSETS,
  LATTICE_ROOM_FIELDS,
  analyzeLatticeDescriptor,
  latticeChunkKey,
  latticeEdgeKey,
  latticeHorizontalCellKey,
  latticeSliceCoordinates,
} from './structures/lattice.js'
import {
  latticeChamberApproaches,
  latticeChamberPerimeter,
  latticeEffectiveExposureM,
  latticeFloorGeometry,
  latticeNearestAnchor,
  latticeProjectedSegments,
} from './structures/latticeStamp.js'
import {
  compareSewerEdges,
  SEWER_DESCRIPTOR_KIND,
  SEWER_RIGHT_TURN_CHANCE,
  sewerCellKey,
  sewerEdgeKey,
} from './zones/sewer.js'

export const FAMILY_AUDIT_ORDER = MAP_FAMILY_ORDER

const SEWER_AUDIT_REASONS = Object.freeze({
  orphanDescriptor: 'sewer:orphan-descriptor',
  familyMismatch: 'sewer:family-mismatch',
  canonicalIdMismatch: 'sewer:canonical-id-mismatch',
  unreachableModule: 'sewer:unreachable-module',
  deferredModule: 'sewer:deferred-module',
  wetOutput: 'sewer:wet-output',
  loopBudget: 'sewer:loop-budget',
  nonSparseLighting: 'sewer:non-sparse-lighting',
  missingSeam: 'sewer:missing-seam',
})

const TOWER_AUDIT_REASONS = Object.freeze({
  orphanDescriptor: 'tower:orphan-descriptor',
  familyMismatch: 'tower:family-mismatch',
  canonicalIdMismatch: 'tower:canonical-id-mismatch',
  participantCardinality: 'tower:participant-cardinality',
  verticalBand: 'tower:vertical-band',
  structureIdentity: 'tower:structure-identity',
  invalidDeck: 'tower:invalid-deck',
  invalidApproach: 'tower:invalid-approach',
  floorConnectivity: 'tower:floor-connectivity',
  invalidGuard: 'tower:invalid-guard',
  missingLandmarkSocket: 'tower:missing-landmark-socket',
  mixedLandmarkKinds: 'tower:mixed-landmark-kinds',
  crossDistrictNetwork: 'tower:cross-district-network',
})

export const LATTICE_AUDIT_DIMENSIONS = Object.freeze([
  'polygon',
  'anchors',
  'backbone',
  'cycles',
  'orientations',
  'allFloors',
  'stamping',
  'exposure',
  'boundaryCues',
  'plainWalls',
  'guards',
  'lethalVoid',
])

const LATTICE_AUDIT_REASONS = Object.freeze({
  orphanDescriptor: 'lattice:orphan-descriptor',
  familyMismatch: 'lattice:family-mismatch',
  canonicalIdMismatch: 'lattice:canonical-id-mismatch',
  participantCardinality: 'lattice:participant-cardinality',
  missingParticipant: 'lattice:missing-participant',
  bounded: 'lattice:bounded-3x3x3',
  anchorShape: 'lattice:anchor-shape',
  edgeShape: 'lattice:edge-shape',
  duplicateEdge: 'lattice:duplicate-edge',
  edgeOrder: 'lattice:edge-order',
  disconnectedBackbone: 'lattice:disconnected-backbone',
  cyclicBackbone: 'lattice:cyclic-backbone',
  backboneNotMinimum: 'lattice:backbone-not-minimum',
  cycleRate: 'lattice:cycle-rate',
  missingHorizontalLink: 'lattice:missing-horizontal-link',
  missingVerticalLink: 'lattice:missing-vertical-link',
  missingSpine: 'lattice:missing-spine',
  verticalLinkDescriptor: 'lattice:vertical-link-descriptor',
  exposureRange: 'lattice:exposure-range',
  cueCoverage: 'lattice:cue-coverage',
  cueSources: 'lattice:cue-sources',
  cueCount: 'lattice:cue-count',
  plainWallSides: 'lattice:plain-wall-sides',
  enclosedRoomIdentity: 'lattice:enclosed-room-identity',
  nonSparseBridgeFabric: 'lattice:non-sparse-bridge-fabric',
  invalidGuard: 'lattice:invalid-guard',
  invalidApproach: 'lattice:invalid-approach',
  missingFloorAudit: 'lattice:missing-floor-audit',
  stampMismatch: 'lattice:stamp-mismatch',
  crossDistrictNetwork: 'lattice:cross-district-network',
})

const AUDIT_REASONS = Object.freeze({
  staleVersion: 'stale-version',
  versionReuse: 'version-reuse',
  missingGlobalPin: 'missing-global-pin',
  staleGlobalPin: 'stale-global-pin',
  missingFamilyPin: 'missing-family-pin',
  staleFamilyPin: 'stale-family-pin',
  missingMaximumHeight: 'missing-maximum-height',
  staleMaximumHeight: 'stale-maximum-height',
  missingCorpusMetadata: 'missing-corpus-metadata',
  staleCorpusMetadata: 'stale-corpus-metadata',
  missingFamilyAdapter: 'missing-family-adapter',
  missingKindAdapter: 'missing-kind-adapter',
  forcedProfileRequired: 'forced-profile-required',
  missingFamilyMetrics: 'missing-family-metrics',
  officeShareBelowFloor: 'office-share-below-floor',
  unknownRollbackRevision: 'unknown-rollback-revision',
  partialFoundationRollback: 'partial-foundation-rollback',
})

const VOID_SAFETY_REASONS = Object.freeze({
  missingHardVoidDeathEvidence: 'missing-hard-void-death-evidence',
  hardVoidDeathFailed: 'hard-void-death-failed',
  voidDeathNotIdempotent: 'void-death-not-idempotent',
  missingVoidPlaneHalf: 'missing-void-plane-half',
  voidPlaneMismatch: 'void-plane-mismatch',
  voidOwnershipMismatch: 'void-ownership-mismatch',
  missingDeterministicResetEvidence: 'missing-deterministic-reset-evidence',
  deterministicResetFailed: 'deterministic-reset-failed',
  resetBaselineMismatch: 'reset-baseline-mismatch',
})

const VOID_SAFETY_REASON_ORDER = Object.freeze([
  VOID_SAFETY_REASONS.missingHardVoidDeathEvidence,
  VOID_SAFETY_REASONS.hardVoidDeathFailed,
  VOID_SAFETY_REASONS.voidDeathNotIdempotent,
  VOID_SAFETY_REASONS.missingVoidPlaneHalf,
  VOID_SAFETY_REASONS.voidPlaneMismatch,
  VOID_SAFETY_REASONS.voidOwnershipMismatch,
  VOID_SAFETY_REASONS.missingDeterministicResetEvidence,
  VOID_SAFETY_REASONS.deterministicResetFailed,
  VOID_SAFETY_REASONS.resetBaselineMismatch,
])

const ACTIVATION_REASON_ORDER = Object.freeze([
  AUDIT_REASONS.staleVersion,
  AUDIT_REASONS.versionReuse,
  AUDIT_REASONS.missingGlobalPin,
  AUDIT_REASONS.staleGlobalPin,
  AUDIT_REASONS.missingFamilyPin,
  AUDIT_REASONS.staleFamilyPin,
  AUDIT_REASONS.missingMaximumHeight,
  AUDIT_REASONS.staleMaximumHeight,
  AUDIT_REASONS.missingCorpusMetadata,
  AUDIT_REASONS.staleCorpusMetadata,
  ...VOID_SAFETY_REASON_ORDER,
])

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const hasText = (value) => typeof value === 'string' && value.length > 0

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

const addReason = (reasons, reason) => reasons.add(reason)
const familyReason = (family, reason) => `${family}:${reason}`
const missingFamilyRowReason = (family) => `missing-family-row:${family}`

const orderedActivationReasons = (reasons) =>
  ACTIVATION_REASON_ORDER.filter((reason) => reasons.has(reason))

const orderedFixtureReasons = (reasons) => [...reasons].sort()

const orderedLethalVoidReasons = (reasons) =>
  LETHAL_VOID_REASON_ORDER.filter((reason) => reasons.has(reason))

function addLethalVoidParityReasons(reasons, up, down) {
  if (up.id !== down.id) addReason(reasons, 'canonical-id-mismatch')
  if (up.family !== down.family) addReason(reasons, 'family-mismatch')
  if (up.lowerCy !== down.lowerCy) addReason(reasons, 'lower-floor-mismatch')

  if (!Array.isArray(up.cells) || !Array.isArray(down.cells) ||
      up.cells.length !== down.cells.length) {
    addReason(reasons, 'cell-mismatch')
    return
  }

  for (let index = 0; index < up.cells.length; index++) {
    const upCell = up.cells[index]
    const downCell = down.cells[index]
    if (upCell?.lx !== downCell?.lx || upCell?.lz !== downCell?.lz) {
      addReason(reasons, 'cell-mismatch')
      continue
    }
    if (upCell?.deathYmm !== downCell?.deathYmm) {
      addReason(reasons, 'death-plane-mismatch')
    }
  }
}

export function auditLethalVoidHalf(data, direction) {
  const half = direction === 'up'
    ? data?.lethalVoidUp
    : direction === 'down'
      ? data?.lethalVoidDown
      : null
  if (half == null) return []
  return validateLethalVoidHalf(data, half, direction).reasons
}

// Pair parity belongs to the family-audit boundary so layered audits and later
// release rows share one deterministic taxonomy. Raster holes remain local;
// this function only compares the two descriptor halves for one internal slab.
export function auditLethalVoidPair(lower, upper) {
  const reasons = new Set([
    ...auditLethalVoidHalf(lower, 'up'),
    ...auditLethalVoidHalf(upper, 'down'),
  ])
  const up = lower?.lethalVoidUp
  const down = upper?.lethalVoidDown
  if (!isRecord(up) || !isRecord(down)) {
    return orderedLethalVoidReasons(reasons)
  }

  addLethalVoidParityReasons(reasons, up, down)

  return orderedLethalVoidReasons(reasons)
}

function auditStructureFixture(fixture, family, kind) {
  const reasons = new Set()
  const descriptors = Array.isArray(fixture?.descriptors)
    ? fixture.descriptors
    : []
  const participants = Array.isArray(fixture?.participantStructures)
    ? fixture.participantStructures
    : []

  for (const descriptor of descriptors) {
    const claims = participants.filter(
      (participant) => participant?.descriptor === descriptor
    )
    if (claims.length === 0) {
      addReason(reasons, familyReason(family, 'orphan-descriptor'))
      continue
    }

    const adapter = structureAdapterFor(descriptor)
    if (
      !adapter ||
      adapter.family !== family ||
      adapter.kind !== kind
    ) {
      addReason(reasons, familyReason(family, 'family-mismatch'))
      continue
    }

    const ownership = claims.map((claim) => ({
      cx: claim.cx,
      cz: claim.cz,
      id: claim.id,
      family: claim.family,
      baseCy: claim.baseCy ?? descriptor.baseCy,
      topCy: claim.topCy ?? descriptor.topCy,
    }))
    for (const reason of adapter.validateStructure(descriptor, { ownership }).reasons) {
      addReason(reasons, reason)
    }
  }

  return orderedFixtureReasons(reasons)
}

function makeFamilyAdapter(family, kinds) {
  return Object.freeze({
    family,
    kinds: Object.freeze([...new Set(kinds)].sort()),
  })
}

function makeStructureKindAdapter(family, kind) {
  return Object.freeze({
    family,
    kind,
    auditFixture(fixture) {
      return auditStructureFixture(fixture, family, kind)
    },
  })
}

function validTowerBounds(bounds) {
  return Number.isInteger(bounds?.x0) &&
    Number.isInteger(bounds?.z0) &&
    Number.isInteger(bounds?.x1) &&
    Number.isInteger(bounds?.z1) &&
    bounds.x0 <= bounds.x1 &&
    bounds.z0 <= bounds.z1
}

function exactTowerParticipantPair(participants) {
  if (!Array.isArray(participants) || participants.length !== 2) return false
  const [left, right] = participants
  return Number.isInteger(left?.cx) &&
    Number.isInteger(left?.cz) &&
    Number.isInteger(right?.cx) &&
    Number.isInteger(right?.cz) &&
    (left.cz < right.cz || (left.cz === right.cz && left.cx < right.cx)) &&
    Math.abs(left.cx - right.cx) + Math.abs(left.cz - right.cz) === 1
}

function towerBoundsInsideParticipants(bounds, participants) {
  if (!validTowerBounds(bounds) || !exactTowerParticipantPair(participants)) return false
  const minCx = Math.min(...participants.map(({ cx }) => cx))
  const maxCx = Math.max(...participants.map(({ cx }) => cx))
  const minCz = Math.min(...participants.map(({ cz }) => cz))
  const maxCz = Math.max(...participants.map(({ cz }) => cz))
  if (
    bounds.x0 < minCx * CHUNK ||
    bounds.x1 >= (maxCx + 1) * CHUNK ||
    bounds.z0 < minCz * CHUNK ||
    bounds.z1 >= (maxCz + 1) * CHUNK
  ) return false

  const touched = new Set()
  for (let cz = Math.floor(bounds.z0 / CHUNK); cz <= Math.floor(bounds.z1 / CHUNK); cz++) {
    for (let cx = Math.floor(bounds.x0 / CHUNK); cx <= Math.floor(bounds.x1 / CHUNK); cx++) {
      touched.add(towerParticipantKey({ cx, cz }))
    }
  }
  const expected = new Set(participants.map(towerParticipantKey))
  return touched.size === expected.size && [...touched].every((key) => expected.has(key))
}

function validTowerStair(stair) {
  const cells = [stair?.landing, ...(stair?.run ?? []), stair?.exit]
  if (
    !isRecord(stair) ||
    !Number.isInteger(stair.dir) ||
    stair.dir < 0 ||
    stair.dir > 3 ||
    !Array.isArray(stair.run) ||
    stair.run.length !== 2 ||
    cells.length !== 4 ||
    cells.some((cell) =>
      !Number.isInteger(cell?.lx) ||
      !Number.isInteger(cell?.lz) ||
      cell.lx < 0 ||
      cell.lx >= CHUNK ||
      cell.lz < 0 ||
      cell.lz >= CHUNK
    ) ||
    hasOwn(stair, 'lowerCy')
  ) return false

  const dx = [0, 1, 0, -1][stair.dir]
  const dz = [-1, 0, 1, 0][stair.dir]
  return cells.slice(1).every((cell, index) =>
    cell.lx === cells[index].lx + dx && cell.lz === cells[index].lz + dz
  )
}

function validateTowerDeck(descriptor, reasons) {
  const deck = Array.isArray(descriptor?.decks) && descriptor.decks.length === 1
    ? descriptor.decks[0]
    : null
  const participants = descriptor?.participants
  const cells = deck?.globalCells
  let valid = isRecord(deck) &&
    deck.levelCy === descriptor?.baseCy + 1 &&
    deck.lowerCy === descriptor?.baseCy &&
    Number.isInteger(deck.globalBridgeLine) &&
    validTowerBounds(deck.globalBounds) &&
    Array.isArray(cells) &&
    cells.length >= 2

  const cellParticipants = new Set()
  if (Array.isArray(cells)) {
    for (let index = 0; index < cells.length; index++) {
      const cell = cells[index]
      if (
        !isRecord(cell) ||
        !Number.isInteger(cell.gx) ||
        !Number.isInteger(cell.gz) ||
        hasOwn(cell, 'cy') ||
        (index > 0 && (
          Math.abs(cells[index - 1].gx - cell.gx) +
          Math.abs(cells[index - 1].gz - cell.gz) !== 1
        ))
      ) valid = false
      if (Number.isInteger(cell?.gx) && Number.isInteger(cell?.gz)) {
        cellParticipants.add(towerParticipantKey({
          cx: Math.floor(cell.gx / CHUNK),
          cz: Math.floor(cell.gz / CHUNK),
        }))
      }
    }
  }

  if (valid && descriptor.bridgeAxis === 'x') {
    valid = deck.globalBounds.x0 === cells[0].gx &&
      deck.globalBounds.x1 === cells.at(-1).gx &&
      deck.globalBounds.z0 === deck.globalBridgeLine &&
      deck.globalBounds.z1 === deck.globalBridgeLine &&
      cells.every((cell) => cell.gz === deck.globalBridgeLine)
  } else if (valid && descriptor.bridgeAxis === 'z') {
    valid = deck.globalBounds.z0 === cells[0].gz &&
      deck.globalBounds.z1 === cells.at(-1).gz &&
      deck.globalBounds.x0 === deck.globalBridgeLine &&
      deck.globalBounds.x1 === deck.globalBridgeLine &&
      cells.every((cell) => cell.gx === deck.globalBridgeLine)
  } else {
    valid = false
  }

  const expectedParticipants = new Set((participants ?? []).map(towerParticipantKey))
  valid &&= cellParticipants.size === 2 &&
    [...cellParticipants].every((key) => expectedParticipants.has(key))
  if (!valid) addReason(reasons, TOWER_AUDIT_REASONS.invalidDeck)
  return valid ? deck : null
}

function validateTowerLinks(descriptor, reasons) {
  const participantKeys = new Set((descriptor?.participants ?? []).map(towerParticipantKey))
  const links = descriptor?.verticalLinks
  const valid = Array.isArray(links) &&
    links.length === 2 &&
    links.every((link, index) =>
      link?.lowerCy === descriptor.baseCy + index &&
      participantKeys.has(towerParticipantKey(link)) &&
      validTowerStair(link.stair)
    )
  if (!valid) addReason(reasons, TOWER_AUDIT_REASONS.floorConnectivity)
  return valid
}

function towerSocketParticipantKey(socket) {
  if (!Number.isInteger(socket?.gx) || !Number.isInteger(socket?.gz)) return null
  return towerParticipantKey({
    cx: Math.floor(socket.gx / CHUNK),
    cz: Math.floor(socket.gz / CHUNK),
  })
}

function validateTowerLandmarks(descriptor, reasons) {
  const sockets = descriptor?.landmarkSockets
  const deck = descriptor?.decks?.[0]
  const participantKeys = new Set((descriptor?.participants ?? []).map(towerParticipantKey))
  let schemaValid = Array.isArray(sockets) && sockets.length > 0 &&
    descriptor?.proceduralDecoration !== true
  const kinds = new Set()
  const anchorFloors = new Set()
  const approachParticipants = new Set()
  const approachEndpoints = towerDeckEndpoints(descriptor)

  for (const socket of Array.isArray(sockets) ? sockets : []) {
    let valid = isRecord(socket) &&
      (socket.slot === 'anchorFloor' || socket.slot === 'bridgeApproach') &&
      TOWER_LANDMARK_SOCKET_KINDS.includes(socket.kind) &&
      Number.isInteger(socket.gx) &&
      Number.isInteger(socket.gz) &&
      Number.isInteger(socket.cy) &&
      (socket.axis === 'x' || socket.axis === 'z') &&
      (socket.side === -1 || socket.side === 1) &&
      validCanonicalId(socket.salt) &&
      socket.cy >= descriptor.baseCy &&
      socket.cy <= descriptor.topCy &&
      socket.gx >= descriptor.globalBounds?.x0 &&
      socket.gx <= descriptor.globalBounds?.x1 &&
      socket.gz >= descriptor.globalBounds?.z0 &&
      socket.gz <= descriptor.globalBounds?.z1 &&
      participantKeys.has(towerSocketParticipantKey(socket))
    if (socket?.slot === 'bridgeApproach') {
      const endpointIndex = approachEndpoints.findIndex((cell) =>
        sameTowerCell(cell, socket)
      )
      valid &&= endpointIndex >= 0 &&
        socket.axis === descriptor.bridgeAxis &&
        socket.side === (endpointIndex === 0 ? -1 : 1)
    }
    if (!valid) schemaValid = false
    if (!TOWER_LANDMARK_SOCKET_KINDS.includes(socket?.kind)) continue
    kinds.add(socket.kind)
    if (socket.slot === 'anchorFloor') {
      anchorFloors.add(socket.cy - descriptor.baseCy)
    } else if (socket.slot === 'bridgeApproach' && socket.cy === deck?.levelCy) {
      approachParticipants.add(towerSocketParticipantKey(socket))
    }
  }

  if (
    !schemaValid ||
    !TOWER_FLOOR_OFFSETS.every((offset) => anchorFloors.has(offset)) ||
    approachParticipants.size !== 2 ||
    [...participantKeys].some((key) => !approachParticipants.has(key))
  ) {
    addReason(reasons, TOWER_AUDIT_REASONS.missingLandmarkSocket)
  }
  if (Array.isArray(sockets) && sockets.length > 0 && kinds.size <= 1) {
    addReason(reasons, TOWER_AUDIT_REASONS.mixedLandmarkKinds)
  }
  return { kinds, anchorFloors, approachParticipants }
}

function validateTowerDescriptor(descriptor, reasons) {
  const adapter = structureAdapterFor(descriptor)
  const ownership = Array.isArray(descriptor?.participants)
    ? descriptor.participants.map((participant) => ({
        ...participant,
        id: descriptor.id,
        family: MAP_FAMILY_TOWER,
        baseCy: descriptor.baseCy,
        topCy: descriptor.topCy,
      }))
    : []
  for (const reason of adapter?.validateStructure(descriptor, { ownership }).reasons ?? []) {
    addReason(reasons, reason)
  }

  if (
    !isRecord(descriptor?.district) ||
    !Number.isInteger(descriptor.district.x) ||
    !Number.isInteger(descriptor.district.z) ||
    !Number.isInteger(descriptor.district.size) ||
    descriptor.district.size <= 0 ||
    descriptor?.bridgeAxis !== 'x' && descriptor?.bridgeAxis !== 'z' ||
    !towerBoundsInsideParticipants(descriptor?.globalBounds, descriptor?.participants)
  ) {
    addReason(reasons, TOWER_AUDIT_REASONS.structureIdentity)
  }
  if (
    descriptor?.levelCount !== 3 ||
    !Number.isInteger(descriptor?.baseCy) ||
    descriptor?.topCy !== descriptor?.baseCy + 2
  ) {
    addReason(reasons, TOWER_AUDIT_REASONS.verticalBand)
  }

  const deck = validateTowerDeck(descriptor, reasons)
  validateTowerLinks(descriptor, reasons)
  if (deck) validateTowerLandmarks(descriptor, reasons)
  if (TOWER_NETWORK_FIELDS.some((field) => hasOwn(descriptor ?? {}, field))) {
    addReason(reasons, TOWER_AUDIT_REASONS.crossDistrictNetwork)
  }
}

function validateTowerSyntheticStamp(stamping, descriptor, reasons) {
  const participants = descriptor.participants ?? []
  const expectedSlices = new Set(towerSliceCoordinates(descriptor).map(
    ({ cx, cy, cz }) => towerChunkKey(cx, cy, cz)
  ))
  const floorSlices = stamping?.floorSlices
  const observedSlices = new Set((floorSlices ?? []).map((slice) =>
    towerChunkKey(slice?.cx, slice?.cy, slice?.cz)
  ))
  if (
    !Array.isArray(floorSlices) ||
    floorSlices.length !== 6 ||
    observedSlices.size !== expectedSlices.size ||
    [...expectedSlices].some((key) => !observedSlices.has(key)) ||
    floorSlices.some((slice) => slice?.surface !== 'enclosedTower')
  ) {
    addReason(reasons, TOWER_AUDIT_REASONS.structureIdentity)
  }

  const deck = descriptor.decks?.[0]
  const skybridge = stamping?.skybridge
  const stampedCells = skybridge?.deckCells
  if (
    skybridge?.surface !== 'skybridgeDeck' ||
    skybridge?.id !== descriptor.id ||
    skybridge?.levelCy !== deck?.levelCy ||
    !Array.isArray(stampedCells) ||
    stampedCells.length !== deck?.globalCells?.length ||
    stampedCells.some((cell, index) => !sameTowerCell(cell, deck.globalCells[index]))
  ) {
    addReason(reasons, TOWER_AUDIT_REASONS.invalidDeck)
  }
  if (reasons.has(TOWER_AUDIT_REASONS.invalidDeck)) return

  const approaches = skybridge?.approaches
  const expectedApproaches = towerDeckEndpoints(descriptor)
  const approachParticipants = new Set()
  let approachesValid = Array.isArray(approaches) && approaches.length === 2
  for (let index = 0; index < (approaches?.length ?? 0); index++) {
    const approach = approaches[index]
    approachParticipants.add(towerParticipantKey(approach))
    approachesValid &&= approach?.id === descriptor.id &&
      approach?.levelCy === deck?.levelCy &&
      sameTowerCell(approach, expectedApproaches[index])
  }
  const expectedParticipantKeys = new Set(participants.map(towerParticipantKey))
  approachesValid &&= approachParticipants.size === 2 &&
    [...expectedParticipantKeys].every((key) => approachParticipants.has(key))
  if (!approachesValid) addReason(reasons, TOWER_AUDIT_REASONS.invalidApproach)

  if (
    !Array.isArray(skybridge?.guards) ||
    skybridge.guards.length !== 2 ||
    skybridge.guards.some((guard) => guard?.continuous !== true)
  ) {
    addReason(reasons, TOWER_AUDIT_REASONS.invalidGuard)
  }
}

function towerChunkMap(chunks) {
  const values = chunks instanceof Map
    ? [...chunks.values()]
    : Array.isArray(chunks)
      ? chunks
      : []
  return new Map(values.map((data) => [towerChunkKey(data?.cx, data?.cy, data?.cz), data]))
}

function towerGlobalCellData(chunks, cell, cy) {
  const cx = Math.floor(cell.gx / CHUNK)
  const cz = Math.floor(cell.gz / CHUNK)
  const data = chunks.get(towerChunkKey(cx, cy, cz))
  if (!data) return null
  return {
    data,
    lx: cell.gx - cx * CHUNK,
    lz: cell.gz - cz * CHUNK,
  }
}

function towerEdgeState(data, axis, line, cell) {
  return axis === 'v'
    ? {
        wall: data.vAt(line, cell),
        passage: data.passageVAt(line, cell),
        feature: data.wallFeatureVAt(line, cell),
      }
    : {
        wall: data.hAt(cell, line),
        passage: data.passageHAt(cell, line),
        feature: data.wallFeatureHAt(cell, line),
      }
}

function towerSocketEdge(data, socket) {
  const lx = socket.gx - data.cx * CHUNK
  const lz = socket.gz - data.cz * CHUNK
  return socket.axis === 'x'
    ? towerEdgeState(data, 'v', lx + (socket.side > 0 ? 1 : 0), lz)
    : towerEdgeState(data, 'h', lz + (socket.side > 0 ? 1 : 0), lx)
}

function validateTowerChunkStamp(chunkSource, descriptor, reasons) {
  const chunks = towerChunkMap(chunkSource)
  const expectedKeys = towerSliceCoordinates(descriptor).map(
    ({ cx, cy, cz }) => towerChunkKey(cx, cy, cz)
  )
  if (chunks.size !== 6 || expectedKeys.some((key) => !chunks.has(key))) {
    addReason(reasons, TOWER_AUDIT_REASONS.structureIdentity)
    return
  }

  for (const key of expectedKeys) {
    const data = chunks.get(key)
    const structure = data?.structure
    if (
      data?.mapFamily !== MAP_FAMILY_TOWER ||
      structure?.id !== descriptor.id ||
      structure?.family !== MAP_FAMILY_TOWER ||
      structure?.kind !== STRUCTURE_KIND_TOWER
    ) {
      addReason(reasons, TOWER_AUDIT_REASONS.structureIdentity)
      continue
    }

    const x0 = Math.max(descriptor.globalBounds.x0, data.cx * CHUNK)
    const z0 = Math.max(descriptor.globalBounds.z0, data.cz * CHUNK)
    const x1 = Math.min(descriptor.globalBounds.x1, (data.cx + 1) * CHUNK - 1)
    const z1 = Math.min(descriptor.globalBounds.z1, (data.cz + 1) * CHUNK - 1)
    let enclosedCells = 0
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const lx = gx - data.cx * CHUNK
        const lz = gz - data.cz * CHUNK
        if (
          data.cellKind[cIdx(lx, lz)] === CELL_LOBBY &&
          !data.hasFloorHole(lx, lz) &&
          data.spaceId[cIdx(lx, lz)] === descriptor.id
        ) enclosedCells++
      }
    }
    if (enclosedCells === 0) addReason(reasons, TOWER_AUDIT_REASONS.structureIdentity)
  }

  const deck = descriptor.decks[0]
  for (const cell of deck.globalCells) {
    const local = towerGlobalCellData(chunks, cell, deck.levelCy)
    const sliceOwnsDeckCell = local?.data?.structureDown?.bridgeCells?.some(
      (candidate) => candidate.lx === local.lx && candidate.lz === local.lz
    )
    if (
      !local ||
      ![CELL_BRIDGE, CELL_LOBBY, CELL_STAIR].includes(
        local.data.cellKind[cIdx(local.lx, local.lz)]
      ) ||
      !sliceOwnsDeckCell ||
      local.data.spaceId[cIdx(local.lx, local.lz)] !== descriptor.id ||
      local.data.hasFloorHole(local.lx, local.lz)
    ) {
      addReason(reasons, TOWER_AUDIT_REASONS.invalidDeck)
      break
    }

    const guards = descriptor.bridgeAxis === 'x'
      ? [
          towerEdgeState(local.data, 'h', local.lz, local.lx),
          towerEdgeState(local.data, 'h', local.lz + 1, local.lx),
        ]
      : [
          towerEdgeState(local.data, 'v', local.lx, local.lz),
          towerEdgeState(local.data, 'v', local.lx + 1, local.lz),
        ]
    if (guards.some((guard) =>
      guard.wall !== 1 || guard.passage !== PASSAGE_WALL || guard.feature !== WALL_RAIL
    )) {
      addReason(reasons, TOWER_AUDIT_REASONS.invalidGuard)
      break
    }
  }

  const endpoints = towerDeckEndpoints(descriptor)
  for (let index = 0; index < endpoints.length; index++) {
    const endpoint = endpoints[index]
    const local = towerGlobalCellData(chunks, endpoint, deck.levelCy)
    const slice = local?.data?.structureDown
    const edge = !local
      ? null
      : descriptor.bridgeAxis === 'x'
        ? towerEdgeState(local.data, 'v', local.lx + (index === 0 ? 0 : 1), local.lz)
        : towerEdgeState(local.data, 'h', local.lz + (index === 0 ? 0 : 1), local.lx)
    if (
      !local ||
      slice?.id !== descriptor.id ||
      slice?.kind !== STRUCTURE_KIND_TOWER ||
      slice?.levelCy !== deck.levelCy ||
      edge?.wall !== 0 ||
      (edge?.passage !== PASSAGE_WIDE && edge?.passage !== PASSAGE_DOOR)
    ) {
      addReason(reasons, TOWER_AUDIT_REASONS.invalidApproach)
    }
  }

  for (const link of descriptor.verticalLinks) {
    const lower = chunks.get(towerChunkKey(link.cx, link.lowerCy, link.cz))
    const upper = chunks.get(towerChunkKey(link.cx, link.lowerCy + 1, link.cz))
    if (
      JSON.stringify(lower?.stairUp) !== JSON.stringify(link.stair) ||
      JSON.stringify(upper?.stairDown) !== JSON.stringify(link.stair)
    ) {
      addReason(reasons, TOWER_AUDIT_REASONS.floorConnectivity)
    }
  }

  const door = descriptor.landmarkSockets.find((socket) => socket.kind === 'door')
  const doorData = door && chunks.get(towerChunkKey(
    Math.floor(door.gx / CHUNK),
    door.cy,
    Math.floor(door.gz / CHUNK)
  ))
  if (!doorData || towerSocketEdge(doorData, door).passage !== PASSAGE_DOOR) {
    addReason(reasons, TOWER_AUDIT_REASONS.missingLandmarkSocket)
  }
  const fixture = descriptor.landmarkSockets.find((socket) => socket.kind === 'fixture')
  const fixtureData = fixture && chunks.get(towerChunkKey(
    Math.floor(fixture.gx / CHUNK),
    fixture.cy,
    Math.floor(fixture.gz / CHUNK)
  ))
  if (
    !fixtureData ||
    !fixtureData.lamps?.some((lamp) =>
      lamp.lx === fixture.gx - fixtureData.cx * CHUNK &&
      lamp.lz === fixture.gz - fixtureData.cz * CHUNK
    )
  ) {
    addReason(reasons, TOWER_AUDIT_REASONS.missingLandmarkSocket)
  }
}

function auditTowerFixture(fixture) {
  const reasons = new Set(auditStructureFixture(
    fixture,
    MAP_FAMILY_TOWER,
    STRUCTURE_KIND_TOWER
  ))
  if (reasons.size > 0) return orderedFixtureReasons(reasons)

  const descriptors = Array.isArray(fixture?.descriptors) ? fixture.descriptors : []
  if (descriptors.length === 0) {
    addReason(reasons, TOWER_AUDIT_REASONS.orphanDescriptor)
    return orderedFixtureReasons(reasons)
  }
  for (const descriptor of descriptors) {
    if (fixture?.chunks) {
      validateTowerDescriptor(descriptor, reasons)
      validateTowerChunkStamp(fixture.chunks, descriptor, reasons)
    } else if (fixture?.stamping) {
      validateTowerDescriptor(descriptor, reasons)
      validateTowerSyntheticStamp(fixture.stamping, descriptor, reasons)
    }
  }
  return orderedFixtureReasons(reasons)
}

function makeTowerKindAdapter() {
  return Object.freeze({
    family: MAP_FAMILY_TOWER,
    kind: STRUCTURE_KIND_TOWER,
    socketKinds: TOWER_LANDMARK_SOCKET_KINDS,
    auditFixture: auditTowerFixture,
    auditDescriptor(descriptor) {
      const reasons = new Set()
      validateTowerDescriptor(descriptor, reasons)
      return orderedFixtureReasons(reasons)
    },
    auditLandmarks(descriptor) {
      const reasons = new Set()
      validateTowerLandmarks(descriptor, reasons)
      return orderedFixtureReasons(reasons)
    },
  })
}

const LATTICE_PROFILE = Object.freeze({
  ...DEFAULT_WORLD_CONFIG.mapFamily.profiles.lattice,
  family: MAP_FAMILY_LATTICE,
  enabled: true,
  cycleRate: Object.freeze([
    ...DEFAULT_WORLD_CONFIG.mapFamily.profiles.lattice.cycleRate,
  ]),
})

const LATTICE_DESCRIPTOR_REASON_TO_AUDIT = Object.freeze({
  [LATTICE_DESCRIPTOR_REASONS.orphanDescriptor]:
    LATTICE_AUDIT_REASONS.orphanDescriptor,
  [LATTICE_DESCRIPTOR_REASONS.familyMismatch]:
    LATTICE_AUDIT_REASONS.familyMismatch,
  [LATTICE_DESCRIPTOR_REASONS.canonicalIdMismatch]:
    LATTICE_AUDIT_REASONS.canonicalIdMismatch,
  [LATTICE_DESCRIPTOR_REASONS.bounded]: LATTICE_AUDIT_REASONS.bounded,
  [LATTICE_DESCRIPTOR_REASONS.anchorShape]:
    LATTICE_AUDIT_REASONS.anchorShape,
  [LATTICE_DESCRIPTOR_REASONS.edgeShape]: LATTICE_AUDIT_REASONS.edgeShape,
  [LATTICE_DESCRIPTOR_REASONS.duplicateEdge]:
    LATTICE_AUDIT_REASONS.duplicateEdge,
  [LATTICE_DESCRIPTOR_REASONS.edgeOrder]: LATTICE_AUDIT_REASONS.edgeOrder,
  [LATTICE_DESCRIPTOR_REASONS.disconnectedBackbone]:
    LATTICE_AUDIT_REASONS.disconnectedBackbone,
  [LATTICE_DESCRIPTOR_REASONS.cyclicBackbone]:
    LATTICE_AUDIT_REASONS.cyclicBackbone,
  [LATTICE_DESCRIPTOR_REASONS.backboneNotMinimum]:
    LATTICE_AUDIT_REASONS.backboneNotMinimum,
  [LATTICE_DESCRIPTOR_REASONS.cycleRate]: LATTICE_AUDIT_REASONS.cycleRate,
  [LATTICE_DESCRIPTOR_REASONS.missingHorizontalLink]:
    LATTICE_AUDIT_REASONS.missingHorizontalLink,
  [LATTICE_DESCRIPTOR_REASONS.missingVerticalLink]:
    LATTICE_AUDIT_REASONS.missingVerticalLink,
  [LATTICE_DESCRIPTOR_REASONS.missingSpine]:
    LATTICE_AUDIT_REASONS.missingSpine,
  [LATTICE_DESCRIPTOR_REASONS.verticalLinkDescriptor]:
    LATTICE_AUDIT_REASONS.verticalLinkDescriptor,
  [LATTICE_DESCRIPTOR_REASONS.exposureRange]:
    LATTICE_AUDIT_REASONS.exposureRange,
  [LATTICE_DESCRIPTOR_REASONS.enclosedRoomIdentity]:
    LATTICE_AUDIT_REASONS.enclosedRoomIdentity,
  [LATTICE_DESCRIPTOR_REASONS.crossDistrictNetwork]:
    LATTICE_AUDIT_REASONS.crossDistrictNetwork,
})

function analyzeLatticeDescriptorForAudit(descriptor) {
  const analysis = analyzeLatticeDescriptor(descriptor, LATTICE_PROFILE)
  const reasons = new Set()
  if (analysis.reason) {
    addReason(
      reasons,
      LATTICE_DESCRIPTOR_REASON_TO_AUDIT[analysis.reason] ??
        LATTICE_AUDIT_REASONS.edgeShape
    )
  }
  return {
    ...analysis,
    descriptor,
    reasons,
    minimumTree: analysis.minimumTreeKeys,
    eligibleCycles: analysis.eligibleCycleKeys,
  }
}

function latticeChunkMap(source) {
  const chunks = source instanceof Map
    ? [...source.values()]
    : Array.isArray(source)
      ? source
      : []
  return new Map(chunks.map((data) => [
    latticeChunkKey(data?.cx, data?.cy, data?.cz),
    data,
  ]))
}

function latticeGlobalEdge(chunks, axis, gx, gz, cy) {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  const data = chunks.get(latticeChunkKey(cx, cy, cz))
  if (!data) return null
  const lx = gx - cx * CHUNK
  const lz = gz - cz * CHUNK
  return axis === 'v'
    ? {
        wall: data.vAt(lx, lz),
        passage: data.passageVAt(lx, lz),
        feature: data.wallFeatureVAt(lx, lz),
      }
    : {
        wall: data.hAt(lx, lz),
        passage: data.passageHAt(lx, lz),
        feature: data.wallFeatureHAt(lx, lz),
      }
}

function auditLatticeRaster(chunks, analysis) {
  const { descriptor } = analysis
  const result = {
    stampMismatch: false,
    exposureFailure: false,
    cueCoverageFailure: false,
    cueSourcesFailure: false,
    cueCountFailure: false,
    plainWallSideFailures: 0,
    enclosedRoomSlices: 0,
    guardFailures: 0,
    approachFailures: 0,
    minimumCombined: Infinity,
    minimumRails: Infinity,
    minimumSeams: Infinity,
  }
  const expectedChunkKeys = latticeSliceCoordinates(descriptor).map(
    ({ cx, cy, cz }) => latticeChunkKey(cx, cy, cz)
  )
  if (chunks.size !== 27 || expectedChunkKeys.some((key) => !chunks.has(key))) {
    result.stampMismatch = true
    return result
  }

  const descriptorJson = JSON.stringify(descriptor)
  for (const key of expectedChunkKeys) {
    const data = chunks.get(key)
    if (
      data?.mapFamily !== MAP_FAMILY_LATTICE ||
      JSON.stringify(data.structure) !== descriptorJson
    ) {
      result.stampMismatch = true
      return result
    }
    if (LATTICE_ROOM_FIELDS.some((field) => hasOwn(data, field))) {
      result.enclosedRoomSlices++
    }
  }

  for (let cy = descriptor.baseCy; cy <= descriptor.topCy; cy++) {
    const geometry = latticeFloorGeometry(descriptor, cy)
    for (const participant of descriptor.participants) {
      const data = chunks.get(latticeChunkKey(participant.cx, cy, participant.cz))
      const chunkGx = participant.cx * CHUNK
      const chunkGz = participant.cz * CHUNK
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const gx = chunkGx + lx
          const gz = chunkGz + lz
          const cellKey = latticeHorizontalCellKey(gx, gz)
          const owned = data.spaceId[cIdx(lx, lz)] === descriptor.id
          if (!owned) {
            result.stampMismatch = true
            continue
          }
          const actualKind = data.cellKind[cIdx(lx, lz)]
          if (geometry.chamberCells.has(cellKey)) {
            if (actualKind !== CELL_ATRIUM) {
              result.stampMismatch = true
            }
          } else if (geometry.edgeCells.has(cellKey)) {
            if (actualKind !== CELL_BRIDGE) {
              result.stampMismatch = true
            }
          } else if (geometry.stairSafeCells.has(cellKey)) {
            if (![CELL_ATRIUM, CELL_STAIR, CELL_LOBBY].includes(actualKind)) {
              result.stampMismatch = true
            }
          } else if (actualKind !== CELL_VOID) {
            result.stampMismatch = true
          }
        }
      }
      for (const slice of [data.structureUp, data.structureDown]) {
        if (!slice) continue
        const expected = latticeProjectedSegments(
          descriptor,
          participant.cx,
          participant.cz,
          slice.levelCy
        )
        if (JSON.stringify(slice.bridgeSegments) !== JSON.stringify(expected)) {
          result.stampMismatch = true
        }
      }
    }
  }
  if (result.stampMismatch) return result

  for (const link of descriptor.verticalLinks) {
    const lower = chunks.get(latticeChunkKey(link.cx, link.lowerCy, link.cz))
    const upper = chunks.get(latticeChunkKey(link.cx, link.lowerCy + 1, link.cz))
    if (
      JSON.stringify(lower?.stairUp) !== JSON.stringify(link.stair) ||
      JSON.stringify(upper?.stairDown) !== JSON.stringify(link.stair)
    ) result.stampMismatch = true
  }
  if (result.stampMismatch) return result

  for (const data of chunks.values()) {
    const upper = chunks.get(latticeChunkKey(data.cx, data.cy + 1, data.cz))
    if (!upper || data.cy >= descriptor.topCy) continue
    if (auditLethalVoidPair(data, upper).length > 0) {
      result.stampMismatch = true
      continue
    }
    const half = data.lethalVoidUp
    const anchors = descriptor.anchors.filter((anchor) =>
      anchor.levelCy === data.cy + 1
    )
    for (const cell of half?.cells ?? []) {
      const gx = data.cx * CHUNK + cell.lx
      const gz = data.cz * CHUNK + cell.lz
      const nearest = latticeNearestAnchor(anchors, gx, gz)
      const exposureM = latticeEffectiveExposureM(nearest, LATTICE_PROFILE)
      const expected = Math.round(((data.cy + 1) * LAYER_H - exposureM) * 1000)
      if (cell.deathYmm !== expected) result.exposureFailure = true
    }
  }

  for (const anchor of descriptor.anchors) {
    const sides = latticeChamberPerimeter(anchor)
    const expectedApproaches = latticeChamberApproaches(descriptor, anchor)
    const rails = new Set()
    const seams = new Set()
    let plainSides = 0
    for (const side of sides) {
      let plainCells = 0
      for (const edge of side) {
        const key = `${edge.axis}:${edge.gx},${edge.gz}`
        const state = latticeGlobalEdge(
          chunks,
          edge.axis,
          edge.gx,
          edge.gz,
          anchor.levelCy
        )
        if (state?.wall === 1 && state.passage === PASSAGE_WALL && state.feature === WALL_RAIL) {
          rails.add(key)
        }
        if (state?.wall === 1 && state.feature === WALL_PLAIN) plainCells++
        if (
          expectedApproaches.has(key) &&
          state?.wall === 0 &&
          state.passage !== PASSAGE_WALL
        ) seams.add(key)
      }
      if (plainCells >= 2) plainSides++
    }
    if (expectedApproaches.size === 0) result.cueCoverageFailure = true
    const missingApproaches = [...expectedApproaches].filter((key) => !seams.has(key))
    if (missingApproaches.length > 0) {
      result.approachFailures++
    }
    if (rails.size === 0 || seams.size === 0) result.cueSourcesFailure = true
    if (new Set([...rails, ...seams]).size < LATTICE_PROFILE.minimumCueCells) {
      result.cueCountFailure = true
    }
    if (plainSides >= 3) result.plainWallSideFailures++
    result.minimumCombined = Math.min(result.minimumCombined, rails.size + seams.size)
    result.minimumRails = Math.min(result.minimumRails, rails.size)
    result.minimumSeams = Math.min(result.minimumSeams, seams.size)
  }

  for (let cy = descriptor.baseCy; cy <= descriptor.topCy; cy++) {
    const retained = latticeFloorGeometry(descriptor, cy).retained
    for (const key of retained) {
      const [gx, gz] = key.split(',').map(Number)
      for (const boundary of [
        { axis: 'v', gx, gz, neighbor: latticeHorizontalCellKey(gx - 1, gz) },
        { axis: 'v', gx: gx + 1, gz, neighbor: latticeHorizontalCellKey(gx + 1, gz) },
        { axis: 'h', gx, gz, neighbor: latticeHorizontalCellKey(gx, gz - 1) },
        { axis: 'h', gx, gz: gz + 1, neighbor: latticeHorizontalCellKey(gx, gz + 1) },
      ]) {
        if (retained.has(boundary.neighbor)) continue
        const state = latticeGlobalEdge(
          chunks,
          boundary.axis,
          boundary.gx,
          boundary.gz,
          cy
        )
        if (
          state?.wall !== 1 ||
          state.passage !== PASSAGE_WALL ||
          state.feature !== WALL_RAIL
        ) result.guardFailures++
      }
    }
  }
  return result
}

function latticeFixtureAudit(fixture) {
  const chunks = latticeChunkMap(fixture?.chunks)
  const descriptorChunks = [...chunks.values()].filter((data) =>
    data?.structure?.kind === STRUCTURE_KIND_LATTICE ||
    data?.mapFamily === MAP_FAMILY_LATTICE
  )
  const descriptor = descriptorChunks.find((data) =>
    isRecord(data?.structure)
  )?.structure
  if (!descriptor) {
    return {
      reasons: [LATTICE_AUDIT_REASONS.orphanDescriptor],
      metrics: null,
    }
  }
  if (descriptorChunks.some((data) => data.mapFamily !== MAP_FAMILY_LATTICE)) {
    return {
      reasons: [LATTICE_AUDIT_REASONS.familyMismatch],
      metrics: null,
    }
  }
  const descriptorJson = JSON.stringify(descriptor)
  if (descriptorChunks.some((data) =>
    !isRecord(data.structure) ||
    data.structure.id !== descriptor.id ||
    JSON.stringify(data.structure) !== descriptorJson
  )) {
    return {
      reasons: [LATTICE_AUDIT_REASONS.canonicalIdMismatch],
      metrics: null,
    }
  }

  const floorCoverage = [...new Set(descriptorChunks.map((data) =>
    data.cy - descriptor.baseCy
  ))].sort((a, b) => a - b)
  if (
    floorCoverage.length !== LATTICE_FLOOR_OFFSETS.length ||
    LATTICE_FLOOR_OFFSETS.some((floor) => !floorCoverage.includes(floor))
  ) {
    return {
      reasons: [LATTICE_AUDIT_REASONS.missingFloorAudit],
      metrics: null,
    }
  }
  const expectedKeys = new Set(latticeSliceCoordinates(descriptor).map(
    ({ cx, cy, cz }) => latticeChunkKey(cx, cy, cz)
  ))
  if (expectedKeys.size !== 27 || [...expectedKeys].some((key) => !chunks.has(key))) {
    return {
      reasons: [LATTICE_AUDIT_REASONS.missingParticipant],
      metrics: null,
    }
  }

  const analysis = analyzeLatticeDescriptorForAudit(descriptor)
  const descriptorReasons = orderedFixtureReasons(analysis.reasons)
  if (descriptorReasons.length > 0) return { reasons: descriptorReasons, metrics: null }
  const raster = auditLatticeRaster(chunks, analysis)
  let rasterReason = null
  if (raster.stampMismatch) rasterReason = LATTICE_AUDIT_REASONS.stampMismatch
  else if (raster.exposureFailure) rasterReason = LATTICE_AUDIT_REASONS.exposureRange
  else if (raster.enclosedRoomSlices > 0) rasterReason = LATTICE_AUDIT_REASONS.enclosedRoomIdentity
  else if (raster.plainWallSideFailures > 0) rasterReason = LATTICE_AUDIT_REASONS.plainWallSides
  else if (raster.approachFailures > 0) rasterReason = LATTICE_AUDIT_REASONS.invalidApproach
  else if (raster.cueCoverageFailure) rasterReason = LATTICE_AUDIT_REASONS.cueCoverage
  else if (raster.cueSourcesFailure) rasterReason = LATTICE_AUDIT_REASONS.cueSources
  else if (raster.cueCountFailure) rasterReason = LATTICE_AUDIT_REASONS.cueCount
  else if (raster.guardFailures > 0) rasterReason = LATTICE_AUDIT_REASONS.invalidGuard

  const exposures = descriptor.anchors.map((anchor) =>
    latticeEffectiveExposureM(anchor, LATTICE_PROFILE)
  )
  const metrics = {
    participantCardinality: descriptor.participants.length,
    districtFootprint: { x: descriptor.district.size, z: descriptor.district.size },
    districtCount: 1,
    floorCoverage,
    anchorCount: descriptor.anchors.length,
    backbone: {
      edgeCount: analysis.treeEdges.length,
      connected: analysis.treeEdges.length === 24,
      acyclic: analysis.treeEdges.length === 24,
      minimum: [...analysis.minimumTree].every((key) =>
        analysis.treeEdges.some((edge) => latticeEdgeKey(edge) === key)
      ),
    },
    cycles: {
      inserted: analysis.cycleEdges.length,
      eligibleNonBackboneLinks: descriptor.eligibleNonBackboneLinks,
      rate: analysis.cycleEdges.length / descriptor.eligibleNonBackboneLinks,
    },
    orientations: {
      horizontal: descriptor.edges.some(({ role }) => role !== 'vertical'),
      vertical: descriptor.edges.some(({ role }) => role === 'vertical'),
    },
    verticalConnections: {
      lowerMiddle: descriptor.verticalLinks.some(({ lowerCy }) => lowerCy === descriptor.baseCy),
      middleUpper: descriptor.verticalLinks.some(({ lowerCy }) => lowerCy === descriptor.baseCy + 1),
    },
    stamping: {
      floorSlices: chunks.size,
      chamberContexts: descriptor.anchors.length,
      bridgeSegmentsMatchDescriptor: !raster.stampMismatch,
      enclosedRoomSlices: raster.enclosedRoomSlices,
    },
    exposure: {
      defaultM: LATTICE_PROFILE.defaultExposureM,
      maximumM: LATTICE_PROFILE.maxExposureM,
      observedMaximumM: Math.max(...exposures),
      invalidAnchors: raster.exposureFailure ? 1 : 0,
    },
    cues: {
      minimumRequired: LATTICE_PROFILE.minimumCueCells,
      minimumCombined: Number.isFinite(raster.minimumCombined) ? raster.minimumCombined : 0,
      railPerimeterCells: Number.isFinite(raster.minimumRails) ? raster.minimumRails : 0,
      bridgeSeamCells: Number.isFinite(raster.minimumSeams) ? raster.minimumSeams : 0,
    },
    plainWallSideFailures: raster.plainWallSideFailures,
    guardFailures: raster.guardFailures,
    approachFailures: raster.approachFailures,
    descriptorFailures: rasterReason ? 1 : 0,
  }
  return { reasons: rasterReason ? [rasterReason] : [], metrics }
}

function auditLatticeFixture(fixture) {
  return latticeFixtureAudit(fixture).reasons
}

function auditLatticeCorpus(fixtures, voidSafety) {
  const audits = (fixtures ?? []).map(latticeFixtureAudit)
  const reasons = audits.flatMap((audit) => audit.reasons)
  const valid = audits.map((audit) => audit.metrics).filter(Boolean)
  if (valid.length === 0) return { reasons, metrics: null }
  const first = structuredClone(valid[0])
  first.cues.minimumCombined = Math.min(...valid.map((metrics) => metrics.cues.minimumCombined))
  first.cues.railPerimeterCells = Math.min(...valid.map((metrics) => metrics.cues.railPerimeterCells))
  first.cues.bridgeSeamCells = Math.min(...valid.map((metrics) => metrics.cues.bridgeSeamCells))
  first.plainWallSideFailures = valid.reduce(
    (sum, metrics) => sum + metrics.plainWallSideFailures,
    0
  )
  first.guardFailures = valid.reduce((sum, metrics) => sum + metrics.guardFailures, 0)
  first.approachFailures = valid.reduce((sum, metrics) => sum + metrics.approachFailures, 0)
  first.descriptorFailures = reasons.length
  first.voidSafety = voidSafety
  return { reasons, metrics: first }
}

function makeLatticeKindAdapter() {
  return Object.freeze({
    family: MAP_FAMILY_LATTICE,
    kind: STRUCTURE_KIND_LATTICE,
    auditDimensions: LATTICE_AUDIT_DIMENSIONS,
    auditFixture: auditLatticeFixture,
    auditDescriptor(descriptor) {
      return orderedFixtureReasons(
        analyzeLatticeDescriptorForAudit(descriptor).reasons
      )
    },
    auditCorpus(fixtures, { voidSafety } = {}) {
      return auditLatticeCorpus(fixtures, voidSafety)
    },
  })
}

const SEWER_KIND = SEWER_DESCRIPTOR_KIND
const UINT32_MAX = 0xffffffff
const SEWER_MODULE_SET = new Set(SEWER_MODULE_KINDS)
const SEWER_DIRECTION_SET = new Set(SEWER_DIRECTIONS)
const DEFERRED_SEWER_MODULE_SET = new Set([
  'uBend',
  'cross',
  'floodedStretch',
  'ventShaft',
])

function hasCanonicalSewerSeams(seams, config = DEFAULT_WORLD_CONFIG) {
  try {
    const office = borderPairMode(ZONE_SEWER, ZONE_OFFICE, config)
    const openHallModes = [ZONE_PILLARS, ZONE_WAREHOUSE].map((zone) =>
      borderPairMode(ZONE_SEWER, zone, config)
    )
    return seams?.office === office &&
      openHallModes.every((mode) => mode === openHallModes[0]) &&
      seams?.openHall === openHallModes[0]
  } catch {
    return false
  }
}

function carriesWetOutput(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    if (key === 'optionalSystems') continue
    if (/^(water|waterDepth|wet|wading)$/i.test(key)) return true
    if (carriesWetOutput(child, seen)) return true
  }
  return false
}

function validLocalBounds(bounds) {
  return Number.isInteger(bounds?.x0) &&
    Number.isInteger(bounds?.z0) &&
    Number.isInteger(bounds?.x1) &&
    Number.isInteger(bounds?.z1) &&
    bounds.x0 >= 0 &&
    bounds.z0 >= 0 &&
    bounds.x0 <= bounds.x1 &&
    bounds.z0 <= bounds.z1 &&
    bounds.x1 < CHUNK &&
    bounds.z1 < CHUNK
}

function moduleInsideBounds(module, bounds) {
  return Number.isInteger(module?.lx) &&
    Number.isInteger(module?.lz) &&
    module.lx >= bounds.x0 &&
    module.lx <= bounds.x1 &&
    module.lz >= bounds.z0 &&
    module.lz <= bounds.z1
}

function analyzeCanonicalEdges(edges, moduleCount) {
  const list = Array.isArray(edges) ? edges : []
  const adjacency = Array.from({ length: moduleCount }, () => [])
  const keys = new Set()
  let canonical = Array.isArray(edges)
  let previous = null

  for (const edge of list) {
    const valid = isRecord(edge) &&
      Number.isInteger(edge.a) &&
      Number.isInteger(edge.b) &&
      edge.a >= 0 &&
      edge.b < moduleCount &&
      edge.a < edge.b
    if (!valid) {
      canonical = false
      continue
    }

    const key = sewerEdgeKey(edge.a, edge.b)
    if (keys.has(key) || (previous && compareSewerEdges(previous, edge) >= 0)) {
      canonical = false
    }
    keys.add(key)
    previous = edge
    adjacency[edge.a].push(edge.b)
    adjacency[edge.b].push(edge.a)
  }

  return { adjacency, canonical, keys }
}

function reachableIndexes(adjacency, rootIndex, allowed = null) {
  const seen = new Set()
  if (
    rootIndex < 0 ||
    rootIndex >= adjacency.length ||
    (allowed && !allowed.has(rootIndex))
  ) return seen

  const queue = [rootIndex]
  seen.add(rootIndex)
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const next of adjacency[queue[cursor]]) {
      if (seen.has(next) || (allowed && !allowed.has(next))) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

function treeIsAcyclic(edges, moduleCount) {
  if (!Array.isArray(edges)) return false
  const parent = Array.from({ length: moduleCount }, (_, index) => index)
  const find = (node) => {
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]]
      node = parent[node]
    }
    return node
  }

  for (const edge of edges) {
    if (!isRecord(edge)) return false
    const { a, b } = edge
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b >= moduleCount) {
      return false
    }
    const left = find(a)
    const right = find(b)
    if (left === right) return false
    parent[left] = right
  }
  return true
}

function validateSewerDescriptor(descriptor, reasons) {
  if (!isRecord(descriptor) || descriptor.family !== MAP_FAMILY_SEWER) {
    addReason(reasons, SEWER_AUDIT_REASONS.familyMismatch)
    return {
      moduleCount: 0,
      rootIndex: -1,
      tree: null,
      loops: null,
      usable: false,
    }
  }
  if (
    !Number.isInteger(descriptor.id) ||
    descriptor.id < 0 ||
    descriptor.id > UINT32_MAX
  ) {
    addReason(reasons, SEWER_AUDIT_REASONS.canonicalIdMismatch)
  }
  if (carriesWetOutput(descriptor)) addReason(reasons, SEWER_AUDIT_REASONS.wetOutput)

  const bounds = descriptor.bounds
  const modules = Array.isArray(descriptor.modules) ? descriptor.modules : []
  const moduleCount = modules.length
  let topologyValid = validLocalBounds(bounds) && moduleCount > 0
  const moduleCells = new Set()

  for (const module of modules) {
    const kindAllowed = SEWER_MODULE_SET.has(module?.kind)
    if (!kindAllowed) addReason(reasons, SEWER_AUDIT_REASONS.deferredModule)
    if (
      !isRecord(module) ||
      !moduleInsideBounds(module, bounds ?? {}) ||
      !SEWER_DIRECTION_SET.has(module.dir) ||
      moduleCells.has(sewerCellKey(module?.lx, module?.lz))
    ) {
      topologyValid = false
    }
    if (isRecord(module)) moduleCells.add(sewerCellKey(module.lx, module.lz))
  }

  const rootMatches = modules
    .map((module, index) => ({ module, index }))
    .filter(({ module }) =>
      module?.lx === descriptor.trunkRoot?.lx &&
      module?.lz === descriptor.trunkRoot?.lz
    )
  const rootIndex = rootMatches.length === 1 ? rootMatches[0].index : -1
  if (rootIndex < 0) topologyValid = false

  const tree = analyzeCanonicalEdges(descriptor.treeEdges, moduleCount)
  if (
    !tree.canonical ||
    (descriptor.treeEdges?.length ?? -1) !== moduleCount - 1 ||
    !treeIsAcyclic(descriptor.treeEdges, moduleCount) ||
    reachableIndexes(tree.adjacency, rootIndex).size !== moduleCount
  ) {
    topologyValid = false
  }
  if (!topologyValid) addReason(reasons, SEWER_AUDIT_REASONS.unreachableModule)

  const loops = analyzeCanonicalEdges(descriptor.loopEdges, moduleCount)
  let loopValid = loops.canonical &&
    Number.isInteger(descriptor.eligibleNonTreeLinks) &&
    descriptor.eligibleNonTreeLinks > 0 &&
    (descriptor.loopEdges?.length ?? 0) < descriptor.eligibleNonTreeLinks
  for (const key of loops.keys) {
    if (tree.keys.has(key)) loopValid = false
  }
  if (!loopValid) addReason(reasons, SEWER_AUDIT_REASONS.loopBudget)

  return { moduleCount, rootIndex, tree, loops, usable: true }
}

function validateSewerRaster(structure, descriptorState, reasons) {
  const raster = structure?.raster
  const moduleCount = descriptorState.moduleCount
  const traversable = Array.isArray(raster?.traversableModules)
    ? raster.traversableModules
    : []
  const allowed = new Set()
  let valid = traversable.length === moduleCount
  for (const index of traversable) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= moduleCount ||
      allowed.has(index)
    ) {
      valid = false
      continue
    }
    allowed.add(index)
  }

  const links = analyzeCanonicalEdges(raster?.links, moduleCount)
  // A physical raster may enumerate independently derived links in traversal
  // order rather than descriptor order, so only endpoint/index uniqueness is
  // canonical here; list ordering is not used as geometry evidence.
  const rasterAdjacency = Array.from({ length: moduleCount }, () => [])
  const linkKeys = new Set()
  if (!Array.isArray(raster?.links)) valid = false
  const rasterLinks = Array.isArray(raster?.links) ? raster.links : []
  for (const edge of rasterLinks) {
    if (
      !isRecord(edge) ||
      !Number.isInteger(edge.a) ||
      !Number.isInteger(edge.b) ||
      edge.a < 0 ||
      edge.b >= moduleCount ||
      edge.a >= edge.b ||
      linkKeys.has(sewerEdgeKey(edge.a, edge.b))
    ) {
      valid = false
      continue
    }
    linkKeys.add(sewerEdgeKey(edge.a, edge.b))
    rasterAdjacency[edge.a].push(edge.b)
    rasterAdjacency[edge.b].push(edge.a)
  }
  // Keep the strict analysis live so malformed endpoint arrays cannot be
  // accepted merely because a duplicate happened to preserve reachability.
  if (!links.canonical && linkKeys.size !== (raster?.links?.length ?? 0)) valid = false
  if (
    reachableIndexes(rasterAdjacency, descriptorState.rootIndex, allowed).size !==
      moduleCount
  ) {
    valid = false
  }
  if (!valid) addReason(reasons, SEWER_AUDIT_REASONS.unreachableModule)
}

function validLightingCell(cell) {
  return Number.isInteger(cell?.lx) &&
    Number.isInteger(cell?.lz) &&
    cell.lx >= 0 &&
    cell.lx < CHUNK &&
    cell.lz >= 0 &&
    cell.lz < CHUNK
}

function validateSewerLighting(structure, reasons) {
  const eligible = structure?.lighting?.eligibleLocations
  const lit = structure?.lighting?.litLocations
  let valid = Array.isArray(eligible) && Array.isArray(lit)
  const eligibleKeys = new Set()
  const litKeys = new Set()

  const eligibleList = Array.isArray(eligible) ? eligible : []
  const litList = Array.isArray(lit) ? lit : []
  for (const cell of eligibleList) {
    const key = sewerCellKey(cell?.lx, cell?.lz)
    if (!validLightingCell(cell) || eligibleKeys.has(key)) valid = false
    eligibleKeys.add(key)
  }
  for (const cell of litList) {
    const key = sewerCellKey(cell?.lx, cell?.lz)
    if (
      !validLightingCell(cell) ||
      litKeys.has(key) ||
      !eligibleKeys.has(key)
    ) {
      valid = false
    }
    litKeys.add(key)
  }
  if (
    eligibleKeys.size >= 2 &&
    (litKeys.size === 0 || litKeys.size === eligibleKeys.size)
  ) {
    valid = false
  }
  if (!valid) addReason(reasons, SEWER_AUDIT_REASONS.nonSparseLighting)
}

function validateSewerStructure(structure, descriptor, descriptorState, reasons) {
  if (
    !isRecord(structure) ||
    structure.family !== MAP_FAMILY_SEWER ||
    structure.kind !== SEWER_KIND
  ) {
    addReason(reasons, SEWER_AUDIT_REASONS.familyMismatch)
  }
  if (structure?.id !== descriptor?.id) {
    addReason(reasons, SEWER_AUDIT_REASONS.canonicalIdMismatch)
  }
  if (carriesWetOutput(structure)) addReason(reasons, SEWER_AUDIT_REASONS.wetOutput)

  const profile = structure?.profile
  if (profile?.forcedProfile !== true) {
    addReason(reasons, AUDIT_REASONS.forcedProfileRequired)
  }
  if (
    profile?.rightTurnChance !== SEWER_RIGHT_TURN_CHANCE ||
    !Array.isArray(profile?.zoneBands) ||
    profile.zoneBands.length !== 1 ||
    profile.zoneBands[0]?.id !== ZONE_SEWER
  ) {
    addReason(reasons, SEWER_AUDIT_REASONS.familyMismatch)
  }

  const maxLoops = profile?.maxLoops
  if (
    !Number.isInteger(maxLoops) ||
    maxLoops < 0 ||
    (descriptor?.loopEdges?.length ?? 0) > maxLoops ||
    maxLoops >= descriptor?.eligibleNonTreeLinks
  ) {
    addReason(reasons, SEWER_AUDIT_REASONS.loopBudget)
  }
  validateSewerRaster(structure, descriptorState, reasons)
  validateSewerLighting(structure, reasons)
  if (!hasCanonicalSewerSeams(structure?.seams)) {
    addReason(reasons, SEWER_AUDIT_REASONS.missingSeam)
  }

  const risers = structure?.risers
  const kinds = new Set(descriptor?.modules?.map((module) => module.kind) ?? [])
  if (
    (kinds.has(SEWER_MODULE_MANHOLE_UP) && (!isRecord(risers) || risers.up !== true)) ||
    (kinds.has(SEWER_MODULE_MANHOLE_DOWN) && (!isRecord(risers) || risers.down !== true))
  ) {
    addReason(reasons, SEWER_AUDIT_REASONS.unreachableModule)
  }
}

function auditSewerFixture(fixture) {
  const reasons = new Set()
  const descriptors = Array.isArray(fixture?.descriptors)
    ? fixture.descriptors
    : []
  const structures = Array.isArray(fixture?.sewerStructures)
    ? fixture.sewerStructures
    : []

  if (descriptors.length === 0) {
    addReason(reasons, SEWER_AUDIT_REASONS.orphanDescriptor)
  }

  for (const descriptor of descriptors) {
    const claims = structures.filter((structure) => structure?.descriptor === descriptor)
    if (claims.length === 0) {
      addReason(reasons, SEWER_AUDIT_REASONS.orphanDescriptor)
      continue
    }
    if (claims.length > 1) {
      addReason(reasons, SEWER_AUDIT_REASONS.canonicalIdMismatch)
    }
    const descriptorState = validateSewerDescriptor(descriptor, reasons)
    if (!descriptorState.usable) continue
    for (const structure of claims) {
      validateSewerStructure(structure, descriptor, descriptorState, reasons)
    }
  }
  for (const structure of structures) {
    if (!descriptors.includes(structure?.descriptor)) {
      addReason(reasons, SEWER_AUDIT_REASONS.orphanDescriptor)
    }
  }

  return orderedFixtureReasons(reasons)
}

function makeSewerKindAdapter() {
  return Object.freeze({
    family: MAP_FAMILY_SEWER,
    kind: SEWER_KIND,
    auditFixture: auditSewerFixture,
    auditDescriptor(descriptor) {
      const reasons = new Set()
      validateSewerDescriptor(descriptor, reasons)
      return orderedFixtureReasons(reasons)
    },
  })
}

// Hotel is an office-fabric family: its chunks own explicit mapFamily
// identity, but the multilevel descriptors they stamp carry no family field
// and therefore validate through the office adapter — the same default that
// structureFamily applies at runtime (structures/contract.js). Registration
// audits expect the office adapter namespace for these families rather than
// a parallel hotel adapter set.
const OFFICE_FABRIC_FAMILIES = Object.freeze([
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_HOTEL,
])

const expectedAdapterFamily = (family) =>
  OFFICE_FABRIC_FAMILIES.includes(family) ? MAP_FAMILY_OFFICE : family

const FAMILY_ADAPTERS = Object.freeze({
  [MAP_FAMILY_OFFICE]: makeFamilyAdapter(
    MAP_FAMILY_OFFICE,
    [STRUCTURE_KIND_OFFICE]
  ),
  [MAP_FAMILY_SEWER]: makeFamilyAdapter(MAP_FAMILY_SEWER, [SEWER_KIND]),
  [MAP_FAMILY_TOWER]: makeFamilyAdapter(
    MAP_FAMILY_TOWER,
    [STRUCTURE_KIND_TOWER]
  ),
  [MAP_FAMILY_LATTICE]: makeFamilyAdapter(
    MAP_FAMILY_LATTICE,
    [STRUCTURE_KIND_LATTICE]
  ),
  [MAP_FAMILY_HOTEL]: makeFamilyAdapter(
    MAP_FAMILY_HOTEL,
    [STRUCTURE_KIND_OFFICE]
  ),
})

const KIND_ADAPTERS = Object.freeze({
  [STRUCTURE_KIND_OFFICE]: makeStructureKindAdapter(
    MAP_FAMILY_OFFICE,
    STRUCTURE_KIND_OFFICE
  ),
  [SEWER_KIND]: makeSewerKindAdapter(),
  [STRUCTURE_KIND_TOWER]: makeTowerKindAdapter(),
  [STRUCTURE_KIND_LATTICE]: makeLatticeKindAdapter(),
})

// Family identity and descriptor-kind identity are deliberately separate
// namespaces. Reusing cells, walls, rails, or aperture vocabulary never
// substitutes for either explicit registration.
export const FAMILY_AUDIT_ADAPTERS = Object.freeze({
  families: FAMILY_ADAPTERS,
  kinds: KIND_ADAPTERS,
})

function validVersionRecord(record) {
  return isRecord(record) &&
    Number.isSafeInteger(record.version) &&
    hasText(record.digest)
}

function validatePinNamespace(
  reasons,
  pin,
  candidate,
  missingReason,
  staleReason,
  extraValid = () => true
) {
  if (!isRecord(pin)) {
    addReason(reasons, missingReason)
    return
  }
  if (
    !validVersionRecord(pin) ||
    pin.version !== candidate?.version ||
    !extraValid(pin)
  ) {
    addReason(reasons, staleReason)
  }
}

function exactEvidenceValue(a, b) {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => exactEvidenceValue(value, b[index]))
  }
  if (!isRecord(a) || !isRecord(b)) return false

  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()
  return aKeys.length === bKeys.length &&
    aKeys.every((key, index) =>
      key === bKeys[index] && exactEvidenceValue(a[key], b[key])
    )
}

function validRollbackFamilyList(families) {
  return Array.isArray(families) &&
    families.length > 0 &&
    families.every((family, index) =>
      FAMILY_AUDIT_ORDER.includes(family) &&
      (index === 0 || FAMILY_AUDIT_ORDER.indexOf(family) >
        FAMILY_AUDIT_ORDER.indexOf(families[index - 1]))
    )
}

function hasFoundationContractSet(state) {
  return isRecord(state) &&
    state.selectedFamily === MAP_FAMILY_OFFICE &&
    exactEvidenceValue(state.enabledFamilies, [MAP_FAMILY_OFFICE]) &&
    exactEvidenceValue(state.emittedFamilies, [MAP_FAMILY_OFFICE]) &&
    isRecord(state.pins) &&
    isRecord(state.pins.global) &&
    state.pins.family === null &&
    isRecord(state.pins.maximumHeight) &&
    isRecord(state.corpus) &&
    isRecord(state.contracts) &&
    hasText(state.contracts.pairEnumeration) &&
    hasText(state.contracts.auditSchema)
}

function validRollbackState(state, scope, family) {
  if (
    !validVersionRecord(state) ||
    !validRollbackFamilyList(state.enabledFamilies) ||
    !validRollbackFamilyList(state.emittedFamilies) ||
    !state.enabledFamilies.includes(MAP_FAMILY_OFFICE) ||
    !state.emittedFamilies.includes(MAP_FAMILY_OFFICE) ||
    !state.enabledFamilies.includes(state.selectedFamily) ||
    !exactEvidenceValue(state.enabledFamilies, state.emittedFamilies) ||
    !isRecord(state.pins) ||
    !validVersionRecord(state.pins.global) ||
    state.pins.global.version !== state.version ||
    !isRecord(state.corpus) ||
    state.corpus.version !== state.version ||
    !hasText(state.corpus.profileIdentity) ||
    !hasText(state.corpus.seedDerivation) ||
    !isRecord(state.contracts) ||
    !hasText(state.contracts.auditSchema)
  ) return false

  const maximumHeight = state.pins.maximumHeight
  if (scope === 'foundation') {
    return family === MAP_FAMILY_OFFICE &&
      hasFoundationContractSet(state) &&
      validVersionRecord(maximumHeight) &&
      maximumHeight.version === state.version
  }

  const familyPin = state.pins.family
  if (
    !isRecord(familyPin) ||
    !validVersionRecord(familyPin) ||
    familyPin.family !== family ||
    familyPin.version !== state.version ||
    familyPin.digest !== state.digest ||
    !state.enabledFamilies.includes(family)
  ) return false

  // Families without authored maximum-height output pin that namespace as
  // null rather than as a stale golden.
  if (family === MAP_FAMILY_SEWER || family === MAP_FAMILY_HOTEL) {
    return maximumHeight === null
  }
  return validVersionRecord(maximumHeight) &&
    maximumHeight.version === state.version
}

// Rollback evidence is intentionally metadata-only. `knownPassing` is the
// caller's trusted release record; this seam proves that the proposed restored
// state is that exact record and that its version/pin/corpus contract is whole.
// Synthetic test records exercise the shape but never become release pins.
export function validateRollbackEvidence(evidence) {
  const scope = evidence?.scope
  const family = evidence?.family
  const foundation = scope === 'foundation'

  if (foundation && (
    family !== MAP_FAMILY_OFFICE ||
    !hasFoundationContractSet(evidence?.knownPassing) ||
    !hasFoundationContractSet(evidence?.restored)
  )) {
    return {
      ok: false,
      reasons: [AUDIT_REASONS.partialFoundationRollback],
    }
  }

  const familyScope = scope === 'family' &&
    family !== MAP_FAMILY_OFFICE &&
    FAMILY_AUDIT_ORDER.includes(family)
  const knownPassing = evidence?.knownPassing
  const restored = evidence?.restored
  const current = evidence?.current
  const exactKnownRevision = (foundation || familyScope) &&
    validVersionRecord(current) &&
    validRollbackState(knownPassing, scope, family) &&
    validRollbackState(restored, scope, family) &&
    knownPassing.version < current.version &&
    exactEvidenceValue(restored, knownPassing)

  return exactKnownRevision
    ? { ok: true, reasons: [] }
    : { ok: false, reasons: [AUDIT_REASONS.unknownRollbackRevision] }
}

const HARD_VOID_PLANE_KEYS = Object.freeze(['id', 'family', 'deathYmm'])
const HARD_VOID_OWNERSHIP_KEYS = Object.freeze(['id', 'family', 'lowerCy'])
const RESET_BASELINE_FIELDS = Object.freeze([
  'version',
  'seedText',
  'level',
  'mapFamily',
  'profileIdentity',
  'initialDigest',
])

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return keys.length === expectedKeys.length &&
    expectedKeys.every((key) => hasOwn(value, key))
}

function validCanonicalId(value) {
  return Number.isInteger(value) && value >= 0 && value <= UINT32_MAX
}

function activationHalfReasons(half, family) {
  const reasons = new Set()
  if (!validCanonicalId(half?.id)) {
    addReason(reasons, 'canonical-id-mismatch')
  }
  if (half?.family !== family || !requiresVoidSafety(half?.family)) {
    addReason(reasons, 'family-mismatch')
  }
  if (!Number.isInteger(half?.lowerCy)) {
    addReason(reasons, 'lower-floor-mismatch')
  }

  if (!Array.isArray(half?.cells) || half.cells.length === 0) {
    addReason(reasons, 'cell-mismatch')
    return reasons
  }

  let previous = null
  for (const cell of half.cells) {
    const coordinatesValid = isRecord(cell) &&
      Number.isInteger(cell.lx) &&
      Number.isInteger(cell.lz) &&
      cell.lx >= 0 &&
      cell.lx < CHUNK &&
      cell.lz >= 0 &&
      cell.lz < CHUNK
    if (!coordinatesValid || (previous && (
      previous.lz > cell.lz ||
      (previous.lz === cell.lz && previous.lx >= cell.lx)
    ))) {
      addReason(reasons, 'cell-mismatch')
    }
    if (!Number.isInteger(cell?.deathYmm)) {
      addReason(reasons, 'death-plane-mismatch')
    }
    if (coordinatesValid) previous = cell
  }
  return reasons
}

function addHardVoidPlaneReasons(reasons, family, hardVoidDeath) {
  const halves = hardVoidDeath?.halves
  const up = halves?.lethalVoidUp
  const down = halves?.lethalVoidDown
  const hasBothHalves = isRecord(up) && isRecord(down)

  if (!hasBothHalves) {
    addReason(reasons, VOID_SAFETY_REASONS.missingVoidPlaneHalf)
  }

  const layeredReasons = new Set()
  if (hasBothHalves) {
    for (const reason of activationHalfReasons(up, family)) {
      addReason(layeredReasons, reason)
    }
    for (const reason of activationHalfReasons(down, family)) {
      addReason(layeredReasons, reason)
    }
    addLethalVoidParityReasons(layeredReasons, up, down)
  }

  if (orderedLethalVoidReasons(layeredReasons).some(
    (reason) => reason !== 'void-ownership-mismatch'
  )) {
    addReason(reasons, VOID_SAFETY_REASONS.voidPlaneMismatch)
  }
  if (layeredReasons.has('void-ownership-mismatch')) {
    addReason(reasons, VOID_SAFETY_REASONS.voidOwnershipMismatch)
  }

  const plane = hardVoidDeath?.plane
  let planeMismatch = !hasExactKeys(plane, HARD_VOID_PLANE_KEYS) ||
    !validCanonicalId(plane?.id) ||
    plane?.family !== family ||
    !Number.isInteger(plane?.deathYmm)
  if (hasBothHalves) {
    planeMismatch ||= plane?.id !== up.id ||
      plane?.id !== down.id ||
      plane?.family !== up.family ||
      plane?.family !== down.family ||
      !up.cells?.some((cell) => cell?.deathYmm === plane?.deathYmm) ||
      !down.cells?.some((cell) => cell?.deathYmm === plane?.deathYmm)
  }
  if (planeMismatch) {
    addReason(reasons, VOID_SAFETY_REASONS.voidPlaneMismatch)
  }

  const ownership = hardVoidDeath?.ownership
  let ownershipMismatch = !hasExactKeys(ownership, HARD_VOID_OWNERSHIP_KEYS) ||
    !validCanonicalId(ownership?.id) ||
    ownership?.family !== family ||
    !Number.isInteger(ownership?.lowerCy)
  if (hasBothHalves) {
    ownershipMismatch ||= ownership?.id !== up.id ||
      ownership?.id !== down.id ||
      ownership?.family !== up.family ||
      ownership?.family !== down.family ||
      ownership?.lowerCy !== up.lowerCy ||
      ownership?.lowerCy !== down.lowerCy
  }
  if (ownershipMismatch) {
    addReason(reasons, VOID_SAFETY_REASONS.voidOwnershipMismatch)
  }
}

function validResetBaseline(baseline, family, profileIdentity) {
  return isRecord(baseline) &&
    Number.isSafeInteger(baseline.version) &&
    hasText(baseline.seedText) &&
    Number.isSafeInteger(baseline.level) &&
    baseline.mapFamily === family &&
    hasText(baseline.profileIdentity) &&
    (!hasText(profileIdentity) || baseline.profileIdentity === profileIdentity) &&
    hasText(baseline.initialDigest)
}

function addDeterministicResetReasons(reasons, evidence, deterministicReset) {
  if (!isRecord(deterministicReset)) {
    addReason(reasons, VOID_SAFETY_REASONS.missingDeterministicResetEvidence)
    return
  }
  if (deterministicReset.ok !== true) {
    addReason(reasons, VOID_SAFETY_REASONS.deterministicResetFailed)
  }

  const before = deterministicReset.before
  const after = deterministicReset.after
  const family = evidence?.family
  const profileIdentity = evidence?.corpus?.profileIdentity
  if (
    !validResetBaseline(before, family, profileIdentity) ||
    !validResetBaseline(after, family, profileIdentity) ||
    RESET_BASELINE_FIELDS.some((field) => before?.[field] !== after?.[field])
  ) {
    addReason(reasons, VOID_SAFETY_REASONS.resetBaselineMismatch)
  }
}

// Produce the single release-safety verdict consumed by activation validation.
// Disabled families and families without authored lethal planes are deliberately
// outside this gate; malformed exposed-family evidence always fails closed.
export function validateVoidSafetyEligibility(evidence) {
  if (evidence?.enabled !== true || !requiresVoidSafety(evidence?.family)) {
    return { ok: true, reasons: [] }
  }

  const reasons = new Set()
  const hardVoidDeath = evidence?.voidSafety?.hardVoidDeath
  if (!isRecord(hardVoidDeath)) {
    addReason(reasons, VOID_SAFETY_REASONS.missingHardVoidDeathEvidence)
  } else {
    if (hardVoidDeath.ok !== true || hardVoidDeath.deathReason !== 'void') {
      addReason(reasons, VOID_SAFETY_REASONS.hardVoidDeathFailed)
    }
    if (hardVoidDeath.callbackCount !== 1) {
      addReason(reasons, VOID_SAFETY_REASONS.voidDeathNotIdempotent)
    }
    addHardVoidPlaneReasons(reasons, evidence.family, hardVoidDeath)
  }

  addDeterministicResetReasons(
    reasons,
    evidence,
    evidence?.voidSafety?.deterministicReset
  )

  const ordered = VOID_SAFETY_REASON_ORDER.filter((reason) => reasons.has(reason))
  return { ok: ordered.length === 0, reasons: ordered }
}

// Validate one atomic release-evidence set. This function validates metadata;
// it never enables a profile or mutates world-generation configuration.
export function validateActivationEvidence(evidence) {
  const reasons = new Set()
  const previous = evidence?.previous
  const candidate = evidence?.candidate
  const byteChanging = evidence?.byteImpact === 'first-emission' ||
    evidence?.byteImpact === 'changed-output'

  if (
    !validVersionRecord(previous) ||
    !validVersionRecord(candidate) ||
    (byteChanging && (
      candidate.version <= previous.version ||
      candidate.digest === previous.digest
    )) ||
    (!byteChanging && (
      candidate.version !== previous.version ||
      candidate.digest !== previous.digest
    ))
  ) {
    addReason(reasons, AUDIT_REASONS.staleVersion)
  }

  if (
    validVersionRecord(evidence?.released) &&
    evidence.released.version === candidate?.version &&
    evidence.released.digest !== candidate?.digest
  ) {
    addReason(reasons, AUDIT_REASONS.versionReuse)
  }

  validatePinNamespace(
    reasons,
    evidence?.pins?.global,
    candidate,
    AUDIT_REASONS.missingGlobalPin,
    AUDIT_REASONS.staleGlobalPin
  )

  const familyPinRequired = byteChanging &&
    evidence?.enabled === true &&
    evidence?.family !== MAP_FAMILY_OFFICE
  if (familyPinRequired || evidence?.pins?.family != null) {
    validatePinNamespace(
      reasons,
      evidence?.pins?.family,
      candidate,
      AUDIT_REASONS.missingFamilyPin,
      AUDIT_REASONS.staleFamilyPin,
      (pin) => pin.family === evidence?.family &&
        pin.digest === candidate?.digest
    )
  }

  if (evidence?.affectsMaximumHeight === true) {
    validatePinNamespace(
      reasons,
      evidence?.pins?.maximumHeight,
      candidate,
      AUDIT_REASONS.missingMaximumHeight,
      AUDIT_REASONS.staleMaximumHeight
    )
  }

  const corpus = evidence?.corpus
  if (
    !isRecord(corpus) ||
    !Number.isSafeInteger(corpus.version) ||
    !hasText(corpus.profileIdentity) ||
    !hasText(corpus.seedDerivation)
  ) {
    addReason(reasons, AUDIT_REASONS.missingCorpusMetadata)
  } else if (corpus.version !== candidate?.version) {
    addReason(reasons, AUDIT_REASONS.staleCorpusMetadata)
  }

  for (const reason of validateVoidSafetyEligibility(evidence).reasons) {
    addReason(reasons, reason)
  }

  const ordered = orderedActivationReasons(reasons)
  return { ok: ordered.length === 0, reasons: ordered }
}

function cloneRow(row) {
  return {
    ...row,
    pins: isRecord(row?.pins) ? { ...row.pins } : row?.pins,
    corpus: isRecord(row?.corpus) ? structuredClone(row.corpus) : row?.corpus,
  }
}

function hasCorpusRowContract(row, family) {
  return isRecord(row) &&
    row.family === family &&
    typeof row.enabled === 'boolean' &&
    typeof row.forcedProfile === 'boolean' &&
    Number.isSafeInteger(row.generatorVersion) &&
    hasText(row.seedDerivation) &&
    isRecord(row.pins) &&
    isRecord(row.corpus) &&
    (family === MAP_FAMILY_OFFICE || hasText(row.profileIdentity))
}

function profileActivation(enabledProfiles) {
  const enabled = new Map(FAMILY_AUDIT_ORDER.map((family) => [family, false]))
  for (const profile of enabledProfiles ?? []) {
    if (enabled.has(profile?.family)) {
      enabled.set(profile.family, profile.enabled === true)
    }
  }
  // The default office corpus is a mandatory release row even if a malformed
  // caller omits it from the supplied profile projection.
  enabled.set(MAP_FAMILY_OFFICE, true)
  return enabled
}

function hasExactSewerCoverage(moduleCoverage) {
  if (!Array.isArray(moduleCoverage) || moduleCoverage.length !== SEWER_MODULE_KINDS.length) {
    return false
  }
  const coverage = new Set(moduleCoverage)
  return coverage.size === SEWER_MODULE_KINDS.length &&
    SEWER_MODULE_KINDS.every((kind) => coverage.has(kind))
}

function addSewerMetricReasons(reasons, row) {
  const metrics = row?.corpus?.familyMetrics
  const loops = metrics?.loops
  const lights = metrics?.lights
  const seams = metrics?.seams
  const metricShapeValid = isRecord(metrics) &&
    Array.isArray(metrics.moduleCoverage) &&
    Number.isSafeInteger(metrics.deferredModules) &&
    Number.isSafeInteger(metrics.unreachableModules) &&
    isRecord(loops) &&
    Number.isSafeInteger(loops.inserted) &&
    Number.isSafeInteger(loops.budget) &&
    Number.isSafeInteger(loops.eligibleNonTreeLinks) &&
    isRecord(lights) &&
    Number.isSafeInteger(lights.eligible) &&
    Number.isSafeInteger(lights.lit) &&
    Number.isSafeInteger(lights.unlit) &&
    isRecord(seams) &&
    Number.isSafeInteger(metrics.descriptorFailures) &&
    hasOwn(metrics, 'observedRightTurnRate') &&
    Number.isFinite(metrics.observedRightTurnRate)

  if (!metricShapeValid) {
    addReason(reasons, AUDIT_REASONS.missingFamilyMetrics)
    return
  }

  if (
    metrics.deferredModules !== 0 ||
    metrics.moduleCoverage.some((kind) =>
      DEFERRED_SEWER_MODULE_SET.has(kind) || !SEWER_MODULE_SET.has(kind)
    )
  ) {
    addReason(reasons, SEWER_AUDIT_REASONS.deferredModule)
  } else if (!hasExactSewerCoverage(metrics.moduleCoverage)) {
    addReason(reasons, AUDIT_REASONS.missingFamilyMetrics)
  }
  if (metrics.unreachableModules !== 0) {
    addReason(reasons, SEWER_AUDIT_REASONS.unreachableModule)
  }
  if (
    loops.inserted < 0 ||
    loops.budget < 0 ||
    loops.eligibleNonTreeLinks <= 0 ||
    loops.inserted > loops.budget ||
    loops.budget >= loops.eligibleNonTreeLinks ||
    loops.inserted >= loops.eligibleNonTreeLinks
  ) {
    addReason(reasons, SEWER_AUDIT_REASONS.loopBudget)
  }
  if (
    lights.eligible < 0 ||
    lights.lit < 0 ||
    lights.unlit < 0 ||
    lights.lit + lights.unlit !== lights.eligible ||
    (lights.eligible >= 2 && (lights.lit === 0 || lights.unlit === 0))
  ) {
    addReason(reasons, SEWER_AUDIT_REASONS.nonSparseLighting)
  }
  if (!hasCanonicalSewerSeams(seams)) {
    addReason(reasons, SEWER_AUDIT_REASONS.missingSeam)
  }
  if (metrics.descriptorFailures !== 0) {
    addReason(reasons, SEWER_AUDIT_REASONS.orphanDescriptor)
  }
}

function addTowerMetricReasons(reasons, row) {
  const metrics = row?.corpus?.familyMetrics
  if (!isRecord(metrics)) {
    addReason(reasons, AUDIT_REASONS.missingFamilyMetrics)
    return
  }

  const metricShapeValid = Number.isSafeInteger(metrics.participantCardinality) &&
    Number.isSafeInteger(metrics.floorCount) &&
    Number.isSafeInteger(metrics.deckCount) &&
    isRecord(metrics.approaches) &&
    Number.isSafeInteger(metrics.approaches.expected) &&
    Number.isSafeInteger(metrics.approaches.matched) &&
    Number.isSafeInteger(metrics.connectedFloors) &&
    Array.isArray(metrics.socketKinds) &&
    isRecord(metrics.socketCoverage) &&
    Array.isArray(metrics.socketCoverage.anchorFloors) &&
    Number.isSafeInteger(metrics.socketCoverage.bridgeApproaches) &&
    Number.isSafeInteger(metrics.guardFailures) &&
    Number.isSafeInteger(metrics.descriptorFailures) &&
    Number.isSafeInteger(metrics.enclosedTowerSlices) &&
    Number.isSafeInteger(metrics.skybridgeDecks) &&
    isRecord(metrics.voidSafety)
  if (!metricShapeValid) {
    addReason(reasons, AUDIT_REASONS.missingFamilyMetrics)
    return
  }

  if (metrics.participantCardinality !== 2) {
    addReason(reasons, TOWER_AUDIT_REASONS.participantCardinality)
  }
  if (metrics.floorCount !== 3) {
    addReason(reasons, TOWER_AUDIT_REASONS.verticalBand)
  }
  if (metrics.deckCount !== 1 || metrics.skybridgeDecks !== 1) {
    addReason(reasons, TOWER_AUDIT_REASONS.invalidDeck)
  }
  if (metrics.approaches.expected !== 2 || metrics.approaches.matched !== 2) {
    addReason(reasons, TOWER_AUDIT_REASONS.invalidApproach)
  }
  if (metrics.connectedFloors !== 3) {
    addReason(reasons, TOWER_AUDIT_REASONS.floorConnectivity)
  }
  if (!hasExactTowerSocketKinds(metrics.socketKinds)) {
    addReason(reasons, TOWER_AUDIT_REASONS.mixedLandmarkKinds)
  }
  if (
    metrics.socketCoverage.bridgeApproaches !== 2 ||
    metrics.socketCoverage.anchorFloors.length !== 3 ||
    !TOWER_FLOOR_OFFSETS.every((floor) =>
      metrics.socketCoverage.anchorFloors.includes(floor)
    )
  ) {
    addReason(reasons, TOWER_AUDIT_REASONS.missingLandmarkSocket)
  }
  if (metrics.guardFailures !== 0) {
    addReason(reasons, TOWER_AUDIT_REASONS.invalidGuard)
  }
  if (metrics.descriptorFailures !== 0) {
    addReason(reasons, TOWER_AUDIT_REASONS.orphanDescriptor)
  }
  if (metrics.enclosedTowerSlices !== 6) {
    addReason(reasons, TOWER_AUDIT_REASONS.structureIdentity)
  }

  const safetyVerdict = validateVoidSafetyEligibility({
    family: MAP_FAMILY_TOWER,
    enabled: true,
    corpus: { profileIdentity: row?.profileIdentity },
    voidSafety: metrics.voidSafety,
  })
  for (const reason of safetyVerdict.reasons) addReason(reasons, reason)
}

function addLatticeMetricReasons(reasons, row) {
  const metrics = row?.corpus?.familyMetrics
  const backbone = metrics?.backbone
  const cycles = metrics?.cycles
  const orientations = metrics?.orientations
  const verticalConnections = metrics?.verticalConnections
  const stamping = metrics?.stamping
  const exposure = metrics?.exposure
  const cues = metrics?.cues
  const metricShapeValid = isRecord(metrics) &&
    Number.isSafeInteger(metrics.participantCardinality) &&
    isRecord(metrics.districtFootprint) &&
    Number.isSafeInteger(metrics.districtFootprint.x) &&
    Number.isSafeInteger(metrics.districtFootprint.z) &&
    Number.isSafeInteger(metrics.districtCount) &&
    Array.isArray(metrics.floorCoverage) &&
    Number.isSafeInteger(metrics.anchorCount) &&
    isRecord(backbone) &&
    Number.isSafeInteger(backbone.edgeCount) &&
    typeof backbone.connected === 'boolean' &&
    typeof backbone.acyclic === 'boolean' &&
    typeof backbone.minimum === 'boolean' &&
    isRecord(cycles) &&
    Number.isSafeInteger(cycles.inserted) &&
    Number.isSafeInteger(cycles.eligibleNonBackboneLinks) &&
    Number.isFinite(cycles.rate) &&
    isRecord(orientations) &&
    typeof orientations.horizontal === 'boolean' &&
    typeof orientations.vertical === 'boolean' &&
    isRecord(verticalConnections) &&
    typeof verticalConnections.lowerMiddle === 'boolean' &&
    typeof verticalConnections.middleUpper === 'boolean' &&
    isRecord(stamping) &&
    Number.isSafeInteger(stamping.floorSlices) &&
    Number.isSafeInteger(stamping.chamberContexts) &&
    typeof stamping.bridgeSegmentsMatchDescriptor === 'boolean' &&
    Number.isSafeInteger(stamping.enclosedRoomSlices) &&
    isRecord(exposure) &&
    Number.isFinite(exposure.defaultM) &&
    Number.isFinite(exposure.maximumM) &&
    Number.isFinite(exposure.observedMaximumM) &&
    Number.isSafeInteger(exposure.invalidAnchors) &&
    isRecord(cues) &&
    Number.isSafeInteger(cues.minimumRequired) &&
    Number.isSafeInteger(cues.minimumCombined) &&
    Number.isSafeInteger(cues.railPerimeterCells) &&
    Number.isSafeInteger(cues.bridgeSeamCells) &&
    Number.isSafeInteger(metrics.plainWallSideFailures) &&
    Number.isSafeInteger(metrics.guardFailures) &&
    Number.isSafeInteger(metrics.approachFailures) &&
    Number.isSafeInteger(metrics.descriptorFailures) &&
    isRecord(metrics.voidSafety)
  if (!metricShapeValid) {
    addReason(reasons, AUDIT_REASONS.missingFamilyMetrics)
    return
  }

  if (
    metrics.participantCardinality !== 9 ||
    metrics.districtFootprint.x !== 3 ||
    metrics.districtFootprint.z !== 3 ||
    metrics.districtCount !== 1 ||
    metrics.anchorCount !== 25
  ) addReason(reasons, LATTICE_AUDIT_REASONS.bounded)
  if (
    metrics.floorCoverage.length !== 3 ||
    LATTICE_FLOOR_OFFSETS.some(
      (floor) => !metrics.floorCoverage.includes(floor)
    ) ||
    stamping.floorSlices !== 27
  ) addReason(reasons, LATTICE_AUDIT_REASONS.missingFloorAudit)
  if (
    backbone.edgeCount !== 24 ||
    backbone.connected !== true ||
    backbone.acyclic !== true
  ) addReason(reasons, LATTICE_AUDIT_REASONS.disconnectedBackbone)
  if (backbone.minimum !== true) {
    addReason(reasons, LATTICE_AUDIT_REASONS.backboneNotMinimum)
  }
  if (
    cycles.inserted <= 0 ||
    cycles.eligibleNonBackboneLinks <= 0 ||
    cycles.rate !== cycles.inserted / cycles.eligibleNonBackboneLinks ||
    cycles.rate < LATTICE_PROFILE.cycleRate[0] ||
    cycles.rate > LATTICE_PROFILE.cycleRate[1]
  ) addReason(reasons, LATTICE_AUDIT_REASONS.cycleRate)
  if (orientations.horizontal !== true) {
    addReason(reasons, LATTICE_AUDIT_REASONS.missingHorizontalLink)
  }
  if (
    orientations.vertical !== true ||
    verticalConnections.lowerMiddle !== true ||
    verticalConnections.middleUpper !== true
  ) addReason(reasons, LATTICE_AUDIT_REASONS.missingVerticalLink)
  if (
    stamping.chamberContexts !== 25 ||
    stamping.bridgeSegmentsMatchDescriptor !== true
  ) addReason(reasons, LATTICE_AUDIT_REASONS.stampMismatch)
  if (stamping.enclosedRoomSlices !== 0) {
    addReason(reasons, LATTICE_AUDIT_REASONS.enclosedRoomIdentity)
  }
  if (
    exposure.defaultM !== LATTICE_PROFILE.defaultExposureM ||
    exposure.maximumM !== LATTICE_PROFILE.maxExposureM ||
    exposure.observedMaximumM > LATTICE_PROFILE.maxExposureM ||
    exposure.invalidAnchors !== 0
  ) addReason(reasons, LATTICE_AUDIT_REASONS.exposureRange)
  if (cues.railPerimeterCells <= 0 || cues.bridgeSeamCells <= 0) {
    addReason(reasons, LATTICE_AUDIT_REASONS.cueSources)
  }
  if (
    cues.minimumRequired !== LATTICE_PROFILE.minimumCueCells ||
    cues.minimumCombined < LATTICE_PROFILE.minimumCueCells
  ) addReason(reasons, LATTICE_AUDIT_REASONS.cueCount)
  if (metrics.plainWallSideFailures !== 0) {
    addReason(reasons, LATTICE_AUDIT_REASONS.plainWallSides)
  }
  if (metrics.guardFailures !== 0) {
    addReason(reasons, LATTICE_AUDIT_REASONS.invalidGuard)
  }
  if (metrics.approachFailures !== 0) {
    addReason(reasons, LATTICE_AUDIT_REASONS.invalidApproach)
  }
  if (metrics.descriptorFailures !== 0) {
    addReason(reasons, LATTICE_AUDIT_REASONS.orphanDescriptor)
  }

  const safetyVerdict = validateVoidSafetyEligibility({
    family: MAP_FAMILY_LATTICE,
    enabled: true,
    corpus: { profileIdentity: row?.profileIdentity },
    voidSafety: metrics.voidSafety,
  })
  for (const reason of safetyVerdict.reasons) addReason(reasons, reason)
}

function rowReasons({
  family,
  row,
  enabled,
  emissions,
  adapters,
  officeShareFloor,
  officeVersion,
}) {
  const reasons = new Set()
  const auditRequested = emissions.length > 0

  if (!hasCorpusRowContract(row, family)) {
    addReason(reasons, AUDIT_REASONS.missingCorpusMetadata)
  }

  if (enabled || auditRequested) {
    const familyAdapter = adapters?.families?.[family]
    if (!familyAdapter) addReason(reasons, AUDIT_REASONS.missingFamilyAdapter)

    for (const emission of emissions) {
      const kindAdapter = adapters?.kinds?.[emission?.kind]
      if (
        !kindAdapter ||
        kindAdapter.family !== expectedAdapterFamily(family) ||
        (familyAdapter && !familyAdapter.kinds.includes(emission?.kind))
      ) {
        addReason(reasons, AUDIT_REASONS.missingKindAdapter)
        continue
      }
      if (!familyAdapter) continue
      for (const fixture of emission.fixtures ?? []) {
        for (const reason of kindAdapter.auditFixture(fixture)) {
          addReason(reasons, reason)
        }
      }
    }

    if (enabled && familyAdapter) {
      for (const expectedKind of familyAdapter.kinds) {
        if (!emissions.some((emission) => emission?.kind === expectedKind)) {
          addReason(reasons, AUDIT_REASONS.missingKindAdapter)
        }
      }
    }

    if (family === MAP_FAMILY_SEWER) {
      const sewerEmissions = emissions
        .filter((emission) => emission?.kind === SEWER_KIND)
      const sewerFixtures = sewerEmissions
        .flatMap((emission) => emission.fixtures ?? [])
      if (sewerEmissions.length > 0 && sewerFixtures.length === 0) {
        addReason(reasons, SEWER_AUDIT_REASONS.orphanDescriptor)
      }
      if (row?.forcedProfile !== true) {
        addReason(reasons, AUDIT_REASONS.forcedProfileRequired)
      }
      addSewerMetricReasons(reasons, row)
    }
    if (family === MAP_FAMILY_TOWER) {
      const towerEmissions = emissions.filter(
        (emission) => emission?.kind === STRUCTURE_KIND_TOWER
      )
      const completeTowerAudit = towerEmissions.some((emission) =>
        Array.isArray(emission?.socketKinds)
      )
      if (completeTowerAudit) {
        const towerKindAdapter = adapters?.kinds?.[STRUCTURE_KIND_TOWER]
        if (
          !hasExactTowerSocketKinds(towerKindAdapter?.socketKinds) ||
          towerEmissions.some((emission) =>
            !hasExactTowerSocketKinds(emission.socketKinds)
          )
        ) {
          addReason(reasons, AUDIT_REASONS.missingKindAdapter)
        }
        if (towerEmissions.flatMap((emission) => emission.fixtures ?? []).length === 0) {
          addReason(reasons, TOWER_AUDIT_REASONS.orphanDescriptor)
        }
        if (row?.forcedProfile !== true) {
          addReason(reasons, AUDIT_REASONS.forcedProfileRequired)
        }
        addTowerMetricReasons(reasons, row)
      }
    }
    if (family === MAP_FAMILY_LATTICE) {
      const latticeEmissions = emissions.filter(
        (emission) => emission?.kind === STRUCTURE_KIND_LATTICE
      )
      const latticeKindAdapter = adapters?.kinds?.[STRUCTURE_KIND_LATTICE]
      const dimensionsValid = Array.isArray(latticeKindAdapter?.auditDimensions) &&
        latticeKindAdapter.auditDimensions.length === LATTICE_AUDIT_DIMENSIONS.length &&
        LATTICE_AUDIT_DIMENSIONS.every(
          (dimension, index) => latticeKindAdapter.auditDimensions[index] === dimension
        ) &&
        latticeEmissions.every((emission) =>
          Array.isArray(emission?.auditDimensions) &&
          emission.auditDimensions.length === LATTICE_AUDIT_DIMENSIONS.length &&
          LATTICE_AUDIT_DIMENSIONS.every(
            (dimension, index) => emission.auditDimensions[index] === dimension
          )
        )
      if (!dimensionsValid) addReason(reasons, AUDIT_REASONS.missingKindAdapter)
      if (latticeEmissions.flatMap((emission) => emission.fixtures ?? []).length === 0) {
        addReason(reasons, LATTICE_AUDIT_REASONS.orphanDescriptor)
      }
      if (row?.forcedProfile !== true) {
        addReason(reasons, AUDIT_REASONS.forcedProfileRequired)
      }

      const suppliedMetrics = row?.corpus?.familyMetrics
      if (!isRecord(suppliedMetrics)) {
        addReason(reasons, AUDIT_REASONS.missingFamilyMetrics)
      } else if (typeof latticeKindAdapter?.auditCorpus !== 'function') {
        addReason(reasons, AUDIT_REASONS.missingKindAdapter)
      } else {
        const corpusAudit = latticeKindAdapter.auditCorpus(
          latticeEmissions.flatMap((emission) => emission.fixtures ?? []),
          { voidSafety: suppliedMetrics.voidSafety }
        )
        if (corpusAudit.reasons.length === 0 && corpusAudit.metrics) {
          row.corpus.familyMetrics = corpusAudit.metrics
          addLatticeMetricReasons(reasons, row)
        }
      }
    }
  }

  if (enabled) {
    if (family === MAP_FAMILY_OFFICE) {
      if (row?.pins?.global !== true) {
        addReason(reasons, AUDIT_REASONS.missingGlobalPin)
      }
      if (row?.pins?.maximumHeight !== true) {
        addReason(reasons, AUDIT_REASONS.missingMaximumHeight)
      }
      if (
        !Number.isFinite(row?.corpus?.officeShare) ||
        row.corpus.officeShare < officeShareFloor
      ) {
        addReason(reasons, AUDIT_REASONS.officeShareBelowFloor)
      }
    } else {
      if (row?.pins?.family !== true) {
        addReason(reasons, AUDIT_REASONS.missingFamilyPin)
      }
      if (
        (family === MAP_FAMILY_TOWER || family === MAP_FAMILY_LATTICE) &&
        row?.pins?.maximumHeight !== true
      ) {
        addReason(reasons, AUDIT_REASONS.missingMaximumHeight)
      }
      if (
        Number.isSafeInteger(officeVersion) &&
        Number.isSafeInteger(row?.generatorVersion) &&
        row.generatorVersion !== officeVersion
      ) {
        addReason(reasons, AUDIT_REASONS.staleVersion)
      }
    }
  }

  return [...reasons]
}

export function auditFamilyCompleteness(
  enabledProfiles,
  emittedKinds,
  {
    adapters = FAMILY_AUDIT_ADAPTERS,
    familyRows = [],
    officeShareFloor = 0.75,
  } = {}
) {
  const enabled = profileActivation(enabledProfiles)
  const rowsByFamily = new Map()
  for (const row of familyRows ?? []) {
    if (FAMILY_AUDIT_ORDER.includes(row?.family) && !rowsByFamily.has(row.family)) {
      rowsByFamily.set(row.family, cloneRow(row))
    }
  }

  const topReasons = []
  for (const family of FAMILY_AUDIT_ORDER) {
    if (enabled.get(family) && !rowsByFamily.has(family)) {
      topReasons.push(missingFamilyRowReason(family))
    }
  }

  const emissionsByFamily = new Map(
    FAMILY_AUDIT_ORDER.map((family) => [family, []])
  )
  const orderedEmissions = [...(emittedKinds ?? [])].sort((a, b) => {
    const familyOrder = FAMILY_AUDIT_ORDER.indexOf(a?.family) -
      FAMILY_AUDIT_ORDER.indexOf(b?.family)
    if (familyOrder !== 0) return familyOrder
    return String(a?.kind ?? '').localeCompare(String(b?.kind ?? ''))
  })
  for (const emission of orderedEmissions) {
    if (emissionsByFamily.has(emission?.family)) {
      emissionsByFamily.get(emission.family).push(emission)
    }
  }

  const officeVersion = rowsByFamily.get(MAP_FAMILY_OFFICE)?.generatorVersion
  const rows = FAMILY_AUDIT_ORDER
    .filter((family) => rowsByFamily.has(family))
    .map((family) => {
      const row = rowsByFamily.get(family)
      const reasons = rowReasons({
        family,
        row,
        enabled: enabled.get(family),
        emissions: emissionsByFamily.get(family),
        adapters,
        officeShareFloor,
        officeVersion,
      })
      return {
        ...row,
        verdict: { ok: reasons.length === 0, reasons },
      }
    })

  return {
    ok: topReasons.length === 0 && rows.every((row) => row.verdict.ok),
    reasons: topReasons,
    familyRows: rows,
  }
}

function chunkValues(chunks) {
  if (chunks instanceof Map) return chunks.values()
  if (Array.isArray(chunks)) return chunks.values()
  return chunks?.[Symbol.iterator]?.() ?? [][Symbol.iterator]()
}

function localLatticeEdgeState(data, axis, line, cell) {
  return axis === 'v'
    ? {
        wall: data.vAt(line, cell),
        passage: data.passageVAt(line, cell),
        feature: data.wallFeatureVAt(line, cell),
      }
    : {
        wall: data.hAt(cell, line),
        passage: data.passageHAt(cell, line),
        feature: data.wallFeatureHAt(cell, line),
      }
}

function bestPartialLatticeChamber(data, descriptor) {
  let best = null
  for (let z = 0; z <= CHUNK - 4; z++) {
    for (let x = 0; x <= CHUNK - 4; x++) {
      const sides = [
        Array.from({ length: 3 }, (_, offset) => ['h', z, x + offset]),
        Array.from({ length: 3 }, (_, offset) => ['v', x + 3, z + offset]),
        Array.from({ length: 3 }, (_, offset) => ['h', z + 3, x + offset]),
        Array.from({ length: 3 }, (_, offset) => ['v', x, z + offset]),
      ]
      let rails = 0
      let seams = 0
      let plainSides = 0
      let owned = 0
      for (let lz = z; lz < z + 3; lz++) {
        for (let lx = x; lx < x + 3; lx++) {
          if (data.spaceId[cIdx(lx, lz)] === descriptor.id) owned++
        }
      }
      for (const side of sides) {
        let plainCells = 0
        for (const [axis, line, cell] of side) {
          const state = localLatticeEdgeState(data, axis, line, cell)
          if (
            state.wall === 1 &&
            state.passage === PASSAGE_WALL &&
            state.feature === WALL_RAIL
          ) rails++
          if (state.wall === 0 && state.passage === PASSAGE_WIDE) seams++
          if (state.wall === 1 && state.feature === WALL_PLAIN) plainCells++
        }
        if (plainCells >= 2) plainSides++
      }
      const candidate = { owned, rails, seams, plainSides, combined: rails + seams }
      if (
        !best ||
        candidate.owned > best.owned ||
        (candidate.owned === best.owned && candidate.combined > best.combined) ||
        (candidate.owned === best.owned && candidate.combined === best.combined &&
          candidate.plainSides > best.plainSides)
      ) best = candidate
    }
  }
  return best ?? { rails: 0, seams: 0, plainSides: 0, combined: 0 }
}

function partialLatticeGuardGap(data) {
  const slice = data.structureDown ?? data.structureUp
  const cells = slice?.bridgeCells
  if (!Array.isArray(cells) || cells.length < 2) return false
  const xs = [...new Set(cells.map(({ lx }) => lx))]
  const zs = [...new Set(cells.map(({ lz }) => lz))]
  const axis = zs.length === 1 ? 'h' : xs.length === 1 ? 'v' : null
  if (!axis) return false
  const span = (axis === 'h' ? xs : zs).sort((a, b) => a - b)
  const patterns = []
  for (let line = 0; line < CHUNK; line++) {
    const states = span.map((cell) => localLatticeEdgeState(data, axis, line, cell))
    patterns.push({
      rails: states.filter((state) =>
        state.wall === 1 &&
        state.passage === PASSAGE_WALL &&
        state.feature === WALL_RAIL
      ).length,
      gaps: states.filter((state) =>
        state.wall === 0 && state.passage === PASSAGE_WIDE
      ).length,
    })
  }
  const hasCompleteGuard = patterns.some(({ rails }) => rails === span.length)
  if (hasCompleteGuard && patterns.some(({ rails, gaps }) =>
    rails === span.length - 1 && gaps === 1
  )) return true
  return false
}

function auditPartialLatticeGroup(descriptor, chunks) {
  const reasons = []
  const exposures = descriptor.anchors?.map((anchor) =>
    latticeEffectiveExposureM(anchor, LATTICE_PROFILE)
  ) ?? []
  if (
    exposures.length !== 25 ||
    exposures.some((value) =>
      !Number.isFinite(value) || value < 0 || value > LATTICE_PROFILE.maxExposureM
    )
  ) reasons.push(LATTICE_AUDIT_REASONS.exposureRange)

  const chambers = chunks.map((data) => bestPartialLatticeChamber(data, descriptor))
  const minimumCombined = Math.min(...chambers.map(({ combined }) => combined))
  const maximumPlainWallSides = Math.max(...chambers.map(({ plainSides }) => plainSides))
  const minimumRails = Math.min(...chambers.map(({ rails }) => rails))
  const minimumSeams = Math.min(...chambers.map(({ seams }) => seams))
  if (maximumPlainWallSides >= 3) {
    reasons.push(LATTICE_AUDIT_REASONS.plainWallSides)
  } else if (minimumRails <= 0 || minimumSeams <= 0) {
    reasons.push(LATTICE_AUDIT_REASONS.cueSources)
  } else if (minimumCombined < LATTICE_PROFILE.minimumCueCells) {
    reasons.push(LATTICE_AUDIT_REASONS.cueCount)
  } else if (chunks.some(partialLatticeGuardGap)) {
    reasons.push(LATTICE_AUDIT_REASONS.invalidGuard)
  }

  return {
    reasons: [...new Set(reasons)],
    metrics: {
      anchorCount: descriptor.anchors?.length ?? 0,
      floorCoverage: [...new Set(chunks.map((data) => data.cy - descriptor.baseCy))]
        .sort((a, b) => a - b),
      horizontalBridges: descriptor.edges?.filter(({ role }) => role !== 'vertical').length ?? 0,
      verticalConnectors: descriptor.verticalLinks?.length ?? 0,
      defaultExposureM: LATTICE_PROFILE.defaultExposureM,
      maximumExposureM: Math.max(...exposures),
      minimumCombinedCueCells: minimumCombined,
      maximumPlainWallSides,
      enclosedRoomSlices: LATTICE_ROOM_FIELDS.some((field) => hasOwn(descriptor, field))
        ? chunks.length
        : 0,
    },
  }
}

// Layered audits use this narrow registration pass in addition to their raster
// and structure-group checks. It proves explicit family/kind coverage without
// pretending that one streamed patch is a complete release corpus.
export function auditChunkFamilyRegistrations(
  chunks,
  adapters = FAMILY_AUDIT_ADAPTERS
) {
  const familyCounts = {}
  const kindCounts = {}
  const landmarkKindCounts = {}
  const failures = []
  const failureKeys = new Set()
  const towerGroups = new Map()
  const latticeGroups = new Map()
  let latticeMetrics = null

  const fail = (family, kind, reason) => {
    const key = `${family}:${kind ?? ''}:${reason}`
    if (failureKeys.has(key)) return
    failureKeys.add(key)
    failures.push({ family, kind, reason })
  }

  for (const data of chunkValues(chunks)) {
    // ChunkData owns explicit family identity. Missing identity must not be
    // reinterpreted from reused office cells or descriptor vocabulary.
    const family = data?.mapFamily
    familyCounts[family] = (familyCounts[family] ?? 0) + 1
    if (!adapters?.families?.[family]) {
      fail(family, null, AUDIT_REASONS.missingFamilyAdapter)
    }

    const sewerDescriptor = data?.sewerDescriptor
    if (family === MAP_FAMILY_SEWER || sewerDescriptor != null) {
      if (sewerDescriptor == null) {
        fail(family, SEWER_KIND, SEWER_AUDIT_REASONS.orphanDescriptor)
      } else {
        kindCounts[SEWER_KIND] = (kindCounts[SEWER_KIND] ?? 0) + 1
        const familyAdapter = adapters?.families?.[family]
        const auditAdapter = adapters?.kinds?.[SEWER_KIND]
        if (
          family !== MAP_FAMILY_SEWER ||
          !familyAdapter?.kinds?.includes(SEWER_KIND) ||
          !auditAdapter ||
          auditAdapter.family !== family
        ) {
          fail(family, SEWER_KIND, AUDIT_REASONS.missingKindAdapter)
        } else {
          for (const reason of auditAdapter.auditDescriptor(sewerDescriptor)) {
            fail(family, SEWER_KIND, reason)
          }
        }
      }
    }

    const structureDescriptor = data?.structure
    if (!structureDescriptor) continue
    const structureAdapter = structureAdapterFor(structureDescriptor)
    const structureKind = structureAdapter?.kind ?? null
    if (structureKind !== null) {
      kindCounts[structureKind] = (kindCounts[structureKind] ?? 0) + 1
    }
    const structureAuditAdapter = structureKind === null
      ? null
      : adapters?.kinds?.[structureKind]
    const structureFamilyAdapter = adapters?.families?.[family]
    // Office-fabric chunks (office, hotel) stamp family-less descriptors that
    // resolve to the office adapter; every other family must match its own
    // adapter namespace exactly.
    if (
      !structureAdapter ||
      structureAdapter.family !== expectedAdapterFamily(family) ||
      !structureFamilyAdapter?.kinds?.includes(structureKind) ||
      !structureAuditAdapter ||
      structureAuditAdapter.family !== expectedAdapterFamily(family)
    ) {
      fail(family, structureKind, AUDIT_REASONS.missingKindAdapter)
      continue
    }

    if (family === MAP_FAMILY_TOWER && structureKind === STRUCTURE_KIND_TOWER) {
      let group = towerGroups.get(structureDescriptor.id)
      if (!group) {
        group = { descriptor: structureDescriptor, chunks: [], audited: false }
        towerGroups.set(structureDescriptor.id, group)
      } else if (JSON.stringify(group.descriptor) !== JSON.stringify(structureDescriptor)) {
        fail(family, structureKind, TOWER_AUDIT_REASONS.canonicalIdMismatch)
      }
      group.chunks.push(data)

      const completeDescriptor = hasOwn(structureDescriptor, 'levelCount') ||
        hasOwn(structureDescriptor, 'decks') ||
        hasOwn(structureDescriptor, 'landmarkSockets')
      if (completeDescriptor && !group.audited) {
        group.audited = true
        if (!hasExactTowerSocketKinds(structureAuditAdapter.socketKinds)) {
          fail(family, structureKind, AUDIT_REASONS.missingKindAdapter)
        }
        for (const reason of structureAuditAdapter.auditDescriptor(structureDescriptor)) {
          fail(family, structureKind, reason)
        }
        for (const socket of structureDescriptor.landmarkSockets ?? []) {
          if (!structureAuditAdapter.socketKinds.includes(socket?.kind)) continue
          landmarkKindCounts[socket.kind] = (landmarkKindCounts[socket.kind] ?? 0) + 1
        }
      }
    }
    if (
      family === MAP_FAMILY_LATTICE &&
      structureKind === STRUCTURE_KIND_LATTICE &&
      Array.isArray(structureDescriptor.anchors) &&
      Array.isArray(structureDescriptor.edges)
    ) {
      let group = latticeGroups.get(structureDescriptor.id)
      if (!group) {
        group = { descriptor: structureDescriptor, chunks: [] }
        latticeGroups.set(structureDescriptor.id, group)
      } else if (JSON.stringify(group.descriptor) !== JSON.stringify(structureDescriptor)) {
        fail(family, structureKind, LATTICE_AUDIT_REASONS.canonicalIdMismatch)
      }
      group.chunks.push(data)
    }
  }

  for (const { descriptor, chunks: towerChunks } of towerGroups.values()) {
    const expectedKeys = towerSliceCoordinates(descriptor).map(
      ({ cx, cy, cz }) => towerChunkKey(cx, cy, cz)
    )
    const loadedKeys = new Set(towerChunks.map((data) =>
      towerChunkKey(data.cx, data.cy, data.cz)
    ))
    if (
      expectedKeys.length !== 6 ||
      expectedKeys.some((key) => !loadedKeys.has(key))
    ) continue

    const reasons = new Set()
    validateTowerChunkStamp(towerChunks, descriptor, reasons)
    for (const reason of orderedFixtureReasons(reasons)) {
      fail(MAP_FAMILY_TOWER, STRUCTURE_KIND_TOWER, reason)
    }
  }

  for (const { descriptor, chunks: latticeChunks } of latticeGroups.values()) {
    const expectedKeys = latticeSliceCoordinates(descriptor).map(
      ({ cx, cy, cz }) => latticeChunkKey(cx, cy, cz)
    )
    const loadedKeys = new Set(latticeChunks.map((data) =>
      latticeChunkKey(data.cx, data.cy, data.cz)
    ))
    const complete = expectedKeys.length === 27 &&
      expectedKeys.every((key) => loadedKeys.has(key))
    const result = complete
      ? latticeFixtureAudit({ chunks: latticeChunks })
      : auditPartialLatticeGroup(descriptor, latticeChunks)
    for (const reason of result.reasons) {
      fail(MAP_FAMILY_LATTICE, STRUCTURE_KIND_LATTICE, reason)
    }
    if (!latticeMetrics && result.metrics) {
      latticeMetrics = complete
        ? {
            anchorCount: result.metrics.anchorCount,
            floorCoverage: result.metrics.floorCoverage,
            horizontalBridges: descriptor.edges.filter(({ role }) => role !== 'vertical').length,
            verticalConnectors: descriptor.verticalLinks.length,
            defaultExposureM: result.metrics.exposure.defaultM,
            maximumExposureM: result.metrics.exposure.observedMaximumM,
            minimumCombinedCueCells: result.metrics.cues.minimumCombined,
            maximumPlainWallSides: result.metrics.plainWallSideFailures === 0 ? 2 : 3,
            enclosedRoomSlices: result.metrics.stamping.enclosedRoomSlices,
          }
        : result.metrics
    }
  }

  failures.sort((a, b) => {
    const familyOrder = FAMILY_AUDIT_ORDER.indexOf(a.family) -
      FAMILY_AUDIT_ORDER.indexOf(b.family)
    if (familyOrder !== 0) return familyOrder
    const kindOrder = String(a.kind ?? '').localeCompare(String(b.kind ?? ''))
    return kindOrder || a.reason.localeCompare(b.reason)
  })

  const orderedFamilyCounts = {}
  for (const family of FAMILY_AUDIT_ORDER) {
    if (familyCounts[family] !== undefined) {
      orderedFamilyCounts[family] = familyCounts[family]
    }
  }
  for (const family of Object.keys(familyCounts).sort()) {
    if (!(family in orderedFamilyCounts)) {
      orderedFamilyCounts[family] = familyCounts[family]
    }
  }

  const orderedKindCounts = {}
  for (const kind of Object.keys(kindCounts).sort()) {
    orderedKindCounts[kind] = kindCounts[kind]
  }

  const orderedLandmarkKindCounts = {}
  for (const kind of Object.keys(landmarkKindCounts).sort()) {
    orderedLandmarkKindCounts[kind] = landmarkKindCounts[kind]
  }

  return {
    ok: failures.length === 0,
    familyCounts: orderedFamilyCounts,
    kindCounts: orderedKindCounts,
    landmarkKindCounts: orderedLandmarkKindCounts,
    latticeMetrics,
    failures,
  }
}
