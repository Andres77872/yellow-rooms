import { describe, expect, it } from 'vitest'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import {
  CHUNK,
  LOAD_RADIUS,
  ZONE_OFFICE,
  ZONE_PILLARS,
} from '../constants.js'
import { hash2i } from '../core/hash.js'
import { layerSeed, SALT_LAYER } from '../layerSeed.js'
import {
  chunkMultilevelRooms,
  DEFAULT_MULTILEVEL_CONFIG,
  multilevelConfig,
  multilevelContract,
  normalizeMultilevelConfig,
} from '../multilevel.js'
import { selectZone } from '../regions.js'
import { slabContract } from '../slab.js'

const SEEDS = [7, 12345, 0xdeadbeef >>> 0]

function testConfig({ zone = ZONE_OFFICE, multilevel = {}, stairs = false } = {}) {
  const config = structuredClone(DEFAULT_WORLD_CONFIG)
  config.multilevel = { ...DEFAULT_MULTILEVEL_CONFIG, ...multilevel }
  if (zone !== null) config.zoneBands = [{ id: zone, max: 1.01 }]
  config.stairs.enabled = stairs
  return config
}

const key = ({ lx, lz }) => `${lx},${lz}`
const rowIndex = ({ lx, lz }) => lz * CHUNK + lx

function expectRowMajor(cells) {
  const indices = cells.map(rowIndex)
  expect(indices).toEqual([...indices].sort((a, b) => a - b))
}

describe('multilevel room contracts', () => {
  it('duplicates the exact layer seed formula without pipeline coupling', () => {
    for (const seed of SEEDS) {
      expect(layerSeed(seed, 0)).toBe(seed >>> 0)
      for (const cy of [-17, -2, -1, 1, 2, 19]) {
        expect(layerSeed(seed, cy)).toBe(hash2i((seed ^ SALT_LAYER) | 0, cy, 0))
      }
    }
    expect(SALT_LAYER).toBe(0x4c59)
  })

  it('normalizes defaults, malformed tuning, reversed spans, and mutable configs', () => {
    const withoutFeature = structuredClone(DEFAULT_WORLD_CONFIG)
    expect(multilevelConfig(withoutFeature)).toEqual(DEFAULT_MULTILEVEL_CONFIG)
    expect(normalizeMultilevelConfig).toBe(multilevelConfig)

    const config = testConfig({
      multilevel: {
        chance: Infinity,
        districtChunks: LOAD_RADIUS + 99,
        longSpan: 4,
        shortSpan: 9,
        salt: NaN,
      },
    })
    const normalized = multilevelConfig(config)
    expect(normalized.chance).toBe(DEFAULT_MULTILEVEL_CONFIG.chance)
    expect(normalized.districtChunks).toBe(LOAD_RADIUS + 1)
    expect(normalized.longSpan).toBe(9)
    expect(normalized.shortSpan).toBe(4)
    expect(normalized.salt).toBe(DEFAULT_MULTILEVEL_CONFIG.salt)
    expect(multilevelConfig(config)).toBe(normalized)

    config.multilevel.chance = 0
    expect(multilevelConfig(config)).not.toBe(normalized)
    expect(multilevelConfig(config).chance).toBe(0)
  })

  it('is deterministic, call-order independent, and root-seeded on negative floors', () => {
    const config = testConfig({ multilevel: { chance: 1 } })
    for (const seed of SEEDS) {
      const first = multilevelContract(seed, -7, 11, -2, config)
      expect(first.hasRoom).toBe(true)
      expect(first.id).toBeGreaterThanOrEqual(0)
      expect(first.id).toBeLessThanOrEqual(0xffffffff)
      multilevelContract(seed, 31, -19, 8, config)
      multilevelContract(seed ^ 0x55aa, -7, 11, -2, config)
      expect(multilevelContract(seed, -7, 11, -2, config)).toEqual(first)
    }
    expect(multilevelContract(SEEDS[0], -7, 11, -2, config).id)
      .not.toBe(multilevelContract(SEEDS[1], -7, 11, -2, config).id)
  })

  it('anchors only on even lower floors, including correct negative parity', () => {
    const config = testConfig({ multilevel: { chance: 1 } })
    for (let baseCy = -7; baseCy <= 7; baseCy++) {
      const room = multilevelContract(12345, 2, -3, baseCy, config)
      expect(room.hasRoom).toBe(baseCy % 2 === 0)
      expect(room.baseCy).toBe(baseCy)
    }
    expect(multilevelContract(12345, 0, 0, 0, config).hasRoom).toBe(false)
    expect(multilevelContract(12345, 0, 0, -2, config).hasRoom).toBe(true)
  })

  it('keeps the rectangle inside one chunk and partitions it into void plus bridge', () => {
    const config = testConfig({ multilevel: { chance: 1 } })
    const axes = new Set()
    for (const seed of SEEDS) {
      for (let cz = -4; cz <= 4; cz++) {
        for (let cx = -4; cx <= 4; cx++) {
          if (cx === 0 && cz === 0) continue
          const room = multilevelContract(seed, cx, cz, 0, config)
          expect(room.hasRoom).toBe(true)
          axes.add(room.bridgeAxis)
          const { x0, z0, x1, z1 } = room.bounds
          expect(x0).toBeGreaterThanOrEqual(1)
          expect(z0).toBeGreaterThanOrEqual(1)
          expect(x1).toBeLessThanOrEqual(CHUNK - 2)
          expect(z1).toBeLessThanOrEqual(CHUNK - 2)

          const width = x1 - x0 + 1
          const depth = z1 - z0 + 1
          const long = config.multilevel.longSpan
          const short = config.multilevel.shortSpan
          expect([width, depth].sort((a, b) => b - a)).toEqual([long, short])
          expect(room.bridgeCells).toHaveLength(long)
          expect(room.voidCells).toHaveLength(long * short - long)

          const bridge = new Set(room.bridgeCells.map(key))
          const openVoid = new Set(room.voidCells.map(key))
          expect(bridge.size).toBe(room.bridgeCells.length)
          expect(openVoid.size).toBe(room.voidCells.length)
          for (const cell of room.bridgeCells) expect(openVoid.has(key(cell))).toBe(false)
          for (let lz = z0; lz <= z1; lz++) {
            for (let lx = x0; lx <= x1; lx++) {
              expect(bridge.has(`${lx},${lz}`) || openVoid.has(`${lx},${lz}`)).toBe(true)
            }
          }
          expectRowMajor(room.bridgeCells)
          expectRowMajor(room.voidCells)
        }
      }
    }
    expect(axes).toEqual(new Set(['x', 'z']))
  })

  it('runs a one-cell-wide bridge continuously along the long axis to opposite banks', () => {
    const config = testConfig({ multilevel: { chance: 1 } })
    for (const seed of SEEDS) {
      for (const [cx, cz] of [[-5, -3], [-2, 6], [4, -7], [8, 9]]) {
        const room = multilevelContract(seed, cx, cz, 2, config)
        expect(room.hasRoom).toBe(true)
        const { x0, z0, x1, z1 } = room.bounds
        if (room.bridgeAxis === 'x') {
          expect(new Set(room.bridgeCells.map((cell) => cell.lz))).toEqual(
            new Set([room.bridgeLine])
          )
          expect(room.bridgeCells.map((cell) => cell.lx)).toEqual(
            Array.from({ length: x1 - x0 + 1 }, (_, i) => x0 + i)
          )
          expect(room.bridgeCells[0].lx).toBe(x0)
          expect(room.bridgeCells.at(-1).lx).toBe(x1)
        } else {
          expect(new Set(room.bridgeCells.map((cell) => cell.lx))).toEqual(
            new Set([room.bridgeLine])
          )
          expect(room.bridgeCells.map((cell) => cell.lz)).toEqual(
            Array.from({ length: z1 - z0 + 1 }, (_, i) => z0 + i)
          )
          expect(room.bridgeCells[0].lz).toBe(z0)
          expect(room.bridgeCells.at(-1).lz).toBe(z1)
        }
      }
    }
  })

  it('rejects every chunk with a stair contract on any of the three touching slabs', () => {
    const config = testConfig({ multilevel: { chance: 1 }, stairs: true })
    let conflicts = 0
    let rooms = 0
    for (const seed of SEEDS) {
      for (const baseCy of [-2, 0, 2]) {
        for (let cz = -5; cz <= 5; cz++) {
          for (let cx = -5; cx <= 5; cx++) {
            if (cx === 0 && cz === 0 && baseCy === 0) continue
            const conflict = [baseCy - 1, baseCy, baseCy + 1]
              .some((slabCy) => slabContract(seed, cx, cz, slabCy, config).hasStair)
            const room = multilevelContract(seed, cx, cz, baseCy, config)
            if (conflict) {
              conflicts++
              expect(room.hasRoom).toBe(false)
            } else {
              rooms++
              expect(room.hasRoom).toBe(true)
            }
          }
        }
      }
    }
    expect(conflicts).toBeGreaterThan(0)
    expect(rooms).toBeGreaterThan(0)
  })

  it('requires the same non-pillars zone on both participating floors', () => {
    const natural = testConfig({ zone: null, multilevel: { chance: 1 } })
    let mismatch = null
    for (let seed = 1; seed <= 20 && !mismatch; seed++) {
      for (let cz = -12; cz <= 12 && !mismatch; cz++) {
        for (let cx = -12; cx <= 12; cx++) {
          const lower = selectZone(cx, cz, layerSeed(seed, -2), natural)
          const upper = selectZone(cx, cz, layerSeed(seed, -1), natural)
          if (lower !== upper) {
            mismatch = { seed, cx, cz }
            break
          }
        }
      }
    }
    expect(mismatch).not.toBeNull()
    expect(
      multilevelContract(mismatch.seed, mismatch.cx, mismatch.cz, -2, natural).hasRoom
    ).toBe(false)

    const pillars = testConfig({ zone: ZONE_PILLARS, multilevel: { chance: 1 } })
    expect(multilevelContract(12345, 3, 4, -2, pillars).hasRoom).toBe(false)
  })

  it('elects exactly one fallback among eligible district chunks when chance is zero', () => {
    const config = testConfig({ multilevel: { chance: 0 } })
    const K = config.multilevel.districtChunks
    for (const seed of SEEDS) {
      for (const baseCy of [-2, 0, 2]) {
        for (const [districtX, districtZ] of [[-2, -1], [0, 0], [3, -4]]) {
          let rooms = 0
          for (let dz = 0; dz < K; dz++) {
            for (let dx = 0; dx < K; dx++) {
              const cx = districtX * K + dx
              const cz = districtZ * K + dz
              if (multilevelContract(seed, cx, cz, baseCy, config).hasRoom) rooms++
            }
          }
          expect(rooms).toBe(1)
        }
      }
    }
  })

  it('elects fallback from a sparse eligible set rather than a fixed district slot', () => {
    const config = testConfig({ zone: null, multilevel: { chance: 0 }, stairs: true })
    const K = config.multilevel.districtChunks
    let nonEmptyDistricts = 0
    for (const baseCy of [-2, 0, 2]) {
      for (const [districtX, districtZ] of [[-3, 1], [-1, -1], [1, 2], [4, -2]]) {
        let eligible = 0
        let rooms = 0
        for (let dz = 0; dz < K; dz++) {
          for (let dx = 0; dx < K; dx++) {
            const cx = districtX * K + dx
            const cz = districtZ * K + dz
            const lower = selectZone(cx, cz, layerSeed(12345, baseCy), config)
            const upper = selectZone(cx, cz, layerSeed(12345, baseCy + 1), config)
            const stairs = [baseCy - 1, baseCy, baseCy + 1]
              .some((slabCy) => slabContract(12345, cx, cz, slabCy, config).hasStair)
            const spawn = cx === 0 && cz === 0 && baseCy === 0
            if (lower === upper && lower !== ZONE_PILLARS && !stairs && !spawn) eligible++
            if (multilevelContract(12345, cx, cz, baseCy, config).hasRoom) rooms++
          }
        }
        if (eligible > 0) nonEmptyDistricts++
        expect(rooms).toBe(eligible > 0 ? 1 : 0)
      }
    }
    expect(nonEmptyDistricts).toBeGreaterThan(0)
  })

  it('mirrors the vertical ownership key: up(cy) equals down(cy+1)', () => {
    const config = testConfig({ multilevel: { chance: 1 } })
    for (const seed of SEEDS) {
      for (const [cx, cz] of [[-7, 11], [2, -3], [9, 4]]) {
        for (let cy = -5; cy <= 5; cy++) {
          const here = chunkMultilevelRooms(seed, cx, cz, cy, config)
          const above = chunkMultilevelRooms(seed, cx, cz, cy + 1, config)
          expect(above.down).toEqual(here.up)
        }
      }
    }
  })

  it('disables all contracts without affecting their ownership shape', () => {
    const config = testConfig({ multilevel: { enabled: false, chance: 1 } })
    for (const seed of SEEDS) {
      for (let baseCy = -4; baseCy <= 4; baseCy++) {
        expect(multilevelContract(seed, 3, -2, baseCy, config)).toEqual({
          baseCy,
          hasRoom: false,
        })
      }
    }
  })
})
