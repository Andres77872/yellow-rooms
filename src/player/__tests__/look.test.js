import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as THREE from 'three'
import { Controller } from '../Controller.js'

const MAX_PITCH = Math.PI / 2 - 0.05
const SENS = 0.002

// Controller binds to window/document at construction. Node test env has
// neither, so capture the listeners it registers and drive them directly.
let doc = {}
function makeController() {
  const c = new Controller(new THREE.PerspectiveCamera(), {}, { phase: 'PLAYING' })
  c.sensitivity = SENS
  c.isLocked = true
  return c
}
const mouse = (dx, dy) => doc.mousemove({ movementX: dx, movementY: dy })

describe('look input', () => {
  beforeEach(() => {
    doc = {}
    vi.stubGlobal('addEventListener', () => {})
    vi.stubGlobal('document', {
      addEventListener: (type, fn) => {
        doc[type] = fn
      },
      pointerLockElement: null,
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('mouse right yaws right, mouse down pitches down', () => {
    const c = makeController()
    mouse(10, 10)
    expect(c.yaw).toBeCloseTo(-10 * SENS, 10)
    expect(c.pitch).toBeCloseTo(-10 * SENS, 10)
  })

  it('invertY flips pitch only', () => {
    const c = makeController()
    c.invertY = true
    mouse(10, 10)
    expect(c.yaw).toBeCloseTo(-10 * SENS, 10) // yaw untouched
    expect(c.pitch).toBeCloseTo(10 * SENS, 10) // pull down -> look up
  })

  it('invertX flips yaw only', () => {
    const c = makeController()
    c.invertX = true
    mouse(10, 10)
    expect(c.yaw).toBeCloseTo(10 * SENS, 10)
    expect(c.pitch).toBeCloseTo(-10 * SENS, 10)
  })

  it('both inversions compose', () => {
    const c = makeController()
    c.invertY = true
    c.invertX = true
    mouse(10, -4)
    expect(c.yaw).toBeCloseTo(10 * SENS, 10)
    expect(c.pitch).toBeCloseTo(-4 * SENS, 10)
  })

  it('scales with sensitivity', () => {
    const c = makeController()
    c.sensitivity = SENS * 3
    mouse(10, 0)
    expect(c.yaw).toBeCloseTo(-30 * SENS, 10)
  })

  // The clamp lives past the invert, so an inverted player can't overshoot the
  // pole in the direction the sign flip sends them.
  it('clamps pitch at both poles regardless of invert', () => {
    for (const invertY of [false, true]) {
      const c = makeController()
      c.invertY = invertY
      mouse(0, 100_000)
      expect(Math.abs(c.pitch)).toBeCloseTo(MAX_PITCH, 10)
      mouse(0, -200_000)
      expect(Math.abs(c.pitch)).toBeCloseTo(MAX_PITCH, 10)
    }
  })

  it('ignores the mouse while unlocked or with input disabled', () => {
    const c = makeController()
    c.isLocked = false
    mouse(50, 50)
    expect(c.yaw).toBe(0)

    c.isLocked = true
    c.inputEnabled = false // debug mode parks the player
    mouse(50, 50)
    expect(c.yaw).toBe(0)
    expect(c.pitch).toBe(0)
  })

  // Touch look runs hotter than the mouse (short thumb travel), but must honour
  // the same sensitivity and invert flags — it's the same integrator.
  it('touch look shares sensitivity and inversion, at a higher gain', () => {
    const c = makeController()
    c.lookDelta(10, 10)
    const touchYaw = c.yaw
    const touchPitch = c.pitch
    expect(touchYaw).toBeLessThan(-10 * SENS) // same sign as the mouse, larger
    expect(touchPitch).toBeLessThan(-10 * SENS)

    const inv = makeController()
    inv.invertY = true
    inv.invertX = true
    inv.lookDelta(10, 10)
    expect(inv.yaw).toBeCloseTo(-touchYaw, 10)
    expect(inv.pitch).toBeCloseTo(-touchPitch, 10)
  })

  it('touch look respects the input gate', () => {
    const c = makeController()
    c.inputEnabled = false
    c.lookDelta(50, 50)
    expect(c.yaw).toBe(0)
    expect(c.pitch).toBe(0)
  })
})
