import { CHUNK } from '../../constants.js'
import { RNG } from '../../core/rng.js'
import { MAP_FAMILY_FUNHOUSE } from '../ids.js'
import { FAMILY_SALT, floorDiv, hashChain, tileKeyAt, tileKeyOf } from '../../tiles/tileKey.js'

// The funhouse family's pure geometry (spec §3.3, §12.12; docs/liminal_maps/
// 12-funhouse.md §4). Everything here is a pure function of (worldSeed,
// global coordinates): the tile, its footprint and the midway ports, the
// spawn cells, each pavilion's SKELETON (its lobby, its two stair cores, the
// dark ride's loop, load/unload platform, gate and walkways — all rolled per
// pavilion), the exit pavilion and its unload-walkway cells, the stair
// chunks (the streaming hint), the per-pavilion third attraction and the
// anomaly budget with its rotated classes. The tile program (tile.js), the
// generator, the hooks and the planner read it; it never reads them.
//
// PLANNER-CHAIN MODULE (§7.5): contract.js → families/planners.js →
// funhouse/structures.js → this file. It may import only constants.js,
// core/hash.js, core/rng.js, mapTypes.js, mapFamily.js ({deepFreeze,
// MAP_FAMILY_CODES}), structures/catalog/engine.js, families/ids.js,
// tiles/tileKey.js and tiles/stubPlanner.js.
//
// The world, in one paragraph. The funhouse is a CHAIN of pavilions along x:
// one row of tiles (rows [0]), each tile one pavilion of 3×2 chunks on two
// storeys (0 the midway and the maze, 1 the dark ride), endless in ±x. The
// covered midway crosses each x seam (the only ports) at that seam's own
// hashed rows, anywhere from the north wall to the south third; inside a
// pavilion it runs its own ROUTE (2 or 3 rows wide, one to four straight runs
// joined by jogs), lined on both sides by booth bands, and passes a lobby
// (a hall across it, a rotunda round it or a vestibule beside it). Every
// pavilion is GENERATED, not copied: its size and outline, its midway route,
// its lobby, its booth bands, where its two enclosed stair cores stand (and
// which way they climb), the shape of its ride loop, the side and length of
// the load/unload platform, the gate and the routes of the two service
// walkways all come from this file's skeleton grammar (skeletonOf, pure in
// (worldSeed, tx)); the tile program grows the booths, the maze wings, the
// attractions, the scene bays and the backstage around it. Every chunk off
// the row, or off storeys 0..1, is solid. A pavilion carries at most one
// anomaly (doc 14), never near the spawn or on the exit pavilion, whose ride
// runs one way so its unload walkway (the exit) comes after the maze and the
// whole ride.
//
// Kind-local frame (the editor kind's coordinates): cells x 0..41, z 0..27,
// storeys 0 (GROUND) and 1 (RIDE). Kind cell (gx, gz) of pavilion tx is
// global (tx·42 + gx, gz); kind storey n is global storey n.

export const FAMILY = MAP_FAMILY_FUNHOUSE

// The kind's dice salt (rng(seed, SALT) in tile.js).
export const SALT = 0x0ca1

// Kind-local storeys.
export const GROUND = 0
export const RIDE = 1

// The tile (§6.2): 3×2 chunks, backend 'band', one band of two storeys,
// one row of tiles. Salt = FAMILY_SALT.funhouse (0x5a170000 + 16).
export const TILE = Object.freeze({
  w: 3, d: 2, backend: 'band', H: 2, lo: 0, hi: 1, rows: Object.freeze([0]), salt: FAMILY_SALT[MAP_FAMILY_FUNHOUSE],
})
export const TILE_CELLS_X = TILE.w * CHUNK // 42 cells per pavilion along the chain
export const TILE_CELLS_Z = TILE.d * CHUNK // 28 cells across

// Hash salts (one per independent stream).
const S_EXIT = 0x0f117001
const S_LIE = 0x0f117002
const S_LIE_ROLL = 0x0f117003
const S_SKELETON = 0x0f117005

// --- footprint and ports ------------------------------------------------------------

// §6.5 footprint: every chunk of a pavilion on storeys 0..1 is baked; the
// rows off the chain and every other storey are solid mass.
export function footprint(worldSeed, cx, cy, cz) {
  return tileKeyOf(TILE, cx, cy, cz) ? 'tile' : 'solid'
}

// The midway's x-seam ports (§12.12; the brief's per-seam hashing): the
// midway crosses each x seam on storey 0 at rows p..p+1, p = portRowOf(seed,
// s) for the seam on the west of pavilion s, hashed per seam anywhere in
// PORT_ROW_MIN..PORT_ROW_MAX (the north third, the middle or the south of
// the pavilion). Seam 0 (the spawn pavilion's west seam) is fixed at
// MIDWAY_ROWS, the spawn's rows. A pavilion's midway enters at its west
// port's rows and leaves at its east port's rows; between them it runs its
// own route (skeleton.route).
export const MIDWAY_ROWS = Object.freeze({ z0: 4, z1: 5 })
export const PORT_ROW_MIN = 3
export const PORT_ROW_MAX = 20
const S_PORT = 0x0f117006
export function portRowOf(worldSeed, s) {
  if (s === 0) return MIDWAY_ROWS.z0
  return PORT_ROW_MIN + (hashChain(((worldSeed >>> 0) ^ S_PORT) | 0, s) % (PORT_ROW_MAX - PORT_ROW_MIN + 1))
}
const PORT_MEMO = new Map()
const NO_PORTS = Object.freeze([])

// §6.5/§6.8: only the west (x) seam of storey 0 carries a port; the north
// side faces the solid rows off the chain, the ride storey is closed.
export function ports(worldSeed, k, side, cy) {
  if (cy !== GROUND || side !== 'west') return NO_PORTS
  const p = portRowOf(worldSeed, k.tx)
  let r = PORT_MEMO.get(p)
  if (!r) PORT_MEMO.set(p, (r = Object.freeze([Object.freeze({ a0: p, a1: p + 1 })])))
  return r
}

// --- the pavilion skeleton (the grammar's frame for one pavilion) -------------------
//
// Spec §6.8 fixes only what a seam needs: the east column (x 41) and the
// south row (z 27) are mass except at ports; the west and north lines are
// the tile's own and are walled where a walkable cell meets them. Nothing
// else of the frame is fixed: every pavilion rolls its own.
//
// The skeleton rolls, per pavilion:
//   shed      the pavilion's size: each side 0..3 cells in from the tile's
//             west line, the mass column x 41, z 0 and the mass row z 27
//             (mass beyond it on both storeys, the midway crossing it), and
//             on storey 0 up to two corner notches of mass (the facade's
//             outline is not a rectangle);
//   route     the MIDWAY: 2 or 3 rows wide, entering at the west port's rows
//             and leaving at the east port's, in 1..4 straight runs at
//             rolled rows joined by 2-column jogs at rolled columns (a
//             straight promenade, a dog-leg, a staircase or a zig-zag; along
//             the north wall, through the middle or down the south side);
//   lobby     on one straight run, one of three shapes: a HALL across the
//             midway grown 2..4 rows to one side, a ROTUNDA grown to both
//             sides, or a VESTIBULE beside the midway entered by a 2-cell
//             arch (the midway runs on past it). A hall or rotunda is
//             entered through a door at one end (the doc's lobby seal) and
//             left WIDE at the other, the end rolled;
//   bands     both sides of every straight run, cut into runs of 2..7
//             columns: where the shed leaves 2..5 rows the band fills them
//             (booths with stock rooms or mass behind); where it leaves more
//             a run is either a booth row 2..3 deep with the field behind it
//             or the FACADE (the field meets the midway: the mouths open
//             there); a single spare row widens the midway;
//   field     what is left of the shed (the maze floor): one to four pieces
//             (north and south of the midway, either side of a jog), each
//             touching the midway; slivers under 12 cells are mass; it must
//             hold the tile's three attractions at their smallest
//             (ATTRACTION_MIN, firstFits), or the roll is redrawn;
//   loop      the dark ride's closed track: the 2-cell rim of a polygon P
//             that is the union of a base rectangle and 0..3 wings — an O,
//             an L, a T, a U or an S-bend of track; P's interior is the
//             ride's backstage;
//   platform  a 2-deep strip, 10..16 long, outside P along a straight run
//             of its rim on any side; the gate is 4 cells of it (WIDE);
//   stairs    stair A (the unload stair) and stair B (the load stair):
//             switchback cores 6×4 or 4×6 (stairwellPlan, any of the four
//             climbing directions, the door near or far), on field cells,
//             strictly inside one chunk;
//   walkways  BFS routes on storey 1 from each core's door to its own end
//             of the platform (A to the unload end, B to the load end).
// The exit pavilion's pane sits across walkway A after its third cell; the
// cells after it are the exit candidates.

export const PLAN_X1 = TILE_CELLS_X - 2 // 40: the last plan column west of the mass column x 41
export const PLAN_Z1 = TILE_CELLS_Z - 2 // 26: the last plan row north of the mass row z 27
export const JOG_X0 = PLAN_X1 - 1 // 39: the last column a jog may start at
const W = TILE_CELLS_X
const D = TILE_CELLS_Z
const at = (x, z) => z * W + x
// Storey-0 frame codes (skeleton.frame, one byte per kind-local cell).
export const F_MASS = 0
export const F_MIDWAY = 1
export const F_LOBBY = 2
export const F_BAND = 3
export const F_FIELD = 4
export const F_CORE = 5
// The smallest field piece kept as maze floor (smaller ones are mass).
const PIECE_MIN = 12
// The shed of the pavilion being rolled (its storey-1 cells; storey 0's
// field is the part of it the frame leaves).
let AREA = null
const inArea = (x, z) => x >= AREA.x0 && x <= AREA.x1 && z >= AREA.z0 && z <= AREA.z1
const inRect = (r, x, z) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1
const grow = (r, k) => ({ x0: r.x0 - k, z0: r.z0 - k, x1: r.x1 + k, z1: r.z1 + k })
const overlaps = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1
const DIR4 = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]])
const weighted = (rnd, table) => {
  let t = rnd.next() * table.reduce((s, [, w]) => s + w, 0)
  for (const [v, w] of table) if ((t -= w) < 0) return v
  return table[table.length - 1][0]
}

// Stair directions as stairwellPlan names them (structures/slab.js: N 0,
// E 1, S 2, W 3 — re-declared here, the planner chain cannot import slab.js).
export const STAIR_DIRS = Object.freeze({ N: 0, E: 1, S: 2, W: 3 })
const AXIS = { 1: [[1, 0], [0, 1]], 3: [[-1, 0], [0, 1]], 2: [[0, 1], [1, 0]], 0: [[0, -1], [1, 0]] }

// The core rect of stairwellPlan({gx, gz, dir}) (both rows plus the halo,
// structures/authored.js) and the cell beyond its door (stairwellDoor).
export function stairCore(gx, gz, dir) {
  const [a, p] = AXIS[dir]
  const xs = []
  const zs = []
  for (const along of [-1, 4]) for (const across of [-1, 2]) {
    xs.push(gx + a[0] * along + p[0] * across)
    zs.push(gz + a[1] * along + p[1] * across)
  }
  return { x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) }
}
export function stairDoor(core, dir, doorSide) {
  const horizontal = dir === STAIR_DIRS.E || dir === STAIR_DIRS.W
  const far = doorSide === 'far'
  if (horizontal) {
    const x = Math.floor((core.x0 + core.x1) / 2)
    return far ? { axis: 'h', line: core.z1 + 1, x, z: core.z1 + 1, inX: x, inZ: core.z1 } : { axis: 'h', line: core.z0, x, z: core.z0 - 1, inX: x, inZ: core.z0 }
  }
  const z = Math.floor((core.z0 + core.z1) / 2)
  return far ? { axis: 'v', line: core.x1 + 1, x: core.x1 + 1, z, inX: core.x1, inZ: z } : { axis: 'v', line: core.x0, x: core.x0 - 1, z, inX: core.x0, inZ: z }
}
const insideOneChunk = (r) =>
  floorDiv(r.x0, CHUNK) === floorDiv(r.x1, CHUNK) && floorDiv(r.z0, CHUNK) === floorDiv(r.z1, CHUNK) &&
  r.x0 - floorDiv(r.x0, CHUNK) * CHUNK >= 1 && r.x1 - floorDiv(r.x1, CHUNK) * CHUNK <= CHUNK - 2 &&
  r.z0 - floorDiv(r.z0, CHUNK) * CHUNK >= 1 && r.z1 - floorDiv(r.z1, CHUNK) * CHUNK <= CHUNK - 2

function bfsCount(open, start) {
  if (!open[start]) return 0
  const seen = new Uint8Array(W * D)
  const q = [start]
  seen[start] = 1
  for (let i = 0; i < q.length; i++) {
    const c = q[i]
    const x = c % W
    const z = (c - x) / W
    for (const [dx, dz] of DIR4) {
      const nx = x + dx
      const nz = z + dz
      if (nx < 0 || nz < 0 || nx >= W || nz >= D) continue
      const n = at(nx, nz)
      if (open[n] && !seen[n]) {
        seen[n] = 1
        q.push(n)
      }
    }
  }
  return q.length
}

// The loop polygon: a base rectangle and 0..3 wings on its sides.
function rollLoop(rnd) {
  const B = { x0: AREA.x0 + 2, z0: AREA.z0 + 2, x1: AREA.x1 - 2, z1: AREA.z1 - 2 }
  const bw = rnd.int(12, Math.min(34, B.x1 - B.x0 + 1))
  const bd = rnd.int(6, Math.min(16, B.z1 - B.z0 + 1))
  const bx = rnd.int(B.x0, B.x1 - bw + 1)
  const bz = rnd.int(B.z0, B.z1 - bd + 1)
  const rects = [{ x0: bx, z0: bz, x1: bx + bw - 1, z1: bz + bd - 1 }]
  const wings = rnd.int(0, 3)
  for (let i = 0; i < wings; i++) {
    const base = rects[0]
    const side = rnd.pick(['N', 'S', 'E', 'W'])
    const horiz = side === 'N' || side === 'S'
    const len = horiz ? base.x1 - base.x0 + 1 : base.z1 - base.z0 + 1
    const L = rnd.int(6, Math.min(len, 14))
    const a0 = (horiz ? base.x0 : base.z0) + rnd.int(0, len - L)
    const out = rnd.int(4, 9)
    let r
    if (side === 'N') r = { x0: a0, x1: a0 + L - 1, z0: base.z0 - out, z1: base.z0 + 2 }
    if (side === 'S') r = { x0: a0, x1: a0 + L - 1, z0: base.z1 - 2, z1: base.z1 + out }
    if (side === 'W') r = { z0: a0, z1: a0 + L - 1, x0: base.x0 - out, x1: base.x0 + 2 }
    if (side === 'E') r = { z0: a0, z1: a0 + L - 1, x0: base.x1 - 2, x1: base.x1 + out }
    r = { x0: Math.max(r.x0, B.x0), z0: Math.max(r.z0, B.z0), x1: Math.min(r.x1, B.x1), z1: Math.min(r.z1, B.z1) }
    const grows = side === 'N' ? base.z0 - r.z0 : side === 'S' ? r.z1 - base.z1 : side === 'W' ? base.x0 - r.x0 : r.x1 - base.x1
    if (grows >= 3 && r.x1 - r.x0 >= 5 && r.z1 - r.z0 >= 5) rects.push(r)
  }
  const P = new Uint8Array(W * D)
  for (const r of rects) for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) P[at(x, z)] = 1
  // Inner (the backstage inside the loop): cells whose 5×5 window is in P.
  const inner = new Uint8Array(W * D)
  let innerN = 0
  let innerAt = -1
  let trackN = 0
  for (let z = B.z0; z <= B.z1; z++) {
    for (let x = B.x0; x <= B.x1; x++) {
      if (!P[at(x, z)]) continue
      let ok = true
      for (let dz = -2; dz <= 2 && ok; dz++) for (let dx = -2; dx <= 2 && ok; dx++) ok = !!P[at(x + dx, z + dz)]
      if (ok) {
        inner[at(x, z)] = 1
        innerN++
        innerAt = at(x, z)
      } else trackN++
    }
  }
  if (!innerN || bfsCount(inner, innerAt) !== innerN) return null
  const track = new Uint8Array(W * D)
  let trackAt = -1
  for (let i = 0; i < W * D; i++) {
    if (P[i] && !inner[i]) {
      track[i] = 1
      trackAt = i
    }
  }
  if (bfsCount(track, trackAt) !== trackN) return null
  return { rects, P, inner, track, trackN }
}

// Straight runs of P's rim with two free rows outside: platform candidates.
function platformRuns(P) {
  const runs = []
  const sides = [
    { side: 'S', out: [0, 1], along: [1, 0] },
    { side: 'N', out: [0, -1], along: [1, 0] },
    { side: 'E', out: [1, 0], along: [0, 1] },
    { side: 'W', out: [-1, 0], along: [0, 1] },
  ]
  for (const s of sides) {
    const lines = s.along[0] ? D : W
    const len = s.along[0] ? W : D
    for (let l = 0; l < lines; l++) {
      let run = []
      const flush = () => {
        if (run.length >= 10) runs.push({ ...s, cells: run })
        run = []
      }
      for (let a = 0; a < len; a++) {
        const x = s.along[0] ? a : l
        const z = s.along[0] ? l : a
        const ok = inArea(x, z) && P[at(x, z)] &&
          [1, 2].every((k) => inArea(x + s.out[0] * k, z + s.out[1] * k) && !P[at(x + s.out[0] * k, z + s.out[1] * k)])
        if (ok) run.push([x, z])
        else flush()
      }
      flush()
    }
  }
  return runs
}

function bfsPath(blocked, start, goals, order) {
  if (blocked[start]) return null
  const prev = new Int32Array(W * D).fill(-2)
  prev[start] = -1
  const q = [start]
  for (let i = 0; i < q.length; i++) {
    const c = q[i]
    if (goals.has(c)) {
      const path = []
      for (let p = c; p !== -1; p = prev[p]) path.unshift(p)
      return path
    }
    const x = c % W
    const z = (c - x) / W
    for (const k of order) {
      const nx = x + DIR4[k][0]
      const nz = z + DIR4[k][1]
      if (!inArea(nx, nz)) continue
      const n = at(nx, nz)
      if (blocked[n] || prev[n] !== -2) continue
      prev[n] = c
      q.push(n)
    }
  }
  return null
}

// The midway's route: its width, the rows of its straight runs (the first
// at the west port's rows, the last at the east port's) and the first
// column of each 2-column jog between them. On the spawn pavilion the
// first run carries the spawn cells (x 10..17), so its first jog comes
// after x 19.
function rollRoute(rnd, m, e, spawnPavilion) {
  const wide = rnd.chance(0.4) ? 3 : 2
  const rows = [m]
  const kinks = weighted(rnd, [[0, 3], [1, 4], [2, 3], [3, 1]])
  for (let i = 0; i < kinks; i++) {
    const r = rnd.int(PORT_ROW_MIN, PORT_ROW_MAX)
    if (Math.abs(r - rows[rows.length - 1]) >= 3) rows.push(r)
  }
  if (rows[rows.length - 1] !== e) {
    // The east port's row: a kink of a row or two folds into the last run.
    if (rows.length > 1 && Math.abs(rows[rows.length - 1] - e) < 3) rows[rows.length - 1] = e
    else rows.push(e)
  }
  for (let i = rows.length - 1; i > 0; i--) if (rows[i] === rows[i - 1]) rows.splice(i, 1)
  const jogs = []
  let lo = spawnPavilion ? 19 : 3
  for (let i = 0; i < rows.length - 1; i++) {
    const hi = JOG_X0 - (rows.length - 2 - i) * 7
    if (hi < lo) return null
    const j = rnd.int(lo, hi)
    jogs.push(j)
    lo = j + 7
  }
  // Runs: the straight columns of each row; jog columns carry both rows.
  const runs = rows.map((row, k) => ({ row, x0: k === 0 ? 0 : jogs[k - 1] + 2, x1: k === rows.length - 1 ? W - 1 : jogs[k] - 1 }))
  const lo2 = new Array(W).fill(-1)
  const hi2 = new Array(W).fill(-1)
  const runOf = new Array(W).fill(-1)
  for (let x = 0; x < W; x++) {
    let k = 0
    while (k < jogs.length && x >= jogs[k] + 2) k++
    if (k < jogs.length && x >= jogs[k]) {
      lo2[x] = Math.min(rows[k], rows[k + 1])
      hi2[x] = Math.max(rows[k], rows[k + 1]) + wide - 1
    } else {
      lo2[x] = rows[k]
      hi2[x] = rows[k] + wide - 1
      runOf[x] = k
    }
  }
  // The east mass column is open only at the east port's two rows.
  lo2[W - 1] = e
  hi2[W - 1] = e + 1
  return { wide, rows, jogs, runs, lo: lo2, hi: hi2, runOf }
}

// The lobby: a hall across the midway, a rotunda round it, or a vestibule
// beside it, on one straight run. On the spawn pavilion a hall or rotunda
// ends by x 8 (west of the spawn cells).
function rollLobby(rnd, route, shed, spawnPavilion) {
  const type = weighted(rnd, [['hall', 4], ['rotunda', 2], ['vestibule', 3]])
  const across = type !== 'vestibule'
  const { wide } = route
  const fitsN = (r, k) => r - k >= shed.z0
  const fitsS = (r, k) => r + wide - 1 + k <= shed.z1
  for (let t = 0; t < 24; t++) {
    const run = spawnPavilion && across ? route.runs[0] : rnd.pick(route.runs)
    const lw = rnd.int(type === 'rotunda' ? 5 : 4, type === 'vestibule' ? 7 : 8)
    const xa = Math.max(run.x0 + 1, shed.x0, 1)
    const xb = Math.min(run.x1 - 1, shed.x1, JOG_X0 - 1)
    let x0
    let x1
    if (spawnPavilion && across) {
      x0 = Math.max(1, shed.x0)
      x1 = Math.min(8, x0 + lw - 1)
    } else {
      if (xb - xa + 1 < lw) continue
      x0 = rnd.int(xa, xb - lw + 1)
      x1 = x0 + lw - 1
    }
    const r = run.row
    const side = rnd.chance(0.5) ? 'N' : 'S'
    const seal = rnd.chance(0.5) ? 'W' : 'E'
    if (type === 'hall') {
      const ext = rnd.int(2, 4)
      const s = (side === 'N' ? fitsN(r, ext) : fitsS(r, ext)) ? side : side === 'N' ? 'S' : 'N'
      if (s === 'N' ? !fitsN(r, ext) : !fitsS(r, ext)) continue
      const z0 = s === 'N' ? r - ext : r
      const z1 = s === 'N' ? r + wide - 1 : r + wide - 1 + ext
      return { type, x0, z0, x1, z1, side: s, seal, row: r, wide, arch: null }
    }
    if (type === 'rotunda') {
      let en = rnd.int(1, 3)
      let es = rnd.int(1, 3)
      while (en > 0 && !fitsN(r, en)) en--
      while (es > 0 && !fitsS(r, es)) es--
      if (!en || !es) continue
      return { type, x0, z0: r - en, x1, z1: r + wide - 1 + es, side: 'NS', seal, row: r, wide, arch: null }
    }
    const depth = rnd.int(3, 5)
    const s = (side === 'N' ? fitsN(r, depth) : fitsS(r, depth)) ? side : side === 'N' ? 'S' : 'N'
    if (s === 'N' ? !fitsN(r, depth) : !fitsS(r, depth)) continue
    const z0 = s === 'N' ? r - depth : r + wide
    const z1 = s === 'N' ? r - 1 : r + wide - 1 + depth
    return { type, x0, z0, x1, z1, side: s, seal: null, row: r, wide, arch: rnd.int(x0, x1 - 1) }
  }
  return null
}

function trySkeleton(rnd, m, e, spawnPavilion) {
  // The shed: the pavilion's own size inside the tile (mass beyond it).
  const margin = () => rnd.pick([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2])
  const shed = { x0: margin(), z0: Math.min(margin(), PORT_ROW_MIN), x1: PLAN_X1 - margin(), z1: PLAN_Z1 - margin() }
  AREA = shed
  const route = rollRoute(rnd, m, e, spawnPavilion)
  if (!route) return null
  const lobby = rollLobby(rnd, route, shed, spawnPavilion)
  if (!lobby) return null
  const across = lobby.type !== 'vestibule'
  // The frame grid: the shed is field until something else claims it.
  const frame = new Uint8Array(W * D)
  for (let z = shed.z0; z <= shed.z1; z++) for (let x = shed.x0; x <= shed.x1; x++) frame[at(x, z)] = F_FIELD
  const midLo = route.lo.slice()
  const midHi = route.hi.slice()
  for (let x = 0; x < W; x++) {
    if (across && x >= lobby.x0 && x <= lobby.x1) {
      midLo[x] = -1
      midHi[x] = -1
      continue
    }
    for (let z = route.lo[x]; z <= route.hi[x]; z++) frame[at(x, z)] = F_MIDWAY
  }
  for (let z = lobby.z0; z <= lobby.z1; z++) for (let x = lobby.x0; x <= lobby.x1; x++) frame[at(x, z)] = F_LOBBY
  // The bands: both sides of every straight run.
  const bands = []
  const widen = (x, z) => {
    frame[at(x, z)] = F_MIDWAY
    if (midLo[x] >= 0) {
      midLo[x] = Math.min(midLo[x], z)
      midHi[x] = Math.max(midHi[x], z)
    }
  }
  route.runs.forEach((run, k) => {
    for (const side of ['N', 'S']) {
      const front = side === 'N' ? run.row - 1 : run.row + route.wide
      const room = side === 'N' ? run.row - shed.z0 : shed.z1 - (run.row + route.wide - 1)
      const dir = side === 'N' ? -1 : 1
      // The columns of this side the band may take (the shed's, never under
      // the lobby, never the run's first or last column next to a jog).
      const cols = []
      for (let x = Math.max(run.x0, shed.x0); x <= Math.min(run.x1, shed.x1); x++) {
        if (frame[at(x, front)] !== F_FIELD) continue
        if ((k > 0 && x === run.x0) || (k < route.runs.length - 1 && x === run.x1)) continue
        cols.push(x)
      }
      const segs = []
      for (const x of cols) {
        const s = segs[segs.length - 1]
        if (s && s.x1 === x - 1) s.x1 = x
        else segs.push({ x0: x, x1: x })
      }
      for (const s of segs) {
        for (let x = s.x0; x <= s.x1;) {
          let w = Math.min(s.x1 - x + 1, rnd.int(2, 7))
          if (s.x1 - (x + w - 1) === 1) w++
          const b = { x0: x, x1: x + w - 1 }
          x += w
          if (room <= 0) continue
          if (room === 1) {
            for (let c = b.x0; c <= b.x1; c++) if (midLo[c] >= 0 && frame[at(c, front)] === F_FIELD) widen(c, front)
            continue
          }
          let depth
          let toEdge
          if (room <= 5) {
            depth = room
            toEdge = true
          } else if (rnd.chance(0.4) || w < 2) {
            continue // the facade: the field meets the midway here
          } else {
            depth = rnd.int(2, 3)
            toEdge = false
          }
          // Only field cells become band (a lobby or a jog may cut a corner).
          let n = 0
          for (let c = b.x0; c <= b.x1; c++) {
            for (let i = 0; i < depth; i++) if (frame[at(c, front + dir * i)] !== F_FIELD) n++
          }
          if (n) continue
          for (let c = b.x0; c <= b.x1; c++) for (let i = 0; i < depth; i++) frame[at(c, front + dir * i)] = F_BAND
          bands.push({ id: bands.length, side, x0: b.x0, x1: b.x1, front, depth, toEdge, run: k })
        }
      }
    }
  })
  if (bands.filter((b) => b.depth >= 2 && b.x1 > b.x0).length < 2) return null
  // Corner notches: the shed's outline steps in (mass on storey 0).
  const notches = []
  for (const corner of rnd.shuffle(['NW', 'NE', 'SW', 'SE']).slice(0, weighted(rnd, [[0, 2], [1, 3], [2, 2]]))) {
    const w = rnd.int(3, 8)
    const d = rnd.int(2, 5)
    const x0 = corner[1] === 'W' ? shed.x0 : shed.x1 - w + 1
    const z0 = corner[0] === 'N' ? shed.z0 : shed.z1 - d + 1
    const r = { x0, z0, x1: x0 + w - 1, z1: z0 + d - 1 }
    let ok = true
    for (let z = r.z0 - 1; z <= r.z1 + 1 && ok; z++) {
      for (let x = r.x0 - 1; x <= r.x1 + 1 && ok; x++) {
        if (!inArea(x, z)) continue
        if (frame[at(x, z)] !== F_FIELD && inRect(r, x, z)) ok = false
        if (frame[at(x, z)] === F_MIDWAY || frame[at(x, z)] === F_LOBBY) ok = false
      }
    }
    if (!ok) continue
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) frame[at(x, z)] = F_MASS
    notches.push(r)
  }
  const loop = rollLoop(rnd)
  if (!loop) return null
  const { P } = loop
  const runs = platformRuns(P)
  if (!runs.length) return null
  const run = rnd.pick(runs)
  const Lp = rnd.int(10, Math.min(16, run.cells.length))
  const k0 = rnd.int(0, run.cells.length - Lp)
  const rim = run.cells.slice(k0, k0 + Lp) // the track cells the platform runs along
  const [ox, oz] = run.out
  const [ax, az] = run.along
  const plat = rim.map(([x, z]) => [[x + ox, z + oz], [x + 2 * ox, z + 2 * oz]])
  const gate = rnd.int(3, Lp - 7) // gate cells gate..gate+3 (platform index)
  const loadEnd = rnd.int(0, 1) // 0: the platform's start (index 0) is the load end
  const blocked = new Uint8Array(W * D)
  for (let i = 0; i < W * D; i++) blocked[i] = P[i]
  for (const [a, b] of plat) {
    blocked[at(...a)] = 1
    blocked[at(...b)] = 1
  }
  // The cells a walkway may arrive at for platform end e, and the platform
  // cell each joins.
  const attach = (e) => {
    const k = e ? Lp - 1 : 0
    const s = e ? 1 : -1
    const out = new Map()
    for (const d of [0, 1]) {
      const [px, pz] = plat[k][d]
      const bx = px + ax * s
      const bz = pz + az * s
      if (inArea(bx, bz) && !blocked[at(bx, bz)]) out.set(at(bx, bz), [px, pz])
    }
    const [px, pz] = plat[k][1]
    if (inArea(px + ox, pz + oz) && !blocked[at(px + ox, pz + oz)]) out.set(at(px + ox, pz + oz), [px, pz])
    return out
  }
  const isField = (x, z) => inArea(x, z) && frame[at(x, z)] === F_FIELD
  const stairs = []
  const paths = []
  for (const role of ['A', 'B']) {
    const end = role === 'B' ? loadEnd : 1 - loadEnd
    let placed = null
    for (let t = 0; t < 140 && !placed; t++) {
      const dir = rnd.int(0, 3)
      const doorSide = rnd.int(0, 1) ? 'far' : 'near'
      const gx = rnd.int(AREA.x0, AREA.x1)
      const gz = rnd.int(AREA.z0, AREA.z1)
      const core = stairCore(gx, gz, dir)
      if (core.x0 < AREA.x0 || core.x1 > AREA.x1 || core.z0 < AREA.z0 || core.z1 > AREA.z1 || !insideOneChunk(core)) continue
      if (overlaps(grow(lobby, 1), core)) continue
      const door = stairDoor(core, dir, doorSide)
      if (!isField(door.x, door.z)) continue
      if (stairs.some((s) => floorDiv(s.core.x0, CHUNK) === floorDiv(core.x0, CHUNK) && floorDiv(s.core.z0, CHUNK) === floorDiv(core.z0, CHUNK))) continue
      let clash = false
      for (let z = core.z0 - 1; z <= core.z1 + 1 && !clash; z++) {
        for (let x = core.x0 - 1; x <= core.x1 + 1 && !clash; x++) {
          const inside = inRect(core, x, z)
          if (inside && (blocked[at(x, z)] || !isField(x, z))) clash = true
          if (stairs.some((s) => inRect(s.core, x, z) || (s.door.x === x && s.door.z === z))) clash = true
        }
      }
      if (clash || blocked[at(door.x, door.z)]) continue
      const goals = attach(end)
      if (!goals.size) break
      const b2 = blocked.slice()
      for (let z = core.z0; z <= core.z1; z++) for (let x = core.x0; x <= core.x1; x++) b2[at(x, z)] = 1
      const order = rnd.shuffle([0, 1, 2, 3])
      const path = bfsPath(b2, at(door.x, door.z), goals, order)
      if (!path || (role === 'A' && path.length < 8)) continue
      placed = { core, door, dir, doorSide, gx, gz, path, joins: goals.get(path[path.length - 1]) }
    }
    if (!placed) return null
    for (let z = placed.core.z0; z <= placed.core.z1; z++) {
      for (let x = placed.core.x0; x <= placed.core.x1; x++) {
        blocked[at(x, z)] = 1
        frame[at(x, z)] = F_CORE
      }
    }
    for (const c of placed.path) blocked[c] = 1
    stairs.push(placed)
    paths.push(placed.path)
  }
  // Storey 0: the field's pieces. Slivers become mass; every piece left
  // touches the midway (its mouths open there) and both stair doors open
  // onto one.
  const [A, Bs] = stairs
  const seen = new Uint8Array(W * D)
  let pieces = 0
  for (let i = 0; i < W * D; i++) {
    if (frame[i] !== F_FIELD || seen[i]) continue
    const comp = [i]
    seen[i] = 1
    let touches = false
    for (let h = 0; h < comp.length; h++) {
      const c = comp[h]
      const x = c % W
      const z = (c - x) / W
      for (const [dx, dz] of DIR4) {
        const nx = x + dx
        const nz = z + dz
        if (nx < 0 || nz < 0 || nx >= W || nz >= D) continue
        const n = at(nx, nz)
        if (frame[n] === F_MIDWAY) touches = true
        if (frame[n] === F_FIELD && !seen[n]) {
          seen[n] = 1
          comp.push(n)
        }
      }
    }
    const hasDoor = [A, Bs].some((s) => comp.includes(at(s.door.x, s.door.z)))
    if (comp.length < PIECE_MIN) {
      if (hasDoor) return null
      for (const c of comp) frame[c] = F_MASS
      continue
    }
    if (!touches) return null
    pieces++
  }
  if (pieces < 1 || pieces > 4) return null
  if (frame[at(A.door.x, A.door.z)] !== F_FIELD || frame[at(Bs.door.x, Bs.door.z)] !== F_FIELD) return null
  if (!attractionRoom(frame, [A.door, Bs.door])) return null
  const cellOf = (c) => Object.freeze({ gx: c % W, gz: (c - (c % W)) / W })
  const stairOut = (s) => Object.freeze({
    gx: s.gx, gz: s.gz, dir: s.dir, doorSide: s.doorSide,
    core: Object.freeze({ ...s.core }),
    door: Object.freeze({ ...s.door }),
    path: Object.freeze(s.path.map(cellOf)),
    joins: Object.freeze({ gx: s.joins[0], gz: s.joins[1] }),
  })
  return {
    mid: m,
    portE: e,
    route: Object.freeze({
      wide: route.wide,
      rows: Object.freeze(route.rows),
      jogs: Object.freeze(route.jogs),
      runs: Object.freeze(route.runs.map((r) => Object.freeze(r))),
    }),
    midLo: Object.freeze(midLo),
    midHi: Object.freeze(midHi),
    lobby: Object.freeze(lobby),
    shed: Object.freeze(shed),
    notches: Object.freeze(notches.map((r) => Object.freeze(r))),
    bands: Object.freeze(bands.map((b) => Object.freeze(b))),
    frame,
    fieldPieces: pieces,
    loopRects: Object.freeze(loop.rects.map((r) => Object.freeze(r))),
    loopCells: loop.trackN,
    P: loop.P,
    inner: loop.inner,
    track: loop.track,
    platform: Object.freeze({
      side: run.side, out: Object.freeze([ox, oz]), along: Object.freeze([ax, az]), length: Lp, gate, loadEnd,
      rim: Object.freeze(rim.map(([x, z]) => Object.freeze({ gx: x, gz: z }))),
      cells: Object.freeze(plat.map((p) => Object.freeze(p.map(([x, z]) => Object.freeze({ gx: x, gz: z }))))),
    }),
    stairA: stairOut(A),
    stairB: stairOut(Bs),
  }
}

// The tile program's three attractions at their smallest (doc §4.3 step 1:
// the 6×4 mirror maze, the 4×4 glass maze, the 3×3 black-light room), each
// with a ring of field round it, clear of the stair doors. The tile places
// them by dice; its last try takes the first fit of each in this order, so a
// skeleton that passes here always has room for them.
export const ATTRACTION_MIN = Object.freeze([Object.freeze([6, 4]), Object.freeze([4, 4]), Object.freeze([3, 3])])
export function firstFits(free, sizes, x0, z0, x1, z1) {
  const SW = W + 1
  const sat = new Int32Array(SW * (D + 1))
  const out = []
  const grid = free.slice()
  for (const [w, d] of sizes) {
    for (let z = 0; z < D; z++) {
      for (let x = 0; x < W; x++) sat[(z + 1) * SW + x + 1] = grid[z * W + x] + sat[z * SW + x + 1] + sat[(z + 1) * SW + x] - sat[z * SW + x]
    }
    let got = null
    for (let z = z0 + 1; z <= z1 - d && !got; z++) {
      for (let x = x0 + 1; x <= x1 - w && !got; x++) {
        const a = x - 1
        const b = z - 1
        const c = x + w
        const e = z + d
        const n = sat[(e + 1) * SW + c + 1] - sat[b * SW + c + 1] - sat[(e + 1) * SW + a] + sat[b * SW + a]
        if (n === (w + 2) * (d + 2)) got = { x0: x, z0: z, x1: x + w - 1, z1: z + d - 1 }
      }
    }
    if (!got) return null
    for (let z = got.z0; z <= got.z1; z++) for (let x = got.x0; x <= got.x1; x++) grid[z * W + x] = 0
    out.push(got)
  }
  return out
}
function attractionRoom(frame, doors) {
  const free = new Uint8Array(W * D)
  for (let z = AREA.z0; z <= AREA.z1; z++) for (let x = AREA.x0; x <= Math.min(AREA.x1, PLAN_X1); x++) free[at(x, z)] = frame[at(x, z)] === F_FIELD ? 1 : 0
  for (const d of doors) free[at(d.x, d.z)] = 0
  return firstFits(free, ATTRACTION_MIN, AREA.x0, AREA.z0, AREA.x1, AREA.z1) !== null
}

// A canonical skeleton for the (never observed) case that every roll of a
// pavilion fails: the first success of a fixed dice sequence for the
// pavilion's port rows (its seams are pure, so the fallback must keep them).
const FALLBACK = new Map()
function fallbackSkeleton(m, e, spawnPavilion) {
  const fk = `${m},${e},${spawnPavilion ? 1 : 0}`
  let f = FALLBACK.get(fk)
  for (let k = 0; !f && k < 4096; k++) {
    const s = trySkeleton(new RNG(hashChain(S_SKELETON, 0x7fff, k)), m, e, spawnPavilion)
    if (s) FALLBACK.set(fk, (f = Object.freeze({ ...s, attempt: -1 })))
  }
  return f
}

export const SKELETON_TRIES = 48
const MEMO = new Map()
const MEMO_CAP = 512

// The skeleton of pavilion tx (pure in worldSeed and tx; memoised).
export function skeletonOf(worldSeed, tx) {
  const seed = worldSeed >>> 0
  const key = `${seed},${tx}`
  const hit = MEMO.get(key)
  if (hit) return hit
  const m = portRowOf(seed, tx)
  const e = portRowOf(seed, tx + 1)
  let s = null
  for (let attempt = 0; attempt < SKELETON_TRIES && !s; attempt++) {
    const got = trySkeleton(new RNG(hashChain((seed ^ S_SKELETON) | 0, tx, attempt)), m, e, tx === 0)
    if (got) s = Object.freeze({ ...got, attempt })
  }
  s ??= fallbackSkeleton(m, e, tx === 0)
  if (MEMO.size >= MEMO_CAP) MEMO.delete(MEMO.keys().next().value)
  MEMO.set(key, s)
  return s
}

// --- stairs (the streaming hint) ---------------------------------------------------------

// True on the two stair chunks of pavilion tx at lowerCy 0 (the only slab a
// flight crosses): the chunks holding stair A's and stair B's cores. A
// sound streaming hint (§9.7).
export function stairChunkAt(worldSeed, cx, cz, lowerCy) {
  if (lowerCy !== GROUND) return false
  const k = tileKeyOf(TILE, cx, lowerCy, cz)
  if (!k) return false
  const sk = skeletonOf(worldSeed, k.tx)
  const lx = cx - k.origin.cx
  const lz = cz - k.origin.cz
  return [sk.stairA, sk.stairB].some((s) => floorDiv(s.core.x0, CHUNK) === lx && floorDiv(s.core.z0, CHUNK) === lz)
}

// --- the pavilion's light ----------------------------------------------------------

// Each pavilion's maze burns in one colour (doc §4.3 step 1: Level 228's
// blue, green and red, Level 956's magenta), pale enough to walk by; the
// midway, its booths and the lobby keep the warm bulb string's colour.
export const FIELD_TINTS = Object.freeze([0x9fb8ff, 0xa8ffc8, 0xff9c9c, 0xffa8ee])
const S_TINT = 0x0f117007
export function fieldTintOf(worldSeed, tx) {
  return FIELD_TINTS[hashChain(((worldSeed >>> 0) ^ S_TINT) | 0, tx) % FIELD_TINTS.length]
}

// --- spawn ------------------------------------------------------------------------

// The spawn (§8.1, §12.12): pavilion 0, storey 0, on the midway east of the
// lobby (every lobby ends by x 8). Fallbacks walk the midway east.
export const SPAWN_CELLS = Object.freeze([[10, 5], [11, 5], [12, 4], [13, 5], [15, 4], [17, 5]].map(([gx, gz]) => Object.freeze({ gx, gz })))

// --- exit -------------------------------------------------------------------------

// On the exit pavilion the ride runs one way (doc §4.3 step 6: "the exit is
// the dark ride's unload platform"): stair A lands in a short stub of its
// walkway (the first STUB cells) behind a glass pane, so the walkway beyond
// is seen but reached only through the maze, stair B, the load platform and
// the full ride loop. Exit cells lie past the pane.
export const STUB = 3

// The exit pavilion (§12.12): tx = 2 + hash % 3 (pure in the seed). Every
// level of a seed shares it.
export function exitTileOf(worldSeed) {
  return 2 + (hashChain(((worldSeed >>> 0) ^ S_EXIT) | 0, 0x0e) % 3)
}

// The unload walkway's cells past the pane (kind-local, RIDE storey).
export function walkwayExitCells(worldSeed, tx) {
  return skeletonOf(worldSeed, tx).stairA.path.slice(STUB)
}

// The exit cell on pavilion tx's unload walkway (kind-local, RIDE): a
// hashed cell of the walkway past the pane.
export function exitCellOf(worldSeed, tx) {
  const cells = walkwayExitCells(worldSeed, tx)
  const h = hashChain(((worldSeed >>> 0) ^ S_EXIT) | 0, tx, 0x1f)
  const c = cells[h % cells.length]
  return Object.freeze({ gx: c.gx, gz: c.gz, cy: RIDE })
}

// The bake's exit candidates (markExit order): the hashed cell first, then
// every other walkway cell past the pane, nearest along the walkway first
// (the hook's §8.2 fallbacks, all on the same walkway, inside the exit
// bounds and on the unload side of the exit pavilion's pane).
export function exitCandidatesOf(worldSeed, tx) {
  const cells = walkwayExitCells(worldSeed, tx)
  const first = exitCellOf(worldSeed, tx)
  const i0 = cells.findIndex((c) => c.gx === first.gx && c.gz === first.gz)
  const rest = cells.map((c, i) => ({ c, i })).filter(({ i }) => i !== i0)
  rest.sort((a, b) => Math.abs(a.i - i0) - Math.abs(b.i - i0) || a.i - b.i)
  return [first, ...rest.map(({ c }) => ({ gx: c.gx, gz: c.gz, cy: RIDE }))]
}

// The tile key of pavilion tx (band 0, row 0).
export const pavilionKey = (tx) => tileKeyAt(TILE, tx, 0, 0)

// A kind-local cell of pavilion tx as a global chunk + chunk-local cell.
export function globalCell(tx, { gx, gz, cy }) {
  const x = tx * TILE_CELLS_X + gx
  const cx = floorDiv(x, CHUNK)
  const cz = floorDiv(gz, CHUNK)
  return { cx, cy, cz, lx: x - cx * CHUNK, lz: gz - cz * CHUNK }
}

export function exitAnchorOfTile(worldSeed, tx) {
  return globalCell(tx, exitCellOf(worldSeed, tx))
}

// §8.2 exit anchor: the hashed unload-walkway cell of the exit pavilion.
export function exitAnchor(worldSeed) {
  const seed = worldSeed >>> 0
  return exitAnchorOfTile(seed, exitTileOf(seed))
}

// --- the anomaly budget (doc §4.3 steps 1 and 4, §10; doc 14: funhouse segment = pavilion) ----

// The mirror maze's lie classes (the kind's FUNHOUSE_LIES): a pane missing
// from the reflection, the reflected lamp dead, a figure standing only in
// the reflection.
export const LIE_CLASSES = Object.freeze(['panel', 'lamp', 'figure'])

// Every anomaly a pavilion can carry (doc §10): the three mirror lies
// (anomalies 1-4, a reflected view that is wrong), a ball rolling uphill in
// the level room (anomaly 5) and a ride animatronic turned toward the
// track (anomaly 8). Index order is the rotation's class order.
export const ANOMALY_CLASSES = Object.freeze([...LIE_CLASSES, 'uphill', 'turned'])

// The pavilion's third attraction (doc §4.3 step 1, hashed per pavilion):
// the level room with its ball track, or a black-light room. The spawn
// pavilion and its neighbours out to LIE_FREE always show the level room, so
// the baseline the 'uphill' anomaly breaks is seen first.
export const ATTRACTIONS = Object.freeze(['level', 'blacklight'])
const S_ATTRACTION = 0x0f117004
export function attractionOf(worldSeed, tx) {
  if (Math.abs(tx) <= LIE_FREE) return 'level'
  return hashChain(((worldSeed >>> 0) ^ S_ATTRACTION) | 0, tx) % 3 === 0 ? 'blacklight' : 'level'
}

// The per-pavilion anomaly budget (doc 14's deviationBudget for the
// funhouse: "the lie budget, grows along the chain"). Doc 14's placement
// rules hold: at most one anomaly per pavilion, never on the exit pavilion,
// the baseline first. So the budget is the CHANCE (per mille) that pavilion
// tx carries its one anomaly: none on the spawn pavilion and the next
// LIE_FREE either way (the player sees three honest pavilions before any
// lie), then 25% rising by 5% a pavilion to a ceiling of 80%. Monotone
// non-decreasing in |tx|, symmetric.
export const LIE_FREE = 2 // |tx| ≤ LIE_FREE carries no anomaly
export const LIE_BASE = 250
export const LIE_STEP = 50
export const LIE_CEIL = 800
export function lieBudget(tx) {
  const a = Math.abs(tx)
  if (a <= LIE_FREE) return 0
  return Math.min(LIE_CEIL, LIE_BASE + LIE_STEP * (a - LIE_FREE - 1))
}

// The classes pavilion tx can show (indices into ANOMALY_CLASSES): the
// level room's 'uphill' only where the pavilion has a level room.
function classesOf(seed, tx) {
  return attractionOf(seed, tx) === 'level' ? [0, 1, 2, 3, 4] : [0, 1, 2, 4]
}

// The raw anomaly of pavilion tx: its preferred class and a priority, or
// null for an honest pavilion (the dice above its budget, or the exit
// pavilion: doc 14 "never on the exit segment").
function rawLie(seed, tx, exitTx) {
  if (tx === exitTx) return null
  const budget = lieBudget(tx)
  if (!budget) return null
  if (hashChain((seed ^ S_LIE_ROLL) | 0, tx, 0x0d) % 1000 >= budget) return null
  const h = hashChain((seed ^ S_LIE) | 0, tx)
  const avail = classesOf(seed, tx)
  return { cls: avail[h % avail.length], avail, pri: h >>> 3, tx }
}

const outranks = (a, b) => a.pri > b.pri || (a.pri === b.pri && a.tx > b.tx)

// The pavilions the rotation compares: the nearest anomalous pavilion on
// either side, within ROT_REACH pavilions (past that many honest pavilions
// the baseline is re-established, so a repeat no longer reads "in a row").
export const ROT_REACH = 12
function nearestLie(seed, tx, dx, exitTx) {
  for (let k = 1; k <= ROT_REACH; k++) {
    const n = rawLie(seed, tx + dx * k, exitTx)
    if (n) return n
  }
  return null
}

// Rotation (doc 14 "never the same class twice in a row"): greedy in
// priority order along the chain of anomalous pavilions. A pavilion takes
// its preferred class unless a neighbouring anomaly of higher priority holds
// it, else the next free class it can show (two neighbours take at most two
// of its four or five). The neighbour relation is symmetric and the
// recursion only climbs strictly rising priorities, so the answer is pure in
// (seed, tx) and independent of the order pavilions are asked in.
function classOf(seed, me, exitTx, memo) {
  const hit = memo.get(me.tx)
  if (hit !== undefined) return hit
  const taken = new Set()
  for (const dx of [-1, 1]) {
    const n = nearestLie(seed, me.tx, dx, exitTx)
    if (n && outranks(n, me)) taken.add(classOf(seed, n, exitTx, memo))
  }
  const at = me.avail.indexOf(me.cls)
  let c = me.cls
  for (let i = 0; i < me.avail.length && taken.has(c); i++) c = me.avail[(at + i + 1) % me.avail.length]
  memo.set(me.tx, c)
  return c
}

// The anomaly of pavilion tx (a name from ANOMALY_CLASSES), or null.
export function anomalyAt(worldSeed, tx) {
  const seed = worldSeed >>> 0
  const exitTx = exitTileOf(seed)
  const me = rawLie(seed, tx, exitTx)
  return me ? ANOMALY_CLASSES[classOf(seed, me, exitTx, new Map())] : null
}

// The anomalies of pavilion tx as a list (none or one), in the order the
// tile program applies them.
export function liesAt(worldSeed, tx) {
  const a = anomalyAt(worldSeed, tx)
  return Object.freeze(a ? [a] : [])
}
