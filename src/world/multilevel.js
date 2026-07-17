import { CHUNK, LOAD_RADIUS, fmod } from './constants.js'
import { DEFAULT_WORLD_CONFIG } from './config.js'
import { hash3f, hash3i } from './core/hash.js'

// Canonical multi-floor structures are planned in horizontal districts and
// vertical bands. A structure always occupies exactly two adjacent chunks and
// never depends on generated ChunkData (or on stairs/slabs), so either chunk
// can independently recover the same immutable descriptor.
export const DEFAULT_MULTILEVEL_CONFIG = Object.freeze({
  enabled: true,
  districtChunks: 4,
  longSpan: CHUNK + 8,
  shortSpan: 6,
  minLevels: 4,
  maxLevels: 10,
  verticalPeriod: 12,
  bridgeChance: 0.68,
  salt: 0x6d75,
  posSalt: 0xb71d,
  fallbackSalt: 0xfa17,
  heightSalt: 0x71e7,
  kindSalt: 0xb21d,
  deckSalt: 0xd3c5,
})

const MIN_LEVELS = 3
const MAX_LEVELS = 10
const MIN_LONG_SPAN = CHUNK + 1
const MAX_LONG_SPAN = CHUNK * 2 - 2
// A bridge must have open void on both flanks. Four cells is the smallest
// short span with two distinct interior deck lines and at least one void row
// on either side of either line.
const MIN_SHORT_SPAN = 4
const MAX_SHORT_SPAN = CHUNK - 2
const MIN_DISTRICT_CHUNKS = 2
const MAX_DISTRICT_CHUNKS = Math.max(MIN_DISTRICT_CHUNKS, LOAD_RADIUS + 1)
const CONFIG_CACHE = new WeakMap()
const STRUCTURE_CACHE = new WeakMap()
const STRUCTURE_CACHE_LIMIT = 1024
const EMPTY_CELLS = Object.freeze([])

const CONFIG_INPUT_FIELDS = Object.freeze([
  'enabled',
  'districtChunks',
  'longSpan',
  'shortSpan',
  'minLevels',
  'maxLevels',
  'verticalPeriod',
  'bridgeChance',
  'salt',
  'posSalt',
  'fallbackSalt',
  'heightSalt',
  'kindSalt',
  'deckSalt',
])

const finite = (value, fallback) => Number.isFinite(value) ? value : fallback
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value))

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function sameConfigInputs(hit, raw) {
  if (!hit || hit.raw !== raw) return false
  return CONFIG_INPUT_FIELDS.every((field, index) =>
    Object.is(hit.inputs[index], raw[field])
  )
}

// Normalized fields:
// - districtChunks: horizontal election district (at least 2, so a pair fits)
// - longSpan/shortSpan: cell footprint; longSpan necessarily crosses one seam
// - minLevels/maxLevels: inclusive structure height range, clamped to 3..10
// - verticalPeriod: distance between band bases, with at least one clear floor
// - bridgeChance: selects `bridged`; the complement selects `openVoid`
// - salts: independent stable streams for identity, layout, height, kind/decks
//
// The cache records every raw input used below. Designer/test configs are often
// mutated in place, so an object-identity-only WeakMap would return stale data.
export function multilevelConfig(config) {
  const candidate = config?.multilevel
  const raw = candidate && typeof candidate === 'object'
    ? candidate
    : DEFAULT_MULTILEVEL_CONFIG

  if (config && typeof config === 'object') {
    const hit = CONFIG_CACHE.get(config)
    if (sameConfigInputs(hit, raw)) return hit.value
  }

  const levelA = clamp(
    Math.floor(finite(raw.minLevels, DEFAULT_MULTILEVEL_CONFIG.minLevels)),
    MIN_LEVELS,
    MAX_LEVELS
  )
  const levelB = clamp(
    Math.floor(finite(raw.maxLevels, DEFAULT_MULTILEVEL_CONFIG.maxLevels)),
    MIN_LEVELS,
    MAX_LEVELS
  )
  const minLevels = Math.min(levelA, levelB)
  const maxLevels = Math.max(levelA, levelB)
  const requestedPeriod = Math.floor(finite(
    raw.verticalPeriod,
    DEFAULT_MULTILEVEL_CONFIG.verticalPeriod
  ))

  const value = Object.freeze({
    enabled: raw.enabled === undefined
      ? DEFAULT_MULTILEVEL_CONFIG.enabled
      : !!raw.enabled,
    districtChunks: clamp(
      Math.floor(finite(
        raw.districtChunks,
        DEFAULT_MULTILEVEL_CONFIG.districtChunks
      )),
      MIN_DISTRICT_CHUNKS,
      MAX_DISTRICT_CHUNKS
    ),
    longSpan: clamp(
      Math.floor(finite(raw.longSpan, DEFAULT_MULTILEVEL_CONFIG.longSpan)),
      MIN_LONG_SPAN,
      MAX_LONG_SPAN
    ),
    shortSpan: clamp(
      Math.floor(finite(raw.shortSpan, DEFAULT_MULTILEVEL_CONFIG.shortSpan)),
      MIN_SHORT_SPAN,
      MAX_SHORT_SPAN
    ),
    minLevels,
    maxLevels,
    verticalPeriod: Math.max(maxLevels + 1, requestedPeriod),
    bridgeChance: clamp(
      finite(raw.bridgeChance, DEFAULT_MULTILEVEL_CONFIG.bridgeChance),
      0,
      1
    ),
    salt: finite(raw.salt, DEFAULT_MULTILEVEL_CONFIG.salt) | 0,
    posSalt: finite(raw.posSalt, DEFAULT_MULTILEVEL_CONFIG.posSalt) | 0,
    fallbackSalt: finite(
      raw.fallbackSalt,
      DEFAULT_MULTILEVEL_CONFIG.fallbackSalt
    ) | 0,
    heightSalt: finite(raw.heightSalt, DEFAULT_MULTILEVEL_CONFIG.heightSalt) | 0,
    kindSalt: finite(raw.kindSalt, DEFAULT_MULTILEVEL_CONFIG.kindSalt) | 0,
    deckSalt: finite(raw.deckSalt, DEFAULT_MULTILEVEL_CONFIG.deckSalt) | 0,
  })

  if (config && typeof config === 'object') {
    CONFIG_CACHE.set(config, {
      raw,
      inputs: CONFIG_INPUT_FIELDS.map((field) => raw[field]),
      value,
    })
  }
  return value
}

export const normalizeMultilevelConfig = multilevelConfig

function isValidBandBase(baseCy, normalized) {
  return Number.isInteger(baseCy) && fmod(baseCy, normalized.verticalPeriod) === 0
}

function districtCoordinate(chunkCoordinate, districtChunks) {
  return Math.floor(chunkCoordinate / districtChunks)
}

function participantKey(cx, cz) {
  return `${cx},${cz}`
}

function hasParticipant(structure, cx, cz) {
  return structure.participants.some(
    (participant) => participant.cx === cx && participant.cz === cz
  )
}

function pairCandidates(districtX, districtZ, normalized, bridgeAxis, avoidSpawn) {
  const K = normalized.districtChunks
  const originCx = districtX * K
  const originCz = districtZ * K
  const candidates = []

  const xCount = bridgeAxis === 'x' ? K - 1 : K
  const zCount = bridgeAxis === 'z' ? K - 1 : K
  for (let localZ = 0; localZ < zCount; localZ++) {
    for (let localX = 0; localX < xCount; localX++) {
      const anchor = { cx: originCx + localX, cz: originCz + localZ }
      const neighbor = bridgeAxis === 'x'
        ? { cx: anchor.cx + 1, cz: anchor.cz }
        : { cx: anchor.cx, cz: anchor.cz + 1 }
      if (
        avoidSpawn &&
        (participantKey(anchor.cx, anchor.cz) === '0,0' ||
          participantKey(neighbor.cx, neighbor.cz) === '0,0')
      ) continue
      candidates.push({ anchor, neighbor })
    }
  }
  return candidates
}

function footprintBounds(seed, districtX, districtZ, bandIndex, pair, bridgeAxis, normalized) {
  let h = hash3i((seed ^ normalized.posSalt) | 0, districtX, bandIndex, districtZ)
  h = Math.floor(h / 2) // bit zero elected the axis

  // Both offsets preserve a one-cell exterior ring. Because longSpan > CHUNK,
  // every legal long offset necessarily touches both participant chunks.
  const longStartSlots = CHUNK * 2 - normalized.longSpan - 1
  const longOffset = 1 + (h % longStartSlots)
  h = Math.floor(h / longStartSlots)
  const shortStartSlots = CHUNK - normalized.shortSpan - 1
  const shortOffset = 1 + (h % shortStartSlots)

  const originX = pair.anchor.cx * CHUNK
  const originZ = pair.anchor.cz * CHUNK
  if (bridgeAxis === 'x') {
    return {
      x0: originX + longOffset,
      z0: originZ + shortOffset,
      x1: originX + longOffset + normalized.longSpan - 1,
      z1: originZ + shortOffset + normalized.shortSpan - 1,
    }
  }
  return {
    x0: originX + shortOffset,
    z0: originZ + longOffset,
    x1: originX + shortOffset + normalized.shortSpan - 1,
    z1: originZ + longOffset + normalized.longSpan - 1,
  }
}

function bridgeCenterLines(globalBounds, bridgeAxis, shortSpan) {
  const shortStart = bridgeAxis === 'x' ? globalBounds.z0 : globalBounds.x0
  const shortEnd = bridgeAxis === 'x' ? globalBounds.z1 : globalBounds.x1
  const low = shortStart + Math.floor((shortSpan - 1) / 2)
  // Even widths naturally have two central cells. For odd widths use the cell
  // immediately after the center, retaining two distinct alternating lines.
  const naturalHigh = shortStart + Math.floor(shortSpan / 2)
  const high = naturalHigh === low ? Math.min(shortEnd, low + 1) : naturalHigh
  return [low, high]
}

function bridgeLevels(baseCy, topCy) {
  const levels = []
  for (let levelCy = baseCy + 1; levelCy <= topCy; levelCy += 2) {
    levels.push(levelCy)
  }
  // A legal three-level structure has only one odd-offset upper level. Keep
  // the alternating cadence normally, but add its other upper level so every
  // bridged structure still has the promised minimum of two usable decks.
  if (levels.length < 2) levels.push(topCy)
  return [...new Set(levels)].sort((a, b) => a - b)
}

function globalDeckCells(bridgeAxis, globalBounds, globalBridgeLine) {
  const cells = []
  if (bridgeAxis === 'x') {
    for (let gx = globalBounds.x0; gx <= globalBounds.x1; gx++) {
      cells.push({ gx, gz: globalBridgeLine })
    }
  } else {
    for (let gz = globalBounds.z0; gz <= globalBounds.z1; gz++) {
      cells.push({ gx: globalBridgeLine, gz })
    }
  }
  return cells
}

function buildStructureForDistrict(seed, districtX, districtZ, baseCy, normalized) {
  if (!normalized.enabled || !isValidBandBase(baseCy, normalized)) return null
  const bandIndex = baseCy / normalized.verticalPeriod
  const levelRange = normalized.maxLevels - normalized.minLevels + 1
  const levelCount = normalized.minLevels + (
    hash3i(
      (seed ^ normalized.heightSalt) | 0,
      districtX,
      bandIndex,
      districtZ
    ) % levelRange
  )
  const topCy = baseCy + levelCount - 1
  const bridgeAxis = hash3i(
    (seed ^ normalized.posSalt) | 0,
    districtX,
    bandIndex,
    districtZ
  ) % 2 === 0 ? 'x' : 'z'

  const candidates = pairCandidates(
    districtX,
    districtZ,
    normalized,
    bridgeAxis,
    baseCy <= 0 && topCy >= 0
  )
  if (candidates.length === 0) return null
  const pairHash = hash3i(
    (seed ^ normalized.fallbackSalt) | 0,
    districtX,
    bandIndex,
    districtZ
  )
  const pair = candidates[pairHash % candidates.length]
  const globalBounds = footprintBounds(
    seed,
    districtX,
    districtZ,
    bandIndex,
    pair,
    bridgeAxis,
    normalized
  )
  const kind = hash3f(
    (seed ^ normalized.kindSalt) | 0,
    districtX,
    bandIndex,
    districtZ
  ) < normalized.bridgeChance ? 'bridged' : 'openVoid'
  const participants = [pair.anchor, pair.neighbor]
  const id = hash3i(
    (seed ^ normalized.salt) | 0,
    pair.anchor.cx,
    baseCy,
    pair.anchor.cz
  ) || 1

  let levels = []
  let decks = []
  let centerLines = []
  if (kind === 'bridged') {
    levels = bridgeLevels(baseCy, topCy)
    centerLines = bridgeCenterLines(
      globalBounds,
      bridgeAxis,
      normalized.shortSpan
    )
    const firstLine = hash3i(
      (seed ^ normalized.deckSalt) | 0,
      districtX,
      bandIndex,
      districtZ
    ) % 2
    decks = levels.map((levelCy, index) => {
      const globalBridgeLine = centerLines[(firstLine + index) % 2]
      const deckBounds = bridgeAxis === 'x'
        ? {
            x0: globalBounds.x0,
            z0: globalBridgeLine,
            x1: globalBounds.x1,
            z1: globalBridgeLine,
          }
        : {
            x0: globalBridgeLine,
            z0: globalBounds.z0,
            x1: globalBridgeLine,
            z1: globalBounds.z1,
          }
      return {
        levelCy,
        lowerCy: levelCy - 1,
        globalBridgeLine,
        globalBounds: deckBounds,
        globalCells: globalDeckCells(
          bridgeAxis,
          globalBounds,
          globalBridgeLine
        ),
      }
    })
  }

  // `bounds` and `participants` are the canonical global forms. Explicitly
  // named aliases make the coordinate space unambiguous to new consumers.
  return deepFreeze({
    id,
    hasRoom: true,
    kind,
    district: { x: districtX, z: districtZ, size: normalized.districtChunks },
    bandIndex,
    baseCy,
    bottomCy: baseCy,
    topCy,
    levelCount,
    height: levelCount,
    bridgeAxis,
    longSpan: normalized.longSpan,
    shortSpan: normalized.shortSpan,
    anchor: pair.anchor,
    participants,
    participantChunks: participants,
    bounds: globalBounds,
    globalBounds,
    centerLines,
    bridgeLevels: levels,
    decks,
  })
}

// Stair fallback election and office planning ask for the same district/band
// descriptor many times. Cache the immutable canonical object by normalized
// config identity so those pure lookups stay cheap even for ten-storey shafts.
function structureForDistrict(seed, districtX, districtZ, baseCy, normalized) {
  if (!normalized.enabled || !isValidBandBase(baseCy, normalized)) return null
  let cache = STRUCTURE_CACHE.get(normalized)
  if (!cache) {
    cache = new Map()
    STRUCTURE_CACHE.set(normalized, cache)
  }
  const key = `${seed >>> 0}:${districtX},${districtZ},${baseCy}`
  if (cache.has(key)) {
    const hit = cache.get(key)
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const structure = buildStructureForDistrict(
    seed,
    districtX,
    districtZ,
    baseCy,
    normalized
  )
  cache.set(key, structure)
  if (cache.size > STRUCTURE_CACHE_LIMIT) cache.delete(cache.keys().next().value)
  return structure
}

function noContract(baseCy) {
  return Object.freeze({ baseCy, hasRoom: false })
}

// Return the global descriptor only at its elected anchor and exact band base.
// Participant chunks intentionally do not pass this ownership contract; use
// multilevelStructureAt when querying an arbitrary chunk/level.
export function multilevelContract(
  seed,
  cx,
  cz,
  baseCy,
  config = DEFAULT_WORLD_CONFIG
) {
  const normalized = multilevelConfig(config)
  if (
    !normalized.enabled ||
    !Number.isInteger(cx) ||
    !Number.isInteger(cz) ||
    !isValidBandBase(baseCy, normalized)
  ) return noContract(baseCy)

  const districtX = districtCoordinate(cx, normalized.districtChunks)
  const districtZ = districtCoordinate(cz, normalized.districtChunks)
  const structure = structureForDistrict(
    seed,
    districtX,
    districtZ,
    baseCy,
    normalized
  )
  if (structure?.anchor.cx !== cx || structure?.anchor.cz !== cz) {
    return noContract(baseCy)
  }
  return structure
}

function noStructure(levelCy) {
  return Object.freeze({ levelCy, hasRoom: false })
}

// Recover the canonical structure from either of its participant chunks. The
// queried floor must be within the inclusive [baseCy, topCy] range.
export function multilevelStructureAt(
  seed,
  cx,
  cz,
  levelCy,
  config = DEFAULT_WORLD_CONFIG
) {
  const normalized = multilevelConfig(config)
  if (
    !normalized.enabled ||
    !Number.isInteger(cx) ||
    !Number.isInteger(cz) ||
    !Number.isInteger(levelCy)
  ) return noStructure(levelCy)

  const baseCy = Math.floor(levelCy / normalized.verticalPeriod) *
    normalized.verticalPeriod
  const districtX = districtCoordinate(cx, normalized.districtChunks)
  const districtZ = districtCoordinate(cz, normalized.districtChunks)
  const structure = structureForDistrict(
    seed,
    districtX,
    districtZ,
    baseCy,
    normalized
  )
  if (
    !structure ||
    levelCy < structure.baseCy ||
    levelCy > structure.topCy ||
    !hasParticipant(structure, cx, cz)
  ) return noStructure(levelCy)
  return structure
}

function noSlice(lowerCy) {
  return Object.freeze({
    id: null,
    baseCy: null,
    topCy: null,
    lowerCy,
    levelCy: lowerCy + 1,
    kind: null,
    bridgeAxis: null,
    bounds: null,
    localBounds: null,
    globalBounds: null,
    bridgeLine: null,
    globalBridgeLine: null,
    voidCells: EMPTY_CELLS,
    bridgeCells: EMPTY_CELLS,
    hasRoom: false,
  })
}

// Project one structure/slab intersection into one participant chunk. `lowerCy`
// owns the slab whose upper surface is `levelCy = lowerCy + 1`. Cells use local
// chunk coordinates; bounds/bridge lines are supplied in both coordinate spaces.
export function multilevelStructureSlice(structure, cx, cz, lowerCy) {
  if (
    !structure?.hasRoom ||
    !Number.isInteger(cx) ||
    !Number.isInteger(cz) ||
    !Number.isInteger(lowerCy) ||
    !hasParticipant(structure, cx, cz)
  ) return noSlice(lowerCy)

  const levelCy = lowerCy + 1
  if (lowerCy < structure.baseCy || levelCy > structure.topCy) {
    return noSlice(lowerCy)
  }

  const chunkX0 = cx * CHUNK
  const chunkZ0 = cz * CHUNK
  const gx0 = Math.max(structure.globalBounds.x0, chunkX0)
  const gz0 = Math.max(structure.globalBounds.z0, chunkZ0)
  const gx1 = Math.min(structure.globalBounds.x1, chunkX0 + CHUNK - 1)
  const gz1 = Math.min(structure.globalBounds.z1, chunkZ0 + CHUNK - 1)
  if (gx0 > gx1 || gz0 > gz1) return noSlice(lowerCy)

  const deck = structure.decks.find((candidate) => candidate.levelCy === levelCy)
  const globalBridgeLine = deck?.globalBridgeLine ?? null
  const bridgeLine = globalBridgeLine === null
    ? null
    : structure.bridgeAxis === 'x'
      ? globalBridgeLine - chunkZ0
      : globalBridgeLine - chunkX0
  const voidCells = []
  const bridgeCells = []
  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const onBridge = globalBridgeLine !== null && (
        structure.bridgeAxis === 'x'
          ? gz === globalBridgeLine
          : gx === globalBridgeLine
      )
      const cell = { lx: gx - chunkX0, lz: gz - chunkZ0 }
      ;(onBridge ? bridgeCells : voidCells).push(cell)
    }
  }

  const localBounds = {
    x0: gx0 - chunkX0,
    z0: gz0 - chunkZ0,
    x1: gx1 - chunkX0,
    z1: gz1 - chunkZ0,
  }
  return deepFreeze({
    id: structure.id,
    baseCy: structure.baseCy,
    topCy: structure.topCy,
    lowerCy,
    levelCy,
    kind: structure.kind,
    bridgeAxis: structure.bridgeAxis,
    bounds: localBounds,
    localBounds,
    globalBounds: structure.globalBounds,
    bridgeLine,
    globalBridgeLine,
    voidCells,
    bridgeCells,
    hasRoom: true,
  })
}

// Operation-oriented aliases plus seed/chunk helpers for callers that do not
// already hold the global structure descriptor.
export const multilevelSlice = multilevelStructureSlice
export const sliceMultilevelStructure = multilevelStructureSlice

export function multilevelSliceAt(
  seed,
  cx,
  cz,
  lowerCy,
  config = DEFAULT_WORLD_CONFIG
) {
  const structure = multilevelStructureAt(seed, cx, cz, lowerCy, config)
  return multilevelStructureSlice(structure, cx, cz, lowerCy)
}

export function multilevelUpSlice(
  seed,
  cx,
  cz,
  cy,
  config = DEFAULT_WORLD_CONFIG
) {
  return multilevelSliceAt(seed, cx, cz, cy, config)
}

export function multilevelDownSlice(
  seed,
  cx,
  cz,
  cy,
  config = DEFAULT_WORLD_CONFIG
) {
  return multilevelSliceAt(seed, cx, cz, cy - 1, config)
}

// A floor sees the same global `structure` from either participant. `up` is
// the slab cy -> cy+1 and `down` is cy-1 -> cy; at the inclusive bottom/top,
// the outward-facing slice is the explicit hasRoom:false descriptor.
export function chunkMultilevelRooms(
  seed,
  cx,
  cz,
  cy,
  config = DEFAULT_WORLD_CONFIG
) {
  const structure = multilevelStructureAt(seed, cx, cz, cy, config)
  return {
    structure,
    up: multilevelStructureSlice(structure, cx, cz, cy),
    down: multilevelStructureSlice(structure, cx, cz, cy - 1),
  }
}
