// Semantic map vocabulary shared by generation, rendering, debug tools and
// tests. Walls remain the collision truth; passage kinds explain *why* an edge
// is open so consumers no longer have to guess doors from raster patterns.

export const PASSAGE_WALL = 0
export const PASSAGE_OPEN = 1
export const PASSAGE_DOOR = 2
export const PASSAGE_WIDE = 3

export const CELL_OPEN = 0
export const CELL_ROOM = 1
export const CELL_CORRIDOR = 2
export const CELL_LOBBY = 3
export const CELL_STAIR = 4 // stair landing/run cells (v8; see world/slab.js)
export const CELL_ATRIUM = 5 // lower hall of a room open through the slab above
export const CELL_VOID = 6 // non-walkable upper-floor opening over an atrium
export const CELL_BRIDGE = 7 // narrow retained deck crossing an atrium void

// Column byte values. Navigation deliberately treats both as a blocked cell;
// rendering and swept collision retain the physical size so a monumental pier
// is more than a differently colored ordinary post.
export const COLUMN_NONE = 0
export const COLUMN_STANDARD = 1
export const COLUMN_MONUMENTAL = 2
// A cell occupied by furniture (desk, chair, table, cabinet...). Navigation,
// maps, audits and placement treat it as blocked like any column, but the
// precise walkable AABB lives in ChunkData.furniture: swept collision resolves
// the real footprint (a desk is not a 3u square), and eye-height sight lines
// pass over the low pieces (columnHalfAt returns 0 for this kind).
export const COLUMN_FURNITURE = 3

// A closed edge can still have a visual/sight role.  The collision raster and
// PASSAGE_WALL remain authoritative for movement; these features only refine
// how that blocked edge is meshed and whether it occludes sight.  Keeping the
// roles separate prevents an observation window or bridge guard from becoming
// an accidental doorway.
export const WALL_PLAIN = 0
export const WALL_WINDOW = 1
export const WALL_RAIL = 2

export const wallFeatureSeesThrough = (feature) =>
  feature === WALL_WINDOW || feature === WALL_RAIL

export const isPassageOpen = (kind) => kind !== PASSAGE_WALL

// Semantic room roles (v15). Assigned per office-district space at plan time
// (officePlan.js) and compiled into ChunkData.spaceRole; topology never
// changes — roles steer the dressing layer (furniture composition, wall
// props, signage) so districts read as named places: meeting rooms, break
// rooms, copy rooms, archives, server rooms, storage. Ordinary rooms keep
// SPACE_ROLE_NONE and furnish generically.
export const SPACE_ROLE_NONE = 0
export const SPACE_ROLE_MEETING = 1
export const SPACE_ROLE_BREAK = 2
export const SPACE_ROLE_COPY = 3
export const SPACE_ROLE_ARCHIVE = 4
export const SPACE_ROLE_SERVER = 5
export const SPACE_ROLE_STORAGE = 6
