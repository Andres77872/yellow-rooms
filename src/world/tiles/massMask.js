import { CHUNK, cIdx, hIdx, vIdx } from '../constants.js'
import { COLUMN_STANDARD, WALL_PLAIN } from '../mapTypes.js'
import { familyRecord } from '../families/registry.js'

// Sealed-mass mask (spec §9.6b): which mass cells of a chunk can never be
// seen, so the mesher may skip their column instances and the dressing may
// skip their column trim. Collision, navigation, LightGrid and sight keep
// reading `cols`; this is a render-only economy.
//
// Visibility through mass. A standard column is a 0.8u post in a 3u cell, so
// a mass region is a see-through forest of posts: once sight enters it, rows
// behind the first stay visible through the gaps. The mask therefore works on
// regions, not single cells:
//
// 1. Sight ENTRY points (seeds) are mass cells with an edge that is not an
//    opaque plain wall and leads out of the chunk's mass:
//    - in-chunk: an edge to a non-mass cell (walkable room, furniture,
//      monumental pier, hole) carrying no wall or a see-through wall (window,
//      rail, any non-plain feature), and any mass cell whose own floor or
//      ceiling is holed. Sight from these may flood the whole connected
//      in-chunk mass (IN_CHUNK_DEPTH is unbounded): mass behind in-chunk
//      glass keeps all its columns, as §9.6 requires;
//    - border: the chunk's own west/north line (lx = 0 / lz = 0) unless a
//      plain wall sits on it there, and every east/south border cell (those
//      lines belong to the neighbour, whose wall, possibly glass, this chunk
//      cannot see). Sight from a neighbour may enter here, possibly already
//      deep into the neighbour's mass, so these seeds keep BORDER_DEPTH rows
//      of posts (the seed cell counts as row 1).
// 2. Sight spreads from mass cell to in-chunk mass cell across every edge
//    that is not a plain wall.
// 3. A mass cell is masked when no seed's budget reaches it.
//
// Guarantee (pinned by mass-fast-path.test.js over the 12 liminal kinds):
// no masked cell is reachable through mass from an in-chunk see-through or
// open edge, and none lies within BORDER_DEPTH mass steps of any walkable
// cell anywhere in the map, across chunk borders. Deeper cross-chunk mass is
// at least 4 rows of 0.8u posts (12u) in from the light, where nearly every
// ray has hit a post.
//
// Not cached: the editor preview edits ChunkData in place and re-meshes the
// same object (Preview3D), so a per-object cache would go stale. One pass is
// a 196-cell scan plus a flood, run once by the mesher and once by the
// column dressing per chunk build. Returns a fresh Uint8Array(CHUNK*CHUNK),
// 1 = masked.
export const BORDER_DEPTH = 4
const IN_CHUNK_DEPTH = CHUNK * CHUNK

const isMass = (data, x, z) => data.cols[cIdx(x, z)] === COLUMN_STANDARD
const plainV = (data, line, z) => {
  const i = vIdx(line, z)
  return data.wallV[i] !== 0 && data.wallFeatureV[i] === WALL_PLAIN
}
const plainH = (data, x, line) => {
  const i = hIdx(x, line)
  return data.wallH[i] !== 0 && data.wallFeatureH[i] === WALL_PLAIN
}

export function sealedMassMask(data) {
  const N = CHUNK
  // budget[i]: how many rows of posts, from cell i on, sight can still see
  // (0 = not reached).
  const budget = new Int32Array(N * N)
  const stack = []
  const seed = (x, z, b) => {
    const i = cIdx(x, z)
    if (b > budget[i]) {
      budget[i] = b
      stack.push(i)
    }
  }
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      if (!isMass(data, x, z)) continue
      if (data.hasFloorHole?.(x, z) || data.hasCeilHole?.(x, z)) seed(x, z, IN_CHUNK_DEPTH)
      // West edge: line x (owned; at x = 0 also the chunk border).
      if (x === 0) {
        if (!plainV(data, 0, z)) seed(x, z, BORDER_DEPTH)
      } else if (!isMass(data, x - 1, z) && !plainV(data, x, z)) seed(x, z, IN_CHUNK_DEPTH)
      // East edge: line x + 1; at x = CHUNK-1 it is the neighbour's line.
      if (x === N - 1) seed(x, z, BORDER_DEPTH)
      else if (!isMass(data, x + 1, z) && !plainV(data, x + 1, z)) seed(x, z, IN_CHUNK_DEPTH)
      // North edge: line z (owned; at z = 0 also the chunk border).
      if (z === 0) {
        if (!plainH(data, x, 0)) seed(x, z, BORDER_DEPTH)
      } else if (!isMass(data, x, z - 1) && !plainH(data, x, z)) seed(x, z, IN_CHUNK_DEPTH)
      // South edge: line z + 1; at z = CHUNK-1 it is the neighbour's line.
      if (z === N - 1) seed(x, z, BORDER_DEPTH)
      else if (!isMass(data, x, z + 1) && !plainH(data, x, z + 1)) seed(x, z, IN_CHUNK_DEPTH)
    }
  }
  while (stack.length) {
    const i = stack.pop()
    const b = budget[i] - 1
    if (b <= 0) continue
    const x = i % N
    const z = (i - x) / N
    if (x > 0 && isMass(data, x - 1, z) && !plainV(data, x, z)) seed(x - 1, z, b)
    if (x < N - 1 && isMass(data, x + 1, z) && !plainV(data, x + 1, z)) seed(x + 1, z, b)
    if (z > 0 && isMass(data, x, z - 1) && !plainH(data, x, z)) seed(x, z - 1, b)
    if (z < N - 1 && isMass(data, x, z + 1) && !plainH(data, x, z + 1)) seed(x, z + 1, b)
  }
  const mask = new Uint8Array(N * N)
  for (let i = 0; i < N * N; i++) if (budget[i] === 0 && data.cols[i] === COLUMN_STANDARD) mask[i] = 1
  return mask
}

// The gate (spec §9.6): the mask applies only to families whose registry
// record sets massFastPath. Legacy families (and unknown ids) get null, so
// their mesh and dressing paths read exactly as before.
export const massFastPathOf = (data) => familyRecord(data?.mapFamily)?.massFastPath === true

export function fastPathMassMask(data) {
  return massFastPathOf(data) ? sealedMassMask(data) : null
}
