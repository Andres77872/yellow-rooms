import { describe, expect, it } from 'vitest'
import { CHUNK } from '../../../constants.js'
import { generateChunk } from '../../../generate.js'
import { massLeakAudit } from '../../../tiles/seams.js'
import { tileBakeAt } from '../../../tiles/familyChunk.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familyGenerator } from '../../generators.js'
import { familySpawn } from '../../hooks.js'
import { familyPlanner } from '../../planners.js'
import { windowConnectivity, worldSource } from '../../reach.js'
import { runFamilySuite } from '../../__tests__/familyHarness.js'
import { CELL_ROOM } from '../../../mapTypes.js'
import {
  ANOMALY_CLASSES,
  ANOMALY_RATE,
  BASEMENT_LABEL,
  DECK_LABEL,
  DISTRICT,
  MIN_CORES,
  NEXT_ISLAND,
  RING2,
  SPAN,
  TILE,
  anchorDistrict,
  anomalyAt,
  blueprint,
  coreRectOf,
  deckLabel,
  districtKey,
  exitAnchor,
  footprint,
  gasDistrict,
  kioskArea,
  kioskChunk,
  ports,
  spawnCells,
  underPorts,
  upperChunks,
} from '../geometry.js'
import { MERCURY, MODULE_WHITE, SIGNAL_RED, SODIUM, TUBE, UPPER_LABELS, WARM } from '../tile.js'
import { PROP_CART, PROP_DUMPSTER } from '../../../props/index.js'

// The nightlot family suite (spec §11.1, §12.2): W = 2×2 districts × storeys
// −1..1 (the undercroft, the lot, the upper storey over the garages and the
// frontage blocks); the decision-6 window 3×3 districts.
runFamilySuite('nightlot', {
  window: { tiles: [2, 2], storeys: [-1, 1] },
  connWindow: { tiles: [3, 3], storeys: [-1, 1] },
})

// --- nightlot specifics (§12.2 Tests) -------------------------------------------------

const ID = 'nightlot'
const config = forcedFamilyConfig(ID)
const gen = familyGenerator(ID)
const planner = familyPlanner(ID)
const cheb = (ax, az, bx, bz) => Math.max(Math.abs(ax - bx), Math.abs(az - bz))
const districts = (r, fn) => {
  for (let tz = -r; tz <= r; tz++) for (let tx = -r; tx <= r; tx++) fn(tx, tz)
}
const inside = (a, b) => a.x0 >= b.x0 && a.z0 >= b.z0 && a.x1 <= b.x1 && a.z1 <= b.z1
const overlap = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1
const grow = (r, n) => ({ x0: r.x0 - n, z0: r.z0 - n, x1: r.x1 + n, z1: r.z1 + n })
const local = (v) => ((v % CHUNK) + CHUNK) % CHUNK
const SEED = 12345

// The chunks of district (tx, tz) on storey cy (cached per test file).
const cache = new Map()
const chunkOf = (seed, cx, cy, cz) => {
  const k = `${seed}|${cx},${cy},${cz}`
  if (!cache.has(k)) cache.set(k, generateChunk(seed, cx, cy, cz, config))
  return cache.get(k)
}
const districtChunks = (seed, tx, tz, cy) => {
  const out = []
  for (let lz = 0; lz < DISTRICT; lz++) for (let lx = 0; lx < DISTRICT; lx++) out.push(chunkOf(seed, tx * DISTRICT + lx, cy, tz * DISTRICT + lz))
  return out
}
// Walls and columns of a district-sized region (the variety gate's sets,
// mass columns included). On the upper storey only its footprint chunks
// count (`kept`): the footprint-solid rest is solid by construction.
const regionSet = (seed, tx, tz, cy, kept = false) => {
  const s = new Set()
  districtChunks(seed, tx, tz, cy).forEach((c, n) => {
    if (kept && footprint(seed, c.cx, cy, c.cz) !== 'tile') return
    for (let i = 0; i < CHUNK * CHUNK; i++) {
      if (c.wallV[i]) s.add(`v${n}:${i}`)
      if (c.wallH[i]) s.add(`h${n}:${i}`)
      if (c.cols[i]) s.add(`c${n}:${i}:${c.cols[i]}`)
    }
  })
  return s
}
const jaccard = (a, b) => {
  let i = 0
  for (const x of a) if (b.has(x)) i++
  return i / (a.size + b.size - i || 1)
}
const pairwise = (sets) => {
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
  return { mean: sum / n, max }
}
const GATE_DISTRICTS = []
for (let tz = -2; tz < 2; tz++) for (let tx = -2; tx < 1; tx++) GATE_DISTRICTS.push([tx, tz]) // 12

describe('nightlot family (§12.2)', () => {
  it('tile, footprint and ports: a 4×4 district over −1..1, the lot and the undercroft whole, the upper storey over the garage and the frontage blocks; full-seam lot ports, 1–2 underpasses per owned seam on the undercroft', () => {
    expect(TILE).toMatchObject({ w: 4, d: 4, backend: 'band', H: 3, lo: -1, hi: 1 })
    for (const seed of [1, SEED]) {
      districts(2, (tx, tz) => {
        const bp = blueprint(seed, tx, tz)
        const ups = new Set(upperChunks(seed, tx, tz).map(([a, b]) => `${a},${b}`))
        const g = bp.garage?.chunks
        if (g) for (let lz = g.c0z; lz < g.c0z + g.h; lz++) for (let lx = g.c0x; lx < g.c0x + g.w; lx++) expect(ups.has(`${lx},${lz}`)).toBe(true)
        for (const c of bp.cores) if (c.topCy === 1) expect(ups.has(`${c.lcx},${c.lcz}`)).toBe(true)
        if (!g && !bp.blocks.some((b) => b.upper || b.roof)) expect(ups.size).toBe(0)
        for (let lz = 0; lz < DISTRICT; lz++) {
          for (let lx = 0; lx < DISTRICT; lx++) {
            const cx = tx * DISTRICT + lx
            const cz = tz * DISTRICT + lz
            expect(footprint(seed, cx, 0, cz)).toBe('tile')
            expect(footprint(seed, cx, -1, cz)).toBe('tile')
            expect(footprint(seed, cx, 1, cz)).toBe(ups.has(`${lx},${lz}`) ? 'tile' : 'solid')
            expect(footprint(seed, cx, 2, cz)).toBe('solid')
            expect(footprint(seed, cx, -2, cz)).toBe('solid')
          }
        }
        const k = districtKey(tx, tz)
        expect(ports(seed, k, 'west', 0)).toEqual([{ a0: 0, a1: SPAN - 1 }])
        expect(ports(seed, k, 'north', 0)).toEqual([{ a0: 0, a1: SPAN - 1 }])
        for (const side of ['west', 'north']) {
          const p = ports(seed, k, side, -1)
          expect(p).toEqual(underPorts(seed, tx, tz, side))
          expect(p.length >= 1 && p.length <= 2).toBe(true)
          let last = -1
          for (const r of p) {
            expect(r.a0).toBeGreaterThan(last + 1)
            expect(r.a0).toBeGreaterThanOrEqual(6)
            expect(r.a1).toBeLessThanOrEqual(49)
            expect(r.a1 - r.a0 + 1 >= 3 && r.a1 - r.a0 + 1 <= 5).toBe(true)
            last = r.a1
          }
          expect(ports(seed, k, side, 1)).toEqual([])
        }
        expect(ports(seed, k, 'east', -1)).toEqual([])
      })
    }
  })

  it('blueprint grammar: an optional garage, two to four buildings and up to three outparcels, nothing overlapping, a stair in every district (MIN_CORES nearly always), one core per chunk strictly inside it, none in the kiosk chunk; the garage\'s cores and the frontage stair halls climb to cy 1', () => {
    let short = 0
    let n = 0
    for (const seed of [1, 2, SEED]) {
      districts(3, (tx, tz) => {
        const bp = blueprint(seed, tx, tz)
        const where = `seed ${seed} district ${tx},${tz}`
        n++
        const g = bp.garage
        if (g) {
          expect(inside(g.rect, bp.parcel), where).toBe(true)
          expect(g.cores.length, where).toBeGreaterThanOrEqual(1)
          expect(bp.mode, where).toBe('mixed')
        }
        const big = bp.blocks.filter((b) => b.kind !== 'pad')
        expect(big.length, where).toBeLessThanOrEqual(4)
        expect(big.length, where).toBeGreaterThanOrEqual(1)
        expect(bp.blocks.length - big.length, where).toBeLessThanOrEqual(3)
        // Footprints never overlap (the garage, buildings, booths, lots, the kiosk).
        const rects = [...(g ? [g.rect] : []), ...bp.blocks.map((b) => b.rect), ...bp.booths.map((b) => b.rect), ...bp.lots.map((l) => l.rect)]
        if (bp.kiosk) rects.push(kioskArea(bp.kiosk.lcx, bp.kiosk.lcz))
        for (let i = 0; i < rects.length; i++) {
          expect(inside(rects[i], { x0: 0, z0: 0, x1: SPAN - 2, z1: SPAN - 2 }), where).toBe(true)
          for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i], rects[j]), `${where}: ${i} × ${j}`).toBe(false)
        }
        // Stair cores: strictly inside one chunk, one per chunk, never the kiosk's.
        expect(bp.cores.length + (bp.kiosk ? 1 : 0), where).toBeGreaterThanOrEqual(1)
        if (bp.cores.length < MIN_CORES) short++
        const seen = new Set(bp.kiosk ? [`${bp.kiosk.lcx},${bp.kiosk.lcz}`] : [])
        for (const c of bp.cores) {
          expect(coreRectOf(c.gx, c.gz, c.dir)).toEqual(c.rect)
          const climbs = c.role === 'garage-tower' || c.role === 'garage-ramp' || bp.blocks.some((b) => b.core === c && (b.upper || b.roof))
          expect([c.baseCy, c.topCy], `${where} ${c.role}`).toEqual([-1, climbs ? 1 : 0])
          expect([Math.floor(c.rect.x0 / CHUNK), Math.floor(c.rect.z0 / CHUNK)]).toEqual([Math.floor(c.rect.x1 / CHUNK), Math.floor(c.rect.z1 / CHUNK)])
          expect(local(c.rect.x0) >= 1 && local(c.rect.z0) >= 1 && local(c.rect.x1) <= CHUNK - 2 && local(c.rect.z1) <= CHUNK - 2, where).toBe(true)
          const key = `${c.lcx},${c.lcz}`
          expect(seen.has(key), `${where}: two cores in chunk ${key}`).toBe(false)
          seen.add(key)
        }
        for (const l of bp.lots) if (l.core) expect(inside(l.core.rect, grow(l.rect, -1)), where).toBe(true)
      })
    }
    expect(short / n).toBeLessThan(0.02)
  })

  it('variety of the grammar: modes, garage sizes, placements, orientations, building kinds, lot stair heads and underpasses all vary across districts', () => {
    const sizes = new Set()
    const spots = new Set()
    const fronts = new Set()
    const kinds = new Set()
    const subs = new Set()
    const lotCounts = new Set()
    const unders = new Set()
    const mixes = new Set()
    let garages = 0
    let fields = 0
    let heads = 0
    let kiosks = 0
    let n = 0
    districts(5, (tx, tz) => {
      const bp = blueprint(SEED, tx, tz)
      n++
      if (bp.garage) {
        garages++
        const c = bp.garage.chunks
        sizes.add(`${c.w}x${c.h}`)
        spots.add(`${c.c0x},${c.c0z}`)
      }
      if (bp.mode === 'field') fields++
      for (const b of bp.blocks) {
        fronts.add(b.front)
        kinds.add(b.kind)
        subs.add(b.sub)
      }
      mixes.add(`${bp.garage ? 'g' : ''}${bp.blocks.map((b) => b.sub).sort().join('+')}`)
      heads += bp.cores.filter((c) => c.role === 'lot-stair').length
      lotCounts.add(bp.lots.length)
      unders.add(JSON.stringify(underPorts(SEED, tx, tz, 'west')))
      if (bp.kiosk) kiosks++
    })
    expect(sizes.size).toBeGreaterThanOrEqual(4)
    expect(spots.size).toBeGreaterThanOrEqual(6)
    expect(garages / n).toBeGreaterThan(0.3)
    expect(garages / n).toBeLessThan(0.7)
    expect(fields / n).toBeGreaterThan(0.08)
    expect(fields / n).toBeLessThan(0.35)
    expect(mixes.size).toBeGreaterThanOrEqual(20)
    expect(heads).toBeGreaterThan(n / 2)
    expect([...fronts].sort()).toEqual(['E', 'N', 'S', 'W'])
    expect([...kinds].sort()).toEqual(['bigbox', 'frontage', 'gas', 'pad', 'strip'])
    expect(subs.has('motel') && subs.has('offices')).toBe(true)
    expect(lotCounts.size).toBeGreaterThanOrEqual(4)
    expect(unders.size).toBeGreaterThan(n * 0.9)
    expect(kiosks / n).toBeGreaterThan(0.2)
    expect(kiosks / n).toBeLessThan(0.55)
  })

  it('variety gate: wall/column Jaccard (mass included) over 12 district regions ≤ 0.25 mean, ≤ 0.45 max on the lot (cy 0), the undercroft (cy −1) and the upper storey (cy 1, over its footprint chunks)', () => {
    for (const cy of [0, -1, 1]) {
      const v = pairwise(GATE_DISTRICTS.map(([tx, tz]) => regionSet(SEED, tx, tz, cy, cy === 1)))
      expect(v.mean, `cy ${cy}`).toBeLessThanOrEqual(0.25)
      expect(v.max, `cy ${cy}`).toBeLessThanOrEqual(0.45)
    }
  }, 60_000)

  it('content gate on the lot (cy 0): per chunk ≥ 25 wall edges, ≥ 2 rooms (CELL_ROOM spaces), ≥ 8 pieces, ≥ 3 lit lamps; walkable share 0.5–0.9; a stair down in every district', () => {
    let n = 0
    let walls = 0
    let rooms = 0
    let pieces = 0
    let lit = 0
    let open = 0
    for (const [tx, tz] of GATE_DISTRICTS) {
      let downs = 0
      for (const c of districtChunks(SEED, tx, tz, 0)) {
        n++
        const rm = new Set()
        for (let i = 0; i < CHUNK * CHUNK; i++) {
          walls += c.wallV[i] + c.wallH[i]
          if (!c.cols[i]) open++
          if (c.spaceId[i] && c.cellKind[i] === CELL_ROOM) rm.add(c.spaceId[i])
        }
        rooms += rm.size
        pieces += c.furniture.length
        lit += c.lamps.filter((l) => l.lit).length
        if (c.stairDown) downs++
      }
      expect(downs, `district ${tx},${tz}`).toBeGreaterThanOrEqual(1)
    }
    expect(walls / n).toBeGreaterThanOrEqual(25)
    expect(rooms / n).toBeGreaterThanOrEqual(2)
    expect(pieces / n).toBeGreaterThanOrEqual(8)
    expect(lit / n).toBeGreaterThanOrEqual(3)
    expect(open / (n * CHUNK * CHUNK)).toBeGreaterThanOrEqual(0.5)
    expect(open / (n * CHUNK * CHUNK)).toBeLessThanOrEqual(0.9)
  }, 60_000)

  it('stair cores: every core pairs the undercroft and the lot in its chunk (the kiosk core too), the climbing ones the lot and the upper storey; verticalOpeningAt agrees; the undercroft reads P-1, the roof deck P2, an upper floor 2', () => {
    for (const seed of [1, SEED]) {
      districts(1, (tx, tz) => {
        const bp = blueprint(seed, tx, tz)
        const pairs = bp.cores.map((c) => [tx * DISTRICT + c.lcx, tz * DISTRICT + c.lcz, c.role, c.topCy])
        const k = kioskChunk(seed, tx, tz)
        if (k) pairs.push([k.cx, k.cz, 'kiosk', 0])
        for (const [cx, cz, role, top] of pairs) {
          const base = chunkOf(seed, cx, -1, cz)
          const lot = chunkOf(seed, cx, 0, cz)
          expect(base.stairUp, `${role} ${cx},${cz}`).toBeTruthy()
          expect(JSON.stringify(lot.stairDown)).toBe(JSON.stringify(base.stairUp))
          expect(planner.verticalOpeningAt(seed, cx, cz, -1)).toBe(true)
          expect(planner.verticalOpeningAt(seed, cx, cz, 0)).toBe(top === 1)
          expect(planner.verticalOpeningAt(seed, cx, cz, 1)).toBe(false)
          if (top === 1) {
            const up = chunkOf(seed, cx, 1, cz)
            expect(lot.stairUp, `${role} ${cx},${cz} up`).toBeTruthy()
            expect(JSON.stringify(up.stairDown)).toBe(JSON.stringify(lot.stairUp))
            expect(up.stairUp).toBeFalsy()
          } else {
            expect(lot.stairUp, `${role} ${cx},${cz}`).toBeFalsy()
          }
        }
        for (const c of districtChunks(seed, tx, tz, -1)) expect(c.levelLabel).toBe(BASEMENT_LABEL)
        const g = bp.garage?.chunks
        for (const [lx, lz] of upperChunks(seed, tx, tz)) {
          const roof = !!g && lx >= g.c0x && lx < g.c0x + g.w && lz >= g.c0z && lz < g.c0z + g.h
          expect(chunkOf(seed, tx * DISTRICT + lx, 1, tz * DISTRICT + lz).levelLabel).toBe(roof ? UPPER_LABELS.roof : UPPER_LABELS.floor)
        }
      })
    }
  })

  it('upper storey: every footprint chunk of cy 1 holds a real floor (no near-solid slivers); roof decks carry poles, a lobby, the cores; frontage upper floors carry rooms', () => {
    let roofLit = 0
    let roofs = 0
    let floors = 0
    for (const seed of [1, SEED]) {
      districts(1, (tx, tz) => {
        const bp = blueprint(seed, tx, tz)
        const g = bp.garage?.chunks
        let rooms = 0
        for (const [lx, lz] of upperChunks(seed, tx, tz)) {
          const c = chunkOf(seed, tx * DISTRICT + lx, 1, tz * DISTRICT + lz)
          let floor = 0
          for (let i = 0; i < CHUNK * CHUNK; i++) {
            if (!c.cols[i] || c.spaceId[i]) floor++
            if (c.spaceId[i] && c.cellKind[i] === CELL_ROOM) rooms++
          }
          expect(floor, `seed ${seed} chunk ${tx * DISTRICT + lx},1,${tz * DISTRICT + lz}`).toBeGreaterThanOrEqual(24)
          if (g && lx >= g.c0x && lx < g.c0x + g.w && lz >= g.c0z && lz < g.c0z + g.h) roofLit += c.lamps.filter((l) => l.lit).length
        }
        if (g) roofs++
        if (bp.blocks.some((b) => b.upper)) {
          floors++
          expect(rooms, `seed ${seed} district ${tx},${tz}`).toBeGreaterThan(0)
        }
      })
    }
    expect(roofs).toBeGreaterThan(0)
    expect(floors).toBeGreaterThan(0)
    expect(roofLit).toBeGreaterThan(roofs)
  }, 60_000)

  it('refuges: rare and never edge neighbours (doc §4.3 step 6); always in district (0,0)', () => {
    for (const seed of [1, 2, SEED]) {
      let n = 0
      let gas = 0
      expect(gasDistrict(seed, 0, 0)).toBe(true)
      districts(12, (tx, tz) => {
        n++
        const has = (x, z) => blueprint(seed, x, z).blocks.some((b) => b.kind === 'gas')
        if (!has(tx, tz)) return
        gas++
        expect(gasDistrict(seed, tx, tz)).toBe(true)
        for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) expect(has(tx + dx, tz + dz), `seed ${seed} ${tx},${tz}`).toBe(false)
      })
      expect(gas / n).toBeGreaterThan(0.06)
      expect(gas / n).toBeLessThan(0.2)
    }
  }, 60_000)

  it('underpasses: every cy −1 seam port is walkable and open on both sides', () => {
    const src = worldSource(SEED, config)
    districts(1, (tx, tz) => {
      for (const { a0, a1 } of underPorts(SEED, tx, tz, 'west')) {
        for (let a = a0; a <= a1; a++) {
          const gz = tz * SPAN + a
          for (const gx of [tx * SPAN, tx * SPAN - 1]) {
            const d = src.chunkAt(Math.floor(gx / CHUNK), -1, Math.floor(gz / CHUNK))
            expect(d.cols[local(gz) * CHUNK + local(gx)], `${gx},${gz}`).toBe(0)
          }
          const d = src.chunkAt(Math.floor((tx * SPAN) / CHUNK), -1, Math.floor(gz / CHUNK))
          expect(d.wallV[local(gz) * CHUNK + local(tx * SPAN)]).toBe(0)
        }
      }
      for (const { a0, a1 } of underPorts(SEED, tx, tz, 'north')) {
        for (let a = a0; a <= a1; a++) {
          const gx = tx * SPAN + a
          for (const gz of [tz * SPAN, tz * SPAN - 1]) {
            const d = src.chunkAt(Math.floor(gx / CHUNK), -1, Math.floor(gz / CHUNK))
            expect(d.cols[local(gz) * CHUNK + local(gx)], `${gx},${gz}`).toBe(0)
          }
          const d = src.chunkAt(Math.floor(gx / CHUNK), -1, Math.floor((tz * SPAN) / CHUNK))
          expect(d.wallH[local(tz * SPAN) * CHUNK + local(gx)]).toBe(0)
        }
      }
    })
  }, 60_000)

  it('lamps: tints from the palette, ≤ 12 lit per chunk-storey; every lit island head sees another lit lamp within the next-island distance', () => {
    const tints = new Set([SODIUM, MERCURY, MODULE_WHITE, TUBE, WARM, SIGNAL_RED])
    for (const [tx, tz] of GATE_DISTRICTS.slice(0, 6)) {
      const lamps = []
      for (const cy of [-1, 0, 1]) {
        for (const c of districtChunks(SEED, tx, tz, cy)) {
          expect(c.lamps.filter((l) => l.lit).length).toBeLessThanOrEqual(12)
          for (const l of c.lamps) {
            expect(tints.has(l.tint), `tint ${l.tint}`).toBe(true)
            if (cy === 0) lamps.push({ gx: c.cx * CHUNK + l.lx, gz: c.cz * CHUNK + l.lz, lit: l.lit, tint: l.tint })
          }
        }
      }
      for (const l of lamps) {
        if (!l.lit || (l.tint !== SODIUM && l.tint !== MERCURY)) continue
        const near = lamps.some((m) => m !== l && m.lit && Math.hypot(m.gx - l.gx, m.gz - l.gz) <= NEXT_ISLAND)
        expect(near, `lonely lit head at ${l.gx},${l.gz}`).toBe(true)
      }
    }
  }, 60_000)

  it('anomalies: rare (ANOMALY_RATE of the districts), rotated between edge neighbours, never near the spawn or in the exit district; every class drawn', () => {
    for (const seed of [1, 2, SEED]) {
      const a = anchorDistrict(seed)
      const counts = Object.fromEntries(ANOMALY_CLASSES.map((c) => [c, 0]))
      let total = 0
      let some = 0
      districts(10, (tx, tz) => {
        const c = anomalyAt(seed, tx, tz)
        if (cheb(tx, tz, 0, 0) <= 1 || (tx === a.tx && tz === a.tz)) {
          expect(c).toBeNull()
          return
        }
        total++
        if (c !== null) {
          some++
          counts[c]++
        }
        for (const [dx, dz] of [[1, 0], [0, 1]]) {
          const n = anomalyAt(seed, tx + dx, tz + dz)
          if (c && n) expect(n, `${tx},${tz}`).not.toBe(c)
        }
      })
      expect(some / total).toBeGreaterThan(ANOMALY_RATE - 0.08)
      expect(some / total).toBeLessThan(ANOMALY_RATE + 0.08)
      for (const cls of ANOMALY_CLASSES) expect(counts[cls], `${seed} ${cls}`).toBeGreaterThan(0)
    }
  })

  it('anomalies render: the countdown plates count, the other lot plates read b4; a tile of every class audits clean', () => {
    const seed = SEED
    const site = (cls) => {
      for (let r = 2; r < 12; r++) {
        for (let tz = -r; tz <= r; tz++) {
          for (let tx = -r; tx <= r; tx++) if (cheb(tx, tz, 0, 0) === r && anomalyAt(seed, tx, tz) === cls) return { tx, tz }
        }
      }
      return null
    }
    const cd = site('countdown')
    const labels = new Set()
    for (const c of districtChunks(seed, cd.tx, cd.tz, 0)) {
      expect(c.levelLabel).toBe(deckLabel(seed, c.cx, c.cz))
      labels.add(c.levelLabel)
    }
    expect(labels.size).toBeGreaterThan(1)
    expect(chunkOf(seed, 0, 0, 0).levelLabel).toBe(DECK_LABEL)
    // The full lot: the same object in every stall but one — carts, not the
    // dumpster stand-in (no dumpster yard).
    const fl = site('full-lot')
    let carts = 0
    let dumpsters = 0
    for (const cy of [0, 1]) {
      for (const c of districtChunks(seed, fl.tx, fl.tz, cy)) {
        carts += c.furniture.filter((f) => f.kind === PROP_CART).length
        dumpsters += c.furniture.filter((f) => f.kind === PROP_DUMPSTER).length
      }
    }
    // Every stall of every lot (a dense district may hold one lot only).
    expect(carts).toBeGreaterThan(20)
    expect(dumpsters / 16).toBeLessThan(4)
    const src = worldSource(seed, config)
    for (const cls of ANOMALY_CLASSES) {
      const { tx, tz } = site(cls)
      const box = { x0: tx * 4 - 1, z0: tz * 4 - 1, x1: tx * 4 + 3, z1: tz * 4 + 3, y0: -1, y1: 1 }
      const audit = massLeakAudit(src.chunkAt, box, { gen, worldSeed: seed })
      expect([audit.leaks, audit.seals, audit.portViolations, audit.seeThroughToSolid, audit.seeThroughThinMass], cls).toEqual([0, 0, 0, 0, 0])
      const inner = { x0: tx * 4, z0: tz * 4, x1: tx * 4 + 3, z1: tz * 4 + 3, y0: -1, y1: 1 }
      const outer = { x0: inner.x0 - 4, z0: inner.z0 - 4, x1: inner.x1 + 4, z1: inner.z1 + 4, y0: -1, y1: 1 }
      const res = windowConnectivity(src, inner, outer, { gx: tx * SPAN, gz: tz * SPAN, cy: 0 })
      expect({ ok: res.ok, reason: res.reason, stranded: res.stranded }, cls).toEqual({ ok: true, reason: null, stranded: [] })
    }
  }, 120_000)

  it('far districts bake clean: one attempt, no fallback; seams audit clean and every walkable cell (all three storeys) joins the seam road', () => {
    for (const seed of [2, 0x5eed]) {
      const src = worldSource(seed, config)
      for (const [tx, tz] of [[5, -3], [-6, 4], [3, 7]]) {
        const bake = tileBakeAt(seed, districtKey(tx, tz), config)
        expect([bake.fallback, bake.attempts]).toEqual([false, 1])
        const box = { x0: tx * 4 - 1, z0: tz * 4 - 1, x1: tx * 4 + 3, z1: tz * 4 + 3, y0: -1, y1: 1 }
        const audit = massLeakAudit(src.chunkAt, box, { gen, worldSeed: seed })
        expect([audit.leaks, audit.seals, audit.portViolations, audit.seeThroughToSolid, audit.seeThroughThinMass]).toEqual([0, 0, 0, 0, 0])
        const inner = { x0: tx * 4, z0: tz * 4, x1: tx * 4 + 3, z1: tz * 4 + 3, y0: -1, y1: 1 }
        const outer = { x0: inner.x0 - 4, z0: inner.z0 - 4, x1: inner.x1 + 4, z1: inner.z1 + 4, y0: -1, y1: 1 }
        const res = windowConnectivity(src, inner, outer, { gx: tx * SPAN, gz: tz * SPAN, cy: 0 })
        expect({ ok: res.ok, reason: res.reason, stranded: res.stranded }, `${seed} ${tx},${tz}`).toEqual({ ok: true, reason: null, stranded: [] })
      }
    }
  }, 120_000)

  it('spawn under the refuge canopy of district (0,0); exit in the exit district\'s kiosk basement at Chebyshev 5..11 chunks', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const sp = familySpawn(config, seed)
      expect([Math.floor(sp.cx / DISTRICT), Math.floor(sp.cz / DISTRICT)]).toEqual([0, 0])
      const cells = spawnCells(seed)
      expect(cells.map((c) => `${c.gx},${c.gz}`)).toContain(`${sp.cx * CHUNK + sp.lx},${sp.cz * CHUNK + sp.lz}`)
      const bp = blueprint(seed, 0, 0)
      const gas = bp.blocks.find((b) => b.kind === 'gas')
      expect(inside({ x0: cells[0].gx, z0: cells[0].gz, x1: cells[0].gx, z1: cells[0].gz }, grow(gas.rect, 0))).toBe(true)
      const e = exitAnchor(seed)
      const d = cheb(e.cx, e.cz, sp.cx, sp.cz)
      expect(d).toBeGreaterThanOrEqual(5)
      expect(d).toBeLessThanOrEqual(11)
      expect(e.cy).toBe(-1)
      const a = anchorDistrict(seed)
      expect(RING2).toContainEqual(a)
      expect([Math.floor(e.cx / DISTRICT), Math.floor(e.cz / DISTRICT)]).toEqual([a.tx, a.tz])
      expect(kioskChunk(seed, a.tx, a.tz)).not.toBeNull()
    }
  })
})
