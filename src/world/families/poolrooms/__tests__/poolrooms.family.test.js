import { describe, expect, it } from 'vitest'
import { CHUNK, chunkKey3, hIdx, vIdx } from '../../../constants.js'
import { hash2i } from '../../../core/hash.js'
import { auditLayeredPatch } from '../../../audit.js'
import { buildChunk } from '../../../pipeline.js'
import { resolveMapFamily } from '../../../mapFamily.js'
import { WALL_RAIL } from '../../../mapTypes.js'
import { linkHalo } from '../../../structures/catalog/engine.js'
import { catalogSliceErrors } from '../../../structures/catalog/audit.js'
import { makeTileCtx, tileBakeAt } from '../../../tiles/familyChunk.js'
import { massLeakAudit } from '../../../tiles/seams.js'
import { solidChunk } from '../../../tiles/solidChunk.js'
import { TileCanvas } from '../../../tiles/TileCanvas.js'
import { tileKeyAt, tileWindow } from '../../../tiles/tileKey.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familyGenerator } from '../../generators.js'
import { familyExitHook, familySpawn, hookOf } from '../../hooks.js'
import { familyPlanner } from '../../planners.js'
import { componentPartition, windowConnectivity, worldSource } from '../../reach.js'
import { SLOW, STRUCTURAL_COUNTERS, plannerKeySweep, runFamilySuite } from '../../__tests__/familyHarness.js'
import {
  AREA,
  TILE,
  VOLUME_TYPES,
  anomalyAllowed,
  anomalyAt,
  bandKey,
  exitTileOf,
  footprint,
  pitOf,
  planSeedOf,
  ports,
  ropeSiteOf,
  seamPorts,
  separable,
  tilePorts,
  tileVolumes,
  volumesOf,
} from '../geometry.js'
import { chamberAnomalies, spawnCells, worldTileGrammar } from '../grammar.js'
import { PROP_LOUNGER } from '../../../props/index.js'

// The poolrooms family suite (spec §11.1, §12.4): W = 2×2 tiles × storeys
// −1..1; the decision-6 window is 3×3 tiles × −1..1.
runFamilySuite('poolrooms', {
  window: { tiles: [2, 2], storeys: [-1, 1] },
  connWindow: { tiles: [3, 3], storeys: [-1, 1] },
})

// --- poolrooms specifics (§12.4 Tests) -----------------------------------------------

const ID = 'poolrooms'
const config = forcedFamilyConfig(ID)
const profile = resolveMapFamily(config)
const gen = familyGenerator(ID)
const planner = familyPlanner(ID)
const SEEDS = [1, 0x5eed, 777]
const TC = TILE.w * CHUNK // 42 cells per tile side

// The tile's chunk box (GLOBAL chunks) over storeys y0..y1.
const tileBox = (tx, tz, y0 = -1, y1 = 1) => ({ x0: tx * 3, z0: tz * 3, x1: tx * 3 + 2, z1: tz * 3 + 2, y0, y1 })
const boxOfTiles = (tx0, tz0, tx1, tz1, y0 = -1, y1 = 1) => ({ x0: tx0 * 3, z0: tz0 * 3, x1: tx1 * 3 + 2, z1: tz1 * 3 + 2, y0, y1 })
const shift = (r, tx, tz) => ({ x0: r.x0 + tx * TC, z0: r.z0 + tz * TC, x1: r.x1 + tx * TC, z1: r.z1 + tz * TC })

// The anti-copy metric (scratchpad repeat/sim.mjs): a tile's wall edges and
// column cells on storey cy as a set; mean / max pairwise Jaccard.
function tileSignature(seed, tx, tz, cy) {
  const s = new Set()
  for (let dz = 0; dz < 3; dz++) {
    for (let dx = 0; dx < 3; dx++) {
      const c = buildChunk(seed, tx * 3 + dx, cy, tz * 3 + dz, config, null, [])
      for (let i = 0; i < CHUNK * CHUNK; i++) {
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

describe('poolrooms family (§12.4)', () => {
  it('tile and footprint: basin, deck and upper gallery all nine chunks; a stair core up from every deck', () => {
    expect(TILE).toMatchObject({ w: 3, d: 3, backend: 'band', H: 3, lo: -1, hi: 1, salt: 0x5a170008 })
    for (const seed of SEEDS) {
      for (const [tx, tz] of [[0, 0], [-3, 2], [5, -7], [2, 2], [-1, -4], [3, 0]]) {
        const count = (cy) => {
          let n = 0
          for (let cz = tz * 3; cz < tz * 3 + 3; cz++) for (let cx = tx * 3; cx < tx * 3 + 3; cx++) if (footprint(seed, cx, cy, cz) === 'tile') n++
          return n
        }
        expect([count(-1), count(0), count(1)]).toEqual([9, 9, 9])
        expect(footprint(seed, tx * 3, 2, tz * 3)).toBe('solid')
        expect(footprint(seed, tx * 3, -2, tz * 3)).toBe('solid')
        // The gallery's stair core: one enclosed flight deck → gallery, in a
        // chunk free of the natatio's own flight, `gap` (2, else 1, else 0)
        // off every pool box.
        const g = worldTileGrammar(seed, tx, tz)
        expect(g.stair, `stair core ${tx},${tz}`).toBeTruthy()
        const { core, box, gap } = g.stair
        expect([0, 1, 2]).toContain(gap)
        expect(Math.floor(core.x0 / CHUNK)).toBe(Math.floor(core.x1 / CHUNK))
        expect(Math.floor(core.z0 / CHUNK)).toBe(Math.floor(core.z1 / CHUNK))
        for (const v of tileVolumes(seed, tx, tz)) {
          expect(box.x1 + gap < v.box.x0 || v.box.x1 + gap < box.x0 || box.z1 + gap < v.box.z0 || v.box.z1 + gap < box.z0, `stair box clear of ${v.type}`).toBe(true)
        }
        const cx = tx * 3 + Math.floor(core.x0 / CHUNK)
        const cz = tz * 3 + Math.floor(core.z0 / CHUNK)
        expect(planner.verticalOpeningAt(seed, cx, cz, 0, profile, config)).toBe(true)
      }
    }
  })

  it('ports: deck only, hashed per seam (2–4 openings of 1–2 cells, off the corners and the chunk lines)', () => {
    const seen = new Set()
    for (const seed of SEEDS) {
      for (let tz = -3; tz <= 3; tz++) {
        for (let tx = -3; tx <= 3; tx++) {
          for (const side of ['west', 'north']) {
            const ps = ports(seed, { tx, tz }, side, 0)
            expect(ps).toBe(seamPorts(seed, tx, tz, side))
            expect(ps.length).toBeGreaterThanOrEqual(2)
            expect(ps.length).toBeLessThanOrEqual(4)
            for (const p of ps) {
              expect(p.a1 - p.a0).toBeLessThanOrEqual(1)
              expect(p.a0).toBeGreaterThanOrEqual(2)
              expect(p.a1).toBeLessThanOrEqual(38)
              expect(Math.floor(p.a0 / CHUNK)).toBe(Math.floor(p.a1 / CHUNK))
            }
            // Disjoint openings, in order, at least 2 cells apart.
            for (let i = 1; i < ps.length; i++) expect(ps[i].a0 - ps[i - 1].a1).toBeGreaterThanOrEqual(2)
            seen.add(JSON.stringify(ps))
            for (const cy of [-1, 1]) expect(ports(seed, { tx, tz }, side, cy)).toEqual([])
          }
          // The east view is the next tile's west, the south view the next row's north.
          expect(tilePorts(seed, tx, tz).east).toBe(seamPorts(seed, tx + 1, tz, 'west'))
          expect(tilePorts(seed, tx, tz).south).toBe(seamPorts(seed, tx, tz + 1, 'north'))
        }
      }
    }
    // Not a fixed opening: the seams of 3 seeds × 98 seams hold many layouts.
    expect(seen.size).toBeGreaterThan(100)
  })

  it('planner: 2–4 volumes per tile (always one pit room), zero nulls over 2000 keys, at true global coordinates', () => {
    const sweep = plannerKeySweep(planner, TILE, SEEDS[0], profile, config, 2000)
    expect(sweep).toMatchObject({ keys: 2000, nulls: 0, ruleErrors: [] })
    for (const seed of SEEDS) {
      for (const [tx, tz] of [[0, 0], [1, -1], [-4, 3], [9, 9], [2, 2]]) {
        const k = bandKey(tx, tz)
        const vols = tileVolumes(seed, tx, tz)
        const list = planner.structuresInTile(seed, k, profile, config)
        expect(list.length).toBe(vols.length)
        expect(list.length).toBeGreaterThanOrEqual(2)
        expect(list.length).toBeLessThanOrEqual(4)
        expect(list.filter((s) => s.type === 'pitRoom')).toHaveLength(1)
        expect(list.map((s) => [s.slot, s.kind, s.family])).toEqual(vols.map((v, i) => [i, 'poolroomsCatalog', ID]))
        expect(list.map((s) => s.type)).toEqual(vols.map((v) => v.type))
        expect(list.map((s) => s.globalBounds)).toEqual(vols.map((v) => shift(v.fp, tx, tz)))
        expect(list.map((s) => s.levels[1].voids)).toEqual(vols.map((v) => [shift(v.pool, tx, tz)]))
        expect(list.map((s) => [s.baseCy, s.topCy])).toEqual(vols.map((v) => [-1, v.levels - 2]))
        for (const s of list) for (const p of s.participants) expect(planner.structureAt(seed, p.cx, p.cz, s.baseCy, profile, config)).toBe(s)
        // The grammar can always run a channel between the boxes.
        expect(separable(vols.map((v) => v.box), AREA)).toBe(true)
      }
    }
  })

  it('the volume grammar varies: programs, sizes, lies and positions differ tile to tile', () => {
    const programs = new Set()
    const pits = new Set()
    const sizes = new Set()
    const lies = new Set()
    for (let i = 0; i < 300; i++) {
      const vols = volumesOf(hash2i(0x5eed, i, 7) >>> 0)
      programs.add(vols.map((v) => v.type).join('+'))
      const pit = pitOf(vols)
      pits.add(`${pit.box.x0},${pit.box.z0}`)
      for (const v of vols) {
        sizes.add(`${v.type}:${v.pool.x1 - v.pool.x0}x${v.pool.z1 - v.pool.z0}`)
        lies.add(`${v.type}:${v.alongX}`)
      }
    }
    expect(programs.size).toBeGreaterThanOrEqual(6)
    expect(pits.size).toBeGreaterThan(150)
    expect(sizes.size).toBeGreaterThan(40)
    expect(lies.size).toBe(2 * Object.keys(VOLUME_TYPES).length)
  })

  it('the deck grammar: chambers 4–8 cells a side (doc §4.1), pool halls with wide margins, a few walks and courts; the basin a plant level', () => {
    const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))]
    const chambers = []
    const counts = []
    const margins = []
    const walks = []
    const courts = []
    const loops = []
    const basinRooms = []
    for (const seed of SEEDS) {
      for (let tz = -4; tz < 4; tz++) {
        for (let tx = -4; tx < 4; tx++) {
          const g = worldTileGrammar(seed, tx, tz)
          const live = g.deck.regions.filter((r) => !r.mass)
          const ch = live.filter((r) => r.type === 'chamber')
          counts.push(ch.length)
          for (const r of ch) chambers.push([r.rect.x1 - r.rect.x0 + 1, r.rect.z1 - r.rect.z0 + 1])
          for (const h of live.filter((r) => r.type === 'hall')) margins.push(Math.max(h.box.x0 - h.rect.x0, h.rect.x1 - h.box.x1, h.box.z0 - h.rect.z0, h.rect.z1 - h.box.z1))
          walks.push(live.filter((r) => r.type === 'walk').length)
          courts.push(live.filter((r) => r.type === 'court').length)
          loops.push(g.deck.stats.loops)
          basinRooms.push(g.basin.stats.chambers)
        }
      }
    }
    // Every chamber is 4..8 a side. Measured over 192 tiles: chambers per
    // tile p10 7, median 14, p90 22; the widest hall margin median 5.
    for (const [w, h] of chambers) {
      expect(Math.min(w, h)).toBeGreaterThanOrEqual(4)
      expect(Math.max(w, h)).toBeLessThanOrEqual(8)
    }
    expect(q(counts, 0.5)).toBeGreaterThanOrEqual(6)
    expect(q(counts, 0.5)).toBeLessThanOrEqual(16)
    expect(q(margins, 0.5)).toBeGreaterThanOrEqual(3)
    expect(Math.max(...walks)).toBeLessThanOrEqual(3)
    expect(Math.max(...courts)).toBeLessThanOrEqual(1)
    expect(courts.filter(Boolean).length / courts.length).toBeGreaterThan(0.2)
    expect(q(loops, 0.5)).toBeGreaterThanOrEqual(3)
    expect(q(basinRooms, 0.5)).toBeGreaterThanOrEqual(6)
  })

  it('the gallery grammar: a terrace level of few big rooms (sun terraces, viewing rooms), not a warren; a stair core in every tile', () => {
    const areas = []
    const rooms = []
    const terraces = []
    let tiles = 0
    let cores = 0
    for (const seed of SEEDS) {
      for (let tz = -4; tz < 4; tz++) {
        for (let tx = -4; tx < 4; tx++) {
          const g = worldTileGrammar(seed, tx, tz)
          tiles++
          if (g.stair) cores++
          const live = (g.gallery?.regions ?? []).filter((r) => !r.mass && (r.type === 'chamber' || r.type === 'court'))
          rooms.push(live.length)
          terraces.push(live.filter((r) => r.type === 'court').length)
          for (const r of live) areas.push((r.rect.x1 - r.rect.x0 + 1) * (r.rect.z1 - r.rect.z0 + 1))
        }
      }
    }
    // Measured over 192 tiles: rooms (chambers and terraces) per tile p10 5,
    // median 8, p90 13; room area p10 48, median 90, p90 176 cells² (the
    // deck's chambers: median 25); terraces a tile median 2.
    const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))]
    expect(cores).toBe(tiles)
    expect(q(rooms, 0.5)).toBeLessThanOrEqual(12)
    expect(q(areas, 0.5)).toBeGreaterThanOrEqual(64)
    expect(q(terraces, 0.5)).toBeGreaterThanOrEqual(2)
  })

  it('anti-copy gate: tiles are generated, not repeated (every storey: mean Jaccard ≤ 0.25, max ≤ 0.45 over 12 tiles)', () => {
    const origins = []
    for (let a = 0; a < 4; a++) for (let b = 0; b < 3; b++) origins.push([a * 3 + 1, b * 3 + 1])
    for (const cy of [0, -1, 1]) {
      const sigs = origins.map(([tx, tz]) => tileSignature(12345, tx, tz, cy))
      let sum = 0
      let n = 0
      let max = 0
      for (let i = 0; i < sigs.length; i++) {
        for (let j = i + 1; j < sigs.length; j++) {
          const v = jaccard(sigs[i], sigs[j])
          sum += v
          n++
          max = Math.max(max, v)
        }
      }
      expect(sum / n, `storey ${cy} mean`).toBeLessThanOrEqual(0.25)
      expect(max, `storey ${cy} max`).toBeLessThanOrEqual(0.45)
    }
  }, 60_000)

  it('a forced attempt-1 bake (new tileSeed, same planSeed) matches the planner: no kit:planner-mismatch', () => {
    for (const seed of SEEDS) {
      for (const [tx, tz] of [[0, 0], [2, 1], [-2, 0]]) {
        const k = tileKeyAt(TILE, tx, tz, 0)
        const planSeed = planSeedOf(seed, k)
        const win = tileWindow(TILE, k)
        const canvas = new TileCanvas({
          family: ID, base: 'tower', version: config.version, worldSeed: seed, origin: k.origin, district: { dx: tx, dz: tz },
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
      }
    }
  })

  it('tile mode keeps every stair halo (both storeys of each link) and the exit cell furniture-free', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const [tx, tz] of [[0, 0], [1, 0], [0, 1], [-2, 2]]) {
        for (const s of planner.structuresInTile(seed, bandKey(tx, tz), profile, config)) {
          for (const link of s.verticalLinks) {
            const h = linkHalo(link)
            for (const cy of [link.lowerCy, link.lowerCy + 1]) {
              for (let gz = h.z0; gz <= h.z1; gz++) {
                for (let gx = h.x0; gx <= h.x1; gx++) {
                  const cx = Math.floor(gx / CHUNK)
                  const cz = Math.floor(gz / CHUNK)
                  const d = src.chunkAt(cx, cy, cz)
                  const lx = gx - cx * CHUNK
                  const lz = gz - cz * CHUNK
                  expect(d.furniture.filter((f) => f.lx === lx && f.lz === lz), `furniture in halo ${gx},${gz},${cy}`).toEqual([])
                }
              }
            }
          }
        }
        const exits = tileBakeAt(seed, bandKey(tx, tz), config).exits
        for (const e of exits) {
          const cx = Math.floor(e.gx / CHUNK)
          const cz = Math.floor(e.gz / CHUNK)
          expect(src.chunkAt(cx, e.cy, cz).furniture.filter((f) => f.lx === e.gx - cx * CHUNK && f.lz === e.gz - cz * CHUNK)).toEqual([])
        }
      }
    }
  })

  it('each tile is one walk graph per storey: the deck joins every port, the basin every under-deck hall', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const [tx, tz] of [[0, 0], [1, 1], [-3, 2]]) {
        for (const cy of [0, -1]) {
          const comps = componentPartition(src, tileBox(tx, tz, cy, cy))
          expect(comps.length, `seed ${seed} tile ${tx},${tz} storey ${cy}: ${comps.map((c) => c.length)}`).toBe(1)
          const set = new Set(comps[0])
          if (cy === 0) {
            const ps = tilePorts(seed, tx, tz)
            const cells = [
              ...ps.west.map((p) => [0, p.a0]), ...ps.north.map((p) => [p.a0, 0]),
              ...ps.east.map((p) => [TC - 1, p.a0]), ...ps.south.map((p) => [p.a0, TC - 1]),
            ]
            for (const [x, z] of cells) expect(set.has(`${tx * TC + x},${tz * TC + z},0`), `port ${x},${z}`).toBe(true)
          }
        }
        // The grammar's own record: chambers, mouths, loops and dead ends.
        const g = worldTileGrammar(seed, tx, tz)
        expect(g.deck.stats.loops).toBeGreaterThanOrEqual(1)
        expect(g.deck.stats.chambers).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it('spawn on the deck of tile (0,0) at a grammar cell; exit on the pit floor (cy −1) of a tile at Chebyshev distance 2', () => {
    const hooks = hookOf(ID)
    expect(hooks.stub).toBe(false)
    for (const seed of [...SEEDS, 4242, 99]) {
      const sp = familySpawn(config, seed)
      const cells = spawnCells(seed).map((c) => `${c.gx},${c.gz}`)
      expect(cells).toContain(`${sp.cx * CHUNK + sp.lx},${sp.cz * CHUNK + sp.lz}`)
      expect([Math.floor(sp.cx / 3), Math.floor(sp.cz / 3)]).toEqual([0, 0])
      const src = worldSource(seed, config)
      const ex = familyExitHook(config)({ worldSeed: seed, level: 1, config, profile, generate: src.chunkAt })
      const t = exitTileOf(seed)
      expect(Math.max(Math.abs(t.tx), Math.abs(t.tz))).toBe(2)
      expect(ex.cy).toBe(-1)
      expect([Math.floor(ex.cx / 3), Math.floor(ex.cz / 3)]).toEqual([t.tx, t.tz])
      expect(ex).toEqual(hooks.exitAnchor(seed, profile))
      const list = planner.structuresInTile(seed, bandKey(t.tx, t.tz), profile, config)
      const v = list.find((s) => s.type === 'pitRoom').levels[1].voids[0]
      const gx = ex.cx * CHUNK + ex.lx
      const gz = ex.cz * CHUNK + ex.lz
      expect(gx >= v.x0 && gx <= v.x1 && gz >= v.z0 && gz <= v.z1, 'exit inside the pit well').toBe(true)
      expect(anomalyAt(seed, bandKey(t.tx, t.tz))).toBeNull()
      const dist = Math.max(Math.abs(ex.cx - sp.cx), Math.abs(ex.cz - sp.cz))
      expect(dist).toBeGreaterThanOrEqual(hooks.exitBounds.minChunks)
      expect(dist).toBeLessThanOrEqual(hooks.exitBounds.maxChunks)
    }
    expect(hooks.exitHookStats.lastResort).toBe(0)
  })

  it('proofBox: exactly the spawn and exit tiles\' bounding rectangle over the deck and the basin', () => {
    const hooks = hookOf(ID)
    for (const seed of [...SEEDS, 2, 3, 4, 5]) {
      const sp = familySpawn(config, seed)
      const ex = hooks.exitAnchor(seed, profile)
      const t = exitTileOf(seed)
      const box = hooks.proofBox(ex, sp)
      expect(box).toEqual({
        chunks: { x0: Math.min(t.tx, 0) * 3, z0: Math.min(t.tz, 0) * 3, x1: Math.max(t.tx, 0) * 3 + 2, z1: Math.max(t.tz, 0) * 3 + 2 },
        cy: [-1, 0],
      })
      for (const c of [sp, ex]) {
        expect(c.cx >= box.chunks.x0 && c.cx <= box.chunks.x1 && c.cz >= box.chunks.z0 && c.cz <= box.chunks.z1).toBe(true)
      }
    }
  })

  it('anomalies: hashed per tile from the planSeed, never the same class on edge neighbours, never near spawn or in the exit tile', () => {
    const maps = []
    const sites = new Set()
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
          expect(['deep', 'rope']).toContain(a)
          // doc 14: never the same class twice in a row.
          for (const [nx, nz] of [[tx + 1, tz], [tx, tz + 1]]) if (at(nx, nz)) expect(at(nx, nz), `seed ${seed} ${tx},${tz}→${nx},${nz}`).not.toBe(a)
          if (a === 'rope') sites.add(ropeSiteOf(planSeedOf(seed, bandKey(tx, tz)), 5))
          expect(anomalyAt(seed, bandKey(tx, tz))).toBe(a)
        }
      }
      expect(present / cells, `seed ${seed} density`).toBeGreaterThan(0.4)
      expect(present / cells, `seed ${seed} density`).toBeLessThan(0.75)
      expect(classes).toEqual(new Set(['deep', 'rope']))
      maps.push(sig.join(''))
    }
    expect(new Set(maps).size).toBe(maps.length)
    expect([...sites].sort()).toEqual([0, 1, 2, 3, 4])
  })

  it('chamber anomalies (doc 14: segment = chamber, 1 per 6): ropes and lone loungers, one per chamber, never the same class on linked chambers', () => {
    for (const seed of SEEDS) {
      let chambers = 0
      let anomalies = 0
      const classes = new Set()
      for (let tz = -8; tz < 8; tz++) {
        for (let tx = -8; tx < 8; tx++) {
          const k = bandKey(tx, tz)
          const g = worldTileGrammar(seed, tx, tz)
          chambers += g.deck.regions.filter((r) => r.type === 'chamber' && !r.mass).length
          const tileAnom = anomalyAt(seed, k)
          if (!anomalyAllowed(seed, tx, tz)) {
            expect(tileAnom, `seed ${seed} tile ${tx},${tz}`).toBeNull()
            continue
          }
          const tileRope = tileAnom === 'rope' && g.deck.ropeSites.length ? g.deck.ropeLinks[ropeSiteOf(planSeedOf(seed, k), g.deck.ropeSites.length)] : null
          const list = chamberAnomalies(planSeedOf(seed, k), g.deck, tileRope)
          expect(chamberAnomalies(planSeedOf(seed, k), g.deck, tileRope)).toEqual(list)
          anomalies += list.length + (tileAnom === 'deep' ? 1 : 0)
          // One per chamber; the tile's rope is one of them.
          expect(new Set(list.map((a) => a.region)).size).toBe(list.length)
          expect(list.filter((a) => a.tile).map((a) => a.link)).toEqual(tileRope ? [tileRope] : [])
          const cls = new Map(list.map((a) => [a.region, a.cls]))
          for (const a of list) {
            classes.add(a.cls)
            expect(g.deck.regions[a.region].type).toBe('chamber')
            if (a.cls === 'rope') expect([a.link.pair.a, a.link.pair.b]).toContain(a.region)
          }
          for (const l of g.deck.links) if (cls.has(l.pair.a) && cls.has(l.pair.b)) expect(cls.get(l.pair.a), `seed ${seed} tile ${tx},${tz}`).not.toBe(cls.get(l.pair.b))
          // Every rope strung at once keeps the deck one graph.
          const shut = new Set(list.filter((a) => a.cls === 'rope').map((a) => a.link))
          const adj = new Map()
          for (const l of g.deck.links) {
            if (shut.has(l)) continue
            for (const [x, y] of [[l.pair.a, l.pair.b], [l.pair.b, l.pair.a]]) adj.set(x, [...(adj.get(x) ?? []), y])
          }
          const live = g.deck.regions.filter((r) => !r.mass)
          const seen = new Set([live[0].id])
          const queue = [live[0].id]
          while (queue.length) {
            for (const y of adj.get(queue.pop()) ?? []) {
              if (!seen.has(y)) { seen.add(y); queue.push(y) }
            }
          }
          expect(seen.size, `seed ${seed} tile ${tx},${tz} ropes`).toBe(live.length)
        }
      }
      // Measured: 6.2–6.3 chambers per anomaly over 400 tiles (seeds 1, 0x5eed, 8080).
      expect(chambers / anomalies, `seed ${seed} chambers per anomaly`).toBeGreaterThanOrEqual(5)
      expect(chambers / anomalies, `seed ${seed} chambers per anomaly`).toBeLessThanOrEqual(8)
      expect(classes).toEqual(new Set(['rope', 'towel']))
    }
  })

  it('anomalies in the world: deep wells and lane ropes keep it sealed and connected', () => {
    const seed = SEEDS[0]
    const src = worldSource(seed, config)
    const inner = boxOfTiles(2, 1, 4, 3)
    const outer = boxOfTiles(1, 0, 5, 4)
    const found = []
    let chamberSeen = 0
    let ropeless = 0
    for (let tz = 1; tz <= 3; tz++) for (let tx = 2; tx <= 4; tx++) found.push({ tx, tz, kind: anomalyAt(seed, bandKey(tx, tz)) })
    expect(new Set(found.map((f) => f.kind).filter(Boolean))).toEqual(new Set(['deep', 'rope']))
    const sp = spawnCells(seed)[0]
    const res = windowConnectivity(src, inner, outer, { gx: sp.gx + 3 * TC, gz: sp.gz + 2 * TC, cy: 0 })
    expect({ ok: res.ok, reason: res.reason, stranded: res.stranded, sealed: res.sealed }).toMatchObject({ ok: true, reason: null, stranded: [], sealed: [] })
    const audit = massLeakAudit(src.chunkAt, outer, { gen, worldSeed: seed })
    expect(audit.details).toEqual({ leaks: [], seals: [], portViolations: [], seeThroughToSolid: [], seeThroughThinMass: [] })
    const lay = auditLayeredPatch(src.chunkAt, inner.x0, -1, inner.z0, inner.x1 - inner.x0 + 1, 3, inner.z1 - inner.z0 + 1)
    expect(Object.fromEntries(STRUCTURAL_COUNTERS.filter((c) => lay[c]).map((c) => [c, lay[c]]))).toEqual({})
    for (const { tx, tz, kind } of found) {
      const k = bandKey(tx, tz)
      const pit = pitOf(tileVolumes(seed, tx, tz))
      const pitChunk = { cx: tx * 3 + Math.floor((pit.pool.x0 + pit.pool.x1) / 2 / CHUNK), cz: tz * 3 + Math.floor((pit.pool.z0 + pit.pool.z1) / 2 / CHUNK) }
      const label = src.chunkAt(pitChunk.cx, -1, pitChunk.cz).levelLabel
      if (kind === 'deep') {
        const v = planner.structuresInTile(seed, k, profile, config).find((s) => s.type === 'pitRoom').levels[1].voids[0]
        expect([v.x1 - v.x0 + 1, v.z1 - v.z0 + 1]).toEqual([6, 6])
        expect(label).toBe('999F')
        // No lit tube over the too-deep well's box, on the deck or under it.
        const box = shift(pit.box, tx, tz)
        for (const cy of [-1, 0]) {
          for (let cz = Math.floor(box.z0 / CHUNK); cz <= Math.floor(box.z1 / CHUNK); cz++) {
            for (let cx = Math.floor(box.x0 / CHUNK); cx <= Math.floor(box.x1 / CHUNK); cx++) {
              const lit = src.chunkAt(cx, cy, cz).lamps.filter((l) => {
                const gx = cx * CHUNK + l.lx
                const gz = cz * CHUNK + l.lz
                return l.lit && gx >= box.x0 && gx <= box.x1 && gz >= box.z0 && gz <= box.z1
              })
              expect(lit, `deep box lamps ${cx},${cy},${cz}`).toEqual([])
            }
          }
        }
      } else {
        expect(label).not.toBe('999F')
      }
      // The rope: rails across the chosen chamber mouth, and the tile's deck
      // still one walk graph.
      const g = worldTileGrammar(seed, tx, tz)
      if (kind === 'rope' && !g.deck.ropeSites.length) {
        // A deck of pool halls alone (no chamber on a loop): the bake notes
        // the rope found no site (measured: 2 tiles in 576).
        expect(tileBakeAt(seed, k, config).notes).toContain('anomaly: rope (no site)')
        ropeless++
      } else if (kind === 'rope') {
        const site = g.deck.ropeSites[ropeSiteOf(planSeedOf(seed, k), g.deck.ropeSites.length)]
        for (const e of site) {
          const gx = tx * TC + e.gx
          const gz = tz * TC + e.gz
          const cx = Math.floor(gx / CHUNK)
          const cz = Math.floor(gz / CHUNK)
          const d = src.chunkAt(cx, 0, cz)
          const i = e.axis === 'v' ? vIdx(gx - cx * CHUNK, gz - cz * CHUNK) : hIdx(gx - cx * CHUNK, gz - cz * CHUNK)
          const [walls, feats] = e.axis === 'v' ? [d.wallV, d.wallFeatureV] : [d.wallH, d.wallFeatureH]
          expect([walls[i], feats[i]], `rope edge ${e.axis} ${gx},${gz}`).toEqual([1, WALL_RAIL])
        }
        expect(componentPartition(src, tileBox(tx, tz, 0, 0))).toHaveLength(1)
      }
      // The chamber anomalies: rails across every rope's mouth, a lone
      // lounger in each towel chamber; the bake notes them all.
      const tileRope = kind === 'rope' ? g.deck.ropeLinks[ropeSiteOf(planSeedOf(seed, k), g.deck.ropeSites.length)] : null
      const list = anomalyAllowed(seed, tx, tz) ? chamberAnomalies(planSeedOf(seed, k), g.deck, tileRope) : []
      const notes = tileBakeAt(seed, k, config).notes
      for (const a of list) {
        if (a.tile) continue
        const note = notes.find((n) => n.startsWith(`anomaly: chamber ${a.region} ${a.cls}`))
        expect(note, `tile ${tx},${tz} chamber ${a.region}`).toBeTruthy()
        if (note.endsWith('(no site)')) continue
        if (a.cls === 'rope') {
          for (const e of a.link.edges) {
            const gx = tx * TC + e.gx
            const gz = tz * TC + e.gz
            const cx = Math.floor(gx / CHUNK)
            const cz = Math.floor(gz / CHUNK)
            const d = src.chunkAt(cx, 0, cz)
            const i = e.axis === 'v' ? vIdx(gx - cx * CHUNK, gz - cz * CHUNK) : hIdx(gx - cx * CHUNK, gz - cz * CHUNK)
            const [walls, feats] = e.axis === 'v' ? [d.wallV, d.wallFeatureV] : [d.wallH, d.wallFeatureH]
            expect([walls[i], feats[i]], `chamber rope edge ${e.axis} ${gx},${gz}`).toEqual([1, WALL_RAIL])
          }
        } else {
          const r = shift(g.deck.regions[a.region].rect, tx, tz)
          let loungers = 0
          for (let cz = Math.floor(r.z0 / CHUNK); cz <= Math.floor(r.z1 / CHUNK); cz++) {
            for (let cx = Math.floor(r.x0 / CHUNK); cx <= Math.floor(r.x1 / CHUNK); cx++) {
              for (const f of src.chunkAt(cx, 0, cz).furniture) {
                const gx = cx * CHUNK + f.lx
                const gz = cz * CHUNK + f.lz
                if (f.kind === PROP_LOUNGER && gx >= r.x0 && gx <= r.x1 && gz >= r.z0 && gz <= r.z1) loungers++
              }
            }
          }
          expect(loungers, `towel chamber ${a.region} of tile ${tx},${tz}`).toBe(1)
        }
      }
      if (list.length) chamberSeen++
    }
    expect(chamberSeen).toBeGreaterThan(0)
    expect(ropeless).toBeLessThanOrEqual(1)
  })

  // The catalog stamp's approach corridor (structures/catalog/stamp.js step
  // 7) can run through grammar rock; tile.js sealMass walls it off. These
  // are the tiles where it once left open rock faces (review of the first
  // grammar); SLOW=1 sweeps 16×16 tiles × 3 storeys of four seeds (about
  // 15 s a seed).
  const LEAK_TILES = [[99, 4, -7], [99, 7, -1], [31337, 1, -3], [7, -4, -7], [7, 0, 3], [1, -2, -2], [1, 4, 7], [12345, -7, -1], [3735928559, 6, -4]]
  it('no open rock face anywhere a stamp carved (massLeakAudit 0 on the tiles that once leaked)', () => {
    for (const [seed, tx, tz] of LEAK_TILES) {
      const src = worldSource(seed, config)
      const a = massLeakAudit(src.chunkAt, tileBox(tx, tz), { gen, worldSeed: seed })
      expect(a.details.leaks, `seed ${seed} tile ${tx},${tz}`).toEqual([])
    }
  }, 60_000)

  it.runIf(SLOW)('SLOW: massLeakAudit 0 over 16×16 tiles × storeys −1..1 of four seeds', () => {
    for (const seed of [99, 31337, 7, 2024]) {
      const src = worldSource(seed, config, { cache: new Map() })
      const a = massLeakAudit(src.chunkAt, boxOfTiles(-8, -8, 7, 7), { gen, worldSeed: seed })
      expect({ leaks: a.details.leaks, seals: a.seals, ports: a.portViolations, see: a.seeThroughToSolid, thin: a.seeThroughThinMass }, `seed ${seed}`)
        .toEqual({ leaks: [], seals: 0, ports: 0, see: 0, thin: 0 })
    }
  }, 300_000)

  it('slices project clean and the plates lie: basin 12Ft/40Ft/300F by column, gallery 3 Ft, deck unlabelled', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      const vols = tileVolumes(seed, 0, 0)
      const labels = (cy) => new Set([0, 1, 2].flatMap((cx) => [0, 1, 2].map((cz) => src.chunkAt(cx, cy, cz).levelLabel)))
      const pit = pitOf(vols)
      const deep = anomalyAt(seed, bandKey(0, 0)) === 'deep'
      expect(deep).toBe(false)
      expect(labels(-1)).toEqual(new Set(['12Ft', '40Ft', '300F']))
      expect(pit).toBeTruthy()
      const nat = vols.find((v) => v.type === 'natatio')
      for (const c of nat?.chunks ?? []) expect(src.chunkAt(c.cx, 1, c.cz).levelLabel).toBe('3 Ft')
      for (let cz = 0; cz < 3; cz++) for (let cx = 0; cx < 3; cx++) expect(src.chunkAt(cx, 0, cz).levelLabel ?? null).toBeNull()
      for (const cy of [-1, 0, 1]) {
        for (let cz = 0; cz < 3; cz++) {
          for (let cx = 0; cx < 3; cx++) {
            const d = src.chunkAt(cx, cy, cz)
            if (d.structureUp) expect(catalogSliceErrors(d, d.structureUp, 'up')).toEqual([])
            if (d.structureDown) expect(catalogSliceErrors(d, d.structureDown, 'down')).toEqual([])
          }
        }
      }
      // The bake's chunks are exactly the footprint's 'tile' chunks.
      const bake = tileBakeAt(seed, bandKey(0, 0), config)
      const kept = []
      for (const cy of [-1, 0, 1]) for (let cz = 0; cz < 3; cz++) for (let cx = 0; cx < 3; cx++) if (footprint(seed, cx, cy, cz) === 'tile') kept.push(chunkKey3(cx, cy, cz))
      expect([...bake.chunks.keys()].sort()).toEqual(kept.sort())
      expect(bake.stats.untouchedKept).toBe(0)
    }
  })
})
