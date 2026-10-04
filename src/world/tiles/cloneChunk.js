import { ChunkData } from '../ChunkData.js'

// A copy of the editor document's chunk clone (editor/EditorMap.js
// cloneChunkData, CHUNK_DESCRIPTORS), so the world's tile cache can hand out
// slices without importing src/editor. EditorMap keeps its own copy; the
// clone-coverage test pins both to every ChunkData field.

const RASTERS = [
  'wallV', 'wallH', 'passageV', 'passageH',
  'wallFeatureV', 'wallFeatureH', 'cols', 'cellKind', 'spaceId', 'spaceRole',
]

// Descriptor carriers preserved (shared, frozen) by a clone.
export const CHUNK_DESCRIPTORS = [
  'stairUp', 'stairDown', 'sewerDescriptor',
  'structure', 'structureUp', 'structureDown', 'lethalVoidUp', 'lethalVoidDown',
]

// The seam ring is never copied, and the stair stamp's edge protection
// (_protV/_protH) is per-build scratch state: a clone starts with neither.
export function cloneChunkData(d) {
  const copy = new ChunkData(d.cx, d.cy, d.cz, d.zone, d.version, d.mapFamily)
  for (const f of RASTERS) copy[f].set(d[f])
  copy.lamps = d.lamps.map((l) => ({ ...l }))
  copy.furniture = d.furniture.map((f) => ({ ...f }))
  copy.exit = d.exit ? { ...d.exit } : null
  for (const f of CHUNK_DESCRIPTORS) copy[f] = d[f] // frozen/shared descriptors
  copy.repairs = { ...d.repairs }
  // Finish-schedule context (world/surfaceSet.js; the .yrmap finish section).
  if (d.spaceClass) copy.spaceClass.set(d.spaceClass)
  copy.district = d.district ? { ...d.district } : null
  copy.worldSeed = d.worldSeed ?? 0
  // Authored-kind extras (the .yrmap extras section).
  copy.levelLabel = d.levelLabel ?? null
  copy.authoredFeatures = !!d.authoredFeatures
  return copy
}

// Record fields that hold a spaceId, which a tile bake's id remap must
// rewrite with the cells (spec §6.6 step 3). Furniture and lamp records hold
// none; a canvas room record's `id` is its spaceId (rooms live on the canvas
// only and are never exported with a chunk). Pinned by clone-coverage.test.
export const SPACE_ID_RECORD_FIELDS = Object.freeze({
  furniture: Object.freeze([]),
  lamps: Object.freeze([]),
  rooms: Object.freeze(['id']),
})
