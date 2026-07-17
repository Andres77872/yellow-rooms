import { describe, expect, it } from 'vitest'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { CHUNK, LOAD_RADIUS } from '../constants.js'
import { hash2i } from '../core/hash.js'
import { layerSeed, SALT_LAYER } from '../layerSeed.js'
import {
  chunkMultilevelRooms,
  DEFAULT_MULTILEVEL_CONFIG,
  multilevelConfig,
  multilevelContract,
  multilevelStructureAt,
  normalizeMultilevelConfig,
} from '../multilevel.js'

const SEEDS = [7, 12345, 0xdeadbeef >>> 0]

function testConfig(multilevel = {}) {
  const config = structuredClone(DEFAULT_WORLD_CONFIG)
  config.multilevel = { ...DEFAULT_MULTILEVEL_CONFIG, ...multilevel }
  return config
}

function districtStructure(seed, districtX, districtZ, baseCy, config) {
  const K = multilevelConfig(config).districtChunks
  const found = []
  for (let dz = 0; dz < K; dz++) {
    for (let dx = 0; dx < K; dx++) {
      const cx = districtX * K + dx
      const cz = districtZ * K + dz
      const structure = multilevelContract(seed, cx, cz, baseCy, config)
      if (structure.hasRoom) found.push(structure)
    }
  }
  expect(found).toHaveLength(1)
  return found[0]
}

const globalKey = ({ gx, gz }) => `${gx},${gz}`

function globalCells(slice, cx, cz, field) {
  return slice[field].map(({ lx, lz }) => ({
    gx: cx * CHUNK + lx,
    gz: cz * CHUNK + lz,
  }))
}

describe('canonical tall multilevel structures', () => {
  it('keeps the established root-to-layer seed mapping', () => {
    for (const seed of SEEDS) {
      expect(layerSeed(seed, 0)).toBe(seed >>> 0)
      for (const cy of [-17, -2, -1, 1, 2, 19]) {
        expect(layerSeed(seed, cy)).toBe(hash2i((seed ^ SALT_LAYER) | 0, cy, 0))
      }
    }
    expect(SALT_LAYER).toBe(0x4c59)
  })

  it('normalizes cross-chunk spans, 3..10 levels, period, kinds and mutable configs', () => {
    expect(multilevelConfig(structuredClone(DEFAULT_WORLD_CONFIG)))
      .toEqual(DEFAULT_MULTILEVEL_CONFIG)
    expect(normalizeMultilevelConfig).toBe(multilevelConfig)

    const config = testConfig({
      districtChunks: 1,
      longSpan: 2,
      shortSpan: 1,
      minLevels: 99,
      maxLevels: -4,
      verticalPeriod: 2,
      bridgeChance: Infinity,
      salt: NaN,
    })
    const normalized = multilevelConfig(config)
    expect(normalized.districtChunks).toBe(2)
    expect(normalized.longSpan).toBe(CHUNK + 1)
    expect(normalized.shortSpan).toBe(4)
    expect(normalized.minLevels).toBe(3)
    expect(normalized.maxLevels).toBe(10)
    expect(normalized.verticalPeriod).toBe(11)
    expect(normalized.bridgeChance).toBe(DEFAULT_MULTILEVEL_CONFIG.bridgeChance)
    expect(normalized.salt).toBe(DEFAULT_MULTILEVEL_CONFIG.salt)
    expect(multilevelConfig(config)).toBe(normalized)

    config.multilevel.districtChunks = LOAD_RADIUS + 99
    config.multilevel.bridgeChance = 0
    const changed = multilevelConfig(config)
    expect(changed).not.toBe(normalized)
    expect(changed.districtChunks).toBe(LOAD_RADIUS + 1)
    expect(changed.bridgeChance).toBe(0)
  })

  it('elects exactly one deterministic two-chunk owner per district and valid band', () => {
    const config = testConfig()
    const period = multilevelConfig(config).verticalPeriod
    for (const seed of SEEDS) {
      for (const baseCy of [-period, 0, period]) {
        for (const [districtX, districtZ] of [[-2, -1], [0, 0], [3, -4]]) {
          const first = districtStructure(seed, districtX, districtZ, baseCy, config)
          expect(districtStructure(seed, districtX, districtZ, baseCy, config)).toBe(first)
          expect(first.baseCy).toBe(baseCy)
          expect(first.participants).toHaveLength(2)
          if (baseCy === 0 && districtX === 0 && districtZ === 0) {
            expect(first.participants).not.toContainEqual({ cx: 0, cz: 0 })
          }
        }
      }
    }
    expect(multilevelContract(7, 0, 0, 1, config)).toEqual({ baseCy: 1, hasRoom: false })
  })

  it('uses a globally bounded footprint longer than one chunk with an exterior ring', () => {
    const config = testConfig({ minLevels: 4, maxLevels: 10 })
    const axes = new Set()
    for (const seed of SEEDS) {
      const structure = districtStructure(seed, -1, 2, 0, config)
      axes.add(structure.bridgeAxis)
      const { x0, z0, x1, z1 } = structure.globalBounds
      const width = x1 - x0 + 1
      const depth = z1 - z0 + 1
      expect([width, depth].sort((a, b) => b - a)).toEqual([
        config.multilevel.longSpan,
        config.multilevel.shortSpan,
      ])
      expect(Math.max(width, depth)).toBeGreaterThan(CHUNK)
      expect(structure.levelCount).toBeGreaterThanOrEqual(4)
      expect(structure.levelCount).toBeLessThanOrEqual(10)

      const [a, b] = structure.participants
      expect(Math.abs(a.cx - b.cx) + Math.abs(a.cz - b.cz)).toBe(1)
      if (structure.bridgeAxis === 'x') {
        expect(b).toEqual({ cx: a.cx + 1, cz: a.cz })
        expect(Math.floor(x0 / CHUNK)).toBe(a.cx)
        expect(Math.floor(x1 / CHUNK)).toBe(b.cx)
      } else {
        expect(b).toEqual({ cx: a.cx, cz: a.cz + 1 })
        expect(Math.floor(z0 / CHUNK)).toBe(a.cz)
        expect(Math.floor(z1 / CHUNK)).toBe(b.cz)
      }
      for (const p of structure.participants) {
        expect(multilevelStructureAt(seed, p.cx, p.cz, structure.baseCy, config)).toBe(structure)
      }
    }
    for (let seed = 0; seed < 32 && axes.size < 2; seed++) {
      axes.add(districtStructure(seed, 0, -1, 0, config).bridgeAxis)
    }
    expect(axes).toEqual(new Set(['x', 'z']))
  })

  it('builds several continuous multi-chunk decks on alternating upper levels', () => {
    const config = testConfig({ bridgeChance: 1, minLevels: 10, maxLevels: 10 })
    const structure = districtStructure(12345, -2, 1, -12, config)
    expect(structure.kind).toBe('bridged')
    expect(structure.levelCount).toBe(10)
    expect(structure.bridgeLevels.length).toBeGreaterThanOrEqual(2)
    expect(structure.decks).toHaveLength(structure.bridgeLevels.length)
    expect(Object.isFrozen(structure)).toBe(true)
    expect(Object.isFrozen(structure.decks[0].globalCells)).toBe(true)

    const lines = new Set()
    for (const deck of structure.decks) {
      lines.add(deck.globalBridgeLine)
      expect(deck.globalCells).toHaveLength(structure.longSpan)
      expect(deck.levelCy).toBeGreaterThan(structure.baseCy)
      expect(deck.levelCy).toBeLessThanOrEqual(structure.topCy)
      for (let i = 1; i < deck.globalCells.length; i++) {
        const a = deck.globalCells[i - 1]
        const b = deck.globalCells[i]
        expect(Math.abs(a.gx - b.gx) + Math.abs(a.gz - b.gz)).toBe(1)
      }
      const chunkKeys = new Set(deck.globalCells.map(({ gx, gz }) =>
        `${Math.floor(gx / CHUNK)},${Math.floor(gz / CHUNK)}`
      ))
      expect(chunkKeys.size).toBe(2)
    }
    expect(lines.size).toBe(2)
  })

  it('supports a bridge-less shaft with a complete aperture on every slab', () => {
    const config = testConfig({ bridgeChance: 0, minLevels: 6, maxLevels: 6 })
    const structure = districtStructure(7, 2, -3, -12, config)
    expect(structure.kind).toBe('openVoid')
    expect(structure.decks).toEqual([])
    expect(structure.bridgeLevels).toEqual([])

    const area = structure.longSpan * structure.shortSpan
    for (let lowerCy = structure.baseCy; lowerCy < structure.topCy; lowerCy++) {
      let voidCount = 0
      for (const p of structure.participants) {
        const slice = chunkMultilevelRooms(7, p.cx, p.cz, lowerCy, config).up
        expect(slice.hasRoom).toBe(true)
        expect(slice.kind).toBe('openVoid')
        expect(slice.globalBridgeLine).toBeNull()
        expect(slice.bridgeLine).toBeNull()
        expect(slice.bridgeCells).toEqual([])
        voidCount += slice.voidCells.length
      }
      expect(voidCount).toBe(area)
    }
  })

  it('partitions every slab globally and mirrors up(cy) as down(cy+1)', () => {
    const config = testConfig({ bridgeChance: 1, minLevels: 7, maxLevels: 7 })
    const seed = 0xdeadbeef >>> 0
    const structure = districtStructure(seed, -3, -2, -12, config)
    const expectedFootprint = new Set()
    for (let gz = structure.globalBounds.z0; gz <= structure.globalBounds.z1; gz++) {
      for (let gx = structure.globalBounds.x0; gx <= structure.globalBounds.x1; gx++) {
        expectedFootprint.add(`${gx},${gz}`)
      }
    }

    for (let lowerCy = structure.baseCy; lowerCy < structure.topCy; lowerCy++) {
      const actual = new Set()
      let bridgeCount = 0
      for (const p of structure.participants) {
        const lower = chunkMultilevelRooms(seed, p.cx, p.cz, lowerCy, config)
        const upper = chunkMultilevelRooms(seed, p.cx, p.cz, lowerCy + 1, config)
        expect(upper.down).toEqual(lower.up)
        expect(lower.structure).toBe(structure)
        for (const cell of globalCells(lower.up, p.cx, p.cz, 'voidCells')) {
          expect(actual.has(globalKey(cell))).toBe(false)
          actual.add(globalKey(cell))
        }
        for (const cell of globalCells(lower.up, p.cx, p.cz, 'bridgeCells')) {
          expect(actual.has(globalKey(cell))).toBe(false)
          actual.add(globalKey(cell))
          bridgeCount++
        }
      }
      expect(actual).toEqual(expectedFootprint)
      const hasDeck = structure.bridgeLevels.includes(lowerCy + 1)
      expect(bridgeCount).toBe(hasDeck ? structure.longSpan : 0)
    }
  })

  it('exposes bottom/middle/top ownership and no structure in clear band floors', () => {
    const config = testConfig({ minLevels: 4, maxLevels: 4, verticalPeriod: 7 })
    const structure = districtStructure(91, 1, 1, 0, config)
    const p = structure.participants[0]
    const bottom = chunkMultilevelRooms(91, p.cx, p.cz, structure.baseCy, config)
    const middle = chunkMultilevelRooms(91, p.cx, p.cz, structure.baseCy + 1, config)
    const top = chunkMultilevelRooms(91, p.cx, p.cz, structure.topCy, config)
    expect(bottom.down.hasRoom).toBe(false)
    expect(bottom.up.hasRoom).toBe(true)
    expect(middle.down.hasRoom).toBe(true)
    expect(middle.up.hasRoom).toBe(true)
    expect(top.down.hasRoom).toBe(true)
    expect(top.up.hasRoom).toBe(false)
    expect(multilevelStructureAt(91, p.cx, p.cz, structure.topCy + 1, config).hasRoom)
      .toBe(false)
  })

  it('disables contracts, structures and slices consistently', () => {
    const config = testConfig({ enabled: false })
    expect(multilevelContract(7, 3, -2, 0, config)).toEqual({ baseCy: 0, hasRoom: false })
    expect(multilevelStructureAt(7, 3, -2, 0, config)).toEqual({
      levelCy: 0,
      hasRoom: false,
    })
    const rooms = chunkMultilevelRooms(7, 3, -2, 0, config)
    expect(rooms.structure.hasRoom).toBe(false)
    expect(rooms.up.hasRoom).toBe(false)
    expect(rooms.down.hasRoom).toBe(false)
  })
})
