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
