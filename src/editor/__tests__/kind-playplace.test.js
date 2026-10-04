import { describe, expect, it } from 'vitest'
import {
  CELL_BRIDGE,
  SPACE_ROLE_DINING,
  WALL_RAIL,
  WALL_WINDOW,
} from '../../world/mapTypes.js'
import {
  PROP_ARCADE,
  PROP_BENCH,
  PROP_CHILD_CHAIR,
  PROP_CHILD_TABLE,
  PROP_MASCOT,
  PROP_PUNCH_BAG,
} from '../../world/props/index.js'
import { POD, TUBE, inRect, kindLayout } from '../../world/families/playplace/geometry.js'
import { cellWalkable } from '../../world/tiles/holeMasks.js'
import { EditorMap, seedFromText } from '../EditorMap.js'
import { PLAY_THEMES, RED_PIT_TINT } from '../kinds/playplace.js'
import { generatePrototype } from '../prototypes.js'
import { DARK_LEVEL, lightField, liminalReport, nodeKey, walkGraph } from '../simulate.js'
import { KIND_SEEDS, expectKindClean, judgeMap } from './kindJudge.js'

// Playplace (docs/liminal_maps/10-playplace.md): the kind-lab contract over
// the default seeds, then the doc's claims as the sample builds them. The
// kind draws one procedural module of the family's grammar per seed
// (geometry.js kindLayout: one or two halls, always one three storeys tall,
// a crawl block on the deck, corridors and rooms in the rest; no seams), so
// the claims are checked against that seed's own plan, not fixed cells.

const build = (seed) => {
  const map = new EditorMap()
  const res = generatePrototype(map, 'playplace', { seed })
  return { map, res, lay: kindLayout(seedFromText(seed)) }
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const allFurniture = (map) => [...map.chunks.values()].flatMap((d) => d.furniture.map((f) => ({
  ...f, cy: d.cy, gx: d.cx * 14 + f.lx, gz: d.cz * 14 + f.lz,
})))
const hallsOf = (map) => [...new Set([...map.chunks.values()].map((d) => d.structure).filter(Boolean))]
const N = 28
// A wider sweep than the kind lab's seeds: the grammar's rolls (hall types,
// sizes, the crawl lattice, the rooms) differ per seed.
const SWEEP = [...KIND_SEEDS, ...Array.from({ length: 40 }, (_, i) => `sweep-${i}`)]

describe('playplace kind', () => {
  it('builds clean, connected, deterministic storeys for every seed', () => {
    expectKindClean(expect, 'playplace')
  }, 180_000)

  it('raises one three-storey office hall among one or two: flights on both slabs, 1-wide net bridges railed on both flanks, the pit open to the sky but under its bridges, where its lamps hang', () => {
    const types = new Set()
    for (const seed of ['proto', 'liminal-1', 'liminal-5', 'sweep-3', 'sweep-10']) {
      const { map, res, lay } = build(seed)
      const at = `playplace ${seed}`
      const halls = hallsOf(map)
      expect(halls.length, at).toBe(lay.halls.length)
      expect([1, 2], at).toContain(halls.length)
      for (const h of lay.halls) types.add(h.type)
      expect(halls.every((h) => h.family === 'office' && h.baseCy === 0), at).toBe(true)
      const tall = halls.filter((h) => h.levelCount === 3)
      expect(tall, at).toHaveLength(1)
      // The catalog's own flights are the climbs: one per slab.
      expect(new Set(tall[0].verticalLinks.map((l) => l.lowerCy)), at).toEqual(new Set([0, 1]))
      for (const hall of halls) {
        for (let k = 1; k < hall.levelCount; k++) {
          for (const br of hall.levels[k].bridges) {
            expect(br.x0 === br.x1 || br.z0 === br.z1, `${at} level ${k}`).toBe(true)
            const along = br.z0 === br.z1
            for (let t = along ? br.x0 : br.z0; t <= (along ? br.x1 : br.z1); t++) {
              const flanks = along
                ? [map.wallHAt(t, k, br.z0), map.wallHAt(t, k, br.z0 + 1)]
                : [map.wallVAt(br.x0, k, t), map.wallVAt(br.x0 + 1, k, t)]
              expect(flanks.every((e) => e.wall === 1 && e.feature === WALL_RAIL), `${at} level ${k} @${t}`).toBe(true)
              const [gx, gz] = along ? [t, br.z0] : [br.x0, t]
              expect(map.cellAt(gx, k, gz).kind, at).toBe(CELL_BRIDGE)
            }
          }
        }
        // A pit (a deck void over the hall floor) is open to the sky except
        // under the deck's bridges; its lamps hang only there.
        const plan = lay.halls.find((h) => h.slot === hall.slot)
        if (plan.type === 'court' || plan.type === 'fortress') continue
        const bridges = hall.levels[1].bridges
        for (const pit of hall.levels[1].voids) {
          let lit = 0
          for (let gz = pit.z0; gz <= pit.z1; gz++) {
            for (let gx = pit.x0; gx <= pit.x1; gx++) {
              const c = map.cellAt(gx, 0, gz)
              const under = bridges.some((b) => inRect(b, gx, gz))
              expect(c.chunk.hasCeilHole(map.cellLocal(gx), map.cellLocal(gz)), `${at} ${gx},${gz}`).toBe(!under)
              const lamp = c.chunk.lamps.find((l) => l.lx === map.cellLocal(gx) && l.lz === map.cellLocal(gz))
              if (lamp?.lit) {
                expect(under, `${at} lamp ${gx},${gz}`).toBe(true)
                lit++
              }
            }
          }
          if (bridges.some((b) => pit.x0 <= b.x1 && b.x0 <= pit.x1 && pit.z0 <= b.z1 && b.z0 <= pit.z1)) expect(lit, at).toBeGreaterThanOrEqual(1)
        }
      }
      // Spawn on the first hall's floor by its main gate, on a free cell.
      expect(res.spawn.cy, at).toBe(0)
      expect(map.cellAt(res.spawn.gx, 0, res.spawn.gz).col, at).toBe(0)
    }
    expect(types.size).toBeGreaterThanOrEqual(2)
  })

  it('threads a 1-wide crawl-tube lattice through the deck: ≥ 1 tube-only loop, ≥ 2 mouths, its bubble windows built, lit only at pods', () => {
    const shapes = new Set()
    for (const seed of ['proto', 'lobby', 'liminal-3', 'sweep-7']) {
      const { map, lay } = build(seed)
      const at = `playplace ${seed}`
      const t = lay.storeys[1].tubes
      expect(t, at).toBeTruthy()
      shapes.add(`${t.nx}x${t.nz}`)
      const st = lay.storeys[1]
      const tubeCells = []
      for (let gz = t.rect.z0; gz <= t.rect.z1; gz++) for (let gx = t.rect.x0; gx <= t.rect.x1; gx++) if ([TUBE, POD].includes(st.cells[gz * N + gx])) tubeCells.push([gx, gz])
      const { box } = judgeMap(map)
      const g = walkGraph(map, { ...box, y0: 1, y1: 1 }, { vertical: false })
      const key = ([gx, gz]) => `${gx},${gz}`
      const inTube = new Set(tubeCells.map(key))
      const nodeOf = new Map([...g.nodes.values()].map((n) => [`${n.gx},${n.gz}`, n]))
      for (const c of tubeCells) expect(nodeOf.has(key(c)), `${at} tube cell ${key(c)} walkable`).toBe(true)
      // 1-wide: no 2×2 block of tube cells.
      for (const [gx, gz] of tubeCells) {
        const block = [[1, 0], [0, 1], [1, 1]].every(([dx, dz]) => inTube.has(`${gx + dx},${gz + dz}`))
        expect(block, `${at} ${gx},${gz}`).toBe(false)
      }
      // Doc §12 "≥ 1 crawl-only loop": the cyclomatic number of the graph of
      // tube cells alone (E − V + C) is the plan's loop count, at least 1.
      const near = (c) => g.neighbors(nodeOf.get(key(c))).map(([k]) => g.nodes.get(k)).filter((m) => inTube.has(`${m.gx},${m.gz}`))
      let edges = 0
      for (const c of tubeCells) edges += near(c).length
      edges /= 2
      const seen = new Set()
      let comps = 0
      for (const c of tubeCells) {
        if (seen.has(key(c))) continue
        comps++
        const queue = [c]
        seen.add(key(c))
        while (queue.length) {
          for (const m of near(queue.pop())) {
            if (seen.has(`${m.gx},${m.gz}`)) continue
            seen.add(`${m.gx},${m.gz}`)
            queue.push([m.gx, m.gz])
          }
        }
      }
      expect(comps, at).toBe(1)
      expect(edges - tubeCells.length + comps, at).toBe(t.loops)
      expect(t.loops, at).toBeGreaterThanOrEqual(1)
      expect(t.mouths.length, at).toBeGreaterThanOrEqual(2)
      for (const w of t.windows) {
        const [ax, az] = w.edge
        const [bx, bz] = w.out
        const e = ax !== bx ? map.wallVAt(Math.max(ax, bx), 1, az) : map.wallHAt(ax, 1, Math.max(az, bz))
        expect(e.feature, `${at} window ${ax},${az}`).toBe(WALL_WINDOW)
      }
      // Lamps on tube cells only at the pods.
      const pods = new Set(t.pods.map((p) => `${p.gx},${p.gz}`))
      const lamps = [...map.chunks.values()].filter((d) => d.cy === 1)
        .flatMap((d) => d.lamps.filter((l) => l.lit).map((l) => `${d.cx * 14 + l.lx},${d.cz * 14 + l.lz}`))
        .filter((k) => inTube.has(k))
      expect(lamps.every((k) => pods.has(k)), at).toBe(true)
    }
    expect(shapes.size).toBeGreaterThanOrEqual(2)
  })

  it('dresses the module with the playplace pack: party rooms round one child table, an arcade row, at most one mascot', () => {
    for (const seed of ['proto', 'liminal-2', 'sweep-14']) {
      const { map } = build(seed)
      const at = `playplace ${seed}`
      const furn = allFurniture(map)
      const of = (kind) => furn.filter((f) => f.kind === kind)
      const parties = map.rooms.filter((r) => r.role === SPACE_ROLE_DINING)
      expect(parties.length, at).toBeGreaterThanOrEqual(1)
      let seated = 0
      // A party room holds one child table in its centre cell with chairs
      // in the cells beside it (four where its doors leave four free in a
      // row), one record per cell, and nothing else.
      for (const room of parties) {
        const inside = furn.filter((f) => f.cy === room.cy && f.gx >= room.x0 && f.gx <= room.x1 && f.gz >= room.z0 && f.gz <= room.z1)
        expect(inside.every((f) => f.kind === PROP_CHILD_TABLE || f.kind === PROP_CHILD_CHAIR), at).toBe(true)
        expect(new Set(inside.map((f) => `${f.gx},${f.gz}`)).size, at).toBe(inside.length)
        const tables = inside.filter((f) => f.kind === PROP_CHILD_TABLE)
        expect(tables.length, at).toBeLessThanOrEqual(1)
        if (!tables.length) continue
        seated++
        expect([tables[0].gx, tables[0].gz], at).toEqual([room.x0 + 1, room.z0 + 1])
        expect(inside.length - 1, at).toBeLessThanOrEqual(4)
        for (const f of inside) expect(Math.max(Math.abs(f.gx - tables[0].gx), Math.abs(f.gz - tables[0].gz)), at).toBeLessThanOrEqual(1)
      }
      expect(seated / parties.length, at).toBeGreaterThanOrEqual(0.5)
      // Moving a party table in the editor leaves its chairs where they are.
      const room = parties.find((r) => furn.some((f) => f.kind === PROP_CHILD_TABLE && f.gx === r.x0 + 1 && f.gz === r.z0 + 1 && f.cy === r.cy))
      const chairs = of(PROP_CHILD_CHAIR).length
      const to = [[room.x0 + 2, room.z0], [room.x0, room.z0], [room.x0 + 2, room.z0 + 2], [room.x0, room.z0 + 2]].find(([x, z]) => !map.cellAt(x, room.cy, z).col)
      expect(to, at).toBeTruthy()
      expect(map.moveFurniture(room.x0 + 1, room.cy, room.z0 + 1, to[0], to[1]), at).toBeTruthy()
      expect(allFurniture(map).filter((f) => f.kind === PROP_CHILD_CHAIR).length, at).toBe(chairs)
      expect(of(PROP_ARCADE).length, at).toBeGreaterThanOrEqual(4)
      expect(of(PROP_MASCOT).length, at).toBeLessThanOrEqual(1)
    }
  })

  it('furnishes every seed of the sweep without plugging a bridge or stacking a cell; the notes count what stands', () => {
    let mascots = 0
    for (const seed of SWEEP) {
      const { map, res } = build(seed)
      const at = `playplace ${seed}`
      expect(res.ok, at).toBe(true)
      const furn = allFurniture(map)
      // One record per occupied cell (ChunkData's contract; the editor moves
      // and deletes furniture cell by cell).
      const cells = new Set(furn.map((f) => `${f.cy},${f.gx},${f.gz}`))
      expect(cells.size, at).toBe(furn.length)
      // No piece stands at a net bridge's mouth, and every storey stays one walk.
      for (const f of furn) {
        const mouth = [[0, -1], [1, 0], [0, 1], [-1, 0]].some(([dx, dz]) => map.cellAt(f.gx + dx, f.cy, f.gz + dz).kind === CELL_BRIDGE)
        expect(mouth, `${at} kind ${f.kind} at ${f.cy}:${f.gx},${f.gz}`).toBe(false)
      }
      const { floors, volume } = judgeMap(map)
      expect(floors.map((f) => f.length), at).toEqual([1, 1, 1])
      expect(volume, at).toBe(1)
      const count = (kind) => furn.filter((f) => f.kind === kind).length
      expect(res.notes[3], at).toContain(`${count(PROP_CHILD_TABLE)} party tables`)
      expect(res.notes[3], at).toContain(`${count(PROP_ARCADE)} arcade cabinets`)
      expect(res.notes[3], at).toContain(`${count(PROP_PUNCH_BAG)} punch bags`)
      expect(res.notes[3], at).toContain(`${count(PROP_BENCH)} empty parents' benches`)
      expect(count(PROP_PUNCH_BAG), at).toBeGreaterThanOrEqual(2)
      expect(count(PROP_BENCH), at).toBeGreaterThanOrEqual(2)
      mascots += count(PROP_MASCOT)
    }
    expect(mascots / SWEEP.length).toBeGreaterThan(0.9)
  }, 120_000)

  it('plates and tints: cheerful level plates, themed hall tubes, a red pit on some seeds', () => {
    const themes = new Set()
    let redPits = 0
    const tints = new Set([...PLAY_THEMES.map((t) => t.tint), RED_PIT_TINT])
    for (const seed of ['proto', 'lobby', 'same', 'liminal-0', 'liminal-1', 'liminal-2', 'liminal-3', 'liminal-4']) {
      const { map, lay } = build(seed)
      const at = `playplace ${seed}`
      const labels = (cy) => new Set([...map.chunks.values()].filter((d) => d.cy === cy).map((d) => d.levelLabel))
      expect(labels(0), at).toEqual(new Set(['PLAy']))
      expect(labels(1), at).toEqual(new Set(['FUn']))
      expect(labels(2), at).toEqual(new Set(['yAy']))
      // Every lit tube inside a hall's box is in a hall theme's tint (or the
      // red pit's).
      for (const h of lay.halls) {
        for (let cy = 0; cy < h.L; cy++) {
          const inBox = [...map.chunks.values()].filter((d) => d.cy === cy).flatMap((d) => d.lamps.filter((l) => l.lit && inRect(h.box, d.cx * 14 + l.lx, d.cz * 14 + l.lz)))
          expect(inBox.length, `${at} hall ${h.slot} storey ${cy}`).toBeGreaterThanOrEqual(1)
          expect(inBox.every((l) => tints.has(l.tint)), `${at} hall ${h.slot} storey ${cy}`).toBe(true)
          for (const l of inBox) if (l.tint !== RED_PIT_TINT) themes.add(l.tint)
        }
      }
      if ([...map.chunks.values()].some((d) => d.cy === 0 && d.lamps.some((l) => l.tint === RED_PIT_TINT))) redPits++
    }
    expect(themes.size).toBeGreaterThanOrEqual(2)
    expect(redPits).toBeGreaterThanOrEqual(1)
  })

  it('measures the sample (doc §12): halls bright, the whole sample lit; sightlines and loops', () => {
    // report:liminal settings (samples 24, rays 96). Measured over these
    // seeds: whole-storey darkness ≈ 0.01–0.09 (floor), 0.05–0.17 (deck),
    // 0–0.08 (top deck), median ≈ 0.06; the halls lit end to end, the rooms
    // and corridors by the sight-aware covers (light.js) under the world's
    // lamp density, so the doc's "0 with lights on" is approached, not met:
    // a small store room or a corridor corner can stay dim.
    // Sightline median ≈ 8.6 cells (doc: isovist median 4–8; the halls and
    // nets keep it a little above).
    const floors = []
    let hallWalk = 0
    let hallDark = 0
    for (const seed of ['liminal-0', 'liminal-1', 'proto', 'lobby']) {
      const { map, lay } = build(seed)
      const { box } = judgeMap(map)
      floors.push(...liminalReport(map, box, { samples: 24, rays: 96 }).floors)
      // The hall boxes: under 5% dark pooled, no hall storey over 25%.
      for (const h of lay.halls) {
        for (let cy = 0; cy < h.L; cy++) {
          const field = lightField(map, box, cy)
          let walk = 0
          let dark = 0
          for (let gz = h.bounds.z0; gz <= h.bounds.z1; gz++) {
            for (let gx = h.bounds.x0; gx <= h.bounds.x1; gx++) {
              const c = map.cellAt(gx, cy, gz)
              if (!c.chunk || !cellWalkable(c.chunk, map.cellLocal(gx), map.cellLocal(gz))) continue
              walk++
              if ((field.level.get(nodeKey(gx, gz, cy)) ?? 0) < DARK_LEVEL) dark++
            }
          }
          expect(dark / Math.max(1, walk), `${seed} hall ${h.slot} storey ${cy}`).toBeLessThan(0.25)
          hallWalk += walk
          hallDark += dark
        }
      }
    }
    expect(hallDark / hallWalk).toBeLessThan(0.05)
    expect(median(floors.map((f) => f.darkness))).toBeLessThanOrEqual(0.12)
    expect(Math.max(...floors.map((f) => f.darkness))).toBeLessThanOrEqual(0.25)
    expect(median(floors.map((f) => f.sightMedian))).toBeGreaterThanOrEqual(5)
    expect(median(floors.map((f) => f.sightMedian))).toBeLessThanOrEqual(10)
    // Loops on every storey of every seed (doc: ≥ 2 per hall).
    for (const seed of SWEEP) {
      const { map } = build(seed)
      const loops = liminalReport(map, judgeMap(map).box, { samples: 24, rays: 96 }).floors.map((f) => f.loops)
      expect(loops.every((n) => n >= 2), `playplace ${seed} loops ${loops}`).toBe(true)
    }
  }, 120_000)
})
