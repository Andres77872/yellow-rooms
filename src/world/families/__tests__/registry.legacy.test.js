import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FAMILY_SPACES } from '../../../audio/AudioBus.js'
import { FAMILY_PA } from '../../../audio/music/MusicPlayer.js'
import { LEAF_FINISH } from '../../../render/gbufferMaterials.js'
import { familyNote } from '../../../ui/titleMenu.js'
import { DEFAULT_WORLD_CONFIG } from '../../config.js'
import { familyPalette } from '../../familyPalette.js'
import { generateChunk } from '../../generate.js'
import { MAP_FAMILY_ORDER, worldConfigForFamily } from '../../mapFamily.js'
import { digestChunk } from '../../__tests__/support/chunkDigest.js'
import { forcedFamilyConfig } from '../forced.js'
import {
  LEGACY_FAMILIES,
  STYLE_TO_STEP,
  baseFamilyOf,
  byFamily,
  displayNameOf,
  dressingOf,
  familiesWith,
  familyAudio,
  familyRecord,
  isLiminal,
  noteOf,
  paletteIdOf,
  propPacksOf,
  stepClassFor,
} from '../registry.js'
import { selectableFamilies } from '../select.js'
import {
  computeLegacySnapshot,
  LEGACY_SNAPSHOT_PATH,
} from '../../../../scripts/snapshot-legacy-families.mjs'

// Invariant I3: every registry-derived value resolves to today's value for the
// 5 legacy families. The snapshot was captured before the registry existed;
// the identities below pin each lookup against the literal it replaces.

// Ids that are not families must keep falling back exactly like the literal
// `T[f] ?? T.office` sites did.
const STRANGERS = ['nope', '', undefined, null]
const STEP_STYLES = ['carpet', 'concrete', 'tile', 'deck']

describe('legacy registry identity (I3)', () => {
  it('the legacy snapshot is unchanged', () => {
    expect(computeLegacySnapshot()).toEqual(JSON.parse(readFileSync(LEGACY_SNAPSHOT_PATH, 'utf8')))
  }, 60_000)

  it('LEGACY_FAMILIES and the building matrices are the legacy 5 in ORDER order', () => {
    expect(LEGACY_FAMILIES).toEqual(['office', 'sewer', 'tower', 'lattice', 'hotel'])
    expect(MAP_FAMILY_ORDER.slice(0, 5)).toEqual(LEGACY_FAMILIES)
    expect(familiesWith('buildingMatrices')).toEqual(LEGACY_FAMILIES)
    expect(Object.isFrozen(LEGACY_FAMILIES)).toBe(true)
    expect(Object.isFrozen(familiesWith('buildingMatrices'))).toBe(true)
  })

  it.each(LEGACY_FAMILIES)('%s: every lookup is the identity it replaces', (family) => {
    const record = familyRecord(family)
    expect(record.id).toBe(family)
    expect(record.group).toBe('buildings')
    expect(Object.hasOwn(record, 'profile')).toBe(false)
    expect(isLiminal(family)).toBe(false)
    expect(baseFamilyOf(family)).toBe(family)
    expect(dressingOf(family)).toBe(family)
    expect(paletteIdOf(family)).toBe(family)
    expect(displayNameOf(family)).toBe(family.toUpperCase())
    expect(noteOf(family)).toBe(familyNote(family))
    expect(propPacksOf(family)).toEqual([])
    expect(familyAudio(family)).toBeNull()
    expect(record.lampTint).toBeNull()
    expect(record.threats).toBeNull()
    expect(record.massFastPath).toBe(false)
    expect(record.step).toEqual({})
    expect(record.traits.buildingMatrices).toBe(true)
    expect(record.traits.structures).toBe('catalog')
  })

  it('byFamily reproduces the literal fallbacks of the audio and leaf tables', () => {
    for (const family of [...LEGACY_FAMILIES, ...STRANGERS]) {
      expect(byFamily(FAMILY_SPACES, family)).toBe(FAMILY_SPACES[family] ?? FAMILY_SPACES.office)
      expect(byFamily(FAMILY_PA, family)).toBe(FAMILY_PA[family] ?? FAMILY_PA.office)
      expect(byFamily(LEAF_FINISH, family, 'default')).toBe(LEAF_FINISH[family] ?? LEAF_FINISH.default)
    }
  })

  it('unknown ids keep the pre-registry behaviour of every lookup', () => {
    for (const id of STRANGERS) {
      expect(familyRecord(id)).toBeNull()
      expect(isLiminal(id)).toBe(false)
      expect(noteOf(id)).toBe(familyNote(id))
      expect(propPacksOf(id)).toEqual([])
      expect(familyAudio(id)).toBeNull()
    }
    expect(familyRecord('toString')).toBeNull()
    expect(displayNameOf('nope')).toBe('NOPE')
    expect(baseFamilyOf('nope')).toBe('nope')
  })

  it('the footstep table is the identity on the legacy floor styles', () => {
    for (const style of STEP_STYLES) {
      expect(STYLE_TO_STEP[style]).toBe(style)
      for (const family of LEGACY_FAMILIES) expect(stepClassFor(style, family)).toBe(style)
    }
    for (const family of LEGACY_FAMILIES) {
      const style = familyPalette(family).floor.style
      expect(stepClassFor(style, family)).toBe(style)
    }
  })

  it('selectableFamilies(DEFAULT_WORLD_CONFIG) is the legacy 5 and never throws', () => {
    expect(selectableFamilies(DEFAULT_WORLD_CONFIG)).toEqual(LEGACY_FAMILIES)
    for (const junk of [undefined, null, {}, { mapFamily: null }, { mapFamily: { profiles: 7 } }]) {
      expect(selectableFamilies(junk)).toEqual([])
    }
    const broken = structuredClone(DEFAULT_WORLD_CONFIG)
    broken.mapFamily.profiles.sewer = { enabled: 'yes' }
    delete broken.mapFamily.profiles.hotel
    expect(selectableFamilies(broken)).toEqual(['office', 'tower', 'lattice'])
  })

  it.each(LEGACY_FAMILIES)('%s: forcedFamilyConfig equals worldConfigForFamily and builds the same chunk', (family) => {
    const before = JSON.stringify(DEFAULT_WORLD_CONFIG)
    const forced = forcedFamilyConfig(family)
    expect(JSON.stringify(DEFAULT_WORLD_CONFIG)).toBe(before)
    const plain = worldConfigForFamily(family)
    expect(forced).toEqual(plain)
    expect(Object.isFrozen(forced)).toBe(true)
    expect(Object.isFrozen(forced.mapFamily.profiles[family])).toBe(true)
    expect(digestChunk(generateChunk(0x5eed, 1, 0, -1, forced)))
      .toBe(digestChunk(generateChunk(0x5eed, 1, 0, -1, plain)))
  }, 60_000)

  it('forcedFamilyConfig turns a disabled profile on without touching its base', () => {
    const base = structuredClone(DEFAULT_WORLD_CONFIG)
    base.mapFamily.profiles.hotel.enabled = false
    const forced = forcedFamilyConfig('hotel', base)
    expect(base.mapFamily.profiles.hotel.enabled).toBe(false)
    expect(forced.mapFamily.selected).toBe('hotel')
    expect(forced.mapFamily.profiles.hotel.enabled).toBe(true)
    expect(() => forcedFamilyConfig('nope')).toThrow(/unknown/)
  })
})
