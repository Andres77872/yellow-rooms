import { describe, expect, it } from 'vitest'
import { MAP_FAMILY_CODES, MAP_FAMILY_ORDER } from '../../mapFamily.js'
import { CATALOG_KINDS, isCatalogKind } from '../../structures/catalog/engine.js'
import { CATALOG_STRUCTURE_ADAPTERS } from '../../structures/contract.js'
import { FAMILY_AUDIT_ADAPTERS } from '../../familyAudit.js'
import { LIMINAL_FAMILY_IDS } from '../ids.js'

// Invariant I4 (spec §0.1, §11.2): family codes and catalog kinds are
// append-only. A code is a family's index in MAP_FAMILY_ORDER and is folded
// into every chunk digest ((code << 8) | zone); a catalog kind is folded as
// 5 + its index in CATALOG_KINDS. Re-numbering either re-pins every world.

const LEGACY = ['office', 'sewer', 'tower', 'lattice', 'hotel']
const LIMINAL = [
  'stairwell', 'nightlot', 'showroom', 'poolrooms', 'babel', 'suburb',
  'terminal', 'theater', 'playplace', 'train', 'house', 'funhouse',
]

describe('append-only family codes (I4)', () => {
  it('keeps the legacy codes 0..4', () => {
    LEGACY.forEach((family, code) => expect(MAP_FAMILY_CODES[family], family).toBe(code))
    expect(MAP_FAMILY_ORDER.slice(0, 5)).toEqual(LEGACY)
  })

  it('gives the 12 liminal families codes 5..16, in LIMINAL_FAMILY_IDS order', () => {
    expect([...LIMINAL_FAMILY_IDS]).toEqual(LIMINAL)
    LIMINAL.forEach((family, i) => expect(MAP_FAMILY_CODES[family], family).toBe(5 + i))
    expect(MAP_FAMILY_ORDER).toEqual([...LEGACY, ...LIMINAL])
    expect(Object.keys(MAP_FAMILY_CODES)).toEqual([...MAP_FAMILY_ORDER])
    expect(Object.isFrozen(MAP_FAMILY_ORDER)).toBe(true)
    expect(Object.isFrozen(MAP_FAMILY_CODES)).toBe(true)
  })
})

describe('append-only catalog kinds (I4)', () => {
  it('keeps the first 5 CATALOG_KINDS entries', () => {
    expect(Object.entries(CATALOG_KINDS).slice(0, 5)).toEqual([
      ['office', 'officeCatalog'],
      ['hotel', 'hotelCatalog'],
      ['sewer', 'sewerCatalog'],
      ['tower', 'towerCatalog'],
      ['lattice', 'latticeCatalog'],
    ])
  })

  it("appends one '<id>Catalog' kind per liminal family after lattice, in order", () => {
    expect(Object.entries(CATALOG_KINDS).slice(5)).toEqual(LIMINAL.map((id) => [id, `${id}Catalog`]))
    expect(new Set(Object.values(CATALOG_KINDS)).size).toBe(17)
    for (const id of LIMINAL) expect(isCatalogKind(`${id}Catalog`), id).toBe(true)
    expect(Object.isFrozen(CATALOG_KINDS)).toBe(true)
  })

  it('registers a runtime and an audit adapter for every catalog kind, legacy keys first', () => {
    const kinds = Object.values(CATALOG_KINDS)
    for (const [family, kind] of Object.entries(CATALOG_KINDS)) {
      expect(CATALOG_STRUCTURE_ADAPTERS[kind]?.family, kind).toBe(family)
      expect(CATALOG_STRUCTURE_ADAPTERS[kind]?.kind, kind).toBe(kind)
      expect(FAMILY_AUDIT_ADAPTERS.kinds[kind]?.family, kind).toBe(family)
    }
    // Legacy order first: office, hotel, sewer, tower, lattice, then the 12.
    expect(Object.keys(CATALOG_STRUCTURE_ADAPTERS)).toEqual(kinds)
    for (const id of LIMINAL) {
      expect(FAMILY_AUDIT_ADAPTERS.families[id]?.kinds, id).toEqual([`${id}Catalog`])
    }
    expect(Object.keys(FAMILY_AUDIT_ADAPTERS.families)).toEqual([...LEGACY, ...LIMINAL])
  })
})
