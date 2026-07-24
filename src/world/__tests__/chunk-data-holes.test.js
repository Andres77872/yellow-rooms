import { describe, expect, it } from 'vitest'
import { ChunkData } from '../ChunkData.js'
import { CHUNK } from '../constants.js'

function frozenRoom(voidCells, hasRoom = true) {
  return Object.freeze({
    hasRoom,
    voidCells: Object.freeze(
      voidCells.map((cell) => Object.freeze({ ...cell }))
    ),
  })
}

describe('ChunkData multilevel slab-hole membership', () => {
  it('rejects absent, inactive, and non-array room descriptors', () => {
    const data = new ChunkData(0, 0, 0, 0)

    expect(data.hasCeilHole(2, 3)).toBe(false)

    data.structureUp = frozenRoom([{ lx: 2, lz: 3 }], false)
    expect(data.hasCeilHole(2, 3)).toBe(false)

    data.structureUp = Object.freeze({ hasRoom: true, voidCells: null })
    expect(data.hasCeilHole(2, 3)).toBe(false)
  })

  it('compiles duplicate cells and both valid boundary cells exactly once', () => {
    let xReads = 0
    let zReads = 0
    const observedCell = Object.freeze({
      get lx() {
        xReads++
        return CHUNK - 1
      },
      get lz() {
        zReads++
        return CHUNK - 1
      },
    })
    const room = Object.freeze({
      hasRoom: true,
      voidCells: Object.freeze([
        Object.freeze({ lx: 0, lz: 0 }),
        Object.freeze({ lx: 0, lz: 0 }),
        observedCell,
      ]),
    })
    const data = new ChunkData(0, 0, 0, 0)
    data.structureUp = room

    expect(data.hasCeilHole(0, 0)).toBe(true)
    expect(data.hasCeilHole(CHUNK - 1, CHUNK - 1)).toBe(true)
    expect(data.hasCeilHole(6, 6)).toBe(false)
    expect(data.hasCeilHole(CHUNK - 1, CHUNK - 1)).toBe(true)
    expect(xReads).toBe(1)
    expect(zReads).toBe(1)
  })

  it('ignores out-of-bounds descriptor cells without index aliasing', () => {
    const data = new ChunkData(0, 0, 0, 0)
    data.structureDown = frozenRoom([
      { lx: CHUNK, lz: 0 },
      { lx: -1, lz: 1 },
      { lx: 0, lz: CHUNK },
      { lx: 1, lz: -1 },
      { lx: 2.5, lz: 2 },
      { lx: 3, lz: 3 },
    ])

    expect(data.hasFloorHole(3, 3)).toBe(true)
    expect(data.hasFloorHole(0, 1)).toBe(false)
    expect(data.hasFloorHole(CHUNK - 1, 0)).toBe(false)
    expect(data.hasFloorHole(CHUNK, 0)).toBe(false)
    expect(data.hasFloorHole(-1, 1)).toBe(false)
    expect(data.hasFloorHole(2.5, 2)).toBe(false)
  })

  it('keys immutable masks by descriptor identity when a slice is replaced', () => {
    const data = new ChunkData(0, 0, 0, 0)
    const first = frozenRoom([{ lx: 1, lz: 2 }])
    const second = frozenRoom([{ lx: 8, lz: 9 }])

    data.structureUp = first
    expect(data.hasCeilHole(1, 2)).toBe(true)
    expect(data.hasCeilHole(8, 9)).toBe(false)

    data.structureUp = second
    expect(data.hasCeilHole(1, 2)).toBe(false)
    expect(data.hasCeilHole(8, 9)).toBe(true)
    expect(Object.keys(first)).toEqual(['hasRoom', 'voidCells'])
    expect(Object.keys(second)).toEqual(['hasRoom', 'voidCells'])
  })

  it('keeps mutable descriptors live instead of caching stale membership', () => {
    const data = new ChunkData(0, 0, 0, 0)
    const room = {
      hasRoom: true,
      voidCells: [{ lx: 4, lz: 5 }],
    }
    data.structureUp = room

    expect(data.hasCeilHole(4, 5)).toBe(true)
    room.voidCells[0].lx = 7
    room.voidCells[0].lz = 8
    expect(data.hasCeilHole(4, 5)).toBe(false)
    expect(data.hasCeilHole(7, 8)).toBe(true)

    room.voidCells = [{ lx: 10, lz: 11 }]
    expect(data.hasCeilHole(7, 8)).toBe(false)
    expect(data.hasCeilHole(10, 11)).toBe(true)
  })
})
