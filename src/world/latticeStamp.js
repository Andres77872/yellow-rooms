import { CHUNK, LAYER_H, cIdx } from './constants.js'
import { deepFreeze } from './mapFamily.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_VOID,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  WALL_RAIL,
} from './mapTypes.js'
import {
  analyzeLatticeDescriptor,
  compareLatticeEdges,
  latticeHorizontalCellKey,
} from './lattice.js'
import { stampStructureVerticalLinks } from './stairStamp.js'

const CHAMBER_RADIUS = 1

const compareLocalCells = (left, right) =>
  left.lz - right.lz || left.lx - right.lx

export const latticeEffectiveExposureM = (anchor, profile) =>
  anchor?.exposureM === undefined
    ? profile.defaultExposureM
    : anchor.exposureM

// Stamping and runtime projection accept only the immutable planner descriptor
// after the shared candidate/MST/cycle/scope analyzer passes.
function canonicalGraphEvidence(structure, profile) {
  if (!Object.isFrozen(structure)) return null
  const analysis = analyzeLatticeDescriptor(structure, profile)
  return analysis.ok ? analysis : null
}

function inside(bounds, gx, gz) {
  return gx >= bounds.x0 &&
    gx <= bounds.x1 &&
    gz >= bounds.z0 &&
    gz <= bounds.z1
}

function addGlobalCell(target, bounds, gx, gz) {
  if (inside(bounds, gx, gz)) target.add(latticeHorizontalCellKey(gx, gz))
}

export function latticeFloorGeometry(structure, levelCy) {
  const chamberCells = new Set()
  const edgeCells = new Set()
  const stairSafeCells = new Set()
  for (const anchor of structure.anchors) {
    if (anchor.levelCy !== levelCy) continue
    for (let dz = -CHAMBER_RADIUS; dz <= CHAMBER_RADIUS; dz++) {
      for (let dx = -CHAMBER_RADIUS; dx <= CHAMBER_RADIUS; dx++) {
        addGlobalCell(
          chamberCells,
          structure.globalBounds,
          anchor.gx + dx,
          anchor.gz + dz
        )
      }
    }
  }
  for (const edge of structure.edges) {
    for (const cell of edge.cells) {
      if (cell.cy === levelCy) {
        edgeCells.add(latticeHorizontalCellKey(cell.gx, cell.gz))
      }
    }
  }
  for (const link of structure.verticalLinks) {
    if (levelCy !== link.lowerCy && levelCy !== link.lowerCy + 1) continue
    const cells = [link.stair.landing, ...link.stair.run, link.stair.exit]
    for (const cell of cells) {
      const gx = link.cx * CHUNK + cell.lx
      const gz = link.cz * CHUNK + cell.lz
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          addGlobalCell(
            stairSafeCells,
            structure.globalBounds,
            gx + dx,
            gz + dz
          )
        }
      }
    }
  }
  return {
    chamberCells,
    edgeCells,
    stairSafeCells,
    retained: new Set([...chamberCells, ...edgeCells, ...stairSafeCells]),
  }
}

export function latticeProjectedSegments(structure, cx, cz, levelCy) {
  const segments = []
  for (const edge of structure.edges) {
    const cells = edge.cells.filter((cell) =>
      cell.cy === levelCy &&
      Math.floor(cell.gx / CHUNK) === cx &&
      Math.floor(cell.gz / CHUNK) === cz
    ).map(({ gx, gz, cy }) => ({ gx, gz, cy }))
    if (cells.length === 0) continue
    segments.push({
      a: edge.a,
      b: edge.b,
      role: edge.role,
      orientation: edge.role === 'vertical' ? 'vertical' : 'horizontal',
      cells,
    })
  }
  return segments.sort(compareLatticeEdges)
}

export function latticeStructureSlice(structure, cx, cz, lowerCy, profile) {
  if (
    !canonicalGraphEvidence(structure, profile) ||
    !structure.participants.some(
      (participant) => participant.cx === cx && participant.cz === cz
    ) ||
    !Number.isInteger(lowerCy) ||
    lowerCy < structure.baseCy ||
    lowerCy >= structure.topCy
  ) return null

  const levelCy = lowerCy + 1
  const geometry = latticeFloorGeometry(structure, levelCy)
  const chunkGx = cx * CHUNK
  const chunkGz = cz * CHUNK
  const voidCells = []
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      if (!geometry.retained.has(
        latticeHorizontalCellKey(chunkGx + lx, chunkGz + lz)
      )) {
        voidCells.push({ lx, lz })
      }
    }
  }
  const bridgeSegments = latticeProjectedSegments(structure, cx, cz, levelCy)
  const bridgeCells = [...new Map(bridgeSegments.flatMap((segment) =>
    segment.cells.map((cell) => {
      const local = { lx: cell.gx - chunkGx, lz: cell.gz - chunkGz }
      return [`${local.lx},${local.lz}`, local]
    })
  )).values()].sort(compareLocalCells)
  const localBounds = { x0: 0, z0: 0, x1: CHUNK - 1, z1: CHUNK - 1 }
  return deepFreeze({
    id: structure.id,
    family: structure.family,
    kind: structure.kind,
    hasRoom: true,
    baseCy: structure.baseCy,
    topCy: structure.topCy,
    lowerCy,
    levelCy,
    bounds: localBounds,
    localBounds,
    globalBounds: structure.globalBounds,
    voidCells,
    bridgeCells,
    bridgeSegments,
  })
}

function resetLatticeRaster(data, structure, geometry) {
  const chunkGx = data.cx * CHUNK
  const chunkGz = data.cz * CHUNK
  data.furniture = []
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const key = latticeHorizontalCellKey(chunkGx + lx, chunkGz + lz)
      data.setCol(lx, lz, 0)
      data.spaceId[cIdx(lx, lz)] = structure.id
      data.cellKind[cIdx(lx, lz)] = geometry.chamberCells.has(key) ||
        geometry.stairSafeCells.has(key)
        ? CELL_ATRIUM
        : geometry.edgeCells.has(key) ? CELL_BRIDGE : CELL_VOID
    }
  }
  for (let cell = 0; cell < CHUNK; cell++) {
    for (let line = 0; line < CHUNK; line++) {
      data.setV(line, cell, 0, PASSAGE_WIDE)
      data.setH(cell, line, 0, PASSAGE_WIDE)
    }
  }
}

function restoreCanonicalGraphCellKinds(data, geometry) {
  const chunkGx = data.cx * CHUNK
  const chunkGz = data.cz * CHUNK
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const key = latticeHorizontalCellKey(chunkGx + lx, chunkGz + lz)
      if (geometry.chamberCells.has(key)) {
        data.cellKind[cIdx(lx, lz)] = CELL_ATRIUM
      } else if (geometry.edgeCells.has(key)) {
        data.cellKind[cIdx(lx, lz)] = CELL_BRIDGE
      }
    }
  }
}

function stampRetainedBoundaryRails(data, geometry) {
  const chunkGx = data.cx * CHUNK
  const chunkGz = data.cz * CHUNK
  for (let cell = 0; cell < CHUNK; cell++) {
    const gz = chunkGz + cell
    for (let line = 0; line < CHUNK; line++) {
      const gx = chunkGx + line
      const left = geometry.retained.has(latticeHorizontalCellKey(gx - 1, gz))
      const right = geometry.retained.has(latticeHorizontalCellKey(gx, gz))
      if (left === right) continue
      data.setV(line, cell, 1, PASSAGE_WALL, WALL_RAIL)
      data.protectV(line, cell)
    }
  }
  for (let cell = 0; cell < CHUNK; cell++) {
    const gx = chunkGx + cell
    for (let line = 0; line < CHUNK; line++) {
      const gz = chunkGz + line
      const north = geometry.retained.has(latticeHorizontalCellKey(gx, gz - 1))
      const south = geometry.retained.has(latticeHorizontalCellKey(gx, gz))
      if (north === south) continue
      data.setH(cell, line, 1, PASSAGE_WALL, WALL_RAIL)
      data.protectH(cell, line)
    }
  }
}

export function latticeChamberApproaches(structure, anchor) {
  const approaches = new Set()
  for (const edge of structure.edges) {
    if (edge.a !== anchor.id && edge.b !== anchor.id) continue
    const outside = edge.cells
      .filter((cell) => cell.cy === anchor.levelCy)
      .filter((cell) =>
        Math.abs(cell.gx - anchor.gx) > CHAMBER_RADIUS ||
        Math.abs(cell.gz - anchor.gz) > CHAMBER_RADIUS
      )
      .sort((left, right) =>
        Math.abs(left.gx - anchor.gx) + Math.abs(left.gz - anchor.gz) -
          Math.abs(right.gx - anchor.gx) - Math.abs(right.gz - anchor.gz)
      )[0]
    if (!outside) continue
    if (outside.gx > anchor.gx) approaches.add(`v:${anchor.gx + 2},${anchor.gz}`)
    else if (outside.gx < anchor.gx) approaches.add(`v:${anchor.gx - 1},${anchor.gz}`)
    else if (outside.gz > anchor.gz) approaches.add(`h:${anchor.gx},${anchor.gz + 2}`)
    else if (outside.gz < anchor.gz) approaches.add(`h:${anchor.gx},${anchor.gz - 1}`)
  }

  const lowerLink = structure.verticalLinks.find((link) =>
    link.lowerCy === anchor.levelCy &&
    link.cx === Math.floor(anchor.gx / CHUNK) &&
    link.cz === Math.floor(anchor.gz / CHUNK) &&
    link.stair.landing.lx === ((anchor.gx % CHUNK) + CHUNK) % CHUNK &&
    link.stair.landing.lz === ((anchor.gz % CHUNK) + CHUNK) % CHUNK
  )
  if (lowerLink) {
    if (lowerLink.stair.dir === 0) approaches.add(`h:${anchor.gx},${anchor.gz - 1}`)
    else if (lowerLink.stair.dir === 1) approaches.add(`v:${anchor.gx + 2},${anchor.gz}`)
    else if (lowerLink.stair.dir === 2) approaches.add(`h:${anchor.gx},${anchor.gz + 2}`)
    else approaches.add(`v:${anchor.gx - 1},${anchor.gz}`)
  }
  return approaches
}

export function latticeChamberPerimeter(anchor) {
  return [
    Array.from({ length: 3 }, (_, offset) => ({
      axis: 'h', gx: anchor.gx - 1 + offset, gz: anchor.gz - 1,
    })),
    Array.from({ length: 3 }, (_, offset) => ({
      axis: 'v', gx: anchor.gx + 2, gz: anchor.gz - 1 + offset,
    })),
    Array.from({ length: 3 }, (_, offset) => ({
      axis: 'h', gx: anchor.gx - 1 + offset, gz: anchor.gz + 2,
    })),
    Array.from({ length: 3 }, (_, offset) => ({
      axis: 'v', gx: anchor.gx - 1, gz: anchor.gz - 1 + offset,
    })),
  ]
}

// Rails remain the chamber cue source even when a retained stair halo surrounds
// an anchor. Only canonical bridge/stair approach cells stay open; no plain-wall
// room perimeter is introduced.
function stampChamberCueRails(data, structure) {
  const chunkGx = data.cx * CHUNK
  const chunkGz = data.cz * CHUNK
  for (const anchor of structure.anchors) {
    if (anchor.levelCy !== data.cy) continue
    const approaches = latticeChamberApproaches(structure, anchor)
    const perimeter = latticeChamberPerimeter(anchor)
    for (let offset = 0; offset < 3; offset++) {
      for (const side of perimeter) {
        const edge = side[offset]
        if (approaches.has(`${edge.axis}:${edge.gx},${edge.gz}`)) continue
        if (edge.axis === 'v') {
          const cx = Math.floor(edge.gx / CHUNK)
          const cz = Math.floor(edge.gz / CHUNK)
          if (cx !== data.cx || cz !== data.cz) continue
          const line = edge.gx - chunkGx
          const cell = edge.gz - chunkGz
          data.setV(line, cell, 1, PASSAGE_WALL, WALL_RAIL)
          data.protectV(line, cell)
        } else {
          const cx = Math.floor(edge.gx / CHUNK)
          const cz = Math.floor(edge.gz / CHUNK)
          if (cx !== data.cx || cz !== data.cz) continue
          const cell = edge.gx - chunkGx
          const line = edge.gz - chunkGz
          data.setH(cell, line, 1, PASSAGE_WALL, WALL_RAIL)
          data.protectH(cell, line)
        }
      }
    }
  }
}

export function latticeNearestAnchor(anchors, gx, gz) {
  return anchors.slice().sort((left, right) =>
    Math.abs(left.gx - gx) + Math.abs(left.gz - gz) -
      Math.abs(right.gx - gx) - Math.abs(right.gz - gz) ||
    left.id - right.id
  )[0]
}

function lethalVoidHalf(structure, slice, profile, cx, cz) {
  if (!slice || slice.voidCells.length === 0) return null
  const anchors = structure.anchors.filter(
    (anchor) => anchor.levelCy === slice.levelCy
  )
  if (anchors.length === 0) return null
  const chunkGx = cx * CHUNK
  const chunkGz = cz * CHUNK
  const cells = slice.voidCells.map(({ lx, lz }) => {
    const gx = chunkGx + lx
    const gz = chunkGz + lz
    const nearest = latticeNearestAnchor(anchors, gx, gz)
    const exposureM = latticeEffectiveExposureM(nearest, profile)
    return {
      lx,
      lz,
      deathYmm: Math.round((slice.levelCy * LAYER_H - exposureM) * 1000),
    }
  })
  return deepFreeze({
    id: structure.id,
    family: structure.family,
    lowerCy: slice.lowerCy,
    cells,
  })
}

export function stampLatticeStructure(data, structure, profile) {
  if (
    !canonicalGraphEvidence(structure, profile) ||
    !structure.participants.some(
      (participant) => participant.cx === data?.cx && participant.cz === data?.cz
    ) ||
    !Number.isInteger(data?.cy) ||
    data.cy < structure.baseCy ||
    data.cy > structure.topCy
  ) return false

  const geometry = latticeFloorGeometry(structure, data.cy)
  resetLatticeRaster(data, structure, geometry)
  stampRetainedBoundaryRails(data, geometry)

  data.multilevelStructure = structure
  data.multilevelUp = data.cy < structure.topCy
    ? latticeStructureSlice(structure, data.cx, data.cz, data.cy, profile)
    : null
  data.multilevelDown = data.cy > structure.baseCy
    ? latticeStructureSlice(structure, data.cx, data.cz, data.cy - 1, profile)
    : null
  stampStructureVerticalLinks(data, structure)
  // Graph/chamber raster identity remains canonical when a stair halo overlaps
  // an owned bridge cell. The stair descriptor still owns holes, ramps, and
  // guards; CELL_STAIR/CELL_LOBBY remains only on halo cells outside the graph.
  restoreCanonicalGraphCellKinds(data, geometry)
  stampRetainedBoundaryRails(data, geometry)
  stampChamberCueRails(data, structure)
  data.lethalVoidUp = lethalVoidHalf(
    structure,
    data.multilevelUp,
    profile,
    data.cx,
    data.cz
  )
  data.lethalVoidDown = lethalVoidHalf(
    structure,
    data.multilevelDown,
    profile,
    data.cx,
    data.cz
  )
  return true
}
