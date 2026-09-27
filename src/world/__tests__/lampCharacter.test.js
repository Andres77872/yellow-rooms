import { describe, it, expect } from 'vitest'
import {
  FLICKER_FULL,
  FLICKER_SAFE,
  flickerProfile,
  isBadTube,
  lampFlicker,
  lampTint,
  lampPanelTint,
  tubeHum,
} from '../lampCharacter.js'
import {
  CELL,
  LAMP_FLICKER_AMP,
  LAMP_BAD_LO,
  LAMP_BAD_RATE,
  LAMP_SAFE_BAD_LO,
  LAMP_SAFE_BAD_RATE,
  LAMP_SAFE_DIP,
  LAMP_TINT_VAR,
} from '../constants.js'

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
      for (let t = 0; t < 3; t += 0.061) samples.push(lampFlicker(x, z, cy, t, FLICKER_FULL))
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

// --- Photosensitivity (Settings 'reduceFlicker') ----------------------------

// Bad tubes from a wide deterministic grid (same sweep as above).
function badTubes(limit) {
  const out = []
  for (let gx = 0; gx < 40 && out.length < limit; gx++) {
    for (let gz = 0; gz < 40 && out.length < limit; gz++) {
      const x = (gx + 0.5) * CELL
      const z = (gz + 0.5) * CELL
      if (isBadTube(x, z, 0)) out.push([x, z, 0])
    }
  }
  return out
}

const DT = 1 / 1000 // 1 kHz sampling: far above any step or ripple rate
const trace = (fn, seconds) => {
  const s = new Float64Array(Math.round(seconds / DT))
  for (let i = 0; i < s.length; i++) s[i] = fn(i * DT)
  return s
}

// WCAG 2.3.1 general flash: a pair of opposing luminance changes of at least
// 10%. Zigzag with hysteresis: a change registers once the trace has moved
// `thr` away from the extreme of the previous leg, so ripple smaller than the
// threshold never counts. Returns the most flashes (change pairs) found in
// any one-second window.
function maxFlashesPerSecond(s, thr) {
  const changes = []
  let hi = s[0]
  let lo = s[0]
  let dir = 0
  for (let i = 1; i < s.length; i++) {
    const v = s[i]
    if (dir >= 0) {
      if (v > hi) hi = v
      if (hi - v >= thr) {
        changes.push(i)
        dir = -1
        lo = v
        continue
      }
    }
    if (dir <= 0) {
      if (v < lo) lo = v
      if (v - lo >= thr) {
        changes.push(i)
        dir = 1
        hi = v
      }
    }
  }
  const win = Math.round(1 / DT)
  let best = 0
  for (let a = 0, b = 0; b < changes.length; b++) {
    while (changes[b] - changes[a] >= win) a++
    best = Math.max(best, Math.floor((b - a + 1) / 2))
  }
  return best
}

// Value changes (steps) inside any one-second window.
function maxStepsPerSecond(s) {
  const steps = []
  for (let i = 1; i < s.length; i++) if (s[i] !== s[i - 1]) steps.push(i)
  const win = Math.round(1 / DT)
  let best = 0
  for (let a = 0, b = 0; b < steps.length; b++) {
    while (steps[b] - steps[a] >= win) a++
    best = Math.max(best, b - a + 1)
  }
  return best
}

const swing = (s) => {
  let hi = -Infinity
  let lo = Infinity
  for (const v of s) {
    if (v > hi) hi = v
    if (v < lo) lo = v
  }
  return (hi - lo) / hi // relative to the peak: the conservative reading of 10%
}

// Cast light of a room lit by one tube: the fixture's own flicker times the
// shared hum's cast coupling (Engine._updateFlicker: 0.6 + 0.4 * hum), with a
// dead-tube dip at the Engine's tightest cadence (0.12 s every 4 s).
const roomLight = (x, z, cy, profile) => (t) =>
  lampFlicker(x, z, cy, t, profile) * (0.6 + 0.4 * tubeHum(t, t % 4 < 0.12, profile))

describe('reduce-flicker profile (photosensitivity)', () => {
  const bad = badTubes(16)

  it('selects SAFE when on and is the default everywhere', () => {
    expect(flickerProfile(true)).toBe(FLICKER_SAFE)
    expect(flickerProfile(false)).toBe(FLICKER_FULL)
    expect(FLICKER_FULL.badRate).toBe(LAMP_BAD_RATE)
    expect(FLICKER_FULL.badLo).toBe(LAMP_BAD_LO)
    const [x, z, cy] = bad[0]
    for (let t = 0; t < 4; t += 0.037) {
      expect(lampFlicker(x, z, cy, t)).toBe(lampFlicker(x, z, cy, t, FLICKER_SAFE))
      expect(tubeHum(t, false)).toBe(tubeHum(t, false, FLICKER_SAFE))
    }
  })

  it('caps the bad-tube step rate at <= 3 Hz and the swing under 10%', () => {
    expect(bad.length).toBe(16)
    expect(LAMP_SAFE_BAD_RATE).toBeLessThanOrEqual(3)
    expect(1 - LAMP_SAFE_BAD_LO).toBeLessThan(0.1)
    for (const [x, z, cy] of bad) {
      const s = trace((t) => lampFlicker(x, z, cy, t, FLICKER_SAFE), 12)
      expect(maxStepsPerSecond(s)).toBeLessThanOrEqual(3)
      expect(maxStepsPerSecond(s)).toBeLessThanOrEqual(LAMP_SAFE_BAD_RATE)
      for (const v of s) {
        expect(v).toBeGreaterThanOrEqual(LAMP_SAFE_BAD_LO - 1e-12)
        expect(v).toBeLessThanOrEqual(1)
      }
      expect(swing(s)).toBeLessThan(0.1)
      expect(maxFlashesPerSecond(s, 0.1)).toBe(0)
      // Still a bad tube: it keeps stepping, just slowly and shallowly.
      expect(maxStepsPerSecond(s)).toBeGreaterThan(0)
    }
  })

  it('the full profile is the hazard the setting exists for', () => {
    // Sanity check on the counter as much as a record of why SAFE is the
    // default: the authored ~9 Hz 20-100% strobe fails 2.3.1 outright.
    let worst = 0
    for (const [x, z, cy] of bad) {
      const s = trace((t) => lampFlicker(x, z, cy, t, FLICKER_FULL), 12)
      expect(maxStepsPerSecond(s)).toBeGreaterThan(3)
      worst = Math.max(worst, maxFlashesPerSecond(s, 0.1))
    }
    expect(worst).toBeGreaterThan(3)
  })

  it('healthy tubes are untouched by the profile', () => {
    const good = SPOTS.filter(([x, z, cy]) => !isBadTube(x, z, cy))
    for (const [x, z, cy] of good) {
      for (let t = 0; t < 3; t += 0.071) {
        expect(lampFlicker(x, z, cy, t, FLICKER_SAFE)).toBe(lampFlicker(x, z, cy, t, FLICKER_FULL))
      }
    }
  })

  it('the shared tube hum keeps its ripple under 10% and its dip to a sag', () => {
    const s = trace((t) => tubeHum(t, false, FLICKER_SAFE), 10)
    expect(swing(s)).toBeLessThan(0.1)
    expect(maxFlashesPerSecond(s, 0.1)).toBe(0)
    expect(LAMP_SAFE_DIP).toBeGreaterThan(0.9)
    for (let t = 0; t < 3; t += 0.053) {
      expect(tubeHum(t, true, FLICKER_SAFE) / tubeHum(t, false, FLICKER_SAFE)).toBeCloseTo(LAMP_SAFE_DIP, 12)
    }
  })

  it('FULL keeps the authored hum and 40% dip', () => {
    for (let t = 0; t < 3; t += 0.053) {
      const f = 0.92 + Math.sin(t * 18) * 0.05 + Math.sin(t * 43) * 0.02
      expect(tubeHum(t, false, FLICKER_FULL)).toBeCloseTo(f, 12)
      expect(tubeHum(t, true, FLICKER_FULL)).toBeCloseTo(f * 0.4, 12)
    }
  })

  it('a room lit by a bad tube stays within 3 flashes per second', () => {
    for (const [x, z, cy] of bad) {
      const s = trace(roomLight(x, z, cy, FLICKER_SAFE), 12)
      expect(maxFlashesPerSecond(s, 0.1)).toBeLessThanOrEqual(3)
    }
    let worst = 0
    for (const [x, z, cy] of bad) {
      worst = Math.max(worst, maxFlashesPerSecond(trace(roomLight(x, z, cy, FLICKER_FULL), 12), 0.1))
    }
    expect(worst).toBeGreaterThan(3)
  })
})
