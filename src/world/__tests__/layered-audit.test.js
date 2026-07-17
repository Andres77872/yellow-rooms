import { describe, expect, it } from 'vitest'
import { auditLayeredPatch } from '../audit.js'
import { ChunkData } from '../ChunkData.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { buildChunk } from '../pipeline.js'
import { STAIR_DX, STAIR_DZ } from '../slab.js'

const denseConfig = () => ({
  ...DEFAULT_WORLD_CONFIG,
  stairs: { ...DEFAULT_WORLD_CONFIG.stairs, enabled: true, chance: 1 },
  multilevel: { ...DEFAULT_WORLD_CONFIG.multilevel, enabled: false },
})

const key = (cx, cy, cz) => `${cx},${cy},${cz}`
const lookup = (chunks) => (cx, cy, cz) => chunks.get(key(cx, cy, cz)) || null

function generatedPair(seed = 991) {
  const config = denseConfig()
  const chunks = new Map()
  chunks.set(key(0, 0, 0), buildChunk(seed, 0, 0, 0, config))
  chunks.set(key(0, 1, 0), buildChunk(seed, 0, 1, 0, config))
  return chunks
}

describe('layered world integrity audit', () => {
  it('accepts a real generated patch as one coherent 3D graph', () => {
    const seed = 1337
    const config = denseConfig()
    const chunks = new Map()
    for (let cy = -1; cy <= 1; cy++) {
      for (let cz = -1; cz <= 0; cz++) {
        for (let cx = -1; cx <= 0; cx++) {
          chunks.set(key(cx, cy, cz), buildChunk(seed, cx, cy, cz, config))
        }
      }
    }

    const audit = auditLayeredPatch(lookup(chunks), -1, -1, -1, 2, 3, 2)
    expect(audit.chunks).toBe(12)
    expect(audit.slabs).toBe(8)
    expect(audit.stairPairs).toBe(8)
    expect(audit.canonicalLinks).toBe(8)
    expect(audit.mismatchedDescriptors).toBe(0)
    expect(audit.holeMismatches).toBe(0)
    expect(audit.orphanedHalves).toBe(0)
    expect(audit.invalidCanonicalLinks).toBe(0)
    expect(audit.components).toBe(1)
    expect(audit.disconnectedCells).toBe(0)
    expect(audit.connected).toBe(true)
    expect(audit.ok).toBe(true)
  })

  it('reports an orphan half and every resulting slab-hole disagreement', () => {
    const chunks = generatedPair()
    chunks.get(key(0, 1, 0)).stairDown = null

    const audit = auditLayeredPatch(lookup(chunks), 0, 0, 0, 1, 2, 1)
    expect(audit.orphanedHalves).toBe(1)
    expect(audit.details.orphanedHalves[0].half).toBe('lower.stairUp')
    expect(audit.holeMismatchSlabs).toBe(1)
    expect(audit.holeMismatches).toBe(2)
    expect(audit.canonicalLinks).toBe(0)
    expect(audit.connected).toBe(false)
    expect(audit.ok).toBe(false)
  })

  it('separates descriptor mismatches from hole-cell mismatches', () => {
    const chunks = generatedPair(992)
    const upper = chunks.get(key(0, 1, 0))
    const down = upper.stairDown
    // Replace one upper hole with the landing. The lower descriptor remains
    // untouched: one expected hole disappears and one unexpected hole appears.
    upper.stairDown = {
      ...down,
      run: [{ ...down.landing }, { ...down.run[1] }],
    }

    const audit = auditLayeredPatch(lookup(chunks), 0, 0, 0, 1, 2, 1)
    expect(audit.stairPairs).toBe(1)
    expect(audit.mismatchedDescriptors).toBe(1)
    expect(audit.holeMismatchSlabs).toBe(1)
    expect(audit.holeMismatches).toBe(2)
    expect(audit.orphanedHalves).toBe(0)
    expect(audit.canonicalLinks).toBe(0)
    expect(audit.invalidCanonicalLinks).toBe(0)
    expect(audit.ok).toBe(false)
  })

  it('rejects a canonical landing-to-exit link with a blocked endpoint', () => {
    const chunks = generatedPair(993)
    const lower = chunks.get(key(0, 0, 0))
    lower.setCol(lower.stairUp.landing.lx, lower.stairUp.landing.lz, 1)

    const audit = auditLayeredPatch(lookup(chunks), 0, 0, 0, 1, 2, 1)
    expect(audit.mismatchedDescriptors).toBe(0)
    expect(audit.holeMismatches).toBe(0)
    expect(audit.invalidCanonicalLinks).toBe(1)
    expect(audit.details.invalidCanonicalLinks[0].reasons).toContain('blocked lower landing')
    expect(audit.canonicalLinks).toBe(0)
    expect(audit.connected).toBe(false)
    expect(audit.ok).toBe(false)
  })

  it('reports a stamped stair whose protected mouth or guard raster drifted', () => {
    const chunks = generatedPair(994)
    const lower = chunks.get(key(0, 0, 0))
    const stair = lower.stairUp
    const outer = {
      lx: stair.landing.lx - STAIR_DX[stair.dir],
      lz: stair.landing.lz - STAIR_DZ[stair.dir],
    }
    if (stair.dir === 1 || stair.dir === 3) {
      lower.setV(Math.max(outer.lx, stair.landing.lx), stair.landing.lz, 1)
    } else {
      lower.setH(stair.landing.lx, Math.max(outer.lz, stair.landing.lz), 1)
    }

    const audit = auditLayeredPatch(lookup(chunks), 0, 0, 0, 1, 2, 1)
    expect(audit.invalidCanonicalLinks).toBe(1)
    expect(audit.details.invalidCanonicalLinks[0].reasons).toContain('invalid lower mouth')
    expect(audit.ok).toBe(false)
  })

  it('uses owned walls when finding disconnected 3D graph components', () => {
    const data = new ChunkData(0, 0, 0, 0)
    // Isolate one ordinary interior cell in an otherwise open chunk.
    data.setV(5, 5, 1)
    data.setV(6, 5, 1)
    data.setH(5, 5, 1)
    data.setH(5, 6, 1)
    const chunks = new Map([[key(0, 0, 0), data]])

    const audit = auditLayeredPatch(lookup(chunks), 0, 0, 0, 1, 1, 1)
    expect(audit.walkableCells).toBe(14 * 14)
    expect(audit.componentSizes).toEqual([14 * 14 - 1, 1])
    expect(audit.components).toBe(2)
    expect(audit.disconnectedCells).toBe(1)
    expect(audit.connected).toBe(false)
    expect(audit.ok).toBe(false)
  })
})
