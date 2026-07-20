import { describe, expect, it } from 'vitest'
import { DEFAULT_WORLD_CONFIG, TOWER_RELEASE_EVIDENCE } from '../config.js'
import { CELL, CHUNK, WORLD_GEN_VERSION } from '../constants.js'
import { generateChunk } from '../generate.js'
import { worldConfigForFamily } from '../mapFamily.js'
import {
  CELL_BRIDGE,
  PASSAGE_DOOR,
  PASSAGE_WALL,
  WALL_RAIL,
} from '../mapTypes.js'
import { collectInteriorDressing, PROP_TINT, SIGN_TINT } from '../objects/dressing/index.js'
import { structureAt } from '../structures/contract.js'

const FIXED_SEEDS = Object.freeze([0x5a17, 0x7157, 0xc0ffee])
const REQUIRED_SOCKET_KINDS = Object.freeze([
  'signage',
  'clock',
  'litAccent',
  'door',
  'fixture',
])
const REQUIRED_FLOOR_OFFSETS = Object.freeze([0, 1, 2])

const key2 = ({ cx, cz }) => `${cx},${cz}`
const key3 = (cx, cy, cz) => `${cx},${cy},${cz}`
const cellKey = ({ gx, gz }) => `${gx},${gz}`

function forcedTowerConfig() {
  const base = structuredClone(DEFAULT_WORLD_CONFIG)
  base.mapFamily.profiles.tower.enabled = true
  return worldConfigForFamily('tower', base)
}

function findTowerDescriptor(seed, config) {
  let descriptor = null
  for (let cy = -24; cy <= 24 && !descriptor; cy++) {
    for (let cz = -4; cz <= 4 && !descriptor; cz++) {
      for (let cx = -4; cx <= 4; cx++) {
        const candidate = structureAt(seed, cx, cz, cy, config)
        if (
          candidate?.hasRoom === true &&
          candidate.family === 'tower' &&
          candidate.kind === 'towerSkybridge'
        ) {
          descriptor = candidate
          break
        }
      }
    }
  }

  expect(
    descriptor,
    'task 4.1 RED: structureAt must dispatch a forced enabled Tower profile to the bounded tower planner'
  ).not.toBeNull()
  return descriptor
}

function chunkAtGlobal(chunks, gx, gz, cy) {
  return chunks.get(key3(Math.floor(gx / CHUNK), cy, Math.floor(gz / CHUNK))) ?? null
}

function socketEdge(data, socket) {
  if (!data) return null
  const lx = socket.gx - data.cx * CHUNK
  const lz = socket.gz - data.cz * CHUNK
  if (socket.axis === 'x') {
    const line = lx + (socket.side > 0 ? 1 : 0)
    return {
      wall: data.vAt(line, lz),
      passage: data.passageVAt(line, lz),
    }
  }
  const line = lz + (socket.side > 0 ? 1 : 0)
  return {
    wall: data.hAt(lx, line),
    passage: data.passageHAt(lx, line),
  }
}

function dressingHasSocketTint(data, socket, tint) {
  if (!data) return false
  const dressing = collectInteriorDressing(data)
  const items = [...dressing.props, ...dressing.signs]
  const lx = socket.gx - data.cx * CHUNK
  const lz = socket.gz - data.cz * CHUNK
  const along = (socket.axis === 'x' ? lz : lx) * CELL + CELL / 2
  const line = (socket.axis === 'x' ? lx : lz) + (socket.side > 0 ? 1 : 0)
  const plane = line * CELL
  return items.some((item) => {
    if (item.tint !== tint) return false
    const itemAlong = socket.axis === 'x' ? item.pz : item.px
    const itemAcross = socket.axis === 'x' ? item.px : item.pz
    return Math.abs(itemAlong - along) < 1e-9 &&
      Math.sign(itemAcross - plane) === socket.side
  })
}

function horizontalGuard(chunks, gx, lineGZ, cy) {
  const data = chunkAtGlobal(chunks, gx, lineGZ, cy)
  if (!data) return false
  const lx = gx - data.cx * CHUNK
  const line = lineGZ - data.cz * CHUNK
  return data.hAt(lx, line) === 1 &&
    data.passageHAt(lx, line) === PASSAGE_WALL &&
    data.wallFeatureHAt(lx, line) === WALL_RAIL
}

function verticalGuard(chunks, lineGX, gz, cy) {
  const data = chunkAtGlobal(chunks, lineGX, gz, cy)
  if (!data) return false
  const line = lineGX - data.cx * CHUNK
  const lz = gz - data.cz * CHUNK
  return data.vAt(line, lz) === 1 &&
    data.passageVAt(line, lz) === PASSAGE_WALL &&
    data.wallFeatureVAt(line, lz) === WALL_RAIL
}

function generatedGuardEvidence(chunks, descriptor) {
  const deck = descriptor.decks?.[0]
  if (!deck || !Array.isArray(deck.globalCells)) return []
  return deck.globalCells.map(({ gx, gz }) => ({
    gx,
    gz,
    negative: descriptor.bridgeAxis === 'x'
      ? horizontalGuard(chunks, gx, gz, deck.levelCy)
      : verticalGuard(chunks, gx, gz, deck.levelCy),
    positive: descriptor.bridgeAxis === 'x'
      ? horizontalGuard(chunks, gx, gz + 1, deck.levelCy)
      : verticalGuard(chunks, gx + 1, gz, deck.levelCy),
  }))
}

function generatedRoomFloorEvidence(chunks, descriptor) {
  const bridgeCells = new Set(
    (descriptor.decks ?? []).flatMap((deck) => deck.globalCells ?? []).map(cellKey)
  )
  const evidence = []
  for (const participant of descriptor.participants ?? []) {
    const chunkX0 = participant.cx * CHUNK
    const chunkZ0 = participant.cz * CHUNK
    const x0 = Math.max(descriptor.globalBounds?.x0 ?? 1, chunkX0)
    const z0 = Math.max(descriptor.globalBounds?.z0 ?? 1, chunkZ0)
    const x1 = Math.min(descriptor.globalBounds?.x1 ?? 0, chunkX0 + CHUNK - 1)
    const z1 = Math.min(descriptor.globalBounds?.z1 ?? 0, chunkZ0 + CHUNK - 1)

    for (let cy = descriptor.baseCy; cy <= descriptor.topCy; cy++) {
      const data = chunks.get(key3(participant.cx, cy, participant.cz))
      let enclosedRoomFloor = false
      for (let gz = z0; gz <= z1 && !enclosedRoomFloor; gz++) {
        for (let gx = x0; gx <= x1; gx++) {
          const lx = gx - chunkX0
          const lz = gz - chunkZ0
          if (
            data &&
            !bridgeCells.has(`${gx},${gz}`) &&
            !data.hasFloorHole(lx, lz) &&
            data.cellKind[lz * CHUNK + lx] !== CELL_BRIDGE &&
            data.colAt(lx, lz) === 0
          ) {
            enclosedRoomFloor = true
            break
          }
        }
      }
      evidence.push({ ...participant, cy, enclosedRoomFloor })
    }
  }
  return evidence
}

function generateTowerFixture(seed, config = forcedTowerConfig()) {
  const descriptor = findTowerDescriptor(seed, config)
  const chunks = new Map()
  for (let cy = descriptor.baseCy; cy <= descriptor.topCy; cy++) {
    for (const { cx, cz } of descriptor.participants) {
      chunks.set(key3(cx, cy, cz), generateChunk(seed, cx, cy, cz, config))
    }
  }

  const deck = descriptor.decks?.[0]
  const approaches = (descriptor.participants ?? []).map((participant) => {
    const data = chunks.get(key3(participant.cx, deck?.levelCy, participant.cz))
    return {
      id: data?.structureDown?.id,
      levelCy: data?.structureDown?.levelCy,
      participant: { ...participant },
    }
  })

  return {
    descriptor,
    chunks,
    approaches,
    guards: generatedGuardEvidence(chunks, descriptor),
    roomFloors: generatedRoomFloorEvidence(chunks, descriptor),
    networkEdges: descriptor.networkEdges ?? descriptor.crossDistrictLinks ?? [],
    proceduralDecoration: false,
  }
}

function referenceTowerFixture() {
  const participants = [{ cx: 0, cz: 0 }, { cx: 1, cz: 0 }]
  const baseCy = 4
  const topCy = 6
  const levelCy = 5
  const globalCells = Array.from({ length: 22 }, (_, index) => ({
    gx: 3 + index,
    gz: 6,
  }))
  const descriptor = {
    id: 0x7157,
    family: 'tower',
    kind: 'towerSkybridge',
    hasRoom: true,
    district: { x: 0, z: 0, size: 2 },
    baseCy,
    topCy,
    levelCount: 3,
    participants,
    anchor: { ...participants[0] },
    bridgeAxis: 'x',
    globalBounds: { x0: 3, z0: 3, x1: 24, z1: 10 },
    decks: [{
      levelCy,
      lowerCy: levelCy - 1,
      globalBridgeLine: 6,
      globalBounds: { x0: 3, z0: 6, x1: 24, z1: 6 },
      globalCells,
    }],
    verticalLinks: [
      { lowerCy: 4, cx: 0, cz: 0, stair: { lowerCy: 4, dir: 1 } },
      { lowerCy: 5, cx: 1, cz: 0, stair: { lowerCy: 5, dir: 3 } },
    ],
    landmarkSockets: [
      { slot: 'anchorFloor', kind: 'signage', gx: 4, gz: 4, cy: 4, axis: 'x', side: -1, salt: 11 },
      { slot: 'anchorFloor', kind: 'clock', gx: 18, gz: 4, cy: 5, axis: 'z', side: -1, salt: 12 },
      { slot: 'anchorFloor', kind: 'fixture', gx: 5, gz: 9, cy: 6, axis: 'x', side: 1, salt: 13 },
      { slot: 'bridgeApproach', kind: 'litAccent', gx: 12, gz: 6, cy: 5, axis: 'x', side: -1, salt: 14 },
      { slot: 'bridgeApproach', kind: 'door', gx: 15, gz: 6, cy: 5, axis: 'x', side: 1, salt: 15 },
    ],
  }

  return {
    descriptor,
    approaches: participants.map((participant) => ({
      id: descriptor.id,
      levelCy,
      participant: { ...participant },
    })),
    guards: globalCells.map((cell) => ({ ...cell, negative: true, positive: true })),
    roomFloors: participants.flatMap((participant) => REQUIRED_FLOOR_OFFSETS.map((offset) => ({
      ...participant,
      cy: baseCy + offset,
      enclosedRoomFloor: true,
    }))),
    networkEdges: [],
    proceduralDecoration: false,
  }
}

function validBounds(bounds) {
  return bounds &&
    Number.isInteger(bounds.x0) &&
    Number.isInteger(bounds.z0) &&
    Number.isInteger(bounds.x1) &&
    Number.isInteger(bounds.z1) &&
    bounds.x1 >= bounds.x0 &&
    bounds.z1 >= bounds.z0
}

function exactCanonicalPair(descriptor) {
  const participants = descriptor.participants ?? []
  if (participants.length !== 2) return false
  const [a, b] = participants
  return (
    a.cz < b.cz ||
    (a.cz === b.cz && a.cx < b.cx)
  ) &&
    Math.abs(a.cx - b.cx) + Math.abs(a.cz - b.cz) === 1
}

function contiguousDeck(descriptor, deck) {
  if (!Array.isArray(deck?.globalCells) || deck.globalCells.length < 2) return false
  const participantKeys = new Set()
  for (let index = 0; index < deck.globalCells.length; index++) {
    const cell = deck.globalCells[index]
    participantKeys.add(`${Math.floor(cell.gx / CHUNK)},${Math.floor(cell.gz / CHUNK)}`)
    if (index === 0) continue
    const previous = deck.globalCells[index - 1]
    if (Math.abs(previous.gx - cell.gx) + Math.abs(previous.gz - cell.gz) !== 1) {
      return false
    }
  }
  return participantKeys.size === 2 &&
    [...participantKeys].every((key) => descriptor.participants.some((item) => key2(item) === key))
}

function socketParticipantKey(socket) {
  if (!Number.isInteger(socket?.gx) || !Number.isInteger(socket?.gz)) return null
  return `${Math.floor(socket.gx / CHUNK)},${Math.floor(socket.gz / CHUNK)}`
}

function towerContractReasons(fixture) {
  const descriptor = fixture?.descriptor ?? {}
  const reasons = new Set()
  const participants = descriptor.participants ?? []
  const participantKeys = new Set(participants.map(key2))

  if (
    descriptor.family !== 'tower' ||
    descriptor.kind !== 'towerSkybridge' ||
    descriptor.hasRoom !== true ||
    !Number.isInteger(descriptor.id)
  ) reasons.add('tower-identity')

  if (participants.length !== 2) reasons.add('participant-cardinality')
  if (!exactCanonicalPair(descriptor) || key2(descriptor.anchor ?? {}) !== key2(participants[0] ?? {})) {
    reasons.add('participant-shape')
  }
  if (
    descriptor.levelCount !== 3 ||
    !Number.isInteger(descriptor.baseCy) ||
    descriptor.topCy !== descriptor.baseCy + 2 ||
    !validBounds(descriptor.globalBounds)
  ) reasons.add('bounded-three-floor-geometry')

  const deck = descriptor.decks?.[0]
  if (
    descriptor.decks?.length !== 1 ||
    deck?.lowerCy !== deck?.levelCy - 1 ||
    deck?.levelCy <= descriptor.baseCy ||
    deck?.levelCy > descriptor.topCy ||
    !validBounds(deck?.globalBounds) ||
    !contiguousDeck(descriptor, deck)
  ) reasons.add('skybridge-deck')

  const approaches = fixture?.approaches ?? []
  const approachParticipants = new Set(approaches.map((approach) => key2(approach.participant ?? {})))
  if (
    approaches.length !== 2 ||
    approaches.some((approach) =>
      approach.id !== descriptor.id || approach.levelCy !== deck?.levelCy
    ) ||
    approachParticipants.size !== 2 ||
    [...approachParticipants].some((key) => !participantKeys.has(key))
  ) reasons.add('approach-match')

  const links = descriptor.verticalLinks ?? []
  const lowerFloors = [...new Set(links.map((link) => link.lowerCy))].sort((a, b) => a - b)
  if (
    links.length !== 2 ||
    lowerFloors.length !== 2 ||
    lowerFloors[0] !== descriptor.baseCy ||
    lowerFloors[1] !== descriptor.baseCy + 1 ||
    links.some((link) =>
      !participantKeys.has(key2(link)) ||
      !link.stair ||
      typeof link.stair !== 'object'
    )
  ) reasons.add('floor-connectivity')

  if (
    fixture?.roomFloors?.length !== participants.length * 3 ||
    fixture.roomFloors.some((floor) => floor.enclosedRoomFloor !== true)
  ) reasons.add('enclosed-room-floor')

  const sockets = descriptor.landmarkSockets ?? []
  if (sockets.length === 0 || fixture?.proceduralDecoration === true) {
    reasons.add('authored-sockets')
  }
  const kinds = new Set(sockets.map((socket) => socket.kind))
  if (kinds.size <= 1 || sockets.some((socket) => !REQUIRED_SOCKET_KINDS.includes(socket.kind))) {
    reasons.add('mixed-socket-kinds')
  }
  const anchorFloors = new Set(
    sockets.filter((socket) => socket.slot === 'anchorFloor').map((socket) => socket.cy)
  )
  if (REQUIRED_FLOOR_OFFSETS.some((offset) => !anchorFloors.has(descriptor.baseCy + offset))) {
    reasons.add('anchor-socket-coverage')
  }
  const coveredApproaches = new Set(
    sockets
      .filter((socket) => socket.slot === 'bridgeApproach' && socket.cy === deck?.levelCy)
      .map(socketParticipantKey)
  )
  if (
    coveredApproaches.size !== 2 ||
    [...participantKeys].some((key) => !coveredApproaches.has(key))
  ) reasons.add('approach-socket-coverage')

  const guards = fixture?.guards ?? []
  if (
    guards.length !== (deck?.globalCells?.length ?? -1) ||
    guards.some((guard) => guard.negative !== true || guard.positive !== true)
  ) reasons.add('guard-continuity')

  if (
    (fixture?.networkEdges?.length ?? 0) > 0 ||
    descriptor.networkId !== undefined ||
    descriptor.linkedStructureIds !== undefined
  ) reasons.add('cross-district-network')

  return [...reasons]
}

function deepFrozen(value) {
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)) return false
  return Object.values(value).every((child) =>
    !child || typeof child !== 'object' || deepFrozen(child)
  )
}

function chunkSnapshot(data) {
  return {
    wallV: [...data.wallV],
    wallH: [...data.wallH],
    passageV: [...data.passageV],
    passageH: [...data.passageH],
    wallFeatureV: [...data.wallFeatureV],
    wallFeatureH: [...data.wallFeatureH],
    cols: [...data.cols],
    cellKind: [...data.cellKind],
    stairUp: data.stairUp,
    stairDown: data.stairDown,
    structure: data.structure,
    structureUp: data.structureUp,
    structureDown: data.structureDown,
    lethalVoidUp: data.lethalVoidUp,
    lethalVoidDown: data.lethalVoidDown,
    lamps: data.lamps.map((lamp) => ({ ...lamp })),
    dressing: collectInteriorDressing(data),
  }
}

describe('bounded canonical Tower/skybridge generation', () => {
  it('[R08-S02][R25-S01..S04][R27-S02][D04/D05/D08] emits one enclosed exact-pair three-floor structure with matched approaches, links, deck, and guards', () => {
    const config = forcedTowerConfig()
    expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles.tower.enabled).toBe(true)
    expect(config.mapFamily.profiles.tower.enabled).toBe(true)

    for (const seed of FIXED_SEEDS) {
      const fixture = generateTowerFixture(seed, config)
      expect(towerContractReasons(fixture)).toEqual([])
      expect(fixture.descriptor.participants).toHaveLength(2)
      expect(fixture.descriptor.levelCount).toBe(3)
      expect(fixture.descriptor.decks).toHaveLength(1)
      expect(fixture.descriptor.verticalLinks).toHaveLength(2)
      expect(fixture.chunks.size).toBe(6)
    }
  })

  it('[R05-S02][R06-S01..S03][R20-S01][R27-S01][R33-S01][D11] binds the active Tower profile to its version, corpus identity, and Sewer-independent fixture', () => {
    const withoutSewer = structuredClone(DEFAULT_WORLD_CONFIG)
    withoutSewer.mapFamily.profiles.sewer.enabled = false
    const config = worldConfigForFamily('tower', withoutSewer)
    const fixture = generateTowerFixture(FIXED_SEEDS[0], config)

    expect(WORLD_GEN_VERSION).toBe(TOWER_RELEASE_EVIDENCE.generatorVersion)
    expect(TOWER_RELEASE_EVIDENCE).toMatchObject({
      family: 'tower',
      byteImpact: 'changed-output',
      previousVersion: 20,
      generatorVersion: 21,
      profileIdentity: 'tower-forced-audit:levels-3:participants-2:skybridge-1',
      seedDerivation: 'fixed-root-seeds(0x5a17,0x7157,0xc0ffee)',
      affectsMaximumHeight: true,
    })
    expect(config.mapFamily.profiles.sewer.enabled).toBe(false)
    expect(config.mapFamily.profiles.tower.enabled).toBe(true)
    expect(towerContractReasons(fixture)).toEqual([])
    expect(fixture.networkEdges).toEqual([])
  })

  it('[R26-S01..S04][D05] covers all five authored socket kinds while every fixed fixture stays mixed and both approaches stay covered', () => {
    const observed = new Set()
    for (const seed of FIXED_SEEDS) {
      const fixture = generateTowerFixture(seed)
      const sockets = fixture.descriptor.landmarkSockets
      const kinds = new Set(sockets.map((socket) => socket.kind))
      expect(kinds.size).toBeGreaterThan(1)
      expect(towerContractReasons(fixture)).not.toContain('approach-socket-coverage')
      for (const kind of kinds) observed.add(kind)
    }
    expect([...observed].sort()).toEqual([...REQUIRED_SOCKET_KINDS].sort())
  })

  it('[R26-S01..S04][D05] materializes the fixed socket template through existing prop, passage, and lamp assets', () => {
    for (const seed of FIXED_SEEDS) {
      const fixture = generateTowerFixture(seed)
      const sockets = fixture.descriptor.landmarkSockets
      expect(sockets.map(({ kind }) => kind)).toEqual(REQUIRED_SOCKET_KINDS)
      expect(sockets.map(({ salt }) => salt)).toEqual([
        0x745101,
        0x745102,
        0x745103,
        0x745104,
        0x745105,
      ])

      const byKind = Object.fromEntries(sockets.map((socket) => [socket.kind, socket]))
      const dataFor = (socket) => chunkAtGlobal(
        fixture.chunks,
        socket.gx,
        socket.gz,
        socket.cy
      )

      expect(dressingHasSocketTint(
        dataFor(byKind.signage),
        byKind.signage,
        SIGN_TINT.blade
      )).toBe(true)
      expect(dressingHasSocketTint(
        dataFor(byKind.clock),
        byKind.clock,
        PROP_TINT.clock
      )).toBe(true)
      expect(dressingHasSocketTint(
        dataFor(byKind.litAccent),
        byKind.litAccent,
        SIGN_TINT.exit
      )).toBe(true)

      expect(socketEdge(dataFor(byKind.door), byKind.door)).toEqual({
        wall: 0,
        passage: PASSAGE_DOOR,
      })

      const fixtureData = dataFor(byKind.fixture)
      const fixtureLX = byKind.fixture.gx - fixtureData.cx * CHUNK
      const fixtureLZ = byKind.fixture.gz - fixtureData.cz * CHUNK
      expect(fixtureData.lamps).toContainEqual(expect.objectContaining({
        lx: fixtureLX,
        lz: fixtureLZ,
      }))

      for (const data of fixture.chunks.values()) {
        expect(data.structure).not.toHaveProperty('landmarks')
        expect(data).not.toHaveProperty('towerStructure')
      }
    }
  })

  it('[R25-S01][D05] reproduces frozen descriptors, anchors, vertical connectors, and emitted chunk data independent of request order', () => {
    const seed = FIXED_SEEDS[0]
    const config = forcedTowerConfig()
    const descriptor = findTowerDescriptor(seed, config)
    const repeated = findTowerDescriptor(seed, config)
    expect(repeated).toEqual(descriptor)
    expect(deepFrozen(descriptor)).toBe(true)
    expect(descriptor.anchor).toEqual(descriptor.participants[0])

    const requests = []
    for (let cy = descriptor.baseCy; cy <= descriptor.topCy; cy++) {
      for (const participant of descriptor.participants) requests.push({ ...participant, cy })
    }
    const forward = new Map(requests.map(({ cx, cy, cz }) => [
      key3(cx, cy, cz),
      chunkSnapshot(generateChunk(seed, cx, cy, cz, config)),
    ]))
    for (const { cx, cy, cz } of requests.reverse()) {
      expect(chunkSnapshot(generateChunk(seed, cx, cy, cz, config)))
        .toEqual(forward.get(key3(cx, cy, cz)))
    }
  })
})

describe('Tower descriptor and authored-fixture rejection controls', () => {
  it('[R25-S01][R26-S01][D05] accepts the complete bounded reference fixture used by negative cases', () => {
    expect(towerContractReasons(referenceTowerFixture())).toEqual([])
  })

  it('[R08-S02][R25-S02][D04/D05] rejects a third tower participant', () => {
    const fixture = referenceTowerFixture()
    fixture.descriptor.participants.push({ cx: 2, cz: 0 })
    expect(towerContractReasons(fixture)).toContain('participant-cardinality')
  })

  it.each([
    {
      label: 'canonical id',
      damage(fixture) {
        fixture.approaches[1].id += 1
      },
    },
    {
      label: 'skybridge floor',
      damage(fixture) {
        fixture.approaches[1].levelCy += 1
      },
    },
  ])('[R25-S03][D05] rejects approaches with a mismatched $label', ({ damage }) => {
    const fixture = referenceTowerFixture()
    damage(fixture)
    expect(towerContractReasons(fixture)).toContain('approach-match')
  })

  it('[R25-S04][D05] rejects a floor disconnected by a missing canonical vertical link', () => {
    const fixture = referenceTowerFixture()
    fixture.descriptor.verticalLinks.pop()
    expect(towerContractReasons(fixture)).toContain('floor-connectivity')
  })

  it('[R26-S02][D05] rejects a fixture made from one repeated accent kind', () => {
    const fixture = referenceTowerFixture()
    for (const socket of fixture.descriptor.landmarkSockets) socket.kind = 'litAccent'
    expect(towerContractReasons(fixture)).toContain('mixed-socket-kinds')
  })

  it('[R26-S03][D05] rejects procedural-only decoration without authored socket descriptors', () => {
    const fixture = referenceTowerFixture()
    fixture.descriptor.landmarkSockets = []
    fixture.proceduralDecoration = true
    expect(towerContractReasons(fixture)).toContain('authored-sockets')
  })

  it('[R26-S04][D05] rejects an uncovered skybridge approach', () => {
    const fixture = referenceTowerFixture()
    fixture.descriptor.landmarkSockets = fixture.descriptor.landmarkSockets.filter(
      (socket) => socket.slot !== 'bridgeApproach' || socket.gx < CHUNK
    )
    expect(towerContractReasons(fixture)).toContain('approach-socket-coverage')
  })

  it('[R27-S02][D08] rejects one missing side of the required continuous skybridge guard', () => {
    const fixture = referenceTowerFixture()
    fixture.guards[Math.floor(fixture.guards.length / 2)].positive = false
    expect(towerContractReasons(fixture)).toContain('guard-continuity')
  })

  it('[R27-S04][D05] rejects a cross-district edge while retaining a single finite canonical structure', () => {
    const fixture = referenceTowerFixture()
    fixture.networkEdges.push({
      fromId: fixture.descriptor.id,
      toId: fixture.descriptor.id + 1,
    })
    expect(towerContractReasons(fixture)).toContain('cross-district-network')
  })
})
