import { chunkKey3 } from '../constants.js'
import { hash2i } from '../core/hash.js'
import { normalizeDoorPassages } from '../doors.js'
import { resolveMapFamily } from '../mapFamily.js'
import { COLUMN_FURNITURE } from '../mapTypes.js'
import { familyGenerator } from '../families/generators.js'
import { familyPlanner } from '../families/planners.js'
import { familyRecord } from '../families/registry.js'
import { SPACE_ID_RECORD_FIELDS, cloneChunkData } from './cloneChunk.js'
import { fillDarkCells, resolveFillSpec } from './fillLight.js'
import { makeWorldKit } from './kit.js'
import { portsAtOf } from './seams.js'
import { solidChunk } from './solidChunk.js'
import { TileCanvas } from './TileCanvas.js'
import { bakeStats, recordBake, recordFallback, tileCache } from './tileCache.js'
import {
  LOCAL_SPACE_MASK,
  STRUCTURE_ID_BIT,
  keyString,
  spaceIdOf,
  tileKeyAt,
  tileKeyOf,
  tileSeed,
  tileWindow,
} from './tileKey.js'

// The liminal branch of chunk generation (spec §6.6, §6.7).
//
// buildChunk hands every chunk of a liminal family here. A chunk whose
// footprint is solid (or that lies outside the family's storeys/rows) is
// solid mass, never baked. Otherwise the chunk's TILE is baked once — the
// family's tile program (its kind body) drawn on a TileCanvas at the tile's
// origin, with the world kit stamping the planner's structures — cached in a
// per-family LRU, and the chunk is a clone of the bake's slice.
//
// Purity: a bake reads only (worldSeed, family, profile, config.version,
// furniture flag, tile key). The cache key's signature covers exactly those.
//
// IMPORT RULE (§3.1, §7.5): nothing here may import families/hooks.js
// (generate → pipeline → familyChunk cycle). The exit anchor comes from
// gen.exitAnchor.

export { bakeStats, tileCache }

const MAX_ATTEMPTS = 4

// --- the bake ------------------------------------------------------------------------

// The cache signature of a config: [selected profile, version, furniture flag].
const SIG = new WeakMap()
const furnitureOn = (config) => config?.furniture?.enabled !== false
export function configSignature(config, profile = resolveMapFamily(config)) {
  const memo = config !== null && typeof config === 'object' ? SIG.get(config) : undefined
  if (memo !== undefined) return memo
  const sig = JSON.stringify([profile, config?.version, furnitureOn(config)])
  if (config !== null && typeof config === 'object') SIG.set(config, sig)
  return sig
}

// keep(gcx, gcy, gcz): in the tile window, in [cy0, cy1], footprint 'tile'.
function keepOf(gen, worldSeed, k, profile) {
  const win = tileWindow(gen.tile, k)
  return (gcx, gcy, gcz) =>
    gcx >= win.cx0 && gcx <= win.cx1 && gcz >= win.cz0 && gcz <= win.cz1 &&
    gcy >= k.cy0 && gcy <= k.cy1 &&
    gen.footprint(worldSeed, gcx, gcy, gcz, profile) === 'tile'
}

// The bake ctx (§6.5) for tile k on `canvas`.
export function makeTileCtx(gen, profile, worldSeed, config, k, canvas, { tileSeed: seed, planSeed, structures = null, attempt = 0 }) {
  const family = profile.family
  const planner = familyPlanner(family)
  const ctx = {
    mode: 'tile',
    family,
    record: familyRecord(family),
    profile,
    config,
    worldSeed,
    key: { tx: k.tx, tz: k.tz, band: k.band },
    origin: k.origin,
    cy0: k.cy0,
    cy1: k.cy1,
    tileSeed: seed,
    planSeed,
    attempt,
    window: tileWindow(gen.tile, k),
    portsAt: portsAtOf(gen, worldSeed, k),
    structures: structures ?? (planner ? planner.structuresInTile(worldSeed, k, profile, config) : Object.freeze([])),
    anchor: gen.exitAnchor(worldSeed, profile),
    furniture: furnitureOn(config),
    // The family geometry's atrium → catalog conversion (§7.4), re-exported
    // by house/terminal generators; null elsewhere (kit.atrium then throws).
    atriumAsCatalog: gen.atriumAsCatalog ?? null,
    // The generator's fill-light spec (tiles/fillLight.js), applied by
    // finishBake after the tile program; null skips the pass.
    light: gen.light ?? null,
    kit: null,
    params: null,
    exits: [],
    spawns: [],
    notes: [],
  }
  ctx.kit = makeWorldKit(ctx, canvas)
  ctx.params = gen.paramsFor ? gen.paramsFor(ctx) ?? {} : {}
  return ctx
}

const remapError = (code, d, i, v) =>
  new Error(`${code} (chunk ${d.cx},${d.cy},${d.cz} cell ${i}: ${v >>> 0})`)

// §6.6 finish: per exported chunk, structure-id cells pass through (and must
// belong to a descriptor stamped into that chunk), local space ids are
// range-checked and remapped to spaceIdOf(k, local), record fields holding a
// space id are remapped alike, the stamp's edge protection is cleared, door
// passages are normalised, and the furniture off-switch is applied.
export function finishBake(canvas, ctx, k, t0 = performance.now()) {
  const chunks = canvas.exportChunks()
  const planned = new Set()
  for (const s of ctx.structures ?? []) if (s && Number.isInteger(s.id)) planned.add(s.id >>> 0)
  const remap = (d, ids, v, i) => {
    if (v === 0) return 0
    if (v >= STRUCTURE_ID_BIT) {
      if (!ids.has(v)) throw remapError('bake:stray-structure-id', d, i, v)
      return v
    }
    if (v < 1 || v > LOCAL_SPACE_MASK) throw remapError('bake:local-id-range', d, i, v)
    return spaceIdOf(k, v)
  }
  for (const d of chunks.values()) {
    const ids = new Set()
    for (const s of [d.structure, d.structureUp, d.structureDown]) {
      if (s && Number.isInteger(s.id) && planned.has(s.id >>> 0)) ids.add(s.id >>> 0)
    }
    const sid = d.spaceId
    for (let i = 0; i < sid.length; i++) if (sid[i]) sid[i] = remap(d, ids, sid[i], i)
    for (const [field, keys] of Object.entries(SPACE_ID_RECORD_FIELDS)) {
      if (!keys.length || !Array.isArray(d[field])) continue
      for (const rec of d[field]) {
        for (const key of keys) if (Number.isInteger(rec[key]) && rec[key]) rec[key] = remap(d, ids, rec[key], -1)
      }
    }
    d._protV.clear()
    d._protH.clear()
    normalizeDoorPassages(d)
    if (!ctx.furniture) {
      d.furniture = []
      for (let i = 0; i < d.cols.length; i++) if (d.cols[i] === COLUMN_FURNITURE) d.cols[i] = 0
    }
  }
  // Fill light (I-playfix): plain fixtures over the cells the tile's own
  // lamps leave dark, after the furniture switch so cleared cells count.
  const fill = resolveFillSpec(ctx.light, ctx)
  if (fill) {
    const n = fillDarkCells(chunks, fill)
    if (n) ctx.notes.push(`fill-light: ${n} fixtures`)
  }
  const ms = performance.now() - t0
  return Object.freeze({
    key: Object.freeze({ ...k }),
    chunks,
    exits: Object.freeze(ctx.exits.map((c) => Object.freeze({ ...c }))),
    spawns: Object.freeze(ctx.spawns.map((c) => Object.freeze({ ...c }))),
    notes: Object.freeze([...ctx.notes]),
    stats: Object.freeze({ ...canvas.stats }),
    fallback: false,
    attempts: (ctx.attempt ?? 0) + 1,
    ms,
  })
}

// Every attempt failed: an all-solid tile (every slice missing → solidChunk).
function fallbackBake(k, notes, t0) {
  recordFallback()
  return Object.freeze({
    key: Object.freeze({ ...k }),
    chunks: new Map(),
    exits: Object.freeze([]),
    spawns: Object.freeze([]),
    notes: Object.freeze([...notes]),
    stats: Object.freeze({ scratchWalkableWrites: 0, chunksCreated: 0, untouchedKept: 0, massFilledCells: 0 }),
    fallback: true,
    attempts: MAX_ATTEMPTS,
    ms: performance.now() - t0,
  })
}

// §6.6: bake tile key k → Object.freeze({ key, chunks: Map, exits, spawns,
// notes, stats, fallback, attempts, ms }). Uncached; buildFamilyChunk and the
// gates go through the cache. planSeed is FIXED (attempt 0's seed); a retry
// (the tile program returned { error }) changes only ctx.tileSeed. A throw
// from the tile program or the kit propagates (a contract violation, never
// retried).
export function bakeTile(gen, profile, worldSeed, config, k) {
  const t0 = performance.now()
  const seed0 = worldSeed >>> 0
  const family = profile.family
  const record = familyRecord(family)
  const planSeed = tileSeed(seed0, gen.tile.salt, k)
  const keep = keepOf(gen, seed0, k, profile)
  const district = { dx: k.tx, dz: k.tz }
  const solidAt = (gcx, gcy, gcz) => solidChunk(seed0, gcx, gcy, gcz, config, family, { district })
  const planner = familyPlanner(family)
  const structures = planner ? planner.structuresInTile(seed0, k, profile, config) : Object.freeze([])
  const notes = []
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const canvas = new TileCanvas({
      family,
      base: record?.base ?? family,
      version: config?.version,
      worldSeed: seed0,
      origin: k.origin,
      keep,
      district,
      solidChunk: solidAt,
    })
    const seed = attempt ? (hash2iAttempt(planSeed, attempt)) : planSeed
    const ctx = makeTileCtx(gen, profile, seed0, config, k, canvas, { tileSeed: seed, planSeed, structures, attempt })
    const res = gen.bake(canvas, ctx)
    if (!res?.error) {
      const bake = finishBake(canvas, ctx, k, t0)
      recordBake(bake.ms)
      return bake
    }
    notes.push(`attempt ${attempt}: ${res.error}`)
  }
  const bake = fallbackBake(k, notes, t0)
  recordBake(bake.ms)
  return bake
}

// Per-attempt tile seed (§6.6): hash2i(planSeed, attempt, 0x7e) >>> 0.
const hash2iAttempt = (planSeed, attempt) => hash2i(planSeed, attempt, 0x7e) >>> 0

// The cached bake of tile k (bakes and caches on a miss).
function cachedBake(gen, profile, worldSeed, config, k) {
  const key = keyString(profile.family, worldSeed, configSignature(config, profile), k)
  let bake = tileCache.get(gen, key)
  if (!bake) {
    bake = bakeTile(gen, profile, worldSeed, config, k)
    tileCache.set(gen, key, bake)
  }
  return bake
}

// --- the chunk -----------------------------------------------------------------------

// §6.7: the liminal branch of buildChunk. Returns the chunk's ChunkData.
//   gen       the family generator (families/generators.js familyGenerator)
//   profile   resolveMapFamily(config)
//   seed      world seed >>> 0
//   exitCell  {lx, lz} | null — sets data.exit (no carve)
//   clearings [{lx, lz, r?, family?}] | null — only entries with family: true
//             carve (the legacy hub clearing is ignored; the liminal spawn
//             passes [])
export function buildFamilyChunk(gen, profile, seed, cx, cy, cz, config, exitCell = null, clearings = null) {
  const worldSeed = seed >>> 0
  const family = profile.family
  const k = tileKeyOf(gen.tile, cx, cy, cz)
  let data
  if (!k) {
    data = solidChunk(worldSeed, cx, cy, cz, config, family, { tile: gen.tile })
  } else if (gen.footprint(worldSeed, cx, cy, cz, profile) !== 'tile') {
    data = solidChunk(worldSeed, cx, cy, cz, config, family, { district: { dx: k.tx, dz: k.tz } })
  } else {
    const bake = cachedBake(gen, profile, worldSeed, config, k)
    const slice = bake.chunks.get(chunkKey3(cx, cy, cz))
    data = slice
      ? cloneChunkData(slice)
      : solidChunk(worldSeed, cx, cy, cz, config, family, { district: { dx: k.tx, dz: k.tz } })
  }
  if (exitCell) data.exit = { lx: exitCell.lx, lz: exitCell.lz }
  for (const c of clearings ?? []) {
    if (c?.family === true) data.carveClearing(c.lx, c.lz, c.r ?? config?.exit?.clearRadius ?? 1)
  }
  normalizeDoorPassages(data)
  return data
}

// --- gates ---------------------------------------------------------------------------

// The generator, profile and tile key of a liminal chunk, or null.
function liminalTileOf(seed, cx, cy, cz, config) {
  const profile = resolveMapFamily(config)
  const gen = familyGenerator(profile.family)
  if (!gen) return null
  const k = tileKeyOf(gen.tile, cx, cy, cz)
  if (!k || gen.footprint(seed >>> 0, cx, cy, cz, profile) !== 'tile') return null
  return { gen, profile, k }
}

// §6.6: true when building (seed, cx, cy, cz) under `config` would bake a
// tile (liminal family, footprint 'tile', key not cached). Never throws.
export function wouldBakeChunk(seed, cx, cy, cz, config) {
  try {
    const t = liminalTileOf(seed, cx, cy, cz, config)
    if (!t) return false
    const key = keyString(t.profile.family, seed >>> 0, configSignature(config, t.profile), t.k)
    return !tileCache.has(t.gen, key)
  } catch {
    return false
  }
}

// The cached bake of tile key k (a full key, or just {tx, tz, band}) of the
// family `config` selects, baking it on a miss; null for legacy families and
// keys outside the family's tiles. Diagnostics and the family harness read
// its `stats`, `notes` and `ms`; never mutate it.
export function tileBakeAt(seed, k, config) {
  const profile = resolveMapFamily(config)
  const gen = familyGenerator(profile.family)
  if (!gen || !k) return null
  const key = k.origin ? k : tileKeyAt(gen.tile, k.tx, k.tz, k.band)
  if (!key) return null
  return cachedBake(gen, profile, seed >>> 0, config, key)
}

// §6.6: the bake's exit candidates (frozen GLOBAL cells {gx, gz, cy}) for tile
// key k — a full key, or just {tx, tz, band}. [] for legacy families and keys
// outside the family's tiles.
export function bakeExitsAt(seed, k, config) {
  return tileBakeAt(seed, k, config)?.exits ?? []
}

// §6.6/§9.7: bake the tile containing (cx, cy, cz) into the cache only;
// returns whether it baked. Never throws for a non-liminal config.
export function prebakeTile(seed, cx, cy, cz, config) {
  if (!wouldBakeChunk(seed, cx, cy, cz, config)) return false
  const t = liminalTileOf(seed, cx, cy, cz, config)
  cachedBake(t.gen, t.profile, seed >>> 0, config, t.k)
  return true
}
