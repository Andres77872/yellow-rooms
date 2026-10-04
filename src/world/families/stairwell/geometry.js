import { CHUNK } from '../../constants.js'
import { hash2i, hash3i } from '../../core/hash.js'
import { MAP_FAMILY_STAIRWELL } from '../ids.js'
import { FAMILY_SALT, floorDiv } from '../../tiles/tileKey.js'

// The stairwell family's pure geometry (spec §12.1; docs/liminal_maps/
// 04-endless-stairwell.md §4). Everything here is a pure function of
// (worldSeed, GLOBAL coordinates); the tile program (tile.js), the generator,
// the hooks and the planner read it, it never reads them.
//
// PLANNER-CHAIN MODULE (§7.5): contract.js → families/planners.js →
// stairwell/structures.js → this file. It may import only constants.js,
// core/hash.js, core/rng.js, mapTypes.js, mapFamily.js ({deepFreeze,
// MAP_FAMILY_CODES}), structures/catalog/engine.js, families/ids.js,
// tiles/tileKey.js and tiles/stubPlanner.js.
//
// The grammar, in one paragraph. Districts are 4×4 chunks; one bake draws ONE
// storey of one district (backend 'storey'). Each district is a FIELD OF
// SHAFTS: 14–16 of its 16 chunks hold an enclosed switchback core each (A and
// B Chebyshev ≥ 2 apart), each with its own landing cell, flight direction
// and door side, running through every storey (global flight parity), with
// the same landing storey after storey. The shaft is the world; behind every
// fire door is a small dead-end fragment (doc §4.3): a vestibule, then a
// lobby ring round the core with its doors (offices, archives, risers,
// washrooms, stores), a plant room, an office floor, now and then a car-park
// deck, or a bricked door. A fragment's kind holds for a 3–6-storey run and
// its plan is keyed by the run. The storey is shared out among the landings
// by a binary partition of the district (fixed per district) whose cuts move
// with the runs of the shafts beside them, each share cut back to the kind's
// reach round its core, so fragments stay small and the mass between them
// falls anywhere, never on the chunk lattice. The shafts are joined by a
// ladder tree (A–B, then nearest first); every tree edge is a routed 2-wide
// rung on one of the band's 2–3 A–B transfer floors (band −1 always has one at
// storey −3), and one LONG rung per district seam per band (the four seams of
// a district on distinct residues mod 4) runs from the nearest landing to a
// port hashed per seam and band. Corridors are found by a seeded Dijkstra
// over the district's cells (hashed cost field, hashed turn penalty). Every
// chunk no landing, rung or share reaches is solid mass.

export const FAMILY = MAP_FAMILY_STAIRWELL

// District size in chunks, and the fragment/rung band height in storeys.
export const DISTRICT = 4
export const BAND = 16
export const SPAN = DISTRICT * CHUNK // cells per district side (56)
const CELLS = SPAN * SPAN

// Backend 'storey' (§2): the key is (tx, tz, cy); unbounded storeys.
export const TILE = Object.freeze({ w: DISTRICT, d: DISTRICT, backend: 'storey', salt: FAMILY_SALT[MAP_FAMILY_STAIRWELL] })

// Hash salts (one per independent stream).
const S_LAYOUT = 0x5e1a0001
const S_RUNG = 0x5e1a0002
const S_XSEAM = 0x5e1a0003
const S_ZSEAM = 0x5e1a0004
const S_PORT = 0x5e1a0005
const S_EXIT = 0x5e1a0006
const S_LIE = 0x5e1a0007
const S_BAND = 0x5e1a0008
const S_FRAG = 0x04a1
const S_CLAIM = 0x5e1a0009
const S_ROUTE = 0x5e1a000a
const S_SITE = 0x5e1a000b

// uint32 from (worldSeed, salt, a, b, c, d).
const hk = (seed, salt, a = 0, b = 0, c = 0, d = 0) =>
  hash3i(hash2i(((seed >>> 0) ^ salt) | 0, a | 0, b | 0) | 0, c | 0, d | 0, salt) >>> 0

// The kind lab's index-keyed dice (tiles/floorPlan.js rng), copied so the
// planner chain never imports the floor-plan compiler: r(a, b) is a uint32.
export const dice = (seed, salt) => (a, b = 0) => hash3i((seed ^ salt) | 0, a | 0, b | 0, 0x51) >>> 0

// The seed of a district's 16-storey band: fragment runs, breaker segments
// and in-district rungs all roll from dice(bandSeed, …). Pure in
// (worldSeed, dx, dz, band), never the tile seed.
export const bandSeed = (worldSeed, dx, dz, band) => hk(worldSeed, S_BAND, dx, dz, band)

// --- memo -----------------------------------------------------------------------

// A small bounded memo (cleared when full): footprint() runs for every chunk
// a bake or a stream touches, and each answer needs a few hashes.
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

// --- core placements (the parts catalogue of a shaft) --------------------------------

// A switchback core is stairwellPlan's 6×4 (with halo) block round landing
// (lx, lz) climbing along `dir`; its fire door is mid-way along one long side
// ('near' or 'far', structures/authored.js stairwellDoor). CORE_PLACEMENTS
// enumerates every landing × direction × door side whose core sits in cells
// 1..12 of its chunk and whose door looks out over three cells that stay in
// 0..12 (the fragment's first cells never sit on a perimeter line). ~150
// placements: the district picks one per shaft.
const DIR_AXIS = { E: [1, 0, 0, 1], W: [-1, 0, 0, 1], S: [0, 1, 1, 0], N: [0, -1, 1, 0] }
function corePlacement(lx, lz, dir, far) {
  const [ax, az, px, pz] = DIR_AXIS[dir]
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (let along = -1; along <= 4; along++) {
    for (let across = -1; across <= 2; across++) {
      const x = lx + ax * along + px * across
      const z = lz + az * along + pz * across
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z)
    }
  }
  if (x0 < 1 || z0 < 1 || x1 > CHUNK - 2 || z1 > CHUNK - 2) return null
  const horizontal = dir === 'E' || dir === 'W'
  let door, out, inside, n, wall
  if (horizontal) {
    const x = Math.floor((x0 + x1) / 2)
    door = { axis: 'h', at: x, line: far ? z1 + 1 : z0 }
    out = { x, z: far ? z1 + 1 : z0 - 1 }
    inside = { x, z: far ? z1 : z0 }
    n = [0, far ? 1 : -1]
    wall = far ? 'S' : 'N'
  } else {
    const z = Math.floor((z0 + z1) / 2)
    door = { axis: 'v', at: z, line: far ? x1 + 1 : x0 }
    out = { x: far ? x1 + 1 : x0 - 1, z }
    inside = { x: far ? x1 : x0, z }
    n = [far ? 1 : -1, 0]
    wall = far ? 'E' : 'W'
  }
  for (let k = 0; k <= 2; k++) {
    const x = out.x + n[0] * k
    const z = out.z + n[1] * k
    if (x < 0 || z < 0 || x > CHUNK - 2 || z > CHUNK - 2) return null
  }
  return { lx, lz, dir, far, core: { x0, x1, z0, z1 }, door, out, inside, n, wall, along: horizontal ? [1, 0] : [0, 1] }
}
const CORE_PLACEMENTS = (() => {
  const out = []
  for (const dir of ['E', 'W', 'S', 'N']) {
    for (const far of [false, true]) {
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const p = corePlacement(lx, lz, dir, far)
          if (p) out.push(Object.freeze(p))
        }
      }
    }
  }
  return Object.freeze(out)
})()
export const CORE_PLACEMENT_COUNT = CORE_PLACEMENTS.length

// A shaft of a district: chunk (ix, iz) of the 4×4 lattice and a placement,
// in district-local cells (0..55). `out` is the cell outside the fire door
// (the fragment's first cell), `inside` the landing cell inside it, `n` the
// outward normal, `along` the door wall's axis, `wall` the door wall's side.
function shaftGeom(s, ix, iz, p) {
  const ox = ix * CHUNK
  const oz = iz * CHUNK
  const g = (c) => ({ x: ox + c.x, z: oz + c.z })
  const n = p.n
  const t = [n[1], n[0]] // the door wall's direction (either sign)
  // The approach: three cells out from the door and one either side. Other
  // routes keep one cell clear of it, so the landing always opens onto its
  // own fragment.
  const approach = []
  for (let k = 0; k <= 2; k++) {
    for (let j = -1; j <= 1; j++) approach.push(Object.freeze({ x: ox + p.out.x + n[0] * k + t[0] * j, z: oz + p.out.z + n[1] * k + t[1] * j }))
  }
  return Object.freeze({
    s,
    ix,
    iz,
    chunk: ix + DISTRICT * iz,
    dir: p.dir,
    far: p.far,
    west: p.dir === 'W',
    planGx: ox + p.lx,
    planGz: oz + p.lz,
    core: Object.freeze({ x0: ox + p.core.x0, x1: ox + p.core.x1, z0: oz + p.core.z0, z1: oz + p.core.z1 }),
    door: Object.freeze({ axis: p.door.axis, at: (p.door.axis === 'h' ? ox : oz) + p.door.at, line: (p.door.axis === 'h' ? oz : ox) + p.door.line }),
    out: Object.freeze(g(p.out)),
    inside: Object.freeze(g(p.inside)),
    n: Object.freeze([...n]),
    along: Object.freeze([...p.along]),
    wall: p.wall,
    approach: Object.freeze(approach),
  })
}

const cheb = (a, b) => Math.max(Math.abs((a % DISTRICT) - (b % DISTRICT)), Math.abs(((a / DISTRICT) | 0) - ((b / DISTRICT) | 0)))
const manh = (a, b) => Math.abs((a % DISTRICT) - (b % DISTRICT)) + Math.abs(((a / DISTRICT) | 0) - ((b / DISTRICT) | 0))

// --- district layout --------------------------------------------------------------

// District (dx, dz): a FIELD of shafts. 14–16 of the 16 lattice chunks hold a
// switchback core each (doc §1: the world is the shaft; the density is what
// keeps every district's massing its own), A and B Chebyshev ≥ 2 apart (doc
// §4.1: 2–4 chunks), the rest anywhere; a placement each (landing, flight
// direction, door side), so core shapes, hands and landings differ chunk to
// chunk. Each chunk WITHOUT a shaft is the territory of one shaft beside it
// (hashed among its 4-neighbours; none beside it → always solid): the only
// chunk a fragment may spill into (a car-park deck, a plant hall). The shafts
// are joined by a ladder tree (Prim from A–B, shortest Manhattan first): its
// edges are the rungs. The plate offsets of the counting shafts. A is the
// spawn shaft, B the exit shaft (honest count).
const layoutMemo = memo(4096, (seed, dx, dz) => {
  const h = (i) => hk(seed, S_LAYOUT, dx, dz, i)
  const a = h(0) % 16
  const candB = []
  for (let c = 0; c < 16; c++) if (cheb(a, c) >= 2) candB.push(c)
  const picks = [a, candB[h(2) % candB.length]]
  const want = Math.min(16, 14 + (h(1) % 4))
  const rest = []
  for (let c = 0; c < 16; c++) if (!picks.includes(c)) rest.push(c)
  for (let i = rest.length - 1; i > 0; i--) {
    const j = h(40 + i) % (i + 1)
    ;[rest[i], rest[j]] = [rest[j], rest[i]]
  }
  picks.push(...rest.slice(0, want - 2))
  const shafts = Object.freeze(picks.map((c, s) => shaftGeom(s, c % DISTRICT, (c / DISTRICT) | 0, CORE_PLACEMENTS[h(10 + s) % CORE_PLACEMENTS.length])))
  const at = new Int8Array(16).fill(-1)
  for (const S of shafts) at[S.chunk] = S.s
  // The storey's partition (static shape): a binary split of the district
  // between the shafts, each cut an axis line that clears the cores and
  // approaches on both sides; a node keeps its interval [lo, hi] of valid
  // cut lines (cells < cut go left) and the two shafts bounding it. The cut
  // itself moves inside the interval band by band, and round a rung's
  // shafts on its storey (domains).
  const ext = shafts.map((S) => {
    let x0 = S.core.x0, x1 = S.core.x1, z0 = S.core.z0, z1 = S.core.z1
    for (const c of S.approach) {
      x0 = Math.min(x0, c.x - 1); x1 = Math.max(x1, c.x + 1)
      z0 = Math.min(z0, c.z - 1); z1 = Math.max(z1, c.z + 1)
    }
    // Clipped to the shaft's own chunk, so any two shafts in different
    // chunks can always be cut apart.
    const ox = S.ix * CHUNK
    const oz = S.iz * CHUNK
    return { x0: Math.max(x0, ox), x1: Math.min(x1, ox + CHUNK - 1), z0: Math.max(z0, oz), z1: Math.min(z1, oz + CHUNK - 1) }
  })
  let salt = 0
  const split = (group) => {
    if (group.length === 1) return Object.freeze({ leaf: group[0] })
    const cands = []
    for (const axis of ['x', 'z']) {
      const a0 = axis === 'x' ? 'x0' : 'z0'
      const a1 = axis === 'x' ? 'x1' : 'z1'
      const sorted = [...group].sort((p, q) => ext[p][a0] + ext[p][a1] - ext[q][a0] - ext[q][a1] || p - q)
      for (let k = 1; k < sorted.length; k++) {
        const left = sorted.slice(0, k)
        const right = sorted.slice(k)
        const lb = left.reduce((b, t) => (ext[t][a1] > ext[b][a1] ? t : b), left[0])
        const rb = right.reduce((b, t) => (ext[t][a0] < ext[b][a0] ? t : b), right[0])
        const lo = ext[lb][a1] + 1
        const hi = ext[rb][a0]
        if (lo <= hi) cands.push({ axis, left, right, lo, hi, lb, rb, bal: Math.abs(group.length - 2 * k) })
      }
    }
    const minBal = Math.min(...cands.map((c) => c.bal))
    const best = cands.filter((c) => c.bal <= minBal + 1)
    const c = best[h(200 + salt++) % best.length]
    return Object.freeze({ axis: c.axis, lo: c.lo, hi: c.hi, lb: c.lb, rb: c.rb, left: split(c.left), right: split(c.right) })
  }
  const bsp = split(shafts.map((S) => S.s))
  // The ladder tree: A–B first, then the shaft nearest the tree joins its
  // nearest tree shaft (ties: lower index).
  const tree = [Object.freeze([0, 1])]
  const inTree = new Set([0, 1])
  while (inTree.size < shafts.length) {
    let best = null
    for (const S of shafts) {
      if (inTree.has(S.s)) continue
      for (const p of inTree) {
        const d = manh(S.chunk, shafts[p].chunk)
        if (!best || d < best[0] || (d === best[0] && (S.s < best[2] || (S.s === best[2] && p < best[1])))) best = [d, p, S.s]
      }
    }
    tree.push(Object.freeze([best[1], best[2]]))
    inTree.add(best[2])
  }
  // Static per district: the cores (blocked to every plan) and each shaft's
  // approach grown by one cell (blocked to the routes of the others).
  const core = new Uint8Array(CELLS)
  for (const S of shafts) {
    for (let z = S.core.z0; z <= S.core.z1; z++) for (let x = S.core.x0; x <= S.core.x1; x++) core[z * SPAN + x] = 1
  }
  const near = shafts.map((S) => {
    const m = new Uint8Array(CELLS)
    for (const c of S.approach) {
      for (const [ex, ez] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = c.x + ex
        const z = c.z + ez
        if (x >= 0 && z >= 0 && x < SPAN && z < SPAN) m[z * SPAN + x] = 1
      }
    }
    return m
  })
  // The same approaches as one bit per shaft (bit s), for the hot loops.
  const nearBits = new Uint16Array(CELLS)
  near.forEach((m, s) => {
    for (let i = 0; i < CELLS; i++) if (m[i]) nearBits[i] |= 1 << s
  })
  const offsets = shafts.map((_, s) => (s === 0 ? 9 + (h(7) % 12) : s === 1 ? 0 : 20 + (h(70 + s) % 60)))
  return Object.freeze({
    dx, dz,
    n: shafts.length,
    shafts,
    A: shafts[0],
    B: shafts[1],
    at,
    tree: Object.freeze(tree),
    bsp,
    core,
    near,
    nearBits,
    offsets: Object.freeze(offsets),
    offsetA: offsets[0],
  })
})
export const districtLayout = (worldSeed, dx, dz) => layoutMemo(`${worldSeed >>> 0},${dx},${dz}`, worldSeed >>> 0, dx, dz)

// --- rungs ------------------------------------------------------------------------

// In-district rungs of band `band`: A↔B on 2–3 storeys (band-local 2..14,
// 4–6 apart; band −1 always carries one at band-local 13 = storey −3, which
// guarantees an A↔B transfer between storey 0 and any exit depth): the
// band's transfer floors. Every other edge of the ladder tree is a rung on
// one of them, so a transfer floor carries several rungs (a shaft may be on
// more than one). Each entry is { cy, pair: [s, t] }.
const rungMemo = memo(4096, (seed, dx, dz, band) => {
  const L = districtLayout(seed, dx, dz)
  const r = dice(bandSeed(seed, dx, dz, band), S_RUNG)
  const t1 = 2 + (r(2, 1) % 3)
  const t2 = t1 + 4 + (r(2, 2) % 3)
  const t3 = t2 + 4 + (r(2, 3) % 3)
  const local = [t1, t2]
  if (band === -1) local.push(13)
  else if (t3 <= BAND - 2) local.push(t3)
  const out = local.map((t) => ({ cy: band * BAND + t, pair: Object.freeze([0, 1]) }))
  // Every other tree edge is one rung per band on its own hashed storey
  // (band-local 1..14): a landing meets a transfer every few storeys (doc
  // §4.1: "every 5–9 floors" per shaft pair), and no storey of the district
  // is a corridor network.
  for (const [k, pair] of L.tree.entries()) {
    if (k === 0) continue
    out.push({ cy: band * BAND + 1 + (r(3, k * 8 + 1) % (BAND - 2)), pair })
  }
  out.sort((a, b) => a.cy - b.cy || a.pair[0] - b.pair[0] || a.pair[1] - b.pair[1])
  return Object.freeze(out.map((e) => Object.freeze(e)))
})
export const rungsOf = (worldSeed, dx, dz, band) => rungMemo(`${worldSeed >>> 0},${dx},${dz},${band}`, worldSeed >>> 0, dx, dz, band)
// The A↔B transfer storeys of a band (the ladder's rungs proper).
export const districtRungs = (worldSeed, dx, dz, band) =>
  rungsOf(worldSeed, dx, dz, band).filter((e) => e.pair[0] === 0 && e.pair[1] === 1).map((e) => e.cy)
// Every rung on storey cy.
export const rungsAt = (worldSeed, dx, dz, cy) => rungsOf(worldSeed, dx, dz, floorDiv(cy, BAND)).filter((e) => e.cy === cy)
export const isDistrictRung = (worldSeed, dx, dz, cy) => rungsAt(worldSeed, dx, dz, cy).length > 0

// Long rungs (decision 6): one storey per band on every district seam. The
// east x-seam of (dx, dz) (keyed by its west district) uses residue dx & 1,
// the south z-seam of (dx, dz) (keyed by its north district) 2 + (dz & 1), so
// a district's four seams take the four residues mod 4.
export const xSeamStorey = (worldSeed, dx, dz, band) => band * BAND + (dx & 1) + 4 * (hk(worldSeed, S_XSEAM, dx, dz, band) % 4)
export const zSeamStorey = (worldSeed, dx, dz, band) => band * BAND + 2 + (dz & 1) + 4 * (hk(worldSeed, S_ZSEAM, dx, dz, band) % 4)

// The seams of district (dx, dz) with a long rung on storey cy: at most one.
export function longRungSide(worldSeed, dx, dz, cy) {
  const band = floorDiv(cy, BAND)
  if (xSeamStorey(worldSeed, dx, dz, band) === cy) return 'east'
  if (xSeamStorey(worldSeed, dx - 1, dz, band) === cy) return 'west'
  if (zSeamStorey(worldSeed, dx, dz, band) === cy) return 'south'
  if (zSeamStorey(worldSeed, dx, dz - 1, band) === cy) return 'north'
  return null
}

// The four long-rung storeys of district (dx, dz) in band `band`.
export const seamStoreys = (worldSeed, dx, dz, band) => Object.freeze({
  east: xSeamStorey(worldSeed, dx, dz, band),
  west: xSeamStorey(worldSeed, dx - 1, dz, band),
  south: zSeamStorey(worldSeed, dx, dz, band),
  north: zSeamStorey(worldSeed, dx, dz - 1, band),
})

// The port of a seam on its band's storey: two cells a0..a0+1 along the seam
// (district-local), hashed per (seam, band) and moved on to the first
// candidate whose rows stay clear of both districts' cores and landing
// approaches for four cells either side of the seam (so the 2-wide corridor
// can always run straight in). Pure in the seam key, the band and the two layouts.
const blockedForPort = (L, x, z) => L.core[z * SPAN + x] === 1 || L.near.some((m) => m[z * SPAN + x] === 1)
const portMemo = memo(4096, (seed, axis, dx, dz, band) => {
  // axis 'x': the seam between (dx, dz) and (dx + 1, dz); 'z': (dx, dz) and (dx, dz + 1).
  const P = districtLayout(seed, dx, dz)
  const Q = axis === 'x' ? districtLayout(seed, dx + 1, dz) : districtLayout(seed, dx, dz + 1)
  const cand = []
  for (let c = 0; c < DISTRICT; c++) for (let off = 1; off <= CHUNK - 3; off++) cand.push(c * CHUNK + off)
  const start = hk(seed, S_PORT, dx, dz, band, axis === 'x' ? 1 : 2) % cand.length
  for (let i = 0; i < cand.length; i++) {
    const a = cand[(start + i) % cand.length]
    let ok = true
    for (const k of [a, a + 1]) {
      for (const d of [0, 1, 2, 3]) {
        const p = axis === 'x' ? blockedForPort(P, SPAN - 1 - d, k) : blockedForPort(P, k, SPAN - 1 - d)
        const q = axis === 'x' ? blockedForPort(Q, d, k) : blockedForPort(Q, k, d)
        if (p || q) ok = false
      }
    }
    if (ok) return a
  }
  return cand[start]
})
export const xPort = (worldSeed, dx, dz, band) => portMemo(`${worldSeed >>> 0},x,${dx},${dz},${band}`, worldSeed >>> 0, 'x', dx, dz, band)
export const zPort = (worldSeed, dx, dz, band) => portMemo(`${worldSeed >>> 0},z,${dx},${dz},${band}`, worldSeed >>> 0, 'z', dx, dz, band)

// --- fragments (kinds and runs) ---------------------------------------------------------

// Fragment kinds (doc §4.3): 'corridor' (the default, recognition: a
// double-loaded corridor of identical doors), 'office' (the single office
// and its locked neighbours), 'toilets', 'closets' (a passage of stores),
// 'plant' (a plant room), 'carpark' (the occasional deck: weight 1 of 18).
// 'dark' repeats the run it interrupts with every lamp dead (the world's
// fill pass leaves it dark: darkCells); 'bricked' walls the fire door, so the
// landing is all there is.
export const GEOMETRY = Object.freeze(['corridor', 'office', 'toilets', 'plant', 'carpark', 'closets'])
const FRAGMENT_WEIGHTS = [['corridor', 6], ['office', 2], ['toilets', 3], ['plant', 2], ['closets', 2], ['carpark', 1], ['dark', 1], ['bricked', 1]]
const WEIGHT_SUM = FRAGMENT_WEIGHTS.reduce((s, [, w]) => s + w, 0)

// Run-length fragment stream for one shaft: a kind holds for 3–6 storeys
// (a bricked door for one), never the same kind twice in a row. Each storey
// gets { kind, run } (the run's index, which keys the run's style).
export function fragmentRuns(r, s, floors) {
  const out = []
  let prev = null
  for (let i = 0; out.length < floors; i++) {
    let roll = r(s * 64 + i, 1) % WEIGHT_SUM
    let kind = FRAGMENT_WEIGHTS[0][0]
    for (const [k, w] of FRAGMENT_WEIGHTS) {
      if (roll < w) {
        kind = k
        break
      }
      roll -= w
    }
    if (kind === prev) kind = GEOMETRY[r(s * 64 + i, 2) % GEOMETRY.length]
    if (kind === prev) continue
    const len = kind === 'bricked' ? 1 : 3 + (r(s * 64 + i, 3) % 4)
    for (let k = 0; k < len && out.length < floors; k++) out.push({ kind, run: i })
    prev = kind
  }
  return out
}

// Per band: every shaft's runs (dark runs resolved to the geometry they
// interrupt) and its breaker segment (one block of 3–7 dark storeys).
const bandMemo = memo(4096, (seed, dx, dz, band) => {
  const L = districtLayout(seed, dx, dz)
  const rb = dice(bandSeed(seed, dx, dz, band), S_FRAG)
  const shafts = L.shafts.map((_, s) => {
    const raw = fragmentRuns(rb, s, BAND)
    const runs = raw.map((e, at) => {
      if (e.kind !== 'dark') return Object.freeze({ kind: e.kind, run: e.run, dark: false })
      let k = at
      while (k >= 0 && (raw[k].kind === 'dark' || raw[k].kind === 'bricked')) k--
      return Object.freeze({ kind: k >= 0 ? raw[k].kind : 'corridor', run: k >= 0 ? raw[k].run : e.run, dark: true })
    })
    const darkLen = 3 + (rb(4, s) % 5)
    const darkFrom = 1 + (rb(3, s) % (BAND - 3 - darkLen))
    return Object.freeze({ runs: Object.freeze(runs), darkFrom, darkLen })
  })
  return Object.freeze(shafts)
})
export const bandPlan = (worldSeed, dx, dz, band) => bandMemo(`${worldSeed >>> 0},${dx},${dz},${band}`, worldSeed >>> 0, dx, dz, band)

// --- the storey: who is on a corridor, which fragment each landing opens on ---------------

// The cheap part of a storey (no routing): the storey's rungs, the long
// rung's side, port and attachment (the landing nearest the port), the
// shafts on a corridor and each other shaft's fragment { kind, run, dark }.
const infoMemo = memo(16384, (seed, dx, dz, cy) => {
  const L = districtLayout(seed, dx, dz)
  const band = floorDiv(cy, BAND)
  const at = cy - band * BAND
  const rungs = rungsAt(seed, dx, dz, cy)
  const side = longRungSide(seed, dx, dz, cy)
  let ext = null
  if (side) {
    const a = side === 'east' ? xPort(seed, dx, dz, band)
      : side === 'west' ? xPort(seed, dx - 1, dz, band)
        : side === 'south' ? zPort(seed, dx, dz, band) : zPort(seed, dx, dz - 1, band)
    // The two port cells and the 2×2 block that reaches them.
    const cells = side === 'east' ? [[SPAN - 1, a], [SPAN - 1, a + 1]]
      : side === 'west' ? [[0, a], [0, a + 1]]
        : side === 'south' ? [[a, SPAN - 1], [a + 1, SPAN - 1]] : [[a, 0], [a + 1, 0]]
    const block = side === 'east' ? [SPAN - 2, a] : side === 'west' ? [0, a] : side === 'south' ? [a, SPAN - 2] : [a, 0]
    let shaft = null
    let bd = Infinity
    for (const S of L.shafts) {
      const d = Math.abs(S.out.x - cells[0][0]) + Math.abs(S.out.z - cells[0][1])
      if (d < bd) [bd, shaft] = [d, S.s]
    }
    ext = Object.freeze({ side, a, cells: Object.freeze(cells.map((c) => Object.freeze(c))), block: Object.freeze(block), shaft })
  }
  const onCorridor = new Set(rungs.flatMap((e) => e.pair))
  if (ext) onCorridor.add(ext.shaft)
  const home = dx === 0 && dz === 0
  const G = exitStorey(seed)
  const bp = bandPlan(seed, dx, dz, band)
  const frags = []
  for (const S of L.shafts) {
    if (onCorridor.has(S.s)) continue
    let { kind, run, dark } = bp[S.s].runs[at]
    // The spawn (A, storey 0) and exit (B, storey G) landings of district
    // (0,0) keep their fire doors.
    if (home && kind === 'bricked' && ((S.s === 0 && cy === 0) || (S.s === 1 && cy === G))) kind = 'corridor'
    // The spawn storey and the two round it keep their tubes in district
    // (0,0): no run goes dark where the run starts.
    if (home && cy >= -1 && cy <= 1) dark = false
    frags.push(Object.freeze({ s: S.s, kind, run, dark }))
  }
  const segDark = Object.freeze(L.shafts.map((S) => !(home && cy >= -1 && cy <= 1) && at >= bp[S.s].darkFrom && at < bp[S.s].darkFrom + bp[S.s].darkLen))
  return Object.freeze({ dx, dz, cy, band, at, layout: L, rungs, ext, onCorridor: Object.freeze([...onCorridor].sort((x, y) => x - y)), frags: Object.freeze(frags), segDark })
})
export const storeyInfo = (worldSeed, dx, dz, cy) => infoMemo(`${worldSeed >>> 0},${dx},${dz},${cy}`, worldSeed >>> 0, dx, dz, cy)

// --- routing (shared with tile.js's fragment spines) ----------------------------------

// A seeded shortest path for a w×w brush over a W×H cell grid: `free(x, z)`
// says whether a cell may be covered; the brush at (x, z) covers x..x+w−1,
// z..z+w−1. Moves cost `step + noise(x, z)`, a turn `turn` more. Returns the
// brush positions from a source to the first target reached, or null.
// Dijkstra on a binary heap over (position, heading).
export function routeBrush({ W, H, w, free, sources, isTarget, noise, step = 2, turn = 4 }) {
  const PW = W - w + 1
  const PH = H - w + 1
  if (PW <= 0 || PH <= 0) return null
  const N = PW * PH
  const ok = new Uint8Array(N)
  for (let z = 0; z < PH; z++) {
    for (let x = 0; x < PW; x++) {
      let f = 1
      for (let j = 0; j < w && f; j++) for (let i = 0; i < w && f; i++) if (!free(x + i, z + j)) f = 0
      ok[z * PW + x] = f
    }
  }
  const dist = new Int32Array(N * 4).fill(0x3fffffff)
  const prev = new Int32Array(N * 4).fill(-1)
  const heap = []
  const push = (v) => {
    heap.push(v)
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p] <= heap[i]) break
      ;[heap[p], heap[i]] = [heap[i], heap[p]]
      i = p
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < heap.length && heap[l] < heap[m]) m = l
        if (r < heap.length && heap[r] < heap[m]) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i], heap[m]]
        i = m
      }
    }
    return top
  }
  const K = N * 4
  for (const [x, z] of sources) {
    if (x < 0 || z < 0 || x >= PW || z >= PH) continue
    const b = z * PW + x
    if (!ok[b]) continue
    for (let d = 0; d < 4; d++) {
      dist[b * 4 + d] = 0
      push(b * 4 + d)
    }
  }
  const DX = [1, -1, 0, 0]
  const DZ = [0, 0, 1, -1]
  while (heap.length) {
    const v = pop()
    const st = v % K
    const c = (v - st) / K
    if (c > dist[st]) continue
    const b = st >> 2
    const d = st & 3
    const x = b % PW
    const z = (b - x) / PW
    if (isTarget(x, z)) {
      const path = []
      for (let s = st; s >= 0; s = prev[s]) {
        const bb = s >> 2
        const px = bb % PW
        const pz = (bb - px) / PW
        if (!path.length || path[path.length - 1][0] !== px || path[path.length - 1][1] !== pz) path.push([px, pz])
      }
      return path.reverse()
    }
    for (let nd = 0; nd < 4; nd++) {
      if ((nd ^ 1) === d) continue
      const nx = x + DX[nd]
      const nz = z + DZ[nd]
      if (nx < 0 || nz < 0 || nx >= PW || nz >= PH) continue
      const nb = nz * PW + nx
      if (!ok[nb]) continue
      const nc = c + step + noise(nx, nz) + (nd === d ? 0 : turn)
      const ns = nb * 4 + nd
      if (nc < dist[ns]) {
        dist[ns] = nc
        prev[ns] = st
        push(nc * K + ns)
      }
    }
  }
  return null
}

// The 2×2 brush positions covering a landing's door cell and the cell beyond.
function startBlocks(S) {
  const a = S.out
  const b = { x: S.out.x + S.n[0], z: S.out.z + S.n[1] }
  const out = []
  for (let z = Math.min(a.z, b.z) - 1; z <= Math.min(a.z, b.z) + 1; z++) {
    for (let x = Math.min(a.x, b.x) - 1; x <= Math.min(a.x, b.x) + 1; x++) {
      const has = (c) => c.x >= x && c.x <= x + 1 && c.z >= z && c.z <= z + 1
      if (has(a) && has(b)) out.push([x, z])
    }
  }
  return out
}

// One district-storey's corridors: each rung (a 2-wide route between its
// pair's landings) and the long rung (from the attached landing, or from a
// rung corridor leaving it, to the port block). A route keeps clear of every
// core and of the approaches of the landings it does not join. Returns
// { cells (Uint8Array over the district, 1 = corridor), paths: [{ from, to,
// blocks }] } (`to` is a shaft index, or the long rung's side).
function routeCorridors(seed, info) {
  const L = info.layout
  const { rungs, ext } = info
  if (!rungs.length && !ext) return null
  const h = (i) => hk(seed, S_ROUTE, info.dx, info.dz, info.cy, i)
  // Cost field: 8×8-cell patches of 0..4, and the storey's turn penalty.
  const patch = new Uint8Array(49)
  for (let i = 0; i < 49; i++) patch[i] = h(100 + i) % 5
  const noise = (x, z) => patch[(z >> 3) * 7 + (x >> 3)]
  const turn = 2 + (h(1) % 7)
  const cells = new Uint8Array(CELLS)
  const paths = []
  const blocked = (x, z, ends, port) => {
    const i = z * SPAN + x
    if (L.core[i]) return true
    if ((x === SPAN - 1 || z === SPAN - 1) && !(port && port.some(([px, pz]) => px === x && pz === z))) return true
    return (L.nearBits[i] & ~ends) !== 0
  }
  const relaxed = (x, z, port) => !L.core[z * SPAN + x] && ((x < SPAN - 1 && z < SPAN - 1) || (port && port.some(([px, pz]) => px === x && pz === z)))
  const mark = (path) => {
    for (const [x, z] of path) {
      cells[z * SPAN + x] = 1
      cells[z * SPAN + x + 1] = 1
      cells[(z + 1) * SPAN + x] = 1
      cells[(z + 1) * SPAN + x + 1] = 1
    }
  }
  for (const rung of rungs) {
    const [sa, sb] = rung.pair
    const tb = new Set(startBlocks(L.shafts[sb]).map(([x, z]) => `${x},${z}`))
    const run = (relax) => routeBrush({
      W: SPAN, H: SPAN, w: 2,
      free: (x, z) => !blocked(x, z, (1 << rung.pair[0]) | (1 << rung.pair[1]), null) || (relax && relaxed(x, z, null)),
      sources: startBlocks(L.shafts[sa]),
      isTarget: (x, z) => tb.has(`${x},${z}`),
      noise, turn,
    })
    const path = run(false) ?? run(true)
    if (!path) throw new Error(`stairwell: no rung route in ${info.dx},${info.dz} storey ${info.cy}`)
    mark(path)
    paths.push(Object.freeze({ from: sa, to: sb, blocks: Object.freeze(path) }))
  }
  if (ext) {
    const sources = [...startBlocks(L.shafts[ext.shaft])]
    for (const p of paths) if (p.from === ext.shaft || p.to === ext.shaft) sources.push(...p.blocks)
    const [tx, tz] = ext.block
    const run = (relax) => routeBrush({
      W: SPAN, H: SPAN, w: 2,
      free: (x, z) => !blocked(x, z, 1 << ext.shaft, ext.cells) || (relax && relaxed(x, z, ext.cells)),
      sources,
      isTarget: (x, z) => x === tx && z === tz,
      noise, turn,
    })
    const path = run(false) ?? run(true)
    if (!path) throw new Error(`stairwell: no long-rung route in ${info.dx},${info.dz} storey ${info.cy}`)
    mark(path)
    paths.push(Object.freeze({ from: ext.shaft, to: ext.side, blocks: Object.freeze(path) }))
  }
  return { cells, paths: Object.freeze(paths) }
}

// --- the storey plan ------------------------------------------------------------------

// A landing's DOMAIN on a storey: the district cells it may build its
// fragment in, a rectangle. The layout's binary partition is cut, node by
// node, on a line inside the node's valid interval, hashed from the runs of
// the two shafts bounding the cut (a shaft on a corridor: from the storey),
// so the line between two landings' worlds (the cell of mass a StoreyGrid
// keeps between two owners) falls anywhere, never on the chunk lattice, and
// moves only when one of those runs changes. Each leaf rectangle is then cut
// back to the kind's reach round its core; cores are nobody's, and a bricked
// landing's rectangle is mass.
// A fragment's SITE (doc §4.2: "fragment up to 10 × 10", on the door's side
// of the core): a rectangle `depth` cells out from the fire door (the
// two-cell vestibule included) and `width` across it, the door column at a
// hashed place across the width, so a run's fragment slides, narrows and
// deepens from landing to landing. [depth range, width range] per kind. A
// shaft on a rung corridor keeps a small share round its core for the few
// rooms off the corridor (WING cells beyond the core's rectangle).
export const SITE = Object.freeze({
  corridor: Object.freeze([[9, 12], [9, 12]]),
  toilets: Object.freeze([[8, 10], [8, 10]]),
  closets: Object.freeze([[8, 11], [8, 10]]),
  office: Object.freeze([[9, 11], [9, 11]]),
  plant: Object.freeze([[9, 11], [8, 10]]),
  carpark: Object.freeze([[11, 13], [11, 13]]),
})
const WING = 8

// The site of a `kind` fragment off landing S ({ out, n } in any frame):
// h(i) is the run's dice. Returns the inclusive rectangle in S's frame.
export function fragmentSite(kind, S, h) {
  const [[d0, d1], [w0, w1]] = SITE[kind]
  const depth = d0 + (h(1) % (d1 - d0 + 1))
  const width = w0 + (h(2) % (w1 - w0 + 1))
  const p = 1 + (h(3) % (width - 2))
  const t = [S.n[1], S.n[0]]
  const ax = S.out.x - t[0] * p
  const az = S.out.z - t[1] * p
  const bx = S.out.x + S.n[0] * (depth - 1) + t[0] * (width - 1 - p)
  const bz = S.out.z + S.n[1] * (depth - 1) + t[1] * (width - 1 - p)
  return Object.freeze({ x0: Math.min(ax, bx), x1: Math.max(ax, bx), z0: Math.min(az, bz), z1: Math.max(az, bz) })
}

function domains(seed, info, L) {
  const n = L.n
  const site = new Array(n).fill(null)
  const key = new Int32Array(n)
  // The cuts between shares are the band's (a landing's share holds while
  // its neighbours change runs, so a run's storeys stay near-copies); the
  // rung storeys recut round their corridors.
  const cutKey = new Int32Array(n).fill(info.band * 4096)
  for (const f of info.frags) {
    key[f.s] = info.band * 4096 + (f.run & 255)
    if (f.kind === 'bricked') continue
    site[f.s] = fragmentSite(f.kind, L.shafts[f.s], dice(hk(seed, S_SITE, info.dx, info.dz, f.s, key[f.s]), S_SITE))
  }
  for (const s of info.onCorridor) {
    key[s] = 0x100000 + info.cy
    cutKey[s] = key[s]
    const c = L.shafts[s].core
    site[s] = { x0: c.x0 - WING, x1: c.x1 + WING, z0: c.z0 - WING, z1: c.z1 + WING }
  }
  // The share a landing may build in (doc §4.2: "inside the remaining
  // 13×13 of the chunk"): its own chunk, and its site where the site runs on
  // past the chunk's edge.
  const claim = site.map((q, s) => {
    if (!q) return null
    const c = L.shafts[s].core
    const R = 8
    return { x0: Math.min(q.x0, c.x0 - R), x1: Math.max(q.x1, c.x1 + R), z0: Math.min(q.z0, c.z0 - R), z1: Math.max(q.z1, c.z1 + R) }
  })
  const owner = new Int8Array(CELLS).fill(-1)
  const walk = (node, box) => {
    if (node.leaf !== undefined) {
      const s = node.leaf
      const q = claim[s]
      if (!q) return
      const x0 = Math.max(box.x0, q.x0)
      const x1 = Math.min(box.x1, q.x1)
      const z0 = Math.max(box.z0, q.z0)
      const z1 = Math.min(box.z1, q.z1)
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (!L.core[z * SPAN + x]) owner[z * SPAN + x] = s
      return
    }
    const cut = node.lo + (hk(seed, S_CLAIM, info.dx, info.dz, node.lb * 64 + node.rb, cutKey[node.lb] * 31 + cutKey[node.rb]) % (node.hi - node.lo + 1))
    if (node.axis === 'x') {
      walk(node.left, { ...box, x1: cut - 1 })
      walk(node.right, { ...box, x0: cut })
    } else {
      walk(node.left, { ...box, z1: cut - 1 })
      walk(node.right, { ...box, z0: cut })
    }
  }
  walk(L.bsp, { x0: 0, x1: SPAN - 1, z0: 0, z1: SPAN - 1 })
  return { owner, sites: Object.freeze(site.map((q) => (q ? Object.freeze(q) : null))) }
}

// The full storey plan of district (dx, dz) on storey cy: the info, the
// corridors, each fragment's claim (its run's), the corridor's claim (the
// chunks it runs through, and the own chunks and territories of the shafts
// it joins, where it grows its side rooms) and the 16-bit mask of non-solid
// chunks (bit ix + 4·iz). Every shaft chunk is kept; a shaftless chunk is
// kept when a claim or a corridor takes it, solid otherwise.
const planMemo = memo(8192, (seed, dx, dz, cy) => {
  const info = storeyInfo(seed, dx, dz, cy)
  const L = info.layout
  const corridors = routeCorridors(seed, info)
  const { owner, sites } = domains(seed, info, L)
  let mask = 0
  for (const S of L.shafts) mask |= 1 << S.chunk
  const corridorChunks = new Set()
  const chunkOf = (i) => (((i % SPAN) / CHUNK) | 0) + DISTRICT * (((i / SPAN) / CHUNK) | 0)
  if (corridors) {
    for (let z = 0; z < SPAN; z++) {
      for (let x = 0; x < SPAN; x++) {
        if (!corridors.cells[z * SPAN + x]) continue
        const ix = (x / CHUNK) | 0
        const iz = (z / CHUNK) | 0
        corridorChunks.add(ix + DISTRICT * iz)
        // A corridor cell on a chunk's east column or south row keeps the
        // neighbour too (§6.8 rule 1: it may not face a foreign chunk).
        if (x % CHUNK === CHUNK - 1 && ix < DISTRICT - 1) corridorChunks.add(ix + 1 + DISTRICT * iz)
        if (z % CHUNK === CHUNK - 1 && iz < DISTRICT - 1) corridorChunks.add(ix + DISTRICT * (iz + 1))
      }
    }
  }
  // The chunks each landing's domain reaches (its claim); a bricked landing
  // has none (mass behind its door).
  const live = new Uint8Array(L.n)
  for (const f of info.frags) if (f.kind !== 'bricked') live[f.s] = 1
  for (const s of info.onCorridor) live[s] = 1
  // A share's sliver in a chunk other than its own (under 20 cells) is cut
  // back to mass: a chunk is kept for a landing's fragment only where the
  // fragment has room to be something.
  const per = new Uint16Array(L.n * 16)
  for (let i = 0; i < CELLS; i++) if (owner[i] >= 0) per[owner[i] * 16 + chunkOf(i)]++
  const reached = L.shafts.map(() => new Set())
  for (let i = 0; i < CELLS; i++) {
    const s = owner[i]
    if (s < 0) continue
    const c = chunkOf(i)
    if (!live[s] || (c !== L.shafts[s].chunk && per[s * 16 + c] < 20)) {
      owner[i] = -1
      continue
    }
    reached[s].add(c)
  }
  const claims = info.frags.map((f) => Object.freeze([L.shafts[f.s].chunk, ...[...reached[f.s]].filter((c) => c !== L.shafts[f.s].chunk).sort((a, b) => a - b)]))
  const wingChunks = new Set()
  for (const s of info.onCorridor) for (const c of reached[s]) wingChunks.add(c)
  for (const c of wingChunks) corridorChunks.add(c)
  for (const c of corridorChunks) mask |= 1 << c
  for (const claim of claims) for (const c of claim) mask |= 1 << c
  return Object.freeze({
    ...info,
    corridors,
    owner,
    sites,
    corridorChunks: Object.freeze([...corridorChunks].sort((a, b) => a - b)),
    claims: Object.freeze(claims),
    mask,
  })
})
export const storeyPlan = (worldSeed, dx, dz, cy) => planMemo(`${worldSeed >>> 0},${dx},${dz},${cy}`, worldSeed >>> 0, dx, dz, cy)

// The cells of a district-storey that stay DARK whatever the bake's fill
// light does (doc §4.3 "Dark floor: everything, no lit lamp"; §8 breaker
// segments): every cell of a dark fragment's share (a dark run, or the
// landing's breaker segment) off the routed corridors, and the core of every
// landing whose tubes are dead (its segment, flipped by a 'dead-landing'
// anomaly), but for the exit landing's. Uint8Array over the district's
// cells (1 = dark), or null when the storey has none. Pure in (worldSeed, dx, dz, cy).
const darkMemo = memo(4096, (seed, dx, dz, cy) => {
  const P = storeyPlan(seed, dx, dz, cy)
  const L = P.layout
  // The exit landing (shaft B, storey G, district (0,0)) is never held dark.
  const exitS = dx === 0 && dz === 0 && cy === exitStorey(seed) ? 1 : -1
  let darkS = 0
  for (const f of P.frags) if (f.kind !== 'bricked' && f.s !== exitS && (f.dark || P.segDark[f.s])) darkS |= 1 << f.s
  const deadCore = L.shafts.filter((S) => {
    if (S.s === exitS) return false
    const a = anomalyAt(seed, dx, dz, S.s, cy)
    return P.segDark[S.s] !== (a !== null && a.cy === cy && a.kind === 'dead-landing')
  })
  if (!darkS && !deadCore.length) return null
  const m = new Uint8Array(CELLS)
  if (darkS) {
    for (let i = 0; i < CELLS; i++) {
      const s = P.owner[i]
      if (s >= 0 && ((darkS >> s) & 1) === 1 && !(P.corridors && P.corridors.cells[i])) m[i] = 1
    }
  }
  for (const S of deadCore) {
    for (let z = S.core.z0; z <= S.core.z1; z++) for (let x = S.core.x0; x <= S.core.x1; x++) m[z * SPAN + x] = 1
  }
  return m
})
export const darkCells = (worldSeed, dx, dz, cy) => darkMemo(`${worldSeed >>> 0},${dx},${dz},${cy}`, worldSeed >>> 0, dx, dz, cy)

// Number of non-solid chunks of a district-storey (the §12.1 footprint metric).
export function footprintCount(worldSeed, dx, dz, cy) {
  let m = storeyPlan(worldSeed, dx, dz, cy).mask
  let n = 0
  for (; m; m &= m - 1) n++
  return n
}

// --- generator geometry exports (§6.5) --------------------------------------------

// 'tile' for the shaft chunks, the claims and the corridor chunks of storey
// cy; every other chunk is solid mass, never baked.
export function footprint(worldSeed, cx, cy, cz) {
  const dx = floorDiv(cx, DISTRICT)
  const dz = floorDiv(cz, DISTRICT)
  const bit = 1 << (cx - dx * DISTRICT + DISTRICT * (cz - dz * DISTRICT))
  return storeyPlan(worldSeed, dx, dz, cy).mask & bit ? 'tile' : 'solid'
}

// Shaft chunks: every storey of them holds a flight up (verticalOpeningAt).
export function isShaftChunk(worldSeed, cx, cz) {
  const dx = floorDiv(cx, DISTRICT)
  const dz = floorDiv(cz, DISTRICT)
  const L = districtLayout(worldSeed, dx, dz)
  const c = cx - dx * DISTRICT + DISTRICT * (cz - dz * DISTRICT)
  return L.shafts.some((S) => S.chunk === c)
}

// Seam ports (tile-local along-cells, inclusive), pure and band-independent
// in form: the west line of district (tx, tz) is the east x-seam of
// (tx − 1, tz), open on its long-rung storey at xPort; the north line is the
// south z-seam of (tx, tz − 1), open at zPort.
const NO_PORTS = Object.freeze([])
export function ports(worldSeed, { tx, tz }, side, cy) {
  const band = floorDiv(cy, BAND)
  if (side === 'west') {
    if (xSeamStorey(worldSeed, tx - 1, tz, band) !== cy) return NO_PORTS
    const a = xPort(worldSeed, tx - 1, tz, band)
    return Object.freeze([Object.freeze({ a0: a, a1: a + 1 })])
  }
  if (side === 'north') {
    if (zSeamStorey(worldSeed, tx, tz - 1, band) !== cy) return NO_PORTS
    const a = zPort(worldSeed, tx, tz - 1, band)
    return Object.freeze([Object.freeze({ a0: a, a1: a + 1 })])
  }
  return NO_PORTS
}

// --- exit ------------------------------------------------------------------------------

// The exit storey G ∈ [−40, −15] (§12.1): shaft B's landing in district (0,0).
export const exitStorey = (worldSeed) => -(15 + (hk(worldSeed, S_EXIT) % 26))
export const EXIT_CY = Object.freeze([-40, -15])

// The pure exit anchor: shaft B's door cell (the landing's fragment side) on
// storey G of district (0,0) — GLOBAL chunk, chunk-local cell.
export function exitAnchor(worldSeed) {
  const B = districtLayout(worldSeed, 0, 0).B
  return Object.freeze({ cx: B.ix, cy: exitStorey(worldSeed), cz: B.iz, lx: B.out.x - B.ix * CHUNK, lz: B.out.z - B.iz * CHUNK })
}

// The spawn: shaft A's landing inside its fire door, district (0,0), storey 0.
export function spawnCell(worldSeed) {
  const A = districtLayout(worldSeed, 0, 0).A
  return Object.freeze({ cx: A.ix, cz: A.iz, lx: A.inside.x - A.ix * CHUNK, lz: A.inside.z - A.iz * CHUNK })
}

// --- anomalies and labels ------------------------------------------------------------

// One anomaly per (district, shaft, 8-storey octave) (doc §10, the 1-per-8
// budget of 14-anomalies-and-threats.md): mostly a lying plate (doc §4.5),
// sometimes a landing deviation. Never on storey G, 0 ± 1 or a storey where
// that shaft's landing opens on a corridor (spec §12.1). A reversal needs its
// pair storey (cy + 1, same octave) allowed too. Only shaft A may skip.
const LIES_A = Object.freeze([['skip', 2], ['repeat', 2], ['reversal', 2], ['foreign', 2], ['impossible', 2], ['no-standpipe', 1], ['two-standpipes', 1], ['dead-landing', 1]])
const LIES_B = Object.freeze([['repeat', 2], ['reversal', 2], ['foreign', 2], ['impossible', 2], ['no-standpipe', 1], ['two-standpipes', 1], ['dead-landing', 1]])
export const LABEL_LIES = Object.freeze(['skip', 'repeat', 'reversal', 'foreign', 'impossible'])
export const IMPOSSIBLE = Object.freeze(['-0', '9999', 'HErE', '    '])

// Whether storey cy is closed to shaft s's anomalies in district (dx, dz).
export function anomalyBlocked(worldSeed, dx, dz, s, cy) {
  if (cy === exitStorey(worldSeed) || (cy >= -1 && cy <= 1)) return true
  return storeyInfo(worldSeed, dx, dz, cy).onCorridor.includes(s)
}

// The first allowed storey of the octave for a kind, scanning from the
// hashed offset and wrapping (a reversal scans 7 starts so its pair stays in
// the octave), or null when the whole octave is closed.
function octaveSlot(seed, dx, dz, s, oct, kind, start) {
  const n = kind === 'reversal' ? 7 : 8
  for (let i = 0; i < n; i++) {
    const cy = oct * 8 + ((start + i) % n)
    if (anomalyBlocked(seed, dx, dz, s, cy)) continue
    if (kind === 'reversal' && anomalyBlocked(seed, dx, dz, s, cy + 1)) continue
    return cy
  }
  return null
}

const anomalyMemo = memo(8192, (seed, dx, dz, s, oct) => {
  const table = s === 0 ? LIES_A : LIES_B
  const sum = table.reduce((t, [, w]) => t + w, 0)
  const h = (i) => hk(seed, S_LIE, dx, dz, oct * 4 + s, i)
  let roll = h(0) % sum
  let kind = table[0][0]
  for (const [k, w] of table) {
    if (roll < w) {
      kind = k
      break
    }
    roll -= w
  }
  let cy = octaveSlot(seed, dx, dz, s, oct, kind, h(1) % (kind === 'reversal' ? 7 : 8))
  // No free pair for a reversal: the octave still gets its one deviation,
  // as a single-storey lie.
  if (cy === null && kind === 'reversal') {
    kind = 'foreign'
    cy = octaveSlot(seed, dx, dz, s, oct, kind, h(1) % 8)
  }
  if (cy === null) return null
  return Object.freeze({ cy, kind, pick: h(2) })
})
// The anomaly of shaft s (0 = A, 1 = B, 2 = C) in the octave holding storey cy, or null.
export const anomalyAt = (worldSeed, dx, dz, s, cy) => {
  const oct = floorDiv(cy, 8)
  return anomalyMemo(`${worldSeed >>> 0},${dx},${dz},${s},${oct}`, worldSeed >>> 0, dx, dz, s, oct)
}

// Shaft A's skips shift every label above them (and none below storey 0
// moves the other way): the count's offset from cy + offsetA, as the signed
// number of skip storeys between 0 and cy. Pure; O(|cy| / 8).
function skipShift(seed, dx, dz, cy) {
  let n = 0
  const lo = Math.min(0, cy)
  const hi = Math.max(0, cy)
  for (let oct = floorDiv(lo, 8); oct <= floorDiv(hi, 8); oct++) {
    const a = anomalyAt(seed, dx, dz, 0, oct * 8)
    if (!a || a.kind !== 'skip') continue
    if (cy >= 0 ? a.cy > 0 && a.cy <= cy : a.cy > cy && a.cy <= 0) n++
  }
  return cy >= 0 ? n : -n
}

// The honest count of shaft s on storey cy: shaft B counts cy − G + 1 (1 at
// the exit), shaft A cy + offsetA plus its skips, shaft C cy + its offset.
export function shaftCount(worldSeed, dx, dz, s, cy) {
  if (s === 1) return cy - exitStorey(worldSeed) + 1
  const L = districtLayout(worldSeed, dx, dz)
  if (s >= 2) return cy + L.offsets[s]
  return cy + L.offsetA + skipShift(worldSeed >>> 0, dx, dz, cy)
}

// A number as ≤ 4 plate glyphs.
export const plate = (n) => (n >= 0 ? String(n % 10000) : `-${(-n) % 1000}`)

// The plate of shaft s on storey cy (closed form): the count, unless the
// octave's anomaly is a lie on this storey (or on its reversal pair).
export function labelAt(worldSeed, dx, dz, s, cy) {
  const count = (y) => shaftCount(worldSeed, dx, dz, s, y)
  const a = anomalyAt(worldSeed, dx, dz, s, cy)
  if (a) {
    if (a.kind === 'repeat' && a.cy === cy) return plate(count(cy - 1))
    if (a.kind === 'reversal' && a.cy === cy) return plate(count(cy + 1))
    if (a.kind === 'reversal' && a.cy + 1 === cy) return plate(count(cy - 1))
    if (a.kind === 'foreign' && a.cy === cy) {
      const n = Math.abs(count(cy)) % 1000
      return [`b${n}`, `${n}F`, `${Math.abs(count(cy) - 1) % 1000}A`][a.pick % 3]
    }
    if (a.kind === 'impossible' && a.cy === cy) return IMPOSSIBLE[a.pick % IMPOSSIBLE.length]
  }
  return plate(count(cy))
}
