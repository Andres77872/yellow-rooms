import { LIMINAL_FAMILY_IDS } from './ids.js'
import { LEGACY_RECORDS } from './legacy.js'
import { FAMILY_RECORDS } from './records.js'
import {
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
} from '../mapTypes.js'

// Family registry: lookups over the family records (spec §4).
//
// Import allowlist (spec §4.4): ./ids.js, ./legacy.js, ./records.js and
// ../mapTypes.js only. This module must never import mapFamily.js, config.js
// or familyPalette.js; mapFamily.js may import it because nothing here
// imports mapFamily.js back.
//
// Every lookup is an identity for the legacy 5 (base = dressing = paletteId =
// id, empty step/packs, null audio), so a site converted to the registry
// resolves to exactly today's value for them. registry.legacy.test.js pins it.

// The 5 legacy building families in MAP_FAMILY_ORDER order. Built from the
// mapTypes constants, never from mapFamily exports.
export const LEGACY_FAMILIES = Object.freeze([
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_HOTEL,
])

const EMPTY = Object.freeze([])
const LIMINAL = new Set(LIMINAL_FAMILY_IDS)

// The record for `id`, or null for anything that is not a registered family
// (including inherited Object keys such as 'toString').
export function familyRecord(id) {
  return typeof id === 'string' && Object.hasOwn(FAMILY_RECORDS, id) ? FAMILY_RECORDS[id] : null
}

export const isLiminal = (id) => LIMINAL.has(id)
export const isLegacyFamily = (id) => typeof id === 'string' && Object.hasOwn(LEGACY_RECORDS, id)

// Table parent of a family: the legacy family whose per-family rows it
// borrows when a table has no row of its own. Unknown ids map to themselves,
// so byFamily() falls through to the fallback exactly like `T[f] ?? T.office`.
export const baseFamilyOf = (id) => familyRecord(id)?.base ?? id

// Interior dressing layer: 'office' | 'tower' | 'lattice' | 'sewer' | 'none'
// for liminal families; the id itself for the legacy 5 and unknown ids.
export const dressingOf = (id) => familyRecord(id)?.dressing ?? id

// T[f] ?? T[baseFamilyOf(f)] ?? T[fallbackKey]. For a legacy (or unknown) id
// the middle term repeats the first, so this is `T[f] ?? T[fallbackKey]`.
// Some tables fall back to a key other than office (LEAF_FINISH: 'default').
export function byFamily(table, id, fallbackKey = MAP_FAMILY_OFFICE) {
  return table[id] ?? table[baseFamilyOf(id)] ?? table[fallbackKey]
}

// Family ids whose record has a truthy `traits[trait]`, in registry order
// (MAP_FAMILY_ORDER order: legacy 5, then LIMINAL_FAMILY_IDS). Frozen and
// cached per trait. familiesWith('buildingMatrices') is the legacy 5.
const TRAIT_CACHE = new Map()
export function familiesWith(trait) {
  let ids = TRAIT_CACHE.get(trait)
  if (!ids) {
    ids = Object.freeze(Object.values(FAMILY_RECORDS).filter((r) => Boolean(r.traits?.[trait])).map((r) => r.id))
    TRAIT_CACHE.set(trait, ids)
  }
  return ids
}

// Title/HUD name. Legacy records carry id.toUpperCase(), which is what the HUD
// printed before the registry; unknown ids keep that behaviour.
export function displayNameOf(id) {
  const record = familyRecord(id)
  if (record) return record.displayName
  return typeof id === 'string' ? id.toUpperCase() : ''
}

// Title-menu note; '' for unknown ids (titleMenu.familyNote's contract).
export const noteOf = (id) => familyRecord(id)?.note ?? ''

// MAP_PALETTES key of a family. Legacy ids (and unknown ids) map to
// themselves; familyPalette resolves unknowns to office as before.
export const paletteIdOf = (id) => familyRecord(id)?.paletteId ?? id

// Prop packs the family needs loaded (lazy, spec §9.1). Legacy: none.
export const propPacksOf = (id) => familyRecord(id)?.propPacks ?? EMPTY

// The family's own {space, pa} audio rows, or null (legacy and unknown ids):
// callers then use byFamily(FAMILY_SPACES / FAMILY_PA, id).
export const familyAudio = (id) => familyRecord(id)?.audio ?? null

// Footstep class of every palette floor style (spec §9.3, the single
// definition). The four footstep recipes are carpet, concrete, tile and deck;
// the legacy palettes only use those four, which map to themselves.
export const STYLE_TO_STEP = Object.freeze({
  carpet: 'carpet',
  concrete: 'concrete',
  tile: 'tile',
  deck: 'deck',
  polished: 'tile',
  mosaic: 'tile',
  terrazzo: 'tile',
  checker: 'tile',
  parquet: 'deck',
  planks: 'deck',
  carpetPattern: 'carpet',
})

// A family's own step override wins, then the shared style table, then the
// style itself (identity for anything unmapped, as before the registry).
export const stepClassFor = (style, family) =>
  familyRecord(family)?.step?.[style] ?? STYLE_TO_STEP[style] ?? style
