import { CHUNK, WORLD_GEN_VERSION, ZONE_OFFICE } from '../constants.js'
import { ChunkData } from '../ChunkData.js'
import { COLUMN_STANDARD, PASSAGE_OPEN, WALL_PLAIN } from '../mapTypes.js'
import { CHUNK_DESCRIPTORS } from './cloneChunk.js'

// Whole-chunk solid mass of a liminal family (spec §6.7 step 1, §9.6a).
//
// A chunk whose footprint is 'solid' (or that lies outside the family's
// storeys/rows) is never baked: buildFamilyChunk returns this instead. It is
// every column COLUMN_STANDARD, every cell CELL_OPEN with spaceId 0 and no
// role, walls 0 and passages/features at their defaults, and no lamps,
// furniture, stairs, structure slices or exit. worldSeed and district are set
// so finish/dressing context reads never see a stale chunk.
//
//   solidChunk(seed, cx, cy, cz, config, family, { district, tile } = {})
//     seed     world seed (stored >>> 0 as data.worldSeed)
//     config   world config; data.version = config.version ?? WORLD_GEN_VERSION
//     family   map-family id (data.mapFamily)
//     district optional planner district {dx, dz} (the tile key's {tx, tz})
//     tile     optional family TILE {w, d}: when no district is given, the
//              district is derived as {dx: floor(cx / w), dz: floor(cz / d)},
//              so the null-key path (tileKeyOf → null) still sets it (§6.7
//              step 1). Neither given → district null.
export function solidChunk(seed, cx, cy, cz, config, family, { district = null, tile = null } = {}) {
  const version = config?.version ?? WORLD_GEN_VERSION
  const data = new ChunkData(cx, cy, cz, ZONE_OFFICE, version, family)
  data.cols.fill(COLUMN_STANDARD)
  data.worldSeed = seed >>> 0
  data.district = district ? { dx: district.dx, dz: district.dz } : districtOfTile(cx, cz, tile)
  return data
}

function districtOfTile(cx, cz, tile) {
  const w = tile?.w
  const d = tile?.d
  if (!(Number.isInteger(w) && w > 0 && Number.isInteger(d) && d > 0)) return null
  return { dx: Math.floor(cx / w), dz: Math.floor(cz / d) }
}

const N = CHUNK * CHUNK

// True when `data` is whole-chunk solid mass in the §9.6a sense: all 196
// columns COLUMN_STANDARD; walls 0, passages PASSAGE_OPEN and wall features
// WALL_PLAIN on both axes; no lamps, furniture, exit, stairs, structure
// slices or other descriptor carriers. cellKind/spaceId are not read: under
// a standard column they never reach collision, navigation or the mesher.
// Pure; never throws on a ChunkData-shaped input.
export function isSolidMassChunk(data) {
  if (!data) return false
  if (data.lamps?.length || data.furniture?.length || data.exit) return false
  for (const field of CHUNK_DESCRIPTORS) if (data[field]) return false
  const { cols, wallV, wallH, passageV, passageH, wallFeatureV, wallFeatureH } = data
  for (let i = 0; i < N; i++) {
    if (cols[i] !== COLUMN_STANDARD) return false
    if (wallV[i] || wallH[i]) return false
    if (passageV[i] !== PASSAGE_OPEN || passageH[i] !== PASSAGE_OPEN) return false
    if (wallFeatureV[i] !== WALL_PLAIN || wallFeatureH[i] !== WALL_PLAIN) return false
  }
  return true
}
