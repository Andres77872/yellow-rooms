import { describe, it, expect } from 'vitest'
import { fmix32, hash2i, hash3i, hash2f, hashStr } from '../core/hash.js'

// Reference xmur3 (the pre-refactor string hash) — hashStr must match it exactly.
function xmur3(str) {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return h >>> 0
  }
}

describe('hash primitives', () => {
  it('fmix32 is a deterministic uint32', () => {
    for (const v of [0, 1, -1, 1234567, 0x7fffffff | 0]) {
      const a = fmix32(v)
      expect(a).toBe(fmix32(v))
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThanOrEqual(0xffffffff)
      expect(Number.isInteger(a)).toBe(true)
    }
  })

  it('hash2i / hash3i are deterministic uint32 and order-sensitive', () => {
    expect(hash2i(42, 1, 2)).toBe(hash2i(42, 1, 2))
    expect(hash2i(42, 1, 2)).not.toBe(hash2i(42, 2, 1))
    expect(hash2i(42, 1, 2)).not.toBe(hash2i(43, 1, 2))
    expect(hash3i(42, 1, 2, 3)).toBe(hash3i(42, 1, 2, 3))
    expect(hash3i(42, 1, 2, 3)).not.toBe(hash3i(42, 3, 2, 1))
    for (const x of [-5, 0, 7, 9999]) {
      const h = hash2i(7, x, x + 1)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('hash2f is in [0,1) with a mean near 0.5', () => {
    let sum = 0
    const N = 20000
    for (let i = 0; i < N; i++) {
      const f = hash2f(1, i % 137, (i * 31) % 251)
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThan(1)
      sum += f
    }
    expect(Math.abs(sum / N - 0.5)).toBeLessThan(0.02)
  })

  it('hashStr is bit-identical to the legacy xmur3', () => {
    for (const s of ['lobby', 'seed#1', 'seed#1#exit', '', 'a', 'The Backrooms 600M']) {
      expect(hashStr(s)).toBe(xmur3(s)())
    }
  })
})
