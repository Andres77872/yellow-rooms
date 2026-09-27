import { describe, expect, it } from 'vitest'
import { hashStr } from '../core/hash.js'
import { buildChunk } from '../pipeline.js'
import { worldConfigForFamily } from '../mapFamily.js'
import {
  familyDistinctness,
  patchSignature,
  skeletonOverlap,
} from '../familySignature.js'

// v26 guard: the five families must be different MAPS, not one layout in
// five palettes. Before v26 the Office and Hotel layouts of a seed were
// statistically indistinguishable (effect 0.34) and every non-sewer pair
// shared the same chunk-seam skeleton (Cohen's kappa 0.69–0.79). Features are
// layout-only (familySignature.js), so no dressing change can pass this.
// Full-size report: npm run report:families.

const FAMILIES = ['office', 'hotel', 'sewer', 'tower', 'lattice']

describe('family distinctness', () => {
  it('keeps every family pair structurally distinct with unrelated skeletons', () => {
    const configs = Object.fromEntries(FAMILIES.map((f) => [f, worldConfigForFamily(f)]))
    const samples = Object.fromEntries(FAMILIES.map((f) => [f, []]))
    const kappa = {}
    for (let i = 0; i < 3; i++) {
      const seed = hashStr(`distinct-${i}`)
      const at = Object.fromEntries(FAMILIES.map((f) => {
        const cache = new Map()
        return [f, (cx, cy, cz) => {
          const key = `${cx},${cy},${cz}`
          if (!cache.has(key)) cache.set(key, buildChunk(seed, cx, cy, cz, configs[f]))
          return cache.get(key)
        }]
      }))
      for (const [cx0, cz0] of [[-1, -1], [6 + 3 * i, -8]]) {
        for (const cy of [0, 2]) {
          for (const f of FAMILIES) samples[f].push(patchSignature(at[f], cx0, cz0, 3, cy))
          for (let a = 0; a < FAMILIES.length; a++) {
            for (let b = a + 1; b < FAMILIES.length; b++) {
              const key = `${FAMILIES[a]}~${FAMILIES[b]}`
              ;(kappa[key] ??= []).push(skeletonOverlap(at[FAMILIES[a]], at[FAMILIES[b]], cx0, cz0, 3, cy).seamKappa)
            }
          }
        }
      }
    }
    const report = familyDistinctness(samples)
    for (const [pair, values] of Object.entries(kappa)) {
      const mean = values.reduce((x, y) => x + y, 0) / values.length
      expect(mean, `${pair} shares its chunk-seam skeleton`).toBeLessThan(0.3)
    }
    for (const [pair, { rms }] of Object.entries(report.pairwise)) {
      expect(rms, `${pair} layouts are too alike`).toBeGreaterThan(1)
    }
    expect(report.accuracy).toBeGreaterThan(0.8)
  })
})
