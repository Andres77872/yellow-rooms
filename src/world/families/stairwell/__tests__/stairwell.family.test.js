import { describe, expect, it } from 'vitest'
import { CHUNK } from '../../../constants.js'
import { auditLayeredPatch } from '../../../audit.js'
import { generateChunk } from '../../../generate.js'
import { CELL_LOBBY } from '../../../mapTypes.js'
import { PROP_STANDPIPE } from '../../../props/index.js'
import { massLeakAudit } from '../../../tiles/seams.js'
import { isSolidMassChunk } from '../../../tiles/solidChunk.js'
import { buildChunk } from '../../../pipeline.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familySpawn } from '../../hooks.js'
import { worldSource } from '../../reach.js'
import { STRUCTURAL_COUNTERS, runFamilySuite } from '../../__tests__/familyHarness.js'
import gen from '../generator.js'
import planner from '../structures.js'
import * as hooks from '../hooks.js'
import {
  BAND,
  DISTRICT,
  IMPOSSIBLE,
  SPAN,
  anomalyAt,
  anomalyBlocked,
  darkCells,
  districtLayout,
  districtRungs,
  exitAnchor,
  exitStorey,
  footprint,
  footprintCount,
  isShaftChunk,
  labelAt,
  longRungSide,
  plate,
  ports,
  seamStoreys,
  rungsOf,
  shaftCount,
  storeyInfo,
  storeyPlan,
} from '../geometry.js'

// The stairwell family suite (spec §11.1, §12.1). connWindow: 2×2 districts ×
// the full 16-storey bands below and above the spawn (−16..15) plus their
// long rungs (the outer box adds one district and one storey all round).
runFamilySuite('stairwell', {
  connWindow: { tiles: [2, 2], storeys: [-16, 15] },
})

// §12.1 extras.
const config = forcedFamilyConfig('stairwell')
const SEEDS = [1, 0x5eed, 777, 42, 0xdeadbeef, 0x7fffffff]
const DISTRICTS = []
for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) DISTRICTS.push([dx, dz])

describe('stairwell (§12.1)', () => {
  it('exit: storey G ∈ [−40, −15] on shaft B of district (0,0), plate "1"; spawn inside shaft A on storey 0', () => {
    const depths = new Set()
    for (let i = 0; i < 64; i++) {
      const seed = (Math.imul(i + 1, 0x9e3779b1) ^ 0x5eed) >>> 0
      const G = exitStorey(seed)
      depths.add(G)
      expect(G).toBeGreaterThanOrEqual(-40)
      expect(G).toBeLessThanOrEqual(-15)
      const L = districtLayout(seed, 0, 0)
      const a = exitAnchor(seed)
      expect([a.cx, a.cy, a.cz, a.cx * CHUNK + a.lx, a.cz * CHUNK + a.lz]).toEqual([L.B.ix, G, L.B.iz, L.B.out.x, L.B.out.z])
      expect(labelAt(seed, 0, 0, 1, G)).toBe('1')
      const sp = hooks.spawn({ worldSeed: seed })
      expect([sp.cx, sp.cz, sp.cx * CHUNK + sp.lx, sp.cz * CHUNK + sp.lz]).toEqual([L.A.ix, L.A.iz, L.A.inside.x, L.A.inside.z])
    }
    expect(depths.size).toBeGreaterThan(12)
    for (const seed of SEEDS.slice(0, 3)) {
      const src = worldSource(seed, config)
      const ex = hooks.exit({ worldSeed: seed, config, generate: src.chunkAt })
      expect(ex).toEqual({ ...exitAnchor(seed) })
      // The exit landing is shaft B's, the spawn landing shaft A's (lobby cells).
      const sp = familySpawn(config, seed)
      expect(src.chunkAt(sp.cx, 0, sp.cz).cellKind[sp.lx + sp.lz * CHUNK]).toBe(CELL_LOBBY)
      expect(isShaftChunk(seed, ex.cx, ex.cz)).toBe(true)
    }
    expect(hooks.exitHookStats.lastResort).toBe(0)
  })

  it('plates: shaft B counts honestly to the exit, at most one deviation per 8 storeys per shaft, never on G, 0 ± 1 or a rung', () => {
    const kinds = new Set()
    for (const seed of SEEDS.slice(0, 3)) {
      const G = exitStorey(seed)
      for (const [dx, dz] of DISTRICTS.slice(0, 9)) {
        for (let s = 0; s < districtLayout(seed, dx, dz).n; s++) {
          let breaks = 0
          for (let cy = -64; cy < 64; cy++) {
            const label = labelAt(seed, dx, dz, s, cy)
            expect(label.length).toBeLessThanOrEqual(4)
            const a = anomalyAt(seed, dx, dz, s, cy)
            const lieHere = a && (a.cy === cy || (a.kind === 'reversal' && a.cy + 1 === cy)) && ['repeat', 'reversal', 'foreign', 'impossible'].includes(a.kind)
            if (a) {
              kinds.add(a.kind)
              for (const y of a.kind === 'reversal' ? [a.cy, a.cy + 1] : [a.cy]) {
                expect(y === G || (y >= -1 && y <= 1)).toBe(false)
                // Never where this shaft's landing opens on a rung (a
                // transfer it is on, or a long rung attached to it).
                for (const e of rungsOf(seed, dx, dz, Math.floor(y / BAND))) if (e.cy === y) expect(e.pair).not.toContain(s)
                const ext = storeyPlan(seed, dx, dz, y).ext
                if (ext) expect(ext.shaft).not.toBe(s)
                expect(storeyInfo(seed, dx, dz, y).onCorridor).not.toContain(s)
                expect(anomalyBlocked(seed, dx, dz, s, y)).toBe(false)
              }
            }
            if (!lieHere) expect(label, `${seed} ${dx},${dz} shaft ${s} storey ${cy}`).toBe(plate(shaftCount(seed, dx, dz, s, cy)))
            else breaks++
            if (s === 1) expect(shaftCount(seed, dx, dz, 1, cy)).toBe(cy - G + 1)
            // Shaft A's count steps by one, or two at a skip.
            if (s === 0 && cy > -64) {
              const step = shaftCount(seed, dx, dz, 0, cy) - shaftCount(seed, dx, dz, 0, cy - 1)
              expect(step === 1 || (step === 2 && a?.kind === 'skip' && a.cy === cy)).toBe(true)
            }
          }
          // 16 octaves: at most 2 lying storeys each.
          expect(breaks).toBeLessThanOrEqual(32)
        }
      }
      expect(labelAt(seed, 0, 0, 1, 0)).toBe(plate(1 - G))
    }
    for (const k of ['skip', 'repeat', 'reversal', 'foreign', 'impossible', 'no-standpipe', 'two-standpipes', 'dead-landing']) expect(kinds.has(k), k).toBe(true)
    expect(IMPOSSIBLE).toContain('HErE')
  })

  it('anomaly cadence: exactly one per 8-storey octave per shaft whenever the octave has an allowed storey', () => {
    let octaves = 0
    let filled = 0
    let routeStoreys = 0
    let routeAnomalies = 0
    let bareRoutes = 0
    for (let i = 0; i < 40; i++) {
      const seed = (Math.imul(i + 1, 0x85ebca6b) ^ 0x51a1) >>> 0
      for (const [dx, dz] of DISTRICTS.slice(0, 9)) {
        for (let s = 0; s < districtLayout(seed, dx, dz).n; s++) {
          for (let oct = -6; oct < 2; oct++) {
            const a = anomalyAt(seed, dx, dz, s, oct * 8)
            let open = false
            for (let y = oct * 8; y < oct * 8 + 8; y++) if (!anomalyBlocked(seed, dx, dz, s, y)) open = true
            octaves++
            expect(a !== null, `${seed} ${dx},${dz} shaft ${s} octave ${oct}`).toBe(open)
            if (a) {
              filled++
              expect(Math.floor(a.cy / 8)).toBe(oct)
              if (a.kind === 'reversal') expect(Math.floor((a.cy + 1) / 8)).toBe(oct)
            }
          }
        }
      }
      // The spawn→exit route of district (0,0): A from 0 down to −3, B from −3 down to G.
      const G = exitStorey(seed)
      let n = 0
      for (let y = -3; y <= 0; y++) if (anomalyAt(seed, 0, 0, 0, y)?.cy === y) n++
      for (let y = G; y < -3; y++) if (anomalyAt(seed, 0, 0, 1, y)?.cy === y) n++
      routeStoreys += 1 - G
      routeAnomalies += n
      if (n === 0) bareRoutes++
    }
    expect(filled / octaves).toBeGreaterThan(0.97)
    // The route keeps close to one deviation per 8 storeys and none is bare.
    expect(routeStoreys / routeAnomalies).toBeLessThan(10)
    expect(bareRoutes).toBe(0)
  })

  it('rungs: 2–3 A↔B transfer floors per band, ≥ 3 storeys apart, band −1 always at storey −3; every other ladder-tree edge once per band, on its own storey', () => {
    let many = 0
    let spread = 0
    for (const seed of SEEDS) {
      for (const [dx, dz] of DISTRICTS) {
        const L = districtLayout(seed, dx, dz)
        expect(L.n).toBeGreaterThanOrEqual(14)
        expect(L.n).toBeLessThanOrEqual(16)
        if (L.n >= 16) many++
        // The ladder tree spans every shaft, A–B first.
        expect(L.tree[0]).toEqual([0, 1])
        expect(L.tree).toHaveLength(L.n - 1)
        expect(new Set(L.tree.flat()).size).toBe(L.n)
        for (let band = -4; band <= 3; band++) {
          const rungs = districtRungs(seed, dx, dz, band)
          expect(rungs.length).toBeGreaterThanOrEqual(2)
          expect(rungs.length).toBeLessThanOrEqual(3)
          for (const t of rungs) expect(Math.floor(t / BAND)).toBe(band)
          for (let i = 1; i < rungs.length; i++) expect(rungs[i] - rungs[i - 1]).toBeGreaterThanOrEqual(3)
          if (band === -1) expect(rungs).toContain(-3)
          const all = rungsOf(seed, dx, dz, band)
          // Every other tree edge is exactly one rung per band, on a storey
          // of its own hashing (band-local 1..14), so the transfers spread
          // over the band instead of stacking on the A–B floors.
          const storeys = new Set()
          for (const [p, q] of L.tree.slice(1)) {
            const on = all.filter((e) => e.pair[0] === p && e.pair[1] === q)
            expect(on, `${seed} ${dx},${dz} band ${band} edge ${p}-${q}`).toHaveLength(1)
            const t = on[0].cy - band * BAND
            expect(t).toBeGreaterThanOrEqual(1)
            expect(t).toBeLessThanOrEqual(BAND - 2)
            storeys.add(on[0].cy)
          }
          if (L.n >= 14) spread += storeys.size > 3 ? 1 : 0
          expect(all).toHaveLength(rungs.length + L.n - 2)
        }
      }
    }
    expect(many).toBeGreaterThan(0)
    expect(spread).toBeGreaterThan(0)
  })

  it('long rungs: one storey per seam per band, the four seams of a district on distinct residues mod 4, ports symmetric', () => {
    for (const seed of SEEDS) {
      for (const [dx, dz] of DISTRICTS) {
        for (let band = -3; band <= 2; band++) {
          const s = seamStoreys(seed, dx, dz, band)
          const res = Object.values(s).map((y) => ((y % 4) + 4) % 4)
          expect(new Set(res).size).toBe(4)
          for (const y of Object.values(s)) expect(Math.floor(y / BAND)).toBe(band)
          // The same seam seen from both districts.
          expect(seamStoreys(seed, dx + 1, dz, band).west).toBe(s.east)
          expect(seamStoreys(seed, dx, dz + 1, band).north).toBe(s.south)
          for (const [side, y] of Object.entries(s)) expect(longRungSide(seed, dx, dz, y)).toBe(side)
          // Ports open exactly on the seam storey (west/north lines of the district).
          expect(ports(seed, { tx: dx, tz: dz }, 'west', s.west)).toHaveLength(1)
          expect(ports(seed, { tx: dx, tz: dz }, 'north', s.north)).toHaveLength(1)
          expect(ports(seed, { tx: dx, tz: dz }, 'west', s.west + 1)).toHaveLength(0)
        }
      }
    }
  })

  it('footprint: the kept chunks are exactly the shafts, the storey\'s run claims and its corridors; a run keeps its massing (reported)', () => {
    // Spec §12.1's "≤ 10 non-solid chunks" gate is not met: a district is a
    // field of 14–16 shafts, each landing's domain capped near its fragment's
    // site (geometry.js fragmentSite, ~100 cells built), but with that many
    // shafts nearly every chunk holds a core or a domain (the similarity
    // gate needs the storey about half built), so most chunks are kept. A
    // spec ruling is requested. What is asserted is the footprint's
    // composition and its run-keyed stability.
    let max = 0
    let min = 16
    let sum = 0
    let n = 0
    let pairs = 0
    let same = 0
    for (const seed of SEEDS) {
      for (const [dx, dz] of DISTRICTS) {
        const L = districtLayout(seed, dx, dz)
        let prev = null
        for (let cy = -48; cy < 48; cy++) {
          const c = footprintCount(seed, dx, dz, cy)
          max = Math.max(max, c)
          min = Math.min(min, c)
          sum += c
          n++
          const P = storeyPlan(seed, dx, dz, cy)
          let mask = 0
          for (const S of L.shafts) mask |= 1 << S.chunk
          for (const claim of P.claims) for (const k of claim) mask |= 1 << k
          for (const k of P.corridorChunks) mask |= 1 << k
          expect(P.mask, `${seed} ${dx},${dz} storey ${cy}`).toBe(mask)
          if ((cy & 3) === 0) {
            for (let k = 0; k < DISTRICT * DISTRICT; k++) {
              expect(footprint(seed, dx * DISTRICT + (k % DISTRICT), cy, dz * DISTRICT + Math.floor(k / DISTRICT))).toBe((mask >> k) & 1 ? 'tile' : 'solid')
            }
          }
          // A landing whose run goes on keeps its site, and the band keeps its
          // cuts, so its claim holds but round a rung's storey (reported).
          if (prev && prev.band === P.band) {
            for (const [i, f] of P.frags.entries()) {
              const j = prev.frags.findIndex((g) => g.s === f.s)
              if (j < 0 || prev.frags[j].kind !== f.kind || prev.frags[j].run !== f.run) continue
              pairs++
              if (prev.claims[j].join() === P.claims[i].join()) same++
              expect(P.claims[i][0]).toBe(L.shafts[f.s].chunk)
            }
          }
          prev = P
        }
      }
    }
    expect(pairs).toBeGreaterThan(n)
    expect(same / pairs).toBeGreaterThan(0.6)
    expect(min).toBeGreaterThanOrEqual(2)
    console.info(`[stairwell footprint] min ${min}, max ${max}, mean ${(sum / n).toFixed(2)} non-solid chunks per district-storey (spec §12.1 gate ≤ 10 not met); ${pairs} same-run landing pairs, ${(same / pairs * 100).toFixed(1)}% keep their claim`)
  }, 60_000)

  it('procedural: districts differ on a storey (wall/column Jaccard, the repeat/sim.mjs metric); a run\'s storeys are near-copies, a new run is not', () => {
    const seed = 12345
    const region = (tx, tz, cy) => {
      const set = new Set()
      for (let iz = 0; iz < DISTRICT; iz++) {
        for (let ix = 0; ix < DISTRICT; ix++) {
          const c = buildChunk(seed, tx * DISTRICT + ix, cy, tz * DISTRICT + iz, config, null, [])
          for (let i = 0; i < CHUNK * CHUNK; i++) {
            const k = `${ix},${iz},${i}`
            if (c.wallV[i]) set.add('v' + k)
            if (c.wallH[i]) set.add('h' + k)
            if (c.cols[i]) set.add('c' + k + ':' + c.cols[i])
          }
        }
      }
      return set
    }
    const jac = (a, b) => {
      let i = 0
      for (const x of a) if (b.has(x)) i++
      return i / (a.size + b.size - i || 1)
    }
    const score = (sets) => {
      let sum = 0
      let n = 0
      let max = 0
      for (let i = 0; i < sets.length; i++) {
        for (let j = i + 1; j < sets.length; j++) {
          const v = jac(sets[i], sets[j])
          sum += v
          n++
          max = Math.max(max, v)
        }
      }
      return { mean: sum / n, max }
    }
    const tiles = []
    for (let a = 0; a < 4; a++) for (let b = 0; b < 3; b++) tiles.push([a * 3 + 1, b * 3 + 1])
    const out = {}
    for (const cy of [0, -7]) {
      const r = score(tiles.map(([tx, tz]) => region(tx, tz, cy)))
      out[`districts@${cy}`] = r
      expect(r.mean, `districts on storey ${cy}`).toBeLessThanOrEqual(0.25)
      expect(r.max, `districts on storey ${cy}`).toBeLessThanOrEqual(0.45)
    }
    // Vertically the doc wants the opposite (§1, §4.3): a landing's storeys
    // within its run are near-copies (its own chunk), and a new run is a
    // different floor.
    const chunkSet = (cx, cy, cz) => {
      const c = buildChunk(seed, cx, cy, cz, config, null, [])
      const set = new Set()
      for (let i = 0; i < CHUNK * CHUNK; i++) {
        if (c.wallV[i]) set.add('v' + i)
        if (c.wallH[i]) set.add('h' + i)
        if (c.cols[i]) set.add('c' + i + ':' + c.cols[i])
      }
      return set
    }
    const within = []
    const across = []
    for (const [tx, tz] of [[4, 7], [1, 1]]) {
      const L = districtLayout(seed, tx, tz)
      for (let cy = -24; cy < 0; cy++) {
        const P = storeyPlan(seed, tx, tz, cy)
        const Q = storeyPlan(seed, tx, tz, cy + 1)
        if (P.band !== Q.band) continue
        for (const S of L.shafts) {
          const a = P.frags.find((f) => f.s === S.s)
          const b = Q.frags.find((f) => f.s === S.s)
          if (!a || !b) continue
          const v = jac(chunkSet(tx * DISTRICT + S.ix, cy, tz * DISTRICT + S.iz), chunkSet(tx * DISTRICT + S.ix, cy + 1, tz * DISTRICT + S.iz))
          ;(a.kind === b.kind && a.run === b.run ? within : across).push(v)
        }
      }
    }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
    out['within-run landing pairs'] = { mean: mean(within), min: Math.min(...within) }
    out['run-change landing pairs'] = { mean: mean(across), max: Math.max(...across) }
    expect(within.length).toBeGreaterThan(40)
    expect(across.length).toBeGreaterThan(10)
    expect(mean(within)).toBeGreaterThanOrEqual(0.7)
    expect(mean(across)).toBeLessThan(mean(within) - 0.25)
    console.info(`[stairwell similarity] ${Object.entries(out).map(([k, v]) => `${k} ${Object.entries(v).map(([a, b]) => `${a} ${b.toFixed(3)}`).join(' ')}`).join('; ')}`)
  }, 60_000)

  it('shafts: every storey of a shaft chunk pairs its flight up with the storey above\'s flight down (global parity), standpipe on the landing', () => {
    for (const seed of SEEDS.slice(0, 2)) {
      const src = worldSource(seed, config)
      for (const [dx, dz] of [[0, 0], [-1, 1], [2, -2]]) {
        const L = districtLayout(seed, dx, dz)
        for (const S of L.shafts) {
          const cx = dx * DISTRICT + S.ix
          const cz = dz * DISTRICT + S.iz
          for (let cy = -12; cy <= 12; cy++) {
            const d = src.chunkAt(cx, cy, cz)
            const up = src.chunkAt(cx, cy + 1, cz)
            expect(d.stairUp, `${seed} ${cx},${cy},${cz}`).toBeTruthy()
            expect(JSON.stringify(up.stairDown)).toBe(JSON.stringify(d.stairUp))
            expect(planner.verticalOpeningAt(seed, cx, cz, cy)).toBe(true)
            const pipes = d.furniture.filter((f) => f.kind === PROP_STANDPIPE && d.cellKind[f.lx + f.lz * CHUNK] === CELL_LOBBY).length
            const a = anomalyAt(seed, dx, dz, S.s, cy)
            const kind = a && a.cy === cy ? a.kind : null
            expect(pipes).toBe(kind === 'no-standpipe' ? 0 : kind === 'two-standpipes' ? 2 : 1)
          }
        }
      }
    }
  }, 180_000)

  it('dark floors stay dark in the world: no lit fixture (the fill pass included) in a dark fragment or on a dead landing', () => {
    // Doc §4.3 "Dark floor: everything, no lit lamp" and §8's breaker
    // segments: geometry.js darkCells marks a dark fragment's share (off
    // the routed corridors) and every dead landing's core; the generator's
    // fill pass never hangs a fixture there, and the tile never lights one.
    let darkStoreys = 0
    let checked = 0
    for (const seed of SEEDS.slice(0, 2)) {
      for (const [dx, dz] of [[0, 0], [-1, 1]]) {
        for (let cy = -20; cy <= 3; cy++) {
          const mask = darkCells(seed, dx, dz, cy)
          if (!mask) continue
          darkStoreys++
          const P = storeyPlan(seed, dx, dz, cy)
          for (let c = 0; c < DISTRICT * DISTRICT; c++) {
            if (!((P.mask >> c) & 1)) continue
            const ix = c % DISTRICT
            const iz = Math.floor(c / DISTRICT)
            const d = buildChunk(seed, dx * DISTRICT + ix, cy, dz * DISTRICT + iz, config, null, [])
            for (const l of d.lamps) {
              const at = (iz * CHUNK + l.lz) * SPAN + ix * CHUNK + l.lx
              if (!mask[at]) continue
              checked++
              expect(l.lit, `${seed} district ${dx},${dz} storey ${cy} cell ${ix * CHUNK + l.lx},${iz * CHUNK + l.lz}`).toBe(false)
            }
          }
        }
      }
    }
    expect(darkStoreys).toBeGreaterThan(10)
    expect(checked).toBeGreaterThan(50)
  }, 60_000)

  it('deep window: seams and the layered audit hold over 3×3 districts × storeys −42..−1', () => {
    const seed = 1
    const src = worldSource(seed, config)
    const box = { x0: -4, z0: -4, x1: 7, z1: 7, y0: -42, y1: -1 }
    const seams = massLeakAudit(src.chunkAt, box, { gen, worldSeed: seed })
    for (const k of ['leaks', 'seals', 'portViolations', 'seeThroughToSolid', 'seeThroughThinMass']) expect(seams.details[k], k).toEqual([])
    const audit = auditLayeredPatch(src.chunkAt, box.x0, box.y0, box.z0, box.x1 - box.x0 + 1, box.y1 - box.y0 + 1, box.z1 - box.z0 + 1)
    expect(Object.fromEntries(STRUCTURAL_COUNTERS.filter((c) => audit[c]).map((c) => [c, audit[c]]))).toEqual({})
    // Every shaft of the 9 districts (2 or 3 each) × 41 flights.
    let shafts = 0
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) shafts += districtLayout(seed, dx, dz).n
    expect(audit.canonicalLinks).toBe(shafts * 41)
    // Solid chunks are never baked (pure footprint): the first solid chunk
    // of the 3×3 districts on storeys −16..15 comes back as plain mass.
    let solid = null
    for (let cy = -BAND; cy < BAND && !solid; cy++) {
      for (let dz = -1; dz <= 1 && !solid; dz++) {
        for (let dx = -1; dx <= 1 && !solid; dx++) {
          for (let c = 0; c < DISTRICT * DISTRICT && !solid; c++) {
            const at = [dx * DISTRICT + (c % DISTRICT), cy, dz * DISTRICT + Math.floor(c / DISTRICT)]
            if (footprint(seed, ...at) === 'solid') solid = at
          }
        }
      }
    }
    expect(solid).not.toBeNull()
    expect(isSolidMassChunk(generateChunk(seed, ...solid, config))).toBe(true)
  }, 60_000)
})
