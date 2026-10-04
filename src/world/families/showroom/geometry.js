import { CHUNK } from '../../constants.js'
import { MAP_FAMILY_SHOWROOM } from '../ids.js'
import { FAMILY_SALT, hashChain, tileKeyAt, tileKeyOf, tileSeed } from '../../tiles/tileKey.js'

// The showroom family's pure geometry (spec §3.3, §12.3): the tile, its
// footprint and hashed seam ports, the district's MACRO PLAN (the route's
// coarse lattice, its serpentine and lanes, the port spurs, the two stair
// cores and the hall's lobby corridor), the spawn, the exit tile, the
// per-tile anomaly and the plate texts. Everything here is a pure function
// of (worldSeed, global coordinates), so the planner (structures.js), the
// layout grammar (layout.js), the bake (district.js) and the hooks agree.
//
// Planner-chain module (§7.5): it may import only constants.js, core/hash.js,
// core/rng.js, mapTypes.js, mapFamily.js ({deepFreeze, MAP_FAMILY_CODES}),
// structures/catalog/engine.js, families/ids.js, tiles/tileKey.js and
// tiles/stubPlanner.js. Never tiles/stub.js, the canvas or the kit.
//
// Kind-local frame: storeys DOWN = 0 (market hall, warehouse, checkouts) and
// UP = 1 (the showroom route); cells x, z 0..27 (2×2 chunks). The world tile
// is 2×2 chunks × storeys −1..0 (origin.cy = −1), so kind storey n is global
// storey n − 1 and kind cell (gx, gz) of tile (tx, tz) is global
// (tx·28 + gx, tz·28 + gz). Cells 0..26 are the district; column x 27 and
// row z 27 are the mass a tile shows its east and south neighbours (§6.8
// rule 1), open only at the ports.
//
// THE DISTRICT IS GENERATED, NOT COPIED (doc 09 §4.4). Per tile, from its own
// dice (hashChain of the tile's planSeed and coordinates, mirror-free):
//   1. a coarse lattice of 3–4 × 3–4 blocks with random cut positions (block
//      sides 6–11 cells);
//   2. a Hamiltonian serpentine through the blocks (random DFS, random start)
//      — the one-way route, a 2-wide lane per block at a random offset per
//      lattice row and column, so straights, turns and U-turns land
//      anywhere;
//   3. stair A at the route's first block and stair B at its last, each core
//      (6×4, either orientation, door near or far) placed where its door
//      opens onto that block's lane, in two different chunks;
//   4. spurs (2-wide, shortest path round the cores) from the route storey's
//      N/S seam ports to the nearest lane;
//   5. the hall storey's lobby corridor from the x-seam's west port to stair
//      A's door, and a check that the rest of the hall (stair B's door, the
//      east port) is one region.
// A draw that breaks a rule (no core fits, a spur or corridor is blocked) is
// thrown away and the next attempt is drawn: still pure in the tile.
//
// The chain (doc §4.1 "districts chain into an infinite route"):
//   - along x, on the hall storey (cy −1): every district's checkouts leave
//     through its east port into the east neighbour's lobby corridor, which
//     climbs stair A to that district's route start;
//   - along z, on the route storey (cy 0): one 2-wide passage per seam, at an
//     x hashed per seam, spurring into the route on both sides.

export const FAMILY = MAP_FAMILY_SHOWROOM

// Kind-local storeys.
export const DOWN = 0
export const UP = 1

// The tile (§6.2): 2×2 chunks, backend 'band', one band of two storeys
// (−1 hall, 0 route). Salt = FAMILY_SALT.showroom (0x5a170000 + 7).
export const TILE = Object.freeze({ w: 2, d: 2, backend: 'band', H: 2, lo: -1, hi: 0, salt: FAMILY_SALT.showroom })
export const TILE_CELLS = TILE.w * CHUNK // 28 cells per tile side
export const N = TILE_CELLS - 1 // 27: the district's cells are 0..26
const W = TILE_CELLS // grid stride (cells 0..27)
export const idx = (x, z) => z * W + x

// The kind's region (cells x, z 0..27).
export const REGION = Object.freeze({ x0: 0, z0: 0, x1: N, z1: N })

// --- footprint and ports ----------------------------------------------------------

// §6.5 footprint: both storeys of every tile are drawn; every other storey is
// solid mass, never baked.
export function footprint(worldSeed, cx, cy, cz) {
  return tileKeyOf(TILE, cx, cy, cz) ? 'tile' : 'solid'
}

const NO_PORTS = Object.freeze([])
const PORT_MIN = 2
const PORT_SPAN = N - 1 - 2 * PORT_MIN // a0 ∈ 2..23 (a1 = a0 + 1 ≤ 24)
const S_NS = 0x0b5e
const S_X = 0x0b5f

// A memo of small pure results (bounded).
function memo(limit) {
  const m = new Map()
  return (key, make) => {
    let v = m.get(key)
    if (v === undefined) {
      v = make()
      if (m.size >= limit) m.clear()
      m.set(key, v)
    }
    return v
  }
}
const portMemo = memo(8192)

// The route storey's passage through the seam between tile (tx, tz − 1)
// (its south row) and tile (tx, tz) (its north line): 2 wide, at an x hashed
// per seam, mirror-free.
export function northPortOf(worldSeed, tx, tz) {
  return portMemo(`n${worldSeed >>> 0},${tx},${tz}`, () => {
    const a0 = PORT_MIN + (hashChain(((worldSeed >>> 0) ^ S_NS) | 0, tx, tz) % PORT_SPAN)
    return Object.freeze([Object.freeze({ a0, a1: a0 + 1 })])
  })
}

// The hall storey's passage through the seam between tile (tx − 1, tz) (its
// east column: the checkouts' way out) and tile (tx, tz) (its west line: the
// lobby corridor to stair A): 2 wide, at a z hashed per seam.
export function westPortOf(worldSeed, tx, tz) {
  return portMemo(`w${worldSeed >>> 0},${tx},${tz}`, () => {
    const a0 = PORT_MIN + (hashChain(((worldSeed >>> 0) ^ S_X) | 0, tx, tz) % PORT_SPAN)
    return Object.freeze([Object.freeze({ a0, a1: a0 + 1 })])
  })
}

// Ports (§6.5, §6.8), tile-local along-cells, inclusive; pure and
// band-independent. West: the hall storey's x seam; north: the route
// storey's z seam.
export function ports(worldSeed, k, side, cy) {
  if (side === 'west') return cy === DOWN - 1 ? westPortOf(worldSeed, k.tx, k.tz) : NO_PORTS
  if (side === 'north') return cy === UP - 1 ? northPortOf(worldSeed, k.tx, k.tz) : NO_PORTS
  return NO_PORTS
}

// --- tile keys and dice ----------------------------------------------------------

// The tile key (band 0) of tile (tx, tz) and its planSeed.
export const bandKey = (tx, tz) => tileKeyAt(TILE, tx, tz, 0)
export const planSeedOf = (worldSeed, k) => tileSeed(worldSeed >>> 0, TILE.salt, k)
// Per-tile variety that must not repeat at the mirror tile (−tx, −tz).
export const varietySeed = (seed, k) => hashChain(seed | 0, k.tx, k.tz, k.band)
// Index-keyed dice: d(a, b) is a uint32 of (seed, a, b).
export const diceOf = (seed) => (a, b = 0) => hashChain(seed | 0, a, b)

// --- the district's macro plan ------------------------------------------------------

const DIRS = [[1, 0, 'E'], [-1, 0, 'W'], [0, 1, 'S'], [0, -1, 'N']]

// n parts of `total` cells, each in [lo, hi], in random order.
function compose(d, salt, total, n, lo, hi) {
  const parts = new Array(n).fill(lo)
  let rest = total - lo * n
  for (let i = 0; rest > 0 && i < 64; i++) {
    const j = d(salt, i) % n
    if (parts[j] < hi) {
      parts[j]++
      rest--
    }
  }
  for (let j = 0; rest > 0 && j < n; j++) {
    const add = Math.min(rest, hi - parts[j])
    parts[j] += add
    rest -= add
  }
  return parts
}

// A lane offset in a block of width w: the side pockets stay 0 or ≥ 3 cells.
function laneOffset(d, salt, w) {
  const good = []
  for (let o = 0; o <= w - 2; o++) {
    const a = o
    const b = w - 2 - o
    if ((a === 0 || a >= 3) && (b === 0 || b >= 3)) good.push(o)
  }
  return good[d(salt, 7) % good.length]
}

// A Hamiltonian path through the nx × nz lattice (random DFS with a
// Warnsdorff tie-break), or null within the step budget.
function serpentine(d, salt, nx, nz) {
  const n = nx * nz
  const start = d(salt, 1) % n
  const seen = new Uint8Array(n)
  const path = [start]
  seen[start] = 1
  let steps = 0
  const nbrs = (c) => {
    const x = c % nx
    const z = (c - x) / nx
    const out = []
    for (const [dx, dz] of DIRS) {
      const a = x + dx
      const b = z + dz
      if (a >= 0 && a < nx && b >= 0 && b < nz) out.push(b * nx + a)
    }
    return out
  }
  const free = (c) => nbrs(c).filter((m) => !seen[m]).length
  const go = () => {
    if (path.length === n) return true
    if (++steps > 4000) return false
    const c = path[path.length - 1]
    const opts = nbrs(c).filter((m) => !seen[m])
    opts.sort((p, q) => free(p) - free(q) || (d(salt, 100 + steps * 4 + p) % 7) - (d(salt, 100 + steps * 4 + q) % 7))
    for (const m of opts) {
      seen[m] = 1
      path.push(m)
      if (go()) return true
      path.pop()
      seen[m] = 0
    }
    return false
  }
  return go() ? path : null
}

// The 6×4 (E/W flights) or 4×6 (N/S flights) core whose door opens onto
// cell (x, z), for a stair `dir` and door side; null when it would not sit
// strictly inside one chunk (structures/authored.js stairwellPlan).
function coreAt(x, z, dir, doorSide) {
  const horizontal = dir === 'E' || dir === 'W'
  let x0
  let z0
  if (horizontal) {
    x0 = x - 2
    z0 = doorSide === 'near' ? z + 1 : z - 4
  } else {
    z0 = z - 2
    x0 = doorSide === 'near' ? x + 1 : x - 4
  }
  const x1 = x0 + (horizontal ? 5 : 3)
  const z1 = z0 + (horizontal ? 3 : 5)
  const inChunk = (a, b) => a >= 0 && Math.floor(a / CHUNK) === Math.floor(b / CHUNK) && a % CHUNK >= 1 && b % CHUNK <= CHUNK - 2
  if (!inChunk(x0, x1) || !inChunk(z0, z1) || x1 > N - 1 || z1 > N - 1) return null
  // The landing (stairwellPlan's gx, gz) of this core.
  const gx = dir === 'W' ? x0 + 4 : x0 + 1
  const gz = dir === 'N' ? z0 + 4 : z0 + 1
  return { gx, gz, dir, doorSide, core: { x0, z0, x1, z1 }, door: { x, z }, chunk: { cx: Math.floor(x0 / CHUNK), cz: Math.floor(z0 / CHUNK) } }
}

// The cheapest path of s×s blocks (a step costs 4, a turn 3 more, so paths
// run straight and turn seldom) from block `from` to a block `goal(x, z, s)`
// accepts, over cells `free(x, z)`; the path's cells, or null. Ties break on
// the tile's dice.
function blockPath(d, salt, from, goal, free, s, startDir = 4) {
  const ok = (x, z) => {
    if (x < 0 || z < 0 || x + s - 1 > N - 1 || z + s - 1 > N - 1) return false
    for (let b = 0; b < s; b++) for (let a = 0; a < s; a++) if (!free(x + a, z + b)) return false
    return true
  }
  if (!ok(from.x, from.z)) return null
  const S = W * W * 5 // state = cell * 5 + incoming dir (4 = start)
  const cost = new Int32Array(S).fill(-1)
  const prev = new Int32Array(S).fill(-1)
  const buckets = []
  const push = (st, c) => {
    ;(buckets[c] ??= []).push(st)
  }
  const s0 = idx(from.x, from.z) * 5 + startDir
  cost[s0] = 0
  push(s0, 0)
  const rot = d(salt, 0) % 4
  let hit = -1
  for (let c = 0; c < buckets.length && hit < 0; c++) {
    const list = buckets[c]
    if (!list) continue
    for (let li = 0; li < list.length; li++) {
      const st = list[li]
      if (cost[st] !== c) continue
      const k = Math.floor(st / 5)
      const din = st % 5
      const x = k % W
      const z = (k - x) / W
      if (goal(x, z, s)) {
        hit = st
        break
      }
      for (let j = 0; j < 4; j++) {
        const dd = (j + rot) % 4
        const [dx, dz] = DIRS[dd]
        if (!ok(x + dx, z + dz)) continue
        const nc = c + 4 + (din !== 4 && din !== dd ? 3 : 0)
        const ns = idx(x + dx, z + dz) * 5 + dd
        if (cost[ns] >= 0 && cost[ns] <= nc) continue
        cost[ns] = nc
        prev[ns] = st
        push(ns, nc)
      }
    }
  }
  if (hit < 0) return null
  const cells = []
  for (let st = hit; st !== -1; st = prev[st]) {
    const k = Math.floor(st / 5)
    const x = k % W
    const z = (k - x) / W
    for (let b = 0; b < s; b++) for (let a = 0; a < s; a++) cells.push(idx(x + a, z + b))
  }
  return cells
}

function tryPlan(d, ports4) {
  const nx = 3 + (d(1) & 1)
  const nz = 3 + (d(2) & 1)
  const ws = compose(d, 3, N, nx, nx === 3 ? 7 : 6, nx === 3 ? 11 : 8)
  const ds = compose(d, 4, N, nz, nz === 3 ? 7 : 6, nz === 3 ? 11 : 8)
  const xs = []
  const zs = []
  for (let i = 0, x = 0; i < nx; x += ws[i++]) xs.push(x)
  for (let j = 0, z = 0; j < nz; z += ds[j++]) zs.push(z)
  const laneX = ws.map((w, i) => xs[i] + laneOffset(d, 10 + i, w))
  const laneZ = ds.map((h, j) => zs[j] + laneOffset(d, 20 + j, h))
  const path = serpentine(d, 5, nx, nz)
  if (!path) return null

  // Lanes: per block, the strips from its edges to its crossing.
  const route = new Uint8Array(W * W) // 1 lane, 2 spur / port
  const strips = [] // per block: lane cells of that block
  const conn = (a, b) => {
    const ax = a % nx
    const az = (a - ax) / nx
    const bx = b % nx
    const bz = (b - bx) / nx
    return bx > ax ? 'E' : bx < ax ? 'W' : bz > az ? 'S' : 'N'
  }
  for (let p = 0; p < path.length; p++) {
    const c = path[p]
    const i = c % nx
    const j = (c - i) / nx
    const dirs = []
    if (p > 0) dirs.push(conn(c, path[p - 1]))
    if (p < path.length - 1) dirs.push(conn(c, path[p + 1]))
    const cx0 = laneX[i]
    const cz0 = laneZ[j]
    const bx0 = xs[i]
    const bx1 = xs[i] + ws[i] - 1
    const bz0 = zs[j]
    const bz1 = zs[j] + ds[j] - 1
    const cells = []
    const rect = (x0, z0, x1, z1) => {
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) cells.push(idx(x, z))
    }
    rect(cx0, cz0, cx0 + 1, cz0 + 1)
    for (const dir of dirs) {
      if (dir === 'W') rect(bx0, cz0, cx0 + 1, cz0 + 1)
      if (dir === 'E') rect(cx0, cz0, bx1, cz0 + 1)
      if (dir === 'N') rect(cx0, bz0, cx0 + 1, cz0 + 1)
      if (dir === 'S') rect(cx0, cz0, cx0 + 1, bz1)
    }
    for (const k of cells) route[k] = 1
    strips.push({ block: c, i, j, dirs, cells: [...new Set(cells)] })
  }

  // Stairs: A at the route's first block, B at its last.
  const portCells = new Set()
  for (const { a0, a1 } of ports4.north) for (let a = a0; a <= a1; a++) portCells.add(idx(a, 0))
  for (const { a0, a1 } of ports4.south) for (let a = a0; a <= a1; a++) portCells.add(idx(a, N - 1))
  for (const { a0, a1 } of ports4.west) for (let a = a0; a <= a1; a++) portCells.add(idx(0, a))
  for (const { a0, a1 } of ports4.east) for (let a = a0; a <= a1; a++) portCells.add(idx(N - 1, a))
  const coreHits = (c, other) => {
    for (let z = c.core.z0 - 1; z <= c.core.z1 + 1; z++) {
      for (let x = c.core.x0 - 1; x <= c.core.x1 + 1; x++) {
        const inCore = x >= c.core.x0 && x <= c.core.x1 && z >= c.core.z0 && z <= c.core.z1
        if (inCore && (route[idx(x, z)] || portCells.has(idx(x, z)))) return true
        // Keep one free cell between the two cores and off the other's door.
        if (other && x >= other.core.x0 && x <= other.core.x1 && z >= other.core.z0 && z <= other.core.z1) return true
        if (other && inCore && x === other.door.x && z === other.door.z) return true
      }
    }
    return false
  }
  const stairs = []
  for (const [n, strip] of [[0, strips[0]], [1, strips[strips.length - 1]]]) {
    const cands = []
    for (const k of strip.cells) {
      const x = k % W
      const z = (k - x) / W
      for (const dir of ['E', 'W', 'N', 'S']) {
        for (const side of ['near', 'far']) {
          const c = coreAt(x, z, dir, side)
          if (!c || coreHits(c, stairs[0])) continue
          if (stairs[0] && stairs[0].chunk.cx === c.chunk.cx && stairs[0].chunk.cz === c.chunk.cz) continue
          cands.push(c)
        }
      }
    }
    if (!cands.length) return null
    stairs.push(cands[d(30 + n, cands.length) % cands.length])
  }
  const coreCell = new Uint8Array(W * W)
  for (const s of stairs) {
    for (let z = s.core.z0; z <= s.core.z1; z++) for (let x = s.core.x0; x <= s.core.x1; x++) coreCell[idx(x, z)] = 1
  }

  // Spurs from the route storey's N/S ports to the nearest lane.
  const nearLane = (x, z, s) => {
    for (let b = -1; b <= s; b++) {
      for (let a = -1; a <= s; a++) {
        if ((a === -1 || a === s) && (b === -1 || b === s)) continue
        const gx = x + a
        const gz = z + b
        if (gx >= 0 && gz >= 0 && gx < N && gz < N && route[idx(gx, gz)] === 1) return true
      }
    }
    return false
  }
  const spurs = []
  for (const [side, list] of [['north', ports4.north], ['south', ports4.south]]) {
    for (const { a0 } of list) {
      const from = { x: a0, z: side === 'north' ? 0 : N - 2 }
      let cells = blockPath(d, 40 + spurs.length, from, nearLane, (x, z) => !coreCell[idx(x, z)], 2, side === 'north' ? 2 : 3)
      if (!cells) return null
      for (const k of cells) if (!route[k]) route[k] = 2
      if (side === 'south') for (let a = a0; a <= a0 + 1; a++) route[idx(a, N)] = 2
      spurs.push({ side, a0, cells })
    }
  }

  // The hall storey: the lobby corridor from the west port to stair A's door
  // (never over stair B's door), and one hall region round the rest.
  const A = stairs[0]
  const B = stairs[1]
  const hallFree = (x, z) => {
    if (coreCell[idx(x, z)]) return false
    if (Math.abs(x - B.door.x) + Math.abs(z - B.door.z) <= 1) return false
    return !(x === N - 1 && z >= ports4.east[0].a0 && z <= ports4.east[0].a1)
  }
  const atDoor = (x, z, s) => A.door.x >= x && A.door.x < x + s && A.door.z >= z && A.door.z < z + s
  const wp = ports4.west[0]
  let corridor = blockPath(d, 50, { x: 0, z: wp.a0 }, atDoor, hallFree, 2, 0)
  if (!corridor) {
    const one = blockPath(d, 51, { x: 0, z: wp.a0 }, atDoor, hallFree, 1, 0)
    if (!one) return null
    corridor = [...one, idx(0, wp.a1)]
  }
  const lobby = new Uint8Array(W * W)
  for (const k of corridor) lobby[k] = 1
  // The rest of the hall: stair B's door and the east port in one region.
  const ep = ports4.east[0]
  const seen = new Uint8Array(W * W)
  const stack = [idx(B.door.x, B.door.z)]
  seen[stack[0]] = 1
  while (stack.length) {
    const k = stack.pop()
    const x = k % W
    const z = (k - x) / W
    for (const [dx, dz] of DIRS) {
      const a = x + dx
      const b = z + dz
      if (a < 0 || b < 0 || a >= N || b >= N) continue
      const nk = idx(a, b)
      if (seen[nk] || coreCell[nk] || lobby[nk]) continue
      seen[nk] = 1
      stack.push(nk)
    }
  }
  if (lobby[idx(B.door.x, B.door.z)] || !seen[idx(N - 1, ep.a0)] || !seen[idx(N - 1, ep.a1)]) return null

  return {
    nx, nz, xs, zs, ws, ds, laneX, laneZ, path, strips,
    route, coreCell, lobby, spurs, stairs,
    ports: ports4,
  }
}

const planMemo = memo(512)

// The district's own dice seed (mirror-free): the plan's and the layout's.
export const districtSeed = (worldSeed, tx, tz) => {
  const k = bandKey(tx, tz)
  return varietySeed(planSeedOf(worldSeed >>> 0, k), k)
}

// The district plan of tile (tx, tz): pure in (worldSeed, tx, tz).
export function districtPlan(worldSeed, tx, tz) {
  const seed = worldSeed >>> 0
  return planMemo(`${seed},${tx},${tz}`, () => {
    const base = districtSeed(seed, tx, tz)
    const ports4 = {
      north: northPortOf(seed, tx, tz),
      south: northPortOf(seed, tx, tz + 1),
      west: westPortOf(seed, tx, tz),
      east: westPortOf(seed, tx + 1, tz),
    }
    for (let attempt = 0; attempt < 256; attempt++) {
      const plan = tryPlan(diceOf(hashChain(base, attempt, 0x91)), ports4)
      if (plan) return Object.freeze({ ...plan, attempt })
    }
    throw new Error(`showroom: no district plan for tile ${tx},${tz} (seed ${seed})`)
  })
}

// §7.2 streaming hint: stairs A and B climb from the hall storey (cy −1) in
// their two chunks of the tile.
export function isStairChunk(worldSeed, cx, cz) {
  const tx = Math.floor(cx / TILE.w)
  const tz = Math.floor(cz / TILE.d)
  const lx = cx - tx * TILE.w
  const lz = cz - tz * TILE.d
  return districtPlan(worldSeed, tx, tz).stairs.some((s) => s.chunk.cx === lx && s.chunk.cz === lz)
}

// --- spawn, exit ---------------------------------------------------------------------

const toChunkCell = (gx, gz, cy) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { cx, cy, cz, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}

// A kind-local cell of tile (tx, tz) as a global chunk + cell.
export function globalCell(tx, tz, c) {
  const k = bandKey(tx, tz)
  return toChunkCell(k.origin.cx * CHUNK + c.gx, k.origin.cz * CHUNK + c.gz, k.origin.cy + c.cy)
}

// The spawn (§8.1, §12.3): the route entrance of tile (0,0) on cy 0, outside
// stair A's door, then the route cells nearest it (fallbacks).
export function spawnCellsOf(worldSeed) {
  const plan = districtPlan(worldSeed, 0, 0)
  const A = plan.stairs[0]
  const out = []
  const seen = new Set([idx(A.door.x, A.door.z)])
  const queue = [idx(A.door.x, A.door.z)]
  for (let i = 0; i < queue.length && out.length < 6; i++) {
    const k = queue[i]
    const x = k % W
    const z = (k - x) / W
    out.push(Object.freeze({ gx: x, gz: z }))
    for (const [dx, dz] of DIRS) {
      const a = x + dx
      const b = z + dz
      const nk = idx(a, b)
      if (a < 0 || b < 0 || a >= N || b >= N || seen.has(nk) || plan.route[nk] !== 1) continue
      seen.add(nk)
      queue.push(nk)
    }
  }
  return Object.freeze(out)
}

// The exit tile (§12.3): tx = 2 + hash % 3, tz 0 (pure in the seed; every
// level of a world shares it).
const S_EXIT = 0x0e17
export function exitTileOf(worldSeed) {
  return Object.freeze({ tx: 2 + (hashChain(((worldSeed >>> 0) ^ TILE.salt ^ S_EXIT) | 0, 0x0e) % 3), tz: 0 })
}

// --- plates ---------------------------------------------------------------------------

// The warehouse's aisle number (doc §2: "Aisle 630", the fiction's best
// wayfinding device): three digits, pure in (worldSeed, tile).
const S_AISLE = 0x0a15
export const aisleOf = (worldSeed, tx, tz) => String(100 + (hashChain(((worldSeed >>> 0) ^ S_AISLE) | 0, tx, tz) % 900))

// --- anomalies ------------------------------------------------------------------------

// Per-tile anomaly (§12.0, §12.3; doc 09 §10, doc 14: a showroom district is
// one vignette loop, at most one active anomaly per segment, never the same
// class twice in a row, never on the exit segment). Hashed from each tile's
// planSeed (hashChain, mirror-free):
//   raw    present with p = ANOMALY_RAW_OF_8 / 8, a preferred class from the
//          next bits, a priority from the rest; never within Chebyshev 1 of
//          the spawn tile, never the exit tile;
//   rotate greedy in priority order: a tile takes its preferred class unless
//          an edge neighbour of higher priority holds it, else the other
//          class, else none. No two edge-adjacent tiles share a class; pure
//          and order-independent.
// Every other tile outside the spawn's ring and the exit tile carries one
// odd copy (one mutated vignette), so each district holds one anomaly.
//   'loop'    looping arrows (doc §10.2: the route turns back on itself): the
//             district's best shortcut opens 2 wide as route, joining two
//             far-apart stretches of the serpentine. An extra edge, never the
//             only route.
//   'repeat'  a repeated vignette (doc §10.1, §4.3): the district's vignette
//             runs never close — each layout repeats down the whole route,
//             with no odd copy.
export const ANOMALY_RAW_OF_8 = 3
export const ANOMALY_CLASSES = Object.freeze(['loop', 'repeat'])
const EDGE_NEIGHBOURS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]])
const anomalyHash = (worldSeed, tx, tz) => {
  const k = bandKey(tx, tz)
  return hashChain((planSeedOf(worldSeed, k) ^ 0x0a9a1) | 0, tx, tz, 0x3a)
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

function finalClass(worldSeed, me, ex, memoMap) {
  const key = `${me.tx},${me.tz}`
  const hit = memoMap.get(key)
  if (hit !== undefined) return hit
  const taken = [false, false]
  for (const [dx, dz] of EDGE_NEIGHBOURS) {
    const n = rawAnomaly(worldSeed, me.tx + dx, me.tz + dz, ex)
    if (!n || !outranks(n, me)) continue
    const c = finalClass(worldSeed, n, ex, memoMap)
    if (c >= 0) taken[c] = true
  }
  const out = !taken[me.cls] ? me.cls : !taken[1 - me.cls] ? 1 - me.cls : -1
  memoMap.set(key, out)
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

// The district's odd copy (doc 09 §4.3: "then one copy is mutated"; doc 14:
// one mutation per district, never on the exit segment, never the same class
// twice in a row). A tile keeps exactly one when it carries no other anomaly
// and lies outside the spawn's ring and the exit tile; its class rotates like
// the anomalies: each eligible tile hashes a preferred class and a priority,
// and takes the first class, from its preferred one on, that no edge
// neighbour of higher priority holds.
export const MUTATION_CLASSES = Object.freeze(['missing', 'swapped', 'dark', 'walled'])
const mutationHash = (worldSeed, tx, tz) => hashChain((planSeedOf(worldSeed, bandKey(tx, tz)) ^ 0x0b0d) | 0, tx, tz, 0x3b)

function rawMutation(worldSeed, tx, tz, ex) {
  if (Math.max(Math.abs(tx), Math.abs(tz)) <= 1) return null
  if (ex.tx === tx && ex.tz === tz) return null
  if (anomalyAt(worldSeed, { tx, tz })) return null
  const h = mutationHash(worldSeed, tx, tz)
  return { cls: h & 3, pri: h >>> 2, tx, tz }
}

function mutationClass(worldSeed, me, ex, memoMap) {
  const key = `${me.tx},${me.tz}`
  const hit = memoMap.get(key)
  if (hit !== undefined) return hit
  const taken = [false, false, false, false]
  for (const [dx, dz] of EDGE_NEIGHBOURS) {
    const n = rawMutation(worldSeed, me.tx + dx, me.tz + dz, ex)
    if (!n || !outranks(n, me)) continue
    const c = mutationClass(worldSeed, n, ex, memoMap)
    if (c >= 0) taken[c] = true
  }
  let out = -1
  for (let i = 0; i < 4 && out < 0; i++) if (!taken[(me.cls + i) & 3]) out = (me.cls + i) & 3
  memoMap.set(key, out)
  return out
}

// The district's odd-copy class ('missing' | 'swapped' | 'dark' | 'walled'),
// or null when the district keeps none.
export function mutationClassAt(worldSeed, k) {
  const seed = worldSeed >>> 0
  const ex = exitTileOf(seed)
  const me = rawMutation(seed, k.tx, k.tz, ex)
  if (!me) return null
  const c = mutationClass(seed, me, ex, new Map())
  return c < 0 ? null : MUTATION_CLASSES[c]
}

export function mutationAllowed(worldSeed, k) {
  return mutationClassAt(worldSeed, k) !== null
}
export const oddCopyOf = (planSeed, k, n) => hashChain((planSeed ^ 0x0dd0) | 0, k.tx, k.tz, k.band) % n
