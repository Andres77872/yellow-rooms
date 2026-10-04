import { CHUNK } from '../../constants.js'
import { hash2i, hash3i } from '../../core/hash.js'
import { assembleCatalogDescriptor, linkHalo } from '../../structures/catalog/engine.js'
import { MAP_FAMILY_POOLROOMS } from '../ids.js'
import { FAMILY_SALT, planPick, tileKeyAt, tileKeyOf, tileSeed } from '../../tiles/tileKey.js'

// The poolrooms family's pure geometry (spec §3.3, §12.4): the tile, its
// footprint and hashed seam ports, the POOL VOLUME GRAMMAR (which basins a
// tile holds, how big, which way they lie and where), the per-tile anomaly
// and the exit anchor. Everything here is a pure function of (worldSeed,
// global coordinates) or of a tile's planSeed (tileSeed of attempt 0), so the
// planner (structures.js), the deck/basin grammar (grammar.js) and the tile
// program (tile.js) agree on every volume.
//
// Planner-chain module (§7.5): it may import only constants.js, core/hash.js,
// core/rng.js, mapTypes.js, mapFamily.js ({deepFreeze, MAP_FAMILY_CODES}),
// structures/catalog/engine.js, families/ids.js, tiles/tileKey.js and
// tiles/stubPlanner.js. Never tiles/stub.js, the canvas or the kit.
//
// Kind-local frame: storeys 0 basin, 1 deck, 2 gallery; cells x, z 0..41 (a
// 3×3-chunk tile). The world tile is 3×3 chunks × storeys −1..1 (origin.cy =
// −1), so kind storey n is global storey n − 1 and kind cell (gx, gz) of tile
// (tx, tz) is global (tx·42 + gx, tz·42 + gz).
//
// No tile is a copy of another. Per tile the planSeed rolls a PROGRAM (a
// natatio vault with p ≈ 0.55, 0–2 lap halls, always one pit room, a stepped
// plunge basin with p ≈ 0.45), and each basin's pool size, lie (along x or
// z), deep end, deck margins and position are rolled anywhere in the tile
// subject to the catalog's rules (participant chunks ≤ 2×2 and disjoint, ring
// inside them, voids off the seams, a stair flight that fits) and to the
// deck grammar's (boxes 2 cells off the tile edge and from each other, and
// guillotine-separable so grammar.js can always run a channel between them).
// Every accepted volume is assembled here once with the planner's own first
// pick, so the planner never meets a null slot.

export const FAMILY = MAP_FAMILY_POOLROOMS

// The kind's dice salt (rng(seed, SALT) in tile.js).
export const SALT = 0x01a1

// Kind-local storeys.
export const BASIN = 0
export const DECK = 1
export const GALLERY = 2

// The tile (§6.2): 3×3 chunks, backend 'band', one band of three storeys
// (−1 basin, 0 deck, +1 gallery). Salt = FAMILY_SALT.poolrooms (0x5a170000 + 8).
export const TILE = Object.freeze({ w: 3, d: 3, backend: 'band', H: 3, lo: -1, hi: 1, salt: FAMILY_SALT.poolrooms })
export const TILE_CELLS = TILE.w * CHUNK // 42 cells per tile side
export const LAST = TILE_CELLS - 1 // 41: the east column / south row, mass but for ports

// §7.2: the planner's attempt budget per volume (attempt 0 is proven here).
export const PICK_ATTEMPTS = 4

export const R = (x0, z0, x1, z1) => ({ x0, z0, x1, z1 })
export const grow = (r, n) => R(r.x0 - n, r.z0 - n, r.x1 + n, r.z1 + n)
export const inRect = (r, gx, gz) => gx >= r.x0 && gx <= r.x1 && gz >= r.z0 && gz <= r.z1
const overlaps = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1
const local = (g) => ((g % CHUNK) + CHUNK) % CHUNK

// The kind's dice, index-keyed: roll(seed, a, b) === rng(seed, SALT)(a, b)
// (tiles/floorPlan.js), without importing the floor-plan compiler.
export const roll = (seed, a, b = 0) => hash3i((seed ^ SALT) | 0, a | 0, b | 0, 0x51) >>> 0

// A counter-driven dice stream (pure in seed and salt): n(m) ∈ [0, m),
// p(q) true with probability q, pick(list).
export function dice(seed, salt) {
  let i = 0
  const s = (seed ^ salt) | 0
  const u = () => hash3i(s, i++, 0x6a, 0x51) >>> 0
  return {
    n: (m) => (m > 0 ? u() % m : 0),
    p: (q) => u() / 4294967296 < q,
    pick: (list) => list[u() % list.length],
  }
}

// --- seam ports (§6.8) -----------------------------------------------------------

// Deck ports (cy 0) only, hashed per SEAM: the west seam of tile (tx, tz) is
// the line between tiles tx−1 and tx, keyed by (worldSeed, tx, tz, 'west');
// the north seam likewise. Two to four openings per seam, one or two cells
// wide (the doc's 1–2-cell deck channels), never within 3 cells of a tile
// corner and never across a chunk line. The basin and the gallery have none.
const PORT_SALT = 0x0b9047
const NO_PORTS = Object.freeze([])
const portCache = new Map()

export function seamPorts(worldSeed, tx, tz, side) {
  const key = `${worldSeed >>> 0}|${tx},${tz},${side}`
  let hit = portCache.get(key)
  if (hit) return hit
  const base = ((worldSeed >>> 0) ^ TILE.salt ^ PORT_SALT) | 0
  const h = (i) => hash3i(base, tx | 0, tz | 0, (side === 'west' ? 0x100 : 0x200) + i) >>> 0
  // 2–4 openings, one in each of `count` equal spans of cells 3..37.
  const count = 2 + (h(0) % 3)
  const seg = Math.floor((35 - (count - 1) * 2) / count)
  const spans = Array.from({ length: count }, (_, i) => [3 + i * (seg + 2), 3 + i * (seg + 2) + seg - 1])
  const out = []
  for (const [i, [lo, hi]] of spans.entries()) {
    const width = h(10 + i) % 4 === 0 ? 1 : 2
    let a0 = lo + (h(20 + i) % (hi - lo + 1))
    if (width === 2 && local(a0) === CHUNK - 1) a0 -= 1
    out.push(Object.freeze({ a0, a1: a0 + width - 1 }))
  }
  hit = Object.freeze(out)
  portCache.set(key, hit)
  if (portCache.size > 4096) portCache.delete(portCache.keys().next().value)
  return hit
}

export function ports(worldSeed, k, side, cy) {
  if (cy !== 0) return NO_PORTS
  if (side !== 'west' && side !== 'north') return NO_PORTS
  return seamPorts(worldSeed, k.tx, k.tz, side)
}

// All four sides of tile (tx, tz), tile-local along-cells: west/north are its
// own seams, east/south its neighbours' west/north.
export function tilePorts(worldSeed, tx, tz) {
  return {
    west: seamPorts(worldSeed, tx, tz, 'west'),
    north: seamPorts(worldSeed, tx, tz, 'north'),
    east: seamPorts(worldSeed, tx + 1, tz, 'west'),
    south: seamPorts(worldSeed, tx, tz + 1, 'north'),
  }
}

// --- the pool volume grammar --------------------------------------------------------

// The catalog types (doc §4.2, §5). `levels` storeys from the basin floor:
// the natatio vault rises to the gallery, the rest stop at the deck.
export const VOLUME_TYPES = Object.freeze({
  natatio: Object.freeze({ label: 'natatio vault', sizeClass: 'medium', levels: 3, glazing: 'window' }),
  lapHall: Object.freeze({ label: 'lap hall', sizeClass: 'small', levels: 2, glazing: 'rail' }),
  pitRoom: Object.freeze({ label: 'pit room', sizeClass: 'small', levels: 2, glazing: 'rail' }),
  plunge: Object.freeze({ label: 'stepped basin', sizeClass: 'small', levels: 2, glazing: 'rail' }),
})

// Boxes (the carve box = footprint grown by its ring) stay inside [EDGE,
// LAST − EDGE] so the tile's rim belongs to the deck grammar and every seam
// port lands on deck floor, and keep GAP free cells between each other.
const EDGE = 2
const GAP = 2

// A volume's catalog plan (assembleCatalogDescriptor's `plan`): base storey =
// basin floor (no voids), the pool a void on every storey above, automatic
// flights (plus redundant ones in other chunks).
export function poolPlan(v) {
  const levels = Array.from({ length: v.levels }, (_, i) => (i === 0 ? { voids: [] } : { voids: [v.pool] }))
  return { label: v.label, bounds: v.fp, levels, columns: [], piers: [], core: null, links: 'auto', extraFlights: true, glazing: v.glazing }
}

const chunkSpan = (box) => ({ cx0: Math.floor(box.x0 / CHUNK), cz0: Math.floor(box.z0 / CHUNK), cx1: Math.floor(box.x1 / CHUNK), cz1: Math.floor(box.z1 / CHUNK) })

function chunksOf(box) {
  const s = chunkSpan(box)
  const out = []
  for (let cz = s.cz0; cz <= s.cz1; cz++) for (let cx = s.cx0; cx <= s.cx1; cx++) out.push(Object.freeze({ cx, cz }))
  return out
}

// Guillotine separability of a box set inside `area`: some straight cut line
// (between two cell columns or rows, crossing no box) splits the set, and
// each side is separable again. grammar.js always finds such a cut.
export function separable(boxes, area) {
  if (boxes.length <= 1) return true
  for (const axis of ['x', 'z']) {
    const lo = axis === 'x' ? area.x0 : area.z0
    const hi = axis === 'x' ? area.x1 : area.z1
    for (let c = lo + 1; c <= hi; c++) {
      const a = []
      const b = []
      let crossed = false
      for (const bx of boxes) {
        const b0 = axis === 'x' ? bx.x0 : bx.z0
        const b1 = axis === 'x' ? bx.x1 : bx.z1
        if (b1 < c) a.push(bx)
        else if (b0 >= c) b.push(bx)
        else {
          crossed = true
          break
        }
      }
      if (crossed || !a.length || !b.length) continue
      const ra = axis === 'x' ? R(area.x0, area.z0, c - 1, area.z1) : R(area.x0, area.z0, area.x1, c - 1)
      const rb = axis === 'x' ? R(c, area.z0, area.x1, area.z1) : R(area.x0, c, area.x1, area.z1)
      if (separable(a, ra) && separable(b, rb)) return true
    }
  }
  return false
}

// The deck grammar's area (grammar.js): x, z 0..40 (the east column and the
// south row stay mass but for ports).
export const AREA = Object.freeze(R(0, 0, LAST - 1, LAST - 1))

// Roll one volume of `type`: pool size and lie, deck margins (the pit's well
// keeps ≥ 2 all round for its flights), deep end, position. Null when the
// roll breaks a cheap rule (the catalog's assembly is the final judge).
function rollVolume(type, d, deep) {
  const t = VOLUME_TYPES[type]
  const alongX = d.n(2) === 0
  let L
  let W
  if (type === 'natatio') [L, W] = [13 + d.n(5), 5 + d.n(4)] // doc: 17 × 8
  else if (type === 'lapHall') [L, W] = [8 + d.n(3), 5 + d.n(3)] // doc: 9 × 7
  else if (type === 'pitRoom') L = W = deep ? 6 : 2 + d.n(3) // doc: 2×2 to 3×3 wells (4×4 kept), 'deep' 6×6
  else [L, W] = [4 + d.n(3), 3 + d.n(2)] // stepped plunge basin
  const pw = alongX ? L : W
  const pd = alongX ? W : L
  const m = type === 'pitRoom' ? () => 2 + d.n(2) : () => 1 + d.n(3)
  const [mW, mN, mE, mS] = [m(), m(), m(), m()]
  const boxW = pw + mW + mE + 2
  const boxD = pd + mN + mS + 2
  const span = LAST - 2 * EDGE + 1 // 38
  if (boxW > span || boxD > span) return null
  const bx0 = EDGE + d.n(span - boxW + 1)
  const bz0 = EDGE + d.n(span - boxD + 1)
  const box = R(bx0, bz0, bx0 + boxW - 1, bz0 + boxD - 1)
  const fp = grow(box, -1)
  const pool = R(fp.x0 + mW, fp.z0 + mN, fp.x1 - mE, fp.z1 - mS)
  const deepSide = type === 'pitRoom' ? null : alongX ? (d.n(2) ? 'E' : 'W') : (d.n(2) ? 'S' : 'N')
  // Catalog rules, cheaply: the ring inside the participant chunks, voids
  // off the chunk seams, at most 2 chunks per axis.
  if (local(fp.x0) === 0 || local(fp.z0) === 0 || local(fp.x1) === CHUNK - 1 || local(fp.z1) === CHUNK - 1) return null
  if (local(pool.x0) === 0 || local(pool.x1 + 1) === 0 || local(pool.z0) === 0 || local(pool.z1 + 1) === 0) return null
  const s = chunkSpan(box)
  if (s.cx1 - s.cx0 > 1 || s.cz1 - s.cz0 > 1) return null
  // A vault's gallery box never ends on its chunks' south row or east
  // column: on the gallery storey the next chunk is solid (§6.8 rule 1).
  if (t.levels > 2 && (local(box.x1) === CHUNK - 1 || local(box.z1) === CHUNK - 1)) return null
  return { type, ...t, alongX, pool, fp, box, deepSide }
}

const VALIDATE_ID = 0x80000001

// Assemble `v` as slot `slot` with the planner's own first pick: the planner
// (structures.js) then meets exactly this descriptor, translated. Returns the
// stair links in kind-local coordinates, or null.
function proveVolume(v, slot, planSeed) {
  const meta = {
    id: VALIDATE_ID, family: FAMILY, type: v.type, sizeClass: v.sizeClass,
    district: { x: 0, z: 0, size: TILE.w }, bandIndex: 0, slot, baseCy: BASIN,
  }
  const desc = assembleCatalogDescriptor(poolPlan(v), meta, planPick(planSeed, slot, 0))
  return desc ? desc.verticalLinks : null
}

// The program: what a tile holds, largest first. `force` (the finite kind)
// always takes the natatio so the kind keeps its gallery storey.
function program(d, force) {
  const natatio = force || d.p(0.55)
  const laps = natatio ? (d.p(0.5) ? 1 : 0) : 1 + d.n(2)
  const plunge = d.p(0.45)
  return [
    ...(natatio ? ['natatio'] : []),
    ...Array.from({ length: laps }, () => 'lapHall'),
    'pitRoom',
    ...(plunge ? ['plunge'] : []),
  ]
}

const LAYOUT_ROUNDS = 12

// The exit tile's pit keeps to the tile's far chunks along `far.axis` (the
// two chunk columns or rows away from tile (0,0)), so the exit chunk lies
// 5..8 chunks (Chebyshev) from a spawn anywhere in tile (0,0).
const farEnough = (chunks, far) => chunks.every((c) => {
  const i = far.axis === 'x' ? c.cx : c.cz
  return far.sign > 0 ? i >= 1 : i <= 1
})
const TRIES_PER_VOLUME = 48

// One layout round: place the program's volumes one by one (a type that
// finds no place is dropped, except the pit and a forced natatio).
function layoutRound(planSeed, anomaly, force, far, round) {
  const d = dice(planSeed, 0x0b0 + round * 0x101)
  const vols = []
  const used = new Set()
  for (const type of program(d, force)) {
    let placed = null
    for (let t = 0; t < TRIES_PER_VOLUME && !placed; t++) {
      const v = rollVolume(type, d, type === 'pitRoom' && anomaly === 'deep')
      if (!v) continue
      const chunks = chunksOf(v.box)
      if (chunks.some((c) => used.has(`${c.cx},${c.cz}`))) continue
      if (type === 'pitRoom' && far && !farEnough(chunks, far)) continue
      if (vols.some((o) => overlaps(grow(o.box, GAP), v.box))) continue
      if (!separable([...vols.map((o) => o.box), v.box], AREA)) continue
      const links = proveVolume(v, vols.length, planSeed)
      if (!links) continue
      placed = { ...v, chunks, links }
    }
    if (!placed) {
      if (type === 'pitRoom' || (type === 'natatio' && force)) return null
      continue
    }
    for (const c of placed.chunks) used.add(`${c.cx},${c.cz}`)
    vols.push(placed)
  }
  return vols
}

// The last resort (never met over the measured seeds; kept so the grammar is
// total): a lone pit room in the tile's middle chunk, plus the natatio across
// the top when forced.
function fallbackLayout(planSeed, anomaly, force, far) {
  const vols = []
  const fixed = []
  if (force) fixed.push({ type: 'natatio', alongX: true, pool: R(6, 4, 22, 9), fp: R(3, 3, 25, 11), deepSide: 'E' })
  const s = anomaly === 'deep' ? 6 : 3
  // The middle chunk, or the far middle chunk of the exit tile.
  const o = { x: 14, z: 14 }
  if (far) o[far.axis] = far.sign > 0 ? 28 : 0
  fixed.push({ type: 'pitRoom', alongX: true, pool: R(o.x + 4, o.z + 4, o.x + 3 + s, o.z + 3 + s), fp: R(o.x + 2, o.z + 2, o.x + 5 + s, o.z + 5 + s), deepSide: null })
  for (const f of fixed) {
    const v = { ...f, ...VOLUME_TYPES[f.type], box: grow(f.fp, 1) }
    const links = proveVolume(v, vols.length, planSeed)
    if (!links) throw new Error(`poolrooms: fallback ${f.type} does not assemble`)
    vols.push({ ...v, chunks: chunksOf(v.box), links })
  }
  return vols
}

const freezeVol = (v, slot) => Object.freeze({
  slot,
  type: v.type,
  label: v.label,
  sizeClass: v.sizeClass,
  levels: v.levels,
  glazing: v.glazing,
  alongX: v.alongX,
  deepSide: v.deepSide,
  pool: Object.freeze(v.pool),
  fp: Object.freeze(v.fp),
  box: Object.freeze(v.box),
  chunks: Object.freeze(v.chunks),
  // Stair halos per kind-local storey (both storeys of every link).
  halos: Object.freeze(v.links.flatMap((l) => [l.lowerCy, l.lowerCy + 1].map((cy) => Object.freeze({ cy, rect: Object.freeze(linkHalo(l)) })))),
})

const layoutCache = new Map()
const LAYOUT_CACHE_MAX = 1024

// §6.5 volume-shaping rolls: the volumes of a tile whose planSeed is
// `planSeed` and whose anomaly is `anomaly` (anomalyAt), slot-ordered, in
// kind-local coordinates. Pure; memoised.
// `far` ({ axis, sign }, the exit tile only): the pit keeps to the far chunks.
export function volumesOf(planSeed, anomaly = null, { force = false, far = null } = {}) {
  const key = `${planSeed >>> 0}|${anomaly ?? '-'}|${force ? 1 : 0}|${far ? far.axis + far.sign : '-'}`
  let hit = layoutCache.get(key)
  if (hit) {
    layoutCache.delete(key)
    layoutCache.set(key, hit)
    return hit
  }
  let vols = null
  for (let round = 0; round < LAYOUT_ROUNDS && !vols; round++) vols = layoutRound(planSeed >>> 0, anomaly, force, far, round)
  vols ??= fallbackLayout(planSeed >>> 0, anomaly, force, far)
  hit = Object.freeze(vols.map(freezeVol))
  layoutCache.set(key, hit)
  if (layoutCache.size > LAYOUT_CACHE_MAX) layoutCache.delete(layoutCache.keys().next().value)
  return hit
}

// --- the world grid --------------------------------------------------------------

// The tile key (band 0) of tile (tx, tz) and its planSeed.
export const bandKey = (tx, tz) => tileKeyAt(TILE, tx, tz, 0)
export const planSeedOf = (worldSeed, k) => tileSeed(worldSeed >>> 0, TILE.salt, k)

// The exit tile's `far` constraint (null elsewhere): along x when the tile
// is two columns off, else along z.
export function farOf(worldSeed, tx, tz) {
  const ex = exitTileOf(worldSeed >>> 0)
  if (ex.tx !== tx || ex.tz !== tz) return null
  return Math.abs(tx) === 2 ? { axis: 'x', sign: Math.sign(tx) } : { axis: 'z', sign: Math.sign(tz) }
}

const tileCache = new Map()
// The volumes of world tile (tx, tz), slot-ordered, kind-local (pure in
// worldSeed and the tile): what the planner assembles and the tile program
// hands ctx.kit.catalog.
export function tileVolumes(worldSeed, tx, tz) {
  const key = `${worldSeed >>> 0}|${tx},${tz}`
  let hit = tileCache.get(key)
  if (hit) return hit
  const k = bandKey(tx, tz)
  hit = volumesOf(planSeedOf(worldSeed, k), anomalyAt(worldSeed, k), { far: farOf(worldSeed, tx, tz) })
  tileCache.set(key, hit)
  if (tileCache.size > LAYOUT_CACHE_MAX) tileCache.delete(tileCache.keys().next().value)
  return hit
}

// §6.5 footprint: all nine chunks on each of the three storeys (the basin,
// the deck and the upper gallery, grammar.js).
export function footprint(worldSeed, cx, cy, cz) {
  const k = tileKeyOf(TILE, cx, cy, cz)
  if (!k) return 'solid'
  return 'tile'
}

// --- the stair core ---------------------------------------------------------------------

// The tile's stair core between the deck and the upper gallery: an enclosed
// switchback (structures/authored.js stairwellPlan, one flight, baseCy DECK,
// topCy GALLERY) whose 6×4-cell core sits strictly inside one chunk, its
// LOBBY box (the core grown by one cell, so the door always opens on lobby
// floor) inside the grammar's area, `gap` cells off every pool box
// (STAIR_GAPS), the boxes still guillotine-separable, and never in the chunk
// of the natatio's own deck→gallery flight (one stair up per chunk). Hashed
// from the planSeed; null only when no place fits even at gap 0 (never met
// over 4800 tiles). Kind-local cells. Planner-pure (structures.js reads its
// chunk for the streaming hint verticalOpeningAt).
//   gx, gz   the landing cell; dir 'E'/'W'/'S'/'N' (the first flight's)
//   gap      the clearance it was placed at (2, else 1, else 0)
//   core     the 6×4 core (the stairwell's carve and walls)
//   box      the lobby box (core grown by 1)
const STAIR_GAP = 2
function coreOf(gx, gz, dir) {
  // stairwellPlan's coreCells: along −1..4, across −1..2 from the landing.
  if (dir === 'E') return R(gx - 1, gz - 1, gx + 4, gz + 2)
  if (dir === 'W') return R(gx - 4, gz - 1, gx + 1, gz + 2)
  if (dir === 'S') return R(gx - 1, gz - 1, gx + 2, gz + 4)
  return R(gx - 1, gz - 4, gx + 2, gz + 1)
}
const stairCache = new Map()
export function stairCore(planSeed, vols) {
  const key = `${planSeed >>> 0}|${vols.map((v) => `${v.box.x0},${v.box.z0},${v.box.x1},${v.box.z1}`).join(';')}`
  if (stairCache.has(key)) return stairCache.get(key)
  const hit = rollStairCore(planSeed >>> 0, vols)
  stairCache.set(key, hit)
  if (stairCache.size > LAYOUT_CACHE_MAX) stairCache.delete(stairCache.keys().next().value)
  return hit
}

// The pool boxes' clearance round the lobby box: STAIR_GAP first; the rare
// tile with no place at that gap (about 1 in 700) retries at 1, then 0 (the
// lobby wall against a hall's), so every tile gets its core.
const STAIR_GAPS = Object.freeze([STAIR_GAP, 1, 0])
function rollStairCore(planSeed, vols) {
  for (const gap of STAIR_GAPS) {
    const hit = rollStairCoreAt(planSeed, vols, gap)
    if (hit) return hit
  }
  return null
}

function rollStairCoreAt(planSeed, vols, gap) {
  const d = dice(planSeed, 0x57a12)
  const busy = new Set()
  for (const v of vols) {
    for (const h of v.halos) {
      if (h.cy !== GALLERY) continue
      busy.add(`${Math.floor((h.rect.x0 + h.rect.x1) / 2 / CHUNK)},${Math.floor((h.rect.z0 + h.rect.z1) / 2 / CHUNK)}`)
    }
  }
  const lo = 2
  const hi = LAST - 2
  const cands = []
  for (let gz = 0; gz <= LAST; gz++) {
    for (let gx = 0; gx <= LAST; gx++) {
      for (const dir of ['E', 'W', 'S', 'N']) {
        const core = coreOf(gx, gz, dir)
        const cx = Math.floor(core.x0 / CHUNK)
        const cz = Math.floor(core.z0 / CHUNK)
        if (Math.floor(core.x1 / CHUNK) !== cx || Math.floor(core.z1 / CHUNK) !== cz) continue
        if (local(core.x0) < 1 || local(core.z0) < 1 || local(core.x1) > CHUNK - 2 || local(core.z1) > CHUNK - 2) continue
        const box = grow(core, 1)
        if (box.x0 < lo || box.z0 < lo || box.x1 > hi || box.z1 > hi) continue
        if (busy.has(`${cx},${cz}`)) continue
        if (vols.some((v) => box.x0 <= v.box.x1 + gap && v.box.x0 - gap <= box.x1 && box.z0 <= v.box.z1 + gap && v.box.z0 - gap <= box.z1)) continue
        cands.push({ gx, gz, dir, core, box, k: d.n(1 << 30) })
      }
    }
  }
  // The candidates in hashed order (the lowest roll first) until one keeps
  // the boxes separable — almost always the first.
  const first = (a, b) => a.k - b.k || a.gz - b.gz || a.gx - b.gx || a.dir.localeCompare(b.dir)
  const boxes = vols.map((v) => v.box)
  while (cands.length) {
    let m = 0
    for (let i = 1; i < cands.length; i++) if (first(cands[i], cands[m]) < 0) m = i
    const c = cands[m]
    cands[m] = cands[cands.length - 1]
    cands.pop()
    if (!separable([...boxes, c.box], AREA)) continue
    return Object.freeze({
      gx: c.gx, gz: c.gz, dir: c.dir, doorSide: d.p(0.5) ? 'near' : 'far', gap,
      core: Object.freeze(c.core), box: Object.freeze(c.box),
    })
  }
  return null
}

// --- spawn, exit, anomalies --------------------------------------------------------

// The 16 tiles at Chebyshev distance 2 from tile (0,0), in ring order.
const RING2 = Object.freeze((() => {
  const out = []
  for (let tz = -2; tz <= 2; tz++) for (let tx = -2; tx <= 2; tx++) if (Math.max(Math.abs(tx), Math.abs(tz)) === 2) out.push(Object.freeze({ tx, tz }))
  return out
})())

// The exit tile: one of the 16 tiles at Chebyshev distance 2 (pure in the seed).
export function exitTileOf(worldSeed) {
  return RING2[(hash2i((worldSeed ^ TILE.salt) | 0, 0x0e, 0x17) >>> 0) % RING2.length]
}

// The deterministic fallback tiles of the exit hook: the rest of the ring,
// starting after the exit tile.
export function exitFallbackTiles(worldSeed) {
  const first = RING2.indexOf(exitTileOf(worldSeed))
  return Array.from({ length: RING2.length - 1 }, (_, i) => RING2[(first + 1 + i) % RING2.length])
}

// Per-tile anomaly (§12.0, §12.4; doc 14: poolrooms 1 per 6 chambers, a tile
// holds 6–14, at most one per segment, never the same class twice in a row,
// never on the exit segment). Hashed from each tile's planSeed:
//   raw    present with p = ANOMALY_RAW_OF_8 / 8, a preferred class from the
//          next bit, a priority from the rest; never within Chebyshev 1 of
//          the spawn tile (spawn storey ±1 near spawn), never the exit tile;
//   rotate greedy in priority order: a tile takes its preferred class unless
//          an edge neighbour of higher priority holds it, else the other
//          class, else none. No two edge-adjacent tiles share a class. The
//          recursion only climbs strictly rising priorities (a few tiles), so
//          the result is pure in (worldSeed, tile) and order-independent.
// About 0.57 per tile survive (under the doc's 1 per 6 chambers).
//   'deep'  a too-deep drained pool: the pit's well opens to 6×6, every tube
//           over it dead, its basin plate counting past any pool;
//   'rope'  a lane rope (rail) across one mouth of a deck chamber whose
//           removal keeps the deck connected (never the only route); which
//           mouth is hashed (ropeSiteOf) over the grammar's candidates.
export const ANOMALY_RAW_OF_8 = 6
export const ANOMALY_CLASSES = Object.freeze(['deep', 'rope'])
const anomalyHash = (worldSeed, tx, tz) => hash2i((planSeedOf(worldSeed, bandKey(tx, tz)) ^ 0x0a40a1) | 0, 0x3a, 0x17) >>> 0
const EDGE_NEIGHBOURS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]])

// May tile (tx, tz) hold anomalies at all (the tile's own or its chambers',
// grammar.js chamberAnomalies)? Never within Chebyshev 1 of the spawn tile,
// never the exit tile.
export function anomalyAllowed(worldSeed, tx, tz) {
  if (Math.max(Math.abs(tx), Math.abs(tz)) <= 1) return false
  const ex = exitTileOf(worldSeed >>> 0)
  return !(ex.tx === tx && ex.tz === tz)
}

function rawAnomaly(worldSeed, tx, tz, ex) {
  if (Math.max(Math.abs(tx), Math.abs(tz)) <= 1) return null
  if (ex.tx === tx && ex.tz === tz) return null
  const h = anomalyHash(worldSeed, tx, tz)
  if ((h & 7) >= ANOMALY_RAW_OF_8) return null
  return { cls: (h >>> 3) & 1, pri: h >>> 4, tx, tz }
}

// Strict total order on raw anomalies: priority, then (tx, tz).
const outranks = (a, b) => a.pri > b.pri || (a.pri === b.pri && (a.tx > b.tx || (a.tx === b.tx && a.tz > b.tz)))

// The class index (0/1) tile `me` ends with, or −1.
function finalClass(worldSeed, me, ex, memo) {
  const key = `${me.tx},${me.tz}`
  const hit = memo.get(key)
  if (hit !== undefined) return hit
  const taken = [false, false]
  for (const [dx, dz] of EDGE_NEIGHBOURS) {
    const n = rawAnomaly(worldSeed, me.tx + dx, me.tz + dz, ex)
    if (!n || !outranks(n, me)) continue
    const c = finalClass(worldSeed, n, ex, memo)
    if (c >= 0) taken[c] = true
  }
  const out = !taken[me.cls] ? me.cls : !taken[1 - me.cls] ? 1 - me.cls : -1
  memo.set(key, out)
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

// The rope's site (anomaly 'rope'): index into the deck grammar's candidate
// mouths (grammar.js ropeSites). Pure in the planSeed.
export const ropeSiteOf = (planSeed, n) => (roll(planSeed, 0x7e) >>> 0) % n

// The pit room of a volume list (every tile has exactly one).
export const pitOf = (vols) => vols.find((v) => v.type === 'pitRoom')

// The exit cell on the pit's well floor (kind-local, basin storey): the
// well's middle, nudged by rolls 9 and 10 of `seed` (tile mode: the planSeed,
// so the anchor below is pure).
export function pitExitCell(seed, well) {
  const s = well.x1 - well.x0 + 1
  const t = well.z1 - well.z0 + 1
  return {
    gx: well.x0 + Math.floor(s / 2) - (roll(seed, 9) % 2),
    gz: well.z0 + Math.floor(t / 2) - (roll(seed, 10) % 2),
    cy: BASIN,
  }
}

// §8.2 exit anchor: the pit floor (cy −1) of the exit tile, at the cell the
// tile program marks (markExit).
export function exitAnchorOfTile(worldSeed, tx, tz) {
  const k = bandKey(tx, tz)
  const planSeed = planSeedOf(worldSeed, k)
  const c = pitExitCell(planSeed, pitOf(tileVolumes(worldSeed, tx, tz)).pool)
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
