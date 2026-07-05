import * as THREE from 'three'
import {
  CELL,
  worldToCell,
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
} from '../world/constants.js'
import { moveAndCollide, hasLineOfSight } from '../player/collision.js'
import { sightGate, findHiddenSpot, EYE_Y } from './sense.js'
import { findPath, followPath } from '../world/pathfind.js'
import { pursuerSpeed, shouldRelocate, clampBandDist } from './pursuerLogic.js'

const DORMANT = { caught: false, tension: 0, seen: false, dist: Infinity, inBeam: false, frozen: false }

// The Pursuer ("Crawler"): a relentless second entity. Once placed it is ALWAYS
// active — it never despawns and the flashlight can't freeze it. Every frame it
// closes on the player at a constant speed below WALK_SPEED (beelining when it
// has line of sight, otherwise routing with grid A* — it always knows where you
// are), so you can open distance but never shake it. If it ever falls more than
// PURSUER_LEASH (~100 m) behind, it relocates into an off-screen band around the
// player (never on top of you) so it can never drop off the leash. It never
// teleports-on-stuck like the Stalker; a stuck detector escalates repath ->
// (cooldown-gated) relocate instead. Speed scales gently with the level.
export class Pursuer {
  constructor(scene, materials, geom, cm) {
    this.cm = cm
    this.mesh = new THREE.Mesh(geom.pursuer, materials.pursuer)
    this.mesh.scale.set(1.2, 1.0, 1.2) // low, broad silhouette
    this.mesh.visible = false
    scene.add(this.mesh)
    this.pos = new THREE.Vector3()
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
    this.active = false
    this.inBeam = false
    this.mesh.visible = false
    this.stateLabel = 'spawning'
    void playerPos // (re)spawns anchor on the player's live position
  }

  // Place (or relocate) into an off-screen band cell around the player. Fallback
  // chain so it never simply drops off the leash and never lands on the player.
  _relocate(camera, player) {
    const spot = this._findBandSpot(camera, player)
    if (!spot) return false
    this._lastTarget = { x: spot.x, z: spot.z }
    this.pos.set(spot.x, EYE_Y, spot.z)
    this.mesh.position.set(spot.x, this.mesh.scale.y * 0.95, spot.z)
    this.mesh.visible = true
    return true
  }

  _findBandSpot(camera, player) {
    const rec = this.recordCandidates ? this._lastCandidates : null
    // (a) off-screen, in the band.
    let s = findHiddenSpot(this.cm, camera, player.x, player.z, this.bandMin, this.bandMax, { record: rec })
    if (s) return s
    // (b) allow on-screen — appearing beats falling off the leash.
    s = findHiddenSpot(this.cm, camera, player.x, player.z, this.bandMin, this.bandMax, { requireOffscreen: false })
    if (s) return s
    // (c) widen the band toward the leash.
    s = findHiddenSpot(this.cm, camera, player.x, player.z, this.bandMin * 0.5, this.leash * 0.95, {
      requireOffscreen: false,
    })
    if (s) return s
    // (d) deterministic snap on the player->pursuer bearing at a clamped distance.
    return this._bearingSnap(player)
  }

  // Cast from the player toward the pursuer's current bearing at a band distance,
  // then spiral out to the nearest non-column cell centre. Returns {x,z} or null.
  _bearingSnap(player) {
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
          if (!this.cm.columnAt(gx0 + ox, gz0 + oz)) {
            return { x: (gx0 + ox + 0.5) * CELL, z: (gz0 + oz + 0.5) * CELL }
          }
        }
      }
    }
    return null // last resort: caller keeps current pos and keeps pathing
  }

  _faceMesh(player) {
    this.mesh.position.set(this.pos.x, this.mesh.scale.y * 0.95, this.pos.z)
    this.mesh.rotation.y = Math.atan2(player.x - this.pos.x, player.z - this.pos.z)
  }

  // Returns { caught, tension, seen, dist, inBeam:false, frozen:false }.
  // ctx is accepted for signature parity but ignored (flashlight-immune).
  update(dt, player, camera, _ctx = {}) {
    if (this.frozen) {
      // Debug hold-position.
      this.stateLabel = 'hold'
      const d = this.active ? Math.hypot(player.x - this.pos.x, player.z - this.pos.z) : Infinity
      return { caught: false, tension: 0, seen: false, dist: d, inBeam: false, frozen: false }
    }

    // --- Spawn grace: place once, then stay active forever. ---
    if (!this.active) {
      this.stateLabel = 'spawning'
      this._spawnTimer -= dt
      if (this._spawnTimer <= 0) {
        if (this._relocate(camera, player)) this.active = true
        else this._spawnTimer = 0.3 // confined right now — retry shortly
      }
      if (this.alwaysVisible) this.mesh.visible = true
      return DORMANT
    }

    this._repathT -= dt
    this._relocT -= dt

    let dx = player.x - this.pos.x
    let dz = player.z - this.pos.z
    let dist = Math.hypot(dx, dz)

    // Is the player actually watching it (frustum + LOS) inside the fog-opaque
    // range? Relocates must be deferred then: with the thinned fog + persistent
    // entity ink, a watched departure at 100u+ is a visible mid-screen teleport.
    // Deferring costs nothing — the pursuer never gains on a moving player.
    const observed = sightGate(
      this.cm, camera, this.pos.x, this.pos.z, player.x, player.z, ENTITY_VANISH_DIST)

    // --- Leash: relocate if it has fallen too far behind. ---
    if (!observed && shouldRelocate(dist, this.leash, this._relocT) && this._relocate(camera, player)) {
      this._relocT = this.relocateCooldown
      this._pathLen = 0
      this._stuckT = 0
      dx = player.x - this.pos.x
      dz = player.z - this.pos.z
      dist = Math.hypot(dx, dz)
    }

    // --- Move (constant speed; never stops). ---
    const step = this.chaseSpeed * dt
    const bx = this.pos.x
    const bz = this.pos.z
    const los = hasLineOfSight(this.cm, player.x, player.z, this.pos.x, this.pos.z)
    if (los) {
      this.stateLabel = 'chasing'
      this._pathLen = 0
      this._moveToward(dx, dz, dist, step)
    } else {
      this.stateLabel = 'pathing'
      const consumed = this._pathLen === 0 || this._cursor * 2 >= this._pathLen
      if (consumed || this._repathT <= 0) {
        const p = findPath(this.cm, this.pos.x, this.pos.z, player.x, player.z, {
          out: this._pathBuf,
          leash: PURSUER_PATH_LEASH,
          maxNodes: 1500,
        })
        this._pathLen = p ? p.length : 0
        this._cursor = 0
        this._repathT = this.repathInterval
      }
      if (this._pathLen > 0) {
        const r = followPath(this.cm, this.pos, this._pathBuf, this._cursor, step)
        this._cursor = r.i
      } else {
        // No route (over budget / unreachable): keep closing the gap anyway.
        this.stateLabel = 'pathing(direct)'
        this._moveToward(dx, dz, dist, step)
      }
    }

    // --- Stuck detector: never teleport-on-stuck — repath, then relocate. ---
    // (Relocate deferred while observed, same as the leash: standing briefly
    // beats visibly teleporting.)
    const moved = Math.hypot(this.pos.x - bx, this.pos.z - bz)
    this._stuckT = moved < step * 0.1 ? this._stuckT + dt : 0
    if (this._stuckT > PURSUER_STUCK_RELOCATE && this._relocT <= 0 && !observed) {
      if (this._relocate(camera, player)) {
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

    // Catch / sense (recompute distance after the move).
    dx = player.x - this.pos.x
    dz = player.z - this.pos.z
    dist = Math.hypot(dx, dz)
    const caught = dist < this.catchDist
    if (caught) this.stateLabel = 'caught'
    const seen = sightGate(this.cm, camera, this.pos.x, this.pos.z, player.x, player.z, this.sightDist)
    let tension = Math.max(0, 1 - dist / 30)
    if (seen) tension = Math.min(1, tension + 0.35)
    return { caught, tension, seen, dist, inBeam: false, frozen: false }
  }

  _moveToward(dx, dz, dist, step) {
    const inv = dist > 1e-4 ? step / dist : 0
    if (inv) moveAndCollide(this.cm, this.pos, dx * inv, dz * inv)
  }
}
