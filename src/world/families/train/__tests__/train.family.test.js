import { describe, expect, it } from 'vitest'
import { CHUNK, cIdx, chunkKey3, hIdx, vIdx } from '../../../constants.js'
import { hash2i } from '../../../core/hash.js'
import { auditLayeredPatch } from '../../../audit.js'
import { resolveMapFamily } from '../../../mapFamily.js'
import { CELL_LOBBY, COLUMN_STANDARD, PASSAGE_DOOR, PASSAGE_WIDE, WALL_WINDOW } from '../../../mapTypes.js'
import { FURN_BED, FURN_DESK, FURN_WARDROBE } from '../../../rooms/catalog.js'
import { PROP_METRO_BENCH, PROP_SEAT_PAIR } from '../../../props/index.js'
import { makeTileCtx, tileBakeAt } from '../../../tiles/familyChunk.js'
import { cellWalkable } from '../../../tiles/holeMasks.js'
import { fastPathMassMask } from '../../../tiles/massMask.js'
import { massLeakAudit } from '../../../tiles/seams.js'
import { isSolidMassChunk, solidChunk } from '../../../tiles/solidChunk.js'
import { TileCanvas } from '../../../tiles/TileCanvas.js'
import { tileSeed, tileWindow } from '../../../tiles/tileKey.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familyGenerator } from '../../generators.js'
import { familyExitHook, familySpawn, hookOf } from '../../hooks.js'
import { familyPlanner } from '../../planners.js'
import { componentPartition, windowConnectivity, worldSource } from '../../reach.js'
import { STRUCTURAL_COUNTERS, plannerKeySweep, runFamilySuite } from '../../__tests__/familyHarness.js'
import {
  ANOMALY_CLASSES,
  CAR_TYPES,
  STATIONS,
  TILE,
  UNLISTED,
  carPlateOf,
  exitAnchor,
  exitTileOf,
  footprint,
  isStation,
  periodAnomaly,
  periodCars,
  periodCount,
  portRow0,
  ports,
  skeleton,
  stationNameOf,
  stationPlatesOf,
  tileAnomalies,
  trainKey,
  wrongSideOf,
} from '../geometry.js'
import { trainPlates } from '../plates.js'

// The train family suite (spec §11.1, §12.10): W = 3×1 tiles × storeys 0..1;
// the decision-6 window is 8 tiles × [0, 1].
runFamilySuite('train', {
  window: { tiles: [3, 1], storeys: [0, 1] },
  connWindow: { tiles: [8, 1], storeys: [0, 1] },
})

// --- train specifics (§12.10 Tests, rebuilt as a grammar) ------------------------------

const ID = 'train'
const config = forcedFamilyConfig(ID)
const profile = resolveMapFamily(config)
const gen = familyGenerator(ID)
const planner = familyPlanner(ID)
const SEEDS = [1, 0x5eed, 777]
const TC = TILE.w * CHUNK // 56 cells per tile

const TRAIN = 0
const CONC = 1
const rowBox = (tx0, tx1, y0 = 0, y1 = 1) => ({ x0: tx0 * 4, z0: 0, x1: tx1 * 4 + 3, z1: 0, y0, y1 })
const at = (src, gx, cy, gz) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { d: src.chunkAt(cx, cy, cz), lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}
const walkable = (src, gx, cy, gz) => {
  const c = at(src, gx, cy, gz)
  return cellWalkable(c.d, c.lx, c.lz)
}
const vEdge = (src, gx, cy, gz) => {
  const c = at(src, gx, cy, gz)
  const i = vIdx(c.lx, c.lz)
  return { wall: c.d.wallV[i], passage: c.d.passageV[i], feature: c.d.wallFeatureV[i] }
}
const hEdge = (src, gx, cy, gz) => {
  const c = at(src, gx, cy, gz)
  const i = hIdx(c.lx, c.lz)
  return { wall: c.d.wallH[i], passage: c.d.passageH[i], feature: c.d.wallFeatureH[i] }
}
const piecesAt = (src, gx, cy, gz) => {
  const c = at(src, gx, cy, gz)
  return c.d.furniture.filter((f) => f.lx === c.lx && f.lz === c.lz).map((f) => f.kind)
}

// The repeat metric (scratchpad repeat/sim.mjs): a tile's wall and column set.
function tileSet(src, tx, cy) {
  const s = new Set()
  for (let dx = 0; dx < TILE.w; dx++) {
    const c = src.chunkAt(tx * TILE.w + dx, cy, 0)
    for (let i = 0; i < CHUNK * CHUNK; i++) {
      const k = `${dx},0,${i}`
      if (c.wallV[i]) s.add('v' + k)
      if (c.wallH[i]) s.add('h' + k)
      if (c.cols[i]) s.add('c' + k + ':' + c.cols[i])
    }
  }
  return s
}
const jaccard = (a, b) => {
  let i = 0
  for (const x of a) if (b.has(x)) i++
  return i / (a.size + b.size - i || 1)
}

describe('train family (§12.10)', () => {
  it('tile, footprint and ports: 4×1 chunks, rows [0], both storeys everywhere, the gangway hashed per seam, storey 1 sealed', () => {
    expect(TILE).toMatchObject({ w: 4, d: 1, backend: 'band', H: 2, lo: 0, hi: 1, rows: [0], salt: 0x5a17000e })
    for (const seed of SEEDS) {
      const rows0 = new Set()
      for (let tx = -20; tx <= 20; tx++) {
        const row = (cy, cz = 0) => [0, 1, 2, 3].map((i) => footprint(seed, tx * 4 + i, cy, cz))
        expect(row(0)).toEqual(['tile', 'tile', 'tile', 'tile'])
        expect(row(1)).toEqual(['tile', 'tile', 'tile', 'tile'])
        for (const [cy, cz] of [[0, 1], [0, -1], [1, 1], [2, 0], [-1, 0]]) expect(row(cy, cz)).toEqual(['solid', 'solid', 'solid', 'solid'])
        const p = portRow0(seed, tx)
        expect(ports(seed, { tx, tz: 0 }, 'west', 0)).toEqual([{ a0: p, a1: p }])
        // Storey 1 has no seam port: each upper pocket is its own stairs'.
        expect(ports(seed, { tx, tz: 0 }, 'west', 1)).toEqual([])
        expect(ports(seed, { tx, tz: 0 }, 'north', 0)).toEqual([])
        expect(ports(seed, { tx, tz: 0 }, 'north', 1)).toEqual([])
        expect(p >= 3 && p <= 9).toBe(true)
        rows0.add(p)
      }
      // The seams are not one fixed row.
      expect(rows0.size, `seed ${seed} storey-0 port rows`).toBeGreaterThanOrEqual(5)
    }
    expect(plannerKeySweep(planner, TILE, 1, profile, config)).toMatchObject({ keys: 2000, nulls: 0, ruleErrors: [] })
  })

  it('every tile is composed, not copied: car sequences, the path and the station layouts vary; wall/column Jaccard over 12 tiles ≤ 0.25 mean, ≤ 0.45 max on both storeys', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const cy of [TRAIN, CONC]) {
        const sets = Array.from({ length: 12 }, (_, a) => tileSet(src, 2 * a + 1, cy))
        let sum = 0
        let n = 0
        let max = 0
        for (let i = 0; i < sets.length; i++) {
          for (let j = i + 1; j < sets.length; j++) {
            const v = jaccard(sets[i], sets[j])
            sum += v
            n++
            max = Math.max(max, v)
          }
        }
        expect(sum / n, `seed ${seed} storey ${cy} mean`).toBeLessThanOrEqual(0.25)
        expect(max, `seed ${seed} storey ${cy} max`).toBeLessThanOrEqual(0.45)
      }
      // The skeleton's own variety over 41 tiles.
      const seqs = new Set()
      const paths = new Set()
      const counts = new Set()
      const lens = new Set()
      const types = new Set()
      const layouts = new Set()
      const sides = new Set()
      const coreCounts = new Set()
      for (let tx = -20; tx <= 20; tx++) {
        const sk = skeleton(seed, tx)
        seqs.add(sk.cars.map((c) => c.type).join(','))
        paths.add(sk.cars.map((c) => `${c.x0}:${c.aisle}`).join(','))
        counts.add(sk.n)
        for (const c of sk.cars) {
          lens.add(c.len)
          types.add(c.type)
          expect(c.len).toBe(CAR_TYPES[c.type].len)
        }
        expect(sk.cars.reduce((a, c) => a + c.len, 0)).toBe(TC)
        expect(sk.cars.filter((c) => c.dark).length).toBeLessThanOrEqual(1)
        coreCounts.add(sk.cores.length)
        const st = sk.station
        expect(!!st).toBe(isStation(seed, tx))
        if (st) {
          sides.add(st.side)
          layouts.add(JSON.stringify([st.side, st.w, st.platforms[0].x0, st.platforms[0].x1, sk.cores.map((c) => c.x0)]))
        }
      }
      expect(seqs.size, `seed ${seed} car sequences`).toBeGreaterThanOrEqual(35)
      expect(paths.size, `seed ${seed} paths`).toBeGreaterThanOrEqual(38)
      expect([...counts].sort()).toEqual([7, 8])
      expect([...lens].sort()).toEqual([6, 7, 8, 9])
      expect(types.size).toBeGreaterThanOrEqual(5)
      expect(sides.size, `seed ${seed} platform sides`).toBeGreaterThanOrEqual(2)
      const stations = [...Array(41).keys()].filter((i) => isStation(seed, i - 20)).length
      expect(layouts.size, `seed ${seed} station layouts`).toBeGreaterThanOrEqual(Math.ceil(stations * 0.9))
      expect(coreCounts.size).toBeGreaterThanOrEqual(2)
    }
  })

  it('the gangway chain over 12 tiles: one snaking aisle through a door on every car joint (seams included), car ends walled', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      const seen = { commuter: 0, open: 0, sleeper: 0, dining: 0 }
      let jogs = 0
      for (let tx = -6; tx < 6; tx++) {
        const sk = skeleton(seed, tx)
        const ox = tx * TC
        expect(sk.cars[0].aisle).toBe(portRow0(seed, tx))
        expect(sk.cars[sk.n - 1].aisle).toBe(portRow0(seed, tx + 1))
        for (const car of sk.cars) {
          for (let x = car.x0; x <= car.x1; x++) expect(walkable(src, ox + x, TRAIN, car.aisle), `${seed} aisle ${tx}:${x}`).toBe(true)
        }
        for (const j of sk.joints) {
          const line = ox + j.x
          expect(vEdge(src, line, TRAIN, j.z), `${seed} gangway ${tx}:${j.x}`).toMatchObject({ wall: 0, passage: PASSAGE_DOOR })
          const east = sk.cars[j.east]
          const west = j.west >= 0 ? sk.cars[j.west] : skeleton(seed, tx - 1).cars.at(-1)
          if (Math.abs(east.aisle - west.aisle) === 1) jogs++
          expect(Math.abs(east.aisle - west.aisle)).toBeLessThanOrEqual(1)
          const rows = new Set([east.aisle - 1, east.aisle, east.aisle + 1, west.aisle - 1, west.aisle, west.aisle + 1])
          rows.delete(j.z)
          for (const z of rows) expect(vEdge(src, line, TRAIN, z).wall, `${seed} car end ${tx}:${j.x},${z}`).toBe(1)
        }
        // Seats by car type, in a seat bay of each lit car.
        for (const car of sk.cars) {
          if (!(car.type in seen)) continue
          const want = { commuter: [PROP_METRO_BENCH], open: [PROP_SEAT_PAIR], sleeper: [FURN_BED, FURN_WARDROBE], dining: [FURN_DESK] }[car.type]
          let hit = false
          for (let b = 0; b < car.len && !hit; b++) {
            for (const s of [-1, 1]) if (piecesAt(src, ox + car.x0 + b, TRAIN, car.aisle + s).some((k) => want.includes(k))) hit = true
          }
          if (hit) seen[car.type]++
        }
      }
      expect(jogs, `${seed} the train snakes`).toBeGreaterThan(20)
      for (const [t, n] of Object.entries(seen)) expect(n, `${seed} ${t} seats`).toBeGreaterThan(0)
      // One component holds the whole chain, end to end.
      const comps = componentPartition(src, rowBox(-6, 5, 0, 0))
      const first = `${-6 * TC},${skeleton(seed, -6).cars[0].aisle},0`
      const last = skeleton(seed, 5).cars.at(-1)
      const chain = comps.find((c) => c.includes(first))
      expect(chain.includes(`${5 * TC + last.x1},${last.aisle},0`)).toBe(true)
    }
  })

  it('a station within any 3 tiles: platforms, wide doors, 1–3 cores at the skeleton\'s places and a concourse; plain tiles get service stairs', () => {
    for (const seed of [...SEEDS, 2, 3, 4, 5, 6, 7, 8]) {
      let gap = 0
      for (let tx = -40; tx <= 40; tx++) {
        gap = isStation(seed, tx) ? 0 : gap + 1
        expect(gap, `seed ${seed} tile ${tx}`).toBeLessThanOrEqual(2)
      }
    }
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (let tx = -3; tx <= 3; tx++) {
        const sk = skeleton(seed, tx)
        const st = sk.station
        const ox = tx * TC
        if (st) {
          for (const p of st.platforms) {
            for (let z = p.z0; z <= p.z1; z++) {
              for (let x = p.x0; x <= p.x1; x++) {
                const c = at(src, ox + x, TRAIN, z)
                expect(c.d.cellKind[cIdx(c.lx, c.lz)], `${seed} platform ${tx}:${x},${z}`).toBe(CELL_LOBBY)
              }
            }
            const s = p.side === 'S' ? 1 : -1
            for (let k = st.s; k <= st.e; k++) {
              const car = sk.cars[k]
              // A wrongSide car of a both-sides station keeps its doors onto
              // the stairs' platform shut (the platform on the wrong side).
              const shut = st.side === 'B' && p.side === st.coreSide && tileAnomalies(seed, tx).some((m) => m.car === k && m.cls === 'wrongSide')
              for (const b of CAR_TYPES[car.type].doors) {
                const z = s > 0 ? car.aisle + 2 : car.aisle - 1
                const e = hEdge(src, ox + car.x0 + b, TRAIN, z)
                if (shut) expect(e.wall).toBe(1)
                else expect(e, `${seed} wide door ${tx} car ${k}`).toMatchObject({ wall: 0, passage: PASSAGE_WIDE })
              }
            }
          }
          const C = st.concourse
          for (let z = C.z0; z <= C.z1; z++) {
            for (let x = C.x0; x <= C.x1; x++) {
              const c = at(src, ox + x, CONC, z)
              expect(c.d.cellKind[cIdx(c.lx, c.lz)], `${seed} concourse ${tx}:${x},${z}`).toBe(CELL_LOBBY)
            }
          }
          expect(sk.cores.length).toBeGreaterThanOrEqual(1)
          expect(sk.cores.length).toBeLessThanOrEqual(3)
        } else expect(sk.cores.length).toBeGreaterThanOrEqual(1)
        const coreChunks = new Set(sk.cores.map((c) => c.chunk))
        for (const i of [0, 1, 2, 3]) {
          const has = coreChunks.has(i)
          expect(!!src.chunkAt(tx * 4 + i, TRAIN, 0).stairUp, `${seed} core up ${tx},${i}`).toBe(has)
          expect(!!src.chunkAt(tx * 4 + i, CONC, 0).stairDown, `${seed} core down ${tx},${i}`).toBe(has)
          expect(planner.verticalOpeningAt(seed, tx * 4 + i, 0, TRAIN, profile, config)).toBe(has)
          expect(isSolidMassChunk(src.chunkAt(tx * 4 + i, CONC, 0))).toBe(false)
        }
        // Every core's door opens onto a walkable cell on both storeys.
        for (const c of sk.cores) for (const cy of [TRAIN, CONC]) expect(walkable(src, ox + c.door.x, cy, c.door.z), `${seed} core door ${tx}`).toBe(true)
      }
    }
  })

  it('the unlisted plate: the exit station (the second east of tile 0) reads nonE; the exit is its closet', () => {
    const hooks = hookOf(ID)
    expect(hooks.stub).toBe(false)
    const names = new Set(STATIONS.flat())
    expect(names.has(UNLISTED)).toBe(false)
    for (const seed of [...SEEDS, 4242, 99, 12345]) {
      const src = worldSource(seed, config)
      const ex = exitTileOf(seed)
      const east = []
      for (let tx = 1; east.length < 2; tx++) if (isStation(seed, tx)) east.push(tx)
      expect(ex).toBe(east[1])
      const st = skeleton(seed, ex).station
      for (const c of st.chunks0) expect(src.chunkAt(ex * 4 + c, TRAIN, 0).levelLabel, `${seed} exit label cy 0`).toBe(UNLISTED)
      for (const c of st.chunks1) expect(src.chunkAt(ex * 4 + c, CONC, 0).levelLabel, `${seed} exit label cy 1`).toBe(UNLISTED)
      for (let tx = -3; tx <= 8; tx++) {
        if (tx === ex || !isStation(seed, tx)) continue
        const sk = skeleton(seed, tx)
        expect(src.chunkAt(tx * 4 + sk.station.chunks0[0], TRAIN, 0).levelLabel, `${seed} station ${tx}`).toBe(stationNameOf(seed, tx)[0])
        for (const c of sk.station.chunks1) expect(names.has(src.chunkAt(tx * 4 + c, CONC, 0).levelLabel)).toBe(true)
      }
      const sp = familySpawn(config, seed)
      expect([sp.cx * CHUNK + sp.lx, sp.cz * CHUNK + sp.lz]).toEqual([3, portRow0(seed, 0)])
      const e = familyExitHook(config)({ worldSeed: seed, level: 1, config, profile, generate: src.chunkAt })
      expect(e).toEqual(hooks.exitAnchor(seed, profile))
      expect(e).toEqual(exitAnchor(seed))
      const cl = st.closet
      const gx = e.cx * CHUNK + e.lx - ex * TC
      expect(gx >= cl.x0 && gx <= cl.x1 && e.lz >= cl.z0 && e.lz <= cl.z1 && e.cy === CONC).toBe(true)
      expect(hooks.proofBox(e, sp)).toEqual({ chunks: { x0: 0, z0: 0, x1: ex * 4 + 3, z1: 0 }, cy: [0, 1] })
      expect(tileAnomalies(seed, ex)).toEqual([])
    }
    expect(hooks.exitHookStats.lastResort).toBe(0)
  })

  it('glass only where it looks onto a walkway, the platform or deep enough mass; the columns behind it are kept', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      let panes = 0
      let deep = 0
      for (let cx = -8; cx < 8; cx++) {
        const d = src.chunkAt(cx, TRAIN, 0)
        const mask = fastPathMassMask(d)
        expect(mask, 'the train takes the mass fast path').toBeTruthy()
        for (let lx = 0; lx < CHUNK; lx++) {
          for (let line = 1; line < CHUNK; line++) {
            const i = hIdx(lx, line)
            if (!d.wallH[i] || d.wallFeatureH[i] !== WALL_WINDOW) continue
            panes++
            // From the walkable side, walk out through the mass.
            const north = cellWalkable(d, lx, line - 1)
            const s = north ? 1 : -1
            let z = north ? line : line - 1
            let m = 0
            while (z >= 0 && z < CHUNK && d.cols[cIdx(lx, z)] === COLUMN_STANDARD) {
              if (m < 4) expect(mask[cIdx(lx, z)], `${seed} column behind glass ${cx},${lx},${z}`).toBe(0)
              m++
              z += s
            }
            if (m) deep++
            expect(m === 0 || m >= 4 || (z >= 0 && z < CHUNK), `${seed} thin mass behind glass ${cx},${lx},${line}`).toBe(true)
          }
        }
      }
      expect(panes).toBeGreaterThan(100)
      expect(deep).toBeGreaterThan(10)
      const audit = massLeakAudit(src.chunkAt, { ...rowBox(-2, 1), z0: -1, z1: 1 }, { gen, worldSeed: seed })
      expect(audit.details.seeThroughThinMass).toEqual([])
      expect(audit.details.seeThroughToSolid).toEqual([])
    }
  })

  it('anomalies: 1 per period of ~3 cars, one per car at most, rotated, hashed per seed, never near spawn, in the exit tile or on the dark car', () => {
    const layouts = new Set()
    const seen = new Set()
    for (const seed of [...SEEDS, 2, 3, 4, 5, 6]) {
      const ex = exitTileOf(seed)
      let open = 0
      let found = 0
      let prev = null
      const sig = []
      for (let tx = -30; tx <= 30; tx++) {
        const sk = skeleton(seed, tx)
        const m = periodCount(seed, tx)
        expect(m).toBe(Math.round(sk.n / 3))
        for (let i = 0; i < m; i++) {
          const a = periodAnomaly(seed, tx, i)
          sig.push(a ? `${a.j}${a.cls[0]}` : '-')
          const [j0, j1] = periodCars(sk.n, i)
          const blockedTile = tx === 0 || tx === ex
          const free = []
          for (let j = j0; j <= j1; j++) {
            const nearSpawn = (tx === -1 && j >= sk.n - 3) || (tx === 1 && j < 3)
            if (!blockedTile && !nearSpawn && !sk.cars[j].dark) free.push(j)
          }
          if (free.length) open++
          if (a) {
            found++
            seen.add(a.cls)
            expect(free).toContain(a.j)
            if (a.cls === 'stationName') expect(a.j >= sk.station.s && a.j <= sk.station.e).toBe(true)
            // doc 14: never the same class twice in a row.
            if (prev) expect(a.cls, `seed ${seed} ${tx}:${i}`).not.toBe(prev)
            expect(periodAnomaly(seed, tx, i)).toEqual(a)
            prev = a.cls
          } else prev = null
        }
        const list = tileAnomalies(seed, tx)
        expect(new Set(list.map((q) => q.car)).size).toBe(list.length)
      }
      // Every period with an open car carries one: the rotation drops none.
      expect(found, `seed ${seed} cadence`).toBe(open)
      layouts.add(sig.join(' '))
    }
    expect(layouts.size).toBe(8)
    expect([...seen].sort()).toEqual([...ANOMALY_CLASSES].sort())
  })

  it('anomalies in the world: a lying plate, doors onto the tunnel wall, a drifting name and a blackout, all sealed and connected', () => {
    const found = {}
    for (const seed of [...SEEDS, 2, 3, 4, 5]) {
      for (let tx = -12; tx <= 12; tx++) for (const m of tileAnomalies(seed, tx)) found[m.cls] ??= { seed, tx, car: m.car }
    }
    expect(Object.keys(found).sort()).toEqual([...ANOMALY_CLASSES].sort())
    // A lying plate: both panels of the car repeat the previous number.
    {
      const { seed, tx, car } = found.carNumbers
      const src = worldSource(seed, config)
      const sk = skeleton(seed, tx)
      const lie = carPlateOf(seed, tx, car)
      expect(lie).not.toBe(`C${car + 1}`)
      const j = sk.joints[car]
      const cx = tx * 4 + Math.floor(j.x / CHUNK)
      const panel = trainPlates(src.chunkAt(cx, TRAIN, 0)).find((p) => p.axis === 'v' && p.line === j.x % CHUNK && p.cell === j.z && p.side === 1)
      expect(panel?.number).toBe(lie)
    }
    // Doors onto the wall: wide openings on the car's away side into
    // walkable niches (or the walkway already there).
    {
      const { seed, tx, car } = found.wrongSide
      const src = worldSource(seed, config)
      const sk = skeleton(seed, tx)
      const c = sk.cars[car]
      const s = wrongSideOf(seed, tx, car)
      const shut = sk.station?.side === 'B' && car >= sk.station.s && car <= sk.station.e
      let open = 0
      for (const b of CAR_TYPES[c.type].doors) {
        if (shut) {
          // The platform on the wrong side: the doors onto the stairs' platform are wall.
          expect(hEdge(src, tx * TC + c.x0 + b, TRAIN, s > 0 ? c.aisle + 2 : c.aisle - 1).wall).toBe(1)
          open++
          continue
        }
        const x = tx * TC + c.x0 + b
        const line = s > 0 ? c.aisle + 2 : c.aisle - 1
        if (c.aisle + 2 * s < 0 || c.aisle + 2 * s > 12) continue
        const e = hEdge(src, x, TRAIN, line)
        if (e.wall === 0 && e.passage === PASSAGE_WIDE) {
          open++
          expect(walkable(src, x, TRAIN, c.aisle + 2 * s)).toBe(true)
        }
      }
      expect(open).toBeGreaterThan(0)
      const res = windowConnectivity(src, rowBox(Math.min(tx, 0), Math.max(tx, 0)), rowBox(Math.min(tx, 0) - 1, Math.max(tx, 0) + 1), familySpawnCell(seed))
      expect({ ok: res.ok, stranded: res.stranded, sealed: res.sealed, pockets: res.pockets }).toEqual({ ok: true, stranded: [], sealed: [], pockets: [] })
    }
    // A drifting name: the later station chunks' boards and labels drift.
    {
      const { seed, tx } = found.stationName
      const src = worldSource(seed, config)
      const [name, drift] = stationNameOf(seed, tx)
      expect([...name].filter((ch, i) => ch !== drift[i]).length).toBe(1)
      for (const cy of [TRAIN, CONC]) {
        const plates = stationPlatesOf(seed, tx, cy)
        expect(plates.length).toBeGreaterThanOrEqual(2)
        expect(plates.map((p) => p.name)).toEqual(plates.map((_, i) => (i ? drift : name)))
        for (const p of plates) expect(src.chunkAt(tx * 4 + p.chunk, cy, 0).levelLabel).toBe(p.name)
      }
    }
    // A blackout: every tube of the car dead, its seats kept.
    {
      const { seed, tx, car } = found.blackout
      const src = worldSource(seed, config)
      const c = skeleton(seed, tx).cars[car]
      const lamps = []
      for (let x = c.x0; x <= c.x1; x++) {
        const q = at(src, tx * TC + x, TRAIN, c.aisle)
        lamps.push(...q.d.lamps.filter((l) => l.lx === q.lx && l.lz === q.lz))
      }
      expect(lamps.length).toBeGreaterThan(0)
      expect(lamps.every((l) => !l.lit)).toBe(true)
      let seats = 0
      for (let x = c.x0; x <= c.x1; x++) for (const s of [-1, 1]) seats += piecesAt(src, tx * TC + x, TRAIN, c.aisle + s).length
      expect(seats).toBeGreaterThan(0)
      const outer = { ...rowBox(tx - 1, tx + 1), z0: -1, z1: 1 }
      const audit = massLeakAudit(src.chunkAt, outer, { gen, worldSeed: seed })
      expect(audit.details).toEqual({ leaks: [], seals: [], portViolations: [], seeThroughToSolid: [], seeThroughThinMass: [] })
      const lay = auditLayeredPatch(src.chunkAt, tx * 4, 0, 0, 4, 2, 1)
      expect(Object.fromEntries(STRUCTURAL_COUNTERS.filter((k) => lay[k]).map((k) => [k, lay[k]]))).toEqual({})
    }
  })

  it('a forced attempt-1 bake (new tileSeed, same planSeed) bakes the same clean tile; the bake exports both storeys', () => {
    for (const seed of SEEDS) {
      for (const tx of [-2, 0, 1, 4]) {
        const k = trainKey(tx)
        const win = tileWindow(TILE, k)
        const keep = (cx, cy, cz) => cx >= win.cx0 && cx <= win.cx1 && cz >= win.cz0 && cz <= win.cz1 && cy >= k.cy0 && cy <= k.cy1 &&
          footprint(seed, cx, cy, cz) === 'tile'
        const canvas = new TileCanvas({
          family: ID, base: 'tower', version: config.version, worldSeed: seed, origin: k.origin, district: { dx: tx, dz: 0 }, keep,
          solidChunk: (cx, cy, cz) => solidChunk(seed, cx, cy, cz, config, ID, { district: { dx: tx, dz: 0 } }),
        })
        const planSeed = tileSeed(seed, TILE.salt, k)
        const ctx = makeTileCtx(gen, profile, seed, config, k, canvas, { tileSeed: hash2i(planSeed, 1, 0x7e) >>> 0, planSeed, attempt: 1 })
        let res = null
        expect(() => { res = gen.bake(canvas, ctx) }).not.toThrow()
        expect(res?.error).toBeUndefined()
        expect(ctx.notes.filter((n) => /^(kit|seam):|fallback|stranded/.test(n))).toEqual([])
        expect(ctx.exits.length).toBe(isStation(seed, tx) ? 4 : 0)
        const bake = tileBakeAt(seed, k, config)
        const kept = []
        for (const cy of [0, 1]) for (let cx = tx * 4; cx < tx * 4 + 4; cx++) kept.push(chunkKey3(cx, cy, 0))
        expect([...bake.chunks.keys()].sort()).toEqual(kept.sort())
        expect(bake.stats).toMatchObject({ untouchedKept: 0, scratchWalkableWrites: 0 })
        expect(bake.spawns.length).toBe(tx === 0 ? 1 : 0)
      }
    }
  })
})

function familySpawnCell(seed) {
  const sp = familySpawn(config, seed)
  return { gx: sp.cx * CHUNK + sp.lx, gz: sp.cz * CHUNK + sp.lz, cy: 0 }
}
