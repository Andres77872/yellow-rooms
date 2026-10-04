import { describe, expect, it, vi } from 'vitest'
import { CHUNK, ZONE_OFFICE } from '../../constants.js'
import { ChunkData } from '../../ChunkData.js'
import { worldConfigForFamily } from '../../mapFamily.js'
import { COLUMN_STANDARD, PASSAGE_WALL } from '../../mapTypes.js'
import { auditLayeredPatch } from '../../audit.js'
import { graphComponents, walkGraph } from '../../tiles/simulate.js'
import { forcedFamilyConfig } from '../forced.js'
import { componentPartition, proveReachable, toBox, toCell, windowConnectivity, worldSource } from '../reach.js'
import { STUB_EXIT_CELL, STUB_SPAWN_CELL, STUB_WORLD_ID } from './stubWorld.js'

// STUB_WORLD_ID runs the §12.0 stub program in this file, whatever its real
// family has become (./stubWorld.js).
vi.mock('../generators.js', (orig) => import('./stubWorld.js').then((m) => m.mockGenerators(orig)))
vi.mock('../planners.js', (orig) => import('./stubWorld.js').then((m) => m.mockPlanners(orig)))

// §8.3: the reachability helpers against the layered audit's own graph. The
// component partition of walkGraph (packed keys) over a world source must
// equal auditLayeredPatch's on the stub world and on 3 legacy windows, and
// the lazy proveReachable must agree with it pair by pair.

const sizesOf = (source, b) => graphComponents(walkGraph(source, b)).map((c) => c.size).sort((x, y) => y - x)

// walkGraph's partition in componentPartition's canonical form: each
// component as its sorted "gx,gz,cy" keys, components sorted by first key.
function graphPartition(graph) {
  const seen = new Set()
  const out = []
  for (const [k, n] of graph.nodes) {
    if (seen.has(k)) continue
    seen.add(k)
    const comp = []
    const stack = [n]
    while (stack.length) {
      const cur = stack.pop()
      comp.push(`${cur.gx},${cur.gz},${cur.cy}`)
      for (const [nk] of graph.neighbors(cur)) {
        if (seen.has(nk)) continue
        seen.add(nk)
        stack.push(graph.nodes.get(nk))
      }
    }
    out.push(comp.sort())
  }
  return out.sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))
}
const auditOf = (source, b) => auditLayeredPatch(source.chunkAt, b.x0, b.y0, b.z0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1)

const WINDOWS = [
  [`stub (${STUB_WORLD_ID})`, forcedFamilyConfig(STUB_WORLD_ID), 11, { x0: -2, x1: 2, z0: -2, z1: 1, y0: -1, y1: 1 }],
  ['office', worldConfigForFamily('office'), 0x5eed, { x0: -1, x1: 1, z0: -1, z1: 1, y0: 0, y1: 1 }],
  ['hotel', worldConfigForFamily('hotel'), 777, { x0: 0, x1: 2, z0: -1, z1: 0, y0: -1, y1: 0 }],
  ['sewer', worldConfigForFamily('sewer'), 1, { x0: -1, x1: 1, z0: 0, z1: 1, y0: 0, y1: 1 }],
]

describe('reach oracle', () => {
  it('worldSource memoises generateChunk and shares a cache', () => {
    const cache = new Map()
    const a = worldSource(3, forcedFamilyConfig(STUB_WORLD_ID), { cache })
    const d = a.chunkAt(1, 0, 2)
    expect(a.chunkAt(1, 0, 2)).toBe(d)
    expect(worldSource(3, forcedFamilyConfig(STUB_WORLD_ID), { cache }).chunkAt(1, 0, 2)).toBe(d)
    // Lines are read from their owner chunk: V line gx = 14 is chunk 1's West line.
    expect(a.wallVAt(CHUNK, 0, 2 * CHUNK + 6)).toEqual({ wall: d.vAt(0, 6), passage: expect.any(Number), feature: expect.any(Number) })
    expect(a.wallVAt(CHUNK, 0, 2 * CHUNK + 2).wall).toBe(d.vAt(0, 2))
    expect(a.wallHAt(CHUNK + 6, 0, 2 * CHUNK).wall).toBe(d.hAt(6, 0))
    expect(toBox({ chunks: { x0: 1, z0: 2, x1: 3, z1: 4 }, cy: [-1, 0] })).toEqual({ x0: 1, z0: 2, x1: 3, z1: 4, y0: -1, y1: 0 })
    expect(toCell({ cx: 2, cz: -1, lx: 3, lz: 4 })).toEqual({ gx: 31, gz: -10, cy: 0 })
  })

  for (const [name, config, seed, box] of WINDOWS) {
    it(`walkGraph partition equals auditLayeredPatch: ${name}`, () => {
      const source = worldSource(seed, config)
      const audit = auditOf(source, box)
      expect(audit.invalidCanonicalLinks).toBe(0)
      expect(audit.walkableCells).toBeGreaterThan(0)
      expect(sizesOf(source, box)).toEqual(audit.componentSizes)
      // The partition itself, not only its size multiset: walkGraph's equals
      // the independent flood over reach.js's lazy edges, cell for cell.
      const graph = walkGraph(source, box)
      const part = componentPartition(source, box)
      expect(part.map((c) => c.length).sort((x, y) => y - x)).toEqual(audit.componentSizes)
      expect(part.reduce((n, c) => n + c.length, 0)).toBe(audit.walkableCells)
      expect(graphPartition(graph)).toEqual(part)
    }, 60_000)
  }

  it('the partition check is stronger than the size check: same sizes, different partitions', () => {
    // One open chunk with a 3×3 closet at two different places: the size
    // multisets agree, the partitions do not.
    const world = (x0, z0) => {
      const d = new ChunkData(0, 0, 0, ZONE_OFFICE)
      for (let i = 0; i < 3; i++) {
        d.setV(x0, z0 + i, 1, PASSAGE_WALL)
        d.setV(x0 + 3, z0 + i, 1, PASSAGE_WALL)
        d.setH(x0 + i, z0, 1, PASSAGE_WALL)
        d.setH(x0 + i, z0 + 3, 1, PASSAGE_WALL)
      }
      const at = (gx, gz, f) => (gx >= 0 && gx < CHUNK && gz >= 0 && gz < CHUNK ? f(gx, gz) : 0)
      return {
        chunkAt: (cx, cy, cz) => (cx === 0 && cy === 0 && cz === 0 ? d : null),
        wallVAt: (gx, cy, gz) => ({ wall: at(gx, gz, (x, z) => d.vAt(x, z)) }),
        wallHAt: (gx, cy, gz) => ({ wall: at(gx, gz, (x, z) => d.hAt(x, z)) }),
      }
    }
    const box = { x0: 0, x1: 0, z0: 0, z1: 0, y0: 0, y1: 0 }
    const a = world(1, 1)
    const b = world(6, 6)
    expect(sizesOf(a, box)).toEqual(sizesOf(b, box))
    expect(sizesOf(a, box)).toEqual([CHUNK * CHUNK - 9, 9])
    expect(componentPartition(a, box)).toEqual(graphPartition(walkGraph(a, box)))
    expect(componentPartition(b, box)).toEqual(graphPartition(walkGraph(b, box)))
    expect(componentPartition(a, box)).not.toEqual(componentPartition(b, box))
  })

  it('proveReachable agrees with the partition pair by pair (stub world and office)', () => {
    for (const [, config, seed, box] of [WINDOWS[0], WINDOWS[1]]) {
      const source = worldSource(seed, config)
      const graph = walkGraph(source, box)
      const label = new Map()
      let id = 0
      for (const [k, n] of graph.nodes) {
        if (label.has(k)) continue
        const stack = [n]
        label.set(k, id)
        while (stack.length) {
          const cur = stack.pop()
          for (const [nk] of graph.neighbors(cur)) {
            if (label.has(nk)) continue
            label.set(nk, id)
            stack.push(graph.nodes.get(nk))
          }
        }
        id++
      }
      const nodes = [...graph.nodes.entries()]
      for (let i = 0; i < 24; i++) {
        const [ka, a] = nodes[(i * 7919) % nodes.length]
        const [kb, b] = nodes[(i * 104729 + 13) % nodes.length]
        const r = proveReachable(source, a, b, box)
        expect(r.ok, `${a.gx},${a.gz},${a.cy} → ${b.gx},${b.gz},${b.cy}`).toBe(label.get(ka) === label.get(kb))
        if (r.ok) expect(r.steps).toBeGreaterThanOrEqual(Math.abs(a.gx - b.gx) + Math.abs(a.gz - b.gz) > 0 ? 1 : 0)
      }
    }
  }, 60_000)

  it('the stub world: spawn reaches the exit anchor; outside the box it does not', () => {
    const source = worldSource(5, forcedFamilyConfig(STUB_WORLD_ID))
    const spawn = STUB_SPAWN_CELL
    const exit = { gx: STUB_EXIT_CELL.cx * CHUNK + STUB_EXIT_CELL.lx, gz: STUB_EXIT_CELL.lz, cy: 0 }
    const r = proveReachable(source, spawn, exit, { chunks: { x0: -1, z0: -1, x1: 7, z1: 1 }, cy: [0, 0] })
    expect(r.ok).toBe(true)
    expect(r.steps).toBe(6 * CHUNK)
    expect(proveReachable(source, spawn, exit, { x0: 0, z0: 0, x1: 5, z1: 0, y0: 0, y1: 0 })).toMatchObject({ ok: false, reason: 'to-not-walkable' })
    expect(proveReachable(source, spawn, { gx: 0, gz: 0, cy: 0 }, { x0: 0, z0: 0, x1: 1, z1: 0, y0: 0, y1: 0 })).toMatchObject({ ok: false, reason: 'to-not-walkable' })
    expect(proveReachable(source, spawn, exit, { x0: -1, z0: -1, x1: 7, z1: 1, y0: 0, y1: 0 }, { maxNodes: 10 })).toMatchObject({ ok: false, reason: 'max-nodes' })
  })

  it('windowConnectivity: stub world is one graph; stranded and sealed components are caught', () => {
    const source = worldSource(5, forcedFamilyConfig(STUB_WORLD_ID))
    const inner = { x0: -1, x1: 1, z0: -1, z1: 1, y0: 0, y1: 0 }
    const outer = { x0: -2, x1: 2, z0: -2, z1: 2, y0: -1, y1: 1 }
    const ok = windowConnectivity(source, inner, outer, { cx: 0, cz: 0, lx: 6, lz: 6 })
    expect(ok).toMatchObject({ ok: true, reason: null, components: 1, stranded: [], sealed: [] })
    expect(ok.walkable).toBeGreaterThan(0)
    expect(windowConnectivity(source, inner, outer, { cx: 0, cz: 0, lx: 0, lz: 0 }).reason).toBe('spawn-not-walkable')

    // A hand-built world: two open chunks split by a wall, plus a sealed closet.
    const chunks = new Map()
    for (let cx = -2; cx <= 2; cx++) {
      for (let cz = -2; cz <= 2; cz++) {
        const d = new ChunkData(cx, 0, cz, ZONE_OFFICE)
        chunks.set(`${cx},0,${cz}`, d)
      }
    }
    const wallLine = (cx) => { for (let cz = -2; cz <= 2; cz++) for (let z = 0; z < CHUNK; z++) chunks.get(`${cx},0,${cz}`).setV(0, z, 1, PASSAGE_WALL) }
    const hand = {
      chunkAt: (cx, cy, cz) => chunks.get(`${cx},${cy},${cz}`) ?? null,
      wallVAt: (gx, cy, gz) => { const cx = Math.floor(gx / CHUNK); const cz = Math.floor(gz / CHUNK); const d = chunks.get(`${cx},${cy},${cz}`); return { wall: d ? d.vAt(gx - cx * CHUNK, gz - cz * CHUNK) : 0 } },
      wallHAt: (gx, cy, gz) => { const cx = Math.floor(gx / CHUNK); const cz = Math.floor(gz / CHUNK); const d = chunks.get(`${cx},${cy},${cz}`); return { wall: d ? d.hAt(gx - cx * CHUNK, gz - cz * CHUNK) : 0 } },
    }
    const iBox = { x0: -1, x1: 1, z0: -1, z1: 1, y0: 0, y1: 0 }
    const oBox = { x0: -2, x1: 2, z0: -2, z1: 2, y0: 0, y1: 0 }
    expect(windowConnectivity(hand, iBox, oBox, { cx: 0, cz: 0, lx: 6, lz: 6 })).toMatchObject({ ok: true, components: 1 })
    wallLine(1) // the east third is cut off, but reaches the outer ring: stranded
    const cut = windowConnectivity(hand, iBox, oBox, { cx: 0, cz: 0, lx: 6, lz: 6 })
    expect(cut).toMatchObject({ ok: false, reason: 'stranded-components' })
    expect(cut.stranded.length).toBe(1)
    // Remove the cut; wall in a 3×3 closet in chunk (0,0): a sealed pocket of 9 ≤ 24.
    for (let cz = -2; cz <= 2; cz++) for (let z = 0; z < CHUNK; z++) chunks.get(`1,0,${cz}`).setV(0, z, 0)
    const closet = (x0, z0, n) => {
      const d = chunks.get('0,0,0')
      for (let i = 0; i < n; i++) {
        d.setV(x0, z0 + i, 1, PASSAGE_WALL)
        d.setV(x0 + n, z0 + i, 1, PASSAGE_WALL)
        d.setH(x0 + i, z0, 1, PASSAGE_WALL)
        d.setH(x0 + i, z0 + n, 1, PASSAGE_WALL)
      }
    }
    closet(1, 1, 3)
    const pocket = windowConnectivity(hand, iBox, oBox, { cx: 0, cz: 0, lx: 10, lz: 10 })
    expect(pocket).toMatchObject({ ok: true, pockets: [{ size: 9 }] })
    closet(5, 5, 6) // 36 cells > sealedMax
    const sealed = windowConnectivity(hand, iBox, oBox, { cx: 0, cz: 0, lx: 12, lz: 12 })
    expect(sealed).toMatchObject({ ok: false, reason: 'sealed-pockets', sealed: [{ size: 36 }] })
    expect(windowConnectivity(hand, iBox, oBox, { cx: 0, cz: 0, lx: 12, lz: 12 }, { sealedPockets: true }).ok).toBe(true)
    // A walled-off mass cell is not a node; the spawn outside inner is refused.
    chunks.get('0,0,0').setCol(0, 0, COLUMN_STANDARD)
    expect(windowConnectivity(hand, iBox, oBox, { cx: 2, cz: 0, lx: 6, lz: 6 }).reason).toBe('spawn-outside-inner')
  })
})
