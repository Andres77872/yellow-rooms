import { describe, it, expect } from 'vitest'
import { buildChunk } from '../pipeline.js'
import { DEFAULT_WORLD_CONFIG as CFG } from '../config.js'
import { CHUNK, ZONE_OFFICE, ZONE_PILLARS, ZONE_WAREHOUSE, chunkKey } from '../constants.js'
import { countChunkComponents } from '../topology.js'

function forcedZone(zone) {
  const cfg = structuredClone(CFG)
  cfg.zoneBands = [{ id: zone, max: 1.01 }]
  return cfg
}

describe('generation topology validation and repair', () => {
  it('repairs the known warehouse wall-loop regression', () => {
    const data = buildChunk(933, 2, 0, 1, forcedZone(ZONE_WAREHOUSE))
    expect(data.zone).toBe(ZONE_WAREHOUSE)
    expect(data.repairs.connectivity).toBeGreaterThan(0)
    expect(countChunkComponents(data)).toBe(1)
    expect(countChunkComponents(data, true)).toBe(1)
  })

  it('repairs the known column-aware navigation regression', () => {
    const data = buildChunk(104, -2, 0, 2, forcedZone(ZONE_WAREHOUSE))
    expect(data.zone).toBe(ZONE_WAREHOUSE)
    expect(data.repairs.navigation + data.repairs.columns).toBeGreaterThan(0)
    expect(countChunkComponents(data, true)).toBe(1)
  })

  it('enforces both local connectivity contracts across every zone and a seed corpus', () => {
    for (const zone of [ZONE_OFFICE, ZONE_PILLARS, ZONE_WAREHOUSE]) {
      const cfg = forcedZone(zone)
      for (let seed = 0; seed < 160; seed++) {
        const cx = (seed % 11) - 5
        const cz = ((seed * 7) % 13) - 6
        const data = buildChunk(seed, cx, 0, cz, cfg)
        expect(countChunkComponents(data)).toBe(1)
        expect(countChunkComponents(data, true)).toBe(1)
      }
    }
  })

  it('keeps every non-column navigation cell reachable across a streamed patch', () => {
    const N = 5
    const X0 = -2
    const Z0 = -2
    const W = N * CHUNK
    for (const seed of [104, 933, 0xbeef, 0xc0ffee]) {
      const chunks = new Map()
      for (let cz = Z0; cz < Z0 + N; cz++) {
        for (let cx = X0; cx < X0 + N; cx++) {
          chunks.set(chunkKey(cx, cz), buildChunk(seed, cx, 0, cz, CFG))
        }
      }
      const at = (gx, gz) => {
        const cx = Math.floor(gx / CHUNK)
        const cz = Math.floor(gz / CHUNK)
        const data = chunks.get(chunkKey(cx, cz))
        return {
          data,
          x: gx - cx * CHUNK,
          z: gz - cz * CHUNK,
        }
      }
      const blocked = (gx, gz) => {
        const c = at(gx, gz)
        return !c.data ||
          c.data.colAt(c.x, c.z) > 0 ||
          c.data.hasFloorHole(c.x, c.z)
      }
      const canPass = (gx, gz, nx, nz) => {
        if (blocked(nx, nz)) return false
        if (nx === gx + 1) {
          const c = at(nx, nz)
          return c.data.vAt(c.x, c.z) === 0
        }
        if (nx === gx - 1) {
          const c = at(gx, gz)
          return c.data.vAt(c.x, c.z) === 0
        }
        if (nz === gz + 1) {
          const c = at(nx, nz)
          return c.data.hAt(c.x, c.z) === 0
        }
        const c = at(gx, gz)
        return c.data.hAt(c.x, c.z) === 0
      }

      let start = null
      let walkable = 0
      for (let z = 0; z < W; z++) {
        for (let x = 0; x < W; x++) {
          const gx = X0 * CHUNK + x
          const gz = Z0 * CHUNK + z
          if (blocked(gx, gz)) continue
          walkable++
          if (!start) start = [gx, gz]
        }
      }
      const seen = new Set([`${start[0]},${start[1]}`])
      const queue = [start]
      while (queue.length) {
        const [gx, gz] = queue.shift()
        for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = gx + dx
          const nz = gz + dz
          if (
            nx < X0 * CHUNK ||
            nx >= (X0 + N) * CHUNK ||
            nz < Z0 * CHUNK ||
            nz >= (Z0 + N) * CHUNK ||
            !canPass(gx, gz, nx, nz)
          ) continue
          const key = `${nx},${nz}`
          if (!seen.has(key)) {
            seen.add(key)
            queue.push([nx, nz])
          }
        }
      }
      expect(seen.size).toBe(walkable)
    }
  })
})
