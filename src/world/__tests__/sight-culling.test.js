import { describe, expect, it } from 'vitest'
import { ChunkData } from '../ChunkData.js'
import { CELL, CHUNK, CHUNK_WORLD, FOG_DENSITY } from '../constants.js'
import { PASSAGE_DOOR, PASSAGE_WALL, WALL_WINDOW } from '../mapTypes.js'
import { LightGrid } from '../lightGrid/LightGrid.js'
import { SIGHT_FOG_DIST, SIGHT_NEAR_KEEP, SightCulling } from '../lightGrid/SightCulling.js'

// A row of chunks along +x with one full-height partition wall on the
// vertical line lx = 0 of chunk `wallAt` (optionally with a doorway/window).
function corridorWorld({ wallAt = 2, opening = null, count = 5 } = {}) {
  const grid = new LightGrid()
  for (let cx = 0; cx < count; cx++) {
    const d = new ChunkData(cx, 0, 0, 0)
    if (cx === wallAt) {
      for (let z = 0; z < CHUNK; z++) d.setV(0, z, 1, PASSAGE_WALL)
      if (opening === 'door') d.setV(0, 7, 0, PASSAGE_DOOR)
      if (opening === 'window') d.setV(0, 7, 1, PASSAGE_WALL, WALL_WINDOW)
    }
    grid.addChunk(d)
  }
  return grid
}

describe('SightCulling', () => {
  it('stops sight at a solid partition but keeps the wall owner drawn', () => {
    const grid = corridorWorld()
    const sc = new SightCulling(grid)
    sc.update(CHUNK_WORLD * 0.5, CHUNK_WORLD * 0.5, 0)
    expect(sc.chunkVisible(0, 0)).toBe(true)
    expect(sc.chunkVisible(1, 0)).toBe(true)
    expect(sc.chunkVisible(2, 0)).toBe(true) // owns the wall line the rays stop on
    expect(sc.chunkVisible(3, 0)).toBe(false)
    expect(sc.chunkVisible(4, 0)).toBe(false)
  })

  it('sees through doorways and windows', () => {
    for (const opening of ['door', 'window']) {
      const sc = new SightCulling(corridorWorld({ opening }))
      sc.update(CHUNK_WORLD * 0.5, 7.5 * CELL, 0)
      expect(sc.chunkVisible(3, 0), opening).toBe(true)
    }
  })

  it('never culls the chunks within the near-keep radius', () => {
    const grid = corridorWorld({ wallAt: 1 })
    const sc = new SightCulling(grid)
    // Standing just inside chunk 0 at its east edge: chunk 1 is within 6 m.
    sc.update(CHUNK_WORLD - SIGHT_NEAR_KEEP / 2, CHUNK_WORLD * 0.5, 0)
    expect(sc.chunkVisible(1, 0)).toBe(true)
  })

  it('floods only to the 95% fog distance and re-floods on movement', () => {
    const fog = 1 - Math.exp(-((FOG_DENSITY * SIGHT_FOG_DIST) ** 2))
    expect(fog).toBeCloseTo(0.95, 6)
    const grid = corridorWorld({ wallAt: 99, count: 7 })
    const sc = new SightCulling(grid)
    expect(sc.update(1.5, 1.5, 0)).toBe(true)
    expect(sc.chunkVisible(Math.ceil(SIGHT_FOG_DIST / CHUNK_WORLD) + 1, 0)).toBe(false)
    expect(sc.update(1.6, 1.5, 0)).toBe(false) // turning / tiny moves cost nothing
    expect(sc.update(3.0, 1.5, 0)).toBe(true)
    expect(sc.floor).toBe(0)
    sc.invalidate()
    expect(sc.update(3.0, 1.5, 0)).toBe(true)
  })
})
