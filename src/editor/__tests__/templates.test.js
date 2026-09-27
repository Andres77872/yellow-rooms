import { describe, expect, it } from 'vitest'
import { auditLayeredPatch } from '../../world/audit.js'
import { CELL } from '../../world/constants.js'
import { COLUMN_STANDARD, SPACE_ROLE_OFFICE } from '../../world/mapTypes.js'
import { EditorMap } from '../EditorMap.js'
import { decodeMapFile, encodeMapFile } from '../format/yrmap.js'
import { applyTemplate, planTemplate, removeAuthored, TEMPLATE_DEFS } from '../templates.js'
import { walkGraph, graphComponents } from '../simulate.js'

// Empty documents materialize open fabric, so every template can be judged in
// isolation: structural contracts via the layered audit, walkability per
// storey (and across storeys where the template owns stairs).
function auditAll(map) {
  const b = map.bounds()
  const audit = auditLayeredPatch(
    (cx, cy, cz) => map.chunkAt(cx, cy, cz),
    b.x0, b.y0, b.z0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1
  )
  const bad = Object.entries(audit.details).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${JSON.stringify(v.slice(0, 2))}`)
  const floors = []
  for (let cy = b.y0; cy <= b.y1; cy++) {
    const comps = graphComponents(walkGraph(map, { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0: cy, y1: cy }, { vertical: false }))
    floors.push(comps.length)
  }
  const volume = graphComponents(walkGraph(map, { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0: b.y0, y1: b.y1 })).length
  return { audit, bad, floors, volume }
}

function prime(map, cy0, cy1) {
  // Open fabric around the work area so edges of the templates have floor.
  map.mutate(() => {
    for (let cy = cy0; cy <= cy1; cy++) for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 2; cx++) map.ensureChunk(cx, cy, cz)
  })
}

const RECTS = {
  atrium: { x0: 9, z0: 3, x1: 19, z1: 9 },
  bridgedAtrium: { x0: 9, z0: 3, x1: 19, z1: 9 },
  splitLevel: { x0: 3, z0: 2, x1: 8, z1: 5 },
  twinVoid: { x0: 22, z0: 3, x1: 33, z1: 9 },
  anomalyWing: { x0: 1, z0: 2, x1: 12, z1: 9 },
  compression: { x0: 15, z0: 2, x1: 32, z1: 8 },
}

describe('structure templates', () => {
  it('covers every declared template', () => {
    expect(TEMPLATE_DEFS.map((t) => t.id).sort()).toEqual(
      ['anomalyWing', 'atrium', 'bridgedAtrium', 'compression', 'splitLevel', 'stairwell', 'twinVoid']
    )
  })

  for (const id of ['atrium', 'bridgedAtrium', 'splitLevel', 'twinVoid', 'compression']) {
    it(`${id}: applies cleanly and keeps every storey walkable`, () => {
      const map = new EditorMap()
      prime(map, 0, 3)
      const plan = planTemplate(map, id, RECTS[id], 0, { levels: 3 })
      expect(plan.error).toBeUndefined()
      const rec = applyTemplate(map, plan)
      expect(map.authored).toHaveLength(1)
      expect(rec.template).toBe(id)
      const { bad, floors } = auditAll(map)
      expect(bad).toEqual([])
      expect(floors.every((n) => n === 1)).toBe(true)
    })
  }

  it('splitLevel joins its two storeys through its own stair', () => {
    const map = new EditorMap()
    prime(map, 0, 1)
    applyTemplate(map, planTemplate(map, 'splitLevel', RECTS.splitLevel, 0))
    const { volume, audit } = auditAll(map)
    expect(audit.canonicalLinks).toBe(1)
    expect(volume).toBe(1)
  })

  it('stairwell: one walk through every floor, same door on each', () => {
    const map = new EditorMap()
    prime(map, 0, 5)
    const plan = planTemplate(map, 'stairwell', { gx: 3, gz: 4 }, 0, { levels: 6, enclosed: true })
    expect(plan.error).toBeUndefined()
    applyTemplate(map, plan)
    const { bad, volume, audit } = auditAll(map)
    expect(bad).toEqual([])
    expect(audit.canonicalLinks).toBe(5)
    expect(volume).toBe(1)
  })

  it('anomalyWing: repeated rooms are identical except the anomaly', () => {
    for (const anomaly of ['dark', 'empty', 'pillar', 'extraDoor']) {
      const map = new EditorMap()
      prime(map, 0, 0)
      const plan = planTemplate(map, 'anomalyWing', RECTS.anomalyWing, 0, { anomaly, role: SPACE_ROLE_OFFICE })
      expect(plan.error).toBeUndefined()
      const rec = applyTemplate(map, plan)
      const part = rec.parts[0]
      const rooms = part.rooms.map((id) => map.roomById(id))
      const side0 = rooms.filter((r) => r.z0 === rooms[0].z0)
      expect(side0.length).toBeGreaterThanOrEqual(3)
      const layout = (r) => {
        const out = []
        for (let gz = r.z0; gz <= r.z1; gz++) {
          for (let gx = r.x0; gx <= r.x1; gx++) {
            const f = map.furnitureAt(gx, 0, gz)
            if (f) out.push(`${gx - r.x0},${gz - r.z0}:${f.rec.kind}:${(f.rec.x % CELL).toFixed(3)}`)
          }
        }
        return out.join('|')
      }
      const base = layout(side0[0])
      const same = side0.filter((r, i) => i !== part.anomalyIndex).every((r) => layout(r) === base)
      expect(same).toBe(true)
      const odd = side0[part.anomalyIndex]
      const cx = Math.floor((odd.x0 + odd.x1) / 2)
      const cz = Math.floor((odd.z0 + odd.z1) / 2)
      if (anomaly === 'dark') expect(map.lampAt(cx, 0, cz).rec.lit).toBe(false)
      if (anomaly === 'empty') expect(layout(odd)).toBe('')
      if (anomaly === 'pillar') expect(map.cellAt(cx, 0, cz).col).toBe(COLUMN_STANDARD)
      const { bad, floors } = auditAll(map)
      expect(bad).toEqual([])
      expect(floors).toEqual([1])
    }
  })

  it('refuses overlapping multilevel structures with a reason', () => {
    const map = new EditorMap()
    prime(map, 0, 3)
    applyTemplate(map, planTemplate(map, 'atrium', RECTS.atrium, 0))
    const again = planTemplate(map, 'atrium', { x0: 10, z0: 4, x1: 16, z1: 8 }, 1)
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/multilevel structure/)
  })

  it('undoes, round-trips through .yrmap and removes cleanly', async () => {
    const map = new EditorMap()
    prime(map, 0, 3)
    const rec = applyTemplate(map, planTemplate(map, 'bridgedAtrium', RECTS.bridgedAtrium, 0))
    expect(map.chunkAt(0, 1, 0).structureDown?.id).toBe(rec.parts[0].descriptor.id)
    map.undo()
    expect(map.authored).toEqual([])
    expect(map.chunkAt(0, 1, 0).structureDown).toBeNull()
    map.redo()
    expect(map.authored).toHaveLength(1)

    const loaded = await decodeMapFile(await encodeMapFile(map, { compress: false }))
    expect(loaded.authored).toEqual(map.authored)
    expect(auditAll(loaded).bad).toEqual([])

    removeAuthored(map, map.authored[0])
    expect(map.authored).toEqual([])
    expect(map.chunkAt(0, 1, 0).structureDown).toBeNull()
    const { bad, floors } = auditAll(map)
    expect(bad).toEqual([])
    expect(floors.every((n) => n === 1)).toBe(true)
  })
})
