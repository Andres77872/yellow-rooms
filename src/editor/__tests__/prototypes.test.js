import { describe, expect, it } from 'vitest'
import { auditLayeredPatch } from '../../world/audit.js'
import { EditorMap } from '../EditorMap.js'
import { serializeMap } from '../format/yrmap.js'
import { PROTOTYPE_KINDS, generatePrototype } from '../prototypes.js'
import { graphComponents, liminalReport, walkGraph } from '../simulate.js'

function judge(map) {
  const b = map.bounds()
  const box = { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0: b.y0, y1: b.y1 }
  const audit = auditLayeredPatch(
    (cx, cy, cz) => map.chunkAt(cx, cy, cz),
    b.x0, b.y0, b.z0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1
  )
  const bad = Object.entries(audit.details).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${JSON.stringify(v.slice(0, 2))}`)
  const floors = []
  for (let cy = b.y0; cy <= b.y1; cy++) {
    const comps = graphComponents(walkGraph(map, { ...box, y0: cy, y1: cy }, { vertical: false }))
    floors.push(comps.map((c) => `${c.size}@${c.sample.gx},${c.sample.gz}`))
  }
  const volume = graphComponents(walkGraph(map, box)).length
  return { audit, bad, floors, volume, box }
}

describe('prototype map kinds', () => {
  for (const kind of PROTOTYPE_KINDS) {
    it(`${kind.id}: audits clean, every floor and the whole volume connected`, () => {
      const map = new EditorMap()
      const res = generatePrototype(map, kind.id, { seed: 'proto' })
      expect(res.error).toBeUndefined()
      expect(res.ok).toBe(true)
      const { bad, floors, volume, audit } = judge(map)
      expect(bad).toEqual([])
      expect(floors.every((f) => f.length === 1)).toBe(true)
      expect(floors).toHaveLength(kind.floors)
      expect(volume).toBe(1)
      if (kind.floors > 1) expect(audit.canonicalLinks).toBeGreaterThanOrEqual(kind.floors - 1)
    })

    it(`${kind.id}: is deterministic per seed`, () => {
      const a = new EditorMap()
      const b = new EditorMap()
      generatePrototype(a, kind.id, { seed: 'same' })
      generatePrototype(b, kind.id, { seed: 'same' })
      expect(Buffer.from(serializeMap(a)).equals(Buffer.from(serializeMap(b)))).toBe(true)
    })
  }

  it('underpass mutates only later bands and keeps the baseline identical', () => {
    const seen = new Set()
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const map = new EditorMap()
      const res = generatePrototype(map, 'underpass', { seed })
      for (const note of res.notes) {
        const band = Number(note.match(/band (\d+)/)[1])
        expect(band).toBeGreaterThanOrEqual(4)
        seen.add(note.split(': ')[1])
      }
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  it('reports liminal metrics for a prototype', () => {
    const map = new EditorMap()
    generatePrototype(map, 'underpass', { seed: 'proto' })
    const { box } = judge(map)
    const [f] = liminalReport(map, box, { samples: 8, rays: 48 }).floors
    expect(f.walkable).toBeGreaterThan(200)
    expect(f.deadEndSpaces).toBeGreaterThan(10) // closets behind every door
    expect(f.sightP90).toBeGreaterThan(8) // long segment sightlines
  })
})
