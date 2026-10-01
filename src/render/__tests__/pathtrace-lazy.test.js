import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LazyPathTraceView, PATH_TRACE_KEY } from '../pathtrace/LazyPathTraceView.js'
import { TRACER_DEVICE_LIMITS, requestTracerAdapter, webgpuAvailability } from '../pathtrace/webgpuSupport.js'
import { Phase } from '../../core/GameState.js'

// The experimental WebGPU path tracer's boot-graph shell. It must stay
// inert (no module load, no key capture) until the option is switched on,
// freeze the world from the key press on, and fall back cleanly on failure.

let keyListeners

function press(code = PATH_TRACE_KEY, extra = {}) {
  const event = { code, preventDefault: vi.fn(), ...extra }
  for (const listener of [...keyListeners]) listener(event)
  return event
}

function viewModule(instances, { initError = null } = {}) {
  return {
    PathTraceView: class {
      constructor(engine) {
        this.engine = engine
        this.stats = { lights: 7 }
        this.samples = 12
        this.init = vi.fn(async () => {
          if (initError) throw initError
        })
        this.open = vi.fn()
        this.close = vi.fn()
        this.render = vi.fn()
        this.resize = vi.fn()
        this.dispose = vi.fn()
        instances.push(this)
      }
    },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function engine(phase = Phase.PLAYING) {
  return { state: { phase }, debugMode: { active: false }, touch: false }
}

beforeEach(() => {
  keyListeners = new Set()
  vi.stubGlobal('addEventListener', vi.fn((type, listener) => {
    if (type === 'keydown') keyListeners.add(listener)
  }))
  vi.stubGlobal('removeEventListener', vi.fn((type, listener) => {
    if (type === 'keydown') keyListeners.delete(listener)
  }))
  // nextPaint() waits on two frames.
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0))
  vi.stubGlobal('document', undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const ok = { ok: true, reason: '' }

describe('LazyPathTraceView', () => {
  it('is off by default: P is not consumed and nothing loads', () => {
    const load = vi.fn()
    const pt = new LazyPathTraceView(engine(), { load, availability: ok })
    expect(pt.enabled).toBe(false)
    expect(press().preventDefault).not.toHaveBeenCalled()
    expect(pt.active).toBe(false)
    expect(pt.render(0)).toBe(false)
    expect(load).not.toHaveBeenCalled()
  })

  it('freezes on the key press, then goes live once the module and WebGPU are up', async () => {
    const instances = []
    const load = vi.fn(async () => viewModule(instances))
    const pt = new LazyPathTraceView(engine(), { load, availability: ok })
    pt.setMode('viewer')

    expect(press().preventDefault).toHaveBeenCalledOnce()
    expect(pt.active).toBe(true)
    expect(pt.live).toBe(false)
    expect(pt.render(0)).toBe(false)

    for (let i = 0; i < 5; i++) await flush()
    expect(load).toHaveBeenCalledOnce()
    const [view] = instances
    expect(view.init).toHaveBeenCalledOnce()
    expect(view.open).toHaveBeenCalledOnce()
    expect(pt.live).toBe(true)
    expect(pt.render(5)).toBe(true)
    expect(view.render).toHaveBeenCalledWith(5)

    // P again returns to the game; the WebGPU context stays warm.
    press()
    expect(pt.active).toBe(false)
    expect(view.close).toHaveBeenCalledOnce()
    expect(view.dispose).not.toHaveBeenCalled()
    press()
    for (let i = 0; i < 5; i++) await flush()
    expect(load).toHaveBeenCalledOnce()
    expect(view.open).toHaveBeenCalledTimes(2)
  })

  it('only opens while playing, outside the F2 tools, and ignores key repeat', () => {
    const load = vi.fn(async () => viewModule([]))
    const e = engine(Phase.PAUSED)
    const pt = new LazyPathTraceView(e, { load, availability: ok })
    pt.setMode('viewer')
    expect(press().preventDefault).not.toHaveBeenCalled()
    e.state.phase = Phase.PLAYING
    e.debugMode.active = true
    expect(pt.open()).toBe(false)
    e.debugMode.active = false
    press(PATH_TRACE_KEY, { repeat: true })
    expect(pt.active).toBe(false)
    expect(load).not.toHaveBeenCalled()
  })

  it('never opens where WebGPU is unavailable', () => {
    const load = vi.fn()
    const pt = new LazyPathTraceView(engine(), { load, availability: { ok: false, reason: 'no' } })
    pt.setMode('viewer')
    expect(pt.open()).toBe(false)
    expect(load).not.toHaveBeenCalled()
  })

  it('closes when the game leaves PLAYING', async () => {
    const instances = []
    const pt = new LazyPathTraceView(engine(), { load: async () => viewModule(instances), availability: ok })
    pt.setMode('viewer')
    pt.open()
    for (let i = 0; i < 5; i++) await flush()
    pt.update(Phase.PLAYING)
    expect(pt.live).toBe(true)
    pt.update(Phase.PAUSED)
    expect(pt.active).toBe(false)
    expect(instances[0].close).toHaveBeenCalledOnce()
  })

  it('switching the mode off releases the WebGPU context', async () => {
    const instances = []
    const pt = new LazyPathTraceView(engine(), { load: async () => viewModule(instances), availability: ok })
    pt.setMode('viewer')
    pt.open()
    for (let i = 0; i < 5; i++) await flush()
    pt.setMode('off')
    expect(pt.active).toBe(false)
    expect(instances[0].dispose).toHaveBeenCalledOnce()
    expect(press().preventDefault).not.toHaveBeenCalled()
  })

  it('a failed start unfreezes, reports why, and the next press retries', async () => {
    const instances = []
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let fail = new Error('No WebGPU adapter')
    const load = vi.fn(async () => viewModule(instances, { initError: fail }))
    const pt = new LazyPathTraceView(engine(), { load, availability: ok })
    pt.setMode('viewer')
    pt.open()
    for (let i = 0; i < 5; i++) await flush()
    expect(pt.active).toBe(false)
    expect(pt.error).toBe('No WebGPU adapter')
    expect(instances[0].dispose).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalled()

    fail = null
    pt.open()
    for (let i = 0; i < 5; i++) await flush()
    expect(load).toHaveBeenCalledTimes(2)
    expect(pt.live).toBe(true)
  })

  it('a lost device closes the view and drops it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const instances = []
    const pt = new LazyPathTraceView(engine(), { load: async () => viewModule(instances), availability: ok })
    pt.setMode('viewer')
    pt.open()
    for (let i = 0; i < 5; i++) await flush()
    instances[0].onLost('WebGPU device lost')
    expect(pt.active).toBe(false)
    expect(pt.live).toBe(false)
    expect(instances[0].dispose).toHaveBeenCalledOnce()
    expect(pt.error).toBe('WebGPU device lost')
  })

  it('dispose removes the key listener', () => {
    const pt = new LazyPathTraceView(engine(), { load: vi.fn(), availability: ok })
    expect(keyListeners.size).toBe(1)
    pt.dispose()
    expect(keyListeners.size).toBe(0)
  })
})

describe('webgpuSupport', () => {
  it('needs navigator.gpu, a secure page and a desktop', () => {
    expect(webgpuAvailability({ nav: { gpu: {} }, secure: true }).ok).toBe(true)
    expect(webgpuAvailability({ nav: {}, secure: true })).toEqual({
      ok: false,
      reason: 'WebGPU is not available in this browser',
    })
    expect(webgpuAvailability({ nav: { gpu: {} }, secure: false }).ok).toBe(false)
    expect(webgpuAvailability({ nav: { gpu: {} }, secure: true, touch: true }).ok).toBe(false)
  })

  it('requests the adapter maxima for the tracer buffer limits', async () => {
    const adapter = {
      limits: { maxBufferSize: 4e9, maxStorageBufferBindingSize: 2e9, maxBindGroups: 4 },
      info: { vendor: 'v', architecture: 'a' },
    }
    const nav = { gpu: { requestAdapter: vi.fn(async () => adapter) } }
    const out = await requestTracerAdapter(nav)
    expect(nav.gpu.requestAdapter).toHaveBeenCalledWith({ powerPreference: 'high-performance' })
    expect(Object.keys(out.requiredLimits)).toEqual(TRACER_DEVICE_LIMITS)
    expect(out.requiredLimits).toEqual({ maxBufferSize: 4e9, maxStorageBufferBindingSize: 2e9 })
    expect(out.info).toEqual({ vendor: 'v', architecture: 'a', fallback: false })
  })

  it('fails loudly without an adapter', async () => {
    await expect(requestTracerAdapter({ gpu: { requestAdapter: async () => null } })).rejects.toThrow(
      'No WebGPU adapter'
    )
  })
})
