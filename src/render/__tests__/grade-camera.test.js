import { describe, expect, it } from 'vitest'
import { GRADE_FRAG } from '../shaders/grade.js'
import { LOOK_CAMCORDER, LOOK_PROFILES, TONE_VIDEO } from '../lookProfile.js'
import { FAMILY_PALETTES } from '../../world/familyPalette.js'

const main = GRADE_FRAG.slice(GRADE_FRAG.indexOf('void main()'))
const at = (needle) => {
  const i = main.indexOf(needle)
  expect(i, needle).toBeGreaterThan(0)
  return i
}

const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}
const srgb = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)

// JS twin of the camcorder grade for a grey pixel at the frame centre, in
// the shader's order: video knee (identity below it), sensor noise, white
// clip, toe, sRGB, pedestal. The saturation / split / lift stages add the
// same offset to every dark pixel and drop out of a contrast-to-noise ratio.
function camcorderPixel(x, n, gain) {
  const cam = LOOK_PROFILES[LOOK_CAMCORDER].camera
  const sn = LOOK_PROFILES[LOOK_CAMCORDER].sensorNoise
  let c = x // below the 0.78 knee the video curve is the identity
  c += n * sn * 0.022 * gain * (0.35 + 0.65 * (1 - smoothstep(0, 0.35, c)))
  c = Math.min(Math.max(c, 0), cam.whiteClip)
  const t = cam.toe
  c = (c < 2 * t ? (c * c) / (4 * t) : c - t) / (1 - t)
  return cam.blackLevel + (1 - cam.blackLevel) * srgb(c)
}

// Mean and standard deviation of the encoded pixel over the uniform hash.
function stats(x, gain) {
  let m = 0
  let m2 = 0
  const N = 4000
  for (let i = 0; i < N; i++) {
    const v = camcorderPixel(x, (i + 0.5) / N - 0.5, gain)
    m += v
    m2 += v * v
  }
  m /= N
  return { mean: m, sd: Math.sqrt(Math.max(m2 / N - m * m, 0)) }
}

describe('grade camera model', () => {
  it('adds sensor noise before the toe, then clips white after every tone mapper', () => {
    const tone = at('col = toneMap(col);')
    const noise = at('col += n * sensorNoise')
    const clip = at('col = clamp(col, 0.0, whiteClip);')
    const toe = at('if (toe > 0.0)')
    expect(tone).toBeLessThan(noise)
    expect(noise).toBeLessThan(clip)
    expect(clip).toBeLessThan(toe)
    // The clip is no longer private to the video curve (liminal's AgX
    // whiteClip was a dead lever).
    const video = GRADE_FRAG.slice(GRADE_FRAG.indexOf('vec3 toneVideo'), GRADE_FRAG.indexOf('vec3 toneMap'))
    expect(video).not.toContain('whiteClip')
    expect(LOOK_PROFILES[LOOK_CAMCORDER].toneMapper).toBe(TONE_VIDEO)
  })

  it('keeps an unlit camcorder room readable at full auto-exposure gain', () => {
    const x = LOOK_PROFILES[LOOK_CAMCORDER].exposure
    const ped = LOOK_PROFILES[LOOK_CAMCORDER].camera.blackLevel
    const gain = Math.sqrt(2 ** x.maxEv) // exposure pinned at base x 2^maxEv
    for (const [family, pal] of Object.entries(FAMILY_PALETTES)) {
      const e = pal.exposure * 2 ** x.maxEv
      // Unlit wall vs a doorway void (scene-linear luminance under the
      // family hemisphere ambient at the camcorder's hemiAmbient).
      const wall = stats(0.0125 * e, gain)
      const door = stats(0.004 * e, gain)
      const cnr = (wall.mean - door.mean) / Math.sqrt((wall.sd ** 2 + door.sd ** 2) / 2)
      // Single pixel, single frame, before the signal pass's luma low-pass
      // (which roughly halves the noise). Noise added after the toe gave 0.2.
      expect(cnr, family).toBeGreaterThan(1.0)
      // Black stays crushed into the pedestal instead of a lifted noise floor.
      expect(stats(0, gain).mean - ped, family).toBeLessThan(0.04)
    }
  })
})
