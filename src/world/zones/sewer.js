import { CHUNK, ZONE_SEWER } from '../constants.js'
import { hash3i } from '../core/hash.js'
import { deepFreeze } from '../mapFamily.js'
import { countChunkComponents } from '../topology.js'
import { chunkStairs, stairStrip } from '../structures/slab.js'
import {
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  COLUMN_STANDARD,
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

// Sewer v2 — a gallery network carved out of solid ground instead of the old
// cell-filling comb. Real drainage is trunk-and-branch with landmark chambers
// at junctions (docs/.dev dossier: Yang 2017, Haghighi 2013, ASCE MOP 60), so
// the chunk is built the same way:
//
//   trunk    — one full-span straight gallery (the engineered spine; it keeps
//              the chunk crossable and orients the player),
//   pockets  — the two root-seeded stair strips become real manhole rooms:
//              strip + 1-cell halo carved as a lobby, connected to the trunk,
//              with the manholeUp/Down module labels ON the actual riser cells
//              (the labels used to be decoupled from the geometry),
//   chambers — one 3×3 and one 2×2 prescribed room (Pittman's seeded-rooms
//              rule): the landmarks the wayfinding research asks for,
//   branches — a few short dead-end service tunnels with a per-branch
//              right-turn bias (profile.rightTurnChance),
//   mouths   — every open border-seam cell is routed into the network, so
//              seam continuity never depends on interior luck,
//   mass     — every other cell stays solid (column-sealed) ground. The
//              negative space is what makes it read as tunnels, not a maze.
//
// Determinism: every decision owns a fixed salt over (seed, cx, cy, cz); no
// mutable RNG stream is consumed, so decisions cannot reorder each other.
const SEWER_SALTS = Object.freeze({
  id: 0x5e00,
  trunkHeading: 0x5e01,
  branchSide: 0x5e02,
  loopCount: 0x5e03,
  trunkLine: 0x5e05,
  branchCount: 0x5e06,
  loopPick: 0x5e10,
  chamberSmall: 0x5e21,
  chamberLarge: 0x5e22,
  branchSlot: 0x5e30,
  branchLen: 0x5e40,
  branchElbow: 0x5e50,
  candidateRetries: Object.freeze([0, 0x5e61, 0x5e62, 0x5e63]),
})

const UINT32_RANGE = 4294967296

// Region labels carried on every module: the dressing/lighting layers style a
// trunk gallery, a manhole room, and a service branch differently.
export const SEWER_REGION_TRUNK = 'trunk'
export const SEWER_REGION_CHAMBER = 'chamber'
export const SEWER_REGION_POCKET = 'pocket'
export const SEWER_REGION_BRANCH = 'branch'
export const SEWER_REGION_LINK = 'link'

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

// The forced-riser stair view shared with the pipeline's stamp stage: every
// sewer chunk realizes both slab halves, so manhole modules always have a real
// canonical riser behind them.
export function sewerStairConfig(config) {
  return {
    ...config,
    stairs: {
      ...config.stairs,
      enabled: true,
      chance: 1,
    },
  }
}

const DIRECTION_VECTOR = Object.freeze({
  [SEWER_DIR_NORTH]: Object.freeze({ dx: 0, dz: -1 }),
  [SEWER_DIR_EAST]: Object.freeze({ dx: 1, dz: 0 }),
  [SEWER_DIR_SOUTH]: Object.freeze({ dx: 0, dz: 1 }),
  [SEWER_DIR_WEST]: Object.freeze({ dx: -1, dz: 0 }),
})

function directionOfStep(dx, dz) {
  if (dx > 0) return SEWER_DIR_EAST
  if (dx < 0) return SEWER_DIR_WEST
  if (dz > 0) return SEWER_DIR_SOUTH
  return SEWER_DIR_NORTH
}

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

const inChunk = (lx, lz) => lx >= 0 && lx < CHUNK && lz >= 0 && lz < CHUNK
const posKey = (lx, lz) => lz * CHUNK + lx

// Interior wall-edge identity between two orthogonally adjacent cells.
function edgeKeyBetween(ax, az, bx, bz) {
  return ax === bx
    ? `h:${ax}:${Math.max(az, bz)}`
    : `v:${Math.max(ax, bx)}:${az}`
}

// --- Network builder -------------------------------------------------------
// The network is the module list under construction. Insertion order IS the
// canonical module order; every non-root cell records its carve parent, which
// becomes its tree edge.
class SewerNetwork {
  constructor() {
    this.cells = [] // { lx, lz, dir, parentIndex, region }
    this.indexByPos = new Map()
    this.blocked = new Set() // strip cells + down-run holes: never routed through
    // Strip cells stay off-limits to connector routing even once they become
    // modules: the stamp's flank guard walls would sever any corridor that
    // attached to (or crossed) a strip laterally. Connectors attach to the
    // halo ring instead.
    this.noAttach = new Set()
    this.holes = [] // down-run cells: carved open, but never modules
    this.holeSet = new Set()
    this.openEdges = new Set() // region-internal edges beyond tree/loop edges
  }

  has(lx, lz) {
    return this.indexByPos.has(posKey(lx, lz))
  }

  indexAt(lx, lz) {
    return this.indexByPos.get(posKey(lx, lz))
  }

  add(lx, lz, dir, parentIndex, region) {
    const index = this.cells.length
    this.cells.push({ lx, lz, dir, parentIndex, region })
    this.indexByPos.set(posKey(lx, lz), index)
    return index
  }

  isFree(lx, lz) {
    return inChunk(lx, lz) &&
      !this.has(lx, lz) &&
      !this.blocked.has(posKey(lx, lz)) &&
      !this.holeSet.has(posKey(lx, lz))
  }
}

const BFS_STEPS = Object.freeze([
  Object.freeze({ dx: -1, dz: 0 }),
  Object.freeze({ dx: 1, dz: 0 }),
  Object.freeze({ dx: 0, dz: -1 }),
  Object.freeze({ dx: 0, dz: 1 }),
])

// Shortest deterministic corridor from the existing network to `target`,
// tunnelling through solid mass but never through stair strips or holes.
// Carves the path cells as `link` modules parent-chained from the network.
function carveConnector(net, target, region = SEWER_REGION_LINK) {
  const targetKey = posKey(target.lx, target.lz)
  if (net.indexByPos.has(targetKey)) return net.indexAt(target.lx, target.lz)

  const cameFrom = new Map()
  const queue = []
  for (const cell of net.cells) {
    const key = posKey(cell.lx, cell.lz)
    cameFrom.set(key, -1)
    if (!net.noAttach.has(key)) queue.push([cell.lx, cell.lz])
  }
  let found = null
  for (let cursor = 0; cursor < queue.length && !found; cursor++) {
    const [x, z] = queue[cursor]
    for (const { dx, dz } of BFS_STEPS) {
      const nx = x + dx
      const nz = z + dz
      if (!inChunk(nx, nz)) continue
      const key = posKey(nx, nz)
      if (cameFrom.has(key)) continue
      if (net.blocked.has(key) || net.holeSet.has(key)) continue
      if (net.noAttach.has(key) && key !== targetKey) continue
      cameFrom.set(key, posKey(x, z))
      if (key === targetKey) {
        found = key
        break
      }
      queue.push([nx, nz])
    }
  }
  if (found === null) {
    throw new TypeError('Unroutable sewer connector')
  }

  // Rebuild the path target -> network, then carve network -> target so each
  // new cell parents to the one before it.
  const path = []
  let cursor = found
  while (cameFrom.get(cursor) !== -1) {
    path.push(cursor)
    cursor = cameFrom.get(cursor)
  }
  path.reverse()
  let parentIndex = net.indexByPos.get(cursor)
  let px = cursor % CHUNK
  let pz = (cursor / CHUNK) | 0
  let lastIndex = parentIndex
  for (const key of path) {
    const lx = key % CHUNK
    const lz = (key / CHUNK) | 0
    lastIndex = net.add(lx, lz, directionOfStep(lx - px, lz - pz), parentIndex, region)
    parentIndex = lastIndex
    px = lx
    pz = lz
  }
  return lastIndex
}

// Carve every un-carved cell of a rect as one open room region: modules are
// BFS parent-chained from the cells already inside the rect, every internal
// adjacency is opened, and hole cells stay carved-but-module-free.
function carveRoomRegion(net, rect, region, dir) {
  const inside = (lx, lz) =>
    lx >= rect.x0 && lx <= rect.x1 && lz >= rect.z0 && lz <= rect.z1
  const queue = []
  for (let lz = rect.z0; lz <= rect.z1; lz++) {
    for (let lx = rect.x0; lx <= rect.x1; lx++) {
      if (net.has(lx, lz)) queue.push([lx, lz])
    }
  }
  if (queue.length === 0) {
    throw new TypeError('Sewer room region requires an anchor inside the rect')
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [x, z] = queue[cursor]
    for (const { dx, dz } of BFS_STEPS) {
      const nx = x + dx
      const nz = z + dz
      if (!inside(nx, nz) || !inChunk(nx, nz)) continue
      if (net.has(nx, nz) || net.holeSet.has(posKey(nx, nz))) continue
      net.add(nx, nz, dir, net.indexAt(x, z), region)
      queue.push([nx, nz])
    }
  }
  // Open every internal adjacency between carved cells of the region (module
  // or hole), so chambers and manhole rooms read as rooms, not serpentines.
  const carved = (lx, lz) =>
    inside(lx, lz) && inChunk(lx, lz) &&
    (net.has(lx, lz) || net.holeSet.has(posKey(lx, lz)))
  for (let lz = rect.z0; lz <= rect.z1; lz++) {
    for (let lx = rect.x0; lx <= rect.x1; lx++) {
      if (!carved(lx, lz)) continue
      if (carved(lx + 1, lz)) net.openEdges.add(edgeKeyBetween(lx, lz, lx + 1, lz))
      if (carved(lx, lz + 1)) net.openEdges.add(edgeKeyBetween(lx, lz, lx, lz + 1))
    }
  }
}

function stripRect(contract) {
  let x0 = CHUNK
  let z0 = CHUNK
  let x1 = -1
  let z1 = -1
  for (const cell of stairStrip(contract)) {
    x0 = Math.min(x0, cell.lx)
    z0 = Math.min(z0, cell.lz)
    x1 = Math.max(x1, cell.lx)
    z1 = Math.max(z1, cell.lz)
  }
  return {
    x0: Math.max(0, x0 - 1),
    z0: Math.max(0, z0 - 1),
    x1: Math.min(CHUNK - 1, x1 + 1),
    z1: Math.min(CHUNK - 1, z1 + 1),
  }
}

// One full-span straight trunk gallery on a line that avoids both stair
// strips, so it never needs to jog through a guard wall.
function carveTrunk(net, seed, ctx, heading, blockedLines) {
  const { cx, cy, cz } = ctx
  const vec = DIRECTION_VECTOR[heading]
  const horizontal = vec.dx !== 0
  const candidates = []
  for (let line = 1; line < CHUNK - 1; line++) {
    if (!blockedLines.has(line)) candidates.push(line)
  }
  if (candidates.length === 0) {
    throw new TypeError('No sewer trunk line clear of both stair strips')
  }
  const trunkLine = candidates[
    saltedHash(seed, cx, cy, cz, SEWER_SALTS.trunkLine) % candidates.length
  ]

  let parentIndex = -1
  for (let step = 0; step < CHUNK; step++) {
    const along = vec.dx + vec.dz > 0 ? step : CHUNK - 1 - step
    const lx = horizontal ? along : trunkLine
    const lz = horizontal ? trunkLine : along
    parentIndex = net.add(lx, lz, heading, parentIndex, SEWER_REGION_TRUNK)
  }
  return trunkLine
}

// Prescribed landmark chambers (Pittman's seeded-rooms rule): pick a clear
// rect, corridor it to the network, then open it as a room.
function carveChamber(net, seed, ctx, size, salt, region) {
  const { cx, cy, cz } = ctx
  const candidates = []
  for (let z0 = 1; z0 + size - 1 <= CHUNK - 2; z0++) {
    for (let x0 = 1; x0 + size - 1 <= CHUNK - 2; x0++) {
      let free = true
      for (let z = z0; free && z < z0 + size; z++) {
        for (let x = x0; free && x < x0 + size; x++) {
          if (!net.isFree(x, z)) free = false
        }
      }
      if (free) candidates.push({ x0, z0 })
    }
  }
  if (candidates.length === 0) {
    throw new TypeError('No bounded sewer chamber slot')
  }
  const pick = candidates[saltedHash(seed, cx, cy, cz, salt) % candidates.length]
  const rect = { x0: pick.x0, z0: pick.z0, x1: pick.x0 + size - 1, z1: pick.z0 + size - 1 }
  const anchor = {
    lx: pick.x0 + ((size / 2) | 0),
    lz: pick.z0 + ((size / 2) | 0),
  }
  carveConnector(net, anchor)
  carveRoomRegion(net, rect, region, net.cells[net.indexAt(anchor.lx, anchor.lz)].dir)
  return { rect, anchor }
}

// Short dead-end service branches off the trunk. The per-branch side coin is
// where profile.rightTurnChance is consumed: real drainage branches favour one
// turning hand, and the player learns the bias.
function carveBranches(net, seed, ctx, profile, heading, trunkCount) {
  const { cx, cy, cz } = ctx
  const count = 3 + (saltedHash(seed, cx, cy, cz, SEWER_SALTS.branchCount) % 3)
  for (let k = 0; k < count; k++) {
    const slotRoll = saltedHash(seed, cx, cy, cz, SEWER_SALTS.branchSlot + k)
    const trunkIndex = 2 + (slotRoll % (trunkCount - 4))
    const trunkCell = net.cells[trunkIndex]
    const sideRoll = saltedHash(seed, cx, cy, cz, SEWER_SALTS.branchSide + k) / UINT32_RANGE
    const side = sideRoll < profile.rightTurnChance ? rightOf(heading) : leftOf(heading)
    let dir = side
    let vec = DIRECTION_VECTOR[dir]
    const length = 2 + (saltedHash(seed, cx, cy, cz, SEWER_SALTS.branchLen + k) % 5)
    const elbowRoll = saltedHash(seed, cx, cy, cz, SEWER_SALTS.branchElbow + k)
    const elbowAt = elbowRoll % 2 === 0 ? 1 + (elbowRoll >>> 8) % Math.max(1, length - 1) : -1

    const opposite = rightOf(rightOf(heading))
    let x = trunkCell.lx
    let z = trunkCell.lz
    let parentIndex = trunkIndex
    for (let step = 0; step < length; step++) {
      if (step === elbowAt) {
        // The elbow turns the branch parallel to the trunk: an L-shaped
        // service run, the shape real laterals take along a street.
        dir = (elbowRoll >>> 16) % 2 === 0 ? heading : opposite
        vec = DIRECTION_VECTOR[dir]
      }
      const nx = x + vec.dx
      const nz = z + vec.dz
      if (!net.isFree(nx, nz)) break
      parentIndex = net.add(nx, nz, dir, parentIndex, SEWER_REGION_BRANCH)
      x = nx
      z = nz
    }
  }
}

// Route every open border-seam cell into the network so cross-chunk galleries
// always continue: seam continuity is authored, never incidental.
function carveMouths(net, borders) {
  const sides = [
    { walls: borders?.wW, cell: (i) => ({ lx: 0, lz: i }) },
    { walls: borders?.wN, cell: (i) => ({ lx: i, lz: 0 }) },
    { walls: borders?.wE, cell: (i) => ({ lx: CHUNK - 1, lz: i }) },
    { walls: borders?.wS, cell: (i) => ({ lx: i, lz: CHUNK - 1 }) },
  ]
  for (const side of sides) {
    if (!side.walls) continue
    for (let i = 0; i < CHUNK; i++) {
      if (side.walls[i]) continue
      const cell = side.cell(i)
      if (net.has(cell.lx, cell.lz)) continue
      if (net.blocked.has(posKey(cell.lx, cell.lz))) continue
      carveConnector(net, cell)
    }
  }
}

function buildPlan(ctx) {
  const { cx, cy, cz, mapFamilyProfile: profile } = ctx
  validateProfile(profile)

  const seed = (ctx.layerSeed ?? ctx.seed ?? ctx.rootSeed) | 0
  const rootSeed = (ctx.rootSeed ?? seed) >>> 0
  const net = new SewerNetwork()

  // Root-seeded stair strips: the real vertical geometry the manhole modules
  // must sit on. Both strips land on interior lines and never cross (slab.js
  // parity families), so a trunk line clear of both always exists.
  const stairs = chunkStairs(rootSeed, cx, cz, cy, sewerStairConfig(ctx.config))
  const pockets = []
  const heading = SEWER_DIRECTIONS[
    saltedHash(seed, cx, cy, cz, SEWER_SALTS.trunkHeading) % SEWER_DIRECTIONS.length
  ]
  const horizontal = DIRECTION_VECTOR[heading].dx !== 0
  const blockedLines = new Set()

  const reserveStrip = (contract, kind) => {
    if (!contract?.hasStair) return
    const cells = stairStrip(contract)
    for (const cell of cells) {
      // Routing barrier AND attachment ban: corridors go around strips and
      // join the manhole room at its halo ring, never across a flank guard.
      net.blocked.add(posKey(cell.lx, cell.lz))
      net.noAttach.add(posKey(cell.lx, cell.lz))
      blockedLines.add(horizontal ? cell.lz : cell.lx)
    }
    if (kind === SEWER_MODULE_MANHOLE_DOWN) {
      // The two run cells become floor holes at stamp time; carve them open
      // but keep them out of the module list. The descend exit is the one
      // strip cell a connector may target (its outer edges survive the stamp).
      for (const cell of contract.run) {
        net.holes.push({ lx: cell.lx, lz: cell.lz })
        net.holeSet.add(posKey(cell.lx, cell.lz))
      }
      net.blocked.delete(posKey(contract.exit.lx, contract.exit.lz))
    }
    pockets.push({ contract, kind, rect: stripRect(contract) })
  }
  reserveStrip(stairs.up, SEWER_MODULE_MANHOLE_UP)
  reserveStrip(stairs.down, SEWER_MODULE_MANHOLE_DOWN)

  const trunkLine = carveTrunk(net, seed, ctx, heading, blockedLines)
  const trunkCount = net.cells.length

  // Manhole rooms: connect each pocket at its working end, then open the
  // strip + halo as one lobby. Up connects at the landing mouth; down at the
  // descend exit.
  const landmarkCells = []
  for (const pocket of pockets) {
    const { contract, kind } = pocket
    const anchor = kind === SEWER_MODULE_MANHOLE_UP
      ? {
          lx: contract.landing.lx - DIRECTION_VECTOR[headingOfStair(contract)].dx,
          lz: contract.landing.lz - DIRECTION_VECTOR[headingOfStair(contract)].dz,
        }
      : { lx: contract.exit.lx, lz: contract.exit.lz }
    carveConnector(net, anchor)
    carveRoomRegion(net, pocket.rect, SEWER_REGION_POCKET, headingOfStair(contract))
    const labelCell = kind === SEWER_MODULE_MANHOLE_UP ? contract.landing : contract.exit
    landmarkCells.push({ kind, index: net.indexAt(labelCell.lx, labelCell.lz) })
  }

  const chamberLarge = carveChamber(
    net, seed, ctx, 3, SEWER_SALTS.chamberLarge, SEWER_REGION_CHAMBER
  )
  const chamberSmall = carveChamber(
    net, seed, ctx, 2, SEWER_SALTS.chamberSmall, SEWER_REGION_CHAMBER
  )

  carveBranches(net, seed, ctx, profile, heading, trunkCount)
  carveMouths(net, ctx.borders)

  // Spawn guarantee: the fixed hub clearing at (0,0,0) must open into the
  // network, not into sealed mass.
  if (cx === 0 && cz === 0 && cy === 0) {
    carveConnector(net, { lx: (CHUNK / 2) | 0, lz: (CHUNK / 2) | 0 })
  }

  // Canonical tree edges from the carve parents.
  const treeEdges = []
  for (let index = 0; index < net.cells.length; index++) {
    const parentIndex = net.cells[index].parentIndex
    if (parentIndex >= 0) treeEdges.push(canonicalSewerEdge(parentIndex, index))
  }
  treeEdges.sort(compareSewerEdges)
  const treeEdgeKeys = new Set(treeEdges.map(({ a, b }) => sewerEdgeKey(a, b)))

  // Loop insertion over the module adjacency, exactly like v1: bounded count,
  // endpoint-disjoint, preferring links whose edge is still walled so a loop
  // is a real new connection.
  const eligibleNonTreeLinks = []
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const a = net.indexAt(lx, lz)
      if (a === undefined) continue
      for (const [nx, nz] of [[lx + 1, lz], [lx, lz + 1]]) {
        const b = net.indexAt(nx, nz)
        if (b === undefined || treeEdgeKeys.has(sewerEdgeKey(a, b))) continue
        eligibleNonTreeLinks.push(canonicalSewerEdge(a, b))
      }
    }
  }
  eligibleNonTreeLinks.sort(compareSewerEdges)

  if (profile.maxLoops >= eligibleNonTreeLinks.length) {
    throw new TypeError('Sewer loop budget must be smaller than the eligible non-tree link set')
  }

  const walledLink = ({ a, b }) => {
    const first = net.cells[a]
    const second = net.cells[b]
    return !net.openEdges.has(
      edgeKeyBetween(first.lx, first.lz, second.lx, second.lz)
    )
  }
  const loopTarget = profile.maxLoops === 0
    ? 0
    : 1 + (
        saltedHash(seed, cx, cy, cz, SEWER_SALTS.loopCount) % profile.maxLoops
      )
  const loopEdges = []
  const usedLoopEndpoints = new Set()
  for (let loopIndex = 0; loopIndex < loopTarget; loopIndex++) {
    const disjoint = eligibleNonTreeLinks.filter(({ a, b }) =>
      !usedLoopEndpoints.has(a) && !usedLoopEndpoints.has(b)
    )
    const available = disjoint.some(walledLink) ? disjoint.filter(walledLink) : disjoint
    if (available.length === 0) break
    const selected = available[
      saltedHash(seed, cx, cy, cz, SEWER_SALTS.loopPick + loopIndex) % available.length
    ]
    loopEdges.push(selected)
    usedLoopEndpoints.add(selected.a)
    usedLoopEndpoints.add(selected.b)
  }
  loopEdges.sort(compareSewerEdges)

  // Physical adjacency (tree + loops + room interiors) for kind assignment.
  const openEdgeKeys = new Set(net.openEdges)
  for (const { a, b } of [...treeEdges, ...loopEdges]) {
    const first = net.cells[a]
    const second = net.cells[b]
    openEdgeKeys.add(edgeKeyBetween(first.lx, first.lz, second.lx, second.lz))
  }
  const degree = net.cells.map((cell) => {
    let count = 0
    for (const { dx, dz } of BFS_STEPS) {
      const nx = cell.lx + dx
      const nz = cell.lz + dz
      if (!inChunk(nx, nz)) continue
      if (!net.has(nx, nz) && !net.holeSet.has(posKey(nx, nz))) continue
      if (openEdgeKeys.has(edgeKeyBetween(cell.lx, cell.lz, nx, nz))) count++
    }
    return count
  })

  const landmarkKinds = new Map(landmarkCells.map(({ index, kind }) => [index, kind]))
  const chamberRects = [
    { ...chamberLarge, kind: SEWER_MODULE_CHAMBER_LARGE },
    { ...chamberSmall, kind: SEWER_MODULE_CHAMBER_SMALL },
  ]
  const insideRect = (rect, lx, lz) =>
    lx >= rect.x0 && lx <= rect.x1 && lz >= rect.z0 && lz <= rect.z1

  const modules = net.cells.map((cell, index) => {
    let kind = landmarkKinds.get(index)
    if (!kind) {
      const chamber = chamberRects.find(({ rect }) => insideRect(rect, cell.lx, cell.lz))
      if (chamber) kind = chamber.kind
    }
    if (!kind) {
      if (degree[index] >= 3) {
        kind = SEWER_MODULE_T
      } else if (degree[index] === 2) {
        const open = []
        for (const { dx, dz } of BFS_STEPS) {
          const nx = cell.lx + dx
          const nz = cell.lz + dz
          if (!inChunk(nx, nz)) continue
          if (openEdgeKeys.has(edgeKeyBetween(cell.lx, cell.lz, nx, nz))) {
            open.push({ nx, nz })
          }
        }
        const straight = open.length === 2 &&
          (open[0].nx === open[1].nx || open[0].nz === open[1].nz)
        kind = straight ? SEWER_MODULE_DRY_STRETCH : SEWER_MODULE_L_BEND
      } else {
        kind = SEWER_MODULE_DRY_STRETCH
      }
    }
    return { kind, lx: cell.lx, lz: cell.lz, dir: cell.dir, region: cell.region }
  })

  return {
    seed,
    heading,
    trunkLine,
    trunkCount,
    modules,
    treeEdges,
    loopEdges,
    eligibleNonTreeLinks: eligibleNonTreeLinks.length,
    openEdges: openEdgeKeys,
    holes: net.holes,
    chambers: chamberRects.map(({ rect, anchor, kind }) => ({ ...rect, anchor, kind })),
    network: net,
  }
}

function headingOfStair(contract) {
  const dx = contract.run[0].lx - contract.landing.lx
  const dz = contract.run[0].lz - contract.landing.lz
  return directionOfStep(dx, dz)
}

function stampPlan(data, plan) {
  data.cellKind.fill(CELL_OPEN)

  // Cell states: network module / carved hole / solid mass.
  const carved = new Set()
  for (const module of plan.modules) carved.add(posKey(module.lx, module.lz))
  for (const hole of plan.holes) carved.add(posKey(hole.lx, hole.lz))

  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      data.setCol(lx, lz, carved.has(posKey(lx, lz)) ? 0 : COLUMN_STANDARD)
    }
  }

  // Interior walls: open edges stay open; any edge touching a carved cell is
  // a gallery wall; mass-internal edges stay unwalled (sealed by the gallery
  // walls around them, and columns already exclude mass from every graph).
  for (let z = 0; z < CHUNK; z++) {
    for (let lx = 1; lx < CHUNK; lx++) {
      const a = carved.has(posKey(lx - 1, z))
      const b = carved.has(posKey(lx, z))
      if (plan.openEdges.has(`v:${lx}:${z}`)) {
        data.setV(lx, z, 0, PASSAGE_OPEN)
      } else if (a || b) {
        data.setV(lx, z, 1, PASSAGE_WALL)
      }
    }
  }
  for (let lz = 1; lz < CHUNK; lz++) {
    for (let x = 0; x < CHUNK; x++) {
      const a = carved.has(posKey(x, lz - 1))
      const b = carved.has(posKey(x, lz))
      if (plan.openEdges.has(`h:${x}:${lz}`)) {
        data.setH(x, lz, 0, PASSAGE_OPEN)
      } else if (a || b) {
        data.setH(x, lz, 1, PASSAGE_WALL)
      }
    }
  }

  for (const module of plan.modules) {
    const index = module.lz * CHUNK + module.lx
    data.cellKind[index] =
      module.region === SEWER_REGION_CHAMBER || module.region === SEWER_REGION_POCKET
        ? CELL_LOBBY
        : CELL_CORRIDOR
  }
  for (const hole of plan.holes) {
    data.cellKind[hole.lz * CHUNK + hole.lx] = CELL_LOBBY
  }
}

// Compile one bounded dry sewer chunk. The canonical descriptor lives only on
// data.sewerDescriptor; zone-generator return values are deliberately not a
// second carrier for pipeline, digest, or audit consumers.
export function generate(data, ctx) {
  const plan = buildPlan(ctx)
  stampPlan(data, plan)

  data.sewerDescriptor = deepFreeze({
    family: SEWER_DESCRIPTOR_KIND,
    id: saltedHash(plan.seed, ctx.cx, ctx.cy, ctx.cz, SEWER_SALTS.id),
    bounds: { x0: 0, z0: 0, x1: CHUNK - 1, z1: CHUNK - 1 },
    trunkRoot: {
      lx: plan.modules[0].lx,
      lz: plan.modules[0].lz,
    },
    heading: plan.heading,
    trunkLine: plan.trunkLine,
    trunkCount: plan.trunkCount,
    chambers: plan.chambers,
    modules: plan.modules.map(({ kind, lx, lz, dir, region }) => ({
      kind, lx, lz, dir, region,
    })),
    treeEdges: plan.treeEdges,
    loopEdges: plan.loopEdges,
    eligibleNonTreeLinks: plan.eligibleNonTreeLinks,
  })
}
