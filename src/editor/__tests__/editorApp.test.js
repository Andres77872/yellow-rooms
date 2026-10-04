import { describe, expect, it, vi } from 'vitest'
import { CELL } from '../../world/constants.js'
import { CELL_ROOM } from '../../world/mapTypes.js'
import { FURN_BOOKSHELF, FURN_COUNTER, FURN_DESK } from '../../world/rooms/catalog.js'
import { EditorApp } from '../EditorApp.js'
import { EditorMap, seedFromText } from '../EditorMap.js'
import { serializeMap } from '../format/yrmap.js'

// Scratch kinds the kind lab can be asked for, through the real buildKind:
// one throws mid-build (a level-plate glyph labelFloor rejects), one returns
// an error after building, one throws before changing anything.
vi.mock('../prototypes.js', async (importOriginal) => {
  const actual = await importOriginal()
  const { labelFloor } = await import('../kinds/floorPlan.js')
  const scratch = (map) => {
    for (let gz = 1; gz <= 3; gz++) for (let gx = 1; gx <= 3; gx++) map.setCell(gx, 0, gz, { kind: CELL_ROOM, spaceId: 1 })
    map.addFurniture(2, 0, 2, { kind: FURN_DESK, x: 2.5 * CELL, z: 2.5 * CELL, w: 1.7, d: 0.85, facing: 0 })
  }
  const KINDS = {
    badPlate: { id: 'badPlate', label: 'bad plate', family: 'tower', build: (map) => {
      scratch(map)
      labelFloor(map, 0, 'Q1')
      return { spawn: { gx: 2, gz: 2, cy: 0 } }
    } },
    halfError: { id: 'halfError', label: 'half error', family: 'tower', build: (map) => {
      scratch(map)
      return { error: 'halfError: no stair site' }
    } },
    throwEarly: { id: 'throwEarly', label: 'throw early', family: 'office', palette: 'poolTile', build: () => {
      throw new Error('early')
    } },
  }
  return {
    ...actual,
    generatePrototype: (map, kindId, options) =>
      KINDS[kindId] ? actual.buildKind(map, KINDS[kindId], options) : actual.generatePrototype(map, kindId, options),
  }
})

// EditorApp has no DOM here: stub just what generateKind and the selection
// commands read.
function stubApp(map, mode = 'document') {
  const app = Object.create(EditorApp.prototype)
  Object.assign(app, {
    mode,
    map,
    world: { family: map.meta.family, seedText: 'lobby' },
    view2d: { fitCells() {} },
    preview: null,
    floor: 0,
    selection: null,
    selectedStructureKey: null,
    lab: null,
    notices: [],
    changes: 0,
    notify(text, level) { this.notices.push({ text, level }) },
    onDocumentChanged() { this.changes++ },
    jumpToCell() {},
  })
  return app
}

// A document with history: a furnished room (undo entry 1), a lamp
// (entry 2, undone so it waits on the redo stack).
function documentWithHistory() {
  const map = new EditorMap({ name: 'mine' })
  map.mutate(() => {
    for (let gz = 4; gz <= 6; gz++) for (let gx = 4; gx <= 6; gx++) map.setCell(gx, 0, gz, { kind: CELL_ROOM, spaceId: 7 })
    map.rooms.push({ id: 7, cy: 0, x0: 4, z0: 4, x1: 6, z1: 6, role: 0, salt: 0, door: null, baked: false })
    map.nextRoomId = 8
    map.addFurniture(5, 0, 5, { kind: FURN_COUNTER, x: 5.5 * CELL, z: 5.5 * CELL, w: 1, d: 0.6, facing: 0 })
  })
  map.mutate(() => map.setLamp(5, 0, 5, true))
  map.undo()
  return map
}

describe('EditorApp.generateKind failure', () => {
  for (const [kindId, message] of [
    ['badPlate', /^kind lab: badPlate build failed: labelFloor: "Q1" is not/],
    ['halfError', /^kind lab: halfError: no stair site$/],
  ]) {
    it(`${kindId}: rolls the document back and shows the error`, () => {
      const map = documentWithHistory()
      const bytes = serializeMap(map)
      const undo = [...map._undo]
      const redo = [...map._redo]
      const meta = { ...map.meta }
      const app = stubApp(map, 'explore')
      expect(() => app.generateKind(kindId, 'seed')).not.toThrow()
      expect(app.notices).toHaveLength(1)
      expect(app.notices[0].level).toBe('error')
      expect(app.notices[0].text).toMatch(message)
      // Back exactly as before: chunks, rooms, meta (name included), and the
      // history — no entry for the attempt, the redo still redoable.
      expect(serializeMap(map)).toEqual(bytes)
      expect(map.rooms.map((r) => r.id)).toEqual([7])
      expect(map.nextRoomId).toBe(8)
      expect(map.meta).toEqual(meta)
      expect(map._op).toBeNull()
      expect(map._undo).toHaveLength(undo.length)
      map._undo.forEach((op, i) => expect(op).toBe(undo[i]))
      expect(map._redo).toEqual(redo)
      expect(app.mode).toBe('explore')
      expect(app.lab).toBeNull()
      expect(map.redo()).toBe(true)
      expect(map.lampAt(5, 0, 5).rec.lit).toBe(true)
      expect(map.undo() && map.undo()).toBe(true)
      expect(map.chunks.size).toBe(0)
    })
  }

  it('leaves the previous undo entry alone when the attempt changed nothing', () => {
    const map = new EditorMap({ family: 'office', seed: seedFromText('s') })
    map.mutate(() => { map.meta.palette = 'poolTile' })
    const app = stubApp(map)
    app.generateKind('throwEarly', 's')
    expect(app.notices[0].text).toBe('kind lab: throwEarly build failed: early')
    expect(map._undo).toHaveLength(1)
    expect(map.meta.palette).toBe('poolTile')
  })

  it('still builds a working kind', () => {
    const map = documentWithHistory()
    const app = stubApp(map)
    app.generateKind('underpass', 'proto')
    expect(app.notices.every((n) => n.level !== 'error')).toBe(true)
    expect(app.lab?.kind).toBeTruthy()
    expect(map.rooms.some((r) => r.id === 7 && r.x0 === 4)).toBe(false)
    expect(map.undo()).toBe(true) // one step back to the document
    expect(map.rooms.map((r) => r.id)).toEqual([7])
  })
})

describe('EditorApp stacked furniture selection', () => {
  const gondola = (map, gx, gz) => {
    map.mutate(() => {
      for (const [ox, oz, facing] of [[-0.2, -0.45, 3], [0.2, -0.45, 2], [-0.2, 0.45, 3], [0.2, 0.45, 2]]) {
        map.addFurniture(gx, 0, gz, { kind: FURN_BOOKSHELF, x: (gx + 0.5) * CELL + ox, z: (gz + 0.5) * CELL + oz, w: 0.4, d: 0.9, facing })
      }
    })
  }
  const offsets = (map, gx, gz) => map.furnitureListAt(gx, 0, gz).map(({ rec }) => [
    +(rec.x - (gx + 0.5) * CELL).toFixed(6), +(rec.z - (gz + 0.5) * CELL).toFixed(6), rec.facing, rec.w, rec.d,
  ])

  it('describes a stacked cell as its pieces and a single cell as before', () => {
    const map = new EditorMap()
    gondola(map, 3, 3)
    map.mutate(() => map.addFurniture(5, 0, 3, { kind: FURN_DESK, x: 5.5 * CELL, z: 3.5 * CELL, w: 1.7, d: 0.85, facing: 2 }))
    const app = stubApp(map)
    app.selection = { type: 'furniture', gx: 3, gz: 3, cy: 0 }
    expect(app.describeSelection()).toEqual([
      '4 pieces: bookshelf ×4 @ 3,3 f0',
      'stacked cell · move, rotate and delete act on every piece',
    ])
    app.selection = { type: 'furniture', gx: 5, gz: 3, cy: 0 }
    expect(app.describeSelection()).toEqual(['desk @ 5,3 f0', 'facing +x · 1.70×0.85u'])
    app.selection = { type: 'furniture', gx: 4, gz: 3, cy: 0 }
    expect(app.describeSelection()).toBe('(gone)')
  })

  it('rotates a stacked cell as one arrangement, as one undo step', () => {
    const map = new EditorMap()
    gondola(map, 3, 3)
    const before = offsets(map, 3, 3)
    const app = stubApp(map)
    app.selection = { type: 'furniture', gx: 3, gz: 3, cy: 0 }
    map.takeDirty()
    app.rotateSelection()
    // (ox, oz) → (−oz, ox); facing +x → +z, −x → −z; extents swap.
    expect(offsets(map, 3, 3)).toEqual([
      [0.45, -0.2, 1, 0.9, 0.4], [0.45, 0.2, 0, 0.9, 0.4], [-0.45, -0.2, 1, 0.9, 0.4], [-0.45, 0.2, 0, 0.9, 0.4],
    ])
    expect(map.takeDirty().size).toBeGreaterThan(0) // the chunk re-meshes
    app.rotateSelection()
    app.rotateSelection()
    app.rotateSelection()
    expect(offsets(map, 3, 3)).toEqual(before)
    for (let i = 0; i < 4; i++) expect(map.undo()).toBe(true)
    expect(offsets(map, 3, 3)).toEqual(before)
  })

  it('rotates a single piece onto the cell centre, undoably', () => {
    const map = new EditorMap()
    map.mutate(() => map.addFurniture(5, 0, 3, { kind: FURN_DESK, x: 5.5 * CELL + 0.3, z: 3.5 * CELL, w: 1.7, d: 0.85, facing: 0 }))
    const app = stubApp(map)
    app.selection = { type: 'furniture', gx: 5, gz: 3, cy: 0 }
    app.rotateSelection()
    expect(offsets(map, 5, 3)).toEqual([[0, 0, 3, 0.85, 1.7]])
    expect(map.undo()).toBe(true)
    expect(offsets(map, 5, 3)).toEqual([[0.3, 0, 0, 1.7, 0.85]])
  })

  it('deletes every piece of a stacked cell', () => {
    const map = new EditorMap()
    gondola(map, 3, 3)
    const app = stubApp(map)
    app.select = function (sel) { this.selection = sel }
    app.selection = { type: 'furniture', gx: 3, gz: 3, cy: 0 }
    app.deleteSelection()
    expect(map.furnitureListAt(3, 0, 3)).toEqual([])
    expect(map.cellAt(3, 0, 3).col).toBe(0)
    expect(map.undo()).toBe(true)
    expect(map.furnitureListAt(3, 0, 3)).toHaveLength(4)
  })
})
