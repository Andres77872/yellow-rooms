import {
  CELL,
  CHUNK,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  CELL_ROOM,
  FACING,
  FloorPlan,
  PASSAGE_DOOR,
  PASSAGE_WALL,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_BEDROOM,
  SPACE_ROLE_DINING,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_LIVING,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_OFFICE,
  STAIR_E,
  WALL_WINDOW,
  addPiece,
  featureEdge,
  rng,
} from '../../tiles/floorPlan.js'
import { createRoom, furnishRoom, stampRoomShell } from '../../tiles/roomOps.js'
import { finiteCtx, markExit } from '../../tiles/kit.js'
import { stairwellPlan } from '../../structures/authored.js'
import { PROP_HALL_CLOCK, PROP_RADIO } from '../../props/index.js'
import { LOOP_ANOMALIES as WORLD_LOOP_ANOMALIES, SALT } from './geometry.js'
import { KIND_CAP, furnishHouseRooms } from './furnish.js'

const SKIP_RADIO = new Set([PROP_RADIO])

// 05 House Larger Inside (docs/liminal_maps/05-house-larger-inside.md, §13
// step 1): the Euclidean prototype, and the house's PARTS CATALOGUE.
//
// The finite kind (buildHouseTile, wrapped by src/editor/kinds/house.js) is
// one authored house: a small shell (a 2-room façade on a hedged front yard)
// whose interior graph runs on into column-sealed mass the shell could never
// hold: domestic rooms (createRoom, residential roles), a stair that climbs
// on past the roof line, a P.T. loop of four identical L-hallways (one copy
// mutated), and at depth the Great Hall, a 3-storey void, unfurnished and
// dark, reached on the top floor through a door that opens onto its rail
// (Winchester).
//
//   floor 0   z 22..26  front yard (hedges = mass); spawn on the path
//             z 17..21  the shell: hall (clock), living + dining at the front
//                       (one façade window each), kitchen + WC behind
//             x 5       the back hallway north into the mass: laundry, den,
//                       back bedroom, the stair foot (3,5)
//             z 12      the long passage east to the loop's door (20,15)
//             x 15..26  the L loop round a sealed block; its SE closet opens
//                       on through its back wall to the anteroom and the
//                       Great Hall's door (33,13)
//   floor 1   z 5       landing corridor: bedrooms, bath, study, nursery, a
//                       bedroom that is a copy of the one before it; the
//                       corridor ends at a window into the hall's void
//   floor 2   z 5       unlit hallway to the anteroom; its far door opens
//                       onto the top gallery, one step from the rail
//
// Seams, swaps and pocket space (S7) are impossible in a document: the
// interior is laid out in real space, only hidden by the mass round it.
//
// The WORLD does not copy this plan. Its tile program is world.js, which
// grows every tile from the family's grammar (layout.js) and draws it with
// the parts below: the P.T. loop module at any size and place
// (buildLoopAt / mutateLoopWith), the shell and its rooms (buildShell /
// furnishShell), the room operations (stampRooms, copyRoom, placeRadio),
// the domestic roles, the warm practicals and P.T.'s red.

export const FLOORS = 3

export const WARM = 0xffd2a0 // domestic practicals (the family record's lampTint)
export const RED = 0xff3a2a // P.T.'s red hallway

const REGION_0 = { x0: 0, z0: 0, x1: 41, z1: 27 } // last compiled column 41, row 27
const REGION_UP = { x0: 0, z0: 0, x1: 41, z1: 13 } // upper storeys: chunk row 0 only
export const YARD = Object.freeze({ x0: 1, z0: 22, x1: 12, z1: 26 })
export const SHELL = Object.freeze({ x0: 2, z0: 17, x1: 9, z1: 21 }) // façade on H-line 22
export const SHELL_HALL = Object.freeze({ x0: 5, z0: 17, x1: 6, z1: 21 })
export const FRONT_DOOR = 5 // façade column of the front door; the sidelight is 6
const HALL = { x0: 30, z0: 2, x1: 39, z1: 11 } // Great Hall void, chunk (2, 0)
const RING = { x0: HALL.x0 - 1, z0: HALL.z0 - 1, x1: HALL.x1 + 1, z1: HALL.z1 + 1 }
const OVERLOOK = Math.floor((HALL.z0 + HALL.z1) / 2) // top-floor rail row (openVoid, x axis)
const HALL_DOOR = { gx: 33, gz: 13 } // ground floor, from the anteroom
const STAIR = { gx: 2, gz: 2 } // E flight, far door at (3, 5) on every floor
// The loop: four L-hallways round a sealed 8×8 block, each the mirror of
// the NW one (cells 15..20 × 14..19) across x line 21 and z line 20.
const FINITE_LOOP = Object.freeze({ x0: 15, z0: 14, S: 10, LX: 21, LZ: 20 })
const LOOP_LINE = { x: FINITE_LOOP.LX, z: FINITE_LOOP.LZ }
export const LOOP_Q = Object.freeze(['NW', 'NE', 'SW', 'SE'])
const LOOP_ANOMALIES = WORLD_LOOP_ANOMALIES

// Rooms (createRoom) per floor: rect, role, door edge. The shell's four are
// placed by side (west/east) so the seed can mirror the house.
const SHELL_ROOMS = {
  front: { z0: 19, z1: 21, doorZ: 20 },
  back: { z0: 17, z1: 18, doorZ: 18 },
}
const ROOMS_0 = [
  { key: 'laundry', x0: 2, z0: 7, x1: 4, z1: 8, role: SPACE_ROLE_LAUNDRY, door: { axis: 'v', gx: 5, gz: 7 } },
  { key: 'den', x0: 6, z0: 7, x1: 8, z1: 8, role: SPACE_ROLE_LOUNGE, door: { axis: 'v', gx: 6, gz: 8 } },
  { key: 'back bedroom', x0: 2, z0: 10, x1: 4, z1: 11, role: SPACE_ROLE_BEDROOM, door: { axis: 'v', gx: 5, gz: 11 } },
]
const ROOMS_1 = [
  { key: 'bedroom', x0: 1, z0: 6, x1: 3, z1: 7, role: SPACE_ROLE_BEDROOM, door: { axis: 'h', gx: 2, gz: 6 } },
  { key: 'bath', x0: 6, z0: 6, x1: 7, z1: 7, role: SPACE_ROLE_BATHROOM, door: { axis: 'h', gx: 6, gz: 6 } },
  { key: 'guest room', x0: 10, z0: 6, x1: 12, z1: 7, role: SPACE_ROLE_BEDROOM, door: { axis: 'h', gx: 11, gz: 6 } },
  { key: 'study', x0: 9, z0: 3, x1: 11, z1: 4, role: SPACE_ROLE_OFFICE, door: { axis: 'h', gx: 10, gz: 5 } },
  { key: 'nursery', x0: 15, z0: 3, x1: 17, z1: 4, role: SPACE_ROLE_BEDROOM, door: { axis: 'h', gx: 16, gz: 5 } },
]
const COPY_DX = 5 // the guest room again, five cells on (anomaly 3)
const ANTEROOM_0 = { x0: 31, z0: 16, x1: 34, z1: 19 }
const ANTEROOM_2 = { x0: 25, z0: 4, x1: 28, z1: 7 }

const NEIGHBOURS = [[0, -1], [-1, 0], [1, 0], [0, 1]]

// The kind lab's finite ctx (the editor kind's map, byte-identical).
export const FINITE_CTX_HOUSE = finiteCtx({})

// The finite kind: the whole authored house (shell, loop, hall) on one map.
// The world's tile program is world.js (buildWorldHouse).
export function buildHouseTile(map, seed, ctx = FINITE_CTX_HOUSE) {
  if (ctx.mode === 'tile') throw new Error('house: the world draws its tiles with world.js (buildWorldHouse)')
  const r = rng(seed, SALT)
  const notes = []
  const flip = (r(1) & 1) === 1 // living room east, dining west

  // --- floor 0: yard, shell, back hallway, loop, anteroom --------------------
  const p0 = new FloorPlan(REGION_0)
  buildLoopAt(p0, FINITE_LOOP, 200)
  const loop = mutateLoop(p0, r)

  buildShellPlan(p0)
  // The back hallway north to the stair foot, its rooms, and the passage east.
  p0.rect({ x0: 3, z0: 5, x1: 5, z1: 5 })
  p0.rect({ x0: 5, z0: 6, x1: 5, z1: 16 })
  for (const rm of ROOMS_0) p0.rect(rm, CELL_ROOM)
  p0.rect({ x0: 6, z0: 12, x1: 20, z1: 12 })
  p0.rect({ x0: 20, z0: 13, x1: 20, z1: 14 })
  p0.edge('h', 20, 15, 0, PASSAGE_DOOR) // into the loop's north side
  for (const [gx, gz, lit] of [[4, 5, true], [5, 9, true], [5, 14, true], [9, 12, true], [14, 12, false], [20, 13, true]]) {
    p0.lamp(gx, gz, lit, lit ? WARM : null)
  }
  // Through the SE closet's back wall: the anteroom, then the hall's door.
  p0.edge('v', 27, 21, 0, PASSAGE_DOOR)
  p0.rect({ x0: 27, z0: 21, x1: 32, z1: 21 })
  p0.open(32, 20)
  p0.room(ANTEROOM_0, {
    spaceId: 300,
    doors: [{ axis: 'h', gx: 32, gz: ANTEROOM_0.z1 + 1 }, { axis: 'h', gx: HALL_DOOR.gx, gz: ANTEROOM_0.z0 }],
  })
  p0.rect({ x0: HALL_DOOR.gx, z0: HALL_DOOR.gz, x1: HALL_DOOR.gx, z1: ANTEROOM_0.z0 - 1 })
  p0.rect(RING, CELL_LOBBY)
  p0.compile(map, 0)

  // --- floor 1: the landing corridor, bedrooms, a window into the void -------
  const p1 = new FloorPlan(REGION_UP)
  p1.rect({ x0: 1, z0: 5, x1: RING.x0 - 1, z1: 5 })
  for (const rm of ROOMS_1) p1.rect(rm, CELL_ROOM)
  p1.rect({ ...ROOMS_1[2], x0: ROOMS_1[2].x0 + COPY_DX, x1: ROOMS_1[2].x1 + COPY_DX }, CELL_ROOM)
  p1.rect(RING, CELL_LOBBY)
  for (const [gx, gz, lit] of [[4, 5, true], [13, 5, true], [21, 5, false]]) p1.lamp(gx, gz, lit, lit ? WARM : null)
  p1.compile(map, 1)

  // --- floor 2: unlit hallway, anteroom, the Winchester door ------------------
  const p2 = new FloorPlan(REGION_UP)
  p2.rect({ x0: 3, z0: 5, x1: ANTEROOM_2.x0 - 1, z1: 5 })
  p2.room(ANTEROOM_2, { spaceId: 400, doors: [{ axis: 'v', gx: ANTEROOM_2.x0, gz: 5 }] })
  p2.rect(RING, CELL_LOBBY)
  p2.lamp(5, 5, false)
  p2.compile(map, 2)

  // --- stamps: the Great Hall (atrium, not a link), then the stair -----------
  const hall = ctx.kit.atrium(map, { ...HALL, baseCy: 0, levels: FLOORS, kind: 'openVoid' })
  if (hall === null) return { error: 'house: great hall (planner null slot)' }
  if (hall.error) return { error: `house: ${hall.error}` }
  const sp = stairwellPlan({ ...STAIR, baseCy: 0, topCy: FLOORS - 1, dir: STAIR_E, doorSide: 'far' })
  if (sp.error) return { error: `house: ${sp.error}` }
  ctx.kit.stairwell(map, sp, { enclosed: true })

  // The atrium carve opens the ring's outer edges onto the mass: wall them
  // again, keeping one door per storey (ground: from the anteroom; first:
  // the landing corridor, ending at a window; top: the Winchester door, one
  // step from the overlook rail).
  rewallRing(map, RING, [
    [{ axis: 'h', gx: HALL_DOOR.gx, gz: RING.z1 + 1 }],
    [{ axis: 'v', gx: RING.x0, gz: 5 }],
    [{ axis: 'v', gx: RING.x0, gz: OVERLOOK }],
  ])
  const exit = { gx: HALL.x1 - 1, gz: HALL.z0 + 1, cy: 0 }
  markExit(map, ctx, exit)

  // --- rooms (createRoom: residential furnishing), then the façade -----------
  const salt = (i) => r(i, 7) & 0xffff
  let n = 0
  const { shell, radio } = furnishShell(map, r, flip, () => salt(n++))

  const deep = []
  for (const rm of ROOMS_0) deep.push(room(map, 0, rm, rm.role, rm.door, salt(n++)))
  const upstairs = []
  for (const rm of ROOMS_1) upstairs.push(room(map, 1, rm, rm.role, rm.door, salt(n++)))
  // The guest room again: same shell, same door, same furniture (anomaly 3,
  // "the new one is a copy of the bedroom").
  const twin = copyRoom(map, upstairs[2], COPY_DX)
  // One upstairs room sleeps dark (its lamp dead), picked by the seed.
  const dark = r(2) % upstairs.length
  map.setLamp(lampCell(upstairs[dark]).gx, 1, lampCell(upstairs[dark]).gz, false)

  const rooms = [...Object.values(shell), ...deep, ...upstairs, twin]
  const shellArea = (SHELL.x1 - SHELL.x0 + 1) * (SHELL.z1 - SHELL.z0 + 1)
  notes.push(
    'look: from the yard the house is a 2-room façade; hide ceilings in the 3D preview and the plan behind it runs on through the mass, up a stair the roof cannot hold',
    `shell: ${shellArea} cells (${SHELL.x1 - SHELL.x0 + 1}×${SHELL.z1 - SHELL.z0 + 1}), façade of 2 windows, a sidelight and a door; living room ${flip ? 'east' : 'west'}${radio ? ', radio on its side table' : ''}`,
    `${rooms.length} furnished rooms (residential roles; the last is the guest room's copy next door) · front and back rooms share a door on both sides of the hall (2 cycles) · hall clock by the back door`,
    `loop: four identical L-hallways round a sealed block; the ${LOOP_Q[loop.q]} copy is mutated (${loop.anomaly}) · the SE closet opens on through its back wall`,
    `Great Hall: 10×10 void through ${FLOORS} storeys, unlit, unfurnished; window onto it at the end of the upstairs corridor; top-floor door opens one step from its rail (Winchester)`,
    `the ${ROOMS_1[dark].key} upstairs sleeps dark · exit: the hall's far corner`,
    'stand-ins: hedges are column mass; no 2.4 m ceilings or plenum; no seams, swaps or portals (S7) — the interior is real space hidden by mass; no spiral stair, the domestic stair is an enclosed core'
  )
  return { spawn: { gx: FRONT_DOOR, gz: 25, cy: 0 }, exit, notes }
}

// --- parts: the shell -----------------------------------------------------------------------

// The shell on its yard (tile-local cells): the yard (open, the porch lamp
// and two dark garden lamps), the shell's cells (rooms until createRoom
// stamps them), its hall with the clock by the back door, the front door and
// its sidelight on the façade line, the back door into the house.
export function buildShellPlan(p) {
  p.rect(YARD, CELL_OPEN)
  p.lamp(FRONT_DOOR, 22, true, WARM) // porch light
  p.lamp(2, 25, false)
  p.lamp(11, 25, false)
  p.rect(SHELL, CELL_ROOM)
  p.rect(SHELL_HALL, CELL_CORRIDOR)
  p.edge('h', FRONT_DOOR, 22, 0, PASSAGE_DOOR)
  p.window('h', FRONT_DOOR + 1, 22) // sidelight
  p.edge('h', 5, 17, 0, PASSAGE_DOOR) // the back door into the mass
  p.piece(6, 17, PROP_HALL_CLOCK, { wall: 'N' })
  p.lamp(5, 19, true, WARM)
}

// The shell's four rooms (living + dining at the front, kitchen + WC behind,
// mirrored by `flip`), each side's pair sharing a second door, the radio on
// the living room's side table, then one façade window per front room.
// Returns { shell: {key → room}, radio, sides }.
export function furnishShell(map, r, flip, nextSalt) {
  const sides = flip ? ['dining', 'living'] : ['living', 'dining']
  const backs = flip ? ['WC', 'kitchen'] : ['kitchen', 'WC']
  const roleOf = { living: SPACE_ROLE_LIVING, dining: SPACE_ROLE_DINING, kitchen: SPACE_ROLE_KITCHEN, WC: SPACE_ROLE_BATHROOM }
  const shell = {}
  let radio = null
  for (const [i, x0] of [[0, 2], [1, 7]]) {
    const doorX = i === 0 ? 5 : 7
    // Front and back rooms of a side share a second door in their outer
    // column (a domestic cycle: hall → front → back → hall), cut before
    // either is furnished so the grammar keeps both door cells free.
    const pair = [['front', sides[i]], ['back', backs[i]]].map(([band, key]) => {
      const b = SHELL_ROOMS[band]
      return { key, cy: 0, x0, z0: b.z0, x1: x0 + 2, z1: b.z1, role: roleOf[key], door: { axis: 'v', gx: doorX, gz: b.doorZ }, salt: nextSalt() }
    })
    const shared = { axis: 'h', gx: i === 0 ? x0 : x0 + 2, gz: SHELL_ROOMS.front.z0 }
    // The radio stands before the grammar furnishes round it.
    const prep = (rm, k) => {
      if (pair[k].key === 'living') radio = placeRadio(map, rm, r)
    }
    furnishTogether(map, pair, [shared], prep, false).forEach((rm, k) => (shell[pair[k].key] = rm))
  }
  // The first rooms the player sees, furnished full by the house's own
  // domestic grammar (furnish.js): the sofa facing the TV, the table with
  // its chairs, the kitchen run, the WC with its basin.
  const role = { living: 'living', dining: 'dining', kitchen: 'kitchen', WC: 'bath' }
  furnishHouseRooms(map, Object.entries(shell).map(([key, rec]) => ({ rec, role: role[key], skip: key === 'living' ? SKIP_RADIO : null })), r)
  // One window per façade room (the doc's count rule), cut after createRoom
  // rewrote the perimeter as plain wall.
  for (const key of sides) featureEdge(map, 'h', shell[key].x0 + 1, 0, SHELL.z1 + 1, WALL_WINDOW)
  return { shell, radio, sides }
}

// --- parts: the ring of an atrium ------------------------------------------------------------

// The atrium carve opens the ring's outer edges onto the mass: wall them
// again on every storey, keeping `openings[cy]` ({axis, gx, gz} edges) as doors.
export function rewallRing(map, ring, openings) {
  for (let cy = 0; cy < openings.length; cy++) {
    const doors = openings[cy]
    const set = (axis, gx, gz) => {
      const open = doors.some((door) => axis === door.axis && gx === door.gx && gz === door.gz)
      if (axis === 'v') map.setWallV(gx, cy, gz, open ? 0 : 1, open ? PASSAGE_DOOR : PASSAGE_WALL)
      else map.setWallH(gx, cy, gz, open ? 0 : 1, open ? PASSAGE_DOOR : PASSAGE_WALL)
    }
    for (let gz = ring.z0; gz <= ring.z1; gz++) {
      set('v', ring.x0, gz)
      set('v', ring.x1 + 1, gz)
    }
    for (let gx = ring.x0; gx <= ring.x1; gx++) {
      set('h', gx, ring.z0)
      set('h', gx, ring.z1 + 1)
    }
  }
}

// --- parts: the P.T. loop ---------------------------------------------------------------------

// The NW L-hallway of loop L ({ x0, z0, S, LX, LZ }: a leg along x on row
// z0+1, a leg along z on column x0+1, the elbow lit), a clock alcove off the
// long leg at (x0+3, z0) and a 1×1 closet off the short one at (x0, closetRow)
// (space id `space`), mirrored across x line LX and z line LZ into all four
// corners of an S×S ring. The finite kind's loop is { 15, 14, 10, 21, 20 }.
export function buildLoopAt(plan, L, space) {
  const { x0, z0, LX, LZ } = L
  plan.rect({ x0: x0 + 1, z0: z0 + 1, x1: LX - 1, z1: z0 + 1 })
  plan.rect({ x0: x0 + 1, z0: z0 + 2, x1: x0 + 1, z1: LZ - 1 })
  plan.lamp(x0 + 1, z0 + 1, true, WARM)
  plan.open(x0 + 3, z0)
  plan.piece(x0 + 3, z0, PROP_HALL_CLOCK, { wall: 'N' })
  const cz = closetRow(L)
  plan.room({ x0, z0: cz, x1: x0, z1: cz }, { spaceId: space, doors: [{ axis: 'v', gx: x0 + 1, gz: cz }] })
  plan.mirror({ axis: 'x', line: LX, from: { x0, z0, x1: LX - 1, z1: LZ - 1 }, spaceOffset: 1 })
  plan.mirror({ axis: 'z', line: LZ, from: { x0, z0, x1: x0 + L.S + 1, z1: LZ - 1 }, spaceOffset: 2 })
}

// The closet's row off the short leg: z0+4, or the leg's last cell on the
// smallest ring (S 6, the doc's 3 + 2 L; layout.loopClosetRow).
export const closetRow = (L) => Math.min(L.z0 + 4, L.LZ - 1)

// Quadrant q's copy of a NW cell (gx, gz) or V line gx of loop L.
export const qCell = (L, q, gx, gz) => ({
  gx: q & 1 ? 2 * L.LX - 1 - gx : gx,
  gz: q & 2 ? 2 * L.LZ - 1 - gz : gz,
})
const qLineV = (L, q, gx) => (q & 1 ? 2 * L.LX - gx : gx)

// One of the three later L's changes one property (the underpass's
// repetition-with-deviation, P.T.'s hallway).
function mutateLoop(plan, r) {
  const anomaly = LOOP_ANOMALIES[r(3) % LOOP_ANOMALIES.length]
  let q = 1 + (r(4) % 3)
  // The exit closet keeps its door.
  if (anomaly === 'missingDoor' && q === EXIT_Q) q = 1
  return mutateLoopWith(plan, anomaly, q, FINITE_LOOP, 210)
}
const EXIT_Q = 3

// The mutation itself: L `q` of loop L takes `anomaly` (the world passes the
// tile's hashed anomaly, geometry.anomalyAt); an extra door's closet takes
// space id `space`.
export function mutateLoopWith(plan, anomaly, q, L = FINITE_LOOP, space = 210) {
  const { x0, z0 } = L
  const elbow = qCell(L, q, x0 + 1, z0 + 1)
  const alcove = qCell(L, q, x0 + 3, z0)
  const lamp = plan.lamps.find((l) => l.gx === elbow.gx && l.gz === elbow.gz)
  const clock = plan.pieces.find((p) => p.gx === alcove.gx && p.gz === alcove.gz)
  if (anomaly === 'dark') lamp.lit = false
  if (anomaly === 'red') lamp.tint = RED
  if (anomaly === 'turned') Object.assign(clock, { wall: null, front: q & 1 ? FACING.W : FACING.E })
  if (anomaly === 'noClock') plan.pieces.splice(plan.pieces.indexOf(clock), 1)
  if (anomaly === 'missingDoor') {
    // The closet is gone: its cell back to mass, its doorway a plain wall.
    const closet = qCell(L, q, x0, closetRow(L))
    plan.cells.delete(`${closet.gx},${closet.gz}`)
    plan.edge('v', qLineV(L, q, x0 + 1), closet.gz, 1, PASSAGE_WALL)
  }
  if (anomaly === 'extraDoor') {
    // A second closet on the inner side of the short leg.
    const c = qCell(L, q, x0 + 2, z0 + 3)
    plan.room({ x0: c.gx, z0: c.gz, x1: c.gx, z1: c.gz }, { spaceId: space, doors: [{ axis: 'v', gx: qLineV(L, q, x0 + 2), gz: c.gz }] })
  }
  return { q, anomaly }
}

// --- parts: rooms ------------------------------------------------------------------------------

// createRoom (stamp, centre lamp, residential furnishing), the lamp warm.
export function room(map, cy, rect, role, door, salt) {
  const rm = createRoom(map, { cy, x0: rect.x0, z0: rect.z0, x1: rect.x1, z1: rect.z1, role, salt, door, lamp: true })
  const l = lampCell(rm)
  if (map.lampAt(l.gx, cy, l.gz)) map.setLamp(l.gx, cy, l.gz, true, WARM)
  return rm
}

// createRoom's steps (stamp, lamp, furnish, record) for rooms that share
// doors: every shell is stamped and every extra door cut before any room is
// furnished, so no piece lands in a door cell. `prep(room, i)` runs
// just before room i is furnished; `furnish` false stamps and lights only
// (the caller furnishes).
export function furnishTogether(map, specs, doors, prep = null, furnish = true) {
  const rooms = specs.map(({ cy, x0, z0, x1, z1, role, salt, door }) => {
    const rm = { id: map.nextRoomId++, cy, x0, z0, x1, z1, role, salt, door, baked: false }
    stampRoomShell(map, rm)
    return rm
  })
  for (const d of doors) {
    if (d.axis === 'v') map.setWallV(d.gx, rooms[0].cy, d.gz, 0, PASSAGE_DOOR)
    else map.setWallH(d.gx, rooms[0].cy, d.gz, 0, PASSAGE_DOOR)
  }
  rooms.forEach((rm, i) => {
    const l = lampCell(rm)
    map.setLamp(l.gx, rm.cy, l.gz, true, WARM)
    prep?.(rm, i)
    if (furnish) furnishRoom(map, rm)
    map.rooms.push(rm)
  })
  return rooms
}

export const lampCell = (rm) => ({ gx: Math.floor((rm.x0 + rm.x1) / 2), gz: Math.floor((rm.z0 + rm.z1) / 2) })
const inRoom = (rm, gx, gz) => gx >= rm.x0 && gx <= rm.x1 && gz >= rm.z0 && gz <= rm.z1

// The room cell behind door edge {axis, gx, gz}.
function doorCell(rm, door) {
  const a = door.axis === 'v' ? { gx: door.gx - 1, gz: door.gz } : { gx: door.gx, gz: door.gz - 1 }
  const b = { gx: door.gx, gz: door.gz }
  return inRoom(rm, a.gx, a.gz) ? a : b
}

// Whether any edge of the cell is a doorway.
function isDoorCell(map, cy, gx, gz) {
  const edges = [map.wallVAt(gx, cy, gz), map.wallVAt(gx + 1, cy, gz), map.wallHAt(gx, cy, gz), map.wallHAt(gx, cy, gz + 1)]
  return edges.some((e) => !e.wall && e.passage === PASSAGE_DOOR)
}

// Free cells of `rm` reachable from its door cell.
function reach(map, rm) {
  const { cy } = rm
  const start = doorCell(rm, rm.door)
  const free = (gx, gz) => inRoom(rm, gx, gz) && !map.cellAt(gx, cy, gz).col
  const seen = new Set()
  if (!free(start.gx, start.gz)) return seen
  seen.add(`${start.gx},${start.gz}`)
  const stack = [start]
  while (stack.length) {
    const c = stack.pop()
    for (const [dx, dz] of NEIGHBOURS) {
      const gx = c.gx + dx
      const gz = c.gz + dz
      if (!free(gx, gz) || seen.has(`${gx},${gz}`)) continue
      seen.add(`${gx},${gz}`)
      stack.push({ gx, gz })
    }
  }
  return seen
}

const freeCount = (map, rm) => {
  let n = 0
  for (let gz = rm.z0; gz <= rm.z1; gz++) for (let gx = rm.x0; gx <= rm.x1; gx++) if (!map.cellAt(gx, rm.cy, gz).col) n++
  return n
}

// The radio on its side table, against a wall of the living room, on the
// first free wall cell (seed order) that is no doorway and leaves the rest
// of the room reachable.
export function placeRadio(map, rm, r) {
  const { cy } = rm
  const cells = []
  for (let gz = rm.z0; gz <= rm.z1; gz++) {
    for (let gx = rm.x0; gx <= rm.x1; gx++) {
      const wall = gz === rm.z0 ? 'N' : gz === rm.z1 ? 'S' : gx === rm.x0 ? 'W' : gx === rm.x1 ? 'E' : null
      if (wall) cells.push({ gx, gz, wall })
    }
  }
  const start = r(5) % cells.length
  const before = freeCount(map, rm)
  for (let i = 0; i < cells.length; i++) {
    const { gx, gz, wall } = cells[(start + i) % cells.length]
    const c = map.cellAt(gx, cy, gz)
    if (c.col || map.lampAt(gx, cy, gz)) continue
    if (isDoorCell(map, cy, gx, gz)) continue
    addPiece(map, cy, { gx, gz, kind: PROP_RADIO, front: { N: FACING.S, S: FACING.N, W: FACING.E, E: FACING.W }[wall], wall })
    if (reach(map, rm).size === before - 1) return { gx, gz }
    map.removeFurniture(gx, cy, gz)
  }
  return null
}

// stampRoomShell (createRoom without furnishing) (dx, dz) cells from `src`,
// its lamp and furniture copied piece for piece.
export function copyRoom(map, src, dx, dz = 0) {
  const { cy } = src
  const rm = {
    id: map.nextRoomId, cy, x0: src.x0 + dx, z0: src.z0 + dz, x1: src.x1 + dx, z1: src.z1 + dz,
    role: src.role, salt: src.salt, door: { ...src.door, gx: src.door.gx + dx, gz: src.door.gz + dz }, baked: false,
  }
  map.nextRoomId++
  stampRoomShell(map, rm)
  map.rooms.push(rm)
  copyContents(map, src, dx, dz)
  return rm
}

// The lamp and furniture of room `src`, copied (dx, dz) cells on.
export function copyContents(map, src, dx, dz = 0) {
  const { cy } = src
  for (let gz = src.z0; gz <= src.z1; gz++) {
    for (let gx = src.x0; gx <= src.x1; gx++) {
      const lamp = map.lampAt(gx, cy, gz)
      if (lamp) map.setLamp(gx + dx, cy, gz + dz, lamp.rec.lit, lamp.rec.tint ?? null)
      // Every piece of the cell (a group packs several into one), but none
      // that would give the twin's chunk a kind over KIND_CAP.
      for (const f of map.furnitureListAt(gx, cy, gz)) {
        const to = map.chunkAt(map.cellChunk(gx + dx), cy, map.cellChunk(gz + dz))
        if (to && !to.furniture.some((q) => q.kind === f.rec.kind) && new Set(to.furniture.map((q) => q.kind)).size >= KIND_CAP) continue
        const { lx: _lx, lz: _lz, ...rec } = f.rec
        const X = map.cellChunk(gx) * CHUNK * CELL + rec.x + dx * CELL
        const moved = { ...rec, x: X - map.cellChunk(gx + dx) * CHUNK * CELL }
        if (dz) {
          const Z = map.cellChunk(gz) * CHUNK * CELL + rec.z + dz * CELL
          moved.z = Z - map.cellChunk(gz + dz) * CHUNK * CELL
        }
        map.addFurniture(gx + dx, cy, gz + dz, moved)
      }
    }
  }
}

// The kind lab's layout (the finite kind's cells; kind-house.test reads it).
export const HOUSE_LAYOUT = Object.freeze({
  floors: FLOORS, shell: SHELL, yard: YARD, hall: HALL, ring: RING, overlook: OVERLOOK,
  loopQuadrants: LOOP_Q, loopLine: LOOP_LINE, anteroom: ANTEROOM_2, copyDx: COPY_DX, red: RED, warm: WARM,
})
