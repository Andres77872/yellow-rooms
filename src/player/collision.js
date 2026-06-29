import { CELL, PLAYER_R, WALL_COL_HALF, COL_HALF, worldToCell } from '../world/constants.js'

const SKIN = 0.001

// Swept AABB collision against the thin-wall model, resolved one axis at a time
// so the player slides along walls. Walls live on cell EDGES (zero geometric
// width), so resolution tests the wall LINES the player's leading face crosses
// between its old and new position — knowing which side you came from is what
// makes zero-width walls correct. A small WALL_COL_HALF margin turns each line
// into a thin slab (kills diagonal corner-slip). Freestanding columns are
// resolved as AABBs in a second pass. The Engine sub-steps movement 5x, so |d|
// per call is well under CELL.
//
// Mutates `pos` in place; returns which axes were blocked.
export function moveAndCollide(cm, pos, dx, dz) {
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
        if (rowHasWallV(cm, L, gz0, gz1)) {
          pos.x = L * CELL - m - SKIN
          hit.x = true
          break
        }
      }
    } else {
      const L0 = Math.ceil((oldX - r) / CELL) - 1
      const L1 = Math.ceil((pos.x - r) / CELL)
      for (let L = L0; L >= L1; L--) {
        if (rowHasWallV(cm, L, gz0, gz1)) {
          pos.x = L * CELL + m + SKIN
          hit.x = true
          break
        }
      }
    }
    resolveColumns(cm, pos, r, true, dx, hit)
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
        if (colHasWallH(cm, L, gx0, gx1)) {
          pos.z = L * CELL - m - SKIN
          hit.z = true
          break
        }
      }
    } else {
      const L0 = Math.ceil((oldZ - r) / CELL) - 1
      const L1 = Math.ceil((pos.z - r) / CELL)
      for (let L = L0; L >= L1; L--) {
        if (colHasWallH(cm, L, gx0, gx1)) {
          pos.z = L * CELL + m + SKIN
          hit.z = true
          break
        }
      }
    }
    resolveColumns(cm, pos, r, false, dz, hit)
  }

  return hit
}

function rowHasWallV(cm, lineX, gz0, gz1) {
  for (let gz = gz0; gz <= gz1; gz++) if (cm.wallVAt(lineX, gz)) return true
  return false
}
function colHasWallH(cm, lineZ, gx0, gx1) {
  for (let gx = gx0; gx <= gx1; gx++) if (cm.wallHAt(gx, lineZ)) return true
  return false
}

// AABB-vs-column resolution along one axis (axisX = true -> push on X).
function resolveColumns(cm, pos, r, axisX, d, hit) {
  const reach = r + COL_HALF
  const cgx0 = worldToCell(pos.x - reach)
  const cgx1 = worldToCell(pos.x + reach)
  const cgz0 = worldToCell(pos.z - reach)
  const cgz1 = worldToCell(pos.z + reach)
  for (let cz = cgz0; cz <= cgz1; cz++) {
    for (let cx = cgx0; cx <= cgx1; cx++) {
      if (!cm.columnAt(cx, cz)) continue
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

// Line-of-sight via an Amanatides-Woo grid DDA: step cell to cell and block on
// the wall LINE crossed at each step. Replaces point-sampling, which would pass
// straight through zero-width walls. Endpoints' own cells are not tested.
export function hasLineOfSight(cm, x0, z0, x1, z1) {
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
  while ((gx !== gxe || gz !== gze) && guard++ < 4096) {
    if (tMaxX < tMaxZ) {
      if (cm.wallVAt(sx > 0 ? gx + 1 : gx, gz)) return false
      gx += sx
      tMaxX += tDeltaX
    } else {
      if (cm.wallHAt(gx, sz > 0 ? gz + 1 : gz)) return false
      gz += sz
      tMaxZ += tDeltaZ
    }
  }
  return true
}
