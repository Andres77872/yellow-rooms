import { describe, it, expect } from 'vitest'
import { slabContract, stairStrip, chunkStairs, stairConfig, STAIR_E, STAIR_W, STAIR_DX, STAIR_DZ } from '../slab.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { LOAD_RADIUS } from '../constants.js'

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

  it('keeps transformed parity families perpendicular and inside [3..10]²', () => {
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
          // Strip cells step 1 apart along the ascent axis, landing -> exit.
          for (let i = 1; i < 4; i++) {
            expect(cells[i].lx - cells[i - 1].lx).toBe(STAIR_DX[c.dir])
            expect(cells[i].lz - cells[i - 1].lz).toBe(STAIR_DZ[c.dir])
          }
        }
        const even = slabContract(seed, cx, cz, 0, { ...CFG, stairs: { ...CFG.stairs, chance: 1 } })
        const odd = slabContract(seed, cx, cz, 1, { ...CFG, stairs: { ...CFG.stairs, chance: 1 } })
        expect(even.dir % 2).not.toBe(odd.dir % 2)
      }
    }
  })

  it('normalizes malformed tuning without losing the fallback guarantee', () => {
    for (const districtChunks of [0, -5, 1.9, NaN, Infinity, LOAD_RADIUS + 99]) {
      const cfg = {
        ...CFG,
        stairs: { ...CFG.stairs, chance: -10, districtChunks },
      }
      let stairs = 0
      for (let cz = -LOAD_RADIUS; cz <= LOAD_RADIUS; cz++) {
        for (let cx = -LOAD_RADIUS; cx <= LOAD_RADIUS; cx++) {
          if (slabContract(7, cx, cz, 0, cfg).hasStair) stairs++
        }
      }
      expect(stairs).toBeGreaterThan(0)
    }
    const normalized = stairConfig({
      stairs: {
        enabled: 1,
        chance: Infinity,
        districtChunks: LOAD_RADIUS + 99,
        salt: NaN,
      },
    })
    expect(normalized.enabled).toBe(true)
    expect(normalized.chance).toBe(0.3)
    expect(normalized.districtChunks).toBe(LOAD_RADIUS + 1)
    expect(normalized.salt).toBe(0x51ab)

    const mutable = structuredClone(CFG)
    const cached = stairConfig(mutable)
    expect(stairConfig(mutable)).toBe(cached)
    mutable.stairs.chance = 0
    expect(stairConfig(mutable)).not.toBe(cached)
    expect(stairConfig(mutable).chance).toBe(0)
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

  it('varies the transformed stair family between XZ chunk columns', () => {
    const cfg = { ...CFG, stairs: { ...CFG.stairs, chance: 1 } }
    const directions = new Set()
    const footprints = new Set()
    for (let cz = -5; cz <= 5; cz++) {
      for (let cx = -5; cx <= 5; cx++) {
        const c = slabContract(12345, cx, cz, 0, cfg)
        directions.add(c.dir)
        footprints.add(stairStrip(c).map(({ lx, lz }) => `${lx},${lz}`).join('|'))
      }
    }
    expect(directions.size).toBe(4)
    expect(footprints.size).toBeGreaterThan(20)
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
    const horizontal = (dir) => dir === STAIR_E || dir === STAIR_W
    const between = (a, b, horiz) => horiz
      ? `v:${Math.max(a.lx, b.lx)},${a.lz}`
      : `h:${a.lx},${Math.max(a.lz, b.lz)}`
    const flanks = (cell, horiz) => horiz
      ? [`h:${cell.lx},${cell.lz}`, `h:${cell.lx},${cell.lz + 1}`]
      : [`v:${cell.lx},${cell.lz}`, `v:${cell.lx + 1},${cell.lz}`]
    const stampEdges = (c, lower) => {
      const horiz = horizontal(c.dir)
      const cells = lower ? [c.landing, ...c.run] : c.run
      const edges = new Set(cells.flatMap((cell) => flanks(cell, horiz)))
      edges.add(between(lower ? c.run[1] : c.landing, lower ? c.exit : c.run[0], horiz))
      const outer = {
        lx: c.landing.lx - STAIR_DX[c.dir],
        lz: c.landing.lz - STAIR_DZ[c.dir],
      }
      edges.add(between(lower ? outer : c.run[1], lower ? c.landing : c.exit, horiz))
      return edges
    }
    // A column-stable D4 transform varies the bands, but transforms both
    // parity families together. Verify the actual lower/upper stamp edges.
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
            const upEdges = stampEdges(up, true)
            for (const edge of stampEdges(down, false)) expect(upEdges.has(edge)).toBe(false)
          }
        }
      }
    }
  })
})
