import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { DeferredRenderer } from '../DeferredRenderer.js'
import { AO_SCALE, BLOOM_SCALE, SHADOW_SCALE, VOL_SCALE } from '../../world/constants.js'

function makeRenderer(width = 320, height = 180, pixelRatio = 1) {
  const size = { width, height, pixelRatio }
  return {
    size,
    setClearColor: vi.fn(),
    setRenderTarget: vi.fn(),
    render: vi.fn(),
    getPixelRatio: () => size.pixelRatio,
    getSize: (out) => out.set(size.width, size.height),
  }
}

function makeDeferred(renderer = makeRenderer()) {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 100)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return new DeferredRenderer(renderer, new THREE.Scene(), camera)
}

describe('DeferredRenderer render-target lifecycle', () => {
  it('keeps HDR color/material data while compacting normalized view normals', () => {
    const deferred = makeDeferred()

    expect(deferred.gColor.format).toBe(THREE.RGBAFormat)
    expect(deferred.gColor.type).toBe(THREE.HalfFloatType)
    expect(deferred.gNormal.format).toBe(THREE.RGBAFormat)
    expect(deferred.gNormal.type).toBe(THREE.UnsignedByteType)

    deferred.dispose()
  })

  it('re-clears skipped-pass identity targets after a GL context restore', () => {
    const renderer = makeRenderer()
    const listeners = new Map()
    renderer.domElement = {
      addEventListener: vi.fn((type, fn) => listeners.set(type, fn)),
      removeEventListener: vi.fn((type) => listeners.delete(type)),
    }
    renderer.getClearColor = (c) => c
    renderer.getClearAlpha = () => 1
    renderer.clear = vi.fn()
    const deferred = makeDeferred(renderer)

    deferred._clearRT(deferred.aoBlurRT, 0xffffff)
    deferred._clearRT(deferred.aoBlurRT, 0xffffff)
    expect(renderer.clear).toHaveBeenCalledTimes(1) // cached identity: no re-clear

    listeners.get('webglcontextrestored')()
    deferred._clearRT(deferred.aoBlurRT, 0xffffff)
    expect(renderer.clear).toHaveBeenCalledTimes(2) // storage was recreated empty

    deferred.dispose()
    expect(listeners.has('webglcontextrestored')).toBe(false)
  })

  it('keeps full-resolution attachments valid in a collapsed viewport', () => {
    const renderer = makeRenderer(0, 0, 0.5)
    const deferred = makeDeferred(renderer)
    deferred.setSize()
    expect([deferred.gBuffer.width, deferred.gBuffer.height]).toEqual([1, 1])
    expect(deferred.outlineUniforms.uTexel.value.toArray()).toEqual([1, 1])
    expect(deferred.fxaaUniforms.uTexel.value.toArray()).toEqual([1, 1])
    deferred.dispose()
  })

  it('clears geometry but avoids redundant clears on opaque fullscreen passes', () => {
    const renderer = makeRenderer()
    renderer.autoClear = true
    const deferred = makeDeferred(renderer)
    vi.spyOn(deferred, '_clearRT').mockImplementation(() => {})
    const clears = []
    renderer.render.mockImplementation(() => clears.push(renderer.autoClear))

    deferred.render(0)
    expect(clears.length).toBeGreaterThan(5)
    expect(clears[0]).toBe(true)
    expect(clears.slice(1).every((clear) => clear === false)).toBe(true)
    expect(renderer.autoClear).toBe(true)

    deferred.setDebugView(5)
    deferred.render(1)
    expect(renderer.autoClear).toBe(true)
    deferred.dispose()
  })

  it('restores renderer, scene and timing state if a pass throws', () => {
    const renderer = makeRenderer()
    renderer.autoClear = false
    const deferred = makeDeferred(renderer)
    const background = new THREE.Color(0x887744)
    deferred.scene.background = background
    deferred.timingEnabled = true
    deferred.timer = { frameStart: vi.fn(), begin: vi.fn(), end: vi.fn(), frameEnd: vi.fn(), dispose: vi.fn() }
    renderer.render.mockImplementation(() => { throw new Error('lost context') })

    expect(() => deferred.render(0)).toThrow('lost context')
    expect(deferred.scene.background).toBe(background)
    expect(renderer.autoClear).toBe(false)
    expect(deferred.timer.end).toHaveBeenCalledOnce()
    expect(deferred.timer.frameEnd).toHaveBeenCalledOnce()
    deferred.dispose()
  })

  it('keeps depth only on the G-buffer', () => {
    const deferred = makeDeferred()

    expect(deferred.gBuffer.depthBuffer).toBe(true)
    expect(deferred.gBuffer.depthTexture).toBe(deferred.depthTex)

    const postTargets = new Set([
      deferred.litRT,
      deferred.aoRT,
      deferred.aoBlurRT,
      deferred.shadowRT,
      deferred.shadowBlurRT,
      deferred.volRT,
      deferred.bloomPreRT,
      deferred.bloomTmpRT,
      deferred.bloomRT,
      deferred.bloomWideTmpRT,
      deferred.bloomWideRT,
      deferred.sceneRT,
      deferred.gradeRT,
    ])
    for (const target of postTargets) {
      expect(target.depthBuffer).toBe(false)
      expect(target.depthTexture).toBe(null)
    }

    deferred.dispose()
  })

  it('pools disjoint half-resolution intermediates without aliasing final debug channels', () => {
    const deferred = makeDeferred()
    const maskScales = new Set([AO_SCALE, SHADOW_SCALE])

    expect(deferred._effectScratchRTs.size).toBe(2)
    expect(deferred._effectScratchRTs.get('mask').size).toBe(maskScales.size)
    // Bloom's tight (half-res) and wide (quarter-res) horizontal intermediates
    // are pooled at their own scales.
    expect(deferred._effectScratchRTs.get('hdr').size).toBe(2)
    expect(deferred.bloomWideTmpRT).not.toBe(deferred.bloomTmpRT)
    expect(deferred.bloomWideRT).not.toBe(deferred.bloomWideTmpRT)
    expect(deferred.compositeUniforms.tBloomWide.value).toBe(deferred.bloomWideRT.texture)
    // These game effects currently share one half-resolution target, while the
    // pool still separates them automatically if a future tuning changes scale.
    expect(deferred.aoRT === deferred.shadowRT).toBe(AO_SCALE === SHADOW_SCALE)
    expect(deferred.shadowRT).not.toBe(deferred.bloomTmpRT)
    expect(deferred.aoBlurRT).not.toBe(deferred.aoRT)
    expect(deferred.shadowBlurRT).not.toBe(deferred.shadowRT)
    expect(deferred.bloomPreRT).not.toBe(deferred.bloomTmpRT)
    expect(deferred.bloomRT).not.toBe(deferred.bloomTmpRT)
    expect(deferred.aoBlurUniforms.tAO.value).toBe(deferred.aoRT.texture)
    expect(deferred.shadowBlurUniforms.tShadow.value).toBe(deferred.shadowRT.texture)

    expect(deferred.debugViewUniforms.tAO.value).toBe(deferred.aoBlurRT.texture)
    expect(deferred.debugViewUniforms.tShadow.value).toBe(deferred.shadowBlurRT.texture)
    expect(deferred.debugViewUniforms.tVol.value).toBe(deferred.volRT.texture)
    expect(deferred.debugViewUniforms.tBloom.value).toBe(deferred.bloomRT.texture)
    expect(deferred.debugViewUniforms.tLit.value).toBe(deferred.litRT.texture)
    expect(deferred.debugViewUniforms.tScene.value).toBe(deferred.sceneRT.texture)

    deferred.dispose()
  })

  it('stores scalar AO and shadow masks as filtered R8 while bloom remains RGBA16F', () => {
    const deferred = makeDeferred()

    for (const target of [deferred.aoRT, deferred.aoBlurRT, deferred.shadowRT, deferred.shadowBlurRT]) {
      expect(target.texture.format).toBe(THREE.RedFormat)
      expect(target.texture.type).toBe(THREE.UnsignedByteType)
      expect(target.texture.minFilter).toBe(THREE.LinearFilter)
      expect(target.texture.magFilter).toBe(THREE.LinearFilter)
      expect(target.depthBuffer).toBe(false)
    }
    for (const target of [deferred.bloomPreRT, deferred.bloomTmpRT, deferred.bloomRT]) {
      expect(target.texture.format).toBe(THREE.RGBAFormat)
      expect(target.texture.type).toBe(THREE.HalfFloatType)
      expect(target.depthBuffer).toBe(false)
    }

    deferred.dispose()
  })

  it('resizes pooled and final targets at their configured scales while preserving bindings', () => {
    const renderer = makeRenderer()
    const deferred = makeDeferred(renderer)
    const scratch = deferred.aoRT

    renderer.size.width = 101
    renderer.size.height = 51
    renderer.size.pixelRatio = 1.5
    deferred.setSize()

    const dw = Math.floor(renderer.size.width * renderer.size.pixelRatio)
    const dh = Math.floor(renderer.size.height * renderer.size.pixelRatio)
    expect([deferred.gBuffer.width, deferred.gBuffer.height]).toEqual([dw, dh])
    expect([deferred.litRT.width, deferred.litRT.height]).toEqual([dw, dh])
    expect([deferred.sceneRT.width, deferred.sceneRT.height]).toEqual([dw, dh])
    expect([deferred.gradeRT.width, deferred.gradeRT.height]).toEqual([dw, dh])

    expect(deferred.aoRT).toBe(scratch)
    expect([deferred.aoRT.width, deferred.aoRT.height]).toEqual([
      Math.max(1, Math.floor(dw * AO_SCALE)),
      Math.max(1, Math.floor(dh * AO_SCALE)),
    ])
    expect([deferred.aoBlurRT.width, deferred.aoBlurRT.height]).toEqual([
      Math.max(1, Math.floor(dw * AO_SCALE)),
      Math.max(1, Math.floor(dh * AO_SCALE)),
    ])
    expect([deferred.shadowRT.width, deferred.shadowRT.height]).toEqual([
      Math.max(1, Math.floor(dw * SHADOW_SCALE)),
      Math.max(1, Math.floor(dh * SHADOW_SCALE)),
    ])
    expect([deferred.shadowBlurRT.width, deferred.shadowBlurRT.height]).toEqual([
      Math.max(1, Math.floor(dw * SHADOW_SCALE)),
      Math.max(1, Math.floor(dh * SHADOW_SCALE)),
    ])
    expect([deferred.volRT.width, deferred.volRT.height]).toEqual([
      Math.max(1, Math.floor(dw * VOL_SCALE)),
      Math.max(1, Math.floor(dh * VOL_SCALE)),
    ])
    expect([deferred.bloomRT.width, deferred.bloomRT.height]).toEqual([
      Math.max(1, Math.floor(dw * BLOOM_SCALE)),
      Math.max(1, Math.floor(dh * BLOOM_SCALE)),
    ])
    expect([deferred.bloomTmpRT.width, deferred.bloomTmpRT.height]).toEqual([
      Math.max(1, Math.floor(dw * BLOOM_SCALE)),
      Math.max(1, Math.floor(dh * BLOOM_SCALE)),
    ])
    expect(deferred.debugViewUniforms.tAO.value).toBe(deferred.aoBlurRT.texture)
    expect(deferred.debugViewUniforms.tLit.value).toBe(deferred.litRT.texture)

    deferred.dispose()
  })

  it('reuses the dead lighting target for outline output after the debug branch', () => {
    const renderer = makeRenderer()
    const deferred = makeDeferred(renderer)

    const outlined = deferred._renderOutline()
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(deferred.litRT)
    expect(deferred.outlineUniforms.tDiffuse.value).toBe(deferred.sceneRT.texture)
    expect(outlined).toBe(deferred.litRT.texture)

    renderer.setRenderTarget.mockClear()
    deferred.setOutline(false)
    expect(deferred._renderOutline()).toBe(deferred.sceneRT.texture)
    expect(renderer.setRenderTarget).not.toHaveBeenCalled()

    deferred.dispose()
  })

  it('preserves pass order and never overwrites the lighting debug channel with outline', () => {
    const deferred = makeDeferred()
    const order = []
    const stages = [
      ['_updateFrame', 'update'],
      ['_renderGBuffer', 'gbuffer'],
      ['_renderSSAO', 'ssao'],
      ['_renderShadow', 'shadow'],
      ['_renderLighting', 'lighting'],
      ['_renderVolumetrics', 'volumetric'],
      ['_renderBloom', 'bloom'],
      ['_composite', 'composite'],
      ['_renderOutline', 'outline'],
      ['_renderGrade', 'grade'],
      ['_renderFXAA', 'fxaa'],
      ['_renderDebug', 'debug'],
    ]
    for (const [method, label] of stages) {
      vi.spyOn(deferred, method).mockImplementation(() => {
        order.push(label)
        if (method === '_renderOutline') return deferred.litRT.texture
      })
    }
    vi.spyOn(deferred, '_clearRT').mockImplementation(() => {})
    deferred.lamps.uLampCount.value = 1
    deferred.visibleLamps.uLampCount.value = 1

    deferred.render(1)
    expect(order).toEqual([
      'update',
      'gbuffer',
      'ssao',
      'shadow',
      'lighting',
      'volumetric',
      'bloom',
      'composite',
      'outline',
      'grade',
      'fxaa',
    ])

    order.length = 0
    deferred.setDebugView(5)
    deferred.render(2)
    expect(order).toEqual([
      'update',
      'gbuffer',
      'ssao',
      'shadow',
      'lighting',
      'volumetric',
      'bloom',
      'composite',
      'debug',
    ])

    deferred.dispose()
  })

  it('owns no cel LUT and no stale AO resolution uniform', () => {
    const deferred = makeDeferred()

    // The cel ramp is the analytic CEL_BAND snippet now (see cel-band.test.js),
    // so there is no LUT texture to bind, resize or dispose.
    expect(deferred.ramp).toBeUndefined()
    expect(deferred.lightUniforms.tRamp).toBeUndefined()
    expect(deferred.shadowUniforms.tRamp).toBeUndefined()
    // SSAO jitters from gl_FragCoord, so the full-res size it used to (wrongly)
    // scale half-res UVs by is gone.
    expect(deferred.aoUniforms.uResolution).toBeUndefined()

    deferred.dispose()
  })

  it('fills a skipped pass output once instead of every frame', () => {
    const renderer = makeRenderer()
    renderer.clear = vi.fn()
    renderer.getClearColor = (out) => out.set(0, 0, 0)
    renderer.getClearAlpha = () => 1
    const deferred = makeDeferred(renderer)
    for (const method of [
      '_renderGBuffer',
      '_renderSSAO',
      '_renderShadow',
      '_renderLighting',
      '_renderVolumetrics',
      '_renderBloom',
      '_composite',
      '_renderGrade',
      '_renderFXAA',
    ]) {
      vi.spyOn(deferred, method).mockImplementation(() => {})
    }
    vi.spyOn(deferred, '_renderOutline').mockReturnValue(deferred.litRT.texture)
    deferred.applyQuality({
      ao: { enabled: false, samples: 8 },
      shadow: { enabled: false, steps: 12, lamps: 4 },
      vol: { enabled: false, steps: 16, lights: 6 },
      bloom: false,
      fxaa: true,
    })

    // First frame fills each skipped pass's output with its identity value.
    deferred.render(0)
    expect(renderer.clear).toHaveBeenCalledTimes(5) // ao, shadow, vol, bloom (tight + wide)

    // The identity never changes, so subsequent frames must not re-clear.
    renderer.clear.mockClear()
    deferred.render(1)
    deferred.render(2)
    expect(renderer.clear).not.toHaveBeenCalled()

    // Resizing reallocates the storage, so the cached fills are invalid.
    renderer.size.width = 640
    deferred.setSize()
    deferred.render(3)
    expect(renderer.clear).toHaveBeenCalledTimes(5)

    // And a pass that starts rendering again reclaims its target: re-enabling
    // volumetrics then disabling it must clear once more, not read as clean.
    // The lamp goes in the SOURCE set — _updateFrame derives the visible count
    // from it every frame, so poking the visible count directly would not stick.
    renderer.clear.mockClear()
    deferred.lamps.uLampPos.value[0].set(0, 0, -10)
    deferred.lamps.uLampCount.value = 1
    deferred.volEnabled = true
    deferred.render(4)
    expect(deferred.visibleLamps.uLampCount.value).toBe(1)
    expect(renderer.clear).not.toHaveBeenCalled()
    deferred.volEnabled = false
    deferred.render(5)
    expect(renderer.clear).toHaveBeenCalledTimes(1)

    deferred.dispose()
  })

  it('disposes each pooled render target exactly once', () => {
    const deferred = makeDeferred()
    const pooledTargets = new Set(
      [...deferred._effectScratchRTs.values()].flatMap((scaledPool) => [...scaledPool.values()]),
    )
    const scratchDisposals = [...pooledTargets].map((target) => vi.spyOn(target, 'dispose'))
    const litDispose = vi.spyOn(deferred.litRT, 'dispose')
    const sceneDispose = vi.spyOn(deferred.sceneRT, 'dispose')

    deferred.dispose()

    for (const dispose of scratchDisposals) expect(dispose).toHaveBeenCalledOnce()
    expect(litDispose).toHaveBeenCalledOnce()
    expect(sceneDispose).toHaveBeenCalledOnce()
    expect(deferred._effectScratchRTs.size).toBe(0)
  })

  it('releases every post-process shader material once on repeated teardown', () => {
    const deferred = makeDeferred()
    const disposals = Object.values(deferred)
      .filter((value) => value?.material?.isRawShaderMaterial)
      .map((quad) => vi.spyOn(quad.material, 'dispose'))
    expect(disposals).toHaveLength(13)
    deferred.dispose()
    deferred.dispose()
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce()
  })
})
