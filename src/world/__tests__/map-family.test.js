import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORLD_CONFIG,
  LATTICE_RELEASE_EVIDENCE,
  SEWER_RELEASE_EVIDENCE,
  TOWER_RELEASE_EVIDENCE,
} from '../config.js'
import { WORLD_GEN_VERSION, ZONE_OFFICE } from '../constants.js'
import { fmix32 } from '../core/hash.js'
import { buildChunk } from '../pipeline.js'

const MAP_FAMILY_MODULE = '../mapFamily.js'
const FAMILY_AUDIT_MODULE = '../familyAudit.js'

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
    districtChunks: 3,
    levels: 3,
    anchorsPerAxis: 5,
    cycleRate: [0.08, 0.15],
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

async function plannedExport(modulePath, exportName, redReason, expectedType = 'function') {
  let plannedModule
  try {
    plannedModule = await import(/* @vite-ignore */ modulePath)
  } catch (cause) {
    throw new Error(
      `${redReason}: planned module ${modulePath} is not implemented`,
      { cause }
    )
  }

  expect(
    plannedModule[exportName],
    `${redReason}: planned export ${exportName} is not implemented`
  ).toBeTypeOf(expectedType)
  return plannedModule[exportName]
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

function completeVoidSafety(family, profileIdentity) {
  const half = {
    id: 0x5a17,
    family,
    lowerCy: 2,
    cells: [{ lx: 5, lz: 8, deathYmm: -7200 }],
  }
  const baseline = {
    version: WORLD_GEN_VERSION,
    seedText: 'activation-safety',
    level: 7,
    mapFamily: family,
    profileIdentity,
    initialDigest: `${family}:activation-safety:v${WORLD_GEN_VERSION}`,
  }
  return {
    hardVoidDeath: {
      ok: true,
      deathReason: 'void',
      callbackCount: 1,
      plane: { id: half.id, family, deathYmm: half.cells[0].deathYmm },
      halves: {
        lethalVoidUp: structuredClone(half),
        lethalVoidDown: structuredClone(half),
      },
      ownership: { id: half.id, family, lowerCy: half.lowerCy },
    },
    deterministicReset: {
      ok: true,
      before: structuredClone(baseline),
      after: structuredClone(baseline),
    },
  }
}

function activationEvidence({
  family = 'tower',
  byteImpact = 'first-emission',
  affectsMaximumHeight = true,
  previousVersion = WORLD_GEN_VERSION,
  candidateVersion = WORLD_GEN_VERSION + 1,
  previousDigest = 'office-byte-stream',
  candidateDigest = `${family}-byte-stream`,
} = {}) {
  const profileIdentity = `${family}-core`
  const evidence = {
    family,
    enabled: true,
    byteImpact,
    affectsMaximumHeight,
    previous: {
      version: previousVersion,
      digest: previousDigest,
    },
    candidate: {
      version: candidateVersion,
      digest: candidateDigest,
    },
    pins: {
      global: {
        version: candidateVersion,
        digest: `global-${candidateDigest}`,
      },
      family: {
        family,
        version: candidateVersion,
        digest: candidateDigest,
      },
      maximumHeight: affectsMaximumHeight
        ? {
            version: candidateVersion,
            digest: `maximum-height-${candidateDigest}`,
          }
        : null,
    },
    corpus: {
      version: candidateVersion,
      profileIdentity,
      seedDerivation: 'hashStr(seedText#level)',
    },
  }
  if (family === 'tower' || family === 'lattice') {
    evidence.voidSafety = completeVoidSafety(family, profileIdentity)
  }
  return evidence
}

function releaseActivationEvidence(release) {
  const evidence = {
    family: release.family,
    enabled: true,
    byteImpact: release.byteImpact,
    affectsMaximumHeight: release.affectsMaximumHeight,
    previous: {
      version: release.previousVersion,
      digest: release.previousFamilyCorpusDigest,
    },
    candidate: {
      version: release.generatorVersion,
      digest: release.familyCorpusDigest,
    },
    pins: {
      global: {
        version: release.generatorVersion,
        digest: release.globalGoldenDigest,
      },
      family: {
        family: release.family,
        version: release.generatorVersion,
        digest: release.familyCorpusDigest,
      },
      maximumHeight: release.affectsMaximumHeight
        ? {
            version: release.generatorVersion,
            digest: release.maximumHeightGoldenDigest,
          }
        : null,
    },
    corpus: {
      version: release.generatorVersion,
      profileIdentity: release.profileIdentity,
      seedDerivation: release.seedDerivation,
    },
  }
  if (release.family === 'tower' || release.family === 'lattice') {
    evidence.voidSafety = completeVoidSafety(release.family, release.profileIdentity)
  }
  return evidence
}

function sewerReleaseActivationEvidence() {
  return releaseActivationEvidence(SEWER_RELEASE_EVIDENCE)
}

function towerReleaseActivationEvidence() {
  return releaseActivationEvidence(TOWER_RELEASE_EVIDENCE)
}

function latticeReleaseActivationEvidence() {
  return releaseActivationEvidence(LATTICE_RELEASE_EVIDENCE)
}

function expectActivationRejection(result, reason) {
  expect(result?.ok, `${reason}: activation must fail closed`).toBe(false)
  expect(result?.reasons, `${reason}: activation must expose distinct reasons`).toContain(reason)
}

function enabledFamilyFlags(config) {
  return Object.fromEntries(
    Object.entries(config.mapFamily.profiles)
      .map(([family, profile]) => [family, profile.enabled])
  )
}

describe('map-family profile selection and strict configuration', () => {
  it('[R01-S01][D01] resolves an absent selection to one frozen office profile', async () => {
    const resolveMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'resolveMapFamily',
      'default-office'
    )
    const config = familyConfig()
    delete config.mapFamily.selected

    const profile = resolveMapFamily(config)

    expect(profile).toMatchObject({ family: 'office', enabled: true })
    expect(Object.isFrozen(profile)).toBe(true)
  })

  it('[R01-S02][D01] selects an explicitly enabled sewer without changing other flags', async () => {
    const resolveMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'resolveMapFamily',
      'enabled-family'
    )
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

  it('[R01-S03][D01] rejects an unknown selected family with reason unknown', async () => {
    const resolveMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'resolveMapFamily',
      'unknown'
    )
    const config = familyConfig('hospital')

    expectConfigError(() => resolveMapFamily(config), 'unknown')
  })

  it('[R01-S03][D01] rejects a disabled selected family with reason disabled', async () => {
    const resolveMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'resolveMapFamily',
      'disabled'
    )
    const config = familyConfig('sewer')

    expectConfigError(() => resolveMapFamily(config), 'disabled')
  })

  it('[R02-S01][D01] clones a complete family config and makes it eligible', async () => {
    const resolveMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'resolveMapFamily',
      'complete-profile'
    )
    const worldConfigForFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'worldConfigForFamily',
      'complete-profile'
    )
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

  it('[R02-S02][D01] rejects a selected profile missing a required constraint as incomplete', async () => {
    const resolveMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'resolveMapFamily',
      'incomplete'
    )
    const config = familyConfig('sewer')
    config.mapFamily.profiles.sewer.enabled = true
    delete config.mapFamily.profiles.sewer.maxLoops

    expectConfigError(() => resolveMapFamily(config), 'incomplete')
  })

  it('[R02-S03][D01] keeps office bytes unchanged after invalid family validation', async () => {
    const resolveMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'resolveMapFamily',
      'incomplete'
    )
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
  it('[R03-S02][D02] folds family identity into the existing zone fold while office stays code zero', async () => {
    const familyCodes = await plannedExport(
      MAP_FAMILY_MODULE,
      'MAP_FAMILY_CODES',
      'family-digest',
      'object'
    )
    const families = ['office', 'sewer', 'tower', 'lattice']
    const codes = families.map((family) => familyCodes[family])

    expect(familyCodes.office).toBe(0)
    expect(codes.every(Number.isInteger)).toBe(true)
    expect(new Set(codes).size).toBe(families.length)

    // D02 uses one fold input, `(familyCode << 8) | zone`; it does not add an
    // office-only fold that would invalidate the established office pins.
    const foldInput = (family) => (familyCodes[family] << 8) | ZONE_OFFICE
    expect(foldInput('office')).toBe(ZONE_OFFICE)
    expect(fmix32(foldInput('sewer'))).not.toBe(fmix32(foldInput('office')))
    expect(fmix32(foldInput('tower'))).not.toBe(fmix32(foldInput('sewer')))
  })
})

describe('void-safety family eligibility', () => {
  it('[R20-S01..S03][R32-S04][D08/D10] gates exactly Tower and Lattice', async () => {
    const requiresVoidSafety = await plannedExport(
      MAP_FAMILY_MODULE,
      'requiresVoidSafety',
      'void-safety-family-policy'
    )

    expect(Object.fromEntries(
      ['office', 'sewer', 'tower', 'lattice']
        .map((family) => [family, requiresVoidSafety(family)])
    )).toEqual({
      office: false,
      sewer: false,
      tower: true,
      lattice: true,
    })
    expect(WORLD_GEN_VERSION).toBe(21)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.profiles).toMatchObject({
      office: { enabled: true },
      sewer: { enabled: true },
      tower: { enabled: true },
      lattice: { enabled: true },
    })
  })
})

describe('byte-impact version and atomic pin activation', () => {
  it('[R05-S02..S04][R06-S01..S03][R20-S03][R24-S01..S03][D11] accepts only the complete atomic Sewer release set', async () => {
    const validateActivationEvidence = await plannedExport(
      FAMILY_AUDIT_MODULE,
      'validateActivationEvidence',
      'sewer-release-evidence'
    )
    const resolveMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'resolveMapFamily',
      'sewer-release-profile'
    )
    const worldConfigForFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'worldConfigForFamily',
      'sewer-release-profile'
    )
    const evidence = sewerReleaseActivationEvidence()

    expect(WORLD_GEN_VERSION).toBe(SEWER_RELEASE_EVIDENCE.generatorVersion)
    expect(SEWER_RELEASE_EVIDENCE.generatorVersion)
      .toBe(SEWER_RELEASE_EVIDENCE.previousVersion + 1)
    expect(SEWER_RELEASE_EVIDENCE.maximumHeightGoldenDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.selected).toBe('office')
    expect(Object.fromEntries(
      Object.entries(DEFAULT_WORLD_CONFIG.mapFamily.profiles)
        .map(([family, profile]) => [family, profile.enabled])
    )).toEqual({ office: true, sewer: true, tower: true, lattice: true })
    expect(resolveMapFamily(worldConfigForFamily('sewer')))
      .toMatchObject({ family: 'sewer', enabled: true })
    expect(validateActivationEvidence(evidence)).toEqual({ ok: true, reasons: [] })

    const missingGlobal = structuredClone(evidence)
    missingGlobal.pins.global = null
    expectActivationRejection(
      validateActivationEvidence(missingGlobal),
      'missing-global-pin'
    )

    const missingFamily = structuredClone(evidence)
    missingFamily.pins.family = null
    expectActivationRejection(
      validateActivationEvidence(missingFamily),
      'missing-family-pin'
    )

    const staleCorpus = structuredClone(evidence)
    staleCorpus.corpus.version = evidence.previous.version
    expectActivationRejection(
      validateActivationEvidence(staleCorpus),
      'stale-corpus-metadata'
    )
  })

  it('[R05-S02..S04][R06-S01..S03][R20-S01][R27-S01..S04][R33-S01][D11] accepts only the complete atomic Tower release set', async () => {
    const validateActivationEvidence = await plannedExport(
      FAMILY_AUDIT_MODULE,
      'validateActivationEvidence',
      'tower-release-evidence'
    )
    const resolveMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'resolveMapFamily',
      'tower-release-profile'
    )
    const worldConfigForFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'worldConfigForFamily',
      'tower-release-profile'
    )
    const evidence = towerReleaseActivationEvidence()

    expect(WORLD_GEN_VERSION).toBe(TOWER_RELEASE_EVIDENCE.generatorVersion)
    expect(TOWER_RELEASE_EVIDENCE.generatorVersion)
      .toBe(TOWER_RELEASE_EVIDENCE.previousVersion + 1)
    expect(TOWER_RELEASE_EVIDENCE.affectsMaximumHeight).toBe(true)
    expect(TOWER_RELEASE_EVIDENCE.familyRepresentativeDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(TOWER_RELEASE_EVIDENCE.familyCorpusDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(TOWER_RELEASE_EVIDENCE.globalGoldenDigest)
      .toBe(SEWER_RELEASE_EVIDENCE.globalGoldenDigest)
    expect(TOWER_RELEASE_EVIDENCE.maximumHeightGoldenDigest)
      .toBe(SEWER_RELEASE_EVIDENCE.maximumHeightGoldenDigest)
    expect(TOWER_RELEASE_EVIDENCE.globalGoldenDigest)
      .toBe(LATTICE_RELEASE_EVIDENCE.globalGoldenDigest)
    expect(TOWER_RELEASE_EVIDENCE.maximumHeightGoldenDigest)
      .toBe(LATTICE_RELEASE_EVIDENCE.maximumHeightGoldenDigest)
    expect(resolveMapFamily(worldConfigForFamily('tower')))
      .toMatchObject({ family: 'tower', enabled: true })
    expect(validateActivationEvidence(evidence)).toEqual({ ok: true, reasons: [] })

    for (const [namespace, reason] of [
      ['global', 'missing-global-pin'],
      ['family', 'missing-family-pin'],
      ['maximumHeight', 'missing-maximum-height'],
    ]) {
      const missing = structuredClone(evidence)
      missing.pins[namespace] = null
      expectActivationRejection(validateActivationEvidence(missing), reason)
    }

    const staleCorpus = structuredClone(evidence)
    staleCorpus.corpus.version = TOWER_RELEASE_EVIDENCE.previousVersion
    expectActivationRejection(
      validateActivationEvidence(staleCorpus),
      'stale-corpus-metadata'
    )
  })

  it('[R05-S02..S04][R06-S01..S03][R20-S02][R31-S01..S04][R33-S02][D11] accepts only the complete atomic Lattice release set', async () => {
    const validateActivationEvidence = await plannedExport(
      FAMILY_AUDIT_MODULE,
      'validateActivationEvidence',
      'lattice-release-evidence'
    )
    const resolveMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'resolveMapFamily',
      'lattice-release-profile'
    )
    const worldConfigForFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'worldConfigForFamily',
      'lattice-release-profile'
    )
    const evidence = latticeReleaseActivationEvidence()

    expect(WORLD_GEN_VERSION).toBe(LATTICE_RELEASE_EVIDENCE.generatorVersion)
    expect(LATTICE_RELEASE_EVIDENCE).toMatchObject({
      family: 'lattice',
      byteImpact: 'changed-output',
      previousVersion: 20,
      generatorVersion: 21,
      profileIdentity: 'lattice-forced-audit:levels-3:district-3:anchors-5:cycles-0.08-0.15:exposure-5-20:cues-8',
      seedDerivation: 'hashStr("audit-lattice-N#1"), N=0..2',
      affectsMaximumHeight: true,
    })
    expect(LATTICE_RELEASE_EVIDENCE.generatorVersion)
      .toBe(LATTICE_RELEASE_EVIDENCE.previousVersion + 1)
    expect(LATTICE_RELEASE_EVIDENCE.familyRepresentativeDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(LATTICE_RELEASE_EVIDENCE.familyCorpusDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(resolveMapFamily(worldConfigForFamily('lattice')))
      .toMatchObject({ family: 'lattice', enabled: true })
    expect(validateActivationEvidence(evidence)).toEqual({ ok: true, reasons: [] })

    for (const [namespace, reason] of [
      ['global', 'missing-global-pin'],
      ['family', 'missing-family-pin'],
      ['maximumHeight', 'missing-maximum-height'],
    ]) {
      const missing = structuredClone(evidence)
      missing.pins[namespace] = null
      expectActivationRejection(validateActivationEvidence(missing), reason)
    }

    const staleCorpus = structuredClone(evidence)
    staleCorpus.corpus.version = LATTICE_RELEASE_EVIDENCE.previousVersion
    expectActivationRejection(
      validateActivationEvidence(staleCorpus),
      'stale-corpus-metadata'
    )

    const staleSafety = structuredClone(evidence)
    staleSafety.voidSafety.deterministicReset.after.initialDigest = 'stale-lattice-reset'
    expectActivationRejection(
      validateActivationEvidence(staleSafety),
      'reset-baseline-mismatch'
    )
  })

  it('[R20-S01][R33-S01][R34-S01][D11] keeps Tower independent from Sewer and fails Tower closed on a safety regression', async () => {
    const validateActivationEvidence = await plannedExport(
      FAMILY_AUDIT_MODULE,
      'validateActivationEvidence',
      'tower-safety-independence'
    )
    const resolveMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'resolveMapFamily',
      'tower-safety-independence'
    )
    const worldConfigForFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'worldConfigForFamily',
      'tower-safety-independence'
    )
    const withoutSewer = structuredClone(DEFAULT_WORLD_CONFIG)
    withoutSewer.mapFamily.profiles.sewer.enabled = false
    const towerOnly = worldConfigForFamily('tower', withoutSewer)

    expect(resolveMapFamily(towerOnly)).toMatchObject({ family: 'tower', enabled: true })
    expect(towerOnly.mapFamily.profiles.sewer.enabled).toBe(false)

    const regressedTower = towerReleaseActivationEvidence()
    regressedTower.voidSafety.hardVoidDeath.ok = false
    expectActivationRejection(
      validateActivationEvidence(regressedTower),
      'hard-void-death-failed'
    )
    expect(validateActivationEvidence(sewerReleaseActivationEvidence()))
      .toEqual({ ok: true, reasons: [] })
  })

  it('[R20-S02][R33-S02][R34-S01][D11] keeps Lattice independent from Tower and fails only Lattice closed on a safety regression', async () => {
    const validateActivationEvidence = await plannedExport(
      FAMILY_AUDIT_MODULE,
      'validateActivationEvidence',
      'lattice-safety-independence'
    )
    const resolveMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'resolveMapFamily',
      'lattice-safety-independence'
    )
    const worldConfigForFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'worldConfigForFamily',
      'lattice-safety-independence'
    )
    const withoutTower = structuredClone(DEFAULT_WORLD_CONFIG)
    withoutTower.mapFamily.profiles.tower.enabled = false
    const latticeOnly = worldConfigForFamily('lattice', withoutTower)

    expect(resolveMapFamily(latticeOnly)).toMatchObject({ family: 'lattice', enabled: true })
    expect(latticeOnly.mapFamily.profiles.tower.enabled).toBe(false)

    const regressedLattice = latticeReleaseActivationEvidence()
    regressedLattice.voidSafety.hardVoidDeath.ok = false
    expectActivationRejection(
      validateActivationEvidence(regressedLattice),
      'hard-void-death-failed'
    )
    expect(validateActivationEvidence(sewerReleaseActivationEvidence()))
      .toEqual({ ok: true, reasons: [] })
    expect(validateActivationEvidence(towerReleaseActivationEvidence()))
      .toEqual({ ok: true, reasons: [] })
  })

  it('[R05-S01][D11] accepts inert foundation metadata without a version bump', async () => {
    const validateActivationEvidence = await plannedExport(
      FAMILY_AUDIT_MODULE,
      'validateActivationEvidence',
      'inert-version'
    )
    const evidence = activationEvidence({
      family: 'office',
      byteImpact: 'inert',
      affectsMaximumHeight: false,
      candidateVersion: WORLD_GEN_VERSION,
      candidateDigest: 'office-byte-stream',
    })
    evidence.pins.family = null

    const result = validateActivationEvidence(evidence)

    expect(result?.ok).toBe(true)
    expect(result?.reasons).toEqual([])
  })

  it('[R05-S02][D11] accepts first byte emission only with a higher version and complete metadata', async () => {
    const validateActivationEvidence = await plannedExport(
      FAMILY_AUDIT_MODULE,
      'validateActivationEvidence',
      'first-emission-version'
    )
    const evidence = activationEvidence({ byteImpact: 'first-emission' })

    const result = validateActivationEvidence(evidence)

    expect(evidence.candidate.version).toBeGreaterThan(evidence.previous.version)
    expect(evidence.corpus).toMatchObject({
      version: evidence.candidate.version,
      profileIdentity: 'tower-core',
      seedDerivation: 'hashStr(seedText#level)',
    })
    expect(result?.ok).toBe(true)
    expect(result?.reasons).toEqual([])
  })

  it('[R05-S03][D11] accepts changed enabled output only after the version advances', async () => {
    const validateActivationEvidence = await plannedExport(
      FAMILY_AUDIT_MODULE,
      'validateActivationEvidence',
      'changed-output-version'
    )
    const evidence = activationEvidence({
      byteImpact: 'changed-output',
      previousDigest: 'tower-byte-stream-v1',
      candidateDigest: 'tower-byte-stream-v2',
    })

    const result = validateActivationEvidence(evidence)

    expect(evidence.candidate.version).toBeGreaterThan(evidence.previous.version)
    expect(result?.ok).toBe(true)
    expect(result?.reasons).toEqual([])
  })

  it('[R05-S04][D11] rejects changed bytes without a bump as stale-version', async () => {
    const validateActivationEvidence = await plannedExport(
      FAMILY_AUDIT_MODULE,
      'validateActivationEvidence',
      'stale-version'
    )
    const evidence = activationEvidence({
      byteImpact: 'changed-output',
      candidateVersion: WORLD_GEN_VERSION,
      previousDigest: 'tower-byte-stream-v1',
      candidateDigest: 'tower-byte-stream-v2',
    })

    expectActivationRejection(validateActivationEvidence(evidence), 'stale-version')
  })

  it('[R06-S02][D11] rejects activation without its matching family pin', async () => {
    const validateActivationEvidence = await plannedExport(
      FAMILY_AUDIT_MODULE,
      'validateActivationEvidence',
      'missing-family-pin'
    )
    const evidence = activationEvidence()
    evidence.pins.family = null

    expectActivationRejection(validateActivationEvidence(evidence), 'missing-family-pin')
  })

  it('[R06-S01][D11] rejects activation without its matching global pin', async () => {
    const validateActivationEvidence = await plannedExport(
      FAMILY_AUDIT_MODULE,
      'validateActivationEvidence',
      'missing-global-pin'
    )
    const evidence = activationEvidence()
    evidence.pins.global = null

    const result = validateActivationEvidence(evidence)
    expectActivationRejection(result, 'missing-global-pin')
    expect(result.reasons).toEqual(['missing-global-pin'])
  })

  it.each([
    { pin: 'global', reason: 'stale-global-pin' },
    { pin: 'family', reason: 'stale-family-pin' },
    { pin: 'maximumHeight', reason: 'stale-maximum-height' },
  ])(
    '[R06-S01..S03][D11] rejects a stale $pin namespace as $reason',
    async ({ pin, reason }) => {
      const validateActivationEvidence = await plannedExport(
        FAMILY_AUDIT_MODULE,
        'validateActivationEvidence',
        reason
      )
      const evidence = activationEvidence()
      evidence.pins[pin].version = evidence.previous.version

      const result = validateActivationEvidence(evidence)
      expectActivationRejection(result, reason)
      expect(result.reasons).toEqual([reason])
    }
  )

  it('[R06-S03][D11] rejects relevant activation without maximum-height evidence', async () => {
    const validateActivationEvidence = await plannedExport(
      FAMILY_AUDIT_MODULE,
      'validateActivationEvidence',
      'missing-maximum-height'
    )
    const evidence = activationEvidence({ affectsMaximumHeight: true })
    evidence.pins.maximumHeight = null

    expectActivationRejection(validateActivationEvidence(evidence), 'missing-maximum-height')
  })

  it('[R06-S01][D11] rejects activation without corpus metadata', async () => {
    const validateActivationEvidence = await plannedExport(
      FAMILY_AUDIT_MODULE,
      'validateActivationEvidence',
      'missing-corpus-metadata'
    )
    const evidence = activationEvidence()
    evidence.corpus = null

    const result = validateActivationEvidence(evidence)
    expectActivationRejection(result, 'missing-corpus-metadata')
    expect(result.reasons).toEqual(['missing-corpus-metadata'])
  })

  it('[R06-S01][D11] rejects corpus metadata targeting a stale version', async () => {
    const validateActivationEvidence = await plannedExport(
      FAMILY_AUDIT_MODULE,
      'validateActivationEvidence',
      'stale-corpus-metadata'
    )
    const evidence = activationEvidence()
    evidence.corpus.version = evidence.previous.version

    const result = validateActivationEvidence(evidence)
    expectActivationRejection(result, 'stale-corpus-metadata')
    expect(result.reasons).toEqual(['stale-corpus-metadata'])
  })

  it('[R07-S02][D11] rejects reusing a released version for a different byte stream', async () => {
    const validateActivationEvidence = await plannedExport(
      FAMILY_AUDIT_MODULE,
      'validateActivationEvidence',
      'version-reuse'
    )
    const evidence = activationEvidence()
    evidence.released = {
      version: evidence.candidate.version,
      digest: 'already-released-different-byte-stream',
    }

    expectActivationRejection(validateActivationEvidence(evidence), 'version-reuse')
  })
})

describe('cross-family rollback configuration (task 6.1 RED)', () => {
  it('[R33-S03][R34-S01][D01] rolls Sewer back without disabling or deselecting Tower', async () => {
    const rollbackMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'rollbackMapFamily',
      'sewer-rollback-retains-tower'
    )
    const resolveMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'resolveMapFamily',
      'sewer-rollback-retains-tower'
    )
    const worldConfigForFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'worldConfigForFamily',
      'sewer-rollback-retains-tower'
    )
    const base = worldConfigForFamily('tower')
    const before = enabledFamilyFlags(base)

    const rolledBack = rollbackMapFamily('sewer', base)

    expect(rolledBack).not.toBe(base)
    expect(rolledBack.mapFamily.selected).toBe('tower')
    expect(enabledFamilyFlags(rolledBack)).toEqual({
      office: true,
      sewer: false,
      tower: true,
      lattice: true,
    })
    expect(resolveMapFamily(rolledBack)).toMatchObject({ family: 'tower', enabled: true })
    expect(enabledFamilyFlags(base)).toEqual(before)
  })

  it('[R33-S04][R34-S01][D01] rolls Tower back without disabling or deselecting Lattice', async () => {
    const rollbackMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'rollbackMapFamily',
      'tower-rollback-retains-lattice'
    )
    const resolveMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'resolveMapFamily',
      'tower-rollback-retains-lattice'
    )
    const worldConfigForFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'worldConfigForFamily',
      'tower-rollback-retains-lattice'
    )
    const base = worldConfigForFamily('lattice')
    const before = enabledFamilyFlags(base)

    const rolledBack = rollbackMapFamily('tower', base)

    expect(rolledBack).not.toBe(base)
    expect(rolledBack.mapFamily.selected).toBe('lattice')
    expect(enabledFamilyFlags(rolledBack)).toEqual({
      office: true,
      sewer: true,
      tower: false,
      lattice: true,
    })
    expect(resolveMapFamily(rolledBack)).toMatchObject({ family: 'lattice', enabled: true })
    expect(enabledFamilyFlags(base)).toEqual(before)
  })

  it('[R34-S02][D01] restores byte-identical Office after rolling back the sole selected non-office family', async () => {
    const rollbackMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'rollbackMapFamily',
      'sole-family-office-fallback'
    )
    const resolveMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'resolveMapFamily',
      'sole-family-office-fallback'
    )
    const base = structuredClone(DEFAULT_WORLD_CONFIG)
    base.mapFamily.selected = 'sewer'
    base.mapFamily.profiles.tower.enabled = false
    base.mapFamily.profiles.lattice.enabled = false
    const officeBefore = officeByteSnapshot(
      buildChunk(0x6011baac, 0, 0, 0, DEFAULT_WORLD_CONFIG)
    )

    const rolledBack = rollbackMapFamily('sewer', base)

    expect(rolledBack.mapFamily.selected).toBe('office')
    expect(enabledFamilyFlags(rolledBack)).toEqual({
      office: true,
      sewer: false,
      tower: false,
      lattice: false,
    })
    expect(resolveMapFamily(rolledBack)).toMatchObject({ family: 'office', enabled: true })
    expect(officeByteSnapshot(
      buildChunk(0x6011baac, 0, 0, 0, rolledBack)
    )).toEqual(officeBefore)
    expect(base.mapFamily.selected).toBe('sewer')
    expect(base.mapFamily.profiles.sewer.enabled).toBe(true)
  })
})

describe('untrusted family selection with office fallback', () => {
  it('round-trips every canonical family against the shipped default config', async () => {
    const worldConfigForFamilyOrOffice = await plannedExport(
      MAP_FAMILY_MODULE,
      'worldConfigForFamilyOrOffice',
      'or-office-roundtrip'
    )
    const resolveMapFamily = await plannedExport(
      MAP_FAMILY_MODULE,
      'resolveMapFamily',
      'or-office-roundtrip'
    )
    const order = await plannedExport(
      MAP_FAMILY_MODULE,
      'MAP_FAMILY_ORDER',
      'or-office-roundtrip',
      'object'
    )

    for (const kind of order) {
      const { family, config, fellBack } = worldConfigForFamilyOrOffice(kind)
      expect(family).toBe(kind)
      expect(fellBack).toBe(false)
      expect(config.mapFamily.selected).toBe(kind)
      expect(resolveMapFamily(config)).toMatchObject({ family: kind, enabled: true })
    }
  })

  it('projects the sewer profile onto the shared zone surface', async () => {
    const worldConfigForFamilyOrOffice = await plannedExport(
      MAP_FAMILY_MODULE,
      'worldConfigForFamilyOrOffice',
      'or-office-sewer-projection'
    )

    const { config } = worldConfigForFamilyOrOffice('sewer')
    const profile = DEFAULT_WORLD_CONFIG.mapFamily.profiles.sewer

    expect(config.zoneBands).toEqual(profile.zoneBands)
    for (const { id } of profile.zoneBands) {
      expect(config.lamps.phase[id]).toBe(profile.lampPhase)
      expect(config.lamps.chance[id]).toBe(profile.lampChance)
    }
  })

  it('falls back to office for unknown, empty, and missing selections', async () => {
    const worldConfigForFamilyOrOffice = await plannedExport(
      MAP_FAMILY_MODULE,
      'worldConfigForFamilyOrOffice',
      'or-office-unknown'
    )

    for (const junk of ['hospital', '', undefined, null, 42]) {
      const { family, config, fellBack } = worldConfigForFamilyOrOffice(junk)
      expect(family).toBe('office')
      expect(fellBack).toBe(true)
      expect(config.mapFamily.selected).toBe('office')
    }
  })

  it('falls back to office instead of throwing for a disabled family', async () => {
    const worldConfigForFamilyOrOffice = await plannedExport(
      MAP_FAMILY_MODULE,
      'worldConfigForFamilyOrOffice',
      'or-office-disabled'
    )
    const base = familyConfig('office') // COMPLETE_PROFILES: tower disabled

    const { family, config, fellBack } = worldConfigForFamilyOrOffice('tower', base)

    expect(family).toBe('office')
    expect(fellBack).toBe(true)
    expect(config.mapFamily.selected).toBe('office')
  })

  it('never mutates the base config', async () => {
    const worldConfigForFamilyOrOffice = await plannedExport(
      MAP_FAMILY_MODULE,
      'worldConfigForFamilyOrOffice',
      'or-office-no-mutation'
    )
    const base = familyConfig('office')
    base.mapFamily.profiles.sewer.enabled = true
    const snapshot = structuredClone(base)

    worldConfigForFamilyOrOffice('sewer', base)
    worldConfigForFamilyOrOffice('hospital', base)

    expect(base).toEqual(snapshot)
  })
})
