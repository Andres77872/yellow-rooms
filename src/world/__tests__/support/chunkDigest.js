// Golden chunk digest, moved verbatim from generate.test.js (spec §13.1).
// `version` overrides the folded generator version so the re-pin helper
// can prove a WORLD_GEN_VERSION bump value-neutral (refold at the old
// version); without it the chunk's own version is folded, exactly as before.
import { CATALOG_KINDS, isCatalogKind } from '../../structures/catalog/engine.js'
import { fmix32 } from '../../core/hash.js'
import { MAP_FAMILY_CODES } from '../../mapFamily.js'
import {
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  SEWER_DIRECTIONS,
  SEWER_MODULE_KINDS,
} from '../../mapTypes.js'

const CATALOG_KIND_LIST = Object.values(CATALOG_KINDS)

// Stable fold over a chunk's full state — pins the generator output so any
// accidental algorithm drift fails CI (intentional changes bump WORLD_GEN_VERSION
// and re-pin these). Computed from the committed implementation.
export function digestChunk(d, { version } = {}) {
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
            : isCatalogKind(kind)
              ? 5 + CATALOG_KIND_LIST.indexOf(kind)
              : 0
  )
  const foldString = (value) => {
    fold(typeof value === 'string' ? value.length : -1)
    for (const character of value ?? '') fold(character.charCodeAt(0))
  }
  const foldCells = (cells, xKey = 'lx', zKey = 'lz') => {
    fold(cells.length)
    for (const cell of cells) {
      fold(cell[xKey])
      fold(cell[zKey])
    }
  }
  fold(version ?? d.version)
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
    if (isCatalogKind(room.kind)) {
      // v26 catalog slices: family, recipe type and the aperture partition.
      fold(MAP_FAMILY_CODES[room.family] ?? -1)
      foldString(room.type)
      fold(room.apertureRects.length)
      for (const r of room.apertureRects) foldBounds(r)
    } else if (
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
    if (isCatalogKind(structure.kind)) {
      // v26 catalog volume: every behaviour-bearing field.
      foldKind(structure.kind)
      fold(MAP_FAMILY_CODES[structure.family] ?? -1)
      foldString(structure.type)
      foldString(structure.sizeClass)
      fold(structure.district.x)
      fold(structure.district.z)
      fold(structure.district.size)
      fold(structure.bandIndex)
      fold(structure.slot)
      fold(structure.baseCy)
      fold(structure.topCy)
      fold(structure.levelCount)
      fold(structure.participants.length)
      for (const p of structure.participants) {
        fold(p.cx)
        fold(p.cz)
      }
      foldBounds(structure.globalBounds)
      foldAxis(structure.bridgeAxis)
      fold(structure.glazing === 'window' ? 1 : 0)
      fold(structure.levels.length)
      for (const level of structure.levels) {
        fold(level.levelCy)
        fold(level.voids.length)
        for (const r of level.voids) foldBounds(r)
        fold(level.bridges.length)
        for (const r of level.bridges) foldBounds(r)
      }
      foldCells(structure.columns, 'gx', 'gz')
      foldCells(structure.piers, 'gx', 'gz')
      if (structure.core) {
        fold(1)
        for (const key of ['gx', 'gz', 'dir', 'side']) fold(structure.core[key])
        fold(structure.core.well ? 1 : 0)
        fold(structure.core.enclosed ? 1 : 0)
        fold(structure.core.doorSide === 'far' ? 1 : 0)
        foldBounds(structure.core.rect)
      } else fold(0)
      fold(structure.verticalLinks.length)
      for (const link of structure.verticalLinks) {
        fold(link.lowerCy)
        fold(link.cx)
        fold(link.cz)
        foldStair(link.stair)
      }
      if (structure.deviation) {
        fold(1)
        foldString(structure.deviation.kind)
        fold(structure.deviation.levelCy)
      } else fold(0)
      return
    }
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
      fold(['nave', 'splitCourt', 'overlookCourt'].indexOf(structure.architecture?.form) + 1)
      fold(structure.architecture?.longSpan ?? 0)
      fold(structure.architecture?.shortSpan ?? 0)
      fold(structure.architecture?.columnBay ?? 0)
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
        fold(['landing', 'pierX', 'pierZ', 'crossing'].indexOf(anchor.platform) + 1)
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
      const foldText = (value) => {
        fold(value.length)
        for (const character of value) fold(character.charCodeAt(0))
      }
      foldText(descriptor.layout)
      fold(SEWER_DIRECTIONS.indexOf(descriptor.heading) + 1)
      fold(descriptor.trunkLine)
      fold(descriptor.trunkCount)
      fold(descriptor.chambers.length)
      for (const chamber of descriptor.chambers) {
        foldBounds(chamber)
        foldCells([chamber.anchor])
        fold(SEWER_MODULE_KINDS.indexOf(chamber.kind) + 1)
      }
      fold(descriptor.structures.length)
      for (const structure of descriptor.structures) {
        foldText(structure.kind)
        foldBounds(structure.bounds)
        foldBounds(structure.core)
        foldCells(structure.anchor ? [structure.anchor] : [])
        foldCells(structure.junction ? [structure.junction] : [])
        foldCells(structure.cells ?? [])
        foldMaybeInt(structure.loopEdge?.a)
        foldMaybeInt(structure.loopEdge?.b)
      }
      fold(descriptor.modules.length)
      for (const module of descriptor.modules) {
        fold(SEWER_MODULE_KINDS.indexOf(module.kind) + 1)
        fold(module.lx)
        fold(module.lz)
        fold(SEWER_DIRECTIONS.indexOf(module.dir) + 1)
        foldText(module.region)
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
