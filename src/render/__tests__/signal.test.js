import { describe, expect, it } from 'vitest'
import { SIGNAL_FRAG, SIGNAL_PEAK_RATIO, SIGNAL_TAP_SIGMA } from '../shaders/signal.js'
import { LOOK_CAMCORDER, LOOK_PROFILES } from '../lookProfile.js'

const sig = LOOK_PROFILES[LOOK_CAMCORDER].signal

// The shader's luma / peaking kernels at render height H (16:9): taps
// stepPx apart, weights in tap units. Returns the frequency response of
// y - yb (the peaking band) from 0 to Nyquist.
function peakingBand(H) {
  const sY = Math.max(H / (2.3 * sig.lumaLines), 0.35)
  const step = Math.max(1, sY / SIGNAL_TAP_SIGMA)
  const sYt = sY / step
  const sBt = SIGNAL_PEAK_RATIO * sYt
  const gy = []
  const gb = []
  for (let k = -4; k <= 4; k++) {
    gy.push(Math.exp((-0.5 * k * k) / (sYt * sYt)))
    gb.push(Math.exp((-0.5 * k * k) / (sBt * sBt)))
  }
  const ny = gy.reduce((a, b) => a + b)
  const nb = gb.reduce((a, b) => a + b)
  const band = []
  for (let f = 0.01; f <= 0.5; f += 0.01) {
    let y = 0
    let b = 0
    for (let k = -4; k <= 4; k++) {
      const c = Math.cos(2 * Math.PI * f * k * step)
      y += (gy[k + 4] * c) / ny
      b += (gb[k + 4] * c) / nb
    }
    band.push(y - b)
  }
  return band
}

describe('camcorder signal pass', () => {
  it('never feeds the frame or time counters to the float hash', () => {
    // hash() loses every fractional bit once line + 17 x frame passes ~18k,
    // which froze the tape noise into static stripes; PCG takes integers.
    expect(SIGNAL_FRAG).not.toMatch(/\bhash\s*\(/)
    const calls = (SIGNAL_FRAG.match(/\buhash\s*\(/g) ?? []).length - 1 // minus the definition
    expect(calls).toBe(4) // head switch, streak, two chroma channels
    expect(SIGNAL_FRAG).toContain('uint frame = uint(uFrame);')
    expect(SIGNAL_FRAG).toMatch(/uint pcg\(uint v\)/)
  })

  it('keeps peaking a positive band-pass at every render height', () => {
    expect(SIGNAL_FRAG).toMatch(/float gY = exp\(-0\.5 \* fk \* fk \/ \(sYt \* sYt\)\);/)
    expect(SIGNAL_FRAG).toMatch(/float gB = exp\(-0\.5 \* fk \* fk \/ \(sBt \* sBt\)\);/)
    expect(SIGNAL_FRAG).toContain('vec2 ou = vec2(fk * stepPx * uTexel.x, 0.0);')
    for (const H of [540, 720, 1080, 1440, 1800, 2160]) {
      const band = peakingBand(H)
      // A fixed 1.5 px reference made this a -0.16 low-pass at 1440p.
      expect(Math.max(...band), `${H}`).toBeGreaterThan(0.3)
      expect(Math.min(...band), `${H}`).toBeGreaterThan(-0.03)
    }
  })

  it('weights the chroma taps as a Gaussian of sigma sC in tap units', () => {
    // Taps sit sC / 2 px apart, so the weight must not depend on sC (the
    // old exp(-2k^2 / sC^2) became a near box above 1080p).
    const m = SIGNAL_FRAG.match(/float gC = ([^;]+);/)
    expect(m?.[1]).toBe('exp(-0.125 * fk * fk)')
    expect(SIGNAL_FRAG).toContain('fk * sC * 0.5 * uTexel.x')
  })
})
