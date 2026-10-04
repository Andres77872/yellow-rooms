import {
  CELL,
  CHUNK,
  THICK,
  THRESHOLD_H,
  THRESHOLD_DEPTH,
  EXIT_SIGN_W,
  EXIT_SIGN_H,
  EXIT_SIGN_T,
  EXIT_SIGN_Y,
  CLOCK_SIZE,
  CLOCK_Y,
  BOARD_W,
  BOARD_H,
  BOARD_Y,
  PROP_PLATE_T,
  WALL_ITEM_RATE,
  EXT_STEP,
  EXT_W,
  EXT_H,
  EXT_T,
  EXT_Y,
  RADIATOR_W,
  RADIATOR_H,
  RADIATOR_T,
  RADIATOR_RIBS,
  PROP_SALT,
  SIGN_SALT,
  FRAME_DEPTH,
  DOOR_LEAF_FRACTION,
  WALL_H,
  vIdx,
  hIdx,
  cIdx,
} from '../../constants.js'
import { hash2i } from '../../core/hash.js'
import {
  PASSAGE_DOOR,
  PASSAGE_WIDE,
  WALL_PLAIN,
  WALL_WINDOW,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_ROOM,
  SPACE_ROLE_ARCHIVE,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_COPY,
  SPACE_ROLE_DINING,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_LIBRARY,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_OFFICE,
} from '../../mapTypes.js'
import { PROP_TINT, ROLE_BAND, SIGN_TINT } from './palette.js'
import { decalCell, decalCellAt, safetyCell, signCell, signIdFor, wayfindingCell } from '../../decalKinds.js'
import { DOOR_EGRESS, DOOR_GUEST, DOOR_INTERNAL } from '../../doorFunction.js'
import { doorwayAt } from '../../doors.js'
import { baseFamilyOf, byFamily } from '../../families/registry.js'
import { MAP_FAMILY_STAIRWELL } from '../../families/ids.js'
import { SPACE_ROOM, ZONE_SOFT, cellRole } from '../../surfaceSet.js'
import { DERELICT, arrowLabel, doorNumber, faceKey, pushPlate, signagePlan, storeyNumber } from './notices.js'

// Wall-edge dressing: thresholds and exit signs at openings, radiators under
// windows, and the wall-mounted prop set (clocks, notice boards, extinguisher
// cabinets, caution plates). Baseboards and crowns follow whole wall RUNS
// (objects/wallShell.js collectWallTrim), not single edges.
//
// Printed matter goes to `decals` (world/decalKinds.js): thin plates whose
// faces show a cell of the world's decal atlas — room signs on door headers,
// posters, calendars, charts and photographs in rooms, evacuation plans,
// wayfinding arrows and notices in corridors, clock dials, memo slips on
// notice boards, and the rare note that should not be there. Descriptor:
// { px, py, pz, sx, sy, sz, cell, shade, rough[, number] }.
//
// Every choice is made by meaning, not by dice per edge: what a door's sign
// says comes from the room it serves (doorFunction.js), safety notices from
// the space they are posted in, arrows point at the stairs, extinguishers
// keep a fixed cadence, and a room hangs one coherent set of things chosen
// by its persona (its stable space key) and its department. Hashes only
// decide WHERE along a wall something hangs, and the derelict wings
// (surfaceSet.js decay) are where the anomalies live.
const roll = (salt, gx, gz) => hash2i(salt | 0, gx, gz) / 4294967296
const mod = (v, n) => ((v % n) + n) % n

const DECAL_SALT = 0x0dec
const PERSONA_SALT = 0x9e75
const NUMBER_SALT = 0x4e0
const PAPER_T = 0.004 // sheet on a wall or a board
const PLATE_T = 0.012 // laminated poster / sign plate
const ROOM_SIGN_W = 0.6
const ROOM_SIGN_H = 0.2
const LEVEL_SIGN_Y = 1.75
const NUMBERED_DEPARTMENTS = 0.65 // share of departments that number their doors
const LOST_SIGN = 0.25 // door plates that have come down in a derelict wing
const WRONG_ARROW = 0.2 // derelict arrows pointing away from the stairs
const LIMINAL_RATE = 0.015 // derelict faces with a note that should not be there

// What a room hangs on its walls, by use: `items` lists the kinds — the
// singletons (layoutOf) take their slots in order of weight, the fill kinds
// share the other slots by weight — and `rate` scales WALL_ITEM_RATE (the
// share of fill slots that carry anything).
// Wet rooms post hygiene notices (a break room adds its clock and calendar)
// and never boards or posters, service rooms stay sparse, server rooms are
// handled apart (caution plates only).
const WORK = { rate: 1, items: { clock: 0.2, board: 0.27, poster: 0.28, calendar: 0.12, chart: 0.09, photo: 0.04 } }
const LOBBY = { rate: 1, items: { clock: 0.25, board: 0.2, poster: 0.3, photo: 0.15, calendar: 0.1 } }
const SOCIAL = { rate: 0.8, items: { photo: 0.35, poster: 0.35, clock: 0.3 } }
const OFFICE_WALLS = {
  [SPACE_ROLE_MEETING]: { rate: 0.8, items: { clock: 0.3, chart: 0.35, poster: 0.3, photo: 0.05 } },
  // The break room is a wet room (surfaceSet.js): washable walls, a clock
  // and the department's calendar by the sink, no boards or posters.
  [SPACE_ROLE_BREAK]: { rate: 0.8, items: { clock: 0.35, calendar: 0.35, washHands: 0.3 } },
  [SPACE_ROLE_COPY]: { rate: 0.6, items: { board: 0.6, calendar: 0.4 } },
  [SPACE_ROLE_ARCHIVE]: { rate: 0.4, items: { clock: 0.5, calendar: 0.5 } },
  [SPACE_ROLE_STORAGE]: { rate: 0.3, items: { authorized: 1 } },
  [SPACE_ROLE_LIBRARY]: { rate: 0.8, items: { clock: 0.3, poster: 0.3, photo: 0.25, calendar: 0.15 } },
  [SPACE_ROLE_LOUNGE]: SOCIAL,
  [SPACE_ROLE_DINING]: SOCIAL,
  [SPACE_ROLE_BATHROOM]: { rate: 0.6, items: { washHands: 0.7, wetFloor: 0.3 } },
  [SPACE_ROLE_KITCHEN]: { rate: 0.6, items: { washHands: 0.6, wetFloor: 0.4 } },
  [SPACE_ROLE_LAUNDRY]: { rate: 0.6, items: { wetFloor: 1 } },
}
// Hotel rooms hang a framed print, not office clutter — nobody WORKED here,
// they stayed here. Guest bathrooms are private: no notices.
const HOTEL_ROOM = { rate: 0.65, items: { art: 0.8, photo: 0.2 } }
const HOTEL_WALLS = {
  [SPACE_ROLE_BATHROOM]: null,
  [SPACE_ROLE_KITCHEN]: { rate: 0.6, items: { washHands: 1 } },
  [SPACE_ROLE_LAUNDRY]: { rate: 0.6, items: { wetFloor: 1 } },
  [SPACE_ROLE_STORAGE]: { rate: 0.3, items: { authorized: 1 } },
}

// What a LOBBY face hangs, per family (byFamily: the office set unless a
// family names its own). The endless stairwell's lobbies are its stair
// landings: fire-stair notices, never the office's posters and photos.
const STAIR_LANDING = { rate: 0.5, items: { board: 0.5, authorized: 0.5 } }
const LOBBY_WALLS = { [MAP_FAMILY_OFFICE]: LOBBY, [MAP_FAMILY_STAIRWELL]: STAIR_LANDING }

function wallSetOf(family, kind, role) {
  if (baseFamilyOf(family) === MAP_FAMILY_HOTEL) return role in HOTEL_WALLS ? HOTEL_WALLS[role] : HOTEL_ROOM
  if (kind === CELL_LOBBY) return byFamily(LOBBY_WALLS, family)
  return role in OFFICE_WALLS ? OFFICE_WALLS[role] : WORK
}

// A room's persona, from its stable space key: how cluttered it is, whether
// it keeps a clock and a notice board, which warning a server room posts,
// which wall is its feature wall and where its pattern starts along a wall.
// Every face of the room reads the same persona, across chunk seams.
function personaOf(ctx) {
  const h = hash2i(PERSONA_SALT, ctx.key | 0, 0)
  return {
    busy: 0.55 + 0.9 * ((h & 255) / 255),
    clock: ((h >>> 8) & 3) !== 0,
    board: ((h >>> 10) & 3) !== 0,
    voltage: ((h >>> 12) & 1) === 0,
    facing: (h >>> 13) & 3,
    shift: (h >>> 15) & 3,
  }
}

// Stripped as a wing decays: worn rooms keep less on their walls, derelict
// ones little but what was screwed down.
const wearScale = (decay) => (decay < 0.45 ? 1 : decay < DERELICT ? 0.85 : 0.55)

// How a room composes its walls. Things hang on every other wall cell
// (never two side by side), in a four-slot pattern along each wall that
// repeats every 8 cells, read from the GLOBAL coordinate along the wall so
// the chunks a room spans agree. The room's singletons — clock, calendar,
// notice board, chart, its notices — each own one slot on one wall facing
// (the persona's feature wall first, then the wall opposite, then the other
// two), so a room keeps one clock per stretch of wall instead of a row of
// them; every other slot takes the room's fill (posters, prints, photos) as
// its clutter and wear allow.
const SINGLETONS = new Set(['clock', 'calendar', 'board', 'chart', 'washHands', 'wetFloor', 'authorized'])
const SINGLETON_SLOTS = [[0, 0], [1, 0], [0, 2], [1, 2], [2, 0], [3, 0], [2, 2], [3, 2]] // [facing, slot]

function layoutOf(set, persona) {
  const entries = Object.entries(set.items)
  const singles = entries
    .filter(([k]) => SINGLETONS.has(k) && (k !== 'clock' || persona.clock) && (k !== 'board' || persona.board))
    .sort((a, b) => b[1] - a[1])
  const at = new Map()
  singles.slice(0, SINGLETON_SLOTS.length).forEach(([k], i) => at.set(SINGLETON_SLOTS[i][0] * 4 + SINGLETON_SLOTS[i][1], k))
  return { at, fill: entries.filter(([k]) => !SINGLETONS.has(k)) }
}

// Weighted pick from [kind, weight] pairs; `u` is a 0..1 roll.
function weighted(list, u) {
  const total = list.reduce((sum, [, w]) => sum + w, 0)
  let acc = 0
  for (const [k, w] of list) {
    acc += w / total
    if (u < acc) return k
  }
  return list[list.length - 1][0]
}

// Extinguisher cabinets keep a fire-code rhythm down every corridor: one
// each EXT_STEP cells, alternating between the corridor's two walls, read
// from the global coordinate along the wall. When the slot's own face is
// taken (a doorway, an opening, a window, an open leaf beside a door) the
// cabinet moves on to the next free face of the same wall, up to EXT_SHIFT
// cells — decided from this chunk's walls alone, so a slot whose free face
// lies past the seam is dropped rather than guessed.
const EXT_SHIFT = 2
function corridorWallFace(data, plan, vertical, line, c, s) {
  if (c < 0 || c >= CHUNK) return null
  const lx = vertical ? line + (s > 0 ? 0 : -1) : c
  const lz = vertical ? c : line + (s > 0 ? 0 : -1)
  if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK) return null
  if (data.cellKind[cIdx(lx, lz)] !== CELL_CORRIDOR) return null
  const i = vertical ? vIdx(line, c) : hIdx(c, line)
  const door = (k) => k >= 0 && k < CHUNK && (vertical ? data.passageV[vIdx(line, k)] : data.passageH[hIdx(k, line)]) === PASSAGE_DOOR
  const free = (vertical ? data.wallV[i] : data.wallH[i]) === 1 &&
    (vertical ? data.wallFeatureV[i] : data.wallFeatureH[i]) === WALL_PLAIN &&
    !door(c - 1) && !door(c + 1) && !data.hasFloorHole(lx, lz) &&
    !plan.levelFaces.has(faceKey(vertical ? 'v' : 'h', line, c, s))
  return { free }
}

function cabinetFace(data, plan, vertical, line, cell, s) {
  const g = (vertical ? data.cz : data.cx) * CHUNK + cell
  const phase = s > 0 ? 0 : EXT_STEP
  for (let k = 0; k <= EXT_SHIFT; k++) {
    if (mod(g - k, EXT_STEP * 2) !== phase) continue
    // The slot is k faces back: every face from it up to this one must be a
    // taken face of the same corridor wall.
    for (let j = cell - k; j < cell; j++) {
      const face = corridorWallFace(data, plan, vertical, line, j, s)
      if (!face || face.free) return false
    }
    return true
  }
  return false
}

// Exit signs at the stair ends: the stairs are the escape route, so every
// stair end on the storey hangs a lit exit sign from its ceiling at the
// mouth of the flight, broad face to whoever walks up to it — the beacon a
// fire door carries, where the stair has no door. A doorway across the
// mouth carries its own sign instead.
const MOUTH_INSET = 0.3 // sign plane, metres in from the mouth of the flight
export function dressStairExits(data, plan, signs) {
  for (const end of plan.stairEnds) {
    if (!end.flight || data.hasCeilHole(end.lx, end.lz)) continue
    const { dx, dz } = end.flight
    const alongX = dx !== 0 // the flight runs along x: the sign spans z
    const line = alongX ? end.lx + (dx > 0 ? 1 : 0) : end.lz + (dz > 0 ? 1 : 0)
    const c = alongX ? end.lz : end.lx
    const i = alongX ? vIdx(line, c) : hIdx(c, line)
    if (line > 0 && line < CHUNK && (alongX ? data.passageV[i] : data.passageH[i]) === PASSAGE_DOOR) continue
    const px = (end.lx + 0.5) * CELL + dx * (CELL / 2 - MOUTH_INSET)
    const pz = (end.lz + 0.5) * CELL + dz * (CELL / 2 - MOUTH_INSET)
    const hang = (ou, y, su, sy, st, tint) =>
      signs.push(alongX
        ? { px, py: y, pz: pz + ou, sx: st, sy, sz: su, tint }
        : { px: px + ou, py: y, pz, sx: su, sy, sz: st, tint })
    const y = EXIT_SIGN_Y
    // Housing, the glowing face proud of it on both sides, two hanger rods.
    hang(0, y, EXIT_SIGN_W + 0.07, EXIT_SIGN_H + 0.06, 0.05, SIGN_TINT.frame)
    hang(0, y, EXIT_SIGN_W, EXIT_SIGN_H, EXIT_SIGN_T, SIGN_TINT.exit)
    const top = y + EXIT_SIGN_H / 2 + 0.03
    for (const rod of [-1, 1]) hang(rod * (EXIT_SIGN_W / 2 - 0.08), (top + WALL_H) / 2, 0.03, WALL_H - top, 0.03, SIGN_TINT.frame)
  }
}

// The header exit sign over a fire door: a dark housing plate with the
// glowing face proud of it, one assembly per wall face.
function pushDoorExitSign(signs, axis, line, cell) {
  const vertical = axis === 'v'
  const plane = line * CELL
  const centre = (cell + 0.5) * CELL
  const y = EXIT_SIGN_Y
  const box = (across, sAlong, sY, sAcross, tint) =>
    signs.push(vertical
      ? { px: across, py: y, pz: centre, sx: sAcross, sy: sY, sz: sAlong, tint }
      : { px: centre, py: y, pz: across, sx: sAlong, sy: sY, sz: sAcross, tint })
  for (const s of [-1, 1]) {
    box(plane + s * (THICK / 2 + 0.02), EXIT_SIGN_W + 0.07, EXIT_SIGN_H + 0.06, 0.04, SIGN_TINT.frame)
    box(plane + s * (THICK / 2 + 0.04 + EXIT_SIGN_T / 2), EXIT_SIGN_W, EXIT_SIGN_H, EXIT_SIGN_T, SIGN_TINT.exit)
  }
}

// Exit signs over every lit fire door of the chunk, for the family layers
// that replace dressEdge (the lattice): the same escape route, the same
// beacons. Openings over a slab hole stay bare, as in dressEdge.
export function dressDoorExits(data, plan, signs) {
  const hole = (lx, lz) => lx >= 0 && lx < CHUNK && lz >= 0 && lz < CHUNK && data.hasFloorHole(lx, lz)
  for (const axis of ['v', 'h']) {
    const vertical = axis === 'v'
    for (let line = 0; line < CHUNK; line++) {
      for (let cell = 0; cell < CHUNK; cell++) {
        const i = vertical ? vIdx(line, cell) : hIdx(cell, line)
        if ((vertical ? data.wallV[i] : data.wallH[i]) === 1) continue
        if ((vertical ? data.passageV[i] : data.passageH[i]) !== PASSAGE_DOOR) continue
        if (!plan.exitLit(axis, line, cell)) continue
        if (vertical ? hole(line - 1, cell) || hole(line, cell) : hole(cell, line - 1) || hole(cell, line)) continue
        pushDoorExitSign(signs, axis, line, cell)
      }
    }
  }
}

// The department either numbers every ordinary door or none of them.
const numbersDoors = (district) => hash2i(SIGN_SALT ^ NUMBER_SALT, district | 0, 0) / 4294967296 < NUMBERED_DEPARTMENTS

export function dressEdge(data, axis, line, cell, props, signs, decals = null, plan = signagePlan(data)) {
  const vertical = axis === 'v'
  const i = vertical ? vIdx(line, cell) : hIdx(cell, line)
  const wall = vertical ? data.wallV[i] : data.wallH[i]
  const passage = vertical ? data.passageV[i] : data.passageH[i]
  const feature = vertical ? data.wallFeatureV[i] : data.wallFeatureH[i]
  const family = data.mapFamily
  const cy = data.cy | 0
  const plane = line * CELL
  const centre = (cell + 0.5) * CELL
  const gx = data.cx * CHUNK + (vertical ? line : cell)
  const gz = data.cz * CHUNK + (vertical ? cell : line)

  // box(): axis-aware emit, `along` running along the wall, `across` across it.
  const box = (out, along, y, across, sAlong, sY, sAcross, tint) => {
    if (vertical) out.push({ px: across, py: y, pz: along, sx: sAcross, sy: sY, sz: sAlong, tint })
    else out.push({ px: along, py: y, pz: across, sx: sAlong, sy: sY, sz: sAcross, tint })
  }

  // A printed plate on face `s` showing atlas cell `cellIndex`, `base`
  // metres off the wall plane (the wall face by default); a numbered sign
  // plate sets its `number` in raised numerals.
  const decal = (along, y, s, w, h, cellIndex, { t = PLATE_T, base = THICK / 2, shade = 1, rough = 0.7, number = null } = {}) => {
    if (decals) pushPlate(decals, props, vertical, plane, s, along, y, w, h, cellIndex, { t, base, shade, rough, number })
  }
  const pick = (salt) => roll((DECAL_SALT ^ salt) | 0, gx, gz)

  // Faces over a slab opening (atrium/catalog voids, stair wells) carry no
  // floor- or wall-mounted dressing: it would hang in mid-air over the drop.
  const faceHole = (s) => {
    const cx = vertical ? line + (s > 0 ? 0 : -1) : cell
    const cz = vertical ? cell : line + (s > 0 ? 0 : -1)
    return cx >= 0 && cx < CHUNK && cz >= 0 && cz < CHUNK && data.hasFloorHole(cx, cz)
  }
  const holeBefore = faceHole(-1)
  const holeAfter = faceHole(1)

  if (wall !== 1) {
    if (passage !== PASSAGE_DOOR && passage !== PASSAGE_WIDE) return
    if (holeBefore || holeAfter) return
    // Threshold strip: a flooring-material seam line under the opening.
    box(props, centre, THRESHOLD_H / 2, plane, CELL, THRESHOLD_H, THRESHOLD_DEPTH, PROP_TINT.threshold)
    if (passage !== PASSAGE_DOOR) return
    const door = plan.door(axis, line, cell)
    if (door.fn === DOOR_EGRESS) {
      // Exit sign over every fire door of the escape route (stair, lobby and
      // corridor-to-corridor doors) — a dark housing plate with the glowing
      // face proud of it, one assembly per wall face. A seam door the chunk
      // only half sees stays dark (signagePlan).
      if (plan.exitLit(axis, line, cell)) pushDoorExitSign(signs, axis, line, cell)
      return
    }
    // Room identification plate: at most one per door, on the header casing
    // of the face that looks out of the room it names (the corridor side),
    // labelled by that room's use (decalKinds.js signIdFor: a hotel's guest
    // rooms carry their number on the door itself, its public rooms a
    // name). Doors between two ordinary rooms stay unsigned.
    const room = door.room
    if (!decals || !room || door.fn === DOOR_INTERNAL) return
    const s = -door.roomSide
    const outside = s < 0 ? door.lo : door.hi
    // A hotel suite's own bathroom or closet is private.
    if (baseFamilyOf(family) === MAP_FAMILY_HOTEL && outside?.cls === SPACE_ROOM && outside.category === ZONE_SOFT) return
    let id = signIdFor(room.role, family)
    let number = null
    if (!id && door.fn === DOOR_GUEST) {
      // The hotel numbers the room, not the leaf: where the guest door is
      // not hung, its number moves to a plate on the header.
      const way = doorwayAt(data, axis, line, cell, DOOR_LEAF_FRACTION)
      if (way.leaf || !way.number) return
      id = 'room'
      number = way.number
    }
    const cellIndex = id ? signCell(id, family) : -1
    if (cellIndex < 0) return
    if (id === 'room' && number === null) {
      // Ordinary rooms: a department numbers all its doors or none, and only
      // a door whose two sides this chunk sees can be sure it serves a room.
      if (door.partial || !numbersDoors(room.district)) return
      number = doorNumber(data, axis, line, cell, door.roomSide)
    }
    if (room.decay >= DERELICT && pick(0x51) < LOST_SIGN) return
    decal(centre, EXIT_SIGN_Y, s, ROOM_SIGN_W, ROOM_SIGN_H, cellIndex, { base: FRAME_DEPTH / 2, rough: 0.45, number })
    return
  }

  if (feature === WALL_WINDOW) {
    // Radiator under the window stool, both gallery faces: enamel panel with
    // ribs, feet, and an inlet pipe dropping to the floor.
    const y = RADIATOR_H / 2
    for (const s of [-1, 1]) {
      if (s < 0 ? holeBefore : holeAfter) continue
      const faceOff = plane + s * (THICK / 2 + RADIATOR_T / 2)
      box(props, centre, y, faceOff, RADIATOR_W, RADIATOR_H, RADIATOR_T, PROP_TINT.radiator)
      for (let r = 0; r < RADIATOR_RIBS; r++) {
        const off = (r / (RADIATOR_RIBS - 1) - 0.5) * (RADIATOR_W - 0.2)
        box(props, centre + off, y, faceOff + s * (RADIATOR_T / 2 + 0.015), 0.07, RADIATOR_H * 0.82, 0.03, PROP_TINT.radiator)
      }
      // Feet + the inlet pipe at one end.
      for (const fs of [-1, 1]) {
        box(props, centre + fs * (RADIATOR_W / 2 - 0.12), 0.04, faceOff, 0.08, 0.08, RADIATOR_T, PROP_TINT.pipe)
      }
      box(props, centre + RADIATOR_W / 2 - 0.06, RADIATOR_H / 2 - 0.1, faceOff + s * (RADIATOR_T / 2 + 0.02), 0.05, RADIATOR_H - 0.1, 0.05, PROP_TINT.pipe)
    }
    return
  }

  if (feature !== WALL_PLAIN) return

  // An open door leaf lies flat against the wall either side of a doorway
  // (objects/joinery/doors.js), up to door height: nothing mounts there but
  // the role band.
  const doorAt = (c) =>
    c >= 0 && c < CHUNK && (vertical ? data.passageV[vIdx(line, c)] : data.passageH[hIdx(c, line)]) === PASSAGE_DOOR
  const besideDoor = doorAt(cell - 1) || doorAt(cell + 1)

  // Corridor face: extinguisher cabinets on a fixed cadence along the
  // corridor, EXT_STEP cells apart and alternating between its two walls (a
  // fire-code rhythm instead of dice), and paperwork by place: fire-door and
  // keep-clear notices on the escape route, evacuation plans (one per
  // storey), arrows to the stairs, and in a derelict wing a note somebody
  // should not have left.
  const corridorFace = (s, cx, cz, ps) => {
    if (cabinetFace(data, plan, vertical, line, cell, s)) {
      // Extinguisher cabinet: red body, pale glazed door, handle nub.
      const off = plane + s * (THICK / 2 + EXT_T / 2)
      box(props, centre, EXT_Y, off, EXT_W, EXT_H, EXT_T, PROP_TINT.extinguisher)
      box(props, centre, EXT_Y + 0.03, off + s * (EXT_T / 2 + 0.008), EXT_W - 0.08, EXT_H - 0.16, 0.015, PROP_TINT.glassPale)
      box(props, centre + (EXT_W / 2 - 0.05), EXT_Y, off + s * (EXT_T / 2 + 0.02), 0.03, 0.1, 0.03, PROP_TINT.pipe)
      return
    }
    if (!decals) return
    const ctx = plan.ctxAt(cx, cz)
    const derelict = ctx.decay >= DERELICT
    const q = pick(ps | 1)
    const notice = (id) => decal(centre, 1.55, s, 0.3, 0.4, safetyCell(id), { rough: 0.5 })
    const evacPlan = () => decal(centre, 1.5, s, 0.6, 0.45, decalCellAt('evac', cy), { rough: 0.4 })
    if (plan.nearEgress(cx, cz) && q < 0.3) return notice(q < 0.18 ? 'fireDoor' : 'doNotBlock')
    if (plan.nearStair(cx, cz) && q < 0.3) return q < 0.15 ? evacPlan() : notice('doNotBlock')
    if (q < 0.04) return evacPlan()
    if (q < 0.12) {
      // Arrows follow the walk to the stairs (signagePlan route), and only
      // where it runs along this wall.
      const arrow = plan.arrow(vertical, s, cx, cz)
      if (!arrow) return
      // A derelict wing's arrows are not to be trusted.
      const dir = derelict && pick(ps | 2) < WRONG_ARROW ? -arrow.dir : arrow.dir
      return decal(centre, 2.15, s, 0.75, 0.25, wayfindingCell(arrowLabel(cy, arrow.target), dir), { rough: 0.45 })
    }
    if (derelict && q < 0.12 + LIMINAL_RATE) {
      decal(centre + (pick(ps | 3) - 0.5), 1.45, s, 0.21, 0.28, decalCell('liminal', pick(ps | 4)), { t: PAPER_T, rough: 0.9 })
    }
  }

  // Room / lobby face: what hangs here is the room's composition (persona,
  // layoutOf) and its department's taste — one clock dial, one calendar
  // month, one chart and one poster series per department, so a wing reads
  // as one fit-out — thinned as the wing decays.
  const roomFace = (s, cx, cz, kind, role, ps) => {
    const band = ROLE_BAND[role]
    const wallFace = THICK / 2 + (band ? 0.022 : 0) // in front of a role band
    const r = roll((PROP_SALT ^ (s > 0 ? 0x5eed : 0xface)) | 0, gx, gz)
    const ctx = plan.ctxAt(cx, cz)
    const persona = personaOf(ctx)
    const dept = ctx.district | 0
    const derelict = ctx.decay >= DERELICT
    if (decals && derelict && role !== SPACE_ROLE_SERVER && pick(ps | 6) < LIMINAL_RATE) {
      return decal(centre + (pick(ps | 7) - 0.5), 1.45, s, 0.21, 0.28, decalCell('liminal', pick(ps | 8)), { base: wallFace, t: PAPER_T, rough: 0.9 })
    }
    // Where along the room's pattern this face falls: every other wall cell,
    // `step` counting those cells along the wall, `slot` the pattern place,
    // `facing` which of the room's four walls (0 = its feature wall).
    const along = vertical ? gz : gx
    const parity = ctx.key & 1
    if (mod(along, 2) !== parity) return
    const step = (along - parity) / 2
    const slot = mod(step + persona.shift, 4)
    const facing = ((vertical ? 0 : 2) + (s > 0 ? 0 : 1)) ^ persona.facing
    if (role === SPACE_ROLE_SERVER) {
      // A caution notice once along each stretch of the server room's
      // walls, no homely clutter.
      if (slot !== 0 || r >= wearScale(ctx.decay)) return
      if (decals) return decal(centre, 1.6, s, 0.36, 0.48, safetyCell(persona.voltage ? 'highVoltage' : 'authorized'), { base: wallFace, rough: 0.5 })
      const off = plane + s * (THICK / 2 + PROP_PLATE_T / 2)
      box(props, centre, 1.6, off, 0.4, 0.28, PROP_PLATE_T, PROP_TINT.caution)
      box(props, centre, 1.6, off + s * (PROP_PLATE_T / 2 + 0.006), 0.3, 0.05, 0.012, PROP_TINT.clockRim)
      return
    }
    const set = wallSetOf(family, kind, role)
    if (!set) return
    const memoKey = `${ctx.key}|${kind}|${role}`
    let layout = plan.memo.get(memoKey)
    if (!layout) plan.memo.set(memoKey, (layout = layoutOf(set, persona)))
    let item = slot % 2 === 0 ? layout.at.get(facing * 4 + slot) : undefined
    if (item) {
      if (r >= wearScale(ctx.decay)) return
    } else {
      if (!layout.fill.length) return
      const rate = WALL_ITEM_RATE * set.rate * persona.busy * wearScale(ctx.decay)
      if (r >= rate) return
      item = weighted(layout.fill, r / rate)
    }
    const off = plane + s * (THICK / 2 + PROP_PLATE_T / 2)
    const opt = { base: wallFace }
    switch (item) {
      case 'clock': {
        // Wall clock: dark case, the dial — every clock of a department
        // stopped at the same minute.
        box(props, centre, CLOCK_Y, off, CLOCK_SIZE + 0.06, CLOCK_SIZE + 0.06, PROP_PLATE_T, PROP_TINT.clockRim)
        if (decals) return decal(centre, CLOCK_Y, s, CLOCK_SIZE, CLOCK_SIZE, decalCellAt('clock', dept), { base: THICK / 2 + PROP_PLATE_T, t: PAPER_T, rough: 0.2 })
        const faceOff = off + s * (PROP_PLATE_T / 2 + 0.006)
        box(props, centre, CLOCK_Y, faceOff, CLOCK_SIZE, CLOCK_SIZE, 0.012, PROP_TINT.clock)
        box(props, centre, CLOCK_Y + 0.05, faceOff + s * 0.012, 0.025, 0.16, 0.012, PROP_TINT.clockRim) // hour hand
        box(props, centre + 0.06, CLOCK_Y, faceOff + s * 0.012, 0.2, 0.02, 0.012, PROP_TINT.clockRim) // minute hand
        return
      }
      case 'board': {
        // Notice board: wood frame, cork field, pinned paper slips.
        box(props, centre, BOARD_Y, off, BOARD_W + 0.08, BOARD_H + 0.08, PROP_PLATE_T, PROP_TINT.boardFrame)
        const faceOff = off + s * (PROP_PLATE_T / 2 + 0.006)
        box(props, centre, BOARD_Y, faceOff, BOARD_W, BOARD_H, 0.012, PROP_TINT.board)
        const h2 = hash2i((PROP_SALT ^ 0xbeef) | 0, gx, gz)
        const cork = THICK / 2 + PROP_PLATE_T + 0.012
        for (let p = 0; p < 3; p++) {
          const pu = ((h2 >>> (p * 6)) & 63) / 63 - 0.5
          const pv = ((h2 >>> (p * 6 + 3)) & 63) / 63 - 0.5
          const u = centre + pu * (BOARD_W - 0.5)
          const y = BOARD_Y + pv * (BOARD_H - 0.35)
          if (!decals) {
            box(props, u, y, faceOff + s * 0.01, 0.22, 0.28, 0.008, PROP_TINT.paper)
            continue
          }
          // Slips overlap on the cork: step each one further off it. The
          // calendar and chart slips are the department's month and chart.
          const kindRoll = pick(ps | (8 + p))
          const slip = kindRoll < 0.62 ? 'memo' : kindRoll < 0.82 ? 'calendar' : (kindRoll < 0.985 || !derelict) ? 'chart' : 'liminal'
          const [w, h] = slip === 'chart' ? [0.3, 0.225] : slip === 'memo' ? [0.21, 0.297] : [0.21, 0.28]
          const slipCell = slip === 'calendar' || slip === 'chart' ? decalCellAt(slip, dept) : decalCell(slip, pick(ps | (12 + p)))
          decal(u, y, s, w, h, slipCell, { base: cork + p * PAPER_T, t: PAPER_T, rough: 0.85 })
        }
        return
      }
      case 'art': {
        // Framed print: dark wood frame, the world's print behind glass —
        // three prints per wing, the decorator's series.
        if (decals) {
          const artW = BOARD_H * (4 / 3)
          box(props, centre, BOARD_Y, off, artW + 0.08, BOARD_H + 0.08, PROP_PLATE_T, PROP_TINT.boardFrame)
          return decal(centre, BOARD_Y, s, artW, BOARD_H, decalCellAt('art', dept + mod(step, 3)), { base: THICK / 2 + PROP_PLATE_T, t: PAPER_T, rough: 0.3 })
        }
        // Framed print: dark wood frame, muted field, 1-2 accent strokes.
        box(props, centre, BOARD_Y, off, BOARD_W + 0.08, BOARD_H + 0.08, PROP_PLATE_T, PROP_TINT.boardFrame)
        const faceOff = off + s * (PROP_PLATE_T / 2 + 0.006)
        box(props, centre, BOARD_Y, faceOff, BOARD_W, BOARD_H, 0.012, PROP_TINT.print)
        box(props, centre - 0.18, BOARD_Y + 0.1, faceOff + s * 0.01, 0.34, 0.07, 0.008, PROP_TINT.printAqua)
        if ((hash2i((PROP_SALT ^ 0xbeef) | 0, gx, gz) & 1) === 0) {
          box(props, centre + 0.16, BOARD_Y - 0.14, faceOff + s * 0.01, 0.2, 0.05, 0.008, PROP_TINT.printWine)
        }
        return
      }
      case 'poster':
        return decal(centre, 1.55, s, 0.6, 0.8, decalCellAt('poster', dept + mod(step, 3)), { ...opt, rough: 0.3 })
      case 'calendar':
        return decal(centre + (pick(ps | 16) - 0.5) * 0.8, 1.55, s, 0.33, 0.44, decalCellAt('calendar', dept), { ...opt, t: PAPER_T, rough: 0.8 })
      case 'chart':
        return decal(centre, 1.5, s, 0.6, 0.45, decalCellAt('chart', dept), { ...opt, t: PAPER_T, rough: 0.8 })
      case 'photo':
        return decal(centre, 1.55, s, 0.32, 0.24, decalCellAt('photo', (ctx.key >>> 4) + step), { ...opt, rough: 0.35 })
      case 'washHands':
      case 'wetFloor':
      case 'authorized':
        return decal(centre, 1.55, s, 0.3, 0.4, safetyCell(item), { ...opt, rough: 0.5 })
    }
  }

  // Wall-mounted props, per wall face, by the adjacent cell kind: corridor
  // walls get extinguishers and paperwork, rooms and lobbies their persona's
  // set. Plates sit shallower than the door casings.
  for (const s of [-1, 1]) {
    const cx = vertical ? line + (s > 0 ? 0 : -1) : cell
    const cz = vertical ? cell : line + (s > 0 ? 0 : -1)
    if (cx < 0 || cx >= CHUNK || cz < 0 || cz >= CHUNK) continue
    const ci = cIdx(cx, cz)
    const kind = data.cellKind[ci]
    const role = cellRole(data, cx, cz) // the room's role, as its finish reads it
    // Role wainscot: a continuous painted band around every role room's
    // walls, so the room's identity reads architecturally at a glance.
    if ((kind === CELL_ROOM || kind === CELL_LOBBY) && ROLE_BAND[role]) {
      box(props, centre, 1.32, plane + s * (THICK / 2 + 0.011), CELL, 0.4, 0.022, ROLE_BAND[role])
    }
    if (plan.levelFaces.has(faceKey(axis, line, cell, s))) {
      // The storey's LEVEL plate at its stair end: arriving names the floor.
      const level = signCell('level', family)
      if (level >= 0) decal(centre, LEVEL_SIGN_Y, s, ROOM_SIGN_W, ROOM_SIGN_H, level, { rough: 0.45, number: data.levelLabel ?? storeyNumber(cy) })
      continue
    }
    if (besideDoor) continue
    const ps = s > 0 ? 0x100 : 0x200 // per-face decal salts
    if (kind === CELL_CORRIDOR) corridorFace(s, cx, cz, ps)
    else if (kind === CELL_ROOM || kind === CELL_LOBBY) roomFace(s, cx, cz, kind, role, ps)
  }
}
