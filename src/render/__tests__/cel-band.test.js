import { describe, expect, it } from 'vitest'
import { CEL_BAND } from '../shaders/common.js'
import { makeToonGradient } from '../gradientRamp.js'
import { CEL_BANDS, CEL_FLOOR } from '../../world/constants.js'

// The lighting and shadow passes used to quantise N·L with a dependent texture
// read into the CEL_BANDS-texel nearest LUT built by makeToonGradient() — once
// per lamp per pixel, up to 72x, in the two hottest loops in the renderer. That
// LUT is now evaluated analytically by the shared CEL_BAND snippet.
//
// gradientRamp.js survives purely as the ORACLE for this test: it is the
// authored definition of the ramp, and these tests hold the shader to it. If the
// analytic form ever drifts from the LUT, this fails rather than the cel shading
// quietly changing shape.

// Transpile the tiny `float band(float x)` body out of the emitted GLSL and run
// it as JavaScript. This tests the STRING THE GPU ACTUALLY COMPILES, not a
// hand-copied reimplementation of it.
function compileBand(glsl) {
  const body = glsl.match(/float band\(float x\)\s*\{([\s\S]*?)\n\s*\}/)
  expect(body, 'CEL_BAND must define float band(float x)').not.toBeNull()
  const js = body[1]
    .replace(/\bfloat\b/g, 'let')
    .replace(/\bmin\(/g, 'Math.min(')
    .replace(/\bmax\(/g, 'Math.max(')
    .replace(/\bfloor\(/g, 'Math.floor(')
  const fn = new Function('x', 'clamp', js)
  return (x) => fn(x, (v, lo, hi) => Math.min(Math.max(v, lo), hi))
}

// What a NearestFilter, clamp-to-edge sample of the LUT returns for uv.x = x.
function sampleRamp(tex, steps, x) {
  const i = Math.min(Math.max(Math.floor(Math.min(Math.max(x, 0), 1) * steps), 0), steps - 1)
  return tex.image.data[i] / 255
}

describe('analytic cel band', () => {
  const band = compileBand(CEL_BAND)
  const ramp = makeToonGradient(CEL_BANDS, CEL_FLOOR)

  it('matches the LUT within its own 8-bit quantisation across the domain', () => {
    // 1/510 is the worst case: the LUT rounds each authored step to 8 bits, so
    // half a code value is the most the exact analytic form can differ by.
    for (let k = 0; k <= 1000; k++) {
      const x = k / 1000
      expect(band(x), `x=${x}`).toBeCloseTo(sampleRamp(ramp, CEL_BANDS, x), 2)
      expect(Math.abs(band(x) - sampleRamp(ramp, CEL_BANDS, x))).toBeLessThanOrEqual(1 / 510)
    }
  })

  it('produces exactly CEL_BANDS distinct steps', () => {
    const seen = new Set()
    for (let k = 0; k <= 1000; k++) seen.add(band(k / 1000).toFixed(6))
    expect(seen.size).toBe(CEL_BANDS)
  })

  it('spans CEL_FLOOR at the terminator to 1 at full N·L, and clamps outside [0,1]', () => {
    expect(band(0)).toBeCloseTo(CEL_FLOOR, 12)
    expect(band(1)).toBeCloseTo(1, 12)
    // The lighting pass dithers the lookup by up to +/- half a band, so out-of-
    // range arguments are routine and must saturate, never wrap or extrapolate.
    expect(band(-5)).toBeCloseTo(CEL_FLOOR, 12)
    expect(band(5)).toBeCloseTo(1, 12)
  })

  it('is monotonically non-decreasing', () => {
    let prev = -Infinity
    for (let k = 0; k <= 1000; k++) {
      const v = band(k / 1000)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('is the only band() the lighting and shadow passes define', async () => {
    // Both passes must share this snippet; a locally redefined band() would be
    // a duplicate GLSL definition (compile error) or a silent divergence.
    const { LIGHTING_FRAG } = await import('../shaders/lighting.js')
    const { SHADOW_FRAG } = await import('../shaders/shadow.js')
    for (const [name, src] of [
      ['lighting', LIGHTING_FRAG],
      ['shadow', SHADOW_FRAG],
    ]) {
      expect(src.match(/float band\(/g)?.length, name).toBe(1)
      expect(src, name).toContain(CEL_BAND.trim())
      // The LUT sampler is gone from both passes.
      expect(src, name).not.toContain('tRamp')
    }
  })
})
