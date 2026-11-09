import { describe, expect, it } from 'vitest'
import { ZONE_OFFICE } from '../constants.js'
import { forcedFamilyConfig } from '../families/forced.js'
import { generateChunk } from '../generate.js'
import { worldConfigForFamily } from '../mapFamily.js'
import {
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
} from '../mapTypes.js'
import { chunkPlanPending, layerSeed, stepChunkPlan } from '../pipeline.js'
import {
  buildOfficeDistrictPlan,
  clearOfficePlanCache,
  officeDistrictPlanPending,
  officePlanCandidatesBuilt,
  stepOfficeDistrictPlan,
} from '../zones/officePlan.js'
import { selectZone } from '../zones/regions.js'
import { digestChunk } from './support/chunkDigest.js'

// Streaming plans a district one candidate per frame instead of all at once
// inside the first chunk build (ChunkManager.update). The world must not
// notice: a plan built in steps is the plan built in one go, and a chunk built
// behind it is the same chunk.

const PLANNED_FAMILIES = [
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_TOWER,
  MAP_FAMILY_LATTICE,
]
// [root seed, district x, district z, floor]: positive and negative districts,
// the spawn district, and floors with their own layer seed.
const CASES = [
  [1, 0, 0, 0],
  [1, -2, 3, 2],
  [0x0ff1ce, 5, -1, 0],
  [0x0ff1ce, -4, -4, -1],
  [0x51ea7, 2, 2, 1],
  [0x51ea7, 0, -3, 0],
]

// The seed and context a chunk build hands the planner for floor `cy`.
function layerArgs(rootSeed, cy) {
  const lseed = layerSeed(rootSeed, cy)
  return [lseed, { rootSeed: rootSeed >>> 0, layerSeed: lseed, cy }]
}

function counting(fn) {
  const before = officePlanCandidatesBuilt()
  const result = fn()
  return { result, candidates: officePlanCandidatesBuilt() - before }
}

function planInOneGo(config, [rootSeed, dx, dz, cy]) {
  const [lseed, ctx] = layerArgs(rootSeed, cy)
  clearOfficePlanCache(config)
  const { result, candidates } = counting(() => buildOfficeDistrictPlan(lseed, dx, dz, config, ctx))
  return { plan: result, candidates }
}

// Step a cold plan to the end; the read that follows must find it cached.
function planInSteps(config, [rootSeed, dx, dz, cy]) {
  const [lseed, ctx] = layerArgs(rootSeed, cy)
  clearOfficePlanCache(config)
  let steps = 0
  while (officeDistrictPlanPending(lseed, dx, dz, config, ctx)) {
    const step = counting(() => stepOfficeDistrictPlan(lseed, dx, dz, config, ctx))
    expect(step.candidates).toBe(1)
    if (++steps > 64) throw new Error('stepped plan never finished')
  }
  const read = counting(() => buildOfficeDistrictPlan(lseed, dx, dz, config, ctx))
  expect(read.candidates).toBe(0)
  return { plan: read.result, steps }
}

describe.each(PLANNED_FAMILIES)('district plan in steps: %s', (family) => {
  const config = worldConfigForFamily(family)

  it('is the plan built in one go, candidate for candidate', () => {
    for (const planCase of CASES) {
      const whole = planInOneGo(config, planCase)
      const stepped = planInSteps(config, planCase)
      expect(stepped.steps, `candidates of ${planCase}`).toBe(whole.candidates)
      expect(stepped.plan, `plan of ${planCase}`).toStrictEqual(whole.plan)
    }
  })

  it('does not depend on which district each step went to', () => {
    const trio = CASES.slice(0, 3)
    const whole = trio.map((planCase) => planInOneGo(config, planCase).plan)
    clearOfficePlanCache(config)
    const args = trio.map(([rootSeed, dx, dz, cy]) => [layerArgs(rootSeed, cy), dx, dz])
    // Round robin, the way a re-sorted queue hands the head to another
    // district before the first one is done.
    let pending = true
    while (pending) {
      pending = false
      for (const [[lseed, ctx], dx, dz] of args) {
        if (stepOfficeDistrictPlan(lseed, dx, dz, config, ctx)) pending = true
      }
    }
    args.forEach(([[lseed, ctx], dx, dz], i) => {
      const read = counting(() => buildOfficeDistrictPlan(lseed, dx, dz, config, ctx))
      expect(read.candidates).toBe(0)
      expect(read.result).toStrictEqual(whole[i])
    })
  })

  it('a read finishes a plan that steps started instead of starting over', () => {
    const [rootSeed, dx, dz, cy] = CASES[1]
    const [lseed, ctx] = layerArgs(rootSeed, cy)
    const whole = planInOneGo(config, CASES[1])
    expect(whole.candidates).toBeGreaterThan(2)

    clearOfficePlanCache(config)
    expect(stepOfficeDistrictPlan(lseed, dx, dz, config, ctx)).toBe(true)
    expect(stepOfficeDistrictPlan(lseed, dx, dz, config, ctx)).toBe(true)
    // Level load (ChunkManager.prewarm) reads plans synchronously.
    const read = counting(() => buildOfficeDistrictPlan(lseed, dx, dz, config, ctx))
    expect(read.candidates).toBe(whole.candidates - 2)
    expect(read.result).toStrictEqual(whole.plan)
    expect(officeDistrictPlanPending(lseed, dx, dz, config, ctx)).toBe(false)
    expect(counting(() => stepOfficeDistrictPlan(lseed, dx, dz, config, ctx))).toEqual({
      result: false,
      candidates: 0,
    })
  })
})

describe('district plan in steps: candidate pool', () => {
  it.each([1, 2, 6])('runs exactly the base pool of %i candidates', (planCandidates) => {
    for (const family of [MAP_FAMILY_OFFICE, MAP_FAMILY_HOTEL]) {
      const config = worldConfigForFamily(family)
      config.office.planCandidates = planCandidates
      const whole = planInOneGo(config, CASES[2])
      const stepped = planInSteps(config, CASES[2])
      expect(whole.candidates).toBe(planCandidates)
      expect(stepped.steps).toBe(planCandidates)
      expect(stepped.plan).toStrictEqual(whole.plan)
    }
  })

  it('drops a started plan when the config changes in place', () => {
    const config = worldConfigForFamily(MAP_FAMILY_OFFICE)
    const [lseed, ctx] = layerArgs(7, 0)
    expect(stepOfficeDistrictPlan(lseed, 1, 1, config, ctx)).toBe(true)
    config.office.braid = 0.6
    const fresh = structuredClone(config)
    const read = counting(() => buildOfficeDistrictPlan(lseed, 1, 1, config, ctx))
    // Every candidate again: none of the old config's candidates is reused.
    expect(read.candidates).toBe(config.office.planCandidates)
    expect(read.result).toStrictEqual(buildOfficeDistrictPlan(lseed, 1, 1, fresh, ctx))
  })
})

// A chunk's full generated state, including the planner fields the golden
// digest does not fold.
function chunkState(data) {
  return {
    digest: digestChunk(data),
    spaceClass: Array.from(data.spaceClass),
    district: data.district,
    seam: data.seam?.resolve() ?? null,
  }
}

// Chunks around the first few non-office chunks of the floor: there the seam
// contracts meet other zones, and the non-office chunks themselves must not
// ask for a plan.
function zoneEdgeChunks(seed, config, limit) {
  const out = []
  for (let cz = -10; cz <= 10 && out.length < limit; cz++) {
    for (let cx = -10; cx <= 10 && out.length < limit; cx++) {
      if (selectZone(cx, cz, seed, config) === ZONE_OFFICE) continue
      out.push([cx, 0, cz], [cx - 1, 0, cz], [cx, 0, cz + 1])
    }
  }
  return out
}

describe('chunk builds behind a stepped plan', () => {
  const seed = 0x5eed01
  const CHUNKS = [
    [0, 0, 0],
    [1, 0, 0], // same district as the spawn chunk
    [4, 0, -3],
    [-6, 1, 2],
    [9, -1, 9],
  ]

  it.each(PLANNED_FAMILIES)('%s: same chunk, and the build plans nothing', (family) => {
    const config = worldConfigForFamily(family)
    const chunks = [...CHUNKS, ...zoneEdgeChunks(seed, config, 6)]
    let planned = 0
    for (const [cx, cy, cz] of chunks) {
      const where = `${family} chunk ${cx},${cy},${cz}`
      clearOfficePlanCache(config)
      const whole = counting(() => generateChunk(seed, cx, cy, cz, config))

      clearOfficePlanCache(config)
      let steps = 0
      while (chunkPlanPending(seed, cx, cy, cz, config)) {
        stepChunkPlan(seed, cx, cy, cz, config)
        if (++steps > 64) throw new Error('stepped plan never finished')
      }
      // The steps ran every candidate the build would have, so the build
      // runs none: nothing it reads is left unplanned.
      expect(steps, where).toBe(whole.candidates)
      const stepped = counting(() => generateChunk(seed, cx, cy, cz, config))
      expect(stepped.candidates, where).toBe(0)
      expect(chunkState(stepped.result), where).toEqual(chunkState(whole.result))
      if (steps) planned++
    }
    // The sample holds both kinds: office slices, and other zones' chunks.
    expect(planned).toBeGreaterThanOrEqual(CHUNKS.length)
    expect(planned).toBeLessThan(chunks.length)
  })

  it('one district plan serves every chunk of the district', () => {
    const config = worldConfigForFamily(MAP_FAMILY_OFFICE)
    while (chunkPlanPending(seed, 0, 0, 0, config)) stepChunkPlan(seed, 0, 0, 0, config)
    // (1, 0, 1) shares the 3x3 district of the spawn chunk.
    expect(chunkPlanPending(seed, 1, 0, 1, config)).toBe(false)
    expect(counting(() => generateChunk(seed, 1, 0, 1, config)).candidates).toBe(0)
    // Another floor of the same column is another plan.
    expect(chunkPlanPending(seed, 1, 1, 1, config)).toBe(true)
  })

  it('families that read no district plan never ask for one', () => {
    for (const config of [worldConfigForFamily(MAP_FAMILY_SEWER), forcedFamilyConfig('stairwell')]) {
      for (const [cx, cy, cz] of CHUNKS) {
        expect(chunkPlanPending(seed, cx, cy, cz, config)).toBe(false)
        expect(stepChunkPlan(seed, cx, cy, cz, config)).toBe(false)
        expect(counting(() => generateChunk(seed, cx, cy, cz, config)).candidates).toBe(0)
      }
    }
  })

  it('leaves a config the build rejects to the build', () => {
    const config = worldConfigForFamily(MAP_FAMILY_OFFICE)
    config.mapFamily.selected = 'no-such-family'
    expect(chunkPlanPending(seed, 0, 0, 0, config)).toBe(false)
    expect(() => generateChunk(seed, 0, 0, 0, config)).toThrow()
  })
})
