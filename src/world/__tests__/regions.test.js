import { describe, it, expect } from 'vitest'
import { DEFAULT_WORLD_CONFIG as CFG } from '../config.js'
import { ZONE_OFFICE, ZONE_PILLARS, ZONE_WAREHOUSE } from '../constants.js'
import { regionLandmark, sampleRegionValue, selectZone } from '../zones/index.js'

function largestOpenComponent(seed, radius) {
  const size = radius * 2 + 1
  const open = new Uint8Array(size * size)
  for (let z = -radius; z <= radius; z++) {
    for (let x = -radius; x <= radius; x++) {
      open[(z + radius) * size + x + radius] =
        selectZone(x, z, seed, CFG) === ZONE_OFFICE ? 0 : 1
    }
  }
  const seen = new Uint8Array(open.length)
  let largest = 0
  for (let start = 0; start < open.length; start++) {
    if (!open[start] || seen[start]) continue
    seen[start] = 1
    const stack = [start]
    let count = 0
    while (stack.length) {
      const i = stack.pop()
      count++
      const x = i % size
      const z = Math.floor(i / size)
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + dx
        const nz = z + dz
        if (nx < 0 || nx >= size || nz < 0 || nz >= size) continue
        const ni = nz * size + nx
        if (!open[ni] || seen[ni]) continue
        seen[ni] = 1
        stack.push(ni)
      }
    }
    largest = Math.max(largest, count)
  }
  return largest
}

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

  it('keeps rooms dominant while retaining coherent bounded landmarks', () => {
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
    expect(fractions[ZONE_OFFICE]).toBeGreaterThan(0.92)
    expect(fractions[ZONE_OFFICE]).toBeLessThan(0.97)
    expect(fractions[ZONE_PILLARS]).toBeGreaterThan(0.03)
    expect(fractions[ZONE_PILLARS]).toBeLessThan(0.08)
    expect(fractions[ZONE_WAREHOUSE]).toBeGreaterThan(0.0005)
    expect(fractions[ZONE_WAREHOUSE]).toBeLessThan(0.006)
    expect(same / edges).toBeGreaterThan(0.93)
  })

  it('separates compact halls from rare hero courts', () => {
    let ordinary = 0
    let heroes = 0
    let warehouseCourts = 0
    const patterns = new Set()
    for (let seed = 0; seed < 16; seed++) {
      for (let dz = -12; dz <= 12; dz++) {
        for (let dx = -12; dx <= 12; dx++) {
          const landmark = regionLandmark(seed, dx, dz, CFG)
          if (!landmark.active) continue
          patterns.add(landmark.pierPattern)
          expect(['x', 'z']).toContain(landmark.axis)
          expect(landmark.landmarkSignature).toContain(landmark.pierPattern)
          if (landmark.hero) {
            heroes++
            expect(landmark.intensityRole).toBe('hero')
            expect(landmark.width).toBeGreaterThanOrEqual(3)
            expect(landmark.width).toBeLessThanOrEqual(4)
            expect(landmark.height).toBeGreaterThanOrEqual(3)
            expect(landmark.height).toBeLessThanOrEqual(4)
          } else {
            ordinary++
            expect(landmark.intensityRole).toBe('ordinary')
            expect(landmark.kind).toBe('pillarHall')
            expect(landmark.width).toBeGreaterThanOrEqual(1)
            expect(landmark.width).toBeLessThanOrEqual(2)
            expect(landmark.height).toBeGreaterThanOrEqual(1)
            expect(landmark.height).toBeLessThanOrEqual(2)
          }
          if (landmark.kind === 'warehouseCourt') {
            warehouseCourts++
            expect(landmark.hero).toBe(true)
            expect(landmark.sampledZone).toBe(ZONE_WAREHOUSE)
            expect(landmark.pierPattern).toBe('courtColonnade')
          }
        }
      }
    }
    expect(ordinary).toBeGreaterThan(0)
    expect(heroes).toBeGreaterThan(0)
    expect(warehouseCourts).toBeGreaterThan(0)
    expect(patterns).toEqual(new Set([
      'monumentalGrid',
      'processionalAisle',
      'brokenBay',
      'courtColonnade',
    ]))
  })

  it('hard-caps open components and never elects adjacent landmark districts', () => {
    const maxSpan = Math.max(
      CFG.region.roomDominance.maxSpanChunks,
      CFG.region.roomDominance.heroMaxSpanChunks
    )
    for (const seed of [1, 42, 0xbeef, 314159, 0xc0ffee]) {
      expect(largestOpenComponent(seed, 80)).toBeLessThanOrEqual(maxSpan * maxSpan)
      for (let dz = -20; dz <= 20; dz++) {
        for (let dx = -20; dx <= 20; dx++) {
          const here = regionLandmark(seed, dx, dz, CFG)
          if (!here.active) continue
          expect(regionLandmark(seed, dx + 1, dz, CFG).active).toBe(false)
          expect(regionLandmark(seed, dx, dz + 1, CFG).active).toBe(false)
        }
      }
    }
  })

  it('keeps every spawn neighbourhood room-majority across a seed corpus', () => {
    for (let seed = 0; seed < 512; seed++) {
      let office = 0
      for (let cz = -4; cz <= 4; cz++) {
        for (let cx = -4; cx <= 4; cx++) {
          if (selectZone(cx, cz, seed, CFG) === ZONE_OFFICE) office++
        }
      }
      expect(office).toBeGreaterThanOrEqual(57)
      for (let cz = -1; cz <= 1; cz++) {
        for (let cx = -1; cx <= 1; cx++) {
          expect(selectZone(cx, cz, seed, CFG)).toBe(ZONE_OFFICE)
        }
      }
    }
  })
})
