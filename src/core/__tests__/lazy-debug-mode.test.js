import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LazyDebugMode } from '../LazyDebugMode.js'

let keyListeners

function press(code = 'F2') {
  const event = { code, preventDefault: vi.fn() }
  for (const listener of [...keyListeners]) listener(event)
  return event
}

function debugModule(instances) {
  return {
    DebugMode: class {
      constructor(engine) {
        this.engine = engine
        this.active = false
        this.freeze = false
        this.invincible = true
        this.toggle = vi.fn(() => {
          this.active = !this.active
        })
        this._onKeyDown = (event) => {
          if (event.code !== 'F2') return
          event.preventDefault()
          this.toggle()
        }
        this.update = vi.fn()
        this.preRender = vi.fn()
        this.postRender = vi.fn()
        this.resize = vi.fn()
        this.placeStalker = vi.fn(() => 'placed')
        this.teleportPlayer = vi.fn(() => 'teleported')
        this.dispose = vi.fn(() => {
          removeEventListener('keydown', this._onKeyDown)
        })
        addEventListener('keydown', this._onKeyDown)
        instances.push(this)
      }
    },
  }
}

beforeEach(() => {
  keyListeners = new Set()
  vi.stubGlobal('addEventListener', vi.fn((type, listener) => {
    if (type === 'keydown') keyListeners.add(listener)
  }))
  vi.stubGlobal('removeEventListener', vi.fn((type, listener) => {
    if (type === 'keydown') keyListeners.delete(listener)
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('LazyDebugMode', () => {
  it('stays inert until F2, then delegates the synchronous frame lifecycle', async () => {
    const instances = []
    const engine = {}
    const load = vi.fn(async () => debugModule(instances))
    const debug = new LazyDebugMode(engine, load)

    debug.update(0.1)
    debug.preRender()
    debug.postRender()
    debug.resize(1280, 720)
    expect(debug.placeStalker(1, 2, 3)).toBeUndefined()
    expect(debug.teleportPlayer(4, 5, 6)).toBeUndefined()
    expect(load).not.toHaveBeenCalled()
    expect(debug.active).toBe(false)
    expect(debug.freeze).toBe(false)
    expect(debug.invincible).toBe(false)

    expect(press('KeyA').preventDefault).not.toHaveBeenCalled()
    const event = press()
    expect(event.preventDefault).toHaveBeenCalledOnce()

    await vi.waitFor(() => expect(instances).toHaveLength(1))
    const mode = instances[0]
    expect(load).toHaveBeenCalledOnce()
    expect(mode.engine).toBe(engine)
    expect(mode.resize).toHaveBeenCalledWith(1280, 720)
    expect(mode.toggle).toHaveBeenCalledOnce()
    expect(debug.active).toBe(true)
    expect(debug.invincible).toBe(true)

    debug.update(0.2)
    debug.preRender()
    debug.postRender()
    debug.resize(800, 600)
    expect(mode.update).toHaveBeenCalledWith(0.2)
    expect(mode.preRender).toHaveBeenCalledOnce()
    expect(mode.postRender).toHaveBeenCalledOnce()
    expect(mode.resize).toHaveBeenLastCalledWith(800, 600)
    expect(debug.placeStalker(10, 20, 2)).toBe('placed')
    expect(debug.teleportPlayer(30, 40, -1)).toBe('teleported')
    expect(mode.placeStalker).toHaveBeenCalledWith(10, 20, 2)
    expect(mode.teleportPlayer).toHaveBeenCalledWith(30, 40, -1)

    const closeEvent = press()
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce()
    expect(mode.toggle).toHaveBeenCalledTimes(2)
    expect(debug.active).toBe(false)
    expect(keyListeners.size).toBe(1)

    debug.dispose()
    debug.dispose()
    expect(mode.dispose).toHaveBeenCalledOnce()
    expect(keyListeners.size).toBe(0)
  })

  it('coalesces F2 toggles while one module request is pending', async () => {
    const instances = []
    let resolveLoad
    const load = vi.fn(() => new Promise((resolve) => {
      resolveLoad = resolve
    }))
    const debug = new LazyDebugMode({}, load)

    press()
    press()
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    const pending = debug._loading
    resolveLoad(debugModule(instances))
    await pending

    expect(instances).toHaveLength(1)
    expect(instances[0].toggle).not.toHaveBeenCalled()
    expect(debug.active).toBe(false)
  })

  it('keeps F2 retryable after a load failure', async () => {
    const instances = []
    const failure = new Error('offline')
    const load = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(debugModule(instances))
    const onError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const debug = new LazyDebugMode({}, load)

    press()
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(
      'Failed to load debug tools',
      failure
    ))
    expect(keyListeners.size).toBe(1)

    press()
    await vi.waitFor(() => expect(instances).toHaveLength(1))
    expect(load).toHaveBeenCalledTimes(2)
    expect(instances[0].toggle).toHaveBeenCalledOnce()
    expect(debug.active).toBe(true)
  })

  it('does not construct late-arriving tools after engine disposal', async () => {
    const instances = []
    let resolveLoad
    const load = vi.fn(() => new Promise((resolve) => {
      resolveLoad = resolve
    }))
    const debug = new LazyDebugMode({}, load)

    press()
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    const pending = debug._loading
    debug.dispose()
    resolveLoad(debugModule(instances))
    await pending

    expect(instances).toHaveLength(0)
    expect(keyListeners.size).toBe(0)
  })
})
