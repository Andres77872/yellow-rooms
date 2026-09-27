import { describe, expect, it } from 'vitest'
import { CHUNK, ZONE_OFFICE } from '../constants.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { CELL_CORRIDOR, CELL_LOBBY, CELL_VOID } from '../mapTypes.js'
import { buildChunk, layerSeed } from '../pipeline.js'
import { structureAt } from '../structures/contract.js'
import { buildOfficeDistrictPlan, clearOfficePlanCache } from '../zones/officePlan.js'

const families = ['tower', 'lattice']
const circulation = (kind) => kind === CELL_CORRIDOR || kind === CELL_LOBBY
function configFor(family, mixed = false) {
  const config = worldConfigForFamily(family, DEFAULT_WORLD_CONFIG)
  if (!mixed) config.zoneBands = [{ id: ZONE_OFFICE, max: 1.01 }]
  config.furniture.enabled = false
  return config
}

function reachable(plan, start, onlyCirculation = false, ignoreWalls = false) {
  const seen = new Set([start])
  const queue = [start]
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]
    const x = i % plan.size
    const z = Math.floor(i / plan.size)
    for (const [nx, nz, wall] of [
      [x - 1, z, plan.vAt(x, z)],
      [x + 1, z, x + 1 < plan.size ? plan.vAt(x + 1, z) : 1],
      [x, z - 1, plan.hAt(x, z)],
      [x, z + 1, z + 1 < plan.size ? plan.hAt(x, z + 1) : 1],
    ]) {
      if (nx < 0 || nz < 0 || nx >= plan.size || nz >= plan.size || (wall && !ignoreWalls)) continue
      const next = nz * plan.size + nx
      if (seen.has(next) || !plan.active[next] || (onlyCirculation && !circulation(plan.cellKind[next]))) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

function verifyConnectedIslands(plan) {
  const checked = new Set()
  for (let i = 0; i < plan.active.length; i++) {
    if (!plan.active[i] || checked.has(i)) continue
    const island = reachable(plan, i, false, true)
    expect(reachable(plan, i).size).toBe(island.size)
    const hall = [...island].filter((cell) => circulation(plan.cellKind[cell]))
    expect(hall.length).toBeGreaterThan(0)
    expect(reachable(plan, hall[0], true).size).toBe(hall.length)
    for (const cell of island) checked.add(cell)
  }
}

describe('Tower and Lattice solid-floor architecture', () => {
  it.each(families)('gives %s its own ground plan without any canonical vertical structure or furniture', (family) => {
    const seed = 0xad7c44d0
    const config = configFor(family)
    const office = configFor('office')
    const changed = []
    for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      expect(structureAt(seed, cx, cz, 0, config).hasRoom).toBe(false)
      const data = buildChunk(seed, cx, 0, cz, config)
      const ordinary = buildChunk(seed, cx, 0, cz, office)
      expect(data.furniture).toHaveLength(0)
      expect(data.cellKind).not.toContain(CELL_VOID)
      expect(data.structure?.hasRoom ?? false).toBe(false)
      let difference = 0
      for (let i = 0; i < CHUNK * CHUNK; i++) {
        difference += Number(data.wallV[i] !== ordinary.wallV[i]) + Number(data.wallH[i] !== ordinary.wallH[i])
      }
      changed.push(difference)
    }
    expect(changed.every((count) => count > CHUNK * CHUNK * 0.1)).toBe(true)
  })

  it.each(families)('reserves visible %s circulation forms and varies them between districts', (family) => {
    const config = configFor(family)
    const variants = new Set()
    const axes = new Set()
    for (const seed of [1, 2, 3, 4, 5, 6, 42, 777]) {
      const plan = buildOfficeDistrictPlan(seed, -1, 2, config)
      expect(plan.architecture.length).toBeGreaterThan(0)
      for (const item of plan.architecture) {
        expect(item.kind.startsWith(`${family}-`)).toBe(true)
        variants.add(item.variant)
        axes.add(item.axis)
        for (const cell of item.cells) expect(circulation(plan.cellKind[cell])).toBe(true)
      }
      const focal = plan.architecture.filter((item) => item.kind === (family === 'tower' ? 'tower-axial-hall' : 'lattice-transfer-plaza'))
      expect(focal.length).toBeGreaterThan(0)
      expect(focal.some((item) => item.cells.length >= 25)).toBe(true)
      verifyConnectedIslands(plan)
    }
    expect(variants.size).toBe(3)
    expect(axes.size).toBe(2)
    const first = buildOfficeDistrictPlan(777, -1, 2, config)
    clearOfficePlanCache(config)
    expect(buildOfficeDistrictPlan(777, -1, 2, config)).toEqual(first)
  })

  it.each(families)('keeps clipped %s islands, portals, and circulation connected across signed districts', (family) => {
    const config = configFor(family, true)
    for (const seed of [1, 42, 777, 0xc0ffee]) {
      for (const cy of [-1, 0, 2]) {
        for (const [dx, dz] of [[0, 0], [-1, -1], [1, -2]]) {
          const plan = buildOfficeDistrictPlan(layerSeed(seed, cy), dx, dz, config, { rootSeed: seed, cy })
          expect(plan.metrics.invalidRooms).toBe(0)
          expect(plan.metrics.unsupportedDoors).toBe(0)
          expect(plan.metrics.portalMisses).toBe(0)
          verifyConnectedIslands(plan)
        }
      }
    }
  })
})
