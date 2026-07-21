import { CHUNK, ZONE_OFFICE, ZONE_SEWER, FURN_MARGIN, cIdx } from './constants.js'
import { CELL_ROOM, MAP_FAMILY_SEWER, PASSAGE_DOOR, PASSAGE_WIDE } from './mapTypes.js'
import { countChunkComponents } from './topology.js'
import { cellEdges, furnishOrdinaryRoom, furnishRoleRoom } from './rooms/furnish.js'

// Furniture placement (v23) — collision-real furniture, deterministic per
// chunk from global coordinates. Every occupied cell enters the cols raster
// as COLUMN_FURNITURE, so enemies, minimaps, audits and placement queries
// treat it as blocked; the player sweeps the precise piece AABB in
// ChunkData.furniture instead of the coarse cell.
//
// Placement contract:
//   - rooms only (CELL_ROOM cells of a real space): office-fabric rooms in
//     the office/tower/lattice families, and the prescribed chambers of the
//     sewer family (zones/sewer.js graduates them to CELL_ROOM);
//   - a 2-cell margin off chunk borders, so two chunks can never stamp
//     overlapping pieces of the same cross-seam room;
//   - never on doorway/mouth approach cells, lamps, columns, or slab holes;
//   - rooms are furnished SPARSELY (empty rooms are a feature of the genre);
//   - the chunk's column-aware component count must equal the pre-furniture
//     baseline at every step — each piece is verified at placement time and a
//     severing piece is refused (see rooms/furnish.js addPiece).
//
// Coherence contract: every room furnishes from ONE grammar. What that
// grammar IS lives in the room catalog (rooms/catalog.js): role rooms always
// receive their anchor piece and draw only whitelisted kinds; ordinary rooms
// elect a theme from their district-stable space id. Sewer chambers never
// elect ordinary themes — a dry service tunnel has no whiteboards to find:
// an unelected chamber stays bare. This module is only the per-chunk
// placement entry — it collects each room slice's candidate cells and hands
// them to the grammar interpreter (rooms/furnish.js).

// Piece-kind vocabulary: canonical home is rooms/catalog.js; re-exported here
// so the existing import surface (models, meshing, tests) keeps working.
export {
  FURN_DESK,
  FURN_CHAIR,
  FURN_TABLE,
  FURN_CABINET,
  FURN_COPIER,
  FURN_COOLER,
  FURN_PLANT,
  FURN_RACK,
  FURN_SOFA,
  FURN_BOOKSHELF,
  FURN_WHITEBOARD,
} from './rooms/catalog.js'

function isFreeCandidate(data, lampCells, x, z) {
  if (x < FURN_MARGIN || x >= CHUNK - FURN_MARGIN) return false
  if (z < FURN_MARGIN || z >= CHUNK - FURN_MARGIN) return false
  if (data.cellKind[cIdx(x, z)] !== CELL_ROOM) return false
  if (data.colAt(x, z)) return false
  if (data.hasFloorHole(x, z) || data.hasCeilHole(x, z)) return false
  if (lampCells.has(`${x},${z}`)) return false
  for (const e of cellEdges(data, x, z)) {
    if (e.passage === PASSAGE_DOOR || e.passage === PASSAGE_WIDE) return false
  }
  return true
}

export function placeFurniture(data, ctx) {
  const { zone, config } = ctx
  if (config.furniture?.enabled === false) return 0
  // Two furnishable fabrics: office-family rooms (office/tower/lattice all
  // plan office districts) and the sewer family's prescribed chambers. Every
  // other zone (pillars, warehouse halls) stays empty by design.
  if (zone !== ZONE_OFFICE && zone !== ZONE_SEWER) return 0
  const baseline = countChunkComponents(data, true)
  const lampCells = new Set(data.lamps.map((l) => `${l.lx},${l.lz}`))

  // Group room cells by space id (chunk-local slice of the district plan).
  const spaces = new Map()
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      if (data.cellKind[cIdx(x, z)] !== CELL_ROOM) continue
      const id = data.spaceId[cIdx(x, z)]
      if (!id) continue
      if (!spaces.has(id)) spaces.set(id, { id, cells: [], x0: x, z0: z, x1: x, z1: z, area: 0 })
      const s = spaces.get(id)
      s.cells.push({ lx: x, lz: z, gx: data.cx * CHUNK + x, gz: data.cz * CHUNK + z })
      s.x0 = Math.min(s.x0, x)
      s.z0 = Math.min(s.z0, z)
      s.x1 = Math.max(s.x1, x)
      s.z1 = Math.max(s.z1, z)
      s.area++
    }
  }

  const ctx2 = { data, added: [], baseline }
  for (const space of [...spaces.values()].sort((a, b) => a.id - b.id)) {
    const candidates = space.cells.filter((c) => isFreeCandidate(data, lampCells, c.lx, c.lz))
    if (candidates.length < 3) continue
    const role = data.spaceRole[cIdx(space.cells[0].lx, space.cells[0].lz)]
    if (role) {
      // Special-role rooms are always furnished: the role IS the furnishing.
      furnishRoleRoom(ctx2, space, candidates, role)
    } else if (data.mapFamily !== MAP_FAMILY_SEWER) {
      // Ordinary rooms elect one coherent theme — except in the sewer, where
      // an unelected chamber stays bare (no office props underground).
      furnishOrdinaryRoom(ctx2, space, candidates)
    }
  }
  return ctx2.added.length
}
