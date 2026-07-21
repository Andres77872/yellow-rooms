import { describe, it, expect } from 'vitest'
import { CameraFx } from '../cameraFx.js'
import { HeadBob } from '../headbob.js'

const FOV_KICK = 5
const LEAN_MAX = 0.02
const DIP_DUR = 0.38

// Drive updates at a fixed 60Hz step for `seconds`.
const run = (fx, seconds, sprinting = false, strafe = 0) => {
  const dt = 1 / 60
  for (let t = 0; t < seconds; t += dt) fx.update(dt, sprinting, strafe)
}

describe('CameraFx', () => {
  it('fov eases toward the kick while sprinting and settles exactly', () => {
    const fx = new CameraFx()
    fx.update(1 / 60, true, 0)
    expect(fx.fovOffset).toBeGreaterThan(0)
    expect(fx.fovOffset).toBeLessThan(FOV_KICK)
    run(fx, 2, true)
    // Exact, not approximate: the snap is what stops per-frame
    // updateProjectionMatrix calls once the transition is over.
    expect(fx.fovOffset).toBe(FOV_KICK)
    run(fx, 2, false)
    expect(fx.fovOffset).toBe(0)
  })

  it('strafe right leans right (negative roll), capped at LEAN_MAX', () => {
    const fx = new CameraFx()
    run(fx, 2, false, 1)
    expect(fx.roll).toBe(-LEAN_MAX)
    run(fx, 2, false, -1)
    expect(fx.roll).toBe(LEAN_MAX)
    run(fx, 2, false, 0.5)
    expect(fx.roll).toBeCloseTo(-LEAN_MAX * 0.5, 10)
  })

  it('landing dips then returns to exactly zero; harder falls dip deeper', () => {
    const fx = new CameraFx()
    fx.notifyLand(3)
    fx.update(1 / 60, false, 0)
    const soft = fx.dipY
    expect(soft).toBeLessThan(0)
    run(fx, DIP_DUR + 0.1)
    expect(fx.dipY).toBe(0)

    fx.notifyLand(30)
    fx.update(1 / 60, false, 0)
    expect(fx.dipY).toBeLessThan(soft)
  })

  it('disabled: everything drives to zero and landings are ignored', () => {
    const fx = new CameraFx()
    run(fx, 2, true, 1)
    fx.enabled = false
    fx.notifyLand(30)
    expect(fx.dipY).toBe(0)
    run(fx, 2, true, 1)
    expect(fx.fovOffset).toBe(0)
    expect(fx.roll).toBe(0)
  })

  it('reset zeroes instantly', () => {
    const fx = new CameraFx()
    run(fx, 2, true, 1)
    fx.notifyLand(30)
    fx.reset()
    expect(fx.fovOffset).toBe(0)
    expect(fx.roll).toBe(0)
    expect(fx.dipY).toBe(0)
  })
})

// Footstep timing hangs off HeadBob.phase's sign-crossing — the fx polish must
// never touch it, under any toggle combination.
describe('HeadBob fx polish', () => {
  it('phase stays the plain sine and advances for every fx/enabled combo', () => {
    for (const fx of [true, false]) {
      for (const enabled of [true, false]) {
        const hb = new HeadBob()
        hb.fx = fx
        hb.enabled = enabled
        const before = hb.t
        hb.update(1 / 60, 5.2, true)
        expect(hb.t).toBeGreaterThan(before)
        expect(hb.phase).toBe(Math.sin(hb.t))
      }
    }
  })

  it('fx off reproduces the plain-sine bob exactly, roll 0', () => {
    const hb = new HeadBob()
    hb.fx = false
    for (let i = 0; i < 30; i++) hb.update(1 / 60, 5.2, true)
    expect(hb.bobY).toBe(Math.sin(hb.t) * 0.065 * hb.amp)
    expect(hb.bobRoll).toBe(0)
  })

  it('fx bob stays within the plain bob excursion', () => {
    const hb = new HeadBob()
    hb.amp = 1
    let min = 0
    let max = 0
    for (let t = 0; t < Math.PI * 2; t += 0.01) {
      hb.t = t
      min = Math.min(min, hb.bobY)
      max = Math.max(max, hb.bobY)
    }
    expect(min).toBeGreaterThan(-0.07)
    expect(max).toBeLessThan(0.07)
  })

  it('bob disabled silences the sway roll too (amp-scaled)', () => {
    const hb = new HeadBob()
    hb.enabled = false
    for (let i = 0; i < 200; i++) hb.update(1 / 60, 5.2, true)
    expect(Math.abs(hb.bobRoll)).toBeLessThan(1e-4)
  })
})
