import { describe, it, expect } from 'vitest'
import { DEFAULT_WORLD_CONFIG as CFG } from '../config.js'
import { ZONE_OFFICE, ZONE_PILLARS, ZONE_WAREHOUSE } from '../constants.js'
import { sampleRegionValue, selectZone } from '../zones/index.js'

describe('coherent macro regions', () => {
  it('samples a deterministic bounded domain-warped field', () => {
    for (const seed of [1, 42, 0xbeef]) {
      for (const [cx, cz] of [[0, 0], [-70, -99], [123, -456]]) {
        const a = sampleRegionValue(cx, cz, seed, CFG)
        const b = sampleRegionValue(cx, cz, seed, CFG)
        expect(a).toBe(b)
        expect(a).toBeGreaterThanOrEqual(0)
        expect(a).toBeLessThan(1)
      }
    }
  })

  it('guarantees pillars between every office and warehouse edge', () => {
    for (const seed of [1, 42, 0xbeef, 314159, 0xc0ffee]) {
      for (let cz = -80; cz < 80; cz++) {
        for (let cx = -80; cx < 80; cx++) {
          const a = selectZone(cx, cz, seed, CFG)
          for (const [dx, dz] of [[1, 0], [0, 1]]) {
            const b = selectZone(cx + dx, cz + dz, seed, CFG)
            expect(
              (a === ZONE_OFFICE && b === ZONE_WAREHOUSE) ||
              (a === ZONE_WAREHOUSE && b === ZONE_OFFICE)
            ).toBe(false)
          }
        }
      }
    }
  })

  it('keeps broad style proportions and high neighbouring agreement', () => {
    const counts = [0, 0, 0]
    let same = 0
    let edges = 0
    for (const seed of [1, 42, 0xbeef]) {
      for (let cz = -70; cz < 70; cz++) {
        for (let cx = -70; cx < 70; cx++) {
          const a = selectZone(cx, cz, seed, CFG)
          counts[a]++
          for (const [dx, dz] of [[1, 0], [0, 1]]) {
            same += selectZone(cx + dx, cz + dz, seed, CFG) === a ? 1 : 0
            edges++
          }
        }
      }
    }
    const total = counts.reduce((a, b) => a + b)
    const fractions = counts.map((n) => n / total)
    expect(fractions[ZONE_OFFICE]).toBeGreaterThan(0.38)
    expect(fractions[ZONE_OFFICE]).toBeLessThan(0.52)
    expect(fractions[ZONE_PILLARS]).toBeGreaterThan(0.22)
    expect(fractions[ZONE_PILLARS]).toBeLessThan(0.38)
    expect(fractions[ZONE_WAREHOUSE]).toBeGreaterThan(0.18)
    expect(fractions[ZONE_WAREHOUSE]).toBeLessThan(0.32)
    expect(same / edges).toBeGreaterThan(0.88)
  })
})
