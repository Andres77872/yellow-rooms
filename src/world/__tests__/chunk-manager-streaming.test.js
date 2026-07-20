import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { Chunk } from '../Chunk.js'
import { ChunkManager } from '../ChunkManager.js'
import {
  CELL,
  CHUNK_WORLD,
  LOAD_RADIUS,
  LOAD_RADIUS_Y,
  MAX_BUILDS_PER_FRAME,
  UNLOAD_RADIUS,
  chunkKey3,
} from '../constants.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { worldConfigForFamily } from '../mapFamily.js'
import {
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
} from '../mapTypes.js'
import { slabContract } from '../structures/slab.js'
import { structureAt } from '../structures/contract.js'
import {
  chunkMultilevelRooms,
  multilevelBandBase,
  multilevelConfig,
  multilevelContract,
} from '../structures/multilevel.js'
import { discoverTowerFixture } from './tower-fixture.js'

const LOAD_COUNT = (LOAD_RADIUS * 2 + 1) ** 2 * (LOAD_RADIUS_Y * 2 + 1)

function ordinaryConfig() {
  const config = structuredClone(DEFAULT_WORLD_CONFIG)
  config.multilevel.enabled = false
  return config
}

function tallConfig(levels = 15) {
  const config = structuredClone(DEFAULT_WORLD_CONFIG)
  config.multilevel.minLevels = levels
  config.multilevel.maxLevels = levels
  return config
}

function findStructure(seed, config, levelCy = 0, districtX = 1, districtZ = -1) {
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
      const structure = multilevelContract(
        seed,
        districtX * K + dx,
        districtZ * K + dz,
        baseCy,
        config
      )
      if (structure.hasRoom) return structure
    }
  }
  throw new Error('expected a deterministic multilevel structure')
}

function makeManager(seed = 1, config = ordinaryConfig()) {
  const cm = new ChunkManager(new THREE.Scene(), seed, null, null)
  cm.config = config
  const built = []

  // Exercise the real update/queue lifecycle without building render meshes.
  // Resident stand-ins preserve generation-backed structure discovery,
  // duplicate prevention, visibility and unload hysteresis.
  cm._buildNext = function () {
    const request = this.queue.shift()
    this.queued.delete(request.key)
    if (this.chunks.has(request.key)) return
    built.push({ ...request })
    const rooms = chunkMultilevelRooms(
      this.seed,
      request.cx,
      request.cz,
      request.cy,
      this.config
    )
    const structure = rooms.structure.hasRoom ? rooms.structure : null
    const chunk = {
      cx: request.cx,
      cy: request.cy,
      cz: request.cz,
      structure: structure,
      data: { structure: structure },
      apertures: [],
      lamps: [],
      group: { visible: true },
      dispose() {},
    }
    this.chunks.set(request.key, chunk)
    this._enqueueStructureRequests(structure)
    this._applyVisibility(chunk)
  }

  return { cm, built }
}

function scheduledKeys(cm, built, from = 0) {
  return [...built.slice(from), ...cm.queue].map((request) => request.key)
}

function expectQueueMatchesLoadBox(cm, pcx, pcy, pcz) {
  expect(cm.queued).toEqual(new Set(cm.queue.map((request) => request.key)))
  expect(cm.queue).toHaveLength(new Set(cm.queue.map((request) => request.key)).size)
  for (const request of cm.queue) {
    expect(Math.abs(request.cx - pcx)).toBeLessThanOrEqual(LOAD_RADIUS)
    expect(Math.abs(request.cz - pcz)).toBeLessThanOrEqual(LOAD_RADIUS)
    expect(Math.abs(request.cy - pcy)).toBeLessThanOrEqual(LOAD_RADIUS_Y)
  }
}

function nextCanonicalId(id) {
  return id === 0xffffffff ? id - 1 : id + 1
}

function registerStructureAperture(seed, config, structure, slice, participant, cy) {
  const chunk = Object.assign(Object.create(Chunk.prototype), {
    cx: participant.cx,
    cy,
    cz: participant.cz,
    data: {
      structure: structure,
      structureUp: slice,
    },
    apertures: [],
  })
  chunk._registerStructureAperture(seed, config)
  return chunk.apertures
}

function plannedTowerFixture() {
  const discovered = discoverTowerFixture()
  expect(
    discovered.structure,
    'task 4.3 RED: structureAt must expose a canonical forced-profile Tower descriptor'
  ).toBeDefined()
  return discovered
}

function makeTowerManager(seed, config) {
  const cm = new ChunkManager(new THREE.Scene(), seed, null, null)
  cm.config = config
  const built = []

  // Exercise ChunkManager's real queue/retention/visibility logic while
  // keeping this headless proof independent from mesh construction.
  cm._buildNext = function () {
    const request = this.queue.shift()
    this.queued.delete(request.key)
    if (this.chunks.has(request.key)) return
    built.push({ ...request })
    const resolved = structureAt(
      this.seed,
      request.cx,
      request.cz,
      request.cy,
      this.config
    )
    const structure = resolved?.hasRoom === true ? resolved : null
    const chunk = {
      cx: request.cx,
      cy: request.cy,
      cz: request.cz,
      structure: structure,
      data: { structure: structure },
      apertures: [],
      lamps: [],
      group: { visible: true },
      dispose() {},
    }
    this.chunks.set(request.key, chunk)
    this._enqueueStructureRequests(structure)
    this._applyVisibility(chunk)
  }

  return { cm, built }
}

const LATTICE_SCAN_SEEDS = Object.freeze([0x1a771ce, 0x51a771ce, 0xc0ffee])
let latticeStreamingDiscovery = null

function plannedLatticeFixture() {
  if (!latticeStreamingDiscovery) {
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
              latticeStreamingDiscovery = { config, seed, structure }
              break
            }
          }
          if (latticeStreamingDiscovery) break
        }
        if (latticeStreamingDiscovery) break
      }
      if (latticeStreamingDiscovery) break
    }

    latticeStreamingDiscovery ??= { config, seed: null, structure: null }
  }

  expect(
    latticeStreamingDiscovery.structure,
    'task 5.3 RED: structureAt must expose one canonical forced-profile Lattice district'
  ).not.toBeNull()
  return latticeStreamingDiscovery
}

function makeLatticeManager(seed, config) {
  const cm = new ChunkManager(new THREE.Scene(), seed, null, null)
  cm.config = config
  const built = []

  // This is functional streaming evidence only. The stand-ins exercise the
  // real queue, canonical ownership, visibility, retention, and unload paths;
  // they make no frame-time, memory, rendering, or build-throughput claim.
  cm._buildNext = function () {
    const request = this.queue.shift()
    this.queued.delete(request.key)
    if (this.chunks.has(request.key)) return
    built.push({ ...request })
    const resolved = structureAt(
      this.seed,
      request.cx,
      request.cz,
      request.cy,
      this.config
    )
    const structure = resolved?.hasRoom === true ? resolved : null
    const chunk = {
      cx: request.cx,
      cy: request.cy,
      cz: request.cz,
      structure: structure,
      data: { structure: structure },
      apertures: [],
      lamps: [],
      group: { visible: true },
      dispose() {},
    }
    this.chunks.set(request.key, chunk)
    this._enqueueStructureRequests(structure)
    this._applyVisibility(chunk)
  }

  return { cm, built }
}

describe('ChunkManager streaming queue', () => {
  it('keeps ordinary streaming at exactly the player floor plus cy±1', () => {
    const { cm } = makeManager()
    cm.prewarm(0, 0, 0)

    const residentFloors = new Set(
      [...cm.chunks.values()]
        .filter((chunk) => chunk.cx === 0 && chunk.cz === 0)
        .map((chunk) => chunk.cy)
    )
    expect(residentFloors).toEqual(new Set([-1, 0, 1]))
    expect(cm.chunks.has(chunkKey3(0, 2, 0))).toBe(false)
    expect(cm.chunks.has(chunkKey3(0, -2, 0))).toBe(false)
  })

  it('drops stale requests after a large XZ teleport and rebuilds queued membership', () => {
    const { cm } = makeManager()
    cm.update(0, 0, 0)

    const staleKey = cm.queue[0].key
    cm.queue.push({ ...cm.queue[0] })
    cm.queued.add('orphaned-membership')

    const pcx = LOAD_RADIUS * 3
    const pcz = -LOAD_RADIUS * 3
    cm.update(pcx * CHUNK_WORLD, pcz * CHUNK_WORLD, 0)

    expectQueueMatchesLoadBox(cm, pcx, 0, pcz)
    expect(cm.queued.has(staleKey)).toBe(false)
    expect(cm.queued.has('orphaned-membership')).toBe(false)
    expect(cm.queue).toHaveLength(LOAD_COUNT - MAX_BUILDS_PER_FRAME)
  })

  it('re-centres pending work after rapid floor changes without duplicates', () => {
    const { cm } = makeManager()
    cm.update(0, 0, 0)
    cm.update(0, 0, 5)
    cm.update(0, 0, -4)

    expectQueueMatchesLoadBox(cm, 0, -4, 0)
    expect(cm.queue).toHaveLength(LOAD_COUNT - MAX_BUILDS_PER_FRAME)

    cm.update(0, 0, -4)
    expectQueueMatchesLoadBox(cm, 0, -4, 0)
    expect(cm.queue).toHaveLength(LOAD_COUNT - MAX_BUILDS_PER_FRAME * 2)
  })

  it('recomputes priority and produces deterministic tie ordering', () => {
    const seed = 91
    const targetCx = 2
    const first = makeManager(seed)
    first.cm.update(targetCx * CHUNK_WORLD, 0, 0)
    const expected = scheduledKeys(first.cm, first.built)

    const second = makeManager(seed)
    second.cm.update(0, 0, 0)
    const builtBeforeMove = second.built.length
    second.cm.chunks.clear()
    second.cm.queue.reverse()
    for (const request of second.cm.queue) {
      request.d = -100
      request.floorPriority = 99
      request.xzTie = 99
    }
    second.cm.update(targetCx * CHUNK_WORLD, 0, 0)

    expect(scheduledKeys(second.cm, second.built, builtBeforeMove)).toEqual(expected)
  })

  it('builds the current floor, then connected adjacent-floor chunks ahead of penalized work', () => {
    const config = ordinaryConfig()
    let seed = 0
    let up
    let down
    do {
      up = slabContract(seed, 0, 0, 0, config).hasStair
      down = slabContract(seed, 0, 0, -1, config).hasStair
      seed++
    } while (up === down && seed < 10_000)
    seed--
    expect(up).not.toBe(down)

    const { cm, built } = makeManager(seed, config)
    cm.update(0, 0, 0)
    const order = scheduledKeys(cm, built)
    const connectedCy = up ? 1 : -1
    const unconnectedCy = -connectedCy

    expect(order[0]).toBe(chunkKey3(0, 0, 0))
    expect(order.indexOf(chunkKey3(0, connectedCy, 0))).toBeLessThan(
      order.indexOf(chunkKey3(1, 0, 0))
    )
    expect(order.indexOf(chunkKey3(0, unconnectedCy, 0))).toBeGreaterThan(
      order.indexOf(chunkKey3(1, 0, 0))
    )
  })

  it('prioritizes the connected upper slice of a dynamically discovered structure', () => {
    const seed = 1337
    const config = tallConfig()
    const structure = findStructure(seed, config)
    const { cx, cz } = structure.anchor
    const { cm, built } = makeManager(seed, config)
    cm.update((cx + 0.5) * CHUNK_WORLD, (cz + 0.5) * CHUNK_WORLD, structure.baseCy)
    const order = scheduledKeys(cm, built)
    expect(order[0]).toBe(chunkKey3(cx, structure.baseCy, cz))
    expect(order.indexOf(chunkKey3(cx, structure.baseCy + 1, cz))).toBeLessThan(
      order.indexOf(chunkKey3(cx + 1, structure.baseCy, cz))
    )
    expect(order.indexOf(chunkKey3(cx, structure.baseCy - 1, cz))).toBeGreaterThan(
      order.indexOf(chunkKey3(cx + 1, structure.baseCy, cz))
    )
  })

  it('requires canonical ownership before a descriptor widens residency', () => {
    const seed = 0x51ea6
    const config = tallConfig(15)
    const structure = findStructure(seed, config)
    const playerChunk = structure.participants[0]
    const { cm } = makeManager(seed, config)
    cm._streamPcx = playerChunk.cx
    cm._streamPcy = structure.baseCy
    cm._streamPcz = playerChunk.cz

    const malformed = [
      {
        ...structure,
        id: nextCanonicalId(structure.id),
      },
      {
        ...structure,
        participantChunks: [...structure.participants].reverse(),
      },
      {
        ...structure,
        topCy: structure.topCy + 1,
      },
    ]
    for (const descriptor of malformed) {
      expect(cm._enqueueStructureRequests(descriptor)).toBe(0)
      expect(cm.queue).toEqual([])
      expect(cm.queued).toEqual(new Set())
    }

    expect(cm._enqueueStructureRequests(structure)).toBe(30)
    const widened = cm.queue.find(
      (request) => Math.abs(request.cy - structure.baseCy) > LOAD_RADIUS_Y
    )
    expect(widened).toBeTruthy()

    const forged = {
      ...structure,
      id: nextCanonicalId(structure.id),
    }
    cm._visCy = structure.baseCy
    expect(cm._chunkVisible({
      cx: playerChunk.cx,
      cy: structure.baseCy + LOAD_RADIUS_Y + 1,
      cz: playerChunk.cz,
      structure: forged,
      data: { structure: forged },
    })).toBe(false)

    widened.structure = forged
    cm.queue = [widened]
    cm.queued = new Set([widened.key])
    cm._reconcileQueue(playerChunk.cx, structure.baseCy, playerChunk.cz)
    expect(cm.queue).toEqual([])
    expect(cm.queued).toEqual(new Set())
  })

  it('builds office apertures only after canonical slice ownership validates', () => {
    const seed = 0x51ea6
    const config = tallConfig(15)
    const structure = findStructure(seed, config)
    const participant = structure.participants[0]
    const { up } = chunkMultilevelRooms(
      seed,
      participant.cx,
      participant.cz,
      structure.baseCy,
      config
    )
    expect(up.hasRoom).toBe(true)

    const apertures = registerStructureAperture(
      seed,
      config,
      structure,
      up,
      participant,
      structure.baseCy
    )
    expect(apertures).toHaveLength(1)
    const aperture = apertures[0]
    expect(aperture).toMatchObject({
      kind: 'multilevel',
      id: up.id,
      lowerCy: up.lowerCy,
      baseCy: up.baseCy,
      topCy: up.topCy,
      structureKind: up.kind,
    })
    expect(aperture.minX).toBe(
      participant.cx * CHUNK_WORLD + up.bounds.x0 * CELL
    )
    expect(aperture.maxX).toBe(
      participant.cx * CHUNK_WORLD + (up.bounds.x1 + 1) * CELL
    )
    expect(aperture.minZ).toBe(
      participant.cz * CHUNK_WORLD + up.bounds.z0 * CELL
    )
    expect(aperture.maxZ).toBe(
      participant.cz * CHUNK_WORLD + (up.bounds.z1 + 1) * CELL
    )

    const forgedId = nextCanonicalId(structure.id)
    expect(registerStructureAperture(
      seed,
      config,
      { ...structure, id: forgedId },
      { ...up, id: forgedId },
      participant,
      structure.baseCy
    )).toEqual([])
  })

  it('loads, retains, renders and unloads exactly 30 chunks across a 15-storey structure', () => {
    const seed = 0x51ea7
    const config = tallConfig(15)
    const structure = findStructure(seed, config)
    const playerChunk = structure.participants[0]
    const px = (playerChunk.cx + 0.5) * CHUNK_WORLD
    const pz = (playerChunk.cz + 0.5) * CHUNK_WORLD
    const { cm } = makeManager(seed, config)

    cm.prewarm(px, pz, structure.baseCy)
    cm.updateVisibility(structure.baseCy)

    const structureKeys = []
    for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
      for (const participant of structure.participants) {
        const key = chunkKey3(participant.cx, cy, participant.cz)
        structureKeys.push(key)
        const chunk = cm.chunks.get(key)
        expect(chunk?.structure).toBe(structure)
        expect(chunk?.group.visible).toBe(true)
      }
    }
    expect(structureKeys).toHaveLength(30)

    // A subsequent steady-state update must not apply ordinary Y hysteresis
    // to slices of the same continuous structure.
    cm.update(px, pz, structure.baseCy)
    for (const key of structureKeys) expect(cm.chunks.has(key)).toBe(true)

    // A normal column never inherits the tall structure's vertical lifetime.
    const ordinary = [...cm.chunks.values()].find((chunk) =>
      chunk.cy === structure.baseCy &&
      !chunk.structure &&
      Math.abs(chunk.cx - playerChunk.cx) <= LOAD_RADIUS &&
      Math.abs(chunk.cz - playerChunk.cz) <= LOAD_RADIUS
    )
    expect(ordinary).toBeTruthy()
    expect(cm.chunks.has(chunkKey3(
      ordinary.cx,
      structure.baseCy + 3,
      ordinary.cz
    ))).toBe(false)

    const farPcx = Math.max(
      ...structure.participants.map((participant) => participant.cx)
    ) + UNLOAD_RADIUS + 1
    cm.update((farPcx + 0.5) * CHUNK_WORLD, pz, structure.baseCy)
    for (const key of structureKeys) expect(cm.chunks.has(key)).toBe(false)
  })

  it('unloads and hides unrelated far floors while leaving a visible structure intact', () => {
    const seed = 0x51ea8
    const config = tallConfig(15)
    const structure = findStructure(seed, config)
    const playerChunk = structure.participants[0]
    const px = (playerChunk.cx + 0.5) * CHUNK_WORLD
    const pz = (playerChunk.cz + 0.5) * CHUNK_WORLD
    const { cm } = makeManager(seed, config)
    cm.prewarm(px, pz, structure.baseCy)

    const unrelatedKey = chunkKey3(playerChunk.cx, structure.baseCy + 5, playerChunk.cz + 2)
    const unrelated = {
      cx: playerChunk.cx,
      cy: structure.baseCy + 5,
      cz: playerChunk.cz + 2,
      structure: null,
      data: { structure: null },
      apertures: [],
      lamps: [],
      group: { visible: true },
      dispose() {},
    }
    cm.chunks.set(unrelatedKey, unrelated)
    cm.updateVisibility(structure.baseCy)
    expect(unrelated.group.visible).toBe(false)

    cm.update(px, pz, structure.baseCy)
    expect(cm.chunks.has(unrelatedKey)).toBe(false)
    expect(cm.chunks.has(chunkKey3(
      structure.participants[1].cx,
      structure.topCy,
      structure.participants[1].cz
    ))).toBe(true)
  })
})

describe('bounded Tower streaming evidence (task 4.3 RED)', () => {
  it('[R15-S01..S03][R16-S01][R17-S01..S02] loads, retains, and unloads only the finite two-participant by three-floor Tower volume', () => {
    expect(DEFAULT_WORLD_CONFIG.mapFamily.selected).toBe(MAP_FAMILY_OFFICE)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles[MAP_FAMILY_SEWER].enabled).toBe(true)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles[MAP_FAMILY_TOWER].enabled).toBe(true)

    const { seed, config, structure } = plannedTowerFixture()
    expect(structure.participants).toHaveLength(2)
    expect(structure.levelCount).toBe(3)
    expect(structure.topCy - structure.baseCy).toBe(2)
    expect(structure.globalBounds).toMatchObject({
      x0: expect.any(Number),
      z0: expect.any(Number),
      x1: expect.any(Number),
      z1: expect.any(Number),
    })
    expect(config.mapFamily.profiles[MAP_FAMILY_TOWER].enabled).toBe(true)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles[MAP_FAMILY_TOWER].enabled).toBe(true)

    const playerChunk = structure.participants[0]
    const px = (playerChunk.cx + 0.5) * CHUNK_WORLD
    const pz = (playerChunk.cz + 0.5) * CHUNK_WORLD
    const { cm } = makeTowerManager(seed, config)
    cm._streamPcx = playerChunk.cx
    cm._streamPcy = structure.baseCy
    cm._streamPcz = playerChunk.cz

    expect(cm._enqueueStructureRequests(structure)).toBe(6)
    while (cm.queue.length) cm._buildNext()

    const structureKeys = []
    for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
      for (const participant of structure.participants) {
        const key = chunkKey3(participant.cx, cy, participant.cz)
        structureKeys.push(key)
        expect(cm.chunks.get(key)?.structure).toEqual(structure)
      }
    }
    expect(structureKeys).toHaveLength(6)

    cm.updateVisibility(structure.baseCy)
    for (const key of structureKeys) {
      expect(cm.chunks.get(key)?.group.visible).toBe(true)
    }

    // Retention is finite functional availability only. It does not establish
    // a memory, frame-time, rendering-throughput, or unrestricted-A* claim.
    cm.update(px, pz, structure.baseCy)
    for (const key of structureKeys) expect(cm.chunks.has(key)).toBe(true)

    const farPcx = Math.max(...structure.participants.map(({ cx }) => cx)) +
      UNLOAD_RADIUS + 1
    cm.update((farPcx + 0.5) * CHUNK_WORLD, pz, structure.baseCy)
    for (const key of structureKeys) expect(cm.chunks.has(key)).toBe(false)
  })

  it('[R16-S03][R27-S04] refuses cross-canonical Tower residency and visibility', () => {
    const { seed, config, structure } = plannedTowerFixture()
    const participant = structure.participants[0]
    const { cm } = makeTowerManager(seed, config)
    cm._streamPcx = participant.cx
    cm._streamPcy = structure.baseCy
    cm._streamPcz = participant.cz
    cm._visCy = structure.baseCy

    const otherId = nextCanonicalId(structure.id)
    const crossCanonical = { ...structure, id: otherId }
    expect(cm._enqueueStructureRequests(crossCanonical)).toBe(0)
    expect(cm.queue).toEqual([])
    expect(cm._chunkVisible({
      cx: participant.cx,
      cy: structure.topCy,
      cz: participant.cz,
      structure: crossCanonical,
      data: { structure: crossCanonical },
    })).toBe(false)

    // Reused office vocabulary is not Tower registration. Residency and
    // visibility must resolve through the explicit matching adapter.
    const inferredKind = { ...structure, kind: 'bridged' }
    expect(cm._enqueueStructureRequests(inferredKind)).toBe(0)
    expect(cm.queue).toEqual([])
    expect(cm._chunkVisible({
      cx: participant.cx,
      cy: structure.topCy,
      cz: participant.cz,
      structure: inferredKind,
      data: { structure: inferredKind },
    })).toBe(false)
  })
})

describe('bounded Lattice streaming evidence (task 5.3 RED)', () => {
  it('[R15-S01..S03][R16-S01][R17-S01..S02][R29-S01] covers exactly nine participants and all three floors from the middle floor with LOAD_RADIUS_Y=1', () => {
    expect(LOAD_RADIUS_Y).toBe(1)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.selected).toBe(MAP_FAMILY_OFFICE)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles[MAP_FAMILY_SEWER].enabled).toBe(true)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles[MAP_FAMILY_TOWER].enabled).toBe(true)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles[MAP_FAMILY_LATTICE].enabled).toBe(true)

    const { seed, config, structure } = plannedLatticeFixture()
    expect(config.mapFamily.profiles[MAP_FAMILY_LATTICE].enabled).toBe(true)
    expect(config.version).toBe(DEFAULT_WORLD_CONFIG.version)
    expect(structure).toMatchObject({
      family: MAP_FAMILY_LATTICE,
      kind: 'latticeDistrict',
      levelCount: 3,
      district: { size: 3 },
    })
    expect(structure.participants).toHaveLength(9)
    expect(structure.topCy - structure.baseCy).toBe(2)
    expect(structure).not.toHaveProperty('latticeSpan')

    const middleCy = structure.baseCy + 1
    const playerChunk = structure.anchor
    const px = (playerChunk.cx + 0.5) * CHUNK_WORLD
    const pz = (playerChunk.cz + 0.5) * CHUNK_WORLD
    const { cm } = makeLatticeManager(seed, config)
    cm._streamPcx = playerChunk.cx
    cm._streamPcy = middleCy
    cm._streamPcz = playerChunk.cz

    expect(cm._enqueueStructureRequests(structure)).toBe(27)
    while (cm.queue.length) cm._buildNext()

    const structureKeys = []
    const coveredFloors = new Set()
    for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
      for (const participant of structure.participants) {
        const key = chunkKey3(participant.cx, cy, participant.cz)
        structureKeys.push(key)
        coveredFloors.add(cy)
        expect(cm.chunks.get(key)?.structure).toEqual(structure)
      }
    }
    expect(structureKeys).toHaveLength(27)
    expect(coveredFloors).toEqual(new Set([
      structure.baseCy,
      middleCy,
      structure.topCy,
    ]))

    cm.updateVisibility(middleCy)
    for (const key of structureKeys) {
      expect(cm.chunks.get(key)?.group.visible).toBe(true)
    }

    cm.update(px, pz, middleCy)
    for (const key of structureKeys) expect(cm.chunks.has(key)).toBe(true)

    const farPcx = Math.max(...structure.participants.map(({ cx }) => cx)) +
      UNLOAD_RADIUS + 1
    cm.update((farPcx + 0.5) * CHUNK_WORLD, pz, middleCy)
    for (const key of structureKeys) expect(cm.chunks.has(key)).toBe(false)
  })

  it('[R09-S02..S06][R16-S03][R31-S03] refuses missing-polygon, conflicting-owner, missing-floor, and inferred-kind Lattice authority', () => {
    const { seed, config, structure } = plannedLatticeFixture()
    const participant = structure.anchor
    const middleCy = structure.baseCy + 1
    const { cm } = makeLatticeManager(seed, config)
    cm._streamPcx = participant.cx
    cm._streamPcy = middleCy
    cm._streamPcz = participant.cz
    cm._visCy = middleCy

    const malformed = [
      {
        ...structure,
        participants: structure.participants.slice(0, -1),
      },
      {
        ...structure,
        id: nextCanonicalId(structure.id),
      },
      {
        ...structure,
        topCy: structure.topCy - 1,
        levelCount: 2,
      },
      {
        ...structure,
        kind: 'bridged',
      },
    ]

    for (const descriptor of malformed) {
      expect(cm._enqueueStructureRequests(descriptor)).toBe(0)
      expect(cm.queue).toEqual([])
      expect(cm.queued).toEqual(new Set())
      expect(cm._chunkVisible({
        cx: participant.cx,
        cy: structure.topCy,
        cz: participant.cz,
        structure: descriptor,
        data: { structure: descriptor },
      })).toBe(false)
    }
  })
})
