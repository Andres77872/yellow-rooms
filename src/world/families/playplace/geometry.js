import { CHUNK } from '../../constants.js'
import { hash3i } from '../../core/hash.js'
import { MAP_FAMILY_PLAYPLACE } from '../ids.js'
import { assembleCatalogDescriptor, linkHalo } from '../../structures/catalog/engine.js'
import { FAMILY_SALT, hashChain, planPick, structureId, tileKeyAt, tileKeyOf, tileSeed } from '../../tiles/tileKey.js'

// The playplace family's pure geometry (spec §3.3, §12.9, rebuilt as a
// grammar): every module (tile) is COMPOSED from its planSeed, never copied.
// The editor prototype is the parts catalogue (play halls, pits, wells, net
// bridges, crawl tubes and pods, party rooms, arcade, lounge, toilets, staff
// room, parents' benches, punch bags, the mascot); this file is the grammar
// that arranges them (docs/liminal_maps/10-playplace.md §4.4):
//
//   1. seams: one or two ports per module seam on the floor (cy 0) and, on
//      about half the seams, one or two on the deck (cy 1); count, position
//      and width are hashed from the seam key alone (pure, shared by both
//      modules);
//   2. volumes: one 6–10-cell play hall (50%), two on either side of a
//      chunk seam (28%) or one big 10–12-cell hall (22%), at hashed
//      positions and sizes, each of a hashed type — 'frame' (pit, a wider well when three
//      storeys tall, net bridges, frame posts), 'pitHall' (one big ball pit
//      with 1–2 net bridges), 'court' (a double-height food court under a
//      mezzanine) or 'fortress' (a compact three-storey frame of small
//      holes) — at most one three storeys tall; each is a catalog volume
//      assembled here at TRUE GLOBAL coordinates (the planner returns it);
//   3. per storey (floor, deck): hall doors on hashed sides; on the deck a
//      crawl-tube block of padding mass (a pod lattice of 2–4 × 2–3, a random
//      spanning tree plus 1–2 extra tubes, so the crawl layer always closes a
//      loop; bubble-window nubs and a mouth onto the hall when it touches one),
//      and a second, smaller block against a second hall the first does not
//      reach; a corridor network routed (turn-penalised Dijkstra over a
//      hashed cost field, trunks reused) from every port, hall door and tube
//      mouth (and, on the deck, anchors in the free floor far from all of
//      them, so no quarter of the mezzanine is left blank), plus
//      1–3 loop corridors and a widened run or two; the rest cut into rooms
//      (greedy hashed rectangles) that open onto a corridor or onto a room
//      already reached (at most two rooms deep), typed by size (3×3 party
//      rooms, an arcade, a lounge or café, toilets, a staff room, store
//      rooms); 1-wide slivers and rooms nothing reaches are solid mass;
//   4. the top deck (cy 2) is the tall hall's alone (footprint-solid elsewhere).
//
// Everything is a pure function of (worldSeed, global coordinates) or of a
// module's planSeed (tileSeed of attempt 0), so the planner (structures.js),
// the tile program (tile.js) and the hooks agree.
//
// Planner-chain module (§7.5): it may import only constants.js, core/hash.js,
// core/rng.js, mapTypes.js, mapFamily.js ({deepFreeze, MAP_FAMILY_CODES}),
// structures/catalog/engine.js, families/ids.js, tiles/tileKey.js and
// tiles/stubPlanner.js. Never tiles/stub.js, the canvas or the kit.
//
// Kind-local frame = module-local: storeys 0 floor, 1 deck, 2 top deck;
// cells x 0..27, z 0..27 (2×2 chunks). Module (tx, tz) cell (gx, gz) is
// global (tx·28 + gx, tz·28 + gz).

export const FAMILY = MAP_FAMILY_PLAYPLACE

// The kind's dice salt (rng(seed, SALT) in tile.js).
export const SALT = 0x0aa1

// Kind-local storeys.
export const FLOOR = 0
export const DECK = 1
export const TOP = 2

// The module (§6.2): 2×2 chunks, backend 'band', one band of three storeys.
export const TILE = Object.freeze({ w: 2, d: 2, backend: 'band', H: 3, lo: 0, hi: 2, salt: FAMILY_SALT.playplace })
export const TILE_CELLS = TILE.w * CHUNK // 28 cells per module side
const N = TILE_CELLS
const LAST = N - 1

// §7.2: the planner's attempt budget per hall shape.
export const PICK_ATTEMPTS = 8

export const R = (x0, z0, x1, z1) => ({ x0, z0, x1, z1 })
export const grow = (r, n) => R(r.x0 - n, r.z0 - n, r.x1 + n, r.z1 + n)
export const inRect = (r, gx, gz) => gx >= r.x0 && gx <= r.x1 && gz >= r.z0 && gz <= r.z1
const shift = (r, dx, dz) => R(r.x0 + dx, r.z0 + dz, r.x1 + dx, r.z1 + dz)

// The kind's dice, index-keyed: roll(seed, a, b) === rng(seed, SALT)(a, b)
// (tiles/floorPlan.js), without importing the floor-plan compiler.
export const roll = (seed, a, b = 0) => hash3i((seed ^ SALT) | 0, a | 0, b | 0, 0x51) >>> 0
export const rollOf = (seed) => (a, b = 0) => roll(seed, a, b)

// A counter dice: every call is the next index of one hashed stream.
function dice(seed, salt) {
  let n = 0
  const u = () => hash3i((seed ^ salt) | 0, n++, 0x5d1c, 0x51) >>> 0
  return {
    u,
    int: (k) => (k <= 1 ? (u(), 0) : u() % k),
    range: (a, b) => (b <= a ? (u(), a) : a + (u() % (b - a + 1))),
    chance: (p) => u() / 4294967296 < p,
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = u() % (i + 1)
        ;[arr[i], arr[j]] = [arr[j], arr[i]]
      }
      return arr
    },
  }
}

// Layout cell codes.
export const MASS = 0
export const CORR = 1
export const ROOM = 2
export const HALL = 3
export const TUBE = 4
export const POD = 5
const FREE = 255
export const walkableCode = (c) => c === CORR || c === ROOM || c === HALL || c === TUBE || c === POD
const I = (x, z) => z * N + x
const XZ = (i) => [i % N, (i - (i % N)) / N]

// Edge keys: 'v' line gx between (gx−1, gz) and (gx, gz); 'h' line gz
// between (gx, gz−1) and (gx, gz).
export const edgeKey = (axis, gx, gz) => `${axis}:${gx},${gz}`
export function edgeBetween(ax, az, bx, bz) {
  if (bx !== ax) return { axis: 'v', gx: Math.max(ax, bx), gz: az }
  return { axis: 'h', gx: ax, gz: Math.max(az, bz) }
}

// Hall themes (doc §4.4: jungle, space, ocean — colour only).
export const PLAY_THEMES = Object.freeze([
  Object.freeze({ name: 'jungle', tint: 0xd8ffcc }),
  Object.freeze({ name: 'space', tint: 0xd4d8ff }),
  Object.freeze({ name: 'ocean', tint: 0xc8f2ff }),
])

// --- seams --------------------------------------------------------------------------

// The ports of a seam: the seam west ('x') or north ('z') of module (tx, tz)
// on storey cy. Pure in the seam key: both modules read the same value. The
// floor always crosses (one port, two on about 40% of the seams); the deck
// on about 55% of the seams (one port, or two on about a quarter of those).
// A port is 1–2 cells wide at along-cells 3..24; two ports stand ≥ 5 apart.
const PORT_SALT = 0x50a7
const NO_PORTS = Object.freeze([])
const portMemo = new Map()
function seamPorts(worldSeed, side, tx, tz, cy) {
  if (cy !== FLOOR && cy !== DECK) return NO_PORTS
  const key = `${worldSeed >>> 0}|${side}|${tx},${tz},${cy}`
  let p = portMemo.get(key)
  if (p) return p
  const h = hashChain(((worldSeed >>> 0) ^ TILE.salt ^ PORT_SALT) | 0, tx, tz, (side === 'x' ? 1 : 2) + cy * 4)
  const h2 = hashChain(((worldSeed >>> 0) ^ TILE.salt ^ PORT_SALT ^ 0x2b) | 0, tx, tz, (side === 'x' ? 1 : 2) + cy * 4)
  const roll = h2 % 100
  const count = cy === FLOOR ? (roll < 40 ? 2 : 1) : roll < 45 ? 0 : roll < 86 ? 1 : 2
  if (!count) p = NO_PORTS
  else {
    const w = 1 + ((h >>> 20) & 1)
    const a0 = 3 + (h % 21)
    const list = [{ a0, a1: a0 + w - 1 }]
    if (count === 2) {
      // The second: a hashed free start ≥ 5 cells from the first.
      const free = []
      for (let b = 3; b <= 23; b++) if (b + 1 < a0 - 4 || b > a0 + w + 3) free.push(b)
      if (free.length) {
        const b0 = free[(h2 >>> 8) % free.length]
        const w2 = 1 + ((h2 >>> 20) & 1)
        list.push({ a0: b0, a1: Math.min(24, b0 + w2 - 1) })
      }
    }
    list.sort((a, b) => a.a0 - b.a0)
    p = Object.freeze(list.map((q) => Object.freeze(q)))
  }
  if (portMemo.size > 8192) portMemo.clear()
  portMemo.set(key, p)
  return p
}

// §6.5 ports, module-local along-cells, inclusive: west and north are this
// module's own seams; the east view of tile tx is ports(seed,{tx:tx+1},'west').
export function ports(worldSeed, k, side, cy) {
  if (side === 'west') return seamPorts(worldSeed, 'x', k.tx, k.tz, cy)
  if (side === 'north') return seamPorts(worldSeed, 'z', k.tx, k.tz, cy)
  if (side === 'east') return seamPorts(worldSeed, 'x', k.tx + 1, k.tz, cy)
  if (side === 'south') return seamPorts(worldSeed, 'z', k.tx, k.tz + 1, cy)
  return NO_PORTS
}

const portsOfModule = (worldSeed, tx, tz) => [FLOOR, DECK].map((cy) => ({
  west: ports(worldSeed, { tx, tz }, 'west', cy),
  north: ports(worldSeed, { tx, tz }, 'north', cy),
  east: ports(worldSeed, { tx, tz }, 'east', cy),
  south: ports(worldSeed, { tx, tz }, 'south', cy),
}))

// --- volumes: the play halls --------------------------------------------------------

export const HALL_TYPES = Object.freeze(['frame', 'pitHall', 'court', 'fortress'])
const LABELS = { frame: 'soft-play hall', pitHall: 'ball-pit hall', court: 'food court', fortress: 'play fortress' }
const seamLine = (l) => ((l % CHUNK) + CHUNK) % CHUNK === 0
const voidOk = (v) => v.x1 >= v.x0 && v.z1 >= v.z0 && !seamLine(v.x0) && !seamLine(v.x1 + 1) && !seamLine(v.z0) && !seamLine(v.z1 + 1)
const bridgeOk = (br) => (br.z0 === br.z1 ? !seamLine(br.z0) && !seamLine(br.z0 + 1) : !seamLine(br.x0) && !seamLine(br.x0 + 1))
const localOk = (g) => g % CHUNK !== 0 && g % CHUNK !== CHUNK - 1

// A net bridge across void v on an interior line, along x or z ('x' | 'z').
function bridgeAcross(v, axis, d) {
  if (axis === 'x') {
    if (v.z1 - v.z0 < 2) return null
    const z = d.range(v.z0 + 1, v.z1 - 1)
    const br = R(v.x0, z, v.x1, z)
    return bridgeOk(br) ? br : null
  }
  if (v.x1 - v.x0 < 2) return null
  const x = d.range(v.x0 + 1, v.x1 - 1)
  const br = R(x, v.z0, x, v.z1)
  return bridgeOk(br) ? br : null
}

// One hall's shape (module-local): its levels' voids and bridges and its
// frame posts, or null when the roll does not fit (the caller re-rolls).
function hallShape(type, L, b, d) {
  const w = b.x1 - b.x0 + 1
  const dd = b.z1 - b.z0 + 1
  const levels = [{ voids: [], bridges: [] }]
  const piers = []
  const posts = (r, p) => {
    for (const [gx, gz] of [[r.x0, r.z0], [r.x1, r.z0], [r.x0, r.z1], [r.x1, r.z1]]) {
      if (!inRect(grow(b, -1), gx, gz) || !localOk(gx) || !localOk(gz)) continue
      if (d.chance(p)) piers.push({ gx, gz })
    }
  }
  if (type === 'frame') {
    const m = L === 3 ? 2 : 1
    const pw = d.range(2, Math.min(5, w - 2 * m - 1))
    const pd = d.range(2, Math.min(5, dd - 2 * m - 1))
    if (b.x1 - m - pw + 1 < b.x0 + m || b.z1 - m - pd + 1 < b.z0 + m) return null
    const px = d.range(b.x0 + m, b.x1 - m - pw + 1)
    const pz = d.range(b.z0 + m, b.z1 - m - pd + 1)
    const pit = R(px, pz, px + pw - 1, pz + pd - 1)
    const axis = d.int(2) ? 'x' : 'z'
    const br1 = bridgeAcross(pit, axis, d) ?? bridgeAcross(pit, axis === 'x' ? 'z' : 'x', d)
    levels.push({ voids: [pit], bridges: br1 ? [br1] : [] })
    if (L === 3) {
      const well = grow(pit, 1)
      const br2 = bridgeAcross(well, axis === 'x' ? 'z' : 'x', d) ?? bridgeAcross(well, axis, d)
      levels.push({ voids: [well], bridges: br2 ? [br2] : [] })
      posts(grow(well, 1), 0.75)
    } else posts(grow(pit, 1), 0.5)
  } else if (type === 'pitHall') {
    // A rim of 1 round the pit, 2–3 on one side (the flights' band), and a
    // second wide side on about half the halls.
    const mg = [1, 1, 1, 1]
    const wide = d.int(4)
    mg[wide] = d.range(2, 3)
    if (d.chance(0.5)) mg[(wide + 1 + d.int(3)) % 4] = 2
    const v = R(b.x0 + mg[3], b.z0 + mg[0], b.x1 - mg[1], b.z1 - mg[2])
    if (v.x1 - v.x0 < 2 || v.z1 - v.z0 < 2) return null
    const along = v.x1 - v.x0 >= v.z1 - v.z0 ? 'x' : 'z'
    const bridges = []
    const first = bridgeAcross(v, along, d)
    if (first) bridges.push(first)
    const short = along === 'x' ? v.z1 - v.z0 + 1 : v.x1 - v.x0 + 1
    if (short >= 7 && d.chance(0.6)) {
      const second = bridgeAcross(v, along, d)
      const line = (br) => (along === 'x' ? br.z0 : br.x0)
      if (second && (!first || Math.abs(line(second) - line(first)) >= 3)) bridges.push(second)
    }
    levels.push({ voids: [v], bridges })
  } else if (type === 'court') {
    const mg = [2, 2, 2, 2]
    if (d.chance(0.5)) mg[d.int(4)] = 3
    const v = R(b.x0 + mg[3], b.z0 + mg[0], b.x1 - mg[1], b.z1 - mg[2])
    if (v.x1 - v.x0 < 1 || v.z1 - v.z0 < 1) return null
    levels.push({ voids: [v], bridges: [] })
  } else {
    // fortress: small look-down holes, staggered, never one shaft.
    const hole = (m, sx, sz) => {
      if (b.x1 - m - sx + 1 < b.x0 + m || b.z1 - m - sz + 1 < b.z0 + m) return null
      const x = d.range(b.x0 + m, b.x1 - m - sx + 1)
      const z = d.range(b.z0 + m, b.z1 - m - sz + 1)
      return R(x, z, x + sx - 1, z + sz - 1)
    }
    const h1 = hole(2, 2, 2)
    const h2 = d.int(2) ? hole(1, 2, 3) : hole(1, 3, 2)
    if (!h1 || !h2) return null
    levels.push({ voids: [h1], bridges: [] })
    if (L === 3) levels.push({ voids: [h2], bridges: [] })
    posts(grow(b, -2), 0.5)
  }
  for (const level of levels) {
    for (const v of level.voids) if (!voidOk(v)) return null
    for (const br of level.bridges) if (!bridgeOk(br)) return null
  }
  const kept = piers.filter((p) => !levels.some((l) => l.voids.some((v) => inRect(v, p.gx, p.gz))))
  return { levels, piers: kept }
}

// The hall's catalog plan (assembleCatalogDescriptor's `plan`), shifted by
// (dx, dz) cells.
export function hallPlan(hall, dx = 0, dz = 0) {
  return {
    label: LABELS[hall.type],
    bounds: shift(hall.bounds, dx, dz),
    levels: hall.levels.map((l) => ({ voids: l.voids.map((v) => shift(v, dx, dz)), bridges: l.bridges.map((v) => shift(v, dx, dz)) })),
    columns: [],
    piers: hall.piers.map((p) => ({ gx: p.gx + dx, gz: p.gz + dz })),
    core: null,
    links: 'auto',
    glazing: 'rail',
  }
}

// Hall placements (doc §12: a 6×6 to 10×10 play hall per 3–4 chunks, an
// 8×8-ish ball-pit hall): 'one' hall of 6–10 × 6–10 anywhere (50%), 'two'
// of 6–10 on either side of a chunk seam (28%), or one 'big' hall of 10–12
// (22%: a ball-pit hall or a food court). Every box (bounds ±1) stays inside cells 2..25, so
// the perimeter band of the module stays free for circulation; a tall hall's
// box never lies on a chunk line facing a chunk it does not own (the top
// deck is the hall's alone).
function placeHalls(d, forceTall) {
  const a = d.int(100)
  const specs = []
  const sizeIn = (lim, wr, dr) => {
    const w = d.range(wr[0], Math.min(wr[1], lim.x1 - lim.x0 - 1))
    const dd = d.range(dr[0], Math.min(dr[1], lim.z1 - lim.z0 - 1))
    const bx = d.range(lim.x0, lim.x1 - w - 1)
    const bz = d.range(lim.z0, lim.z1 - dd - 1)
    return R(bx + 1, bz + 1, bx + w, bz + dd)
  }
  if (a < 50) specs.push({ bounds: sizeIn(R(2, 2, 25, 25), [6, 10], [6, 10]), big: false })
  else if (a < 78) {
    const alongX = d.int(2) === 1
    const lims = alongX ? [R(2, 2, 13, 25), R(14, 2, 25, 25)] : [R(2, 2, 25, 13), R(2, 14, 25, 25)]
    for (const lim of lims) specs.push({ bounds: sizeIn(lim, [6, 10], [6, 10]), big: false })
  } else specs.push({ bounds: sizeIn(R(2, 2, 25, 25), [10, 12], [10, 12]), big: true })

  // The catalog engine keeps a footprint off a chunk's edge cells (local 0
  // and 13: its ring stays inside the participants), and its flights need
  // room inside one chunk: a box straddling a chunk seam keeps ≥ 10 cells on
  // one side or ≥ 6 on both, else it moves into one chunk (or along). A lone
  // box of 15+ cells on both axes leaving no 6-cell band beside it (the
  // deck's crawl block) is pushed flush to its farther side.
  for (const s of specs) {
    const b = s.bounds
    for (const ax of ['x', 'z']) {
      const k0 = ax + '0'
      const k1 = ax + '1'
      let box0 = b[k0] - 1
      let box1 = b[k1] + 1
      const size = box1 - box0 + 1
      if (box0 <= 13 && box1 >= 14) {
        const left = 14 - box0
        const right = box1 - 13
        if (!(Math.max(left, right) >= 10 || Math.min(left, right) >= 6)) {
          if (size <= 12) {
            if (left >= right) { box1 = 13; box0 = Math.max(2, box1 - size + 1) } else { box0 = 14; box1 = Math.min(25, box0 + size - 1) }
          } else if (left < right) { box0 = 4; box1 = box0 + size - 1 } else { box1 = 23; box0 = box1 - size + 1 }
        }
      }
      b[k0] = box0 + 1
      b[k1] = box1 - 1
      if (b[k0] % CHUNK === 0) b[k0]++
      if (b[k1] % CHUNK === CHUNK - 1) b[k1]--
    }
  }
  if (specs.length === 1) {
    const b = specs[0].bounds
    const gap = (lo, hi) => Math.max(lo - 1 - 2, 25 - (hi + 1))
    if (Math.max(gap(b.x0, b.x1), gap(b.z0, b.z1)) < 6) {
      const w = b.x1 - b.x0
      if (b.x0 - 3 > 24 - b.x1) { b.x0 = 3; b.x1 = 3 + w } else { b.x1 = 24; b.x0 = 24 - w }
      if (b.x0 % CHUNK === 0) b.x0++
      if (b.x1 % CHUNK === CHUNK - 1) b.x1--
    }
  }
  let tall = false
  const halls = []
  for (const s of specs) {
    const w = s.bounds.x1 - s.bounds.x0 + 1
    const dd = s.bounds.z1 - s.bounds.z0 + 1
    let type
    if (s.big) type = d.chance(0.6) ? 'pitHall' : 'court'
    else {
      const t = d.int(100)
      type = t < 50 ? 'frame' : t < 65 ? (w <= 9 && dd <= 9 ? 'fortress' : 'frame') : t < 83 ? 'pitHall' : 'court'
    }
    let L = type === 'fortress' ? 3 : type === 'frame' && d.chance(0.65) ? 3 : 2
    // A three-storey frame needs a 7-cell box for its well and rim.
    if (L === 3 && type === 'frame' && Math.min(w, dd) < 7) L = 2
    if (L === 3 && tall) {
      L = 2
      if (type === 'fortress') type = 'frame'
    }
    if (L === 3) tall = true
    halls.push({ type, L, bounds: s.bounds })
  }
  if (forceTall && !tall) {
    halls[0].type = halls[0].type === 'fortress' ? 'fortress' : 'frame'
    halls[0].L = 3
  }
  // A tall hall's box off the chunk lines it does not straddle.
  for (const h of halls) {
    if (h.L !== 3) continue
    const b = h.bounds
    if ((b.x0 - 1) % CHUNK === 0) b.x0++
    if ((b.x1 + 1) % CHUNK === CHUNK - 1) b.x1--
    if ((b.z0 - 1) % CHUNK === 0) b.z0++
    if ((b.z1 + 1) % CHUNK === CHUNK - 1) b.z1--
    if (b.x1 - b.x0 + 1 < 6 || b.z1 - b.z0 + 1 < 6) {
      h.L = 2
      if (h.type === 'fortress') h.type = 'frame'
    } else if (h.type === 'frame' && Math.min(b.x1 - b.x0, b.z1 - b.z0) + 1 < 7) h.L = 2
  }
  return halls
}

// The module's halls: shapes rolled until the catalog engine assembles them
// (auto flights in the solid bands, voids off the chunk seams), each the
// descriptor at TRUE GLOBAL coordinates. `metaOf(slot, hall)` gives the
// assembly meta; `ox`, `oz` the module's global cell origin.
const SHIFTS = Object.freeze([[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2]])
const overlaps = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1
function shiftedBounds(b, [dx, dz], others) {
  const r = shift(b, dx, dz)
  if (r.x0 < 3 || r.z0 < 3 || r.x1 > 24 || r.z1 > 24) return null
  if (r.x0 % CHUNK === 0 || r.z0 % CHUNK === 0 || r.x1 % CHUNK === CHUNK - 1 || r.z1 % CHUNK === CHUNK - 1) return null
  // Boxes keep a cell of corridor between them.
  if (others.some((o) => overlaps(grow(r, 2), grow(o.bounds, 1)))) return null
  return r
}

function buildHalls(planSeed, { forceTall, metaOf, ox, oz }) {
  const d = dice(planSeed, 0x4a11)
  const placed = placeHalls(d, forceTall)
  const out = []
  for (const [slot, h] of placed.entries()) {
    const sd = dice(planSeed, 0x5ab0 + slot)
    let hall = null
    // Shapes rolled 12 times; then the same bounds with no holes; then two
    // storeys with no holes; then (never seen past ~1 in 5000) two storeys
    // with no holes in the bounds moved 2 cells along each diagonal and axis
    // (the fallbacks the harness counts as none).
    for (let tryN = 0; tryN < 14 + SHIFTS.length && !hall; tryN++) {
      const fallback = tryN >= 12
      const L = tryN >= 13 ? 2 : h.L
      const type = tryN >= 13 && h.type === 'fortress' ? 'frame' : h.type
      const bounds = tryN >= 14 ? shiftedBounds(h.bounds, SHIFTS[tryN - 14], placed.filter((o) => o !== h)) : h.bounds
      if (!bounds) continue
      const shape = fallback
        ? { levels: Array.from({ length: L }, () => ({ voids: [], bridges: [] })), piers: [] }
        : hallShape(type, L, bounds, sd)
      if (!shape) continue
      const cand = { slot, type, L, bounds, box: grow(bounds, 1), levels: shape.levels, piers: shape.piers }
      const plan = hallPlan(cand, ox, oz)
      const meta = metaOf(slot, cand)
      for (let attempt = 0; attempt < PICK_ATTEMPTS; attempt++) {
        const desc = assembleCatalogDescriptor(plan, meta, planPick(planSeed, slot, attempt), null)
        if (desc) {
          hall = { ...cand, attempt, desc, fallback }
          break
        }
      }
    }
    if (hall) {
      hall.theme = PLAY_THEMES[sd.int(PLAY_THEMES.length)]
      hall.netSide = 'NESW'[sd.int(4)]
      // The hall's flight halos on each storey (module-local cells).
      hall.halos = hall.desc.verticalLinks.map((l) => ({ lowerCy: l.lowerCy - hall.desc.baseCy, rect: shift(linkHalo(l), -ox, -oz) }))
      out.push(hall)
    } else {
      out.push(null)
    }
  }
  return out
}

// --- storeys --------------------------------------------------------------------------

const DX = [0, 1, 0, -1]
const DZ = [-1, 0, 1, 0]

// Route scratch (reused: one route at a time, single-threaded): distances
// and back-pointers per (cell, arrival direction), stamped per call.
const STATES = N * N * 5
const rDist = new Int32Array(STATES)
const rPrev = new Int32Array(STATES)
const rStamp = new Int32Array(STATES)
let rGen = 0
const BUCKETS = 32 // > the largest step cost (cell cost + turn)
const rBuckets = Array.from({ length: BUCKETS }, () => [])

// Turn-penalised cheapest path from cell `start` to any cell with goal[i]
// set, entering cells at cost(i) (a small integer; Infinity: impassable),
// by Dial's bucket queue. Returns the cells from start to the goal, or null.
function route(start, goal, cost, turn) {
  rGen++
  for (const b of rBuckets) b.length = 0
  const s0 = start * 5 + 4
  rStamp[s0] = rGen
  rDist[s0] = 0
  rPrev[s0] = -1
  rBuckets[0].push(s0)
  let pending = 1
  let end = -1
  for (let dcur = 0; pending > 0 && end < 0; dcur++) {
    const bucket = rBuckets[dcur % BUCKETS]
    for (let q = 0; q < bucket.length; q++) {
      const st = bucket[q]
      pending--
      if (rDist[st] !== dcur) continue
      const i = (st / 5) | 0
      if (goal[i]) {
        end = st
        break
      }
      const dir = st % 5
      const x = i % N
      const z = (i - x) / N
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k]
        const nz = z + DZ[k]
        if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue
        const j = nz * N + nx
        const c = cost(j)
        if (!Number.isFinite(c)) continue
        const nd = dcur + c + (dir !== 4 && dir !== k ? turn : 0)
        const ns = j * 5 + k
        if (rStamp[ns] === rGen && rDist[ns] <= nd) continue
        rStamp[ns] = rGen
        rDist[ns] = nd
        rPrev[ns] = st
        rBuckets[nd % BUCKETS].push(ns)
        pending++
      }
    }
    bucket.length = 0
  }
  if (end < 0) return null
  const path = []
  for (let st = end; st >= 0; st = rPrev[st]) path.push((st / 5) | 0)
  return path.reverse()
}

// Box side cells: [inside cell, outside cell, edge] for every position along
// each side of box (no corners), side order N E S W.
function boxSides(box) {
  const out = [[], [], [], []]
  for (let gx = box.x0; gx <= box.x1; gx++) {
    out[0].push({ in: [gx, box.z0], out: [gx, box.z0 - 1], edge: { axis: 'h', gx, gz: box.z0 } })
    out[2].push({ in: [gx, box.z1], out: [gx, box.z1 + 1], edge: { axis: 'h', gx, gz: box.z1 + 1 } })
  }
  for (let gz = box.z0; gz <= box.z1; gz++) {
    out[1].push({ in: [box.x1, gz], out: [box.x1 + 1, gz], edge: { axis: 'v', gx: box.x1 + 1, gz } })
    out[3].push({ in: [box.x0, gz], out: [box.x0 - 1, gz], edge: { axis: 'v', gx: box.x0, gz } })
  }
  return out
}

// The crawl-tube block on the deck: a lattice of pods (nx × nz, three cells
// apart) inside padding mass, joined by a random spanning tree plus extra
// tubes (a crawl-only loop), with mouths on the block's edge and bubble-window
// nubs onto a hall it touches. Writes TUBE/POD/MASS into g; returns the
// block's description or null when nothing fits.
function tubeBlock(g, d, hallAt, onlySlot = null) {
  const sizes = onlySlot === null ? d.shuffle([[3, 3], [4, 2], [2, 3], [3, 2], [4, 3], [2, 2]]) : d.shuffle([[3, 2], [2, 3], [2, 2]])
  sizes.push([2, 2])
  const hallCell = (x, z) => g[I(x, z)] === HALL && (onlySlot === null || hallAt(x, z) === onlySlot)
  for (const [nx, nz] of sizes) {
    const bw = 3 * nx
    const bd = 3 * nz
    const fits = []
    for (let z0 = 2; z0 + bd - 1 <= 25; z0++) {
      for (let x0 = 2; x0 + bw - 1 <= 25; x0++) {
        let ok = true
        for (let z = z0; z < z0 + bd && ok; z++) for (let x = x0; x < x0 + bw; x++) if (g[I(x, z)] !== FREE) { ok = false; break }
        if (!ok) continue
        // Touching a hall: a block edge cell beside a hall box cell.
        let touch = 0
        for (let x = x0; x < x0 + bw; x++) {
          if (z0 > 0 && hallCell(x, z0 - 1)) touch++
          if (z0 + bd < N && hallCell(x, z0 + bd)) touch++
        }
        for (let z = z0; z < z0 + bd; z++) {
          if (x0 > 0 && hallCell(x0 - 1, z)) touch++
          if (x0 + bw < N && hallCell(x0 + bw, z)) touch++
        }
        fits.push({ x0, z0, touch })
      }
    }
    if (!fits.length) continue
    const touching = fits.filter((f) => f.touch >= 3)
    // A second block (onlySlot) always sits against its own hall.
    if (onlySlot !== null && !touching.length) continue
    const pool = onlySlot !== null || (touching.length && d.chance(0.8)) ? touching : fits
    const { x0, z0 } = pool[d.int(pool.length)]
    const blk = R(x0, z0, x0 + bw - 1, z0 + bd - 1)
    for (let z = blk.z0; z <= blk.z1; z++) for (let x = blk.x0; x <= blk.x1; x++) g[I(x, z)] = MASS
    const pod = (i, j) => [x0 + 1 + 3 * i, z0 + 1 + 3 * j]
    // Lattice edges, a random spanning tree (Kruskal on hashed weights) and
    // 1–2 extra tubes.
    const edges = []
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      if (i + 1 < nx) edges.push([i, j, i + 1, j])
      if (j + 1 < nz) edges.push([i, j, i, j + 1])
    }
    d.shuffle(edges)
    const parent = Array.from({ length: nx * nz }, (_, k) => k)
    const find = (k) => (parent[k] === k ? k : (parent[k] = find(parent[k])))
    const used = []
    const spare = []
    for (const e of edges) {
      const a = find(e[1] * nx + e[0])
      const b = find(e[3] * nx + e[2])
      if (a !== b) {
        parent[a] = b
        used.push(e)
      } else spare.push(e)
    }
    const extra = Math.min(spare.length, 1 + d.int(2))
    used.push(...spare.slice(0, extra))
    const cells = []
    const set = (x, z, code) => {
      g[I(x, z)] = code
      cells.push(I(x, z))
    }
    const degree = new Map()
    for (const [i, j, i2, j2] of used) {
      const [ax, az] = pod(i, j)
      const [bx, bz] = pod(i2, j2)
      for (let t = 1; t < 3; t++) set(ax + ((bx - ax) / 3) * t, az + ((bz - az) / 3) * t, TUBE)
      degree.set(j * nx + i, (degree.get(j * nx + i) ?? 0) + 1)
      degree.set(j2 * nx + i2, (degree.get(j2 * nx + i2) ?? 0) + 1)
    }
    const pods = []
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const [x, z] = pod(i, j)
      set(x, z, POD)
      pods.push({ gx: x, gz: z, degree: degree.get(j * nx + i) ?? 0, i, j })
    }
    // Mouths and nubs: from each outer pod, one cell out to the block edge.
    // Toward a hall the nub is a bubble window (or the mouth onto the deck);
    // toward free space it may be a mouth onto the mezzanine.
    const outs = []
    for (const p of pods) {
      for (let k = 0; k < 4; k++) {
        const ex = p.gx + DX[k]
        const ez = p.gz + DZ[k]
        if (inRect(blk, ex, ez) && (ex === blk.x0 || ex === blk.x1 || ez === blk.z0 || ez === blk.z1)) {
          const ox = ex + DX[k]
          const oz = ez + DZ[k]
          if (ox < 0 || oz < 0 || ox >= N || oz >= N) continue
          outs.push({ pod: p, edge: [ex, ez], out: [ox, oz], hall: g[I(ox, oz)] === HALL ? hallAt(ox, oz) : null, free: g[I(ox, oz)] === FREE })
        }
      }
    }
    d.shuffle(outs)
    const mouths = []
    const windows = []
    const hallOuts = outs.filter((o) => o.hall !== null)
    const freeOuts = outs.filter((o) => o.free)
    const takeMouth = (o) => {
      set(o.edge[0], o.edge[1], TUBE)
      mouths.push(o)
    }
    if (hallOuts.length) takeMouth(hallOuts[0])
    const wantFree = Math.max(1, (hallOuts.length ? 1 : 2) + d.int(2) - (hallOuts.length ? 0 : 0))
    const usedPods = new Set(mouths.map((m) => m.pod))
    for (const o of freeOuts) {
      if (mouths.length - (hallOuts.length ? 1 : 0) >= wantFree) break
      if (usedPods.has(o.pod)) continue
      usedPods.add(o.pod)
      takeMouth(o)
    }
    if (mouths.length < 2) {
      for (const o of [...hallOuts.slice(1), ...freeOuts]) {
        if (mouths.length >= 2) break
        if (mouths.includes(o) || g[I(o.edge[0], o.edge[1])] === TUBE) continue
        takeMouth(o)
      }
    }
    if (!mouths.length) {
      for (const p of pods) for (const [x, z] of [[p.gx, p.gz]]) g[I(x, z)] = MASS
      for (const c of cells) g[c] = MASS
      for (let z = blk.z0; z <= blk.z1; z++) for (let x = blk.x0; x <= blk.x1; x++) g[I(x, z)] = FREE
      continue
    }
    // Bubble windows: the other nubs facing a hall.
    for (const o of hallOuts) {
      if (mouths.includes(o) || windows.length >= 3) continue
      if (g[I(o.edge[0], o.edge[1])] !== MASS) continue
      set(o.edge[0], o.edge[1], TUBE)
      windows.push(o)
    }
    // The exit pod: the pod farthest (tube steps) from every mouth.
    const far = new Map()
    const queue = mouths.map((m) => I(m.edge[0], m.edge[1]))
    for (const q of queue) far.set(q, 0)
    for (let qi = 0; qi < queue.length; qi++) {
      const [x, z] = XZ(queue[qi])
      for (let k = 0; k < 4; k++) {
        const nx2 = x + DX[k]
        const nz2 = z + DZ[k]
        if (!inRect(blk, nx2, nz2)) continue
        const j = I(nx2, nz2)
        if ((g[j] !== TUBE && g[j] !== POD) || far.has(j)) continue
        far.set(j, far.get(queue[qi]) + 1)
        queue.push(j)
      }
    }
    let exitPod = pods[0]
    for (const p of pods) if ((far.get(I(p.gx, p.gz)) ?? -1) > (far.get(I(exitPod.gx, exitPod.gz)) ?? -1)) exitPod = p
    return {
      rect: blk, nx, nz, pods, mouths, windows, exitPod: { gx: exitPod.gx, gz: exitPod.gz }, tubes: used.length,
      loops: used.length - (nx * nz - 1),
    }
  }
  return null
}

const SUITE_DEPTH = 2 // en-suite rooms behind a corridor's room, at most
const ROLE_WEIGHTS = [3, 3, 3, 4, 5, 6, 7, 8] // rolled room sides (3 favoured: the party rooms)

// One storey of a module: cells, rooms, doors, windows, the tube block.
function storeyPlan(planSeed, cy, halls, portsCy) {
  const d = dice(planSeed, 0x5100 + cy)
  const g = new Uint8Array(N * N).fill(FREE)
  const hallIdx = new Int8Array(N * N).fill(-1)
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) if (x === LAST || z === LAST) g[I(x, z)] = MASS
  const here = halls.filter((h) => h && h.L > cy)
  for (const h of here) {
    for (let z = h.box.z0; z <= h.box.z1; z++) for (let x = h.box.x0; x <= h.box.x1; x++) {
      g[I(x, z)] = HALL
      hallIdx[I(x, z)] = h.slot
    }
  }
  const doors = new Map() // edgeKey → { axis, gx, gz, passage, kind }
  const windows = new Set()
  const terminals = []
  const portCells = []
  for (const [side, list] of Object.entries(portsCy ?? {})) {
    for (const { a0, a1 } of list) {
      for (let a = a0; a <= a1; a++) {
        const [x, z] = side === 'west' ? [0, a] : side === 'north' ? [a, 0] : side === 'east' ? [LAST, a] : [a, LAST]
        g[I(x, z)] = CORR
        terminals.push(I(x, z))
        portCells.push({ side, gx: x, gz: z })
      }
    }
  }
  // The deck's crawl-tube blocks: the first anywhere (it holds the exit
  // pod); with two halls on the deck, a second against the hall the first
  // does not reach (doc §4.4: a crawl-only loop per hall).
  const hallOfCell = (x, z) => hallIdx[I(x, z)]
  const tubes = cy === DECK ? tubeBlock(g, d, hallOfCell) : null
  const tubeBlocks = tubes ? [tubes] : []
  if (tubes && here.length === 2) {
    const reached = new Set([...tubes.mouths, ...tubes.windows].map((o) => o.hall).filter((x) => x !== null))
    const other = here.find((h) => !reached.has(h.slot))
    const second = other ? tubeBlock(g, dice(planSeed, 0x7b00), hallOfCell, other.slot) : null
    if (second) tubeBlocks.push(second)
  }
  for (const tb of tubeBlocks) {
    for (const m of tb.mouths) {
      const [ex, ez] = m.edge
      const [ox, oz] = m.out
      const e = edgeBetween(ex, ez, ox, oz)
      doors.set(edgeKey(e.axis, e.gx, e.gz), { ...e, passage: 'door', kind: 'mouth' })
      if (g[I(ox, oz)] === FREE) {
        g[I(ox, oz)] = CORR
        terminals.push(I(ox, oz))
      }
    }
    for (const w of tb.windows) {
      const e = edgeBetween(w.edge[0], w.edge[1], w.out[0], w.out[1])
      windows.add(edgeKey(e.axis, e.gx, e.gz))
    }
  }
  // Hall doors: the floor 2–3 (the first the main gate, two cells wide where
  // the side allows), the deck 1–2; never at a box corner, always onto free
  // floor.
  const gates = []
  for (const h of here) {
    if (cy >= 2) continue
    const sides = boxSides(h.box)
    const want = cy === FLOOR ? 2 + d.int(2) : 1 + d.int(2)
    const order = d.shuffle([0, 1, 2, 3])
    let made = 0
    for (let si = 0; si < order.length * 2 && made < want; si++) {
      const side = sides[order[si % 4]]
      const cand = side.filter((c, k) => k > 0 && k < side.length - 1 && g[I(...c.out)] === FREE)
      if (!cand.length) continue
      const c = cand[d.int(cand.length)]
      const wide = cy === FLOOR && made === 0
      const list = [c]
      if (wide) {
        const k = side.indexOf(c)
        const nb = side[k + 1]
        if (nb && k + 1 < side.length - 1 && g[I(...nb.out)] === FREE) list.push(nb)
      }
      for (const cc of list) {
        doors.set(edgeKey(cc.edge.axis, cc.edge.gx, cc.edge.gz), { ...cc.edge, passage: list.length > 1 ? 'wide' : 'door', kind: 'hall', slot: h.slot })
        g[I(...cc.out)] = CORR
        terminals.push(I(...cc.out))
      }
      if (made === 0) gates.push({ slot: h.slot, inside: c.in, outside: c.out, cells: list.map((cc) => ({ in: cc.in, out: cc.out })) })
      made++
    }
  }
  // A deck with fewer than two seam ports (about a tenth of them) would be a
  // stub off its hall doors: two or three hashed anchors in the free floor
  // pull the corridor tree (and the rooms it reaches) across it.
  const anchors = []
  if (cy === DECK && portCells.length < 2) {
    const want = 2 + d.int(2)
    for (let k = 0, made = 0; k < 40 && made < want; k++) {
      const x = d.range(3, 24)
      const z = d.range(3, 24)
      let free = true
      for (let zz = z - 1; zz <= z + 1 && free; zz++) for (let xx = x - 1; xx <= x + 1; xx++) if (g[I(xx, zz)] !== FREE) free = false
      if (!free || terminals.some((t) => { const [tx, tz] = XZ(t); return Math.abs(tx - x) + Math.abs(tz - z) < 8 })) continue
      g[I(x, z)] = CORR
      terminals.push(I(x, z))
      anchors.push(I(x, z))
      made++
    }
  }
  // On every deck, up to two more anchors in the free floor farthest (≥ 9
  // steps) from every terminal and hall box, so no quarter of the mezzanine
  // is left a blank block of padding.
  if (cy === DECK) {
    for (let k = 0; k < 2; k++) {
      const far = (x, z) => {
        let m = Infinity
        for (const t of terminals) {
          const [tx, tz] = XZ(t)
          m = Math.min(m, Math.abs(tx - x) + Math.abs(tz - z))
        }
        for (const h of here) {
          const dx = Math.max(h.box.x0 - x, 0, x - h.box.x1)
          const dz = Math.max(h.box.z0 - z, 0, z - h.box.z1)
          m = Math.min(m, dx + dz)
        }
        return m
      }
      let best = -1
      let bestD = 8
      const jx = d.int(3)
      const jz = d.int(3)
      for (let z = 3 + jz; z <= 24; z += 3) {
        for (let x = 3 + jx; x <= 24; x += 3) {
          let free = true
          for (let zz = z - 1; zz <= z + 1 && free; zz++) for (let xx = x - 1; xx <= x + 1; xx++) if (g[I(xx, zz)] !== FREE) free = false
          if (!free) continue
          const dd = far(x, z)
          if (dd > bestD) {
            bestD = dd
            best = I(x, z)
          }
        }
      }
      if (best < 0) break
      g[best] = CORR
      terminals.push(best)
      anchors.push(best)
    }
  }
  // Corridors: every terminal routed into one tree.
  const noise = new Uint8Array(N * N)
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    noise[I(x, z)] = (hash3i((planSeed ^ 0x6e01) | 0, x >> 2, z >> 2, cy) >>> 0) % 4 + ((hash3i((planSeed ^ 0x6e02) | 0, x, z, cy) >>> 0) % 2)
  }
  const tree = new Uint8Array(N * N)
  const order = terminals.slice()
  d.shuffle(order)
  // The tree grows from a port, door or mouth, never from an anchor.
  const root = order.findIndex((i) => !anchors.includes(i))
  if (root > 0) [order[0], order[root]] = [order[root], order[0]]
  let corridorCells = 0
  if (order.length) tree[order[0]] = 1
  const reuse = (i) => (g[i] === CORR ? 1 : g[i] === FREE ? 3 + noise[i] : Infinity)
  for (const t of order.slice(1)) {
    if (tree[t]) continue
    const path = route(t, tree, reuse, 4)
    if (!path) continue
    for (const i of path) {
      if (g[i] === FREE) corridorCells++
      g[i] = CORR
      tree[i] = 1
    }
  }
  // An anchor the tree could not reach goes back to the free floor.
  for (const i of anchors) if (!tree[i] && g[i] === CORR) g[i] = FREE
  // Loops: 1–3 extra corridors between distant parts of the tree.
  const loops = []
  const treeCells = () => {
    const out = []
    for (let i = 0; i < N * N; i++) if (tree[i] && g[i] === CORR) out.push(i)
    return out
  }
  const want = 1 + d.int(3)
  // Ten picks for the wanted loops; past them (a crowded storey), up to
  // twenty more with a shorter span until the storey has its first loop.
  for (let tries = 0; tries < 30 && loops.length < want && (tries < 10 || !loops.length); tries++) {
    const cells = treeCells()
    if (cells.length < 2) break
    const a = cells[d.int(cells.length)]
    const b = cells[d.int(cells.length)]
    const [ax, az] = XZ(a)
    const [bx, bz] = XZ(b)
    const man = Math.abs(ax - bx) + Math.abs(az - bz)
    if (man < (tries < 10 ? 9 : 6)) continue
    const goal = new Uint8Array(N * N)
    goal[b] = 1
    const path = route(a, goal, (i) => (g[i] === CORR ? 6 : g[i] === FREE ? 2 + noise[i] : Infinity), 3)
    if (!path) continue
    const fresh = path.filter((i) => g[i] === FREE).length
    if (fresh < 3 || path.length > man * 2.2) continue
    for (const i of path) {
      g[i] = CORR
      tree[i] = 1
    }
    corridorCells += fresh
    loops.push({ a, b, fresh })
  }
  // Widened runs: up to two straight corridor runs of ≥ 6 cells get a
  // parallel lane where the floor is free (a 2-wide trunk).
  const widen = d.int(3)
  for (let n = 0; n < widen; n++) {
    const alongX = d.int(2) === 1
    const runs = []
    for (let a = 1; a < LAST - 1; a++) {
      let start = -1
      for (let b = 0; b <= N; b++) {
        const i = b < N ? (alongX ? I(b, a) : I(a, b)) : -1
        const on = i >= 0 && g[i] === CORR
        if (on && start < 0) start = b
        if (!on && start >= 0) {
          if (b - start >= 6) runs.push({ a, b0: start, b1: b - 1 })
          start = -1
        }
      }
    }
    if (!runs.length) continue
    const run = runs[d.int(runs.length)]
    const side = d.int(2) ? 1 : -1
    const lane = run.a + side
    if (lane < 1 || lane >= LAST - 1) continue
    for (let b = run.b0; b <= run.b1; b++) {
      const i = alongX ? I(b, lane) : I(lane, b)
      if (g[i] === FREE) {
        g[i] = CORR
        corridorCells++
      }
    }
  }
  // Padding: hashed stretches (2–7 cells, about half of each side) of the
  // module's outer band that no corridor took are thick mass between the
  // blocks, one or two cells deep, so the seam lines do not carry the same
  // walls everywhere.
  const band = [
    (t, k) => [k, t], (t, k) => [t, k], (t, k) => [LAST - 1 - k, t], (t, k) => [t, LAST - 1 - k],
  ]
  for (const at of band) {
    let on = d.int(2) === 1
    for (let t = 0; t < N;) {
      const len = d.range(2, 7)
      const depth = d.range(1, 2)
      for (let k = 0; k < len && t + k < N; k++) {
        for (let q = 0; q < depth && on; q++) {
          const [x, z] = at(t + k, q)
          if (g[I(x, z)] !== FREE) break
          g[I(x, z)] = MASS
        }
      }
      t += len
      on = !on
    }
  }
  // Rooms: greedy hashed rectangles over the free cells, grown from a hashed
  // corner of the module in a hashed scan order (rows or columns), so room
  // lines never fall on the same grid from module to module.
  const roomOf = new Int16Array(N * N).fill(-1)
  const rects = []
  const flipX = d.int(2) === 1
  const flipZ = d.int(2) === 1
  const cols = d.int(2) === 1
  // Scan coordinates (u, v) → cell (x, z): u runs fastest.
  const cellOf = (u, v) => {
    let x = cols ? v : u
    let z = cols ? u : v
    if (flipX) x = LAST - x
    if (flipZ) z = LAST - z
    return [x, z]
  }
  const sx = flipX ? -1 : 1
  const sz = flipZ ? -1 : 1
  for (let v = 0; v < N; v++) {
    for (let u = 0; u < N; u++) {
      const [x, z] = cellOf(u, v)
      if (g[I(x, z)] !== FREE || roomOf[I(x, z)] >= 0) continue
      const free = (xx, zz) => xx >= 0 && zz >= 0 && xx < N && zz < N && g[I(xx, zz)] === FREE && roomOf[I(xx, zz)] < 0
      const tw = ROLE_WEIGHTS[d.int(ROLE_WEIGHTS.length)]
      const td = ROLE_WEIGHTS[d.int(ROLE_WEIGHTS.length)]
      let w = 1
      while (w < tw && free(x + sx * w, z)) w++
      let dd = 1
      for (; dd < td; dd++) {
        let ok = true
        for (let k = 0; k < w; k++) if (!free(x + sx * k, z + sz * dd)) { ok = false; break }
        if (!ok) break
      }
      const xa = x + sx * (w - 1)
      const za = z + sz * (dd - 1)
      const r = R(Math.min(x, xa), Math.min(z, za), Math.max(x, xa), Math.max(z, za))
      const id = rects.length
      rects.push(r)
      for (let zz = r.z0; zz <= r.z1; zz++) for (let xx = r.x0; xx <= r.x1; xx++) roomOf[I(xx, zz)] = id
    }
  }
  // Slivers (1-wide rects): a lone cell or a pair beside a corridor joins
  // the corridor (a nook); anything else is padding (a 1-wide closet would
  // be one more unlit dead room).
  const nextTo = (r, code) => {
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) {
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k]
        const nz = z + DZ[k]
        if (nx >= 0 && nz >= 0 && nx < N && nz < N && !inRect(r, nx, nz) && g[I(nx, nz)] === code) return true
      }
    }
    return false
  }
  const rooms = []
  for (const [id, r] of rects.entries()) {
    const w = r.x1 - r.x0 + 1
    const dd = r.z1 - r.z0 + 1
    const area = w * dd
    if (w >= 2 && dd >= 2) {
      rooms.push({ rect: r, id })
      continue
    }
    const code = nextTo(r, CORR) && area <= 2 ? CORR : MASS
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) {
      g[I(x, z)] = code
      roomOf[I(x, z)] = -1
    }
  }
  // Doors: rooms reached from a corridor first, then from a room already
  // reached (en suite, at most SUITE_DEPTH rooms deep), in hashed order; a
  // room nothing reaches is padding (solid mass).
  const reached = new Set()
  const depth = new Map() // room id → rooms crossed from its corridor
  const byId = new Map(rooms.map((rm) => [rm.id, rm]))
  const pending = d.shuffle(rooms.slice())
  for (let pass = 0; pass < 8 && pending.length; pass++) {
    for (let k = 0; k < pending.length; k++) {
      const rm = pending[k]
      const r = rm.rect
      const corr = []
      const via = []
      for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) {
        for (let q = 0; q < 4; q++) {
          const nx = x + DX[q]
          const nz = z + DZ[q]
          if (nx < 0 || nz < 0 || nx >= N || nz >= N || inRect(r, nx, nz)) continue
          const j = I(nx, nz)
          if (g[j] === CORR) corr.push([x, z, nx, nz])
          else if (g[j] === FREE && reached.has(roomOf[j]) && depth.get(roomOf[j]) < SUITE_DEPTH) via.push([x, z, nx, nz, roomOf[j]])
        }
      }
      const list = corr.length ? corr : via
      if (!list.length) continue
      const [x, z, nx, nz, parent] = list[d.int(list.length)]
      const e = edgeBetween(x, z, nx, nz)
      rm.door = e
      rm.parent = corr.length ? -1 : parent
      depth.set(rm.id, corr.length ? 0 : depth.get(parent) + 1)
      rm.inside = [x, z]
      rm.outside = [nx, nz]
      reached.add(rm.id)
      pending.splice(k, 1)
      k--
    }
  }
  for (const rm of pending) {
    const r = rm.rect
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) {
      g[I(x, z)] = MASS
      roomOf[I(x, z)] = -1
    }
  }
  const live = rooms.filter((rm) => reached.has(rm.id))
  for (const rm of live) for (let z = rm.rect.z0; z <= rm.rect.z1; z++) for (let x = rm.rect.x0; x <= rm.rect.x1; x++) g[I(x, z)] = ROOM
  // Parent-first order (a child's door is cut after its parent's walls).
  const ordered = []
  const done = new Set()
  const visit = (rm) => {
    if (done.has(rm.id)) return
    if (rm.parent >= 0 && byId.has(rm.parent)) visit(byId.get(rm.parent))
    done.add(rm.id)
    ordered.push(rm)
  }
  for (const rm of live) visit(rm)
  assignRoles(ordered, cy, d)
  // Renumber rooms 1.. in order; roomOf → that number.
  const roomNo = new Int16Array(N * N)
  const childDoors = new Map()
  for (const [k, rm] of ordered.entries()) {
    rm.no = k + 1
    for (let z = rm.rect.z0; z <= rm.rect.z1; z++) for (let x = rm.rect.x0; x <= rm.rect.x1; x++) roomNo[I(x, z)] = rm.no
  }
  for (const rm of ordered) {
    if (rm.parent < 0) continue
    const p = byId.get(rm.parent)
    if (!childDoors.has(p.no)) childDoors.set(p.no, [])
    childDoors.get(p.no).push(rm.outside)
  }
  const out = ordered.map((rm) => Object.freeze({
    no: rm.no,
    x0: rm.rect.x0, z0: rm.rect.z0, x1: rm.rect.x1, z1: rm.rect.z1,
    role: rm.role,
    door: Object.freeze({ axis: rm.door.axis, gx: rm.door.gx, gz: rm.door.gz }),
    inside: Object.freeze(rm.inside),
    parent: rm.parent >= 0 ? byId.get(rm.parent).no : 0,
    // cells of this room that are the inside of a child room's door
    childDoors: Object.freeze((childDoors.get(rm.no) ?? []).map((c) => Object.freeze(c))),
  }))
  const count = (code) => g.reduce((n, c) => n + (c === code ? 1 : 0), 0)
  return {
    cy,
    cells: g,
    roomNo,
    hallIdx,
    rooms: out,
    doors,
    windows,
    tubes,
    tubeBlocks,
    gates,
    ports: portCells,
    stats: { corridor: count(CORR), rooms: out.length, loops: loops.length, mass: count(MASS), corridorCells },
  }
}

// Room types by size (doc §4.3): one arcade (3×4-ish) and one lounge/café
// (the largest), toilets and a staff room among the small ones, every 3×3
// room a party room (identical rooms, the liminal repetition), the rest
// store rooms.
function assignRoles(rooms, cy, d) {
  const dims = (rm) => [rm.rect.x1 - rm.rect.x0 + 1, rm.rect.z1 - rm.rect.z0 + 1]
  const area = (rm) => dims(rm)[0] * dims(rm)[1]
  const minDim = (rm) => Math.min(...dims(rm))
  for (const rm of rooms) rm.role = null
  const free = () => rooms.filter((rm) => !rm.role)
  const take = (pred, score, role) => {
    const c = free().filter(pred)
    if (!c.length) return null
    c.sort((a, b) => score(a) - score(b) || a.id - b.id)
    c[0].role = role
    return c[0]
  }
  if (cy === FLOOR) take((rm) => minDim(rm) >= 3 && area(rm) >= 9, (rm) => Math.abs(area(rm) - 15) * 4 + d.int(4), 'arcade')
  take((rm) => minDim(rm) >= 3 && area(rm) >= 12, (rm) => -area(rm), cy === FLOOR ? 'lounge' : 'cafe')
  take((rm) => area(rm) >= 4 && area(rm) <= 9, (rm) => area(rm) + d.int(3), 'toilets')
  take((rm) => area(rm) >= 4 && area(rm) <= 12, () => d.int(16), 'staff')
  for (const rm of free()) {
    const [w, dd] = dims(rm)
    rm.role = w === 3 && dd === 3 ? 'party' : 'store'
  }
}

// --- the module ---------------------------------------------------------------------

const memo = new Map()
const MEMO_MAX = 256
function cached(key, make) {
  let v = memo.get(key)
  if (v) {
    memo.delete(key)
    memo.set(key, v)
    return v
  }
  v = make()
  memo.set(key, v)
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value)
  return v
}

// The module key (band 0) of module (tx, tz) and its planSeed.
export const bandKey = (tx, tz) => tileKeyAt(TILE, tx, tz, 0)
export const planSeedOf = (worldSeed, k) => tileSeed(worldSeed >>> 0, TILE.salt, k)

const sizeClassOf = (h) => {
  const a = (h.bounds.x1 - h.bounds.x0 + 1) * (h.bounds.z1 - h.bounds.z0 + 1)
  return a <= 64 ? 'small' : a <= 160 ? 'medium' : 'large'
}

// The halls of module (tx, tz): pure in (worldSeed, tx, tz), descriptors at
// true global coordinates (what the planner returns).
export function hallsOf(worldSeed, tx, tz) {
  const seed = worldSeed >>> 0
  return cached(`h|${seed}|${tx},${tz}`, () => {
    const k = bandKey(tx, tz)
    const planSeed = planSeedOf(seed, k)
    const metaOf = (slot, h) => ({
      id: structureId(seed, FAMILY, k, slot),
      family: FAMILY,
      type: h.type === 'court' ? 'foodCourt' : 'playHall',
      sizeClass: sizeClassOf(h),
      district: { x: k.tx, z: k.tz, size: TILE.w },
      bandIndex: k.band,
      slot,
      baseCy: k.origin.cy + FLOOR,
    })
    return Object.freeze(buildHalls(planSeed, { forceTall: false, metaOf, ox: k.origin.cx * CHUNK, oz: k.origin.cz * CHUNK }))
  })
}

// The kind lab's finite meta (family 'office', fixed ids per slot).
export const KIND_HALL_ID = 0x0aa10001
export const kindMetaOf = (slot, h) => ({
  id: KIND_HALL_ID + slot,
  family: 'office',
  type: h.type === 'court' ? 'foodCourt' : 'playHall',
  sizeClass: sizeClassOf(h),
  district: { x: 0, z: 0, size: 4 },
  bandIndex: 0,
  slot,
  baseCy: FLOOR,
})

function composeModule(planSeed, halls, portsByCy) {
  const floor = storeyPlan(planSeed, FLOOR, halls, portsByCy[FLOOR])
  const deck = storeyPlan(planSeed, DECK, halls, portsByCy[DECK])
  const tall = halls.find((h) => h && h.L === 3) ?? null
  const top = tall ? topPlan(tall) : null
  return Object.freeze({ planSeed, halls, storeys: Object.freeze([floor, deck, top]), tall })
}

// The top deck: the tall hall's box alone.
function topPlan(h) {
  const g = new Uint8Array(N * N)
  const hallIdx = new Int8Array(N * N).fill(-1)
  for (let z = h.box.z0; z <= h.box.z1; z++) for (let x = h.box.x0; x <= h.box.x1; x++) {
    g[I(x, z)] = HALL
    hallIdx[I(x, z)] = h.slot
  }
  return { cy: TOP, cells: g, roomNo: new Int16Array(N * N), hallIdx, rooms: [], doors: new Map(), windows: new Set(), tubes: null, tubeBlocks: [], gates: [], ports: [], stats: {} }
}

// The whole module (tx, tz): halls, floor, deck and top deck plans.
export function moduleLayout(worldSeed, tx, tz) {
  const seed = worldSeed >>> 0
  return cached(`m|${seed}|${tx},${tz}`, () => {
    const k = bandKey(tx, tz)
    return composeModule(planSeedOf(seed, k), hallsOf(seed, tx, tz), portsOfModule(seed, tx, tz))
  })
}

// The editor kind's sample: one module from the kind seed, no seams, always
// three storeys (a tall hall), family 'office'.
// A draw whose tall hall fell back to two storeys is redrawn from the next
// planSeed (pure in the seed; never more than a few redraws).
export function kindLayout(seed) {
  return cached(`k|${seed >>> 0}`, () => {
    const none = { west: [], north: [], east: [], south: [] }
    let lay = null
    for (let i = 0; i < 16; i++) {
      const planSeed = hash3i((seed ^ SALT) | 0, 0x6b1d, i, 0x51) >>> 0
      const halls = Object.freeze(buildHalls(planSeed, { forceTall: true, metaOf: kindMetaOf, ox: 0, oz: 0 }))
      lay = composeModule(planSeed, halls, [none, none])
      if (lay.tall) break
    }
    return lay
  })
}

// Cell code of storey plan `st` at module-local (gx, gz) (MASS outside).
export const codeAt = (st, gx, gz) => (gx < 0 || gz < 0 || gx >= N || gz >= N ? MASS : st.cells[I(gx, gz)])

// The edge between two walkable cells of storey plan `st`: 'open', 'wall',
// 'window', or a door { passage: 'door' | 'wide' }.
export function edgeRule(st, ax, az, bx, bz) {
  const e = edgeBetween(ax, az, bx, bz)
  const key = edgeKey(e.axis, e.gx, e.gz)
  const door = st.doors.get(key)
  if (door) return door
  if (st.windows.has(key)) return 'window'
  const a = codeAt(st, ax, az)
  const b = codeAt(st, bx, bz)
  if (a === CORR && b === CORR) return 'open'
  if ((a === TUBE || a === POD) && (b === TUBE || b === POD)) return 'open'
  if (a === HALL && b === HALL && st.hallIdx[I(ax, az)] === st.hallIdx[I(bx, bz)]) return 'open'
  if (a === ROOM && b === ROOM && st.roomNo[I(ax, az)] === st.roomNo[I(bx, bz)]) return 'open'
  return 'wall'
}

// --- footprint ------------------------------------------------------------------------

// §6.5 footprint: the floor and the deck are all four chunks of every module;
// the top deck is the chunks of the module's tall hall (its participants).
// Everything else is solid mass, never baked.
export function footprint(worldSeed, cx, cy, cz) {
  const k = tileKeyOf(TILE, cx, cy, cz)
  if (!k) return 'solid'
  if (cy === FLOOR || cy === DECK) return 'tile'
  const tall = hallsOf(worldSeed, k.tx, k.tz).find((h) => h && h.L === 3)
  if (!tall) return 'solid'
  return tall.desc.participants.some((p) => p.cx === cx && p.cz === cz) ? 'tile' : 'solid'
}

// --- spawn, exit, anomalies --------------------------------------------------------

// The anchor ring: the 40 modules at Chebyshev distance 2 or 3 from module
// (0,0), ring 2 first, each ring in scan order.
const RING23 = Object.freeze((() => {
  const out = []
  for (const ring of [2, 3]) {
    for (let tz = -ring; tz <= ring; tz++) {
      for (let tx = -ring; tx <= ring; tx++) if (Math.max(Math.abs(tx), Math.abs(tz)) === ring) out.push(Object.freeze({ tx, tz }))
    }
  }
  return out
})())

// The exit's anchor module: one of the 40 modules at Chebyshev distance 2–3.
export function exitTileOf(worldSeed) {
  return RING23[hashChain(((worldSeed >>> 0) ^ TILE.salt) | 0, 0x0e, 0x17) % RING23.length]
}

// The deterministic fallback modules of the exit hook: the rest of the ring.
export function exitFallbackTiles(worldSeed) {
  const first = RING23.indexOf(exitTileOf(worldSeed))
  const out = []
  for (let i = 1; i < RING23.length; i++) out.push(RING23[(first + i) % RING23.length])
  return out
}

// The exit pod of a module layout (module-local, deck storey): the crawl
// block's pod farthest from its mouths, or (no block: never seen) the first
// deck corridor cell.
export function exitPodOfLayout(lay) {
  const t = lay.storeys[DECK].tubes
  if (t) return { gx: t.exitPod.gx, gz: t.exitPod.gz, cy: DECK }
  const g = lay.storeys[DECK].cells
  for (let i = 0; i < N * N; i++) if (g[i] === CORR) return { gx: i % N, gz: (i - (i % N)) / N, cy: DECK }
  return { gx: 1, gz: 1, cy: DECK }
}

// §8.2 exit anchor: the exit pod on the deck (cy 1) of module (tx, tz).
export function exitAnchorOfTile(worldSeed, tx, tz) {
  const k = bandKey(tx, tz)
  const c = exitPodOfLayout(moduleLayout(worldSeed, tx, tz))
  const gx = k.origin.cx * CHUNK + c.gx
  const gz = k.origin.cz * CHUNK + c.gz
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { cx, cy: k.origin.cy + c.cy, cz, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}

export function exitAnchor(worldSeed) {
  const t = exitTileOf(worldSeed >>> 0)
  return exitAnchorOfTile(worldSeed >>> 0, t.tx, t.tz)
}

// The spawn candidates (module-local = global for module (0,0)), floor, in
// tiers, nearest the main gate first within each:
//   1. the first hall's floor just inside its main gate (≤ 6 steps), off the
//      pit and its rails, the frame posts and the flights' halos;
//   2. the rest of that hall's floor on the same terms (a ball-pit hall or a
//      wide well can leave nothing within 6 steps of the gate);
//   3. that hall's floor beside the pit rails (never in the pit);
//   4. the module's floor corridors and rooms, off the chunk-edge cells
//      (spawnCellOk counts its ring inside one chunk);
//   5. the corridor cell outside the gate (the last resort).
// The hook (hooks.js) takes the first candidate that is walkable and passes
// spawnCellOk in the baked chunk.
const SPAWN_TIER_CAP = 8
export function spawnCellsOfLayout(lay) {
  const st = lay.storeys[FLOOR]
  const gate = st.gates[0]
  const h = gate ? lay.halls[gate.slot] : lay.halls.find(Boolean)
  if (!h) return []
  const [gx0, gz0] = gate ? gate.inside : [h.bounds.x0, h.bounds.z0]
  const upper = h.levels.slice(1).flatMap((l) => l.voids)
  const offPosts = (x, z) => !h.piers.some((p) => Math.abs(p.gx - x) <= 1 && Math.abs(p.gz - z) <= 1) &&
    !h.halos.some((hh) => hh.lowerCy === 0 && inRect(grow(hh.rect, 1), x, z))
  const inPit = (x, z) => upper.some((v) => inRect(v, x, z))
  const byRail = (x, z) => upper.some((v) => inRect(grow(v, 1), x, z))
  const edge = (g) => g % CHUNK === 0 || g % CHUNK === CHUNK - 1
  const dist = (x, z) => Math.abs(x - gx0) + Math.abs(z - gz0)
  const tiers = [[], [], [], []]
  for (let z = h.bounds.z0; z <= h.bounds.z1; z++) {
    for (let x = h.bounds.x0; x <= h.bounds.x1; x++) {
      const dd = dist(x, z)
      if (dd < 1 || !offPosts(x, z) || inPit(x, z)) continue
      if (byRail(x, z)) tiers[2].push({ gx: x, gz: z, dd })
      else tiers[dd <= 6 ? 0 : 1].push({ gx: x, gz: z, dd })
    }
  }
  const g = st.cells
  for (let z = 1; z < N - 1; z++) {
    for (let x = 1; x < N - 1; x++) {
      const c = g[I(x, z)]
      if ((c !== CORR && c !== ROOM) || edge(x) || edge(z)) continue
      tiers[3].push({ gx: x, gz: z, dd: dist(x, z) })
    }
  }
  const out = []
  for (const t of tiers) {
    t.sort((a, b) => a.dd - b.dd || a.gz - b.gz || a.gx - b.gx)
    for (const { gx, gz } of t.slice(0, SPAWN_TIER_CAP)) out.push(Object.freeze({ gx, gz }))
  }
  if (gate) out.push(Object.freeze({ gx: gate.outside[0], gz: gate.outside[1] }))
  return out
}

export function spawnCells(worldSeed) {
  return spawnCellsOfLayout(moduleLayout(worldSeed >>> 0, 0, 0))
}

// Per-module anomaly (§12.0; doc 14: playplace 1 per hall; doc §10). Every
// module draws one, hashed (mirror-free) from the world seed and its module:
//   raw     a preferred class and a priority; never on module (0,0) or its
//           eight neighbours (spawn storey ±1 near spawn), never the anchor
//           module (the exit's module and the proof route's only climb);
//   rotate  greedy in priority order: a module takes its preferred class
//           unless an edge neighbour of higher priority holds it, else the
//           next free class, else none. No two edge-adjacent modules share a
//           class. The recursion only climbs strictly rising priorities, so
//           the result is pure and order-independent.
//   'redPit'  §10.1: the balls in the first hall's pit are all red (red lamp);
//   'mascot'  §10.10: the mascot cut-out has moved from the main gate up to
//             the highest deck of the module;
//   'arcade'  §10.7: every arcade cabinet stands out of its row and faces the
//             door, in sync.
// None of them touches a wall, a flight or a tube: never the only route.
export const ANOMALY_CLASSES = Object.freeze(['redPit', 'mascot', 'arcade'])
const EDGE_NEIGHBOURS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]])

function rawAnomaly(worldSeed, tx, tz, ex) {
  if (Math.max(Math.abs(tx), Math.abs(tz)) <= 1) return null
  if (ex.tx === tx && ex.tz === tz) return null
  const h = hashChain((worldSeed ^ TILE.salt ^ 0x0a40a1) | 0, tx, tz, 0x3a)
  return { cls: h % ANOMALY_CLASSES.length, pri: Math.floor(h / ANOMALY_CLASSES.length), tx, tz }
}

const outranks = (a, b) => a.pri > b.pri || (a.pri === b.pri && (a.tx > b.tx || (a.tx === b.tx && a.tz > b.tz)))

function finalClass(worldSeed, me, ex, memoA) {
  const key = `${me.tx},${me.tz}`
  const hit = memoA.get(key)
  if (hit !== undefined) return hit
  const taken = new Array(ANOMALY_CLASSES.length).fill(false)
  for (const [dx, dz] of EDGE_NEIGHBOURS) {
    const n = rawAnomaly(worldSeed, me.tx + dx, me.tz + dz, ex)
    if (!n || !outranks(n, me)) continue
    const c = finalClass(worldSeed, n, ex, memoA)
    if (c >= 0) taken[c] = true
  }
  let out = -1
  for (let i = 0; i < ANOMALY_CLASSES.length; i++) {
    const c = (me.cls + i) % ANOMALY_CLASSES.length
    if (!taken[c]) {
      out = c
      break
    }
  }
  memoA.set(key, out)
  return out
}

export function anomalyAt(worldSeed, k) {
  const seed = worldSeed >>> 0
  const ex = exitTileOf(seed)
  const me = rawAnomaly(seed, k.tx, k.tz, ex)
  if (!me) return null
  const c = finalClass(seed, me, ex, new Map())
  return c < 0 ? null : ANOMALY_CLASSES[c]
}
