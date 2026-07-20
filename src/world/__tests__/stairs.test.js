import { describe, it, expect } from 'vitest'
import { buildChunk } from '../pipeline.js'
import { slabContract, STAIR_E, STAIR_W, STAIR_DX, STAIR_DZ } from '../structures/slab.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { CHUNK, ZONE_OFFICE, ZONE_PILLARS, ZONE_WAREHOUSE, vIdx, hIdx, cIdx } from '../constants.js'
import { CELL_STAIR, PASSAGE_WALL, PASSAGE_WIDE } from '../mapTypes.js'
import { countChunkComponents } from '../topology.js'

const CFG = DEFAULT_WORLD_CONFIG

// Force stairs everywhere so every chunk exercises both stamps.
const denseCfg = (base = CFG) => ({
  ...base,
  stairs: { ...base.stairs, chance: 1 },
  multilevel: { ...base.multilevel, enabled: false },
})

const horizontal = (dir) => dir === STAIR_E || dir === STAIR_W

// The two flank edge coords of a strip cell, as [kind, lx, lz] with kind v|h.
function flanks(cell, dir) {
  return horizontal(dir)
    ? [
        ['h', cell.lx, cell.lz],
        ['h', cell.lx, cell.lz + 1],
      ]
    : [
        ['v', cell.lx, cell.lz],
        ['v', cell.lx + 1, cell.lz],
      ]
}

function edgeBetween(a, b, dir) {
  return horizontal(dir)
    ? ['v', Math.max(a.lx, b.lx), a.lz]
    : ['h', a.lx, Math.max(a.lz, b.lz)]
}

const wallAt = (d, [kind, lx, lz]) => (kind === 'v' ? d.vAt(lx, lz) : d.hAt(lx, lz))
const passageAt = (d, [kind, lx, lz]) =>
  kind === 'v' ? d.passageVAt(lx, lz) : d.passageHAt(lx, lz)

describe('stair stamps', () => {
  it('vertically adjacent chunks realize the identical slab contract', () => {
    for (const seed of [7, 12345, 0xbeef]) {
      for (const [cx, cz] of [[0, 0], [3, -2], [-6, 9]]) {
        for (let cy = -2; cy <= 2; cy++) {
          const below = buildChunk(seed, cx, cy, cz, CFG)
          const above = buildChunk(seed, cx, cy + 1, cz, CFG)
          expect(above.stairDown).toEqual(below.stairUp)
        }
      }
    }
  })

  it('realizes the exact stamped bytes on both layers', () => {
    const cfg = denseCfg()
    for (const seed of [7, 12345]) {
      for (const [cx, cz] of [[1, 1], [-3, 4], [8, -8]]) {
        for (const cy of [-1, 0, 1]) {
          const c = slabContract(seed, cx, cz, cy, cfg)
          expect(c.hasStair).toBe(true)
          const lower = buildChunk(seed, cx, cy, cz, cfg)
          const upper = buildChunk(seed, cx, cy + 1, cz, cfg)

          // Lower half: flanks along landing+runs walled, far-end wall present,
          // mouth open+wide; walkable strip cells marked and column-free.
          for (const cell of [c.landing, ...c.run]) {
            for (const e of flanks(cell, c.dir)) {
              expect(wallAt(lower, e)).toBe(1)
              expect(passageAt(lower, e)).toBe(PASSAGE_WALL)
            }
            expect(lower.cellKind[cIdx(cell.lx, cell.lz)]).toBe(CELL_STAIR)
            expect(lower.colAt(cell.lx, cell.lz)).toBe(0)
          }
          expect(wallAt(lower, edgeBetween(c.run[1], c.exit, c.dir))).toBe(1)
          const outer = {
            lx: c.landing.lx - STAIR_DX[c.dir],
            lz: c.landing.lz - STAIR_DZ[c.dir],
          }
          const mouth = edgeBetween(outer, c.landing, c.dir)
          expect(wallAt(lower, mouth)).toBe(0)
          expect(passageAt(lower, mouth)).toBe(PASSAGE_WIDE)
          // Ramp interior edges stay open (landing->run0->run1).
          expect(wallAt(lower, edgeBetween(c.landing, c.run[0], c.dir))).toBe(0)
          expect(wallAt(lower, edgeBetween(c.run[0], c.run[1], c.dir))).toBe(0)
          // Ceiling holes derived exactly over the run cells.
          expect(lower.hasCeilHole(c.run[0].lx, c.run[0].lz)).toBe(true)
          expect(lower.hasCeilHole(c.run[1].lx, c.run[1].lz)).toBe(true)
          expect(lower.hasCeilHole(c.landing.lx, c.landing.lz)).toBe(false)
          expect(lower.hasCeilHole(c.exit.lx, c.exit.lz)).toBe(false)

          // Upper half: hole flanks walled, back wall present, descend edge
          // open+wide; holes marked, exit cell walkable and column-free.
          for (const cell of c.run) {
            for (const e of flanks(cell, c.dir)) {
              expect(wallAt(upper, e)).toBe(1)
            }
            expect(upper.cellKind[cIdx(cell.lx, cell.lz)]).toBe(CELL_STAIR)
            expect(upper.hasFloorHole(cell.lx, cell.lz)).toBe(true)
          }
          expect(wallAt(upper, edgeBetween(c.landing, c.run[0], c.dir))).toBe(1)
          const descend = edgeBetween(c.run[1], c.exit, c.dir)
          expect(wallAt(upper, descend)).toBe(0)
          expect(passageAt(upper, descend)).toBe(PASSAGE_WIDE)
          expect(upper.hasFloorHole(c.exit.lx, c.exit.lz)).toBe(false)
          expect(upper.colAt(c.exit.lx, c.exit.lz)).toBe(0)
        }
      }
    }
  })

  it('keeps every stamped chunk one connected component in every zone', () => {
    const zones = [ZONE_OFFICE, ZONE_PILLARS, ZONE_WAREHOUSE]
    for (const zone of zones) {
      const cfg = denseCfg({ ...CFG, zoneBands: [{ id: zone, max: 1.01 }] })
      for (let seed = 1; seed <= 60; seed++) {
        for (const cy of [-1, 0, 1]) {
          const d = buildChunk(seed, 2, cy, -2, cfg)
          expect(countChunkComponents(d), `zone ${zone} seed ${seed} cy ${cy}`).toBe(1)
          expect(
            countChunkComponents(d, true),
            `zone ${zone} seed ${seed} cy ${cy} (column-aware)`
          ).toBe(1)
        }
      }
    }
  })

  it('generation order across layers cannot change bytes', () => {
    const cfgA = structuredClone(CFG) // separate config objects -> separate plan caches
    const cfgB = structuredClone(CFG)
    const snap = (d) => ({
      wallV: Array.from(d.wallV),
      wallH: Array.from(d.wallH),
      cellKind: Array.from(d.cellKind),
      stairUp: d.stairUp,
      stairDown: d.stairDown,
    })
    // A: layer 0 then 1; B: layer 1 then 0 (fresh caches each).
    const a0 = snap(buildChunk(4242, 5, 0, 5, cfgA))
    const a1 = snap(buildChunk(4242, 5, 1, 5, cfgA))
    const b1 = snap(buildChunk(4242, 5, 1, 5, cfgB))
    const b0 = snap(buildChunk(4242, 5, 0, 5, cfgB))
    expect(b0).toEqual(a0)
    expect(b1).toEqual(a1)
  })

  it('protects stamped guard walls from later clearings', () => {
    const cfg = denseCfg()
    const c = slabContract(7, 1, 1, 0, cfg)
    expect(c.hasStair).toBe(true)
    // A clearing centred on the ramp would, without protection, re-open the
    // flank guard walls. It must not.
    const carved = buildChunk(7, 1, 0, 1, cfg, null, [
      { lx: c.run[0].lx, lz: c.run[0].lz, r: 2 },
    ])
    for (const cell of [c.landing, ...c.run]) {
      for (const e of flanks(cell, c.dir)) {
        expect(wallAt(carved, e)).toBe(1)
      }
    }
    // And the mouth survives as an opening.
    const outer = {
      lx: c.landing.lx - STAIR_DX[c.dir],
      lz: c.landing.lz - STAIR_DZ[c.dir],
    }
    expect(wallAt(carved, edgeBetween(outer, c.landing, c.dir))).toBe(0)
  })

  it('no stranded floor: a 12x12x5 patch floods as one graph through stairs', () => {
    const seed = 1337
    const X0 = 0, Z0 = 0, NX = 12, NZ = 12
    const LAYERS = [-2, -1, 0, 1, 2]
    const chunks = new Map()
    for (const cy of LAYERS) {
      for (let cz = Z0; cz < Z0 + NZ; cz++) {
        for (let cx = X0; cx < X0 + NX; cx++) {
          chunks.set(`${cx},${cy},${cz}`, buildChunk(seed, cx, cy, cz, CFG))
        }
      }
    }
    const dataAt = (cx, cy, cz) => chunks.get(`${cx},${cy},${cz}`) || null
    const wallV = (gx, gz, cy) => {
      const cx = Math.floor(gx / CHUNK)
      const cz = Math.floor(gz / CHUNK)
      const d = dataAt(cx, cy, cz)
      return d ? d.wallV[vIdx(gx - cx * CHUNK, gz - cz * CHUNK)] === 1 : true
    }
    const wallH = (gx, gz, cy) => {
      const cx = Math.floor(gx / CHUNK)
      const cz = Math.floor(gz / CHUNK)
      const d = dataAt(cx, cy, cz)
      return d ? d.wallH[hIdx(gx - cx * CHUNK, gz - cz * CHUNK)] === 1 : true
    }
    const cellData = (gx, gz, cy) =>
      dataAt(Math.floor(gx / CHUNK), cy, Math.floor(gz / CHUNK))
    // Walkable: inside the patch, not a column, not a floor hole (hole cells'
    // walkable surface is the ramp on the layer below).
    const walkable = (gx, gz, cy) => {
      const d = cellData(gx, gz, cy)
      if (!d) return false
      const lx = gx - Math.floor(gx / CHUNK) * CHUNK
      const lz = gz - Math.floor(gz / CHUNK) * CHUNK
      return d.colAt(lx, lz) === 0 && !d.hasFloorHole(lx, lz)
    }

    // Collect walkable cells + stair links.
    const total = new Set()
    const stairLinks = [] // [gx1,gz1,cy, gx2,gz2,cy+1] run1 <-> exit
    for (const [key, d] of chunks) {
      const [cx, cy, cz] = key.split(',').map(Number)
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          if (walkable(cx * CHUNK + lx, cz * CHUNK + lz, cy)) {
            total.add(`${cx * CHUNK + lx},${cz * CHUNK + lz},${cy}`)
          }
        }
      }
      if (d.stairUp && LAYERS.includes(cy + 1)) {
        stairLinks.push([
          cx * CHUNK + d.stairUp.run[1].lx,
          cz * CHUNK + d.stairUp.run[1].lz,
          cy,
          cx * CHUNK + d.stairUp.exit.lx,
          cz * CHUNK + d.stairUp.exit.lz,
          cy + 1,
        ])
      }
    }
    const linksFrom = new Map()
    for (const [ax, az, acy, bx, bz, bcy] of stairLinks) {
      const a = `${ax},${az},${acy}`
      const b = `${bx},${bz},${bcy}`
      if (!linksFrom.has(a)) linksFrom.set(a, [])
      if (!linksFrom.has(b)) linksFrom.set(b, [])
      linksFrom.get(a).push(b)
      linksFrom.get(b).push(a)
    }

    // BFS from the layer-0 hub.
    const start = `${7},${7},${0}`
    expect(total.has(start)).toBe(true)
    const seen = new Set([start])
    const queue = [start]
    while (queue.length) {
      const cur = queue.pop()
      const [gx, gz, cy] = cur.split(',').map(Number)
      const step = (nx, nz, blockedByWall) => {
        if (blockedByWall) return
        const k = `${nx},${nz},${cy}`
        if (!total.has(k) || seen.has(k)) return
        seen.add(k)
        queue.push(k)
      }
      step(gx + 1, gz, wallV(gx + 1, gz, cy))
      step(gx - 1, gz, wallV(gx, gz, cy))
      step(gx, gz + 1, wallH(gx, gz + 1, cy))
      step(gx, gz - 1, wallH(gx, gz, cy))
      for (const n of linksFrom.get(cur) || []) {
        if (total.has(n) && !seen.has(n)) {
          seen.add(n)
          queue.push(n)
        }
      }
    }
    expect(seen.size).toBe(total.size)
  })
})
