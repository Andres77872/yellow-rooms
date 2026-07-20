import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the pathfinder so these tests drive the FOLLOWER's decision logic
// (when to recompute, what to report), not the real A*.
vi.mock('../../world/pathfind.js', () => ({
  findPath: vi.fn(() => null),
  followPath: vi.fn((cm, ent, path, i, step) => {
    ent.pos.x += step
    return { i: i + 1, movedSq: step * step, done: false, stair: false }
  }),
  edgeOpen: vi.fn(() => true),
  cellBlocked: vi.fn(() => false),
}))

import { PathFollower } from '../follow.js'
import { CELL } from '../../world/constants.js'
import { findPath, followPath } from '../../world/pathfind.js'

const cm = {}

function makeEnt(x = 0, z = 0, cy = 0) {
  return { pos: { x, y: 0, z }, cy }
}

function makeFollower(opts = {}) {
  return new PathFollower(cm, { leash: 22, maxNodes: 1200, repathEvery: 0.5, ...opts })
}

beforeEach(() => {
  vi.clearAllMocks()
  findPath.mockReturnValue([1, 0, 0, 2, 0, 0, 3, 0, 0])
  followPath.mockImplementation((c, ent, path, i, step) => {
    ent.pos.x += step
    return { i: i + 1, movedSq: step * step, done: false, stair: false }
  })
})

describe('PathFollower', () => {
  it('computes a route on the first step and advances along it', () => {
    const f = makeFollower()
    const ent = makeEnt()
    const r = f.step(ent, 0.1, 30, 0, 0, 0.5)
    expect(findPath).toHaveBeenCalledTimes(1)
    expect(followPath).toHaveBeenCalledTimes(1)
    expect(r.repathed).toBe(true)
    expect(r.hasPath).toBe(true)
    expect(ent.pos.x).toBeCloseTo(0.5)
  })

  it('throttles recomputes to the cadence while the target holds still', () => {
    const f = makeFollower()
    const ent = makeEnt()
    // Far target (beyond nearCells) => full 0.5s cadence applies.
    const tx = 30 * CELL
    f.step(ent, 0.1, tx, 0, 0, 0.01)
    f.step(ent, 0.1, tx, 0, 0, 0.01)
    f.step(ent, 0.1, tx, 0, 0, 0.01)
    expect(findPath).toHaveBeenCalledTimes(1) // 0.3s elapsed < 0.5s
    f.step(ent, 0.3, tx, 0, 0, 0.01) // 0.6s elapsed -> cadence fires
    expect(findPath).toHaveBeenCalledTimes(2)
  })

  it('repaths at the halved cadence when the target is near', () => {
    const f = makeFollower()
    const ent = makeEnt()
    const tx = 3 * CELL // 3 cells away: inside nearCells (5)
    f.step(ent, 0.05, tx, 0, 0, 0.01)
    expect(findPath).toHaveBeenCalledTimes(1)
    f.step(ent, 0.2, tx, 0, 0, 0.01)
    f.step(ent, 0.1, tx, 0, 0, 0.01) // 0.3s > repathNear (0.25s)
    expect(findPath).toHaveBeenCalledTimes(2)
  })

  it('drift: repaths immediately when the target leaves the goal neighbourhood', () => {
    const f = makeFollower()
    const ent = makeEnt()
    const tx = 30 * CELL
    f.step(ent, 0.05, tx, 0, 0, 0.01)
    expect(findPath).toHaveBeenCalledTimes(1)
    // Mid-interval, target hops 3 cells sideways (> driftCells 2): recompute NOW.
    f.step(ent, 0.05, tx, 3.5 * CELL, 0, 0.01)
    expect(findPath).toHaveBeenCalledTimes(2)
    // A hop of 1 cell stays inside the tolerance: no recompute.
    f.step(ent, 0.05, tx, 2.5 * CELL, 0, 0.01)
    expect(findPath).toHaveBeenCalledTimes(2)
  })

  it('drift: a target floor change forces an immediate repath', () => {
    const f = makeFollower()
    const ent = makeEnt()
    const tx = 30 * CELL
    f.step(ent, 0.05, tx, 0, 0, 0)
    f.step(ent, 0.05, tx, 0, 1, 0) // same XZ, player went upstairs
    expect(findPath).toHaveBeenCalledTimes(2)
    expect(findPath).toHaveBeenLastCalledWith(cm, 0, 0, 0, tx, 0, 1, expect.any(Object))
  })

  it('reset() drops the route and recomputes on the next step', () => {
    const f = makeFollower()
    const ent = makeEnt()
    const tx = 30 * CELL
    f.step(ent, 0.05, tx, 0, 0, 0.01)
    f.reset()
    expect(f.hasPath).toBe(false)
    f.step(ent, 0.05, tx, 0, 0, 0.01)
    expect(findPath).toHaveBeenCalledTimes(2)
  })

  it('reports pathless recomputes and takes no movement', () => {
    findPath.mockReturnValue(null)
    const f = makeFollower()
    const ent = makeEnt()
    const r = f.step(ent, 0.1, 30, 0, 0, 0.5)
    expect(r.repathed).toBe(true)
    expect(r.hasPath).toBe(false)
    expect(followPath).not.toHaveBeenCalled()
    expect(ent.pos.x).toBe(0)
  })

  it('propagates done/stair from the advance', () => {
    followPath.mockImplementation(() => ({ i: 3, movedSq: 0, done: true, stair: true }))
    const f = makeFollower()
    const ent = makeEnt()
    const r = f.step(ent, 0.1, 30, 0, 0, 0.5)
    expect(r.done).toBe(true)
    expect(r.stair).toBe(true)
  })
})
