import { fmod } from './constants.js'
import { hash3i, hash3f } from './core/hash.js'

// Slab contracts (v8). The slab between layer cy and cy+1 is ONE shared object,
// keyed by the LOWER layer — the vertical analogue of the border contracts in
// border.js (both neighbours of an edge derive the identical contract from the
// lower coordinate). A contract is a pure function of (ROOT seed, cx, cz, cy,
// config) and NEVER reads either layer's plan internals, so layer cy and layer
// cy+1 realize matching halves of the same stairwell without communication or
// generation-order coupling.
//
// A stair is a straight run, 1 cell wide: [landing][run0][run1] walkable on the
// lower layer (the ramp rises LAYER_H over run0+run1 = 2*CELL ≈ 31°), with the
// EXIT cell on the upper layer past the ramp top. The slab holes are exactly
// the two run cells. The lower-layer cell under the exit is ordinary floor
// (solid slab above it), walled off from the ramp by the far-end wall.
//
// Ascent directions: 0=N(-z) 1=E(+x) 2=S(+z) 3=W(-x).
export const STAIR_N = 0
export const STAIR_E = 1
export const STAIR_S = 2
export const STAIR_W = 3
export const STAIR_DX = [0, 1, 0, -1]
export const STAIR_DZ = [-1, 0, 1, 0]

// Candidate placement — the PARITY SCHEME. Even slabs (cy even) place E/W
// strips in rows 3-5; odd slabs place N/S strips in a single column of rows
// 7-10. All strip cells sit in [3..10]², so stamped edges live on interior
// lines [3..11]: they can never touch a chunk's owned border lines (0), a
// neighbour-owned seam, or the transition-mouth threshold bands. And because
// the up-stamp (slab cy) and down-stamp (slab cy-1) realized in one layer
// always have opposite parity, their cell AND edge sets are disjoint for every
// possible pair of contracts — conflict-free by construction, with no
// cross-contract lookups (hence no recursive dependency between slabs).
//
// Trade-off, accepted deliberately: stairs on even slabs always run E/W in the
// north band and odd slabs N/S in the south band. Modest positional variety
// (30/16 candidates) in exchange for provable non-conflict.
function candidates(cy) {
  const list = []
  if (fmod(cy, 2) === 0) {
    // E/W strips: cells [c..c+3] x {r}
    for (let r = 3; r <= 5; r++) {
      for (let c = 3; c <= 7; c++) {
        list.push({ dir: STAIR_E, lx: c, lz: r })
        list.push({ dir: STAIR_W, lx: c, lz: r })
      }
    }
  } else {
    // N/S strips: cells {col} x [7..10]
    for (let col = 3; col <= 10; col++) {
      list.push({ dir: STAIR_S, lx: col, lz: 7 })
      list.push({ dir: STAIR_N, lx: col, lz: 7 })
    }
  }
  return list
}

// Materialize a candidate ({dir, lx, lz} = strip origin, its lowest-coordinate
// cell) into the contract's cell roles, ordered base -> top along the ascent.
function realize(cy, cand) {
  const { dir, lx, lz } = cand
  const horizontal = dir === STAIR_E || dir === STAIR_W
  const cells = []
  for (let i = 0; i < 4; i++) {
    cells.push(horizontal ? { lx: lx + i, lz } : { lx, lz: lz + i })
  }
  // Ascending along +axis keeps the array order; -axis reverses it.
  if (dir === STAIR_W || dir === STAIR_N) cells.reverse()
  return {
    cy,
    hasStair: true,
    dir,
    landing: cells[0],
    run: [cells[1], cells[2]],
    exit: cells[3],
  }
}

// Spawn-hub exclusion: the player spawns at the chunk (0,0) hub (7,7) with a
// radius-1 clearing. Stamps into layer 0 come from slabs cy=0 (up) and cy=-1
// (down); reject candidates whose strip intersects the hub's [5..9]² guard box
// so no stair wall can crowd the spawn. Always satisfiable: even slabs keep
// rows 3-4 free, odd slabs keep columns {3,4,10}.
function excluded(cx, cz, cy, cand) {
  if (cx !== 0 || cz !== 0 || (cy !== 0 && cy !== -1)) return false
  const horizontal = cand.dir === STAIR_E || cand.dir === STAIR_W
  for (let i = 0; i < 4; i++) {
    const x = horizontal ? cand.lx + i : cand.lx
    const z = horizontal ? cand.lz : cand.lz + i
    if (x >= 5 && x <= 9 && z >= 5 && z <= 9) return true
  }
  return false
}

// The slab contract for the slab ABOVE layer cy in chunk column (cx, cz).
// Layer cy realizes the lower half (landing + ramp + ceiling holes); layer
// cy+1 realizes the upper half (floor holes + exit + guard walls).
export function slabContract(seed, cx, cz, cy, config) {
  const s = config.stairs
  if (!s?.enabled) return { cy, hasStair: false }

  // Existence: a hash gate for organic density, OR'd with a deterministic
  // fallback that elects exactly one chunk per K x K stair-district per slab —
  // so every floor ALWAYS has an up- and a down-stair within Chebyshev 2K-1
  // chunks of any position. No stranded floors, by construction.
  const gate = hash3f((seed ^ s.salt) | 0, cx, cy, cz) < s.chance
  const K = s.districtChunks
  const sx = Math.floor(cx / K)
  const sz = Math.floor(cz / K)
  const j = hash3i((seed ^ s.fallbackSalt) | 0, sx, cy, sz) % (K * K)
  const fallback = fmod(cx, K) === j % K && fmod(cz, K) === ((j / K) | 0)
  if (!gate && !fallback) return { cy, hasStair: false }

  const list = candidates(cy)
  const h = hash3i((seed ^ s.posSalt) | 0, cx, cy, cz)
  for (let i = 0; i < list.length; i++) {
    const cand = list[(h + i) % list.length]
    if (!excluded(cx, cz, cy, cand)) return realize(cy, cand)
  }
  return { cy, hasStair: false } // unreachable (exclusion is always satisfiable)
}

// The 4 strip cells of a contract, base -> top: [landing, run0, run1, exit].
export function stairStrip(contract) {
  return [contract.landing, contract.run[0], contract.run[1], contract.exit]
}

// Both contracts a LAYER participates in: `up` pierces this layer's ceiling
// (slab cy), `down` pierces its floor (slab cy-1). Consumers that need "which
// stairs touch chunk (cx, cy, cz)" — the stamp, exit placement, streaming
// priority, the debug map — use this without generating anything.
export function chunkStairs(seed, cx, cz, cy, config) {
  return {
    up: slabContract(seed, cx, cz, cy, config),
    down: slabContract(seed, cx, cz, cy - 1, config),
  }
}
