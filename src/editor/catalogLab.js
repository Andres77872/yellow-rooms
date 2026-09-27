import { CHUNK, cIdx, chunkKey3 } from '../world/constants.js'
import { CELL_LOBBY, CELL_STAIR } from '../world/mapTypes.js'
import { generateChunk } from '../world/generate.js'
import { hash3i, hashStr } from '../world/core/hash.js'
import { worldConfigForFamilyOrOffice } from '../world/mapFamily.js'
import { structureAt } from '../world/structures/contract.js'
import {
  CATALOG_RECIPES,
  CATALOG_SIZE_CLASSES,
  assembleCatalogDescriptor,
  footprintBox,
  isCatalogStructure,
} from '../world/structures/catalog/index.js'
import { stampCatalogStructure } from '../world/structures/catalog/stamp.js'
import { seedFromText } from './EditorMap.js'
import { dropRoomsIn } from './templates.js'

// The editor's view of the v26 structure catalog: what each family can
// place (its landmark planner + its procedural small/medium/large types),
// where the nearest real instance of a type is in a world, and how to stamp
// one exact recipe into the document for study or editing.

// Landmark planners that predate the catalog (one per district/band).
export const FAMILY_LANDMARKS = Object.freeze({
  office: [
    { type: 'openVoid', label: 'open shaft (atrium)', sizeClass: 'landmark', levels: [4, 15], about: 'A two-chunk shaft through up to 15 storeys, glazed at every gallery.', reference: 'Office atria (v13)', match: (s) => s.kind === 'openVoid' },
    { type: 'bridged', label: 'bridged atrium', sizeClass: 'landmark', levels: [4, 15], about: 'A two-chunk atrium with a guarded bridge on alternating storeys.', reference: 'Office atria (v13)', match: (s) => s.kind === 'bridged' },
  ],
  hotel: [
    { type: 'openVoid', label: 'hotel light shaft', sizeClass: 'landmark', levels: [5, 13], about: 'The hotel’s own tall shaft (wider, shorter than the office’s).', reference: 'Atrium hotels', match: (s) => s.kind === 'openVoid' },
    { type: 'bridged', label: 'hotel bridged atrium', sizeClass: 'landmark', levels: [5, 13], about: 'The hotel’s tall atrium with bridges on alternating storeys.', reference: 'Atrium hotels', match: (s) => s.kind === 'bridged' },
  ],
  sewer: [],
  tower: [
    { type: 'nave', label: 'nave', sizeClass: 'landmark', levels: [3, 3], about: 'A 24×6 nave over a lethal floor, skybridge and stairs.', reference: 'Tower landmarks (v25)', match: (s) => s.architecture?.form === 'nave' },
    { type: 'splitCourt', label: 'split court', sizeClass: 'landmark', levels: [3, 3], about: 'A 20×10 court with a transverse upper gallery.', reference: 'Tower landmarks (v25)', match: (s) => s.architecture?.form === 'splitCourt' },
    { type: 'overlookCourt', label: 'overlook court', sizeClass: 'landmark', levels: [3, 3], about: 'A 22×8 court with alternating terraces.', reference: 'Tower landmarks (v25)', match: (s) => s.architecture?.form === 'overlookCourt' },
  ],
  lattice: [
    { type: 'latticeDistrict', label: 'catwalk district', sizeClass: 'landmark', levels: [5, 5], about: 'A 4×4-chunk, five-floor terraced catwalk block over lethal drops.', reference: 'Lattice districts (v24)', match: (s) => s.kind === 'latticeDistrict' },
  ],
})

// Every type a family can place: landmarks first, then small → large.
export function familyCatalog(family) {
  const landmarks = (FAMILY_LANDMARKS[family] ?? []).map((l) => ({ ...l, family, landmark: true, chunks: [[2, 1]] }))
  const recipes = (CATALOG_RECIPES[family] ?? [])
    .map((r) => ({
      family,
      type: r.type,
      label: labelFor(r),
      sizeClass: r.sizeClass,
      levels: r.levels,
      chunks: r.chunks,
      about: r.about,
      reference: r.reference,
      weight: r.weight,
      landmark: false,
      match: (s) => s.type === r.type,
    }))
    .sort((a, b) => CATALOG_SIZE_CLASSES.indexOf(a.sizeClass) - CATALOG_SIZE_CLASSES.indexOf(b.sizeClass))
  return [...landmarks, ...recipes]
}

// Human label from a dry design (labels live on designs, not recipes).
const LABELS = new Map()
function labelFor(recipe) {
  const key = `${recipe.family}:${recipe.type}`
  if (LABELS.has(key)) return LABELS.get(key)
  let label = recipe.type
  try {
    const plan = recipe.build(dryContext(recipe, 0, 0, recipe.chunks[0], recipe.levels[0], 1))
    label = plan?.label ?? label
  } catch {
    // Designs are pure; a failing dry build only costs the pretty label.
  }
  LABELS.set(key, label)
  return label
}

function dryContext(recipe, cx0, cz0, [w, d], levels, seed, baseCy = 0) {
  const rnd = (salt) => hash3i(seed | 0, salt | 0, cx0 * 31 + cz0, levels) >>> 0
  return {
    family: recipe.family,
    sizeClass: recipe.sizeClass,
    type: recipe.type,
    cx0, cz0, w, d, levels, baseCy,
    box: footprintBox(cx0, cz0, w, d),
    rand: rnd,
    int: (lo, hi, salt) => lo + (rnd(salt) % (hi - lo + 1)),
    chance: (p, salt) => (rnd(salt) % 10000) / 10000 < p,
    pick: (arr, salt) => arr[rnd(salt) % arr.length],
  }
}

// Nearest real instance of a catalog entry in a family's world: rings of
// chunks outward from (cx, cz), storeys within ±dy of cy. Returns the
// descriptor or null. Pure lookups (cached planners) — no chunk generation.
export function findNearestInWorld(entry, seedText, from, { radius = 16, dy = 12 } = {}) {
  const { config } = worldConfigForFamilyOrOffice(entry.family)
  const seed = seedFromText(seedText)
  for (let r = 0; r <= radius; r++) {
    const hits = []
    for (let cz = from.cz - r; cz <= from.cz + r; cz++) {
      for (let cx = from.cx - r; cx <= from.cx + r; cx++) {
        if (Math.max(Math.abs(cx - from.cx), Math.abs(cz - from.cz)) !== r) continue
        // Tall volumes span >= 2 storeys: sampling every other floor is enough.
        for (let d = 0; d <= dy; d += 2) {
          for (const cy of d ? [from.cy + d, from.cy - d] : [from.cy]) {
            const s = structureAt(seed, cx, cz, cy, config)
            if (s?.hasRoom && entry.match(s)) hits.push({ s, d })
          }
        }
      }
    }
    if (hits.length) {
      hits.sort((a, b) => a.d - b.d || a.s.id - b.s.id)
      return { structure: hits[0].s, seed, family: entry.family }
    }
  }
  return null
}

// Stamp one exact recipe into the document at chunk (cx0, cz0), storeys
// baseCy.. (levels, clamped to the recipe). Every chunk-storey it needs must
// be free of other structures. Undoable (one mutation). Returns
// { ok, structure } or { ok:false, error }.
export function stampRecipeIntoDocument(map, family, type, { cx0, cz0, baseCy, levels = null, variant = 0, dims = null }) {
  const recipe = (CATALOG_RECIPES[family] ?? []).find((r) => r.type === type)
  if (!recipe) return { ok: false, error: `unknown ${family} structure type ${type}` }
  const chunkDims = dims ?? recipe.chunks[0]
  const n = Math.max(recipe.levels[0], Math.min(recipe.levels[1], levels ?? Math.round((recipe.levels[0] + recipe.levels[1]) / 2)))
  const seed = hashStr(`doc:${family}:${type}:${variant}`)
  const ctx = dryContext(recipe, cx0, cz0, chunkDims, n, seed, baseCy)
  const plan = recipe.build(ctx)
  if (!plan) return { ok: false, error: 'this orientation does not fit here' }
  const id = (hash3i(seed | 0, cx0, baseCy, cz0) >>> 0) || 1
  let k = 0
  const desc = assembleCatalogDescriptor(plan, {
    id,
    family,
    type,
    sizeClass: recipe.sizeClass,
    district: { x: Math.floor(cx0 / 4), z: Math.floor(cz0 / 4), size: 4 },
    bandIndex: 0,
    slot: -1,
    baseCy,
  }, (m) => hash3i(seed | 0, k++, m, 17) % m, null)
  if (!desc) return { ok: false, error: 'the recipe fails its invariants at this size — try another variant' }
  for (const p of desc.participants) {
    for (let cy = desc.baseCy; cy <= desc.topCy; cy++) {
      const d = map.chunkAt(p.cx, cy, p.cz)
      if (d?.structure || d?.structureUp || d?.structureDown) {
        return { ok: false, error: `chunk ${p.cx},${cy},${p.cz} already carries a structure` }
      }
    }
  }
  // Missing chunks get the family's real fabric (generated without any
  // structures), so a stamped volume always sits in context and family
  // carriers such as the sewer module descriptor are present.
  const { config } = worldConfigForFamilyOrOffice(family)
  const fabric = structuredClone(config)
  fabric.multilevel.enabled = false
  fabric.catalog = { ...(fabric.catalog ?? {}), enabled: false }
  const fabricSeed = (map.meta.seed >>> 0) || hashStr('lobby')
  map.mutate(() => {
    const b = desc.globalBounds
    dropRoomsIn(map, { x0: b.x0 - 1, z0: b.z0 - 1, x1: b.x1 + 1, z1: b.z1 + 1 }, desc.baseCy, desc.topCy)
    for (const p of desc.participants) {
      for (let cy = desc.baseCy; cy <= desc.topCy; cy++) {
        if (!map.chunkAt(p.cx, cy, p.cz)) {
          map._touch(p.cx, cy, p.cz, false)
          const d = generateChunk(fabricSeed, p.cx, cy, p.cz, fabric)
          // Tower/Lattice landmark planners cannot be switched off by config:
          // a context chunk that would carry one stays blank instead.
          const landmark = d.structure || d.structureUp || d.structureDown || d.lethalVoidUp || d.lethalVoidDown
          if (landmark) map.ensureChunk(p.cx, cy, p.cz)
          else map.chunks.set(chunkKey3(p.cx, cy, p.cz), d)
        }
      }
      // The generator reserves slabs baseCy-1 … topCy of every structure
      // column for the structure's own flights: drop generic stair halves
      // there (both halves, including partners just outside the band).
      for (let cy = desc.baseCy - 1; cy <= desc.topCy + 1; cy++) {
        const d = map.chunkAt(p.cx, cy, p.cz)
        if (!d) continue
        const stripUp = cy <= desc.topCy && d.stairUp
        const stripDown = cy >= desc.baseCy && d.stairDown
        if (!stripUp && !stripDown) continue
        map._touch(p.cx, cy, p.cz)
        for (const stair of [stripUp, stripDown].filter(Boolean)) {
          for (const c of [stair.landing, ...stair.run, stair.exit]) {
            const i = cIdx(c.lx, c.lz)
            if (d.cellKind[i] === CELL_STAIR) d.cellKind[i] = CELL_LOBBY
          }
        }
        if (stripUp) d.stairUp = null
        if (stripDown) d.stairDown = null
      }
    }
    for (const p of desc.participants) {
      for (let cy = desc.baseCy; cy <= desc.topCy; cy++) {
        const d = map._touch(p.cx, cy, p.cz)
        // Edge protection is transient generation state (meaningful inside
        // one chunk build only); stale entries — e.g. the guards of a stair
        // stripped above — must not survive into this carve.
        d._protV.clear()
        d._protH.clear()
        stampCatalogStructure(d, desc)
        // Lamps under the new openings would hang in mid-air.
        d.lamps = d.lamps.filter((l) => !d.hasCeilHole(l.lx, l.lz))
      }
    }
  })
  return { ok: true, structure: desc }
}

export const catalogChunkOf = (gx, gz) => ({ cx: Math.floor(gx / CHUNK), cz: Math.floor(gz / CHUNK) })
export { isCatalogStructure }
