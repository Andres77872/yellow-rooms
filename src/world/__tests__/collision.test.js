import { describe, it, expect } from 'vitest'
import { moveAndCollide, hasLineOfSight } from '../../player/collision.js'
import { ChunkData } from '../ChunkData.js'
import { CELL, CHUNK, PLAYER_R, WALL_COL_HALF } from '../constants.js'

// Mock ChunkManager backed by a single chunk at the origin.
function mockCM(data) {
  const inRange = (gx, gz) => gx >= 0 && gx < CHUNK && gz >= 0 && gz < CHUNK
  return {
    wallVAt: (gx, gz) => inRange(gx, gz) && data.vAt(gx, gz) === 1,
    wallHAt: (gx, gz) => inRange(gx, gz) && data.hAt(gx, gz) === 1,
    columnAt: (gx, gz) => inRange(gx, gz) && data.colAt(gx, gz) === 1,
  }
}

const STOP = (line) => line * CELL - PLAYER_R - WALL_COL_HALF - 0.001

describe('collision: walls', () => {
  it('stops the player at a vertical wall and never penetrates it', () => {
    const data = new ChunkData(0, 0, 0)
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1) // wall on line x=5
    const cm = mockCM(data)
    const pos = { x: 5 * CELL - 1, z: 7.5 }
    const hit = moveAndCollide(cm, pos, 2, 0) // drive east through the wall
    expect(hit.x).toBe(true)
    expect(pos.x).toBeLessThanOrEqual(STOP(5) + 1e-6)
    expect(pos.x).toBeGreaterThan(5 * CELL - PLAYER_R - 0.2) // stopped just shy
  })

  it('passes through a doorway gap in the wall', () => {
    const data = new ChunkData(0, 0, 0)
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1)
    data.setV(5, 7, 0) // doorway at row z=7
    const cm = mockCM(data)
    const pos = { x: 5 * CELL - 1, z: 7 * CELL + 1.5 } // centred in row 7
    const hit = moveAndCollide(cm, pos, 2, 0)
    expect(hit.x).toBe(false)
    expect(pos.x).toBeCloseTo(5 * CELL + 1, 6) // moved freely through
  })

  it('slides along a wall (blocked axis stops, free axis moves)', () => {
    const data = new ChunkData(0, 0, 0)
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1)
    const cm = mockCM(data)
    const pos = { x: 5 * CELL - 1, z: 7.5 }
    const hit = moveAndCollide(cm, pos, 2, 1) // diagonal into the wall
    expect(hit.x).toBe(true)
    expect(pos.z).toBeCloseTo(8.5, 6) // z slid freely
  })

  it('blocks on a freestanding column', () => {
    const data = new ChunkData(0, 0, 0)
    data.setCol(5, 5, 1)
    const cm = mockCM(data)
    const colCenterX = 5.5 * CELL
    const pos = { x: colCenterX - 2, z: 5.5 * CELL }
    // Engine sub-steps movement (~0.09u/call max), so drive in small steps.
    let blocked = false
    for (let i = 0; i < 60; i++) blocked = moveAndCollide(cm, pos, 0.1, 0).x || blocked
    expect(blocked).toBe(true)
    expect(pos.x).toBeLessThan(colCenterX - 0.3) // stopped west of the column centre
  })
})

describe('collision: line of sight', () => {
  it('is blocked by a wall between two cells', () => {
    const data = new ChunkData(0, 0, 0)
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1)
    const cm = mockCM(data)
    // From cell x=2 to cell x=8 across the wall at line 5.
    expect(hasLineOfSight(cm, 2.5 * CELL, 7.5, 8.5 * CELL, 7.5)).toBe(false)
  })

  it('is clear through a doorway', () => {
    const data = new ChunkData(0, 0, 0)
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1)
    data.setV(5, 7, 0)
    const cm = mockCM(data)
    expect(hasLineOfSight(cm, 2.5 * CELL, 7.5 * CELL, 8.5 * CELL, 7.5 * CELL)).toBe(true)
  })

  it('is clear in fully open space', () => {
    const cm = mockCM(new ChunkData(0, 0, 0))
    expect(hasLineOfSight(cm, 3, 3, 30, 12)).toBe(true)
  })
})
