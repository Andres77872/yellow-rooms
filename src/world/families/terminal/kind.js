import {
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  FACING,
  FloorPlan,
  PASSAGE_DOOR,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_OFFICE,
  SPACE_ROLE_STORAGE,
  STAIR_E,
  STAIR_S,
  WALL_TO_FRONT,
  addPiece,
  labelFloor,
  rng,
} from '../../tiles/floorPlan.js'
import { FURN_COUNTER, FURN_PLANT, FURN_RACK, FURN_SOFA } from '../../rooms/catalog.js'
import { PROP_BEAM_SEAT, PROP_FIDS, PROP_GATE_PODIUM } from '../../props/index.js'
import { stairwellPlan } from '../../structures/authored.js'
import { finiteCtx, markExit } from '../../tiles/kit.js'
import { BAG, DEP, MEZ, SALT } from './geometry.js'

// 08 — The Terminal (docs/liminal_maps/08-terminal.md): an airport at an hour
// with no flights. A comb: one long spine with two dead-end piers, every pier
// a 5-wide concourse between 3-deep holdrooms whose outer walls are glass onto
// a sealed apron, glass or steel jet bridges that end at a door into a
// closet, and a tip lounge where the pier stops. One pier is dead, the
// other's gates are lit.
//
// Storeys: cy 0 baggage hall (carousels) reached only by the piers' service
// stairs, cy 1 departures (check-in, the security serpentine, spine, piers),
// cy 2 the mezzanine over the spine's bridged atrium.
//
// Plan (global cells, departures): landside x 1..13 (check-in hall, then the
// rail queue x 10..13), spine x 14..54 × z 3..10 with the atrium void
// x 16..38 × z 5..8, piers south from z 11 at x 12..22 (A) and 33..43 (B),
// tips z 30..35. The apron between and beside the piers stays column mass.
//
// The editor kind's body (the kind lab's finite map, byte-identical; the
// editor wrapper src/editor/kinds/terminal.js reaches it through tile.js's
// buildTerminalTile with FINITE_CTX_TERMINAL). It is the terminal family's
// parts catalogue: the world's tile grammar (geometry.js layoutOf, tile.js)
// builds every tile from these parts (pier bands, holdrooms, jet bridges, tip
// lounges, the serpentine, shops, carousels, the mezzanine units, the stair
// cores and plates) without ever repeating this arrangement.

// --- the kind's plan (kind-local cells) ------------------------------------------

const R = (x0, z0, x1, z1) => ({ x0, z0, x1, z1 })
const SPINE = Object.freeze(R(14, 3, 54, 10))
// The atrium (bridged along x) stays in chunks cx 1..2 so the landside's
// queue rails (cx 0) never sit in an atrium base chunk.
const VOID = Object.freeze(R(16, 5, 38, 8))
const PIER_X = Object.freeze([12, 33]) // west edge of each pier: holdroom 3 + concourse 5 + holdroom 3
const HOLD_Z = Object.freeze([12, 18, 24]) // three holdrooms a side, 6 long
const TIP = Object.freeze({ z0: 30, z1: 35 })

export const GATE_TINT = 0xd4e2ff // sign and FIDS glow: cool
export const LOUNGE_TINT = 0xffe0b8 // club lounge tungsten

// The kind lab's finite ctx (the editor kind's map, byte-identical).
export const FINITE_CTX_TERMINAL = finiteCtx({})

// FIDS banks (three stands) over each pier mouth; unbroken seat rows on
// the south lane between them. Runs, not scattered islands, keep the spine
// one readable hall (and its space graph a few rectangles).
const SPINE_FIDS = [[16, 18], [37, 39]]
const SPINE_SEATS = [[21, 34], [42, 53]]
const SHOPS = [[20, 24], [27, 31], [39, 43]]
// Carousel west columns; x 18 stays an aisle beside the baggage office.
const CAROUSEL_X = [19, 25, 31]
// Service stairs down to baggage at each pier's midpoint, in the apron
// between the piers (door into the middle inner holdroom).
const PIER_STAIR = [
  { gx: 24, gz: 19, dir: STAIR_S, doorSide: 'near' }, // core x 23..26, door v 23 @ z 20
  { gx: 30, gz: 19, dir: STAIR_S, doorSide: 'far' }, // core x 29..32, door v 33 @ z 20
]
// The mezzanine stair beyond the atrium's east end (core x 45..50 × z 1..4,
// door h 5 @ x 47).
const MEZ_STAIR = { gx: 46, gz: 2, dir: STAIR_E, doorSide: 'far' }

// Plate labels: a gate block per pier chunk. The seed picks how the numbers
// lie (doc §10.4: gate numbers skip, repeat or count down).
const GATE_SCHEMES = Object.freeze({
  repeat: [['C12', 'C14'], ['C12', 'C14']],
  countdown: [['C40', 'C38'], ['C36', 'C34']],
  skip: [['C2', 'C4'], ['C9', 'C13']],
})
export function buildTerminalKind(map, seed, ctx = FINITE_CTX_TERMINAL) {
  const r = rng(seed, SALT)
  const deadPier = r(1) % 2
  const scheme = Object.keys(GATE_SCHEMES)[r(2) % 3]
  const isDead = (p) => p === deadPier
  const gateTint = () => GATE_TINT
  const pieces = [] // [cy, piece] — placed after every stamp
  const put = (cy, gx, gz, kind, { wall = null, facing = FACING.S } = {}) => {
    pieces.push([cy, { gx, gz, kind, front: wall ? WALL_TO_FRONT[wall] : facing, wall }])
  }
  const fids = (cy, gx, gz, { wall = null, facing = FACING.S }) => {
    const front = wall ? WALL_TO_FRONT[wall] : facing
    pieces.push([cy, { gx, gz, kind: PROP_FIDS, front, wall }])
  }
  let spaceId = 800
  let windows = 0

  // --- departures --------------------------------------------------------------
  const dep = new FloorPlan({ x0: 0, z0: 0, x1: 54, z1: 40 })
  // Landside: the check-in hall (counters along its south wall), then the
  // queue lanes.
  dep.rect({ x0: 1, z0: 3, x1: 9, z1: 10 }, CELL_LOBBY)
  for (let gx = 2; gx <= 7; gx++) put(DEP, gx, 10, FURN_COUNTER, { wall: 'S' })
  put(DEP, 1, 3, PROP_FIDS, { wall: 'N' })
  for (const gx of [2, 5, 8]) dep.lamp(gx, 8, r(gx, 3) % 3 !== 0)
  security(dep, r)

  // The spine: one hall, the atrium void down its middle (stamped later).
  dep.rect(SPINE, CELL_LOBBY)
  for (const [a, b] of SPINE_FIDS) for (let gx = a; gx <= b; gx++) fids(DEP, gx, 3, { wall: 'N' })
  for (const [a, b] of SPINE_SEATS) for (let gx = a; gx <= b; gx++) put(DEP, gx, 10, PROP_BEAM_SEAT, { wall: 'S' })
  // Duty-free shops behind the north lane: grille fronts (WIDE), shelving
  // along the back wall, a few still glowing.
  for (const [x0, x1] of SHOPS) {
    const mid = (x0 + x1) >> 1
    const lit = r(x0, 23) % 3 !== 0
    const doors = [mid - 1, mid, mid + 1].map((gx) => ({ axis: 'h', gx, gz: 3, passage: PASSAGE_WIDE }))
    dep.room({ x0, z0: 1, x1, z1: 2 }, { spaceId: spaceId++, role: SPACE_ROLE_STORAGE, doors })
    dep.lamp(mid, 2, lit, lit ? LOUNGE_TINT : null)
    for (let gx = x0; gx <= x1; gx += 2) put(DEP, gx, 1, FURN_RACK, { wall: 'N' })
  }
  // High-bay rows on the ring lines; whole 8-cell circuits fail together.
  for (let gx = 15; gx <= 53; gx += 2) {
    const lit = r(gx >> 3, 4) % 5 < 3
    // North row skips the mezzanine stair core (x 45..50).
    dep.lamp(gx, gx % 4 === 1 && (gx < 44 || gx > 51) ? 4 : 9, lit)
  }

  // Piers.
  const gates = [] // {pier, closet:{gx,gz}} — the boarding doors
  // Most tubes are glass, some steel; none north of z 14, whose chunks are
  // the atrium's base storey (no features allowed there).
  const board = (b) => {
    const id = spaceId++
    const g = jetBridge(dep, { ...b, spaceId: id, glass: b.gz >= 14 && r(id, 24) % 5 !== 0 })
    windows += g.panes
    gates.push(g)
  }
  for (let p = 0; p < 2; p++) {
    const X = PIER_X[p]
    const dead = isDead(p)
    // Concourse: 5 wide, the dead travelator (a counter line) down its
    // centre cell, open at both ends.
    dep.rect({ x0: X + 3, z0: 11, x1: X + 7, z1: TIP.z0 - 1 }, CELL_CORRIDOR)
    for (let gz = 13; gz <= TIP.z0 - 2; gz++) put(DEP, X + 5, gz, FURN_COUNTER, { facing: FACING.E })
    for (let gz = 12; gz < TIP.z0; gz += 4) dep.lamp(X + 5, gz, !dead && r(p, gz) % 3 !== 0)
    // Restrooms either side of the pier root.
    for (const [x0, line] of [[X, X + 3], [X + 8, X + 8]]) {
      dep.room({ x0, z0: 11, x1: x0 + 2, z1: 11 }, { spaceId: spaceId++, role: SPACE_ROLE_BATHROOM, doors: [{ axis: 'v', gx: line, gz: 11 }], lamp: false })
    }
    for (let k = 0; k < HOLD_Z.length; k++) {
      const z0 = HOLD_Z[k]
      const z1 = z0 + 5
      for (const side of ['W', 'E']) {
        const outer = side === 'W' ? X : X + 10
        const mid = side === 'W' ? X + 1 : X + 9
        const outerLine = side === 'W' ? X : X + 11
        const frontLine = side === 'W' ? X + 3 : X + 8
        // The apron side between the piers: A's east, B's west.
        const inner = (p === 0) === (side === 'E')
        const stair = inner && k === 1
        // Gate row: inner rows are fixed so A's and B's bridges interleave;
        // outer rows ride the seed.
        const zg = stair ? null : inner ? (p === 0 ? z0 + 1 : z1 - 1) : z0 + 1 + (r(p * 8 + k, side === 'W' ? 5 : 6) % 4)
        const doors = []
        for (let gz = z0 + 1; gz <= z1 - 1; gz++) doors.push({ axis: 'v', gx: frontLine, gz, passage: PASSAGE_WIDE })
        if (zg !== null) doors.push({ axis: 'v', gx: outerLine, gz: zg, passage: PASSAGE_DOOR })
        const lit = !dead || (k === 2 && side === 'W' && r(p, 7) % 2 === 0)
        // A W holdroom spans X..X+2, an E one X+8..X+10.
        const x0 = side === 'W' ? X : X + 8
        dep.room({ x0, z0, x1: x0 + 2, z1 }, { spaceId: spaceId++, role: SPACE_ROLE_LOUNGE, doors })
        dep.lamp(mid, z0 + 2, lit, lit ? gateTint(p) : null)
        // Seats face the glass in the middle column; the ends stay free so the
        // window aisle joins the front aisle.
        for (let gz = z0 + 1; gz <= z1 - 1; gz++) put(DEP, mid, gz, PROP_BEAM_SEAT, { facing: side === 'W' ? FACING.W : FACING.E })
        const zp = zg === null ? z0 : zg < z1 ? zg + 1 : zg - 1
        put(DEP, outer, zp, PROP_GATE_PODIUM, { wall: side })
        // Glass on the outer wall (south of the atrium chunks only).
        for (let gz = z0; gz <= z1; gz++) {
          if (gz === zg || stair || gz < 14) continue
          dep.window('v', outerLine, gz)
          windows++
        }
        if (zg !== null) {
          const len = inner ? 4 + (r(p * 8 + k, 9) % 2) : 4 + (r(p * 8 + k, 10) % 6)
          board({ gx: side === 'W' ? outerLine - 1 : outerLine, gz: zg, dx: side === 'W' ? -1 : 1, len, pier: p })
        }
      }
    }
    // Tip lounge: the dead end, glass on three sides, three more gates.
    const tip = { x0: X, z0: TIP.z0, x1: X + 10, z1: TIP.z1 }
    // Inner tip rows are fixed (A's east 31, B's west 34) so the two piers'
    // bridges never meet in the apron between them.
    const tipRowW = p === 1 ? 34 : 32 + (r(p, 11) % 3)
    const tipRowE = p === 0 ? 31 : 32 + (r(p, 12) % 3)
    const tipS = X + 5
    const tipDoors = [
      { axis: 'v', gx: X, gz: tipRowW },
      { axis: 'v', gx: X + 11, gz: tipRowE },
      { axis: 'h', gx: tipS, gz: TIP.z1 + 1 },
    ]
    for (let gx = X + 3; gx <= X + 7; gx++) tipDoors.push({ axis: 'h', gx, gz: TIP.z0, passage: PASSAGE_WIDE })
    dep.room(tip, { spaceId: spaceId++, role: SPACE_ROLE_LOUNGE, doors: tipDoors })
    for (let gz = TIP.z0; gz <= TIP.z1; gz++) {
      if (gz !== tipRowW) dep.window('v', X, gz)
      if (gz !== tipRowE) dep.window('v', X + 11, gz)
      windows += (gz !== tipRowW) + (gz !== tipRowE)
    }
    for (let gx = X; gx <= X + 10; gx++) {
      if (gx === tipS) continue
      dep.window('h', gx, TIP.z1 + 1)
      windows++
    }
    for (const gx of [X + 1, X + 2, X + 3, X + 7, X + 8, X + 9]) put(DEP, gx, 33, FURN_SOFA, { facing: FACING.S })
    // Plants in the two south corners (no gate door lands there).
    put(DEP, X, TIP.z1, FURN_PLANT, { wall: 'S' })
    put(DEP, X + 10, TIP.z1, FURN_PLANT, { wall: 'S' })
    fids(DEP, X + 4, TIP.z0 + 1, { facing: FACING.N })
    dep.lamp(X + 2, 31, !dead, dead ? null : gateTint(p))
    dep.lamp(X + 8, 31, !dead && r(p, 13) % 2 === 0, dead ? null : gateTint(p))
    board({ gx: X - 1, gz: tipRowW, dx: -1, len: p === 0 ? 4 + (r(p, 14) % 6) : 4, pier: p })
    board({ gx: X + 11, gz: tipRowE, dx: 1, len: p === 0 ? 4 : 4 + (r(p, 15) % 6), pier: p })
    board({ gx: tipS, gz: TIP.z1 + 1, dz: 1, len: 4, pier: p })
  }
  dep.compile(map, DEP)

  // --- baggage hall --------------------------------------------------------------
  const bag = new FloorPlan({ x0: 14, z0: 0, x1: 40, z1: 26 })
  bag.rect({ x0: 15, z0: 2, x1: 40, z1: 12 }, CELL_OPEN)
  // Baggage services and lost luggage in the hall's north corners.
  bag.room({ x0: 15, z0: 2, x1: 17, z1: 4 }, { spaceId: spaceId++, role: SPACE_ROLE_OFFICE, doors: [{ axis: 'h', gx: 16, gz: 5 }], lamp: r(20) % 2 === 0 })
  bag.room({ x0: 37, z0: 2, x1: 40, z1: 4 }, { spaceId: spaceId++, role: SPACE_ROLE_STORAGE, doors: [{ axis: 'h', gx: 38, gz: 5 }], lamp: false })
  // Service corridors from the hall to each pier stair's door, and three
  // blind belt tunnels (the belts themselves are not built).
  bag.rect({ x0: 21, z0: 13, x1: 22, z1: 23 }, CELL_CORRIDOR)
  bag.rect({ x0: 33, z0: 13, x1: 34, z1: 23 }, CELL_CORRIDOR)
  for (const [x0, z1] of [[16, 24], [27, 25], [38, 24]]) {
    bag.rect({ x0, z0: 13, x1: x0 + 1, z1 }, CELL_CORRIDOR)
    bag.lamp(x0, z1 - 2, false)
  }
  const carousels = 2 + (r(16) % 2)
  for (let i = 0; i < carousels; i++) {
    const a = CAROUSEL_X[i] + (carousels === 2 ? 2 : 0)
    // A carousel: a solid 2 × 6 block of counters faced outward (a loop
    // with nothing inside to strand), with a free aisle all round.
    for (let gz = 4; gz <= 9; gz++) {
      put(BAG, a, gz, FURN_COUNTER, { facing: FACING.W })
      put(BAG, a + 1, gz, FURN_COUNTER, { facing: FACING.E })
    }
  }
  // Hall lights in pairs of columns; a failed pair is a dark band.
  for (let gx = 19; gx <= 39; gx += 4) {
    const lit = r(gx >> 3, 17) % 3 !== 0
    bag.lamp(gx, 6, lit)
    bag.lamp(gx, 11, lit)
  }
  bag.lamp(22, 17, true)
  bag.lamp(33, 17, r(21) % 2 === 0)
  bag.compile(map, BAG)

  // --- mezzanine ------------------------------------------------------------------
  const mez = new FloorPlan({ x0: 14, z0: 0, x1: 54, z1: 13 })
  // Gallery round the void (ring + one lane), club lounges behind its north
  // rail, shuttered food-court units south, and an east lounge that reaches
  // the stair door.
  mez.rect({ x0: VOID.x0 - 2, z0: VOID.z0 - 2, x1: VOID.x1 + 2, z1: VOID.z1 + 2 }, CELL_LOBBY)
  mez.rect({ x0: VOID.x1 + 3, z0: 5, x1: 51, z1: 10 }, CELL_LOBBY)
  for (let k = 0; k < 3; k++) {
    const x0 = VOID.x0 + k * 7
    const front = (gz) => [x0 + 2, x0 + 3].map((gx) => ({ axis: 'h', gx, gz, passage: PASSAGE_WIDE }))
    const lit = r(k, 18) % 3 !== 0
    mez.room({ x0, z0: 1, x1: x0 + 5, z1: 2 }, { spaceId: spaceId++, role: SPACE_ROLE_LOUNGE, doors: front(3) })
    mez.lamp(x0 + 2, 2, lit, lit ? LOUNGE_TINT : null)
    for (const gx of [x0 + 1, x0 + 4]) put(MEZ, gx, 1, FURN_SOFA, { wall: 'N' })
    mez.room({ x0, z0: 11, x1: x0 + 5, z1: 12 }, { spaceId: spaceId++, role: SPACE_ROLE_KITCHEN, doors: front(11) })
    for (let gx = x0 + 1; gx <= x0 + 4; gx++) put(MEZ, gx, 12, FURN_COUNTER, { wall: 'S' })
    mez.lamp(x0 + 3, 11, r(k, 19) % 4 === 0)
  }
  for (const gx of [43, 46, 49]) put(MEZ, gx, 10, FURN_SOFA, { wall: 'S' })
  for (let gx = VOID.x0; gx <= VOID.x1; gx += 4) mez.lamp(gx, gx % 8 === 0 ? 4 : 9, r(gx, 22) % 2 === 0)
  mez.lamp(46, 7, true, LOUNGE_TINT)
  mez.compile(map, MEZ)

  // --- stamps: the atrium, then the stairs ------------------------------------------
  const atrium = ctx.kit.atrium(map, { ...VOID, baseCy: DEP, levels: 2, kind: 'bridged', bridgeAxis: 'x', bridgeEvery: 1 })
  if (atrium?.error) return { error: `terminal atrium: ${atrium.error}` }
  for (const at of PIER_STAIR) {
    const sp = stairwellPlan({ ...at, baseCy: BAG, topCy: DEP })
    if (sp.error) return { error: `terminal pier stair: ${sp.error}` }
    ctx.kit.stairwell(map, sp, { enclosed: true })
  }
  const ms = stairwellPlan({ ...MEZ_STAIR, baseCy: DEP, topCy: MEZ })
  if (ms.error) return { error: `terminal mezzanine stair: ${ms.error}` }
  ctx.kit.stairwell(map, ms, { enclosed: true })

  // --- touch-ups: plates, the exit gate ------------------------------------------------
  labelFloor(map, BAG, 'Arr')
  labelFloor(map, DEP, 'dEP')
  labelFloor(map, MEZ, 'CLUb')
  const blocks = GATE_SCHEMES[scheme]
  for (let p = 0; p < 2; p++) {
    const plates = blocks[p]
    const cxs = [Math.floor(PIER_X[p] / 14), Math.floor((PIER_X[p] + 10) / 14)]
    for (let i = 0; i < 2; i++) {
      for (const cx of new Set(cxs)) labelFloor(map, DEP, plates[i], { cx, cz: 1 + i })
    }
  }
  // Boarding: the exit is one gate's closet, in the lit pier.
  const litGates = gates.filter((g) => g.pier !== deadPier)
  const g = litGates[r(19) % litGates.length]
  const exit = { gx: g.closet.gx, gz: g.closet.gz, cy: DEP }
  markExit(map, ctx, exit)

  // --- furniture last ----------------------------------------------------------------
  for (const [cy, piece] of pieces) addPiece(map, cy, piece)

  const pierName = ['A (west)', 'B (east)']
  const notes = [
    `departures: spine with two dead-end piers; pier ${pierName[deadPier]} is dead, pier ${pierName[1 - deadPier]}'s gates are lit (cool tint)`,
    `${gates.length} jet bridges end at a door into a closet; exit = the closet of a lit gate`,
    `gate plates ${scheme}: ${GATE_SCHEMES[scheme].map((b) => b.join('/')).join(' · ')}; floors Arr / dEP / CLUb`,
    `look at: the security serpentine (rails), ${windows} glass panes (holdroom walls, tips, jet-bridge tubes) onto the dark apron, seat rows facing the glass, the tip lounges`,
    `baggage hall below (${carousels} carousels) via each pier's service stair; mezzanine lounge over the spine atrium`,
    'stand-ins: apron = column mass behind windows; travelators and carousels = inert counters; FIDS = unlit-text stands; gate letters = level plates; aircraft doors = closets; no PA, schedule, belts or aircraft',
  ]
  return {
    spawn: { gx: 4, gz: 9, cy: DEP },
    exit,
    notes,
  }
}

// Security: four 8-deep lanes joined at alternating ends by gaps in the
// stanchion rails, a serpentine nobody queues in; two arches (doors) out.
function security(dep, r) {
  const flip = r(3) % 2
  dep.rect({ x0: 10, z0: 3, x1: 13, z1: 10 }, CELL_CORRIDOR)
  for (let k = 0; k < 4; k++) {
    const line = 10 + k
    const gap = (k + flip) % 2 === 0 ? 10 : 3
    for (let gz = 3; gz <= 10; gz++) if (gz !== gap) dep.rail('v', line, gz)
  }
  // The last lane is entered at one end; its arches stand at the other.
  const lastGap = (3 + flip) % 2 === 0 ? 10 : 3
  for (let gz = 3; gz <= 10; gz++) dep.edge('v', 14, gz, 1, PASSAGE_WALL)
  const arch = lastGap === 3 ? [9, 10] : [3, 4]
  for (const gz of arch) dep.edge('v', 14, gz, 0, PASSAGE_DOOR)
  dep.lamp(11, 6, true)
}

// A jet bridge: a 1-wide dead-end tube `len` cells out of the gate door,
// ending at a door into a one-cell closet (the aircraft door, or nothing).
// A glass tube glazes both flanks; a steel one keeps them plain.
function jetBridge(plan, { gx, gz, dx = 0, dz = 0, len, spaceId, pier, glass }) {
  let panes = 0
  for (let i = 0; i < len; i++) {
    const x = gx + dx * i
    const z = gz + dz * i
    plan.open(x, z, CELL_CORRIDOR)
    if (!glass) continue
    if (dx) {
      plan.window('h', x, z)
      plan.window('h', x, z + 1)
    } else {
      plan.window('v', x, z)
      plan.window('v', x + 1, z)
    }
    panes += 2
  }
  const cx = gx + dx * len
  const cz = gz + dz * len
  // The door sits on the line between the tube's last cell and the closet.
  const door = dx ? { axis: 'v', gx: dx > 0 ? cx : cx + 1, gz: cz } : { axis: 'h', gx: cx, gz: dz > 0 ? cz : cz + 1 }
  plan.room({ x0: cx, z0: cz, x1: cx, z1: cz }, { spaceId, role: SPACE_ROLE_STORAGE, doors: [door] })
  return { pier, closet: { gx: cx, gz: cz }, panes }
}
