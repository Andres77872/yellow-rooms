import { availableParallelism, loadavg } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHUNK, CHUNK_WORLD, CELL } from '../../constants.js'
import { fmix32, hashStr } from '../../core/hash.js'
import { generateChunk } from '../../generate.js'
import { resolveMapFamily, worldConfigForFamilyOrOffice } from '../../mapFamily.js'
import { COLUMN_FURNITURE } from '../../mapTypes.js'
import { DEFAULT_WORLD_CONFIG } from '../../config.js'
import { auditLayeredPatch } from '../../audit.js'
import { auditChunkFamilyRegistrations } from '../../familyAudit.js'
import { validatedRuntimeStructure } from '../../structures/contract.js'
import { analyzeCatalogDescriptor, isCatalogStructure } from '../../structures/catalog/engine.js'
import { catalogSliceErrors } from '../../structures/catalog/audit.js'
import { NUMERAL_GLYPHS } from '../../objects/dressing/notices.js'
import { PROP_BY_ID } from '../../props/index.js'
import { familyGenerator } from '../generators.js'
import { familyPlanner } from '../planners.js'
import { familyExitHook, familySpawn, hookOf, LEGACY_SPAWN } from '../hooks.js'
import { forcedFamilyConfig } from '../forced.js'
import { familyRecord } from '../registry.js'
import { proveReachable, windowConnectivity, worldSource } from '../reach.js'
import { cellWalkable } from '../../tiles/holeMasks.js'
import { exitCellClear, spawnCellOk } from '../../tiles/cells.js'
import { massLeakAudit } from '../../tiles/seams.js'
import { bakeStats, tileBakeAt, tileCache } from '../../tiles/familyChunk.js'
import { tileKeyAt, tileKeyOf, tileShape, tileWindow } from '../../tiles/tileKey.js'
import { digestChunk } from '../../__tests__/support/chunkDigest.js'
import { PINNED_VERSION } from '../../__tests__/support/goldens.js'

// The per-family suite (spec §11.1): runFamilySuite(id, opts) registers the
// 11 checks every liminal family must pass, on whatever its generator,
// planner and hooks are today — the stub world in Phase F, the real family
// after its agent ports it. A family test file is one call:
//
//   import { runFamilySuite } from '../../__tests__/familyHarness.js'
//   runFamilySuite('stairwell', { … })
//
// opts (all optional):
//   seeds         [1, 0x5eed, 777]
//   window        { tiles: [2, 2], storeys: [lo, hi] }   W, spawn-centred
//                 (default storeys: the family's within ±1 of 0)
//   connWindow    { tiles, storeys }  decision-6 window (default W)
//   purityWindow  { tiles: [1, 1], storeys }  purity/order passes
//   lruSample     24 chunks of W for the shuffled and LRU-1 passes
//   reachSeeds    3 (SLOW=1 → 16); reachLevels [1, 2, 3]
//   sealedPockets false
//   skipRegistration false (F-verify turned registration on in all 12 suites)
//   goldens       { coords, digests } (default: <id>/__tests__/<id>.goldens.js)
//
// SLOW=1 runs the 16-seed reachability sweep and fails a file over 10 s
// (wall clock, or — when the machine is loaded — the file's own CPU time).
// FAMILY_REPORT=1 (or SLOW=1) prints the reported metrics.

export const SLOW = process.env.SLOW === '1'
const REPORT = SLOW || process.env.FAMILY_REPORT === '1'

const GOLDENS = import.meta.glob('../*/__tests__/*.goldens.js', { eager: true, import: 'default' })

// The four footstep classes (spec §9.3).
const STEP_CLASSES = Object.freeze(['carpet', 'concrete', 'tile', 'deck'])

// Every structural counter of auditLayeredPatch that must be 0.
export const STRUCTURAL_COUNTERS = Object.freeze([
  'mismatchedDescriptors', 'holeMismatches', 'orphanedHalves', 'invalidCanonicalLinks',
  'mismatchedMultilevelDescriptors', 'orphanedMultilevelHalves', 'invalidMultilevelRooms',
  'mismatchedLethalVoidDescriptors', 'orphanedLethalVoidHalves', 'strayWallFeatures',
  'invalidMultilevelStructures', 'missingMultilevelSlices', 'closedBridgeSeams',
  'familyAdapterFailures', 'kindAdapterFailures', 'familyDescriptorFailures',
])

// §11.1 gates (×3 slack).
const BUDGET = Object.freeze({ meanChunkMs: 4.5 * 3, maxBakeMs: 75 * 3, solidChunkMs: 0.3 * 3, fileMs: 10_000 })

// Load tolerance: wall-clock timings spike on a loaded machine (other test
// workers, GC). A budget miss is measured again, fresh, up to RETIME times
// and the best measurement counts: code that is really over budget misses
// every time, a scheduler stall does not repeat. The file budget falls back
// to the file's own CPU time (this thread's, where Node reports it). CPU time
// still stretches when every core is busy (shared caches, SMT siblings,
// clocks), so that fallback scales with the measured load per core, like
// the ×3 chunk budgets and never past them: ×1 up to a load of 0.25 per
// core, +1 per unit of load per core beyond that, ×3 at most. On a quiet
// machine the gate is the plain 10 s.
const RETIME = 2
export function retimed(first, budget, measure) {
  let best = first
  let retries = 0
  while (best > budget && retries < RETIME) {
    retries++
    best = Math.min(best, measure())
  }
  return { value: best, first, retries }
}
export const loadSlack = () => {
  const cores = typeof availableParallelism === 'function' ? availableParallelism() : 1
  return Math.min(3, Math.max(1, 0.75 + loadavg()[0] / Math.max(1, cores)))
}
const cpuMs = () => {
  const u = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage()
  return (u.user + u.system) / 1000
}
const LAMP_CAP_CHUNK = 12
const LAMP_CAP_60U = 72
const PROP_KIND_CAP = 14
const WALL_DIFF_MIN = 0.02
const PLANNER_KEYS = 2000

// --- helpers (exported for the framework tests) ----------------------------------

// A chunk's full fingerprint: the golden digest plus everything it does not
// fold (lamp tints, labels, finish context).
export function chunkPrint(d) {
  let h = 0x2545f491
  for (const v of d.spaceClass) h = fmix32((h ^ v) | 0)
  return `${digestChunk(d)}|${h >>> 0}|${JSON.stringify({
    lamps: d.lamps,
    label: d.levelLabel ?? null,
    district: d.district ?? null,
    worldSeed: d.worldSeed ?? 0,
    af: !!d.authoredFeatures,
  })}`
}

export const boxChunks = (b) => {
  const out = []
  for (let cy = b.y0; cy <= b.y1; cy++) {
    for (let cz = b.z0; cz <= b.z1; cz++) for (let cx = b.x0; cx <= b.x1; cx++) out.push([cx, cy, cz])
  }
  return out
}

// The distinct tile keys of the chunks of box b (null keys skipped).
export function tileKeysIn(tile, b) {
  const keys = new Map()
  for (const [cx, cy, cz] of boxChunks(b)) {
    const k = tileKeyOf(tile, cx, cy, cz)
    if (k) keys.set(`${k.tx},${k.tz},${k.band}`, k)
  }
  return [...keys.values()]
}

// A deterministic Fisher-Yates permutation.
function permute(list, salt) {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = fmix32((salt ^ Math.imul(i, 0x9e3779b1)) | 0) % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const clampStoreys = (tile, lo, hi) => {
  const s = tileShape(tile)
  return [Math.max(lo, s.lo), Math.min(hi, s.hi)]
}

// The §7.2 planner rules over one tile's structuresInTile list (null slots
// are item 6's own check): levelCount 2..6 and voids inset ≥ 1 from the
// bounds (catalog volumes); every volume inside the tile window and its
// storeys inside the band [k.cy0, k.cy1]; per storey, the participant chunks
// of different volumes are disjoint. Returns the list of violations.
export function plannerRuleErrors(list, tile, k) {
  const out = []
  const win = tileWindow(tile, k)
  const owner = new Map()
  for (const desc of list) {
    if (desc == null) continue
    const tag = `slot ${desc.slot ?? '?'} (${desc.kind ?? 'structure'})`
    const levels = desc.levels ?? null
    if (isCatalogStructure(desc)) {
      const n = levels?.length ?? 0
      if (n < 2 || n > 6) out.push(`${tag}: levelCount ${n} outside 2..6`)
      const b = desc.globalBounds
      for (const level of levels ?? []) {
        for (const v of level.voids ?? []) {
          if (!b || v.x0 < b.x0 + 1 || v.z0 < b.z0 + 1 || v.x1 > b.x1 - 1 || v.z1 > b.z1 - 1) {
            out.push(`${tag}: void ${JSON.stringify(v)} on storey ${level.levelCy} not inset 1 from bounds ${JSON.stringify(b)}`)
          }
        }
      }
    }
    const base = Number.isInteger(desc.baseCy) ? desc.baseCy : null
    const top = Number.isInteger(desc.topCy) ? desc.topCy : base
    if (base === null) {
      out.push(`${tag}: no integer baseCy`)
      continue
    }
    if (base < k.cy0 || top > k.cy1 || top < base) out.push(`${tag}: storeys ${base}..${top} leave the band [${k.cy0}, ${k.cy1}]`)
    for (const p of desc.participants ?? []) {
      if (p.cx < win.cx0 || p.cx > win.cx1 || p.cz < win.cz0 || p.cz > win.cz1) {
        out.push(`${tag}: participant chunk ${p.cx},${p.cz} outside the tile window ${JSON.stringify(win)}`)
      }
      for (let cy = base; cy <= top; cy++) {
        const key = `${p.cx},${cy},${p.cz}`
        const prev = owner.get(key)
        if (prev !== undefined && prev !== desc) out.push(`${tag}: chunk-storey ${key} already belongs to slot ${prev.slot ?? '?'}`)
        else owner.set(key, desc)
      }
    }
  }
  return out
}

// The family's layout: generator, config, tile, default windows.
export function familyLayout(id, opts = {}) {
  const gen = familyGenerator(id)
  if (!gen) throw new Error(`runFamilySuite: ${id} has no generator`)
  const config = forcedFamilyConfig(id)
  const profile = resolveMapFamily(config)
  const tile = gen.tile
  const storeys = opts.window?.storeys ?? clampStoreys(tile, -1, 1)
  const window = { tiles: opts.window?.tiles ?? [2, 2], storeys }
  return {
    id,
    gen,
    config,
    profile,
    tile,
    window,
    connWindow: { tiles: opts.connWindow?.tiles ?? window.tiles, storeys: opts.connWindow?.storeys ?? storeys },
    purityWindow: { tiles: opts.purityWindow?.tiles ?? [1, 1], storeys: opts.purityWindow?.storeys ?? storeys },
  }
}

// A tile window { tiles: [nx, nz], storeys: [lo, hi] } as GLOBAL chunks,
// centred on the spawn's tile.
export function windowBox(layout, win, spawn) {
  const { tile } = layout
  const [nx, nz] = win.tiles
  const tx0 = Math.floor(spawn.cx / tile.w) - Math.floor((nx - 1) / 2)
  const tz0 = Math.floor(spawn.cz / tile.d) - Math.floor((nz - 1) / 2)
  return {
    x0: tx0 * tile.w,
    z0: tz0 * tile.d,
    x1: (tx0 + nx) * tile.w - 1,
    z1: (tz0 + nz) * tile.d - 1,
    y0: win.storeys[0],
    y1: win.storeys[1],
  }
}

// Box b grown by one tile on each planar side (storeys unchanged).
export const growTile = (tile, b) => ({ ...b, x0: b.x0 - tile.w, x1: b.x1 + tile.w, z0: b.z0 - tile.d, z1: b.z1 + tile.d })

// Box b grown by one tile planar and one storey vertically, clipped to the
// family's storeys (the outer box of a connectivity window).
export function outerBox(tile, b) {
  const g = growTile(tile, b)
  const [y0, y1] = clampStoreys(tile, b.y0 - 1, b.y1 + 1)
  return { ...g, y0, y1 }
}

// Item 6's planner-only sweep over `count` DISTINCT tile keys. Row families
// (tile.rows) walk tx along their rows; the others walk a widening 47-wide
// grid of tiles. Every storey of [-4, 4] ∩ [lo, hi] is tried per tile and
// repeated keys are skipped, so `keys` counts distinct (tx, tz, band).
// Returns { keys, nulls, ruleErrors (first few plannerRuleErrors) }.
export function plannerKeySweep(planner, tile, seed, profile, config, count = PLANNER_KEYS) {
  const [lo, hi] = clampStoreys(tile, -4, 4)
  const ny = hi - lo + 1
  const rows = tile.rows ?? null
  const distinct = new Set()
  let nulls = 0
  let ruleErrors = []
  for (let i = 0; ny > 0 && distinct.size < count && i < count * 32; i++) {
    const j = Math.floor(i / ny)
    const cy = lo + (i % ny)
    const tx = rows ? Math.floor(j / rows.length) - 1000 : (j % 47) - 23
    const tz = rows ? rows[j % rows.length] : Math.floor(j / 47) - 21
    const k = tileKeyOf(tile, tx * tile.w, cy, tz * tile.d)
    if (!k) continue
    const ks = `${k.tx},${k.tz},${k.band}`
    if (distinct.has(ks)) continue
    distinct.add(ks)
    const list = planner.structuresInTile(seed, k, profile, config)
    nulls += list.filter((s) => s == null).length
    if (ruleErrors.length < 8) ruleErrors = ruleErrors.concat(plannerRuleErrors(list, tile, k).map((e) => `${ks}: ${e}`))
  }
  return { keys: distinct.size, nulls, ruleErrors }
}

const spawnCell = (sp) => ({ gx: sp.cx * CHUNK + sp.lx, gz: sp.cz * CHUNK + sp.lz, cy: 0 })

// --- the suite --------------------------------------------------------------------

export function runFamilySuite(id, opts = {}) {
  const seeds = opts.seeds ?? [1, 0x5eed, 777]
  const lruSample = opts.lruSample ?? 24
  const reachSeedCount = SLOW ? 16 : (opts.reachSeeds ?? 3)
  const reachLevels = opts.reachLevels ?? [1, 2, 3]
  const sealedPockets = opts.sealedPockets ?? false
  const goldens = opts.goldens ?? GOLDENS[`../${id}/__tests__/${id}.goldens.js`] ?? null
  const metrics = {}
  let started = 0

  describe(`family suite: ${id}`, () => {
    const L = familyLayout(id, opts)
    const { gen, config, profile, tile } = L
    const sources = new Map()
    const sourceFor = (seed) => {
      let s = sources.get(seed)
      if (!s) sources.set(seed, (s = worldSource(seed, config)))
      return s
    }
    const spawnOf = (seed) => familySpawn(config, seed)
    const W = (seed) => windowBox(L, L.window, spawnOf(seed))

    let startedCpu = 0
    beforeAll(() => {
      started = performance.now()
      startedCpu = cpuMs()
      tileCache.setCapacityOverride(null)
    })
    afterAll(() => {
      tileCache.setCapacityOverride(null)
      metrics.fileMs = Math.round(performance.now() - started)
      metrics.fileCpuMs = Math.round(cpuMs() - startedCpu)
      metrics.loadSlack = +loadSlack().toFixed(2)
      if (REPORT) console.info(`[family ${id}]`, JSON.stringify(metrics))
    })

    // 1. Registration ---------------------------------------------------------------
    it.skipIf(!!opts.skipRegistration)('1. registration: record, palette, surfaces, step, packs, adapters, title, config, audio', async () => {
      const { familyPalette, MAP_PALETTES } = await import('../../familyPalette.js')
      const { worldSurfaceSet } = await import('../../surfaceSet.js')
      const { stepClassFor } = await import('../registry.js')
      const { PROP_MODEL_FILES } = await import('../../props/index.js')
      const { CATALOG_KINDS } = await import('../../structures/catalog/engine.js')
      const { FAMILY_AUDIT_ADAPTERS } = await import('../../familyAudit.js')
      const { FAMILY_NOTES } = await import('../../../ui/titleMenu.js')
      const { FAMILY_SPACES } = await import('../../../audio/AudioBus.js')
      const { FAMILY_PA } = await import('../../../audio/music/MusicPlayer.js')
      const record = familyRecord(id)
      expect(record).toBeTruthy()
      for (const key of ['id', 'base', 'dressing', 'displayName', 'note', 'group', 'paletteId', 'step', 'propPacks',
        'lampTint', 'audio', 'threats', 'massFastPath', 'profile', 'traits']) {
        expect(Object.hasOwn(record, key), `record.${key}`).toBe(true)
      }
      const palette = familyPalette(id)
      expect(palette).toBe(MAP_PALETTES[record.paletteId])
      const floor0 = worldSurfaceSet(id).floor[0]
      expect(floor0.style).toBe(palette.floor.style)
      expect(STEP_CLASSES).toContain(stepClassFor(palette.floor.style, id))
      for (const pack of record.propPacks) expect(Object.hasOwn(PROP_MODEL_FILES, pack), `pack ${pack}`).toBe(true)
      // Every placed prop's pack is listed.
      const seed = seeds[0]
      for (const [cx, cy, cz] of boxChunks(W(seed))) {
        for (const f of sourceFor(seed).chunkAt(cx, cy, cz).furniture) {
          const prop = PROP_BY_ID[f.kind]
          if (prop) expect(record.propPacks, `prop ${prop.key} at ${cx},${cy},${cz}`).toContain(prop.pack)
        }
      }
      expect(CATALOG_KINDS[id]).toBe(`${id}Catalog`)
      expect(FAMILY_AUDIT_ADAPTERS.families[id]).toBeTruthy()
      expect(FAMILY_NOTES[id]).toBe(record.note)
      expect(() => forcedFamilyConfig(id)).not.toThrow()
      expect(resolveMapFamily(forcedFamilyConfig(id)).family).toBe(id)
      const enabled = DEFAULT_WORLD_CONFIG.mapFamily.profiles[id]?.enabled === true
      expect(worldConfigForFamilyOrOffice(id).fellBack).toBe(!enabled)
      if (gen.stub === false) {
        expect(record.audio).toBeTruthy()
        expect(record.audio.space).not.toEqual(FAMILY_SPACES[record.base])
        expect(record.audio.pa).not.toEqual(FAMILY_PA[record.base])
      }
    })

    // 2. Purity and order independence ------------------------------------------------
    it('2. purity: cold, warm, reverse and cleared builds agree; shuffled and LRU-1 too', () => {
      const build = (seed, [cx, cy, cz]) => chunkPrint(generateChunk(seed, cx, cy, cz, config))
      for (const seed of seeds) {
        const coords = boxChunks(windowBox(L, L.purityWindow, spawnOf(seed)))
        tileCache.clear()
        const cold = coords.map((c) => build(seed, c))
        const warm = coords.map((c) => build(seed, c))
        tileCache.clear()
        const reverse = [...coords].reverse().map((c) => build(seed, c)).reverse()
        tileCache.clear()
        const cleared = coords.map((c) => build(seed, c))
        expect(warm).toEqual(cold)
        expect(reverse).toEqual(cold)
        expect(cleared).toEqual(cold)
      }
      const seed = seeds[0]
      const all = boxChunks(W(seed))
      const sample = permute(all, hashStr(`lru-${id}`)).slice(0, Math.min(lruSample, all.length))
      tileCache.clear()
      const base = sample.map((c) => build(seed, c))
      const order = permute(sample.map((_, i) => i), hashStr(`shuffle-${id}`))
      tileCache.clear()
      const shuffled = new Array(sample.length)
      for (const i of order) shuffled[i] = build(seed, sample[i])
      expect(shuffled).toEqual(base)
      try {
        tileCache.setCapacityOverride(1)
        tileCache.clear()
        const lru1 = new Array(sample.length)
        for (const i of order) lru1[i] = build(seed, sample[i])
        expect(lru1).toEqual(base)
      } finally {
        tileCache.setCapacityOverride(null)
        tileCache.clear()
      }
    }, 120_000)

    // 3. Seams and perimeter --------------------------------------------------------
    it('3. seams: no mass leaks, seals, port violations or see-through to solid (direct or across thin mass) over W + 1 tile', () => {
      let untouchedKept = 0
      let massFilledCells = 0
      let solidChunks = 0
      for (const seed of seeds) {
        const box = growTile(tile, W(seed))
        const src = sourceFor(seed)
        const audit = massLeakAudit(src.chunkAt, box, { gen, worldSeed: seed })
        expect(audit.details.leaks, `seed ${seed} leaks`).toEqual([])
        expect(audit.details.seals, `seed ${seed} seals`).toEqual([])
        expect(audit.details.portViolations, `seed ${seed} port violations`).toEqual([])
        expect(audit.details.seeThroughToSolid, `seed ${seed} see-through`).toEqual([])
        // Glass must not see across fewer than BORDER_DEPTH rows of mass into a
        // whole-solid chunk, which draws no posts (§9.6a; F-render request).
        expect(audit.details.seeThroughThinMass, `seed ${seed} see-through thin mass`).toEqual([])
        expect(audit.sealedMass).toBe(true)
        solidChunks += audit.solidChunks
        for (const k of tileKeysIn(tile, box)) {
          const bake = tileBakeAt(seed, k, config)
          expect(bake.stats.scratchWalkableWrites, `scratch writes in tile ${k.tx},${k.tz},${k.band}`).toBe(0)
          untouchedKept += bake.stats.untouchedKept
          massFilledCells += bake.stats.massFilledCells
        }
        // Ports are pure and band-independent (§6.5).
        for (const k of tileKeysIn(tile, W(seed))) {
          for (let cy = k.cy0; cy <= k.cy1; cy++) {
            for (const side of ['west', 'north']) {
              const a = gen.ports(seed, { tx: k.tx, tz: k.tz, band: k.band }, side, cy)
              const b = gen.ports(seed, { tx: k.tx, tz: k.tz, band: k.band + 7 }, side, cy)
              expect(b, `ports ${side} of ${k.tx},${k.tz} on ${cy}`).toEqual(a)
            }
          }
        }
      }
      metrics.untouchedKept = untouchedKept
      metrics.massFilledCells = massFilledCells
      metrics.solidChunks = solidChunks
    }, 120_000)

    // 4. Layered structure audit -------------------------------------------------------
    it('4. layered audit over W: every structural counter 0, family registrations clean', () => {
      for (const seed of seeds) {
        const b = W(seed)
        const src = sourceFor(seed)
        const audit = auditLayeredPatch(src.chunkAt, b.x0, b.y0, b.z0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1)
        const bad = Object.fromEntries(STRUCTURAL_COUNTERS.filter((c) => audit[c]).map((c) => [c, audit[c]]))
        expect(bad, JSON.stringify(audit.details).slice(0, 2000)).toEqual({})
        const chunks = new Map(boxChunks(b).map(([cx, cy, cz]) => [`${cx},${cy},${cz}`, src.chunkAt(cx, cy, cz)]))
        expect(auditChunkFamilyRegistrations(chunks).failures).toEqual([])
      }
    }, 120_000)

    // 5. Window connectivity ---------------------------------------------------------
    it('5. window connectivity over connWindow', () => {
      for (const seed of seeds) {
        const sp = spawnOf(seed)
        const inner = windowBox(L, L.connWindow, sp)
        const res = windowConnectivity(sourceFor(seed), inner, outerBox(tile, inner), spawnCell(sp), { sealedPockets })
        expect({ ok: res.ok, reason: res.reason, stranded: res.stranded, sealed: res.sealed }).toEqual({ ok: true, reason: null, stranded: [], sealed: [] })
        metrics.pockets = Math.max(metrics.pockets ?? 0, res.pockets.length)
      }
    }, 120_000)

    // 6. Structures -------------------------------------------------------------------
    it('6. structures: descriptors, identity, runtime validation, slices, links, ids', () => {
      const planner = familyPlanner(id)
      expect(planner).toBeTruthy()
      const fallbacks0 = bakeStats.fallbacks
      for (const seed of seeds) {
        const b = W(seed)
        const src = sourceFor(seed)
        for (const k of tileKeysIn(tile, b)) {
          const list = planner.structuresInTile(seed, k, profile, config)
          expect(Object.isFrozen(list)).toBe(true)
          expect(list.filter((s) => s == null), `null slots in ${k.tx},${k.tz},${k.band}`).toEqual([])
          expect(plannerRuleErrors(list, tile, k), `planner rules in ${k.tx},${k.tz},${k.band}`).toEqual([])
          for (const desc of list) {
            if (isCatalogStructure(desc)) expect(analyzeCatalogDescriptor(desc).reasons).toEqual([])
            for (const p of desc.participants ?? []) {
              for (let cy = Math.max(desc.baseCy, k.cy0); cy <= Math.min(desc.topCy, k.cy1); cy++) {
                expect(planner.structureAt(seed, p.cx, p.cz, cy, profile, config), `structureAt ${p.cx},${cy},${p.cz}`).toBe(desc)
                expect(validatedRuntimeStructure(seed, config, desc, cy), `runtime ${p.cx},${cy},${p.cz}`).not.toBeNull()
              }
            }
          }
        }
        for (const [cx, cy, cz] of boxChunks(b)) {
          const d = src.chunkAt(cx, cy, cz)
          if (d.structureUp) expect(catalogSliceErrors(d, d.structureUp, 'up'), `up slice ${cx},${cy},${cz}`).toEqual([])
          if (d.structureDown) expect(catalogSliceErrors(d, d.structureDown, 'down'), `down slice ${cx},${cy},${cz}`).toEqual([])
          if (d.structure) expect(planner.structureAt(seed, cx, cz, cy, profile, config)).toStrictEqual(d.structure)
          // One up flight, one down flight, one structure per chunk-storey:
          // a structure's links in this chunk are this chunk's only stairs.
          const links = (d.structure?.verticalLinks ?? []).filter((l) => l.cx === cx && l.cz === cz)
          expect(links.filter((l) => l.lowerCy === cy).length).toBeLessThanOrEqual(1)
          expect(links.filter((l) => l.lowerCy === cy - 1).length).toBeLessThanOrEqual(1)
          if (d.stairUp || d.structureUp) {
            expect(planner.verticalOpeningAt(seed, cx, cz, cy, profile, config), `verticalOpeningAt ${cx},${cy},${cz}`).toBe(true)
          }
        }
      }
      expect(bakeStats.fallbacks - fallbacks0).toBe(0)
      expect(bakeStats.fallbacks).toBe(0)
      // Planner nulls (and the §7.2 rules) over ≥ 2000 DISTINCT tile keys,
      // planner only, no bakes.
      const seed = seeds[0]
      const sweep = plannerKeySweep(planner, tile, seed, profile, config)
      expect(sweep.keys).toBe(PLANNER_KEYS)
      expect(sweep.nulls).toBe(0)
      expect(sweep.ruleErrors).toEqual([])
      // Ids unique in a 9×9-tile window, all with bit 31.
      const sp = spawnOf(seed)
      const ids = new Map()
      const stx = Math.floor(sp.cx / tile.w)
      const stz = Math.floor(sp.cz / tile.d)
      const bands = new Set(tileKeysIn(tile, W(seed)).map((k) => k.band))
      for (let tz = stz - 4; tz <= stz + 4; tz++) {
        for (let tx = stx - 4; tx <= stx + 4; tx++) {
          for (const band of bands) {
            const k = tileKeyAt(tile, tx, tz, band)
            if (!k) continue
            for (const s of planner.structuresInTile(seed, k, profile, config)) {
              expect(s.id >>> 0, `id of ${tx},${tz},${band} slot ${s.slot}`).toBeGreaterThanOrEqual(0x80000000)
              expect(ids.get(s.id), `duplicate id ${s.id}`).toBeUndefined()
              ids.set(s.id, `${tx},${tz},${band}`)
            }
          }
        }
      }
      metrics.structures = ids.size
    }, 120_000)

    // 7. Spawn --------------------------------------------------------------------------
    it('7. spawn: storey 0, walkable, spawnCellOk, clearings ignored', () => {
      for (const seed of seeds) {
        const sp = spawnOf(seed)
        expect(sp.cy, 'the hook returns no storey (I7)').toBeUndefined()
        expect(sp.clearings).toEqual([])
        const d = sourceFor(seed).chunkAt(sp.cx, 0, sp.cz)
        expect(cellWalkable(d, sp.lx, sp.lz)).toBe(true)
        expect(spawnCellOk(d, sp.lx, sp.lz)).toBe(true)
        expect(sp.x).toBeCloseTo(sp.cx * CHUNK_WORLD + (sp.lx + 0.5) * CELL)
        const plain = chunkPrint(generateChunk(seed, sp.cx, 0, sp.cz, config, null, null))
        expect(chunkPrint(generateChunk(seed, sp.cx, 0, sp.cz, config, null, []))).toBe(plain)
        expect(chunkPrint(generateChunk(seed, sp.cx, 0, sp.cz, config, null, LEGACY_SPAWN.clearings))).toBe(plain)
      }
    })

    // 8. Exit and reachability ------------------------------------------------------
    it('8. exit hook and reachability proof', () => {
      const hooks = hookOf(id)
      expect(hooks).toBeTruthy()
      const exitHook = familyExitHook(config)
      const reachSeeds = [...seeds, ...Array.from({ length: 16 }, (_, i) => hashStr(`reach-${id}-${i}`))].slice(0, reachSeedCount)
      let maxSteps = 0
      for (const seed of reachSeeds) {
        // The suite's seeds reuse their window source (chunks are pure in
        // their coordinates, item 2); the extra SLOW seeds start cold.
        const src = seeds.includes(seed) ? sourceFor(seed) : worldSource(seed, config, { cache: new Map() })
        const sp = spawnOf(seed)
        for (const level of reachLevels) {
          let ex = null
          expect(() => {
            ex = exitHook({ worldSeed: seed, level, config, profile, generate: (cx, cy, cz) => src.chunkAt(cx, cy, cz) })
          }, `exit hook seed ${seed} level ${level}`).not.toThrow()
          const { minChunks, maxChunks, cy } = hooks.exitBounds
          const dist = Math.max(Math.abs(ex.cx - sp.cx), Math.abs(ex.cz - sp.cz))
          expect(dist, `exit distance seed ${seed}`).toBeGreaterThanOrEqual(minChunks)
          expect(dist).toBeLessThanOrEqual(maxChunks)
          expect(ex.cy).toBeGreaterThanOrEqual(cy[0])
          expect(ex.cy).toBeLessThanOrEqual(cy[1])
          const d = src.chunkAt(ex.cx, ex.cy, ex.cz)
          expect(cellWalkable(d, ex.lx, ex.lz), `exit cell walkable seed ${seed}`).toBe(true)
          expect(exitCellClear(d, ex.lx, ex.lz)).toBe(true)
          const box = hooks.proofBox(hooks.exitAnchor(seed, profile), sp)
          const proof = proveReachable(src, spawnCell(sp), { gx: ex.cx * CHUNK + ex.lx, gz: ex.cz * CHUNK + ex.lz, cy: ex.cy }, box)
          expect(proof.ok, `reachability seed ${seed} level ${level}: ${proof.reason}`).toBe(true)
          maxSteps = Math.max(maxSteps, proof.steps)
        }
      }
      // §8.2: a real hook must export the counter (absent counts as 0 only
      // for the stub world).
      if (gen.stub === false) {
        expect(hooks.exitHookStats, `${id} hooks export exitHookStats`).toBeTypeOf('object')
        expect(hooks.exitHookStats).not.toBeNull()
        expect(Number.isInteger(hooks.exitHookStats.lastResort), 'exitHookStats.lastResort is an integer').toBe(true)
        expect(hooks.exitHookStats.lastResort).toBe(0)
      } else {
        expect(hooks.exitHookStats?.lastResort ?? 0).toBe(0)
      }
      metrics.reachMaxSteps = maxSteps
    }, 120_000)

    // 9. Identity ---------------------------------------------------------------------
    it('9. identity: lamp caps, tints, glyphs, prop kinds, wall bytes vs the base family', () => {
      const seed = seeds[0]
      const b = W(seed)
      const src = sourceFor(seed)
      const lampsOf = (cx, cy, cz) => src.chunkAt(cx, cy, cz).lamps.filter((l) => l.lit)
      let propMax = 0
      let propSum = 0
      let chunks = 0
      for (const [cx, cy, cz] of boxChunks(b)) {
        const d = src.chunkAt(cx, cy, cz)
        const lit = lampsOf(cx, cy, cz)
        expect(lit.length, `lit lamps ${cx},${cy},${cz}`).toBeLessThanOrEqual(LAMP_CAP_CHUNK)
        // Lit lamps within 60 u of the chunk centre (same storey).
        const ox = (cx + 0.5) * CHUNK_WORLD
        const oz = (cz + 0.5) * CHUNK_WORLD
        let near = 0
        const r = Math.ceil(60 / CHUNK_WORLD) + 1
        for (let nz = cz - r; nz <= cz + r; nz++) {
          for (let nx = cx - r; nx <= cx + r; nx++) {
            for (const l of lampsOf(nx, cy, nz)) {
              const x = nx * CHUNK_WORLD + (l.lx + 0.5) * CELL
              const z = nz * CHUNK_WORLD + (l.lz + 0.5) * CELL
              if (Math.hypot(x - ox, z - oz) <= 60) near++
            }
          }
        }
        expect(near, `lit lamps within 60 u of ${cx},${cy},${cz}`).toBeLessThanOrEqual(LAMP_CAP_60U)
        for (const l of d.lamps) {
          if (l.tint !== undefined) expect(Number.isInteger(l.tint) && l.tint >= 0 && l.tint <= 0xffffff, `tint ${l.tint}`).toBe(true)
        }
        if (d.levelLabel != null) {
          for (const ch of String(d.levelLabel)) expect(Object.hasOwn(NUMERAL_GLYPHS, ch), `glyph '${ch}' at ${cx},${cy},${cz}`).toBe(true)
        }
        const kinds = new Set(d.furniture.map((f) => f.kind)).size
        propMax = Math.max(propMax, kinds)
        propSum += kinds
        chunks++
        for (let i = 0; i < d.cols.length; i++) {
          if (d.cols[i] === COLUMN_FURNITURE) expect(d.furniture.length, `furniture column without records ${cx},${cy},${cz}`).toBeGreaterThan(0)
        }
      }
      expect(propMax).toBeLessThanOrEqual(PROP_KIND_CAP)
      metrics.propKindsMax = propMax
      metrics.propKindsMean = +(propSum / Math.max(1, chunks)).toFixed(2)
      // Wall bytes differ from the base family's by more than 2%.
      const base = familyRecord(id).base
      const baseConfig = forcedFamilyConfig(base)
      let diff = 0
      let total = 0
      for (const [cx, cy, cz] of boxChunks(b)) {
        const a = src.chunkAt(cx, cy, cz)
        const o = generateChunk(seed, cx, cy, cz, baseConfig)
        for (const f of ['wallV', 'wallH']) {
          for (let i = 0; i < a[f].length; i++) {
            total++
            if (a[f][i] !== o[f][i]) diff++
          }
        }
      }
      metrics.wallDiff = +(diff / total).toFixed(4)
      expect(diff / total).toBeGreaterThan(WALL_DIFF_MIN)
    }, 120_000)

    // 10. Budget -------------------------------------------------------------------------
    it('10. budget: mean chunk, max bake and solid chunk times (×3 slack)', () => {
      const seed = seeds[0]
      const sp = spawnOf(seed)
      const box = { x0: sp.cx - 4, x1: sp.cx + 4, z0: sp.cz - 4, z1: sp.cz + 4, y0: -1, y1: 1 }
      // Mean chunk time over the box from a cold tile cache.
      const meanPass = () => {
        tileCache.clear()
        let total = 0
        let n = 0
        for (const [cx, cy, cz] of boxChunks(box)) {
          const t = performance.now()
          generateChunk(seed, cx, cy, cz, config)
          total += performance.now() - t
          n++
        }
        return total / n
      }
      const keys = tileKeysIn(tile, box)
      const mean = retimed(meanPass(), BUDGET.meanChunkMs, meanPass)
      // The first measurements are reported beside the gated ones, so a
      // regression the retries absorb still shows in FAMILY_REPORT.
      // Bake times of the pass that left the cache warm; a tile over budget
      // is baked again, fresh, before it counts.
      const firstBakes = keys.map((k) => tileBakeAt(seed, k, config).ms)
      let bakeRetries = 0
      const bakes = keys.map((k, i) => {
        const r = retimed(firstBakes[i], BUDGET.maxBakeMs, () => {
          tileCache.clear()
          return tileBakeAt(seed, k, config).ms
        })
        bakeRetries += r.retries
        return r.value
      }).sort((a, b) => a - b)
      const maxBake = bakes.length ? bakes[bakes.length - 1] : 0
      metrics.meanChunkMs = +mean.value.toFixed(3)
      metrics.firstMeanChunkMs = +mean.first.toFixed(3)
      metrics.firstMaxBakeMs = +(firstBakes.length ? Math.max(...firstBakes) : 0).toFixed(2)
      metrics.maxBakeMs = +maxBake.toFixed(2)
      metrics.budgetRetries = mean.retries + bakeRetries
      metrics.p95BakeMs = bakes.length ? +bakes[Math.min(bakes.length - 1, Math.ceil(bakes.length * 0.95) - 1)].toFixed(2) : 0
      // A solid chunk: the first chunk of the box whose footprint is solid.
      let solid = null
      for (const [cx, cy, cz] of boxChunks({ ...box, y0: -3, y1: 3 })) {
        const k = tileKeyOf(tile, cx, cy, cz)
        if (!k || gen.footprint(seed, cx, cy, cz, profile) !== 'tile') {
          solid = [cx, cy, cz]
          break
        }
      }
      if (solid) {
        generateChunk(seed, ...solid, config)
        const reps = 200
        const solidPass = () => {
          const t = performance.now()
          for (let i = 0; i < reps; i++) generateChunk(seed, ...solid, config)
          return (performance.now() - t) / reps
        }
        const r = retimed(solidPass(), BUDGET.solidChunkMs, solidPass)
        metrics.budgetRetries += r.retries
        metrics.solidChunkMs = +r.value.toFixed(4)
        metrics.firstSolidChunkMs = +r.first.toFixed(4)
        expect(metrics.solidChunkMs).toBeLessThanOrEqual(BUDGET.solidChunkMs)
      }
      expect(metrics.meanChunkMs).toBeLessThanOrEqual(BUDGET.meanChunkMs)
      expect(metrics.maxBakeMs).toBeLessThanOrEqual(BUDGET.maxBakeMs)
    }, 120_000)

    // 11. Goldens -----------------------------------------------------------------------
    it.skipIf(!goldens?.digests)('11. goldens: every pinned coordinate matches', () => {
      for (const entry of goldens.coords) {
        const [seed, cx, cy, cz] = Array.isArray(entry) ? entry : [entry.seed, entry.cx, entry.cy, entry.cz]
        const key = (!Array.isArray(entry) && entry.key) || `${seed},${cx},${cy},${cz}`
        expect(digestChunk(generateChunk(seed, cx, cy, cz, config), { version: PINNED_VERSION }), key).toBe(goldens.digests[key])
      }
    })

    it('file budget (fails over 10 s only under SLOW=1)', () => {
      const ms = performance.now() - started
      // Over the wall-clock budget only counts when the file's own CPU time
      // is over it too: a loaded machine stretches wall time, not work.
      if (SLOW && ms > BUDGET.fileMs) {
        const slack = loadSlack()
        expect(cpuMs() - startedCpu, `file wall ${Math.round(ms)} ms; CPU time (load slack ×${slack.toFixed(2)})`).toBeLessThanOrEqual(BUDGET.fileMs * slack)
      }
    })
  })
}
