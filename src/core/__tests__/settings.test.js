import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Settings, DEFAULTS, SENS_DEFAULT, SENS_MIN, SENS_MAX, dynamicResEnabled } from '../Settings.js'
import { AUTO_FALLBACK_PRESET } from '../graphics.js'

const KEY = 'yellowrooms.settings'

// Node test env has no localStorage; a Map-backed stub lets us assert what
// actually gets persisted and seed a "previous session" blob.
function stubStorage(initial) {
  const store = new Map(initial ? [[KEY, JSON.stringify(initial)]] : [])
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  })
  return store
}

const saved = (store) => JSON.parse(store.get(KEY))

describe('Settings', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('starts from the defaults when nothing is stored', () => {
    stubStorage()
    const s = new Settings()
    for (const [k, v] of Object.entries(DEFAULTS)) expect(s.get(k)).toBe(v)
  })

  it('restores a stored session', () => {
    stubStorage({ sensitivity: SENS_DEFAULT * 2, invertY: true, minimap: false })
    const s = new Settings()
    expect(s.get('sensitivity')).toBe(SENS_DEFAULT * 2)
    expect(s.get('invertY')).toBe(true)
    expect(s.get('minimap')).toBe(false)
    expect(s.get('bob')).toBe(DEFAULTS.bob) // untouched keys keep their default
  })

  it('persists on every set', () => {
    const store = stubStorage()
    const s = new Settings()
    s.set('invertY', true)
    expect(saved(store).invertY).toBe(true)
  })

  it('setMany coerces every key and persists once', () => {
    const store = stubStorage()
    const s = new Settings()
    const setItem = vi.spyOn(globalThis.localStorage, 'setItem')
    s.setMany({ volume: 7, invertX: true, renderScale: 0.1 })
    expect(setItem).toHaveBeenCalledOnce()
    expect(s.get('volume')).toBe(1)
    expect(s.get('invertX')).toBe(true)
    expect(s.get('renderScale')).toBe(0.5)
    expect(saved(store).invertX).toBe(true)
  })

  it('survives a corrupt blob', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => '{not json',
      setItem: () => {},
    })
    expect(new Settings().get('sensitivity')).toBe(SENS_DEFAULT)
  })

  it('survives storage being unavailable (private mode)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    const s = new Settings()
    expect(() => s.set('volume', 0.5)).not.toThrow()
    expect(s.get('volume')).toBe(0.5) // in-memory value still applies this session
  })

  // A stale/hand-edited blob must never be able to strand the player with dead
  // look, a NaN in the audio gain graph, or a truthy-but-not-boolean toggle.
  it('coerces out-of-range and wrong-typed stored values', () => {
    stubStorage({
      sensitivity: 0,
      volume: 99,
      invertY: 'yes',
      bob: null,
      cameraFx: 'yes',
      noise: 'sometimes',
    })
    const s = new Settings()
    expect(s.get('sensitivity')).toBe(SENS_MIN)
    expect(s.get('volume')).toBe(1)
    expect(s.get('invertY')).toBe(DEFAULTS.invertY)
    expect(s.get('bob')).toBe(DEFAULTS.bob)
    expect(s.get('cameraFx')).toBe(DEFAULTS.cameraFx)
    expect(s.get('noise')).toBe(DEFAULTS.noise)
  })

  it('coerces on set and returns the value actually kept', () => {
    stubStorage()
    const s = new Settings()
    expect(s.set('sensitivity', 999)).toBe(SENS_MAX)
    expect(s.set('sensitivity', Number.NaN)).toBe(SENS_DEFAULT)
    expect(s.set('volume', -1)).toBe(0)
    expect(s.get('sensitivity')).toBe(SENS_DEFAULT)
  })

  // Photosensitivity: the safe flicker profile is the default, so a fresh
  // install, an old blob without the key and a corrupt value all land on it.
  it('reduceFlicker defaults on and only an explicit false turns it off', () => {
    stubStorage()
    expect(DEFAULTS.reduceFlicker).toBe(true)
    expect(new Settings().get('reduceFlicker')).toBe(true)
    stubStorage({ volume: 0.4 }) // a blob from before the setting existed
    expect(new Settings().get('reduceFlicker')).toBe(true)
    stubStorage({ reduceFlicker: 'no' })
    expect(new Settings().get('reduceFlicker')).toBe(true)
    const store = stubStorage({ reduceFlicker: false })
    const s = new Settings()
    expect(s.get('reduceFlicker')).toBe(false)
    expect(s.set('reduceFlicker', 0)).toBe(true) // wrong type -> the safe default
    expect(saved(store).reduceFlicker).toBe(true)
  })

  it('reset restores and persists the defaults', () => {
    const store = stubStorage({ invertY: true, invertX: true, volume: 0.1 })
    const s = new Settings()
    s.reset()
    expect(s.get('invertY')).toBe(false)
    expect(s.get('volume')).toBe(DEFAULTS.volume)
    expect(saved(store)).toEqual(DEFAULTS)
  })
})

// The v1 boot saved its device default preset on every start (it ran the
// preset setting, which persists the whole store), so a stored v1 preset says
// nothing about what the player chose unless it differs from that default.
describe('v1 settings migration', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('moves the boot-stamped v1 default preset to auto', () => {
    expect(AUTO_FALLBACK_PRESET).toBe('high') // node runs as desktop
    stubStorage({ preset: 'high', shadowQuality: 'high', invertY: true })
    const s = new Settings()
    expect(s.get('preset')).toBe('auto')
    expect(s.get('flashShadowQuality')).toBe('high')
    expect(s.get('invertY')).toBe(true)
  })

  it('keeps every v1 preset that was a real choice', () => {
    for (const preset of ['low', 'medium', 'ultra', 'custom']) {
      stubStorage({ preset, shadowQuality: 'medium' })
      expect(new Settings().get('preset'), preset).toBe(preset)
    }
  })

  it('never touches a v2 blob, whatever preset it holds', () => {
    // Every v2 save writes the whole store, flashShadowQuality included.
    stubStorage({ preset: 'high', flashShadowQuality: 'high' })
    expect(new Settings().get('preset')).toBe('high')
  })

  it('runs once: the migrated store saves as v2', () => {
    const store = stubStorage({ preset: 'high', shadowQuality: 'low' })
    const s = new Settings()
    s.set('volume', 0.5)
    expect(saved(store).preset).toBe('auto')
    expect('flashShadowQuality' in saved(store)).toBe(true)
    // The player picks HIGH explicitly afterwards: that choice now sticks.
    s.set('preset', 'high')
    expect(new Settings().get('preset')).toBe('high')
  })
})

describe('dynamicResEnabled', () => {
  const store = (preset, dynamicRes) => ({ get: (k) => (k === 'preset' ? preset : dynamicRes) })

  it('is always on for auto, never for cinematic, the toggle otherwise', () => {
    expect(dynamicResEnabled(store('auto', false))).toBe(true)
    expect(dynamicResEnabled(store('cinematic', true))).toBe(false)
    expect(dynamicResEnabled(store('high', false))).toBe(false)
    expect(dynamicResEnabled(store('high', true))).toBe(true)
    expect(dynamicResEnabled(store('custom', true))).toBe(true)
  })
})
