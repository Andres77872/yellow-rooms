import { CHUNK } from '../../constants.js'
import { assembleCatalogDescriptor } from '../../structures/catalog/engine.js'
import { planPick, structureId, tileKeyOf } from '../../tiles/tileKey.js'
import { BASIN, DECK, FAMILY, PICK_ATTEMPTS, TILE, planSeedOf, poolPlan, stairCore, tileVolumes } from './geometry.js'

// The poolrooms structure planner (spec §7.2, §12.4): the pool volumes of a
// tile — 2 to 4, rolled by geometry.volumesOf from its planSeed (a natatio
// vault rising to the gallery or not, 0–2 lap halls, always one pit room, a
// stepped plunge basin or not; each sized, turned and placed per tile) —
// assembled as 'poolroomsCatalog' descriptors at TRUE GLOBAL coordinates, in
// slot order. The tile program (tile.js) draws the same plans through
// ctx.kit.catalog, which looks each volume up here by slot and proves the
// plans equal.
//
// Planner-chain module (§7.5): imports only the allowlist (constants, the
// catalog engine, core/hash.js, tiles/tileKey.js and this family's geometry.js).

const CACHE_MAX = 512
const cache = new Map() // `${worldSeed}|${tx},${tz},${band}` → frozen list (LRU)

const shiftRect = (r, dx, dz) => ({ x0: r.x0 + dx, z0: r.z0 + dz, x1: r.x1 + dx, z1: r.z1 + dz })

// A kind-local plan at the tile's origin: every cell rect by origin·CHUNK.
function translatePlan(plan, origin) {
  const dx = origin.cx * CHUNK
  const dz = origin.cz * CHUNK
  return {
    ...plan,
    bounds: shiftRect(plan.bounds, dx, dz),
    levels: plan.levels.map((l) => ({ voids: (l.voids ?? []).map((r) => shiftRect(r, dx, dz)) })),
  }
}

function assemble(worldSeed, k) {
  const planSeed = planSeedOf(worldSeed, k)
  const out = []
  for (const spec of tileVolumes(worldSeed, k.tx, k.tz)) {
    const slot = spec.slot
    const plan = poolPlan(spec)
    const meta = {
      id: structureId(worldSeed, FAMILY, k, slot),
      family: FAMILY,
      type: spec.type,
      sizeClass: spec.sizeClass,
      district: { x: k.tx, z: k.tz, size: TILE.w },
      bandIndex: k.band,
      slot,
      baseCy: k.origin.cy + BASIN,
    }
    const world = translatePlan(plan, k.origin)
    let desc = null
    for (let attempt = 0; attempt < PICK_ATTEMPTS && !desc; attempt++) {
      desc = assembleCatalogDescriptor(world, meta, planPick(planSeed, slot, attempt))
    }
    out.push(desc)
  }
  return Object.freeze(out)
}

// §7.2: the tile's volumes, frozen and slot-sorted (a failed slot is null).
function structuresInTile(worldSeed, k) {
  const seed = worldSeed >>> 0
  const key = `${seed}|${k.tx},${k.tz},${k.band}`
  let list = cache.get(key)
  if (list) {
    cache.delete(key)
    cache.set(key, list)
    return list
  }
  list = assemble(seed, k)
  cache.set(key, list)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return list
}

// The volume owning chunk (cx, cz) on storey cy: the SAME object as its
// structuresInTile element, or null.
function structureAt(worldSeed, cx, cz, cy) {
  const k = tileKeyOf(TILE, cx, cy, cz)
  if (!k) return null
  for (const s of structuresInTile(worldSeed, k)) {
    if (!s || cy < s.baseCy || cy > s.topCy) continue
    if (s.participants.some((p) => p.cx === cx && p.cz === cz)) return s
  }
  return null
}

// Streaming hint (§9.7): true wherever a volume spans the slab between
// lowerCy and lowerCy + 1 over chunk (cx, cz) — a superset of the chunks
// whose stairs or slab slices open upward there — and over the chunk of the
// tile's stair core (geometry.stairCore, deck to gallery).
function verticalOpeningAt(worldSeed, cx, cz, lowerCy) {
  const s = structureAt(worldSeed, cx, cz, lowerCy)
  if (s && lowerCy < s.topCy) return true
  const k = tileKeyOf(TILE, cx, lowerCy, cz)
  if (!k || lowerCy !== k.origin.cy + DECK) return false
  const core = stairCore(planSeedOf(worldSeed >>> 0, k), tileVolumes(worldSeed >>> 0, k.tx, k.tz))
  return !!core && k.origin.cx + Math.floor(core.core.x0 / CHUNK) === cx && k.origin.cz + Math.floor(core.core.z0 / CHUNK) === cz
}

export default Object.freeze({
  stub: false,
  structuresInTile,
  structureAt,
  verticalOpeningAt,
})
