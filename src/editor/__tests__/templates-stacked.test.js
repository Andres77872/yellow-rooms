import { describe, expect, it, vi } from 'vitest'
import { CELL } from '../../world/constants.js'
import { SPACE_ROLE_OFFICE } from '../../world/mapTypes.js'
import { FURN_BOOKSHELF } from '../../world/rooms/catalog.js'
import { EditorMap } from '../EditorMap.js'
import { applyTemplate, planTemplate } from '../templates.js'

// The room grammar seldom stacks two pieces in a cell, so the furnished
// master room of an anomaly wing gets one stacked cell by hand: createRoom
// adds a second record to the first furnished cell it made.
vi.mock('../roomBuilder.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    createRoom(map, spec) {
      const room = actual.createRoom(map, spec)
      map.mutate(() => {
        for (let gz = room.z0; gz <= room.z1; gz++) {
          for (let gx = room.x0; gx <= room.x1; gx++) {
            const found = map.furnitureAt(gx, room.cy, gz)
            if (!found) continue
            const { lx: _lx, lz: _lz, ...rec } = found.rec
            map.addFurniture(gx, room.cy, gz, { ...rec, kind: FURN_BOOKSHELF, x: rec.x + 0.1 })
            return
          }
        }
      })
      return room
    },
  }
})

describe('anomalyWing with a stacked master cell', () => {
  it('copies every record of the stacked cell into each sibling room', () => {
    const map = new EditorMap()
    map.mutate(() => {
      for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 2; cx++) map.ensureChunk(cx, 0, cz)
    })
    const plan = planTemplate(map, 'anomalyWing', { x0: 1, z0: 2, x1: 12, z1: 9 }, 0, { anomaly: 'dark', role: SPACE_ROLE_OFFICE })
    expect(plan.error).toBeUndefined()
    const rec = applyTemplate(map, plan)
    const rooms = rec.parts[0].rooms.map((id) => map.roomById(id))
    const side0 = rooms.filter((r) => r.z0 === rooms[0].z0)
    expect(side0.length).toBeGreaterThanOrEqual(3)
    const layout = (r) => {
      const out = []
      for (let gz = r.z0; gz <= r.z1; gz++) {
        for (let gx = r.x0; gx <= r.x1; gx++) {
          const list = map.furnitureListAt(gx, 0, gz)
          if (list.length) out.push(`${gx - r.x0},${gz - r.z0}:${list.map((f) => `${f.rec.kind}@${(f.rec.x % CELL).toFixed(3)}`).join('+')}`)
        }
      }
      return out.join('|')
    }
    const base = layout(side0[0])
    expect(base).toMatch(/\+/) // the master holds a stacked cell
    for (const r of side0) expect(layout(r)).toBe(base)
  })
})
