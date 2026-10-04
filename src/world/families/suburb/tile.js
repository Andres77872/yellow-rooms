import { cIdx } from '../../constants.js'
import {
  CELL,
  CHUNK,
  CELL_CORRIDOR,
  CELL_OPEN,
  CELL_ROOM,
  FACING,
  FloorPlan,
  PASSAGE_DOOR,
  PASSAGE_WALL,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_BEDROOM,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_LIVING,
  SPACE_ROLE_NONE,
  SPACE_ROLE_STORAGE,
  STAIR_E,
  STAIR_N,
  STAIR_S,
  STAIR_W,
  WALL_WINDOW,
  featureEdge,
  labelFloor,
  rng,
} from '../../tiles/floorPlan.js'
import { createRoom } from '../../tiles/roomOps.js'
import { markExit, markSpawn } from '../../tiles/kit.js'
import { openOwnedSeam } from '../../tiles/seams.js'
import { stairwellPlan } from '../../structures/authored.js'
import {
  PROP_BENCH,
  PROP_CART,
  PROP_DOGHOUSE,
  PROP_DUMPSTER,
  PROP_GNOME,
  PROP_KIDS_BIKE,
  PROP_MAILBOX,
  PROP_WHEELIE_BIN,
} from '../../props/index.js'
import { FURN_ARMCHAIR, FURN_CHAIR, FURN_FRIDGE, FURN_SOFA, FURN_TABLE, FURN_WASHER } from '../../rooms/catalog.js'
import {
  NEIGHBOURS,
  SUBURB_MODELS,
  TINT_PORCH,
  TINT_ROOM,
  TINT_TV,
  edgeBetween,
  hallEdges,
  parseModel,
  sharedEdges,
  stampRoom,
} from './prototype.js'
import {
  ATTIC,
  FACE_STEP,
  GROUND,
  SPAWN_CELLS,
  TILE_D,
  TILE_W,
  TWO_STOREY,
  TWO_STOREY_KINDS,
  anomalyAt,
  houseCellOf,
  isAnchorTile,
  lotCell,
  nineRowOf,
  plateOf,
  suburbPlan,
} from './geometry.js'

// THE tile program of the suburb family (spec §3.3, §12.6): one 5×3-chunk
// world tile at ctx.origin, storeys 0..1, drawn from the tile's own plan
// (geometry.suburbPlan: seam ports, spine, legs, parallel street, stems,
// bulbs, lots — composed per tile, never copied). The parts come from the
// kind's catalogue (prototype.js): the five house models and their room
// stamping, the twin furnishing (the first house of a model and frontage
// axis is furnished by createRoom, every later one copies it, reflected), the
// tints. What this program adds over the plan:
//   - lots as open ground (lawn, driveway, backyard), houses walled with a
//     front door and a back door onto the yard; leftover land is open field;
//   - privacy fences on the backyards' side and rear lot lines (~8% gaps),
//     gates across the driveways (~30% open), picket rails on some lawns;
//     then a repair pass opens a fence wherever a yard would be shut in, so
//     every yard reaches the street through its house or a gap (doc §4.3.6);
//   - the two-storey houses (1-4 per tile, any of four facings; four models
//     — cape cod, colonial, side hall, saltbox — each with 2-3 ground plans
//     that put the stair core in different places, geometry.TWO_STOREY_DEFS)
//     climb through a switchback core (kit.stairwell) to an upstairs drawn
//     per house (geometry.upstairsVariant: a trimmed or stubbed hall, 2-7
//     rooms split by hash — bedrooms, a bath, a box room, a laundry or a
//     bonus room — knee-wall eaves with dormers, linen closets) on storey 1,
//     the only kept chunks of that storey;
//   - wake states hashed per house (0.3 up: a lit window or a TV; nearly
//     half the sleepers leave the porch light on); in the anchor tile every
//     house sleeps but the first two-storey one, lit in the exit's own amber,
//     and the exit is in its attic (markExit); gnomes face that house;
//   - streetlights at junctions and bulbs (~30% lit), a kerb pole at every
//     second lot (one in five lit), porch lamps and the driveway's coach
//     light (switched together), lit windows (the lamp just inside the
//     street window), TVs, the upstairs halls' night lights; then the light
//     floor (lightFloor): no street-level chunk keeps fewer than three lit
//     lamps — a lamp left on inside a sleeping house first, then a porch, a
//     flickering streetlight, a back-porch bulb, a new lamp on bare ground;
//   - one anomaly per tile at most (geometry.anomalyAt), plates per chunk
//     (geometry.plateOf), ≤ 12 lit lamps and ≤ 14 prop kinds per chunk.

export const TINT_STREET = 0xffc27a // the odd sodium streetlight still burning (the record's lampTint)
export const TINT_EXIT = 0xff9a3c // the one lit house of the anchor tile: an amber found nowhere else
// Moonlight (doc §8: "moonlight gives silhouettes only"): the bake's few
// fill fixtures outside (generator.js: one hashed cell per 8×8 block, only
// where no warm light reaches) are a dim, cold night tint, so the warm light
// reads as what it is in a sleeping suburb — the odd streetlight still
// burning, a porch, a lit window, a TV.
export const TINT_MOON = 0x5d6f96
// The upstairs hall's night light: a low, warm plug-in glow.
export const TINT_NIGHT = 0xd98a4a

const SALT = 0x03a2 // the tile program's dice salt
const REGION = Object.freeze({ x0: 0, z0: 0, x1: TILE_W - 1, z1: TILE_D - 1 })

// The two-storey houses' ground floors (geometry.TWO_STOREY_KINDS), whose
// 'S' block is the stair core, not a room.
export const TWO_STOREY_MODELS = Object.freeze(TWO_STOREY_KINDS.map((kind) => Object.freeze(kind.variants.map((g) => {
  const m = parseModel({ name: g.name, rows: g.rows, cycles: [] }, SUBURB_MODELS.length + kind.index)
  return Object.freeze({ ...m, rooms: m.rooms.filter((rm) => rm.key !== 'S'), core: g.core, twoStorey: true, kind: g })
}))))
// The upstairs letters (geometry.TWO_STOREY_DEFS attics): bedrooms, the
// bath, the box room under the roof, a laundry, a bonus room with a TV.
export const ATTIC_ROLE = Object.freeze({
  R: SPACE_ROLE_BEDROOM,
  P: SPACE_ROLE_BEDROOM,
  N: SPACE_ROLE_BEDROOM,
  B: SPACE_ROLE_BATHROOM,
  T: SPACE_ROLE_STORAGE,
  U: SPACE_ROLE_LAUNDRY,
  Y: SPACE_ROLE_LIVING,
})
// A forced lot's upstairs plan: drawn per house by geometry.upstairsVariant
// (atticPlan -1: the anomaly's repeated ground floor).
const upstairsOf = (lot) => lot.attic
const inCore = (model, u, v) => !!model.core && u >= model.core.u0 && u <= model.core.u1 && v >= model.core.v0 && v <= model.core.v1

// Exterior ground kinds (buildSuburbTile's ext array).
const EXT_STREET = 1
const EXT_LAWN = 2
const EXT_YARD = 3
const EXT_DRIVE = 4
const EXT_FIELD = 5

const FACE_FACING = Object.freeze({ N: FACING.N, S: FACING.S, W: FACING.W, E: FACING.E })
const REAR_WALL = Object.freeze({ N: 'S', S: 'N', W: 'E', E: 'W' })
const axisOf = (face) => (face === 'N' || face === 'S' ? 'ns' : 'ew')

// --- layout: the plan's lots as houses ----------------------------------------------

function tileLayout(ctx, seed) {
  const k = ctx.key
  const plan = suburbPlan(ctx.worldSeed, k.tx, k.tz)
  const anchor = isAnchorTile(ctx.worldSeed, k)
  const anomaly = anomalyAt(ctx.worldSeed, k)
  const r = rng(plan.h ^ seed, SALT)
  const houses = plan.lots.map((lot, i) => {
    const model = lot.model === TWO_STOREY ? TWO_STOREY_MODELS[lot.two][lot.ground] : SUBURB_MODELS[lot.model]
    const h = { ...lot, index: i, model, forced: lot.model === TWO_STOREY ? lot : null }
    if (h.forced) h.attic = upstairsOf(lot)
    h.anchorTile = anchor
    h.frontDoor = houseCellOf(h, model.front.u, model.front.v)
    h.outside = houseCellOf(h, model.front.u, -1) // the porch cell
    return h
  })
  const exitHouse = houses.find((h) => h.forced?.slot === 0)
  // Wake states (doc §4.3.7, §8): dark, porch light only, one lit window,
  // TV. About three houses in ten are up (doc §8: "one lit window per few
  // houses": 0.2 a lit window, 0.1 a TV); of the sleeping ones, nearly half
  // left the porch light burning (doc §1: "a porch light here"). A house
  // with a lit window has its porch on too, one watching TV half the time.
  // The anchor tile sleeps but its lit house.
  // Round the start (the spawn tile and its eight neighbours) the street
  // is still half awake — more porches burn — and it goes to sleep as you
  // walk deeper into the tract.
  const near = Math.max(Math.abs(k.tx), Math.abs(k.tz)) <= 1
  const porchUpTo = near ? 78 : 62
  for (const h of houses) {
    const roll = r(h.index, 7) % 100
    h.wake = anchor ? 'dark' : roll < 20 ? 'window' : roll < 30 ? 'tv' : roll < porchUpTo ? 'porch' : 'dark'
    h.porchLit = h.wake === 'porch' || h.wake === 'window' || (h.wake === 'tv' && r(h.index, 17) % 2 === 0)
  }
  if (anchor) {
    exitHouse.wake = 'exit'
    exitHouse.porchLit = true
  }
  // Anomaly 'door' (doc 10.7): one house's front door is missing — a wall
  // where the path ends. Only a model house with a back door onto a yard.
  let noFrontDoor = null
  if (anomaly === 'door') {
    const doorless = houses.filter((h) => !h.forced && h.yard > 0 && h.model.back)
    noFrontDoor = doorless.length ? doorless[r(6) % doorless.length] : null
  }
  const spawn = k.tx === 0 && k.tz === 0 ? { ...SPAWN_CELLS[0], cy: GROUND } : null
  return { plan, anchor, anomaly, r, houses, exitHouse, noFrontDoor, spawn }
}

// --- build -------------------------------------------------------------------------

export function buildSuburbTile(map, seed, ctx) {
  const L = tileLayout(ctx, seed)
  const { plan, r } = L
  const cy = GROUND
  const fp = new FloorPlan(REGION)
  // Tile-local cell arrays (index gz·70 + gx): the exterior ground kind, the
  // cells a door opens onto, the cells props took, and (after the fences)
  // the walls of every edge: wallV[i] is the edge west of cell i, wallH[i]
  // the edge north of it.
  const N = TILE_W * TILE_D
  const at = (gx, gz) => gz * TILE_W + gx
  const inTile = (gx, gz) => gx >= 0 && gz >= 0 && gx < TILE_W && gz < TILE_D
  const ext = new Uint8Array(N) // 0 none (house or mass), else an EXT_ kind
  const present = new Uint8Array(N) // 1: a plan cell
  const doorFront = new Uint8Array(N)
  const blocked = new Uint8Array(N)
  const outside = (gx, gz, what) => {
    ext[at(gx, gz)] = what
    present[at(gx, gz)] = 1
    fp.open(gx, gz, CELL_OPEN)
  }
  const isExt = (gx, gz) => inTile(gx, gz) && ext[at(gx, gz)] !== 0
  const isStreet = (gx, gz) => inTile(gx, gz) && ext[at(gx, gz)] === EXT_STREET
  // The east and south rim (the seam lines the neighbours own) stay mass but
  // at the ports (§6.8 rule 1); the west and north rim are the tile's own
  // lines: lots and field run onto them, walled on the seam line (compile).
  const rim = (gx, gz) => gx === TILE_W - 1 || gz === TILE_D - 1
  // Any seam cell (all four rims): never a prop or a pole — a port's cells
  // stay clear on both sides of its seam.
  const seamCell = (gx, gz) => gx === 0 || gz === 0 || rim(gx, gz)

  // Ground: streets (ports included), then every lot's open ground, then
  // the leftover inner land as field.
  for (let gz = 0; gz < TILE_D; gz++) {
    for (let gx = 0; gx < TILE_W; gx++) {
      const i = at(gx, gz)
      if (plan.street[i]) outside(gx, gz, EXT_STREET)
      else if (!rim(gx, gz) && plan.land[i] === 0) outside(gx, gz, EXT_FIELD)
    }
  }
  const houseWalls = new Set() // edge keys of house outlines (never opened)
  const edgeKey = (e) => `${e.axis}:${e.gx},${e.gz}`
  let hallId = 1000
  for (const h of L.houses) {
    const { model } = h
    for (let t = 0; t < h.lawn + h.D + h.yard; t++) {
      for (let s = 0; s <= h.W + h.side; s++) {
        const c = lotCell(h, s, t)
        outside(c.gx, c.gz, t < h.lawn ? EXT_LAWN : t >= h.lawn + h.D ? EXT_YARD : EXT_DRIVE)
      }
    }
    h.hallId = hallId++
    for (let v = 0; v < model.D; v++) {
      for (let u = 0; u < model.W; u++) {
        const c = houseCellOf(h, u, v)
        ext[at(c.gx, c.gz)] = 0
        present[at(c.gx, c.gz)] = 1
        const hall = model.halls.some((m) => m.u === u && m.v === v)
        // Room cells are placeholders until createRoom stamps them; a
        // two-storey house's core is its own space (the stair hall).
        if (model.twoStorey && inCore(model, u, v)) fp.open(c.gx, c.gz, CELL_ROOM, coreSpace(h), SPACE_ROLE_NONE)
        else fp.open(c.gx, c.gz, hall ? CELL_ROOM : CELL_CORRIDOR, hall ? h.hallId : 0, SPACE_ROLE_NONE)
      }
    }
    // The outline is walled; doors go in on top.
    const wall = (a, b) => {
      const e = edgeBetween(a, b)
      fp.edge(e.axis, e.gx, e.gz, 1, PASSAGE_WALL)
      houseWalls.add(edgeKey(e))
    }
    for (let u = 0; u < model.W; u++) {
      wall(houseCellOf(h, u, 0), houseCellOf(h, u, -1))
      wall(houseCellOf(h, u, model.D - 1), houseCellOf(h, u, model.D))
    }
    for (let v = 0; v < model.D; v++) {
      wall(houseCellOf(h, 0, v), houseCellOf(h, -1, v))
      wall(houseCellOf(h, model.W - 1, v), houseCellOf(h, model.W, v))
    }
    if (h !== L.noFrontDoor) {
      const e = edgeBetween(h.frontDoor, h.outside)
      fp.edge(e.axis, e.gx, e.gz, 0, PASSAGE_DOOR)
      doorFront[at(h.outside.gx, h.outside.gz)] = 1
    }
    if (h.yard > 0 && model.back) {
      const inside = houseCellOf(h, model.back.u, model.back.v)
      const yard = houseCellOf(h, model.back.u, model.D)
      const e = edgeBetween(inside, yard)
      fp.edge(e.axis, e.gx, e.gz, 0, PASSAGE_DOOR)
      doorFront[at(yard.gx, yard.gz)] = 1
      h.backDoor = true
    }
  }

  // Fences. Privacy fences (plain full-height walls: the stand-in for 1.8 m
  // boards) on the side and rear lines of every backyard, ~8% of their cells
  // missing; gates across the driveways at the house's back line, ~30% open
  // (the doorless house's gates all stand open); picket rails along ~40% of
  // the lawns' kerbs, open at the front path and the mailbox.
  const fences = new Map() // edge key -> edge, every fence, gate and rail
  const fence = (a, b, rail = false) => {
    if (!inTile(a.gx, a.gz) || !inTile(b.gx, b.gz) || !present[at(a.gx, a.gz)] || !present[at(b.gx, b.gz)]) return
    const e = edgeBetween(a, b)
    const k = edgeKey(e)
    if (houseWalls.has(k)) return
    if (rail) fp.rail(e.axis, e.gx, e.gz)
    else fp.edge(e.axis, e.gx, e.gz, 1, PASSAGE_WALL)
    fences.set(k, e)
  }
  const gap = (a, b) => r(a, b) % 100 < 8
  const mailboxS = new Map() // house -> the frontage column of its mailbox
  let pickets = 0
  for (const h of L.houses) {
    const back = h.lawn + h.D
    const last = h.W + h.side
    for (let t = back; t < back + h.yard; t++) {
      if (!gap(h.index * 64 + t, 11)) fence(lotCell(h, -1, t), lotCell(h, 0, t))
      if (!gap(h.index * 64 + t, 12)) fence(lotCell(h, last, t), lotCell(h, last + 1, t))
    }
    if (h.yard > 0) {
      const t = back + h.yard - 1
      for (let s = 0; s <= last; s++) if (!gap(h.index * 64 + s, 13)) fence(lotCell(h, s, t), lotCell(h, s, t + 1))
      // The gates across the driveway and the side yard.
      if (h !== L.noFrontDoor && r(h.index, 14) % 10 >= 3) {
        fence(lotCell(h, 0, back - 1), lotCell(h, 0, back))
        for (let s = h.W + 1; s <= last; s++) fence(lotCell(h, s, back - 1), lotCell(h, s, back))
      }
    }
    const door = 1 + (h.flip ? h.W - 1 - h.model.front.u : h.model.front.u)
    const mail = door === 1 ? 2 : 1
    mailboxS.set(h, mail)
    if (r(h.index, 8) % 10 < 4) {
      for (let s = 1; s <= h.W; s++) {
        if (s === door || s === mail) continue
        const kerb = lotCell(h, s, -1)
        if (!isStreet(kerb.gx, kerb.gz)) continue
        fence(lotCell(h, s, 0), kerb, true)
        pickets++
      }
    }
  }

  // The edge walls as arrays (explicit edges; an edge to a missing cell is
  // never crossed anyway).
  const wallV = new Uint8Array(N)
  const wallH = new Uint8Array(N)
  for (const [k, e] of fp.edges) {
    if (!e.wall) continue
    const c = k.indexOf(',')
    const gx = Number(k.slice(2, c))
    const gz = Number(k.slice(c + 1))
    if (!inTile(gx, gz)) continue
    if (k[0] === 'v') wallV[at(gx, gz)] = 1
    else wallH[at(gx, gz)] = 1
  }
  // Whether one can step from cell (ax, az) to its neighbour (bx, bz).
  const passable = (ax, az, bx, bz) => {
    if (!inTile(bx, bz) || !present[at(bx, bz)]) return false
    if (az === bz) return !wallV[at(Math.max(ax, bx), az)]
    return !wallH[at(ax, Math.max(az, bz))]
  }

  // Repair: every exterior cell must reach the street (a yard boxed in by
  // fences and a house without a back door, a lawn behind a rail). Flood
  // from the streets through open edges (houses enter by their doors); while
  // a cell is unreached, the first fence between it and a reached cell opens.
  const reached = new Uint8Array(N)
  const stack = []
  const flood = () => {
    while (stack.length) {
      const i = stack.pop()
      const gx = i % TILE_W
      const gz = (i - gx) / TILE_W
      for (const [dx, dz] of NEIGHBOURS) {
        const nx = gx + dx
        const nz = gz + dz
        if (!passable(gx, gz, nx, nz) || reached[at(nx, nz)]) continue
        reached[at(nx, nz)] = 1
        stack.push(at(nx, nz))
      }
    }
  }
  for (let i = 0; i < N; i++) {
    if (ext[i] !== EXT_STREET) continue
    reached[i] = 1
    stack.push(i)
  }
  flood()
  let opened = 0
  for (let guard = 0; guard < 4096; guard++) {
    let fix = null
    for (const [k, e] of fences) {
      const a = e.axis === 'v' ? at(e.gx - 1, e.gz) : at(e.gx, e.gz - 1)
      const b = at(e.gx, e.gz)
      if (reached[a] !== reached[b]) {
        fix = { k, e, start: reached[a] ? b : a }
        break
      }
    }
    if (!fix) break
    fp.edges.delete(fix.k)
    fences.delete(fix.k)
    if (fix.e.axis === 'v') wallV[at(fix.e.gx, fix.e.gz)] = 0
    else wallH[at(fix.e.gx, fix.e.gz)] = 0
    opened++
    reached[fix.start] = 1
    stack.push(fix.start)
    flood()
  }

  // Lamps outside: a porch fixture at every front door and a coach light
  // over every driveway (both lit when the porch light is on), streetlights
  // at junctions and bulbs (most of them dead), a pole at the kerb of every
  // second lot (one in five burning).
  for (const h of L.houses) {
    if (h === L.noFrontDoor) continue
    fp.lamp(h.outside.gx, h.outside.gz, h.porchLit, h.porchLit ? (h.wake === 'exit' ? TINT_EXIT : TINT_PORCH) : null)
    // The coach light on the house corner over the driveway, switched with
    // the porch: a lit house front is one warm island, porch to drive.
    const drive = lotCell(h, 0, h.lawn)
    fp.lamp(drive.gx, drive.gz, h.porchLit, h.porchLit ? (h.wake === 'exit' ? TINT_EXIT : TINT_PORCH) : null)
  }
  const poleAt = new Uint8Array(N)
  const poles = []
  for (const p of [...plan.junctions, ...plan.bulbs]) {
    if (!isStreet(p.gx, p.gz) || seamCell(p.gx, p.gz) || poleAt[at(p.gx, p.gz)]) continue
    poleAt[at(p.gx, p.gz)] = 1
    poles.push(p)
  }
  const order = poles.map((p, i) => [r(p.gx, p.gz + 500), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  // The street the player wakes on is the one still lit: in the spawn tile
  // every junction, bulb and kerb light burns; out in the tract about three
  // junction and bulb lights in ten (doc §4.3.7: 60-80% dead) and one kerb
  // pole in five.
  const litPoles = L.spawn ? poles.length : Math.max(1, Math.round(poles.length * 0.3))
  const litSet = new Set(order.slice(0, litPoles).map(([, i]) => i))
  poles.forEach((p, i) => fp.lamp(p.gx, p.gz, litSet.has(i), litSet.has(i) ? TINT_STREET : null))
  for (const h of L.houses) {
    if (h.index % 2) continue
    const kerb = lotCell(h, 0, -1)
    if (!isStreet(kerb.gx, kerb.gz) || poleAt[at(kerb.gx, kerb.gz)] || seamCell(kerb.gx, kerb.gz)) continue
    poleAt[at(kerb.gx, kerb.gz)] = 1
    const lit = L.spawn || r(h.index, 18) % 5 === 0
    fp.lamp(kerb.gx, kerb.gz, lit, lit ? TINT_STREET : null)
    poles.push(kerb)
  }

  // Yard props. A piece blocks its whole cell, so one goes down only where
  // its open neighbours stay joined around it (a local articulation test
  // over exterior ground; doors' outside cells, the rim and the spawn are
  // never used).
  if (L.spawn) for (const c of SPAWN_CELLS) blocked[at(c.gx, c.gz)] = 1
  const open = (ax, az, bx, bz) => isExt(bx, bz) && !blocked[at(bx, bz)] && passable(ax, az, bx, bz)
  const canBlock = (gx, gz) => {
    if (!isExt(gx, gz) || seamCell(gx, gz)) return false
    const i = at(gx, gz)
    if (blocked[i] || doorFront[i]) return false
    const near = NEIGHBOURS.map(([dx, dz]) => [gx + dx, gz + dz]).filter(([x, z]) => open(gx, gz, x, z))
    if (!near.length) return false
    // Flood the 3×3 box round the cell from its first open neighbour.
    const box = new Uint8Array(9)
    const bi = (x, z) => (z - gz + 1) * 3 + (x - gx + 1)
    const inBox = (x, z) => Math.abs(x - gx) <= 1 && Math.abs(z - gz) <= 1 && (x !== gx || z !== gz)
    const q = [near[0]]
    box[bi(...near[0])] = 1
    while (q.length) {
      const [x, z] = q.pop()
      for (const [dx, dz] of NEIGHBOURS) {
        const mx = x + dx
        const mz = z + dz
        if (!inBox(mx, mz) || box[bi(mx, mz)] || !open(x, z, mx, mz)) continue
        box[bi(mx, mz)] = 1
        q.push([mx, mz])
      }
    }
    return near.every(([x, z]) => box[bi(x, z)])
  }
  const counts = { mailbox: 0, bin: 0, gnome: 0, bike: 0, doghouse: 0, patio: 0, yardkit: 0, junk: 0 }
  const place = (tries, kind, opts, tally, ok = () => true) => {
    const c = tries.find((t) => inTile(t.gx, t.gz) && ok(t.gx, t.gz) && canBlock(t.gx, t.gz))
    if (!c) return null
    blocked[at(c.gx, c.gz)] = 1
    fp.piece(c.gx, c.gz, kind, typeof opts === 'function' ? opts(c.gx, c.gz) : opts)
    counts[tally]++
    return c
  }
  const walledSide = (gx, gz, side) => {
    const [dx, dz] = FACE_STEP[side]
    const nx = gx + dx
    const nz = gz + dz
    if (!inTile(nx, nz) || !present[at(nx, nz)]) return true
    return dz === 0 ? wallV[at(Math.max(gx, nx), gz)] === 1 : wallH[at(gx, Math.max(gz, nz))] === 1
  }
  const ex = L.exitHouse.outside
  const gaze = (gx, gz) => {
    const dx = ex.gx - gx
    const dz = ex.gz - gz
    return { facing: Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? FACING.E : FACING.W) : dz > 0 ? FACING.S : FACING.N }
  }
  for (const h of L.houses) {
    const toStreet = FACE_FACING[h.face]
    const porch = h.lawn - 1
    const W = h.W
    place([lotCell(h, mailboxS.get(h), 0)], PROP_MAILBOX, { facing: toStreet }, 'mailbox')
    // Bin night: half the wheelie bins wait at the kerb.
    if (r(h.index, 9) % 2 === 0) place([lotCell(h, 0, -1), lotCell(h, 1, -1), lotCell(h, W, -1)], PROP_WHEELIE_BIN, { facing: toStreet }, 'bin')
    // Gnomes all turn toward the exit house's porch (the anomaly carrier).
    if (r(h.index, 10) % 3 === 0 && h !== L.exitHouse) place([lotCell(h, W, porch), lotCell(h, 1, porch)], PROP_GNOME, gaze, 'gnome')
    if (r(h.index, 11) % 5 === 0) place([lotCell(h, W - 1, 0), lotCell(h, 3, porch)], PROP_KIDS_BIKE, { facing: FACING.E }, 'bike')
    if (h.yard > 0 && r(h.index, 12) % 3 === 0) {
      // Against the rear fence, never across one of its gaps.
      const rear = h.lawn + h.D + h.yard - 1
      const wall = REAR_WALL[h.face]
      place([lotCell(h, W, rear), lotCell(h, 1, rear)], PROP_DOGHOUSE, { wall }, 'doghouse', (gx, gz) => walledSide(gx, gz, wall))
    }
    // The back lawn (doc §5 backyard kit): a patio table with its chairs off
    // the back door, a bench or the bins along the side fence of a deep yard.
    if (h.yard >= 2 && r(h.index, 20) % 2 === 0) {
      const t = h.lawn + h.D + (h.yard >= 3 ? 1 : 0)
      const mid = 1 + Math.floor(W / 2) + (r(h.index, 21) % 2)
      const away = FACE_FACING[REAR_WALL[h.face]]
      if (place([lotCell(h, mid, t), lotCell(h, mid + 1, t), lotCell(h, mid - 2, t)], FURN_TABLE, { facing: away }, 'patio')) {
        place([lotCell(h, mid - 1, t), lotCell(h, mid + 2, t)], FURN_CHAIR, { facing: FACING.E }, 'patio')
        place([lotCell(h, mid, t + 1), lotCell(h, mid + 1, t + 1)], FURN_CHAIR, { facing: away }, 'patio')
      }
    }
    if (h.yard >= 4 && r(h.index, 22) % 3 !== 0) {
      const t = h.lawn + h.D + h.yard - 2
      const kind = r(h.index, 23) % 2 ? PROP_BENCH : PROP_WHEELIE_BIN
      place([lotCell(h, h.W + h.side, t), lotCell(h, 0, t), lotCell(h, h.W + h.side, t - 1)], kind, { facing: FACE_FACING[h.face] }, 'yardkit')
    }
  }

  // Vacant land (doc §4.3.4: "a field, a drainage strip or a lot for
  // sale"): every stretch of field is a lot nobody built on, and it reads as
  // one — a builder's skip and junk dumped at its kerb (an old sofa, an
  // armchair, a fridge, a washer), a shopping cart left in the grass. One
  // piece per ~25 cells, at least three cells apart.
  const fieldSeen = new Uint8Array(N)
  const JUNK = [PROP_DUMPSTER, FURN_SOFA, FURN_ARMCHAIR, FURN_FRIDGE, PROP_CART, FURN_WASHER]
  for (let i0 = 0; i0 < N; i0++) {
    if (ext[i0] !== EXT_FIELD || fieldSeen[i0]) continue
    const comp = []
    const q = [i0]
    fieldSeen[i0] = 1
    while (q.length) {
      const i = q.pop()
      comp.push(i)
      const gx = i % TILE_W
      const gz = (i - gx) / TILE_W
      for (const [dx, dz] of NEIGHBOURS) {
        const nx = gx + dx
        const nz = gz + dz
        if (!inTile(nx, nz) || ext[at(nx, nz)] !== EXT_FIELD || fieldSeen[at(nx, nz)] || !passable(gx, gz, nx, nz)) continue
        fieldSeen[at(nx, nz)] = 1
        q.push(at(nx, nz))
      }
    }
    if (comp.length < 12) continue
    const want = Math.min(5, Math.round(comp.length / 25) || 1)
    const kerbSide = (i) => {
      const gx = i % TILE_W
      const gz = (i - gx) / TILE_W
      return NEIGHBOURS.find(([dx, dz]) => isStreet(gx + dx, gz + dz)) ?? null
    }
    // The kerb cells first (the dump), then the rest in a hashed order.
    const order = comp.map((i) => [(kerbSide(i) ? 0 : 1 << 24) + (r(i, 24) & 0xffffff), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, i]) => i)
    const taken = []
    let k = r(i0, 25) % JUNK.length
    for (const i of order) {
      if (taken.length >= want) break
      const gx = i % TILE_W
      const gz = (i - gx) / TILE_W
      if (taken.some((j) => Math.max(Math.abs((j % TILE_W) - gx), Math.abs(Math.floor(j / TILE_W) - gz)) < 3)) continue
      const side = kerbSide(i)
      const facing = side ? vecFacing(side[0], side[1]) : FACING.S
      if (place([{ gx, gz }], JUNK[k % JUNK.length], { facing }, 'junk')) {
        taken.push(i)
        k++
      }
    }
  }

  fp.compile(map, cy)

  // The attics (storey 1, one plan per two-storey house: its chunk only), the
  // owned seam lines, then the stair cores through the kit.
  const twoStorey = L.houses.filter((h) => h.forced)
  for (const h of twoStorey) atticPlan(h).compile(map, ATTIC)
  openOwnedSeam(map, ctx, GROUND, 'west')
  openOwnedSeam(map, ctx, GROUND, 'north')
  for (const h of twoStorey) {
    const plan2 = corePlan(h)
    if (plan2.error) return { error: `suburb: stair core of house ${h.index}: ${plan2.error}` }
    ctx.kit.stairwell(map, plan2, { enclosed: true })
  }

  // Interiors. The first house of each model and frontage axis is built room
  // by room with createRoom (the hotel family's residential furnishing
  // grammar); every later house of that model and axis repeats it exactly —
  // same doors, furniture copied and reflected with the plan — so next door
  // is the same house, mirrored (doc 10.6). A model cycle "XY" closes a loop
  // inside the house: Y is furnished first, X's createRoom door then opens
  // into a free cell of Y, and X's hall door is added where X kept a free cell.
  const canon = new Map() // `${model}:${axis}` -> {doors, extra, items} in the model frame
  const free = (c) => !map.cellAt(c.gx, cy, c.gz).col
  const toEdge = (h, [p, q]) => edgeBetween(houseCellOf(h, p.u, p.v), houseCellOf(h, q.u, q.v))
  const setDoor = (e) => (e.axis === 'v' ? map.setWallV(e.gx, cy, e.gz, 0, PASSAGE_DOOR) : map.setWallH(e.gx, cy, e.gz, 0, PASSAGE_DOOR))
  const rectOf = (h, rm) => {
    const a = houseCellOf(h, rm.u0, rm.v0)
    const b = houseCellOf(h, rm.u1, rm.v1)
    return { x0: Math.min(a.gx, b.gx), z0: Math.min(a.gz, b.gz), x1: Math.max(a.gx, b.gx), z1: Math.max(a.gz, b.gz) }
  }
  let twins = 0
  let cycles = 0
  for (const h of L.houses) {
    const { model } = h
    if (model.twoStorey) {
      buildTwoStorey(map, h, r)
      continue
    }
    const via = new Map(model.cycles.map((c) => [c[0], c[1]])) // X -> Y
    const roomOrder = [...model.rooms].sort((p, q) => (via.has(p.key) ? 1 : 0) - (via.has(q.key) ? 1 : 0))
    const ck = `${model.index}:${axisOf(h.face)}`
    const source = canon.get(ck)
    const rooms = new Map()
    if (!source) {
      const doors = new Map()
      const extra = []
      for (const rm of roomOrder) {
        let door = rm.door
        const Y = via.has(rm.key) && model.rooms.find((o) => o.key === via.get(rm.key))
        if (Y) door = sharedEdges(rm, Y).find(([, q]) => free(houseCellOf(h, q.u, q.v))) ?? rm.door
        doors.set(rm.key, door)
        const room = createRoom(map, {
          cy, ...rectOf(h, rm), role: rm.role, salt: r(model.index * 16 + model.rooms.indexOf(rm), 15) & 0xffff,
          door: toEdge(h, door), lamp: false,
        })
        rooms.set(rm.key, room)
      }
      for (const rm of roomOrder) {
        if (doors.get(rm.key) === rm.door) continue
        const hallDoor = hallEdges(model, rm).find(([p]) => free(houseCellOf(h, p.u, p.v)))
        if (hallDoor) extra.push(hallDoor)
      }
      for (const e of extra) setDoor(toEdge(h, e))
      const items = []
      const fr = frameOf(h)
      for (const room of rooms.values()) {
        for (let gz = room.z0; gz <= room.z1; gz++) {
          for (let gx = room.x0; gx <= room.x1; gx++) {
            const f = map.furnitureAt(gx, cy, gz)
            if (f) items.push(toModel(fr, gx, gz, f.rec, map))
          }
        }
      }
      canon.set(ck, { doors, extra, items })
      cycles += extra.length
    } else {
      twins++
      for (const rm of roomOrder) rooms.set(rm.key, stampRoom(map, { cy, ...rectOf(h, rm), role: rm.role, salt: 0, door: toEdge(h, source.doors.get(rm.key)) }))
      for (const e of source.extra) setDoor(toEdge(h, e))
      const fr = frameOf(h)
      for (const it of source.items) {
        const c = houseCellOf(h, it.u, it.v)
        map.addFurniture(c.gx, cy, c.gz, fromModel(fr, c, it, map))
      }
      cycles += source.extra.length
    }
    h.rooms = model.rooms.map((rm) => rooms.get(rm.key))
  }

  // Touch-ups after the room stamps (createRoom rewrites its perimeter as
  // plain wall): front windows (and back ones over the yard), then the
  // houses' lamps by wake state.
  let windows = 0
  for (const h of L.houses) {
    const { model } = h
    const isRoom = (u, v) => model.rooms.some((rm) => u >= rm.u0 && u <= rm.u1 && v >= rm.v0 && v <= rm.v1)
    for (let u = 0; u < model.W; u++) {
      if (isRoom(u, 0)) {
        const e = edgeBetween(houseCellOf(h, u, 0), houseCellOf(h, u, -1))
        featureEdge(map, e.axis, e.gx, cy, e.gz, WALL_WINDOW)
        windows++
      }
      if (h.yard > 0 && u % 2 === 0 && isRoom(u, model.D - 1)) {
        const e = edgeBetween(houseCellOf(h, u, model.D - 1), houseCellOf(h, u, model.D))
        featureEdge(map, e.axis, e.gx, cy, e.gz, WALL_WINDOW)
        windows++
      }
    }
    // One lamp per room; the wake state picks which burn. A lit window's
    // lamp hangs just inside the street window (Hido's one lit window: its
    // glow falls out over the lawn), the room's other lamps at its centre.
    const front = model.rooms.find((rm) => rm.v0 === 0 && rm.role !== SPACE_ROLE_BATHROOM) ?? model.rooms[0]
    // Someone up has a second room lit deeper in the house (the kitchen when
    // there is one; low behind the TV).
    const deeper = model.rooms.filter((rm) => rm !== front && rm.role !== SPACE_ROLE_BATHROOM)
    const second = deeper.find((rm) => rm.key === 'K') ?? deeper[r(h.index, 19) % Math.max(1, deeper.length)]
    model.rooms.forEach((rm, i) => {
      const room = h.rooms[i]
      let gx = Math.floor((room.x0 + room.x1) / 2)
      let gz = Math.floor((room.z0 + room.z1) / 2)
      let lit = false
      let tint = null
      if (h.wake === 'window' && rm === front) {
        ;[lit, tint] = [true, TINT_ROOM]
        const c = houseCellOf(h, Math.floor((rm.u0 + rm.u1) / 2), 0)
        if (map.cellAt(c.gx, cy, c.gz).col === 0) ({ gx, gz } = c)
      }
      if (h.wake === 'window' && rm === second) [lit, tint] = [true, TINT_ROOM]
      if (h.wake === 'tv' && rm === second && rm.role !== SPACE_ROLE_LIVING) [lit, tint] = [true, TINT_NIGHT]
      if (h.wake === 'tv' && rm.role === SPACE_ROLE_LIVING) [lit, tint] = [true, TINT_TV]
      if (h.wake === 'exit') [lit, tint] = [true, TINT_EXIT]
      map.setLamp(gx, cy, gz, lit, tint ?? undefined)
    })
    // The hall light: on in a house where someone is up with a lamp (and
    // in the anchor tile's lit house), dead otherwise.
    const hall = houseCellOf(h, model.front.u, model.front.v)
    const hallLit = h.wake === 'exit' || h.wake === 'window' || h.wake === 'tv'
    map.setLamp(hall.gx, cy, hall.gz, hallLit, hallLit ? (h.wake === 'exit' ? TINT_EXIT : h.wake === 'tv' ? TINT_NIGHT : TINT_ROOM) : undefined)
  }

  // Bare ground a new light may go on: open exterior cells off the seams,
  // free of props and door fronts (lightFloor's last resort).
  const bare = []
  for (let gz = 1; gz < TILE_D - 1; gz++) {
    for (let gx = 1; gx < TILE_W - 1; gx++) {
      const i = at(gx, gz)
      if (ext[i] && !blocked[i] && !doorFront[i]) bare.push({ gx, gz, street: ext[i] === EXT_STREET || ext[i] === EXT_FIELD })
    }
  }
  const relit = lightFloor(map, L, poles, bare, r)

  // The exit: the far end of the first two-storey house's attic hall (every
  // tile marks it; the hook reads the anchor tile's).
  const exit = { ...L.exitHouse.forced.exit }
  markExit(map, ctx, exit)
  if (L.spawn) markSpawn(map, ctx, L.spawn)
  finishTile(map, ctx, L, r)

  const nd = L.noFrontDoor
  const models = new Set(L.houses.filter((h) => !h.forced).map((h) => h.model.name))
  const wake = { dark: 0, porch: 0, window: 0, tv: 0, exit: 0 }
  for (const h of L.houses) wake[h.wake]++
  const notes = [
    `plan: ${plan.spine.warp.some(Boolean) ? 'warped ' : ''}${plan.axis === 'x' ? 'east-west' : 'north-south'} spine${plan.parallel ? ` and a parallel street (${plan.parallel.connectors.length} connector(s))` : ''}, ${plan.stems} cul-de-sac stem(s), ${plan.bulbs.length} bulb(s); ports W ${plan.ports.W.join('/')}, E ${plan.ports.E.join('/')}, N ${plan.ports.N.join('/')}, S ${plan.ports.S.join('/')}${plan.attempt ? `; attempt ${plan.attempt}` : ''}`,
    `${L.houses.length} houses (${twoStorey.length} two-storey) from ${models.size} models (${[...models].join(', ')}); ${twins} furnished as mirror copies of the first of their model`,
    `light: ${litPoles} junction/bulb lights burning of ${poles.length} poles; houses ${wake.porch} porch, ${wake.window} lit window, ${wake.tv} TV, ${wake.dark} dark${L.anchor ? ', the anchor house burning' : ''}; dim chunks relit: ${relit.inside} lights left on indoors, ${relit.porch} porch lights left on, ${relit.pole} streetlights flickering, ${relit.back} back-porch bulbs, ${relit.added} new lamps`,
    `look at: ${nd ? `the house at ${nd.outside.gx},${nd.outside.gz} has no front door (door cell ${nd.frontDoor.gx},${nd.frontDoor.gz})` : 'every house has its front door'}; ${windows} front/back windows; ${cycles} room-to-room doors; ${pickets} picket rails; ${opened} fence(s) opened by the repair pass`,
    `props: ${counts.mailbox} mailboxes, ${counts.bin} wheelie bins at the kerb, ${counts.gnome} gnomes, ${counts.bike} bikes, ${counts.doghouse} doghouses, ${counts.patio} patio pieces, ${counts.yardkit} yard benches/bins, ${counts.junk} pieces of junk on vacant lots`,
  ]
  ctx.notes.push(...notes)
  if (L.anomaly) ctx.notes.push(`anomaly: ${L.anomaly}`)
  return { spawn: L.spawn, exit, notes }
}

// --- the light floor -----------------------------------------------------------------

// Every street-level chunk keeps a few lights burning (doc §1: "a porch
// light here, a blue TV glow there"; §8: houses supply almost all the
// light, with rare lit pools): a chunk the wake states and the streetlights
// left with fewer than CHUNK_LIT lit fixtures gets, in order, a lamp left on
// deep inside one of its sleeping houses (a bath, a back bedroom: its glow
// stays indoors), a sleeping house's porch and coach lights left on for the
// night, then a dead streetlight flickering back on, then a bulb over a
// back door; a chunk with none of those (a stretch of dead street, a
// vacant lot, deep backyards) gets a new lamp on its bare ground, at least
// LAMP_GAP cells from any fixture: a sodium lamp on a street or field, a
// garden bulb in a yard. The anchor tile, whose one lit house must stay
// unique, only gets streetlights. Returns the counts for the notes.
const CHUNK_LIT = 3
const LAMP_GAP = 4
function lightFloor(map, L, poles, bare, r) {
  const counts = { inside: 0, porch: 0, pole: 0, back: 0, added: 0 }
  const chunkOf = (c) => `${Math.floor(c.gx / CHUNK)},${Math.floor(c.gz / CHUNK)}`
  const fixtures = new Map() // chunk key -> [{ cells, pri, key, on }]
  const add = (cells, pri, key, on) => {
    const k = chunkOf(cells[0])
    if (!fixtures.has(k)) fixtures.set(k, [])
    fixtures.get(k).push({ cells, pri, key, on })
  }
  // A light left on deep inside a sleeping house (a bath, a back bedroom):
  // its glow stays indoors, so the street stays dark.
  for (const h of L.houses) {
    if (L.anchor || (h.wake !== 'dark' && h.wake !== 'porch')) continue
    // The rooms off the street front, one per house before a second.
    const back = h.model.rooms.map((rm, i) => ({ rm, room: h.rooms[i] })).filter(({ rm, room }) => room && rm.v0 > 0)
    const first = back.length ? r(h.index, 64) % back.length : 0
    back.forEach(({ room }, j) => {
      const c = { gx: Math.floor((room.x0 + room.x1) / 2), gz: Math.floor((room.z0 + room.z1) / 2) }
      const lamp = map.lampAt(c.gx, GROUND, c.gz)
      if (!lamp || lamp.rec.lit) return
      add([c], j === first ? 0 : 1, r(h.index, 65 + j), () => {
        counts.inside++
        map.setLamp(c.gx, GROUND, c.gz, true, TINT_ROOM)
      })
    })
  }
  for (const h of L.houses) {
    if (L.anchor || h.porchLit || h === L.noFrontDoor) continue
    const drive = lotCell(h, 0, h.lawn)
    add([h.outside, drive], 2, r(h.index, 60), () => {
      h.porchLit = true
      counts.porch++
      for (const c of [h.outside, drive]) map.setLamp(c.gx, GROUND, c.gz, true, TINT_PORCH)
    })
  }
  poles.forEach((p, i) => {
    if (map.lampAt(p.gx, GROUND, p.gz)?.rec.lit) return
    add([p], 3, r(p.gx, p.gz + 61) + i, () => {
      counts.pole++
      map.setLamp(p.gx, GROUND, p.gz, true, TINT_STREET)
    })
  })
  for (const h of L.houses) {
    if (L.anchor || !h.backDoor) continue
    const c = houseCellOf(h, h.model.back.u, h.model.D)
    if (map.lampAt(c.gx, GROUND, c.gz)) continue
    add([c], 4, r(h.index, 62), () => {
      counts.back++
      map.setLamp(c.gx, GROUND, c.gz, true, TINT_PORCH)
    })
  }
  for (const c of bare) {
    if (L.anchor && !c.street) continue
    add([c], 5, r(c.gx, c.gz + 63), () => {
      for (let z = c.gz - LAMP_GAP + 1; z < c.gz + LAMP_GAP; z++) {
        for (let x = c.gx - LAMP_GAP + 1; x < c.gx + LAMP_GAP; x++) if (map.lampAt(x, GROUND, z)) return
      }
      counts.added++
      map.setLamp(c.gx, GROUND, c.gz, true, c.street ? TINT_STREET : TINT_PORCH)
    })
  }
  for (let lcz = 0; lcz < TILE_D / CHUNK; lcz++) {
    for (let lcx = 0; lcx < TILE_W / CHUNK; lcx++) {
      const d = map.chunkAt(lcx, GROUND, lcz)
      const list = fixtures.get(`${lcx},${lcz}`)
      if (!d || !list) continue
      const litNow = () => d.lamps.filter((l) => l.lit).length
      if (litNow() >= CHUNK_LIT) continue
      list.sort((a, b) => a.pri - b.pri || a.key - b.key)
      for (const f of list) {
        f.on()
        if (litNow() >= CHUNK_LIT) break
      }
    }
  }
  return counts
}

// --- the two-storey house ------------------------------------------------------------

const coreSpace = (h) => 2000 + h.forced.slot
const atticHallSpace = (h) => 3000 + h.forced.slot

// The upstairs plan (storey 1) of two-storey house h: its outline only,
// inside its one upstairs chunk — the upstairs hall, the core and the rooms'
// placeholder cells; the eaves ('#', the knee walls under the roof) stay
// mass.
function atticPlan(h) {
  const { model, attic } = h
  const a = houseCellOf(h, 0, 0)
  const b = houseCellOf(h, model.W - 1, model.D - 1)
  const p = new FloorPlan({ x0: Math.min(a.gx, b.gx), z0: Math.min(a.gz, b.gz), x1: Math.max(a.gx, b.gx), z1: Math.max(a.gz, b.gz) })
  for (let v = 0; v < model.D; v++) {
    for (let u = 0; u < model.W; u++) {
      if (attic.eaves.some((m) => m.u === u && m.v === v)) continue
      const c = houseCellOf(h, u, v)
      const hall = attic.halls.some((m) => m.u === u && m.v === v)
      if (inCore(model, u, v)) p.open(c.gx, c.gz, CELL_ROOM, coreSpace(h), SPACE_ROLE_NONE)
      else p.open(c.gx, c.gz, hall ? CELL_ROOM : CELL_CORRIDOR, hall ? atticHallSpace(h) : 0, SPACE_ROLE_NONE)
    }
  }
  return p
}

// The switchback core of house h: its model's 6×4 core, one flight from
// storey 0 to the upstairs along the frontage; its door opens onto the hall
// row before it (coreSide 'front') or behind it ('back'), on both storeys.
const STAIR_DIR = Object.freeze({ E: STAIR_E, W: STAIR_W, N: STAIR_N, S: STAIR_S })
function corePlan(h) {
  const c = h.forced.core
  const dir = STAIR_DIR[h.forced.dir]
  const horizontal = dir === STAIR_E || dir === STAIR_W
  const gx = dir === STAIR_W ? c.x1 - 1 : c.x0 + 1
  const gz = dir === STAIR_N ? c.z1 - 1 : c.z0 + 1
  const k = h.model.core
  const hall = houseCellOf(h, k.u0, h.forced.coreSide === 'front' ? k.v0 - 1 : k.v1 + 1)
  const near = horizontal ? hall.gz < c.z0 : hall.gx < c.x0
  return stairwellPlan({ gx, gz, baseCy: GROUND, topCy: ATTIC, dir, doorSide: near ? 'near' : 'far' })
}

// The two-storey house's rooms: its model's ground-floor rooms on storey 0,
// its upstairs plan's rooms on storey 1 (bedrooms, a bath, a box room, a
// laundry or a bonus room, by the plan geometry hashed for the house;
// anomaly 'upstairs', first house: the ground floor again — same rects,
// roles and doors, their shells stamped bare here and the ground floor's
// furniture copied piece for piece by finishTile), with the lamps of both
// storeys by wake state.
function buildTwoStorey(map, h, r) {
  const { model, attic: plan } = h
  const rect = (rm) => {
    const a = houseCellOf(h, rm.u0, rm.v0)
    const b = houseCellOf(h, rm.u1, rm.v1)
    return { x0: Math.min(a.gx, b.gx), z0: Math.min(a.gz, b.gz), x1: Math.max(a.gx, b.gx), z1: Math.max(a.gz, b.gz) }
  }
  const doorOf = (rm) => edgeBetween(houseCellOf(h, rm.door[0].u, rm.door[0].v), houseCellOf(h, rm.door[1].u, rm.door[1].v))
  const salts = model.rooms.map((rm, i) => r(h.index * 16 + i, 31) & 0xffff)
  h.rooms = model.rooms.map((rm, i) => createRoom(map, {
    cy: GROUND, ...rect(rm), role: rm.role, salt: salts[i], door: doorOf(rm), lamp: false,
  }))
  const repeat = h.forced.atticPlan < 0
  // createRoom's dice key on the room id as well as the salt, so a re-run
  // would furnish the repeated rooms differently: they get bare shells and
  // the ground floor's pieces (h.repeatRooms, copied after the prop cap).
  const atticRooms = repeat
    ? model.rooms.map((rm, i) => stampRoom(map, { cy: ATTIC, ...rect(rm), role: rm.role, salt: salts[i], door: doorOf(rm) }))
    : plan.rooms.map((rm, i) => createRoom(map, {
      cy: ATTIC, ...rect(rm), role: ATTIC_ROLE[rm.key], salt: r(h.index * 16 + i, 33) & 0xffff, door: doorOf(rm), lamp: false,
    }))
  if (repeat) h.repeatRooms = h.rooms
  // Upstairs lamps: one per room and one in the hall, lit with the house
  // (a lit window), dark otherwise; the bonus room's TV burns blue in a
  // house that stays up watching.
  const lit = h.wake === 'exit' || h.wake === 'window'
  const tint = h.wake === 'exit' ? TINT_EXIT : TINT_ROOM
  atticRooms.forEach((room, i) => {
    const tv = !repeat && h.wake === 'tv' && plan.rooms[i].key === 'Y'
    const on = lit || tv
    map.setLamp(Math.floor((room.x0 + room.x1) / 2), ATTIC, Math.floor((room.z0 + room.z1) / 2), on, on ? (tv ? TINT_TV : tint) : undefined)
  })
  // The upstairs hall keeps a night light burning (a climb never ends in
  // total darkness) in every house but the sleeping ones of the anchor tile.
  const hall = houseCellOf(h, plan.lamp.u, plan.lamp.v)
  const night = lit || !h.anchorTile
  map.setLamp(hall.gx, ATTIC, hall.gz, night, night ? (lit ? tint : TINT_NIGHT) : undefined)
  // Ground floor lamps (the room loop of buildSuburbTile covers them too).
  h.atticRooms = atticRooms
}

// After everything is drawn: plates, the 'nine' anomaly, the world's lamp
// and prop-kind caps.
function finishTile(map, ctx, L, r) {
  const k = ctx.key
  const nine = L.anomaly === 'nine' ? nineRowOf(ctx.worldSeed, k) : -1
  for (let lcz = 0; lcz < 3; lcz++) {
    for (let lcx = 0; lcx < 5; lcx++) labelFloor(map, GROUND, lcz === nine ? '9' : plateOf(ctx.worldSeed, k, GROUND, lcx, lcz), { cx: lcx, cz: lcz })
  }
  for (const h of L.houses) {
    if (h.forced) labelFloor(map, ATTIC, plateOf(ctx.worldSeed, k, ATTIC, h.forced.up.lcx, h.forced.up.lcz), { cx: h.forced.up.lcx, cz: h.forced.up.lcz })
  }
  // Lamps under the stair cores' openings would hang in mid-air.
  for (const d of map.chunks.values()) d.lamps = d.lamps.filter((l) => !d.hasCeilHole(l.lx, l.lz))
  capLitLamps(map, r, LIT_CAP)
  const capped = capPropKinds(map, PROP_KIND_CAP)
  // After the cap: a dropped piece can leave a free cell boxed in by others
  // (only a room holding a freed cell needs the check).
  if (capped.size) {
    const freedIn = (room) => {
      for (let gz = room.z0; gz <= room.z1; gz++) {
        for (let gx = room.x0; gx <= room.x1; gx++) {
          const d = map.chunkAt(map.cellChunk(gx), room.cy, map.cellChunk(gz))
          if (capped.get(d)?.has(cIdx(map.cellLocal(gx), map.cellLocal(gz)))) return true
        }
      }
      return false
    }
    for (const room of map.rooms) if (freedIn(room)) unboxRoom(map, room)
    for (const cy of [GROUND, ATTIC]) unboxFreed(map, capped, cy)
  }
  // Anomaly 'upstairs': the attic's living room and kitchen get the ground
  // floor's furniture, cell for cell (after the cap, so both storeys keep the
  // same pieces; the door edges match, so every piece stays reachable).
  for (const h of L.houses) {
    for (const room of h.repeatRooms ?? []) {
      for (let gz = room.z0; gz <= room.z1; gz++) {
        for (let gx = room.x0; gx <= room.x1; gx++) {
          for (const { rec } of map.furnitureListAt(gx, GROUND, gz)) {
            const { lx: _lx, lz: _lz, ...piece } = rec
            map.addFurniture(gx, ATTIC, gz, piece)
          }
        }
      }
    }
  }
}

// No free cell of a room may be boxed in by its furniture (the prop-kind cap
// frees cells the furnishing grammar had filled, which can leave a corner
// sealed off behind a sofa). Free cells are flooded from every open
// perimeter edge; while some stay unreached, the piece that bridges them to
// the reached ones (or, failing that, the first one beside them) is taken out.
function unboxRoom(map, room) {
  const { cy, x0, z0, x1, z1 } = room
  const inRoom = (gx, gz) => gx >= x0 && gx <= x1 && gz >= z0 && gz <= z1
  const free = (gx, gz) => map.cellAt(gx, cy, gz).col === 0
  const open = (a, b) => {
    const e = edgeBetween(a, b)
    return (e.axis === 'v' ? map.wallVAt(e.gx, cy, e.gz) : map.wallHAt(e.gx, cy, e.gz)).wall !== 1
  }
  const W = x1 - x0 + 1
  const N = W * (z1 - z0 + 1)
  const idx = (gx, gz) => (gz - z0) * W + (gx - x0)
  for (let guard = 0; guard < N; guard++) {
    const reached = new Uint8Array(N)
    const stack = []
    let freeCells = 0
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        if (!free(gx, gz)) continue
        freeCells++
        const c = { gx, gz }
        const entry = NEIGHBOURS.some(([dx, dz]) => {
          const n = { gx: gx + dx, gz: gz + dz }
          return !inRoom(n.gx, n.gz) && map.chunkAt(map.cellChunk(n.gx), cy, map.cellChunk(n.gz)) && free(n.gx, n.gz) && open(c, n)
        })
        if (entry) { reached[idx(gx, gz)] = 1; stack.push(c) }
      }
    }
    if (!stack.length) return
    let reachedCells = stack.length
    while (stack.length) {
      const c = stack.pop()
      for (const [dx, dz] of NEIGHBOURS) {
        const n = { gx: c.gx + dx, gz: c.gz + dz }
        if (!inRoom(n.gx, n.gz) || reached[idx(n.gx, n.gz)] || !free(n.gx, n.gz) || !open(c, n)) continue
        reached[idx(n.gx, n.gz)] = 1
        reachedCells++
        stack.push(n)
      }
    }
    if (reachedCells === freeCells) return
    let bridge = null
    let beside = null
    for (let gz = z0; gz <= z1 && !bridge; gz++) {
      for (let gx = x0; gx <= x1 && !bridge; gx++) {
        if (free(gx, gz) || !map.furnitureAt(gx, cy, gz)) continue
        const c = { gx, gz }
        let toPocket = false
        let toReached = false
        for (const [dx, dz] of NEIGHBOURS) {
          const n = { gx: gx + dx, gz: gz + dz }
          if (!inRoom(n.gx, n.gz) || !free(n.gx, n.gz) || !open(c, n)) continue
          if (reached[idx(n.gx, n.gz)]) toReached = true
          else toPocket = true
        }
        if (toPocket && toReached) bridge = c
        else if (toPocket && !beside) beside = c
      }
    }
    const take = bridge ?? beside
    if (!take) return
    map.removeFurniture(take.gx, cy, take.gz)
  }
}

// A piece the cap dropped frees its cell, and the yard props' articulation
// test counted that cell as blocked: a freed dead-end cell (a side-yard
// strip's end, its mouth holding another piece) can be left sealed off. Each
// freed cell floods through free cells and open edges until it meets a cell
// that was free before the cap (the walk graph); a pocket that meets none
// takes out the first piece on its rim, and floods again.
function unboxFreed(map, capped, cy) {
  const W = TILE_W
  const freed = new Uint8Array(TILE_W * TILE_D)
  const list = []
  for (let gz = 0; gz < TILE_D; gz++) {
    for (let gx = 0; gx < TILE_W; gx++) {
      const d = map.chunkAt(map.cellChunk(gx), cy, map.cellChunk(gz))
      if (!capped.get(d)?.has(cIdx(map.cellLocal(gx), map.cellLocal(gz)))) continue
      freed[gz * W + gx] = 1
      list.push({ gx, gz })
    }
  }
  const inTile = (gx, gz) => gx >= 0 && gz >= 0 && gx < TILE_W && gz < TILE_D && !!map.chunkAt(map.cellChunk(gx), cy, map.cellChunk(gz))
  const free = (gx, gz) => inTile(gx, gz) && map.cellAt(gx, cy, gz).col === 0
  const open = (a, b) => {
    const e = edgeBetween(a, b)
    return (e.axis === 'v' ? map.wallVAt(e.gx, cy, e.gz) : map.wallHAt(e.gx, cy, e.gz)).wall !== 1
  }
  for (const f of list) {
    for (let guard = 0; guard < 64; guard++) {
      if (!free(f.gx, f.gz)) break
      const seen = new Set([f.gz * W + f.gx])
      const stack = [f]
      const pocket = []
      let joined = false
      while (stack.length && !joined) {
        const c = stack.pop()
        pocket.push(c)
        for (const [dx, dz] of NEIGHBOURS) {
          const n = { gx: c.gx + dx, gz: c.gz + dz }
          const i = n.gz * W + n.gx
          if (seen.has(i) || !free(n.gx, n.gz) || !open(c, n)) continue
          if (!freed[i]) { joined = true; break }
          seen.add(i)
          stack.push(n)
        }
      }
      if (joined) break
      let take = null
      for (const c of pocket) {
        for (const [dx, dz] of NEIGHBOURS) {
          const n = { gx: c.gx + dx, gz: c.gz + dz }
          if (take || !inTile(n.gx, n.gz) || !open(c, n) || !map.furnitureAt(n.gx, cy, n.gz)) continue
          take = n
        }
      }
      if (!take) break
      map.removeFurniture(take.gx, cy, take.gz)
      freed[take.gz * W + take.gx] = 1
    }
  }
}

// At most `cap` lit lamps per chunk-storey (spec §11.1 item 9). A chunk over
// the cap keeps the `cap` lamps whose dice rank lowest lit and turns the rest
// into dead fixtures.
const LIT_CAP = 12
function capLitLamps(map, r, cap) {
  for (const d of map.chunks.values()) {
    const lit = d.lamps.filter((l) => l.lit)
    if (lit.length <= cap) continue
    const rank = (l) => r(1000 + d.cy * 256 + l.lx * 16 + l.lz, d.cx * 64 + d.cz)
    lit.sort((a, b) => rank(a) - rank(b) || a.lx - b.lx || a.lz - b.lz)
    for (const l of lit.slice(cap)) l.lit = false
  }
}

// At most `cap` distinct furniture/prop kinds per chunk (spec §11.1 item 9).
// A chunk over the cap loses every piece of its rarest kinds (fewest pieces,
// then highest kind id); freeing a cell never cuts a room, but can leave a
// free cell boxed in (unboxRoom). Returns the cells it freed: chunk -> Set.
const PROP_KIND_CAP = 14
function capPropKinds(map, cap) {
  const capped = new Map()
  for (const d of map.chunks.values()) {
    const count = new Map()
    for (const f of d.furniture) count.set(f.kind, (count.get(f.kind) ?? 0) + 1)
    if (count.size <= cap) continue
    const drop = new Set([...count].sort((a, b) => a[1] - b[1] || b[0] - a[0]).slice(0, count.size - cap).map(([kind]) => kind))
    const gone = d.furniture.filter((f) => drop.has(f.kind))
    d.furniture = d.furniture.filter((f) => !drop.has(f.kind))
    const freed = new Set()
    for (const f of gone) {
      if (d.furniture.some((o) => o.lx === f.lx && o.lz === f.lz)) continue
      d.cols[cIdx(f.lx, f.lz)] = 0
      freed.add(cIdx(f.lx, f.lz))
    }
    capped.set(d, freed)
  }
  return capped
}

// --- twin furniture: the model frame of a house, any facing ---------------------------

// The metric frame of house h: unit cell steps of +u and +v, and the world
// corner (metres, tile-local) of the model's (0, 0) corner.
function frameOf(h) {
  const c00 = houseCellOf(h, 0, 0)
  const c10 = houseCellOf(h, 1, 0)
  const c01 = houseCellOf(h, 0, 1)
  const du = { x: c10.gx - c00.gx, z: c10.gz - c00.gz }
  const dv = { x: c01.gx - c00.gx, z: c01.gz - c00.gz }
  return {
    c00,
    du,
    dv,
    ox: (c00.gx + (du.x < 0 || dv.x < 0 ? 1 : 0)) * CELL,
    oz: (c00.gz + (du.z < 0 || dv.z < 0 ? 1 : 0)) * CELL,
  }
}

const FACING_VEC = Object.freeze({ [FACING.S]: [0, 1], [FACING.N]: [0, -1], [FACING.E]: [1, 0], [FACING.W]: [-1, 0] })
const vecFacing = (x, z) => (x > 0 ? FACING.E : x < 0 ? FACING.W : z > 0 ? FACING.S : FACING.N)

// A furniture record → the model frame (cell, metres, facing as a model
// direction), and back into another house of the same model and axis.
function toModel(fr, gx, gz, rec, map) {
  const X = map.cellChunk(gx) * CHUNK * CELL + rec.x - fr.ox
  const Z = map.cellChunk(gz) * CHUNK * CELL + rec.z - fr.oz
  const [fx, fz] = FACING_VEC[rec.facing & 3]
  return {
    u: fr.du.x * (gx - fr.c00.gx) + fr.du.z * (gz - fr.c00.gz),
    v: fr.dv.x * (gx - fr.c00.gx) + fr.dv.z * (gz - fr.c00.gz),
    U: fr.du.x * X + fr.du.z * Z,
    V: fr.dv.x * X + fr.dv.z * Z,
    fu: fr.du.x * fx + fr.du.z * fz,
    fv: fr.dv.x * fx + fr.dv.z * fz,
    high: rec.facing & ~3,
    rec,
  }
}

function fromModel(fr, c, it, map) {
  const X = fr.ox + fr.du.x * it.U + fr.dv.x * it.V
  const Z = fr.oz + fr.du.z * it.U + fr.dv.z * it.V
  const { lx: _lx, lz: _lz, ...rest } = it.rec
  return {
    ...rest,
    x: X - map.cellChunk(c.gx) * CHUNK * CELL,
    z: Z - map.cellChunk(c.gz) * CHUNK * CELL,
    facing: vecFacing(it.fu * fr.du.x + it.fv * fr.dv.x, it.fu * fr.du.z + it.fv * fr.dv.z) | it.high,
  }
}
