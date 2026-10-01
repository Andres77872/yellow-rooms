import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../textures.js', () => ({
  floorTexture: (anisotropy) => Object.assign(new THREE.Texture(), { anisotropy }),
  wallTexture: (anisotropy) => Object.assign(new THREE.Texture(), { anisotropy }),
  ceilingTexture: (anisotropy) => Object.assign(new THREE.Texture(), { anisotropy }),
  surfaceDetailTexture: (albedo) => Object.assign(new THREE.Texture(), { anisotropy: albedo.anisotropy }),
}))

import { DeferredRenderer } from '../DeferredRenderer.js'
import {
  ALPHA_CONTINUED,
  ALPHA_FRESH,
  FILTER_ITERATIONS,
  FILTER_SAMPLE_STEPS,
  PathTraceBlend,
  SNAPSHOT_SLOTS,
  filterIterations,
  traceSize,
} from '../pathtrace/pathTraceBlend.js'
import { REBUILD_DISTANCE, needsRebuild, worldKey } from '../pathtrace/realtimePolicy.js'
import { MAX_JOB_SAMPLES, MIN_JOB_SAMPLES, PathTraceRealtime } from '../pathtrace/PathTraceRealtime.js'
import { LazyPathTraceView, PATH_TRACE_KEY } from '../pathtrace/LazyPathTraceView.js'
import { createGBufferMaterials } from '../gbufferMaterials.js'
import { createGeometries } from '../geometries.js'
import { Chunk } from '../../world/Chunk.js'
import { worldConfigForFamily } from '../../world/mapFamily.js'
import { hashStr } from '../../world/core/hash.js'
import { EYE_H, HUB_CELL, SPAWN_WORLD } from '../../world/constants.js'
import { Phase } from '../../core/GameState.js'

// The experimental REALTIME path tracer (docs/pathracer/10): the WebGL
// blend that DeferredRenderer runs after its lighting pass, the streaming
// policy, the page-side driver of the tracer worker, and the facade's
// realtime mode. The worker protocol is in pathtrace-worker.test.js; the
// WebGPU tracer itself needs a GPU and is verified in the browser (doc §7).

function fakeRenderer(width = 320, height = 180) {
  const size = { width, height, pixelRatio: 1 }
  return {
    size,
    setClearColor: vi.fn(),
    setRenderTarget: vi.fn(),
    render: vi.fn(),
    getPixelRatio: () => size.pixelRatio,
    getSize: (out) => out.set(size.width, size.height),
  }
}

function makeDeferred(renderer = fakeRenderer()) {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 100)
  camera.position.set(1, 2, 3)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return new DeferredRenderer(renderer, new THREE.Scene(), camera)
}

describe('trace resolution and filter schedule', () => {
  it('keeps the aspect, caps the pixel count and rounds the width to 16', () => {
    const s = traceSize(1469, 1235)
    expect(s.width % 16).toBe(0)
    expect(s.width * s.height).toBeLessThanOrEqual(150_000)
    expect(s.width / s.height).toBeCloseTo(1469 / 1235, 1)
    // Small frames trace at half resolution.
    expect(traceSize(320, 180)).toEqual({ width: 160, height: 90 })
  })

  it('filters a few-sample frame fully and sheds the filter as samples accumulate', () => {
    expect(filterIterations(1)).toBe(FILTER_ITERATIONS)
    expect(filterIterations(FILTER_SAMPLE_STEPS[0] - 1)).toBe(FILTER_ITERATIONS)
    expect(filterIterations(FILTER_SAMPLE_STEPS[0])).toBe(FILTER_ITERATIONS - 1)
    expect(filterIterations(512)).toBe(0)
    expect(filterIterations(5000)).toBe(0)
  })
})

describe('PathTraceBlend', () => {
  let deferred
  let blend
  beforeEach(() => {
    deferred = makeDeferred()
    blend = new PathTraceBlend()
    blend.setTraceSize(160, 90)
  })
  afterEach(() => {
    blend.dispose()
    deferred.dispose()
  })

  it('snapshots only a reserved frame and hands its camera to the dispatcher', () => {
    blend.render(deferred)
    expect(blend.takeCaptured()).toBeNull()
    const slot = blend.reserve()
    expect(slot).toBeGreaterThanOrEqual(0)
    blend.render(deferred)
    const cap = blend.takeCaptured()
    expect(cap.slot).toBe(slot)
    expect(cap.camPos.toArray()).toEqual([1, 2, 3])
    const vp = new THREE.Matrix4().multiplyMatrices(deferred.camera.projectionMatrix, deferred.camera.matrixWorldInverse)
    expect(cap.viewProj.equals(vp)).toBe(true)
    expect(blend.inFlight).toBe(1)
  })

  it('accepts a matching readback as current and frees the previous one', () => {
    const data = new Float32Array(160 * 90 * 4)
    blend.reserve()
    blend.render(deferred)
    const a = blend.takeCaptured().slot
    expect(blend.accept(a, data, 160, 90)).toBe(true)
    expect(blend.slots[a].state).toBe('current')
    expect(blend.accumUniforms.uAlpha.value).toBe(ALPHA_FRESH)
    blend.reserve()
    blend.render(deferred)
    const b = blend.takeCaptured().slot
    expect(b).not.toBe(a)
    expect(blend.accept(b, data, 160, 90, { continued: true })).toBe(true)
    expect(blend.slots[a].state).toBe('free')
    expect(blend.accumUniforms.uAlpha.value).toBe(ALPHA_CONTINUED)
    expect(blend.stats.accepted).toBe(2)
  })

  it('snapshots at trace size and filters by the frame\'s sample count', () => {
    blend.reserve()
    blend.render(deferred)
    expect(blend.snapUniforms.uTraceSize.value.toArray()).toEqual([160, 90])
    const data = new Float32Array(160 * 90 * 4)
    blend.accept(blend.takeCaptured().slot, data, 160, 90, { samples: 600 })
    blend.render(deferred)
    expect(blend.stats.filterIterations).toBe(0)
    blend.reserve()
    blend.render(deferred)
    blend.accept(blend.takeCaptured().slot, data, 160, 90, { samples: 2 })
    blend.render(deferred)
    expect(blend.stats.filterIterations).toBe(FILTER_ITERATIONS)
  })

  it('refuses a readback from another trace size or an unknown slot', () => {
    blend.reserve()
    blend.render(deferred)
    const slot = blend.takeCaptured().slot
    blend.setTraceSize(176, 99)
    expect(blend.accept(slot, new Float32Array(160 * 90 * 4), 160, 90)).toBe(false)
    expect(blend.accept(7, new Float32Array(176 * 99 * 4), 176, 99)).toBe(false)
    expect(blend.stats.rejected).toBe(2)
  })

  it('never leaks a slot: an undispatched capture is released by the next frame', () => {
    for (let i = 0; i < SNAPSHOT_SLOTS * 3; i++) {
      blend.reserve()
      blend.render(deferred) // captured, never taken
    }
    expect(blend.inFlight).toBeLessThanOrEqual(1)
    expect(blend.reserve()).toBeGreaterThanOrEqual(0)
  })

  it('runs no traced passes while disabled (raster A/B)', () => {
    blend.enabled = false
    deferred.renderer.setRenderTarget.mockClear()
    blend.render(deferred)
    expect(deferred.renderer.setRenderTarget).not.toHaveBeenCalledWith(deferred.litRT)
  })

  it('blends over litRT and leaves its alpha alone', () => {
    const m = blend.applyQuad.material
    expect(m.blending).toBe(THREE.CustomBlending)
    expect(m.blendSrc).toBe(THREE.SrcAlphaFactor)
    expect(m.blendDst).toBe(THREE.OneMinusSrcAlphaFactor)
    expect(m.blendSrcAlpha).toBe(THREE.ZeroFactor)
    expect(m.blendDstAlpha).toBe(THREE.OneFactor)
    const data = new Float32Array(160 * 90 * 4)
    blend.reserve()
    blend.render(deferred)
    blend.accept(blend.takeCaptured().slot, data, 160, 90)
    deferred.renderer.setRenderTarget.mockClear()
    blend.render(deferred)
    expect(deferred.renderer.setRenderTarget).toHaveBeenCalledWith(deferred.litRT)
  })
})

describe('DeferredRenderer hook', () => {
  it('runs the path-trace hook after lighting and before the exposure meter', () => {
    const deferred = makeDeferred()
    // As DeferredRenderer.test.js does for full frames: target clears are
    // not under test here.
    vi.spyOn(deferred, '_clearRT').mockImplementation(() => {})
    const order = []
    const lighting = deferred._renderLighting.bind(deferred)
    deferred._renderLighting = () => {
      order.push('lighting')
      lighting()
    }
    deferred._renderExposure = () => order.push('exposure')
    deferred.gradeUniforms.autoExposure.value = 1
    deferred.setPathTraceHook({ render: (d) => order.push(d === deferred ? 'pathTrace' : 'wrong') })
    deferred.render(0)
    expect(order).toEqual(['lighting', 'pathTrace', 'exposure'])
    order.length = 0
    deferred.setPathTraceHook(null)
    deferred.render(1)
    expect(order).toEqual(['lighting', 'exposure'])
    deferred.dispose()
  })
})

describe('streaming policy', () => {
  const base = {
    hasScene: true,
    key: 'k',
    sceneKey: 'k',
    floor: 0,
    sceneFloor: 0,
    eye: { x: 0, z: 0 },
    center: { x: 0, z: 0 },
    sameChunks: true,
    now: 10_000,
    lastBuildAt: 0,
  }
  it('rebuilds on a new level, floor, or leaving the gathered area', () => {
    expect(needsRebuild(base)).toBe(false)
    expect(needsRebuild({ ...base, hasScene: false })).toBe(true)
    expect(needsRebuild({ ...base, key: 'other' })).toBe(true)
    expect(needsRebuild({ ...base, floor: 1 })).toBe(true)
    expect(needsRebuild({ ...base, eye: { x: REBUILD_DISTANCE + 0.1, z: 0 } })).toBe(true)
    expect(needsRebuild({ ...base, eye: { x: REBUILD_DISTANCE - 0.1, z: 0 } })).toBe(false)
  })

  it('rate-limits rebuilds for streamed-in chunks', () => {
    expect(needsRebuild({ ...base, sameChunks: false, lastBuildAt: base.now - 200 })).toBe(false)
    expect(needsRebuild({ ...base, sameChunks: false, lastBuildAt: base.now - 2000 })).toBe(true)
  })

  it('keys the world by seed, level and family', () => {
    expect(worldKey({ seed: 3, level: 2, mapFamily: 'hotel' })).toBe('3|2|hotel')
  })
})

// A stand-in for the tracer worker: records what the page posts.
class FakeWorker {
  constructor({ fail = null } = {}) {
    this.sent = []
    this.terminated = false
    this.fail = fail
  }
  postMessage(msg) {
    this.sent.push(msg)
    if (msg.type === 'init') {
      queueMicrotask(() =>
        this.reply(this.fail ? { type: 'error', message: this.fail } : { type: 'ready', info: { vendor: 'test' }, backend: 'megakernel' })
      )
    }
  }
  reply(msg) {
    this.onmessage?.({ data: msg })
  }
  of(type) {
    return this.sent.filter((m) => m.type === type)
  }
  terminate() {
    this.terminated = true
  }
}

describe('PathTraceRealtime (page side of the worker)', () => {
  const materials = createGBufferMaterials({ capabilities: { getMaxAnisotropy: () => 4 } })
  const geom = createGeometries()
  const { config } = worldConfigForFamily('office')
  const clear = [{ cx: 0, cy: 0, cz: 0, lx: HUB_CELL, lz: HUB_CELL, r: 1 }]
  const chunk = new Chunk(0, 0, 0, hashStr('review#1'), materials, geom, null, config, clear, null)

  function setup({ fail = null } = {}) {
    const deferred = makeDeferred()
    const camera = deferred.camera
    camera.position.set(SPAWN_WORLD, EYE_H, SPAWN_WORLD)
    camera.updateMatrixWorld(true)
    const engine = {
      deferred,
      camera,
      cm: { chunks: new Map([['0,0,0', chunk]]) },
      state: { seed: 1, level: 1, mapFamily: 'office', flashlightOn: false },
      controller: { floor: 0 },
      materials,
      _drsTargetFps: () => 60,
    }
    const worker = new FakeWorker({ fail })
    const rt = new PathTraceRealtime(engine, { createWorker: () => worker })
    return { rt, worker, engine, deferred, camera }
  }

  // One engine frame: the deferred render (its hook snapshots a reserved
  // slot), then the driver.
  const frame = (t, now) => {
    t.rt.blend.render(t.deferred)
    t.rt.afterRender(now)
  }

  it('starts the worker on the megakernel and hooks the blend in', async () => {
    const t = setup()
    await t.rt.init()
    expect(t.worker.of('init')[0].settings).toMatchObject({ maxBounces: 3, maxSamples: 512, megakernel: true })
    expect(t.rt.backend).toBe('megakernel')
    expect(t.deferred.pathTraceHook).toBe(t.rt.blend)
  })

  it('a failed start rejects init and never hooks the blend', async () => {
    const t = setup({ fail: 'No WebGPU adapter' })
    await expect(t.rt.init()).rejects.toThrow('No WebGPU adapter')
    expect(t.deferred.pathTraceHook).toBeNull()
  })

  it('mirrors the neighbourhood, then dispatches each snapshotted frame', async () => {
    const t = setup()
    await t.rt.init()
    frame(t, 0)
    // First frame: geometry, chunk, materials, then the scene, in that order.
    const order = t.worker.sent.map((m) => m.type).filter((x) => x !== 'geometry' && x !== 'texture')
    expect(order.slice(1, 4)).toEqual(['chunk', 'materials', 'scene'])
    const [scene] = t.worker.of('scene')
    expect(scene.chunks).toHaveLength(1)
    expect(scene.lights.length).toBeGreaterThan(0)
    expect(scene.flashlight.on).toBe(false)
    expect(t.worker.of('trace')).toHaveLength(0)
    frame(t, 16)
    const [job] = t.worker.of('trace')
    expect(job.width).toBe(160)
    expect(job.height).toBe(90)
    expect(job.camera.m).toEqual(Array.from(t.camera.matrixWorld.elements))
    expect(job.samples).toBeGreaterThanOrEqual(MIN_JOB_SAMPLES)
    expect(job.samples).toBeLessThanOrEqual(MAX_JOB_SAMPLES)
    t.worker.reply({ type: 'frame', slot: job.slot, serial: job.serial, data: new Float32Array(160 * 90 * 4), width: 160, height: 90, continued: false, samples: 1, ms: 5 })
    expect(t.rt.blend.stats.accepted).toBe(1)
    expect(t.rt.blend.slots[job.slot].state).toBe('current')
  })

  it('stops tracing once a still view converges and resumes when the camera moves', async () => {
    const t = setup()
    await t.rt.init()
    frame(t, 0)
    frame(t, 16)
    const [job] = t.worker.of('trace')
    t.worker.reply({ type: 'frame', slot: job.slot, serial: job.serial, data: new Float32Array(160 * 90 * 4), width: 160, height: 90, continued: true, samples: 512, ms: 5 })
    expect(t.rt.converged).toBe(true)
    const before = t.worker.of('trace').length
    for (let i = 2; i < 6; i++) frame(t, i * 16)
    // At most the job already reserved before the frame came back.
    expect(t.worker.of('trace').length - before).toBeLessThanOrEqual(1)
    expect(t.rt.blend.inFlight).toBe(0)
    t.camera.position.x += 0.5
    t.camera.updateMatrixWorld(true)
    frame(t, 100)
    expect(t.rt.converged).toBe(false)
    frame(t, 116)
    expect(t.worker.of('trace').at(-1).camera.m).toEqual(Array.from(t.camera.matrixWorld.elements))
  })

  it('never holds more than two jobs in flight', async () => {
    const t = setup()
    await t.rt.init()
    for (let i = 0; i < 10; i++) frame(t, i * 16)
    expect(t.worker.of('trace')).toHaveLength(2)
    expect(t.rt.blend.inFlight).toBe(2)
    const [a] = t.worker.of('trace')
    t.worker.reply({ type: 'skipped', slot: a.slot })
    expect(t.rt.blend.inFlight).toBe(1)
  })

  it('sheds samples when frames run over budget and grows them back slowly', async () => {
    const t = setup()
    await t.rt.init()
    let now = 0
    for (let i = 0; i < 60; i++) frame(t, (now += 10))
    expect(t.rt.samples).toBe(MAX_JOB_SAMPLES)
    frame(t, (now += 40))
    expect(t.rt.samples).toBe(MAX_JOB_SAMPLES - 1)
    frame(t, (now += 10))
    expect(t.rt.samples).toBe(MAX_JOB_SAMPLES - 1)
  })

  it('re-sends the lights when the torch toggles', async () => {
    const t = setup()
    await t.rt.init()
    frame(t, 0)
    t.engine.state.flashlightOn = true
    frame(t, 16)
    const [lights] = t.worker.of('lights')
    expect(lights.flashlight.on).toBe(true)
    frame(t, 32)
    expect(t.worker.of('trace').at(-1).flash.position).toHaveLength(3)
  })

  it('a worker error drops back to raster through onLost; dispose ends the worker', async () => {
    const t = setup()
    await t.rt.init()
    const lost = vi.fn()
    t.rt.onLost = lost
    t.worker.reply({ type: 'error', message: 'Device lost' })
    expect(lost).toHaveBeenCalledWith('Device lost')
    t.rt.dispose()
    expect(t.worker.of('dispose')).toHaveLength(1)
    expect(t.worker.terminated).toBe(true)
    expect(t.deferred.pathTraceHook).toBeNull()
  })
})

describe('LazyPathTraceView realtime mode', () => {
  let keyListeners
  const press = () => {
    const event = { code: PATH_TRACE_KEY, preventDefault: vi.fn() }
    for (const l of [...keyListeners]) l(event)
    return event
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const ok = { ok: true, reason: '' }

  function realtimeModule(instances, { initError = null } = {}) {
    return {
      PathTraceRealtime: class {
        constructor(engine) {
          this.engine = engine
          this.enabled = true
          this.init = vi.fn(async () => {
            if (initError) throw initError
          })
          this.afterRender = vi.fn()
          this.idle = vi.fn()
          this.setEnabled = vi.fn((on) => {
            this.enabled = on
          })
          this.dispose = vi.fn()
          instances.push(this)
        }
      },
    }
  }

  beforeEach(() => {
    keyListeners = new Set()
    vi.stubGlobal('addEventListener', vi.fn((t, l) => t === 'keydown' && keyListeners.add(l)))
    vi.stubGlobal('removeEventListener', vi.fn((t, l) => t === 'keydown' && keyListeners.delete(l)))
    vi.stubGlobal('document', undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('loads on the first PLAYING frame, then drives the tracer every frame', async () => {
    const instances = []
    const loadRealtime = vi.fn(async () => realtimeModule(instances))
    const engine = { state: { phase: Phase.TITLE }, debugMode: { active: false } }
    const pt = new LazyPathTraceView(engine, { loadRealtime, availability: ok })
    pt.setMode('realtime')
    pt.afterRender(0, Phase.TITLE)
    expect(loadRealtime).not.toHaveBeenCalled()
    pt.afterRender(1, Phase.PLAYING)
    pt.afterRender(2, Phase.PLAYING)
    for (let i = 0; i < 4; i++) await flush()
    expect(loadRealtime).toHaveBeenCalledOnce()
    const [rt] = instances
    expect(pt.realtime).toBe(rt)
    pt.afterRender(3, Phase.PLAYING)
    expect(rt.afterRender).toHaveBeenCalledWith(3)
    // Not playing: the frame is idle (its snapshot is released), not traced.
    pt.afterRender(4, Phase.PAUSED)
    expect(rt.idle).toHaveBeenCalledOnce()
    // Realtime never freezes the game.
    expect(pt.active).toBe(false)
  })

  it('P flips path-traced and raster lighting while playing', async () => {
    const instances = []
    const engine = { state: { phase: Phase.PLAYING }, debugMode: { active: false } }
    const pt = new LazyPathTraceView(engine, { loadRealtime: async () => realtimeModule(instances), availability: ok })
    pt.setMode('realtime')
    pt.afterRender(0, Phase.PLAYING)
    for (let i = 0; i < 4; i++) await flush()
    expect(press().preventDefault).toHaveBeenCalledOnce()
    expect(instances[0].setEnabled).toHaveBeenLastCalledWith(false)
    press()
    expect(instances[0].setEnabled).toHaveBeenLastCalledWith(true)
  })

  it('a failed start falls back to raster and retries only on P', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const instances = []
    let fail = new Error('No WebGPU adapter')
    const loadRealtime = vi.fn(async () => realtimeModule(instances, { initError: fail }))
    const engine = { state: { phase: Phase.PLAYING }, debugMode: { active: false } }
    const pt = new LazyPathTraceView(engine, { loadRealtime, availability: ok })
    pt.setMode('realtime')
    pt.afterRender(0, Phase.PLAYING)
    for (let i = 0; i < 4; i++) await flush()
    expect(pt.error).toBe('No WebGPU adapter')
    expect(instances[0].dispose).toHaveBeenCalledOnce()
    for (let i = 1; i < 10; i++) pt.afterRender(i, Phase.PLAYING)
    expect(loadRealtime).toHaveBeenCalledOnce()
    fail = null
    press()
    pt.afterRender(11, Phase.PLAYING)
    for (let i = 0; i < 4; i++) await flush()
    expect(loadRealtime).toHaveBeenCalledTimes(2)
    expect(pt.realtime).toBe(instances[1])
  })

  it('switching modes releases the realtime tracer', async () => {
    const instances = []
    const engine = { state: { phase: Phase.PLAYING }, debugMode: { active: false } }
    const pt = new LazyPathTraceView(engine, { loadRealtime: async () => realtimeModule(instances), availability: ok })
    pt.setMode('realtime')
    pt.afterRender(0, Phase.PLAYING)
    for (let i = 0; i < 4; i++) await flush()
    pt.setMode('viewer')
    expect(instances[0].dispose).toHaveBeenCalledOnce()
    expect(pt.realtime).toBeNull()
    pt.afterRender(1, Phase.PLAYING)
    for (let i = 0; i < 4; i++) await flush()
    expect(instances).toHaveLength(1)
  })
})
