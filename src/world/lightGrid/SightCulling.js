import { CELL, CHUNK, FOG_DENSITY } from '../constants.js'
import { EDGE_WALL } from './gridSpec.js'

// Grid visibility culling (engine-improvement chapter 12 §4.4).
//
// Chunk streaming used to gate submission by FLOOR only: every same-floor
// chunk within LOAD_RADIUS (up to 9 x 9 = 81) was drawn, and only Three's
// frustum test removed batches — although in the walled families most of
// them sit behind several partitions, and a quarter are fully fogged.
//
// The thin-wall grid makes a conservative 2D visibility test cheap: a fan of
// rays from the eye walks cell edges (Amanatides–Woo) until a SOLID wall
// stops it or the fog is effectively opaque. Doors, windows and bridge rails
// are see-through at eye height, so only EDGE_WALL occludes. Every cell a ray
// visits marks its own chunk and its four neighbours' chunks (a one-cell
// margin), plus the chunk that owns the wall a ray stops at (walls are drawn
// by the chunk owning their line). The fan is omnidirectional, so turning in
// place never needs a recompute — only moving does.
//
// The flood runs on the eye's floor. ChunkManager uses it twice: directly
// for same-floor chunks, and to gate the cross-floor rules — a chunk seen
// through a stair aperture or a tall structure's void only renders while
// that opening's chunk is itself reachable by a sight line on this floor.

// Distance where exp^2 fog reaches 95% (render-coupling.test.js: silhouette
// removal may only happen at >= 95% fog).
export const SIGHT_FOG_DIST = Math.sqrt(-Math.log(0.05)) / FOG_DENSITY
// Chunks whose nearest point is this close to the eye are never culled.
export const SIGHT_NEAR_KEEP = 6
const RAYS = 720
const RECOMPUTE_MOVE = 0.75 // metres of eye travel before re-flooding

const key2 = (cx, cz) => (((cx + 0x8000) & 0xffff) << 16) | ((cz + 0x8000) & 0xffff)

export class SightCulling {
  constructor(grid, { rays = RAYS, maxDist = SIGHT_FOG_DIST } = {}) {
    this.grid = grid
    this.rays = rays
    this.maxDist = maxDist
    this.visible = new Set()
    this._x = NaN
    this._z = NaN
    this._cy = null
    this._dirty = true
    this.stats = { floods: 0, cells: 0, chunks: 0, ms: 0 }
    this._dirs = []
    for (let i = 0; i < rays; i++) {
      const a = ((i + 0.5) / rays) * Math.PI * 2
      this._dirs.push([Math.cos(a), Math.sin(a)])
    }
  }

  // Residency or level changed: the next update re-floods.
  invalidate() {
    this._dirty = true
  }

  // Re-flood if the eye moved enough, changed floor, or the world changed.
  // Returns true when the visible set was recomputed.
  update(ex, ez, cy, now = () => performance.now()) {
    const moved = Math.hypot(ex - this._x, ez - this._z)
    if (!this._dirty && cy === this._cy && moved < RECOMPUTE_MOVE) return false
    const t0 = now()
    this._flood(ex, ez, cy)
    this._x = ex
    this._z = ez
    this._cy = cy
    this._dirty = false
    this.stats.floods++
    this.stats.ms = now() - t0
    return true
  }

  chunkVisible(cx, cz) {
    return this.visible.has(key2(cx, cz))
  }

  // Floor the current visible set was flooded on (null before the first).
  get floor() {
    return this._cy
  }

  _flood(ex, ez, cy) {
    const vis = this.visible
    vis.clear()
    const grid = this.grid
    const markCell = (gx, gz) => {
      vis.add(key2(Math.floor(gx / CHUNK), Math.floor(gz / CHUNK)))
      vis.add(key2(Math.floor((gx - 1) / CHUNK), Math.floor(gz / CHUNK)))
      vis.add(key2(Math.floor((gx + 1) / CHUNK), Math.floor(gz / CHUNK)))
      vis.add(key2(Math.floor(gx / CHUNK), Math.floor((gz - 1) / CHUNK)))
      vis.add(key2(Math.floor(gx / CHUNK), Math.floor((gz + 1) / CHUNK)))
    }
    // Always keep everything within SIGHT_NEAR_KEEP of the eye.
    const keep = SIGHT_NEAR_KEEP
    for (let cz = Math.floor((ez - keep) / (CHUNK * CELL)); cz <= Math.floor((ez + keep) / (CHUNK * CELL)); cz++) {
      for (let cx = Math.floor((ex - keep) / (CHUNK * CELL)); cx <= Math.floor((ex + keep) / (CHUNK * CELL)); cx++) {
        vis.add(key2(cx, cz))
      }
    }
    const maxT = this.maxDist
    let cells = 0
    const gx0 = Math.floor(ex / CELL)
    const gz0 = Math.floor(ez / CELL)
    markCell(gx0, gz0)
    for (const [dx, dz] of this._dirs) {
      let gx = gx0
      let gz = gz0
      const stepX = dx > 0 ? 1 : -1
      const stepZ = dz > 0 ? 1 : -1
      let tMaxX = dx > 0 ? ((gx + 1) * CELL - ex) / dx : (gx * CELL - ex) / dx
      let tMaxZ = dz > 0 ? ((gz + 1) * CELL - ez) / dz : (gz * CELL - ez) / dz
      const tDeltaX = CELL / Math.abs(dx)
      const tDeltaZ = CELL / Math.abs(dz)
      for (;;) {
        let t
        if (tMaxX < tMaxZ) {
          t = tMaxX
          if (t > maxT) break
          const ex_ = stepX > 0 ? gx + 1 : gx // west edge of this cell is crossed
          if (grid._edge(0, ex_, gz, cy) === EDGE_WALL) {
            markCell(ex_, gz) // the wall's owner chunk draws it
            break
          }
          gx += stepX
          tMaxX += tDeltaX
        } else {
          t = tMaxZ
          if (t > maxT) break
          const ez_ = stepZ > 0 ? gz + 1 : gz
          if (grid._edge(1, gx, ez_, cy) === EDGE_WALL) {
            markCell(gx, ez_)
            break
          }
          gz += stepZ
          tMaxZ += tDeltaZ
        }
        markCell(gx, gz)
        cells++
      }
    }
    this.stats.cells = cells
    this.stats.chunks = vis.size
  }
}
