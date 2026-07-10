import { describe, it, expect } from 'vitest'
import { buildChunk } from '../pipeline.js'
import { DEFAULT_WORLD_CONFIG as CFG } from '../config.js'
import { CHUNK, ZONE_OFFICE, ZONE_PILLARS, ZONE_WAREHOUSE } from '../constants.js'
import { CELL_CORRIDOR, CELL_LOBBY } from '../mapTypes.js'

function forcedZone(zone) {
  const cfg = structuredClone(CFG)
  cfg.zoneBands = [{ id: zone, max: 1.01 }]
  return cfg
}

describe('feature-keyed lamp randomness', () => {
  it('keeps conditional dead rates close to the configured probability in every zone', () => {
    for (const zone of [ZONE_OFFICE, ZONE_PILLARS, ZONE_WAREHOUSE]) {
      const cfg = forcedZone(zone)
      let fixtures = 0
      let dead = 0
      for (let cz = -20; cz < 20; cz++) {
        for (let cx = -20; cx < 20; cx++) {
          const data = buildChunk(0x71a9, cx, cz, cfg)
          fixtures += data.lamps.length
          for (const lamp of data.lamps) dead += lamp.lit ? 0 : 1
        }
      }
      expect(fixtures).toBeGreaterThan(1000)
      expect(dead / fixtures).toBeGreaterThan(0.16)
      expect(dead / fixtures).toBeLessThan(0.2)
    }
  })

  it('changing the dead-state salt never changes fixture positions', () => {
    const a = forcedZone(ZONE_OFFICE)
    const b = structuredClone(a)
    b.lamps.deadSalt ^= 0x7777
    for (const [cx, cz] of [[0, 0], [4, -3], [-8, 5]]) {
      const pa = buildChunk(123, cx, cz, a).lamps.map(({ lx, lz }) => [lx, lz])
      const pb = buildChunk(123, cx, cz, b).lamps.map(({ lx, lz }) => [lx, lz])
      expect(pb).toEqual(pa)
    }
  })

  it('guarantees fixtures and lit guidance along office circulation', () => {
    const cfg = forcedZone(ZONE_OFFICE)
    for (let seed = 0; seed < 40; seed++) {
      let fixtures = 0
      let lit = 0
      for (let cz = 0; cz < cfg.office.districtChunks; cz++) {
        for (let cx = 0; cx < cfg.office.districtChunks; cx++) {
          const data = buildChunk(seed, cx, cz, cfg)
          for (const lamp of data.lamps) {
            const kind = data.cellKind[lamp.lz * CHUNK + lamp.lx]
            if (kind !== CELL_CORRIDOR && kind !== CELL_LOBBY) continue
            fixtures++
            if (lamp.lit) lit++
          }
        }
      }
      expect(fixtures).toBeGreaterThan(0)
      expect(lit).toBeGreaterThan(0)
    }
  })
})
