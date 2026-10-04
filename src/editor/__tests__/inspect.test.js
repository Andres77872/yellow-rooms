import { describe, expect, it } from 'vitest'
import { CELL } from '../../world/constants.js'
import { FURN_BOOKSHELF, FURN_DESK } from '../../world/rooms/catalog.js'
import { EditorMap } from '../EditorMap.js'
import { inspectCell } from '../inspect.js'

const furnitureLines = (res) => res.lines.filter((l) => /furniture/.test(l) && !l.startsWith('lamps '))

describe('inspectCell furniture', () => {
  it('lists a one-piece cell on one line', () => {
    const map = new EditorMap()
    map.mutate(() => map.addFurniture(3, 0, 3, { kind: FURN_DESK, x: 3.5 * CELL, z: 3.5 * CELL, w: 1.7, d: 0.85, facing: 2 }))
    expect(furnitureLines(inspectCell(map, 3, 0, 3))).toEqual([`furniture kind ${FURN_DESK} · 1.70×0.85 · facing 2`])
    expect(furnitureLines(inspectCell(map, 4, 0, 3))).toEqual([])
  })

  it('lists every record of a stacked cell', () => {
    const map = new EditorMap()
    map.mutate(() => {
      map.addFurniture(3, 0, 3, { kind: FURN_BOOKSHELF, x: 3.5 * CELL - 0.2, z: 3.5 * CELL, w: 0.4, d: 0.9, facing: 3 })
      map.addFurniture(3, 0, 3, { kind: FURN_BOOKSHELF, x: 3.5 * CELL + 0.2, z: 3.5 * CELL, w: 0.4, d: 0.9, facing: 2 })
      map.addFurniture(3, 0, 3, { kind: FURN_DESK, x: 3.5 * CELL, z: 3.5 * CELL + 0.5, w: 1.7, d: 0.85, facing: 0 })
    })
    const lines = furnitureLines(inspectCell(map, 3, 0, 3))
    const at = (dx, dz) => `${(3.5 * CELL + dx).toFixed(2)},${(3.5 * CELL + dz).toFixed(2)}`
    expect(lines).toEqual([
      'furniture 3 pieces (stacked)',
      `  furniture kind ${FURN_BOOKSHELF} · 0.40×0.90 · facing 3 · at ${at(-0.2, 0)}`,
      `  furniture kind ${FURN_BOOKSHELF} · 0.40×0.90 · facing 2 · at ${at(0.2, 0)}`,
      `  furniture kind ${FURN_DESK} · 1.70×0.85 · facing 0 · at ${at(0, 0.5)}`,
    ])
    // The chunk summary counts records, not cells.
    expect(inspectCell(map, 3, 0, 3).lines.find((l) => l.startsWith('lamps '))).toMatch(/furniture 3$/)
  })
})
