import {
  CHUNK,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  CELL_ROOM,
  COLUMN_STANDARD,
  FACING,
  PASSAGE_DOOR,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  SPACE_ROLE_ARCHIVE,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_BEDROOM,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_LIBRARY,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_OFFICE,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
  STAIR_E,
  STAIR_W,
  WALL_PLAIN,
  WALL_RAIL,
  WALL_WINDOW,
  addPiece,
  labelFloor,
} from '../../tiles/floorPlan.js'
import {
  FURN_ARMCHAIR,
  FURN_BED,
  FURN_BOOKSHELF,
  FURN_CABINET,
  FURN_CHAIR,
  FURN_COOLER,
  FURN_COPIER,
  FURN_COUNTER,
  FURN_DESK,
  FURN_FRIDGE,
  FURN_NIGHTSTAND,
  FURN_PLANT,
  FURN_RACK,
  FURN_SINK,
  FURN_SOFA,
  FURN_STOVE,
  FURN_TABLE,
  FURN_TOILET,
  FURN_TV,
  FURN_WARDROBE,
  FURN_WASHER,
  FURN_WHITEBOARD,
} from '../../rooms/catalog.js'
import { PROP_BENCH, PROP_CART, PROP_DUMPSTER, PROP_WHEELIE_BIN } from '../../props/index.js'
import { stairwellPlan } from '../../structures/authored.js'
import { finiteCtx, markExit, markSpawn } from '../../tiles/kit.js'
import { openOwnedSeam } from '../../tiles/seams.js'
import { cellWalkable } from '../../tiles/holeMasks.js'
import {
  BASEMENT,
  BASEMENT_LABEL,
  DECK,
  DIR_VEC,
  KIOSK,
  NEXT_ISLAND,
  R,
  SPAN,
  UP,
  UP_CY,
  anchorDistrict,
  anomalyAt,
  blueprint,
  deckLabel,
  detail,
  frameOf,
  grow,
  inRect,
  kioskArea,
  kioskFrame,
  poleArms,
  roofBody,
  roofSpan,
  sideOf,
  spawnCells,
  underPorts,
  upperAllowed,
  upperChunks,
} from './geometry.js'

// 02 Night Lot (docs/liminal_maps/02-night-lot.md). THE tile program of the
// nightlot family (spec §3.3, §12.2), moved here from src/editor/kinds/
// nightlot.js, which wraps it with FINITE_CTX_NIGHTLOT (the kind lab's map,
// byte-identical).
//
// Finite mode (§13 step 1): the kind lab's prototype, one 4×4-chunk district
// on a single storey: an open CELL_OPEN plane lit by twin-pole islands, a
// store frontage and the gas-station refuge; poles are a COLUMN_STANDARD post
// with 2–4 ceiling panels round it (view it with ceilings hidden).
//
// Tile mode (§12.2): one district of the endless night lot, drawn from the
// pure blueprint (geometry.js) over three storeys — kind storeys 0 (the
// undercroft, world −1), 1 (the lot, world 0) and 2 (the upper storey, world
// 1, only over the garage and the frontage blocks):
//
//   roads      the district owns its west and north seam roads: lanes, a
//              kerbside walk with street poles on breaker runs, a dead
//              traffic light at the crossing; the far verges stay open, so
//              the lot opens on every seam (full-seam ports)
//   garage     a two-deck parking garage: open-sided ground deck behind guard
//              rails, a vehicle entrance with a pay booth, piers, parked
//              vehicles, tube lamps on dead runs; an enclosed stair tower and
//              an open ramp flight (stair cores, kit.stairwell) to the upper
//              deck
//   blocks     two-storey frontage (a motel, or offices over shops: units
//              below, a stair hall, rooms off a corridor above), strip malls
//              (shop units with storefront glass, back rooms, a service
//              alley or corridor with dumpsters and a loading dock), a
//              big-box store (mass behind a lit vestibule, a cart corral),
//              the gas-station refuge (canopy apron, pump islands, a lit shop)
//   upper      on cy 1: the garage's roof deck (poles, a lift lobby, the
//              ramp housing, parked vehicles), a motel's rooms on an open
//              walkway, offices off a corridor
//   outparcels freestanding diners, banks, laundromats out in the lot (glass
//              all round, a back room, a WC)
//   kiosk      a kiosk over a basement service floor (stair core), the exit's
//              plant room in the exit district
//   booths     bus shelters (glass, a bench), pay booths and small kiosks
//   lots       double-loaded bays (stall, aisle, stall) with cross aisles;
//              kerbed lamp islands of 2–4-head poles on breaker circuits
//              (40–60% dead, the next-island rule repairs), parked vehicles,
//              cart corrals, strays, perimeter fences with gaps
//   apron      lamp poles and planted beds on the open ground between them
//
// Every piece and post is placed only where it keeps its neighbourhood
// connected (Grid.safe), so no walkable cell is ever stranded.

// Lamp tints: sodium (the dominant head, the family record's lampTint) and
// the cold mercury retrofit.
export const SODIUM = 0xffb050
export const MERCURY = 0xd8f0ff
// The module lamps in the world (frontage, refuge, kiosk, booths, shops):
// neutral white, set explicitly (0xffffff is an exact identity in
// applyLampRecordTint). Doc 02 §7: the refuge canopy is the bright
// neutral-white welcome against the sodium islands.
export const MODULE_WHITE = 0xffffff
// The upper storey's plates: the garage's roof deck, a frontage's upper floor.
export const UPPER_LABELS = Object.freeze({ roof: 'P2', floor: '2' })
// The garage's fluorescent tubes (cold), the warm shop interiors, the red
// head of the dead traffic light.
export const TUBE = 0xe4efff
export const WARM = 0xffd9a0
export const SIGNAL_RED = 0xff3a20

// The finite kind (the editor's kind lab): one procedurally generated
// district of the family's own grammar — the seed's exit district, so the
// sample holds the kiosk and its basement exit — over all three storeys, its
// seams closed (no ports), the upper storey solid off its footprint.
export const KIND_DEFAULTS = Object.freeze({ sample: 'exit-district' })
export const FINITE_CTX_NIGHTLOT = finiteCtx(KIND_DEFAULTS)



// --- tile mode: the district grid ------------------------------------------------------

const NCELLS = SPAN * SPAN
const RING8 = Object.freeze([[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]])
const FACE = (side) => FACING[side] // 'S' | 'N' | 'E' | 'W' → FACING.*
const BLOCK_POST = 1
const BLOCK_PIECE = 2
const PROP_KIND_CAP = 14 // §11.1 item 9: distinct piece kinds per chunk

// One storey of a district as typed rasters (district-local cells 0..55),
// with the FloorPlan surface the kiosk drawing uses (rect/room/lamp/edge/
// window/rail/has) plus the placement rules of the world: `put` and `post`
// block a cell only where its walkable neighbourhood stays connected round
// it (`safe`), never on a kept cell (doors, cores, spawn, seams), so a piece
// can never strand a walkable cell. `compileGrid` writes it into the canvas
// with FloorPlan.compile's edge rule (an explicit edge where one is set, open
// between plan cells, a wall between a plan cell and mass).
class Grid {
  constructor(cy) {
    this.cy = cy
    this.plan = new Uint8Array(NCELLS)
    this.kind = new Uint8Array(NCELLS)
    this.space = new Int32Array(NCELLS)
    this.role = new Uint8Array(NCELLS)
    this.block = new Uint8Array(NCELLS)
    this.keepCell = new Uint8Array(NCELLS)
    this.ev = new Map() // V-line gx at row gz → { wall, passage, feature }
    this.eh = new Map() // H-line gz at column gx
    this.lamps = []
    this.pieces = []
  }

  ok(x, z) {
    return x >= 0 && z >= 0 && x < SPAN && z < SPAN
  }

  has(x, z) {
    return this.ok(x, z) && this.plan[z * SPAN + x] === 1
  }

  walk(x, z) {
    return this.has(x, z) && this.block[z * SPAN + x] === 0
  }

  open(x, z, kind = CELL_OPEN, space = 0, role = 0) {
    if (!this.ok(x, z)) return
    const i = z * SPAN + x
    this.plan[i] = 1
    this.kind[i] = kind
    this.space[i] = space
    this.role[i] = kind === CELL_ROOM ? role : 0
  }

  rect(r, kind = CELL_OPEN, space = 0, role = 0) {
    for (let z = Math.max(0, r.z0); z <= Math.min(SPAN - 1, r.z1); z++) {
      for (let x = Math.max(0, r.x0); x <= Math.min(SPAN - 1, r.x1); x++) this.open(x, z, kind, space, role)
    }
  }

  del(x, z) {
    if (!this.ok(x, z)) return
    const i = z * SPAN + x
    this.plan[i] = 0
    this.block[i] = 0
    this.space[i] = 0
    this.role[i] = 0
    this.kind[i] = CELL_OPEN
  }

  delRect(r) {
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) this.del(x, z)
  }

  keep(x, z) {
    if (this.ok(x, z)) this.keepCell[z * SPAN + x] = 1
  }

  keepRect(r) {
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) this.keep(x, z)
  }

  kept(x, z) {
    return this.ok(x, z) && this.keepCell[z * SPAN + x] === 1
  }

  edge(axis, gx, gz, wall, passage, feature = WALL_PLAIN) {
    const m = axis === 'v' ? this.ev : this.eh
    m.set(axis === 'v' ? gz * (SPAN + 1) + gx : gz * SPAN + gx, { wall, passage, feature })
  }

  explicit(axis, gx, gz) {
    return axis === 'v' ? this.ev.get(gz * (SPAN + 1) + gx) : this.eh.get(gz * SPAN + gx)
  }

  // Any explicit edge on one of cell (x, z)'s four sides.
  explicitAround(x, z) {
    return !!(this.explicit('v', x, z) || this.explicit('v', x + 1, z) || this.explicit('h', x, z) || this.explicit('h', x, z + 1))
  }

  // Drop every explicit edge on a side of a cell of rect r (back to the
  // compile rule: open between plan cells, a wall against mass).
  clearEdges(r) {
    for (let z = r.z0; z <= r.z1; z++) {
      for (let x = r.x0; x <= r.x1; x++) {
        this.ev.delete(z * (SPAN + 1) + x)
        this.ev.delete(z * (SPAN + 1) + x + 1)
        this.eh.delete(z * SPAN + x)
        this.eh.delete((z + 1) * SPAN + x)
      }
    }
  }

  window(axis, gx, gz) {
    this.edge(axis, gx, gz, 1, PASSAGE_WALL, WALL_WINDOW)
  }

  rail(axis, gx, gz) {
    this.edge(axis, gx, gz, 1, PASSAGE_WALL, WALL_RAIL)
  }

  // The edge between adjacent cells a and b.
  static between(ax, az, bx, bz) {
    return az === bz ? { axis: 'v', gx: Math.max(ax, bx), gz: az } : { axis: 'h', gx: ax, gz: Math.max(az, bz) }
  }

  setBetween(ax, az, bx, bz, wall, passage, feature = WALL_PLAIN) {
    const e = Grid.between(ax, az, bx, bz)
    this.edge(e.axis, e.gx, e.gz, wall, passage, feature)
  }

  // Walkable passage between adjacent plan cells a and b (walls respected).
  passable(ax, az, bx, bz) {
    if (!this.has(ax, az) || !this.has(bx, bz)) return false
    const e = Grid.between(ax, az, bx, bz)
    const x = this.explicit(e.axis, e.gx, e.gz)
    return x ? !x.wall : true
  }

  room(r, { spaceId, role = 0, doors = [], lamp = null }) {
    this.rect(r, CELL_ROOM, spaceId, role)
    for (let gz = r.z0; gz <= r.z1; gz++) {
      this.edge('v', r.x0, gz, 1, PASSAGE_WALL)
      this.edge('v', r.x1 + 1, gz, 1, PASSAGE_WALL)
    }
    for (let gx = r.x0; gx <= r.x1; gx++) {
      this.edge('h', gx, r.z0, 1, PASSAGE_WALL)
      this.edge('h', gx, r.z1 + 1, 1, PASSAGE_WALL)
    }
    for (const d of doors) this.edge(d.axis, d.gx, d.gz, 0, d.passage ?? PASSAGE_DOOR)
    if (lamp !== null) this.lamp(Math.floor((r.x0 + r.x1) / 2), Math.floor((r.z0 + r.z1) / 2), lamp)
  }

  lamp(gx, gz, lit = true, tint = null, info = null) {
    if (!this.has(gx, gz)) return null
    const prior = this.lamps.find((l) => l.gx === gx && l.gz === gz)
    if (prior) return prior
    const l = { gx, gz, lit, tint, prio: 1, ...(info ?? {}) }
    this.lamps.push(l)
    return l
  }

  // Blocking (x, z) keeps every walkable orthogonal neighbour that reached it
  // connected to the others through its 8-ring (walls respected): a local,
  // conservative simple-point test.
  safe(x, z) {
    return this.safeRect(x, z, x, z)
  }

  // Blocking the rect x0..x1 × z0..z1 keeps every walkable cell that reached
  // it (through an open edge) connected to the others through the ring of
  // cells round the rect (walls respected): a local, conservative test —
  // any walk through the rect can go round it instead.
  safeRect(x0, z0, x1, z1) {
    const ring = []
    for (let x = x0 - 1; x <= x1 + 1; x++) ring.push([x, z0 - 1])
    for (let z = z0; z <= z1 + 1; z++) ring.push([x1 + 1, z])
    for (let x = x1; x >= x0 - 1; x--) ring.push([x, z1 + 1])
    for (let z = z1; z >= z0; z--) ring.push([x0 - 1, z])
    const n = ring.length
    const inR = ring.map(([x, z]) => this.walk(x, z))
    const orth = []
    for (let k = 0; k < n; k++) {
      if (!inR[k]) continue
      const [x, z] = ring[k]
      const cx = Math.min(x1, Math.max(x0, x))
      const cz = Math.min(z1, Math.max(z0, z))
      if (Math.abs(cx - x) + Math.abs(cz - z) === 1 && this.passable(cx, cz, x, z)) orth.push(k)
    }
    if (orth.length <= 1) return true
    const link = (k) => {
      const j = (k + 1) % n
      return inR[k] && inR[j] && this.passable(ring[k][0], ring[k][1], ring[j][0], ring[j][1])
    }
    let start = -1
    for (let k = 0; k < n; k++) if (!link((k + n - 1) % n)) start = k
    if (start < 0) return true // the whole ring is linked
    const label = new Int16Array(n).fill(-1)
    let c = 0
    for (let m = 0; m < n; m++) {
      const k = (start + m) % n
      if (!inR[k]) continue
      if (m > 0 && !link((k + n - 1) % n)) c++
      label[k] = c
    }
    const first = label[orth[0]]
    return orth.every((k) => label[k] === first)
  }

  // A two-cell piece (the vehicle stand-in): both cells blocked together.
  putPair(a, b, kind, facing) {
    const [ax, az] = a
    const [bx, bz] = b
    if (!this.walk(ax, az) || !this.walk(bx, bz) || this.kept(ax, az) || this.kept(bx, bz)) return false
    if (!this.passable(ax, az, bx, bz)) return false
    if (!this.safeRect(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz))) return false
    for (const [x, z] of [a, b]) {
      this.block[z * SPAN + x] = BLOCK_PIECE
      this.pieces.push({ gx: x, gz: z, kind, front: facing, wall: null })
    }
    return true
  }

  canBlock(x, z) {
    return this.walk(x, z) && !this.kept(x, z) && this.safe(x, z)
  }

  // A piece (furniture or prop) centred in its cell or hugging wall `wall`.
  put(x, z, kind, { wall = null, facing = FACING.S } = {}) {
    if (!this.canBlock(x, z)) return false
    this.block[z * SPAN + x] = BLOCK_PIECE
    this.pieces.push({ gx: x, gz: z, kind, front: wall ? WALL_FRONT[wall] : facing, wall })
    return true
  }

  // FloorPlan's piece(): the kiosk drawing's spelling of put().
  piece(x, z, kind, opts) {
    return this.put(x, z, kind, opts)
  }

  unput(x, z) {
    const i = this.pieces.findIndex((p) => p.gx === x && p.gz === z)
    if (i >= 0) this.pieces.splice(i, 1)
    if (this.ok(x, z) && this.block[z * SPAN + x] === BLOCK_PIECE) this.block[z * SPAN + x] = 0
  }

  // A post (pole, pier, pump): COLUMN_STANDARD on a plan cell (keeps its
  // space id, so it is a pillar, never mass).
  post(x, z, { force = false } = {}) {
    if (!force && !this.canBlock(x, z)) return false
    if (!this.has(x, z)) return false
    this.block[z * SPAN + x] = BLOCK_POST
    return true
  }

  isPost(x, z) {
    return this.ok(x, z) && this.block[z * SPAN + x] === BLOCK_POST
  }
}

const WALL_FRONT = Object.freeze({ N: FACING.S, S: FACING.N, W: FACING.E, E: FACING.W })

// Write grid `g` into chunks `chunks` ([lcx, lcz] list) of storey g.cy:
// every cell (plan cells as drawn, the rest mass), every OWNED edge line,
// the lamps and the pieces. Distinct piece kinds per chunk stay ≤ 14.
function compileGrid(map, g, chunks) {
  const cy = g.cy
  const want = new Set(chunks.map(([a, b]) => a * 8 + b))
  const inWant = (x, z) => want.has(Math.floor(x / CHUNK) * 8 + Math.floor(z / CHUNK))
  const writeEdge = (axis, gx, gz, a, b) => {
    let wall = 0
    let passage = PASSAGE_OPEN
    let feature = WALL_PLAIN
    if (a || b) {
      const e = g.explicit(axis, gx, gz)
      // Between a plan cell and mass the edge is always a plain wall (an
      // explicit door, glass or rail there would open on, or look into,
      // mass: a clipped upper floor, a pruned room).
      if (!(a && b)) [wall, passage] = [1, PASSAGE_WALL]
      else if (e) ({ wall, passage, feature } = e)
    }
    if (axis === 'v') map.setWallV(gx, cy, gz, wall, passage, feature)
    else map.setWallH(gx, cy, gz, wall, passage, feature)
    if (wall && feature !== WALL_PLAIN) map.chunkAt(map.cellChunk(gx), cy, map.cellChunk(gz)).authoredFeatures = true
  }
  for (const [lcx, lcz] of chunks) {
    const x0 = lcx * CHUNK
    const z0 = lcz * CHUNK
    for (let z = z0; z < z0 + CHUNK; z++) {
      for (let x = x0; x < x0 + CHUNK; x++) {
        const i = z * SPAN + x
        if (g.plan[i]) map.setCell(x, cy, z, { kind: g.kind[i], spaceId: g.space[i], role: g.role[i], col: g.block[i] === BLOCK_POST ? COLUMN_STANDARD : 0 })
        else map.setCell(x, cy, z, { kind: CELL_OPEN, spaceId: 0, role: 0, col: COLUMN_STANDARD })
      }
    }
    for (let z = z0; z < z0 + CHUNK; z++) {
      for (let x = x0; x < x0 + CHUNK; x++) {
        writeEdge('v', x, z, g.has(x - 1, z), g.has(x, z))
        writeEdge('h', x, z, g.has(x, z - 1), g.has(x, z))
      }
    }
  }
  for (const l of g.lamps) if (inWant(l.gx, l.gz) && g.has(l.gx, l.gz)) map.setLamp(l.gx, cy, l.gz, l.lit, l.tint)
  const kinds = new Map()
  for (const p of g.pieces) {
    if (!inWant(p.gx, p.gz) || !g.has(p.gx, p.gz)) continue
    const key = Math.floor(p.gx / CHUNK) * 8 + Math.floor(p.gz / CHUNK)
    let set = kinds.get(key)
    if (!set) kinds.set(key, (set = new Set()))
    if (!set.has(p.kind) && set.size >= PROP_KIND_CAP) continue
    set.add(p.kind)
    addPiece(map, cy, p)
  }
}

const allChunks = () => {
  const out = []
  for (let lcz = 0; lcz < 4; lcz++) for (let lcx = 0; lcx < 4; lcx++) out.push([lcx, lcz])
  return out
}

// --- the district's dice ------------------------------------------------------------------

function diceOf(seed, tx, tz) {
  const d = (a, b = 0) => detail(seed, tx, tz, a, b)
  return {
    d,
    pick: (n, a, b = 0) => (n <= 1 ? 0 : d(a, b) % n),
    chance: (p, a, b = 0) => (d(a, b) % 10000) / 10000 < p,
  }
}

// A canonical-frame helper over a frameOf(): place, edge, wall names.
function canon(F) {
  const at = (u, v) => F.cell(u, v)
  const edgeUV = (u, v, du, dv) => {
    const [ax, az] = F.cell(u, v)
    const [bx, bz] = F.cell(u + du, v + dv)
    return Grid.between(ax, az, bx, bz)
  }
  // Walls by canonical name: 'back' (−v), 'front' (+v), 'left' (−u), 'right' (+u).
  const wallOf = { back: F.side(0, -1), front: F.side(0, 1), left: F.side(-1, 0), right: F.side(1, 0) }
  return { F, at, edgeUV, wallOf }
}

// --- the roads --------------------------------------------------------------------------

function drawRoads(G, bp, S, dice, poles) {
  const { wW, wN, vE, vS } = bp.roads
  const ids = { apron: S(), roadN: S(), roadW: S(), walkN: S(), walkW: S(), vergeE: S(), vergeS: S() }
  G.rect(R(0, 0, SPAN - 1, SPAN - 1), CELL_OPEN, ids.apron)
  G.rect(R(0, 0, SPAN - 1, wN - 1), CELL_OPEN, ids.roadN)
  G.rect(R(0, wN, wW - 1, SPAN - 1), CELL_OPEN, ids.roadW)
  G.rect(R(wW, wN, SPAN - 1, wN), CELL_OPEN, ids.walkN)
  G.rect(R(wW, wN + 1, wW, SPAN - 1), CELL_OPEN, ids.walkW)
  G.rect(R(SPAN - vE, wN + 1, SPAN - 1, SPAN - 1), CELL_OPEN, ids.vergeE)
  G.rect(R(wW + 1, SPAN - vS, SPAN - 1 - vE, SPAN - 1), CELL_OPEN, ids.vergeS)
  // The seam cells stay clear (full-seam ports: walkable on both sides).
  for (let a = 0; a < SPAN; a++) {
    G.keep(0, a)
    G.keep(a, 0)
    G.keep(SPAN - 1, a)
    G.keep(a, SPAN - 1)
  }
  // Street poles on the walks, one head over the near lane: breaker runs of
  // two to three, then one or two dead.
  const run = (side, k) => {
    const n = dice.d(0x50 + side, k >> 2) % 5
    return [true, true, false, true, false][(k + n) % 5]
  }
  // The pitch (6–10 cells) and the phase are hashed per side; one head in
  // three is a twin where a near verge lies behind the walk (its second head
  // over the verge, never over the parcel's buildings).
  const street = (side, at, back) => {
    const pitch = 6 + dice.pick(5, 0x53, side)
    let k = 0
    for (let a = (side ? wN : wW) + 3 + dice.pick(4, 0x52, side); a <= SPAN - 4; a += pitch) {
      const [px, pz] = at(a)
      if (G.post(px, pz)) {
        const lit = run(side, k)
        const lamps = [G.lamp(...back(a, -1), lit, SODIUM)]
        if ((side ? bp.roads.iW : bp.roads.iN) >= 1 && dice.pick(3, 0x54 + side, k) === 0) lamps.push(G.lamp(...back(a, 1), lit, SODIUM))
        poles.push({ kind: 'street', circuit: `street-${side ? 'w' : 'n'}`, post: [px, pz], lamps: lamps.filter(Boolean), lit })
      }
      k++
    }
  }
  street(0, (x) => [x, wN], (x, d) => [x, wN + d])
  street(1, (z) => [wW, z], (z, d) => [wW + d, z])
  // The dead traffic light at the crossing: a red head that still burns.
  if (G.post(wW, wN)) G.lamp(wW - 1, wN - 1, true, SIGNAL_RED, { prio: 3 })
  return ids
}

// The verges: the far ones (east and south, inside the seam's one-cell walk)
// and the near ones (between the west/north walks and the parcel). Each side
// takes a hashed treatment — a clipped hedge, a chain-link rail, planted beds
// with bins, a bollard row, or bare grass — with gaps on a hashed pitch, so
// no two seams read alike. Drawn last on the lot, only where blocking keeps
// every neighbourhood connected.
const VERGE_STYLES = Object.freeze(['hedge', 'hedge', 'hedge', 'rail', 'rail', 'beds', 'beds', 'bollards', 'hedge', 'grass'])
function drawVerges(G, bp, dice) {
  const { wN, wW, vE, vS, iW = 0, iN = 0 } = bp.roads
  const P = bp.parcel
  // side: [band cells (u along, w across), the parcel-side neighbour offset]
  const sides = [
    { k: 0, w: vE - 1, cell: (u, w) => [SPAN - 2 - w, u], u0: wN + 2, u1: SPAN - 2, inward: [-1, 0], edgeW: vE - 2 },
    { k: 1, w: vS - 1, cell: (u, w) => [u, SPAN - 2 - w], u0: wW + 2, u1: SPAN - 1 - vE, inward: [0, -1], edgeW: vS - 2 },
    { k: 2, w: iW, cell: (u, w) => [wW + 1 + w, u], u0: P.z0, u1: P.z1, inward: [1, 0], edgeW: iW - 1 },
    { k: 3, w: iN, cell: (u, w) => [u, wN + 1 + w], u0: P.x0, u1: P.x1, inward: [0, 1], edgeW: iN - 1 },
  ]
  for (const sd of sides) {
    if (sd.w < 1) continue
    const style = VERGE_STYLES[dice.pick(VERGE_STYLES.length, 0x5a, sd.k)]
    const pitch = 5 + dice.pick(5, 0x58, sd.k)
    const gap = 2 + (dice.pick(3, 0x59, sd.k) === 0 ? 1 : 0)
    const phase = dice.pick(pitch, 0x5b, sd.k)
    const inGap = (u) => (u - sd.u0 + phase) % pitch < gap
    for (let u = sd.u0; u <= sd.u1; u++) {
      // Behind a rail, a bed row or a bollard line, the verge's back rows are
      // a planted bank (mass) with the same gaps; bare grass stays open.
      if (style !== 'hedge' && style !== 'grass' && !inGap(u)) {
        for (let w = 0; w < sd.w; w++) {
          if (w === sd.edgeW) continue
          const [x, z] = sd.cell(u, w)
          if (G.canBlock(x, z) && !G.explicitAround(x, z)) G.del(x, z)
        }
      }
      if (style === 'hedge') {
        if (inGap(u)) continue
        for (let w = 0; w < sd.w; w++) {
          const [x, z] = sd.cell(u, w)
          if (G.canBlock(x, z) && !G.explicitAround(x, z)) G.del(x, z)
        }
      } else if (style === 'rail') {
        if (inGap(u)) continue
        const [x, z] = sd.cell(u, sd.edgeW)
        const [ox, oz] = [x + sd.inward[0], z + sd.inward[1]]
        if (!G.walk(x, z) || !G.walk(ox, oz) || G.kept(x, z) || G.kept(ox, oz)) continue
        const e = Grid.between(x, z, ox, oz)
        if (G.explicit(e.axis, e.gx, e.gz)) continue
        G.rail(e.axis, e.gx, e.gz)
      } else if (style === 'beds') {
        // A bed two or three cells long, one cell deep, every pitch; a bin or
        // a planter at the head of one bed in two.
        const m = (u - sd.u0 + phase) % pitch
        if (m >= gap + 3 || m < gap) continue
        const [x, z] = sd.cell(u, sd.edgeW)
        if (m === gap && dice.chance(0.5, 0x5c, sd.k * 4096 + u)) {
          G.put(x, z, dice.chance(0.5, 0x5d, u) ? PROP_WHEELIE_BIN : FURN_PLANT)
          continue
        }
        if (G.canBlock(x, z) && !G.explicitAround(x, z)) G.del(x, z)
      } else if (style === 'bollards') {
        if ((u - sd.u0 + phase) % 3 !== 0) continue
        const [x, z] = sd.cell(u, sd.edgeW)
        G.post(x, z)
      } else if ((u - sd.u0 + phase) % (pitch * 3) === 0) {
        // Bare grass: a bench or a bin now and then.
        const [x, z] = sd.cell(u, 0)
        G.put(x, z, dice.chance(0.5, 0x5e, u) ? PROP_BENCH : PROP_WHEELIE_BIN, { facing: FACING.S })
      }
    }
  }
}

// --- parking lots ------------------------------------------------------------------------

// A lot: lanes on its long edges, double-loaded bays (stall 2, aisle 2,
// stall 2) across it, cross aisles at both ends and every 12–16 cells,
// kerbed lamp islands between bays (every bay or every other), parked
// vehicles (stand-in: two dumpsters nose to tail per 1×2 stall until the S6
// car model lands; rare, doc §6), stray carts, a cart corral, chain-link
// fences or hedges with gaps where the lot meets a road walk, and in some
// lots an enclosed stair head down to the under-lot deck.
function drawLot(G, lot, S, dice, poles, { full = false, walkIds }) {
  const F = frameOf(lot.rect, lot.axis === 'x' ? 'S' : 'E')
  const C = canon(F)
  const l = F.L
  const d = F.D
  const id = S()
  const n = 0x100 + lot.n * 0x40
  G.rect(lot.rect, CELL_OPEN, id)
  // The stair head's halo stays clear of stalls, posts and kerbs.
  const head = lot.core ? grow(lot.core.rect, 1) : null
  if (head) G.keepRect(head)
  // Across: lane, modules, islands.
  const end = d >= 8 ? d - 2 : d - 1
  const islandEvery = dice.pick(4, n + 1) === 0 ? 2 : 1
  const stallRows = []
  const aisles = []
  const islands = []
  let v = 1
  let mods = 0
  while (v + 5 <= end) {
    stallRows.push(v)
    aisles.push(v + 2)
    stallRows.push(v + 4)
    v += 6
    mods++
    if (v + 6 <= end && mods % islandEvery === 0) {
      islands.push(v)
      v++
    }
  }
  // A shallow lot (or the rows left over) takes one single-loaded bay; a lot
  // with no island between its bays keeps one on its far edge.
  if (v + 3 <= end) {
    stallRows.push(v)
    aisles.push(v + 2)
    v += 4
  }
  if (!islands.length && v <= end) islands.push(v)
  // Along: cross aisles.
  const cross = new Set([0, 1, l - 2, l - 1])
  const M = 12 + dice.pick(5, n + 2)
  if (l > 18) {
    for (let u = 2 + M; u + 2 <= l - 4; u += M + 2) {
      cross.add(u)
      cross.add(u + 1)
    }
  }
  const stallU = []
  for (let u = 2; u <= l - 3; u++) if (!cross.has(u)) stallU.push(u)
  // Islands: posts first, then corral/planters, then kerb rails with gaps.
  // Each island segment is one breaker's circuit.
  const circuitBase = `lot${lot.n}`
  const hedgeRows = new Set(islands.map((_, row) => row).filter((row) => dice.chance(0.6, n + 18, row)))
  islands.forEach((vi, row) => {
    const segs = []
    let s0 = null
    for (let u = 2; u <= l - 2; u++) {
      const inSeg = u <= l - 3 && !cross.has(u)
      if (inSeg && s0 === null) s0 = u
      if (!inSeg && s0 !== null) {
        segs.push([s0, u - 1])
        s0 = null
      }
    }
    const step = 5 + dice.pick(3, n + 3, row)
    segs.forEach(([a, b], si) => {
      const circuit = `${circuitBase}:${row}:${si}`
      for (let u = a + 1; u <= b - 1; u += step) {
        const [px, pz] = C.at(u, vi)
        if (!G.post(px, pz)) continue
        const q = dice.d(n + 4, row * 64 + u)
        const arms = poleArms([2, 2, 3, 4][q % 4], [1, 3][(q >>> 3) & 1])
        const lamps = []
        for (const [au, av] of arms) {
          const [lx, lz] = C.at(u + au, vi + av)
          const lp = G.lamp(lx, lz, false, SODIUM)
          if (lp) lamps.push(lp)
        }
        poles.push({ kind: 'island', circuit, post: [px, pz], lamps, lit: false })
      }
      // A cart corral (three carts in a railed bay) on one segment in four.
      if (si === 0 && dice.pick(3, n + 5, row) === 0 && b - a >= 6) {
        const cu = b - 3
        let ok = true
        for (let u = cu; u <= cu + 2 && ok; u++) ok = G.walk(...C.at(u, vi)) && !G.isPost(...C.at(u, vi)) && !G.kept(...C.at(u, vi))
        if (ok) {
          for (let u = cu; u <= cu + 2; u++) G.put(...C.at(u, vi), PROP_CART, { facing: FACE(C.wallOf.right) })
          const e0 = C.edgeUV(cu, vi, -1, 0)
          G.rail(e0.axis, e0.gx, e0.gz)
        }
      }
      // Planters and the odd bin or bench on the island.
      for (let u = a; u <= b; u++) {
        const r = dice.d(n + 6, row * 64 + u) % 10
        const [x, z] = C.at(u, vi)
        if (r < 2) G.put(x, z, FURN_PLANT)
        else if (r === 2) G.put(x, z, PROP_WHEELIE_BIN, { facing: FACE(C.wallOf.front) })
        else if (r === 3 && u > a && u < b) G.put(x, z, PROP_BENCH, { facing: FACE(C.wallOf.front) })
      }
      // Kerb rails on both long sides; a walkable run cut off from the
      // segment's ends gets a gap at its first cell.
      for (let u = a; u <= b; u++) {
        for (const dv of [-1, 1]) {
          const e = C.edgeUV(u, vi, 0, dv)
          G.rail(e.axis, e.gx, e.gz)
        }
      }
      // A hedge median (one island row in two): the island's cells between
      // the pole kerbs become a planted bed (mass), its kerbs plain walls.
      if (hedgeRows.has(row)) {
        const poleU = []
        for (let u = a; u <= b; u++) if (G.isPost(...C.at(u, vi))) poleU.push(u)
        for (let u = a; u <= b; u++) {
          const [x, z] = C.at(u, vi)
          if (poleU.some((pu) => Math.abs(pu - u) <= 1) || !G.canBlock(x, z)) continue
          G.del(x, z)
          G.clearEdges(R(x, z, x, z))
        }
      }
      let run = null
      for (let u = a; u <= b + 1; u++) {
        const w = u <= b && G.walk(...C.at(u, vi))
        if (w && run === null) run = u
        if (!w && run !== null) {
          const touchesEnd = run === a || u - 1 === b
          if (!touchesEnd) {
            const e = C.edgeUV(run, vi, 0, -1)
            G.edge(e.axis, e.gx, e.gz, 0, PASSAGE_OPEN)
          }
          run = null
        }
      }
    })
  })
  // A lot without islands gets end-cap poles at the ends of its aisles.
  if (!islands.length) {
    aisles.forEach((va, k) => {
      for (const u of [2, l - 3]) {
        const [px, pz] = C.at(u, va)
        if (!G.post(px, pz)) continue
        const lamps = [[0, -1], [0, 2]].map(([du, dv]) => G.lamp(...C.at(u + du, va + dv), false, SODIUM)).filter(Boolean)
        poles.push({ kind: 'island', circuit: `${circuitBase}:cap${k}`, post: [px, pz], lamps, lit: false })
      }
    })
  }
  // Parked vehicles: the stand-in is two dumpsters nose to tail, its long
  // side along the stall; rare (doc §6: "parked car, rare"). A full lot
  // (anomaly) fills every stall but one with the same object, all facing
  // one way: a shopping cart at the head of each stall (not the dumpster
  // stand-in, which would read as a dumpster yard until a car model lands).
  const occupancy = full ? 1 : 0.02 + (dice.pick(9, n + 7) / 100)
  const vehicleFacing = FACE(C.wallOf.right)
  let emptyStall = null
  if (full) {
    const k = dice.d(n + 8)
    emptyStall = [stallRows[k % stallRows.length], stallU[(k >>> 8) % stallU.length]]
  }
  let cars = 0
  stallRows.forEach((vs, si) => {
    for (const u of stallU) {
      if (emptyStall && emptyStall[0] === vs && emptyStall[1] === u) continue
      if (!full && (dice.d(n + 9, si * 128 + u) % 1000) / 1000 >= occupancy) continue
      if (full ? G.put(...C.at(u, vs), PROP_CART, { facing: vehicleFacing }) : G.putPair(C.at(u, vs), C.at(u, vs + 1), PROP_DUMPSTER, vehicleFacing)) cars++
    }
  })
  if (emptyStall) {
    const [x, z] = C.at(emptyStall[1], emptyStall[0])
    G.lamp(x, z, true, SODIUM, { prio: 4, anomaly: true })
  }
  // Wheel stops along a few stall rows (low bins stand in: a rhythm of small
  // dark shapes at the head of the stalls), and stray carts in the aisles.
  const strays = 1 + dice.pick(3, n + 10)
  for (let i = 0, placed = 0; i < 16 && placed < strays && aisles.length; i++) {
    const va = aisles[dice.d(n + 11, i) % aisles.length] + (dice.d(n + 12, i) & 1)
    const u = stallU.length ? stallU[dice.d(n + 13, i) % stallU.length] : 2
    if (G.put(...C.at(u, va), PROP_CART, { facing: [FACING.S, FACING.E, FACING.N, FACING.W][dice.d(n + 14, i) & 3] })) placed++
  }
  // Where the lot meets a seam road's walk: a chain-link fence (rails) or a
  // hedge (a one-cell mass row), with a two-cell gap every 6–12 cells.
  const sides = [['back', 0, -1, (u) => [u, 0]], ['front', 0, 1, (u) => [u, d - 1]]]
  for (const [, du, dv, cellOf] of sides) {
    const gapEvery = 6 + dice.pick(7, n + 15, dv)
    const hedge = dice.chance(0.65, n + 16, dv)
    for (let u = 0; u < l; u++) {
      const [cu, cv] = cellOf(u)
      const [x, z] = C.at(cu, cv)
      const [ox, oz] = C.at(cu + du, cv + dv)
      if (!G.has(ox, oz) || (!hedge && !walkIds.has(G.space[oz * SPAN + ox]))) continue
      if (u % gapEvery < 2) continue
      if (hedge) {
        if (u > 0 && u < l - 1 && G.canBlock(x, z) && !G.explicitAround(x, z)) G.del(x, z)
      } else {
        G.setBetween(x, z, ox, oz, 1, PASSAGE_WALL, WALL_RAIL)
      }
    }
  }
  // The stair head: its halo clear of kerbs, fences and stalls; a lamp over
  // its door.
  if (head) {
    G.clearEdges(head)
    const [ox, oz] = lot.core.door.outside
    G.lamp(ox, oz, dice.chance(0.6, n + 17), MODULE_WHITE, { prio: 2 })
  }
  return { id, cars }
}

// Apron poles: the open ground between the lots and the buildings (the
// blueprint's FREE cells) gets lamp poles on a coarse lattice, two heads
// each, on breaker rows like the islands' (the next-island rule and the
// district's lit floor treat them alike); a bin or a planter at the odd foot.
function drawApron(G, bp, dice, poles) {
  // The open apron (placement cells no lot, building or lane took): a
  // scatter of pole islands at least `gap` cells apart (Chebyshev), taken in
  // hashed order, so the remnant strips between buildings get theirs too.
  const gap = 7 + dice.pick(4, 0x150)
  const free = (x, z) => x >= 0 && z >= 0 && x < SPAN && z < SPAN && bp.free[z * SPAN + x] === 0
  const cands = []
  for (let z = bp.parcel.z0 + 1; z <= bp.parcel.z1 - 1; z++) {
    for (let x = bp.parcel.x0 + 1; x <= bp.parcel.x1 - 1; x++) {
      let ok = true
      for (let dz = -1; dz <= 1 && ok; dz++) for (let dx = -1; dx <= 1 && ok; dx++) ok = free(x + dx, z + dz)
      if (ok) cands.push([dice.d(0x151, z * SPAN + x), x, z])
    }
  }
  cands.sort((a, b) => a[0] - b[0])
  const taken = []
  for (const [, x, z] of cands) {
    if (taken.some(([px, pz]) => Math.max(Math.abs(px - x), Math.abs(pz - z)) < gap)) continue
    let ok = true
    for (let dz = -1; dz <= 1 && ok; dz++) for (let dx = -1; dx <= 1 && ok; dx++) ok = G.walk(x + dx, z + dz) && !G.kept(x + dx, z + dz)
    if (!ok || !G.post(x, z)) continue
    taken.push([x, z])
    const row = Math.floor(z / (gap + 3))
    const q = dice.d(0x153, x * 64 + z)
    const lamps = poleArms(2, q & 3).map(([dx, dz]) => G.lamp(x + dx, z + dz, false, SODIUM)).filter(Boolean)
    poles.push({ kind: 'island', circuit: `apron:${row}`, post: [x, z], lamps, lit: false })
    // At the pole's foot (two in three): a bin, a planter, a bench or a
    // stray cart; one pole in four keeps a second piece across from it.
    if ((q >>> 4) % 3 !== 0) {
      const foot = [PROP_WHEELIE_BIN, FURN_PLANT, PROP_BENCH, PROP_CART]
      const [bx, bz] = (q >>> 8) & 1 ? [x + 1, z + 1] : [x - 1, z - 1]
      G.put(bx, bz, foot[(q >>> 9) & 3], { facing: FACING.S })
      if (((q >>> 16) & 3) === 0) G.put(2 * x - bx, 2 * z - bz, foot[((q >>> 9) + 1) & 3], { facing: FACING.N })
    }
    // A planted bed (raised kerb, shrubs: mass) beside one pole in two.
    if ((q >>> 12) & 1) {
      const horiz = ((q >>> 13) & 1) === 1
      const ox = x + (horiz ? -1 : 3)
      const oz = z + (horiz ? 3 : -1)
      const bed = horiz ? R(ox, oz, ox + 2, oz + 1) : R(ox, oz, ox + 1, oz + 2)
      let room = true
      for (let bz = bed.z0 - 1; bz <= bed.z1 + 1 && room; bz++) for (let bx = bed.x0 - 1; bx <= bed.x1 + 1 && room; bx++) room = free(bx, bz) && G.walk(bx, bz) && !G.kept(bx, bz)
      if (room) for (let bz = bed.z0; bz <= bed.z1; bz++) for (let bx = bed.x0; bx <= bed.x1; bx++) if (G.canBlock(bx, bz) && !G.explicitAround(bx, bz)) G.del(bx, bz)
    }
  }
}

// --- the garage ---------------------------------------------------------------------------

// The garage's ground deck over its rect (its B1 deck lies below, drawn with
// the undercroft): open-sided behind guard rails (or walled), a three-cell
// vehicle entrance, pedestrian gaps, a pay booth, piers on a seeded grid,
// vehicles along the walls, tube lamps on runs. The cores (blueprint) are
// kept clear and stamped after the compile.
function drawGarage(G0, g, S, dice, { full = false } = {}) {
  const r = g.rect
  const id = S()
  G0.rect(r, CELL_LOBBY, id)
  for (const c of g.cores) G0.keepRect(grow(c.rect, 1))
  // Perimeter of the ground deck.
  const ent = g.entrance
  const sides = garageSides(r)
  Object.entries(sides).forEach(([side, s], k) => {
    const railed = dice.chance(0.6, 0x200, k)
    const span = s.range[1] - s.range[0] + 1
    const gapAt = s.range[0] + 2 + dice.pick(Math.max(1, span - 4), 0x201, k)
    for (let a = s.range[0]; a <= s.range[1]; a++) {
      const [[ix, iz], [ox, oz]] = s.cells(a)
      if (side === ent.side && a >= ent.a0 && a <= ent.a1) {
        G0.setBetween(ix, iz, ox, oz, 0, PASSAGE_WIDE)
        G0.keep(ix, iz)
        G0.keep(ox, oz)
        continue
      }
      if (a === gapAt) {
        G0.setBetween(ix, iz, ox, oz, 0, railed ? PASSAGE_OPEN : PASSAGE_DOOR)
        G0.keep(ix, iz)
        G0.keep(ox, oz)
        continue
      }
      // Rails between concrete posts every fourth cell.
      const feature = railed && (a - s.range[0]) % 4 !== 0 ? WALL_RAIL : WALL_PLAIN
      G0.setBetween(ix, iz, ox, oz, 1, PASSAGE_WALL, feature)
    }
  })
  // The entrance lane stays clear four cells in.
  for (let a = ent.a0; a <= ent.a1; a++) {
    for (let k = 0; k < 5; k++) {
      const x = ent.side === 'N' || ent.side === 'S' ? a : (ent.side === 'W' ? r.x0 + k : r.x1 - k)
      const z = ent.side === 'N' || ent.side === 'S' ? (ent.side === 'N' ? r.z0 + k : r.z1 - k) : a
      G0.keep(x, z)
    }
  }
  // The pay booth: a 2×2 room, door to the deck, glass to the lane.
  if (g.booth) {
    const b = g.booth
    const bid = S()
    const cx = (r.x0 + r.x1) / 2
    const cz = (r.z0 + r.z1) / 2
    const doorSide = ent.side === 'N' || ent.side === 'S' ? (b.x0 < cx ? 'E' : 'W') : (b.z0 < cz ? 'S' : 'N')
    const door = boothEdge(b, doorSide, 0)
    G0.room(b, { spaceId: bid, role: SPACE_ROLE_OFFICE, doors: [{ ...door, passage: PASSAGE_DOOR }] })
    const glass = boothEdge(b, ent.side, 0)
    G0.window(glass.axis, glass.gx, glass.gz)
    keepDoor(G0, door)
    const inside = innerCellsOf(b).filter(([x, z]) => !G0.kept(x, z))
    if (inside[0]) G0.put(...inside[0], FURN_DESK, { facing: FACE(ent.side) })
    if (inside[1]) G0.put(...inside[1], FURN_CHAIR, { facing: FACE(ent.side) })
    const lit = dice.chance(0.4, 0x202)
    G0.lamp(b.x0, b.z0, lit, lit ? WARM : TUBE, { prio: 2 })
  }
  // Rooms along the deck's walls: storage cages, plant and meter rooms.
  const rooms = garageRooms(G0, g, id, S, dice)
  // The ramp spine: a one-cell wall down the deck's long axis, broken every
  // 7–10 cells for the cross aisles.
  const alongX = r.x1 - r.x0 >= r.z1 - r.z0
  const mid = alongX ? Math.floor((r.z0 + r.z1) / 2) + dice.pick(3, 0x209) - 1 : Math.floor((r.x0 + r.x1) / 2) + dice.pick(3, 0x209) - 1
  const gapEvery = 7 + dice.pick(4, 0x20a)
  const [a0, a1] = alongX ? [r.x0 + 4, r.x1 - 4] : [r.z0 + 4, r.z1 - 4]
  for (let a = a0; a <= a1; a++) {
    if ((a - a0) % gapEvery >= gapEvery - 2) continue
    const [x, z] = alongX ? [a, mid] : [mid, a]
    if (G0.space[z * SPAN + x] !== id || G0.kind[z * SPAN + x] !== CELL_LOBBY || !G0.canBlock(x, z)) continue
    G0.del(x, z)
  }
  // Piers on the seeded grid (the B1 deck repeats it below); beside three
  // piers in five, what a deck collects: a hose cabinet, a bin, an abandoned cart,
  // a sand bucket's bench.
  const pierKit = [FURN_CABINET, PROP_WHEELIE_BIN, PROP_CART, FURN_CABINET, PROP_BENCH]
  pierCells(g).forEach(([x, z], k) => {
    if (!G0.canBlock(x, z) || !G0.post(x, z)) return
    if (dice.pick(5, 0x20b, k) >= 3) return
    const [dx, dz] = N4[dice.pick(4, 0x20c, k)]
    if (G0.space[(z + dz) * SPAN + x + dx] === id) G0.put(x + dx, z + dz, pierKit[dice.pick(pierKit.length, 0x20d, k)], { facing: FACE(dx ? (dx > 0 ? 'E' : 'W') : (dz > 0 ? 'S' : 'N')) })
  })
  // Vehicles nose-in along the walls (rare; every bay in a full-lot garage).
  const cars = parkAlongWalls(G0, sides, full ? 1 : 0.04 + dice.pick(8, 0x203) / 100, dice, 0x204, null, full ? PROP_CART : PROP_DUMPSTER)
  // Tube lamps every four cells; whole rows on one run.
  tubes(G0, r, 0.6, dice, 0x207)
  return { id, cars, rooms: rooms + (g.booth ? 1 : 0) }
}

// Rooms against the ground deck's walls, one per garage chunk or so: 3–4
// cells along the wall, 2 deep, the door on the deck side; a storage cage
// (chain-link on the deck side) or a plant / meter room (walls). Never on a
// kept cell (the entrance lane, the pedestrian gaps, the cores' halos, the
// booth's door), never touching another room.
function garageRooms(G, g, id, S, dice) {
  const r = g.rect
  const want = g.chunks.w * g.chunks.h + dice.pick(2, 0x210)
  const SIDES = ['N', 'S', 'E', 'W']
  let placed = 0
  for (let t = 0; t < 24 && placed < want; t++) {
    const side = SIDES[dice.pick(4, 0x211, t)]
    const w = 3 + dice.pick(2, 0x212, t)
    const alongX = side === 'N' || side === 'S'
    const [lo, hi] = alongX ? [r.x0 + 1, r.x1 - w] : [r.z0 + 1, r.z1 - w]
    if (hi < lo) continue
    const a = lo + dice.pick(hi - lo + 1, 0x213, t)
    const rr = side === 'N' ? R(a, r.z0, a + w - 1, r.z0 + 1)
      : side === 'S' ? R(a, r.z1 - 1, a + w - 1, r.z1)
        : side === 'W' ? R(r.x0, a, r.x0 + 1, a + w - 1)
          : R(r.x1 - 1, a, r.x1, a + w - 1)
    let ok = true
    for (let z = rr.z0 - 1; z <= rr.z1 + 1 && ok; z++) {
      for (let x = rr.x0 - 1; x <= rr.x1 + 1 && ok; x++) {
        const i = z * SPAN + x
        if (inRect(rr, x, z)) ok = G.has(x, z) && G.space[i] === id && G.block[i] === 0 && !G.kept(x, z)
        else if (G.has(x, z) && G.kind[i] === CELL_ROOM) ok = false
      }
    }
    if (!ok) continue
    // The door: the middle cell of the deck-side face.
    const [dx, dz] = DIR_VEC[side]
    const mid = Math.floor(w / 2)
    const inner = alongX ? [a + mid, side === 'N' ? rr.z1 : rr.z0] : [side === 'W' ? rr.x1 : rr.x0, a + mid]
    const outer = [inner[0] - dx, inner[1] - dz]
    if (!G.walk(...outer) || G.isPost(...outer)) continue
    const door = { ...Grid.between(inner[0], inner[1], outer[0], outer[1]), passage: PASSAGE_DOOR }
    const cage = dice.chance(0.5, 0x214, t)
    const kind = cage ? 'storage' : ['plant', 'storage', 'archive'][dice.pick(3, 0x215, t)]
    const rid = S()
    G.room(rr, { spaceId: rid, role: SHOP_TYPES[kind].role, doors: [door] })
    keepDoor(G, door)
    if (cage) {
      for (let k = 0; k < w; k++) {
        const c = alongX ? [a + k, inner[1]] : [inner[0], a + k]
        if (c[0] === inner[0] && c[1] === inner[1]) continue
        const e = Grid.between(c[0], c[1], c[0] - dx, c[1] - dz)
        G.rail(e.axis, e.gx, e.gz)
      }
    }
    const C = canon(frameOf(rr, BACK_SIDE[side]))
    let ud = 0
    for (let u = 0; u < C.F.L; u++) {
      const [x, z] = C.at(u, C.F.D - 1)
      if (x === inner[0] && z === inner[1]) ud = u
    }
    furnish(G, C, kind, { u0: 0, u1: C.F.L - 1, v0: 0, v1: C.F.D - 1, ud, space: rid }, dice, 0x220 + t)
    G.lamp(...C.at(Math.floor(C.F.L / 2), 0), dice.chance(0.3, 0x216, t), cage ? TUBE : WARM, { prio: 1 })
    placed++
  }
  return placed
}

const garageSides = (r) => ({
  N: { cells: (a) => [[a, r.z0], [a, r.z0 - 1]], range: [r.x0, r.x1] },
  S: { cells: (a) => [[a, r.z1], [a, r.z1 + 1]], range: [r.x0, r.x1] },
  W: { cells: (a) => [[r.x0, a], [r.x0 - 1, a]], range: [r.z0, r.z1] },
  E: { cells: (a) => [[r.x1, a], [r.x1 + 1, a]], range: [r.z0, r.z1] },
})

function pierCells(g) {
  const r = g.rect
  const [sx, sz] = g.pierStep
  const [px0, pz0] = g.pierPhase
  const out = []
  for (let z = r.z0 + 2 + pz0; z <= r.z1 - 2; z += sz) for (let x = r.x0 + 2 + px0; x <= r.x1 - 2; x += sx) out.push([x, z])
  return out
}

// Vehicles nose-in along the sides of rect `sides` (garageSides); with
// `space`, only on that space's cells. The stand-in is a dumpster pair; a
// cart (one cell) for the full-lot anomaly's identical rows.
function parkAlongWalls(G, sides, rate, dice, salt, space = null, kind = PROP_DUMPSTER) {
  let n = 0
  const mine = (x, z) => space === null || (G.has(x, z) && G.space[z * SPAN + x] === space)
  Object.entries(sides).forEach(([side, s], k) => {
    const [dx, dz] = DIR_VEC[side]
    const facing = side === 'N' || side === 'S' ? FACING.E : FACING.S
    for (let a = s.range[0] + 2; a <= s.range[1] - 2; a++) {
      if ((dice.d(salt, k * 128 + a) % 1000) / 1000 >= rate) continue
      const [[ix, iz]] = s.cells(a)
      if (!mine(ix, iz) || !mine(ix - dx, iz - dz)) continue
      if (kind === PROP_CART ? G.put(ix, iz, PROP_CART, { facing }) : G.putPair([ix, iz], [ix - dx, iz - dz], kind, facing)) n++
    }
  })
  return n
}

// Tube lamps every four cells over rect r (with `space`, only on that
// space's cells); whole rows on one run.
function tubes(G, r, litRate, dice, salt, space = null) {
  let row = 0
  for (let z = r.z0 + 2; z <= r.z1 - 1; z += 4, row++) {
    const on = (dice.d(salt, row) % 100) / 100 < litRate
    for (let x = r.x0 + 2; x <= r.x1 - 1; x += 4) {
      if (space !== null && (!G.has(x, z) || G.space[z * SPAN + x] !== space)) continue
      G.lamp(x, z, on, TUBE, { prio: 1 })
    }
  }
}

// The edge of booth rect b on side `side` at its `k`-th cell along that side.
function boothEdge(b, side, k) {
  if (side === 'N') return { axis: 'h', gx: b.x0 + k, gz: b.z0 }
  if (side === 'S') return { axis: 'h', gx: b.x0 + k, gz: b.z1 + 1 }
  if (side === 'W') return { axis: 'v', gx: b.x0, gz: b.z0 + k }
  return { axis: 'v', gx: b.x1 + 1, gz: b.z0 + k }
}

const innerCellsOf = (r) => {
  const out = []
  for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) out.push([x, z])
  return out
}

// Keep both cells of a door edge clear of pieces and posts.
function keepDoor(G, e) {
  if (e.axis === 'v') {
    G.keep(e.gx - 1, e.gz)
    G.keep(e.gx, e.gz)
  } else {
    G.keep(e.gx, e.gz - 1)
    G.keep(e.gx, e.gz)
  }
}

// --- frontage blocks ---------------------------------------------------------------------

// Shop types: what stands along the back wall, the side walls, in the middle
// (gondola rows), and whether a counter stands by the door.
const SHOP_TYPES = Object.freeze({
  grocery: { back: [FURN_COOLER], sides: [FURN_RACK], middle: [FURN_RACK], counter: true, role: SPACE_ROLE_STORAGE },
  laundromat: { back: [FURN_WASHER], sides: [FURN_WASHER], middle: [FURN_TABLE, FURN_CHAIR], counter: false, extra: FURN_PLANT, role: SPACE_ROLE_LAUNDRY },
  diner: { back: [FURN_COUNTER, FURN_STOVE, FURN_FRIDGE], sides: [FURN_TABLE], middle: [FURN_TABLE, FURN_CHAIR], counter: false, role: SPACE_ROLE_KITCHEN },
  office: { back: [FURN_CABINET, FURN_COPIER, FURN_WHITEBOARD], sides: [FURN_DESK], middle: [FURN_DESK, FURN_CHAIR], counter: false, extra: FURN_PLANT, role: SPACE_ROLE_OFFICE },
  video: { back: [FURN_BOOKSHELF], sides: [FURN_BOOKSHELF], middle: [FURN_BOOKSHELF], counter: true, extra: FURN_TV, role: SPACE_ROLE_LIBRARY },
  furniture: { back: [FURN_SOFA, FURN_ARMCHAIR], sides: [FURN_ARMCHAIR], middle: [FURN_TABLE, FURN_BED], counter: false, extra: FURN_PLANT, role: SPACE_ROLE_LOUNGE },
  pharmacy: { back: [FURN_CABINET], sides: [FURN_RACK], middle: [FURN_RACK], counter: true, role: SPACE_ROLE_STORAGE },
  salon: { back: [FURN_SINK], sides: [FURN_SINK, FURN_CHAIR], middle: [], counter: false, extra: FURN_SOFA, role: SPACE_ROLE_LOUNGE },
  vacant: { back: [], sides: [FURN_CABINET], middle: [], counter: false, role: SPACE_ROLE_STORAGE },
  motel: { back: [FURN_BED, FURN_NIGHTSTAND], sides: [FURN_WARDROBE, FURN_TV], middle: [], counter: false, role: SPACE_ROLE_BEDROOM },
  lobby: { back: [FURN_CABINET], sides: [FURN_SOFA, FURN_PLANT], middle: [], counter: true, role: SPACE_ROLE_LOUNGE },
  storage: { back: [FURN_RACK], sides: [FURN_RACK, FURN_CABINET], middle: [], counter: false, role: SPACE_ROLE_STORAGE },
  // The undercroft's rooms.
  plant: { back: [FURN_CABINET], sides: [FURN_CABINET, FURN_RACK], middle: [], counter: false, role: SPACE_ROLE_SERVER },
  archive: { back: [FURN_BOOKSHELF, FURN_CABINET], sides: [FURN_BOOKSHELF], middle: [FURN_BOOKSHELF], counter: false, role: SPACE_ROLE_ARCHIVE },
  laundry: { back: [FURN_WASHER], sides: [FURN_WASHER, FURN_RACK], middle: [FURN_TABLE], counter: false, role: SPACE_ROLE_LAUNDRY },
  cold: { back: [FURN_COOLER, FURN_FRIDGE], sides: [FURN_COOLER], middle: [FURN_RACK], counter: false, role: SPACE_ROLE_STORAGE },
})
const SHOP_ROTATION = Object.freeze(['grocery', 'laundromat', 'diner', 'office', 'video', 'furniture', 'pharmacy', 'salon', 'vacant', 'vacant'])

// Furnish canonical room cells u0..u1 × v0..v1 (v1 the door row, the door at
// column ud) of space `space` with shop type `t`: back wall first, then the
// side walls, the gondola rows, the counter. Every piece goes through
// Grid.put and lands only on the room's own cells.
function furnish(G, C, t, { u0, u1, v0, v1, ud, space }, dice, salt) {
  const T = SHOP_TYPES[t]
  const put = (u, v, kind, wall) => {
    if (u === ud && v >= v1 - 1) return false
    const [x, z] = C.at(u, v)
    if (space !== undefined && (!G.has(x, z) || G.space[z * SPAN + x] !== space)) return false
    return wall ? G.put(x, z, kind, { wall: C.wallOf[wall] }) : G.put(x, z, kind, { facing: FACE(C.wallOf.front) })
  }
  let k = 0
  if (T.back.length) for (let u = u0; u <= u1; u++) put(u, v0, T.back[k++ % T.back.length], 'back')
  k = 0
  for (let v = v0 + 1; v <= v1 - 1; v++) {
    if (!T.sides.length) break
    put(u0, v, T.sides[k % T.sides.length], 'left')
    put(u1, v, T.sides[(k + 1) % T.sides.length], 'right')
    k++
  }
  if (T.middle.length && u1 - u0 >= 4 && v1 - v0 >= 4) {
    for (let v = v0 + 2; v <= v1 - 2; v += 2) {
      for (let u = u0 + 2; u <= u1 - 2; u++) {
        if (u === ud) continue
        put(u, v, T.middle[(u + v) % T.middle.length], null)
      }
    }
  }
  if (T.counter) put(ud === u0 ? u0 + 1 : ud - 1, v1 - 1, FURN_COUNTER, null)
  if (T.extra) put(dice.d(salt) & 1 ? u0 : u1, v1, T.extra, null)
}

// A restroom (toilet, sink) in the back corner of a unit's floor, on side
// `left`/`right` of the door column: 2×2, or 1×2 (a toilet stall) in a
// three-wide unit; its door on its front edge. Canonical cells; returns true
// when drawn.
function restroom(G, C, { u0, u1, v0, ud, side }, S) {
  const rw = u1 - u0 + 1 >= 4 ? 2 : 1
  const ua = side === 'left' ? u0 : u1 - rw + 1
  const ub = ua + rw - 1
  if (ud >= ua && ud <= ub) return false
  const cells = []
  for (let u = ua; u <= ub; u++) for (const v of [v0, v0 + 1]) cells.push(C.at(u, v))
  if (cells.some(([x, z]) => !G.walk(x, z) || G.kept(x, z))) return false
  const id = S()
  const xs = cells.map((c) => c[0])
  const zs = cells.map((c) => c[1])
  const r = R(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs))
  const du = side === 'left' ? ub : ua
  const door = C.edgeUV(du, v0 + 1, 0, 1)
  G.room(r, { spaceId: id, role: SPACE_ROLE_BATHROOM, doors: [{ ...door, passage: PASSAGE_DOOR }] })
  keepDoor(G, door)
  const far = side === 'left' ? ua : ub
  G.put(...C.at(far, v0), FURN_TOILET, { wall: C.wallOf.back })
  if (rw === 2) G.put(...C.at(du, v0), FURN_SINK, { wall: C.wallOf.back })
  return true
}

// Split [0, L−1] into unit spans of widths [minW, maxW], keeping `hall`
// ([u0, u1]) as one unit of its own.
function splitUnits(L, hall, minW, maxW, rnd) {
  const segs = hall ? [[0, hall[0] - 1], null, [hall[1] + 1, L - 1]] : [[0, L - 1]]
  const out = []
  let k = 0
  for (const s of segs) {
    if (s === null) {
      out.push({ u0: hall[0], u1: hall[1], hall: true })
      continue
    }
    const [s0, s1] = s
    if (s1 < s0) continue
    let u = s0
    while (s1 - u + 1 > maxW) {
      let w = minW + (rnd(k++) % (maxW - minW + 1))
      if (s1 - (u + w) + 1 < minW) w = s1 - u + 1 - minW
      if (w < minW) break
      out.push({ u0: u, u1: u + w - 1 })
      u += w
    }
    out.push({ u0: u, u1: s1 })
  }
  return out
}

// One frontage block (strip mall, frontage motel or offices, big box,
// gas-station refuge) in its canonical frame.
function drawBlock(G0, b, S, dice, ctx) {
  const F = frameOf(b.rect, b.front, b.mirror)
  const C = canon(F)
  if (b.kind === 'gas') return drawGas(G0, b, F, C, S, dice)
  if (b.kind === 'bigbox') return drawBigBox(G0, b, F, C, S, dice)
  if (b.kind === 'pad') return drawPad(G0, b, F, C, S, dice, ctx)
  const a = b.alley
  const D = b.D
  const front = a + D - 1
  const walkV = a + D
  const salt = 0x400 + b.n * 0x80
  // A deja-vu district draws the same run of fronts as every other one.
  const rnd = ctx.dejaVu ? (k) => detail(0x0de7a, 0, 0, 0x7f0 + k) : (k) => dice.d(salt + 1, k)
  const sid = { walk: S(), alley: S() }
  // The walk in front and the alley (or service corridor) behind.
  for (let u = 0; u < F.L; u++) {
    for (let v = walkV; v < F.D; v++) G0.open(...C.at(u, v), CELL_OPEN, sid.walk)
  }
  const serviceCorridor = a > 0 && b.kind === 'strip' && (rnd(90) % 10) < 3
  for (let u = 0; u < F.L && a > 0; u++) {
    for (let v = 0; v < a; v++) G0.open(...C.at(u, v), serviceCorridor ? CELL_CORRIDOR : CELL_OPEN, sid.alley)
  }
  if (serviceCorridor) {
    // A corridor along the back: walled outside, a door at each end.
    for (let u = 0; u < F.L; u++) {
      const e = C.edgeUV(u, 0, 0, -1)
      G0.edge(e.axis, e.gx, e.gz, 1, PASSAGE_WALL)
    }
    for (const [u, du] of [[0, -1], [F.L - 1, 1]]) {
      for (let v = 0; v < a; v++) {
        const e = C.edgeUV(u, v, du, 0)
        if (v === 0) G0.edge(e.axis, e.gx, e.gz, 0, PASSAGE_DOOR)
        else G0.edge(e.axis, e.gx, e.gz, 1, PASSAGE_WALL)
      }
    }
  }
  // Units.
  const hall = b.core ? [b.core.u, b.core.u + 5] : null
  const motel = b.sub === 'motel'
  const offices = b.sub === 'offices'
  const [minW, maxW] = motel ? [3, 4] : offices ? [4, 6] : [3, 6]
  const units = splitUnits(F.L, hall, minW, maxW, rnd)
  const litP = motel || offices ? 0.3 : 0.4
  let officeDone = false
  let lit = 0
  let rooms = 0
  units.forEach((unit, k) => {
    const { u0, u1 } = unit
    const w = u1 - u0 + 1
    const id = S()
    const room = F.rectUV(u0, a, u1, front)
    const ud = u0 + Math.floor((w - 1) / 2) + (w > 3 && rnd(100 + k) & 1 ? 1 : 0)
    const door = C.edgeUV(ud, front, 0, 1)
    let type
    if (unit.hall) type = 'lobby'
    else if (motel) type = officeDone || w < 4 ? 'motel' : 'lobby'
    else if (offices) type = ['office', 'office', 'diner', 'pharmacy', 'vacant', 'salon'][rnd(200 + k) % 6]
    else type = SHOP_ROTATION[rnd(200 + k) % SHOP_ROTATION.length]
    if (type === 'lobby' && !unit.hall) officeDone = true
    const T = SHOP_TYPES[type]
    G0.room(room, { spaceId: id, role: T.role, doors: [{ ...door, passage: PASSAGE_DOOR }] })
    keepDoor(G0, door)
    rooms++
    // Storefront glass (shops); a window beside the door (motel rooms).
    for (let u = u0; u <= u1; u++) {
      if (u === ud) continue
      const e = C.edgeUV(u, front, 0, 1)
      if (type === 'motel' ? Math.abs(u - ud) === 1 : !unit.hall || Math.abs(u - ud) === 1) G0.window(e.axis, e.gx, e.gz)
    }
    // A back room (stock room, back office) behind a partition, its own space.
    let v0 = a
    if (!unit.hall && !motel && D >= 7 && w >= 4 && rnd(300 + k) % 10 < 6) {
      const bid = S()
      for (let u = u0; u <= u1; u++) {
        for (let v = a; v <= a + 1; v++) G0.open(...C.at(u, v), CELL_ROOM, bid, offices ? SPACE_ROLE_OFFICE : SPACE_ROLE_STORAGE)
        const e = C.edgeUV(u, a + 1, 0, 1)
        G0.edge(e.axis, e.gx, e.gz, 1, PASSAGE_WALL)
      }
      const pu = u0 + (rnd(310 + k) % w)
      const pe = C.edgeUV(pu, a + 1, 0, 1)
      G0.edge(pe.axis, pe.gx, pe.gz, 0, PASSAGE_DOOR)
      keepDoor(G0, pe)
      rooms++
      // Stock (or files) along the back wall, away from the door column.
      for (let u = u0; u <= u1; u++) if (u !== pu) G0.put(...C.at(u, a), offices ? ((u + k) % 2 ? FURN_DESK : FURN_CABINET) : (u + k) % 3 ? FURN_RACK : FURN_CABINET, { wall: C.wallOf.back })
      // A back door to the alley, or a loading dock (two wide).
      if (a > 0 && rnd(320 + k) % 10 < 5) {
        const bu = pu === u0 ? u1 : u0
        const dock = !serviceCorridor && w >= 5 && rnd(330 + k) % 3 === 0
        for (const uu of dock ? [bu, bu === u0 ? u0 + 1 : u1 - 1] : [bu]) {
          const e = C.edgeUV(uu, a, 0, -1)
          G0.edge(e.axis, e.gx, e.gz, 0, dock ? PASSAGE_WIDE : PASSAGE_DOOR)
          keepDoor(G0, e)
          G0.unput(...C.at(uu, a))
        }
      }
      v0 = a + 2
    } else if (!unit.hall && a > 0 && rnd(340 + k) % 10 < 3) {
      const bu = u0 === ud ? u1 : u0
      const e = C.edgeUV(bu, a, 0, -1)
      G0.edge(e.axis, e.gx, e.gz, 0, PASSAGE_DOOR)
      keepDoor(G0, e)
    }
    if (unit.hall) {
      // The stair hall: the core (blueprint) takes the back four rows.
      G0.keepRect(grow(b.core.rect, 1))
    } else {
      // A restroom in a back corner (every motel room has its bathroom).
      const side = ud - u0 <= u1 - ud ? 'right' : 'left'
      if ((type === 'motel' || rnd(350 + k) % 10 < 7) && front - v0 >= 4 && w >= 3) {
        if (restroom(G0, C, { u0, u1, v0, ud, side }, S)) rooms++
      }
      furnish(G0, C, type, { u0, u1, v0, v1: front, ud, space: id }, dice, salt + 400 + k)
    }
    // Light: a lit unit burns inside and under the canopy at its door.
    const on = type === 'lobby' || (rnd(500 + k) % 1000) / 1000 < litP
    if (on) lit++
    const mid = Math.floor((v0 + front) / 2)
    G0.lamp(...C.at(u0 + Math.floor(w / 2), mid), on, WARM, { prio: 1 })
    if (w >= 5 && front - v0 >= 4) G0.lamp(...C.at(u0 + Math.floor(w / 2), front - 1), on, WARM, { prio: 1 })
    G0.lamp(...C.at(ud, walkV), on, MODULE_WHITE, { prio: 2 })
  })
  // The alley: dumpsters and bins against the back wall, a bench on the walk.
  if (a > 0) {
    for (let u = 1; u < F.L - 1; u += 4 + (rnd(600 + u) % 3)) {
      const kind = rnd(610 + u) % 3 ? PROP_WHEELIE_BIN : PROP_DUMPSTER
      G0.put(...C.at(u, a - 1), kind, { wall: C.wallOf.front })
    }
    G0.lamp(...C.at(Math.floor(F.L / 2), 0), rnd(620) % 3 === 0, SODIUM, { prio: 2 })
  }
  // Canopy columns along the walk (every third cell, clear of the doors).
  if (F.D > walkV && rnd(660) % 4 !== 0) {
    for (let u = 1 + (rnd(661) % 3); u < F.L - 1; u += 3) G0.post(...C.at(u, walkV))
  }
  if (F.D > walkV) {
    for (let u = 2; u < F.L - 2; u += 7 + (rnd(630 + u) % 4)) {
      G0.put(...C.at(u, F.D - 1), rnd(640 + u) & 1 ? PROP_BENCH : PROP_WHEELIE_BIN, { facing: FACE(C.wallOf.front) })
    }
  }
  return { rooms, lit, units: units.length }
}

// An outparcel out in the lot (doc 02 §2: Hopper's lit diner seen across the
// dark): a glass-walled main room (rows 2..D−1) with its door on the walk, a
// back room and a WC behind it (rows 0–1), a back door to the lot; a diner,
// a bank, a laundromat, a video store, a pharmacy, or vacant.
const PAD_TYPES = Object.freeze(['diner', 'diner', 'office', 'laundromat', 'video', 'pharmacy', 'vacant'])
const PAD_BACK = Object.freeze({ diner: 'cold', office: 'archive' })
function drawPad(G0, b, F, C, S, dice, ctx) {
  const L = F.L
  const D = b.D
  const salt = 0x680 + b.n * 0x20
  const rnd = ctx.dejaVu ? (k) => detail(0x0de7a, 0, 0, 0xaf0 + k) : (k) => dice.d(salt, k)
  const type = PAD_TYPES[rnd(0) % PAD_TYPES.length]
  const walk = S()
  for (let u = 0; u < L; u++) G0.open(...C.at(u, D), CELL_OPEN, walk)
  // The main room, its door on the walk, glass along the front and both ends.
  const main = S()
  const ud = 1 + (rnd(1) % Math.max(1, L - 2))
  const door = C.edgeUV(ud, D - 1, 0, 1)
  G0.room(F.rectUV(0, 2, L - 1, D - 1), { spaceId: main, role: SHOP_TYPES[type].role, doors: [{ ...door, passage: PASSAGE_DOOR }] })
  keepDoor(G0, door)
  for (let u = 0; u < L; u++) {
    if (u === ud) continue
    const e = C.edgeUV(u, D - 1, 0, 1)
    G0.window(e.axis, e.gx, e.gz)
  }
  for (let v = 3; v <= D - 2; v++) {
    for (const [u, du] of [[0, -1], [L - 1, 1]]) {
      const e = C.edgeUV(u, v, du, 0)
      G0.window(e.axis, e.gx, e.gz)
    }
  }
  // The back room and the WC behind it, both doors into the main room.
  const wcLeft = (rnd(2) & 1) === 1
  const wc = wcLeft ? [0, 1] : [L - 2, L - 1]
  const br = wcLeft ? [2, L - 1] : [0, L - 3]
  const back = S()
  const bdu = br[0] + (rnd(3) % (br[1] - br[0] + 1))
  const bdoor = C.edgeUV(bdu, 1, 0, 1)
  G0.room(F.rectUV(br[0], 0, br[1], 1), { spaceId: back, role: SHOP_TYPES[PAD_BACK[type] ?? 'storage'].role, doors: [{ ...bdoor, passage: PASSAGE_DOOR }] })
  keepDoor(G0, bdoor)
  if (rnd(4) % 2 === 0) {
    const rdu = bdu === br[0] ? br[1] : br[0]
    const rdoor = C.edgeUV(rdu, 0, 0, -1)
    G0.edge(rdoor.axis, rdoor.gx, rdoor.gz, 0, PASSAGE_DOOR)
    keepDoor(G0, rdoor)
  }
  const wdu = wcLeft ? 1 : L - 2
  const wdoor = C.edgeUV(wdu, 1, 0, 1)
  G0.room(F.rectUV(wc[0], 0, wc[1], 1), { spaceId: S(), role: SPACE_ROLE_BATHROOM, doors: [{ ...wdoor, passage: PASSAGE_DOOR }] })
  keepDoor(G0, wdoor)
  G0.put(...C.at(wcLeft ? 0 : L - 1, 0), FURN_TOILET, { wall: C.wallOf.back })
  G0.put(...C.at(wcLeft ? 0 : L - 1, 1), FURN_SINK, { wall: wcLeft ? C.wallOf.left : C.wallOf.right })
  furnish(G0, C, PAD_BACK[type] ?? 'storage', { u0: br[0], u1: br[1], v0: 0, v1: 1, ud: bdu, space: back }, dice, salt + 5)
  furnish(G0, C, type, { u0: 0, u1: L - 1, v0: 2, v1: D - 1, ud, space: main }, dice, salt + 6)
  // Light: the lit glass box across the dark, or a dead one.
  const on = rnd(7) % 100 < 55
  const tint = type === 'diner' ? WARM : MODULE_WHITE
  G0.lamp(...C.at(Math.floor(L / 3), Math.floor((D + 1) / 2)), on, tint, { prio: 2 })
  G0.lamp(...C.at(Math.floor((2 * L) / 3), Math.floor((D + 1) / 2)), on, tint, { prio: 2 })
  G0.lamp(...C.at(ud, D), on, MODULE_WHITE, { prio: 2 })
  G0.lamp(...C.at(br[0] + 1, 0), rnd(8) % 100 < 20, TUBE, { prio: 1 })
  // The walk: a bench and a bin, a newspaper box.
  G0.put(...C.at(ud === 0 ? 2 : 0, D), PROP_BENCH, { facing: FACE(C.wallOf.front) })
  G0.put(...C.at(ud === L - 1 ? L - 3 : L - 1, D), PROP_WHEELIE_BIN, { facing: FACE(C.wallOf.front) })
  return { rooms: 3, lit: on ? 1 : 0, units: 1 }
}

// The gas-station refuge: the shop (rows 0–3) with a restroom beside it, a
// walk (row 4), the canopy apron (rows 5..D−1) under the district's
// brightest lamps, pump islands, a bench; the spawn row in the home
// district stays clear.
function drawGas(G0, b, F, C, S, dice) {
  const ids = { apron: S(), shop: S(), walk: S() }
  const L = F.L
  const D = F.D
  for (let u = 0; u < L; u++) {
    for (let v = 0; v < D; v++) G0.open(...C.at(u, v), v >= 5 ? CELL_LOBBY : CELL_OPEN, v === 4 ? ids.walk : ids.apron)
  }
  for (const c of b.spawn) {
    G0.keep(c[0], c[1])
    for (const [dx, dz] of RING8) G0.keep(c[0] + dx, c[1] + dz)
  }
  const sw = 5 + dice.pick(2, 0x500)
  const su0 = dice.chance(0.5, 0x501) ? 1 : L - 1 - sw
  const shop = F.rectUV(su0, 0, su0 + sw - 1, 3)
  const ud = su0 + 1 + dice.pick(sw - 2, 0x502)
  const door = C.edgeUV(ud, 3, 0, 1)
  G0.room(shop, { spaceId: ids.shop, role: SPACE_ROLE_STORAGE, doors: [{ ...door, passage: PASSAGE_DOOR }] })
  keepDoor(G0, door)
  for (let u = su0; u < su0 + sw; u++) {
    if (u === ud) continue
    const e = C.edgeUV(u, 3, 0, 1)
    G0.window(e.axis, e.gx, e.gz)
  }
  furnish(G0, C, 'grocery', { u0: su0, u1: su0 + sw - 1, v0: 0, v1: 3, ud, space: ids.shop }, dice, 0x503)
  G0.lamp(...C.at(su0 + 1, 1), true, MODULE_WHITE, { prio: 3 })
  G0.lamp(...C.at(su0 + sw - 2, 2), true, MODULE_WHITE, { prio: 3 })
  // The restroom beside the shop, its door on the walk ("key at the counter").
  const ru = su0 === 1 ? su0 + sw + 1 : su0 - 3
  const rr = F.rectUV(ru, 2, ru + 1, 3)
  const rdoor = C.edgeUV(ru, 3, 0, 1)
  G0.room(rr, { spaceId: S(), role: SPACE_ROLE_BATHROOM, doors: [{ ...rdoor, passage: PASSAGE_DOOR }] })
  keepDoor(G0, rdoor)
  G0.put(...C.at(ru + 1, 2), FURN_TOILET, { wall: C.wallOf.back })
  G0.put(...C.at(ru, 2), FURN_SINK, { wall: C.wallOf.back })
  // Behind/beside the shop: a dumpster and the air stand (a post).
  const yard = su0 === 1 ? [L - 2, 1] : [1, 1]
  G0.put(...C.at(yard[0], yard[1]), PROP_DUMPSTER, { wall: C.wallOf.back })
  G0.post(...C.at(yard[0], 3))
  // Canopy lamps (rows 6 and D−2, every third cell) and pump islands (row 6
  // pairs, the spawn row left clear).
  const rows = [6, D - 2]
  rows.forEach((v, k) => {
    for (let u = 1 + k; u < L - 1; u += 3) G0.lamp(...C.at(u, v), true, MODULE_WHITE, { prio: 3 })
  })
  for (const pu of [2, L - 4]) {
    for (const du of [0, 1]) G0.post(...C.at(pu + du, D - 4 >= 6 ? D - 4 : 6))
  }
  G0.put(...C.at(su0 === 1 ? L - 2 : 1, 4), PROP_BENCH, { facing: FACE(C.wallOf.front) })
  G0.put(...C.at(su0 === 1 ? L - 3 : 2, 4), PROP_WHEELIE_BIN, { facing: FACE(C.wallOf.front) })
  return { rooms: 2, lit: 1, units: 1 }
}

// The big-box store: mass behind its frontage, a lit (or dead) vestibule
// with two doors under a canopy, a customer-service room and restrooms off
// it, a cart corral and bins on the apron.
function drawBigBox(G0, b, F, C, S, dice) {
  const D = b.D
  const L = F.L
  const ids = { walk: S(), vest: S() }
  for (let u = 0; u < L; u++) {
    for (let v = 0; v < D; v++) G0.del(...C.at(u, v))
    for (let v = D; v < F.D; v++) G0.open(...C.at(u, v), CELL_OPEN, ids.walk)
  }
  // The vestibule: centred on the stock stair's door when the store has one.
  const vu = b.core ? b.core.du - 1 : 2 + dice.pick(Math.max(1, L - 9), 0x600)
  if (b.core) {
    G0.keepRect(grow(b.core.rect, 1))
    G0.keep(...b.core.door.outside)
  }
  const vest = F.rectUV(vu, D - 3, vu + 3, D - 1)
  const doors = [vu + 1, vu + 2].map((u) => ({ ...C.edgeUV(u, D - 1, 0, 1), passage: PASSAGE_DOOR }))
  G0.room(vest, { spaceId: ids.vest, role: SPACE_ROLE_STORAGE, doors })
  for (const d of doors) keepDoor(G0, d)
  // Customer service (a counter behind glass) and the restrooms.
  const svc = F.rectUV(vu + 4, D - 3, vu + 6, D - 1)
  const sdoor = C.edgeUV(vu + 3, D - 2, 1, 0)
  G0.room(svc, { spaceId: S(), role: SPACE_ROLE_OFFICE, doors: [{ ...sdoor, passage: PASSAGE_DOOR }] })
  keepDoor(G0, sdoor)
  for (const u of [vu + 4, vu + 6]) {
    const e = C.edgeUV(u, D - 1, 0, 1)
    G0.window(e.axis, e.gx, e.gz)
  }
  G0.put(...C.at(vu + 5, D - 2), FURN_COUNTER, { facing: FACE(C.wallOf.front) })
  G0.put(...C.at(vu + 6, D - 3), FURN_CABINET, { wall: C.wallOf.back })
  const wc = F.rectUV(vu - 2, D - 2, vu - 1, D - 1)
  const wdoor = C.edgeUV(vu, D - 2, -1, 0)
  G0.room(wc, { spaceId: S(), role: SPACE_ROLE_BATHROOM, doors: [{ ...wdoor, passage: PASSAGE_DOOR }] })
  keepDoor(G0, wdoor)
  G0.put(...C.at(vu - 2, D - 2), FURN_TOILET, { wall: C.wallOf.back })
  G0.put(...C.at(vu - 2, D - 1), FURN_SINK, { wall: C.wallOf.left })
  const lit = dice.chance(0.6, 0x601)
  G0.lamp(...C.at(vu + 1, D - 2), lit, MODULE_WHITE, { prio: 2 })
  G0.lamp(...C.at(vu + 2, D - 2), lit, MODULE_WHITE, { prio: 2 })
  G0.lamp(...C.at(vu + 5, D - 3), lit, WARM, { prio: 1 })
  for (const u of [vu, vu + 3]) G0.lamp(...C.at(u, D + 1), lit, MODULE_WHITE, { prio: 2 })
  G0.put(...C.at(vu, D - 3), FURN_PLANT)
  G0.put(...C.at(vu + 3, D - 3), PROP_CART, { facing: FACE(C.wallOf.front) })
  // The cart-return corral on the walk: three carts between rails.
  const cu = vu + 8 <= L - 4 ? vu + 8 : Math.max(0, vu - 6)
  let ok = true
  for (let u = cu; u <= cu + 2 && ok; u++) ok = G0.walk(...C.at(u, D + 1)) && !G0.kept(...C.at(u, D + 1))
  if (ok && cu + 2 < L) {
    for (let u = cu; u <= cu + 2; u++) {
      const e = C.edgeUV(u, D + 1, 0, -1)
      G0.rail(e.axis, e.gx, e.gz)
      G0.put(...C.at(u, D + 1), PROP_CART, { facing: FACE(C.wallOf.front) })
    }
  }
  for (const u of [1, L - 2]) G0.put(...C.at(u, D), u === 1 ? PROP_DUMPSTER : PROP_WHEELIE_BIN, { wall: C.wallOf.back })
  // The front walk's furniture against the facade, on a hashed pitch: the
  // ice chest, a vending cooler, benches, bins, a stack of carts nobody
  // returned; a sodium wall pack over one in three, mostly dead.
  const pitch = 3 + dice.pick(3, 0x602)
  const kinds = [FURN_COOLER, PROP_BENCH, PROP_WHEELIE_BIN, PROP_CART, FURN_PLANT, FURN_COOLER]
  for (let u = 3 + dice.pick(pitch, 0x603), k = 0; u < L - 3; u += pitch, k++) {
    if (u >= vu - 2 && u <= vu + 6) continue
    if (G0.put(...C.at(u, D), kinds[dice.pick(kinds.length, 0x604, k)], { wall: C.wallOf.back }) && dice.pick(3, 0x605, k) === 0) {
      G0.lamp(...C.at(u, D + 1), dice.chance(0.3, 0x606, k), SODIUM, { prio: 1 })
    }
  }
  return { rooms: 3, lit: lit ? 1 : 0, units: 1 }
}

// Booths: a bus shelter (glass back and ends, a bench), a pay booth (desk,
// chair) or a small kiosk (counter, cooler).
function drawBooth(G0, bo, S, dice) {
  const r = bo.rect
  const id = S()
  const k = 0x700 + bo.n * 16
  if (bo.kind === 'shelter') {
    G0.rect(r, CELL_LOBBY, id)
    const F = frameOf(r, bo.front)
    const C = canon(F)
    for (let u = 0; u < F.L; u++) {
      const e = C.edgeUV(u, 0, 0, -1)
      G0.window(e.axis, e.gx, e.gz)
    }
    for (const [u, du] of [[0, -1], [F.L - 1, 1]]) {
      const e = C.edgeUV(u, 0, du, 0)
      G0.window(e.axis, e.gx, e.gz)
    }
    G0.put(...C.at(1, 0), PROP_BENCH, { facing: FACE(C.wallOf.front) })
    G0.lamp(...C.at(0, 0), dice.chance(0.5, k), MODULE_WHITE, { prio: 2 })
    return { rooms: 0 }
  }
  const door = boothEdge(r, bo.front, Math.floor(((bo.front === 'N' || bo.front === 'S' ? r.x1 - r.x0 : r.z1 - r.z0)) / 2))
  G0.room(r, { spaceId: id, role: SPACE_ROLE_STORAGE, doors: [{ ...door, passage: PASSAGE_DOOR }] })
  keepDoor(G0, door)
  const glass = boothEdge(r, bo.front, 0)
  if (glass.gx !== door.gx || glass.gz !== door.gz) G0.window(glass.axis, glass.gx, glass.gz)
  const cells = innerCellsOf(r).filter(([x, z]) => !G0.kept(x, z))
  const kinds = bo.kind === 'booth' ? [FURN_DESK, FURN_CHAIR] : [FURN_COUNTER, FURN_COOLER, FURN_RACK]
  kinds.forEach((kind, i) => cells[i] && G0.put(...cells[i], kind, { facing: FACE(bo.front) }))
  G0.lamp(r.x0, r.z0, dice.chance(0.4, k + 1), MODULE_WHITE, { prio: 2 })
  return { rooms: 1 }
}

// --- the kiosk with a basement ------------------------------------------------------------

// The kiosk's stairwell core: landing KIOSK.landing, flight east in the
// module's canonical frame, turned with the module; the door on the core's
// side facing the kiosk's open floor (the module's south). Kind-local plan
// (baseCy BASEMENT, topCy DECK) and its core rect in kind-local cells.
export function kioskStair(T) {
  const [gx, gz] = T.cell(KIOSK.landing.x, KIOSK.landing.z)
  const dir = T.stairDir(STAIR_E)
  const [sx, sz] = T.vec(0, 1)
  const horizontal = dir === STAIR_E || dir === STAIR_W
  for (const doorSide of ['far', 'near']) {
    const out = doorSide === 'far' ? 1 : -1
    const [ox, oz] = horizontal ? [0, out] : [out, 0]
    if (ox !== sx || oz !== sz) continue
    const plan = stairwellPlan({ gx, gz, baseCy: BASEMENT, topCy: DECK, dir, doorSide })
    if (plan.error) return { error: plan.error }
    const core = {
      x0: plan.cx * CHUNK + plan.core.x0,
      z0: plan.cz * CHUNK + plan.core.z0,
      x1: plan.cx * CHUNK + plan.core.x1,
      z1: plan.cz * CHUNK + plan.core.z1,
    }
    return { plan, core }
  }
  return { error: 'nightlot kiosk: no stair door faces the kiosk floor' }
}

// The kiosk-with-basement module on the lot: a lit 10×8 kiosk round the
// stairwell core, two doors south, a canopy pair outside, a cooler, a rack
// and a counter on its free strip.
function drawKioskDeck(G, T, stair, id) {
  const room = KIOSK.room
  G.room(T.rect(room), {
    spaceId: id,
    role: SPACE_ROLE_STORAGE,
    doors: KIOSK.doors.map((x) => T.edge('h', x, room.z1 + 1)),
  })
  G.delRect(stair.core)
  G.keepRect(grow(stair.core, 1))
  for (const [x, z] of [[10, 4], [10, 8], [3, 9], [5, 12], [8, 12]]) G.lamp(...T.cell(x, z), true, MODULE_WHITE, { prio: 3 })
  for (const x of KIOSK.doors) {
    G.keep(...T.cell(x, room.z1))
    G.keep(...T.cell(x, room.z1 + 1))
  }
  G.put(...T.cell(11, 4), FURN_COOLER, { wall: T.wall('E') })
  G.put(...T.cell(11, 7), FURN_RACK, { wall: T.wall('E') })
  G.put(...T.cell(10, 10), FURN_COUNTER, { wall: T.wall('S') })
}

// The service floor below (the undercroft storey): a lobby round the core, a
// corridor, a plant room (the exit's room in the exit district) and a store
// room inside the module's cells 2..12; the lobby opens on a service door to
// the undercroft at canonical cell (1, 3) (always local 1 or 12 in the chunk,
// so never on the district's seam lines).
function drawKioskBasement(G, T, stair, S) {
  const lobby = S()
  G.rect(T.rect(KIOSK.lobby), CELL_CORRIDOR, lobby)
  G.rect(T.rect(KIOSK.corridor), CELL_CORRIDOR, lobby)
  G.room(T.rect(KIOSK.plant), { spaceId: S(), role: SPACE_ROLE_SERVER, doors: [T.edge('h', 10, KIOSK.plant.z1 + 1)] })
  G.room(T.rect(KIOSK.store), { spaceId: S(), role: SPACE_ROLE_STORAGE, doors: [T.edge('h', 5, KIOSK.store.z0)] })
  G.delRect(stair.core)
  G.keepRect(grow(stair.core, 1))
  G.open(...T.cell(1, 3), CELL_CORRIDOR, lobby)
  G.keep(...T.cell(1, 3))
  G.keep(...T.cell(2, 3))
  for (const [x, z, lit] of [[3, 3, true], [11, 10, true], [10, 5, true], [8, 12, true], [3, 12, false]]) G.lamp(...T.cell(x, z), lit, MODULE_WHITE, { prio: 3 })
  for (const [x, z] of KIOSK.exits) G.keep(...T.cell(x, z))
  G.put(...T.cell(12, 8), FURN_RACK, { wall: T.wall('E') })
  G.put(...T.cell(3, 12), FURN_RACK, { wall: T.wall('S') })
  G.put(...T.cell(9, 12), FURN_RACK, { wall: T.wall('S') })
}

// --- the undercroft (cy −1) ----------------------------------------------------------------

// The diggable cells: the district's seam lines stay mass (§6.8 rules 1–2)
// except at the underpass ports.
const UNDER = Object.freeze(R(1, 1, SPAN - 2, SPAN - 2))

// The undercroft below one district: the garage's B1 deck, under-lot decks,
// the basement suites of the blocks, the kiosk's service floor, the stair
// cores' landings, the underpasses at the seams, and service tunnels that
// join them all; plant rooms and storage cages in the leftover ground.
function drawUnder(GU, bp, S, dice, { kiosk, seed, tx, tz, closed = false }) {
  const reserved = new Uint8Array(NCELLS)
  const reserve = (r) => {
    for (let z = Math.max(0, r.z0); z <= Math.min(SPAN - 1, r.z1); z++) for (let x = Math.max(0, r.x0); x <= Math.min(SPAN - 1, r.x1); x++) reserved[z * SPAN + x] = 1
  }
  const diggable = (x, z) => inRect(UNDER, x, z) && !reserved[z * SPAN + x] && !GU.has(x, z)
  const seeds = []
  // 1. The kiosk's service floor.
  if (kiosk) {
    drawKioskBasement(GU, kiosk.T, kiosk.stair, S)
    reserve(kioskArea(kiosk.m.lcx, kiosk.m.lcz))
    const [lx, lz] = kiosk.T.cell(KIOSK.lobby.x0, KIOSK.lobby.z1)
    seeds.push([lx, lz])
  }
  // 2. The stair cores' landings (core and halo).
  for (const c of bp.cores) {
    const h = grow(c.rect, 1)
    GU.rect(h, CELL_LOBBY, S())
    GU.keepRect(h)
    reserve(h)
    seeds.push([h.x0, h.z0])
  }
  // 3. The basement suites under the blocks.
  let suites = 0
  for (const b of bp.blocks) suites += drawSuite(GU, b, S, dice, diggable)
  // 4. Decks: the garage's B1 (its rect grown 0–4 cells per side) and under
  //    most lots (a lot with a stair head always) a deck shrunk 0–3 cells.
  const decks = []
  if (bp.garage) {
    const g = bp.garage.rect
    const e = (k) => dice.pick(5, 0x900, k)
    decks.push({ rect: R(g.x0 - e(0), g.z0 - e(1), g.x1 + e(2), g.z1 + e(3)), kind: 'garage', salt: 0x910 })
  }
  bp.lots.forEach((lot) => {
    if (!lot.core && !dice.chance(0.9, 0x920, lot.n)) return
    const s = (k) => dice.pick(4, 0x921, lot.n * 4 + k)
    const r = R(lot.rect.x0 + s(0), lot.rect.z0 + s(1), lot.rect.x1 - s(2), lot.rect.z1 - s(3))
    if (r.x1 - r.x0 < 4 || r.z1 - r.z0 < 4) return
    decks.push({ rect: r, kind: 'lot', salt: 0x930 + lot.n * 8 })
  })
  // Overflow decks: five to eight more bays of the undercroft at hashed spots,
  // under the roads and aprons as much as under the lots.
  const nOver = 5 + dice.pick(4, 0x960)
  const digDeck = (d) => {
    d.id = S()
    for (let z = d.rect.z0; z <= d.rect.z1; z++) for (let x = d.rect.x0; x <= d.rect.x1; x++) if (diggable(x, z)) GU.open(x, z, CELL_LOBBY, d.id)
  }
  for (const d of decks) digDeck(d)
  // Each overflow bay takes the best of four hashed spots (the most untouched
  // ground), so the bays spread into the solid ground the lots leave.
  const freeIn = (r) => {
    let n = 0
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) if (diggable(x, z)) n++
    return n
  }
  for (let k = 0; k < nOver; k++) {
    const w = 9 + dice.pick(16, 0x961, k)
    const d = 7 + dice.pick(14, 0x962, k)
    let best = null
    for (let t = 0; t < 4; t++) {
      const x0 = 1 + dice.pick(SPAN - 2 - w, 0x963, k * 8 + t)
      const z0 = 1 + dice.pick(SPAN - 2 - d, 0x964, k * 8 + t)
      const r = R(x0, z0, x0 + w - 1, z0 + d - 1)
      const n = freeIn(r)
      if (!best || n > best.n) best = { r, n }
    }
    if (best.n < 24) continue
    const deck = { rect: best.r, kind: 'overflow', salt: 0x970 + k * 8 }
    decks.push(deck)
    digDeck(deck)
  }
  // 5. The underpasses: this district's west/north ports and the
  //    neighbours' (its east/south view), three cells deep.
  const ports = []
  for (const p of underPorts(seed, tx, tz, 'west')) ports.push({ p, cell: (a, k) => [k, a] })
  for (const p of underPorts(seed, tx, tz, 'north')) ports.push({ p, cell: (a, k) => [a, k] })
  // (A closed sample — the kind lab's — has no neighbours to meet there.)
  if (!closed) {
    for (const p of underPorts(seed, tx + 1, tz, 'west')) ports.push({ p, cell: (a, k) => [SPAN - 1 - k, a] })
    for (const p of underPorts(seed, tx, tz + 1, 'north')) ports.push({ p, cell: (a, k) => [a, SPAN - 1 - k] })
  }
  const portCells = []
  for (const { p, cell } of ports) {
    const id = S()
    for (let a = p.a0; a <= p.a1; a++) {
      for (let k = 0; k < 3; k++) {
        const [x, z] = cell(a, k)
        if (k === 0 || diggable(x, z)) GU.open(x, z, CELL_CORRIDOR, id)
        if (k === 0) {
          GU.keep(x, z)
          portCells.push([x, z])
        }
      }
    }
    const [lx, lz] = cell(p.a0, 1)
    GU.lamp(lx, lz, dice.chance(0.5, 0x940, p.a0), TUBE, { prio: 2 })
  }
  // 6. Service tunnels: every component joins the network.
  const tunnels = connectAll(GU, seeds, diggable, S, dice)
  // 7. Plant rooms, pump rooms, archives and storage cages in the leftover
  //    ground, each with a door on the network.
  const extras = placeUnderRooms(GU, S, dice, diggable)
  // 8. Whatever the network does not reach goes back to mass (port cells
  //    stay: their neighbour reaches them).
  pruneUnreached(GU, [...seeds, ...portCells])
  // 9. Dressing: piers, tubes and rare vehicles on the decks; tunnel lamps.
  for (const d of decks) dressDeck(GU, d, bp, dice)
  for (const t of tunnels) {
    t.cells.forEach(([x, z], i) => {
      if (i % 6 === 3) GU.lamp(x, z, dice.chance(0.3, 0x950, x * 64 + z), TUBE, { prio: 1 })
    })
  }
  return { decks: decks.length, suites, tunnels: tunnels.length, extras, ports: ports.length }
}

// A block's basement suite: a service corridor along the block in front of
// the stair hall's landing (its back rows a..a+3), rooms behind it and before
// it, each with a door on the corridor; under a big box, a stock hall of rack
// rows. Only diggable cells are used. Returns the number of rooms.
function drawSuite(GU, b, S, dice, diggable) {
  if (b.kind === 'gas' || b.kind === 'pad') return 0
  const F = frameOf(b.rect, b.front, b.mirror)
  const C = canon(F)
  const salt = 0xa00 + b.n * 0x40
  const ok = (u, v) => diggable(...C.at(u, v))
  if (b.kind === 'bigbox') {
    // The stock hall: rows 1..D−2 under the store, rack rows every other row
    // with a cross aisle every 6 cells, a freight corridor in front.
    const id = S()
    for (let v = 1; v <= b.D - 1; v++) for (let u = 1; u <= F.L - 2; u++) if (ok(u, v)) GU.open(...C.at(u, v), v === b.D - 1 ? CELL_CORRIDOR : CELL_LOBBY, id)
    for (let v = 2; v <= b.D - 3; v += 2) {
      for (let u = 2; u <= F.L - 3; u++) if ((u - 2) % 6 !== 5) GU.put(...C.at(u, v), dice.chance(0.8, salt, v * 64 + u) ? FURN_RACK : FURN_CABINET, { facing: FACE(C.wallOf.front) })
    }
    for (let u = 3; u < F.L - 2; u += 6) GU.lamp(...C.at(u, Math.floor(b.D / 2)), dice.chance(0.25, salt + 1, u), TUBE, { prio: 1 })
    return 1
  }
  const a = b.alley
  const D = b.D
  const vc = a + 4
  const corr = S()
  for (let u = 0; u < F.L; u++) if (ok(u, vc)) GU.open(...C.at(u, vc), CELL_CORRIDOR, corr)
  const hall = b.core ? [b.core.u - 1, b.core.u + 6] : null
  const types = b.sub === 'motel' ? ['laundry', 'storage', 'plant', 'laundry'] : b.sub === 'offices' ? ['archive', 'archive', 'plant', 'storage'] : ['storage', 'cold', 'plant', 'storage', 'vacant']
  let rooms = 0
  const bands = [[a, vc - 1, -1], [vc + 1, a + D - 1, 1]]
  bands.forEach(([v0, v1, dir], bi) => {
    if (v1 - v0 < 1) return
    const units = splitUnits(F.L, bi === 0 ? hall : null, 3, 6, (k) => dice.d(salt + 2 + bi, k))
    units.forEach((unit, k) => {
      if (unit.hall) return
      const { u0, u1 } = unit
      for (let u = u0; u <= u1; u++) for (let v = v0; v <= v1; v++) if (!ok(u, v)) return
      const ud = u0 + Math.floor((u1 - u0) / 2)
      const doorV = dir < 0 ? v1 : v0
      const [cx, cz] = C.at(ud, vc)
      if (!GU.has(cx, cz)) return
      const id = S()
      const door = C.edgeUV(ud, doorV, 0, -dir)
      const type = types[dice.d(salt + 4, bi * 32 + k) % types.length]
      GU.room(F.rectUV(u0, v0, u1, v1), { spaceId: id, role: SHOP_TYPES[type].role, doors: [{ ...door, passage: PASSAGE_DOOR }] })
      keepDoor(GU, door)
      rooms++
      const Cr = dir < 0 ? C : canonFlip(C, v0 + v1)
      furnish(GU, Cr, type, { u0, u1, v0, v1, ud, space: id }, dice, salt + 8 + bi * 32 + k)
      GU.lamp(...C.at(ud, Math.floor((v0 + v1) / 2)), dice.chance(0.2, salt + 5, bi * 32 + k), WARM, { prio: 1 })
    })
  })
  for (let u = 1; u < F.L; u += 5) if (GU.has(...C.at(u, vc))) GU.lamp(...C.at(u, vc), dice.chance(0.35, salt + 6, u), TUBE, { prio: 1 })
  return rooms
}

// The canonical helper of a front band seen from the corridor: v mirrored
// about (vSum / 2), so its door row is the band's largest v and 'back' is
// the outer wall.
function canonFlip(C, vSum) {
  const at = (u, v) => C.at(u, vSum - v)
  const edgeUV = (u, v, du, dv) => C.edgeUV(u, vSum - v, du, -dv)
  const wallOf = { back: C.wallOf.front, front: C.wallOf.back, left: C.wallOf.left, right: C.wallOf.right }
  return { F: C.F, at, edgeUV, wallOf }
}

const N4 = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]])

// Connected components of the grid's plan cells (walls respected).
function components(G) {
  const comp = new Int32Array(NCELLS).fill(-1)
  const list = []
  const stack = []
  for (let i = 0; i < NCELLS; i++) {
    if (!G.plan[i] || comp[i] >= 0) continue
    const k = list.length
    const cells = []
    comp[i] = k
    stack.push(i)
    while (stack.length) {
      const j = stack.pop()
      cells.push(j)
      const x = j % SPAN
      const z = (j - x) / SPAN
      for (const [dx, dz] of N4) {
        const nx = x + dx
        const nz = z + dz
        if (!G.has(nx, nz)) continue
        const n = nz * SPAN + nx
        if (comp[n] >= 0 || !G.passable(x, z, nx, nz)) continue
        comp[n] = k
        stack.push(n)
      }
    }
    list.push(cells)
  }
  return { comp, list }
}

// Join every component to the network (the components of the seeds) with a
// service tunnel: a breadth-first search from the component through
// diggable ground to the nearest network cell, carved one cell wide (two
// where the ground allows, one tunnel in two). Returns the tunnels.
function connectAll(G, seeds, diggable, S, dice) {
  const { comp, list } = components(G)
  const net = new Uint8Array(NCELLS)
  const join = (cells) => {
    for (const i of cells) net[i] = 1
  }
  for (const [x, z] of seeds) {
    const k = comp[z * SPAN + x]
    if (k >= 0 && !net[list[k][0]]) join(list[k])
  }
  if (!seeds.some(([x, z]) => comp[z * SPAN + x] >= 0) && list.length) join(list.reduce((a, b) => (b.length > a.length ? b : a)))
  const tunnels = []
  const prev = new Int32Array(NCELLS)
  const seen = new Uint8Array(NCELLS)
  for (let k = 0; k < list.length; k++) {
    const cells = list[k]
    if (net[cells[0]]) continue
    // An edge from cell i (plan or dug) to n is open unless a wall is set.
    const openTo = (x, z, nx, nz) => {
      const e = Grid.between(x, z, nx, nz)
      const ex = G.explicit(e.axis, e.gx, e.gz)
      return !ex || !ex.wall
    }
    seen.fill(0)
    const queue = []
    for (const i of cells) {
      seen[i] = 1
      prev[i] = -1
      queue.push(i)
    }
    let hit = -1
    for (let q = 0; q < queue.length && hit < 0; q++) {
      const i = queue[q]
      const x = i % SPAN
      const z = (i - x) / SPAN
      const inComp = comp[i] === k
      for (const [dx, dz] of N4) {
        const nx = x + dx
        const nz = z + dz
        if (nx < 0 || nz < 0 || nx >= SPAN || nz >= SPAN) continue
        const n = nz * SPAN + nx
        if (seen[n]) continue
        if (net[n] && G.has(nx, nz) && (inComp ? G.passable(x, z, nx, nz) : openTo(x, z, nx, nz))) {
          hit = i
          break
        }
        if (!diggable(nx, nz) || !openTo(x, z, nx, nz)) continue
        seen[n] = 1
        prev[n] = i
        queue.push(n)
      }
    }
    if (hit < 0) continue
    // Carve the path back to the component.
    const id = S()
    const path = []
    for (let i = hit; i >= 0 && comp[i] !== k; i = prev[i]) path.push(i)
    const wide = path.length > 2 && dice.chance(0.5, 0xb00, k)
    const dug = []
    for (const i of path) {
      const x = i % SPAN
      const z = (i - x) / SPAN
      G.open(x, z, CELL_CORRIDOR, id)
      dug.push([x, z])
    }
    if (wide) {
      for (let p = 0; p < path.length; p++) {
        const i = path[p]
        const x = i % SPAN
        const z = (i - x) / SPAN
        const j = path[p + 1] ?? path[p - 1]
        const jx = j % SPAN
        const horiz = (j - jx) / SPAN === z
        const [wx, wz] = horiz ? [x, z + 1] : [x + 1, z]
        if (diggable(wx, wz)) {
          G.open(wx, wz, CELL_CORRIDOR, id)
          net[wz * SPAN + wx] = 1
        }
      }
    }
    for (const i of path) net[i] = 1
    join(cells)
    tunnels.push({ id, cells: dug })
    // Components the tunnel touched join with it.
    for (const [x, z] of dug) {
      for (const [dx, dz] of N4) {
        const nx = x + dx
        const nz = z + dz
        if (!G.has(nx, nz)) continue
        const c = comp[nz * SPAN + nx]
        if (c >= 0 && !net[list[c][0]] && G.passable(x, z, nx, nz)) join(list[c])
      }
    }
  }
  return tunnels
}

// Rooms in the leftover ground of the undercroft: 3×3..5×4 rects of
// diggable cells set against the network, each with its door on a network
// cell that is not a room. Plant rooms, pump rooms, archives, storage cages
// (rails on the sides that face open floor). Candidates are drawn from the
// network's edge cells in a salted order.
function placeUnderRooms(G, S, dice, diggable) {
  const kinds = ['plant', 'cage', 'archive', 'storage', 'cage', 'plant', 'laundry']
  const edges = []
  for (let z = 1; z < SPAN - 1; z++) {
    for (let x = 1; x < SPAN - 1; x++) {
      const i = z * SPAN + x
      if (!G.plan[i] || G.kind[i] === CELL_ROOM || G.block[i] !== 0) continue
      N4.forEach(([dx, dz], k) => {
        if (diggable(x + dx, z + dz)) edges.push([x, z, dx, dz, dice.d(0xc00, i * 4 + k)])
      })
    }
  }
  edges.sort((a, b) => a[4] - b[4])
  let n = 0
  for (let t = 0; t < edges.length && n < 14; t++) {
    const [ox, oz, dx, dz] = edges[t]
    if (!G.has(ox, oz) || G.block[oz * SPAN + ox] !== 0) continue
    const w = 3 + dice.pick(3, 0xc01, t)
    const d = 3 + dice.pick(2, 0xc02, t)
    const off = dice.pick(w, 0xc03, t)
    // The room runs d cells away from the door cell, w across it.
    const ax = dz !== 0 ? 1 : 0
    const az = dx !== 0 ? 1 : 0
    const c0 = [ox + dx - ax * off, oz + dz - az * off]
    const c1 = [c0[0] + ax * (w - 1) + dx * (d - 1), c0[1] + az * (w - 1) + dz * (d - 1)]
    const r = R(Math.min(c0[0], c1[0]), Math.min(c0[1], c1[1]), Math.max(c0[0], c1[0]), Math.max(c0[1], c1[1]))
    let free = true
    for (let z = r.z0 - 1; z <= r.z1 + 1 && free; z++) {
      for (let x = r.x0 - 1; x <= r.x1 + 1 && free; x++) {
        if (inRect(r, x, z)) free = diggable(x, z)
        else if (G.kind[z * SPAN + x] === CELL_ROOM && G.has(x, z)) free = false
      }
    }
    if (!free) continue
    const dx0 = ox + dx
    const dz0 = oz + dz
    const kind = kinds[dice.pick(kinds.length, 0xc05, t)]
    const id = S()
    const door = { ...Grid.between(dx0, dz0, ox, oz), passage: PASSAGE_DOOR }
    G.room(r, { spaceId: id, role: kind === 'cage' ? SPACE_ROLE_STORAGE : SHOP_TYPES[kind].role, doors: [door] })
    keepDoor(G, door)
    if (kind === 'cage') {
      // Chain-link sides where the cage faces open floor.
      for (const [x, z] of innerCellsOf(r)) {
        for (const [ddx, ddz] of N4) {
          const nx = x + ddx
          const nz = z + ddz
          if (inRect(r, nx, nz) || !G.has(nx, nz) || G.kind[nz * SPAN + nx] === CELL_ROOM || (nx === ox && nz === oz && x === dx0 && z === dz0)) continue
          const e = Grid.between(x, z, nx, nz)
          G.rail(e.axis, e.gx, e.gz)
        }
      }
    }
    const C = canon(frameOf(r, sideOf(-dx, -dz)))
    const F = C.F
    let ud = 0
    for (let u = 0; u < F.L; u++) {
      const [x, z] = C.at(u, F.D - 1)
      if (x === dx0 && z === dz0) ud = u
    }
    furnish(G, C, kind === 'cage' ? 'storage' : kind, { u0: 0, u1: F.L - 1, v0: 0, v1: F.D - 1, ud, space: id }, dice, 0xc10 + t)
    G.lamp(...C.at(Math.floor(F.L / 2), Math.floor(F.D / 2)), dice.chance(0.25, 0xc06, t), kind === 'cage' ? TUBE : WARM, { prio: 1 })
    n++
  }
  return n
}

// Back to mass: every plan cell that the seeds do not reach.
// §11.1 item 9 (≤ PROP_KIND_CAP distinct piece kinds per chunk), applied on
// the grid: a piece past the cap takes a kind its chunk already holds (a
// neutral one first), so the cap never unblocks a cell the drawing counted
// on (no piece dropped, no pocket opened).
const CAP_SWAP = Object.freeze([FURN_CABINET, FURN_PLANT, PROP_WHEELIE_BIN, FURN_CHAIR, FURN_RACK, FURN_COOLER])
function capKinds(G) {
  const kinds = new Map()
  for (const p of G.pieces) {
    if (!G.has(p.gx, p.gz)) continue
    const key = Math.floor(p.gx / CHUNK) * 8 + Math.floor(p.gz / CHUNK)
    let set = kinds.get(key)
    if (!set) kinds.set(key, (set = new Set()))
    if (!set.has(p.kind) && set.size >= PROP_KIND_CAP) p.kind = CAP_SWAP.find((k) => set.has(k)) ?? set.values().next().value
    set.add(p.kind)
  }
}

// A storey's last pass: a walkable pocket that hedges, kerbs, pieces and mass
// have boxed in — a component of walkable cells off the district's seams
// (on the lot, where the seams are open) holding no kept cell (a stair's
// halo, a door's outside, the spawn) or, given `seeds` (the upper storey),
// none of those cells (its stairs) — becomes mass, and a piece no walkable
// cell reaches goes with it: nothing is left where no one can walk.
function sealPockets(G, { seams = true, seeds = null } = {}) {
  const seedSet = seeds ? new Set(seeds.map(([x, z]) => z * SPAN + x)) : null
  const seen = new Uint8Array(NCELLS)
  let sealed = 0
  for (let i = 0; i < NCELLS; i++) {
    const x0 = i % SPAN
    const z0 = (i - x0) / SPAN
    if (seen[i] || !G.walk(x0, z0)) continue
    const cells = []
    const stack = [i]
    seen[i] = 1
    let open = false
    while (stack.length) {
      const j = stack.pop()
      const x = j % SPAN
      const z = (j - x) / SPAN
      cells.push([x, z])
      if ((seedSet ? seedSet.has(j) : G.kept(x, z)) || (seams && (x === 0 || z === 0 || x === SPAN - 1 || z === SPAN - 1))) open = true
      for (const [dx, dz] of N4) {
        const nx = x + dx
        const nz = z + dz
        if (!G.walk(nx, nz)) continue
        const n = nz * SPAN + nx
        if (seen[n] || !G.passable(x, z, nx, nz)) continue
        seen[n] = 1
        stack.push(n)
      }
    }
    if (open) continue
    // The pieces (and posts) round the pocket that no other walkable cell
    // reaches go with it.
    const orphans = []
    for (const [x, z] of cells) {
      for (const [dx, dz] of N4) {
        const [px, pz] = [x + dx, z + dz]
        if (!G.has(px, pz) || G.walk(px, pz) || !G.passable(x, z, px, pz)) continue
        if (!N4.some(([ex, ez]) => G.walk(px + ex, pz + ez) && !cells.some(([cx, cz]) => cx === px + ex && cz === pz + ez) && G.passable(px, pz, px + ex, pz + ez))) orphans.push([px, pz])
      }
    }
    for (const [x, z] of [...cells, ...orphans]) G.del(x, z)
    sealed += cells.length
  }
  if (!sealed) return 0
  G.pieces = G.pieces.filter((p) => G.has(p.gx, p.gz))
  G.lamps = G.lamps.filter((l) => G.has(l.gx, l.gz))
  return sealed
}

function pruneUnreached(G, seeds) {
  const reach = new Uint8Array(NCELLS)
  const stack = []
  for (const [x, z] of seeds) {
    if (!G.has(x, z)) continue
    const i = z * SPAN + x
    if (reach[i]) continue
    reach[i] = 1
    stack.push(i)
  }
  while (stack.length) {
    const j = stack.pop()
    const x = j % SPAN
    const z = (j - x) / SPAN
    for (const [dx, dz] of N4) {
      const nx = x + dx
      const nz = z + dz
      if (!G.has(nx, nz)) continue
      const n = nz * SPAN + nx
      if (reach[n] || !G.passable(x, z, nx, nz)) continue
      reach[n] = 1
      stack.push(n)
    }
  }
  let pruned = 0
  for (let i = 0; i < NCELLS; i++) {
    if (!G.plan[i] || reach[i]) continue
    const x = i % SPAN
    const z = (i - x) / SPAN
    G.del(x, z)
    G.pieces = G.pieces.filter((p) => p.gx !== x || p.gz !== z)
    pruned++
  }
  if (pruned) G.lamps = G.lamps.filter((l) => G.has(l.gx, l.gz))
  return pruned
}

// A deck below: piers on a seeded grid (the garage's B1 repeats the ground
// deck's grid), tube lamps on runs (mostly dead), rare vehicles nose-in
// along its walls, the odd cart.
function dressDeck(G, d, bp, dice) {
  const r = d.rect
  const g = d.kind === 'garage' ? bp.garage : null
  const piers = g ? pierCells(g) : (() => {
    const out = []
    const sx = 5 + dice.pick(3, d.salt, 1)
    const sz = 5 + dice.pick(3, d.salt, 2)
    for (let z = r.z0 + 1 + dice.pick(4, d.salt, 3); z <= r.z1 - 1; z += sz) for (let x = r.x0 + 1 + dice.pick(4, d.salt, 4); x <= r.x1 - 1; x += sx) out.push([x, z])
    return out
  })()
  for (const [x, z] of piers) if (G.has(x, z) && G.space[z * SPAN + x] === d.id && G.canBlock(x, z)) G.post(x, z)
  tubes(G, r, d.kind === 'garage' ? 0.35 : 0.25, dice, d.salt + 5, d.id)
  parkAlongWalls(G, garageSides(r), 0.03 + dice.pick(6, d.salt, 6) / 100, dice, d.salt + 7, d.id)
  if (dice.chance(0.4, d.salt, 8)) {
    const [x, z] = [r.x0 + dice.pick(Math.max(1, r.x1 - r.x0), d.salt, 9), r.z0 + dice.pick(Math.max(1, r.z1 - r.z0), d.salt, 10)]
    if (G.has(x, z) && G.space[z * SPAN + x] === d.id) G.put(x, z, PROP_CART, { facing: [FACING.S, FACING.E, FACING.N, FACING.W][dice.d(d.salt, 11) & 3] })
  }
}

// --- the upper storey (cy 1) -----------------------------------------------------------------

const rectsOverlap = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1

// The garage's roof deck over its rect: open to the sky behind a parapet
// (plain walls: the storey round the garage is footprint-solid, so no rail or
// glass may look out over it), the heads of the stair tower and the ramp
// flight (the cores, stamped after the compile), a lift-and-pay lobby in a
// corner, the vehicle ramp's housing on the spine below, sodium poles on
// breaker rows (the roof is the one place the lot's islands are seen from
// above), a few vehicles nose-in along the parapet, stray carts, bins and a
// bench.
function drawRoof(G, g, S, dice, { full = false } = {}) {
  // The roof slab steps in 0–3 cells per side (never past a core's halo,
  // which stays on the deck), and one or two corners of it may be cut back
  // 2–5 cells (plant enclosures on the deck below): no two roofs share an
  // outline.
  const halos = g.cores.map((c) => grow(c.rect, 1))
  const lim = [
    Math.min(...halos.map((h) => h.x0 - g.rect.x0)),
    Math.min(...halos.map((h) => h.z0 - g.rect.z0)),
    Math.min(...halos.map((h) => g.rect.x1 - h.x1)),
    Math.min(...halos.map((h) => g.rect.z1 - h.z1)),
  ]
  const e = (k) => Math.max(0, Math.min(lim[k], dice.pick(4, 0xe20, k)))
  const r = R(g.rect.x0 + e(0), g.rect.z0 + e(1), g.rect.x1 - e(2), g.rect.z1 - e(3))
  const id = S()
  G.rect(r, CELL_OPEN, id)
  for (const h of halos) G.keepRect(h)
  const nCuts = dice.chance(0.85, 0xe21) ? 1 + dice.pick(2, 0xe25) : 0
  const cuts = []
  for (let c = 0; c < nCuts; c++) {
    const w = 2 + dice.pick(4, 0xe22, c)
    const d = 2 + dice.pick(4, 0xe23, c)
    const k = (dice.pick(4, 0xe24) + c * 3) % 4
    const x0 = k & 1 ? r.x1 - w + 1 : r.x0
    const z0 = k & 2 ? r.z1 - d + 1 : r.z0
    const cut = R(x0, z0, x0 + w - 1, z0 + d - 1)
    if (!halos.some((h) => rectsOverlap(grow(h, 1), cut))) {
      G.delRect(cut)
      cuts.push(cut)
    }
  }
  const cx = (r.x0 + r.x1) / 2
  const cz = (r.z0 + r.z1) / 2
  // The lobby: 3×3 in a deck corner clear of the cores' halos; its door (and
  // glass beside it) on the side facing the deck.
  const corners = [[r.x0, r.z0], [r.x1 - 2, r.z0], [r.x0, r.z1 - 2], [r.x1 - 2, r.z1 - 2]]
  const k0 = dice.pick(4, 0xe00)
  let lobby = null
  for (let k = 0; k < 4 && !lobby; k++) {
    const [x0, z0] = corners[(k0 + k) % 4]
    const lr = R(x0, z0, x0 + 2, z0 + 2)
    if (!halos.some((h) => rectsOverlap(grow(h, 1), lr)) && !cuts.some((q) => rectsOverlap(grow(q, 1), lr))) lobby = lr
  }
  let rooms = 0
  if (lobby) {
    const east = lobby.x0 > cx
    const south = lobby.z0 > cz
    const doorSide = dice.d(0xe01) & 1 ? (east ? 'W' : 'E') : (south ? 'N' : 'S')
    const door = boothEdge(lobby, doorSide, 1)
    G.room(lobby, { spaceId: S(), role: SPACE_ROLE_LOUNGE, doors: [{ ...door, passage: PASSAGE_DOOR }] })
    keepDoor(G, door)
    for (const k of [0, 2]) {
      const e = boothEdge(lobby, doorSide, k)
      G.window(e.axis, e.gx, e.gz)
    }
    const inside = innerCellsOf(lobby).filter(([x, z]) => !G.kept(x, z))
    const back = BACK_SIDE[doorSide]
    const kinds = [FURN_COUNTER, FURN_CHAIR, FURN_PLANT]
    // The far cells first: the pay machine against the back wall.
    inside.sort((p, q) => dist2(q, lobbyDoorCell(door)) - dist2(p, lobbyDoorCell(door)))
    kinds.forEach((kind, i) => inside[i] && G.put(...inside[i], kind, i === 0 ? { wall: back } : { facing: FACE(doorSide) }))
    G.lamp(lobby.x0 + 1, lobby.z0 + 1, dice.chance(0.6, 0xe02), MODULE_WHITE, { prio: 2 })
    rooms++
  }
  // The vehicle ramp's housing: a two-cell-wide mass run on the spine line,
  // where the ramp from the ground deck comes up through the slab.
  const alongX = r.x1 - r.x0 >= r.z1 - r.z0
  const mid = alongX ? Math.floor((r.z0 + r.z1) / 2) + dice.pick(3, 0x209) - 1 : Math.floor((r.x0 + r.x1) / 2) + dice.pick(3, 0x209) - 1
  const [lo, hi] = alongX ? [r.x0 + 3, r.x1 - 3] : [r.z0 + 3, r.z1 - 3]
  const len = Math.min(hi - lo + 1, 5 + dice.pick(4, 0xe03))
  if (len >= 4) {
    const a0 = lo + dice.pick(hi - lo - len + 2, 0xe04)
    for (let a = a0; a < a0 + len; a++) {
      for (const w of [0, 1]) {
        const [x, z] = alongX ? [a, mid + w] : [mid + w, a]
        if (G.has(x, z) && G.space[z * SPAN + x] === id && G.canBlock(x, z)) G.del(x, z)
      }
    }
  }
  // The roof's own program (hashed per garage): a light well open to the
  // deck below (mass on this storey), guard rails between the parking rows,
  // or a solar canopy's column grid over one half of the deck.
  const program = dice.pick(4, 0xe30)
  const lobbyHalo = lobby ? grow(lobby, 1) : null
  const free = (x, z) => G.has(x, z) && G.space[z * SPAN + x] === id && !G.kept(x, z) && !(lobbyHalo && inRect(lobbyHalo, x, z))
  const block = (x, z) => free(x, z) && G.canBlock(x, z) && !G.explicitAround(x, z) && (G.del(x, z), true)
  if (program === 0 || program === 3) {
    const n = 1
    for (let k = 0; k < n; k++) {
      const w = 3 + dice.pick(3, 0xe32, k)
      const d = 3 + dice.pick(4, 0xe33, k)
      const x0 = r.x0 + 2 + dice.pick(Math.max(1, r.x1 - r.x0 - w - 3), 0xe34, k)
      const z0 = r.z0 + 2 + dice.pick(Math.max(1, r.z1 - r.z0 - d - 3), 0xe35, k)
      for (let z = z0; z < z0 + d; z++) for (let x = x0; x < x0 + w; x++) block(x, z)
    }
  }
  if (program === 1 || program === 3) {
    // Guard rails between the parking rows: runs of 3–6 cells with a gap.
    const horiz = r.x1 - r.x0 >= r.z1 - r.z0
    const [lo, hi] = horiz ? [r.z0 + 2, r.z1 - 2] : [r.x0 + 2, r.x1 - 2]
    const pitch = 4 + dice.pick(3, 0xe36)
    for (let line = lo + dice.pick(pitch, 0xe37); line <= hi; line += pitch) {
      const run = 3 + dice.pick(4, 0xe38, line)
      const [a0, a1] = horiz ? [r.x0 + 2, r.x1 - 2] : [r.z0 + 2, r.z1 - 2]
      for (let a = a0 + dice.pick(3, 0xe39, line); a <= a1; a += run + 2) {
        for (let t = a; t < Math.min(a1 + 1, a + run); t++) {
          const [x, z] = horiz ? [t, line] : [line, t]
          const [nx, nz] = horiz ? [t, line + 1] : [line + 1, t]
          if (!free(x, z) || !free(nx, nz)) continue
          const e = Grid.between(x, z, nx, nz)
          if (!G.explicit(e.axis, e.gx, e.gz)) G.rail(e.axis, e.gx, e.gz)
        }
      }
    }
  }
  if (program === 2) {
    const pitch = 3 + dice.pick(2, 0xe3a)
    const half = dice.d(0xe3b) & 1
    const xm = Math.floor((r.x0 + r.x1) / 2)
    for (let z = r.z0 + 2; z <= r.z1 - 2; z += pitch) {
      for (let x = half ? r.x0 + 2 : xm; x <= (half ? xm : r.x1 - 2); x += pitch) if (free(x, z)) G.post(x, z)
    }
  }
  // Poles: a grid of posts 7–9 cells apart, two to four sodium heads each;
  // every grid row is one breaker, about half of them dead, never all.
  const step = 7 + dice.pick(3, 0xe05)
  const poles = []
  let row = 0
  for (let z = r.z0 + 3 + dice.pick(2, 0xe06); z <= r.z1 - 3; z += step, row++) {
    for (let x = r.x0 + 3 + dice.pick(2, 0xe07); x <= r.x1 - 3; x += step) {
      if (G.kept(x, z) || !G.has(x, z) || G.space[z * SPAN + x] !== id || !G.post(x, z)) continue
      const q = dice.d(0xe08, x * 64 + z)
      const lamps = poleArms([2, 2, 3, 4][q % 4], (q >>> 4) & 3).map(([dx, dz]) => G.lamp(x + dx, z + dz, false, SODIUM, { prio: 3 })).filter(Boolean)
      poles.push({ row, lamps })
    }
  }
  const rows = [...new Set(poles.map((p) => p.row))]
  const live = new Set(rows.filter((rw) => !dice.chance(0.5, 0xe09, rw)))
  if (!live.size && rows.length) live.add(rows[dice.pick(rows.length, 0xe0a)])
  for (const p of poles) for (const l of p.lamps) l.lit = live.has(p.row)
  // Vehicles along the parapet (rare), carts, a bench and bins by the lobby.
  const cars = parkAlongWalls(G, garageSides(r), full ? 1 : 0.03 + dice.pick(6, 0xe10) / 100, dice, 0xe11, id, full ? PROP_CART : PROP_DUMPSTER)
  const strays = 1 + dice.pick(3, 0xe12)
  for (let i = 0, placed = 0; i < 12 && placed < strays; i++) {
    const x = r.x0 + 2 + dice.pick(Math.max(1, r.x1 - r.x0 - 3), 0xe13, i)
    const z = r.z0 + 2 + dice.pick(Math.max(1, r.z1 - r.z0 - 3), 0xe14, i)
    if (G.space[z * SPAN + x] === id && G.put(x, z, PROP_CART, { facing: [FACING.S, FACING.E, FACING.N, FACING.W][dice.d(0xe15, i) & 3] })) placed++
  }
  if (lobby) {
    const ring = [[lobby.x0 - 1, lobby.z0], [lobby.x1 + 1, lobby.z1], [lobby.x0, lobby.z1 + 1], [lobby.x1, lobby.z0 - 1]]
    let bins = 0
    for (const [x, z] of ring) if (bins < 2 && G.space[z * SPAN + x] === id && G.put(x, z, bins ? PROP_BENCH : PROP_WHEELIE_BIN)) bins++
  }
  return { rooms, cars, poles: poles.length, lit: poles.filter((p) => live.has(p.row)).length }
}

const BACK_SIDE = Object.freeze({ N: 'S', S: 'N', E: 'W', W: 'E' })
const dist2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2
// The inner cell of a booth/lobby door edge (the cell on the room side is
// either neighbour; the distance sort only needs the door's position).
const lobbyDoorCell = (e) => (e.axis === 'v' ? [e.gx - 0.5, e.gz] : [e.gx, e.gz - 0.5])

// A frontage block's upper floor (cy 1), reached by its stair hall.
//   motel    rooms the depth of the block — a bed, a nightstand, a wardrobe,
//            a TV, a bathroom — each with its door and a window on an open
//            walkway over the shop walk; the stair hall's landing opens onto
//            the walkway, an ice machine at one end
//   offices  a corridor in front of the stair hall's door; offices, archives,
//            a break room and the odd restroom on both sides of it
// No glass looks out: the storey round the block is footprint-solid.
function drawUpper(G, b, S, dice, ctx) {
  const F = frameOf(b.rect, b.front, b.mirror)
  const C = canon(F)
  const a = b.alley
  const D = b.D
  const front = a + D - 1
  const walkV = a + D
  const salt = 0xd00 + b.n * 0x80
  const rnd = ctx.dejaVu ? (k) => detail(0x0de7a, 0, 0, 0x9f0 + k) : (k) => dice.d(salt + 1, k)
  const core = b.core
  const hall = [core.u, core.u + 5]
  // The floor's span along the block (stepped back from the ends).
  const [t0, t1] = b.upTrim ?? [0, 0]
  const U0 = t0
  const U1 = F.L - 1 - t1
  const span = (minW, maxW, withHall, salt) => splitUnits(U1 - U0 + 1, withHall ? [hall[0] - U0, hall[1] - U0] : null, minW, maxW, (k) => rnd(salt + k))
    .map((x) => ({ ...x, u0: x.u0 + U0, u1: x.u1 + U0 }))
  let rooms = 0
  let lit = 0
  if (b.sub === 'motel') {
    const walk = S()
    for (let u = U0; u <= U1; u++) G.open(...C.at(u, walkV), CELL_CORRIDOR, walk)
    const [mw, xw] = [[3, 4], [3, 5], [4, 5], [3, 4], [4, 6]][rnd(690) % 5]
    const units = span(mw, xw, true, 700)
    units.forEach((unit, k) => {
      const { u0, u1 } = unit
      const w = u1 - u0 + 1
      const id = S()
      const ud = unit.hall ? u0 + 2 + (rnd(710 + k) & 1) : u0 + Math.floor((w - 1) / 2) + (w > 3 && rnd(720 + k) & 1 ? 1 : 0)
      const door = C.edgeUV(ud, front, 0, 1)
      // Stepped massing: a room may stop 1–2 rows short of the back (the
      // roof of the room below shows there: solid on this storey).
      const sb = unit.hall ? 0 : Math.min(MOTEL_STEP[rnd(760 + k) % MOTEL_STEP.length], front - a - 4)
      const va = a + sb
      G.room(F.rectUV(u0, va, u1, front), { spaceId: id, role: unit.hall ? SPACE_ROLE_LOUNGE : SPACE_ROLE_BEDROOM, doors: [{ ...door, passage: PASSAGE_DOOR }] })
      keepDoor(G, door)
      rooms++
      if (unit.hall) {
        G.keepRect(grow(core.rect, 1))
      } else {
        for (const u of [ud - 1, ud + 1]) {
          if (u < u0 || u > u1) continue
          const e = C.edgeUV(u, front, 0, 1)
          G.window(e.axis, e.gx, e.gz)
        }
        const side = ud - u0 <= u1 - ud ? 'right' : 'left'
        if (front - va >= 4 && w >= 3 && restroom(G, C, { u0, u1, v0: va, ud, side }, S)) rooms++
        furnish(G, C, 'motel', { u0, u1, v0: va, v1: front, ud, space: id }, dice, salt + 0x40 + k)
      }
      const on = unit.hall || rnd(730 + k) % 100 < 22
      if (on) lit++
      G.lamp(...C.at(u0 + Math.floor(w / 2), Math.floor((va + front) / 2)), on, WARM, { prio: 1 })
      G.lamp(...C.at(ud, walkV), unit.hall || rnd(740 + k) % 100 < 45, MODULE_WHITE, { prio: 2 })
    })
    // The walkway: the ice machine at one end.
    G.put(...C.at(rnd(750) & 1 ? U0 : U1, walkV), FURN_COOLER, { wall: C.wallOf.front })
    return { rooms, lit, units: units.length }
  }
  // Offices: the corridor (row a + 4, in front of the stair hall's door) and
  // the hall's rows behind it (the core, carved by the kit).
  const vc = a + 4
  const corr = S()
  for (let u = U0; u <= U1; u++) G.open(...C.at(u, vc), CELL_CORRIDOR, corr)
  for (let u = hall[0]; u <= hall[1]; u++) for (let v = a; v < vc; v++) G.open(...C.at(u, v), CELL_LOBBY, corr)
  G.keepRect(grow(core.rect, 1))
  const types = ['office', 'office', 'archive', 'furniture', 'office', 'storage', 'diner']
  const bands = [[a, vc - 1, -1], [vc + 1, front, 1]]
  let wc = false
  bands.forEach(([b0, b1, dir], bi) => {
    if (b1 - b0 < 1) return
    const units = span(...OFFICE_WIDTHS[(rnd(755) + bi) % OFFICE_WIDTHS.length], bi === 0, 760 + bi * 32)
    // An open-plan band (p 0.4): one room per run of units, desks on a
    // hashed grid, files along the outer wall, a copier, tubes overhead.
    if (b1 - b0 >= 3 && rnd(850 + bi) % 5 < 2) {
      const runs = []
      for (const unit of units) {
        if (unit.hall) runs.push(null)
        else if (runs.length && runs[runs.length - 1]) runs[runs.length - 1].u1 = unit.u1
        else runs.push({ u0: unit.u0, u1: unit.u1 })
      }
      const pu = 2 + (rnd(860 + bi) % 2)
      const pv = 2 + (rnd(861 + bi) % 2)
      runs.filter(Boolean).forEach(({ u0, u1 }, k) => {
        if (u1 - u0 < 3) return
        const id = S()
        const [v0, v1] = [b0, b1]
        const doorV = dir < 0 ? v1 : v0
        const doors = [u0 + 1 + (rnd(862 + k) % Math.max(1, u1 - u0 - 1))]
        if (u1 - u0 >= 9) doors.push(doors[0] > (u0 + u1) / 2 ? u0 + 1 : u1 - 1)
        const de = doors.map((ud) => ({ ...C.edgeUV(ud, doorV, 0, -dir), passage: PASSAGE_DOOR }))
        G.room(F.rectUV(u0, v0, u1, v1), { spaceId: id, role: SPACE_ROLE_OFFICE, doors: de })
        for (const d of de) keepDoor(G, d)
        rooms++
        const outer = dir < 0 ? v0 : v1
        const inner = dir < 0 ? v1 : v0
        const free = (u, v) => !doors.some((ud) => ud === u && (v === inner || v === inner + dir))
        for (let u = u0; u <= u1; u += 2) if (free(u, outer)) G.put(...C.at(u, outer), FURN_CABINET, { wall: dir < 0 ? C.wallOf.back : C.wallOf.front })
        const ph = rnd(863 + k) % pu
        for (let v = Math.min(v0, v1) + 1; v <= Math.max(v0, v1) - 1; v += pv) {
          if (v === outer || v === inner) continue
          for (let u = u0 + 1 + ph; u <= u1 - 1; u += pu) if (free(u, v)) G.put(...C.at(u, v), (u + v + k) % 7 === 0 ? FURN_COPIER : FURN_DESK, { facing: FACE(C.wallOf.front) })
        }
        const on = rnd(864 + k) % 100 < 30
        if (on) lit++
        for (let u = u0 + 1; u <= u1; u += 4) G.lamp(...C.at(u, Math.floor((v0 + v1) / 2)), on, TUBE, { prio: 1 })
      })
      return
    }
    units.forEach((unit, k) => {
      if (unit.hall) return
      const { u0, u1 } = unit
      const ud = u0 + Math.floor((u1 - u0) / 2)
      // Stepped massing: an office may stop a row short of the outer wall.
      const cut = rnd(770 + bi * 32 + k) % 3 === 0 && b1 - b0 >= 3 ? 1 : 0
      const [v0, v1] = dir < 0 ? [b0 + cut, b1] : [b0, b1 - cut]
      const doorV = dir < 0 ? v1 : v0
      const id = S()
      const door = C.edgeUV(ud, doorV, 0, -dir)
      const type = types[rnd(780 + bi * 32 + k) % types.length]
      G.room(F.rectUV(u0, v0, u1, v1), { spaceId: id, role: SHOP_TYPES[type].role, doors: [{ ...door, passage: PASSAGE_DOOR }] })
      keepDoor(G, door)
      rooms++
      const Cr = dir < 0 ? C : canonFlip(C, v0 + v1)
      if (!wc && v1 - v0 >= 3 && u1 - u0 >= 3 && restroom(G, Cr, { u0, u1, v0, ud, side: rnd(790 + k) & 1 ? 'left' : 'right' }, S)) {
        wc = true
        rooms++
      }
      furnish(G, Cr, type, { u0, u1, v0, v1, ud, space: id }, dice, salt + 0x60 + bi * 32 + k)
      const on = rnd(800 + bi * 32 + k) % 100 < 25
      if (on) lit++
      G.lamp(...C.at(ud, Math.floor((v0 + v1) / 2)), on, WARM, { prio: 1 })
    })
  })
  for (let u = U0 + 1; u < U1; u += 5) G.lamp(...C.at(u, vc), rnd(820 + u) % 100 < 40, TUBE, { prio: 1 })
  G.put(...C.at(rnd(830) & 1 ? U0 : U1, vc), FURN_PLANT)
  return { rooms, lit, units: rooms }
}

const MOTEL_STEP = Object.freeze([0, 0, 1, 2, 1, 0, 2])
const OFFICE_WIDTHS = Object.freeze([[4, 6], [3, 5], [5, 7], [4, 8], [3, 4]])

// A strip mall's or a big box's roof (cy 1), reached through the bulkhead
// over its stair hall: a flat roof behind its parapet (the wall against the
// solid storey round it). One of three hashed programs dresses it —
//   units      rooftop-unit housings (mass) on a hashed lattice, condensers
//              beside them, vent stacks
//   skylights  rows of skylight curbs (mass) every few rows, staggered, a
//              few condensers
//   clutter    vent stacks, condensers, cable racks and bins scattered
// — and on a strip mall, the low parapets between the shops' roofs (rails
// with a gap); one or two roof floods, mostly dead; on a big box, a
// billboard's catwalk rail and its lamp, lit for no one.
const ROOF_PROGRAMS = Object.freeze(['units', 'skylights', 'clutter'])
function drawRooftop(G, b, S, dice) {
  const F = frameOf(b.rect, b.front, b.mirror)
  const C = canon(F)
  const body = roofBody(b)
  const [U0, U1, v0, v1] = roofSpan(b)
  const L = F.L
  const salt = 0xe00 + b.n * 0x80
  const rnd = (k) => dice.d(salt + 1, k)
  G.rect(body, CELL_OPEN, S())
  G.keepRect(grow(b.core.rect, 1))
  G.keep(...b.core.door.outside)
  const mass = (u, v) => {
    const [x, z] = C.at(u, v)
    if (u < U0 || u > U1 || v < v0 || v > v1 || !G.canBlock(x, z) || G.explicitAround(x, z)) return false
    G.del(x, z)
    return true
  }
  const put = (u, v, kind) => G.put(...C.at(u, v), kind, { facing: FACE(C.wallOf.front) })
  // Shop parapets first (their gap cells kept clear of the dressing).
  if (b.kind === 'strip') {
    for (let u = 3 + (rnd(1) % 4); u < L - 3; u += 4 + (rnd(2 + u) % 4)) {
      if (rnd(3 + u) % 3 === 0) continue
      const gap = v0 + (rnd(4 + u) % (v1 - v0 + 1))
      for (let v = v0; v <= v1; v++) {
        if (Math.abs(v - gap) <= (rnd(5 + u) & 1)) {
          G.keep(...C.at(u, v))
          G.keep(...C.at(u - 1, v))
          continue
        }
        const [ax, az] = C.at(u - 1, v)
        const [bx, bz] = C.at(u, v)
        if (G.kept(ax, az) || G.kept(bx, bz)) continue
        const e = Grid.between(ax, az, bx, bz)
        if (!G.explicit(e.axis, e.gx, e.gz)) G.rail(e.axis, e.gx, e.gz)
      }
    }
  }
  const program = ROOF_PROGRAMS[rnd(10) % ROOF_PROGRAMS.length]
  let pieces = 0
  if (program === 'units') {
    const pu = 5 + (rnd(11) % 4)
    const pv = 3 + (rnd(12) % 3)
    const [hw, hd] = [[2, 2], [3, 2], [2, 1], [3, 1]][rnd(13) % 4]
    for (let v = v0 + 1 + (rnd(14) % 2); v + hd - 1 < v1; v += pv) {
      for (let u = 1 + (rnd(15 + v) % pu); u + hw - 1 < L - 1; u += pu) {
        for (let dv = 0; dv < hd; dv++) for (let du = 0; du < hw; du++) mass(u + du, v + dv)
        if (put(u + hw, v, FURN_COOLER)) pieces++
      }
    }
    for (let k = 0; k < 2 + (rnd(16) % 4); k++) mass(1 + (rnd(17 + k) % Math.max(1, L - 2)), v0 + (rnd(18 + k) % (v1 - v0 + 1)))
  } else if (program === 'skylights') {
    const len = 2 + (rnd(20) % 3)
    const gapU = 2 + (rnd(21) % 2)
    let row = 0
    for (let v = v0 + 1 + (rnd(22) % 2); v < v1; v += 2 + (rnd(23) % 2), row++) {
      for (let u = 1 + ((row & 1) ? Math.floor((len + gapU) / 2) : 0); u + len - 1 < L - 1; u += len + gapU) {
        for (let du = 0; du < len; du++) mass(u + du, v)
      }
    }
    for (let k = 0; k < 2 + (rnd(24) % 3); k++) if (put(1 + (rnd(25 + k) % Math.max(1, L - 2)), v0 + (rnd(26 + k) % (v1 - v0 + 1)), FURN_COOLER)) pieces++
  } else {
    const n = Math.floor((L * (v1 - v0 + 1)) / 14)
    const kinds = [FURN_COOLER, FURN_COOLER, FURN_RACK, PROP_WHEELIE_BIN, FURN_CABINET]
    for (let k = 0; k < n; k++) {
      const u = rnd(30 + k) % L
      const v = v0 + (rnd(31 + k) % (v1 - v0 + 1))
      if (rnd(32 + k) % 3 === 0) {
        const [x, z] = C.at(u, v)
        G.post(x, z)
      } else if (put(u, v, kinds[rnd(33 + k) % kinds.length])) pieces++
    }
  }
  // Roof floods on the parapet, mostly dead.
  let lit = 0
  for (let k = 0; k < 1 + (rnd(40) % 2); k++) {
    const on = rnd(41 + k) % 10 < 3
    if (G.lamp(...C.at(1 + (rnd(42 + k) % Math.max(1, L - 2)), k ? v1 : v0), on, rnd(43 + k) & 1 ? SODIUM : MODULE_WHITE, { prio: 1 })?.lit) lit++
  }
  // A big box's billboard: a catwalk rail along its back, posts at its ends,
  // a lamp in front of it.
  if (b.kind === 'bigbox' && rnd(50) % 10 < 6) {
    const bl = 6 + (rnd(51) % 3)
    const bu = 1 + (rnd(52) % Math.max(1, L - bl - 2))
    for (let u = bu; u < bu + bl; u++) {
      const [ax, az] = C.at(u, v0)
      const [bx, bz] = C.at(u, v0 + 1)
      if (G.kept(ax, az) || G.kept(bx, bz) || !G.walk(ax, az) || !G.walk(bx, bz)) continue
      const e = Grid.between(ax, az, bx, bz)
      if (!G.explicit(e.axis, e.gx, e.gz)) G.rail(e.axis, e.gx, e.gz)
    }
    G.post(...C.at(bu, v0))
    G.post(...C.at(bu + bl - 1, v0))
    if (G.lamp(...C.at(bu + (bl >> 1), v0 + 1), rnd(53) % 10 < 7, MODULE_WHITE, { prio: 2 })?.lit) lit++
  }
  return { program, pieces, lit }
}

// --- lights: circuits, the next-island rule, anomalies, the floor, the cap ----------------

// A district keeps at least LIT_FLOOR lit lamps per chunk on the lot.
const LIT_FLOOR = 3.4 * 16

function lightPoles(G0, poles, dice, anomaly, notes) {
  const island = poles.filter((p) => p.kind === 'island')
  const circuits = [...new Set(island.map((p) => p.circuit))]
  const order = circuits.map((c, i) => [dice.d(0x800, i), c]).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)).map(([, c]) => c)
  const frac = 0.4 + dice.pick(21, 0x801) / 100
  let nDead = Math.round(order.length * frac)
  if (anomaly === 'dead-cluster') nDead = order.length
  if (anomaly === 'burning-pole') nDead = Math.max(nDead, Math.min(order.length, 1))
  const dead = new Set(order.slice(0, nDead))
  const apply = () => {
    for (const p of island) p.lit = !dead.has(p.circuit)
  }
  apply()
  // The next-island rule (doc §4.4): every lit island pole sees a lit lamp of
  // another circuit (an island, a street pole, a lit building) within
  // NEXT_ISLAND cells, lamp to lamp; a violation relights the nearest dead
  // circuit, in a deterministic order. A dead cluster keeps its darkness.
  const lampLit = (l) => {
    const p = l.pole
    return p ? p.lit : l.lit
  }
  for (const p of poles) for (const l of p.lamps) l.pole = p
  const near = (p) => G0.lamps.some((l) => lampLit(l) && l.pole?.circuit !== p.circuit &&
    p.lamps.some((m) => Math.hypot(l.gx - m.gx, l.gz - m.gz) <= NEXT_ISLAND))
  let repaired = 0
  const span = (p, q) => Math.min(...p.lamps.flatMap((l) => q.lamps.map((m) => Math.hypot(l.gx - m.gx, l.gz - m.gz))))
  const repair = () => {
    for (let guard = 0; guard < 24 && anomaly !== 'dead-cluster'; guard++) {
      const lonely = island.find((p) => p.lit && !near(p))
      if (!lonely) break
      const dist = (c) => Math.min(...island.filter((q) => q.circuit === c).map((q) => span(q, lonely)))
      const cands = [...dead].map((c) => [dist(c), c]).filter(([dd]) => Number.isFinite(dd)).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1))
      if (!cands.length) break
      dead.delete(cands[0][1])
      apply()
      repaired++
    }
  }
  repair()
  // The district's floor: while the lot burns fewer than LIT_FLOOR lamps,
  // the dead circuits come back in their salted order (a dead cluster stays
  // dark: its darkness is the anomaly).
  const litCount = () => {
    const per = new Map()
    for (const l of G0.lamps) {
      if (!lampLit(l)) continue
      const key = Math.floor(l.gx / CHUNK) * 8 + Math.floor(l.gz / CHUNK)
      per.set(key, (per.get(key) ?? 0) + 1)
    }
    let n = 0
    for (const v of per.values()) n += Math.min(12, v)
    return n
  }
  let floor = 0
  if (anomaly !== 'dead-cluster') {
    for (const c of order) {
      if (litCount() >= LIT_FLOOR) break
      if (!dead.has(c)) continue
      dead.delete(c)
      apply()
      floor++
    }
    // Still short (few islands): the dead street heads come back, in their
    // salted order.
    const deadStreet = poles.filter((p) => p.kind === 'street' && !p.lit && p.lamps.length)
      .map((p, i) => [dice.d(0x807, i), p]).sort((a, b) => a[0] - b[0]).map(([, p]) => p)
    for (const p of deadStreet) {
      if (litCount() >= LIT_FLOOR) break
      p.lit = true
      floor++
    }
  }
  // Street poles keep the rule too: a lit head with no lit lamp in reach
  // relights the nearest dead street head (one breaker run bridges the gap).
  const street = poles.filter((p) => p.kind === 'street' && p.lamps.length)
  for (let guard = 0; guard < 12; guard++) {
    const lonely = street.find((p) => p.lit && !near(p) && !G0.lamps.some((l) => lampLit(l) && l.pole !== p && p.lamps.some((m) => Math.hypot(l.gx - m.gx, l.gz - m.gz) <= NEXT_ISLAND)))
    if (!lonely) break
    const cand = street.filter((q) => !q.lit).sort((a, b) => span(a, lonely) - span(b, lonely))[0]
    if (!cand) {
      lonely.lit = false
      continue
    }
    cand.lit = true
    repaired++
  }
  repair()
  // Tints: sodium heads; a cold mercury retrofit on one lit circuit in three;
  // the odd-sodium anomaly turns every lit island cold but one pole.
  const litCircuits = order.filter((c) => !dead.has(c)).sort()
  let cold = null
  if (litCircuits.length >= 2 && dice.chance(0.35, 0x802)) cold = litCircuits[dice.pick(litCircuits.length, 0x803)]
  for (const p of island) p.tint = p.circuit === cold ? MERCURY : SODIUM
  if (anomaly === 'odd-sodium') {
    const litPoles = island.filter((p) => p.lit)
    litPoles.forEach((p) => {
      p.tint = MERCURY
    })
    if (litPoles.length) {
      litPoles[dice.pick(litPoles.length, 0x804)].tint = SODIUM
      notes.push('anomaly: one sodium pole burns in an LED sector')
    }
  }
  if (anomaly === 'burning-pole') {
    const off = island.filter((p) => !p.lit)
    if (off.length) {
      const burning = off[dice.pick(off.length, 0x805)]
      burning.lit = true
      burning.tint = MERCURY
      burning.prio = 4
      // A lone cart in its pool.
      const [px, pz] = burning.post
      for (const [dx, dz] of [[2, 1], [-2, 1], [2, -1], [-2, -1], [1, 2], [-1, -2]]) {
        if (G0.put(px + dx, pz + dz, PROP_CART, { facing: [FACING.S, FACING.E, FACING.N, FACING.W][dice.d(0x806) & 3] })) break
      }
      notes.push('anomaly: one mercury pole burns in a dead circuit, a lone cart in its pool')
    }
  }
  for (const p of poles) {
    for (const l of p.lamps) {
      l.lit = p.lit
      if (p.kind === 'island') l.tint = p.tint
      l.prio = p.prio ?? (p.kind === 'island' ? 3 : 2)
      delete l.pole
    }
  }
  const lit = island.filter((p) => p.lit).length
  notes.push(`${lit}/${island.length} island poles lit on ${circuits.length - dead.size}/${circuits.length} circuits${repaired ? ` (${repaired} relit by the next-island rule)` : ''}${floor ? ` (${floor} by the district floor)` : ''}${cold ? ' · a mercury retrofit' : ''}`)
}

// §11.1 item 9: at most 12 lit lamps per chunk-storey: the lowest priority
// (and then the last placed) go dark first.
function capLamps(G, cap = 12) {
  const byChunk = new Map()
  for (const l of G.lamps) {
    if (!l.lit) continue
    const key = Math.floor(l.gx / CHUNK) * 8 + Math.floor(l.gz / CHUNK)
    if (!byChunk.has(key)) byChunk.set(key, [])
    byChunk.get(key).push(l)
  }
  for (const list of byChunk.values()) {
    if (list.length <= cap) continue
    const order = list.map((l, i) => [l, i]).sort((a, b) => a[0].prio - b[0].prio || b[1] - a[1])
    for (let k = 0; k < list.length - cap; k++) order[k][0].lit = false
  }
}

// --- the district bake ----------------------------------------------------------------------

function buildNightLotDistrict(map, ctx) {
  const seed = ctx.worldSeed >>> 0
  const { tx, tz } = ctx.key
  const bp = blueprint(seed, tx, tz)
  const anomaly = anomalyAt(seed, tx, tz)
  const dice = diceOf(seed, tx, tz)
  const notes = [`${bp.mode === 'field' ? 'lot field' : 'mixed block'}`]
  let nextId = 1
  const S = () => nextId++
  const G0 = new Grid(DECK)
  const GU = new Grid(BASEMENT)
  const G1 = new Grid(UP)
  const poles = []

  // The roads, then every element of the blueprint.
  const roadIds = drawRoads(G0, bp, S, dice, poles)
  const walkIds = new Set([roadIds.walkN, roadIds.walkW, roadIds.vergeE, roadIds.vergeS])
  const home = tx === 0 && tz === 0
  if (home) {
    for (const c of bp.spawn) {
      G0.keep(c.gx, c.gz)
      for (const [dx, dz] of RING8) G0.keep(c.gx + dx, c.gz + dz)
    }
  }
  // The full-lot anomaly fills every lot's stalls, or the garage's ground
  // deck in a district without lots.
  const fullGarage = anomaly === 'full-lot' && !bp.lots.length && !!bp.garage
  let rooms = 0
  if (bp.garage) {
    const garage = drawGarage(G0, bp.garage, S, dice, { full: fullGarage })
    if (fullGarage) notes.push(`anomaly: every bay of the garage's ground deck holds the same vehicle (${garage.cars} vehicles)`)
    rooms += garage.rooms
    const roof = drawRoof(G1, bp.garage, S, dice, { full: fullGarage })
    rooms += roof.rooms
    notes.push(`garage ${bp.garage.chunks.w}×${bp.garage.chunks.h} chunks, B1, ground deck and roof deck, ${bp.garage.cores.length} cores, ${garage.cars + roof.cars} vehicles, ${roof.lit}/${roof.poles} roof poles lit`)
  }
  let kiosk = null
  if (bp.kiosk) {
    const T = kioskFrame(bp.kiosk)
    const stair = kioskStair(T)
    if (stair.error) return { error: stair.error }
    drawKioskDeck(G0, T, stair, S())
    kiosk = { m: bp.kiosk, T, stair }
    notes.push(`kiosk with a basement in chunk ${bp.kiosk.lcx},${bp.kiosk.lcz}`)
  }
  const blockCtx = { dejaVu: anomaly === 'deja-vu' }
  for (const b of bp.blocks) {
    const res = drawBlock(G0, b, S, dice, blockCtx)
    rooms += res.rooms
    notes.push(`${b.sub} facing ${b.front}: ${res.units} units, ${res.lit} lit`)
    if (b.upper) {
      const up = drawUpper(G1, b, S, dice, blockCtx)
      rooms += up.rooms
      notes.push(`  upper floor: ${up.rooms} rooms, ${up.lit} lit`)
    } else if (b.roof) {
      const top = drawRooftop(G1, b, S, dice)
      notes.push(`  roof (${top.program}): ${top.pieces} pieces, ${top.lit} floods lit`)
    }
  }
  if (blockCtx.dejaVu) notes.push('anomaly: the frontage repeats (the same fronts, lit the same way, as every deja-vu district)')
  for (const bo of bp.booths) rooms += drawBooth(G0, bo, S, dice).rooms
  drawApron(G0, bp, dice, poles)
  bp.lots.forEach((lot, k) => {
    const res = drawLot(G0, lot, S, dice, poles, { full: anomaly === 'full-lot', walkIds })
    if (anomaly === 'full-lot') notes.push(`anomaly: every stall of lot ${k} holds the same vehicle but one, empty and lit (${res.cars} vehicles)`)
  })
  drawVerges(G0, bp, dice)
  const sealed = sealPockets(G0)
  if (sealed) notes.push(`${sealed} pocket cells sealed`)
  lightPoles(G0, poles, dice, anomaly, notes)
  capLamps(G0)

  // The undercroft below.
  const under = drawUnder(GU, bp, S, dice, { kiosk, seed, tx, tz, closed: ctx.mode !== 'tile' })
  capLamps(GU)
  notes.push(`undercroft: ${under.decks} decks, ${under.suites} suite rooms, ${under.extras} service rooms, ${under.tunnels} tunnels, ${under.ports} underpasses`)

  // The upper storey: clipped to its footprint (a body's slivers in chunks
  // that stay solid up there are ground floor only), whatever its stairs do
  // not reach goes back to mass, then the cap.
  for (let i = 0; i < NCELLS; i++) {
    if (!G1.plan[i]) continue
    const x = i % SPAN
    const z = (i - x) / SPAN
    if (!upperAllowed(bp.upMask, x, z)) G1.del(x, z)
  }
  const upCores = bp.cores.filter((c) => c.topCy === UP_CY)
  pruneUnreached(G1, upCores.flatMap((c) => (c.enclosed ? [c.door.outside] : [[c.rect.x0, c.rect.z0], [c.rect.x1, c.rect.z1]])))
  const stairCells = upCores.flatMap((c) => {
    const out = c.enclosed ? [c.door.outside] : []
    for (let z = c.rect.z0; z <= c.rect.z1; z++) for (let x = c.rect.x0; x <= c.rect.x1; x++) out.push([x, z])
    return out
  })
  const sealedUp = sealPockets(G1, { seams: false, seeds: stairCells })
  if (sealedUp) notes.push(`${sealedUp} upper pocket cells sealed`)
  capLamps(G1)

  // Compile the storeys (the lot and the undercroft whole, the upper storey
  // over its footprint chunks).
  for (const G of [G0, GU, G1]) capKinds(G)
  const ups = upperChunks(seed, tx, tz)
  compileGrid(map, G0, allChunks())
  compileGrid(map, GU, allChunks())
  if (ups.length) compileGrid(map, G1, ups)
  // §6.8 rules 3–4: the owned West/North lines open at the ports.
  openOwnedSeam(map, ctx, DECK, 'west')
  openOwnedSeam(map, ctx, DECK, 'north')
  openOwnedSeam(map, ctx, BASEMENT, 'west')
  openOwnedSeam(map, ctx, BASEMENT, 'north')

  // The stair cores (kit.stairwell), undercroft to lot: the garage's tower and
  // ramp, the blocks' stair halls, the lots' stair heads, the kiosk's core.
  for (const c of bp.cores) {
    const plan = stairwellPlan({ gx: c.gx, gz: c.gz, baseCy: BASEMENT, topCy: c.topCy === UP_CY ? UP : DECK, dir: c.dir, doorSide: c.doorSide })
    if (plan.error) return { error: `nightlot ${c.role}: ${plan.error}` }
    ctx.kit.stairwell(map, plan, { enclosed: c.enclosed })
  }
  if (kiosk) ctx.kit.stairwell(map, kiosk.stair.plan, { enclosed: true })

  // Plates.
  if (anomaly === 'countdown') notes.push('anomaly: the stall plates count down toward the exit')
  for (const [lcx, lcz] of allChunks()) labelFloor(map, DECK, deckLabel(seed, tx * 4 + lcx, tz * 4 + lcz), { cx: lcx, cz: lcz })
  labelFloor(map, BASEMENT, BASEMENT_LABEL)
  // The upper storey: the roof deck reads P2, a frontage's upper floor 2.
  const gc = bp.garage?.chunks
  for (const [lcx, lcz] of ups) {
    const roofChunk = !!gc && lcx >= gc.c0x && lcx < gc.c0x + gc.w && lcz >= gc.c0z && lcz < gc.c0z + gc.h
    labelFloor(map, UP, roofChunk ? UPPER_LABELS.roof : UPPER_LABELS.floor, { cx: lcx, cz: lcz })
  }
  if (kiosk) {
    const a = anchorDistrict(seed)
    if (a.tx === tx && a.tz === tz) {
      for (const [x, z] of KIOSK.exits) {
        const [gx, gz] = kiosk.T.cell(x, z)
        markExit(map, ctx, { gx, gz, cy: BASEMENT })
      }
    }
  }
  if (home) {
    const c = spawnCells(seed)[0]
    markSpawn(map, ctx, { gx: c.gx - tx * SPAN, gz: c.gz - tz * SPAN, cy: DECK })
  }
  ctx.notes?.push?.(...notes, `${rooms} rooms and units · ${bp.lots.length} lots · ${bp.cores.length} stair cores (${upCores.length} up to the upper storey)`)
  return {}
}

// The tile program (spec §3.3): build<Id>Tile(map, seed, ctx). Finite ctx →
// the kind lab's district; tile ctx → one district of the world.
export function buildNightLotTile(map, seed, ctx = FINITE_CTX_NIGHTLOT) {
  if (ctx.mode === 'tile') return buildNightLotDistrict(map, ctx)
  return buildNightLotSample(map, seed, ctx)
}

// The kind lab's sample (finite mode): the seed's exit district drawn by the
// tile program at district-local coordinates (storeys 0..2 = cy −1..1), the
// upper storey's off-footprint chunks written solid. The spawn is the first
// walkable cell of the west road on the lot; the exit the kiosk basement's.
function buildNightLotSample(map, seed, ctx) {
  const worldSeed = seed >>> 0
  const key = anchorDistrict(worldSeed)
  const notes = []
  const exits = []
  const res = buildNightLotDistrict(map, { ...ctx, worldSeed, key, notes })
  if (res.error) return res
  const ups = new Set(upperChunks(worldSeed, key.tx, key.tz).map(([a, b]) => `${a},${b}`))
  compileGrid(map, new Grid(UP), allChunks().filter(([a, b]) => !ups.has(`${a},${b}`)))
  // Chunk records carry world chunk coordinates; the result is in the map's
  // own frame (a TileCanvas at a non-zero origin shifts them).
  const o = map.origin ?? { cx: 0, cy: 0, cz: 0 }
  for (const d of map.chunks.values()) {
    if (d.exit) exits.push({ gx: (d.cx - o.cx) * CHUNK + d.exit.lx, gz: (d.cz - o.cz) * CHUNK + d.exit.lz, cy: d.cy - o.cy })
  }
  let spawn = null
  for (let gz = SPAN >> 1; gz < SPAN && !spawn; gz++) {
    for (let gx = 0; gx < 4 && !spawn; gx++) {
      const d = map.chunkAt(map.cellChunk(gx), DECK, map.cellChunk(gz))
      if (d && cellWalkable(d, map.cellLocal(gx), map.cellLocal(gz))) spawn = { gx, gz, cy: DECK }
    }
  }
  notes.unshift(`sample: district ${key.tx},${key.tz} of world seed ${worldSeed} (the exit district)`)
  return { spawn, exit: exits[0] ?? null, notes }
}
