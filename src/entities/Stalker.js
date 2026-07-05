import * as THREE from 'three'
import {
  WALK_SPEED,
  SPRINT_SPEED,
  FLASH_RANGE,
  FLASH_COS_OUTER,
  STALKER_LIGHT_SPEED,
  STALKER_DARK_SPEED,
  ENTITY_VANISH_DIST,
  CELL,
  worldToCell,
} from '../world/constants.js'
import { moveAndCollide } from '../player/collision.js'
import { sightGate, findHiddenSpot, EYE_Y } from './sense.js'
import { findPath, followPath } from '../world/pathfind.js'

const _camPos = new THREE.Vector3()
const _camDir = new THREE.Vector3()
const _toE = new THREE.Vector3()

// The Stalker: a Slender-style teleporter that now also PATHFINDS. It spawns
// off-screen and teleports to random off-frustum cells while hunting; the moment
// it has line of sight it CHASES (a light-scaled beeline). When you break sight
// it doesn't give up at once — for a short pursue window it routes around the
// walls toward where it last saw you (grid A* via world/pathfind), so it follows
// you around corners instead of teleporting blindly. Only when that window
// lapses, the route fails, or it reaches your last cell with still no sight does
// it fall back to the teleport hunt and (after despawnDelay) vanish.
//
// Light drives its tempo: it reads cm.lightAt every frame and sprints in the
// dark / crawls under lamps, while the flashlight beam freezes it outright.
// Range, interval, chase speed, darkness boost, pursue patience, despawn patience
// and respawn speed all scale with the level, so difficulty escalates for free.
export class Stalker {
  constructor(scene, materials, geom, cm) {
    this.cm = cm
    this.mesh = new THREE.Mesh(geom.entity, materials.entity)
    this.mesh.scale.set(1, 1.28, 1)
    this.mesh.visible = false
    scene.add(this.mesh)
    this.pos = new THREE.Vector3()
    this.active = false
    this.level = 1

    // Level-1 defaults so the entity is well-defined before the first reset()
    // (e.g. the debug AI inspector reads these at the title screen). reset()
    // recomputes them per level on run start.
    this.maxRange = 27
    this.minRange = this.maxRange * 0.55
    this.interval = 5.1
    this.chaseSpeed = WALK_SPEED * 0.95 + 0.3
    this.catchDist = 1.25
    this.sightDist = 60
    this.despawnDelay = 3.0 // seconds of lost sight before it gives up and vanishes
    this.respawnCooldown = 6.0 // seconds dormant before it returns
    this.darkSpeedMul = STALKER_DARK_SPEED // chase-speed mult in full darkness
    this.pursueTime = 2.4 // seconds it routes toward your last-seen cell after losing sight
    this.repathEvery = 0.5 // seconds between path recomputes while pursuing
    this.pathLeash = 22 // pathfinder search leash in cells (~66 u ≪ loaded edge)
    this.pathBudget = 1200 // pathfinder maxNodes
    this._timer = this.interval
    this._spawnTimer = 4.5 // countdown to (re)spawn while dormant
    this._lostTimer = this.despawnDelay // countdown to despawn while unseen

    // Pursue path state (reused buffer — no per-frame allocation).
    this._pathBuf = []
    this._pathLen = 0 // path.length while valid, else 0
    this._cursor = 0 // current waypoint index
    this._lastGX = 0
    this._lastGZ = 0
    this._hasLast = false // have we ever seen the player (a last-seen cell)?
    this._repathT = 0
    this._pursueT = 0 // remaining pursue budget (s)

    // --- Debug introspection / control (no effect unless toggled) ---
    this.frozen = false // hold position: no teleport, no chase
    this.alwaysVisible = false // force the mesh visible for inspection
    this.recordCandidates = false // capture findHiddenSpot samples for the map overlay
    this.stateLabel = 'idle' // derived state for the AI inspector HUD
    this.inBeam = false // last-frame: caught in the flashlight beam (frozen)
    this._lastCandidates = [] // [{x,z,ok}] from the last spawn sample (when recording)
    this._lastTarget = null // {x,z} of the last chosen teleport spot
  }

  reset(level, playerPos) {
    this.level = level
    this.maxRange = Math.max(14, 30 - level * 3)
    this.minRange = this.maxRange * 0.55
    this.interval = Math.max(2.0, 5.5 - level * 0.4)
    this.chaseSpeed = Math.min(SPRINT_SPEED * 0.92, WALK_SPEED * 0.95 + level * 0.3)
    this.catchDist = 1.25
    this.sightDist = 60
    // Harder = clings longer when you hide, returns faster, much faster in the dark.
    this.despawnDelay = Math.min(6, 2.5 + level * 0.4)
    this.respawnCooldown = Math.max(2, 7 - level * 0.5)
    this.darkSpeedMul = Math.min(2.2, STALKER_DARK_SPEED + level * 0.08)
    // Corner-pursuit window grows with the level but never outlasts the despawn.
    this.pursueTime = Math.min(this.despawnDelay * 0.8, 2.2 + level * 0.2)
    this.repathEvery = 0.5
    this.pathLeash = 22
    this.pathBudget = 1200
    this._timer = this.interval
    this._spawnTimer = 4.5 // breathing room at level start
    this._lostTimer = this.despawnDelay
    this._pursueT = 0
    this._repathT = 0
    this._pathLen = 0
    this._cursor = 0
    this._hasLast = false
    this.active = false
    this.inBeam = false
    this.mesh.visible = false
    void playerPos // (re)spawns now anchor on the player's live position
  }

  // CPU mirror of the shader flashlight cone: is the entity inside the player's
  // beam? Requires `seen` (so the LOS-baked frustum/raycast already blocks the
  // beam through walls) plus the analytic cone test (FLASH_RANGE / outer angle).
  _inFlashBeam(camera, ctx, seen) {
    if (!seen || !ctx || !ctx.flashlightOn) return false
    camera.getWorldPosition(_camPos)
    camera.getWorldDirection(_camDir)
    _toE.set(this.pos.x, 1.0, this.pos.z).sub(_camPos)
    const d = _toE.length()
    if (d < 1e-4) return true
    if (d > FLASH_RANGE) return false
    return _toE.dot(_camDir) / d >= FLASH_COS_OUTER
  }

  // Returns true if a hidden spot was found and the entity was placed there.
  _teleport(camera, player) {
    const spot = findHiddenSpot(this.cm, camera, player.x, player.z, this.minRange, this.maxRange, {
      record: this.recordCandidates ? this._lastCandidates : null,
    })
    if (!spot) return false
    this._lastTarget = { x: spot.x, z: spot.z }
    this.pos.set(spot.x, EYE_Y, spot.z)
    this.mesh.position.set(spot.x, this.mesh.scale.y * 0.95, spot.z)
    this.mesh.visible = true
    return true
  }

  _despawn() {
    this.active = false
    this.inBeam = false
    this.mesh.visible = false
    this._spawnTimer = this.respawnCooldown
  }

  // --- Debug controls ---
  forceTeleport(camera, player) {
    this.active = true
    this._lostTimer = this.despawnDelay
    if (!this._teleport(camera, player)) {
      this.active = false
      return false
    }
    this._timer = this.interval
    return true
  }

  setParams(p = {}) {
    Object.assign(this, p)
  }

  // Light-scaled chase multiplier at the entity's position (dark = fast, lit = slow).
  _lightMul() {
    const light = this.cm.lightAt(this.pos.x, this.pos.z)
    return this.darkSpeedMul + (STALKER_LIGHT_SPEED - this.darkSpeedMul) * light
  }

  _faceMesh(player) {
    this.mesh.position.set(this.pos.x, this.mesh.scale.y * 0.95, this.pos.z)
    this.mesh.rotation.y = Math.atan2(player.x - this.pos.x, player.z - this.pos.z)
  }

  // Returns { caught, tension, seen, dist, inBeam, frozen }.
  // ctx = { flashlightOn, canFreeze } supplied by the Engine.
  update(dt, player, camera, ctx = {}) {
    // --- Dormant: not on the map; count down to the next (re)spawn. ---
    if (!this.active) {
      this.stateLabel = 'spawning'
      if (!this.frozen) {
        this._spawnTimer -= dt
        if (this._spawnTimer <= 0) {
          this._lostTimer = this.despawnDelay
          if (this._teleport(camera, player)) {
            this.active = true
            this._timer = this.interval
          } else {
            this._spawnTimer = 0.3 // confined right now — retry the spawn shortly
          }
        }
      }
      if (this.alwaysVisible) this.mesh.visible = true
      return { caught: false, tension: 0, seen: false, dist: Infinity, inBeam: false, frozen: false }
    }

    const dx = player.x - this.pos.x
    const dz = player.z - this.pos.z
    const dist = Math.hypot(dx, dz)

    // Cheap-first visibility gate (distance -> frustum -> line of sight).
    const seen = sightGate(this.cm, camera, this.pos.x, this.pos.z, player.x, player.z, this.sightDist)
    // Wider "is the PLAYER watching it" gate for despawn/teleport: `seen` caps
    // at sightDist (60u) but the thinned fog + persistent entity ink keep the
    // silhouette readable far beyond that, so removals must never happen while
    // it's in frustum with LOS inside the fog-opaque range.
    const observed =
      seen || sightGate(this.cm, camera, this.pos.x, this.pos.z, player.x, player.z, ENTITY_VANISH_DIST)

    // Flashlight beam (a strong, dynamic light) freezes the entity outright —
    // unless the player has stared so long the freeze has failed (canFreeze).
    const inBeam = this._inFlashBeam(camera, ctx, seen)
    this.inBeam = inBeam
    const frozen = inBeam && ctx.canFreeze !== false

    if (this.frozen) {
      // Debug hold-position: keep the readout meaningful, take no action.
      this.stateLabel = seen ? 'chasing(frozen)' : 'hidden(frozen)'
    } else if (frozen) {
      // Pinned by the beam: hold still, but we still have eyes on it.
      this.stateLabel = 'frozen'
      this._lostTimer = this.despawnDelay
      this.mesh.rotation.y = Math.atan2(player.x - this.pos.x, player.z - this.pos.z)
    } else if (seen) {
      // CHASE: straight beeline at the player (LOS is clear, so the line is too).
      // Arm the corner-pursuit window and remember where we last saw them.
      this.stateLabel = 'chasing'
      this._lostTimer = this.despawnDelay
      this._pursueT = this.pursueTime
      this._pathLen = 0
      this._cursor = 0
      this._lastGX = worldToCell(player.x)
      this._lastGZ = worldToCell(player.z)
      this._hasLast = true
      const step = this.chaseSpeed * this._lightMul() * dt
      const inv = dist > 0.0001 ? 1 / dist : 0
      const before = this.pos.clone()
      moveAndCollide(this.cm, this.pos, dx * inv * step, dz * inv * step)
      this._faceMesh(player)
      // If somehow wall-stuck on a clear chase, allow it to re-teleport sooner.
      if (this.pos.distanceTo(before) < step * 0.1) this._timer = Math.min(this._timer, 0.8)
    } else {
      // --- Lost sight ---
      this._lostTimer -= dt
      // Never vanish while watched: hold (keep hunting) until the player looks
      // away or the haze has fully swallowed it.
      if (this._lostTimer <= 0 && !observed) {
        this._despawn()
        this.stateLabel = 'despawn'
        // Now inactive: report Infinity like the dormant branch above, so the
        // Engine's (un-gated) proximity-slow doesn't fire on the despawn frame.
        return { caught: false, tension: 0, seen: false, dist: Infinity, inBeam: false, frozen: false }
      }

      if (this._pursueT > 0 && this._hasLast) {
        // PURSUE: route around the walls toward the last-seen cell.
        this.stateLabel = 'pursuing'
        this._pursueT -= dt
        this._repathT -= dt
        const consumed = this._pathLen === 0 || this._cursor * 2 >= this._pathLen
        if (consumed || this._repathT <= 0) {
          const tx = (this._lastGX + 0.5) * CELL
          const tz = (this._lastGZ + 0.5) * CELL
          const p = findPath(this.cm, this.pos.x, this.pos.z, tx, tz, {
            out: this._pathBuf,
            leash: this.pathLeash,
            maxNodes: this.pathBudget,
          })
          this._pathLen = p ? p.length : 0
          this._cursor = 0
          this._repathT = this.repathEvery
          if (!p) this._pursueT = 0 // unreachable -> drop to HUNT next frame
        }
        if (this._pathLen > 0) {
          const r = followPath(this.cm, this.pos, this._pathBuf, this._cursor, this.chaseSpeed * this._lightMul() * dt)
          this._cursor = r.i
          this._faceMesh(player)
          if (r.done) this._pursueT = 0 // reached the last-seen cell, still unseen -> HUNT
        }
      } else {
        // HUNT: the original teleport-on-interval fallback, then despawn.
        this.stateLabel = 'hunting'
        this._timer -= dt
        if (this._timer <= 0) {
          if (observed) {
            // Departure would pop mid-screen; retry once the player looks away.
            this._timer = 0.4
          } else {
            this.stateLabel = 'teleport'
            this._teleport(camera, player)
            this._timer = this.interval
          }
        }
      }
    }

    if (this.alwaysVisible) this.mesh.visible = true

    // A frozen entity can't close the distance, so it can't catch you — until
    // the freeze fails (then it lunges).
    const caught = dist < this.catchDist && !frozen
    if (caught) this.stateLabel = 'caught'
    // Tension from proximity, amplified when in view.
    let tension = Math.max(0, 1 - dist / 22)
    if (seen) tension = Math.min(1, tension + 0.35)
    return { caught, tension, seen, dist, inBeam, frozen }
  }
}
