import { describe, expect, it } from 'vitest'
import { CELL, CHUNK, chunkKey3 } from '../../../constants.js'
import { hash2i } from '../../../core/hash.js'
import { auditLayeredPatch } from '../../../audit.js'
import { resolveMapFamily } from '../../../mapFamily.js'
import { PROP_ARCADE, PROP_MASCOT } from '../../../props/index.js'
import { linkHalo } from '../../../structures/catalog/engine.js'
import { catalogSliceErrors } from '../../../structures/catalog/audit.js'
import { makeTileCtx, tileBakeAt } from '../../../tiles/familyChunk.js'
import { spawnCellOk } from '../../../tiles/cells.js'
import { cellWalkable } from '../../../tiles/holeMasks.js'
import { DARK_LEVEL, lightField, nodeKey } from '../../../tiles/simulate.js'
import { massLeakAudit } from '../../../tiles/seams.js'
import { solidChunk } from '../../../tiles/solidChunk.js'
import { TileCanvas } from '../../../tiles/TileCanvas.js'
import { tileWindow } from '../../../tiles/tileKey.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familyGenerator } from '../../generators.js'
import { familyExitHook, familySpawn, hookOf } from '../../hooks.js'
import { familyPlanner } from '../../planners.js'
import { componentPartition, windowConnectivity, worldSource } from '../../reach.js'
import { STRUCTURAL_COUNTERS, plannerKeySweep, runFamilySuite } from '../../__tests__/familyHarness.js'
import { RED_PIT_TINT } from '../tile.js'
import {
  ANOMALY_CLASSES,
  CORR,
  HALL_TYPES,
  POD,
  TILE,
  TUBE,
  anomalyAt,
  bandKey,
  edgeRule,
  exitPodOfLayout,
  exitTileOf,
  footprint,
  hallsOf,
  inRect,
  moduleLayout,
  ports,
  spawnCells,
  walkableCode,
} from '../geometry.js'

// The playplace family suite (spec §11.1, §12.9): W = 2×2 modules × storeys
// 0..2; the decision-6 window is 3×3 modules × 0..2.
runFamilySuite('playplace', {
  window: { tiles: [2, 2], storeys: [0, 2] },
  connWindow: { tiles: [3, 3], storeys: [0, 2] },
})

// --- playplace specifics (§12.9 Tests) -----------------------------------------------
//
// Every module is drawn by the grammar in geometry.js (no fixed prototype):
// one to two halls of four types and two or three storeys, a crawl-tube
// lattice on the deck, corridors routed between hashed seam ports, rooms
// grown in the leftovers. The tests check the contracts and the variety.

const ID = 'playplace'
const config = forcedFamilyConfig(ID)
const profile = resolveMapFamily(config)
const gen = familyGenerator(ID)
const planner = familyPlanner(ID)
const SEEDS = [1, 0x5eed, 777]
const TC = TILE.w * CHUNK // 28 cells per module side

const boxOfModules = (tx0, tz0, tx1, tz1, y0 = 0, y1 = 2) => ({ x0: tx0 * 2, z0: tz0 * 2, x1: tx1 * 2 + 1, z1: tz1 * 2 + 1, y0, y1 })
const moduleChunks = (tx, tz) => [[tx * 2, tz * 2], [tx * 2 + 1, tz * 2], [tx * 2, tz * 2 + 1], [tx * 2 + 1, tz * 2 + 1]]
const MODULES = (r) => {
  const out = []
  for (let tz = -r; tz <= r; tz++) for (let tx = -r; tx <= r; tx++) out.push([tx, tz])
  return out
}

// The structural signature the liminal-repeat gate measures (scratch
// repeat/sim.mjs): wall edges and columns of one module's four chunks on one
// storey, keyed module-locally.
function signature(src, tx, tz, cy) {
  const s = new Set()
  for (const [i, [cx, cz]] of moduleChunks(tx, tz).entries()) {
    const d = src.chunkAt(cx, cy, cz)
    for (let c = 0; c < CHUNK * CHUNK; c++) {
      if (d.wallV[c]) s.add(`v${i},${c}`)
      if (d.wallH[c]) s.add(`h${i},${c}`)
      if (d.cols[c]) s.add(`c${i},${c}:${d.cols[c]}`)
    }
  }
  return s
}
const jaccard = (a, b) => {
  let i = 0
  for (const x of a) if (b.has(x)) i++
  return i / (a.size + b.size - i || 1)
}

describe('playplace family (§12.9)', () => {
  it('module, footprint and ports: floor and deck on every module, the top deck only over a tall hall; one or two hashed ports per floor seam', () => {
    expect(TILE).toMatchObject({ w: 2, d: 2, backend: 'band', H: 3, lo: 0, hi: 2, salt: 0x5a17000d })
    const along = new Set()
    let tall = 0
    let n = 0
    let deckPorts = 0
    let deckSeams = 0
    let twoFloor = 0
    for (const seed of SEEDS) {
      for (const [tx, tz] of MODULES(8)) {
        n++
        const halls = hallsOf(seed, tx, tz)
        const t = halls.find((h) => h && h.L === 3)
        if (t) tall++
        for (const [cx, cz] of moduleChunks(tx, tz)) {
          expect(footprint(seed, cx, 0, cz)).toBe('tile')
          expect(footprint(seed, cx, 1, cz)).toBe('tile')
          const top = !!t && t.desc.participants.some((p) => p.cx === cx && p.cz === cz)
          expect(footprint(seed, cx, 2, cz), `${seed} ${cx},${cz}`).toBe(top ? 'tile' : 'solid')
          expect(footprint(seed, cx, 3, cz)).toBe('solid')
          expect(footprint(seed, cx, -1, cz)).toBe('solid')
        }
        // Ports: hashed per seam, 1–2 cells wide, off the corners, two on a
        // seam ≥ 5 cells apart; the floor always crosses every seam (twice
        // on about 40% of them), the deck on about half of them; the
        // east/south view is the neighbour's own west/north.
        for (const side of ['west', 'north']) {
          const p0 = ports(seed, { tx, tz }, side, 0)
          expect(p0.length).toBeGreaterThanOrEqual(1)
          expect(p0.length).toBeLessThanOrEqual(2)
          if (p0.length === 2) twoFloor++
          for (const cy of [0, 1]) {
            const list = ports(seed, { tx, tz }, side, cy)
            for (const p of list) {
              expect(p.a0).toBeGreaterThanOrEqual(3)
              expect(p.a1).toBeLessThanOrEqual(TC - 3)
              expect(p.a1 - p.a0).toBeLessThanOrEqual(1)
              if (cy === 0) along.add(p.a0)
            }
            if (list.length === 2) expect(list[1].a0 - list[0].a1, `${seed} ${tx},${tz} ${side} ${cy}`).toBeGreaterThanOrEqual(5)
          }
          const p1 = ports(seed, { tx, tz }, side, 1)
          expect(p1.length).toBeLessThanOrEqual(2)
          if (p1.length) deckSeams++
          deckPorts += p1.length
          expect(ports(seed, { tx, tz }, side, 2)).toEqual([])
        }
        expect(ports(seed, { tx, tz }, 'east', 0)).toEqual(ports(seed, { tx: tx + 1, tz }, 'west', 0))
        expect(ports(seed, { tx, tz }, 'south', 1)).toEqual(ports(seed, { tx, tz: tz + 1 }, 'north', 1))
      }
    }
    expect(along.size).toBeGreaterThanOrEqual(15)
    expect(twoFloor / (2 * n)).toBeGreaterThan(0.25)
    expect(twoFloor / (2 * n)).toBeLessThan(0.55)
    expect(deckSeams / (2 * n)).toBeGreaterThan(0.4)
    expect(deckSeams / (2 * n)).toBeLessThan(0.7)
    expect(deckPorts).toBeGreaterThan(deckSeams)
    // Doc §12: play halls are two storeys; a three-storey hall (a tall frame
    // or the fortress) on some modules carries the top deck.
    expect(tall / n).toBeGreaterThan(0.15)
    expect(tall / n).toBeLessThan(0.6)
  })

  it('planner: 1–2 playplaceCatalog halls per module, 0 nulls over 2000 keys, at true global coordinates, inside their module', () => {
    const sweep = plannerKeySweep(planner, TILE, SEEDS[0], profile, config, 2000)
    expect(sweep).toMatchObject({ keys: 2000, nulls: 0, ruleErrors: [] })
    const counts = new Set()
    const types = new Set()
    for (const seed of SEEDS) {
      for (const [tx, tz] of MODULES(3)) {
        const k = bandKey(tx, tz)
        const list = planner.structuresInTile(seed, k, profile, config)
        expect(Object.isFrozen(list)).toBe(true)
        expect(list.every(Boolean), `${seed} ${tx},${tz}`).toBe(true)
        expect(list).toEqual(hallsOf(seed, tx, tz).map((h) => h.desc))
        counts.add(list.length)
        for (const [slot, s] of list.entries()) {
          types.add(s.type)
          expect([s.slot, s.kind, s.family, s.baseCy]).toEqual([slot, 'playplaceCatalog', ID, 0])
          expect([1, 2]).toContain(s.topCy)
          expect(s.levels).toHaveLength(s.topCy + 1)
          const b = s.globalBounds
          expect(b.x0 >= tx * TC && b.x1 < (tx + 1) * TC && b.z0 >= tz * TC && b.z1 < (tz + 1) * TC, `${seed} ${tx},${tz} bounds`).toBe(true)
          for (const p of s.participants) {
            expect(Math.floor(p.cx / 2) === tx && Math.floor(p.cz / 2) === tz).toBe(true)
            for (let cy = 0; cy <= s.topCy; cy++) expect(planner.structureAt(seed, p.cx, p.cz, cy, profile, config)).toBe(s)
            expect(planner.verticalOpeningAt(seed, p.cx, p.cz, 0, profile, config)).toBe(true)
            expect(planner.verticalOpeningAt(seed, p.cx, p.cz, s.topCy, profile, config)).toBe(false)
          }
        }
      }
    }
    expect([...counts].sort()).toEqual([1, 2])
    expect(types).toEqual(new Set(['playHall', 'foodCourt']))
  })

  it('a forced attempt-1 bake (new tileSeed, same planSeed) matches the planner: no kit:planner-mismatch, no blocked port', () => {
    for (const seed of SEEDS) {
      const ex = exitTileOf(seed)
      for (const [tx, tz] of [[0, 0], [ex.tx, ex.tz], [3, -1], [-2, 4]]) {
        const k = bandKey(tx, tz)
        const planSeed = moduleLayout(seed, tx, tz).planSeed
        const win = tileWindow(TILE, k)
        const canvas = new TileCanvas({
          family: ID, base: 'office', version: config.version, worldSeed: seed, origin: k.origin, district: { dx: tx, dz: tz },
          keep: (cx, cy, cz) => cx >= win.cx0 && cx <= win.cx1 && cz >= win.cz0 && cz <= win.cz1 && cy >= k.cy0 && cy <= k.cy1 &&
            footprint(seed, cx, cy, cz) === 'tile',
          solidChunk: (cx, cy, cz) => solidChunk(seed, cx, cy, cz, config, ID, { district: { dx: tx, dz: tz } }),
        })
        const ctx = makeTileCtx(gen, profile, seed, config, k, canvas, { tileSeed: hash2i(planSeed, 1, 0x7e) >>> 0, planSeed, attempt: 1 })
        let res = null
        expect(() => { res = gen.bake(canvas, ctx) }).not.toThrow()
        expect(res?.error).toBeUndefined()
        expect(ctx.notes.filter((n) => n.startsWith('kit:') || n.startsWith('seam:'))).toEqual([])
        expect(ctx.exits).toHaveLength(1)
        expect(ctx.spawns).toHaveLength(tx === 0 && tz === 0 ? 1 : 0)
      }
    }
  })

  it('the grammar: every module a different plan, pure and order-independent; halls, tubes, loops and dead ends vary', () => {
    const seen = { types: new Set(), halls: new Set(), rooms: new Set(), pods: new Set(), roles: new Set(), plans: new Set() }
    let deadEnds = 0
    let storeys = 0
    for (const [tx, tz] of MODULES(7)) {
      const lay = moduleLayout(4242, tx, tz)
      for (const h of lay.halls) seen.types.add(h.type)
      seen.halls.add(lay.halls.length)
      const t = lay.storeys[1].tubes
      expect(t, `tubes ${tx},${tz}`).toBeTruthy()
      // ≥ 1 crawl-only loop, ≥ 2 mouths.
      expect(t.loops, `tube loops ${tx},${tz}`).toBeGreaterThanOrEqual(1)
      expect(t.mouths.length).toBeGreaterThanOrEqual(2)
      seen.pods.add(`${t.nx}x${t.nz}`)
      for (const cy of [0, 1]) {
        const st = lay.storeys[cy]
        storeys++
        seen.rooms.add(st.rooms.length)
        for (const rm of st.rooms) seen.roles.add(rm.role)
        expect(st.stats.loops, `corridor loops ${tx},${tz},${cy}`).toBeGreaterThanOrEqual(1)
        // A dead end: a corridor cell with one open neighbour.
        let ends = 0
        for (let gz = 0; gz < TC; gz++) {
          for (let gx = 0; gx < TC; gx++) {
            if (st.cells[gz * TC + gx] !== CORR) continue
            let open = 0
            for (const [nx, nz] of [[gx + 1, gz], [gx - 1, gz], [gx, gz + 1], [gx, gz - 1]]) {
              if (nx < 0 || nz < 0 || nx >= TC || nz >= TC || !walkableCode(st.cells[nz * TC + nx])) continue
              if (edgeRule(st, gx, gz, nx, nz) !== 'wall' && edgeRule(st, gx, gz, nx, nz) !== 'window') open++
            }
            if (open === 1) ends++
          }
        }
        if (ends) deadEnds++
        seen.plans.add(st.cells.join(''))
      }
    }
    expect(seen.types).toEqual(new Set(HALL_TYPES))
    expect([...seen.halls].sort()).toEqual([1, 2])
    expect(seen.rooms.size).toBeGreaterThanOrEqual(8)
    expect(seen.pods.size).toBeGreaterThanOrEqual(4)
    expect(seen.roles).toEqual(new Set(['party', 'arcade', 'lounge', 'cafe', 'toilets', 'staff', 'store']))
    expect(seen.plans.size).toBe(storeys)
    expect(deadEnds / storeys).toBeGreaterThan(0.5)
    // Pure in (worldSeed, module), whatever order the modules are asked in.
    const a = moduleLayout(99, 5, -6)
    const b = moduleLayout(99, -6, 5)
    const fresh = (tx, tz) => JSON.stringify(moduleLayout(99, tx, tz).storeys.slice(0, 2).map((s) => [...s.cells]))
    const keyA = fresh(5, -6)
    const keyB = fresh(-6, 5)
    expect(keyA).not.toBe(keyB)
    expect(JSON.stringify(a.storeys.slice(0, 2).map((s) => [...s.cells]))).toBe(keyA)
    expect(JSON.stringify(b.storeys.slice(0, 2).map((s) => [...s.cells]))).toBe(keyB)
  })

  it('liminal repeat gate: 12 modules of one world share their parts, not their layouts (wall/column Jaccard mean ≤ 0.25, max ≤ 0.45 on storeys 0 and 1)', () => {
    for (const seed of [12345, 1]) {
      const src = worldSource(seed, config)
      const tiles = []
      for (let a = 0; a < 4; a++) for (let b = 0; b < 3; b++) tiles.push([a * 3 + 1, b * 3 + 1])
      for (const cy of [0, 1]) {
        const sigs = tiles.map(([tx, tz]) => signature(src, tx, tz, cy))
        let sum = 0
        let max = 0
        let n = 0
        for (let i = 0; i < sigs.length; i++) {
          for (let j = i + 1; j < sigs.length; j++) {
            const v = jaccard(sigs[i], sigs[j])
            sum += v
            max = Math.max(max, v)
            n++
          }
        }
        expect(sum / n, `seed ${seed} storey ${cy} mean`).toBeLessThanOrEqual(0.25)
        expect(max, `seed ${seed} storey ${cy} max`).toBeLessThanOrEqual(0.45)
      }
    }
  }, 60_000)

  it('the anchor module\'s every pod is reachable from the spawn inside the proof box', () => {
    const hooks = hookOf(ID)
    for (const seed of SEEDS) {
      const ex = exitTileOf(seed)
      const k = bandKey(ex.tx, ex.tz)
      const bake = tileBakeAt(seed, k, config)
      const lay = moduleLayout(seed, ex.tx, ex.tz)
      const pod = exitPodOfLayout(lay)
      const anchor = hooks.exitAnchor(seed, profile)
      expect(bake.exits).toEqual([{ gx: ex.tx * TC + pod.gx, gz: ex.tz * TC + pod.gz, cy: 1 }])
      expect([anchor.cx * CHUNK + anchor.lx, anchor.cz * CHUNK + anchor.lz]).toEqual([ex.tx * TC + pod.gx, ex.tz * TC + pod.gz])
      const src = worldSource(seed, config)
      const sp = familySpawn(config, seed)
      const comps = componentPartition(src, hooks.proofBox(anchor, sp))
      const main = new Set(comps.find((c) => c.includes(`${sp.cx * CHUNK + sp.lx},${sp.cz * CHUNK + sp.lz},0`)))
      const tubes = lay.storeys[1].tubes
      expect(tubes.pods.length).toBeGreaterThanOrEqual(4)
      for (const p of tubes.pods) {
        const wx = ex.tx * TC + p.gx
        const wz = ex.tz * TC + p.gz
        const d = src.chunkAt(Math.floor(wx / CHUNK), 1, Math.floor(wz / CHUNK))
        const lx = wx - d.cx * CHUNK
        const lz = wz - d.cz * CHUNK
        expect([TUBE, POD]).toContain(lay.storeys[1].cells[p.gz * TC + p.gx])
        expect(cellWalkable(d, lx, lz), `pod ${p.gx},${p.gz}`).toBe(true)
        expect(main.has(`${wx},${wz},1`), `pod ${p.gx},${p.gz} of seed ${seed} reachable`).toBe(true)
      }
    }
  })

  it('spawn on module (0,0)\'s first hall floor by its main gate; exit at the far pod on the deck of a module at Chebyshev distance 2–3; proofBox is the two modules\' rectangle', () => {
    const hooks = hookOf(ID)
    expect(hooks.stub).toBe(false)
    for (const seed of [...SEEDS, 4242, 99]) {
      const sp = familySpawn(config, seed)
      const cand = spawnCells(seed).map((c) => `${c.gx},${c.gz}`)
      expect(cand.length).toBeGreaterThanOrEqual(2)
      expect(cand).toContain(`${sp.cx * CHUNK + sp.lx},${sp.cz * CHUNK + sp.lz}`)
      const src = worldSource(seed, config)
      const ex = familyExitHook(config)({ worldSeed: seed, level: 1, config, profile, generate: src.chunkAt })
      const t = exitTileOf(seed)
      expect([2, 3]).toContain(Math.max(Math.abs(t.tx), Math.abs(t.tz)))
      expect(ex).toEqual(hooks.exitAnchor(seed, profile))
      expect(ex.cy).toBe(1)
      expect([Math.floor(ex.cx / 2), Math.floor(ex.cz / 2)]).toEqual([t.tx, t.tz])
      expect(anomalyAt(seed, bandKey(t.tx, t.tz))).toBeNull()
      expect(hooks.proofBox(ex, sp)).toEqual({
        chunks: { x0: Math.min(t.tx, 0) * 2, z0: Math.min(t.tz, 0) * 2, x1: Math.max(t.tx, 0) * 2 + 1, z1: Math.max(t.tz, 0) * 2 + 1 },
        cy: [0, 1],
      })
    }
    expect(hooks.exitHookStats.lastResort).toBe(0)
  })

  it('spawn sweep: on 120 world seeds (two past failures among them) the spawn is walkable and passes spawnCellOk, almost always on the gate hall\'s floor', () => {
    const seeds = [4060459933, 927305020, ...Array.from({ length: 118 }, (_, i) => hash2i(0x5a17, i, 0x5b) >>> 0)]
    let inHall = 0
    for (const seed of seeds) {
      const sp = familySpawn(config, seed)
      expect(sp.cy ?? 0).toBe(0)
      const d = worldSource(seed, config).chunkAt(sp.cx, 0, sp.cz)
      expect(cellWalkable(d, sp.lx, sp.lz), `spawn walkable (seed ${seed})`).toBe(true)
      expect(spawnCellOk(d, sp.lx, sp.lz), `spawnCellOk (seed ${seed})`).toBe(true)
      const lay = moduleLayout(seed, 0, 0)
      const gate = lay.storeys[0].gates[0]
      const h = gate ? lay.halls[gate.slot] : lay.halls[0]
      if (inRect(h.bounds, sp.cx * CHUNK + sp.lx, sp.cz * CHUNK + sp.lz)) inHall++
    }
    expect(inHall / seeds.length).toBeGreaterThan(0.9)
  }, 120_000)

  it('anomalies: one per module (hashed, mirror-free), rotated over three classes, never near spawn or in the anchor module', () => {
    const maps = []
    for (const seed of [...SEEDS, 2, 3, 4, 5, 6]) {
      const ex = exitTileOf(seed)
      const at = (tx, tz) => anomalyAt(seed, bandKey(tx, tz))
      let eligible = 0
      let present = 0
      const classes = new Set()
      const sig = []
      for (const [tx, tz] of MODULES(8)) {
        const a = at(tx, tz)
        sig.push(a ?? '-')
        if (Math.max(Math.abs(tx), Math.abs(tz)) <= 1 || (tx === ex.tx && tz === ex.tz)) {
          expect(a, `seed ${seed} module ${tx},${tz}`).toBeNull()
          continue
        }
        eligible++
        if (!a) continue
        present++
        classes.add(a)
        expect(ANOMALY_CLASSES).toContain(a)
        // doc 14: never the same class on edge-adjacent modules.
        for (const [nx, nz] of [[tx + 1, tz], [tx, tz + 1]]) if (at(nx, nz)) expect(at(nx, nz), `seed ${seed} ${tx},${tz}→${nx},${nz}`).not.toBe(a)
      }
      // Every module is eligible (four edge neighbours each), so the rotation
      // leaves a few more without a class than the old hall-only lattice.
      expect(present / eligible, `seed ${seed} density`).toBeGreaterThan(0.85)
      expect(classes).toEqual(new Set(ANOMALY_CLASSES))
      maps.push(sig.join(''))
    }
    expect(new Set(maps).size).toBe(maps.length)
  })

  it('anomalies in the world: a red pit, a moved mascot and a turned arcade keep the modules sealed and connected', () => {
    const seed = SEEDS[0]
    let block = null
    for (let tx0 = 2; tx0 <= 12 && !block; tx0++) {
      for (let tz0 = -6; tz0 <= 6 && !block; tz0++) {
        const found = []
        for (let tz = tz0; tz < tz0 + 3; tz++) for (let tx = tx0; tx < tx0 + 3; tx++) found.push({ tx, tz, kind: anomalyAt(seed, bandKey(tx, tz)) })
        if (new Set(found.map((f) => f.kind).filter(Boolean)).size === 3) block = { tx0, tz0, found }
      }
    }
    expect(block).toBeTruthy()
    const { tx0, tz0, found } = block
    const src = worldSource(seed, config)
    const inner = boxOfModules(tx0, tz0, tx0 + 2, tz0 + 2)
    const outer = boxOfModules(tx0 - 1, tz0 - 1, tx0 + 3, tz0 + 3)
    const gate = moduleLayout(seed, tx0, tz0).storeys[0].gates[0]
    const start = { gx: tx0 * TC + gate.outside[0], gz: tz0 * TC + gate.outside[1], cy: 0 }
    const res = windowConnectivity(src, inner, outer, start)
    expect({ ok: res.ok, reason: res.reason, stranded: res.stranded, sealed: res.sealed }).toEqual({ ok: true, reason: null, stranded: [], sealed: [] })
    const audit = massLeakAudit(src.chunkAt, outer, { gen, worldSeed: seed })
    expect(audit.details).toEqual({ leaks: [], seals: [], portViolations: [], seeThroughToSolid: [], seeThroughThinMass: [] })
    const lay = auditLayeredPatch(src.chunkAt, inner.x0, 0, inner.z0, inner.x1 - inner.x0 + 1, 3, inner.z1 - inner.z0 + 1)
    expect(Object.fromEntries(STRUCTURAL_COUNTERS.filter((c) => lay[c]).map((c) => [c, lay[c]]))).toEqual({})
    const furnitureOf = (tx, tz, cy) => moduleChunks(tx, tz).flatMap(([cx, cz]) => (footprint(seed, cx, cy, cz) === 'tile' ? src.chunkAt(cx, cy, cz).furniture : []))
    let red = 0
    let mascots = 0
    let arcades = 0
    for (const { tx, tz, kind } of found) {
      const halls = hallsOf(seed, tx, tz)
      const lamps = moduleChunks(tx, tz).flatMap(([cx, cz]) => src.chunkAt(cx, 0, cz).lamps)
      const pit = halls.some((h) => h.type !== 'court' && h.levels[1].voids.length)
      const isRed = lamps.some((l) => l.tint === RED_PIT_TINT)
      expect(isRed, `red pit in ${tx},${tz} (${kind})`).toBe(kind === 'redPit' && pit)
      if (isRed) red++
      // The mascot stands by the main gate on the floor, or (anomaly) on
      // the highest deck.
      const where = [0, 1, 2].filter((cy) => furnitureOf(tx, tz, cy).some((f) => f.kind === PROP_MASCOT))
      if (kind === 'mascot') {
        expect(where.includes(0), `mascot in ${tx},${tz}`).toBe(false)
        if (where.length) mascots++
      } else {
        expect(where.every((cy) => cy === 0), `mascot in ${tx},${tz}`).toBe(true)
      }
      // Arcade cabinets: backed to the row's wall (off the cell centre), or
      // (anomaly) out of the row, centred and turned to the door.
      const cabinets = furnitureOf(tx, tz, 0).filter((f) => f.kind === PROP_ARCADE)
      const centred = (f) => Math.abs(f.x - (f.lx + 0.5) * CELL) < 1e-6 && Math.abs(f.z - (f.lz + 0.5) * CELL) < 1e-6
      expect(cabinets.every((f) => centred(f) === (kind === 'arcade')), `arcade in ${tx},${tz} (${kind})`).toBe(true)
      if (kind === 'arcade' && cabinets.length) arcades++
    }
    expect([red, mascots, arcades].every((v) => v >= 1), `${red} ${mascots} ${arcades}`).toBe(true)
  })

  it('plates PLAy / FUn / yAy; slices project clean; stair halos and the exit pod stay furniture-free; the bake is exactly the footprint', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      const ex = exitTileOf(seed)
      for (const [tx, tz] of [[0, 0], [1, 0], [0, 1], [ex.tx, ex.tz]]) {
        for (const [cx, cz] of moduleChunks(tx, tz)) {
          expect(src.chunkAt(cx, 0, cz).levelLabel).toBe('PLAy')
          expect(src.chunkAt(cx, 1, cz).levelLabel).toBe('FUn')
          if (footprint(seed, cx, 2, cz) === 'tile') expect(src.chunkAt(cx, 2, cz).levelLabel).toBe('yAy')
        }
        for (const desc of planner.structuresInTile(seed, bandKey(tx, tz), profile, config)) {
          for (const link of desc.verticalLinks) {
            const h = linkHalo(link)
            for (const cy of [link.lowerCy, link.lowerCy + 1]) {
              for (let gz = h.z0; gz <= h.z1; gz++) {
                for (let gx = h.x0; gx <= h.x1; gx++) {
                  const d = src.chunkAt(Math.floor(gx / CHUNK), cy, Math.floor(gz / CHUNK))
                  expect(d.furniture.filter((f) => f.lx === gx - d.cx * CHUNK && f.lz === gz - d.cz * CHUNK), `halo ${gx},${gz},${cy}`).toEqual([])
                }
              }
            }
          }
        }
        const pod = exitPodOfLayout(moduleLayout(seed, tx, tz))
        const pd = src.chunkAt(Math.floor((tx * TC + pod.gx) / CHUNK), 1, Math.floor((tz * TC + pod.gz) / CHUNK))
        expect(pd.furniture.filter((f) => f.lx === tx * TC + pod.gx - pd.cx * CHUNK && f.lz === tz * TC + pod.gz - pd.cz * CHUNK)).toEqual([])
        for (let cy = 0; cy <= 2; cy++) {
          for (const [cx, cz] of moduleChunks(tx, tz)) {
            const d = src.chunkAt(cx, cy, cz)
            if (d.structureUp) expect(catalogSliceErrors(d, d.structureUp, 'up')).toEqual([])
            if (d.structureDown) expect(catalogSliceErrors(d, d.structureDown, 'down')).toEqual([])
          }
        }
        const bake = tileBakeAt(seed, bandKey(tx, tz), config)
        const kept = []
        for (let cy = 0; cy <= 2; cy++) for (const [cx, cz] of moduleChunks(tx, tz)) if (footprint(seed, cx, cy, cz) === 'tile') kept.push(chunkKey3(cx, cy, cz))
        expect([...bake.chunks.keys()].sort()).toEqual(kept.sort())
        expect(bake.stats.untouchedKept).toBe(0)
      }
    }
  })

  it('the map stays lit under the world\'s lamp cap: ≤ 10 lit in a chunk touching a hall, ≤ 9 elsewhere; the hall boxes under 5% dark per storey (no hall over 35%), the floor and deck under 15%', () => {
    const tally = [0, 1, 2].map(() => ({ walk: 0, dark: 0 }))
    const whole = [0, 1].map(() => ({ walk: 0, dark: 0 }))
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const [tx, tz] of MODULES(1)) {
        const halls = hallsOf(seed, tx, tz)
        for (let cy = 0; cy <= 2; cy++) {
          for (const [cx, cz] of moduleChunks(tx, tz)) {
            if (footprint(seed, cx, cy, cz) !== 'tile') continue
            const lit = src.chunkAt(cx, cy, cz).lamps.filter((l) => l.lit).length
            const lx0 = cx * CHUNK - tx * TC
            const lz0 = cz * CHUNK - tz * TC
            const touches = halls.some((h) => cy < h.L && h.box.x0 <= lx0 + CHUNK - 1 && h.box.x1 >= lx0 && h.box.z0 <= lz0 + CHUNK - 1 && h.box.z1 >= lz0)
            // The spawn's own fixture may top a chunk of module (0,0) up by one.
            const spawnFix = tx === 0 && tz === 0 && cy === 0 ? 1 : 0
            expect(lit, `lit lamps ${cx},${cy},${cz}`).toBeLessThanOrEqual((touches ? 10 : 9) + spawnFix)
          }
        }
        // Doc §8/§12 (darkness 0 with the lights on), under the world's lamp
        // density: the whole floor and deck of the module, rooms and
        // corridors included.
        for (const cy of [0, 1]) {
          const field = lightField(src, { x0: tx * 2, z0: tz * 2, x1: tx * 2 + 1, z1: tz * 2 + 1 }, cy)
          for (const [cx, cz] of moduleChunks(tx, tz)) {
            const d = src.chunkAt(cx, cy, cz)
            for (let lz = 0; lz < CHUNK; lz++) {
              for (let lx = 0; lx < CHUNK; lx++) {
                if (!cellWalkable(d, lx, lz)) continue
                whole[cy].walk++
                if ((field.level.get(nodeKey(cx * CHUNK + lx, cz * CHUNK + lz, cy)) ?? 0) < DARK_LEVEL) whole[cy].dark++
              }
            }
          }
        }
        for (const h of halls) {
          for (let cy = 0; cy < h.L; cy++) {
            const field = lightField(src, { x0: tx * 2, z0: tz * 2, x1: tx * 2 + 1, z1: tz * 2 + 1 }, cy)
            let dark = 0
            let walk = 0
            for (let gz = h.bounds.z0; gz <= h.bounds.z1; gz++) {
              for (let gx = h.bounds.x0; gx <= h.bounds.x1; gx++) {
                const wx = tx * TC + gx
                const wz = tz * TC + gz
                const d = src.chunkAt(Math.floor(wx / CHUNK), cy, Math.floor(wz / CHUNK))
                if (!cellWalkable(d, wx - d.cx * CHUNK, wz - d.cz * CHUNK)) continue
                walk++
                if ((field.level.get(nodeKey(wx, wz, cy)) ?? 0) < DARK_LEVEL) dark++
              }
            }
            tally[cy].walk += walk
            tally[cy].dark += dark
            if (walk) expect(dark / walk, `hall ${tx},${tz} slot ${h.slot} storey ${cy} dark share (seed ${seed})`).toBeLessThan(0.35)
          }
        }
      }
    }
    for (const [cy, { walk, dark }] of tally.entries()) expect(dark / walk, `hall dark share, storey ${cy}`).toBeLessThan(0.05)
    for (const [cy, { walk, dark }] of whole.entries()) expect(dark / walk, `storey dark share, storey ${cy}`).toBeLessThan(0.15)
  })
})
