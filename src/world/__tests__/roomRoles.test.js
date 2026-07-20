import { describe, it, expect } from 'vitest'
import { buildOfficeDistrictPlan } from '../zones/officePlan.js'
import { buildChunk } from '../pipeline.js'
import { ChunkData } from '../ChunkData.js'
import {
  placeFurniture,
  FURN_DESK,
  FURN_CHAIR,
  FURN_TABLE,
  FURN_CABINET,
  FURN_COPIER,
  FURN_COOLER,
  FURN_PLANT,
  FURN_RACK,
  FURN_SOFA,
  FURN_BOOKSHELF,
  FURN_WHITEBOARD,
} from '../furniture.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { CHUNK, FURN_MARGIN, ZONE_OFFICE } from '../constants.js'
import {
  CELL_ROOM,
  COLUMN_FURNITURE,
  SPACE_ROLE_NONE,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_COPY,
  SPACE_ROLE_ARCHIVE,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
  PASSAGE_DOOR,
  PASSAGE_WIDE,
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

// Room/furniture coherence invariants (v21): a room's architectural claims —
// its role band, its theme — must always be backed by the furniture in it.
describe('room coherence', () => {
  const ROLE_ANCHOR = {
    [SPACE_ROLE_MEETING]: FURN_TABLE,
    [SPACE_ROLE_BREAK]: FURN_COOLER,
    [SPACE_ROLE_COPY]: FURN_COPIER,
    [SPACE_ROLE_ARCHIVE]: FURN_BOOKSHELF,
    [SPACE_ROLE_SERVER]: FURN_RACK,
    [SPACE_ROLE_STORAGE]: FURN_CABINET,
  }
  const ROLE_WHITELIST = {
    [SPACE_ROLE_MEETING]: new Set([FURN_TABLE, FURN_CHAIR, FURN_WHITEBOARD]),
    [SPACE_ROLE_BREAK]: new Set([FURN_COOLER, FURN_SOFA, FURN_TABLE, FURN_CHAIR, FURN_CABINET, FURN_PLANT]),
    [SPACE_ROLE_COPY]: new Set([FURN_COPIER, FURN_CABINET]),
    [SPACE_ROLE_ARCHIVE]: new Set([FURN_BOOKSHELF, FURN_CABINET]),
    [SPACE_ROLE_SERVER]: new Set([FURN_RACK]),
    [SPACE_ROLE_STORAGE]: new Set([FURN_CABINET]),
  }
  // One theme per ordinary room: huddle, workroom, lounge, or stash.
  const ORDINARY_THEMES = [
    new Set([FURN_TABLE, FURN_CHAIR, FURN_WHITEBOARD]),
    new Set([FURN_DESK, FURN_CHAIR, FURN_CABINET, FURN_PLANT]),
    new Set([FURN_SOFA, FURN_PLANT]),
    new Set([FURN_CABINET]),
  ]
  const ROLE_MARKERS = new Set([FURN_COPIER, FURN_RACK, FURN_BOOKSHELF, FURN_COOLER])

  // Mirror of the furnishing candidate contract, with already-placed furniture
  // counted as free (the pre-placement view of the built chunk).
  function sliceCapability(data, id) {
    const lampCells = new Set(data.lamps.map((l) => `${l.lx},${l.lz}`))
    let candidates = 0
    let wallCandidates = 0
    for (let z = FURN_MARGIN; z < CHUNK - FURN_MARGIN; z++) {
      for (let x = FURN_MARGIN; x < CHUNK - FURN_MARGIN; x++) {
        const i = z * CHUNK + x
        if (data.cellKind[i] !== CELL_ROOM || data.spaceId[i] !== id) continue
        const col = data.colAt(x, z)
        if (col && col !== COLUMN_FURNITURE) continue
        if (data.hasFloorHole(x, z) || data.hasCeilHole(x, z)) continue
        if (lampCells.has(`${x},${z}`)) continue
        const edges = [
          { wall: data.vAt(x, z), passage: data.passageVAt(x, z) },
          { wall: x + 1 < CHUNK ? data.vAt(x + 1, z) : 1, passage: x + 1 < CHUNK ? data.passageVAt(x + 1, z) : 0 },
          { wall: data.hAt(x, z), passage: data.passageHAt(x, z) },
          { wall: z + 1 < CHUNK ? data.hAt(x, z + 1) : 1, passage: z + 1 < CHUNK ? data.passageHAt(x, z + 1) : 0 },
        ]
        if (edges.some((e) => e.passage === PASSAGE_DOOR || e.passage === PASSAGE_WIDE)) continue
        candidates++
        if (edges.some((e) => e.wall === 1)) wallCandidates++
      }
    }
    return { candidates, wallCandidates }
  }

  it('always backs a role room with its anchor piece and only whitelisted kinds', () => {
    const districtChunks = cfg.office.districtChunks
    // room key -> {role, kinds, capable}, aggregated across chunk slices
    const rooms = new Map()
    for (const seed of [777, 31337]) {
      for (let cx = -4; cx <= 4; cx++) {
        for (let cz = -4; cz <= 4; cz++) {
          const data = buildChunk(seed, cx, 0, cz, cfg)
          if (data.zone !== ZONE_OFFICE) continue
          const seen = new Set()
          const kindsBySpace = new Map()
          for (const f of data.furniture) {
            const id = data.spaceId[f.lz * CHUNK + f.lx]
            if (!kindsBySpace.has(id)) kindsBySpace.set(id, new Set())
            kindsBySpace.get(id).add(f.kind)
          }
          for (let i = 0; i < data.spaceId.length; i++) {
            if (data.cellKind[i] !== CELL_ROOM) continue
            const id = data.spaceId[i]
            if (!id || seen.has(id)) continue
            seen.add(id)
            // Space ids are unique per district only — key by district too.
            const key = `${seed}:${Math.floor(cx / districtChunks)},${Math.floor(cz / districtChunks)}:${id}`
            if (!rooms.has(key)) {
              rooms.set(key, { role: data.spaceRole[i], kinds: new Set(), candidates: 0, wallCandidates: 0 })
            }
            const room = rooms.get(key)
            const capability = sliceCapability(data, id)
            if (capability.candidates >= 3) {
              room.candidates = Math.max(room.candidates, capability.candidates)
              room.wallCandidates = Math.max(room.wallCandidates, capability.wallCandidates)
            }
            for (const kind of kindsBySpace.get(id) ?? []) room.kinds.add(kind)
          }
        }
      }
    }

    let roleRooms = 0
    let ordinaryFurnished = 0
    for (const [key, room] of rooms) {
      if (room.role !== SPACE_ROLE_NONE) {
        // Whitelist: nothing outside the role's grammar, ever.
        for (const kind of room.kinds) {
          expect(ROLE_WHITELIST[room.role].has(kind), `${key} kind ${kind} in role ${room.role}`).toBe(true)
        }
        // Anchor guarantee: any room with a furnishable slice holds its anchor.
        const anchor = ROLE_ANCHOR[room.role]
        const needsWall = anchor !== FURN_TABLE
        const capable = room.candidates >= 3 && (!needsWall || room.wallCandidates >= 1)
        if (capable) {
          roleRooms++
          expect(room.kinds.has(anchor), `${key} role ${room.role} anchor`).toBe(true)
        }
      } else if (room.kinds.size) {
        ordinaryFurnished++
        // Theme coherence: the whole room fits ONE ordinary theme, and the
        // role-marker kinds never leak into unmarked rooms.
        for (const kind of room.kinds) {
          expect(ROLE_MARKERS.has(kind), `${key} role marker ${kind} in ordinary room`).toBe(false)
        }
        const fitsOneTheme = ORDINARY_THEMES.some((theme) =>
          [...room.kinds].every((kind) => theme.has(kind))
        )
        expect(fitsOneTheme, `${key} kinds ${[...room.kinds]}`).toBe(true)
      }
    }
    // The corpus must actually exercise the invariants.
    expect(roleRooms).toBeGreaterThan(30)
    expect(ordinaryFurnished).toBeGreaterThan(100)
  })

  it('never leaves a role band on promoted circulation', () => {
    for (const seed of [12345, 777, 4242]) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const plan = buildOfficeDistrictPlan(seed, dx, dz, cfg)
          const byId = new Map(plan.spaces.map((s) => [s.id, s]))
          for (let i = 0; i < plan.roleGrid.length; i++) {
            if (!plan.roleGrid[i]) continue
            const space = byId.get(plan.spaceId[i])
            expect(space?.type, `${seed}:${dx},${dz} role cell on ${space?.type}`).toBe('room')
          }
        }
      }
    }
  })
})
