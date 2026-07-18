import { describe, it, expect } from 'vitest'
import { ChunkData } from '../ChunkData.js'
import { buildChunk } from '../pipeline.js'
import { DEFAULT_WORLD_CONFIG as CFG } from '../config.js'
import { CHUNK, ZONE_OFFICE, ZONE_PILLARS } from '../constants.js'
import { RNG } from '../core/rng.js'
import { CELL_LOBBY, PASSAGE_OPEN, PASSAGE_WIDE } from '../mapTypes.js'
import { selectZone } from '../regions.js'
import * as pillars from '../zones/pillars.js'

const isOpenZone = (zone) => (CFG.border.openness[zone] ?? 0) >= 1

describe('office-to-open transitions', () => {
  it('uses a wide boundary and lobby approach on both seam axes', () => {
    const seed = 1
    let vertical = false
    let horizontal = false
    for (let cz = -8; cz <= 8 && (!vertical || !horizontal); cz++) {
      for (let cx = -8; cx <= 8 && (!vertical || !horizontal); cx++) {
        const zone = selectZone(cx, cz, seed, CFG)
        const eastZone = selectZone(cx + 1, cz, seed, CFG)
        if (!vertical && isOpenZone(zone) !== isOpenZone(eastZone)) {
          const west = buildChunk(seed, cx, 0, cz, CFG)
          const east = buildChunk(seed, cx + 1, 0, cz, CFG)
          const office = west.zone === ZONE_OFFICE ? west : east
          const open = west.zone === ZONE_OFFICE ? east : west
          const officeLines = west.zone === ZONE_OFFICE ? [CHUNK - 1, CHUNK - 2] : [1, 2]
          const openLines = west.zone === ZONE_OFFICE ? [1, 2] : [CHUNK - 1, CHUNK - 2]
          let openings = 0
          for (let z = 0; z < CHUNK; z++) {
            if (east.vAt(0, z)) continue
            openings++
            expect(east.passageVAt(0, z)).toBe(PASSAGE_WIDE)
            for (const line of officeLines) expect(office.passageVAt(line, z)).toBe(PASSAGE_WIDE)
            for (const line of openLines) expect(open.passageVAt(line, z)).toBe(PASSAGE_OPEN)
            const officeX = west.zone === ZONE_OFFICE ? CHUNK - 1 : 0
            expect(office.cellKind[z * CHUNK + officeX]).toBe(CELL_LOBBY)
          }
          expect(openings).toBeGreaterThanOrEqual(CFG.border.mouthWidth[0])
          vertical = true
        }

        const southZone = selectZone(cx, cz + 1, seed, CFG)
        if (!horizontal && isOpenZone(zone) !== isOpenZone(southZone)) {
          const north = buildChunk(seed, cx, 0, cz, CFG)
          const south = buildChunk(seed, cx, 0, cz + 1, CFG)
          const office = north.zone === ZONE_OFFICE ? north : south
          const open = north.zone === ZONE_OFFICE ? south : north
          const officeLines = north.zone === ZONE_OFFICE ? [CHUNK - 1, CHUNK - 2] : [1, 2]
          const openLines = north.zone === ZONE_OFFICE ? [1, 2] : [CHUNK - 1, CHUNK - 2]
          let openings = 0
          for (let x = 0; x < CHUNK; x++) {
            if (south.hAt(x, 0)) continue
            openings++
            expect(south.passageHAt(x, 0)).toBe(PASSAGE_WIDE)
            for (const line of officeLines) expect(office.passageHAt(x, line)).toBe(PASSAGE_WIDE)
            for (const line of openLines) expect(open.passageHAt(x, line)).toBe(PASSAGE_OPEN)
            const officeZ = north.zone === ZONE_OFFICE ? CHUNK - 1 : 0
            expect(office.cellKind[officeZ * CHUNK + x]).toBe(CELL_LOBBY)
          }
          expect(openings).toBeGreaterThanOrEqual(CFG.border.mouthWidth[0])
          horizontal = true
        }
      }
    }
    expect(vertical).toBe(true)
    expect(horizontal).toBe(true)
  })

  it('clears structural columns throughout an open-side mouth approach', () => {
    const mouth = new Uint8Array(CHUNK).fill(1)
    for (const z of [2, 3, 4]) mouth[z] = 0
    const data = new ChunkData(0, 0, 0, ZONE_PILLARS)
    pillars.generate(data, {
      seed: 7,
      cx: 0,
      cz: 0,
      zone: ZONE_PILLARS,
      rng: RNG.fromHash(7, 0, 0),
      config: CFG,
      borders: { wW: mouth },
      borderZones: { w: ZONE_OFFICE },
    })

    for (const z of [2, 3, 4]) {
      expect(data.colAt(0, z)).toBe(0)
      expect(data.colAt(1, z)).toBe(0)
      expect(data.colAt(2, z)).toBe(0)
    }
    expect(data.colAt(4, 4)).toBeGreaterThan(0)
  })
})
