import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../textures.js', () => ({
  floorTexture: (anisotropy) => Object.assign(new THREE.Texture(), { anisotropy }),
  wallTexture: (anisotropy) => Object.assign(new THREE.Texture(), { anisotropy }),
  ceilingTexture: (anisotropy) => Object.assign(new THREE.Texture(), { anisotropy }),
  surfaceDetailTexture: (albedo) => Object.assign(new THREE.Texture(), { anisotropy: albedo.anisotropy }),
}))

import { applyFamilyMaterials, createGBufferMaterials, disposeGBufferMaterials } from '../gbufferMaterials.js'

const renderer = (anisotropy) => ({ capabilities: { getMaxAnisotropy: () => anisotropy } })

describe('G-buffer texture ownership', () => {
  it('keeps live materials valid when another renderer is disposed', () => {
    const first = createGBufferMaterials(renderer(2))
    const second = createGBufferMaterials(renderer(16))
    const texture = second.carpet.uniforms.map.value
    const dispose = vi.spyOn(texture, 'dispose')
    expect(first.carpet.uniforms.map.value).not.toBe(texture)
    expect(texture.anisotropy).toBe(16)
    disposeGBufferMaterials(first)
    expect(dispose).not.toHaveBeenCalled()
    disposeGBufferMaterials(second)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('reuses family textures until the last material set releases the renderer', () => {
    const context = renderer(8)
    const first = createGBufferMaterials(context)
    const second = createGBufferMaterials(context)
    const office = first.carpet.uniforms.map.value
    const officeDispose = vi.spyOn(office, 'dispose')
    expect(second.carpet.uniforms.map.value).toBe(office)
    applyFamilyMaterials(first, context, 'hotel')
    const hotelDispose = vi.spyOn(first.carpet.uniforms.map.value, 'dispose')
    disposeGBufferMaterials(first)
    expect(officeDispose).not.toHaveBeenCalled()
    expect(hotelDispose).not.toHaveBeenCalled()
    disposeGBufferMaterials(second)
    expect(officeDispose).toHaveBeenCalledOnce()
    expect(hotelDispose).toHaveBeenCalledOnce()
    const restarted = createGBufferMaterials(context)
    expect(restarted.carpet.uniforms.map.value).not.toBe(office)
    disposeGBufferMaterials(restarted)
  })
})
