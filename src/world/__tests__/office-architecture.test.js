import { describe, expect, it } from 'vitest'
import { reserveOfficeArchitecture } from '../zones/officeArchitecture.js'
import { buildOfficeDistrictPlan, clearOfficePlanCache } from '../zones/officePlan.js'
import { buildChunk } from '../pipeline.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { CHUNK } from '../constants.js'
import { CELL_CORRIDOR, CELL_LOBBY, CELL_ROOM, COLUMN_FURNITURE } from '../mapTypes.js'

describe('empty office architecture', () => {
  it('preserves a real enclosed office island inside waiting loops', () => {
    // Seed 148 previously let an existing corridor consume the entire island.
    const config = structuredClone(DEFAULT_WORLD_CONFIG)
    let loops = 0
    for (const seed of [1, 4, 7, 13, 42, 148]) {
      const plan = buildOfficeDistrictPlan(seed, 0, 0, config)
      for (const feature of plan.architecture) {
        if (!feature.coreBounds) continue
        loops++
        const { x0, z0, x1, z1 } = feature.coreBounds
        const ids = new Set()
        let walls = 0
        for (let z = z0; z <= z1; z++) {
          for (let x = x0; x <= x1; x++) {
            expect(plan.cellKind[z * plan.size + x]).toBe(CELL_ROOM)
            ids.add(plan.spaceId[z * plan.size + x])
          }
          walls += plan.vAt(x0, z) + plan.vAt(x1 + 1, z)
        }
        for (let x = x0; x <= x1; x++) walls += plan.hAt(x, z0) + plan.hAt(x, z1 + 1)
        expect(ids.size).toBe(1)
        expect(walls).toBeGreaterThanOrEqual((x1 - x0 + z1 - z0 + 4))
      }
    }
    expect(loops).toBeGreaterThan(0)
  })
  it('keeps all three architectural silhouettes connected to existing circulation', () => {
    const kinds = new Set()
    for (let seed = 0; seed < 24; seed++) {
      const size = 42
      const plan = { size, dx: -1, dz: 2, active: new Uint8Array(size * size).fill(1) }
      const corridor = new Uint8Array(size * size)
      for (let z = 0; z < size; z++) corridor[z * size] = CELL_CORRIDOR
      const [architecture] = reserveOfficeArchitecture(plan, corridor, seed)
      kinds.add(architecture.kind)
      const seen = new Set([0])
      const queue = [0]
      for (let head = 0; head < queue.length; head++) {
        const i = queue[head], x = i % size, z = Math.floor(i / size)
        for (const [nx, nz] of [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]]) {
          if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue
          const next = nz * size + nx
          if (corridor[next] && !seen.has(next)) { seen.add(next); queue.push(next) }
        }
      }
      expect(architecture.cells.every(i => seen.has(i))).toBe(true)
      expect(architecture.cells.length).toBeGreaterThanOrEqual(36)
      const { x0, z0, x1, z1 } = architecture.bounds
      const area = (x1 - x0 + 1) * (z1 - z0 + 1)
      expect(architecture.cells.length === area).toBe(architecture.kind === 'emptyBullpen')
    }
    expect([...kinds].sort()).toEqual(['doglegGallery', 'emptyBullpen', 'waitingLoop'])
  })

  it('never overwrites reserved stairs or shafts when a district has no site', () => {
    const size = 28
    const plan = {
      size, dx: 0, dz: 0, active: new Uint8Array(size * size).fill(1),
      stairLobbies: [{ cells: Array.from({ length: size * size }, (_, i) => i) }],
    }
    const corridor = new Uint8Array(size * size)
    corridor[0] = CELL_CORRIDOR
    const before = corridor.slice()
    expect(reserveOfficeArchitecture(plan, corridor, 7)).toEqual([])
    expect(corridor).toEqual(before)
  })

  it('projects empty, wall-free landmarks through real chunk generation and cache eviction', () => {
    const config = structuredClone(DEFAULT_WORLD_CONFIG)
    const seed = 42
    const plan = buildOfficeDistrictPlan(seed, 0, 0, config)
    expect(plan.architecture).toHaveLength(1)
    const feature = structuredClone(plan.architecture[0])
    const reserved = new Set([
      ...plan.stairLobbies.flatMap(lobby => lobby.cells),
      ...plan.multilevelLobbies.flatMap(lobby => lobby.cells),
    ])
    const cells = new Set(feature.cells)
    const chunks = new Map()
    for (const i of cells) {
      expect(reserved.has(i)).toBe(false)
      expect(plan.cellKind[i]).toBe(CELL_LOBBY)
      const x = i % plan.size, z = Math.floor(i / plan.size)
      const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK)
      const key = `${cx},${cz}`
      if (!chunks.has(key)) chunks.set(key, buildChunk(seed, cx, 0, cz, config))
      const data = chunks.get(key)
      const lx = x % CHUNK, lz = z % CHUNK, local = lz * CHUNK + lx
      expect(data.cellKind[local]).toBe(CELL_LOBBY)
      expect(data.cols[local]).not.toBe(COLUMN_FURNITURE)
      if (x > 0 && cells.has(i - 1)) expect(data.vAt(lx, lz)).toBe(0)
      if (z > 0 && cells.has(i - plan.size)) expect(data.hAt(lx, lz)).toBe(0)
    }
    plan.architecture[0].cells.length = 0
    plan.architecture[0].bounds.x0 = -100
    expect(buildOfficeDistrictPlan(seed, 0, 0, config).architecture[0]).toEqual(feature)
    clearOfficePlanCache(config)
    expect(buildOfficeDistrictPlan(seed, 0, 0, config).architecture[0]).toEqual(feature)
  })
})
