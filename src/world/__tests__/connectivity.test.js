import { describe, it, expect } from 'vitest'
import { buildChunk } from '../pipeline.js'
import { DEFAULT_WORLD_CONFIG as CFG } from '../config.js'
import { CHUNK, chunkKey } from '../constants.js'
import { floodReachable } from '../connectivity.js'

// Build an NX×NZ patch of chunks anchored at (X0,Z0) and expose global wall
// queries over it, then flood-fill the whole patch as one cell grid.
function buildPatch(seed, X0, Z0, NX, NZ, config = CFG) {
  const chunks = new Map()
  for (let cz = Z0; cz < Z0 + NZ; cz++) {
    for (let cx = X0; cx < X0 + NX; cx++) {
      chunks.set(chunkKey(cx, cz), buildChunk(seed, cx, cz, config))
    }
  }
  // Vertical wall on global line `lineGX`, global row `gz`.
  const vWall = (lineGX, gz) => {
    const cx = Math.floor(lineGX / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const c = chunks.get(chunkKey(cx, cz))
    if (!c) return 1
    return c.vAt(lineGX - cx * CHUNK, gz - cz * CHUNK) === 1
  }
  // Horizontal wall on global line `lineGZ`, global column `gx`.
  const hWall = (gx, lineGZ) => {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(lineGZ / CHUNK)
    const c = chunks.get(chunkKey(cx, cz))
    if (!c) return 1
    return c.hAt(gx - cx * CHUNK, lineGZ - cz * CHUNK) === 1
  }
  return { chunks, vWall, hWall }
}

describe('multi-chunk connectivity (no sealed pockets)', () => {
  const X0 = -4
  const Z0 = -4
  const N = 9
  const W = N * CHUNK
  const seeds = [1, 42, 0xbeef, 314159, 0xc0ffee, 99999]

  for (const seed of seeds) {
    it(`9x9 patch is fully connected (seed ${seed})`, () => {
      const { vWall, hWall } = buildPatch(seed, X0, Z0, N, N)
      // Local patch cell (lx,lz) -> global cell.
      const canPass = (ax, az, bx, bz) => {
        const gxa = X0 * CHUNK + ax
        const gza = Z0 * CHUNK + az
        if (bx === ax + 1) return !vWall(gxa + 1, gza) // east
        if (bx === ax - 1) return !vWall(gxa, gza) // west
        if (bz === az + 1) return !hWall(gxa, gza + 1) // south
        return !hWall(gxa, gza) // north
      }
      const seen = floodReachable((W / 2) | 0, (W / 2) | 0, W, W, canPass)
      let reached = 0
      for (const v of seen) reached += v
      // Every cell in the patch must be reachable: zero sealed pockets.
      expect(reached).toBe(W * W)
    })
  }
})
