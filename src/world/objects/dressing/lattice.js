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
  CELL_VOID,
  SPACE_ROLE_SERVER,
  WALL_PLAIN,
  WALL_RAIL,
} from '../../mapTypes.js'
import { ZONE_SERVICE } from '../../surfaceSet.js'
import { hash2i } from '../../core/hash.js'
import { safetyCell, signCell, wayfindingCell } from '../../decalKinds.js'
import { ACCENT_CYCLE, LATTICE_TINT } from './palette.js'
import { arrowLabel, faceKey, plateFace, pushPlate, signagePlan, storeyNumber } from './notices.js'
import { dressDoorExits, dressStairExits } from './edges.js'

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
const LEVEL_STEP = 6 // cells between the storey plates along a core wall
const NOTICE_SALT = 0x1a77
const POST_S = 0.09
const KICK_H = 0.05

export function collectLatticeDressing(data) {
  const trim = []
  const props = []
  const signs = []
  const decals = []
  const structure = data.structure
  // The escape route reads as in every built family: exit signs over its fire
  // doors and at the stair mouths (edges.js).
  const plan = signagePlan(data)
  dressDoorExits(data, plan, signs)
  dressStairExits(data, plan, signs)
  if (!structure?.anchors) {
    latticeNotices(data, props, decals, plan)
    return { trim, props, signs, decals }
  }

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

  latticeNotices(data, props, decals, plan)
  return { trim, props, signs, decals }
}

// Level plates, safety notices and wayfinding arrows on the plain core walls
// (never over a void or an atrium drop, beside the stair flight or where a
// door leaf opens flat — notices.js plateFace), each by place rather than by
// dice: the storey's LEVEL plate (its number set from data.cy) at the stair
// ends and on a fixed cadence along the core, fall-hazard notices where the
// deck meets the drop, keep-clear notices at the stairs, authorised-only
// (high voltage at the switch rooms) on plant-room walls, and arrows that
// follow the walk to this storey's stairs.
function latticeNotices(data, props, decals, plan = signagePlan(data)) {
  const chunkGx = data.cx * CHUNK
  const chunkGz = data.cz * CHUNK
  const cy = data.cy | 0
  const level = signCell('level', data.mapFamily)
  const kindAt = (lx, lz) => (lx >= 0 && lx < CHUNK && lz >= 0 && lz < CHUNK ? data.cellKind[cIdx(lx, lz)] : -1)
  const walkable = (lx, lz) => {
    if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK) return false
    return data.cellKind[cIdx(lx, lz)] !== CELL_ATRIUM && !data.hasFloorHole(lx, lz)
  }
  const drop = (lx, lz) => {
    const k = kindAt(lx, lz)
    return k === CELL_ATRIUM || k === CELL_VOID || k === CELL_BRIDGE || (k >= 0 && data.hasFloorHole(lx, lz))
  }
  const exposed = (lx, lz) => drop(lx - 1, lz) || drop(lx + 1, lz) || drop(lx, lz - 1) || drop(lx, lz + 1)
  const notice = (vertical, line, cell) => {
    const gx = chunkGx + (vertical ? line : cell)
    const gz = chunkGz + (vertical ? cell : line)
    const plane = line * CELL
    const along = (cell + 0.5) * CELL
    for (const side of [-1, 1]) {
      const lx = vertical ? line + (side > 0 ? 0 : -1) : cell
      const lz = vertical ? cell : line + (side > 0 ? 0 : -1)
      if (!walkable(lx, lz) || !plateFace(data, plan, vertical, line, cell, side)) continue
      const r = hash2i(NOTICE_SALT ^ (side > 0 ? 0x11 : 0x22), gx, gz) / 4294967296
      const stairEnd = plan.levelFaces.has(faceKey(vertical ? 'v' : 'h', line, cell, side))
      const cadence = (((vertical ? gz : gx) % LEVEL_STEP) + LEVEL_STEP) % LEVEL_STEP === (side > 0 ? 0 : LEVEL_STEP >> 1)
      if (level >= 0 && (stairEnd || (cadence && r < 0.35))) {
        pushPlate(decals, props, vertical, plane, side, along, 1.9, 0.6, 0.2, level, { rough: 0.5, number: data.levelLabel ?? storeyNumber(cy) })
      } else if (exposed(lx, lz) && r < 0.25) {
        pushPlate(decals, null, vertical, plane, side, along, 1.5, 0.3, 0.4, safetyCell('fallHazard'), { rough: 0.6 })
      } else if (r < 0.2 && (plan.nearStair(lx, lz) || plan.ctxAt(lx, lz).category === ZONE_SERVICE)) {
        const ctx = plan.ctxAt(lx, lz)
        const id = ctx.category !== ZONE_SERVICE ? 'doNotBlock' : ctx.role === SPACE_ROLE_SERVER ? 'highVoltage' : 'authorized'
        pushPlate(decals, null, vertical, plane, side, along, 1.5, 0.3, 0.4, safetyCell(id), { rough: 0.6 })
      } else if (r < 0.04) {
        const arrow = plan.arrow(vertical, side, lx, lz)
        if (arrow) pushPlate(decals, null, vertical, plane, side, along, 2.1, 0.75, 0.25, wayfindingCell(arrowLabel(cy, arrow.target), arrow.dir), { rough: 0.5 })
      }
    }
  }
  for (let lx = 1; lx < CHUNK; lx++) {
    for (let z = 0; z < CHUNK; z++) {
      const i = vIdx(lx, z)
      if (data.wallV[i] === 1 && data.wallFeatureV[i] === WALL_PLAIN) notice(true, lx, z)
    }
  }
  for (let lz = 1; lz < CHUNK; lz++) {
    for (let x = 0; x < CHUNK; x++) {
      const i = hIdx(x, lz)
      if (data.wallH[i] === 1 && data.wallFeatureH[i] === WALL_PLAIN) notice(false, lz, x)
    }
  }
}
