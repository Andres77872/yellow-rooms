import { describe, expect, it } from 'vitest'
import { DEFAULT_WORLD_CONFIG, LIMINAL_RELEASE_EVIDENCE } from '../../config.js'
import { LIMINAL_FAMILY_IDS } from '../ids.js'
import { familyGenerator } from '../generators.js'
import { familyPlanner } from '../planners.js'
import { hookOf } from '../hooks.js'
import { familyRecord } from '../registry.js'

// Release readiness (spec §11.2, §13.3): dormant through Phases F/P/B/I.
// It turns on under RELEASE=1, or as soon as any liminal profile ships
// enabled, and then requires every family to be real (no stub generator,
// planner or hooks), pinned (goldens filled), evidenced
// (LIMINAL_RELEASE_EVIDENCE row) and voiced (record audio).

const GOLDENS = import.meta.glob('../*/__tests__/*.goldens.js', { eager: true, import: 'default' })

const anyEnabled = LIMINAL_FAMILY_IDS.some((id) => DEFAULT_WORLD_CONFIG.mapFamily.profiles[id]?.enabled === true)
export const RELEASE_ACTIVE = process.env.RELEASE === '1' || anyEnabled

describe.skipIf(!RELEASE_ACTIVE)('release readiness', () => {
  for (const id of LIMINAL_FAMILY_IDS) {
    it(`${id}: real generator, planner and hooks; goldens, evidence, audio; enabled`, () => {
      const gen = familyGenerator(id)
      expect(gen.ready).toBe(true)
      expect(gen.stub).toBe(false)
      expect(familyPlanner(id).stub ?? false).toBe(false)
      expect(hookOf(id).stub ?? false).toBe(false)
      const goldens = GOLDENS[`../${id}/__tests__/${id}.goldens.js`]
      expect(goldens?.coords?.length).toBeGreaterThan(0)
      expect(goldens.digests).toBeTruthy()
      for (const entry of goldens.coords) {
        const [seed, cx, cy, cz] = Array.isArray(entry) ? entry : [entry.seed, entry.cx, entry.cy, entry.cz]
        const key = (!Array.isArray(entry) && entry.key) || `${seed},${cx},${cy},${cz}`
        expect(goldens.digests[key], `golden ${key}`).toMatch(/^[0-9a-f]{8}$/)
      }
      expect(LIMINAL_RELEASE_EVIDENCE[id], 'evidence row').toBeTruthy()
      const audio = familyRecord(id).audio
      expect(audio?.space).toBeTruthy()
      expect(audio?.pa).toBeTruthy()
      expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles[id].enabled).toBe(true)
    })
  }
})

describe('release readiness gate', () => {
  it('finds every family\'s goldens manifest', () => {
    expect(Object.keys(GOLDENS).sort()).toEqual(LIMINAL_FAMILY_IDS.map((id) => `../${id}/__tests__/${id}.goldens.js`).sort())
  })
})
