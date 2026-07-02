import { describe, it, expect } from 'vitest'
import { stickVector, sprintGate } from '../stick.js'

const R = 60 // px radius used by TouchControls

describe('stickVector', () => {
  it('zeroes inside the deadzone', () => {
    expect(stickVector(0, 0, R)).toEqual({ x: 0, z: 0, mag: 0 })
    const v = stickVector(R * 0.1, R * 0.1, R) // len ≈ 0.14 < 0.15
    expect(v).toEqual({ x: 0, z: 0, mag: 0 })
  })

  it('passes analog magnitude through below the rim', () => {
    const v = stickVector(0, -R * 0.5, R) // half-forward
    expect(v.x).toBeCloseTo(0)
    expect(v.z).toBeCloseTo(0.5)
    expect(v.mag).toBeCloseTo(0.5)
  })

  it('clamps to the unit circle beyond the radius', () => {
    const v = stickVector(R * 3, -R * 4, R) // len 5, direction (0.6, 0.8)
    expect(v.mag).toBe(1)
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(1)
    expect(v.x).toBeCloseTo(0.6)
    expect(v.z).toBeCloseTo(0.8)
  })

  it('maps screen axes to controller axes (up = forward, right = strafe right)', () => {
    expect(stickVector(0, -R, R).z).toBeCloseTo(1) // drag up → forward
    expect(stickVector(0, R, R).z).toBeCloseTo(-1) // drag down → back
    expect(stickVector(R, 0, R).x).toBeCloseTo(1) // drag right → strafe right
    expect(stickVector(-R, 0, R).x).toBeCloseTo(-1) // drag left → strafe left
  })

  it('respects a custom deadzone', () => {
    expect(stickVector(0, -R * 0.3, R, 0.5).mag).toBe(0)
    expect(stickVector(0, -R * 0.6, R, 0.5).mag).toBeCloseTo(0.6)
  })
})

describe('sprintGate', () => {
  it('engages only at the rim', () => {
    expect(sprintGate(false, 0.9)).toBe(false)
    expect(sprintGate(false, 0.95)).toBe(true)
    expect(sprintGate(false, 1)).toBe(true)
  })

  it('holds through the hysteresis band once engaged', () => {
    expect(sprintGate(true, 0.9)).toBe(true) // between release and engage
    expect(sprintGate(true, 0.85)).toBe(true)
  })

  it('releases below the release threshold', () => {
    expect(sprintGate(true, 0.84)).toBe(false)
    expect(sprintGate(false, 0.84)).toBe(false)
  })
})
