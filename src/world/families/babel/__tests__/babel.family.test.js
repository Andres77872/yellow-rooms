import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { CHUNK, CHUNK_WORLD } from '../../../constants.js'
import { auditLayeredPatch } from '../../../audit.js'
import { ChunkManager } from '../../../ChunkManager.js'
import { resolveMapFamily, worldConfigForFamily } from '../../../mapFamily.js'
import { chunkMultilevelRooms } from '../../../structures/multilevel.js'
import { cellWalkable } from '../../../tiles/holeMasks.js'
import { bakeTile, tileBakeAt } from '../../../tiles/familyChunk.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familyGenerator } from '../../generators.js'
import { familyPlanner } from '../../planners.js'
import { componentPartition, proveReachable, worldSource } from '../../reach.js'
import { SLOW, STRUCTURAL_COUNTERS, runFamilySuite } from '../../__tests__/familyHarness.js'
import { familyExitHook } from '../../hooks.js'
import { hashStr } from '../../../core/hash.js'
import {
  ANOMALY_CLASSES, ANOMALY_ONE_IN, CRIMSON, SPAWN_CELLS, TILE, anomalyAt, bandAnomalyPicks, boundaryFlight,
  exitAnchor, exitAnchorGallery, exitTileOf, flightAt, keyAt, keyOfBand, layoutOf, noShaftAt, openSeamPorts, ports,
  seamCandidates, storeyPlan, volumeOf,
} from '../geometry.js'
import { LIT_CAP } from '../tile.js'

// The library's own globes keep LIT_CAP (6) per chunk-storey; the bake's fill
// light (tiles/fillLight.js) then hangs plain fixtures over the dark aisles and
// vestibules, up to the world gate of §11.1 (12 per chunk-storey).
const WORLD_LIT_CAP = 12
expect(LIT_CAP).toBeLessThanOrEqual(WORLD_LIT_CAP)

// The babel family suite (spec §11.1) on the real library (§12.5): one 2×2
// block per tile, bands of five storeys, the decision-6 window over 3×3
// blocks × the spawn block's band and the one below it.
// The exit is pure in the world seed (every level shares it: the extra
// below proves the hook level-invariant), so the SLOW 16-seed sweep proves
// one level per seed instead of re-proving the same path three times.
runFamilySuite('babel', { connWindow: { tiles: [3, 3], storeys: [-5, 4] }, reachLevels: SLOW ? [1] : [1, 2, 3] })

// §12.5 extras.
describe('babel §12.5', () => {
  const config = forcedFamilyConfig('babel')
  const profile = resolveMapFamily(config)
  const seed = 1
  const src = worldSource(seed, config)
  const spawnCellOn = (cy) => {
    for (const c of SPAWN_CELLS) if (cellWalkable(src.chunkAt(0, cy, 0), c.lx, c.lz)) return { gx: c.lx, gz: c.lz, cy }
    return null
  }

  // Flooded over the 4×4 blocks grown by one block (galleries cut by the box
  // edge would otherwise show as pockets): every walkable cell of the inner
  // 4×4 blocks lies in one component of its storey.
  it('every storey is one planar component over 4×4 blocks', () => {
    const inner = (gx, gz) => gx >= -56 && gx < 56 && gz >= -56 && gz < 56
    for (const cy of [-1, 0, 4, 5]) {
      const parts = componentPartition(src, { x0: -6, z0: -6, x1: 5, z1: 5, y0: cy, y1: cy })
      const hit = parts.filter((p) => p.some((key) => {
        const [gx, gz] = key.split(',').map(Number)
        return inner(gx, gz)
      }))
      expect(hit.length, `storey ${cy}: components of sizes ${hit.map((p) => p.length).join(',')}`).toBe(1)
    }
  }, 120_000)

  it('the stairs climb and descend across three bands', () => {
    const box = { x0: -2, z0: -2, x1: 1, z1: 1 }
    const from = spawnCellOn(0)
    // Spawn band 0..4: up to the top of band +2 (14), down to the base of band −2 (−10).
    for (const cy of [14, -10]) {
      const to = spawnCellOn(cy)
      expect(to, `a hall cell on storey ${cy}`).not.toBeNull()
      const y = [Math.min(0, cy), Math.max(0, cy)]
      const p = proveReachable(src, from, to, { ...box, y0: y[0], y1: y[1] })
      expect(p.ok, `spawn → storey ${cy}: ${p.reason}`).toBe(true)
    }
  }, 120_000)

  it('band-boundary flights pair through kit.stairs and pass the layered audit', () => {
    let flights = 0
    for (const [tx, tz] of [[0, 0], [1, 0], [0, 1], [-1, -1]]) {
      const k = keyAt(tx, tz, 0)
      const cy1 = k.cy1
      const list = boundaryFlight(seed, tx, tz, cy1)
      expect(list.length, `block ${tx},${tz}`).toBe(2)
      for (const f of list) {
        flights++
        const up = src.chunkAt(f.cx, cy1, f.cz).stairUp
        const dn = src.chunkAt(f.cx, cy1 + 1, f.cz).stairDown
        expect(up?.dir, `stairUp ${f.cx},${cy1},${f.cz}`).toBe(f.stair.dir)
        expect(dn?.dir, `stairDown ${f.cx},${cy1 + 1},${f.cz}`).toBe(f.stair.dir)
        for (const d of [src.chunkAt(f.cx, cy1, f.cz), src.chunkAt(f.cx, cy1 + 1, f.cz)]) {
          expect((d.structure?.verticalLinks ?? []).some((l) => l.cx === f.cx && l.cz === f.cz && l.lowerCy === cy1)).toBe(false)
        }
      }
      for (let cz = 2 * tz; cz < 2 * tz + 2; cz++) {
        for (let cx = 2 * tx; cx < 2 * tx + 2; cx++) {
          if (!flightAt(seed, cx, cz, cy1)) expect(src.chunkAt(cx, cy1, cz).stairUp ?? null).toBeNull()
        }
      }
      const a = auditLayeredPatch(src.chunkAt, 2 * tx, cy1 - 1, 2 * tz, 2, 4, 2)
      const bad = Object.fromEntries(STRUCTURAL_COUNTERS.filter((c) => a[c]).map((c) => [c, a[c]]))
      expect(bad, JSON.stringify(a.details).slice(0, 1000)).toEqual({})
    }
    expect(flights).toBe(8)
  }, 120_000)

  it('wells: every room shaft is a void on levels 1..4 of ≥ 95% of block-bands', () => {
    let open = 0
    let total = 0
    for (let tz = -6; tz < 6; tz++) {
      for (let tx = -6; tx < 6; tx++) {
        for (let band = -1; band <= 1; band++) {
          const k = keyOfBand(tx, tz, band)
          const v = volumeOf(seed, k, 0x80000001)
          const shafts = layoutOf(seed, k).rooms.reduce((n, room) => n + room.shafts.length, 0)
          expect(shafts, `block-band ${tx},${tz},${band}`).toBeGreaterThan(0)
          total++
          if (noShaftAt(seed, k)) expect(v.levels.every((l) => l.voids.length === 0)).toBe(true)
          else {
            expect(v.levels.slice(1).every((l) => l.voids.length === shafts), `block-band ${tx},${tz},${band}`).toBe(true)
            open++
          }
        }
      }
    }
    expect(open / total).toBeGreaterThanOrEqual(0.95)
    // And the baked floors carry the holes (the spawn block, its band's level 1).
    const k = keyAt(0, 0, 0)
    for (const room of layoutOf(seed, k).rooms) {
      for (const s of room.shafts) {
        const d = src.chunkAt(Math.floor(s.x0 / CHUNK), k.cy0 + 1, Math.floor(s.z0 / CHUNK))
        expect(d.hasFloorHole(s.x0 % CHUNK, s.z0 % CHUNK), `shaft of room ${room.n}`).toBe(true)
      }
    }
  })

  it('anomalies: one per 40 gallery-storeys, never near spawn or at the exit, a band\'s picks differ', () => {
    const ex = exitAnchorGallery(seed)
    const exTile = exitTileOf(seed)
    let n = 0
    let slots = 0
    for (let tz = -5; tz <= 5; tz++) {
      for (let tx = -5; tx <= 5; tx++) {
        for (let band = -2; band <= 2; band++) {
          const k = keyOfBand(tx, tz, band)
          const L = layoutOf(seed, k)
          const picks = bandAnomalyPicks(seed, k)
          const G = L.galleries.length * (k.cy1 - k.cy0 + 1)
          expect(picks.length).toBeGreaterThanOrEqual(Math.floor(G / ANOMALY_ONE_IN))
          expect(picks.length).toBeLessThanOrEqual(Math.floor(G / ANOMALY_ONE_IN) + 1)
          expect(bandAnomalyPicks(seed, k)).toBe(picks)
          slots += G
          n += picks.length
          if (picks.length <= 2) expect(new Set(picks.map((p) => p.cls)).size).toBe(picks.length)
          for (const p of picks) {
            expect(L.rooms[p.n].kind).not.toBe('hall')
            expect(p.cy >= k.cy0 && p.cy <= k.cy1).toBe(true)
            if (Math.max(Math.abs(tx), Math.abs(tz)) <= 1) expect(p.cy < -1 || p.cy > 1, `near spawn ${p.n},${p.cy}`).toBe(true)
            const isExit = tx === ex.tx && tz === ex.tz && p.n === ex.n && p.cy === ex.cy
            expect(isExit).toBe(false)
            expect(ANOMALY_CLASSES).toContain(p.cls)
            expect(anomalyAt(seed, k, p.n, p.cy)).toBe(p.cls)
            if (tx === exTile.tx && tz === exTile.tz) expect(p.cls).not.toBe('crimson')
          }
        }
      }
    }
    // ≈ 1 in 40 gallery-storeys.
    expect(n / slots).toBeGreaterThan(0.02)
    expect(n / slots).toBeLessThan(0.03)
  })

  it('lamps: at most twelve lit per chunk-storey (six globes plus fill light); the Crimson Hexagon is lit red', () => {
    for (let cy = -1; cy <= 1; cy++) {
      for (let cz = -2; cz <= 1; cz++) {
        for (let cx = -2; cx <= 1; cx++) {
          expect(src.chunkAt(cx, cy, cz).lamps.filter((l) => l.lit).length, `${cx},${cy},${cz}`).toBeLessThanOrEqual(WORLD_LIT_CAP)
        }
      }
    }
    const a = exitAnchor(seed)
    const d = src.chunkAt(a.cx, a.cy, a.cz)
    expect(d.lamps.some((l) => l.lit && l.tint === CRIMSON)).toBe(true)
    expect(d.lamps.filter((l) => l.lit).length).toBeLessThanOrEqual(WORLD_LIT_CAP)
  })

  // Design doc 06 §3/§8: the globes never fail. A fixture is dark only in a
  // 'dark' anomaly room, and every other room burns, also in the
  // chunk-storeys a crimson pair crowds past the budget (the cap takes spare
  // fixtures down whole).
  it('lamps never fail: dead fixtures only in dark rooms, every other room lit', () => {
    const checkTile = (s, ws, tx, tz, cy) => {
      const k = keyAt(tx, tz, cy)
      const ox = tx * TILE.w * CHUNK
      const oz = tz * TILE.d * CHUNK
      const lampsIn = (room) => {
        const out = []
        for (let gz = room.z0 + oz; gz <= room.z1 + oz; gz++) {
          for (let gx = room.x0 + ox; gx <= room.x1 + ox; gx++) {
            const cx = Math.floor(gx / CHUNK)
            const cz = Math.floor(gz / CHUNK)
            for (const l of s.chunkAt(cx, cy, cz).lamps) if (l.lx === gx - cx * CHUNK && l.lz === gz - cz * CHUNK) out.push(l)
          }
        }
        return out
      }
      let dark = 0
      for (const room of layoutOf(ws, k).rooms) {
        if (room.kind === 'hall') continue
        const ls = lampsIn(room)
        if (anomalyAt(ws, k, room.n, cy) === 'dark') {
          dark += ls.length
          expect(ls.some((l) => l.lit), `dark ${room.n},${cy}`).toBe(false)
        } else {
          expect(ls.some((l) => l.lit), `unlit room ${tx},${tz} #${room.n} cy ${cy} (seed ${ws})`).toBe(true)
          expect(ls.every((l) => l.lit), `dead fixture in ${tx},${tz} #${room.n} cy ${cy} (seed ${ws})`).toBe(true)
        }
      }
      let deadTotal = 0
      for (let lz = 0; lz < TILE.d; lz++) {
        for (let lx = 0; lx < TILE.w; lx++) {
          const d = s.chunkAt(tx * TILE.w + lx, cy, tz * TILE.d + lz)
          expect(d.lamps.filter((l) => l.lit).length).toBeLessThanOrEqual(WORLD_LIT_CAP)
          deadTotal += d.lamps.filter((l) => !l.lit).length
        }
      }
      // Every dead fixture of the block hangs in one of its dark rooms.
      expect(deadTotal, `stray dead fixtures in ${tx},${tz},${cy} (seed ${ws})`).toBe(dark)
    }
    // The first three crimson and three dark anomalies of band 1 (row-major
    // over the blocks round spawn).
    const found = { crimson: 0, dark: 0 }
    for (let tz = -4; tz <= 4; tz++) {
      for (let tx = -4; tx <= 4; tx++) {
        for (const p of bandAnomalyPicks(seed, keyOfBand(tx, tz, 1))) {
          if ((p.cls !== 'crimson' && p.cls !== 'dark') || found[p.cls] >= 3) continue
          found[p.cls]++
          checkTile(src, seed, tx, tz, p.cy)
        }
      }
    }
    expect(found).toEqual({ crimson: 3, dark: 3 })
    // The ordinary storeys round spawn too.
    for (let tz = -1; tz <= 0; tz++) for (let tx = -1; tx <= 0; tx++) for (let cy = -1; cy <= 1; cy++) checkTile(src, seed, tx, tz, cy)
  })

  // The grammar composes every block-band (the task's hard gate): the wall
  // and column sets of 12 blocks (4×3, every third block) differ, on the
  // spawn storey and on storey 2 — mean pairwise Jaccard ≤ 0.25, max ≤ 0.45
  // (the copied-lattice library measured 0.94).
  it('procedural: blocks differ (wall/column Jaccard over 12 blocks, storeys 0 and 2)', () => {
    const region = (tx, tz, cy) => {
      const set = new Set()
      for (let dz = 0; dz < TILE.d; dz++) {
        for (let dx = 0; dx < TILE.w; dx++) {
          const c = src.chunkAt(tx * TILE.w + dx, cy, tz * TILE.d + dz)
          for (let i = 0; i < CHUNK * CHUNK; i++) {
            const key = `${dx},${dz},${i}`
            if (c.wallV[i]) set.add(`v${key}`)
            if (c.wallH[i]) set.add(`h${key}`)
            if (c.cols[i]) set.add(`c${key}:${c.cols[i]}`)
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
    for (const cy of [0, 2]) {
      const sets = []
      for (let a = 0; a < 4; a++) for (let b = 0; b < 3; b++) sets.push(region(a * 3 + 1, b * 3 + 1, cy))
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
      expect(sum / n, `storey ${cy} mean`).toBeLessThanOrEqual(0.25)
      expect(max, `storey ${cy} max`).toBeLessThanOrEqual(0.45)
    }
  }, 120_000)

  it('the grammar: every storey plan reaches every room; flavours, styles, kinds and counts vary', () => {
    const flavours = new Set()
    const styles = new Set()
    const kinds = new Set()
    const counts = new Set()
    let vests = 0
    let closets = 0
    let loops = 0
    let spaces = 0
    let storeys = 0
    let rooms = 0
    let canonical = 0
    let deadEnds = 0
    let roomStoreys = 0
    for (let tz = -4; tz < 4; tz++) {
      for (let tx = -4; tx < 4; tx++) {
        for (const band of [-1, 0]) {
          const k = keyOfBand(tx, tz, band)
          const L = layoutOf(seed, k)
          flavours.add(L.flavour)
          styles.add(L.style)
          counts.add(L.rooms.length)
          for (const room of L.rooms) {
            kinds.add(room.kind)
            if (room.kind === 'hall') continue
            // Every room has a shaft (doc §1 A3; the shaftless gallery is
            // only the 1-in-40 noShaft anomaly), the gallery is THE 6×4.
            expect(room.shafts.length, `${tx},${tz} room ${room.n}`).toBeGreaterThan(0)
            const w = room.x1 - room.x0 + 1
            const d = room.z1 - room.z0 + 1
            if (room.kind === 'gallery') expect([w, d].sort()).toEqual([4, 6])
            rooms++
            if (room.kind === 'gallery') canonical++
          }
          expect(L.rooms.filter((room) => room.kind === 'hall').length).toBe(4)
          for (let cy = k.cy0; cy <= k.cy1; cy++) {
            const P = storeyPlan(seed, k, cy)
            expect(P.missing, `${tx},${tz} cy ${cy}`).toEqual([])
            vests += P.vests.length
            closets += P.closets.length
            loops += P.vests.length - (L.rooms.length - 1)
            spaces += L.rooms.length + P.vests.filter((v) => v.cells.length).length + P.closets.length + P.stubs.length
            const degree = [...P.degree]
            for (const s of P.stubs) if (L.stubs[s].room >= 0) degree[L.stubs[s].room]++
            deadEnds += degree.filter((dg) => dg === 1).length
            roomStoreys += L.rooms.length
            storeys++
            // Vestibule and closet cells are disjoint.
            const cells = [...P.vests.flatMap((v) => v.cells), ...P.closets.map((c) => c.cell)]
            expect(new Set(cells).size).toBe(cells.length)
          }
        }
      }
    }
    expect([...flavours].sort()).toEqual(['hexagons', 'long galleries', 'reading niches', 'stacks', 'wells'])
    expect(styles.size).toBe(5)
    expect([...kinds].sort()).toEqual(['double', 'gallery', 'hall', 'well'])
    expect(counts.size).toBeGreaterThanOrEqual(5)
    expect(closets).toBeGreaterThan(0)
    // Doc §12: room repetition ≥ 0.95 (the canonical gallery's share of rooms).
    expect(canonical / rooms).toBeGreaterThanOrEqual(0.95)
    // Doc §12: loops per 100 spaces 5–15; dead-end share ≈ 0.
    expect((100 * loops) / spaces).toBeGreaterThanOrEqual(5)
    expect((100 * loops) / spaces).toBeLessThanOrEqual(15)
    expect(deadEnds / roomStoreys).toBeLessThan(0.08)
  })

  it('ports: two hashed candidates per seam, one or both open per storey', () => {
    const seen = new Set()
    for (let t = -6; t <= 6; t++) {
      for (const side of ['west', 'north']) {
        const c = seamCandidates(seed, t, 2 * t, side)
        seen.add(c.join(','))
        expect(c[0]).toBeGreaterThanOrEqual(2)
        expect(c[1]).toBeLessThanOrEqual(25)
        for (let cy = -3; cy <= 3; cy++) {
          const open = openSeamPorts(seed, t, 2 * t, side, cy)
          expect(open.length).toBeGreaterThanOrEqual(1)
          expect(ports(seed, { tx: t, tz: 2 * t }, side, cy).map((p) => p.a0)).toEqual(open)
        }
      }
    }
    expect(seen.size).toBeGreaterThan(10)
  })

  // Backs the SLOW reachLevels [1]: the hook returns one exit for every
  // level of each of the harness's 16 reach seeds.
  it('the exit hook is level-invariant', () => {
    const hook = familyExitHook(config)
    for (const ws of [1, 0x5eed, 777, ...Array.from({ length: 13 }, (_, i) => hashStr(`reach-babel-${i}`))]) {
      const s = worldSource(ws, config)
      const at = (level) => hook({ worldSeed: ws, level, config, profile, generate: (cx, cy, cz) => s.chunkAt(cx, cy, cz) })
      const first = at(1)
      for (const level of [2, 3, 5, 9]) expect(at(level), `seed ${ws} level ${level}`).toEqual(first)
    }
  })

  it('spawn and exit are marked by their bakes', () => {
    const a = exitAnchor(seed)
    const g = exitAnchorGallery(seed)
    const bake = tileBakeAt(seed, keyAt(g.tx, g.tz, g.cy), config)
    expect(bake.exits.length).toBe(1)
    expect(bake.exits[0]).toMatchObject({ gx: a.cx * CHUNK + a.lx, gz: a.cz * CHUNK + a.lz, cy: a.cy })
    const home = tileBakeAt(seed, keyAt(0, 0, 0), config)
    expect(home.spawns.length).toBeGreaterThan(0)
    expect(home.spawns[0]).toMatchObject({ gx: SPAWN_CELLS[0].lx, gz: SPAWN_CELLS[0].lz, cy: 0 })
  })

  it('a retried bake (attempt 1) still matches the planner', () => {
    const gen = familyGenerator('babel')
    const forced = { ...gen, bake: (canvas, ctx) => (ctx.attempt === 0 ? { error: 'forced' } : gen.bake(canvas, ctx)) }
    for (const [tx, tz, cy] of [[0, 0, 0], [2, -1, 6]]) {
      const bake = bakeTile(forced, profile, seed, config, keyAt(tx, tz, cy))
      expect(bake.fallback).toBe(false)
      expect(bake.attempts).toBe(2)
      expect(bake.notes.filter((n) => n.startsWith('kit:'))).toEqual([])
    }
  }, 120_000)

  it('residency stays within 1.7× hotel on a headless stream walk', () => {
    const resident = (family) => {
      const cfg = family === 'babel' ? config : worldConfigForFamily(family)
      const planner = familyPlanner(family)
      const cm = new ChunkManager(new THREE.Scene(), seed, null, null)
      cm.config = cfg
      cm._idlePrebake = () => {}
      // Resident stand-ins (chunk-manager-streaming.test.js): the planner's
      // volume for babel; hotel's multilevel rooms (a lower bound on hotel,
      // so the ratio is conservative).
      cm._buildNext = function () {
        const request = this.queue.shift()
        this.queued.delete(request.key)
        if (this.chunks.has(request.key)) return
        let structure = null
        if (planner) structure = planner.structureAt(this.seed, request.cx, request.cz, request.cy)
        else {
          const r = chunkMultilevelRooms(this.seed, request.cx, request.cz, request.cy, this.config)
          structure = r.structure.hasRoom ? r.structure : null
        }
        const chunk = {
          cx: request.cx, cy: request.cy, cz: request.cz, structure, data: { structure }, apertures: [], lamps: [],
          group: { visible: true }, renderDetail: null, setRenderDetail(d) { this.renderDetail = d }, dispose() {},
        }
        this.chunks.set(request.key, chunk)
        this._enqueueStructureRequests(structure)
        this._applyVisibility(chunk)
        this._applyRenderDetail(chunk)
      }
      const path = []
      for (let x = 0; x < 8; x++) path.push([x, 0, 0])
      for (let cy = 1; cy <= 6; cy++) path.push([8, 0, cy])
      for (let z = 1; z < 6; z++) path.push([8, z, 6])
      let sum = 0
      let max = 0
      for (const [x, z, cy] of path) {
        for (let f = 0; f < 400 && (f < 2 || cm.queue.length); f++) cm.update((x + 0.5) * CHUNK_WORLD, (z + 0.5) * CHUNK_WORLD, cy)
        sum += cm.chunks.size
        max = Math.max(max, cm.chunks.size)
      }
      return { mean: sum / path.length, max }
    }
    const babel = resident('babel')
    const hotel = resident('hotel')
    expect(babel.mean / hotel.mean, JSON.stringify({ babel, hotel })).toBeLessThanOrEqual(1.7)
    expect(babel.max / hotel.max).toBeLessThanOrEqual(1.7)
  }, 120_000)

  it('the tile is a 2×2 block on bands of five, phase (tx + 2tz) mod 5', () => {
    expect([TILE.w, TILE.d, TILE.H]).toEqual([2, 2, 5])
    for (const [tx, tz] of [[0, 0], [1, 0], [0, 1], [3, -2]]) {
      const k = keyAt(tx, tz, 0)
      expect(((k.cy0 - (tx + 2 * tz)) % 5 + 5) % 5).toBe(0)
    }
  })
})
