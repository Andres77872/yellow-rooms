import * as THREE from 'three'
import {
  EYE_H,
  WALK_SPEED,
  SPRINT_SPEED,
  ACCEL,
  FLOOR_SWITCH_Y,
  GROUND_SNAP,
  GRAVITY,
  MAX_FALL_SPEED,
  layerY,
  worldToCell,
} from '../world/constants.js'
import { MAP_FAMILY_LATTICE, MAP_FAMILY_TOWER } from '../world/mapTypes.js'
import { moveAndCollide } from './collision.js'
import { groundHeightAt } from './ground.js'
import { HeadBob } from './headbob.js'

const MAX_PITCH = Math.PI / 2 - 0.05
// Thumb travel on a phone is far shorter than mouse travel, so touch look runs
// hotter than the shared sensitivity setting (which still scales it).
const TOUCH_LOOK_MULT = 2.2
const STAMINA_DRAIN = 1 / 6 // empty after ~6s of sprint
const STAMINA_REGEN = 1 / 9
const BATTERY_DRAIN = 1 / 90 // ~90s of light
const UINT32_MAX = 0xffffffff
const HARD_VOID_PLANE_KEYS = Object.freeze(['deathYmm', 'family', 'id'])

const _euler = new THREE.Euler(0, 0, 0, 'YXZ')
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _wish = new THREE.Vector3()

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const approach = (v, target, maxDelta) => {
  const d = target - v
  if (Math.abs(d) <= maxDelta) return target
  return v + Math.sign(d) * maxDelta
}

function exactHardVoidPlane(plane) {
  if (plane === null || typeof plane !== 'object' || Array.isArray(plane)) {
    return false
  }
  const keys = Object.keys(plane).sort()
  return keys.length === HARD_VOID_PLANE_KEYS.length &&
    keys.every((key, index) => key === HARD_VOID_PLANE_KEYS[index]) &&
    Number.isInteger(plane.id) &&
    plane.id >= 0 &&
    plane.id <= UINT32_MAX &&
    (plane.family === MAP_FAMILY_TOWER || plane.family === MAP_FAMILY_LATTICE) &&
    Number.isInteger(plane.deathYmm)
}

// First-person controller: manual pointer-lock + mouse look (robust across
// three.js versions), WASD with acceleration, sprint, and the player's physical
// resources (stamina, flashlight battery).
export class Controller {
  constructor(camera, dom, state) {
    this.camera = camera
    this.dom = dom
    this.state = state
    camera.rotation.order = 'YXZ'

    this.pos = new THREE.Vector3(0, 0, 0) // feet position (y = ground height)
    this.vel = new THREE.Vector3()
    // Vertical state (v8): the floor index selects which layer's walls collide
    // and which lamps/minimap/streaming context apply. `pos.y` follows the
    // ground (stairs are an analytic ramp); `vy` only runs while airborne.
    this.floor = 0
    this.vy = 0
    this.grounded = true
    this.onFloorChange = null // (floor:int) => void, wired by the Engine
    this.onVoidDeath = null // ({id,family}) => void, wired by the Engine
    this._hardVoidPlane = null
    this._hardVoidDeathFired = false
    this.yaw = 0
    this.pitch = 0
    this.speed = 0
    this.speedMul = 1 // external movement multiplier (Engine drives enemy-proximity drag)
    this.sensitivity = 0.0022 // radians per pixel; Engine feeds this from Settings
    this.invertY = false // flight-stick style: pull down to look up
    this.invertX = false
    this.isLocked = false
    this.inputEnabled = true // debug mode parks the player by disabling this
    this.keys = new Set()
    this.move = { x: 0, z: 0 } // analog stick input, unit-clamped by the caller
    this.sprintTouch = false
    this.headbob = new HeadBob()
    this.flashlight = null // SpotLight, set by Engine
    this._prevPhase = 0

    this.onStep = null // footstep callback
    this.onLockChange = null // (locked:boolean) => void
    this.onToggleFlashlight = null

    this._bind()
  }

  _bind() {
    addEventListener('keydown', (e) => {
      this.keys.add(e.code)
      if (e.code === 'KeyF') this._toggleFlashlight()
    })
    addEventListener('keyup', (e) => this.keys.delete(e.code))
    addEventListener('blur', () => {
      this.keys.clear()
      this.move.x = 0
      this.move.z = 0
      this.sprintTouch = false
    })
    document.addEventListener('mousemove', (e) => {
      if (!this.isLocked || !this.inputEnabled) return
      this._look(e.movementX, e.movementY, this.sensitivity)
    })
    document.addEventListener('pointerlockchange', () => {
      this.isLocked = document.pointerLockElement === this.dom
      this.onLockChange?.(this.isLocked)
    })
  }

  lock() {
    try {
      const p = this.dom.requestPointerLock({ unadjustedMovement: true })
      if (p && p.catch) p.catch(() => safeLock(this.dom))
    } catch {
      safeLock(this.dom)
    }
  }
  unlock() {
    document.exitPointerLock?.()
  }

  // Touch look: same integrator as the mousemove handler, minus the pointer-lock
  // gate (touch mode never locks). dx/dy are drag deltas in px.
  lookDelta(dx, dy) {
    if (!this.inputEnabled) return
    this._look(dx, dy, this.sensitivity * TOUCH_LOOK_MULT)
  }

  // The one place look input becomes rotation, so mouse and touch can't drift
  // apart on invert/clamp behaviour. dx/dy are pointer deltas in px, scale is
  // radians per px. Pitch stops just short of the poles so the view never flips.
  _look(dx, dy, scale) {
    this.yaw -= dx * scale * (this.invertX ? -1 : 1)
    const dp = dy * scale * (this.invertY ? -1 : 1)
    this.pitch = clamp(this.pitch - dp, -MAX_PITCH, MAX_PITCH)
  }

  // Touch move: analog vector (x strafe, z forward), caller-clamped to the
  // unit circle; consumed alongside the keyboard in step().
  setMove(x, z, sprint) {
    this.move.x = x
    this.move.z = z
    this.sprintTouch = sprint
  }

  toggleFlashlight() {
    this._toggleFlashlight()
  }

  _toggleFlashlight() {
    if (this.state.phase !== 'PLAYING') return
    // A dead battery can't power the light back on (applyFrame auto-kills it at
    // 0); without this guard a depleted battery still grants free light + freeze.
    if (!this.state.flashlightOn && this.state.battery <= 0) return
    this.state.flashlightOn = !this.state.flashlightOn
    this.onToggleFlashlight?.(this.state.flashlightOn)
  }

  teleport(x, z, cy = 0, yaw = 0) {
    this.pos.set(x, layerY(cy), z)
    this.vel.set(0, 0, 0)
    this.floor = cy
    this.vy = 0
    this.grounded = true
    this.yaw = yaw
    this.pitch = 0
    this.speed = 0
    this.speedMul = 1
    this._hardVoidPlane = null
    this._hardVoidDeathFired = false
  }

  setBobEnabled(on) {
    this.headbob.enabled = on
  }

  // Physics sub-step (called several times per frame).
  step(dt, cm) {
    const k = this.keys
    // Debug mode disables player input so WASD drives the debug UI / nothing.
    const fz = this.inputEnabled
      ? (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) -
        (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) +
        this.move.z
      : 0
    const fx = this.inputEnabled
      ? (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) -
        (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) +
        this.move.x
      : 0

    _euler.set(0, this.yaw, 0)
    _fwd.set(0, 0, -1).applyEuler(_euler)
    _right.set(1, 0, 0).applyEuler(_euler)
    _wish.set(0, 0, 0).addScaledVector(_fwd, fz).addScaledVector(_right, fx)
    const moving = _wish.lengthSq() > 0
    // Clamp to the unit circle instead of normalizing so analog (touch stick)
    // deflection < 1 scales the speed; identical to normalize for keyboard.
    const wl = _wish.length()
    if (wl > 1) _wish.multiplyScalar(1 / wl)

    const wantSprint =
      (k.has('ShiftLeft') || k.has('ShiftRight') || this.sprintTouch) &&
      this.state.stamina > 0.02 &&
      moving
    // speedMul (<=1) is the enemy-proximity drag set by the Engine each frame.
    const speed = (wantSprint ? SPRINT_SPEED : WALK_SPEED) * this.speedMul

    // Stamina
    if (wantSprint) this.state.stamina = Math.max(0, this.state.stamina - STAMINA_DRAIN * dt)
    else this.state.stamina = Math.min(1, this.state.stamina + STAMINA_REGEN * dt)

    const tx = _wish.x * speed
    const tz = _wish.z * speed
    const md = ACCEL * dt
    this.vel.x = approach(this.vel.x, tx, md)
    this.vel.z = approach(this.vel.z, tz, md)

    const hit = moveAndCollide(cm, this.pos, this.vel.x * dt, this.vel.z * dt, this.floor)
    if (hit.x) this.vel.x = 0
    if (hit.z) this.vel.z = 0

    // Vertical resolve (v8). Grounded movement is glue-to-ground: the stair
    // ramp rises ~0.05u per substep, far inside GROUND_SNAP, so walking stairs
    // is pure snap-follow (GROUND_SNAP doubles as the max climb rate — a
    // bigger instantaneous ground jump becomes a fall/land, not a teleport).
    // The gravity branch is a safety net for teleports/debug drops only: in
    // normal play every hole edge is either guard-walled or opens onto the
    // ramp top at the same height.
    if (!this._hardVoidPlane && typeof cm?.hardVoidAt === 'function') {
      const plane = cm.hardVoidAt(
        worldToCell(this.pos.x),
        worldToCell(this.pos.z),
        this.floor
      )
      if (exactHardVoidPlane(plane)) {
        // Copy the validated value. The loaded chunk may unload immediately
        // after entry; no mutable adapter result can replace the authored plane.
        this._hardVoidPlane = {
          id: plane.id,
          family: plane.family,
          deathYmm: plane.deathYmm,
        }
      }
    }

    if (this._hardVoidPlane) {
      this.vy = Math.max(this.vy - GRAVITY * dt, -MAX_FALL_SPEED)
      this.pos.y += this.vy * dt
      this.grounded = false
    } else {
      const g = groundHeightAt(cm, this.pos.x, this.pos.z, this.floor)
      if (this.pos.y <= g + GROUND_SNAP && this.vy <= 0) {
        this.pos.y = g
        this.vy = 0
        this.grounded = true
      } else {
        this.vy = Math.max(this.vy - GRAVITY * dt, -MAX_FALL_SPEED)
        this.pos.y += this.vy * dt
        this.grounded = false
        if (this.pos.y <= g) {
          this.pos.y = g
          this.vy = 0
          this.grounded = true
        }
      }
    }

    // Floor handoff with hysteresis: flip mid-ramp, well clear of the two
    // stamped edges the layers' rasters disagree on (see FLOOR_SWITCH_Y). The
    // +-2.8 band means a flip needs 2.0u of vertical travel to flip back, so
    // jitter at the threshold can never thrash the floor index.
    const yRel = this.pos.y - layerY(this.floor)
    if (yRel >= FLOOR_SWITCH_Y) this._setFloor(this.floor + 1)
    else if (yRel <= -FLOOR_SWITCH_Y) this._setFloor(this.floor - 1)

    if (
      this._hardVoidPlane &&
      !this._hardVoidDeathFired &&
      this.pos.y <= this._hardVoidPlane.deathYmm / 1000
    ) {
      this._hardVoidDeathFired = true
      this.onVoidDeath?.({
        id: this._hardVoidPlane.id,
        family: this._hardVoidPlane.family,
      })
    }

    this.speed = Math.hypot(this.vel.x, this.vel.z)
  }

  _setFloor(f) {
    if (f === this.floor) return
    this.floor = f
    this.onFloorChange?.(f)
  }

  // Per-frame: resources, camera transform, footsteps.
  applyFrame(dt) {
    // Flashlight battery
    if (this.state.flashlightOn && this.state.battery > 0) {
      this.state.battery = Math.max(0, this.state.battery - BATTERY_DRAIN * dt)
      if (this.state.battery <= 0) {
        this.state.flashlightOn = false
        this.onToggleFlashlight?.(false)
      }
    }
    if (this.flashlight) this.flashlight.intensity = this.state.flashlightOn ? 6 : 0

    // Head-bob + camera
    const moving = this.speed > 0.4
    this.headbob.update(dt, this.speed, moving)
    const cam = this.camera
    cam.position.set(this.pos.x, this.pos.y + EYE_H, this.pos.z)
    cam.position.y += this.headbob.bobY
    cam.position.addScaledVector(_right.set(1, 0, 0).applyEuler(_euler.set(0, this.yaw, 0)), this.headbob.bobX)
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ')

    // Footstep on each downward bob crossing
    const phase = this.headbob.phase
    if (this._prevPhase >= 0 && phase < 0 && moving) this.onStep?.(this.speed)
    this._prevPhase = phase
  }
}

function safeLock(dom) {
  try {
    const p = dom.requestPointerLock()
    if (p && p.catch) p.catch(() => {})
  } catch {
    /* ignore (e.g. called outside a user gesture) */
  }
}
