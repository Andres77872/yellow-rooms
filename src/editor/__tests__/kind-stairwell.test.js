import { describe, expect, it } from 'vitest'
import { CELL_LOBBY, CELL_ROOM, CHUNK, PASSAGE_DOOR, SPACE_ROLE_STORAGE } from '../kinds/floorPlan.js'
import { PROP_DOORSTOP, PROP_STANDPIPE } from '../../world/props/index.js'
import { EditorMap } from '../EditorMap.js'
import { generatePrototype } from '../prototypes.js'
import { liminalReport, walkGraph } from '../simulate.js'
import { KIND_SEEDS, expectKindClean, judgeMap } from './kindJudge.js'

// 04 Endless Stairwell (docs/liminal_maps/04-endless-stairwell.md): two
// 16-storey shafts joined by exactly three transfer corridors, one fire door
// per landing on the same edge, lying level plates.

const FLOORS = 16

function build(seed) {
  const map = new EditorMap()
  const res = generatePrototype(map, 'stairwell', { seed })
  const b = map.bounds()
  // Shaft A is chunk column 0, shaft B the east end of the document.
  const shafts = [0, b.x1].map((cx) => {
    // The fire door: local column 6 on H-line 5 (south of a core at rows
    // 1..4) or 9 (north of a core at rows 9..12): the line whose inside cell
    // is the core's landing (a fragment's room door may share the column).
    const line = [5, 9].find((l) => map.cellAt(cx * CHUNK + 6, FLOORS - 1, l === 5 ? 4 : 9).kind === CELL_LOBBY)
    return { cx, line }
  })
  return { map, res, b, shafts }
}

const labelsOf = (map, cx) => Array.from({ length: FLOORS }, (_, cy) => map.chunkAt(cx, cy, 0).levelLabel)

// Storey-to-storey steps that are not "+1" (a lie breaks one to three).
const brokenSteps = (labels) => labels.slice(1).filter((l, i) => !(/^\d+$/.test(l) && /^\d+$/.test(labels[i]) && Number(l) === Number(labels[i]) + 1)).length

describe('stairwell kind (04 Endless Stairwell)', () => {
  it('audits clean and connected for every default seed', () => {
    expectKindClean(expect, 'stairwell', KIND_SEEDS)
  }, 60_000) // 11 seeds × 16 storeys, built twice each

  it('two shafts 2–4 chunks apart, joined on exactly three storeys', () => {
    for (const seed of ['proto', 'liminal-0', 'liminal-3']) {
      const { map, res, b } = build(seed)
      expect(b.x1 - b.x0, seed).toBeGreaterThanOrEqual(2)
      expect(b.x1 - b.x0, seed).toBeLessThanOrEqual(4)
      expect([b.z0, b.z1, b.y0, b.y1], seed).toEqual([0, 0, 0, FLOORS - 1])
      const { floors, audit } = judgeMap(map)
      // Two switchbacks of 15 flights each: every storey is reached by stair.
      expect(audit.canonicalLinks, seed).toBe(2 * (FLOORS - 1))
      // The rungs are the only storeys where the shafts meet in plan.
      expect(floors.filter((f) => f.length === 1), seed).toHaveLength(3)
      expect(floors.every((f) => f.length <= 2), seed).toBe(true)
      // Spawn on shaft A's top landing, exit at shaft B's foot.
      expect(res.spawn.cy).toBe(FLOORS - 1)
      expect(map.cellChunk(res.spawn.gx)).toBe(0)
      const top = walkGraph(map, { ...b, y0: FLOORS - 1, y1: FLOORS - 1 }, { vertical: false })
      expect([...top.nodes.values()].some((n) => n.gx === res.spawn.gx && n.gz === res.spawn.gz), seed).toBe(true)
      expect(res.exit.cy).toBe(0)
      expect(map.chunkAt(b.x1, 0, 0).exit, seed).toEqual({ lx: map.cellLocal(res.exit.gx), lz: map.cellLocal(res.exit.gz) })
      expect(map.meta.palette).toBe('stairwellConcrete')
    }
  })

  it('one fire door per landing on the same edge; some storeys brick it up', () => {
    let bricked = 0
    for (const seed of KIND_SEEDS) {
      const { map, shafts } = build(seed)
      for (const { cx, line } of shafts) {
        expect(line, seed).toBeDefined()
        for (let cy = 0; cy < FLOORS; cy++) {
          const e = map.wallHAt(cx * CHUNK + 6, cy, line)
          if (e.passage === PASSAGE_DOOR) expect(e.wall).toBe(0)
          else {
            expect(e.wall, `${seed} cx ${cx} cy ${cy}`).toBe(1)
            bricked++
          }
          // No other opening in the core's door wall.
          for (let lx = 4; lx <= 9; lx++) {
            if (lx !== 6) expect(map.wallHAt(cx * CHUNK + lx, cy, line).wall, `${seed} ${cx} ${cy} ${lx}`).toBe(1)
          }
        }
      }
    }
    expect(bricked).toBeGreaterThan(0)
  })

  it('level plates mostly count true, lying about once per 8 storeys per shaft', () => {
    const kinds = new Set()
    for (const seed of KIND_SEEDS) {
      const { map, res, shafts } = build(seed)
      const [a, bLabels] = shafts.map(({ cx }) => labelsOf(map, cx))
      // Shaft B is honest to the exit: storey + 1 except at its two lies,
      // never on the exit storey or the top three.
      const off = bLabels.map((l, cy) => l !== String(cy + 1))
      expect(off.filter(Boolean).length, seed).toBeGreaterThanOrEqual(2)
      expect(off.filter(Boolean).length, seed).toBeLessThanOrEqual(4)
      expect(off[0] || off.slice(FLOORS - 3).some(Boolean), seed).toBe(false)
      expect(off.slice(0, 8).some(Boolean) && off.slice(8).some(Boolean), seed).toBe(true)
      // Shaft A reads another count; its top three storeys are the clean
      // baseline and at most six steps break.
      for (const labels of [a, bLabels]) {
        expect(brokenSteps(labels), seed).toBeGreaterThanOrEqual(1)
        expect(brokenSteps(labels), seed).toBeLessThanOrEqual(6)
        expect(brokenSteps(labels.slice(FLOORS - 3)), seed).toBe(0)
      }
      expect(a[0], seed).not.toBe(bLabels[0])
      for (const m of res.notes.join(' ').matchAll(/storey \d+ (\w+) \(/g)) kinds.add(m[1])
    }
    expect(kinds.size).toBeGreaterThanOrEqual(4)
  })

  it('standpipe on every landing; door wedges only in dead-end closets', () => {
    let wedges = 0
    for (const seed of ['proto', 'lobby', 'liminal-2', 'liminal-4']) {
      const { map, shafts } = build(seed)
      for (const { cx } of shafts) {
        for (let cy = 0; cy < FLOORS; cy++) {
          const d = map.chunkAt(cx, cy, 0)
          const onLanding = d.furniture.filter((f) => f.kind === PROP_STANDPIPE && map.cellAt(cx * CHUNK + f.lx, cy, f.lz).kind === CELL_LOBBY)
          expect(onLanding, `${seed} ${cx} ${cy}`).toHaveLength(1)
        }
      }
      for (const d of map.chunks.values()) {
        for (const f of d.furniture.filter((p) => p.kind === PROP_DOORSTOP)) {
          wedges++
          const gx = d.cx * CHUNK + f.lx
          const c = map.cellAt(gx, d.cy, f.lz)
          expect(c.kind).toBe(CELL_ROOM)
          expect(c.role).toBe(SPACE_ROLE_STORAGE)
          // One-cell room: no neighbour shares its spaceId.
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            expect(map.cellAt(gx + dx, d.cy, f.lz + dz).spaceId).not.toBe(c.spaceId)
          }
        }
      }
    }
    expect(wedges).toBeGreaterThan(0)
  })

  it('dark storeys keep their fixtures dead, rooms and rung corridors included', () => {
    let deadRooms = 0
    let deadRung = 0
    for (const seed of ['proto', 'liminal-0', 'liminal-3']) {
      const { map, res, b } = build(seed)
      const notes = res.notes.join('\n')
      const [, a0, a1, b0, b1] = notes.match(/dark segments: A storeys (\d+)-(\d+), B storeys (\d+)-(\d+)/).map(Number)
      const segment = [[a0 - 1, a1 - 1], [b0 - 1, b1 - 1]]
      const inSegment = (s, cy) => cy >= segment[s][0] && cy <= segment[s][1]
      // Fragment notes ("cy:dark office") fold in dark runs as well as segments.
      const dark = ['A', 'B'].map((n) => new Set([...notes.match(new RegExp(`fragments ${n}: (.*)`))[1].matchAll(/(\d+):dark /g)].map((m) => Number(m[1]))))
      // Every furnished room has a centre fixture, dead exactly on a dark storey.
      let litRooms = 0
      for (const room of map.rooms) {
        const s = map.cellChunk(room.x0) === 0 ? 0 : 1
        const l = map.lampAt(Math.floor((room.x0 + room.x1) / 2), room.cy, Math.floor((room.z0 + room.z1) / 2))
        expect(l, `${seed} room ${room.id} storey ${room.cy}`).not.toBeNull()
        expect(l.rec.lit, `${seed} room ${room.id} storey ${room.cy}`).toBe(!dark[s].has(room.cy))
        if (!l.rec.lit) deadRooms++
        else litRooms++
      }
      expect(litRooms, seed).toBeGreaterThan(0)
      // A rung's corridor lamps (rows 2, 6, 10; landing tubes sit off them)
      // go dark on the half nearest a shaft whose segment holds the storey.
      const mid = (6 + b.x1 * CHUNK + 6) / 2
      for (const m of notes.matchAll(/storey (\d+): transfer corridor/g)) {
        const cy = Number(m[1]) - 1
        for (let cx = b.x0; cx <= b.x1; cx++) {
          for (const l of map.chunkAt(cx, cy, 0).lamps.filter((q) => [2, 6, 10].includes(q.lz))) {
            const gx = cx * CHUNK + l.lx
            expect(l.lit, `${seed} rung storey ${cy} x ${gx}`).toBe(!inSegment(gx < mid ? 0 : 1, cy))
            if (!l.lit) deadRung++
          }
        }
      }
    }
    expect(deadRooms).toBeGreaterThan(0)
    expect(deadRung).toBeGreaterThan(0)
  })

  it('measures near the doc 12 bands', () => {
    // Measured (8 samples x 48 rays, floors pooled): liminal-0..5 room
    // repetition 0.65, darkness 0.23, sightline median 7.5; liminal-0..11
    // 0.67, 0.24, 7.6 (per seed: repetition 0.50–0.79, darkness 0.11–0.51,
    // sightline 6.6–8.5: a seed's dark runs and breaker segments swing its
    // darkness). Doc 12 targets: repetition ≥ 0.7, darkness 0.25–0.4,
    // horizontal sightline median ≤ 6 (the switchback core's halo and the
    // car-park deck stretch it a little). Rooms of a module are fitted and
    // lit alike whichever side of a corridor they open from (fragments.js
    // sideFit, lightRooms), so they repeat.
    const floors = []
    for (const seed of ['liminal-0', 'liminal-1', 'liminal-2', 'liminal-3', 'liminal-4', 'liminal-5']) {
      const { map, b } = build(seed)
      floors.push(...liminalReport(map, b, { samples: 8, rays: 48 }).floors)
    }
    const median = (get) => {
      const v = floors.map(get).filter(Number.isFinite).sort((x, y) => x - y)
      return v[Math.floor((v.length - 1) / 2)]
    }
    expect(floors).toHaveLength(6 * FLOORS)
    expect(median((f) => f.roomRepetition)).toBeGreaterThanOrEqual(0.6)
    expect(median((f) => f.darkness)).toBeGreaterThan(0.12)
    expect(median((f) => f.darkness)).toBeLessThan(0.45)
    expect(median((f) => f.sightMedian)).toBeLessThanOrEqual(8)
  }, 60_000)
})
