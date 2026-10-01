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
  FILTER_DECAY,
  FILTER_ITERATIONS,
  PathTraceBlend,
  SNAPSHOT_SLOTS,
  filterIterations,
  traceSize,
} from '../pathtrace/pathTraceBlend.js'
import { REBUILD_DISTANCE, needsRebuild, worldKey } from '../pathtrace/realtimePolicy.js'
import { ProxySceneBuilder, REALTIME_SKIPPED_PARTS, mergeChunk } from '../pathtrace/proxyScene.js'
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
// policy, the merged chunk proxies, and the facade's realtime mode. The
// WebGPU tracer itself needs a GPU and is verified in the browser (doc §6).

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

  it('filters a fresh frame fully and fades the filter as a still view converges', () => {
    expect(filterIterations(0)).toBe(FILTER_ITERATIONS)
    expect(filterIterations(FILTER_DECAY)).toBe(FILTER_ITERATIONS - 1)
    expect(filterIterations(FILTER_DECAY * FILTER_ITERATIONS)).toBe(0)
    expect(filterIterations(1000)).toBe(0)
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

describe('merged chunk proxies (realtime)', () => {
  const materials = createGBufferMaterials({ capabilities: { getMaxAnisotropy: () => 4 } })
  const geom = createGeometries()
  const { config } = worldConfigForFamily('office')
  const clear = [{ cx: 0, cy: 0, cz: 0, lx: HUB_CELL, lz: HUB_CELL, r: 1 }]
  const chunk = new Chunk(0, 0, 0, hashStr('review#1'), materials, geom, null, config, clear, null)
  const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.1, 180)
  camera.position.set(SPAWN_WORLD, EYE_H, SPAWN_WORLD)
  camera.updateMatrixWorld()

  it('bakes instances into world space and folds instance colour into vertex colour', () => {
    const mats = new Map()
    const materialFor = (src) => {
      if (!mats.has(src)) mats.set(src, new THREE.MeshStandardMaterial({ vertexColors: true }))
      return mats.get(src)
    }
    const { meshes, triangles, instances } = mergeChunk(chunk.group, materialFor)
    expect(instances).toBeGreaterThan(100)
    expect(meshes.length).toBe(mats.size)
    let tris = 0
    for (const m of meshes) {
      const g = m.geometry
      tris += g.index.count / 3
      for (const key of ['position', 'normal', 'uv', 'color', 'tangent']) expect(g.attributes[key]).toBeDefined()
      g.computeBoundingBox()
      // World space: inside the chunk's footprint (plus trim overhang).
      expect(g.boundingBox.min.x).toBeGreaterThan(-1)
      expect(g.boundingBox.max.x).toBeLessThan(43)
    }
    expect(tris).toBe(triangles)
    // The lit panels' tint survives as vertex colour.
    const panelMesh = meshes.find((m) => m.material === mats.get(materials.panel))
    const c = panelMesh.geometry.attributes.color
    let tinted = false
    for (let i = 0; i < c.count && !tinted; i++) tinted = c.getX(i) !== 1 || c.getY(i) !== 1 || c.getZ(i) !== 1
    expect(tinted).toBe(true)
  })

  it('leaves the realtime-skipped parts out', () => {
    const materialFor = () => new THREE.MeshStandardMaterial()
    const full = mergeChunk(chunk.group, materialFor)
    const skip = new Set(REALTIME_SKIPPED_PARTS.map((k) => chunk.renderParts[k]).filter(Boolean))
    expect(skip.size).toBeGreaterThan(0)
    const lean = mergeChunk(chunk.group, materialFor, skip)
    expect(lean.triangles).toBeLessThan(full.triangles)
  })

  it('caches merged chunks across builds and prewarms within a budget', () => {
    const builder = new ProxySceneBuilder({ merged: true, skipParts: REALTIME_SKIPPED_PARTS })
    const built = vi.fn((g) => {
      g.boundsTree = { fake: true }
    })
    // Budget 0 ms: merges the chunk, builds nothing yet.
    let clock = 0
    const now = () => clock
    expect(builder.prewarm([chunk], { x: SPAWN_WORLD, z: SPAWN_WORLD, budgetMs: 0, buildBVH: built, now })).toBe(true)
    expect(built).not.toHaveBeenCalled()
    // A real budget builds every BVH.
    builder.prewarm([chunk], { x: SPAWN_WORLD, z: SPAWN_WORLD, budgetMs: 1e9, buildBVH: built, now })
    const count = built.mock.calls.length
    expect(count).toBeGreaterThan(0)
    const first = builder.build({ chunks: [chunk], camera, panelMaterial: materials.panel })
    expect(first.stats.mergedChunks).toBe(0) // prewarmed
    // Cached meshes move to the next scene, so read this one first.
    const meshesA = first.scene.children.filter((o) => o.isMesh)
    for (const m of meshesA) expect(m.geometry.boundsTree).toEqual({ fake: true })
    const second = builder.build({ chunks: [chunk], camera, panelMaterial: materials.panel })
    expect(second.stats.mergedChunks).toBe(0)
    const meshesB = second.scene.children.filter((o) => o.isMesh)
    expect(meshesB.map((m) => m.geometry)).toEqual(meshesA.map((m) => m.geometry))
    // Merged proxies use vertex colours; the lit panel stays a dark diffuser.
    for (const m of meshesB) expect(m.material.vertexColors).toBe(true)
    builder.dispose()
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
