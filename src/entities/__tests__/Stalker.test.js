import { describe, it, expect, vi, beforeEach } from 'vitest'

// Sensing, collision and routing are mocked so these tests drive only the
// Stalker's own decisions (beeline vs route, despawn bookkeeping).
vi.mock('../sense.js', () => ({
  sightGate: vi.fn(() => false),
  findHiddenSpot: vi.fn(() => null),
}))

vi.mock('../../player/collision.js', () => ({
  moveAndCollide: vi.fn((cm, pos, dx, dz) => {
    pos.x += dx
    pos.z += dz
    return { x: false, z: false }
  }),
  hasWalkableCorridor: vi.fn(() => true),
}))

vi.mock('../../player/ground.js', () => ({ groundHeightAt: () => 0 }))

vi.mock('../follow.js', () => ({
  PathFollower: class {
    constructor() {
      this.configure = vi.fn()
      this.reset = vi.fn()
      this.step = vi.fn(() => ({ hasPath: true, stair: false, done: false, repathed: false }))
    }
  },
  extrapolateSearch: vi.fn((cm, gx, gz) => ({ gx, gz })),
  cellCenterOf: (g) => g + 0.5,
}))

import { Stalker } from '../Stalker.js'
import { sightGate } from '../sense.js'
import { moveAndCollide, hasWalkableCorridor } from '../../player/collision.js'

const camera = {}
const makeStalker = () => {
  const s = new Stalker({ add() {} }, {}, {}, { lightAt: () => 1 })
  s.reset(1, { x: 0, z: 0 })
  s.active = true
  s.pos.set(10, 0, 0)
  return s
}

beforeEach(() => {
  vi.clearAllMocks()
  sightGate.mockReturnValue(false)
  hasWalkableCorridor.mockReturnValue(true)
})

describe('Stalker', () => {
  it('beelines when the seen player is reachable in a straight walkable line', () => {
    const s = makeStalker()
    sightGate.mockReturnValue(true)
    const r = s.update(0.1, { x: 0, z: 0 }, camera, { playerCy: 0 })
    expect(s.stateLabel).toBe('chasing')
    expect(moveAndCollide).toHaveBeenCalled()
    expect(s.follower.step).not.toHaveBeenCalled()
    expect(r.seen).toBe(true)
  })

  it('routes instead of grinding when it sees the player across a rail or desk', () => {
    const s = makeStalker()
    sightGate.mockReturnValue(true)
    hasWalkableCorridor.mockReturnValue(false)
    s.update(0.1, { x: 0, z: 0 }, camera, { playerCy: 0 })
    expect(s.stateLabel).toBe('pursuing(route)')
    expect(moveAndCollide).not.toHaveBeenCalled()
    expect(s.follower.step).toHaveBeenCalledOnce()
  })

  it('reports the catch distance after this frame\'s move', () => {
    const s = makeStalker()
    s.pos.set(1.3, 0, 0) // just outside catchDist before moving
    sightGate.mockReturnValue(true)
    const r = s.update(0.1, { x: 0, z: 0 }, camera, { playerCy: 0 })
    expect(r.dist).toBeLessThan(1.3)
    expect(r.caught).toBe(true)
  })

  it('forgets the previous pursuit episode when it despawns', () => {
    const s = makeStalker()
    s._pursueT = 1.5
    s._hasLast = true
    s._searched = true
    s._despawn()
    expect(s.active).toBe(false)
    expect(s._pursueT).toBe(0)
    expect(s._hasLast).toBe(false)
    expect(s._searched).toBe(false)
    expect(s.follower.reset).toHaveBeenCalled()
  })
})
