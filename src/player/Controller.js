import * as THREE from 'three'
import {
  EYE_H,
  WALK_SPEED,
  SPRINT_SPEED,
  ACCEL,
} from '../world/constants.js'
import { moveAndCollide } from './collision.js'
import { HeadBob } from './headbob.js'

const MAX_PITCH = Math.PI / 2 - 0.05
const STAMINA_DRAIN = 1 / 6 // empty after ~6s of sprint
const STAMINA_REGEN = 1 / 9
const BATTERY_DRAIN = 1 / 90 // ~90s of light

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

// First-person controller: manual pointer-lock + mouse look (robust across
// three.js versions), WASD with acceleration, sprint, and the player's physical
// resources (stamina, flashlight battery).
export class Controller {
  constructor(camera, dom, state) {
    this.camera = camera
    this.dom = dom
    this.state = state
    camera.rotation.order = 'YXZ'

    this.pos = new THREE.Vector3(0, 0, 0) // feet position (XZ plane)
    this.vel = new THREE.Vector3()
    this.yaw = 0
    this.pitch = 0
    this.speed = 0
    this.speedMul = 1 // external movement multiplier (Engine drives enemy-proximity drag)
    this.sensitivity = 0.0022
    this.isLocked = false
    this.inputEnabled = true // debug mode parks the player by disabling this
    this.keys = new Set()
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
    addEventListener('blur', () => this.keys.clear())
    document.addEventListener('mousemove', (e) => {
      if (!this.isLocked) return
      this.yaw -= e.movementX * this.sensitivity
      this.pitch = clamp(this.pitch - e.movementY * this.sensitivity, -MAX_PITCH, MAX_PITCH)
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

  _toggleFlashlight() {
    if (this.state.phase !== 'PLAYING') return
    // A dead battery can't power the light back on (applyFrame auto-kills it at
    // 0); without this guard a depleted battery still grants free light + freeze.
    if (!this.state.flashlightOn && this.state.battery <= 0) return
    this.state.flashlightOn = !this.state.flashlightOn
    this.onToggleFlashlight?.(this.state.flashlightOn)
  }

  teleport(x, z, yaw = 0) {
    this.pos.set(x, 0, z)
    this.vel.set(0, 0, 0)
    this.yaw = yaw
    this.pitch = 0
    this.speed = 0
    this.speedMul = 1
  }

  setBobEnabled(on) {
    this.headbob.enabled = on
  }

  // Physics sub-step (called several times per frame).
  step(dt, cm) {
    const k = this.keys
    // Debug mode disables player input so WASD drives the debug UI / nothing.
    const fz = this.inputEnabled
      ? (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0)
      : 0
    const fx = this.inputEnabled
      ? (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0)
      : 0

    _euler.set(0, this.yaw, 0)
    _fwd.set(0, 0, -1).applyEuler(_euler)
    _right.set(1, 0, 0).applyEuler(_euler)
    _wish.set(0, 0, 0).addScaledVector(_fwd, fz).addScaledVector(_right, fx)
    const moving = _wish.lengthSq() > 0
    if (moving) _wish.normalize()

    const wantSprint = (k.has('ShiftLeft') || k.has('ShiftRight')) && this.state.stamina > 0.02 && moving
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

    const hit = moveAndCollide(cm, this.pos, this.vel.x * dt, this.vel.z * dt)
    if (hit.x) this.vel.x = 0
    if (hit.z) this.vel.z = 0

    this.speed = Math.hypot(this.vel.x, this.vel.z)
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
    cam.position.set(this.pos.x, EYE_H, this.pos.z)
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
