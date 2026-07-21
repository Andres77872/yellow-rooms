import { describe, expect, it } from 'vitest'
import { auditLayeredPatch } from '../audit.js'
import { Chunk } from '../Chunk.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { CELL, CHUNK, CHUNK_WORLD, cIdx } from '../constants.js'
import { generateChunk } from '../generate.js'
import { deepFreeze, worldConfigForFamily } from '../mapFamily.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_VOID,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  WALL_PLAIN,
  WALL_RAIL,
  WALL_WINDOW,
} from '../mapTypes.js'
import {
  multilevelBandBase,
  multilevelConfig,
  multilevelContract,
  multilevelTerminalOverlookLine,
} from '../structures/multilevel.js'
import { structureAt } from '../structures/contract.js'
import { countChunkComponents } from '../topology.js'
import { discoverTowerFixture } from './tower-fixture.js'

const key3 = (cx, cy, cz) => `${cx},${cy},${cz}`

function forcedConfig({ kind = 'bridged', levels = 15 } = {}) {
  const config = structuredClone(DEFAULT_WORLD_CONFIG)
  config.multilevel.bridgeChance = kind === 'bridged' ? 1 : 0
  config.multilevel.minLevels = levels
  config.multilevel.maxLevels = levels
  return config
}

function districtStructure(seed, districtX, districtZ, levelCy, config) {
  const K = multilevelConfig(config).districtChunks
  const baseCy = multilevelBandBase(
    seed,
    districtX * K,
    districtZ * K,
    levelCy,
    config
  )
  for (let dz = 0; dz < K; dz++) {
    for (let dx = 0; dx < K; dx++) {
      const room = multilevelContract(
        seed,
        districtX * K + dx,
        districtZ * K + dz,
        baseCy,
        config
      )
      if (room.hasRoom) return room
    }
  }
  throw new Error('expected canonical structure')
}

function generateStructure(seed, structure, config) {
  const chunks = new Map()
  for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
    for (const { cx, cz } of structure.participants) {
      chunks.set(key3(cx, cy, cz), generateChunk(seed, cx, cy, cz, config))
    }
  }
  return chunks
}

function generateStructureDistrict(seed, structure, config) {
  const chunks = new Map()
  const K = multilevelConfig(config).districtChunks
  const x0 = structure.district.x * K
  const z0 = structure.district.z * K
  for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
    for (let cz = z0; cz < z0 + K; cz++) {
      for (let cx = x0; cx < x0 + K; cx++) {
        chunks.set(key3(cx, cy, cz), generateChunk(seed, cx, cy, cz, config))
      }
    }
  }
  return { chunks, x0, z0, size: K }
}

let towerGenerationDiscovery = null

function plannedTowerGenerationFixture() {
  if (!towerGenerationDiscovery) {
    towerGenerationDiscovery = discoverTowerFixture()
  }

  expect(
    towerGenerationDiscovery.structure,
    'task 4.3 RED: the forced Tower profile must expose one canonical bounded structure'
  ).toBeDefined()
  const { seed, config, structure } = towerGenerationDiscovery
  return {
    seed,
    config,
    structure,
    chunks: generateStructure(seed, structure, config),
  }
}

const LATTICE_SCAN_SEEDS = Object.freeze([0x1a771ce, 0x51a771ce, 0xc0ffee])
let latticeGenerationDiscovery = null

function plannedLatticeGenerationFixture() {
  if (!latticeGenerationDiscovery) {
    const base = structuredClone(DEFAULT_WORLD_CONFIG)
    base.mapFamily.profiles[MAP_FAMILY_LATTICE].enabled = true
    const config = worldConfigForFamily(MAP_FAMILY_LATTICE, base)

    for (const seed of LATTICE_SCAN_SEEDS) {
      for (let cy = -24; cy <= 24; cy++) {
        for (let cz = -4; cz <= 4; cz++) {
          for (let cx = -4; cx <= 4; cx++) {
            const structure = structureAt(seed, cx, cz, cy, config)
            if (
              structure?.hasRoom === true &&
              structure.family === MAP_FAMILY_LATTICE &&
              structure.kind === 'latticeDistrict'
            ) {
              latticeGenerationDiscovery = { config, seed, structure }
              break
            }
          }
          if (latticeGenerationDiscovery) break
        }
        if (latticeGenerationDiscovery) break
      }
      if (latticeGenerationDiscovery) break
    }

    latticeGenerationDiscovery ??= { config, seed: null, structure: null }
  }

  expect(
    latticeGenerationDiscovery.structure,
    'task 5.3 RED: forced Lattice generation must expose one canonical 4x4x5 district'
  ).not.toBeNull()
  const { seed, config, structure } = latticeGenerationDiscovery
  return {
    seed,
    config,
    structure,
    chunks: generateStructure(seed, structure, config),
  }
}

const get = (chunks, cx, cy, cz) => chunks.get(key3(cx, cy, cz)) || null

function vState(chunks, lineGX, gz, cy) {
  const cx = Math.floor(lineGX / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  const data = get(chunks, cx, cy, cz)
  const line = lineGX - cx * CHUNK
  const cell = gz - cz * CHUNK
  return {
    wall: data.vAt(line, cell),
    passage: data.passageVAt(line, cell),
    feature: data.wallFeatureVAt(line, cell),
  }
}

function hState(chunks, gx, lineGZ, cy) {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(lineGZ / CHUNK)
  const data = get(chunks, cx, cy, cz)
  const cell = gx - cx * CHUNK
  const line = lineGZ - cz * CHUNK
  return {
    wall: data.hAt(cell, line),
    passage: data.passageHAt(cell, line),
    feature: data.wallFeatureHAt(cell, line),
  }
}

function cellData(chunks, gx, gz, cy) {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  const data = get(chunks, cx, cy, cz)
  return {
    data,
    lx: gx - cx * CHUNK,
    lz: gz - cz * CHUNK,
  }
}

function localApertureCells(aperture, cx, cz) {
  const cells = new Set()
  const chunkX = cx * CHUNK_WORLD
  const chunkZ = cz * CHUNK_WORLD
  for (const region of aperture.regions) {
    const x0 = (region.minX - chunkX) / CELL
    const x1 = (region.maxX - chunkX) / CELL
    const z0 = (region.minZ - chunkZ) / CELL
    const z1 = (region.maxZ - chunkZ) / CELL
    expect([x0, x1, z0, z1].every(Number.isInteger)).toBe(true)
    expect(x0).toBeGreaterThanOrEqual(0)
    expect(z0).toBeGreaterThanOrEqual(0)
    expect(x1).toBeLessThanOrEqual(CHUNK)
    expect(z1).toBeLessThanOrEqual(CHUNK)
    expect(x1).toBeGreaterThan(x0)
    expect(z1).toBeGreaterThan(z0)
    for (let lz = z0; lz < z1; lz++) {
      for (let lx = x0; lx < x1; lx++) cells.add(`${lx},${lz}`)
    }
  }
  return cells
}

function featureCounts(chunks, structure, cy) {
  let windows = 0
  let rails = 0
  for (const { cx, cz } of structure.participants) {
    const data = get(chunks, cx, cy, cz)
    for (let i = 0; i < data.wallFeatureV.length; i++) {
      for (const feature of [data.wallFeatureV[i], data.wallFeatureH[i]]) {
        if (feature === WALL_WINDOW) windows++
        if (feature === WALL_RAIL) rails++
      }
    }
  }
  return { windows, rails }
}

function expectWindow(state) {
  expect(state).toEqual({
    wall: 1,
    passage: PASSAGE_WALL,
    feature: WALL_WINDOW,
  })
}

function expectRail(state) {
  expect(state).toEqual({
    wall: 1,
    passage: PASSAGE_WALL,
    feature: WALL_RAIL,
  })
}

function expectOpenApproach(state) {
  expect(state).toEqual({
    wall: 0,
    passage: PASSAGE_WIDE,
    feature: WALL_PLAIN,
  })
}

function expectSurfaceEdges(chunks, structure, cy) {
  const { x0, z0, x1, z1 } = structure.globalBounds
  const deck = structure.decks.find((candidate) => candidate.levelCy === cy)
  const bridgeLine = deck?.globalBridgeLine ?? null
  const overlookLine = multilevelTerminalOverlookLine({ ...structure, levelCy: cy })
  let windows = 0
  let mouths = 0
  let rails = 0

  for (let gz = z0; gz <= z1; gz++) {
    const bridgeEnd = bridgeLine !== null && structure.bridgeAxis === 'x' && gz === bridgeLine
    const terminalEdge = overlookLine !== null && structure.bridgeAxis === 'x' && gz === overlookLine
    for (const lineGX of [x0, x1 + 1]) {
      const state = vState(chunks, lineGX, gz, cy)
      if (bridgeEnd) {
        expectOpenApproach(state)
        mouths++
      } else if (terminalEdge) {
        expectRail(state)
        rails++
      } else {
        expectWindow(state)
        windows++
      }
    }
  }
  for (let gx = x0; gx <= x1; gx++) {
    const bridgeEnd = bridgeLine !== null && structure.bridgeAxis === 'z' && gx === bridgeLine
    const terminalEdge = overlookLine !== null && structure.bridgeAxis === 'z' && gx === overlookLine
    for (const lineGZ of [z0, z1 + 1]) {
      const state = hState(chunks, gx, lineGZ, cy)
      if (bridgeEnd) {
        expectOpenApproach(state)
        mouths++
      } else if (terminalEdge) {
        expectRail(state)
        rails++
      } else {
        expectWindow(state)
        windows++
      }
    }
  }

  if (deck) {
    for (const { gx, gz } of deck.globalCells) {
      if (structure.bridgeAxis === 'x') {
        expectRail(hState(chunks, gx, gz, cy))
        expectRail(hState(chunks, gx, gz + 1, cy))
      } else {
        expectRail(vState(chunks, gx, gz, cy))
        expectRail(vState(chunks, gx + 1, gz, cy))
      }
      rails += 2
    }
  }
  expect(featureCounts(chunks, structure, cy)).toEqual({ windows, rails })
  expect(mouths).toBe(deck ? 2 : 0)
}

describe('generated tall structures', () => {
  it('stamps a 15-storey, two-chunk bridge stack with exact holes and semantics', () => {
    const seed = 1337
    const config = forcedConfig({ kind: 'bridged', levels: 15 })
    const structure = districtStructure(seed, 0, -2, 0, config)
    const chunks = generateStructure(seed, structure, config)
    const footprintArea = structure.longSpan * structure.shortSpan
    expect(structure.levelCount).toBe(15)
    expect(structure.topCy).toBe(structure.baseCy + 14)
    expect(structure.decks).toHaveLength(7)
    expect(chunks.size).toBe(30)

    for (const { cx, cz } of structure.participants) {
      const bottom = get(chunks, cx, structure.baseCy, cz)
      expect(bottom.structure).toEqual(structure)
      expect(bottom.structureDown).toBeNull()
      expect(bottom.stairDown).toBeNull()
      expect(bottom.stairUp).toBeNull()
      expect(countChunkComponents(bottom, true)).toBe(1)
    }
    expect(featureCounts(chunks, structure, structure.baseCy)).toEqual({
      windows: 0,
      rails: 0,
    })

    let matchingSlabPairs = 0
    for (let lowerCy = structure.baseCy; lowerCy < structure.topCy; lowerCy++) {
      let slabCells = 0
      for (const { cx, cz } of structure.participants) {
        const lower = get(chunks, cx, lowerCy, cz)
        const upper = get(chunks, cx, lowerCy + 1, cz)
        expect(lower.structureUp).toEqual(upper.structureDown)
        expect(lower.structureUp.lowerCy).toBe(lowerCy)
        expect(lower.stairUp).toBeNull()
        expect(upper.stairDown).toBeNull()
        for (let z = 0; z < CHUNK; z++) {
          for (let x = 0; x < CHUNK; x++) {
            expect(lower.hasCeilHole(x, z)).toBe(upper.hasFloorHole(x, z))
          }
        }
        slabCells += lower.structureUp.voidCells.length + lower.structureUp.bridgeCells.length
      }
      expect(slabCells).toBe(footprintArea)
      matchingSlabPairs++
    }
    expect(matchingSlabPairs).toBe(14)

    const bounds = structure.globalBounds
    for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
      const deck = structure.decks.find((candidate) => candidate.levelCy === cy)
      for (let gz = bounds.z0; gz <= bounds.z1; gz++) {
        for (let gx = bounds.x0; gx <= bounds.x1; gx++) {
          const { data, lx, lz } = cellData(chunks, gx, gz, cy)
          expect(data.colAt(lx, lz)).toBe(0)
          expect(data.spaceId[cIdx(lx, lz)]).toBe(structure.id)
          if (cy === structure.topCy) expect(data.hasCeilHole(lx, lz)).toBe(false)
          if (cy === structure.baseCy) {
            expect(data.cellKind[cIdx(lx, lz)]).toBe(CELL_ATRIUM)
            expect(data.hasFloorHole(lx, lz)).toBe(false)
            continue
          }
          const onBridge = !!deck && (structure.bridgeAxis === 'x'
            ? gz === deck.globalBridgeLine
            : gx === deck.globalBridgeLine)
          expect(data.cellKind[cIdx(lx, lz)]).toBe(onBridge ? CELL_BRIDGE : CELL_VOID)
          expect(data.hasFloorHole(lx, lz)).toBe(!onBridge)
        }
      }
      if (cy > structure.baseCy) expectSurfaceEdges(chunks, structure, cy)
    }
  })

  it('keeps every bridge continuous through the owned chunk seam', () => {
    const seed = 27
    const config = forcedConfig({ kind: 'bridged', levels: 15 })
    const structure = districtStructure(seed, -2, 2, -17, config)
    const chunks = generateStructure(seed, structure, config)

    for (const deck of structure.decks) {
      for (let i = 1; i < deck.globalCells.length; i++) {
        const a = deck.globalCells[i - 1]
        const b = deck.globalCells[i]
        const state = structure.bridgeAxis === 'x'
          ? vState(chunks, b.gx, a.gz, deck.levelCy)
          : hState(chunks, a.gx, b.gz, deck.levelCy)
        expect(state.wall).toBe(0)
      }
      const participantKeys = new Set(deck.globalCells.map(({ gx, gz }) =>
        `${Math.floor(gx / CHUNK)},${Math.floor(gz / CHUNK)}`
      ))
      expect(participantKeys.size).toBe(2)
    }
  })

  it('creates a 15-storey open shaft with a guarded terminal overlook and no bridge artifacts', () => {
    const seed = 8128
    const config = forcedConfig({ kind: 'openVoid', levels: 15 })
    const structure = districtStructure(seed, 1, -1, 0, config)
    const chunks = generateStructure(seed, structure, config)
    expect(structure.decks).toEqual([])

    for (let cy = structure.baseCy + 1; cy <= structure.topCy; cy++) {
      expectSurfaceEdges(chunks, structure, cy)
      const features = featureCounts(chunks, structure, cy)
      expect(features.rails).toBe(cy === structure.topCy ? 2 : 0)
      for (const { cx, cz } of structure.participants) {
        const data = get(chunks, cx, cy, cz)
        expect(data.structureDown.bridgeCells).toEqual([])
        expect(data.structureDown.globalBridgeLine).toBeNull()
        for (const { lx, lz } of data.structureDown.voidCells) {
          expect(data.hasFloorHole(lx, lz)).toBe(true)
          expect(data.cellKind[cIdx(lx, lz)]).toBe(CELL_VOID)
        }
      }
    }
  })

  it('keeps one uninterrupted sight shaft from the windowless bottom to the solid top ceiling', () => {
    const seed = 144
    const config = forcedConfig({ kind: 'bridged', levels: 15 })
    const structure = districtStructure(seed, -1, -1, -17, config)
    const chunks = generateStructure(seed, structure, config)
    const gx = structure.globalBounds.x0
    const gz = structure.globalBounds.z0

    for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
      const { data, lx, lz } = cellData(chunks, gx, gz, cy)
      if (cy === structure.baseCy) {
        expect(data.hasFloorHole(lx, lz)).toBe(false)
      } else {
        expect(data.hasFloorHole(lx, lz)).toBe(true)
      }
      if (cy === structure.topCy) {
        expect(data.hasCeilHole(lx, lz)).toBe(false)
      } else {
        expect(data.hasCeilHole(lx, lz)).toBe(true)
      }
    }
    expect(featureCounts(chunks, structure, structure.baseCy)).toEqual({ windows: 0, rails: 0 })
  })

  it('is generation-order independent across chunks and all floors', () => {
    const seed = 99991
    const config = forcedConfig({ kind: 'bridged', levels: 15 })
    const structure = districtStructure(seed, 2, 1, 0, config)
    const requests = []
    for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
      for (const p of structure.participants) requests.push({ ...p, cy })
    }
    const snapshots = new Map()
    for (const request of requests) {
      const data = generateChunk(seed, request.cx, request.cy, request.cz, config)
      snapshots.set(key3(request.cx, request.cy, request.cz), JSON.stringify({
        wallV: [...data.wallV],
        wallH: [...data.wallH],
        passageV: [...data.passageV],
        passageH: [...data.passageH],
        featureV: [...data.wallFeatureV],
        featureH: [...data.wallFeatureH],
        cellKind: [...data.cellKind],
        spaceId: [...data.spaceId],
        up: data.structureUp,
        down: data.structureDown,
      }))
    }
    for (const request of requests.reverse()) {
      const data = generateChunk(seed, request.cx, request.cy, request.cz, config)
      expect(JSON.stringify({
        wallV: [...data.wallV],
        wallH: [...data.wallH],
        passageV: [...data.passageV],
        passageH: [...data.passageH],
        featureV: [...data.wallFeatureV],
        featureH: [...data.wallFeatureH],
        cellKind: [...data.cellKind],
        spaceId: [...data.spaceId],
        up: data.structureUp,
        down: data.structureDown,
      })).toBe(snapshots.get(key3(request.cx, request.cy, request.cz)))
    }
  })
})

describe('tall-structure audit integration', () => {
  it('accepts complete maximum-height bridged and open-void patches', () => {
    for (const [kind, seed] of [['bridged', 404], ['openVoid', 406]]) {
      const config = forcedConfig({ kind, levels: 15 })
      const structure = districtStructure(seed, 1, 2, 0, config)
      const { chunks, x0, z0, size } = generateStructureDistrict(
        seed,
        structure,
        config
      )
      const audit = auditLayeredPatch(
        (cx, cy, cz) => get(chunks, cx, cy, cz),
        x0,
        structure.baseCy,
        z0,
        size,
        structure.levelCount,
        size
      )
      expect(audit.mismatchedMultilevelDescriptors).toBe(0)
      expect(audit.orphanedMultilevelHalves).toBe(0)
      expect(audit.holeMismatches).toBe(0)
      expect(audit.invalidMultilevelRooms).toBe(0)
      expect(audit.strayWallFeatures).toBe(0)
      expect(audit.multilevelStructures).toBe(1)
      expect(audit.multilevelPairs).toBe(28)
      expect(audit.multilevelSlices).toBe(56)
      expect(audit.invalidMultilevelStructures).toBe(0)
      expect(audit.missingMultilevelSlices).toBe(0)
      expect(audit.closedBridgeSeams).toBe(0)
      expect(audit.connected).toBe(true)
      expect(audit.ok).toBe(true)
    }
  })

  it('detects a missing loaded slice, a damaged window, and a closed bridge seam', () => {
    const seed = 405
    const config = forcedConfig({ kind: 'bridged', levels: 8 })
    const structure = districtStructure(seed, -2, 1, -17, config)

    {
      const chunks = generateStructure(seed, structure, config)
      const participant = structure.participants[0]
      const lower = get(chunks, participant.cx, structure.baseCy + 1, participant.cz)
      lower.structureUp = null
      const audit = auditLayeredPatch(
        (cx, cy, cz) => get(chunks, cx, cy, cz),
        Math.min(...structure.participants.map((p) => p.cx)),
        structure.baseCy,
        Math.min(...structure.participants.map((p) => p.cz)),
        Math.max(...structure.participants.map((p) => p.cx)) -
          Math.min(...structure.participants.map((p) => p.cx)) + 1,
        structure.levelCount,
        Math.max(...structure.participants.map((p) => p.cz)) -
          Math.min(...structure.participants.map((p) => p.cz)) + 1
      )
      expect(audit.orphanedMultilevelHalves).toBeGreaterThan(0)
      expect(audit.missingMultilevelSlices).toBeGreaterThan(0)
      expect(audit.ok).toBe(false)
    }

    {
      const chunks = generateStructure(seed, structure, config)
      const deck = structure.decks[0]
      let damaged = false
      for (const participant of structure.participants) {
        const upper = get(chunks, participant.cx, deck.levelCy, participant.cz)
        for (let z = 0; z < CHUNK && !damaged; z++) {
          for (let line = 0; line < CHUNK && !damaged; line++) {
            if (upper.wallFeatureVAt(line, z) === WALL_WINDOW) {
              upper.setV(line, z, 1, PASSAGE_WALL, WALL_PLAIN)
              damaged = true
            } else if (upper.wallFeatureHAt(z, line) === WALL_WINDOW) {
              upper.setH(z, line, 1, PASSAGE_WALL, WALL_PLAIN)
              damaged = true
            }
          }
        }
      }
      expect(damaged).toBe(true)
      const xs = structure.participants.map((p) => p.cx)
      const zs = structure.participants.map((p) => p.cz)
      const audit = auditLayeredPatch(
        (cx, cy, cz) => get(chunks, cx, cy, cz),
        Math.min(...xs),
        structure.baseCy,
        Math.min(...zs),
        Math.max(...xs) - Math.min(...xs) + 1,
        structure.levelCount,
        Math.max(...zs) - Math.min(...zs) + 1
      )
      expect(audit.invalidMultilevelRooms).toBeGreaterThan(0)
      expect(audit.details.invalidMultilevelRooms.flatMap((item) => item.reasons))
        .toContain('invalid observation window')
      expect(audit.ok).toBe(false)
    }

    {
      const chunks = generateStructure(seed, structure, config)
      const deck = structure.decks[0]
      if (structure.bridgeAxis === 'x') {
        const east = structure.participants.reduce((a, b) => a.cx > b.cx ? a : b)
        const upper = get(chunks, east.cx, deck.levelCy, east.cz)
        upper.setV(0, deck.globalBridgeLine - east.cz * CHUNK, 1)
      } else {
        const south = structure.participants.reduce((a, b) => a.cz > b.cz ? a : b)
        const upper = get(chunks, south.cx, deck.levelCy, south.cz)
        upper.setH(deck.globalBridgeLine - south.cx * CHUNK, 0, 1)
      }
      const xs = structure.participants.map((p) => p.cx)
      const zs = structure.participants.map((p) => p.cz)
      const audit = auditLayeredPatch(
        (cx, cy, cz) => get(chunks, cx, cy, cz),
        Math.min(...xs),
        structure.baseCy,
        Math.min(...zs),
        Math.max(...xs) - Math.min(...xs) + 1,
        structure.levelCount,
        Math.max(...zs) - Math.min(...zs) + 1
      )
      expect(audit.closedBridgeSeams).toBe(1)
      expect(audit.details.closedBridgeSeams[0].id).toBe(structure.id)
      expect(audit.ok).toBe(false)
    }
  })
})

describe('generated Tower aperture and bounded-audit integration (task 4.3 RED)', () => {
  it('[R15-S01..S03][R16-S01..S03][R17-S01..S02][R25-S01] carries one independent two-by-three Tower through matched stair/multilevel apertures and explicit safety audit evidence', () => {
    expect(DEFAULT_WORLD_CONFIG.mapFamily.selected).toBe(MAP_FAMILY_OFFICE)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles[MAP_FAMILY_SEWER].enabled).toBe(true)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles[MAP_FAMILY_TOWER].enabled).toBe(true)

    const { seed, config, structure, chunks } = plannedTowerGenerationFixture()
    expect(config.mapFamily.profiles[MAP_FAMILY_TOWER].enabled).toBe(true)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles[MAP_FAMILY_TOWER].enabled).toBe(true)
    expect(structure).toMatchObject({
      family: MAP_FAMILY_TOWER,
      kind: 'towerSkybridge',
      levelCount: 3,
      baseCy: expect.any(Number),
      topCy: expect.any(Number),
      globalBounds: {
        x0: expect.any(Number),
        z0: expect.any(Number),
        x1: expect.any(Number),
        z1: expect.any(Number),
      },
    })
    expect(structure.participants).toHaveLength(2)
    expect(structure.topCy - structure.baseCy).toBe(2)
    expect(structure.decks).toHaveLength(1)
    expect(structure.verticalLinks).toHaveLength(2)
    expect(Array.isArray(structure.landmarkSockets)).toBe(true)
    expect(chunks.size).toBe(6)

    for (const data of chunks.values()) {
      expect(data.mapFamily).toBe(MAP_FAMILY_TOWER)
      expect(data.structure).toEqual(structure)
      expect(data.structure.landmarkSockets).toEqual(
        structure.landmarkSockets
      )
    }

    for (let lowerCy = structure.baseCy; lowerCy < structure.topCy; lowerCy++) {
      for (const participant of structure.participants) {
        const lower = get(chunks, participant.cx, lowerCy, participant.cz)
        const upper = get(chunks, participant.cx, lowerCy + 1, participant.cz)
        expect(lower.structureUp).toEqual(upper.structureDown)
        expect(lower.structureUp).toMatchObject({
          id: structure.id,
          kind: 'towerSkybridge',
          lowerCy,
          hasRoom: true,
        })

        const chunk = Object.assign(Object.create(Chunk.prototype), {
          cx: participant.cx,
          cy: lowerCy,
          cz: participant.cz,
          data: lower,
          apertures: [],
        })
        chunk._registerStructureAperture(seed, config)
        expect(chunk.apertures).toHaveLength(1)
        expect(chunk.apertures[0]).toMatchObject({
          kind: 'multilevel',
          id: structure.id,
          lowerCy,
          baseCy: structure.baseCy,
          topCy: structure.topCy,
          structureKind: 'towerSkybridge',
        })
      }
    }

    const inferredParticipant = structure.participants[0]
    const inferredData = get(
      chunks,
      inferredParticipant.cx,
      structure.baseCy,
      inferredParticipant.cz
    )
    const inferredKind = { ...structure, kind: 'bridged' }
    const inferredChunk = Object.assign(Object.create(Chunk.prototype), {
      cx: inferredParticipant.cx,
      cy: structure.baseCy,
      cz: inferredParticipant.cz,
      data: {
        ...inferredData,
        structure: inferredKind,
      },
      apertures: [],
    })
    inferredChunk._registerStructureAperture(seed, config)
    expect(inferredChunk.apertures).toEqual([])

    for (const link of structure.verticalLinks) {
      const lower = get(chunks, link.cx, link.lowerCy, link.cz)
      const upper = get(chunks, link.cx, link.lowerCy + 1, link.cz)
      expect(lower?.stairUp).toEqual(link.stair)
      expect(upper?.stairDown).toEqual(link.stair)
    }

    const xs = structure.participants.map(({ cx }) => cx)
    const zs = structure.participants.map(({ cz }) => cz)
    const x0 = Math.min(...xs)
    const z0 = Math.min(...zs)
    const audit = auditLayeredPatch(
      (cx, cy, cz) => get(chunks, cx, cy, cz),
      x0,
      structure.baseCy,
      z0,
      Math.max(...xs) - x0 + 1,
      structure.levelCount,
      Math.max(...zs) - z0 + 1
    )
    expect(audit.chunks).toBe(6)
    expect(audit.stairPairs).toBe(2)
    expect(audit.multilevelPairs).toBe(4)
    expect(audit.lethalVoidPairs).toBeGreaterThan(0)
    expect(audit.mismatchedDescriptors).toBe(0)
    expect(audit.mismatchedMultilevelDescriptors).toBe(0)
    expect(audit.mismatchedLethalVoidDescriptors).toBe(0)
    expect(audit.orphanedLethalVoidHalves).toBe(0)
    expect(audit.closedBridgeSeams).toBe(0)
    expect(audit.familyAdapterFailures).toBe(0)
    expect(audit.kindAdapterFailures).toBe(0)
    expect(audit.familyDescriptorFailures).toBe(0)
    expect(audit.familyAudit.familyCounts).toEqual({ tower: 6 })
    expect(audit.familyAudit.kindCounts).toMatchObject({ towerSkybridge: 6 })
    expect(audit.connected).toBe(true)
    expect(audit.ok).toBe(true)
  })
})

describe('generated Lattice aperture and bounded-audit integration (task 5.3 RED)', () => {
  it('[R09-S01..S06][R12-S01..S03][R13-S01..S07][R15-S01..S03][R17-S01..S02][R29-S01..S02][R31-S03] preserves polygon/graph/stamp/safety parity across the finite all-floor fixture and rejects a missing floor', () => {
    expect(DEFAULT_WORLD_CONFIG.mapFamily.selected).toBe(MAP_FAMILY_OFFICE)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles[MAP_FAMILY_SEWER].enabled).toBe(true)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles[MAP_FAMILY_TOWER].enabled).toBe(true)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles[MAP_FAMILY_LATTICE].enabled).toBe(true)

    const { seed, config, structure, chunks } = plannedLatticeGenerationFixture()
    expect(config.mapFamily.profiles[MAP_FAMILY_LATTICE].enabled).toBe(true)
    expect(config.version).toBe(DEFAULT_WORLD_CONFIG.version)
    expect(structure).toMatchObject({
      family: MAP_FAMILY_LATTICE,
      kind: 'latticeDistrict',
      district: { size: 4 },
      levelCount: 5,
      baseCy: expect.any(Number),
      topCy: expect.any(Number),
      globalBounds: {
        x0: expect.any(Number),
        z0: expect.any(Number),
        x1: expect.any(Number),
        z1: expect.any(Number),
      },
    })
    expect(structure.participants).toHaveLength(16)
    expect(structure.anchors).toHaveLength(64)
    expect(structure.topCy - structure.baseCy).toBe(4)
    expect(structure).not.toHaveProperty('latticeSpan')
    expect(chunks.size).toBe(80)

    const participantKeys = structure.participants.map(({ cx, cz }) => `${cx},${cz}`)
    expect(new Set(participantKeys).size).toBe(16)
    expect(participantKeys).toEqual([...participantKeys].sort((a, b) => {
      const [ax, az] = a.split(',').map(Number)
      const [bx, bz] = b.split(',').map(Number)
      return az - bz || ax - bx
    }))
    const participantXs = new Set(structure.participants.map(({ cx }) => cx))
    const participantZs = new Set(structure.participants.map(({ cz }) => cz))
    expect(participantXs.size).toBe(4)
    expect(participantZs.size).toBe(4)
    expect(new Set([...participantZs].flatMap((cz) =>
      [...participantXs].map((cx) => `${cx},${cz}`)
    ))).toEqual(new Set(participantKeys))

    for (const data of chunks.values()) {
      expect(data.mapFamily).toBe(MAP_FAMILY_LATTICE)
      expect(data.structure).toEqual(structure)
    }

    for (const anchor of structure.anchors) {
      const { data, lx, lz } = cellData(
        chunks,
        anchor.gx,
        anchor.gz,
        anchor.levelCy
      )
      expect(data.spaceId[cIdx(lx, lz)]).toBe(structure.id)
      expect(data.cellKind[cIdx(lx, lz)]).not.toBe(CELL_VOID)
    }

    const horizontalEdges = structure.edges.filter(({ role }) => role !== 'vertical')
    const verticalEdges = structure.edges.filter(({ role }) => role === 'vertical')
    expect(horizontalEdges.length).toBeGreaterThan(0)
    expect(verticalEdges.length).toBeGreaterThan(0)
    for (const edge of structure.edges) {
      expect(edge.cells.length).toBeGreaterThan(0)
      for (const cell of edge.cells) {
        expect(Number.isInteger(cell.gx)).toBe(true)
        expect(Number.isInteger(cell.gz)).toBe(true)
        expect(Number.isInteger(cell.cy)).toBe(true)
        if (edge.role === 'vertical') continue
        const { data, lx, lz } = cellData(chunks, cell.gx, cell.gz, cell.cy)
        expect(data.spaceId[cIdx(lx, lz)]).toBe(structure.id)
        expect([CELL_ATRIUM, CELL_BRIDGE]).toContain(data.cellKind[cIdx(lx, lz)])
      }
    }

    let bridgeSegments = 0
    let lethalVoidPairs = 0
    const apertureFloors = new Set()
    for (let lowerCy = structure.baseCy; lowerCy < structure.topCy; lowerCy++) {
      for (const participant of structure.participants) {
        const lower = get(chunks, participant.cx, lowerCy, participant.cz)
        const upper = get(chunks, participant.cx, lowerCy + 1, participant.cz)
        expect(lower.structureUp).toEqual(upper.structureDown)
        expect(lower.structureUp).toMatchObject({
          id: structure.id,
          kind: 'latticeDistrict',
          lowerCy,
          hasRoom: true,
        })
        expect(Array.isArray(lower.structureUp.bridgeSegments)).toBe(true)
        bridgeSegments += lower.structureUp.bridgeSegments.length

        if (lower.lethalVoidUp || upper.lethalVoidDown) {
          expect(lower.lethalVoidUp).toEqual(upper.lethalVoidDown)
          expect(lower.lethalVoidUp).toMatchObject({
            id: structure.id,
            family: MAP_FAMILY_LATTICE,
            lowerCy,
          })
          for (const cell of lower.lethalVoidUp.cells) {
            expect(Number.isInteger(cell.deathYmm)).toBe(true)
          }
          lethalVoidPairs++
        }

        const chunk = Object.assign(Object.create(Chunk.prototype), {
          cx: participant.cx,
          cy: lowerCy,
          cz: participant.cz,
          data: lower,
          apertures: [],
        })
        chunk._registerStructureAperture(seed, config)
        expect(chunk.apertures).toHaveLength(1)
        const aperture = chunk.apertures[0]
        expect(aperture).toMatchObject({
          kind: 'multilevel',
          id: structure.id,
          lowerCy,
          baseCy: structure.baseCy,
          topCy: structure.topCy,
          structureKind: 'latticeDistrict',
        })
        expect(aperture.kind).not.toBe('latticeSpan')
        const apertureCells = localApertureCells(
          aperture,
          participant.cx,
          participant.cz
        )
        expect(apertureCells).toEqual(new Set(
          lower.structureUp.voidCells.map(({ lx, lz }) => `${lx},${lz}`)
        ))
        for (const { lx, lz } of lower.structureUp.bridgeCells) {
          expect(apertureCells).not.toContain(`${lx},${lz}`)
        }
        apertureFloors.add(lowerCy)
      }
    }
    expect(bridgeSegments).toBeGreaterThan(0)
    expect(lethalVoidPairs).toBeGreaterThan(0)
    expect(apertureFloors).toEqual(new Set([
      structure.baseCy,
      structure.baseCy + 1,
      structure.baseCy + 2,
      structure.baseCy + 3,
    ]))

    const parityParticipant = structure.participants.find(({ cx, cz }) => {
      const data = get(chunks, cx, structure.baseCy, cz)
      return data.structureUp.voidCells.length > 1
    })
    expect(parityParticipant).toBeDefined()
    const parityData = get(
      chunks,
      parityParticipant.cx,
      structure.baseCy,
      parityParticipant.cz
    )

    const mismatchedSlice = deepFreeze({
      ...structuredClone(parityData.structureUp),
      voidCells: parityData.structureUp.voidCells.slice(1),
    })
    const mismatchedSliceChunk = Object.assign(Object.create(Chunk.prototype), {
      cx: parityParticipant.cx,
      cy: structure.baseCy,
      cz: parityParticipant.cz,
      data: { ...parityData, structureUp: mismatchedSlice },
      apertures: [],
    })
    mismatchedSliceChunk._registerStructureAperture(seed, config)
    expect(mismatchedSliceChunk.apertures).toEqual([])

    const mismatchedGraph = structuredClone(structure)
    mismatchedGraph.edges = mismatchedGraph.edges.slice(1)
    deepFreeze(mismatchedGraph)
    const mismatchedGraphChunk = Object.assign(Object.create(Chunk.prototype), {
      cx: parityParticipant.cx,
      cy: structure.baseCy,
      cz: parityParticipant.cz,
      data: {
        ...parityData,
        structure: mismatchedGraph,
      },
      apertures: [],
    })
    mismatchedGraphChunk._registerStructureAperture(seed, config)
    expect(mismatchedGraphChunk.apertures).toEqual([])

    const xs = structure.participants.map(({ cx }) => cx)
    const zs = structure.participants.map(({ cz }) => cz)
    const x0 = Math.min(...xs)
    const z0 = Math.min(...zs)
    const sizeX = Math.max(...xs) - x0 + 1
    const sizeZ = Math.max(...zs) - z0 + 1
    expect(sizeX).toBe(4)
    expect(sizeZ).toBe(4)

    const audit = auditLayeredPatch(
      (cx, cy, cz) => get(chunks, cx, cy, cz),
      x0,
      structure.baseCy,
      z0,
      sizeX,
      structure.levelCount,
      sizeZ
    )
    expect(audit.chunks).toBe(80)
    expect(audit.missingMultilevelSlices).toBe(0)
    expect(audit.mismatchedDescriptors).toBe(0)
    expect(audit.mismatchedMultilevelDescriptors).toBe(0)
    expect(audit.mismatchedLethalVoidDescriptors).toBe(0)
    expect(audit.orphanedLethalVoidHalves).toBe(0)
    expect(audit.familyAdapterFailures).toBe(0)
    expect(audit.kindAdapterFailures).toBe(0)
    expect(audit.familyDescriptorFailures).toBe(0)
    expect(audit.familyAudit.familyCounts).toEqual({ lattice: 80 })
    expect(audit.familyAudit.kindCounts).toMatchObject({ latticeDistrict: 80 })
    // v24 makes the district one walkable component: the base floor is street
    // level (CELL_OPEN ground instead of fenced void) and every adjacent floor
    // pair is bridged by at least one canonical stair link, so the layered walk
    // graph — which traverses those links — reaches every floor.
    expect(audit.components).toBe(1)
    expect(audit.connected).toBe(true)
    expect(audit.ok).toBe(true)

    const missingFloorChunks = new Map(chunks)
    const missingParticipant = structure.participants.at(-1)
    missingFloorChunks.delete(key3(
      missingParticipant.cx,
      structure.topCy,
      missingParticipant.cz
    ))
    const missingFloorAudit = auditLayeredPatch(
      (cx, cy, cz) => get(missingFloorChunks, cx, cy, cz),
      x0,
      structure.baseCy,
      z0,
      sizeX,
      structure.levelCount,
      sizeZ
    )
    expect(missingFloorAudit.chunks).toBe(79)
    expect(missingFloorAudit.familyDescriptorFailures).toBeGreaterThan(0)
    expect(missingFloorAudit.ok).toBe(false)
  })
})
