import { describe, expect, it } from 'vitest'
import { buildChunk } from '../pipeline.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { familiesWith } from '../families/registry.js'

// Office-semantics matrix: only the building families (spec §11.4). The
// liminal families have their own per-family suites.
const BUILDING_FAMILIES = familiesWith('buildingMatrices')

// Identity must survive removing all placed objects, textures, lighting,
// semantic labels and the family tag itself. Sample the same physical region
// in every family, including three floors so bridges/courts can participate.
describe('map families have different physical architecture', () => {
  it('keeps the safe spawn fabric distinct even without a landmark', () => {
    for (const seed of [42, 777, 0xad7c44d0]) {
      const walls = new Map()
      for (const family of BUILDING_FAMILIES) {
        const config = worldConfigForFamily(family)
        config.furniture.enabled = false
        const chunk = buildChunk(seed, 0, 0, 0, config)
        if (family !== 'sewer') expect(chunk.structure?.hasRoom ?? false).toBe(false)
        walls.set(family, [...chunk.wallV, ...chunk.wallH])
      }
      for (let a = 0; a < BUILDING_FAMILIES.length; a++) {
        for (let b = a + 1; b < BUILDING_FAMILIES.length; b++) {
          const first = walls.get(BUILDING_FAMILIES[a]), second = walls.get(BUILDING_FAMILIES[b])
          const changed = first.filter((v, i) => v !== second[i]).length
          expect(changed / first.length,
            `spawn seed ${seed}: ${BUILDING_FAMILIES[a]} / ${BUILDING_FAMILIES[b]}`)
            .toBeGreaterThan(0.02)
        }
      }
    }
  })

  it('distinguishes every pair using only walls and structural columns', () => {
    const geometry = new Map()
    for (const family of BUILDING_FAMILIES) {
      const config = worldConfigForFamily(family)
      config.furniture.enabled = false
      const bytes = []
      for (const seed of [42, 777]) {
        for (let cy = -1; cy <= 1; cy++) {
          for (let cz = -2; cz <= 2; cz++) {
            for (let cx = -2; cx <= 2; cx++) {
              const chunk = buildChunk(seed, cx, cy, cz, config)
              expect(chunk.furniture).toHaveLength(0)
              bytes.push(...chunk.wallV, ...chunk.wallH, ...chunk.cols)
            }
          }
        }
      }
      geometry.set(family, bytes)
    }
    for (let a = 0; a < BUILDING_FAMILIES.length; a++) {
      for (let b = a + 1; b < BUILDING_FAMILIES.length; b++) {
        const first = geometry.get(BUILDING_FAMILIES[a])
        const second = geometry.get(BUILDING_FAMILIES[b])
        let different = 0
        for (let i = 0; i < first.length; i++) if (first[i] !== second[i]) different++
        expect(different / first.length, `${BUILDING_FAMILIES[a]} / ${BUILDING_FAMILIES[b]}`)
          .toBeGreaterThan(0.01)
      }
    }
  })
})
