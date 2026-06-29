import { describe, it, expect } from 'vitest'
import { buildChunk } from '../pipeline.js'
import { DEFAULT_WORLD_CONFIG as CFG } from '../config.js'
import { CHUNK, ZONE_OFFICE, ZONE_PILLARS, ZONE_WAREHOUSE, chunkKey } from '../constants.js'
import { ChunkData } from '../ChunkData.js'
import { RNG } from '../core/rng.js'
import {
  isOfficeGuideCoord,
  officeGuidePositions,
  warehouseWallH,
} from '../layoutGuides.js'
import * as pillars from '../zones/pillars.js'

function forcedZone(zone) {
  const cfg = structuredClone(CFG)
  cfg.zoneBands = [{ id: zone, max: 1.01 }]
  return cfg
}

function allOfficePatch(seed, X0, Z0, N, cfg) {
  const chunks = new Map()
  for (let cz = Z0; cz < Z0 + N; cz++) {
    for (let cx = X0; cx < X0 + N; cx++) chunks.set(chunkKey(cx, cz), buildChunk(seed, cx, cz, cfg))
  }
  return chunks
}

describe('global office guides', () => {
  const seed = 0x0ff1ce
  const cfg = forcedZone(ZONE_OFFICE)
  const X0 = -2
  const Z0 = -2
  const N = 5
  const chunks = allOfficePatch(seed, X0, Z0, N, cfg)

  it('carves guide rows and columns through every office chunk', () => {
    for (let cz = Z0; cz < Z0 + N; cz++) {
      for (let cx = X0; cx < X0 + N; cx++) {
        const d = chunks.get(chunkKey(cx, cz))
        for (const z of officeGuidePositions(cz * CHUNK, seed, cfg, 'z')) {
          for (let lx = 1; lx < CHUNK; lx++) expect(d.vAt(lx, z)).toBe(0)
        }
        for (const x of officeGuidePositions(cx * CHUNK, seed, cfg, 'x')) {
          for (let lz = 1; lz < CHUNK; lz++) expect(d.hAt(x, lz)).toBe(0)
        }
      }
    }
  })

  it('places office seam doorways on guide lines that continue inward', () => {
    for (let cz = Z0; cz < Z0 + N; cz++) {
      for (let cx = X0; cx < X0 + N - 1; cx++) {
        const west = chunks.get(chunkKey(cx, cz))
        const east = chunks.get(chunkKey(cx + 1, cz))
        let open = 0
        for (let z = 1; z < CHUNK - 1; z++) {
          if (east.vAt(0, z) !== 0) continue
          open++
          expect(isOfficeGuideCoord(cz * CHUNK + z, seed, cfg, 'z')).toBe(true)
          for (let lx = 1; lx < CHUNK; lx++) {
            expect(west.vAt(lx, z)).toBe(0)
            expect(east.vAt(lx, z)).toBe(0)
          }
        }
        expect(open).toBeGreaterThanOrEqual(cfg.border.officeMinDoors)
      }
    }

    for (let cx = X0; cx < X0 + N; cx++) {
      for (let cz = Z0; cz < Z0 + N - 1; cz++) {
        const north = chunks.get(chunkKey(cx, cz))
        const south = chunks.get(chunkKey(cx, cz + 1))
        let open = 0
        for (let x = 1; x < CHUNK - 1; x++) {
          if (south.hAt(x, 0) !== 0) continue
          open++
          expect(isOfficeGuideCoord(cx * CHUNK + x, seed, cfg, 'x')).toBe(true)
          for (let lz = 1; lz < CHUNK; lz++) {
            expect(north.hAt(x, lz)).toBe(0)
            expect(south.hAt(x, lz)).toBe(0)
          }
        }
        expect(open).toBeGreaterThanOrEqual(cfg.border.officeMinDoors)
      }
    }
  })
})

describe('transition approach clearing', () => {
  it('removes pillar columns from office-to-open mouth approach cells', () => {
    const mouth = new Uint8Array(CHUNK).fill(1)
    mouth[2] = 0
    mouth[3] = 0
    mouth[4] = 0
    const data = new ChunkData(0, 0, ZONE_PILLARS)
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
    }
    expect(data.colAt(2, 2)).toBe(1)
  })
})

describe('global warehouse fragments', () => {
  it('generates wall fragments from global edge coordinates across chunk seams', () => {
    const cfg = forcedZone(ZONE_WAREHOUSE)
    cfg.border.stubChance = 0
    cfg.warehouse.colChance = 0
    cfg.warehouse.fragments.chance = 1
    cfg.warehouse.fragments.lineSpacing = 1
    cfg.warehouse.fragments.anchorStep = 10
    cfg.warehouse.fragments.runLen = [10, 10]

    const seed = 0x51a7
    const west = buildChunk(seed, 0, 0, cfg)
    const east = buildChunk(seed, 1, 0, cfg)
    const lineGz = 5

    expect(warehouseWallH(13, lineGz, seed, cfg)).toBe(true)
    expect(warehouseWallH(14, lineGz, seed, cfg)).toBe(true)
    expect(west.hAt(13, lineGz)).toBe(1)
    expect(east.hAt(0, lineGz)).toBe(1)
  })
})
