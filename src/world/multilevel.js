import { CHUNK, LOAD_RADIUS, ZONE_PILLARS, fmod } from './constants.js'
import { DEFAULT_WORLD_CONFIG } from './config.js'
import { hash3f, hash3i } from './core/hash.js'
import { layerSeed } from './layerSeed.js'
import { selectZone } from './regions.js'
import { slabContract, stairConfig } from './slab.js'

// A multilevel room is owned by its lower (even) floor, just as a stair
// contract is owned by its lower slab. The feature remains a pure root-seeded
// contract: either participating floor can derive the same descriptor without
// generating or consulting the other floor's ChunkData.
export const DEFAULT_MULTILEVEL_CONFIG = Object.freeze({
  enabled: true,
  chance: 0.04,
  districtChunks: 4,
  longSpan: 8,
  shortSpan: 6,
  salt: 0x6d75,
  posSalt: 0xb71d,
  fallbackSalt: 0xfa17,
})

const MIN_SPAN = 3
const MAX_SPAN = CHUNK - 2 // cells [1..CHUNK-2], preserving a 1-cell ring
const CONFIG_CACHE = new WeakMap()
const FALLBACK_CACHE = new WeakMap()
const FALLBACK_CACHE_LIMIT = 512

const finite = (value, fallback) => Number.isFinite(value) ? value : fallback
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value))

// Normalize at the pure contract boundary so malformed or partially-specified
// tuning cannot silently break fallback election or place geometry outside the
// chunk. `longSpan` and `shortSpan` are ordered after clamping, preserving their
// semantic meaning even if a caller supplies them in reverse.
export function multilevelConfig(config) {
  const raw = config?.multilevel || DEFAULT_MULTILEVEL_CONFIG
  if (config && typeof config === 'object') {
    const hit = CONFIG_CACHE.get(config)
    if (
      hit?.raw === raw &&
      Object.is(hit.enabled, raw.enabled) &&
      Object.is(hit.chance, raw.chance) &&
      Object.is(hit.districtChunks, raw.districtChunks) &&
      Object.is(hit.longSpan, raw.longSpan) &&
      Object.is(hit.shortSpan, raw.shortSpan) &&
      Object.is(hit.salt, raw.salt) &&
      Object.is(hit.posSalt, raw.posSalt) &&
      Object.is(hit.fallbackSalt, raw.fallbackSalt)
    ) return hit.value
  }

  const spanA = clamp(
    Math.floor(finite(raw.longSpan, DEFAULT_MULTILEVEL_CONFIG.longSpan)),
    MIN_SPAN,
    MAX_SPAN
  )
  const spanB = clamp(
    Math.floor(finite(raw.shortSpan, DEFAULT_MULTILEVEL_CONFIG.shortSpan)),
    MIN_SPAN,
    MAX_SPAN
  )
  const value = Object.freeze({
    enabled: raw.enabled === undefined ? DEFAULT_MULTILEVEL_CONFIG.enabled : !!raw.enabled,
    chance: clamp(finite(raw.chance, DEFAULT_MULTILEVEL_CONFIG.chance), 0, 1),
    districtChunks: clamp(
      Math.floor(finite(raw.districtChunks, DEFAULT_MULTILEVEL_CONFIG.districtChunks)),
      1,
      LOAD_RADIUS + 1
    ),
    longSpan: Math.max(spanA, spanB),
    shortSpan: Math.min(spanA, spanB),
    salt: finite(raw.salt, DEFAULT_MULTILEVEL_CONFIG.salt) | 0,
    posSalt: finite(raw.posSalt, DEFAULT_MULTILEVEL_CONFIG.posSalt) | 0,
    fallbackSalt: finite(raw.fallbackSalt, DEFAULT_MULTILEVEL_CONFIG.fallbackSalt) | 0,
  })

  if (config && typeof config === 'object') {
    CONFIG_CACHE.set(config, {
      raw,
      enabled: raw.enabled,
      chance: raw.chance,
      districtChunks: raw.districtChunks,
      longSpan: raw.longSpan,
      shortSpan: raw.shortSpan,
      salt: raw.salt,
      posSalt: raw.posSalt,
      fallbackSalt: raw.fallbackSalt,
      value,
    })
  }
  return value
}

// Explicit alias for callers that prefer the operation-oriented name.
export const normalizeMultilevelConfig = multilevelConfig

function eligibility(seed, cx, cz, baseCy, config) {
  const lowerZone = selectZone(cx, cz, layerSeed(seed, baseCy), config)
  const upperZone = selectZone(cx, cz, layerSeed(seed, baseCy + 1), config)
  if (lowerZone !== upperZone || lowerZone === ZONE_PILLARS) return null

  // These are precisely the three slabs that touch either participating room
  // layer: below the lower floor, between the rooms, and above the upper floor.
  for (let slabCy = baseCy - 1; slabCy <= baseCy + 1; slabCy++) {
    if (slabContract(seed, cx, cz, slabCy, config).hasStair) return null
  }
  return { zone: lowerZone }
}

// The fallback host is shared by every query in one district. Keep a small LRU
// per world-config object; the key contains every normalized stair and region
// input that eligibility reads, so ordinary mutable test/designer configs can
// never reuse a result after a relevant edit.
function fallbackCacheKey(seed, districtX, districtZ, baseCy, config, normalized) {
  const region = config.region
  const stairs = stairConfig(config)
  const bands = config.zoneBands.map(({ id, max }) => `${id}:${max}`).join(',')
  return [
    seed >>> 0,
    districtX,
    districtZ,
    baseCy,
    normalized.districtChunks,
    normalized.fallbackSalt,
    region.scale,
    region.salt,
    region.warpAmp,
    region.octaves,
    region.lacunarity,
    region.gain,
    region.bufferTransitions ? 1 : 0,
    bands,
    stairs.enabled ? 1 : 0,
    stairs.chance,
    stairs.districtChunks,
    stairs.salt,
    stairs.posSalt,
    stairs.layoutSalt,
    stairs.fallbackSalt,
  ].join('|')
}

function fallbackCache(config) {
  let cache = FALLBACK_CACHE.get(config)
  if (!cache) {
    cache = new Map()
    FALLBACK_CACHE.set(config, cache)
  }
  return cache
}

// Walk a root-seeded cyclic permutation of the district until an eligible host
// is found. Unlike hashing one fixed slot, this guarantees exactly one fallback
// whenever the district has a valid host. Returning at the first match avoids
// evaluating every chunk in the common case while retaining a canonical result.
function fallbackHost(seed, districtX, districtZ, baseCy, config, normalized) {
  const cache = fallbackCache(config)
  const cacheKey = fallbackCacheKey(
    seed,
    districtX,
    districtZ,
    baseCy,
    config,
    normalized
  )
  if (cache.has(cacheKey)) {
    const hit = cache.get(cacheKey)
    cache.delete(cacheKey)
    cache.set(cacheKey, hit)
    return hit
  }

  const K = normalized.districtChunks
  const h = hash3i(
    (seed ^ normalized.fallbackSalt) | 0,
    districtX,
    baseCy,
    districtZ
  )
  const area = K * K
  const start = h % area
  for (let offset = 0; offset < area; offset++) {
    const index = (start + offset) % area
    const cx = districtX * K + (index % K)
    const cz = districtZ * K + Math.floor(index / K)
    if (cx === 0 && cz === 0 && baseCy === 0) continue
    if (eligibility(seed, cx, cz, baseCy, config)) {
      const host = { cx, cz }
      cache.set(cacheKey, host)
      if (cache.size > FALLBACK_CACHE_LIMIT) cache.delete(cache.keys().next().value)
      return host
    }
  }
  cache.set(cacheKey, null)
  if (cache.size > FALLBACK_CACHE_LIMIT) cache.delete(cache.keys().next().value)
  return null
}

function geometry(seed, cx, cz, baseCy, zone, normalized, id) {
  // One position stream supplies orientation, legal rectangle offsets, and
  // the choice between the two central lines of an even-width short axis.
  // Division (rather than signed bit shifts) keeps all 32 hash bits unsigned.
  let h = hash3i((seed ^ normalized.posSalt) | 0, cx, baseCy, cz)
  const bridgeAxis = h % 2 === 0 ? 'x' : 'z'
  h = Math.floor(h / 2)

  const width = bridgeAxis === 'x' ? normalized.longSpan : normalized.shortSpan
  const depth = bridgeAxis === 'z' ? normalized.longSpan : normalized.shortSpan
  const xSlots = CHUNK - width - 1
  const zSlots = CHUNK - depth - 1
  const x0 = 1 + (h % xSlots)
  h = Math.floor(h / xSlots)
  const z0 = 1 + (h % zSlots)
  h = Math.floor(h / zSlots)
  const x1 = x0 + width - 1
  const z1 = z0 + depth - 1

  const shortStart = bridgeAxis === 'x' ? z0 : x0
  const centerLow = shortStart + Math.floor((normalized.shortSpan - 1) / 2)
  const centerHigh = shortStart + Math.floor(normalized.shortSpan / 2)
  const bridgeLine = h % 2 === 0 ? centerLow : centerHigh

  // Enumerating the footprint in row-major order canonically sorts both
  // arrays. The bridge is the complete one-cell deck; every other footprint
  // cell is open void shared visually by the two room layers.
  const voidCells = []
  const bridgeCells = []
  for (let lz = z0; lz <= z1; lz++) {
    for (let lx = x0; lx <= x1; lx++) {
      const onBridge = bridgeAxis === 'x' ? lz === bridgeLine : lx === bridgeLine
      ;(onBridge ? bridgeCells : voidCells).push({ lx, lz })
    }
  }

  return {
    id,
    baseCy,
    zone,
    bounds: { x0, z0, x1, z1 },
    bridgeAxis,
    bridgeLine,
    voidCells,
    bridgeCells,
    hasRoom: true,
  }
}

// Contract for the two-floor room owned by lower floor `baseCy`.
export function multilevelContract(
  seed,
  cx,
  cz,
  baseCy,
  config = DEFAULT_WORLD_CONFIG
) {
  const normalized = multilevelConfig(config)
  if (!normalized.enabled || !Number.isInteger(baseCy) || fmod(baseCy, 2) !== 0) {
    return { baseCy, hasRoom: false }
  }
  if (cx === 0 && cz === 0 && baseCy === 0) return { baseCy, hasRoom: false }

  const eligible = eligibility(seed, cx, cz, baseCy, config)
  if (!eligible) return { baseCy, hasRoom: false }

  // The gate hash is also the room's stable uint32 identity. Fallback is an OR
  // over this organic density gate, so other eligible district cells retain
  // their independent chance while one valid host is always guaranteed.
  // spaceId uses zero as "no semantic space", so reserve a non-zero stable ID.
  const id = hash3i((seed ^ normalized.salt) | 0, cx, baseCy, cz) || 1
  const gate = hash3f((seed ^ normalized.salt) | 0, cx, baseCy, cz) < normalized.chance
  if (gate) return geometry(seed, cx, cz, baseCy, eligible.zone, normalized, id)

  const K = normalized.districtChunks
  const districtX = Math.floor(cx / K)
  const districtZ = Math.floor(cz / K)
  const fallback = fallbackHost(
    seed,
    districtX,
    districtZ,
    baseCy,
    config,
    normalized
  )
  if (fallback?.cx !== cx || fallback?.cz !== cz) {
    return { baseCy, hasRoom: false }
  }

  return geometry(seed, cx, cz, baseCy, eligible.zone, normalized, id)
}

// Both contracts in which a layer can participate. As with chunkStairs,
// up(cy) and down(cy+1) are independently-derived copies of one shared object.
export function chunkMultilevelRooms(seed, cx, cz, cy, config = DEFAULT_WORLD_CONFIG) {
  return {
    up: multilevelContract(seed, cx, cz, cy, config),
    down: multilevelContract(seed, cx, cz, cy - 1, config),
  }
}
