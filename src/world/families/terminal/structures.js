import { tileKeyOf } from '../../tiles/tileKey.js'
import { ATRIUM_SLOTS, TILE, assembleAtrium, layoutOf, stairSlots } from './geometry.js'

// The terminal structure planner (spec §7.2, §7.4, §12.7): one or two
// 'terminalCatalog' volumes per tile, slots 0 and 1, the spine atria. Its geometry
// is the tile grammar's (geometry.layoutOf: the x span, length, bridges and
// the spine's rows vary tile to tile), converted by geometry.atriumAsCatalog
// and assembled at TRUE GLOBAL coordinates (geometry.assembleAtrium). A tile
// whose chunk columns the serpentine and the landside leave no run for
// carries no atrium (an empty list). The tile program (tile.js) reaches the
// volume through ctx.kit.atrium, which looks it up here by slot and proves
// the plans equal.
//
// The service stairs (pier and mezzanine stairwell cores) are not volumes;
// stairSlots lists their chunk-storeys and picks whose flight lands on one
// are rejected (the pier cores sit in chunk rows 0 and 3; an atrium over the
// mezzanine core's column is laid out only where its flight finds the other
// column), and verticalOpeningAt reports them.
//
// Planner-chain module (§7.5): imports only the allowlist (tiles/tileKey.js
// and this family's geometry.js).

const CACHE_MAX = 512
const cache = new Map() // `${worldSeed}|${tx},${tz},${band}` → frozen list (LRU)
const EMPTY = Object.freeze([])

function assemble(worldSeed, k) {
  if (k.tz !== 0) return EMPTY
  const out = []
  const atria = layoutOf(worldSeed, k.tx).atria
  for (let slot = 0; slot < ATRIUM_SLOTS; slot++) if (atria[slot]) out.push(assembleAtrium(worldSeed, k, atria[slot], stairSlots(worldSeed, k)))
  return out.length ? Object.freeze(out) : EMPTY
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

// Streaming hint (§9.7): true wherever the atrium spans the slab between
// lowerCy and lowerCy + 1 over chunk (cx, cz), or a service stair core climbs
// from lowerCy there.
function verticalOpeningAt(worldSeed, cx, cz, lowerCy) {
  const s = structureAt(worldSeed, cx, cz, lowerCy)
  if (s && lowerCy < s.topCy) return true
  const k = tileKeyOf(TILE, cx, lowerCy, cz)
  if (!k) return false
  return stairSlots(worldSeed >>> 0, k).some((t) => t.cx === cx && t.cz === cz && t.lowerCy === lowerCy)
}

export default Object.freeze({
  stub: false,
  structuresInTile,
  structureAt,
  verticalOpeningAt,
})
