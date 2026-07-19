import { DEFAULT_WORLD_CONFIG } from './config.js'
import {
  LATTICE_STRUCTURE_KIND,
  latticeStructureAt,
} from './lattice.js'
import { deepFreeze, resolveMapFamily } from './mapFamily.js'
import {
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_TOWER,
} from './mapTypes.js'
import { multilevelStructureAt } from './multilevel.js'
import { TOWER_STRUCTURE_KIND, towerStructureAt } from './tower.js'

export const STRUCTURE_KIND_OFFICE = 'officeMultilevel'
export const STRUCTURE_KIND_TOWER = TOWER_STRUCTURE_KIND
export const STRUCTURE_KIND_LATTICE = LATTICE_STRUCTURE_KIND

const LEGACY_OFFICE_STRUCTURE_KINDS = Object.freeze([
  'bridged',
  'openVoid',
  STRUCTURE_KIND_OFFICE,
])

const hasOwn = (value, key) =>
  value !== null &&
  typeof value === 'object' &&
  Object.prototype.hasOwnProperty.call(value, key)

export function structureFamily(structure) {
  return hasOwn(structure, 'family') && structure.family !== undefined
    ? structure.family
    : MAP_FAMILY_OFFICE
}

export function structureKind(structure) {
  const family = structureFamily(structure)
  const kind = structure?.kind ?? null
  if (
    family === MAP_FAMILY_OFFICE &&
    LEGACY_OFFICE_STRUCTURE_KINDS.includes(kind)
  ) {
    return STRUCTURE_KIND_OFFICE
  }
  return kind
}

// Canonical participant arrays sort by (cz, cx). Consumers import this one
// comparator rather than silently choosing a different coordinate priority.
export function compareStructureParticipants(a, b) {
  return a.cz - b.cz || a.cx - b.cx
}

function noStructure(family, levelCy) {
  return deepFreeze({ family, levelCy, hasRoom: false })
}

// Resolve the selected family's canonical descriptor without consulting
// generated ChunkData. Tower planning is still release-inert: only a valid,
// explicitly enabled forced profile can reach it until the activation gate.
export function structureAt(
  seed,
  cx,
  cz,
  cy,
  config = DEFAULT_WORLD_CONFIG
) {
  const profile = resolveMapFamily(config)
  const { family } = profile
  const structure = family === MAP_FAMILY_OFFICE
    ? multilevelStructureAt(seed, cx, cz, cy, config)
    : family === MAP_FAMILY_TOWER
      ? towerStructureAt(seed, cx, cz, cy, profile) ?? noStructure(family, cy)
      : family === MAP_FAMILY_LATTICE
        ? latticeStructureAt(seed, cx, cz, cy, profile) ?? noStructure(family, cy)
    : noStructure(family, cy)
  return deepFreeze(structure)
}

// Canonical ownership is evidence from a family lookup, not an inference from
// a descriptor's non-empty participant list. The identity field is always
// `id`; legacy `canonicalId` aliases are deliberately not projected here.
export function structureOwnershipAt(
  seed,
  cx,
  cz,
  cy,
  config = DEFAULT_WORLD_CONFIG
) {
  const structure = structureAt(seed, cx, cz, cy, config)
  const ownsChunk = structure?.hasRoom === true &&
    Array.isArray(structure.participants) &&
    structure.participants.some(
      (participant) => participant?.cx === cx && participant?.cz === cz
    )
  if (!ownsChunk) return null

  return deepFreeze({
    cx,
    cz,
    id: structure.id,
    family: structureFamily(structure),
    baseCy: structure.baseCy,
    topCy: structure.topCy,
  })
}
