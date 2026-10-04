import {
  CELL,
  CELL_CORRIDOR,
  CELL_LOBBY,
  FACING,
  FloorPlan,
  PASSAGE_DOOR,
  PASSAGE_WIDE,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_STORAGE,
  STAIR_E,
  STAIR_W,
  THICK,
  WALL_TO_FRONT,
  addPiece,
  labelFloor,
  rng,
} from '../../tiles/floorPlan.js'
import { FURN_CABINET, FURN_COUNTER, FURN_DESK, FURN_WHITEBOARD } from '../../rooms/catalog.js'
import { PIECE_DIMS } from '../../rooms/furnish.js'
import { PROP_METRO_BENCH, PROP_SEAT_PAIR, PROP_TICKET_GATE } from '../../props/index.js'
import { stairwellPlan } from '../../structures/authored.js'
import { markExit } from '../../tiles/kit.js'
import { SALT, STATIONS } from './geometry.js'
import { KIOSK_TINT, TRAIN_TINT } from './tile.js'

// 07 — The Endless Train (docs/liminal_maps/07-endless-train.md, §13 step 1):
// the kind lab's static grey-box, kept as the family's PARTS CATALOGUE. One
// train of seven cars along +x stopped at one station; nothing moves (the
// treadmill exterior, S16, the schedule, S13, and doors that close, S6, do
// not exist). The world's tiles (world.js) are not this map repeated: they
// compose these parts — the car types (commuter benches, transverse seat
// pairs, the dark baggage car), the gangway doors, the platform with its
// wide doors, benches and booth, the enclosed stair cores, the concourse
// with its gate line, kiosk, toilets, line map and exit closet — with a
// grammar of their own (car sequences and a snaking path, station layouts,
// lineside rooms, the passage level).
//
// Storeys: cy 0 the train, its platform and the tunnel walkways; cy 1 the
// concourse over the station, reached by two enclosed stairs off the
// platform.
//
// Plan (global cells, cy 0):
//
//   z 1     sealed tunnel wall (column mass) behind the far-side windows
//   z 2..4  the train: cab x 1..2 (aisle only), cars x 3..51 (7 × 7 cells),
//           cab x 52..53; aisle z 3, seat and door bays z 2 and z 4
//   z 5..6  the platform x 17..37 beside cars 3..5, WIDE door openings into
//           them; 1-wide tunnel walkways x 11..16 and 38..43 at its ends
//   z 7..10 stair cores x 17..22 and 32..37, the station-master's booth
//
// A car is 3 cells wide, not 1 (doc §4.2's one-cell carriage needs the
// edge-furniture class): a piece blocks its whole cell for walking, so the
// seats sit in 1-cell side bays and the aisle between them stays free.

const TRAIN = 0
const CONC = 1

const DOOR_BAYS = [1, 3, 5] // car-local cells of the side door pairs; seats at 0, 2, 4, 6
const SEAT_BAYS = [0, 2, 4, 6]
const STATION_CARS = [2, 3, 4]
const ANOMALIES = Object.freeze(['carNumbers', 'stationName', 'wrongSide'])

// The kind's frame: seven cars from x 3, two cabs, the station beside cars
// 2..4 of that train.
const F = Object.freeze({
  cars: 7,
  carX0: 3,
  far: 2,
  aisle: 3,
  near: 4,
  site: { x0: 0, z0: 0, x1: 55, z1: 13 },
  platform: { x0: 17, z0: 5, x1: 37, z1: 6 },
  walkways: [{ x0: 11, x1: 16 }, { x0: 38, x1: 43 }],
  platformBenches: [21, 23, 29, 31, 36],
  booth: { x0: 26, z0: 7, x1: 27, z1: 7 },
  stairs: [
    { gx: 18, gz: 8, dir: STAIR_E, doorSide: 'near' },
    { gx: 36, gz: 8, dir: STAIR_W, doorSide: 'near' },
  ],
  concSite: { x0: 14, z0: 0, x1: 41, z1: 13 },
  concourse: { x0: 17, z0: 1, x1: 37, z1: 6 },
  gateZ: 3,
  gateBank: { x0: 23, x1: 31 },
  closet: { x0: 15, z0: 1, x1: 16, z1: 2 },
  exit: { gx: 15, gz: 1 },
  kiosk: { x0: 38, z0: 1, x1: 40, z1: 2 },
  toilets: { x0: 38, z0: 5, x1: 40, z1: 6 },
  whiteboard: 27,
  concBenches: [25, 29],
  freeLamps: [19, 25, 31, 36],
  freeLampSplit: 30,
  paidLamps: [21, 27, 33],
})

export function buildTrainKind(map, seed, ctx) {
  const { cars: CARS, carX0: CAR_X0, far: FAR, aisle: AISLE, near: NEAR } = F
  const carX0 = (k) => CAR_X0 + 7 * k
  const PLATFORM = F.platform
  const CONCOURSE = F.concourse
  const r = rng(seed, SALT)
  const anomaly = ANOMALIES[r(1) % ANOMALIES.length]
  const [stationName, drifted] = STATIONS[r(2) % STATIONS.length]
  // The dark car (a baggage car: no seats, no windows, dead tubes) is never
  // one the platform serves; the car whose far doors open onto the tunnel
  // wall (anomaly) is a station car.
  const darkCar = [0, 1, 5, 6][r(3) % 4]
  const wrongCar = STATION_CARS[r(4) % STATION_CARS.length]
  const wrongSide = (k) => anomaly === 'wrongSide' && k === wrongCar
  // The neighbour whose nearest tube fails with the dark car (an end car
  // already has its dead cab on one side).
  const failSide = darkCar === 0 || darkCar === CARS - 1 ? 0 : r(14) % 2 ? 1 : -1
  const carType = []
  for (let k = 0; k < CARS; k++) carType.push(k === darkCar ? 'dark' : r(k, 5) % 3 === 0 ? 'open' : 'commuter')
  const pieces = [] // [cy, record]: addPiece records, or raw furniture ({raw})
  const put = (cy, gx, gz, kind, { wall = null, facing = FACING.S } = {}) => {
    pieces.push([cy, { gx, gz, kind, front: wall ? WALL_TO_FRONT[wall] : facing, wall }])
  }
  let windows = 0
  let spaceId = 700

  // --- cy 0: the train -----------------------------------------------------------
  const t = new FloorPlan(F.site)
  const glaze = (gx, line) => {
    t.window('h', gx, line)
    windows++
  }
  for (let k = 0; k < CARS; k++) {
    const x0 = carX0(k)
    const type = carType[k]
    const stationCar = STATION_CARS.includes(k)
    const doors = []
    if (stationCar) for (const b of DOOR_BAYS) doors.push({ axis: 'h', gx: x0 + b, gz: NEAR + 1, passage: PASSAGE_WIDE })
    if (wrongSide(k)) {
      // The doors open onto the tunnel wall: a one-cell niche each.
      for (const b of DOOR_BAYS) {
        doors.push({ axis: 'h', gx: x0 + b, gz: FAR, passage: PASSAGE_WIDE })
        t.open(x0 + b, FAR - 1, CELL_CORRIDOR)
      }
    }
    t.room({ x0, z0: FAR, x1: x0 + 6, z1: NEAR }, { spaceId: spaceId++, doors })
    // Glass along both sides of the seat bays (the dark car is a blind
    // baggage van); door bays stay solid where no door opens.
    if (type !== 'dark') {
      for (const b of SEAT_BAYS) {
        glaze(x0 + b, FAR)
        glaze(x0 + b, NEAR + 1)
      }
      if (!wrongSide(k)) {
        // Far-side door leaves are glazed too: the tunnel shows through them.
        for (const b of DOOR_BAYS) glaze(x0 + b, FAR)
      }
    }
    // The ceiling strip down the aisle: lit and tinted, dead in the dark
    // car, and one neighbour's tube nearest it fails too (the spill through
    // the gangways would otherwise light it from both ends).
    for (const b of SEAT_BAYS) {
      const lit = type !== 'dark' && !(failSide && k === darkCar + failSide && b === (failSide < 0 ? 6 : 0))
      t.lamp(x0 + b, AISLE, lit, lit ? TRAIN_TINT : null)
    }
    // Seats in the side bays; the aisle and the door bays stay free.
    for (const b of SEAT_BAYS) {
      const gx = x0 + b
      if (type === 'commuter') {
        put(TRAIN, gx, FAR, PROP_METRO_BENCH, { wall: 'N' })
        put(TRAIN, gx, NEAR, PROP_METRO_BENCH, { wall: 'S' })
      } else if (type === 'open') {
        // Transverse pairs against the windows, alternate bays facing each
        // other along the car.
        const facing = b % 4 === 0 ? FACING.E : FACING.W
        pieces.push([TRAIN, { raw: seatPair(map, gx, FAR, 'N', facing) }])
        pieces.push([TRAIN, { raw: seatPair(map, gx, NEAR, 'S', facing) }])
      } else if (r(k, b) % 2 === 0) {
        put(TRAIN, gx, b % 4 === 0 ? FAR : NEAR, FURN_CABINET, { wall: b % 4 === 0 ? 'N' : 'S' })
      }
    }
  }
  // Gangways: one door on the aisle between cars, solid car ends either side.
  for (let k = 1; k < CARS; k++) t.edge('v', carX0(k), AISLE, 0, PASSAGE_DOOR)
  // Driver's cabs: dead ends with a window onto the tunnel that never ends.
  const lastX = carX0(CARS)
  const cabs = [{ x0: 1, door: CAR_X0, glass: 1 }, { x0: lastX, door: lastX, glass: lastX + 2 }]
  for (const c of cabs) {
    t.room({ x0: c.x0, z0: AISLE, x1: c.x0 + 1, z1: AISLE }, { spaceId: spaceId++, role: SPACE_ROLE_STORAGE, lamp: false })
    t.edge('v', c.door, AISLE, 0, PASSAGE_DOOR)
    t.window('v', c.glass, AISLE)
    windows++
  }

  // The platform: WIDE openings into the three station cars (set by their
  // rooms), benches against the back wall, most lamps dead.
  t.rect(PLATFORM, CELL_LOBBY)
  const platformLit = new Set([r(6) % 5, (r(6) % 5 + 2 + (r(7) % 2)) % 5])
  // Five lamps spaced inside the platform, none on the walkways.
  for (let i = 0; i < 5; i++) t.lamp(PLATFORM.x0 + 2 + i * 4, PLATFORM.z0, platformLit.has(i) && r(i, 8) % 3 !== 0)
  for (const gx of F.platformBenches) put(TRAIN, gx, PLATFORM.z1, PROP_METRO_BENCH, { wall: 'S' })
  // Tunnel mouths: 1-wide walkways past the platform ends, dark, dead-ending
  // in the mass; the passing cars look onto them through their glass.
  for (const w of F.walkways) {
    t.rect({ x0: w.x0, z0: PLATFORM.z0, x1: w.x1, z1: PLATFORM.z0 }, CELL_CORRIDOR)
    t.lamp((w.x0 + w.x1) >> 1, PLATFORM.z0, false)
  }
  // The station-master's booth (a ghost-station landmark), dark.
  const BOOTH = F.booth
  t.room(BOOTH, { spaceId: spaceId++, role: SPACE_ROLE_STORAGE, doors: [{ axis: 'h', gx: BOOTH.x0, gz: BOOTH.z0 }], lamp: false })
  put(TRAIN, BOOTH.x1, BOOTH.z0, FURN_DESK, { wall: 'S' })
  t.compile(map, TRAIN)

  // --- cy 1: the concourse --------------------------------------------------------
  let gates = 0
  const c = new FloorPlan(F.concSite)
  c.rect(CONCOURSE, CELL_LOBBY)
  // The gate line: a bank of gates with walk gaps between them, rails along
  // the rest of the line (free side north, paid side and stairs south).
  const GATE_Z = F.gateZ
  const GATE_BANK = F.gateBank
  for (let gx = CONCOURSE.x0; gx <= CONCOURSE.x1; gx++) {
    if (gx >= GATE_BANK.x0 && gx <= GATE_BANK.x1) continue
    c.rail('h', gx, GATE_Z)
  }
  const gateParity = r(9) % 2
  for (let gx = GATE_BANK.x0; gx <= GATE_BANK.x1; gx++) {
    if ((gx - GATE_BANK.x0) % 2 !== gateParity) continue
    put(CONC, gx, GATE_Z, PROP_TICKET_GATE, { facing: FACING.S })
    gates++
  }
  // Exit stairs to the street (a closet: the exit) and a kiosk on the free
  // side; toilets off the paid side beside the east stair top.
  const CL = F.closet
  c.room(CL, { spaceId: 800, role: SPACE_ROLE_STORAGE, doors: [{ axis: 'v', gx: CL.x1 + 1, gz: CL.z0, passage: PASSAGE_WIDE }] })
  c.lamp(CL.x0, CL.z0, true)
  const K = F.kiosk
  c.room(K, { spaceId: 801, role: SPACE_ROLE_STORAGE, doors: [{ axis: 'v', gx: K.x0, gz: K.z1, passage: PASSAGE_WIDE }] })
  const kioskLit = r(10) % 2 === 0
  c.lamp(K.x0 + 1, K.z0, kioskLit, kioskLit ? KIOSK_TINT : null)
  put(CONC, K.x0 + 1, K.z0, FURN_COUNTER, { wall: 'N' })
  put(CONC, K.x0 + 2, K.z0, FURN_COUNTER, { wall: 'N' })
  const T = F.toilets
  c.room(T, { spaceId: 802, role: SPACE_ROLE_BATHROOM, doors: [{ axis: 'v', gx: T.x0, gz: T.z0 }], lamp: false })
  // The line map (a whiteboard stand-in) on the free side's north wall.
  put(CONC, F.whiteboard, CONCOURSE.z0, FURN_WHITEBOARD, { wall: 'N' })
  for (const gx of F.concBenches) put(CONC, gx, CONCOURSE.z1, PROP_METRO_BENCH, { wall: 'S' })
  // Free side lit near the exit, paid side mostly dead.
  for (const gx of F.freeLamps) c.lamp(gx, CONCOURSE.z0 + 1, gx < F.freeLampSplit || r(gx, 11) % 2 === 0)
  for (const gx of F.paidLamps) c.lamp(gx, CONCOURSE.z1 - 1, r(gx, 12) % 4 === 0)
  c.compile(map, CONC)

  // --- stamps: the stairs ------------------------------------------------------------
  for (const at of F.stairs) {
    const sp = stairwellPlan({ ...at, baseCy: TRAIN, topCy: CONC })
    if (sp.error) return { error: `train stair: ${sp.error}` }
    ctx.kit.stairwell(map, sp, { enclosed: true })
  }

  // --- touch-ups: plates ------------------------------------------------------------
  // Car numbers on the train's plates (the car at each chunk's centre:
  // 1, 3, 5, 7; the anomaly counts them backwards or repeats one), the
  // station's name on the concourse's.
  const numbers = anomaly !== 'carNumbers' ? [1, 3, 5, 7] : r(13) % 2 === 0 ? [7, 5, 3, 1] : [1, 3, 3, 3]
  for (let cx = 0; cx < numbers.length; cx++) labelFloor(map, TRAIN, `C${numbers[cx]}`, { cx, cz: 0 })
  const nameDrifts = anomaly === 'stationName'
  labelFloor(map, CONC, stationName, { cx: 1, cz: 0 })
  labelFloor(map, CONC, nameDrifts ? drifted : stationName, { cx: 2, cz: 0 })
  const exit = { gx: F.exit.gx, gz: F.exit.gz, cy: CONC }
  markExit(map, ctx, exit)

  // --- furniture last ----------------------------------------------------------------
  for (const [cy, p] of pieces) {
    if (p.raw) {
      if (!map.cellAt(p.raw.gx, cy, p.raw.gz).col) map.addFurniture(p.raw.gx, cy, p.raw.gz, p.raw.rec)
    } else addPiece(map, cy, p)
  }

  const types = carType.map((ty) => ({ commuter: 'c', open: 'o', dark: 'D' })[ty]).join('')
  const lie = {
    carNumbers: `the car plates lie (${numbers.map((n) => `C${n}`).join(' ')})`,
    stationName: `the station's name drifts between its plates (${stationName} / ${drifted})`,
    wrongSide: `car ${wrongCar + 1}'s far-side doors open onto the tunnel wall`,
  }[anomaly]
  return {
    spawn: { gx: 1, gz: AISLE, cy: TRAIN },
    exit,
    notes: [
      `train: ${CARS} cars × 7 cells (${types}: c commuter benches, o transverse pairs, D the dark baggage car ${darkCar + 1}), gangway doors on the aisle, cabs at both ends`,
      `station ${stationName}: platform beside cars 3–5 with ${STATION_CARS.length * DOOR_BAYS.length} wide door openings, 2 stairs up to the concourse, ${gates} ticket gates with walk gaps`,
      `anomaly ${anomaly}: ${lie}`,
      `look at: from the rear cab (spawn), the one-point view down the aisle through every gangway; ${windows} panes onto the sealed tunnel, the walkways and the platform; the half-dead platform and concourse against the lit train`,
      'stand-ins: tunnel = column mass behind glass; closed side doors = plain walls; car numbers and station name = level plates; line map = whiteboard; exit = closet off the concourse',
      'not built: motion and the moving exterior (S16), the schedule (S13), doors that close and gangways that lock (S6), track bed, third rail and the far platform; seats block whole cells (no edge furniture), so cars are 3 cells wide',
    ],
  }
}

// A transverse seat pair facing along the car (E/W), pushed against the
// side wall: addPiece only hugs a wall with the piece's back, so place it by
// hand (dims rotate: E/W fronts swap w and d).
function seatPair(map, gx, gz, wall, facing) {
  const [w0, d0] = PIECE_DIMS[PROP_SEAT_PAIR]
  const w = d0
  const d = w0
  const off = CELL / 2 - THICK / 2 - d / 2 - 0.06
  const x = (map.cellLocal(gx) + 0.5) * CELL
  const z = (map.cellLocal(gz) + 0.5) * CELL + (wall === 'N' ? -off : off)
  return { gx, gz, rec: { kind: PROP_SEAT_PAIR, x, z, w, d, facing } }
}
