import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  HUSK_BAND_MIN,
  HUSK_BAND_MAX,
  HUSK_TOUCH,
  HUSK_CLOSE_KILL,
  HUSK_RESPAWN_DEAD,
  HUSK_RESPAWN_FADE,
} from '../../world/constants.js'

// Mock the shared sensing so the test fully controls spawn spots + visibility.
vi.mock('../sense.js', () => ({
  EYE_Y_REL: 1.6,
  inFrustum: vi.fn(() => false),
  sightGate: vi.fn(() => false),
  findHiddenSpot: vi.fn(() => null),
}))

import { Husk } from '../Husk.js'
import { sightGate, findHiddenSpot } from '../sense.js'

const cm = {}
const scene = { add() {} }
const geom = { husk: undefined }
const materials = { husk: undefined }
const camera = {}

function makeHusk() {
  const h = new Husk(scene, materials, geom, cm)
  h.reset(1, { x: 0, z: 0 })
  return h
}

// Fast-forward through the dormant countdown and place it at `spot`.
function spawn(h, spot = { x: 15, z: 0, cy: 0 }, player = { x: 0, z: 0 }) {
  findHiddenSpot.mockReturnValue(spot)
  h.update(60, player, camera)
  expect(h.active).toBe(true)
  return h
}

beforeEach(() => {
  vi.clearAllMocks()
  sightGate.mockReturnValue(false)
  findHiddenSpot.mockReturnValue(null)
})

describe('Husk', () => {
  it('stays dormant through the cooldown, then appears off-screen in the near band', () => {
    const h = makeHusk()
    const r0 = h.update(0.1, { x: 0, z: 0 }, camera)
    expect(h.active).toBe(false)
    expect(r0.dist).toBe(Infinity)

    findHiddenSpot.mockReturnValue({ x: 15, z: 0, cy: 0 })
    h.update(60, { x: 0, z: 0 }, camera)
    expect(h.active).toBe(true)
    expect(h.mesh.visible).toBe(true)
    expect(findHiddenSpot).toHaveBeenCalledWith(
      cm, camera, 0, 0, 0, HUSK_BAND_MIN, HUSK_BAND_MAX, expect.any(Object)
    )
  })

  it('retries shortly when confined (no spot available)', () => {
    const h = makeHusk()
    h.update(60, { x: 0, z: 0 }, camera) // cooldown elapsed, sampler returns null
    expect(h.active).toBe(false)
    expect(h._spawnTimer).toBeCloseTo(0.4)
  })

  it('never moves, whatever the player does', () => {
    const h = spawn(makeHusk())
    for (const px of [8, 20, 11, 30]) {
      h.update(0.5, { x: px, z: 5 }, camera)
    }
    expect(h.pos.x).toBe(15)
    expect(h.pos.z).toBe(0)
  })

  it('dies instantly on touch and reports the death event', () => {
    const h = spawn(makeHusk())
    const r = h.update(0.1, { x: 15 - HUSK_TOUCH * 0.5, z: 0 }, camera)
    expect(r.died).toBe(true)
    expect(r.caught).toBe(false)
    expect(r.dist).toBe(Infinity) // proximity-slow releases on the death frame
    expect(h.active).toBe(false)
    expect(h.mesh.visible).toBe(false)
    expect(h.kills).toBe(1)
    expect(h._spawnTimer).toBe(HUSK_RESPAWN_DEAD)
  })

  it('dies after the player lingers inside the close radius', () => {
    const h = spawn(makeHusk())
    const player = { x: 12.5, z: 0 } // dist 2.5: inside close (3.5), outside touch
    let died = false
    let t = 0
    for (let i = 0; i < 10 && !died; i++) {
      died = h.update(0.5, player, camera).died
      t += 0.5
    }
    expect(died).toBe(true)
    expect(t).toBeGreaterThanOrEqual(HUSK_CLOSE_KILL)
    expect(h.kills).toBe(1)
  })

  it('close pressure decays when the player retreats', () => {
    const h = spawn(makeHusk())
    h.update(1.0, { x: 12.5, z: 0 }, camera) // 1.0s of pressure
    for (let i = 0; i < 4; i++) h.update(1.0, { x: 25, z: 0 }, camera) // fully decays
    // Coming back restarts the clock: 2.0s more is still under the threshold.
    let r = h.update(1.0, { x: 12.5, z: 0 }, camera)
    r = h.update(1.0, { x: 12.5, z: 0 }, camera)
    expect(r.died).toBe(false)
    expect(h.active).toBe(true)
  })

  it('fades away when the player leaves it behind (no death event)', () => {
    const h = spawn(makeHusk())
    let r
    for (let i = 0; i < 3; i++) r = h.update(0.5, { x: 50, z: 0 }, camera) // dist 35 > vanish
    expect(h.active).toBe(false)
    expect(r.died).toBe(false)
    expect(h.kills).toBe(0)
    expect(h._spawnTimer).toBe(HUSK_RESPAWN_FADE)
  })

  it('never fades while genuinely watched', () => {
    const h = spawn(makeHusk())
    sightGate.mockReturnValue(true) // in frustum with LOS
    for (let i = 0; i < 6; i++) h.update(0.5, { x: 50, z: 0 }, camera)
    expect(h.active).toBe(true) // holds until the player looks away
    sightGate.mockReturnValue(false)
    h.update(0.5, { x: 50, z: 0 }, camera)
    expect(h.active).toBe(false)
  })

  it('a player on another floor counts as away', () => {
    const h = spawn(makeHusk())
    for (let i = 0; i < 4; i++) h.update(0.5, { x: 15, y: 3.6, z: 0 }, camera, { playerCy: 1 })
    expect(h.active).toBe(false)
    expect(h.kills).toBe(0)
  })

  it('reports seen + tension through the sight gate, and never catches', () => {
    const h = spawn(makeHusk())
    sightGate.mockReturnValue(true)
    const r = h.update(0.1, { x: 8, z: 0 }, camera)
    expect(r.seen).toBe(true)
    expect(r.caught).toBe(false)
    expect(r.tension).toBeGreaterThan(0)
    expect(r.inBeam).toBe(false)
  })

  it('frozen (debug) takes no action, even at touch range', () => {
    const h = spawn(makeHusk())
    h.frozen = true
    const r = h.update(0.1, { x: 15, z: 0.5 }, camera)
    expect(r.died).toBe(false)
    expect(h.active).toBe(true)
    expect(r.dist).toBeCloseTo(0.5)
  })
})
