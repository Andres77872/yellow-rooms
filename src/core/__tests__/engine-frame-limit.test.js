import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from '../Engine.js'
import { Phase } from '../GameState.js'

// Frame pacing (engine-improvement chapter 15): the FRAME RATE LIMIT setting
// for live phases, and the pause screen holding its last frame. Driven
// through the real _shouldRender / _runSetting / _configureDynamicResolution
// on a bare engine (Engine.prototype + the fields these paths read), the
// same pattern as engine-drs.test.js.

function bareEngine({ frameLimit = 'off', preset = 'high', gpu = true } = {}) {
  const e = Object.create(Engine.prototype)
  const settings = new Map([
    ['preset', preset],
    ['dynamicRes', true],
    ['frameLimit', frameLimit],
  ])
  e.settings = {
    get: (k) => settings.get(k),
    set: (k, v) => (settings.set(k, v), v),
  }
  e.state = { phase: Phase.PLAYING }
  e.renderer = { setPixelRatio: vi.fn() }
  e.deferred = {
    setFrameTiming: vi.fn(() => gpu),
    pollFrameMs: vi.fn(() => 5),
    setSize: vi.fn(),
    lightingPending: false,
  }
  e.debugMode = { active: false, freeze: false }
  e.debug = { visible: false }
  e._runSetting('frameLimit', frameLimit)
  return e
}

// rAF callbacks on a `hz` display for `seconds` (optional deterministic
// jitter in ms); returns the times of the callbacks that rendered.
function callbacks(e, { hz, seconds = 2, phase = Phase.PLAYING, start = 1000, jitter = 0, from = 0 }) {
  const period = 1000 / hz
  const rendered = []
  for (let i = from; i < from + Math.round(hz * seconds); i++) {
    const wobble = jitter ? ((((i * 7919) % 11) - 5) / 5) * jitter : 0
    const now = start + i * period + wobble
    if (e._shouldRender(now, phase)) rendered.push(now)
  }
  return rendered
}

const intervals = (times) => times.slice(1).map((t, i) => t - times[i])

beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('frame rate limit while playing', () => {
  it('OFF draws on every refresh, as before the setting existed', () => {
    const e = bareEngine()
    expect(callbacks(e, { hz: 160 })).toHaveLength(320)
  })

  it('a number caps the average rate on a faster display, without bursts', () => {
    const e = bareEngine({ frameLimit: 60 })
    const r = callbacks(e, { hz: 160, seconds: 4 })
    expect(r.length).toBeGreaterThanOrEqual(239)
    expect(r.length).toBeLessThanOrEqual(241)
    // Uneven on a refresh it does not divide, but never two in a row and
    // never a skipped extra refresh.
    for (const dt of intervals(r)) {
      expect(dt).toBeGreaterThanOrEqual(1000 / 160 * 2 - 1e-6)
      expect(dt).toBeLessThanOrEqual(1000 / 160 * 3 + 1e-6)
    }
  })

  it('a limit equal to the refresh rate drops no frame under timestamp jitter', () => {
    for (const hz of [60, 144]) {
      const e = bareEngine({ frameLimit: hz })
      expect(callbacks(e, { hz, jitter: 0.5 })).toHaveLength(hz * 2)
      const late = bareEngine({ frameLimit: hz }) // first frame at the late edge
      expect(callbacks(late, { hz, jitter: 0.5, from: 3 })).toHaveLength(hz * 2)
    }
  })

  it('½ REFRESH draws every second callback, evenly paced', () => {
    const e = bareEngine({ frameLimit: 'half' })
    const r = callbacks(e, { hz: 160 })
    expect(r).toHaveLength(160)
    for (const dt of intervals(r)) expect(dt).toBeCloseTo(2000 / 160, 6)
  })

  it('restarts from now after a hitch instead of catching up', () => {
    const e = bareEngine({ frameLimit: 30 })
    callbacks(e, { hz: 120, seconds: 1 })
    // 500 ms without callbacks (a stall), then the display resumes.
    const r = callbacks(e, { hz: 120, seconds: 1, start: 2500 })
    expect(intervals(r).every((dt) => dt > 1000 / 60)).toBe(true)
    expect(r.length).toBeLessThanOrEqual(31)
  })

  it('applies to DEAD and TRANSITION, not to F2 debug mode', () => {
    const e = bareEngine({ frameLimit: 30 })
    expect(callbacks(e, { hz: 120, phase: Phase.DEAD }).length).toBeLessThanOrEqual(61)
    expect(callbacks(e, { hz: 120, phase: Phase.TRANSITION, start: 5000 }).length).toBeLessThanOrEqual(61)
    e.debugMode.active = true
    expect(callbacks(e, { hz: 120, start: 9000 })).toHaveLength(240)
  })

  it('changing the limit takes effect on the next callback', () => {
    const e = bareEngine({ frameLimit: 30 })
    callbacks(e, { hz: 120, seconds: 1 })
    e._runSetting('frameLimit', 'off')
    expect(callbacks(e, { hz: 120, seconds: 1, start: 2000 })).toHaveLength(120)
  })
})

describe('dynamic resolution under a frame limit', () => {
  function withDrs(frameLimit, { displayHz } = {}) {
    vi.stubGlobal('innerWidth', 1920)
    vi.stubGlobal('innerHeight', 1080)
    vi.stubGlobal('devicePixelRatio', 1)
    const e = bareEngine({ frameLimit })
    if (displayHz) e._displayHz = displayHz
    e._configureDynamicResolution({ renderScale: 1 })
    return e
  }

  it('keeps the 60 fps budget when uncapped or capped at 60 fps or more', () => {
    for (const lim of ['off', 60, 120, 144]) expect(withDrs(lim)._drs.budgetMs).toBeCloseTo(1000 / 60, 6)
    expect(withDrs('half', { displayHz: 160 })._drs.budgetMs).toBeCloseTo(1000 / 60, 6)
  })

  it('lets a frame use the whole capped interval below 60 fps', () => {
    expect(withDrs(30)._drs.budgetMs).toBeCloseTo(1000 / 30, 6)
    expect(withDrs('half', { displayHz: 60 })._drs.budgetMs).toBeCloseTo(1000 / 30, 6)
  })

  it('follows a limit changed in play', () => {
    const e = withDrs('off')
    e._runSetting('frameLimit', 30)
    expect(e._drs.budgetMs).toBeCloseTo(1000 / 30, 6)
    e._runSetting('frameLimit', 'off')
    expect(e._drs.budgetMs).toBeCloseTo(1000 / 60, 6)
  })
})

describe('pause screen holds its last frame', () => {
  it('draws at 30 Hz while it settles, then stops', () => {
    const e = bareEngine()
    const r = callbacks(e, { hz: 120, seconds: 6, phase: Phase.PAUSED })
    expect(r.length).toBeGreaterThan(80)
    expect(r.length).toBeLessThan(100)
    expect(r.at(-1)).toBeLessThanOrEqual(1000 + 3000 + 1e-6)
  })

  it('draws again after a setting changes, then holds again', () => {
    const e = bareEngine()
    callbacks(e, { hz: 120, seconds: 6, phase: Phase.PAUSED })
    e._invalidateIdleRender()
    const r = callbacks(e, { hz: 120, seconds: 6, phase: Phase.PAUSED, start: 7000 })
    expect(r[0]).toBe(7000)
    expect(r.length).toBeGreaterThan(80)
    expect(r.at(-1)).toBeLessThanOrEqual(7000 + 3000 + 1e-6)
  })

  it('keeps drawing while a lighting build is still compiling', () => {
    const e = bareEngine()
    e.deferred.lightingPending = true
    const r = callbacks(e, { hz: 120, seconds: 6, phase: Phase.PAUSED })
    expect(r.at(-1)).toBeGreaterThan(1000 + 5500)
    e.deferred.lightingPending = false
    const after = callbacks(e, { hz: 120, seconds: 6, phase: Phase.PAUSED, start: 7000 })
    expect(after.length).toBeGreaterThan(80) // the settle time after it lands
    expect(after.at(-1)).toBeLessThanOrEqual(7000 + 3000 + 1e-6)
  })

  it('the title keeps its animated backdrop', () => {
    const e = bareEngine()
    expect(callbacks(e, { hz: 120, seconds: 6, phase: Phase.TITLE }).length).toBeGreaterThan(170)
  })
})
