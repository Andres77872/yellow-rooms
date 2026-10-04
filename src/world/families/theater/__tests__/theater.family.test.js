import { describe, expect, it } from 'vitest'
import { CHUNK, chunkKey3, hIdx, vIdx } from '../../../constants.js'
import { hash2i } from '../../../core/hash.js'
import { auditLayeredPatch } from '../../../audit.js'
import { resolveMapFamily } from '../../../mapFamily.js'
import { buildChunk } from '../../../pipeline.js'
import { FACING } from '../../../tiles/floorPlan.js'
import { PROP_GHOST_LIGHT, PROP_SEAT_ROW } from '../../../props/index.js'
import { catalogSliceErrors } from '../../../structures/catalog/audit.js'
import { isCatalogKind, linkHalo } from '../../../structures/catalog/engine.js'
import { makeTileCtx, tileBakeAt } from '../../../tiles/familyChunk.js'
import { cellWalkable } from '../../../tiles/holeMasks.js'
import { massLeakAudit } from '../../../tiles/seams.js'
import { solidChunk } from '../../../tiles/solidChunk.js'
import { TileCanvas } from '../../../tiles/TileCanvas.js'
import { tileWindow } from '../../../tiles/tileKey.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familyGenerator } from '../../generators.js'
import { familyExitHook, familySpawn, hookOf } from '../../hooks.js'
import { familyPlanner } from '../../planners.js'
import { componentPartition, proveReachable, worldSource } from '../../reach.js'
import { STRUCTURAL_COUNTERS, plannerKeySweep, runFamilySuite } from '../../__tests__/familyHarness.js'
import {
  ANOMALY_CLASSES,
  HOUSES,
  TILE,
  anomalyAt,
  bandKey,
  exitTileOf,
  footprint,
  frameOf,
  keptLocal,
  participantChunk,
  planSeedOf,
  ports,
  schemeOf,
  spawnCellsOfWorld,
} from '../geometry.js'
import { planTheatre } from '../layout.js'

// The theater family suite (spec §11.1, §12.8): W = 2×2 tiles × storeys
// −1..1; the decision-6 window is 3×3 tiles × −1..1.
runFamilySuite('theater', {
  window: { tiles: [2, 2], storeys: [-1, 1] },
  connWindow: { tiles: [3, 3], storeys: [-1, 1] },
})

// --- theater specifics (§12.8 Tests) -------------------------------------------------

const ID = 'theater'
const config = forcedFamilyConfig(ID)
const profile = resolveMapFamily(config)
const gen = familyGenerator(ID)
const planner = familyPlanner(ID)
const SEEDS = [1, 0x5eed, 777]
const TW = TILE.w * CHUNK // 42 cells
const TD = TILE.d * CHUNK // 42 cells

// The tile's chunk box (GLOBAL chunks) over storeys y0..y1.
const tileBox = (tx, tz, y0 = -1, y1 = 3) => ({ x0: tx * 3, z0: tz * 3, x1: tx * 3 + 2, z1: tz * 3 + 2, y0, y1 })

// A GLOBAL cell of the world: { d, lx, lz }.
const cellOf = (src, gx, cy, gz) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { d: src.chunkAt(cx, cy, cz), lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}
const walk = (src, gx, cy, gz) => {
  const c = cellOf(src, gx, cy, gz)
  return cellWalkable(c.d, c.lx, c.lz)
}
// Is the edge between (gx-1, gz) and (gx, gz) (axis 'v') or (gx, gz-1) and
// (gx, gz) (axis 'h') open? The line belongs to the east/south cell's chunk.
const openEdge = (src, axis, gx, cy, gz) => {
  const c = cellOf(src, gx, cy, gz)
  return axis === 'v' ? !c.d.wallV[vIdx(c.lx, c.lz)] : !c.d.wallH[hIdx(c.lx, c.lz)]
}
// Pieces of `kind` on world storey cy of tile (tx, tz), tile-local cells.
const piecesOf = (src, tx, tz, cy, kind) => {
  const out = []
  for (let lz = 0; lz < 3; lz++) {
    for (let lx = 0; lx < 3; lx++) {
      const d = src.chunkAt(tx * 3 + lx, cy, tz * 3 + lz)
      for (const f of d.furniture) if (f.kind === kind) out.push({ gx: (lx * CHUNK) + f.lx, gz: (lz * CHUNK) + f.lz, facing: f.facing })
    }
  }
  return out
}

// sim.mjs's metric: the wall-edge and column sets of a tile's 3×3 chunks.
function tileSet(seed, tx, tz, cy) {
  const s = new Set()
  for (let dz = 0; dz < 3; dz++) {
    for (let dx = 0; dx < 3; dx++) {
      const c = buildChunk(seed, tx * 3 + dx, cy, tz * 3 + dz, config, null, [])
      for (let i = 0; i < 196; i++) {
        const k = `${dx},${dz},${i}`
        if (c.wallV[i]) s.add(`v${k}`)
        if (c.wallH[i]) s.add(`h${k}`)
        if (c.cols[i]) s.add(`c${k}:${c.cols[i]}`)
      }
    }
  }
  return s
}
const jaccard = (a, b) => {
  let i = 0
  for (const x of a) if (b.has(x)) i++
  return i / (a.size + b.size - i || 1)
}

describe('theater family (§12.8)', () => {
  it('tile, footprint and ports: 3×3 chunks × storeys −1..3; the band on −1..1, the house above; hashed ports', () => {
    expect(TILE).toMatchObject({ w: 3, d: 3, backend: 'band', H: 5, lo: -1, hi: 3, salt: 0x5a170000 + 12 })
    for (const seed of SEEDS) {
      for (const [tx, tz] of [[0, 0], [-3, 2], [5, -7], [2, 2]]) {
        const sc = schemeOf(seed, bandKey(tx, tz))
        const count = (cy) => {
          let n = 0
          for (let cz = tz * 3; cz < tz * 3 + 3; cz++) for (let cx = tx * 3; cx < tx * 3 + 3; cx++) if (footprint(seed, cx, cy, cz) === 'tile') n++
          return n
        }
        const parts = (sc.part.x1 - sc.part.x0 + 1) * (sc.part.z1 - sc.part.z0 + 1) / (CHUNK * CHUNK)
        expect([-1, 0, 1, 2, 3].map(count)).toEqual([9, 9, 9, sc.NL > 3 ? parts : 0, sc.NL > 4 ? parts : 0])
        expect(count(4)).toBe(0)
        expect(count(-2)).toBe(0)
        // Ports: 1–2 on the ground storey, 0–1 on the basement and the first
        // floor, none above; 1–2 cells inside 2..39, at least 3 apart; pure.
        for (const side of ['west', 'north']) {
          const g = ports(seed, { tx, tz }, side, 0)
          expect(g.length).toBeGreaterThanOrEqual(1)
          expect(g.length).toBeLessThanOrEqual(2)
          for (const cy of [-1, 1]) expect(ports(seed, { tx, tz }, side, cy).length).toBeLessThanOrEqual(1)
          for (const cy of [2, 3]) expect(ports(seed, { tx, tz }, side, cy)).toEqual([])
          for (const cy of [-1, 0, 1]) {
            const p = ports(seed, { tx, tz }, side, cy)
            expect(ports(seed, { tx, tz, band: 9 }, side, cy)).toEqual(p)
            for (const { a0, a1 } of p) {
              expect(a0).toBeGreaterThanOrEqual(2)
              expect(a1).toBeLessThanOrEqual(39)
              expect(a1 - a0).toBeLessThanOrEqual(1)
            }
            for (let i = 1; i < p.length; i++) expect(p[i].a0 - p[i - 1].a1).toBeGreaterThan(3)
          }
        }
      }
    }
  })

  it('port symmetry: every seam cell pair is open exactly at the declared ports, on every storey', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const [tx, tz] of [[0, 0], [1, 0], [0, 1], [-1, -1]]) {
        for (let cy = -1; cy <= 3; cy++) {
          const xPorts = ports(seed, { tx, tz }, 'west', cy)
          for (let a = 0; a < TD; a++) {
            const gx = tx * TW
            const gz = tz * TD + a
            const passable = walk(src, gx - 1, cy, gz) && walk(src, gx, cy, gz) && openEdge(src, 'v', gx, cy, gz)
            const port = xPorts.some((p) => a >= p.a0 && a <= p.a1)
            expect(passable, `seed ${seed} west seam of ${tx},${tz} cy ${cy} z+${a}`).toBe(port)
          }
          const zPorts = ports(seed, { tx, tz }, 'north', cy)
          for (let a = 0; a < TW; a++) {
            const gx = tx * TW + a
            const gz = tz * TD
            const passable = walk(src, gx, cy, gz - 1) && walk(src, gx, cy, gz) && openEdge(src, 'h', gx, cy, gz)
            const port = zPorts.some((p) => a >= p.a0 && a <= p.a1)
            expect(passable, `seed ${seed} north seam of ${tx},${tz} cy ${cy} x+${a}`).toBe(port)
          }
        }
      }
    }
  })

  it('planner: one non-null theaterCatalog house per tile, the scheme\'s, at true global coordinates', () => {
    const sweep = plannerKeySweep(planner, TILE, SEEDS[1], profile, config, 300)
    expect(sweep).toMatchObject({ keys: 300, nulls: 0, ruleErrors: [] })
    for (const seed of SEEDS) {
      for (const [tx, tz] of [[0, 0], [1, -1], [-4, 3], [9, 9]]) {
        const k = bandKey(tx, tz)
        const sc = schemeOf(seed, k)
        const list = planner.structuresInTile(seed, k, profile, config)
        const house = HOUSES[sc.house]
        expect(list.map((s) => [s.slot, s.type, s.sizeClass, s.kind, s.family, s.levelCount])).toEqual([[0, house.type, house.sizeClass, 'theaterCatalog', ID, sc.NL]])
        const [s] = list
        const b = sc.bounds
        expect(s.globalBounds).toEqual({ x0: b.x0 + tx * TW, z0: b.z0 + tz * TD, x1: b.x1 + tx * TW, z1: b.z1 + tz * TD })
        expect([s.baseCy, s.topCy]).toEqual([-1, sc.NL - 2])
        expect(s.district).toEqual({ x: tx, z: tz, size: 3 })
        const want = []
        for (let cz = 0; cz < 3; cz++) for (let cx = 0; cx < 3; cx++) if (participantChunk(sc, cx, cz)) want.push([cx, cz])
        expect(s.participants.map((p) => [p.cx - tx * 3, p.cz - tz * 3]).sort()).toEqual(want.sort())
        for (const p of s.participants) for (let cy = -1; cy <= sc.NL - 2; cy++) expect(planner.structureAt(seed, p.cx, p.cz, cy, profile, config)).toBe(s)
        // The streaming hint: the house's slabs, and each band stairwell's
        // chunk over the basement and the ground floor (not above).
        for (const t of sc.skeleton.stairs) {
          const cx = tx * 3 + t.cx
          const cz = tz * 3 + t.cz
          expect(planner.verticalOpeningAt(seed, cx, cz, -1, profile, config)).toBe(true)
          expect(planner.verticalOpeningAt(seed, cx, cz, 0, profile, config)).toBe(true)
          expect(planner.verticalOpeningAt(seed, cx, cz, 1, profile, config)).toBe(false)
        }
        const [p] = s.participants
        expect(planner.verticalOpeningAt(seed, p.cx, p.cz, sc.NL - 3, profile, config)).toBe(true)
        expect(planner.verticalOpeningAt(seed, p.cx, p.cz, sc.NL - 2, profile, config)).toBe(false)
      }
    }
  })

  it('a forced attempt-1 bake (new tileSeed, same planSeed) matches the planner: no kit:planner-mismatch', () => {
    for (const seed of SEEDS) {
      for (const [tx, tz] of [[0, 0], [2, 1], [-2, 0]]) {
        const k = bandKey(tx, tz)
        const planSeed = planSeedOf(seed, k)
        const win = tileWindow(TILE, k)
        const canvas = new TileCanvas({
          family: ID, base: 'hotel', version: config.version, worldSeed: seed, origin: k.origin, district: { dx: tx, dz: tz },
          keep: (cx, cy, cz) => cx >= win.cx0 && cx <= win.cx1 && cz >= win.cz0 && cz <= win.cz1 && cy >= k.cy0 && cy <= k.cy1 &&
            footprint(seed, cx, cy, cz) === 'tile',
          solidChunk: (cx, cy, cz) => solidChunk(seed, cx, cy, cz, config, ID, { district: { dx: tx, dz: tz } }),
        })
        const ctx = makeTileCtx(gen, profile, seed, config, k, canvas, { tileSeed: hash2i(planSeed, 1, 0x7e) >>> 0, planSeed, attempt: 1 })
        let res = null
        expect(() => { res = gen.bake(canvas, ctx) }).not.toThrow()
        expect(res?.error).toBeUndefined()
        expect(ctx.notes.filter((n) => n.startsWith('kit:') || n.startsWith('seam:'))).toEqual([])
        // The exit candidate is the scheme's: pure in the tile, not the tileSeed.
        const [e] = schemeOf(seed, k).exitCells
        expect(ctx.exits).toEqual([{ gx: e.gx + tx * TW, gz: e.gz + tz * TD, cy: -1 }])
      }
    }
  })

  it('each theatre is one connected building, and its trap room is reachable from its stalls inside the tile', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const [tx, tz] of [[0, 0], [1, 1], [-3, 2]]) {
        const comps = componentPartition(src, tileBox(tx, tz))
        expect(comps.length, `components of tile ${tx},${tz}`).toBe(1)
        expect(comps[0].length).toBeGreaterThan(2500)
        const sc = schemeOf(seed, bandKey(tx, tz))
        const [ex] = tileBakeAt(seed, bandKey(tx, tz), config).exits
        const sp = sc.spawnCells.find((c) => walk(src, tx * TW + c.gx, 0, tz * TD + c.gz))
        const from = { gx: tx * TW + sp.gx, gz: tz * TD + sp.gz, cy: 0 }
        const box = { chunks: { x0: tx * 3, z0: tz * 3, x1: tx * 3 + 2, z1: tz * 3 + 2 }, cy: [-1, 1] }
        const proof = proveReachable(src, from, ex, box)
        expect(proof.ok, `trap room of tile ${tx},${tz}: ${proof.reason}`).toBe(true)
        expect(ex.cy).toBe(-1)
        expect(sc.exitCells.some((c) => c.gx === ex.gx - tx * TW && c.gz === ex.gz - tz * TD)).toBe(true)
      }
    }
  })

  it('stair halos, the exit cell and the spawn gangways stay furniture-free', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      const free = (gx, cy, gz, what) => {
        const c = cellOf(src, gx, cy, gz)
        expect(c.d.furniture.filter((f) => f.lx === c.lx && f.lz === c.lz), `${what} ${gx},${gz},${cy}`).toEqual([])
      }
      for (const [tx, tz] of [[0, 0], [1, 0], [-2, 2]]) {
        for (const s of planner.structuresInTile(seed, bandKey(tx, tz), profile, config)) {
          for (const link of s.verticalLinks) {
            const h = linkHalo(link)
            for (const cy of [link.lowerCy, link.lowerCy + 1]) {
              for (let gz = h.z0; gz <= h.z1; gz++) for (let gx = h.x0; gx <= h.x1; gx++) free(gx, cy, gz, 'halo')
            }
          }
        }
        for (const e of tileBakeAt(seed, bandKey(tx, tz), config).exits) free(e.gx, e.cy, e.gz, 'exit')
        for (const c of schemeOf(seed, bandKey(tx, tz)).spawnCells) free(tx * TW + c.gx, 0, tz * TD + c.gz, 'spawn')
      }
    }
  })

  it('spawn in the stalls of tile (0,0); exit in the trap room (cy −1) of a theatre at Chebyshev distance 2', () => {
    const hooks = hookOf(ID)
    expect(hooks.stub).toBe(false)
    for (const seed of [...SEEDS, 4242, 99]) {
      const sp = familySpawn(config, seed)
      const cells = spawnCellsOfWorld(seed)
      expect(cells.some((c) => c.gx === sp.cx * CHUNK + sp.lx && c.gz === sp.cz * CHUNK + sp.lz)).toBe(true)
      const src = worldSource(seed, config)
      const ex = familyExitHook(config)({ worldSeed: seed, level: 1, config, profile, generate: src.chunkAt })
      const t = exitTileOf(seed)
      expect(Math.max(Math.abs(t.tx), Math.abs(t.tz))).toBe(2)
      expect(ex.cy).toBe(-1)
      expect([Math.floor(ex.cx / 3), Math.floor(ex.cz / 3)]).toEqual([t.tx, t.tz])
      expect(ex).toEqual(hooks.exitAnchor(seed, profile))
      const dist = Math.max(Math.abs(ex.cx - sp.cx), Math.abs(ex.cz - sp.cz))
      expect(dist).toBeGreaterThanOrEqual(hooks.exitBounds.minChunks)
      expect(dist).toBeLessThanOrEqual(hooks.exitBounds.maxChunks)
      expect(anomalyAt(seed, bandKey(t.tx, t.tz))).toBeNull()
    }
    expect(hooks.exitHookStats.lastResort).toBe(0)
  })

  it('proofBox: exactly the spawn and exit tiles\' bounding rectangle over the three band storeys', () => {
    const hooks = hookOf(ID)
    for (const seed of [...SEEDS, 2, 3, 4, 5]) {
      const sp = familySpawn(config, seed)
      const ex = hooks.exitAnchor(seed, profile)
      const t = exitTileOf(seed)
      const box = hooks.proofBox(ex, sp)
      expect(box).toEqual({
        chunks: { x0: Math.min(t.tx, 0) * 3, z0: Math.min(t.tz, 0) * 3, x1: Math.max(t.tx, 0) * 3 + 2, z1: Math.max(t.tz, 0) * 3 + 2 },
        cy: [-1, 1],
      })
      for (const c of [sp, ex]) expect(c.cx >= box.chunks.x0 && c.cx <= box.chunks.x1 && c.cz >= box.chunks.z0 && c.cz <= box.chunks.z1).toBe(true)
    }
  })

  it('anomalies: hashed per theatre, 1 per 2–3 theatres, never the same class on edge neighbours, never near spawn or in the exit tile', () => {
    const maps = []
    for (const seed of [...SEEDS, 2, 3, 4, 5, 6]) {
      const ex = exitTileOf(seed)
      const at = (tx, tz) => anomalyAt(seed, bandKey(tx, tz))
      let present = 0
      let cells = 0
      const classes = new Set()
      const sig = []
      for (let tz = -8; tz <= 8; tz++) {
        for (let tx = -8; tx <= 8; tx++) {
          const a = at(tx, tz)
          sig.push(a ?? '-')
          if (Math.max(Math.abs(tx), Math.abs(tz)) <= 1 || (tx === ex.tx && tz === ex.tz)) {
            expect(a, `seed ${seed} tile ${tx},${tz}`).toBeNull()
            continue
          }
          cells++
          if (!a) continue
          present++
          classes.add(a)
          expect(ANOMALY_CLASSES).toContain(a)
          for (const [nx, nz] of [[tx + 1, tz], [tx, tz + 1]]) if (at(nx, nz)) expect(at(nx, nz), `seed ${seed} ${tx},${tz}→${nx},${nz}`).not.toBe(a)
          expect(anomalyAt(seed, bandKey(tx, tz))).toBe(a)
        }
      }
      expect(present / cells, `seed ${seed} density`).toBeGreaterThan(1 / 3)
      expect(present / cells, `seed ${seed} density`).toBeLessThan(1 / 2)
      expect(classes).toEqual(new Set(ANOMALY_CLASSES))
      maps.push(sig.join(''))
    }
    expect(new Set(maps).size).toBe(maps.length)
  })

  it('anomalies in the world: each class shows in its theatre, which stays sealed and connected', () => {
    const seed = SEEDS[0]
    const src = worldSource(seed, config)
    const found = new Map()
    for (let tz = -6; tz <= 6 && found.size < ANOMALY_CLASSES.length; tz++) {
      for (let tx = -6; tx <= 6; tx++) {
        const a = anomalyAt(seed, bandKey(tx, tz))
        if (a && !found.has(a)) found.set(a, { tx, tz })
      }
    }
    expect([...found.keys()].sort()).toEqual([...ANOMALY_CLASSES].sort())
    const PLATES = ['trAP', '5tAL', 'dC', 'UC', 'LoFt']
    const check = (tx, tz, cls) => {
      const k = bandKey(tx, tz)
      const sc = schemeOf(seed, k)
      const F = frameOf(sc)
      // The plan's stalls seats, with and without the anomaly (the plan's own
      // count after its furniture pass: the world places every one of them).
      const plain = planTheatre(sc, { tile: true, anomaly: null }).info.seats.stalls
      const stalls = piecesOf(src, tx, tz, 0, PROP_SEAT_ROW).filter((p) => F.toCanon(p.gx, p.gz).u < sc.P)
      const ghost = piecesOf(src, tx, tz, 0, PROP_GHOST_LIGHT).map((p) => [p.gx, p.gz])
      const down = F.toTile(sc.P + 1, sc.oc)
      const up = F.toTile(sc.L - 2, sc.oc)
      expect(ghost, `${cls ?? 'plain'} ghost`).toEqual([cls === 'upstage' ? [up.gx, up.gz] : [down.gx, down.gz]])
      if (cls === 'missing') {
        expect(stalls.length).toBeLessThan(plain)
        expect(sc.blocks.map(([a, b]) => b - a + 1)).toContain(plain - stalls.length)
      } else expect(stalls.length, `${cls ?? 'plain'} seats`).toBeGreaterThanOrEqual(plain - 2)
      // Seats face the stage (one canonical step +u), the turned row the back.
      const toStage = F.step(1, 0)
      const facing = toStage.dx > 0 ? FACING.E : toStage.dx < 0 ? FACING.W : toStage.dz > 0 ? FACING.S : FACING.N
      expect(stalls.some((p) => p.facing !== facing), `${cls ?? 'plain'} turned`).toBe(cls === 'turned')
      const labels = [-1, 0, 1, 2, 3].map((cy) => src.chunkAt(tx * 3 + Math.floor(sc.part.x0 / CHUNK), cy, tz * 3 + Math.floor(sc.part.z0 / CHUNK)).levelLabel)
      const want = cls === 'plates' ? Array(5).fill('5tAL') : PLATES
      expect(labels.slice(0, sc.NL), `${cls ?? 'plain'} plates`).toEqual(want.slice(0, sc.NL))
    }
    expect(anomalyAt(seed, bandKey(0, 0))).toBeNull()
    check(0, 0, null)
    for (const [cls, { tx, tz }] of found) {
      check(tx, tz, cls)
      const box = tileBox(tx, tz)
      const audit = massLeakAudit(src.chunkAt, box, { gen, worldSeed: seed })
      expect(audit.details).toEqual({ leaks: [], seals: [], portViolations: [], seeThroughToSolid: [], seeThroughThinMass: [] })
      const lay = auditLayeredPatch(src.chunkAt, box.x0, -1, box.z0, 3, 5, 3)
      expect(Object.fromEntries(STRUCTURAL_COUNTERS.filter((c) => lay[c]).map((c) => [c, lay[c]]))).toEqual({})
      expect(componentPartition(src, box)).toHaveLength(1)
    }
  })

  it('the bake keeps exactly the footprint\'s chunks; lamps tinted, every house lamp dead but the ghost light', () => {
    for (const seed of SEEDS) {
      const k = bandKey(0, 0)
      const sc = schemeOf(seed, k)
      const bake = tileBakeAt(seed, k, config)
      const kept = []
      for (let cy = -1; cy <= 3; cy++) for (let cz = 0; cz < 3; cz++) for (let cx = 0; cx < 3; cx++) if (footprint(seed, cx, cy, cz) === 'tile') kept.push(chunkKey3(cx, cy, cz))
      expect([...bake.chunks.keys()].sort()).toEqual(kept.sort())
      expect(bake.stats.untouchedKept).toBe(0)
      for (let cy = -1; cy <= 3; cy++) for (let cz = 0; cz < 3; cz++) for (let cx = 0; cx < 3; cx++) expect(footprint(seed, cx, cy, cz) === 'tile').toBe(keptLocal(sc, cx, cy + 1, cz))
      // The house, the stage and their ring on the ground storey: one lit
      // lamp, the ghost light's tinted bulb over its prop.
      const src = worldSource(seed, config)
      const b = sc.bounds
      const lit = []
      for (let cz = 0; cz < 3; cz++) {
        for (let cx = 0; cx < 3; cx++) {
          for (const l of src.chunkAt(cx, 0, cz).lamps) {
            const gx = cx * CHUNK + l.lx
            const gz = cz * CHUNK + l.lz
            if (l.lit && gx >= b.x0 - 1 && gx <= b.x1 + 1 && gz >= b.z0 - 1 && gz <= b.z1 + 1) lit.push([gx, gz, l.tint])
          }
        }
      }
      const F = frameOf(sc)
      const g = F.toTile(sc.P + 1, sc.oc)
      expect(lit).toEqual([[g.gx, g.gz, 0xffe2b4]])
      for (const d of bake.chunks.values()) for (const l of d.lamps) if (l.tint !== undefined) expect(Number.isInteger(l.tint)).toBe(true)
    }
  })

  it('upper house storeys: the core opens onto the house on every level, no deck or core is ever sealed (plans, 900 tiles)', () => {
    for (const seed of [1, 0x5eed, 777, 31337, 90210]) {
      for (let i = 0; i < 180; i++) {
        // Near tiles and far ones (up to ±66 tiles, about ±200 chunks).
        const far = i % 4 === 0 ? 66 : 0
        const tx = (i % 15) - 7 + (i % 8 === 0 ? far : -far)
        const tz = Math.floor(i / 15) - 6 + (i % 3 === 0 ? far : 0)
        const sc = schemeOf(seed, bandKey(tx, tz))
        const where = `${seed} tile ${tx},${tz}`
        // Above the band storeys only the house's chunks stand: the core's
        // door never opens onto the participant box's last line (mass there).
        const o = sc.coreDoor.outside
        if (sc.NL - 1 > 2) expect(o.gx !== sc.part.x1 && o.gz !== sc.part.z1, where).toBe(true)
        const { storeys } = planTheatre(sc, { tile: true })
        for (let s = 0; s < sc.NL; s++) {
          const st = storeys[s]
          expect(st.stranded ?? 0, `${where} storey ${s} stranded`).toBe(0)
          expect(st.walk(o.gx, o.gz), `${where} storey ${s} core door`).toBe(true)
          expect(st.regions[st.regAt(o.gx, o.gz)].name, `${where} storey ${s} core landing`).not.toBe('landing')
          for (const br of sc.levels[s].bridges) {
            for (let gz = br.z0; gz <= br.z1; gz++) for (let gx = br.x0; gx <= br.x1; gx++) expect(st.walk(gx, gz), `${where} storey ${s} deck ${gx},${gz}`).toBe(true)
          }
        }
      }
    }
  }, 120_000)

  it('upper house storeys in the world: sealed mass and clean catalog slices over cy −1..3 (120 tiles, near and far)', () => {
    for (const seed of [99, 2024, 31337]) {
      const src = worldSource(seed, config, { cache: new Map() })
      for (let i = 0; i < 40; i++) {
        const far = i % 4 === 0 ? (i % 8 === 0 ? 66 : -67) : 0
        const tx = (i % 10) * 2 - 9 + far
        const tz = Math.floor(i / 10) * 3 - 5 - far
        const box = tileBox(tx, tz)
        const where = `${seed} tile ${tx},${tz}`
        const audit = massLeakAudit(src.chunkAt, box, { gen, worldSeed: seed })
        expect(audit.details, where).toEqual({ leaks: [], seals: [], portViolations: [], seeThroughToSolid: [], seeThroughThinMass: [] })
        for (let cy = -1; cy <= 3; cy++) {
          for (let cz = box.z0; cz <= box.z1; cz++) {
            for (let cx = box.x0; cx <= box.x1; cx++) {
              const d = src.chunkAt(cx, cy, cz)
              if (isCatalogKind(d.structureDown?.kind)) expect(catalogSliceErrors(d, d.structureDown, 'down'), `${where} ${cx},${cy},${cz} down`).toEqual([])
              if (isCatalogKind(d.structureUp?.kind)) expect(catalogSliceErrors(d, d.structureUp, 'up'), `${where} ${cx},${cy},${cz} up`).toEqual([])
            }
          }
        }
        if (i % 4 === 0) {
          const lay = auditLayeredPatch(src.chunkAt, box.x0, -1, box.z0, 3, 5, 3)
          expect(Object.fromEntries(STRUCTURAL_COUNTERS.filter((c) => lay[c]).map((c) => [c, lay[c]])), where).toEqual({})
        }
      }
    }
  }, 240_000)

  it('every tile is its own theatre: the grammar varies class, size, orientation, stage, circles, core and band', () => {
    const seen = { house: new Set(), NL: new Set(), frame: new Set(), circles: new Set(), stairs: new Set(), part: new Set(), S: new Set(), Ow: new Set(), strips: new Set(), pit: new Set(), boxes: new Set() }
    const layouts = new Set()
    let n = 0
    for (const seed of SEEDS) {
      for (let tz = -5; tz <= 5; tz++) {
        for (let tx = -5; tx <= 5; tx++) {
          const sc = schemeOf(seed, bandKey(tx, tz))
          expect(schemeOf(seed, bandKey(tx, tz))).toBe(sc)
          seen.house.add(sc.house)
          seen.NL.add(sc.NL)
          seen.frame.add(`${sc.sw}${sc.fu}${sc.fv}`)
          seen.circles.add(sc.circles)
          seen.stairs.add(sc.skeleton.stairs.length)
          seen.part.add(`${sc.part.x0},${sc.part.z0},${sc.part.x1},${sc.part.z1}`)
          seen.S.add(sc.S)
          seen.Ow.add(sc.Ow)
          seen.strips.add(sc.skeleton.strips.length)
          seen.pit.add(!!sc.pit)
          seen.boxes.add(sc.boxes)
          layouts.add(JSON.stringify([sc.bounds, sc.core, sc.skeleton.strips.map((s) => [s.rect, s.lane]), sc.skeleton.stairs.map((t) => t.rect)]))
          n++
        }
      }
    }
    expect([...seen.house].sort()).toEqual(['opera', 'proscenium', 'small'])
    expect([...seen.NL].sort()).toEqual([3, 4, 5])
    expect(seen.frame.size).toBe(8)
    expect([...seen.circles].sort()).toEqual([0, 1, 2])
    expect(seen.stairs.has(1) && seen.stairs.has(2)).toBe(true)
    expect(seen.part.size).toBeGreaterThanOrEqual(8)
    expect(seen.S.size).toBeGreaterThanOrEqual(4)
    expect(seen.Ow.size).toBeGreaterThanOrEqual(4)
    expect(seen.strips.size).toBeGreaterThanOrEqual(2)
    expect([...seen.pit].sort()).toEqual([false, true])
    expect([...seen.boxes].sort()).toEqual([false, true])
    // No two tiles share a layout.
    expect(layouts.size).toBe(n)
  })

  it('no repeated layout: wall/column Jaccard over 12 tiles, mean ≤ 0.25 and max ≤ 0.45 on cy 0 and cy −1', () => {
    const seed = 12345
    const origins = []
    for (let a = 0; a < 4; a++) for (let b = 0; b < 3; b++) origins.push([a * 3 + 1, b * 3 + 1])
    for (const cy of [0, -1]) {
      const sets = origins.map(([tx, tz]) => tileSet(seed, tx, tz, cy))
      let sum = 0
      let pairs = 0
      let max = 0
      for (let i = 0; i < sets.length; i++) {
        for (let j = i + 1; j < sets.length; j++) {
          const v = jaccard(sets[i], sets[j])
          sum += v
          pairs++
          max = Math.max(max, v)
        }
      }
      expect(sum / pairs, `mean, cy ${cy}`).toBeLessThanOrEqual(0.25)
      expect(max, `max, cy ${cy}`).toBeLessThanOrEqual(0.45)
    }
  }, 120_000)
})
