import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { DeferredRenderer } from '../DeferredRenderer.js'
import {
  DEFAULT_LOOK,
  LOOK_CAMCORDER,
  LOOK_CLASSIC,
  LOOK_LIMINAL,
  LOOK_NEUTRAL,
  LOOK_ORDER,
  LOOK_PROFILES,
  LOOK_SCHEMA_VERSION,
  LOOK_SEMI_REALISTIC,
  resolveLook,
} from '../lookProfile.js'
import { resolveGraphics, GRAPHICS_PRESETS } from '../../core/graphics.js'
import { LOOK_FIELD_FEATURE, RENDER_FEATURES } from '../renderFeatures.js'
import { GRADE_LEVELS, LIGHT_INTENSITY, PANEL_GLOW, RIM_STRENGTH, WALL_H } from '../../world/constants.js'
import { familyPalette } from '../../world/familyPalette.js'
import { LightGrid } from '../../world/lightGrid/LightGrid.js'
import { GRID_H, GRID_W } from '../../world/lightGrid/gridSpec.js'

function makeDeferred() {
  const renderer = {
    setClearColor: vi.fn(),
    setRenderTarget: vi.fn(),
    render: vi.fn(),
    getPixelRatio: () => 1,
    getSize: (out) => out.set(320, 180),
  }
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 100)
  camera.updateMatrixWorld(true)
  return new DeferredRenderer(renderer, new THREE.Scene(), camera)
}

// Recursive key set of a profile: nested blocks must match too, so a look
// can never silently miss a lever another look defines.
function keyPaths(o, prefix = '') {
  const out = []
  for (const [k, v] of Object.entries(o)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...keyPaths(v, path))
    else out.push(path)
  }
  return out.sort()
}

const qualityHigh = () => resolveGraphics({ get: (k) => GRAPHICS_PRESETS.high[k] })

describe('look profiles', () => {
  it('every profile defines every lever the classic rollback defines (deep)', () => {
    const keys = keyPaths(LOOK_PROFILES[LOOK_CLASSIC])
    expect(LOOK_ORDER).toHaveLength(5)
    for (const id of LOOK_ORDER) {
      expect(keyPaths(LOOK_PROFILES[id]), id).toEqual(keys)
      expect(Object.isFrozen(LOOK_PROFILES[id].exposure)).toBe(true)
      expect(Object.isFrozen(LOOK_PROFILES[id].shadow)).toBe(true)
      expect(LOOK_PROFILES[id].version).toBe(LOOK_SCHEMA_VERSION)
    }
    expect(resolveLook('nope').id).toBe(DEFAULT_LOOK)
    expect(DEFAULT_LOOK).toBe(LOOK_SEMI_REALISTIC)
  })

  it('every schema-v2 lever names a landed feature that consumes it', () => {
    const v2 = keyPaths(LOOK_PROFILES[LOOK_CLASSIC]).filter(
      (p) =>
        /^(lights|shadow|camera|signal|motion)\./.test(p) ||
        /^exposure\.(meterEmissive|damping|omega|awbStrength|awbSpeed)$/.test(p)
    )
    expect(v2.length).toBeGreaterThan(50)
    for (const path of v2) {
      expect(LOOK_FIELD_FEATURE[path], path).toBeDefined()
      expect(RENDER_FEATURES.has(LOOK_FIELD_FEATURE[path]), path).toBe(true)
    }
    for (const [path, feature] of Object.entries(LOOK_FIELD_FEATURE)) {
      expect(RENDER_FEATURES.has(feature), `${path} -> ${feature}`).toBe(true)
    }
  })

  it('keeps every numeric lever inside a sane range', () => {
    for (const id of LOOK_ORDER) {
      const L = LOOK_PROFILES[id]
      for (const k of ['contact', 'furniture', 'furnitureAO', 'capsule', 'capsuleAO', 'capsuleMinVis', 'creaseAO', 'selfShadow']) {
        expect(L.shadow[k], `${id}.shadow.${k}`).toBeGreaterThanOrEqual(0)
        expect(L.shadow[k], `${id}.shadow.${k}`).toBeLessThanOrEqual(1)
      }
      expect(L.shadow.penumbraScale).toBeGreaterThan(0.5)
      expect(L.shadow.penumbraScale).toBeLessThan(2)
      expect(L.shadow.torchSize).toBeGreaterThan(0)
      expect(L.shadow.torchSize).toBeLessThanOrEqual(0.1)
      expect(L.lights.sourceDrop).toBeGreaterThan(0)
      expect(L.lights.sourceDrop).toBeLessThanOrEqual(0.5)
      expect(L.lights.emitFloor).toBeGreaterThanOrEqual(0)
      expect(L.lights.emitFloor).toBeLessThanOrEqual(1)
      expect(L.camera.lensK1).toBeLessThanOrEqual(0.04) // aim stays honest
      expect(L.camera.blackLevel).toBeLessThanOrEqual(0.08)
      expect(L.exposure.omega).toBeLessThan(2 * Math.PI * 3) // hunting < 3 Hz
      expect(L.exposure.awbSpeed).toBeLessThanOrEqual(0.8)
    }
  })

  it('sets every bloom clamp inside the emissive range it is meant to shape', () => {
    // The panel emissive is colour (max channel 1) x flicker (0.92 nominal,
    // 0.99 peak) x PANEL_GLOW x panelGlow x the troffer face (flat 1, tube
    // bands 1.3). A clamp must spare the flat face and cut the tube bands;
    // the old 16-64 never engaged at all.
    for (const id of LOOK_ORDER) {
      const L = LOOK_PROFILES[id]
      if (L.camera.bloomClamp <= 0) continue
      const flat = PANEL_GLOW * L.lights.panelGlow
      expect(L.camera.bloomClamp, id).toBeGreaterThanOrEqual(0.99 * flat)
      expect(L.camera.bloomClamp, id).toBeLessThan(0.92 * 1.3 * flat)
    }
  })

  it('keeps the dusk-blue shadow side in every look except the opt-in liminal photo', () => {
    for (const id of LOOK_ORDER) {
      if (id === LOOK_LIMINAL) continue
      expect(LOOK_PROFILES[id].shadow.ambientTint, id).toBe('family')
    }
    expect(Array.isArray(LOOK_PROFILES[LOOK_LIMINAL].shadow.ambientTint)).toBe(true)
    // Classic stays the pixel-faithful rollback of the legacy occlusion.
    expect(LOOK_PROFILES[LOOK_CLASSIC].shadow.occlusionPath).toBe('legacy')
    expect(LOOK_PROFILES[LOOK_CLASSIC].lights.sourceDrop).toBe(0.5)
  })

  it('switches the lighting shader variant with the shading model', () => {
    const d = makeDeferred()
    const src = () => d.lightQuad.material.fragmentShader
    expect(src()).toContain('#define SHADING_PBR')
    expect(src()).toContain('#define ATT_PHYSICAL')
    d.setLook(LOOK_CLASSIC)
    expect(src()).not.toContain('#define SHADING_PBR')
    expect(src()).not.toContain('#define ATT_PHYSICAL')
    expect(d.lightUniforms.uLampIntensity.value).toBe(LIGHT_INTENSITY)
    expect(d.lightUniforms.uRim.value).toBe(RIM_STRENGTH)
    d.dispose()
  })

  it('bypasses posterize explicitly and restores it for the classic look', () => {
    const d = makeDeferred()
    expect(d.gradeUniforms.levels.value).toBe(0) // semi-realistic: bypass branch
    d.setLook(LOOK_CLASSIC)
    expect(d.gradeUniforms.levels.value).toBe(GRADE_LEVELS)
    expect(d.gradeUniforms.toneMapper.value).toBe(0)
    d.setLook(LOOK_NEUTRAL)
    expect(d.gradeUniforms.toneMapper.value).toBe(2)
    expect(d.gradeUniforms.autoExposure.value).toBe(0)
    d.dispose()
  })

  it('scales the family grade toward neutral by the look amounts', () => {
    const d = makeDeferred()
    const pal = familyPalette('office')
    d.applyPalette(pal)
    d.setLook(LOOK_CLASSIC)
    expect(d.gradeUniforms.sat.value).toBeCloseTo(pal.gradeSat, 6)
    expect(d.gradeUniforms.tint.value.x).toBeCloseTo(pal.gradeTint[0], 6)
    d.setLook(LOOK_NEUTRAL)
    expect(d.gradeUniforms.sat.value).toBe(1)
    expect(d.gradeUniforms.tint.value.toArray()).toEqual([1, 1, 1])
    expect(d.gradeUniforms.lift.value).toBe(0)
    d.setLook(LOOK_SEMI_REALISTIC)
    const semi = LOOK_PROFILES[LOOK_SEMI_REALISTIC]
    expect(d.gradeUniforms.sat.value).toBeCloseTo(1 + (pal.gradeSat - 1) * semi.saturation, 6)
    d.dispose()
  })

  it('only draws the ink outline when both the setting and the look want it', () => {
    const d = makeDeferred()
    expect(d.outlineActive).toBe(false) // semi-realistic look has no ink
    d.setLook(LOOK_CLASSIC)
    expect(d.outlineActive).toBe(true)
    d.setOutline(false)
    expect(d.outlineActive).toBe(false)
    d.dispose()
  })
})

describe('DeferredRenderer G-buffer v2 and grid binding', () => {
  it('allocates the three-attachment G-buffer with a material target', () => {
    const d = makeDeferred()
    expect(d.gBuffer.textures).toHaveLength(3)
    expect(d.gMaterial.type).toBe(THREE.UnsignedByteType)
    expect(d.lightUniforms.tMaterial.value).toBe(d.gMaterial)
    expect(d.debugViewUniforms.tMaterial.value).toBe(d.gMaterial)
    d.dispose()
  })

  it('binds a light grid as zero-copy textures and falls back to placeholders', () => {
    const d = makeDeferred()
    const grid = new LightGrid()
    expect(d.gridUniforms.tGridList.value.image.width).toBe(1) // placeholder
    d.bindLightGrid(grid)
    const list = d.gridUniforms.tGridList.value
    expect(list.image.data).toBe(grid.list)
    expect([list.image.width, list.image.height]).toEqual([GRID_W, GRID_H])
    expect(list.internalFormat).toBe('RGBA32UI')
    expect(d.lightUniforms.tGridList).toBe(d.shadowUniforms.tGridList) // shared value-objects
    expect(d.volUniforms.tGridEdge).toBe(d.lightUniforms.tGridEdge)
    expect(d.gridActive).toBe(true)
    d.gridSuspended = true
    expect(d.gridActive).toBe(false)
    d.gridSuspended = false
    d.bindLightGrid(null)
    expect(d.gridUniforms.tGridList.value.image.width).toBe(1)
    d.dispose()
  })

  it('hands the family albedos to the grid for the bounce solve', () => {
    const d = makeDeferred()
    const grid = new LightGrid()
    d.bindLightGrid(grid)
    d.applyPalette(familyPalette('hotel'))
    const expected = new THREE.Color(familyPalette('hotel').floor.base)
    expect(grid.albedo.floor[0]).toBeCloseTo(expected.r, 6)
    d.dispose()
  })

  it('packs capsule groups (<= 3 capsules each) for grid and legacy pixels alike', () => {
    const d = makeDeferred()
    const caps = new Float32Array(10 * 8)
    const put = (i, x, r) => caps.set([x, 0.3, 0, r, x, 2, 0, 0], i * 8)
    put(0, 1, 0.3)
    put(1, 1, 0.2)
    put(3, 4, 0.25)
    const counts = new Int32Array([2, 1, 0, 0])
    const bounds = new Float32Array([1, 1.1, 0, 1.2, 4, 1.1, 0, 1.1, 0, 0, 0, 0, 0, 0, 0, 0])
    d.setOccluders(caps, counts, bounds)
    d._updateFrame()
    const u = d.lightUniforms
    expect(u.uCapGroups.value).toBe(2) // no grid needed any more
    expect(Array.from(u.uCapN.value)).toEqual([2, 1, 0, 0])
    expect(u.uCapA.value[3].toArray()).toEqual([4, 0.30000001192092896, 0, 0.25])
    expect(u.uCapBound.value[2].w).toBe(0) // absent group
    d.setOccluders(caps, new Int32Array(4), bounds)
    d._updateFrame()
    expect(u.uCapGroups.value).toBe(0)
    d.dispose()
  })

  it('pushes the look levers every pass shares, and re-hues the ambient with luminance kept', () => {
    const d = makeDeferred()
    d.applyPalette(familyPalette('office'))
    d.applyQuality(qualityHigh())
    d.setLook(LOOK_SEMI_REALISTIC)
    const semi = LOOK_PROFILES[LOOK_SEMI_REALISTIC]
    expect(d.gridUniforms.uSourceY.value).toBeCloseTo(WALL_H - semi.lights.sourceDrop, 6)
    expect(d.lightUniforms.uSourceY).toBe(d.volUniforms.uSourceY) // one shared value-object
    expect(d.lightUniforms.uSourceY).toBe(d.shadowUniforms.uSourceY)
    expect(d.shadowUniforms.uMaxDist.value).toBe(semi.shadow.contactLength)
    expect(d.lightUniforms.uCreaseK.value).toBe(semi.shadow.creaseAO)
    expect(d.lightUniforms.uFurnK.value).toBe(1)
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
    const familySky = d.lightUniforms.uAmbSky.value.clone()
    d.setLook(LOOK_LIMINAL)
    const liminalSky = d.lightUniforms.uAmbSky.value
    expect(lum(liminalSky)).toBeCloseTo(lum(familySky), 5)
    expect(liminalSky.b / liminalSky.r).toBeLessThan(familySky.b / familySky.r) // warmer
    d.setLook(LOOK_CLASSIC)
    expect(d.gridUniforms.uSourceY.value).toBeCloseTo(WALL_H - 0.5, 6)
    expect(d.lightUniforms.uFurnK.value).toBe(0)
    d.dispose()
  })

  it('selects lighting variants from look x quality, never recompiling on uniform knobs', () => {
    const d = makeDeferred()
    d.applyQuality(qualityHigh())
    d.setLook(LOOK_SEMI_REALISTIC)
    const src = () => d.lightQuad.material.fragmentShader
    expect(src()).toMatch(/#define FURN\s/)
    expect(src()).toContain('#define FLASH_FILTER 1')
    const m = d.lightQuad.material
    d.applyQuality(qualityHigh()) // same knobs: same build
    expect(d.lightQuad.material).toBe(m)
    d.setLook(LOOK_CLASSIC)
    expect(src()).not.toMatch(/#define FURN\s/)
    d.setLook(LOOK_CAMCORDER)
    expect(src()).toContain('#define SHADING_PBR')
    d.dispose()
  })

  it('renders the torch shadow only while the torch is on and the tier allows it', () => {
    const d = makeDeferred()
    const spy = vi.spyOn(d.flashShadow, 'update')
    vi.spyOn(d, '_clearRT').mockImplementation(() => {})
    d.render(0)
    expect(spy).not.toHaveBeenCalled()
    d.lightUniforms.uFlashOn.value = 1
    d.render(1)
    expect(spy).toHaveBeenCalledOnce()
    expect(d.flashUniforms.uFlashShadowOn.value).toBe(1)
    d.applyQuality({
      ao: { enabled: true, samples: 8 },
      shadow: { enabled: false, steps: 12, lamps: 4, tier: 'off' },
      vol: { enabled: true, steps: 16, lights: 6 },
      bloom: true,
      fxaa: true,
    })
    d.render(2)
    expect(spy).toHaveBeenCalledOnce()
    expect(d.flashUniforms.uFlashShadowOn.value).toBe(0)
    d.dispose()
  })
})
