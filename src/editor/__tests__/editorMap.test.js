import { describe, expect, it } from 'vitest'
import { CHUNK, CELL } from '../../world/constants.js'
import {
  CELL_ROOM,
  COLUMN_FURNITURE,
  PASSAGE_DOOR,
  PASSAGE_WALL,
  SPACE_ROLE_MEETING,
} from '../../world/mapTypes.js'
import { EditorMap, isPristineChunk, cloneChunkData } from '../EditorMap.js'
import { FURN_DESK } from '../../world/rooms/catalog.js'

describe('EditorMap global addressing', () => {
  it('lazily materializes chunks and resolves edge ownership across seams', () => {
    const map = new EditorMap()
    // Vertical line gx=14 is chunk (1,0)'s West line 0.
    map.mutate(() => map.setWallV(CHUNK, 0, 3, 1))
    expect(map.chunkAt(1, 0, 0)).toBeTruthy()
    expect(map.chunkAt(0, 0, 0)).toBeNull()
    expect(map.wallVAt(CHUNK, 0, 3)).toEqual({ wall: 1, passage: PASSAGE_WALL, feature: 0 })
    // The same edge read through a chunkless neighbour cell reports open.
    expect(map.wallVAt(CHUNK - 1, 0, 3).wall).toBe(0)
  })

  it('handles negative coordinates with floor division', () => {
    const map = new EditorMap()
    map.mutate(() => map.setCell(-1, 0, -1, { kind: CELL_ROOM, spaceId: 9 }))
    const d = map.chunkAt(-1, 0, -1)
    expect(d).toBeTruthy()
    expect(d.cellKind[(CHUNK - 1) * CHUNK + (CHUNK - 1)]).toBe(CELL_ROOM)
    expect(map.cellAt(-1, 0, -1).spaceId).toBe(9)
  })

  it('doors set through the passage byte read back as doors', () => {
    const map = new EditorMap()
    map.mutate(() => map.setWallH(2, 0, 5, 0, PASSAGE_DOOR))
    expect(map.wallHAt(2, 0, 5)).toEqual({ wall: 0, passage: PASSAGE_DOOR, feature: 0 })
  })
})

describe('EditorMap objects', () => {
  const desk = { kind: FURN_DESK, x: 0, z: 0, w: 1.7, d: 0.85, facing: 0 }

  it('adds furniture with the collision byte and removes it cleanly', () => {
    const map = new EditorMap()
    map.mutate(() => map.addFurniture(3, 0, 3, { ...desk, x: 3.5 * CELL, z: 3.5 * CELL }))
    expect(map.cellAt(3, 0, 3).col).toBe(COLUMN_FURNITURE)
    expect(map.furnitureAt(3, 0, 3).rec.kind).toBe(FURN_DESK)
    map.mutate(() => map.removeFurniture(3, 0, 3))
    expect(map.cellAt(3, 0, 3).col).toBe(0)
    expect(map.furnitureAt(3, 0, 3)).toBeNull()
  })

  it('moves furniture across a chunk seam, preserving the in-cell offset', () => {
    const map = new EditorMap()
    map.mutate(() => {
      map.addFurniture(13, 0, 2, { ...desk, x: 13.5 * CELL + 0.4, z: 2.5 * CELL - 0.2 })
      map.moveFurniture(13, 0, 2, 14, 2)
    })
    expect(map.furnitureAt(13, 0, 2)).toBeNull()
    expect(map.cellAt(13, 0, 2).col).toBe(0)
    const moved = map.furnitureAt(14, 0, 2)
    expect(moved.chunk.cx).toBe(1)
    expect(moved.rec.lx).toBe(0)
    expect(moved.rec.x).toBeCloseTo(0.5 * CELL + 0.4)
    expect(moved.rec.z).toBeCloseTo(2.5 * CELL - 0.2)
    expect(map.cellAt(14, 0, 2).col).toBe(COLUMN_FURNITURE)
  })

  it('refuses to move onto an occupied cell', () => {
    const map = new EditorMap()
    map.mutate(() => {
      map.addFurniture(1, 0, 1, desk)
      map.addFurniture(2, 0, 1, desk)
    })
    expect(map.mutate(() => map.moveFurniture(1, 0, 1, 2, 1))).toBeNull()
    expect(map.furnitureAt(1, 0, 1)).toBeTruthy()
  })

  it('lamps toggle and delete', () => {
    const map = new EditorMap()
    map.mutate(() => map.setLamp(4, 0, 4, true))
    expect(map.lampAt(4, 0, 4).rec.lit).toBe(true)
    map.mutate(() => map.setLamp(4, 0, 4, false))
    expect(map.lampAt(4, 0, 4).rec.lit).toBe(false)
    map.mutate(() => map.setLamp(4, 0, 4, null))
    expect(map.lampAt(4, 0, 4)).toBeNull()
  })
})

describe('EditorMap undo/redo', () => {
  it('round-trips chunk bytes and room records through undo and redo', () => {
    const map = new EditorMap()
    map.mutate(() => {
      map.setCell(2, 0, 2, { kind: CELL_ROOM, spaceId: 7, role: SPACE_ROLE_MEETING })
      map.rooms.push({ id: 7, cy: 0, x0: 2, z0: 2, x1: 2, z1: 2, role: SPACE_ROLE_MEETING, salt: 0, door: null })
    })
    expect(map.undo()).toBe(true)
    expect(map.chunkAt(0, 0, 0)).toBeNull()
    expect(map.rooms).toHaveLength(0)
    expect(map.redo()).toBe(true)
    expect(map.cellAt(2, 0, 2).role).toBe(SPACE_ROLE_MEETING)
    expect(map.rooms).toHaveLength(1)
    expect(map.undo()).toBe(true)
    expect(map.undo()).toBe(false)
  })

  it('does not record no-op mutations', () => {
    const map = new EditorMap()
    map.mutate(() => {})
    expect(map.undo()).toBe(false)
  })
})

describe('pristine detection and cloning', () => {
  it('a freshly ensured chunk is pristine; any edit changes that', () => {
    const map = new EditorMap()
    const d = map.ensureChunk(0, 0, 0)
    expect(isPristineChunk(d)).toBe(true)
    d.setV(3, 3, 1)
    expect(isPristineChunk(d)).toBe(false)
  })

  it('cloneChunkData produces an independent deep copy of mutable state', () => {
    const map = new EditorMap()
    const d = map.ensureChunk(0, 0, 0)
    d.setV(3, 3, 1)
    d.lamps.push({ lx: 1, lz: 1, lit: 1 })
    const copy = cloneChunkData(d)
    d.setV(3, 3, 0)
    d.lamps[0].lit = 0
    expect(copy.vAt(3, 3)).toBe(1)
    expect(copy.lamps[0].lit).toBe(1)
  })
})
