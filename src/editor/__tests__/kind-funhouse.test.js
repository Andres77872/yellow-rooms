import { describe, expect, it } from 'vitest'
import { EditorMap, seedFromText } from '../EditorMap.js'
import { generatePrototype } from '../prototypes.js'
import { isovist, liminalReport } from '../simulate.js'
import { CELL, CHAIR_W, CHUNK, TABLE_D, TABLE_W } from '../../world/constants.js'
import { COLUMN_STANDARD, PASSAGE_DOOR, WALL_PLAIN, WALL_WINDOW } from '../../world/mapTypes.js'
import { FURN_CHAIR, FURN_COUNTER, FURN_TABLE } from '../../world/rooms/catalog.js'
import { PROP_BALL_TRACK, PROP_CCTV, PROP_MASCOT } from '../../world/props/index.js'
import { FACING, THICK } from '../kinds/floorPlan.js'
import { FUNHOUSE_LIES } from '../kinds/funhouse.js'
import { TILE_CELLS_X, skeletonOf } from '../../world/families/funhouse/geometry.js'
import { KIND_SEEDS, expectKindClean } from './kindJudge.js'

// The funhouse (docs/liminal_maps/12-funhouse.md): the kind-lab contract
// plus the doc's measurable claims (§4, §10, §12) that today's engine can
// reach — mirrors and glass are both window edges, so "apparent" sight is
// sight through glass. The sample is one procedural pavilion (pavilion 0
// of the seed's chain): its wings, attractions, stairs and ride loop come
// from the seed, so the checks read sizes and places from the notes and the
// skeleton, never from a fixed plan.

const GROUND = 0
const RIDE = 1
const UV = 0xb070ff

function build(seed) {
  const map = new EditorMap()
  const res = generatePrototype(map, 'funhouse', { seed })
  expect(res.ok, res.error).toBe(true)
  const b = map.bounds()
  return { map, res, box: { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0: b.y0, y1: b.y1 } }
}

const note = (res, re) => {
  const m = res.notes.map((n) => re.exec(n)).find(Boolean)
  expect(m, `${re}`).toBeTruthy()
  return m.slice(1).map((v) => (/^\d+$/.test(v) ? Number(v) : v))
}
const lamps = (map, cy) => [...map.chunks.values()].filter((d) => d.cy === cy).flatMap((d) => d.lamps.map((l) => ({ ...l, gx: d.cx * CHUNK + l.lx, gz: d.cz * CHUNK + l.lz })))
const furniture = (map, cy) => [...map.chunks.values()].filter((d) => d.cy === cy).flatMap((d) => d.furniture.map((f) => ({ ...f, gx: d.cx * CHUNK + f.lx, gz: d.cz * CHUNK + f.lz })))
// Walls (and how many are glass) on the edges between two open cells of rect.
function wallsIn(map, cy, r) {
  let walls = 0
  let glass = 0
  const open = (x, z) => map.cellAt(x, cy, z).col !== COLUMN_STANDARD
  for (let z = r.z0; z <= r.z1; z++) {
    for (let x = r.x0; x <= r.x1; x++) {
      if (!open(x, z)) continue
      for (const w of [x < r.x1 && open(x + 1, z) && map.wallVAt(x + 1, cy, z), z < r.z1 && open(x, z + 1) && map.wallHAt(x, cy, z + 1)]) {
        if (!w || !w.wall) continue
        walls++
        if (w.feature === WALL_WINDOW) glass++
      }
    }
  }
  return { walls, glass }
}
// The woven field (res.field: cell 'x,z' → atom): atom pairs that share an
// edge, and those joined by at least one open edge.
function atomGraph(map, field) {
  const pairs = new Map()
  for (const [k, a] of field) {
    const [x, z] = k.split(',').map(Number)
    for (const [nx, nz, w] of [[x + 1, z, () => map.wallVAt(x + 1, GROUND, z)], [x, z + 1, () => map.wallHAt(x, GROUND, z + 1)]]) {
      const b = field.get(`${nx},${nz}`)
      if (b === undefined || b === a) continue
      const pk = a < b ? `${a}|${b}` : `${b}|${a}`
      const open = !w().wall
      pairs.set(pk, (pairs.get(pk) ?? false) || open)
    }
  }
  return { atoms: new Set(field.values()).size, pairs: pairs.size, open: [...pairs.values()].filter(Boolean).length }
}
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1]

describe('funhouse kind', () => {
  it('builds clean, connected, deterministic maps for every seed', () => {
    expectKindClean(expect, 'funhouse')
  })

  it('weaves the field from seeded wings: 10–20% of the spare joints reopened, dead ends in the doc band, a different field per seed', () => {
    const fields = new Set()
    for (const seed of KIND_SEEDS) {
      const { map, res, box } = build(seed)
      const [cells, atoms, wings, wingList, reopened, walls] = note(res, /^field: (\d+) cells, (\d+) atoms in (\d+) wings \(([^)]*)\); (\d+)\/(\d+) walls reopened/)
      fields.add(wingList)
      expect(wingList.split(' '), seed).toHaveLength(wings)
      expect(wings, seed).toBeGreaterThanOrEqual(2)
      // Measured on the map: a spanning tree joins atoms − 1 atom pairs, so
      // the open pairs beyond that are the reopened joints, and every pair
      // beyond the tree was a candidate.
      // The field is one to four pieces (each opening onto the midway): a
      // spanning forest joins atoms − pieces atom pairs.
      const [pieces] = note(res, / onto (\d+) field pieces/)
      expect(pieces >= 1 && pieces <= 4, seed).toBe(true)
      expect(res.field.size, seed).toBe(cells)
      const g = atomGraph(map, res.field)
      expect(g.atoms, seed).toBe(atoms)
      expect(g.open - (atoms - pieces), seed).toBe(reopened)
      expect(g.pairs - (atoms - pieces), seed).toBe(walls)
      if (walls >= 20) {
        expect(reopened / walls, seed).toBeGreaterThanOrEqual(0.095 - 0.5 / walls)
        expect(reopened / walls, seed).toBeLessThanOrEqual(0.205 + 0.5 / walls)
      }
      const f = liminalReport(map, { ...box, y0: GROUND, y1: GROUND }, { samples: 4, rays: 16 }).floors[0]
      // Doc §12 dead-end share 0.15–0.3.
      expect(f.deadEndSpaces / f.spaces, seed).toBeGreaterThanOrEqual(0.15)
      expect(f.deadEndSpaces / f.spaces, seed).toBeLessThanOrEqual(0.3)
    }
    expect(fields.size).toBe(KIND_SEEDS.length)
  })

  it('glazes the attractions and reflects the mirror maze with exactly one lie', () => {
    const lies = new Set()
    for (const seed of KIND_SEEDS) {
      const { map, res } = build(seed)
      // Glass maze: doc §4.3 step 3, 60–90% of a module's walls glass.
      const [gx0, gz0, gw, gd] = note(res, /^glass maze at (\d+),(\d+) \((\d+)x(\d+)\)/)
      expect(gw >= 4 && gw <= 6 && gd >= 4 && gd <= 6, seed).toBe(true)
      const g = wallsIn(map, GROUND, { x0: gx0, z0: gz0, x1: gx0 + gw - 1, z1: gz0 + gd - 1 })
      expect(g.glass / g.walls, seed).toBeGreaterThanOrEqual(0.6)
      expect(g.glass / g.walls, seed).toBeLessThanOrEqual(0.9)
      // Mirror maze: a 3×(4..6) half reflected across a line of glass.
      const [mx0, mz0, mw, md] = note(res, /^mirror maze at (\d+),(\d+) \((\d+)x(\d+)/)
      expect(mw, seed).toBe(6)
      expect(md >= 4 && md <= 6, seed).toBe(true)
      const line = mx0 + 3
      for (let z = mz0; z < mz0 + md; z++) expect(map.wallVAt(line, GROUND, z).feature, `${seed} line z ${z}`).toBe(WALL_WINDOW)
      const m = wallsIn(map, GROUND, { x0: mx0, z0: mz0, x1: mx0 + 5, z1: mz0 + md - 1 })
      expect((m.glass - md) / (m.walls - md), seed).toBeGreaterThanOrEqual(0.55)
      const sig = (w) => `${w.wall}/${w.feature}`
      let diffs = 0
      for (let z = mz0; z < mz0 + md; z++) {
        for (let x = mx0; x < line; x++) {
          const rx = 2 * line - 1 - x
          expect(map.cellAt(rx, GROUND, z).kind, `${seed} ${rx},${z}`).toBe(map.cellAt(x, GROUND, z).kind)
          if (x > mx0 && sig(map.wallVAt(x, GROUND, z)) !== sig(map.wallVAt(2 * line - x, GROUND, z))) diffs++
          if (z > mz0 && sig(map.wallHAt(x, GROUND, z)) !== sig(map.wallHAt(rx, GROUND, z))) diffs++
        }
        // The entrance is reflected too: west wall and east wall open on the same row.
        expect(map.wallVAt(mx0, GROUND, z).wall, `${seed} entry z ${z}`).toBe(map.wallVAt(mx0 + 6, GROUND, z).wall)
      }
      const [lie, lx, lz] = note(res, /^mirror lie: (\w+) at (\d+),(\d+)/)
      expect(FUNHOUSE_LIES).toContain(lie)
      lies.add(lie)
      expect(diffs, seed).toBe(lie === 'panel' ? 1 : 0)
      const mirrorLamps = lamps(map, GROUND).filter((l) => l.gx >= mx0 && l.gx <= mx0 + 5 && l.gz >= mz0 && l.gz < mz0 + md)
      expect(mirrorLamps, seed).toHaveLength(2)
      expect(mirrorLamps[0].tint, seed).toBe(mirrorLamps[1].tint)
      expect(mirrorLamps.filter((l) => l.lit), seed).toHaveLength(lie === 'lamp' ? 1 : 2)
      const figures = furniture(map, GROUND).filter((f) => f.kind === PROP_MASCOT && f.gx >= mx0 && f.gx <= mx0 + 5 && f.gz >= mz0 && f.gz < mz0 + md)
      expect(figures.map((f) => `${f.gx},${f.gz}`), seed).toEqual(lie === 'figure' ? [`${lx},${lz}`] : [])
    }
    expect(lies.size).toBeGreaterThanOrEqual(2)
  })

  it('lets glass lie about the extent: apparent sight ≥ 3× real in the mirror maze', () => {
    for (const seed of ['proto', 'liminal-0', 'liminal-1', 'liminal-2']) {
      const { map, res } = build(seed)
      const [mx0, mz0, md] = note(res, /^mirror maze at (\d+),(\d+) \(6x(\d+)/)
      const areas = () => {
        const a = []
        for (let z = mz0; z < mz0 + md; z++) {
          for (let x = mx0; x <= mx0 + 5; x++) if (!map.cellAt(x, GROUND, z).col) a.push(isovist(map, GROUND, x, z, { rays: 48, range: 48 }).area)
        }
        return median(a)
      }
      const apparent = areas()
      // The real maze: the same walls, every pane opaque.
      for (const d of map.chunks.values()) {
        if (d.cy !== GROUND) continue
        d.wallFeatureV.fill(WALL_PLAIN)
        d.wallFeatureH.fill(WALL_PLAIN)
      }
      // Doc §12: apparent isovist median ≥ 3× the real one (measured 3.6–6.6).
      expect(apparent / areas(), seed).toBeGreaterThanOrEqual(3)
    }
    // Doc §12 mirror/glass share per pavilion 0.2–0.4: over every wall
    // between two walkable cells of the ground storey (booths, stock rooms,
    // attractions and maze alike).
    for (const seed of KIND_SEEDS) {
      const { map } = build(seed)
      const p = wallsIn(map, GROUND, { x0: 0, z0: 0, x1: 41, z1: 27 })
      expect(p.glass / p.walls, seed).toBeGreaterThanOrEqual(0.2)
      expect(p.glass / p.walls, seed).toBeLessThanOrEqual(0.4)
    }
  })

  it('runs a dark ride of UV-lit scenes and dresses the midway', () => {
    for (const seed of KIND_SEEDS) {
      const { map, res } = build(seed)
      const [scenes, uvLit] = note(res, /^dark ride: (\d+) scenes \((\d+) UV-lit\)/)
      // Doc §4.2: 6–10 scene bays of 2×2 on the loop.
      expect(scenes, seed).toBeGreaterThanOrEqual(6)
      expect(scenes, seed).toBeLessThanOrEqual(10)
      const ride = lamps(map, RIDE)
      const uv = ride.filter((l) => l.tint === UV)
      expect(uv, seed).toHaveLength(scenes)
      expect(uv.filter((l) => l.lit).length, seed).toBe(uvLit)
      expect(uvLit, seed).toBeGreaterThanOrEqual(1)
      // The ride's public cells (track, platform, walkways) are dark but for
      // one platform light; only backstage work lights burn elsewhere.
      const sk = skeletonOf(seedFromText(seed), 0)
      const isTrack = (x, z) => x >= 0 && z >= 0 && x < TILE_CELLS_X && sk.track[z * TILE_CELLS_X + x] === 1
      const platform = new Set(sk.platform.cells.flat().map((c) => `${c.gx},${c.gz}`))
      const walks = new Set([...sk.stairA.path, ...sk.stairB.path].map((c) => `${c.gx},${c.gz}`))
      const publicLit = ride.filter((l) => l.tint !== UV && l.lit && (isTrack(l.gx, l.gz) || platform.has(`${l.gx},${l.gz}`) || walks.has(`${l.gx},${l.gz}`)))
      expect(publicLit.map((l) => platform.has(`${l.gx},${l.gz}`)), seed).toEqual([true])
      // Bump doors: two door edges across the 2-wide track per bump door.
      const [bumps] = note(res, /, (\d+) bump doors,/)
      expect(bumps >= 3 && bumps <= 6, seed).toBe(true)
      let doors = 0
      for (let z = 0; z < 28; z++) {
        for (let x = 0; x < TILE_CELLS_X; x++) {
          if (!isTrack(x, z)) continue
          if (isTrack(x + 1, z) && map.wallVAt(x + 1, RIDE, z).passage === PASSAGE_DOOR) doors++
          if (isTrack(x, z + 1) && map.wallHAt(x, RIDE, z + 1).passage === PASSAGE_DOOR) doors++
        }
      }
      expect(doors, seed).toBe(2 * bumps)
      // A figure has left its scene (doc §10 anomaly 8).
      expect(furniture(map, RIDE).filter((f) => f.kind === PROP_MASCOT), seed).toHaveLength(1)
      // Ground props: the CCTV desk in the attendant booth (ticket windows
      // and the lobby may carry the ticket seller's monitor too), the ball
      // track in the level room, counters in the midway booths.
      const ground = furniture(map, GROUND)
      const cctv = ground.filter((f) => f.kind === PROP_CCTV)
      const [ax, az, cx, cz] = note(res, /^attendant booth at (\d+),(\d+) \(CCTV at (\d+),(\d+)\)/)
      expect(cctv.map((f) => `${f.gx},${f.gz}`), seed).toContain(`${cx},${cz}`)
      expect(cx - ax, seed).toBe(1)
      expect(Math.abs(cz - az) <= 2, seed).toBe(true)
      const [tx, tz] = note(res, /^level room at (\d+),(\d+)/)
      const track = ground.filter((f) => f.kind === PROP_BALL_TRACK && f.gx >= tx && f.gx <= tx + 1 && f.gz >= tz && f.gz <= tz + 1)
      expect(track, seed).toHaveLength(1)
      expect(track[0].gx - tx, seed).toBe(1)
      expect(Math.abs(track[0].gz - tz) <= 1, seed).toBe(true)
      expect(ground.filter((f) => f.kind === FURN_COUNTER).length, seed).toBeGreaterThanOrEqual(5)
      // Tables and chairs (no PIECE_DIMS entry) carry their real footprint,
      // the box collision uses, and wall-huggers sit flush to the wall.
      const sized = [...ground, ...furniture(map, RIDE)].filter((f) => f.kind === FURN_TABLE || f.kind === FURN_CHAIR)
      expect(sized.some((f) => f.kind === FURN_CHAIR), seed).toBe(true)
      for (const f of sized) {
        const [w0, d0] = f.kind === FURN_TABLE ? [TABLE_W, TABLE_D] : [CHAIR_W, CHAIR_W]
        const alongX = f.facing === FACING.E || f.facing === FACING.W
        expect([f.w, f.d], `${seed} ${f.gx},${f.gz}`).toEqual(alongX ? [d0, w0] : [w0, d0])
        const off = Math.abs(alongX ? f.x - (f.lx + 0.5) * CELL : f.z - (f.lz + 0.5) * CELL)
        if (off > 1e-9) expect(off, `${seed} ${f.gx},${f.gz}`).toBeCloseTo(CELL / 2 - THICK / 2 - (alongX ? f.w : f.d) / 2 - 0.06, 9)
      }
    }
    const { map, res } = build('proto')
    expect(map.meta.palette).toBe('funhouseNeon')
    for (const d of map.chunks.values()) expect(d.levelLabel).toBe(d.cy === GROUND ? 'FUn' : 'nUF')
    expect(res.spawn).toEqual({ gx: 10, gz: 5, cy: GROUND })
    // The kind seals the midway at its east end (x 40, the east port's rows).
    const ez = skeletonOf(seedFromText('proto'), 0).midLo[40]
    expect(map.chunkAt(2, GROUND, Math.floor(ez / CHUNK)).exit).toEqual({ lx: 12, lz: ez % CHUNK })
  })
})
