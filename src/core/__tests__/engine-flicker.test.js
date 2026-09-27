import { describe, expect, it, vi } from 'vitest'
import { Engine } from '../Engine.js'
import { FLICKER_FULL, FLICKER_SAFE, tubeHum } from '../../world/lampCharacter.js'
import { PANEL_GLOW } from '../../world/constants.js'

// The reduceFlicker setting (photosensitivity) through the real Engine
// methods on a bare engine (Engine.prototype + the fields these paths read),
// the same pattern engine-drs.test.js uses.

function bareEngine(reduceFlicker) {
  const e = Object.create(Engine.prototype)
  const settings = new Map([['reduceFlicker', reduceFlicker]])
  e.settings = { get: (k) => settings.get(k), set: (k, v) => (settings.set(k, v), v) }
  e.lightField = { flicker: null }
  e.deferred = {
    setFlickerProfile: vi.fn(),
    lightUniforms: { uLampFlicker: { value: 1 } },
    panelGlow: 1,
  }
  e.materials = { panel: { uniforms: { uIntensity: { value: 1 } } } }
  e.audio = { flickerDrop: vi.fn() }
  e._time = 1.3
  e._dipT = 10
  e._dipActive = 0
  return e
}

describe('Engine reduceFlicker', () => {
  it('routes one profile to the hum, the CPU lamps and the GPU grid', () => {
    const e = bareEngine(false)
    e._runSetting('reduceFlicker', false)
    expect(e._flicker).toBe(FLICKER_FULL)
    expect(e.lightField.flicker).toBe(FLICKER_FULL)
    expect(e.deferred.setFlickerProfile).toHaveBeenLastCalledWith(FLICKER_FULL)
    e._runSetting('reduceFlicker', true)
    expect(e._flicker).toBe(FLICKER_SAFE)
    expect(e.lightField.flicker).toBe(FLICKER_SAFE)
    expect(e.deferred.setFlickerProfile).toHaveBeenLastCalledWith(FLICKER_SAFE)
  })

  it('a dead-tube dip only sags the lights under the safe profile', () => {
    for (const [on, profile] of [[true, FLICKER_SAFE], [false, FLICKER_FULL]]) {
      const e = bareEngine(on)
      e._runSetting('reduceFlicker', on)
      e._dipActive = 0.12 // mid-dip (a husk death or the random timer)
      e._updateFlicker(1 / 60)
      const f = tubeHum(e._time, true, profile)
      expect(e.materials.panel.uniforms.uIntensity.value).toBeCloseTo(f * PANEL_GLOW, 12)
      expect(e.deferred.lightUniforms.uLampFlicker.value).toBeCloseTo(0.6 + 0.4 * f, 12)
    }
    const safe = bareEngine(true)
    safe._runSetting('reduceFlicker', true)
    safe._updateFlicker(1 / 60)
    const steady = safe.deferred.lightUniforms.uLampFlicker.value
    safe._dipActive = 0.12
    safe._updateFlicker(0)
    // Cast light moves by far less than the 10% flash threshold.
    expect(1 - safe.deferred.lightUniforms.uLampFlicker.value / steady).toBeLessThan(0.05)
  })

  it('leaving a capture replay restores the player setting', () => {
    const e = bareEngine(true)
    e.captureFrozen = true
    e._setFlickerProfile(false) // capture replay pinned the full strobe
    expect(e.lightField.flicker).toBe(FLICKER_FULL)
    e.resumeFromCapture()
    expect(e.captureFrozen).toBe(false)
    expect(e.lightField.flicker).toBe(FLICKER_SAFE)
    expect(e.deferred.setFlickerProfile).toHaveBeenLastCalledWith(FLICKER_SAFE)
  })
})
