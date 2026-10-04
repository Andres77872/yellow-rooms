import { describe, expect, it } from 'vitest'
import { CHUNK, CELL, DOOR_LEAF_FRACTION, cIdx, chunkKey3, hIdx, vIdx } from '../../world/constants.js'
import {
  CELL_ROOM,
  COLUMN_FURNITURE,
  PASSAGE_DOOR,
  PASSAGE_WALL,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_MEETING,
} from '../../world/mapTypes.js'
import { DOOR_WET, edgeContext } from '../../world/doorFunction.js'
import { scheduleDoor } from '../../world/doorSchedule.js'
import { collectDoorways } from '../../world/doors.js'
import { generateChunk } from '../../world/generate.js'
import { worldConfigForFamily } from '../../world/mapFamily.js'
import { signagePlan } from '../../world/objects/dressing/notices.js'
import { SPACE_ROOM } from '../../world/surfaceSet.js'
import { EditorMap, isPristineChunk, cloneChunkData } from '../EditorMap.js'
import { generatePrototype } from '../prototypes.js'
import { FURN_BOOKSHELF, FURN_DESK } from '../../world/rooms/catalog.js'

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

describe('EditorMap stacked furniture cells', () => {
  // A showroom gondola: four bookshelves back to back in one cell, each at
  // its own offset from the cell centre.
  const OFFSETS = [[-0.2, -0.45], [0.2, -0.45], [-0.2, 0.45], [0.2, 0.45]]
  const gondola = (map, gx, gz) => {
    for (const [i, [ox, oz]] of OFFSETS.entries()) {
      map.addFurniture(gx, 0, gz, {
        kind: FURN_BOOKSHELF, x: (map.cellLocal(gx) + 0.5) * CELL + ox, z: (map.cellLocal(gz) + 0.5) * CELL + oz,
        w: 0.4, d: 0.9, facing: i % 2 ? 2 : 3,
      })
    }
  }
  const offsetsAt = (map, gx, gz) => map.furnitureListAt(gx, 0, gz).map(({ rec }) => [
    +(rec.x - (rec.lx + 0.5) * CELL).toFixed(6), +(rec.z - (rec.lz + 0.5) * CELL).toFixed(6), rec.facing,
  ])
  const expected = OFFSETS.map(([ox, oz], i) => [ox, oz, i % 2 ? 2 : 3])

  it('lists every record of a cell; furnitureAt keeps returning the first', () => {
    const map = new EditorMap()
    map.mutate(() => gondola(map, 3, 3))
    const list = map.furnitureListAt(3, 0, 3)
    expect(list).toHaveLength(4)
    expect(list.every(({ chunk }) => chunk === map.chunkAt(0, 0, 0))).toBe(true)
    expect(map.furnitureAt(3, 0, 3).rec).toBe(list[0].rec)
    expect(offsetsAt(map, 3, 3)).toEqual(expected)
    expect(map.furnitureListAt(4, 0, 3)).toEqual([])
    expect(map.furnitureListAt(3, 5, 3)).toEqual([]) // no chunk there
  })

  it('moves every piece across a chunk seam, each keeping its offset, as one undo step', () => {
    const map = new EditorMap()
    map.mutate(() => {
      gondola(map, CHUNK - 1, 2)
      map.addFurniture(CHUNK - 2, 0, 2, { kind: FURN_DESK, x: (CHUNK - 1.5) * CELL, z: 2.5 * CELL, w: 1.7, d: 0.85, facing: 0 })
    })
    const undoDepth = map._undo.length
    const moved = map.moveFurniture(CHUNK - 1, 0, 2, CHUNK, 3)
    expect(moved).toHaveLength(4)
    expect(map._undo.length).toBe(undoDepth + 1)
    expect(map.furnitureListAt(CHUNK - 1, 0, 2)).toEqual([])
    expect(map.cellAt(CHUNK - 1, 0, 2).col).toBe(0)
    expect(map.chunkAt(0, 0, 0).furniture).toHaveLength(1) // the neighbour desk stays
    const there = map.furnitureListAt(CHUNK, 0, 3)
    expect(there.map(({ rec }) => rec)).toEqual(moved)
    expect(there.every(({ chunk, rec }) => chunk.cx === 1 && rec.lx === 0 && rec.lz === 3)).toBe(true)
    expect(offsetsAt(map, CHUNK, 3)).toEqual(expected)
    expect(map.cellAt(CHUNK, 0, 3).col).toBe(COLUMN_FURNITURE)
    // One undo puts all four back; redo moves all four again.
    expect(map.undo()).toBe(true)
    expect(map.furnitureListAt(CHUNK, 0, 3)).toEqual([])
    expect(offsetsAt(map, CHUNK - 1, 2)).toEqual(expected)
    expect(map.cellAt(CHUNK - 1, 0, 2).col).toBe(COLUMN_FURNITURE)
    expect(map.redo()).toBe(true)
    expect(offsetsAt(map, CHUNK, 3)).toEqual(expected)
    expect(map.furnitureListAt(CHUNK - 1, 0, 2)).toEqual([])
  })

  it('refuses an occupied target without touching the stack or the history', () => {
    const map = new EditorMap()
    map.mutate(() => {
      gondola(map, 5, 5)
      map.addFurniture(6, 0, 5, { kind: FURN_DESK, x: 6.5 * CELL, z: 5.5 * CELL, w: 1.7, d: 0.85, facing: 0 })
    })
    const undoDepth = map._undo.length
    expect(map.mutate(() => map.moveFurniture(5, 0, 5, 6, 5))).toBeNull()
    expect(map.moveFurniture(5, 0, 5, 5, 5)).toBeNull() // onto itself: occupied
    expect(map.moveFurniture(7, 0, 5, 8, 5)).toBeNull() // nothing to move
    expect(map._undo.length).toBe(undoDepth)
    expect(offsetsAt(map, 5, 5)).toEqual(expected)
    expect(map.furnitureListAt(6, 0, 5)).toHaveLength(1)
  })

  it('removes every record of the cell and undoes as one step', () => {
    const map = new EditorMap()
    map.mutate(() => gondola(map, 2, 2))
    expect(map.mutate(() => map.removeFurniture(2, 0, 2))).toBe(true)
    expect(map.furnitureListAt(2, 0, 2)).toEqual([])
    expect(map.chunkAt(0, 0, 0).furniture).toEqual([])
    expect(map.cellAt(2, 0, 2).col).toBe(0)
    map.undo()
    expect(offsetsAt(map, 2, 2)).toEqual(expected)
  })

  it('moves a real showroom gondola without losing shelves', () => {
    const map = new EditorMap()
    expect(generatePrototype(map, 'showroom', { seed: 'proto' }).ok).toBe(true)
    // A stacked cell with a free East neighbour on its floor.
    let hit = null
    for (const d of map.chunks.values()) {
      for (const f of d.furniture) {
        const gx = d.cx * CHUNK + f.lx
        const gz = d.cz * CHUNK + f.lz
        if (map.furnitureListAt(gx, d.cy, gz).length < 2) continue
        const c = map.cellAt(gx + 1, d.cy, gz)
        if (!c.col && c.chunk) { hit = { gx, gz, cy: d.cy }; break }
      }
      if (hit) break
    }
    expect(hit).not.toBeNull()
    const total = () => [...map.chunks.values()].reduce((n, d) => n + d.furniture.length, 0)
    const before = total()
    const kinds = map.furnitureListAt(hit.gx, hit.cy, hit.gz).map(({ rec }) => rec.kind)
    expect(map.moveFurniture(hit.gx, hit.cy, hit.gz, hit.gx + 1, hit.gz)).toHaveLength(kinds.length)
    expect(total()).toBe(before)
    expect(map.furnitureListAt(hit.gx + 1, hit.cy, hit.gz).map(({ rec }) => rec.kind)).toEqual(kinds)
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

describe('seedFromText', () => {
  it('hashes seed text like the game and accepts #<uint32> seeds', async () => {
    const { seedFromText } = await import('../EditorMap.js')
    const { hashStr } = await import('../../world/core/hash.js')
    expect(seedFromText('lobby')).toBe(hashStr('lobby'))
    expect(seedFromText('#519299066')).toBe(519299066)
    expect(seedFromText(' #42 ')).toBe(42)
    expect(seedFromText('#x42')).toBe(hashStr('#x42'))
  })
})

describe('undo restores the generated world', () => {
  it('rolls meta.seed/family back with the chunks a bake replaced', () => {
    const map = new EditorMap()
    map.bakeProcedural({ seedText: 'lobby', family: 'office', radius: 0, floors: [0] })
    const first = { ...map.meta }
    map.bakeProcedural({ seedText: 'other', family: 'tower', radius: 0, floors: [0] })
    expect(map.meta.family).toBe('tower')
    map.meta.name = 'renamed'
    expect(map.undo()).toBe(true)
    expect(map.meta.seed).toBe(first.seed)
    expect(map.meta.family).toBe('office')
    expect(map.meta.name).toBe('renamed')
    expect(map.redo()).toBe(true)
    expect(map.meta.family).toBe('tower')
  })

  it("drops a kind's palette when a bake replaces the world (undo restores it)", () => {
    const map = new EditorMap({ family: 'tower', palette: 'poolTile' })
    map.mutate(() => map.clearAll())
    map.bakeChunks({ seed: 7, family: 'office', coords: [{ cx: 0, cy: 0, cz: 0 }] })
    expect(map.meta.family).toBe('office')
    expect(map.meta.palette).toBeNull()
    expect(map.undo()).toBe(true)
    expect(map.meta.palette).toBe('poolTile')
    expect(map.redo()).toBe(true)
    expect(map.meta.palette).toBeNull()
  })
})

// The line-0 doorways of chunk d (the ones whose far side lies across its
// own West / North line), as the door dressing reads them: function, room
// side, hotel number, leaf keep and exit-sign lighting.
function lineZeroDoors(d) {
  const plan = signagePlan(d)
  const out = []
  for (const axis of ['v', 'h']) {
    for (let cell = 0; cell < CHUNK; cell++) {
      const i = axis === 'v' ? vIdx(0, cell) : hIdx(cell, 0)
      const wall = axis === 'v' ? d.wallV[i] : d.wallH[i]
      const passage = axis === 'v' ? d.passageV[i] : d.passageH[i]
      if (wall === 1 || passage !== PASSAGE_DOOR) continue
      const e = edgeContext(d, axis, 0, cell)
      const s = scheduleDoor(d, axis, 0, cell)
      out.push(`${axis}0,${cell}: ${e.fn}/${e.roomSide}/${s.number}/${s.keep}/${plan.exitLit(axis, 0, cell)}`)
    }
  }
  return out
}

// A 6x6 block of storey 0 baked into a document, and the chunks of it whose
// West and North neighbours are baked too.
function bakeBlock(family, seed = 4242) {
  const map = new EditorMap()
  const coords = []
  for (let cz = -3; cz < 3; cz++) for (let cx = -3; cx < 3; cx++) coords.push({ cx, cy: 0, cz })
  map.bakeChunks({ seed, family, coords })
  return { map, interior: coords.filter(({ cx, cz }) => cx > -3 && cz > -3) }
}

describe('EditorMap document seam ring', () => {
  for (const family of ['hotel', 'office']) {
    it(`classifies a baked ${family} block's line-0 doorways as the game does, through undo and redo`, () => {
      const { map, interior } = bakeBlock(family)
      const config = worldConfigForFamily(family)
      const game = new Map(interior.map(({ cx, cz }) => [`${cx},${cz}`, lineZeroDoors(generateChunk(4242, cx, 0, cz, config))]))
      const expectGame = () => {
        for (const { cx, cz } of interior) {
          expect(lineZeroDoors(map.chunkAt(cx, 0, cz)), `chunk ${cx},0,${cz}`).toEqual(game.get(`${cx},${cz}`))
        }
      }
      // Across the seam lie suite, wash, service and guest rooms and fire
      // doors: classified from one side alone, most of these would differ.
      const doors = [...game.values()].flat()
      expect(doors.length).toBeGreaterThan(15)
      expect(doors.filter((s) => / (internal|wet|service|guest)\//.test(s)).length).toBeGreaterThan(5)
      expect(doors.filter((s) => s.endsWith('/true')).length).toBeGreaterThan(5)
      expectGame()

      // An unrelated edit in every chunk, undone: each chunk is restored as a
      // copy, which reads its neighbours from the document again.
      map.mutate(() => {
        for (const { cx, cz } of interior) map.setLamp(cx * CHUNK + 7, 0, cz * CHUNK + 7, true)
      })
      map.undo()
      expect(map.lampAt(7, 0, 7)).toBeNull()
      expectGame()
      map.redo()
      expect(map.lampAt(7, 0, 7).rec.lit).toBe(true)
      expectGame()
    })
  }

  it('reads the document, not the generator: no plan, cloneable, following an edit across the line', () => {
    const { map } = bakeBlock('hotel')
    const d = map.chunkAt(0, 0, 0)
    // The generator's source carried the district plan; the document's seam
    // answers the same questions from the document's own cells.
    expect(d.seam.plan).toBeUndefined()
    expect(Object.keys(d)).not.toContain('seam')
    expect(structuredClone(d).seam).toBeUndefined()
    const ring = d.seam.resolve()
    const west = map.chunkAt(-1, 0, 0)
    expect(ring.west).toEqual(west.district)
    expect(ring.portal).toEqual({ w: false, n: false })
    expect([...ring.id.subarray(0, CHUNK)]).toEqual([...Array(CHUNK).keys()].map((z) => west.spaceId[cIdx(CHUNK - 1, z)]))
    const id = west.spaceId[cIdx(CHUNK - 1, 3)]
    expect(d.seam.plannedId(-1, 3)).toBe(id)
    expect(d.seam.plannedClass(-1, 3)).toBe(west.spaceClass[cIdx(CHUNK - 1, 3)])
    map.mutate(() => map.setCell(-1, 0, 3, { spaceId: 77 }))
    expect(d.seam.resolve().id[3]).toBe(77)
    expect(d.seam.plannedId(-1, 3)).toBe(77)
    map.undo()
    expect(d.seam.resolve().id[3]).toBe(id)
    // A chunk with no neighbour in a district reads no side.
    expect(map.chunkAt(-3, 0, -3).seam.resolve()).toBeNull()
  })

  it('numbers every hotel door of a baked block as the game does, past the chunk edge too', () => {
    // Storey -2 of seed 4242: before the shared slot of several walls lies a
    // corridor the plan names one id and the stamped chunks another.
    const map = new EditorMap()
    const coords = []
    for (let cz = -3; cz < 3; cz++) for (let cx = -3; cx < 3; cx++) coords.push({ cx, cy: -2, cz })
    map.bakeChunks({ seed: 4242, family: 'hotel', coords })
    const config = worldConfigForFamily('hotel')
    const numbers = (d) => collectDoorways(d, DOOR_LEAF_FRACTION).map((w) => `${w.axis}${w.line},${w.cell}: ${w.number}`)
    let numbered = 0
    for (const { cx, cz } of coords) {
      if (cx === -3 || cz === -3) continue
      const game = numbers(generateChunk(4242, cx, -2, cz, config))
      expect(numbers(map.chunkAt(cx, -2, cz)), `chunk ${cx},-2,${cz}`).toEqual(game)
      numbered += game.filter((s) => !s.endsWith(' null')).length
    }
    expect(numbered).toBeGreaterThan(200)
  })

  it('re-meshes the chunk east of an edited East column, and its doorway follows the edit', () => {
    const { map, interior } = bakeBlock('hotel')
    // A guest or suite door on a chunk's West line whose room lies across it.
    let found = null
    for (const { cx, cz } of interior) {
      const d = map.chunkAt(cx, 0, cz)
      for (let z = 0; z < CHUNK && !found; z++) {
        if (d.wallV[vIdx(0, z)] === 1 || d.passageV[vIdx(0, z)] !== PASSAGE_DOOR) continue
        const e = edgeContext(d, 'v', 0, z)
        if (e.lo?.cls === SPACE_ROOM && e.fn !== DOOR_WET) found = { d, z, fn: e.fn }
      }
      if (found) break
    }
    expect(found).toBeTruthy()
    const { d, z, fn } = found
    const key = chunkKey3(d.cx, 0, d.cz)
    const gx = d.cx * CHUNK - 1
    const gz = d.cz * CHUNK + z
    map.takeDirty()
    map.mutate(() => map.setCell(gx, 0, gz, { role: SPACE_ROLE_BATHROOM }))
    expect(map.takeDirty()).toContain(key)
    expect(edgeContext(d, 'v', 0, z).fn).toBe(DOOR_WET)
    map.undo()
    expect(map.takeDirty()).toContain(key)
    expect(edgeContext(map.chunkAt(d.cx, 0, d.cz), 'v', 0, z).fn).toBe(fn)

    // An edit nobody across a seam reads re-meshes the edited chunk alone.
    map.mutate(() => map.setWallV(gx - 3, 0, gz, 1))
    expect([...map.takeDirty()]).toEqual([chunkKey3(d.cx - 1, 0, d.cz)])
  })
})
