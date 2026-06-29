import { describe, it, expect } from 'vitest'
import { buildChunk } from '../pipeline.js'
import { DEFAULT_WORLD_CONFIG as CFG } from '../config.js'
import { chunkKey } from '../constants.js'
import { auditPatch } from '../audit.js'

// Proves the world reads as a CONTINUATION, not a grid of isolated boxes:
//   - no shared border is ever fully sealed (no isolated chunk);
//   - adjacent OPEN zones merge (near-fully-open seams);
//   - office<->open seams always have a wide transition MOUTH (smooth handoff);
//   - office<->office partitions keep corners walled, have >= officeMinDoors, and
//     their doorways LINE UP across consecutive seams (the lattice continuation).
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

  it('no shared border is ever fully sealed', () => {
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

  it('office<->office partitions keep corners walled and >= officeMinDoors', () => {
    for (const a of audits) {
      if (a.office.n === 0) continue
      expect(a.office.cornerWalls).toBe(a.office.n)
      expect(a.office.minDoors).toBeGreaterThanOrEqual(CFG.border.officeMinDoors)
    }
  })

  it('office doorways line up across consecutive seams (continuation)', () => {
    for (const a of audits) {
      if (a.aligned.pairs === 0) continue
      expect(a.alignment).toBeGreaterThanOrEqual(0.9)
    }
  })

  it('the test corpus actually exercises every seam category', () => {
    const sum = (k, sub) => audits.reduce((t, a) => t + a[k][sub], 0)
    expect(sum('open', 'n')).toBeGreaterThan(0)
    expect(sum('mouth', 'n')).toBeGreaterThan(0)
    expect(sum('office', 'n')).toBeGreaterThan(0)
    expect(sum('aligned', 'pairs')).toBeGreaterThan(0)
  })
})
