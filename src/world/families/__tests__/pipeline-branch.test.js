import { describe, expect, it, vi } from 'vitest'
import { generateChunk } from '../../generate.js'
import { worldConfigForFamily } from '../../mapFamily.js'
import { LEGACY_FAMILIES } from '../registry.js'
import { LIMINAL_FAMILY_IDS } from '../ids.js'
import { familyGenerator } from '../generators.js'
import { forcedFamilyConfig } from '../forced.js'
import { buildFamilyChunk } from '../../tiles/familyChunk.js'

// I1: the legacy 5 take no new code path during generation (spec §0.1, §6.7).
// The pipeline branch is a registry lookup that is null for legacy, so a spy
// on buildFamilyChunk never fires over 200 legacy builds — and fires exactly
// once per liminal build.

vi.mock('../../tiles/familyChunk.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, buildFamilyChunk: vi.fn(real.buildFamilyChunk) }
})

describe('pipeline branch (I1)', () => {
  it('familyGenerator is null for the legacy 5 and unknown ids, a generator for the 12', () => {
    expect(LEGACY_FAMILIES).toEqual(['office', 'sewer', 'tower', 'lattice', 'hotel'])
    for (const f of LEGACY_FAMILIES) expect(familyGenerator(f)).toBeNull()
    for (const f of ['toString', '__proto__', '', 'Office', undefined, null]) expect(familyGenerator(f)).toBeNull()
    for (const f of LIMINAL_FAMILY_IDS) expect(familyGenerator(f)?.tile).toBeTruthy()
  })

  it('200 legacy builds never reach buildFamilyChunk', () => {
    buildFamilyChunk.mockClear()
    let builds = 0
    for (const f of LEGACY_FAMILIES) {
      const config = worldConfigForFamily(f)
      for (let i = 0; i < 40; i++) {
        const d = generateChunk(0x5eed + i, (i % 7) - 3, (i % 3) - 1, (i % 5) - 2, config, i === 0 ? { lx: 6, lz: 6 } : null, i === 1 ? [{ lx: 6, lz: 6, r: 1 }] : null)
        expect(d.mapFamily).toBe(f)
        builds++
      }
    }
    expect(builds).toBe(200)
    expect(buildFamilyChunk).not.toHaveBeenCalled()
  }, 120_000)

  it('a liminal build goes through buildFamilyChunk once, with the resolved profile and seed >>> 0', () => {
    buildFamilyChunk.mockClear()
    const config = forcedFamilyConfig('house')
    const exitCell = { lx: 3, lz: 4 }
    const d = generateChunk(-1, 2, 0, -3, config, exitCell, [])
    expect(buildFamilyChunk).toHaveBeenCalledTimes(1)
    const [gen, profile, seed, cx, cy, cz, cfg, exit, clearings] = buildFamilyChunk.mock.calls[0]
    expect(gen).toBe(familyGenerator('house'))
    expect(profile).toEqual({ family: 'house', enabled: true })
    expect([seed, cx, cy, cz]).toEqual([0xffffffff, 2, 0, -3])
    expect(cfg).toBe(config)
    expect(exit).toBe(exitCell)
    expect(clearings).toEqual([])
    expect(d.mapFamily).toBe('house')
    expect(d.exit).toEqual(exitCell)
  })
})
