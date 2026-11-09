import { describe, expect, it } from 'vitest'
import { GRID_GLSL, REF_DIV, divMagic } from '../shaders/grid.js'
import {
  GRID_FLOORS,
  GRID_W,
  OCC_CELLS,
  REF_FLOOR_REACH,
  REF_REACH,
  REF_SPAN,
  decodeRef,
  imod,
} from '../../world/lightGrid/gridSpec.js'

// The grid shaders address every texel through gImod and decode every list
// entry through gRefDecode. Both avoid the integer divide (GPUs have no fast
// one: it was ~13% of the lighting pass), so their exactness is checked here
// against the CPU encoder, with the shader's float32 arithmetic emulated.

const f = Math.fround

// gImod as the shader evaluates it, for both ways a driver may divide.
function gImodExact(a, n) {
  return a - n * Math.floor(f(f(a + 0.5) / n))
}
function gImodReciprocal(a, n) {
  return a - n * Math.floor(f(f(a + 0.5) * f(1 / n)))
}

describe('gImod (float quotient)', () => {
  it('is the generated source the emulation mirrors', () => {
    expect(GRID_GLSL).toMatch(
      /int gImod\(int a, int n\)\{ return a - n \* int\(floor\(\(float\(a\) \+ 0\.5\) \/ float\(n\)\)\); \}/
    )
  })

  it('equals the CPU modulo around every multiple the world can reach', () => {
    // Mismatches are collected and asserted once: this walks ~200k values.
    const wrong = []
    const check = (a, n) => {
      const want = imod(a, n)
      if (gImodExact(a, n) !== want) wrong.push(`${a} mod ${n}`)
      if (gImodReciprocal(a, n) !== want) wrong.push(`${a} mod ${n} (reciprocal)`)
    }
    for (const n of [GRID_W, GRID_FLOORS]) {
      // Dense near the origin, then every multiple's neighbourhood out to the
      // documented 2^22 limit (the quotient is closest to an integer there).
      for (let a = -3 * n; a <= 3 * n; a++) check(a, n)
      const limit = 2 ** 22
      const step = Math.max(1, Math.floor(limit / n / 4096))
      for (let q = -Math.floor(limit / n); q <= Math.floor(limit / n); q += step) {
        for (const d of [-2, -1, 0, 1, 2]) {
          const a = q * n + d
          if (Math.abs(a) < limit) check(a, n)
        }
      }
    }
    expect(wrong.slice(0, 10)).toEqual([])
  })
})

describe('gRefDecode (multiply-shift)', () => {
  it('finds constants that divide every 10-bit ref exactly', () => {
    const [m1, s1] = REF_DIV.span
    const [m2, s2] = REF_DIV.span2
    for (let ref = 0; ref < 1024; ref++) {
      // 32-bit signed arithmetic, as GLSL highp int.
      const q = Math.imul(ref, m1) >> s1
      const fl = Math.imul(ref, m2) >> s2
      const want = decodeRef(ref)
      expect(ref - q * REF_SPAN - REF_REACH, `dx of ${ref}`).toBe(want.dx)
      expect(q - fl * REF_SPAN - REF_REACH, `dz of ${ref}`).toBe(want.dz)
      expect(fl - REF_FLOOR_REACH, `df of ${ref}`).toBe(want.df)
    }
    expect(1023 * m1).toBeLessThan(2 ** 31)
    expect(1023 * m2).toBeLessThan(2 ** 31)
  })

  it('emits those constants and no integer divide', () => {
    const [m1, s1] = REF_DIV.span
    const [m2, s2] = REF_DIV.span2
    expect(GRID_GLSL).toContain(`int q = (ref * ${m1}) >> ${s1};`)
    expect(GRID_GLSL).toContain(`int f = (ref * ${m2}) >> ${s2};`)
    const decode = GRID_GLSL.slice(GRID_GLSL.indexOf('ivec3 gRefDecode('), GRID_GLSL.indexOf('bool gridEntry(')).replace(
      /\/\/[^\n]*/g,
      ''
    )
    expect(decode).not.toMatch(/[%]/)
    expect(decode).not.toMatch(/ref \/ /)
  })

  it('refuses a divisor it cannot serve', () => {
    expect(divMagic(9, 1024)).toEqual(REF_DIV.span)
    expect(() => divMagic(3, 2 ** 31)).toThrow()
  })
})

describe('gBitIndex (float exponent)', () => {
  it('returns the bit of every occupancy ring cell', () => {
    expect(GRID_GLSL).toMatch(/int gBitIndex\(uint bit\)\{ return \(floatBitsToInt\(float\(bit\)\) >> 23\) - 127; \}/)
    const fl = new Float32Array(1)
    const bits = new Int32Array(fl.buffer)
    for (let b = 0; b < OCC_CELLS; b++) {
      fl[0] = 2 ** b
      expect((bits[0] >> 23) - 127, `bit ${b}`).toBe(b)
    }
  })
})
