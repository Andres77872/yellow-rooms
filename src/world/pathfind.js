import { CELL, worldToCell } from './constants.js'
import { moveAndCollide, hasLineOfSight } from '../player/collision.js'

// Grid A* over the thin-wall model, shared by every enemy AI. Walls live on cell
// EDGES (see constants.js), so the graph is the cell grid and an edge between two
// 4-adjacent cells is passable iff there is no wall on the line between them and
// the destination holds no freestanding column — the SAME rule the collision DDA
// and the connectivity flood-fill use, so a path is always physically walkable.
//
// Design goals: (1) zero per-call allocation — it runs for several enemies at a
// few Hz; (2) bounded cost — a `leash` clamps the search window and `maxNodes`
// hard-caps expansions, so an open `warehouse` zone can't make it flood; (3)
// deterministic — fixed neighbour order + a total-order heap key, no Math.random.
// On any failure (unreachable / over budget / beyond leash) it returns null and
// the caller falls back to its native behaviour (beeline / teleport).

// --- 4-neighbour offsets: E, W, S, N (fixed order => deterministic) ---
export const DX = [1, -1, 0, 0]
export const DZ = [0, 0, 1, -1]

// Is the shared EDGE leaving cell (gx,gz) in direction `dir` (0..3) passable?
//   E: wall on the line x=gx+1   W: line x=gx
//   S: wall on the line z=gz+1   N: line z=gz
export function edgeOpen(cm, gx, gz, dir) {
  switch (dir) {
    case 0:
      return !cm.wallVAt(gx + 1, gz)
    case 1:
      return !cm.wallVAt(gx, gz)
    case 2:
      return !cm.wallHAt(gx, gz + 1)
    default:
      return !cm.wallHAt(gx, gz)
  }
}

// Closure form for floodReachable()/tests: may you step from cell A to 4-adjacent
// cell B? (edge open AND destination not a column). One validator, no drift.
export function makeCanPass(cm) {
  return (ax, az, bx, bz) => {
    const dx = bx - ax
    const dz = bz - az
    const dir = dx === 1 ? 0 : dx === -1 ? 1 : dz === 1 ? 2 : 3
    return edgeOpen(cm, ax, az, dir) && !cm.columnAt(bx, bz)
  }
}

// --- Search scratch (allocated once, reused via a generation stamp) -----------
// A bounded square window of WIN_MAX cells per side. The constant stride lets a
// local index `li` be reused across calls: any value written on a previous call
// (different window) reads as "unseen" because its generation stamp is stale, so
// nothing needs clearing between calls.
const WIN_MAX = 64
const N = WIN_MAX * WIN_MAX
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
const li = (gx, gz) => (gz - _oz) * WIN_MAX + (gx - _ox)

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
// well under 256 because the leash caps |dx|+|dz|, so this is a strict ordering.
const keyOf = (g, h) => (g + h) * 256 + h

// A* from world (sx,sz) to world (tx,tz) over global cells.
// opts: { maxNodes=1200, leash=22, margin=6, collapse=true, out=null }
// Returns a flat cell array [gx0,gz0, gx1,gz1, ...] (start -> target), the
// caller-supplied `out` reused, or null. No diagonal moves.
export function findPath(cm, sx, sz, tx, tz, opts = {}) {
  const maxNodes = opts.maxNodes ?? 1200
  const leash = opts.leash ?? 22
  const margin = opts.margin ?? 6
  const collapse = opts.collapse !== false
  const out = opts.out || []

  let sgx = worldToCell(sx)
  let sgz = worldToCell(sz)
  let tgx = worldToCell(tx)
  let tgz = worldToCell(tz)

  if (sgx === tgx && sgz === tgz) return emit(out, sgx, sgz)

  // Leash bail before any allocation/search.
  if (Math.max(Math.abs(tgx - sgx), Math.abs(tgz - sgz)) > leash) return null

  // Solid target: retarget to its first open 4-neighbour, else give up.
  if (cm.columnAt(tgx, tgz)) {
    let moved = false
    for (let dir = 0; dir < 4; dir++) {
      const nx = tgx + DX[dir]
      const nz = tgz + DZ[dir]
      if (edgeOpen(cm, tgx, tgz, dir) && !cm.columnAt(nx, nz)) {
        tgx = nx; tgz = nz; moved = true
        break
      }
    }
    if (!moved) return null
    if (sgx === tgx && sgz === tgz) return emit(out, sgx, sgz)
  }

  // Window covering start+target plus a margin to route around walls.
  _ox = Math.min(sgx, tgx) - margin
  _oz = Math.min(sgz, tgz) - margin
  const w = Math.max(sgx, tgx) + margin - _ox + 1
  const h = Math.max(sgz, tgz) + margin - _oz + 1
  if (w > WIN_MAX || h > WIN_MAX) return null // (leash keeps us here in practice)
  const exMax = _ox + w
  const ezMax = _oz + h

  gen++
  heapLen = 0
  let nodes = 0

  const s = li(sgx, sgz)
  seenGen[s] = gen
  gScore[s] = 0
  came[s] = -1
  heapPush(s, keyOf(0, manhattan(sgx, sgz, tgx, tgz)))

  while (heapLen > 0) {
    const cur = heapPop()
    if (closeGen[cur] === gen) continue // stale duplicate
    closeGen[cur] = gen

    const cgx = _ox + (cur % WIN_MAX)
    const cgz = _oz + ((cur / WIN_MAX) | 0)
    if (cgx === tgx && cgz === tgz) return reconstruct(cur, out, collapse)
    if (++nodes > maxNodes) return null

    const g1 = gScore[cur] + 1
    for (let dir = 0; dir < 4; dir++) {
      const ngx = cgx + DX[dir]
      const ngz = cgz + DZ[dir]
      if (ngx < _ox || ngx >= exMax || ngz < _oz || ngz >= ezMax) continue
      if (!edgeOpen(cm, cgx, cgz, dir)) continue
      if (cm.columnAt(ngx, ngz)) continue
      const ni = li(ngx, ngz)
      if (closeGen[ni] === gen) continue // consistent heuristic => never reopen
      if (seenGen[ni] !== gen) {
        seenGen[ni] = gen
        gScore[ni] = INF
        came[ni] = -1
      }
      if (g1 < gScore[ni]) {
        gScore[ni] = g1
        came[ni] = cur
        heapPush(ni, keyOf(g1, manhattan(ngx, ngz, tgx, tgz)))
      }
    }
  }
  return null // window exhausted -> unreachable
}

const manhattan = (ax, az, bx, bz) => Math.abs(ax - bx) + Math.abs(az - bz)

// Fill `out` with a single-cell trivial path.
function emit(out, gx, gz) {
  out.length = 0
  out.push(gx, gz)
  return out
}

// Walk came[] target->start into _recon, then emit start..target into `out` as
// [gx,gz,...]. With collapse, drop colinear interior cells (keep endpoints +
// corners) by replacing the previous point whenever the segment direction repeats.
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
    const gx = _ox + (idx % WIN_MAX)
    const gz = _oz + ((idx / WIN_MAX) | 0)
    if (collapse && out.length >= 4) {
      const bx = out[out.length - 2]
      const bz = out[out.length - 1]
      const ax = out[out.length - 4]
      const az = out[out.length - 3]
      if (Math.sign(bx - ax) === Math.sign(gx - bx) && Math.sign(bz - az) === Math.sign(gz - bz)) {
        out[out.length - 2] = gx // colinear: extend the last segment
        out[out.length - 1] = gz
        continue
      }
    }
    out.push(gx, gz)
  }
  return out
}

// --- Per-frame path follower --------------------------------------------------
// Advances `pos` (mutated, XZ) toward the path with LOS string-pulling so motion
// isn't a robotic zig-zag along cell centres. Returns a REUSED result object
// (consumed immediately by the caller): { i, movedSq, done }.
const _follow = { i: 0, movedSq: 0, done: false }
const _wp = { x: 0, z: 0, set(x, _y, z) { this.x = x; this.z = z; return this } }

export function followPath(cm, pos, path, i, step, opts = {}) {
  const n = path ? path.length >> 1 : 0
  if (n === 0) {
    _follow.i = i; _follow.movedSq = 0; _follow.done = true
    return _follow
  }
  if (i >= n) i = n - 1
  const arriveR = opts.arriveR ?? CELL * 0.4
  const lookAhead = opts.lookAhead ?? 6

  // String-pull: jump the cursor to the farthest waypoint with a clear shot.
  const jMax = Math.min(i + lookAhead, n - 1)
  for (let j = jMax; j > i; j--) {
    cm.cellCenter(path[j << 1], path[(j << 1) + 1], _wp)
    if (hasLineOfSight(cm, pos.x, pos.z, _wp.x, _wp.z)) {
      i = j
      break
    }
  }

  cm.cellCenter(path[i << 1], path[(i << 1) + 1], _wp)
  const bx = pos.x
  const bz = pos.z
  let dx = _wp.x - pos.x
  let dz = _wp.z - pos.z
  const d = Math.hypot(dx, dz)
  if (d > 1e-4) {
    const inv = step / d
    moveAndCollide(cm, pos, dx * inv, dz * inv)
  }
  // Pop the waypoint once we're on top of it.
  dx = _wp.x - pos.x
  dz = _wp.z - pos.z
  if (Math.hypot(dx, dz) < arriveR) i++

  _follow.i = i
  _follow.movedSq = (pos.x - bx) * (pos.x - bx) + (pos.z - bz) * (pos.z - bz)
  _follow.done = i >= n
  return _follow
}
