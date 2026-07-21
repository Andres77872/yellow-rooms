import { describe, it, expect } from 'vitest'
import { buildOfficeDistrictPlan } from '../zones/officePlan.js'
import { buildChunk } from '../pipeline.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { ZONE_OFFICE, CHUNK } from '../constants.js'
import { countChunkComponents } from '../topology.js'
import {
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  CELL_ROOM,
  SPACE_ROLE_NONE,
  SPACE_ROLE_ARCHIVE,
  SPACE_ROLE_BEDROOM,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_COPY,
  SPACE_ROLE_LIBRARY,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_OFFICE,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
} from '../mapTypes.js'
import {
  FAMILY_ORDINARY_THEMES,
  FAMILY_ROOM_CATALOGS,
  FURN_BED,
  FURN_CABINET,
  FURN_CHAIR,
  FURN_COOLER,
  FURN_COPIER,
  FURN_DESK,
  FURN_RACK,
  FURN_TABLE,
  FURN_WHITEBOARD,
  ORDINARY_THEMES,
  ROLE_MARKER_KINDS,
  ROOM_TYPES,
  ordinaryThemesFor,
} from '../rooms/catalog.js'

const cfg = structuredClone(DEFAULT_WORLD_CONFIG)

// The v22 room layer: per-family catalogs, procedural room shapes, and the
// iterative plan-candidate loop. These pin the CONTRACTS of the rooms module;
// byte-level output is pinned by the golden tables in generate.test.js.
describe('room catalog integrity', () => {
  it('backs every electable role with a complete room type', () => {
    for (const [family, catalog] of Object.entries(FAMILY_ROOM_CATALOGS)) {
      const electable = new Set(
        Object.values(catalog.election).flat().map((entry) => entry.role)
      )
      for (const role of electable) {
        const type = ROOM_TYPES[role]
        expect(type, `${family} role ${role} has a room type`).toBeTruthy()
        // The anchor must be whitelisted, and the grammar's first landing
        // pieces must all be whitelisted (whitelist-strict by construction —
        // here we check the declaration is self-consistent).
        expect(type.whitelist, `${family}/${type.key} anchor whitelisted`)
          .toContain(type.anchor)
        // Every electable role draws from the district quota table.
        expect(catalog.quotas[role], `${family}/${type.key} quota`).toBeGreaterThan(0)
      }
      // Quotas without an election entry would be dead config.
      for (const role of Object.keys(catalog.quotas)) {
        expect(electable.has(Number(role)), `${family} quota ${role} electable`).toBe(true)
      }
    }
  })

  it('keeps role-marker kinds out of every ordinary theme, in every family set', () => {
    const markers = new Set(ROLE_MARKER_KINDS)
    const themeSets = [ORDINARY_THEMES, ...Object.values(FAMILY_ORDINARY_THEMES)]
    for (const themes of themeSets) {
      for (const theme of themes) {
        for (const op of theme.grammar) {
          if (op.kind !== undefined) {
            expect(markers.has(op.kind), `theme ${theme.key} kind ${op.kind}`).toBe(false)
          }
        }
      }
    }
  })

  it('keeps the election vocabulary out of the district-less sewer family', () => {
    // Sewer chambers roll SEWER_CHAMBER_CATALOG at stamp time instead — no
    // district plan exists to elect over, so the family catalog stays empty.
    const catalog = FAMILY_ROOM_CATALOGS[MAP_FAMILY_SEWER]
    expect(Object.keys(catalog.quotas)).toHaveLength(0)
    expect(Object.values(catalog.election).flat()).toHaveLength(0)
    // Lattice decks are bare, but the office shell around them elects a
    // maintenance mix (v23): the catalog is small and infrastructure-only.
    const lattice = FAMILY_ROOM_CATALOGS[MAP_FAMILY_LATTICE]
    const electable = new Set(
      Object.values(lattice.election).flat().map((entry) => entry.role)
    )
    expect(electable.size).toBeGreaterThan(0)
    for (const role of electable) {
      expect(
        [SPACE_ROLE_SERVER, SPACE_ROLE_ARCHIVE, SPACE_ROLE_STORAGE].includes(role),
        `lattice role ${role} stays infrastructural`
      ).toBe(true)
    }
  })
})

describe('per-family room election', () => {
  const electedRoles = (config, seed = 777, span = 2) => {
    const roles = new Set()
    for (let dx = -span; dx <= span; dx++) {
      for (let dz = -span; dz <= span; dz++) {
        const plan = buildOfficeDistrictPlan(seed, dx, dz, config)
        for (const s of plan.spaces) {
          if (s.type === 'room' && s.role) roles.add(s.role)
        }
      }
    }
    return roles
  }

  it('fills every catalog quota whenever the district geometry can host it', () => {
    // The v23 backstop pass: election windows decide WHICH rooms volunteer,
    // never WHETHER the floor reaches its institutional mix. Under-fills left
    // after the backstop are genuinely geometry-gated (a district with no
    // large room cannot host its meeting quota) — across an 81-district
    // corpus those stay vanishingly rare.
    for (const family of [MAP_FAMILY_OFFICE, MAP_FAMILY_TOWER, MAP_FAMILY_LATTICE, MAP_FAMILY_HOTEL]) {
      const config = family === MAP_FAMILY_OFFICE ? cfg : worldConfigForFamily(family, cfg)
      const quotas = FAMILY_ROOM_CATALOGS[family].quotas
      const misses = new Map()
      let districts = 0
      for (let dx = -4; dx <= 4; dx++) {
        for (let dz = -4; dz <= 4; dz++) {
          const plan = buildOfficeDistrictPlan(777, dx, dz, config)
          districts++
          const counts = new Map()
          for (const s of plan.spaces) {
            if (s.type === 'room' && s.role) counts.set(s.role, (counts.get(s.role) ?? 0) + 1)
          }
          for (const [role, quota] of Object.entries(quotas)) {
            if ((counts.get(Number(role)) ?? 0) < quota) {
              misses.set(role, (misses.get(role) ?? 0) + 1)
            }
          }
        }
      }
      for (const [role, count] of misses) {
        expect(
          count / districts,
          `${family} role ${role} under-filled in ${count}/${districts} districts`
        ).toBeLessThan(0.05)
      }
    }
  })

  it('office districts elect only office-catalog roles, and all of them', () => {
    const allowed = new Set(
      Object.values(FAMILY_ROOM_CATALOGS[MAP_FAMILY_OFFICE].election)
        .flat().map((e) => e.role)
    )
    const roles = electedRoles(cfg)
    for (const role of roles) expect(allowed.has(role), `office role ${role}`).toBe(true)
    // The corpus is big enough that every catalog role appears (incl. the
    // v22 additions — library, private office, lounge).
    for (const role of allowed) expect(roles.has(role), `office elects ${role}`).toBe(true)
  })

  it('tower districts elect the infrastructure mix, never the office-only roles', () => {
    const towerConfig = worldConfigForFamily(MAP_FAMILY_TOWER, cfg)
    const allowed = new Set(
      Object.values(FAMILY_ROOM_CATALOGS[MAP_FAMILY_TOWER].election)
        .flat().map((e) => e.role)
    )
    const roles = electedRoles(towerConfig)
    expect(roles.size).toBeGreaterThan(0)
    for (const role of roles) expect(allowed.has(role), `tower role ${role}`).toBe(true)
    // The office-floor identity pieces stay out of towers.
    for (const banned of [SPACE_ROLE_BREAK, SPACE_ROLE_COPY, SPACE_ROLE_LIBRARY]) {
      expect(roles.has(banned), `tower banned role ${banned}`).toBe(false)
    }
  })

  it('keeps family plans out of each other\'s cache', () => {
    const towerConfig = worldConfigForFamily(MAP_FAMILY_TOWER, cfg)
    const officeBefore = buildOfficeDistrictPlan(777, 0, 0, cfg)
    const tower = buildOfficeDistrictPlan(777, 0, 0, towerConfig)
    const officeAfter = buildOfficeDistrictPlan(777, 0, 0, cfg)
    // Interleaving a tower build never pollutes the office plan (and vice
    // versa): the cache keys on the config identity + family signature.
    expect(officeAfter.cellKind).toEqual(officeBefore.cellKind)
    expect(officeAfter.roleGrid).toEqual(officeBefore.roleGrid)
    // And the two families' role grids draw from disjoint election sources
    // (tower elects no break/copy/library, office does elect them somewhere).
    expect(tower.roleGrid).not.toEqual(officeBefore.roleGrid)
  })
})

describe('procedural room shapes', () => {
  it('produces a healthy share of non-rectangular rooms', () => {
    let rooms = 0
    let nonRect = 0
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const plan = buildOfficeDistrictPlan(777, dx, dz, cfg)
        for (const s of plan.spaces) {
          if (s.type !== 'room') continue
          rooms++
          const w = s.x1 - s.x0 + 1
          const h = s.z1 - s.z0 + 1
          if (s.area < w * h) nonRect++
        }
      }
    }
    expect(rooms).toBeGreaterThan(200)
    // Shape variety is real but bounded: rectangles remain the norm-setter.
    expect(nonRect / rooms).toBeGreaterThan(0.1)
    expect(nonRect / rooms).toBeLessThan(0.75)
  })

  it('is deterministic and honours the shape knobs', () => {
    const a = buildOfficeDistrictPlan(4242, 1, -1, cfg)
    const b = buildOfficeDistrictPlan(4242, 1, -1, cfg)
    expect(a.cellKind).toEqual(b.cellKind)
    expect(a.spaceId).toEqual(b.spaceId)

    const square = structuredClone(cfg)
    square.office.roomShapeChance = 0
    const plain = buildOfficeDistrictPlan(4242, 1, -1, square)
    // With the exchange disabled the same seed carves a different (all-BSP)
    // field; the knob is live.
    expect(plain.cellKind).not.toEqual(a.cellKind)
  })
})

describe('iterative plan generation', () => {
  it('every published plan satisfies the hard constraints across a seed sweep', () => {
    for (const seed of [1, 7, 42, 777, 4242, 31337, 0xbeef]) {
      const plan = buildOfficeDistrictPlan(seed, 0, 0, cfg)
      expect(plan.metrics.invalidRooms).toBe(0)
      expect(plan.metrics.unroutedStairs).toBe(0)
      expect(plan.metrics.unroutedMultilevel).toBe(0)
    }
  })

  it('exposes the candidate budget as config', () => {
    expect(cfg.office.planCandidateLimit).toBeGreaterThanOrEqual(cfg.office.planCandidates)
  })
})

describe('tower furnishing', () => {
  it('places catalog-consistent furniture on tower floors', () => {
    const towerConfig = worldConfigForFamily(MAP_FAMILY_TOWER, cfg)
    // Everything a tower chunk may contain: the tower roles' whitelists plus
    // the shared ordinary themes (row kinds + the implicit conference/
    // workstation pieces: table, chair, desk).
    const allowedKinds = new Set([
      ...Object.keys(FAMILY_ROOM_CATALOGS[MAP_FAMILY_TOWER].quotas)
        .flatMap((role) => ROOM_TYPES[role].whitelist),
      ...ORDINARY_THEMES.flatMap((theme) =>
        theme.grammar.map((op) => op.kind).filter((kind) => kind !== undefined)
      ),
      FURN_DESK, // workstations op
      FURN_CHAIR, // conference + workstations ops
      FURN_TABLE, // conference op
    ])
    let pieces = 0
    for (let cx = -3; cx <= 3; cx++) {
      for (let cz = -3; cz <= 3; cz++) {
        const data = buildChunk(777, cx, 0, cz, towerConfig)
        if (data.zone !== ZONE_OFFICE) continue
        pieces += data.furniture.length
        for (const f of data.furniture) {
          expect(allowedKinds.has(f.kind), `tower kind ${f.kind}`).toBe(true)
        }
        // Role bytes on tower floors come from the tower catalog.
        for (let i = 0; i < data.spaceRole.length; i++) {
          const role = data.spaceRole[i]
          if (role === SPACE_ROLE_NONE) continue
          expect(
            FAMILY_ROOM_CATALOGS[MAP_FAMILY_TOWER].quotas[role],
            `tower spaceRole ${role}`
          ).toBeGreaterThan(0)
        }
      }
    }
    expect(pieces).toBeGreaterThan(50)
  })
})

// Room-role bytes are elected on CELL_ROOM cells, but several chunk-time
// stages relabel room cells into circulation (border thresholds facing
// non-office zones, stair halos, tall-structure carves, lattice resets).
// Every relabel must drop the role: dressing, lamp character and the debug
// map all trust that SPACE_ROLE_* only ever rides CELL_ROOM.
describe('room roles stay on real rooms (all families)', () => {
  it('never leaves a SPACE_ROLE byte on a non-room cell', () => {
    for (const family of [
      MAP_FAMILY_OFFICE,
      MAP_FAMILY_SEWER,
      MAP_FAMILY_TOWER,
      MAP_FAMILY_LATTICE,
      MAP_FAMILY_HOTEL,
    ]) {
      const config = family === MAP_FAMILY_OFFICE ? cfg : worldConfigForFamily(family, cfg)
      for (let cx = -2; cx <= 2; cx++) {
        for (let cz = -2; cz <= 2; cz++) {
          for (const cy of [0, 1, 2]) {
            const data = buildChunk(777, cx, cy, cz, config)
            for (let i = 0; i < data.spaceRole.length; i++) {
              if (data.spaceRole[i] === SPACE_ROLE_NONE) continue
              expect(
                data.cellKind[i],
                `${family} ${cx},${cy},${cz} cell ${i % CHUNK},${(i / CHUNK) | 0} role ${data.spaceRole[i]}`
              ).toBe(CELL_ROOM)
            }
          }
        }
      }
    }
  })
})

// Sewer chambers are the district-less family's rooms: prescribed by the
// module grammar, graduated to CELL_ROOM at stamp time, role-elected from
// SEWER_CHAMBER_CATALOG, and furnished like any named room.
describe('sewer chamber rooms', () => {
  const sewerConfig = worldConfigForFamily(MAP_FAMILY_SEWER, cfg)

  it('graduates each prescribed chamber to one named CELL_ROOM space', () => {
    let chambersSeen = 0
    let absorbed = 0
    for (let cx = -3; cx <= 3; cx++) {
      for (let cz = -3; cz <= 3; cz++) {
        const data = buildChunk(777, cx, 0, cz, sewerConfig)
        expect(data.sewerDescriptor).toBeTruthy()
        const roleById = new Map()
        for (let i = 0; i < data.cellKind.length; i++) {
          if (data.cellKind[i] !== CELL_ROOM) continue
          const id = data.spaceId[i]
          expect(id, 'room cell carries a space id').toBeGreaterThan(0)
          const role = data.spaceRole[i]
          expect(
            [SPACE_ROLE_NONE, SPACE_ROLE_SERVER, SPACE_ROLE_STORAGE].includes(role),
            `sewer chamber role ${role} stays infrastructural`
          ).toBe(true)
          // One role per room space, uniform across its cells.
          if (roleById.has(id)) expect(roleById.get(id)).toBe(role)
          roleById.set(id, role)
        }
        for (const chamber of data.sewerDescriptor.chambers) {
          chambersSeen++
          const ids = new Set()
          for (let z = chamber.z0; z <= chamber.z1; z++) {
            for (let x = chamber.x0; x <= chamber.x1; x++) {
              const i = z * CHUNK + x
              if (data.cellKind[i] !== CELL_ROOM) continue
              ids.add(data.spaceId[i])
            }
          }
          // Stair halos may absorb chamber-edge cells as circulation; a
          // chamber that survives does so as exactly ONE room space.
          if (ids.size === 0) absorbed++
          else expect(ids.size, `chamber ${chamber.kind} is one room space`).toBe(1)
        }
      }
    }
    expect(chambersSeen).toBeGreaterThan(50)
    expect(absorbed).toBeLessThan(chambersSeen / 4)
  })

  it('furnishes named chambers from their whitelists only, deterministically', () => {
    const whitelist = new Set([FURN_RACK, FURN_CABINET])
    let pieces = 0
    let namedCells = 0
    for (let cx = -3; cx <= 3; cx++) {
      for (let cz = -3; cz <= 3; cz++) {
        const a = buildChunk(777, cx, 0, cz, sewerConfig)
        const b = buildChunk(777, cx, 0, cz, sewerConfig)
        expect(a.furniture).toEqual(b.furniture)
        expect(a.spaceRole).toEqual(b.spaceRole)
        pieces += a.furniture.length
        for (const f of a.furniture) {
          const i = f.lz * CHUNK + f.lx
          expect(a.cellKind[i]).toBe(CELL_ROOM)
          // Furniture only lands in NAMED chambers (unelected ones stay
          // bare — no office props underground), from the server/storage
          // whitelists: racks and cabinets, nothing else.
          expect(a.spaceRole[i]).not.toBe(SPACE_ROLE_NONE)
          expect(whitelist.has(f.kind), `sewer furniture kind ${f.kind}`).toBe(true)
        }
        for (let i = 0; i < a.spaceRole.length; i++) {
          if (a.spaceRole[i] !== SPACE_ROLE_NONE) namedCells++
        }
      }
    }
    expect(namedCells).toBeGreaterThan(0)
    expect(pieces).toBeGreaterThan(30)
  })

  it('never lets chamber furniture sever the sewer walk graph', () => {
    const bareConfig = worldConfigForFamily(MAP_FAMILY_SEWER, cfg)
    bareConfig.furniture = { enabled: false }
    for (let cx = -2; cx <= 2; cx++) {
      for (let cz = -2; cz <= 2; cz++) {
        const furnished = buildChunk(777, cx, 0, cz, sewerConfig)
        const bare = buildChunk(777, cx, 0, cz, bareConfig)
        expect(countChunkComponents(furnished, true)).toBe(1)
        expect(countChunkComponents(furnished, true)).toBe(countChunkComponents(bare, true))
      }
    }
  })
})

// The lattice structure's decks stay bare by design, but the office shell
// around and beyond the structure is real fabric: it elects the lattice
// maintenance mix and furnishes like any other office floor.
describe('lattice shell rooms', () => {
  it('furnishes the office shell while lattice decks stay bare', () => {
    const latticeConfig = worldConfigForFamily(MAP_FAMILY_LATTICE, cfg)
    const shellRoles = new Set(
      Object.values(FAMILY_ROOM_CATALOGS[MAP_FAMILY_LATTICE].election)
        .flat().map((entry) => entry.role)
    )
    let structureChunks = 0
    let shellPieces = 0
    for (let cx = -3; cx <= 3; cx++) {
      for (let cz = -3; cz <= 3; cz++) {
        for (let cy = 0; cy <= 6; cy++) {
          const data = buildChunk(777, cx, cy, cz, latticeConfig)
          if (data.structure?.family === MAP_FAMILY_LATTICE) {
            structureChunks++
            expect(data.furniture, 'lattice deck stays bare').toHaveLength(0)
            continue
          }
          shellPieces += data.furniture.length
          for (let i = 0; i < data.spaceRole.length; i++) {
            const role = data.spaceRole[i]
            if (role === SPACE_ROLE_NONE) continue
            expect(shellRoles.has(role), `lattice shell role ${role}`).toBe(true)
          }
        }
      }
    }
    expect(structureChunks).toBeGreaterThan(0)
    expect(shellPieces).toBeGreaterThan(50)
  })
})

// The hotel family: residential fabric on the office pipeline. Its
// districts read as a residence — bedrooms dominate the named mix, the
// communal rooms (kitchen, living, dining, laundry) each appear, and the
// institutional office vocabulary never does.
describe('hotel rooms', () => {
  const hotelConfig = worldConfigForFamily(MAP_FAMILY_HOTEL, cfg)

  it('elects only hotel-catalog roles, with bedrooms as the dominant named room', () => {
    const allowed = new Set(
      Object.values(FAMILY_ROOM_CATALOGS[MAP_FAMILY_HOTEL].election)
        .flat().map((e) => e.role)
    )
    const counts = new Map()
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        const plan = buildOfficeDistrictPlan(777, dx, dz, hotelConfig)
        for (const s of plan.spaces) {
          if (s.type !== 'room' || !s.role) continue
          expect(allowed.has(s.role), `hotel role ${s.role}`).toBe(true)
          counts.set(s.role, (counts.get(s.role) ?? 0) + 1)
        }
      }
    }
    // Every catalog role appears somewhere in a 9x9-district corpus.
    for (const role of allowed) expect(counts.get(role) ?? 0, `hotel elects ${role}`).toBeGreaterThan(0)
    // Bedrooms are the residence's dominant named room.
    const max = Math.max(...counts.values())
    expect(counts.get(SPACE_ROLE_BEDROOM)).toBe(max)
    // The institutional identity roles never appear behind a hotel door.
    for (const banned of [
      SPACE_ROLE_MEETING,
      SPACE_ROLE_BREAK,
      SPACE_ROLE_COPY,
      SPACE_ROLE_SERVER,
      SPACE_ROLE_ARCHIVE,
      SPACE_ROLE_LIBRARY,
      SPACE_ROLE_OFFICE,
    ]) {
      expect(counts.has(banned), `hotel banned role ${banned}`).toBe(false)
    }
  })

  it('furnishes hotel floors residentially — role whitelists plus hotel themes, never office kit', () => {
    const allowedKinds = new Set([
      ...Object.keys(FAMILY_ROOM_CATALOGS[MAP_FAMILY_HOTEL].quotas)
        .flatMap((role) => ROOM_TYPES[role].whitelist),
      ...ordinaryThemesFor(MAP_FAMILY_HOTEL).flatMap((theme) =>
        theme.grammar.map((op) => op.kind).filter((kind) => kind !== undefined)
      ),
      FURN_TABLE, // conference op (dining/kitchen islands)
      FURN_CHAIR, // conference op seating
    ])
    const officeKit = new Set([FURN_DESK, FURN_COPIER, FURN_COOLER, FURN_RACK, FURN_WHITEBOARD])
    let pieces = 0
    let beds = 0
    for (let cx = -3; cx <= 3; cx++) {
      for (let cz = -3; cz <= 3; cz++) {
        const a = buildChunk(777, cx, 0, cz, hotelConfig)
        const b = buildChunk(777, cx, 0, cz, hotelConfig)
        expect(a.furniture).toEqual(b.furniture)
        if (a.zone !== ZONE_OFFICE) continue
        pieces += a.furniture.length
        for (const f of a.furniture) {
          expect(allowedKinds.has(f.kind), `hotel kind ${f.kind}`).toBe(true)
          expect(officeKit.has(f.kind), `office kit ${f.kind} in hotel`).toBe(false)
          if (f.kind === FURN_BED) beds++
        }
        // Role bytes on hotel floors come from the hotel catalog.
        for (let i = 0; i < a.spaceRole.length; i++) {
          const role = a.spaceRole[i]
          if (role === SPACE_ROLE_NONE) continue
          expect(
            FAMILY_ROOM_CATALOGS[MAP_FAMILY_HOTEL].quotas[role],
            `hotel spaceRole ${role}`
          ).toBeGreaterThan(0)
        }
      }
    }
    expect(pieces).toBeGreaterThan(50)
    expect(beds).toBeGreaterThan(5)
  })

  it('keeps hotel plans out of the office plan cache', () => {
    const officeBefore = buildOfficeDistrictPlan(777, 0, 0, cfg)
    const hotel = buildOfficeDistrictPlan(777, 0, 0, hotelConfig)
    const officeAfter = buildOfficeDistrictPlan(777, 0, 0, cfg)
    expect(officeAfter.cellKind).toEqual(officeBefore.cellKind)
    expect(officeAfter.roleGrid).toEqual(officeBefore.roleGrid)
    expect(hotel.roleGrid).not.toEqual(officeBefore.roleGrid)
  })
})
