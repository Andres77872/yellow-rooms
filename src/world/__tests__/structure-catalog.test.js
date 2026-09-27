import { describe, expect, it } from 'vitest'
import { hash3i, hashStr } from '../core/hash.js'
import { buildChunk } from '../pipeline.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { auditLayeredPatch } from '../audit.js'
import { countChunkComponents } from '../topology.js'
import {
  structureAdapterFor,
  structureAt,
  validatedRuntimeStructure,
} from '../structures/contract.js'
import { chunkStairs } from '../structures/slab.js'
import {
  CATALOG_KINDS,
  CATALOG_RECIPES,
  CATALOG_SIZE_CLASSES,
  analyzeCatalogDescriptor,
  assembleCatalogDescriptor,
  catalogStructureSlice,
  footprintBox,
  isCatalogStructure,
} from '../structures/catalog/index.js'
import { FAMILY_SKELETONS } from '../mapFamily.js'

const FAMILIES = ['office', 'hotel', 'sewer', 'tower', 'lattice']
const configs = Object.fromEntries(FAMILIES.map((f) => [f, worldConfigForFamily(f)]))

// Every catalog structure of a family inside a chunk window (deduped by id).
function scan(family, seed, { r = 5, y0 = -2, y1 = 8 } = {}) {
  const found = new Map()
  for (let cy = y0; cy <= y1; cy++) {
    for (let cz = -r; cz <= r; cz++) {
      for (let cx = -r; cx <= r; cx++) {
        const s = structureAt(seed, cx, cz, cy, configs[family])
        if (isCatalogStructure(s)) found.set(s.id, s)
      }
    }
  }
  return [...found.values()]
}

function recipeContext(family, recipe, dims, levels, tr, seed) {
  const [w, d] = dims
  const rnd = (salt) => hash3i(seed, salt, tr, levels) >>> 0
  return {
    family, sizeClass: recipe.sizeClass, type: recipe.type, cx0: -3, cz0: 5, w, d, levels, baseCy: 2,
    box: footprintBox(-3, 5, w, d),
    rand: rnd,
    int: (lo, hi, salt) => lo + (rnd(salt) % (hi - lo + 1)),
    chance: (p, salt) => salt === 0x71 ? !!(tr & 1) : salt === 0x72 ? !!(tr & 2) : salt === 0x73 ? !!(tr & 4) : (rnd(salt) % 10000) / 10000 < p,
    pick: (arr, salt) => arr[rnd(salt) % arr.length],
  }
}

describe('structure catalog (v26)', () => {
  it('gives every family small, medium and large types of its own', () => {
    const types = new Set()
    for (const family of FAMILIES) {
      const recipes = CATALOG_RECIPES[family]
      for (const size of CATALOG_SIZE_CLASSES) {
        expect(recipes.filter((r) => r.sizeClass === size).length, `${family} ${size}`).toBeGreaterThanOrEqual(2)
      }
      for (const r of recipes) {
        expect(types.has(r.type), `${r.type} is unique to one family`).toBe(false)
        types.add(r.type)
      }
    }
    expect(types.size).toBeGreaterThanOrEqual(35)
  })

  it('assembles every recipe in every orientation and height, or fails closed', () => {
    let built = 0
    let total = 0
    for (const family of FAMILIES) {
      for (const recipe of CATALOG_RECIPES[family]) {
        for (const dims of recipe.chunks) {
          for (const levels of new Set([recipe.levels[0], recipe.levels[1]])) {
            for (let tr = 0; tr < 8; tr++) {
              total++
              const plan = recipe.build(recipeContext(family, recipe, dims, levels, tr, 7))
              let n = 0
              const desc = plan && assembleCatalogDescriptor(plan, {
                id: 99, family, type: recipe.type, sizeClass: recipe.sizeClass,
                district: { x: 0, z: 0, size: 4 }, bandIndex: 0, slot: 0, baseCy: 2,
              }, (k) => hash3i(7, n++, k, tr) % k)
              if (!desc) continue
              built++
              expect(analyzeCatalogDescriptor(desc)).toEqual({ ok: true, reasons: [] })
              expect(Object.isFrozen(desc)).toBe(true)
              // One flight per slab at least, every one inside a participant.
              for (let lowerCy = desc.baseCy; lowerCy < desc.topCy; lowerCy++) {
                expect(desc.verticalLinks.some((l) => l.lowerCy === lowerCy)).toBe(true)
              }
            }
          }
        }
      }
    }
    // Designs are fail-closed by construction; nearly all orientations build.
    expect(built / total).toBeGreaterThan(0.97)
  })

  it('places a varied, deterministic catalog in every family, clear of the spawn hub', () => {
    const seed = hashStr('catalog-test')
    for (const family of FAMILIES) {
      const list = scan(family, seed)
      const sizes = new Set(list.map((s) => s.sizeClass))
      const types = new Set(list.map((s) => s.type))
      expect(list.length, family).toBeGreaterThan(15)
      expect([...sizes].sort(), family).toEqual([...CATALOG_SIZE_CLASSES].sort())
      expect(types.size, family).toBeGreaterThanOrEqual(5)
      for (const s of list) {
        expect(s.family).toBe(family)
        expect(s.kind).toBe(CATALOG_KINDS[family])
        // Same object from every participant and storey.
        for (const p of s.participants) {
          for (let cy = s.baseCy; cy <= s.topCy; cy++) {
            expect(structureAt(seed, p.cx, p.cz, cy, configs[family])).toBe(s)
          }
        }
        const spawn = s.participants.some((p) => Math.abs(p.cx) <= 1 && Math.abs(p.cz) <= 1)
        if (spawn) expect(s.baseCy > 0 || s.topCy < 0).toBe(true)
      }
    }
  })

  it('registers every catalog kind with a runtime adapter that accepts it on every storey', () => {
    const seed = hashStr('catalog-runtime')
    for (const family of FAMILIES) {
      for (const s of scan(family, seed, { r: 4, y0: 0, y1: 5 }).slice(0, 6)) {
        const adapter = structureAdapterFor(s)
        expect(adapter?.kind).toBe(CATALOG_KINDS[family])
        for (let cy = s.baseCy; cy <= s.topCy; cy++) {
          const verdict = validatedRuntimeStructure(seed, configs[family], s, cy)
          expect(verdict, `${family} ${s.type} cy ${cy}`).not.toBeNull()
          for (const p of s.participants) {
            if (cy < s.topCy) {
              const slice = catalogStructureSlice(s, p.cx, p.cz, cy)
              expect(adapter.validateSlice(slice, s, { ownership: verdict.ownership }).ok).toBe(true)
            }
          }
        }
      }
    }
  })

  it('stamps matching slab halves, guarded voids and a walkable volume in every family', () => {
    const seed = hashStr('catalog-audit')
    for (const family of FAMILIES) {
      const list = scan(family, seed, { r: 4, y0: -1, y1: 6 })
      // One of each size class per family keeps the suite fast.
      const picks = CATALOG_SIZE_CLASSES.map((c) => list.find((s) => s.sizeClass === c)).filter(Boolean)
      expect(picks.length, family).toBeGreaterThanOrEqual(2)
      for (const s of picks) {
        const cache = new Map()
        const at = (cx, cy, cz) => {
          const k = `${cx},${cy},${cz}`
          if (!cache.has(k)) cache.set(k, buildChunk(seed, cx, cy, cz, configs[family]))
          return cache.get(k)
        }
        const xs = s.participants.map((p) => p.cx)
        const zs = s.participants.map((p) => p.cz)
        const X0 = Math.min(...xs)
        const Z0 = Math.min(...zs)
        const NX = Math.max(...xs) - X0 + 1
        const NZ = Math.max(...zs) - Z0 + 1
        const audit = auditLayeredPatch(at, X0, s.baseCy, Z0, NX, s.levelCount, NZ)
        const label = `${family} ${s.type} (${s.sizeClass})`
        for (const counter of [
          'mismatchedDescriptors', 'holeMismatches', 'orphanedHalves', 'invalidCanonicalLinks',
          'mismatchedMultilevelDescriptors', 'orphanedMultilevelHalves', 'invalidMultilevelRooms',
          'strayWallFeatures', 'invalidMultilevelStructures', 'missingMultilevelSlices',
          'familyAdapterFailures', 'kindAdapterFailures', 'familyDescriptorFailures',
        ]) {
          expect(audit[counter], `${label}: ${counter} ${JSON.stringify(audit.details?.[counter]?.slice?.(0, 3) ?? '')}`).toBe(0)
        }
        // Every stamped storey carries the descriptor and both halves agree.
        for (const p of s.participants) {
          for (let cy = s.baseCy; cy < s.topCy; cy++) {
            const lower = at(p.cx, cy, p.cz)
            const upper = at(p.cx, cy + 1, p.cz)
            expect(lower.structure).toBe(s)
            expect(JSON.stringify(lower.structureUp)).toBe(JSON.stringify(upper.structureDown))
          }
        }
        // Reachability: every walkable cell of the structure's chunks joins
        // one component, except pockets that continue outside the patch
        // (they touch its boundary floors or sides).
        expect(audit.connected || audit.components <= 1 || audit.disconnectedCells < audit.walkableCells * 0.05, label).toBe(true)
      }
    }
  })

  it('never strands a chunk: every stamped storey is one component on its own', () => {
    const seed = hashStr('catalog-chunks')
    for (const family of FAMILIES) {
      for (const s of scan(family, seed, { r: 4, y0: 0, y1: 4 }).slice(0, 5)) {
        for (const p of s.participants) {
          for (let cy = s.baseCy; cy <= s.topCy; cy++) {
            const d = buildChunk(seed, p.cx, cy, p.cz, configs[family])
            // Column-aware, holes excluded: the same contract the topology
            // repair and the sewer candidate validation enforce.
            const components = countChunkComponents(d, true)
            expect(components, `${family} ${s.type} chunk ${p.cx},${cy},${p.cz}`).toBe(1)
          }
        }
      }
    }
  })

  it('keeps a stair on every slab of every stair district', () => {
    const seed = hashStr('catalog-stairs')
    for (const family of ['office', 'hotel', 'tower', 'lattice']) {
      const config = configs[family]
      for (let cy = -1; cy <= 4; cy++) {
        for (let dz = -1; dz <= 0; dz++) {
          for (let dx = -1; dx <= 0; dx++) {
            let stairs = 0
            let reserved = 0
            for (let lz = 0; lz < 4; lz++) {
              for (let lx = 0; lx < 4; lx++) {
                const cx = dx * 4 + lx
                const cz = dz * 4 + lz
                if (chunkStairs(seed, cx, cz, cy, config).up.hasStair) stairs++
                const s = structureAt(seed, cx, cz, cy, config)
                if (s?.hasRoom) reserved++
              }
            }
            // A full landmark district (lattice) owns its own flights.
            if (reserved < 16) expect(stairs, `${family} district ${dx},${dz} slab ${cy}`).toBeGreaterThan(0)
          }
        }
      }
    }
  })

  it('projects a distinct skeleton for every non-office family', () => {
    for (const [family, skeleton] of Object.entries(FAMILY_SKELETONS)) {
      const config = configs[family]
      expect(config.region.salt).toBe((configs.office.region.salt ^ skeleton.salt) | 0)
      expect(config.stairs.salt).toBe((configs.office.stairs.salt ^ skeleton.salt) | 0)
    }
    expect(configs.hotel.office.districtChunks).not.toBe(configs.office.office.districtChunks)
    expect(configs.tower.office.portals.width).toBeGreaterThan(1)
  })
})
