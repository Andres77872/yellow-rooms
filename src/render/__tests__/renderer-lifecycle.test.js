import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { DeferredRenderer } from '../DeferredRenderer.js'
import { GridLightTextures } from '../GridLightTextures.js'
import { FrameGpuTimer, PassTimer } from '../PassTimer.js'
import { SAMPLER_PRECISION } from '../shaders/common.js'
import { lightingFrag } from '../shaders/lighting.js'
import { LOOK_PROFILES } from '../lookProfile.js'
import { GRAPHICS_PRESETS, resolveGraphics } from '../../core/graphics.js'
import { LIGHT_INTENSITY } from '../../world/constants.js'
import { GI_TEXELS, GRID_H, GRID_W } from '../../world/lightGrid/gridSpec.js'

// Renderer lifecycle under the conditions a synchronous mock never reaches:
// lighting builds that link in the background (compileAsync), context
// restores, skipped passes whose targets other passes still read, and
// probe frames. Each case pins a defect found in the chapter-14 review.

function makeRenderer({ async = false } = {}) {
  const r = {
    size: { width: 320, height: 180, pixelRatio: 1 },
    target: null,
    clearColor: new THREE.Color(0, 0, 0),
    clearAlpha: 1,
    clears: [],
    setRenderTarget: vi.fn((rt) => {
      r.target = rt
    }),
    render: vi.fn(),
    // Same premultiply as three's ColorBuffer.setClear (premultipliedAlpha
    // is the WebGLRenderer default).
    setClearColor: vi.fn((c, a = 1) => {
      r.clearColor = new THREE.Color(c)
      r.clearAlpha = a
    }),
    getClearColor: (out) => out.copy(r.clearColor),
    getClearAlpha: () => r.clearAlpha,
    clear: vi.fn(() => {
      const a = r.clearAlpha
      r.clears.push({ rt: r.target, rgba: [r.clearColor.r * a, r.clearColor.g * a, r.clearColor.b * a, a] })
    }),
    getPixelRatio: () => r.size.pixelRatio,
    getSize: (out) => out.set(r.size.width, r.size.height),
  }
  if (async) {
    r.jobs = []
    r.compileAsync = vi.fn((scene) => new Promise((resolve) => r.jobs.push({ scene, resolve })))
  }
  return r
}

function makeDeferred(renderer = makeRenderer()) {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 100)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return new DeferredRenderer(renderer, new THREE.Scene(), camera)
}

// Past the first frame, where builds link in the background.
function makeLiveDeferred(renderer = makeRenderer({ async: true })) {
  const d = makeDeferred(renderer)
  d._frames = 1
  d._precompiled = true
  return d
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const quality = (name) => resolveGraphics({ get: (k) => (k === 'preset' ? name : GRAPHICS_PRESETS[name][k]) })
const jobFor = (r, m) => r.jobs.find((j) => j.scene.children.some((c) => c.material === m))
const drawsVariant = (d) =>
  d.lightQuad.material.fragmentShader === SAMPLER_PRECISION + lightingFrag(d.variant)

describe('lighting build swap', () => {
  it('a request back to the drawing build cancels the in-flight one (A -> B -> A)', async () => {
    const r = makeRenderer({ async: true })
    const d = makeLiveDeferred(r)
    const pbr = d.lightQuad.material
    d.setLook('classic')
    const toon = d._pendingLightMat
    expect(toon).toBeTruthy()
    const disposeToon = vi.spyOn(toon, 'dispose')
    d.setLook('neutral') // the PBR build that is still drawing
    expect(d._pendingLightMat).toBe(null)
    expect(d.look.id).toBe('neutral')
    await flush()
    // Three is still polling the superseded build: it must not be disposed yet.
    expect(disposeToon).not.toHaveBeenCalled()
    jobFor(r, toon).resolve()
    await flush()
    expect(disposeToon).toHaveBeenCalledOnce()
    expect(d.lightQuad.material).toBe(pbr)
    expect(d.variant.occV2).toBe(true)
    expect(drawsVariant(d)).toBe(true)
    d.dispose()
  })

  it('flash ULTRA -> HIGH -> ULTRA never leaves the PCSS build on a non-PCSS binding', async () => {
    const r = makeRenderer({ async: true })
    const d = makeDeferred(r)
    d.applyQuality(quality('high'))
    d._frames = 1
    d._precompiled = true
    const noCompare = () => expect(d.lightUniforms.tFlashDepth.value.compareFunction ?? null).toBe(null)
    noCompare()
    d.applyQuality(quality('ultra'))
    noCompare()
    d.applyQuality(quality('high'))
    noCompare()
    await flush()
    for (const j of r.jobs) j.resolve()
    await flush()
    expect(d.lightQuad.material.fragmentShader).not.toContain('#define FLASH_FILTER 2')
    expect(d.variant.flashFilter).toBe(1)
    expect(drawsVariant(d)).toBe(true)
    noCompare()
    d.dispose()
  })

  it('keeps the PCSS blocker target while the PCSS build is still drawing', async () => {
    const r = makeRenderer({ async: true })
    const d = makeDeferred(r)
    d.applyQuality(quality('ultra'))
    d._frames = 1
    d._precompiled = true
    const blocker = () => d.flashShadow.blockerTexture
    expect(d.variant.flashFilter).toBe(2)
    d.applyQuality(quality('high'))
    // The PCSS build still draws: its blocker search must keep real blockers.
    expect(d.flashShadow.pcss).toBe(true)
    expect(d.lightUniforms.tFlashDepth.value).toBe(blocker())
    await flush()
    for (const j of r.jobs) j.resolve()
    await flush()
    expect(d.variant.flashFilter).toBe(1)
    expect(d.flashShadow.pcss).toBe(false)
    expect(d.lightUniforms.tFlashDepth.value).toBe(d._flashDepthNone)
    expect(d.flashUniforms.tFlashShadow.value).toBe(d.flashShadow.depth)
    expect(d._flashTargetReady).toBe(false)
    d.dispose()
  })

  it('re-allocates the blocker target when a look re-enters PCSS from the analytic torch', async () => {
    const r = makeRenderer({ async: true })
    const d = makeDeferred(r)
    d.applyQuality(quality('ultra'))
    d.setAnalyticTorch(true)
    expect(d.variant.flashFilter).toBe(0)
    expect(d.flashShadow.pcss).toBe(false)
    d._frames = 1
    d._precompiled = true
    d.setAnalyticTorch(false)
    await flush()
    for (const j of r.jobs) j.resolve()
    await flush()
    expect(d.variant.flashFilter).toBe(2)
    expect(d.flashShadow.pcss).toBe(true)
    expect(d.lightUniforms.tFlashDepth.value).toBe(d.flashShadow.blockerTexture)
    d.dispose()
  })

  it('keeps the outgoing build on its own pass set, inputs and look until the new one lands', async () => {
    const r = makeRenderer({ async: true })
    const d = makeLiveDeferred(r)
    const lamp = d.lightUniforms.uLampIntensity.value
    const reset = vi.spyOn(d.exposure, 'reset')
    d.setLook('classic')
    const toon = d._pendingLightMat
    let ready = false
    d.whenLightingReady().then(() => (ready = true))
    // Still drawing semi-realistic: v2 occlusion, its lamp power, no reset.
    expect(d.look.id).toBe('semiRealistic')
    expect(d.variant.occV2).toBe(true)
    expect(d.lightUniforms.tOcc.value).toBe(d.occRT.textures[0])
    expect(d.lightUniforms.uLampIntensity.value).toBe(lamp)
    expect(reset).not.toHaveBeenCalled()
    expect(drawsVariant(d)).toBe(true)
    await flush()
    expect(ready).toBe(false)
    jobFor(r, toon).resolve()
    await flush()
    expect(ready).toBe(true)
    expect(d.lightQuad.material).toBe(toon)
    expect(d.look.id).toBe('classic')
    expect(d.variant.occV2).toBe(false)
    expect(d.lightUniforms.tOcc.value).toBe(d.aoBlurRT.texture)
    expect(d.lightUniforms.tContact.value).toBe(d.shadowBlurRT.texture)
    expect(d.lightUniforms.uLampIntensity.value).toBe(LIGHT_INTENSITY * LOOK_PROFILES.classic.lampPower)
    expect(reset).toHaveBeenCalledOnce()
    expect(drawsVariant(d)).toBe(true)
    d.dispose()
  })

  it('only the newest request installs, whatever order the compiles finish in', async () => {
    const r = makeRenderer({ async: true })
    const d = makeDeferred(r)
    d.applyQuality(quality('high'))
    d._frames = 1
    d._precompiled = true
    d.setLook('classic')
    const first = d._pendingLightMat
    const disposeFirst = vi.spyOn(first, 'dispose')
    d.applyQuality(quality('ultra'))
    const second = d._pendingLightMat
    expect(second).not.toBe(first)
    await flush()
    jobFor(r, second).resolve()
    await flush()
    expect(d.lightQuad.material).toBe(second)
    jobFor(r, first).resolve()
    await flush()
    expect(disposeFirst).toHaveBeenCalledOnce()
    expect(d.lightQuad.material).toBe(second)
    expect(d.look.id).toBe('classic')
    expect(drawsVariant(d)).toBe(true)
    d.dispose()
  })

  it('renderer teardown leaves an in-flight build to dispose itself once its compile settles', async () => {
    const r = makeRenderer({ async: true })
    const d = makeLiveDeferred(r)
    d.setLook('classic')
    const toon = d._pendingLightMat
    const disposeToon = vi.spyOn(toon, 'dispose')
    await flush()
    d.dispose()
    expect(disposeToon).not.toHaveBeenCalled()
    jobFor(r, toon).resolve()
    await flush()
    expect(disposeToon).toHaveBeenCalledOnce()
    expect(d.lightQuad.material).not.toBe(toon)
  })
})

describe('fullscreen precompile (volumetric haze and look-specific passes)', () => {
  it('links every other fullscreen build after the first frame and swaps haze without a new material', async () => {
    const r = makeRenderer({ async: true })
    const d = makeDeferred(r)
    d.render(0)
    await flush()
    expect(r.compileAsync).toHaveBeenCalledOnce()
    const mats = new Set(r.jobs[0].scene.children.map((c) => c.material))
    for (const m of [...d._volMats, d.aoQuad.material, d.shadowQuad.material, d.outlineQuad.material,
      d.signalQuad.material, d.smearQuad.material, d.motionQuad.material, d.gtaoQuad.material]) {
      expect(mats.has(m)).toBe(true)
    }
    expect(mats.has(d.lightQuad.material)).toBe(false)
    d.render(1)
    expect(r.compileAsync).toHaveBeenCalledOnce()

    const plain = d.volQuad.material
    d.applyQuality(quality('ultra'))
    expect(d.volQuad.material).toBe(d._volMats[1])
    expect(d.volQuad.material.fragmentShader).toContain('#define VOL_HAZE')
    d.applyQuality(quality('high'))
    expect(d.volQuad.material).toBe(plain)

    // Teardown while the precompile is polling waits for it.
    const disposeHaze = vi.spyOn(d._volMats[1], 'dispose')
    d.dispose()
    expect(disposeHaze).not.toHaveBeenCalled()
    r.jobs[0].resolve()
    await flush()
    expect(disposeHaze).toHaveBeenCalledOnce()
  })
})

describe('skipped passes and the targets other passes still read', () => {
  it('clears the occlusion v2 contact identity to all ones through a premultiplying clear', () => {
    const r = makeRenderer()
    const d = makeDeferred(r)
    d.applyQuality(quality('high'))
    d.applyQuality({ ...quality('high'), shadow: { ...quality('high').shadow, enabled: false } })
    d.render(0)
    const contact = r.clears.find((c) => c.rt === d.contactRawRT)
    expect(contact.rgba).toEqual([1, 1, 1, 1])
    // No identity may rely on alpha < 1: the premultiply would black it out.
    for (const c of r.clears) expect(c.rgba[3]).toBe(1)
    d.dispose()
  })

  it('keeps the CCD smear input live with bloom off, and never stale', () => {
    const r = makeRenderer()
    const d = makeDeferred(r)
    const q = quality('high')
    d.setLook('camcorder')
    d.applyQuality({ ...q, bloom: false })
    const pre = vi.spyOn(d, '_renderBloomPrefilter')
    d.render(0)
    expect(pre).toHaveBeenCalledOnce()

    // No smear to feed: the prefilter holds black, re-cleared after every
    // frame bloom wrote it (bloom off -> on -> off).
    d.setLook('semiRealistic')
    const preClears = () => r.clears.filter((c) => c.rt === d.bloomPreRT).length
    d.render(1)
    expect(preClears()).toBe(1)
    d.render(2)
    expect(preClears()).toBe(1)
    d.applyQuality(q)
    d.render(3)
    d.applyQuality({ ...q, bloom: false })
    d.render(4)
    expect(preClears()).toBe(2)
    d.dispose()
  })
})

describe('NOISE setting', () => {
  it('gates the look sensor noise as well as the tape noise', () => {
    const d = makeDeferred()
    const g = d.gradeUniforms
    d.setLook('camcorder')
    expect(g.sensorNoise.value).toBe(LOOK_PROFILES.camcorder.sensorNoise)
    d.setSignalAccess({ noise: false })
    expect(g.sensorNoise.value).toBe(0)
    expect(d.signalUniforms.uTapeNoise.value).toBe(0)
    d.setLook('semiRealistic') // the default look carries sensor noise too
    expect(g.sensorNoise.value).toBe(0)
    d.setSignalAccess({ noise: true })
    expect(g.sensorNoise.value).toBe(LOOK_PROFILES.semiRealistic.sensorNoise)
    d.dispose()
  })
})

describe('evidence probes', () => {
  it("a 'lit' probe reads the lighting output, not the motion-blurred composite", () => {
    const r = makeRenderer()
    r.readRenderTargetPixels = vi.fn()
    const d = makeDeferred(r)
    d.setLook('camcorder')
    d.setMotionBlur(true)
    const blur = vi.spyOn(d, '_renderMotionBlur')
    d.render(0)
    d.render(1)
    expect(blur).toHaveBeenCalledOnce() // live frames blur (history valid on the second)
    blur.mockClear()
    d.probe([{ px: [4, 4] }], { source: 'lit' })
    d.probe([{ px: [4, 4] }], { source: 'bogus' }) // unknown sources read litRT too
    expect(blur).not.toHaveBeenCalled()
    expect(d._probeUniforms.tSrc.value).toBe(d.litRT.texture)
    d.probe([{ px: [4, 4] }], { source: 'scene' })
    expect(blur).toHaveBeenCalledOnce()
    d.dispose()
  })
})

describe('GL context restore', () => {
  function fakeGrid() {
    const n = GRID_W * GRID_H * 4
    const grid = {
      list: new Uint32Array(n),
      edge: new Uint8Array(n),
      lamp: new Uint8Array(n),
      gi: new Uint16Array(n * GI_TEXELS),
      occ: new Uint32Array(n),
      queue: [],
      takeDirty: () => grid.queue.shift() ?? {},
    }
    return grid
  }

  it('grid textures upload whole after a restore, even with rows dirtied that frame', () => {
    const grid = fakeGrid()
    const g = new GridLightTextures(grid)
    const edge = g.textures.edge
    grid.queue.push({ edge: [0, 0, 4, 2] })
    g.sync()
    expect(edge.updateRanges.length).toBe(2) // streamed rows only
    g.restore()
    expect(edge.updateRanges.length).toBe(0)
    const version = edge.version
    grid.queue.push({ edge: [0, 0, 4, 2], list: [2, 2, 1, 1] })
    g.sync()
    for (const tex of Object.values(g.textures)) expect(tex.updateRanges.length).toBe(0)
    expect(edge.version).toBeGreaterThan(version)
    grid.queue.push({ edge: [0, 0, 4, 2] })
    g.sync() // back to partial uploads afterwards
    expect(edge.updateRanges.length).toBe(2)
    g.dispose()
  })

  function fakeGl() {
    const gl = {
      ext: { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb },
      getExtension: vi.fn(() => gl.ext),
      createQuery: () => ({}),
      beginQuery: vi.fn(),
      endQuery: vi.fn(),
      deleteQuery: vi.fn(),
      getQueryParameter: () => false,
      getParameter: () => false,
    }
    return gl
  }

  it('GPU timers re-enable their extension and drop dead queries', () => {
    const gl = fakeGl()
    const frame = new FrameGpuTimer(gl)
    frame.begin()
    frame.end()
    expect(frame._pending.length).toBe(1)
    frame.restore()
    expect(gl.getExtension).toHaveBeenCalledTimes(2)
    expect(frame._pending.length).toBe(0)
    expect(frame.supported).toBe(true)
    expect(gl.deleteQuery).not.toHaveBeenCalled()

    const pass = new PassTimer(gl)
    pass.frameStart()
    pass.begin('a')
    pass.end()
    pass.frameEnd()
    gl.ext = null // the restored context lacks the extension
    pass.restore()
    expect(pass.supported).toBe(false)
    expect(pass._frames.length).toBe(0)
  })

  it('invalidates the torch map, its target, the grid and the timers', () => {
    const r = makeRenderer()
    const listeners = new Map()
    r.domElement = {
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type) => listeners.delete(type),
    }
    const gl = fakeGl()
    r.getContext = () => gl
    const d = makeDeferred(r)
    d.bindLightGrid(fakeGrid())
    d.setFrameTiming(true)
    d.setTiming(true)
    d.render(0)
    expect(d._flashTargetReady).toBe(true)
    const invalidate = vi.spyOn(d.flashShadow, 'invalidate')
    const gridRestore = vi.spyOn(d.grid, 'restore')
    const calls = gl.getExtension.mock.calls.length
    listeners.get('webglcontextrestored')()
    expect(d._flashTargetReady).toBe(false)
    expect(invalidate).toHaveBeenCalledOnce()
    expect(gridRestore).toHaveBeenCalledOnce()
    expect(gl.getExtension.mock.calls.length).toBe(calls + 2) // frame + pass timers
    expect(d.timingEnabled).toBe(true)
    d.dispose()
  })
})
