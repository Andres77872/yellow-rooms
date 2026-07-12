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

const LOAD_COUNT = (LOAD_RADIUS * 2 + 1) ** 2 * (LOAD_RADIUS_Y * 2 + 1)

function makeManager(seed = 1) {
  const cm = new ChunkManager(new THREE.Scene(), seed, null, null)
  const built = []

  // Exercise the real update/queue lifecycle without building render meshes.
  // Resident stand-ins preserve duplicate prevention and unload hysteresis.
  cm._buildNext = function () {
    const request = this.queue.shift()
    this.queued.delete(request.key)
    if (this.chunks.has(request.key)) return
    built.push({ ...request })
    this.chunks.set(request.key, {
      cx: request.cx,
      cy: request.cy,
      cz: request.cz,
      apertures: [],
      dispose() {},
    })
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
    let seed = 0
    let up
    let down
    do {
      up = slabContract(seed, 0, 0, 0, DEFAULT_WORLD_CONFIG).hasStair
      down = slabContract(seed, 0, 0, -1, DEFAULT_WORLD_CONFIG).hasStair
      seed++
    } while (up === down && seed < 10_000)
    seed--
    expect(up).not.toBe(down)

    const { cm, built } = makeManager(seed)
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
})
