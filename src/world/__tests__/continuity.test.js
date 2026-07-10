import { describe, it, expect } from 'vitest'
import { buildChunk } from '../pipeline.js'
import { DEFAULT_WORLD_CONFIG as CFG } from '../config.js'
import { chunkKey } from '../constants.js'
import { auditPatch } from '../audit.js'

// Proves canonical transition contracts remain safe while internal office
// chunk lines behave like ordinary cuts through a district plan:
//   - no open-zone, transition, or district-boundary contract is sealed;
//   - adjacent OPEN zones merge (near-fully-open seams);
//   - office<->open seams always have a wide transition MOUTH (smooth handoff);
//   - office district boundaries have sparse portals;
//   - internal district seam patterns vary and may be solid room walls.
// auditPatch is the same validator the debug world map uses.

const X0 = -7
const Z0 = -7
const N = 14
const SEEDS = [1, 42, 0xbeef, 314159, 0xc0ffee, 99999, 7, 2026]

function patch(seed) {
  const m = new Map()
  for (let cz = Z0; cz < Z0 + N; cz++) {
    for (let cx = X0; cx < X0 + N; cx++) m.set(chunkKey(cx, cz), buildChunk(seed, cx, cz, CFG))
  }
  return auditPatch((cx, cz) => m.get(chunkKey(cx, cz)) ?? null, X0, Z0, N, N, CFG)
}

describe('chunk continuity (not isolated boxes)', () => {
  const audits = SEEDS.map(patch)

  it('no canonical transition or district-boundary contract is sealed', () => {
    for (const a of audits) {
      expect(a.sealed).toBe(0)
      expect(a.minOpen).toBeGreaterThanOrEqual(1)
    }
  })

  it('adjacent open zones merge (seams stay mostly open)', () => {
    for (const a of audits) {
      if (a.open.n === 0) continue
      expect(a.openness).toBeGreaterThanOrEqual(0.85)
    }
  })

  it('office<->open transitions always carve a wide mouth', () => {
    for (const a of audits) {
      if (a.mouth.n === 0) continue
      expect(a.mouthCoverage).toBe(1) // every transition seam has a >= mouthWidth[0] run
    }
  })

  it('office district boundaries keep corners walled and have sparse portals', () => {
    for (const a of audits) {
      if (a.office.n === 0) continue
      expect(a.office.cornerWalls).toBe(a.office.n)
      expect(a.office.minDoors).toBeGreaterThanOrEqual(1)
    }
  })

  it('internal office seam slices have varied patterns instead of a periodic lattice', () => {
    for (const a of audits) {
      if (a.planned.n === 0) continue
      expect(a.planned.patterns).toBeGreaterThan(1)
      expect(a.planVariety).toBeGreaterThan(0.08)
    }
  })

  it('the test corpus actually exercises every seam category', () => {
    const sum = (k, sub) => audits.reduce((t, a) => t + a[k][sub], 0)
    expect(sum('open', 'n')).toBeGreaterThan(0)
    expect(sum('mouth', 'n')).toBeGreaterThan(0)
    expect(sum('office', 'n')).toBeGreaterThan(0)
    expect(sum('planned', 'n')).toBeGreaterThan(0)
  })
})
