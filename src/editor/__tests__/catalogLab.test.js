import { describe, expect, it } from 'vitest'
import { EditorMap } from '../EditorMap.js'
import { auditStructure, documentStructures, structureKey } from '../structureReview.js'
import { familyCatalog, findNearestInWorld, stampRecipeIntoDocument } from '../catalogLab.js'
import { CATALOG_RECIPES } from '../../world/structures/catalog/index.js'

const FAMILIES = ['office', 'hotel', 'sewer', 'tower', 'lattice']

describe('structure catalog lab', () => {
  it('lists every family’s landmarks and procedural types with descriptions', () => {
    for (const family of FAMILIES) {
      const entries = familyCatalog(family)
      expect(entries.filter((e) => !e.landmark)).toHaveLength(CATALOG_RECIPES[family].length)
      for (const e of entries) {
        expect(e.label.length, `${family} ${e.type}`).toBeGreaterThan(2)
        expect(e.about.length, `${family} ${e.type}`).toBeGreaterThan(10)
        expect(e.reference.length).toBeGreaterThan(2)
      }
      const sizes = new Set(entries.map((e) => e.sizeClass))
      for (const s of ['small', 'medium', 'large']) expect(sizes.has(s), `${family} ${s}`).toBe(true)
    }
  })

  it('finds the nearest real instance of a type in a family world', () => {
    for (const family of ['office', 'sewer', 'tower']) {
      const entry = familyCatalog(family).find((e) => !e.landmark && e.sizeClass === 'small')
      const hit = findNearestInWorld(entry, 'lobby', { cx: 4, cz: -4, cy: 2 }, { radius: 12, dy: 10 })
      expect(hit, `${family} ${entry.type}`).not.toBeNull()
      expect(hit.structure.type).toBe(entry.type)
      expect(hit.family).toBe(family)
    }
  })

  it('stamps a recipe into a document as an audited, undoable volume', () => {
    for (const [family, type] of [['office', 'lightWell'], ['hotel', 'portmanAtrium'], ['sewer', 'cistern'], ['lattice', 'moduleHill']]) {
      const map = new EditorMap()
      map.meta.family = family
      const result = stampRecipeIntoDocument(map, family, type, { cx0: 3, cz0: -2, baseCy: 0, variant: 1 })
      expect(result.ok, `${family} ${type}: ${result.error}`).toBe(true)
      const s = result.structure
      expect(documentStructures(map).map(structureKey)).toEqual([structureKey(s)])
      const review = auditStructure(map, s)
      expect(review.issues, `${family} ${type}`).toEqual([])
      expect(review.ok).toBe(true)
      // A second stamp on the same chunks is refused, the first undoes cleanly.
      expect(stampRecipeIntoDocument(map, family, type, { cx0: 3, cz0: -2, baseCy: 0, variant: 2 }).ok).toBe(false)
      map.undo()
      expect(map.chunks.size).toBe(0)
    }
  })
})
