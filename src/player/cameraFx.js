import { MAX_FALL_SPEED } from '../world/constants.js'

const FOV_KICK = 5 // deg added at full sprint
const FOV_IN_RATE = 9 // 1/s exponential ease into the kick
const FOV_OUT_RATE = 5 // 1/s ease back out (slower, so stopping feels soft)
const LEAN_MAX = 0.02 // rad (~1.1°) roll at full-speed strafe
const LEAN_RATE = 10 // 1/s
const DIP_MIN = 0.04 // m dip at the landing-cue threshold
const DIP_RANGE = 0.12 // m extra dip at terminal fall speed (0.16 max total)
const DIP_DUR = 0.38 // s

// Exponential ease that SNAPS onto the target once close enough. The snap
// matters for fovOffset: the Controller only calls updateProjectionMatrix when
// the fov actually changed, so settling exactly stops the per-frame cost.
const ease = (v, target, rate, dt, snap) => {
  const n = v + (target - v) * (1 - Math.exp(-rate * dt))
  return Math.abs(target - n) < snap ? target : n
}

// Camera feel effects independent of head bob: sprint FOV kick, landing dip,
// strafe lean. All offsets, applied by Controller.applyFrame AFTER collision.
// Disabling eases nothing — Controller.resetCameraFx snaps the camera home so
// a pause-menu toggle can't leave a kicked FOV frozen behind the overlay.
export class CameraFx {
  constructor() {
    this.enabled = true
    this.fovOffset = 0 // deg, added to the camera's base fov
    this.lean = 0 // rad roll, - leans right
    this._dipT = 0
    this._dipDepth = 0
  }

  // strafe is rightward velocity as a fraction of sprint speed, in [-1, 1].
  update(dt, sprinting, strafe) {
    const fovTarget = this.enabled && sprinting ? FOV_KICK : 0
    const fovRate = fovTarget > this.fovOffset ? FOV_IN_RATE : FOV_OUT_RATE
    this.fovOffset = ease(this.fovOffset, fovTarget, fovRate, dt, 0.01)
    const leanTarget = this.enabled ? -strafe * LEAN_MAX : 0
    this.lean = ease(this.lean, leanTarget, LEAN_RATE, dt, 1e-4)
    this._dipT = Math.max(0, this._dipT - dt)
  }

  notifyLand(fallSpeed) {
    if (!this.enabled) return
    const k = Math.min(1, fallSpeed / MAX_FALL_SPEED)
    this._dipDepth = DIP_MIN + DIP_RANGE * k
    this._dipT = DIP_DUR
  }

  get dipY() {
    if (this._dipT <= 0) return 0
    // Skewed half-sine: bottoms out in the first ~35%, recovers smoothly.
    const u = 1 - this._dipT / DIP_DUR
    return -this._dipDepth * Math.sin(Math.PI * Math.pow(u, 0.65))
  }

  get roll() {
    return this.lean
  }

  reset() {
    this.fovOffset = 0
    this.lean = 0
    this._dipT = 0
  }
}
