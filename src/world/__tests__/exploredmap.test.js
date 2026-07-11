import { describe, it, expect } from 'vitest'
import { ExploredMap } from '../ExploredMap.js'
import { ChunkData } from '../ChunkData.js'
import { generateChunk, DEFAULT_WORLD_CONFIG } from '../generate.js'
import { CELL, CHUNK } from '../constants.js'

// Minimal ChunkManager stub: one chunk at the origin. Provides the fields
// ExploredMap reads (chunks/seed/config/exit/clearings) plus the wall queries
// hasLineOfSight needs during the reveal walk. The player stands deep inside
// chunk (0,0) so every revealed cell stays in that chunk — ExploredMap captures
// the live `data` ref and the generate fallback is never exercised here.
function mockCM(data) {
  const inRange = (gx, gz) => gx >= 0 && gx < CHUNK && gz >= 0 && gz < CHUNK
  return {
    seed: 1,
    config: DEFAULT_WORLD_CONFIG,
    exit: null,
    clearings: [],
    chunks: new Map([['0,0,0', { data }]]), // live map is keyed (cx,cy,cz) in v8
    wallVAt: (gx, gz) => inRange(gx, gz) && data.vAt(gx, gz) === 1,
    wallHAt: (gx, gz) => inRange(gx, gz) && data.hAt(gx, gz) === 1,
    columnAt: (gx, gz) => inRange(gx, gz) && data.colAt(gx, gz) === 1,
  }
}

// A chunk split by a solid vertical wall on line x=5, with one doorway at row 7.
function walledChunk(doorway = true) {
  const data = new ChunkData(0, 0, 0, 0)
  for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1)
  if (doorway) data.setV(5, 7, 0) // doorway at row z=7
  return data
}

const cellCenter = (g) => (g + 0.5) * CELL

describe('ExploredMap: fog-of-war reveal', () => {
  it('reveals the player cell and line-of-sight neighbours, not the unseen', () => {
    const em = new ExploredMap(mockCM(walledChunk()))
    em.update(cellCenter(7), cellCenter(7)) // stand in cell (7,7), east of the wall

    expect(em.isRevealed(7, 7)).toBe(true) // own cell
    expect(em.isRevealed(9, 7)).toBe(true) // clear sightline, same side
    expect(em.isRevealed(2, 7)).toBe(true) // visible through the doorway (row 7)
    expect(em.isRevealed(2, 9)).toBe(false) // blocked by the solid wall
    expect(em.isRevealed(1, 1)).toBe(false) // beyond the reveal radius
  })

  it('does not see through a solid wall even within radius', () => {
    const em = new ExploredMap(mockCM(walledChunk(false))) // no doorway
    em.update(cellCenter(7), cellCenter(7))

    expect(em.isRevealed(7, 7)).toBe(true)
    expect(em.isRevealed(2, 7)).toBe(false) // wall blocks the only sightline
  })

  it('exposes wall queries over the stored data for the renderer', () => {
    const em = new ExploredMap(mockCM(walledChunk()))
    em.update(cellCenter(7), cellCenter(7))
    expect(em.wallVAt(5, 8)).toBe(true) // solid segment
    expect(em.wallVAt(5, 7)).toBe(false) // the doorway
  })

  it('recompute is a no-op until the player crosses a cell boundary', () => {
    const em = new ExploredMap(mockCM(walledChunk()))
    em.update(cellCenter(7), cellCenter(7))
    const sum = () => em.chunks.get('0,0,0').revealed.reduce((a, b) => a + b, 0)
    const before = sum()
    em.update(cellCenter(7) + 0.1, cellCenter(7) - 0.1) // same cell
    expect(sum()).toBe(before)
  })

  it('keeps each floor\'s fog isolated (v8)', () => {
    const cm = mockCM(walledChunk())
    cm.seed = 12345
    const em = new ExploredMap(cm)
    em.update(cellCenter(7), cellCenter(7), 0)
    expect(em.isRevealed(7, 7, 0)).toBe(true)
    expect(em.isRevealed(7, 7, 1)).toBe(false) // floor 1 untouched
    em.update(cellCenter(7), cellCenter(7), 1) // player climbs a floor
    expect(em.isRevealed(7, 7, 1)).toBe(true)
    expect(em.isRevealed(7, 7, 0)).toBe(true) // floor 0 fog preserved
  })

  it('reset() clears all fog', () => {
    const em = new ExploredMap(mockCM(walledChunk()))
    em.update(cellCenter(7), cellCenter(7))
    expect(em.chunks.size).toBeGreaterThan(0)
    em.reset()
    expect(em.chunks.size).toBe(0)
    expect(em.isRevealed(7, 7)).toBe(false)
  })
})

// Sanity: the regen fallback must reproduce ChunkManager's build for ordinary
// chunks (no exit/clearing) so the minimap stays consistent after unload.
describe('ExploredMap: dataAt fallback', () => {
  it('regenerates an unloaded chunk identically to generateChunk, per floor', () => {
    const cm = mockCM(walledChunk())
    cm.seed = 12345
    const em = new ExploredMap(cm)
    for (const cy of [0, 1, -2]) {
      const got = em.dataAt(3, cy, 4) // not in cm.chunks -> fallback regen
      const want = generateChunk(12345, 3, cy, 4, DEFAULT_WORLD_CONFIG, null, null)
      expect(Array.from(got.wallV)).toEqual(Array.from(want.wallV))
      expect(Array.from(got.wallH)).toEqual(Array.from(want.wallH))
    }
  })
})
