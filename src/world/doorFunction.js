import { CHUNK, cIdx } from './constants.js'
import { CELL_LOBBY, CELL_STAIR, MAP_FAMILY_HOTEL } from './mapTypes.js'
import { baseFamilyOf } from './families/registry.js'
import {
  SPACE_CIRC,
  SPACE_HALL,
  SPACE_ROOM,
  ZONE_SERVICE,
  ZONE_SOFT,
  ZONE_WET,
  roomContext,
  seamContext,
  seamPortal,
  worldSurfaceSet,
} from './surfaceSet.js'

// What a doorway (or a window, or any wall edge) is FOR, read from the spaces
// on its two sides. Doors, door signs, exit signs and glazing all key off this
// one classification, so a bathroom always gets a bathroom door, its sign and
// no vision lite — instead of each system rolling its own dice per edge.
//
// Function classes:
//   DOOR_EGRESS   circulation <-> circulation, a stair or a landmark hall:
//                 the fire doors of the escape route (exit signs live here).
//   DOOR_WET      into a bathroom / kitchen / laundry / break room.
//   DOOR_SERVICE  into a server / storage / copy / archive room.
//   DOOR_GUEST    hotel corridor -> guest room (numbered).
//   DOOR_ROOM     corridor -> ordinary room: the district's standard door.
//   DOOR_INTERNAL room <-> room (a suite door), neither side wet or service.
export const DOOR_EGRESS = 'egress'
export const DOOR_WET = 'wet'
export const DOOR_SERVICE = 'service'
export const DOOR_GUEST = 'guest'
export const DOOR_ROOM = 'room'
export const DOOR_INTERNAL = 'internal'

// The two cells an edge separates, in chunk-local cells (null when the cell
// lies in the neighbouring chunk). 'v' line lx parts (lx-1, cell) | (lx, cell);
// 'h' line lz parts (cell, lz-1) | (cell, lz). `lo` is the side a face
// sign s = -1 looks into, `hi` the side s = +1 looks into.
export function edgeCells(axis, line, cell) {
  const v = axis === 'v'
  const lo = v ? [line - 1, cell] : [cell, line - 1]
  const hi = v ? [line, cell] : [cell, line]
  const inside = ([x, z]) => x >= 0 && x < CHUNK && z >= 0 && z < CHUNK
  return { lo: inside(lo) ? { lx: lo[0], lz: lo[1] } : null, hi: inside(hi) ? { lx: hi[0], lz: hi[1] } : null }
}


function roomFunction(family, room, other) {
  if (room.category === ZONE_WET) return DOOR_WET
  if (room.category === ZONE_SERVICE) return DOOR_SERVICE
  if (other && other.cls === SPACE_ROOM) return DOOR_INTERNAL
  if (baseFamilyOf(family) === MAP_FAMILY_HOTEL && room.category === ZONE_SOFT) return DOOR_GUEST
  return DOOR_ROOM
}

// { lo, hi, fn, room, roomSide, partial }:
//   lo / hi    roomContext of each side; a side across the chunk's own line 0
//              comes from the planner's seam ring (seamContext), else null
//   fn         DOOR_* class
//   room       context of the room the door serves (null for egress doors)
//   roomSide   -1 / +1: which face looks INTO that room (0 when none)
//   partial    one side is unknown (not read across the seam); the class
//              came from the in-chunk side alone, which every load order
//              agrees on
//   portal     that unknown side is another district's portal edge
// Pure in the chunk's own data: a doorway resolves the same however the
// world streamed in.
export function edgeContext(data, axis, line, cell, set = worldSurfaceSet(data.mapFamily, data.worldSeed)) {
  const cells = edgeCells(axis, line, cell)
  // Lines run 0..CHUNK-1, so only the lo side can lie across the seam.
  const lo = cells.lo ? roomContext(data, cells.lo.lx, cells.lo.lz, set) : seamContext(data, axis, cell, set)
  const hi = cells.hi ? roomContext(data, cells.hi.lx, cells.hi.lz, set) : null
  const partial = !lo || !hi
  if (!lo && hi.cls !== SPACE_ROOM && seamPortal(data, axis)) {
    // A district portal: corridor on both sides, the escape route.
    return { lo, hi, fn: DOOR_EGRESS, room: null, roomSide: 0, partial, portal: true }
  }
  const family = data.mapFamily
  const rooms = [lo, hi].filter((c) => c?.cls === SPACE_ROOM)
  if (rooms.length === 2) {
    // A suite: the wetter / more technical room names the door.
    const wet = rooms.find((c) => c.category === ZONE_WET)
    const service = rooms.find((c) => c.category === ZONE_SERVICE)
    const room = wet ?? service ?? hi
    const fn = wet ? DOOR_WET : service ? DOOR_SERVICE : DOOR_INTERNAL
    return { lo, hi, fn, room, roomSide: room === hi ? 1 : -1, partial, portal: false }
  }
  if (rooms.length === 1) {
    const room = rooms[0]
    const other = room === lo ? hi : lo
    return { lo, hi, fn: roomFunction(family, room, other), room, roomSide: room === hi ? 1 : -1, partial, portal: false }
  }
  // No room side: circulation, halls and stairs — the escape route. A lone
  // side facing an unknown neighbour is a fire door when it is the stair
  // itself, or unplanned fabric (sewer galleries, pillar halls), which runs
  // on across the seam; a planned lobby can as well open onto a room, so it
  // stays an ordinary door rather than a guess.
  const circ = [lo, hi].filter((c) => c && (c.cls === SPACE_CIRC || c.cls === SPACE_HALL)).length
  const stair = [lo, hi].some((c) => c && (c.kind === CELL_STAIR || (!partial && c.kind === CELL_LOBBY)))
  const own = partial ? (cells.lo ?? cells.hi) : null
  const fabric = !!own && !data.spaceId[cIdx(own.lx, own.lz)]
  const fn = circ === 2 || stair || fabric ? DOOR_EGRESS : DOOR_ROOM
  return { lo, hi, fn, room: null, roomSide: 0, partial, portal: false }
}
