import { describe, expect, it } from 'vitest'
import { DEFAULT_WORLD_CONFIG, LATTICE_RELEASE_EVIDENCE } from '../config.js'
import { CHUNK, WORLD_GEN_VERSION } from '../constants.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { MAP_FAMILY_LATTICE } from '../mapTypes.js'
import { polygonCandidates } from '../structures/multilevel.js'
import { structureAt } from '../structures/contract.js'

const FIXED_SEEDS = Object.freeze([0x1a771ce, 0x5a17, 0xc0ffee])
const LATTICE_KIND = 'latticeDistrict'
const DISTRICT_CHUNKS = 4
const LEVELS = 5
const ANCHORS_PER_AXIS = 8
const ANCHOR_COUNT = ANCHORS_PER_AXIS * ANCHORS_PER_AXIS
const PARTICIPANT_COUNT = DISTRICT_CHUNKS * DISTRICT_CHUNKS
const EDGE_ROLES = Object.freeze(['backbone', 'cycle', 'spine', 'vertical'])
const TREE_ROLES = new Set(['backbone', 'spine', 'vertical'])
const NETWORK_FIELDS = Object.freeze([
  'networkId',
  'networkEdges',
  'crossDistrictLinks',
  'linkedStructureIds',
  'interFamilyLinks',
])
const ROOM_FIELDS = Object.freeze([
  'rooms',
  'roomBounds',
  'enclosedRooms',
  'enclosedRoomSlices',
])
const RUNTIME_ENVELOPE_FIELDS = Object.freeze([
  'candidateLinks',
  'stamping',
  'anchorContexts',
  'participantStructures',
])
const LATTICE_PLANNER_PATH = '../structures/lattice.js'

const participantKey = ({ cx, cz }) => `${cx},${cz}`
const edgeKey = ({ a, b }) => `${Math.min(a, b)}:${Math.max(a, b)}`
const compareParticipants = (a, b) => a.cz - b.cz || a.cx - b.cx
const compareAnchors = (a, b) =>
  a.levelCy - b.levelCy || a.gz - b.gz || a.gx - b.gx || a.id - b.id
const compareEdges = (a, b) =>
  (a.role === b.role ? 0 : a.role < b.role ? -1 : 1) || a.a - b.a || a.b - b.b
const compareCells = (a, b) => a.cy - b.cy || a.gz - b.gz || a.gx - b.gx

function forcedLatticeConfig() {
  const base = structuredClone(DEFAULT_WORLD_CONFIG)
  base.mapFamily.profiles[MAP_FAMILY_LATTICE].enabled = true
  return worldConfigForFamily(MAP_FAMILY_LATTICE, base)
}

function findLatticeDescriptor(seed, config = forcedLatticeConfig()) {
  let descriptor = null
  for (let cy = -24; cy <= 24 && !descriptor; cy++) {
    for (let cz = -4; cz <= 4 && !descriptor; cz++) {
      for (let cx = -4; cx <= 4; cx++) {
        const candidate = structureAt(seed, cx, cz, cy, config)
        if (
          candidate?.hasRoom === true &&
          candidate.family === MAP_FAMILY_LATTICE &&
          candidate.kind === LATTICE_KIND
        ) {
          descriptor = candidate
          break
        }
      }
    }
  }

  expect(
    descriptor,
    'task 5.1 RED: structureAt must dispatch a forced enabled Lattice profile to the bounded lattice planner'
  ).not.toBeNull()
  return descriptor
}

function deepFrozen(value) {
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)) return false
  return Object.values(value).every((child) =>
    !child || typeof child !== 'object' || deepFrozen(child)
  )
}

async function latticePlannerApi() {
  try {
    return await import(/* @vite-ignore */ LATTICE_PLANNER_PATH)
  } catch (error) {
    throw new Error(
      'task 5.4 requires the production-owned Lattice candidate-weight contract',
      { cause: error }
    )
  }
}

function validParticipant(participant) {
  return Number.isInteger(participant?.cx) && Number.isInteger(participant?.cz)
}

function completeDistrictParticipants(descriptor) {
  const participants = descriptor?.participants ?? []
  if (
    descriptor?.district?.size !== DISTRICT_CHUNKS ||
    !Number.isInteger(descriptor.district.x) ||
    !Number.isInteger(descriptor.district.z) ||
    participants.length !== PARTICIPANT_COUNT ||
    participants.some((participant) => !validParticipant(participant))
  ) return false

  const originCx = descriptor.district.x * DISTRICT_CHUNKS
  const originCz = descriptor.district.z * DISTRICT_CHUNKS
  const expected = []
  for (let dz = 0; dz < DISTRICT_CHUNKS; dz++) {
    for (let dx = 0; dx < DISTRICT_CHUNKS; dx++) {
      expected.push({ cx: originCx + dx, cz: originCz + dz })
    }
  }
  return participants.every((participant, index) =>
    participant.cx === expected[index].cx && participant.cz === expected[index].cz
  )
}

function validGlobalBounds(bounds, participants) {
  if (
    !Number.isInteger(bounds?.x0) ||
    !Number.isInteger(bounds?.z0) ||
    !Number.isInteger(bounds?.x1) ||
    !Number.isInteger(bounds?.z1) ||
    bounds.x1 < bounds.x0 ||
    bounds.z1 < bounds.z0 ||
    participants.length === 0
  ) return false

  const minCx = Math.min(...participants.map(({ cx }) => cx))
  const maxCx = Math.max(...participants.map(({ cx }) => cx))
  const minCz = Math.min(...participants.map(({ cz }) => cz))
  const maxCz = Math.max(...participants.map(({ cz }) => cz))
  return bounds.x0 >= minCx * CHUNK &&
    bounds.z0 >= minCz * CHUNK &&
    bounds.x1 < (maxCx + 1) * CHUNK &&
    bounds.z1 < (maxCz + 1) * CHUNK
}

function anchorsFormFullGrid(descriptor) {
  const anchors = descriptor?.anchors ?? []
  if (anchors.length !== ANCHOR_COUNT) return false
  if (anchors.some((anchor) =>
    !Number.isInteger(anchor?.id) ||
    !Number.isInteger(anchor.gx) ||
    !Number.isInteger(anchor.gz) ||
    !Number.isInteger(anchor.levelCy) ||
    anchor.levelCy < descriptor.baseCy ||
    anchor.levelCy > descriptor.topCy
  )) return false

  const ids = new Set(anchors.map(({ id }) => id))
  const xs = [...new Set(anchors.map(({ gx }) => gx))].sort((a, b) => a - b)
  const zs = [...new Set(anchors.map(({ gz }) => gz))].sort((a, b) => a - b)
  const positions = new Set(anchors.map(({ gx, gz }) => `${gx},${gz}`))
  if (
    ids.size !== ANCHOR_COUNT ||
    xs.length !== ANCHORS_PER_AXIS ||
    zs.length !== ANCHORS_PER_AXIS ||
    positions.size !== ANCHOR_COUNT
  ) {
    return false
  }
  return xs.every((gx) => zs.every((gz) => positions.has(`${gx},${gz}`))) &&
    anchors.every((anchor, index) =>
      index === 0 || compareAnchors(anchors[index - 1], anchor) < 0
    )
}

function normalizedExposure(anchor, profile) {
  return anchor.exposureM === undefined
    ? profile.defaultExposureM
    : anchor.exposureM
}

function validEdgeCells(edge, descriptor) {
  if (!Array.isArray(edge?.cells) || edge.cells.length === 0) return false
  return edge.cells.every((cell, index) =>
    Number.isInteger(cell?.gx) &&
    Number.isInteger(cell?.gz) &&
    Number.isInteger(cell?.cy) &&
    cell.gx >= descriptor.globalBounds.x0 &&
    cell.gx <= descriptor.globalBounds.x1 &&
    cell.gz >= descriptor.globalBounds.z0 &&
    cell.gz <= descriptor.globalBounds.z1 &&
    cell.cy >= descriptor.baseCy &&
    cell.cy <= descriptor.topCy &&
    (index === 0 || compareCells(edge.cells[index - 1], cell) < 0)
  )
}

function treeAnalysis(anchorIds, edges) {
  const adjacency = new Map(anchorIds.map((id) => [id, []]))
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
  let cycle = false
  let invalid = false

  for (const edge of edges) {
    if (!adjacency.has(edge.a) || !adjacency.has(edge.b) || edge.a === edge.b) {
      invalid = true
      continue
    }
    adjacency.get(edge.a).push(edge.b)
    adjacency.get(edge.b).push(edge.a)
    const a = find(edge.a)
    const b = find(edge.b)
    if (a === b) cycle = true
    else parent.set(a, b)
  }

  const seen = new Set()
  const first = anchorIds[0]
  if (first !== undefined) {
    const queue = [first]
    seen.add(first)
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const next of adjacency.get(queue[cursor]) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return { cycle, invalid, seen }
}

function minimumSpanningEdgeKeys(anchorIds, candidateLinks) {
  const parent = new Map(anchorIds.map((id) => [id, id]))
  const find = (id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)))
      id = parent.get(id)
    }
    return id
  }
  const selected = []
  const sorted = [...candidateLinks].sort((left, right) =>
    left.weight - right.weight || left.a - right.a || left.b - right.b
  )
  for (const edge of sorted) {
    const a = find(edge.a)
    const b = find(edge.b)
    if (a === b) continue
    parent.set(a, b)
    selected.push(edgeKey(edge))
    if (selected.length === anchorIds.length - 1) break
  }
  return new Set(selected)
}

function latticeContractReasons(fixture) {
  const descriptor = fixture?.descriptor ?? {}
  const profile = fixture?.profile ?? DEFAULT_WORLD_CONFIG.mapFamily.profiles.lattice
  const participants = descriptor.participants ?? []
  const anchors = descriptor.anchors ?? []
  const edges = descriptor.edges ?? []
  const reasons = new Set()

  if (
    descriptor.family !== MAP_FAMILY_LATTICE ||
    descriptor.kind !== LATTICE_KIND ||
    descriptor.hasRoom !== true ||
    !Number.isInteger(descriptor.id) ||
    descriptor.id < 0 ||
    descriptor.id > 0xffffffff
  ) reasons.add('lattice-identity')

  if (participants.length !== PARTICIPANT_COUNT) reasons.add('participant-cardinality')
  const participantKeys = participants.map(participantKey)
  if (new Set(participantKeys).size !== participantKeys.length) {
    reasons.add('duplicate-participant')
  }
  if (
    !completeDistrictParticipants(descriptor) ||
    participantKey(descriptor.anchor ?? {}) !== participantKey(participants[0] ?? {}) ||
    !participants.every((participant, index) =>
      index === 0 || compareParticipants(participants[index - 1], participant) < 0
    )
  ) reasons.add('participant-shape')

  if (
    descriptor.district?.size !== DISTRICT_CHUNKS ||
    descriptor.levelCount !== LEVELS ||
    !Number.isInteger(descriptor.baseCy) ||
    descriptor.topCy !== descriptor.baseCy + LEVELS - 1 ||
    !validGlobalBounds(descriptor.globalBounds, participants)
  ) reasons.add('bounded-4x4x5')

  const ownership = fixture?.ownership ?? []
  const claims = new Map(ownership.map((claim) => [participantKey(claim), claim]))
  if (
    ownership.length !== participants.length ||
    claims.size !== participants.length ||
    participants.some((participant) => !claims.has(participantKey(participant)))
  ) reasons.add('missing-participant')
  for (const participant of participants) {
    const claim = claims.get(participantKey(participant))
    if (!claim) continue
    if (claim.id !== descriptor.id) reasons.add('canonical-id-mismatch')
    if (claim.family !== MAP_FAMILY_LATTICE) reasons.add('family-mismatch')
    if (claim.baseCy !== descriptor.baseCy || claim.topCy !== descriptor.topCy) {
      reasons.add('vertical-band')
    }
  }

  if (!anchorsFormFullGrid(descriptor)) reasons.add('anchor-shape')
  for (const anchor of anchors) {
    const exposureM = normalizedExposure(anchor, profile)
    if (!Number.isFinite(exposureM) || exposureM < 0 || exposureM > profile.maxExposureM) {
      reasons.add('exposure-range')
    }
  }

  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]))
  const edgeKeys = new Set()
  for (const edge of edges) {
    if (
      !EDGE_ROLES.includes(edge?.role) ||
      !Number.isInteger(edge?.a) ||
      !Number.isInteger(edge?.b) ||
      edge.a >= edge.b ||
      !anchorById.has(edge.a) ||
      !anchorById.has(edge.b) ||
      !validEdgeCells(edge, descriptor)
    ) reasons.add('edge-shape')
    const key = edgeKey(edge)
    if (edgeKeys.has(key)) reasons.add('duplicate-edge')
    edgeKeys.add(key)
  }
  if (!edges.every((edge, index) =>
    index === 0 || compareEdges(edges[index - 1], edge) < 0
  )) reasons.add('edge-order')

  const treeEdges = edges.filter((edge) => TREE_ROLES.has(edge.role))
  const tree = treeAnalysis([...anchorById.keys()], treeEdges)
  if (
    tree.invalid ||
    tree.cycle ||
    treeEdges.length !== Math.max(0, anchors.length - 1) ||
    tree.seen.size !== anchors.length
  ) reasons.add(tree.cycle ? 'cyclic-backbone' : 'disconnected-backbone')

  if (Array.isArray(fixture?.candidateLinks)) {
    const expected = minimumSpanningEdgeKeys([...anchorById.keys()], fixture.candidateLinks)
    const actual = new Set(treeEdges.map(edgeKey))
    if (
      expected.size !== actual.size ||
      [...expected].some((key) => !actual.has(key))
    ) reasons.add('backbone-not-minimum')
  }

  const cycleEdges = edges.filter((edge) => edge.role === 'cycle')
  const eligibleNonBackboneLinks = fixture?.eligibleNonBackboneLinks ??
    descriptor.eligibleNonBackboneLinks
  if (
    !Number.isInteger(eligibleNonBackboneLinks) ||
    eligibleNonBackboneLinks <= 0 ||
    cycleEdges.length / eligibleNonBackboneLinks < profile.cycleRate[0] ||
    cycleEdges.length / eligibleNonBackboneLinks > profile.cycleRate[1]
  ) reasons.add('cycle-rate')

  const horizontalEdges = edges.filter((edge) => {
    const a = anchorById.get(edge.a)
    const b = anchorById.get(edge.b)
    return a && b && a.levelCy === b.levelCy
  })
  const verticalEdges = edges.filter((edge) => {
    const a = anchorById.get(edge.a)
    const b = anchorById.get(edge.b)
    return edge.role === 'vertical' &&
      a && b && Math.abs(a.levelCy - b.levelCy) === 1
  })
  if (horizontalEdges.length === 0) reasons.add('missing-horizontal-link')
  const verticalPairs = new Set(verticalEdges.map((edge) => {
    const a = anchorById.get(edge.a)
    const b = anchorById.get(edge.b)
    return Math.min(a.levelCy, b.levelCy)
  }))
  for (
    let lowerCy = descriptor.baseCy;
    Number.isInteger(descriptor.baseCy) && lowerCy < descriptor.topCy;
    lowerCy++
  ) {
    if (!verticalPairs.has(lowerCy)) reasons.add('missing-vertical-link')
  }
  if (!edges.some((edge) => edge.role === 'spine')) reasons.add('missing-spine')

  // Every vertical tree edge realizes as one stair; every adjacent floor pair
  // of the five-level band must be bridged at least once.
  const verticalLinks = descriptor.verticalLinks ?? []
  const lowerFloors = new Set(verticalLinks.map((link) => link.lowerCy))
  let boundariesCovered = Number.isInteger(descriptor.baseCy)
  for (
    let lowerCy = descriptor.baseCy;
    Number.isInteger(descriptor.baseCy) && lowerCy < descriptor.topCy;
    lowerCy++
  ) {
    boundariesCovered &&= lowerFloors.has(lowerCy)
  }
  if (
    verticalLinks.length !== verticalEdges.length ||
    verticalLinks.length < LEVELS - 1 ||
    !boundariesCovered ||
    verticalLinks.some((link) =>
      !participants.some(({ cx, cz }) => cx === link.cx && cz === link.cz) ||
      !link.stair || typeof link.stair !== 'object'
    )
  ) reasons.add('vertical-link-descriptor')

  const contexts = fixture?.anchorContexts
  if (Array.isArray(contexts)) {
    if (contexts.length !== anchors.length) reasons.add('cue-coverage')
    for (const context of contexts) {
      if (
        !Number.isInteger(context.railPerimeterCueCells) ||
        !Number.isInteger(context.bridgeSeamCueCells)
      ) reasons.add('cue-sources')
      const cueCells = context.railPerimeterCueCells + context.bridgeSeamCueCells
      if (!Number.isInteger(cueCells) || cueCells < profile.minimumCueCells) {
        reasons.add('cue-count')
      }
      if (!Number.isInteger(context.plainWallSides) || context.plainWallSides >= 3) {
        reasons.add('plain-wall-sides')
      }
      if (context.enclosedRoom === true) reasons.add('enclosed-room-identity')
    }
  }
  if ((fixture?.enclosedRooms?.length ?? 0) > 0) reasons.add('enclosed-room-identity')
  if (ROOM_FIELDS.some((field) => descriptor[field] !== undefined)) {
    reasons.add('enclosed-room-identity')
  }

  const bridgeCells = new Set(edges.flatMap((edge) =>
    (edge.cells ?? []).map(({ gx, gz, cy }) => `${gx},${gz},${cy}`)
  ))
  const districtVolume = participants.length * CHUNK * CHUNK * LEVELS
  if (bridgeCells.size === 0 || bridgeCells.size >= districtVolume) {
    reasons.add('non-sparse-bridge-fabric')
  }

  if (NETWORK_FIELDS.some((field) => descriptor[field] !== undefined)) {
    reasons.add('cross-district-network')
  }

  return [...reasons]
}

// Mirrors the production edge-cell geometry: horizontal edges are one straight
// catwalk; a vertical edge owns the lower anchor's cell plus the FULL upper-
// floor line from the upper anchor to directly above that cell (so the stair
// top always opens onto its own edge's deck).
function edgeCellsBetween(a, b) {
  if (a.levelCy === b.levelCy) {
    const cells = [{ gx: a.gx, gz: a.gz, cy: a.levelCy }]
    let { gx, gz } = a
    while (gx !== b.gx) {
      gx += Math.sign(b.gx - gx)
      cells.push({ gx, gz, cy: a.levelCy })
    }
    while (gz !== b.gz) {
      gz += Math.sign(b.gz - gz)
      cells.push({ gx, gz, cy: a.levelCy })
    }
    return cells.sort(compareCells)
  }
  const [lower, upper] = a.levelCy < b.levelCy ? [a, b] : [b, a]
  const dx = Math.sign(upper.gx - lower.gx)
  const dz = Math.sign(upper.gz - lower.gz)
  const span = Math.abs(upper.gx - lower.gx) + Math.abs(upper.gz - lower.gz)
  const cells = [{ gx: lower.gx, gz: lower.gz, cy: lower.levelCy }]
  for (let distance = 0; distance <= span; distance++) {
    cells.push({
      gx: lower.gx + dx * distance,
      gz: lower.gz + dz * distance,
      cy: upper.levelCy,
    })
  }
  const unique = new Map(cells.map((cell) => [`${cell.gx},${cell.gz},${cell.cy}`, cell]))
  return [...unique.values()].sort(compareCells)
}

const STAIR_DELTAS = Object.freeze([
  Object.freeze({ dir: 0, dx: 0, dz: -1 }),
  Object.freeze({ dir: 1, dx: 1, dz: 0 }),
  Object.freeze({ dir: 2, dx: 0, dz: 1 }),
  Object.freeze({ dir: 3, dx: -1, dz: 0 }),
])

function referenceLatticeFixture() {
  const baseCy = 4
  const participants = []
  for (let cz = 0; cz < DISTRICT_CHUNKS; cz++) {
    for (let cx = 0; cx < DISTRICT_CHUNKS; cx++) participants.push({ cx, cz })
  }

  // Production anchor pitch: every chunk hosts a 2x2 quad at locals {3, 10}.
  const coordinates = Array.from({ length: ANCHORS_PER_AXIS }, (_, index) =>
    Math.floor(index / 2) * CHUNK + (index % 2 === 0 ? 3 : 10)
  )
  // Row-terraced field over five floors: widths [2,2,2,1,1], adjacent rows
  // never differ by more than one floor.
  const rowFloor = [0, 0, 1, 1, 2, 2, 3, 4]
  const anchors = []
  for (let row = 0; row < ANCHORS_PER_AXIS; row++) {
    const levelCy = baseCy + rowFloor[row]
    for (let column = 0; column < ANCHORS_PER_AXIS; column++) {
      const id = row * ANCHORS_PER_AXIS + column
      anchors.push({
        id,
        gx: coordinates[column],
        gz: coordinates[row],
        levelCy,
        ...(id === 0 ? {} : { exposureM: id === ANCHOR_COUNT - 1 ? 20 : 5 }),
      })
    }
  }
  anchors.sort(compareAnchors)
  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]))
  const anchorByPosition = new Map(anchors.map((anchor) => [`${anchor.gx},${anchor.gz}`, anchor]))

  const candidateLinks = []
  for (let row = 0; row < ANCHORS_PER_AXIS; row++) {
    for (let column = 0; column < ANCHORS_PER_AXIS; column++) {
      const anchor = anchorByPosition.get(`${coordinates[column]},${coordinates[row]}`)
      for (const [nextColumn, nextRow] of [[column + 1, row], [column, row + 1]]) {
        if (nextColumn >= ANCHORS_PER_AXIS || nextRow >= ANCHORS_PER_AXIS) continue
        const next = anchorByPosition.get(`${coordinates[nextColumn]},${coordinates[nextRow]}`)
        const a = Math.min(anchor.id, next.id)
        const b = Math.max(anchor.id, next.id)
        const distance = Math.abs(anchor.gx - next.gx) +
          Math.abs(anchor.gz - next.gz) +
          Math.abs(anchor.levelCy - next.levelCy) * CHUNK
        candidateLinks.push({ a, b, weight: distance * 1000 + a * ANCHOR_COUNT + b })
      }
    }
  }

  const anchorIds = anchors.map(({ id }) => id)
  const treeKeys = minimumSpanningEdgeKeys(anchorIds, candidateLinks)
  const treeLinks = candidateLinks.filter((edge) => treeKeys.has(edgeKey(edge)))
  const nonTreeLinks = candidateLinks.filter((edge) => !treeKeys.has(edgeKey(edge)))
  const spineKeys = new Set(treeLinks
    .filter((edge) => {
      const a = anchorById.get(edge.a)
      const b = anchorById.get(edge.b)
      return a.levelCy === baseCy + (LEVELS >> 1) && b.levelCy === a.levelCy
    })
    .slice(0, 4)
    .map(edgeKey))

  const makeEdge = (link, role) => ({
    a: link.a,
    b: link.b,
    role,
    cells: edgeCellsBetween(anchorById.get(link.a), anchorById.get(link.b)),
  })
  const treeEdges = treeLinks.map((link) => {
    const a = anchorById.get(link.a)
    const b = anchorById.get(link.b)
    const role = a.levelCy !== b.levelCy
      ? 'vertical'
      : spineKeys.has(edgeKey(link)) ? 'spine' : 'backbone'
    return makeEdge(link, role)
  })
  // 6 of 49 eligible non-tree links keeps the rate inside [0.12, 0.25]:
  // removing one dips below the floor, so the below-minimum damage case bites.
  const sameLevelNonTree = nonTreeLinks.filter((link) =>
    anchorById.get(link.a).levelCy === anchorById.get(link.b).levelCy
  )
  const cycleEdges = sameLevelNonTree.slice(0, 6).map((link) => makeEdge(link, 'cycle'))
  const edges = [...treeEdges, ...cycleEdges].sort(compareEdges)

  // One stair per vertical tree edge, running from the lower anchor straight
  // toward the upper anchor, sorted by (lowerCy, cz, cx).
  const verticalLinks = treeEdges
    .filter((edge) => edge.role === 'vertical')
    .map((edge) => {
      const a = anchorById.get(edge.a)
      const b = anchorById.get(edge.b)
      const [lower, upper] = a.levelCy < b.levelCy ? [a, b] : [b, a]
      const dx = Math.sign(upper.gx - lower.gx)
      const dz = Math.sign(upper.gz - lower.gz)
      const { dir } = STAIR_DELTAS.find((delta) => delta.dx === dx && delta.dz === dz)
      const lx = lower.gx % CHUNK
      const lz = lower.gz % CHUNK
      const cellAt = (distance) => ({ lx: lx + dx * distance, lz: lz + dz * distance })
      return {
        lowerCy: lower.levelCy,
        cx: Math.floor(lower.gx / CHUNK),
        cz: Math.floor(lower.gz / CHUNK),
        stair: {
          dir,
          landing: cellAt(0),
          run: [cellAt(1), cellAt(2)],
          exit: cellAt(3),
        },
      }
    })
    .sort((a, b) => a.lowerCy - b.lowerCy || a.cz - b.cz || a.cx - b.cx)

  const descriptor = {
    id: 0x1a771ce,
    family: MAP_FAMILY_LATTICE,
    kind: LATTICE_KIND,
    hasRoom: true,
    district: { x: 0, z: 0, size: DISTRICT_CHUNKS },
    baseCy,
    topCy: baseCy + LEVELS - 1,
    levelCount: LEVELS,
    participants,
    anchor: { ...participants[0] },
    globalBounds: {
      x0: 0,
      z0: 0,
      x1: CHUNK * DISTRICT_CHUNKS - 1,
      z1: CHUNK * DISTRICT_CHUNKS - 1,
    },
    anchors,
    edges,
    verticalLinks,
    eligibleNonBackboneLinks: nonTreeLinks.length,
  }

  return {
    descriptor,
    profile: structuredClone(DEFAULT_WORLD_CONFIG.mapFamily.profiles.lattice),
    ownership: participants.map((participant) => ({
      ...participant,
      id: descriptor.id,
      family: MAP_FAMILY_LATTICE,
      baseCy: descriptor.baseCy,
      topCy: descriptor.topCy,
    })),
    candidateLinks,
    eligibleNonBackboneLinks: nonTreeLinks.length,
    anchorContexts: anchors.map((anchor, index) => ({
      anchorId: anchor.id,
      railPerimeterCueCells: 6,
      bridgeSeamCueCells: 2,
      plainWallSides: index % 3,
      enclosedRoom: false,
    })),
    enclosedRooms: [],
  }
}

function plannerFixture(seed, config = forcedLatticeConfig()) {
  const descriptor = findLatticeDescriptor(seed, config)
  return {
    descriptor,
    profile: config.mapFamily.profiles.lattice,
    ownership: descriptor.participants.map((participant) => ({
      ...participant,
      id: descriptor.id,
      family: descriptor.family,
      baseCy: descriptor.baseCy,
      topCy: descriptor.topCy,
    })),
  }
}

describe('bounded Lattice polygon and planner contracts', () => {
  it('[R08-S03][D04] enumerates one canonical complete 4x4 sixteen-participant polygon', () => {
    const participants = []
    for (let cz = 8; cz <= 11; cz++) {
      for (let cx = -4; cx <= -1; cx++) participants.push({ cx, cz })
    }
    expect(polygonCandidates(-1, 2, { districtChunks: 4 }, {
      shape: 'lattice',
      avoidSpawn: false,
    })).toEqual([{
      anchor: { cx: -4, cz: 8 },
      participants,
    }])
    expect(polygonCandidates(0, 0, { districtChunks: 4 }, {
      shape: 'lattice',
      bridgeAxis: 'x',
      avoidSpawn: true,
    })).toEqual([])
    expect(polygonCandidates(-1, 0, { districtChunks: 4 }, {
      shape: 'lattice',
      bridgeAxis: 'z',
      avoidSpawn: true,
    })).toHaveLength(1)
    expect(polygonCandidates(-1, 2, { districtChunks: 1 }, {
      shape: 'lattice',
      avoidSpawn: false,
    })).toEqual([])
    expect(polygonCandidates(-1, 2, { districtChunks: 4 }, {
      shape: 'lattice3x3',
      avoidSpawn: false,
    })).toEqual([])
  })

  it('[R08-S03][R09-S01..S06][R28-S01][D04/D05] emits one bounded canonical sixteen-owner descriptor', () => {
    for (const seed of FIXED_SEEDS) {
      const fixture = plannerFixture(seed)
      expect(latticeContractReasons(fixture)).toEqual([])
      expect(fixture.descriptor.participants).toHaveLength(PARTICIPANT_COUNT)
      expect(fixture.descriptor.anchors).toHaveLength(ANCHOR_COUNT)
      expect(fixture.descriptor.levelCount).toBe(LEVELS)
      expect(fixture.descriptor.participantChunks).toBeUndefined()
      expect(RUNTIME_ENVELOPE_FIELDS.every(
        (field) => fixture.descriptor[field] === undefined
      )).toBe(true)
    }
  })

  it('[R28-S02..S04][R29-S03..S04][D05] reproduces the production conflict-resolved MST, bounded cycles, spine, and full floor-boundary stair coverage', async () => {
    const { latticeCandidateLinks, latticeGraphEvidence } = await latticePlannerApi()
    expect(
      latticeCandidateLinks,
      'generated MST evidence must use the production-owned candidate-weight contract'
    ).toBeTypeOf('function')
    expect(
      latticeGraphEvidence,
      'generated MST evidence must use the production conflict-resolved tree contract'
    ).toBeTypeOf('function')

    for (const seed of FIXED_SEEDS) {
      const fixture = plannerFixture(seed)
      const candidates = latticeCandidateLinks(fixture.descriptor.anchors)
      const evidence = latticeGraphEvidence(fixture.descriptor.anchors)
      const treeEdges = fixture.descriptor.edges.filter((edge) => TREE_ROLES.has(edge.role))
      const treeKeys = new Set(treeEdges.map(edgeKey))
      const anchors = new Map(
        fixture.descriptor.anchors.map((anchor) => [anchor.id, anchor])
      )
      const eligibleCycleKeys = new Set(candidates
        .filter((candidate) => !treeKeys.has(edgeKey(candidate)))
        .filter((candidate) =>
          anchors.get(candidate.a)?.levelCy === anchors.get(candidate.b)?.levelCy
        )
        .map(edgeKey))
      const cycleEdges = fixture.descriptor.edges.filter((edge) => edge.role === 'cycle')
      const verticalTreeEdges = treeEdges.filter((edge) => edge.role === 'vertical')

      const reasons = latticeContractReasons(fixture)
      expect(candidates).toHaveLength(
        2 * ANCHORS_PER_AXIS * (ANCHORS_PER_AXIS - 1)
      )
      expect(candidates.every((candidate) =>
        Number.isInteger(candidate.a) &&
        Number.isInteger(candidate.b) &&
        candidate.a < candidate.b &&
        Number.isInteger(candidate.weight)
      )).toBe(true)
      expect(evidence).not.toBeNull()
      expect(treeKeys).toEqual(evidence.minimumTreeKeys)
      expect(treeEdges).toHaveLength(ANCHOR_COUNT - 1)
      expect(verticalTreeEdges.length).toBeGreaterThanOrEqual(LEVELS - 1)
      expect(treeEdges.filter((edge) => edge.role === 'spine').length)
        .toBeGreaterThanOrEqual(1)
      expect(fixture.descriptor.verticalLinks).toHaveLength(verticalTreeEdges.length)
      const coveredBoundaries = new Set(
        fixture.descriptor.verticalLinks.map(({ lowerCy }) => lowerCy)
      )
      for (
        let lowerCy = fixture.descriptor.baseCy;
        lowerCy < fixture.descriptor.topCy;
        lowerCy++
      ) expect(coveredBoundaries.has(lowerCy)).toBe(true)
      expect(fixture.descriptor.eligibleNonBackboneLinks).toBe(eligibleCycleKeys.size)
      expect(cycleEdges.every((edge) => eligibleCycleKeys.has(edgeKey(edge)))).toBe(true)
      expect(cycleEdges.every((edge) =>
        anchors.get(edge.a)?.levelCy === anchors.get(edge.b)?.levelCy
      )).toBe(true)
      expect(cycleEdges.length / eligibleCycleKeys.size).toBeGreaterThanOrEqual(0.12)
      expect(cycleEdges.length / eligibleCycleKeys.size).toBeLessThanOrEqual(0.25)
      expect(reasons).not.toContain('disconnected-backbone')
      expect(reasons).not.toContain('cyclic-backbone')
      expect(reasons).not.toContain('backbone-not-minimum')
      expect(reasons).not.toContain('cycle-rate')
      expect(reasons).not.toContain('missing-spine')
      expect(reasons).not.toContain('missing-horizontal-link')
      expect(reasons).not.toContain('missing-vertical-link')
    }
  })

  it('[R28-S01..S06][D05] is deterministic, recursively frozen, order-independent, and owned by every participant/floor lookup', () => {
    const seed = FIXED_SEEDS[0]
    const config = forcedLatticeConfig()
    const descriptor = findLatticeDescriptor(seed, config)
    expect(findLatticeDescriptor(seed, config)).toEqual(descriptor)
    expect(deepFrozen(descriptor)).toBe(true)
    expect(descriptor.anchor).toEqual(descriptor.participants[0])

    const floors = []
    for (let cy = descriptor.baseCy; cy <= descriptor.topCy; cy++) floors.push(cy)
    const requests = descriptor.participants.flatMap(({ cx, cz }) =>
      floors.map((cy) => ({ cx, cy, cz }))
    )
    for (const { cx, cy, cz } of requests.reverse()) {
      expect(structureAt(seed, cx, cz, cy, config)).toEqual(descriptor)
    }
  })

  it('[R29-S03..S04][R30-S01..S05][D05] keeps default/max exposure and sparse bridge-without-room identity explicit', () => {
    const fixture = referenceLatticeFixture()
    const defaulted = fixture.descriptor.anchors.find((anchor) => anchor.exposureM === undefined)
    const maximum = fixture.descriptor.anchors.find((anchor) => anchor.exposureM === 20)

    expect(normalizedExposure(defaulted, fixture.profile)).toBe(5)
    expect(normalizedExposure(maximum, fixture.profile)).toBe(20)
    expect(latticeContractReasons(fixture)).toEqual([])
    expect(fixture.enclosedRooms).toEqual([])
    expect(fixture.anchorContexts.every((context) => context.enclosedRoom === false)).toBe(true)
  })
})

describe('Lattice graph and malformed-descriptor controls', () => {
  it('[R28-S02..S04][D05] accepts the weighted reference MST before cycle reinsertion', () => {
    const fixture = referenceLatticeFixture()
    const treeEdges = fixture.descriptor.edges.filter((edge) => TREE_ROLES.has(edge.role))
    const selected = new Set(treeEdges.map(edgeKey))
    const minimum = minimumSpanningEdgeKeys(
      fixture.descriptor.anchors.map(({ id }) => id),
      fixture.candidateLinks
    )
    const cycles = fixture.descriptor.edges.filter((edge) => edge.role === 'cycle')

    expect(selected).toEqual(minimum)
    expect(treeEdges).toHaveLength(fixture.descriptor.anchors.length - 1)
    expect(cycles).toHaveLength(6)
    expect(cycles.length / fixture.eligibleNonBackboneLinks)
      .toBeGreaterThanOrEqual(0.12)
    expect(cycles.length / fixture.eligibleNonBackboneLinks)
      .toBeLessThanOrEqual(0.25)
    expect(latticeContractReasons(fixture)).toEqual([])
  })

  it.each([
    {
      label: 'one participant',
      reason: 'participant-cardinality',
      damage(fixture) {
        fixture.descriptor.participants = [fixture.descriptor.participants[0]]
        fixture.ownership = [fixture.ownership[0]]
      },
    },
    {
      label: 'duplicate participant',
      reason: 'duplicate-participant',
      damage(fixture) {
        fixture.descriptor.participants[15] = { ...fixture.descriptor.participants[0] }
      },
    },
    {
      label: 'missing canonical owner',
      reason: 'missing-participant',
      damage(fixture) {
        fixture.ownership.pop()
      },
    },
    {
      label: 'conflicting canonical id',
      reason: 'canonical-id-mismatch',
      damage(fixture) {
        fixture.ownership[4].id += 1
      },
    },
    {
      label: 'non-4x4 participant shape',
      reason: 'participant-shape',
      damage(fixture) {
        fixture.descriptor.participants[15].cx += 1
        fixture.ownership[15].cx += 1
      },
    },
    {
      label: 'owner outside the vertical band',
      reason: 'vertical-band',
      damage(fixture) {
        fixture.ownership[5].topCy += 1
      },
    },
    {
      label: 'oversized horizontal district',
      reason: 'bounded-4x4x5',
      damage(fixture) {
        fixture.descriptor.district.size = 5
      },
    },
    {
      label: 'oversized floor band',
      reason: 'bounded-4x4x5',
      damage(fixture) {
        fixture.descriptor.levelCount = 6
        fixture.descriptor.topCy += 1
      },
    },
    {
      label: 'disconnected backbone',
      reason: 'disconnected-backbone',
      damage(fixture) {
        const index = fixture.descriptor.edges.findIndex((edge) => TREE_ROLES.has(edge.role))
        fixture.descriptor.edges.splice(index, 1)
      },
    },
    {
      label: 'cyclic backbone',
      reason: 'cyclic-backbone',
      damage(fixture) {
        const cycle = fixture.descriptor.edges.find((edge) => edge.role === 'cycle')
        cycle.role = 'backbone'
        fixture.descriptor.edges.sort(compareEdges)
      },
    },
    {
      label: 'non-minimum weighted backbone',
      reason: 'backbone-not-minimum',
      damage(fixture) {
        const selected = fixture.descriptor.edges.find((edge) => TREE_ROLES.has(edge.role))
        const candidate = fixture.candidateLinks.find((edge) => edgeKey(edge) === edgeKey(selected))
        candidate.weight += 1_000_000
      },
    },
    {
      label: 'cycle reinsertion below 12 percent',
      reason: 'cycle-rate',
      damage(fixture) {
        const index = fixture.descriptor.edges.findIndex((edge) => edge.role === 'cycle')
        fixture.descriptor.edges.splice(index, 1)
      },
    },
    {
      label: 'cycle reinsertion above 25 percent',
      reason: 'cycle-rate',
      damage(fixture) {
        const anchors = new Map(fixture.descriptor.anchors.map((anchor) => [anchor.id, anchor]))
        const used = new Set(fixture.descriptor.edges.map(edgeKey))
        for (const link of fixture.candidateLinks) {
          const cycles = fixture.descriptor.edges
            .filter((edge) => edge.role === 'cycle').length
          if (cycles / fixture.eligibleNonBackboneLinks > 0.25) break
          if (used.has(edgeKey(link))) continue
          used.add(edgeKey(link))
          fixture.descriptor.edges.push({
            a: link.a,
            b: link.b,
            role: 'cycle',
            cells: edgeCellsBetween(anchors.get(link.a), anchors.get(link.b)),
          })
        }
        fixture.descriptor.edges.sort(compareEdges)
      },
    },
    {
      label: 'horizontal-only connector graph',
      reason: 'missing-vertical-link',
      damage(fixture) {
        fixture.descriptor.edges = fixture.descriptor.edges
          .filter((edge) => edge.role !== 'vertical')
          .sort(compareEdges)
        fixture.descriptor.verticalLinks = []
      },
    },
    {
      label: 'vertical-only connector graph',
      reason: 'missing-horizontal-link',
      damage(fixture) {
        fixture.descriptor.edges = fixture.descriptor.edges
          .filter((edge) => edge.role === 'vertical')
          .sort(compareEdges)
      },
    },
    {
      label: 'missing floor-boundary stair',
      reason: 'vertical-link-descriptor',
      damage(fixture) {
        fixture.descriptor.verticalLinks =
          fixture.descriptor.verticalLinks.slice(1)
      },
    },
    {
      label: 'missing spine label',
      reason: 'missing-spine',
      damage(fixture) {
        for (const edge of fixture.descriptor.edges) {
          if (edge.role === 'spine') edge.role = 'backbone'
        }
        fixture.descriptor.edges.sort(compareEdges)
      },
    },
    {
      label: 'exposure above 20 metres',
      reason: 'exposure-range',
      damage(fixture) {
        fixture.descriptor.anchors[0].exposureM = 21
      },
    },
    {
      label: 'omitted incident bridge-seam cues',
      reason: 'cue-sources',
      damage(fixture) {
        delete fixture.anchorContexts[0].bridgeSeamCueCells
      },
    },
    {
      label: 'fewer than eight combined cue cells',
      reason: 'cue-count',
      damage(fixture) {
        fixture.anchorContexts[0].railPerimeterCueCells = 5
        fixture.anchorContexts[0].bridgeSeamCueCells = 2
      },
    },
    {
      label: 'three plain-wall sides',
      reason: 'plain-wall-sides',
      damage(fixture) {
        fixture.anchorContexts[0].plainWallSides = 3
      },
    },
    {
      label: 'enclosed chamber room',
      reason: 'enclosed-room-identity',
      damage(fixture) {
        fixture.anchorContexts[0].enclosedRoom = true
        fixture.enclosedRooms.push({ anchorId: 0 })
      },
    },
    {
      label: 'cross-district network identity',
      reason: 'cross-district-network',
      damage(fixture) {
        fixture.descriptor.linkedStructureIds = [fixture.descriptor.id + 1]
      },
    },
  ])('[R09][R28..R30][D04/D05] rejects $label', ({ damage, reason }) => {
    const fixture = referenceLatticeFixture()
    damage(fixture)
    expect(latticeContractReasons(fixture)).toContain(reason)
  })
})

describe('Lattice atomic release-state gate', () => {
  it('[R05-S02..S04][R06-S01..S03][R20-S02][R31-S01..S04][R33-S02][D11] binds the active Lattice profile to v24 pins, corpus identity, and Tower-independent generation', () => {
    expect(WORLD_GEN_VERSION).toBe(24)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.selected).toBe('office')
    expect(Object.fromEntries(Object.entries(DEFAULT_WORLD_CONFIG.mapFamily.profiles)
      .map(([family, profile]) => [family, profile.enabled]))).toEqual({
      office: true,
      sewer: true,
      tower: true,
      lattice: true,
      hotel: true,
    })

    expect(LATTICE_RELEASE_EVIDENCE).toMatchObject({
      family: MAP_FAMILY_LATTICE,
      byteImpact: 'changed-output',
      previousVersion: 23,
      generatorVersion: 24,
      profileIdentity: 'lattice-forced-audit:levels-5:district-4:anchors-8:cycles-0.12-0.25:exposure-5-20:cues-8',
      seedDerivation: 'hashStr("audit-lattice-N#1"), N=0..2',
      affectsMaximumHeight: true,
    })
    expect(LATTICE_RELEASE_EVIDENCE.generatorVersion)
      .toBe(LATTICE_RELEASE_EVIDENCE.previousVersion + 1)
    for (const digest of [
      LATTICE_RELEASE_EVIDENCE.globalGoldenDigest,
      LATTICE_RELEASE_EVIDENCE.maximumHeightGoldenDigest,
      LATTICE_RELEASE_EVIDENCE.familyRepresentativeDigest,
      LATTICE_RELEASE_EVIDENCE.familyCorpusDigest,
    ]) expect(digest).toMatch(/^[0-9a-f]{64}$/)

    const withoutTower = structuredClone(DEFAULT_WORLD_CONFIG)
    withoutTower.mapFamily.profiles.tower.enabled = false
    const config = worldConfigForFamily(MAP_FAMILY_LATTICE, withoutTower)
    const descriptor = findLatticeDescriptor(FIXED_SEEDS[0], config)
    expect(config.mapFamily.profiles.tower.enabled).toBe(false)
    expect(config.mapFamily.profiles.lattice.enabled).toBe(true)
    expect(latticeContractReasons(plannerFixture(FIXED_SEEDS[0], config))).toEqual([])
    expect(descriptor).toMatchObject({
      family: MAP_FAMILY_LATTICE,
      kind: LATTICE_KIND,
      levelCount: LEVELS,
    })
  })
})
