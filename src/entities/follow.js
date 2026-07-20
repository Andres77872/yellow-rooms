import { CELL, worldToCell } from '../world/constants.js'
import { findPath, followPath, edgeOpen, cellBlocked } from '../world/pathfind.js'

// Shared route-following brain for enemies that chase a moving target through
// the stair-aware grid A*. The Stalker and the Pursuer used to each own a copy
// of the same buffer/cursor/repath-timer plumbing; this collapses both into one
// tested implementation and adds two follow-quality upgrades:
//   - GOAL DRIFT: a route is recomputed as soon as the live target has moved
//     more than `driftCells` from the cell the route was computed to (or hopped
//     floors), instead of only on the fixed cadence — the enemy cuts the corner
//     the player just turned rather than walking to a stale cell first.
//   - ADAPTIVE CADENCE: within `nearCells` of the target the repath throttle
//     halves (`repathNear`), so close-quarters tracking hugs the player's real
//     route; far away the full interval keeps the A* cost where it was.
export class PathFollower {
  constructor(cm, opts = {}) {
    this.cm = cm
    this.configure(opts)
    this._buf = []
    this._len = 0 // path.length while valid, else 0
    this._cursor = 0 // current waypoint index
    this._repathT = 0
    this._goalGX = 0 // cell the current route was computed TO
    this._goalGZ = 0
    this._goalCy = 0
    // Reused result object (consumed immediately by the caller each step).
    this._r = { hasPath: false, stair: false, done: false, repathed: false }
  }

  configure({ leash = 22, maxNodes = 1200, repathEvery = 0.5, driftCells = 2, nearCells = 5 } = {}) {
    this.leash = leash
    this.maxNodes = maxNodes
    this.repathEvery = repathEvery
    this.repathNear = repathEvery * 0.5
    this.driftCells = driftCells
    this.nearCells = nearCells
  }

  get hasPath() {
    return this._len > 0
  }

  // Drop the route and the throttle (teleport, mode switch, forced repath):
  // the next step() recomputes immediately.
  reset() {
    this._len = 0
    this._cursor = 0
    this._repathT = 0
  }

  // Has the live target left the cell neighbourhood this route leads to?
  _drifted(tgx, tgz, tcy) {
    return (
      tcy !== this._goalCy ||
      Math.max(Math.abs(tgx - this._goalGX), Math.abs(tgz - this._goalGZ)) > this.driftCells
    )
  }

  // One follow tick: (re)route toward world (tx,tz) on floor tcy when the
  // current route is consumed/stale/drifted, then advance `ent` (pos mutated in
  // place, .cy flipped at stair waypoints) by `step` world units (followPath
  // applies the ramp slow-down itself). Returns a REUSED status object
  // { hasPath, stair, done, repathed }.
  step(ent, dt, tx, tz, tcy, step) {
    const r = this._r
    this._repathT -= dt
    const tgx = worldToCell(tx)
    const tgz = worldToCell(tz)
    const consumed = this._len === 0 || this._cursor * 3 >= this._len
    r.repathed = false
    if (consumed || this._repathT <= 0 || this._drifted(tgx, tgz, tcy)) {
      const p = findPath(this.cm, ent.pos.x, ent.pos.z, ent.cy, tx, tz, tcy, {
        out: this._buf,
        leash: this.leash,
        maxNodes: this.maxNodes,
      })
      this._len = p ? p.length : 0
      this._cursor = 0
      const near =
        Math.max(Math.abs(tgx - worldToCell(ent.pos.x)), Math.abs(tgz - worldToCell(ent.pos.z))) <=
          this.nearCells && tcy === ent.cy
      this._repathT = near ? this.repathNear : this.repathEvery
      this._goalGX = tgx
      this._goalGZ = tgz
      this._goalCy = tcy
      r.repathed = true
    }
    r.hasPath = this._len > 0
    r.stair = false
    r.done = false
    if (this._len > 0) {
      const f = followPath(this.cm, ent, this._buf, this._cursor, step)
      this._cursor = f.i
      r.stair = f.stair
      r.done = f.done
    }
    return r
  }
}

// Where did a fleeing player most likely go? From cell (gx,gz) on floor cy,
// walk toward the point `maxSteps` cells along the escape bearing (dirX,dirZ),
// one open 4-edge at a time — larger remaining axis first, other axis as the
// fallback when a wall blocks, stop when boxed in. Returns the farthest
// reachable {gx,gz}: the "search ahead" cell an enemy checks after arriving at
// the last-seen spot with no sight, so it follows around the corner instead of
// giving up on the player's doorstep. Pure and allocation-light for testing.
export function extrapolateSearch(cm, gx, gz, cy, dirX, dirZ, maxSteps = 6) {
  const d = Math.hypot(dirX, dirZ)
  if (!(d > 1e-6) || maxSteps <= 0) return { gx, gz }
  const tx = gx + Math.round((dirX / d) * maxSteps)
  const tz = gz + Math.round((dirZ / d) * maxSteps)
  let x = gx
  let z = gz
  for (let i = 0; i < maxSteps * 2; i++) {
    const ddx = tx - x
    const ddz = tz - z
    if (ddx === 0 && ddz === 0) break
    const mx = Math.sign(ddx)
    const mz = Math.sign(ddz)
    const tries =
      Math.abs(ddx) >= Math.abs(ddz) ? [[mx, 0], [0, mz]] : [[0, mz], [mx, 0]]
    let moved = false
    for (const [sx, sz] of tries) {
      if (!sx && !sz) continue
      const dir = sx === 1 ? 0 : sx === -1 ? 1 : sz === 1 ? 2 : 3
      if (!edgeOpen(cm, x, z, cy, dir) || cellBlocked(cm, x + sx, z + sz, cy)) continue
      x += sx
      z += sz
      moved = true
      break
    }
    if (!moved) break
  }
  return { gx: x, gz: z }
}

export const cellCenterOf = (g) => (g + 0.5) * CELL
