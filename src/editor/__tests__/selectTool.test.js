import { describe, expect, it } from 'vitest'
import { CELL, CHUNK } from '../../world/constants.js'
import { FURN_BOOKSHELF, FURN_DESK } from '../../world/rooms/catalog.js'
import { EditorMap } from '../EditorMap.js'
import { SelectTool } from '../ui/tools.js'

// The select tool against a stub app: just what onDown/onMove/onUp read.
function stubApp(map) {
  return {
    floor: 0,
    readOnly: false,
    map,
    selection: null,
    select(s) { this.selection = s },
    guardCeiling: () => false,
    guardCell: () => false,
    onDocumentChanged() {},
    inspectAt() {},
  }
}

function drag(tool, from, to) {
  tool.onDown(from)
  tool.onMove(to, { buttons: 1 })
  tool.onUp()
}

describe('SelectTool furniture drag', () => {
  it('drags every piece of a stacked cell, across a chunk seam, as one undo step', () => {
    const map = new EditorMap()
    map.mutate(() => {
      for (const ox of [-0.2, 0.2]) {
        map.addFurniture(CHUNK - 1, 0, 4, { kind: FURN_BOOKSHELF, x: (CHUNK - 0.5) * CELL + ox, z: 4.5 * CELL, w: 0.4, d: 0.9, facing: ox < 0 ? 3 : 2 })
      }
      map.addFurniture(CHUNK + 1, 0, 4, { kind: FURN_DESK, x: 1.5 * CELL, z: 4.5 * CELL, w: 1.7, d: 0.85, facing: 0 })
    })
    const app = stubApp(map)
    const tool = new SelectTool(app)
    tool.onDown({ gx: CHUNK - 1, gz: 4 })
    tool.onMove({ gx: CHUNK, gz: 4 }, { buttons: 1 })
    tool.onMove({ gx: CHUNK + 1, gz: 4 }, { buttons: 1 }) // occupied: stays put
    tool.onUp()
    expect(app.selection).toEqual({ type: 'furniture', gx: CHUNK, gz: 4, cy: 0 })
    expect(map.furnitureListAt(CHUNK - 1, 0, 4)).toEqual([])
    const moved = map.furnitureListAt(CHUNK, 0, 4).map(({ rec }) => +(rec.x - 0.5 * CELL).toFixed(6))
    expect(moved).toEqual([-0.2, 0.2])
    expect(map.furnitureListAt(CHUNK + 1, 0, 4)).toHaveLength(1)
    expect(map.undo()).toBe(true)
    expect(map.furnitureListAt(CHUNK - 1, 0, 4)).toHaveLength(2)
    expect(map.furnitureListAt(CHUNK, 0, 4)).toEqual([])
  })
})

describe('SelectTool lamp drag', () => {
  it('moves a tinted lamp with its tint', () => {
    const map = new EditorMap()
    map.mutate(() => map.setLamp(4, 0, 4, true, 0xff4030))
    drag(new SelectTool(stubApp(map)), { gx: 4, gz: 4 }, { gx: 5, gz: 4 })
    expect(map.lampAt(4, 0, 4)).toBeNull()
    expect(map.lampAt(5, 0, 4).rec).toEqual({ lx: 5, lz: 4, lit: true, tint: 0xff4030 })
  })

  it('leaves an untinted lamp without a tint key', () => {
    const map = new EditorMap()
    map.mutate(() => map.setLamp(4, 0, 4, false))
    drag(new SelectTool(stubApp(map)), { gx: 4, gz: 4 }, { gx: 4, gz: 5 })
    expect(map.lampAt(4, 0, 5).rec).toEqual({ lx: 4, lz: 5, lit: false })
  })
})
