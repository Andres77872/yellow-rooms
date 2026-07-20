import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { buildChunk } from '../pipeline.js'
import { generateChunk } from '../generate.js'
import { vBorderContract, hBorderContract } from '../border.js'
import {
  DEFAULT_WORLD_CONFIG as CFG,
  LATTICE_RELEASE_EVIDENCE,
  SEWER_RELEASE_EVIDENCE,
  TOWER_RELEASE_EVIDENCE,
} from '../config.js'
import {
  CHUNK,
  LAYER_H,
  ZONE_OFFICE,
  ZONE_PILLARS,
  ZONE_SEWER,
  WORLD_GEN_VERSION,
  cIdx,
  fmod,
} from '../constants.js'
import { fmix32, hash2i } from '../core/hash.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_STAIR,
  CELL_VOID,
  COLUMN_NONE,
  COLUMN_MONUMENTAL,
  COLUMN_STANDARD,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  SEWER_DIRECTIONS,
  SEWER_MODULE_KINDS,
  WALL_PLAIN,
  WALL_RAIL,
} from '../mapTypes.js'
import { countChunkComponents } from '../topology.js'
import { layerSeed } from '../pipeline.js'
import {
  multilevelBandBase,
  multilevelConfig,
  multilevelContract,
} from '../structures/multilevel.js'
import { pillarColumnKindAt } from '../zones/pillars.js'
import {
  regionLandmark,
  regionLandmarkAt,
  regionLandmarkContains,
} from '../zones/regions.js'
import { MAP_FAMILY_CODES, worldConfigForFamily } from '../mapFamily.js'
import { latticeCandidateLinks } from '../structures/lattice.js'
import { structureAt } from '../structures/contract.js'
import { ZONES } from '../zones/index.js'

const RASTER_FIELDS = [
  'wallV',
  'wallH',
  'passageV',
  'passageH',
  'wallFeatureV',
  'wallFeatureH',
  'cols',
  'cellKind',
  'spaceId',
  'spaceRole',
]

// Stable fold over a chunk's full state — pins the generator output so any
// accidental algorithm drift fails CI (intentional changes bump WORLD_GEN_VERSION
// and re-pin these). Computed from the committed implementation.
function digest(d) {
  let h = 0x9e3779b1 | 0
  const fold = (v) => {
    h = fmix32((h ^ v) | 0) | 0
  }
  const foldMaybeInt = (v) => {
    if (!Number.isInteger(v)) {
      fold(0)
      return
    }
    fold(1)
    fold(v)
  }
  const foldBounds = (bounds) => {
    if (!bounds) {
      fold(0)
      return
    }
    fold(1)
    for (const key of ['x0', 'z0', 'x1', 'z1']) fold(bounds[key])
  }
  const foldAxis = (axis) => fold(axis === 'x' ? 1 : axis === 'z' ? 2 : 0)
  const foldKind = (kind) => fold(
    kind === 'bridged'
      ? 1
      : kind === 'openVoid'
        ? 2
        : kind === 'towerSkybridge'
          ? 3
          : kind === 'latticeDistrict'
            ? 4
            : 0
  )
  const foldCells = (cells, xKey = 'lx', zKey = 'lz') => {
    fold(cells.length)
    for (const cell of cells) {
      fold(cell[xKey])
      fold(cell[zKey])
    }
  }
  fold(d.version)
  fold(d.cx)
  fold(d.cy)
  fold(d.cz)
  for (const arr of [
    d.wallV,
    d.wallH,
    d.passageV,
    d.passageH,
    d.wallFeatureV,
    d.wallFeatureH,
    d.cols,
    d.cellKind,
    d.spaceId,
    d.spaceRole,
  ]) {
    for (const v of arr) fold(v)
  }
  for (const l of d.lamps) {
    fold(l.lx)
    fold(l.lz)
    fold(l.lit ? 1 : 0)
  }
  // Furniture records: positions/sizes are quantized to millimetres so the
  // fold stays integer-exact while still pinning every piece's placement.
  fold(d.furniture.length)
  for (const f of d.furniture) {
    fold(f.kind)
    fold(f.lx)
    fold(f.lz)
    fold(f.facing)
    for (const v of [f.x, f.z, f.w, f.d]) fold(Math.round(v * 1000))
  }
  // The family foundation reuses the existing zone fold. Office is code 0,
  // so both the pre-foundation fixture and the future explicit `office` value
  // retain every established digest without adding another fold operation.
  const familyCode = d.mapFamily == null
    ? MAP_FAMILY_CODES.office
    : MAP_FAMILY_CODES[d.mapFamily]
  if (!Number.isInteger(familyCode)) throw new Error(`unknown map family: ${d.mapFamily}`)
  fold((familyCode << 8) | d.zone)
  fold(d.repairs.connectivity)
  fold(d.repairs.navigation)
  fold(d.repairs.columns)
  if (d.exit) {
    fold(1)
    fold(d.exit.lx)
    fold(d.exit.lz)
  } else fold(0)
  const foldStair = (s) => {
    if (!s) {
      fold(0)
      return
    }
    fold(1)
    fold(s.dir)
    for (const c of [s.landing, s.run[0], s.run[1], s.exit]) {
      fold(c.lx)
      fold(c.lz)
    }
  }
  foldStair(d.stairUp)
  foldStair(d.stairDown)
  const foldMultilevel = (room) => {
    if (!room) {
      fold(0)
      return
    }
    fold(1)
    fold(room.hasRoom ? 1 : 0)
    fold(room.id)
    fold(room.baseCy)
    fold(room.topCy)
    fold(room.lowerCy)
    fold(room.levelCy)
    foldKind(room.kind)
    foldAxis(room.bridgeAxis)
    // Keep both aliases in the digest: changing either coordinate contract is
    // observable generator drift even when the other remains intact.
    foldBounds(room.bounds)
    foldBounds(room.localBounds)
    foldBounds(room.globalBounds)
    foldMaybeInt(room.bridgeLine)
    foldMaybeInt(room.globalBridgeLine)
    foldCells(room.voidCells)
    foldCells(room.bridgeCells)
    if (
      room.family === MAP_FAMILY_LATTICE ||
      room.kind === 'latticeDistrict'
    ) {
      fold(MAP_FAMILY_CODES[room.family] ?? -1)
      fold(room.bridgeSegments.length)
      for (const segment of room.bridgeSegments) {
        fold(segment.a)
        fold(segment.b)
        fold(['backbone', 'cycle', 'spine', 'vertical'].indexOf(segment.role) + 1)
        fold(segment.orientation === 'horizontal'
          ? 1
          : segment.orientation === 'vertical' ? 2 : 0)
        fold(segment.cells.length)
        for (const cell of segment.cells) {
          fold(cell.gx)
          fold(cell.gz)
          fold(cell.cy)
        }
      }
    }
  }
  const foldStructure = (structure) => {
    if (!structure) {
      fold(0)
      return
    }
    fold(1)
    fold(structure.hasRoom ? 1 : 0)
    fold(structure.id)
    if (
      structure.family === MAP_FAMILY_TOWER ||
      structure.kind === 'towerSkybridge'
    ) {
      fold(MAP_FAMILY_CODES[structure.family] ?? -1)
      foldKind(structure.kind)
      fold(structure.district.x)
      fold(structure.district.z)
      fold(structure.district.size)
      fold(structure.baseCy)
      fold(structure.topCy)
      fold(structure.levelCount)
      foldAxis(structure.bridgeAxis)
      fold(structure.anchor.cx)
      fold(structure.anchor.cz)
      fold(structure.participants.length)
      for (const participant of structure.participants) {
        fold(participant.cx)
        fold(participant.cz)
      }
      foldBounds(structure.globalBounds)
      fold(structure.decks.length)
      for (const deck of structure.decks) {
        fold(deck.levelCy)
        fold(deck.lowerCy)
        fold(deck.globalBridgeLine)
        foldBounds(deck.globalBounds)
        foldCells(deck.globalCells, 'gx', 'gz')
      }
      fold(structure.verticalLinks.length)
      for (const link of structure.verticalLinks) {
        fold(link.lowerCy)
        fold(link.cx)
        fold(link.cz)
        foldStair(link.stair)
      }
      fold(structure.landmarkSockets.length)
      for (const socket of structure.landmarkSockets) {
        fold(socket.slot === 'anchorFloor' ? 1 : socket.slot === 'bridgeApproach' ? 2 : 0)
        fold([
          'signage',
          'clock',
          'litAccent',
          'door',
          'fixture',
        ].indexOf(socket.kind) + 1)
        fold(socket.gx)
        fold(socket.gz)
        fold(socket.cy)
        foldAxis(socket.axis)
        fold(socket.side)
        fold(socket.salt)
      }
      return
    }
    if (
      structure.family === MAP_FAMILY_LATTICE ||
      structure.kind === 'latticeDistrict'
    ) {
      fold(MAP_FAMILY_CODES[structure.family] ?? -1)
      foldKind(structure.kind)
      fold(structure.district.x)
      fold(structure.district.z)
      fold(structure.district.size)
      fold(structure.baseCy)
      fold(structure.topCy)
      fold(structure.levelCount)
      fold(structure.anchor.cx)
      fold(structure.anchor.cz)
      fold(structure.participants.length)
      for (const participant of structure.participants) {
        fold(participant.cx)
        fold(participant.cz)
      }
      foldBounds(structure.globalBounds)
      fold(structure.anchors.length)
      for (const anchor of structure.anchors) {
        fold(anchor.id)
        fold(anchor.gx)
        fold(anchor.gz)
        fold(anchor.levelCy)
        foldMaybeInt(anchor.exposureM)
      }
      fold(structure.edges.length)
      for (const edge of structure.edges) {
        fold(edge.a)
        fold(edge.b)
        fold(['backbone', 'cycle', 'spine', 'vertical'].indexOf(edge.role) + 1)
        fold(edge.cells.length)
        for (const cell of edge.cells) {
          fold(cell.gx)
          fold(cell.gz)
          fold(cell.cy)
        }
      }
      fold(structure.eligibleNonBackboneLinks)
      fold(structure.verticalLinks.length)
      for (const link of structure.verticalLinks) {
        fold(link.lowerCy)
        fold(link.cx)
        fold(link.cz)
        foldStair(link.stair)
      }
      return
    }
    foldKind(structure.kind)
    fold(structure.district.x)
    fold(structure.district.z)
    fold(structure.district.size)
    fold(structure.bandIndex)
    fold(structure.baseCy)
    fold(structure.bottomCy)
    fold(structure.topCy)
    fold(structure.levelCount)
    fold(structure.height)
    foldAxis(structure.bridgeAxis)
    fold(structure.longSpan)
    fold(structure.shortSpan)
    fold(structure.anchor.cx)
    fold(structure.anchor.cz)
    for (const participants of [structure.participants, structure.participantChunks]) {
      fold(participants.length)
      for (const participant of participants) {
        fold(participant.cx)
        fold(participant.cz)
      }
    }
    foldBounds(structure.bounds)
    foldBounds(structure.globalBounds)
    fold(structure.centerLines.length)
    for (const line of structure.centerLines) fold(line)
    fold(structure.bridgeLevels.length)
    for (const level of structure.bridgeLevels) fold(level)
    fold(structure.decks.length)
    for (const deck of structure.decks) {
      fold(deck.levelCy)
      fold(deck.lowerCy)
      fold(deck.globalBridgeLine)
      foldBounds(deck.globalBounds)
      foldCells(deck.globalCells, 'gx', 'gz')
    }
  }
  foldStructure(d.structure)
  foldMultilevel(d.structureUp)
  foldMultilevel(d.structureDown)
  if (
    d.mapFamily === MAP_FAMILY_TOWER ||
    d.mapFamily === MAP_FAMILY_LATTICE
  ) {
    const foldLethalVoidHalf = (half) => {
      if (!half) {
        fold(0)
        return
      }
      fold(1)
      fold(half.id)
      fold(MAP_FAMILY_CODES[half.family] ?? -1)
      fold(half.lowerCy)
      fold(half.cells.length)
      for (const cell of half.cells) {
        fold(cell.lx)
        fold(cell.lz)
        fold(cell.deathYmm)
      }
    }
    foldLethalVoidHalf(d.lethalVoidUp)
    foldLethalVoidHalf(d.lethalVoidDown)
  }
  if (d.mapFamily === MAP_FAMILY_SEWER) {
    const descriptor = d.sewerDescriptor
    if (!descriptor) {
      fold(0)
    } else {
      fold(1)
      fold(MAP_FAMILY_CODES[descriptor.family] ?? -1)
      fold(descriptor.id)
      foldBounds(descriptor.bounds)
      fold(descriptor.trunkRoot.lx)
      fold(descriptor.trunkRoot.lz)
      fold(descriptor.modules.length)
      for (const module of descriptor.modules) {
        fold(SEWER_MODULE_KINDS.indexOf(module.kind) + 1)
        fold(module.lx)
        fold(module.lz)
        fold(SEWER_DIRECTIONS.indexOf(module.dir) + 1)
      }
      for (const edges of [descriptor.treeEdges, descriptor.loopEdges]) {
        fold(edges.length)
        for (const edge of edges) {
          fold(edge.a)
          fold(edge.b)
        }
      }
      fold(descriptor.eligibleNonTreeLinks)
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// Re-pinned whenever WORLD_GEN_VERSION changes. Coordinates cover all three
// zones AND multiple layers; the digest includes semantic passages, spaces,
// repair metadata, plan-aware stairs, furniture records, and representative
// v13 structures. The final twelve entries pin bottom/middle/top in both
// chunks of deterministic maximum-height bridged and open-void structures.
const GOLDEN = {
  '0,0,0': 'b7ef3f61',
  '3,0,-2': 'e0f45a00',
  '12,0,12': '4746f7ac',
  '-10,0,10': '2ba53576',
  '0,1,0': 'f8eb81c4',
  '3,-1,-2': '73787c90',
  '12,2,12': 'f90a47d8',
  '3,-2,-12': 'c35a6b9e',
  '3,-1,-12': '9a2c5fe2',
  '1,0,-2': 'b1361f10',
  '2,1,-2': '9d435ddb',
  '1,7,-2': 'ec293214',
  '-1,0,2': '4e9fc1e3',
  '-1,3,3': 'da93faaa',
  '-7,9,-8': '450e98fe',
  '-3,-15,-1': 'fb00ed20',
  '-2,-15,-1': '8a5a55fa',
  '-3,-8,-1': '5865f84c',
  '-2,-8,-1': '371ed0fd',
  '-3,-1,-1': 'c1e95ff2',
  '-2,-1,-1': 'd677fb20',
  '-10,0,8': '1c85ff56',
  '-10,0,9': 'c6931b70',
  '-10,7,8': 'a50bf469',
  '-10,7,9': 'd0e32f1a',
  '-10,14,8': 'cf124cfe',
  '-10,14,9': 'd021f7c0',
}

const MAX_HEIGHT_GOLDEN = {
  bridged: ['-3,-15,-1', '-2,-15,-1', '-3,-8,-1', '-2,-8,-1', '-3,-1,-1', '-2,-1,-1'],
  openVoid: ['-10,0,8', '-10,0,9', '-10,7,8', '-10,7,9', '-10,14,8', '-10,14,9'],
}

const SEWER_GOLDEN = Object.freeze([
  { key: '24151,2,-1,-3', seed: 24151, cx: 2, cy: -1, cz: -3, digest: '81fcf46f' },
  { key: '24151,2,0,-3', seed: 24151, cx: 2, cy: 0, cz: -3, digest: 'd3f98adf' },
  { key: '24151,2,1,-3', seed: 24151, cx: 2, cy: 1, cz: -3, digest: '6a3c2308' },
  {
    key: 'audit-0:4084550820,-3,0,-4',
    seed: 4084550820,
    cx: -3,
    cy: 0,
    cz: -4,
    digest: '4c42b328',
  },
  {
    key: 'audit-15:3752583958,-2,0,-1',
    seed: 3752583958,
    cx: -2,
    cy: 0,
    cz: -1,
    digest: '7bb7f285',
  },
  {
    key: 'audit-31:3566893867,0,0,-2',
    seed: 3566893867,
    cx: 0,
    cy: 0,
    cz: -2,
    digest: '8c930520',
  },
])

const SEWER_GOLDEN_DIGEST = 'bb0f6332cc6eb5b0911a0aeb8f4e1ab61fd8e718b4d121b6e476ad26f525661c'

const TOWER_GOLDEN = Object.freeze([
  { key: '23063,-4,-22,-3', seed: 23063, cx: -4, cy: -22, cz: -3, digest: '6e7b9b90' },
  { key: '23063,-4,-22,-2', seed: 23063, cx: -4, cy: -22, cz: -2, digest: 'b6e09969' },
  { key: '23063,-4,-21,-3', seed: 23063, cx: -4, cy: -21, cz: -3, digest: '452dcd98' },
  { key: '23063,-4,-21,-2', seed: 23063, cx: -4, cy: -21, cz: -2, digest: '0ec94415' },
  { key: '23063,-4,-20,-3', seed: 23063, cx: -4, cy: -20, cz: -3, digest: 'e5c8da95' },
  { key: '23063,-4,-20,-2', seed: 23063, cx: -4, cy: -20, cz: -2, digest: '83c291fa' },
])

const TOWER_GOLDEN_DIGEST = 'bd096ad47110a693e5e77089b181ba2b8b270162335122a8cc448555faa85ecf'

const LATTICE_GOLDEN = Object.freeze([
  { key: '27750862,3,-24,-6', seed: 27750862, cx: 3, cy: -24, cz: -6, digest: '0b6bfdaa' },
  { key: '27750862,4,-24,-6', seed: 27750862, cx: 4, cy: -24, cz: -6, digest: '5d9b4171' },
  { key: '27750862,5,-24,-6', seed: 27750862, cx: 5, cy: -24, cz: -6, digest: '442c85d4' },
  { key: '27750862,3,-24,-5', seed: 27750862, cx: 3, cy: -24, cz: -5, digest: '0277687e' },
  { key: '27750862,4,-24,-5', seed: 27750862, cx: 4, cy: -24, cz: -5, digest: 'cc7846ad' },
  { key: '27750862,5,-24,-5', seed: 27750862, cx: 5, cy: -24, cz: -5, digest: 'c916984c' },
  { key: '27750862,3,-24,-4', seed: 27750862, cx: 3, cy: -24, cz: -4, digest: 'e705a78b' },
  { key: '27750862,4,-24,-4', seed: 27750862, cx: 4, cy: -24, cz: -4, digest: 'd5d5697c' },
  { key: '27750862,5,-24,-4', seed: 27750862, cx: 5, cy: -24, cz: -4, digest: 'f8d4b7eb' },
  { key: '27750862,3,-23,-6', seed: 27750862, cx: 3, cy: -23, cz: -6, digest: '30d785b4' },
  { key: '27750862,4,-23,-6', seed: 27750862, cx: 4, cy: -23, cz: -6, digest: '8ced6464' },
  { key: '27750862,5,-23,-6', seed: 27750862, cx: 5, cy: -23, cz: -6, digest: '7ff0e658' },
  { key: '27750862,3,-23,-5', seed: 27750862, cx: 3, cy: -23, cz: -5, digest: '79e4d0ff' },
  { key: '27750862,4,-23,-5', seed: 27750862, cx: 4, cy: -23, cz: -5, digest: '48fb6f37' },
  { key: '27750862,5,-23,-5', seed: 27750862, cx: 5, cy: -23, cz: -5, digest: '37aac510' },
  { key: '27750862,3,-23,-4', seed: 27750862, cx: 3, cy: -23, cz: -4, digest: 'ebd4c644' },
  { key: '27750862,4,-23,-4', seed: 27750862, cx: 4, cy: -23, cz: -4, digest: 'ecac03f8' },
  { key: '27750862,5,-23,-4', seed: 27750862, cx: 5, cy: -23, cz: -4, digest: 'dd445e11' },
  { key: '27750862,3,-22,-6', seed: 27750862, cx: 3, cy: -22, cz: -6, digest: '5ce8689f' },
  { key: '27750862,4,-22,-6', seed: 27750862, cx: 4, cy: -22, cz: -6, digest: '8fb831a8' },
  { key: '27750862,5,-22,-6', seed: 27750862, cx: 5, cy: -22, cz: -6, digest: '4efd3def' },
  { key: '27750862,3,-22,-5', seed: 27750862, cx: 3, cy: -22, cz: -5, digest: '084214e1' },
  { key: '27750862,4,-22,-5', seed: 27750862, cx: 4, cy: -22, cz: -5, digest: 'ab90066a' },
  { key: '27750862,5,-22,-5', seed: 27750862, cx: 5, cy: -22, cz: -5, digest: '582f923f' },
  { key: '27750862,3,-22,-4', seed: 27750862, cx: 3, cy: -22, cz: -4, digest: '6eb19191' },
  { key: '27750862,4,-22,-4', seed: 27750862, cx: 4, cy: -22, cz: -4, digest: '03b582c3' },
  { key: '27750862,5,-22,-4', seed: 27750862, cx: 5, cy: -22, cz: -4, digest: '9eec5112' },
])

const LATTICE_GOLDEN_DIGEST = '8503421792e832bd3c1febe319e307e17f6c50cd628959a5741ea8fb92113a4e'

const OFFICE_PAIR_DESCRIPTOR_GOLDEN = {
  id: 1394823709,
  kind: 'bridged',
  district: { x: -1, z: -1, size: 4 },
  bandIndex: -1,
  baseCy: -15,
  bottomCy: -15,
  topCy: -1,
  levelCount: 15,
  height: 15,
  bridgeAxis: 'x',
  longSpan: 22,
  shortSpan: 6,
  anchor: { cx: -3, cz: -1 },
  participants: [
    { cx: -3, cz: -1 },
    { cx: -2, cz: -1 },
  ],
  participantChunks: [
    { cx: -3, cz: -1 },
    { cx: -2, cz: -1 },
  ],
  bounds: { x0: -40, z0: -7, x1: -19, z1: -2 },
  globalBounds: { x0: -40, z0: -7, x1: -19, z1: -2 },
  centerLines: [-5, -4],
  bridgeLevels: [-14, -12, -10, -8, -6, -4, -2],
  decks: [
    [-14, -15, -5],
    [-12, -13, -4],
    [-10, -11, -5],
    [-8, -9, -4],
    [-6, -7, -5],
    [-4, -5, -4],
    [-2, -3, -5],
  ],
}

const SEEDS = [1, 42, 0xbeef, 1234567, 0x5a5a5a]
const COORDS = [
  [0, 0, 0],
  [1, 0, 0],
  [3, 0, -2],
  [-4, 1, 5],
  [12, -1, 12],
  [-7, 2, -9],
]

function districtStructure(seed, districtX, districtZ, levelCy = 0) {
  const K = multilevelConfig(CFG).districtChunks
  const baseCy = multilevelBandBase(
    seed,
    districtX * K,
    districtZ * K,
    levelCy,
    CFG
  )
  for (let dz = 0; dz < K; dz++) {
    for (let dx = 0; dx < K; dx++) {
      const structure = multilevelContract(
        seed,
        districtX * K + dx,
        districtZ * K + dz,
        baseCy,
        CFG
      )
      if (structure.hasRoom) return structure
    }
  }
  throw new Error('expected deterministic multilevel structure')
}

function rasterSnapshot(data) {
  return Object.fromEntries(
    RASTER_FIELDS.map((field) => [field, Array.from(data[field])])
  )
}

const sha256 = (value) => createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex')

function releaseSewerConfig() {
  return worldConfigForFamily(MAP_FAMILY_SEWER)
}

function forcedTowerFixture(seed = 0x5a17) {
  const base = structuredClone(CFG)
  base.mapFamily.profiles[MAP_FAMILY_TOWER].enabled = true
  const config = worldConfigForFamily(MAP_FAMILY_TOWER, base)
  let structure = null
  for (let cy = -24; cy <= 24 && !structure; cy++) {
    for (let cz = -4; cz <= 4 && !structure; cz++) {
      for (let cx = -4; cx <= 4; cx++) {
        const candidate = structureAt(seed, cx, cz, cy, config)
        if (
          candidate?.hasRoom === true &&
          candidate.family === MAP_FAMILY_TOWER &&
          candidate.kind === 'towerSkybridge'
        ) {
          structure = candidate
          break
        }
      }
    }
  }
  if (!structure) throw new Error('expected deterministic forced Tower fixture')

  const chunks = new Map()
  for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
    for (const participant of structure.participants) {
      chunks.set(
        `${participant.cx},${cy},${participant.cz}`,
        buildChunk(seed, participant.cx, cy, participant.cz, config)
      )
    }
  }
  return { seed, config, structure, chunks }
}

function forcedLatticeFixture(seed = 0x1a771ce) {
  const base = structuredClone(CFG)
  base.mapFamily.profiles[MAP_FAMILY_LATTICE].enabled = true
  const config = worldConfigForFamily(MAP_FAMILY_LATTICE, base)
  let structure = null
  for (let cy = -24; cy <= 24 && !structure; cy++) {
    for (let cz = -4; cz <= 4 && !structure; cz++) {
      for (let cx = -4; cx <= 4; cx++) {
        const candidate = structureAt(seed, cx, cz, cy, config)
        if (
          candidate?.hasRoom === true &&
          candidate.family === MAP_FAMILY_LATTICE &&
          candidate.kind === 'latticeDistrict'
        ) {
          structure = candidate
          break
        }
      }
    }
  }
  if (!structure) throw new Error('expected deterministic forced Lattice fixture')

  const chunks = new Map()
  for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
    for (const participant of structure.participants) {
      chunks.set(
        `${participant.cx},${cy},${participant.cz}`,
        buildChunk(seed, participant.cx, cy, participant.cz, config)
      )
    }
  }
  return { seed, config, structure, chunks }
}

function generatedCell(chunks, gx, gz, cy) {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  const data = chunks.get(`${cx},${cy},${cz}`)
  const lx = gx - cx * CHUNK
  const lz = gz - cz * CHUNK
  return { data, lx, lz }
}

function generatedVEdge(chunks, lineGX, gz, cy) {
  const cx = Math.floor(lineGX / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  const data = chunks.get(`${cx},${cy},${cz}`)
  if (!data) return null
  const line = lineGX - cx * CHUNK
  const cell = gz - cz * CHUNK
  return {
    wall: data.vAt(line, cell),
    passage: data.passageVAt(line, cell),
    feature: data.wallFeatureVAt(line, cell),
  }
}

function generatedHEdge(chunks, gx, lineGZ, cy) {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(lineGZ / CHUNK)
  const data = chunks.get(`${cx},${cy},${cz}`)
  if (!data) return null
  const cell = gx - cx * CHUNK
  const line = lineGZ - cz * CHUNK
  return {
    wall: data.hAt(cell, line),
    passage: data.passageHAt(cell, line),
    feature: data.wallFeatureHAt(cell, line),
  }
}

const latticeEdgeKey = ({ a, b }) => `${Math.min(a, b)}:${Math.max(a, b)}`

function latticeChamberCueEvidence(chunks, structure, anchor) {
  const railCells = new Set()
  const sideStates = [[], [], [], []]
  for (let offset = -1; offset <= 1; offset++) {
    const north = generatedHEdge(
      chunks,
      anchor.gx + offset,
      anchor.gz - 1,
      anchor.levelCy
    )
    const south = generatedHEdge(
      chunks,
      anchor.gx + offset,
      anchor.gz + 2,
      anchor.levelCy
    )
    const west = generatedVEdge(
      chunks,
      anchor.gx - 1,
      anchor.gz + offset,
      anchor.levelCy
    )
    const east = generatedVEdge(
      chunks,
      anchor.gx + 2,
      anchor.gz + offset,
      anchor.levelCy
    )
    for (const [side, state, key] of [
      [0, north, `${anchor.gx + offset},${anchor.gz - 2}`],
      [1, east, `${anchor.gx + 2},${anchor.gz + offset}`],
      [2, south, `${anchor.gx + offset},${anchor.gz + 2}`],
      [3, west, `${anchor.gx - 2},${anchor.gz + offset}`],
    ]) {
      sideStates[side].push(state)
      if (
        state?.wall === 1 &&
        state.passage === PASSAGE_WALL &&
        state.feature === WALL_RAIL
      ) railCells.add(key)
    }
  }

  const bridgeSeamCells = new Set()
  for (const edge of structure.edges) {
    if (edge.a !== anchor.id && edge.b !== anchor.id) continue
    for (const cell of edge.cells) {
      if (
        cell.cy === anchor.levelCy &&
        Math.abs(cell.gx - anchor.gx) <= 2 &&
        Math.abs(cell.gz - anchor.gz) <= 2
      ) bridgeSeamCells.add(`${cell.gx},${cell.gz}`)
    }
  }
  const combined = new Set([...railCells, ...bridgeSeamCells])
  const plainWallSides = sideStates.filter((states) =>
    states.every((state) =>
      state?.wall === 1 &&
      state.passage === PASSAGE_WALL &&
      state.feature === WALL_PLAIN
    )
  ).length
  return { railCells, bridgeSeamCells, combined, plainWallSides }
}

function recursivelyFrozen(value) {
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)) return false
  return Object.values(value).every((child) =>
    !child || typeof child !== 'object' || recursivelyFrozen(child)
  )
}

function sewerSnapshot(data) {
  return {
    raster: rasterSnapshot(data),
    descriptor: data.sewerDescriptor,
    lamps: data.lamps,
    repairs: data.repairs,
    stairUp: data.stairUp,
    stairDown: data.stairDown,
    digest: digest(data),
  }
}

function officePairDescriptorPin(structure) {
  return {
    id: structure.id,
    kind: structure.kind,
    district: structure.district,
    bandIndex: structure.bandIndex,
    baseCy: structure.baseCy,
    bottomCy: structure.bottomCy,
    topCy: structure.topCy,
    levelCount: structure.levelCount,
    height: structure.height,
    bridgeAxis: structure.bridgeAxis,
    longSpan: structure.longSpan,
    shortSpan: structure.shortSpan,
    anchor: structure.anchor,
    participants: structure.participants,
    participantChunks: structure.participantChunks,
    bounds: structure.bounds,
    globalBounds: structure.globalBounds,
    centerLines: structure.centerLines,
    bridgeLevels: structure.bridgeLevels,
    decks: structure.decks.map((deck) => [
      deck.levelCy,
      deck.lowerCy,
      deck.globalBridgeLine,
    ]),
  }
}

describe('determinism', () => {
  it('regenerates byte-identical chunks', () => {
    for (const s of SEEDS) {
      for (const [cx, cy, cz] of COORDS) {
        const a = buildChunk(s, cx, cy, cz, CFG)
        const b = buildChunk(s, cx, cy, cz, CFG)
        expect(a.version).toBe(WORLD_GEN_VERSION)
        expect(a.zone).toBe(b.zone)
        expect(Array.from(a.wallV)).toEqual(Array.from(b.wallV))
        expect(Array.from(a.wallH)).toEqual(Array.from(b.wallH))
        expect(Array.from(a.passageV)).toEqual(Array.from(b.passageV))
        expect(Array.from(a.passageH)).toEqual(Array.from(b.passageH))
        expect(Array.from(a.wallFeatureV)).toEqual(Array.from(b.wallFeatureV))
        expect(Array.from(a.wallFeatureH)).toEqual(Array.from(b.wallFeatureH))
        expect(Array.from(a.cols)).toEqual(Array.from(b.cols))
        expect(Array.from(a.cellKind)).toEqual(Array.from(b.cellKind))
        expect(Array.from(a.spaceId)).toEqual(Array.from(b.spaceId))
        expect(a.lamps).toEqual(b.lamps)
        expect(a.repairs).toEqual(b.repairs)
        expect(a.stairUp).toEqual(b.stairUp)
        expect(a.stairDown).toEqual(b.stairDown)
        expect(a.structure).toEqual(b.structure)
        expect(a.structureUp).toEqual(b.structureUp)
        expect(a.structureDown).toEqual(b.structureDown)
      }
    }
  })

  it('matches pinned golden digests', () => {
    const actual = {}
    const maximumHeightPins = {}
    for (const key of Object.keys(GOLDEN)) {
      const [cx, cy, cz] = key.split(',').map(Number)
      actual[key] = digest(buildChunk(12345, cx, cy, cz, CFG))
    }
    expect(actual).toEqual(GOLDEN)

    for (const [kind, keys] of Object.entries(MAX_HEIGHT_GOLDEN)) {
      for (const key of keys) {
        maximumHeightPins[key] = actual[key]
        const [cx, cy, cz] = key.split(',').map(Number)
        const structure = buildChunk(12345, cx, cy, cz, CFG).structure
        expect(structure?.kind).toBe(kind)
        expect(structure?.levelCount).toBe(15)
        expect(structure?.topCy - structure?.baseCy).toBe(14)
        expect(cy).toBeGreaterThanOrEqual(structure.baseCy)
        expect(cy).toBeLessThanOrEqual(structure.topCy)
      }
    }

    expect(sha256(actual)).toBe(LATTICE_RELEASE_EVIDENCE.globalGoldenDigest)
    expect(sha256(maximumHeightPins))
      .toBe(LATTICE_RELEASE_EVIDENCE.maximumHeightGoldenDigest)
    for (const release of [SEWER_RELEASE_EVIDENCE, TOWER_RELEASE_EVIDENCE]) {
      expect(release.globalGoldenDigest)
        .toBe(LATTICE_RELEASE_EVIDENCE.globalGoldenDigest)
      expect(release.maximumHeightGoldenDigest)
        .toBe(LATTICE_RELEASE_EVIDENCE.maximumHeightGoldenDigest)
    }
  })

  it('keeps the public generation path byte-identical to the headless office pipeline', () => {
    const direct = buildChunk(12345, 0, 0, 0, CFG)
    const publicResult = generateChunk(12345, 0, 0, 0, CFG)

    expect(direct.zone).toBe(ZONE_OFFICE)
    expect(rasterSnapshot(publicResult)).toEqual(rasterSnapshot(direct))
    expect(publicResult.lamps).toEqual(direct.lamps)
    expect(publicResult.furniture).toEqual(direct.furniture)
    expect(publicResult.structure).toEqual(direct.structure)
    expect(digest(publicResult)).toBe(GOLDEN['0,0,0'])
    expect(digest(direct)).toBe(GOLDEN['0,0,0'])
  })

  it('keeps office output stable after surrounding chunks are generated in either order', () => {
    const target = [-3, -15, -1]
    const surroundings = [
      [-4, -15, -1],
      [-2, -15, -1],
      [-3, -15, -2],
      [-3, -15, 0],
      [-3, -14, -1],
    ]
    const expected = buildChunk(12345, ...target, CFG)

    for (const order of [surroundings, [...surroundings].reverse()]) {
      for (const coords of order) buildChunk(12345, ...coords, CFG)
      const actual = buildChunk(12345, ...target, CFG)
      expect(rasterSnapshot(actual)).toEqual(rasterSnapshot(expected))
      expect(actual.structure).toEqual(expected.structure)
      expect(actual.structureUp).toEqual(expected.structureUp)
      expect(actual.structureDown).toEqual(expected.structureDown)
      expect(digest(actual)).toBe(GOLDEN[target.join(',')])
    }
  })

  it('pins the established office multilevel descriptor as one exact pair', () => {
    const first = buildChunk(12345, -3, -15, -1, CFG)
    const second = buildChunk(12345, -2, -15, -1, CFG)
    const structure = first.structure

    expect(structure).not.toBeNull()
    expect(structure).toEqual(second.structure)
    expect(structure.participants).toHaveLength(2)
    expect(structure.participantChunks).toEqual(structure.participants)
    expect(structure).not.toHaveProperty('family')
    expect(officePairDescriptorPin(structure)).toEqual(OFFICE_PAIR_DESCRIPTOR_GOLDEN)
    expect(digest(first)).toBe(GOLDEN['-3,-15,-1'])
    expect(digest(second)).toBe(GOLDEN['-2,-15,-1'])
  })

  it('labels default output as office at the family-aware dispatch seam', () => {
    const direct = buildChunk(12345, 0, 0, 0, CFG)
    const publicResult = generateChunk(12345, 0, 0, 0, CFG)

    expect([direct.mapFamily, publicResult.mapFamily]).toEqual(['office', 'office'])
    expect(Object.hasOwn(direct, 'sewerDescriptor')).toBe(true)
    expect(Object.hasOwn(publicResult, 'sewerDescriptor')).toBe(true)
    expect([direct.sewerDescriptor, publicResult.sewerDescriptor]).toEqual([null, null])
  })

  it('folds family identity and behaviorally relevant descriptors without changing office pins', () => {
    const office = buildChunk(12345, -3, -15, -1, CFG)
    const familyVariant = { ...office, mapFamily: 'tower' }
    const descriptorVariant = {
      ...office,
      structure: {
        ...office.structure,
        id: (office.structure.id + 1) >>> 0,
      },
    }

    expect(digest(office)).toBe(GOLDEN['-3,-15,-1'])
    expect(rasterSnapshot(familyVariant)).toEqual(rasterSnapshot(office))
    expect(digest(familyVariant)).not.toBe(digest(office))
    expect(digest(descriptorVariant)).not.toBe(digest(office))
  })

  it('rejects an invalid selected profile before constructing downstream chunk data', () => {
    const invalid = structuredClone(CFG)
    invalid.mapFamily.selected = 'lattice'
    delete invalid.mapFamily.profiles.lattice.minimumCueCells
    let versionRead = false
    Object.defineProperty(invalid, 'version', {
      configurable: true,
      get() {
        versionRead = true
        return WORLD_GEN_VERSION
      },
    })

    expect(() => buildChunk(12345, 0, 0, 0, invalid)).toThrowError(
      expect.objectContaining({ name: 'MapFamilyConfigError', reason: 'incomplete' })
    )
    expect(versionRead).toBe(false)
  })

  it('layer 0 uses the root seed; other layers get decorrelated seeds', () => {
    expect(layerSeed(12345, 0)).toBe(12345)
    expect(layerSeed(12345, 1)).not.toBe(12345)
    expect(layerSeed(12345, -1)).not.toBe(layerSeed(12345, 1))
    // Layers must differ (zones/walls decorrelate across floors).
    let differing = 0
    for (const [cx, , cz] of COORDS) {
      const a = buildChunk(42, cx, 0, cz, CFG)
      const b = buildChunk(42, cx, 1, cz, CFG)
      if (digest(a) !== digest(b)) differing++
    }
    expect(differing).toBe(COORDS.length)
  })

  it('keeps ordinary chunk generation available above the cy-64 landmark cap', () => {
    const data = buildChunk(12345, 0, 65, 0, CFG)
    expect(data.version).toBe(WORLD_GEN_VERSION)
    expect(data.cy).toBe(65)
    expect(data.structure).toBeNull()
    expect(data.wallV.length).toBeGreaterThan(0)
  })
})

describe('release sewer pipeline', () => {
  it('[R05-S02][R06-S01..S03][R24-S01][D11] pins the enabled Sewer byte stream independently', () => {
    const config = releaseSewerConfig()
    const actual = Object.fromEntries(SEWER_GOLDEN.map((fixture) => [
      fixture.key,
      digest(buildChunk(fixture.seed, fixture.cx, fixture.cy, fixture.cz, config)),
    ]))
    const expected = Object.fromEntries(
      SEWER_GOLDEN.map(({ key, digest: pinned }) => [key, pinned])
    )

    expect(CFG.mapFamily.selected).toBe('office')
    expect(CFG.mapFamily.profiles[MAP_FAMILY_SEWER].enabled).toBe(true)
    expect(CFG.mapFamily.profiles.tower.enabled).toBe(true)
    expect(CFG.mapFamily.profiles.lattice.enabled).toBe(true)
    expect(actual).toEqual(expected)
    expect(sha256(actual)).toBe(SEWER_GOLDEN_DIGEST)
    expect(SEWER_GOLDEN_DIGEST).toBe(SEWER_RELEASE_EVIDENCE.familyRepresentativeDigest)
  })

  it('[R03-S01..S04][R21-S01][R22-S01][D02][D03][D05] carries one frozen canonical descriptor through both headless entry points', () => {
    const config = releaseSewerConfig()
    const direct = buildChunk(0x5e57, 2, 0, -3, config)
    const publicResult = generateChunk(0x5e57, 2, 0, -3, config)

    expect(CFG.mapFamily.profiles[MAP_FAMILY_SEWER].enabled).toBe(true)
    expect(direct.mapFamily).toBe(MAP_FAMILY_SEWER)
    expect(direct.zone).toBe(ZONE_SEWER)
    expect(direct.sewerDescriptor).not.toBeNull()
    expect(recursivelyFrozen(direct.sewerDescriptor)).toBe(true)
    expect(direct).not.toHaveProperty('descriptor')
    expect(direct).not.toHaveProperty('sewer')
    expect(sewerSnapshot(publicResult)).toEqual(sewerSnapshot(direct))
    expect(direct.repairs).toEqual({ connectivity: 0, navigation: 0, columns: 0 })
    expect(countChunkComponents(direct, true)).toBe(1)
  })

  it('[R03-S02][D02] folds every canonical SewerDescriptor field without changing office pins', () => {
    const office = buildChunk(12345, -3, -15, -1, CFG)
    const sewer = buildChunk(0x5e57, 2, 0, -3, releaseSewerConfig())
    const baseline = digest(sewer)
    const mutations = [
      ['family', (descriptor) => { descriptor.family = 'office' }],
      ['id', (descriptor) => { descriptor.id = (descriptor.id + 1) >>> 0 }],
      ['bounds', (descriptor) => { descriptor.bounds.x0++ }],
      ['trunk root', (descriptor) => { descriptor.trunkRoot.lx++ }],
      ['module kind', (descriptor) => {
        const index = SEWER_MODULE_KINDS.indexOf(descriptor.modules[0].kind)
        descriptor.modules[0].kind = SEWER_MODULE_KINDS[(index + 1) % SEWER_MODULE_KINDS.length]
      }],
      ['module x', (descriptor) => { descriptor.modules[0].lx++ }],
      ['module z', (descriptor) => { descriptor.modules[0].lz++ }],
      ['module direction', (descriptor) => {
        const index = SEWER_DIRECTIONS.indexOf(descriptor.modules[0].dir)
        descriptor.modules[0].dir = SEWER_DIRECTIONS[(index + 1) % SEWER_DIRECTIONS.length]
      }],
      ['tree edge', (descriptor) => { descriptor.treeEdges[0].b++ }],
      ['loop edge', (descriptor) => { descriptor.loopEdges[0].b++ }],
      ['eligible links', (descriptor) => { descriptor.eligibleNonTreeLinks++ }],
    ]

    expect(digest(office)).toBe(GOLDEN['-3,-15,-1'])
    for (const [label, mutate] of mutations) {
      const descriptor = structuredClone(sewer.sewerDescriptor)
      mutate(descriptor)
      expect(
        digest({ ...sewer, sewerDescriptor: descriptor }),
        `${label} must be digest-covered`
      ).not.toBe(baseline)
    }
  })

  it('[R03-S03][D03] remains independent of surrounding forced-generation order', () => {
    const target = [2, 0, -3]
    const surroundings = [
      [1, 0, -3],
      [3, 0, -3],
      [2, 0, -4],
      [2, 0, -2],
      [2, 1, -3],
    ]
    const expected = sewerSnapshot(buildChunk(0x5e57, ...target, releaseSewerConfig()))

    for (const order of [surroundings, [...surroundings].reverse()]) {
      const config = releaseSewerConfig()
      for (const coords of order) buildChunk(0x5e57, ...coords, config)
      expect(sewerSnapshot(buildChunk(0x5e57, ...target, config))).toEqual(expected)
    }
  })

  it('[R22-S01..S04][D03] retries a disconnected candidate from a separate bounded salt instead of repairing it', () => {
    const sewerZone = ZONES[ZONE_SEWER]
    const attempts = []
    ZONES[ZONE_SEWER] = {
      ...sewerZone,
      generate(data, context) {
        attempts.push(context.layerSeed)
        sewerZone.generate(data, context)
        if (attempts.length !== 1) return

        const isolated = data.sewerDescriptor.modules.find((module) =>
          module.lx > 0 && module.lx < CHUNK - 1 && module.lz > 0 && module.lz < CHUNK - 1
        )
        data.setV(isolated.lx, isolated.lz, 1)
        data.setV(isolated.lx + 1, isolated.lz, 1)
        data.setH(isolated.lx, isolated.lz, 1)
        data.setH(isolated.lx, isolated.lz + 1, 1)
      },
    }

    try {
      const data = buildChunk(0x5e57, 2, 0, -3, releaseSewerConfig())
      expect(attempts).toHaveLength(2)
      expect(attempts[1]).not.toBe(attempts[0])
      expect(countChunkComponents(data, true)).toBe(1)
      expect(data.repairs).toEqual({ connectivity: 0, navigation: 0, columns: 0 })
    } finally {
      ZONES[ZONE_SEWER] = sewerZone
    }
  })

  it('[R23-S01][D03][D05] stamps deterministic manhole modules through the existing stair descriptor primitive', () => {
    const data = buildChunk(0x5e57, 2, 0, -3, releaseSewerConfig())
    const above = buildChunk(0x5e57, 2, 1, -3, releaseSewerConfig())
    const below = buildChunk(0x5e57, 2, -1, -3, releaseSewerConfig())
    const cases = [
      ['manholeUp', data.stairUp, 'hasCeilHole'],
      ['manholeDown', data.stairDown, 'hasFloorHole'],
    ]

    expect(data.stairUp).toEqual(above.stairDown)
    expect(data.stairDown).toEqual(below.stairUp)

    for (const [kind, stair, holeAt] of cases) {
      const module = data.sewerDescriptor.modules.find((candidate) => candidate.kind === kind)
      expect(module).toBeDefined()
      expect(stair).not.toBeNull()
      expect(stair.dir).toBeGreaterThanOrEqual(0)
      expect(stair.dir).toBeLessThan(SEWER_DIRECTIONS.length)
      expect(stair.run).toHaveLength(2)
      for (const cell of [stair.landing, ...stair.run, stair.exit]) {
        expect(cell.lx).toBeGreaterThanOrEqual(0)
        expect(cell.lx).toBeLessThan(CHUNK)
        expect(cell.lz).toBeGreaterThanOrEqual(0)
        expect(cell.lz).toBeLessThan(CHUNK)
      }
      for (const cell of stair.run) {
        expect(data[holeAt](cell.lx, cell.lz)).toBe(true)
        expect(data.cellKind[cell.lz * CHUNK + cell.lx]).toBe(CELL_STAIR)
      }
    }

    expect(sewerSnapshot(buildChunk(0x5e57, 2, 0, -3, releaseSewerConfig())))
      .toEqual(sewerSnapshot(data))
  })
})

describe('release Tower pipeline', () => {
  it('[R05-S02][R06-S01..S03][R27-S01][D11] pins the enabled Tower byte stream independently', () => {
    const config = worldConfigForFamily(MAP_FAMILY_TOWER)
    const actual = Object.fromEntries(TOWER_GOLDEN.map((fixture) => [
      fixture.key,
      digest(buildChunk(fixture.seed, fixture.cx, fixture.cy, fixture.cz, config)),
    ]))
    const expected = Object.fromEntries(
      TOWER_GOLDEN.map(({ key, digest: pinned }) => [key, pinned])
    )

    expect(CFG.mapFamily.selected).toBe('office')
    expect(CFG.mapFamily.profiles[MAP_FAMILY_SEWER].enabled).toBe(true)
    expect(CFG.mapFamily.profiles[MAP_FAMILY_TOWER].enabled).toBe(true)
    expect(CFG.mapFamily.profiles.lattice.enabled).toBe(true)
    expect(actual).toEqual(expected)
    expect(sha256(actual)).toBe(TOWER_GOLDEN_DIGEST)
    expect(TOWER_GOLDEN_DIGEST).toBe(TOWER_RELEASE_EVIDENCE.familyRepresentativeDigest)
  })
})

describe('release Lattice pipeline', () => {
  it('[R05-S02][R06-S01..S03][R20-S02][R31-S01][D11] pins the enabled all-floor Lattice byte stream independently', () => {
    const config = worldConfigForFamily(MAP_FAMILY_LATTICE)
    const actual = Object.fromEntries(LATTICE_GOLDEN.map((fixture) => [
      fixture.key,
      digest(buildChunk(fixture.seed, fixture.cx, fixture.cy, fixture.cz, config)),
    ]))
    const expected = Object.fromEntries(
      LATTICE_GOLDEN.map(({ key, digest: pinned }) => [key, pinned])
    )

    expect(CFG.mapFamily.selected).toBe('office')
    expect(Object.fromEntries(Object.entries(CFG.mapFamily.profiles)
      .map(([family, profile]) => [family, profile.enabled]))).toEqual({
      office: true,
      sewer: true,
      tower: true,
      lattice: true,
    })
    expect(WORLD_GEN_VERSION).toBe(LATTICE_RELEASE_EVIDENCE.generatorVersion)
    expect(actual).toEqual(expected)
    expect(sha256(actual)).toBe(LATTICE_GOLDEN_DIGEST)
    expect(LATTICE_GOLDEN_DIGEST)
      .toBe(LATTICE_RELEASE_EVIDENCE.familyRepresentativeDigest)
  })
})

describe('forced Tower stamping (task 4.5 GREEN)', () => {
  it('[R03-S01..S04][R18-S01][R25-S01..S04][D02/D03/D05/D08] stamps only the canonical Tower carriers with matched stairs and lethal halves', () => {
    const { structure, chunks } = forcedTowerFixture()
    const expectedDeathYmm = Math.round(structure.baseCy * LAYER_H * 1000)

    expect(CFG.mapFamily.profiles[MAP_FAMILY_TOWER].enabled).toBe(true)
    expect(CFG.mapFamily.profiles[MAP_FAMILY_SEWER].enabled).toBe(true)
    expect(WORLD_GEN_VERSION).toBe(TOWER_RELEASE_EVIDENCE.generatorVersion)
    expect(chunks.size).toBe(6)
    expect(new Set(structure.landmarkSockets.map(({ kind }) => kind))).toEqual(
      new Set(['signage', 'clock', 'litAccent', 'door', 'fixture'])
    )

    for (const data of chunks.values()) {
      expect(data.mapFamily).toBe(MAP_FAMILY_TOWER)
      expect(data.structure).toEqual(structure)
      expect(recursivelyFrozen(data.structure)).toBe(true)
      expect(data).not.toHaveProperty('towerStructure')
      expect(data).not.toHaveProperty('approaches')
      expect(data).not.toHaveProperty('stamping')
      expect(data).not.toHaveProperty('skybridgeDeck')
    }

    for (let lowerCy = structure.baseCy; lowerCy < structure.topCy; lowerCy++) {
      for (const participant of structure.participants) {
        const lower = chunks.get(`${participant.cx},${lowerCy},${participant.cz}`)
        const upper = chunks.get(`${participant.cx},${lowerCy + 1},${participant.cz}`)
        expect(lower.structureUp).toEqual(upper.structureDown)
        expect(lower.lethalVoidUp).toEqual(upper.lethalVoidDown)
        expect(recursivelyFrozen(lower.lethalVoidUp)).toBe(true)
        expect(lower.lethalVoidUp).toMatchObject({
          id: structure.id,
          family: MAP_FAMILY_TOWER,
          lowerCy,
        })
        expect(lower.lethalVoidUp.cells.length).toBeGreaterThan(0)
        expect(lower.lethalVoidUp.cells).toEqual(
          [...lower.lethalVoidUp.cells].sort((a, b) => a.lz - b.lz || a.lx - b.lx)
        )
        for (const cell of lower.lethalVoidUp.cells) {
          expect(cell.deathYmm).toBe(expectedDeathYmm)
          expect(lower.hasCeilHole(cell.lx, cell.lz)).toBe(true)
          expect(upper.hasFloorHole(cell.lx, cell.lz)).toBe(true)
        }
      }
    }

    for (const link of structure.verticalLinks) {
      const lower = chunks.get(`${link.cx},${link.lowerCy},${link.cz}`)
      const upper = chunks.get(`${link.cx},${link.lowerCy + 1},${link.cz}`)
      expect(lower.stairUp).toEqual(link.stair)
      expect(upper.stairDown).toEqual(link.stair)
    }
  })

  it('[R03-S02][D02/D05/D08] digest-covers every behavior-bearing Tower descriptor family while preserving Office pins', () => {
    const { structure, chunks } = forcedTowerFixture()
    const data = chunks.get(
      `${structure.participants[0].cx},${structure.baseCy + 1},${structure.participants[0].cz}`
    )
    const baseline = digest(data)
    const mutations = [
      ['structure family', (value) => { value.structure.family = 'office' }],
      ['structure id', (value) => { value.structure.id++ }],
      ['structure kind', (value) => { value.structure.kind = 'unknown' }],
      ['district', (value) => { value.structure.district.x++ }],
      ['base floor', (value) => { value.structure.baseCy++ }],
      ['top floor', (value) => { value.structure.topCy++ }],
      ['level count', (value) => { value.structure.levelCount++ }],
      ['bridge axis', (value) => {
        value.structure.bridgeAxis = value.structure.bridgeAxis === 'x' ? 'z' : 'x'
      }],
      ['anchor', (value) => { value.structure.anchor.cx++ }],
      ['participant', (value) => { value.structure.participants[0].cz++ }],
      ['structure bounds', (value) => { value.structure.globalBounds.x0++ }],
      ['deck floor', (value) => { value.structure.decks[0].levelCy++ }],
      ['deck lower floor', (value) => { value.structure.decks[0].lowerCy++ }],
      ['deck line', (value) => { value.structure.decks[0].globalBridgeLine++ }],
      ['deck bounds', (value) => { value.structure.decks[0].globalBounds.z0++ }],
      ['deck cells', (value) => { value.structure.decks[0].globalCells[0].gx++ }],
      ['link floor', (value) => { value.structure.verticalLinks[0].lowerCy++ }],
      ['link participant x', (value) => { value.structure.verticalLinks[0].cx++ }],
      ['link participant z', (value) => { value.structure.verticalLinks[0].cz++ }],
      ['link direction', (value) => { value.structure.verticalLinks[0].stair.dir++ }],
      ['link landing', (value) => { value.structure.verticalLinks[0].stair.landing.lx++ }],
      ['link run', (value) => { value.structure.verticalLinks[0].stair.run[0].lz++ }],
      ['link exit', (value) => { value.structure.verticalLinks[0].stair.exit.lx++ }],
      ['socket slot', (value) => { value.structure.landmarkSockets[0].slot = 'bridgeApproach' }],
      ['socket kind', (value) => { value.structure.landmarkSockets[0].kind = 'clock' }],
      ['socket x', (value) => { value.structure.landmarkSockets[0].gx++ }],
      ['socket z', (value) => { value.structure.landmarkSockets[0].gz++ }],
      ['socket floor', (value) => { value.structure.landmarkSockets[0].cy++ }],
      ['socket axis', (value) => {
        const socket = value.structure.landmarkSockets[0]
        socket.axis = socket.axis === 'x' ? 'z' : 'x'
      }],
      ['socket side', (value) => { value.structure.landmarkSockets[0].side *= -1 }],
      ['socket salt', (value) => { value.structure.landmarkSockets[0].salt++ }],
      ['slice id', (value) => { value.structureDown.id++ }],
      ['slice floor', (value) => { value.structureDown.lowerCy++ }],
      ['slice kind', (value) => { value.structureDown.kind = 'unknown' }],
      ['slice bridge line', (value) => { value.structureDown.globalBridgeLine++ }],
      ['slice void cells', (value) => { value.structureDown.voidCells[0].lx++ }],
      ['slice bridge cells', (value) => { value.structureDown.bridgeCells[0].lz++ }],
      ['lethal id', (value) => { value.lethalVoidDown.id++ }],
      ['lethal family', (value) => { value.lethalVoidDown.family = 'lattice' }],
      ['lethal floor', (value) => { value.lethalVoidDown.lowerCy++ }],
      ['lethal cell x', (value) => { value.lethalVoidDown.cells[0].lx++ }],
      ['lethal cell z', (value) => { value.lethalVoidDown.cells[0].lz++ }],
      ['lethal death plane', (value) => { value.lethalVoidDown.cells[0].deathYmm++ }],
    ]

    expect(digest(buildChunk(12345, -3, -15, -1, CFG))).toBe(GOLDEN['-3,-15,-1'])
    for (const [label, mutate] of mutations) {
      const variant = structuredClone(data)
      mutate(variant)
      expect(digest(variant), `${label} must be digest-covered`).not.toBe(baseline)
    }
  })
})

describe('forced Lattice stamping (task 5.5 GREEN)', () => {
  it('[R03-S01..S04][R28-S01..S06][R30-S01..S05][D02/D03/D05] projects only the canonical weighted graph into open chamber and bridge raster geometry', () => {
    const { structure, chunks } = forcedLatticeFixture()
    const anchorById = new Map(structure.anchors.map((anchor) => [anchor.id, anchor]))
    const descriptorEdges = new Map(structure.edges.map((edge) => [
      latticeEdgeKey(edge),
      edge,
    ]))
    const candidateKeys = new Set(
      latticeCandidateLinks(structure.anchors).map(latticeEdgeKey)
    )
    const projectedCells = new Set()
    const expectedProjectedCells = new Set(structure.edges.flatMap((edge) =>
      edge.cells
        .filter((cell) => cell.cy > structure.baseCy)
        .map((cell) => `${latticeEdgeKey(edge)}:${cell.gx},${cell.gz},${cell.cy}`)
    ))
    const allowedCells = new Set([
      CELL_ATRIUM,
      CELL_BRIDGE,
      CELL_LOBBY,
      CELL_STAIR,
      CELL_VOID,
    ])

    expect(chunks.size).toBe(27)
    expect(structure.edges.every((edge) => candidateKeys.has(latticeEdgeKey(edge))))
      .toBe(true)
    expect(structure).not.toHaveProperty('candidateLinks')
    expect(structure).not.toHaveProperty('stamping')
    expect(structure).not.toHaveProperty('anchorContexts')
    expect(structure).not.toHaveProperty('participantStructures')

    for (const data of chunks.values()) {
      expect(data.mapFamily).toBe(MAP_FAMILY_LATTICE)
      expect(data.structure).toEqual(structure)
      expect(recursivelyFrozen(data.structure)).toBe(true)
      expect(data).not.toHaveProperty('latticeStructure')
      expect(data).not.toHaveProperty('candidateLinks')
      expect(data).not.toHaveProperty('stamping')
      expect([...data.cellKind].every((kind) => allowedCells.has(kind))).toBe(true)
    }

    for (const anchor of structure.anchors) {
      const { data, lx, lz } = generatedCell(
        chunks,
        anchor.gx,
        anchor.gz,
        anchor.levelCy
      )
      expect(data.spaceId[cIdx(lx, lz)]).toBe(structure.id)
      expect(data.cellKind[cIdx(lx, lz)]).not.toBe(CELL_VOID)

      const cues = latticeChamberCueEvidence(chunks, structure, anchor)
      expect(cues.railCells.size).toBeGreaterThan(0)
      expect(cues.bridgeSeamCells.size).toBeGreaterThan(0)
      expect(cues.combined.size).toBeGreaterThanOrEqual(
        CFG.mapFamily.profiles[MAP_FAMILY_LATTICE].minimumCueCells
      )
      expect(cues.plainWallSides).toBeLessThan(3)
    }

    for (const edge of structure.edges) {
      expect(anchorById.has(edge.a)).toBe(true)
      expect(anchorById.has(edge.b)).toBe(true)
      for (const cell of edge.cells) {
        const { data, lx, lz } = generatedCell(chunks, cell.gx, cell.gz, cell.cy)
        expect(data.spaceId[cIdx(lx, lz)]).toBe(structure.id)
        expect(data.cellKind[cIdx(lx, lz)]).not.toBe(CELL_VOID)
      }
    }

    for (let lowerCy = structure.baseCy; lowerCy < structure.topCy; lowerCy++) {
      for (const participant of structure.participants) {
        const lower = chunks.get(`${participant.cx},${lowerCy},${participant.cz}`)
        const upper = chunks.get(`${participant.cx},${lowerCy + 1},${participant.cz}`)
        expect(lower.structureUp).toEqual(upper.structureDown)
        expect(recursivelyFrozen(lower.structureUp)).toBe(true)
        expect(lower.structureUp).not.toHaveProperty('bridgeAxis')
        expect(lower.structureUp).not.toHaveProperty('bridgeLine')
        expect(lower.structureUp).not.toHaveProperty('globalBridgeLine')
        expect(Array.isArray(lower.structureUp.bridgeSegments)).toBe(true)

        const localBridgeCells = new Set()
        for (const segment of lower.structureUp.bridgeSegments) {
          const descriptorEdge = descriptorEdges.get(latticeEdgeKey(segment))
          expect(descriptorEdge).toBeDefined()
          expect(segment.role).toBe(descriptorEdge.role)
          expect(segment.orientation).toBe(
            descriptorEdge.role === 'vertical' ? 'vertical' : 'horizontal'
          )
          expect(candidateKeys.has(latticeEdgeKey(segment))).toBe(true)
          for (const cell of segment.cells) {
            expect(descriptorEdge.cells).toContainEqual(cell)
            expect(cell.cy).toBe(lowerCy + 1)
            expect(Math.floor(cell.gx / CHUNK)).toBe(participant.cx)
            expect(Math.floor(cell.gz / CHUNK)).toBe(participant.cz)
            projectedCells.add(
              `${latticeEdgeKey(segment)}:${cell.gx},${cell.gz},${cell.cy}`
            )
            localBridgeCells.add(
              `${cell.gx - participant.cx * CHUNK},${cell.gz - participant.cz * CHUNK}`
            )
          }
        }
        expect(new Set(lower.structureUp.bridgeCells.map(
          ({ lx, lz }) => `${lx},${lz}`
        ))).toEqual(localBridgeCells)
      }
    }
    expect(projectedCells).toEqual(expectedProjectedCells)

    for (const link of structure.verticalLinks) {
      const lower = chunks.get(`${link.cx},${link.lowerCy},${link.cz}`)
      const upper = chunks.get(`${link.cx},${link.lowerCy + 1},${link.cz}`)
      expect(lower.stairUp).toEqual(link.stair)
      expect(upper.stairDown).toEqual(link.stair)
    }
  })

  it('[R18-S02][R29-S03..S04][D08] derives matched integer death planes from the nearest same-floor anchor with the 5 m default and 20 m maximum', () => {
    const { structure, chunks } = forcedLatticeFixture()
    const defaultAnchor = structure.anchors.find(
      (anchor) => anchor.exposureM === undefined
    )
    const maximumAnchor = structure.anchors.find(
      (anchor) => anchor.exposureM === 20
    )
    const observedExposures = new Set()

    expect(defaultAnchor).toBeDefined()
    expect(defaultAnchor.exposureM ?? 5).toBe(5)
    expect(maximumAnchor).toBeDefined()
    expect(Math.max(...structure.anchors.map(({ exposureM = 5 }) => exposureM)))
      .toBe(20)

    for (let lowerCy = structure.baseCy; lowerCy < structure.topCy; lowerCy++) {
      const levelCy = lowerCy + 1
      const floorAnchors = structure.anchors.filter(
        (anchor) => anchor.levelCy === levelCy
      )
      for (const participant of structure.participants) {
        const lower = chunks.get(`${participant.cx},${lowerCy},${participant.cz}`)
        const upper = chunks.get(`${participant.cx},${levelCy},${participant.cz}`)
        expect(lower.lethalVoidUp).toEqual(upper.lethalVoidDown)
        expect(recursivelyFrozen(lower.lethalVoidUp)).toBe(true)
        expect(lower.lethalVoidUp).toMatchObject({
          id: structure.id,
          family: MAP_FAMILY_LATTICE,
          lowerCy,
        })
        expect(lower.lethalVoidUp.cells.map(({ lx, lz }) => ({ lx, lz })))
          .toEqual(lower.structureUp.voidCells)
        expect(lower.lethalVoidUp.cells).toEqual(
          [...lower.lethalVoidUp.cells].sort((left, right) =>
            left.lz - right.lz || left.lx - right.lx
          )
        )

        for (const cell of lower.lethalVoidUp.cells) {
          const gx = participant.cx * CHUNK + cell.lx
          const gz = participant.cz * CHUNK + cell.lz
          const nearest = floorAnchors.slice().sort((left, right) =>
            Math.abs(left.gx - gx) + Math.abs(left.gz - gz) -
              Math.abs(right.gx - gx) - Math.abs(right.gz - gz) ||
            left.id - right.id
          )[0]
          const exposureM = nearest.exposureM ?? 5
          observedExposures.add(exposureM)
          expect(exposureM).toBeLessThanOrEqual(20)
          expect(cell.deathYmm).toBe(
            Math.round((levelCy * LAYER_H - exposureM) * 1000)
          )
          expect(lower.hasCeilHole(cell.lx, cell.lz)).toBe(true)
          expect(upper.hasFloorHole(cell.lx, cell.lz)).toBe(true)
        }
      }
    }
    expect(observedExposures).toContain(5)
    expect(observedExposures).toContain(20)
  })

  it('[R03-S02][D02/D05/D08] digest-covers canonical Lattice graph, slice, segment, exposure, stair, and lethal fields without touching Office pins', () => {
    const { chunks } = forcedLatticeFixture()
    const data = [...chunks.values()].find((candidate) =>
      candidate.structureDown?.bridgeSegments?.length > 0 &&
      candidate.structureDown?.voidCells?.length > 0 &&
      candidate.lethalVoidDown?.cells?.length > 0
    )
    const baseline = digest(data)
    const mutations = [
      ['structure family', (value) => { value.structure.family = 'office' }],
      ['structure id', (value) => { value.structure.id++ }],
      ['structure kind', (value) => { value.structure.kind = 'unknown' }],
      ['district', (value) => { value.structure.district.x++ }],
      ['anchor identity', (value) => { value.structure.anchors[0].id++ }],
      ['anchor x', (value) => { value.structure.anchors[0].gx++ }],
      ['anchor floor', (value) => { value.structure.anchors[0].levelCy++ }],
      ['anchor exposure', (value) => { value.structure.anchors[0].exposureM = 6 }],
      ['edge endpoint', (value) => { value.structure.edges[0].a++ }],
      ['edge role', (value) => { value.structure.edges[0].role = 'cycle' }],
      ['edge cell x', (value) => { value.structure.edges[0].cells[0].gx++ }],
      ['edge cell floor', (value) => { value.structure.edges[0].cells[0].cy++ }],
      ['eligible cycles', (value) => { value.structure.eligibleNonBackboneLinks++ }],
      ['link floor', (value) => { value.structure.verticalLinks[0].lowerCy++ }],
      ['link participant', (value) => { value.structure.verticalLinks[0].cx++ }],
      ['link stair', (value) => { value.structure.verticalLinks[0].stair.run[0].lx++ }],
      ['slice family', (value) => { value.structureDown.family = 'tower' }],
      ['slice id', (value) => { value.structureDown.id++ }],
      ['slice void cell', (value) => { value.structureDown.voidCells[0].lx++ }],
      ['slice bridge cell', (value) => { value.structureDown.bridgeCells[0].lz++ }],
      ['segment endpoint', (value) => { value.structureDown.bridgeSegments[0].a++ }],
      ['segment role', (value) => { value.structureDown.bridgeSegments[0].role = 'cycle' }],
      ['segment orientation', (value) => { value.structureDown.bridgeSegments[0].orientation = 'vertical' }],
      ['segment cell', (value) => { value.structureDown.bridgeSegments[0].cells[0].gz++ }],
      ['lethal id', (value) => { value.lethalVoidDown.id++ }],
      ['lethal family', (value) => { value.lethalVoidDown.family = 'tower' }],
      ['lethal floor', (value) => { value.lethalVoidDown.lowerCy++ }],
      ['lethal cell x', (value) => { value.lethalVoidDown.cells[0].lx++ }],
      ['lethal death plane', (value) => { value.lethalVoidDown.cells[0].deathYmm++ }],
    ]

    expect(data).toBeDefined()
    expect(digest(buildChunk(12345, -3, -15, -1, CFG))).toBe(GOLDEN['-3,-15,-1'])
    for (const [label, mutate] of mutations) {
      const variant = structuredClone(data)
      mutate(variant)
      expect(digest(variant), `${label} must be digest-covered`).not.toBe(baseline)
    }
  })
})

describe('seam consistency', () => {
  const inBounds = (bounds, gx, gz) =>
    gx >= bounds.x0 && gx <= bounds.x1 && gz >= bounds.z0 && gz <= bounds.z1

  const participantsInclude = (structure, chunk) => structure.participants.some(
    ({ cx, cz }) => cx === chunk.cx && cz === chunk.cz
  )

  const sharedStructure = (a, b, axis) => {
    const structure = a.structure
    if (
      !structure ||
      structure.id !== b.structure?.id ||
      structure.bridgeAxis !== axis ||
      a.cy !== b.cy ||
      a.cy < structure.baseCy ||
      a.cy > structure.topCy ||
      !participantsInclude(structure, a) ||
      !participantsInclude(structure, b)
    ) return null
    return structure
  }

  const ownsVSeamCell = (west, east, z) => {
    const structure = sharedStructure(west, east, 'x')
    if (!structure) return false
    const carve = {
      x0: structure.globalBounds.x0 - 1,
      z0: structure.globalBounds.z0 - 1,
      x1: structure.globalBounds.x1 + 1,
      z1: structure.globalBounds.z1 + 1,
    }
    const gx = east.cx * CHUNK
    const gz = east.cz * CHUNK + z
    return inBounds(carve, gx - 1, gz) && inBounds(carve, gx, gz)
  }

  const ownsHSeamCell = (north, south, x) => {
    const structure = sharedStructure(north, south, 'z')
    if (!structure) return false
    const carve = {
      x0: structure.globalBounds.x0 - 1,
      z0: structure.globalBounds.z0 - 1,
      x1: structure.globalBounds.x1 + 1,
      z1: structure.globalBounds.z1 + 1,
    }
    const gx = south.cx * CHUNK + x
    const gz = south.cz * CHUNK
    return inBounds(carve, gx, gz - 1) && inBounds(carve, gx, gz)
  }

  it('stores the canonical shared border outside exact tall-structure cuts', () => {
    for (const s of SEEDS) {
      for (const [cx, cy, cz] of COORDS) {
        const ls = layerSeed(s, cy)
        const layerCtx = { rootSeed: s, layerSeed: ls, cy }
        // East seam of (cx,cz): the chunk to the east stores it as its West line 0.
        const west = buildChunk(s, cx, cy, cz, CFG)
        const east = buildChunk(s, cx + 1, cy, cz, CFG)
        const vb = vBorderContract(cx, cz, ls, CFG, layerCtx)
        for (let z = 0; z < CHUNK; z++) {
          if (ownsVSeamCell(west, east, z)) continue
          expect(east.vAt(0, z)).toBe(vb.walls[z])
          expect(east.passageVAt(0, z)).toBe(vb.passages[z])
        }

        // South seam of (cx,cz): the chunk to the south stores it as its North line 0.
        const north = west
        const south = buildChunk(s, cx, cy, cz + 1, CFG)
        const hb = hBorderContract(cx, cz, ls, CFG, layerCtx)
        for (let x = 0; x < CHUNK; x++) {
          if (ownsHSeamCell(north, south, x)) continue
          expect(south.hAt(x, 0)).toBe(hb.walls[x])
          expect(south.passageHAt(x, 0)).toBe(hb.passages[x])
        }
      }
    }
  })

  it('opens every structure-owned shared seam cell as one protected wide cut', () => {
    let owned = 0
    let changedFromCanonical = 0
    for (const s of SEEDS) {
      for (const [districtX, districtZ] of [[-2, -1], [1, 2]]) {
        const structure = districtStructure(s, districtX, districtZ)
        const cy = structure.baseCy
        const ls = layerSeed(s, cy)
        const layerCtx = { rootSeed: s, layerSeed: ls, cy }
        const [first, second] = structure.participants.map(({ cx, cz }) =>
          buildChunk(s, cx, cy, cz, CFG)
        )
        if (structure.bridgeAxis === 'x') {
          const vb = vBorderContract(first.cx, first.cz, ls, CFG, layerCtx)
          for (let z = 0; z < CHUNK; z++) {
            if (!ownsVSeamCell(first, second, z)) continue
            owned++
            if (second.vAt(0, z) !== vb.walls[z]) changedFromCanonical++
            expect(second.vAt(0, z)).toBe(0)
            expect(second.passageVAt(0, z)).toBe(PASSAGE_WIDE)
            expect(second.wallFeatureVAt(0, z)).toBe(WALL_PLAIN)
          }
        } else {
          const hb = hBorderContract(first.cx, first.cz, ls, CFG, layerCtx)
          for (let x = 0; x < CHUNK; x++) {
            if (!ownsHSeamCell(first, second, x)) continue
            owned++
            if (second.hAt(x, 0) !== hb.walls[x]) changedFromCanonical++
            expect(second.hAt(x, 0)).toBe(0)
            expect(second.passageHAt(x, 0)).toBe(PASSAGE_WIDE)
            expect(second.wallFeatureHAt(x, 0)).toBe(WALL_PLAIN)
          }
        }
      }
    }
    expect(owned).toBeGreaterThan(0)
    expect(changedFromCanonical).toBeGreaterThan(0)
  })
})

describe('border contracts', () => {
  // Planned internal office cuts may be solid room walls; canonical transitions
  // and district boundaries must always retain a portal.
  it('every canonical border contract keeps at least one opening', () => {
    for (const s of SEEDS) {
      for (const [cx, , cz] of COORDS) {
        for (const c of [
          vBorderContract(cx, cz, s, CFG),
          hBorderContract(cx, cz, s, CFG),
        ]) {
          if (c.kind !== 'planned') expect(c.walls.some((v) => v === 0)).toBe(true)
        }
      }
    }
  })
})

describe('bounds & shape', () => {
  it('arrays are correctly sized and lamps in range', () => {
    for (const s of SEEDS) {
      for (const [cx, cy, cz] of COORDS) {
        const d = buildChunk(s, cx, cy, cz, CFG)
        expect(d.wallV.length).toBe(CHUNK * CHUNK)
        expect(d.wallH.length).toBe(CHUNK * CHUNK)
        expect(d.passageV.length).toBe(CHUNK * CHUNK)
        expect(d.passageH.length).toBe(CHUNK * CHUNK)
        expect(d.wallFeatureV.length).toBe(CHUNK * CHUNK)
        expect(d.wallFeatureH.length).toBe(CHUNK * CHUNK)
        expect(d.cols.length).toBe(CHUNK * CHUNK)
        expect(d.cellKind.length).toBe(CHUNK * CHUNK)
        expect(d.spaceId.length).toBe(CHUNK * CHUNK)
        expect(d.exit).toBe(null)
        for (const l of d.lamps) {
          expect(l.lx).toBeGreaterThanOrEqual(0)
          expect(l.lx).toBeLessThan(CHUNK)
          expect(l.lz).toBeGreaterThanOrEqual(0)
          expect(l.lz).toBeLessThan(CHUNK)
          expect(typeof l.lit).toBe('boolean')
        }
      }
    }
  })
})

describe('lamp regularity', () => {
  it('lamps follow room grids or circulation intervals and never occupy columns', () => {
    const step = CFG.lamps.step
    for (const s of SEEDS) {
      for (const [cx, cy, cz] of COORDS) {
        const d = buildChunk(s, cx, cy, cz, CFG)
        const ls = layerSeed(s, cy)
        const phase = CFG.lamps.phase[d.zone] ?? 0
        for (const l of d.lamps) {
          const gx = cx * CHUNK + l.lx
          const gz = cz * CHUNK + l.lz
          const kind = d.cellKind[l.lz * CHUNK + l.lx]
          if (kind === CELL_CORRIDOR || kind === CELL_LOBBY || kind === CELL_BRIDGE) {
            const corridorPhase =
              hash2i((ls ^ CFG.lamps.corridorSalt) | 0, 0x43, 0) % CFG.lamps.corridorStep
            expect(
              (((gx + gz - corridorPhase) % CFG.lamps.corridorStep) +
                CFG.lamps.corridorStep) %
                CFG.lamps.corridorStep
            ).toBe(0)
          } else {
            expect((((gx - phase) % step) + step) % step).toBe(0)
            expect((((gz - phase) % step) + step) % step).toBe(0)
          }
          expect(d.colAt(l.lx, l.lz)).toBe(0)
          expect(d.hasCeilHole(l.lx, l.lz)).toBe(false)
        }
      }
    }
  })

  // Regression: a pillar lattice sharing the phase-0 lamp grid rejects nearly
  // every fixture candidate. The per-zone offset must keep bounded hypostyle
  // halls deliberately lit rather than accidentally pitch-black.
  it('pillars chunks get real lamp coverage (>= 4 lamps/chunk on average)', () => {
    const cfg = structuredClone(CFG)
    cfg.zoneBands = [{ id: ZONE_PILLARS, max: 1.01 }]
    cfg.stairs.enabled = false
    cfg.multilevel.enabled = false
    for (const s of SEEDS) {
      let lamps = 0
      let chunks = 0
      for (let cz = -2; cz <= 2; cz++) {
        for (let cx = -2; cx <= 2; cx++) {
          const d = buildChunk(s, cx, 0, cz, cfg)
          expect(d.zone).toBe(ZONE_PILLARS)
          lamps += d.lamps.length
          chunks++
        }
      }
      expect(chunks).toBeGreaterThan(0)
      expect(lamps / chunks).toBeGreaterThanOrEqual(4)
    }
  })
})

describe('monumental pillar halls', () => {
  it('places true large-pier bytes on a seam-continuous global bay grid', () => {
    const cfg = structuredClone(CFG)
    cfg.zoneBands = [{ id: ZONE_PILLARS, max: 1.01 }]
    cfg.stairs.enabled = false
    cfg.multilevel.enabled = false
    cfg.pillars.monumentalChance = 1
    const { spacing, phase } = cfg.pillars
    let columns = 0
    for (const [cx, cz] of [[0, 0], [1, 0], [-1, -1]]) {
      const data = buildChunk(0x5049, cx, 0, cz, cfg)
      expect(data.zone).toBe(ZONE_PILLARS)
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          const gx = cx * CHUNK + x
          const gz = cz * CHUNK + z
          const expected = fmod(gx, spacing) === phase && fmod(gz, spacing) === phase
          expect(data.colAt(x, z)).toBe(expected ? COLUMN_MONUMENTAL : 0)
          if (expected) columns++
        }
      }
    }
    expect(columns).toBeGreaterThan(0)
  })

  it('uses coherent processional, broken-bay, and court signatures', () => {
    const processional = {
      x0: 0,
      z0: 0,
      x1: 0,
      z1: 0,
      axis: 'x',
      pierPattern: 'processionalAisle',
    }
    expect(pillarColumnKindAt(1, 0, 4, processional, CFG)).toBe(COLUMN_MONUMENTAL)
    expect(pillarColumnKindAt(1, 0, 8, processional, CFG)).toBe(COLUMN_MONUMENTAL)
    expect(pillarColumnKindAt(1, 0, 0, processional, CFG)).toBe(COLUMN_STANDARD)
    expect(pillarColumnKindAt(1, 1, 4, processional, CFG)).toBe(COLUMN_NONE)

    const broken = {
      ...processional,
      x0: 0,
      z0: 0,
      x1: 2,
      z1: 2,
      pierPattern: 'brokenBay',
    }
    expect(pillarColumnKindAt(1, 20, 20, broken, CFG)).toBe(COLUMN_NONE)
    expect(pillarColumnKindAt(1, 16, 20, broken, CFG)).toBe(COLUMN_MONUMENTAL)

    const court = { ...processional, pierPattern: 'courtColonnade' }
    expect(pillarColumnKindAt(1, 0, 0, court, CFG)).toBe(COLUMN_MONUMENTAL)
  })

  it('recovers one processional signature across every real landmark slice', () => {
    const cfg = structuredClone(CFG)
    cfg.stairs.enabled = false
    cfg.multilevel.enabled = false

    for (const axis of ['x', 'z']) {
      let found = null
      for (let seed = 0; seed < 64 && !found; seed++) {
        for (let dz = -8; dz <= 8 && !found; dz++) {
          for (let dx = -8; dx <= 8; dx++) {
            const landmark = regionLandmark(seed, dx, dz, cfg)
            if (
              landmark.active &&
              landmark.kind === 'pillarHall' &&
              landmark.pierPattern === 'processionalAisle' &&
              landmark.axis === axis &&
              landmark.width >= 2 &&
              landmark.height >= 2
            ) {
              found = { seed, landmark }
              break
            }
          }
        }
      }
      expect(found).not.toBeNull()

      const { seed, landmark } = found
      const global = {
        x0: landmark.x0 * CHUNK,
        z0: landmark.z0 * CHUNK,
        x1: (landmark.x1 + 1) * CHUNK - 1,
        z1: (landmark.z1 + 1) * CHUNK - 1,
      }
      let monumental = 0
      let standard = 0
      for (let cz = landmark.z0; cz <= landmark.z1; cz++) {
        for (let cx = landmark.x0; cx <= landmark.x1; cx++) {
          if (!regionLandmarkContains(landmark, cx, cz)) continue
          expect(regionLandmarkAt(cx, cz, seed, cfg)).toEqual(landmark)
          const data = buildChunk(seed, cx, 0, cz, cfg)
          for (let z = 0; z < CHUNK; z++) {
            for (let x = 0; x < CHUNK; x++) {
              const gx = cx * CHUNK + x
              const gz = cz * CHUNK + z
              if (
                gx < global.x0 + 3 || gx > global.x1 - 3 ||
                gz < global.z0 + 3 || gz > global.z1 - 3
              ) continue
              const expected = pillarColumnKindAt(seed, gx, gz, landmark, cfg)
              if (!expected) continue
              expect(data.colAt(x, z)).toBe(expected)
              monumental += expected === COLUMN_MONUMENTAL ? 1 : 0
              standard += expected === COLUMN_STANDARD ? 1 : 0
            }
          }
        }
      }
      expect(monumental).toBeGreaterThan(0)
      expect(standard).toBeGreaterThan(0)
    }
  })

  it('realizes the elected missing pier of a broken-bay landmark', () => {
    const cfg = structuredClone(CFG)
    cfg.stairs.enabled = false
    cfg.multilevel.enabled = false
    let found = null
    for (let seed = 0; seed < 64 && !found; seed++) {
      for (let dz = -8; dz <= 8 && !found; dz++) {
        for (let dx = -8; dx <= 8; dx++) {
          const landmark = regionLandmark(seed, dx, dz, cfg)
          if (landmark.active && landmark.pierPattern === 'brokenBay') {
            found = { seed, landmark }
            break
          }
        }
      }
    }
    expect(found).not.toBeNull()
    const { seed, landmark } = found
    const { spacing, phase } = cfg.pillars
    const missing = []
    for (let gz = landmark.z0 * CHUNK; gz < (landmark.z1 + 1) * CHUNK; gz++) {
      for (let gx = landmark.x0 * CHUNK; gx < (landmark.x1 + 1) * CHUNK; gx++) {
        if (fmod(gx, spacing) !== phase || fmod(gz, spacing) !== phase) continue
        if (pillarColumnKindAt(seed, gx, gz, landmark, cfg) === COLUMN_NONE) {
          missing.push({ gx, gz })
        }
      }
    }
    expect(missing).toHaveLength(1)

    const [{ gx, gz }] = missing
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const data = buildChunk(seed, cx, 0, cz, cfg)
    expect(data.colAt(gx - cx * CHUNK, gz - cz * CHUNK)).toBe(COLUMN_NONE)
    const neighborX = gx + spacing
    const neighborCx = Math.floor(neighborX / CHUNK)
    const neighbor = buildChunk(seed, neighborCx, 0, cz, cfg)
    expect(pillarColumnKindAt(seed, neighborX, gz, landmark, cfg))
      .toBe(COLUMN_MONUMENTAL)
    expect(neighbor.colAt(neighborX - neighborCx * CHUNK, gz - cz * CHUNK))
      .toBe(COLUMN_MONUMENTAL)
  })
})

describe('config purity', () => {
  it('generators read config (lamp chance 0 -> no lamps)', () => {
    const cfg = structuredClone(CFG)
    for (const k of Object.keys(cfg.lamps.chance)) cfg.lamps.chance[k] = 0
    for (const [cx, cy, cz] of COORDS) {
      expect(buildChunk(7, cx, cy, cz, cfg).lamps.length).toBe(0)
    }
  })

  it('propagates the config generation version into ChunkData', () => {
    const cfg = structuredClone(CFG)
    cfg.version = 999
    expect(buildChunk(7, 0, 0, 0, cfg).version).toBe(999)
  })
})

describe('office invariant (I1)', () => {
  it('every compiled office slice is one connected component', () => {
    const cfg = structuredClone(CFG)
    cfg.zoneBands = [{ id: ZONE_OFFICE, max: 1.01 }]
    for (const s of SEEDS) {
      for (const [cx, cy, cz] of COORDS) {
        expect(countChunkComponents(buildChunk(s, cx, cy, cz, cfg))).toBe(1)
      }
    }
  })
})

describe('anomaly determinism', () => {
  it('pins exit and clearing inputs in regenerated output', () => {
    const a = buildChunk(77, 0, 0, 0, CFG, { lx: 3, lz: 4 }, [{ lx: 8, lz: 9, r: 2 }])
    const b = buildChunk(77, 0, 0, 0, CFG, { lx: 3, lz: 4 }, [{ lx: 8, lz: 9, r: 2 }])
    const ordinary = buildChunk(77, 0, 0, 0, CFG)
    expect(digest(a)).toBe(digest(b))
    expect(digest(a)).not.toBe(digest(ordinary))
    expect(a.exit).toEqual({ lx: 3, lz: 4 })
  })

  it('marks clearing cuts across semantic rooms as wide thresholds', () => {
    const ordinary = buildChunk(0, 1, 0, -3, CFG)
    const data = buildChunk(0, 1, 0, -3, CFG, null, [{ lx: 8, lz: 8, r: 2 }])
    expect(data.zone).toBe(ZONE_OFFICE)
    let changedCrossSpaceEdges = 0
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 1; x < CHUNK; x++) {
        const west = data.spaceId[z * CHUNK + x - 1]
        const east = data.spaceId[z * CHUNK + x]
        const passage = data.passageVAt(x, z)
        if (west && east && west !== east) {
          expect(passage).not.toBe(PASSAGE_OPEN)
          if (passage !== ordinary.passageVAt(x, z)) {
            expect(passage).toBe(PASSAGE_WIDE)
            changedCrossSpaceEdges++
          }
        }
      }
    }
    for (let z = 1; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) {
        const north = data.spaceId[(z - 1) * CHUNK + x]
        const south = data.spaceId[z * CHUNK + x]
        const passage = data.passageHAt(x, z)
        if (north && south && north !== south) {
          expect(passage).not.toBe(PASSAGE_OPEN)
          if (passage !== ordinary.passageHAt(x, z)) {
            expect(passage).toBe(PASSAGE_WIDE)
            changedCrossSpaceEdges++
          }
        }
      }
    }
    expect(changedCrossSpaceEdges).toBeGreaterThan(0)
  })

  it('normalizes a door frame after transition carving removes its supports', () => {
    const cfg = structuredClone(CFG)
    cfg.stairs.enabled = false
    // This fixture targets the transition/door-normalization integration, not
    // the default landmark election. Recover the broad-field coordinate that
    // originally exposed the unsupported frame.
    cfg.region.roomDominance.enabled = false
    const data = buildChunk(89, -10, 0, -6, cfg)
    expect(data.zone).toBe(ZONE_OFFICE)
    expect(data.hAt(5, 12)).toBe(0)
    expect(data.hAt(7, 12)).toBe(0)
    expect(data.passageHAt(6, 12)).toBe(PASSAGE_WIDE)
  })
})
