import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WALK_SPEED, PURSUER_LEASH, PURSUER_BAND_MIN, PURSUER_BAND_MAX, PURSUER_CATCH, LAYER_H } from '../../world/constants.js'
import { pursuerSpeed, shouldRelocate, clampBandDist, decideMode, chooseFallback } from '../pursuerLogic.js'
import { mergeEnemy } from '../../core/enemyMerge.js'

// Mock the shared modules so the class test fully controls vision/pathing and we
// assert on the Pursuer's own decision logic, not the real A*/collision.
vi.mock('../sense.js', () => ({
  EYE_Y_REL: 1.6,
  inFrustum: vi.fn(() => false),
  sightGate: vi.fn(() => false),
  findHiddenSpot: vi.fn(() => null),
}))
vi.mock('../../world/pathfind.js', () => ({
  findPath: vi.fn(() => null),
  followPath: vi.fn((cm, ent, path, i, step) => {
    ent.pos.x += step // move so "never stops" is observable
    return { i: i + 1, movedSq: step * step, done: false, stair: false }
  }),
}))
vi.mock('../../player/collision.js', () => ({
  moveAndCollide: vi.fn((cm, pos, dx, dz) => {
    pos.x += dx
    pos.z += dz
    return { x: false, z: false }
  }),
  hasLineOfSight: vi.fn(() => true),
}))

import { Pursuer } from '../Pursuer.js'
import { sightGate, findHiddenSpot } from '../sense.js'
import { findPath, followPath } from '../../world/pathfind.js'
import { moveAndCollide, hasLineOfSight } from '../../player/collision.js'

const cm = { columnAt: () => false, stairAt: () => null, isBlocked: () => false }
const scene = { add() {} }
const geom = { pursuer: undefined }
const materials = { pursuer: undefined }
const camera = {}

function makePursuer() {
  return new Pursuer(scene, materials, geom, cm)
}
const dist = (p, player) => Math.hypot(player.x - p.pos.x, player.z - p.pos.z)

beforeEach(() => {
  vi.clearAllMocks()
  sightGate.mockReturnValue(false)
  findHiddenSpot.mockReturnValue(null)
  findPath.mockReturnValue(null)
  followPath.mockImplementation((c, ent, path, i, step) => {
    ent.pos.x += step
    return { i: i + 1, movedSq: step * step, done: false, stair: false }
  })
  hasLineOfSight.mockReturnValue(true)
  moveAndCollide.mockImplementation((c, pos, dx, dz) => {
    pos.x += dx
    pos.z += dz
    return { x: false, z: false }
  })
})

describe('pursuerLogic (pure)', () => {
  it('shouldRelocate fires only past the leash and off cooldown', () => {
    expect(shouldRelocate(99, 100, 0)).toBe(false)
    expect(shouldRelocate(120, 100, 0)).toBe(true)
    expect(shouldRelocate(120, 100, 1)).toBe(false) // cooldown blocks thrash
  })

  it('clampBandDist clamps into the band', () => {
    expect(clampBandDist(10, 45, 85)).toBe(45)
    expect(clampBandDist(200, 45, 85)).toBe(85)
    expect(clampBandDist(60, 45, 85)).toBe(60)
  })

  it('decideMode picks beeline with LOS, path without', () => {
    expect(decideMode(true)).toBe('beeline')
    expect(decideMode(false)).toBe('path')
  })

  it('chooseFallback: direct only on the same floor, hold across floors', () => {
    expect(chooseFallback(true, 0, false)).toBe('beeline')
    expect(chooseFallback(false, 0, true)).toBe('path')
    expect(chooseFallback(false, 1, true)).toBe('path')
    expect(chooseFallback(false, 0, false)).toBe('direct')
    expect(chooseFallback(false, 1, false)).toBe('hold')
    expect(chooseFallback(false, -1, false)).toBe('hold')
  })

  it('chaseSpeed stays below WALK_SPEED across all levels', () => {
    for (let lvl = 1; lvl <= 20; lvl++) {
      expect(pursuerSpeed(lvl)).toBeLessThan(WALK_SPEED)
      expect(pursuerSpeed(lvl)).toBeGreaterThan(0)
    }
    expect(pursuerSpeed(1)).toBeCloseTo(WALK_SPEED * 0.55, 5)
    expect(pursuerSpeed(20)).toBeGreaterThan(pursuerSpeed(1)) // scales up with level
  })
})

describe('enemyMerge', () => {
  it('combines two enemy results, beam/frozen from the first', () => {
    const a = { caught: false, dist: 10, seen: true, tension: 0.4, inBeam: true, frozen: true }
    const b = { caught: true, dist: 3, seen: false, tension: 0.9, inBeam: false, frozen: false }
    const m = mergeEnemy(a, b)
    expect(m.caught).toBe(true)
    expect(m.dist).toBe(3)
    expect(m.seen).toBe(true)
    expect(m.tension).toBeCloseTo(0.9)
    expect(m.inBeam).toBe(true) // from a (stalker)
    expect(m.frozen).toBe(true)
  })

  it('merges any number of results (three enemies)', () => {
    const a = { caught: false, dist: 10, seen: false, tension: 0.4, inBeam: true, frozen: true }
    const b = { caught: false, dist: 8, seen: false, tension: 0.2, inBeam: false, frozen: false }
    const c = { caught: false, dist: 2, seen: true, tension: 0.95, inBeam: false, frozen: false }
    const m = mergeEnemy(a, b, c)
    expect(m.caught).toBe(false)
    expect(m.dist).toBe(2) // the husk at arm's length drives the slow
    expect(m.seen).toBe(true)
    expect(m.tension).toBeCloseTo(0.95)
    expect(m.inBeam).toBe(true) // still the stalker's
    expect(m.frozen).toBe(true)
  })
})

describe('Pursuer class', () => {
  it('respects spawn grace, then activates off-screen', () => {
    const p = makePursuer()
    p.reset(1, { x: 0, z: 0 })
    const player = { x: 0, z: 0 }
    const r0 = p.update(0.1, player, camera)
    expect(p.active).toBe(false) // still inside the grace window
    expect(r0.dist).toBe(Infinity)

    findHiddenSpot.mockReturnValue({ x: 60, z: 0, cy: 0 })
    p.update(5, player, camera) // grace elapsed
    expect(p.active).toBe(true)
    expect(p.mesh.visible).toBe(true)
  })

  it('beelines toward the player with LOS and catches at range', () => {
    const p = makePursuer()
    p.reset(1, { x: 0, z: 0 })
    p.active = true
    const player = { x: 0, z: 0 }

    p.pos.set(20, 0, 0)
    hasLineOfSight.mockReturnValue(true)
    const before = dist(p, player)
    const r = p.update(0.1, player, camera)
    expect(dist(p, player)).toBeLessThan(before) // closed the gap
    expect(moveAndCollide).toHaveBeenCalled()
    expect(r.caught).toBe(false)

    p.pos.set(1.0, 0, 0) // inside catch radius
    const r2 = p.update(0.1, player, camera)
    expect(r2.caught).toBe(true)
    expect(PURSUER_CATCH).toBeGreaterThan(1.0)
  })

  it('never stops when LOS is blocked — paths, and still moves when findPath is null', () => {
    const p = makePursuer()
    p.reset(1, { x: 0, z: 0 })
    p.active = true
    const player = { x: 0, z: 0 }
    p.pos.set(30, 0, 0)
    hasLineOfSight.mockReturnValue(false)

    findPath.mockReturnValue([10, 0, 0, 5, 0, 0, 0, 0, 0]) // a real route (triples)
    let x0 = p.pos.x
    p.update(0.1, player, camera)
    expect(followPath).toHaveBeenCalled()
    expect(p.pos.x).not.toBe(x0)

    findPath.mockReturnValue(null) // no route -> direct fallback, still moves
    p.follower.reset() // force a recompute (clear the cached route from above)
    p.pos.set(30, 0, 0)
    p.update(0.1, player, camera)
    expect(p.pos.x).not.toBe(30)
    expect(p.stateLabel).toBe('pathing(direct)')
  })

  it('relocates past the leash into the band, respecting the cooldown', () => {
    const p = makePursuer()
    p.reset(1, { x: 0, z: 0 })
    p.active = true
    const player = { x: 0, z: 0 }
    p.pos.set(PURSUER_LEASH + 50, 0, 0) // well past the leash
    findHiddenSpot.mockReturnValue({ x: 60, z: 0, cy: 0 })

    p.update(0.1, player, camera)
    expect(findHiddenSpot).toHaveBeenCalledTimes(1)
    const d = dist(p, player)
    expect(d).toBeGreaterThanOrEqual(PURSUER_BAND_MIN - 5)
    expect(d).toBeLessThanOrEqual(PURSUER_BAND_MAX + 5)

    // Drag it past the leash again immediately — cooldown must block a re-relocate.
    p.pos.set(PURSUER_LEASH + 50, 0, 0)
    p.update(0.1, player, camera)
    expect(findHiddenSpot).toHaveBeenCalledTimes(1)
  })

  it('relocate fallback never lands on the player', () => {
    const p = makePursuer()
    p.reset(1, { x: 0, z: 0 })
    p.active = true
    const player = { x: 0, z: 0 }
    p.pos.set(PURSUER_LEASH + 60, 0, 0)
    findHiddenSpot.mockReturnValue(null) // every sampler attempt fails -> bearing snap

    expect(() => p.update(0.1, player, camera)).not.toThrow()
    expect(dist(p, player)).toBeGreaterThan(PURSUER_CATCH) // not on top of the player
  })

  it('reports seen via the sight gate', () => {
    const p = makePursuer()
    p.reset(1, { x: 0, z: 0 })
    p.active = true
    const player = { x: 0, z: 0 }
    p.pos.set(15, 0, 0)

    sightGate.mockReturnValue(false)
    expect(p.update(0.1, player, camera).seen).toBe(false)
    sightGate.mockReturnValue(true)
    expect(p.update(0.1, player, camera).seen).toBe(true)
  })

  it('chases across floors: no beeline, pathfinds with both floor indices', () => {
    const p = makePursuer()
    p.reset(1, { x: 0, z: 0 })
    p.active = true
    p.cy = 0
    const player = { x: 0, y: LAYER_H, z: 0 } // one floor up
    p.pos.set(10, 0, 0)
    hasLineOfSight.mockReturnValue(true) // even with 2D LOS true...
    findPath.mockReturnValue([3, 0, 0, 3, 0, 1]) // route via a stair
    p.update(0.1, player, camera, { playerCy: 1 })
    // ...a cross-floor player must NOT be beelined at through the slab:
    expect(p.stateLabel).toBe('pathing')
    expect(findPath).toHaveBeenCalledWith(
      cm, 10, 0, 0, 0, 0, 1,
      expect.objectContaining({ leash: expect.any(Number) })
    )
    expect(followPath).toHaveBeenCalled()
  })

  it('holds (not direct-grinds) when cross-floor with no route', () => {
    const p = makePursuer()
    p.reset(1, { x: 0, z: 0 })
    p.active = true
    p.cy = 0
    const player = { x: 0, y: LAYER_H, z: 0 }
    p.pos.set(10, 0, 0)
    hasLineOfSight.mockReturnValue(true)
    findPath.mockReturnValue(null)
    const x0 = p.pos.x
    p.update(0.1, player, camera, { playerCy: 1 })
    expect(p.stateLabel).toBe('holding')
    expect(p.pos.x).toBe(x0) // no movement
  })

  it('escalates a stuck state to a relocate without teleporting onto the player', () => {
    const p = makePursuer()
    p.reset(1, { x: 0, z: 0 })
    p.active = true
    const player = { x: 0, z: 0 }
    p.pos.set(12, 0, 0)
    hasLineOfSight.mockReturnValue(true)
    moveAndCollide.mockImplementation(() => ({ x: true, z: true })) // wall-stuck: no progress
    findHiddenSpot.mockReturnValue({ x: 60, z: 0, cy: 0 })

    for (let k = 0; k < 6; k++) p.update(0.5, player, camera) // accrue > stuck-relocate seconds
    expect(findHiddenSpot).toHaveBeenCalled() // stuck escalated to a relocate
    expect(dist(p, player)).toBeGreaterThan(PURSUER_CATCH)
  })
})
