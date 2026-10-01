import {
  BASEBOARD_H,
  BASEBOARD_PROUD,
  BRIDGE_GUARD_CAP_H,
  BRIDGE_GUARD_H,
  CELL,
  CHUNK,
  CROWN_H,
  CROWN_PROUD,
  FRAME_DEPTH,
  THICK,
  WALL_BEVEL,
  WALL_H,
  WINDOW_HEAD_Y,
  WINDOW_SILL_H,
  hIdx,
  vIdx,
} from '../constants.js'
import { PASSAGE_DOOR, WALL_RAIL, WALL_WINDOW } from '../mapTypes.js'

// The wall shell: per-edge wall bytes -> the boxes that draw them.
//
// The thin-wall model stores one byte per 3 m cell edge. Drawn one box per
// edge, a straight wall was a row of abutting slabs, and every L-corner left
// a THICK/2 square notch at its outer corner (each slab stopped on the grid
// line). With bevelled edges (render/bevel.js) every slab end would also
// round off and groove the wall once per cell. So the shell is built from
// RUNS, and every run end is resolved against the vertex it meets:
//
//   runs     consecutive collinear edges of the same piece kind: one box per
//            height band of the kind (a window is a sill and a header);
//   exposed  an end with nothing collinear past the vertex, not buried in a
//            through-wall: a free end, either leg of an L-corner, or a run
//            reaching a chunk seam. It reaches THICK/2 past the vertex to
//            the far face of the vertex square. An L's two legs then fill the
//            square (no notch) and round its outer corner identically, and
//            each leg's inner corner lies on the other's flat face — flat for
//            THICK - r > r, so any r < THICK/2 hides;
//   joint    a window/rail run continuing into a wall whose bands contain
//            its own reaches 2r into it: each rounding lands on the other's
//            flat face (the wall's end is the window jamb, and stays put);
//   buried   a T-stem ends on the through-wall's centre line, THICK/2 deep:
//            its rounding (r < THICK/2) is inside the through-wall.
//
// A continuation through a framed doorway also covers an end: the casing's
// jamb and back-band wrap it.
//
// Seams: a chunk owns its lines 0..CHUNK-1 only; edges past the chunk read
// as absent, so a wall crossing a seam is extended THICK/2 past it from both
// sides. The overlap is coplanar wallpaper — invisible — and the wall stays
// seamless without neighbour data at mesh time. When the neighbour does not
// continue, the end looks exactly like any other free end.
//
// Pure functions, THREE-free; descriptors are { px, py, pz, sx, sy, sz } in
// chunk-local world units, like the joinery and dressing builders.

const NONE = 0
const PLAIN = 1
const WINDOW = 2
const RAIL = 3

// Height bands [y0, y1] of the boxes each piece kind is made of.
const BANDS = [
  [],
  [[0, WALL_H]],
  [[0, WINDOW_SILL_H], [WINDOW_HEAD_Y, WALL_H]],
  [[0, BRIDGE_GUARD_H]],
]
const JOINT_REACH = 2 * WALL_BEVEL

const contains = (outer, band) => outer[0] <= band[0] + 1e-9 && outer[1] >= band[1] - 1e-9
const bandIn = (kind, band) => BANDS[kind].some((b) => contains(b, band))

function pieceKind(wall, feature) {
  if (wall !== 1) return NONE
  if (feature === WALL_WINDOW) return WINDOW
  if (feature === WALL_RAIL) return RAIL
  return PLAIN
}

// Edge accessors over the OWNED lines; anything past the chunk reads absent.
function edgeReader(data, kindOf) {
  const owned = (a, b) => a >= 0 && a < CHUNK && b >= 0 && b < CHUNK
  return {
    v: (lx, z) => (owned(lx, z) ? kindOf('v', lx, z) : NONE),
    h: (x, lz) => (owned(x, lz) ? kindOf('h', lz, x) : NONE),
    doorV: (lx, z) => owned(lx, z) && data.passageV[vIdx(lx, z)] === PASSAGE_DOOR,
    doorH: (x, lz) => owned(x, lz) && data.passageH[hIdx(x, lz)] === PASSAGE_DOOR,
  }
}

// Maximal same-kind runs on every owned line:
// [{ axis, line, c0, c1, kind }] with cells c0..c1 inclusive.
function collectRuns(read) {
  const runs = []
  for (const axis of ['v', 'h']) {
    const at = axis === 'v' ? (line, c) => read.v(line, c) : (line, c) => read.h(c, line)
    for (let line = 0; line < CHUNK; line++) {
      let start = 0
      for (let c = 1; c <= CHUNK; c++) {
        const prev = at(line, c - 1)
        if (c < CHUNK && at(line, c) === prev) continue
        if (prev !== NONE) runs.push({ axis, line, c0: start, c1: c - 1, kind: prev })
        start = c
      }
    }
  }
  return runs
}

// The four pieces meeting at grid vertex (vx, vz), and whether a framed
// doorway continues each direction.
function vertexPieces(read, vx, vz) {
  return {
    n: read.v(vx, vz - 1),
    s: read.v(vx, vz),
    w: read.h(vx - 1, vz),
    e: read.h(vx, vz),
    doorN: read.doorV(vx, vz - 1),
    doorS: read.doorV(vx, vz),
    doorW: read.doorH(vx - 1, vz),
    doorE: read.doorH(vx, vz),
  }
}

const OPPOSITE = { n: 's', s: 'n', w: 'e', e: 'w' }
const ACROSS = { n: ['w', 'e'], s: ['w', 'e'], w: ['n', 's'], e: ['n', 's'] }
const DOOR = { n: 'doorN', s: 'doorS', w: 'doorW', e: 'doorE' }

// Does the piece arriving at a vertex from `dir` end exposed there?
function exposedAt(p, dir) {
  const opp = OPPOSITE[dir]
  if (p[opp] !== NONE || p[DOOR[opp]]) return false
  const [a, b] = ACROSS[dir]
  const buried = p[a] !== NONE && p[b] !== NONE &&
    BANDS[p[dir]].every((band) => bandIn(p[a], band) && bandIn(p[b], band))
  return !buried
}

// Resolve both ends of a run: { start, end } each 'exposed' | 'joint' (with
// the collinear neighbour's kind) | null.
function runEnds(read, run) {
  const vertical = run.axis === 'v'
  const at = vertical ? (c) => read.v(run.line, c) : (c) => read.h(c, run.line)
  const vertex = (c) => (vertical ? vertexPieces(read, run.line, c) : vertexPieces(read, c, run.line))
  const resolve = (pieces, dir, beyond) => {
    if (exposedAt(pieces, dir)) return { exposed: true }
    if (beyond !== NONE && beyond !== run.kind) return { joint: beyond }
    return {}
  }
  return {
    start: resolve(vertex(run.c0), vertical ? 's' : 'e', at(run.c0 - 1)),
    end: resolve(vertex(run.c1 + 1), vertical ? 'n' : 'w', at(run.c1 + 1)),
  }
}

// Along-axis extent of a run's box: `reach` past exposed ends and, for a
// THICK-deep shell box (`band`), the joint reach into a containing neighbour.
function runSpan(run, ends, reach, band = null) {
  const grow = (end) => (end.exposed ? reach : band && end.joint && bandIn(end.joint, band) ? JOINT_REACH : 0)
  return [run.c0 * CELL - grow(ends.start), (run.c1 + 1) * CELL + grow(ends.end)]
}

// Boxes take a vertical centre + height (py, sy), like every other
// descriptor builder, so profile heights stay exact (CROWN_H, not a
// difference of two floats).
function pushAlong(out, axis, line, [a0, a1], py, sy, depth) {
  const plane = line * CELL
  const along = (a0 + a1) / 2
  const len = a1 - a0
  if (axis === 'v') out.push({ px: plane, py, pz: along, sx: depth, sy, sz: len })
  else out.push({ px: along, py, pz: plane, sx: len, sy, sz: depth })
}

// The wallpaper shell and its rail caps.
// -> { walls: boxes (wallpaper batch), caps: boxes (trim batch) }
export function collectWallShell(data) {
  const read = edgeReader(data, (axis, line, cell) =>
    axis === 'v'
      ? pieceKind(data.wallV[vIdx(line, cell)], data.wallFeatureV[vIdx(line, cell)])
      : pieceKind(data.wallH[hIdx(cell, line)], data.wallFeatureH[hIdx(cell, line)])
  )
  const walls = []
  const caps = []
  for (const run of collectRuns(read)) {
    const ends = runEnds(read, run)
    for (const band of BANDS[run.kind]) {
      pushAlong(walls, run.axis, run.line, runSpan(run, ends, THICK / 2, band), (band[0] + band[1]) / 2, band[1] - band[0], THICK)
    }
    if (run.kind === RAIL) {
      // The contrasting cap rides the parapet top, wrapping exposed ends.
      pushAlong(caps, run.axis, run.line, runSpan(run, ends, FRAME_DEPTH / 2), BRIDGE_GUARD_H, BRIDGE_GUARD_CAP_H, FRAME_DEPTH)
    }
  }
  return { walls, caps }
}

// Baseboard + crown along every full-height wall face that has floor on both
// sides (rails carry their own cap; faces over a slab opening carry nothing),
// run-merged and resolved on the same rules as the shell, so the trim wraps
// outer corners and free wall ends instead of stopping short of them.
export function collectWallTrim(data) {
  const holeAt = (x, z) => x >= 0 && x < CHUNK && z >= 0 && z < CHUNK && data.hasFloorHole(x, z)
  const read = edgeReader(data, (axis, line, cell) => {
    const vertical = axis === 'v'
    const i = vertical ? vIdx(line, cell) : hIdx(cell, line)
    if ((vertical ? data.wallV[i] : data.wallH[i]) !== 1) return NONE
    if ((vertical ? data.wallFeatureV[i] : data.wallFeatureH[i]) === WALL_RAIL) return NONE
    const over = vertical
      ? holeAt(line - 1, cell) || holeAt(line, cell)
      : holeAt(cell, line - 1) || holeAt(cell, line)
    return over ? NONE : PLAIN
  })
  const trim = []
  const boardDepth = THICK + 2 * BASEBOARD_PROUD
  const crownDepth = THICK + 2 * CROWN_PROUD
  for (const run of collectRuns(read)) {
    const ends = runEnds(read, run)
    pushAlong(trim, run.axis, run.line, runSpan(run, ends, boardDepth / 2), BASEBOARD_H / 2, BASEBOARD_H, boardDepth)
    pushAlong(trim, run.axis, run.line, runSpan(run, ends, crownDepth / 2), WALL_H - CROWN_H / 2, CROWN_H, crownDepth)
  }
  return trim
}

// Union collinear boxes with an identical cross-section whose along-extents
// touch or overlap: the union is exactly one box, so this never changes the
// silhouette — it removes the seams a bevel would round, and instances.
// `tint` (when present) must match too. Order of the result is stable.
const q = (v) => Math.round(v * 1e5)
export function mergeCollinearBoxes(boxes) {
  const tintKey = (b) => (b.tint ? b.tint.map(q).join('/') : '')
  const pass = (list, axis) => {
    const [p, s, o1, s1, o2, s2] = axis === 'x'
      ? ['px', 'sx', 'py', 'sy', 'pz', 'sz']
      : ['pz', 'sz', 'py', 'sy', 'px', 'sx']
    const groups = new Map()
    list.forEach((b, i) => {
      const key = `${q(b[o1])},${q(b[s1])},${q(b[o2])},${q(b[s2])},${tintKey(b)}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(i)
    })
    const merged = new Map() // lead index -> merged box
    const dropped = new Set()
    for (const members of groups.values()) {
      if (members.length < 2) continue
      members.sort((i, j) => (list[i][p] - list[i][s] / 2) - (list[j][p] - list[j][s] / 2))
      let lead = members[0]
      let lo = list[lead][p] - list[lead][s] / 2
      let hi = list[lead][p] + list[lead][s] / 2
      const flush = () => {
        if (hi - lo > list[lead][s] + 1e-9) merged.set(lead, { ...list[lead], [p]: (lo + hi) / 2, [s]: hi - lo })
      }
      for (let k = 1; k < members.length; k++) {
        const b = list[members[k]]
        const b0 = b[p] - b[s] / 2
        const b1 = b[p] + b[s] / 2
        if (b0 <= hi + 1e-6) {
          hi = Math.max(hi, b1)
          dropped.add(members[k])
        } else {
          flush()
          lead = members[k]
          lo = b0
          hi = b1
        }
      }
      flush()
    }
    const out = []
    list.forEach((b, i) => {
      if (!dropped.has(i)) out.push(merged.get(i) ?? b)
    })
    return out
  }
  return pass(pass(boxes, 'x'), 'z')
}
