import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { Controller } from '../Controller.js'

let browserEvents
let documentEvents

beforeEach(() => {
  browserEvents = new EventTarget()
  documentEvents = new EventTarget()
  documentEvents.pointerLockElement = null
  documentEvents.exitPointerLock = vi.fn()
  vi.stubGlobal('addEventListener', browserEvents.addEventListener.bind(browserEvents))
  vi.stubGlobal('removeEventListener', browserEvents.removeEventListener.bind(browserEvents))
  vi.stubGlobal('document', documentEvents)
})

afterEach(() => vi.unstubAllGlobals())

const key = (code) => Object.assign(new Event('keydown'), { code })

describe('controller lifetime', () => {
  it('reports a rejected fallback lock even when the browser emits no document error event', async () => {
    const dom = { requestPointerLock: vi.fn().mockRejectedValue(new Error('gesture required')) }
    const controller = new Controller(new THREE.PerspectiveCamera(), dom, { phase: 'PLAYING' })
    controller.onLockError = vi.fn()
    controller.lock()
    await Promise.resolve()
    await Promise.resolve()

    expect(dom.requestPointerLock).toHaveBeenCalledTimes(2)
    expect(controller.onLockError).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('removes browser input listeners and releases only its own pointer lock', () => {
    const dom = {}
    const state = { phase: 'PLAYING', battery: 1, flashlightOn: false }
    const controller = new Controller(new THREE.PerspectiveCamera(), dom, state)
    const onLockChange = controller.onLockChange = vi.fn()
    documentEvents.pointerLockElement = dom
    documentEvents.dispatchEvent(new Event('pointerlockchange'))
    browserEvents.dispatchEvent(key('KeyW'))
    expect(controller.keys.has('KeyW')).toBe(true)

    controller.dispose()
    controller.dispose()
    browserEvents.dispatchEvent(key('KeyW'))
    browserEvents.dispatchEvent(key('KeyF'))
    documentEvents.dispatchEvent(new Event('pointerlockchange'))

    expect(controller.keys.size).toBe(0)
    expect(controller.inputEnabled).toBe(false)
    expect(controller.isLocked).toBe(false)
    expect(state.flashlightOn).toBe(false)
    expect(onLockChange).toHaveBeenCalledOnce()
    expect(documentEvents.exitPointerLock).toHaveBeenCalledOnce()
  })

  it('does not steal or release another controller lock after an outstanding request rejects', async () => {
    let reject
    const dom = {
      requestPointerLock: vi.fn(() => new Promise((_resolve, fail) => { reject = fail })),
    }
    const controller = new Controller(new THREE.PerspectiveCamera(), dom, { phase: 'PLAYING' })
    controller.lock()
    documentEvents.pointerLockElement = {}
    controller.dispose()
    reject(new Error('raw input unsupported'))
    await Promise.resolve()
    controller.lock()

    expect(dom.requestPointerLock).toHaveBeenCalledOnce()
    expect(documentEvents.exitPointerLock).not.toHaveBeenCalled()
  })
})
