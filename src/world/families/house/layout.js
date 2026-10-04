import { CHUNK } from '../../constants.js'
import { RNG } from '../../core/rng.js'
import { hashChain } from '../../tiles/tileKey.js'
import {
  SHELL_BACK,
  SHELL_ZONE,
  TILE_D,
  TILE_W,
  anomalyAt,
  bandKey,
  chunkOf,
  depthOf,
  frameOf,
  hallOf,
  hasHall,
  hasLoop,
  planSeedOf,
  portLane,
} from './geometry.js'

// The house's floor-plan grammar (doc §4.3 modules, §4.4 generation sketch):
// every tile of the endless house is GROWN, storey by storey, from its frame
// (geometry.frameOf: the hashed seam doors, the stair cores, the Great Hall,
// which chunks each storey keeps) and its plan seed:
//
//   1. set pieces   the P.T. loop (loop/hall/shell tiles: ring size 6 — the
//                   doc's 3 + 2 L round a 4×4 block — by the front door,
//                   growing to 8, 10, 12 deeper in (loopSizesOf), anywhere
//                   on the ground storey, entered from the north or the
//                   west, left through the SE closet's back wall), the
//                   Great Hall's ring with its doors (one or two on the ground
//                   storey, the landing door, the Winchester door on top),
//                   the shell's yard corner on tile (0,0);
//   2. hallways     a corridor graph: every door that must be reached (seam
//                   doors, stair doors, hall doors, the loop's two doors, the
//                   shell's back door) plus 2..7 hashed junctions are joined by
//                   a randomised spanning tree of 1-cell hallways (Dijkstra
//                   with a turn penalty, a per-cell noise field, a penalty
//                   for running beside another hallway, the loop or the
//                   hall's ring, or one free cell off them: two halls round
//                   a 1-cell sliver of mass have no room between them, and
//                   one for a straight run past the tile's hall length, so
//                   a passage jogs), then 0..3 extra hallways close loops
//                   (doc §12: ≥ 2 loops per 10 nodes); unjoined junctions
//                   and leaves stay dead ends;
//   3. rooms        houses: WINGS hung off the hallways (a spine hall of 4
//                   to 6 cells by the front door, branching off the passage,
//                   never running straight on out of it, with a
//                   front door, a band of rooms each side read from a
//                   domestic programme: living, dining, kitchen facing the
//                   bedrooms and the bathroom on the ground storey, bedrooms,
//                   nursery, study and bath upstairs; often a row of rooms
//                   across the hall's end), bands of rooms along the other
//                   straight runs, rooms behind rooms (en-suite, pantry, den;
//                   deeper with tile depth: "the house grows"), each room a
//                   ROLE (ROLE_SPEC) of domestic size: 2×2 or 2×3 cells (6 ×
//                   6 to 6 × 9 m), a bathroom, WC or laundry 1×2 or 2×2; the
//                   blanks the hallways never reached (free squares of 4
//                   cells and more) get a hallway and houses of their own;
//                   then 1×1 / 1×2 closets in the leftovers; whatever is left
//                   is mass; then second
//                   doors (living–dining, dining–kitchen, kitchen–laundry,
//                   then a depth-scaled share; bathrooms and laundries keep
//                   one door) close room-level loops; the house's schema
//                   (one kitchen, dining room and living room to a house by
//                   the front door, repeats deeper in) picks the roles; HALL
//                   DOORS cut every straight run of hallway longer than
//                   hallCapOf(depth) (the doc's 1×4 hall by the front door,
//                   the long hallway at 13+) into one house's hall opening
//                   on the next;
//   4. anomalies    the copied room (a room and its twin side by side on one
//                   hallway), the red hallway (the ground storey's longest
//                   straight run).
//
// Pure in (worldSeed, tx, tz): the planner, the tile program and the tests
// read the same plan. Cells are tile-local (x 0..41, z 0..27).

export const W = TILE_W
export const D = TILE_D
const at = (x, z) => z * W + x
const inside = (x, z) => x >= 0 && z >= 0 && x < W && z < D

// Cell states of a storey grid.
export const BLOCK = -1 // not usable (footprint-solid, a forced-mass border)
export const FREE = 0
export const CORR = 1 // hallway
export const RES = 2 // a set piece (stair core, hall ring, loop, shell)
const ROOM0 = 10 // rooms: ROOM0 + room index
const BLOCK_TRIED = -2 // a free square's centre no hallway reaches (this pass only)

const DIRS = Object.freeze([[1, 0], [0, 1], [-1, 0], [0, -1]]) // E S W N

// Domestic rooms (doc §4.3, in 3 m cells: bath, WC, closet and laundry
// 1×1 to 2×2; bedrooms 2×2 to 2×3, a living room 2×3;
// nothing office-sized: the biggest room is 6 × 9 m). Per role: w = [min,
// max] cells along its hallway, d = the deepest it goes from the hallway,
// grow = [long, short] side caps when it grows into free cells beside it.
export const ROLE_SPEC = Object.freeze({
  living: { w: [3, 3], d: 2, grow: [3, 2] },
  dining: { w: [2, 2], d: 2, grow: [3, 2] },
  kitchen: { w: [2, 2], d: 2, grow: [3, 2] },
  bed: { w: [2, 2], d: 2, grow: [3, 2] },
  nursery: { w: [2, 2], d: 2, grow: [2, 2] },
  study: { w: [2, 2], d: 2, grow: [3, 2] },
  den: { w: [2, 2], d: 2, grow: [3, 2] },
  bath: { w: [1, 2], d: 2, grow: [2, 2] },
  laundry: { w: [1, 2], d: 2, grow: [2, 2] },
  closet: { w: [1, 1], d: 2, grow: [1, 1] },
})
// The longest side any room takes (the band's leftover rule).
const MAX_SIDE = 3
export const ROLES = Object.freeze(Object.keys(ROLE_SPEC))
// Room programmes, read along a band from the hallway's start. A wing on
// the ground storey is one house: the public side (living, dining,
// kitchen) faces the private side (bedrooms, the bathroom) across its hall;
// upstairs both sides sleep. Halls between houses take mixed programmes.
const PUBLIC_PROGRAMMES = Object.freeze([
  ['living', 'dining', 'kitchen'], ['living', 'kitchen', 'dining'], ['kitchen', 'dining', 'living'],
  ['living', 'dining', 'kitchen', 'laundry'], ['dining', 'kitchen', 'living'], ['living', 'den', 'kitchen'],
])
const PRIVATE_PROGRAMMES = Object.freeze([
  ['bed', 'bath', 'bed'], ['bath', 'bed', 'bed'], ['bed', 'laundry', 'bath', 'bed'], ['den', 'bath', 'bed'],
  ['bed', 'bath', 'bed', 'bed'], ['study', 'bath', 'bed'],
])
const UPPER_PROGRAMMES = Object.freeze([
  ['bed', 'bath', 'bed'], ['bed', 'bed', 'bath'], ['bed', 'study', 'bath'], ['bath', 'bed', 'nursery'],
  ['nursery', 'bath', 'bed'], ['bed', 'bath', 'bed', 'study'], ['den', 'bed', 'bath'], ['bed', 'nursery', 'bed'],
  ['bed', 'study', 'bed', 'bath'],
])
const HALL_PROGRAMMES = Object.freeze([
  ['bed', 'bath', 'bed'], ['living', 'dining', 'kitchen'], ['bed', 'bath'], ['kitchen', 'laundry', 'dining'],
  ['bed', 'bed', 'bath'], ['den', 'bath', 'bed'], ['dining', 'kitchen', 'living'],
])
// The rooms across the far end of a wing's hall: [main, the room behind it
// when the wing is wider than 4].
const GROUND_END = Object.freeze([['living', 'den'], ['bed', 'bath'], ['dining', 'kitchen'], ['bed', 'study'], ['living', 'study']])
const UPPER_END = Object.freeze([['bed', 'bath'], ['bed', 'study'], ['study', 'bed'], ['bed', 'nursery'], ['nursery', 'bath']])
// A wing's end width (a + 1 + b cells) split in rooms of 2..3.
const SPLITS = Object.freeze({ 5: [[3, 2], [2, 3]], 6: [[3, 3], [2, 2, 2]], 7: [[3, 2, 2], [2, 3, 2], [2, 2, 3]] })
// Rooms behind rooms, by the parent's role.
const CHILD_ROLES = Object.freeze({
  bed: ['bath', 'closet'], living: ['den', 'study'], kitchen: ['laundry', 'closet'], dining: ['kitchen'],
  den: ['closet'], study: ['closet'], nursery: ['closet'],
})
// The house's own second doors: [neighbour role, chance].
const AFFINITY = Object.freeze({
  living: [['dining', 0.8], ['den', 0.6]], dining: [['kitchen', 0.8]], kitchen: [['laundry', 0.5]],
})
// A band's short leftover (two cells along the hall).
const SHORT_ROLES = Object.freeze(['bath', 'study', 'nursery'])
// ... and a single cell: a WC or a linen closet.
const ONE_ROLES = Object.freeze(['bath', 'closet'])
// Rooms that keep a single door (no second doors, no rooms behind them).
const WET = new Set(['bath', 'laundry'])
// The schema's reach (cells, centre to centre, either axis) by tile depth:
// no second room of a public role this close to the first; per role, the
// share of the reach it keeps; the roles it gives way to (the first free,
// else a bedroom, or a bathroom in a 1-wide room).
const spreadOf = (depth) => (depth <= 3 ? 10 : depth <= 8 ? 8 : depth <= 12 ? 5 : 0)
const SPREAD = Object.freeze({ living: 1, dining: 1, kitchen: 1, den: 0.6, study: 0.6, laundry: 0.6, nursery: 0.6 })
const SUBS = Object.freeze({
  living: ['den', 'study'], dining: ['study', 'den'], kitchen: ['laundry', 'study'],
  den: ['study'], study: ['den'], laundry: ['bath'], nursery: ['study'],
})
// Free squares the hallways never reached that get a hallway (and houses).
const FILL_PASSES = 6
const FILL_MIN = 4 // the smallest free square (cells a side) that gets a hallway
const BLANK = Object.freeze([0.2, 0.25, 0.25]) // per storey: hallway sides left blank (mass behind the wall; few, or the halls run through mass)
// Rooms given a second door (doc §12 loops ≥ 2 per 10 nodes): the share
// rises with tile depth, LINK_BASE + LINK_DEPTH·depth, capped at LINK_MAX.
const LINK_BASE = 0.4
const LINK_DEPTH = 0.016
const LINK_MAX = 0.52

// --- the storey's usable cells ------------------------------------------------------------

// A kept chunk's east column / south row facing a foreign chunk (not kept on
// the storey, or outside the tile) is mass (§6.8 rule 1); the ground storey's
// east/south port cells are the exception.
export function usableMask(frame, cy) {
  const m = new Uint8Array(W * D)
  const mask = frame.up[cy]
  const kept = (lx, lz) => lx >= 0 && lx < 3 && lz >= 0 && lz < 2 && ((mask >> (lx + 3 * lz)) & 1) === 1
  for (let i = 0; i < 6; i++) {
    if (!((mask >> i) & 1)) continue
    const { lx, lz } = chunkOf(i)
    const eastForeign = !kept(lx + 1, lz)
    const southForeign = !kept(lx, lz + 1)
    for (let uz = 0; uz < 14; uz++) {
      for (let ux = 0; ux < 14; ux++) {
        if ((ux === 13 && eastForeign) || (uz === 13 && southForeign)) continue
        m[at(lx * 14 + ux, lz * 14 + uz)] = 1
      }
    }
  }
  if (cy === 0) {
    m[at(frame.ports.e.gx, frame.ports.e.gz)] = 1
    m[at(frame.ports.s.gx, frame.ports.s.gz)] = 1
  }
  return m
}

// --- Dijkstra router -------------------------------------------------------------------------

class Heap {
  constructor() {
    this.k = []
    this.v = []
  }
  get size() {
    return this.k.length
  }
  push(key, val) {
    const { k, v } = this
    let i = k.length
    k.push(key)
    v.push(val)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (k[p] <= key) break
      k[i] = k[p]
      v[i] = v[p]
      i = p
    }
    k[i] = key
    v[i] = val
  }
  pop() {
    const { k, v } = this
    const top = v[0]
    const lk = k.pop()
    const lv = v.pop()
    if (k.length) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= k.length) break
        if (c + 1 < k.length && k[c + 1] < k[c]) c++
        if (k[c] >= lk) break
        k[i] = k[c]
        v[i] = v[c]
        i = c
      }
      k[i] = lk
      v[i] = lv
    }
    return top
  }
}

// A cheapest path from `src` (cell index) to the hallway network (a CORR
// cell; with `minNet`, one at least that many steps along the network from
// `src`, read from `netDist`), stepping on free cells (and, with `ring`, on
// the Great Hall ring's cells at a premium). State = cell·4 + heading: a turn
// costs TURN; every cell costs 1 + its noise, a hallway reused less, a cell
// beside another hallway more (no double-wide halls). Returns the cells
// (src … target) or null.
const TURN = 6
const SLIVER = 2.5 // a hallway step one free cell off another hallway
// The heuristic's weight: a step costs 1 + noise (≤ 1.6) + penalties (RUN
// a cell past the hall length), so a weighted A* (HW > 1) finds a
// near-cheapest hallway after far fewer states (the bake budget); the
// hallways only need to wander, not be optimal.
const HW = 4
const NS = W * D * 4
const DIST = new Float32Array(NS)
const PREV = new Int32Array(NS)
const RUNL = new Int8Array(NS) // the straight run (cells) ending in each state
const HOPS = new Int32Array(W * D) // A* heuristic: steps to the nearest target
const QUEUE = new Int32Array(W * D)
const HEAP = new Heap()
const STEP = Object.freeze([1, W, -1, -W]) // E S W N, as DIRS
// The set pieces' own hallways on the storey being grown (the P.T. loop's
// L's, the Great Hall ring's outer cells): a hallway beside one, or one free
// cell off it, pays as beside a hallway (no doubled corridor round the loop).
const HALLISH = new Uint8Array(W * D)
// The straight run (cells) a hallway takes before RUN a cell (growStorey sets
// it from the tile's depth; 0: no limit).
const RUN = 6
let runCap = 0
const hallish = (o) => g_[o] === CORR || HALLISH[o] === 1
let g_ = null
function route(g, noise, src, { ring = null, netDist = null, minNet = 0 } = {}) {
  g_ = g
  const inRing = (n) => {
    if (ring === null || g[n] !== RES) return false
    const x = n % W
    const z = (n - x) / W
    return x >= ring.x0 && x <= ring.x1 && z >= ring.z0 && z <= ring.z1
  }
  const isTarget = (n) => g[n] === CORR && (netDist === null || netDist[n] >= minNet)
  const canStep = (n) => g[n] === FREE || inRing(n)
  // Steps from every cell to the nearest target over steppable cells (a
  // multi-source BFS): an admissible, consistent A* heuristic (a step costs
  // at least 1).
  HOPS.fill(-1)
  let qh = 0
  let qt = 0
  for (let n = 0; n < W * D; n++) {
    if (isTarget(n)) {
      HOPS[n] = 0
      QUEUE[qt++] = n
    }
  }
  while (qh < qt) {
    const c = QUEUE[qh++]
    const x = c % W
    for (let m = 0; m < 4; m++) {
      if ((m === 0 && x === W - 1) || (m === 2 && x === 0)) continue
      const n = c + STEP[m]
      if (n < 0 || n >= W * D || HOPS[n] >= 0 || !canStep(n)) continue
      HOPS[n] = HOPS[c] + 1
      QUEUE[qt++] = n
    }
  }
  if (HOPS[src] < 0) {
    // The source itself may be a hallway cell (a loop closing from the
    // network): one step more than its best free neighbour.
    let best = -1
    const sx = src % W
    for (let m = 0; m < 4; m++) {
      if ((m === 0 && sx === W - 1) || (m === 2 && sx === 0)) continue
      const n = src + STEP[m]
      if (n >= 0 && n < W * D && HOPS[n] > 0 && (best < 0 || HOPS[n] < best)) best = HOPS[n]
    }
    if (best < 0) return null
    HOPS[src] = best + 1
  }
  DIST.fill(Infinity)
  PREV.fill(-1)
  const heap = HEAP
  heap.k.length = 0
  heap.v.length = 0
  for (let h = 0; h < 4; h++) {
    DIST[src * 4 + h] = 0
    RUNL[src * 4 + h] = 0
    heap.push(HW * HOPS[src], src * 4 + h)
  }
  while (heap.size) {
    const s = heap.pop()
    const c = s >> 2
    const h = s & 3
    const dc = DIST[s]
    if (c !== src && isTarget(c)) {
      const cells = []
      let t = s
      while (t >= 0) {
        const cell = t >> 2
        if (cells[cells.length - 1] !== cell) cells.push(cell)
        t = PREV[t]
      }
      return cells.reverse()
    }
    const x = c % W
    for (let nh = 0; nh < 4; nh++) {
      if ((nh === 0 && x === W - 1) || (nh === 2 && x === 0)) continue
      const n = c + STEP[nh]
      if (n < 0 || n >= W * D || HOPS[n] < 0) continue
      const target = HOPS[n] === 0
      let step = 1 + noise[n]
      if (!target) {
        if (g[n] !== FREE) step += 6 // through the hall's ring
        else {
          // A free cell beside another hallway (not the one we come from),
          // or one free cell off it (two halls round a 1-cell sliver of mass
          // read as filler, not a house plan: no room fits between them).
          const nx = n % W
          let side = 0
          for (let m = 0; m < 4; m++) {
            if ((m === 0 && nx === W - 1) || (m === 2 && nx === 0)) continue
            const o = n + STEP[m]
            if (o < 0 || o >= W * D || o === c) continue
            if (hallish(o)) {
              side = 2
              break
            }
            const edge = (m === 0 && nx === W - 2) || (m === 2 && nx === 1)
            const o2 = o + STEP[m]
            if (!edge && o2 >= 0 && o2 < W * D && g[o] === FREE && hallish(o2)) side = 1
          }
          if (side === 2) step += 2.2
          else if (side === 1) step += SLIVER
        }
      }
      if (nh !== h && c !== src) step += TURN
      // A straight run past the storey's hall length pays RUN a cell: the
      // passage jogs (a hall, a turn, the next hall) instead of crossing the
      // tile in one line (the run is the one of the state's best path).
      const run = nh === h && c !== src ? RUNL[s] + 1 : 1
      if (runCap > 0 && run > runCap) step += RUN
      const nd = dc + step
      const ns = n * 4 + nh
      if (nd < DIST[ns]) {
        DIST[ns] = nd
        PREV[ns] = s
        RUNL[ns] = Math.min(run, 127)
        heap.push(nd + HW * HOPS[n], ns)
      }
    }
  }
  return null
}

// --- the plan --------------------------------------------------------------------------------

const PLANS = new Map()
const PLAN_MAX = 64

// The plan of tile (tx, tz): { frame, hall (geometry.hallOf or null),
// anomaly, loop, storeys: [StoreyPlan × 3], copy, red }. Memoised (small LRU).
export function planTile(worldSeed, tx, tz) {
  const seed = worldSeed >>> 0
  const key = `${seed}|${tx},${tz}`
  const hit = PLANS.get(key)
  if (hit) return hit
  const plan = buildPlan(seed, tx, tz)
  PLANS.set(key, plan)
  if (PLANS.size > PLAN_MAX) PLANS.delete(PLANS.keys().next().value)
  return plan
}

function buildPlan(seed, tx, tz) {
  const k = bandKey(tx, tz)
  const frame = frameOf(seed, tx, tz)
  const hall = hasHall(frame.variant) ? hallOf(seed, k) : null
  const anomaly = anomalyAt(seed, k)
  const depth = depthOf(tx, tz)
  const rnd = new RNG(hashChain(planSeedOf(seed, k), tx, tz, 0x1a40))
  const shell = frame.variant === 'shell'

  // Storey grids: usable cells, then the set pieces.
  const grids = [0, 1, 2].map((cy) => {
    const m = usableMask(frame, cy)
    const g = new Int16Array(W * D)
    for (let i = 0; i < g.length; i++) g[i] = m[i] ? FREE : BLOCK
    return g
  })
  const res = (g, r) => {
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) if (inside(x, z) && g[at(x, z)] !== BLOCK) g[at(x, z)] = RES
  }
  for (const s of frame.stairs) for (let cy = 0; cy <= s.top; cy++) res(grids[cy], s.core)
  const ring = hall ? hall.geometry.ring : null
  if (ring) for (const g of grids) res(g, ring)
  if (shell) res(grids[0], SHELL_ZONE)

  // Anchors per storey: cells the hallways must reach.
  const anchors = [[], [], []]
  const lanes = Object.values(frame.ports).map(portLane)
  for (const port of Object.values(frame.ports)) anchors[0].push({ c: at(port.gx, port.gz), why: `port ${port.side}`, port: true })
  for (const s of frame.stairs) for (let cy = 0; cy <= s.top; cy++) anchors[cy].push({ c: at(s.door.out.gx, s.door.out.gz), why: 'stair' })
  if (shell) anchors[0].push({ c: at(SHELL_BACK.gx, SHELL_BACK.gz), why: 'shell' })

  // The P.T. loop (ground storey).
  let loop = null
  if (hasLoop(frame.variant)) {
    loop = placeLoop(rnd, grids[0], lanes, anchors[0], loopSizesOf(depth, shell))
    if (loop) {
      for (const c of loop.cells) grids[0][c] = RES
      for (const c of loop.block) grids[0][c] = RES
      anchors[0].push({ c: at(loop.entry.out.gx, loop.entry.out.gz), why: 'loop entry' })
      anchors[0].push({ c: at(loop.exit.out.gx, loop.exit.out.gz), why: 'loop exit' })
    }
  }

  // The Great Hall's doors.
  const hallDoors = [[], [], []]
  if (hall) {
    for (let cy = 0; cy < 3; cy++) {
      const doors = hallDoorsOf(rnd, grids[cy], hall.geometry, cy)
      hallDoors[cy] = doors
      for (const d of doors) anchors[cy].push({ c: at(d.out.gx, d.out.gz), why: 'hall' })
    }
  }

  // Grown first floor first, so the copied room lands upstairs when it can
  // (the doc's "the new one is a copy of the bedroom").
  const storeys = []
  let copy = null
  for (const cy of [1, 0, 2]) {
    const wantCopy = anomaly?.cls === 'copy' && !copy
    // The shell's own living room, dining room and kitchen count in the
    // schema (tile.furnishShell: the front-door house).
    const sx = (SHELL_ZONE.x0 + SHELL_ZONE.x1) / 2
    const sz = (SHELL_ZONE.z0 + SHELL_ZONE.z1) / 2
    const taken = cy === 0 && shell ? ['living', 'dining', 'kitchen'].map((role) => ({ role, x: sx, z: sz })) : []
    storeys[cy] = growStorey(rnd, grids[cy], cy, anchors[cy], { depth, ring, wantCopy, loopCells: cy === 0 && loop ? loop.cells : null, taken })
    const pair = storeys[cy].rooms.findIndex((r) => r.copyOf !== undefined)
    if (wantCopy && pair >= 0) {
      const r = storeys[cy].rooms[pair]
      copy = { cy, room: pair, of: r.copyOf, dx: r.dx, dz: r.dz }
    }
  }

  // The red hallway (anomaly).
  const red = anomaly?.cls === 'red' ? longestRun(grids[0]) : null
  return Object.freeze({ seed, tx, tz, frame, hall, anomaly, depth, loop, hallDoors, storeys, copy, red, grids })
}

// --- set pieces ------------------------------------------------------------------------------

// The P.T. loop module at (x0, z0), ring size S (even): the NW L-hallway (a
// leg along x on row z0+1, a leg along z on column x0+1, the elbow lit), its
// clock alcove above the long leg at (x0+3, z0) and its closet left of the
// short leg at (x0, z0+4), mirrored across x line LX = x0+1+S/2 and z line
// LZ = z0+1+S/2 into four identical L's round a sealed block (tile.js
// buildLoopAt draws it). Entered from the north (row z0, column LX−1) or
// the west (column x0, row z0+2); left through the SE closet's back wall.
// The closet's row off the short leg: z0+4, or the leg's last cell on the
// smallest loop (S 6: the doc's 3 + 2 L, whose short leg ends at z0+3).
export const loopClosetRow = (L) => Math.min(L.z0 + 4, L.LZ - 1)

export function loopGeometry(x0, z0, S, entry) {
  const LX = x0 + 1 + S / 2
  const LZ = z0 + 1 + S / 2
  const mx = (x) => 2 * LX - 1 - x
  const mz = (z) => 2 * LZ - 1 - z
  const cells = new Set()
  const add = (x, z) => {
    for (const [a, b] of [[x, z], [mx(x), z], [x, mz(z)], [mx(x), mz(z)]]) cells.add(at(a, b))
  }
  const cz = loopClosetRow({ z0, LZ })
  for (let x = x0 + 1; x < LX; x++) add(x, z0 + 1)
  for (let z = z0 + 2; z < LZ; z++) add(x0 + 1, z)
  add(x0 + 3, z0) // the clock alcove
  add(x0, cz) // the closet
  const block = []
  for (let z = z0 + 2; z <= z0 + S - 1; z++) for (let x = x0 + 2; x <= x0 + S - 1; x++) block.push(at(x, z))
  const se = { gx: mx(x0), gz: mz(cz) } // the SE closet
  const exit = { axis: 'v', gx: se.gx + 1, gz: se.gz, out: { gx: se.gx + 1, gz: se.gz } }
  const en = entry === 'N'
    ? { axis: 'h', gx: LX - 1, gz: z0 + 1, out: { gx: LX - 1, gz: z0 } }
    : { axis: 'v', gx: x0 + 1, gz: z0 + 2, out: { gx: x0, gz: z0 + 2 } }
  return { x0, z0, S, LX, LZ, entry: en, exit, side: entry, cells: [...cells], block, box: { x0, z0, x1: x0 + S + 1, z1: z0 + S + 1 } }
}

// The loop's ring sizes by tile depth (the house grows): by the front door
// the doc's L of 3 + 2 cells round a 4×4 block (S 6), a size up from the
// middle depths, the big rings (a 10×10 block, 30 m of blank wall) only in
// the deep house.
export function loopSizesOf(depth, shell) {
  if (shell || depth <= 4) return [6]
  if (depth <= 8) return [6, 8]
  if (depth <= 12) return [6, 8, 10]
  return [8, 10, 12]
}

function placeLoop(rnd, g, lanes, anchors, sizes) {
  const anchorCells = new Set(anchors.map((a) => a.c))
  const ok = (c) => g[c] === FREE && !anchorCells.has(c)
  const inLane = (x, z) => lanes.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1)
  for (const S of rnd.shuffle([...sizes]).concat([6])) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const x0 = rnd.int(0, W - S - 3)
      const z0 = rnd.int(0, D - S - 3)
      // The smallest ring's north door would open on its clock alcove.
      const L = loopGeometry(x0, z0, S, S > 6 && rnd.chance(0.5) ? 'N' : 'W')
      const all = [...L.cells, ...L.block]
      if (!all.every(ok)) continue
      if (all.some((c) => inLane(c % W, Math.floor(c / W)))) continue
      const outs = [L.entry.out, L.exit.out]
      if (!outs.every((o) => inside(o.gx, o.gz) && ok(at(o.gx, o.gz)) && !inLane(o.gx, o.gz))) continue
      // The rest of the storey must stay one region round it: every anchor
      // and both loop doors in one flood of the free cells.
      const trial = g.slice()
      for (const c of all) trial[c] = RES
      const flood = floodFree(trial, anchors[0].c)
      if (!anchors.every((a) => flood.has(a.c)) || !outs.every((o) => flood.has(at(o.gx, o.gz)))) continue
      return L
    }
  }
  return null
}

function floodFree(g, start) {
  const seen = new Set([start])
  const q = [start]
  while (q.length) {
    const c = q.pop()
    const x = c % W
    const z = (c - x) / W
    for (const [dx, dz] of DIRS) {
      const nx = x + dx
      const nz = z + dz
      if (!inside(nx, nz)) continue
      const n = at(nx, nz)
      if (seen.has(n) || g[n] !== FREE) continue
      seen.add(n)
      q.push(n)
    }
  }
  return seen
}

// The hall ring's doors on storey cy: the edge between a ring cell and a
// usable free cell outside it. Ground: one or two (hashed sides); first
// storey: one (the landing); top: the Winchester door, one step from the
// rail (on the ring line the overlook meets), else any.
function hallDoorsOf(rnd, g, h, cy) {
  const r = h.ring
  const cands = []
  const push = (axis, gx, gz, out, side) => {
    if (!inside(out.gx, out.gz) || g[at(out.gx, out.gz)] !== FREE) return
    cands.push({ axis, gx, gz, out, side })
  }
  for (let z = r.z0; z <= r.z1; z++) {
    push('v', r.x0, z, { gx: r.x0 - 1, gz: z }, 'W')
    push('v', r.x1 + 1, z, { gx: r.x1 + 1, gz: z }, 'E')
  }
  for (let x = r.x0; x <= r.x1; x++) {
    push('h', x, r.z0, { gx: x, gz: r.z0 - 1 }, 'N')
    push('h', x, r.z1 + 1, { gx: x, gz: r.z1 + 1 }, 'S')
  }
  if (!cands.length) return []
  // The first door opens inside the ring's own chunk: the chunk's catalog
  // stamp joins the ring to its chunk's fabric (structures/catalog
  // ensureApproach), and a ring whose only door crosses the chunk line gets
  // an unplanned corridor carved through the mass there.
  const chunkNo = (x, z) => Math.floor(x / CHUNK) + 8 * Math.floor(z / CHUNK)
  const home = chunkNo(r.x0, r.z0)
  const local = cands.filter((c) => chunkNo(c.out.gx, c.out.gz) === home)
  const pool = local.length ? local : cands
  if (cy === 2) {
    const win = h.side === 'E'
      ? pool.filter((c) => c.axis === 'h' && c.gx === h.overlook)
      : pool.filter((c) => c.axis === 'v' && c.gz === h.overlook)
    return [win.length ? win[rnd.int(0, win.length - 1)] : pool[rnd.int(0, pool.length - 1)]]
  }
  const first = pool[rnd.int(0, pool.length - 1)]
  const out = [first]
  if (cy === 0 && rnd.chance(0.5)) {
    const other = cands.filter((c) => c.side !== first.side)
    if (other.length) out.push(other[rnd.int(0, other.length - 1)])
  }
  return out
}

// The centre of the largest square of free cells, if at least `min` wide,
// else -1 (the first in scan order on ties).
const SQ = new Int16Array(W * D)
function biggestFree(g, min) {
  let best = -1
  let bestN = min - 1
  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      const i = at(x, z)
      if (g[i] !== FREE) {
        SQ[i] = 0
        continue
      }
      const n = x && z ? 1 + Math.min(SQ[i - 1], SQ[i - W], SQ[i - W - 1]) : 1
      SQ[i] = n
      if (n > bestN) {
        bestN = n
        best = at(x - (n >> 1), z - (n >> 1))
      }
    }
  }
  return best
}

// --- one storey ------------------------------------------------------------------------------

// Hallways, rooms and closets on storey cy. Returns { cy, corridors (cell
// indexes), rooms [{ x0, z0, x1, z1, door, parent, nest, size, kind 'room' |
// 'closet', copyOf?, dx?, dz? }], links (second doors {axis, gx, gz}: room to
// room, or a room behind a room back to a hallway), lamps [{ gx, gz, lit }], ringDoors (doors
// a hallway cut through the Great Hall's ring), junctions, loops, deadEnds,
// unjoined (doors no hallway reached: the tile program refuses the plan) }.
function growStorey(rnd, g, cy, anchorsIn, { depth, ring, wantCopy = false, loopCells = null, taken = [] }) {
  const out = { cy, corridors: [], rooms: [], links: [], frontDoors: [], hallDoors: [], lamps: [], ringDoors: [], junctions: 0, loops: 0, deadEnds: 0, unjoined: 0 }
  HALLISH.fill(0)
  runCap = hallCapOf(depth) + 2
  if (loopCells) for (const c of loopCells) HALLISH[c] = 1
  if (ring) {
    for (let x = ring.x0; x <= ring.x1; x++) for (const z of [ring.z0, ring.z1]) if (inside(x, z)) HALLISH[at(x, z)] = 1
    for (let z = ring.z0; z <= ring.z1; z++) for (const x of [ring.x0, ring.x1]) if (inside(x, z)) HALLISH[at(x, z)] = 1
  }
  const anchors = anchorsIn.filter((a) => g[a.c] === FREE || g[a.c] === CORR)
  out.unjoined = anchorsIn.length - anchors.length
  if (!anchors.length) return out
  // A noise field: the hallways wander differently in every tile.
  const noise = new Float32Array(W * D)
  for (let i = 0; i < noise.length; i++) noise[i] = rnd.next() * 0.8
  const isAnchor = new Uint8Array(W * D)
  for (const a of anchors) isAnchor[a.c] = 1
  const mark = (cells) => {
    for (const c of cells) if (g[c] === FREE) g[c] = CORR
  }
  const inRing = (c) => {
    if (!ring) return false
    const x = c % W
    const z = (c - x) / W
    return x >= ring.x0 && x <= ring.x1 && z >= ring.z0 && z <= ring.z1
  }

  // Junctions: one hashed cell in every chunk the storey keeps that holds
  // no door (so the hallways reach every wing), then 0..2 more.
  const spots = anchors.map((a) => a.c)
  const junctions = []
  const farFrom = (c, d) => {
    const x = c % W
    const z = (c - x) / W
    return spots.every((o) => Math.max(Math.abs((o % W) - x), Math.abs(Math.floor(o / W) - z)) >= d)
  }
  const byChunk = Array.from({ length: 6 }, () => [])
  for (let i = 0; i < g.length; i++) {
    if (g[i] !== FREE) continue
    const x = i % W
    const z = (i - x) / W
    byChunk[Math.floor(x / 14) + 3 * Math.floor(z / 14)].push(i)
  }
  // A chunk with a door of its own already draws its hallways; the others
  // take a junction (fewer, longer halls: a house, not a corridor grid).
  const chunkOfCell = (c) => Math.floor((c % W) / 14) + 3 * Math.floor(Math.floor(c / W) / 14)
  const anchored = new Set(anchors.map((a) => chunkOfCell(a.c)))
  const extraJ = rnd.int(0, 1) + (depth >= 6 ? 1 : 0)
  const pools = [...byChunk.filter((l, i) => l.length > 20 && !anchored.has(i)), ...Array.from({ length: extraJ }, () => byChunk.flat())]
  for (const pool of pools) {
    for (let t = 0; t < 24 && pool.length; t++) {
      const c = pool[rnd.int(0, pool.length - 1)]
      if (farFrom(c, 5)) {
        junctions.push(c)
        spots.push(c)
        break
      }
    }
  }

  // The spanning tree: the first anchor seeds the network; every other door
  // (first) and junction joins it by the cheapest hallway.
  mark([anchors[0].c])
  const order = rnd.shuffle([...anchors.slice(1).map((a) => ({ c: a.c, must: true })), ...junctions.map((c) => ({ c, must: false }))])
  order.sort((a, b) => Number(b.must) - Number(a.must))
  for (const o of order) {
    if (g[o.c] === CORR) continue
    let path = route(g, noise, o.c)
    if (!path && o.must && ring) {
      // Through the Great Hall: its ring is walkable floor; the hallway
      // enters and leaves it by two more doors.
      path = route(g, noise, o.c, { ring })
      if (path) {
        for (let i = 1; i < path.length; i++) {
          const a = path[i - 1]
          const b = path[i]
          if (inRing(a) === inRing(b)) continue
          const o2 = inRing(a) ? b : a
          const r2 = inRing(a) ? a : b
          const ox = o2 % W
          const oz = (o2 - ox) / W
          const rx = r2 % W
          const rz = (r2 - rx) / W
          out.ringDoors.push(ox !== rx
            ? { axis: 'v', gx: Math.max(ox, rx), gz: oz, out: { gx: ox, gz: oz } }
            : { axis: 'h', gx: ox, gz: Math.max(oz, rz), out: { gx: ox, gz: oz } })
        }
        mark(path.filter((c) => !inRing(c)))
        continue
      }
    }
    if (!path) {
      if (o.must) out.unjoined++
      continue
    }
    mark(path)
    if (!o.must) out.junctions++
  }

  // Extra hallways that close loops (doc §12: ≥ 2 loops per 10 nodes): from
  // a dead end (or any hallway cell) to a hallway cell ≥ 10 steps away along
  // the network, over free cells only.
  const extra = rnd.int(0, 2) + (depth >= 6 ? 1 : 0)
  const netDist = new Float32Array(W * D)
  for (let e = 0; e < extra; e++) {
    const corr = []
    for (let i = 0; i < g.length; i++) if (g[i] === CORR) corr.push(i)
    if (corr.length < 12) break
    const leaves = corr.filter((c) => !isAnchor[c] && corrDegree(g, c) === 1)
    const pool = leaves.length ? leaves : corr
    const src = pool[rnd.int(0, pool.length - 1)]
    corrDistances(g, src, netDist)
    const path = route(g, noise, src, { netDist, minNet: 10 })
    if (path) {
      mark(path)
      out.loops++
    }
  }

  // Rooms: every storey is a run of HOUSES (doc §1: "a domestic interior —
  // hall, kitchen, living room, bedrooms, bathroom, stairs"; §4.3: rooms of
  // 1×1 to 2×2 cells and up). The hallways above are the house's own halls
  // and the passages between houses; the rooms are packed wall to wall:
  //   a. the copied room (anomaly), if the tile asks;
  //   b. WINGS: a house hung off a hallway cell — a straight 1-wide hall
  //      (the spine) with a band of rooms on each side (living, dining,
  //      kitchen on the public side; bedrooms and the bathroom on the
  //      private side; upstairs bedrooms both sides), often closed by a room
  //      across its far end; the next wing may start from its spine's end,
  //      so the hall runs on into another house;
  //   c. BANDS along the remaining straight hallway runs, flush rooms from a
  //      domestic programme;
  //   d. rooms behind rooms (en-suite bath, walk-in closet, pantry, den),
  //      deeper with tile depth ("the house grows");
  //   e. growth into the free cells beside a room (domestic caps), closets in
  //      pockets, a clock alcove or two; whatever is left is mass;
  //   f. second doors: the house's own enfilades (living–dining,
  //      dining–kitchen, bedroom–bath), then a depth-scaled share more.
  const rooms = out.rooms
  const place = (r) => {
    const id = rooms.length
    rooms.push(r)
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) g[at(x, z)] = ROOM0 + id
    return id
  }
  const fits = (x0, z0, x1, z1) => {
    if (x0 < 0 || z0 < 0 || x1 >= W || z1 >= D) return false
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (g[at(x, z)] !== FREE) return false
    return true
  }
  const corrCells = () => {
    const list = []
    for (let i = 0; i < g.length; i++) if (g[i] === CORR) list.push(i)
    return list
  }
  // The house's schema (doc §4.4: a kitchen beside its dining room, one of
  // each to a house, "respected at low depth and broken at high depth"): a
  // public room (living, dining, kitchen; the den, study, laundry and
  // nursery at a shorter reach) takes another role while one of its own
  // stands within the schema's reach; deep in, rooms repeat.
  const reach = spreadOf(depth)
  const domestic = (r, role) => {
    const w = Math.min(r.x1 - r.x0 + 1, r.z1 - r.z0 + 1)
    const cx = (r.x0 + r.x1) / 2
    const cz = (r.z0 + r.z1) / 2
    const near = (q) => {
      const k = SPREAD[q]
      if (!k || !reach) return false
      const R = reach * k
      return taken.some((t) => t.role === q && Math.abs(t.x - cx) < R && Math.abs(t.z - cz) < R)
    }
    if (!near(role)) return role
    for (const q of SUBS[role]) if ((w >= 2 || WET.has(q)) && !near(q)) return q
    return w >= 2 ? 'bed' : 'bath'
  }
  const room = (r, door, roleIn, parent = -1, nest = 0) => {
    const role = roleIn === 'closet' || roleIn === 'bed' || roleIn === 'bath' ? roleIn : domestic(r, roleIn)
    const kind = role === 'closet' ? 'closet' : 'room'
    taken.push({ role, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 })
    return place({ ...r, door, parent, nest, kind, role, size: (r.x1 - r.x0 + 1) * (r.z1 - r.z0 + 1) })
  }
  const upper = cy > 0

  // a. The copied room: a room and its twin side by side on one straight run
  // of hallway, the twin's door the same step further on.
  if (wantCopy) {
    let done = false
    for (const c of rnd.shuffle(corrCells())) {
      for (const h of rnd.shuffle([0, 1, 2, 3])) {
        for (const [along, deep] of rnd.shuffle([[3, 2], [2, 3], [2, 2]])) {
          const [sx, sz] = DIRS[h][0] ? [0, along] : [along, 0]
          const cx = c % W
          const cz = (c - cx) / W
          if (!inside(cx + sx, cz + sz) || g[at(cx + sx, cz + sz)] !== CORR) continue
          const a = rectFrom(c, h, along, deep, 0)
          const b = rectFrom(at(cx + sx, cz + sz), h, along, deep, 0)
          if (!fits(a.r.x0, a.r.z0, a.r.x1, a.r.z1) || !fits(b.r.x0, b.r.z0, b.r.x1, b.r.z1)) continue
          const ia = room(a.r, a.door, 'bed')
          rooms[room(b.r, b.door, 'bed')].copyOf = ia
          Object.assign(rooms[rooms.length - 1], { dx: sx, dz: sz })
          done = true
          break
        }
        if (done) break
      }
      if (done) break
    }
  }

  // b. Wings. A wing at hallway cell c heading h: spine cells k = 1..L on
  // the line t = 0, bands t = −a..−1 and 1..b, an end room k = L+1..L+e
  // across the whole width. All of it must be free.
  const wingsFrom = (cells, cap) => {
    let wings = 0
    const cands = []
    for (const c of cells) for (let h = 0; h < 4; h++) cands.push(c * 4 + h)
    for (const v of rnd.shuffle(cands)) {
      if (wings >= cap) break
      const c = v >> 2
      if (g[c] !== CORR) continue
      if (tryWing(c, v & 3)) wings++
    }
  }
  wingsFrom(corrCells(), upper ? 5 : 7)
  function tryWing(c, h) {
    const cx = c % W
    const cz = (c - cx) / W
    const [dx, dz] = DIRS[h]
    const [px, pz] = dx ? [0, 1] : [1, 0]
    const cell = (k, t) => [cx + dx * k + px * t, cz + dz * k + pz * t]
    const rect = (k0, k1, t0, t1) => {
      const [ax, az] = cell(k0, t0)
      const [bx, bz] = cell(k1, t1)
      return { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) }
    }
    const free = (r) => fits(r.x0, r.z0, r.x1, r.z1)
    // A house's hall branches off the passage (or turns off another hall's
    // end); it never runs straight on out of a hallway (that made one hall
    // of every wing in a row: a corridor across the tile).
    if (inside(cx - dx, cz - dz) && g[at(cx - dx, cz - dz)] === CORR) return false
    // The public side (ground storey) is a = 2..3 deep; the private side 2..3.
    const flip = rnd.chance(0.5)
    const a = rnd.chance(0.3) ? 3 : 2
    const b = rnd.chance(0.3) ? 3 : 2
    // The hall: 1×4 to 1×6 by the front door, longer deeper in.
    const Lmax = rnd.int(4, 6 + Math.min(5, Math.floor(depth / 3)))
    for (let L = Lmax; L >= 4; L--) {
      if (!free(rect(1, L, -a, b))) continue
      const e = 2
      const end = rnd.chance(upper ? 0.65 : 0.55) && free(rect(L + 1, L + e, -a, b))
      for (let k = 1; k <= L; k++) g[at(...cell(k, 0))] = CORR
      const progA = upper ? rnd.pick(UPPER_PROGRAMMES) : rnd.pick(PUBLIC_PROGRAMMES)
      const progB = upper ? rnd.pick(UPPER_PROGRAMMES) : rnd.pick(PRIVATE_PROGRAMMES)
      const [sa, sb] = flip ? [1, -1] : [-1, 1]
      band(cell, rect, L, sa, flip ? b : a, progA, dx !== 0)
      band(cell, rect, L, sb, flip ? a : b, progB, dx !== 0)
      // The front door: the house's own door off the passage.
      out.frontDoors.push(edgeBetween(cx, cz, ...cell(1, 0)))
      if (end) {
        // Across the hall's end: the width (a + 1 + b = 5..7 cells) split in
        // rooms of 2..3 cells: the one holding the spine's line opens off
        // it, the others open into their neighbour toward it (a bedroom and
        // its en-suite, a living room and the den off it).
        const [main, side] = rnd.pick(upper ? UPPER_END : GROUND_END)
        const [sx, sz] = cell(L, 0)
        const [ex, ez] = cell(L + 1, 0)
        const segs = rnd.pick(SPLITS[a + 1 + b])
        const cuts = []
        let t0 = -a
        for (const n of segs) {
          cuts.push([t0, t0 + n - 1])
          t0 += n
        }
        const mainAt = cuts.findIndex(([p, q]) => p <= 0 && q >= 0)
        const ids = []
        ids[mainAt] = room(rect(L + 1, L + e, ...cuts[mainAt]), edgeBetween(sx, sz, ex, ez), main)
        for (const dir of [-1, 1]) {
          for (let k = mainAt + dir; k >= 0 && k < cuts.length; k += dir) {
            const near = cuts[k - dir]
            const kq = L + 1 + rnd.int(0, e - 1)
            const [qx, qz] = cell(kq, dir > 0 ? near[1] : near[0])
            const [ox, oz] = cell(kq, dir > 0 ? cuts[k][0] : cuts[k][1])
            const role = k === mainAt + dir ? side : rnd.pick(SHORT_ROLES)
            ids[k] = room(rect(L + 1, L + e, ...cuts[k]), edgeBetween(ox, oz, qx, qz), role, ids[k - dir], Math.abs(k - mainAt))
          }
        }
      }
      return true
    }
    return false
  }
  // One band of a wing: rooms along k = 1..L on side `s` (±1), `depth`
  // cells deep, widths from the programme's roles; each room's door on the
  // spine (a kitchen after a dining room may open off it instead).
  function band(cell, rect, L, s, depth, prog, kx) {
    let k = 1
    let pi = 0
    let prev = -1
    while (k <= L) {
      let role = prog[pi % prog.length]
      const spec = ROLE_SPEC[role]
      const rem = L - k + 1
      let w = Math.min(rem, rnd.int(spec.w[0], spec.w[1]))
      if (w < spec.w[0]) {
        // Too short for the next room: the room before takes the rest when
        // it stays domestic, else a bathroom or a linen closet.
        const p = prev >= 0 ? rooms[prev] : null
        const pw = p ? (kx ? p.x1 - p.x0 + 1 : p.z1 - p.z0 + 1) : 0
        if (p && p.kind === 'room' && pw + rem <= ROLE_SPEC[p.role].grow[0] && ROLE_SPEC[p.role].w[1] >= 2) {
          const r = rect(k, L, s > 0 ? 1 : -(kx ? p.z1 - p.z0 + 1 : p.x1 - p.x0 + 1), s > 0 ? (kx ? p.z1 - p.z0 + 1 : p.x1 - p.x0 + 1) : -1)
          for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) g[at(x, z)] = ROOM0 + prev
          p.x0 = Math.min(p.x0, r.x0)
          p.z0 = Math.min(p.z0, r.z0)
          p.x1 = Math.max(p.x1, r.x1)
          p.z1 = Math.max(p.z1, r.z1)
          p.size = (p.x1 - p.x0 + 1) * (p.z1 - p.z0 + 1)
          break
        }
        role = rem === 1 ? rnd.pick(ONE_ROLES) : rnd.pick(SHORT_ROLES)
        w = Math.min(rem, ROLE_SPEC[role].w[1])
      }
      // A single cell left over joins this room when it can.
      if (rem - w === 1 && w + 1 <= Math.max(2, ROLE_SPEC[role].w[1] + 1) && w + 1 <= MAX_SIDE) w++
      const d = Math.min(depth, ROLE_SPEC[role].d)
      const r = rect(k, k + w - 1, s > 0 ? 1 : -d, s > 0 ? d : -1)
      const kd = k + rnd.int(0, w - 1)
      const [ax, az] = cell(kd, s)
      const [bx, bz] = cell(kd, 0)
      let id
      if (role === 'kitchen' && prev >= 0 && rooms[prev].role === 'dining' && rnd.chance(0.5)) {
        // The kitchen through the dining room.
        const [qx, qz] = cell(k, s)
        const [ox, oz] = cell(k - 1, s)
        id = room(r, edgeBetween(qx, qz, ox, oz), role, prev, 1)
      } else id = room(r, edgeBetween(ax, az, bx, bz), role)
      prev = id
      k += w
      pi++
    }
  }

  // c. Bands along the remaining straight hallway runs (the halls between
  // houses): flush rooms from a programme, each with its door on the run.
  const bands = () => {
    const runs = []
    for (const horiz of [true, false]) {
      const [n, m] = horiz ? [D, W] : [W, D]
      for (let a2 = 0; a2 < n; a2++) {
        let s0 = -1
        for (let b2 = 0; b2 <= m; b2++) {
          const c = horiz ? at(b2, a2) : at(a2, b2)
          if (b2 < m && g[c] === CORR) {
            if (s0 < 0) s0 = b2
          } else {
            if (s0 >= 0 && b2 - s0 >= 2) runs.push({ horiz, line: a2, from: s0, to: b2 - 1 })
            s0 = -1
          }
        }
      }
    }
    rnd.shuffle(runs).sort((p, q) => q.to - q.from - (p.to - p.from))
    for (const run of runs) {
      for (const s of rnd.shuffle([-1, 1])) {
        if (rnd.next() < BLANK[cy]) continue
        const prog = upper ? rnd.pick(UPPER_PROGRAMMES) : rnd.pick(HALL_PROGRAMMES)
        const depth = rnd.int(2, 3)
        const cellAt = (u, t) => (run.horiz ? [u, run.line + t] : [run.line + t, u])
        let u = run.from
        let pi = 0
        while (u <= run.to) {
          const role = prog[pi % prog.length]
          const spec = ROLE_SPEC[role]
          const maxW = Math.min(run.to - u + 1, rnd.int(spec.w[0], spec.w[1]))
          let placed = false
          // No room starts here unless the cell beside the run is free.
          const [fx, fz] = cellAt(u, s)
          if (!inside(fx, fz) || g[at(fx, fz)] !== FREE) {
            u++
            continue
          }
          for (let w = maxW; w >= spec.w[0] && !placed; w--) {
            for (let d = Math.min(depth, spec.d); d >= Math.min(2, spec.d) && !placed; d--) {
              const [ax, az] = cellAt(u, s > 0 ? 1 : -d)
              const [bx, bz] = cellAt(u + w - 1, s > 0 ? d : -1)
              const r = { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) }
              if (!fits(r.x0, r.z0, r.x1, r.z1)) continue
              const ud = u + rnd.int(0, w - 1)
              const [qx, qz] = cellAt(ud, s)
              const [ox, oz] = cellAt(ud, 0)
              room(r, edgeBetween(qx, qz, ox, oz), role)
              u += w
              placed = true
            }
          }
          if (placed) pi++
          else u++
        }
      }
    }
  }
  bands()

  // The house reaches its own corners: while a free square of FILL_MIN cells
  // a side or more is left (a blank the hallways never reached), a hallway is routed
  // from its centre to the network and houses are hung off it.
  for (let pass = 0; pass < FILL_PASSES; pass++) {
    const c = biggestFree(g, FILL_MIN)
    if (c < 0) break
    const before = new Set(corrCells())
    const path = route(g, noise, c)
    if (!path) {
      g[c] = BLOCK_TRIED
      continue
    }
    mark(path)
    wingsFrom(path.filter((p) => !before.has(p)), 3)
    bands()
  }
  for (let i = 0; i < g.length; i++) if (g[i] === BLOCK_TRIED) g[i] = FREE

  // d. Rooms behind rooms: an en-suite or a walk-in closet behind a
  // bedroom, a pantry or laundry behind a kitchen, a den behind the living
  // room; deeper tiles nest deeper (doc §4.1, "the house grows").
  const maxNest = 1 + (depth >= 3 ? 1 : 0) + (depth >= 7 ? 1 : 0)
  const backChance = 0.15 + 0.03 * Math.min(depth, 8)
  for (let level = 1; level <= maxNest; level++) {
    const parents = []
    rooms.forEach((r, i) => {
      if (r.kind === 'room' && r.nest === level - 1 && r.copyOf === undefined && CHILD_ROLES[r.role]) parents.push(i)
    })
    for (const pi of rnd.shuffle(parents)) {
      if (rnd.next() >= backChance) continue
      const role = rnd.pick(CHILD_ROLES[rooms[pi].role])
      const spec = ROLE_SPEC[role]
      let done = false
      for (const e of rnd.shuffle(perimeter(rooms[pi]))) {
        if (g[e.n] !== FREE) continue
        for (let along = spec.w[1]; along >= spec.w[0] && !done; along--) {
          for (let deep = spec.d; deep >= 1 && !done; deep--) {
            if (role !== 'closet' && deep < 2) continue
            for (let o = 0; o < along && !done; o++) {
              const { r, door } = rectFrom(e.c, e.h, along, deep, o)
              if (!fits(r.x0, r.z0, r.x1, r.z1)) continue
              room(r, door, role, pi, level)
              done = true
            }
          }
        }
        if (done) break
      }
    }
  }

  // e. Rooms grow into the free strips beside them (a whole side at a
  // time, within domestic sizes), closets in pockets off a hallway or a
  // room; the rest of the pockets is the house's hidden mass.
  for (const r of [...rooms, ...rooms]) {
    if (r.kind !== 'room' || r.copyOf !== undefined || rooms.some((q) => q.copyOf !== undefined && rooms[q.copyOf] === r)) continue
    const cap = ROLE_SPEC[r.role].grow
    for (const side of rnd.shuffle([0, 1, 2, 3])) {
      if (rnd.next() < 0.2) continue
      const w = r.x1 - r.x0 + 1
      const d = r.z1 - r.z0 + 1
      const growX = side === 0 || side === 2
      const nw = growX ? w + 1 : w
      const nd = growX ? d : d + 1
      if (Math.max(nw, nd) > cap[0] || Math.min(nw, nd) > cap[1] || nw * nd > cap[0] * cap[1]) continue
      const strip = side === 0 ? [r.x1 + 1, r.z0, r.x1 + 1, r.z1] : side === 2 ? [r.x0 - 1, r.z0, r.x0 - 1, r.z1]
        : side === 1 ? [r.x0, r.z1 + 1, r.x1, r.z1 + 1] : [r.x0, r.z0 - 1, r.x1, r.z0 - 1]
      if (!fits(...strip)) continue
      const id = g[at(r.x0, r.z0)]
      for (let z = strip[1]; z <= strip[3]; z++) for (let x = strip[0]; x <= strip[2]; x++) g[at(x, z)] = id
      if (side === 0) r.x1++
      else if (side === 2) r.x0--
      else if (side === 1) r.z1++
      else r.z0--
      r.size = (r.x1 - r.x0 + 1) * (r.z1 - r.z0 + 1)
    }
  }
  let closets = Math.min(3, Math.floor(depth / 3))
  for (let c = 0; c < g.length && closets > 0; c++) {
    if (g[c] !== FREE) continue
    const x = c % W
    const z = (c - x) / W
    for (const h of [0, 1, 2, 3]) {
      const hx = x - DIRS[h][0]
      const hz = z - DIRS[h][1]
      if (!inside(hx, hz)) continue
      const host = g[at(hx, hz)]
      if (host !== CORR && !(host >= ROOM0 && rooms[host - ROOM0].kind === 'room' && !WET.has(rooms[host - ROOM0].role) && rooms[host - ROOM0].copyOf === undefined)) continue
      let { r, door } = rectFrom(at(hx, hz), h, 2, 1, 0)
      if (!fits(r.x0, r.z0, r.x1, r.z1)) ({ r, door } = rectFrom(at(hx, hz), h, 1, 1, 0))
      if (!fits(r.x0, r.z0, r.x1, r.z1)) continue
      room(r, door, 'closet', host === CORR ? -1 : host - ROOM0, 9)
      closets--
      break
    }
  }
  // Clock alcoves: a free cell off a straight hallway run, between walls
  // (the hall clock stands in it, as in the P.T. loop).
  let alcoves = rnd.int(1, 2)
  for (const c of rnd.shuffle(corrCells())) {
    if (alcoves <= 0) break
    const x = c % W
    const z = (c - x) / W
    const straightX = inside(x - 1, z) && inside(x + 1, z) && g[at(x - 1, z)] === CORR && g[at(x + 1, z)] === CORR
    const straightZ = inside(x, z - 1) && inside(x, z + 1) && g[at(x, z - 1)] === CORR && g[at(x, z + 1)] === CORR
    if (!straightX && !straightZ) continue
    for (const h of rnd.shuffle(straightX ? [1, 3] : [0, 2])) {
      const nx = x + DIRS[h][0]
      const nz = z + DIRS[h][1]
      if (!inside(nx, nz) || g[at(nx, nz)] !== FREE) continue
      g[at(nx, nz)] = CORR
      alcoves--
      break
    }
  }

  // f. Second doors (doc §12 loops: "a graph, not a tree"). First the
  // house's own: living room to dining room, dining room to kitchen,
  // kitchen to laundry, the den off the living room; then a depth-scaled
  // share of the rest gains a door into a neighbouring room or, for a room
  // behind a room, back onto a hallway. Each opens onto a space the room is
  // not yet joined to, so every one closes a room-level cycle. The copied
  // pair, the closets and the wet rooms (a 2×2 bathroom with a second door
  // has no wall left for its basin) keep their single doors.
  const twinOf = new Set()
  for (const r of rooms) if (r.copyOf !== undefined) twinOf.add(r.copyOf)
  // A bathroom or a laundry keeps its one door (a 2×2 wet room with a
  // second door has no wall left for its basin).
  const linkable = (i) => rooms[i].kind === 'room' && !WET.has(rooms[i].role) && rooms[i].copyOf === undefined && !twinOf.has(i)
  const joined = rooms.map((r) => new Set([r.parent >= 0 ? ROOM0 + r.parent : CORR]))
  rooms.forEach((r, i) => {
    if (r.parent >= 0) joined[r.parent].add(ROOM0 + i)
  })
  const linkTo = (i, want) => {
    const opts = perimeter(rooms[i]).filter((e) => {
      const code = g[e.n]
      if (code !== CORR && !(code >= ROOM0 && linkable(code - ROOM0))) return false
      if (joined[i].has(code)) return false
      return want(code)
    })
    if (!opts.length) return false
    const e = opts[rnd.int(0, opts.length - 1)]
    const code = g[e.n]
    out.links.push(rectFrom(e.c, e.h, 1, 1, 0).door)
    joined[i].add(code)
    if (code >= ROOM0) joined[code - ROOM0].add(ROOM0 + i)
    return true
  }
  for (const i of rnd.shuffle(rooms.map((_, i) => i))) {
    if (!linkable(i)) continue
    const pairs = AFFINITY[rooms[i].role]
    if (!pairs) continue
    for (const [role, p] of pairs) {
      if (rnd.next() >= p) continue
      linkTo(i, (code) => code >= ROOM0 && rooms[code - ROOM0].role === role)
    }
  }
  const linkShare = Math.min(LINK_MAX, LINK_BASE + LINK_DEPTH * depth)
  for (const i of rnd.shuffle(rooms.map((_, i) => i))) {
    if (!linkable(i) || rnd.next() >= linkShare) continue
    linkTo(i, () => true)
  }

  // Hall doors (doc §4.3: a hallway is 1×2 to 1×4 cells, "the stretchable
  // element"; §4.4: the stretch grows with depth): a straight run of hallway
  // longer than hallCapOf(depth) is cut by doors into halls of at most that
  // length, so the passages between houses read as one house's hall opening
  // on the next, not as a hotel corridor. A door hangs where a wall meets it
  // (a party wall between two rooms, a room's wall against the mass): never
  // on a chunk line, a tile edge, or beside a set piece.
  hallDoors(g, out, rooms, hallCapOf(depth))

  // Hallway lamps: no two within 4 cells (Chebyshev; the rooms' own lamps
  // come first in a chunk's light budget, and the fill light covers the
  // hallways' dark stretches), none dead by the front door, a few deeper in.
  const lamped = new Uint8Array(W * D)
  const deadShare = depth <= 1 ? 0 : 0.15
  for (const c of corrCells()) {
    const x = c % W
    const z = (c - x) / W
    let near = false
    for (let dz = -4; dz <= 4 && !near; dz++) for (let dx = -4; dx <= 4 && !near; dx++) near = inside(x + dx, z + dz) && lamped[at(x + dx, z + dz)] === 1
    if (near) continue
    lamped[c] = 1
    out.lamps.push({ gx: x, gz: z, lit: rnd.next() >= deadShare })
  }
  out.corridors = corrCells()
  out.deadEnds = out.corridors.filter((c) => corrDegree(g, c) === 1 && !isAnchor[c]).length
  return out
}

// The longest straight run of hallway between doors, by tile depth: the
// doc's 1×4 hall by the front door, longer deeper in, the hallway that should
// not exist (13+).
export const hallCapOf = (depth) => (depth <= 3 ? 4 : depth <= 6 ? 5 : depth <= 9 ? 6 : depth <= 12 ? 8 : 14)

function hallDoors(g, out, rooms, cap) {
  // Door edges: V edge (gx, gz) at gz·(W+1)+gx, H edge (gx, gz) at
  // DV + gz·W + gx.
  const DV = (W + 1) * D
  const doorAt = new Uint8Array(DV + W * (D + 1))
  const key = (d) => (d.axis === 'v' ? d.gz * (W + 1) + d.gx : DV + d.gz * W + d.gx)
  const doors = { has: (k) => doorAt[k] === 1, add: (k) => (doorAt[k] = 1) }
  for (const r of rooms) doors.add(key(r.door))
  for (const d of out.links) doors.add(key(d))
  for (const d of out.frontDoors) doors.add(key(d))
  for (const d of out.ringDoors) doors.add(key(d))
  const code = (x, z) => (inside(x, z) ? g[at(x, z)] : BLOCK)
  // Whether the edge between cells a and b (codes) on edge `k` is a wall
  // the compiled plan keeps: a room's side against anything else (not a set
  // piece, whose stamps redraw their own walls), and no door.
  const wall = (a, b, k) => a !== b && (a >= ROOM0 || b >= ROOM0) && a !== RES && b !== RES && !doors.has(k)
  // Horizontal runs (V edges across them), then vertical runs (H edges).
  for (const horiz of [true, false]) {
    const [n, m] = horiz ? [D, W] : [W, D]
    const cellAt = (u, line) => (horiz ? [u, line] : [line, u])
    const edgeKey = (u, line) => (horiz ? line * (W + 1) + u : DV + u * W + line)
    // The edge between cells u-1 and u of line `line`: 2 walls beside it, 1, or 0.
    const score = (u, line) => {
      if (u % 14 === 0) return 0
      let k = 0
      const l = line % 14
      for (const t of [-1, 1]) {
        if ((t < 0 && l === 0) || (t > 0 && l === 13)) continue
        const [ax, az] = cellAt(u - 1, line + t)
        const [bx, bz] = cellAt(u, line + t)
        if (wall(code(ax, az), code(bx, bz), edgeKey(u, line + t))) k++
      }
      return k
    }
    for (let line = 0; line < n; line++) {
      let s0 = -1
      for (let u = 0; u <= m; u++) {
        const [x, z] = cellAt(u, line)
        const corr = u < m && g[at(x, z)] === CORR
        // A door already across the run ends it.
        const broken = corr && s0 >= 0 && doors.has(edgeKey(u, line))
        if (corr && !broken) {
          if (s0 < 0) s0 = u
          continue
        }
        if (s0 >= 0) cutRun(s0, u - 1, line)
        s0 = corr ? u : -1
      }
    }
    function cutRun(a, b, line) {
      let p = a
      while (b - p + 1 > cap) {
        let best = -1
        for (const want of [2, 1]) {
          for (let u = p + cap; u >= p + 2 && best < 0; u--) if (score(u, line) >= want) best = u
          if (best >= 0) break
        }
        if (best < 0) for (let u = p + cap + 1; u <= b - 1 && best < 0; u++) if (score(u, line) >= 1) best = u
        if (best < 0) return
        const [ax, az] = cellAt(best - 1, line)
        const [bx, bz] = cellAt(best, line)
        const d = edgeBetween(ax, az, bx, bz)
        out.hallDoors.push(d)
        doors.add(key(d))
        p = best
      }
    }
  }
}

// A rect of `along` × `deep` cells beyond cell n (reached from hallway or
// room cell c heading h), n at offset `off` along its near side; the door is
// the edge c|n.
// The door edge between two edge-adjacent cells.
function edgeBetween(ax, az, bx, bz) {
  return ax !== bx ? { axis: 'v', gx: Math.max(ax, bx), gz: az } : { axis: 'h', gx: ax, gz: Math.max(az, bz) }
}

function rectFrom(c, h, along, deep, off) {
  const cx = c % W
  const cz = (c - cx) / W
  const [dx, dz] = DIRS[h]
  const nx = cx + dx
  const nz = cz + dz
  let r
  if (dx) {
    const x0 = dx > 0 ? nx : nx - deep + 1
    r = { x0, z0: nz - off, x1: x0 + deep - 1, z1: nz - off + along - 1 }
  } else {
    const z0 = dz > 0 ? nz : nz - deep + 1
    r = { x0: nx - off, z0, x1: nx - off + along - 1, z1: z0 + deep - 1 }
  }
  const door = dx ? { axis: 'v', gx: Math.max(cx, nx), gz: cz } : { axis: 'h', gx: cx, gz: Math.max(cz, nz) }
  return { r, door }
}

// The cells outside room r's perimeter: { c (inside cell), h (heading out), n (outside cell) }.
function perimeter(r) {
  const out = []
  for (let z = r.z0; z <= r.z1; z++) {
    if (inside(r.x0 - 1, z)) out.push({ c: at(r.x0, z), h: 2, n: at(r.x0 - 1, z) })
    if (inside(r.x1 + 1, z)) out.push({ c: at(r.x1, z), h: 0, n: at(r.x1 + 1, z) })
  }
  for (let x = r.x0; x <= r.x1; x++) {
    if (inside(x, r.z0 - 1)) out.push({ c: at(x, r.z0), h: 3, n: at(x, r.z0 - 1) })
    if (inside(x, r.z1 + 1)) out.push({ c: at(x, r.z1), h: 1, n: at(x, r.z1 + 1) })
  }
  return out
}

function corrDegree(g, c) {
  const x = c % W
  const z = (c - x) / W
  let k = 0
  for (const [dx, dz] of DIRS) if (inside(x + dx, z + dz) && g[at(x + dx, z + dz)] === CORR) k++
  return k
}

// Steps along the hallway network from `src` into `dist` (Infinity off it).
function corrDistances(g, src, dist) {
  dist.fill(Infinity)
  dist[src] = 0
  const q = [src]
  for (let i = 0; i < q.length; i++) {
    const c = q[i]
    const x = c % W
    const z = (c - x) / W
    for (const [dx, dz] of DIRS) {
      if (!inside(x + dx, z + dz)) continue
      const n = at(x + dx, z + dz)
      if (g[n] !== CORR || dist[n] !== Infinity) continue
      dist[n] = dist[c] + 1
      q.push(n)
    }
  }
}

// The ground storey's longest straight hallway run (≥ 3 cells): [{gx, gz}].
function longestRun(g) {
  let best = []
  for (const horiz of [true, false]) {
    const [n, m] = horiz ? [D, W] : [W, D]
    for (let a = 0; a < n; a++) {
      let run = []
      for (let b = 0; b <= m; b++) {
        const x = horiz ? b : a
        const z = horiz ? a : b
        if (b < m && g[at(x, z)] === CORR) run.push({ gx: x, gz: z })
        else {
          if (run.length > best.length) best = run
          run = []
        }
      }
    }
  }
  return best.length >= 3 ? best : null
}
