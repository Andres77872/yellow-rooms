import { CHUNK } from '../constants.js'
import { hash2i } from '../core/hash.js'
import { officeGuideDistanceLocal, officeGuidePositions } from '../layoutGuides.js'

// Shared, THREE-free helpers used by the zone generators. All operate on a
// ChunkData instance through its edge accessors.
//
// Zone contract (invariant I1): after generate(), the cell-adjacency graph of
// the chunk (nodes = cells, edge between 4-neighbours iff no wall on the shared
// edge) must be a SINGLE connected component spanning all cells — so every
// border-doorway cell is reachable. Columns add no wall edges; braiding and
// clearings only OPEN edges, so both preserve I1.

// Fill every INTERIOR wall line (1..CHUNK-1) as a wall. The owned border lines
// (lx=0 / lz=0), already written with the reconciled border arrays, are left
// untouched.
export function fillInterior(data) {
  for (let z = 0; z < CHUNK; z++) {
    for (let lx = 1; lx < CHUNK; lx++) data.setV(lx, z, 1)
  }
  for (let lz = 1; lz < CHUNK; lz++) {
    for (let x = 0; x < CHUNK; x++) data.setH(x, lz, 1)
  }
}

// Recursive binary space partition of the inclusive cell rect [x0..x1]×[z0..z1]
// into leaf rooms, each >= min in both dims and <= max where possible. Splits the
// longer axis at a random line that keeps both children >= min.
export function bsp(rng, x0, z0, x1, z1, min, max) {
  const w = x1 - x0 + 1
  const h = z1 - z0 + 1
  const canX = w >= 2 * min
  const canZ = h >= 2 * min
  if ((w <= max && h <= max) || (!canX && !canZ)) {
    return [{ x0, z0, x1, z1 }]
  }
  const splitX = canX && canZ ? w >= h : canX
  if (splitX) {
    const cut = rng.int(x0 + min, x1 - min + 1) // wall line between cell cut-1 | cut
    return [
      ...bsp(rng, x0, z0, cut - 1, z1, min, max),
      ...bsp(rng, cut, z0, x1, z1, min, max),
    ]
  }
  const cut = rng.int(z0 + min, z1 - min + 1)
  return [
    ...bsp(rng, x0, z0, x1, cut - 1, min, max),
    ...bsp(rng, x0, cut, x1, z1, min, max),
  ]
}

const clampThresholdDepth = (config) =>
  Math.max(1, Math.min(CHUNK - 1, config?.border?.thresholdDepth ?? 1))

function carveThresholdSlabs(data, borders, depth, shouldCarve) {
  if (!borders) return
  const last = CHUNK - 1
  const open = (arr, i) => arr && arr[i] === 0
  const carveW = shouldCarve('w')
  const carveE = shouldCarve('e')
  const carveN = shouldCarve('n')
  const carveS = shouldCarve('s')
  for (let i = 0; i < CHUNK; i++) {
    if (carveW && open(borders.wW, i)) {
      for (let step = 1; step <= depth; step++) {
        data.setV(step, i, 0)
        if (open(borders.wW, i + 1)) data.setH(step - 1, i + 1, 0)
      }
    }
    if (carveE && open(borders.wE, i)) {
      for (let step = 1; step <= depth; step++) {
        const x = last - step + 1
        data.setV(x, i, 0)
        if (open(borders.wE, i + 1)) data.setH(x, i + 1, 0)
      }
    }
    if (carveN && open(borders.wN, i)) {
      for (let step = 1; step <= depth; step++) {
        data.setH(i, step, 0)
        if (open(borders.wN, i + 1)) data.setV(i + 1, step - 1, 0)
      }
    }
    if (carveS && open(borders.wS, i)) {
      for (let step = 1; step <= depth; step++) {
        const z = last - step + 1
        data.setH(i, z, 0)
        if (open(borders.wS, i + 1)) data.setV(i + 1, z, 0)
      }
    }
  }
}

// Carve a clean threshold behind every border opening, so a
// doorway/mouth always leads INTO the chunk (never straight into a wall corner)
// and a wide transition mouth reads as one continuous lobby rather than a row of
// slots split by stray walls. Only ever OPENS interior edges (monotone), so it
// can never disconnect the graph (invariant I1 is preserved). `borders` is the
// {wW, wN, wE, wS} doorway map the pipeline already conditions the layout on.
export function carveBorderThresholds(data, borders, config) {
  carveThresholdSlabs(data, borders, clampThresholdDepth(config), () => true)
}

// Same shape as carveBorderThresholds, but only where this zone transitions to a
// walled neighbour. Open<->open seams do not need help, and preserving their
// first interior lines lets warehouse wall fragments continue across chunks.
export function carveTransitionThresholds(data, borders, borderZones, zone, config) {
  if (!borders || !borderZones) return
  const transition = (neighbourZone) =>
    neighbourZone !== undefined && isOpenZone(zone, config) !== isOpenZone(neighbourZone, config)
  carveThresholdSlabs(data, borders, clampThresholdDepth(config), (side) => transition(borderZones[side]))
}

// Open one-cell-wide global corridor guides through office chunks. Horizontal
// guide rows open east-west movement; vertical guide columns open north-south
// movement. Office seam doorways are placed on the same guides in border.js, so
// a doorway leads directly into a route that continues across neighbouring
// chunks.
export function carveOfficeCorridors(data, seed, cx, cz, config) {
  for (const z of officeGuidePositions(cz * CHUNK, seed, config, 'z')) {
    for (let lx = 1; lx < CHUNK; lx++) data.setV(lx, z, 0)
  }
  for (const x of officeGuidePositions(cx * CHUNK, seed, config, 'x')) {
    for (let lz = 1; lz < CHUNK; lz++) data.setH(x, lz, 0)
  }
}

function edgeFalloff(local) {
  if (local <= 0 || local >= CHUNK - 1) return 0.45
  if (local === 1 || local === CHUNK - 2) return 0.75
  return 1
}

// Pick room-to-room doors with a bias toward the same global guide field that
// controls seam doorways. Local BSP still gives variation, but room doors now
// tend to feed the long Level-0 routes instead of punching random corner holes.
export function pickOfficeDoorCandidate(rng, cands, ctx) {
  if (!cands || cands.length === 0) return null
  if (cands.length === 1) return cands[0]
  const { seed, cx, cz, config } = ctx
  let lo = CHUNK
  let hi = -1
  for (const c of cands) {
    const local = c.v !== undefined ? c.z : c.h
    lo = Math.min(lo, local)
    hi = Math.max(hi, local)
  }
  const mid = (lo + hi) * 0.5
  const half = Math.max(1, (hi - lo) * 0.5)
  const weighted = []
  let total = 0
  for (const c of cands) {
    const axis = c.v !== undefined ? 'z' : 'x'
    const local = c.v !== undefined ? c.z : c.h
    const gBase = axis === 'z' ? cz * CHUNK : cx * CHUNK
    const spacing = config.office?.corridors?.spacing ?? config.border?.doorSpacing ?? 5
    const guideD = officeGuideDistanceLocal(gBase, local, seed, config, axis)
    const guide = Math.max(0, 1 - guideD / Math.max(1, spacing * 0.5))
    const centered = 1 - Math.min(1, Math.abs(local - mid) / half)
    const weight = (1 + guide * 5 + centered * 1.35) * edgeFalloff(local)
    total += weight
    weighted.push({ c, weight: total })
  }
  const pick = rng.next() * total
  for (const w of weighted) {
    if (pick <= w.weight) return w.c
  }
  return weighted[weighted.length - 1].c
}

export function carveOfficeJunctionPockets(data, seed, cx, cz, config) {
  const cfg = config.office?.junctions
  if (!cfg || cfg.chance <= 0 || cfg.radius <= 0) return
  const rows = officeGuidePositions(cz * CHUNK, seed, config, 'z', true)
  const cols = officeGuidePositions(cx * CHUNK, seed, config, 'x', true)
  for (const z of rows) {
    for (const x of cols) {
      const gx = cx * CHUNK + x
      const gz = cz * CHUNK + z
      const h = hash2i((seed ^ cfg.salt) | 0, gx, gz)
      if (h / 4294967296 < cfg.chance) data.carveClearing(x, z, cfg.radius)
    }
  }
}

const isOpenZone = (zone, config) => (config.border.openness[zone] ?? 0) >= 1

function clearCol(data, x, z) {
  if (x >= 0 && x < CHUNK && z >= 0 && z < CHUNK) data.setCol(x, z, 0)
}

// Open zones can have columns at cell centres. When an open zone borders an
// office, clear the immediate approach cells behind the transition mouth so the
// seam reads as a usable continuation instead of a threshold cluttered by a
// pillar or rare warehouse column.
export function clearTransitionColumns(data, borders, borderZones, zone, config) {
  if (!borders || !borderZones || !isOpenZone(zone, config)) return
  const last = CHUNK - 1
  const depth = Math.max(2, Math.min(CHUNK, clampThresholdDepth(config) + 1))
  const clearLine = (arr, neighbourZone, clear) => {
    if (!arr || neighbourZone === undefined || isOpenZone(neighbourZone, config)) return
    for (let i = 0; i < CHUNK; i++) if (arr[i] === 0) clear(i)
  }
  clearLine(borders.wW, borderZones.w, (z) => {
    for (let x = 0; x < depth; x++) clearCol(data, x, z)
  })
  clearLine(borders.wE, borderZones.e, (z) => {
    for (let x = last - depth + 1; x <= last; x++) clearCol(data, x, z)
  })
  clearLine(borders.wN, borderZones.n, (x) => {
    for (let z = 0; z < depth; z++) clearCol(data, x, z)
  })
  clearLine(borders.wS, borderZones.s, (x) => {
    for (let z = last - depth + 1; z <= last; z++) clearCol(data, x, z)
  })
}

// Open all interior edges strictly inside a room rect (perimeter walls stay).
export function clearInterior(data, room) {
  const { x0, z0, x1, z1 } = room
  for (let z = z0; z <= z1; z++) {
    for (let lx = x0 + 1; lx <= x1; lx++) data.setV(lx, z, 0)
  }
  for (let x = x0; x <= x1; x++) {
    for (let lz = z0 + 1; lz <= z1; lz++) data.setH(x, lz, 0)
  }
}
