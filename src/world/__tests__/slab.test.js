import { describe, it, expect } from 'vitest'
import { slabContract, stairStrip, chunkStairs, STAIR_E, STAIR_W, STAIR_N, STAIR_S, STAIR_DX, STAIR_DZ } from '../slab.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { fmod } from '../constants.js'

const CFG = DEFAULT_WORLD_CONFIG
const SEEDS = [12345, 0xdeadbeef >>> 0, 7, 999999937]
const COORDS = [
  [0, 0],
  [3, -2],
  [-7, 11],
  [40, 40],
  [-13, -29],
]
const LAYERS = [-3, -2, -1, 0, 1, 2, 5]

describe('slab contracts', () => {
  it('is deterministic and independent of call order', () => {
    for (const seed of SEEDS) {
      const a = slabContract(seed, 3, -2, 1, CFG)
      slabContract(seed, 8, 8, -4, CFG) // interleave unrelated queries
      const b = slabContract(seed, 3, -2, 1, CFG)
      expect(b).toEqual(a)
    }
  })

  it('respects the parity bands and the [3..10]² strip box', () => {
    for (const seed of SEEDS) {
      for (const [cx, cz] of COORDS) {
        for (const cy of LAYERS) {
          const c = slabContract(seed, cx, cz, cy, CFG)
          if (!c.hasStair) continue
          const cells = stairStrip(c)
          for (const { lx, lz } of cells) {
            expect(lx).toBeGreaterThanOrEqual(3)
            expect(lx).toBeLessThanOrEqual(10)
            expect(lz).toBeGreaterThanOrEqual(3)
            expect(lz).toBeLessThanOrEqual(10)
          }
          if (fmod(cy, 2) === 0) {
            expect([STAIR_E, STAIR_W]).toContain(c.dir)
            for (const { lz } of cells) expect(lz).toBeLessThanOrEqual(5)
          } else {
            expect([STAIR_N, STAIR_S]).toContain(c.dir)
            for (const { lz } of cells) expect(lz).toBeGreaterThanOrEqual(7)
          }
          // Strip cells step 1 apart along the ascent axis, landing -> exit.
          for (let i = 1; i < 4; i++) {
            expect(cells[i].lx - cells[i - 1].lx).toBe(STAIR_DX[c.dir])
            expect(cells[i].lz - cells[i - 1].lz).toBe(STAIR_DZ[c.dir])
          }
        }
      }
    }
  })

  it('never places a stair strip in the spawn-hub guard box of chunk (0,0)', () => {
    for (const seed of SEEDS) {
      for (const cy of [-1, 0]) {
        const c = slabContract(seed, 0, 0, cy, CFG)
        if (!c.hasStair) continue
        for (const { lx, lz } of stairStrip(c)) {
          expect(lx >= 5 && lx <= 9 && lz >= 5 && lz <= 9).toBe(false)
        }
      }
    }
  })

  it('guarantees an up-stair in every stair-district on every slab (fallback)', () => {
    const K = CFG.stairs.districtChunks
    for (const seed of SEEDS) {
      for (const cy of [-2, 0, 3]) {
        for (const [sx, sz] of [[0, 0], [-1, 2], [5, -3]]) {
          let count = 0
          for (let dz = 0; dz < K; dz++) {
            for (let dx = 0; dx < K; dx++) {
              if (slabContract(seed, sx * K + dx, sz * K + dz, cy, CFG).hasStair) count++
            }
          }
          expect(count).toBeGreaterThanOrEqual(1)
        }
      }
    }
  })

  it('chunkStairs mirrors the vertical key symmetry: up(cy) === down(cy+1)', () => {
    for (const seed of SEEDS) {
      for (const [cx, cz] of COORDS) {
        for (const cy of LAYERS) {
          const here = chunkStairs(seed, cx, cz, cy, CFG)
          const above = chunkStairs(seed, cx, cz, cy + 1, CFG)
          expect(above.down).toEqual(here.up)
        }
      }
    }
  })

  it('disabling stairs removes every contract', () => {
    const cfg = { ...CFG, stairs: { ...CFG.stairs, enabled: false } }
    for (const [cx, cz] of COORDS) {
      for (const cy of LAYERS) {
        expect(slabContract(12345, cx, cz, cy, cfg).hasStair).toBe(false)
      }
    }
  })

  it('up- and down-stamps in one layer never share cells or stamped edge lines', () => {
    // Parity separation: even-slab strips live in rows 3-5 (H-lines 3..6),
    // odd-slab strips in rows 7-10 (H-lines 7..11). Verify empirically across
    // a coordinate sweep: the two contracts a layer realizes never overlap.
    for (const seed of SEEDS) {
      for (let cx = -4; cx <= 4; cx += 2) {
        for (let cz = -4; cz <= 4; cz += 2) {
          for (const cy of [-1, 0, 1, 2]) {
            const { up, down } = chunkStairs(seed, cx, cz, cy, CFG)
            if (!up.hasStair || !down.hasStair) continue
            const cellsUp = new Set(stairStrip(up).map((c) => `${c.lx},${c.lz}`))
            for (const c of stairStrip(down)) {
              expect(cellsUp.has(`${c.lx},${c.lz}`)).toBe(false)
            }
            const zsUp = stairStrip(up).map((c) => c.lz)
            const zsDown = stairStrip(down).map((c) => c.lz)
            // Row bands must not even touch: max of one band + 1 < min of other.
            expect(Math.max(...zsUp) + 1 < Math.min(...zsDown) || Math.max(...zsDown) + 1 < Math.min(...zsUp)).toBe(true)
          }
        }
      }
    }
  })
})
