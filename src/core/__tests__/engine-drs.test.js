import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from '../Engine.js'
import { Phase } from '../GameState.js'
import { GPU_PROFILE_KEY, loadGpuProfile, rendererKeyHash, saveGpuProfile, BENCH_VERSION } from '../../render/gpuProfile.js'

// Dynamic resolution, the auto benchmark and the in-session guard as one
// system, driven through the real Engine methods and the real
// DynamicResolution on a bare engine (Engine.prototype + the few fields these
// paths read) — the same pattern the UI tests use for overlays.

function stubViewport(w, h, dpr) {
  vi.stubGlobal('innerWidth', w)
  vi.stubGlobal('innerHeight', h)
  vi.stubGlobal('devicePixelRatio', dpr)
}

function stubStorage() {
  const store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  })
  return store
}

function bareEngine({ preset = 'auto', gpu = true, autoPreset = 'medium', cls = 'integrated', score = null } = {}) {
  const e = Object.create(Engine.prototype)
  const settings = new Map([
    ['preset', preset],
    ['dynamicRes', false],
  ])
  e.settings = {
    get: (k) => settings.get(k),
    set: (k, v) => (settings.set(k, v), v),
  }
  e.state = { phase: Phase.PLAYING }
  e.renderer = { setPixelRatio: vi.fn() }
  e.gpuMs = () => null
  e.deferred = {
    setFrameTiming: vi.fn(() => gpu),
    pollFrameMs: vi.fn(() => e.gpuMs(e._drs.scale)),
    setSize: vi.fn(),
  }
  e.debugMode = { active: false, freeze: false }
  e.ui = { setAutoPreset: vi.fn() }
  e.gpu = { cls, key: 'k', autoPreset, score }
  e._renderScale = 1
  // Applying a preset is the graphics pipeline's business; here it only
  // re-bounds the controller at the new preset's scale, like _applyGraphics.
  e._runSetting = vi.fn(() => e._configureDynamicResolution({ renderScale: e.gpu.autoPreset === 'low' ? 0.75 : 1 }))
  return e
}

// One rendered frame every `intervalMs` for `seconds` of live play.
function play(e, { seconds, intervalMs = 1000 / 60, start = 2000 }) {
  let t = start
  while (t < start + seconds * 1000) {
    t += intervalMs
    e._sampleDynamicResolution(t, intervalMs)
  }
  return t
}

beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('dynamic resolution works on the native backing store', () => {
  it('scales the post-clamp ratio, so every step changes pixels on a budget-clamped display', () => {
    // 2560x1440 CSS at DPR 2: the 4K budget clamps the native ratio to 1.5.
    stubViewport(2560, 1440, 2)
    const e = bareEngine()
    e._configureDynamicResolution({ renderScale: 1 })
    e._drs.configure({ ceiling: 0.8 })
    e._applyPixelRatio()
    expect(e.renderer.setPixelRatio).toHaveBeenLastCalledWith(1.5 * 0.8)
    // The floor is 0.6 OF NATIVE, not of the unclamped DPR.
    e._drs.configure({ ceiling: 0.6 })
    e._applyPixelRatio()
    expect(e.renderer.setPixelRatio).toHaveBeenLastCalledWith(1.5 * 0.6)
  })

  it('puts the preset ceiling in native terms: where the budget clamp swallows it, DRS does too', () => {
    stubViewport(2560, 1440, 2)
    const e = bareEngine()
    expect(e._drsCeiling(0.75)).toBe(1)
    stubViewport(1920, 1080, 1)
    expect(e._drsCeiling(0.75)).toBe(0.75)
    expect(e._drsCeiling(1)).toBe(1)
  })

  it('a fixed render scale keeps the pre-clamp rule when DRS is off', () => {
    stubViewport(2560, 1440, 2)
    const e = bareEngine({ preset: 'high' })
    e._renderScale = 0.5
    e._configureDynamicResolution({ renderScale: 0.5 })
    expect(e._drs).toBeNull()
    e._applyPixelRatio()
    expect(e.renderer.setPixelRatio).toHaveBeenLastCalledWith(1)
  })
})

describe('resize keeps the measured scale', () => {
  it('re-bounds the controller without snapping back to the ceiling', () => {
    stubViewport(1920, 1080, 1)
    const e = bareEngine()
    Object.assign(e, {
      camera: { updateProjectionMatrix: vi.fn() },
      debugMode: { active: false, freeze: false, resize: vi.fn() },
      minimap: { resize: vi.fn() },
    })
    e.renderer.setSize = vi.fn()
    e._configureDynamicResolution({ renderScale: 1 })
    e._drs.configure({ ceiling: 0.7 })
    e._drs.configure({ ceiling: 1 }) // a raised ceiling is climbed, not jumped to
    expect(e._drs.scale).toBe(0.7)
    stubViewport(1600, 900, 1)
    e._onResize()
    expect(e._drs.scale).toBe(0.7)
    expect(e.renderer.setPixelRatio).toHaveBeenLastCalledWith(0.7)
    // The new floor still clamps: 540 lines of a 600-line window is 0.9.
    stubViewport(800, 600, 1)
    e._onResize()
    expect(e._drs.scale).toBe(0.9)
  })

  it('a quality change still starts at the new ceiling', () => {
    stubViewport(1920, 1080, 1)
    const e = bareEngine()
    e._configureDynamicResolution({ renderScale: 1 })
    e._drs.configure({ ceiling: 0.7 })
    e._drs.configure({ ceiling: 1 })
    e._configureDynamicResolution({ renderScale: 1 })
    expect(e._drs.scale).toBe(1)
  })
})

describe('the DYNAMIC RESOLUTION toggle', () => {
  it('changes nothing under auto: no snap back to the ceiling', () => {
    stubViewport(1920, 1080, 1)
    const e = bareEngine()
    e._runSetting = Engine.prototype._runSetting
    e._configureDynamicResolution({ renderScale: 1 })
    const drs = e._drs
    const reset = vi.spyOn(drs, 'reset')
    e.settings.set('dynamicRes', true)
    e._runSetting('dynamicRes', true)
    expect(e._drs).toBe(drs)
    expect(reset).not.toHaveBeenCalled()
  })

  it('turns the controller on and off for named presets', () => {
    stubViewport(1920, 1080, 1)
    const e = bareEngine({ preset: 'high' })
    e._runSetting = Engine.prototype._runSetting
    e._configureDynamicResolution({ renderScale: 1 })
    expect(e._drs).toBeNull()
    e.settings.set('dynamicRes', true)
    e._runSetting('dynamicRes', true)
    expect(e._drs).not.toBeNull()
    e.settings.set('dynamicRes', false)
    e._runSetting('dynamicRes', false)
    expect(e._drs).toBeNull()
  })
})

describe('in-session guard', () => {
  it('never fires where the floor equals the ceiling and the GPU is idle', () => {
    // A 960x540 embed at DPR 1: 540 native lines, floor = ceiling = 1. The
    // scale "sits at the floor" from the first frame.
    stubViewport(960, 540, 1)
    const store = stubStorage()
    const e = bareEngine({ autoPreset: 'high', cls: 'discrete' })
    e.gpu.benchDone = true
    e._configureDynamicResolution({ renderScale: 1 })
    expect(e._drs.floor).toBe(e._drs.ceiling)
    e.gpuMs = () => 5
    play(e, { seconds: 30 })
    expect(e.gpu.autoPreset).toBe('high')
    expect(e._runSetting).not.toHaveBeenCalled()
    expect(store.has(GPU_PROFILE_KEY)).toBe(false)
  })

  it('drops one preset on real GPU overload at the floor and keeps it as a score', () => {
    stubViewport(960, 540, 1)
    const store = stubStorage()
    const e = bareEngine({ autoPreset: 'high', cls: 'discrete' })
    e.gpu.benchDone = true
    e._configureDynamicResolution({ renderScale: 1 })
    e.gpuMs = () => 30
    play(e, { seconds: 30 })
    expect(e.gpu.autoPreset).toBe('medium')
    expect(e._runSetting).toHaveBeenCalledWith('preset', 'auto')
    const saved = JSON.parse(store.get(GPU_PROFILE_KEY))
    expect(saved.preset).toBe('medium')
    expect(saved.score).toBeGreaterThan(0)
    // Once per session.
    play(e, { seconds: 30, start: 40000 })
    expect(e.gpu.autoPreset).toBe('medium')
  })

  it('a raf-mode drop lasts the session only: intervals cannot prove GPU load', () => {
    stubViewport(960, 540, 1)
    const store = stubStorage()
    const e = bareEngine({ gpu: false, autoPreset: 'high', cls: 'discrete' })
    e._configureDynamicResolution({ renderScale: 1 })
    play(e, { seconds: 30, intervalMs: 40 })
    expect(e.gpu.autoPreset).toBe('medium')
    expect(store.has(GPU_PROFILE_KEY)).toBe(false)
  })

  it('does not count frozen frames', () => {
    stubViewport(960, 540, 1)
    stubStorage()
    const e = bareEngine({ autoPreset: 'high', cls: 'discrete' })
    e.gpu.benchDone = true
    e._configureDynamicResolution({ renderScale: 1 })
    e.gpuMs = () => 30
    e.debugMode.active = true
    e.debugMode.freeze = true
    play(e, { seconds: 30 })
    expect(e.gpu.autoPreset).toBe('high')
  })
})

// Idle-screen callbacks on a display refreshing at `hz`, through the real
// _shouldRender / _trackDisplayRate pair in _animate's order. A callback that
// renders costs `renderMs` of main-thread or backpressure time, so the next
// callback lands on the first vsync after it; one that only updates costs
// almost nothing.
function idle(e, { hz, renderMs = 2, count = 600, phase = Phase.TITLE, start = 1000 }) {
  e.debug ??= { visible: false }
  const period = 1000 / hz
  let now = start
  let last = start - period
  for (let i = 0; i < count; i++) {
    const render = e._shouldRender(now, phase)
    e._trackDisplayRate(now - last, phase, render)
    last = now
    const busyUntil = now + (render ? renderMs : 0.5)
    now = Math.ceil((busyUntil - start) / period - 1e-9) * period + start
  }
}

describe('display refresh estimate', () => {
  it('a 30 Hz rAF cap measured on the title becomes the raf-mode budget, so DRS holds its scale', () => {
    stubViewport(1920, 1080, 1)
    const e = bareEngine({ gpu: false, autoPreset: 'medium' })
    // At 30 Hz every callback meets the 30/s idle deadline; the probe skip
    // is what yields clean intervals.
    idle(e, { hz: 30 })
    expect(e._displayHz).toBe(30)
    e._configureDynamicResolution({ renderScale: 1 })
    expect(e._drs.budgetMs).toBeCloseTo(1000 / 30, 6)
    play(e, { seconds: 30, intervalMs: 1000 / 30 })
    expect(e._drs.scale).toBe(1)
    expect(e.gpu.autoPreset).toBe('medium')
  })

  it('reads 60 Hz from a 60 Hz panel whose title frames each cost more than a refresh', () => {
    // Every rendered callback slips a vsync, so raw intervals are ~33 ms;
    // only the intervals after a submission-free callback are the vsync.
    // Start from a stale 30 Hz reading so an estimate must actually be taken.
    const e = bareEngine({ gpu: false })
    e._displayHz = 30
    idle(e, { hz: 60, renderMs: 25 })
    expect(e._displayHz).toBe(60)
    idle(e, { hz: 50, renderMs: 2, start: 50_000 })
    expect(e._displayHz).toBe(50)
    idle(e, { hz: 60, renderMs: 2, start: 90_000 })
    expect(e._displayHz).toBe(60)
  })

  it('takes no estimate while every callback renders at full rate (diagnostics on)', () => {
    const e = bareEngine({ gpu: false })
    e.debug = { visible: true }
    idle(e, { hz: 60, renderMs: 25 })
    expect(e._displayHz).toBeUndefined()
  })

  it('gpu mode keeps the 60 fps budget whatever the display estimate', () => {
    stubViewport(1920, 1080, 1)
    const e = bareEngine({ gpu: true })
    e._configureDynamicResolution({ renderScale: 1 })
    idle(e, { hz: 30 })
    expect(e._displayHz).toBe(30)
    expect(e._drs.budgetMs).toBeCloseTo(1000 / 60, 6)
    e._configureDynamicResolution({ renderScale: 1 }, { resize: true })
    expect(e._drs.budgetMs).toBeCloseTo(1000 / 60, 6)
  })

  it('ignores gameplay and rendered-after intervals, and never estimates below 30 Hz', () => {
    const e = bareEngine()
    for (let i = 0; i < 120; i++) e._trackDisplayRate(40, Phase.PLAYING, false)
    expect(e._displayHz).toBeUndefined()
    for (let i = 0; i < 120; i++) e._trackDisplayRate(1000 / 30, Phase.TITLE, true)
    expect(e._displayHz).toBeUndefined()
    for (let i = 0; i < 60; i++) e._trackDisplayRate(45, Phase.PAUSED, false)
    expect(e._displayHz).toBe(30)
    for (let i = 0; i < 60; i++) e._trackDisplayRate(1000 / 60, Phase.TITLE, false)
    expect(e._displayHz).toBe(60)
  })
})

describe('auto benchmark', () => {
  it('finishes on an over-budget GPU while DRS runs below the ceiling, and picks a cheaper preset', () => {
    // 25 ms at the 'medium' ceiling on 1080p: DRS leaves the ceiling within a
    // second, which used to starve the benchmark of samples for good.
    stubViewport(1920, 1080, 1)
    const store = stubStorage()
    const e = bareEngine({ autoPreset: 'medium', cls: 'integrated' })
    e._configureDynamicResolution({ renderScale: 1 })
    e.gpuMs = (s) => 25 * (0.2 + 0.8 * s * s)
    play(e, { seconds: 20 })
    expect(e._drs.changes).toBeGreaterThan(0)
    expect(e.gpu.benchDone).toBe(true)
    expect(e.gpu.score).toBeGreaterThan(0)
    expect(e.gpu.autoPreset).toBe('low')
    expect(JSON.parse(store.get(GPU_PROFILE_KEY)).preset).toBe('low')
  })

  it('normalises by the pixels rendered: the score does not depend on the DRS scale', () => {
    stubViewport(1920, 1080, 1)
    stubStorage()
    const scoreAt = (ceiling) => {
      const e = bareEngine({ autoPreset: 'high', cls: 'discrete' })
      e._configureDynamicResolution({ renderScale: 1 })
      e._drs.configure({ ceiling }) // holds the scale there
      e.gpuMs = (s) => 6 * s * s // purely fill-bound, well inside budget
      play(e, { seconds: 6 })
      return e.gpu.score
    }
    expect(scoreAt(0.7)).toBeCloseTo(scoreAt(1), 6)
  })
})

describe('boot preset from a stored score', () => {
  const RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
  const renderer = { getContext: () => ({ RENDERER: 0x1f01, getExtension: () => null, getParameter: () => RENDERER }) }

  it('re-derives the preset for the current viewport instead of reusing the stored name', () => {
    stubStorage()
    // Benchmarked in a 720p window, where this score picked 'ultra'.
    saveGpuProfile(globalThis.localStorage, {
      key: rendererKeyHash(RENDERER),
      score: 5,
      preset: 'ultra',
      cls: 'discrete',
      benchVersion: BENCH_VERSION,
    })
    const e = Object.create(Engine.prototype)
    e.touch = false
    stubViewport(1280, 720, 1)
    expect(e._classifyGpu(renderer).autoPreset).toBe('ultra')
    stubViewport(3840, 2160, 1)
    expect(e._classifyGpu(renderer).autoPreset).toBe('low')
  })

  it('reuses the stored name only when there is no score', () => {
    stubStorage()
    saveGpuProfile(globalThis.localStorage, { key: rendererKeyHash(RENDERER), score: null, preset: 'medium', cls: 'discrete' })
    const e = Object.create(Engine.prototype)
    e.touch = false
    stubViewport(1280, 720, 1)
    expect(loadGpuProfile(globalThis.localStorage, rendererKeyHash(RENDERER)).score).toBeNull()
    expect(e._classifyGpu(renderer).autoPreset).toBe('medium')
  })
})
