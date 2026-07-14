import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Settings, DEFAULTS, SENS_DEFAULT, SENS_MIN, SENS_MAX } from '../Settings.js'

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
    stubStorage({ sensitivity: 0, volume: 99, invertY: 'yes', bob: null })
    const s = new Settings()
    expect(s.get('sensitivity')).toBe(SENS_MIN)
    expect(s.get('volume')).toBe(1)
    expect(s.get('invertY')).toBe(DEFAULTS.invertY)
    expect(s.get('bob')).toBe(DEFAULTS.bob)
  })

  it('coerces on set and returns the value actually kept', () => {
    stubStorage()
    const s = new Settings()
    expect(s.set('sensitivity', 999)).toBe(SENS_MAX)
    expect(s.set('sensitivity', Number.NaN)).toBe(SENS_DEFAULT)
    expect(s.set('volume', -1)).toBe(0)
    expect(s.get('sensitivity')).toBe(SENS_DEFAULT)
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
