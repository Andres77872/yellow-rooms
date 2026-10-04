import { describe, expect, it } from 'vitest'
import { CHUNK } from '../../constants.js'
import { hashStr } from '../../core/hash.js'
import { cellWalkable } from '../../tiles/holeMasks.js'
import { SPAWN_LEVEL, lightLevelAt } from '../../tiles/fillLight.js'
import { forcedFamilyConfig } from '../forced.js'
import { familyGenerator } from '../generators.js'
import { familySpawn } from '../hooks.js'
import { LIMINAL_FAMILY_IDS, MAP_FAMILY_THEATER } from '../ids.js'
import { worldSource } from '../reach.js'

// I-playfix: the first-person playtest found runs that start in the dark
// (babel's vestibule, the night lot, the pool deck, the house yard, …) and
// routes far darker than the legacy maps. Every liminal generator now carries
// a fill-light spec (tiles/fillLight.js), and the spawn stands in light —
// except the theatre, whose house is lit by the ghost light alone (doc 11).
const SEEDS = [1, 0x5eed, hashStr('p6qdjc#1') >>> 0]
const GATE = 12 // §11.1 item 9: lit lamps per chunk-storey

// Share of the walkable cells of the 3×3 chunks round the spawn (storey 0)
// that the light model leaves below 0.02 (lightAt ≈ its 0.1 floor), per
// family: the ceiling each family must stay under. Design-dark families keep
// a looser bound (the theatre's house, the night lot's deck between islands,
// the suburb's sleeping houses).
const DARK_MAX = Object.freeze({
  stairwell: 0.35,
  nightlot: 0.95,
  showroom: 0.4,
  poolrooms: 0.4,
  babel: 0.45,
  suburb: 0.75,
  terminal: 0.5,
  theater: 0.95,
  playplace: 0.35,
  train: 0.45,
  house: 0.4,
  funhouse: 0.6,
})

describe('liminal fill light (I-playfix)', () => {
  it('every liminal generator declares a fill-light spec', () => {
    for (const id of LIMINAL_FAMILY_IDS) expect(familyGenerator(id).light, id).toBeTruthy()
  })

  it.each(LIMINAL_FAMILY_IDS)('%s: the spawn stands in light; lamps within the gate; route darkness bounded', (id) => {
    const config = forcedFamilyConfig(id)
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      const sp = familySpawn(config, seed)
      const gx = sp.cx * CHUNK + sp.lx
      const gz = sp.cz * CHUNK + sp.lz
      if (id !== MAP_FAMILY_THEATER) {
        expect(lightLevelAt(src, gx, gz, 0), `spawn light, seed ${seed}`).toBeGreaterThanOrEqual(SPAWN_LEVEL)
      }
      let walk = 0
      let dark = 0
      for (let cz = sp.cz - 1; cz <= sp.cz + 1; cz++) {
        for (let cx = sp.cx - 1; cx <= sp.cx + 1; cx++) {
          for (const cy of [-1, 0, 1]) {
            const d = src.chunkAt(cx, cy, cz)
            if (d) expect(d.lamps.filter((l) => l.lit).length, `lit ${cx},${cy},${cz}`).toBeLessThanOrEqual(GATE)
          }
          const d = src.chunkAt(cx, 0, cz)
          for (let lz = 0; lz < CHUNK; lz++) {
            for (let lx = 0; lx < CHUNK; lx++) {
              if (!cellWalkable(d, lx, lz)) continue
              walk++
              if (lightLevelAt(src, cx * CHUNK + lx, cz * CHUNK + lz, 0) < 0.02) dark++
            }
          }
        }
      }
      expect(walk).toBeGreaterThan(0)
      expect(dark / walk, `dark share, seed ${seed}`).toBeLessThanOrEqual(DARK_MAX[id])
    }
  })
})
