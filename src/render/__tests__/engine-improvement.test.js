import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { GridLightTextures } from '../GridLightTextures.js'
import { probeDeferredSupport, GBUFFER_ATTACHMENTS } from '../capabilities.js'
import { PassTimer, percentile } from '../PassTimer.js'
import { GLTF_SURFACES, MIN_ROUGHNESS, SURFACE_STYLES, resolveGltfSurface } from '../surfaces.js'
import { bakeFurnitureGeometry } from '../furnitureModels.js'
import { LightGrid } from '../../world/lightGrid/LightGrid.js'
import { ChunkData } from '../../world/ChunkData.js'
import { GRID_W } from '../../world/lightGrid/gridSpec.js'
import { CHUNK } from '../../world/constants.js'
import { FAMILY_PALETTES } from '../../world/familyPalette.js'

describe('GridLightTextures', () => {
  it('turns grid dirty rectangles into per-row update ranges', () => {
    const grid = new LightGrid()
    const tex = new GridLightTextures(grid)
    const edge = tex.textures.edge
    expect(edge.image.data).toBe(grid.edge) // zero-copy
    grid.addChunk(new ChunkData(1, 0, 2, 0))
    const addRange = vi.spyOn(edge, 'addUpdateRange')
    const rows = tex.sync()
    expect(rows).toBeGreaterThan(0)
    // One range per texel row of the 14x14 chunk: start at the row, 14 texels.
    expect(addRange).toHaveBeenCalledTimes(CHUNK)
    const [start, count] = addRange.mock.calls[0]
    expect(count).toBe(CHUNK * 4)
    expect(start % 4).toBe(0)
    expect(((start / 4) % GRID_W)).toBe(CHUNK) // chunk cx=1 -> texel column 14
    expect(tex.sync()).toBe(0) // nothing new
    tex.dispose()
  })

  it('uploads a whole texture without ranges after a reset', () => {
    const grid = new LightGrid()
    const tex = new GridLightTextures(grid)
    grid.reset()
    const spy = vi.spyOn(tex.textures.list, 'addUpdateRange')
    tex.sync()
    expect(spy).not.toHaveBeenCalled()
    expect(tex.textures.list.updateRanges).toEqual([])
    tex.dispose()
  })
})

describe('capability probe', () => {
  it('skips cleanly without a GL context (headless, mocked renderers)', () => {
    expect(probeDeferredSupport({}).ok).toBe(true)
    expect(probeDeferredSupport({ getContext: () => null }).skipped).toBe(true)
  })

  it('reports missing float colour buffers and too few draw buffers', () => {
    const gl = {
      MAX_DRAW_BUFFERS: 1, MAX_COLOR_ATTACHMENTS: 2, MAX_TEXTURE_IMAGE_UNITS: 3,
      MAX_FRAGMENT_UNIFORM_VECTORS: 4, MAX_TEXTURE_SIZE: 5,
      getParameter: (p) => (p === 1 || p === 2 ? GBUFFER_ATTACHMENTS - 1 : 16),
      getExtension: () => null,
    }
    const report = probeDeferredSupport({ getContext: () => gl })
    expect(report.ok).toBe(false)
    expect(report.reasons.join(' ')).toMatch(/draw buffers/)
    expect(report.reasons.join(' ')).toMatch(/EXT_color_buffer_float/)
  })

  it('checks framebuffer completeness of the real G-buffer layout', () => {
    const gl = {
      MAX_DRAW_BUFFERS: 1, MAX_COLOR_ATTACHMENTS: 2, MAX_TEXTURE_IMAGE_UNITS: 3,
      MAX_FRAGMENT_UNIFORM_VECTORS: 4, MAX_TEXTURE_SIZE: 5, FRAMEBUFFER: 6,
      FRAMEBUFFER_COMPLETE: 0x8cd5,
      getParameter: () => 16,
      getExtension: () => ({}),
      checkFramebufferStatus: vi.fn(() => 0x8cd6),
    }
    const targets = []
    const renderer = {
      getContext: () => gl,
      getRenderTarget: () => null,
      setRenderTarget: (rt) => targets.push(rt),
    }
    const report = probeDeferredSupport(renderer)
    expect(report.ok).toBe(false)
    expect(report.reasons[0]).toMatch(/incomplete/)
    expect(targets[0].textures).toHaveLength(GBUFFER_ATTACHMENTS)
    expect(targets.at(-1)).toBe(null) // restored
    gl.checkFramebufferStatus.mockReturnValue(0x8cd5)
    expect(probeDeferredSupport(renderer).ok).toBe(true)
  })
})

describe('PassTimer statistics', () => {
  it('computes nearest-rank percentiles', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(s, 0.5)).toBe(5)
    expect(percentile(s, 0.95)).toBe(10)
    expect(percentile([], 0.5)).toBe(null)
  })

  it('records resolved frames, counts disjoint ones, and exports a report', () => {
    let q = 0
    const results = new Map()
    let disjoint = false
    const gl = {
      QUERY_RESULT_AVAILABLE: 1, QUERY_RESULT: 2,
      getExtension: () => ({ TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 }),
      createQuery: () => ++q,
      beginQuery: () => {},
      endQuery: () => {},
      deleteQuery: () => {},
      getQueryParameter: (id, p) => (p === 1 ? true : results.get(id) ?? 1e6),
      getParameter: () => disjoint,
    }
    const t = new PassTimer(gl, 16)
    for (let i = 0; i < 3; i++) {
      t.frameStart()
      t.begin('lighting')
      results.set(q, (i + 1) * 1e6)
      t.end()
      t.frameEnd()
    }
    disjoint = true
    t.frameStart()
    t.begin('lighting')
    t.end()
    t.frameEnd()
    const st = t.stats('lighting')
    expect(st.count).toBe(3)
    expect(st.p50).toBe(2)
    expect(st.max).toBe(3)
    const report = t.export()
    expect(report.resolvedFrames).toBe(3)
    expect(report.disjointFrames).toBe(1)
    expect(report.passes.frame.count).toBe(3)
  })
})

describe('surface descriptors', () => {
  it('covers every architectural style the family palettes use', () => {
    for (const pal of Object.values(FAMILY_PALETTES)) {
      for (const slot of ['floor', 'wall', 'ceiling']) {
        expect(SURFACE_STYLES[pal[slot].style], `${slot} ${pal[slot].style}`).toBeDefined()
      }
    }
  })

  it('resolves named Blender materials and preserves unknown glTF factors', () => {
    expect(resolveGltfSurface({ name: 'yr_chrome', roughness: 0.32, metalness: 0.85 })).toEqual({
      ...GLTF_SURFACES.yr_chrome,
      known: true,
    })
    expect(resolveGltfSurface({ name: 'unknown', roughness: 0, metalness: 2 })).toEqual({
      roughness: MIN_ROUGHNESS,
      metalness: 1,
      known: false,
    })
    expect(resolveGltfSurface(null)).toEqual({ roughness: 1, metalness: 0, known: false })
  })

  it('bakes each primitive surface into a per-vertex attribute instead of discarding it', () => {
    const root = new THREE.Group()
    const leg = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ name: 'yr_legMetal' }))
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ name: 'yr_fabric' }))
    seat.position.y = 1
    root.add(leg, seat)
    const g = bakeFurnitureGeometry(root)
    const surface = g.getAttribute('surface')
    expect(surface.itemSize).toBe(2)
    expect(surface.normalized).toBe(true)
    const per = leg.geometry.attributes.position.count
    expect(surface.getX(0)).toBeCloseTo(GLTF_SURFACES.yr_legMetal.roughness, 2)
    expect(surface.getY(0)).toBeCloseTo(GLTF_SURFACES.yr_legMetal.metalness, 2)
    expect(surface.getX(per)).toBeCloseTo(GLTF_SURFACES.yr_fabric.roughness, 2)
    expect(surface.getY(per)).toBe(0)
  })
})
