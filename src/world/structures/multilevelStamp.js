import { CHUNK, LAYER_H, cIdx } from '../constants.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_LOBBY,
  CELL_VOID,
  MAP_FAMILY_TOWER,
  PASSAGE_DOOR,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  SPACE_ROLE_NONE,
  WALL_RAIL,
  WALL_WINDOW,
} from '../mapTypes.js'
import { deepFreeze } from '../mapFamily.js'
import {
  multilevelStructureSlice,
  multilevelTerminalOverlookLine,
} from './multilevel.js'
import { lethalVoidHalfFromSlice } from './lethalVoid.js'
import { stampStructureVerticalLinks } from './stairStamp.js'
import {
  TOWER_STRUCTURE_KIND,
  towerSocketBelongsToChunk,
} from './tower.js'

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
  // The office district plan elected roles for the fabric under this volume;
  // every cell the structure takes (hall, gallery, ring, stair) stops being a
  // furnishable room, so its SPACE_ROLE_* byte must not survive into the
  // dressing/lighting/debug reads that trust "roles only ride CELL_ROOM".
  for (let z = Math.max(0, z0 - 1); z <= Math.min(CHUNK - 1, z1 + 1); z++) {
    for (let x = Math.max(0, x0 - 1); x <= Math.min(CHUNK - 1, x1 + 1); x++) {
      data.spaceRole[cIdx(x, z)] = SPACE_ROLE_NONE
    }
  }
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

const edgeKey = (axis, line, cell) => `${axis}:${line},${cell}`

function stampOuterWindowsAndApproaches(data, slice, roomOpenings = null) {
  const { x0, z0, x1, z1 } = slice.localBounds
  const global = slice.globalBounds
  const chunkGX = data.cx * CHUNK
  const chunkGZ = data.cz * CHUNK
  const bridge = slice.globalBridgeLine
  const overlook = multilevelTerminalOverlookLine(slice)

  for (let z = z0; z <= z1; z++) {
    const gz = chunkGZ + z
    const isBridgeEnd = bridge !== null && slice.bridgeAxis === 'x' && gz === bridge
    const isOverlook = overlook !== null && slice.bridgeAxis === 'x' && gz === overlook
    for (const [x, gx] of [[x0, chunkGX + x0], [x1 + 1, chunkGX + x1 + 1]]) {
      if (gx !== global.x0 && gx !== global.x1 + 1) continue
      if (isBridgeEnd || roomOpenings?.has(edgeKey('v', x, z))) {
        setV(data, x, z, 0, PASSAGE_WIDE)
      }
      else setV(data, x, z, 1, PASSAGE_WALL, isOverlook ? WALL_RAIL : WALL_WINDOW)
    }
  }

  for (let x = x0; x <= x1; x++) {
    const gx = chunkGX + x
    const isBridgeEnd = bridge !== null && slice.bridgeAxis === 'z' && gx === bridge
    const isOverlook = overlook !== null && slice.bridgeAxis === 'z' && gx === overlook
    for (const [z, gz] of [[z0, chunkGZ + z0], [z1 + 1, chunkGZ + z1 + 1]]) {
      if (gz !== global.z0 && gz !== global.z1 + 1) continue
      if (isBridgeEnd || roomOpenings?.has(edgeKey('h', z, x))) {
        setH(data, x, z, 0, PASSAGE_WIDE)
      }
      else setH(data, x, z, 1, PASSAGE_WALL, isOverlook ? WALL_RAIL : WALL_WINDOW)
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

function stampGallery(data, floorSlice, roomOpenings = null) {
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
  stampOuterWindowsAndApproaches(data, floorSlice, roomOpenings)
  stampBridgeGuards(data, floorSlice)
}

const localCellKey = (lx, lz) => `${lx},${lz}`

function towerParticipantLink(structure, cx, cz) {
  return structure.verticalLinks.find(
    (link) => link.cx === cx && link.cz === cz
  ) ?? null
}

// Keep one authored access corridor and the complete stair halo solid inside
// each participant. The remaining three-cell shaft band is the exposed void;
// the middle slice replaces its centre line with the canonical deck.
function towerSafeFloorCells(structure, slice, cx, cz) {
  const safe = new Set()
  const link = towerParticipantLink(structure, cx, cz)
  if (!link) return safe

  const stairCells = [link.stair.landing, ...link.stair.run, link.stair.exit]
  const corridor = structure.bridgeAxis === 'x'
    ? link.stair.landing.lz
    : link.stair.landing.lx
  const { x0, z0, x1, z1 } = slice.localBounds
  if (structure.bridgeAxis === 'x') {
    for (let lx = x0; lx <= x1; lx++) safe.add(localCellKey(lx, corridor))
  } else {
    for (let lz = z0; lz <= z1; lz++) safe.add(localCellKey(corridor, lz))
  }

  const haloX0 = Math.max(x0, Math.min(...stairCells.map(({ lx }) => lx)) - 1)
  const haloZ0 = Math.max(z0, Math.min(...stairCells.map(({ lz }) => lz)) - 1)
  const haloX1 = Math.min(x1, Math.max(...stairCells.map(({ lx }) => lx)) + 1)
  const haloZ1 = Math.min(z1, Math.max(...stairCells.map(({ lz }) => lz)) + 1)
  for (let lz = haloZ0; lz <= haloZ1; lz++) {
    for (let lx = haloX0; lx <= haloX1; lx++) safe.add(localCellKey(lx, lz))
  }
  return safe
}

function towerStructureSlice(structure, cx, cz, lowerCy) {
  const slice = multilevelStructureSlice(structure, cx, cz, lowerCy)
  if (!slice.hasRoom) return slice

  const safe = towerSafeFloorCells(structure, slice, cx, cz)
  const canonicalDeckLine = structure.decks[0].globalBridgeLine
  const chunkGX = cx * CHUNK
  const chunkGZ = cz * CHUNK
  const voidCells = []
  for (let lz = slice.localBounds.z0; lz <= slice.localBounds.z1; lz++) {
    for (let lx = slice.localBounds.x0; lx <= slice.localBounds.x1; lx++) {
      const globalShort = structure.bridgeAxis === 'x'
        ? chunkGZ + lz
        : chunkGX + lx
      const isDeck = slice.globalBridgeLine !== null &&
        globalShort === slice.globalBridgeLine
      if (
        !isDeck &&
        Math.abs(globalShort - canonicalDeckLine) <= 1 &&
        !safe.has(localCellKey(lx, lz))
      ) {
        voidCells.push({ lx, lz })
      }
    }
  }

  return deepFreeze({ ...slice, voidCells })
}

function towerRoomOpenings(structure, slice, cx, cz) {
  const participantIndex = structure.participants.findIndex(
    (participant) => participant.cx === cx && participant.cz === cz
  )
  const openings = new Set()
  if (participantIndex < 0) return openings

  if (structure.bridgeAxis === 'x') {
    const line = participantIndex === 0
      ? slice.localBounds.x0
      : slice.localBounds.x1 + 1
    for (const link of structure.verticalLinks) {
      openings.add(edgeKey('v', line, link.stair.landing.lz))
    }
  } else {
    const line = participantIndex === 0
      ? slice.localBounds.z0
      : slice.localBounds.z1 + 1
    for (const link of structure.verticalLinks) {
      openings.add(edgeKey('h', line, link.stair.landing.lx))
    }
  }
  return openings
}

function stampTowerRoomFloor(data, slice) {
  const { x0, z0, x1, z1 } = slice.localBounds
  for (let lz = z0; lz <= z1; lz++) {
    for (let lx = x0; lx <= x1; lx++) {
      data.setCol(lx, lz, 0)
      data.cellKind[cIdx(lx, lz)] = CELL_LOBBY
      data.spaceId[cIdx(lx, lz)] = slice.id
    }
  }
}

// Bottom-hall colonnade: two inset rows of columns on a fixed structural bay
// along the long axis. The hall stops being a bare extruded box — it reads as
// the load path of the tower above, gives the eye a scale reference, and adds
// the occlusion rhythm the pillar-perception research values. Columns are
// never adjacent (3-cell bay) and sit 2 cells clear of the footprint ends, so
// the open hall stays one navigable component and every perimeter approach
// keeps a clear mouth; the stair halo carve deletes any column it overlaps.
function stampTowerColonnade(data, slice) {
  const { x0, z0, x1, z1 } = slice.localBounds
  const alongX = x1 - x0 >= z1 - z0
  const a0 = alongX ? x0 : z0
  const a1 = alongX ? x1 : z1
  const lines = alongX ? [z0 + 1, z1 - 1] : [x0 + 1, x1 - 1]
  for (let along = a0 + 2; along <= a1 - 2; along += 3) {
    for (const line of lines) {
      const lx = alongX ? along : line
      const lz = alongX ? line : along
      if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK) continue
      data.setCol(lx, lz, 1)
    }
  }
}

function stampTowerPerimeter(data, structure, surface, roomOpenings) {
  const perimeter = data.cy === structure.baseCy
    ? {
        ...surface,
        bridgeLine: null,
        globalBridgeLine: null,
      }
    : surface
  stampOuterWindowsAndApproaches(data, perimeter, roomOpenings)
  if (data.cy !== structure.baseCy) stampBridgeGuards(data, perimeter)
}

// Door sockets reuse the already-open matched approach edge. Only passage
// metadata changes from wide to the existing door token; wall geometry,
// protected ownership, deck continuity, and collision remain unchanged.
function stampTowerDoorSocket(data, structure) {
  const socket = structure.landmarkSockets?.find(
    (candidate) =>
      candidate.kind === 'door' &&
      candidate.slot === 'bridgeApproach' &&
      towerSocketBelongsToChunk(candidate, data)
  )
  if (!socket) return

  const lx = socket.gx - data.cx * CHUNK
  const lz = socket.gz - data.cz * CHUNK
  if (socket.axis === 'x') {
    const line = lx + (socket.side > 0 ? 1 : 0)
    if (
      line >= 0 &&
      line < CHUNK &&
      lz >= 0 &&
      lz < CHUNK &&
      data.vAt(line, lz) === 0 &&
      data.passageVAt(line, lz) !== PASSAGE_WALL
    ) setV(data, line, lz, 0, PASSAGE_DOOR)
  } else if (socket.axis === 'z') {
    const line = lz + (socket.side > 0 ? 1 : 0)
    if (
      lx >= 0 &&
      lx < CHUNK &&
      line >= 0 &&
      line < CHUNK &&
      data.hAt(lx, line) === 0 &&
      data.passageHAt(lx, line) !== PASSAGE_WALL
    ) setH(data, lx, line, 0, PASSAGE_DOOR)
  }
}

function lethalVoidHalf(structure, slice) {
  const deathYmm = Math.round(structure.baseCy * LAYER_H * 1000)
  return lethalVoidHalfFromSlice(structure, slice, () => deathYmm)
}

// Stamp one slice of the already-planned canonical Tower descriptor. The
// descriptor remains data.structure; all other fields below are the
// established multilevel, stair, and lethal slab-half carriers.
export function stampTowerStructure(data, structure) {
  if (
    structure?.hasRoom !== true ||
    structure.family !== MAP_FAMILY_TOWER ||
    structure.kind !== TOWER_STRUCTURE_KIND
  ) return

  const up = towerStructureSlice(structure, data.cx, data.cz, data.cy)
  const down = towerStructureSlice(structure, data.cx, data.cz, data.cy - 1)
  const surface = down.hasRoom ? down : up
  if (!surface.hasRoom) return

  carveStructure(data, surface)
  stampTowerRoomFloor(data, surface)
  const roomOpenings = towerRoomOpenings(
    structure,
    surface,
    data.cx,
    data.cz
  )
  if (data.cy === structure.baseCy) {
    stampTowerColonnade(data, surface)
    stampTowerPerimeter(data, structure, surface, roomOpenings)
  } else {
    stampGallery(data, down, roomOpenings)
  }

  data.structure = structure
  data.structureUp = up.hasRoom ? up : null
  data.structureDown = down.hasRoom ? down : null
  stampStructureVerticalLinks(data, structure)
  // A stair flank can coincide with a deck rail edge. Both require the same
  // closed collision guard, but the deck owns its final visual rail semantic.
  // Reassert only the already-protected Tower perimeter/guard edges after the
  // stair primitive has written its complete canonical halves.
  stampTowerPerimeter(data, structure, surface, roomOpenings)
  stampTowerDoorSocket(data, structure)
  data.lethalVoidUp = lethalVoidHalf(structure, data.structureUp)
  data.lethalVoidDown = lethalVoidHalf(structure, data.structureDown)
}

// Same pre-resolved descriptor contract as the tower/lattice stamps: the
// pipeline passes the canonical structure; the stamp derives its own slices.
export function stampMultilevelRooms(data, structure) {
  if (!structure?.hasRoom) return
  const up = multilevelStructureSlice(structure, data.cx, data.cz, data.cy)
  const down = multilevelStructureSlice(structure, data.cx, data.cz, data.cy - 1)

  const surface = down.hasRoom ? down : up
  carveStructure(data, surface)
  if (data.cy === structure.baseCy) stampBottom(data, surface)
  else stampGallery(data, down)

  data.structure = structure
  data.structureUp = up.hasRoom ? up : null
  data.structureDown = down.hasRoom ? down : null
}
