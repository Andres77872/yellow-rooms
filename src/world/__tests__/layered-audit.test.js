import { describe, expect, it } from 'vitest'
import { auditLayeredPatch } from '../audit.js'
import { ChunkData } from '../ChunkData.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { CHUNK, cIdx } from '../constants.js'
import {
  CELL_BRIDGE,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  WALL_PLAIN,
  WALL_RAIL,
} from '../mapTypes.js'
import { buildChunk } from '../pipeline.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { STAIR_DX, STAIR_DZ } from '../structures/slab.js'
import { structureAt } from '../structures/contract.js'
import {
  OFFICE_STRUCTURE_ADAPTER,
  structureAdapterFor,
  TOWER_STRUCTURE_ADAPTER,
} from '../structures/contract.js'
import {
  STRUCTURE_KIND_LATTICE,
  STRUCTURE_KIND_OFFICE,
  STRUCTURE_KIND_TOWER,
} from '../structures/contract.js'

const denseConfig = () => ({
  ...DEFAULT_WORLD_CONFIG,
  stairs: { ...DEFAULT_WORLD_CONFIG.stairs, enabled: true, chance: 1 },
  multilevel: { ...DEFAULT_WORLD_CONFIG.multilevel, enabled: false },
})

const key = (cx, cy, cz) => `${cx},${cy},${cz}`
const lookup = (chunks) => (cx, cy, cz) => chunks.get(key(cx, cy, cz)) || null
const TOWER_LANDMARK_KINDS = Object.freeze([
  'signage',
  'clock',
  'litAccent',
  'door',
  'fixture',
])

function generatedPair(seed = 991) {
  const config = denseConfig()
  const chunks = new Map()
  chunks.set(key(0, 0, 0), buildChunk(seed, 0, 0, 0, config))
  chunks.set(key(0, 1, 0), buildChunk(seed, 0, 1, 0, config))
  return chunks
}

function structureDescriptor(family, id) {
  const participants = family === MAP_FAMILY_LATTICE
    ? Array.from({ length: 3 }, (_, cz) =>
        Array.from({ length: 3 }, (_, cx) => ({ cx, cz }))
      ).flat()
    : [{ cx: 0, cz: 0 }, { cx: 1, cz: 0 }]
  return {
    id,
    family,
    kind: family === MAP_FAMILY_TOWER
      ? STRUCTURE_KIND_TOWER
      : STRUCTURE_KIND_LATTICE,
    district: { x: 0, z: 0, size: family === MAP_FAMILY_TOWER ? 2 : 3 },
    baseCy: 0,
    topCy: 2,
    ...(family === MAP_FAMILY_LATTICE ? { levelCount: 3 } : {}),
    participants,
    anchor: participants[0],
    globalBounds: family === MAP_FAMILY_LATTICE
      ? { x0: 0, z0: 0, x1: CHUNK * 3 - 1, z1: CHUNK * 3 - 1 }
      : { x0: 0, z0: 0, x1: CHUNK * 2 - 1, z1: CHUNK - 1 },
    verticalLinks: [],
  }
}

function freeVoidCells(lower, upper, count = 2) {
  const excluded = new Set()
  for (const data of [lower, upper]) {
    for (const stair of [data.stairUp, data.stairDown]) {
      for (const cell of [stair?.landing, ...(stair?.run || []), stair?.exit]) {
        if (cell) excluded.add(`${cell.lx},${cell.lz}`)
      }
    }
  }

  const cells = []
  for (let lz = 2; lz < CHUNK - 2 && cells.length < count; lz++) {
    for (let lx = 2; lx < CHUNK - 2 && cells.length < count; lx++) {
      if (excluded.has(`${lx},${lz}`)) continue
      if (lower.colAt(lx, lz) || upper.colAt(lx, lz)) continue
      if (lower.hasCeilHole(lx, lz) || upper.hasFloorHole(lx, lz)) continue
      cells.push({ lx, lz, deathYmm: -5000 - cells.length * 250 })
    }
  }
  if (cells.length !== count) throw new Error('expected free lethal-void fixture cells')
  return cells
}

function lethalVoidFixture(family = MAP_FAMILY_TOWER, seed = 16031) {
  const chunks = generatedPair(seed)
  const lower = chunks.get(key(0, 0, 0))
  const upper = chunks.get(key(0, 1, 0))
  const id = family === MAP_FAMILY_TOWER ? 0x7011 : 0x1a771ce
  const descriptor = structureDescriptor(family, id)
  const half = {
    id,
    family,
    lowerCy: 0,
    cells: freeVoidCells(lower, upper),
  }

  for (const data of [lower, upper]) {
    data.mapFamily = family
    data.structure = descriptor
  }
  lower.lethalVoidUp = structuredClone(half)
  upper.lethalVoidDown = structuredClone(half)
  return { chunks, lower, upper, descriptor, cells: half.cells }
}

function authoredTowerVoidFixture(seed = 16031) {
  const fixture = lethalVoidFixture(MAP_FAMILY_TOWER, seed)
  const descriptor = {
    ...fixture.descriptor,
    levelCount: 3,
    bridgeAxis: 'x',
    verticalLinks: [
      {
        lowerCy: 0,
        cx: 0,
        cz: 0,
        stair: structuredClone(fixture.lower.stairUp),
      },
      {
        lowerCy: 1,
        cx: 1,
        cz: 0,
        stair: structuredClone(fixture.upper.stairDown),
      },
    ],
    decks: [{
      levelCy: 1,
      lowerCy: 0,
      globalBridgeLine: 7,
      globalBounds: { x0: 13, z0: 7, x1: 18, z1: 7 },
      globalCells: Array.from({ length: 6 }, (_, index) => ({
        gx: 13 + index,
        gz: 7,
      })),
    }],
    landmarkSockets: [
      {
        slot: 'anchorFloor',
        kind: 'signage',
        gx: 5,
        gz: 4,
        cy: 0,
        axis: 'x',
        side: -1,
        salt: 2101,
      },
      {
        slot: 'anchorFloor',
        kind: 'clock',
        gx: 6,
        gz: 4,
        cy: 1,
        axis: 'x',
        side: -1,
        salt: 2102,
      },
      {
        slot: 'anchorFloor',
        kind: 'litAccent',
        gx: 7,
        gz: 4,
        cy: 2,
        axis: 'x',
        side: -1,
        salt: 2103,
      },
      {
        slot: 'bridgeApproach',
        kind: 'door',
        gx: 13,
        gz: 7,
        cy: 1,
        axis: 'x',
        side: -1,
        salt: 2104,
      },
      {
        slot: 'bridgeApproach',
        kind: 'fixture',
        gx: 18,
        gz: 7,
        cy: 1,
        axis: 'x',
        side: 1,
        salt: 2105,
      },
    ],
  }
  fixture.descriptor = descriptor
  fixture.lower.structure = descriptor
  fixture.upper.structure = descriptor
  return fixture
}

function forcedLatticeConfig() {
  const base = structuredClone(DEFAULT_WORLD_CONFIG)
  base.mapFamily.profiles[MAP_FAMILY_LATTICE].enabled = true
  return worldConfigForFamily(MAP_FAMILY_LATTICE, base)
}

function authoredLatticeVoidFixture(seed = 0x1a771ce) {
  const config = forcedLatticeConfig()
  let descriptor = null
  for (let cy = -24; cy <= 24 && !descriptor; cy++) {
    for (let cz = -4; cz <= 4 && !descriptor; cz++) {
      for (let cx = -4; cx <= 4; cx++) {
        const candidate = structureAt(seed, cx, cz, cy, config)
        if (
          candidate?.family === MAP_FAMILY_LATTICE &&
          candidate.kind === STRUCTURE_KIND_LATTICE &&
          candidate.hasRoom === true
        ) {
          descriptor = candidate
          break
        }
      }
    }
  }
  if (!descriptor) throw new Error('expected one generated Lattice audit fixture')

  const chunks = new Map()
  for (let cy = descriptor.baseCy; cy <= descriptor.topCy; cy++) {
    for (const participant of descriptor.participants) {
      const data = buildChunk(seed, participant.cx, cy, participant.cz, config)
      chunks.set(key(participant.cx, cy, participant.cz), data)
    }
  }
  const link = descriptor.verticalLinks[0]
  const lower = chunks.get(key(link.cx, link.lowerCy, link.cz))
  const upper = chunks.get(key(link.cx, link.lowerCy + 1, link.cz))
  const top = chunks.get(key(link.cx, link.lowerCy + 2, link.cz))
  return {
    chunks,
    lower,
    upper,
    top,
    descriptor,
    cells: lower.lethalVoidUp.cells,
    secondCells: upper.lethalVoidUp.cells,
  }
}

function latticeGlobalEdge(chunks, axis, gx, gz, cy) {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  const data = chunks.get(key(cx, cy, cz))
  if (!data) return null
  const lx = gx - cx * CHUNK
  const lz = gz - cz * CHUNK
  return axis === 'v'
    ? { data, lx, lz, wall: data.vAt(lx, lz), feature: data.wallFeatureVAt(lx, lz) }
    : { data, lx, lz, wall: data.hAt(lx, lz), feature: data.wallFeatureHAt(lx, lz) }
}

function setLatticeGlobalEdge(chunks, axis, gx, gz, cy, wall, passage, feature) {
  const state = latticeGlobalEdge(chunks, axis, gx, gz, cy)
  if (!state) throw new Error('expected generated Lattice edge')
  if (axis === 'v') state.data.setV(state.lx, state.lz, wall, passage, feature)
  else state.data.setH(state.lx, state.lz, wall, passage, feature)
}

function latticeChamberEdges(anchor) {
  return [
    ...Array.from({ length: 3 }, (_, offset) => ['h', anchor.gx - 1 + offset, anchor.gz - 1]),
    ...Array.from({ length: 3 }, (_, offset) => ['v', anchor.gx + 2, anchor.gz - 1 + offset]),
    ...Array.from({ length: 3 }, (_, offset) => ['h', anchor.gx - 1 + offset, anchor.gz + 2]),
    ...Array.from({ length: 3 }, (_, offset) => ['v', anchor.gx - 1, anchor.gz - 1 + offset]),
  ]
}

function damageGeneratedLatticeCues(chunks, descriptor) {
  const anchor = descriptor.anchors.find((candidate) =>
    latticeChamberEdges(candidate).filter(([axis, gx, gz]) =>
      latticeGlobalEdge(chunks, axis, gx, gz, candidate.levelCy)?.feature === WALL_RAIL
    ).length >= 6
  )
  const rails = latticeChamberEdges(anchor).filter(([axis, gx, gz]) =>
    latticeGlobalEdge(chunks, axis, gx, gz, anchor.levelCy)?.feature === WALL_RAIL
  )
  for (const [axis, gx, gz] of rails.slice(0, 5)) {
    setLatticeGlobalEdge(
      chunks,
      axis,
      gx,
      gz,
      anchor.levelCy,
      0,
      PASSAGE_WIDE,
      WALL_PLAIN
    )
  }
}

function damageGeneratedLatticePlainSides(chunks, descriptor) {
  const anchor = descriptor.anchors[0]
  const sides = latticeChamberEdges(anchor)
  for (const [axis, gx, gz] of sides.slice(0, 9)) {
    setLatticeGlobalEdge(
      chunks,
      axis,
      gx,
      gz,
      anchor.levelCy,
      1,
      PASSAGE_WALL,
      WALL_PLAIN
    )
  }
}

function damageGeneratedLatticeGuard(chunks, descriptor) {
  for (const edge of descriptor.edges) {
    for (const cell of edge.cells) {
      const data = chunks.get(key(
        Math.floor(cell.gx / CHUNK),
        cell.cy,
        Math.floor(cell.gz / CHUNK)
      ))
      if (!data) continue
      const lx = cell.gx - data.cx * CHUNK
      const lz = cell.gz - data.cz * CHUNK
      if (data.cellKind[cIdx(lx, lz)] !== CELL_BRIDGE) continue
      for (const [axis, gx, gz] of [
        ['v', cell.gx, cell.gz],
        ['v', cell.gx + 1, cell.gz],
        ['h', cell.gx, cell.gz],
        ['h', cell.gx, cell.gz + 1],
      ]) {
        const state = latticeGlobalEdge(chunks, axis, gx, gz, cell.cy)
        if (state?.wall === 1 && state.feature === WALL_RAIL) {
          setLatticeGlobalEdge(
            chunks,
            axis,
            gx,
            gz,
            cell.cy,
            0,
            PASSAGE_WIDE,
            WALL_PLAIN
          )
          return
        }
      }
    }
  }
  throw new Error('expected a generated Lattice bridge guard')
}

function replaceGeneratedLatticeDescriptor(chunks, damage) {
  const descriptor = structuredClone(chunks.values().next().value.structure)
  damage(descriptor)
  for (const data of chunks.values()) data.structure = descriptor
  return descriptor
}

function auditLatticeFixture(chunks) {
  const descriptor = chunks.values().next().value.structure
  const xs = descriptor.participants.map(({ cx }) => cx)
  const zs = descriptor.participants.map(({ cz }) => cz)
  const x0 = Math.min(...xs)
  const z0 = Math.min(...zs)
  return auditLayeredPatch(
    lookup(chunks),
    x0,
    descriptor.baseCy,
    z0,
    Math.max(...xs) - x0 + 1,
    descriptor.levelCount,
    Math.max(...zs) - z0 + 1
  )
}

function auditVoidFixture(chunks) {
  return auditLayeredPatch(lookup(chunks), 0, 0, 0, 1, 2, 1)
}

function officeAtriumFixture() {
  const data = new ChunkData(
    0,
    1,
    0,
    0,
    DEFAULT_WORLD_CONFIG.version,
    MAP_FAMILY_OFFICE
  )
  const id = 0x0ff1ce
  const participants = [{ cx: 0, cz: 0 }, { cx: 1, cz: 0 }]
  const atriumCell = { lx: 5, lz: 5 }
  data.structure = {
    id,
    kind: STRUCTURE_KIND_OFFICE,
    baseCy: 0,
    topCy: 2,
    participants,
    anchor: participants[0],
  }
  data.structureDown = {
    id,
    hasRoom: true,
    kind: 'openVoid',
    baseCy: 0,
    topCy: 2,
    lowerCy: 0,
    levelCy: 1,
    voidCells: [atriumCell],
    bridgeCells: [],
  }
  return { data, atriumCell }
}

describe('layered world integrity audit', () => {
  it('accepts a real generated patch as one coherent 3D graph', () => {
    const seed = 1337
    const config = denseConfig()
    const chunks = new Map()
    for (let cy = -1; cy <= 1; cy++) {
      for (let cz = -1; cz <= 0; cz++) {
        for (let cx = -1; cx <= 0; cx++) {
          chunks.set(key(cx, cy, cz), buildChunk(seed, cx, cy, cz, config))
        }
      }
    }

    const audit = auditLayeredPatch(lookup(chunks), -1, -1, -1, 2, 3, 2)
    expect(audit.chunks).toBe(12)
    expect(audit.slabs).toBe(8)
    expect(audit.stairPairs).toBe(8)
    expect(audit.canonicalLinks).toBe(8)
    expect(audit.mismatchedDescriptors).toBe(0)
    expect(audit.holeMismatches).toBe(0)
    expect(audit.orphanedHalves).toBe(0)
    expect(audit.invalidCanonicalLinks).toBe(0)
    expect(audit.components).toBe(1)
    expect(audit.disconnectedCells).toBe(0)
    expect(audit.connected).toBe(true)
    expect(audit.ok).toBe(true)
  })

  it('reports an orphan half and every resulting slab-hole disagreement', () => {
    const chunks = generatedPair()
    chunks.get(key(0, 1, 0)).stairDown = null

    const audit = auditLayeredPatch(lookup(chunks), 0, 0, 0, 1, 2, 1)
    expect(audit.orphanedHalves).toBe(1)
    expect(audit.details.orphanedHalves[0].half).toBe('lower.stairUp')
    expect(audit.holeMismatchSlabs).toBe(1)
    expect(audit.holeMismatches).toBe(2)
    expect(audit.canonicalLinks).toBe(0)
    expect(audit.connected).toBe(false)
    expect(audit.ok).toBe(false)
  })

  it('separates descriptor mismatches from hole-cell mismatches', () => {
    const chunks = generatedPair(992)
    const upper = chunks.get(key(0, 1, 0))
    const down = upper.stairDown
    // Replace one upper hole with the landing. The lower descriptor remains
    // untouched: one expected hole disappears and one unexpected hole appears.
    upper.stairDown = {
      ...down,
      run: [{ ...down.landing }, { ...down.run[1] }],
    }

    const audit = auditLayeredPatch(lookup(chunks), 0, 0, 0, 1, 2, 1)
    expect(audit.stairPairs).toBe(1)
    expect(audit.mismatchedDescriptors).toBe(1)
    expect(audit.holeMismatchSlabs).toBe(1)
    expect(audit.holeMismatches).toBe(2)
    expect(audit.orphanedHalves).toBe(0)
    expect(audit.canonicalLinks).toBe(0)
    expect(audit.invalidCanonicalLinks).toBe(0)
    expect(audit.ok).toBe(false)
  })

  it('rejects a canonical landing-to-exit link with a blocked endpoint', () => {
    const chunks = generatedPair(993)
    const lower = chunks.get(key(0, 0, 0))
    lower.setCol(lower.stairUp.landing.lx, lower.stairUp.landing.lz, 1)

    const audit = auditLayeredPatch(lookup(chunks), 0, 0, 0, 1, 2, 1)
    expect(audit.mismatchedDescriptors).toBe(0)
    expect(audit.holeMismatches).toBe(0)
    expect(audit.invalidCanonicalLinks).toBe(1)
    expect(audit.details.invalidCanonicalLinks[0].reasons).toContain('blocked lower landing')
    expect(audit.canonicalLinks).toBe(0)
    expect(audit.connected).toBe(false)
    expect(audit.ok).toBe(false)
  })

  it('reports a stamped stair whose protected mouth or guard raster drifted', () => {
    const chunks = generatedPair(994)
    const lower = chunks.get(key(0, 0, 0))
    const stair = lower.stairUp
    const outer = {
      lx: stair.landing.lx - STAIR_DX[stair.dir],
      lz: stair.landing.lz - STAIR_DZ[stair.dir],
    }
    if (stair.dir === 1 || stair.dir === 3) {
      lower.setV(Math.max(outer.lx, stair.landing.lx), stair.landing.lz, 1)
    } else {
      lower.setH(stair.landing.lx, Math.max(outer.lz, stair.landing.lz), 1)
    }

    const audit = auditLayeredPatch(lookup(chunks), 0, 0, 0, 1, 2, 1)
    expect(audit.invalidCanonicalLinks).toBe(1)
    expect(audit.details.invalidCanonicalLinks[0].reasons).toContain('invalid lower mouth')
    expect(audit.ok).toBe(false)
  })

  it('uses owned walls when finding disconnected 3D graph components', () => {
    const data = new ChunkData(0, 0, 0, 0)
    // Isolate one ordinary interior cell in an otherwise open chunk.
    data.setV(5, 5, 1)
    data.setV(6, 5, 1)
    data.setH(5, 5, 1)
    data.setH(5, 6, 1)
    const chunks = new Map([[key(0, 0, 0), data]])

    const audit = auditLayeredPatch(lookup(chunks), 0, 0, 0, 1, 1, 1)
    expect(audit.walkableCells).toBe(14 * 14)
    expect(audit.componentSizes).toEqual([14 * 14 - 1, 1])
    expect(audit.components).toBe(2)
    expect(audit.disconnectedCells).toBe(1)
    expect(audit.connected).toBe(false)
    expect(audit.ok).toBe(false)
  })
})

describe('descriptor-scoped lethal void audit (task 3.1 RED)', () => {
  it.each([MAP_FAMILY_TOWER, MAP_FAMILY_LATTICE])(
    'R09/R13/D08 accepts one matched %s lethal-void slab pair',
    (family) => {
      const { chunks, lower, upper } = lethalVoidFixture(family)
      expect(lower.lethalVoidUp).toEqual(upper.lethalVoidDown)

      const audit = auditVoidFixture(chunks)
      expect(
        audit.lethalVoidPairs,
        'D08 missing matched lethal-void half registration in layered audit'
      ).toBe(1)
      expect(audit.mismatchedLethalVoidDescriptors).toBe(0)
      expect(audit.orphanedLethalVoidHalves).toBe(0)
      expect(audit.ok).toBe(true)
    }
  )

  it.each([MAP_FAMILY_TOWER, MAP_FAMILY_LATTICE])(
    'R18/D08 derives matching slab holes for authored %s lethal cells',
    (family) => {
      const { lower, upper, cells } = lethalVoidFixture(family)
      for (const { lx, lz } of cells) {
        expect(
          lower.hasCeilHole(lx, lz),
          'D08 lower lethalVoidUp must own the ceiling hole'
        ).toBe(true)
        expect(
          upper.hasFloorHole(lx, lz),
          'D08 upper lethalVoidDown must own the matching floor hole'
        ).toBe(true)
      }
    }
  )

  it.each([
    {
      name: 'canonical ids',
      reason: 'canonical-id-mismatch',
      mutate(half) {
        half.id++
      },
    },
    {
      name: 'families',
      reason: 'family-mismatch',
      mutate(half) {
        half.family = MAP_FAMILY_LATTICE
      },
    },
    {
      name: 'lower floors',
      reason: 'lower-floor-mismatch',
      mutate(half) {
        half.lowerCy++
      },
    },
    {
      name: 'cell sets',
      reason: 'cell-mismatch',
      mutate(half) {
        half.cells = [
          ...half.cells.slice(0, -1),
          { lx: CHUNK - 2, lz: CHUNK - 2, deathYmm: half.cells.at(-1).deathYmm },
        ]
      },
    },
    {
      name: 'death planes',
      reason: 'death-plane-mismatch',
      mutate(half) {
        half.cells[0].deathYmm++
      },
    },
  ])('R09/R13/D08 rejects mismatched lethal-void $name', ({ reason, mutate }) => {
    const { chunks, upper } = lethalVoidFixture(MAP_FAMILY_TOWER)
    mutate(upper.lethalVoidDown)

    const audit = auditVoidFixture(chunks)
    expect(
      audit.mismatchedLethalVoidDescriptors,
      `D08 missing lethal-void parity rejection for ${reason}`
    ).toBe(1)
    expect(audit.details.mismatchedLethalVoidDescriptors[0].reasons).toContain(reason)
    expect(audit.ok).toBe(false)
  })

  it.each([
    {
      name: 'lower up half',
      half: 'lower.lethalVoidUp',
      remove({ lower }) {
        lower.lethalVoidUp = null
      },
    },
    {
      name: 'upper down half',
      half: 'upper.lethalVoidDown',
      remove({ upper }) {
        upper.lethalVoidDown = null
      },
    },
  ])('R13/D08 rejects an orphaned $name', ({ half, remove }) => {
    const fixture = lethalVoidFixture(MAP_FAMILY_LATTICE)
    remove(fixture)

    const audit = auditVoidFixture(fixture.chunks)
    expect(
      audit.orphanedLethalVoidHalves,
      'D08 missing orphaned lethal-void half rejection'
    ).toBe(1)
    expect(audit.details.orphanedLethalVoidHalves[0].half).toBe(half)
    expect(audit.ok).toBe(false)
  })

  it.each([MAP_FAMILY_TOWER, MAP_FAMILY_LATTICE])(
    'R18/D06/D08 exposes only the authored %s death plane through its adapter',
    (family) => {
      const { upper, descriptor, cells } = lethalVoidFixture(family)
      const adapter = structureAdapterFor(descriptor)
      expect(adapter).not.toBeNull()
      expect(adapter.hardVoidAt(upper, 0, 0)).toBeNull()
      expect(
        adapter.hardVoidAt(upper, cells[0].lx, cells[0].lz),
        'D06/D08 family adapter must resolve an authored lethal descriptor cell'
      ).toEqual({
        id: descriptor.id,
        family,
        deathYmm: cells[0].deathYmm,
      })
    }
  )

  it('R18/D08 fails closed for a malformed local lethal half', () => {
    const { chunks, upper, descriptor, cells } = lethalVoidFixture(MAP_FAMILY_TOWER)
    const adapter = structureAdapterFor(descriptor)
    const { lx, lz, deathYmm } = cells[0]
    const validPlane = adapter.hardVoidAt(upper, lx, lz)
    const validHole = upper.hasFloorHole(lx, lz)

    upper.lethalVoidDown.cells = [
      { ...cells[0] },
      { ...cells[0] },
    ]

    const malformedPlane = adapter.hardVoidAt(upper, lx, lz)
    const malformedHole = upper.hasFloorHole(lx, lz)
    const audit = auditVoidFixture(chunks)
    expect({ validPlane, validHole, malformedPlane, malformedHole }).toEqual({
      validPlane: { id: descriptor.id, family: MAP_FAMILY_TOWER, deathYmm },
      validHole: true,
      malformedPlane: null,
      malformedHole: false,
    })
    expect(audit.mismatchedLethalVoidDescriptors).toBe(1)
    expect(audit.details.mismatchedLethalVoidDescriptors[0].reasons)
      .toEqual(['cell-mismatch'])
    expect(audit.ok).toBe(false)
  })

  it('R09/R18/D08 fails closed when canonical structure ownership lookup fails', () => {
    const { chunks, upper, descriptor, cells } = lethalVoidFixture(MAP_FAMILY_TOWER)
    const adapter = structureAdapterFor(descriptor)
    const { lx, lz, deathYmm } = cells[0]
    const validPlane = adapter.hardVoidAt(upper, lx, lz)
    const participants = [{ cx: 1, cz: 0 }, { cx: 2, cz: 0 }]
    upper.structure = {
      ...descriptor,
      participants,
      anchor: participants[0],
    }

    const unownedPlane = adapter.hardVoidAt(upper, lx, lz)
    const audit = auditVoidFixture(chunks)
    expect({ validPlane, unownedPlane }).toEqual({
      validPlane: { id: descriptor.id, family: MAP_FAMILY_TOWER, deathYmm },
      unownedPlane: null,
    })
    expect(audit.mismatchedLethalVoidDescriptors).toBe(1)
    expect(audit.details.mismatchedLethalVoidDescriptors[0].reasons)
      .toEqual(['void-ownership-mismatch'])
    expect(audit.ok).toBe(false)
  })

  it('R18/D08 keeps ordinary office atrium voids and open cells non-lethal', () => {
    const { data, atriumCell } = officeAtriumFixture()
    const sewer = new ChunkData(
      0,
      1,
      0,
      0,
      DEFAULT_WORLD_CONFIG.version,
      MAP_FAMILY_SEWER
    )
    expect(OFFICE_STRUCTURE_ADAPTER.hardVoidAt(data, atriumCell.lx, atriumCell.lz)).toBeNull()
    expect(OFFICE_STRUCTURE_ADAPTER.hardVoidAt(data, 0, 0)).toBeNull()
    expect(TOWER_STRUCTURE_ADAPTER.hardVoidAt(sewer, atriumCell.lx, atriumCell.lz)).toBeNull()
  })

  it('R13/D06 rejects a lethal half whose structure kind has no explicit adapter', () => {
    const { chunks, lower, upper } = lethalVoidFixture(MAP_FAMILY_TOWER)
    const unregistered = {
      ...lower.structure,
      kind: 'unregisteredVoidStructure',
    }
    lower.structure = unregistered
    upper.structure = unregistered
    expect(structureAdapterFor(unregistered)).toBeNull()

    const audit = auditVoidFixture(chunks)
    expect(audit.kindAdapterFailures).toBe(1)
    expect(audit.details.familyAuditFailures.map(({ reason }) => reason))
      .toContain('missing-kind-adapter')
    expect(audit.ok).toBe(false)
  })

  it('R13-S07/D08 rejects a damaged required guard in a lethal tower fixture', () => {
    const { chunks, lower } = lethalVoidFixture(MAP_FAMILY_TOWER)
    const stair = lower.stairUp
    const runCell = stair.run[0]
    if (stair.dir === 1 || stair.dir === 3) {
      lower.setH(runCell.lx, runCell.lz, 0)
    } else {
      lower.setV(runCell.lx, runCell.lz, 0)
    }

    const audit = auditVoidFixture(chunks)
    expect(audit.invalidCanonicalLinks).toBe(1)
    expect(audit.details.invalidCanonicalLinks[0].reasons)
      .toContain('invalid lower guard wall')
    expect(audit.ok).toBe(false)
  })
})

describe('Tower layered registration and landmark coverage (task 4.2 RED)', () => {
  it('audits mixed authored sockets once per canonical Tower while reusing the validated lethal plane', () => {
    const { chunks, upper, descriptor, cells } = authoredTowerVoidFixture()
    const adapter = structureAdapterFor(descriptor)
    const plane = adapter.hardVoidAt(upper, cells[0].lx, cells[0].lz)
    const audit = auditVoidFixture(chunks)

    expect(new Set(descriptor.landmarkSockets.map(({ kind }) => kind)))
      .toEqual(new Set(TOWER_LANDMARK_KINDS))
    expect(plane).toEqual({
      id: descriptor.id,
      family: MAP_FAMILY_TOWER,
      deathYmm: cells[0].deathYmm,
    })
    expect(audit.lethalVoidPairs).toBe(1)
    expect(audit.familyAudit).toMatchObject({
      familyCounts: { tower: 2 },
      kindCounts: { towerSkybridge: 2 },
      landmarkKindCounts: {
        clock: 1,
        door: 1,
        fixture: 1,
        litAccent: 1,
        signage: 1,
      },
    })
    expect(audit.familyDescriptorFailures).toBe(0)
    expect(audit.ok).toBe(true)
  })

  it('rejects a Tower whose second skybridge approach has no authored socket', () => {
    const { chunks, descriptor } = authoredTowerVoidFixture(17043)
    descriptor.landmarkSockets = descriptor.landmarkSockets.filter(
      ({ slot, side }) => slot !== 'bridgeApproach' || side !== 1
    )

    const audit = auditVoidFixture(chunks)
    const failures = audit.details.familyAuditFailures

    expect(audit.familyDescriptorFailures).toBe(1)
    expect(failures).toContainEqual({
      family: MAP_FAMILY_TOWER,
      kind: STRUCTURE_KIND_TOWER,
      reason: 'tower:missing-landmark-socket',
    })
    expect(audit.ok).toBe(false)
  })

  it('rejects one repeated accent kind as a substitute for mixed authored landmarks', () => {
    const { chunks, descriptor } = authoredTowerVoidFixture(17044)
    descriptor.landmarkSockets = descriptor.landmarkSockets.map((socket) => ({
      ...socket,
      kind: 'litAccent',
    }))

    const audit = auditVoidFixture(chunks)
    const failures = audit.details.familyAuditFailures

    expect(audit.familyDescriptorFailures).toBe(1)
    expect(failures).toContainEqual({
      family: MAP_FAMILY_TOWER,
      kind: STRUCTURE_KIND_TOWER,
      reason: 'tower:mixed-landmark-kinds',
    })
    expect(audit.ok).toBe(false)
  })

  it('rejects procedural decoration with no authored landmark socket descriptors', () => {
    const { chunks, descriptor } = authoredTowerVoidFixture(17045)
    descriptor.landmarkSockets = []
    descriptor.proceduralDecoration = true

    const audit = auditVoidFixture(chunks)
    const failures = audit.details.familyAuditFailures

    expect(audit.familyDescriptorFailures).toBe(1)
    expect(failures).toContainEqual({
      family: MAP_FAMILY_TOWER,
      kind: STRUCTURE_KIND_TOWER,
      reason: 'tower:missing-landmark-socket',
    })
    expect(audit.ok).toBe(false)
  })
})

describe('Lattice layered stamping, cues, and lethal parity (task 5.2 RED)', () => {
  it('audits all three open floors, both connector slabs, combined cues, and matched lethal halves', () => {
    const { chunks, upper, descriptor, cells } = authoredLatticeVoidFixture()
    const adapter = structureAdapterFor(descriptor)
    const plane = adapter.hardVoidAt(upper, cells[0].lx, cells[0].lz)
    const audit = auditLatticeFixture(chunks)

    expect(descriptor.participants).toHaveLength(9)
    expect(descriptor.anchors).toHaveLength(25)
    expect(descriptor.anchors.some((anchor) => anchor.exposureM === undefined)).toBe(true)
    expect(descriptor.anchors.some((anchor) => anchor.exposureM === 20)).toBe(true)
    expect(plane).toEqual({
      id: descriptor.id,
      family: MAP_FAMILY_LATTICE,
      deathYmm: cells[0].deathYmm,
    })
    expect(audit.lethalVoidPairs).toBe(18)
    expect(audit.familyAudit).toMatchObject({
      familyCounts: { lattice: 27 },
      kindCounts: { latticeDistrict: 27 },
      latticeMetrics: {
        anchorCount: 25,
        floorCoverage: [0, 1, 2],
        horizontalBridges: expect.any(Number),
        verticalConnectors: 2,
        defaultExposureM: 5,
        maximumExposureM: 20,
        minimumCombinedCueCells: expect.any(Number),
        maximumPlainWallSides: 2,
        enclosedRoomSlices: 0,
      },
    })
    expect(audit.familyAudit.latticeMetrics.minimumCombinedCueCells)
      .toBeGreaterThanOrEqual(8)
    expect(audit.familyDescriptorFailures).toBe(0)
    expect({
      invalidMultilevelRooms: audit.invalidMultilevelRooms,
      invalidCanonicalLinks: audit.invalidCanonicalLinks,
      invalidMultilevelStructures: audit.invalidMultilevelStructures,
      missingMultilevelSlices: audit.missingMultilevelSlices,
      closedBridgeSeams: audit.closedBridgeSeams,
      connected: audit.connected,
      components: audit.components,
    }).toEqual({
      invalidMultilevelRooms: 0,
      invalidCanonicalLinks: 0,
      invalidMultilevelStructures: 0,
      missingMultilevelSlices: 0,
      closedBridgeSeams: 0,
      // Generic walk-graph components remain one per floor until task 5.7
      // integrates runtime apertures. Task 5.6 accepts the strict canonical
      // graph/stamp/link family evidence without claiming that later runtime.
      connected: false,
      components: 3,
    })
    expect(audit.ok).toBe(true)
  })

  it('rejects an exposure override above twenty metres', () => {
    const { chunks } = authoredLatticeVoidFixture(18052)
    replaceGeneratedLatticeDescriptor(chunks, (candidate) => {
      candidate.anchors.at(-1).exposureM = 21
    })

    const audit = auditLatticeFixture(chunks)

    expect(audit.details.familyAuditFailures).toContainEqual({
      family: MAP_FAMILY_LATTICE,
      kind: STRUCTURE_KIND_LATTICE,
      reason: 'lattice:exposure-range',
    })
    expect(audit.ok).toBe(false)
  })

  it('rejects a damaged horizontal bridge guard', () => {
    const { chunks, descriptor } = authoredLatticeVoidFixture(18053)
    damageGeneratedLatticeGuard(chunks, descriptor)

    const audit = auditLatticeFixture(chunks)

    expect(audit.details.familyAuditFailures).toContainEqual({
      family: MAP_FAMILY_LATTICE,
      kind: STRUCTURE_KIND_LATTICE,
      reason: 'lattice:invalid-guard',
    })
    expect(audit.ok).toBe(false)
  })

  it('requires bridge seams in addition to chamber rail-perimeter cues', () => {
    const { chunks, descriptor } = authoredLatticeVoidFixture(18054)
    damageGeneratedLatticeCues(chunks, descriptor)

    const audit = auditLatticeFixture(chunks)

    expect(audit.details.familyAuditFailures).toContainEqual({
      family: MAP_FAMILY_LATTICE,
      kind: STRUCTURE_KIND_LATTICE,
      reason: 'lattice:cue-count',
    })
    expect(audit.ok).toBe(false)
  })

  it('rejects an enclosed-room identity with three plain-wall chamber sides', () => {
    const { chunks, descriptor } = authoredLatticeVoidFixture(18055)
    damageGeneratedLatticePlainSides(chunks, descriptor)

    const audit = auditLatticeFixture(chunks)

    expect(audit.details.familyAuditFailures).toContainEqual({
      family: MAP_FAMILY_LATTICE,
      kind: STRUCTURE_KIND_LATTICE,
      reason: 'lattice:plain-wall-sides',
    })
    expect(audit.ok).toBe(false)
  })

  it('keeps both Lattice lethal halves byte-matched across each internal slab', () => {
    const { lower, upper, top } = authoredLatticeVoidFixture(18056)

    expect(lower.lethalVoidUp).toEqual(upper.lethalVoidDown)
    expect(upper.lethalVoidUp).toEqual(top.lethalVoidDown)
    expect(lower.lethalVoidUp.cells.every(({ deathYmm }) => Number.isInteger(deathYmm)))
      .toBe(true)
    expect(upper.lethalVoidUp.cells.every(({ deathYmm }) => Number.isInteger(deathYmm)))
      .toBe(true)
  })
})
