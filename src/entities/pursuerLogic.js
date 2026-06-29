import {
  WALK_SPEED,
  PURSUER_SPEED_MULT,
  PURSUER_SPEED_PER_LEVEL,
  PURSUER_SPEED_CAP,
} from '../world/constants.js'

// Pure (THREE-free) decision helpers for the Pursuer, split out so they can be
// unit-tested in isolation from the rendering/scene plumbing.

// Constant chase speed for a level — always below WALK_SPEED so a walking player
// can open distance, but it never stops. Level 1 sits at exactly the base mult.
export function pursuerSpeed(level) {
  const mult = Math.min(PURSUER_SPEED_CAP, PURSUER_SPEED_MULT + (level - 1) * PURSUER_SPEED_PER_LEVEL)
  return WALK_SPEED * mult
}

// Relocate only when it has fallen strictly past the leash AND the anti-thrash
// cooldown has elapsed.
export function shouldRelocate(dist, leash, relocTimer) {
  return dist > leash && relocTimer <= 0
}

// Clamp a distance into the relocate band [min,max].
export function clampBandDist(dist, min, max) {
  return Math.max(min, Math.min(max, dist))
}

// LOS clear -> a straight beeline is valid; otherwise route with the pathfinder.
export function decideMode(los) {
  return los ? 'beeline' : 'path'
}
