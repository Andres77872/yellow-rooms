import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

// The legacy-families snapshot (invariant I3) is the pre-refactor baseline and
// must survive the planned WORLD_GEN_VERSION bump untouched: repin never
// rewrites it. Simulate the bump for every importer of constants.js and check
// the fixture still matches byte for byte.
vi.mock('../constants.js', async (importOriginal) => ({
  ...(await importOriginal()),
  WORLD_GEN_VERSION: 29,
}))

const { WORLD_GEN_VERSION } = await import('../constants.js')
const { DEFAULT_WORLD_CONFIG } = await import('../config.js')
const { computeLegacySnapshot, legacyConfigView, LEGACY_SNAPSHOT_PATH } = await import(
  '../../../scripts/snapshot-legacy-families.mjs'
)

describe('legacy-families snapshot across a version bump', () => {
  it('runs under the bumped version', () => {
    expect(WORLD_GEN_VERSION).toBe(29)
    expect(DEFAULT_WORLD_CONFIG.version).toBe(29)
  })

  it('folds the live version back to the pinned 28', () => {
    const live = legacyConfigView(DEFAULT_WORLD_CONFIG)
    const pinned = legacyConfigView({ ...DEFAULT_WORLD_CONFIG, version: 28 })
    expect(live).toEqual(pinned)
    expect(legacyConfigView({ ...DEFAULT_WORLD_CONFIG, version: 27 }).body).not.toBe(pinned.body)
  })

  it('still matches the fixture', () => {
    const fixture = JSON.parse(readFileSync(LEGACY_SNAPSHOT_PATH, 'utf8'))
    expect(computeLegacySnapshot()).toEqual(fixture)
  }, 60_000)
})
