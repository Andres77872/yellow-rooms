import { describe, it, expect } from 'vitest'
import { buildOfficeDistrictPlan } from '../zones/officePlan.js'
import { buildChunk } from '../pipeline.js'
import { ChunkData } from '../ChunkData.js'
import { placeFurniture, FURN_RACK, FURN_CABINET, FURN_COPIER, FURN_COOLER, FURN_TABLE, FURN_BOOKSHELF } from '../furniture.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { CHUNK, ZONE_OFFICE } from '../constants.js'
import {
  CELL_ROOM,
  SPACE_ROLE_NONE,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_COPY,
  SPACE_ROLE_ARCHIVE,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
  PASSAGE_DOOR,
} from '../mapTypes.js'

const cfg = structuredClone(DEFAULT_WORLD_CONFIG)

describe('office space roles', () => {
  it('assigns deterministic roles per district space', () => {
    const a = buildOfficeDistrictPlan(12345, 0, 0, cfg)
    const b = buildOfficeDistrictPlan(12345, 0, 0, cfg)
    expect(a.spaces.map((s) => s.role ?? 0)).toEqual(b.spaces.map((s) => s.role ?? 0))
    expect(a.roleGrid).toEqual(b.roleGrid)
  })

  it('keeps the grammar sparse and size-aware across districts', () => {
    const counts = new Map()
    let rooms = 0
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const plan = buildOfficeDistrictPlan(777, dx, dz, cfg)
        for (const s of plan.spaces) {
          if (s.type !== 'room') continue
          rooms++
          const role = s.role ?? SPACE_ROLE_NONE
          counts.set(role, (counts.get(role) ?? 0) + 1)
          // Size contract: meeting/server/break only in genuinely large rooms.
          if ([SPACE_ROLE_MEETING, SPACE_ROLE_SERVER].includes(role)) {
            expect(s.area).toBeGreaterThanOrEqual(20)
          }
        }
      }
    }
    const none = counts.get(SPACE_ROLE_NONE) ?? 0
    expect(none / rooms).toBeGreaterThan(0.5) // most rooms stay ordinary
    // Every special family shows up somewhere in a 5x5-district corpus.
    for (const role of [SPACE_ROLE_MEETING, SPACE_ROLE_BREAK, SPACE_ROLE_COPY, SPACE_ROLE_ARCHIVE, SPACE_ROLE_SERVER, SPACE_ROLE_STORAGE]) {
      expect(counts.get(role) ?? 0, `role ${role} present`).toBeGreaterThan(0)
    }
  })

  it('marks exactly the space\'s own cells in the role grid', () => {
    const plan = buildOfficeDistrictPlan(4242, 1, 0, cfg)
    const byId = new Map(plan.spaces.map((s) => [s.id, s]))
    for (let i = 0; i < plan.roleGrid.length; i++) {
      const space = byId.get(plan.spaceId[i])
      const expected = space?.type === 'room' ? (space.role ?? SPACE_ROLE_NONE) : SPACE_ROLE_NONE
      expect(plan.roleGrid[i]).toBe(expected)
    }
  })

  it('compiles the role grid into chunk data identically per slice', () => {
    const a = buildChunk(999, 0, 0, 0, cfg)
    const b = buildChunk(999, 0, 0, 0, cfg)
    expect(a.spaceRole).toEqual(b.spaceRole)
    // Roles only ever ride on real rooms.
    for (let i = 0; i < a.spaceRole.length; i++) {
      if (a.spaceRole[i] !== SPACE_ROLE_NONE) expect(a.cellKind[i]).toBe(CELL_ROOM)
    }
  })
})

describe('role-driven furnishing', () => {
  function roomWithRole(role, x0 = 3, z0 = 3, x1 = 10, z1 = 10) {
    const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
    for (let x = x0; x <= x1; x++) {
      data.setH(x, z0, 1)
      data.setH(x, z1 + 1, 1)
    }
    for (let z = z0; z <= z1; z++) {
      data.setV(x0, z, 1)
      data.setV(x1 + 1, z, 1)
    }
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const i = z * CHUNK + x
        data.cellKind[i] = CELL_ROOM
        data.spaceId[i] = 7
        data.spaceRole[i] = role
      }
    }
    data.setPassageV(x0, (z0 + z1) >> 1, PASSAGE_DOOR)
    return data
  }

  const ctx = { zone: ZONE_OFFICE, config: structuredClone(DEFAULT_WORLD_CONFIG) }
  const kinds = (data) => data.furniture.map((f) => f.kind)

  it('stacks a server room with racks and nothing else', () => {
    const data = roomWithRole(SPACE_ROLE_SERVER)
    placeFurniture(data, ctx)
    expect(data.furniture.length).toBeGreaterThan(0)
    expect(new Set(kinds(data))).toEqual(new Set([FURN_RACK]))
  })

  it('lines an archive with book rows and an occasional cabinet', () => {
    const data = roomWithRole(SPACE_ROLE_ARCHIVE)
    placeFurniture(data, ctx)
    expect(data.furniture.length).toBeGreaterThan(0)
    const set = new Set(kinds(data))
    expect(set.has(FURN_BOOKSHELF)).toBe(true)
    for (const k of set) expect([FURN_BOOKSHELF, FURN_CABINET]).toContain(k)
  })

  it('fills a copy room with copiers (and at most one cabinet)', () => {
    const data = roomWithRole(SPACE_ROLE_COPY)
    placeFurniture(data, ctx)
    const set = new Set(kinds(data))
    expect(set.has(FURN_COPIER)).toBe(true)
    for (const k of set) expect([FURN_COPIER, FURN_CABINET]).toContain(k)
  })

  it('always gives the break room its water cooler', () => {
    const data = roomWithRole(SPACE_ROLE_BREAK)
    placeFurniture(data, ctx)
    expect(kinds(data)).toContain(FURN_COOLER)
  })

  it('seats a meeting room around a conference table', () => {
    const data = roomWithRole(SPACE_ROLE_MEETING)
    placeFurniture(data, ctx)
    expect(kinds(data)).toContain(FURN_TABLE)
  })
})
