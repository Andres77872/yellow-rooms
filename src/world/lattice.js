import { CHUNK } from './constants.js'
import { hash2i, hash3i } from './core/hash.js'
import { deepFreeze } from './mapFamily.js'
import { MAP_FAMILY_LATTICE } from './mapTypes.js'
import {
  MAX_MULTILEVEL_TOP_CY,
  polygonCandidates,
} from './multilevel.js'

export const LATTICE_STRUCTURE_KIND = 'latticeDistrict'

export const LATTICE_EDGE_ROLE_ORDER = Object.freeze([
  'backbone',
  'cycle',
  'spine',
  'vertical',
])

export const LATTICE_FLOOR_OFFSETS = Object.freeze([0, 1, 2])

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
  bounded: 'bounded-3x3x3',
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

const DISTRICT_CHUNKS = 3
const VERTICAL_PERIOD = 17
const ANCHORS_PER_AXIS = 5
const ANCHOR_LOCAL_COORDINATES = Object.freeze([3, 11, 20, 29, 38])
const FLOOR_BAND_WIDTHS = Object.freeze([
  Object.freeze([1, 1, 3]),
  Object.freeze([1, 3, 1]),
  Object.freeze([3, 1, 1]),
  Object.freeze([1, 2, 2]),
  Object.freeze([2, 1, 2]),
  Object.freeze([2, 2, 1]),
])
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
  floorBands: 0x1a7704,
  floorDirection: 0x1a7705,
  maximumExposure: 0x1a7706,
  edgeWeight: 0x1a7707,
  cycleSelection: 0x1a7708,
  stairDirection: 0x1a7709,
})

const LATTICE_POLYGON_CONFIG = Object.freeze({
  districtChunks: DISTRICT_CHUNKS,
})

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

export const isLatticeTreeEdge = (edge) =>
  LATTICE_TREE_EDGE_ROLE_SET.has(edge?.role)

export function isCanonicalLatticeProfile(profile) {
  return profile?.family === MAP_FAMILY_LATTICE &&
    profile.enabled === true &&
    profile.districtChunks === DISTRICT_CHUNKS &&
    profile.levels === 3 &&
    profile.anchorsPerAxis === ANCHORS_PER_AXIS &&
    Array.isArray(profile.cycleRate) &&
    profile.cycleRate.length === 2 &&
    Number.isFinite(profile.cycleRate[0]) &&
    Number.isFinite(profile.cycleRate[1]) &&
    profile.cycleRate[0] >= 0.08 &&
    profile.cycleRate[1] <= 0.15 &&
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
    participants.length !== 9 ||
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
// reuse this finite 27-slice order instead of rebuilding it independently.
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
  return Math.floor(chunkCoordinate / DISTRICT_CHUNKS)
}

function plannerHash(seed, salt, districtX, bandIndex, districtZ) {
  return hash3i(
    ((seed >>> 0) ^ salt) | 0,
    districtX,
    bandIndex,
    districtZ
  )
}

function verticalPhase(seed, districtX, districtZ) {
  return hash3i(
    ((seed >>> 0) ^ SALTS.verticalPhase) | 0,
    districtX,
    0,
    districtZ
  ) % VERTICAL_PERIOD
}

function bandBaseAtLevel(seed, districtX, districtZ, levelCy) {
  const phase = verticalPhase(seed, districtX, districtZ)
  return phase + Math.floor((levelCy - phase) / VERTICAL_PERIOD) * VERTICAL_PERIOD
}

function bandIndexAtBase(seed, districtX, districtZ, baseCy) {
  const phase = verticalPhase(seed, districtX, districtZ)
  return (baseCy - phase) / VERTICAL_PERIOD
}

function floorOffsetAtGridIndex(index, widths) {
  if (index < widths[0]) return 0
  if (index < widths[0] + widths[1]) return 1
  return 2
}

function latticeAnchors(seed, districtX, districtZ, bandIndex, baseCy, profile) {
  const originGx = districtX * DISTRICT_CHUNKS * CHUNK
  const originGz = districtZ * DISTRICT_CHUNKS * CHUNK
  const floorAxis = plannerHash(
    seed,
    SALTS.floorAxis,
    districtX,
    bandIndex,
    districtZ
  ) % 2 === 0 ? 'x' : 'z'
  const widths = FLOOR_BAND_WIDTHS[plannerHash(
    seed,
    SALTS.floorBands,
    districtX,
    bandIndex,
    districtZ
  ) % FLOOR_BAND_WIDTHS.length]
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
  ) % (ANCHORS_PER_AXIS * ANCHORS_PER_AXIS)
  const defaultExposureIndex = (maximumExposureIndex + 1) %
    (ANCHORS_PER_AXIS * ANCHORS_PER_AXIS)
  const anchors = []

  for (let row = 0; row < ANCHORS_PER_AXIS; row++) {
    for (let column = 0; column < ANCHORS_PER_AXIS; column++) {
      const positionIndex = row * ANCHORS_PER_AXIS + column
      const axisIndex = floorAxis === 'x' ? column : row
      const rawFloorOffset = floorOffsetAtGridIndex(axisIndex, widths)
      const floorOffset = reverseFloors ? 2 - rawFloorOffset : rawFloorOffset
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
  if (!Array.isArray(anchors) || anchors.length !== 25) return false
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

// Candidate weighting, Kruskal selection, and the horizontal cycle denominator
// form one planner-owned computation. Stamping and auditing consume this
// evidence directly; candidates remain transient and never enter the descriptor.
export function latticeGraphEvidence(anchors) {
  if (!validCandidateAnchors(anchors)) return null
  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]))
  const candidates = latticeCandidateLinks(anchors)
  if (candidates.length !== 40) return null
  const candidateByKey = new Map(candidates.map((candidate) => [
    latticeEdgeKey(candidate),
    candidate,
  ]))
  const minimumTreeLinks = latticeMinimumSpanningLinks(
    anchors.map(({ id }) => id),
    candidates
  )
  if (minimumTreeLinks.length !== anchors.length - 1) return null
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
    minimumTreeLinks,
    minimumTreeKeys,
    eligibleCycleLinks,
    eligibleCycleKeys,
  }
}

function edgeCellsBetween(left, right) {
  const cells = []
  let gx = left.gx
  let gz = left.gz
  let cy = left.levelCy
  cells.push({ gx, gz, cy })
  while (gx !== right.gx) {
    gx += Math.sign(right.gx - gx)
    cells.push({ gx, gz, cy })
  }
  while (gz !== right.gz) {
    gz += Math.sign(right.gz - gz)
    cells.push({ gx, gz, cy })
  }
  while (cy !== right.levelCy) {
    cy += Math.sign(right.levelCy - cy)
    cells.push({ gx, gz, cy })
  }
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
    cells: edgeCellsBetween(
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
    anchorById.get(candidate.a).levelCy === baseCy + 1
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

const STAIR_DIRECTIONS = Object.freeze([
  Object.freeze({ dir: 0, dx: 0, dz: -1 }),
  Object.freeze({ dir: 1, dx: 1, dz: 0 }),
  Object.freeze({ dir: 2, dx: 0, dz: 1 }),
  Object.freeze({ dir: 3, dx: -1, dz: 0 }),
])

const localCoordinate = (globalCoordinate) =>
  ((globalCoordinate % CHUNK) + CHUNK) % CHUNK

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

function stairDescriptor(anchor, lowerCy) {
  const lx = localCoordinate(anchor.gx)
  const lz = localCoordinate(anchor.gz)
  const validDirections = STAIR_DIRECTIONS.filter(({ dx, dz }) => {
    const exitX = lx + dx * 3
    const exitZ = lz + dz * 3
    return exitX >= 1 && exitX < CHUNK - 1 &&
      exitZ >= 1 && exitZ < CHUNK - 1
  })
  const direction = validDirections[
    hash2i(SALTS.stairDirection, anchor.id | 0, lowerCy) % validDirections.length
  ]
  const cellAt = (distance) => ({
    lx: lx + direction.dx * distance,
    lz: lz + direction.dz * distance,
  })
  return {
    dir: direction.dir,
    landing: cellAt(0),
    run: [cellAt(1), cellAt(2)],
    exit: cellAt(3),
  }
}

function latticeVerticalLinks(anchors, treeLinks) {
  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]))
  return treeLinks.filter((candidate) =>
    anchorById.get(candidate.a).levelCy !== anchorById.get(candidate.b).levelCy
  ).map((candidate) => {
    const left = anchorById.get(candidate.a)
    const right = anchorById.get(candidate.b)
    const lower = left.levelCy < right.levelCy ? left : right
    const lowerCy = lower.levelCy
    return {
      lowerCy,
      cx: Math.floor(lower.gx / CHUNK),
      cz: Math.floor(lower.gz / CHUNK),
      stair: stairDescriptor(lower, lowerCy),
    }
  }).sort((a, b) => a.lowerCy - b.lowerCy)
}

function validLatticeEdgeCells(edge, left, right, structure) {
  if (!Array.isArray(edge?.cells) || edge.cells.length === 0) return false
  const keys = new Set()
  for (let index = 0; index < edge.cells.length; index++) {
    const cell = edge.cells[index]
    const key = latticeGlobalCellKey(cell?.gx, cell?.gz, cell?.cy)
    if (
      !Number.isInteger(cell?.gx) ||
      !Number.isInteger(cell?.gz) ||
      !Number.isInteger(cell?.cy) ||
      cell.gx < structure.globalBounds.x0 ||
      cell.gx > structure.globalBounds.x1 ||
      cell.gz < structure.globalBounds.z0 ||
      cell.gz > structure.globalBounds.z1 ||
      cell.cy < structure.baseCy ||
      cell.cy > structure.topCy ||
      keys.has(key) ||
      (index > 0 && compareLatticeCells(edge.cells[index - 1], cell) >= 0)
    ) return false
    keys.add(key)
  }
  return keys.has(latticeGlobalCellKey(left.gx, left.gz, left.levelCy)) &&
    keys.has(latticeGlobalCellKey(right.gx, right.gz, right.levelCy))
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
// and release audit. It recomputes candidate weights, Kruskal, and eligible
// cycles from canonical anchors and rejects parallel DTO/network authority.
export function analyzeLatticeDescriptor(structure, profile) {
  if (!isRecord(structure)) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.orphanDescriptor
    )
  }
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
    structure.levelCount !== 3 ||
    !Number.isInteger(structure.baseCy) ||
    structure.topCy !== structure.baseCy + 2 ||
    !hasExactLatticeParticipants(structure) ||
    !hasExactLatticeBounds(structure)
  ) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.bounded
    )
  }

  const anchors = structure.anchors
  if (!Array.isArray(anchors) || anchors.length !== 25) {
    return failedLatticeAnalysis(
      structure,
      LATTICE_DESCRIPTOR_REASONS.anchorShape
    )
  }
  const anchorById = new Map()
  const positions = new Set()
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
    floors.add(anchor.levelCy)
  }
  const xs = [...new Set(anchors.map(({ gx }) => gx))]
  const zs = [...new Set(anchors.map(({ gz }) => gz))]
  if (
    anchorById.size !== 25 ||
    positions.size !== 25 ||
    xs.length !== ANCHORS_PER_AXIS ||
    zs.length !== ANCHORS_PER_AXIS ||
    !xs.every((gx) => zs.every((gz) =>
      positions.has(latticeHorizontalCellKey(gx, gz))
    )) ||
    floors.size !== 3 ||
    !floors.has(structure.baseCy) ||
    !floors.has(structure.baseCy + 1) ||
    !floors.has(structure.topCy)
  ) {
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
      !validLatticeEdgeCells(edge, left, right, structure) ||
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

  const verticalEdges = treeEdges.filter(({ role }) => role === 'vertical')
  const links = structure.verticalLinks
  if (
    verticalEdges.length !== 2 ||
    !Array.isArray(links) ||
    links.length !== 2 ||
    links[0]?.lowerCy !== structure.baseCy ||
    links[1]?.lowerCy !== structure.baseCy + 1
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
  if (treeEdges.length < 24) {
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
  if (treeEdges.length > 24) {
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

  for (const link of links) {
    const vertical = verticalEdges.find((edge) => {
      const left = anchorById.get(edge.a)
      const right = anchorById.get(edge.b)
      return Math.min(left.levelCy, right.levelCy) === link.lowerCy
    })
    const lower = vertical && [
      anchorById.get(vertical.a),
      anchorById.get(vertical.b),
    ].find((anchor) => anchor.levelCy === link.lowerCy)
    if (
      !vertical ||
      !lower ||
      link.cx !== Math.floor(lower.gx / CHUNK) ||
      link.cz !== Math.floor(lower.gz / CHUNK) ||
      !isCanonicalLatticeStair(link.stair)
    ) {
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
  if (topCy > MAX_MULTILEVEL_TOP_CY) return null

  const bandIndex = bandIndexAtBase(seed, districtX, districtZ, baseCy)
  if (!Number.isInteger(bandIndex)) return null
  const polygons = polygonCandidates(
    districtX,
    districtZ,
    LATTICE_POLYGON_CONFIG,
    {
      shape: 'lattice3x3',
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
  const verticalLinks = latticeVerticalLinks(anchors, evidence.minimumTreeLinks)
  if (
    verticalLinks.length !== 2 ||
    verticalLinks[0].lowerCy !== baseCy ||
    verticalLinks[1].lowerCy !== baseCy + 1
  ) return null

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
// participant and floor in its three-level band. Runtime carriage remains the
// existing data.multilevelStructure field; this planner exposes no parallel DTO.
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
  const structure = structureForDistrict(
    seed,
    districtX,
    districtZ,
    baseCy,
    profile
  )
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
