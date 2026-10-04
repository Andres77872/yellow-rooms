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
  SPACE_ROLE_DINING,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_LIVING,
  SPACE_ROLE_NONE,
  WALL_WINDOW,
  featureEdge,
  rng,
} from '../../tiles/floorPlan.js'
import { createRoom, stampRoomShell } from '../../tiles/roomOps.js'
import {
  PROP_DOGHOUSE,
  PROP_GNOME,
  PROP_KIDS_BIKE,
  PROP_MAILBOX,
  PROP_WHEELIE_BIN,
} from '../../props/index.js'

// --- the kind's template (kind-local cells: one 5×3-chunk superblock) ---------

// The kind's dice salt (rng(seed, SALT)).
const SALT = 0x03a1

// One 5 × 3-chunk superblock; plan cells stay inside x 1..68,
// z 1..40 (never on the compiled range's last column or row).
const REGION = Object.freeze({ x0: 0, z0: 0, x1: 69, z1: 41 })
const STREETS = Object.freeze({ S1: Object.freeze([9, 13]), S2: Object.freeze([30, 34]) })
const BULB = 9 // bulb plate side (cells)
const BULB_X = Object.freeze({ W: 1, E: 60 })
const STEM_X = Object.freeze({ W: Object.freeze([1, 17]), E: Object.freeze([52, 68]) })
const CONNECTOR_W = 5
const CONNECTORS = Object.freeze({ W: 18, E: 47 }) // first column; the middle one is seeded
const MID_X = Object.freeze([32, 33]) // both island halves stay ≥ 9 cells: any model fits
const CONNECTOR_Z = Object.freeze([14, 29])

// Lot bands. `face` is the side the street lies on (S = +z, N = −z); each
// band lists its yard, house and lawn rows. Houses on a cul-de-sac bulb sit
// one row further back (the bulb takes their lawn), except in band D, which
// backs onto the map edge (in the world: the tile's south mass row).
const BANDS = Object.freeze([
  { id: 'A', street: 'S1', face: 'S', yard: [1, 2], house: [3, 7], lawn: [8, 8] },
  { id: 'B', street: 'S1', face: 'N', lawn: [14, 14], house: [15, 19], yard: [20, 21] },
  { id: 'C', street: 'S2', face: 'S', yard: [22, 23], house: [24, 28], lawn: [29, 29] },
  { id: 'D', street: 'S2', face: 'N', lawn: [35, 35], house: [36, 40], yard: null },
].map((b) => Object.freeze({ ...b, span: [Math.min(...b.lawn, ...b.house, ...(b.yard ?? [])), Math.max(...b.lawn, ...b.house, ...(b.yard ?? []))] })))

// The cul-de-sac rule of the kind: a house whose frontage overlaps a bulb
// plate steps one row back (band D never). `bulbAt(end)` says whether end
// 'S1W' | 'S1E' | 'S2W' | 'S2E' carries a bulb.
function onBulbOf(band, hx0, W, bulbAt) {
  return band.id !== 'D' && ['W', 'E'].some((e) => {
    const bx = BULB_X[e]
    return bulbAt(`${band.street}${e}`) && hx0 <= bx + BULB - 1 && hx0 + W - 1 >= bx
  })
}
const houseZ0 = (band, onBulb) => band.house[0] + (onBulb ? (band.face === 'S' ? -1 : 1) : 0)

// Sleeping suburb (docs/liminal_maps/03-sleeping-suburb.md): one superblock
// of a post-war tract at 3 AM. Two parallel streets (5-cell open strips)
// joined by three connectors make the loop collector; their ends run out as
// cul-de-sac stems into 9×9 rounded bulbs, so the street graph is dendritic
// (dead ends, T junctions, no crossroads). Lots front every street: a lawn,
// a house built from one of five room-cluster models (mirrored in pairs, the
// Levittown way), a backyard. Rear and side lot lines carry privacy fences
// with gaps and gates, so the yards between the two streets read as a fence
// maze; some front lawns carry picket fences (rails). Light comes from the
// houses: each one wakes (porch light, one lit window, a blue TV) or sleeps,
// and most streetlights are dead.
//
// THE FINITE PROTOTYPE (the editor kind's map, byte-identical; wrapped by
// src/editor/kinds/suburb.js). The world does NOT
// repeat this layout: the suburb family's tile program (tile.js) composes
// every tile from a seeded street grammar (geometry.js suburbPlan) and takes
// only this file's parts — the house models, their room stamping and twin
// furnishing, the tints — as its catalogue.

export const TINT_PORCH = 0xffb060 // 2700 K porch bulb
export const TINT_ROOM = 0xffd8a8 // a warm lamp behind curtains
export const TINT_TV = 0x6f8cff // blue television glow
export const TINT_STREET = 0xffc27a // the odd sodium streetlight still burning (the record's lampTint)

// House models in their own frame: row 0 is the street front, 'h' the hall
// (front door on its first front-row cell, back door on its first back-row
// cell), letters are createRoom rooms (2×2 or 4×1 at least, so the
// furnishing grammar always has three free cells). `cycles` name room pairs
// that get a second, connecting door once furnished.
export const ROLE_OF = {
  L: SPACE_ROLE_LIVING,
  K: SPACE_ROLE_KITCHEN,
  D: SPACE_ROLE_DINING,
  B: SPACE_ROLE_BATHROOM,
  R: SPACE_ROLE_BEDROOM,
  S: SPACE_ROLE_BEDROOM,
  U: SPACE_ROLE_LAUNDRY,
}
export const MODEL_DEFS = [
  { name: 'ranch', rows: ['LLhKKDD', 'LLhKKDD', 'LLhhhhh', 'BBhRRUU', 'BBhRRUU'], cycles: ['KD', 'RU'] },
  { name: 'long hall', rows: ['LLLhKKKK', 'LLLhKKKK', 'LLLhhhhh', 'BBhhRRDD', 'BBhhRRDD'], cycles: ['RD', 'BL'] },
  { name: 'wide living', rows: ['LLLLhRRR', 'LLLLhRRR', 'KKKhhhhh', 'KKKhSSBB', 'KKKhSSBB'], cycles: ['LK', 'SB'] },
  { name: 'cape', rows: ['BBhLLLL', 'BBhLLLL', 'KKhRRRR', 'KKhRRRR', 'KKhDDDD'], cycles: ['LR', 'DR'] },
  { name: 'foyer', rows: ['KKhhLL', 'KKhhLL', 'RRhhBB', 'RRhhBB', 'RRhhBB'], cycles: ['KR', 'LB'] },
]

export const NEIGHBOURS = [[0, -1], [-1, 0], [1, 0], [0, 1]] // N, W, E, S

export function parseModel(def, index) {
  const D = def.rows.length
  const W = def.rows[0].length
  const at = (u, v) => (u >= 0 && u < W && v >= 0 && v < D ? def.rows[v][u] : null)
  const halls = []
  const rects = new Map()
  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      const c = at(u, v)
      if (c === 'h') {
        halls.push({ u, v })
        continue
      }
      const r = rects.get(c) ?? { key: c, role: ROLE_OF[c], u0: u, v0: v, u1: u, v1: v }
      r.u0 = Math.min(r.u0, u)
      r.v0 = Math.min(r.v0, v)
      r.u1 = Math.max(r.u1, u)
      r.v1 = Math.max(r.v1, v)
      rects.set(c, r)
    }
  }
  const rooms = [...rects.values()]
  for (const r of rooms) {
    // The room's door: the first room cell (row-major) with a hall
    // neighbour, checked N, W, E, S.
    search: for (let v = r.v0; v <= r.v1; v++) {
      for (let u = r.u0; u <= r.u1; u++) {
        for (const [du, dv] of NEIGHBOURS) {
          if (at(u + du, v + dv) === 'h') {
            r.door = [{ u, v }, { u: u + du, v: v + dv }]
            break search
          }
        }
      }
    }
    if (!r.door) throw new Error(`suburb model ${def.name}: room ${r.key} has no hall door`)
  }
  const front = halls.find((c) => c.v === 0)
  const back = halls.find((c) => c.v === D - 1) ?? null
  return { index, name: def.name, W, D, halls, rooms, front, back, cycles: def.cycles }
}

export const SUBURB_MODELS = Object.freeze(MODEL_DEFS.map(parseModel))

// --- layout (pure: seed → streets, lots, houses) -------------------------------

// Lay one frontage run [x0, x1] with lots: each lot is a 1-cell side yard
// (the driveway) and a house. Models come in groups of two or three
// identical houses, alternately mirrored. Groups take the section's models
// in turn (`deal`, shared by every run, so the whole set shows up), skipping
// to the next one that fits twice in what is left, or once. The last lot
// keeps the remainder.
function layLots(run, deal, r, key) {
  const lots = []
  const fits = (x, m, n) => x + n * (m.W + 1) - 1 <= run[1]
  let x = run[0]
  let model = null
  let left = 0
  let flip = false
  for (let k = 0; ; k++) {
    if (!left || !fits(x, model, 1)) {
      const next = deal((m) => m !== model && fits(x, m, 2)) ?? deal((m) => fits(x, m, 1))
      if (!next) break
      model = next
      left = 2 + (r(key, 2 * k + 1) % 4 === 0 ? 1 : 0)
      flip = r(key, 2 * k + 1) % 2 === 1
    }
    lots.push({ x0: x, x1: x + model.W, hx0: x + 1, model, flipX: flip })
    x += model.W + 1
    left--
    flip = !flip
  }
  if (lots.length) lots[lots.length - 1].x1 = run[1]
  return lots
}

// `seed` is the kind's seed.
export function suburbLayout(seed) {
  const r = rng(seed, SALT)
  const mid = MID_X[r(1) % MID_X.length]
  // Four possible cul-de-sacs (both ends of both streets); one may be
  // missing, its stem left as a vacant field.
  const ends = ['S1W', 'S1E', 'S2W', 'S2E']
  const missing = r(2) % 3 === 0 ? ends[r(3) % 4] : null
  const stems = Object.fromEntries(ends.map((e) => [e, e !== missing]))
  const bulbAt = (e) => stems[e]
  // The section's model set: four or five of the five models.
  const drop = r(4) % 6
  const models = SUBURB_MODELS.filter((m) => drop >= SUBURB_MODELS.length || m.index !== drop)
  const order = models.map((m, i) => [r(i, 14), m]).sort((a, b) => a[0] - b[0]).map(([, m]) => m)
  let turn = 0
  const deal = (ok) => {
    for (let i = 0; i < order.length; i++) {
      const m = order[(turn + i) % order.length]
      if (!ok(m)) continue
      turn = (turn + i + 1) % order.length
      return m
    }
    return null
  }

  const runsB = [[1, 17], [23, mid - 1], [mid + 5, 46], [52, 68]]
  const houses = []
  for (const band of BANDS) {
    const runs = band.id === 'A' || band.id === 'D' ? [[1, 68]] : runsB
    runs.forEach((run, ri) => {
      const key = 100 + BANDS.indexOf(band) * 10 + ri
      const lots = layLots(run, deal, r, key)
      lots.forEach((lot, li) => {
        const onBulb = onBulbOf(band, lot.hx0, lot.model.W, bulbAt)
        const hz0 = houseZ0(band, onBulb)
        const hz1 = hz0 + lot.model.D - 1
        houses.push({
          ...lot,
          band,
          run: `${band.id}${ri}`,
          slot: li,
          hz0,
          flipZ: band.face === 'S',
          onBulb,
          // This lot's own rows: its lawn widens and its yard narrows when
          // the house steps back from a bulb.
          lawn: band.face === 'S' ? [hz1 + 1, band.lawn[1]] : [band.lawn[0], hz0 - 1],
          yard: band.yard && (band.face === 'S' ? [band.yard[0], hz0 - 1] : [hz1 + 1, band.yard[1]]),
        })
      })
    })
  }
  houses.forEach((h, i) => {
    h.index = i
    h.frontDoor = houseCell(h, h.model.front.u, h.model.front.v)
    h.outside = houseCell(h, h.model.front.u, -1) // the porch cell
  })

  // Street graph: bulbs (degree 1), the six connector junctions, and the
  // corners where a missing stem leaves a degree-2 bend.
  const junctions = []
  for (const s of ['S1', 'S2']) {
    const zc = (STREETS[s][0] + STREETS[s][1]) >> 1
    for (const [c, x0] of [['W', CONNECTORS.W], ['M', mid], ['E', CONNECTORS.E]]) {
      const degree = 1 + (c !== 'W' || stems[`${s}W`] ? 1 : 0) + (c !== 'E' || stems[`${s}E`] ? 1 : 0)
      junctions.push({ street: s, at: c, gx: x0 + 2, gz: zc, degree })
    }
  }
  const bulbs = ends.filter((e) => stems[e] && bulbAt(e)).map((e) => {
    const s = e.slice(0, 2)
    const zc = (STREETS[s][0] + STREETS[s][1]) >> 1
    const x0 = BULB_X[e[2]]
    return { end: e, x0, z0: zc - 4, gx: x0 + 4, gz: zc, degree: 1 }
  })

  const spawnBulb = bulbs[r(5) % bulbs.length]
  const spawn = { gx: spawnBulb.gx, gz: spawnBulb.gz, cy: 0 }
  // The exit house: the one whose porch is farthest (Manhattan) from the
  // spawn; its porch light is on.
  let exitHouse = houses[0]
  let far = -1
  for (const h of houses) {
    const dist = Math.abs(h.outside.gx - spawn.gx) + Math.abs(h.outside.gz - spawn.gz)
    if (dist > far) [far, exitHouse] = [dist, h]
  }
  // Wake states by quota over a seeded shuffle: 40% dark, 20% porch light,
  // 30% one lit window, 10% TV glow (the exit house always has its porch
  // light on).
  const shuffled = houses.map((h) => [r(h.index, 7), h]).sort((a, b) => a[0] - b[0] || a[1].index - b[1].index)
  shuffled.forEach(([, h], i) => {
    const q = (i + 0.5) / shuffled.length
    h.wake = q < 0.4 ? 'dark' : q < 0.6 ? 'porch' : q < 0.9 ? 'window' : 'tv'
  })
  exitHouse.wake = 'porch'
  // Anomaly (doc 10.7): one house's front door is missing — a wall where the
  // path ends. Only a house with a back door, never the exit house.
  const doorless = houses.filter((h) => h !== exitHouse && h.band.yard)
  const noFrontDoor = doorless[r(6) % doorless.length]

  return { mid, stems, models, houses, junctions, bulbs, spawn, exitHouse, noFrontDoor }
}

// Model frame → global cell: row 0 faces the street; flipX mirrors the plan.
export function houseCell(h, u, v) {
  const { W, D } = h.model
  return {
    gx: h.flipX ? h.hx0 + W - 1 - u : h.hx0 + u,
    gz: h.flipZ ? h.hz0 + D - 1 - v : h.hz0 + v,
  }
}

export const edgeBetween = (a, b) => (a.gz === b.gz
  ? { axis: 'v', gx: Math.max(a.gx, b.gx), gz: a.gz }
  : { axis: 'h', gx: a.gx, gz: Math.max(a.gz, b.gz) })

// Street-graph shares over junction and dead-end nodes (degree ≠ 2), the
// doc's 12 "dead-end share" and "4-way intersection share".
export function suburbStreetGraph(layout) {
  const nodes = [...layout.junctions, ...layout.bulbs].filter((n) => n.degree !== 2)
  const deadEnds = nodes.filter((n) => n.degree === 1).length
  const fourWay = nodes.filter((n) => n.degree >= 4).length
  return { nodes: nodes.length, deadEnds, fourWay, deadEndShare: deadEnds / nodes.length, fourWayShare: fourWay / nodes.length }
}

// Share of houses with a same-model house next door on their frontage.
export function suburbModelSharing(layout) {
  const { houses } = layout
  let shared = 0
  houses.forEach((h, i) => {
    const near = [houses[i - 1], houses[i + 1]].filter((o) => o && o.run === h.run)
    if (near.some((o) => o.model === h.model)) shared++
  })
  return shared / houses.length
}

// --- build -------------------------------------------------------------------------

// The kind body (the editor kind's map).
export function buildSuburbPrototype(map, seed) {
  const r = rng(seed, SALT)
  const L = suburbLayout(seed)
  const cy = 0
  const plan = new FloorPlan(REGION)
  const exterior = new Map() // 'gx,gz' -> 'street' | 'lawn' | 'yard' | 'field'
  const key = (gx, gz) => `${gx},${gz}`
  const outside = (gx, gz, what) => {
    exterior.set(key(gx, gz), what)
    plan.open(gx, gz, CELL_OPEN)
  }

  // Streets: both strips, the connectors, then the stems (or fields).
  for (const s of ['S1', 'S2']) {
    const [z0, z1] = STREETS[s]
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = CONNECTORS.W; gx <= CONNECTORS.E + CONNECTOR_W - 1; gx++) outside(gx, gz, 'street')
      for (const e of ['W', 'E']) {
        const [x0, x1] = STEM_X[e]
        for (let gx = x0; gx <= x1; gx++) outside(gx, gz, L.stems[`${s}${e}`] ? 'street' : 'field')
      }
    }
  }
  for (const x0 of [CONNECTORS.W, L.mid, CONNECTORS.E]) {
    for (let gz = CONNECTOR_Z[0]; gz <= CONNECTOR_Z[1]; gz++) {
      for (let gx = x0; gx < x0 + CONNECTOR_W; gx++) outside(gx, gz, 'street')
    }
  }
  // Lots: lawn, side yards and backyards are open ground; the house is
  // walled, with a front door (and a back door onto a yard).
  const houseCells = new Set()
  const doorFront = new Set() // exterior cells a door opens onto
  let hallId = 1000
  for (const h of L.houses) {
    const { band, model } = h
    for (let gx = h.x0; gx <= h.x1; gx++) {
      for (let gz = band.span[0]; gz <= band.span[1]; gz++) {
        outside(gx, gz, h.yard && gz >= h.yard[0] && gz <= h.yard[1] ? 'yard' : 'lawn')
      }
    }
    h.hallId = hallId++
    for (let v = 0; v < model.D; v++) {
      for (let u = 0; u < model.W; u++) {
        const c = houseCell(h, u, v)
        exterior.delete(key(c.gx, c.gz))
        houseCells.add(key(c.gx, c.gz))
        const hall = model.halls.some((m) => m.u === u && m.v === v)
        // Room cells are placeholders until createRoom stamps them.
        plan.open(c.gx, c.gz, hall ? CELL_ROOM : CELL_CORRIDOR, hall ? h.hallId : 0, SPACE_ROLE_NONE)
      }
    }
    // The outline is walled; doors go in on top.
    for (let u = 0; u < model.W; u++) {
      for (const [v, out] of [[0, -1], [model.D - 1, model.D]]) {
        const e = edgeBetween(houseCell(h, u, v), houseCell(h, u, out))
        plan.edge(e.axis, e.gx, e.gz, 1, PASSAGE_WALL)
      }
    }
    for (let v = 0; v < model.D; v++) {
      for (const [u, out] of [[0, -1], [model.W - 1, model.W]]) {
        const e = edgeBetween(houseCell(h, u, v), houseCell(h, out, v))
        plan.edge(e.axis, e.gx, e.gz, 1, PASSAGE_WALL)
      }
    }
    if (h !== L.noFrontDoor) {
      const e = edgeBetween(h.frontDoor, h.outside)
      plan.edge(e.axis, e.gx, e.gz, 0, PASSAGE_DOOR)
      doorFront.add(key(h.outside.gx, h.outside.gz))
    }
    if (band.yard && model.back) {
      const inside = houseCell(h, model.back.u, model.back.v)
      const yard = houseCell(h, model.back.u, model.D)
      const e = edgeBetween(inside, yard)
      plan.edge(e.axis, e.gx, e.gz, 0, PASSAGE_DOOR)
      doorFront.add(key(yard.gx, yard.gz))
      h.backDoor = true
    }
  }

  // Cul-de-sac bulbs: 9×9 plates with three cells cut from each corner (a
  // disc of radius 4.5), over the stem ends and the lawns beside them.
  for (const b of L.bulbs) {
    for (let j = 0; j < BULB; j++) {
      for (let i = 0; i < BULB; i++) {
        if ((i - 4) ** 2 + (j - 4) ** 2 > 20.25) continue
        const gx = b.x0 + i
        const gz = b.z0 + j
        if (exterior.has(key(gx, gz))) exterior.set(key(gx, gz), 'street')
      }
    }
  }

  // Fences. Privacy fences (plain full-height walls: the stand-in for 1.8 m
  // boards) on the side and rear lot lines of the backyards, ~8% of their
  // cells missing; gates across the side yards, ~30% open.
  const fence = (axis, gx, gz) => plan.edge(axis, gx, gz, 1, PASSAGE_WALL)
  const gap = (a, b) => r(a, b) % 100 < 8
  for (const h of L.houses) {
    const { band } = h
    if (!band.yard) continue
    const last = L.houses[h.index + 1]?.run !== h.run
    for (let gz = band.yard[0]; gz <= band.yard[1]; gz++) {
      if (!gap(h.x0 * 64 + gz, 11)) fence('v', h.x0, gz)
      // The run's far end, where it meets a connector street.
      if (last && exterior.has(key(h.x1 + 1, gz)) && !gap(h.x1 * 64 + gz, 12)) fence('v', h.x1 + 1, gz)
    }
    const gateLine = band.face === 'S' ? h.hz0 : h.hz0 + h.model.D
    for (let gx = h.x0; gx <= h.x1; gx++) {
      if (gx >= h.hx0 && gx < h.hx0 + h.model.W) continue
      // The doorless house's yard is its only way in: its gates stand open.
      if (h !== L.noFrontDoor && r(gx, gateLine) % 10 >= 3) fence('h', gx, gateLine)
    }
  }
  // The rear lot line between the two middle bands.
  const rearLine = BANDS[2].yard[0]
  for (let gx = 1; gx <= 68; gx++) {
    if (exterior.get(key(gx, rearLine - 1)) === 'yard' && exterior.get(key(gx, rearLine)) === 'yard' && !gap(gx, 13)) {
      fence('h', gx, rearLine)
    }
  }

  // Lamps outside: a porch fixture at every front door (lit when the house
  // stirs), streetlights at junctions and bulbs only, most of them dead.
  for (const h of L.houses) {
    if (h === L.noFrontDoor) continue
    const porchLit = h.wake === 'porch'
    plan.lamp(h.outside.gx, h.outside.gz, porchLit, porchLit ? TINT_PORCH : null)
  }
  const poles = [...L.junctions.filter((j) => j.degree !== 2), ...L.bulbs]
  const order = poles.map((p, i) => [r(p.gx, p.gz + 500), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const litPoles = Math.max(1, Math.round(poles.length * 0.3))
  const litSet = new Set(order.slice(0, litPoles).map(([, i]) => i))
  poles.forEach((p, i) => plan.lamp(p.gx, p.gz, litSet.has(i), litSet.has(i) ? TINT_STREET : null))
  // Yard props. A piece blocks its whole cell, so one goes down only where
  // its open neighbours stay joined around it (a local articulation test
  // over exterior ground; doors' outside cells are never used).
  const blocked = new Set(L.spawn ? [key(L.spawn.gx, L.spawn.gz)] : [])
  const passable = (a, b) => {
    if (!exterior.has(key(b.gx, b.gz)) || blocked.has(key(b.gx, b.gz))) return false
    const e = edgeBetween(a, b)
    const explicit = plan.edges.get(`${e.axis}:${e.gx},${e.gz}`)
    return !explicit || !explicit.wall
  }
  const canBlock = (gx, gz) => {
    const k = key(gx, gz)
    if (!exterior.has(k) || blocked.has(k) || doorFront.has(k)) return false
    const c = { gx, gz }
    const near = NEIGHBOURS.map(([dx, dz]) => ({ gx: gx + dx, gz: gz + dz })).filter((n) => passable(c, n))
    if (!near.length) return false
    const inBox = (n) => Math.abs(n.gx - gx) <= 1 && Math.abs(n.gz - gz) <= 1 && (n.gx !== gx || n.gz !== gz)
    const seen = new Set([key(near[0].gx, near[0].gz)])
    const stack = [near[0]]
    while (stack.length) {
      const n = stack.pop()
      for (const [dx, dz] of NEIGHBOURS) {
        const m = { gx: n.gx + dx, gz: n.gz + dz }
        if (!inBox(m) || seen.has(key(m.gx, m.gz)) || !passable(n, m)) continue
        seen.add(key(m.gx, m.gz))
        stack.push(m)
      }
    }
    return near.every((n) => seen.has(key(n.gx, n.gz)))
  }
  const counts = { mailbox: 0, bin: 0, gnome: 0, bike: 0, doghouse: 0 }
  // The first of `tries` that can take the piece gets it; `opts` may be a
  // function of the cell (a gnome's gaze depends on where it stands).
  // `ok` may veto a cell. Returns the cell taken, if any.
  const place = (tries, kind, opts, tally, ok = () => true) => {
    const at = tries.find(([gx, gz]) => ok(gx, gz) && canBlock(gx, gz))
    if (!at) return null
    blocked.add(key(...at))
    plan.piece(...at, kind, typeof opts === 'function' ? opts(...at) : opts)
    counts[tally]++
    return at
  }
  // A cell's `side` edge stands walled: an explicit wall, or the plan's
  // outline where open ground meets unopened cells.
  const walledSide = (gx, gz, side) => {
    const [dx, dz] = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] }[side]
    const e = edgeBetween({ gx, gz }, { gx: gx + dx, gz: gz + dz })
    const explicit = plan.edges.get(`${e.axis}:${e.gx},${e.gz}`)
    return explicit ? explicit.wall === 1 : !plan.has(gx + dx, gz + dz)
  }
  const ex = L.exitHouse.outside
  const gaze = (gx, gz) => {
    const dx = ex.gx - gx
    const dz = ex.gz - gz
    return { facing: Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? FACING.E : FACING.W) : dz > 0 ? FACING.S : FACING.N }
  }
  // Mailbox by the driveway, at the lawn's street edge (placed before the
  // picket fences, which open in front of it).
  const mailboxGx = new Map() // house -> its mailbox's column
  for (const h of L.houses) {
    const { band } = h
    const lawnRow = band.face === 'S' ? band.lawn[1] : band.lawn[0]
    const xEnd = h.hx0 + h.model.W - 1
    const at = place([[h.hx0, lawnRow], [h.hx0 + 1, lawnRow], [xEnd, lawnRow]], PROP_MAILBOX, { facing: band.face === 'S' ? FACING.S : FACING.N }, 'mailbox')
    if (at) mailboxGx.set(h, at[0])
  }
  // Picket fences (rails) along some front lot lines, open at the path, the
  // mailbox and the driveway.
  let pickets = 0
  for (const h of L.houses) {
    if (r(h.index, 8) % 10 >= 4) continue
    const { band } = h
    const lawnRow = band.face === 'S' ? band.lawn[1] : band.lawn[0]
    const kerbRow = band.face === 'S' ? lawnRow + 1 : lawnRow - 1
    const line = band.face === 'S' ? kerbRow : lawnRow
    for (let gx = h.hx0; gx < h.hx0 + h.model.W; gx++) {
      if (gx === h.frontDoor.gx || gx === mailboxGx.get(h)) continue
      if (exterior.get(key(gx, lawnRow)) !== 'lawn' || exterior.get(key(gx, kerbRow)) !== 'street') continue
      plan.rail('h', gx, line)
      pickets++
    }
  }
  // The rest of the yard.
  for (const h of L.houses) {
    const { band } = h
    const toStreet = band.face === 'S' ? FACING.S : FACING.N
    const lawnRow = band.face === 'S' ? band.lawn[1] : band.lawn[0]
    const porchRow = h.outside.gz
    const kerbRow = band.face === 'S' ? lawnRow + 1 : lawnRow - 1
    const xEnd = h.hx0 + h.model.W - 1
    // Bin night: half the wheelie bins wait at the kerb.
    if (r(h.index, 9) % 2 === 0) {
      place([[h.x0, kerbRow], [h.x0 + 1, kerbRow], [xEnd, kerbRow]], PROP_WHEELIE_BIN, { facing: toStreet }, 'bin')
    }
    // Gnomes all turn toward the exit house's porch (the anomaly carrier).
    if (r(h.index, 10) % 3 === 0 && h !== L.exitHouse) {
      place([[xEnd, porchRow], [h.hx0, porchRow]], PROP_GNOME, gaze, 'gnome')
    }
    if (r(h.index, 11) % 5 === 0) {
      place([[xEnd - 1, lawnRow], [h.hx0 + 2, porchRow]], PROP_KIDS_BIKE, { facing: FACING.E }, 'bike')
    }
    if (band.yard && r(h.index, 12) % 3 === 0) {
      // Against the rear fence, never across one of its gaps.
      const rearRow = band.face === 'S' ? band.yard[0] : band.yard[1]
      const wall = band.face === 'S' ? 'N' : 'S'
      place([[xEnd, rearRow], [h.hx0, rearRow]], PROP_DOGHOUSE, { wall }, 'doghouse', (gx, gz) => walledSide(gx, gz, wall))
    }
  }

  plan.compile(map, cy)

  // Interiors. The first house of each model is built room by room with
  // createRoom (the hotel family's residential furnishing grammar); every
  // later house of that model repeats it exactly — same doors, furniture
  // copied and mirrored with the plan — so next door is the same house,
  // reflected (doc 10.6). A model cycle "XY" closes a loop inside the house:
  // Y is furnished first, X's createRoom door then opens into a free cell of
  // Y, and X's hall door is added where X kept a free cell.
  const canon = new Map() // model index -> {doors, extra, items} in the model frame
  const free = (c) => !map.cellAt(c.gx, cy, c.gz).col
  const toEdge = (h, [p, q]) => edgeBetween(houseCell(h, p.u, p.v), houseCell(h, q.u, q.v))
  const setDoor = (e) => (e.axis === 'v' ? map.setWallV(e.gx, cy, e.gz, 0, PASSAGE_DOOR) : map.setWallH(e.gx, cy, e.gz, 0, PASSAGE_DOOR))
  let twins = 0
  let cycles = 0
  for (const h of L.houses) {
    const { model } = h
    const via = new Map(model.cycles.map((c) => [c[0], c[1]])) // X -> Y
    const order = [...model.rooms].sort((p, q) => (via.has(p.key) ? 1 : 0) - (via.has(q.key) ? 1 : 0))
    const rect = (rm) => {
      const a = houseCell(h, rm.u0, rm.v0)
      const b = houseCell(h, rm.u1, rm.v1)
      return { x0: Math.min(a.gx, b.gx), z0: Math.min(a.gz, b.gz), x1: Math.max(a.gx, b.gx), z1: Math.max(a.gz, b.gz) }
    }
    const source = canon.get(model.index)
    const rooms = new Map()
    if (!source) {
      const doors = new Map()
      const extra = []
      for (const rm of order) {
        let door = rm.door
        const Y = via.has(rm.key) && model.rooms.find((o) => o.key === via.get(rm.key))
        if (Y) door = sharedEdges(rm, Y).find(([, q]) => free(houseCell(h, q.u, q.v))) ?? rm.door
        doors.set(rm.key, door)
        // createRoom's furnishing reads edges across chunk seams and lifts
        // pieces until every free cell is reachable from the door, so a
        // room on a seam needs no touch-up here.
        const room = createRoom(map, {
          cy, ...rect(rm), role: rm.role, salt: r(model.index * 16 + model.rooms.indexOf(rm), 15) & 0xffff,
          door: toEdge(h, door), lamp: false,
        })
        rooms.set(rm.key, room)
      }
      for (const rm of order) {
        if (doors.get(rm.key) === rm.door) continue
        const hallDoor = hallEdges(model, rm).find(([p]) => free(houseCell(h, p.u, p.v)))
        if (hallDoor) extra.push(hallDoor)
      }
      for (const e of extra) setDoor(toEdge(h, e))
      const items = []
      for (const room of rooms.values()) {
        for (let gz = room.z0; gz <= room.z1; gz++) {
          for (let gx = room.x0; gx <= room.x1; gx++) {
            const f = map.furnitureAt(gx, cy, gz)
            if (f) items.push(toModel(h, gx, gz, f.rec, map))
          }
        }
      }
      canon.set(model.index, { doors, extra, items })
      cycles += extra.length
    } else {
      twins++
      for (const rm of order) rooms.set(rm.key, stampRoom(map, { cy, ...rect(rm), role: rm.role, salt: 0, door: toEdge(h, source.doors.get(rm.key)) }))
      for (const e of source.extra) setDoor(toEdge(h, e))
      for (const it of source.items) {
        const c = houseCell(h, it.u, it.v)
        map.addFurniture(c.gx, cy, c.gz, fromModel(h, c, it, map))
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
        const e = edgeBetween(houseCell(h, u, 0), houseCell(h, u, -1))
        featureEdge(map, e.axis, e.gx, cy, e.gz, WALL_WINDOW)
        windows++
      }
      if (h.band.yard && u % 2 === 0 && isRoom(u, model.D - 1)) {
        const e = edgeBetween(houseCell(h, u, model.D - 1), houseCell(h, u, model.D))
        featureEdge(map, e.axis, e.gx, cy, e.gz, WALL_WINDOW)
        windows++
      }
    }
    // One lamp per room; the wake state picks which burn.
    const front = model.rooms.find((rm) => rm.v0 === 0 && rm.role !== SPACE_ROLE_BATHROOM) ?? model.rooms[0]
    model.rooms.forEach((rm, i) => {
      const room = h.rooms[i]
      const gx = Math.floor((room.x0 + room.x1) / 2)
      const gz = Math.floor((room.z0 + room.z1) / 2)
      let lit = false
      let tint = null
      if (h.wake === 'window' && rm === front) [lit, tint] = [true, TINT_ROOM]
      if (h.wake === 'tv' && rm.role === SPACE_ROLE_LIVING) [lit, tint] = [true, TINT_TV]
      map.setLamp(gx, cy, gz, lit, tint ?? undefined)
    })
    // A dead hall light — burning only in the exit house.
    const hall = houseCell(h, model.front.u, model.front.v)
    const hallLit = h === L.exitHouse
    map.setLamp(hall.gx, cy, hall.gz, hallLit, hallLit ? TINT_ROOM : undefined)
  }

  // The exit: the far end of the exit house's hall.
  const exitHall = L.exitHouse.model.halls.at(-1)
  const exit = houseCell(L.exitHouse, exitHall.u, exitHall.v)
  const d = map.chunkAt(map.cellChunk(exit.gx), cy, map.cellChunk(exit.gz))
  d.exit = { lx: map.cellLocal(exit.gx), lz: map.cellLocal(exit.gz) }

  const graph = suburbStreetGraph(L)
  const share = suburbModelSharing(L)
  const wake = { dark: 0, porch: 0, window: 0, tv: 0 }
  for (const h of L.houses) wake[h.wake]++
  const nd = L.noFrontDoor?.outside
  const notes = [
    `${L.houses.length} houses from ${L.models.length} models (${L.models.map((m) => m.name).join(', ')}); ${twins} furnished as mirror copies of the first of their model; ${Math.round(share * 100)}% share a model with a neighbour`,
    `streets: loop collector with ${L.bulbs.length} cul-de-sac bulbs${L.bulbs.length < 4 ? ' and a vacant field' : ''}; dead-end share ${graph.deadEndShare.toFixed(2)}, ${graph.fourWay} crossroads`,
    `light: ${litPoles}/${poles.length} streetlights burning; houses ${wake.porch} porch, ${wake.window} lit window, ${wake.tv} TV, ${wake.dark} dark`,
    `exit: the house with the porch light at ${L.exitHouse.outside.gx},${L.exitHouse.outside.gz} (its hall lamp burns); every gnome faces it`,
    `look at: ${nd ? `the house at ${nd.gx},${nd.gz} has no front door` : 'every house has its front door'}; mirrored twin interiors; ${windows} front/back windows; ${cycles} room-to-room doors; ${pickets} picket rails; the fence maze between the middle bands`,
    `props: ${counts.mailbox} mailboxes, ${counts.bin} wheelie bins at the kerb, ${counts.gnome} gnomes, ${counts.bike} bikes, ${counts.doghouse} doghouses`,
    'stand-ins: privacy fences are full-height walls; every cell keeps a ceiling (hide ceilings in the preview); streetlights and porch lights are ceiling panels; one storey (no attics); props render as boxes until their GLBs exist',
  ]
  return {
    spawn: L.spawn,
    exit: { ...exit, cy },
    notes,
  }
}

// Model-frame door edges [room cell, other cell]: between rooms X and Y,
// and from room X onto the hall.
export function sharedEdges(X, Y) {
  const out = []
  for (let v = X.v0; v <= X.v1; v++) {
    for (let u = X.u0; u <= X.u1; u++) {
      for (const [du, dv] of NEIGHBOURS) {
        const q = { u: u + du, v: v + dv }
        if (q.u >= Y.u0 && q.u <= Y.u1 && q.v >= Y.v0 && q.v <= Y.v1) out.push([{ u, v }, q])
      }
    }
  }
  return out
}

export function hallEdges(model, X) {
  const out = []
  for (let v = X.v0; v <= X.v1; v++) {
    for (let u = X.u0; u <= X.u1; u++) {
      for (const [du, dv] of NEIGHBOURS) {
        const q = { u: u + du, v: v + dv }
        if (model.halls.some((c) => c.u === q.u && c.v === q.v)) out.push([{ u, v }, q])
      }
    }
  }
  return out
}

// createRoom without its furnishing pass (same record, shell and door), for
// a twin whose furniture is copied from its model's first house.
export function stampRoom(map, { cy, x0, z0, x1, z1, role, salt, door }) {
  const room = { id: map.nextRoomId, cy, x0, z0, x1, z1, role, salt, door, baked: false }
  map.nextRoomId++
  stampRoomShell(map, room)
  map.rooms.push(room)
  return room
}

// A furniture record → the model frame of house h (metres from the model's
// own origin, facing unmirrored), and back into another house.
const MIRROR = {
  x: { [FACING.S]: FACING.S, [FACING.N]: FACING.N, [FACING.E]: FACING.W, [FACING.W]: FACING.E },
  z: { [FACING.S]: FACING.N, [FACING.N]: FACING.S, [FACING.E]: FACING.E, [FACING.W]: FACING.W },
}
const flipFacing = (h, f) => {
  let out = f
  if (h.flipX) out = MIRROR.x[out]
  if (h.flipZ) out = MIRROR.z[out]
  return out
}

export function toModel(h, gx, gz, rec, map) {
  const { W, D } = h.model
  const X = map.cellChunk(gx) * CHUNK * CELL + rec.x
  const Z = map.cellChunk(gz) * CHUNK * CELL + rec.z
  return {
    u: h.flipX ? h.hx0 + W - 1 - gx : gx - h.hx0,
    v: h.flipZ ? h.hz0 + D - 1 - gz : gz - h.hz0,
    U: h.flipX ? (h.hx0 + W) * CELL - X : X - h.hx0 * CELL,
    V: h.flipZ ? (h.hz0 + D) * CELL - Z : Z - h.hz0 * CELL,
    facing: flipFacing(h, rec.facing),
    rec,
  }
}

export function fromModel(h, c, it, map) {
  const { W, D } = h.model
  const X = h.flipX ? (h.hx0 + W) * CELL - it.U : h.hx0 * CELL + it.U
  const Z = h.flipZ ? (h.hz0 + D) * CELL - it.V : h.hz0 * CELL + it.V
  const { lx: _lx, lz: _lz, ...rest } = it.rec
  return {
    ...rest,
    x: X - map.cellChunk(c.gx) * CHUNK * CELL,
    z: Z - map.cellChunk(c.gz) * CHUNK * CELL,
    facing: flipFacing(h, it.facing),
  }
}
