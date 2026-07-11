import {
  CELL,
  worldToCell,
  PATH_VLEASH,
  STAIR_LAYER_COST,
  CROSS_FLOOR_NODE_MULT,
  ENEMY_STAIR_SPEED,
  GROUND_SNAP,
  FLOOR_SWITCH_Y,
  PLAYER_R,
  layerY,
} from './constants.js'
import { moveAndCollide, hasLineOfSight } from '../player/collision.js'
import { groundHeightAt } from '../player/ground.js'

// Grid A* over the thin-wall model, shared by every enemy AI. Walls live on cell
// EDGES (see constants.js), so the graph is the cell grid and an edge between two
// 4-adjacent cells is passable iff there is no wall on the line between them and
// the destination holds no freestanding column — the SAME rule the collision DDA
// and the connectivity flood-fill use, so a path is always physically walkable.
//
// v8: nodes are (gx, gz, cy) — the world is a stack of floors and STAIRS are the
// only vertical edges: a stair's landing (lower layer) connects to its exit cell
// (upper layer) at cost runLen + STAIR_LAYER_COST, appended as a fifth
// fixed-order expansion. Run/hole cells are NOT walkable graph nodes (the ramp
// is traversed BY the stair edge; steering renders it in followPath), so paths
// can never route across the open slab.
//
// Design goals: (1) zero per-call allocation — it runs for several enemies at a
// few Hz; (2) bounded cost — a `leash` clamps the search window (plus a vertical
// leash) and `maxNodes` hard-caps expansions, so an open `warehouse` zone can't
// make it flood; (3) deterministic — fixed neighbour order + a total-order heap
// key, no Math.random. On any failure (unreachable / over budget / beyond leash)
// it returns null and the caller falls back to its native behaviour.

// --- 4-neighbour offsets: E, W, S, N (fixed order => deterministic) ---
export const DX = [1, -1, 0, 0]
export const DZ = [0, 0, 1, -1]

// Is the shared EDGE leaving cell (gx,gz) on layer cy in direction `dir` (0..3)
// passable?
//   E: wall on the line x=gx+1   W: line x=gx
//   S: wall on the line z=gz+1   N: line z=gz
export function edgeOpen(cm, gx, gz, cy, dir) {
  switch (dir) {
    case 0:
      return !cm.wallVAt(gx + 1, gz, cy)
    case 1:
      return !cm.wallVAt(gx, gz, cy)
    case 2:
      return !cm.wallHAt(gx, gz + 1, cy)
    default:
      return !cm.wallHAt(gx, gz, cy)
  }
}

// May a graph node occupy cell (gx,gz) on layer cy? Columns block, and so do
// stair run cells (the ramp) and hole cells (open slab) — the ONE walkability
// rule shared by the expansion, the retarget, steering and the debug flood.
export function cellBlocked(cm, gx, gz, cy) {
  if (cm.columnAt(gx, gz, cy)) return true
  const s = cm.stairAt(gx, gz, cy)
  return !!s && (s.part === 'run' || s.part === 'hole')
}

// Closure form for floodReachable()/tests: may you step from cell A to 4-adjacent
// cell B on layer cy? One validator, no drift.
export function makeCanPass(cm, cy = 0) {
  return (ax, az, bx, bz) => {
    const dx = bx - ax
    const dz = bz - az
    const dir = dx === 1 ? 0 : dx === -1 ? 1 : dz === 1 ? 2 : 3
    return edgeOpen(cm, ax, az, cy, dir) && !cellBlocked(cm, bx, bz, cy)
  }
}

// --- Search scratch (allocated once, reused via a generation stamp) -----------
// A bounded box of WIN_MAX cells per side, LAYERS floors tall. The constant
// strides let a local index `li` be reused across calls: any value written on a
// previous call (different window) reads as "unseen" because its generation
// stamp is stale, so nothing needs clearing between calls.
const WIN_MAX = 64
const LAYERS = 2 * PATH_VLEASH + 1 // vertical extent of the search box
const LAYER_STRIDE = WIN_MAX * WIN_MAX
const N = LAYER_STRIDE * LAYERS // 20,480 nodes (~1MB of Int32 scratch, one-time)
const INF = 0x3fffffff

const gScore = new Int32Array(N)
const came = new Int32Array(N) // parent LOCAL index, -1 at the root
const seenGen = new Int32Array(N) // gScore/came valid iff seenGen[i] === gen
const closeGen = new Int32Array(N) // closed iff closeGen[i] === gen
let gen = 0

const HEAP_CAP = N * 4
const heapVal = new Int32Array(HEAP_CAP) // local node index
const heapKey = new Int32Array(HEAP_CAP) // composite f-then-h key (min-first)
let heapLen = 0

const _recon = new Int32Array(N) // reconstruction scratch (local indices)

// Per-call window origin (set in findPath); li() maps a global cell -> local idx.
let _ox = 0
let _oz = 0
let _ocy = 0 // lowest layer of the search box
const li = (gx, gz, cy) =>
  (cy - _ocy) * LAYER_STRIDE + (gz - _oz) * WIN_MAX + (gx - _ox)

function heapPush(val, key) {
  let i = heapLen++
  heapVal[i] = val
  heapKey[i] = key
  while (i > 0) {
    const p = (i - 1) >> 1
    if (heapKey[p] <= heapKey[i]) break
    const tv = heapVal[p], tk = heapKey[p]
    heapVal[p] = heapVal[i]; heapKey[p] = heapKey[i]
    heapVal[i] = tv; heapKey[i] = tk
    i = p
  }
}

function heapPop() {
  const top = heapVal[0]
  if (--heapLen > 0) {
    heapVal[0] = heapVal[heapLen]
    heapKey[0] = heapKey[heapLen]
    let i = 0
    for (;;) {
      const l = i * 2 + 1
      const r = l + 1
      let m = i
      if (l < heapLen && heapKey[l] < heapKey[m]) m = l
      if (r < heapLen && heapKey[r] < heapKey[m]) m = r
      if (m === i) break
      const tv = heapVal[m], tk = heapKey[m]
      heapVal[m] = heapVal[i]; heapKey[m] = heapKey[i]
      heapVal[i] = tv; heapKey[i] = tk
      i = m
    }
  }
  return top
}

// f-then-h composite so equal-f ties expand toward the goal (lower h). h stays
// well under 256 because the leash caps |dx|+|dz| (and the vertical leash caps
// the |dcy|*STAIR_LAYER_COST term), so this is a strict ordering.
const keyOf = (g, h) => (g + h) * 256 + h

// Consistent 3D heuristic: lateral Manhattan + the minimum vertical cost. A
// lateral edge (cost 1) changes it by <=1; a stair edge (cost runLen +
// STAIR_LAYER_COST) changes the lateral term by <=runLen and the vertical term
// by <=STAIR_LAYER_COST — consistent, so closed nodes never need reopening.
const heur = (ax, az, acy, bx, bz, bcy) =>
  Math.abs(ax - bx) + Math.abs(az - bz) + Math.abs(acy - bcy) * STAIR_LAYER_COST

// A* from world (sx,sz) on floor scy to world (tx,tz) on floor tcy.
// opts: { maxNodes=1200, leash=22, vleash=PATH_VLEASH, margin=6, collapse=true, out=null }
// Returns a flat cell TRIPLE array [gx0,gz0,cy0, gx1,gz1,cy1, ...]
// (start -> target), the caller-supplied `out` reused, or null. No diagonals.
export function findPath(cm, sx, sz, scy, tx, tz, tcy, opts = {}) {
  const maxNodes = opts.maxNodes ?? 1200
  const leash = opts.leash ?? 22
  const vleash = Math.min(opts.vleash ?? PATH_VLEASH, PATH_VLEASH)
  const margin = opts.margin ?? 6
  const collapse = opts.collapse !== false
  const out = opts.out || []

  let sgx = worldToCell(sx)
  let sgz = worldToCell(sz)
  let tgx = worldToCell(tx)
  let tgz = worldToCell(tz)

  if (sgx === tgx && sgz === tgz && scy === tcy) return emit(out, sgx, sgz, scy)

  // Leash bails before any search (XZ Chebyshev + vertical).
  if (Math.max(Math.abs(tgx - sgx), Math.abs(tgz - sgz)) > leash) return null
  if (Math.abs(tcy - scy) > vleash) return null

  // Solid/unwalkable target: retarget deterministically. A target on a stair
  // ramp (run) or over a hole resolves to that stair's walkable end on the
  // same layer; a column retargets to its first open 4-neighbour.
  const ts = cm.stairAt(tgx, tgz, tcy)
  if (ts && (ts.part === 'run' || ts.part === 'hole')) {
    const end = ts.part === 'run' ? ts.landing : ts.exit
    tgx = end.gx
    tgz = end.gz
  } else if (cm.columnAt(tgx, tgz, tcy)) {
    let moved = false
    for (let dir = 0; dir < 4; dir++) {
      const nx = tgx + DX[dir]
      const nz = tgz + DZ[dir]
      if (edgeOpen(cm, tgx, tgz, tcy, dir) && !cellBlocked(cm, nx, nz, tcy)) {
        tgx = nx; tgz = nz; moved = true
        break
      }
    }
    if (!moved) return null
  }
  if (sgx === tgx && sgz === tgz && scy === tcy) return emit(out, sgx, sgz, scy)

  // Window covering start+target plus a margin to route around walls; one layer
  // of vertical slack below (the optimal route may overshoot a floor).
  let bx0 = Math.min(sgx, tgx)
  let bz0 = Math.min(sgz, tgz)
  let bx1 = Math.max(sgx, tgx)
  let bz1 = Math.max(sgz, tgz)
  // Cross-floor: stairs are the ONLY vertical edges and their placement is
  // independent of the start-target corridor — a bare bbox window would only
  // contain one by luck, degenerating vertical pursuit to its fallbacks. Grow
  // the window to include the nearest loaded stair through each slab between
  // the floors (the aperture registry lists them; entities only path through
  // loaded space anyway). If the strip overflows WIN_MAX the guard below still
  // returns null — no worse than not looking.
  if (scy !== tcy && cm.apertures) {
    const lo = Math.min(scy, tcy)
    const hi = Math.max(scy, tcy)
    for (let cy = lo; cy < hi; cy++) {
      let best = null
      let bd = Infinity
      for (const a of cm.apertures.values()) {
        if (a.lowerCy !== cy) continue
        const d = Math.max(
          Math.abs(worldToCell(a.centerX) - sgx),
          Math.abs(worldToCell(a.centerZ) - sgz)
        )
        if (d < bd) {
          bd = d
          best = a
        }
      }
      if (!best || bd > leash) continue
      const st = cm.stairAt(worldToCell(best.centerX), worldToCell(best.centerZ), cy)
      if (!st) continue
      bx0 = Math.min(bx0, st.landing.gx, st.exit.gx)
      bx1 = Math.max(bx1, st.landing.gx, st.exit.gx)
      bz0 = Math.min(bz0, st.landing.gz, st.exit.gz)
      bz1 = Math.max(bz1, st.landing.gz, st.exit.gz)
    }
  }
  _ox = bx0 - margin
  _oz = bz0 - margin
  _ocy = Math.min(scy, tcy) - 1
  const w = bx1 + margin - _ox + 1
  const h = bz1 + margin - _oz + 1
  if (w > WIN_MAX || h > WIN_MAX) return null // (leash keeps us here in practice)
  const exMax = _ox + w
  const ezMax = _oz + h
  const cyMax = _ocy + LAYERS // exclusive

  // Cross-floor searches get a bigger node budget: the heuristic can't see
  // where the stairs are, so the frontier may flood the start floor first.
  const budget = scy === tcy ? maxNodes : maxNodes * CROSS_FLOOR_NODE_MULT

  gen++
  heapLen = 0
  let nodes = 0

  // Seed the search. A start ON the ramp (run/hole — mid-transit repath) can
  // reach EITHER stair end by walking the ramp, so both become roots; A* then
  // picks the end that serves the target, instead of always dragging the
  // entity back down through the landing.
  const seed = (gx, gz, cy, g0) => {
    if (cy < _ocy || cy >= cyMax || gx < _ox || gx >= exMax || gz < _oz || gz >= ezMax) return
    const s = li(gx, gz, cy)
    seenGen[s] = gen
    gScore[s] = g0
    came[s] = -1
    heapPush(s, keyOf(g0, heur(gx, gz, cy, tgx, tgz, tcy)))
  }
  const ss = cm.stairAt(sgx, sgz, scy)
  if (ss && (ss.part === 'run' || ss.part === 'hole')) {
    seed(ss.landing.gx, ss.landing.gz, ss.baseCy, 1)
    seed(ss.exit.gx, ss.exit.gz, ss.baseCy + 1, 1)
  } else {
    seed(sgx, sgz, scy, 0)
  }

  const relax = (ni, g1, ngx, ngz, ncy) => {
    if (closeGen[ni] === gen) return // consistent heuristic => never reopen
    if (seenGen[ni] !== gen) {
      seenGen[ni] = gen
      gScore[ni] = INF
      came[ni] = -1
    }
    if (g1 < gScore[ni]) {
      gScore[ni] = g1
      came[ni] = _cur
      heapPush(ni, keyOf(g1, heur(ngx, ngz, ncy, tgx, tgz, tcy)))
    }
  }
  let _cur = -1

  while (heapLen > 0) {
    const cur = heapPop()
    if (closeGen[cur] === gen) continue // stale duplicate
    closeGen[cur] = gen
    _cur = cur

    const rem = cur % LAYER_STRIDE
    const cgx = _ox + (rem % WIN_MAX)
    const cgz = _oz + ((rem / WIN_MAX) | 0)
    const ccy = _ocy + ((cur / LAYER_STRIDE) | 0)
    if (cgx === tgx && cgz === tgz && ccy === tcy) return reconstruct(cur, out, collapse)
    if (++nodes > budget) return null
    if (heapLen + 8 > HEAP_CAP) return null // defensive: never corrupt the heap

    const g1 = gScore[cur] + 1
    for (let dir = 0; dir < 4; dir++) {
      const ngx = cgx + DX[dir]
      const ngz = cgz + DZ[dir]
      if (ngx < _ox || ngx >= exMax || ngz < _oz || ngz >= ezMax) continue
      if (!edgeOpen(cm, cgx, cgz, ccy, dir)) continue
      if (cellBlocked(cm, ngx, ngz, ccy)) continue
      relax(li(ngx, ngz, ccy), g1, ngx, ngz, ccy)
    }
    // Fifth fixed-order expansion: the stair edge (landing <-> exit).
    const st = cm.stairAt(cgx, cgz, ccy)
    if (st && (st.part === 'landing' || st.part === 'exit')) {
      const up = st.part === 'landing'
      const ncy = up ? st.baseCy + 1 : st.baseCy
      const nc = up ? st.exit : st.landing
      if (
        ncy >= _ocy && ncy < cyMax &&
        nc.gx >= _ox && nc.gx < exMax &&
        nc.gz >= _oz && nc.gz < ezMax
      ) {
        relax(li(nc.gx, nc.gz, ncy), gScore[cur] + st.runLen + STAIR_LAYER_COST, nc.gx, nc.gz, ncy)
      }
    }
  }
  return null // window exhausted -> unreachable
}

// Fill `out` with a single-cell trivial path.
function emit(out, gx, gz, cy) {
  out.length = 0
  out.push(gx, gz, cy)
  return out
}

// Walk came[] target->start into _recon, then emit start..target into `out` as
// [gx,gz,cy,...]. With collapse, drop colinear interior cells (keep endpoints +
// corners) by replacing the previous point whenever the segment direction
// repeats — never across a floor change, so a stair's landing and exit both
// always survive as waypoints.
function reconstruct(targetLocal, out, collapse) {
  let n = 0
  let cur = targetLocal
  while (cur !== -1) {
    _recon[n++] = cur
    cur = came[cur]
  }
  out.length = 0
  for (let k = n - 1; k >= 0; k--) {
    const idx = _recon[k]
    const rem = idx % LAYER_STRIDE
    const gx = _ox + (rem % WIN_MAX)
    const gz = _oz + ((rem / WIN_MAX) | 0)
    const cy = _ocy + ((idx / LAYER_STRIDE) | 0)
    if (collapse && out.length >= 6) {
      const bx = out[out.length - 3]
      const bz = out[out.length - 2]
      const bcy = out[out.length - 1]
      const ax = out[out.length - 6]
      const az = out[out.length - 5]
      const acy = out[out.length - 4]
      if (
        acy === bcy && bcy === cy &&
        Math.sign(bx - ax) === Math.sign(gx - bx) &&
        Math.sign(bz - az) === Math.sign(gz - bz)
      ) {
        out[out.length - 3] = gx // colinear on one floor: extend the segment
        out[out.length - 2] = gz
        continue
      }
    }
    out.push(gx, gz, cy)
  }
  return out
}

// --- Per-frame path follower --------------------------------------------------
// Advances `ent` (an entity with .pos mutated in place and .cy, its floor index)
// toward the path with LOS string-pulling so motion isn't a robotic zig-zag
// along cell centres. Stair traversal: when the current waypoint is on another
// floor, collision runs against the LOWER layer (guard walls live in both
// rasters), speed scales by ENEMY_STAIR_SPEED, and the feet follow the higher
// of the two layers' ground surfaces (the ramp, seen from either side) — the
// same analytic surface the player walks. `ent.cy` flips exactly on waypoint
// arrival, the single mutation point. Returns a REUSED result object
// { i, movedSq, done, stair } (consumed immediately by the caller).
const _follow = { i: 0, movedSq: 0, done: false, stair: false }
const _wp = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this } }

// Is the straight segment walkable for a body of PLAYER_R half-width (not just
// a zero-width ray)? Centre ray plus two parallel rays offset by the radius.
function corridorClear(cm, x0, z0, x1, z1, cy) {
  const dx = x1 - x0
  const dz = z1 - z0
  const d = Math.hypot(dx, dz)
  if (d < 1e-4) return true
  const px = (-dz / d) * PLAYER_R
  const pz = (dx / d) * PLAYER_R
  return (
    hasLineOfSight(cm, x0, z0, x1, z1, cy) &&
    hasLineOfSight(cm, x0 + px, z0 + pz, x1 + px, z1 + pz, cy) &&
    hasLineOfSight(cm, x0 - px, z0 - pz, x1 - px, z1 - pz, cy)
  )
}

export function followPath(cm, ent, path, i, step, opts = {}) {
  const pos = ent.pos
  const n = path ? ((path.length / 3) | 0) : 0
  if (n === 0) {
    _follow.i = i; _follow.movedSq = 0; _follow.done = true; _follow.stair = false
    return _follow
  }
  if (i >= n) i = n - 1
  const arriveR = opts.arriveR ?? CELL * 0.4
  const lookAhead = opts.lookAhead ?? 6

  // A fresh (re)path starts at the entity's own cell: standing ANYWHERE inside
  // the current waypoint's cell counts as arrival (arriveR alone can miss by
  // half a cell). Without this, the periodic repath drags the entity back to
  // its own cell centre each cycle — visible as ping-ponging at a stair mouth,
  // where the next waypoint is cross-floor and the string-pull can't skip it.
  while (
    i < n - 1 &&
    path[i * 3 + 2] === ent.cy &&
    worldToCell(pos.x) === path[i * 3] &&
    worldToCell(pos.z) === path[i * 3 + 1]
  ) {
    i++
  }

  // String-pull: jump the cursor to the farthest SAME-FLOOR waypoint with a
  // clear shot (never pull across a floor transition — the stair must be
  // walked through its landing/exit waypoints). The shot must be clear for
  // the follower's BODY, not just a zero-width ray: a bare ray threads a
  // one-cell doorway diagonally where the box cannot, which traps followers
  // oscillating at stair mouths — so test a corridor of parallel rays offset
  // by the collision radius.
  let jMax = Math.min(i + lookAhead, n - 1)
  for (let j = i + 1; j <= jMax; j++) {
    if (path[j * 3 + 2] !== ent.cy) {
      jMax = j - 1
      break
    }
  }
  for (let j = jMax; j > i; j--) {
    cm.cellCenter(path[j * 3], path[j * 3 + 1], path[j * 3 + 2], _wp)
    if (corridorClear(cm, pos.x, pos.z, _wp.x, _wp.z, ent.cy)) {
      i = j
      break
    }
  }

  const wcy = path[i * 3 + 2]
  const stair = wcy !== ent.cy
  cm.cellCenter(path[i * 3], path[i * 3 + 1], wcy, _wp)
  const bx = pos.x
  const bz = pos.z
  let dx = _wp.x - pos.x
  let dz = _wp.z - pos.z
  const d = Math.hypot(dx, dz)
  if (d > 1e-4) {
    const eff = stair ? step * ENEMY_STAIR_SPEED : step
    const inv = eff / d
    // Collision runs against the entity's CURRENT floor, exactly like the
    // player — the mid-ramp handoff below swaps rasters before either of the
    // two floor-specific stamped edges (far-end wall / back wall) can block.
    moveAndCollide(cm, pos, dx * inv, dz * inv, ent.cy)
  }
  // Feet follow the walk surface. During a stair segment both layers offer a
  // candidate ground (the ramp is the same surface seen from either side, but
  // solid floor cells of the OTHER layer — e.g. the slab above the landing —
  // must not count), so take the highest candidate within climbing reach of
  // the current feet; the ramp's slope per call is far inside GROUND_SNAP.
  if (stair) {
    const gA = groundHeightAt(cm, pos.x, pos.z, ent.cy)
    const gB = groundHeightAt(cm, pos.x, pos.z, wcy)
    const reach = pos.y + GROUND_SNAP
    let gnd = -Infinity
    if (gA <= reach) gnd = gA
    if (gB <= reach && gB > gnd) gnd = gB
    pos.y = gnd === -Infinity ? Math.min(gA, gB) : gnd
    // Height-based floor handoff, mirroring the player controller: flip the
    // collision raster mid-ramp (the two layers agree on every edge there).
    const lower = Math.min(ent.cy, wcy)
    ent.cy = pos.y - layerY(lower) >= FLOOR_SWITCH_Y ? lower + 1 : lower
  } else {
    pos.y = groundHeightAt(cm, pos.x, pos.z, ent.cy)
  }

  // Pop the waypoint once we're on top of it (and adopt its floor).
  dx = _wp.x - pos.x
  dz = _wp.z - pos.z
  if (Math.hypot(dx, dz) < arriveR) {
    ent.cy = wcy
    i++
  }

  _follow.i = i
  _follow.movedSq = (pos.x - bx) * (pos.x - bx) + (pos.z - bz) * (pos.z - bz)
  _follow.done = i >= n
  _follow.stair = stair
  return _follow
}
