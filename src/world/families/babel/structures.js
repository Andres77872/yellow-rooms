import { structureId, tileKeyOf } from '../../tiles/tileKey.js'
import { FAMILY, TILE, flightAt, volumeOf } from './geometry.js'

// The babel structure planner (spec §7.2, §12.5): one 'babelCatalog' volume
// per block-band (slot 0) — the shafts of the rooms of the block-band's
// procedural layout (geometry.layoutOf) as voids on the band's levels 1..4
// and the in-band stair flights as its links — assembled at TRUE GLOBAL
// coordinates. The tile program (tile.js) builds the
// same draft kind-locally through ctx.kit.customCatalog, which looks this
// descriptor up by slot and proves the voids, links and level count equal.
//
// Planner-chain module (§7.5): imports only the allowlist (tiles/tileKey.js
// and this family's geometry.js, which imports the catalog engine).

const CACHE_MAX = 512
const cache = new Map() // `${worldSeed}|${tx},${tz},${band}` → frozen list (LRU)

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
  list = Object.freeze([volumeOf(seed, k, structureId(seed, FAMILY, k, 0))])
  cache.set(key, list)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return list
}

// The volume owning chunk (cx, cz) on storey cy: the SAME object as its
// structuresInTile element (every chunk of every storey has one).
function structureAt(worldSeed, cx, cz, cy) {
  const k = tileKeyOf(TILE, cx, cy, cz)
  if (!k) return null
  for (const s of structuresInTile(worldSeed, k)) {
    if (!s || cy < s.baseCy || cy > s.topCy) continue
    if (s.participants.some((p) => p.cx === cx && p.cz === cz)) return s
  }
  return null
}

// Streaming hint (§9.7): the slab above lowerCy is open over chunk (cx, cz)
// inside a band (the shafts and the volume's flights), and at a band's top
// storey wherever a band-boundary flight climbs.
function verticalOpeningAt(worldSeed, cx, cz, lowerCy) {
  const s = structureAt(worldSeed, cx, cz, lowerCy)
  if (s && lowerCy < s.topCy) return true
  return !!flightAt(worldSeed >>> 0, cx, cz, lowerCy)
}

export default Object.freeze({
  stub: false,
  structuresInTile,
  structureAt,
  verticalOpeningAt,
})
