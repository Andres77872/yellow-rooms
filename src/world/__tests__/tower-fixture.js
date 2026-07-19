import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { MAP_FAMILY_TOWER } from '../mapTypes.js'
import { structureAt } from '../structureContracts.js'
import { TOWER_STRUCTURE_KIND } from '../tower.js'

export const TOWER_SCAN_SEEDS = Object.freeze([0x5a17, 0x7157, 0xc0ffee])

let discovery = null

// This finite order is a fixture locator only. Keeping it in one test helper
// prevents the streaming, path, and aperture proofs from silently selecting
// different candidates; it remains neither a planner API nor a density claim.
export function discoverTowerFixture() {
  if (discovery) return discovery

  const base = structuredClone(DEFAULT_WORLD_CONFIG)
  base.mapFamily.profiles[MAP_FAMILY_TOWER].enabled = true
  const config = worldConfigForFamily(MAP_FAMILY_TOWER, base)
  for (const seed of TOWER_SCAN_SEEDS) {
    for (let cy = -24; cy <= 24; cy++) {
      for (let cz = -4; cz <= 4; cz++) {
        for (let cx = -4; cx <= 4; cx++) {
          const structure = structureAt(seed, cx, cz, cy, config)
          if (
            structure?.hasRoom === true &&
            structure.family === MAP_FAMILY_TOWER &&
            structure.kind === TOWER_STRUCTURE_KIND
          ) {
            discovery = { config, seed, structure }
            return discovery
          }
        }
      }
    }
  }

  discovery = { config, seed: null, structure: null }
  return discovery
}
