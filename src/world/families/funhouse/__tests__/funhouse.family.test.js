import { describe, expect, it } from 'vitest'
import { CHUNK, chunkKey3, hIdx, vIdx } from '../../../constants.js'
import { hash2i, hashStr } from '../../../core/hash.js'
import { auditLayeredPatch } from '../../../audit.js'
import { resolveMapFamily } from '../../../mapFamily.js'
import { PROP_ARCADE, PROP_BALL_TRACK, PROP_MASCOT } from '../../../props/index.js'
import { FACING } from '../../../tiles/floorPlan.js'
import { makeTileCtx, tileBakeAt } from '../../../tiles/familyChunk.js'
import { cellWalkable } from '../../../tiles/holeMasks.js'
import { massLeakAudit } from '../../../tiles/seams.js'
import { solidChunk } from '../../../tiles/solidChunk.js'
import { TileCanvas } from '../../../tiles/TileCanvas.js'
import { tileSeed, tileWindow } from '../../../tiles/tileKey.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familyGenerator } from '../../generators.js'
import { familyExitHook, familySpawn, hookOf } from '../../hooks.js'
import { familyPlanner } from '../../planners.js'
import { componentPartition, proveReachable, windowConnectivity, worldSource } from '../../reach.js'
import { STRUCTURAL_COUNTERS, runFamilySuite } from '../../__tests__/familyHarness.js'
import {
  ANOMALY_CLASSES,
  LIE_CEIL,
  LIE_CLASSES,
  LIE_FREE,
  MIDWAY_ROWS,
  PORT_ROW_MAX,
  PORT_ROW_MIN,
  ROT_REACH,
  SPAWN_CELLS,
  STUB,
  TILE,
  TILE_CELLS_X,
  TILE_CELLS_Z,
  anomalyAt,
  attractionOf,
  exitTileOf,
  footprint,
  lieBudget,
  liesAt,
  pavilionKey,
  ports,
  portRowOf,
  skeletonOf,
  stairChunkAt,
  stairCore,
  walkwayExitCells,
} from '../geometry.js'

// The funhouse family suite (spec §11.1, §12.12): W = 3 pavilions × storeys
// 0..1 (the chain has one row of tiles); the decision-6 window is 5
// pavilions × [0, 1].
runFamilySuite('funhouse', {
  window: { tiles: [3, 1], storeys: [0, 1] },
  connWindow: { tiles: [5, 1], storeys: [0, 1] },
})

// --- funhouse specifics (§12.12 Tests) -----------------------------------------------

const ID = 'funhouse'
const config = forcedFamilyConfig(ID)
const profile = resolveMapFamily(config)
const gen = familyGenerator(ID)
const planner = familyPlanner(ID)
const SEEDS = [1, 0x5eed, 777]
const TC = TILE_CELLS_X // 42 cells per pavilion along the chain

// Pavilions tx0..tx1 as a GLOBAL chunk box over storeys y0..y1.
const pavilions = (tx0, tx1, y0 = 0, y1 = 1) => ({ x0: tx0 * 3, z0: 0, x1: tx1 * 3 + 2, z1: 1, y0, y1 })
const cellAt = (src, gx, gz, cy) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { d: src.chunkAt(cx, cy, cz), lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}
const noteOf = (bake, re) => bake.notes.map((n) => re.exec(n)).find(Boolean)

describe('funhouse family (§12.12)', () => {
  it('tile, footprint and ports: a one-row chain of 3×2-chunk pavilions on storeys 0..1; the midway x-seam port only', () => {
    expect(TILE).toMatchObject({ w: 3, d: 2, backend: 'band', H: 2, lo: 0, hi: 1, rows: [0], salt: 0x5a170010 })
    for (const tx of [0, 1, -1, 7, -40, 1000]) {
      let kept = 0
      for (const cy of [0, 1]) for (const cz of [0, 1]) for (let cx = tx * 3; cx < tx * 3 + 3; cx++) if (footprint(1, cx, cy, cz) === 'tile') kept++
      expect(kept, `pavilion ${tx}`).toBe(12)
      for (const [cy, cz] of [[0, -1], [0, 2], [1, 2], [-1, 0], [2, 0], [2, 1]]) expect(footprint(1, tx * 3, cy, cz)).toBe('solid')
    }
    // The spawn pavilion's west seam is the spawn's rows; every other seam
    // hashes its own two rows (pure in the seam), and they vary.
    expect(ports(1, { tx: 0, tz: 0 }, 'west', 0)).toEqual([{ a0: MIDWAY_ROWS.z0, a1: MIDWAY_ROWS.z1 }])
    expect(MIDWAY_ROWS).toEqual({ z0: 4, z1: 5 })
    const rows = new Set()
    for (let tx = -20; tx <= 20; tx++) {
      const p = portRowOf(1, tx)
      expect(ports(1, { tx, tz: 0 }, 'west', 0)).toEqual([{ a0: p, a1: p + 1 }])
      expect(p >= PORT_ROW_MIN && p <= PORT_ROW_MAX).toBe(true)
      expect(skeletonOf(1, tx).mid).toBe(p)
      expect(skeletonOf(1, tx - 1).portE).toBe(p)
      rows.add(p)
    }
    expect(rows.size).toBeGreaterThanOrEqual(4)
    for (const [side, cy] of [['north', 0], ['west', 1], ['north', 1]]) expect(ports(1, { tx: 3, tz: 0 }, side, cy)).toEqual([])
    expect(planner.structuresInTile(1, pavilionKey(0), profile, config)).toEqual([])
    expect(planner.structureAt(1, 0, 0, 0, profile, config)).toBeNull()
  })

  it('the chain: the midway crosses every seam (at that seam\'s rows) into the next pavilion\'s midway and lobby; 5 pavilions are one graph', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (let tx = -2; tx <= 2; tx++) {
        const east = portRowOf(seed, tx + 1)
        for (let gz = 0; gz < TILE_CELLS_Z; gz++) {
          // The east column (x 41) is mass except at the east port's rows,
          // where the midway crosses it.
          const e = cellAt(src, tx * TC + TC - 1, gz, 0)
          expect(cellWalkable(e.d, e.lx, e.lz), `east column ${tx},${gz}`).toBe(gz === east || gz === east + 1)
        }
        const p = portRowOf(seed, tx)
        for (const gz of [p, p + 1]) {
          // The west line (x 0) is open at the west port's rows.
          const west = cellAt(src, tx * TC, gz, 0)
          expect(cellWalkable(west.d, west.lx, west.lz), `west port ${tx},${gz}`).toBe(true)
          expect(west.d.wallV[vIdx(0, west.lz)], `west seam ${tx},${gz}`).toBe(0)
        }
      }
      // One component over 5 pavilions × both storeys (chain.mjs: 3 → 1).
      const comps = componentPartition(src, pavilions(-2, 2))
      comps.sort((a, b) => b.length - a.length)
      const main = new Set(comps[0])
      expect(comps.slice(1).filter((c) => c.length > 24)).toEqual([])
      for (let tx = -2; tx <= 2; tx++) {
        for (const cy of [0, 1]) {
          const end = skeletonOf(seed, tx).stairA.path.at(-1)
          // Storey 0: the midway's cell on the pavilion's west port.
          const probe = cy === 0 ? [tx * TC, portRowOf(seed, tx)] : [tx * TC + end.gx, end.gz]
          expect(main.has(`${probe[0]},${probe[1]},${cy}`), `pavilion ${tx} storey ${cy} in the main graph`).toBe(true)
        }
      }
      // And the walk is real: spawn → pavilion −2's and +2's unload walkways.
      const sp = familySpawn(config, seed)
      for (const tx of [-2, 2]) {
        const end = skeletonOf(seed, tx).stairA.path.at(-1)
        const proof = proveReachable(src, { gx: sp.cx * CHUNK + sp.lx, gz: sp.cz * CHUNK + sp.lz, cy: 0 }, { gx: tx * TC + end.gx, gz: end.gz, cy: 1 }, pavilions(Math.min(tx, 0), Math.max(tx, 0)))
        expect(proof.ok, `seed ${seed} to pavilion ${tx}: ${proof.reason}`).toBe(true)
      }
    }
  })

  it('stairs: two enclosed cores per pavilion, placed by its skeleton, through kit.stairwell; verticalOpeningAt marks exactly their chunks', () => {
    const placements = new Set()
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const tx of [-1, 0, 1, 5]) {
        const sk = skeletonOf(seed, tx)
        const chunksOf = new Set()
        for (const s of [sk.stairA, sk.stairB]) {
          // Each core lies strictly inside one chunk (stairwellPlan's rule)
          // and inside the shed; the two cores never share a chunk.
          expect(s.core).toEqual(stairCore(s.gx, s.gz, s.dir))
          const cx = Math.floor(s.core.x0 / CHUNK)
          const cz = Math.floor(s.core.z0 / CHUNK)
          expect([Math.floor(s.core.x1 / CHUNK), Math.floor(s.core.z1 / CHUNK)]).toEqual([cx, cz])
          expect(s.core.x0 % CHUNK).toBeGreaterThanOrEqual(1)
          expect(s.core.z0 % CHUNK).toBeGreaterThanOrEqual(1)
          expect(s.core.x1 % CHUNK).toBeLessThanOrEqual(CHUNK - 2)
          expect(s.core.z1 % CHUNK).toBeLessThanOrEqual(CHUNK - 2)
          expect(s.core.x0 >= 1 && s.core.x1 <= TC - 2 && s.core.z0 >= 0 && s.core.z1 <= TILE_CELLS_Z - 2).toBe(true)
          chunksOf.add(`${cx},${cz}`)
        }
        expect(chunksOf.size).toBe(2)
        placements.add(`${seed}|${tx}|${[...chunksOf].sort().join(';')}|${sk.stairA.gx},${sk.stairA.gz},${sk.stairA.dir}|${sk.stairB.gx},${sk.stairB.gz},${sk.stairB.dir}`)
        const box = pavilions(tx, tx)
        for (let cz = box.z0; cz <= box.z1; cz++) {
          for (let cx = box.x0; cx <= box.x1; cx++) {
            const lx = cx - tx * 3
            const stair = chunksOf.has(`${lx},${cz}`)
            expect(stairChunkAt(seed, cx, cz, 0)).toBe(stair)
            const g = src.chunkAt(cx, 0, cz)
            const r = src.chunkAt(cx, 1, cz)
            expect(!!g.stairUp, `stair up ${cx},0,${cz}`).toBe(stair)
            expect(!!r.stairDown, `stair down ${cx},1,${cz}`).toBe(stair)
            expect(r.stairUp ?? null).toBeNull()
            if (stair) expect(JSON.stringify(r.stairDown)).toBe(JSON.stringify(g.stairUp))
            expect(planner.verticalOpeningAt(seed, cx, cz, 0, profile, config)).toBe(stair)
            expect(planner.verticalOpeningAt(seed, cx, cz, 1, profile, config)).toBe(false)
          }
        }
      }
      expect(planner.verticalOpeningAt(seed, 0, 2, 0, profile, config)).toBe(false)
    }
    // The stairs move: no two of the 12 pavilions share a stair placement.
    expect(new Set([...placements].map((p) => p.split('|').slice(2).join('|'))).size).toBe(12)
  })

  it('every pavilion is its own: the ground and ride storeys of 12 pavilions share few walls (pairwise Jaccard)', () => {
    // The liminal sameness is the repeated parts (booths, bulbs, mirror
    // panes, track, bays); the layouts differ. Same metric as the repeat
    // audit: wall and column keys over the pavilion's 6 chunks.
    const seed = 0x5eed
    const src = worldSource(seed, config)
    const setOf = (tx, cy) => {
      const out = new Set()
      for (let cz = 0; cz <= 1; cz++) {
        for (let dx = 0; dx < 3; dx++) {
          const d = src.chunkAt(tx * 3 + dx, cy, cz)
          for (let i = 0; i < CHUNK * CHUNK; i++) {
            const k = `${dx},${cz},${i}`
            if (d.wallV[i]) out.add(`v${k}`)
            if (d.wallH[i]) out.add(`h${k}`)
            if (d.cols[i]) out.add(`c${k}:${d.cols[i]}`)
          }
        }
      }
      return out
    }
    for (const cy of [0, 1]) {
      const sets = [-11, -9, -7, -5, -3, -1, 1, 3, 5, 7, 9, 11].map((tx) => setOf(tx, cy))
      let sum = 0
      let n = 0
      let max = 0
      for (let i = 0; i < sets.length; i++) {
        for (let j = i + 1; j < sets.length; j++) {
          let inter = 0
          for (const x of sets[i]) if (sets[j].has(x)) inter++
          const jac = inter / (sets[i].size + sets[j].size - inter)
          sum += jac
          n++
          max = Math.max(max, jac)
        }
      }
      // The repeat gate: mean ≤ 0.25, max ≤ 0.45 (measured 0.22 / 0.33).
      expect(sum / n, `storey ${cy} mean`).toBeLessThanOrEqual(0.25)
      expect(max, `storey ${cy} max`).toBeLessThanOrEqual(0.45)
    }
    // The frame moves too: the midway's route (rows, width, jogs), the
    // lobby's shape and place, the booth bands and the pavilion's size and
    // outline differ along the chain.
    const frames = [-11, -9, -7, -5, -3, -1, 1, 3, 5, 7, 9, 11].map((tx) => skeletonOf(seed, tx))
    expect(new Set(frames.map((f) => f.mid)).size).toBeGreaterThanOrEqual(5)
    expect(new Set(frames.map((f) => JSON.stringify([f.route.wide, f.route.rows, f.route.jogs]))).size).toBe(12)
    expect(new Set(frames.map((f) => f.route.rows.length)).size).toBeGreaterThanOrEqual(2)
    expect(new Set(frames.map((f) => f.route.wide))).toEqual(new Set([2, 3]))
    expect(new Set(frames.map((f) => f.lobby.type)).size).toBeGreaterThanOrEqual(2)
    expect(new Set(frames.map((f) => `${f.lobby.x0},${f.lobby.z0}`)).size).toBeGreaterThanOrEqual(10)
    expect(new Set(frames.map((f) => JSON.stringify(f.bands.map((b) => [b.side, b.x0, b.x1, b.depth])))).size).toBe(12)
    expect(new Set(frames.map((f) => JSON.stringify([f.shed, f.notches]))).size).toBeGreaterThanOrEqual(8)
    // The skeletons differ: stairs, loop and platform per pavilion.
    const sigs = new Set()
    for (let tx = -6; tx <= 6; tx++) {
      const sk = skeletonOf(seed, tx)
      sigs.add(JSON.stringify([sk.stairA.core, sk.stairB.core, sk.loopRects, sk.platform.side, sk.platform.length]))
    }
    expect(sigs.size).toBe(13)
  })

  it('no pocket, no leak, no bare pavilion: booth units stay inside their bands, alcoves join what they front, every cell is reached; the attractions always fit', () => {
    // Windows where a one-column band once grew a 2-wide tent into the field
    // (a sealed pocket) or across seam 0 (a leak at row 3), where an arcade
    // fronting a hall lobby was walled off from the midway, or whose
    // skeleton once left no room for the attractions (a solid fallback).
    const cases = [
      [2520520716, -1], [774541575, 0], [922468106, -306], [3485480432, -2], [1844939811, 1], [1514207030, 0],
      [2915347295, 137], [2710938419, 145], [3302644519, -628], [1549107668, -292],
      [2535449476, 0], [198858234, 0], [2012263584, 0], [4217903409, 0], [1042809558, 0],
      [260931938, 96], [2569463954, 51],
    ]
    for (const [seed, tx] of cases) {
      const src = worldSource(seed, config)
      const box = pavilions(tx - 1, tx + 1)
      for (let t = tx - 1; t <= tx + 1; t++) expect(tileBakeAt(seed, pavilionKey(t), config).fallback, `${seed} pavilion ${t}`).toBe(false)
      const xs0 = box.x0 * CHUNK
      const xs1 = (box.x1 + 1) * CHUNK - 1
      for (const part of componentPartition(src, box)) {
        const cells = part.cells ?? part
        const gxs = cells.map((k) => Number(String(k).split(',')[0]))
        expect(Math.min(...gxs) === xs0 || Math.max(...gxs) === xs1, `${seed} pocket of ${cells.length} at ${cells[0]}`).toBe(true)
      }
      const det = massLeakAudit(src.chunkAt, box, { gen, worldSeed: seed }).details
      for (const k of ['leaks', 'seals', 'portViolations', 'seeThroughToSolid', 'seeThroughThinMass']) expect(det[k] ?? [], `${seed} ${k}`).toEqual([])
    }
    // Props: at least 8.5 pieces a chunk on every pavilion's ground storey;
    // mascots are the lobby's barker and at most two more (outside the
    // mirror maze, where only the figure lie stands one).
    for (const seed of [5, 31337]) {
      for (let tx = -40; tx <= 40; tx += 8) {
        const bake = tileBakeAt(seed, pavilionKey(tx), config)
        let pieces = 0
        let mascots = 0
        const [, mx, mz, mw, md] = noteOf(bake, /^mirror maze at (\d+),(\d+) \((\d+)x(\d+)/).map(Number)
        for (const d of bake.chunks.values()) {
          if (d.cy !== 0) continue
          pieces += d.furniture.length
          for (const f of d.furniture) {
            const gx = (d.cx - tx * 3) * CHUNK + f.lx
            const gz = d.cz * CHUNK + f.lz
            if (f.kind === PROP_MASCOT && !(gx >= mx && gx < mx + mw && gz >= mz && gz < mz + md)) mascots++
          }
        }
        expect(pieces, `${seed} pavilion ${tx} pieces`).toBeGreaterThanOrEqual(51)
        expect(mascots, `${seed} pavilion ${tx} mascots`).toBeLessThanOrEqual(3)
      }
    }
  })

  it('the anomaly budget: none within LIE_FREE of the spawn, a chance monotone and symmetric in |tx|, capped below certainty', () => {
    expect(LIE_CLASSES).toEqual(['panel', 'lamp', 'figure'])
    expect(ANOMALY_CLASSES).toEqual(['panel', 'lamp', 'figure', 'uphill', 'turned'])
    expect(LIE_FREE).toBe(2)
    for (const tx of [-2, -1, 0, 1, 2]) expect(lieBudget(tx)).toBe(0)
    for (let a = 0; a < 400; a++) {
      expect(lieBudget(-a)).toBe(lieBudget(a))
      expect(lieBudget(a + 1)).toBeGreaterThanOrEqual(lieBudget(a))
      expect(lieBudget(a)).toBeLessThanOrEqual(LIE_CEIL)
    }
    expect([3, 4, 8, 13, 14, 100, 1e6].map(lieBudget)).toEqual([250, 300, 500, 750, 800, 800, 800])
  })

  it('anomalies (doc 14): at most one per pavilion, none near the spawn or on the exit pavilion, rotated, pure, at the budget\'s rate', () => {
    const layouts = new Set()
    const classes = new Set()
    const rate = { near: [0, 0], far: [0, 0] } // [anomalous, pavilions]
    for (let s = 0; s < 40; s++) {
      const seed = hashStr(`fun-lies-${s}`)
      const ex = exitTileOf(seed)
      const row = []
      for (let tx = -60; tx <= 60; tx++) {
        const a = anomalyAt(seed, tx)
        expect(liesAt(seed, tx)).toEqual(a ? [a] : [])
        if (Math.abs(tx) <= LIE_FREE || tx === ex) expect(a, `seed ${seed} pavilion ${tx}`).toBeNull()
        if (a) {
          expect(ANOMALY_CLASSES).toContain(a)
          classes.add(a)
          if (a === 'uphill') expect(attractionOf(seed, tx)).toBe('level')
          // doc 14: never the same class twice in a row (the next anomalous
          // pavilion within ROT_REACH).
          for (let k = 1; k <= ROT_REACH; k++) {
            const b = anomalyAt(seed, tx + k)
            if (!b) continue
            expect(b, `seed ${seed} ${tx}→${tx + k}`).not.toBe(a)
            break
          }
        }
        const bucket = Math.abs(tx) >= 14 ? rate.far : Math.abs(tx) >= 3 && Math.abs(tx) <= 5 && tx !== ex ? rate.near : null
        if (bucket) {
          bucket[0] += a ? 1 : 0
          bucket[1]++
        }
        row.push(a ?? '-')
      }
      // Pure: the same answer asked in reverse order.
      for (let tx = 60; tx >= -60; tx--) expect(anomalyAt(seed, tx) ?? '-').toBe(row[tx + 60])
      layouts.add(row.join('|'))
    }
    expect(layouts.size).toBe(40)
    expect(classes).toEqual(new Set(ANOMALY_CLASSES))
    // The budget is a chance: about 30% at |tx| 3..5, 80% from |tx| 14 on.
    expect(rate.near[0] / rate.near[1]).toBeGreaterThan(0.18)
    expect(rate.near[0] / rate.near[1]).toBeLessThan(0.45)
    expect(rate.far[0] / rate.far[1]).toBeGreaterThan(0.72)
    expect(rate.far[0] / rate.far[1]).toBeLessThan(0.88)
    // The third attraction: the level room near the spawn, else 1 in 3 black-light.
    let bl = 0
    for (let tx = -2; tx <= 2; tx++) expect(attractionOf(1, tx)).toBe('level')
    for (let tx = 3; tx < 603; tx++) bl += attractionOf(1, tx) === 'blacklight' ? 1 : 0
    expect(bl).toBeGreaterThan(150)
    expect(bl).toBeLessThan(250)
  })

  it('anomalies in the world: each class drawn where it belongs, the honest baseline everywhere else; windows stay sealed and connected', () => {
    const seed = SEEDS[0]
    const src = worldSource(seed, config)
    const ex = exitTileOf(seed)
    // One pavilion per class (the nearest to the spawn), a black-light
    // pavilion, and the honest spawn, neighbours and exit pavilion.
    const want = new Map([[0, null], [1, null], [-1, null], [2, null], [-2, null], [ex, null]])
    const found = new Set()
    let blacklight = null
    for (let k = 3; k < 80 && (found.size < ANOMALY_CLASSES.length || blacklight === null); k++) {
      for (const tx of [k, -k]) {
        const a = anomalyAt(seed, tx)
        if (a && !found.has(a)) {
          found.add(a)
          want.set(tx, a)
        }
        if (blacklight === null && attractionOf(seed, tx) === 'blacklight') {
          blacklight = tx
          want.set(tx, a)
        }
      }
    }
    expect(found).toEqual(new Set(ANOMALY_CLASSES))
    const step = [[0, 1], [0, -1], [1, 0], [-1, 0]] // FACING S, N, E, W
    for (const [tx, a] of want) {
      const bake = tileBakeAt(seed, pavilionKey(tx), config)
      expect(bake.notes.find((n) => n.startsWith('anomaly: ')), `pavilion ${tx}`).toMatch(new RegExp(`^anomaly: ${a ?? 'none'} `))
      expect(bake.notes.filter((x) => x.startsWith('mirror lie: ')).map((x) => x.split(' ')[2])).toEqual(LIE_CLASSES.includes(a) ? [a] : [])
      const [, mx, mz, mw, md] = noteOf(bake, /^mirror maze at (\d+),(\d+) \((\d+)x(\d+)/).map(Number)
      expect(mw).toBe(6)
      expect(md).toBeGreaterThanOrEqual(4)
      expect(md).toBeLessThanOrEqual(6)
      // The mirror maze: the figure stands only in the reflection; the lamp
      // lie kills one of the maze's two lamps; the panel lie breaks the symmetry.
      let mascots = 0
      const lamps = []
      for (let gz = mz; gz < mz + md; gz++) {
        for (let gx = mx; gx < mx + mw; gx++) {
          const { d, lx, lz } = cellAt(src, tx * TC + gx, gz, 0)
          mascots += d.furniture.filter((f) => f.kind === PROP_MASCOT && f.lx === lx && f.lz === lz).length
          lamps.push(...d.lamps.filter((l) => l.lx === lx && l.lz === lz))
        }
      }
      expect(mascots, `figures in pavilion ${tx}`).toBe(a === 'figure' ? 1 : 0)
      expect(lamps).toHaveLength(2)
      expect(lamps.filter((l) => l.lit), `lit mirror lamps in pavilion ${tx}`).toHaveLength(a === 'lamp' ? 1 : 2)
      const line = mx + 3
      let diffs = 0
      for (let gz = mz; gz < mz + md; gz++) {
        for (let gx = mx + 1; gx < line; gx++) {
          const p = cellAt(src, tx * TC + gx, gz, 0)
          const q = cellAt(src, tx * TC + 2 * line - gx, gz, 0)
          if (p.d.wallV[vIdx(p.lx, p.lz)] !== q.d.wallV[vIdx(q.lx, q.lz)]) diffs++
        }
        for (let gx = mx; gx < line; gx++) {
          if (gz === mz) continue
          const p = cellAt(src, tx * TC + gx, gz, 0)
          const q = cellAt(src, tx * TC + 2 * line - 1 - gx, gz, 0)
          if (p.d.wallH[hIdx(p.lx, p.lz)] !== q.d.wallH[hIdx(q.lx, q.lz)]) diffs++
        }
      }
      expect(diffs, `reflection asymmetries in pavilion ${tx}`).toBe(a === 'panel' ? 1 : 0)
      // The third attraction: the ball track flush on the level room's east
      // wall (facing W) unless the ball rolls uphill (turned end-on); or
      // the black-light room's arcade cabinet and UV spots.
      const furn = (cy, kind) => {
        const out = []
        for (let cz = 0; cz <= 1; cz++) {
          for (let cx = tx * 3; cx < tx * 3 + 3; cx++) {
            const d = src.chunkAt(cx, cy, cz)
            for (const f of d.furniture) if (f.kind === kind) out.push({ ...f, gx: cx * CHUNK + f.lx - tx * TC, gz: cz * CHUNK + f.lz })
          }
        }
        return out
      }
      // (Ball-roll games and arcade cabinets also dress the booths and the
      // maze; the attraction's own pieces are the ones inside its room.)
      const inRoom = (list, x, z, w) => list.filter((f) => f.gx >= x && f.gx < x + w && f.gz >= z && f.gz < z + w)
      if (attractionOf(seed, tx) === 'level') {
        const [, lx, lz] = noteOf(bake, /^level room at (\d+),(\d+)/).map(Number)
        const balls = inRoom(furn(0, PROP_BALL_TRACK), lx, lz, 2)
        expect(balls, `ball tracks in pavilion ${tx}`).toHaveLength(1)
        expect(balls[0].facing === FACING.W, `pavilion ${tx}: track flush unless uphill`).toBe(a !== 'uphill')
        expect(inRoom(furn(0, PROP_ARCADE), lx, lz, 2)).toHaveLength(0)
      } else {
        const [, bx, bz] = noteOf(bake, /^black-light room at (\d+),(\d+)/).map(Number)
        expect(inRoom(furn(0, PROP_BALL_TRACK), bx, bz, 3)).toHaveLength(0)
        expect(inRoom(furn(0, PROP_ARCADE), bx, bz, 3)).toHaveLength(1)
      }
      // The ride's animatronic: facing its tableau (furniture in front of
      // it) unless turned toward the track.
      const figs = furn(1, PROP_MASCOT)
      expect(figs, `ride figures in pavilion ${tx}`).toHaveLength(1)
      const [dx, dz] = step[figs[0].facing]
      const ahead = cellAt(src, tx * TC + figs[0].gx + dx, figs[0].gz + dz, 1)
      const tableau = ahead.d.furniture.some((f) => f.lx === ahead.lx && f.lz === ahead.lz)
      expect(tableau, `pavilion ${tx}: the figure faces its tableau unless turned`).toBe(a !== 'turned')
    }
    const lo = Math.min(...want.keys())
    const hi = Math.max(...want.keys())
    for (const t of [...want.keys()].filter((t) => Math.abs(t) > 2)) {
      const [tx0, tx1] = [Math.max(lo, t - 1), Math.min(hi, t + 1)]
      const inner = pavilions(tx0, tx1)
      const outer = pavilions(tx0 - 1, tx1 + 1)
      const res = windowConnectivity(src, inner, outer, { gx: tx0 * TC, gz: portRowOf(seed, tx0), cy: 0 })
      expect({ ok: res.ok, reason: res.reason, stranded: res.stranded, sealed: res.sealed }).toEqual({ ok: true, reason: null, stranded: [], sealed: [] })
      const audit = massLeakAudit(src.chunkAt, { ...outer, z0: -1, z1: 2 }, { gen, worldSeed: seed })
      expect(audit.details).toEqual({ leaks: [], seals: [], portViolations: [], seeThroughToSolid: [], seeThroughThinMass: [] })
      const lay = auditLayeredPatch(src.chunkAt, inner.x0, 0, inner.z0, inner.x1 - inner.x0 + 1, 2, inner.z1 - inner.z0 + 1)
      expect(Object.fromEntries(STRUCTURAL_COUNTERS.filter((c) => lay[c]).map((c) => [c, lay[c]]))).toEqual({})
    }
  })

  it('the exit pavilion\'s ride runs one way: stair A\'s landing sees the walkway through glass; the exit is reached only after the maze and the loop', () => {
    for (let s = 0; s < 12; s++) {
      const seed = s < SEEDS.length ? SEEDS[s] : hashStr(`fun-oneway-${s}`)
      const src = worldSource(seed, config)
      const t = exitTileOf(seed)
      const sk = skeletonOf(seed, t)
      const ex = hookOf(ID).exitAnchor(seed, profile)
      const walkA = sk.stairA.path
      const at = (tx, c) => ({ gx: tx * TC + c.gx, gz: c.gz, cy: 1 })
      const landing = at(t, walkA[0])
      const loadSide = at(t, sk.stairB.path[0]) // stair B's door on the ride storey
      // On the ride storey alone the landing cannot reach the exit (a pane
      // across the walkway after STUB cells); the load side can, but only
      // round the loop, past the cut at the gate.
      const ride = pavilions(t, t, 1, 1)
      expect(proveReachable(src, landing, ex, ride).ok, `seed ${seed}: landing → exit on the ride storey`).toBe(false)
      const round = proveReachable(src, loadSide, ex, ride)
      expect(round.ok, `seed ${seed}: load side → exit`).toBe(true)
      // The route rides the whole loop: a 2-wide ring of loopCells cells is
      // about loopCells / 2 long round, plus the walkways at both ends.
      expect(round.steps, `seed ${seed}: round the loop`).toBeGreaterThan(sk.loopCells / 2)
      const [p, q] = [walkA[STUB - 1], walkA[STUB]]
      const pc = cellAt(src, t * TC + Math.max(p.gx, q.gx), Math.max(p.gz, q.gz), 1)
      const wall = p.gx === q.gx ? pc.d.wallH[hIdx(pc.lx, pc.lz)] : pc.d.wallV[vIdx(pc.lx, pc.lz)]
      expect(wall, `seed ${seed}: the pane across the walkway`).toBeGreaterThan(0)
      // From the spawn, the proof needs the maze, stair B and the ride.
      const sp = familySpawn(config, seed)
      const full = proveReachable(src, sp, ex, hookOf(ID).proofBox(ex, sp))
      expect(full.ok, `seed ${seed}: spawn → exit`).toBe(true)
      expect(full.steps).toBeGreaterThan((t - 1) * TC + round.steps)
      // Any other pavilion keeps the loop round: its landing walks straight
      // down its walkway.
      const nwalk = skeletonOf(seed, t + 1).stairA.path
      const nb = proveReachable(src, at(t + 1, nwalk[0]), at(t + 1, nwalk.at(-1)), pavilions(t + 1, t + 1, 1, 1))
      expect(nb.ok).toBe(true)
      expect(nb.steps).toBeLessThan(nwalk.length + 2)
    }
  })

  it('spawn on pavilion 0\'s midway; exit on the unload walkway (storey 1) of pavilion 2..4, in bounds, over 64 seeds', () => {
    const hooks = hookOf(ID)
    expect(hooks.stub).toBe(false)
    expect(hooks.exitBounds).toEqual({ minChunks: 5, maxChunks: 14, cy: [1, 1] })
    const hist = new Map()
    for (let s = 0; s < 64; s++) {
      const seed = s < SEEDS.length ? SEEDS[s] : hashStr(`fun-exit-${s}`)
      const sp = familySpawn(config, seed)
      expect([sp.cx, sp.cz, sp.lx, sp.lz]).toEqual([0, 0, SPAWN_CELLS[0].gx, SPAWN_CELLS[0].gz])
      const src = worldSource(seed, config)
      const ex = familyExitHook(config)({ worldSeed: seed, level: 1 + (s % 3), config, profile, generate: src.chunkAt })
      const t = exitTileOf(seed)
      hist.set(t, (hist.get(t) ?? 0) + 1)
      expect(t).toBeGreaterThanOrEqual(2)
      expect(t).toBeLessThanOrEqual(4)
      expect(ex).toEqual(hooks.exitAnchor(seed, profile))
      const gx = ex.cx * CHUNK + ex.lx - t * TC
      const gz = ex.cz * CHUNK + ex.lz
      expect(ex.cy).toBe(1)
      expect(walkwayExitCells(seed, t).some((c) => c.gx === gx && c.gz === gz), `seed ${seed} exit on the walkway, past the pane`).toBe(true)
      const dist = Math.max(Math.abs(ex.cx - sp.cx), Math.abs(ex.cz - sp.cz))
      expect(dist).toBeGreaterThanOrEqual(hooks.exitBounds.minChunks)
      expect(dist).toBeLessThanOrEqual(hooks.exitBounds.maxChunks)
      const box = hooks.proofBox(hooks.exitAnchor(seed, profile), sp)
      expect(box).toEqual({ chunks: { x0: 0, z0: 0, x1: t * 3 + 2, z1: 1 }, cy: [0, 1] })
      const d = src.chunkAt(ex.cx, ex.cy, ex.cz)
      expect(d.furniture.filter((f) => f.lx === ex.lx && f.lz === ex.lz)).toEqual([])
      expect(d.levelLabel).toBe('nUF')
    }
    expect([...hist.keys()].sort()).toEqual([2, 3, 4])
    expect(hooks.exitHookStats.lastResort).toBe(0)
  })

  it('plates read FUn below and nUF above on every pavilion chunk; a forced attempt-1 bake matches the plan', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const tx of [-3, 0, 2]) {
        const b = pavilions(tx, tx)
        for (let cz = b.z0; cz <= b.z1; cz++) {
          for (let cx = b.x0; cx <= b.x1; cx++) {
            expect(src.chunkAt(cx, 0, cz).levelLabel).toBe('FUn')
            expect(src.chunkAt(cx, 1, cz).levelLabel).toBe('nUF')
          }
        }
        // The bake's chunks are exactly the footprint's (12 per pavilion).
        const bake = tileBakeAt(seed, pavilionKey(tx), config)
        const kept = []
        for (const cy of [0, 1]) for (const cz of [0, 1]) for (let cx = tx * 3; cx < tx * 3 + 3; cx++) kept.push(chunkKey3(cx, cy, cz))
        expect([...bake.chunks.keys()].sort()).toEqual(kept.sort())
        expect(bake.stats.untouchedKept).toBe(0)
        expect(bake.notes.filter((n) => n.startsWith('kit:') || n.startsWith('seam:'))).toEqual([])
        // Attempt 1: a new tileSeed, the same planSeed. Nothing cross-tile
        // reads the tileSeed, so the bake succeeds with the same exits.
        const k = pavilionKey(tx)
        const planSeed = tileSeed(seed, TILE.salt, k)
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
        expect(ctx.exits).toEqual(bake.exits.map((e) => ({ ...e })))
        expect(ctx.spawns).toHaveLength(tx === 0 ? 1 : 0)
      }
    }
  })
})
