import { describe, it, expect } from 'vitest'
import {
  GRAPHICS_PRESETS,
  GRAPHICS_KEYS,
  PRESET_ORDER,
  TIER_ORDER,
  AO_TIERS,
  SHADOW_TIERS,
  VOL_TIERS,
  DEFAULT_PRESET,
  resolveGraphics,
} from '../graphics.js'
import { DEFAULTS, Settings } from '../Settings.js'
import {
  AO_SAMPLES,
  AO_SAMPLES_MAX,
  SHADOW_STEPS,
  SHADOW_STEPS_MAX,
  SHADOW_MAX,
  SHADOW_LAMPS_MAX,
  VOL_STEPS,
  VOL_STEPS_MAX,
  VOL_LIGHT_MAX,
  VOL_LIGHTS_MAX,
  LIGHT_MAX,
} from '../../world/constants.js'

const fakeSettings = (data) => ({ get: (k) => data[k] })

describe('graphics presets / tiers', () => {
  it('every preset pins exactly the advanced graphics keys', () => {
    for (const name of PRESET_ORDER) {
      const preset = GRAPHICS_PRESETS[name]
      expect(preset, name).toBeDefined()
      expect(Object.keys(preset).sort()).toEqual([...GRAPHICS_KEYS].sort())
    }
  })

  it('every preset references tiers that exist', () => {
    for (const name of PRESET_ORDER) {
      const p = GRAPHICS_PRESETS[name]
      expect(AO_TIERS[p.aoQuality], `${name}.aoQuality`).toBeDefined()
      expect(SHADOW_TIERS[p.shadowQuality], `${name}.shadowQuality`).toBeDefined()
      expect(VOL_TIERS[p.volQuality], `${name}.volQuality`).toBeDefined()
      expect(TIER_ORDER).toContain(p.aoQuality)
      expect(p.renderScale).toBeGreaterThanOrEqual(0.5)
      expect(p.renderScale).toBeLessThanOrEqual(1)
    }
  })

  it('no tier exceeds the shader compile-time ceilings', () => {
    for (const t of Object.values(AO_TIERS)) expect(t.samples).toBeLessThanOrEqual(AO_SAMPLES_MAX)
    for (const t of Object.values(SHADOW_TIERS)) {
      expect(t.steps).toBeLessThanOrEqual(SHADOW_STEPS_MAX)
      expect(t.lamps).toBeLessThanOrEqual(SHADOW_LAMPS_MAX)
    }
    for (const t of Object.values(VOL_TIERS)) {
      expect(t.steps).toBeLessThanOrEqual(VOL_STEPS_MAX)
      expect(t.lights).toBeLessThanOrEqual(VOL_LIGHTS_MAX)
      expect(t.lights).toBeLessThanOrEqual(LIGHT_MAX)
    }
  })

  it("the 'high' tier is the legacy desktop tuning (default look unchanged)", () => {
    expect(AO_TIERS.high).toEqual({ enabled: true, samples: AO_SAMPLES })
    expect(SHADOW_TIERS.high).toEqual({ enabled: true, steps: SHADOW_STEPS, lamps: SHADOW_MAX })
    expect(VOL_TIERS.high).toEqual({ enabled: true, steps: VOL_STEPS, lights: VOL_LIGHT_MAX })
    expect(GRAPHICS_PRESETS.high.renderScale).toBe(1)
    // Node has no touch pointer, so the resolved default preset here is the
    // desktop one — which must be 'high' to keep the pre-settings look.
    expect(DEFAULT_PRESET).toBe('high')
  })

  it('off tiers disable their pass', () => {
    expect(AO_TIERS.off.enabled).toBe(false)
    expect(SHADOW_TIERS.off.enabled).toBe(false)
    expect(VOL_TIERS.off.enabled).toBe(false)
  })
})

describe('resolveGraphics', () => {
  it('resolves stored tiers into renderer numbers', () => {
    const q = resolveGraphics(
      fakeSettings({
        renderScale: 0.75,
        aoQuality: 'off',
        shadowQuality: 'ultra',
        volQuality: 'low',
        bloom: false,
        fxaa: true,
      })
    )
    expect(q.renderScale).toBe(0.75)
    expect(q.ao.enabled).toBe(false)
    expect(q.shadow).toEqual(SHADOW_TIERS.ultra)
    expect(q.vol).toEqual(VOL_TIERS.low)
    expect(q.bloom).toBe(false)
    expect(q.fxaa).toBe(true)
  })

  it('falls back to the high tier / sane defaults on a gutted store', () => {
    const q = resolveGraphics(fakeSettings({}))
    expect(q.renderScale).toBe(1)
    expect(q.ao).toEqual(AO_TIERS.high)
    expect(q.shadow).toEqual(SHADOW_TIERS.high)
    expect(q.vol).toEqual(VOL_TIERS.high)
    expect(q.bloom).toBe(true)
    expect(q.fxaa).toBe(true)
  })
})

describe('Settings graphics coercion', () => {
  it('fresh defaults are the device preset, expanded', () => {
    expect(DEFAULTS.preset).toBe(DEFAULT_PRESET)
    for (const k of GRAPHICS_KEYS) {
      expect(DEFAULTS[k], k).toEqual(GRAPHICS_PRESETS[DEFAULT_PRESET][k])
    }
  })

  it('rejects hostile stored values (no out-of-range loop counts can reach a shader)', () => {
    const s = new Settings()
    expect(s.set('preset', 'nonsense')).toBe(DEFAULTS.preset)
    expect(s.set('preset', 'custom')).toBe('custom')
    expect(s.set('aoQuality', 'ludicrous')).toBe(DEFAULTS.aoQuality)
    expect(s.set('shadowQuality', 42)).toBe(DEFAULTS.shadowQuality)
    expect(s.set('volQuality', null)).toBe(DEFAULTS.volQuality)
    expect(s.set('renderScale', 99)).toBe(1)
    expect(s.set('renderScale', 0.01)).toBe(0.5)
    expect(s.set('renderScale', NaN)).toBe(DEFAULTS.renderScale)
    expect(s.set('bloom', 'yes')).toBe(DEFAULTS.bloom)
    expect(s.set('fxaa', false)).toBe(false)
  })
})

describe('debug channel viewer', () => {
  it('the channel strip and the debug shader agree on the mode range', async () => {
    const [{ CHANNELS }, { DEBUG_VIEW_FRAG }] = await Promise.all([
      import('../../debug/LightTool.js'),
      import('../../render/shaders/debugView.js'),
    ])
    // Index == uMode; the highest strip entry must exist as a shader branch.
    expect(CHANNELS.length).toBe(11)
    expect(DEBUG_VIEW_FRAG).toContain(`uMode == ${CHANNELS.length - 1}`)
    expect(DEBUG_VIEW_FRAG).toContain('tShadow')
  })
})
