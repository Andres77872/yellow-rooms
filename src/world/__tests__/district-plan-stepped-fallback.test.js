import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { ChunkManager } from '../ChunkManager.js'
import { chunkKey3 } from '../constants.js'
import { generateChunk } from '../generate.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { MAP_FAMILY_OFFICE } from '../mapTypes.js'
import {
  buildOfficeDistrictPlan,
  clearOfficePlanCache,
  officeDistrictPlanPending,
  officePlanCandidatesBuilt,
  stepOfficeDistrictPlan,
} from '../zones/officePlan.js'

// With real configs every plan candidate is valid (the planner's repair passes
// see to it), so the draws past the base pool, a budget with no valid plan and
// a candidate that throws cannot be reached through configuration. Role
// election is the planner's last stage before scoring: wrapping it lets a test
// spoil chosen candidates with a hard-constraint violation (a stair lobby
// whose mouth is not circulation) or make them throw. `spoil.calls` counts
// candidates since the test last reset it.
const spoil = vi.hoisted(() => ({ calls: 0, invalid: () => false, throws: () => false }))

vi.mock('../rooms/election.js', async (importOriginal) => {
  const real = await importOriginal()
  const { CELL_ROOM } = await import('../mapTypes.js')
  return {
    ...real,
    assignSpaceRoles(plan, ...rest) {
      const candidate = spoil.calls++
      if (spoil.throws(candidate)) throw new Error('candidate blew up')
      const result = real.assignSpaceRoles(plan, ...rest)
      if (spoil.invalid(candidate)) {
        const cell = plan.cellKind.findIndex((kind, i) => plan.active[i] && kind === CELL_ROOM)
        if (cell < 0) throw new Error('fixture: the plan has no room cell to spoil')
        plan.stairLobbies.push({
          mouth: { x: cell % plan.size, z: Math.floor(cell / plan.size) },
          cells: [],
        })
      }
      return result
    },
  }
})

const SEED = 0x0ff1ce
const DISTRICT = [1, -2]

function officeConfig(planCandidates, planCandidateLimit) {
  const config = worldConfigForFamily(MAP_FAMILY_OFFICE)
  config.office.planCandidates = planCandidates
  config.office.planCandidateLimit = planCandidateLimit
  return config
}

function counting(fn) {
  const before = officePlanCandidatesBuilt()
  const result = fn()
  return { result, candidates: officePlanCandidatesBuilt() - before }
}

const read = (config) => buildOfficeDistrictPlan(SEED, ...DISTRICT, config)
const step = (config) => stepOfficeDistrictPlan(SEED, ...DISTRICT, config)
const pending = (config) => officeDistrictPlanPending(SEED, ...DISTRICT, config)

function inOneGo(config) {
  clearOfficePlanCache(config)
  spoil.calls = 0
  return counting(() => read(config))
}

function inSteps(config) {
  clearOfficePlanCache(config)
  spoil.calls = 0
  let steps = 0
  while (pending(config)) {
    step(config)
    if (++steps > 64) throw new Error('stepped plan never finished')
  }
  return steps
}

beforeEach(() => {
  spoil.calls = 0
  spoil.invalid = () => false
  spoil.throws = () => false
})

describe('district plan in steps: past the base pool', () => {
  it('keeps drawing until a candidate is valid, as the one-go loop does', () => {
    const config = officeConfig(2, 6)
    spoil.invalid = (candidate) => candidate < 3
    const whole = inOneGo(config)
    expect(whole.candidates).toBe(4) // 0-2 spoiled, 3 is the first valid one

    expect(inSteps(config)).toBe(4)
    const stepped = counting(() => read(config))
    expect(stepped.candidates).toBe(0)
    expect(stepped.result).toStrictEqual(whole.result)
  })

  it('picks the best valid candidate of the base pool, as the one-go loop does', () => {
    const config = officeConfig(4, 6)
    const clean = inOneGo(config).result
    // Spoil whichever candidate won, so the winner has to change.
    const scores = []
    for (let candidate = 0; candidate < 4; candidate++) {
      spoil.invalid = (index) => index !== candidate
      const only = officeConfig(4, 4)
      scores.push(inOneGo(only).result.score)
    }
    const winner = scores.indexOf(clean.score)
    expect(winner).toBeGreaterThanOrEqual(0)

    spoil.invalid = (candidate) => candidate === winner
    const whole = inOneGo(config)
    expect(whole.candidates).toBe(4)
    expect(whole.result.score).not.toBe(clean.score)
    expect(inSteps(config)).toBe(4)
    expect(read(config)).toStrictEqual(whole.result)
  })

  it('leaves a budget with no valid plan to the read, which raises the planner error', () => {
    const config = officeConfig(2, 3)
    spoil.invalid = () => true
    clearOfficePlanCache(config)
    expect(() => read(config)).toThrow(/no valid plan in 3 candidates \(district 1,-2\)/)

    // In steps: the whole budget runs, then there is nothing left to step and
    // no step ever throws. The read raises without running a candidate.
    expect(inSteps(config)).toBe(3)
    expect(counting(() => step(config))).toEqual({ result: false, candidates: 0 })
    const failed = counting(() => {
      expect(() => read(config)).toThrow(/no valid plan in 3 candidates \(district 1,-2\)/)
    })
    expect(failed.candidates).toBe(0)

    // A later read starts over, as it always did.
    spoil.invalid = () => false
    expect(counting(() => read(config)).candidates).toBe(2)
  })

  it('leaves a candidate that throws to the read', () => {
    const config = officeConfig(3, 6)
    const whole = inOneGo(config).result

    clearOfficePlanCache(config)
    expect(step(config)).toBe(true)
    spoil.throws = () => true
    expect(step(config)).toBe(false) // swallowed: the step is not where errors surface
    expect(pending(config)).toBe(false)
    expect(() => read(config)).toThrow('candidate blew up')

    spoil.throws = () => false
    expect(read(config)).toStrictEqual(whole)
  })
})

describe('ChunkManager with a district that cannot be planned', () => {
  it('raises from the build, as before, and moves on to the next request', () => {
    const cm = new ChunkManager(new THREE.Scene(), SEED, null, null)
    cm.config = officeConfig(2, 2)
    cm._planStreamingRequests = () => {}
    cm._unloadOutsideStreamingBounds = () => {}
    const built = []
    cm._buildNext = function () {
      const request = this.queue.shift()
      this.queued.delete(request.key)
      generateChunk(this.seed, request.cx, request.cy, request.cz, this.config)
      built.push(request.key)
    }
    const request = (cx, cy, cz) => ({ cx, cy, cz, key: chunkKey3(cx, cy, cz) })
    // Two districts (3x3 chunks each).
    cm.queue.push(request(0, 0, 0), request(6, 0, 0))

    // A still clock: no frame ever looks spent, so each one runs its candidate.
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)

    spoil.invalid = () => true
    const planned = counting(() => {
      cm.update(0, 0, 0)
      cm.update(0, 0, 0)
    })
    expect(planned.candidates).toBe(2) // the whole budget, one per frame, nothing thrown
    expect(cm.queue).toHaveLength(2)
    expect(() => cm.update(0, 0, 0)).toThrow(/no valid plan in 2 candidates/)
    expect(cm.queue.map(({ key }) => key)).toEqual([chunkKey3(6, 0, 0)])
    expect(built).toEqual([])

    spoil.invalid = () => false
    cm.update(0, 0, 0)
    cm.update(0, 0, 0)
    expect(built).toEqual([])
    cm.update(0, 0, 0)
    expect(built).toEqual([chunkKey3(6, 0, 0)])
    clock.mockRestore()
  })
})
