import { CELL, LAYER_H, layerY, worldToCell } from '../world/constants.js'
import { DEFAULT_MULTILEVEL_CONFIG } from '../world/multilevel.js'

// Walkable ground height for a feet point on layer `cy` (v8). Pure — shared by
// the player controller and the AI path follower, and unit-tested headless.
//
// Flat floors sit at cy*LAYER_H. Stair cells resolve through the canonical
// ChunkManager.stairAt descriptor:
//   'landing' — flat at the stair's base layer (== cy*LAYER_H when queried
//               from the lower layer, where landings live);
//   'run'/'hole' — the analytic ramp: the SAME world surface queried from the
//               lower layer (run, under the ceiling hole) or the upper layer
//               (hole, where the slab is open and the ramp IS the ground);
//   'exit' — ordinary upper floor (solid slab past the ramp top).
// The ramp is linear from the landing->run0 edge (t=0) to the run1->exit edge
// (t=1, flush with the upper floor), so walking stairs is continuous — no step
// pops; the rendered step boxes are visual detail over this surface.
export function groundHeightAt(cm, wx, wz, cy) {
  const gx = worldToCell(wx)
  const gz = worldToCell(wz)
  const s = cm.stairAt(gx, gz, cy)
  // A guarded shaft normally cannot be entered. If debug teleportation or
  // malformed external state puts a body there, fall through every aligned
  // aperture to the first real deck/bottom hall instead of inventing a floor
  // one storey below. The generator hard-caps structures at ten levels.
  if (!s) {
    let supportCy = cy
    let remaining = DEFAULT_MULTILEVEL_CONFIG.maxLevels
    while (remaining-- > 0 && cm.floorHoleAt?.(gx, gz, supportCy)) supportCy--
    return layerY(supportCy)
  }
  if (s.part === 'landing') return layerY(s.baseCy)
  if (s.part === 'exit') return layerY(s.baseCy + 1)
  const along = s.axis === 'x' ? wx : wz
  const t = Math.min(1, Math.max(0, (s.sign * (along - s.rampStart)) / (2 * CELL)))
  return layerY(s.baseCy) + t * LAYER_H
}
