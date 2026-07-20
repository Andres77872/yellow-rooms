import * as THREE from 'three'
import {
  WALK_SPEED,
  SPRINT_SPEED,
  FLASH_RANGE,
  FLASH_COS_OUTER,
  STALKER_LIGHT_SPEED,
  STALKER_DARK_SPEED,
  ENTITY_VANISH_DIST,
  worldToCell,
  layerY,
} from '../world/constants.js'
import { moveAndCollide } from '../player/collision.js'
import { groundHeightAt } from '../player/ground.js'
import { sightGate, findHiddenSpot } from './sense.js'
import { PathFollower, extrapolateSearch, cellCenterOf } from './follow.js'

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
    this.pos = new THREE.Vector3() // feet position (y = ground height)
    this.cy = 0 // floor index (v8)
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
    this.searchSteps = 6 // cells of search extrapolation past the last-seen cell
    this.searchTime = 1.6 // pursue window granted by a successful extension (level scales)
    this._timer = this.interval
    this._spawnTimer = 4.5 // countdown to (re)spawn while dormant
    this._lostTimer = this.despawnDelay // countdown to despawn while unseen

    // Pursue route state (shared follower — reused buffers, drift repath).
    this.follower = new PathFollower(cm, {
      leash: this.pathLeash,
      maxNodes: this.pathBudget,
      repathEvery: this.repathEvery,
    })
    this._lastGX = 0
    this._lastGZ = 0
    this._lastCY = 0
    this._hasLast = false // have we ever seen the player (a last-seen cell)?
    this._pursueT = 0 // remaining pursue budget (s)
    // Escape-bearing memory: smoothed player velocity while in sight, consumed
    // by the search extension when the pursue reaches the last-seen cell dry.
    this._escapeX = 0
    this._escapeZ = 0
    this._prevPX = 0
    this._prevPZ = 0
    this._hasPrev = false
    this._searched = false // one extension per lost-sight episode

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
    this.searchSteps = 6
    // Higher levels search farther past the corner before giving up.
    this.searchTime = Math.min(2.6, 1.2 + level * 0.15)
    this.follower.configure({
      leash: this.pathLeash,
      maxNodes: this.pathBudget,
      repathEvery: this.repathEvery,
    })
    this._timer = this.interval
    this._spawnTimer = 4.5 // breathing room at level start
    this._lostTimer = this.despawnDelay
    this._pursueT = 0
    this.follower.reset()
    this._hasLast = false
    this._escapeX = 0
    this._escapeZ = 0
    this._hasPrev = false
    this._searched = false
    this.cy = 0
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
    _toE.set(this.pos.x, this.pos.y + 1.0, this.pos.z).sub(_camPos)
    const d = _toE.length()
    if (d < 1e-4) return true
    if (d > FLASH_RANGE) return false
    return _toE.dot(_camDir) / d >= FLASH_COS_OUTER
  }

  // Returns true if a hidden spot was found and the entity was placed there.
  // The 'dread' floor policy sometimes lands one floor off the player's —
  // footsteps overhead, a silhouette down a stairwell — and the stair-aware
  // pathfinder brings it the rest of the way.
  _teleport(camera, player, playerCy = 0) {
    const spot = findHiddenSpot(this.cm, camera, player.x, player.z, playerCy, this.minRange, this.maxRange, {
      floorPolicy: 'dread',
      record: this.recordCandidates ? this._lastCandidates : null,
    })
    if (!spot) return false
    this._lastTarget = { x: spot.x, z: spot.z, cy: spot.cy }
    this.cy = spot.cy
    this.pos.set(spot.x, layerY(spot.cy), spot.z)
    // A teleport invalidates any pursue route computed from the OLD position —
    // following it would walk toward stale waypoints (worst case adopting a
    // stale cross-floor waypoint through solid slab).
    this.follower.reset()
    this._faceMesh(player)
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
  forceTeleport(camera, player, playerCy = 0) {
    this.active = true
    this._lostTimer = this.despawnDelay
    if (!this._teleport(camera, player, playerCy)) {
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
    const light = this.cm.lightAt(this.pos.x, this.pos.z, this.cy)
    return this.darkSpeedMul + (STALKER_LIGHT_SPEED - this.darkSpeedMul) * light
  }

  _faceMesh(player) {
    this.mesh.position.set(this.pos.x, this.pos.y + this.mesh.scale.y * 0.95, this.pos.z)
    this.mesh.rotation.y = Math.atan2(player.x - this.pos.x, player.z - this.pos.z)
  }

  // One pursue tick: (re)route toward the last-seen cell/floor with the shared
  // follower (it walks ramps and flips this.cy at stair waypoints, and drift-
  // repaths when the target cell moves). Shared by the corner-pursuit after
  // lost sight AND the aperture-seen "it's coming up the stairs" chase.
  _pursueStep(dt, player) {
    const r = this.follower.step(
      this,
      dt,
      cellCenterOf(this._lastGX),
      cellCenterOf(this._lastGZ),
      this._lastCY,
      this.chaseSpeed * this._lightMul() * dt
    )
    if (r.repathed && !r.hasPath) {
      this._pursueT = 0 // unreachable -> drop to HUNT next frame
      return
    }
    this._faceMesh(player)
    if (r.done) this._onLastSeenReached()
  }

  // Arrived at the last-seen cell with still no sight. Once per lost-sight
  // episode, keep hunting ALONG THE PLAYER'S ESCAPE BEARING: walk the grid a
  // few open cells the way they were moving when sight broke and pursue that
  // cell — it follows around the corner instead of giving up on the doorstep.
  _onLastSeenReached() {
    const speed = Math.hypot(this._escapeX, this._escapeZ)
    if (this._searched || speed < 0.5) {
      this._pursueT = 0 // already searched (or no usable bearing) -> HUNT
      return
    }
    this._searched = true
    const s = extrapolateSearch(
      this.cm,
      this._lastGX,
      this._lastGZ,
      this._lastCY,
      this._escapeX,
      this._escapeZ,
      this.searchSteps
    )
    if (s.gx === this._lastGX && s.gz === this._lastGZ) {
      this._pursueT = 0 // boxed in: nothing past the corner to check
      return
    }
    this._lastGX = s.gx
    this._lastGZ = s.gz
    this.follower.reset() // retarget immediately (drift tolerance must not gate this)
    this._pursueT = Math.max(this._pursueT, this.searchTime)
  }

  // Returns { caught, tension, seen, dist, inBeam, frozen }.
  // ctx = { flashlightOn, canFreeze, playerCy } supplied by the Engine.
  update(dt, player, camera, ctx = {}) {
    const playerCy = ctx.playerCy ?? 0

    // --- Dormant: not on the map; count down to the next (re)spawn. ---
    if (!this.active) {
      this.stateLabel = 'spawning'
      if (!this.frozen) {
        this._spawnTimer -= dt
        if (this._spawnTimer <= 0) {
          this._lostTimer = this.despawnDelay
          if (this._teleport(camera, player, playerCy)) {
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
    const dy = (player.y || 0) - this.pos.y
    const dz = player.z - this.pos.z
    const dist = Math.hypot(dx, dy, dz) // 3D: a floor of separation is distance, not contact

    // Cheap-first visibility gate (3D distance -> floor gate -> frustum -> LOS).
    const seen = sightGate(this.cm, camera, this.pos, this.cy, player, playerCy, this.sightDist)
    // Wider "is the PLAYER watching it" gate for despawn/teleport: `seen` caps
    // at sightDist (60u) but the thinned fog + persistent entity ink keep the
    // silhouette readable far beyond that, so removals must never happen while
    // it's in frustum with LOS inside the fog-opaque range. Cross-floor the gate
    // is blind outside the stairwell aperture, so an entity left on another
    // floor is automatically free to relocate.
    const observed =
      seen || sightGate(this.cm, camera, this.pos, this.cy, player, playerCy, ENTITY_VANISH_DIST)

    // Escape-bearing memory: while the player is in sight, keep a smoothed
    // read of which way they're moving. When sight breaks and the pursue runs
    // dry at the last-seen cell, this bearing drives the search extension.
    if (seen && this._hasPrev && dt > 1e-4) {
      const a = Math.min(1, dt * 3)
      this._escapeX += ((player.x - this._prevPX) / dt - this._escapeX) * a
      this._escapeZ += ((player.z - this._prevPZ) / dt - this._escapeZ) * a
    }
    this._prevPX = player.x
    this._prevPZ = player.z
    this._hasPrev = true

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
    } else if (seen && playerCy === this.cy) {
      // CHASE: straight beeline at the player (same floor, LOS clear, so the
      // line is walkable). Arm the corner-pursuit window and remember where we
      // last saw them.
      this.stateLabel = 'chasing'
      this._lostTimer = this.despawnDelay
      this._pursueT = this.pursueTime
      this.follower.reset()
      this._searched = false
      this._lastGX = worldToCell(player.x)
      this._lastGZ = worldToCell(player.z)
      this._lastCY = playerCy
      this._hasLast = true
      const step = this.chaseSpeed * this._lightMul() * dt
      const dxz = Math.hypot(dx, dz)
      const inv = dxz > 0.0001 ? 1 / dxz : 0
      const before = this.pos.clone()
      moveAndCollide(this.cm, this.pos, dx * inv * step, dz * inv * step, this.cy)
      this.pos.y = groundHeightAt(this.cm, this.pos.x, this.pos.z, this.cy)
      this._faceMesh(player)
      // If somehow wall-stuck on a clear chase, allow it to re-teleport sooner.
      if (this.pos.distanceTo(before) < step * 0.1) this._timer = Math.min(this._timer, 0.8)
    } else if (seen) {
      // Seen THROUGH a stairwell aperture (one floor apart): it can't lunge
      // through the slab — arm the pursuit toward the player's floor and let
      // the stair-aware A* bring it up/down the stairs.
      this.stateLabel = 'pursuing(stairs)'
      this._lostTimer = this.despawnDelay
      this._pursueT = this.pursueTime
      this._searched = false
      this._lastGX = worldToCell(player.x)
      this._lastGZ = worldToCell(player.z)
      this._lastCY = playerCy
      this._hasLast = true
      this._pursueStep(dt, player)
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
        // PURSUE: route around the walls (and up/down stairs) toward the
        // last-seen cell on the last-seen floor.
        this.stateLabel = 'pursuing'
        this._pursueT -= dt
        this._pursueStep(dt, player)
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
            this._teleport(camera, player, playerCy)
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
