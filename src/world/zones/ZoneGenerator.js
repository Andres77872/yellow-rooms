import { CHUNK } from '../constants.js'
import { borderPairMode } from '../border.js'
import { CELL_LOBBY, PASSAGE_OPEN } from '../mapTypes.js'

// Shared, THREE-free helpers used by the zone generators. All operate on a
// ChunkData instance through its edge accessors.
//
// Open-zone output is validated by the pipeline's topology pass, which enforces
// one local wall component and one column-aware navigation component. Office
// topology is validated on its authoritative district plan before slicing.

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

function carveThresholdSlabs(
  data,
  borders,
  depth,
  shouldCarve,
  passage = PASSAGE_OPEN,
  markLobby = false
) {
  if (!borders) return
  const last = CHUNK - 1
  const open = (arr, i) => arr && arr[i] === 0
  const carveW = shouldCarve('w')
  const carveE = shouldCarve('e')
  const carveN = shouldCarve('n')
  const carveS = shouldCarve('s')
  const mark = (x, z) => {
    if (markLobby && x >= 0 && x < CHUNK && z >= 0 && z < CHUNK) {
      data.cellKind[z * CHUNK + x] = CELL_LOBBY
    }
  }
  for (let i = 0; i < CHUNK; i++) {
    if (carveW && open(borders.wW, i)) {
      for (let step = 1; step <= depth; step++) {
        data.setV(step, i, 0, passage)
        if (open(borders.wW, i + 1)) data.setH(step - 1, i + 1, 0, passage)
        mark(step - 1, i)
      }
    }
    if (carveE && open(borders.wE, i)) {
      for (let step = 1; step <= depth; step++) {
        const x = last - step + 1
        data.setV(x, i, 0, passage)
        if (open(borders.wE, i + 1)) data.setH(x, i + 1, 0, passage)
        mark(x, i)
      }
    }
    if (carveN && open(borders.wN, i)) {
      for (let step = 1; step <= depth; step++) {
        data.setH(i, step, 0, passage)
        if (open(borders.wN, i + 1)) data.setV(i + 1, step - 1, 0, passage)
        mark(i, step - 1)
      }
    }
    if (carveS && open(borders.wS, i)) {
      for (let step = 1; step <= depth; step++) {
        const z = last - step + 1
        data.setH(i, z, 0, passage)
        if (open(borders.wS, i + 1)) data.setV(i + 1, z, 0, passage)
        mark(i, z)
      }
    }
  }
}

// Carve a clean threshold behind every border opening, so a
// door or mouth always leads into the chunk (never straight into a wall corner)
// and a wide transition mouth reads as one continuous lobby rather than a row of
// slots split by stray walls. Only ever OPENS interior edges (monotone), so it
// can never disconnect the graph (invariant I1 is preserved). `borders` is the
// {wW, wN, wE, wS} border-wall contracts used by the zone layout.
export function carveBorderThresholds(
  data,
  borders,
  config,
  shouldCarve = () => true,
  passage = PASSAGE_OPEN,
  markLobby = false
) {
  carveThresholdSlabs(
    data,
    borders,
    clampThresholdDepth(config),
    shouldCarve,
    passage,
    markLobby
  )
}

// Same shape as carveBorderThresholds, but only where this zone transitions to a
// walled neighbour. Open<->open seams do not need help, and preserving their
// first interior lines lets warehouse wall fragments continue across chunks.
export function carveTransitionThresholds(data, borders, borderZones, zone, config) {
  if (!borders || !borderZones) return
  const transition = (neighbourZone) =>
    neighbourZone !== undefined && borderPairMode(zone, neighbourZone, config) === 'mouth'
  carveThresholdSlabs(data, borders, clampThresholdDepth(config), (side) => transition(borderZones[side]))
}

function clearCol(data, x, z) {
  if (x >= 0 && x < CHUNK && z >= 0 && z < CHUNK) data.setCol(x, z, 0)
}

// Open zones can have columns at cell centres. For a named or fallback mouth,
// clear the immediate approach cells so the seam reads as a usable continuation
// instead of a threshold cluttered by a pillar or rare warehouse column.
export function clearTransitionColumns(data, borders, borderZones, zone, config) {
  if (!borders || !borderZones) return
  const last = CHUNK - 1
  const depth = Math.max(2, Math.min(CHUNK, clampThresholdDepth(config) + 1))
  const clearLine = (arr, neighbourZone, clear) => {
    if (
      !arr ||
      neighbourZone === undefined ||
      borderPairMode(zone, neighbourZone, config) !== 'mouth'
    ) return
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
