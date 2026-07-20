import { describe, expect, it } from 'vitest'
import { DEFAULT_WORLD_CONFIG, LATTICE_RELEASE_EVIDENCE } from '../config.js'
import { CHUNK, WORLD_GEN_VERSION } from '../constants.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { MAP_FAMILY_LATTICE } from '../mapTypes.js'
import { polygonCandidates } from '../structures/multilevel.js'
import { structureAt } from '../structures/contract.js'

const FIXED_SEEDS = Object.freeze([0x1a771ce, 0x5a17, 0xc0ffee])
const LATTICE_KIND = 'latticeDistrict'
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
    descriptor?.district?.size !== 3 ||
    !Number.isInteger(descriptor.district.x) ||
    !Number.isInteger(descriptor.district.z) ||
    participants.length !== 9 ||
    participants.some((participant) => !validParticipant(participant))
  ) return false

  const originCx = descriptor.district.x * 3
  const originCz = descriptor.district.z * 3
  const expected = []
  for (let dz = 0; dz < 3; dz++) {
    for (let dx = 0; dx < 3; dx++) {
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

function anchorsFormFiveByFive(descriptor) {
  const anchors = descriptor?.anchors ?? []
  if (anchors.length !== 25) return false
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
  if (ids.size !== 25 || xs.length !== 5 || zs.length !== 5 || positions.size !== 25) {
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

  if (participants.length !== 9) reasons.add('participant-cardinality')
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
    descriptor.district?.size !== 3 ||
    descriptor.levelCount !== 3 ||
    !Number.isInteger(descriptor.baseCy) ||
    descriptor.topCy !== descriptor.baseCy + 2 ||
    !validGlobalBounds(descriptor.globalBounds, participants)
  ) reasons.add('bounded-3x3x3')

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

  if (!anchorsFormFiveByFive(descriptor)) reasons.add('anchor-shape')
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
  if (
    !verticalPairs.has(descriptor.baseCy) ||
    !verticalPairs.has(descriptor.baseCy + 1)
  ) reasons.add('missing-vertical-link')
  if (!edges.some((edge) => edge.role === 'spine')) reasons.add('missing-spine')

  const verticalLinks = descriptor.verticalLinks ?? []
  const lowerFloors = [...new Set(verticalLinks.map((link) => link.lowerCy))]
    .sort((a, b) => a - b)
  if (
    verticalLinks.length !== 2 ||
    lowerFloors.length !== 2 ||
    lowerFloors[0] !== descriptor.baseCy ||
    lowerFloors[1] !== descriptor.baseCy + 1 ||
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
  const districtVolume = participants.length * CHUNK * CHUNK * 3
  if (bridgeCells.size === 0 || bridgeCells.size >= districtVolume) {
    reasons.add('non-sparse-bridge-fabric')
  }

  if (NETWORK_FIELDS.some((field) => descriptor[field] !== undefined)) {
    reasons.add('cross-district-network')
  }

  return [...reasons]
}

function edgeCellsBetween(a, b) {
  const cells = [{ gx: a.gx, gz: a.gz, cy: a.levelCy }]
  let { gx, gz } = a
  let cy = a.levelCy
  while (gx !== b.gx) {
    gx += Math.sign(b.gx - gx)
    cells.push({ gx, gz, cy })
  }
  while (gz !== b.gz) {
    gz += Math.sign(b.gz - gz)
    cells.push({ gx, gz, cy })
  }
  while (cy !== b.levelCy) {
    cy += Math.sign(b.levelCy - cy)
    cells.push({ gx, gz, cy })
  }
  const unique = new Map(cells.map((cell) => [`${cell.gx},${cell.gz},${cell.cy}`, cell]))
  return [...unique.values()].sort(compareCells)
}

function referenceLatticeFixture() {
  const baseCy = 4
  const participants = []
  for (let cz = 0; cz < 3; cz++) {
    for (let cx = 0; cx < 3; cx++) participants.push({ cx, cz })
  }

  const coordinates = [3, 11, 20, 29, 38]
  const anchors = []
  for (let row = 0; row < 5; row++) {
    const levelCy = baseCy + (row < 2 ? 0 : row < 4 ? 1 : 2)
    for (let column = 0; column < 5; column++) {
      const id = row * 5 + column
      anchors.push({
        id,
        gx: coordinates[column],
        gz: coordinates[row],
        levelCy,
        ...(id === 0 ? {} : { exposureM: id === 24 ? 20 : 5 }),
      })
    }
  }
  anchors.sort(compareAnchors)
  const anchorByPosition = new Map(anchors.map((anchor) => [`${anchor.gx},${anchor.gz}`, anchor]))

  const candidateLinks = []
  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 5; column++) {
      const anchor = anchorByPosition.get(`${coordinates[column]},${coordinates[row]}`)
      for (const [nextColumn, nextRow] of [[column + 1, row], [column, row + 1]]) {
        if (nextColumn >= 5 || nextRow >= 5) continue
        const next = anchorByPosition.get(`${coordinates[nextColumn]},${coordinates[nextRow]}`)
        const a = Math.min(anchor.id, next.id)
        const b = Math.max(anchor.id, next.id)
        const distance = Math.abs(anchor.gx - next.gx) +
          Math.abs(anchor.gz - next.gz) +
          Math.abs(anchor.levelCy - next.levelCy) * CHUNK
        candidateLinks.push({ a, b, weight: distance * 1000 + a * 25 + b })
      }
    }
  }

  const anchorIds = anchors.map(({ id }) => id)
  const treeKeys = minimumSpanningEdgeKeys(anchorIds, candidateLinks)
  const treeLinks = candidateLinks.filter((edge) => treeKeys.has(edgeKey(edge)))
  const nonTreeLinks = candidateLinks.filter((edge) => !treeKeys.has(edgeKey(edge)))
  const spineKeys = new Set(treeLinks
    .filter((edge) => {
      const a = anchors.find((anchor) => anchor.id === edge.a)
      const b = anchors.find((anchor) => anchor.id === edge.b)
      return a.levelCy === baseCy + 1 && b.levelCy === baseCy + 1
    })
    .slice(0, 4)
    .map(edgeKey))

  const makeEdge = (link, role) => {
    const a = anchors.find((anchor) => anchor.id === link.a)
    const b = anchors.find((anchor) => anchor.id === link.b)
    return {
      a: link.a,
      b: link.b,
      role,
      cells: edgeCellsBetween(a, b),
    }
  }
  const treeEdges = treeLinks.map((link) => {
    const a = anchors.find((anchor) => anchor.id === link.a)
    const b = anchors.find((anchor) => anchor.id === link.b)
    const role = a.levelCy !== b.levelCy
      ? 'vertical'
      : spineKeys.has(edgeKey(link)) ? 'spine' : 'backbone'
    return makeEdge(link, role)
  })
  const cycleEdges = nonTreeLinks.slice(0, 2).map((link) => makeEdge(link, 'cycle'))
  const edges = [...treeEdges, ...cycleEdges].sort(compareEdges)

  const verticalLinks = [baseCy, baseCy + 1].map((lowerCy) => {
    const edge = treeEdges.find((candidate) => {
      if (candidate.role !== 'vertical') return false
      const a = anchors.find((anchor) => anchor.id === candidate.a)
      const b = anchors.find((anchor) => anchor.id === candidate.b)
      return Math.min(a.levelCy, b.levelCy) === lowerCy
    })
    const anchor = anchors.find((candidate) => candidate.id === edge.b)
    return {
      lowerCy,
      cx: Math.floor(anchor.gx / CHUNK),
      cz: Math.floor(anchor.gz / CHUNK),
      stair: {
        dir: 0,
        landing: { lx: anchor.gx % CHUNK, lz: anchor.gz % CHUNK },
        run: [{ lx: anchor.gx % CHUNK, lz: (anchor.gz + 1) % CHUNK }],
        exit: { lx: anchor.gx % CHUNK, lz: (anchor.gz + 2) % CHUNK },
      },
    }
  })

  const descriptor = {
    id: 0x1a771ce,
    family: MAP_FAMILY_LATTICE,
    kind: LATTICE_KIND,
    hasRoom: true,
    district: { x: 0, z: 0, size: 3 },
    baseCy,
    topCy: baseCy + 2,
    levelCount: 3,
    participants,
    anchor: { ...participants[0] },
    globalBounds: { x0: 0, z0: 0, x1: CHUNK * 3 - 1, z1: CHUNK * 3 - 1 },
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
  it('[R08-S03][D04] enumerates one canonical complete 3x3 nine-participant polygon', () => {
    const participants = []
    for (let cz = 6; cz <= 8; cz++) {
      for (let cx = -3; cx <= -1; cx++) participants.push({ cx, cz })
    }
    expect(polygonCandidates(-1, 2, { districtChunks: 3 }, {
      shape: 'lattice3x3',
      avoidSpawn: false,
    })).toEqual([{
      anchor: { cx: -3, cz: 6 },
      participants,
    }])
    expect(polygonCandidates(0, 0, { districtChunks: 3 }, {
      shape: 'lattice3x3',
      bridgeAxis: 'x',
      avoidSpawn: true,
    })).toEqual([])
    expect(polygonCandidates(-1, 0, { districtChunks: 3 }, {
      shape: 'lattice3x3',
      bridgeAxis: 'z',
      avoidSpawn: true,
    })).toHaveLength(1)
    expect(polygonCandidates(-1, 2, { districtChunks: 4 }, {
      shape: 'lattice3x3',
      avoidSpawn: false,
    })).toEqual([])
  })

  it('[R08-S03][R09-S01..S06][R28-S01][D04/D05] emits one bounded canonical nine-owner descriptor', () => {
    for (const seed of FIXED_SEEDS) {
      const fixture = plannerFixture(seed)
      expect(latticeContractReasons(fixture)).toEqual([])
      expect(fixture.descriptor.participants).toHaveLength(9)
      expect(fixture.descriptor.anchors).toHaveLength(25)
      expect(fixture.descriptor.levelCount).toBe(3)
      expect(fixture.descriptor.participantChunks).toBeUndefined()
      expect(RUNTIME_ENVELOPE_FIELDS.every(
        (field) => fixture.descriptor[field] === undefined
      )).toBe(true)
    }
  })

  it('[R28-S02..S04][R29-S03..S04][D05] reproduces the production-weighted MST, bounded cycles, spine, and both vertical floor links', async () => {
    const { latticeCandidateLinks } = await latticePlannerApi()
    expect(
      latticeCandidateLinks,
      'generated MST evidence must use the production-owned candidate-weight contract'
    ).toBeTypeOf('function')

    for (const seed of FIXED_SEEDS) {
      const fixture = plannerFixture(seed)
      const candidates = latticeCandidateLinks(fixture.descriptor.anchors)
      const treeEdges = fixture.descriptor.edges.filter((edge) => TREE_ROLES.has(edge.role))
      const treeKeys = new Set(treeEdges.map(edgeKey))
      const expectedTreeKeys = minimumSpanningEdgeKeys(
        fixture.descriptor.anchors.map(({ id }) => id),
        candidates
      )
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

      fixture.candidateLinks = candidates
      const reasons = latticeContractReasons(fixture)
      expect(candidates.length).toBeGreaterThan(treeEdges.length)
      expect(candidates.every((candidate) =>
        Number.isInteger(candidate.a) &&
        Number.isInteger(candidate.b) &&
        candidate.a < candidate.b &&
        Number.isInteger(candidate.weight)
      )).toBe(true)
      expect(treeKeys).toEqual(expectedTreeKeys)
      expect(treeEdges).toHaveLength(24)
      expect(treeEdges.filter((edge) => edge.role === 'vertical')).toHaveLength(2)
      expect(treeEdges.filter((edge) => edge.role === 'spine').length)
        .toBeGreaterThanOrEqual(1)
      expect(fixture.descriptor.verticalLinks).toHaveLength(2)
      expect(fixture.descriptor.eligibleNonBackboneLinks).toBe(eligibleCycleKeys.size)
      expect(cycleEdges.every((edge) => eligibleCycleKeys.has(edgeKey(edge)))).toBe(true)
      expect(cycleEdges.every((edge) =>
        anchors.get(edge.a)?.levelCy === anchors.get(edge.b)?.levelCy
      )).toBe(true)
      expect(cycleEdges.length / eligibleCycleKeys.size).toBeGreaterThanOrEqual(0.08)
      expect(cycleEdges.length / eligibleCycleKeys.size).toBeLessThanOrEqual(0.15)
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

    const requests = descriptor.participants.flatMap(({ cx, cz }) =>
      [descriptor.baseCy, descriptor.baseCy + 1, descriptor.topCy]
        .map((cy) => ({ cx, cy, cz }))
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

    expect(selected).toEqual(minimum)
    expect(treeEdges).toHaveLength(fixture.descriptor.anchors.length - 1)
    expect(fixture.descriptor.edges.filter((edge) => edge.role === 'cycle')).toHaveLength(2)
    expect(2 / fixture.eligibleNonBackboneLinks).toBe(0.125)
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
        fixture.descriptor.participants[8] = { ...fixture.descriptor.participants[0] }
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
      label: 'non-3x3 participant shape',
      reason: 'participant-shape',
      damage(fixture) {
        fixture.descriptor.participants[8].cx += 1
        fixture.ownership[8].cx += 1
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
      reason: 'bounded-3x3x3',
      damage(fixture) {
        fixture.descriptor.district.size = 4
      },
    },
    {
      label: 'oversized floor band',
      reason: 'bounded-3x3x3',
      damage(fixture) {
        fixture.descriptor.levelCount = 4
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
      label: 'cycle reinsertion below 8 percent',
      reason: 'cycle-rate',
      damage(fixture) {
        const index = fixture.descriptor.edges.findIndex((edge) => edge.role === 'cycle')
        fixture.descriptor.edges.splice(index, 1)
      },
    },
    {
      label: 'cycle reinsertion above 15 percent',
      reason: 'cycle-rate',
      damage(fixture) {
        const used = new Set(fixture.descriptor.edges.map(edgeKey))
        const link = fixture.candidateLinks.find((edge) => !used.has(edgeKey(edge)))
        const anchors = new Map(fixture.descriptor.anchors.map((anchor) => [anchor.id, anchor]))
        fixture.descriptor.edges.push({
          a: link.a,
          b: link.b,
          role: 'cycle',
          cells: edgeCellsBetween(anchors.get(link.a), anchors.get(link.b)),
        })
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
  it('[R05-S02..S04][R06-S01..S03][R20-S02][R31-S01..S04][R33-S02][D11] binds the active Lattice profile to v20 pins, corpus identity, and Tower-independent generation', () => {
    expect(WORLD_GEN_VERSION).toBe(20)
    expect(DEFAULT_WORLD_CONFIG.mapFamily.selected).toBe('office')
    expect(Object.fromEntries(Object.entries(DEFAULT_WORLD_CONFIG.mapFamily.profiles)
      .map(([family, profile]) => [family, profile.enabled]))).toEqual({
      office: true,
      sewer: true,
      tower: true,
      lattice: true,
    })

    expect(LATTICE_RELEASE_EVIDENCE).toMatchObject({
      family: MAP_FAMILY_LATTICE,
      byteImpact: 'changed-output',
      previousVersion: 19,
      generatorVersion: 20,
      profileIdentity: 'lattice-forced-audit:levels-3:district-3:anchors-5:cycles-0.08-0.15:exposure-5-20:cues-8',
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
      levelCount: 3,
    })
  })
})
