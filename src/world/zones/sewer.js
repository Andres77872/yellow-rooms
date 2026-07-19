import { CHUNK, ZONE_SEWER } from '../constants.js'
import { hash3i } from '../core/hash.js'
import { deepFreeze } from '../mapFamily.js'
import { countChunkComponents } from '../topology.js'
import {
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  MAP_FAMILY_SEWER,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  SEWER_DIRECTIONS,
  SEWER_DIR_EAST,
  SEWER_DIR_NORTH,
  SEWER_DIR_SOUTH,
  SEWER_DIR_WEST,
  SEWER_MODULE_CHAMBER_LARGE,
  SEWER_MODULE_CHAMBER_SMALL,
  SEWER_MODULE_DRY_STRETCH,
  SEWER_MODULE_L_BEND,
  SEWER_MODULE_MANHOLE_DOWN,
  SEWER_MODULE_MANHOLE_UP,
  SEWER_MODULE_T,
} from '../mapTypes.js'

export const id = ZONE_SEWER
export const SEWER_DESCRIPTOR_KIND = MAP_FAMILY_SEWER
export const SEWER_RIGHT_TURN_CHANCE = 0.65

// Every decision owns a fixed salt. Adding a later decision therefore cannot
// consume values from, or reorder, another stage's mutable RNG stream.
const SEWER_SALTS = Object.freeze({
  id: 0x5e00,
  trunkHeading: 0x5e01,
  branchSide: 0x5e02,
  loopCount: 0x5e03,
  loopPick: 0x5e10,
  chamberSmall: 0x5e21,
  chamberLarge: 0x5e22,
  manholeUp: 0x5e23,
  manholeDown: 0x5e24,
  candidateRetries: Object.freeze([0, 0x5e61, 0x5e62, 0x5e63]),
})

const UINT32_RANGE = 4294967296

// Descriptor graph identity is shared by planning, pipeline validation, and
// family auditing. Edges always address zero-based module indexes.
export const compareSewerEdges = (left, right) =>
  left.a - right.a || left.b - right.b

export function canonicalSewerEdge(a, b) {
  return a < b ? { a, b } : { a: b, b: a }
}

export function sewerEdgeKey(a, b) {
  const canonical = canonicalSewerEdge(a, b)
  return `${canonical.a}:${canonical.b}`
}

export const sewerCellKey = (lx, lz) => `${lx},${lz}`

export const sewerCandidateSeeds = (layerSeed) =>
  SEWER_SALTS.candidateRetries.map((salt) => (layerSeed ^ salt) >>> 0)

export const isConnectedSewerCandidate = (data) =>
  countChunkComponents(data, true) === 1

const DIRECTION_VECTOR = Object.freeze({
  [SEWER_DIR_NORTH]: Object.freeze({ dx: 0, dz: -1 }),
  [SEWER_DIR_EAST]: Object.freeze({ dx: 1, dz: 0 }),
  [SEWER_DIR_SOUTH]: Object.freeze({ dx: 0, dz: 1 }),
  [SEWER_DIR_WEST]: Object.freeze({ dx: -1, dz: 0 }),
})

const LANDMARK_SPECS = Object.freeze([
  Object.freeze({ kind: SEWER_MODULE_CHAMBER_SMALL, slot: 0, salt: SEWER_SALTS.chamberSmall }),
  Object.freeze({ kind: SEWER_MODULE_CHAMBER_LARGE, slot: 1, salt: SEWER_SALTS.chamberLarge }),
  Object.freeze({ kind: SEWER_MODULE_MANHOLE_UP, slot: 2, salt: SEWER_SALTS.manholeUp }),
  Object.freeze({ kind: SEWER_MODULE_MANHOLE_DOWN, slot: 3, salt: SEWER_SALTS.manholeDown }),
])

function saltedHash(seed, cx, cy, cz, salt) {
  return hash3i((seed ^ salt) | 0, cx, cz, cy)
}

function rightOf(direction) {
  return SEWER_DIRECTIONS[(SEWER_DIRECTIONS.indexOf(direction) + 1) % SEWER_DIRECTIONS.length]
}

function leftOf(direction) {
  return SEWER_DIRECTIONS[
    (SEWER_DIRECTIONS.indexOf(direction) + SEWER_DIRECTIONS.length - 1) %
      SEWER_DIRECTIONS.length
  ]
}

function rootCoordinate(heading, branchDirection) {
  const headingVector = DIRECTION_VECTOR[heading]
  const branchVector = DIRECTION_VECTOR[branchDirection]
  return {
    lx: headingVector.dx > 0
      ? 0
      : headingVector.dx < 0
        ? CHUNK - 1
        : branchVector.dx > 0 ? 0 : CHUNK - 1,
    lz: headingVector.dz > 0
      ? 0
      : headingVector.dz < 0
        ? CHUNK - 1
        : branchVector.dz > 0 ? 0 : CHUNK - 1,
  }
}

function validateProfile(profile) {
  if (
    profile?.family !== MAP_FAMILY_SEWER ||
    !Number.isInteger(profile.maxLoops) ||
    profile.maxLoops < 0 ||
    profile.rightTurnChance !== SEWER_RIGHT_TURN_CHANCE
  ) {
    throw new TypeError('Invalid sewer map-family profile')
  }
}

function buildTrunkFirstPlan(ctx) {
  const { cx, cy, cz, mapFamilyProfile: profile } = ctx
  validateProfile(profile)

  const seed = (ctx.layerSeed ?? ctx.seed ?? ctx.rootSeed) | 0
  const heading = SEWER_DIRECTIONS[
    saltedHash(seed, cx, cy, cz, SEWER_SALTS.trunkHeading) % SEWER_DIRECTIONS.length
  ]
  const rightTurnRoll = saltedHash(seed, cx, cy, cz, SEWER_SALTS.branchSide) / UINT32_RANGE
  const branchDirection = rightTurnRoll < profile.rightTurnChance
    ? rightOf(heading)
    : leftOf(heading)
  const headingVector = DIRECTION_VECTOR[heading]
  const branchVector = DIRECTION_VECTOR[branchDirection]
  const root = rootCoordinate(heading, branchDirection)

  // Canonical module order is trunk first, then each branch in trunk order and
  // outward order. Tree-edge endpoints are indexes into this exact array.
  const modules = []
  const treeEdges = []
  for (let step = 0; step < CHUNK; step++) {
    modules.push({
      lx: root.lx + headingVector.dx * step,
      lz: root.lz + headingVector.dz * step,
      dir: heading,
    })
    if (step > 0) treeEdges.push(canonicalSewerEdge(step - 1, step))
  }

  for (let trunkIndex = 0; trunkIndex < CHUNK; trunkIndex++) {
    const trunk = modules[trunkIndex]
    let parentIndex = trunkIndex
    for (let step = 1; step < CHUNK; step++) {
      const moduleIndex = modules.length
      modules.push({
        lx: trunk.lx + branchVector.dx * step,
        lz: trunk.lz + branchVector.dz * step,
        dir: branchDirection,
      })
      treeEdges.push(canonicalSewerEdge(parentIndex, moduleIndex))
      parentIndex = moduleIndex
    }
  }
  treeEdges.sort(compareSewerEdges)

  const indexByCell = new Map(
    modules.map((module, moduleIndex) => [sewerCellKey(module.lx, module.lz), moduleIndex])
  )
  const treeEdgeKeys = new Set(treeEdges.map(({ a, b }) => sewerEdgeKey(a, b)))
  const eligibleNonTreeLinks = []
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const a = indexByCell.get(sewerCellKey(lx, lz))
      for (const [nx, nz] of [[lx + 1, lz], [lx, lz + 1]]) {
        const b = indexByCell.get(sewerCellKey(nx, nz))
        if (b === undefined || treeEdgeKeys.has(sewerEdgeKey(a, b))) continue
        eligibleNonTreeLinks.push(canonicalSewerEdge(a, b))
      }
    }
  }
  eligibleNonTreeLinks.sort(compareSewerEdges)

  if (profile.maxLoops >= eligibleNonTreeLinks.length) {
    throw new TypeError('Sewer loop budget must be smaller than the eligible non-tree link set')
  }

  // Loops are inserted only after the connected spanning tree exists. Endpoint
  // disjointness keeps the seven-token MVP free of implicit degree-four crosses.
  const loopTarget = profile.maxLoops === 0
    ? 0
    : 1 + (
        saltedHash(seed, cx, cy, cz, SEWER_SALTS.loopCount) % profile.maxLoops
      )
  const loopEdges = []
  const usedLoopEndpoints = new Set()
  for (let loopIndex = 0; loopIndex < loopTarget; loopIndex++) {
    const available = eligibleNonTreeLinks.filter(({ a, b }) =>
      !usedLoopEndpoints.has(a) && !usedLoopEndpoints.has(b)
    )
    if (available.length === 0) break
    const selected = available[
      saltedHash(seed, cx, cy, cz, SEWER_SALTS.loopPick + loopIndex) % available.length
    ]
    loopEdges.push(selected)
    usedLoopEndpoints.add(selected.a)
    usedLoopEndpoints.add(selected.b)
  }
  loopEdges.sort(compareSewerEdges)

  const adjacency = Array.from({ length: modules.length }, () => [])
  for (const { a, b } of [...treeEdges, ...loopEdges]) {
    adjacency[a].push(b)
    adjacency[b].push(a)
  }

  // Each landmark owns a disjoint modulo slot and a dedicated salt, so chamber
  // or manhole placement cannot become a parallel descriptor or shift another
  // landmark's deterministic decision stream.
  const landmarkKinds = new Map()
  for (const { kind, slot, salt } of LANDMARK_SPECS) {
    const candidates = modules
      .map((_, moduleIndex) => moduleIndex)
      .filter((moduleIndex) =>
        moduleIndex >= CHUNK &&
        moduleIndex % LANDMARK_SPECS.length === slot &&
        adjacency[moduleIndex].length === 2 &&
        !usedLoopEndpoints.has(moduleIndex)
      )
    if (candidates.length === 0) throw new TypeError(`No bounded sewer landmark slot for ${kind}`)
    const selected = candidates[saltedHash(seed, cx, cy, cz, salt) % candidates.length]
    landmarkKinds.set(selected, kind)
  }

  const canonicalModules = modules.map((module, moduleIndex) => {
    let kind = landmarkKinds.get(moduleIndex)
    if (!kind) {
      const neighbours = adjacency[moduleIndex]
      if (neighbours.length === 3) {
        kind = SEWER_MODULE_T
      } else if (neighbours.length === 2) {
        const first = modules[neighbours[0]]
        const second = modules[neighbours[1]]
        const straight = first.lx === second.lx || first.lz === second.lz
        kind = straight ? SEWER_MODULE_DRY_STRETCH : SEWER_MODULE_L_BEND
      } else {
        kind = SEWER_MODULE_DRY_STRETCH
      }
    }
    return { kind, lx: module.lx, lz: module.lz, dir: module.dir }
  })

  return {
    seed,
    modules: canonicalModules,
    treeEdges,
    loopEdges,
    eligibleNonTreeLinks: eligibleNonTreeLinks.length,
  }
}

function openModuleEdge(data, modules, { a, b }) {
  const first = modules[a]
  const second = modules[b]
  if (first.lx === second.lx) {
    data.setH(first.lx, Math.max(first.lz, second.lz), 0, PASSAGE_OPEN)
  } else {
    data.setV(Math.max(first.lx, second.lx), first.lz, 0, PASSAGE_OPEN)
  }
}

function stampPlan(data, plan) {
  data.cellKind.fill(CELL_OPEN)
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      data.setCol(lx, lz, 0)
      if (lx > 0) data.setPassageV(lx, lz, PASSAGE_WALL)
      if (lz > 0) data.setPassageH(lx, lz, PASSAGE_WALL)
    }
  }

  for (const treeEdge of plan.treeEdges) openModuleEdge(data, plan.modules, treeEdge)
  for (const loopEdge of plan.loopEdges) openModuleEdge(data, plan.modules, loopEdge)

  for (let moduleIndex = 0; moduleIndex < plan.modules.length; moduleIndex++) {
    const module = plan.modules[moduleIndex]
    const index = module.lz * CHUNK + module.lx
    if (moduleIndex < CHUNK) data.cellKind[index] = CELL_CORRIDOR
    if (
      module.kind === SEWER_MODULE_CHAMBER_SMALL ||
      module.kind === SEWER_MODULE_CHAMBER_LARGE
    ) {
      data.cellKind[index] = CELL_LOBBY
    }
  }
}

// Compile one bounded dry sewer chunk. The canonical descriptor lives only on
// data.sewerDescriptor; zone-generator return values are deliberately not a
// second carrier for pipeline, digest, or audit consumers.
export function generate(data, ctx) {
  const plan = buildTrunkFirstPlan(ctx)
  stampPlan(data, plan)

  data.sewerDescriptor = deepFreeze({
    family: SEWER_DESCRIPTOR_KIND,
    id: saltedHash(plan.seed, ctx.cx, ctx.cy, ctx.cz, SEWER_SALTS.id),
    bounds: { x0: 0, z0: 0, x1: CHUNK - 1, z1: CHUNK - 1 },
    trunkRoot: {
      lx: plan.modules[0].lx,
      lz: plan.modules[0].lz,
    },
    modules: plan.modules,
    treeEdges: plan.treeEdges,
    loopEdges: plan.loopEdges,
    eligibleNonTreeLinks: plan.eligibleNonTreeLinks,
  })
}
