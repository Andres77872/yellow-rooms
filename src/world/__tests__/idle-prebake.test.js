import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { ChunkManager } from '../ChunkManager.js'
import { chunkKey3 } from '../constants.js'
import { forcedFamilyConfig } from '../families/forced.js'

// Idle prebake scheduling (spec §9.7): the neighbour-tile prebake runs only on
// a frame whose build loop built nothing, so a cold bake never shares its
// frame with a second (prebake) bake.

function makeManager() {
  const cm = new ChunkManager(new THREE.Scene(), 777, null, null)
  cm.config = forcedFamilyConfig('stairwell')
  // Drive the loop by hand: no planning/unload, stand-in builds, spy prebake.
  cm._planStreamingRequests = () => {}
  cm._unloadOutsideStreamingBounds = () => {}
  cm._buildNext = vi.fn(function () {
    const request = this.queue.shift()
    this.queued.delete(request.key)
  })
  cm._idlePrebake = vi.fn()
  cm.update(0, 0, 0) // builds the tile probe for this config
  expect(typeof cm._tileProbe).toBe('function')
  cm._tileProbe = () => true // every request is a cold bake
  cm._buildNext.mockClear()
  cm._idlePrebake.mockClear()
  return cm
}

const request = (cx, cy, cz) => ({ cx, cy, cz, key: chunkKey3(cx, cy, cz) })

describe('ChunkManager idle prebake', () => {
  it('does not prebake on a frame that just built (cold) chunks', () => {
    const cm = makeManager()
    cm.queue.push(request(3, 0, 0))
    cm.update(0, 0, 0)
    expect(cm._buildNext).toHaveBeenCalledTimes(1)
    expect(cm.queue).toHaveLength(0)
    expect(cm._idlePrebake).not.toHaveBeenCalled()
  })

  it('a cold bake in the queue head after a build waits for the next frame', () => {
    const cm = makeManager()
    cm.queue.push(request(3, 0, 0), request(4, 0, 0))
    cm.update(0, 0, 0)
    expect(cm._buildNext).toHaveBeenCalledTimes(1)
    expect(cm.queue).toHaveLength(1)
    expect(cm._idlePrebake).not.toHaveBeenCalled()
    cm.update(0, 0, 0)
    expect(cm._buildNext).toHaveBeenCalledTimes(2)
    expect(cm._idlePrebake).not.toHaveBeenCalled()
  })

  it('prebakes on the first frame with an empty queue and no build', () => {
    const cm = makeManager()
    cm.update(0, 0, 0)
    expect(cm._buildNext).not.toHaveBeenCalled()
    expect(cm._idlePrebake).toHaveBeenCalledTimes(1)
    expect(cm._idlePrebake).toHaveBeenCalledWith(0, 0, 0)
  })

  it('never prebakes for a legacy family (no tile probe)', () => {
    const cm = new ChunkManager(new THREE.Scene(), 777, null, null)
    cm._planStreamingRequests = () => {}
    cm._unloadOutsideStreamingBounds = () => {}
    cm._idlePrebake = vi.fn()
    cm.update(0, 0, 0)
    expect(cm._tileProbe).toBeNull()
    expect(cm._idlePrebake).not.toHaveBeenCalled()
  })
})
