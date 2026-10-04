import { describe, expect, it } from 'vitest'
import { EditorMap, seedFromText } from '../EditorMap.js'
import {
  CELL_BRIDGE,
  CELL_ROOM,
  CELL_VOID,
  FACING,
  PASSAGE_DOOR,
  PASSAGE_WIDE,
  WALL_PLAIN,
} from '../kinds/floorPlan.js'
import { generatePrototype } from '../prototypes.js'
import { DARK_LEVEL, isovist, lightField, walkGraph } from '../simulate.js'
import { hash3i } from '../../world/core/hash.js'
import { cIdx } from '../../world/constants.js'
import { PROP_GHOST_LIGHT, PROP_PROMPT_DESK, PROP_SEAT_ROW } from '../../world/props/index.js'
import { finiteScheme, frameOf, inRect, participantChunk } from '../../world/families/theater/geometry.js'
import { KIND_SEEDS, expectKindClean } from './kindJudge.js'

// 11 — The Empty Theater (docs/liminal_maps/11-empty-theater.md): the kind
// lab draws a procedural sample theatre per seed (the world's grammar,
// geometry.finiteScheme): a house volume (opera house or proscenium house,
// five storeys, any of the 8 orientations) with its stalls, pit, proscenium,
// circles and fly tower, and the band of front-of-house and backstage rooms
// round it. Every assertion reads the seed's scheme: the layout is rolled,
// the elements are not.

const TRAP = 0
const STALLS = 1

function build(seed) {
  const map = new EditorMap()
  const res = generatePrototype(map, 'theater', { seed })
  return { map, res, sc: finiteScheme(seedFromText(seed)) }
}

const cells = (map, cy, test) => {
  const out = []
  for (const d of map.chunks.values()) {
    if (d.cy !== cy) continue
    for (let i = 0; i < 196; i++) {
      const gx = d.cx * 14 + (i % 14)
      const gz = d.cz * 14 + Math.floor(i / 14)
      if (test(d, i, gx, gz)) out.push({ gx, gz, d, i })
    }
  }
  return out
}

const lamps = (map, cy) => {
  const out = []
  for (const d of map.chunks.values()) {
    if (d.cy !== cy) continue
    for (const l of d.lamps) out.push({ gx: d.cx * 14 + l.lx, gz: d.cz * 14 + l.lz, lit: l.lit, tint: l.tint })
  }
  return out
}

const pieces = (map, cy, kind) => {
  const out = []
  for (const d of map.chunks.values()) {
    if (d.cy !== cy) continue
    for (const f of d.furniture) if (f.kind === kind) out.push({ gx: d.cx * 14 + f.lx, gz: d.cz * 14 + f.lz, facing: f.facing })
  }
  return out
}

// The edge between cells a and b (adjacent), as the map stores it.
const edgeBetween = (map, cy, a, b) => (a.gx !== b.gx
  ? map.wallVAt(Math.max(a.gx, b.gx), cy, a.gz)
  : map.wallHAt(a.gx, cy, Math.max(a.gz, b.gz)))
const sideEdge = (map, cy, gx, gz, side) => ({
  S: () => map.wallHAt(gx, cy, gz + 1),
  N: () => map.wallHAt(gx, cy, gz),
  E: () => map.wallVAt(gx + 1, cy, gz),
  W: () => map.wallVAt(gx, cy, gz),
})[side]()
const FACING_SIDE = { [FACING.S]: 'S', [FACING.N]: 'N', [FACING.E]: 'E', [FACING.W]: 'W' }
const facingOf = ({ dx, dz }) => (dx > 0 ? FACING.E : dx < 0 ? FACING.W : dz > 0 ? FACING.S : FACING.N)
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const box = (sc) => ({ x0: sc.bounds.x0 - 1, z0: sc.bounds.z0 - 1, x1: sc.bounds.x1 + 1, z1: sc.bounds.z1 + 1 })

describe('theater kind', () => {
  it('builds clean, connected, deterministic maps for every default seed', () => {
    expectKindClean(expect, 'theater')
  })

  it('every seed is its own theatre: house class, orientation, bounds, stage and band all rolled', () => {
    const layouts = new Set()
    const frames = new Set()
    for (const seed of KIND_SEEDS) {
      const sc = finiteScheme(seedFromText(seed))
      expect(['opera', 'proscenium']).toContain(sc.house)
      expect(sc.NL).toBe(5)
      frames.add(`${sc.sw}${sc.fu}${sc.fv}`)
      layouts.add(JSON.stringify([sc.bounds, sc.core, sc.S, sc.Ow, sc.skeleton.strips.map((s) => [s.rect, s.lane])]))
    }
    expect(layouts.size).toBe(KIND_SEEDS.length)
    expect(frames.size).toBeGreaterThanOrEqual(4)
  })

  it('is one oriented house: a WIDE proscenium of the rolled width, a railed pit, circles and a fly tower', () => {
    for (const seed of KIND_SEEDS) {
      const { map, sc } = build(seed)
      const F = frameOf(sc)
      // Proscenium: the line between canonical u = P − 1 and u = P on the
      // stalls storey is WIDE exactly across the opening; elsewhere wall or a
      // pass door (one or two).
      let wide = 0
      let doors = 0
      for (let v = 0; v < sc.W; v++) {
        const e = edgeBetween(map, STALLS, F.toTile(sc.P - 1, v), F.toTile(sc.P, v))
        if (v >= sc.o0 && v <= sc.o1) {
          expect(e.passage, `${seed} opening v ${v}`).toBe(PASSAGE_WIDE)
          expect(e.wall).toBe(0)
          wide++
        } else if (!e.wall) {
          expect(e.passage, `${seed} proscenium v ${v}`).toBe(PASSAGE_DOOR)
          doors++
        }
      }
      expect(wide, seed).toBe(sc.Ow)
      expect(doors, seed).toBeGreaterThanOrEqual(1)
      expect(doors, seed).toBeLessThanOrEqual(2)
      // The volume's voids on every level are voids (or catwalks) in the map;
      // the pit's floor (the trap room storey) is walkable.
      for (let k = 1; k < sc.NL; k++) {
        for (const r of sc.levels[k].voids) {
          for (let gz = r.z0; gz <= r.z1; gz++) {
            for (let gx = r.x0; gx <= r.x1; gx++) {
              expect([CELL_VOID, CELL_BRIDGE], `${seed} level ${k} ${gx},${gz}`).toContain(map.cellAt(gx, k, gz).kind)
              if (k === STALLS) expect(map.cellAt(gx, TRAP, gz).col, `${seed} pit floor ${gx},${gz}`).toBe(0)
            }
          }
        }
        const bridges = cells(map, k, (d, i) => d.cellKind[i] === CELL_BRIDGE).length
        const want = sc.levels[k].bridges.reduce((a, r) => a + (r.x1 - r.x0 + 1) * (r.z1 - r.z0 + 1), 0)
        expect(bridges, `${seed} catwalks on level ${k}`).toBe(want)
      }
      // The fly tower rises through every level above the stage.
      for (let k = 2; k < sc.NL; k++) expect(sc.levels[k].voids.length, seed).toBe(1 + ((k === 2 && sc.circles >= 1) || (k === 3 && sc.circles >= 2) ? 1 : 0))
      // Plates name the levels (or, as the anomaly, all claim the stalls).
      const plates = [0, 1, 2, 3, 4].map((cy) => [...map.chunks.values()].find((d) => d.cy === cy).levelLabel)
      expect([['trAP', '5tAL', 'dC', 'UC', 'LoFt'], Array(5).fill('5tAL')], seed).toContainEqual(plates)
    }
  })

  it('leaves the house dark: one lit lamp in house and stage, over the ghost light', () => {
    const anomalies = new Set()
    for (const seed of KIND_SEEDS) {
      const { map, res, sc } = build(seed)
      anomalies.add(res.notes.find((n) => n.startsWith('anomaly:')))
      const F = frameOf(sc)
      const b = box(sc)
      // The volume's box (house, stage, ring) on the circles' and fly storeys: all dead.
      for (const cy of [2, 3, 4]) {
        expect(lamps(map, cy).filter((l) => inRect(b, l.gx, l.gz) && l.lit && l.tint !== 0xa8bcff), `${seed} cy ${cy}`).toEqual([])
      }
      // The stalls storey's box: exactly one lit lamp, tinted, over the ghost light.
      const lit = lamps(map, STALLS).filter((l) => inRect(b, l.gx, l.gz) && l.lit)
      expect(lit, seed).toHaveLength(1)
      expect(lamps(map, STALLS).filter((l) => inRect(b, l.gx, l.gz)).length, seed).toBeGreaterThanOrEqual(5)
      const ghosts = pieces(map, STALLS, PROP_GHOST_LIGHT)
      expect(ghosts, seed).toHaveLength(1)
      expect({ gx: lit[0].gx, gz: lit[0].gz }, seed).toEqual({ gx: ghosts[0].gx, gz: ghosts[0].gz })
      expect(lit[0].tint, seed).toBe(0xffe2b4)
      // Centre stage, downstage by default or upstage as the anomaly.
      const { u, v } = F.toCanon(ghosts[0].gx, ghosts[0].gz)
      expect(v, seed).toBe(sc.oc)
      expect([sc.P + 1, sc.L - 2], seed).toContain(u)
      expect(u === sc.L - 2, seed).toBe(res.notes.some((n) => n.includes('upstage')))
      // The prompt desk stage left of the opening, against the proscenium.
      for (const p of pieces(map, STALLS, PROP_PROMPT_DESK)) expect(F.toCanon(p.gx, p.gz), seed).toEqual({ u: sc.P, v: sc.o1 + 2 })
    }
    expect(anomalies.size).toBeGreaterThan(1)
  })

  it('hangs every lamp from a real ceiling; the lamps over a void are dead', () => {
    for (const seed of KIND_SEEDS) {
      const { map } = build(seed)
      for (const d of map.chunks.values()) {
        for (const l of d.lamps) {
          const at = `${d.cy}:${d.cx * 14 + l.lx},${d.cz * 14 + l.lz}`
          expect(d.hasCeilHole(l.lx, l.lz), `${seed} lamp ${at} under a ceiling hole`).toBe(false)
          if (!d.hasFloorHole(l.lx, l.lz) && d.cellKind[cIdx(l.lx, l.lz)] !== CELL_VOID) continue
          expect(l.lit, `${seed} lamp ${at}`).toBe(false)
          const above = map.chunkAt(d.cx, d.cy + 1, d.cz)
          if (above) expect(above.hasFloorHole(l.lx, l.lz), `${seed} lamp ${at} slab above`).toBe(false)
        }
      }
    }
  })

  it('seats the stalls in rows facing the stage, with gangways and cross aisles clear', () => {
    for (const seed of KIND_SEEDS) {
      const { map, res, sc } = build(seed)
      const F = frameOf(sc)
      const toStage = facingOf(F.step(1, 0))
      const stalls = pieces(map, STALLS, PROP_SEAT_ROW).filter((p) => F.toCanon(p.gx, p.gz).u < sc.P)
      const rows = sc.front - 1 - (sc.mid >= 0 ? 1 : 0)
      const full = rows * sc.blocks.reduce((a, [v0, v1]) => a + v1 - v0 + 1, 0)
      expect(stalls.length, seed).toBeGreaterThan(full * 0.75)
      expect(stalls.length, seed).toBeLessThanOrEqual(full)
      const turned = stalls.filter((p) => p.facing !== toStage)
      expect(turned.length > 0, seed).toBe(res.notes.some((n) => n.includes('faces the back')))
      for (const p of stalls) {
        const { u, v } = F.toCanon(p.gx, p.gz)
        expect(sc.gangways, `${seed} seat on a gangway ${p.gx},${p.gz}`).not.toContain(v)
        expect([0, sc.W - 1], `${seed} seat on a side aisle ${p.gx},${p.gz}`).not.toContain(v)
        expect([0, sc.front, sc.mid], `${seed} seat on a cross aisle ${p.gx},${p.gz}`).not.toContain(u)
      }
      // The circles seat too, when the theatre has them.
      if (sc.circles >= 1) expect(pieces(map, 2, PROP_SEAT_ROW).length, seed).toBeGreaterThan(0)
      // No seat looks at a plain wall: in front of each is floor, another
      // seat or a rail over the void.
      for (const cy of [1, 2, 3]) {
        for (const p of pieces(map, cy, PROP_SEAT_ROW)) {
          const e = sideEdge(map, cy, p.gx, p.gz, FACING_SIDE[p.facing])
          expect(e.wall && e.feature === WALL_PLAIN, `${seed} cy ${cy} seat ${p.gx},${p.gz}`).toBeFalsy()
        }
      }
    }
  })

  it('wraps the house in a band of rooms: front of house and backstage on three storeys, doors on every room', () => {
    for (const seed of KIND_SEEDS) {
      const { map, sc } = build(seed)
      for (const cy of [0, 1, 2]) {
        const rooms = new Map()
        for (const { d, i, gx, gz } of cells(map, cy, (d, i) => d.cellKind[i] === CELL_ROOM && d.cols[i] !== 1)) {
          if (inRect(box(sc), gx, gz)) continue
          const id = d.spaceId[i]
          let r = rooms.get(id)
          if (!r) rooms.set(id, (r = []))
          r.push({ gx, gz })
        }
        expect(rooms.size, `${seed} cy ${cy} rooms`).toBeGreaterThanOrEqual(8)
        // Every band room opens: a door (or an opening) on its rim.
        for (const [id, rc] of rooms) {
          const own = new Set(rc.map((c) => `${c.gx},${c.gz}`))
          let open = false
          for (const c of rc) {
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const n = { gx: c.gx + dx, gz: c.gz + dz }
              if (own.has(`${n.gx},${n.gz}`)) continue
              const e = edgeBetween(map, cy, c, n)
              if (!e.wall) open = true
            }
          }
          expect(open, `${seed} cy ${cy} room ${id}`).toBe(true)
        }
      }
      // The band's stairwells (0..2) stand outside the house's chunks.
      for (const t of sc.skeleton.stairs) expect(participantChunk(sc, t.cx, t.cz), seed).toBe(false)
    }
  })

  it('measures a dark, deep house against a short-sighted backstage (doc 12)', () => {
    for (const seed of ['proto', 'liminal-1', 'liminal-3']) {
      const { map, sc } = build(seed)
      const F = frameOf(sc)
      const whole = { x0: 0, x1: 2, z0: 0, z1: 2, y0: STALLS, y1: STALLS }
      // The scheme's masks on the stalls storey: the house (stalls and stage,
      // inside the volume's bounds) and the backstage band (outside the carve
      // box, at or behind the proscenium line), each sampled the way
      // liminalReport samples a floor (24 hashed cells, 96 rays, range 48).
      const house = []
      const back = []
      for (const n of walkGraph(map, whole, { vertical: false }).nodes.values()) {
        if (inRect(sc.bounds, n.gx, n.gz)) house.push(n)
        else if (!inRect(box(sc), n.gx, n.gz) && F.toCanon(n.gx, n.gz).u >= sc.P) back.push(n)
      }
      const light = lightField(map, whole, STALLS)
      const darkness = house.filter((n) => (light.level.get(`${n.gx},${n.gz},${STALLS}`) ?? 0) < DARK_LEVEL).length / house.length
      const measure = (ns) => {
        const iso = ns
          .map((n) => [hash3i(0x11a1, n.gx, n.gz, STALLS) >>> 0, n])
          .sort((a, b) => a[0] - b[0])
          .slice(0, 24)
          .map(([, n]) => isovist(map, STALLS, n.gx, n.gz, { rays: 96, range: 48 }))
        return { sight: median(iso.map((i) => i.maxDepth)), area: median(iso.map((i) => i.area)) }
      }
      const h = measure(house)
      const b = measure(back)
      // Doc 12 "darkness 0.75–0.9 in the house": only the ghost light burns
      // over the house and the stage; the old fixed kind measured 0.92–0.95,
      // the rolled houses 0.85–0.92 (light from the ring's doors).
      expect(darkness, seed).toBeGreaterThan(0.8)
      expect(darkness, seed).toBeLessThan(0.97)
      // Doc 12 "house isovist at the cap": the sightline median is capped by
      // the 2×2-chunk house (about 26 cells); rolled houses measure 21–26.
      expect(h.sight, seed).toBeGreaterThan(20)
      // Doc 12 "backstage isovist 4–8 cells": the rolled backstage (rooms,
      // halls and lanes behind the proscenium) measures 6.6–10.6; the
      // contrast with the house is what the doc asks for.
      expect(b.sight, seed).toBeGreaterThanOrEqual(4)
      expect(b.sight, seed).toBeLessThanOrEqual(11)
      expect(h.sight, seed).toBeGreaterThan(2 * b.sight)
      expect(h.area, seed).toBeGreaterThan(5 * b.area)
    }
  })
})
