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

export const isPassageOpen = (kind) => kind !== PASSAGE_WALL
