import {
  PROXIMITY_SLOW_MAX,
  PROXIMITY_SLOW_RADIUS,
  STARE_LIMIT_BASE,
  STARE_RECOVER,
  STARE_SANITY_DRAIN,
} from '../world/constants.js'

// Pure survival rules: how threat, flashlight stares, and sanity feed back into
// the player and the screen grade. The Engine owns WHEN these run (per sim
// tick) and WHERE the results go (GameState, Controller.speedMul, the grade
// uniforms); this module owns only the numbers, so the tuning is unit-testable
// without a renderer, DOM, or AudioContext.

const clamp01 = (v) => Math.min(1, Math.max(0, v))

// Sanity drain/recovery per second.
export const SANITY_SEEN_DRAIN = 0.15 // an enemy is in view
export const SANITY_TENSE_DRAIN = 0.05 // unseen but close (tension above the threshold)
export const SANITY_TENSE_THRESHOLD = 0.45
export const SANITY_RECOVER = 0.07

// Seconds the player may hold the flashlight on the Stalker before the freeze
// fails; shrinks with the level (floor 1s) so higher levels punish staring.
export function stareLimit(level) {
  return Math.max(1.0, STARE_LIMIT_BASE - level * 0.12)
}

// `threat` is the merged enemy result (see enemyMerge.js): `seen` and
// `tension` drive the drain; a calm frame recovers toward full sanity.
export function updateSanity(state, dt, threat) {
  if (threat.seen) state.sanity -= dt * SANITY_SEEN_DRAIN
  else if (threat.tension > SANITY_TENSE_THRESHOLD) state.sanity -= dt * SANITY_TENSE_DRAIN
  else state.sanity = Math.min(1, state.sanity + dt * SANITY_RECOVER)
  state.sanity = Math.max(0, state.sanity)
}

// Flashlight "stare" backlash: beaming the Stalker charges exposure; past the
// limit the freeze has already failed (the Stalker's ctx.canFreeze) and the
// player's sanity crashes. stareCharge is the 0..1 HUD readout.
export function updateStare(state, dt, inBeam, limit) {
  if (inBeam) state.exposure += dt
  else state.exposure = Math.max(0, state.exposure - STARE_RECOVER * dt)
  if (state.exposure > limit) state.sanity = Math.max(0, state.sanity - STARE_SANITY_DRAIN * dt)
  state.stareCharge = Math.min(1, state.exposure / limit)
}

// Closer enemy => slower player. `dist` is the closest active enemy; dormant
// ones report Infinity, so no separate active gate is needed.
export function proximitySpeedMul(dist) {
  if (!(dist < PROXIMITY_SLOW_RADIUS)) return 1
  const t = (PROXIMITY_SLOW_RADIUS - dist) / PROXIMITY_SLOW_RADIUS
  return 1 - clamp01(t) * PROXIMITY_SLOW_MAX
}

// Screen-grade targets for the current sanity / stare / threat. NOISE modes:
// 'always' keeps the constant grain floor, 'danger' fades a slightly stronger
// floor in with enemy tension (a calm frame is clean), 'off' silences grain
// entirely — the sanity/stare terms included, so the toggle is a real
// accessibility escape, not just a floor removal. `out` is reused per frame.
export function survivalGrade(state, tension, noiseMode, limit, out = {}) {
  const s = state.sanity
  const e = Math.min(1, state.exposure / limit)
  const grainFloor = noiseMode === 'always' ? 0.022 : 0.03 * tension
  out.vignette = 0.16 + (1 - s) * 0.5 + e * 0.12
  out.grain = noiseMode === 'off' ? 0 : grainFloor + (1 - s) * 0.5 + e * 0.18
  // A calm frame is optically clean (a faint lens fringe only toward the
  // corners); the fringing is a sanity/stare symptom, not a constant filter.
  out.aberration = 0.0008 + (1 - s) * 0.008 + e * 0.006
  return out
}
