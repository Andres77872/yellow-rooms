import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FAMILY_SPACES } from '../../../audio/AudioBus.js'
import { FAMILY_PA } from '../../../audio/music/MusicPlayer.js'
import { DEFAULT_WORLD_CONFIG } from '../../config.js'
import { MAP_PALETTES } from '../../familyPalette.js'
import {
  MAP_FAMILY_CODES,
  MAP_FAMILY_ORDER,
  requiresVoidSafety,
  resolveMapFamily,
} from '../../mapFamily.js'
import { PROP_MODEL_FILES } from '../../props/index.js'
import { forcedFamilyConfig } from '../forced.js'
import * as ids from '../ids.js'
import { LIMINAL_FAMILY_IDS } from '../ids.js'
import { FAMILY_RECORDS, LIMINAL_PROFILES, liminalProfiles } from '../records.js'
import {
  LEGACY_FAMILIES,
  byFamily,
  displayNameOf,
  familiesWith,
  familyAudio,
  familyRecord,
  isLiminal,
  noteOf,
  stepClassFor,
} from '../registry.js'

// Spec §5.2: the lethal gates (contract.js, ChunkManager.js, Controller.js,
// audit.js, familyAudit.js, VOID_SAFETY_FAMILIES) stay literal TOWER||LATTICE
// comparisons on purpose. This test is what keeps the registry and those
// literals from drifting apart, and keeps every liminal family non-lethal (I6).
// It also pins the record schema (§4.1) and the §4.3 values.

const ALL = Object.keys(FAMILY_RECORDS)
const STEP_CLASSES = ['carpet', 'concrete', 'tile', 'deck']
const BASES = ['tower', 'hotel', 'lattice', 'office']
const DRESSINGS = ['office', 'tower', 'lattice', 'sewer', 'none']
const STRUCTURES = ['stairs', 'catalog', 'stairs+catalog']
const ONE_SHOTS = [null, 'drip', 'creak', 'wind']
const RECORD_KEYS = [
  'audio', 'base', 'displayName', 'dressing', 'group', 'id', 'lampTint', 'massFastPath',
  'note', 'paletteId', 'profile', 'propPacks', 'step', 'threats', 'traits',
]
const TRAIT_KEYS = ['buildingMatrices', 'floorPockets', 'lethal', 'multiStorey', 'outdoor', 'structures']
const liminalOrderLanded = MAP_FAMILY_ORDER.length > LEGACY_FAMILIES.length

// §4.3 table: [code, id, base, dressing, displayName, paletteId, propPacks, structures, note]
// The note column is the §4.3 'Title notes' table, verbatim.
const TABLE = [
  [5, 'stairwell', 'tower', 'office', 'STAIRWELL', 'stairwellConcrete', ['stairwell', 'street', 'showroom'], 'stairs',
    'endless switchbacks · landing fragments · lying floor numbers'],
  [6, 'nightlot', 'lattice', 'none', 'NIGHT LOT', 'nightLot', ['street'], 'stairs',
    'lamp islands · dead circuits · a lit kiosk somewhere'],
  [7, 'showroom', 'tower', 'office', 'SHOWROOM', 'showroomWhite', ['showroom', 'street'], 'stairs',
    'furnished vignettes · a way out that loops · checkout below'],
  [8, 'poolrooms', 'tower', 'office', 'POOLROOMS', 'poolTile', ['pool'], 'stairs+catalog',
    'tiled chambers · drained basins · a glass gallery'],
  [9, 'babel', 'hotel', 'office', 'LIBRARY', 'babelLibrary', ['babel'], 'stairs+catalog',
    'hexagonal reading rooms · shafts of shelves · one crimson room'],
  [10, 'suburb', 'hotel', 'office', 'SUBURB', 'suburbNight', ['suburb', 'street'], 'stairs',
    'sleeping streets · identical houses · one light on'],
  [11, 'terminal', 'tower', 'office', 'TERMINAL', 'terminalTerrazzo', ['terminal'], 'stairs+catalog',
    'an endless concourse · dead piers · arrivals below'],
  [12, 'theater', 'hotel', 'office', 'THEATER', 'theaterDamask', ['theater'], 'stairs+catalog',
    'empty stalls · backstage that never ends · the trap room'],
  [13, 'playplace', 'office', 'office', 'PLAYPLACE', 'playCarpet', ['playplace', 'street'], 'catalog',
    'soft play · tube grids · nobody collecting'],
  [14, 'train', 'tower', 'office', 'TRAIN', 'metroTile', ['train'], 'stairs',
    'stopped cars · platforms · an unlisted station'],
  [15, 'house', 'hotel', 'office', 'HOUSE', 'houseFaded', ['house'], 'stairs+catalog',
    'rooms behind rooms · the same hallway · a great hall'],
  [16, 'funhouse', 'tower', 'office', 'FUNHOUSE', 'funhouseNeon', ['funhouse', 'playplace'], 'stairs',
    'lying mirrors (painted) · the ride · the unload walk'],
]

function expectDeepFrozen(value, path) {
  if (value === null || typeof value !== 'object') return
  expect(Object.isFrozen(value), path).toBe(true)
  for (const [k, v] of Object.entries(value)) expectDeepFrozen(v, `${path}.${k}`)
}

const sortedKeys = (o) => Object.keys(o).sort()

describe('registry drift guards (§5.2, I6)', () => {
  it('only tower and lattice are lethal', () => {
    expect(familiesWith('lethal')).toEqual(['tower', 'lattice'])
  })

  it('requiresVoidSafety agrees with traits.lethal for every family', () => {
    expect(ALL).toHaveLength(17)
    for (const id of ALL) expect(requiresVoidSafety(id), id).toBe(FAMILY_RECORDS[id].traits.lethal)
  })

  it('no liminal family is lethal or a building matrix', () => {
    for (const id of LIMINAL_FAMILY_IDS) {
      expect(familyRecord(id).traits.lethal, id).toBe(false)
      expect(familyRecord(id).traits.buildingMatrices, id).toBe(false)
    }
  })
})

describe('family ids and registration order (I4)', () => {
  it('ids.js lists the 12 liminal ids in spec order, frozen, with matching constants', () => {
    expect(LIMINAL_FAMILY_IDS).toEqual(TABLE.map((row) => row[1]))
    expect(Object.isFrozen(LIMINAL_FAMILY_IDS)).toBe(true)
    for (const id of LIMINAL_FAMILY_IDS) expect(ids[`MAP_FAMILY_${id.toUpperCase()}`]).toBe(id)
  })

  it('records are keyed by id in legacy-then-liminal order', () => {
    expect(ALL).toEqual([...LEGACY_FAMILIES, ...LIMINAL_FAMILY_IDS])
    for (const id of ALL) expect(FAMILY_RECORDS[id].id).toBe(id)
    expect(familiesWith('multiStorey')).toEqual(ALL)
    expect(familiesWith('outdoor')).toEqual(['nightlot', 'suburb'])
  })

  it('MAP_FAMILY_ORDER is a prefix of the registry order and every ordered family has a record', () => {
    expect(ALL.slice(0, MAP_FAMILY_ORDER.length)).toEqual([...MAP_FAMILY_ORDER])
    for (const id of MAP_FAMILY_ORDER) expect(familyRecord(id), id).not.toBeNull()
  })

  it.runIf(liminalOrderLanded)('liminal codes are 5..16 once ORDER is appended', () => {
    for (const [code, id] of TABLE) expect(MAP_FAMILY_CODES[id], id).toBe(code)
  })
})

describe('liminal records (§4.1 schema, §4.3 values)', () => {
  it.each(TABLE)('%i %s', (code, id, base, dressing, displayName, paletteId, packs, structures, note) => {
    const r = familyRecord(id)
    expect(sortedKeys(r)).toEqual(RECORD_KEYS)
    expect(sortedKeys(r.traits)).toEqual(TRAIT_KEYS)
    expectDeepFrozen(r, id)
    expect(isLiminal(id)).toBe(true)
    expect(r.group).toBe('liminal')
    expect(r.base).toBe(base)
    expect(BASES).toContain(r.base)
    expect(r.dressing).toBe(dressing)
    expect(DRESSINGS).toContain(r.dressing)
    expect(r.displayName).toBe(displayName)
    expect(displayNameOf(id)).toBe(displayName)
    expect(r.displayName.length).toBeLessThanOrEqual(12)
    expect(r.note).toBe(note)
    expect(noteOf(id)).toBe(note)
    expect(r.paletteId).toBe(paletteId)
    expect(MAP_PALETTES[r.paletteId], r.paletteId).toBeTruthy()
    expect(r.propPacks).toEqual(packs)
    for (const pack of r.propPacks) expect(Object.hasOwn(PROP_MODEL_FILES, pack), pack).toBe(true)
    expect(r.traits.structures).toBe(structures)
    expect(STRUCTURES).toContain(r.traits.structures)
    expect(r.traits.outdoor).toBe(id === 'nightlot' || id === 'suburb')
    expect(typeof r.traits.multiStorey).toBe('boolean')
    expect(typeof r.traits.floorPockets).toBe('boolean')
    expect(r.massFastPath).toBe(true)
    expect(r.threats).toBeNull()
    expect(r.lampTint === null || (Number.isInteger(r.lampTint) && r.lampTint >= 0 && r.lampTint <= 0xffffff)).toBe(true)
    expect(sortedKeys(r.profile)).toEqual(['enabled'])
    expect(typeof r.profile.enabled).toBe('boolean')
  })

  it('every liminal floor style maps to one of the 4 footstep classes', () => {
    for (const id of LIMINAL_FAMILY_IDS) {
      const style = MAP_PALETTES[familyRecord(id).paletteId].floor.style
      expect(STEP_CLASSES, `${id} ${style}`).toContain(stepClassFor(style, id))
    }
    expect(stepClassFor('polished', 'stairwell')).toBe('concrete')
    expect(stepClassFor('polished', 'showroom')).toBe('tile')
  })

  it('audio rows have the FAMILY_SPACES / FAMILY_PA shape and only existing one-shots', () => {
    for (const id of LIMINAL_FAMILY_IDS) {
      const audio = familyAudio(id)
      const base = baseRows(id)
      expect(sortedKeys(audio)).toEqual(['pa', 'space'])
      const space = audio.space
      expect(ONE_SHOTS, id).toContain(space.oneShot)
      expect(sortedKeys(space).filter((k) => k !== 'interval'), id)
        .toEqual(sortedKeys(base.space).filter((k) => k !== 'interval'))
      if (space.oneShot) expect(space.interval, id).toHaveLength(2)
      expect(sortedKeys(space.bed), id).toEqual(sortedKeys(base.space.bed))
      expect(sortedKeys(space.pad), id).toEqual(sortedKeys(base.space.pad))
      expect(space.pad.freqs, id).toHaveLength(base.space.pad.freqs.length)
      expect(sortedKeys(audio.pa), id).toEqual(sortedKeys(base.pa))
    }
  })

  it('LIMINAL_PROFILES mirrors the record profiles', () => {
    const expected = Object.fromEntries(LIMINAL_FAMILY_IDS.map((id) => [id, { enabled: familyRecord(id).profile.enabled }]))
    expect(LIMINAL_PROFILES).toEqual(expected)
    expect(liminalProfiles()).toEqual(expected)
    expect(Object.isFrozen(liminalProfiles().stairwell)).toBe(false)
  })

  it.skipIf(process.env.RELEASE === '1')('the liminal families stay disabled until release (I5)', () => {
    for (const id of LIMINAL_FAMILY_IDS) {
      expect(familyRecord(id).profile.enabled, id).toBe(false)
      expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles[id]?.enabled ?? false, id).toBe(false)
    }
  })

  it('byFamily resolves a liminal id through its base family', () => {
    for (const id of LIMINAL_FAMILY_IDS) {
      const base = familyRecord(id).base
      expect(byFamily(FAMILY_SPACES, id)).toBe(FAMILY_SPACES[base])
      expect(byFamily(FAMILY_PA, id)).toBe(FAMILY_PA[base])
    }
    const table = { office: 'o', hotel: 'h', babel: 'b' }
    expect(byFamily(table, 'babel')).toBe('b')
    expect(byFamily(table, 'house')).toBe('h')
    expect(byFamily(table, 'stairwell')).toBe('o')
    expect(byFamily({ default: 'd' }, 'stairwell', 'default')).toBe('d')
  })

  it.runIf(liminalOrderLanded)('forcedFamilyConfig resolves every liminal family', () => {
    for (const id of LIMINAL_FAMILY_IDS) {
      const config = forcedFamilyConfig(id)
      expect(Object.isFrozen(config)).toBe(true)
      expect(config.mapFamily.selected).toBe(id)
      expect(resolveMapFamily(config).family).toBe(id)
    }
  })
})

function baseRows(id) {
  const base = familyRecord(id).base
  return { space: FAMILY_SPACES[base], pa: FAMILY_PA[base] }
}

describe('liminal lampTint follows the editor kind (§4.3)', () => {
  // §4.3: lampTint is the kind's dominant tint constant, or null. The kind
  // source is read as text (never imported), so this test adds no runtime
  // dependency on src/editor. A kind with no 0xRRGGBB constant must be untinted.
  // A family that moved its kind body into families/<id>/tile.js (§3.3, §10)
  // keeps its constants there, so both files count (P-fix: the editor
  // wrapper no longer needs to restate the literal). A family that keeps its
  // kind program in families/<id>/kind.js (terminal, train) counts it too.
  const sourceOf = (rel) => {
    const url = new URL(rel, import.meta.url)
    return existsSync(url) ? readFileSync(url, 'utf8') : ''
  }
  it.each(LIMINAL_FAMILY_IDS)('%s', (id) => {
    const src = [`../../../editor/kinds/${id}.js`, `../${id}/tile.js`, `../${id}/kind.js`].map(sourceOf).join('\n')
    const constants = [...src.matchAll(/0x([0-9a-fA-F]{6})\b/g)].map((m) => Number.parseInt(m[1], 16))
    const { lampTint } = familyRecord(id)
    if (constants.length === 0) expect(lampTint, `${id} kind has no tint constant`).toBeNull()
    if (lampTint !== null) expect(constants, `${id} lampTint must be a constant of its kind`).toContain(lampTint)
  })
})
