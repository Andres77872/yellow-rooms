import { describe, expect, it } from 'vitest'
import { EditorMap } from '../EditorMap.js'
import { CELL_ROOM, PASSAGE_DOOR, PASSAGE_WIDE, WALL_RAIL, WALL_WINDOW, labelFloor } from '../kinds/floorPlan.js'
import { STATIONS } from '../kinds/train.js'
import { generatePrototype } from '../prototypes.js'
import { lightField, liminalReport, nodeKey, walkGraph } from '../simulate.js'
import { PROP_TICKET_GATE } from '../../world/props/index.js'
import { KIND_SEEDS, expectKindClean } from './kindJudge.js'

// 07 — The Endless Train (docs/liminal_maps/07-endless-train.md, §13 step
// 1): seven 3-wide cars joined by gangway doors, glass onto a sealed tunnel,
// one station with wide doors onto a platform, stairs to a concourse with a
// ticket-gate line; the train lit, the station half dead.

const TRAIN = 0
const CONC = 1
const CAR_X0 = 3
const CARS = 7
const STATION_CARS = [2, 3, 4]

function build(seed) {
  const map = new EditorMap()
  const res = generatePrototype(map, 'train', { seed })
  return { map, res }
}

const carX0 = (k) => CAR_X0 + 7 * k
const walkable = (map, gx, cy, gz) => map.cellAt(gx, cy, gz).col === 0

describe('train kind', () => {
  it('builds clean, connected, deterministic maps for every default seed', () => {
    expectKindClean(expect, 'train')
  })

  it('is a chain of seven identical-sized cars joined by gangway doors, seats off a free aisle', () => {
    for (const seed of ['proto', 'liminal-0', 'liminal-3', 'liminal-6']) {
      const { map } = build(seed)
      const ids = new Set()
      for (let k = 0; k < CARS; k++) {
        const x0 = carX0(k)
        const id = map.cellAt(x0, TRAIN, 2).spaceId
        for (let gz = 2; gz <= 4; gz++) {
          for (let gx = x0; gx < x0 + 7; gx++) {
            const c = map.cellAt(gx, TRAIN, gz)
            expect(c.kind, `${seed} car ${k}`).toBe(CELL_ROOM)
            expect(c.spaceId, `${seed} car ${k}`).toBe(id)
          }
        }
        ids.add(id)
      }
      expect(ids.size, seed).toBe(CARS)
      // Every joint (cab | car | … | car | cab) is one door on the aisle with
      // solid car ends beside it.
      for (let k = 0; k <= CARS; k++) {
        const line = carX0(k)
        const g = map.wallVAt(line, TRAIN, 3)
        expect([g.wall, g.passage], `${seed} gangway ${line}`).toEqual([0, PASSAGE_DOOR])
        if (k > 0 && k < CARS) {
          expect(map.wallVAt(line, TRAIN, 2).wall, seed).toBe(1)
          expect(map.wallVAt(line, TRAIN, 4).wall, seed).toBe(1)
        }
      }
      // The aisle runs unbroken from cab to cab; every piece on the train
      // sits in a side bay (z 2 or 4) at a seat position, never a door bay.
      for (let gx = 1; gx <= 53; gx++) expect(walkable(map, gx, TRAIN, 3), `${seed} aisle ${gx}`).toBe(true)
      for (const d of map.chunks.values()) {
        if (d.cy !== TRAIN) continue
        for (const f of d.furniture) {
          const gx = d.cx * 14 + f.lx
          if (f.lz > 4) continue
          expect([2, 4], `${seed} piece at ${gx},${f.lz}`).toContain(f.lz)
          expect(((gx - CAR_X0) % 7) % 2, `${seed} piece at ${gx},${f.lz}`).toBe(0)
        }
      }
      // Side doors: wide openings onto the platform at the station cars'
      // three door bays; every other car's near-side doors stay shut.
      for (let k = 0; k < CARS; k++) {
        for (const b of [1, 3, 5]) {
          const gx = carX0(k) + b
          const e = map.wallHAt(gx, TRAIN, 5)
          if (STATION_CARS.includes(k)) {
            expect([e.wall, e.passage], `${seed} door ${gx}`).toEqual([0, PASSAGE_WIDE])
            expect(walkable(map, gx, TRAIN, 5), seed).toBe(true)
          } else expect(e.wall, `${seed} door ${gx}`).toBe(1)
        }
      }
    }
  })

  it('glazes the cars onto the sealed tunnel and gates the concourse with walk gaps', () => {
    for (const seed of KIND_SEEDS) {
      const { map, res } = build(seed)
      const dark = Number(/dark baggage car (\d)/.exec(res.notes[0])[1]) - 1
      // Far side: glass on every seat bay of every lit car, onto column mass;
      // the dark baggage car is blind.
      for (let k = 0; k < CARS; k++) {
        for (const b of [0, 2, 4, 6]) {
          const gx = carX0(k) + b
          const e = map.wallHAt(gx, TRAIN, 2)
          expect(e.feature, `${seed} car ${k} bay ${b}`).toBe(k === dark ? 0 : WALL_WINDOW)
          expect(map.cellAt(gx, TRAIN, 1).col, seed).toBe(1)
        }
      }
      for (let cx = 0; cx < 4; cx++) expect(map.chunkAt(cx, TRAIN, 0).authoredFeatures, seed).toBe(true)
      // The gate line on z 3: gates alternate with walkable gaps across the
      // bank, rails close the rest of the line.
      const gates = []
      for (const d of map.chunks.values()) {
        if (d.cy !== CONC) continue
        for (const f of d.furniture) if (f.kind === PROP_TICKET_GATE) gates.push(d.cx * 14 + f.lx)
      }
      gates.sort((a, b) => a - b)
      expect(gates.length, seed).toBeGreaterThanOrEqual(4)
      for (let i = 1; i < gates.length; i++) {
        expect(gates[i] - gates[i - 1], seed).toBe(2)
        expect(walkable(map, gates[i] - 1, CONC, 3), `${seed} gap ${gates[i] - 1}`).toBe(true)
      }
      for (let gx = 17; gx <= 37; gx++) {
        const inBank = gx >= 23 && gx <= 31
        expect(map.wallHAt(gx, CONC, 3).feature, `${seed} rail ${gx}`).toBe(inBank ? 0 : WALL_RAIL)
      }
    }
  })

  it('lies on its plates: car numbers, a drifting station name, or doors onto the tunnel wall', () => {
    const seen = new Set()
    for (const seed of KIND_SEEDS) {
      const { map, res } = build(seed)
      const anomaly = /anomaly (\w+)/.exec(res.notes.join('\n'))[1]
      seen.add(anomaly)
      const cars = [0, 1, 2, 3].map((cx) => map.chunkAt(cx, TRAIN, 0).levelLabel)
      const names = [1, 2].map((cx) => map.chunkAt(cx, CONC, 0).levelLabel)
      if (anomaly === 'carNumbers') expect(cars, seed).not.toEqual(['C1', 'C3', 'C5', 'C7'])
      else expect(cars, seed).toEqual(['C1', 'C3', 'C5', 'C7'])
      const diff = [...names[0]].filter((ch, i) => ch !== names[1][i]).length
      expect(diff, `${seed} ${names}`).toBe(anomaly === 'stationName' ? 1 : 0)
      // Wrong side: three one-cell niches behind the far-side door bays.
      let niches = 0
      for (let gx = carX0(0); gx < carX0(CARS); gx++) if (walkable(map, gx, TRAIN, 1)) niches++
      expect(niches, seed).toBe(anomaly === 'wrongSide' ? 3 : 0)
    }
    expect(seen.size).toBe(3)
  })

  it('names every station, and its drift, in plate glyphs one letter apart', () => {
    // labelFloor throws on a glyph the plates lack (e.g. lowercase u), which
    // only fires on the seeds that draw that station with the stationName
    // anomaly: check the whole table, not just the default seeds.
    for (const [name, drifted] of STATIONS) {
      for (const label of [name, drifted]) expect(() => labelFloor(new EditorMap(), CONC, label), label).not.toThrow()
      expect(drifted.length, name).toBe(name.length)
      expect([...name].filter((ch, i) => ch !== drifted[i]).length, `${name} / ${drifted}`).toBe(1)
    }
  })

  it('hangs the platform lamps inside the platform and leaves the walkways dark', () => {
    for (const seed of KIND_SEEDS) {
      const { map } = build(seed)
      const row = []
      for (const d of map.chunks.values()) {
        if (d.cy !== TRAIN || d.cz !== 0) continue
        for (const l of d.lamps ?? []) if (l.lz === 5) row.push({ gx: d.cx * 14 + l.lx, lit: !!l.lit })
      }
      const platform = row.filter((l) => l.gx >= 17 && l.gx <= 37)
      expect(platform.map((l) => l.gx).sort((a, b) => a - b), seed).toEqual([19, 23, 27, 31, 35])
      for (const l of row) if (l.gx < 17 || l.gx > 37) expect(l.lit, `${seed} walkway lamp ${l.gx}`).toBe(false)
    }
  })

  it('measures a lit train against a half-dead station (doc 12 darkness and loop bands)', () => {
    for (const seed of ['proto', 'liminal-0', 'liminal-3', 'liminal-5']) {
      const { map } = build(seed)
      const b = map.bounds()
      const share = (cy, pick) => {
        const lf = lightField(map, b, cy)
        const g = walkGraph(map, { ...b, y0: cy, y1: cy }, { vertical: false })
        const cells = [...g.nodes.values()].filter(pick)
        return cells.filter((n) => (lf.level.get(nodeKey(n.gx, n.gz, cy)) ?? 0) < 0.12).length / cells.length
      }
      // Darkness "0.05–0.15 on the train (blackouts)": the dark baggage car
      // and one failed neighbour tube measure 0.10–0.16 of the train's cells.
      const train = share(TRAIN, (n) => n.gz >= 2 && n.gz <= 4)
      expect(train, seed).toBeGreaterThan(0.06)
      expect(train, seed).toBeLessThan(0.2)
      // "0.4–0.8 in ghost stations": the platform and walkways measure
      // 0.43–0.50, the concourse 0.34–0.63 (its lamps ride the seed).
      const platform = share(TRAIN, (n) => n.gz >= 5)
      expect(platform, seed).toBeGreaterThan(0.35)
      expect(platform, seed).toBeLessThan(0.65)
      const conc = share(CONC, () => true)
      expect(conc, seed).toBeGreaterThan(0.25)
      expect(conc, seed).toBeLessThan(0.75)
      // Loops "0 on the train, ≥ 1 per station": the platform's wide doors
      // close loops through the station cars; the aisle (sightline capped at
      // 48 cells, above the doc's 7–21, since door leaves don't block the
      // metric) runs the whole train.
      const { floors } = liminalReport(map, { ...b }, { samples: 8, rays: 48 })
      expect(floors[TRAIN].loops, seed).toBeGreaterThanOrEqual(1)
      expect(floors[TRAIN].sightP90, seed).toBeGreaterThan(30)
    }
  })
})
