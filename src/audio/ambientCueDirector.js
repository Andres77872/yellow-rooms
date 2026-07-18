import { RNG } from '../world/core/rng.js'

const CUE_SALT = 0x435545

export const AMBIENT_CUE_DEFAULTS = Object.freeze({
  recoverySeconds: 6,
  initialWait: Object.freeze([10, 18]),
  interval: Object.freeze([18, 45]),
  abstainChance: 0.3,
  tensionLimit: 0.2,
})

const range = (value, fallback) => {
  if (!Array.isArray(value) || value.length !== 2) return [...fallback]
  const lo = Number.isFinite(value[0]) ? Math.max(0, value[0]) : fallback[0]
  const candidateHi = Number.isFinite(value[1]) ? value[1] : fallback[1]
  const hi = Math.max(lo, candidateHi)
  return [lo, hi]
}

// Small deterministic pacing layer for non-threatening distant sounds. It
// deliberately does not control enemies: it only prevents ambient fake-outs
// from firing during a real peak or masking a genuine cross-floor footfall.
// Geometry remains independent because this owns a private seed stream.
export class AmbientCueDirector {
  constructor(seed = 0, options = {}) {
    this.options = {
      recoverySeconds: Number.isFinite(options.recoverySeconds)
        ? Math.max(0, options.recoverySeconds)
        : AMBIENT_CUE_DEFAULTS.recoverySeconds,
      initialWait: range(options.initialWait, AMBIENT_CUE_DEFAULTS.initialWait),
      interval: range(options.interval, AMBIENT_CUE_DEFAULTS.interval),
      abstainChance: Number.isFinite(options.abstainChance)
        ? Math.max(0, Math.min(1, options.abstainChance))
        : AMBIENT_CUE_DEFAULTS.abstainChance,
      tensionLimit: Number.isFinite(options.tensionLimit)
        ? Math.max(0, options.tensionLimit)
        : AMBIENT_CUE_DEFAULTS.tensionLimit,
    }
    this.reset(seed)
  }

  reset(seed = 0) {
    this.rng = RNG.fromHash(seed | 0, 0, 0, CUE_SALT)
    this.calmSeconds = 0
    this.waitSeconds = this.rng.range(...this.options.initialWait)
  }

  update(dt, context = {}) {
    if (!Number.isFinite(dt) || dt <= 0) return null
    const tension = Number.isFinite(context.tension) ? context.tension : 0
    const blocked = context.seen === true ||
      context.realVerticalCue === true ||
      tension > this.options.tensionLimit
    if (blocked) {
      this.calmSeconds = 0
      return null
    }

    // Only the part of this frame beyond the recovery boundary advances the
    // scheduled wait. This keeps cue timing stable when a frame straddles the
    // boundary instead of granting a full-frame shortcut.
    const beforeEligible = Math.max(0, this.calmSeconds - this.options.recoverySeconds)
    this.calmSeconds += dt
    const afterEligible = Math.max(0, this.calmSeconds - this.options.recoverySeconds)
    this.waitSeconds -= afterEligible - beforeEligible
    if (this.calmSeconds < this.options.recoverySeconds) return null
    if (this.waitSeconds > 0) return null

    const outcome = this.rng.chance(this.options.abstainChance)
      ? 'abstain'
      : 'distant'
    // Schedule from the opportunity actually processed now. A suspended tab or
    // debugger frame therefore cannot leave several overdue cues queued to
    // burst on consecutive frames.
    this.waitSeconds = this.rng.range(...this.options.interval)
    return outcome
  }
}
