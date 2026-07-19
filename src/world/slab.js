import { CHUNK, LOAD_RADIUS, fmod } from './constants.js'
import { hash3i, hash3f } from './core/hash.js'
import {
  structureAt,
  structureOwnershipAt,
} from './structureContracts.js'
import { structureAdapterFor } from './structureAdapters.js'

// Slab contracts (v9). The slab between layer cy and cy+1 is ONE shared object,
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

const DEFAULT_STAIRS = Object.freeze({
  enabled: true,
  chance: 0.3,
  districtChunks: 4,
  salt: 0x51ab,
  posSalt: 0x9d2f,
  layoutSalt: 0x34d1,
  fallbackSalt: 0xfa11,
})
const STAIR_CONFIG_CACHE = new WeakMap()

const finite = (value, fallback) => Number.isFinite(value) ? value : fallback
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value))

// Normalize the designer-facing stair config at the contract boundary. In
// particular, K=0/NaN previously disabled the deterministic fallback through
// NaN modulo arithmetic, silently violating the "no stranded floor" promise.
// K is capped so a fallback elected in the player's stair district is always
// inside the default streamed XZ box.
export function stairConfig(config) {
  const raw = config?.stairs || DEFAULT_STAIRS
  if (config && typeof config === 'object') {
    const hit = STAIR_CONFIG_CACHE.get(config)
    if (
      hit?.raw === raw &&
      Object.is(hit.enabled, raw.enabled) &&
      Object.is(hit.chance, raw.chance) &&
      Object.is(hit.districtChunks, raw.districtChunks) &&
      Object.is(hit.salt, raw.salt) &&
      Object.is(hit.posSalt, raw.posSalt) &&
      Object.is(hit.layoutSalt, raw.layoutSalt) &&
      Object.is(hit.fallbackSalt, raw.fallbackSalt)
    ) return hit.value
  }
  const value = Object.freeze({
    enabled: raw.enabled === undefined ? DEFAULT_STAIRS.enabled : !!raw.enabled,
    chance: clamp(finite(raw.chance, DEFAULT_STAIRS.chance), 0, 1),
    districtChunks: clamp(
      Math.floor(finite(raw.districtChunks, DEFAULT_STAIRS.districtChunks)),
      1,
      LOAD_RADIUS + 1
    ),
    salt: finite(raw.salt, DEFAULT_STAIRS.salt) | 0,
    posSalt: finite(raw.posSalt, DEFAULT_STAIRS.posSalt) | 0,
    layoutSalt: finite(raw.layoutSalt, DEFAULT_STAIRS.layoutSalt) | 0,
    fallbackSalt: finite(raw.fallbackSalt, DEFAULT_STAIRS.fallbackSalt) | 0,
  })
  if (config && typeof config === 'object') {
    STAIR_CONFIG_CACHE.set(config, {
      raw,
      enabled: raw.enabled,
      chance: raw.chance,
      districtChunks: raw.districtChunks,
      salt: raw.salt,
      posSalt: raw.posSalt,
      layoutSalt: raw.layoutSalt,
      fallbackSalt: raw.fallbackSalt,
      value,
    })
  }
  return value
}

// Candidate placement — the PARITY SCHEME. In canonical coordinates, even
// slabs place E/W strips in rows 3-5 and odd slabs N/S strips in rows 7-10.
// v9 applies one D4 symmetry to BOTH families per chunk column, adding layout
// variety while preserving their disjointness. All strip cells remain inside
// [3..10]², so stamped edges stay on interior lines [3..11] and can never touch
// an owned border, neighbour seam, or transition mouth. Up/down stamps in one
// layer therefore remain conflict-free without cross-contract recursion.
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

// Apply one of the eight symmetries of the square. The transform is keyed by
// the XZ chunk COLUMN (not the slab), so the two alternating parity families
// in every layer are transformed together and remain provably disjoint.
function transformCell(cell, transform) {
  let x = cell.lx
  let z = cell.lz
  if (transform & 4) x = CHUNK - 1 - x
  for (let i = 0; i < (transform & 3); i++) {
    const nx = CHUNK - 1 - z
    z = x
    x = nx
  }
  return { lx: x, lz: z }
}

function transformContract(contract, transform) {
  const landing = transformCell(contract.landing, transform)
  const run = contract.run.map((cell) => transformCell(cell, transform))
  const exit = transformCell(contract.exit, transform)
  const dx = run[0].lx - landing.lx
  const dz = run[0].lz - landing.lz
  const dir = dz < 0 ? STAIR_N : dx > 0 ? STAIR_E : dz > 0 ? STAIR_S : STAIR_W
  return { ...contract, dir, landing, run, exit }
}

// Spawn-hub exclusion: the player spawns at the chunk (0,0) hub (7,7) with a
// radius-1 clearing. Stamps into layer 0 come from slabs cy=0 (up) and cy=-1
// (down); reject candidates whose strip intersects the hub's [5..9]² guard box
// so no stair wall can crowd the spawn. The canonical families always have
// candidates clear of the box, and square symmetries preserve that capacity.
function excluded(cx, cz, cy, contract) {
  if (cx !== 0 || cz !== 0 || (cy !== 0 && cy !== -1)) return false
  for (const { lx: x, lz: z } of stairStrip(contract)) {
    if (x >= 5 && x <= 9 && z >= 5 && z <= 9) return true
  }
  return false
}

// Tall structures own their participant chunks before stairs are elected. Be
// deliberately conservative: a slab is reserved when either floor it joins is
// part of a structure, even when the stair strip would miss the exact void
// footprint. This also keeps stair lobbies off the bottom hall and top gallery.
function validatedStructureAt(seed, cx, cz, levelCy, config) {
  const structure = structureAt(seed, cx, cz, levelCy, config)
  if (structure?.hasRoom !== true) return null

  const adapter = structureAdapterFor(structure)
  if (!adapter) return null

  let participants
  try {
    participants = adapter.expectedParticipants(structure)
  } catch {
    return null
  }
  const ownership = participants.flatMap((participant) => {
    if (
      !Number.isInteger(participant?.cx) ||
      !Number.isInteger(participant?.cz)
    ) return []
    const claim = structureOwnershipAt(
      seed,
      participant.cx,
      participant.cz,
      levelCy,
      config
    )
    return claim ? [claim] : []
  })

  return adapter.validateStructure(structure, { ownership }).ok
    ? structure
    : null
}

function structureReservesSlab(seed, cx, cz, cy, config) {
  return (
    validatedStructureAt(seed, cx, cz, cy, config) !== null ||
    validatedStructureAt(seed, cx, cz, cy + 1, config) !== null
  )
}

// Elect the first available chunk in a root-seeded cyclic permutation of one
// stair district. A structure can therefore displace the old fixed fallback
// slot without removing the district's deterministic stair guarantee whenever
// at least one chunk in that district remains unreserved.
function isFallbackChunk(seed, cx, cz, cy, config, stairs) {
  const K = stairs.districtChunks
  const districtX = Math.floor(cx / K)
  const districtZ = Math.floor(cz / K)
  const area = K * K
  const start = hash3i(
    (seed ^ stairs.fallbackSalt) | 0,
    districtX,
    cy,
    districtZ
  ) % area

  for (let offset = 0; offset < area; offset++) {
    const index = (start + offset) % area
    const candidateCx = districtX * K + (index % K)
    const candidateCz = districtZ * K + Math.floor(index / K)
    if (structureReservesSlab(seed, candidateCx, candidateCz, cy, config)) {
      continue
    }
    return candidateCx === cx && candidateCz === cz
  }
  return false
}

// The slab contract for the slab ABOVE layer cy in chunk column (cx, cz).
// Layer cy realizes the lower half (landing + ramp + ceiling holes); layer
// cy+1 realizes the upper half (floor holes + exit + guard walls).
export function slabContract(seed, cx, cz, cy, config) {
  const s = stairConfig(config)
  if (!s.enabled) return { cy, hasStair: false }

  // Structure ownership wins for both organic stairs and district fallbacks.
  // Suppress the complete contract so neither participating floor can stamp a
  // conflicting half later, regardless of generation or query order.
  if (structureReservesSlab(seed, cx, cz, cy, config)) {
    return { cy, hasStair: false }
  }

  // Existence: a hash gate for organic density, OR'd with a deterministic
  // fallback that walks a root-seeded cyclic permutation of each K x K stair
  // district and elects its first chunk not reserved by a tall structure.
  const gate = hash3f((seed ^ s.salt) | 0, cx, cy, cz) < s.chance
  const fallback = !gate && isFallbackChunk(seed, cx, cz, cy, config, s)
  if (!gate && !fallback) return { cy, hasStair: false }

  const list = candidates(cy)
  const h = hash3i((seed ^ s.posSalt) | 0, cx, cy, cz)
  const transform = hash3i((seed ^ s.layoutSalt) | 0, cx, 0, cz) & 7
  for (let i = 0; i < list.length; i++) {
    const cand = list[(h + i) % list.length]
    const contract = transformContract(realize(cy, cand), transform)
    if (!excluded(cx, cz, cy, contract)) return contract
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
