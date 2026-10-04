import { CHUNK } from '../../constants.js'
import { assembleCatalogDescriptor } from '../../structures/catalog/engine.js'
import { planPick, structureId, tileKeyOf } from '../../tiles/tileKey.js'
import { FAMILY, PICK_ATTEMPTS, TILE, planSeedOf, schemeOf, volumePlan } from './geometry.js'

// The theater structure planner (spec §7.2, §12.8): every tile's house —
// slot 0, a 'theaterCatalog' volume (opera house, proscenium house or small
// house: its chunks, storeys, bounds, orientation, voids, catwalks, piers and
// core all rolled by the tile's scheme, geometry.schemeOf) — assembled at
// TRUE GLOBAL coordinates. The tile program (tile.js) draws the same plan
// through ctx.kit.catalog, which looks the volume up here by slot and proves
// the plans equal. The band's stairwells (0..2 per tile, the scheme's stair
// slots) are stair descriptors (kit.stairwell), not volumes:
// verticalOpeningAt covers their chunks too.
//
// Planner-chain module (§7.5): imports only the allowlist (constants, the
// catalog engine, tiles/tileKey.js and this family's geometry.js).

const SLOTS = [0]
const CACHE_MAX = 512
const cache = new Map() // `${worldSeed}|${tx},${tz},${band}` → frozen list (LRU)

const shiftRect = (r, dx, dz) => ({ x0: r.x0 + dx, z0: r.z0 + dz, x1: r.x1 + dx, z1: r.z1 + dz })

// A kind-local plan at the tile's origin: every cell rect and cell by origin·CHUNK.
function translatePlan(plan, origin) {
  const dx = origin.cx * CHUNK
  const dz = origin.cz * CHUNK
  return {
    ...plan,
    bounds: shiftRect(plan.bounds, dx, dz),
    levels: plan.levels.map((l) => ({
      voids: (l.voids ?? []).map((r) => shiftRect(r, dx, dz)),
      ...(l.bridges ? { bridges: l.bridges.map((r) => shiftRect(r, dx, dz)) } : {}),
    })),
    columns: (plan.columns ?? []).map((c) => ({ ...c, gx: c.gx + dx, gz: c.gz + dz })),
    piers: (plan.piers ?? []).map((c) => ({ ...c, gx: c.gx + dx, gz: c.gz + dz })),
    core: plan.core ? { ...plan.core, gx: plan.core.gx + dx, gz: plan.core.gz + dz } : null,
  }
}

function assemble(worldSeed, k) {
  const planSeed = planSeedOf(worldSeed, k)
  // The theatre (doc 11 §4), pure in the world seed and the tile.
  const scheme = schemeOf(worldSeed, k)
  const out = []
  for (const slot of SLOTS) {
    const { plan, baseCy, type, sizeClass } = volumePlan(slot, scheme)
    const meta = {
      id: structureId(worldSeed, FAMILY, k, slot),
      family: FAMILY,
      type,
      sizeClass,
      district: { x: k.tx, z: k.tz, size: TILE.w },
      bandIndex: k.band,
      slot,
      baseCy: k.origin.cy + baseCy,
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

// Streaming hint (§9.7): true wherever the house spans the slab between
// lowerCy and lowerCy + 1 over chunk (cx, cz), and on a band stairwell's
// chunk over the basement and the ground floor (its flights up).
function verticalOpeningAt(worldSeed, cx, cz, lowerCy) {
  const s = structureAt(worldSeed, cx, cz, lowerCy)
  if (s && lowerCy < s.topCy) return true
  const k = tileKeyOf(TILE, cx, lowerCy, cz)
  if (!k) return false
  const rel = lowerCy - k.origin.cy
  if (rel < 0 || rel > 1) return false
  const lx = cx - k.origin.cx
  const lz = cz - k.origin.cz
  return schemeOf(worldSeed, k).skeleton.stairs.some((t) => t.cx === lx && t.cz === lz)
}

export default Object.freeze({
  stub: false,
  structuresInTile,
  structureAt,
  verticalOpeningAt,
})
