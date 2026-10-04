import { describe, expect, it } from 'vitest'
import { CELL, CHUNK_WORLD } from '../../constants.js'
import { DEFAULT_WORLD_CONFIG } from '../../config.js'
import { worldConfigForFamily } from '../../mapFamily.js'
import { LEGACY_FAMILIES } from '../registry.js'
import { LIMINAL_FAMILY_IDS } from '../ids.js'
import { forcedFamilyConfig } from '../forced.js'
import { familyExitHook, familySpawn, hookOf, LEGACY_SPAWN } from '../hooks.js'

// familySpawn for the legacy 5 is exactly today's spawn (spec §8.1): the hub
// cell of chunk (0,0) with the r = 1 hub clearing; no exit hook.

describe('legacy spawn and exit hooks', () => {
  it('familySpawn(legacy) is LEGACY_SPAWN for every family and seed', () => {
    for (const f of LEGACY_FAMILIES) {
      const config = worldConfigForFamily(f)
      for (const seed of [0, 1, 0x5eed, -7, 0xffffffff]) {
        expect(familySpawn(config, seed)).toBe(LEGACY_SPAWN)
      }
      expect(familyExitHook(config)).toBeNull()
      expect(hookOf(f)).toBeNull()
    }
    expect(familySpawn(DEFAULT_WORLD_CONFIG, 3)).toBe(LEGACY_SPAWN)
    expect(familySpawn(undefined, 3)).toBe(LEGACY_SPAWN)
    expect(familySpawn({ mapFamily: { selected: 'nope' } }, 3)).toBe(LEGACY_SPAWN)
  })

  it('LEGACY_SPAWN deep-equals today\'s constants and is frozen', () => {
    expect(LEGACY_SPAWN).toEqual({
      cx: 0, cz: 0, lx: 7, lz: 7, yaw: null, x: LEGACY_SPAWN.x, z: LEGACY_SPAWN.z,
      clearings: [{ cx: 0, cy: 0, cz: 0, lx: 7, lz: 7, r: 1 }],
    })
    expect(LEGACY_SPAWN.x).toBe(7.5 * CELL)
    expect(LEGACY_SPAWN.z).toBe(7.5 * CELL)
    expect(Object.isFrozen(LEGACY_SPAWN)).toBe(true)
    expect(Object.isFrozen(LEGACY_SPAWN.clearings)).toBe(true)
    expect(Object.isFrozen(LEGACY_SPAWN.clearings[0])).toBe(true)
  })

  it('liminal spawns: storey-0 cell, world x/z, no clearings', () => {
    for (const id of LIMINAL_FAMILY_IDS) {
      const sp = familySpawn(forcedFamilyConfig(id), 9)
      expect(sp.cy).toBeUndefined()
      expect(sp.clearings).toEqual([])
      expect(sp.x).toBe(sp.cx * CHUNK_WORLD + (sp.lx + 0.5) * CELL)
      expect(sp.z).toBe(sp.cz * CHUNK_WORLD + (sp.lz + 0.5) * CELL)
      expect(typeof familyExitHook(forcedFamilyConfig(id))).toBe('function')
    }
  })
})
