import { cIdx } from '../world/constants.js'
import {
  CELL_OPEN,
  CELL_ROOM,
  PASSAGE_DOOR,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  SPACE_ROLE_NONE,
} from '../world/mapTypes.js'
import { hash2i } from '../world/core/hash.js'
import { countChunkComponents } from '../world/topology.js'
import { cellEdges, furnishOrdinaryRoom, furnishRoleRoom } from '../world/rooms/furnish.js'
import { normalizeDoorPassages } from '../world/doors.js'

// Room authoring: a room is a REGION the user selects, not an object. Placing
// one stamps its cells (CELL_ROOM + spaceId + spaceRole), walls its perimeter
// with a door, and runs the game's furnishing grammar over the region — the
// resulting furniture records are ordinary editable objects afterwards.
//
// Furnishing reuses rooms/furnish.js verbatim (anchor guarantees, whitelists,
// wall-hugging, per-piece connectivity guard). The only game rule dropped is
// the 2-cell chunk-border margin: that exists to de-duplicate cross-seam
// stamping in infinite generation, and would starve seam-adjacent editor
// rects for no benefit here (each cell is furnished by exactly one chunk).

// Stable dice identity for a room: reroll = bump salt.
const roomSpaceKey = (room) => hash2i(room.salt | 0, room.id | 0, 0)

export function defaultDoor(rect) {
  return { axis: 'h', gx: Math.floor((rect.x0 + rect.x1) / 2), gz: rect.z1 + 1 }
}

function isDoorEdge(door, axis, gx, gz) {
  return !!door && door.axis === axis && door.gx === gx && door.gz === gz
}

// Stamp the room region: interior cells, cleared interior edges, walled
// perimeter with the door opening.
export function stampRoomShell(map, room) {
  const { cy, x0, z0, x1, z1, door } = room
  for (let gz = z0; gz <= z1; gz++) {
    for (let gx = x0; gx <= x1; gx++) {
      map.setCell(gx, cy, gz, { kind: CELL_ROOM, spaceId: room.id, role: room.role })
    }
  }
  // Interior edges open so the region reads as one space.
  for (let gz = z0; gz <= z1; gz++) {
    for (let gx = x0 + 1; gx <= x1; gx++) map.setWallV(gx, cy, gz, 0, PASSAGE_OPEN)
  }
  for (let gz = z0 + 1; gz <= z1; gz++) {
    for (let gx = x0; gx <= x1; gx++) map.setWallH(gx, cy, gz, 0, PASSAGE_OPEN)
  }
  // Perimeter: west/east vertical lines, north/south horizontal lines.
  for (let gz = z0; gz <= z1; gz++) {
    for (const gx of [x0, x1 + 1]) {
      if (isDoorEdge(door, 'v', gx, gz)) map.setWallV(gx, cy, gz, 0, PASSAGE_DOOR)
      else map.setWallV(gx, cy, gz, 1, PASSAGE_WALL)
    }
  }
  for (let gx = x0; gx <= x1; gx++) {
    for (const gz of [z0, z1 + 1]) {
      if (isDoorEdge(door, 'h', gx, gz)) map.setWallH(gx, cy, gz, 0, PASSAGE_DOOR)
      else map.setWallH(gx, cy, gz, 1, PASSAGE_WALL)
    }
  }
  normalizeTouchedDoors(map, room)
}

function normalizeTouchedDoors(map, room) {
  const c0x = map.cellChunk(room.x0) - 1
  const c1x = map.cellChunk(room.x1 + 1)
  const c0z = map.cellChunk(room.z0) - 1
  const c1z = map.cellChunk(room.z1 + 1)
  for (let cz = c0z; cz <= c1z; cz++) {
    for (let cx = c0x; cx <= c1x; cx++) {
      const d = map._touch(cx, room.cy, cz, false)
      if (d) normalizeDoorPassages(d)
    }
  }
}

// Cells of the room = rect cells whose raster spaceId matches (rects always
// match; baked L-shaped rooms match only their true cells).
export function roomCells(map, room) {
  const cells = []
  for (let gz = room.z0; gz <= room.z1; gz++) {
    for (let gx = room.x0; gx <= room.x1; gx++) {
      const c = map.cellAt(gx, room.cy, gz)
      if (c.kind === CELL_ROOM && c.spaceId === room.id) cells.push({ gx, gz })
    }
  }
  return cells
}

// Remove the furniture generated inside the room region (lamps/walls stay).
export function clearRoomObjects(map, room) {
  for (const { gx, gz } of roomCells(map, room)) {
    map.removeFurniture(gx, room.cy, gz)
  }
}

function isFreeCandidate(data, lampCells, roomId, x, z) {
  const i = cIdx(x, z)
  if (data.cellKind[i] !== CELL_ROOM || data.spaceId[i] !== roomId) return false
  if (data.colAt(x, z)) return false
  if (data.hasFloorHole(x, z) || data.hasCeilHole(x, z)) return false
  if (lampCells.has(`${x},${z}`)) return false
  for (const e of cellEdges(data, x, z)) {
    if (e.passage === PASSAGE_DOOR || e.passage === PASSAGE_WIDE) return false
  }
  return true
}

// Run the furnishing grammar over the room, per chunk slice — the same
// slice-wise contract placeFurniture uses (world/furniture.js), with the
// user's role choice replacing plan-time election.
export function furnishRoom(map, room) {
  const spaceKey = roomSpaceKey(room)
  const slices = new Map() // chunkKey -> {data, cells}
  for (const { gx, gz } of roomCells(map, room)) {
    const cx = map.cellChunk(gx)
    const cz = map.cellChunk(gz)
    const key = `${cx},${cz}`
    if (!slices.has(key)) slices.set(key, { data: map._touch(cx, room.cy, cz), cells: [] })
    slices.get(key).cells.push({ lx: map.cellLocal(gx), lz: map.cellLocal(gz), gx, gz })
  }
  let added = 0
  for (const { data, cells } of slices.values()) {
    const lampCells = new Set(data.lamps.map((l) => `${l.lx},${l.lz}`))
    const space = { id: spaceKey, cells, x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity, area: cells.length }
    for (const c of cells) {
      space.x0 = Math.min(space.x0, c.lx)
      space.z0 = Math.min(space.z0, c.lz)
      space.x1 = Math.max(space.x1, c.lx)
      space.z1 = Math.max(space.z1, c.lz)
    }
    const candidates = cells.filter((c) => isFreeCandidate(data, lampCells, room.id, c.lx, c.lz))
    if (candidates.length < 3) continue
    const ctx = { data, added: [], baseline: countChunkComponents(data, true) }
    if (room.role !== SPACE_ROLE_NONE) furnishRoleRoom(ctx, space, candidates, room.role)
    else furnishOrdinaryRoom(ctx, space, candidates, map.meta.family)
    added += ctx.added.length
  }
  return added
}

// Place a ceiling lamp at the room's centre cell (skipped if the cell already
// carries one, or hosts a hole).
function placeRoomLamp(map, room) {
  const gx = Math.floor((room.x0 + room.x1) / 2)
  const gz = Math.floor((room.z0 + room.z1) / 2)
  const cell = map.cellAt(gx, room.cy, gz)
  if (!cell.chunk || cell.spaceId !== room.id) return
  if (cell.chunk.hasCeilHole(map.cellLocal(gx), map.cellLocal(gz))) return
  if (!map.lampAt(gx, room.cy, gz)) map.setLamp(gx, room.cy, gz, true)
}

// The full "place a room" operation: stamp + light + furnish, undoable as one.
export function createRoom(map, { cy, x0, z0, x1, z1, role = SPACE_ROLE_NONE, salt = 0, door, lamp = true }) {
  if (x1 < x0) [x0, x1] = [x1, x0]
  if (z1 < z0) [z0, z1] = [z1, z0]
  const room = {
    id: map.nextRoomId,
    cy, x0, z0, x1, z1, role,
    salt,
    door: door === undefined ? defaultDoor({ x0, z0, x1, z1 }) : door,
    baked: false,
  }
  map.mutate(() => {
    map.nextRoomId++
    stampRoomShell(map, room)
    if (lamp) placeRoomLamp(map, room)
    furnishRoom(map, room)
    map.rooms.push(room)
  })
  return room
}

// Re-run generation for a room (optionally with a new dice salt).
export function regenerateRoom(map, room, { salt } = {}) {
  map.mutate(() => {
    if (salt !== undefined) room.salt = salt
    clearRoomObjects(map, room)
    furnishRoom(map, room)
  })
}

// Delete a room: clear its cells and objects, open perimeter edges that do
// not border another room, and drop the record. Works for baked (possibly
// non-rectangular) rooms too, because it walks true member cells.
export function removeRoom(map, room) {
  map.mutate(() => {
    const cells = roomCells(map, room)
    const member = new Set(cells.map((c) => `${c.gx},${c.gz}`))
    const cy = room.cy
    for (const { gx, gz } of cells) {
      map.removeFurniture(gx, cy, gz)
      if (map.lampAt(gx, cy, gz)) map.setLamp(gx, cy, gz, null)
      map.setCell(gx, cy, gz, { kind: CELL_OPEN, spaceId: 0, role: SPACE_ROLE_NONE })
    }
    const otherRoom = (gx, gz) => {
      const c = map.cellAt(gx, cy, gz)
      return c.spaceId !== 0 && c.spaceId !== room.id
    }
    for (const { gx, gz } of cells) {
      // West/East edges of the cell.
      if (!member.has(`${gx - 1},${gz}`) && !otherRoom(gx - 1, gz)) map.setWallV(gx, cy, gz, 0, PASSAGE_OPEN)
      if (!member.has(`${gx + 1},${gz}`) && !otherRoom(gx + 1, gz)) map.setWallV(gx + 1, cy, gz, 0, PASSAGE_OPEN)
      // North/South edges.
      if (!member.has(`${gx},${gz - 1}`) && !otherRoom(gx, gz - 1)) map.setWallH(gx, cy, gz, 0, PASSAGE_OPEN)
      if (!member.has(`${gx},${gz + 1}`) && !otherRoom(gx, gz + 1)) map.setWallH(gx, cy, gz + 1, 0, PASSAGE_OPEN)
    }
    map.rooms = map.rooms.filter((r) => r !== room)
    map.compact()
  })
}

// Move the room's door to another perimeter edge.
export function setRoomDoor(map, room, door) {
  map.mutate(() => {
    room.door = door
    stampRoomShell(map, room)
  })
}
