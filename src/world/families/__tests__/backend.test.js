import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHUNK, cIdx, chunkKey3 } from '../../constants.js'
import { generateChunk } from '../../generate.js'
import { MAP_FAMILY_CODES, resolveMapFamily } from '../../mapFamily.js'
import { DEFAULT_WORLD_CONFIG } from '../../config.js'
import { CELL_ROOM, CELL_VOID, COLUMN_FURNITURE, COLUMN_STANDARD } from '../../mapTypes.js'
import { auditLayeredPatch } from '../../audit.js'
import { analyzeCatalogDescriptor, assembleCatalogDescriptor } from '../../structures/catalog/engine.js'
import { catalogSliceErrors } from '../../structures/catalog/audit.js'
import { LIMINAL_FAMILY_IDS } from '../ids.js'
import { familyGenerator } from '../generators.js'
import { forcedFamilyConfig } from '../forced.js'
import { FloorPlan } from '../../tiles/floorPlan.js'
import { isSolidMassChunk } from '../../tiles/solidChunk.js'
import {
  bakeExitsAt,
  bakeStats,
  bakeTile,
  buildFamilyChunk,
  configSignature,
  makeTileCtx,
  prebakeTile,
  tileBakeAt,
  tileCache,
  wouldBakeChunk,
} from '../../tiles/familyChunk.js'
import { bakeStats as cacheBakeStats, lruCapacityOf } from '../../tiles/tileCache.js'
import { TileCanvas } from '../../tiles/TileCanvas.js'
import {
  FAMILY_SALT,
  LOCAL_SPACE_MASK,
  hashChain,
  STRUCTURE_ID_BIT,
  keyString,
  planPick,
  spaceIdOf,
  spaceSlot,
  structureId,
  tileKeyAt,
  tileKeyOf,
  tileSeed,
  tileShape,
} from '../../tiles/tileKey.js'
import { chunkPrint, plannerKeySweep, plannerRuleErrors } from './familyHarness.js'
import { familySpawn, hookOf } from '../hooks.js'
import { STUB_WORLD_ID } from './stubWorld.js'

// The tile backend (spec §6.2, §6.6, §6.7): keys and ids, the bake (plan
// seed, retries, finish remap, furniture off-switch), the cache and its
// gates, and the chunk branch. Private test generators drive the bake; a
// planner override (below) supplies a stub catalog volume.

const override = vi.hoisted(() => ({ planners: {} }))
// STUB_WORLD_ID runs the §12.0 stub program here whatever its real family
// has become (./stubWorld.js); the per-test planner override wins first.
vi.mock('../planners.js', (orig) =>
  import('./stubWorld.js').then((m) => m.mockPlanners(orig, { lookup: (id) => override.planners[id] })))
vi.mock('../generators.js', (orig) => import('./stubWorld.js').then((m) => m.mockGenerators(orig)))

afterEach(() => {
  override.planners = {}
  tileCache.setCapacityOverride(null)
  tileCache.clear()
})

const STUB = STUB_WORLD_ID
const stubConfig = forcedFamilyConfig(STUB)
const stubProfile = resolveMapFamily(stubConfig)

// A private test generator: 2×1-chunk tiles, two storeys, footprint 'tile'.
const TILE2 = Object.freeze({ w: 2, d: 1, backend: 'band', H: 2, lo: 0, hi: 1, salt: FAMILY_SALT.poolrooms })
function testGen(bake, extra = {}) {
  return Object.freeze({
    family: 'test',
    ready: true,
    stub: true,
    tile: TILE2,
    footprint: () => 'tile',
    ports: () => [],
    exitAnchor: () => ({ cx: 0, cy: 0, cz: 0, lx: 6, lz: 6 }),
    paramsFor: () => ({}),
    bake,
    ...extra,
  })
}

// Compile one room (local space id `id`) over both chunks on every storey.
function roomTile(canvas, ctx, id = 1) {
  for (let cy = ctx.cy0; cy <= ctx.cy1; cy++) {
    const plan = new FloorPlan({ x0: 0, z0: 0, x1: 2 * CHUNK - 1, z1: CHUNK - 1 })
    plan.rect({ x0: 1, z0: 1, x1: 2 * CHUNK - 2, z1: CHUNK - 2 }, CELL_ROOM, id)
    plan.compile(canvas, cy - ctx.origin.cy)
  }
}

describe('tile keys, seeds and ids (§6.2)', () => {
  it('FAMILY_SALT is 0x5a170000 + code for the 12, and the stub tiles carry it', () => {
    expect(Object.keys(FAMILY_SALT)).toEqual([...LIMINAL_FAMILY_IDS])
    for (const id of LIMINAL_FAMILY_IDS) {
      expect(FAMILY_SALT[id]).toBe(0x5a170000 + MAP_FAMILY_CODES[id])
      expect(familyGenerator(id).tile.salt).toBe(FAMILY_SALT[id])
    }
    expect(Object.isFrozen(FAMILY_SALT)).toBe(true)
  })

  it('tileKeyOf: storey and band backends, phase, clamping, rows', () => {
    const storey = { w: 4, d: 4, backend: 'storey', H: 1, lo: -Infinity, hi: Infinity }
    expect(tileKeyOf(storey, -1, -7, 5)).toEqual({ tx: -1, tz: 1, band: -7, origin: { cx: -4, cy: -7, cz: 4 }, cy0: -7, cy1: -7 })
    const band = { w: 2, d: 2, backend: 'band', H: 5, lo: -Infinity, hi: Infinity, phase: (tx, tz) => ((tx + 2 * tz) % 5 + 5) % 5 }
    const k = tileKeyOf(band, 3, 4, -1)
    // tx 1, tz -1 → phase ((1 - 2) mod 5) = 4; band floor((4 - 0 - 4) / 5) = 0.
    expect(k).toEqual({ tx: 1, tz: -1, band: 0, origin: { cx: 2, cy: 4, cz: -2 }, cy0: 4, cy1: 8 })
    const clamped = { w: 3, d: 3, backend: 'band', H: 3, lo: -1, hi: 1 }
    expect(tileKeyOf(clamped, 0, 1, 0)).toMatchObject({ band: 0, cy0: -1, cy1: 1, origin: { cy: -1 } })
    expect(tileKeyOf(clamped, 0, 2, 0)).toBeNull()
    expect(tileKeyOf(clamped, 0, -2, 0)).toBeNull()
    const phased = { w: 1, d: 1, backend: 'band', H: 2, lo: 0, hi: 3, phase: () => 1 }
    // band −1 starts at storey −1 < lo: cy0 is clamped to lo.
    expect(tileKeyOf(phased, 0, 0, 0)).toMatchObject({ band: -1, cy0: 0, cy1: 0, origin: { cy: -1 } })
    const rows = { w: 1, d: 1, backend: 'band', H: 1, lo: 0, hi: 0, rows: [0, 2] }
    expect(tileKeyOf(rows, 5, 0, 1)).toBeNull()
    expect(tileKeyOf(rows, 5, 0, 2)).toMatchObject({ tx: 5, tz: 2 })
  })

  it('TILE defaults: H = 1, lo = −∞, hi = ∞ are applied; a malformed TILE throws', () => {
    // babel-shaped, unbounded storeys (§12.5): no lo/hi at all.
    const phase = (tx, tz) => ((tx + 2 * tz) % 5 + 5) % 5
    const open = { w: 2, d: 2, backend: 'band', H: 5, phase }
    const full = { ...open, lo: -Infinity, hi: Infinity }
    for (const [cx, cy, cz] of [[0, 0, 0], [3, 4, -1], [-5, -13, 7], [9, 22, 3]]) {
      expect(tileKeyOf(open, cx, cy, cz)).toEqual(tileKeyOf(full, cx, cy, cz))
      const k = tileKeyOf(open, cx, cy, cz)
      expect(Number.isInteger(k.band) && Number.isInteger(k.cy0) && Number.isInteger(k.cy1)).toBe(true)
      expect(tileKeyAt(open, k.tx, k.tz, k.band)).toEqual(k)
    }
    // No H: one storey per band.
    const noH = { w: 1, d: 1, backend: 'band', lo: 0, hi: 3 }
    expect(tileKeyOf(noH, 0, 2, 0)).toEqual({ tx: 0, tz: 0, band: 2, origin: { cx: 0, cy: 2, cz: 0 }, cy0: 2, cy1: 2 })
    expect(tileKeyAt(noH, 0, 0, 2)).toEqual(tileKeyOf(noH, 0, 2, 0))
    expect(tileKeyAt(noH, 0, 0, 4)).toBeNull()
    expect(tileKeyOf({ w: 1, d: 1, backend: 'storey' }, 0, -40, 0)).toMatchObject({ band: -40, cy0: -40, cy1: -40 })
    expect(tileShape({ w: 1, d: 1 })).toEqual({ H: 1, lo: -Infinity, hi: Infinity, anchor: 0 })
    expect(tileShape({ w: 1, d: 1, lo: -2, hi: 1, H: 2 })).toEqual({ H: 2, lo: -2, hi: 1, anchor: -2 })
    for (const bad of [{ H: 0 }, { H: 2.5 }, { H: NaN }, { lo: 'x' }, { hi: NaN }, { lo: 2, hi: 1 }]) {
      expect(() => tileKeyOf({ w: 1, d: 1, backend: 'band', ...bad }, 0, 0, 0), JSON.stringify(bad)).toThrow(/tileKey: TILE/)
      expect(() => tileKeyAt({ w: 1, d: 1, backend: 'band', ...bad }, 0, 0, 0)).toThrow(/tileKey: TILE/)
    }
  })

  it('tileKeyAt inverts tileKeyOf', () => {
    const tiles = [
      { w: 4, d: 4, backend: 'storey', H: 1, lo: -Infinity, hi: Infinity },
      { w: 2, d: 2, backend: 'band', H: 5, lo: -Infinity, hi: Infinity, phase: (tx, tz) => ((tx + 2 * tz) % 5 + 5) % 5 },
      { w: 3, d: 3, backend: 'band', H: 3, lo: -1, hi: 1 },
    ]
    for (const tile of tiles) {
      for (let cy = -6; cy <= 6; cy++) {
        for (const [cx, cz] of [[0, 0], [5, -3], [-7, 9]]) {
          const k = tileKeyOf(tile, cx, cy, cz)
          if (k) expect(tileKeyAt(tile, k.tx, k.tz, k.band)).toEqual(k)
        }
      }
    }
    expect(tileKeyAt(tiles[2], 0, 0, 1)).toBeNull()
  })

  it('space ids are unique in a 32×32-tile window × both band parities; structure ids are disjoint', () => {
    const seen = new Set()
    const locals = [1, 2, 0x7ff, LOCAL_SPACE_MASK]
    for (let tz = -16; tz < 16; tz++) {
      for (let tx = -16; tx < 16; tx++) {
        for (const band of [-3, 4]) {
          const k = { tx, tz, band }
          expect(spaceSlot(k)).toBeGreaterThanOrEqual(0)
          expect(spaceSlot(k)).toBeLessThan(2048)
          for (const local of locals) {
            const id = spaceIdOf(k, local)
            expect(id).toBeGreaterThanOrEqual(1)
            expect(id).toBeLessThanOrEqual(0x7fffffff)
            expect(seen.has(id)).toBe(false)
            seen.add(id)
          }
        }
      }
    }
    expect(seen.size).toBe(32 * 32 * 2 * locals.length)
    const k = { tx: 3, tz: -2, band: 1 }
    const ids = new Set()
    for (let slot = 0; slot < 64; slot++) {
      const id = structureId(12345, 'poolrooms', k, slot)
      expect(id).toBeGreaterThanOrEqual(STRUCTURE_ID_BIT)
      expect(id).toBeLessThanOrEqual(0xffffffff)
      ids.add(id)
    }
    expect(ids.size).toBe(64)
    expect(structureId(12345, 'poolrooms', k, 0)).toBe(structureId(12345, 'poolrooms', { ...k }, 0))
    expect(structureId(12345, 'babel', k, 0)).not.toBe(structureId(12345, 'poolrooms', k, 0))
    expect(() => structureId(1, 'office', k, 0)).toThrow(/FAMILY_SALT/)
    // Unique by construction in any 32×32-tile, 8-band window (P-fix): here
    // one straddling the tx/tz/band >> 5/3 boundaries, 4 slots, both seed
    // parities; and no mirror pair (tx, tz) / (−tx, −tz) shares an id.
    for (const seed of [2, 7]) {
      const win = new Set()
      for (let tx = -13; tx < 19; tx++) {
        for (let tz = 17; tz < 49; tz++) {
          for (let band = -3; band < 5; band++) {
            for (let slot = 0; slot < 4; slot++) win.add(structureId(seed, 'terminal', { tx, tz, band }, slot))
          }
        }
      }
      expect(win.size).toBe(32 * 32 * 8 * 4)
      for (let tx = -40; tx <= 40; tx++) {
        for (let tz = 1; tz <= 40; tz++) {
          for (const band of [0, 1]) {
            expect(structureId(seed, 'poolrooms', { tx, tz, band }, 0))
              .not.toBe(structureId(seed, 'poolrooms', { tx: -tx, tz: -tz, band }, 0))
          }
        }
      }
    }
  })

  it('hashChain: pure, uint32, order-sensitive and free of the (x, z) / (−x, −z) mirror', () => {
    expect(hashChain(5, 1, 2)).toBe(hashChain(5, 1, 2))
    expect(hashChain(5, 1, 2)).not.toBe(hashChain(5, 2, 1))
    expect(hashChain(5, 1, 2)).not.toBe(hashChain(5, 1, 2, 0))
    let mirrored = 0
    for (let s = 0; s < 32; s++) {
      for (let x = -8; x <= 8; x++) {
        for (let z = -8; z <= 8; z++) {
          const h = hashChain(s, x, z)
          expect(Number.isInteger(h) && h >= 0 && h <= 0xffffffff).toBe(true)
          if ((x || z) && h === hashChain(s, -x, -z)) mirrored++
        }
      }
    }
    expect(mirrored).toBe(0)
  })

  it('planPick, tileSeed and keyString are pure', () => {
    const a = planPick(99, 2, 1)
    const b = planPick(99, 2, 1)
    const rolls = Array.from({ length: 20 }, () => a(7))
    expect(Array.from({ length: 20 }, () => b(7))).toEqual(rolls)
    expect(rolls.every((r) => Number.isInteger(r) && r >= 0 && r < 7)).toBe(true)
    expect(tileSeed(5, 9, { tx: 1, tz: 2, band: 3 })).toBe(tileSeed(5, 9, { tx: 1, tz: 2, band: 3 }))
    expect(tileSeed(5, 9, { tx: 1, tz: 2, band: 3 })).not.toBe(tileSeed(5, 9, { tx: 1, tz: 2, band: 4 }))
    expect(keyString('babel', -1, 'sig', { tx: 1, tz: -2, band: 3 })).toBe('babel|4294967295|sig|1,-2,3')
  })
})

describe('the bake (§6.6)', () => {
  it('bake ctx: §6.5 fields, ports per side, fixed plan seed, per-attempt tile seeds', () => {
    const seen = []
    const gen = testGen((canvas, ctx) => {
      seen.push({ tileSeed: ctx.tileSeed, planSeed: ctx.planSeed, attempt: ctx.attempt })
      if (ctx.attempt < 2) return { error: `nope ${ctx.attempt}` }
      roomTile(canvas, ctx)
      return {}
    }, {
      ports: (seed, k, side, cy) => [{ a0: k.tx * 10 + (side === 'west' ? 1 : 2), a1: cy }],
    })
    const config = forcedFamilyConfig('poolrooms')
    const profile = resolveMapFamily(config)
    const k = tileKeyOf(TILE2, 2, 0, -1)
    const canvas = new TileCanvas({ family: 'poolrooms', origin: k.origin, worldSeed: 3 })
    const ctx = makeTileCtx(gen, profile, 3, config, k, canvas, { tileSeed: 11, planSeed: 10 })
    expect(ctx).toMatchObject({
      mode: 'tile', family: 'poolrooms', worldSeed: 3, key: { tx: 1, tz: -1, band: 0 },
      origin: { cx: 2, cy: 0, cz: -1 }, cy0: 0, cy1: 1, tileSeed: 11, planSeed: 10, attempt: 0,
      window: { cx0: 2, cz0: -1, cx1: 3, cz1: -1 }, furniture: true, exits: [], spawns: [], notes: [],
      anchor: { cx: 0, cy: 0, cz: 0, lx: 6, lz: 6 }, atriumAsCatalog: null,
    })
    expect(ctx.record.id).toBe('poolrooms')
    expect(Object.keys(ctx.kit).sort()).toEqual(['atrium', 'catalog', 'customCatalog', 'stairs', 'stairwell'])
    expect(ctx.portsAt('west', 1)).toEqual([{ a0: 11, a1: 1 }])
    expect(ctx.portsAt('north', 0)).toEqual([{ a0: 12, a1: 0 }])
    expect(ctx.portsAt('east', 0)).toEqual([{ a0: 21, a1: 0 }]) // tile tx+1's west
    expect(ctx.portsAt('south', 0)).toEqual([{ a0: 12, a1: 0 }]) // tile tz+1's north
    const before = bakeStats.count
    const bake = bakeTile(gen, profile, 3, config, k)
    expect(bakeStats.count).toBe(before + 1)
    expect(bake.attempts).toBe(3)
    expect(bake.fallback).toBe(false)
    expect(seen.map((s) => s.attempt)).toEqual([0, 1, 2])
    expect(new Set(seen.map((s) => s.planSeed)).size).toBe(1)
    expect(seen[0].tileSeed).toBe(seen[0].planSeed)
    expect(seen[0].planSeed).toBe(tileSeed(3, TILE2.salt, k))
    expect(new Set(seen.map((s) => s.tileSeed)).size).toBe(3)
    expect(Object.isFrozen(bake)).toBe(true)
    expect(Object.isFrozen(bake.exits)).toBe(true)
    expect([...bake.chunks.keys()].sort()).toEqual([chunkKey3(2, 0, -1), chunkKey3(2, 1, -1), chunkKey3(3, 0, -1), chunkKey3(3, 1, -1)].sort())
  })

  it('every attempt failing gives an all-solid fallback tile and counts it', () => {
    const gen = testGen(() => ({ error: 'always' }))
    const config = forcedFamilyConfig('poolrooms')
    const profile = resolveMapFamily(config)
    const before = bakeStats.fallbacks
    const k = tileKeyOf(TILE2, 0, 0, 0)
    const bake = bakeTile(gen, profile, 1, config, k)
    expect(bake.fallback).toBe(true)
    expect(bake.chunks.size).toBe(0)
    expect(bake.notes).toEqual(['attempt 0: always', 'attempt 1: always', 'attempt 2: always', 'attempt 3: always'])
    expect(bakeStats.fallbacks).toBe(before + 1)
    const d = buildFamilyChunk(gen, profile, 1, 1, 1, 0, config)
    expect(isSolidMassChunk(d)).toBe(true)
  })

  it('finish: local ids remap to spaceIdOf(k, v); 0 stays 0; out-of-range and stray structure ids throw', () => {
    const config = forcedFamilyConfig('poolrooms')
    const profile = resolveMapFamily(config)
    const k = tileKeyOf(TILE2, 4, 1, 3)
    const bake = bakeTile(testGen((canvas, ctx) => {
      roomTile(canvas, ctx, LOCAL_SPACE_MASK)
      canvas.setCell(3, 1 - ctx.origin.cy, 3, { spaceId: 7 })
      return {}
    }), profile, 9, config, k)
    const d = bake.chunks.get(chunkKey3(4, 1, 3))
    expect(d.spaceId[cIdx(0, 0)]).toBe(0) // mass
    expect(d.spaceId[cIdx(5, 5)]).toBe(spaceIdOf(k, LOCAL_SPACE_MASK))
    expect(d.spaceId[cIdx(3, 3)]).toBe(spaceIdOf(k, 7))
    expect(spaceSlot(k)).toBeGreaterThan(0)
    expect(() => bakeTile(testGen((canvas, ctx) => {
      roomTile(canvas, ctx, LOCAL_SPACE_MASK + 1)
      return {}
    }), profile, 9, config, k)).toThrow(/bake:local-id-range/)
    expect(() => bakeTile(testGen((canvas, ctx) => {
      roomTile(canvas, ctx, 1)
      canvas.setCell(3, 0, 3, { spaceId: STRUCTURE_ID_BIT + 5 })
      return {}
    }), profile, 9, config, k)).toThrow(/bake:stray-structure-id/)
  })

  it('a stub catalog volume survives the remap: structure ids pass through, catalogSliceErrors clean', () => {
    const family = 'poolrooms'
    const config = forcedFamilyConfig(family)
    const profile = resolveMapFamily(config)
    const seed = 77
    // The planner: one volume in slot 0 of tile (1, 0), at true global coordinates.
    const descFor = (k) => {
      if (k.tx !== 1 || k.tz !== 0 || k.band !== 0) return null
      const plan = {
        bounds: { x0: 32, z0: 3, x1: 50, z1: 10 },
        levels: [{}, { voids: [{ x0: 36, z0: 5, x1: 46, z1: 8 }] }],
        links: 'auto',
      }
      const meta = {
        id: structureId(seed, family, k, 0), family, type: 'atrium', sizeClass: 'medium',
        district: { x: k.tx, z: k.tz, size: TILE2.w }, bandIndex: k.band, slot: 0, baseCy: 0,
      }
      const planSeed = tileSeed(seed, TILE2.salt, k)
      for (let attempt = 0; attempt < 4; attempt++) {
        const desc = assembleCatalogDescriptor(plan, meta, planPick(planSeed, 0, attempt))
        if (desc) return desc
      }
      return null
    }
    const memo = new Map()
    const inTile = (seedArg, k) => {
      const key = `${k.tx},${k.tz},${k.band}`
      if (!memo.has(key)) {
        const d = descFor(k)
        memo.set(key, Object.freeze(d ? [d] : []))
      }
      return memo.get(key)
    }
    override.planners[family] = Object.freeze({
      structuresInTile: (s, k) => inTile(s, k),
      structureAt: (s, cx, cz, cy) => {
        const k = tileKeyOf(TILE2, cx, cy, cz)
        return (k && inTile(s, k).find((d) => d.participants.some((p) => p.cx === cx && p.cz === cz))) ?? null
      },
      verticalOpeningAt: () => false,
    })
    const k = tileKeyOf(TILE2, 2, 0, 0)
    const desc = inTile(seed, k)[0]
    expect(desc).toBeTruthy()
    expect(desc.id).toBeGreaterThanOrEqual(STRUCTURE_ID_BIT)
    // The tile program: rooms everywhere (local id 1), then the volume by slot.
    const gen = testGen((canvas, ctx) => {
      roomTile(canvas, ctx, 1)
      const o = ctx.origin
      const shift = (r) => ({ x0: r.x0 - o.cx * CHUNK, z0: r.z0 - o.cz * CHUNK, x1: r.x1 - o.cx * CHUNK, z1: r.z1 - o.cz * CHUNK })
      const view = ctx.kit.catalog(canvas, {
        bounds: shift(desc.globalBounds),
        levels: desc.levels.map((l) => ({ voids: l.voids.map(shift), bridges: l.bridges.map(shift) })),
        columns: [],
        piers: [],
      }, { slot: 0, baseCy: 0 - o.cy }, null)
      expect(view.globalBounds).toEqual(shift(desc.globalBounds))
      return {}
    })
    const bake = bakeTile(gen, profile, seed, config, k)
    expect(bake.notes).toEqual([])
    let voids = 0
    let rooms = 0
    for (const d of bake.chunks.values()) {
      expect(d.structure).toBe(desc)
      if (d.structureUp) expect(catalogSliceErrors(d, d.structureUp, 'up')).toEqual([])
      if (d.structureDown) {
        expect(catalogSliceErrors(d, d.structureDown, 'down')).toEqual([])
        for (const c of d.structureDown.voidCells) {
          expect(d.cellKind[cIdx(c.lx, c.lz)]).toBe(CELL_VOID)
          expect(d.spaceId[cIdx(c.lx, c.lz)]).toBe(desc.id)
          voids++
        }
      }
      for (let i = 0; i < CHUNK * CHUNK; i++) if (d.spaceId[i] === spaceIdOf(k, 1)) rooms++
    }
    expect(voids).toBeGreaterThan(0)
    expect(rooms).toBeGreaterThan(0)
    // The same through buildChunk-shaped slices and the layered audit.
    const data = new Map()
    for (const [cx, cy] of [[2, 0], [3, 0], [2, 1], [3, 1]]) data.set(`${cx},${cy},0`, buildFamilyChunk(gen, profile, seed, cx, cy, 0, config))
    const audit = auditLayeredPatch((cx, cy, cz) => data.get(`${cx},${cy},${cz}`) ?? null, 2, 0, 0, 2, 2, 1)
    expect(audit.invalidMultilevelRooms).toBe(0)
    expect(audit.orphanedHalves).toBe(0)
    expect(audit.holeMismatches).toBe(0)
    expect(audit.stairPairs).toBeGreaterThan(0)
  })

  it('the furniture off-switch clears records and COLUMN_FURNITURE; the flag is part of the cache key', () => {
    const gen = testGen((canvas, ctx) => {
      roomTile(canvas, ctx)
      canvas.addFurniture(4, 0 - ctx.origin.cy, 4, { kind: 1, x: 13.5, z: 13.5, w: 1, d: 1, facing: 0 })
      return {}
    })
    const on = forcedFamilyConfig('poolrooms')
    const off = forcedFamilyConfig('poolrooms', { ...DEFAULT_WORLD_CONFIG, furniture: { enabled: false } })
    expect(configSignature(on)).not.toBe(configSignature(off))
    const profile = resolveMapFamily(on)
    const a = buildFamilyChunk(gen, profile, 5, 0, 0, 0, on)
    expect(a.furniture.length).toBe(1)
    expect(a.cols[cIdx(4, 4)]).toBe(COLUMN_FURNITURE)
    const b = buildFamilyChunk(gen, profile, 5, 0, 0, 0, off)
    expect(b.furniture).toEqual([])
    expect([...b.cols].includes(COLUMN_FURNITURE)).toBe(false)
    expect(b.cols[cIdx(4, 4)]).toBe(0)
    // Cached separately: the first config still gets its furniture.
    expect(buildFamilyChunk(gen, profile, 5, 0, 0, 0, on).furniture.length).toBe(1)
  })
})

describe('planner rules (§7.2) and the planner-key sweep', () => {
  const family = 'poolrooms'
  const seed = 77
  const k = tileKeyAt(TILE2, 1, 0, 0) // chunks cx 2..3, cz 0, storeys 0..1
  const assemble = (plan, { slot = 0, baseCy = 0, key = k } = {}) => {
    const meta = {
      id: structureId(seed, family, key, slot), family, type: 'atrium', sizeClass: 'medium',
      district: { x: key.tx, z: key.tz, size: TILE2.w }, bandIndex: key.band, slot, baseCy,
    }
    for (let attempt = 0; attempt < 16; attempt++) {
      const desc = assembleCatalogDescriptor(plan, meta, planPick(seed, slot, attempt))
      if (desc) return desc
    }
    throw new Error('assembly failed')
  }
  const GOOD = { bounds: { x0: 32, z0: 3, x1: 50, z1: 10 }, levels: [{}, { voids: [{ x0: 36, z0: 5, x1: 46, z1: 8 }] }], links: 'auto' }

  it('plannerRuleErrors: a well-formed volume passes; each §7.2 rule is caught', () => {
    const good = assemble(GOOD)
    expect(plannerRuleErrors(Object.freeze([good]), TILE2, k)).toEqual([])
    // levelCount 7 (> 6): assembleCatalogDescriptor and analyzeCatalogDescriptor accept it.
    const tall = assemble({ ...GOOD, levels: [{}, ...Array.from({ length: 6 }, () => ({ voids: [{ x0: 36, z0: 5, x1: 46, z1: 8 }] }))] })
    expect(tall.levels.length).toBe(7)
    expect(analyzeCatalogDescriptor(tall).reasons).toEqual([])
    const tallTile = { ...TILE2, H: 8, hi: 7 }
    const tallKey = tileKeyAt(tallTile, 1, 0, 0)
    expect(plannerRuleErrors([tall], tallTile, tallKey)).toEqual([expect.stringMatching(/levelCount 7 outside 2\.\.6/)])
    // A void touching the bounds (inset 0): the analyzer accepts it, the rule does not.
    const flush = assemble({ ...GOOD, levels: [{}, { voids: [{ x0: 36, z0: 3, x1: 46, z1: 8 }] }] })
    expect(analyzeCatalogDescriptor(flush).reasons).toEqual([])
    expect(plannerRuleErrors([flush], TILE2, k)).toEqual([expect.stringMatching(/not inset 1 from bounds/)])
    // Storeys leaving the band: baseCy 1 with 2 levels tops out at 2 > cy1 = 1.
    const high = assemble(GOOD, { baseCy: 1 })
    expect(plannerRuleErrors([high], TILE2, k)).toEqual([expect.stringMatching(/storeys 1\.\.2 leave the band \[0, 1\]/)])
    // A participant outside the tile window: the same volume checked against tile (0, 0).
    const k0 = tileKeyAt(TILE2, 0, 0, 0)
    expect(plannerRuleErrors([good], TILE2, k0).some((e) => /outside the tile window/.test(e))).toBe(true)
    // Two volumes sharing a chunk-storey.
    const twin = assemble(GOOD, { slot: 1 })
    expect(plannerRuleErrors([good, twin], TILE2, k).some((e) => /slot 1 .*already belongs to slot 0/.test(e))).toBe(true)
    // null slots are item 6's separate check, not a rule error.
    expect(plannerRuleErrors([null, good], TILE2, k)).toEqual([])
  })

  it('plannerKeySweep counts DISTINCT keys, row families included', () => {
    const seen = new Set()
    const planner = {
      structuresInTile: (_seed, key) => {
        seen.add(`${key.tx},${key.tz},${key.band}`)
        return Object.freeze([])
      },
    }
    for (const tile of [
      { w: 4, d: 3, backend: 'band', rows: [0], H: 3, lo: -1, hi: 1 }, // terminal-shaped
      { w: 4, d: 1, backend: 'band', rows: [0], H: 2, lo: 0, hi: 1 }, // train-shaped
      { w: 3, d: 2, backend: 'band', rows: [0, 1], H: 2, lo: 0, hi: 1 },
      { w: 3, d: 2, backend: 'band', H: 5, lo: -1, hi: 3 }, // theater-shaped
      { w: 2, d: 2, backend: 'band', H: 5, phase: (tx, tz) => (((tx + 2 * tz) % 5) + 5) % 5 }, // babel, unbounded
      { w: 1, d: 1, backend: 'storey', lo: -2, hi: 2 },
    ]) {
      seen.clear()
      const res = plannerKeySweep(planner, tile, 1, null, null)
      expect(res, JSON.stringify(tile)).toEqual({ keys: 2000, nulls: 0, ruleErrors: [] })
      expect(seen.size).toBe(2000)
      if (tile.rows) for (const s of seen) expect(tile.rows).toContain(Number(s.split(',')[1]))
    }
    // Nulls are summed over distinct keys only.
    const holey = { structuresInTile: (_s, key) => Object.freeze(key.tx % 10 === 0 ? [null] : []) }
    const res = plannerKeySweep(holey, { w: 4, d: 1, backend: 'band', rows: [0], H: 2, lo: 0, hi: 1 }, 1, null, null)
    expect(res.keys).toBe(2000)
    expect(res.nulls).toBe(200)
  })
})

describe('cache, gates and the chunk branch (§6.6, §6.7)', () => {
  it('purity: cold, warm and cleared builds agree; a built chunk never writes back into the cache', () => {
    const coords = [[0, 0, 0], [1, 0, 0], [0, 0, -1], [5, 0, 3], [0, 1, 0], [0, -1, 0]]
    const cold = coords.map(([cx, cy, cz]) => chunkPrint(generateChunk(31, cx, cy, cz, stubConfig)))
    const warm = coords.map(([cx, cy, cz]) => chunkPrint(generateChunk(31, cx, cy, cz, stubConfig)))
    tileCache.clear()
    const again = coords.map(([cx, cy, cz]) => chunkPrint(generateChunk(31, cx, cy, cz, stubConfig)))
    expect(warm).toEqual(cold)
    expect(again).toEqual(cold)
    const withExit = generateChunk(31, 0, 0, 0, stubConfig, { lx: 6, lz: 6 })
    expect(withExit.exit).toEqual({ lx: 6, lz: 6 })
    withExit.cols[0] = 9
    withExit.lamps.push({ lx: 1, lz: 1, lit: true })
    const plain = generateChunk(31, 0, 0, 0, stubConfig)
    expect(plain.exit).toBeNull()
    expect(chunkPrint(plain)).toBe(cold[0])
  })

  it('LRU: capacity per generator; a capacity-1 cache re-bakes and still agrees', () => {
    expect(lruCapacityOf({ w: 1, d: 1, backend: 'band' })).toBe(242)
    expect(lruCapacityOf({ w: 4, d: 4, backend: 'storey' })).toBe(32)
    expect(lruCapacityOf({ w: 4, d: 4, backend: 'band' })).toBe(32)
    expect(lruCapacityOf({ w: 2, d: 2, backend: 'storey' })).toBe(93)
    expect(cacheBakeStats).toBe(bakeStats)
    const gen = familyGenerator(STUB)
    const a = chunkPrint(generateChunk(8, 0, 0, 0, stubConfig))
    const b = chunkPrint(generateChunk(8, 1, 0, 0, stubConfig))
    let count = bakeStats.count
    generateChunk(8, 0, 0, 0, stubConfig)
    expect(bakeStats.count).toBe(count) // cached
    expect(tileCache.size(gen)).toBe(2)
    tileCache.setCapacityOverride(1)
    tileCache.clear()
    count = bakeStats.count
    expect(chunkPrint(generateChunk(8, 0, 0, 0, stubConfig))).toBe(a)
    expect(chunkPrint(generateChunk(8, 1, 0, 0, stubConfig))).toBe(b)
    expect(chunkPrint(generateChunk(8, 0, 0, 0, stubConfig))).toBe(a)
    expect(bakeStats.count).toBe(count + 3) // evicted and re-baked
    expect(tileCache.size(gen)).toBe(1)
    expect(bakeStats.maxMs).toBeGreaterThanOrEqual(bakeStats.p95Ms)
    expect(bakeStats.ewmaMs).toBeGreaterThan(0)
  })

  it('wouldBakeChunk, prebakeTile and bakeExitsAt', () => {
    expect(wouldBakeChunk(4, 0, 0, 0, stubConfig)).toBe(true)
    expect(wouldBakeChunk(4, 0, 1, 0, stubConfig)).toBe(false) // solid storey
    expect(wouldBakeChunk(4, 0, 0, 0, DEFAULT_WORLD_CONFIG)).toBe(false) // legacy
    expect(wouldBakeChunk(4, 0, 0, 0, null)).toBe(false)
    expect(wouldBakeChunk(4, 0, 0, 0, { mapFamily: { selected: 'nope' } })).toBe(false) // never throws
    expect(prebakeTile(4, 0, 0, 0, stubConfig)).toBe(true)
    expect(wouldBakeChunk(4, 0, 0, 0, stubConfig)).toBe(false)
    expect(prebakeTile(4, 0, 0, 0, stubConfig)).toBe(false)
    expect(prebakeTile(4, 0, 0, 0, DEFAULT_WORLD_CONFIG)).toBe(false)
    // The stub's exit anchor: chunk (6, 0) cell (6, 6) on storey 0.
    expect(bakeExitsAt(4, { tx: 6, tz: 0, band: 0 }, stubConfig)).toEqual([{ gx: 6 * CHUNK + 6, gz: 6, cy: 0 }])
    expect(bakeExitsAt(4, tileKeyOf(familyGenerator(STUB).tile, 6, 0, 0), stubConfig)).toEqual([{ gx: 90, gz: 6, cy: 0 }])
    expect(bakeExitsAt(4, { tx: 5, tz: 0, band: 0 }, stubConfig)).toEqual([])
    expect(bakeExitsAt(4, { tx: 6, tz: 0, band: 3 }, stubConfig)).toEqual([]) // outside the storeys
    expect(bakeExitsAt(4, { tx: 6, tz: 0, band: 0 }, DEFAULT_WORLD_CONFIG)).toEqual([])
    expect(tileBakeAt(4, { tx: 0, tz: 0, band: 0 }, stubConfig).spawns).toEqual([{ gx: 6, gz: 6, cy: 0 }])
    expect(wouldBakeChunk(4, 6, 0, 0, stubConfig)).toBe(false) // bakeExitsAt cached it
  })

  it('solid chunks: out-of-range storeys and footprint-solid chunks never bake', () => {
    const before = bakeStats.count
    const d = generateChunk(4, 3, 2, -5, stubConfig)
    expect(isSolidMassChunk(d)).toBe(true)
    expect(d.mapFamily).toBe(STUB)
    expect(d.worldSeed).toBe(4)
    expect(d.district).toEqual({ dx: 3, dz: -5 })
    expect(d.version).toBe(stubConfig.version)
    // Footprint-solid inside the storeys: district from the tile key.
    const gen = testGen(() => {
      throw new Error('must not bake')
    }, { footprint: () => 'solid' })
    const profile = resolveMapFamily(forcedFamilyConfig('poolrooms'))
    const s = buildFamilyChunk(gen, profile, 4, 5, 1, -3, forcedFamilyConfig('poolrooms'))
    expect(isSolidMassChunk(s)).toBe(true)
    expect(s.district).toEqual({ dx: 2, dz: -3 })
    expect(s.cols.every((c) => c === COLUMN_STANDARD)).toBe(true)
    expect(bakeStats.count).toBe(before)
  })

  it('exitCell sets the exit without carving; only family clearings carve', () => {
    const plain = generateChunk(12, 0, 0, 0, stubConfig)
    const exit = generateChunk(12, 0, 0, 0, stubConfig, { lx: 2, lz: 2 })
    expect(exit.exit).toEqual({ lx: 2, lz: 2 })
    expect([...exit.cols]).toEqual([...plain.cols])
    const legacy = generateChunk(12, 0, 0, 0, stubConfig, null, [{ lx: 0, lz: 0, r: 1 }])
    expect(chunkPrint(legacy)).toBe(chunkPrint(plain))
    expect(plain.cols[cIdx(0, 0)]).toBe(COLUMN_STANDARD)
    const carved = generateChunk(12, 0, 0, 0, stubConfig, null, [{ lx: 0, lz: 0, r: 1, family: true }])
    expect(carved.cols[cIdx(0, 0)]).toBe(0)
    expect(carved.cols[cIdx(1, 1)]).toBe(0)
  })

  it('the stub world builds through buildChunk with remapped space ids and the record family', () => {
    const k = tileKeyOf(familyGenerator(STUB).tile, 3, 0, 2)
    const d = generateChunk(21, 3, 0, 2, stubConfig)
    expect(d.mapFamily).toBe(STUB)
    expect(d.district).toEqual({ dx: 3, dz: 2 })
    const ids = new Set(d.spaceId)
    ids.delete(0)
    expect([...ids].every((v) => v > LOCAL_SPACE_MASK || spaceSlot(k) === 0)).toBe(true)
    expect(ids.has(spaceIdOf(k, 1))).toBe(true)
    expect(d.lamps).toEqual([{ lx: 7, lz: 7, lit: true }])
    expect(keyString(STUB, 21, configSignature(stubConfig, stubProfile), k)).toContain(`${STUB}|21|`)
  })
})

// F-plumb's stub-world contract (§12.0), pinned for every family that still
// runs the stub hooks: spawn chunk (0,0) cell (6,6); exit anchor chunk (6,0)
// cell (6,6) on storey 0; exitBounds {5, 7, [0, 0]}; proofBox = the
// spawn-to-anchor chunk box grown by 1 on storey 0. A family agent's real
// hooks (stub dropped) leave this test.
describe('stub-world hooks (§12.0)', () => {
  const stubIds = LIMINAL_FAMILY_IDS.filter((id) => hookOf(id)?.stub === true)

  it.skipIf(stubIds.length === 0)('spawn, exit anchor, exitBounds and proofBox', () => {
    for (const id of stubIds) {
      const hooks = hookOf(id)
      const config = forcedFamilyConfig(id)
      const profile = resolveMapFamily(config)
      for (const seed of [0, 9, 0xfffffffe]) {
        const sp = familySpawn(config, seed)
        expect({ cx: sp.cx, cz: sp.cz, lx: sp.lx, lz: sp.lz }, id).toEqual({ cx: 0, cz: 0, lx: 6, lz: 6 })
        expect(sp.clearings).toEqual([])
        const exit = hooks.exit({ worldSeed: seed, level: 1, config, profile, generate: () => null })
        expect(exit, id).toEqual({ cx: 6, cy: 0, cz: 0, lx: 6, lz: 6 })
        expect(hooks.exitAnchor(seed, profile)).toEqual(exit)
      }
      expect(hooks.exitBounds).toEqual({ minChunks: 5, maxChunks: 7, cy: [0, 0] })
      expect(hooks.proofBox(hooks.exitAnchor(0, profile), familySpawn(config, 0)))
        .toEqual({ chunks: { x0: -1, z0: -1, x1: 7, z1: 1 }, cy: [0, 0] })
    }
  })
})
