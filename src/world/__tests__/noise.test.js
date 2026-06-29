import { describe, it, expect } from 'vitest'
import { valueNoise2D, fbm2D, domainWarp2D } from '../core/noise.js'
import { hash2f } from '../core/hash.js'

describe('noise', () => {
  it('valueNoise2D is in [0,1) and deterministic', () => {
    for (let i = 0; i < 500; i++) {
      const x = (i * 0.137) % 50
      const y = (i * 0.911) % 50
      const v = valueNoise2D(x, y, 7)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      expect(v).toBe(valueNoise2D(x, y, 7))
    }
  })

  it('valueNoise2D equals the lattice hash at integer points (seam-safe)', () => {
    for (let x = -3; x <= 3; x++) {
      for (let y = -3; y <= 3; y++) {
        expect(valueNoise2D(x, y, 99)).toBeCloseTo(hash2f(99, x, y), 12)
      }
    }
  })

  it('valueNoise2D is continuous across an integer boundary', () => {
    const eps = 1e-4
    const left = valueNoise2D(2 - eps, 1.3, 5)
    const right = valueNoise2D(2 + eps, 1.3, 5)
    expect(Math.abs(left - right)).toBeLessThan(1e-3)
  })

  it('fbm2D and domainWarp2D stay in [0,1) and are deterministic', () => {
    for (let i = 0; i < 200; i++) {
      const x = i * 0.05
      const y = i * 0.03
      const f = fbm2D(x, y, { seed: 3 })
      const d = domainWarp2D(x, y, { seed: 3, amp: 1 })
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThan(1)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(1)
      expect(f).toBe(fbm2D(x, y, { seed: 3 }))
    }
  })
})
