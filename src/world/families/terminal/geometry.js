import { CHUNK } from '../../constants.js'
import { hash3i } from '../../core/hash.js'
import { RNG } from '../../core/rng.js'
import { MAP_FAMILY_TERMINAL } from '../ids.js'
import { assembleCatalogDescriptor } from '../../structures/catalog/engine.js'
import { FAMILY_SALT, floorDiv, hashChain, planPick, structureId, tileKeyAt, tileKeyOf, tileSeed } from '../../tiles/tileKey.js'

// The terminal family's pure geometry (spec §3.3, §7.4, §12.7) and the
// SKELETON of its tile grammar: everything the planner (structures.js), the
// tile program (tile.js) and the hooks must agree on, as pure functions of
// (worldSeed, global coordinates) or of a tile's variety seed.
//
// Planner-chain module (§7.5): it may import only constants.js, core/hash.js,
// core/rng.js, mapTypes.js, mapFamily.js ({deepFreeze, MAP_FAMILY_CODES}),
// structures/catalog/engine.js, families/ids.js, tiles/tileKey.js and
// tiles/stubPlanner.js. Never tiles/stub.js, the canvas or the kit.
//
// The editor kind (kind.js, the finite prototype) is the parts catalogue:
// the 11-wide double-loaded pier (3 holdroom + 5 concourse + 3 holdroom), the
// glazed holdroom with its podium and seats facing the glass, the jet-bridge
// tube ending at a closet door, the glazed tip lounge, the security
// serpentine, duty-free grilles, carousel blocks, the bridged spine atrium
// with its mezzanine, the service stair cores, the Arr / dEP / CLUb plates.
// The world never repeats the kind's arrangement: a seeded GRAMMAR composes
// each tile (layoutOf below decides the skeleton, tile.js the rooms):
//   - the spine: its rows (z0 22..25, 9..11 wide) per tile; the tile seams
//     join neighbouring spines on their shared rows (always ≥ 6), so the
//     concourse kinks from tile to tile without pinching;
//   - one to three piers per tile (doc §4.1: a pier every 2..4 chunks), each
//     on the north or the south side, at its own x, 11 wide (double-loaded)
//     or 8 (single-loaded west or east), its own length, root, tip depth and
//     holdroom split, with a service stair core beside it in the outer chunk
//     row; most run on through the tile-row seam into the apron rows (±1,
//     and on into ±2: 2.7–9 chunks from the spine to the dead end), drawn
//     there by the apron row's own tile (pierPartsOf);
//   - the rest of each side is the spine's frontage and the apron (tile.js:
//     shops, cafés, food courts, remote gate lounges, club lounges, with
//     glass onto the apron mass between them), with the mezzanine stair
//     core in it;
//   - the spine atria (one or two, never over the serpentine nor tile 0's
//     landside column): their x spans (1 or 2 chunk columns each), lengths,
//     deck or cross bridges vary; each ring box is exactly the spine's rows,
//     so the stamp never touches a room; the voids open the spine to the
//     mezzanine's roof over about half its length;
//   - a checkpoint bay about every fifth tile: the serpentine across the
//     spine at its own x, 3..5 lanes;
//   - the baggage level: a service tunnel from the west seam to the east
//     seam (ports hashed per seam) with a jog, the baggage hall straddling
//     it at its own x and size, the arrivals door (the world's exit) off it;
//   - the mezzanine: its depth either side of the spine, its lane (ports
//     hashed per seam), its units (tile.js).
//
// Frames: kind-local storeys 0 baggage (BAG), 1 departures (DEP), 2
// mezzanine (MEZ) are world storeys −1, 0, +1 (origin.cy = −1); a tile is
// 4×4 chunks (56×56 cells); tile-local cell (gx, gz) of tile (tx, tz) is
// global (tx·56 + gx, tz·56 + gz). Row tz = 0 is the terminal; the apron
// rows' tiles hold only pier parts (pierPartsOf).

export const FAMILY = MAP_FAMILY_TERMINAL

// The kind's dice salt (rng(seed, SALT) in kind.js and tile.js).
export const SALT = 0x08a1

// Kind-local storeys.
export const BAG = 0
export const DEP = 1
export const MEZ = 2

// The tile (§6.2): 4×4 chunks, backend 'band', one band of three storeys
// (−1 baggage, 0 departures, +1 mezzanine). Tile row 0 is the terminal (the
// concourse runs along x); rows ±1 and ±2 are the apron, where only the
// long piers run on (departures only, the chunks round each pier:
// footprint); everything else north and south is solid.
export const TILE = Object.freeze({ w: 4, d: 4, backend: 'band', H: 3, lo: -1, hi: 1, rows: Object.freeze([-2, -1, 0, 1, 2]), salt: FAMILY_SALT.terminal })
export const TILE_CELLS_X = TILE.w * CHUNK // 56
export const TILE_CELLS_Z = TILE.d * CHUNK // 56
export const LAST_X = TILE_CELLS_X - 1
export const LAST_Z = TILE_CELLS_Z - 1

// §7.2: the planner's attempt budget for the spine atrium.
export const PICK_ATTEMPTS = 32

export const R = (x0, z0, x1, z1) => ({ x0, z0, x1, z1 })

// The kind's dice, index-keyed: roll(seed, a, b) === rng(seed, SALT)(a, b)
// (tiles/floorPlan.js), without importing the floor-plan compiler.
export const roll = (seed, a, b = 0) => hash3i((seed ^ SALT) | 0, a | 0, b | 0, 0x51) >>> 0

// The tile key (band 0) of tile tx (row 0) and its planSeed.
export const bandKey = (tx) => tileKeyAt(TILE, tx, 0, 0)
export const planSeedOf = (worldSeed, k) => tileSeed(worldSeed >>> 0, TILE.salt, k)
// The tile's pure variety seed (P-fix lessons: planSeed repeats at some
// mirror tiles, so chain the coordinates in).
export const varietySeedOf = (worldSeed, k) => hashChain(planSeedOf(worldSeed, k), k.tx, k.tz, k.band)

const SPINE_SALT = 0x5b1e
const BAG_PORT_SALT = 0xba90
const CHECKPOINT_SALT = 0x0c4e
const EXIT_SALT = 0x0e17
const ANOMALY_SALT = 0x0a40
const LAYOUT_SALT = 0x1a70

const seamHash = (worldSeed, salt, tx) => hashChain(((worldSeed >>> 0) ^ TILE.salt ^ salt) | 0, tx)

// --- spine and ports (pure in the seam / tile key) ------------------------------------

// The spine's rows in tile tx: z0 22..25, 9..11 wide (so z1 30..35): always
// in chunk rows 1..2, and any two tiles share at least 6 rows (the concourse
// never pinches at a seam).
export const SPINE_Z0 = Object.freeze([22, 25])
export const SPINE_W = Object.freeze([9, 11])
export function spineOf(worldSeed, tx) {
  const h = seamHash(worldSeed, SPINE_SALT, tx)
  const z0 = SPINE_Z0[0] + (h % (SPINE_Z0[1] - SPINE_Z0[0] + 1))
  const w = SPINE_W[0] + ((h >>> 8) % (SPINE_W[1] - SPINE_W[0] + 1))
  return { z0, z1: z0 + w - 1 }
}

// The west seam of tile tx on departures: the rows the two spines share.
export function depPort(worldSeed, tx) {
  const a = spineOf(worldSeed, tx - 1)
  const b = spineOf(worldSeed, tx)
  return { a0: Math.max(a.z0, b.z0), a1: Math.min(a.z1, b.z1) }
}

// The west seam of tile tx on the baggage level: the service tunnel's two
// rows, hashed per seam in 16..39 (clear of the stair-core chunk rows).
export const BAG_PORT_RANGE = Object.freeze([16, 38])
export function bagPort(worldSeed, tx) {
  const n = BAG_PORT_RANGE[1] - BAG_PORT_RANGE[0] + 1
  const a0 = BAG_PORT_RANGE[0] + (seamHash(worldSeed, BAG_PORT_SALT, tx) % n)
  return { a0, a1: a0 + 1 }
}

// The west seam of tile tx on the mezzanine: the gallery walkway's two
// rows, hashed per seam inside the departures port (so inside both tiles'
// spine rows).
const MEZ_PORT_SALT = 0x3e20
export function mezPort(worldSeed, tx) {
  const d = depPort(worldSeed, tx)
  const a0 = d.a0 + (seamHash(worldSeed, MEZ_PORT_SALT, tx) % (d.a1 - d.a0))
  return { a0, a1: a0 + 1 }
}

// --- checkpoint, exit tile -------------------------------------------------------------

// A checkpoint bay (§12.7): one tile in every block of five, never tile 0
// (the landside). It carries a security serpentine across the spine and no
// spine atrium.
export function isCheckpoint(worldSeed, tx) {
  if (tx === 0) return false
  const b = floorDiv(tx, 5)
  return tx - b * 5 === hashChain((worldSeed ^ TILE.salt ^ CHECKPOINT_SALT) | 0, b) % 5
}

// The exit tile: tx ∈ ±(2..3), pure in the world seed (§12.7).
const EXIT_TXS = Object.freeze([2, -2, 3, -3])
export function exitTileOf(worldSeed) {
  return EXIT_TXS[hashChain((worldSeed ^ TILE.salt ^ EXIT_SALT) | 0, 0x0e) % EXIT_TXS.length]
}

// The exit hook's deterministic fallback tiles: the other three, in order.
export function exitFallbackTiles(worldSeed) {
  const first = EXIT_TXS.indexOf(exitTileOf(worldSeed))
  return Array.from({ length: EXIT_TXS.length - 1 }, (_, i) => EXIT_TXS[(first + 1 + i) % EXIT_TXS.length])
}

// --- the tile grammar: the skeleton ------------------------------------------------------

// Pier parts (doc 08 §4.2): holdroom 3 deep, concourse 5 with the walkway in
// its centre cell; a single-loaded pier keeps one holdroom band.
export const HOLD = 3
export const CONC = 5
// The stair core of stairwellPlan: 6 cells along its flight (× 4 across).
const CORE_ALONG = 6

// Chunk-interior span of chunk column/row c: a stair core must sit strictly
// inside one chunk (cells 1..12).
const inChunk = (a0, a1) => floorDiv(a0, CHUNK) === floorDiv(a1, CHUNK) && a0 - floorDiv(a0, CHUNK) * CHUNK >= 1 &&
  a1 - floorDiv(a1, CHUNK) * CHUNK <= CHUNK - 2

const overlaps = (a0, a1, b0, b1) => a0 <= b1 && b0 <= a1

// A pier stair core (BAG → DEP, dir S) beside pier body [X, X + w − 1] on its
// `side` ('W' | 'E'), door row zd: the core's door is on the pier's outer
// line at row zd (stairwellPlan: vertical flights put the door on the west
// ('near') or east ('far') wall at the core's middle row = landing row + 1).
function pierCore(X, w, side, zd) {
  const gz = zd - 1
  const gx = side === 'W' ? X - 3 : X + w + 1
  const doorSide = side === 'W' ? 'far' : 'near'
  const rect = R(gx - 1, gz - 1, gx + 2, gz + 4)
  const doorLine = side === 'W' ? X : X + w
  // The plate wall at the stair top (DEP): on the side away from the door.
  const plate = { axis: 'v', line: side === 'W' ? gx : gx + 1, gz: gz + 3 }
  return { gx, gz, dir: 'S', doorSide, side, rect, door: { axis: 'v', line: doorLine, gz: zd }, plate,
    cx: floorDiv(gx, CHUNK), cz: floorDiv(gz, CHUNK) }
}

// The mezzanine stair core (DEP → MEZ, dir E) beside the spine on `side`,
// its west core column x0: rows z0−4..z0−1 (north, door 'far' on h-line z0)
// or z1+1..z1+4 (south, door 'near' on h-line z1+1), door column x0 + 2.
function mezCore(spine, side, x0) {
  const gx = x0 + 1
  const gz = side === 'N' ? spine.z0 - 3 : spine.z1 + 2
  const rect = R(x0, gz - 1, x0 + CORE_ALONG - 1, gz + 2)
  const doorSide = side === 'N' ? 'far' : 'near'
  const doorLine = side === 'N' ? spine.z0 : spine.z1 + 1
  const plate = { axis: 'h', line: side === 'N' ? gz : gz + 1, gx: gx + 3 }
  return { gx, gz, dir: 'E', doorSide, side, rect, door: { axis: 'h', line: doorLine, gx: gx + 1 }, plate,
    cx: floorDiv(gx, CHUNK), cz: floorDiv(gz, CHUNK) }
}

const sideRows = (spine, side) => (side === 'N' ? { e0: spine.z0 - 1, sgn: -1, depth: spine.z0 - 1 } : { e0: spine.z1 + 1, sgn: 1, depth: LAST_Z - 1 - spine.z1 })

// Holdroom runs along a pier side: lengths 4..9 (doc: 6..10 long; a short
// last one closes the run), filling `n` rows exactly.
function holdroomRuns(rng, n) {
  const out = []
  let left = n
  while (left > 0) {
    if (left <= 9) {
      if (left >= 4) {
        out.push(left)
        break
      }
      // Too short a remainder: lengthen the previous run.
      out[out.length - 1] += left
      break
    }
    const len = rng.int(5, Math.min(9, left - 4))
    out.push(len)
    left -= len
  }
  return out
}

// The sides ('W' | 'E') where pier body x0..x0+w−1 can take its stair core
// (4 columns strictly inside one chunk, inside the tile), with the core's
// chunk column.
function coreSidesOf(x0, w) {
  const out = []
  if (x0 - 4 >= 1 && inChunk(x0 - 4, x0 - 1)) out.push({ side: 'W', cx: floorDiv(x0 - 3, CHUNK) })
  if (x0 + w + 3 <= LAST_X - 1 && inChunk(x0 + w, x0 + w + 3)) out.push({ side: 'E', cx: floorDiv(x0 + w + 1, CHUNK) })
  return out
}

// One pier: body x0..x0+w−1 on `side` of the spine, its rows, parts and core
// (on a side whose chunk column `takenCx` does not hold). Returns null when
// no core fits.
function makePier(rng, spine, side, x0, w, loaded, takenCx = []) {
  const { e0, sgn, depth } = sideRows(spine, side)
  const tip = rng.int(5, 7)
  const root = rng.int(1, 2)
  // Most piers run on through the tile-row seam into the apron rows beyond
  // (doc §4.1: a pier is 6–14 chunks long, a dead end far out): `ext` rows
  // there (in the next row, or on through it into the row after), the tip
  // lounge at their end; the rest end in this row.
  const far = rng.chance(EXT_LONG) ? TILE_CELLS_Z : 0
  const ext = rng.chance(EXT_SHARE) ? far + rng.int(EXT_ROWS[0], EXT_ROWS[1]) : 0
  // The core sits in the outer chunk row (rows 1..12 north, 43..54 south),
  // never a spine chunk row (the atrium's participants).
  const coreSides = coreSidesOf(x0, w).filter((c) => !takenCx.includes(c.cx))
  if (!coreSides.length) return null
  const coreSide = coreSides[rng.int(0, coreSides.length - 1)].side
  // Door row (global): in the outer chunk row, with the tip still inside
  // the side's depth (rows out from the spine edge vd + tip + 1 ≤ depth).
  const tipHere = ext ? 0 : tip
  const zdRange = side === 'N' ? [Math.max(3, e0 - depth + tipHere + 1), 9] : [45, Math.min(51, e0 + depth - tipHere - 1)]
  if (zdRange[1] < zdRange[0]) return null
  const zd = rng.int(zdRange[0], zdRange[1])
  const vd = (zd - e0) * sgn // rows out from the spine edge
  const minLen = vd + tipHere + 1
  if (minLen > depth || vd < root + 1) return null
  // A pier that ends here runs out as far as the side allows (the tile row
  // is 56 cells deep; the last few rows vary); one that runs on reaches the
  // seam row (0 or 55), its body to the edge.
  const len = ext ? depth + 1 : rng.int(Math.max(minLen, depth - 7), depth)
  const body = len - root - tipHere
  const rows = (v) => e0 + sgn * v
  const zNear = e0
  const zFar = rows(len - 1)
  const rect = R(x0, Math.min(zNear, zFar), x0 + w - 1, Math.max(zNear, zFar))
  const hasW = loaded === 'both' || loaded === 'W'
  const hasE = loaded === 'both' || loaded === 'E'
  const concX0 = hasW ? x0 + HOLD : x0
  const runsW = hasW ? holdroomRuns(rng, body) : []
  const runsE = hasE ? holdroomRuns(rng, body) : []
  const conc = { x0: concX0, x1: concX0 + CONC - 1 }
  // The parts beyond the seam, one per apron row's tile it crosses
  // (tile-local rows: a north row's from 55 up, a south row's from 0 down;
  // a part that runs on fills its tile's 56 rows): no root, no core; the
  // tip lounge in the last.
  const parts = []
  for (let done = 0, r = 1; done < ext; r++) {
    const n = Math.min(ext - done, TILE_CELLS_Z)
    const tipHere = done + n === ext ? tip : 0
    const pe0 = sgn < 0 ? LAST_Z : 0
    const pFar = pe0 + sgn * (n - 1)
    parts.push({
      side, sgn, e0: pe0, x0, w, loaded, hasW, hasE, len: n, root: 0, tip: tipHere, body: n - tipHere,
      rect: R(x0, Math.min(pe0, pFar), x0 + w - 1, Math.max(pe0, pFar)),
      conc,
      runsW: hasW ? holdroomRuns(rng, n - tipHere) : [],
      runsE: hasE ? holdroomRuns(rng, n - tipHere) : [],
      core: null,
      tz: sgn * r,
    })
    done += n
  }
  return {
    side, sgn, e0, x0, w, loaded, hasW, hasE, len, root, tip: tipHere, body,
    rect,
    conc,
    // Holdroom runs (lengths from the root outward) per band.
    runsW,
    runsE,
    core: pierCore(x0, w, coreSide, zd),
    ext,
    parts,
  }
}

// Pier extensions (the apron rows' tiles): the share of piers that run on,
// the share of those that run on through the next row into the one after,
// and their rows in the row the tip lies in (the tip lounge ≥ 9 rows short
// of the far edge, so its gates' jet bridges fit). Piers measure 1.5–2
// chunks (ending in row 0), 2.7–5 (next row) or 6.7–9 (the row after).
export const EXT_SHARE = 0.85
export const EXT_LONG = 0.35
export const EXT_ROWS = Object.freeze([16, 46])
export const EXT_TZ = 2 // the farthest apron row
// The cells round a pier's part that its tile keeps (footprint): its gates'
// jet bridges (≤ 7 + closet), the tip's widening (≤ 3) and the apron beyond.
export const EXT_MARGIN = 10

// The x span a pier lot claims on its side (body + the apron its bridges
// and core use): margins 4..8 each side, inside the tile.
function lotOf(p, mW, mE) {
  return { x0: Math.max(1, p.x0 - mW), x1: Math.min(LAST_X - 1, p.x0 + p.w - 1 + mE) }
}

const LAYOUT_CACHE_MAX = 256
const LAYOUT = new Map()

// The tile's skeleton (pure in (worldSeed, tx), memoised, frozen):
//   { tx, vs, landside, checkpoint, spine, ports: {dep, depE, bag, bagE, mez,
//     mezE}, piers[], lots: {N: [...], S: [...]}, mezCore, atrium | null,
//     serpentine | null, hall (tile 0's check-in hall) | null, spawnCells,
//     bag: {jog, hall, arrivals}, mez: {z0, z1}, deadPier, scheme, anomaly,
//     anomalyPier, attempts }
export function layoutOf(worldSeed, tx) {
  const seed = worldSeed >>> 0
  const key = `${seed}|${tx}`
  let l = LAYOUT.get(key)
  if (l) {
    LAYOUT.delete(key)
    LAYOUT.set(key, l)
    return l
  }
  l = deepFreezeLocal(buildLayout(seed, tx))
  LAYOUT.set(key, l)
  if (LAYOUT.size > LAYOUT_CACHE_MAX) LAYOUT.delete(LAYOUT.keys().next().value)
  return l
}

function deepFreezeLocal(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreezeLocal(v)
  }
  return o
}

function buildLayout(seed, tx) {
  const k = bandKey(tx)
  const vs = varietySeedOf(seed, k)
  const spine = spineOf(seed, tx)
  const ports = {
    dep: depPort(seed, tx),
    depE: depPort(seed, tx + 1),
    bag: bagPort(seed, tx),
    bagE: bagPort(seed, tx + 1),
    mez: mezPort(seed, tx),
    mezE: mezPort(seed, tx + 1),
  }
  const landside = tx === 0
  const checkpoint = isCheckpoint(seed, tx)
  // The departures skeleton: retried with fresh dice until every rule holds
  // (a fixed, always-valid fallback after the budget).
  // The pier count is rolled once (so the retries do not bias it toward the
  // easy counts): 1: 38 %, 2: 50 %, 3: 12 % (about 1.75 piers a tile, so the
  // anomaly cadence stays one per 1–2 piers, doc 14); tile 0 has 1 or 2. A
  // count that finds no valid dice in 32 attempts drops by one.
  const roll3 = hashChain(vs ^ LAYOUT_SALT, 0x9135) % 100
  const want = landside ? (roll3 < 45 ? 1 : 2) : roll3 < 38 ? 1 : roll3 < 88 ? 2 : 3
  let dep = null
  let attempts = 0
  for (; attempts < 48 && !dep; attempts++) {
    const np = attempts < 32 ? want : Math.max(1, want - 1)
    dep = departures(new RNG(hashChain(vs ^ LAYOUT_SALT, attempts)), spine, { landside, checkpoint, np, seed, k })
  }
  if (!dep) dep = departuresFallback(spine, { landside, checkpoint }, hashChain(vs ^ LAYOUT_SALT, 0xfa11))
  const rng = new RNG(hashChain(vs ^ LAYOUT_SALT, 0x7a6))
  const bag = baggage(rng, ports, tx)
  const mez = {
    z0: spine.z0 - (dep.mezCore.side === 'N' ? rng.int(4, 5) : rng.int(2, 5)),
    z1: spine.z1 + (dep.mezCore.side === 'S' ? rng.int(4, 5) : rng.int(2, 5)),
  }
  // One pier of two or three stands dark; the anomaly takes a lit one.
  const np = dep.piers.length
  const deadPier = np >= 2 ? roll(vs, 1) % np : -1
  const anomaly = anomalyAt(seed, tx)
  const anomalyPier = !anomaly ? -1 : np >= 2 ? (deadPier + 1 + (roll(vs, 3) % (np - 1))) % np : 0
  return {
    tx, vs, landside, checkpoint, spine, ports,
    ...dep,
    // The pier parts per apron row (index tz + EXT_TZ; row 0's is empty).
    parts: Array.from({ length: 2 * EXT_TZ + 1 }, (_, j) => (j === EXT_TZ ? NO_PARTS : partsOf(dep.piers, j - EXT_TZ))),
    bag,
    mez,
    deadPier,
    scheme: roll(vs, 2) % 3,
    anomaly,
    anomalyPier,
    attempts,
  }
}

// --- departures skeleton -------------------------------------------------------------

function departures(rng, spine, { landside, checkpoint, np, seed, k }) {
  // Tile 0's landside: the check-in hall at the west end (chunk column 0),
  // spanning the spine and 2..5 rows either side, then the serpentine.
  let hall = null
  let serpentine = null
  let blocked = [] // x spans (both sides) the piers keep off
  if (landside) {
    const hx1 = rng.int(10, 12)
    hall = R(0, spine.z0 - rng.int(4, 8), hx1, spine.z1 + rng.int(4, 8))
    serpentine = { x0: hx1 + 1, lanes: rng.int(3, 5) }
    blocked.push([0, serpentine.x0 + serpentine.lanes + 2])
  } else if (checkpoint) {
    const lanes = rng.int(3, 5)
    const x0 = rng.int(3, LAST_X - 4 - lanes)
    serpentine = { x0, lanes }
    blocked.push([x0 - 2, x0 + lanes + 2])
  }
  // Piers: `np` (one to three; doc §4.1: a pier every 2..4 chunks), each
  // side N or S, at its own x.
  const sides = []
  for (let i = 0; i < np; i++) sides.push(rng.chance(0.5) ? 'N' : 'S')
  if (np === 3 && sides.every((v) => v === sides[0])) sides[rng.int(0, 2)] = sides[0] === 'N' ? 'S' : 'N'
  const piers = []
  const lots = { N: [], S: [] }
  for (let i = 0; i < np; i++) {
    const side = sides[i]
    const w = rng.chance(0.25) ? HOLD + CONC : HOLD * 2 + CONC
    const loaded = w === HOLD * 2 + CONC ? 'both' : rng.chance(0.5) ? 'W' : 'E'
    const mW = rng.int(4, 8)
    const mE = rng.int(4, 8)
    const xMin = 1 + mW
    const xMax = LAST_X - 1 - mE - w + 1
    // One core per chunk: never the chunk of another pier's core on this side.
    const takenCx = piers.filter((o) => o.side === side).map((o) => o.core.cx)
    // The x the pier may take: its lot clear of this side's lots and the
    // serpentine, a core side free.
    const xs = []
    for (let x = xMin; x <= xMax; x++) {
      const lot = { x0: Math.max(1, x - mW), x1: Math.min(LAST_X - 1, x + w - 1 + mE) }
      if (blocked.some(([a, b]) => overlaps(x - 1, x + w, a, b))) continue
      if (lots[side].some((o) => overlaps(lot.x0, lot.x1, o.x0, o.x1))) continue
      if (!coreSidesOf(x, w).some((c) => !takenCx.includes(c.cx))) continue
      xs.push(x)
    }
    if (!xs.length) return null
    const x0 = xs[rng.int(0, xs.length - 1)]
    const p = makePier(rng, spine, side, x0, w, loaded, takenCx)
    if (!p) return null
    const lot = lotOf(p, mW, mE)
    lots[side].push({ ...lot, pier: i })
    piers.push({ ...p, i, lot, parts: p.parts.map((q) => ({ ...q, i })) })
  }
  // The landside of each side: the x spans no pier lot claims.
  const land = { N: freeSpans(lots.N, landside ? hall : null), S: freeSpans(lots.S, landside ? hall : null) }
  // The mezzanine stair core: beside the spine in a landside span, strictly
  // inside one chunk, never in tile 0's chunk column 0.
  const mezCands = []
  for (const side of ['N', 'S']) {
    for (const s of land[side]) {
      for (let x0 = s.x0 + 1; x0 + CORE_ALONG - 1 <= s.x1 - 1; x0++) {
        if (!inChunk(x0, x0 + CORE_ALONG - 1)) continue
        if (landside && x0 < 14) continue
        if (serpentine && overlaps(x0, x0 + CORE_ALONG - 1, serpentine.x0 - 1, serpentine.x0 + serpentine.lanes + 1)) continue
        mezCands.push({ side, x0 })
      }
    }
  }
  if (!mezCands.length) return null
  const mc = mezCands[rng.int(0, mezCands.length - 1)]
  const mezCoreSpec = mezCore(spine, mc.side, mc.x0)
  // The spine atria (doc §4.1: the spine is 2–4 storeys high): one or two
  // runs of 1..2 chunk columns (the catalog's 2 × 2 participants at most), never tile 0's landside column nor a column
  // the serpentine crosses; each ring box spans the spine's rows exactly and
  // never a whole chunk column. The longest runs are the likeliest, so the
  // spine is double height, its mezzanine a gallery round railed voids,
  // along most of its length. (The mezzanine core's column may take a
  // two-column one: the planner's clash test keeps the atrium's own flight
  // in the other column.)
  const atria = []
  {
    const blockedCol = (c) => (landside && c === 0) ||
      (serpentine && overlaps(c * CHUNK, c * CHUNK + CHUNK - 1, serpentine.x0 - 3, serpentine.x0 + serpentine.lanes + 2))
    const cols = [0, 1, 2, 3].filter((c) => !blockedCol(c))
    const runsOf = (cs) => {
      const runs = []
      for (const c of cs) for (let n = 1; n <= 2 && cs.includes(c + n - 1); n++) if (n === 2 || c !== mezCoreSpec.cx) runs.push([c, c + n - 1])
      return runs
    }
    const pickRun = (runs) => {
      const longest = Math.max(...runs.map(([a, b]) => b - a))
      const top = runs.filter(([a, b]) => b - a === longest)
      const pool = rng.chance(0.85) ? top : runs
      return pool[rng.int(0, pool.length - 1)]
    }
    // A run over the mezzanine core's column is kept only where the
    // planner's own assembly finds the atrium a flight clear of the core
    // (else the next run the dice pick).
    const taken = [...piers.map((p) => p.core), mezCoreSpec].map((c) => ({ cx: k.origin.cx + c.cx, cz: k.origin.cz + c.cz, lowerCy: k.origin.cy + (c === mezCoreSpec ? DEP : BAG) }))
    const place = (runs, slot) => {
      const left = [...runs]
      while (left.length) {
        const run = pickRun(left)
        left.splice(left.indexOf(run), 1)
        const a = atriumOver(rng, spine, run, slot)
        if (run[0] !== mezCoreSpec.cx && run[1] !== mezCoreSpec.cx) return { a, run }
        if (assembleAtrium(seed, k, a, taken)) return { a, run }
      }
      return null
    }
    const first = place(runsOf(cols), 0)
    if (first) {
      atria.push(first.a)
      const rest = runsOf(cols.filter((c) => c < first.run[0] || c > first.run[1]))
      const second = rest.length && rng.chance(0.95) ? place(rest, 1) : null
      if (second) atria.push(second.a)
    }
  }
  return { hall, serpentine, piers, lots, land, mezCore: mezCoreSpec, atrium: atria[0] ?? null, atria, spawnCells: hall ? spawnCellsOf(hall, spine) : [] }
}

// An atrium over chunk columns c0..c1 of the spine (slot `slot`).
function atriumOver(rng, spine, [c0, c1], slot) {
  const lo = c0 * CHUNK + 1
  const hi = c1 * CHUNK + CHUNK - 2
  const span = hi - lo + 1
  const len = c1 > c0 ? rng.int(Math.max(14, span - 5), span) : span - rng.int(0, 2)
  const bx0 = rng.int(lo, hi - len + 1)
  const box = R(bx0, spine.z0, bx0 + len - 1, spine.z1)
  return { ...atriumSpec(rng, box), slot }
}

// A tile that never finds its dice: one double-loaded pier at x 32 on the
// side `h` picks, the mezzanine core on the other side in chunk column 1, a
// one-column atrium in column 2 (outside checkpoint bays). Valid for every
// spine.
function departuresFallback(spine, { landside, checkpoint }, h) {
  const rng = new RNG(0x7e57 ^ h)
  const side = h & 1 ? 'N' : 'S'
  const other = side === 'N' ? 'S' : 'N'
  const p = { ...makeFixedPier(spine, side), i: 0 }
  p.lot = lotOf(p, 7, 7)
  const lots = { N: [], S: [] }
  lots[side].push({ ...p.lot, pier: 0 })
  const hall = landside ? R(0, spine.z0 - 2, 9, spine.z1 + 2) : null
  const serpentine = landside ? { x0: 10, lanes: 3 } : checkpoint ? { x0: 4, lanes: 3 } : null
  const land = { N: freeSpans(lots.N, hall), S: freeSpans(lots.S, hall) }
  const mezCoreSpec = mezCore(spine, other, 15)
  const atrium = checkpoint ? null : { ...atriumSpec(rng, R(29, spine.z0, 40, spine.z1), 'none'), slot: 0 }
  return { hall, serpentine, piers: [p], lots, land, mezCore: mezCoreSpec, atrium, atria: atrium ? [atrium] : [], spawnCells: hall ? spawnCellsOf(hall, spine) : [] }
}

function makeFixedPier(spine, side) {
  // A pier at x 32..42, core east (x 43..46, chunk column 3), door row 7
  // (north) or 47 (south), tip 5, root 1.
  const { e0, sgn, depth } = sideRows(spine, side)
  const x0 = 32
  const w = 11
  const tip = 5
  const root = 1
  const zd = side === 'N' ? 7 : 47
  const vd = (zd - e0) * sgn
  const len = Math.min(depth, vd + tip + 1)
  const body = len - root - tip
  const zFar = e0 + sgn * (len - 1)
  const runs = (n) => (n <= 9 ? [n] : [Math.ceil(n / 2), Math.floor(n / 2)])
  return {
    side, sgn, e0, x0, w, loaded: 'both', hasW: true, hasE: true, len, root, tip, body,
    rect: R(x0, Math.min(e0, zFar), x0 + w - 1, Math.max(e0, zFar)),
    conc: { x0: x0 + HOLD, x1: x0 + HOLD + CONC - 1 },
    runsW: runs(body),
    runsE: runs(body),
    core: pierCore(x0, w, 'E', zd),
    ext: 0,
    parts: [],
  }
}

// The x spans of one side (cells 1..54) no pier lot (nor tile 0's hall)
// claims, each at least 4 wide.
function freeSpans(lots, hall) {
  const taken = lots.map((l) => [l.x0, l.x1])
  if (hall) taken.push([0, hall.x1])
  taken.sort((a, b) => a[0] - b[0])
  const out = []
  let x = 1
  for (const [a, b] of taken) {
    if (a - 1 - x + 1 >= 4) out.push({ x0: x, x1: a - 1 })
    x = Math.max(x, b + 1)
  }
  if (LAST_X - 1 - x + 1 >= 4) out.push({ x0: x, x1: LAST_X - 1 })
  return out
}

// Tile 0's spawn: the check-in hall's middle, then its neighbours (all in
// chunk column 0).
function spawnCellsOf(hall, spine) {
  const gx = Math.min(5, hall.x1 - 3)
  const gz = (spine.z0 + spine.z1) >> 1
  return [[gx, gz], [gx + 1, gz], [gx - 1, gz], [gx, gz - 1], [gx, gz + 1], [gx + 1, gz + 1], [2, gz]]
    .map(([x, z]) => ({ gx: x, gz: z }))
}

// --- the spine atrium (§7.4) ---------------------------------------------------------

// The atrium spec over ring box `box` (the spine's rows × its x span): the
// void sits 3 rows in from the spine edges and 2 cells in from the box ends;
// the bounds are the box less its ring, so the gallery strips either side of
// the void are 2 rows deep and the volume's own flight lands on them. The
// bridges: none, a deck along the void's middle row (3+ rows), or one or two
// cross bridges.
function atriumSpec(rng, box0, force = null) {
  // The catalog's seam rules (structures/catalog/engine.js analysis): no
  // void edge and no ring edge on a chunk line, no bridge flank on one. The
  // void's x ends move inward off them; its rows take inset 3 from the
  // spine's walls, or 4 / 2 where 3 lands on the chunk-row line.
  const m = (g) => ((g % CHUNK) + CHUNK) % CHUNK
  let x0 = box0.x0 + 2
  while (m(x0) === 0 || m(x0) === 1) x0++
  let x1 = box0.x1 - 2
  while (m(x1) === 13 || m(x1) === 12) x1--
  // One side keeps a two-row gallery strip (the ring row and two more: the
  // volume's own flight lands there, in one chunk's rows 2..11); the other
  // side's strip is one row, so the void is as wide as it can be.
  const flightRows = (za) => floorDiv(za, CHUNK) === floorDiv(za + 2, CHUNK) && m(za) >= 1 && m(za + 2) <= 12
  const nOk = flightRows(box0.z0)
  const sOk = flightRows(box0.z1 - 2)
  const wideN = nOk && (!sOk || rng.chance(0.5))
  const insN = !nOk && !sOk ? [3, 4, 2] : wideN ? [3, 4, 2] : [2, 3, 4]
  const insS = !nOk && !sOk ? [3, 4, 2] : wideN ? [2, 3, 4] : [3, 4, 2]
  const z0 = insN.map((i) => box0.z0 + i).find((z) => m(z) !== 0)
  const z1 = insS.map((i) => box0.z1 - i).find((z) => m(z + 1) !== 0 && z >= z0)
  const v = R(x0, z0, x1, z1 ?? z0)
  const box = R(v.x0 - 2, box0.z0, v.x1 + 2, box0.z1)
  const rows = v.z1 - v.z0 + 1
  const len = v.x1 - v.x0 + 1
  const deckRows = []
  for (let z = v.z0; z <= v.z1; z++) if (m(z) !== 0 && m(z + 1) !== 0) deckRows.push(z)
  const crossCols = []
  for (let x = v.x0 + 3; x <= v.x1 - 3; x++) if (m(x) !== 0 && m(x + 1) !== 0) crossCols.push(x)
  const styles = ['none']
  if (rows >= 3 && deckRows.length) styles.push('deck')
  if (len >= 8 && rows >= 2 && crossCols.length) styles.push('cross')
  const style = force ?? styles[rng.int(0, styles.length - 1)]
  const bridges = []
  if (style === 'deck') {
    const mid = v.z0 + ((rows - 1) >> 1)
    const z = deckRows.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a))
    bridges.push(R(v.x0, z, v.x1, z))
  } else if (style === 'cross') {
    const n = len >= 16 && rng.chance(0.5) ? 2 : 1
    const first = crossCols[rng.int(0, crossCols.length - 1)]
    bridges.push(R(first, v.z0, first, v.z1))
    if (n === 2) {
      const far = crossCols.filter((x) => Math.abs(x - first) >= 5)
      if (far.length) {
        const x = far[rng.int(0, far.length - 1)]
        bridges.push(R(x, v.z0, x, v.z1))
        bridges.sort((a, b) => a.x0 - b.x0)
      }
    }
  }
  return { x0: v.x0, z0: v.z0, x1: v.x1, z1: v.z1, bz0: box.z0 + 1, bz1: box.z1 - 1, box, style, bridges, baseCy: DEP, levels: 2 }
}

// §7.4 conversion of an atrium spec (kind-local) into a catalog plan: bounds
// are the void grown by 1 along x and to the spec's gallery rows across; the
// void sits on level 1 with the spec's bridges. Returns { plan, meta } with
// meta.slot and meta.baseCy kind-local.
export function atriumAsCatalog(spec) {
  const v = R(spec.x0, spec.z0, spec.x1, spec.z1)
  const bounds = R(v.x0 - 1, spec.bz0, v.x1 + 1, spec.bz1)
  const levels = [{ voids: [], bridges: [] }]
  for (let k = 1; k < spec.levels; k++) levels.push({ voids: [{ ...v }], bridges: (spec.bridges ?? []).map((b) => ({ ...b })) })
  return {
    plan: { label: 'spine atrium', bounds, levels, columns: [], piers: [], core: null, links: 'auto', glazing: 'window' },
    meta: { id: 0, family: FAMILY, type: 'spineAtrium', sizeClass: 'large', slot: spec.slot ?? 0, baseCy: spec.baseCy },
  }
}

// §6.5 volume plan of slot `slot` of tile k: the spine atria (slot 0, and
// slot 1 where the tile has a second), kind-local; null in checkpoint bays
// and for a slot the tile does not have.
export const ATRIUM_SLOTS = 2
export function volumePlan(worldSeed, k, slot = 0) {
  if (k.tz !== 0) return null
  const a = layoutOf(worldSeed, k.tx).atria[slot]
  return a ? atriumAsCatalog(a) : null
}

const shiftRect = (r, dx, dz) => ({ x0: r.x0 + dx, z0: r.z0 + dz, x1: r.x1 + dx, z1: r.z1 + dz })

// A kind-local plan at the tile's origin: every cell rect by origin·CHUNK.
function translatePlan(plan, origin) {
  const dx = origin.cx * CHUNK
  const dz = origin.cz * CHUNK
  return {
    ...plan,
    bounds: shiftRect(plan.bounds, dx, dz),
    levels: plan.levels.map((l) => ({
      voids: (l.voids ?? []).map((r) => shiftRect(r, dx, dz)),
      bridges: (l.bridges ?? []).map((r) => shiftRect(r, dx, dz)),
    })),
  }
}

// §7.2 assembly of atrium spec `spec` (kind-local, its slot) in tile k at TRUE
// GLOBAL coordinates: the catalog descriptor whose flight lands on no stair
// slot of `taken` (GLOBAL {cx, cz, lowerCy}), in PICK_ATTEMPTS picks, or
// null. The planner (structures.js) and the layout (a run over the
// mezzanine core's column) both call it.
export function assembleAtrium(worldSeed, k, spec, taken) {
  const { plan, meta: local } = atriumAsCatalog(spec)
  const slot = local.slot
  const meta = {
    id: structureId(worldSeed, FAMILY, k, slot),
    family: FAMILY,
    type: local.type,
    sizeClass: local.sizeClass,
    district: { x: k.tx, z: k.tz, size: TILE.w },
    bandIndex: k.band,
    slot,
    baseCy: k.origin.cy + DEP,
  }
  const world = translatePlan(plan, k.origin)
  const clash = (desc) => desc.verticalLinks.some((l) => taken.some((s) => s.cx === l.cx && s.cz === l.cz && (s.lowerCy === l.lowerCy || s.lowerCy === l.lowerCy - 1 || s.lowerCy === l.lowerCy + 1)))
  // Mirror-free pick seed (P-fix lessons): planSeed chained with the tile.
  const pickSeed = hashChain(planSeedOf(worldSeed, k), k.tx, k.tz, k.band)
  let desc = null
  for (let attempt = 0; attempt < PICK_ATTEMPTS && !desc; attempt++) {
    desc = assembleCatalogDescriptor(world, meta, planPick(pickSeed, slot, attempt))
    if (desc && clash(desc)) desc = null
  }
  return desc
}

// --- baggage skeleton -------------------------------------------------------------------

// The service tunnel (west port rows to east port rows, a vertical jog at
// x jx..jx+1) and the baggage halls on it (doc §4.2: 14 × 14 and up, 2–4
// carousels):
//   hall   the reclaim hall, 18..32 × 14..22, straddling the run the dice
//          pick, the tunnel's rows 2..4 in from one long wall so the far
//          side is a deep floor for the carousels;
//   hall2  on the other run where it leaves room (12..20 × 12..18): a second
//          reclaim hall or the arrivals greeting hall;
//   arrivals the vestibule one cell off the reclaim hall's north or south
//          wall (the world's exit).
// West of the origin the arrivals door stays in the tile's west half, so the
// exit chunk of tile −2 is ≥ 7 chunks from the spawn.
const HALL_ROWS = Object.freeze([14, 41])
function nearWallOff(rng, d) {
  const near = rng.int(2, 4)
  return rng.chance(0.5) ? near : d - 2 - near
}
function baggage(rng, ports, tx) {
  const pw = ports.bag.a0
  const pe = ports.bagE.a0
  for (let attempt = 0; attempt < 48; attempt++) {
    const host = rng.chance(0.5) ? 'W' : 'E'
    // The jog first: the host side keeps ≥ 18 columns for the reclaim hall
    // (a hall ends 3 cells short of the jog).
    const jx = host === 'W' ? rng.int(24, 40) : rng.int(14, 30)
    const span = (west) => (west ? [3, jx - 3] : [jx + 5, LAST_X - 3])
    const [a0, a1] = span(host === 'W')
    const w = rng.int(18, Math.min(32, a1 - a0 + 1))
    const d = rng.int(14, 22)
    const p = host === 'W' ? pw : pe
    const hz0 = p - nearWallOff(rng, d)
    const hz1 = hz0 + d - 1
    if (hz0 < HALL_ROWS[0] || hz1 > HALL_ROWS[1]) continue
    const hx0 = rng.int(a0, a1 - w + 1)
    const hx1 = hx0 + w - 1
    if (tx < 0 && hx0 > 25) continue
    const hall = R(hx0, hz0, hx1, hz1)
    // The arrivals vestibule: one cell off the hall's north or south wall.
    const side = rng.chance(0.5) ? 'N' : 'S'
    const axMax = tx < 0 ? Math.min(hx1 - 1, 27) : hx1 - 1
    if (axMax < hx0 + 1) continue
    const ax = rng.int(hx0 + 1, axMax)
    const az = side === 'N' ? hz0 - 1 : hz1 + 1
    // The second hall on the other run (three tiles in four, where it fits).
    let hall2 = null
    const q = host === 'W' ? pe : pw
    const [b0, b1] = span(host !== 'W')
    const want2 = rng.chance(0.8)
    for (let t = 0; t < 10 && want2 && !hall2 && b1 - b0 + 1 >= 12; t++) {
      const w2 = rng.int(12, Math.min(20, b1 - b0 + 1))
      const d2 = rng.int(12, 18)
      const z0 = q - nearWallOff(rng, d2)
      if (z0 < HALL_ROWS[0] || z0 + d2 - 1 > HALL_ROWS[1]) continue
      const x0 = rng.int(b0, b1 - w2 + 1)
      hall2 = { r: R(x0, z0, x0 + w2 - 1, z0 + d2 - 1), kind: rng.chance(0.5) ? 'reclaim' : 'greeting' }
    }
    return { pw, pe, jog: jx, host, hall, hall2, arrivals: { gx: ax, gz: az, side } }
  }
  // Fallback: an 18 × 14 hall on the west run at x 4 (its rows inside
  // 14..41 for every port row 16..38).
  const z0 = pw + 11 <= HALL_ROWS[1] ? pw - 2 : pw - 11
  const hall = R(4, z0, 21, z0 + 13)
  return { pw, pe, jog: 30, host: 'W', hall, hall2: null, arrivals: { gx: 6, gz: hall.z0 - 1, side: 'N' } }
}

// --- spawn, exit ---------------------------------------------------------------------

// Tile 0's spawn candidates (tile-local = global, tile 0).
export function spawnCells(worldSeed) {
  return layoutOf(worldSeed, 0).spawnCells
}

const toChunkCell = (gx, gz) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { cx, cz, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}

// The arrivals door of tile tx as a GLOBAL exit cell {cx, cy, cz, lx, lz}.
export function exitAnchorOfTile(worldSeed, tx) {
  const k = bandKey(tx)
  const a = layoutOf(worldSeed >>> 0, tx).bag.arrivals
  return { ...toChunkCell(k.origin.cx * CHUNK + a.gx, k.origin.cz * CHUNK + a.gz), cy: k.origin.cy + BAG }
}

// §8.2 exit anchor: the arrivals door of the exit tile, on the baggage storey.
export function exitAnchor(worldSeed) {
  return exitAnchorOfTile(worldSeed >>> 0, exitTileOf(worldSeed >>> 0))
}

// --- anomalies -----------------------------------------------------------------------

// Per-tile anomaly (§12.0, §12.7; doc 14: terminal, segment = pier, rate
// 1–2; at most one per segment, never the same class twice in a row, never
// on the exit segment). The segment is the tile (one to three piers). Hashed
// from each tile's variety seed:
//   raw    present with p = 7/8; never within one tile of the spawn tile,
//          never on the exit tile;
//   rotate the classes alternate along the SEQUENCE of anomalous tiles: on
//          each side of the spawn gap the class is a seed bit plus the
//          parity of the raw anomalies between the gap and the tile. Pure in
//          (worldSeed, tx), order-independent; prefix parities memoised.
//   'board' a gate board error on the lit pier: its gate plates read "Err",
//           its gate glow turns error-red and its FIDS stands face the wall;
//   'dead'  a dead pier: the pier that should be lit is dark too.
export const ANOMALY_RAW_OF_8 = 7
export const ANOMALY_CLASSES = Object.freeze(['board', 'dead'])

function rawAnomaly(worldSeed, tx, exitTx) {
  if (Math.abs(tx) <= 1 || tx === exitTx) return false
  const h = hashChain((varietySeedOf(worldSeed, bandKey(tx)) ^ ANOMALY_SALT) | 0, 0x3a)
  return (h & 7) < ANOMALY_RAW_OF_8
}

const PARITY = new Map()
const PARITY_SEEDS = 8
function parityMemo(seed, exitTx) {
  let m = PARITY.get(seed)
  if (m) {
    PARITY.delete(seed)
    PARITY.set(seed, m)
    return m
  }
  m = { exitTx, east: new Uint8Array(64), eastN: 0, west: new Uint8Array(64), westN: 0 }
  PARITY.set(seed, m)
  if (PARITY.size > PARITY_SEEDS) PARITY.delete(PARITY.keys().next().value)
  return m
}
function parityBefore(seed, tx, exitTx) {
  const m = parityMemo(seed, exitTx)
  const side = tx > 0 ? 'east' : 'west'
  const sign = tx > 0 ? 1 : -1
  const n = Math.abs(tx) - 2
  if (n === 0) return 0
  let arr = m[side]
  let have = m[side + 'N']
  if (have < n) {
    if (arr.length < n) {
      const grown = new Uint8Array(Math.max(n, arr.length * 2))
      grown.set(arr.subarray(0, have))
      arr = m[side] = grown
    }
    let par = have ? arr[have - 1] : 0
    for (let i = have; i < n; i++) {
      par ^= rawAnomaly(seed, sign * (2 + i), exitTx) ? 1 : 0
      arr[i] = par
    }
    m[side + 'N'] = have = n
  }
  return arr[n - 1]
}

export function anomalyAt(worldSeed, tx) {
  const seed = worldSeed >>> 0
  const exitTx = exitTileOf(seed)
  if (!rawAnomaly(seed, tx, exitTx)) return null
  const base = hashChain((seed ^ TILE.salt ^ ANOMALY_SALT) | 0, 0x3c) & 1
  const c = (base + (tx > 0 ? 0 : 1) + parityBefore(seed, tx, exitTx)) & 1
  return ANOMALY_CLASSES[c]
}

// The tile's variant: what the tile program, the hooks and the tests read.
export function tileVariant(worldSeed, tx) {
  const l = layoutOf(worldSeed, tx)
  return {
    tx,
    landside: l.landside,
    checkpoint: l.checkpoint,
    piers: l.piers.length,
    deadPier: l.deadPier,
    scheme: l.scheme,
    anomaly: l.anomaly,
    anomalyPier: l.anomalyPier,
    varietySeed: l.vs,
  }
}

// --- footprint and ports -------------------------------------------------------------

// The parts of tile tx's piers that run on into apron row tz (−1 north, +1
// south): their tile-local rects and the tile-local chunks (cx, cz) kept
// round them (the part grown by EXT_MARGIN, clipped to the tile).
export function pierPartsOf(worldSeed, tx, tz) {
  if (tz === 0 || Math.abs(tz) > EXT_TZ) return NO_PARTS
  return layoutOf(worldSeed, tx).parts[tz + EXT_TZ]
}
const NO_PARTS = Object.freeze([])
function partsOf(piers, tz) {
  const out = []
  for (const p of piers) {
    const part = p.parts.find((q) => q.tz === tz)
    if (!part) continue
    const r = part.rect
    const e = R(Math.max(0, r.x0 - EXT_MARGIN), Math.max(0, r.z0 - EXT_MARGIN), Math.min(LAST_X, r.x1 + EXT_MARGIN), Math.min(LAST_Z, r.z1 + EXT_MARGIN))
    const chunks = []
    for (let cz = floorDiv(e.z0, CHUNK); cz <= floorDiv(e.z1, CHUNK); cz++) for (let cx = floorDiv(e.x0, CHUNK); cx <= floorDiv(e.x1, CHUNK); cx++) chunks.push(cz * TILE.w + cx)
    out.push({ ...part, env: e, chunks })
  }
  return out
}

// §6.5 footprint: every storey of the band (baggage cy −1, departures cy 0,
// the mezzanine cy +1) is all sixteen chunks in tile row 0; in the apron
// rows (±1), departures' chunks round the piers that run on; everything else
// is solid.
export function footprint(worldSeed, cx, cy, cz) {
  const k = tileKeyOf(TILE, cx, cy, cz)
  if (!k) return 'solid'
  if (k.tz === 0) return 'tile'
  if (cy !== k.origin.cy + DEP) return 'solid'
  const c = (cz - k.origin.cz) * TILE.w + (cx - k.origin.cx)
  return pierPartsOf(worldSeed, k.tx, k.tz).some((p) => p.chunks.includes(c)) ? 'tile' : 'solid'
}

const NO_PORTS = Object.freeze([])

// Ports (§6.5, §6.8), tile-local along-cells, inclusive, pure in the seam:
//   west   (row 0 only) the spine's shared rows on cy 0, the baggage tunnel
//          on cy −1, the mezzanine lane on cy +1;
//   north  on cy 0 only, the piers that run on across it (their full
//          width): of a row ≤ 0, the north parts in the row above; of a row
//          ≥ 1, its own south parts (each starts at its north seam).
export function ports(worldSeed, k, side, cy) {
  if (side === 'north') {
    if (cy !== 0) return NO_PORTS
    const parts = pierPartsOf(worldSeed, k.tx, k.tz <= 0 ? k.tz - 1 : k.tz)
    return parts.length ? parts.map((p) => ({ a0: p.x0, a1: p.x0 + p.w - 1 })).sort((a, b) => a.a0 - b.a0) : NO_PORTS
  }
  if (side !== 'west' || k.tz !== 0) return NO_PORTS
  const p = cy === 0 ? depPort(worldSeed, k.tx) : cy === -1 ? bagPort(worldSeed, k.tx) : cy === 1 ? mezPort(worldSeed, k.tx) : null
  return p ? [{ a0: p.a0, a1: p.a1 }] : NO_PORTS
}

// --- stair slots -----------------------------------------------------------------------

// §7.2 stair slots of tile k (GLOBAL chunk-storeys {cx, cz, lowerCy}) taken by
// the stairwell cores: each pier's service stair (BAG → DEP, chunk rows 0 or
// 3) and the mezzanine stair (DEP → MEZ). The atrium never spans the
// mezzanine core's chunk column, so the planner's clash test never fires;
// verticalOpeningAt reads them too.
export function stairSlots(worldSeed, k) {
  if (k.tz !== 0) return []
  const l = layoutOf(worldSeed >>> 0, k.tx)
  const out = []
  for (const p of l.piers) out.push({ cx: k.origin.cx + p.core.cx, cz: k.origin.cz + p.core.cz, lowerCy: k.origin.cy + BAG })
  out.push({ cx: k.origin.cx + l.mezCore.cx, cz: k.origin.cz + l.mezCore.cz, lowerCy: k.origin.cy + DEP })
  return out
}
