import {
  CELL,
  PLAYER_R,
  WALL_COL_HALF,
  COL_HALF,
  MAX_COL_HALF,
  worldToCell,
} from '../world/constants.js'

const SKIN = 0.001

// Swept AABB collision against the thin-wall model, resolved one axis at a time
// so the player slides along walls. Walls live on cell EDGES (zero geometric
// width), so resolution tests the wall LINES the player's leading face crosses
// between its old and new position — knowing which side you came from is what
// makes zero-width walls correct. A small WALL_COL_HALF margin turns each line
// into a thin slab. Freestanding columns are resolved as AABBs in a second pass.
// The Engine sub-steps movement 5x, so |d| per call is well under CELL.
//
// The swept passes only test walls the LEADING face crosses along the axis being
// moved, so they can't catch a wall that ends up overlapping the box from the
// SIDE (perpendicular to the move) — strafing along a wall, or rounding a wall
// end / doorway jamb, where a wall segment begins beside you. A final
// minimum-translation push-out (`depenetrate`) ejects the box from any slab or
// column it still overlaps, so the player can never finish a step embedded in —
// or tunnelled through — geometry. CELL >> 2*(PLAYER_R+WALL_COL_HALF), so at most
// one wall per axis can overlap and the push-out converges in a couple of passes.
//
// Mutates `pos` in place; returns which axes were blocked.
export function moveAndCollide(cm, pos, dx, dz, cy = 0) {
  const hit = { x: false, z: false }
  const r = PLAYER_R
  const m = r + WALL_COL_HALF

  // --- X axis ---
  if (dx !== 0) {
    const oldX = pos.x
    pos.x += dx
    const gz0 = worldToCell(pos.z - r + SKIN)
    const gz1 = worldToCell(pos.z + r - SKIN)
    if (dx > 0) {
      const L0 = Math.floor((oldX + r) / CELL) + 1
      const L1 = Math.floor((pos.x + r) / CELL)
      for (let L = L0; L <= L1; L++) {
        if (rowHasWallV(cm, L, gz0, gz1, cy)) {
          pos.x = L * CELL - m - SKIN
          hit.x = true
          break
        }
      }
    } else {
      const L0 = Math.ceil((oldX - r) / CELL) - 1
      const L1 = Math.ceil((pos.x - r) / CELL)
      for (let L = L0; L >= L1; L--) {
        if (rowHasWallV(cm, L, gz0, gz1, cy)) {
          pos.x = L * CELL + m + SKIN
          hit.x = true
          break
        }
      }
    }
    resolveColumns(cm, pos, r, true, dx, hit, cy)
  }

  // --- Z axis ---
  if (dz !== 0) {
    const oldZ = pos.z
    pos.z += dz
    const gx0 = worldToCell(pos.x - r + SKIN)
    const gx1 = worldToCell(pos.x + r - SKIN)
    if (dz > 0) {
      const L0 = Math.floor((oldZ + r) / CELL) + 1
      const L1 = Math.floor((pos.z + r) / CELL)
      for (let L = L0; L <= L1; L++) {
        if (colHasWallH(cm, L, gx0, gx1, cy)) {
          pos.z = L * CELL - m - SKIN
          hit.z = true
          break
        }
      }
    } else {
      const L0 = Math.ceil((oldZ - r) / CELL) - 1
      const L1 = Math.ceil((pos.z - r) / CELL)
      for (let L = L0; L >= L1; L--) {
        if (colHasWallH(cm, L, gx0, gx1, cy)) {
          pos.z = L * CELL + m + SKIN
          hit.z = true
          break
        }
      }
    }
    resolveColumns(cm, pos, r, false, dz, hit, cy)
  }

  depenetrate(cm, pos, hit, cy)
  return hit
}

function rowHasWallV(cm, lineX, gz0, gz1, cy) {
  for (let gz = gz0; gz <= gz1; gz++) if (cm.wallVAt(lineX, gz, cy)) return true
  return false
}
function colHasWallH(cm, lineZ, gx0, gx1, cy) {
  for (let gx = gx0; gx <= gx1; gx++) if (cm.wallHAt(gx, lineZ, cy)) return true
  return false
}

// Runtime ChunkManager exposes exact column half-widths. Small test doubles and
// older callers only expose the boolean query, for which the original width is
// the compatible fallback.
function columnHalfAt(cm, gx, gz, cy) {
  if (cm.columnHalfAt) return cm.columnHalfAt(gx, gz, cy) || 0
  return cm.columnAt(gx, gz, cy) ? COL_HALF : 0
}

// Exact segment-vs-column AABB test for cells crossed by the LOS DDA. The DDA
// alone only knows which cell a ray visits; this slab test preserves clear rays
// through the generous bays around a pier while preventing the new 2.2u
// monumental supports from becoming invisible to AI, fog reveal, or path
// smoothing.
function segmentHitsColumn(cm, gx, gz, cy, x0, z0, x1, z1) {
  const half = columnHalfAt(cm, gx, gz, cy)
  if (!half) return false
  const cx = (gx + 0.5) * CELL
  const cz = (gz + 0.5) * CELL
  const dx = x1 - x0
  const dz = z1 - z0
  let near = 0
  let far = 1
  const clip = (origin, delta, lo, hi) => {
    if (Math.abs(delta) < 1e-9) return origin > lo && origin < hi
    let a = (lo - origin) / delta
    let b = (hi - origin) / delta
    if (a > b) [a, b] = [b, a]
    near = Math.max(near, a)
    far = Math.min(far, b)
    return near < far
  }
  return clip(x0, dx, cx - half, cx + half) &&
    clip(z0, dz, cz - half, cz + half) &&
    far > 1e-6 && near < 1 - 1e-6
}

// AABB-vs-column resolution along one axis (axisX = true -> push on X).
function resolveColumns(cm, pos, r, axisX, d, hit, cy) {
  const scanReach = r + MAX_COL_HALF
  const cgx0 = worldToCell(pos.x - scanReach)
  const cgx1 = worldToCell(pos.x + scanReach)
  const cgz0 = worldToCell(pos.z - scanReach)
  const cgz1 = worldToCell(pos.z + scanReach)
  for (let cz = cgz0; cz <= cgz1; cz++) {
    for (let cx = cgx0; cx <= cgx1; cx++) {
      const half = columnHalfAt(cm, cx, cz, cy)
      if (!half) continue
      const reach = r + half
      const ccx = (cx + 0.5) * CELL
      const ccz = (cz + 0.5) * CELL
      if (Math.abs(pos.x - ccx) >= reach || Math.abs(pos.z - ccz) >= reach) continue
      if (axisX) {
        pos.x = d > 0 ? ccx - reach - SKIN : ccx + reach + SKIN
        hit.x = true
      } else {
        pos.z = d > 0 ? ccz - reach - SKIN : ccz + reach + SKIN
        hit.z = true
      }
    }
  }
}

// Final-position depenetration. Each iteration finds the single deepest overlap
// of the player AABB with a wall slab (half WALL_COL_HALF) or column (half
// COL_HALF) and pushes the box out to that surface along the minimal axis, to the
// side the centre is already on. Flags `hit` so Controller.step kills the velocity
// component (else the player re-accelerates straight back into the wall). Breaks
// as soon as nothing overlaps beyond SKIN — which is the common case, so this is
// usually a single cheap scan. Walls are spaced CELL apart and CELL >> 2*reach, so
// constraints never conflict and it settles in 1-2 iterations.
function depenetrate(cm, pos, hit, cy) {
  const r = PLAYER_R
  const m = r + WALL_COL_HALF
  const scanReach = r + MAX_COL_HALF
  for (let iter = 0; iter < 4; iter++) {
    let best = SKIN
    let axis = 0 // 1 = push X, 2 = push Z
    let push = 0

    // Vertical walls (block X) overlapping the box's z-rows.
    const gz0 = worldToCell(pos.z - r + SKIN)
    const gz1 = worldToCell(pos.z + r - SKIN)
    for (let gx = worldToCell(pos.x - m); gx <= worldToCell(pos.x + m); gx++) {
      const wx = gx * CELL
      const xpen = m - Math.abs(pos.x - wx)
      if (xpen <= best) continue
      if (rowHasWallV(cm, gx, gz0, gz1, cy)) {
        best = xpen
        axis = 1
        push = pos.x >= wx ? wx + m + SKIN : wx - m - SKIN
      }
    }

    // Horizontal walls (block Z) overlapping the box's x-columns.
    const gx0 = worldToCell(pos.x - r + SKIN)
    const gx1 = worldToCell(pos.x + r - SKIN)
    for (let gz = worldToCell(pos.z - m); gz <= worldToCell(pos.z + m); gz++) {
      const wz = gz * CELL
      const zpen = m - Math.abs(pos.z - wz)
      if (zpen <= best) continue
      if (colHasWallH(cm, gz, gx0, gx1, cy)) {
        best = zpen
        axis = 2
        push = pos.z >= wz ? wz + m + SKIN : wz - m - SKIN
      }
    }

    // Freestanding columns (AABB) — eject along the shallower-overlap axis (MTV).
    for (let cz = worldToCell(pos.z - scanReach); cz <= worldToCell(pos.z + scanReach); cz++) {
      for (let cx = worldToCell(pos.x - scanReach); cx <= worldToCell(pos.x + scanReach); cx++) {
        const half = columnHalfAt(cm, cx, cz, cy)
        if (!half) continue
        const reach = r + half
        const ccx = (cx + 0.5) * CELL
        const ccz = (cz + 0.5) * CELL
        const ox = reach - Math.abs(pos.x - ccx)
        const oz = reach - Math.abs(pos.z - ccz)
        if (ox <= SKIN || oz <= SKIN) continue // not overlapping
        if (ox <= oz) {
          if (ox > best) { best = ox; axis = 1; push = pos.x >= ccx ? ccx + reach + SKIN : ccx - reach - SKIN }
        } else if (oz > best) {
          best = oz
          axis = 2
          push = pos.z >= ccz ? ccz + reach + SKIN : ccz - reach - SKIN
        }
      }
    }

    if (axis === 1) {
      pos.x = push
      hit.x = true
    } else if (axis === 2) {
      pos.z = push
      hit.z = true
    } else break
  }
}

// Line-of-sight via an Amanatides-Woo grid DDA: step cell to cell and block on
// the wall LINE crossed at each step. Replaces point-sampling, which would pass
// straight through zero-width walls. Endpoints' own cells are not tested.
export function hasLineOfSight(cm, x0, z0, x1, z1, cy = 0) {
  let gx = worldToCell(x0)
  let gz = worldToCell(z0)
  const gxe = worldToCell(x1)
  const gze = worldToCell(z1)
  const dx = x1 - x0
  const dz = z1 - z0
  const sx = Math.sign(dx)
  const sz = Math.sign(dz)
  const tDeltaX = dx !== 0 ? Math.abs(CELL / dx) : Infinity
  const tDeltaZ = dz !== 0 ? Math.abs(CELL / dz) : Infinity
  let tMaxX =
    dx !== 0 ? (sx > 0 ? (gx + 1) * CELL - x0 : x0 - gx * CELL) / Math.abs(dx) : Infinity
  let tMaxZ =
    dz !== 0 ? (sz > 0 ? (gz + 1) * CELL - z0 : z0 - gz * CELL) / Math.abs(dz) : Infinity
  let guard = 0
  let startCell = true
  while ((gx !== gxe || gz !== gze) && guard++ < 4096) {
    // Match the historical endpoint policy: the observer and target cells are
    // not self-occluding. Every intermediate cell is tested at true pier size.
    if (!startCell && segmentHitsColumn(cm, gx, gz, cy, x0, z0, x1, z1)) return false
    startCell = false
    if (tMaxX < tMaxZ) {
      const line = sx > 0 ? gx + 1 : gx
      if (cm.opaqueVAt ? cm.opaqueVAt(line, gz, cy) : cm.wallVAt(line, gz, cy)) return false
      gx += sx
      tMaxX += tDeltaX
    } else {
      const line = sz > 0 ? gz + 1 : gz
      if (cm.opaqueHAt ? cm.opaqueHAt(gx, line, cy) : cm.wallHAt(gx, line, cy)) return false
      gz += sz
      tMaxZ += tDeltaZ
    }
  }
  return true
}
