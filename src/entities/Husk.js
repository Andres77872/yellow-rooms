import * as THREE from 'three'
import {
  layerY,
  ENTITY_VANISH_DIST,
  HUSK_SPAWN_CD,
  HUSK_BAND_MIN,
  HUSK_BAND_MAX,
  HUSK_VANISH,
  HUSK_AWAY_TIME,
  HUSK_TOUCH,
  HUSK_CLOSE,
  HUSK_CLOSE_KILL,
  HUSK_SIGHT,
  HUSK_RESPAWN_DEAD,
  HUSK_RESPAWN_FADE,
} from '../world/constants.js'
import { sightGate, findHiddenSpot } from './sense.js'

const DORMANT = { caught: false, tension: 0, seen: false, dist: Infinity, inBeam: false, frozen: false, died: false }

// The Husk: a static, weak entity — the one enemy the player can destroy.
// It appears off-screen a short way from the player and simply STANDS there,
// slowly turning to face you. It never moves and can never catch you; its
// threat is presence — tension and the proximity slow while you share a room
// with it. It ends one of three ways:
//   - FADE:  the player stays beyond HUSK_VANISH long enough -> it quietly
//            disappears (never while genuinely watched — no mid-screen pops).
//   - TOUCH: the player walks into it -> it dies instantly.
//   - CROWD: the player lingers inside HUSK_CLOSE for HUSK_CLOSE_KILL seconds
//            -> it dies. Standing that close means eating the proximity slow
//            and its stare the whole time, so the kill is a commitment.
// Death is reported via `died` in the update result so the Engine can cue it.
export class Husk {
  constructor(scene, materials, geom, cm) {
    this.cm = cm
    this.mesh = new THREE.Mesh(geom.husk, materials.husk)
    this.mesh.scale.set(0.9, 0.85, 0.9) // small, frail silhouette
    this.mesh.visible = false
    scene.add(this.mesh)
    this.pos = new THREE.Vector3() // feet position (y = ground height)
    this.cy = 0 // floor index
    this.active = false
    this.level = 1
    this.kills = 0 // husks destroyed this level (touch or crowd)

    this.spawnCooldown = HUSK_SPAWN_CD
    this.touchDist = HUSK_TOUCH
    this.closeDist = HUSK_CLOSE
    this.closeKillTime = HUSK_CLOSE_KILL
    this.vanishDist = HUSK_VANISH
    this.sightDist = HUSK_SIGHT

    this._spawnTimer = HUSK_SPAWN_CD
    this._closeT = 0 // sustained player-too-close seconds
    this._awayT = 0 // sustained player-gone seconds

    // --- Debug introspection / control parity with the other entities ---
    this.frozen = false
    this.alwaysVisible = false
    this.recordCandidates = false
    this.stateLabel = 'dormant'
    this.inBeam = false
    this._lastTarget = null
    this._lastCandidates = []
  }

  reset(level, playerPos) {
    this.level = level
    this.kills = 0
    // Appears a little more often on deeper levels, never oppressively so.
    this.spawnCooldown = Math.max(6, HUSK_SPAWN_CD - level * 0.5)
    this._spawnTimer = this.spawnCooldown
    this._closeT = 0
    this._awayT = 0
    this.cy = 0
    this.active = false
    this.inBeam = false
    this.mesh.visible = false
    this.stateLabel = 'dormant'
    void playerPos // spawns anchor on the player's live position
  }

  // Place it at an off-screen, non-blocked spot in the near band around the
  // player, on the player's floor. Returns false while confined (retry soon).
  _appear(camera, player, playerCy) {
    const spot = findHiddenSpot(this.cm, camera, player.x, player.z, playerCy, HUSK_BAND_MIN, HUSK_BAND_MAX, {
      record: this.recordCandidates ? this._lastCandidates : null,
    })
    if (!spot) return false
    this._lastTarget = { x: spot.x, z: spot.z, cy: spot.cy }
    this.cy = spot.cy
    this.pos.set(spot.x, layerY(spot.cy), spot.z)
    this._faceMesh(player)
    this.mesh.visible = true
    this._closeT = 0
    this._awayT = 0
    return true
  }

  _despawn(cooldown, label) {
    this.active = false
    this.mesh.visible = false
    this._spawnTimer = cooldown
    this.stateLabel = label
  }

  _die() {
    this.kills++
    this._despawn(HUSK_RESPAWN_DEAD, 'dying')
    // Report the final frame with the death event; dist Infinity like the
    // dormant branch so the Engine's proximity-slow releases immediately.
    return { caught: false, tension: 0, seen: false, dist: Infinity, inBeam: false, frozen: false, died: true }
  }

  _faceMesh(player) {
    this.mesh.position.set(this.pos.x, this.pos.y + this.mesh.scale.y * 0.95, this.pos.z)
    this.mesh.rotation.y = Math.atan2(player.x - this.pos.x, player.z - this.pos.z)
  }

  // Returns { caught:false, tension, seen, dist, inBeam:false, frozen:false, died }.
  // ctx = { playerCy } (flashlight fields ignored — it just stands there).
  update(dt, player, camera, ctx = {}) {
    const playerCy = ctx.playerCy ?? 0

    if (this.frozen) {
      this.stateLabel = 'hold'
      const d = this.active
        ? Math.hypot(player.x - this.pos.x, (player.y || 0) - this.pos.y, player.z - this.pos.z)
        : Infinity
      return { caught: false, tension: 0, seen: false, dist: d, inBeam: false, frozen: false, died: false }
    }

    // --- Dormant: count down to the next appearance. ---
    if (!this.active) {
      this.stateLabel = 'dormant'
      this._spawnTimer -= dt
      if (this._spawnTimer <= 0) {
        if (this._appear(camera, player, playerCy)) this.active = true
        else this._spawnTimer = 0.4 // confined right now — retry shortly
      }
      if (this.alwaysVisible) this.mesh.visible = true
      return DORMANT
    }

    const dx = player.x - this.pos.x
    const dy = (player.y || 0) - this.pos.y
    const dz = player.z - this.pos.z
    const dist = Math.hypot(dx, dy, dz) // 3D: a floor of separation is distance

    // --- TOUCH: contact destroys it instantly. ---
    if (dist < this.touchDist) return this._die()

    // --- CROWD: sustained closeness destroys it. ---
    if (dist < this.closeDist && playerCy === this.cy) {
      this._closeT += dt
      if (this._closeT >= this.closeKillTime) return this._die()
    } else {
      this._closeT = Math.max(0, this._closeT - dt)
    }

    // --- FADE: the player left it behind. Never vanish while genuinely
    // watched (frustum + LOS inside the fog-opaque range) — the away timer
    // keeps accruing, and it goes the moment they look elsewhere. ---
    const observed = sightGate(this.cm, camera, this.pos, this.cy, player, playerCy, ENTITY_VANISH_DIST)
    if (dist > this.vanishDist || playerCy !== this.cy) {
      this._awayT += dt
      if (this._awayT >= HUSK_AWAY_TIME && !observed) {
        this._despawn(HUSK_RESPAWN_FADE, 'faded')
        return DORMANT
      }
    } else {
      this._awayT = 0
    }

    // It cannot move — it only turns to keep facing the player.
    this.stateLabel = this._closeT > 0 ? 'cornered' : 'watching'
    this._faceMesh(player)
    if (this.alwaysVisible) this.mesh.visible = true

    const seen = sightGate(this.cm, camera, this.pos, this.cy, player, playerCy, this.sightDist)
    // Weak presence: milder tension than the hunters, amplified in view and
    // while the player is inside the kill radius (its stare intensifies).
    let tension = Math.max(0, 1 - dist / 16) * 0.6
    if (seen) tension = Math.min(1, tension + 0.2)
    if (this._closeT > 0) tension = Math.min(1, tension + 0.15)
    return { caught: false, tension, seen, dist, inBeam: false, frozen: false, died: false }
  }
}
