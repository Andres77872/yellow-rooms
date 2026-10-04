import { CHUNK } from '../../constants.js'
import { MAP_FAMILY_NIGHTLOT } from '../ids.js'
import { FAMILY_SALT, floorDiv, hashChain, tileKeyAt, tileKeyOf } from '../../tiles/tileKey.js'

// The night lot's pure geometry (spec §3.3, §12.2; docs/liminal_maps/
// 02-night-lot.md §4–§6, §10). Everything here is a pure function of
// (worldSeed, GLOBAL coordinates): the district BLUEPRINT (its seam roads,
// its two-deck garage, the kiosk with a basement, the frontage blocks —
// motels and offices over shops, strip malls, a big-box store — the
// gas-station refuge, booths and shelters, and the parking lots that fill the
// rest), the stair cores that join the storeys, the undercroft's underpass
// ports, the anomalies, the footprint, the seam ports, the spawn and the exit
// anchor. The tile program
// (tile.js), the generator, the hooks and the planner all read it; it never
// reads them.
//
// PLANNER-CHAIN MODULE (§7.5): contract.js → families/planners.js →
// nightlot/structures.js → this file. It may import only constants.js,
// core/hash.js, core/rng.js, mapTypes.js, mapFamily.js ({deepFreeze,
// MAP_FAMILY_CODES}), structures/catalog/engine.js, families/ids.js,
// tiles/tileKey.js and tiles/stubPlanner.js.
//
// The world, in one paragraph. The plane is cut into 4×4-chunk districts
// (56×56 cells) baked as one band of three storeys: the undercroft (cy −1),
// the lot (cy 0) and an upper storey (cy 1) that exists only over the
// garages and the frontage blocks (footprint). Every district owns the road
// along its west and north seams (2–3 lanes and a kerbside walk with street
// poles), so the lot is open on every seam. Inside the roads a seeded grammar
// packs the parcel. A district is a MIXED block (p 0.8) or a LOT FIELD (p 0.2:
// two buildings round a big parking field, no garage). Mixed districts may
// hold a 1×1..3×2-chunk parking garage (p 0.6): its B1 deck below, its ground
// deck on the lot (rooms and cages along its walls) and its roof deck above,
// joined by an enclosed stair tower and an open ramp flight; with p 0.35
// (always in the exit district) a kiosk over a basement service floor; three
// or four buildings — frontage blocks (a motel, or offices over shops) whose
// stair halls run from their basement suites to their upper floors, strip
// malls with stair halls down to their stock basements, a big box whose stock
// stair goes down behind its vestibule, the gas-station refuge (always in
// district (0,0), rare and never next to another); outparcels out in the lot
// (diners, banks, laundromats); booths and bus shelters; and, filling
// everything left, parking lots of bays with kerbed lamp islands on breaker
// circuits, some with a stair head down to the under-lot deck, and lamp
// poles and planted beds on the open apron. Below, the undercroft joins the
// garage's B1, the under-lot decks, the basement suites and the kiosk
// basement with service tunnels, and crosses under the seam roads into the
// neighbours through underpasses (cy −1 seam ports). Sizes, counts,
// orientation and placement all vary per district; one stair core per chunk.

export const FAMILY = MAP_FAMILY_NIGHTLOT

// District size in chunks and in cells.
export const DISTRICT = 4
export const SPAN = DISTRICT * CHUNK // 56

// The tile (§6.2, §12.2): a 4×4-chunk district, backend 'band', one band of
// three storeys (−1 the undercroft, 0 the lot, 1 the upper storey: the
// garage's roof deck and the frontage blocks' upper floors), origin.cy = −1.
// The upper storey is footprint-solid except over the chunks those
// buildings stand in (footprint()).
export const TILE = Object.freeze({ w: DISTRICT, d: DISTRICT, backend: 'band', H: 3, lo: -1, hi: 1, salt: FAMILY_SALT.nightlot })

// Kind-local storeys of a tile bake (kind storey n = world storey n − 1).
export const BASEMENT = 0
export const DECK = 1
export const UP = 2
export const BASEMENT_CY = -1
export const DECK_CY = 0
export const UP_CY = 1

// The kind lab's dice salt (rng(seed, SALT) in tile.js).
export const SALT = 0x02a1

// Hash salts, one per independent stream (hashChain(worldSeed ^ salt, …)).
const S_ROAD = 0x02a10011
const S_GARAGE = 0x02a10012
const S_KIOSK = 0x02a10013
const S_BLOCK = 0x02a10014
const S_GAS = 0x02a10015
const S_LOT = 0x02a10016
const S_BOOTH = 0x02a10017
const S_ANOMALY = 0x02a1000a
const S_EXIT = 0x02a1000b
const S_DETAIL = 0x02a10018
const S_MODE = 0x02a10019
const S_UNDER = 0x02a1001a
const S_LOTCORE = 0x02a1001b

const hk = (seed, salt, ...v) => hashChain(((seed >>> 0) ^ salt) | 0, ...v)
// hashChain's low bits follow its last input closely for small consecutive
// values (a run of 34 stalls hashed one cell apart once gave no value under
// 0.24); the blueprint and the detail dice finish with an avalanche
// (murmur3 fmix32) so every threshold sees a uniform draw.
const fmix = (h) => {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}
const hd = (seed, salt, ...v) => fmix(hk(seed, salt, ...v))

// A small bounded memo (cleared when full): footprint() runs for every chunk
// a bake or a stream touches.
function memo(limit, fn) {
  const m = new Map()
  return (key, ...args) => {
    let v = m.get(key)
    if (v === undefined) {
      if (m.size >= limit) m.clear()
      m.set(key, (v = fn(...args)))
    }
    return v
  }
}

const cheb = (ax, az, bx, bz) => Math.max(Math.abs(ax - bx), Math.abs(az - bz))
export const R = (x0, z0, x1, z1) => ({ x0, z0, x1, z1 })
export const grow = (r, n) => R(r.x0 - n, r.z0 - n, r.x1 + n, r.z1 + n)
export const inRect = (r, x, z) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1
const overlaps = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1
const local = (g) => g - Math.floor(g / CHUNK) * CHUNK

// --- module transforms (the finite kind's frontage/refuge; the kiosk module) -------

// The rigid map from a module's canonical cells (x, z) to kind-local cells:
// shift by (shiftU, shiftV) into the module square [0, size), mirror across
// its centre column (u → size − 1 − u), turn `rot` quarter turns clockwise
// ((u, v) → (size − 1 − v, u)), then offset by (ox, oz). Edges, walls,
// facings and stair directions follow the same map.
const FACING_VEC = [[0, 1], [0, -1], [1, 0], [-1, 0]] // FACING.S, N, E, W (tiles/floorPlan.js)
const STAIR_VEC = [[0, -1], [1, 0], [0, 1], [-1, 0]] // STAIR_N, E, S, W (structures/slab.js)
const WALL_VEC = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }
const vecIndex = (table, [a, b]) => table.findIndex(([x, z]) => x === a && z === b)

export function moduleTransform({ size = CHUNK, shiftU = 0, shiftV = 0, rot = 0, mirror = false, ox = 0, oz = 0 } = {}) {
  const n = size - 1
  const turns = ((rot % 4) + 4) % 4
  const cell = (x, z) => {
    let u = x + shiftU
    let v = z + shiftV
    if (mirror) u = n - u
    for (let k = 0; k < turns; k++) [u, v] = [n - v, u]
    return [u + ox, v + oz]
  }
  const vec = (dx, dz) => {
    let a = mirror ? -dx : dx
    let b = dz
    for (let k = 0; k < turns; k++) [a, b] = [-b, a]
    return [a, b]
  }
  // An edge given in canonical cells: 'v' at (x, z) between (x−1, z) and
  // (x, z); 'h' at (x, z) between (x, z−1) and (x, z).
  const edge = (axis, x, z) => {
    const [ax, az] = axis === 'v' ? cell(x - 1, z) : cell(x, z - 1)
    const [bx, bz] = cell(x, z)
    return az === bz ? { axis: 'v', gx: Math.max(ax, bx), gz: az } : { axis: 'h', gx: ax, gz: Math.max(az, bz) }
  }
  const rect = (r) => {
    const [ax, az] = cell(r.x0, r.z0)
    const [bx, bz] = cell(r.x1, r.z1)
    return { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) }
  }
  const wall = (w) => {
    const [a, b] = vec(...WALL_VEC[w])
    return Object.keys(WALL_VEC).find((k) => WALL_VEC[k][0] === a && WALL_VEC[k][1] === b)
  }
  const face = (f) => vecIndex(FACING_VEC, vec(...FACING_VEC[f]))
  const stairDir = (d) => vecIndex(STAIR_VEC, vec(...STAIR_VEC[d]))
  return Object.freeze({ cell, vec, edge, rect, wall, face, stairDir, rot: turns, mirror })
}

// A rectangle's canonical frame: u runs along the block, v from its back
// (v = 0) to its front (v = D − 1); `front` names the world side the front
// faces ('S' +z, 'N' −z, 'E' +x, 'W' −x); `mirror` flips u. Shared by every
// block drawing in tile.js and by the placement here.
export const DIR_VEC = Object.freeze({ S: Object.freeze([0, 1]), N: Object.freeze([0, -1]), E: Object.freeze([1, 0]), W: Object.freeze([-1, 0]) })
export const sideOf = (dx, dz) => (dx > 0 ? 'E' : dx < 0 ? 'W' : dz > 0 ? 'S' : 'N')
export function frameOf(rect, front, mirror = false) {
  const [vx, vz] = DIR_VEC[front]
  let ux = vz
  let uz = -vx
  if (mirror) {
    ux = -ux
    uz = -uz
  }
  const alongX = ux !== 0
  const L = alongX ? rect.x1 - rect.x0 + 1 : rect.z1 - rect.z0 + 1
  const D = alongX ? rect.z1 - rect.z0 + 1 : rect.x1 - rect.x0 + 1
  const ox = ux < 0 || vx < 0 ? rect.x1 : rect.x0
  const oz = uz < 0 || vz < 0 ? rect.z1 : rect.z0
  const cell = (u, v) => [ox + u * ux + v * vx, oz + u * uz + v * vz]
  // The world rect of canonical rect [u0..u1] × [v0..v1].
  const rectUV = (u0, v0, u1, v1) => {
    const [ax, az] = cell(u0, v0)
    const [bx, bz] = cell(u1, v1)
    return R(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz))
  }
  // World side names of the canonical directions.
  const side = (du, dv) => sideOf(du * ux + dv * vx, du * uz + dv * vz)
  return Object.freeze({ rect, front, mirror, L, D, ux, uz, vx, vz, cell, rectUV, side, back: side(0, -1), left: side(-1, 0), right: side(1, 0) })
}

// --- the lamp poles (shared with the finite kind) ------------------------------------

export const POLE_DZ = Object.freeze([-3, 3]) // the kind's twin poles north–south
// Lamp offsets round a pole: twin head (opposite pair), T, or cross.
export const ARMS = Object.freeze([[1, 0], [0, 1], [-1, 0], [0, -1]].map((a) => Object.freeze(a)))
export const NEXT_ISLAND = 20 // cells, lamp to lamp: the doc's "next island visible within 60 m"

// The kind's pole heads: n heads (2 = twin opposite pair, 3 = T, 4 = cross)
// turned by `turn` quarter turns. Shared by the finite kind and the world.
export function poleArms(n, turn) {
  return n === 2 ? [ARMS[turn], ARMS[(turn + 2) % 4]] : [0, 1, 2, 3].slice(0, n).map((i) => ARMS[(turn + i) % 4])
}

// --- stair cores (structures/authored.js stairwellPlan, without importing it) -------

// Stair directions (structures/slab.js): N 0, E 1, S 2, W 3.
export const STAIR = Object.freeze({ N: 0, E: 1, S: 2, W: 3 })
const STAIR_AXIS = Object.freeze({ 0: [[0, -1], [1, 0]], 1: [[1, 0], [0, 1]], 2: [[0, 1], [1, 0]], 3: [[-1, 0], [0, 1]] })

// The 6×4 core rect (flights plus halo) of a stairwellPlan with landing
// (gx, gz) climbing `dir`: along −1..4, across −1..2.
export function coreRectOf(gx, gz, dir) {
  const [[ax, az], [px, pz]] = STAIR_AXIS[dir]
  const xs = []
  const zs = []
  for (const along of [-1, 4]) {
    for (const across of [-1, 2]) {
      xs.push(gx + ax * along + px * across)
      zs.push(gz + az * along + pz * across)
    }
  }
  return R(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs))
}

// The landing of the core that fills `rect` (6×4 for E/W, 4×6 for N/S).
export function landingOf(rect, dir) {
  if (dir === STAIR.E) return [rect.x0 + 1, rect.z0 + 1]
  if (dir === STAIR.W) return [rect.x1 - 1, rect.z0 + 1]
  if (dir === STAIR.S) return [rect.x0 + 1, rect.z0 + 1]
  return [rect.x0 + 1, rect.z1 - 1]
}

// The enclosed core's door (structures/authored.js stairwellDoor): the cells
// inside and outside it.
export function coreDoorCells(rect, dir, doorSide) {
  const far = doorSide === 'far'
  if (dir === STAIR.E || dir === STAIR.W) {
    const x = Math.floor((rect.x0 + rect.x1) / 2)
    return far ? { inside: [x, rect.z1], outside: [x, rect.z1 + 1] } : { inside: [x, rect.z0], outside: [x, rect.z0 - 1] }
  }
  const z = Math.floor((rect.z0 + rect.z1) / 2)
  return far ? { inside: [rect.x1, z], outside: [rect.x1 + 1, z] } : { inside: [rect.x0, z], outside: [rect.x0 - 1, z] }
}

// A core rect fits stairwellPlan: strictly inside one chunk (local 1..12).
const coreFits = (r) => {
  const cx = Math.floor(r.x0 / CHUNK)
  const cz = Math.floor(r.z0 / CHUNK)
  return Math.floor(r.x1 / CHUNK) === cx && Math.floor(r.z1 / CHUNK) === cz &&
    local(r.x0) >= 1 && local(r.z0) >= 1 && local(r.x1) <= CHUNK - 2 && local(r.z1) <= CHUNK - 2
}

// A core record: kind-local landing, direction, door side, rect, storeys
// (world: every core joins the undercroft, cy −1, to the lot, cy 0; the
// garage's cores and the frontage blocks' stair halls go on up to the upper
// storey, cy 1), the door cells and its local chunk.
function makeCore(rect, dir, doorSide, enclosed, role, topCy = DECK_CY) {
  const [gx, gz] = landingOf(rect, dir)
  return Object.freeze({
    gx, gz, dir, doorSide, enclosed, role,
    rect: Object.freeze(rect),
    door: Object.freeze(coreDoorCells(rect, dir, doorSide)),
    baseCy: BASEMENT_CY,
    topCy,
    lcx: Math.floor(rect.x0 / CHUNK),
    lcz: Math.floor(rect.z0 / CHUNK),
  })
}

// --- occupancy (placement scratch) ------------------------------------------------------

const FREE = 0
const SOFT = 1 // clearance: no building, but walkable fabric (lanes, walks)
const HARD = 2 // a building or a reserved module

class Occ {
  constructor() {
    this.a = new Uint8Array(SPAN * SPAN)
    this.any = new Int32Array((SPAN + 1) * (SPAN + 1))
    this.hard = new Int32Array((SPAN + 1) * (SPAN + 1))
    this.dirty = true
  }

  mark(r, v) {
    for (let z = Math.max(0, r.z0); z <= Math.min(SPAN - 1, r.z1); z++) {
      for (let x = Math.max(0, r.x0); x <= Math.min(SPAN - 1, r.x1); x++) {
        const i = z * SPAN + x
        if (this.a[i] < v) this.a[i] = v
      }
    }
    this.dirty = true
  }

  at(x, z) {
    return x < 0 || z < 0 || x >= SPAN || z >= SPAN ? HARD : this.a[z * SPAN + x]
  }

  _sat() {
    if (!this.dirty) return
    const W = SPAN + 1
    for (let z = 0; z < SPAN; z++) {
      let ra = 0
      let rh = 0
      for (let x = 0; x < SPAN; x++) {
        const v = this.a[z * SPAN + x]
        ra += v ? 1 : 0
        rh += v === HARD ? 1 : 0
        this.any[(z + 1) * W + x + 1] = this.any[z * W + x + 1] + ra
        this.hard[(z + 1) * W + x + 1] = this.hard[z * W + x + 1] + rh
      }
    }
    this.dirty = false
  }

  _sum(t, r) {
    const W = SPAN + 1
    const x0 = Math.max(0, r.x0)
    const z0 = Math.max(0, r.z0)
    const x1 = Math.min(SPAN - 1, r.x1)
    const z1 = Math.min(SPAN - 1, r.z1)
    if (x1 < x0 || z1 < z0) return 0
    return t[(z1 + 1) * W + x1 + 1] - t[z0 * W + x1 + 1] - t[(z1 + 1) * W + x0] + t[z0 * W + x0]
  }

  // Every cell of r free (r inside the district).
  isFree(r) {
    this._sat()
    return this._sum(this.any, r) === 0
  }

  // No hard cell in r.
  noHard(r) {
    this._sat()
    return this._sum(this.hard, r) === 0
  }
}

const insideRect = (inner, outer) => inner.x0 >= outer.x0 && inner.z0 >= outer.z0 && inner.x1 <= outer.x1 && inner.z1 <= outer.z1

// The largest free rectangle of the grid restricted to `area` (histogram
// method), or null. Ties: the first found in (z, x) order.
function largestFree(occ, area) {
  const W = area.x1 - area.x0 + 1
  const h = new Int32Array(W)
  let best = null
  let bestA = 0
  for (let z = area.z0; z <= area.z1; z++) {
    for (let i = 0; i < W; i++) h[i] = occ.at(area.x0 + i, z) === FREE ? h[i] + 1 : 0
    const stack = []
    for (let i = 0; i <= W; i++) {
      const cur = i === W ? 0 : h[i]
      let start = i
      while (stack.length && stack[stack.length - 1][1] >= cur) {
        const [s, hh] = stack.pop()
        const w = i - s
        const a = w * hh
        if (hh > 0 && a > bestA && Math.min(w, hh) >= 1) {
          bestA = a
          best = R(area.x0 + s, z - hh + 1, area.x0 + i - 1, z)
        }
        start = s
      }
      stack.push([start, cur])
    }
  }
  return best
}

// --- the blueprint ------------------------------------------------------------------------

// Garage sizes in chunks [w, h] (weights in eighths): mostly 2×1 / 1×2, a
// 1×1 ramp house or a 2×2 deck, the odd long 3×2 / 2×3 deck.
const GARAGE_SIZES = Object.freeze([[2, 1], [1, 2], [1, 1], [2, 2], [2, 1], [1, 2], [1, 1], [3, 2], [2, 2], [1, 1], [2, 1], [1, 2], [2, 3], [2, 1], [1, 2], [1, 1]])
export const P_GARAGE = 0.6
export const P_FIELD = 0.2
export const P_KIOSK = 0.35
// The refuge: hashed with p P_GAS per mixed district, then thinned so no two
// refuges are edge neighbours (gasDistrict); about 0.12 of the districts.
export const P_GAS = 0.25
export const P_BIGBOX = 0.35
export const P_LOT_CORE = 0.35
export const P_ROOF = 0.9
export const UP_MIN = 5
export const MIN_CORES = 2

// Block kinds and their canonical size ranges.
//   frontage  a frontage block: a motel, or offices over shops; D 8–9, a
//             stair hall down to its basement suite
//   strip     a strip mall: D 6–8, a service alley behind (p 0.7), a stair
//             hall down to its stock basement (p 0.7)
//   bigbox    a big-box store: solid mass behind a lit vestibule, D 9–12
//   gas       the gas-station refuge: shop behind, a walk, the canopy apron
//   pad       an outparcel: a freestanding diner, bank, laundromat or video
//             store out in the lot (glass all round, a back room, a WC)
const BLOCK_SPECS = Object.freeze({
  pad: Object.freeze({ L: [8, 12], D: [6, 8] }),
  frontage: Object.freeze({ L: [18, 30], D: [8, 11] }),
  strip: Object.freeze({ L: [12, 32], D: [6, 8] }),
  bigbox: Object.freeze({ L: [16, 28], D: [9, 12] }),
  gas: Object.freeze({ L: [12, 15], D: [10, 11] }),
})

// The kiosk module's cells in its chunk (the module draws inside 2..12; the
// ring 1..12 keeps its door approach and canopy).
export const kioskArea = (lcx, lcz) => R(lcx * CHUNK + 1, lcz * CHUNK + 1, lcx * CHUNK + CHUNK - 2, lcz * CHUNK + CHUNK - 2)

// The district plan, pure in (worldSeed, tx, tz). District-local cells.
//   mode     'mixed' | 'field' (a lot field: two buildings round the lots)
//   roads    { wW, wN, vE, vS, iW, iN }: road widths owned on the west and
//            north seams, verge widths on the east and south, near-verge
//            widths inside the west and north walks
//   parcel   the cells inside the roads and walks
//   garage   { chunks, rect, cores, entrances, booth } | null
//   kiosk    { lcx, lcz, rot, mirror } | null (a kiosk with a basement)
//   blocks   [{ kind, sub, rect, front, mirror, alley, D, L, walk, core? }]
//   booths   [{ kind, rect, front }]
//   lots     [{ rect, axis, n, core? }]
//   cores    every stair core joining the undercroft (cy −1) to the lot (cy 0)
//   spawn    [{ gx, gz }] (district (0,0) only: the refuge apron)
const blueprintMemo = memo(512, (seed, tx, tz) => buildBlueprint(seed, tx, tz))
export const blueprint = (worldSeed, tx, tz) => blueprintMemo(`${worldSeed >>> 0}|${tx},${tz}`, worldSeed >>> 0, tx, tz)

function buildBlueprint(seed, tx, tz, padless = false, frontFirst = false) {
  const H = (salt, ...v) => hd(seed, salt, tx, tz, ...v)
  const pick = (salt, n, ...v) => (n <= 1 ? 0 : H(salt, ...v) % n)
  const chance = (salt, p, ...v) => (H(salt, ...v) % 10000) / 10000 < p
  const wW = 2 + (H(S_ROAD, 0) & 1)
  const wN = 2 + (H(S_ROAD, 1) & 1)
  // The far verges (grass along the east and south seams): 1–4 cells, so the
  // buildings backed against the parcel's edge do not line up district after
  // district.
  // The exit and home districts keep 1-cell far verges and 1–2-cell near
  // ones (the exit's kiosk and the home's refuge always find room).
  const anchorHere = isAnchor(seed, tx, tz)
  const homeHere = tx === 0 && tz === 0
  const vE = anchorHere || homeHere ? 1 : 1 + (H(S_ROAD, 2) % 4)
  const vS = anchorHere || homeHere ? 1 : 1 + (H(S_ROAD, 3) % 4)
  // The near verges (a planted strip, a fence or a kerb between the seam
  // walks and the parcel): 0–3 cells, so blocks backed against the west or
  // north edge stand at a different line district after district.
  const iW = anchorHere || homeHere ? 1 + (H(S_ROAD, 4) & 1) : H(S_ROAD, 4) % 4
  const iN = anchorHere || homeHere ? 1 + (H(S_ROAD, 5) & 1) : H(S_ROAD, 5) % 4
  const parcel = R(wW + 1 + iW, wN + 1 + iN, SPAN - 1 - vE, SPAN - 1 - vS)
  const occ = new Occ()
  // Outside the parcel: roads, walks and the far verges.
  occ.mark(R(0, 0, SPAN - 1, parcel.z0 - 1), HARD)
  occ.mark(R(0, 0, parcel.x0 - 1, SPAN - 1), HARD)
  occ.mark(R(SPAN - vE, 0, SPAN - 1, SPAN - 1), HARD)
  occ.mark(R(0, SPAN - vS, SPAN - 1, SPAN - 1), HARD)
  const anchor = isAnchor(seed, tx, tz)
  const home = tx === 0 && tz === 0
  const mode = modeOf(seed, tx, tz)
  const cores = []
  // One stair core per chunk (a chunk holds one flight per storey); the
  // kiosk's chunk holds its own.
  const coreChunks = new Set()

  // 1. The garage (mixed districts, p 0.6): chunk-aligned, a ground deck on
  //    the lot and its B1 deck below.
  const garage = mode === 'mixed' && chance(S_GARAGE, P_GARAGE, 99) ? placeGarage(parcel, occ, H, pick) : null
  if (garage) {
    cores.push(...garage.cores)
    for (const c of garage.cores) coreChunks.add(`${c.lcx},${c.lcz}`)
  }

  // 2. The kiosk with a basement (forced in the exit district).
  let kiosk = null
  if (anchor || chance(S_KIOSK, P_KIOSK, 0)) {
    const free = []
    for (let lcz = 1; lcz < DISTRICT; lcz++) {
      for (let lcx = 1; lcx < DISTRICT; lcx++) {
        if (occ.isFree(kioskArea(lcx, lcz)) && !coreChunks.has(`${lcx},${lcz}`)) free.push([lcx, lcz])
      }
    }
    if (free.length) {
      const [lcx, lcz] = free[pick(S_KIOSK, free.length, 1)]
      kiosk = Object.freeze({ lcx, lcz, rot: H(S_KIOSK, 2) & 3, mirror: (H(S_KIOSK, 3) & 1) === 1 })
      occ.mark(kioskArea(lcx, lcz), HARD)
      coreChunks.add(`${lcx},${lcz}`)
    } else if (anchor) {
      throw new Error(`nightlot: exit district ${tx},${tz} has no kiosk chunk`)
    }
  }

  // 3. Blocks, in grammar order: the refuge first (always in the home
  //    district), then a hashed shuffle of the district's kinds; three or
  //    four buildings in a mixed district, two round a lot field.
  const want = []
  if (gasDistrict(seed, tx, tz)) want.push('gas')
  const pool = []
  if (mode === 'mixed') {
    if (chance(S_BLOCK, P_BIGBOX, 3)) pool.push('bigbox')
    if (chance(S_BLOCK, 0.65, 6)) pool.push('strip')
    if (chance(S_BLOCK, 0.75, 7)) pool.push('frontage')
    if (chance(S_BLOCK, 0.5, 1)) pool.push('strip')
    if (chance(S_BLOCK, 0.4, 2)) pool.push('frontage')
    if (pool.length < 2) pool.push('strip', 'frontage')
  } else {
    pool.push(chance(S_BLOCK, 0.6, 6) ? 'strip' : 'frontage', chance(S_BLOCK, 0.5, 1) ? 'strip' : 'frontage')
  }
  const order = pool.map((k, i) => [H(S_BLOCK, 0x40, i), k]).sort((a, b) => a[0] - b[0]).map(([, k]) => k)
  const nMax = mode === 'mixed' ? 3 + pick(S_BLOCK, 2, 5) : 2
  if (frontFirst) order.unshift('frontage')
  for (const k of order) if (want.length < Math.max(nMax, home ? 2 : 1)) want.push(k)
  const blocks = []
  const tryBlock = (kind, n) => {
    const b = placeBlock(kind, n, parcel, occ, H, pick, chance, coreChunks)
    if (!b) return
    blocks.push(b)
    if (b.core) {
      cores.push(b.core)
      coreChunks.add(`${b.core.lcx},${b.core.lcz}`)
    }
  }
  want.forEach((kind, n) => tryBlock(kind, n))
  // Never an empty field: a district keeps at least two buildings (rooms on
  // the lot), retrying the small kinds under fresh salts.
  for (let n = 8; n < 14 && blocks.length < 2; n++) tryBlock(n % 2 ? 'strip' : 'frontage', n)
  // Never a district without an upper storey: without a garage, a frontage
  // block (stairs to its upper floor) is tried under fresh salts.
  const upper = () => garage || blocks.some((b) => b.upper || b.roof)
  for (let n = 14; n < 20 && !upper(); n++) tryBlock('frontage', n)
  if (!upper() && !frontFirst) return buildBlueprint(seed, tx, tz, padless, true)
  const bit = (lcx, lcz) => 1 << (lcz * DISTRICT + lcx)
  const upMaskOf = () => {
    let upMask = 0
    if (garage) {
      const c = garage.chunks
      for (let lcz = c.c0z; lcz < c.c0z + c.h; lcz++) for (let lcx = c.c0x; lcx < c.c0x + c.w; lcx++) upMask |= bit(lcx, lcz)
    }
    for (const b of blocks) {
      if (!b.upper) continue
      const body = upperBody(b)
      const alongX = b.front === 'N' || b.front === 'S'
      const [u0, u1] = alongX ? [body.x0, body.x1] : [body.z0, body.z1]
      const [d0, d1] = alongX ? [body.z0, body.z1] : [body.x0, body.x1]
      const coreSlice = alongX ? b.core.lcx : b.core.lcz
      for (let sc = Math.floor(u0 / CHUNK); sc <= Math.floor(u1 / CHUNK); sc++) {
        const w = Math.min(u1, sc * CHUNK + CHUNK - 1) - Math.max(u0, sc * CHUNK) + 1
        let thin = w < MIN_UP_SLICE
        for (let dc = Math.floor(d0 / CHUNK); dc <= Math.floor(d1 / CHUNK) && !thin; dc++) {
          if (w * (Math.min(d1, dc * CHUNK + CHUNK - 1) - Math.max(d0, dc * CHUNK) + 1) < MIN_UP_AREA) thin = true
        }
        if (thin && sc !== coreSlice) continue
        for (let dc = Math.floor(d0 / CHUNK); dc <= Math.floor(d1 / CHUNK); dc++) upMask |= alongX ? bit(sc, dc) : bit(dc, sc)
      }
    }
    // A strip mall's or a big box's roof: every chunk the roof covers with
    // ROOF_MIN_AREA cells or more, joined to the bulkhead's chunk through such
    // chunks (the rest of the roof stays solid up there: a higher plant deck).
    for (const b of blocks) {
      if (!b.roof) continue
      const body = roofBody(b)
      const cand = new Set()
      for (let lcz = Math.floor(body.z0 / CHUNK); lcz <= Math.floor(body.z1 / CHUNK); lcz++) {
        for (let lcx = Math.floor(body.x0 / CHUNK); lcx <= Math.floor(body.x1 / CHUNK); lcx++) {
          const a = area(R(Math.max(body.x0, lcx * CHUNK), Math.max(body.z0, lcz * CHUNK), Math.min(body.x1, lcx * CHUNK + CHUNK - 1), Math.min(body.z1, lcz * CHUNK + CHUNK - 1)))
          if (a >= ROOF_MIN_AREA) cand.add(`${lcx},${lcz}`)
        }
      }
      const start = `${b.core.lcx},${b.core.lcz}`
      cand.add(start)
      const seen = new Set([start])
      const todo = [[b.core.lcx, b.core.lcz]]
      while (todo.length) {
        const [x, z] = todo.pop()
        upMask |= bit(x, z)
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const k = `${x + dx},${z + dz}`
          if (cand.has(k) && !seen.has(k)) {
            seen.add(k)
            todo.push([x + dx, z + dz])
          }
        }
      }
    }
    // A door's outside cell on the east column / south row of its chunk needs
    // the neighbour across that line on the storey too (§6.8 rule 1; never in
    // practice: placeBlock keeps the body's far side off those lines).
    for (const b of blocks) {
      if (!b.upper && !b.roof) continue
      const [ox, oz] = b.core.door.outside
      if (local(ox) === CHUNK - 1 && Math.floor(ox / CHUNK) + 1 < DISTRICT) upMask |= bit(Math.floor(ox / CHUNK) + 1, Math.floor(oz / CHUNK))
      if (local(oz) === CHUNK - 1 && Math.floor(oz / CHUNK) + 1 < DISTRICT) upMask |= bit(Math.floor(ox / CHUNK), Math.floor(oz / CHUNK) + 1)
    }
    return upMask
  }
  // A thin upper storey (fewer than UP_MIN chunks): strip malls and big boxes
  // without a roof take a bulkhead stair up to one (a stair-less one gets a
  // stair hall; a basement-only one's stair goes on up), in turn, until the
  // storey holds UP_MIN chunks — districts do not share one lone upper chunk.
  const chunksOf = (m) => {
    let n = 0
    for (let k = 0; k < DISTRICT * DISTRICT; k++) if (m & (1 << k)) n++
    return n
  }
  const promo = blocks.map((b, i) => [H(S_BLOCK, 0x60, i), i]).sort((p, q) => p[0] - q[0]).map(([, i]) => i)
  for (const i of promo) {
    if (chunksOf(upMaskOf()) >= UP_MIN) break
    const b = blocks[i]
    if ((b.kind !== 'strip' && b.kind !== 'bigbox') || b.roof) continue
    const F = frameOf(b.rect, b.front, b.mirror)
    const body = F.rectUV(0, 0, F.L - 1, F.D - 1)
    if (b.core) coreChunks.delete(`${b.core.lcx},${b.core.lcz}`)
    const core = b.kind === 'bigbox' ? stockCore(F, b.D, H, b.n ^ 0x61, coreChunks, UP_CY, body) : hallCore(F, b.alley, H, b.n ^ 0x61, coreChunks, UP_CY, 'stair-hall', body)
    if (!core) {
      if (b.core) coreChunks.add(`${b.core.lcx},${b.core.lcz}`)
      continue
    }
    const k = b.core ? cores.indexOf(b.core) : -1
    if (k >= 0) cores[k] = core
    else cores.push(core)
    coreChunks.add(`${core.lcx},${core.lcz}`)
    blocks[i] = Object.freeze({ ...b, core, roof: true })
  }
  // Still thin: one more frontage block (an upper floor) under fresh salts.
  for (let n = 30; n < 36 && chunksOf(upMaskOf()) < UP_MIN && blocks.length < 4; n++) tryBlock('frontage', n)
  // Outparcels out in the lot: one or two round a lot field, up to two in a
  // mixed block, one more where fewer than two strips or frontage blocks
  // (the buildings of many rooms) fit.
  const roomy = blocks.filter((b) => b.kind === 'strip' || b.kind === 'frontage').length
  const nPads = padless ? 0 : (mode === 'field' ? 1 + pick(S_BLOCK, 2, 0x50) : pick(S_BLOCK, 3, 0x50)) + (roomy < 2 ? 1 : 0)
  for (let k = 0, n = 20; k < nPads && n < 26; n++) {
    const before = blocks.length
    tryBlock('pad', n)
    if (blocks.length > before) k++
  }

  // 4. Booths: bus shelters on the walks, pay booths and small kiosks.
  const booths = []
  const nBooths = 2 + pick(S_BOOTH, 3, 0) + (mode === 'field' ? 1 : 0)
  for (let n = 0; n < nBooths; n++) {
    const b = placeBooth(n, parcel, occ, H, pick)
    if (b) booths.push(b)
  }

  // 5. Lots: the largest free rectangles, until none is a bay deep.
  const lotRects = []
  for (let n = 0; n < 12; n++) {
    const r = largestFree(occ, parcel)
    if (!r) break
    const w = r.x1 - r.x0 + 1
    const d = r.z1 - r.z0 + 1
    if (Math.min(w, d) < 5 || w * d < 50) break
    const axis = w === d ? ((H(S_LOT, n) & 1) ? 'x' : 'z') : w > d ? 'x' : 'z'
    lotRects.push({ rect: Object.freeze(r), axis, n })
    occ.mark(r, HARD)
  }

  // 6. Lot stair heads: an enclosed core standing in a lot, down to the
  //    under-lot deck (p 0.35 per lot; forced, biggest lot first, until the
  //    district has MIN_CORES).
  const byArea = [...lotRects].sort((a, b) => area(b.rect) - area(a.rect) || a.n - b.n)
  for (const lot of byArea) {
    const need = cores.length < MIN_CORES
    if (!need && !chance(S_LOTCORE, P_LOT_CORE, lot.n)) continue
    const c = lotCore(lot, H, pick, coreChunks)
    if (!c) continue
    lot.core = c
    cores.push(c)
    coreChunks.add(`${c.lcx},${c.lcz}`)
  }
  // Never a district without a stair: when the outparcels took the ground
  // every stair needs, the district is drawn again without them.
  if (!padless && !kiosk && !cores.length && !lotRects.some((l) => l.core) && blocks.some((b) => b.kind === 'pad')) {
    const again = buildBlueprint(seed, tx, tz, true, frontFirst)
    if (again.cores.length) return again
  }
  const lots = lotRects.map((l) => Object.freeze(l))
  // 7. Still short of MIN_CORES (the buildings and outparcels took the
  //    lots): a strip mall or a big box without a stair gets one.
  for (let i = 0; i < blocks.length && cores.length < MIN_CORES; i++) {
    const b = blocks[i]
    if ((b.kind !== 'strip' && b.kind !== 'bigbox') || b.core) continue
    const F = frameOf(b.rect, b.front, b.mirror)
    const core = b.kind === 'bigbox' ? stockCore(F, b.D, H, b.n, coreChunks) : hallCore(F, b.alley, H, b.n, coreChunks, DECK_CY)
    if (!core) continue
    blocks[i] = Object.freeze({ ...b, core })
    cores.push(core)
    coreChunks.add(`${core.lcx},${core.lcz}`)
  }

  // The upper storey (cy 1): the garage's roof deck and the frontage blocks'
  // upper floors (upperBody). A frontage body is cut into slices by the chunk
  // lines across its length; a slice joins the storey's footprint whole
  // (every chunk its depth touches: placeBlock keeps four rows or more in
  // each, so the walkway and the doors' row are always up with the rooms)
  // when it is MIN_UP_SLICE columns wide or more and the body covers
  // MIN_UP_AREA cells of each of its chunks, and always when it holds the
  // stair hall (its core and the cell outside its door share a chunk). Other
  // end slices stay on the ground floor only (the tile clips them,
  // upperAllowed), so no kept upper chunk is a near-solid sliver. The
  // garage's rect sits one cell inside its chunks, so its roof keeps them
  // all.
  const upMask = upMaskOf()
  // The home district's spawn: the refuge apron (blocks[0] is the gas station).
  let spawn = null
  if (home) {
    const gas = blocks.find((b) => b.kind === 'gas')
    if (!gas) throw new Error('nightlot: the home district has no refuge')
    spawn = Object.freeze(gas.spawn.map((c) => Object.freeze({ gx: tx * SPAN + c[0], gz: tz * SPAN + c[1] })))
  }

  return Object.freeze({
    tx, tz, seed, mode,
    roads: Object.freeze({ wW, wN, vE, vS, iW, iN }),
    parcel: Object.freeze(parcel),
    garage,
    kiosk,
    blocks: Object.freeze(blocks),
    booths: Object.freeze(booths),
    lots: Object.freeze(lots),
    cores: Object.freeze(cores),
    upMask,
    spawn,
    free: occ.a, // the placement grid after lots (FREE cells are open apron)
  })
}

const area = (r) => (r.x1 < r.x0 || r.z1 < r.z0 ? 0 : (r.x1 - r.x0 + 1) * (r.z1 - r.z0 + 1))

// The width (cells along a frontage block) of a slice of its upper floor, and
// its least share of each chunk, before that slice joins the footprint.
export const MIN_UP_SLICE = 6
export const MIN_UP_AREA = 84

// A frontage block's upper body (district-local rect): its building rows
// (behind the alley, up to the shop fronts) and, for a motel, the walkway
// over the shop walk, stepped back upTrim cells from the block's ends.
export function upperBody(b) {
  const F = frameOf(b.rect, b.front, b.mirror)
  const [t0, t1] = b.upTrim ?? [0, 0]
  return F.rectUV(t0, b.alley, F.L - 1 - t1, b.alley + b.D - 1 + (b.sub === 'motel' ? 1 : 0))
}

// A roofed strip mall's or big box's roof (district-local rows v0..v1 of
// its frame, and the rect): its building rows (behind the alley) and the
// canopy over its front walk (the covered walk below).
export const ROOF_MIN_AREA = 84
export function roofRows(b) {
  const [, , v0, v1] = roofSpan(b)
  return [v0, v1]
}
// The roof's extent in the block's frame [u0, u1, v0, v1], hashed per block:
// the alley's canopy (p 0.5, where there is an alley), the front walk's
// canopy (p 0.6), and a taller anchor section at one end (p 1/3, 4–10 cells,
// never over the bulkhead): solid on this storey, it steps the outline.
export function roofSpan(b) {
  const F = frameOf(b.rect, b.front, b.mirror)
  const q = b.seed >>> 0
  const big = b.kind === 'bigbox'
  const alleyC = !big && b.alley > 0 && (q & 1) === 1
  const frontC = ((q >>> 1) % 5) < 3
  const v0 = big || alleyC ? 0 : b.alley
  const v1 = big ? b.D - 1 + (frontC ? 2 : 0) : b.alley + b.D - 1 + (frontC ? 1 : 0)
  let [u0, u1] = [0, F.L - 1]
  if ((q >>> 4) % 3 === 0) {
    const t = 4 + ((q >>> 6) % 7)
    const east = ((q >>> 9) & 1) === 1
    const cu0 = b.core ? b.core.u - 1 : -1
    const cu1 = b.core ? b.core.u + 6 : -1
    if (east && F.L - t > cu1 && F.L - t >= 10) u1 = F.L - 1 - t
    else if (!east && t <= cu0 && F.L - t >= 10) u0 = t
  }
  return [u0, u1, v0, v1]
}
export function roofBody(b) {
  const F = frameOf(b.rect, b.front, b.mirror)
  const [u0, u1, v0, v1] = roofSpan(b)
  return F.rectUV(u0, v0, u1, v1)
}

// Whether district-local cell (x, z) may be an upper-storey cell of a body
// under footprint mask `upMask`: its chunk is kept, and it is not on the east
// column / south row of its chunk when the chunk across that line is not
// (§6.8 rule 1: those lines stay mass towards a footprint-solid chunk).
export function upperAllowed(upMask, x, z) {
  if (x < 0 || z < 0 || x >= SPAN || z >= SPAN) return false
  const lcx = Math.floor(x / CHUNK)
  const lcz = Math.floor(z / CHUNK)
  const on = (a, b) => a < DISTRICT && b < DISTRICT && ((upMask >>> (b * DISTRICT + a)) & 1) === 1
  if (!on(lcx, lcz)) return false
  if (local(x) === CHUNK - 1 && !on(lcx + 1, lcz)) return false
  if (local(z) === CHUNK - 1 && !on(lcx, lcz + 1)) return false
  return true
}

// A lot's stair head: a 6×4 / 4×6 enclosed core strictly inside one chunk,
// one cell inside the lot, in a chunk without a core; its door faces the
// lot's centre.
function lotCore(lot, H, pick, coreChunks) {
  const inner = grow(lot.rect, -1)
  const cands = []
  for (const dir of [STAIR.E, STAIR.W, STAIR.S, STAIR.N]) {
    const horiz = dir === STAIR.E || dir === STAIR.W
    const cw = horiz ? 6 : 4
    const ch = horiz ? 4 : 6
    for (let z0 = inner.z0; z0 + ch - 1 <= inner.z1; z0++) {
      for (let x0 = inner.x0; x0 + cw - 1 <= inner.x1; x0++) {
        const r = R(x0, z0, x0 + cw - 1, z0 + ch - 1)
        if (!coreFits(r) || coreChunks.has(`${Math.floor(x0 / CHUNK)},${Math.floor(z0 / CHUNK)}`)) continue
        cands.push({ r, dir })
      }
    }
  }
  if (!cands.length) return null
  const c = cands[pick(S_LOTCORE, cands.length, 0x10, lot.n)]
  const centre = [(lot.rect.x0 + lot.rect.x1) / 2, (lot.rect.z0 + lot.rect.z1) / 2]
  const near = coreDoorCells(c.r, c.dir, 'near').outside
  const far = coreDoorCells(c.r, c.dir, 'far').outside
  const d = (p) => Math.hypot(p[0] - centre[0], p[1] - centre[1])
  return makeCore(c.r, c.dir, d(far) < d(near) ? 'far' : 'near', true, 'lot-stair')
}

// The garage: [w, h] chunks at a chunk position, its deck rect (inset one
// cell inside its chunks), two cores in
// two different chunks — an enclosed stair tower and an open ramp flight —
// a vehicle entrance on a side facing the parcel, and a pay booth inside it.
function placeGarage(parcel, occ, H, pick) {
  const order = []
  const first = pick(S_GARAGE, GARAGE_SIZES.length, 0)
  for (let k = 0; k < GARAGE_SIZES.length; k++) order.push(GARAGE_SIZES[(first + k) % GARAGE_SIZES.length])
  for (const [w, h] of order) {
    const spots = []
    for (let c0z = 0; c0z + h <= DISTRICT; c0z++) {
      for (let c0x = 0; c0x + w <= DISTRICT; c0x++) {
        const rect = R(
          Math.max(c0x * CHUNK, parcel.x0 + 1),
          Math.max(c0z * CHUNK, parcel.z0 + 1),
          Math.min((c0x + w) * CHUNK - 2, parcel.x1 - 1),
          Math.min((c0z + h) * CHUNK - 2, parcel.z1 - 1)
        )
        if (rect.x1 - rect.x0 < 10 || rect.z1 - rect.z0 < 10) continue
        if (!occ.isFree(grow(rect, 1))) continue
        spots.push({ c0x, c0z, rect })
      }
    }
    if (!spots.length) continue
    // Spots where the roads and verges clip the deck least (it fills 3/4 of
    // its chunks or more) first: its roof deck is then no sliver up there.
    const full = spots.filter((p) => area(p.rect) >= 0.75 * w * h * CHUNK * CHUNK)
    const from = full.length && pick(S_GARAGE, 10, 12, w, h) < 9 ? full : spots
    const s = from[pick(S_GARAGE, from.length, 1, w, h)]
    const cores = garageCores(s, w, h, H, pick)
    if (!cores) continue
    occ.mark(grow(s.rect, 1), SOFT)
    occ.mark(s.rect, HARD)
    // The vehicle entrance: on a side of the deck whose outside lane faces
    // the parcel (not a seam road), centred at a hashed position.
    const sides = ['N', 'S', 'E', 'W'].filter((side) => {
      const r = s.rect
      if (side === 'N') return r.z0 - 2 >= parcel.z0
      if (side === 'S') return r.z1 + 2 <= parcel.z1
      if (side === 'W') return r.x0 - 2 >= parcel.x0
      return r.x1 + 2 <= parcel.x1
    })
    const entSide = sides.length ? sides[pick(S_GARAGE, sides.length, 5)] : ['N', 'S', 'E', 'W'][pick(S_GARAGE, 4, 6)]
    const along = entSide === 'N' || entSide === 'S' ? [s.rect.x0, s.rect.x1] : [s.rect.z0, s.rect.z1]
    const width = 3
    const span = along[1] - along[0] + 1 - width - 4
    const a0 = along[0] + 2 + (span > 0 ? pick(S_GARAGE, span + 1, 7) : 0)
    const entrance = Object.freeze({ side: entSide, a0, a1: a0 + width - 1 })
    // The pay booth: a 2×2 room inside the deck beside the entrance lane.
    const booth = garageBooth(s.rect, entrance, cores)
    return Object.freeze({
      chunks: Object.freeze({ c0x: s.c0x, c0z: s.c0z, w, h }),
      rect: Object.freeze(s.rect),
      cores: Object.freeze(cores),
      entrance,
      booth,
      pierStep: Object.freeze([5 + pick(S_GARAGE, 3, 8), 5 + pick(S_GARAGE, 3, 9)]),
      pierPhase: Object.freeze([pick(S_GARAGE, 4, 10), pick(S_GARAGE, 4, 11)]),
    })
  }
  return null
}

// The garage's two cores: candidates are 6×4 / 4×6 rects strictly inside a
// garage chunk (stairwellPlan's rule) and at least two cells inside the deck,
// hugging a deck corner. The tower is enclosed (door towards the deck), the
// ramp is an open flight; they take different chunks when the garage has two.
function garageCores(s, w, h, H, pick) {
  const deck = grow(s.rect, -2)
  const cands = []
  for (let lcz = s.c0z; lcz < s.c0z + h; lcz++) {
    for (let lcx = s.c0x; lcx < s.c0x + w; lcx++) {
      for (const dir of [STAIR.E, STAIR.W, STAIR.S, STAIR.N]) {
        const horiz = dir === STAIR.E || dir === STAIR.W
        const cw = horiz ? 6 : 4
        const ch = horiz ? 4 : 6
        for (let ax = 1; ax <= CHUNK - 1 - cw; ax++) {
          for (let az = 1; az <= CHUNK - 1 - ch; az++) {
            const r = R(lcx * CHUNK + ax, lcz * CHUNK + az, lcx * CHUNK + ax + cw - 1, lcz * CHUNK + az + ch - 1)
            if (!coreFits(r) || !insideRect(r, deck)) continue
            cands.push({ r, dir, lcx, lcz })
          }
        }
      }
    }
  }
  if (!cands.length) return null
  // Prefer cores against the deck's edge (stair towers stand at the walls).
  const edge = cands.filter(({ r }) => r.x0 === deck.x0 || r.x1 === deck.x1 || r.z0 === deck.z0 || r.z1 === deck.z1)
  if (edge.length) cands.splice(0, cands.length, ...edge)
  const centre = [(s.rect.x0 + s.rect.x1) / 2, (s.rect.z0 + s.rect.z1) / 2]
  const doorSideOf = (r, dir) => {
    // The door side whose outside cell is nearer the deck centre.
    const near = coreDoorCells(r, dir, 'near').outside
    const far = coreDoorCells(r, dir, 'far').outside
    const d = (c) => Math.hypot(c[0] - centre[0], c[1] - centre[1])
    return d(far) < d(near) ? 'far' : 'near'
  }
  const a = cands[pick(S_GARAGE, cands.length, 20)]
  const tower = makeCore(a.r, a.dir, doorSideOf(a.r, a.dir), true, 'garage-tower', UP_CY)
  const rest = cands.filter((c) => (c.lcx !== a.lcx || c.lcz !== a.lcz) && !overlaps(grow(c.r, 2), a.r))
  if (!rest.length) return [tower]
  const b = rest[pick(S_GARAGE, rest.length, 21)]
  return [tower, makeCore(b.r, b.dir, doorSideOf(b.r, b.dir), false, 'garage-ramp', UP_CY)]
}

// The garage pay booth: 2×2 cells inside the deck, beside the entrance lane,
// clear of the cores.
function garageBooth(rect, entrance, cores) {
  const { side, a0, a1 } = entrance
  const tries = []
  for (const off of [a1 + 2, a0 - 3, a1 + 4, a0 - 5]) {
    if (side === 'N') tries.push(R(off, rect.z0 + 1, off + 1, rect.z0 + 2))
    if (side === 'S') tries.push(R(off, rect.z1 - 2, off + 1, rect.z1 - 1))
    if (side === 'W') tries.push(R(rect.x0 + 1, off, rect.x0 + 2, off + 1))
    if (side === 'E') tries.push(R(rect.x1 - 2, off, rect.x1 - 1, off + 1))
  }
  const ok = tries.find((r) => insideRect(grow(r, 1), rect) && !cores.some((c) => overlaps(grow(c.rect, 2), grow(r, 1))))
  return ok ? Object.freeze(ok) : null
}

// One block of kind `kind`: canonical size, orientation, and a position with
// its back against the parcel edge or another building where one exists.
function placeBlock(kind, n, parcel, occ, H, pick, chance, coreChunks) {
  const spec = BLOCK_SPECS[kind]
  const fronts = ['S', 'N', 'E', 'W']
  const f0 = pick(S_BLOCK, 4, n, 0x10)
  const mirror = (H(S_BLOCK, n, 0x11) & 1) === 1
  const D = spec.D[0] + pick(S_BLOCK, spec.D[1] - spec.D[0] + 1, n, 0x12)
  const alley = kind === 'strip' ? (chance(S_BLOCK, 0.7, n, 0x13) ? 2 : 0) : kind === 'frontage' ? (chance(S_BLOCK, 0.5, n, 0x13) ? 2 : 0) : 0
  const walk = kind === 'bigbox' ? 2 : kind === 'gas' ? 0 : 1
  const Dt = alley + D + walk
  const Lmax = spec.L[1]
  const Lmin = spec.L[0]
  const sub = kind === 'frontage' ? (chance(S_BLOCK, 0.5, n, 0x14) ? 'motel' : 'offices') : kind
  // A strip mall's stair hall down to its stock basement (p 0.7); a big
  // box's stock stair behind its vestibule (p 0.5).
  const cored = kind === 'frontage' || (kind === 'strip' && chance(S_BLOCK, 0.85, n, 0x18)) || (kind === 'bigbox' && chance(S_BLOCK, 0.7, n, 0x18))
  // A cored strip mall or big box may take its stair on up to a walkable
  // roof (cy 1): a bulkhead over the stair hall.
  const roofed = (kind === 'strip' || kind === 'bigbox') && cored && chance(S_BLOCK, P_ROOF, n, 0x1b)
  // A frontage block's upper floor is cut by chunk lines only along its
  // length: across its depth every chunk band holds four rows or more, and
  // its far side never lies on a chunk's east column / south row (the clip
  // would take the walkway or the doors' row).
  const deep = D - 1 + (sub === 'motel' ? 1 : 0)
  const depthOk = (rect, front) => {
    const [p0, p1] = front === 'S' ? [rect.z0 + alley, rect.z0 + alley + deep]
      : front === 'N' ? [rect.z1 - alley - deep, rect.z1 - alley]
        : front === 'E' ? [rect.x0 + alley, rect.x0 + alley + deep]
          : [rect.x1 - alley - deep, rect.x1 - alley]
    if (local(p1) === CHUNK - 1) return false
    for (let c = Math.floor(p0 / CHUNK) + 1; c * CHUNK <= p1; c++) if (c * CHUNK - p0 < 4 || p1 - c * CHUNK + 1 < 4) return false
    return true
  }
  // Whether a body (rows `deep` + 1 behind the alley) lies in one chunk band
  // across its depth: its upper storey then fills the chunks it keeps.
  const flatOf = (rect, front, d, off = alley) => {
    const [p0, p1] = front === 'S' ? [rect.z0 + off, rect.z0 + off + d]
      : front === 'N' ? [rect.z1 - off - d, rect.z1 - off]
        : front === 'E' ? [rect.x0 + off, rect.x0 + off + d]
          : [rect.x1 - off - d, rect.x1 - off]
    return Math.floor(p0 / CHUNK) === Math.floor(p1 / CHUNK) && local(p1) !== CHUNK - 1
  }
  const roofDeep = alley + D + walk - 1 // a roof: the alley's and the walk's canopies and the building's rows
  for (let attempt = 0; attempt < 4; attempt++) {
    const L = attempt < 3 ? Lmax - Math.floor(((Lmax - Lmin) * attempt) / 2) - pick(S_BLOCK, 5, n, 0x15, attempt) : Math.max(10, Lmin - 2)
    const cands = []
    for (let k = 0; k < 4; k++) {
      const front = fronts[(f0 + k) % 4]
      const alongX = front === 'S' || front === 'N'
      const w = alongX ? L : Dt
      const d = alongX ? Dt : L
      for (let z0 = parcel.z0; z0 + d - 1 <= parcel.z1; z0++) {
        for (let x0 = parcel.x0; x0 + w - 1 <= parcel.x1; x0++) {
          const rect = R(x0, z0, x0 + w - 1, z0 + d - 1)
          if (!occ.isFree(rect)) continue
          if (kind === 'frontage' && !depthOk(rect, front)) continue
          // Clearance: one cell all round, two in front, never a building.
          const back = BACK_OF[front]
          const clear = grow(rect, 1)
          const [fx, fz] = DIR_VEC[front]
          const ahead = R(clear.x0 + Math.min(0, fx), clear.z0 + Math.min(0, fz), clear.x1 + Math.max(0, fx), clear.z1 + Math.max(0, fz))
          if (!occ.noHard(ahead)) {
            // The back may touch the parcel edge or a building; nothing else may.
            if (!backOk(occ, rect, back, ahead)) continue
          }
          const [bx, bz] = DIR_VEC[back]
          const backRow = bx ? (bx < 0 ? R(rect.x0 - 1, rect.z0, rect.x0 - 1, rect.z1) : R(rect.x1 + 1, rect.z0, rect.x1 + 1, rect.z1))
            : (bz < 0 ? R(rect.x0, rect.z0 - 1, rect.x1, rect.z0 - 1) : R(rect.x0, rect.z1 + 1, rect.x1, rect.z1 + 1))
          const backed = !occ.isFree(backRow)
          const flat = kind === 'frontage' ? flatOf(rect, front, deep) : roofed ? flatOf(rect, front, roofDeep, 0) : false
          cands.push({ rect, front, backed, flat })
        }
      }
    }
    if (!cands.length) continue
    // A building with an upper storey stands, where it can, with its body in
    // one chunk band (a roofed one p 0.7), so its upper storey is no sliver.
    const flats = cands.filter((c) => c.flat)
    const base = flats.length && pick(S_BLOCK, 20, n, 0x1c) < 14 ? flats : cands
    const backed = base.filter((c) => c.backed)
    const pool = backed.length && pick(S_BLOCK, 2, n, 0x16) !== 0 ? backed : base
    // The hashed pick, then the next candidates in turn until a frontage
    // block finds its stair hall (a strip's is optional).
    const start = pick(S_BLOCK, pool.length, n, 0x17, attempt)
    let c = null
    for (let t = 0; t < pool.length && !c; t++) {
      const cand = pool[(start + t) % pool.length]
      const F = frameOf(cand.rect, cand.front, mirror)
      const top = kind === 'frontage' || roofed ? UP_CY : DECK_CY
      // The upper storey's rect over the block (its upper floor or roof).
      const body = kind === 'frontage' ? F.rectUV(0, alley, F.L - 1, alley + deep)
        : roofed ? F.rectUV(0, 0, F.L - 1, roofDeep) : null
      const core = !cored ? null : kind === 'bigbox' ? stockCore(F, D, H, n, coreChunks, top, body) : hallCore(F, alley, H, n, coreChunks, top, 'stair-hall', body)
      if (!core && kind === 'frontage') continue
      c = { ...cand, F, core }
    }
    if (!c) continue
    occ.mark(grow(c.rect, 1), SOFT)
    const [fx, fz] = DIR_VEC[c.front]
    occ.mark(R(c.rect.x0 + 2 * Math.min(0, fx), c.rect.z0 + 2 * Math.min(0, fz), c.rect.x1 + 2 * Math.max(0, fx), c.rect.z1 + 2 * Math.max(0, fz)), SOFT)
    occ.mark(c.rect, HARD)
    const block = {
      kind, sub, n,
      rect: Object.freeze(c.rect),
      front: c.front,
      mirror,
      alley, D, walk,
      L: c.F.L,
      core: c.core,
      seed: H(S_DETAIL, n, 0x20),
    }
    if (roofed && c.core?.topCy === UP_CY) block.roof = true
    if (kind === 'frontage' && c.core.topCy === UP_CY) block.upper = true
    if (kind === 'gas') block.spawn = gasSpawnCells(c.F)
    // A frontage block's upper floor steps back 0–4 cells from either end
    // (never into its stair hall's columns): the massing reads stepped.
    if (block.upper) {
      const t0 = Math.min(pick(S_BLOCK, 5, n, 0x19), Math.max(0, c.core.u - 2))
      const t1 = Math.min(pick(S_BLOCK, 5, n, 0x1a), Math.max(0, c.F.L - 1 - (c.core.u + 5) - 2))
      block.upTrim = Object.freeze([t0, t1])
    }
    return Object.freeze(block)
  }
  return null
}

// A block whose clearance would touch a building: allowed only where the
// touching cells lie behind the block (its back against another building or
// the parcel edge), never beside or in front of it.
const BACK_OF = Object.freeze({ S: 'N', N: 'S', E: 'W', W: 'E' })
function backOk(occ, rect, back, ahead) {
  for (let z = ahead.z0; z <= ahead.z1; z++) {
    for (let x = ahead.x0; x <= ahead.x1; x++) {
      if (inRect(rect, x, z) || occ.at(x, z) !== HARD) continue
      // Behind: one step past the back edge.
      const [bx, bz] = DIR_VEC[back]
      const behind = bx ? (bx < 0 ? x < rect.x0 : x > rect.x1) && z >= rect.z0 && z <= rect.z1
        : (bz < 0 ? z < rect.z0 : z > rect.z1) && x >= rect.x0 && x <= rect.x1
      if (!behind) return false
    }
  }
  return true
}

// A block's stair hall: a 6×4 core in its back rows (behind the alley),
// strictly inside one chunk, in a chunk without a core, with its door
// towards the front; it goes down to the block's basement suite.
// A climbing core (`body`: the upper storey's rect over the block) prefers a
// spot whose chunk the body fills half or more: that chunk joins the upper
// footprint whatever its share, so it should be no sliver.
const CORE_CHUNK_AREA = 98
function hallCore(F, alley, H, n, coreChunks, topCy, role = 'stair-hall', body = null) {
  let spots = []
  for (let u = 2; u + 5 <= F.L - 3; u++) {
    const r = F.rectUV(u, alley, u + 5, alley + 3)
    if (!coreFits(r) || coreChunks.has(`${Math.floor(r.x0 / CHUNK)},${Math.floor(r.z0 / CHUNK)}`)) continue
    spots.push({ u, r })
  }
  if (!spots.length) return null
  if (body) {
    const fill = (r) => {
      const cx = Math.floor(r.x0 / CHUNK) * CHUNK
      const cz = Math.floor(r.z0 / CHUNK) * CHUNK
      const w = Math.min(body.x1, cx + CHUNK - 1) - Math.max(body.x0, cx) + 1
      const d = Math.min(body.z1, cz + CHUNK - 1) - Math.max(body.z0, cz) + 1
      return w > 0 && d > 0 ? w * d : 0
    }
    const fat = spots.filter((p) => fill(p.r) >= CORE_CHUNK_AREA)
    if (fat.length) spots = fat
    else {
      const best = Math.max(...spots.map((p) => fill(p.r)))
      spots = spots.filter((p) => fill(p.r) === best)
    }
  }
  const s = spots[H(S_BLOCK, n, 0x30, spots.length) % spots.length]
  const horiz = s.r.x1 - s.r.x0 === 5
  const dir = horiz ? (F.ux > 0 ? STAIR.E : STAIR.W) : (F.uz > 0 ? STAIR.S : STAIR.N)
  // The door faces the front (+V).
  const doorSide = horiz ? (F.vz > 0 ? 'far' : 'near') : (F.vx > 0 ? 'far' : 'near')
  const core = makeCore(s.r, dir, doorSide, true, role, topCy)
  // The canonical column of the cell outside its door.
  let du = -1
  for (let u = s.u; u <= s.u + 5; u++) {
    const [x, z] = F.cell(u, alley + 4)
    if (x === core.door.outside[0] && z === core.door.outside[1]) du = u
  }
  return Object.freeze({ ...core, u: s.u, du })
}

// A big box's stock stair: a stair hall in the store's mass behind its
// vestibule (rows D−7..D−4), its door opening into the vestibule (the tile
// centres the vestibule on it), down to the stock hall.
function stockCore(F, D, H, n, coreChunks, topCy = DECK_CY, body = null) {
  const c = hallCore(F, D - 7, H, n ^ 0x55, coreChunks, topCy, 'stock-stair', body)
  return c && c.du >= 3 && c.du <= F.L - 6 ? c : null
}

// The refuge apron's spawn cells: the apron's middle row, centre outwards.
function gasSpawnCells(F) {
  const v = F.D - 3
  const mid = Math.floor(F.L / 2)
  return [0, 1, -1, 2, -2].map((du) => F.cell(mid + du, v))
}

// Booths: a bus shelter on a walk beside a seam road, or a pay booth / small
// kiosk in the parcel. 3×2 (shelter) or 2×2..3×3 cells, one clear cell all
// round.
function placeBooth(n, parcel, occ, H, pick) {
  const kinds = ['shelter', 'booth', 'kiosk']
  const kind = kinds[pick(S_BOOTH, 3, n, 1)]
  const w = kind === 'shelter' ? 3 : 2 + pick(S_BOOTH, 2, n, 2)
  const d = kind === 'shelter' ? 1 : 2 + pick(S_BOOTH, 2, n, 3)
  const cands = []
  for (const alongX of [true, false]) {
    const bw = alongX ? w : d
    const bd = alongX ? d : w
    for (let z0 = parcel.z0 + 1; z0 + bd <= parcel.z1; z0++) {
      for (let x0 = parcel.x0 + 1; x0 + bw <= parcel.x1; x0++) {
        const r = R(x0, z0, x0 + bw - 1, z0 + bd - 1)
        if (!occ.isFree(grow(r, 2))) continue
        cands.push({ r, alongX })
      }
    }
  }
  if (!cands.length) return null
  const c = cands[pick(S_BOOTH, cands.length, n, 4)]
  occ.mark(grow(c.r, 1), SOFT)
  occ.mark(c.r, HARD)
  const front = c.alongX ? ((H(S_BOOTH, n, 5) & 1) ? 'S' : 'N') : ((H(S_BOOTH, n, 5) & 1) ? 'E' : 'W')
  return Object.freeze({ kind, n, rect: Object.freeze(c.r), front })
}

// --- districts: exit anchor ------------------------------------------------------------------

// The 16 districts at Chebyshev distance 2 from district (0,0), ring order.
export const RING2 = Object.freeze((() => {
  const out = []
  for (let tz = -2; tz <= 2; tz++) for (let tx = -2; tx <= 2; tx++) if (cheb(tx, tz, 0, 0) === 2) out.push(Object.freeze({ tx, tz }))
  return out
})())

// The exit (anchor) district: one of the 16 on the distance-2 ring.
export const anchorDistrict = (worldSeed) => RING2[hk(worldSeed, S_EXIT, 0x0e) % RING2.length]
function isAnchor(seed, tx, tz) {
  const a = anchorDistrict(seed)
  return a.tx === tx && a.tz === tz
}

// The district mode, pure: the home and exit districts are always mixed.
function modeOf(seed, tx, tz) {
  if ((tx === 0 && tz === 0) || isAnchor(seed, tx, tz)) return 'mixed'
  return (hd(seed, S_MODE, tx, tz, 0) % 10000) / 10000 < P_FIELD ? 'field' : 'mixed'
}

// Refuges (doc §4.3 step 6: rare, never adjacent to another refuge): the home
// district always holds one and its edge neighbours never; elsewhere a mixed
// district rolls P_GAS and keeps the refuge unless its west or north
// neighbour rolled one too. Two edge neighbours can never both keep one (the
// eastern/southern one would need the other's roll to fail), and the rule
// reads only pure per-district rolls, so it is order-free.
function rawGas(seed, tx, tz) {
  if (Math.abs(tx) + Math.abs(tz) <= 1) return false
  return modeOf(seed, tx, tz) === 'mixed' && (hd(seed, S_GAS, tx, tz, 0) % 10000) / 10000 < P_GAS
}
export function gasDistrict(worldSeed, tx, tz) {
  const seed = worldSeed >>> 0
  if (tx === 0 && tz === 0) return true
  return rawGas(seed, tx, tz) && !rawGas(seed, tx - 1, tz) && !rawGas(seed, tx, tz - 1)
}

// --- anomalies ------------------------------------------------------------------------------

// Per-district anomaly (§12.0, §12.2; doc 02 §3, §10: repetition makes the
// rare deviation loud; doc 14: the night lot's segment is the district, at
// most one per segment, never on the exit segment, classes rotated). A
// district carries one with p ANOMALY_RATE, hashed from (worldSeed,
// district) with a preferred class and a priority; never within one district
// of the spawn district and never in the exit district.
// Rotation is greedy in priority order: a district takes its preferred class
// unless an edge neighbour of higher priority holds it, then the next class;
// so no two edge-adjacent districts share a class. The recursion only climbs
// strictly rising priorities, so the result is pure and order-independent.
//   'burning-pole'  a mercury pole burns in a dead circuit, a lone cart in its
//                   pool (doc §10 #2)
//   'dead-cluster'  every island circuit of the district fails at once
//   'full-lot'      every stall of one lot holds the same vehicle except one,
//                   empty and lit (doc §10 #1)
//   'countdown'     the stall plates count down toward the exit, then repeat
//                   (doc §10 #5); elsewhere every plate reads 'b4' (#9)
//   'deja-vu'       the frontage repeats: every such district shows the same
//                   run of shop fronts, lit the same way (doc §10 #3, inverted)
//   'odd-sodium'    the lit islands are cold LED except one sodium pole
//                   (doc §10 #11)
export const ANOMALY_CLASSES = Object.freeze(['burning-pole', 'dead-cluster', 'full-lot', 'countdown', 'deja-vu', 'odd-sodium'])
// The preferred class of a district, in sixteenths.
const ANOMALY_PREFERENCE = Object.freeze([0, 0, 0, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5])
const DEAD_CLUSTER = 1
export const ANOMALY_RATE = 0.3
const EDGE_NEIGHBOURS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]])

function rawAnomaly(seed, tx, tz) {
  if (cheb(tx, tz, 0, 0) <= 1) return null
  if (isAnchor(seed, tx, tz)) return null
  if ((hd(seed, S_ANOMALY, tx, tz, 0x7a7e) % 10000) / 10000 >= ANOMALY_RATE) return null
  const h = hk(seed, S_ANOMALY, tx, tz)
  return { cls: ANOMALY_PREFERENCE[h & 15], pri: h >>> 4, tx, tz }
}

const outranks = (a, b) => a.pri > b.pri || (a.pri === b.pri && (a.tx > b.tx || (a.tx === b.tx && a.tz > b.tz)))

function finalClass(seed, me, cache) {
  const key = `${me.tx},${me.tz}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const taken = new Set()
  for (const [dx, dz] of EDGE_NEIGHBOURS) {
    const n = rawAnomaly(seed, me.tx + dx, me.tz + dz)
    if (!n || !outranks(n, me)) continue
    const c = finalClass(seed, n, cache)
    if (c >= 0) taken.add(c)
  }
  let out = -1
  for (let k = 0; k < ANOMALY_CLASSES.length && out < 0; k++) {
    const c = (me.cls + k) % ANOMALY_CLASSES.length
    if (k > 0 && c === DEAD_CLUSTER) continue
    if (!taken.has(c)) out = c
  }
  cache.set(key, out)
  return out
}

const anomalyMemo = memo(8192, (seed, tx, tz) => {
  const me = rawAnomaly(seed, tx, tz)
  if (!me) return null
  const c = finalClass(seed, me, new Map())
  return c < 0 ? null : ANOMALY_CLASSES[c]
})
export const anomalyAt = (worldSeed, tx, tz) => anomalyMemo(`${worldSeed >>> 0}|${tx},${tz}`, worldSeed >>> 0, tx, tz)

// The level plates: 'b4' on every lot chunk (the stall numbering repeats,
// doc §10 #9), the countdown in a 'countdown' district, 'P-1' on the
// undercroft. Pure in (worldSeed, chunk, cy).
export const DECK_LABEL = 'b4'
export const BASEMENT_LABEL = 'P-1'
export function deckLabel(worldSeed, cx, cz) {
  const tx = floorDiv(cx, DISTRICT)
  const tz = floorDiv(cz, DISTRICT)
  if (anomalyAt(worldSeed, tx, tz) !== 'countdown') return DECK_LABEL
  const e = exitAnchor(worldSeed)
  return `b${cheb(cx, cz, e.cx, e.cz) % 10}`
}

// --- the world grid ---------------------------------------------------------------------------

const districtOfChunk = (cx, cz) => {
  const tx = floorDiv(cx, DISTRICT)
  const tz = floorDiv(cz, DISTRICT)
  return { tx, tz, lcx: cx - tx * DISTRICT, lcz: cz - tz * DISTRICT }
}

// The kiosk-with-basement module's chunk of district (tx, tz), GLOBAL, or null.
export function kioskChunk(worldSeed, tx, tz) {
  const k = blueprint(worldSeed, tx, tz).kiosk
  return k ? { cx: tx * DISTRICT + k.lcx, cz: tz * DISTRICT + k.lcz } : null
}

export function isKioskChunk(worldSeed, cx, cz) {
  const { tx, tz, lcx, lcz } = districtOfChunk(cx, cz)
  const k = blueprint(worldSeed, tx, tz).kiosk
  return !!k && k.lcx === lcx && k.lcz === lcz
}

// The stair cores standing in GLOBAL chunk (cx, cz) (undercroft to lot or on
// to the upper storey; the kiosk's core is separate, see isKioskChunk).
export function coresAtChunk(worldSeed, cx, cz) {
  const { tx, tz, lcx, lcz } = districtOfChunk(cx, cz)
  return blueprint(worldSeed, tx, tz).cores.filter((c) => c.lcx === lcx && c.lcz === lcz)
}

// §6.5 footprint: the lot (cy 0) and the undercroft (cy −1) are whole; the
// upper storey (cy 1) only over the garage's chunks and the frontage blocks'
// (blueprint upMask); everything else is solid.
export function footprint(worldSeed, cx, cy, cz) {
  if (!tileKeyOf(TILE, cx, cy, cz)) return 'solid'
  if (cy !== UP_CY) return 'tile'
  const { tx, tz, lcx, lcz } = districtOfChunk(cx, cz)
  return (blueprint(worldSeed, tx, tz).upMask >>> (lcz * DISTRICT + lcx)) & 1 ? 'tile' : 'solid'
}

// The upper storey's chunks of district (tx, tz), local [lcx, lcz] pairs.
export function upperChunks(worldSeed, tx, tz) {
  const m = blueprint(worldSeed, tx, tz).upMask
  const out = []
  for (let i = 0; i < DISTRICT * DISTRICT; i++) if ((m >>> i) & 1) out.push([i % DISTRICT, Math.floor(i / DISTRICT)])
  return out
}

// The underpasses of the undercroft: 1–2 tunnels, 3–5 cells wide, under each
// seam road, at hashed positions along the seam (cells 6..49), pure in
// (worldSeed, district, side): district (tx, tz) owns its west and north
// seams; its east view is ports(tx + 1, 'west'), its south ports(tz + 1,
// 'north').
const UNDER_LO = 6
const UNDER_HI = 49
const underMemo = memo(4096, (seed, tx, tz, side) => {
  const h = (...v) => hd(seed, S_UNDER, tx, tz, side === 'west' ? 1 : 2, ...v)
  const n = 1 + (h(0) & 1)
  const part = Math.floor((UNDER_HI - UNDER_LO + 1) / n)
  const out = []
  for (let k = 0; k < n; k++) {
    const w = 3 + (h(1, k) % 3)
    const lo = UNDER_LO + k * part
    const a0 = lo + (h(2, k) % (part - w - 1))
    out.push(Object.freeze({ a0, a1: a0 + w - 1 }))
  }
  return Object.freeze(out)
})
export const underPorts = (worldSeed, tx, tz, side) => underMemo(`${worldSeed >>> 0}|${tx},${tz},${side}`, worldSeed >>> 0, tx, tz, side)

// Ports (§6.5, §6.8 rules 3–4): the lot is an open plane, so its ports cover
// the whole seam on every side; the undercroft opens on its underpasses.
const DECK_PORTS = Object.freeze([Object.freeze({ a0: 0, a1: SPAN - 1 })])
const NO_PORTS = Object.freeze([])
export function ports(worldSeed, k, side, cy) {
  if (side !== 'west' && side !== 'north') return NO_PORTS
  if (cy === DECK_CY) return DECK_PORTS
  if (cy === BASEMENT_CY) return underPorts(worldSeed, k.tx, k.tz, side)
  return NO_PORTS
}

// The band key of district (tx, tz).
export const districtKey = (tx, tz) => tileKeyAt(TILE, tx, tz, 0)

// --- the kiosk with a basement (canonical module cells) ----------------------------------------

// The module (≥ 10×8): on the lot a lit kiosk (cells 2..11 × 3..10, doors on
// its south wall at 6..7) round a stairwellPlan core whose landing is (4, 6),
// flight east; below, a service floor: a lobby round the core, a corridor, a
// plant room and a store room.
export const KIOSK = Object.freeze({
  room: Object.freeze({ x0: 2, z0: 3, x1: 11, z1: 10 }),
  doors: Object.freeze([6, 7]), // south wall, H-line 11
  landing: Object.freeze({ x: 4, z: 6 }),
  lobby: Object.freeze({ x0: 2, z0: 2, x1: 8, z1: 10 }),
  corridor: Object.freeze({ x0: 9, z0: 9, x1: 12, z1: 10 }),
  plant: Object.freeze({ x0: 9, z0: 2, x1: 12, z1: 8 }), // door H-line 9 at x 10
  store: Object.freeze({ x0: 2, z0: 11, x1: 12, z1: 12 }), // door H-line 11 at x 5
  exits: Object.freeze([[10, 5], [11, 4], [10, 7], [11, 6]].map((c) => Object.freeze(c))),
})

// The transform of the kiosk module of district (tx, tz) into its kind-local
// cells (the module square is its chunk).
export const kioskFrame = (k) => moduleTransform({ size: CHUNK, rot: k.rot, mirror: k.mirror, ox: k.lcx * CHUNK, oz: k.lcz * CHUNK })

// The exit candidates of district (tx, tz)'s kiosk basement: GLOBAL cells on
// cy −1, in order (null when the district has no kiosk).
export function kioskExitCells(worldSeed, tx, tz) {
  const k = blueprint(worldSeed, tx, tz).kiosk
  if (!k) return null
  const T = kioskFrame(k)
  return KIOSK.exits.map(([x, z]) => {
    const [gx, gz] = T.cell(x, z)
    return { gx: tx * SPAN + gx, gz: tz * SPAN + gz, cy: BASEMENT_CY }
  })
}

const asChunkCell = (gx, gz, cy) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { cx, cy, cz, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}

// §8.2 exit anchor: the first exit candidate in the exit district's kiosk
// basement (the cell its bake marks first).
export function exitAnchor(worldSeed) {
  const a = anchorDistrict(worldSeed >>> 0)
  const c = kioskExitCells(worldSeed >>> 0, a.tx, a.tz)[0]
  return asChunkCell(c.gx, c.gz, c.cy)
}

// §8.1 spawn: the refuge apron of district (0,0) (its canopy forced lit), on
// cy 0; fallbacks walk along the apron's middle row.
export function spawnCells(worldSeed) {
  return blueprint(worldSeed >>> 0, 0, 0).spawn.map((c) => ({ gx: c.gx, gz: c.gz }))
}
export const spawnChunkCell = (gx, gz) => asChunkCell(gx, gz, DECK_CY)

// Detail dice for the tile program: pure in (worldSeed, district, a, b).
export const detail = (worldSeed, tx, tz, a, b = 0) => hd(worldSeed, S_DETAIL, tx, tz, a | 0, b | 0)
