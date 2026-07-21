import { describe, expect, it } from 'vitest'
import {
  collectRoomLabels,
  describeCell,
  exploreConfigForFamily,
  formatFamilyCounts,
  formatFamilyFailureSummary,
  formatLatticeMetrics,
  formatMultilevelStructure,
  formatStructureDetail,
  listFamilyFailures,
  roomRoleLabel,
  spaceIdColor,
  structureAtCell,
} from '../mapInspect.js'
import { DEFAULT_WORLD_CONFIG } from '../../world/config.js'
import { CHUNK, ZONE_OFFICE } from '../../world/constants.js'
import { ChunkData } from '../../world/ChunkData.js'
import { buildChunk } from '../../world/pipeline.js'
import { worldConfigForFamily, MAP_FAMILY_ORDER } from '../../world/mapFamily.js'
import {
  CELL_ROOM,
  MAP_FAMILY_LATTICE,
  SPACE_ROLE_SERVER,
} from '../../world/mapTypes.js'
import { structureAt } from '../../world/structures/contract.js'
import { discoverTowerFixture } from '../../world/__tests__/tower-fixture.js'

const LATTICE_SCAN_SEEDS = Object.freeze([0x1a771ce, 0x5a17, 0xc0ffee])

let latticeDiscovery = null
function discoverLatticeFixture() {
  if (latticeDiscovery) return latticeDiscovery
  const base = structuredClone(DEFAULT_WORLD_CONFIG)
  const config = worldConfigForFamily(MAP_FAMILY_LATTICE, base)
  for (const seed of LATTICE_SCAN_SEEDS) {
    for (let cy = -24; cy <= 24; cy++) {
      for (let cz = -4; cz <= 4; cz++) {
        for (let cx = -4; cx <= 4; cx++) {
          const structure = structureAt(seed, cx, cz, cy, config)
          if (structure?.hasRoom === true && structure.family === MAP_FAMILY_LATTICE) {
            latticeDiscovery = { config, seed, structure }
            return latticeDiscovery
          }
        }
      }
    }
  }
  latticeDiscovery = { config, seed: null, structure: null }
  return latticeDiscovery
}

describe('formatStructureDetail', () => {
  it('keeps the historical office string byte-identical', () => {
    const office = Object.freeze({
      id: 173,
      hasRoom: true,
      kind: 'bridged',
      baseCy: -12,
      topCy: 2,
      levelCount: 15,
      bridgeLevels: [-11, -9],
      participants: [{ cx: -5, cz: 2 }, { cx: -4, cz: 2 }],
      globalBounds: { x0: -69, z0: 31, x1: -48, z1: 36 },
    })
    expect(formatStructureDetail([office], office, 'cursor')).toBe(
      formatMultilevelStructure([office], office, 'cursor')
    )
    expect(formatStructureDetail([], null)).toBe('visible 0 · current —')
  })

  it('surfaces tower deck, socket, and link anatomy', () => {
    const { structure } = discoverTowerFixture()
    expect(structure).not.toBeNull()
    const text = formatStructureDetail([structure], structure, 'pinned')
    expect(text).toContain(`pinned #${structure.id} ${structure.kind}`)
    expect(text).toContain(`deck cy${structure.decks[0].levelCy}`)
    expect(text).toContain(`sockets ${structure.landmarkSockets.length}`)
    expect(text).toContain(`vlinks ${structure.verticalLinks.length}`)
  })

  it('surfaces lattice anchors and per-role edge counts', () => {
    const { structure } = discoverLatticeFixture()
    expect(structure).not.toBeNull()
    const text = formatStructureDetail([structure], structure)
    expect(text).toContain(`anchors ${structure.anchors.length}`)
    const backbone = structure.edges.filter((e) => e.role === 'backbone').length
    expect(text).toContain(`edges bb${backbone}`)
  })
})

describe('family audit formatters', () => {
  it('formats nonzero family/kind/landmark counts and drops empty groups', () => {
    expect(formatFamilyCounts(null)).toBe('off')
    expect(formatFamilyCounts({ familyCounts: {}, kindCounts: {} })).toBe('none')
    expect(
      formatFamilyCounts({
        familyCounts: { office: 9, tower: 6, sewer: 0 },
        kindCounts: { towerSkybridge: 6 },
        landmarkKindCounts: { signage: 1, clock: 1 },
      })
    ).toBe('fam office 9 · tower 6 | kind towerSkybridge 6 | lm signage 1 · clock 1')
  })

  it('summarizes adapter and descriptor failures', () => {
    expect(formatFamilyFailureSummary(null)).toBe('off')
    expect(
      formatFamilyFailureSummary({
        familyAdapterFailures: 1,
        kindAdapterFailures: 2,
        familyDescriptorFailures: 3,
        details: { familyAuditFailures: [{}, {}] },
      })
    ).toBe('adapters 1 fam / 2 kind · desc 3 · reasons 2')
  })

  it('formats lattice metrics and dashes when absent', () => {
    expect(formatLatticeMetrics(null)).toBe('—')
    expect(formatLatticeMetrics({})).toBe('—')
    expect(
      formatLatticeMetrics({
        anchorCount: 25,
        floorCoverage: 3,
        horizontalBridges: 7,
        verticalConnectors: 2,
        defaultExposureM: 5,
        maximumExposureM: 20,
        minimumCombinedCueCells: 8,
        enclosedRoomSlices: 27,
      })
    ).toBe('anchors 25 · cover 3 · hbridges 7 · vlinks 2 · exp 5/20m · cues 8 · rooms 27')
  })

  it('lists failures capped with a +N tail', () => {
    expect(listFamilyFailures(null)).toEqual([])
    const failures = Array.from({ length: 12 }, (_, i) => ({
      family: 'tower',
      kind: 'towerSkybridge',
      reason: `reason-${i}`,
    }))
    const lines = listFamilyFailures({ familyAuditFailures: failures }, 10)
    expect(lines).toHaveLength(11)
    expect(lines[0]).toBe('tower:towerSkybridge reason-0')
    expect(lines[10]).toBe('+2 more')
  })
})

describe('structureAtCell across families', () => {
  it('hits inside tower and lattice bounds on a band floor and misses outside', () => {
    const tower = discoverTowerFixture().structure
    const lattice = discoverLatticeFixture().structure
    for (const structure of [tower, lattice]) {
      expect(structure).not.toBeNull()
      const { globalBounds: b, baseCy, topCy } = structure
      expect(structureAtCell([structure], b.x0, b.z0, baseCy)).toBe(structure)
      expect(structureAtCell([structure], b.x1, b.z1, topCy)).toBe(structure)
      expect(structureAtCell([structure], b.x0 - 1, b.z0, baseCy)).toBeNull()
      expect(structureAtCell([structure], b.x0, b.z0, topCy + 1)).toBeNull()
    }
  })
})

describe('exploreConfigForFamily', () => {
  it('selects every canonical family and falls back to office on junk', () => {
    for (const family of MAP_FAMILY_ORDER) {
      expect(exploreConfigForFamily(family).mapFamily.selected).toBe(family)
    }
    expect(exploreConfigForFamily('hospital').mapFamily.selected).toBe('office')
    expect(exploreConfigForFamily('sewer').zoneBands).toEqual(
      DEFAULT_WORLD_CONFIG.mapFamily.profiles.sewer.zoneBands
    )
  })
})

describe('describeCell', () => {
  it('reads kind, space ownership, and role from the raster', () => {
    const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
    const i = 4 * CHUNK + 3
    data.cellKind[i] = CELL_ROOM
    data.spaceId[i] = 421
    data.spaceRole[i] = SPACE_ROLE_SERVER
    expect(describeCell(data, 3, 4)).toBe('room · space 421 server')
    expect(describeCell(data, 0, 0)).toBe('open')
    expect(describeCell(data, -1, 0)).toBe('')
  })

  it('appends the validated death plane on a lethal tower cell', () => {
    const { config, seed, structure } = discoverTowerFixture()
    expect(structure).not.toBeNull()
    let found = null
    for (let cy = structure.baseCy; cy <= structure.topCy && !found; cy++) {
      for (const p of structure.participants) {
        const d = buildChunk(seed, p.cx, cy, p.cz, config)
        const cell = d.lethalVoidDown?.cells?.[0]
        if (cell) {
          found = { d, cell }
          break
        }
      }
    }
    expect(found).not.toBeNull()
    const text = describeCell(found.d, found.cell.lx, found.cell.lz)
    expect(text).toContain(`#${structure.id}`)
    expect(text).toContain('deathY ')
  })
})

describe('spaceIdColor', () => {
  it('is deterministic and hue-bounded', () => {
    expect(spaceIdColor(421)).toBe(spaceIdColor(421))
    expect(spaceIdColor(421)).toMatch(/^hsla\(\d+, 65%, 55%, \.28\)$/)
  })
})

describe('collectRoomLabels', () => {
  const roomCells = (data, cells, id, role) => {
    for (const [lx, lz] of cells) {
      const i = lz * CHUNK + lx
      data.cellKind[i] = CELL_ROOM
      data.spaceId[i] = id
      data.spaceRole[i] = role
    }
  }

  it('labels a seam-crossing room once, at its shared centroid', () => {
    // One space split across the West/East chunk seam: cells lx=13 in chunk
    // (0,0) touch lx=0 in chunk (1,0).
    const west = new ChunkData(0, 0, 0, ZONE_OFFICE)
    const east = new ChunkData(1, 0, 0, ZONE_OFFICE)
    roomCells(west, [[12, 4], [13, 4]], 77, SPACE_ROLE_SERVER)
    roomCells(east, [[0, 4], [1, 4]], 77, SPACE_ROLE_SERVER)
    // Noise that must not label: ordinary cells and a far role-less space.
    roomCells(west, [[5, 5]], 78, 0)
    const labels = collectRoomLabels([{ data: west }, { data: east }])
    expect(labels).toHaveLength(1)
    expect(labels[0].role).toBe(SPACE_ROLE_SERVER)
    expect(labels[0].cells).toBe(4)
    expect(labels[0].gx).toBeCloseTo((12 + 13 + 14 + 15) / 4)
    expect(labels[0].gz).toBeCloseTo(4)
  })

  it('splits disjoint clusters that share one space id', () => {
    // Space ids are only district-unique: two far-apart rooms carrying the
    // same id must label separately.
    const a = new ChunkData(0, 0, 0, ZONE_OFFICE)
    const b = new ChunkData(4, 0, 0, ZONE_OFFICE)
    roomCells(a, [[2, 2], [3, 2]], 99, SPACE_ROLE_SERVER)
    roomCells(b, [[2, 2], [3, 2]], 99, SPACE_ROLE_SERVER)
    const labels = collectRoomLabels([{ data: a }, { data: b }])
    expect(labels).toHaveLength(2)
    expect(labels.map((l) => l.cells).sort()).toEqual([2, 2])
  })

  it('reads real generated rooms across families', () => {
    for (const family of MAP_FAMILY_ORDER) {
      const { config } = exploreConfigForFamily(family)
      const entries = []
      for (let cx = -2; cx <= 2; cx++) {
        for (let cz = -2; cz <= 2; cz++) {
          entries.push({ data: buildChunk(777, cx, 0, cz, config) })
        }
      }
      const labels = collectRoomLabels(entries)
      for (const label of labels) {
        expect(roomRoleLabel(label.role), `${family} label for role ${label.role}`).toBeTruthy()
        expect(label.cells).toBeGreaterThan(0)
      }
      // Office and sewer are dense with named rooms; tower/lattice shells
      // elect fewer — but every family labels something on this corpus.
      expect(labels.length, `${family} labels present`).toBeGreaterThan(0)
    }
  })
})
