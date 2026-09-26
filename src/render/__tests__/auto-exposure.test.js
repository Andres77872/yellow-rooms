import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { AWB_GATE, AutoExposure } from '../AutoExposure.js'
import { LOOK_CAMCORDER, LOOK_PROFILES } from '../lookProfile.js'

function makeExposure() {
  const t = new THREE.Texture()
  return new AutoExposure({ tLit: t, tColor: t, tDepth: t })
}

// Runs the adapt pass's spring block (the real GLSL text between the log2
// conversions) in JS, so the test exercises the shader's own integrator.
function springFromShader(src) {
  const a = src.indexOf('float le = log2(e);')
  const b = src.indexOf('e = exp2(le);')
  expect(a).toBeGreaterThan(0)
  expect(b).toBeGreaterThan(a)
  const body = src
    .slice(a, b)
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\b(?:float|int)\s+(\w+)\s*=/g, 'let $1 =')
  const helpers = 'const log2 = Math.log2, min = Math.min, max = Math.max, ceil = Math.ceil, int = Math.trunc, float = Number;'
  return new Function(
    'u',
    'e',
    'v',
    `${helpers} const { uDt, uOmega, uDamping, uBase, uMinEv, uMaxEv, uBias } = u; const target = u.target; ${body} return [2 ** le, v];`
  )
}

// A camcorder walk from a lit corridor (target pinned at minEv) into a
// pitch-dark room (target pinned at maxEv), 3 s at 60 fps.
function darkRoomStep(spring) {
  const x = LOOK_PROFILES[LOOK_CAMCORDER].exposure
  const base = 0.66
  const u = { uDt: 1 / 60, uOmega: x.omega, uDamping: x.damping, uBase: base, uMinEv: x.minEv, uMaxEv: x.maxEv, uBias: 0 }
  u.target = base * 2 ** x.maxEv
  let e = base * 2 ** x.minEv
  let v = 0
  let peak = -Infinity
  for (let i = 0; i < 180; i++) {
    ;[e, v] = spring(u, e, v)
    peak = Math.max(peak, Math.log2(e / base))
  }
  return { peak, end: Math.log2(e / base), maxEv: x.maxEv }
}

describe('auto exposure', () => {
  it('meters chroma in its own half so AWB divides by sum(wc), not sum(w)', () => {
    const ae = makeExposure()
    // Two 64x64 halves; every 4x4 reduction block stays inside one half.
    expect([ae.meterRT.width, ae.meterRT.height]).toEqual([128, 64])
    let w = ae.meterRT.width
    for (const rt of ae.reduceRTs) {
      expect(rt.width).toBe(2 * rt.height)
      expect(rt.width * 4).toBe(w)
      expect((w / 2) % 4).toBe(0)
      w = rt.width
    }
    expect(ae.reduceRTs.at(-1).width).toBe(2)
    const [meter, , adapt] = ae.materials.map((m) => m.fragmentShader)
    expect(meter).toMatch(/vec4\(log2\(c\.r \/ c\.g\) \* wc, log2\(c\.b \/ c\.g\) \* wc, wc, 0\.0\)/)
    expect(adapt).toContain('c.xy / c.z')
    expect(adapt).not.toMatch(/m\.zw\s*\/\s*m\.y/)
    ae.dispose()
  })

  it('weights AWB chroma against the scene-linear key, whatever the family exposure', () => {
    const ae = makeExposure()
    const x = LOOK_PROFILES[LOOK_CAMCORDER].exposure
    for (const base of [0.6, 0.66, 1.3]) {
      ae.configure(x, base)
      expect(ae.meterUniforms.uKey.value * base).toBeCloseTo(x.key, 9)
      expect(ae.meterUniforms.uEmissiveCap.value).toBeCloseTo(Math.log2(x.key / base) + 6, 9)
      expect(ae.adaptUniforms.uKey.value).toBe(x.key) // the exposure target stays exposed-space
    }
    ae.dispose()
  })

  it('applies one AWB strength to every lit room and fades it out in the dark', () => {
    const ae = makeExposure()
    const x = LOOK_PROFILES[LOOK_CAMCORDER].exposure
    const adapt = ae.adaptQuad.material.fragmentShader
    expect(adapt).toContain(`lc *= smoothstep(${AWB_GATE[0]}, ${AWB_GATE[1]}, c.z / max(m.y, 1e-6));`)
    const smooth = (a, b, v) => {
      const t = Math.min(Math.max((v - a) / (b - a), 0), 1)
      return t * t * (3 - 2 * t)
    }
    // Uniform room adapted to `ev` above the family exposure: the meter's
    // lit fraction wc / w is lum / (lum + uKey) with lum = sceneKey / 2^ev.
    const effective = (ev, base) => {
      ae.configure(x, base)
      const k = ae.meterUniforms.uKey.value
      const lum = x.key / base / 2 ** ev
      return x.awbStrength * smooth(AWB_GATE[0], AWB_GATE[1], lum / (lum + k))
    }
    for (const base of [0.6, 1.3]) {
      // Bright corridor to a dim lit room: the same correction throughout
      // (the sum(w) bug gave 0.4 at -2 EV and 0.17 at +1 EV).
      for (const ev of [-2, -1, 0, 0.5, 1]) expect(effective(ev, base)).toBeCloseTo(x.awbStrength, 6)
      // Pinned at maxEv the dusk-blue cast mostly survives; near black it is untouched.
      expect(effective(x.maxEv, base)).toBeLessThan(0.4 * x.awbStrength)
      expect(effective(5, base)).toBe(0)
    }
    ae.dispose()
  })

  it('never lets the hunting spring overshoot the look EV clamp', () => {
    const ae = makeExposure()
    const src = ae.adaptQuad.material.fragmentShader
    const r = darkRoomStep(springFromShader(src))
    expect(r.peak).toBeLessThanOrEqual(r.maxEv + 1e-9)
    expect(r.end).toBeCloseTo(r.maxEv, 6) // still settles on the limit
    // Without the in-loop stop the same step peaks ~0.54 EV past the limit.
    const unclamped = src.replace(/\n\s*if \(le [<>] (?:hi|lo)\)[^\n]*/g, '')
    expect(unclamped).not.toBe(src)
    expect(darkRoomStep(springFromShader(unclamped)).peak).toBeGreaterThan(r.maxEv + 0.4)
    ae.dispose()
  })
})
