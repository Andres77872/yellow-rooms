import { tileKeyOf } from '../../tiles/tileKey.js'
import { TILE, hallsOf } from './geometry.js'

// The playplace structure planner (spec §7.2, §12.9): the play halls of every
// module (slots 0..1: a frame, a ball-pit hall, a food court or a fortress,
// two or three storeys), each a 'playplaceCatalog' descriptor at TRUE GLOBAL
// coordinates. geometry.hallsOf composes them (positions, sizes, types,
// voids, bridges and posts from the module's planSeed) and assembles each
// with planPick(planSeed, slot, attempt) until the catalog engine accepts
// it; the tile program (tile.js) draws the same plans through
// ctx.kit.catalog, which looks each volume up by slot and proves the plans
// equal.
//
// Planner-chain module (§7.5): imports only the allowlist (tiles/tileKey.js
// and this family's geometry.js).

const CACHE_MAX = 512
const cache = new Map() // `${worldSeed}|${tx},${tz},${band}` → frozen list (LRU)

function assemble(worldSeed, k) {
  if (k.band !== 0) return Object.freeze([])
  return Object.freeze(hallsOf(worldSeed, k.tx, k.tz).map((h) => (h ? h.desc : null)))
}

// §7.2: the module's volumes, frozen and slot-sorted (a failed slot is null).
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

// Streaming hint (§9.7): true wherever a hall spans the slab between
// lowerCy and lowerCy + 1 over chunk (cx, cz).
function verticalOpeningAt(worldSeed, cx, cz, lowerCy) {
  const s = structureAt(worldSeed, cx, cz, lowerCy)
  return !!s && lowerCy < s.topCy
}

export default Object.freeze({
  stub: false,
  structuresInTile,
  structureAt,
  verticalOpeningAt,
})
