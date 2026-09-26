import { describe, it, expect } from 'vitest'
import {
  GRAPHICS_PRESETS,
  GRAPHICS_KEYS,
  PRESET_ORDER,
  TIER_ORDER,
  AO_TIERS,
  SHADOW_TIERS,
  FLASH_TIERS,
  VOL_TIERS,
  WORLD_DETAIL_ORDER,
  DEFAULT_PRESET,
  AUTO_FALLBACK_PRESET,
  concretePreset,
  resolveGraphics,
} from '../graphics.js'
import { DEFAULTS, Settings } from '../Settings.js'
import {
  AO_SAMPLES,
  AO_SAMPLES_MAX,
  CAPSULE_MAX,
  CONTACT_STEPS_MAX,
  FLASH_TAPS_MAX,
  FURN_CELLS_MAX,
  FURN_LIGHTS_MAX,
  GTAO_SLICES_MAX,
  GTAO_STEPS_MAX,
  SHADOW_STEPS,
  SHADOW_STEPS_MAX,
  SHADOW_MAX,
  SHADOW_LAMPS_MAX,
  VOL_STEPS_MAX,
  VOL_LIGHTS_MAX,
  VOL_NEAR_STEPS_MAX,
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
      expect(FLASH_TIERS[p.flashShadowQuality], `${name}.flashShadowQuality`).toBeDefined()
      expect(VOL_TIERS[p.volQuality], `${name}.volQuality`).toBeDefined()
      expect(TIER_ORDER).toContain(p.aoQuality)
      expect(WORLD_DETAIL_ORDER).toContain(p.worldDetail)
      expect(p.renderScale).toBeGreaterThanOrEqual(0.5)
      expect(p.renderScale).toBeLessThanOrEqual(1)
    }
  })

  it('no tier exceeds the shader compile-time ceilings', () => {
    for (const t of Object.values(AO_TIERS)) {
      expect(t.samples).toBeLessThanOrEqual(AO_SAMPLES_MAX)
      expect(t.slices).toBeLessThanOrEqual(GTAO_SLICES_MAX)
      expect(t.steps).toBeLessThanOrEqual(GTAO_STEPS_MAX)
      expect(t.boxAOCells).toBeLessThanOrEqual(FURN_CELLS_MAX)
    }
    for (const t of Object.values(SHADOW_TIERS)) {
      expect(t.steps).toBeLessThanOrEqual(SHADOW_STEPS_MAX)
      expect(t.lamps).toBeLessThanOrEqual(SHADOW_LAMPS_MAX)
      expect(t.traced).toBeLessThanOrEqual(8)
      expect(t.furnLights).toBeLessThanOrEqual(FURN_LIGHTS_MAX)
      expect(t.furnCells).toBeLessThanOrEqual(FURN_CELLS_MAX)
      expect(t.capsulesPerEnemy * 3).toBeLessThanOrEqual(CAPSULE_MAX)
      expect(t.contactSteps).toBeLessThanOrEqual(CONTACT_STEPS_MAX)
    }
    for (const t of Object.values(FLASH_TIERS)) expect(t.taps).toBeLessThanOrEqual(FLASH_TAPS_MAX)
    for (const t of Object.values(VOL_TIERS)) {
      expect(t.steps).toBeLessThanOrEqual(VOL_STEPS_MAX)
      expect(t.lights).toBeLessThanOrEqual(VOL_LIGHTS_MAX)
      expect(t.lights).toBeLessThanOrEqual(LIGHT_MAX)
      expect(t.nearSteps).toBeLessThanOrEqual(VOL_NEAR_STEPS_MAX)
    }
  })

  it('tiers cap work, never light: every tier keeps baked wall visibility and grounding', () => {
    // No tier truncates the light list: the shaders always shade all 8
    // entries; a tier only chooses how many are TRACED (the rest keep the
    // baked, wall-aware 6-bit visibility). MINIMAL still grounds enemies.
    for (const [name, t] of Object.entries(SHADOW_TIERS)) {
      expect(t.traced, name).toBeGreaterThanOrEqual(0)
      expect(t.capsuleLights, name).toBeGreaterThanOrEqual(1)
      expect(t.capsulesPerEnemy, name).toBeGreaterThanOrEqual(1)
    }
    // Tiers only ever add work as they climb.
    const rank = (tbl, key) => TIER_ORDER.map((n) => tbl[n][key])
    for (const key of ['traced', 'furnLights', 'furnCells', 'capsuleLights', 'contactSteps']) {
      const v = rank(SHADOW_TIERS, key)
      for (let i = 1; i < v.length; i++) expect(v[i], key).toBeGreaterThanOrEqual(v[i - 1])
    }
    const fs = rank(FLASH_TIERS, 'size')
    for (let i = 1; i < fs.length; i++) expect(fs[i]).toBeGreaterThanOrEqual(fs[i - 1])
  })

  it('no tier specifies a zero trip count', () => {
    // The shaders divide by these (occ/uSamples, marchLength/uSteps). They carry
    // max(...,1) guards, but a zero here would still mean a pass that renders
    // nothing while claiming to be enabled — so keep the floor at the source.
    // 'off' tiers still carry numbers because the renderer clamps and uploads
    // them whether or not the pass runs.
    for (const t of Object.values(AO_TIERS)) expect(t.samples).toBeGreaterThanOrEqual(1)
    for (const t of Object.values(SHADOW_TIERS)) {
      expect(t.steps).toBeGreaterThanOrEqual(1)
      expect(t.lamps).toBeGreaterThanOrEqual(1)
    }
    for (const t of Object.values(VOL_TIERS)) {
      expect(t.steps).toBeGreaterThanOrEqual(1)
      expect(t.lights).toBeGreaterThanOrEqual(1)
    }
  })

  it("'high' keeps the Classic look's legacy SSAO and contact march numbers", () => {
    // The Classic rollback still runs the v1 screen-space passes; its
    // numbers on 'high' are the pre-settings desktop build's.
    expect(AO_TIERS.high.samples).toBe(AO_SAMPLES)
    expect(SHADOW_TIERS.high.steps).toBe(SHADOW_STEPS)
    expect(SHADOW_TIERS.high.lamps).toBe(SHADOW_MAX)
    expect(GRAPHICS_PRESETS.high.renderScale).toBe(1)
    // Fresh installs choose per device; before classification (and in node,
    // which has no touch pointer) 'auto' stands for the desktop 'high'.
    expect(DEFAULT_PRESET).toBe('auto')
    expect(AUTO_FALLBACK_PRESET).toBe('high')
    expect(concretePreset('auto')).toBe('high')
    expect(concretePreset('auto', 'medium')).toBe('medium')
    expect(concretePreset('custom')).toBe(null)
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
        worldDetail: 'low',
        aoQuality: 'off',
        shadowQuality: 'ultra',
        volQuality: 'low',
        bloom: false,
        fxaa: true,
      })
    )
    expect(q.renderScale).toBe(0.75)
    expect(q.worldDetail).toBe('low')
    expect(q.ao.enabled).toBe(false)
    expect(q.shadow).toEqual({ ...SHADOW_TIERS.ultra, tier: 'ultra' })
    // No stored torch tier: it follows the world shadow tier (v1 blobs).
    expect(q.flash).toMatchObject({ ...FLASH_TIERS.ultra, tier: 'ultra' })
    expect(q.vol).toMatchObject({ ...VOL_TIERS.low, tier: 'low' })
    expect(q.bloom).toBe(false)
    expect(q.bloomTail).toBe(false)
    expect(q.fxaa).toBe(true)
  })

  it('falls back to the high tier / sane defaults on a gutted store', () => {
    const q = resolveGraphics(fakeSettings({}))
    expect(q.renderScale).toBe(1)
    expect(q.worldDetail).toBe('high')
    expect(q.ao).toMatchObject({ ...AO_TIERS.high, tier: 'high' })
    expect(q.shadow).toEqual({ ...SHADOW_TIERS.high, tier: 'high' })
    expect(q.vol).toMatchObject({ ...VOL_TIERS.high, tier: 'high' })
    expect(q.bloom).toBe(true)
    expect(q.bloomTail).toBe(true)
    expect(q.fxaa).toBe(true)
    expect(q.cinematic).toBe(false)
  })

  it('cinematic adds the costs no realtime tier pays, and clamps the map to the GPU', () => {
    const q = resolveGraphics(fakeSettings({ preset: 'cinematic', ...GRAPHICS_PRESETS.cinematic }), { maxTextureSize: 1024 })
    expect(q.cinematic).toBe(true)
    expect(q.flash.taps).toBe(24)
    expect(q.flash.size).toBe(1024)
    expect(q.vol.steps).toBe(VOL_STEPS_MAX)
    // Cinematic AO is the ultra tier: the renderer has no full-resolution
    // occlusion resolve, so no dead flag may claim one.
    expect(q.ao).toEqual({ ...AO_TIERS.ultra, tier: 'ultra' })
  })
})

describe('Settings graphics coercion', () => {
  it('fresh defaults are the auto preset over the fallback tiers, expanded', () => {
    expect(DEFAULTS.preset).toBe(DEFAULT_PRESET)
    for (const k of GRAPHICS_KEYS) {
      expect(DEFAULTS[k], k).toEqual(GRAPHICS_PRESETS[AUTO_FALLBACK_PRESET][k])
    }
    expect(new Settings().fresh).toBe(true)
  })

  it('migrates a v1 blob: the torch tier starts at the stored shadow tier', () => {
    const store = new Map([['yellowrooms.settings', JSON.stringify({ preset: 'custom', shadowQuality: 'low' })]])
    const prev = globalThis.localStorage
    globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
    try {
      const s = new Settings()
      expect(s.fresh).toBe(false)
      expect(s.get('flashShadowQuality')).toBe('low')
      expect(s.set('flashShadowQuality', 'bogus')).toBe(DEFAULTS.flashShadowQuality)
      expect(s.set('preset', 'cinematic')).toBe('cinematic')
      expect(s.set('preset', 'auto')).toBe('auto')
    } finally {
      globalThis.localStorage = prev
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
    expect(s.set('worldDetail', 'cinematic')).toBe(DEFAULTS.worldDetail)
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
    // Index == uMode; every strip entry past 'final' must exist as a shader
    // branch (G-buffer v2 added roughness / metalness / material AO).
    expect(CHANNELS.length).toBe(14)
    for (let mode = 10; mode < CHANNELS.length; mode++) {
      expect(DEBUG_VIEW_FRAG).toContain(`uMode == ${mode}`)
    }
    expect(DEBUG_VIEW_FRAG).toContain('tShadow')
    expect(DEBUG_VIEW_FRAG).toContain('tMaterial')
  })
})
