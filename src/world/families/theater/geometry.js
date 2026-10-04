import { CHUNK } from '../../constants.js'
import { hash3i } from '../../core/hash.js'
import { deepFreeze } from '../../mapFamily.js'
import { assembleCatalogDescriptor, coreDoor, switchbackCore } from '../../structures/catalog/engine.js'
import { MAP_FAMILY_THEATER } from '../ids.js'
import { FAMILY_SALT, hashChain, tileKeyAt, tileKeyOf, tileSeed } from '../../tiles/tileKey.js'

// The theater family's pure geometry (spec §3.3, §12.8; doc 11 §4): the
// PARTS CATALOGUE and the GRAMMAR that composes one theatre per world tile.
//
// Every tile is a different building. A tile's planSeed drives a seeded
// grammar (theatreScheme) that decides:
//   - the house volume (the 'theaterCatalog' structure, slot 0): its class
//     (opera house: two circles, proscenium house: one circle, small house:
//     none or one, 2×1 chunks), how many storeys it rises (3..5), its
//     participant chunks and their position in the 3×3-chunk tile, its
//     bounds (insets 1..3 per side), its orientation (one of the 8 grid
//     symmetries: the stage may face any way), the stage depth, the
//     proscenium opening, the orchestra pit, the stalls' gangways and cross
//     aisles, the fly tower's extent and its catwalks, the circles' depths,
//     boxes or open side galleries, and its stair core (searched over every
//     stair-safe placement, picked by the dice);
//   - the band around it (front of house on the house side, backstage on the
//     stage side): a strip decomposition of the rest of the tile (which
//     corner belongs to which strip is rolled), each strip a wing with a
//     corridor lane (position, width and extent rolled) between room bands,
//     and 0..2 enclosed backstage/front-of-house stairwells (basement to
//     first floor) on corridor-side stair slots;
//   - the exit cell (the trap room under its stage) and its spawn cells.
// The rooms inside the bands (sizes, types, halls, doors, dressing-room
// runs, furniture) are the per-storey infill (layout.js), rolled from the
// same seed. Sameness comes from repeated ELEMENTS (seat rows, doors every
// cell, ghost lights, the ring corridor), never from a repeated layout.
//
// Planner-chain module (§7.5): it may import only constants.js, core/hash.js,
// core/rng.js, mapTypes.js, mapFamily.js ({deepFreeze, MAP_FAMILY_CODES}),
// structures/catalog/engine.js, families/ids.js, tiles/tileKey.js and
// tiles/stubPlanner.js. Never tiles/stub.js, the canvas or the kit.
//
// Kind-local frame: storeys 0 basement (trap room), 1 ground (stalls),
// 2 first (dress circle, fly floor), 3 second (upper circle), 4 loft; cells
// x, z 0..41 (3×3 chunks). World tile = the same 3×3 chunks × storeys −1..3
// (origin.cy = −1): kind storey n is global storey n − 1.

export const FAMILY = MAP_FAMILY_THEATER

// The kind's dice salt (rng(seed, SALT) in tile.js / layout.js).
export const SALT = 0x0ba1

// Kind-local storeys.
export const BASE = 0
export const GROUND = 1
export const FIRST = 2
export const SECOND = 3
export const LOFT = 4
export const FLOORS = 5
// The band (front of house, backstage) fills every chunk of the tile on
// these storeys; above them only the house volume stands.
export const BAND_TOP = FIRST
// Backwards-compatible names (the kind's storeys).
export const TRAP = BASE
export const STALLS = GROUND

// The tile (§6.2, §12.8): 3×3 chunks, backend 'band', one band of five
// storeys (−1 basement … 3 loft). Salt = FAMILY_SALT.theater (0x5a170000 + 12).
export const TILE = Object.freeze({ w: 3, d: 3, backend: 'band', H: 5, lo: -1, hi: 3, salt: FAMILY_SALT.theater })
export const N = TILE.w * CHUNK // 42 cells a side
export const EDGE = N - 2 // 40: the last band cell; x/z 41 is the perimeter mass row (ports excepted)

// §7.2: the planner's attempt budget for the house volume (the core is
// fixed, so the pick is unused; one attempt suffices, the scheme validated).
export const PICK_ATTEMPTS = 1

export const R = (x0, z0, x1, z1) => ({ x0, z0, x1, z1 })
export const inRect = (r, gx, gz) => gx >= r.x0 && gx <= r.x1 && gz >= r.z0 && gz <= r.z1
const grow = (r, n) => R(r.x0 - n, r.z0 - n, r.x1 + n, r.z1 + n)
const overlaps = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1

// --- the parts catalogue -------------------------------------------------------------

// House classes (doc 11 §5): participants (canonical: long axis along the
// stage axis u), storeys, circles and the stage/opening ranges.
export const HOUSES = Object.freeze({
  opera: Object.freeze({ type: 'operaHouse', sizeClass: 'large', label: 'opera house', span: [2, 2], levels: [5, 5], circles: [2, 2], stage: [8, 10], opening: [5, 7] }),
  proscenium: Object.freeze({ type: 'prosceniumHouse', sizeClass: 'medium', label: 'proscenium house', span: [2, 2], levels: [4, 5], circles: [1, 1], stage: [7, 9], opening: [4, 6] }),
  small: Object.freeze({ type: 'smallHouse', sizeClass: 'small', label: 'small house', span: [2, 1], levels: [3, 4], circles: [0, 1], stage: [7, 9], opening: [3, 5] }),
})
// Shares (out of 20): opera 7, proscenium 8, small 5.
const HOUSE_ROLL = Object.freeze([['opera', 7], ['proscenium', 15], ['small', 20]])

// Room types of the band, per zone (front of house / backstage) and storey.
// The infill (layout.js) draws from these lists; the names are the notes'.
export const ROOM_TYPES = Object.freeze({
  foh: Object.freeze({
    [BASE]: Object.freeze(['cellar', 'boiler', 'store', 'cloak store']),
    [GROUND]: Object.freeze(['box office', 'cloakroom', 'bar', 'toilets', 'manager']),
    [FIRST]: Object.freeze(['circle bar', 'office', 'archive', 'salon']),
  }),
  boh: Object.freeze({
    [BASE]: Object.freeze(['band room', 'store', 'workshop', 'boiler']),
    [GROUND]: Object.freeze(['dressing', 'green room', 'wardrobe', 'prop store', 'stage door']),
    [FIRST]: Object.freeze(['dressing', 'rehearsal', 'wardrobe', 'office']),
  }),
})
export const HALL_TYPES = Object.freeze({
  foh: Object.freeze({ [BASE]: 'cistern', [GROUND]: 'lobby', [FIRST]: 'foyer' }),
  boh: Object.freeze({ [BASE]: 'understore', [GROUND]: 'scene dock', [FIRST]: 'paint frame' }),
})

// --- dice ------------------------------------------------------------------------------

// Sequential dice over one seed (pure: the call order is fixed).
export function dice(seed) {
  let n = 0
  const next = () => hash3i(seed | 0, n++, 0x6e7, 0x51) >>> 0
  return {
    next,
    int: (lo, hi) => (hi <= lo ? lo : lo + (next() % (hi - lo + 1))),
    chance: (p) => next() / 4294967296 < p,
    pick: (a) => a[next() % a.length],
  }
}

// The kind's dice, index-keyed: roll(seed, a, b) === rng(seed, SALT)(a, b)
// (tiles/floorPlan.js), without importing the floor-plan compiler.
export const roll = (seed, a, b = 0) => hash3i((seed ^ SALT) | 0, a | 0, b | 0, 0x51) >>> 0

// --- canonical frame -------------------------------------------------------------------

// The house is designed in a canonical frame — u along the stage axis (0 =
// back of the house, L − 1 = the back wall of the stage), v across (0..W−1)
// — and placed by one of the 8 grid symmetries: transpose `sw`, flips `fu`
// and `fv`, at bounds origin (bx0, bz0).
export function frameOf({ sw, fu, fv, bounds, L, W }) {
  const bx0 = bounds.x0
  const bz0 = bounds.z0
  const toTile = (u, v) => {
    const uu = fu ? L - 1 - u : u
    const vv = fv ? W - 1 - v : v
    return sw ? { gx: bx0 + vv, gz: bz0 + uu } : { gx: bx0 + uu, gz: bz0 + vv }
  }
  const toCanon = (gx, gz) => {
    const uu = sw ? gz - bz0 : gx - bx0
    const vv = sw ? gx - bx0 : gz - bz0
    return { u: fu ? L - 1 - uu : uu, v: fv ? W - 1 - vv : vv }
  }
  const rect = (u0, v0, u1, v1) => {
    const a = toTile(u0, v0)
    const b = toTile(u1, v1)
    return R(Math.min(a.gx, b.gx), Math.min(a.gz, b.gz), Math.max(a.gx, b.gx), Math.max(a.gz, b.gz))
  }
  // A canonical step (du, dv) as a tile step (dx, dz).
  const step = (du, dv) => {
    const o = toTile(0, 0)
    const t = toTile(du, dv)
    return { dx: t.gx - o.gx, dz: t.gz - o.gz }
  }
  return { toTile, toCanon, rect, step }
}

// A void or bridge edge may not lie on a chunk seam (engine.js): shrink.
const seamFix = (r) => {
  const x0 = r.x0 % CHUNK === 0 ? r.x0 + 1 : r.x0
  const z0 = r.z0 % CHUNK === 0 ? r.z0 + 1 : r.z0
  const x1 = (r.x1 + 1) % CHUNK === 0 ? r.x1 - 1 : r.x1
  const z1 = (r.z1 + 1) % CHUNK === 0 ? r.z1 - 1 : r.z1
  return R(x0, z0, x1, z1)
}
const onSeam = (line) => line % CHUNK === 0
const localOf = (g) => ((g % CHUNK) + CHUNK) % CHUNK

// --- the grammar: one theatre ------------------------------------------------------

// Seat blocks across the stalls: side aisles v 0 and W − 1, `g` inner
// gangways; blocks of 3..maxB cells.
function rollGangways(D, W, small) {
  const span = W - 2
  const maxB = small ? 10 : 8
  for (let t = 0; t < 24; t++) {
    const g = small ? D.int(0, 1) : D.int(1, 3)
    const cuts = []
    let ok = true
    let at = 1
    for (let i = 0; i < g; i++) {
      const left = span - (at - 1) - (g - i) // cells left after this cut's block
      const lo = at + 3
      const hi = Math.min(at + maxB, at + left - 3 * (g - i))
      if (hi < lo) {
        ok = false
        break
      }
      const c = D.int(lo, hi)
      cuts.push(c)
      at = c + 1
    }
    if (!ok) continue
    const blocks = []
    let b0 = 1
    for (const c of [...cuts, W - 1]) {
      blocks.push([b0, c - 1])
      b0 = c + 1
    }
    if (blocks.every(([a, b]) => b - a + 1 >= 3 && b - a + 1 <= maxB)) return { gangways: cuts, blocks }
  }
  // Even split (always valid for W ≥ 10).
  const mid = Math.floor(W / 2)
  return { gangways: [mid], blocks: [[1, mid - 1], [mid + 1, W - 2]] }
}

// One attempt at a theatre. Returns null when a rolled combination does not
// fit (the caller rolls again with the next attempt's dice).
function tryScheme(D, finite) {
  const r = D.int(0, 19)
  let house = HOUSE_ROLL.find(([, upTo]) => r < upTo)[0]
  if (finite && house === 'small') house = 'proscenium'
  const H = HOUSES[house]
  const NL = finite ? 5 : D.int(H.levels[0], H.levels[1])
  const circles = D.int(H.circles[0], H.circles[1])
  const sw = D.chance(0.5)
  const fu = D.chance(0.5)
  const fv = D.chance(0.5)
  const [spanU, spanV] = H.span
  const pw = sw ? spanV : spanU
  const pd = sw ? spanU : spanV
  const pcx = D.int(0, 3 - pw)
  const pcz = D.int(0, 3 - pd)
  const part = R(pcx * CHUNK, pcz * CHUNK, (pcx + pw) * CHUNK - 1, (pcz + pd) * CHUNK - 1)
  // Insets 1..3 per side; the ring never reaches the tile's east/south
  // perimeter row (x/z 41), so the inset there is at least 2.
  let iw = D.int(1, 3)
  let ie = D.int(part.x1 === N - 1 ? 2 : 1, 3)
  let inn = D.int(1, 3)
  let is = D.int(part.z1 === N - 1 ? 2 : 1, 3)
  if (house === 'small') {
    // The long axis keeps the ring off the chunk edge at both ends (room for
    // the stair core at the back of the house or the back of the stage).
    if (sw) {
      inn = Math.max(inn, 2)
      is = Math.max(is, 2)
    } else {
      iw = Math.max(iw, 2)
      ie = Math.max(ie, 2)
    }
    // The short axis keeps W ≥ 10.
    if (sw) {
      while (iw + ie > 4) {
        if (iw > 1) iw--
        else ie--
      }
    } else {
      while (inn + is > 4) {
        if (inn > 1) inn--
        else is--
      }
    }
  }
  const bounds = R(part.x0 + iw, part.z0 + inn, part.x1 - ie, part.z1 - is)
  const L = sw ? bounds.z1 - bounds.z0 + 1 : bounds.x1 - bounds.x0 + 1
  const W = sw ? bounds.x1 - bounds.x0 + 1 : bounds.z1 - bounds.z0 + 1
  const S = D.int(H.stage[0], H.stage[1])
  const P = L - S
  if (P < (house === 'small' ? 12 : 13)) return null
  const Ow = Math.min(D.int(H.opening[0], H.opening[1]), W - 6)
  if (Ow < 3) return null
  const o0 = Math.max(2, Math.min(W - Ow - 2, Math.floor((W - Ow) / 2) + D.int(-1, 1)))
  const o1 = o0 + Ow - 1
  const oc = Math.floor((o0 + o1) / 2)
  const pit = P >= 13 && D.chance(0.75)
    ? (() => {
      const pa = D.int(0, 1)
      return { u0: P - 3, u1: P - 2, v0: Math.max(1, o0 - pa), v1: Math.min(W - 2, o1 + pa) }
    })()
    : null
  const front = pit ? P - 4 : P - 2 // the front cross aisle
  const rows = front - 1 // stalls rows u 1..front − 1
  const mid = rows >= 9 && D.chance(0.6) ? D.int(4, front - 4) : -1
  const { gangways, blocks } = rollGangways(D, W, house === 'small')
  // Fly tower over the stage (levels 2..NL − 1).
  // (Downstage P + 1 and upstage L − 2 stay under a solid slab: the ghost
  // light's two places, a lamp in a ceiling.)
  const fly = { u0: P + D.int(2, 3), u1: L - 3, v0: Math.max(1, o0 - 1), v1: Math.min(W - 2, o1 + 1) }
  if (fly.u1 - fly.u0 < 2) return null
  // Circles: the dress circle (level 2) and the upper circle (level 3).
  let dress = null
  let upper = null
  let boxes = false
  let sideW = 0
  if (circles >= 1) {
    const dd = house === 'small' ? 3 : D.int(3, 5)
    sideW = house === 'small' ? D.int(1, 2) : D.int(2, 4)
    if (W - 2 * sideW < 4) sideW = Math.floor((W - 4) / 2)
    dress = { u0: dd, u1: P - 2, v0: sideW, v1: W - 1 - sideW }
    if (dress.u1 - dress.u0 < 3 || dress.v1 - dress.v0 < 3) return null
    boxes = sideW >= 3 && D.chance(0.6)
  }
  if (circles >= 2) {
    const du = Math.max(2, Math.min(P - 6, dress.u0 + D.int(-1, 2)))
    const sv = Math.max(1, Math.min(Math.floor((W - 5) / 2), sideW + D.int(-1, 1)))
    upper = { u0: du, u1: P - 2, v0: sv, v1: W - 1 - sv }
  }
  // Catwalks across the fly void on the levels above the fly floor.
  const catwalks = []
  for (let k = 3; k < NL; k++) if (D.chance(0.7)) catwalks.push({ k, u: D.int(fly.u0 + 1, fly.u1 - 1) })
  const understalls = D.chance(0.6) ? 'rooms' : 'store'
  const propRoom = D.chance(0.6) ? (D.chance(0.5) ? 1 : -1) : 0
  const scheme = {
    house, NL, circles, sw, fu, fv, part, bounds, L, W, S, P, Ow, o0, o1, oc,
    pit, front, mid, gangways, blocks, fly, dress, upper, boxes, sideW, catwalks, understalls, propRoom,
  }
  const F = frameOf(scheme)
  // --- the volume in the tile frame -------------------------------------------------
  const levels = []
  for (let k = 0; k < NL; k++) {
    const voids = []
    const bridges = []
    if (k === 1 && pit) voids.push(seamFix(F.rect(pit.u0, pit.v0, pit.u1, pit.v1)))
    if (k >= 2) {
      const hv = k === 2 ? dress : k === 3 ? upper : null
      if (hv) voids.push(seamFix(F.rect(hv.u0, hv.v0, hv.u1, hv.v1)))
      const host = seamFix(F.rect(fly.u0, fly.v0, fly.u1, fly.v1))
      voids.push(host)
      const cw = catwalks.find((c) => c.k === k)
      if (cw) {
        // A catwalk at canonical u spans the void across v: along z (sw
        // false) or along x (sw true); its flank lines may not be seams.
        const t = F.toTile(cw.u, fly.v0)
        if (!sw) {
          let x = Math.max(host.x0, Math.min(host.x1, t.gx))
          for (const dx of [0, 1, -1, 2, -2]) {
            const xx = x + dx
            if (xx >= host.x0 && xx <= host.x1 && !onSeam(xx) && !onSeam(xx + 1)) {
              x = xx
              bridges.push(R(x, host.z0, x, host.z1))
              break
            }
          }
        } else {
          let z = Math.max(host.z0, Math.min(host.z1, t.gz))
          for (const dz of [0, 1, -1, 2, -2]) {
            const zz = z + dz
            if (zz >= host.z0 && zz <= host.z1 && !onSeam(zz) && !onSeam(zz + 1)) {
              z = zz
              bridges.push(R(host.x0, z, host.x1, z))
              break
            }
          }
        }
      }
    }
    for (const v of voids) if (v.x1 < v.x0 || v.z1 < v.z0) return null
    levels.push({ voids, bridges })
  }
  // Stage piers in the trap room (level 0): the fly footprint's corners.
  const columns = []
  for (const [u, v] of [[fly.u0, fly.v0], [fly.u0, fly.v1], [fly.u1, fly.v0], [fly.u1, fly.v1]]) {
    const c = F.toTile(u, v)
    const lx = localOf(c.gx)
    const lz = localOf(c.gz)
    if (lx === 0 || lx === CHUNK - 1 || lz === 0 || lz === CHUNK - 1) continue
    if (!inRect(grow(bounds, -1), c.gx, c.gz)) continue
    columns.push({ gx: c.gx, gz: c.gz })
  }
  scheme.levels = levels
  scheme.columns = columns
  const core = searchCore(D, scheme, F)
  if (!core) return null
  scheme.core = core
  scheme.coreRect = switchbackCore(core.gx, core.gz, core.dir, core.side).rect
  scheme.coreDoor = coreDoor({ rect: scheme.coreRect, dir: core.dir, doorSide: core.doorSide })
  // The volume must assemble (the planner assembles the same plan at true
  // global coordinates; seams are translation-invariant by whole tiles).
  if (!assembleCatalogDescriptor(housePlan(scheme), metaOf(scheme, 0x0ba10001, 0), () => 0)) return null
  // --- the band skeleton -----------------------------------------------------------
  scheme.skeleton = skeletonOf(D, scheme, F)
  // --- spawn and exit cells ---------------------------------------------------------
  scheme.spawnCells = spawnCellsOf(scheme, F)
  scheme.exitCells = exitCellsOf(scheme, F)
  if (!scheme.spawnCells.length || !scheme.exitCells.length) return null
  return scheme
}

// The level class of tile cell (gx, gz) on volume level k: 'out' (outside
// the carve box), 'ring', 'solid' (footprint floor), 'void', 'bridge' or
// 'column' (a level-0 stage pier).
export function volumeClass(scheme, k, gx, gz) {
  const b = scheme.bounds
  if (!inRect(grow(b, 1), gx, gz)) return 'out'
  if (!inRect(b, gx, gz)) return 'ring'
  if (k === 0 && scheme.columns.some((c) => c.gx === gx && c.gz === gz)) return 'column'
  const level = scheme.levels[k]
  if (level.voids.some((r) => inRect(r, gx, gz))) return level.bridges.some((r) => inRect(r, gx, gz)) ? 'bridge' : 'void'
  return 'solid'
}

// The volume's stair core: every switchback core (6×4 with its halo) whose
// rect sits in one chunk's [1..12]², inside the carve box, on stair-safe
// cells of every level, in the stage zone or the back of the house (never in
// front of the proscenium opening), with its door opening onto walkable
// floor on every level. The dice pick among them (the stage side first).
function searchCore(D, s, F) {
  const box = grow(s.bounds, 1)
  const w = box.x1 - box.x0 + 1
  const h = box.z1 - box.z0 + 1
  const ok = new Uint8Array(w * h)
  const idx = (gx, gz) => (gz - box.z0) * w + (gx - box.x0)
  const zone = new Uint8Array(w * h) // 1 stage side, 2 back of house
  // A catwalk lands on floor at both ends: never on the core.
  const landings = new Set()
  for (const level of s.levels) {
    for (const br of level.bridges) {
      if (br.z0 === br.z1) landings.add(`${br.x0 - 1},${br.z0}`).add(`${br.x1 + 1},${br.z0}`)
      else landings.add(`${br.x0},${br.z0 - 1}`).add(`${br.x0},${br.z1 + 1}`)
    }
  }
  for (let gz = box.z0; gz <= box.z1; gz++) {
    for (let gx = box.x0; gx <= box.x1; gx++) {
      let safe = !landings.has(`${gx},${gz}`)
      for (let k = 0; k < s.NL && safe; k++) {
        const c = volumeClass(s, k, gx, gz)
        if (c !== 'ring' && c !== 'solid') safe = false
      }
      const { u, v } = F.toCanon(gx, gz)
      const stage = u >= s.P
      const back = u <= 2
      const opening = u >= s.P && u <= s.P + 1 && v >= s.o0 - 1 && v <= s.o1 + 1
      if (safe && !opening && (stage || back)) ok[idx(gx, gz)] = 1
      zone[idx(gx, gz)] = stage ? 1 : back ? 2 : 0
    }
  }
  const upperLevels = s.NL - 1 > BAND_TOP
  const walkOn = (gx, gz) => {
    if (!inRect(box, gx, gz)) return false
    for (let k = 0; k < s.NL; k++) {
      const c = volumeClass(s, k, gx, gz)
      if (c !== 'ring' && c !== 'solid' && c !== 'bridge') return false
    }
    // Above the band storeys only the house's own chunks stand: a ring cell
    // on the participant box's last line faces a solid chunk there and is
    // mass (layout.js volumeLevel, the perimeter rule), so a core reaching
    // those storeys never opens onto it.
    if (upperLevels && (gx === s.part.x1 || gz === s.part.z1)) return false
    const { u, v } = F.toCanon(gx, gz)
    // Never the front stalls or the pit approach: the ring, the stage, the
    // back aisle or the last rows (the infill keeps a seatless way from the
    // door to an aisle).
    if (u >= 4 && u < s.P && v >= 1 && v <= s.W - 2) return false
    return true
  }
  // Prefix sums of `ok` over the carve box: a 6×4 or 4×6 rect is stair-safe
  // when its sum is its area.
  const ps = new Int32Array((w + 1) * (h + 1))
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) ps[(z + 1) * (w + 1) + x + 1] = ok[z * w + x] + ps[z * (w + 1) + x + 1] + ps[(z + 1) * (w + 1) + x] - ps[z * (w + 1) + x]
  }
  const sum = (x0, z0, x1, z1) => {
    const a = x0 - box.x0
    const b = z0 - box.z0
    const c = x1 - box.x0 + 1
    const d = z1 - box.z0 + 1
    return ps[d * (w + 1) + c] - ps[b * (w + 1) + c] - ps[d * (w + 1) + a] + ps[b * (w + 1) + a]
  }
  const stageList = []
  const backList = []
  for (const horizontal of [true, false]) {
    const rw = horizontal ? 6 : 4
    const rh = horizontal ? 4 : 6
    for (let z0 = box.z0; z0 + rh - 1 <= box.z1; z0++) {
      for (let x0 = box.x0; x0 + rw - 1 <= box.x1; x0++) {
        const r = R(x0, z0, x0 + rw - 1, z0 + rh - 1)
        const cx = Math.floor(r.x0 / CHUNK)
        const cz = Math.floor(r.z0 / CHUNK)
        if (Math.floor(r.x1 / CHUNK) !== cx || Math.floor(r.z1 / CHUNK) !== cz) continue
        if (localOf(r.x0) < 1 || localOf(r.z0) < 1 || localOf(r.x1) > CHUNK - 2 || localOf(r.z1) > CHUNK - 2) continue
        // Clear of the perimeter column/row (x/z 40 stays band or ring, so an
        // east/south port always has a walkable cell to join).
        if (r.x1 > EDGE - 1 || r.z1 > EDGE - 1) continue
        if (sum(r.x0, r.z0, r.x1, r.z1) !== rw * rh) continue
        let zs = 0
        for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) zs |= zone[idx(x, z)]
        if (zs === 3) continue
        // The four switchback cores with this rect (engine.js switchbackCore).
        const cores = horizontal
          ? [[x0 + 1, z0 + 1, 1, 1], [x0 + 1, z0 + 2, 1, -1], [x0 + 4, z0 + 1, 3, 1], [x0 + 4, z0 + 2, 3, -1]]
          : [[x0 + 1, z0 + 1, 2, 1], [x0 + 2, z0 + 1, 2, -1], [x0 + 1, z0 + 4, 0, 1], [x0 + 2, z0 + 4, 0, -1]]
        for (const doorSide of ['near', 'far']) {
          const door = coreDoor({ rect: r, dir: horizontal ? 1 : 2, doorSide })
          if (!walkOn(door.outside.gx, door.outside.gz)) continue
          for (const [gx, gz, dir, side] of cores) {
            const c = { gx, gz, dir, side, enclosed: true, doorSide }
            ;(zs & 1 ? stageList : backList).push(c)
          }
        }
      }
    }
  }
  const list = stageList.length && (D.chance(0.8) || !backList.length) ? stageList : backList
  return list.length ? D.pick(list) : null
}

// The house plan (assembleCatalogDescriptor's `plan`), kind-local.
export function housePlan(scheme) {
  return {
    label: HOUSES[scheme.house].label,
    bounds: scheme.bounds,
    levels: scheme.levels,
    glazing: 'rail',
    columns: scheme.columns,
    piers: [],
    core: scheme.core,
  }
}

// The planner meta of the house volume (kind-local baseCy 0).
export function metaOf(scheme, id, slot, family = FAMILY) {
  const h = HOUSES[scheme.house]
  return { id, family, type: h.type, sizeClass: h.sizeClass, district: { x: 0, z: 0, size: TILE.w }, bandIndex: 0, slot, baseCy: BASE }
}

// §6.5 volume-shaping rolls in tile mode: the scheme's house. Returns
// { plan, baseCy, type, sizeClass }, kind-local.
export function volumePlan(slot, scheme) {
  if (slot !== 0 || !scheme) return null
  const h = HOUSES[scheme.house]
  return { plan: housePlan(scheme), baseCy: BASE, type: h.type, sizeClass: h.sizeClass }
}

// --- the band skeleton -----------------------------------------------------------------

// The rest of the tile ([0..40]² outside the volume's carve box) as strips —
// north/south (full width unless a corner is given away) and west/east —
// each a wing: a corridor lane between room bands. Shared by the basement,
// ground and first storeys (corridors stack); the rooms are per storey.
function skeletonOf(D, s, F) {
  const hole = grow(s.bounds, 1)
  const has = { n: hole.z0 >= 1, s: hole.z1 <= EDGE - 1, w: hole.x0 >= 1, e: hole.x1 <= EDGE - 1 }
  const corner = (a, b) => (has[a] && has[b] ? (D.chance(0.5) ? a : b) : null)
  const nw = corner('n', 'w')
  const ne = corner('n', 'e')
  const sw = corner('s', 'w')
  const se = corner('s', 'e')
  const strips = []
  if (has.n) strips.push({ side: 'n', rect: R(nw === 'n' ? 0 : hole.x0, 0, ne === 'n' ? EDGE : hole.x1, hole.z0 - 1) })
  if (has.s) strips.push({ side: 's', rect: R(sw === 's' ? 0 : hole.x0, hole.z1 + 1, se === 's' ? EDGE : hole.x1, EDGE) })
  if (has.w) strips.push({ side: 'w', rect: R(0, nw === 'w' ? 0 : hole.z0, hole.x0 - 1, sw === 'w' ? EDGE : hole.z1) })
  if (has.e) strips.push({ side: 'e', rect: R(hole.x1 + 1, ne === 'e' ? 0 : hole.z0, EDGE, se === 'e' ? EDGE : hole.z1) })
  // A corner neither strip owns (one side missing) stays with whoever has it:
  // with only one of the two sides, the strip of that side spans to the edge.
  for (const st of strips) {
    if (st.side === 'n' || st.side === 's') {
      if (!has.w) st.rect.x0 = 0
      if (!has.e) st.rect.x1 = EDGE
    } else {
      if (!has.n) st.rect.z0 = 0
      if (!has.s) st.rect.z1 = EDGE
    }
  }
  for (const st of strips) {
    const r = st.rect
    const wx = r.x1 - r.x0 + 1
    const wz = r.z1 - r.z0 + 1
    // The long axis runs along the hole for side strips.
    st.axis = st.side === 'n' || st.side === 's' ? 'x' : 'z'
    if (st.axis === 'x' && wz > wx) st.axis = 'z'
    if (st.axis === 'z' && wx > wz) st.axis = 'x'
    st.len = st.axis === 'x' ? wx : wz
    st.t = st.axis === 'x' ? wz : wx
    // Lane options: corridor width 1 (2 on thick strips) at an offset that
    // leaves room bands of 0 or ≥ 2 cells.
    const opts = []
    if (st.t <= 2) opts.push([0, st.t])
    else {
      for (const cw of st.t >= 7 ? [1, 2] : [1]) {
        for (let c0 = 0; c0 + cw <= st.t; c0++) {
          const d1 = c0
          const d2 = st.t - c0 - cw
          if ((d1 === 0 || d1 >= 2) && (d2 === 0 || d2 >= 2) && d1 + d2 > 0) opts.push([c0, cw])
        }
      }
    }
    const [c0, cw] = D.pick(opts)
    st.lane = { c0, cw }
    // The corridor runs [a0, a1] along the strip; the lane's ends beyond it
    // belong to the end rooms (dead ends, no through corridor).
    const trim = Math.max(0, Math.min(3, Math.floor(st.len / 6)))
    st.lane.a0 = D.int(0, trim)
    st.lane.a1 = st.len - 1 - D.int(0, trim)
    st.bands = []
    if (c0 > 0) st.bands.push({ b0: 0, b1: c0 - 1, near: c0 - 1 })
    if (c0 + cw < st.t) st.bands.push({ b0: c0 + cw, b1: st.t - 1, near: c0 + cw })
    if (st.t <= 2) st.lane.a0 = 0
    if (st.t <= 2) st.lane.a1 = st.len - 1
  }
  // Stair slots: 6 along × 4 deep on a band's corridor side, in one band
  // chunk (never a volume participant), local [1..12] (≤ 11 on the tile's
  // last chunk column/row, clear of the perimeter), the door on the corridor.
  const partChunk = (cx, cz) => cx >= s.part.x0 / CHUNK && cx <= s.part.x1 / CHUNK && cz >= s.part.z0 / CHUNK && cz <= s.part.z1 / CHUNK
  const slots = []
  for (const [si, st] of strips.entries()) {
    for (const band of st.bands) {
      const depth = band.b1 - band.b0 + 1
      if (depth < 4) continue
      const towardLane = band.near === band.b0 ? 1 : -1 // across direction away from the lane
      const across0 = band.near === band.b0 ? band.b0 : band.b1 - 3
      for (let a = st.lane.a0; a + 5 <= st.lane.a1; a++) {
        // Room on at least one side for the leftover cells behind the stair.
        if (depth > 4 && a < 2 && a + 6 > st.len - 2) continue
        const rect = st.axis === 'x'
          ? R(st.rect.x0 + a, st.rect.z0 + across0, st.rect.x0 + a + 5, st.rect.z0 + across0 + 3)
          : R(st.rect.x0 + across0, st.rect.z0 + a, st.rect.x0 + across0 + 3, st.rect.z0 + a + 5)
        const cx = Math.floor(rect.x0 / CHUNK)
        const cz = Math.floor(rect.z0 / CHUNK)
        if (Math.floor(rect.x1 / CHUNK) !== cx || Math.floor(rect.z1 / CHUNK) !== cz) continue
        if (localOf(rect.x0) < 1 || localOf(rect.z0) < 1 || localOf(rect.x1) > CHUNK - 2 || localOf(rect.z1) > CHUNK - 2) continue
        if (rect.x1 > EDGE - 1 || rect.z1 > EDGE - 1) continue
        if (partChunk(cx, cz)) continue
        // The door side: the lane side of the rect (towardLane = +1 → the
        // lane is on the low side of the band).
        const laneLow = towardLane === 1
        let plan
        if (st.axis === 'x') {
          const east = D.chance(0.5)
          plan = { gx: east ? rect.x0 + 1 : rect.x0 + 4, gz: rect.z0 + 1, dir: east ? 1 : 3, doorSide: laneLow ? 'near' : 'far' }
        } else {
          const south = D.chance(0.5)
          plan = { gx: rect.x0 + 1, gz: south ? rect.z0 + 1 : rect.z0 + 4, dir: south ? 2 : 0, doorSide: laneLow ? 'near' : 'far' }
        }
        const horizontal = plan.dir === 1 || plan.dir === 3
        const door = horizontal
          ? { axis: 'h', gx: rect.x0 + 2, line: laneLow ? rect.z0 : rect.z1 + 1, inside: { gx: rect.x0 + 2, gz: laneLow ? rect.z0 : rect.z1 }, outside: { gx: rect.x0 + 2, gz: laneLow ? rect.z0 - 1 : rect.z1 + 1 } }
          : { axis: 'v', gz: rect.z0 + 2, line: laneLow ? rect.x0 : rect.x1 + 1, inside: { gx: laneLow ? rect.x0 : rect.x1, gz: rect.z0 + 2 }, outside: { gx: laneLow ? rect.x0 - 1 : rect.x1 + 1, gz: rect.z0 + 2 } }
        const { u } = F.toCanon(rect.x0 + 2, rect.z0 + 2)
        slots.push({ strip: si, band: st.bands.indexOf(band), a, rect, cx, cz, plan, door, boh: u >= s.P })
      }
    }
  }
  const stairs = []
  if (slots.length) {
    const boh = slots.filter((t) => t.boh)
    const first = D.pick(boh.length ? boh : slots)
    stairs.push(first)
    if (D.chance(0.5)) {
      const rest = slots.filter((t) => (t.cx !== first.cx || t.cz !== first.cz) && !overlaps(grow(t.rect, 1), grow(first.rect, 1)))
      if (rest.length) stairs.push(D.pick(rest))
    }
  }
  return { hole, strips, stairs: stairs.map(({ strip, band, a, rect, cx, cz, plan, door, boh }) => ({ strip, band, a, rect, cx, cz, plan, door, boh })) }
}

// --- spawn and exit cells -----------------------------------------------------------

// Stalls cells (ground storey) where a gangway meets a cross aisle, centre
// first: free of seats by construction (aisles), never the core.
function spawnCellsOf(s, F) {
  const vs = [...s.gangways, 0, s.W - 1].sort((a, b) => Math.abs(a - s.W / 2) - Math.abs(b - s.W / 2))
  const us = [s.front, ...(s.mid >= 0 ? [s.mid] : []), 0]
  const out = []
  for (const u of us) {
    for (const v of vs) {
      const c = F.toTile(u, v)
      if (inRect(s.coreRect, c.gx, c.gz)) continue
      out.push({ gx: c.gx, gz: c.gz })
    }
  }
  return out
}

// Trap room cells (basement) under the stage, centre first: not a pier, not
// the core or its door, not the cells the infill keeps for road cases.
function exitCellsOf(s, F) {
  const uc = Math.floor((s.fly.u0 + s.fly.u1) / 2)
  const out = []
  for (const [du, dv] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1]]) {
    const c = F.toTile(uc + du, s.oc + dv)
    if (s.columns.some((p) => p.gx === c.gx && p.gz === c.gz)) continue
    if (inRect(grow(s.coreRect, 1), c.gx, c.gz)) continue
    out.push({ gx: c.gx, gz: c.gz, cy: BASE })
  }
  return out
}

// --- scheme entry points ---------------------------------------------------------------

const SCHEME_ATTEMPTS = 64
function buildScheme(seed, finite) {
  for (let attempt = 0; attempt < SCHEME_ATTEMPTS; attempt++) {
    const s = tryScheme(dice(hashChain(seed | 0, attempt, 0x5c)), finite)
    if (s) return deepFreeze(s)
  }
  throw new Error(`theater: no scheme for seed ${seed >>> 0}`)
}

const CACHE_MAX = 1024
const cache = new Map()

// The scheme of world tile k (pure in worldSeed and the tile), memoised.
// The variety seed chains the tile coordinates into its planSeed, which
// breaks tileSeed's mirror ties (tiles/tileKey.js hashChain).
export function schemeOf(worldSeed, k) {
  const seed = worldSeed >>> 0
  const key = `${seed}|${k.tx},${k.tz},${k.band ?? 0}`
  let s = cache.get(key)
  if (s) {
    cache.delete(key)
    cache.set(key, s)
    return s
  }
  const kk = bandKey(k.tx, k.tz)
  s = buildScheme(hashChain(planSeedOf(seed, kk), k.tx, k.tz, kk.band), false)
  cache.set(key, s)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return s
}

// The kind lab's sample (finite mode): five storeys always.
const finiteCache = new Map()
export function finiteScheme(seed) {
  const key = seed >>> 0
  let s = finiteCache.get(key)
  if (!s) {
    s = buildScheme(hashChain(key ^ SALT, 0x6b1d), true)
    finiteCache.set(key, s)
    if (finiteCache.size > 64) finiteCache.delete(finiteCache.keys().next().value)
  }
  return s
}

// --- the world grid --------------------------------------------------------------------

// The tile key (band 0) of tile (tx, tz) and its planSeed.
export const bandKey = (tx, tz) => tileKeyAt(TILE, tx, tz, 0)
export const planSeedOf = (worldSeed, k) => tileSeed(worldSeed >>> 0, TILE.salt, k)

// Is kind-local chunk (lcx, lcz) a participant of the house volume?
export const participantChunk = (scheme, lcx, lcz) =>
  lcx * CHUNK >= scheme.part.x0 && lcx * CHUNK <= scheme.part.x1 && lcz * CHUNK >= scheme.part.z0 && lcz * CHUNK <= scheme.part.z1

// Which kind-local chunks a storey keeps: the band storeys keep the whole
// tile; above them only the house volume's chunks up to its top level.
export function keptLocal(scheme, lcx, s, lcz) {
  if (lcx < 0 || lcz < 0 || lcx >= TILE.w || lcz >= TILE.d || s < 0 || s >= FLOORS) return false
  if (s <= BAND_TOP) return true
  return s < scheme.NL && participantChunk(scheme, lcx, lcz)
}

// §6.5 footprint: pure in (worldSeed, chunk), via the tile's scheme.
export function footprint(worldSeed, cx, cy, cz) {
  const k = tileKeyOf(TILE, cx, cy, cz)
  if (!k) return 'solid'
  const s = schemeOf(worldSeed, k)
  return keptLocal(s, cx - k.origin.cx, cy - k.origin.cy, cz - k.origin.cz) ? 'tile' : 'solid'
}

// Ports (§6.5, §6.8): hashed per seam and storey (pure in the seam key: the
// world seed, the eastern/southern tile and the side), on the three band
// storeys (global −1, 0, 1): one or two on the ground storey, none or one on
// the basement and the first floor; each 1–2 cells at tile-local 2..39. The
// band reaches every edge cell on those storeys, so any port opens into a
// room, a corridor or the ring.
const PORT_SALT = 0x9071
export const PORT_STOREYS = Object.freeze([BASE, GROUND, FIRST])
export function ports(worldSeed, k, side, cy) {
  const s = cy - TILE.lo
  if (s < BASE || s > BAND_TOP || (side !== 'west' && side !== 'north')) return []
  const h = hashChain(((worldSeed >>> 0) ^ TILE.salt ^ PORT_SALT) | 0, k.tx, k.tz, side === 'west' ? 1 : 2, s)
  const count = s === GROUND ? 1 + (h & 1) : (h >>> 1) & 1
  const out = []
  let g = h
  for (let i = 0; i < count; i++) {
    g = hashChain(g | 0, i, 0x77)
    for (let t = 0; t < 8; t++) {
      const a0 = 2 + (hashChain(g | 0, t) % 37) // 2..38
      const a1 = Math.min(39, a0 + ((g >>> (8 + t)) & 1))
      if (out.every((p) => a1 < p.a0 - 3 || a0 > p.a1 + 3)) {
        out.push({ a0, a1 })
        break
      }
    }
  }
  return out.sort((a, b) => a.a0 - b.a0)
}

// --- spawn, exit, anomalies --------------------------------------------------------

export const EXIT_MIN_CHUNKS = 4
export const EXIT_MAX_CHUNKS = 9

// The spawn cell of a world (pure in its seed): the first of tile (0,0)'s
// spawn cells (the hook checks walkability in the generated chunk).
export function spawnCellsOfWorld(worldSeed) {
  return schemeOf(worldSeed, bandKey(0, 0)).spawnCells
}

const chunkOfCell = (tx, tz, c) => ({ cx: Math.floor((tx * N + c.gx) / CHUNK), cz: Math.floor((tz * N + c.gz) / CHUNK) })

// The ring of tiles at Chebyshev distance 2 from tile (0,0), each with its
// trap room's exit cell 4..9 chunks (Chebyshev) from the spawn chunk (with
// 3×3-chunk tiles every ring tile qualifies; checked per seed).
const ringCache = new Map()
function exitRingOf(worldSeed) {
  const hit = ringCache.get(worldSeed >>> 0)
  if (hit) return hit
  const ring = Object.freeze(exitRingUncached(worldSeed >>> 0))
  ringCache.set(worldSeed >>> 0, ring)
  if (ringCache.size > 64) ringCache.delete(ringCache.keys().next().value)
  return ring
}
function exitRingUncached(worldSeed) {
  const sp = chunkOfCell(0, 0, spawnCellsOfWorld(worldSeed)[0])
  const out = []
  for (let tz = -2; tz <= 2; tz++) {
    for (let tx = -2; tx <= 2; tx++) {
      if (Math.max(Math.abs(tx), Math.abs(tz)) !== 2) continue
      const ex = schemeOf(worldSeed, bandKey(tx, tz)).exitCells
      const ok = ex.every((c) => {
        const ch = chunkOfCell(tx, tz, c)
        const d = Math.max(Math.abs(ch.cx - sp.cx), Math.abs(ch.cz - sp.cz))
        return d >= EXIT_MIN_CHUNKS && d <= EXIT_MAX_CHUNKS
      })
      if (ok) out.push(Object.freeze({ tx, tz }))
    }
  }
  return out
}

// The exit tile: one of the ring (pure in the seed; mirror-free chain).
export function exitTileOf(worldSeed) {
  const ring = exitRingOf(worldSeed)
  return ring[hashChain(((worldSeed >>> 0) ^ TILE.salt) | 0, 0x0e, 0x17) % ring.length]
}

// The exit hook's deterministic fallback tiles: the rest of the ring, from
// the one after the exit tile.
export function exitFallbackTiles(worldSeed) {
  const ring = exitRingOf(worldSeed)
  const t = exitTileOf(worldSeed)
  const first = ring.findIndex((r) => r.tx === t.tx && r.tz === t.tz)
  return Array.from({ length: ring.length - 1 }, (_, i) => ring[(first + 1 + i) % ring.length])
}

// §8.2 exit anchor: the trap room (cy −1) of tile (tx, tz), at the first
// exit cell its bake marks.
export function exitAnchorOfTile(worldSeed, tx, tz) {
  const k = bandKey(tx, tz)
  const c = schemeOf(worldSeed, k).exitCells[0]
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

// Per-tile anomaly (§12.0, §12.8; doc 11 §10, doc 14: theater 1 per 2–3
// theatres, at most one per segment, never twice in a row, never on the exit
// segment). A tile is one theatre. Hashed per tile (mirror-free chain):
//   raw    present with p = ANOMALY_RAW_OF_16 / 16, a preferred class from
//          the next two bits, a priority from the rest; never within
//          Chebyshev 1 of the spawn tile (spawn storey ±1 near spawn), never
//          the exit tile;
//   rotate greedy in priority order: a tile takes its preferred class unless
//          an edge neighbour of higher priority holds it, else the next free
//          class. No two edge-adjacent tiles share a class. The recursion
//          climbs strictly rising priorities only, so the result is pure in
//          (worldSeed, tile) and order-independent.
// The classes:
//   'upstage'  the ghost light has moved upstage (doc §10.5);
//   'missing'  a stalls row is gone: the seat count is wrong (doc §10.1);
//   'turned'   one stalls row faces the back of the house;
//   'plates'   every level plate claims the stalls (5tAL).
// None touches a route: seats and plates only.
export const ANOMALY_RAW_OF_16 = 7
export const ANOMALY_CLASSES = Object.freeze(['upstage', 'missing', 'turned', 'plates'])
const anomalyHash = (worldSeed, tx, tz) => hashChain(((worldSeed >>> 0) ^ TILE.salt ^ 0x0a40a1) | 0, tx, tz, 0x3a)
const EDGE_NEIGHBOURS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]])

function rawAnomaly(worldSeed, tx, tz, ex) {
  if (Math.max(Math.abs(tx), Math.abs(tz)) <= 1) return null
  if (ex.tx === tx && ex.tz === tz) return null
  const h = anomalyHash(worldSeed, tx, tz)
  if ((h & 15) >= ANOMALY_RAW_OF_16) return null
  return { cls: (h >>> 4) & 3, pri: h >>> 6, tx, tz }
}

// Strict total order on raw anomalies: priority, then (tx, tz).
const outranks = (a, b) => a.pri > b.pri || (a.pri === b.pri && (a.tx > b.tx || (a.tx === b.tx && a.tz > b.tz)))

// The class index tile `me` ends with, or −1.
function finalClass(worldSeed, me, ex, memo) {
  const key = `${me.tx},${me.tz}`
  const hit = memo.get(key)
  if (hit !== undefined) return hit
  const taken = [false, false, false, false]
  for (const [dx, dz] of EDGE_NEIGHBOURS) {
    const n = rawAnomaly(worldSeed, me.tx + dx, me.tz + dz, ex)
    if (!n || !outranks(n, me)) continue
    const c = finalClass(worldSeed, n, ex, memo)
    if (c >= 0) taken[c] = true
  }
  let out = -1
  for (let i = 0; i < 4 && out < 0; i++) {
    const c = (me.cls + i) & 3
    if (!taken[c]) out = c
  }
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
