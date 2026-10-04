import { CHUNK } from '../../constants.js'
import { hashChain } from '../../tiles/tileKey.js'
import { N, anomalyAt, bandKey, diceOf, districtPlan, districtSeed, exitTileOf, globalCell, idx } from './geometry.js'

// The showroom district grammar's fine layout (doc 09 §4.4 steps 3–6), pure
// in (worldSeed, tx, tz) like the macro plan it refines (geometry.js
// districtPlan). Nothing here touches a canvas: district.js draws it.
//
// Route storey (UP):
//   - partitions: two lane cells of serpentine blocks that are not
//     consecutive along the route get a wall between them, so the route
//     stays one directed path even where its lanes run side by side;
//   - shortcuts (doc §4.1, §4.4 step 4): unmarked 1-wide gaps between route
//     stretches adjacent in space but far apart along the route — a gap in
//     such a partition, or a straight 1-wide cut (≤ 8 cells) through the
//     pocket between two lanes — scored by the route distance they save
//     (≥ a fifth of the route, ≥ 10 steps), 2–4 per district where the
//     serpentine offers them (most do; a tight 3×3 one may offer none);
//   - the 'loop' anomaly opens the district's best such link 2 wide as route;
//   - vignettes (doc §4.2, §4.3): every pocket of free cells left between the
//     lanes is cut into rectangles; each rectangle takes its longest route
//     frontage as its open front, a slab 3–5 deep behind it, cut into rooms
//     3–5 wide that never straddle a chunk seam along the front; the slab
//     behind is carved again from its own frontage, or stays mass. The rooms
//     are listed in route order (their front's route distance).
// Hall storey (DOWN):
//   - the lobby corridor (from the plan) behind walls, stair A's way up;
//   - the rest of the floor partitioned by a random BSP into 3–6
//     departments: the checkout bank where the east port leaves, the market
//     hall (gondola runs), the high-bay warehouse (rack lines on piers, a lit
//     main aisle), the stockroom (flat-pack stacks), the store café (tables);
//     each department's runs take their own axis and pitch;
//   - partition walls between departments with 2-wide gaps along a random
//     spanning tree of their adjacency (plus some extra), then a repair pass
//     that lifts furniture or opens a partition until every hall cell joins
//     stair B's door, the east port and the fire exit;
//   - the fire exit: a clear cell of the district's east chunk column, in the
//     market hall when it reaches there.

// Cell kinds of a storey grid.
export const K_MASS = 0
export const K_LANE = 1
export const K_SPUR = 2
export const K_CORE = 3
export const K_ROOM = 4 // vignette
export const K_CUT = 5 // shortcut (unlit open floor)
export const K_LOOP = 6 // the loop anomaly's passage (route)
export const K_LOBBY = 7 // hall: the corridor to stair A
export const K_HALL = 8 // hall: a department cell

const W = N + 1
const SIDES = [[1, 0, 'E'], [-1, 0, 'W'], [0, 1, 'S'], [0, -1, 'N']]
const inside = (x, z) => x >= 0 && z >= 0 && x < N && z < N

// An edge key: 'v' line gx (between x − 1 and x) on row gz; 'h' line gz.
const edgeKey = (ax, gx, gz) => `${ax}${gx},${gz}`
const edgeOf = (x, z, dx, dz) => (dx ? ['v', dx > 0 ? x + 1 : x, z] : ['h', x, dz > 0 ? z + 1 : z])

// Split n cells into vignette widths of 3..5, mostly 4 (the kind's rule).
function widths(n) {
  if (n <= 0) return []
  const k = Math.max(1, Math.round(n / 4))
  const base = Math.floor(n / k)
  return Array.from({ length: k }, (_, i) => base + (i < n - base * k ? 1 : 0))
}

// The repeat anomaly's split: as many 4-wide modules as fit, the remainder
// (1..3 cells) spread over the last ones (n 3 → [3], 6 → [3, 3], 7 →
// [4, 3], 13 → [4, 4, 5]).
// §4.4 sizes vignettes 3×3 to 4×5: a 5-deep slab takes rooms 3..4 wide, the
// cells left over (1..2 at the end) stay mass.
function narrow(ws, n) {
  if (ws.every((w) => w <= 4)) return ws
  const k = Math.max(1, Math.ceil(n / 4))
  const fit = 3 * k <= n ? k : k - 1
  if (fit < 1) return []
  const total = Math.min(n, 4 * fit)
  return Array.from({ length: fit }, (_, i) => Math.floor(total / fit) + (i < total % fit ? 1 : 0))
}

function modules(n) {
  if (n <= 0) return []
  if (n < 8) return n <= 5 ? [n] : n === 6 ? [3, 3] : [4, 3]
  const k = Math.floor(n / 4)
  const out = Array.from({ length: k }, () => 4)
  for (let i = 0; i < n - 4 * k; i++) out[k - 1 - (i % k)]++
  return out
}

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

// --- route storey --------------------------------------------------------------------

function routeOwners(plan) {
  const owner = new Int16Array(W * W).fill(-1)
  plan.strips.forEach((s, p) => {
    for (const k of s.cells) owner[k] = p
  })
  return owner
}

// Route distance from stair A's door over the lanes, through open edges.
function laneDistances(kind, walls, from) {
  const dist = new Int32Array(W * W).fill(-1)
  dist[from] = 0
  const queue = [from]
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i]
    const x = k % W
    const z = (k - x) / W
    for (const [dx, dz] of SIDES) {
      const a = x + dx
      const b = z + dz
      if (!inside(a, b)) continue
      const nk = idx(a, b)
      if (dist[nk] >= 0 || kind[nk] !== K_LANE || walls.has(edgeKey(...edgeOf(x, z, dx, dz)))) continue
      dist[nk] = dist[k] + 1
      queue.push(nk)
    }
  }
  return dist
}

const MAX_CUT = 8 // a shortcut cut runs through ≤ 8 free cells (two room slabs)

function buildRoute(worldSeed, tx, tz) {
  const plan = districtPlan(worldSeed, tx, tz)
  const d = diceOf(hashChain(districtSeed(worldSeed, tx, tz), 0x1a7))
  const anomaly = anomalyAt(worldSeed, bandKey(tx, tz))
  const uniform = anomaly === 'repeat'
  const kind = new Uint8Array(W * W)
  const owner = routeOwners(plan)
  for (let k = 0; k < W * W; k++) {
    if (plan.coreCell[k]) kind[k] = K_CORE
    else if (plan.route[k] === 1) kind[k] = K_LANE
    else if (plan.route[k] === 2) kind[k] = K_SPUR
  }
  const walls = new Set() // explicit plain walls (edge keys)
  const wallList = []
  const addWall = (ax, gx, gz) => {
    const key = edgeKey(ax, gx, gz)
    if (walls.has(key)) return
    walls.add(key)
    wallList.push({ axis: ax, gx, gz })
  }
  const dropWall = (ax, gx, gz) => {
    const key = edgeKey(ax, gx, gz)
    if (!walls.delete(key)) return
    const i = wallList.findIndex((w) => w.axis === ax && w.gx === gx && w.gz === gz)
    if (i >= 0) wallList.splice(i, 1)
  }
  // Partitions between lanes of non-consecutive blocks.
  const partitions = []
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const k = idx(x, z)
      if (kind[k] !== K_LANE) continue
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const a = x + dx
        const b = z + dz
        if (!inside(a, b)) continue
        const nk = idx(a, b)
        if (kind[nk] !== K_LANE || Math.abs(owner[k] - owner[nk]) <= 1) continue
        const [ax, gx, gz] = edgeOf(x, z, dx, dz)
        addWall(ax, gx, gz)
        partitions.push({ ax, gx, gz, a: k, b: nk })
      }
    }
  }
  // A spur joins the lanes of one block only.
  for (const s of plan.spurs) {
    let joined = -1
    for (const k of s.cells) {
      if (kind[k] !== K_SPUR) continue
      const x = k % W
      const z = (k - x) / W
      for (const [dx, dz] of SIDES) {
        const a = x + dx
        const b = z + dz
        if (!inside(a, b)) continue
        const nk = idx(a, b)
        if (kind[nk] !== K_LANE) continue
        if (joined < 0) joined = owner[nk]
        if (owner[nk] !== joined) addWall(...edgeOf(x, z, dx, dz))
      }
    }
  }

  const A = plan.stairs[0]
  const B = plan.stairs[1]
  // The route's own order: distances before any shortcut opens.
  const dist = laneDistances(kind, walls, idx(A.door.x, A.door.z))

  // --- shortcuts ---------------------------------------------------------------
  // Candidates: a partition edge (len 0), or a straight run of 1–6 free cells
  // from a lane cell to another lane cell.
  const free = (k) => kind[k] === K_MASS
  const cands = []
  for (const p of partitions) {
    if (dist[p.a] < 0 || dist[p.b] < 0) continue
    cands.push({ type: 'gap', edges: [[p.ax, p.gx, p.gz]], cells: [], ends: [p.a, p.b], len: 0, saving: Math.abs(dist[p.a] - dist[p.b]) - 1, at: p })
  }
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const k = idx(x, z)
      if (kind[k] !== K_LANE || dist[k] < 0) continue
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const cells = []
        let a = x + dx
        let b = z + dz
        while (inside(a, b) && free(idx(a, b)) && cells.length <= MAX_CUT) {
          cells.push(idx(a, b))
          a += dx
          b += dz
        }
        if (!cells.length || cells.length > MAX_CUT || !inside(a, b)) continue
        const q = idx(a, b)
        if (kind[q] !== K_LANE || dist[q] < 0) continue
        cands.push({ type: 'cut', dx, dz, cells, ends: [k, q], len: cells.length, saving: Math.abs(dist[k] - dist[q]) - cells.length - 1, at: { x, z } })
      }
    }
  }
  const order = (c) => -c.saving * 64 + (d(0x5c, c.ends[0] * 7 + c.ends[1]) % 64)
  cands.sort((p, q) => order(p) - order(q))
  const cellsOf = (c) => {
    if (c.type === 'cut') return c.cells
    return c.ends
  }
  const near = (c, used, gap = 3) => used.some((u) => cellsOf(u).some((k) => cellsOf(c).some((m) => {
    const x0 = k % W
    const x1 = m % W
    return Math.abs(x0 - x1) <= gap && Math.abs((k - x0) / W - (m - x1) / W) <= gap
  })))
  const doors = [A, B].map((s) => idx(s.door.x, s.door.z))
  const nearDoor = (c, gap = 2) => cellsOf(c).some((k) => doors.some((m) => Math.abs((k % W) - (m % W)) <= gap && Math.abs(Math.floor(k / W) - Math.floor(m / W)) <= gap))

  // The loop anomaly: the best link opened 2 wide (a second parallel gap or
  // cut beside it), as route.
  let loop = null
  if (anomaly === 'loop') {
    for (const c of cands) {
      if (c.saving < 8 || nearDoor(c)) continue
      let twin = null
      if (c.type === 'gap') {
        const p = c.at
        const step = p.ax === 'v' ? [0, 1] : [1, 0]
        twin = cands.find((o) => o.type === 'gap' && o.at.ax === p.ax && o.at.gx === p.gx + step[0] && o.at.gz === p.gz + step[1] &&
          Math.abs(dist[o.ends[0]] - dist[c.ends[0]]) <= 2)
      } else {
        const ox = c.dx ? 0 : 1
        const oz = c.dx ? 1 : 0
        twin = cands.find((o) => o.type === 'cut' && o.dx === c.dx && o.len === c.len && o.at.x === c.at.x + ox && o.at.z === c.at.z + oz)
      }
      if (!twin) continue
      loop = { parts: [c, twin], saving: c.saving }
      break
    }
    if (loop) {
      for (const c of loop.parts) {
        if (c.type === 'gap') dropWall(...c.edges[0])
        else for (const k of c.cells) kind[k] = K_LOOP
      }
      if (loop.parts[0].type === 'cut') {
        // The passage's sides are walls: it joins its two ends only.
        for (const c of loop.parts) sealCut(c, kind, addWall, K_LOOP)
      }
    }
  }
  const shortcuts = []
  const want = 2 + (d(0x5d) % 3)
  // A shortcut skips at least a fifth of the route (≥ 10 steps).
  let longest = 0
  for (let k = 0; k < W * W; k++) if (dist[k] > longest) longest = dist[k]
  const minSave = Math.max(10, Math.round(longest / 5))
  // §4.4 asks 2–4 per district: a district left with fewer takes a second
  // pass with the spacing relaxed and one-turn cuts added (still clear of
  // the doors and the loop).
  const bends = () => {
    const out = []
    for (let k = 0; k < W * W; k++) {
      if (kind[k] !== K_LANE || dist[k] < 0) continue
      const x = k % W
      const z = (k - x) / W
      for (const [dx, dz] of SIDES) {
        const first = []
        for (let a = 1; a < MAX_CUT; a++) {
          const p = x + dx * a
          const q = z + dz * a
          if (!inside(p, q) || !free(idx(p, q))) break
          first.push(idx(p, q))
          for (const [ex, ez] of dx ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]]) {
            const cells = [...first]
            let u = p + ex
            let v = q + ez
            while (inside(u, v) && free(idx(u, v)) && cells.length < MAX_CUT) {
              cells.push(idx(u, v))
              u += ex
              v += ez
            }
            if (cells.length === first.length || !inside(u, v)) continue
            const e = idx(u, v)
            if (kind[e] !== K_LANE || dist[e] < 0) continue
            out.push({ type: 'bend', cells, ends: [k, e], len: cells.length, saving: Math.abs(dist[k] - dist[e]) - cells.length - 1, at: { x, z } })
          }
        }
      }
    }
    return out.sort((p, q) => order(p) - order(q))
  }
  for (const [floor, gap, save] of [[want, 3, minSave], [2, 1, Math.max(10, Math.round(longest / 6))]]) {
    if (shortcuts.length >= floor) continue
    for (const c of gap < 3 ? [...cands, ...bends()].sort((p, q) => order(p) - order(q)) : cands) {
      if (shortcuts.length >= floor) break
      if (shortcuts.includes(c) || c.saving < save || nearDoor(c, gap - 1) || near(c, shortcuts, gap) || (loop && near(c, loop.parts, gap))) continue
      if (c.type !== 'gap' && c.cells.some((k) => kind[k] !== K_MASS)) continue
      shortcuts.push(c)
      if (c.type === 'gap') dropWall(...c.edges[0])
      else {
        for (const k of c.cells) kind[k] = K_CUT
        if (c.type === 'cut') sealCut(c, kind, addWall, K_CUT)
        else sealBend(c, kind, addWall)
      }
    }
  }
  // --- vignettes -----------------------------------------------------------------
  const frontOwner = (x, z) => {
    if (!inside(x, z) && !(z === N && x < N)) return null
    const k = idx(x, z)
    if (kind[k] === K_LANE) return owner[k]
    if (kind[k] === K_SPUR || kind[k] === K_LOOP) return -2 - kind[k]
    return null
  }
  const vignettes = []
  const roomCell = new Uint8Array(W * W)
  const carve = (r, depthSalt) => {
    const w = r.x1 - r.x0 + 1
    const h = r.z1 - r.z0 + 1
    if (w <= 0 || h <= 0) return
    let best = null
    for (const side of ['N', 'S', 'W', 'E']) {
      const ns = side === 'N' || side === 'S'
      const a0 = ns ? r.x0 : r.z0
      const a1 = ns ? r.x1 : r.z1
      let run = null
      const close = () => {
        if (run && run.len >= 3) {
          const tie = d(0x7a + depthSalt, run.a * 31 + run.len)
          if (!best || run.len > best.len || (run.len === best.len && tie % 2)) best = { side, ...run }
        }
        run = null
      }
      for (let a = a0; a <= a1; a++) {
        const x = ns ? a : side === 'W' ? r.x0 - 1 : r.x1 + 1
        const z = ns ? (side === 'N' ? r.z0 - 1 : r.z1 + 1) : a
        const o = frontOwner(x, z)
        if (o === null || (run && run.owner !== o)) close()
        if (o === null) continue
        if (!run) run = { a, b: a, len: 0, owner: o }
        run.b = a
        run.len++
      }
      close()
    }
    if (!best) return
    const ns = best.side === 'N' || best.side === 'S'
    const s0 = ns ? r.x0 : r.z0
    const s1 = ns ? r.x1 : r.z1
    if (best.a > s0 || best.b < s1) {
      const parts = [[s0, best.a - 1], [best.a, best.b], [best.b + 1, s1]]
      for (const [p0, p1] of parts) {
        if (p1 < p0) continue
        carve(ns ? { x0: p0, x1: p1, z0: r.z0, z1: r.z1 } : { x0: r.x0, x1: r.x1, z0: p0, z1: p1 }, depthSalt + 1)
      }
      return
    }
    const depth = ns ? h : w
    if (depth < 3) return
    if (depth > 5) {
      const opts = [4, 3, 5].filter((s) => depth - s >= 3)
      // The repeat anomaly's store is cut to one module (4 deep, 4 wide)
      // wherever it fits, so its runs grow long.
      const s = opts.length ? (depth - 4 >= 3 && (uniform || d(0x7c + depthSalt, r.x0 * 32 + r.z0) % 3) ? 4 : opts[d(0x7d + depthSalt, r.x0 * 32 + r.z0) % opts.length]) : 4
      let slab
      let back
      if (best.side === 'N') [slab, back] = [{ ...r, z1: r.z0 + s - 1 }, { ...r, z0: r.z0 + s }]
      if (best.side === 'S') [slab, back] = [{ ...r, z0: r.z1 - s + 1 }, { ...r, z1: r.z1 - s }]
      if (best.side === 'W') [slab, back] = [{ ...r, x1: r.x0 + s - 1 }, { ...r, x0: r.x0 + s }]
      if (best.side === 'E') [slab, back] = [{ ...r, x0: r.x1 - s + 1 }, { ...r, x1: r.x1 - s }]
      carve(slab, depthSalt + 1)
      carve(back, depthSalt + 2)
      return
    }
    // One row of rooms along the front, never across a chunk seam.
    const spans = s0 < CHUNK && s1 >= CHUNK ? [[s0, CHUNK - 1], [CHUNK, s1]] : [[s0, s1]]
    for (const [p0, p1] of spans) {
      if (p1 - p0 + 1 < 3) continue
      let ws = uniform ? modules(p1 - p0 + 1) : widths(p1 - p0 + 1)
      if (depth === 5) ws = narrow(ws, p1 - p0 + 1)
      if (ws.length > 1 && !uniform) ws.push(...ws.splice(0, d(0x7e, p0 * 32 + depthSalt) % ws.length))
      let a = p0
      for (const wd of ws) {
        const rect = ns ? { x0: a, x1: a + wd - 1, z0: r.z0, z1: r.z1 } : { x0: r.x0, x1: r.x1, z0: a, z1: a + wd - 1 }
        vignettes.push({ rect, front: best.side })
        for (let z = rect.z0; z <= rect.z1; z++) for (let x = rect.x0; x <= rect.x1; x++) roomCell[idx(x, z)] = 1
        a += wd
      }
    }
  }
  // The free cells as greedy maximal rectangles, each carved.
  const taken = new Uint8Array(W * W)
  for (let k = 0; k < W * W; k++) if (kind[k] !== K_MASS) taken[k] = 1
  for (let z = 0; z < W; z++) for (let x = 0; x < W; x++) if (x >= N || z >= N) taken[idx(x, z)] = 1
  for (let guard = 0; guard < 400; guard++) {
    const r = largestRect(taken)
    if (!r) break
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) taken[idx(x, z)] = 1
    carve(r, guard * 3)
  }
  // §4.4: 8–14 vignettes per district and the route as 0.4–0.6 of the floor.
  // Past a hashed cap of 13..14 the extra rooms stay display mass: rooms whose
  // size and front no other room shares go first, so the runs keep their
  // copies.
  const cap = 13 + (d(0x7f) % 2)
  if (vignettes.length > cap) {
    const sizeKey = (v) => `${v.rect.x1 - v.rect.x0},${v.rect.z1 - v.rect.z0}${v.front}`
    const shared = new Map()
    for (const v of vignettes) shared.set(sizeKey(v), (shared.get(sizeKey(v)) ?? 0) + 1)
    const drop = vignettes
      .map((v, i) => ({ v, lone: shared.get(sizeKey(v)) === 1 ? 0 : 1, h: d(0x80, i) }))
      .sort((p, q) => p.lone - q.lone || p.h - q.h)
      .slice(0, vignettes.length - cap)
      .map((e) => e.v)
    for (const v of drop) vignettes.splice(vignettes.indexOf(v), 1)
  }
  for (const v of vignettes) for (let z = v.rect.z0; z <= v.rect.z1; z++) for (let x = v.rect.x0; x <= v.rect.x1; x++) kind[idx(x, z)] = K_ROOM

  // Route order: each room's front distance.
  for (const v of vignettes) {
    let best = Infinity
    for (const e of frontCells(v.rect, v.front)) {
      if (!inside(e.x, e.z)) continue
      const dk = dist[idx(e.x, e.z)]
      if (dk >= 0) best = Math.min(best, dk)
    }
    v.dist = best === Infinity ? 1e6 + v.rect.z0 * W + v.rect.x0 : best
  }
  vignettes.sort((p, q) => p.dist - q.dist || p.rect.z0 - q.rect.z0 || p.rect.x0 - q.rect.x0)

  let routeLen = 0
  for (let k = 0; k < W * W; k++) if (dist[k] > routeLen) routeLen = dist[k]
  return Object.freeze({
    plan, kind, owner, walls: Object.freeze(wallList), dist, vignettes: Object.freeze(vignettes), shortcuts: Object.freeze(shortcuts), loop, routeLen,
  })
}

// Wall a cut's sides (every edge but its two ends).
// Wall a one-turn cut: every side but the path itself and its two ends.
function sealBend(c, kind, addWall) {
  const last = c.cells.length - 1
  c.cells.forEach((k, i) => {
    const x = k % W
    const z = (k - x) / W
    for (const [dx, dz] of SIDES) {
      const a = x + dx
      const b = z + dz
      if (!inside(a, b)) continue
      const nk = idx(a, b)
      if (nk === c.cells[i - 1] || nk === c.cells[i + 1]) continue
      if ((i === 0 && nk === c.ends[0]) || (i === last && nk === c.ends[1])) continue
      if (kind[nk] !== K_MASS) addWall(...edgeOf(x, z, dx, dz))
    }
  })
}

function sealCut(c, kind, addWall, own) {
  for (const k of c.cells) {
    const x = k % W
    const z = (k - x) / W
    for (const [dx, dz] of SIDES) {
      if ((dx === c.dx && dz === c.dz) || (dx === -c.dx && dz === -c.dz)) continue
      const a = x + dx
      const b = z + dz
      if (!inside(a, b)) continue
      const nk = idx(a, b)
      if (kind[nk] === own) continue
      if (kind[nk] !== K_MASS) addWall(...edgeOf(x, z, dx, dz))
    }
  }
}

// The cells just outside a rect's front.
export function frontCells(rect, front) {
  const out = []
  if (front === 'N' || front === 'S') {
    const z = front === 'N' ? rect.z0 - 1 : rect.z1 + 1
    for (let x = rect.x0; x <= rect.x1; x++) out.push({ x, z })
  } else {
    const x = front === 'W' ? rect.x0 - 1 : rect.x1 + 1
    for (let z = rect.z0; z <= rect.z1; z++) out.push({ x, z })
  }
  return out
}

// The largest rectangle of untaken cells (histogram method), or null.
function largestRect(taken) {
  const hgt = new Int32Array(W)
  let best = null
  let bestA = 0
  for (let z = 0; z < W; z++) {
    for (let x = 0; x < W; x++) hgt[x] = taken[idx(x, z)] ? 0 : hgt[x] + 1
    const stack = []
    for (let x = 0; x <= W; x++) {
      const hh = x < W ? hgt[x] : 0
      let start = x
      while (stack.length && stack[stack.length - 1][1] >= hh) {
        const [s, sh] = stack.pop()
        const area = sh * (x - s)
        if (sh > 0 && area > bestA) {
          bestA = area
          best = { x0: s, x1: x - 1, z0: z - sh + 1, z1: z }
        }
        start = s
      }
      stack.push([start, hh])
    }
  }
  return best
}

const routeMemo = memo(256)
export function routeLayout(worldSeed, tx, tz) {
  return routeMemo(`${worldSeed >>> 0},${tx},${tz}`, () => buildRoute(worldSeed >>> 0, tx, tz))
}

// --- hall storey ----------------------------------------------------------------------

export const DEPT = Object.freeze({ HALL: 'hall', WARE: 'ware', CHECKOUT: 'checkout', STOCK: 'stock', CAFE: 'cafe', BACK: 'back' })

function bsp(d, target) {
  const leaves = [{ x0: 0, z0: 0, x1: N - 1, z1: N - 1 }]
  for (let i = 0; leaves.length < target && i < 32; i++) {
    let pick = -1
    let area = 0
    leaves.forEach((l, j) => {
      const a = (l.x1 - l.x0 + 1) * (l.z1 - l.z0 + 1)
      const can = l.x1 - l.x0 + 1 >= 12 || l.z1 - l.z0 + 1 >= 12
      if (can && a + (d(0x40, i * 8 + j) % 40) > area) [pick, area] = [j, a + (d(0x40, i * 8 + j) % 40)]
    })
    if (pick < 0) break
    const l = leaves[pick]
    const w = l.x1 - l.x0 + 1
    const h = l.z1 - l.z0 + 1
    const vertical = w >= 12 && (h < 12 || w > h + 3 || (Math.abs(w - h) <= 3 && d(0x41, i) % 2))
    if (vertical) {
      const cut = l.x0 + 6 + (d(0x42, i) % (w - 11))
      leaves.splice(pick, 1, { ...l, x1: cut - 1 }, { ...l, x0: cut })
    } else {
      const cut = l.z0 + 6 + (d(0x42, i) % (h - 11))
      leaves.splice(pick, 1, { ...l, z1: cut - 1 }, { ...l, z0: cut })
    }
  }
  return leaves
}

function buildHall(worldSeed, tx, tz) {
  const plan = districtPlan(worldSeed, tx, tz)
  const d = diceOf(hashChain(districtSeed(worldSeed, tx, tz), 0x4a11))
  const kind = new Uint8Array(W * W)
  for (let k = 0; k < W * W; k++) {
    const x = k % W
    const z = (k - x) / W
    if (plan.coreCell[k]) kind[k] = K_CORE
    else if (plan.lobby[k]) kind[k] = K_LOBBY
    else if (inside(x, z)) kind[k] = K_HALL
  }
  const ep = plan.ports.east[0]
  for (let z = ep.a0; z <= ep.a1; z++) kind[idx(N, z)] = K_HALL
  const B = plan.stairs[1]
  const bDoor = idx(B.door.x, B.door.z)

  // The store's outer wall: along each side of the district, 2–3 stretches
  // set back 0–2 cells into service voids (mass), so the hall's outline is
  // its own; never over the east port's approach or round stair B's door,
  // and undone when it would cut stair B's door from the east port.
  const inset = []
  for (const [si, side] of ['N', 'S', 'W', 'E'].entries()) {
    const cuts = [d(0x30, si * 4) % (N - 6) + 3, d(0x30, si * 4 + 1) % (N - 6) + 3].sort((a, b) => a - b)
    const segs = [[0, cuts[0] - 1], [cuts[0], cuts[1] - 1], [cuts[1], N - 1]]
    segs.forEach(([a0, a1], j) => {
      const depth = [0, 0, 1, 2, 3][d(0x31, si * 4 + j) % 5]
      for (let a = a0; a <= a1; a++) {
        for (let t = 0; t < depth; t++) {
          const x = side === 'W' ? t : side === 'E' ? N - 1 - t : a
          const z = side === 'N' ? t : side === 'S' ? N - 1 - t : a
          const k = idx(x, z)
          if (kind[k] !== K_HALL) continue
          if (x >= N - 3 && z >= ep.a0 - 1 && z <= ep.a1 + 1) continue
          if (Math.abs(x - B.door.x) <= 2 && Math.abs(z - B.door.z) <= 2) continue
          inset.push(k)
        }
      }
    })
  }
  for (const k of inset) kind[k] = K_MASS
  if (!joined(kind, bDoor, idx(N - 1, ep.a0))) for (const k of inset) kind[k] = K_HALL

  // Floor the lobby corridor cuts off from stair B's door joins the lobby:
  // the trolley bay by the west door (doc §2: "Trolleys"). Floor joined to
  // neither goes to mass.
  const eSeen = flood(kind, [bDoor], (q) => kind[q] === K_HALL)
  const bay = new Uint8Array(W * W)
  const lobbyCells = []
  for (let k = 0; k < W * W; k++) if (kind[k] === K_LOBBY) lobbyCells.push(k)
  const wSeen = flood(kind, lobbyCells, (q) => kind[q] === K_LOBBY || (kind[q] === K_HALL && !eSeen[q]))
  for (let k = 0; k < W * W; k++) {
    if (kind[k] !== K_HALL || eSeen[k]) continue
    if (wSeen[k]) {
      kind[k] = K_LOBBY
      bay[k] = 1
    } else kind[k] = K_MASS
  }

  // Departments.
  const leaves = bsp(d, 3 + (d(0x43) % 4))
  const leafOf = new Int8Array(W * W).fill(-1)
  leaves.forEach((l, i) => {
    for (let z = l.z0; z <= l.z1; z++) for (let x = l.x0; x <= l.x1; x++) if (kind[idx(x, z)] === K_HALL) leafOf[idx(x, z)] = i
  })
  for (let z = ep.a0; z <= ep.a1; z++) leafOf[idx(N, z)] = leafOf[idx(N - 1, z)]
  const types = new Array(leaves.length).fill(null)
  const checkout = leafOf[idx(N - 1, ep.a0)]
  types[checkout] = DEPT.CHECKOUT
  const bLeaf = leafOf[bDoor]
  if (types[bLeaf] === null) types[bLeaf] = DEPT.HALL
  const pool = [DEPT.WARE, DEPT.HALL, DEPT.WARE, DEPT.STOCK, DEPT.CAFE, DEPT.HALL]
  let p = d(0x44) % 2
  const rest = leaves.map((_, i) => i).filter((i) => types[i] === null)
  // The biggest remaining leaf is the warehouse when there is none yet.
  rest.sort((a, b) => area(leaves[b]) - area(leaves[a]) || a - b)
  for (const i of rest) {
    if (!types.includes(DEPT.WARE)) types[i] = DEPT.WARE
    else if (!types.includes(DEPT.HALL)) types[i] = DEPT.HALL
    else types[i] = pool[(p++ + d(0x45, i)) % pool.length]
  }
  // Back-of-house (doc §4.1, §5): in some districts the smallest free
  // department is a staff strip — a corridor with small rooms either side.
  if (rest.length >= 2 && d(0x56) % 5 < 3) types[rest[rest.length - 1]] = DEPT.BACK
  const rooms = []
  const roomOf = new Int16Array(W * W).fill(-1)
  types.forEach((t, i) => {
    if (t !== DEPT.BACK) return
    const l = leaves[i]
    const alongX = l.x1 - l.x0 >= l.z1 - l.z0
    const A0 = alongX ? l.x0 : l.z0
    const A1 = alongX ? l.x1 : l.z1
    const C0 = alongX ? l.z0 : l.x0
    const C1 = alongX ? l.z1 : l.x1
    const span = C1 - C0 + 1
    const c = span >= 7 ? C0 + 3 + (d(0x57, i) % Math.max(1, span - 6)) : C0 + Math.min(3, span - 1)
    const at = (a, cc) => (alongX ? [a, cc] : [cc, a])
    for (const side of [-1, 1]) {
      const room = side < 0 ? c - C0 : C1 - c
      if (room < 3) continue
      const depth = Math.min(5, room)
      const ws = widths(A1 - A0 + 1)
      if (ws.length > 1) ws.push(...ws.splice(0, d(0x58, i * 2 + side) % ws.length))
      let a = A0
      for (const wd of ws) {
        const c0 = side < 0 ? c - depth : c + 1
        const c1 = side < 0 ? c - 1 : c + depth
        const [x0, z0] = at(a, c0)
        const [x1, z1] = at(a + wd - 1, c1)
        const rect = { x0: Math.min(x0, x1), z0: Math.min(z0, z1), x1: Math.max(x0, x1), z1: Math.max(z0, z1) }
        a += wd
        let ok = true
        for (let z = rect.z0; z <= rect.z1 && ok; z++) for (let x = rect.x0; x <= rect.x1 && ok; x++) {
          const k = idx(x, z)
          if (kind[k] !== K_HALL || leafOf[k] !== i || roomOf[k] >= 0) ok = false
        }
        // Its door: the middle of the side on the corridor.
        const mid = Math.floor((a - wd + a - 1) / 2)
        const [dx, dz] = at(mid, side < 0 ? c : c)
        const door = alongX ? { axis: 'h', gx: dx, gz: side < 0 ? c : c + 1 } : { axis: 'v', gx: side < 0 ? c : c + 1, gz: dz }
        if (!ok || kind[idx(dx, dz)] !== K_HALL || leafOf[idx(dx, dz)] !== i) continue
        const n = rooms.length
        rooms.push({ rect, door, role: ['storage', 'break', 'office'][d(0x59, n + i * 8) % 3], leaf: i, outside: idx(dx, dz) })
        for (let z = rect.z0; z <= rect.z1; z++) for (let x = rect.x0; x <= rect.x1; x++) roomOf[idx(x, z)] = n
      }
    }
  })

  // Walls: the lobby corridor, the department partitions with gaps.
  const walls = new Set()
  const addWall = (ax, gx, gz) => walls.add(edgeKey(ax, gx, gz))
  const pairs = new Map() // 'i,j' -> [edges]
  for (let z = 0; z < W; z++) {
    for (let x = 0; x < W; x++) {
      const k = idx(x, z)
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const a = x + dx
        const b = z + dz
        if (a >= W || b >= W) continue
        const nk = idx(a, b)
        const lobby = (kind[k] === K_LOBBY) !== (kind[nk] === K_LOBBY)
        const walk = (q) => kind[q] === K_LOBBY || kind[q] === K_HALL
        if (!walk(k) || !walk(nk)) continue
        if (lobby) {
          addWall(...edgeOf(x, z, dx, dz))
          continue
        }
        if (kind[k] !== K_HALL || leafOf[k] === leafOf[nk]) continue
        addWall(...edgeOf(x, z, dx, dz))
        const key = leafOf[k] < leafOf[nk] ? `${leafOf[k]},${leafOf[nk]}` : `${leafOf[nk]},${leafOf[k]}`
        if (!pairs.has(key)) pairs.set(key, [])
        pairs.get(key).push({ e: edgeOf(x, z, dx, dz), a: k, b: nk })
      }
    }
  }
  // The back rooms' walls, their doors open.
  for (const rm of rooms) {
    const { x0, z0, x1, z1 } = rm.rect
    for (let z = z0; z <= z1; z++) {
      addWall('v', x0, z)
      addWall('v', x1 + 1, z)
    }
    for (let x = x0; x <= x1; x++) {
      addWall('h', x, z0)
      addWall('h', x, z1 + 1)
    }
    walls.delete(edgeKey(rm.door.axis, rm.door.gx, rm.door.gz))
  }
  // Gaps along a random spanning tree of the department adjacency, plus some.
  const parent = leaves.map((_, i) => i)
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const gapCells = new Set()
  const keys = [...pairs.keys()].sort((a, b) => (d(0x46, hashKey(a)) % 97) - (d(0x46, hashKey(b)) % 97) || (a < b ? -1 : 1))
  for (const key of keys) {
    const [i, j] = key.split(',').map(Number)
    const tree = find(i) !== find(j)
    if (!tree && d(0x47, hashKey(key)) % 3) continue
    parent[find(i)] = find(j)
    const edges = pairs.get(key).filter((g) => roomOf[g.a] < 0 && roomOf[g.b] < 0)
    if (!edges.length) continue
    // A 2-wide gap at a random place along the shared line.
    const at = d(0x48, hashKey(key)) % edges.length
    for (const g of [edges[at], edges[at + 1]]) {
      if (!g) continue
      if (g !== edges[at] && !adjacentEdges(g.e, edges[at].e)) continue
      walls.delete(edgeKey(...g.e))
      gapCells.add(g.a)
      gapCells.add(g.b)
    }
  }

  // Cells that must stay clear of furniture.
  const clear = new Uint8Array(W * W)
  const clearAround = (k, r) => {
    const x = k % W
    const z = (k - x) / W
    for (let b = -r; b <= r; b++) for (let a = -r; a <= r; a++) if (a + x >= 0 && b + z >= 0 && a + x < W && b + z < W) clear[idx(a + x, b + z)] = 1
  }
  clearAround(bDoor, 1)
  for (const k of gapCells) clearAround(k, 1)
  for (let k = 0; k < W * W; k++) if (roomOf[k] >= 0) clear[k] = 1
  for (const rm of rooms) clearAround(rm.outside, 1)
  for (let z = ep.a0; z <= ep.a1; z++) {
    clearAround(idx(N - 1, z), 1)
    clear[idx(N - 2, z)] = 1
  }
  // Cells next to the lobby or a core stay free too (no piece backs onto
  // a wall the other side of which is the corridor).
  for (let k = 0; k < W * W; k++) {
    if (kind[k] !== K_HALL) continue
    const x = k % W
    const z = (k - x) / W
    for (const [dx, dz] of SIDES) {
      const a = x + dx
      const b = z + dz
      if (a < 0 || b < 0 || a >= W || b >= W) continue
      const q = kind[idx(a, b)]
      if (q === K_LOBBY || q === K_CORE) clear[k] = 1
    }
  }

  // The fire exit: a hall cell of the east chunk column with a free 3×3,
  // the market hall first.
  const exitCands = []
  for (let z = 1; z < N - 1; z++) {
    for (let x = CHUNK + 1; x < N - 1; x++) {
      const k = idx(x, z)
      if (kind[k] !== K_HALL) continue
      let ok = true
      for (let b = -1; b <= 1 && ok; b++) for (let a = -1; a <= 1 && ok; a++) {
        const q = idx(x + a, z + b)
        if (kind[q] !== K_HALL || leafOf[q] !== leafOf[k] || gapCells.has(q) || roomOf[q] >= 0) ok = false
      }
      if (ok && Math.abs(x - B.door.x) + Math.abs(z - B.door.z) > 3) exitCands.push(k)
    }
  }
  const pref = exitCands.filter((k) => types[leafOf[k]] === DEPT.HALL)
  const exitPool = pref.length ? pref : exitCands
  const exit = exitPool.length ? exitPool[d(0x49) % exitPool.length] : null
  if (exit !== null) clearAround(exit, 1)

  // Furniture by department (one entry per cell: kind, records, facing).
  const furn = new Map() // cell -> { type, axis }
  const piers = new Set()
  const lamps = [] // { k, lit, grid?, room? }: grid fixtures are the district's cover pass's to place
  const depts = []
  leaves.forEach((l, i) => {
    const t = types[i]
    const axis = d(0x50, i) % 2 ? 'x' : 'z' // runs along x or z
    const info = { leaf: l, type: t, axis, index: i }
    depts.push(info)
    const inLeaf = (x, z) => x >= l.x0 && x <= l.x1 && z >= l.z0 && z <= l.z1 && kind[idx(x, z)] === K_HALL && leafOf[idx(x, z)] === i
    const interior = (x, z) => x > l.x0 && x < l.x1 && z > l.z0 && z < l.z1 && inLeaf(x, z) && !clear[idx(x, z)]
    // along: coordinate along the runs; across: the run's line.
    const A0 = axis === 'x' ? l.x0 : l.z0
    const A1 = axis === 'x' ? l.x1 : l.z1
    const C0 = axis === 'x' ? l.z0 : l.x0
    const C1 = axis === 'x' ? l.z1 : l.x1
    const at = (a, c) => (axis === 'x' ? [a, c] : [c, a])
    if (t === DEPT.HALL || t === DEPT.WARE || t === DEPT.STOCK) {
      const pitch = t === DEPT.STOCK ? 3 : t === DEPT.HALL ? 2 + (d(0x5a, i) % 2) : 2
      const phase = d(0x51, i) % pitch
      const crossEvery = 5 + (d(0x52, i) % 4)
      const cross = (a) => (a - A0) % crossEvery === crossEvery - 1
      // The warehouse's lit main aisle across its rack lines.
      const main = t === DEPT.WARE ? A0 + 2 + (d(0x53, i) % Math.max(1, A1 - A0 - 3)) : -1
      info.main = main
      for (let c = C0 + 1; c < C1; c++) {
        if ((c - C0 - 1 - phase + pitch) % pitch !== 0) continue
        let n = 0
        for (let a = A0 + 1; a < A1; a++) {
          const [x, z] = at(a, c)
          if (!interior(x, z) || cross(a) || a === main || a === main + 1) {
            n = 0
            continue
          }
          const k = idx(x, z)
          if (t === DEPT.WARE && n % 3 === 0) piers.add(k)
          else furn.set(k, { type: t === DEPT.HALL ? 'gondola' : t === DEPT.WARE ? 'rack' : 'stack', axis })
          n++
        }
      }
      // Lamps: a grid over the department; the warehouse's main aisle lit,
      // its rack aisles a scatter of dead high-bays.
      for (let c = C0 + 1; c <= C1; c += 5) {
        for (let a = A0 + 1; a <= A1; a += 5) {
          const [x, z] = at(a, c)
          if (!inLeaf(x, z)) continue
          lamps.push({ k: idx(x, z), lit: t !== DEPT.WARE || d(0x54, a * 32 + c) % 3 !== 0, grid: t !== DEPT.WARE })
        }
      }
      if (main >= 0) for (let c = C0 + 2; c <= C1; c += 5) {
        const [x, z] = at(main, c)
        if (inLeaf(x, z)) lamps.push({ k: idx(x, z), lit: true, grid: true })
      }
    } else if (t === DEPT.CHECKOUT) {
      // The bank: till rows of 3 cells across the flow to the port (the
      // flow runs along x), lane aisles between, a queue strip before and a
      // till strip after (x ≥ the bank + 3) out to the port.
      const bx = Math.max(l.x0 + 2, l.x1 - 4)
      info.bank = bx
      const lanes = []
      for (let z = l.z0 + 1; z < l.z1; z++) {
        const counter = (z - l.z0) % 2 === 0
        if (!counter) {
          if (inLeaf(bx + 1, z)) lanes.push(z)
          continue
        }
        for (let x = bx; x <= bx + 2; x++) if (interior(x, z)) furn.set(idx(x, z), { type: 'till', axis: 'x' })
      }
      // Impulse shelving: west of the 2-wide queue strip, gondola runs.
      const qx = bx - 3
      if (qx - l.x0 >= 3) {
        const runsAlongZ = d(0x5b, i) % 2 === 0
        const crossEvery = 5 + (d(0x5c, i) % 3)
        for (let z = l.z0 + 1; z < l.z1; z++) {
          for (let x = l.x0 + 1; x <= qx; x++) {
            const line = runsAlongZ ? (x - l.x0 - 1) % 2 === 0 && (z - l.z0) % crossEvery !== 0 : (z - l.z0 - 1) % 2 === 0 && (x - l.x0) % crossEvery !== 0
            if (line && interior(x, z) && x < qx) furn.set(idx(x, z), { type: 'gondola', axis: runsAlongZ ? 'z' : 'x' })
          }
        }
      }
      const lit = lanes.length ? d(0x55, i) % lanes.length : -1
      lanes.forEach((z, j) => lamps.push({ k: idx(bx + 1, z), lit: j === lit }))
      info.lanes = lanes.length
      info.litLane = lit
      for (let z = l.z0 + 2; z <= l.z1; z += 5) {
        for (const x of [bx - 1, Math.min(l.x1, bx + 3)]) if (inLeaf(x, z)) lamps.push({ k: idx(x, z), lit: true, grid: true })
      }
      for (let z = l.z0 + 2; z < l.z1; z += 5) for (let x = l.x0 + 2; x < bx - 3; x += 5) if (inLeaf(x, z)) lamps.push({ k: idx(x, z), lit: true, grid: true })
    } else if (t === DEPT.BACK) {
      // The staff strip: a fixture per back room, the open floor's grid.
      for (const rm of rooms) {
        if (rm.leaf !== i) continue
        lamps.push({ k: idx((rm.rect.x0 + rm.rect.x1) >> 1, (rm.rect.z0 + rm.rect.z1) >> 1), lit: true, room: true })
      }
      for (let c = C0 + 1; c <= C1; c += 5) for (let a = A0 + 1; a <= A1; a += 5) {
        const [x, z] = at(a, c)
        if (inLeaf(x, z) && roomOf[idx(x, z)] < 0) lamps.push({ k: idx(x, z), lit: true, grid: true })
      }
    } else {
      // The café: tables on a 3-cell pitch, a chair beside each.
      for (let c = C0 + 1; c < C1; c += 3) {
        for (let a = A0 + 1; a < A1; a += 3) {
          const [x, z] = at(a, c)
          if (!interior(x, z)) continue
          furn.set(idx(x, z), { type: 'table', axis })
        }
      }
      for (let c = C0 + 1; c <= C1; c += 5) for (let a = A0 + 1; a <= A1; a += 5) {
        const [x, z] = at(a, c)
        if (inLeaf(x, z)) lamps.push({ k: idx(x, z), lit: true, grid: true })
      }
    }
  })

  // The lobby and its trolley bay: a fixture grid, and parked carts in the
  // bay's open floor (each alone in a free 3×3, so none cuts the floor).
  const carts = []
  const ox = d(0x5d) % 5
  const oz = d(0x5e) % 5
  for (let k = 0; k < W * W; k++) {
    if (kind[k] !== K_LOBBY) continue
    const x = k % W
    const z = (k - x) / W
    if ((x + ox) % 5 === 2 && (z + oz) % 5 === 2) lamps.push({ k, lit: true, grid: true })
    if (!bay[k] || (x + z + ox) % 3 !== 0) continue
    let ok = true
    for (let b = -1; b <= 1 && ok; b++) for (let a = -1; a <= 1 && ok; a++) {
      const q = idx(x + a, z + b)
      if (x + a < 0 || z + b < 0 || x + a >= N || z + b >= N || !bay[q] || carts.some((c) => c === q)) ok = false
    }
    if (ok && !carts.some((c) => Math.abs((c % W) - x) <= 2 && Math.abs(Math.floor(c / W) - z) <= 2)) carts.push(k)
  }

  // Repair: every hall cell joins stair B's door; lift furniture, then open
  // partitions, then give up cells to mass.
  const blocked = (k) => furn.has(k) || piers.has(k)
  const walk = (k) => kind[k] === K_HALL
  const reach = () => {
    const seen = new Uint8Array(W * W)
    const stack = [bDoor]
    seen[bDoor] = 1
    while (stack.length) {
      const k = stack.pop()
      const x = k % W
      const z = (k - x) / W
      for (const [dx, dz] of SIDES) {
        const a = x + dx
        const b = z + dz
        if (a < 0 || b < 0 || a >= W || b >= W) continue
        const nk = idx(a, b)
        if (seen[nk] || !walk(nk) || blocked(nk) || walls.has(edgeKey(...edgeOf(x, z, dx, dz)))) continue
        seen[nk] = 1
        stack.push(nk)
      }
    }
    return seen
  }
  for (let guard = 0; guard < 400; guard++) {
    const seen = reach()
    const lost = []
    for (let k = 0; k < W * W; k++) if (walk(k) && !blocked(k) && !seen[k]) lost.push(k)
    if (!lost.length) break
    // A piece between the reached floor and a lost cell.
    let fixed = false
    for (let k = 0; k < W * W && !fixed; k++) {
      if (!blocked(k)) continue
      const x = k % W
      const z = (k - x) / W
      let toSeen = false
      let toLost = false
      for (const [dx, dz] of SIDES) {
        const a = x + dx
        const b = z + dz
        if (a < 0 || b < 0 || a >= W || b >= W) continue
        const nk = idx(a, b)
        if (walls.has(edgeKey(...edgeOf(x, z, dx, dz))) || !walk(nk)) continue
        if (seen[nk]) toSeen = true
        else if (!blocked(nk)) toLost = true
      }
      if (toSeen && toLost) {
        furn.delete(k)
        piers.delete(k)
        fixed = true
      }
    }
    if (fixed) continue
    // A partition between the reached floor and a lost cell.
    for (const k of lost) {
      const x = k % W
      const z = (k - x) / W
      for (const [dx, dz] of SIDES) {
        const a = x + dx
        const b = z + dz
        if (a < 0 || b < 0 || a >= W || b >= W) continue
        const nk = idx(a, b)
        if (!seen[nk] || !walk(nk) || roomOf[nk] >= 0 || roomOf[k] >= 0) continue
        const key = edgeKey(...edgeOf(x, z, dx, dz))
        if (walls.has(key)) {
          walls.delete(key)
          fixed = true
          break
        }
      }
      if (fixed) break
    }
    if (fixed) continue
    // A blocked piece next to a lost cell whose other side is blocked too:
    // lift any piece touching the lost cells.
    for (const k of lost) {
      const x = k % W
      const z = (k - x) / W
      for (const [dx, dz] of SIDES) {
        const nk = idx(x + dx, z + dz)
        if (x + dx < 0 || z + dz < 0 || x + dx >= W || z + dz >= W) continue
        if (blocked(nk)) {
          furn.delete(nk)
          piers.delete(nk)
          fixed = true
        }
      }
      if (fixed) break
    }
    if (fixed) continue
    // A back room standing across the way goes back to the floor (its walls
    // and fixture with it).
    const lostSet = new Set(lost)
    const across = rooms.findIndex((rm, n) => !rm.gone && lost.length && (() => {
      for (let z = rm.rect.z0; z <= rm.rect.z1; z++) {
        for (let x = rm.rect.x0; x <= rm.rect.x1; x++) {
          if (SIDES.some(([dx, dz]) => lostSet.has(idx(x + dx, z + dz)) && roomOf[idx(x + dx, z + dz)] !== n)) return true
        }
      }
      return false
    })())
    if (across >= 0) {
      const rm = rooms[across]
      rm.gone = true
      const { x0, z0, x1, z1 } = rm.rect
      for (let z = z0; z <= z1; z++) {
        walls.delete(edgeKey('v', x0, z))
        walls.delete(edgeKey('v', x1 + 1, z))
        for (let x = x0; x <= x1; x++) roomOf[idx(x, z)] = -1
      }
      for (let x = x0; x <= x1; x++) {
        walls.delete(edgeKey('h', x, z0))
        walls.delete(edgeKey('h', x, z1 + 1))
      }
      continue
    }
    for (const k of lost) kind[k] = K_MASS
  }
  // Lone pieces walled off (a blocked cell whose floor never joins) go too.
  const seen = reach()
  for (let k = 0; k < W * W; k++) {
    if (kind[k] !== K_HALL || seen[k]) continue
    if (blocked(k)) {
      const x = k % W
      const z = (k - x) / W
      const touches = SIDES.some(([dx, dz]) => {
        const a = x + dx
        const b = z + dz
        return a >= 0 && b >= 0 && a < W && b < W && seen[idx(a, b)] && !walls.has(edgeKey(...edgeOf(x, z, dx, dz)))
      })
      if (!touches) {
        furn.delete(k)
        piers.delete(k)
        kind[k] = K_MASS
      }
    } else kind[k] = K_MASS
  }
  // The fire exit survives the repair, or moves to the nearest clear cell of
  // the east chunk column the repair left on stair B's floor.
  let fireExit = exit
  const finalSeen = reach()
  if (fireExit === null || kind[fireExit] !== K_HALL || blocked(fireExit) || !finalSeen[fireExit]) {
    fireExit = null
    for (let k = 0; k < W * W && fireExit === null; k++) {
      const x = k % W
      if (x > CHUNK && x < N && finalSeen[k] && !blocked(k) && kind[k] === K_HALL) fireExit = k
    }
  }
  // A bag bin against the east wall of the till strip, clear of the port:
  // only on a cell whose loss cuts no floor from stair B's door (it is set
  // after the repair, so it must keep the repair's result).
  let bin = null
  const co = depts.find((dd) => dd.type === DEPT.CHECKOUT)
  if (co && co.bank !== undefined && co.leaf.x1 - (co.bank + 2) >= 2) {
    for (const z of [ep.a0 - 3, ep.a1 + 3]) {
      const k = idx(N - 1, z)
      if (z <= co.leaf.z0 || z >= co.leaf.z1 || kind[k] !== K_HALL || blocked(k) || clear[k] || k === fireExit || !finalSeen[k]) continue
      furn.set(k, { type: 'bin' })
      const after = reach()
      furn.delete(k)
      let cuts = false
      for (let q = 0; q < W * W && !cuts; q++) if (q !== k && finalSeen[q] && !after[q]) cuts = true
      if (cuts) continue
      bin = k
      break
    }
  }
  // Walls left on a cell given up to mass are compile's to write.
  const wallList = []
  for (const key of walls) {
    const ax = key[0]
    const [gx, gz] = key.slice(1).split(',').map(Number)
    const [a, b] = ax === 'v' ? [idx(gx - 1, gz), idx(gx, gz)] : [idx(gx, gz - 1), idx(gx, gz)]
    if (gx - (ax === 'v' ? 1 : 0) < 0 || gz - (ax === 'h' ? 1 : 0) < 0) continue
    if (kind[a] === K_MASS || kind[b] === K_MASS) continue
    wallList.push({ axis: ax, gx, gz })
  }
  const kept = rooms.filter((rm) => !rm.gone && kind[idx(rm.rect.x0, rm.rect.z0)] === K_HALL)
  const lampsOk = lamps.filter((l) => (kind[l.k] === K_HALL || kind[l.k] === K_LOBBY) && !(l.room && roomOf[l.k] < 0))
  return Object.freeze({
    plan, kind, leaves, types, leafOf, depts, walls: Object.freeze(wallList),
    furn, piers, lamps: lampsOk, exit: fireExit, bin, clear, carts: Object.freeze(carts), rooms: Object.freeze(kept),
  })
}

const area = (l) => (l.x1 - l.x0 + 1) * (l.z1 - l.z0 + 1)
const hashKey = (s) => {
  let h = 7
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return h
}
const adjacentEdges = (e, f) => e[0] === f[0] && Math.abs(e[1] - f[1]) + Math.abs(e[2] - f[2]) === 1

const hallMemo = memo(256)
export function hallLayout(worldSeed, tx, tz) {
  return hallMemo(`${worldSeed >>> 0},${tx},${tz}`, () => buildHall(worldSeed >>> 0, tx, tz))
}

// The hall's fire exit of tile (tx, tz) (kind-local, hall storey).
export function hallExitOf(worldSeed, tx, tz) {
  const h = hallLayout(worldSeed, tx, tz)
  if (h.exit === null) return null
  const x = h.exit % W
  return { gx: x, gz: (h.exit - x) / W, cy: 0 }
}

// §8.2 exit anchor: the hall exit of the exit tile, on cy −1.
export function exitAnchor(worldSeed) {
  const t = exitTileOf(worldSeed >>> 0)
  const c = hallExitOf(worldSeed >>> 0, t.tx, t.tz)
  return globalCell(t.tx, t.tz, c ?? { gx: N - 2, gz: 1, cy: 0 })
}

// Do cells a and b of the hall floor (K_HALL) join, ignoring walls and
// furniture?
function joined(kind, a, b) {
  const seen = new Uint8Array(W * W)
  const stack = [a]
  seen[a] = 1
  while (stack.length) {
    const k = stack.pop()
    if (k === b) return true
    const x = k % W
    const z = (k - x) / W
    for (const [dx, dz] of SIDES) {
      const p = x + dx
      const q = z + dz
      if (p < 0 || q < 0 || p >= W || q >= W) continue
      const nk = idx(p, q)
      if (seen[nk] || kind[nk] !== K_HALL) continue
      seen[nk] = 1
      stack.push(nk)
    }
  }
  return false
}

// The cells joined to `from` through cells `ok` accepts (4-connected).
function flood(kind, from, ok) {
  const seen = new Uint8Array(W * W)
  const stack = []
  for (const k of from) {
    if (seen[k]) continue
    seen[k] = 1
    stack.push(k)
  }
  while (stack.length) {
    const k = stack.pop()
    const x = k % W
    const z = (k - x) / W
    for (const [dx, dz] of SIDES) {
      const p = x + dx
      const q = z + dz
      if (p < 0 || q < 0 || p >= W || q >= W) continue
      const nk = idx(p, q)
      if (seen[nk] || !ok(nk)) continue
      seen[nk] = 1
      stack.push(nk)
    }
  }
  return seen
}
