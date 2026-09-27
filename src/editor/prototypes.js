import { CELL, CHUNK } from '../world/constants.js'
import {
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  CELL_ROOM,
  COLUMN_STANDARD,
  PASSAGE_DOOR,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  SPACE_ROLE_NONE,
  SPACE_ROLE_OFFICE,
  SPACE_ROLE_STORAGE,
} from '../world/mapTypes.js'
import { hash3i } from '../world/core/hash.js'
import { PIECE_DIMS } from '../world/rooms/furnish.js'
import {
  FURN_BED,
  FURN_CABINET,
  FURN_DESK,
  FURN_RACK,
  FURN_TABLE,
  FURN_WHITEBOARD,
} from '../world/rooms/catalog.js'
import {
  STAIR_E,
  atriumDescriptor,
  stairwellPlan,
  stampAtrium,
  stampStairwell,
} from '../world/structures/authored.js'
import { seedFromText } from './EditorMap.js'

// Prototype map kinds — the "kind lab". Each builds a complete, finite,
// deterministic map (seed → bytes) into an editor document from the same
// primitives the game generates with: thin-wall cells, doors, columns,
// lamps, collision-real furniture, canonical stairs and the Office atrium
// contract. Every kind passes the layered audit, so it can be explored,
// simulated, measured against the families (npm run report:liminal) and
// played in the 3D preview before a generator family is written for it.
//
// Kinds (research: docs/liminal-horror-design.md "New map kinds"):
//   underpass   Exit-8 transit passage: identical serpentine segments with a
//               fixed fixture rhythm, one or two mutated copies
//   parking     multi-storey deck: open column grid, a void slot through all
//               levels, enclosed stair cores, whole-bay lighting failures
//   mall        dead mall: bridged galleria through 3 storeys, storefront
//               rows (mostly dark), an anchor hall and a food court
//   hospital    racetrack ward: corridor ring round a support core, patient
//               rooms outside it, a Nightingale ward as a dead end
//   school      school at night: double-loaded corridor, classrooms with
//               desks, lockers, stair cores at both ends, sparse light
//
// Solid mass is column-sealed (the sewer family's convention): every cell a
// plan does not open carries COLUMN_STANDARD and edges between the open plan
// and mass are walls.

const FACING = { S: 0, N: 1, E: 2, W: 3 } // piece fronts: +z, −z, +x, −x
const WALL_TO_FRONT = { N: FACING.S, S: FACING.N, W: FACING.E, E: FACING.W }
const THICK = 0.16

// --- floor plan compiler ------------------------------------------------------

class FloorPlan {
  constructor(region) {
    this.region = region // global cells {x0, z0, x1, z1}
    this.cells = new Map() // 'gx,gz' -> {kind, spaceId, role}
    this.edges = new Map() // 'v|h:gx,gz' -> {wall, passage}
    this.lamps = []
    this.pieces = []
    this.cols = []
  }

  open(gx, gz, kind = CELL_CORRIDOR, spaceId = 0, role = SPACE_ROLE_NONE) {
    this.cells.set(`${gx},${gz}`, { kind, spaceId, role })
  }

  rect(r, kind = CELL_CORRIDOR, spaceId = 0, role = SPACE_ROLE_NONE) {
    for (let gz = r.z0; gz <= r.z1; gz++) for (let gx = r.x0; gx <= r.x1; gx++) this.open(gx, gz, kind, spaceId, role)
  }

  has(gx, gz) {
    return this.cells.has(`${gx},${gz}`)
  }

  edge(axis, gx, gz, wall, passage) {
    this.edges.set(`${axis}:${gx},${gz}`, { wall, passage })
  }

  // A walled room with one or more openings: `doors` are {axis, gx, gz,
  // passage?} edges on its perimeter.
  room(r, { spaceId, role = SPACE_ROLE_NONE, doors = [], lamp = null }) {
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
    if (lamp !== null) this.lamps.push({ gx: Math.floor((r.x0 + r.x1) / 2), gz: Math.floor((r.z0 + r.z1) / 2), lit: lamp })
  }

  lamp(gx, gz, lit = true) {
    this.lamps.push({ gx, gz, lit })
  }

  column(gx, gz) {
    this.cols.push({ gx, gz })
  }

  // A piece centred in its cell, or hugging the named wall (N/S/E/W) with
  // its front facing away from it.
  piece(gx, gz, kind, { wall = null, facing = FACING.S } = {}) {
    const front = wall ? WALL_TO_FRONT[wall] : facing
    this.pieces.push({ gx, gz, kind, front, wall })
  }

  // Every cell of every chunk the region touches is written (unused cells
  // become mass), and an edge is written only where it borders the plan, so
  // compiling never materializes a stray neighbour chunk.
  compile(map, cy) {
    const x0 = Math.floor(this.region.x0 / CHUNK) * CHUNK
    const z0 = Math.floor(this.region.z0 / CHUNK) * CHUNK
    const x1 = (Math.floor(this.region.x1 / CHUNK) + 1) * CHUNK - 1
    const z1 = (Math.floor(this.region.z1 / CHUNK) + 1) * CHUNK - 1
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const c = this.cells.get(`${gx},${gz}`)
        if (c) map.setCell(gx, cy, gz, { kind: c.kind, spaceId: c.spaceId, role: c.role, col: 0 })
        else map.setCell(gx, cy, gz, { kind: CELL_OPEN, spaceId: 0, role: SPACE_ROLE_NONE, col: COLUMN_STANDARD })
      }
    }
    const setEdge = (axis, gx, gz, a, b) => {
      const explicit = this.edges.get(`${axis}:${gx},${gz}`)
      let wall
      let passage
      if (!a && !b) {
        // Inside the mass: clear only lines this region's chunks own.
        const owner = axis === 'v' ? gx <= x1 : gz <= z1
        if (!owner) return
        ;[wall, passage] = [0, PASSAGE_OPEN]
      } else if (explicit) ({ wall, passage } = explicit)
      else if (a && b) [wall, passage] = [0, PASSAGE_OPEN]
      else [wall, passage] = [1, PASSAGE_WALL]
      if (axis === 'v') map.setWallV(gx, cy, gz, wall, passage)
      else map.setWallH(gx, cy, gz, wall, passage)
    }
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1 + 1; gx++) setEdge('v', gx, gz, this.has(gx - 1, gz), this.has(gx, gz))
    }
    for (let gz = z0; gz <= z1 + 1; gz++) {
      for (let gx = x0; gx <= x1; gx++) setEdge('h', gx, gz, this.has(gx, gz - 1), this.has(gx, gz))
    }
    for (const { gx, gz } of this.cols) map.setCell(gx, cy, gz, { col: COLUMN_STANDARD })
    for (const { gx, gz, lit } of this.lamps) map.setLamp(gx, cy, gz, lit)
    for (const p of this.pieces) addPiece(map, cy, p)
  }
}

function addPiece(map, cy, { gx, gz, kind, front, wall }) {
  if (map.cellAt(gx, cy, gz).col) return
  const [w0, d0] = PIECE_DIMS[kind] ?? [1, 1]
  const alongX = front === FACING.E || front === FACING.W
  const w = alongX ? d0 : w0
  const d = alongX ? w0 : d0
  let x = (map.cellLocal(gx) + 0.5) * CELL
  let z = (map.cellLocal(gz) + 0.5) * CELL
  if (wall) {
    const depth = alongX ? w : d
    const off = CELL / 2 - THICK / 2 - depth / 2 - 0.06
    if (wall === 'N') z -= off
    if (wall === 'S') z += off
    if (wall === 'W') x -= off
    if (wall === 'E') x += off
  }
  map.addFurniture(gx, cy, gz, { kind, x, z, w, d, facing: front })
}

const rng = (seed, salt) => (a, b = 0) => hash3i((seed ^ salt) | 0, a | 0, b | 0, 0x51) >>> 0

// --- underpass (The Exit 8) -----------------------------------------------------

// Serpentine bands of a 2-wide corridor (12 cells long) joined by U-turns at
// alternating ends. Every band repeats the same fixture rhythm — three
// doors into one-cell closets on the north wall, a lamp every two cells —
// until one or two later bands mutate one high-salience property.
export const UNDERPASS_ANOMALIES = Object.freeze(['dark', 'lightsAhead', 'extraDoor', 'missingDoor', 'column'])

function buildUnderpass(map, seed, { bands = 9, anomalies = 2 } = {}) {
  const r = rng(seed, 0xe8)
  const cy = 0
  const plan = new FloorPlan({ x0: 0, z0: 0, x1: 13, z1: bands * 4 })
  const mutated = new Map()
  // Baseline first: bands 0–2 never mutate.
  for (let i = 0; i < anomalies; i++) {
    const band = 3 + (r(i, 1) % Math.max(1, bands - 3))
    mutated.set(band, UNDERPASS_ANOMALIES[r(i, 2) % UNDERPASS_ANOMALIES.length])
  }
  let spaceId = 100
  for (let b = 0; b < bands; b++) {
    const z = 1 + b * 4
    const anomaly = mutated.get(b) ?? null
    plan.rect({ x0: 1, z0: z, x1: 12, z1: z + 1 }, CELL_CORRIDOR)
    // U-turn to the next band at alternating ends.
    if (b < bands - 1) {
      const xs = b % 2 === 0 ? [11, 12] : [1, 2]
      plan.rect({ x0: xs[0], z0: z + 2, x1: xs[1], z1: z + 3 }, CELL_CORRIDOR)
    }
    let doors = [4, 7, 10]
    if (anomaly === 'extraDoor') doors = [4, 6, 8, 10]
    if (anomaly === 'missingDoor') doors = [4, 10]
    for (const x of doors) {
      // The closet above the north wall; skip where a U-turn passes.
      if (plan.has(x, z - 1)) continue
      plan.room({ x0: x, z0: z - 1, x1: x, z1: z - 1 }, {
        spaceId: spaceId++,
        role: SPACE_ROLE_STORAGE,
        doors: [{ axis: 'h', gx: x, gz: z }],
      })
    }
    for (let x = 1; x <= 12; x += 2) {
      const dead = anomaly === 'dark' || (anomaly === 'lightsAhead' && (b % 2 === 0 ? x > 6 : x < 7))
      plan.lamp(x, z, !dead)
    }
    if (anomaly === 'column') plan.column(7, z + 1)
  }
  plan.compile(map, cy)
  const lastZ = 1 + (bands - 1) * 4
  const exit = { gx: (bands - 1) % 2 === 0 ? 12 : 1, gz: lastZ + 1 }
  const d = map.chunkAt(map.cellChunk(exit.gx), cy, map.cellChunk(exit.gz))
  d.exit = { lx: map.cellLocal(exit.gx), lz: map.cellLocal(exit.gz) }
  return {
    spawn: { gx: 1, gz: 1, cy },
    exit: { ...exit, cy },
    notes: [...mutated].map(([b, a]) => `band ${b + 1}: ${a}`),
  }
}

// --- parking deck ------------------------------------------------------------------

function buildParking(map, seed, { floors = 3 } = {}) {
  const r = rng(seed, 0x9a4c)
  const region = { x0: 1, z0: 1, x1: 26, z1: 26 }
  const notes = []
  for (let cy = 0; cy < floors; cy++) {
    const plan = new FloorPlan(region)
    plan.rect(region, CELL_OPEN)
    // Structural grid: a post every 3 cells on the back line of each
    // 6-cell stall module (2 stall + 2 aisle + 2 stall).
    for (let gz = 1; gz <= 26; gz += 6) {
      for (let gx = 2; gx <= 25; gx += 3) plan.column(gx, gz)
    }
    // Sodium grid over the aisles; whole bays (modules) fail together.
    const failed = new Set([r(cy, 1) % 4, r(cy, 2) % 4])
    for (let m = 0; m < 4; m++) {
      const gz = 3 + m * 6
      for (let gx = 3; gx <= 24; gx += 3) plan.lamp(gx, gz, !failed.has(m))
    }
    notes.push(`cy ${cy}: dark bays ${[...failed].map((m) => m + 1).join(', ')}`)
    plan.compile(map, cy)
  }
  // The ramp band becomes a void slot through every level; two enclosed stair
  // cores in opposite corners.
  const slot = atriumDescriptor({ x0: 3, z0: 16, x1: 12, z1: 18, baseCy: 0, levels: floors, kind: 'openVoid', bridgeAxis: 'x' })
  if (slot.error) return { error: slot.error }
  stampAtrium((cx, cy, cz) => map._touch(cx, cy, cz), slot.descriptor)
  for (const at of [{ gx: 18, gz: 4 }, { gx: 18, gz: 21 }]) {
    const sp = stairwellPlan({ ...at, baseCy: 0, topCy: floors - 1, dir: STAIR_E, doorSide: 'far' })
    if (sp.error) return { error: sp.error }
    stampStairwell((cx, cy, cz) => map._touch(cx, cy, cz), sp, { enclosed: true })
  }
  return { spawn: { gx: 5, gz: 5, cy: 0 }, notes }
}

// --- dead mall -----------------------------------------------------------------------

function buildMall(map, seed, { floors = 3 } = {}) {
  const r = rng(seed, 0x3a11)
  // Galleria void (bridged along x); its short side stays inside one chunk.
  const F = { x0: 9, z0: 17, x1: 32, z1: 20 }
  const notes = []
  let spaceId = 400
  for (let cy = 0; cy < floors; cy++) {
    const plan = new FloorPlan({ x0: 0, z0: 0, x1: 41, z1: 27 })
    // Gallery: the stamp's lobby ring plus one walkway lane all round.
    plan.rect({ x0: F.x0 - 2, z0: F.z0 - 2, x1: F.x1 + 2, z1: F.z1 + 2 }, CELL_LOBBY)
    // Storefront rows north and south: 3 wide × 4 deep, fronts fully open.
    let lit = 0
    for (const side of ['N', 'S']) {
      for (let k = 0; k < 8; k++) {
        const x0 = F.x0 - 1 + k * 3
        const rect = side === 'N'
          ? { x0, x1: x0 + 2, z0: F.z0 - 6, z1: F.z0 - 3 }
          : { x0, x1: x0 + 2, z0: F.z1 + 3, z1: F.z1 + 6 }
        const frontZ = side === 'N' ? rect.z1 + 1 : rect.z0
        const on = r(cy * 16 + k, side === 'N' ? 1 : 2) % 10 < 3
        if (on) lit++
        plan.room(rect, {
          spaceId: spaceId++,
          role: SPACE_ROLE_STORAGE,
          doors: [0, 1, 2].map((i) => ({ axis: 'h', gx: x0 + i, gz: frontZ, passage: PASSAGE_WIDE })),
          lamp: on,
        })
        if (on) {
          // Lit shops keep their racks against the back wall.
          const backWall = side === 'N' ? 'N' : 'S'
          const backZ = side === 'N' ? rect.z0 : rect.z1
          plan.piece(x0, backZ, FURN_RACK, { wall: backWall })
          plan.piece(x0 + 2, backZ, FURN_RACK, { wall: backWall })
        }
      }
    }
    notes.push(`cy ${cy}: ${lit}/16 storefronts lit`)
    // West: a dark anchor hall; east: the food court (tables under a few
    // working lamps).
    const anchor = { x0: 1, z0: 5, x1: F.x0 - 3, z1: 26 }
    plan.rect(anchor, CELL_OPEN)
    for (let gz = anchor.z0 + 2; gz <= anchor.z1 - 1; gz += 4) plan.column(3, gz)
    plan.lamp(4, 15, false)
    const court = { x0: F.x1 + 3, z0: 5, x1: 40, z1: 26 }
    plan.rect(court, CELL_OPEN)
    for (let gz = court.z0 + 2; gz <= court.z1 - 2; gz += 3) {
      for (let gx = court.x0 + 1; gx <= court.x1 - 1; gx += 3) {
        plan.piece(gx, gz, FURN_TABLE)
        plan.lamp(gx, gz + 1, r(gx, gz + cy * 100) % 3 === 0)
      }
    }
    // Service passage from the gallery up to the east stair core's door.
    plan.rect({ x0: F.x1 + 1, z0: 5, x1: F.x1 + 2, z1: F.z0 - 3 }, CELL_CORRIDOR)
    plan.rect({ x0: 29, z0: 5, x1: F.x1, z1: 5 }, CELL_CORRIDOR)
    plan.compile(map, cy)
  }
  const gal = atriumDescriptor({ ...F, baseCy: 0, levels: floors, kind: 'bridged', bridgeAxis: 'x', bridgeEvery: 1 })
  if (gal.error) return { error: gal.error }
  stampAtrium((cx, cy, cz) => map._touch(cx, cy, cz), gal.descriptor)
  // Stair cores in the north corners, doors opening south.
  for (const at of [{ gx: 2, gz: 2 }, { gx: 30, gz: 2 }]) {
    const sp = stairwellPlan({ ...at, baseCy: 0, topCy: floors - 1, dir: STAIR_E, doorSide: 'far' })
    if (sp.error) return { error: `mall stair: ${sp.error}` }
    stampStairwell((cx, cy, cz) => map._touch(cx, cy, cz), sp, { enclosed: true })
  }
  return { spawn: { gx: F.x0 - 2, gz: F.z0 - 2, cy: 0 }, notes }
}

// --- hospital ward -------------------------------------------------------------------

function buildHospital(map, seed) {
  const r = rng(seed, 0x40b1)
  const cy = 0
  const plan = new FloorPlan({ x0: 0, z0: 0, x1: 41, z1: 13 })
  const ring = { x0: 13, z0: 3, x1: 39, z1: 10 }
  // Racetrack corridor: one cell wide round the support core.
  for (let gx = ring.x0; gx <= ring.x1; gx++) {
    plan.open(gx, ring.z0)
    plan.open(gx, ring.z1)
  }
  for (let gz = ring.z0; gz <= ring.z1; gz++) {
    plan.open(ring.x0, gz)
    plan.open(ring.x1, gz)
  }
  let spaceId = 700
  // Support core: two rows of utility rooms, one replaced by the lit nurse
  // station (refuge landmark).
  const station = 2 + (r(1) % 3)
  for (let k = 0; k < 6; k++) {
    for (const row of [0, 1]) {
      const x0 = ring.x0 + 1 + k * 4
      const rect = { x0, x1: Math.min(ring.x1 - 1, x0 + 3), z0: row ? 7 : 4, z1: row ? 9 : 6 }
      if (rect.x1 < rect.x0) continue
      const doorZ = row ? ring.z1 : ring.z0 + 1
      if (k === station && row === 0) {
        plan.rect(rect, CELL_LOBBY)
        plan.piece(rect.x0 + 1, rect.z0 + 1, FURN_DESK)
        plan.piece(rect.x0 + 2, rect.z0 + 1, FURN_DESK)
        plan.lamp(rect.x0 + 1, rect.z0 + 2, true)
        continue
      }
      plan.room(rect, {
        spaceId: spaceId++, role: SPACE_ROLE_STORAGE,
        doors: [{ axis: 'h', gx: x0 + 1, gz: doorZ }], lamp: false,
      })
      plan.piece(rect.x1, row ? rect.z1 : rect.z0, FURN_CABINET, { wall: row ? 'S' : 'N' })
    }
  }
  // Patient rooms outside the ring, north and south: bed + nightstand.
  for (let k = 0; ring.x0 + 1 + k * 3 + 1 <= ring.x1 - 1; k++) {
    for (const side of ['N', 'S']) {
      const x0 = ring.x0 + 1 + k * 3
      const rect = side === 'N' ? { x0, x1: x0 + 1, z0: 1, z1: 2 } : { x0, x1: x0 + 1, z0: 11, z1: 12 }
      plan.room(rect, {
        spaceId: spaceId++, role: SPACE_ROLE_NONE,
        doors: [{ axis: 'h', gx: x0, gz: side === 'N' ? ring.z0 : ring.z1 + 1 }],
        lamp: r(k, side === 'N' ? 3 : 4) % 5 === 0,
      })
      plan.piece(x0 + 1, side === 'N' ? 1 : 12, FURN_BED, { wall: side })
    }
  }
  // Nightingale ward: a long dead-end pavilion off the west side, beds in
  // two rows along its walls.
  const ward = { x0: 1, z0: 4, x1: 10, z1: 9 }
  plan.room(ward, { spaceId: spaceId++, role: SPACE_ROLE_NONE, doors: [{ axis: 'v', gx: 11, gz: 6 }, { axis: 'v', gx: 11, gz: 7 }] })
  plan.open(11, 6)
  plan.open(11, 7)
  plan.open(12, 6)
  plan.open(12, 7)
  plan.edge('v', 11, 6, 0, PASSAGE_DOOR)
  plan.edge('v', 11, 7, 0, PASSAGE_DOOR)
  for (let gx = ward.x0; gx <= ward.x1; gx += 2) {
    plan.piece(gx, ward.z0, FURN_BED, { wall: 'N' })
    plan.piece(gx, ward.z1, FURN_BED, { wall: 'S' })
  }
  for (let gx = ward.x0 + 1; gx <= ward.x1; gx += 3) plan.lamp(gx, 6, gx === ward.x0 + 1)
  // Corridor lamps: every other ring cell, one in three lit.
  let n = 0
  for (let gx = ring.x0; gx <= ring.x1; gx += 2) {
    plan.lamp(gx, ring.z0, n++ % 3 === 0)
    plan.lamp(gx, ring.z1, n++ % 3 === 0)
  }
  plan.compile(map, cy)
  return { spawn: { gx: ring.x1, gz: ring.z0, cy }, notes: [`nurse station in bay ${station + 1}`] }
}

// --- school at night ------------------------------------------------------------------

function buildSchool(map, seed, { floors = 2 } = {}) {
  const r = rng(seed, 0x5c01)
  let spaceId = 900
  for (let cy = 0; cy < floors; cy++) {
    const plan = new FloorPlan({ x0: 0, z0: 0, x1: 27, z1: 13 })
    plan.rect({ x0: 1, z0: 6, x1: 26, z1: 7 }, CELL_CORRIDOR)
    // Stair core ends (their halos are carved by the stamp).
    plan.rect({ x0: 1, z0: 1, x1: 6, z1: 5 }, CELL_LOBBY)
    plan.rect({ x0: 21, z0: 1, x1: 26, z1: 5 }, CELL_LOBBY)
    for (let k = 0; k < 4; k++) {
      for (const side of ['N', 'S']) {
        const x0 = 8 + k * 3
        const rect = side === 'N' ? { x0, x1: x0 + 2, z0: 2, z1: 5 } : { x0, x1: x0 + 2, z0: 8, z1: 11 }
        plan.room(rect, {
          spaceId: spaceId++, role: SPACE_ROLE_OFFICE,
          doors: [{ axis: 'h', gx: x0 + 1, gz: side === 'N' ? 6 : 8 }],
          lamp: r(k, cy * 2 + (side === 'N' ? 0 : 1)) % 6 === 0,
        })
        // Desks in the two side columns facing the board, which stands in a
        // far corner so the middle aisle reaches every free cell.
        const rows = side === 'N' ? [3, 4] : [9, 10]
        for (const gz of rows) {
          plan.piece(x0, gz, FURN_DESK, { facing: side === 'N' ? FACING.N : FACING.S })
          plan.piece(x0 + 2, gz, FURN_DESK, { facing: side === 'N' ? FACING.N : FACING.S })
        }
        plan.piece(x0, side === 'N' ? 2 : 11, FURN_WHITEBOARD, { wall: side })
      }
    }
    // Lockers along the north corridor lane, clear of the doors.
    for (let gx = 8; gx <= 19; gx++) {
      if ((gx - 8) % 3 === 1) continue
      plan.piece(gx, 6, FURN_CABINET, { wall: 'N' })
    }
    // Night lighting: a lamp every four cells, every other one dead.
    let n = 0
    for (let gx = 2; gx <= 25; gx += 4) plan.lamp(gx, 7, n++ % 2 === 0)
    plan.compile(map, cy)
  }
  for (const at of [{ gx: 2, gz: 2 }, { gx: 22, gz: 2 }]) {
    const sp = stairwellPlan({ ...at, baseCy: 0, topCy: floors - 1, dir: STAIR_E, doorSide: 'far' })
    if (sp.error) return { error: `school stair: ${sp.error}` }
    stampStairwell((cx, cy, cz) => map._touch(cx, cy, cz), sp, { enclosed: true })
  }
  return { spawn: { gx: 13, gz: 6, cy: 0 }, notes: [`${floors} floors · 16 classrooms per floor`] }
}

// --- registry ---------------------------------------------------------------------------

export const PROTOTYPE_KINDS = Object.freeze([
  { id: 'underpass', label: 'transit underpass (Exit 8)', family: 'tower', floors: 1, build: buildUnderpass },
  { id: 'parking', label: 'parking deck', family: 'tower', floors: 3, build: buildParking },
  { id: 'mall', label: 'dead mall', family: 'hotel', floors: 3, build: buildMall },
  { id: 'hospital', label: 'hospital ward', family: 'tower', floors: 1, build: buildHospital },
  { id: 'school', label: 'school at night', family: 'office', floors: 2, build: buildSchool },
])

// Build a prototype kind into `map` (cleared first) as one undoable step.
export function generatePrototype(map, kindId, { seed = 'lobby', ...options } = {}) {
  const kind = PROTOTYPE_KINDS.find((k) => k.id === kindId)
  if (!kind) return { ok: false, error: `unknown prototype ${kindId}` }
  const numericSeed = seedFromText(seed)
  let result = null
  map.mutate(() => {
    map.clearAll()
    map.meta.family = kind.family
    map.meta.seed = numericSeed
    map.meta.name = `${kind.id}-${seed}`
    result = kind.build(map, numericSeed, options)
  })
  if (result?.error) return { ok: false, error: result.error }
  return { ok: true, kind: kind.id, label: kind.label, ...result }
}
