import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { DeferredRenderer } from '../DeferredRenderer.js'
import { LightField, makeLampUniforms } from '../LightField.js'
import { GRID_GLSL, GRID_UNIFORMS_GLSL } from '../shaders/grid.js'
import { FLICKER_FULL, FLICKER_SAFE, isBadTube, lampFlicker } from '../../world/lampCharacter.js'
import { CELL, LAMP_BAD_RATE } from '../../world/constants.js'

// Photosensitivity (Settings 'reduceFlicker'): the bad-tube strobe has a CPU
// path (LightField -> lampFlicker, the fallback lamp set) and a GPU twin
// (grid.js gFlicker). Both must follow ONE profile, or a grid pixel and a
// fallback pixel of the same fixture would strobe differently.

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

const fnBody = (src, name) => {
  const start = src.indexOf(`float ${name}(`)
  expect(start).toBeGreaterThanOrEqual(0)
  return src.slice(start, src.indexOf('\n  }\n', start))
}

// One bad tube and its neighbours, as ChunkManager candidates.
function badSpot() {
  for (let gx = 0; gx < 40; gx++) {
    for (let gz = 0; gz < 40; gz++) {
      const x = (gx + 0.5) * CELL
      const z = (gz + 0.5) * CELL
      if (isBadTube(x, z, 0)) return { x, z }
    }
  }
  throw new Error('no bad tube in the sweep')
}

describe('reduceFlicker: CPU lamp path', () => {
  const spot = badSpot()
  const cm = {
    collectLampsNear(_px, _pz, out) {
      out.length = 0
      out.push({ x: spot.x, y: 2.9, z: spot.z, cy: 0, role: 0 })
      return out
    },
  }

  it('LightField starts safe and follows the profile it is given', () => {
    const u = makeLampUniforms()
    const field = new LightField(u)
    expect(field.flicker).toBe(FLICKER_SAFE)
    // Sample a few seconds: every raw value matches the profile it ran under.
    for (const profile of [FLICKER_SAFE, FLICKER_FULL]) {
      field.flicker = profile
      let t = 0
      for (let i = 0; i < 40; i++) {
        field.update(0.073, 0, 0, 0, cm)
        t += 0.073
        expect(u.lampFlickerRaw[0]).toBeCloseTo(lampFlicker(spot.x, spot.z, 0, t, profile), 6)
        expect(u.lampFlickerRaw[0]).toBeGreaterThanOrEqual(profile.badLo - 1e-6)
      }
      field._time = 0
    }
  })
})

describe('reduceFlicker: GPU grid path', () => {
  it('gFlicker reads the strobe from a uniform, not baked constants', () => {
    expect(GRID_UNIFORMS_GLSL).toMatch(/uniform vec2 uBadStrobe;/)
    const body = fnBody(GRID_GLSL, 'gFlicker')
    expect(body).toMatch(/floor\(uTime \* uBadStrobe\.x\)/)
    expect(body).toMatch(/return uBadStrobe\.y \+ \(1\.0 - uBadStrobe\.y\) \* n \* n;/)
    // The authored 9 Hz rate must not survive as a literal in the shader.
    expect(body).not.toMatch(new RegExp(`\\b${LAMP_BAD_RATE}\\.0\\b`))
  })

  it('the renderer defaults to the safe strobe and retunes every grid pass at once', () => {
    const d = makeDeferred()
    const strobe = d.gridUniforms.uBadStrobe
    expect(strobe.value.toArray()).toEqual([FLICKER_SAFE.badRate, FLICKER_SAFE.badLo])
    // Lighting, shadow, contact and volumetric passes share the value object.
    for (const u of [d.lightUniforms, d.shadowUniforms, d.contactUniforms, d.volUniforms]) {
      expect(u.uBadStrobe).toBe(strobe)
    }
    d.setFlickerProfile(FLICKER_FULL)
    expect(strobe.value.toArray()).toEqual([FLICKER_FULL.badRate, FLICKER_FULL.badLo])
    d.setFlickerProfile(FLICKER_SAFE)
    expect(strobe.value.x).toBeLessThanOrEqual(3)
    expect(1 - strobe.value.y).toBeLessThan(0.1)
  })
})
