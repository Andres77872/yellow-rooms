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

// Realize a canonical two-floor multilevel-room contract after ordinary zone
// topology and stairs, but before lamps/anomalies. Contracts reject every stair
// touching either participating layer, so this stamp can reserve a large room
// without competing for vertical structure.
//
// Lower half: a completely opened wide hall whose ceiling is absent at every
// footprint cell except the bridge underside.
// Upper half: a connected one-cell gallery ring, matched floor void, retained
// narrow bridge deck, collision-solid observation windows around the void, and
// collision-solid low guards along the bridge. Every structural edge is
// protected so a late exit/spawn clearing cannot erase it.

function setV(data, line, cell, wall, passage, feature) {
  data.setV(line, cell, wall, passage, feature)
  data.protectV(line, cell)
}

function setH(data, cell, line, wall, passage, feature) {
  data.setH(cell, line, wall, passage, feature)
  data.protectH(cell, line)
}

function labelRing(data, room) {
  const { x0, z0, x1, z1 } = room.bounds
  for (let z = z0 - 1; z <= z1 + 1; z++) {
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      if (x < 0 || x >= CHUNK || z < 0 || z >= CHUNK) continue
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) continue
      data.cellKind[cIdx(x, z)] = CELL_LOBBY
    }
  }
}

function stampLower(data, room) {
  const { x0, z0, x1, z1 } = room.bounds
  // Opening the ring as part of the same monotone carve guarantees that the
  // wide hall connects to every surviving approach and contains no leftover
  // room partitions or columns beneath the vertical volume.
  data.carveRect(x0 - 1, z0 - 1, x1 + 1, z1 + 1)
  labelRing(data, room)
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      data.cellKind[cIdx(x, z)] = CELL_ATRIUM
      data.spaceId[cIdx(x, z)] = room.id
    }
  }
  data.multilevelUp = room
}

function stampUpper(data, room) {
  const { x0, z0, x1, z1 } = room.bounds
  data.carveRect(x0 - 1, z0 - 1, x1 + 1, z1 + 1)
  labelRing(data, room)
  for (const { lx, lz } of room.voidCells) {
    data.setCol(lx, lz, 0)
    data.cellKind[cIdx(lx, lz)] = CELL_VOID
    data.spaceId[cIdx(lx, lz)] = room.id
  }
  for (const { lx, lz } of room.bridgeCells) {
    data.setCol(lx, lz, 0)
    data.cellKind[cIdx(lx, lz)] = CELL_BRIDGE
    data.spaceId[cIdx(lx, lz)] = room.id
  }

  // Observation windows exist ONLY on edges from the walkable gallery ring
  // into this room's void. The two bridge endpoints are wide-open approaches,
  // never mislabeled windows.
  for (let z = z0; z <= z1; z++) {
    const bridgeEnd = room.bridgeAxis === 'x' && z === room.bridgeLine
    if (bridgeEnd) {
      setV(data, x0, z, 0, PASSAGE_WIDE)
      setV(data, x1 + 1, z, 0, PASSAGE_WIDE)
    } else {
      setV(data, x0, z, 1, PASSAGE_WALL, WALL_WINDOW)
      setV(data, x1 + 1, z, 1, PASSAGE_WALL, WALL_WINDOW)
    }
  }
  for (let x = x0; x <= x1; x++) {
    const bridgeEnd = room.bridgeAxis === 'z' && x === room.bridgeLine
    if (bridgeEnd) {
      setH(data, x, z0, 0, PASSAGE_WIDE)
      setH(data, x, z1 + 1, 0, PASSAGE_WIDE)
    } else {
      setH(data, x, z0, 1, PASSAGE_WALL, WALL_WINDOW)
      setH(data, x, z1 + 1, 1, PASSAGE_WALL, WALL_WINDOW)
    }
  }

  // The deck is one cell wide and long by contract. Low protected guards line
  // every walkable-to-void edge; their WALL_RAIL feature is sight-transparent
  // but remains a collision/pathfinding wall.
  if (room.bridgeAxis === 'x') {
    for (let x = x0; x <= x1; x++) {
      setH(data, x, room.bridgeLine, 1, PASSAGE_WALL, WALL_RAIL)
      setH(data, x, room.bridgeLine + 1, 1, PASSAGE_WALL, WALL_RAIL)
    }
  } else {
    for (let z = z0; z <= z1; z++) {
      setV(data, room.bridgeLine, z, 1, PASSAGE_WALL, WALL_RAIL)
      setV(data, room.bridgeLine + 1, z, 1, PASSAGE_WALL, WALL_RAIL)
    }
  }
  data.multilevelDown = room
}

export function stampMultilevelRooms(data, seed, cx, cy, cz, config) {
  const { up, down } = chunkMultilevelRooms(seed, cx, cz, cy, config)
  if (up.hasRoom) stampLower(data, up)
  if (down.hasRoom) stampUpper(data, down)
}
