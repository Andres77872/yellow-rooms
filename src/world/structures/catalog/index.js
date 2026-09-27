import { FAMILY_CATALOG_PROFILES } from '../../config.js'
import { hash3i } from '../../core/hash.js'
import {
  MAX_STRUCTURE_TOP_CY,
  bandBaseAtLevel,
  districtCoordinate,
  plannerHash,
  verticalBandPhase,
} from '../districtBand.js'
import {
  CATALOG_SIZE_CLASSES,
  assembleCatalogDescriptor,
  footprintBox,
} from './engine.js'
import { recipesFor } from './recipes.js'
import { multilevelConfig } from '../multilevel.js'
import { resolveMapFamily } from '../../mapFamily.js'

export * from './engine.js'
export { CATALOG_RECIPES, recipesFor } from './recipes.js'

// The structure catalog's election layer. Every family owns a list of
// procedural structure types (./recipes.js) in three size classes:
//
//   small   one chunk            (a light well, a stair core, a mezzanine)
//   medium  an adjacent pair     (a court, a cistern, a nave)
//   large   a 2×2 chunk block    (a grand atrium, a stepwell, an abyss)
//
// Placement is a pure function of (root seed, family config, district, band):
// the chunk grid splits into K×K districts (aligned with the stair and
// multilevel districts), floors into vertical bands of `period` storeys with
// a per-district phase. Each (district, band) runs a fixed number of salted
// attempts; an attempt draws a size class, a recipe, a footprint and a height,
// and is accepted only when every chunk-storey it needs is free of the
// family's canonical landmark (office atria, tower forms, lattice districts
// keep precedence), of earlier attempts and of the spawn hub, and when no
// storey of the district would carry more than `maxChunksPerFloor` structure
// chunks — so the stair fallback always finds a free chunk on every slab.
// Any participant chunk of any storey recomputes the same list, so both
// sides of every slab and every participant agree without communication.

const PHASE_SALT = 0x63a1
const ID_SALT = 0x63d7

export const DEFAULT_CATALOG_CONFIG = FAMILY_CATALOG_PROFILES.office

const CONFIG_CACHE = new WeakMap()
const BY_SIGNATURE = new Map()
const finite = (v, d) => (Number.isFinite(v) ? v : d)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// Catalog volumes are multilevel structures: `multilevel.enabled === false`
// (used by zone-isolation tests) disables them together with the atria.
export function catalogConfig(config) {
  const raw = config?.catalog ?? DEFAULT_CATALOG_CONFIG
  const multilevelOff = config?.multilevel?.enabled === false
  if (config && typeof config === 'object') {
    const hit = CONFIG_CACHE.get(config)
    if (hit && hit.raw === raw && hit.multilevelOff === multilevelOff && hit.sig === signature(raw)) return hit.value
  }
  // Derived configs (sewer riser configs, editor/test clones) carry equal
  // catalog blocks in new objects: share one normalized object per content so
  // the band-plan cache (keyed by it) is shared too.
  const sig = `${signature(raw)}:${multilevelOff}`
  const shared = BY_SIGNATURE.get(sig)
  if (shared) {
    if (config && typeof config === 'object') CONFIG_CACHE.set(config, { raw, multilevelOff, sig: signature(raw), value: shared })
    return shared
  }
  const weights = raw.sizeWeights ?? DEFAULT_CATALOG_CONFIG.sizeWeights
  const value = Object.freeze({
    enabled: raw.enabled !== false && !multilevelOff,
    districtChunks: clamp(Math.floor(finite(raw.districtChunks, 4)), 2, 5),
    period: clamp(Math.floor(finite(raw.period, 9)), 3, 17),
    attempts: clamp(Math.floor(finite(raw.attempts, 6)), 0, 32),
    maxChunksPerFloor: clamp(Math.floor(finite(raw.maxChunksPerFloor, 7)), 1, 24),
    sizeWeights: Object.freeze(Object.fromEntries(CATALOG_SIZE_CLASSES.map((c) => [c, Math.max(0, finite(weights[c], 0))]))),
    salt: finite(raw.salt, DEFAULT_CATALOG_CONFIG.salt) | 0,
  })
  BY_SIGNATURE.set(sig, value)
  if (config && typeof config === 'object') {
    CONFIG_CACHE.set(config, { raw, multilevelOff, sig: signature(raw), value })
  }
  return value
}

function signature(raw) {
  return JSON.stringify([raw.enabled, raw.districtChunks, raw.period, raw.attempts, raw.maxChunksPerFloor, raw.sizeWeights, raw.salt])
}

function weightedPick(entries, h) {
  const total = entries.reduce((a, [, w]) => a + w, 0)
  if (total <= 0) return null
  let t = (h % 10007) / 10007 * total
  for (const [value, w] of entries) {
    if (t < w) return value
    t -= w
  }
  return entries.at(-1)[0]
}

// ---- band planning ----------------------------------------------------------------

const PLAN_CACHE = new WeakMap()
const PLAN_CACHE_LIMIT = 2048
const SPAWN_RADIUS = 1

// A band plan also depends on where the family's LANDMARKS are, which the
// atrium planner derives from config.multilevel (Office/Hotel). Configs that
// share a catalog block but differ there must not share plans. The atrium
// normalizer is cached (and detects in-place edits), so its identity is a
// cheap, exact key.
// Landmark placement depends on the atrium config (Office/Hotel) and on the
// resolved family profile (e.g. Lattice cycleRate). Both normalizers cache
// by content-checked identity, so the pair of objects is an exact key.
const LANDMARK_IDS = new WeakMap()
const LANDMARK_BY_CONTENT = new Map()
function landmarkSignature(config) {
  const normalized = multilevelConfig(config)
  const profile = resolveMapFamily(config)
  let byProfile = LANDMARK_IDS.get(normalized)
  if (!byProfile) LANDMARK_IDS.set(normalized, (byProfile = new WeakMap()))
  let id = byProfile.get(profile)
  if (id) return id
  // Derived configs (sewer risers) normalize to fresh but equal objects.
  const content = JSON.stringify([normalized, profile])
  id = LANDMARK_BY_CONTENT.get(content)
  if (!id) LANDMARK_BY_CONTENT.set(content, (id = LANDMARK_BY_CONTENT.size + 1))
  byProfile.set(profile, id)
  return id
}

function bandPlan(seed, family, dX, dZ, bandIndex, cfg, primaryAt, config) {
  let cache = PLAN_CACHE.get(cfg)
  if (!cache) PLAN_CACHE.set(cfg, (cache = new Map()))
  const key = `${seed >>> 0}:${family}:${landmarkSignature(config)}:${dX},${dZ},${bandIndex}`
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const plan = buildBandPlan(seed, family, dX, dZ, bandIndex, cfg, primaryAt)
  cache.set(key, plan)
  if (cache.size > PLAN_CACHE_LIMIT) cache.delete(cache.keys().next().value)
  return plan
}

function buildBandPlan(seed, family, dX, dZ, bandIndex, cfg, primaryAt) {
  const K = cfg.districtChunks
  const P = cfg.period
  const phase = verticalBandPhase(seed, cfg.salt ^ PHASE_SALT, dX, dZ, P)
  const bandBase = phase + bandIndex * P
  const recipes = recipesFor(family)
  if (!recipes.length) return Object.freeze([])

  // occ[f][i]: 1 = canonical landmark, 2 = spawn hub / cap, 3 = catalog.
  const occ = Array.from({ length: P }, () => new Uint8Array(K * K))
  const count = new Uint8Array(P)
  for (let f = 0; f < P; f++) {
    const cy = bandBase + f
    for (let i = 0; i < K * K; i++) {
      const cx = dX * K + (i % K)
      const cz = dZ * K + Math.floor(i / K)
      if (cy > MAX_STRUCTURE_TOP_CY) occ[f][i] = 2
      else if (Math.abs(cx) <= SPAWN_RADIUS && Math.abs(cz) <= SPAWN_RADIUS && cy === 0) occ[f][i] = 2
      else if (primaryAt(cx, cz, cy)?.hasRoom) {
        occ[f][i] = 1
        count[f]++
      }
    }
  }

  const out = []
  for (let a = 0; a < cfg.attempts; a++) {
    const h = (salt) => plannerHash(seed, (cfg.salt ^ (a * 0x9e3779b1) ^ salt) | 0, dX, bandIndex, dZ)
    const sizeClass = weightedPick(
      CATALOG_SIZE_CLASSES.map((c) => [c, recipes.some((r) => r.sizeClass === c) ? cfg.sizeWeights[c] : 0]),
      h(0x11)
    )
    if (!sizeClass) continue
    const recipe = weightedPick(recipes.filter((r) => r.sizeClass === sizeClass).map((r) => [r, r.weight ?? 1]), h(0x22))
    const dims = recipe.chunks[h(0x33) % recipe.chunks.length]
    const [w, d] = dims
    if (w > K || d > K) continue
    const lcx = h(0x44) % (K - w + 1)
    const lcz = h(0x55) % (K - d + 1)
    const [lo, hi] = recipe.levels
    const maxLevels = Math.min(hi, P)
    if (maxLevels < lo) continue
    const levels = lo + (h(0x66) % (maxLevels - lo + 1))
    const baseOff = h(0x77) % (P - levels + 1)
    let free = true
    for (let f = baseOff; f < baseOff + levels && free; f++) {
      if (count[f] + w * d > cfg.maxChunksPerFloor) free = false
      for (let z = lcz; z < lcz + d && free; z++) {
        for (let x = lcx; x < lcx + w; x++) {
          if (occ[f][z * K + x]) {
            free = false
            break
          }
        }
      }
    }
    if (!free) continue
    const cx0 = dX * K + lcx
    const cz0 = dZ * K + lcz
    const baseCy = bandBase + baseOff
    const ctx = recipeContext(seed, cfg, family, recipe, { cx0, cz0, w, d, levels, baseCy, attempt: a, h })
    const built = recipe.build(ctx)
    if (!built) continue
    const id = (hash3i((seed ^ cfg.salt ^ ID_SALT ^ a) | 0, cx0, baseCy, cz0) >>> 0) || 1
    let pickSalt = 0
    const pick = (n) => hash3i((seed ^ cfg.salt ^ 0x51c) | 0, id & 0xffff, pickSalt++, n) % n
    const desc = assembleCatalogDescriptor(built, {
      id,
      family,
      type: recipe.type,
      sizeClass,
      district: { x: dX, z: dZ, size: K },
      bandIndex,
      slot: a,
      baseCy,
    }, pick)
    if (!desc) continue
    for (let f = baseOff; f < baseOff + levels; f++) {
      count[f] += w * d
      for (let z = lcz; z < lcz + d; z++) {
        for (let x = lcx; x < lcx + w; x++) occ[f][z * K + x] = 3
      }
    }
    out.push(desc)
  }
  return Object.freeze(out)
}

// Deterministic helpers handed to a recipe. Every draw has its own salt so a
// recipe can add choices without disturbing earlier ones.
function recipeContext(seed, cfg, family, recipe, s) {
  const r = (salt) => s.h(0x1000 + (salt | 0))
  return {
    family,
    sizeClass: recipe.sizeClass,
    type: recipe.type,
    cx0: s.cx0,
    cz0: s.cz0,
    w: s.w,
    d: s.d,
    levels: s.levels,
    baseCy: s.baseCy,
    box: footprintBox(s.cx0, s.cz0, s.w, s.d),
    rand: r,
    int: (lo, hi, salt) => lo + (r(salt) % (hi - lo + 1)),
    chance: (p, salt) => (r(salt) % 10000) / 10000 < p,
    pick: (arr, salt) => arr[r(salt) % arr.length],
  }
}

// ---- lookup ---------------------------------------------------------------------------

// The catalog structure owning chunk (cx, cz) on storey cy, or null.
// `primaryAt(cx, cz, cy)` is the family's canonical landmark lookup (it wins
// every chunk-storey it claims).
export function catalogStructureAt(seed, cx, cz, cy, config, family, primaryAt) {
  const cfg = catalogConfig(config)
  if (!cfg.enabled || !Number.isInteger(cx) || !Number.isInteger(cz) || !Number.isInteger(cy)) return null
  if (!recipesFor(family).length) return null
  const K = cfg.districtChunks
  const P = cfg.period
  const dX = districtCoordinate(cx, K)
  const dZ = districtCoordinate(cz, K)
  const phaseSalt = cfg.salt ^ PHASE_SALT
  const base = bandBaseAtLevel(seed, phaseSalt, dX, dZ, cy, P)
  const phase = verticalBandPhase(seed, phaseSalt, dX, dZ, P)
  const bandIndex = Math.round((base - phase) / P)
  const plan = bandPlan(seed >>> 0, family, dX, dZ, bandIndex, cfg, primaryAt, config)
  for (const s of plan) {
    if (cy < s.baseCy || cy > s.topCy) continue
    if (s.participants.some((p) => p.cx === cx && p.cz === cz)) return s
  }
  return null
}

// Every catalog structure of a (district, band) — editor atlas / audits.
export function catalogBandStructures(seed, dX, dZ, bandIndex, config, family, primaryAt) {
  const cfg = catalogConfig(config)
  if (!cfg.enabled) return []
  return bandPlan(seed >>> 0, family, dX, dZ, bandIndex, cfg, primaryAt, config)
}
