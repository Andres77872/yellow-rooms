import { CHUNK } from '../../constants.js'
import { deepFreeze } from '../../mapFamily.js'
import {
  CATALOG_KINDS,
  DIR_E,
  DIR_N,
  DIR_S,
  DIR_W,
  analyzeCatalogDescriptor,
  participantsForBounds,
} from '../../structures/catalog/engine.js'
import { MAP_FAMILY_BABEL } from '../ids.js'
import { FAMILY_SALT, hashChain, tileKeyAt, tileKeyOf } from '../../tiles/tileKey.js'

// The babel family's pure geometry (spec §3.3, §12.5): the per-block-band
// LAYOUT GRAMMAR, the stair halls and flights, the shaft voids, the
// per-block-band volume draft, the hashed seam ports, the anomalies and the
// exit anchor. Everything here is a pure function of (worldSeed, global
// coordinates), so the planner (structures.js), the tile program (tile.js),
// the hooks and every neighbouring tile agree without baking anything.
//
// Planner-chain module (§7.5): it may import only constants.js, core/hash.js,
// core/rng.js, mapTypes.js, mapFamily.js ({deepFreeze, MAP_FAMILY_CODES}),
// structures/catalog/engine.js, families/ids.js, tiles/tileKey.js and
// tiles/stubPlanner.js. Never tiles/stub.js, the canvas or the kit.
//
// THE TILE: one 2×2-chunk block (28×28 cells), backend 'band', H = 5
// storeys, phase (tx + 2tz) mod 5 (neighbouring blocks never share band
// boundaries), all storeys (unbounded).
//
// THE GRAMMAR (docs/liminal_maps/06 §4; the kind is the parts catalogue).
// Sameness is an ELEMENT, never a layout: every room is a gallery with a
// railed shaft, shelves on its walls and two globes across the shaft, joined
// to the next only through narrow vestibules — but each block-band composes
// its own arrangement from those parts:
//   1. stair halls: one 6×3 hall per chunk (a straight flight along its
//      middle row/column), at a hashed place and orientation that the band
//      shares with the band above or below (hallSite: the chunk's boundary
//      flight lands in the same hall from both sides);
//   2. seam stubs: two hashed port candidates per seam (pure in the seam
//      key), each storey opening one or both of them (openSeamPorts);
//   3. rooms, packed round the halls with a one-cell gap (mass or a
//      vestibule): THE gallery (6×4 in either orientation, one 2×2 shaft:
//      the repeated element), and rarely a well (a 3–4-cell shaft) or a
//      double gallery (two shafts); every room has a shaft (a room is only
//      placed where its shaft meets the void rules). A band "flavour" sets
//      the variant share, the loop rate and the niche rate, and a packing
//      style (gravity towards a hashed corner, or loose) the arrangement; a
//      gallery fill pass closes the holes;
//   4. vestibule candidates: every straight 1–4-cell run of free cells
//      between two rooms; seam stubs route (BFS) from each port cell to the
//      nearest room;
//   5. per storey (storeyPlan): a randomized depth-first chain over the
//      rooms (long serpentine chains, doc §4.3), every dead end of the
//      chain closed into a loop where it can be (through a stair hall when
//      one is adjacent: the loop then passes the stairs; doc §12 dead-end
//      share ≈ 0), the flavour's extra cross links, and side closets
//      (lectern niches) off some vestibules.
// The rooms (and so the shafts) are shared by the band's five storeys, so
// every shaft is a void on levels 1..4 of the block-band volume; the links
// change on every storey.

export const FAMILY = MAP_FAMILY_BABEL

// --- the kind's constants (shared with tile.js and the editor kind) ----------------

export const SALT = 0x06a1
export const FLOORS = 5
export const BLOCK = 2 * CHUNK // 28 cells: one 2×2-chunk catalog block = one world tile
export const CRIMSON = 0xff3030 // the one lamp colour in the library that is not white
export const SHELF_LABEL = '----' // every level plate reads the same: no storey can be told apart
export const GALLERY_ID = 100 // spaceId blocks (unique per storey)
export const VESTIBULE_ID = 1000
export const MIRROR_OFFSET = 4000
export const HALL_ID = 60
export const STUB_ID = 3000
export const CLOSET_ID = 5000

// The finite kind's brick lattice (the editor prototype only).
export const galleryX = (i, j) => 7 * i + (j % 2 === 0 ? 6 : 2)
export const galleryZ = (j) => 7 * j + 1

export const mod = (a, n) => ((a % n) + n) % n

// --- the tile -------------------------------------------------------------------------

export const TILE = Object.freeze({
  w: 2,
  d: 2,
  backend: 'band',
  H: FLOORS,
  phase: (tx, tz) => mod(tx + 2 * tz, FLOORS),
  salt: FAMILY_SALT.babel,
})
export const TILE_CELLS = TILE.w * CHUNK // 28

// §7.2: the planner's attempt budget (the volume is a hand-built draft; one try).
export const PICK_ATTEMPTS = 1

// The volume's footprint in tile-local cells: inset 1, so the ring is the
// tile perimeter (spec §12.5 "Perimeter").
export const BLOCK_BOUNDS = Object.freeze({ x0: 1, z0: 1, x1: TILE_CELLS - 2, z1: TILE_CELLS - 2 })

// The key of tile (tx, tz) whose band holds GLOBAL storey cy.
export const keyAt = (tx, tz, cy) => tileKeyOf(TILE, tx * TILE.w, cy, tz * TILE.d)
export const keyOfBand = (tx, tz, band) => tileKeyAt(TILE, tx, tz, band)

// §6.5 footprint: every chunk of every storey is drawn (the library has no
// outside); the band's storeys are always the tile's five.
export function footprint() {
  return 'tile'
}

// --- stair halls and flights -------------------------------------------------------------

// The finite kind's (and the spawn chunk's) hall: chunk-local x 6..11,
// z 5..7, the flight along its middle row (z 6), x 7..10.
export const SITE = Object.freeze({ x0: 6, z0: 5, x1: 11, z1: 7, lz: 6 })
export const SPAWN_HALL = Object.freeze({ axis: 'x', a: SITE.x0, g: SITE.z0 })

const PARITY_SALT = 0x0b5e1a17
const FLIGHT_SALT = 0x0b5ef117
const HALL_SALT = 0x0ba11a11

// The stair checkerboard's parity (pure in the seed).
export const flightParity = (worldSeed) => hashChain((worldSeed ^ PARITY_SALT) | 0, 0x7a) & 1

// A chunk serves the slabs of one parity (checkerboard by chunk and slab), so
// it never holds two flights of consecutive slabs and every block holds two
// flights per slab. A band's two boundary slabs (cy0 − 1 below it, cy1 above)
// are 5 apart, so each chunk serves exactly one of them; the chunk's hall in
// that band is the hall of the boundary slab it serves, shared with the band
// on the other side of that slab.
//
// hallSite: { axis, a, g } — the hall's chunk-local rect is 6 long on `axis`
// from a (1..7) and 3 wide from g (1..10), so it, its flight strip and halo
// stay in [1..12]² of the chunk (never on a chunk seam). Chunk (0,0) keeps
// the kind's site on every slab (the spawn vestibule).
export function hallSite(worldSeed, cx, cz, slab) {
  if (cx === 0 && cz === 0) return SPAWN_HALL
  const h = hashChain(((worldSeed >>> 0) ^ HALL_SALT) | 0, cx, cz, slab)
  return { axis: h & 1 ? 'x' : 'z', a: 1 + ((h >>> 1) % 7), g: 1 + ((h >>> 9) % 10) }
}

// The hall's chunk-local rect.
export const hallRect = (h) =>
  h.axis === 'x' ? { x0: h.a, z0: h.g, x1: h.a + 5, z1: h.g + 2 } : { x0: h.g, z0: h.a, x1: h.g + 2, z1: h.a + 5 }

// The boundary slab chunk (cx, cz) serves in band k.
const servedSlab = (worldSeed, k, cx, cz) => (mod(cx + cz + k.cy1 + flightParity(worldSeed), 2) === 0 ? k.cy1 : k.cy0 - 1)

// The hall of chunk (cx, cz) (GLOBAL chunk) in band k.
export const bandHall = (worldSeed, k, cx, cz) => hallSite(worldSeed, cx, cz, servedSlab(worldSeed >>> 0, k, cx, cz))

// The flight of slab lowerCy → lowerCy + 1 in chunk (cx, cz), or null: in
// the chunk's hall of the band holding storey lowerCy, along its middle line,
// up in a hashed direction. Pure in (worldSeed, cx, cz, lowerCy); the
// canonical stair shape (dir, landing, run, exit) in chunk-local cells.
export function flightAt(worldSeed, cx, cz, lowerCy) {
  const seed = worldSeed >>> 0
  if (mod(cx + cz + lowerCy + flightParity(seed), 2)) return null
  const k = tileKeyOf(TILE, cx, lowerCy, cz)
  const h = bandHall(seed, k, cx, cz)
  const pos = hashChain((seed ^ FLIGHT_SALT) | 0, cx, cz, lowerCy) & 1
  const dir = h.axis === 'x' ? (pos ? DIR_E : DIR_W) : pos ? DIR_S : DIR_N
  const along = [1, 2, 3, 4].map((i) => (pos ? h.a + i : h.a + 5 - i))
  const at = (t) => (h.axis === 'x' ? { lx: along[t], lz: h.g + 1 } : { lx: h.g + 1, lz: along[t] })
  return { dir, landing: at(0), run: [at(1), at(2)], exit: at(3) }
}

const flightsOn = (worldSeed, k, lowerCy) => {
  const out = []
  for (let cz = k.origin.cz; cz < k.origin.cz + TILE.d; cz++) {
    for (let cx = k.origin.cx; cx < k.origin.cx + TILE.w; cx++) {
      const stair = flightAt(worldSeed, cx, cz, lowerCy)
      if (stair) out.push({ lowerCy, cx, cz, stair })
    }
  }
  return out
}

// The volume's links: the in-band flights (slabs cy0 .. cy1 − 1), GLOBAL,
// sorted (lowerCy, cz, cx).
export function babelFlights(worldSeed, k) {
  const out = []
  for (let lowerCy = k.cy0; lowerCy < k.cy1; lowerCy++) out.push(...flightsOn(worldSeed, k, lowerCy))
  return out
}

// The band-boundary flights above band k (slab cy1 → cy1 + 1): no volume
// covers that slab, so the lower band stamps the stairUp halves on its top
// storey and the upper band the stairDown halves on its base storey, both
// through kit.stairs, in the hall both bands share.
export function boundaryFlights(worldSeed, k) {
  return flightsOn(worldSeed, k, k.cy1)
}

// One block-band's boundary flights above storey cy1 (spec §12.5).
export function boundaryFlight(worldSeed, tx, tz, cy1) {
  const k = keyAt(tx, tz, cy1)
  return k && k.cy1 === cy1 ? boundaryFlights(worldSeed, k) : []
}

// --- seams (§6.5, §6.8) ------------------------------------------------------------------

const PORT_SALT = 0x0ba5ea11
const PORT_OPEN_SALT = 0x0ba50e11
const SIDE_CODE = Object.freeze({ west: 1, north: 2 })

// The two port candidates of the WEST or NORTH line of tile (tx, tz),
// tile-local along-cells: one per chunk row/column (2..11 and 16..25). Pure
// in the seam key, so both tiles of the seam agree.
export function seamCandidates(worldSeed, tx, tz, side) {
  const h = hashChain(((worldSeed >>> 0) ^ PORT_SALT) | 0, tx, tz, SIDE_CODE[side])
  return [2 + (h % 10), 16 + ((h >>> 8) % 10)]
}

// The candidates open on GLOBAL storey cy: one, the other or both.
export function openSeamPorts(worldSeed, tx, tz, side, cy) {
  const c = seamCandidates(worldSeed, tx, tz, side)
  const m = hashChain(((worldSeed >>> 0) ^ PORT_OPEN_SALT) | 0, tx, tz, SIDE_CODE[side], cy) % 4
  return m === 0 ? [c[0]] : m === 1 ? [c[1]] : c
}

// Ports, tile-local along-cells, inclusive; pure and band-independent.
export function ports(worldSeed, k, side, cy) {
  if (side !== 'west' && side !== 'north') return []
  return openSeamPorts(worldSeed, k.tx, k.tz, side, cy).map((a) => Object.freeze({ a0: a, a1: a }))
}

// --- the layout grammar ---------------------------------------------------------------------

const S = TILE_CELLS
const LAST = S - 1 // the east column / south row: mass except at ports
const FREE = -1
const RING = -2
const PORT = -3
const MAX_VEST = 4
const LAYOUT_SALT = 0x0ba1a7e0
const LINK_SALT = 0x0ba11c00

// A hash stream: r(m) → [0, m).
function stream(seed) {
  let n = 0
  return (m) => (m <= 1 ? (n++, 0) : hashChain(seed | 0, n++) % m)
}

// Band flavours: the rare variant rooms (percent of placement attempts:
// well, double; the rest are THE gallery), the extra cross links per storey
// (0..extra), and the closet and lectern rates of the vestibules. Every room has a shaft (doc §1 A3): the
// sameness is the 6×4 gallery itself (doc §12 room repetition ≥ 0.95); the
// flavours vary the packing, the links and the niches, not the room.
const FLAVOURS = Object.freeze([
  Object.freeze({ name: 'stacks', well: 2, double: 2, extra: 2, closet: 40, lectern: 50 }),
  Object.freeze({ name: 'wells', well: 9, double: 1, extra: 2, closet: 40, lectern: 40 }),
  Object.freeze({ name: 'long galleries', well: 1, double: 9, extra: 3, closet: 35, lectern: 50 }),
  Object.freeze({ name: 'reading niches', well: 2, double: 2, extra: 1, closet: 70, lectern: 85 }),
  Object.freeze({ name: 'hexagons', well: 0, double: 0, extra: 2, closet: 45, lectern: 50 }),
])
const STYLES = Object.freeze(['gravity NW', 'gravity NE', 'gravity SW', 'gravity SE', 'loose'])
const SLIDE = Object.freeze([[-1, -1], [1, -1], [-1, 1], [1, 1], null])
// THE gallery is 6×4 (doc §5, in either orientation) and never grows; only
// the rare wells and double galleries grow, up to these limits.
export const GALLERY_W = 6
export const GALLERY_D = 4
const GROW_LIMIT = Object.freeze({ gallery: [GALLERY_W, GALLERY_D], well: [9, 8], double: [12, 5] })

function roomSpec(r, f) {
  const t = r(100)
  let spec
  if (t < f.well) spec = { kind: 'well', w: 7 + r(2), d: 6 + r(2) }
  else if (t < f.well + f.double) spec = { kind: 'double', w: 10 + r(2), d: 4 }
  else spec = { kind: 'gallery', w: GALLERY_W, d: GALLERY_D }
  if (r(2) === 0) [spec.w, spec.d] = [spec.d, spec.w]
  return spec
}

// A void must not start or end on a chunk seam (catalog rule) and stays
// inset one cell from the block bounds [1, 26] (planner rule §7.2).
const voidAxisOk = (a0, n) => a0 >= 2 && a0 + n - 1 <= S - 3 && mod(a0, CHUNK) !== 0 && mod(a0 + n, CHUNK) !== 0

// The start of an n-cell shaft inside [lo, hi] (cells), nearest the centre.
function fitAxis(lo, hi, n) {
  const span = hi - lo + 1 - n
  if (span < 0) return null
  const c = lo + Math.floor(span / 2)
  for (const d of [0, 1, -1, 2, -2, 3, -3]) {
    const a = c + d
    if (a >= lo && a <= lo + span && voidAxisOk(a, n)) return a
  }
  return null
}

function shaftIn(x0, z0, x1, z1, sw, sd) {
  const sx = fitAxis(x0 + 1, x1 - 1, sw)
  const sz = fitAxis(z0 + 1, z1 - 1, sd)
  return sx === null || sz === null ? null : { x0: sx, z0: sz, x1: sx + sw - 1, z1: sz + sd - 1 }
}

// The shafts of a room (tile-local), or null when they do not fit (the
// packer then slides the room or tries elsewhere: every room has a shaft).
function shaftsOf(room) {
  const { kind, x0, z0, x1, z1 } = room
  const w = x1 - x0 + 1
  const d = z1 - z0 + 1
  if (kind === 'double') {
    const out = []
    if (w >= d) {
      const m = x0 + Math.floor(w / 2)
      out.push(shaftIn(x0, z0, m, z1, 2, 2), shaftIn(m - 1, z0, x1, z1, 2, 2))
    } else {
      const m = z0 + Math.floor(d / 2)
      out.push(shaftIn(x0, z0, x1, m, 2, 2), shaftIn(x0, m - 1, x1, z1, 2, 2))
    }
    return out.every(Boolean) ? out : null
  }
  const sw = kind === 'well' ? Math.max(2, Math.min(4, w - 4)) : 2
  const sd = kind === 'well' ? Math.max(2, Math.min(4, d - 4)) : 2
  const s = shaftIn(x0, z0, x1, z1, sw, sd)
  return s ? [s] : null
}

// The chunk (0..3, block-local) of a room's first globe (tile.js hangs it
// west of the first shaft; every room has one).
export const GLOBES_PER_CHUNK = 5
export function firstGlobe(room) {
  const s = room.shafts[0]
  return [s.x0 - 1, s.z0]
}
const globeChunk = (room) => {
  const [gx, gz] = firstGlobe(room)
  return (gz >= CHUNK ? 2 : 0) + (gx >= CHUNK ? 1 : 0)
}

const DIRS = Object.freeze([[0, -1], [1, 0], [0, 1], [-1, 0]]) // N E S W

// The edge between 4-adjacent cells a and b: { axis, gx, gz } (a V line is
// the west edge of cell gx, an H line the north edge of row gz).
export const edgeBetween = (ax, az, bx, bz) =>
  ax !== bx ? { axis: 'v', gx: Math.max(ax, bx), gz: az } : { axis: 'h', gx: ax, gz: Math.max(az, bz) }

const LAYOUT_MEMO = new Map()
const LAYOUT_MEMO_MAX = 2048

// The layout of block-band k (tile-local cells), frozen and memoised:
// { flavour, style, rooms: [{ n, kind, x0, z0, x1, z1, shafts, hall?, chunk? }],
//   galleries: [room indices that are not halls], stubs, cands, pairs }.
export function layoutOf(worldSeed, k) {
  const seed = worldSeed >>> 0
  const key = `${seed}|${k.tx},${k.tz},${k.band}`
  let L = LAYOUT_MEMO.get(key)
  if (L) {
    LAYOUT_MEMO.delete(key)
    LAYOUT_MEMO.set(key, L)
    return L
  }
  L = buildLayout(seed, k)
  LAYOUT_MEMO.set(key, L)
  if (LAYOUT_MEMO.size > LAYOUT_MEMO_MAX) LAYOUT_MEMO.delete(LAYOUT_MEMO.keys().next().value)
  return L
}

function buildLayout(seed, k) {
  const { tx, tz } = k
  const r = stream(hashChain((seed ^ LAYOUT_SALT) | 0, tx, tz, k.band))
  const at = (x, z) => z * S + x
  const occ = new Int16Array(S * S).fill(FREE)
  for (let i = 0; i < S; i++) {
    occ[at(LAST, i)] = RING
    occ[at(i, LAST)] = RING
  }
  // 2. The port candidates of the four sides (east/south: the neighbours'
  // west/north candidates).
  const portCells = []
  const sides = [
    ['west', seamCandidates(seed, tx, tz, 'west'), (a) => [0, a], [1, 0]],
    ['north', seamCandidates(seed, tx, tz, 'north'), (a) => [a, 0], [0, 1]],
    ['east', seamCandidates(seed, tx + 1, tz, 'west'), (a) => [LAST, a], [-1, 0]],
    ['south', seamCandidates(seed, tx, tz + 1, 'north'), (a) => [a, LAST], [0, -1]],
  ]
  for (const [side, cands, cell, inward] of sides) {
    for (const [c, a] of cands.entries()) {
      const [x, z] = cell(a)
      occ[at(x, z)] = PORT
      portCells.push({ side, a, c, x, z, inward })
    }
  }
  // 1. The four stair halls.
  const rooms = []
  // A summed-area table of the taken cells (rebuilt lazily after each
  // placement): the packer's quick reject.
  const sat = new Int32Array((S + 1) * (S + 1))
  let satValid = false
  const innerFree = (x0, z0, x1, z1) => {
    if (!satValid) {
      for (let z = 0; z < S; z++) {
        let row = 0
        for (let x = 0; x < S; x++) {
          row += occ[at(x, z)] !== FREE ? 1 : 0
          sat[(z + 1) * (S + 1) + x + 1] = sat[z * (S + 1) + x + 1] + row
        }
      }
      satValid = true
    }
    const W = S + 1
    return sat[(z1 + 1) * W + x1 + 1] - sat[z0 * W + x1 + 1] - sat[(z1 + 1) * W + x0] + sat[z0 * W + x0] === 0
  }
  const place = (room) => {
    room.n = rooms.length
    rooms.push(room)
    for (let z = room.z0; z <= room.z1; z++) for (let x = room.x0; x <= room.x1; x++) occ[at(x, z)] = room.n
    satValid = false
  }
  for (let lz = 0; lz < TILE.d; lz++) {
    for (let lx = 0; lx < TILE.w; lx++) {
      const h = bandHall(seed, k, k.origin.cx + lx, k.origin.cz + lz)
      const hr = hallRect(h)
      place({
        kind: 'hall', x0: hr.x0 + lx * CHUNK, z0: hr.z0 + lz * CHUNK, x1: hr.x1 + lx * CHUNK, z1: hr.z1 + lz * CHUNK,
        shafts: [], hall: h, chunk: { lx, lz },
      })
    }
  }
  // 3. Rooms.
  // A room keeps one cell of gap from every other room, but may stand
  // against a stair hall (the hall is then its vestibule, doc §2: the stair
  // stands in the hallway between galleries).
  // A gallery of a range may also stand back to back with another gallery
  // (abut: the shared side is one shelved wall, never a door), as the
  // galleries of the story share their shelved walls.
  const isHall = (v) => v >= 0 && rooms[v].kind === 'hall'
  const canTouch = (v, abut) => isHall(v) || (abut && rooms[v].kind === 'gallery')
  const fits = (x0, z0, x1, z1, abut = false) => {
    if (x0 < 0 || z0 < 0 || x1 > LAST - 1 || z1 > LAST - 1) return false
    if (!innerFree(x0, z0, x1, z1)) return false
    for (let z = Math.max(0, z0 - 1); z <= Math.min(LAST, z1 + 1); z++) {
      for (let x = Math.max(0, x0 - 1); x <= Math.min(LAST, x1 + 1); x++) {
        const v = occ[at(x, z)]
        const inner = x >= x0 && x <= x1 && z >= z0 && z <= z1
        if (v >= 0 && (inner || !canTouch(v, abut) || ((x < x0 || x > x1) && (z < z0 || z > z1)))) return false
        if (v !== FREE && x >= x0 && x <= x1 && z >= z0 && z <= z1) return false
      }
    }
    return true
  }
  const flavour = FLAVOURS[r(FLAVOURS.length)]
  const styleIx = r(STYLES.length)
  const slide = SLIDE[styleIx]
  // A room is placed only where its shafts satisfy the void rules (inset,
  // never on a chunk seam) and its first globe keeps its chunk within the
  // lamp budget: the slid position first, then the positions it slid
  // through, then one-cell nudges of the drop point.
  const globes = [0, 0, 0, 0]
  const NUDGES = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]]
  const placeAt = (kind, x, z, w, d, abut = false) => {
    if (!fits(x, z, x + w - 1, z + d - 1, abut && kind === 'gallery')) return false
    const room = { kind, x0: x, z0: z, x1: x + w - 1, z1: z + d - 1 }
    room.shafts = shaftsOf(room)
    if (!room.shafts) return false
    const g = globeChunk(room)
    if (globes[g] >= GLOBES_PER_CHUNK) return false
    globes[g]++
    place(room)
    return true
  }
  const tryRoom = (spec, x0, z0, slideOn = true, abut = false, nudge = true) => {
    if (!nudge) return placeAt(spec.kind, x0, z0, spec.w, spec.d, abut)
    const path = [[x0, z0]]
    if (slide && slideOn && fits(x0, z0, x0 + spec.w - 1, z0 + spec.d - 1)) {
      let x = x0
      let z = z0
      for (let moved = true; moved;) {
        moved = false
        if (fits(x + slide[0], z, x + slide[0] + spec.w - 1, z + spec.d - 1)) {
          x += slide[0]
          moved = true
          path.push([x, z])
        }
        if (fits(x, z + slide[1], x + spec.w - 1, z + slide[1] + spec.d - 1)) {
          z += slide[1]
          moved = true
          path.push([x, z])
        }
      }
      path.reverse()
    }
    for (const [dx, dz] of NUDGES) path.push([x0 + dx, z0 + dz])
    for (const [x, z] of path) if (placeAt(spec.kind, x, z, spec.w, spec.d, abut)) return true
    return false
  }
  // 3a. The variant rooms (wells, double galleries) of the flavour first.
  const VARIANT_ATTEMPTS = 14
  for (let t = 0; t < VARIANT_ATTEMPTS; t++) {
    const spec = roomSpec(r, flavour)
    if (spec.kind !== 'gallery') tryRoom(spec, r(S - spec.w), r(S - spec.d))
  }
  // 3b. Ranges: a hashed binary partition of the block into 2..8 regions;
  // each region packs galleries in a run of its own orientation, gaps
  // (1..3 cells: the vestibule lengths), offset and skip rate (doc §4: the
  // galleries stand in ranges joined by narrow vestibules). The halls and
  // variants already placed break the runs.
  const regions = []
  const split = (x0, z0, x1, z1, depth) => {
    const w = x1 - x0 + 1
    const d = z1 - z0 + 1
    const canX = w >= 16
    const canZ = d >= 16
    if ((!canX && !canZ) || depth >= 3 || (depth > 0 && r(100) < 30)) {
      regions.push({ x0, z0, x1, z1 })
      return
    }
    if (canX && (!canZ || r(2) === 0)) {
      const c = x0 + 7 + r(w - 14)
      split(x0, z0, c - 1, z1, depth + 1)
      split(c + 1, z0, x1, z1, depth + 1)
    } else {
      const c = z0 + 7 + r(d - 14)
      split(x0, z0, x1, c - 1, depth + 1)
      split(x0, c + 1, x1, z1, depth + 1)
    }
  }
  split(0, 0, LAST - 1, LAST - 1, 0)
  for (const g of regions) {
    const [w, d] = r(2) === 0 ? [GALLERY_W, GALLERY_D] : [GALLERY_D, GALLERY_W]
    // Gaps: 0 (back to back, along one axis only), 1, or 2..3.
    const backToBack = r(100)
    const gx = backToBack < 35 ? 0 : 1 + (r(100) < 25 ? 1 + r(2) : 0)
    const gz = backToBack >= 35 && backToBack < 70 ? 0 : 1 + (r(100) < 25 ? 1 + r(2) : 0)
    const skip = r(2) * 6
    // The range runs from a hashed corner of its region.
    const fx = r(2)
    const fz = r(2)
    for (let z = g.z0; z + d - 1 <= g.z1; z += d + gz) {
      for (let x = g.x0; x + w - 1 <= g.x1; x += w + gx) {
        if (r(100) < skip) continue
        const px = fx ? g.x1 - (x - g.x0) - w + 1 : x
        const pz = fz ? g.z1 - (z - g.z0) - d + 1 : z
        tryRoom({ kind: 'gallery', w, d }, px, pz, false, true)
      }
    }
  }
  // 3c. Loose galleries in the band's packing style (gravity or loose), and
  // the fill pass, may stand back to back with a gallery too.
  const ATTEMPTS = 30
  for (let t = 0; t < ATTEMPTS; t++) {
    const spec = r(2) === 0 ? { kind: 'gallery', w: GALLERY_W, d: GALLERY_D } : { kind: 'gallery', w: GALLERY_D, d: GALLERY_W }
    tryRoom(spec, r(S - spec.w), r(S - spec.d), true, true)
  }
  // The fill pass: galleries into the holes, raster order from a hashed start.
  const start = r(S * S)
  for (let q = 0; q < S * S; q++) {
    const p = (start + q * 11) % (S * S) // 11 is prime to 784: every cell once
    const x = p % S
    const z = Math.floor(p / S)
    if (occ[at(x, z)] !== FREE) continue
    const turn = r(2)
    for (const q of [turn, 1 - turn]) {
      const [w, d] = q ? [GALLERY_D, GALLERY_W] : [GALLERY_W, GALLERY_D]
      // The free cell as any corner of the gallery.
      if ([[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]].some(([ax, az]) => tryRoom({ kind: 'gallery', w, d }, x - ax, z - az, false, true, false))) break
    }
  }
  // Growth: rooms widen into the gaps the packing left (a gap never closes
  // below one cell), up to their kind's limit, in hashed order.
  const fitsAs = (n, x0, z0, x1, z1) => {
    if (x0 < 0 || z0 < 0 || x1 > LAST - 1 || z1 > LAST - 1) return false
    for (let z = Math.max(0, z0 - 1); z <= Math.min(LAST, z1 + 1); z++) {
      for (let x = Math.max(0, x0 - 1); x <= Math.min(LAST, x1 + 1); x++) {
        const v = occ[at(x, z)]
        if (v === n) continue
        const inner = x >= x0 && x <= x1 && z >= z0 && z <= z1
        if (v >= 0 && (inner || !isHall(v) || ((x < x0 || x > x1) && (z < z0 || z > z1)))) return false
        if (v !== FREE && x >= x0 && x <= x1 && z >= z0 && z <= z1) return false
      }
    }
    return true
  }
  const growOrder = [...rooms.filter((g) => g.kind === 'well' || g.kind === 'double')]
  for (let i = growOrder.length - 1; i > 0; i--) {
    const j = r(i + 1)
    ;[growOrder[i], growOrder[j]] = [growOrder[j], growOrder[i]]
  }
  for (let pass = 0, grew = true; grew && pass < 8; pass++) {
    grew = false
    for (const room of growOrder) {
      const [lw, ld] = GROW_LIMIT[room.kind]
      for (const t of [0, 1, 2, 3].map((q) => (q + r(4)) % 4)) {
        const nx0 = room.x0 - (t === 3 ? 1 : 0)
        const nz0 = room.z0 - (t === 0 ? 1 : 0)
        const nx1 = room.x1 + (t === 1 ? 1 : 0)
        const nz1 = room.z1 + (t === 2 ? 1 : 0)
        const w = nx1 - nx0 + 1
        const d = nz1 - nz0 + 1
        if (Math.max(w, d) > Math.max(lw, ld) || Math.min(w, d) > Math.min(lw, ld)) continue
        if (!fitsAs(room.n, nx0, nz0, nx1, nz1) || !shaftsOf({ kind: room.kind, x0: nx0, z0: nz0, x1: nx1, z1: nz1 })) continue
        Object.assign(room, { x0: nx0, z0: nz0, x1: nx1, z1: nz1 })
        for (let z = nz0; z <= nz1; z++) for (let x = nx0; x <= nx1; x++) occ[at(x, z)] = room.n
        satValid = false
        grew = true
      }
    }
  }
  for (const room of rooms) {
    if (room.kind === 'hall') continue
    const shafts = shaftsOf(room)
    if (!shafts) throw new Error(`babel layout ${tx},${tz},${k.band}: room ${room.n} lost its shaft`)
    room.shafts = shafts
  }
  // The lamp budget (≤ 6 lit per chunk-storey, a red pair included): at most
  // GLOBES_PER_CHUNK rooms hang their first globe in one chunk; the smallest
  // room of a crowded chunk is dropped (its cells go back to mass).
  for (let guard = 0; guard < rooms.length; guard++) {
    const per = [[], [], [], []]
    for (const room of rooms) if (room.kind !== 'hall' && !room.dropped) per[globeChunk(room)].push(room)
    const over = per.find((list) => list.length > GLOBES_PER_CHUNK)
    if (!over) break
    const area = (g) => (g.x1 - g.x0 + 1) * (g.z1 - g.z0 + 1)
    const victim = over.reduce((a, b) => (area(b) < area(a) ? b : a))
    victim.dropped = true
    for (let z = victim.z0; z <= victim.z1; z++) for (let x = victim.x0; x <= victim.x1; x++) occ[at(x, z)] = FREE
    satValid = false
  }
  if (rooms.some((room) => room.dropped)) {
    const kept = rooms.filter((room) => !room.dropped)
    rooms.length = 0
    for (const room of kept) place(room)
  }

  // 4a. Seam stubs: BFS from each port cell through free cells to the
  // nearest room (or, failing that, another stub).
  const stubAt = new Int16Array(S * S).fill(-1)
  const inside = (x, z) => x >= 0 && z >= 0 && x < LAST && z < LAST
  const stubs = []
  for (const p of portCells) {
    const prev = new Int32Array(S * S).fill(-2)
    const s0 = at(p.x, p.z)
    prev[s0] = -1
    const queue = [s0]
    const order = [p.inward, ...DIRS.filter(([dx, dz]) => dx !== p.inward[0] || dz !== p.inward[1])]
    let goal = -1
    let door = null
    let via = -1
    let viaGoal = -1
    let viaDoor = null
    for (let qi = 0; qi < queue.length && goal < 0; qi++) {
      const c = queue[qi]
      const x = c % S
      const z = Math.floor(c / S)
      for (const [dx, dz] of order) {
        const nx = x + dx
        const nz = z + dz
        if (nx < 0 || nz < 0 || nx > LAST || nz > LAST) continue
        const v = occ[at(nx, nz)]
        if (v >= 0) {
          goal = c
          door = { room: v, x: nx, z: nz }
          break
        }
        if (viaGoal < 0 && stubAt[at(nx, nz)] >= 0) {
          viaGoal = c
          via = stubAt[at(nx, nz)]
          viaDoor = { x: nx, z: nz }
        }
      }
      if (goal >= 0) break
      for (const [dx, dz] of order) {
        const nx = x + dx
        const nz = z + dz
        if (!inside(nx, nz)) continue
        const ni = at(nx, nz)
        if (prev[ni] !== -2 || occ[ni] !== FREE || stubAt[ni] >= 0) continue
        prev[ni] = c
        queue.push(ni)
      }
    }
    let end = goal
    if (end < 0) {
      if (viaGoal < 0) throw new Error(`babel layout ${tx},${tz},${k.band}: port ${p.side} ${p.a} is sealed`)
      end = viaGoal
      door = { room: -1, x: viaDoor.x, z: viaDoor.z }
    } else via = -1
    const cells = []
    for (let c = end; c !== -1; c = prev[c]) cells.unshift(c)
    const n = stubs.length
    for (const c of cells) stubAt[c] = n
    const last = cells[cells.length - 1]
    stubs.push({
      n, side: p.side, a: p.a, c: p.c, cells, via, room: door.room,
      door: edgeBetween(last % S, Math.floor(last / S), door.x, door.z),
    })
  }

  // 4b. Vestibule candidates: straight runs of 1..MAX_VEST free cells
  // between two rooms (never through a stub).
  const pairs = new Map() // 'a,b' (a < b) -> [cand]
  for (const A of rooms) {
    for (const [dx, dz] of DIRS) {
      const xs = dx === 0 ? [A.x0, A.x1] : dx > 0 ? [A.x1, A.x1] : [A.x0, A.x0]
      const zs = dz === 0 ? [A.z0, A.z1] : dz > 0 ? [A.z1, A.z1] : [A.z0, A.z0]
      for (let bz = zs[0]; bz <= zs[1]; bz++) {
        for (let bx = xs[0]; bx <= xs[1]; bx++) {
          const path = []
          let x = bx + dx
          let z = bz + dz
          for (let L = 0; L <= MAX_VEST; L++) {
            if (x < 0 || z < 0 || x >= LAST || z >= LAST) break
            const v = occ[at(x, z)]
            if (v >= 0) {
              // A doorway straight into an abutting hall (no vestibule cells).
              if (!path.length && v !== A.n && (A.kind === 'hall') !== (rooms[v].kind === 'hall')) {
                const a = Math.min(A.n, v)
                const b = Math.max(A.n, v)
                let list = pairs.get(`${a},${b}`)
                if (!list) pairs.set(`${a},${b}`, (list = []))
                if (A.n < v) list.push({ a, b, cells: [], doors: [edgeBetween(bx, bz, x, z)] })
              }
              if (v > A.n && path.length) {
                const key = `${A.n},${v}`
                let list = pairs.get(key)
                if (!list) pairs.set(key, (list = []))
                const [fx, fz] = path[0]
                const [lx2, lz2] = path[path.length - 1]
                list.push({
                  a: A.n, b: v, cells: path.map(([px, pz]) => at(px, pz)),
                  doors: [edgeBetween(bx, bz, fx, fz), edgeBetween(lx2, lz2, x, z)],
                })
              }
              break
            }
            if (v !== FREE || stubAt[at(x, z)] >= 0 || L === MAX_VEST) break
            path.push([x, z])
            x += dx
            z += dz
          }
        }
      }
    }
  }
  // Bent corridors joining what the straight runs leave apart (rare).
  const comp = componentsOf(rooms.length, pairs)
  for (let guard = 0; comp.count > 1 && guard < rooms.length; guard++) {
    const bridge = bentCorridor(occ, stubAt, rooms, comp.of, at)
    if (!bridge) throw new Error(`babel layout ${tx},${tz},${k.band}: rooms in ${comp.count} pieces`)
    const key = `${Math.min(bridge.a, bridge.b)},${Math.max(bridge.a, bridge.b)}`
    let list = pairs.get(key)
    if (!list) pairs.set(key, (list = []))
    list.push(bridge)
    Object.assign(comp, componentsOf(rooms.length, pairs))
  }

  // The pair graph; a pair whose removal would split it is a bridge (each
  // storey reserves a run for every bridge before its chain).
  const adj = Array.from({ length: rooms.length }, () => [])
  const bridges = []
  for (const [key, list] of pairs) {
    const [a, b] = key.split(',').map(Number)
    const without = new Map(pairs)
    without.delete(key)
    const bridge = componentsOf(rooms.length, without).count > 1
    if (bridge) bridges.push({ a, b, list })
    adj[a].push({ to: b, list })
    adj[b].push({ to: a, list })
  }
  const galleries = rooms.filter((g) => g.kind !== 'hall').map((g) => g.n)
  return deepFreeze({ tx, tz, band: k.band, flavour: flavour.name, extra: flavour.extra, closet: flavour.closet, lectern: flavour.lectern, style: STYLES[styleIx], rooms, galleries, stubs, adj, bridges })
}

function componentsOf(n, pairs) {
  const of = new Int32Array(n).fill(-1)
  const adj = Array.from({ length: n }, () => [])
  for (const key of pairs.keys()) {
    const [a, b] = key.split(',').map(Number)
    adj[a].push(b)
    adj[b].push(a)
  }
  let count = 0
  for (let s = 0; s < n; s++) {
    if (of[s] >= 0) continue
    const stack = [s]
    of[s] = count
    while (stack.length) {
      const u = stack.pop()
      for (const v of adj[u]) {
        if (of[v] >= 0) continue
        of[v] = count
        stack.push(v)
      }
    }
    count++
  }
  return { of, count }
}

// The shortest free-cell corridor from component 0 to any other component.
function bentCorridor(occ, stubAt, rooms, of, at) {
  const prev = new Int32Array(S * S).fill(-2)
  const from = new Int32Array(S * S).fill(-1)
  const queue = []
  for (const A of rooms) {
    if (of[A.n] !== 0) continue
    for (let z = A.z0; z <= A.z1; z++) {
      for (let x = A.x0; x <= A.x1; x++) {
        for (const [dx, dz] of DIRS) {
          const nx = x + dx
          const nz = z + dz
          if (nx < 0 || nz < 0 || nx >= LAST || nz >= LAST) continue
          const ni = at(nx, nz)
          if (prev[ni] !== -2 || occ[ni] !== FREE || stubAt[ni] >= 0) continue
          prev[ni] = -1
          from[ni] = at(x, z)
          queue.push(ni)
        }
      }
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]
    const x = c % S
    const z = Math.floor(c / S)
    for (const [dx, dz] of DIRS) {
      const nx = x + dx
      const nz = z + dz
      if (nx < 0 || nz < 0 || nx >= LAST || nz >= LAST) continue
      const ni = at(nx, nz)
      const v = occ[ni]
      if (v >= 0 && of[v] !== 0) {
        const cells = []
        for (let p = c; p !== -1; p = prev[p]) cells.unshift(p)
        const s = from[cells[0]]
        const a = occ[s]
        return {
          a: Math.min(a, v), b: Math.max(a, v), cells, bent: true,
          doors: [edgeBetween(s % S, Math.floor(s / S), cells[0] % S, Math.floor(cells[0] / S)), edgeBetween(x, z, nx, nz)],
        }
      }
      if (prev[ni] !== -2 || v !== FREE || stubAt[ni] >= 0) continue
      prev[ni] = c
      queue.push(ni)
    }
  }
  return null
}

// The layout's occupancy grid (room index, FREE, RING) and stub cells.
function layoutOcc(L) {
  const occ = new Int16Array(S * S).fill(FREE)
  for (let i = 0; i < S; i++) occ[LAST * S + i] = occ[i * S + LAST] = RING
  for (const room of L.rooms) for (let z = room.z0; z <= room.z1; z++) for (let x = room.x0; x <= room.x1; x++) occ[z * S + x] = room.n
  return occ
}
function stubCells(L) {
  const out = new Int16Array(S * S).fill(-1)
  for (const st of L.stubs) for (const c of st.cells) out[c] = st.n
  return out
}

// --- one storey's links ------------------------------------------------------------------------

const STOREY_MEMO = new Map()
const STOREY_MEMO_MAX = 4096

// The links of block-band k on GLOBAL storey cy: { vests: [{ a, b, cells,
// doors }], closets: [{ cell, door, lectern }], stubs: [stub indices drawn],
// degree }. A randomized depth-first chain over the rooms (from a hashed
// room, neighbours and vestibule runs in hashed order, runs cell-disjoint),
// then its dead ends closed into loops (stair halls first), the flavour's
// extra cross links and the closets.
export function storeyPlan(worldSeed, k, cy) {
  const seed = worldSeed >>> 0
  const key = `${seed}|${k.tx},${k.tz},${k.band}|${cy}`
  let P = STOREY_MEMO.get(key)
  if (P) return P
  P = buildStoreyPlan(seed, k, cy)
  STOREY_MEMO.set(key, P)
  if (STOREY_MEMO.size > STOREY_MEMO_MAX) STOREY_MEMO.delete(STOREY_MEMO.keys().next().value)
  return P
}

function shuffled(r, list) {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = r(i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function buildStoreyPlan(seed, k, cy) {
  const L = layoutOf(seed, k)
  const r = stream(hashChain((seed ^ LINK_SALT) | 0, k.tx, k.tz, cy))
  const n = L.rooms.length
  const used = new Uint8Array(S * S)
  const vests = []
  const degree = new Int32Array(n)
  const linked = new Set()
  const free = (cand) => cand.cells.every((c) => !used[c])
  const take = (cand) => {
    for (const c of cand.cells) used[c] = 1
    vests.push(cand)
    degree[cand.a]++
    degree[cand.b]++
    linked.add(`${cand.a},${cand.b}`)
  }
  const pick = (list) => shuffled(r, list).find(free) ?? null
  const pairKey = (a, b) => `${Math.min(a, b)},${Math.max(a, b)}`
  // The bridges first: the only ways between parts of the block.
  for (const e of L.bridges) {
    const cand = pick(e.list)
    if (cand) take(cand)
  }
  // The chain: an iterative randomized DFS.
  const seen = new Uint8Array(n)
  const s0 = r(n)
  seen[s0] = 1
  const stack = [s0]
  while (stack.length) {
    const u = stack[stack.length - 1]
    let next = -1
    for (const e of shuffled(r, L.adj[u])) {
      if (seen[e.to]) continue
      if (!linked.has(pairKey(u, e.to))) {
        const cand = pick(e.list)
        if (!cand) continue
        take(cand)
      }
      next = e.to
      break
    }
    if (next < 0) stack.pop()
    else {
      seen[next] = 1
      stack.push(next)
    }
  }
  // Anything a crowded gap cut off: any free run from a reached room.
  for (let guard = 0; guard < n; guard++) {
    let added = false
    for (let u = 0; u < n && !added; u++) {
      if (!seen[u]) continue
      for (const e of L.adj[u]) {
        if (seen[e.to]) continue
        if (!linked.has(pairKey(u, e.to))) {
          const cand = e.list.find(free)
          if (!cand) continue
          take(cand)
        }
        seen[e.to] = 1
        added = true
        break
      }
    }
    if (!added) break
  }
  // Still cut off (a crowded storey): a bent corridor through the cells this
  // storey leaves free.
  for (let guard = 0; guard < n; guard++) {
    const of = new Int32Array(n).fill(1)
    for (let u = 0; u < n; u++) if (seen[u]) of[u] = 0
    if (of.every((c) => c === 0)) break
    const occ = layoutOcc(L)
    for (let c = 0; c < S * S; c++) if (used[c] && occ[c] === FREE) occ[c] = RING
    const bent = bentCorridor(occ, stubCells(L), L.rooms, of, (x, z) => z * S + x)
    if (!bent) break
    take(bent)
    for (const u of [bent.a, bent.b]) seen[u] = 1
    // Everything linked to a newly reached room is reached too.
    for (let grow = true; grow;) {
      grow = false
      for (const v of vests) {
        if (seen[v.a] !== seen[v.b]) {
          seen[v.a] = seen[v.b] = 1
          grow = true
        }
      }
    }
  }
  const missing = []
  for (let u = 0; u < n; u++) if (!seen[u]) missing.push(u)
  // Loops: a hashed share of the dead-end galleries gets a second link, and
  // the flavour's extra cross links.
  const extra = (u, hallsFirst = false) => {
    let order = shuffled(r, L.adj[u])
    if (hallsFirst) order = [...order.filter((e) => L.rooms[e.to].kind === 'hall'), ...order.filter((e) => L.rooms[e.to].kind !== 'hall')]
    for (const e of order) {
      const key = `${Math.min(u, e.to)},${Math.max(u, e.to)}`
      if (linked.has(key)) continue
      const cand = pick(e.list)
      if (!cand) continue
      take(cand)
      return true
    }
    return false
  }
  for (let u = 0; u < n; u++) if (degree[u] === 1) extra(u, true)
  const extras = r(L.extra + 1)
  for (let t = 0; t < extras; t++) extra(r(n))
  // Closets: a niche off a vestibule cell, a lectern in some.
  const closets = []
  const at = (x, z) => z * S + x
  const occupied = (x, z) => {
    if (x < 0 || z < 0 || x >= LAST || z >= LAST) return true
    const c = at(x, z)
    if (used[c]) return true
    for (const room of L.rooms) if (x >= room.x0 && x <= room.x1 && z >= room.z0 && z <= room.z1) return true
    for (const st of L.stubs) if (st.cells.includes(c)) return true
    return false
  }
  for (const v of vests) {
    if (!v.cells.length || r(100) >= L.closet) continue
    const c = v.cells[r(v.cells.length)]
    const x = c % S
    const z = Math.floor(c / S)
    for (const [dx, dz] of shuffled(r, DIRS)) {
      if (occupied(x + dx, z + dz)) continue
      const cell = at(x + dx, z + dz)
      used[cell] = 1
      closets.push({ cell, door: edgeBetween(x, z, x + dx, z + dz), lectern: r(100) < L.lectern })
      break
    }
  }
  // The stubs of the ports open on this storey (and the stubs they merge into).
  const open = new Set()
  for (const st of L.stubs) {
    const side = st.side === 'west' || st.side === 'north' ? st.side : st.side === 'east' ? 'west' : 'north'
    const tx = st.side === 'east' ? k.tx + 1 : k.tx
    const tz = st.side === 'south' ? k.tz + 1 : k.tz
    if (!openSeamPorts(seed, tx, tz, side, cy).includes(st.a)) continue
    for (let s = st.n, guard = 0; s >= 0 && guard < 8; s = L.stubs[s].via, guard++) open.add(s)
  }
  return deepFreeze({ vests, closets, stubs: [...open].sort((a, b) => a - b), missing, degree: [...degree] })
}

// --- anomalies -------------------------------------------------------------------------------

// Doc §10: one anomaly per 40 galleries. A block-band holds G galleries × 5
// storeys; it carries floor(5G / 40) picks plus one more with probability
// (5G mod 40) / 40, so the rate is exactly 1 in 40 gallery-storeys, hashed
// from the world seed and the block's coordinates. A blocked slot (spawn
// storeys −1..1 within one block of the spawn block, the exit gallery) scans
// on to the next allowed slot with wrap-around. A band's picks take
// different classes in turn.
//   'dark'     every globe out: the only darkness in the library;
//   'empty'    no shelves (bare walls, open corners);
//   'crimson'  red lamps in a gallery that is not the exit (never in the
//              exit block).
// Plus 'noShaft', per block-band with p = 1/40: the volume keeps its links
// but its levels list no voids (solid floors, the galleries otherwise
// unchanged). Anomalies never touch a wall, a door or a cell kind's
// walkability, so none can cut a route.
export const ANOMALY_CLASSES = Object.freeze(['dark', 'empty', 'crimson'])
export const ANOMALY_ONE_IN = 40
export const NO_SHAFT_ONE_IN = 40
const ANOMALY_SALT = 0x0ba40a1f
const NO_SHAFT_SALT = 0x0ba5f7ed

const nearSpawn = (tx, tz) => Math.max(Math.abs(tx), Math.abs(tz)) <= 1

export function noShaftAt(worldSeed, k) {
  const seed = worldSeed >>> 0
  if (nearSpawn(k.tx, k.tz) && k.cy0 <= 1 && k.cy1 >= -1) return false
  const ex = exitTileOf(seed)
  if (ex.tx === k.tx && ex.tz === k.tz) return false
  return hashChain((seed ^ NO_SHAFT_SALT) | 0, k.tx, k.tz, k.band) % NO_SHAFT_ONE_IN === 0
}

const PICK_MEMO = new Map()
const PICK_MEMO_MAX = 4096

// The picks of block-band k: [{ n (room index), cy, cls }].
export function bandAnomalyPicks(worldSeed, k) {
  const seed = worldSeed >>> 0
  const key = `${seed}|${k.tx},${k.tz},${k.band}`
  const hit = PICK_MEMO.get(key)
  if (hit) return hit
  const L = layoutOf(seed, k)
  const G = L.galleries.length
  const N = k.cy1 - k.cy0 + 1
  const slots = G * N
  const ex = exitAnchorGallery(seed)
  const exitTile = ex.tx === k.tx && ex.tz === k.tz
  const slotOf = (s) => ({ n: L.galleries[s % G], cy: k.cy0 + Math.floor(s / G) })
  const allowed = (s) => {
    const g = slotOf(s)
    if (nearSpawn(k.tx, k.tz) && g.cy >= -1 && g.cy <= 1) return false
    return !(exitTile && g.n === ex.n && g.cy === ex.cy)
  }
  const h = hashChain((seed ^ ANOMALY_SALT) | 0, k.tx, k.tz, k.band)
  const count = Math.floor(slots / ANOMALY_ONE_IN) + ((h >>> 4) % ANOMALY_ONE_IN < slots % ANOMALY_ONE_IN ? 1 : 0)
  const classes = exitTile ? ['dark', 'empty'] : ANOMALY_CLASSES
  const c0 = (h >>> 16) % classes.length
  const out = []
  const taken = new Set()
  for (let t = 0; t < count && slots; t++) {
    let s = hashChain((seed ^ ANOMALY_SALT) | 0, k.tx, k.tz, k.band, t) % slots
    let tries = 0
    while ((!allowed(s) || taken.has(s)) && tries < slots) {
      s = (s + 1) % slots
      tries++
    }
    if (tries >= slots) break
    taken.add(s)
    out.push(Object.freeze({ ...slotOf(s), cls: classes[(c0 + t) % classes.length] }))
  }
  const list = Object.freeze(out)
  PICK_MEMO.set(key, list)
  if (PICK_MEMO.size > PICK_MEMO_MAX) PICK_MEMO.delete(PICK_MEMO.keys().next().value)
  return list
}

// The anomaly class of room n of block-band k on GLOBAL storey cy, or null.
export function anomalyAt(worldSeed, k, n, cy) {
  return bandAnomalyPicks(worldSeed, k).find((p) => p.n === n && p.cy === cy)?.cls ?? null
}

// The 'dark' anomaly rooms of block-band k as GLOBAL rects with their
// storey: [{ cy, x0, z0, x1, z1 }] (the fill light leaves them dark).
export function darkRooms(worldSeed, k) {
  const picks = bandAnomalyPicks(worldSeed, k).filter((p) => p.cls === 'dark')
  if (!picks.length) return []
  const L = layoutOf(worldSeed, k)
  const ox = k.origin.cx * CHUNK
  const oz = k.origin.cz * CHUNK
  return picks.map((p) => {
    const room = L.rooms[p.n]
    return { cy: p.cy, x0: room.x0 + ox, z0: room.z0 + oz, x1: room.x1 + ox, z1: room.z1 + oz }
  })
}

// --- the volume ----------------------------------------------------------------------------

// The block-band's shaft voids, GLOBAL cells: level 0 (the band's base
// storey) is the shafts' floor; levels 1..4 list every room's shafts in
// room order (the 'noShaft' anomaly: none).
export function babelVoids(worldSeed, k) {
  const ox = k.origin.cx * CHUNK
  const oz = k.origin.cz * CHUNK
  const shafts = noShaftAt(worldSeed, k)
    ? []
    : layoutOf(worldSeed, k).rooms.flatMap((room) => room.shafts.map((s) => ({ x0: s.x0 + ox, z0: s.z0 + oz, x1: s.x1 + ox, z1: s.z1 + oz })))
  return Array.from({ length: k.cy1 - k.cy0 + 1 }, (_, n) => (n ? shafts.map((v) => ({ ...v })) : []))
}

// One block's catalog volume draft (catalog/engine.js assembleCatalogDescriptor's
// shape, key order included): every shaft a void on the levels above the
// first, the stair flights the plan chose. The finite kind (family 'hotel')
// and the world (family 'babel', the planner at true global coordinates and
// the tile program kind-locally) build it here. Not frozen, not analysed.
export function shaftDraft({ id, family, bounds, levels, links, district, bandIndex = 0, slot = -1, baseCy = 0 }) {
  const participants = participantsForBounds(bounds)
  return {
    id,
    hasRoom: true,
    family,
    kind: CATALOG_KINDS[family],
    type: 'babelShafts',
    sizeClass: 'large',
    label: 'Babel shafts',
    district,
    bandIndex,
    slot,
    baseCy,
    bottomCy: baseCy,
    topCy: baseCy + levels.length - 1,
    levelCount: levels.length,
    height: levels.length,
    anchor: { ...participants[0] },
    participants,
    participantChunks: participants.map((p) => ({ ...p })),
    globalBounds: { ...bounds },
    bridgeAxis: 'x',
    glazing: 'rail',
    levels: levels.map((voids, k) => ({ levelCy: baseCy + k, voids: k ? voids : [], bridges: [] })),
    columns: [],
    piers: [],
    core: null,
    verticalLinks: [...links].sort((a, b) => a.lowerCy - b.lowerCy || a.cz - b.cz || a.cx - b.cx),
    deviation: null,
  }
}

// The planner's descriptor of block-band k (GLOBAL), frozen, or null when it
// fails analysis (never, measured; the harness asserts 0 nulls). Every
// verdict rule is relative to the bounds, chunk-local or per level, so the
// verdict is invariant under a chunk-aligned translation in x/z and a shift
// in y: memoised by the tile-local signature (voids, links).
const VERDICTS = new Map()
const VERDICTS_MAX = 4096
export function volumeOf(worldSeed, k, id) {
  const ox = k.origin.cx * CHUNK
  const oz = k.origin.cz * CHUNK
  const draft = shaftDraft({
    id,
    family: FAMILY,
    bounds: { x0: ox + BLOCK_BOUNDS.x0, z0: oz + BLOCK_BOUNDS.z0, x1: ox + BLOCK_BOUNDS.x1, z1: oz + BLOCK_BOUNDS.z1 },
    levels: babelVoids(worldSeed, k),
    links: babelFlights(worldSeed, k),
    district: { x: k.tx, z: k.tz, size: TILE.w },
    bandIndex: k.band,
    slot: 0,
    baseCy: k.cy0,
  })
  const sig = `${draft.levels.length}|${(draft.levels[1]?.voids ?? []).map((v) => `${v.x0 - ox},${v.z0 - oz},${v.x1 - ox},${v.z1 - oz}`).join(';')}|${draft.verticalLinks
    .map((l) => `${l.lowerCy - k.cy0},${l.cx - k.origin.cx},${l.cz - k.origin.cz},${l.stair.dir},${l.stair.landing.lx},${l.stair.landing.lz}`)
    .join(';')}`
  let ok = VERDICTS.get(sig)
  if (ok === undefined) {
    VERDICTS.set(sig, (ok = analyzeCatalogDescriptor(draft).ok))
    if (VERDICTS.size > VERDICTS_MAX) VERDICTS.delete(VERDICTS.keys().next().value)
  }
  return ok ? deepFreeze(draft) : null
}

// --- spawn and exit ------------------------------------------------------------------------------

// §12.5 spawn: block (0,0), storey 0, the stair hall of chunk (0,0) (the
// kind's site on every slab), off the flight's strip (row 6): the hall's
// south and north rows, centre first. Chunk-local cells (= global, chunk (0,0)).
export const SPAWN_CELLS = Object.freeze(
  [[8, 7], [9, 7], [8, 5], [9, 5], [7, 7], [10, 7], [7, 5], [10, 5]].map(([lx, lz]) => Object.freeze({ lx, lz })),
)

// The 40 blocks at Chebyshev distance 2..3 from block (0,0).
const EXIT_RING = Object.freeze((() => {
  const out = []
  for (let tz = -3; tz <= 3; tz++) {
    for (let tx = -3; tx <= 3; tx++) {
      const d = Math.max(Math.abs(tx), Math.abs(tz))
      if (d >= 2 && d <= 3) out.push(Object.freeze({ tx, tz }))
    }
  }
  return out
})())

const EXIT_SALT = 0x0bae0e17
export const EXIT_STOREY_MIN = 2
export const EXIT_STOREY_MAX = 6

// The exit block (Chebyshev 2..3 from the spawn block), hashed.
export function exitTileOf(worldSeed) {
  return EXIT_RING[hashChain(((worldSeed >>> 0) ^ EXIT_SALT) | 0, 0x71) % EXIT_RING.length]
}

// The exit storey: ±(2..6), hashed.
export function exitStorey(worldSeed) {
  const h = hashChain(((worldSeed >>> 0) ^ EXIT_SALT) | 0, 0x72)
  const n = EXIT_STOREY_MIN + (h % (EXIT_STOREY_MAX - EXIT_STOREY_MIN + 1))
  return (h >>> 16) & 1 ? n : -n
}

// The Crimson Hexagon: one of the exit block-band's shafted galleries, on
// the exit storey. { tx, tz, cy, n (room index), x0, z0, x1, z1, shaft }
// (GLOBAL cells).
export function exitAnchorGallery(worldSeed) {
  const seed = worldSeed >>> 0
  const t = exitTileOf(seed)
  const cy = exitStorey(seed)
  const k = keyAt(t.tx, t.tz, cy)
  const L = layoutOf(seed, k)
  const list = L.rooms.filter((g) => g.kind === 'gallery')
  const pool = list.length ? list : L.rooms.filter((g) => g.kind !== 'hall')
  const g = pool[hashChain((seed ^ EXIT_SALT) | 0, 0x73) % pool.length]
  const ox = k.origin.cx * CHUNK
  const oz = k.origin.cz * CHUNK
  const s = g.shafts[0] ?? null
  return {
    tx: t.tx, tz: t.tz, cy, n: g.n,
    x0: g.x0 + ox, z0: g.z0 + oz, x1: g.x1 + ox, z1: g.z1 + oz,
    shaft: s ? { x0: s.x0 + ox, z0: s.z0 + oz, x1: s.x1 + ox, z1: s.z1 + oz } : null,
  }
}

// The exit cells of the Crimson Hexagon (GLOBAL): the walkway cell west of
// its shaft first (the bake marks it), then the rest of the walkway, nearest
// first. Never a shaft cell.
export function exitCellsOf(g) {
  const s = g.shaft
  const first = s ? { gx: s.x0 - 1, gz: s.z0 } : { gx: g.x0 + 1, gz: g.z0 + 1 }
  const out = []
  for (let gz = g.z0; gz <= g.z1; gz++) {
    for (let gx = g.x0; gx <= g.x1; gx++) {
      if (s && gx >= s.x0 && gx <= s.x1 && gz >= s.z0 && gz <= s.z1) continue
      out.push({ gx, gz, cy: g.cy, d: Math.abs(gx - first.gx) + Math.abs(gz - first.gz) })
    }
  }
  out.sort((a, b) => a.d - b.d || a.gz - b.gz || a.gx - b.gx)
  return out.slice(0, 8).map(({ gx, gz, cy }) => ({ gx, gz, cy }))
}

// §8.2 exit anchor: the cell the exit block's bake marks.
export function exitAnchor(worldSeed) {
  const c = exitCellsOf(exitAnchorGallery(worldSeed))[0]
  const cx = Math.floor(c.gx / CHUNK)
  const cz = Math.floor(c.gz / CHUNK)
  return { cx, cy: c.cy, cz, lx: c.gx - cx * CHUNK, lz: c.gz - cz * CHUNK }
}
