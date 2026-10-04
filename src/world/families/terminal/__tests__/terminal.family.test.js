import { describe, expect, it } from 'vitest'
import { CHUNK, cIdx, hIdx, vIdx } from '../../../constants.js'
import { hash2i } from '../../../core/hash.js'
import { auditLayeredPatch } from '../../../audit.js'
import { resolveMapFamily } from '../../../mapFamily.js'
import { CELL_ROOM, PASSAGE_OPEN, WALL_RAIL } from '../../../mapTypes.js'
import { generateChunk } from '../../../generate.js'
import { catalogSliceErrors } from '../../../structures/catalog/audit.js'
import { makeTileCtx } from '../../../tiles/familyChunk.js'
import { cellWalkable } from '../../../tiles/holeMasks.js'
import { massLeakAudit } from '../../../tiles/seams.js'
import { solidChunk } from '../../../tiles/solidChunk.js'
import { TileCanvas } from '../../../tiles/TileCanvas.js'
import { tileWindow } from '../../../tiles/tileKey.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familyGenerator } from '../../generators.js'
import { familyExitHook, familySpawn, hookOf } from '../../hooks.js'
import { familyPlanner } from '../../planners.js'
import { proveReachable, windowConnectivity, worldSource } from '../../reach.js'
import { STRUCTURAL_COUNTERS, plannerKeySweep, runFamilySuite } from '../../__tests__/familyHarness.js'
import {
  TILE,
  anomalyAt,
  atriumAsCatalog,
  bandKey,
  exitTileOf,
  footprint,
  isCheckpoint,
  layoutOf,
  pierPartsOf,
  planSeedOf,
  ports,
  stairSlots,
  tileVariant,
} from '../geometry.js'
import { BOARD_TINT, FLOOD_TINT, GATE_TINT } from '../tile.js'
import { collectInteriorDressing } from '../../../objects/index.js'
import { PROP_FIDS } from '../../../props/index.js'
import { FURN_COUNTER } from '../../../rooms/catalog.js'
import { FACING } from '../../../tiles/floorPlan.js'

// The terminal family suite (spec §11.1, §12.7): W = 3 tiles of the
// terminal row and the apron rows ±1..2 its piers run on into × storeys
// −1..1 (spawn-centred, tx −1..1, tz −2..2); the decision-6 window is 5 tiles
// × the same rows × −1..1.
runFamilySuite('terminal', {
  window: { tiles: [3, 5], storeys: [-1, 1] },
  connWindow: { tiles: [5, 5], storeys: [-1, 1] },
})

// --- terminal specifics (§12.7 Tests) ---------------------------------------------------

const ID = 'terminal'
const config = forcedFamilyConfig(ID)
const profile = resolveMapFamily(config)
const gen = familyGenerator(ID)
const planner = familyPlanner(ID)
const SEEDS = [1, 0x5eed, 777]
const TW = TILE.w * CHUNK // 56 cells per tile along x
const TD = TILE.d * CHUNK // 56 cells per tile along z

// The chunk box (GLOBAL chunks) of tiles tx0..tx1 over storeys y0..y1: the
// terminal row and the apron rows its piers run on into.
const tilesBox = (tx0, tx1, y0 = -1, y1 = 1) => ({ x0: tx0 * TILE.w, z0: -2 * TILE.d, x1: tx1 * TILE.w + TILE.w - 1, z1: 3 * TILE.d - 1, y0, y1 })
const grown = (b) => ({ ...b, x0: b.x0 - TILE.w, x1: b.x1 + TILE.w, z0: b.z0 - 1, z1: b.z1 + 1 })
const cellAt = (src, gx, cy, gz) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  const d = src.chunkAt(cx, cy, cz)
  return { d, i: cIdx(gx - cx * CHUNK, gz - cz * CHUNK), lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}
const walkable = (src, gx, cy, gz) => {
  const { d, lx, lz } = cellAt(src, gx, cy, gz)
  return cellWalkable(d, lx, lz)
}
const sealedClean = (src, box, seed) => {
  const audit = massLeakAudit(src.chunkAt, box, { gen, worldSeed: seed })
  expect(audit.details).toEqual({ leaks: [], seals: [], portViolations: [], seeThroughToSolid: [], seeThroughThinMass: [] })
  expect(audit.sealedMass).toBe(true)
}
const layeredClean = (src, b) => {
  const lay = auditLayeredPatch(src.chunkAt, b.x0, b.y0, b.z0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1)
  expect(Object.fromEntries(STRUCTURAL_COUNTERS.filter((c) => lay[c]).map((c) => [c, lay[c]]))).toEqual({})
}
// A walkable spine cell of tile tx (GLOBAL), for connectivity seeds.
const spineCell = (src, seed, tx) => {
  const s = layoutOf(seed, tx).spine
  for (let x = 2; x < TW - 2; x++) {
    for (let z = s.z0 + 1; z < s.z1; z++) if (walkable(src, tx * TW + x, 0, z)) return { gx: tx * TW + x, gz: z, cy: 0 }
  }
  return null
}
const tileConnected = (src, seed, tx) => {
  const box = tilesBox(tx, tx)
  const res = windowConnectivity(src, box, grown(box), spineCell(src, seed, tx))
  expect({ ok: res.ok, stranded: res.stranded, sealed: res.sealed, pockets: res.pockets }, `tile ${tx} seed ${seed}`).toEqual({ ok: true, stranded: [], sealed: [], pockets: [] })
}
// The level-plate numbers the first-person dressing draws in a chunk.
// (Door numbers, e.g. 'b1506' on a numbered department's rooms, are not
// level plates.)
const PLATE_WORD = /^(C\d+|Err|Arr|dEP|CLUb)$/
const levelPlates = (d) => collectInteriorDressing(d).decals.filter((x) => typeof x.number === 'string' && PLATE_WORD.test(x.number)).map((x) => x.number)
// The first tile tx (scanning outward from 0) of `seed` satisfying `pred`.
const findTile = (seed, pred, span = 60) => {
  for (let i = 0; i <= span; i++) for (const tx of i ? [i, -i] : [0]) if (pred(tx)) return tx
  return null
}
const distinct = (xs) => new Set(xs.map((x) => JSON.stringify(x))).size

// The repeat metric (SP repeat/sim.mjs): a tile's wall-edge and column-cell
// set over its T.w × T.d chunks on one storey; Jaccard between two tiles.
const tileSet = (seed, tx, cy) => {
  const s = new Set()
  for (let dz = 0; dz < TILE.d; dz++) {
    for (let dx = 0; dx < TILE.w; dx++) {
      const c = generateChunk(seed, tx * TILE.w + dx, cy, dz, config)
      for (let i = 0; i < CHUNK * CHUNK; i++) {
        const k = `${dx},${dz},${i}`
        if (c.wallV[i]) s.add('v' + k)
        if (c.wallH[i]) s.add('h' + k)
        if (c.cols[i]) s.add('c' + k + ':' + c.cols[i])
      }
    }
  }
  return s
}
const jaccard = (a, b) => {
  let n = 0
  for (const x of a) if (b.has(x)) n++
  return n / (a.size + b.size - n || 1)
}

describe('terminal family (§12.7)', () => {
  it('tile, footprint and ports: the 4×4 terminal row, the apron rows ±1..2 its long piers run on into; x seams in row 0, north seams where a pier crosses, hashed per seam', () => {
    expect(TILE).toMatchObject({ w: 4, d: 4, backend: 'band', H: 3, lo: -1, hi: 1, rows: [-2, -1, 0, 1, 2], salt: 0x5a17000b })
    for (const seed of SEEDS) {
      for (const tx of [0, -3, 7, 12]) {
        const count = (cy, tz) => {
          let n = 0
          for (let cz = tz * 4; cz < tz * 4 + TILE.d; cz++) for (let cx = tx * 4; cx < tx * 4 + 4; cx++) if (footprint(seed, cx, cy, cz) === 'tile') n++
          return n
        }
        expect([count(-1, 0), count(0, 0), count(1, 0)]).toEqual([16, 16, 16])
        for (const tz of [-2, -1, 1, 2]) {
          // An apron row: departures' chunks round the parts of the piers
          // that run on there, nothing else.
          expect([count(-1, tz), count(1, tz)]).toEqual([0, 0])
          const parts = pierPartsOf(seed, tx, tz)
          const want = new Set(parts.flatMap((p) => p.chunks))
          expect(count(0, tz)).toBe(want.size)
          for (const p of parts) for (let cz = Math.floor(p.rect.z0 / CHUNK); cz <= Math.floor(p.rect.z1 / CHUNK); cz++) expect(footprint(seed, tx * 4 + Math.floor(p.x0 / CHUNK), 0, tz * 4 + cz)).toBe('tile')
        }
        for (const cy of [-2, 2]) expect(footprint(seed, tx * 4, cy, 0)).toBe('solid')
        expect(footprint(seed, tx * 4, 0, 12)).toBe('solid')
        expect(footprint(seed, tx * 4, 0, -9)).toBe('solid')
      }
    }
    for (const seed of SEEDS) {
      const seen = { 0: [], [-1]: [], 1: [] }
      for (let tx = -20; tx <= 20; tx++) {
        const L = layoutOf(seed, tx)
        const k = bandKey(tx)
        for (const cy of [-1, 0, 1]) {
          const [p] = ports(seed, k, 'west', cy)
          seen[cy].push(p)
          // Pure in the seam: tile tx's east port is tile tx+1's west port.
          expect(ports(seed, bandKey(tx + 1), 'west', cy)[0]).toEqual(L.ports[{ 0: 'depE', [-1]: 'bagE', 1: 'mezE' }[cy]])
          if (cy !== 0) expect(ports(seed, k, 'north', cy)).toEqual([])
          for (const tz of [-2, -1, 1, 2]) expect(ports(seed, { tx, tz, band: 0 }, 'west', cy)).toEqual([])
        }
        // North seams: a pier that runs on opens its whole width there, in
        // the row it leaves (row 0's north line, a row ≥ 1's own north line).
        const span = (p) => ({ a0: p.x0, a1: p.x0 + p.w - 1 })
        const byX = (a, b) => a.a0 - b.a0
        expect(ports(seed, k, 'north', 0)).toEqual(L.piers.filter((p) => p.side === 'N' && p.ext > 0).map(span).sort(byX))
        expect(ports(seed, { tx, tz: 1, band: 0 }, 'north', 0)).toEqual(L.piers.filter((p) => p.side === 'S' && p.ext > 0).map(span).sort(byX))
        expect(ports(seed, { tx, tz: -1, band: 0 }, 'north', 0)).toEqual(L.piers.filter((p) => p.side === 'N' && p.ext > TD).map(span).sort(byX))
        expect(ports(seed, { tx, tz: 2, band: 0 }, 'north', 0)).toEqual(L.piers.filter((p) => p.side === 'S' && p.ext > TD).map(span).sort(byX))
        expect(ports(seed, { tx, tz: -2, band: 0 }, 'north', 0)).toEqual([])
        const [dep] = ports(seed, k, 'west', 0)
        const [mez] = ports(seed, k, 'west', 1)
        // Departures: ≥ 6 rows both spines share (the concourse never
        // pinches at a seam); the lane inside them.
        expect(dep.a1 - dep.a0).toBeGreaterThanOrEqual(5)
        expect(dep.a0).toBeGreaterThanOrEqual(L.spine.z0)
        expect(dep.a1).toBeLessThanOrEqual(L.spine.z1)
        expect(mez.a0 >= dep.a0 && mez.a1 <= dep.a1).toBe(true)
      }
      // Hashed per seam: the ports move along the row.
      for (const cy of [-1, 0, 1]) expect(distinct(seen[cy]), `seed ${seed} cy ${cy}`).toBeGreaterThanOrEqual(5)
    }
  })

  it('grammar: every tile composed from seeded dice; pier count, side, length and width, holdroom runs, atrium, baggage hall, mezzanine, checkpoint all vary', () => {
    for (const seed of SEEDS) {
      const pierSig = []
      const holdSig = []
      const atria = []
      const halls = []
      const mezz = []
      const cores = []
      const serp = []
      const counts = { 1: 0, 2: 0, 3: 0 }
      const sides = new Set()
      const widths = new Set()
      const lengths = []
      for (let tx = -60; tx <= 60; tx++) {
        const L = layoutOf(seed, tx)
        expect(L.landside).toBe(tx === 0)
        expect(L.checkpoint).toBe(isCheckpoint(seed, tx))
        expect([1, 2, 3]).toContain(L.piers.length)
        counts[L.piers.length]++
        expect(tileVariant(seed, tx).piers).toBe(L.piers.length)
        expect(L.deadPier === -1).toBe(L.piers.length === 1)
        for (const p of L.piers) {
          sides.add(p.side)
          widths.add(p.w)
          // The pier stands on the spine and inside the tile.
          expect(p.x0).toBeGreaterThanOrEqual(1)
          expect(p.x0 + p.w - 1).toBeLessThanOrEqual(TW - 2)
          // A pier that runs on reaches the seam row; one that ends here
          // keeps a row of mass short of it.
          expect(p.rect.z0).toBeGreaterThanOrEqual(p.ext && p.side === 'N' ? 0 : 1)
          expect(p.rect.z1).toBeLessThanOrEqual(p.ext && p.side === 'S' ? TD - 1 : TD - 2)
          lengths.push(p.len + p.ext)
          if (p.ext) {
            // Its parts fill each apron row it crosses, the tip in the last.
            expect(p.parts.reduce((n, q) => n + q.len, 0)).toBe(p.ext)
            expect(p.parts.map((q) => q.tz)).toEqual(p.parts.map((_, j) => (j + 1) * p.sgn))
            for (const q of p.parts.slice(0, -1)) expect([q.len, q.tip]).toEqual([TD, 0])
            const last = p.parts[p.parts.length - 1]
            expect(last.tip).toBeGreaterThanOrEqual(5)
            expect(last.len).toBeLessThanOrEqual(TD - 10)
            expect(p.tip).toBe(0)
          } else expect(p.tip).toBeGreaterThanOrEqual(5)
          // Its stair core is strictly inside one chunk (cells 1..12).
          const r = p.core.rect
          expect(Math.floor(r.x0 / CHUNK)).toBe(Math.floor(r.x1 / CHUNK))
          expect(Math.floor(r.z0 / CHUNK)).toBe(Math.floor(r.z1 / CHUNK))
          holdSig.push([p.runsW, p.runsE])
        }
        pierSig.push(L.piers.map((p) => [p.side, p.x0, p.w, p.len]))
        if (L.atrium) atria.push([L.atrium.box.x0, L.atrium.box.x1, L.atrium.style, L.atrium.bridges.length])
        else expect(L.checkpoint).toBe(true)
        halls.push([L.bag.hall, L.bag.jog])
        mezz.push([L.mez.z0, L.mez.z1])
        cores.push([L.mezCore.side, L.mezCore.rect.x0])
        if (L.serpentine) serp.push([L.serpentine.x0, L.serpentine.lanes])
        // The pure memo: the same object on a second read, after churn.
        expect(layoutOf(seed, tx)).toBe(L)
      }
      expect(counts[1]).toBeGreaterThan(10)
      expect(counts[2]).toBeGreaterThan(10)
      expect(counts[3]).toBeGreaterThan(5)
      expect(sides).toEqual(new Set(['N', 'S']))
      expect(widths.size).toBeGreaterThanOrEqual(2)
      expect(distinct(pierSig)).toBeGreaterThan(100)
      expect(distinct(holdSig)).toBeGreaterThan(60)
      expect(distinct(atria)).toBeGreaterThan(60)
      expect(distinct(halls)).toBeGreaterThan(100)
      expect(distinct(mezz)).toBeGreaterThan(5)
      expect(distinct(cores)).toBeGreaterThan(30)
      expect(distinct(serp)).toBeGreaterThan(5)
      // Doc §4.1: long dead-end piers (6–14 chunks): most piers run on into
      // the apron rows, a good share past six chunks; none is a stub.
      const chunks = lengths.map((n) => n / CHUNK)
      expect(chunks.filter((n) => n >= 2.5).length / chunks.length, `seed ${seed}`).toBeGreaterThanOrEqual(0.7)
      expect(chunks.filter((n) => n >= 6).length / chunks.length, `seed ${seed}`).toBeGreaterThanOrEqual(0.15)
      expect(Math.min(...chunks)).toBeGreaterThanOrEqual(1)
    }
    // Order independence: far tiles first, after other seeds churned the
    // memo, read the same skeleton.
    const far = [400, -400, 37, -37].map((tx) => JSON.stringify(layoutOf(0x7e57, tx)))
    for (let s2 = 100; s2 < 140; s2++) for (let tx = 0; tx < 8; tx++) layoutOf(s2, tx)
    expect([400, -400, 37, -37].map((tx) => JSON.stringify(layoutOf(0x7e57, tx)))).toEqual(far)
  })

  it('repeat gate: over 12 tiles the mean pairwise wall/column Jaccard is ≤ 0.25 and the max ≤ 0.45 on departures and baggage', () => {
    const seed = 12345
    for (const cy of [0, -1]) {
      const sets = []
      for (let a = 0; a < 12; a++) sets.push(tileSet(seed, a * 2 + 1, cy))
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
      expect(sum / n, `mean, cy ${cy}`).toBeLessThanOrEqual(0.25)
      expect(max, `max, cy ${cy}`).toBeLessThanOrEqual(0.45)
    }
  }, 60_000)

  it('identity (doc 08 §4, §12): departures glazed 0.3–0.5 onto the apron, baggage halls not an office warren, no tile copies another\'s skeleton', () => {
    // Six tiles (24 chunks) of two seeds, measured on the world.
    for (const seed of [31337, 12345]) {
      const stats = {}
      for (const cy of [0, -1]) {
        let closed = 0
        let glass = 0
        const rooms = new Map()
        const mass = (cx, cz, i) => generateChunk(seed, cx, cy, cz, config).cols[i] === 1
        for (let cx = 20; cx <= 43; cx++) {
          for (let cz = 0; cz < TILE.d; cz++) {
            const d = generateChunk(seed, cx, cy, cz, config)
            for (let i = 0; i < CHUNK * CHUNK; i++) {
              const x = i % CHUNK
              const z = Math.floor(i / CHUNK)
              const here = d.cols[i] !== 1
              if (d.cellKind[i] === CELL_ROOM && d.spaceId[i] && here) {
                const k = `${d.spaceId[i]}:${Math.floor(cx / TILE.w)}`
                rooms.set(k, (rooms.get(k) ?? 0) + 1)
              }
              // Glass share: glazed edges of the closed edges touching a walkable cell.
              if (d.wallV[i] && (here || (x > 0 ? d.cols[i - 1] !== 1 : !mass(cx - 1, cz, z * CHUNK + CHUNK - 1)))) {
                closed++
                if (d.wallFeatureV[i] === 1) glass++
              }
              if (d.wallH[i] && (here || (z > 0 ? d.cols[i - CHUNK] !== 1 : !mass(cx, cz - 1, (CHUNK - 1) * CHUNK + x)))) {
                closed++
                if (d.wallFeatureH[i] === 1) glass++
              }
            }
          }
        }
        const sizes = [...rooms.values()]
        stats[cy] = { glass: glass / closed, roomsPerTile: sizes.length / 6, meanRoom: sizes.reduce((a, b) => a + b, 0) / sizes.length }
      }
      // Doc §12: glass 0.3–0.5 of closed edges (curtain walls, glazed fronts).
      expect(stats[0].glass, `seed ${seed}`).toBeGreaterThanOrEqual(0.3)
      expect(stats[0].glass, `seed ${seed}`).toBeLessThanOrEqual(0.5)
      // Halls, not a warren of closets: few, large rooms (the copied office
      // fill had ~95 rooms of ~18 cells a tile down there).
      expect(stats[-1].roomsPerTile, `seed ${seed}`).toBeLessThanOrEqual(50)
      expect(stats[-1].meanRoom, `seed ${seed}`).toBeGreaterThanOrEqual(28)
      expect(stats[0].roomsPerTile, `seed ${seed}`).toBeLessThanOrEqual(60)
    }
    // 1200 skeletons (spine, piers, atrium, baggage hall, mezzanine): all distinct.
    const sk = []
    for (const seed of [3, 4, 5, 6]) {
      for (let tx = -150; tx < 150; tx++) {
        const L = layoutOf(seed, tx)
        sk.push([L.spine, L.piers.map((p) => [p.side, p.x0, p.w, p.len, p.core.cx]), L.atrium?.box ?? null, L.bag.hall, L.bag.jog, L.mez])
      }
    }
    expect(distinct(sk)).toBe(sk.length)
  }, 60_000)

  it('planner: the spine atria in every tile (0 nulls over 2000 keys), clear of the serpentine, the grammar\'s geometry at true global coordinates', () => {
    const sweep = plannerKeySweep(planner, TILE, SEEDS[0], profile, config, 2000)
    expect(sweep).toMatchObject({ keys: 2000, nulls: 0, ruleErrors: [] })
    const styles = new Set()
    const counts = {}
    for (const seed of SEEDS) {
      for (let tx = -12; tx <= 12; tx++) {
        const k = bandKey(tx)
        const list = planner.structuresInTile(seed, k, profile, config)
        const L = layoutOf(seed, tx)
        // The apron rows carry no volume.
        for (const tz of [-2, -1, 1, 2]) expect(planner.structuresInTile(seed, { tx, tz, band: 0 }, profile, config)).toEqual([])
        // One stamp per atrium: the spine atrium (slot 0) and, in most tiles,
        // a second one further along the spine (slot 1); a checkpoint bay's
        // keep clear of its serpentine.
        expect(L.atria.length).toBeGreaterThanOrEqual(1)
        if (L.serpentine) for (const a of L.atria) expect(a.box.x1 < L.serpentine.x0 - 2 || a.box.x0 > L.serpentine.x0 + L.serpentine.lanes + 1, `seed ${seed} tile ${tx}`).toBe(true)
        expect(L.atria[0]).toBe(L.atrium)
        expect(list).toHaveLength(L.atria.length)
        counts[L.atria.length] = (counts[L.atria.length] ?? 0) + 1
        const ox = tx * TW
        const sh = (r) => ({ x0: r.x0 + ox, z0: r.z0, x1: r.x1 + ox, z1: r.z1 })
        const linkChunks = new Set()
        for (const [i, s] of list.entries()) {
          const spec = L.atria[i]
          const { plan } = atriumAsCatalog(spec)
          expect([s.slot, s.kind, s.family, s.type, s.baseCy, s.topCy]).toEqual([i, 'terminalCatalog', ID, 'spineAtrium', 0, 1])
          expect(s.globalBounds).toEqual(sh(plan.bounds))
          expect(s.levels[1].voids).toEqual(plan.levels[1].voids.map(sh))
          expect(s.levels[1].bridges).toEqual(plan.levels[1].bridges.map(sh))
          styles.add(spec.style)
          // The ring box is the spine's rows: the stamp only opens circulation.
          expect([spec.box.z0, spec.box.z1]).toEqual([L.spine.z0, L.spine.z1])
          for (const p of s.participants) expect(Math.floor(p.cx / TILE.w)).toBe(tx)
          expect(s.verticalLinks).toHaveLength(1)
          const [l] = s.verticalLinks
          expect(l.lowerCy).toBe(0)
          linkChunks.add(`${l.cx},${l.cz}`)
          // The service stairs never share the link's chunk (stairSlots).
          for (const t of stairSlots(seed, k)) expect(t.cx === l.cx && t.cz === l.cz).toBe(false)
          for (const p of s.participants) for (const cy of [0, 1]) expect(planner.structureAt(seed, p.cx, p.cz, cy, profile, config)).toBe(s)
          expect(planner.verticalOpeningAt(seed, l.cx, l.cz, 0, profile, config)).toBe(true)
        }
        // Two atria never share a chunk.
        const parts = list.flatMap((s) => s.participants.map((p) => `${p.cx},${p.cz}`))
        expect(new Set(parts).size).toBe(parts.length)
        expect(linkChunks.size).toBe(list.length)
        for (const t of stairSlots(seed, k)) expect(planner.verticalOpeningAt(seed, t.cx, t.cz, t.lowerCy, profile, config)).toBe(true)
      }
    }
    expect(counts[1] > 0 && counts[2] > 0, JSON.stringify(counts)).toBe(true)
    expect(styles).toEqual(new Set(['none', 'deck', 'cross']))
    // Doc §4.1: the spine is 2–4 storeys high. The atria's voids open the
    // spine to the mezzanine's roof over ≥ 40 % of its length on average.
    let len = 0
    let n = 0
    for (const seed of SEEDS) {
      for (let tx = -100; tx < 100; tx++) {
        const cols = new Set()
        for (const a of layoutOf(seed, tx).atria) for (let x = a.x0; x <= a.x1; x++) cols.add(x)
        len += cols.size / TW
        n++
      }
    }
    expect(len / n).toBeGreaterThanOrEqual(0.4)
  })

  it('a forced attempt-1 bake (new tileSeed, same planSeed) matches the planner: no kit:planner-mismatch, no blocked port', () => {
    for (const seed of SEEDS) {
      for (const tx of [0, 1, -2, 5]) {
        const k = bandKey(tx)
        const planSeed = planSeedOf(seed, k)
        const win = tileWindow(TILE, k)
        const canvas = new TileCanvas({
          family: ID, base: 'tower', version: config.version, worldSeed: seed, origin: k.origin, district: { dx: tx, dz: 0 },
          keep: (cx, cy, cz) => cx >= win.cx0 && cx <= win.cx1 && cz >= win.cz0 && cz <= win.cz1 && cy >= k.cy0 && cy <= k.cy1 &&
            footprint(seed, cx, cy, cz) === 'tile',
          solidChunk: (cx, cy, cz) => solidChunk(seed, cx, cy, cz, config, ID, { district: { dx: tx, dz: 0 } }),
        })
        const ctx = makeTileCtx(gen, profile, seed, config, k, canvas, { tileSeed: hash2i(planSeed, 1, 0x7e) >>> 0, planSeed, attempt: 1 })
        let res = null
        expect(() => { res = gen.bake(canvas, ctx) }).not.toThrow()
        expect(res?.error).toBeUndefined()
        expect(ctx.notes.filter((n) => n.startsWith('kit:') || n.startsWith('seam:'))).toEqual([])
        const a = layoutOf(seed, tx).bag.arrivals
        expect(ctx.exits).toEqual([{ gx: tx * TW + a.gx, gz: a.gz, cy: -1 }])
      }
    }
  })

  it('the spine, the baggage tunnel and the mezzanine lane each cross four tile seams, negative x included, on their own storey', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const [cy, key, what] of [[0, 'dep', 'spine'], [-1, 'bag', 'baggage tunnel'], [1, 'mez', 'mezzanine lane']]) {
        const box = tilesBox(-2, 1, cy, cy)
        const west = layoutOf(seed, -2).ports[key]
        const east = layoutOf(seed, 1).ports[`${key}E`]
        const pick = (gx, p) => {
          for (let z = p.a0; z <= p.a1; z++) if (walkable(src, gx, cy, z)) return { gx, gz: z, cy }
          return null
        }
        const from = pick(-2 * TW, west)
        const to = pick(2 * TW - 1, east)
        expect(from && to, `seed ${seed}: the ${what}'s ports are walkable`).toBeTruthy()
        const proof = proveReachable(src, from, to, box)
        expect(proof.ok, `seed ${seed}: the ${what} from tile −2 to tile 1 (${proof.reason})`).toBe(true)
      }
    }
  })

  it('the atrium stamp in every style: leaks 0, slices clean, the box edges keep the plan (no room merged), connected', () => {
    const sites = new Map()
    for (const seed of [...SEEDS, 2, 3]) {
      for (let tx = -10; tx <= 10; tx++) {
        const L = layoutOf(seed, tx)
        if (!L.atrium) continue
        const key = `${L.atrium.style}${L.atrium.box.x1 - L.atrium.box.x0 > 18 ? '-2col' : '-1col'}`
        if (!sites.has(key)) sites.set(key, { seed, tx, L })
      }
    }
    expect(sites.size).toBeGreaterThanOrEqual(4)
    for (const { seed, tx, L } of sites.values()) {
      const src = worldSource(seed, config)
      const box = tilesBox(tx, tx)
      sealedClean(src, grown(box), seed)
      layeredClean(src, box)
      for (const s of planner.structuresInTile(seed, bandKey(tx), profile, config)) for (const p of s.participants) {
        for (const cy of [0, 1]) {
          const d = src.chunkAt(p.cx, cy, p.cz)
          if (d.structureUp) expect(catalogSliceErrors(d, d.structureUp, 'up')).toEqual([])
          if (d.structureDown) expect(catalogSliceErrors(d, d.structureDown, 'down')).toEqual([])
        }
      }
      // On the box's perimeter lines, every open (non-door) edge that touches
      // a room joins two cells of that same room.
      const ox = tx * TW
      for (const { box: b } of L.atria) for (const cy of [0, 1]) {
        const cell = (gx, gz) => {
          const { d, i } = cellAt(src, gx, cy, gz)
          return { room: d.cellKind[i] === CELL_ROOM, space: d.spaceId[i], mass: d.cols[i] === 1 }
        }
        const check = (a, c, axis) => {
          const { d, lx, lz } = cellAt(src, c[0], cy, c[1])
          const wall = axis === 'v' ? d.wallV[vIdx(lx, lz)] : d.wallH[hIdx(lx, lz)]
          const passage = axis === 'v' ? d.passageV[vIdx(lx, lz)] : d.passageH[hIdx(lx, lz)]
          const A = cell(...a)
          const C = cell(...c)
          if (A.mass || C.mass || wall === 1 || passage !== PASSAGE_OPEN || !(A.room || C.room)) return
          expect(A.room && C.room && A.space === C.space, `open room edge ${a}|${c} cy ${cy} tile ${tx} seed ${seed}`).toBe(true)
        }
        for (let gz = b.z0; gz <= b.z1; gz++) {
          check([ox + b.x0 - 1, gz], [ox + b.x0, gz], 'v')
          check([ox + b.x1, gz], [ox + b.x1 + 1, gz], 'v')
        }
        for (let gx = ox + b.x0; gx <= ox + b.x1; gx++) {
          check([gx, b.z0 - 1], [gx, b.z0], 'h')
          check([gx, b.z1], [gx, b.z1 + 1], 'h')
        }
      }
      tileConnected(src, seed, tx)
    }
  })

  it('reclaim halls 14+ deep with 2..4 carousels, FIDS in the check-in hall, travelator belts left walkable', () => {
    let second = 0
    for (const seed of SEEDS) {
      for (let tx = -12; tx <= 12; tx++) {
        const { hall, hall2 } = layoutOf(seed, tx).bag
        expect(hall.z1 - hall.z0 + 1, `seed ${seed} tile ${tx}`).toBeGreaterThanOrEqual(14)
        expect(hall.x1 - hall.x0 + 1, `seed ${seed} tile ${tx}`).toBeGreaterThanOrEqual(14)
        if (hall2) {
          second++
          expect(hall2.r.z1 - hall2.r.z0 + 1).toBeGreaterThanOrEqual(12)
          expect(['reclaim', 'greeting']).toContain(hall2.kind)
        }
      }
    }
    expect(second).toBeGreaterThan(0)
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const tx of [0, 3]) {
        const L = layoutOf(seed, tx)
        // Carousels: runs of belt counters inside the reclaim hall (BAG).
        const h = L.bag.hall
        let belts = 0
        for (let gz = h.z0; gz <= h.z1; gz++) {
          for (let x = h.x0; x <= h.x1; x++) {
            const { d, lx, lz } = cellAt(src, tx * TW + x, -1, gz)
            if (d.furniture.some((f) => f.kind === FURN_COUNTER && f.lx === lx && f.lz === lz)) belts++
          }
        }
        // 2..4 carousels, each 2..3 wide and 4..10 long.
        expect(belts, `seed ${seed} tile ${tx}`).toBeGreaterThanOrEqual(2 * 2 * 4)
        // The travelator lanes on the spine are open floor (no piece on them).
        const s = L.spine
        for (let gz = s.z0; gz <= s.z1; gz++) {
          for (let x = 0; x < TW; x++) {
            const { d, lx, lz } = cellAt(src, tx * TW + x, 0, gz)
            const i = hIdx(lx, lz)
            const railN = d.wallH[i] && d.wallFeatureH[i] === WALL_RAIL
            const below = cellAt(src, tx * TW + x, 0, gz + 1)
            const j = hIdx(below.lx, below.lz)
            const railS = below.d.wallH[j] && below.d.wallFeatureH[j] === WALL_RAIL
            if (!railN || !railS) continue
            expect(cellWalkable(d, lx, lz), `belt ${x},${gz} seed ${seed} tile ${tx}`).toBe(true)
            expect(d.furniture.some((f) => f.lx === lx && f.lz === lz), `belt ${x},${gz} seed ${seed} tile ${tx}`).toBe(false)
          }
        }
      }
      // The landside check-in hall: FIDS boards at its islands.
      const L0 = layoutOf(seed, 0)
      let fids = 0
      for (let gz = L0.hall.z0; gz <= L0.hall.z1; gz++) {
        for (let x = L0.hall.x0; x <= L0.hall.x1; x++) {
          const { d, lx, lz } = cellAt(src, x, 0, gz)
          fids += d.furniture.filter((f) => f.kind === PROP_FIDS && f.lx === lx && f.lz === lz).length
        }
      }
      expect(fids, `seed ${seed}`).toBeGreaterThanOrEqual(2)
    }
  })

  it('landside in tile 0, checkpoint serpentines elsewhere: the serpentine\'s rails exactly where the grammar put them', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      const cp = findTile(seed, (tx) => isCheckpoint(seed, tx))
      const plain = findTile(seed, (tx) => tx !== 0 && !isCheckpoint(seed, tx))
      // Rails across the spine's rows (V lines, tile-local x0..x1): the
      // serpentine's stanchions. (The travelators' balustrades run along
      // their belts, H lines on the spine and V lines down the piers,
      // outside the spine's rows; the check-in queue rails stand in tile 0's
      // hall, west of the serpentine.)
      const railsIn = (tx, x0 = 0, x1 = TW - 1) => {
        const s = layoutOf(seed, tx).spine
        let n = 0
        for (let gz = s.z0; gz <= s.z1; gz++) {
          for (let x = x0; x <= x1; x++) {
            const { d, lx, lz } = cellAt(src, tx * TW + x, 0, gz)
            const i = vIdx(lx, lz)
            if (d.wallV[i] && d.wallFeatureV[i] === WALL_RAIL) n++
          }
        }
        return n
      }
      for (const tx of [0, cp]) {
        const L = layoutOf(seed, tx)
        const rows = L.spine.z1 - L.spine.z0 + 1
        expect(railsIn(tx, L.serpentine.x0, L.serpentine.x0 + L.serpentine.lanes - 1), `seed ${seed} tile ${tx}`).toBe(L.serpentine.lanes * (rows - 1))
        if (tx !== 0) expect(railsIn(tx), `seed ${seed} tile ${tx}`).toBe(L.serpentine.lanes * (rows - 1))
      }
      expect(layoutOf(seed, plain).serpentine).toBeNull()
      expect(railsIn(plain)).toBe(0)
      // No atrium over the serpentine: no structure on its chunk columns.
      const sp = layoutOf(seed, cp).serpentine
      for (let cx = Math.floor(sp.x0 / CHUNK); cx <= Math.floor((sp.x0 + sp.lanes - 1) / CHUNK); cx++) for (let cz = 1; cz <= 2; cz++) expect(src.chunkAt(cp * 4 + cx, 0, cz).structure ?? null).toBeNull()
      // The landside's check-in hall opens onto the west seam at the port.
      const L0 = layoutOf(seed, 0)
      expect(L0.hall.x0).toBe(0)
      for (let gz = L0.ports.dep.a0; gz <= L0.ports.dep.a1; gz++) {
        const { d, lx, lz } = cellAt(src, 0, 0, gz)
        expect(d.cols[cIdx(lx, lz)] === 1, `hall row ${gz}`).toBe(false)
        expect(d.wallV[vIdx(0, lz)]).toBe(0)
      }
      sealedClean(src, grown(tilesBox(cp, cp)), seed)
      tileConnected(src, seed, cp)
    }
  })

  it('one-, two- and three-pier tiles, either side: glass ≥ 4 mass from solid chunks, sealed and connected', () => {
    for (const seed of SEEDS) {
      const want = [(L) => L.piers.length === 1 && L.piers[0].side === 'N', (L) => L.piers.length === 1 && L.piers[0].side === 'S', (L) => L.piers.length === 2, (L) => L.piers.length === 3]
      const src = worldSource(seed, config)
      for (const pred of want) {
        const tx = findTile(seed, (t) => Math.abs(t) >= 2 && pred(layoutOf(seed, t)))
        expect(tx, `seed ${seed}`).not.toBeNull()
        const box = tilesBox(tx, tx)
        sealedClean(src, grown(box), seed)
        layeredClean(src, box)
        tileConnected(src, seed, tx)
      }
    }
  })

  it('long piers (doc §4.1): a pier two apron rows out is one walk from the spine to its tip lounge, glazed, gated, plated, sealed and connected', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const side of ['N', 'S']) {
        const tx = findTile(seed, (t) => Math.abs(t) >= 2 && layoutOf(seed, t).piers.some((p) => p.side === side && p.ext > TD))
        expect(tx, `seed ${seed} ${side}`).not.toBeNull()
        const L = layoutOf(seed, tx)
        const p = L.piers.find((q) => q.side === side && q.ext > TD)
        // 6–9 chunks from the spine to the dead end.
        expect((p.len + p.ext) / CHUNK).toBeGreaterThanOrEqual(6)
        const tip = p.parts[p.parts.length - 1]
        const ox = tx * TW
        const mid = ox + p.conc.x0 + 1
        const from = { gx: mid, gz: p.sgn < 0 ? L.spine.z0 : L.spine.z1, cy: 0 }
        const farRow = (p.sgn < 0 ? tip.rect.z0 + 1 : tip.rect.z1 - 1) + tip.tz * TD
        let to = null
        for (let gx = ox + p.x0; gx < ox + p.x0 + p.w && !to; gx++) if (walkable(src, gx, 0, farRow)) to = { gx, gz: farRow, cy: 0 }
        expect(to, `seed ${seed} tile ${tx}: the tip lounge is floor`).toBeTruthy()
        const proof = proveReachable(src, from, to, { x0: tx * 4, z0: -2 * TILE.d, x1: tx * 4 + 3, z1: 3 * TILE.d - 1, y0: 0, y1: 0 })
        expect(proof.ok, `seed ${seed} tile ${tx}: spine to tip (${proof.reason})`).toBe(true)
        // Holdrooms with gates down both rows it crosses: seats, podiums,
        // FIDS and glass in every apron row's part; the gate plate on it.
        for (const q of p.parts) {
          let seats = 0
          let glass = 0
          for (let cz = Math.floor(q.rect.z0 / CHUNK); cz <= Math.floor(q.rect.z1 / CHUNK); cz++) {
            for (let cx = Math.floor(p.x0 / CHUNK); cx <= Math.floor((p.x0 + p.w - 1) / CHUNK); cx++) {
              const d = src.chunkAt(tx * 4 + cx, 0, q.tz * TILE.d + cz)
              expect(d.levelLabel).toMatch(/^(C\d+|Err)$/)
              seats += d.furniture.length
              for (let i = 0; i < CHUNK * CHUNK; i++) glass += (d.wallV[i] && d.wallFeatureV[i] === 1 ? 1 : 0) + (d.wallH[i] && d.wallFeatureH[i] === 1 ? 1 : 0)
            }
          }
          expect(seats, `seed ${seed} tile ${tx} row ${q.tz}`).toBeGreaterThan(q.len)
          expect(glass, `seed ${seed} tile ${tx} row ${q.tz}`).toBeGreaterThan(q.len)
        }
        // Nothing of the apron rows but the pier's chunks: no baggage, no
        // mezzanine out there.
        for (const q of p.parts) for (const cy of [-1, 1]) expect(footprint(seed, tx * 4 + Math.floor(p.x0 / CHUNK), cy, q.tz * TILE.d)).toBe('solid')
        sealedClean(src, grown(tilesBox(tx, tx)), seed)
        tileConnected(src, seed, tx)
      }
    }
  })

  it('spawn in tile 0\'s check-in hall; exit at the arrivals door (cy −1) of tile ±(2..3)', () => {
    const hooks = hookOf(ID)
    expect(hooks.stub).toBe(false)
    for (const seed of [...SEEDS, 4242, 99]) {
      const sp = familySpawn(config, seed)
      const L0 = layoutOf(seed, 0)
      const s0 = L0.spawnCells[0]
      expect([sp.cx * CHUNK + sp.lx, sp.cz * CHUNK + sp.lz]).toEqual([s0.gx, s0.gz])
      expect(s0.gx >= L0.hall.x0 && s0.gx <= L0.hall.x1 && s0.gz >= L0.hall.z0 && s0.gz <= L0.hall.z1).toBe(true)
      const src = worldSource(seed, config)
      const ex = familyExitHook(config)({ worldSeed: seed, level: 1, config, profile, generate: src.chunkAt })
      const tx = exitTileOf(seed)
      expect([2, 3]).toContain(Math.abs(tx))
      const a = layoutOf(seed, tx).bag.arrivals
      const gx = tx * TW + a.gx
      expect(ex).toEqual({ cx: Math.floor(gx / CHUNK), cy: -1, cz: Math.floor(a.gz / CHUNK), lx: gx - Math.floor(gx / CHUNK) * CHUNK, lz: a.gz % CHUNK })
      expect(ex).toEqual(hooks.exitAnchor(seed, profile))
      expect(anomalyAt(seed, tx)).toBeNull()
      const box = hooks.proofBox(ex, sp)
      expect(box).toEqual({ chunks: { x0: Math.min(tx, 0) * 4, z0: 0, x1: Math.max(tx, 0) * 4 + 3, z1: 3 }, cy: [-1, 0] })
    }
    // The exit tiles over many seeds: all four occur.
    const seen = new Set()
    for (let s = 0; s < 200; s++) seen.add(exitTileOf(s))
    expect([...seen].sort((a, b) => a - b)).toEqual([-3, -2, 2, 3])
    expect(hooks.exitHookStats.lastResort).toBe(0)
  })

  it('anomalies: hashed per tile, one per 1–2 piers, never the same class twice in a row along the row, never near spawn or on the exit tile', () => {
    const maps = []
    let piers = 0
    let anomalies = 0
    for (const seed of [...SEEDS, 2, 3, 4, 5, 6]) {
      const exitTx = exitTileOf(seed)
      let present = 0
      let cells = 0
      const classes = new Set()
      const sig = []
      let last = null // the previous anomaly along the row (west to east)
      for (let tx = -60; tx <= 60; tx++) {
        const a = anomalyAt(seed, tx)
        sig.push(a ?? '-')
        if (Math.abs(tx) <= 1 || tx === exitTx) {
          expect(a, `seed ${seed} tile ${tx}`).toBeNull()
          continue
        }
        cells++
        const v = tileVariant(seed, tx)
        piers += v.piers
        if (!a) continue
        present++
        classes.add(a)
        expect(['board', 'dead']).toContain(a)
        // Doc 14: never the same class twice in a row, gaps included.
        if (last) expect(a, `seed ${seed} tile ${tx} after ${last.tx}`).not.toBe(last.a)
        last = { a, tx }
        expect(v.anomalyPier).toBeGreaterThanOrEqual(0)
        expect(v.anomalyPier).toBeLessThan(v.piers)
        // Both classes sit on the pier that should be lit.
        expect(v.anomalyPier).not.toBe(v.deadPier)
      }
      anomalies += present
      expect(present / cells, `seed ${seed} density`).toBeGreaterThan(0.75)
      expect(present / cells, `seed ${seed} density`).toBeLessThan(0.97)
      expect(classes).toEqual(new Set(['board', 'dead']))
      maps.push(sig.join(''))
    }
    expect(new Set(maps).size).toBe(maps.length)
    // Doc 14: terminal, segment = pier, rate 1–2.
    expect(piers / anomalies).toBeGreaterThanOrEqual(1)
    expect(piers / anomalies).toBeLessThanOrEqual(2.15)
    const seed = 0x7e57
    const far = [400, -400, 37, -37, 3, -3].map((tx) => anomalyAt(seed, tx))
    for (let s2 = 100; s2 < 120; s2++) anomalyAt(s2, 50)
    expect([400, -400, 37, -37, 3, -3].map((tx) => anomalyAt(seed, tx))).toEqual(far)
    let prev = null
    for (let tx = 2; tx <= 400; tx++) {
      const a = anomalyAt(seed, tx)
      if (a && prev) expect(a).not.toBe(prev)
      if (a) prev = a
    }
  })

  it('anomalies in the world: the board error plates read "Err" and glow red, the dead pier has no lit lamp, the tip FIDS turns, both tiles sealed and connected', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const cls of ['board', 'dead']) {
        const tx = findTile(seed, (t) => anomalyAt(seed, t) === cls)
        expect(tx, `seed ${seed} ${cls}`).not.toBeNull()
        const L = layoutOf(seed, tx)
        const p = L.piers[L.anomalyPier]
        const ox = tx * TW
        const core = src.chunkAt(tx * 4 + p.core.cx, 0, p.core.cz)
        if (cls === 'board') expect(core.levelLabel, `seed ${seed} tile ${tx}`).toBe('Err')
        else expect(core.levelLabel).toMatch(/^C\d+$/)
        // The anomaly pier's lamps (holdrooms, concourse, tip), in the
        // terminal row and every apron row it runs on into (GLOBAL rows);
        // the apron's floodlight through the glass is not the pier's.
        const pieces = [{ rect: p.rect, tz: 0 }, ...p.parts.map((q) => ({ rect: q.rect, tz: q.tz }))]
        const lit = []
        for (const { rect, tz } of pieces) {
          const z0 = rect.z0 + tz * TD
          const z1 = rect.z1 + tz * TD
          for (let cz = Math.floor(z0 / CHUNK); cz <= Math.floor(z1 / CHUNK); cz++) {
            for (let cx = Math.floor(p.x0 / CHUNK); cx <= Math.floor((p.x0 + p.w - 1) / CHUNK); cx++) {
              for (const l of src.chunkAt(tx * 4 + cx, 0, cz).lamps) {
                const gx = cx * CHUNK + l.lx
                const gz = cz * CHUNK + l.lz
                if (l.lit && l.tint !== FLOOD_TINT && gx >= p.x0 && gx <= p.x0 + p.w - 1 && gz >= z0 && gz <= z1) lit.push(l)
              }
            }
          }
        }
        if (cls === 'dead') expect(lit, `dead pier of seed ${seed} tile ${tx}`).toEqual([])
        else {
          // The board error: the lit pier's gate glow is error-red, no cool gate light left.
          expect(lit.filter((l) => l.tint === BOARD_TINT).length).toBeGreaterThanOrEqual(2)
          expect(lit.filter((l) => l.tint === GATE_TINT)).toEqual([])
        }
        // Its tip FIDS stand faces the glass (board) or the concourse.
        const fids = []
        const tip = p.ext ? p.parts[p.parts.length - 1] : p
        const off = p.ext ? tip.tz * TD : 0
        const [t0, t1] = p.sgn < 0 ? [tip.rect.z0 + off, tip.rect.z0 + off + tip.tip - 1] : [tip.rect.z1 + off - tip.tip + 1, tip.rect.z1 + off]
        for (let gz = t0; gz <= t1; gz++) {
          for (let gx = p.x0; gx < p.x0 + p.w; gx++) {
            const { d, lx, lz } = cellAt(src, ox + gx, 0, gz)
            for (const f of d.furniture) if (f.kind === PROP_FIDS && f.lx === lx && f.lz === lz) fids.push(f)
          }
        }
        expect(fids.length, `tip FIDS of seed ${seed} tile ${tx}`).toBe(1)
        const toSpine = p.sgn < 0 ? FACING.S : FACING.N
        const toGlass = p.sgn < 0 ? FACING.N : FACING.S
        expect(fids[0].facing).toBe(cls === 'board' ? toGlass : toSpine)
        sealedClean(src, grown(tilesBox(tx, tx)), seed)
        tileConnected(src, seed, tx)
      }
    }
  })

  it('plates are drawn: every pier\'s gate number (or Err) at its stair top, Arr at its foot, CLUb at the mezzanine stair; Arr / dEP / CLUb on the storeys', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (let tx = -6; tx <= 6; tx++) {
        const L = layoutOf(seed, tx)
        for (const p of L.piers) {
          const cx = tx * 4 + p.core.cx
          const d = src.chunkAt(cx, 0, p.core.cz)
          expect(levelPlates(d), `seed ${seed} tile ${tx} pier ${p.i}`).toEqual([d.levelLabel])
          expect(d.levelLabel).toMatch(L.anomaly === 'board' && L.anomalyPier === p.i ? /^Err$/ : /^C\d+$/)
          expect(levelPlates(src.chunkAt(cx, -1, p.core.cz))).toEqual(['Arr'])
        }
        expect(levelPlates(src.chunkAt(tx * 4 + L.mezCore.cx, 1, L.mezCore.cz)), `seed ${seed} tile ${tx}`).toEqual(['CLUb'])
        const plain = (cy, cz) => [0, 1, 2, 3].map((c) => src.chunkAt(tx * 4 + c, cy, cz)).filter((d) => !L.piers.some((p) => tx * 4 + p.core.cx === d.cx && p.core.cz === d.cz))
        for (const d of plain(-1, 1)) expect(d.levelLabel).toBe('Arr')
        expect(plain(0, 1).some((d) => d.levelLabel === 'dEP' || /^(C\d+|Err)$/.test(d.levelLabel))).toBe(true)
        for (const d of [1, 2].flatMap((cz) => [0, 1, 2, 3].map((c) => src.chunkAt(tx * 4 + c, 1, cz)))) expect(d.levelLabel).toBe('CLUb')
      }
    }
  })
})
