import { CHUNK, cIdx } from './constants.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_LOBBY,
  CELL_VOID,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  WALL_RAIL,
  WALL_WINDOW,
} from './mapTypes.js'
import { chunkMultilevelRooms } from './multilevel.js'

// Compile one chunk/floor slice of a canonical tall structure after ordinary
// zone topology and stairs, but before lamps/anomalies. The global contract is
// planned first, so the stair planner suppresses every slab that could touch
// this volume. Every participant independently derives the same footprint,
// height and per-storey bridge mask.
//
// Bottom storey: a completely open, windowless hall with a ceiling aperture.
// Higher storeys: a connected gallery ring, matched floor aperture, windows on
// every outer wall beside the void, and (on selected levels) a retained bridge
// with guarded flanks and two open approaches. Intermediate storeys can have a
// different bridge above and below; ChunkData therefore records separate up
// and down slab slices.

function setV(data, line, cell, wall, passage, feature) {
  data.setV(line, cell, wall, passage, feature)
  data.protectV(line, cell)
}

function setH(data, cell, line, wall, passage, feature) {
  data.setH(cell, line, wall, passage, feature)
  data.protectH(cell, line)
}

function labelRing(data, slice) {
  const { x0, z0, x1, z1 } = slice.localBounds
  for (let z = z0 - 1; z <= z1 + 1; z++) {
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      if (x < 0 || x >= CHUNK || z < 0 || z >= CHUNK) continue
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) continue
      data.cellKind[cIdx(x, z)] = CELL_LOBBY
    }
  }
}

const inside = (bounds, gx, gz) =>
  gx >= bounds.x0 && gx <= bounds.x1 && gz >= bounds.z0 && gz <= bounds.z1

// ChunkData.carveRect intentionally leaves owned border line 0 untouched.
// That is correct for ordinary chunk-local clearings, but a global structure
// crosses one such line. Open the owned West/North seams exactly where both
// adjacent global cells belong to the structure's carved footprint+ring.
function openOwnedStructureSeams(data, slice) {
  const volume = slice.globalBounds
  const carve = {
    x0: volume.x0 - 1,
    z0: volume.z0 - 1,
    x1: volume.x1 + 1,
    z1: volume.z1 + 1,
  }
  const lineGX = data.cx * CHUNK
  const lineGZ = data.cz * CHUNK
  for (let local = 0; local < CHUNK; local++) {
    const gz = lineGZ + local
    if (inside(carve, lineGX - 1, gz) && inside(carve, lineGX, gz)) {
      setV(data, 0, local, 0, PASSAGE_WIDE)
    }
    const gx = lineGX + local
    if (inside(carve, gx, lineGZ - 1) && inside(carve, gx, lineGZ)) {
      setH(data, local, 0, 0, PASSAGE_WIDE)
    }
  }
}

function carveStructure(data, slice) {
  const { x0, z0, x1, z1 } = slice.localBounds
  data.carveRect(x0 - 1, z0 - 1, x1 + 1, z1 + 1)
  openOwnedStructureSeams(data, slice)
  labelRing(data, slice)
}

function stampBottom(data, slice) {
  const { x0, z0, x1, z1 } = slice.localBounds
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      data.setCol(x, z, 0)
      data.cellKind[cIdx(x, z)] = CELL_ATRIUM
      data.spaceId[cIdx(x, z)] = slice.id
    }
  }
  // Deliberately no wall features here: the bottom remains a windowless hall
  // whose unobstructed stacked aperture pulls the player's view upward.
}

function stampOuterWindowsAndApproaches(data, slice) {
  const { x0, z0, x1, z1 } = slice.localBounds
  const global = slice.globalBounds
  const chunkGX = data.cx * CHUNK
  const chunkGZ = data.cz * CHUNK
  const bridge = slice.globalBridgeLine

  for (let z = z0; z <= z1; z++) {
    const gz = chunkGZ + z
    const isBridgeEnd = bridge !== null && slice.bridgeAxis === 'x' && gz === bridge
    for (const [x, gx] of [[x0, chunkGX + x0], [x1 + 1, chunkGX + x1 + 1]]) {
      if (gx !== global.x0 && gx !== global.x1 + 1) continue
      if (isBridgeEnd) setV(data, x, z, 0, PASSAGE_WIDE)
      else setV(data, x, z, 1, PASSAGE_WALL, WALL_WINDOW)
    }
  }

  for (let x = x0; x <= x1; x++) {
    const gx = chunkGX + x
    const isBridgeEnd = bridge !== null && slice.bridgeAxis === 'z' && gx === bridge
    for (const [z, gz] of [[z0, chunkGZ + z0], [z1 + 1, chunkGZ + z1 + 1]]) {
      if (gz !== global.z0 && gz !== global.z1 + 1) continue
      if (isBridgeEnd) setH(data, x, z, 0, PASSAGE_WIDE)
      else setH(data, x, z, 1, PASSAGE_WALL, WALL_WINDOW)
    }
  }
}

function stampBridgeGuards(data, slice) {
  if (slice.globalBridgeLine === null) return
  if (slice.bridgeAxis === 'x') {
    for (const { lx, lz } of slice.bridgeCells) {
      setH(data, lx, lz, 1, PASSAGE_WALL, WALL_RAIL)
      setH(data, lx, lz + 1, 1, PASSAGE_WALL, WALL_RAIL)
    }
  } else {
    for (const { lx, lz } of slice.bridgeCells) {
      setV(data, lx, lz, 1, PASSAGE_WALL, WALL_RAIL)
      setV(data, lx + 1, lz, 1, PASSAGE_WALL, WALL_RAIL)
    }
  }
}

function stampGallery(data, floorSlice) {
  for (const { lx, lz } of floorSlice.voidCells) {
    data.setCol(lx, lz, 0)
    data.cellKind[cIdx(lx, lz)] = CELL_VOID
    data.spaceId[cIdx(lx, lz)] = floorSlice.id
  }
  for (const { lx, lz } of floorSlice.bridgeCells) {
    data.setCol(lx, lz, 0)
    data.cellKind[cIdx(lx, lz)] = CELL_BRIDGE
    data.spaceId[cIdx(lx, lz)] = floorSlice.id
  }
  stampOuterWindowsAndApproaches(data, floorSlice)
  stampBridgeGuards(data, floorSlice)
}

export function stampMultilevelRooms(data, seed, cx, cy, cz, config) {
  const { structure, up, down } = chunkMultilevelRooms(seed, cx, cz, cy, config)
  if (!structure.hasRoom) return

  const surface = down.hasRoom ? down : up
  carveStructure(data, surface)
  if (cy === structure.baseCy) stampBottom(data, surface)
  else stampGallery(data, down)

  data.multilevelStructure = structure
  data.multilevelUp = up.hasRoom ? up : null
  data.multilevelDown = down.hasRoom ? down : null
}
