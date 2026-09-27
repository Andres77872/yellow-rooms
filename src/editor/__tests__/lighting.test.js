import { describe, expect, it } from 'vitest'
import { EditorMap } from '../EditorMap.js'
import { lampCircuits, relightByCircuits } from '../lighting.js'

function office(seedText) {
  const map = new EditorMap()
  map.bakeProcedural({ seedText, family: 'office', radius: 2, floors: [0], center: { cx: 8, cz: -6 } })
  return map
}

const deadCount = (map) => [...map.chunks.values()].reduce((n, d) => n + d.lamps.filter((l) => !l.lit).length, 0)

describe('lighting lab', () => {
  it('groups every fixture into exactly one circuit', () => {
    const map = office('lab-a')
    for (const grain of ['circuit', 'zone']) {
      const { lamps, circuits } = lampCircuits(map, 0, { grain })
      expect(circuits.reduce((n, c) => n + c.members.length, 0)).toBe(lamps.length)
    }
  })

  it('keeps the dead-lamp budget, clusters darkness, and undoes', () => {
    let gain = 0
    for (const seed of ['lab-a', 'lab-b', 'lab-c', 'lab-d']) {
      const map = office(seed)
      const before = deadCount(map)
      const r = relightByCircuits(map, 0, { seed: 7, grain: 'zone' })
      expect(deadCount(map)).toBe(before)
      expect(r.after.dead).toBe(r.before.dead)
      gain += r.after.clustering - r.before.clustering
      map.undo()
      expect(deadCount(map)).toBe(before)
    }
    expect(gain / 4).toBeGreaterThan(0.02)
  })
})
