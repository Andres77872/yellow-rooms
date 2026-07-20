import { CHUNK } from '../../constants.js'
import { dressEdge } from './edges.js'
import { dressColumns } from './columns.js'
import { dressCeiling } from './ceiling.js'
import { dressTowerLandmarkSockets } from './towerSockets.js'

// Interior dressing and props — the "designed building" layer that sits
// between bare thin-wall geometry and the light field. Like the joinery
// builders this is THREE-free: pure functions turning ChunkData into
// unit-box instance descriptors, batched by mesh.js. Everything is
// deterministic from GLOBAL cell coordinates, so a chunk dresses identically
// across reloads.
//
// Returns { trim, props, signs }:
//   trim  : baseboards, crown molding, column bases/caps — batched with the
//           door/window casings (uniform trim paint, no per-instance tint).
//   props : tinted flat items — floor thresholds, radiators, clocks, notice
//           boards, extinguisher cabinets, ceiling vents. Each carries `tint`.
//   signs : emissive items — exit signs over doors, hanging blade signs.
//           These glow (and bloom) but cast no light: beacons, not lamps.
//
// Collision contract: the collision raster and navigation graph never learn
// about any of this. Everything either hugs an existing wall/column face
// (no prouder than the door casings the game already ships), lies flat on the
// floor below ankle height, or hangs above door-head height, so nothing can
// visibly swallow the player or fake a blocker.
export function collectInteriorDressing(data) {
  const trim = []
  const props = []
  const signs = []
  for (let z = 0; z < CHUNK; z++) {
    for (let lx = 0; lx < CHUNK; lx++) dressEdge(data, 'v', lx, z, trim, props, signs)
  }
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let x = 0; x < CHUNK; x++) dressEdge(data, 'h', lz, x, trim, props, signs)
  }
  dressColumns(data, trim)
  dressCeiling(data, props, signs)
  dressTowerLandmarkSockets(data, props, signs)
  return { trim, props, signs }
}

export { PROP_TINT, SIGN_TINT } from './palette.js'
