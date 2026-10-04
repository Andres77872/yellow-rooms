import { describe, expect, it } from 'vitest'
import { CHUNK } from '../../world/constants.js'
import { FURN_CABINET, FURN_WARDROBE } from '../../world/rooms/catalog.js'
import { COLUMN_FURNITURE, SPACE_ROLE_BATHROOM } from '../../world/mapTypes.js'
import {
  PROP_BANDAI,
  PROP_KICKBOARD,
  PROP_LIFEGUARD_CHAIR,
  PROP_LOST_BIN,
  PROP_LOUNGER,
  PROP_STARTING_BLOCK,
} from '../../world/props/index.js'
import { EditorMap } from '../EditorMap.js'
import { POOL_TINT } from '../kinds/poolrooms.js'
import { generatePrototype } from '../prototypes.js'
import { DARK_LEVEL, lightField, liminalReport, nodeKey, walkGraph } from '../simulate.js'
import { expectKindClean, judgeMap, KIND_SEEDS } from './kindJudge.js'

// Poolrooms (docs/liminal_maps/01-poolrooms.md): the kind-lab contract over
// the default seeds, then the doc's signature claims as built today (no
// water: basins are storey-deep catalog voids over a drained basin floor).
// The kind is a procedural sample of the family's tile grammar: every seed
// draws its own pool program (a natatio vault, a pit, maybe lap halls and a
// plunge) and its own deck/basin partition, so these checks hold per seed
// rather than pinning one layout.

const build = (seed) => {
  const map = new EditorMap()
  const res = generatePrototype(map, 'poolrooms', { seed })
  return { map, res }
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const POOL_TYPES = new Set(['natatio', 'lapHall', 'pitRoom', 'plunge'])

// The pool volumes, read back from the chunks that carry them.
function pools(map) {
  const out = new Map()
  for (const d of map.chunks.values()) if (d.structure) out.set(d.structure.id, d.structure)
  return [...out.values()]
}
const ofType = (map, type) => pools(map).filter((s) => s.type === type)
// Basin-floor cells under a pool void (the "deep" cells).
function poolCells(s) {
  const v = s.levels[1].voids[0]
  const cells = []
  for (let gz = v.z0; gz <= v.z1; gz++) for (let gx = v.x0; gx <= v.x1; gx++) cells.push([gx, gz])
  return cells
}
const allFurniture = (map) => [...map.chunks.values()].flatMap((d) => d.furniture.map((f) => ({ ...f, cy: d.cy, gx: d.cx * CHUNK + f.lx, gz: d.cz * CHUNK + f.lz })))

describe('poolrooms kind', () => {
  it('builds clean, connected, deterministic storeys for every seed', () => {
    expectKindClean(expect, 'poolrooms')
  }, 180_000)

  it('sinks tower catalog basins a storey deep, with stairs down to the basin floor and lying depth plates', () => {
    for (const seed of KIND_SEEDS) {
      const { map, res } = build(seed)
      const at = `poolrooms ${seed}`
      const all = pools(map)
      const types = all.map((s) => s.type)
      expect(all.length, at).toBeGreaterThanOrEqual(2)
      expect(types.every((t) => POOL_TYPES.has(t)), at).toBe(true)
      // The sample always keeps one natatio vault and one pit.
      expect(types.filter((t) => t === 'natatio').length, at).toBe(1)
      expect(types.filter((t) => t === 'pitRoom').length, at).toBe(1)
      for (const s of all) {
        expect(s.family, at).toBe('tower')
        expect(s.baseCy, at).toBe(0)
        // Every pool's own flight lands on its basin floor.
        expect(s.verticalLinks.some((l) => l.lowerCy === 0), `${at} ${s.type}`).toBe(true)
        for (const [gx, gz] of poolCells(s)) {
          const c = map.cellAt(gx, 0, gz)
          const local = [map.cellLocal(gx), map.cellLocal(gz)]
          // The drained floor: open to the deck above, no mass (a kickboard
          // or the lone lounger may stand on it).
          expect((c.col === 0 || c.col === COLUMN_FURNITURE) && c.chunk.hasCeilHole(...local) && !c.chunk.hasFloorHole(...local), `${at} ${s.type} ${gx},${gz}`).toBe(true)
        }
      }
      // The natatio vault rises to the gallery storey, with a flight up to it.
      const [nat] = ofType(map, 'natatio')
      expect(nat.levelCount, at).toBe(3)
      expect(nat.verticalLinks.some((l) => l.lowerCy === 1), at).toBe(true)
      // Spawn on the deck, on a walkable cell.
      expect(res.spawn.cy, at).toBe(1)
      expect(map.cellAt(res.spawn.gx, 1, res.spawn.gz).col, at).toBe(0)
      // Depth plates: the basin floor counts past any real pool, the
      // gallery over a two-storey drop reads "3 FT", the deck keeps numbers.
      const labels = (cy) => [...map.chunks.values()].filter((d) => d.cy === cy).map((d) => d.levelLabel)
      expect(new Set(labels(0)), at).toEqual(new Set(['12Ft', '40Ft', '300F']))
      expect(labels(2).length, at).toBeGreaterThan(0)
      expect(labels(2).every((l) => l === '3 Ft'), at).toBe(true)
      expect(labels(1).every((l) => l === null), at).toBe(true)
    }
  }, 60_000)

  it('draws a different program and layout per seed (a grammar, not a stamp)', () => {
    const programs = new Set()
    const pits = new Set()
    const nats = new Set()
    const spawns = new Set()
    for (const seed of KIND_SEEDS) {
      const { map, res } = build(seed)
      programs.add(pools(map).map((s) => s.type).sort().join(','))
      const pit = ofType(map, 'pitRoom')[0].levels[1].voids[0]
      pits.add(`${pit.x0},${pit.z0},${pit.x1},${pit.z1}`)
      const nat = ofType(map, 'natatio')[0].levels[1].voids[0]
      nats.add(`${nat.x0},${nat.z0},${nat.x1},${nat.z1}`)
      spawns.add(`${res.spawn.gx},${res.spawn.gz}`)
    }
    // Measured over the 11 default seeds: 5 programs, 11 pit boxes, 11
    // natatio boxes, 11 spawns.
    expect(programs.size).toBeGreaterThanOrEqual(3)
    expect(pits.size).toBeGreaterThanOrEqual(8)
    expect(nats.size).toBeGreaterThanOrEqual(8)
    expect(spawns.size).toBeGreaterThanOrEqual(8)
  }, 60_000)

  it('keeps the exit at the bottom of the pit on a bare, walkable cell for every seed', () => {
    for (const seed of KIND_SEEDS) {
      const { map, res } = build(seed)
      const at = `poolrooms ${seed}`
      const { gx, gz, cy } = res.exit
      expect(cy, at).toBe(0)
      const v = ofType(map, 'pitRoom')[0].levels[1].voids[0]
      expect(gx >= v.x0 && gx <= v.x1 && gz >= v.z0 && gz <= v.z1, at).toBe(true)
      const c = map.cellAt(gx, cy, gz)
      expect(c.col, at).toBe(0)
      expect(c.chunk.exit, at).toEqual({ lx: map.cellLocal(gx), lz: map.cellLocal(gz) })
      expect(map.furnitureAt(gx, cy, gz), at).toBeNull()
      expect(walkGraph(map, judgeMap(map).box).nodes.has(nodeKey(gx, gz, cy)), at).toBe(true)
    }
  }, 60_000)

  it('lights the pools cyan from above and leaves the basin floors dark (dark cells mostly deep)', () => {
    const ratios = []
    for (const seed of KIND_SEEDS) {
      const { map } = build(seed)
      const at = `poolrooms ${seed}`
      // Cyan troffers hang over the voids on each pool's top storey; some
      // over the deep ends are dead. Measured: lit 9–23, dead 5–12.
      const cyan = []
      for (const d of map.chunks.values()) {
        for (const l of d.lamps) if (l.tint === POOL_TINT && d.hasFloorHole(l.lx, l.lz)) cyan.push(l)
      }
      expect(cyan.filter((l) => l.lit).length, at).toBeGreaterThanOrEqual(8)
      expect(cyan.filter((l) => !l.lit).length, at).toBeGreaterThanOrEqual(3)
      // Doc §12 "darkness … ≥ 0.7 of the dark cells are deep", on the
      // storey that would hold the water: the drained pool floors are dark
      // and make up most of the basin storey's dark cells (the plant level
      // round them is lit by the tile's greedy basin cover, tile.js
      // lampBasin; one small dark refuge at most).
      // Measured: deep floors dark 0.98–1 (median 0.98); share of the
      // dark that is deep 0.76–0.92.
      const { box } = judgeMap(map)
      const light = lightField(map, box, 0)
      const deep = new Set(pools(map).flatMap((s) => poolCells(s).map(([gx, gz]) => nodeKey(gx, gz, 0))))
      let darkDeep = 0
      for (const k of deep) if ((light.level.get(k) ?? 0) < DARK_LEVEL) darkDeep++
      ratios.push(darkDeep / deep.size)
      expect(darkDeep / deep.size, at).toBeGreaterThanOrEqual(0.85)
      expect(darkDeep / light.darkCells, at).toBeGreaterThanOrEqual(0.7)
    }
    expect(median(ratios)).toBeGreaterThan(0.9)
  }, 60_000)

  it('dresses the deck with the pool pack, and the sentō (when drawn) with lockers, a bandai seat and a bath', () => {
    let sento = 0
    let blocks3 = 0
    for (const seed of KIND_SEEDS) {
      const { map } = build(seed)
      const at = `poolrooms ${seed}`
      const furn = allFurniture(map)
      const count = (kind, cy = null) => furn.filter((f) => f.kind === kind && (cy === null || f.cy === cy)).length
      // Starting blocks on every other lane at a head of the natatio (and
      // of each lap hall): measured 2–8, 3 or more on 10 of the 11 seeds.
      expect(count(PROP_STARTING_BLOCK, 1), at).toBeGreaterThanOrEqual(2)
      if (count(PROP_STARTING_BLOCK, 1) >= 3) blocks3++
      // The pit keeps a kickboard on its dry floor, beside the exit.
      const well = ofType(map, 'pitRoom')[0].levels[1].voids[0]
      expect(furn.some((f) => f.cy === 0 && f.kind === PROP_KICKBOARD && f.gx >= well.x0 && f.gx <= well.x1 && f.gz >= well.z0 && f.gz <= well.z1), at).toBe(true)
      expect(count(PROP_LIFEGUARD_CHAIR, 1), at).toBeGreaterThanOrEqual(2)
      expect(count(PROP_LOUNGER), at).toBeGreaterThanOrEqual(4)
      expect(count(PROP_LOUNGER, 0), at).toBe(1) // the lone lounger in the dry basin
      expect(count(PROP_KICKBOARD), at).toBeGreaterThanOrEqual(3)
      expect(count(PROP_LOST_BIN, 1), at).toBeGreaterThanOrEqual(1)
      const bath = map.rooms.find((r) => r.role === SPACE_ROLE_BATHROOM)
      if (!bath) {
        expect(count(PROP_BANDAI), at).toBe(0)
        continue
      }
      sento++
      expect(bath.cy, at).toBe(1)
      expect(count(PROP_BANDAI, 1), at).toBe(1)
      expect(count(FURN_CABINET, 1) + count(FURN_WARDROBE, 1), at).toBeGreaterThanOrEqual(4)
    }
    expect(blocks3).toBeGreaterThanOrEqual(9)
    // The sentō is a grammar option (deck leaf p .4): measured 4 of 11.
    expect(sento).toBeGreaterThanOrEqual(2)
    expect(sento).toBeLessThan(KIND_SEEDS.length)
  }, 60_000)

  it('measures inside the doc §12 darkness and sightline bands', () => {
    // report:liminal settings (samples 24, rays 96), over every default seed;
    // floors[0] basin, [1] deck, [2] gallery. Measured:
    //   sightline median, all floors pooled 19.5 (doc "isovist (median)
    //   18–30 cells"); the deck alone 26.7 (20.2–35.1): long views over the
    //   pools through the halls' margins, the glass and the arcades;
    //   darkness median, all floors pooled 0.18 (doc 0.15–0.3); the deck
    //   0.25 (0.16–0.38); the basin 0.11, its plant level lit so its dark
    //   is the deep ends (the test above);
    //   loops: deck 34–74, basin 12–22, gallery 2–4 (doc: ≥ 1 dry).
    const floors = []
    const deck = []
    const basin = []
    const gallery = []
    for (const seed of KIND_SEEDS) {
      const { map } = build(seed)
      const f = liminalReport(map, judgeMap(map).box, { samples: 24, rays: 96 }).floors
      floors.push(...f)
      basin.push(f[0])
      deck.push(f[1])
      gallery.push(f[2])
    }
    expect(median(floors.map((f) => f.darkness))).toBeGreaterThanOrEqual(0.15)
    expect(median(floors.map((f) => f.darkness))).toBeLessThanOrEqual(0.3)
    expect(median(floors.map((f) => f.sightMedian))).toBeGreaterThanOrEqual(18)
    expect(median(floors.map((f) => f.sightMedian))).toBeLessThanOrEqual(30)
    expect(median(deck.map((f) => f.sightMedian))).toBeGreaterThanOrEqual(18)
    expect(median(deck.map((f) => f.sightMedian))).toBeLessThanOrEqual(30)
    expect(deck.every((f) => f.sightMedian >= 18)).toBe(true)
    expect(median(deck.map((f) => f.darkness))).toBeGreaterThanOrEqual(0.15)
    expect(median(deck.map((f) => f.darkness))).toBeLessThanOrEqual(0.3)
    expect(median(basin.map((f) => f.darkness))).toBeLessThan(median(deck.map((f) => f.darkness)))
    expect(deck.every((f) => f.loops >= 3)).toBe(true)
    expect(basin.every((f) => f.loops >= 3)).toBe(true)
    expect(gallery.every((f) => f.loops >= 1)).toBe(true)
  }, 120_000)
})
