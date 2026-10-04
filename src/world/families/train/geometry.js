import { CHUNK } from '../../constants.js'
import { MAP_FAMILY_TRAIN } from '../ids.js'
import { FAMILY_SALT, hashChain, tileKeyAt, tileKeyOf } from '../../tiles/tileKey.js'

// The train family's pure geometry (spec §3.3, §12.10, Option A, rebuilt as
// a grammar): the tile frame, footprint and ports, the station rule, and the
// tile SKELETON — the car sequence and the train's path, the station's
// platforms, stair cores, concourse and exit closet, the service stair cores
// — plus the anomalies, plates and the spawn and exit anchors. Everything is
// a pure function of (worldSeed, tile index), so the planner (structures.js),
// the bake (world.js), the hooks, the runtime plates and every neighbouring
// tile agree without baking anything. The bake (world.js) composes the rest
// (lineside walkways, bores and rooms, the upper works' pockets and modules,
// lamps and furniture) around the skeleton from the same pure dice.
//
// Planner-chain module (§7.5): it may import only constants.js, core/hash.js,
// core/rng.js, mapTypes.js, mapFamily.js ({deepFreeze, MAP_FAMILY_CODES}),
// structures/catalog/engine.js, families/ids.js, tiles/tileKey.js and
// tiles/stubPlanner.js. Never tiles/stub.js, the canvas or the kit.
//
// The world (docs/liminal_maps/07-endless-train.md §4): one endless stopped
// train along +x on storey 0, tile row tz = 0 only, under the upper works on
// storey 1 (doc §5: concourses, ghost platforms, parallel tunnels). A tile
// is 4×1 chunks = 56 × 14 cells. Nothing is a fixed period:
//   - the CARS are drawn from the car catalogue (commuter 7, dining 7,
//     sleeper 8, open coach 9 cells, the luggage van and the dark baggage
//     car 6) until they fill the tile's 56 cells: 7 or 8 cars of mixed
//     lengths per tile (at most 2 luggage vans and 1 dark car);
//   - the train's PATH: every car has its own aisle row (z 2..11); the aisle
//     runs straight where it may (the long gangway view, doc §4.1) and steps
//     at most one row at a car joint; the tile seam's gangway row is hashed
//     per seam (ports), so the train enters and leaves every tile on a
//     different row, and a plain tile mostly bends once through a hashed
//     waypoint row;
//   - a STATION tile (the gap rule: never 3 tiles in a row without one)
//     draws its platform: side (south, north, or both sides of the train),
//     width (2–3 rows), which cars it serves (1–5, at least 12 cells), its
//     enclosed stair cores (one per chunk, E or W flights; 2–3 wherever the
//     platform spans the chunks, doc §4.1 "2–4 stair runs") 0–2 rows behind
//     the platform (a short stair passage between; or, on an island
//     platform, the far track behind it), the concourse over them on storey
//     1 (4–7 rows deep, its own length) and the exit closet at one of its
//     ends;
//   - a plain tile draws 1–2 service stair cores in whichever lineside band
//     has room beside the train's path at that point; each leads up to its
//     own dead-end pocket of the upper works.
// Storey 1 has no seam ports: the train is the only way from tile to tile
// (doc §11 "stations are where choice lives"; the exit is reached by riding
// to the unlisted station and climbing its own stairs).
// Tile-local rows: z 13 stays mass (the solid row below owns its line), x 55
// is mass except at the east seam's ports; the train and everything else
// lives in x 0..54 (x 55 for the train only), z 0..12 (platforms, concourses
// and cores in z 1..12).

export const FAMILY = MAP_FAMILY_TRAIN

// The kind's dice salt (rng(seed, SALT) in kind.js).
export const SALT = 0x07a1

// Kind-local storeys (= global storeys: the tile's band 0 starts at cy 0).
export const TRAIN = 0
export const CONC = 1

// §12.10: 4×1 chunks, rows [0], one band of two storeys (0 the train and its
// lineside, 1 the upper works). Salt = FAMILY_SALT.train (0x5a170000 + 14).
export const TILE = Object.freeze({ w: 4, d: 1, backend: 'band', H: 2, lo: 0, hi: 1, rows: Object.freeze([0]), salt: FAMILY_SALT.train })
export const TILE_CELLS = TILE.w * CHUNK // 56
export const ROWS = CHUNK // 14
export const X_EAST = TILE_CELLS - 1 // 55: mass except at the east seam's ports
export const Z_MIN = 0 // the north row may hold cells (walled on the owned line)
export const Z_MAX = ROWS - 2 // 12: the south row stays mass (§6.8 rule 1)
export const Z_SAFE = 1 // platforms, concourses and cores keep off row 0 (boards, core halos)

// The train's aisle rows (a car spans aisle − 1 .. aisle + 1) and the seam
// gangway rows (a subrange, so any two seams are at most 6 rows apart and a
// tile's 7+ cars can always walk between them).
export const AISLE_MIN = 2
export const AISLE_MAX = 11
export const PORT_MIN = 3
export const PORT_SPAN = 7

// The car catalogue (doc 07 §4.2 modules, in cells): length and the car-local
// side door bays (both sides); every other bay is a seat bay. The luggage
// van is lit and windowed (crates in its bays); the dark one is the blind
// baggage car (at most one per tile).
export const CAR_TYPES = Object.freeze({
  commuter: Object.freeze({ len: 7, doors: Object.freeze([1, 3, 5]) }),
  dining: Object.freeze({ len: 7, doors: Object.freeze([1, 5]) }),
  sleeper: Object.freeze({ len: 8, doors: Object.freeze([1, 6]) }),
  open: Object.freeze({ len: 9, doors: Object.freeze([1, 7]) }),
  luggage: Object.freeze({ len: 6, doors: Object.freeze([2, 3]) }),
  dark: Object.freeze({ len: 6, doors: Object.freeze([2, 3]) }),
})
const CAR_WEIGHTS = Object.freeze([['commuter', 5], ['open', 3], ['sleeper', 2], ['dining', 1], ['luggage', 1]])
const MAX_LUGGAGE = 2
export const MAX_CARS = 9

// Station names (concourse plates, ≤ 4 seven-segment glyphs) and the
// one-letter drift each can take (doc §10.1); the editor kind re-exports
// them. The unlisted station (doc §4.3 step 5, §10.2: the exit is a station
// that is not on the line map) shows UNLISTED on every plate.
export const STATIONS = Object.freeze([
  ['HoLt', 'HoLE'], ['CoLd', 'CoLt'], ['ACrE', 'ACnE'], ['FALL', 'FELL'], ['dorF', 'dorE'], ['LyrE', 'LynE'],
])
export const UNLISTED = 'nonE'

// --- dice ------------------------------------------------------------------------------

const H_STATION = 0x57a7
const H_NAME = 0x5a3e
const H_PORT0 = 0x9071
const H_CARS = 0x0ca7
const H_FAIL = 0xfa11
const H_PATH = 0x9a7b
const H_ST = 0x57a1
const H_CORE = 0xc03e
const H_CONC = 0xc0c0
const H_ANOM = 0xa40a
const H_WRONG = 0x3e0d
export const h = (worldSeed, tag, ...values) => hashChain((worldSeed ^ TILE.salt) | 0, tag, ...values)

// A tile's own dice for the bake (pure in (worldSeed, tx)): r(a, b, c) → uint32.
export const tileDice = (worldSeed, tx, salt) => (a = 0, b = 0, c = 0) => h(worldSeed >>> 0, salt, tx, a, b, c)

// --- stations ------------------------------------------------------------------------------

// Raw station roll (§12.10: hash(worldSeed, tx) % 2 === 0).
const rawStation = (worldSeed, tx) => (h(worldSeed, H_STATION, tx) & 1) === 0

// A tile is a station iff its raw roll says so, or it is forced: inside a run
// of raw gaps starting after the last raw station s, every third tile
// (tx − s − 1 ≡ 2 mod 3) is a station, so no 3 consecutive tiles lack one.
// The scan back is geometric (p = ½); after 64 tiles the run is taken to
// start there (pure either way).
const RUN_SCAN = 64
export function isStation(worldSeed, tx) {
  const seed = worldSeed >>> 0
  if (rawStation(seed, tx)) return true
  let s = tx - RUN_SCAN
  for (let t = tx - 1; t > tx - RUN_SCAN; t--) {
    if (rawStation(seed, t)) {
      s = t
      break
    }
  }
  return (tx - s - 1) % 3 === 2
}

// The station's name: one of STATIONS (the unlisted exit station overrides it).
export const stationNameOf = (worldSeed, tx) => STATIONS[h(worldSeed >>> 0, H_NAME, tx) % STATIONS.length]

// The stations east of tile 0, nearest first (at most `n`).
export function stationsEast(worldSeed, n) {
  const out = []
  for (let tx = 1; out.length < n && tx <= 3 * n + 3; tx++) if (isStation(worldSeed, tx)) out.push(tx)
  return out
}

// §12.10 exit: the second station east of tile 0 (tx 2..6 by the gap rule).
export const exitTileOf = (worldSeed) => stationsEast(worldSeed >>> 0, 2)[1]

// --- seams -----------------------------------------------------------------------------------

// The gangway row of the seam at x = 56·tx (storey 0): the aisle of the last
// car of tile tx − 1 and of the first car of tile tx.
export const portRow0 = (worldSeed, tx) => PORT_MIN + (h(worldSeed >>> 0, H_PORT0, tx) % PORT_SPAN)

// Ports (§6.5, §6.8), tile-local along-cells, inclusive: the gangway on the
// seam's row (storey 0), west side, and nothing else. Storey 1 is sealed at
// every seam (its pockets are each reached by their own stairs), and the
// north side faces the solid rows.
const NO_PORTS = Object.freeze([])
export function ports(worldSeed, k, side, cy) {
  if (side !== 'west' || cy !== TRAIN) return NO_PORTS
  const p = portRow0(worldSeed, k.tx)
  return Object.freeze([Object.freeze({ a0: p, a1: p })])
}

// §6.5 footprint: storeys 0 and 1 of the row are tile; anything else solid.
export function footprint(worldSeed, cx, cy, cz) {
  return tileKeyOf(TILE, cx, cy, cz) ? 'tile' : 'solid'
}

// The tile key of tile tx (band 0).
export const trainKey = (tx) => tileKeyAt(TILE, tx, 0, 0)

// --- the skeleton ---------------------------------------------------------------------------

// A remaining length r is fillable with at most `six` more 6-cell cars (the
// rest 7..9 cells) iff r − 6k is 0 or a sum of m cars of 7..9 cells
// (7m ≤ r − 6k ≤ 9m) for some k ≤ six.
const sums79 = (r) => r === 0 || (r >= 7 && Math.ceil(r / 9) <= Math.floor(r / 7))
const fillableWith = (r, six) => {
  for (let k = 0; k <= six && 6 * k <= r; k++) if (sums79(r - 6 * k)) return true
  return false
}

// The car sequence of tile tx (attempt `at`): types and lengths that fill 56
// cells, the dark baggage car (at most one; never tile 0's first car), at
// most MAX_LUGGAGE luggage vans (the 6-cell filler only when nothing else
// keeps the rest fillable).
function composeCars(seed, tx, at) {
  const r = (i, salt = 0) => h(seed, H_CARS, tx, at, i, salt)
  const darkWanted = r(99) % 4 !== 0
  const darkAt = 1 + (r(98) % 5)
  const types = []
  let left = TILE_CELLS
  let luggage = 0
  for (let i = 0; left > 0; i++) {
    let pick = null
    if (tx === 0 && i === 0) pick = 'commuter'
    else if (darkWanted && i === darkAt && fillableWith(left - CAR_TYPES.dark.len, MAX_LUGGAGE - luggage)) pick = 'dark'
    if (!pick || !fillableWith(left - CAR_TYPES[pick].len, MAX_LUGGAGE - luggage)) {
      // Weighted order, then the first that keeps the rest fillable.
      const bag = []
      for (const [t, wgt] of CAR_WEIGHTS) for (let k = 0; k < wgt; k++) bag.push(t)
      const order = []
      const seen = new Set()
      for (let k = 0; order.length < CAR_WEIGHTS.length && k < 40; k++) {
        const t = bag[r(i, 1 + k) % bag.length]
        if (!seen.has(t)) {
          seen.add(t)
          order.push(t)
        }
      }
      for (const [t] of CAR_WEIGHTS) if (!seen.has(t)) order.push(t)
      const six = (t) => MAX_LUGGAGE - luggage - (t === 'luggage' ? 1 : 0)
      const ok = (t) => six(t) >= 0 && fillableWith(left - CAR_TYPES[t].len, six(t))
      pick = order.find(ok) ?? null
      if (!pick) pick = 'luggage' // 6 always fits a fillable remainder ≥ 12
    }
    if (pick === 'luggage') luggage++
    types.push(pick)
    left -= CAR_TYPES[pick].len
  }
  const cars = []
  let x = 0
  for (let j = 0; j < types.length; j++) {
    const len = CAR_TYPES[types[j]].len
    cars.push({ j, type: types[j], len, x0: x, x1: x + len - 1, dark: types[j] === 'dark' })
    x += len
  }
  return cars
}

const range = (a, b) => {
  const out = []
  for (let v = a; v <= b; v++) out.push(v)
  return out
}

// A core: 6×4 cells with its halo (stairwellPlan's E/W core), strictly inside
// one chunk (x0 ∈ c·14 + [1, 7]), rows z0..z0+3 inside 1..12, and never on
// column 54 (kept clear of the east seam). doorSide 'near'
// opens its north wall (door cell north of it), 'far' its south wall.
function coreAt(x0, z0, dir, doorSide) {
  const x1 = x0 + 5
  const z1 = z0 + 3
  const door = { x: x0 + 2, z: doorSide === 'near' ? z0 - 1 : z1 + 1 }
  return Object.freeze({
    x0, z0, x1, z1, dir, doorSide,
    gx: dir === 'E' ? x0 + 1 : x0 + 4,
    gz: z0 + 1,
    chunk: Math.floor(x0 / CHUNK),
    door: Object.freeze(door),
  })
}
const coreSlots = (c) => range(c * CHUNK + 1, c * CHUNK + 7)

// Every station layout a car sequence admits, given the seam rows.
function stationOptions(cars, P0, P1) {
  const n = cars.length
  const out = []
  for (const side of ['S', 'N', 'B']) {
    for (const w of [2, 3]) {
      for (let s = 0; s < n - 1; s++) {
        for (let e = s; e <= Math.min(n - 2, s + 4); e++) {
          let dark = false
          for (let j = s; j <= e; j++) dark ||= cars[j].dark
          if (dark) break
          const px0 = cars[s].x0
          const px1 = cars[e].x1
          if (px1 - px0 + 1 < 12) continue
          for (let a = AISLE_MIN; a <= AISLE_MAX; a++) {
            if (Math.abs(a - P0) > s || Math.abs(P1 - a) > n - 1 - e) continue
            const southOk = a + 1 + w + 4 <= Z_MAX // platform + a core below
            const northOk = a - 1 - w - 4 >= Z_SAFE
            let coreSide = null
            if (side === 'S' && southOk) coreSide = 'S'
            if (side === 'N' && northOk) coreSide = 'N'
            if (side === 'B' && a - 1 - w >= Z_SAFE && a + 1 + w <= Z_MAX) coreSide = southOk ? 'S' : northOk ? 'N' : null
            if (!coreSide) continue
            const slots = []
            for (let c = 0; c < TILE.w; c++) {
              const xs = coreSlots(c).filter((x0) => x0 >= px0 && x0 + 5 <= px1 && x0 + 5 <= X_EAST - 2)
              if (xs.length) slots.push({ c, xs })
            }
            if (!slots.length) continue
            out.push({ side, w, s, e, a, coreSide, px0, px1, slots })
          }
        }
      }
    }
  }
  return out
}

// The aisle rows of the cars: from the west seam's row to the east seam's,
// one step at most per joint, flat over the station's cars. A joint keeps
// the row 3 times in 4 when it may (runs of straight cars give the long
// one-point view down the gangways, doc §4.1, §12 isovist).
function walkPath(seed, tx, at, n, P0, P1, fixed) {
  const a = new Array(n).fill(0)
  a[0] = P0
  // Targets: the station run (if any), or on a plain tile (three in four)
  // a hashed waypoint row at a hashed car well off the straight line between
  // the seams (the train's one bend, so equal seams do not give equal
  // paths), then the east seam.
  const targets = []
  if (fixed) targets.push({ j: fixed.s, v: fixed.a })
  else if (h(seed, H_PATH, tx, at, 99) % 4 !== 0) {
    const k = 2 + (h(seed, H_PATH, tx, at, 98) % (n - 4))
    const line = P0 + ((P1 - P0) * k) / (n - 1)
    const ok = []
    for (let v = AISLE_MIN; v <= AISLE_MAX; v++) if (Math.abs(v - P0) <= k && Math.abs(P1 - v) <= n - 1 - k) ok.push(v)
    const far = ok.filter((v) => Math.abs(v - line) >= 2)
    const pool = far.length ? far : ok
    targets.push({ j: k, v: pool[h(seed, H_PATH, tx, at, 97) % pool.length] })
  }
  targets.push({ j: n - 1, v: P1 })
  for (let j = 1; j < n; j++) {
    if (fixed && j > fixed.s && j <= fixed.e) {
      a[j] = fixed.a
      continue
    }
    const t = targets.find((q) => q.j >= j)
    const later = targets.filter((q) => q.j > t.j)
    const roll = h(seed, H_PATH, tx, at, j) % 20
    const pref = roll < 15 ? [0, 1, -1] : roll < 18 ? [1, -1, 0] : [-1, 1, 0]
    let pick = null
    for (const d of pref) {
      const v = a[j - 1] + d
      if (v < AISLE_MIN || v > AISLE_MAX) continue
      if (Math.abs(t.v - v) > t.j - j) continue
      if (later.some((q) => Math.abs(q.v - t.v) > q.j - t.j)) continue
      pick = v
      break
    }
    a[j] = pick ?? a[j - 1] + Math.sign(t.v - a[j - 1])
  }
  return a
}

// Service cores in a plain tile's lineside bands: wherever the train's path
// leaves 4 rows (plus the walkway row) beside it.
function serviceCores(seed, tx, at, cars) {
  const aisleAt = (x) => cars.find((c) => x >= c.x0 && x <= c.x1).aisle
  const opts = []
  for (let c = 0; c < TILE.w; c++) {
    for (const x0 of coreSlots(c)) {
      if (x0 + 5 > X_EAST - 2) continue
      let amin = Infinity
      let amax = -Infinity
      for (let x = x0; x <= x0 + 5; x++) {
        amin = Math.min(amin, aisleAt(x))
        amax = Math.max(amax, aisleAt(x))
      }
      // North: core rows amin−6 .. amin−3, door on its south wall.
      if (amin - 6 >= Z_SAFE) opts.push({ c, x0, side: 'N', z0: amin - 6 })
      // South: core rows amax+3 .. amax+6, door on its north wall.
      if (amax + 6 <= Z_MAX) opts.push({ c, x0, side: 'S', z0: amax + 3 })
    }
  }
  const cores = []
  const want = 1 + (h(seed, H_CORE, tx, at, 1) % 3 === 0 ? 1 : 0)
  for (let k = 0; k < want; k++) {
    // A second core keeps a chunk clear of the first (its own pocket above).
    const free = opts.filter((o) => !cores.some((q) => Math.abs(q.chunk - o.c) < 1 + k))
    if (!free.length) break
    const o = free[h(seed, H_CORE, tx, at, 2, k) % free.length]
    const dir = h(seed, H_CORE, tx, at, 3, k) & 1 ? 'E' : 'W'
    cores.push(coreAt(o.x0, o.z0, dir, o.side === 'N' ? 'far' : 'near'))
  }
  return cores
}

function buildSkeleton(seed, tx) {
  const P0 = portRow0(seed, tx)
  const P1 = portRow0(seed, tx + 1)
  const station = isStation(seed, tx)
  let cars = null
  let opt = null
  let svc = null
  let want = 0
  for (let at = 0; at < 24; at++) {
    cars = composeCars(seed, tx, at)
    if (cars.length - 1 < Math.abs(P1 - P0)) continue
    if (station) {
      const opts = stationOptions(cars, P0, P1)
      if (!opts.length) continue
      // Cores: 2 (two in three) or 3 wanted; the layouts whose platform
      // spans that many chunks first (doc §4.1: 2–4 stair runs, ≥ 1 loop
      // per station), then 2, then any.
      want = 2 + (h(seed, H_ST, tx, at, 1) % 3 === 0 ? 1 : 0)
      const pool = [want, 2, 1].map((k) => opts.filter((o) => o.slots.length >= k)).find((p) => p.length)
      opt = pool[h(seed, H_ST, tx, at) % pool.length]
      const aisles = walkPath(seed, tx, at, cars.length, P0, P1, opt)
      for (let j = 0; j < cars.length; j++) cars[j].aisle = aisles[j]
      break
    }
    const aisles = walkPath(seed, tx, at, cars.length, P0, P1, null)
    for (let j = 0; j < cars.length; j++) cars[j].aisle = aisles[j]
    svc = serviceCores(seed, tx, at, cars)
    if (svc.length) break
  }
  if (cars[0].aisle === undefined) {
    // No station layout fitted any attempt (never seen): a straight walk.
    const aisles = walkPath(seed, tx, 0, cars.length, P0, P1, null)
    for (let j = 0; j < cars.length; j++) cars[j].aisle = aisles[j]
  }
  if (!opt && !svc) svc = serviceCores(seed, tx, 0, cars)
  const n = cars.length
  // Gangways: the west line of every car; on a jog the door sits on the
  // west car's aisle row (inside the east car's side bay at its x0).
  const joints = cars.map((c, j) => Object.freeze({ x: c.x0, z: j ? cars[j - 1].aisle : P0, west: j - 1, east: j }))
  const dark = cars.findIndex((c) => c.dark)
  const failSide = dark < 0 ? 0 : dark === 0 ? 1 : dark === n - 1 ? -1 : h(seed, H_FAIL, tx) & 1 ? 1 : -1

  let st = null
  let cores
  if (opt) {
    const { side, w, s, e, a, coreSide, px0, px1, slots } = opt
    const platforms = []
    const south = { side: 'S', x0: px0, x1: px1, z0: a + 2, z1: a + 1 + w }
    const north = { side: 'N', x0: px0, x1: px1, z0: a - 1 - w, z1: a - 2 }
    if (side === 'S' || side === 'B') platforms.push(Object.freeze(south))
    if (side === 'N' || side === 'B') platforms.push(Object.freeze(north))
    // Cores: `want` of the admissible chunks, each at a hashed slot, 0–2
    // rows back from the platform (a short stair passage between).
    const room = coreSide === 'S' ? Z_MAX - (a + 1 + w + 4) : a - 1 - w - 4 - Z_SAFE
    const gap = Math.min(room, h(seed, H_ST, tx, 5) % 3)
    // An island platform (doc §4.3 step 4, §5; one in two where the cores
    // stand back): the far track runs behind the platform in the gap's
    // first row, the platform edge railed along it.
    const island = gap >= 1 && h(seed, H_ST, tx, 6) % 2 === 0
    const order = slots.map((sl, i) => ({ sl, k: h(seed, H_ST, tx, 2, i) })).sort((p, q) => p.k - q.k).map((o) => o.sl)
    cores = order.slice(0, want).sort((p, q) => p.c - q.c).map((sl, i) => {
      const x0 = sl.xs[h(seed, H_ST, tx, 3, i) % sl.xs.length]
      const dir = h(seed, H_ST, tx, 4, i) & 1 ? 'E' : 'W'
      return coreSide === 'S' ? coreAt(x0, south.z1 + 1 + gap, dir, 'near') : coreAt(x0, north.z0 - 4 - gap, dir, 'far')
    })
    // The concourse over the cores' doors (storey 1), its free side away
    // from them, and the exit closet at one of its ends.
    const depth = 4 + (h(seed, H_CONC, tx, 1) % 4)
    const doorRow = cores[0].door.z
    let cz0 = coreSide === 'S' ? doorRow - depth + 1 : doorRow
    let cz1 = coreSide === 'S' ? doorRow : doorRow + depth - 1
    cz0 = Math.max(Z_SAFE, cz0)
    cz1 = Math.min(Z_MAX, cz1)
    const dx0 = Math.min(...cores.map((c) => c.door.x))
    const dx1 = Math.max(...cores.map((c) => c.door.x))
    // The closet (2 cells past an end) keeps off columns 0..1 and 54..55,
    // by the seams.
    let cx0 = Math.max(4, dx0 - 1 - (h(seed, H_CONC, tx, 2) % 9))
    let cx1 = Math.min(X_EAST - 4, dx1 + 1 + (h(seed, H_CONC, tx, 3) % 9))
    // At least 8 cells long (the gate bank needs its walk gaps).
    while (cx1 - cx0 + 1 < 8) {
      if (cx1 < X_EAST - 4) cx1++
      else cx0--
    }
    const concourse = Object.freeze({ x0: cx0, z0: cz0, x1: cx1, z1: cz1, free: coreSide === 'S' ? 'N' : 'S' })
    const east = h(seed, H_CONC, tx, 4) & 1
    const clz0 = coreSide === 'S' ? cz0 : cz1 - 1
    const closet = Object.freeze(east
      ? { x0: cx1 + 1, z0: clz0, x1: cx1 + 2, z1: clz0 + 1, door: Object.freeze({ x: cx1 + 1, z: clz0 }) }
      : { x0: cx0 - 2, z0: clz0, x1: cx0 - 1, z1: clz0 + 1, door: Object.freeze({ x: cx0, z: clz0 }) })
    // The exit cell first: the closet cell farthest from its door.
    const far = east ? closet.x1 : closet.x0
    const near = east ? closet.x0 : closet.x1
    const exitCells = Object.freeze([
      Object.freeze({ gx: far, gz: closet.z0 }), Object.freeze({ gx: far, gz: closet.z1 }),
      Object.freeze({ gx: near, gz: closet.z1 }), Object.freeze({ gx: near, gz: closet.z0 }),
    ])
    const chunksOf = (x0, x1) => range(Math.floor(x0 / CHUNK), Math.floor(x1 / CHUNK))
    st = Object.freeze({
      side, w, s, e, aisle: a, coreSide, gap, island,
      platforms: Object.freeze(platforms),
      concourse,
      closet,
      exitCells,
      chunks0: Object.freeze(chunksOf(px0, px1)),
      chunks1: Object.freeze(chunksOf(cx0, cx1)),
    })
  } else cores = svc

  return Object.freeze({
    tx,
    P0,
    P1,
    n,
    cars: Object.freeze(cars.map((c) => Object.freeze(c))),
    joints: Object.freeze(joints),
    dark,
    failSide,
    station: st,
    cores: Object.freeze(cores),
  })
}

const MEMO = new Map()
const MEMO_CAP = 4096
export function skeleton(worldSeed, tx) {
  const seed = worldSeed >>> 0
  const key = `${seed}:${tx}`
  let sk = MEMO.get(key)
  if (!sk) {
    if (MEMO.size >= MEMO_CAP) MEMO.clear()
    MEMO.set(key, (sk = buildSkeleton(seed, tx)))
  }
  return sk
}

// The car at tile-local x (storey 0), or null.
export const carAt = (sk, x) => sk.cars.find((c) => x >= c.x0 && x <= c.x1) ?? null

const localChunkX = (cx) => cx - Math.floor(cx / TILE.w) * TILE.w

// The streaming hint's chunks: the chunks of a tile holding a stair core
// (flights between storeys 0 and 1).
export function stairChunk(worldSeed, cx, cz, lowerCy) {
  if (lowerCy !== TRAIN || cz !== 0) return false
  const sk = skeleton(worldSeed, Math.floor(cx / TILE.w))
  const lc = localChunkX(cx)
  return sk.cores.some((c) => c.chunk === lc)
}

// --- spawn and exit ------------------------------------------------------------------

// §12.10 spawn: the aisle of tile 0's first car (a commuter car), storey 0.
export function spawnCells(worldSeed) {
  const sk = skeleton(worldSeed, 0)
  const z = sk.cars[0].aisle
  return Object.freeze([3, 1, 5, 2, 4].map((gx) => Object.freeze({ gx, gz: z })))
}

// The exit closet's cells (tile-local, storey 1) of station tile tx, the
// marked one first, or [] off-station.
export const exitCellsOf = (worldSeed, tx) => skeleton(worldSeed, tx).station?.exitCells ?? []

// The GLOBAL chunk cell of tile-local cell (gx, gz) of tile tx, storey cy.
export function cellOfTile(tx, gx, gz, cy) {
  const x = tx * TILE_CELLS + gx
  const cx = Math.floor(x / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { cx, cy, cz, lx: x - cx * CHUNK, lz: gz - cz * CHUNK }
}

// §8.2 exit anchor: the closet's first cell (the one the bake marks) of the
// exit station, storey 1.
export function exitAnchor(worldSeed) {
  const tx = exitTileOf(worldSeed >>> 0)
  const c = exitCellsOf(worldSeed, tx)[0]
  return cellOfTile(tx, c.gx, c.gz, CONC)
}

// --- anomalies -------------------------------------------------------------------------
//
// doc 14: train, segment = car, 1 per 3 cars, one event slot per car, at
// most one per segment, never on the exit segment, never the same class twice
// in a row. A tile's n cars are cut into m = round(n / 3) periods (2 or 3);
// periods chain across tiles. Each period carries exactly one anomaly at a
// hashed car, scanning the period with wrap-around when the hashed car cannot
// take one.
//
// Classes (per car):
//   carNumbers   the car's plates lie: both its LED panels repeat the
//                previous car's number;
//   wrongSide    the car's side doors open onto the tunnel wall (one-cell
//                niches) on the side away from any platform; on a station
//                with platforms both sides, the platform is on the wrong
//                side: the car's doors onto the stairs' platform stay shut
//                (the station's other cars still open onto it);
//   stationName  the station's later boards drift by one letter: any
//                station car of a station spanning 2+ chunks on both
//                storeys;
//   blackout     every tube of the car is dead while its seats and glass stay.
// Blocked: tile 0's cars, the last 3 cars of tile −1 and the first 3 of tile
// 1 (the spawn clearance), the exit tile, the dark car. None of them blocks
// a route: plates, niches and lamps only.
export const ANOMALY_CLASSES = Object.freeze(['carNumbers', 'stationName', 'wrongSide', 'blackout'])

const periodsOf = (n) => Math.round(n / 3)
export function periodCars(n, i) {
  const m = periodsOf(n)
  return [Math.floor((i * n) / m), Math.floor(((i + 1) * n) / m) - 1]
}
const prevPeriod = (seed, tx, i) => (i > 0 ? [tx, i - 1] : [tx - 1, periodsOf(skeleton(seed, tx - 1).n) - 1])
const nextPeriod = (seed, tx, i) => (i < periodsOf(skeleton(seed, tx).n) - 1 ? [tx, i + 1] : [tx + 1, 0])

function carClasses(seed, tx, j, exTx) {
  const sk = skeleton(seed, tx)
  if (tx === 0 || tx === exTx) return []
  if (tx === -1 && j >= sk.n - 3) return []
  if (tx === 1 && j < 3) return []
  if (sk.cars[j].dark) return []
  const out = ['carNumbers']
  const st = sk.station
  if (st && j >= st.s && j <= st.e && st.chunks0.length >= 2 && st.chunks1.length >= 2) out.push('stationName')
  out.push('wrongSide')
  out.push('blackout')
  return out
}

function rawPeriod(seed, tx, i, exTx) {
  const sk = skeleton(seed, tx)
  const [j0, j1] = periodCars(sk.n, i)
  const len = j1 - j0 + 1
  const hp = h(seed, H_ANOM, tx, i)
  const start = hp % len
  const turn = (hp >>> 3) % ANOMALY_CLASSES.length
  const order = ANOMALY_CLASSES.map((_, k) => ANOMALY_CLASSES[(k + turn) % ANOMALY_CLASSES.length])
  const slots = []
  for (let k = 0; k < len; k++) {
    const j = j0 + ((start + k) % len)
    const cls = carClasses(seed, tx, j, exTx)
    const ranked = order.filter((c) => cls.includes(c))
    if (ranked.length) slots.push({ j, ranked })
  }
  if (!slots.length) return null
  return { tx, i, pri: hp >>> 6, slots }
}

const outranks = (a, b) => a.pri > b.pri || (a.pri === b.pri && (a.tx > b.tx || (a.tx === b.tx && a.i > b.i)))

function finalPeriod(seed, me, exTx, memo) {
  const key = `${me.tx},${me.i}`
  const hit = memo.get(key)
  if (hit !== undefined) return hit
  const taken = new Set()
  for (const [qt, qi] of [prevPeriod(seed, me.tx, me.i), nextPeriod(seed, me.tx, me.i)]) {
    const n = rawPeriod(seed, qt, qi, exTx)
    if (!n || !outranks(n, me)) continue
    const f = finalPeriod(seed, n, exTx, memo)
    if (f) taken.add(f.cls)
  }
  let out = null
  for (const s of me.slots) {
    const cls = s.ranked.find((c) => !taken.has(c))
    if (cls) {
      out = { tx: me.tx, i: me.i, j: s.j, cls }
      break
    }
  }
  memo.set(key, out)
  return out
}

// The anomaly of period i of tile tx ({tx, i, j, cls} | null).
export function periodAnomaly(worldSeed, tx, i) {
  const seed = worldSeed >>> 0
  const exTx = exitTileOf(seed)
  const me = rawPeriod(seed, tx, i, exTx)
  return me ? finalPeriod(seed, me, exTx, new Map()) : null
}

// The periods of tile tx, in order.
export const periodCount = (worldSeed, tx) => periodsOf(skeleton(worldSeed, tx).n)

// The anomalies of tile tx: [{ car (tile-local), cls }], car order.
const ANOM_MEMO = new Map()
export function tileAnomalies(worldSeed, tx) {
  const seed = worldSeed >>> 0
  const key = `${seed}:${tx}`
  let out = ANOM_MEMO.get(key)
  if (out) return out
  out = []
  for (let i = 0; i < periodCount(seed, tx); i++) {
    const a = periodAnomaly(seed, tx, i)
    if (a) out.push(Object.freeze({ car: a.j, cls: a.cls }))
  }
  out = Object.freeze(out.sort((a, b) => a.car - b.car))
  if (ANOM_MEMO.size >= MEMO_CAP) ANOM_MEMO.clear()
  ANOM_MEMO.set(key, out)
  return out
}

// The side (+1 south, −1 north) a wrongSide car's doors open on: away from
// the platform on a station car (on a both-sides station, the side whose
// doors stay shut: the cores' platform), hashed elsewhere.
export function wrongSideOf(worldSeed, tx, j) {
  const st = skeleton(worldSeed, tx).station
  if (st && j >= st.s && j <= st.e) return st.side === 'B' ? (st.coreSide === 'S' ? 1 : -1) : st.side === 'S' ? -1 : 1
  return h(worldSeed >>> 0, H_WRONG, tx, j) & 1 ? 1 : -1
}

// --- labels (doc §6 LED panels and boards, spec §12.10 Labels) --------------------------

// The number car j of tile tx shows: 'C<n>', n its place in its tile; a
// carNumbers car repeats the previous car's number (the previous tile's last
// before a tile's C1).
export function carPlateOf(worldSeed, tx, j) {
  const lies = tileAnomalies(worldSeed, tx).some((m) => m.car === j && m.cls === 'carNumbers')
  if (!lies) return `C${j + 1}`
  return `C${j === 0 ? skeleton(worldSeed, tx - 1).n : j}`
}

// The names station tile tx's boards show, per station chunk in x order
// (storey 0: the platform's chunks; storey 1: the concourse's), or null
// off-station: the station's name, the later chunks drifting by one letter
// under a stationName anomaly; the exit station's read UNLISTED.
export function stationPlatesOf(worldSeed, tx, cy = TRAIN) {
  const seed = worldSeed >>> 0
  const st = skeleton(seed, tx).station
  if (!st) return null
  const chunks = cy === TRAIN ? st.chunks0 : st.chunks1
  if (exitTileOf(seed) === tx) return chunks.map((c) => ({ chunk: c, name: UNLISTED }))
  const [name, drifted] = stationNameOf(seed, tx)
  const drifts = tileAnomalies(seed, tx).some((m) => m.cls === 'stationName')
  return chunks.map((c, i) => ({ chunk: c, name: drifts && i > 0 ? drifted : name }))
}

// The boards of a station (plates.js): storey 0 on the platforms' back walls
// (facing the platform), storey 1 on the concourse's free-side wall.
export function stationBoards(st, cy) {
  if (!st) return []
  if (cy === TRAIN) return st.platforms.map((p) => (p.side === 'S' ? { line: p.z1 + 1, side: -1, x0: p.x0, x1: p.x1 } : { line: p.z0, side: 1, x0: p.x0, x1: p.x1 }))
  const c = st.concourse
  return [c.free === 'N' ? { line: c.z0, side: 1, x0: c.x0, x1: c.x1 } : { line: c.z1 + 1, side: -1, x0: c.x0, x1: c.x1 }]
}

// Light-weight probe for tests and tools: the skeleton's dark car index.
export const darkCarOf = (worldSeed, tx) => skeleton(worldSeed, tx).dark

// Re-exported for the kind's dice compatibility.
export { localChunkX }
