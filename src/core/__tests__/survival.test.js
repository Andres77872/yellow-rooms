import { describe, expect, it } from 'vitest'
import {
  PROXIMITY_SLOW_MAX,
  PROXIMITY_SLOW_RADIUS,
  STARE_LIMIT_BASE,
  STARE_SANITY_DRAIN,
} from '../../world/constants.js'
import { GameState } from '../GameState.js'
import {
  SANITY_RECOVER,
  SANITY_SEEN_DRAIN,
  SANITY_TENSE_DRAIN,
  proximitySpeedMul,
  stareLimit,
  survivalGrade,
  updateSanity,
  updateStare,
} from '../survival.js'

const calm = { seen: false, tension: 0 }

describe('stareLimit', () => {
  it('shrinks with level and never drops below one second', () => {
    expect(stareLimit(1)).toBeCloseTo(STARE_LIMIT_BASE - 0.12)
    expect(stareLimit(5)).toBeLessThan(stareLimit(1))
    expect(stareLimit(1000)).toBe(1)
  })
})

describe('updateSanity', () => {
  it('drains fastest while an enemy is seen, slower while merely tense', () => {
    const seen = new GameState()
    const tense = new GameState()
    updateSanity(seen, 1, { seen: true, tension: 0 })
    updateSanity(tense, 1, { seen: false, tension: 0.9 })
    expect(seen.sanity).toBeCloseTo(1 - SANITY_SEEN_DRAIN)
    expect(tense.sanity).toBeCloseTo(1 - SANITY_TENSE_DRAIN)
  })

  it('recovers when calm, capped at full and floored at zero', () => {
    const s = new GameState()
    s.sanity = 0.5
    updateSanity(s, 1, calm)
    expect(s.sanity).toBeCloseTo(0.5 + SANITY_RECOVER)
    updateSanity(s, 100, calm)
    expect(s.sanity).toBe(1)
    updateSanity(s, 100, { seen: true, tension: 1 })
    expect(s.sanity).toBe(0)
  })
})

describe('updateStare', () => {
  it('charges exposure in the beam and only drains sanity past the limit', () => {
    const s = new GameState()
    updateStare(s, 1, true, 2)
    expect(s.exposure).toBe(1)
    expect(s.stareCharge).toBe(0.5)
    expect(s.sanity).toBe(1)
    updateStare(s, 1.5, true, 2)
    expect(s.stareCharge).toBe(1)
    expect(s.sanity).toBeCloseTo(1 - STARE_SANITY_DRAIN * 1.5)
  })

  it('decays exposure out of the beam without going negative', () => {
    const s = new GameState()
    s.exposure = 0.1
    updateStare(s, 10, false, 2)
    expect(s.exposure).toBe(0)
    expect(s.stareCharge).toBe(0)
  })
})

describe('proximitySpeedMul', () => {
  it('is 1 outside the radius and for dormant (Infinity/NaN) enemies', () => {
    expect(proximitySpeedMul(PROXIMITY_SLOW_RADIUS)).toBe(1)
    expect(proximitySpeedMul(Infinity)).toBe(1)
    expect(proximitySpeedMul(NaN)).toBe(1)
  })

  it('ramps linearly to the maximum slow at point-blank', () => {
    expect(proximitySpeedMul(0)).toBeCloseTo(1 - PROXIMITY_SLOW_MAX)
    expect(proximitySpeedMul(PROXIMITY_SLOW_RADIUS / 2)).toBeCloseTo(1 - PROXIMITY_SLOW_MAX / 2)
    expect(proximitySpeedMul(-1)).toBeCloseTo(1 - PROXIMITY_SLOW_MAX)
  })
})

describe('survivalGrade', () => {
  it('is clean on a calm full-sanity frame in danger mode', () => {
    const fx = survivalGrade(new GameState(), 0, 'danger', 2)
    expect(fx.grain).toBe(0)
    expect(fx.vignette).toBeCloseTo(0.16)
    expect(fx.aberration).toBeCloseTo(0.0008)
  })

  it('keeps a grain floor in always mode and silences all grain when off', () => {
    const s = new GameState()
    s.sanity = 0
    s.exposure = 10
    expect(survivalGrade(new GameState(), 0, 'always', 2).grain).toBeCloseTo(0.022)
    expect(survivalGrade(s, 1, 'off', 2).grain).toBe(0)
  })

  it('reuses the output object', () => {
    const out = {}
    expect(survivalGrade(new GameState(), 0, 'danger', 2, out)).toBe(out)
  })
})
