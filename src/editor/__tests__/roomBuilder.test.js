import { describe, expect, it } from 'vitest'
import {
  CELL_OPEN,
  CELL_ROOM,
  PASSAGE_DOOR,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_NONE,
  SPACE_ROLE_SERVER,
} from '../../world/mapTypes.js'
import { EditorMap } from '../EditorMap.js'
import { createRoom, regenerateRoom, removeRoom, roomCells } from '../roomBuilder.js'
import { ROOM_TYPES } from '../../world/rooms/catalog.js'

const allFurniture = (map) => {
  const out = []
  for (const d of map.chunks.values()) {
    for (const f of d.furniture) {
      out.push({ ...f, gx: d.cx * 14 + f.lx, gz: d.cz * 14 + f.lz, cy: d.cy })
    }
  }
  return out.sort((a, b) => a.gz - b.gz || a.gx - b.gx || a.kind - b.kind)
}

describe('createRoom', () => {
  it('stamps cells, perimeter walls and a door for the selected area', () => {
    const map = new EditorMap()
    const room = createRoom(map, { cy: 0, x0: 2, z0: 2, x1: 7, z1: 6, role: SPACE_ROLE_MEETING })
    for (let gz = 2; gz <= 6; gz++) {
      for (let gx = 2; gx <= 7; gx++) {
        const c = map.cellAt(gx, 0, gz)
        expect(c.kind).toBe(CELL_ROOM)
        expect(c.spaceId).toBe(room.id)
        expect(c.role).toBe(SPACE_ROLE_MEETING)
      }
    }
    // Perimeter closed except the door edge.
    expect(map.wallVAt(2, 0, 4).wall).toBe(1)
    expect(map.wallVAt(8, 0, 4).wall).toBe(1)
    expect(map.wallHAt(4, 0, 2).wall).toBe(1)
    const door = map.wallHAt(room.door.gx, 0, room.door.gz)
    expect(door.wall).toBe(0)
    expect(door.passage).toBe(PASSAGE_DOOR)
    // Interior edges open.
    expect(map.wallVAt(5, 0, 4).wall).toBe(0)
  })

  it('generates the role anchor and only whitelisted pieces', () => {
    const map = new EditorMap()
    createRoom(map, { cy: 0, x0: 2, z0: 2, x1: 8, z1: 7, role: SPACE_ROLE_MEETING })
    const pieces = allFurniture(map)
    expect(pieces.length).toBeGreaterThan(0)
    const type = ROOM_TYPES[SPACE_ROLE_MEETING]
    expect(pieces.some((p) => p.kind === type.anchor)).toBe(true)
    for (const p of pieces) expect(type.whitelist).toContain(p.kind)
  })

  it('is deterministic for identical inputs and changes on reroll', () => {
    const make = (salt) => {
      const map = new EditorMap()
      createRoom(map, { cy: 0, x0: 2, z0: 2, x1: 9, z1: 8, role: SPACE_ROLE_SERVER, salt })
      return allFurniture(map)
    }
    expect(make(0)).toEqual(make(0))
    const a = make(0)
    const b = make(1)
    // Same anchor guarantees, but the dice differ; layouts should diverge.
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it('furnishes rooms that span a chunk seam without duplicate cells', () => {
    const map = new EditorMap()
    const room = createRoom(map, { cy: 0, x0: 10, z0: 3, x1: 18, z1: 9, role: SPACE_ROLE_SERVER })
    const pieces = allFurniture(map)
    expect(pieces.length).toBeGreaterThan(0)
    const seen = new Set()
    for (const p of pieces) {
      const key = `${p.gx},${p.gz}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
      expect(p.gx).toBeGreaterThanOrEqual(room.x0)
      expect(p.gx).toBeLessThanOrEqual(room.x1)
      expect(p.gz).toBeGreaterThanOrEqual(room.z0)
      expect(p.gz).toBeLessThanOrEqual(room.z1)
    }
    // Both chunks contributed cells.
    expect(map.chunkAt(0, 0, 0)).toBeTruthy()
    expect(map.chunkAt(1, 0, 0)).toBeTruthy()
  })

  it('places a centre lamp and ordinary rooms may furnish from themes', () => {
    const map = new EditorMap()
    const room = createRoom(map, { cy: 0, x0: 2, z0: 2, x1: 7, z1: 6, role: SPACE_ROLE_NONE })
    const gx = Math.floor((room.x0 + room.x1) / 2)
    const gz = Math.floor((room.z0 + room.z1) / 2)
    expect(map.lampAt(gx, 0, gz)?.rec.lit).toBe(true)
  })
})

describe('regenerateRoom / removeRoom', () => {
  it('regenerate clears old objects and rebuilds deterministically', () => {
    const map = new EditorMap()
    const room = createRoom(map, { cy: 0, x0: 2, z0: 2, x1: 9, z1: 8, role: SPACE_ROLE_MEETING })
    const first = allFurniture(map)
    regenerateRoom(map, room)
    expect(allFurniture(map)).toEqual(first)
    regenerateRoom(map, room, { salt: 5 })
    const rerolled = allFurniture(map)
    expect(JSON.stringify(rerolled)).not.toBe(JSON.stringify(first))
    // No stale COLUMN_FURNITURE bytes anywhere.
    for (const p of rerolled) expect(map.furnitureAt(p.gx, 0, p.gz)).toBeTruthy()
  })

  it('remove clears cells, objects, lamps and opens non-shared walls', () => {
    const map = new EditorMap()
    const room = createRoom(map, { cy: 0, x0: 2, z0: 2, x1: 7, z1: 6, role: SPACE_ROLE_MEETING })
    removeRoom(map, room)
    expect(map.rooms).toHaveLength(0)
    expect(allFurniture(map)).toHaveLength(0)
    for (let gz = 2; gz <= 6; gz++) {
      for (let gx = 2; gx <= 7; gx++) {
        const c = map.cellAt(gx, 0, gz)
        expect(c.kind).toBe(CELL_OPEN)
        expect(c.spaceId).toBe(0)
        expect(c.col).toBe(0)
      }
    }
    expect(map.wallVAt(2, 0, 4).wall).toBe(0)
    expect(map.wallHAt(4, 0, 2).wall).toBe(0)
    // Fully-erased document compacts back to nothing.
    expect(map.chunks.size).toBe(0)
  })

  it('remove keeps the shared wall of an adjacent room', () => {
    const map = new EditorMap()
    const left = createRoom(map, { cy: 0, x0: 2, z0: 2, x1: 5, z1: 6, role: SPACE_ROLE_SERVER })
    const right = createRoom(map, { cy: 0, x0: 6, z0: 2, x1: 9, z1: 6, role: SPACE_ROLE_SERVER })
    expect(map.wallVAt(6, 0, 4).wall).toBe(1) // shared boundary line
    removeRoom(map, right)
    expect(map.wallVAt(6, 0, 4).wall).toBe(1) // left room keeps its east wall
    expect(roomCells(map, left).length).toBe(4 * 5)
    // Left room's furniture is untouched.
    expect(allFurniture(map).every((p) => p.gx <= 5)).toBe(true)
  })

  it('undo restores the document after a room placement', () => {
    const map = new EditorMap()
    createRoom(map, { cy: 0, x0: 2, z0: 2, x1: 7, z1: 6, role: SPACE_ROLE_MEETING })
    expect(map.undo()).toBe(true)
    expect(map.rooms).toHaveLength(0)
    expect([...map.chunks.values()].every((d) => d.furniture.length === 0)).toBe(true)
    expect(map.cellAt(3, 0, 3).kind).toBe(CELL_OPEN)
  })
})
