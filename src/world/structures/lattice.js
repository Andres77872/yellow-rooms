import { CHUNK } from '../constants.js'
import { hash2i, hash3i } from '../core/hash.js'
import { deepFreeze } from '../mapFamily.js'
import { MAP_FAMILY_LATTICE } from '../mapTypes.js'
import {
  MAX_STRUCTURE_TOP_CY,
  STRUCTURE_VERTICAL_PERIOD,
  bandBaseAtLevel as sharedBandBaseAtLevel,
  bandIndexAtBase as sharedBandIndexAtBase,
  districtCoordinate as sharedDistrictCoordinate,
  plannerHash,
  polygonCandidates,
} from './districtBand.js'

export const LATTICE_STRUCTURE_KIND = 'latticeDistrict'

export const LATTICE_EDGE_ROLE_ORDER = Object.freeze([
  'backbone',
  'cycle',
  'spine',
  'vertical',
])

export const LATTICE_TREE_EDGE_ROLES = Object.freeze([
  'backbone',
  'spine',
  'vertical',
])

export const LATTICE_NETWORK_FIELDS = Object.freeze([
  'networkId',
  'networkEdges',
  'crossDistrictLinks',
  'linkedStructureIds',
  'interFamilyLinks',
])

export const LATTICE_ROOM_FIELDS = Object.freeze([
  'rooms',
  'roomBounds',
  'enclosedRooms',
  'enclosedRoomSlices',
])

export const LATTICE_RUNTIME_ENVELOPE_FIELDS = Object.freeze([
  'candidateLinks',
  'stamping',
  'anchorContexts',
  'participantStructures',
  'latticeStructure',
  'latticeSpan',
])

export const LATTICE_DESCRIPTOR_REASONS = Object.freeze({
  orphanDescriptor: 'orphan-descriptor',
  familyMismatch: 'family-mismatch',
  canonicalIdMismatch: 'canonical-id-mismatch',
  bounded: 'bounded-4x4x5',
  anchorShape: 'anchor-shape',
  edgeShape: 'edge-shape',
  duplicateEdge: 'duplicate-edge',
  edgeOrder: 'edge-order',
  disconnectedBackbone: 'disconnected-backbone',
  cyclicBackbone: 'cyclic-backbone',
  backboneNotMinimum: 'backbone-not-minimum',
  cycleRate: 'cycle-rate',
  missingHorizontalLink: 'missing-horizontal-link',
  missingVerticalLink: 'missing-vertical-link',
  missingSpine: 'missing-spine',
  verticalLinkDescriptor: 'vertical-link-descriptor',
  exposureRange: 'exposure-range',
  enclosedRoomIdentity: 'enclosed-room-identity',
  crossDistrictNetwork: 'cross-district-network',
})

// The multilayer lattice district (v24): a 4x4-chunk city block of narrow
// catwalks. 8x8 anchors at a uniform 7-cell pitch terrace across 5 floors, so
// every chunk hosts a 2x2 anchor quad at locals {3,10} — the whole strip of a
// stair (landing + 2 runs + exit) always fits inside its anchor's chunk in
// every axis direction.
const DISTRICT_CHUNKS = 4
const LEVELS = 5
const VERTICAL_PERIOD = STRUCTURE_VERTICAL_PERIOD
const ANCHORS_PER_AXIS = 8
const ANCHOR_LOCAL_COORDINATES = Object.freeze(
  Array.from({ length: ANCHORS_PER_AXIS }, (_, index) =>
    Math.floor(index / 2) * CHUNK + (index % 2 === 0 ? 3 : 10)
  )
)
const ANCHOR_COUNT = ANCHORS_PER_AXIS * ANCHORS_PER_AXIS
const CANDIDATE_COUNT = 2 * ANCHORS_PER_AXIS * (ANCHORS_PER_AXIS - 1)
// Bounded retry budget for the deterministic stair-conflict resolution loop.
const STAIR_PLAN_ATTEMPTS = 16

export const LATTICE_FLOOR_OFFSETS = Object.freeze(
  Array.from({ length: LEVELS }, (_, offset) => offset)
)

const EMPTY_CANDIDATE_LINKS = Object.freeze([])
const WEIGHT_SCALE = 100_000
const UINT32_MAX = 0xffffffff
const LATTICE_EDGE_ROLE_SET = new Set(LATTICE_EDGE_ROLE_ORDER)
const LATTICE_TREE_EDGE_ROLE_SET = new Set(LATTICE_TREE_EDGE_ROLES)

// Every planner decision owns a fixed Lattice-only stream. Candidate weights
// are derived solely from canonical anchors plus edgeWeight, so planner, tests,
// and later audits can recompute the same graph without a caller-authored DTO.
const SALTS = Object.freeze({
  verticalPhase: 0x1a7701,
  id: 0x1a7702,
  floorAxis: 0x1a7703,
  floorCuts: 0x1a7704,
  floorDirection: 0x1a7705,
  maximumExposure: 0x1a7706,
  edgeWeight: 0x1a7707,
  cycleSelection: 0x1a7708,
})

// Terracing modes: the floor field can climb along either axis or either
// diagonal. Diagonal modes cut the district into staircase terraces, so two
// districts with the same cut widths still read differently underfoot.
const FLOOR_AXIS_MODES = Object.freeze(['x', 'z', 'diagonal', 'antidiagonal'])

const LATTICE_POLYGON_CONFIG = Object.freeze({
  districtChunks: DISTRICT_CHUNKS,
})

// Streaming, per-frame ownership validation, and audits all recover the same
// immutable district descriptor. Cache it like the multilevel planner does so
// the anchor/candidate/Kruskal recomputation runs once per district instead of
// once per lookup. Canonical profiles pin every planner input except cycleRate,
// so the profile contributes only that pair to the key. Null results (bands
// with no structure) are cached too — they are the common case.
const STRUCTURE_CACHE = new Map()
const STRUCTURE_CACHE_LIMIT = 512

function structureCacheKey(seed, districtX, districtZ, baseCy, profile) {
  return `${seed >>> 0}:${districtX},${districtZ},${baseCy}:` +
    `${profile.cycleRate[0]},${profile.cycleRate[1]}`
}

// analyzeLatticeDescriptor is pure over a frozen descriptor + profile, and the
// stamp path re-validates the same descriptor several times per chunk build.
// Key by descriptor identity (WeakMap) and profile identity (inner Map).
const ANALYSIS_CACHE = new WeakMap()

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const hasOwn = (value, key) =>
  isRecord(value) && Object.prototype.hasOwnProperty.call(value, key)

export const latticeParticipantKey = ({ cx, cz }) => `${cx},${cz}`
export const latticeChunkKey = (cx, cy, cz) => `${cx},${cy},${cz}`
export const latticeAnchorPositionKey = ({ gx, gz }) => `${gx},${gz}`
export const latticeHorizontalCellKey = (gx, gz) => `${gx},${gz}`
export const latticeGlobalCellKey = (gx, gz, cy) => `${gx},${gz},${cy}`
export const latticeEdgeKey = ({ a, b }) =>
  `${Math.min(a, b)}:${Math.max(a, b)}`

const compareNumbers = (a, b) => a - b
export const compareLatticeAnchors = (a, b) =>
  a.levelCy - b.levelCy || a.gz - b.gz || a.gx - b.gx || a.id - b.id
export const compareLatticeCells = (a, b) =>
  a.cy - b.cy || a.gz - b.gz || a.gx - b.gx
export const compareLatticeCandidates = (a, b) =>
  a.weight - b.weight || a.a - b.a || a.b - b.b
export const compareLatticeEdges = (a, b) =>
  LATTICE_EDGE_ROLE_ORDER.indexOf(a.role) -
    LATTICE_EDGE_ROLE_ORDER.indexOf(b.role) ||
  a.a - b.a ||
  a.b - b.b
export const compareLatticeVerticalLinks = (a, b) =>
  a.lowerCy - b.lowerCy || a.cz - b.cz || a.cx - b.cx

export const isLatticeTreeEdge = (edge) =>
  LATTICE_TREE_EDGE_ROLE_SET.has(edge?.role)

export function isCanonicalLatticeProfile(profile) {
  return profile?.family === MAP_FAMILY_LATTICE &&
    profile.enabled === true &&
    profile.districtChunks === DISTRICT_CHUNKS &&
    profile.levels === LEVELS &&
    profile.anchorsPerAxis === ANCHORS_PER_AXIS &&
    Array.isArray(profile.cycleRate) &&
    profile.cycleRate.length === 2 &&
    Number.isFinite(profile.cycleRate[0]) &&
    Number.isFinite(profile.cycleRate[1]) &&
    profile.cycleRate[0] >= 0.12 &&
    profile.cycleRate[1] <= 0.25 &&
    profile.cycleRate[0] <= profile.cycleRate[1] &&
    profile.defaultExposureM === 5 &&
    profile.maxExposureM === 20 &&
    Number.isInteger(profile.minimumCueCells) &&
    profile.minimumCueCells >= 8
}

const validParticipant = (participant) =>
  isRecord(participant) &&
  Number.isInteger(participant.cx) &&
  Number.isInteger(participant.cz)

export function hasExactLatticeParticipants(structure) {
  const participants = structure?.participants
  const district = structure?.district
  if (
    !Array.isArray(participants) ||
    participants.length !== DISTRICT_CHUNKS * DISTRICT_CHUNKS ||
    !Number.isInteger(district?.x) ||
    !Number.isInteger(district?.z) ||
    district.size !== DISTRICT_CHUNKS
  ) return false

  let index = 0
  for (let dz = 0; dz < DISTRICT_CHUNKS; dz++) {
    for (let dx = 0; dx < DISTRICT_CHUNKS; dx++) {
      const participant = participants[index++]
      if (
        !validParticipant(participant) ||
        participant.cx !== district.x * DISTRICT_CHUNKS + dx ||
        participant.cz !== district.z * DISTRICT_CHUNKS + dz
      ) return false
    }
  }
  return structure.anchor?.cx === participants[0].cx &&
    structure.anchor?.cz === participants[0].cz
}

export function hasExactLatticeBounds(structure) {
  const district = structure?.district
  if (!Number.isInteger(district?.x) || !Number.isInteger(district?.z)) {
    return false
  }
  const expected = {
    x0: district.x * DISTRICT_CHUNKS * CHUNK,
    z0: district.z * DISTRICT_CHUNKS * CHUNK,
    x1: (district.x * DISTRICT_CHUNKS + DISTRICT_CHUNKS) * CHUNK - 1,
    z1: (district.z * DISTRICT_CHUNKS + DISTRICT_CHUNKS) * CHUNK - 1,
  }
  return Object.entries(expected).every(
    ([key, value]) => structure.globalBounds?.[key] === value
  )
}

export function hasCanonicalLatticeOwnershipShape(structure) {
  return hasExactLatticeParticipants(structure) &&
    !LATTICE_NETWORK_FIELDS.some((field) => hasOwn(structure, field)) &&
    !LATTICE_ROOM_FIELDS.some((field) => hasOwn(structure, field)) &&
    !LATTICE_RUNTIME_ENVELOPE_FIELDS.some((field) => hasOwn(structure, field))
}

// Canonical Lattice volume traversal is floor-major over the descriptor's
// already-canonical participant order. Audit and runtime ownership consumers
// reuse this finite 80-slice order instead of rebuilding it independently.
export function latticeSliceCoordinates(structure) {
  if (
    !Number.isInteger(structure?.baseCy) ||
    !Array.isArray(structure?.participants)
  ) return []
  return LATTICE_FLOOR_OFFSETS.flatMap((offset) =>
    structure.participants.map(({ cx, cz }) => ({
      cx,
      cy: structure.baseCy + offset,
      cz,
    }))
  )
}

function districtCoordinate(chunkCoordinate) {
  return sharedDistrictCoordinate(chunkCoordinate, DISTRICT_CHUNKS)
}

function bandBaseAtLevel(seed, districtX, districtZ, levelCy) {
  return sharedBandBaseAtLevel(
    seed,
    SALTS.verticalPhase,
    districtX,
    districtZ,
    levelCy,
    VERTICAL_PERIOD
  )
}

function bandIndexAtBase(seed, districtX, districtZ, baseCy) {
  return sharedBandIndexAtBase(
    seed,
    SALTS.verticalPhase,
    districtX,
    districtZ,
    baseCy,
    VERTICAL_PERIOD
  )
}

function floorAxisPosition(mode, row, column) {
  if (mode === 'x') return column
  if (mode === 'z') return row
  if (mode === 'diagonal') return row + column
  return row + (ANCHORS_PER_AXIS - 1 - column)
}

function floorAxisPositionCount(mode) {
  return mode === 'x' || mode === 'z'
    ? ANCHORS_PER_AXIS
    : 2 * ANCHORS_PER_AXIS - 1
}

// Partition the terracing axis into LEVELS contiguous bands (each at least one
// position wide) by drawing LEVELS-1 distinct cut positions from one hashed
// stream. Grid-adjacent anchors move at most one axis position, so they can
// never differ by more than one floor — the invariant every vertical link and
// stair depends on.
function floorBandCuts(cutStream, positionCount) {
  const gaps = Array.from({ length: positionCount - 1 }, (_, index) => index + 1)
  const cuts = []
  for (let pick = 0; pick < LEVELS - 1; pick++) {
    const index = hash2i(SALTS.floorCuts, cutStream | 0, pick) % gaps.length
    cuts.push(gaps.splice(index, 1)[0])
  }
  return cuts.sort(compareNumbers)
}

function floorOffsetAtPosition(position, cuts) {
  let offset = 0
  for (const cut of cuts) {
    if (position >= cut) offset++
  }
  return offset
}

function latticeAnchors(seed, districtX, districtZ, bandIndex, baseCy, profile) {
  const originGx = districtX * DISTRICT_CHUNKS * CHUNK
  const originGz = districtZ * DISTRICT_CHUNKS * CHUNK
  const mode = FLOOR_AXIS_MODES[plannerHash(
    seed,
    SALTS.floorAxis,
    districtX,
    bandIndex,
    districtZ
  ) % FLOOR_AXIS_MODES.length]
  const cuts = floorBandCuts(
    plannerHash(seed, SALTS.floorCuts, districtX, bandIndex, districtZ),
    floorAxisPositionCount(mode)
  )
  const reverseFloors = plannerHash(
    seed,
    SALTS.floorDirection,
    districtX,
    bandIndex,
    districtZ
  ) % 2 === 1
  const idBase = plannerHash(
    seed,
    SALTS.id,
    districtX,
    bandIndex,
    districtZ
  )
  const maximumExposureIndex = plannerHash(
    seed,
    SALTS.maximumExposure,
    districtX,
    bandIndex,
    districtZ
  ) % ANCHOR_COUNT
  const defaultExposureIndex = (maximumExposureIndex + 1) % ANCHOR_COUNT
  const anchors = []

  for (let row = 0; row < ANCHORS_PER_AXIS; row++) {
    for (let column = 0; column < ANCHORS_PER_AXIS; column++) {
      const positionIndex = row * ANCHORS_PER_AXIS + column
      const rawFloorOffset = floorOffsetAtPosition(
        floorAxisPosition(mode, row, column),
        cuts
      )
      const floorOffset = reverseFloors
        ? LEVELS - 1 - rawFloorOffset
        : rawFloorOffset
      const anchor = {
        id: (idBase + positionIndex) >>> 0,
        gx: originGx + ANCHOR_LOCAL_COORDINATES[column],
        gz: originGz + ANCHOR_LOCAL_COORDINATES[row],
        levelCy: baseCy + floorOffset,
      }
      if (positionIndex !== defaultExposureIndex) {
        anchor.exposureM = positionIndex === maximumExposureIndex
          ? profile.maxExposureM
          : profile.defaultExposureM
      }
      anchors.push(anchor)
    }
  }

  return anchors.sort(compareLatticeAnchors)
}

function validCandidateAnchors(anchors) {
  if (!Array.isArray(anchors) || anchors.length !== ANCHOR_COUNT) return false
  const ids = new Set()
  const positions = new Set()
  for (const anchor of anchors) {
    if (
      !Number.isInteger(anchor?.id) ||
      anchor.id < 0 ||
      anchor.id > 0xffffffff ||
      !Number.isInteger(anchor.gx) ||
      !Number.isInteger(anchor.gz) ||
      !Number.isInteger(anchor.levelCy)
    ) return false
    ids.add(anchor.id)
    positions.add(latticeAnchorPositionKey(anchor))
  }
  if (ids.size !== anchors.length || positions.size !== anchors.length) return false

  const xs = [...new Set(anchors.map(({ gx }) => gx))].sort(compareNumbers)
  const zs = [...new Set(anchors.map(({ gz }) => gz))].sort(compareNumbers)
  return xs.length === ANCHORS_PER_AXIS &&
    zs.length === ANCHORS_PER_AXIS &&
    xs.every((gx) => zs.every((gz) => positions.has(`${gx},${gz}`)))
}

function weightedCandidate(left, right) {
  const a = Math.min(left.id, right.id)
  const b = Math.max(left.id, right.id)
  const distance = Math.abs(left.gx - right.gx) +
    Math.abs(left.gz - right.gz) +
    Math.abs(left.levelCy - right.levelCy) * CHUNK
  const tieBreak = hash3i(
    SALTS.edgeWeight,
    a | 0,
    b | 0,
    (left.levelCy + right.levelCy) | 0
  ) % WEIGHT_SCALE
  return { a, b, weight: distance * WEIGHT_SCALE + tieBreak }
}

// This is the production-owned weighted eligible graph contract. It is a pure
// recomputation from canonical anchors and is intentionally NOT serialized on
// the runtime descriptor as `candidateLinks`.
export function latticeCandidateLinks(anchors) {
  if (!validCandidateAnchors(anchors)) return EMPTY_CANDIDATE_LINKS

  const xs = [...new Set(anchors.map(({ gx }) => gx))].sort(compareNumbers)
  const zs = [...new Set(anchors.map(({ gz }) => gz))].sort(compareNumbers)
  const byPosition = new Map(anchors.map((anchor) => [latticeAnchorPositionKey(anchor), anchor]))
  const candidates = []
  for (let row = 0; row < zs.length; row++) {
    for (let column = 0; column < xs.length; column++) {
      const anchor = byPosition.get(`${xs[column]},${zs[row]}`)
      if (column + 1 < xs.length) {
        candidates.push(weightedCandidate(
          anchor,
          byPosition.get(`${xs[column + 1]},${zs[row]}`)
        ))
      }
      if (row + 1 < zs.length) {
        candidates.push(weightedCandidate(
          anchor,
          byPosition.get(`${xs[column]},${zs[row + 1]}`)
        ))
      }
    }
  }
  return deepFreeze(candidates.sort(compareLatticeCandidates))
}

export function latticeMinimumSpanningLinks(anchorIds, candidates) {
  const parent = new Map(anchorIds.map((id) => [id, id]))
  const find = (id) => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)
    while (parent.get(id) !== id) {
      const next = parent.get(id)
      parent.set(id, root)
      id = next
    }
    return root
  }
  const selected = []
  for (const candidate of candidates) {
    const left = find(candidate.a)
    const right = find(candidate.b)
    if (left === right) continue
    parent.set(left, right)
    selected.push(candidate)
    if (selected.length === anchorIds.length - 1) break
  }
  return selected
}

const STAIR_DIRECTIONS = Object.freeze([
  Object.freeze({ dir: 0, dx: 0, dz: -1 }),
  Object.freeze({ dir: 1, dx: 1, dz: 0 }),
  Object.freeze({ dir: 2, dx: 0, dz: 1 }),
  Object.freeze({ dir: 3, dx: -1, dz: 0 }),
])

const localCoordinate = (globalCoordinate) =>
  ((globalCoordinate % CHUNK) + CHUNK) % CHUNK

// A vertical tree edge realizes as one stair whose strip runs from the lower
// anchor STRAIGHT TOWARD the upper anchor — directly under the edge's upper
// catwalk. The stair top therefore always opens onto that catwalk; direction is
// geometry, never a hash.
function verticalLinkSite(candidate, anchorById) {
  const left = anchorById.get(candidate.a)
  const right = anchorById.get(candidate.b)
  const [lower, upper] = left.levelCy < right.levelCy
    ? [left, right]
    : [right, left]
  const dx = Math.sign(upper.gx - lower.gx)
  const dz = Math.sign(upper.gz - lower.gz)
  const direction = STAIR_DIRECTIONS.find(
    (entry) => entry.dx === dx && entry.dz === dz
  )
  if (!direction) return null
  const lx = localCoordinate(lower.gx)
  const lz = localCoordinate(lower.gz)
  const cellAt = (distance) => ({
    lx: lx + dx * distance,
    lz: lz + dz * distance,
  })
  return {
    lowerCy: lower.levelCy,
    cx: Math.floor(lower.gx / CHUNK),
    cz: Math.floor(lower.gz / CHUNK),
    stair: {
      dir: direction.dir,
      landing: cellAt(0),
      run: [cellAt(1), cellAt(2)],
      exit: cellAt(3),
    },
  }
}

// ChunkData carries exactly one up-stair and one down-stair slot per chunk
// layer, and a chunk layer between two links realizes both halves. Two links
// therefore conflict when they share a chunk column and their lower floors are
// identical or adjacent.
function conflictingVerticalPair(sites) {
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      if (
        sites[i].site.cx === sites[j].site.cx &&
        sites[i].site.cz === sites[j].site.cz &&
        Math.abs(sites[i].site.lowerCy - sites[j].site.lowerCy) <= 1
      ) {
        return [sites[i], sites[j]]
      }
    }
  }
  return null
}

// Candidate weighting, conflict-resolved Kruskal selection, and the horizontal
// cycle denominator form one planner-owned computation. When the raw MST would
// demand two stairs the raster cannot host, the heavier vertical candidate is
// excluded and the tree recomputed — a bounded, deterministic loop that keeps
// graph and geometry in exact agreement. Stamping and auditing consume this
// evidence directly; candidates remain transient and never enter the descriptor.
export function latticeGraphEvidence(anchors) {
  if (!validCandidateAnchors(anchors)) return null
  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]))
  const candidates = latticeCandidateLinks(anchors)
  if (candidates.length !== CANDIDATE_COUNT) return null
  const candidateByKey = new Map(candidates.map((candidate) => [
    latticeEdgeKey(candidate),
    candidate,
  ]))
  const anchorIds = anchors.map(({ id }) => id)

  const excludedKeys = new Set()
  let minimumTreeLinks = null
  let verticalSites = null
  for (let attempt = 0; attempt < STAIR_PLAN_ATTEMPTS; attempt++) {
    const usable = candidates.filter(
      (candidate) => !excludedKeys.has(latticeEdgeKey(candidate))
    )
    const tree = latticeMinimumSpanningLinks(anchorIds, usable)
    if (tree.length !== anchors.length - 1) return null
    const sites = []
    let invalidSite = false
    for (const candidate of tree) {
      const left = anchorById.get(candidate.a)
      const right = anchorById.get(candidate.b)
      if (left.levelCy === right.levelCy) continue
      const site = Math.abs(left.levelCy - right.levelCy) === 1
        ? verticalLinkSite(candidate, anchorById)
        : null
      if (!site) {
        invalidSite = true
        break
      }
      sites.push({ candidate, site })
    }
    if (invalidSite) return null
    const conflict = conflictingVerticalPair(sites)
    if (!conflict) {
      minimumTreeLinks = tree
      verticalSites = sites
      break
    }
    const loser = conflict[0].candidate.weight >= conflict[1].candidate.weight
      ? conflict[0].candidate
      : conflict[1].candidate
    excludedKeys.add(latticeEdgeKey(loser))
  }
  if (!minimumTreeLinks) return null

  const minimumTreeKeys = new Set(minimumTreeLinks.map(latticeEdgeKey))
  const eligibleCycleLinks = candidates.filter((candidate) =>
    !minimumTreeKeys.has(latticeEdgeKey(candidate)) &&
    anchorById.get(candidate.a).levelCy === anchorById.get(candidate.b).levelCy
  )
  const eligibleCycleKeys = new Set(eligibleCycleLinks.map(latticeEdgeKey))
  return {
    anchorById,
    candidates,
    candidateByKey,
    excludedCandidateKeys: excludedKeys,
    minimumTreeLinks,
    minimumTreeKeys,
    verticalSites,
    eligibleCycleLinks,
    eligibleCycleKeys,
  }
}

// Canonical edge geometry. A horizontal edge is the straight catwalk between
// its grid-adjacent anchors. A vertical edge owns the lower anchor's cell (the
// stair landing) plus the FULL catwalk on the upper floor from the upper
// anchor to directly above that landing — so the stair's upper exit is always
// an interior cell of its own edge's deck, never a stranded island.
export function latticeEdgeCells(left, right) {
  if (left.levelCy === right.levelCy) {
    const cells = []
    let gx = left.gx
    let gz = left.gz
    cells.push({ gx, gz, cy: left.levelCy })
    while (gx !== right.gx) {
      gx += Math.sign(right.gx - gx)
      cells.push({ gx, gz, cy: left.levelCy })
    }
    while (gz !== right.gz) {
      gz += Math.sign(right.gz - gz)
      cells.push({ gx, gz, cy: left.levelCy })
    }
    return dedupeSortedCells(cells)
  }
  if (Math.abs(left.levelCy - right.levelCy) !== 1) return []
  const [lower, upper] = left.levelCy < right.levelCy
    ? [left, right]
    : [right, left]
  const dx = Math.sign(upper.gx - lower.gx)
  const dz = Math.sign(upper.gz - lower.gz)
  const span = Math.abs(upper.gx - lower.gx) + Math.abs(upper.gz - lower.gz)
  if ((dx !== 0 && dz !== 0) || span === 0) return []
  const cells = [{ gx: lower.gx, gz: lower.gz, cy: lower.levelCy }]
  for (let distance = 0; distance <= span; distance++) {
    cells.push({
      gx: lower.gx + dx * distance,
      gz: lower.gz + dz * distance,
      cy: upper.levelCy,
    })
  }
  return dedupeSortedCells(cells)
}

function dedupeSortedCells(cells) {
  return [...new Map(cells.map((cell) => [
    `${cell.gx},${cell.gz},${cell.cy}`,
    cell,
  ])).values()].sort(compareLatticeCells)
}

function descriptorEdge(candidate, role, anchorById) {
  return {
    a: candidate.a,
    b: candidate.b,
    role,
    cells: latticeEdgeCells(
      anchorById.get(candidate.a),
      anchorById.get(candidate.b)
    ),
  }
}

function cyclePriority(candidate) {
  return hash2i(SALTS.cycleSelection, candidate.a | 0, candidate.b | 0)
}

function latticeEdges(anchors, evidence, profile, baseCy) {
  const { anchorById, eligibleCycleLinks, minimumTreeLinks } = evidence
  const horizontalTree = minimumTreeLinks.filter((candidate) =>
    anchorById.get(candidate.a).levelCy === anchorById.get(candidate.b).levelCy
  )
  const middleFloorTree = horizontalTree.filter((candidate) =>
    anchorById.get(candidate.a).levelCy === baseCy + (LEVELS >> 1)
  )
  const spine = (middleFloorTree.length > 0 ? middleFloorTree : horizontalTree)
    .slice()
    .sort(compareLatticeCandidates)[0]
  const minimumCycles = Math.ceil(eligibleCycleLinks.length * profile.cycleRate[0])
  const maximumCycles = Math.floor(eligibleCycleLinks.length * profile.cycleRate[1])
  if (
    !spine ||
    eligibleCycleLinks.length === 0 ||
    maximumCycles < minimumCycles ||
    minimumCycles < 1
  ) return null

  const cycleRange = maximumCycles - minimumCycles + 1
  const cycleCount = minimumCycles + (
    hash2i(SALTS.cycleSelection, anchors[0].id | 0, anchors.at(-1).id | 0) %
    cycleRange
  )
  const selectedCycles = eligibleCycleLinks.slice().sort((a, b) =>
    cyclePriority(a) - cyclePriority(b) || compareLatticeCandidates(a, b)
  ).slice(0, cycleCount)
  const edges = minimumTreeLinks.map((candidate) => {
    const left = anchorById.get(candidate.a)
    const right = anchorById.get(candidate.b)
    const role = left.levelCy !== right.levelCy
      ? 'vertical'
      : latticeEdgeKey(candidate) === latticeEdgeKey(spine) ? 'spine' : 'backbone'
    return descriptorEdge(candidate, role, anchorById)
  })
  edges.push(...selectedCycles.map((candidate) =>
    descriptorEdge(candidate, 'cycle', anchorById)
  ))

  return {
    edges: edges.sort(compareLatticeEdges),
    eligibleNonBackboneLinks: eligibleCycleLinks.length,
  }
}

export function isCanonicalLatticeStair(stair) {
  const cells = [stair?.landing, ...(stair?.run ?? []), stair?.exit]
  if (
    !isRecord(stair) ||
    !Number.isInteger(stair.dir) ||
    stair.dir < 0 ||
    stair.dir > 3 ||
    !Array.isArray(stair.run) ||
    stair.run.length !== 2 ||
    cells.length !== 4 ||
    cells.some((cell) =>
      !Number.isInteger(cell?.lx) ||
      !Number.isInteger(cell?.lz) ||
      cell.lx < 0 ||
      cell.lx >= CHUNK ||
      cell.lz < 0 ||
      cell.lz >= CHUNK
    ) ||
    hasOwn(stair, 'lowerCy')
  ) return false

  const direction = STAIR_DIRECTIONS[stair.dir]
  return cells.slice(1).every((cell, index) =>
    cell.lx === cells[index].lx + direction.dx &&
    cell.lz === cells[index].lz + direction.dz
  )
}

function latticeVerticalLinks(evidence) {
  return evidence.verticalSites
    .map(({ site }) => site)
    .sort(compareLatticeVerticalLinks)
}

function sameStairCell(a, b) {
  return Number.isInteger(a?.lx) &&
    a.lx === b?.lx &&
    Number.isInteger(a?.lz) &&
    a.lz === b?.lz
}

function sameVerticalLink(link, expected) {
  return link?.lowerCy === expected.lowerCy &&
    link?.cx === expected.cx &&
    link?.cz === expected.cz &&
    link?.stair?.dir === expected.stair.dir &&
    sameStairCell(link?.stair?.landing, expected.stair.landing) &&
    Array.isArray(link?.stair?.run) &&
    link.stair.run.length === 2 &&
    sameStairCell(link.stair.run[0], expected.stair.run[0]) &&
    sameStairCell(link.stair.run[1], expected.stair.run[1]) &&
    sameStairCell(link?.stair?.exit, expected.stair.exit)
}

function sameEdgeCells(edge, left, right) {
  const expected = latticeEdgeCells(left, right)
  if (expected.length === 0 || !Array.isArray(edge?.cells)) return false
  return edge.cells.length === expected.length &&
    expected.every((cell, index) =>
      edge.cells[index]?.gx === cell.gx &&
      edge.cells[index]?.gz === cell.gz &&
      edge.cells[index]?.cy === cell.cy
    )
}

function failedLatticeAnalysis(structure, reason, partial = {}) {
  return {
    ok: false,
    reason,
    structure,
    anchorById: new Map(),
    minimumTreeKeys: new Set(),
    treeEdges: [],
    cycleEdges: [],
    eligibleCycleKeys: new Set(),
    ...partial,
  }
}

// One strict descriptor/graph boundary backs stamping, runtime slice parity,
// and release audit. It recomputes candidate weights, the conflict-resolved
// Kruskal tree, and eligible cycles from canonical anchors and rejects
// parallel DTO/network authority.
export function analyzeLatticeDescriptor(structure, profile) {
  if (!isRecord(structure)) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.orphanDescriptor
    )
  }
  const cacheable = Object.isFrozen(structure)
  if (cacheable) {
    const cached = ANALYSIS_CACHE.get(structure)?.get(profile)
    if (cached) return cached
  }
  const analysis = computeLatticeAnalysis(structure, profile)
  if (cacheable) {
    let byProfile = ANALYSIS_CACHE.get(structure)
    if (!byProfile) {
      byProfile = new Map()
      ANALYSIS_CACHE.set(structure, byProfile)
    }
    byProfile.set(profile, analysis)
  }
  return analysis
}

function computeLatticeAnalysis(structure, profile) {
  if (
    structure.family !== MAP_FAMILY_LATTICE ||
    structure.kind !== LATTICE_STRUCTURE_KIND ||
    structure.hasRoom !== true
  ) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.familyMismatch
    )
  }
  if (
    !Number.isInteger(structure.id) ||
    structure.id < 0 ||
    structure.id > UINT32_MAX
  ) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.canonicalIdMismatch
    )
  }
  if (LATTICE_NETWORK_FIELDS.some((field) => hasOwn(structure, field))) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.crossDistrictNetwork
    )
  }
  if (LATTICE_ROOM_FIELDS.some((field) => hasOwn(structure, field))) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.enclosedRoomIdentity
    )
  }
  if (LATTICE_RUNTIME_ENVELOPE_FIELDS.some((field) => hasOwn(structure, field))) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.edgeShape
    )
  }
  if (
    !isCanonicalLatticeProfile(profile) ||
    structure.levelCount !== LEVELS ||
    !Number.isInteger(structure.baseCy) ||
    structure.topCy !== structure.baseCy + LEVELS - 1 ||
    !hasExactLatticeParticipants(structure) ||
    !hasExactLatticeBounds(structure)
  ) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.bounded
    )
  }

  const anchors = structure.anchors
  if (!Array.isArray(anchors) || anchors.length !== ANCHOR_COUNT) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.anchorShape
    )
  }
  const anchorById = new Map()
  const positions = new Set()
  const anchorByPosition = new Map()
  const floors = new Set()
  let exposureValid = true
  for (let index = 0; index < anchors.length; index++) {
    const anchor = anchors[index]
    const positionKey = latticeHorizontalCellKey(anchor?.gx, anchor?.gz)
    const exposureM = anchor?.exposureM === undefined
      ? profile.defaultExposureM
      : anchor.exposureM
    if (
      !Number.isInteger(anchor?.id) ||
      anchor.id < 0 ||
      anchor.id > UINT32_MAX ||
      anchorById.has(anchor.id) ||
      !Number.isInteger(anchor.gx) ||
      !Number.isInteger(anchor.gz) ||
      !Number.isInteger(anchor.levelCy) ||
      anchor.levelCy < structure.baseCy ||
      anchor.levelCy > structure.topCy ||
      anchor.gx < structure.globalBounds.x0 ||
      anchor.gx > structure.globalBounds.x1 ||
      anchor.gz < structure.globalBounds.z0 ||
      anchor.gz > structure.globalBounds.z1 ||
      positions.has(positionKey) ||
      (index > 0 && compareLatticeAnchors(anchors[index - 1], anchor) >= 0)
    ) {
      return failedLatticeAnalysis(
        structure,
        LATTICE_DESCRIPTOR_REASONS.anchorShape,
        { anchorById }
      )
    }
    exposureValid &&= Number.isFinite(exposureM) &&
      exposureM >= 0 && exposureM <= profile.maxExposureM
    anchorById.set(anchor.id, anchor)
    positions.add(positionKey)
    anchorByPosition.set(positionKey, anchor)
    floors.add(anchor.levelCy)
  }
  const xs = [...new Set(anchors.map(({ gx }) => gx))].sort(compareNumbers)
  const zs = [...new Set(anchors.map(({ gz }) => gz))].sort(compareNumbers)
  let terracedField = anchorById.size === ANCHOR_COUNT &&
    positions.size === ANCHOR_COUNT &&
    xs.length === ANCHORS_PER_AXIS &&
    zs.length === ANCHORS_PER_AXIS &&
    xs.every((gx) => zs.every((gz) =>
      positions.has(latticeHorizontalCellKey(gx, gz))
    )) &&
    floors.size === LEVELS
  if (terracedField) {
    for (let offset = 0; offset < LEVELS; offset++) {
      terracedField &&= floors.has(structure.baseCy + offset)
    }
    // Grid-adjacent anchors may differ by at most one floor: that bound is
    // what makes every vertical candidate a single-flight stair.
    for (let row = 0; terracedField && row < zs.length; row++) {
      for (let column = 0; terracedField && column < xs.length; column++) {
        const anchor = anchorByPosition.get(
          latticeHorizontalCellKey(xs[column], zs[row])
        )
        if (column + 1 < xs.length) {
          const east = anchorByPosition.get(
            latticeHorizontalCellKey(xs[column + 1], zs[row])
          )
          terracedField &&= Math.abs(anchor.levelCy - east.levelCy) <= 1
        }
        if (row + 1 < zs.length) {
          const south = anchorByPosition.get(
            latticeHorizontalCellKey(xs[column], zs[row + 1])
          )
          terracedField &&= Math.abs(anchor.levelCy - south.levelCy) <= 1
        }
      }
    }
  }
  if (!terracedField) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.anchorShape,
      { anchorById }
    )
  }
  if (!exposureValid) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.exposureRange,
      { anchorById }
    )
  }

  const graph = latticeGraphEvidence(anchors)
  if (!graph || !Array.isArray(structure.edges)) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.edgeShape,
      { anchorById }
    )
  }
  const seen = new Set()
  const treeEdges = []
  const cycleEdges = []
  let edgeOrderValid = true
  for (let index = 0; index < structure.edges.length; index++) {
    const edge = structure.edges[index]
    const key = latticeEdgeKey(edge ?? {})
    const left = anchorById.get(edge?.a)
    const right = anchorById.get(edge?.b)
    if (seen.has(key)) {
      return failedLatticeAnalysis(
        structure,
        LATTICE_DESCRIPTOR_REASONS.duplicateEdge,
        {
          anchorById,
          minimumTreeKeys: graph.minimumTreeKeys,
        }
      )
    }
    seen.add(key)
    edgeOrderValid &&= index === 0 ||
      compareLatticeEdges(structure.edges[index - 1], edge) < 0
    if (
      !LATTICE_EDGE_ROLE_SET.has(edge?.role) ||
      !Number.isInteger(edge.a) ||
      !Number.isInteger(edge.b) ||
      edge.a >= edge.b ||
      !left ||
      !right ||
      !graph.candidateByKey.has(key) ||
      !sameEdgeCells(edge, left, right) ||
      ((edge.role === 'vertical') !== (left.levelCy !== right.levelCy)) ||
      (edge.role === 'cycle' && left.levelCy !== right.levelCy)
    ) {
      return failedLatticeAnalysis(
        structure,
        LATTICE_DESCRIPTOR_REASONS.edgeShape,
        {
          anchorById,
          minimumTreeKeys: graph.minimumTreeKeys,
          treeEdges,
          cycleEdges,
        }
      )
    }
    if (isLatticeTreeEdge(edge)) treeEdges.push(edge)
    else cycleEdges.push(edge)
  }
  if (!edgeOrderValid) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.edgeOrder,
      {
        anchorById,
        minimumTreeKeys: graph.minimumTreeKeys,
        treeEdges,
        cycleEdges,
      }
    )
  }

  if (treeEdges.length < anchors.length - 1) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.disconnectedBackbone,
      {
        anchorById,
        minimumTreeKeys: graph.minimumTreeKeys,
        treeEdges,
        cycleEdges,
      }
    )
  }
  if (treeEdges.length > anchors.length - 1) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.cyclicBackbone,
      {
        anchorById,
        minimumTreeKeys: graph.minimumTreeKeys,
        treeEdges,
        cycleEdges,
      }
    )
  }
  const treeKeys = new Set(treeEdges.map(latticeEdgeKey))
  if ([...graph.minimumTreeKeys].some((key) => !treeKeys.has(key))) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.backboneNotMinimum,
      {
        anchorById,
        minimumTreeKeys: graph.minimumTreeKeys,
        treeEdges,
        cycleEdges,
      }
    )
  }
  if (!treeEdges.some(({ role }) => role === 'spine')) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.missingSpine,
      {
        anchorById,
        minimumTreeKeys: graph.minimumTreeKeys,
        treeEdges,
        cycleEdges,
      }
    )
  }
  if (!treeEdges.some(({ role }) => role !== 'vertical')) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.missingHorizontalLink,
      {
        anchorById,
        minimumTreeKeys: graph.minimumTreeKeys,
        treeEdges,
        cycleEdges,
      }
    )
  }

  // Vertical links: one canonical stair per vertical tree edge, sorted, with
  // every adjacent floor pair of the band bridged at least once — the "always
  // a way to the next layer" contract — and no two stairs demanding the same
  // chunk slot.
  const verticalEdges = treeEdges.filter(({ role }) => role === 'vertical')
  const expectedLinks = latticeVerticalLinks(graph)
  const links = structure.verticalLinks
  const coveredBoundaries = new Set(
    Array.isArray(links)
      ? links.map((link) => link?.lowerCy).filter(Number.isInteger)
      : []
  )
  let boundariesCovered = true
  for (let lowerCy = structure.baseCy; lowerCy < structure.topCy; lowerCy++) {
    boundariesCovered &&= coveredBoundaries.has(lowerCy)
  }
  if (
    verticalEdges.length < LEVELS - 1 ||
    !Array.isArray(links) ||
    links.length !== verticalEdges.length ||
    !boundariesCovered
  ) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.missingVerticalLink,
      {
        anchorById,
        minimumTreeKeys: graph.minimumTreeKeys,
        treeEdges,
        cycleEdges,
      }
    )
  }
  const linksValid = links.length === expectedLinks.length &&
    links.every((link, index) =>
      sameVerticalLink(link, expectedLinks[index]) &&
      isCanonicalLatticeStair(link?.stair)
    )
  if (!linksValid) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.verticalLinkDescriptor,
      {
        anchorById,
        minimumTreeKeys: graph.minimumTreeKeys,
        treeEdges,
        cycleEdges,
        eligibleCycleKeys: graph.eligibleCycleKeys,
      }
    )
  }

  const cycleRate = cycleEdges.length / graph.eligibleCycleKeys.size
  if (
    structure.eligibleNonBackboneLinks !== graph.eligibleCycleKeys.size ||
    cycleEdges.length === 0 ||
    cycleEdges.some((edge) => !graph.eligibleCycleKeys.has(latticeEdgeKey(edge))) ||
    cycleRate < profile.cycleRate[0] ||
    cycleRate > profile.cycleRate[1]
  ) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.cycleRate,
      {
        anchorById,
        minimumTreeKeys: graph.minimumTreeKeys,
        treeEdges,
        cycleEdges,
        eligibleCycleKeys: graph.eligibleCycleKeys,
      }
    )
  }

  return {
    ok: true,
    reason: null,
    structure,
    anchorById,
    candidateByKey: graph.candidateByKey,
    minimumTreeKeys: graph.minimumTreeKeys,
    treeEdges,
    cycleEdges,
    eligibleCycleKeys: graph.eligibleCycleKeys,
  }
}

function structureForDistrict(seed, districtX, districtZ, baseCy, profile) {
  const topCy = baseCy + profile.levels - 1
  if (topCy > MAX_STRUCTURE_TOP_CY) return null

  const bandIndex = bandIndexAtBase(seed, districtX, districtZ, baseCy)
  if (!Number.isInteger(bandIndex)) return null
  const polygons = polygonCandidates(
    districtX,
    districtZ,
    LATTICE_POLYGON_CONFIG,
    {
      shape: 'lattice',
      bridgeAxis: null,
      avoidSpawn: baseCy <= 0 && topCy >= 0,
    }
  )
  if (polygons.length !== 1) return null

  const participants = polygons[0].participants.map(({ cx, cz }) => ({ cx, cz }))
  const anchors = latticeAnchors(
    seed,
    districtX,
    districtZ,
    bandIndex,
    baseCy,
    profile
  )
  const evidence = latticeGraphEvidence(anchors)
  if (!evidence) return null
  const graph = latticeEdges(anchors, evidence, profile, baseCy)
  if (!graph) return null
  const verticalLinks = latticeVerticalLinks(evidence)
  const coveredBoundaries = new Set(verticalLinks.map(({ lowerCy }) => lowerCy))
  for (let lowerCy = baseCy; lowerCy < topCy; lowerCy++) {
    if (!coveredBoundaries.has(lowerCy)) return null
  }

  const originGx = districtX * DISTRICT_CHUNKS * CHUNK
  const originGz = districtZ * DISTRICT_CHUNKS * CHUNK
  const id = plannerHash(
    seed,
    SALTS.id,
    districtX,
    bandIndex,
    districtZ
  ) || 1
  return deepFreeze({
    id,
    family: MAP_FAMILY_LATTICE,
    kind: LATTICE_STRUCTURE_KIND,
    hasRoom: true,
    district: {
      x: districtX,
      z: districtZ,
      size: DISTRICT_CHUNKS,
    },
    baseCy,
    topCy,
    levelCount: profile.levels,
    participants,
    anchor: participants[0],
    globalBounds: {
      x0: originGx,
      z0: originGz,
      x1: originGx + DISTRICT_CHUNKS * CHUNK - 1,
      z1: originGz + DISTRICT_CHUNKS * CHUNK - 1,
    },
    anchors,
    edges: graph.edges,
    eligibleNonBackboneLinks: graph.eligibleNonBackboneLinks,
    verticalLinks,
  })
}

// Recover one immutable bounded Lattice descriptor from any declared
// participant and floor in its five-level band. Runtime carriage remains the
// existing data.structure field; this planner exposes no parallel DTO.
export function latticeStructureAt(seed, cx, cz, levelCy, profile) {
  if (
    !isCanonicalLatticeProfile(profile) ||
    !Number.isInteger(seed) ||
    !Number.isInteger(cx) ||
    !Number.isInteger(cz) ||
    !Number.isInteger(levelCy)
  ) return null

  const districtX = districtCoordinate(cx)
  const districtZ = districtCoordinate(cz)
  const baseCy = bandBaseAtLevel(seed, districtX, districtZ, levelCy)
  const key = structureCacheKey(seed, districtX, districtZ, baseCy, profile)
  let structure
  if (STRUCTURE_CACHE.has(key)) {
    structure = STRUCTURE_CACHE.get(key)
    STRUCTURE_CACHE.delete(key)
    STRUCTURE_CACHE.set(key, structure)
  } else {
    structure = structureForDistrict(
      seed,
      districtX,
      districtZ,
      baseCy,
      profile
    )
    STRUCTURE_CACHE.set(key, structure)
    if (STRUCTURE_CACHE.size > STRUCTURE_CACHE_LIMIT) {
      STRUCTURE_CACHE.delete(STRUCTURE_CACHE.keys().next().value)
    }
  }
  if (
    !structure ||
    levelCy < structure.baseCy ||
    levelCy > structure.topCy ||
    !structure.participants.some(
      (participant) => latticeParticipantKey(participant) === latticeParticipantKey({ cx, cz })
    )
  ) return null
  return structure
}
