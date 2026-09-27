import { CHUNK, cIdx } from '../world/constants.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_STAIR,
  CELL_VOID,
  WALL_RAIL,
  WALL_WINDOW,
} from '../world/mapTypes.js'
import { holeMasks } from './holeMasks.js'

// Structure protection for the authoring tools. Generated multilevel
// geometry is only valid as a whole: a slab opening needs the same opening in
// the storey above, a bridge deck its guard rails, a stair its landing and
// exit. The editor cannot re-author those descriptors, so while protection
// is on the tools skip the cells and edges the descriptors own and report
// why. Every rule reads the document (never the planners), so imported and
// hand-edited maps are guarded the same way.

function locate(map, gx, cy, gz) {
  const d = map.chunkAt(Math.floor(gx / CHUNK), cy, Math.floor(gz / CHUNK))
  if (!d) return null
  const lx = gx - d.cx * CHUNK
  const lz = gz - d.cz * CHUNK
  return { d, i: cIdx(lx, lz) }
}

// A cell the floor tools (paint, erase, room, furniture) must not rewrite.
export function protectedCellReason(map, gx, cy, gz) {
  const at = locate(map, gx, cy, gz)
  if (!at) return null
  const { d, i } = at
  const m = holeMasks(d)
  if (m.floor[i]) return m.lethal[i] ? 'lethal drop' : 'slab opening'
  if (m.stair[i] || d.cellKind[i] === CELL_STAIR) return 'stair'
  const kind = d.cellKind[i]
  if (kind === CELL_BRIDGE) return 'bridge deck'
  if (kind === CELL_VOID) return 'void'
  if (kind === CELL_ATRIUM) return 'atrium hall'
  return null
}

// Ceiling fixtures cannot hang in an open slab.
export function protectedCeilingReason(map, gx, cy, gz) {
  const at = locate(map, gx, cy, gz)
  if (!at) return null
  return holeMasks(at.d).ceil[at.i] ? 'open ceiling' : null
}

// An edge the wall pen and eraser must not rewrite: guard rails, structure
// windows, and any edge bounding a slab opening, a stair strip (its guard
// walls and mouths keep the drop and the flight honest) or a structure-owned
// cell — a wall across a bridge deck or inside an atrium hall severs the
// volume even though no opening borders it.
export function protectedEdgeReason(map, axis, gx, gz, cy) {
  const e = axis === 'v' ? map.wallVAt(gx, cy, gz) : map.wallHAt(gx, cy, gz)
  if (e.wall && e.feature === WALL_RAIL) return 'guard rail'
  const owner = locate(map, gx, cy, gz)
  if (e.wall && e.feature === WALL_WINDOW && owner?.d.structure) return 'structure window'
  const sides = axis === 'v' ? [[gx - 1, gz], [gx, gz]] : [[gx, gz - 1], [gx, gz]]
  for (const [sx, sz] of sides) {
    const at = locate(map, sx, cy, sz)
    if (!at) continue
    const m = holeMasks(at.d)
    if (m.floor[at.i]) return 'edge of a slab opening'
    const kind = at.d.cellKind[at.i]
    if (m.stair[at.i] || kind === CELL_STAIR) return 'stair guard'
    if (kind === CELL_BRIDGE) return 'bridge deck'
    if (kind === CELL_ATRIUM || kind === CELL_VOID) return 'atrium'
  }
  return null
}

// First protected cell inside a global cell rectangle, if any.
export function protectedRectReason(map, rect, cy) {
  for (let gz = rect.z0; gz <= rect.z1; gz++) {
    for (let gx = rect.x0; gx <= rect.x1; gx++) {
      const reason = protectedCellReason(map, gx, cy, gz)
      if (reason) return { reason, gx, gz }
    }
  }
  return null
}
