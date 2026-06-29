import { CHUNK } from '../constants.js'
import { officeGuidePositions } from '../layoutGuides.js'

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

// Carve a clean threshold one cell deep behind every border opening, so a
// doorway/mouth always leads INTO the chunk (never straight into a wall corner)
// and a wide transition mouth reads as one continuous lobby rather than a row of
// slots split by stray walls. Only ever OPENS interior edges (monotone), so it
// can never disconnect the graph (invariant I1 is preserved). `borders` is the
// {wW, wN, wE, wS} doorway map the pipeline already conditions the layout on.
export function carveBorderThresholds(data, borders) {
  if (!borders) return
  const last = CHUNK - 1
  const open = (arr, i) => arr && arr[i] === 0
  for (let i = 0; i < CHUNK; i++) {
    // West line (lx=0) -> cell (0,i); East line (neighbour's, =wE) -> cell (last,i)
    if (open(borders.wW, i)) {
      data.setV(1, i, 0) // step inward
      if (open(borders.wW, i + 1)) data.setH(0, i + 1, 0) // join adjacent mouth rows
    }
    if (open(borders.wE, i)) {
      data.setV(last, i, 0)
      if (open(borders.wE, i + 1)) data.setH(last, i + 1, 0)
    }
    // North line (lz=0) -> cell (i,0); South line (neighbour's, =wS) -> cell (i,last)
    if (open(borders.wN, i)) {
      data.setH(i, 1, 0)
      if (open(borders.wN, i + 1)) data.setV(i + 1, 0, 0)
    }
    if (open(borders.wS, i)) {
      data.setH(i, last, 0)
      if (open(borders.wS, i + 1)) data.setV(i + 1, last, 0)
    }
  }
}

// Same shape as carveBorderThresholds, but only where this zone transitions to a
// walled neighbour. Open<->open seams do not need help, and preserving their
// first interior lines lets warehouse wall fragments continue across chunks.
export function carveTransitionThresholds(data, borders, borderZones, zone, config) {
  if (!borders || !borderZones) return
  const last = CHUNK - 1
  const transition = (neighbourZone) =>
    neighbourZone !== undefined && isOpenZone(zone, config) !== isOpenZone(neighbourZone, config)
  const open = (arr, i) => arr && arr[i] === 0
  for (let i = 0; i < CHUNK; i++) {
    if (transition(borderZones.w) && open(borders.wW, i)) {
      data.setV(1, i, 0)
      if (open(borders.wW, i + 1)) data.setH(0, i + 1, 0)
    }
    if (transition(borderZones.e) && open(borders.wE, i)) {
      data.setV(last, i, 0)
      if (open(borders.wE, i + 1)) data.setH(last, i + 1, 0)
    }
    if (transition(borderZones.n) && open(borders.wN, i)) {
      data.setH(i, 1, 0)
      if (open(borders.wN, i + 1)) data.setV(i + 1, 0, 0)
    }
    if (transition(borderZones.s) && open(borders.wS, i)) {
      data.setH(i, last, 0)
      if (open(borders.wS, i + 1)) data.setV(i + 1, last, 0)
    }
  }
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
  const clearLine = (arr, neighbourZone, clear) => {
    if (!arr || neighbourZone === undefined || isOpenZone(neighbourZone, config)) return
    for (let i = 0; i < CHUNK; i++) if (arr[i] === 0) clear(i)
  }
  clearLine(borders.wW, borderZones.w, (z) => {
    clearCol(data, 0, z)
    clearCol(data, 1, z)
  })
  clearLine(borders.wE, borderZones.e, (z) => {
    clearCol(data, last, z)
    clearCol(data, last - 1, z)
  })
  clearLine(borders.wN, borderZones.n, (x) => {
    clearCol(data, x, 0)
    clearCol(data, x, 1)
  })
  clearLine(borders.wS, borderZones.s, (x) => {
    clearCol(data, x, last)
    clearCol(data, x, last - 1)
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
