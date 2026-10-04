import { describe, expect, it } from 'vitest'
import { CHUNK, cIdx, hIdx, vIdx } from '../../../constants.js'
import { hash2i } from '../../../core/hash.js'
import { auditLayeredPatch } from '../../../audit.js'
import { resolveMapFamily } from '../../../mapFamily.js'
import { CELL_ROOM } from '../../../mapTypes.js'
import { makeTileCtx, tileBakeAt } from '../../../tiles/familyChunk.js'
import { cellWalkable } from '../../../tiles/holeMasks.js'
import { massLeakAudit } from '../../../tiles/seams.js'
import { lightField } from '../../../tiles/simulate.js'
import { solidChunk } from '../../../tiles/solidChunk.js'
import { TileCanvas } from '../../../tiles/TileCanvas.js'
import { tileWindow } from '../../../tiles/tileKey.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familyGenerator } from '../../generators.js'
import { familyExitHook, familySpawn, hookOf } from '../../hooks.js'
import { familyPlanner } from '../../planners.js'
import { proveReachable, windowConnectivity, worldSource } from '../../reach.js'
import { STRUCTURAL_COUNTERS, runFamilySuite } from '../../__tests__/familyHarness.js'
import {
  MUTATION_CLASSES,
  TILE,
  aisleOf,
  anomalyAt,
  bandKey,
  districtPlan,
  exitTileOf,
  footprint,
  isStairChunk,
  mutationAllowed,
  mutationClassAt,
  northPortOf,
  planSeedOf,
  ports,
  spawnCellsOf,
  westPortOf,
} from '../geometry.js'
import { DEPT, hallExitOf, hallLayout, routeLayout } from '../layout.js'
import { LOOP_PLATE, LOOP_TINT, WARM, vLamp } from '../district.js'

// The showroom family suite (spec §11.1, §12.3): W = 2×2 tiles × storeys
// −1..0; the decision-6 window is 4×3 tiles × −1..0.
runFamilySuite('showroom', {
  window: { tiles: [2, 2], storeys: [-1, 0] },
  connWindow: { tiles: [4, 3], storeys: [-1, 0] },
})

// --- showroom specifics (§12.3 Tests) ------------------------------------------------

const ID = 'showroom'
const config = forcedFamilyConfig(ID)
const profile = resolveMapFamily(config)
const gen = familyGenerator(ID)
const planner = familyPlanner(ID)
const SEEDS = [1, 0x5eed, 777]
const TC = TILE.w * CHUNK // 28 cells per tile side
const HALL = -1
const ROUTE = 0

const tileBox = (tx, tz, y0 = HALL, y1 = ROUTE) => ({ x0: tx * 2, z0: tz * 2, x1: tx * 2 + 1, z1: tz * 2 + 1, y0, y1 })
const boxOfTiles = (tx0, tz0, tx1, tz1, y0 = HALL, y1 = ROUTE) => ({ x0: tx0 * 2, z0: tz0 * 2, x1: tx1 * 2 + 1, z1: tz1 * 2 + 1, y0, y1 })

// A global cell's chunk data and local coordinates.
const at = (src, gx, cy, gz) => {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { d: src.chunkAt(cx, cy, cz), lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}
const walkable = (src, gx, cy, gz) => {
  const { d, lx, lz } = at(src, gx, cy, gz)
  return cellWalkable(d, lx, lz)
}
// The owner chunk's wall on V line gx (row gz) / H line gz (column gx).
const wallV = (src, gx, cy, gz) => {
  const { d, lx, lz } = at(src, gx, cy, gz)
  return d.wallV[vIdx(lx, lz)]
}
const wallH = (src, gx, cy, gz) => {
  const { d, lx, lz } = at(src, gx, cy, gz)
  return d.wallH[hIdx(lx, lz)]
}

// One tile baked on its own canvas (attempt 0): the canvas and the bake's
// result (its vignette plan included).
function bakeTile(seed, tx, tz) {
  const k = bandKey(tx, tz)
  const planSeed = planSeedOf(seed, k)
  const win = tileWindow(TILE, k)
  const canvas = new TileCanvas({
    family: ID, base: 'tower', version: config.version, worldSeed: seed, origin: k.origin, district: { dx: tx, dz: tz },
    keep: (cx, cy, cz) => cx >= win.cx0 && cx <= win.cx1 && cz >= win.cz0 && cz <= win.cz1 && cy >= k.cy0 && cy <= k.cy1 &&
      footprint(seed, cx, cy, cz) === 'tile',
    solidChunk: (cx, cy, cz) => solidChunk(seed, cx, cy, cz, config, ID, { district: { dx: tx, dz: tz } }),
  })
  const ctx = makeTileCtx(gen, profile, seed, config, k, canvas, { tileSeed: planSeed, planSeed, attempt: 0 })
  return { canvas, res: gen.bake(canvas, ctx) }
}

// A vignette's furniture relative to its rect corner, in a stable order.
function layoutOf(canvas, rect) {
  const items = []
  for (let gx = rect.x0; gx <= rect.x1; gx++) {
    for (let gz = rect.z0; gz <= rect.z1; gz++) {
      for (const { rec } of canvas.furnitureListAt(gx, ROUTE + 1, gz)) {
        items.push({ key: `${gx - rect.x0},${gz - rect.z0},${rec.kind},${rec.facing}`, ox: rec.x - canvas.cellLocal(gx) * 3, oz: rec.z - canvas.cellLocal(gz) * 3 })
      }
    }
  }
  return items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.ox - b.ox || a.oz - b.oz))
}
const sameLayout = (a, b) => a.length === b.length && a.every((p, i) => p.key === b[i].key && Math.abs(p.ox - b[i].ox) < 0.02 && Math.abs(p.oz - b[i].oz) < 0.02)

// The most often repeated vignette layout of tile (tx, tz) on the route
// storey: rooms grouped by space id, signed by size and furniture.
function maxRepeat(src, tx, tz) {
  const rooms = new Map()
  for (let cz = tz * 2; cz < tz * 2 + 2; cz++) {
    for (let cx = tx * 2; cx < tx * 2 + 2; cx++) {
      const d = src.chunkAt(cx, ROUTE, cz)
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const i = cIdx(lx, lz)
          if (d.cellKind[i] !== CELL_ROOM) continue
          const gx = cx * CHUNK + lx
          const gz = cz * CHUNK + lz
          let r = rooms.get(d.spaceId[i])
          if (!r) rooms.set(d.spaceId[i], (r = { x0: gx, z0: gz, x1: gx, z1: gz, items: [] }))
          r.x0 = Math.min(r.x0, gx)
          r.z0 = Math.min(r.z0, gz)
          r.x1 = Math.max(r.x1, gx)
          r.z1 = Math.max(r.z1, gz)
          for (const f of d.furniture) if (f.lx === lx && f.lz === lz) r.items.push([gx, gz, f.kind, f.facing])
        }
      }
    }
  }
  const sig = new Map()
  for (const r of rooms.values()) {
    const s = `${r.x1 - r.x0}x${r.z1 - r.z0}|${r.items.map(([gx, gz, k, f]) => `${gx - r.x0},${gz - r.z0},${k},${f}`).sort().join(';')}`
    sig.set(s, (sig.get(s) ?? 0) + 1)
  }
  return Math.max(...sig.values())
}

describe('showroom family (§12.3)', () => {
  it('tile, footprint and ports: 2×2 chunks × storeys −1..0; the hall\'s x seam and the route\'s z seam, each 2 wide at a cell hashed per seam', () => {
    expect(TILE).toMatchObject({ w: 2, d: 2, backend: 'band', H: 2, lo: -1, hi: 0, salt: 0x5a170007 })
    for (const [tx, tz] of [[0, 0], [-3, 2], [5, -7]]) {
      const k = bandKey(tx, tz)
      expect(k).toMatchObject({ band: 0, cy0: -1, cy1: 0, origin: { cx: tx * 2, cy: -1, cz: tz * 2 } })
      for (const cy of [HALL, ROUTE]) for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) expect(footprint(1, tx * 2 + dx, cy, tz * 2 + dz)).toBe('tile')
      for (const cy of [-2, 1, 5]) expect(footprint(1, tx * 2, cy, tz * 2)).toBe('solid')
      expect(ports(1, k, 'west', HALL)).toEqual(westPortOf(1, tx, tz))
      expect(ports(1, k, 'north', ROUTE)).toEqual(northPortOf(1, tx, tz))
      expect(ports(1, k, 'west', ROUTE)).toEqual([])
      expect(ports(1, k, 'north', HALL)).toEqual([])
    }
    // One 2-wide passage per seam, at a cell hashed per seam (most of the
    // 22 candidates occur; neighbouring seams differ often; mirror-free).
    for (const [side, cy] of [['west', HALL], ['north', ROUTE]]) {
      const a0s = new Set()
      let same = 0
      let mirror = 0
      for (let tz = -10; tz <= 10; tz++) {
        for (let tx = -10; tx <= 10; tx++) {
          const p = ports(1, { tx, tz }, side, cy)
          expect(p).toHaveLength(1)
          expect(p[0].a1).toBe(p[0].a0 + 1)
          expect(p[0].a0).toBeGreaterThanOrEqual(2)
          expect(p[0].a1).toBeLessThanOrEqual(24)
          a0s.add(p[0].a0)
          if (ports(1, { tx: tx + 1, tz }, side, cy)[0].a0 === p[0].a0) same++
          if (ports(1, { tx: -tx, tz: -tz }, side, cy)[0].a0 === p[0].a0) mirror++
        }
      }
      expect(a0s.size, side).toBeGreaterThanOrEqual(20)
      expect(same / 441, side).toBeLessThan(0.2)
      expect(mirror / 441, side).toBeLessThan(0.2)
    }
  })

  it('planner: no catalog volumes; stairs A and B are the cross-storey structures, and verticalOpeningAt marks exactly their chunks of the plan', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      expect(planner.structuresInTile(seed, bandKey(0, 0), profile, config)).toEqual([])
      expect(Object.isFrozen(planner.structuresInTile(seed, bandKey(3, -2), profile, config))).toBe(true)
      const where = new Set()
      for (const [tx, tz] of [[0, 0], [1, -1], [-2, 3], [4, 2]]) {
        const plan = districtPlan(seed, tx, tz)
        expect(plan.stairs).toHaveLength(2)
        for (const s of plan.stairs) where.add(`${s.chunk.cx},${s.chunk.cz}`)
        for (const cy of [HALL, ROUTE]) {
          for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
            const cx = tx * 2 + dx
            const cz = tz * 2 + dz
            const d = src.chunkAt(cx, cy, cz)
            const core = plan.stairs.some((s) => s.chunk.cx === dx && s.chunk.cz === dz)
            expect(isStairChunk(seed, cx, cz)).toBe(core)
            expect(!!d.stairUp, `stair up ${cx},${cy},${cz}`).toBe(core && cy === HALL)
            expect(!!d.stairDown, `stair down ${cx},${cy},${cz}`).toBe(core && cy === ROUTE)
            expect(planner.verticalOpeningAt(seed, cx, cz, cy, profile, config)).toBe(core && cy === HALL)
            expect(planner.structureAt(seed, cx, cz, cy, profile, config)).toBeNull()
          }
        }
      }
      // The stairs move with the plan: not always the same chunks.
      expect(where.size, `seed ${seed}`).toBeGreaterThan(1)
    }
  })

  it('a forced attempt-1 bake (new tileSeed, same planSeed) bakes clean: no kit or seam notes, one exit at the plan\'s fire exit', () => {
    for (const seed of SEEDS) {
      for (const [tx, tz] of [[0, 0], [2, 1], [-2, 0]]) {
        const k = bandKey(tx, tz)
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
        const fire = hallExitOf(seed, tx, tz)
        expect(ctx.exits).toEqual([{ gx: tx * TC + fire.gx, gz: tz * TC + fire.gz, cy: HALL }])
      }
    }
  })

  it('the route chains over 3 tiles: stair A → route → stair B → hall → checkouts → x seam → the next stair A; the route storeys meet only across z', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      const door = (tx, tz, s, cy) => {
        const st = districtPlan(seed, tx, tz).stairs[s]
        return { gx: tx * TC + st.door.x, gz: tz * TC + st.door.z, cy }
      }
      // Monotone: tiles 0..3 along tz 0, both storeys.
      const chain = proveReachable(src, door(0, 0, 0, ROUTE), door(3, 0, 0, ROUTE), boxOfTiles(0, 0, 3, 0))
      expect(chain.ok, `seed ${seed}: ${chain.reason}`).toBe(true)
      // The route storeys of neighbouring tiles never meet along x: the chain
      // runs through the hall storey and its x seam.
      expect(proveReachable(src, door(0, 0, 0, ROUTE), door(1, 0, 0, ROUTE), boxOfTiles(0, 0, 1, 0, ROUTE, ROUTE)).ok).toBe(false)
      const east = westPortOf(seed, 1, 0)[0]
      expect(proveReachable(src, door(0, 0, 1, HALL), { gx: TC, gz: east.a0, cy: HALL }, boxOfTiles(0, 0, 1, 0, HALL, HALL)).ok).toBe(true)
      // …and meet along z through the hashed passage.
      expect(proveReachable(src, door(0, 0, 0, ROUTE), door(0, 1, 0, ROUTE), boxOfTiles(0, 0, 0, 1, ROUTE, ROUTE)).ok).toBe(true)
      // Inside one tile: the route runs A → B on its own storey; B's foot
      // reaches the hall's fire exit; the west port the stair A foot.
      for (const [tx, tz] of [[0, 0], [1, -1], [2, 1]]) {
        const box = tileBox(tx, tz)
        expect(proveReachable(src, door(tx, tz, 0, ROUTE), door(tx, tz, 1, ROUTE), tileBox(tx, tz, ROUTE, ROUTE)).ok, `A→B ${tx},${tz}`).toBe(true)
        const fire = hallExitOf(seed, tx, tz)
        expect(proveReachable(src, door(tx, tz, 1, HALL), { gx: tx * TC + fire.gx, gz: tz * TC + fire.gz, cy: HALL }, box).ok, `B→exit ${tx},${tz}`).toBe(true)
        const west = westPortOf(seed, tx, tz)[0]
        expect(proveReachable(src, { gx: tx * TC, gz: tz * TC + west.a0, cy: HALL }, door(tx, tz, 0, HALL), box).ok, `west→A ${tx},${tz}`).toBe(true)
      }
    }
  })

  it('seam ports are symmetric: the hall storey crosses the x seam at its hashed port, the route storey the z seam at its own; every other seam cell is sealed', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const [tx, tz] of [[0, 0], [1, -1], [-3, 2]]) {
        const x0 = (tx + 1) * TC // the seam line between tile tx and tx + 1
        const px = westPortOf(seed, tx + 1, tz)[0]
        for (let z = 0; z < TC; z++) {
          const gz = tz * TC + z
          const port = z >= px.a0 && z <= px.a1
          for (const cy of [HALL, ROUTE]) {
            const open = port && cy === HALL
            expect(walkable(src, x0 - 1, cy, gz) && walkable(src, x0, cy, gz) && !wallV(src, x0, cy, gz), `x seam ${x0},${cy},${gz}`).toBe(open)
            if (!open) expect(walkable(src, x0 - 1, cy, gz) && walkable(src, x0, cy, gz), `sealed x seam ${x0},${cy},${gz}`).toBe(false)
          }
        }
        const z0 = (tz + 1) * TC // the seam line between tile tz and tz + 1
        const p = northPortOf(seed, tx, tz + 1)[0]
        for (let x = 0; x < TC; x++) {
          const gx = tx * TC + x
          const port = x >= p.a0 && x <= p.a1
          for (const cy of [HALL, ROUTE]) {
            const open = port && cy === ROUTE
            expect(walkable(src, gx, cy, z0 - 1) && walkable(src, gx, cy, z0) && !wallH(src, gx, cy, z0), `z seam ${gx},${cy},${z0}`).toBe(open)
            if (!open) expect(walkable(src, gx, cy, z0 - 1) && walkable(src, gx, cy, z0), `sealed z seam ${gx},${cy},${z0}`).toBe(false)
          }
        }
      }
    }
  })

  it('caps: ≤ 90 furniture pieces and ≤ 14 kinds per chunk; ≤ 12 lit lamps per chunk-storey and ≤ 72 within 60 u, by the lamp plan (no dead route tubes but the odd copy\'s)', () => {
    let maxPieces = 0
    let maxKinds = 0
    let tinted = 0
    const CW = CHUNK * 3
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      const litMemo = new Map()
      const lit = (cx, cy, cz) => {
        const key = `${cx},${cy},${cz}`
        if (!litMemo.has(key)) litMemo.set(key, src.chunkAt(cx, cy, cz).lamps.filter((l) => l.lit))
        return litMemo.get(key)
      }
      for (const cy of [HALL, ROUTE]) {
        for (let cz = -4; cz < 4; cz++) {
          for (let cx = -4; cx < 4; cx++) {
            const d = src.chunkAt(cx, cy, cz)
            maxPieces = Math.max(maxPieces, d.furniture.length)
            maxKinds = Math.max(maxKinds, new Set(d.furniture.map((f) => f.kind)).size)
            expect(lit(cx, cy, cz).length, `lit ${cx},${cy},${cz}`).toBeLessThanOrEqual(12)
            if (cy === ROUTE) tinted += d.lamps.filter((l) => l.tint === WARM).length
            // 60 u reach 1.43 chunks from a chunk centre: the inner centres'
            // circles stay inside the box.
            if (cx < -2 || cx > 1 || cz < -2 || cz > 1) continue
            let near = 0
            for (let nz = cz - 2; nz <= cz + 2; nz++) {
              for (let nx = cx - 2; nx <= cx + 2; nx++) {
                for (const l of lit(nx, cy, nz)) {
                  if (Math.hypot(nx * CW + (l.lx + 0.5) * 3 - (cx + 0.5) * CW, nz * CW + (l.lz + 0.5) * 3 - (cz + 0.5) * CW) <= 60) near++
                }
              }
            }
            expect(near, `lit within 60 u of ${cx},${cy},${cz}`).toBeLessThanOrEqual(72)
          }
        }
      }
      // The route storey has no dead tubes but the odd copy's (dark or walled).
      for (let tz = -2; tz < 2; tz++) {
        for (let tx = -2; tx < 2; tx++) {
          let dead = 0
          for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) dead += src.chunkAt(tx * 2 + dx, ROUTE, tz * 2 + dz).lamps.filter((l) => !l.lit).length
          const cls = mutationClassAt(seed, bandKey(tx, tz))
          expect(dead, `dead route tubes in ${tx},${tz}`).toBe(cls === 'dark' || cls === 'walled' ? 1 : 0)
        }
      }
    }
    expect(maxPieces).toBeLessThanOrEqual(90)
    expect(maxKinds).toBeLessThanOrEqual(14)
    expect(tinted).toBeGreaterThan(0)
  })

  it('day light: the route storey ≤ 0.05 dark, the hall storey (the dim warehouse included) ≤ 0.08', () => {
    for (const seed of SEEDS.slice(0, 2)) {
      const src = worldSource(seed, config)
      const box = { x0: 2, z0: -3, x1: 7, z1: 2 }
      expect(lightField(src, box, ROUTE).darkness, `route darkness, seed ${seed}`).toBeLessThanOrEqual(0.05)
      expect(lightField(src, box, HALL).darkness, `hall darkness, seed ${seed}`).toBeLessThanOrEqual(0.08)
    }
  })

  it('vignette runs stay exact: every copy of a run matches its master but the district\'s one odd copy, whose class rotates between neighbouring districts', () => {
    let odd = 0
    for (const [seed, t0] of [[1, -3], [0x5eed, 2]]) {
      for (let tz = t0; tz <= t0 + 3; tz++) {
        for (let tx = t0; tx <= t0 + 3; tx++) {
          const { canvas, res } = bakeTile(seed, tx, tz)
          const cls = mutationClassAt(seed, bandKey(tx, tz))
          const plain = res.vignettes.filter((v) => v.run >= 0)
          const mutants = plain.filter((v) => v.mutation)
          expect(mutants.length, `odd copies in ${seed}:${tx},${tz}`).toBe(cls ? 1 : 0)
          if (cls) expect(mutants[0].mutation).toBe(cls)
          for (const v of plain) {
            const master = res.vignettes[v.run]
            const same = sameLayout(layoutOf(canvas, v.rect), layoutOf(canvas, master.rect))
            const fixture = vLamp(v.rect, v.front)
            const lamp = canvas.lampAt(fixture.gx, ROUTE + 1, fixture.gz)?.rec
            expect(lamp?.tint, `fixture of ${seed}:${tx},${tz} ${v.rect.x0},${v.rect.z0}`).toBe(WARM)
            if (!v.mutation) {
              expect(same, `copy ${seed}:${tx},${tz} ${v.rect.x0},${v.rect.z0}`).toBe(true)
              expect(lamp.lit).toBe(true)
              continue
            }
            odd++
            expect(same).toBe(v.mutation === 'dark' || v.mutation === 'walled')
            expect(lamp.lit).toBe(!(v.mutation === 'dark' || v.mutation === 'walled'))
          }
          // Never the same class twice in a row.
          for (const [nx, nz] of [[tx + 1, tz], [tx, tz + 1]]) {
            const n = mutationClassAt(seed, bandKey(nx, nz))
            if (cls && n) expect(n, `${seed}: ${tx},${tz} → ${nx},${nz}`).not.toBe(cls)
          }
        }
      }
    }
    expect(odd).toBeGreaterThan(10)
    // Every class occurs; districts without one are rare.
    const seen = new Set()
    let none = 0
    let plain = 0
    for (let tz = -10; tz <= 10; tz++) {
      for (let tx = -10; tx <= 10; tx++) {
        const k = bandKey(tx, tz)
        if (Math.max(Math.abs(tx), Math.abs(tz)) <= 1 || anomalyAt(1, k) || (exitTileOf(1).tx === tx && tz === 0)) continue
        plain++
        const c = mutationClassAt(1, k)
        if (c) seen.add(c)
        else none++
      }
    }
    expect(seen).toEqual(new Set(MUTATION_CLASSES))
    expect(none / plain).toBeLessThan(0.01)
  })

  it('the loop\'s carrier: an exit-green fixture over the loop passage, in loop districts only', () => {
    const seed = SEEDS[0]
    const src = worldSource(seed, config)
    let loops = 0
    for (let tz = 1; tz <= 4; tz++) {
      for (let tx = 1; tx <= 5; tx++) {
        const loop = anomalyAt(seed, bandKey(tx, tz)) === 'loop'
        const R = routeLayout(seed, tx, tz)
        expect(!!R.loop, `loop passage ${tx},${tz}`).toBe(loop)
        let green = 0
        for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) green += src.chunkAt(tx * 2 + dx, ROUTE, tz * 2 + dz).lamps.filter((l) => l.lit && l.tint === LOOP_TINT).length
        expect(green, `loop glow ${tx},${tz}`).toBe(loop ? 1 : 0)
        if (loop) loops++
      }
    }
    expect(loops).toBeGreaterThan(0)
  })

  it('spawn at tile (0,0)\'s route entrance (stair A\'s door); exit at the hall\'s fire exit (cy −1) of tile (2 + hash % 3, 0)', () => {
    const hooks = hookOf(ID)
    expect(hooks.stub).toBe(false)
    const tiles = new Set()
    const doors = new Set()
    for (const seed of [...SEEDS, 4242, 99, 2, 3, 4]) {
      const sp = familySpawn(config, seed)
      const A = districtPlan(seed, 0, 0).stairs[0]
      expect(spawnCellsOf(seed)[0]).toEqual({ gx: A.door.x, gz: A.door.z })
      expect([sp.cx * CHUNK + sp.lx, sp.cz * CHUNK + sp.lz]).toEqual([A.door.x, A.door.z])
      doors.add(`${A.door.x},${A.door.z}`)
      const t = exitTileOf(seed)
      tiles.add(t.tx)
      expect(t.tz).toBe(0)
      expect(t.tx).toBeGreaterThanOrEqual(2)
      expect(t.tx).toBeLessThanOrEqual(4)
      const src = worldSource(seed, config)
      const ex = familyExitHook(config)({ worldSeed: seed, level: 1, config, profile, generate: src.chunkAt })
      expect(ex).toEqual(hooks.exitAnchor(seed, profile))
      expect(ex.cy).toBe(HALL)
      const fire = hallExitOf(seed, t.tx, t.tz)
      expect([ex.cx * CHUNK + ex.lx, ex.cz * CHUNK + ex.lz]).toEqual([t.tx * TC + fire.gx, fire.gz])
      const d = src.chunkAt(ex.cx, ex.cy, ex.cz)
      expect(d.furniture.filter((f) => f.lx === ex.lx && f.lz === ex.lz)).toEqual([])
      const box = hooks.proofBox(ex, sp)
      expect(box).toEqual({ chunks: { x0: 0, z0: 0, x1: t.tx * 2 + 1, z1: 1 }, cy: [-1, 0] })
      expect(anomalyAt(seed, bandKey(t.tx, t.tz))).toBeNull()
    }
    expect(tiles).toEqual(new Set([2, 3, 4]))
    expect(doors.size).toBeGreaterThan(1)
    expect(hooks.exitHookStats.lastResort).toBe(0)
  })

  it('anomalies: hashed per tile, about one district in three, rotated, never near spawn or in the exit tile; one odd copy elsewhere', () => {
    const maps = []
    for (const seed of [...SEEDS, 2, 3, 4, 5, 6]) {
      const ex = exitTileOf(seed)
      const anomaly = (tx, tz) => anomalyAt(seed, bandKey(tx, tz))
      let present = 0
      let cells = 0
      const classes = new Set()
      const sig = []
      for (let tz = -8; tz <= 8; tz++) {
        for (let tx = -8; tx <= 8; tx++) {
          const a = anomaly(tx, tz)
          sig.push(a ?? '-')
          if (Math.max(Math.abs(tx), Math.abs(tz)) <= 1 || (tx === ex.tx && tz === ex.tz)) {
            expect(a, `seed ${seed} tile ${tx},${tz}`).toBeNull()
            expect(mutationAllowed(seed, bandKey(tx, tz))).toBe(false)
            continue
          }
          cells++
          // An anomaly tile keeps no odd copy; a plain one keeps one unless
          // its four neighbours outrank it with all four classes (rare).
          if (a) expect(mutationAllowed(seed, bandKey(tx, tz))).toBe(false)
          if (!a) continue
          present++
          classes.add(a)
          expect(['loop', 'repeat']).toContain(a)
          for (const [nx, nz] of [[tx + 1, tz], [tx, tz + 1]]) if (anomaly(nx, nz)) expect(anomaly(nx, nz), `seed ${seed} ${tx},${tz}→${nx},${nz}`).not.toBe(a)
          expect(anomalyAt(seed, bandKey(tx, tz))).toBe(a)
        }
      }
      expect(present / cells, `seed ${seed} density`).toBeGreaterThan(0.25)
      expect(present / cells, `seed ${seed} density`).toBeLessThan(0.45)
      expect(classes).toEqual(new Set(['loop', 'repeat']))
      maps.push(sig.join(''))
    }
    expect(new Set(maps).size).toBe(maps.length)
    // One district, one anomaly: a plain tile keeps exactly one odd copy; the
    // spawn ring, the exit tile and the anomaly tiles none.
    const seed = SEEDS[0]
    for (let tz = -3; tz <= 3; tz++) {
      for (let tx = -3; tx <= 3; tx++) {
        const k = bandKey(tx, tz)
        const odd = tileBakeAt(seed, k, config).notes.filter((n) => n.startsWith('mutation at')).length
        expect(odd, `odd copies in ${tx},${tz}`).toBe(mutationAllowed(seed, k) ? 1 : 0)
      }
    }
  })

  it('anomalies in the world: the loop opens a 2-wide link across the serpentine, the repetition never closes, and both keep the store sealed and connected', () => {
    const seed = SEEDS[0]
    const src = worldSource(seed, config)
    // Tiles 2..5 × 1..4 of seed 1 hold both classes (none is the exit tile).
    const inner = boxOfTiles(2, 1, 5, 4)
    const outer = boxOfTiles(1, 0, 6, 5)
    const found = []
    for (let tz = 1; tz <= 4; tz++) for (let tx = 2; tx <= 5; tx++) found.push({ tx, tz, kind: anomalyAt(seed, bandKey(tx, tz)) })
    expect(new Set(found.map((f) => f.kind).filter(Boolean))).toEqual(new Set(['loop', 'repeat']))
    const A = districtPlan(seed, 3, 1).stairs[0]
    const res = windowConnectivity(src, inner, outer, { gx: 3 * TC + A.door.x, gz: TC + A.door.z, cy: ROUTE })
    expect({ ok: res.ok, reason: res.reason, stranded: res.stranded, sealed: res.sealed }).toEqual({ ok: true, reason: null, stranded: [], sealed: [] })
    const audit = massLeakAudit(src.chunkAt, outer, { gen, worldSeed: seed })
    expect(audit.details).toEqual({ leaks: [], seals: [], portViolations: [], seeThroughToSolid: [], seeThroughThinMass: [] })
    const lay = auditLayeredPatch(src.chunkAt, inner.x0, HALL, inner.z0, inner.x1 - inner.x0 + 1, 2, inner.z1 - inner.z0 + 1)
    expect(Object.fromEntries(STRUCTURAL_COUNTERS.filter((c) => lay[c]).map((c) => [c, lay[c]]))).toEqual({})
    for (const { tx, tz, kind } of found) {
      const R = routeLayout(seed, tx, tz)
      if (kind === 'loop') {
        // Two parallel links, each walkable end to end on the route storey,
        // saving ≥ 8 steps of the serpentine.
        expect(R.loop.parts).toHaveLength(2)
        expect(R.loop.saving).toBeGreaterThanOrEqual(8)
        for (const part of R.loop.parts) {
          const cells = [part.ends[0], ...part.cells, part.ends[1]].map((k) => ({ gx: tx * TC + (k % 28), gz: tz * TC + Math.floor(k / 28), cy: ROUTE }))
          for (const c of cells) expect(walkable(src, c.gx, ROUTE, c.gz), `loop cell ${c.gx},${c.gz}`).toBe(true)
          for (let i = 1; i < cells.length; i++) {
            const [a, b] = [cells[i - 1], cells[i]]
            const wall = a.gx !== b.gx ? wallV(src, Math.max(a.gx, b.gx), ROUTE, a.gz) : wallH(src, a.gx, ROUTE, Math.max(a.gz, b.gz))
            expect(wall, `loop step ${a.gx},${a.gz}→${b.gx},${b.gz}`).toBe(0)
          }
        }
      } else expect(R.loop).toBeNull()
      // The repetition: one room set throughout, every run exact to its
      // master (no odd copy); elsewhere the sets vary and runs close.
      const { canvas, res: baked } = bakeTile(seed, tx, tz)
      const plain = baked.vignettes.filter((v) => v.run >= 0)
      const roles = new Set(plain.map((v) => v.role))
      if (kind === 'repeat') {
        expect(roles.size, `one set in ${tx},${tz}`).toBe(1)
        expect(plain.filter((v) => v.mutation)).toEqual([])
        for (const v of plain) expect(sameLayout(layoutOf(canvas, v.rect), layoutOf(canvas, baked.vignettes[v.run].rect)), `copy ${tx},${tz} ${v.rect.x0},${v.rect.z0}`).toBe(true)
        expect(maxRepeat(src, tx, tz), `repetition in tile ${tx},${tz}`).toBeGreaterThanOrEqual(3)
      } else expect(roles.size, `sets in ${tx},${tz}`).toBeGreaterThan(1)
      const notes = tileBakeAt(seed, bandKey(tx, tz), config).notes
      expect(notes.includes(`anomaly: ${kind}`)).toBe(!!kind)
    }
  })

  it('plates: the route reads oPEn (oUt at a loop district\'s stair A), the hall HALL, the warehouse its district\'s aisle number', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      const numbers = new Set()
      for (const [tx, tz] of [[0, 0], [1, 0], [-2, 3], [4, -1], [4, 2], [1, 3]]) {
        const aisle = aisleOf(seed, tx, tz)
        expect(aisle).toMatch(/^[1-9][0-9][0-9]$/)
        numbers.add(aisle)
        const loop = anomalyAt(seed, bandKey(tx, tz)) === 'loop' && !!routeLayout(seed, tx, tz).loop
        const A = districtPlan(seed, tx, tz).stairs[0].chunk
        const ware = hallLayout(seed, tx, tz).depts.find((d) => d.type === DEPT.WARE)?.leaf
        const wareChunk = ware && { cx: Math.floor(((ware.x0 + ware.x1) >> 1) / CHUNK), cz: Math.floor(((ware.z0 + ware.z1) >> 1) / CHUNK) }
        for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const atA = loop && A.cx === dx && A.cz === dz
          expect(src.chunkAt(tx * 2 + dx, ROUTE, tz * 2 + dz).levelLabel, `route plate ${tx},${tz}:${dx},${dz}`).toBe(atA ? LOOP_PLATE : 'oPEn')
          const atWare = wareChunk && wareChunk.cx === dx && wareChunk.cz === dz
          expect(src.chunkAt(tx * 2 + dx, HALL, tz * 2 + dz).levelLabel, `hall plate ${tx},${tz}:${dx},${dz}`).toBe(atWare ? aisle : 'HALL')
        }
      }
      expect(numbers.size).toBeGreaterThan(1)
    }
  })

  it('generated, not copied: over 12 tiles per storey, the walls and columns of any two tiles share ≤ 0.45 (Jaccard), ≤ 0.25 on average', () => {
    const seed = 12345
    const src = worldSource(seed, config)
    const setOf = (tx, tz, cy) => {
      const s = new Set()
      for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const d = src.chunkAt(tx * 2 + dx, cy, tz * 2 + dz)
        for (let i = 0; i < CHUNK * CHUNK; i++) {
          if (d.wallV[i]) s.add(`v${dx},${dz},${i}`)
          if (d.wallH[i]) s.add(`h${dx},${dz},${i}`)
          if (d.cols[i]) s.add(`c${dx},${dz},${i}:${d.cols[i]}`)
        }
      }
      return s
    }
    const jaccard = (a, b) => {
      let n = 0
      for (const x of a) if (b.has(x)) n++
      return n / (a.size + b.size - n || 1)
    }
    for (const cy of [ROUTE, HALL]) {
      const sets = []
      for (let a = 0; a < 4; a++) for (let b = 0; b < 3; b++) sets.push(setOf(a * 3 + 1, b * 3 + 1, cy))
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
      expect(sum / n, `mean, storey ${cy}`).toBeLessThanOrEqual(0.25)
      expect(max, `max, storey ${cy}`).toBeLessThanOrEqual(0.45)
    }
  })

  it('shortcuts: unlit links across the serpentine, 2–4 in most districts, each saving ≥ a sixth of the route (a fifth on the first pass), sealed along their sides', () => {
    let twoPlus = 0
    let total = 0
    const savings = []
    const W = TC // layout grids are tile-wide (N + 1 = 28)
    for (const seed of SEEDS) {
      for (let tz = -3; tz <= 3; tz++) {
        for (let tx = -3; tx <= 3; tx++) {
          const R = routeLayout(seed, tx, tz)
          total++
          if (R.shortcuts.length >= 2) twoPlus++
          expect(R.shortcuts.length).toBeLessThanOrEqual(4)
          for (const c of R.shortcuts) {
            savings.push(c.saving)
            expect(c.saving, `${seed}:${tx},${tz}`).toBeGreaterThanOrEqual(Math.max(10, Math.round(R.routeLen / 6)))
            if (c.type === 'gap') continue
            // A cut or a one-turn cut: a 4-connected path of unlit cut cells
            // from one lane end to the other.
            const path = [c.ends[0], ...c.cells, c.ends[1]]
            for (let n = 1; n < path.length; n++) {
              const [a, b] = [path[n - 1], path[n]]
              expect(Math.abs((a % W) - (b % W)) + Math.abs(Math.floor(a / W) - Math.floor(b / W)), `${seed}:${tx},${tz}`).toBe(1)
            }
            for (const k of c.cells) expect(R.kind[k]).toBe(5) // K_CUT
          }
          const notes = tileBakeAt(seed, bandKey(tx, tz), config).notes
          expect(notes.filter((n) => n.startsWith('shortcut ')).length).toBe(R.shortcuts.length)
        }
      }
    }
    expect(twoPlus / total).toBeGreaterThan(0.8)
    savings.sort((a, b) => a - b)
    expect(savings[savings.length >> 1]).toBeGreaterThanOrEqual(30) // §12: median saving ≥ 30
  })

  it('§4.4/§12 measures on the route storey: vignettes 3×3 to 4×5, 13–14 at most per district, the route ≥ 0.4 of the floor on the median', () => {
    const shares = []
    for (const seed of SEEDS) {
      for (let tz = -4; tz <= 4; tz++) {
        for (let tx = -4; tx <= 4; tx++) {
          const R = routeLayout(seed, tx, tz)
          expect(R.vignettes.length, `${seed}:${tx},${tz}`).toBeLessThanOrEqual(14)
          expect(R.vignettes.length).toBeGreaterThanOrEqual(8)
          for (const v of R.vignettes) {
            const w = v.rect.x1 - v.rect.x0 + 1
            const d = v.rect.z1 - v.rect.z0 + 1
            expect(Math.min(w, d), `${seed}:${tx},${tz} ${w}×${d}`).toBeGreaterThanOrEqual(3)
            expect(Math.min(w, d), `${seed}:${tx},${tz} ${w}×${d}`).toBeLessThanOrEqual(4)
            expect(Math.max(w, d), `${seed}:${tx},${tz} ${w}×${d}`).toBeLessThanOrEqual(5)
          }
          let lane = 0
          let walk = 0
          for (let k = 0; k < R.kind.length; k++) {
            if (R.kind[k] === 0) continue
            walk++
            if (R.kind[k] === 1 || R.kind[k] === 2) lane++
          }
          shares.push(lane / walk)
        }
      }
    }
    shares.sort((a, b) => a - b)
    expect(shares[shares.length >> 1]).toBeGreaterThanOrEqual(0.4)
    expect(shares[shares.length >> 1]).toBeLessThanOrEqual(0.6)
  })

  it('baked chunks over many seeds and far tiles: the in-tile chain holds (A → B on the route, B → east port and fire exit, west port → A in the hall) and every N and W port cell is walkable on both sides', () => {
    const tiles = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [-99, -99], [100, 37], [-61, 140], [7, -200], [190, 5]]
    let n = 0
    for (let s = 0; s < 24; s++) {
      const seed = (Math.imul(0x9e3779b1, s + 1) ^ 0x5eed) >>> 0
      const src = worldSource(seed, config, { cache: new Map() })
      const seeds = s === 0 ? [[3337620049, 0, 0], [99, -99, -99], [3998633697, 49, 14], [377070548, 41, 194]] : []
      for (const [sd, tx, tz] of [...seeds, ...tiles.map(([a, b]) => [seed, a, b])]) {
        const w = sd === seed ? src : worldSource(sd, config, { cache: new Map() })
        const ox = tx * TC
        const oz = tz * TC
        const P = districtPlan(sd, tx, tz)
        const [A, B] = P.stairs
        const box = { chunks: { x0: tx * 2, z0: tz * 2, x1: tx * 2 + 1, z1: tz * 2 + 1 }, cy: [HALL, ROUTE] }
        const g = (c, cy) => ({ gx: ox + c.x, gz: oz + c.z, cy })
        const ex = hallExitOf(sd, tx, tz)
        const legs = [
          [g(A.door, ROUTE), g(B.door, ROUTE)],
          [g(B.door, HALL), { gx: ox + TC - 1, gz: oz + P.ports.east[0].a0, cy: HALL }],
          [g(B.door, HALL), { gx: ox + ex.gx, gz: oz + ex.gz, cy: HALL }],
          [{ gx: ox, gz: oz + westPortOf(sd, tx, tz)[0].a0, cy: HALL }, g(A.door, HALL)],
        ]
        for (const [from, to] of legs) expect(proveReachable(w, from, to, box).ok, `${sd}:${tx},${tz} ${JSON.stringify(from)}→${JSON.stringify(to)}`).toBe(true)
        for (const p of northPortOf(sd, tx, tz)) {
          for (let a = p.a0; a <= p.a1; a++) {
            expect(walkable(w, ox + a, ROUTE, oz) && walkable(w, ox + a, ROUTE, oz - 1), `${sd}:${tx},${tz} north ${a}`).toBe(true)
          }
        }
        for (const p of westPortOf(sd, tx, tz)) {
          for (let a = p.a0; a <= p.a1; a++) {
            expect(walkable(w, ox, HALL, oz + a) && walkable(w, ox - 1, HALL, oz + a), `${sd}:${tx},${tz} west ${a}`).toBe(true)
          }
        }
        n++
      }
    }
    expect(n).toBe(244)
  }, 120000)
})
