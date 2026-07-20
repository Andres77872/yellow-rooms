import { CHUNK } from '../constants.js'
import { hash2i, hash3i } from '../core/hash.js'
import { layerSeed } from '../layerSeed.js'
import { deepFreeze } from '../mapFamily.js'
import { MAP_FAMILY_TOWER } from '../mapTypes.js'
import {
  MAX_STRUCTURE_TOP_CY,
  STRUCTURE_VERTICAL_PERIOD,
  bandBaseAtLevel as sharedBandBaseAtLevel,
  bandIndexAtBase as sharedBandIndexAtBase,
  districtCoordinate as sharedDistrictCoordinate,
  plannerHash,
  polygonCandidates,
} from './districtBand.js'

export const TOWER_STRUCTURE_KIND = 'towerSkybridge'

export const TOWER_FLOOR_OFFSETS = Object.freeze([0, 1, 2])

export const TOWER_LANDMARK_SOCKET_KINDS = Object.freeze([
  'signage',
  'clock',
  'litAccent',
  'door',
  'fixture',
])

export const TOWER_NETWORK_FIELDS = Object.freeze([
  'networkId',
  'networkEdges',
  'crossDistrictLinks',
  'linkedStructureIds',
])

export const towerParticipantKey = (participant) =>
  `${participant?.cx},${participant?.cz}`

export const towerChunkKey = (cx, cy, cz) => `${cx},${cy},${cz}`

export const sameTowerCell = (left, right) =>
  left?.gx === right?.gx && left?.gz === right?.gz

export function towerDeckEndpoints(structure) {
  const cells = structure?.decks?.[0]?.globalCells
  return [cells?.[0], cells?.at(-1)]
}

export function towerSocketBelongsToChunk(socket, chunk) {
  return socket?.cy === chunk?.cy &&
    Number.isInteger(socket.gx) &&
    Number.isInteger(socket.gz) &&
    Math.floor(socket.gx / CHUNK) === chunk?.cx &&
    Math.floor(socket.gz / CHUNK) === chunk?.cz
}

// Canonical Tower volume traversal is floor-major, with each floor retaining
// the descriptor's already-canonical (cz,cx) participant order. Runtime queue,
// audit, and focused proofs consume this helper rather than inventing a second
// ordering for the same finite six slices.
export function towerSliceCoordinates(structure) {
  if (
    !Number.isInteger(structure?.baseCy) ||
    !Array.isArray(structure?.participants)
  ) return []
  return TOWER_FLOOR_OFFSETS.flatMap((offset) =>
    structure.participants.map(({ cx, cz }) => ({
      cx,
      cy: structure.baseCy + offset,
      cz,
    }))
  )
}

export function hasExactTowerSocketKinds(kinds) {
  return Array.isArray(kinds) &&
    kinds.length === TOWER_LANDMARK_SOCKET_KINDS.length &&
    TOWER_LANDMARK_SOCKET_KINDS.every((kind) => kinds.includes(kind)) &&
    new Set(kinds).size === TOWER_LANDMARK_SOCKET_KINDS.length
}

// These are planner internals, not profile cadence promises. A Tower descriptor
// always remains one finite adjacent pair across three floors regardless of how
// many independent districts can be recovered elsewhere in the world.
const DISTRICT_CHUNKS = 4
const VERTICAL_PERIOD = STRUCTURE_VERTICAL_PERIOD
const LONG_SPAN = CHUNK + 8
const SHORT_SPAN = 6
const TOWER_FIXTURE_LAMP_STEP = 4
const TOWER_FIXTURE_LAMP_SALT = 0x2f61

// Every independent choice owns a fixed stream. Adding another authored choice
// therefore cannot consume or reorder randomness used by an existing field.
const SALTS = Object.freeze({
  verticalPhase: 0x745001,
  axis: 0x745002,
  pair: 0x745003,
  longOffset: 0x745004,
  shortOffset: 0x745005,
  deckLine: 0x745006,
  id: 0x745007,
  linkParticipants: 0x745008,
  signage: 0x745101,
  clock: 0x745102,
  litAccent: 0x745103,
  door: 0x745104,
  fixture: 0x745105,
})

const PAIR_ENUMERATION_CONFIG = Object.freeze({
  districtChunks: DISTRICT_CHUNKS,
})

function validProfile(profile) {
  return profile?.family === MAP_FAMILY_TOWER &&
    profile.enabled === true &&
    profile.levels === 3 &&
    profile.participants === 2 &&
    profile.skybridgeLevelOffset === 1
}

function districtCoordinate(chunkCoordinate) {
  return sharedDistrictCoordinate(chunkCoordinate, DISTRICT_CHUNKS)
}

function bandBaseAtLevel(seed, districtX, districtZ, levelCy) {
  return sharedBandBaseAtLevel(
    seed,
    SALTS.verticalPhase,
    districtX,
    districtZ,
    levelCy,
    VERTICAL_PERIOD
  )
}

function bandIndexAtBase(seed, districtX, districtZ, baseCy) {
  return sharedBandIndexAtBase(
    seed,
    SALTS.verticalPhase,
    districtX,
    districtZ,
    baseCy,
    VERTICAL_PERIOD
  )
}

function footprintBounds(seed, districtX, districtZ, bandIndex, anchor, bridgeAxis) {
  const longStartSlots = CHUNK * 2 - LONG_SPAN - 1
  const shortStartSlots = CHUNK - SHORT_SPAN - 1
  const longOffset = 1 + (
    plannerHash(seed, SALTS.longOffset, districtX, bandIndex, districtZ) %
    longStartSlots
  )
  const shortOffset = 1 + (
    plannerHash(seed, SALTS.shortOffset, districtX, bandIndex, districtZ) %
    shortStartSlots
  )
  const originX = anchor.cx * CHUNK
  const originZ = anchor.cz * CHUNK

  if (bridgeAxis === 'x') {
    return {
      x0: originX + longOffset,
      z0: originZ + shortOffset,
      x1: originX + longOffset + LONG_SPAN - 1,
      z1: originZ + shortOffset + SHORT_SPAN - 1,
    }
  }
  return {
    x0: originX + shortOffset,
    z0: originZ + longOffset,
    x1: originX + shortOffset + SHORT_SPAN - 1,
    z1: originZ + longOffset + LONG_SPAN - 1,
  }
}

function deckForBounds(seed, districtX, districtZ, bandIndex, baseCy, bridgeAxis, bounds) {
  const shortStart = bridgeAxis === 'x' ? bounds.z0 : bounds.x0
  const centerLines = [shortStart + 2, shortStart + 3]
  const lineIndex = plannerHash(
    seed,
    SALTS.deckLine,
    districtX,
    bandIndex,
    districtZ
  ) % centerLines.length
  const globalBridgeLine = centerLines[lineIndex]
  const globalBounds = bridgeAxis === 'x'
    ? {
        x0: bounds.x0,
        z0: globalBridgeLine,
        x1: bounds.x1,
        z1: globalBridgeLine,
      }
    : {
        x0: globalBridgeLine,
        z0: bounds.z0,
        x1: globalBridgeLine,
        z1: bounds.z1,
      }
  const globalCells = []
  if (bridgeAxis === 'x') {
    for (let gx = bounds.x0; gx <= bounds.x1; gx++) {
      globalCells.push({ gx, gz: globalBridgeLine })
    }
  } else {
    for (let gz = bounds.z0; gz <= bounds.z1; gz++) {
      globalCells.push({ gx: globalBridgeLine, gz })
    }
  }

  return {
    levelCy: baseCy + 1,
    lowerCy: baseCy,
    globalBridgeLine,
    globalBounds,
    globalCells,
  }
}

function localAxisRange(participant, bounds, bridgeAxis) {
  const chunkLongOrigin = bridgeAxis === 'x'
    ? participant.cx * CHUNK
    : participant.cz * CHUNK
  const chunkShortOrigin = bridgeAxis === 'x'
    ? participant.cz * CHUNK
    : participant.cx * CHUNK
  const globalLongMin = bridgeAxis === 'x' ? bounds.x0 : bounds.z0
  const globalLongMax = bridgeAxis === 'x' ? bounds.x1 : bounds.z1
  const globalShortMin = bridgeAxis === 'x' ? bounds.z0 : bounds.x0
  const globalShortMax = bridgeAxis === 'x' ? bounds.z1 : bounds.x1
  return {
    longMin: Math.max(0, globalLongMin - chunkLongOrigin),
    longMax: Math.min(CHUNK - 1, globalLongMax - chunkLongOrigin),
    shortMin: Math.max(0, globalShortMin - chunkShortOrigin),
    shortMax: Math.min(CHUNK - 1, globalShortMax - chunkShortOrigin),
  }
}

function stairDescriptor(participant, participantIndex, bridgeAxis, bounds) {
  const range = localAxisRange(participant, bounds, bridgeAxis)
  const firstParticipant = participantIndex === 0
  const start = firstParticipant ? range.longMax - 4 : range.longMin + 1
  const short = firstParticipant ? range.shortMin + 1 : range.shortMax - 1
  const longCells = [start, start + 1, start + 2, start + 3]
  if (!firstParticipant) longCells.reverse()
  const cells = longCells.map((long) => bridgeAxis === 'x'
    ? { lx: long, lz: short }
    : { lx: short, lz: long })

  return {
    dir: bridgeAxis === 'x'
      ? firstParticipant ? 1 : 3
      : firstParticipant ? 2 : 0,
    landing: cells[0],
    run: [cells[1], cells[2]],
    exit: cells[3],
  }
}

function verticalLinks(seed, districtX, districtZ, bandIndex, baseCy, participants, bridgeAxis, bounds) {
  const swap = plannerHash(
    seed,
    SALTS.linkParticipants,
    districtX,
    bandIndex,
    districtZ
  ) % 2
  return [0, 1].map((floorOffset) => {
    const participantIndex = swap === 0 ? floorOffset : 1 - floorOffset
    const participant = participants[participantIndex]
    return {
      lowerCy: baseCy + floorOffset,
      cx: participant.cx,
      cz: participant.cz,
      stair: stairDescriptor(
        participant,
        participantIndex,
        bridgeAxis,
        bounds
      ),
    }
  })
}

function authoredChoice(seed, salt, districtX, bandIndex, districtZ) {
  return plannerHash(seed, salt, districtX, bandIndex, districtZ) % 2
}

const positiveModulo = (value, modulus) => ((value % modulus) + modulus) % modulus

// The authored fixture socket resolves to the existing circulation-lamp grid
// on the top floor. Four adjacent offsets cover every grid phase; the fixture's
// dedicated salt then chooses between two valid authored bands. This reserves
// no new fixture DTO and leaves placeLights as the sole lamp emitter.
function fixtureSocket(
  seed,
  districtX,
  districtZ,
  bandIndex,
  cy,
  bridgeAxis,
  bounds
) {
  const fixtureChoice = authoredChoice(
    seed,
    SALTS.fixture,
    districtX,
    bandIndex,
    districtZ
  )
  const lampPhase = hash2i(
    (layerSeed(seed, cy) ^ TOWER_FIXTURE_LAMP_SALT) | 0,
    0x43,
    0
  ) % TOWER_FIXTURE_LAMP_STEP
  const longStart = bridgeAxis === 'x' ? bounds.x0 : bounds.z0
  const shortCoordinate = bridgeAxis === 'x' ? bounds.z1 : bounds.x1
  const residue = positiveModulo(
    lampPhase - longStart - shortCoordinate,
    TOWER_FIXTURE_LAMP_STEP
  )
  const firstBandOffset = residue === 0 ? TOWER_FIXTURE_LAMP_STEP : residue
  const longCoordinate = longStart + firstBandOffset +
    fixtureChoice * TOWER_FIXTURE_LAMP_STEP

  return bridgeAxis === 'x'
    ? { gx: longCoordinate, gz: shortCoordinate, axis: 'z', side: 1 }
    : { gx: shortCoordinate, gz: longCoordinate, axis: 'x', side: 1 }
}

function landmarkSockets(seed, districtX, districtZ, bandIndex, baseCy, bridgeAxis, bounds, deck) {
  const signageChoice = authoredChoice(
    seed,
    SALTS.signage,
    districtX,
    bandIndex,
    districtZ
  )
  const clockChoice = authoredChoice(
    seed,
    SALTS.clock,
    districtX,
    bandIndex,
    districtZ
  )
  const [firstApproach, secondApproach] = towerDeckEndpoints({ decks: [deck] })

  const signage = bridgeAxis === 'x'
    ? { gx: bounds.x0 + 1 + signageChoice, gz: bounds.z0, axis: 'z', side: -1 }
    : { gx: bounds.x0, gz: bounds.z0 + 1 + signageChoice, axis: 'x', side: -1 }
  const clock = bridgeAxis === 'x'
    ? { gx: bounds.x1 - 1 - clockChoice, gz: bounds.z1, axis: 'z', side: 1 }
    : { gx: bounds.x1, gz: bounds.z1 - 1 - clockChoice, axis: 'x', side: 1 }
  const fixture = fixtureSocket(
    seed,
    districtX,
    districtZ,
    bandIndex,
    baseCy + 2,
    bridgeAxis,
    bounds
  )

  // This order is the authored template. Kinds never come from a procedural
  // random pick; only positions within each template's valid authored choices
  // vary by its dedicated salt.
  return [
    {
      slot: 'anchorFloor',
      kind: TOWER_LANDMARK_SOCKET_KINDS[0],
      ...signage,
      cy: baseCy,
      salt: SALTS.signage >>> 0,
    },
    {
      slot: 'anchorFloor',
      kind: TOWER_LANDMARK_SOCKET_KINDS[1],
      ...clock,
      cy: baseCy + 1,
      salt: SALTS.clock >>> 0,
    },
    {
      slot: 'bridgeApproach',
      kind: TOWER_LANDMARK_SOCKET_KINDS[2],
      ...firstApproach,
      cy: deck.levelCy,
      axis: bridgeAxis,
      side: -1,
      salt: SALTS.litAccent >>> 0,
    },
    {
      slot: 'bridgeApproach',
      kind: TOWER_LANDMARK_SOCKET_KINDS[3],
      ...secondApproach,
      cy: deck.levelCy,
      axis: bridgeAxis,
      side: 1,
      salt: SALTS.door >>> 0,
    },
    {
      slot: 'anchorFloor',
      kind: TOWER_LANDMARK_SOCKET_KINDS[4],
      ...fixture,
      cy: baseCy + 2,
      salt: SALTS.fixture >>> 0,
    },
  ]
}

function structureForDistrict(seed, districtX, districtZ, baseCy, profile) {
  const topCy = baseCy + profile.levels - 1
  if (topCy > MAX_STRUCTURE_TOP_CY) return null

  const bandIndex = bandIndexAtBase(seed, districtX, districtZ, baseCy)
  if (!Number.isInteger(bandIndex)) return null
  const bridgeAxis = plannerHash(
    seed,
    SALTS.axis,
    districtX,
    bandIndex,
    districtZ
  ) % 2 === 0 ? 'x' : 'z'
  const candidates = polygonCandidates(
    districtX,
    districtZ,
    PAIR_ENUMERATION_CONFIG,
    {
      shape: 'pair',
      bridgeAxis,
      avoidSpawn: baseCy <= 0 && topCy >= 0,
    }
  )
  if (candidates.length === 0) return null

  const pairIndex = plannerHash(
    seed,
    SALTS.pair,
    districtX,
    bandIndex,
    districtZ
  ) % candidates.length
  const participants = candidates[pairIndex].participants.map(
    ({ cx, cz }) => ({ cx, cz })
  )
  const anchor = participants[0]
  const globalBounds = footprintBounds(
    seed,
    districtX,
    districtZ,
    bandIndex,
    anchor,
    bridgeAxis
  )
  const deck = deckForBounds(
    seed,
    districtX,
    districtZ,
    bandIndex,
    baseCy,
    bridgeAxis,
    globalBounds
  )
  const id = hash3i(
    ((seed >>> 0) ^ SALTS.id) | 0,
    anchor.cx,
    baseCy,
    anchor.cz
  ) || 1

  return deepFreeze({
    id,
    family: MAP_FAMILY_TOWER,
    kind: TOWER_STRUCTURE_KIND,
    hasRoom: true,
    district: {
      x: districtX,
      z: districtZ,
      size: DISTRICT_CHUNKS,
    },
    baseCy,
    topCy,
    levelCount: profile.levels,
    participants,
    anchor,
    bridgeAxis,
    globalBounds,
    decks: [deck],
    verticalLinks: verticalLinks(
      seed,
      districtX,
      districtZ,
      bandIndex,
      baseCy,
      participants,
      bridgeAxis,
      globalBounds
    ),
    landmarkSockets: landmarkSockets(
      seed,
      districtX,
      districtZ,
      bandIndex,
      baseCy,
      bridgeAxis,
      globalBounds,
      deck
    ),
  })
}

// Recover one immutable bounded Tower descriptor from either declared
// participant and any floor inside its three-level band. Misses remain null so
// the public structureAt dispatcher owns the canonical family-specific sentinel.
export function towerStructureAt(seed, cx, cz, levelCy, profile) {
  if (
    !validProfile(profile) ||
    !Number.isInteger(seed) ||
    !Number.isInteger(cx) ||
    !Number.isInteger(cz) ||
    !Number.isInteger(levelCy)
  ) return null

  const districtX = districtCoordinate(cx)
  const districtZ = districtCoordinate(cz)
  const baseCy = bandBaseAtLevel(seed, districtX, districtZ, levelCy)
  const structure = structureForDistrict(
    seed,
    districtX,
    districtZ,
    baseCy,
    profile
  )
  if (
    !structure ||
    levelCy < structure.baseCy ||
    levelCy > structure.topCy ||
    !structure.participants.some(
      (participant) => participant.cx === cx && participant.cz === cz
    )
  ) return null
  return structure
}
