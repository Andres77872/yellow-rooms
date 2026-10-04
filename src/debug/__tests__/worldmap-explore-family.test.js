import { describe, expect, it } from 'vitest'
import { resolveExploreFamily } from '../WorldMapTool.js'
import { exploreConfigForFamily } from '../mapInspect.js'
import { DEFAULT_WORLD_CONFIG } from '../../world/config.js'
import { selectableFamilies } from '../../world/families/select.js'
import { LIMINAL_FAMILY_IDS } from '../../world/families/ids.js'
import { LEGACY_FAMILIES } from '../../world/families/registry.js'

// EXPLORE keeps its family label and its preview config in step: the picker
// index, the explore cache key and the integrity key all read `family`, so it
// must name the family whose chunks are actually drawn (spec §11.4, §8.4).
describe('WorldMapTool EXPLORE family resolution', () => {
  const preview = selectableFamilies(DEFAULT_WORLD_CONFIG)

  it('keeps every selectable family as itself with its own config', () => {
    for (const family of preview) {
      const r = resolveExploreFamily(family)
      expect(r.family).toBe(family)
      expect(r.config.mapFamily.selected).toBe(family)
      expect(r.config).toEqual(exploreConfigForFamily(family))
    }
  })

  it('resolves a non-selectable (disabled liminal / unknown) family to office, label included', () => {
    for (const family of [...LIMINAL_FAMILY_IDS.filter((f) => !preview.includes(f)), 'nope', undefined]) {
      const r = resolveExploreFamily(family)
      expect(r.family).toBe('office')
      expect(r.config.mapFamily.selected).toBe('office')
      expect(preview.indexOf(r.family)).toBe(0)
      expect(r.config).toEqual(exploreConfigForFamily(family))
    }
  })

  it('previews the legacy families unchanged', () => {
    for (const family of LEGACY_FAMILIES) {
      if (!preview.includes(family)) continue
      expect(resolveExploreFamily(family).family).toBe(family)
    }
  })
})
