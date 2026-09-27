import { describe, expect, it } from 'vitest'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import {
  MAP_FAMILY_CODES,
  MAP_FAMILY_ORDER,
  requiresVoidSafety,
  resolveMapFamily,
  worldConfigForFamily,
  worldConfigForFamilyOrOffice,
} from '../mapFamily.js'
import { WORLD_GEN_VERSION, ZONE_OFFICE } from '../constants.js'
import { fmix32 } from '../core/hash.js'
import { buildChunk } from '../pipeline.js'

const COMPLETE_PROFILES = {
  office: {
    enabled: true,
  },
  sewer: {
    enabled: false,
    zoneBands: [{ id: 3, max: 1.01 }],
    maxLoops: 2,
    rightTurnChance: 0.65,
    lampPhase: 2,
    lampChance: 0.35,
  },
  tower: {
    enabled: false,
    levels: 3,
    participants: 2,
    skybridgeLevelOffset: 1,
  },
  lattice: {
    enabled: false,
    districtChunks: 4,
    levels: 5,
    anchorsPerAxis: 8,
    cycleRate: [0.12, 0.25],
    defaultExposureM: 5,
    maxExposureM: 20,
    minimumCueCells: 8,
  },
}

function familyConfig(selected = 'office') {
  const config = structuredClone(DEFAULT_WORLD_CONFIG)
  config.mapFamily = {
    selected,
    profiles: structuredClone(COMPLETE_PROFILES),
  }
  return config
}

function expectConfigError(action, reason) {
  let error = null
  try {
    action()
  } catch (cause) {
    error = cause
  }

  expect(error, `${reason}: selected family configuration must fail closed`).toBeInstanceOf(Error)
  expect(error?.name, `${reason}: error type must identify the configuration seam`)
    .toBe('MapFamilyConfigError')
  expect(error?.reason, `${reason}: failure reason must remain machine-readable`).toBe(reason)
}

function officeByteSnapshot(data) {
  const arrays = {}
  for (const field of [
    'wallV',
    'wallH',
    'passageV',
    'passageH',
    'wallFeatureV',
    'wallFeatureH',
    'cols',
    'cellKind',
    'spaceId',
    'spaceRole',
  ]) {
    arrays[field] = Array.from(data[field])
  }

  return {
    version: data.version,
    cx: data.cx,
    cy: data.cy,
    cz: data.cz,
    zone: data.zone,
    mapFamily: data.mapFamily,
    arrays,
    lamps: data.lamps,
    furniture: data.furniture,
    repairs: data.repairs,
    exit: data.exit,
    stairUp: data.stairUp,
    stairDown: data.stairDown,
    structure: data.structure,
    structureUp: data.structureUp,
    structureDown: data.structureDown,
  }
}

describe('map-family profile selection and strict configuration', () => {
  it('[R01-S01][D01] resolves an absent selection to one frozen office profile', () => {
    const config = familyConfig()
    delete config.mapFamily.selected

    const profile = resolveMapFamily(config)

    expect(profile).toMatchObject({ family: 'office', enabled: true })
    expect(Object.isFrozen(profile)).toBe(true)
  })

  it('[R01-S02][D01] selects an explicitly enabled sewer without changing other flags', () => {
    const config = familyConfig('sewer')
    config.mapFamily.profiles.sewer.enabled = true
    const activationBefore = Object.fromEntries(
      Object.entries(config.mapFamily.profiles).map(([family, profile]) => [family, profile.enabled])
    )

    const profile = resolveMapFamily(config)

    expect(profile).toMatchObject({ family: 'sewer', enabled: true })
    expect(Object.fromEntries(
      Object.entries(config.mapFamily.profiles).map(([family, value]) => [family, value.enabled])
    )).toEqual(activationBefore)
  })

  it('[R01-S03][D01] rejects an unknown selected family with reason unknown', () => {
    const config = familyConfig('hospital')

    expectConfigError(() => resolveMapFamily(config), 'unknown')
  })

  it('[R01-S03][D01] rejects a disabled selected family with reason disabled', () => {
    const config = familyConfig('sewer')

    expectConfigError(() => resolveMapFamily(config), 'disabled')
  })

  it('[R02-S01][D01] clones a complete family config and makes it eligible', () => {

    const base = familyConfig('office')
    base.mapFamily.profiles.sewer.enabled = true

    const selected = worldConfigForFamily('sewer', base)

    expect(selected).not.toBe(base)
    expect(selected.mapFamily.profiles).not.toBe(base.mapFamily.profiles)
    expect(selected.mapFamily.selected).toBe('sewer')
    expect(selected.zoneBands).toEqual(base.mapFamily.profiles.sewer.zoneBands)
    expect(base.mapFamily.selected).toBe('office')
    expect(resolveMapFamily(selected)).toMatchObject({ family: 'sewer', enabled: true })

    selected.mapFamily.profiles.tower.enabled = true
    expect(base.mapFamily.profiles.tower.enabled).toBe(false)
  })

  it('[R02-S02][D01] rejects a selected profile missing a required constraint as incomplete', () => {
    const config = familyConfig('sewer')
    config.mapFamily.profiles.sewer.enabled = true
    delete config.mapFamily.profiles.sewer.maxLoops

    expectConfigError(() => resolveMapFamily(config), 'incomplete')
  })

  it('[R02-S03][D01] keeps office bytes unchanged after invalid family validation', () => {
    const before = officeByteSnapshot(buildChunk(12345, 0, 0, 0, DEFAULT_WORLD_CONFIG))
    const invalid = familyConfig('sewer')
    invalid.mapFamily.profiles.sewer.enabled = true
    delete invalid.mapFamily.profiles.sewer.maxLoops

    expectConfigError(() => resolveMapFamily(invalid), 'incomplete')

    const after = officeByteSnapshot(buildChunk(12345, 0, 0, 0, DEFAULT_WORLD_CONFIG))
    expect(after).toEqual(before)
  })
})

describe('family digest identity', () => {
  it('[R03-S02][D02] folds family identity into the existing zone fold while office stays code zero', () => {
    const families = ['office', 'sewer', 'tower', 'lattice', 'hotel']
    const codes = families.map((family) => MAP_FAMILY_CODES[family])

    expect(MAP_FAMILY_CODES.office).toBe(0)
    expect(MAP_FAMILY_CODES.hotel).toBe(4)
    expect(codes.every(Number.isInteger)).toBe(true)
    expect(new Set(codes).size).toBe(families.length)

    // D02 uses one fold input, `(familyCode << 8) | zone`; it does not add an
    // office-only fold that would invalidate the established office pins.
    const foldInput = (family) => (MAP_FAMILY_CODES[family] << 8) | ZONE_OFFICE
    expect(foldInput('office')).toBe(ZONE_OFFICE)
    expect(fmix32(foldInput('sewer'))).not.toBe(fmix32(foldInput('office')))
    expect(fmix32(foldInput('tower'))).not.toBe(fmix32(foldInput('sewer')))
  })
})

describe('void-safety family eligibility', () => {
  it('[R20-S01..S03][R32-S04][D08/D10] gates exactly Tower and Lattice', () => {

    expect(Object.fromEntries(
      ['office', 'sewer', 'tower', 'lattice', 'hotel']
        .map((family) => [family, requiresVoidSafety(family)])
    )).toEqual({
      office: false,
      sewer: false,
      tower: true,
      lattice: true,
      hotel: false,
    })
    expect(WORLD_GEN_VERSION).toBe(27)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles).toMatchObject({
      office: { enabled: true },
      sewer: { enabled: true },
      tower: { enabled: true },
      lattice: { enabled: true },
    })
  })
})

describe('untrusted family selection with office fallback', () => {
  it('round-trips every canonical family against the shipped default config', () => {

    for (const kind of MAP_FAMILY_ORDER) {
      const { family, config, fellBack } = worldConfigForFamilyOrOffice(kind)
      expect(family).toBe(kind)
      expect(fellBack).toBe(false)
      expect(config.mapFamily.selected).toBe(kind)
      expect(resolveMapFamily(config)).toMatchObject({ family: kind, enabled: true })
    }
  })

  it('projects the sewer profile onto the shared zone surface', () => {

    const { config } = worldConfigForFamilyOrOffice('sewer')
    const profile = DEFAULT_WORLD_CONFIG.mapFamily.profiles.sewer

    expect(config.zoneBands).toEqual(profile.zoneBands)
    for (const { id } of profile.zoneBands) {
      expect(config.lamps.phase[id]).toBe(profile.lampPhase)
      expect(config.lamps.chance[id]).toBe(profile.lampChance)
    }
  })

  it('falls back to office for unknown, empty, and missing selections', () => {

    for (const junk of ['hospital', '', undefined, null, 42]) {
      const { family, config, fellBack } = worldConfigForFamilyOrOffice(junk)
      expect(family).toBe('office')
      expect(fellBack).toBe(true)
      expect(config.mapFamily.selected).toBe('office')
    }
  })

  it('falls back to office instead of throwing for a disabled family', () => {
    const base = familyConfig('office') // COMPLETE_PROFILES: tower disabled

    const { family, config, fellBack } = worldConfigForFamilyOrOffice('tower', base)

    expect(family).toBe('office')
    expect(fellBack).toBe(true)
    expect(config.mapFamily.selected).toBe('office')
  })

  it('never mutates the base config', () => {
    const base = familyConfig('office')
    base.mapFamily.profiles.sewer.enabled = true
    const snapshot = structuredClone(base)

    worldConfigForFamilyOrOffice('sewer', base)
    worldConfigForFamilyOrOffice('hospital', base)

    expect(base).toEqual(snapshot)
  })
})
