import { CELL, CHUNK } from '../../constants.js'
import { dressEdge, dressStairExits } from './edges.js'
import { pushPlate, signagePlan } from './notices.js'
import { collectWallTrim } from '../wallShell.js'
import { dressColumns } from './columns.js'
import { dressCeiling } from './ceiling.js'
import { dressTowerLandmarkSockets } from './towerSockets.js'
import { collectSewerDressing } from './sewer.js'
import { collectLatticeDressing } from './lattice.js'
import { collectTowerExtras } from './tower.js'
import { MAP_FAMILY_LATTICE, MAP_FAMILY_SEWER, MAP_FAMILY_TOWER } from '../../mapTypes.js'
import { dressingOf } from '../../families/registry.js'
import { familyPlates } from '../../families/plates.js'
import { signCell } from '../../decalKinds.js'

// Interior dressing and props — the "designed building" layer that sits
// between bare thin-wall geometry and the light field. Like the joinery
// builders this is THREE-free: pure functions turning ChunkData into
// unit-box instance descriptors, batched by mesh.js. Everything is
// deterministic from GLOBAL cell coordinates, so a chunk dresses identically
// across reloads.
//
// Returns { trim, props, signs, decals }:
//   trim  : baseboards and crown molding (per wall RUN, wrapping corners and
//           free ends — objects/wallShell.js), column bases/caps — batched
//           with the door/window casings (uniform trim paint, no tint).
//   props : tinted flat items — floor thresholds, radiators, clocks, notice
//           boards, extinguisher cabinets, ceiling vents. Each carries `tint`.
//   signs : emissive items — exit signs over fire doors and at the stair
//           ends, hanging blade signs.
//           These glow (and bloom) but cast no light: beacons, not lamps.
//   decals: printed plates (posters, notices, plans, dials, room signs) —
//           cells of the world's decal atlas (world/decalKinds.js).
//
// Collision contract: the collision raster and navigation graph never learn
// about any of this. Everything either hugs an existing wall/column face
// (no prouder than the door casings the game already ships), lies flat on the
// floor below ankle height, or hangs above door-head height, so nothing can
// visibly swallow the player or fake a blocker.
export function collectInteriorDressing(data) {
  // Family dispatch: Sewer and Lattice replace the office layer wholesale —
  // buried infrastructure and exposed steelwork must not inherit radiators,
  // clocks, and crown molding. Tower keeps the office layer (its fabric IS an
  // office tower) plus its own deck/floor-identity extras.
  // A liminal family dresses with its record's layer (§5.1); 'none' is bare.
  const dressing = dressingOf(data.mapFamily)
  if (dressing === 'none') return { trim: [], props: [], signs: [], decals: [] }
  if (dressing === MAP_FAMILY_SEWER) return collectSewerDressing(data)
  if (dressing === MAP_FAMILY_LATTICE) return collectLatticeDressing(data)

  const trim = collectWallTrim(data)
  const props = []
  const signs = []
  const decals = []
  // One signage plan per chunk: every wall face chooses from the same room
  // contexts, door classes and stair ends.
  const plan = signagePlan(data)
  for (let z = 0; z < CHUNK; z++) {
    for (let lx = 0; lx < CHUNK; lx++) dressEdge(data, 'v', lx, z, props, signs, decals, plan)
  }
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let x = 0; x < CHUNK; x++) dressEdge(data, 'h', lz, x, props, signs, decals, plan)
  }
  dressStairExits(data, plan, signs)
  dressColumns(data, trim)
  dressCeiling(data, props, signs)
  dressTowerLandmarkSockets(data, props, signs)
  if (dressing === MAP_FAMILY_TOWER) collectTowerExtras(data, props, signs)
  dressFamilyPlates(data, plan, trim, props, signs, decals)
  return { trim, props, signs, decals }
}

// Family-declared plates (families/plates.js): car numbers, station names,
// gate numbers — signage a liminal family keeps as data. Legacy families
// declare none, so this adds nothing to their dressing. A descriptor with a
// `pick` group is one of several alternative faces: the first whose box is
// clear of everything already emitted is drawn, the rest of the group not.
const PLATE_CLEAR = 0.05
function dressFamilyPlates(data, plan, trim, props, signs, decals) {
  const plates = familyPlates(data, plan)
  if (!plates.length) return
  const done = new Set()
  for (const p of plates) {
    if (p.pick !== undefined && done.has(p.pick)) continue
    const cell = signCell(p.sign, data.mapFamily)
    if (cell < 0) continue
    if (p.pick !== undefined) {
      const at = []
      pushPlate(at, null, p.axis === 'v', p.line * CELL, p.side, (p.cell + 0.5) * CELL, p.y, p.w, p.h, cell, { base: p.base })
      if ([trim, props, signs, decals].some((list) => list.some((b) => boxesMeet(at[0], b)))) continue
      done.add(p.pick)
    }
    pushPlate(decals, props, p.axis === 'v', p.line * CELL, p.side, (p.cell + 0.5) * CELL, p.y, p.w, p.h, cell, { base: p.base, rough: 0.45, number: p.number })
  }
}

const boxesMeet = (a, b) =>
  Math.abs(a.px - b.px) * 2 < a.sx + b.sx + PLATE_CLEAR * 2 &&
  Math.abs(a.py - b.py) * 2 < a.sy + b.sy + PLATE_CLEAR * 2 &&
  Math.abs(a.pz - b.pz) * 2 < a.sz + b.sz + PLATE_CLEAR * 2

export { PROP_TINT, SIGN_TINT } from './palette.js'
