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
    expect(deferred._effectScratchRTs.get('hdr').size).toBe(1)
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
})
