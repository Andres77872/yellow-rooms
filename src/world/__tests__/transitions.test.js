import { describe, it, expect } from 'vitest'
import { ChunkData } from '../ChunkData.js'
import { buildChunk } from '../pipeline.js'
import { DEFAULT_WORLD_CONFIG as CFG } from '../config.js'
import { CHUNK, ZONE_OFFICE, ZONE_PILLARS, ZONE_WAREHOUSE } from '../constants.js'
import { RNG } from '../core/rng.js'
import {
  CELL_LOBBY,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
} from '../mapTypes.js'
import { sampleRegionValue, selectZone } from '../regions.js'
import * as borderContracts from '../border.js'
import * as pillars from '../zones/pillars.js'

const isOpenZone = (zone) => (CFG.border.openness[zone] ?? 0) >= 1
const ZONE_SEWER = CFG.mapFamily.profiles.sewer.zoneBands[0].id

const SEAM_AXES = [
  { axis: 'vertical', kx: -3, kz: 2, dx: 1, dz: 0 },
  { axis: 'horizontal', kx: -3, kz: 2, dx: 0, dz: 1 },
]

const OFFICE_SEWER_SEAMS = SEAM_AXES.flatMap((seam) => [
  {
    ...seam,
    order: 'office-to-sewer',
    firstZone: ZONE_OFFICE,
    secondZone: ZONE_SEWER,
  },
  {
    ...seam,
    order: 'sewer-to-office',
    firstZone: ZONE_SEWER,
    secondZone: ZONE_OFFICE,
  },
])

const OPEN_HALL_SEWER_SEAMS = SEAM_AXES.flatMap((seam) => [
  ...[
    { hall: 'pillars', zone: ZONE_PILLARS },
    { hall: 'warehouse', zone: ZONE_WAREHOUSE },
  ].flatMap(({ hall, zone }) => [
    {
      ...seam,
      hall,
      order: `${hall}-to-sewer`,
      firstZone: zone,
      secondZone: ZONE_SEWER,
    },
    {
      ...seam,
      hall,
      order: `sewer-to-${hall}`,
      firstZone: ZONE_SEWER,
      secondZone: zone,
    },
  ]),
])

function plannedBorderPairMode(reason) {
  expect(
    borderContracts.borderPairMode,
    `${reason}: planned borderPairMode export is not implemented`
  ).toBeTypeOf('function')
  return borderContracts.borderPairMode
}

function forcedSeamContract({ axis, kx, kz, dx, dz, firstZone, secondZone }) {
  const seed = 0x2e2
  const config = structuredClone(CFG)
  config.region.roomDominance.enabled = false
  config.region.bufferTransitions = false

  const firstValue = sampleRegionValue(kx, kz, seed, config)
  const secondValue = sampleRegionValue(kx + dx, kz + dz, seed, config)
  if (firstValue === secondValue) throw new Error(`${axis}: fixture needs distinct region samples`)

  const split = (firstValue + secondValue) / 2
  config.zoneBands = firstValue < secondValue
    ? [{ id: firstZone, max: split }, { id: secondZone, max: 1.01 }]
    : [{ id: secondZone, max: split }, { id: firstZone, max: 1.01 }]

  expect(selectZone(kx, kz, seed, config), `${axis}: first fixture zone`).toBe(firstZone)
  expect(
    selectZone(kx + dx, kz + dz, seed, config),
    `${axis}: second fixture zone`
  ).toBe(secondZone)

  const contract = axis === 'vertical'
    ? borderContracts.vBorderContract(kx, kz, seed, config)
    : borderContracts.hBorderContract(kx, kz, seed, config)
  return { config, contract }
}

function expectWalledMouth(contract, config, label) {
  expect(contract.kind, `${label}: seam mode`).toBe('mouth')

  const openings = []
  for (let i = 0; i < CHUNK; i++) {
    if (contract.walls[i] === 0) openings.push(i)
    expect(contract.passages[i], `${label}: passage ${i}`).toBe(
      contract.walls[i] === 0 ? PASSAGE_WIDE : PASSAGE_WALL
    )
  }

  expect(openings.length, `${label}: mouth width`).toBeGreaterThanOrEqual(config.border.mouthWidth[0])
  expect(openings.length, `${label}: mouth width`).toBeLessThanOrEqual(config.border.mouthWidth[1])
  expect(openings.length, `${label}: boundary remains walled outside the mouth`).toBeLessThan(CHUNK)
  expect(openings, `${label}: mouth is one contiguous transition`).toEqual(
    Array.from({ length: openings.length }, (_, index) => openings[0] + index)
  )
}

function expectOpenMerge(contract, label) {
  expect(contract.kind, `${label}: seam mode`).toBe('open')
  expect(Array.from(contract.walls), `${label}: no wall closes the merge`)
    .toEqual(Array(CHUNK).fill(0))
  expect(Array.from(contract.passages), `${label}: every edge is an open passage`)
    .toEqual(Array(CHUNK).fill(PASSAGE_OPEN))
}

function transitionBytes(contract) {
  const bytes = new Uint8Array(CHUNK * 2)
  bytes.set(contract.walls)
  bytes.set(contract.passages, CHUNK)
  return Array.from(bytes)
}

function transitionChunkSnapshot(data) {
  return {
    zone: data.zone,
    wallV: Array.from(data.wallV),
    wallH: Array.from(data.wallH),
    passageV: Array.from(data.passageV),
    passageH: Array.from(data.passageH),
    cols: Array.from(data.cols),
    cellKind: Array.from(data.cellKind),
  }
}

function establishedOfficeTransitionCorpus(config) {
  const seed = 1
  const corpus = {}

  for (let cz = -8; cz <= 8 && (!corpus.vertical || !corpus.horizontal); cz++) {
    for (let cx = -8; cx <= 8 && (!corpus.vertical || !corpus.horizontal); cx++) {
      const zone = selectZone(cx, cz, seed, config)
      const eastZone = selectZone(cx + 1, cz, seed, config)
      if (!corpus.vertical && isOpenZone(zone) !== isOpenZone(eastZone)) {
        corpus.vertical = [
          transitionChunkSnapshot(buildChunk(seed, cx, 0, cz, config)),
          transitionChunkSnapshot(buildChunk(seed, cx + 1, 0, cz, config)),
        ]
      }

      const southZone = selectZone(cx, cz + 1, seed, config)
      if (!corpus.horizontal && isOpenZone(zone) !== isOpenZone(southZone)) {
        corpus.horizontal = [
          transitionChunkSnapshot(buildChunk(seed, cx, 0, cz, config)),
          transitionChunkSnapshot(buildChunk(seed, cx, 0, cz + 1, config)),
        ]
      }
    }
  }

  expect(corpus.vertical, 'established vertical office transition fixture').toBeDefined()
  expect(corpus.horizontal, 'established horizontal office transition fixture').toBeDefined()
  return corpus
}

describe('office-to-open transitions', () => {
  it('uses a wide boundary and lobby approach on both seam axes', () => {
    const seed = 1
    let vertical = false
    let horizontal = false
    for (let cz = -8; cz <= 8 && (!vertical || !horizontal); cz++) {
      for (let cx = -8; cx <= 8 && (!vertical || !horizontal); cx++) {
        const zone = selectZone(cx, cz, seed, CFG)
        const eastZone = selectZone(cx + 1, cz, seed, CFG)
        if (!vertical && isOpenZone(zone) !== isOpenZone(eastZone)) {
          const west = buildChunk(seed, cx, 0, cz, CFG)
          const east = buildChunk(seed, cx + 1, 0, cz, CFG)
          const office = west.zone === ZONE_OFFICE ? west : east
          const open = west.zone === ZONE_OFFICE ? east : west
          const officeLines = west.zone === ZONE_OFFICE ? [CHUNK - 1, CHUNK - 2] : [1, 2]
          const openLines = west.zone === ZONE_OFFICE ? [1, 2] : [CHUNK - 1, CHUNK - 2]
          let openings = 0
          for (let z = 0; z < CHUNK; z++) {
            if (east.vAt(0, z)) continue
            openings++
            expect(east.passageVAt(0, z)).toBe(PASSAGE_WIDE)
            for (const line of officeLines) expect(office.passageVAt(line, z)).toBe(PASSAGE_WIDE)
            for (const line of openLines) expect(open.passageVAt(line, z)).toBe(PASSAGE_OPEN)
            const officeX = west.zone === ZONE_OFFICE ? CHUNK - 1 : 0
            expect(office.cellKind[z * CHUNK + officeX]).toBe(CELL_LOBBY)
          }
          expect(openings).toBeGreaterThanOrEqual(CFG.border.mouthWidth[0])
          vertical = true
        }

        const southZone = selectZone(cx, cz + 1, seed, CFG)
        if (!horizontal && isOpenZone(zone) !== isOpenZone(southZone)) {
          const north = buildChunk(seed, cx, 0, cz, CFG)
          const south = buildChunk(seed, cx, 0, cz + 1, CFG)
          const office = north.zone === ZONE_OFFICE ? north : south
          const open = north.zone === ZONE_OFFICE ? south : north
          const officeLines = north.zone === ZONE_OFFICE ? [CHUNK - 1, CHUNK - 2] : [1, 2]
          const openLines = north.zone === ZONE_OFFICE ? [1, 2] : [CHUNK - 1, CHUNK - 2]
          let openings = 0
          for (let x = 0; x < CHUNK; x++) {
            if (south.hAt(x, 0)) continue
            openings++
            expect(south.passageHAt(x, 0)).toBe(PASSAGE_WIDE)
            for (const line of officeLines) expect(office.passageHAt(x, line)).toBe(PASSAGE_WIDE)
            for (const line of openLines) expect(open.passageHAt(x, line)).toBe(PASSAGE_OPEN)
            const officeZ = north.zone === ZONE_OFFICE ? CHUNK - 1 : 0
            expect(office.cellKind[officeZ * CHUNK + x]).toBe(CELL_LOBBY)
          }
          expect(openings).toBeGreaterThanOrEqual(CFG.border.mouthWidth[0])
          horizontal = true
        }
      }
    }
    expect(vertical).toBe(true)
    expect(horizontal).toBe(true)
  })

  it('clears structural columns throughout an open-side mouth approach', () => {
    const mouth = new Uint8Array(CHUNK).fill(1)
    for (const z of [2, 3, 4]) mouth[z] = 0
    const data = new ChunkData(0, 0, 0, ZONE_PILLARS)
    pillars.generate(data, {
      seed: 7,
      cx: 0,
      cz: 0,
      zone: ZONE_PILLARS,
      rng: RNG.fromHash(7, 0, 0),
      config: CFG,
      borders: { wW: mouth },
      borderZones: { w: ZONE_OFFICE },
    })

    for (const z of [2, 3, 4]) {
      expect(data.colAt(0, z)).toBe(0)
      expect(data.colAt(1, z)).toBe(0)
      expect(data.colAt(2, z)).toBe(0)
    }
    expect(data.colAt(4, 4)).toBeGreaterThan(0)
  })
})

describe('pair-aware sewer transitions', () => {
  it.each([
    { neighbour: 'office', zone: ZONE_OFFICE, expected: 'mouth' },
    { neighbour: 'pillars', zone: ZONE_PILLARS, expected: 'open' },
    { neighbour: 'warehouse', zone: ZONE_WAREHOUSE, expected: 'open' },
  ])(
    '[R10-S01..S03][D07] resolves $neighbour and sewer to one $expected result in both query orders',
    ({ neighbour, zone, expected }) => {
      const borderPairMode = plannedBorderPairMode(`${neighbour}-sewer symmetry`)

      const forward = borderPairMode(zone, ZONE_SEWER, CFG)
      const reverse = borderPairMode(ZONE_SEWER, zone, CFG)

      expect(forward, `${neighbour}-to-sewer mode`).toBe(expected)
      expect(reverse, `sewer-to-${neighbour} mode`).toBe(forward)
    }
  )

  it.each(OFFICE_SEWER_SEAMS)(
    '[R10-S01][R10-S03][D07] emits one walled mouth on the $axis $order seam',
    (fixture) => {
      const { config, contract } = forcedSeamContract(fixture)
      expectWalledMouth(contract, config, `${fixture.axis} ${fixture.order}`)
    }
  )

  it.each(SEAM_AXES)(
    '[R10-S01][R10-S03][D07] emits byte-identical swapped mouth contracts on the $axis axis',
    (seam) => {
      const forward = forcedSeamContract({
        ...seam,
        firstZone: ZONE_OFFICE,
        secondZone: ZONE_SEWER,
      })
      const reverse = forcedSeamContract({
        ...seam,
        firstZone: ZONE_SEWER,
        secondZone: ZONE_OFFICE,
      })

      expectWalledMouth(forward.contract, forward.config, `${seam.axis} office-to-sewer`)
      expectWalledMouth(reverse.contract, reverse.config, `${seam.axis} sewer-to-office`)
      expect(transitionBytes(reverse.contract), `${seam.axis}: swapped transition bytes`)
        .toEqual(transitionBytes(forward.contract))
    }
  )

  it.each(OPEN_HALL_SEWER_SEAMS)(
    '[R10-S02][R10-S03][R24-S02][D07] leaves the $axis $order seam fully merged',
    (fixture) => {
      const { contract } = forcedSeamContract(fixture)
      expectOpenMerge(contract, `${fixture.axis} ${fixture.order}`)
    }
  )

  it.each([{ scalar: 0 }, { scalar: 0.5 }, { scalar: 1 }])(
    '[R10-S04][D07] rejects scalar-only sewer openness $scalar',
    ({ scalar }) => {
      const borderPairMode = plannedBorderPairMode('scalar-only sewer policy')
      const scalarOnly = structuredClone(CFG)
      delete scalarOnly.border.pairModes
      scalarOnly.border.openness[ZONE_SEWER] = scalar

      expect(() => borderPairMode(ZONE_OFFICE, ZONE_SEWER, scalarOnly)).toThrow()
      expect(() => borderPairMode(ZONE_PILLARS, ZONE_SEWER, scalarOnly)).toThrow()
    }
  )

  it('[R10-S03..S04][D07] rejects conflicting directed pair definitions deterministically', () => {
    const borderPairMode = plannedBorderPairMode('conflicting sewer pair policy')
    const conflicting = structuredClone(CFG)
    conflicting.border.pairModes = {
      [ZONE_OFFICE]: { [ZONE_SEWER]: 'mouth' },
      [ZONE_SEWER]: { [ZONE_OFFICE]: 'open' },
    }
    const pair = [ZONE_OFFICE, ZONE_SEWER].sort((a, b) => a - b).join('<->')
    const reason = `conflicting border pair modes: ${pair}`

    expect(() => borderPairMode(ZONE_OFFICE, ZONE_SEWER, conflicting)).toThrow(reason)
    expect(() => borderPairMode(ZONE_SEWER, ZONE_OFFICE, conflicting)).toThrow(reason)
  })

  it('[R11-S01..S02][D07] keeps the office transition corpus unchanged while sewer is unselected', () => {
    expect(CFG.mapFamily.selected).toBe('office')
    expect(CFG.mapFamily.profiles.sewer.enabled).toBe(true)

    const unselectedSewer = structuredClone(CFG)
    unselectedSewer.mapFamily.profiles.sewer.zoneBands = [
      { id: ZONE_SEWER, max: 0.5 },
      { id: ZONE_OFFICE, max: 1.01 },
    ]
    unselectedSewer.mapFamily.profiles.sewer.maxLoops = 0
    unselectedSewer.mapFamily.profiles.sewer.lampPhase = 9
    unselectedSewer.mapFamily.profiles.sewer.lampChance = 0.2

    expect(establishedOfficeTransitionCorpus(unselectedSewer))
      .toEqual(establishedOfficeTransitionCorpus(CFG))
  })
})
