import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { ChunkManager } from '../ChunkManager.js'
import {
  CHUNK_WORLD,
  LOAD_RADIUS,
  LOAD_RADIUS_Y,
  MAX_BUILDS_PER_FRAME,
  chunkKey3,
} from '../constants.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { slabContract } from '../slab.js'
import {
  chunkMultilevelRooms,
  multilevelConfig,
  multilevelContract,
} from '../multilevel.js'

const LOAD_COUNT = (LOAD_RADIUS * 2 + 1) ** 2 * (LOAD_RADIUS_Y * 2 + 1)

function ordinaryConfig() {
  const config = structuredClone(DEFAULT_WORLD_CONFIG)
  config.multilevel.enabled = false
  return config
}

function tallConfig(levels = 10) {
  const config = structuredClone(DEFAULT_WORLD_CONFIG)
  config.multilevel.minLevels = levels
  config.multilevel.maxLevels = levels
  return config
}

function findStructure(seed, config, baseCy = 0, districtX = 1, districtZ = -1) {
  const K = multilevelConfig(config).districtChunks
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
      multilevelStructure: structure,
      data: { multilevelStructure: structure },
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

  it('loads, retains and renders both chunks across every floor of a 10-level structure', () => {
    const seed = 0x51ea7
    const config = tallConfig(10)
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
        expect(chunk?.multilevelStructure).toBe(structure)
        expect(chunk?.group.visible).toBe(true)
      }
    }
    expect(structureKeys).toHaveLength(20)

    // A subsequent steady-state update must not apply ordinary Y hysteresis
    // to slices of the same continuous structure.
    cm.update(px, pz, structure.baseCy)
    for (const key of structureKeys) expect(cm.chunks.has(key)).toBe(true)

    // A normal column never inherits the tall structure's vertical lifetime.
    const ordinary = [...cm.chunks.values()].find((chunk) =>
      chunk.cy === structure.baseCy &&
      !chunk.multilevelStructure &&
      Math.abs(chunk.cx - playerChunk.cx) <= LOAD_RADIUS &&
      Math.abs(chunk.cz - playerChunk.cz) <= LOAD_RADIUS
    )
    expect(ordinary).toBeTruthy()
    expect(cm.chunks.has(chunkKey3(
      ordinary.cx,
      structure.baseCy + 3,
      ordinary.cz
    ))).toBe(false)
  })

  it('unloads and hides unrelated far floors while leaving a visible structure intact', () => {
    const seed = 0x51ea8
    const config = tallConfig(10)
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
      multilevelStructure: null,
      data: { multilevelStructure: null },
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
