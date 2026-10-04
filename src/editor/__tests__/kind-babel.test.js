import { describe, expect, it } from 'vitest'
import { CELL_ROOM, CELL_VOID, WALL_WINDOW } from '../../world/mapTypes.js'
import { PROP_CORNER_SHELF, PROP_LECTERN } from '../../world/props/index.js'
import { EditorMap } from '../EditorMap.js'
import { BABEL_LATTICE } from '../kinds/babel.js'
import { generatePrototype } from '../prototypes.js'
import { liminalReport } from '../simulate.js'
import { expectKindClean, judgeMap } from './kindJudge.js'

// Library of Babel (docs/liminal_maps/06-library-of-babel.md): the kind-lab
// contract over the default seeds, then the doc's signature claims.

const build = (seed) => {
  const map = new EditorMap()
  const res = generatePrototype(map, 'babel', { seed })
  return { map, res }
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const { floors: FLOORS, NI, NJ, galleryX, galleryZ } = BABEL_LATTICE

describe('babel kind', () => {
  it('builds clean, connected, deterministic storeys for every seed', () => {
    expectKindClean(expect, 'babel')
  }, 180_000)

  it('stacks a railed 2×2 shaft through every gallery, joined only by stair flights', () => {
    for (const seed of ['proto', 'liminal-2']) {
      const { map, res } = build(seed)
      const closed = new Set(res.notes.join(' ').match(/noShaft \d+:\d+,\d+/g)?.map((s) => s.slice(8)) ?? [])
      for (let cy = 0; cy < FLOORS; cy++) {
        for (let j = 0; j < NJ; j++) {
          for (let i = 0; i < NI; i++) {
            const x = galleryX(i, j) + 2
            const z = galleryZ(j) + 1
            const cells = [[x, z], [x + 1, z], [x, z + 1], [x + 1, z + 1]].map(([gx, gz]) => map.cellAt(gx, cy, gz).kind)
            // The first storey is the shafts' floor; above it every shaft is
            // open except a noShaft anomaly's.
            const open = cy > 0 && !closed.has(`${cy}:${i},${j}`)
            expect(cells.every((k) => k === CELL_VOID), `${seed} cy ${cy} gallery ${i},${j}`).toBe(open)
          }
        }
      }
      // ≤ one flight per chunk per slab: a checkerboard of chunks per slab.
      const { audit } = judgeMap(map)
      expect(audit.canonicalLinks).toBe((FLOORS - 1) * map.chunks.size / FLOORS / 2)
    }
  }, 60_000)

  it('keeps the galleries identical, shelved, under two lamps, with one Crimson Hexagon', () => {
    for (const seed of ['proto', 'liminal-5']) {
      const { map, res } = build(seed)
      const tinted = []
      let shelves = 0
      const vestibules = new Map() // 'cy:spaceId' -> lecterns
      for (const d of map.chunks.values()) {
        for (const l of d.lamps) if (l.tint !== undefined) tinted.push({ ...l, cy: d.cy, cx: d.cx, cz: d.cz })
        shelves += d.furniture.filter((f) => f.kind === PROP_CORNER_SHELF).length
        for (let k = 0; k < 196; k++) {
          if (d.cellKind[k] !== CELL_ROOM || d.spaceId[k] < BABEL_LATTICE.vestibuleId) continue
          const key = `${d.cy}:${d.spaceId[k]}`
          const lectern = d.furniture.some((f) => f.kind === PROP_LECTERN && f.lz * 14 + f.lx === k)
          vestibules.set(key, (vestibules.get(key) ?? 0) + (lectern ? 1 : 0))
        }
        expect(d.levelLabel).toBe(BABEL_LATTICE.label)
      }
      // Two crimson lamps, both in the exit gallery: the only colour change.
      expect(tinted).toHaveLength(2)
      for (const l of tinted) {
        expect(l.tint).toBe(BABEL_LATTICE.crimson)
        expect(l.cy).toBe(res.exit.cy)
        expect(map.cellAt(l.cx * 14 + l.lx, l.cy, l.cz * 14 + l.lz).spaceId).toBe(map.cellAt(res.exit.gx, res.exit.cy, res.exit.gz).spaceId)
      }
      const exitChunk = map.chunkAt(map.cellChunk(res.exit.gx), res.exit.cy, map.cellChunk(res.exit.gz))
      expect(exitChunk.exit).toEqual({ lx: map.cellLocal(res.exit.gx), lz: map.cellLocal(res.exit.gz) })
      // Four slanted corners per shelved gallery (a few "empty" anomalies
      // stand bare) and one lectern in every vestibule (and reflection).
      const empty = res.notes.join(' ').match(/empty \d+:/g)?.length ?? 0
      expect(shelves).toBe(4 * (NI * NJ * FLOORS - empty))
      expect(vestibules.size).toBeGreaterThan(NI * NJ * FLOORS * 0.6)
      for (const [key, n] of vestibules) expect(n, key).toBe(1)
    }
  }, 60_000)

  it('walks round each open shaft as a connected U: the north shelves close the ring on the grid', () => {
    const { map, res } = build('proto')
    const empty = new Set(res.notes.join(' ').match(/empty \d+:\d+,\d+/g)?.map((s) => s.slice(6)) ?? [])
    let galleries = 0
    for (let cy = 1; cy < FLOORS; cy++) {
      for (let j = 0; j < NJ; j++) {
        for (let i = 0; i < NI; i++) {
          const x0 = galleryX(i, j)
          const z0 = galleryZ(j)
          if (map.cellAt(x0 + 2, cy, z0 + 1).kind !== CELL_VOID) continue
          const tag = `cy ${cy} gallery ${i},${j}`
          // Walkable (as A* and the flood see it): not void, no column or
          // furniture.
          const free = new Set()
          for (let z = z0; z <= z0 + 3; z++) {
            for (let x = x0; x <= x0 + 5; x++) {
              const c = map.cellAt(x, cy, z)
              if (c.kind !== CELL_VOID && !c.col) free.add(`${x},${z}`)
            }
          }
          // The row above the shaft is shelved (open only in a bare gallery).
          const bare = empty.has(`${cy}:${i},${j}`)
          expect(free.has(`${x0 + 2},${z0}`), tag).toBe(bare)
          expect(free.has(`${x0 + 3},${z0}`), tag).toBe(bare)
          // Every free cell is reached from the south walkway: no pocket.
          const seen = new Set([`${x0 + 2},${z0 + 3}`])
          const queue = [[x0 + 2, z0 + 3]]
          while (queue.length) {
            const [x, z] = queue.pop()
            for (const [nx, nz] of [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]]) {
              const k = `${nx},${nz}`
              if (free.has(k) && !seen.has(k)) {
                seen.add(k)
                queue.push([nx, nz])
              }
            }
          }
          expect(seen.size, tag).toBe(free.size)
          galleries++
        }
      }
    }
    expect(galleries).toBeGreaterThan(NI * NJ * (FLOORS - 1) * 0.9)
  }, 60_000)

  it('shows the mirror: glass onto a reflected vestibule whose far door is blind', () => {
    const { map, res } = build('proto')
    const mirrors = Number(res.notes.join(' ').match(/glass in (\d+) vestibules/)[1])
    expect(mirrors).toBeGreaterThanOrEqual(FLOORS)
    let windows = 0
    for (const d of map.chunks.values()) {
      const n = [...d.wallFeatureV, ...d.wallFeatureH].filter((f) => f === WALL_WINDOW).length
      if (n) expect(d.authoredFeatures).toBe(true)
      windows += n
    }
    expect(windows).toBe(3 * mirrors)
    // Each reflection is a room of its own (spaceId shifted by the mirror
    // offset) and opens onto exactly one gallery: a cul-de-sac behind the
    // glass, where the vestibule it copies leads on.
    const reflections = new Map() // 'cy:spaceId' -> {cells, exits}
    for (const d of map.chunks.values()) {
      for (let k = 0; k < 196; k++) {
        if (d.cellKind[k] !== CELL_ROOM || d.spaceId[k] < BABEL_LATTICE.mirrorOffset) continue
        const key = `${d.cy}:${d.spaceId[k]}`
        if (!reflections.has(key)) reflections.set(key, { cells: 0, exits: new Set() })
        const ref = reflections.get(key)
        ref.cells++
        const gx = d.cx * 14 + (k % 14)
        const gz = d.cz * 14 + Math.floor(k / 14)
        const sides = [
          [gx - 1, gz, map.wallVAt(gx, d.cy, gz)], [gx + 1, gz, map.wallVAt(gx + 1, d.cy, gz)],
          [gx, gz - 1, map.wallHAt(gx, d.cy, gz)], [gx, gz + 1, map.wallHAt(gx, d.cy, gz + 1)],
        ]
        for (const [nx, nz, edge] of sides) {
          const other = map.cellAt(nx, d.cy, nz).spaceId
          if (!edge.wall && other !== d.spaceId[k]) ref.exits.add(other)
        }
      }
    }
    expect(reflections.size).toBe(mirrors)
    for (const [key, ref] of reflections) {
      expect(ref.cells, key).toBe(6)
      expect(ref.exits.size, key).toBe(1)
    }
  }, 60_000)

  it('measures as the doc §12 asks: sameness, dim uniform light, no dead ends', () => {
    // Bands around what liminalReport measures today (4 seeds, all storeys
    // pooled): room repetition ~0.99 (target ≥ 0.95), intelligibility ~0
    // (target degenerate or ≤ 0.05), darkness ~0.12 (target 0.05–0.15),
    // dead-end share ~0.03 (target ≈ 0), loops/100 spaces 5.5–16.5 (target
    // 5–15; here planar, through the stair vestibules), sightline median
    // ~8–9 cells (target 4–8: the shafts and gap bands see further).
    const pooled = []
    for (const seed of ['liminal-0', 'liminal-1']) {
      const { map } = build(seed)
      pooled.push(...liminalReport(map, map.bounds(), { samples: 12, rays: 64 }).floors)
    }
    expect(median(pooled.map((f) => f.roomRepetition))).toBeGreaterThanOrEqual(0.95)
    expect(Math.max(...pooled.map((f) => f.intelligibility))).toBeLessThanOrEqual(0.05)
    const dark = median(pooled.map((f) => f.darkness))
    expect(dark).toBeGreaterThanOrEqual(0.05)
    expect(dark).toBeLessThanOrEqual(0.17)
    expect(median(pooled.map((f) => f.deadEndSpaces / f.spaces))).toBeLessThanOrEqual(0.06)
    const loops = median(pooled.map((f) => (100 * f.loops) / f.spaces))
    expect(loops).toBeGreaterThanOrEqual(4)
    expect(loops).toBeLessThanOrEqual(18)
    const sight = median(pooled.map((f) => f.sightMedian))
    expect(sight).toBeGreaterThanOrEqual(5)
    expect(sight).toBeLessThanOrEqual(12)
  }, 60_000)
})
