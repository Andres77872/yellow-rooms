import { describe, expect, it } from 'vitest'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { CHUNK, LOAD_RADIUS } from '../constants.js'
import { hash2i } from '../core/hash.js'
import { layerSeed, SALT_LAYER } from '../layerSeed.js'
import * as multilevelApi from '../multilevel.js'

const {
  chunkMultilevelRooms,
  DEFAULT_MULTILEVEL_CONFIG,
  MAX_MULTILEVEL_TOP_CY,
  multilevelBandBase,
  multilevelConfig,
  multilevelContract,
  multilevelStructureAt,
  normalizeMultilevelConfig,
} = multilevelApi

const SEEDS = [7, 12345, 0xdeadbeef >>> 0]

function testConfig(multilevel = {}) {
  const config = structuredClone(DEFAULT_WORLD_CONFIG)
  config.multilevel = { ...DEFAULT_MULTILEVEL_CONFIG, ...multilevel }
  return config
}

function districtContractAtBase(seed, districtX, districtZ, baseCy, config) {
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
  expect(found.length).toBeLessThanOrEqual(1)
  return found[0] ?? null
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
  const structure = districtContractAtBase(
    seed,
    districtX,
    districtZ,
    baseCy,
    config
  )
  expect(structure).not.toBeNull()
  return structure
}

const globalKey = ({ gx, gz }) => `${gx},${gz}`

function globalCells(slice, cx, cz, field) {
  return slice[field].map(({ lx, lz }) => ({
    gx: cx * CHUNK + lx,
    gz: cz * CHUNK + lz,
  }))
}

const STRUCTURE_ADAPTERS_PATH = '../structureAdapters.js'

async function validateStructureFixture(structure, ownership) {
  let api
  try {
    api = await import(/* @vite-ignore */ STRUCTURE_ADAPTERS_PATH)
  } catch (error) {
    throw new Error(
      'D06 missing planned structureAdapters.js validation contract',
      { cause: error }
    )
  }
  const validate = api.validateStructureDescriptor
  expect(
    validate,
    'D06 requires a canonical family-aware structure validator'
  ).toBeTypeOf('function')
  return validate(structure, { ownership })
}

function officeStructureFixture() {
  return structuredClone(districtStructure(
    0x51ea7,
    -1,
    2,
    0,
    testConfig({ minLevels: 4, maxLevels: 4 })
  ))
}

function officeOwnership(structure) {
  return structure.participants.map((participant) => ({
    ...participant,
    id: structure.id,
    family: 'office',
    baseCy: structure.baseCy,
    topCy: structure.topCy,
  }))
}

const malformedOfficeStructures = [
  {
    name: 'R08-S04/R09-S02 rejects the generic one-participant acceptance path',
    reason: 'office:participant-cardinality',
    build() {
      const structure = officeStructureFixture()
      structure.participants = [structure.participants[0]]
      structure.participantChunks = structure.participants
      return { structure, ownership: officeOwnership(structure) }
    },
  },
  {
    name: 'R09 rejects duplicate participant coordinates',
    reason: 'office:duplicate-participant',
    build() {
      const structure = officeStructureFixture()
      structure.participants = [
        structure.participants[0],
        { ...structure.participants[0] },
      ]
      structure.participantChunks = structure.participants
      return { structure, ownership: officeOwnership(structure) }
    },
  },
  {
    name: 'R09-S03/D05 rejects a participant missing from ownership',
    reason: 'office:missing-participant',
    build() {
      const structure = officeStructureFixture()
      return {
        structure,
        ownership: officeOwnership(structure).slice(0, 1),
      }
    },
  },
  {
    name: 'D05 rejects a legacy participant alias mismatch independently',
    reason: 'office:participant-alias-mismatch',
    build() {
      const structure = officeStructureFixture()
      structure.participantChunks = [structure.participants[0]]
      return { structure, ownership: officeOwnership(structure) }
    },
  },
  {
    name: 'R09-S04 rejects conflicting participant canonical ids',
    reason: 'office:canonical-id-mismatch',
    build() {
      const structure = officeStructureFixture()
      const ownership = officeOwnership(structure)
      ownership[1].id = structure.id + 1
      return { structure, ownership }
    },
  },
  {
    name: 'R09-S05 rejects a non-adjacent office participant shape',
    reason: 'office:participant-shape',
    build() {
      const structure = officeStructureFixture()
      const anchor = structure.participants[0]
      structure.participants = [
        anchor,
        { cx: anchor.cx + 1, cz: anchor.cz + 1 },
      ]
      structure.participantChunks = structure.participants
      return { structure, ownership: officeOwnership(structure) }
    },
  },
  {
    name: 'R09-S06 rejects participant ownership outside the vertical band',
    reason: 'office:vertical-band',
    build() {
      const structure = officeStructureFixture()
      const ownership = officeOwnership(structure)
      ownership[1].topCy = structure.topCy + 1
      return { structure, ownership }
    },
  },
]

describe('canonical polygon participant contracts', () => {
  it.each([
    {
      bridgeAxis: 'x',
      expected: [
        {
          anchor: { cx: -2, cz: 4 },
          participants: [{ cx: -2, cz: 4 }, { cx: -1, cz: 4 }],
        },
        {
          anchor: { cx: -2, cz: 5 },
          participants: [{ cx: -2, cz: 5 }, { cx: -1, cz: 5 }],
        },
      ],
    },
    {
      bridgeAxis: 'z',
      expected: [
        {
          anchor: { cx: -2, cz: 4 },
          participants: [{ cx: -2, cz: 4 }, { cx: -2, cz: 5 }],
        },
        {
          anchor: { cx: -1, cz: 4 },
          participants: [{ cx: -1, cz: 4 }, { cx: -1, cz: 5 }],
        },
      ],
    },
  ])('R08-S01 preserves exact ordered $bridgeAxis office pairs', ({
    bridgeAxis,
    expected,
  }) => {
    expect(
      multilevelApi.polygonCandidates,
      'D04 requires polygonCandidates to replace private pair enumeration'
    ).toBeTypeOf('function')
    const normalized = multilevelConfig(testConfig({ districtChunks: 2 }))
    expect(multilevelApi.polygonCandidates(-1, 2, normalized, {
      shape: 'pair',
      bridgeAxis,
      avoidSpawn: false,
    })).toEqual(expected)
  })

  it('R04-S03 keeps the generated legacy office descriptor as one ordered exact pair', () => {
    const structure = districtStructure(
      0x51ea7,
      -1,
      2,
      0,
      testConfig({ minLevels: 4, maxLevels: 4 })
    )
    expect(structure.participants).toHaveLength(2)
    expect(structure.participants).toEqual(
      [...structure.participants].sort((a, b) => a.cz - b.cz || a.cx - b.cx)
    )
    expect(structure.anchor).toEqual(structure.participants[0])
    expect(structure.participantChunks).toBe(structure.participants)
  })

  it('R09-S01 accepts a complete canonical office pair and ownership set', async () => {
    const structure = officeStructureFixture()
    const result = await validateStructureFixture(
      structure,
      officeOwnership(structure)
    )
    expect(result).toMatchObject({
      ok: true,
      family: 'office',
      participants: structure.participants,
      reasons: [],
    })
  })

  it.each(malformedOfficeStructures)('$name with an office-specific reason', async ({
    build,
    reason,
  }) => {
    const { structure, ownership } = build()
    const result = await validateStructureFixture(structure, ownership)
    expect(result.ok).toBe(false)
    expect(result.family).toBe('office')
    expect(result.reasons).toContain(reason)
    expect(result.reasons.every((item) => item.startsWith('office:'))).toBe(true)
  })
})

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

  it('normalizes cross-chunk spans, 3..15 levels, period, kinds and mutable configs', () => {
    const defaults = multilevelConfig(structuredClone(DEFAULT_WORLD_CONFIG))
    expect(defaults).toEqual(DEFAULT_MULTILEVEL_CONFIG)
    expect(defaults.minLevels).toBe(4)
    expect(defaults.maxLevels).toBe(15)
    expect(defaults.verticalPeriod).toBe(17)
    expect(defaults.maxTopCy).toBe(64)
    expect(normalizeMultilevelConfig).toBe(multilevelConfig)

    const config = testConfig({
      districtChunks: 1,
      longSpan: 2,
      shortSpan: 1,
      minLevels: 99,
      maxLevels: -4,
      verticalPeriod: 2,
      maxTopCy: 999,
      bridgeChance: Infinity,
      salt: NaN,
      baseSalt: NaN,
    })
    const normalized = multilevelConfig(config)
    expect(normalized.districtChunks).toBe(2)
    expect(normalized.longSpan).toBe(CHUNK + 1)
    expect(normalized.shortSpan).toBe(4)
    expect(normalized.minLevels).toBe(3)
    expect(normalized.maxLevels).toBe(15)
    expect(normalized.verticalPeriod).toBe(16)
    expect(normalized.maxTopCy).toBe(MAX_MULTILEVEL_TOP_CY)
    expect(normalized.bridgeChance).toBe(DEFAULT_MULTILEVEL_CONFIG.bridgeChance)
    expect(normalized.salt).toBe(DEFAULT_MULTILEVEL_CONFIG.salt)
    expect(normalized.baseSalt).toBe(DEFAULT_MULTILEVEL_CONFIG.baseSalt)
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
      for (const levelCy of [-period, 0, period]) {
        for (const [districtX, districtZ] of [[-2, -1], [0, 0], [3, -4]]) {
          const first = districtStructure(seed, districtX, districtZ, levelCy, config)
          expect(districtStructure(seed, districtX, districtZ, levelCy, config)).toBe(first)
          const K = multilevelConfig(config).districtChunks
          const baseCy = multilevelBandBase(
            seed,
            districtX * K,
            districtZ * K,
            levelCy,
            config
          )
          expect(first.baseCy).toBe(baseCy)
          expect(first.participants).toHaveLength(2)
          if (first.baseCy <= 0 && first.topCy >= 0 && districtX === 0 && districtZ === 0) {
            expect(first.participants).not.toContainEqual({ cx: 0, cz: 0 })
          }
          expect(districtStructure(
            seed,
            districtX,
            districtZ,
            levelCy + period,
            config
          ).baseCy).toBe(baseCy + period)
          expect(multilevelContract(
            seed,
            first.anchor.cx,
            first.anchor.cz,
            baseCy + 1,
            config
          )).toEqual({ baseCy: baseCy + 1, hasRoom: false })
        }
      }
    }
  })

  it('randomizes the base phase so floor 0 can be a bottom, upper floor, or clear', () => {
    const seed = 12345
    const config = testConfig()
    const K = multilevelConfig(config).districtChunks
    const states = new Set()
    const bases = new Set()

    for (let districtZ = -8; districtZ <= 8; districtZ++) {
      for (let districtX = -8; districtX <= 8; districtX++) {
        const baseCy = multilevelBandBase(
          seed,
          districtX * K,
          districtZ * K,
          0,
          config
        )
        bases.add(baseCy)
        const structure = districtContractAtBase(
          seed,
          districtX,
          districtZ,
          baseCy,
          config
        )
        expect(structure).not.toBeNull()
        const participant = structure.participants[0]
        const atUser = multilevelStructureAt(
          seed,
          participant.cx,
          participant.cz,
          0,
          config
        )
        states.add(atUser.hasRoom ? (baseCy === 0 ? 'bottom' : 'upper') : 'clear')
      }
    }

    expect(bases.size).toBeGreaterThan(8)
    expect(states).toEqual(new Set(['bottom', 'upper', 'clear']))
  })

  it('caps landmark top floors at cy 64 without limiting ordinary floors', () => {
    const seed = 9876
    const config = testConfig({ minLevels: 15, maxLevels: 15, maxTopCy: 999 })
    const normalized = multilevelConfig(config)
    const K = normalized.districtChunks
    let accepted = 0
    let rejected = 0
    let highestTop = -Infinity
    let acceptedAt64 = null
    let rejectedAt65 = false

    for (let districtZ = -10; districtZ <= 10; districtZ++) {
      for (let districtX = -10; districtX <= 10; districtX++) {
        const originCx = districtX * K
        const originCz = districtZ * K
        const baseCy = multilevelBandBase(seed, originCx, originCz, 64, config)
        const structure = districtContractAtBase(
          seed,
          districtX,
          districtZ,
          baseCy,
          config
        )
        if (structure) {
          accepted++
          highestTop = Math.max(highestTop, structure.topCy)
          expect(structure.topCy).toBeLessThanOrEqual(64)
          if (baseCy === 50) acceptedAt64 = structure
        } else {
          rejected++
          if (baseCy === 51) rejectedAt65 = true
        }
        expect(districtContractAtBase(
          seed,
          districtX,
          districtZ,
          baseCy + normalized.verticalPeriod,
          config
        )).toBeNull()
        expect(multilevelStructureAt(seed, originCx, originCz, 65, config).hasRoom)
          .toBe(false)
      }
    }

    expect(normalized.maxTopCy).toBe(64)
    expect(accepted).toBeGreaterThan(0)
    expect(rejected).toBeGreaterThan(0)
    expect(highestTop).toBe(64)
    expect(acceptedAt64?.topCy).toBe(64)
    expect(rejectedAt65).toBe(true)
  })

  it('invalidates cached phase and cap normalization when mutable config changes', () => {
    const config = testConfig()
    const first = multilevelConfig(config)
    const firstBase = multilevelBandBase(7, 0, 0, 0, config)
    config.multilevel.baseSalt = 0
    const phaseChanged = multilevelConfig(config)
    expect(phaseChanged).not.toBe(first)
    expect(phaseChanged.baseSalt).toBe(0)
    expect(multilevelBandBase(7, 0, 0, 0, config)).not.toBe(firstBase)

    config.multilevel.maxTopCy = 32.9
    const capChanged = multilevelConfig(config)
    expect(capChanged).not.toBe(phaseChanged)
    expect(capChanged.maxTopCy).toBe(32)
  })

  it('uses a globally bounded footprint longer than one chunk with an exterior ring', () => {
    const config = testConfig({ minLevels: 4, maxLevels: 15 })
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
      expect(structure.levelCount).toBeLessThanOrEqual(15)

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

  it('builds seven continuous multi-chunk decks on alternating levels of a maximum stack', () => {
    const config = testConfig({ bridgeChance: 1, minLevels: 15, maxLevels: 15 })
    const structure = districtStructure(12345, -2, 1, -17, config)
    expect(structure.kind).toBe('bridged')
    expect(structure.levelCount).toBe(15)
    expect(structure.bridgeLevels).toEqual(
      [1, 3, 5, 7, 9, 11, 13].map((offset) => structure.baseCy + offset)
    )
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
    const config = testConfig({ bridgeChance: 0, minLevels: 15, maxLevels: 15 })
    const structure = districtStructure(7, 2, -3, -17, config)
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
    const config = testConfig({ bridgeChance: 1, minLevels: 15, maxLevels: 15 })
    const seed = 0xdeadbeef >>> 0
    const structure = districtStructure(seed, -3, -2, -17, config)
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
