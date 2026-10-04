import { tileKeyOf } from '../../tiles/tileKey.js'
import { TILE, chunkIndex, frameOf, hallOf } from './geometry.js'

// The house structure planner (spec §7.2, §12.11). The Great Hall of every
// hall tile (always the exit tile; never the spawn tile) is a 'houseCatalog'
// volume in slot 0, assembled at TRUE GLOBAL coordinates by geometry.hallOf:
// the tile's frame names its chunk and a hashed order of hall shapes (void
// 5..9 × 4..7 cells, a 5-row gallery on its south, north or east side
// carrying the automatic flights, anywhere in the chunk); the first shape
// that assembles is the hall. The tile program (world.js) draws the same
// plan through ctx.kit.atrium (geometry.hallSpec → atriumAsCatalog), which
// looks the volume up by slot and proves the plans equal. The stair cores
// are stair descriptors (kit.stairwell), not volumes: they only feed the
// streaming hint.
//
// Planner-chain module (§7.5): imports only the allowlist (tiles/tileKey.js
// and this family's geometry.js).

const EMPTY = Object.freeze([])

// §7.2: the tile's volumes, frozen and slot-sorted (a failed slot is null).
// hallOf memoises per tile (LRU), and returns the same descriptor object.
const LISTS = new Map()
const LIST_MAX = 512
function structuresInTile(worldSeed, k) {
  const seed = worldSeed >>> 0
  const key = `${seed}|${k.tx},${k.tz},${k.band}`
  let list = LISTS.get(key)
  if (list) {
    LISTS.delete(key)
    LISTS.set(key, list)
    return list
  }
  const f = frameOf(seed, k.tx, k.tz)
  if (f.hallChunk < 0) list = EMPTY
  else list = Object.freeze([hallOf(seed, k)?.desc ?? null])
  LISTS.set(key, list)
  if (LISTS.size > LIST_MAX) LISTS.delete(LISTS.keys().next().value)
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

// Streaming hint (§9.7): every stair core's chunk holds a flight up on each
// storey below its top; the hall spans the slabs over its chunk.
function verticalOpeningAt(worldSeed, cx, cz, lowerCy) {
  const k = tileKeyOf(TILE, cx, lowerCy, cz)
  if (!k) return false
  const i = chunkIndex(cx - k.origin.cx, cz - k.origin.cz)
  for (const s of frameOf(worldSeed, k.tx, k.tz).stairs) {
    if (s.chunk === i && lowerCy >= k.cy0 && lowerCy < s.top) return true
  }
  const s = structureAt(worldSeed, cx, cz, lowerCy)
  return !!s && lowerCy < s.topCy
}

export default Object.freeze({
  stub: false,
  structuresInTile,
  structureAt,
  verticalOpeningAt,
})
