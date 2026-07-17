import { describe, it, expect } from 'vitest'
import { isBadTube, lampFlicker, lampTint, lampPanelTint } from '../lampCharacter.js'
import { CELL, LAMP_FLICKER_AMP, LAMP_BAD_LO, LAMP_TINT_VAR } from '../constants.js'

// A spread of lamp positions across floors.
const SPOTS = []
for (let i = 0; i < 40; i++) {
  SPOTS.push([(i * 7 + 0.5) * CELL, (i * 13 + 0.5) * CELL, i % 4])
}

describe('lampCharacter', () => {
  it('is deterministic and position-keyed', () => {
    for (const [x, z, cy] of SPOTS) {
      expect(lampFlicker(x, z, cy, 3.7)).toBe(lampFlicker(x, z, cy, 3.7))
      expect(isBadTube(x, z, cy)).toBe(isBadTube(x, z, cy))
      const a = lampTint(x, z, cy, [0, 0, 0])
      const b = lampTint(x, z, cy, [0, 0, 0])
      expect(a).toEqual(b)
    }
  })

  it('cell-centre positions are stable under float wobble', () => {
    const x = 10.5 * CELL
    const z = -4.5 * CELL
    expect(lampFlicker(x + 1e-6, z - 1e-6, 0, 1)).toBe(lampFlicker(x, z, 0, 1))
  })

  it('healthy tubes only ever dip slightly from full brightness', () => {
    const good = SPOTS.filter(([x, z, cy]) => !isBadTube(x, z, cy))
    expect(good.length).toBeGreaterThan(20)
    for (const [x, z, cy] of good) {
      for (let t = 0; t < 5; t += 0.113) {
        const f = lampFlicker(x, z, cy, t)
        expect(f).toBeLessThanOrEqual(1)
        expect(f).toBeGreaterThanOrEqual(1 - LAMP_FLICKER_AMP - 1e-12)
      }
    }
  })

  it('bad tubes are rare and strobe erratically toward the dim floor', () => {
    // Sample a wide deterministic grid: rate should be in a sane band around
    // LAMP_BAD_CHANCE regardless of the exact hash values.
    const bad = []
    let total = 0
    for (let gx = 0; gx < 30; gx++) {
      for (let gz = 0; gz < 30; gz++) {
        for (let cy = 0; cy < 2; cy++) {
          total++
          if (isBadTube((gx + 0.5) * CELL, (gz + 0.5) * CELL, cy)) {
            bad.push([(gx + 0.5) * CELL, (gz + 0.5) * CELL, cy])
          }
        }
      }
    }
    const rate = bad.length / total
    expect(rate).toBeGreaterThan(0.01)
    expect(rate).toBeLessThan(0.2)
    for (const [x, z, cy] of bad.slice(0, 12)) {
      const samples = []
      for (let t = 0; t < 3; t += 0.061) samples.push(lampFlicker(x, z, cy, t))
      for (const f of samples) {
        expect(f).toBeGreaterThanOrEqual(LAMP_BAD_LO - 1e-12)
        expect(f).toBeLessThanOrEqual(1)
      }
      // Erratic: the sequence actually moves (not a steady glow).
      const spread = Math.max(...samples) - Math.min(...samples)
      expect(spread).toBeGreaterThan(0.05)
    }
  })

  it('tint stays a subtle drift around 1 and dims bad tubes at the fixture', () => {
    for (const [x, z, cy] of SPOTS) {
      const t = lampTint(x, z, cy, [0, 0, 0])
      for (const c of t) {
        expect(c).toBeGreaterThan(1 - LAMP_TINT_VAR * 1.4 - 1e-12)
        expect(c).toBeLessThan(1 + LAMP_TINT_VAR * 1.4 + 1e-12)
      }
      const p = lampPanelTint(x, z, cy, [0, 0, 0])
      if (isBadTube(x, z, cy)) {
        expect(p[0]).toBeLessThan(0.5)
        expect(p[1]).toBeLessThan(0.5)
      } else {
        expect(p).toEqual(t)
      }
    }
  })
})
