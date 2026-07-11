import * as THREE from 'three'
import {
  CELL,
  worldToCell,
  layerY,
  PURSUER_LEASH,
  PURSUER_BAND_MIN,
  PURSUER_BAND_MAX,
  PURSUER_CATCH,
  PURSUER_SIGHT,
  PURSUER_REPATH,
  PURSUER_RELOCATE_CD,
  PURSUER_SPAWN_GRACE,
  PURSUER_STUCK_REPATH,
  PURSUER_STUCK_RELOCATE,
  PURSUER_PATH_LEASH,
  ENTITY_VANISH_DIST,
  ENEMY_STAIR_SPEED,
} from '../world/constants.js'
import { moveAndCollide, hasLineOfSight } from '../player/collision.js'
import { groundHeightAt } from '../player/ground.js'
import { sightGate, findHiddenSpot } from './sense.js'
import { findPath, followPath } from '../world/pathfind.js'
import { pursuerSpeed, shouldRelocate, clampBandDist, chooseFallback } from './pursuerLogic.js'

const DORMANT = { caught: false, tension: 0, seen: false, dist: Infinity, inBeam: false, frozen: false }

// The Pursuer ("Crawler"): a relentless second entity. Once placed it is ALWAYS
// active — it never despawns and the flashlight can't freeze it. Every frame it
// closes on the player at a constant speed below WALK_SPEED (beelining when it
// has same-floor line of sight, otherwise routing with the stair-aware grid A*
// — it always knows where you are, INCLUDING which floor), so you can open
// distance but never shake it: it genuinely follows you up and down the stairs.
// If it ever falls more than PURSUER_LEASH (~100 m, 3D) behind, it relocates
// into an off-screen band around the player ON THE PLAYER'S FLOOR (never on top
// of you) so it can never drop off the leash. It never teleports-on-stuck like
// the Stalker; a stuck detector escalates repath -> (cooldown-gated) relocate
// instead. Speed scales gently with the level.
export class Pursuer {
  constructor(scene, materials, geom, cm) {
    this.cm = cm
    this.mesh = new THREE.Mesh(geom.pursuer, materials.pursuer)
    this.mesh.scale.set(1.2, 1.0, 1.2) // low, broad silhouette
    this.mesh.visible = false
    scene.add(this.mesh)
    this.pos = new THREE.Vector3() // feet position (y = ground height)
    this.cy = 0 // floor index (v8)
    this.active = false
    this.level = 1

    this.chaseSpeed = pursuerSpeed(1)
    this.leash = PURSUER_LEASH
    this.bandMin = PURSUER_BAND_MIN
    this.bandMax = PURSUER_BAND_MAX
    this.catchDist = PURSUER_CATCH
    this.sightDist = PURSUER_SIGHT
    this.repathInterval = PURSUER_REPATH
    this.relocateCooldown = PURSUER_RELOCATE_CD

    this._spawnTimer = PURSUER_SPAWN_GRACE
    this._repathT = 0
    this._relocT = 0
    this._stuckT = 0
    this._pathBuf = []
    this._pathLen = 0
    this._cursor = 0

    // --- Debug introspection / control parity with the Stalker ---
    this.frozen = false
    this.alwaysVisible = false
    this.recordCandidates = false
    this.stateLabel = 'spawning'
    this.inBeam = false
    this._lastTarget = null
    this._lastCandidates = []
  }

  reset(level, playerPos) {
    this.level = level
    this.chaseSpeed = pursuerSpeed(level)
    this._spawnTimer = PURSUER_SPAWN_GRACE
    this._repathT = 0
    this._relocT = 0
    this._stuckT = 0
    this._pathLen = 0
    this._cursor = 0
    this.cy = 0
    this.active = false
    this.inBeam = false
    this.mesh.visible = false
    this.stateLabel = 'spawning'
    void playerPos // (re)spawns anchor on the player's live position
  }

  // Place (or relocate) into an off-screen band cell around the player, on the
  // player's floor. Fallback chain so it never simply drops off the leash and
  // never lands on the player.
  _relocate(camera, player, playerCy) {
    const spot = this._findBandSpot(camera, player, playerCy)
    if (!spot) return false
    this._lastTarget = { x: spot.x, z: spot.z, cy: spot.cy }
    this.cy = spot.cy
    this.pos.set(spot.x, layerY(spot.cy), spot.z)
    this.mesh.position.set(spot.x, this.pos.y + this.mesh.scale.y * 0.95, spot.z)
    this.mesh.visible = true
    return true
  }

  _findBandSpot(camera, player, playerCy) {
    const rec = this.recordCandidates ? this._lastCandidates : null
    // (a) off-screen, in the band, on the player's floor.
    let s = findHiddenSpot(this.cm, camera, player.x, player.z, playerCy, this.bandMin, this.bandMax, { record: rec })
    if (s) return s
    // (b) allow on-screen — appearing beats falling off the leash.
    s = findHiddenSpot(this.cm, camera, player.x, player.z, playerCy, this.bandMin, this.bandMax, { requireOffscreen: false })
    if (s) return s
    // (c) widen the band toward the leash.
    s = findHiddenSpot(this.cm, camera, player.x, player.z, playerCy, this.bandMin * 0.5, this.leash * 0.95, {
      requireOffscreen: false,
    })
    if (s) return s
    // (d) deterministic snap on the player->pursuer bearing at a clamped distance.
    return this._bearingSnap(player, playerCy)
  }

  // Cast from the player toward the pursuer's current bearing at a band distance,
  // then spiral out to the nearest placeable cell centre on the player's floor.
  // Returns {x,z,cy} or null.
  _bearingSnap(player, playerCy) {
    const dx = this.pos.x - player.x
    const dz = this.pos.z - player.z
    const d = Math.hypot(dx, dz)
    const ang = d > 1e-4 ? Math.atan2(dz, dx) : 0
    const r = clampBandDist(d, this.bandMin, this.bandMax)
    const gx0 = worldToCell(player.x + Math.cos(ang) * r)
    const gz0 = worldToCell(player.z + Math.sin(ang) * r)
    for (let ring = 0; ring <= 4; ring++) {
      for (let oz = -ring; oz <= ring; oz++) {
        for (let ox = -ring; ox <= ring; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oz)) !== ring) continue
          const x = (gx0 + ox + 0.5) * CELL
          const z = (gz0 + oz + 0.5) * CELL
          // isBlocked fails closed: unloaded chunks, floor holes and columns
          // are all unplaceable.
          if (!this.cm.isBlocked(x, z, playerCy)) {
            return { x, z, cy: playerCy }
          }
        }
      }
    }
    return null // last resort: caller keeps current pos and keeps pathing
  }

  _faceMesh(player) {
    this.mesh.position.set(this.pos.x, this.pos.y + this.mesh.scale.y * 0.95, this.pos.z)
    this.mesh.rotation.y = Math.atan2(player.x - this.pos.x, player.z - this.pos.z)
  }

  // Returns { caught, tension, seen, dist, inBeam:false, frozen:false }.
  // ctx = { playerCy } (flashlight fields ignored — it is beam-immune).
  update(dt, player, camera, ctx = {}) {
    const playerCy = ctx.playerCy ?? 0

    if (this.frozen) {
      // Debug hold-position.
      this.stateLabel = 'hold'
      const d = this.active
        ? Math.hypot(player.x - this.pos.x, (player.y || 0) - this.pos.y, player.z - this.pos.z)
        : Infinity
      return { caught: false, tension: 0, seen: false, dist: d, inBeam: false, frozen: false }
    }

    // --- Spawn grace: place once, then stay active forever. ---
    if (!this.active) {
      this.stateLabel = 'spawning'
      this._spawnTimer -= dt
      if (this._spawnTimer <= 0) {
        if (this._relocate(camera, player, playerCy)) this.active = true
        else this._spawnTimer = 0.3 // confined right now — retry shortly
      }
      if (this.alwaysVisible) this.mesh.visible = true
      return DORMANT
    }

    this._repathT -= dt
    this._relocT -= dt

    let dx = player.x - this.pos.x
    let dy = (player.y || 0) - this.pos.y
    let dz = player.z - this.pos.z
    let dist = Math.hypot(dx, dy, dz) // 3D — vertical kiting still counts as distance

    // Is the player actually watching it (frustum + LOS, floor-gated) inside
    // the fog-opaque range? Relocates must be deferred then: with the thinned
    // fog + persistent entity ink, a watched departure is a visible mid-screen
    // teleport. Cross-floor (outside a stairwell aperture) it is never
    // observed, so a pursuer left a floor behind relocates freely.
    const observed = sightGate(this.cm, camera, this.pos, this.cy, player, playerCy, ENTITY_VANISH_DIST)

    // --- Leash: relocate if it has fallen too far behind. ---
    if (!observed && shouldRelocate(dist, this.leash, this._relocT) && this._relocate(camera, player, playerCy)) {
      this._relocT = this.relocateCooldown
      this._pathLen = 0
      this._stuckT = 0
      dx = player.x - this.pos.x
      dy = (player.y || 0) - this.pos.y
      dz = player.z - this.pos.z
      dist = Math.hypot(dx, dy, dz)
    }

    // --- Move (constant speed; never stops as long as a route exists). ---
    const step = this.chaseSpeed * dt
    const bx = this.pos.x
    const bz = this.pos.z
    const losSameFloor =
      playerCy === this.cy &&
      hasLineOfSight(this.cm, player.x, player.z, this.pos.x, this.pos.z, this.cy)
    let stairMul = 1
    if (losSameFloor) {
      this.stateLabel = 'chasing'
      this._pathLen = 0
      this._moveToward(dx, dz, step)
    } else {
      const consumed = this._pathLen === 0 || this._cursor * 3 >= this._pathLen
      if (consumed || this._repathT <= 0) {
        const p = findPath(this.cm, this.pos.x, this.pos.z, this.cy, player.x, player.z, playerCy, {
          out: this._pathBuf,
          leash: PURSUER_PATH_LEASH,
          maxNodes: 1500,
        })
        this._pathLen = p ? p.length : 0
        this._cursor = 0
        this._repathT = this.repathInterval
      }
      const mode = chooseFallback(losSameFloor, playerCy - this.cy, this._pathLen > 0)
      if (mode === 'path') {
        this.stateLabel = 'pathing'
        const r = followPath(this.cm, this, this._pathBuf, this._cursor, step)
        this._cursor = r.i
        if (r.stair) stairMul = ENEMY_STAIR_SPEED
      } else if (mode === 'direct') {
        // Same floor, no route (over budget / unreachable): keep closing.
        this.stateLabel = 'pathing(direct)'
        this._moveToward(dx, dz, step)
      } else {
        // Cross-floor with no route: walking "toward" the player would just
        // grind a wall under the slab. Hold; the stuck detector escalates to a
        // relocate onto the player's floor — the honest recovery.
        this.stateLabel = 'holding'
      }
    }

    // --- Stuck detector: never teleport-on-stuck — repath, then relocate. ---
    // (Relocate deferred while observed, same as the leash: standing briefly
    // beats visibly teleporting. The threshold honours the stair slow-down.)
    const moved = Math.hypot(this.pos.x - bx, this.pos.z - bz)
    this._stuckT = moved < step * stairMul * 0.1 ? this._stuckT + dt : 0
    if (this._stuckT > PURSUER_STUCK_RELOCATE && this._relocT <= 0 && !observed) {
      if (this._relocate(camera, player, playerCy)) {
        this._relocT = this.relocateCooldown
        this._stuckT = 0
        this._pathLen = 0
      }
    } else if (this._stuckT > PURSUER_STUCK_REPATH) {
      this._repathT = 0 // force a fresh route next frame
      this._pathLen = 0
    }

    this._faceMesh(player)
    if (this.alwaysVisible) this.mesh.visible = true

    // Catch / sense (recompute distance after the move). 3D distance: a
    // pursuer one slab below is 3.6u away — heartbeat, but never a catch.
    dx = player.x - this.pos.x
    dy = (player.y || 0) - this.pos.y
    dz = player.z - this.pos.z
    dist = Math.hypot(dx, dy, dz)
    const caught = dist < this.catchDist
    if (caught) this.stateLabel = 'caught'
    const seen = sightGate(this.cm, camera, this.pos, this.cy, player, playerCy, this.sightDist)
    let tension = Math.max(0, 1 - dist / 30)
    if (seen) tension = Math.min(1, tension + 0.35)
    return { caught, tension, seen, dist, inBeam: false, frozen: false }
  }

  _moveToward(dx, dz, step) {
    const d = Math.hypot(dx, dz)
    const inv = d > 1e-4 ? step / d : 0
    if (inv) {
      moveAndCollide(this.cm, this.pos, dx * inv, dz * inv, this.cy)
      this.pos.y = groundHeightAt(this.cm, this.pos.x, this.pos.z, this.cy)
    }
  }
}
