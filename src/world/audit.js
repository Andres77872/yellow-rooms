import { CHUNK } from './constants.js'
import { chunksShareOfficeDistrict } from './zones/officePlan.js'

// Continuity / "isolation" audit for the thin-wall generator. THREE-free and
// pure data, so it is shared by the property tests (continuity.test.js) and the
// debug world map (WorldMapTool) — one source of truth, like connectivity.js.
//
// It inspects SHARED BORDERS (the only place chunks couple) and reports how
// continuous the world reads: open zones should merge, office<->open seams
// should have a wide transition mouth, district boundaries need portals, and
// internal office seams should vary like ordinary plan cuts. A planned internal
// seam may be solid; macro-plan connectivity, not per-chunk permeability, is
// the architectural invariant.
//
// Seam storage (thin-wall ownership): the vertical seam between (cx,cz) and
// (cx+1,cz) is the EAST chunk's west line — east.vAt(0,z). The horizontal seam
// between (cx,cz) and (cx,cz+1) is the SOUTH chunk's north line — south.hAt(x,0).

export function vSeamLine(east) {
  const a = new Uint8Array(CHUNK)
  for (let z = 0; z < CHUNK; z++) a[z] = east.vAt(0, z)
  return a
}
export function hSeamLine(south) {
  const a = new Uint8Array(CHUNK)
  for (let x = 0; x < CHUNK; x++) a[x] = south.hAt(x, 0)
  return a
}

export const openFraction = (line) => {
  let n = 0
  for (let i = 0; i < CHUNK; i++) if (line[i] === 0) n++
  return n / CHUNK
}
export const openCount = (line) => {
  let n = 0
  for (let i = 0; i < CHUNK; i++) if (line[i] === 0) n++
  return n
}
export const longestOpenRun = (line) => {
  let best = 0
  let run = 0
  for (let i = 0; i < CHUNK; i++) {
    if (line[i] === 0) best = Math.max(best, ++run)
    else run = 0
  }
  return best
}
// Stable key of the open-index set (for cross-seam alignment comparison).
const openKey = (line) => {
  let k = ''
  for (let i = 0; i < CHUNK; i++) if (line[i] === 0) k += i + ','
  return k
}

const isOpen = (zone, config) => (config.border.openness[zone] ?? 0) >= 1

// Seam style from the two adjacent zones (mirrors border.js reconcile()).
export function classifySeam(za, zb, config, chunkA = null, chunkB = null) {
  const openA = isOpen(za, config)
  const openB = isOpen(zb, config)
  if (openA && openB) return 'open'
  if (openA || openB) return 'mouth'
  if (
    chunkA &&
    chunkB &&
    chunksShareOfficeDistrict(chunkA.cx, chunkA.cz, chunkB.cx, chunkB.cz, config)
  ) return 'planned'
  return 'office'
}

function blank() {
  return {
    seams: 0,
    sealed: 0, // fully solid shared borders (must be 0)
    minOpen: CHUNK, // fewest open cells on any seam (must be >= 1)
    open: { n: 0, openSum: 0 }, // open<->open: should be near-fully open
    mouth: { n: 0, withMouth: 0 }, // office<->open: should all have a wide mouth
    office: { n: 0, minDoors: CHUNK, cornerWalls: 0 }, // office district boundaries
    planned: { n: 0, solid: 0, keys: new Set() }, // internal district plan slices
  }
}

function record(s, line, kind, mouthMin) {
  s.seams++
  const oc = openCount(line)
  if (oc === 0 && kind !== 'planned') s.sealed++
  if (kind !== 'planned' && oc < s.minOpen) s.minOpen = oc
  if (kind === 'open') {
    s.open.n++
    s.open.openSum += openFraction(line)
  } else if (kind === 'mouth') {
    s.mouth.n++
    if (longestOpenRun(line) >= mouthMin) s.mouth.withMouth++
  } else if (kind === 'office') {
    s.office.n++
    s.office.minDoors = Math.min(s.office.minDoors, oc)
    if (line[0] === 1 && line[CHUNK - 1] === 1) s.office.cornerWalls++
  } else {
    s.planned.n++
    if (oc === 0) s.planned.solid++
    s.planned.keys.add(openKey(line))
  }
}

// Audit an NX×NZ patch. `dataAt(cx,cz)` returns a ChunkData (with .zone + the
// vAt/hAt accessors) or null. Walks every internal seam once.
export function auditPatch(dataAt, X0, Z0, NX, NZ, config) {
  const s = blank()
  const mouthMin = config.border.mouthWidth[0]

  // Vertical seams (between cx and cx+1).
  for (let cz = Z0; cz < Z0 + NZ; cz++) {
    for (let cx = X0; cx < X0 + NX - 1; cx++) {
      const a = dataAt(cx, cz)
      const east = dataAt(cx + 1, cz)
      if (!a || !east) continue
      const line = vSeamLine(east)
      const kind = classifySeam(a.zone, east.zone, config, a, east)
      record(s, line, kind, mouthMin)
    }
  }

  // Horizontal seams (between cz and cz+1).
  for (let cx = X0; cx < X0 + NX; cx++) {
    for (let cz = Z0; cz < Z0 + NZ - 1; cz++) {
      const a = dataAt(cx, cz)
      const south = dataAt(cx, cz + 1)
      if (!a || !south) continue
      const line = hSeamLine(south)
      const kind = classifySeam(a.zone, south.zone, config, a, south)
      record(s, line, kind, mouthMin)
    }
  }

  // Single 0..1 "continuity score" for the HUD: each component defaults to 1
  // when not sampled, so an all-office or all-open patch still scores fairly.
  const r = (num, den) => (den > 0 ? num / den : 1)
  s.openness = r(s.open.openSum, s.open.n)
  s.mouthCoverage = r(s.mouth.withMouth, s.mouth.n)
  s.portalCoverage = s.office.n === 0 || s.office.minDoors >= 1 ? 1 : 0
  s.planVariety = r(s.planned.keys.size, s.planned.n)
  s.planned.patterns = s.planned.keys.size
  delete s.planned.keys
  s.score =
    (s.sealed === 0 ? 1 : 0) * 0.4 +
    s.openness * 0.2 +
    s.mouthCoverage * 0.2 +
    s.portalCoverage * 0.1 +
    s.planVariety * 0.1
  return s
}
