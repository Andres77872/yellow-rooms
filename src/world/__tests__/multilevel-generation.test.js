import { describe, expect, it } from 'vitest'
import { auditLayeredPatch } from '../audit.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { CHUNK, cIdx } from '../constants.js'
import { generateChunk } from '../generate.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_VOID,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  WALL_PLAIN,
  WALL_RAIL,
  WALL_WINDOW,
} from '../mapTypes.js'
import { multilevelConfig, multilevelContract } from '../multilevel.js'
import { countChunkComponents } from '../topology.js'

const key3 = (cx, cy, cz) => `${cx},${cy},${cz}`

function forcedConfig({ kind = 'bridged', levels = 10 } = {}) {
  const config = structuredClone(DEFAULT_WORLD_CONFIG)
  config.multilevel.bridgeChance = kind === 'bridged' ? 1 : 0
  config.multilevel.minLevels = levels
  config.multilevel.maxLevels = levels
  return config
}

function districtStructure(seed, districtX, districtZ, baseCy, config) {
  const K = multilevelConfig(config).districtChunks
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
  let windows = 0
  let mouths = 0

  for (let gz = z0; gz <= z1; gz++) {
    const bridgeEnd = bridgeLine !== null && structure.bridgeAxis === 'x' && gz === bridgeLine
    for (const lineGX of [x0, x1 + 1]) {
      const state = vState(chunks, lineGX, gz, cy)
      if (bridgeEnd) {
        expectOpenApproach(state)
        mouths++
      } else {
        expectWindow(state)
        windows++
      }
    }
  }
  for (let gx = x0; gx <= x1; gx++) {
    const bridgeEnd = bridgeLine !== null && structure.bridgeAxis === 'z' && gx === bridgeLine
    for (const lineGZ of [z0, z1 + 1]) {
      const state = hState(chunks, gx, lineGZ, cy)
      if (bridgeEnd) {
        expectOpenApproach(state)
        mouths++
      } else {
        expectWindow(state)
        windows++
      }
    }
  }

  let rails = 0
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
  it('stamps a ten-level, two-chunk bridge stack with exact holes and semantics', () => {
    const seed = 1337
    const config = forcedConfig({ kind: 'bridged', levels: 10 })
    const structure = districtStructure(seed, 0, -2, 0, config)
    const chunks = generateStructure(seed, structure, config)
    const footprintArea = structure.longSpan * structure.shortSpan

    for (const { cx, cz } of structure.participants) {
      const bottom = get(chunks, cx, structure.baseCy, cz)
      expect(bottom.multilevelStructure).toEqual(structure)
      expect(bottom.multilevelDown).toBeNull()
      expect(bottom.stairDown).toBeNull()
      expect(bottom.stairUp).toBeNull()
      expect(countChunkComponents(bottom, true)).toBe(1)
    }
    expect(featureCounts(chunks, structure, structure.baseCy)).toEqual({
      windows: 0,
      rails: 0,
    })

    for (let lowerCy = structure.baseCy; lowerCy < structure.topCy; lowerCy++) {
      let slabCells = 0
      for (const { cx, cz } of structure.participants) {
        const lower = get(chunks, cx, lowerCy, cz)
        const upper = get(chunks, cx, lowerCy + 1, cz)
        expect(lower.multilevelUp).toEqual(upper.multilevelDown)
        expect(lower.multilevelUp.lowerCy).toBe(lowerCy)
        expect(lower.stairUp).toBeNull()
        expect(upper.stairDown).toBeNull()
        for (let z = 0; z < CHUNK; z++) {
          for (let x = 0; x < CHUNK; x++) {
            expect(lower.hasCeilHole(x, z)).toBe(upper.hasFloorHole(x, z))
          }
        }
        slabCells += lower.multilevelUp.voidCells.length + lower.multilevelUp.bridgeCells.length
      }
      expect(slabCells).toBe(footprintArea)
    }

    const bounds = structure.globalBounds
    for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
      const deck = structure.decks.find((candidate) => candidate.levelCy === cy)
      for (let gz = bounds.z0; gz <= bounds.z1; gz++) {
        for (let gx = bounds.x0; gx <= bounds.x1; gx++) {
          const { data, lx, lz } = cellData(chunks, gx, gz, cy)
          expect(data.colAt(lx, lz)).toBe(0)
          expect(data.spaceId[cIdx(lx, lz)]).toBe(structure.id)
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
    const config = forcedConfig({ kind: 'bridged', levels: 8 })
    const structure = districtStructure(seed, -2, 2, -12, config)
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

  it('creates a ten-level open shaft with all perimeter windows and no bridge artifacts', () => {
    const seed = 8128
    const config = forcedConfig({ kind: 'openVoid', levels: 10 })
    const structure = districtStructure(seed, 1, -1, 0, config)
    const chunks = generateStructure(seed, structure, config)
    expect(structure.decks).toEqual([])

    for (let cy = structure.baseCy + 1; cy <= structure.topCy; cy++) {
      expectSurfaceEdges(chunks, structure, cy)
      for (const { cx, cz } of structure.participants) {
        const data = get(chunks, cx, cy, cz)
        expect(data.multilevelDown.bridgeCells).toEqual([])
        expect(data.multilevelDown.globalBridgeLine).toBeNull()
        for (const { lx, lz } of data.multilevelDown.voidCells) {
          expect(data.hasFloorHole(lx, lz)).toBe(true)
          expect(data.cellKind[cIdx(lx, lz)]).toBe(CELL_VOID)
        }
      }
    }
  })

  it('keeps one uninterrupted sight shaft from the windowless bottom to the solid top ceiling', () => {
    const seed = 144
    const config = forcedConfig({ kind: 'bridged', levels: 10 })
    const structure = districtStructure(seed, -1, -1, -12, config)
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
    const config = forcedConfig({ kind: 'bridged', levels: 6 })
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
        up: data.multilevelUp,
        down: data.multilevelDown,
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
        up: data.multilevelUp,
        down: data.multilevelDown,
      })).toBe(snapshots.get(key3(request.cx, request.cy, request.cz)))
    }
  })
})

describe('tall-structure audit integration', () => {
  it('accepts a complete generated structure patch', () => {
    const seed = 404
    const config = forcedConfig({ kind: 'bridged', levels: 6 })
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
    expect(audit.multilevelSlices).toBe(4 * (structure.levelCount - 1))
    expect(audit.invalidMultilevelStructures).toBe(0)
    expect(audit.missingMultilevelSlices).toBe(0)
    expect(audit.closedBridgeSeams).toBe(0)
    expect(audit.connected).toBe(true)
    expect(audit.ok).toBe(true)
  })

  it('detects a missing loaded slice, a damaged window, and a closed bridge seam', () => {
    const seed = 405
    const config = forcedConfig({ kind: 'bridged', levels: 8 })
    const structure = districtStructure(seed, -2, 1, -12, config)

    {
      const chunks = generateStructure(seed, structure, config)
      const participant = structure.participants[0]
      const lower = get(chunks, participant.cx, structure.baseCy + 1, participant.cz)
      lower.multilevelUp = null
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
