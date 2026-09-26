import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { DeferredRenderer } from '../DeferredRenderer.js'
import { GRAPHICS_PRESETS, PRESET_ORDER, SHADOW_TIERS, TIER_ORDER, resolveGraphics } from '../../core/graphics.js'
import { LOOK_ORDER } from '../lookProfile.js'
import { familyPalette } from '../../world/familyPalette.js'

// Quality-tier invariants (engine-improvement chapter 14 P4): tiers remove
// occlusion and shadow DETAIL, never light energy or mood. Everything that
// sets the mood — GI, bloom, auto-exposure, the grade, fog, the flashlight
// cone — is identical on every preset; only work caps and variants move.

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

const presetQuality = (name) =>
  resolveGraphics({ get: (k) => (k === 'preset' ? name : GRAPHICS_PRESETS[name][k]) })

// The mood: uniforms a tier must never touch.
function mood(d) {
  const lu = d.lightUniforms
  const cu = d.compositeUniforms
  const g = d.gradeUniforms
  return {
    gi: lu.uGI.value,
    hemi: lu.uHemi.value,
    lamp: lu.uLampIntensity.value,
    flash: [lu.uFlashIntensity.value, lu.uFlashCosInner.value, lu.uFlashCosOuter.value, lu.uFlashRange.value],
    fog: lu.uFogDensity.value,
    bloom: cu.uBloomIntensity.value,
    bloomVeil: cu.uBloomWide.value + cu.uBloomTail.value, // the tail folds into the veil on low tiers
    vol: cu.uVolIntensity.value,
    auto: g.autoExposure.value,
    tone: g.toneMapper.value,
    sat: g.sat.value,
    crease: lu.uCreaseK.value,
    capsuleAO: lu.uCapsuleAOK.value,
    sourceY: d.gridUniforms.uSourceY.value,
    penumbra: d.gridUniforms.uPenumbraScale.value,
  }
}

describe('quality tiers never change the mood', () => {
  it('keeps GI, bloom energy, exposure, grade, fog, the torch cone and analytic AO across presets', () => {
    for (const look of LOOK_ORDER) {
      const d = makeDeferred()
      d.applyPalette(familyPalette('office'))
      d.setLook(look)
      const ref = (d.applyQuality(presetQuality('high')), mood(d))
      for (const p of PRESET_ORDER) {
        d.applyQuality(presetQuality(p))
        const m = mood(d)
        expect(m, `${look} @ ${p}`).toEqual({ ...ref, bloomVeil: m.bloomVeil })
        expect(m.bloomVeil).toBeCloseTo(ref.bloomVeil, 6)
      }
      d.dispose()
    }
  })

  it('shades every light-list entry on every tier (caps limit traces, never entries)', () => {
    for (const t of TIER_ORDER) {
      const s = SHADOW_TIERS[t]
      // The lighting loop walks gListCount entries; `traced` only chooses how
      // many of the partial ones are traced instead of using baked visibility.
      expect(s.traced).toBeLessThanOrEqual(8)
      expect(s.capsuleLights).toBeGreaterThanOrEqual(1)
    }
  })

  it('switching uniform-only knobs keeps the compiled lighting build', () => {
    const d = makeDeferred()
    d.setLook('semiRealistic')
    const q = presetQuality('high')
    d.applyQuality(q)
    const m = d.lightQuad.material
    // Same variant key, different caps: no rebuild.
    d.applyQuality({ ...q, shadow: { ...q.shadow, traced: 2, contactSteps: 8, capsuleLights: 2 } })
    expect(d.lightQuad.material).toBe(m)
    expect(d.lightUniforms.uMaxTraced.value).toBe(2)
    d.dispose()
  })

  it('never leaves the flashlight map larger than the GPU allows', () => {
    const q = resolveGraphics({ get: (k) => GRAPHICS_PRESETS.ultra[k] }, { maxTextureSize: 1024 })
    expect(q.flash.size).toBeLessThanOrEqual(1024)
  })
})
