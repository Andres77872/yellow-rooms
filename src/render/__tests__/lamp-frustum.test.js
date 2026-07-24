import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { DeferredRenderer } from '../DeferredRenderer.js'

function makeRenderer(width = 320, height = 180, pixelRatio = 1) {
  const size = { width, height, pixelRatio }
  return {
    setClearColor: vi.fn(),
    setRenderTarget: vi.fn(),
    render: vi.fn(),
    getPixelRatio: () => size.pixelRatio,
    getSize: (out) => out.set(size.width, size.height),
  }
}

function makeDeferred() {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 100)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return new DeferredRenderer(makeRenderer(), new THREE.Scene(), camera)
}

function setSourceLamp(deferred, i, position, tint, raw = 1) {
  deferred.lamps.uLampPos.value[i].copy(position)
  deferred.lamps.uLampChar.value[i].set(tint[0], tint[1], tint[2], tint[3])
  deferred.lamps.lampFlickerRaw[i] = raw
}

describe('DeferredRenderer lamp influence-frustum culling', () => {
  it('binds every lamp pass to a separate renderer-local visible uniform set', () => {
    const deferred = makeDeferred()
    const source = deferred.lamps
    const visible = deferred.visibleLamps

    expect(visible).toBe(source.visible)
    expect(visible.uLampCount).not.toBe(source.uLampCount)
    expect(visible.uLampChar).not.toBe(source.uLampChar)
    expect(visible.uLampChar.value).not.toBe(source.uLampChar.value)
    expect(visible.uLampChar.value[0]).not.toBe(source.uLampChar.value[0])
    expect(visible.uLampViewPos.value).not.toBe(source.uLampPos.value)
    expect(visible.uLampViewPos.value[0]).not.toBe(source.uLampPos.value[0])

    for (const uniforms of [
      deferred.lightUniforms,
      deferred.shadowUniforms,
      deferred.volUniforms,
    ]) {
      expect(uniforms.uLampViewPos).toBe(visible.uLampViewPos)
      expect(uniforms.uLampCount).toBe(visible.uLampCount)
      expect(uniforms.uLampChar).toBe(visible.uLampChar)
      expect(uniforms.uLampCount).not.toBe(source.uLampCount)
      expect(uniforms.uLampChar).not.toBe(source.uLampChar)
    }

    deferred.dispose()
  })

  it('stably compacts visible lamps without changing source arrays, vectors, characters, or count', () => {
    const deferred = makeDeferred()
    setSourceLamp(deferred, 0, new THREE.Vector3(0, 0, -10), [0.1, 0.2, 0.3, 0.4], 0.25)
    setSourceLamp(deferred, 1, new THREE.Vector3(100, 0, -10), [1.1, 1.2, 1.3, 1.4], 0.5)
    setSourceLamp(deferred, 2, new THREE.Vector3(-2, 1, -8), [2.1, 2.2, 2.3, 2.4], 0.75)
    setSourceLamp(deferred, 3, new THREE.Vector3(0, 0, 30), [3.1, 3.2, 3.3, 3.4], 1)
    deferred.lamps.uLampCount.value = 4

    const posArray = deferred.lamps.uLampPos.value
    const charArray = deferred.lamps.uLampChar.value
    const posRefs = posArray.slice()
    const charRefs = charArray.slice()
    const positionsBefore = posArray.slice(0, 4).map((v) => v.toArray())
    const charsBefore = charArray.slice(0, 4).map((v) => v.toArray())

    deferred._updateFrame()

    expect(deferred.visibleLamps.uLampCount.value).toBe(2)
    expect(deferred.visibleLamps.uLampViewPos.value[0].toArray()).toEqual([0, 0, -10])
    expect(deferred.visibleLamps.uLampViewPos.value[1].toArray()).toEqual([-2, 1, -8])
    expect(deferred.visibleLamps.uLampChar.value[0].toArray()).toEqual([0.1, 0.2, 0.3, 0.25])
    expect(deferred.visibleLamps.uLampChar.value[1].toArray()).toEqual([2.1, 2.2, 2.3, 0.75])

    expect(deferred.lamps.uLampCount.value).toBe(4)
    expect(deferred.lamps.uLampPos.value).toBe(posArray)
    expect(deferred.lamps.uLampChar.value).toBe(charArray)
    for (let i = 0; i < posRefs.length; i++) {
      expect(deferred.lamps.uLampPos.value[i]).toBe(posRefs[i])
      expect(deferred.lamps.uLampChar.value[i]).toBe(charRefs[i])
    }
    expect(posArray.slice(0, 4).map((v) => v.toArray())).toEqual(positionsBefore)
    expect(charArray.slice(0, 4).map((v) => v.toArray())).toEqual(charsBefore)

    // Repeating the derivation while the simulation is frozen stays
    // idempotent; it never folds the derived alpha back into the source.
    deferred._updateFrame()
    expect(charArray.slice(0, 4).map((v) => v.toArray())).toEqual(charsBefore)
    expect(deferred.visibleLamps.uLampChar.value[0].w).toBe(0.25)

    deferred.dispose()
  })

  it('uses the largest live pass range and a small tangent-plane epsilon', () => {
    const deferred = makeDeferred()
    setSourceLamp(deferred, 0, new THREE.Vector3(25, 0, -10), [1, 1, 1, 1])
    const lamp = deferred.lamps.uLampPos.value[0]
    deferred.lamps.uLampCount.value = 1
    deferred.lightUniforms.uLampRange.value = 1
    deferred.shadowUniforms.uLampRange.value = 1
    deferred.volUniforms.uLampRange.value = 20

    deferred._updateFrame()
    expect(deferred.visibleLamps.uLampCount.value).toBe(1)

    deferred.volUniforms.uLampRange.value = 1
    deferred._updateFrame()
    expect(deferred.visibleLamps.uLampCount.value).toBe(0)

    // Put a 1u sphere 0.01u beyond one side plane. The renderer's small
    // precision epsilon retains it; moving another 0.1u out culls it.
    const frustum = new THREE.Frustum().setFromProjectionMatrix(deferred.camera.projectionMatrix)
    const plane = frustum.planes[0]
    lamp.set(0, 0, -10)
    lamp.addScaledVector(plane.normal, -(plane.distanceToPoint(lamp) + 1.01))
    deferred._updateFrame()
    expect(deferred.visibleLamps.uLampCount.value).toBe(1)
    lamp.addScaledVector(plane.normal, -0.1)
    deferred._updateFrame()
    expect(deferred.visibleLamps.uLampCount.value).toBe(0)

    deferred.dispose()
  })

  it('uses the visible count for pass skips and restores a source lamp after a camera turn', () => {
    const deferred = makeDeferred()
    const sourcePosition = new THREE.Vector3(30, 0, 0)
    setSourceLamp(deferred, 0, sourcePosition, [0.8, 0.7, 0.6, 0.5], 0.9)
    deferred.lamps.uLampCount.value = 1
    const sourcePositionRef = deferred.lamps.uLampPos.value[0]

    for (const method of [
      '_renderGBuffer',
      '_renderSSAO',
      '_renderLighting',
      '_renderBloom',
      '_composite',
      '_renderGrade',
      '_renderFXAA',
    ]) {
      vi.spyOn(deferred, method).mockImplementation(() => {})
    }
    vi.spyOn(deferred, '_renderOutline').mockReturnValue(deferred.litRT.texture)
    const shadow = vi.spyOn(deferred, '_renderShadow').mockImplementation(() => {})
    const volumetric = vi.spyOn(deferred, '_renderVolumetrics').mockImplementation(() => {})
    const clear = vi.spyOn(deferred, '_clearRT').mockImplementation(() => {})

    deferred.render(0)
    expect(deferred.visibleLamps.uLampCount.value).toBe(0)
    expect(shadow).not.toHaveBeenCalled()
    expect(volumetric).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledWith(deferred.shadowBlurRT, 0xffffff)
    expect(clear).toHaveBeenCalledWith(deferred.volRT, 0x000000)

    deferred.camera.lookAt(sourcePosition)
    deferred.camera.updateMatrixWorld(true)
    clear.mockClear()
    deferred.render(1)

    expect(deferred.visibleLamps.uLampCount.value).toBe(1)
    expect(shadow).toHaveBeenCalledOnce()
    expect(volumetric).toHaveBeenCalledOnce()
    expect(clear).not.toHaveBeenCalledWith(deferred.shadowBlurRT, 0xffffff)
    expect(clear).not.toHaveBeenCalledWith(deferred.volRT, 0x000000)
    expect(deferred.lamps.uLampCount.value).toBe(1)
    expect(deferred.lamps.uLampPos.value[0]).toBe(sourcePositionRef)
    expect(deferred.lamps.uLampPos.value[0].toArray()).toEqual([30, 0, 0])
    expect(deferred.lamps.uLampChar.value[0].toArray()).toEqual([0.8, 0.7, 0.6, 0.5])

    deferred.dispose()
  })
})
