import {
  BRIDGE_GUARD_H,
  CELL,
  CHUNK,
  THICK,
  WALL_H,
  cIdx,
  vIdx,
  hIdx,
} from '../../constants.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  WALL_RAIL,
} from '../../mapTypes.js'
import { ACCENT_CYCLE, LATTICE_TINT } from './palette.js'

// Lattice dressing — the exposed-steel span language the family was missing:
// rail posts and kick plates so decks read as built gantries, deck seam
// strips on the boundary-cue cadence the wayfinding research asks for, hazard
// plates where the deep-exposure pier makes a fall lethal from further up,
// and ONE lit accent beacon per pier — the per-chamber landmark socket, so a
// 5×5 grid of identical pads becomes a grid of nameable places.
//
// Same contract as every dressing layer: THREE-free unit boxes, deterministic
// from global coordinates, collision-free by construction.

const SEAM_STEP = 4 // cells between deck seams (< the 8-cell boundary-cue cap)
const POST_S = 0.09
const KICK_H = 0.05

export function collectLatticeDressing(data) {
  const trim = []
  const props = []
  const signs = []
  const structure = data.structure
  if (!structure?.anchors) return { trim, props, signs }

  const kindAt = (lx, lz) =>
    lx >= 0 && lx < CHUNK && lz >= 0 && lz < CHUNK
      ? data.cellKind[cIdx(lx, lz)]
      : -1

  // The deep-exposure pier: falls near it are lethal from far higher, so its
  // rails wear hazard paint — the visible difference between a 5 m and a 20 m
  // drop that used to be pure invisible data.
  const chunkGx = data.cx * CHUNK
  const chunkGz = data.cz * CHUNK
  const maxExposure = Math.max(
    ...structure.anchors.map((a) => a.exposureM ?? 0)
  )
  const deepAnchors = structure.anchors.filter(
    (a) => (a.exposureM ?? 0) === maxExposure && maxExposure > 5
  )
  const nearDeepExposure = (lx, lz) => deepAnchors.some((a) =>
    Math.max(Math.abs(a.gx - (chunkGx + lx)), Math.abs(a.gz - (chunkGz + lz))) <= 2
  )

  // Rail posts + kick plates along every guard rail.
  const postAt = new Set()
  const post = (x, z) => {
    const key = `${x},${z}`
    if (postAt.has(key)) return
    postAt.add(key)
    trim.push({
      px: x, py: (BRIDGE_GUARD_H + 0.14) / 2, pz: z,
      sx: POST_S, sy: BRIDGE_GUARD_H + 0.14, sz: POST_S,
    })
  }
  for (let z = 0; z < CHUNK; z++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      if (data.wallV[vIdx(lx, z)] !== 1) continue
      if (data.wallFeatureV[vIdx(lx, z)] !== WALL_RAIL) continue
      post(lx * CELL, z * CELL)
      post(lx * CELL, (z + 1) * CELL)
      props.push({
        px: lx * CELL, py: KICK_H / 2, pz: (z + 0.5) * CELL,
        sx: THICK + 0.08, sy: KICK_H, sz: CELL,
        tint: nearDeepExposure(lx, z) ? LATTICE_TINT.hazard : LATTICE_TINT.kick,
      })
    }
  }
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let x = 0; x < CHUNK; x++) {
      if (data.wallH[hIdx(x, lz)] !== 1) continue
      if (data.wallFeatureH[hIdx(x, lz)] !== WALL_RAIL) continue
      post(x * CELL, lz * CELL)
      post((x + 1) * CELL, lz * CELL)
      props.push({
        px: (x + 0.5) * CELL, py: KICK_H / 2, pz: lz * CELL,
        sx: CELL, sy: KICK_H, sz: THICK + 0.08,
        tint: nearDeepExposure(x, lz) ? LATTICE_TINT.hazard : LATTICE_TINT.kick,
      })
    }
  }

  // Deck seam strips: a dark plate line across the walk direction every
  // SEAM_STEP global cells — the boundary cue that keeps a long span from
  // becoming a cue-less open field.
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      if (kindAt(lx, lz) !== CELL_BRIDGE) continue
      const gx = chunkGx + lx
      const gz = chunkGz + lz
      const alongX = kindAt(lx - 1, lz) === CELL_BRIDGE || kindAt(lx + 1, lz) === CELL_BRIDGE
      const g = alongX ? gx : gz
      if (((g % SEAM_STEP) + SEAM_STEP) % SEAM_STEP !== 0) continue
      props.push(alongX
        ? { px: (lx + 0.5) * CELL, py: 0.015, pz: (lz + 0.5) * CELL, sx: 0.16, sy: 0.03, sz: CELL, tint: LATTICE_TINT.seam }
        : { px: (lx + 0.5) * CELL, py: 0.015, pz: (lz + 0.5) * CELL, sx: CELL, sy: 0.03, sz: 0.16, tint: LATTICE_TINT.seam })
    }
  }

  // Pier landmarks: each anchor on this floor gets corner cap trim and one
  // lit accent bollard, coloured from the anchor's own identity.
  for (const anchor of structure.anchors) {
    if (anchor.levelCy !== data.cy) continue
    const lx = anchor.gx - chunkGx
    const lz = anchor.gz - chunkGz
    if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK) continue
    if (kindAt(lx, lz) !== CELL_ATRIUM) continue
    const cx = (lx + 0.5) * CELL
    const cz = (lz + 0.5) * CELL
    const accent = ACCENT_CYCLE[anchor.id % ACCENT_CYCLE.length]
    // Bollard beacon: dark base, glowing head band.
    props.push({ px: cx, py: 0.45, pz: cz, sx: 0.24, sy: 0.9, sz: 0.24, tint: LATTICE_TINT.post })
    signs.push({ px: cx, py: 0.98, pz: cz, sx: 0.28, sy: 0.16, sz: 0.28, tint: accent })
    props.push({ px: cx, py: 1.09, pz: cz, sx: 0.3, sy: 0.06, sz: 0.3, tint: LATTICE_TINT.cap })
    // Ceiling cap plate over the pier centre when the pier still has a roof.
    if (!data.hasCeilHole(lx, lz)) {
      props.push({ px: cx, py: WALL_H - 0.05, pz: cz, sx: 1.4, sy: 0.1, sz: 1.4, tint: LATTICE_TINT.cap })
    }
  }

  return { trim, props, signs }
}
