import { describe, it, expect } from 'vitest'
import {
  FOG_DENSITY,
  FAR,
  LOAD_RADIUS,
  CHUNK_WORLD,
  LAMP_QUERY_R,
  LAMP_FADE_BAND,
  ENTITY_VANISH_DIST,
  NEAR,
} from '../constants.js'

// The draw-distance contract. FOG_DENSITY, FAR, LOAD_RADIUS and LAMP_QUERY_R
// are one coupled system: fog must be effectively opaque before geometry
// streams in/out, the far plane must not clip visible haze, and lamp pools may
// only enter/leave the shaded set where fog already dominates. Retuning any of
// these WITHOUT the others silently reintroduces the pop-in this guards.
const fogAt = (d) => 1 - Math.exp(-((FOG_DENSITY * d) ** 2))

describe('fog / streaming / far-plane coupling', () => {
  // Worst case: the player stands at a chunk edge, so guaranteed loaded
  // geometry extends only (LOAD_RADIUS - 0.5) chunks along an axis.
  const guaranteedLoaded = (LOAD_RADIUS - 0.5) * CHUNK_WORLD

  it('fog hides the chunk streaming edge (no visible geometry pop-in)', () => {
    expect(fogAt(guaranteedLoaded)).toBeGreaterThanOrEqual(0.98)
  })

  it('far plane sits at/beyond effective fog opacity (no visible far clip)', () => {
    expect(fogAt(FAR)).toBeGreaterThanOrEqual(0.995)
  })

  it('far plane covers everything guaranteed loaded', () => {
    expect(FAR).toBeGreaterThan(guaranteedLoaded)
  })

  it('lamp set-membership changes happen where fog already dominates (>= 50%)', () => {
    // Set membership (LightField candidate list) changes exactly at
    // LAMP_QUERY_R — that boundary is where a pop COULD happen, so fog must
    // dominate there. (Not the pool's far edge, which is more fogged and would
    // pass even with the fade mechanism deleted.)
    expect(fogAt(LAMP_QUERY_R)).toBeGreaterThanOrEqual(0.5)
  })

  it('the shader-side lamp fade band exists and is wide enough to hide churn', () => {
    // The smoothstep fade over the last LAMP_FADE_BAND units of the query
    // radius is the mechanism that makes set churn invisible (a lamp enters
    // the set at zero contribution and ramps in). A shrunk/deleted band
    // reintroduces the hard pool snap this file exists to prevent — and
    // FADE_BAND = 0 would also make the GLSL smoothstep edges equal, which is
    // undefined behavior.
    expect(LAMP_FADE_BAND).toBeGreaterThanOrEqual(8)
    expect(LAMP_FADE_BAND).toBeLessThan(LAMP_QUERY_R)
  })

  it('entities may only vanish in frustum where fog is effectively opaque', () => {
    // Stalker despawn / hunt-teleport and Pursuer relocates are deferred while
    // the entity is observed within ENTITY_VANISH_DIST (sense gate); past it
    // the haze must genuinely swallow the silhouette.
    expect(fogAt(ENTITY_VANISH_DIST)).toBeGreaterThanOrEqual(0.95)
    expect(ENTITY_VANISH_DIST).toBeLessThan(FAR)
  })

  it('near plane clears the closest possible wall approach', () => {
    // PLAYER_R 0.5 minus wall collision half-thickness 0.08, minus head-bob
    // sway ~0.05 -> the eye never gets closer than ~0.3u to a surface.
    expect(NEAR).toBeLessThanOrEqual(0.3)
  })
})
