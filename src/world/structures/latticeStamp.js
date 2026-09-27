import { CHUNK, LAYER_H, cIdx } from '../constants.js'
import { deepFreeze } from '../mapFamily.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_OPEN,
  CELL_VOID,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  SPACE_ROLE_NONE,
  WALL_RAIL,
} from '../mapTypes.js'
import {
  analyzeLatticeDescriptor,
  compareLatticeEdges,
  latticeHorizontalCellKey,
  LATTICE_PLATFORM_FORMS,
} from './lattice.js'
import { lethalVoidHalfFromSlice } from './lethalVoid.js'
import { stampStructureVerticalLinks } from './stairStamp.js'

export function latticeChamberBounds(anchor) {
  const { radiusX, radiusZ } = LATTICE_PLATFORM_FORMS[anchor.platform ?? 'landing']
  return {
    x0: anchor.gx - radiusX,
    x1: anchor.gx + radiusX,
    z0: anchor.gz - radiusZ,
    z1: anchor.gz + radiusZ,
  }
}

// Every chunk in a district re-derives the same per-floor geometry and the
// same chunk-column slices (a floor's `structureUp` and the floor above's
// `structureDown` are the identical slice). Descriptors are frozen and the
// producers are pure, so cache per descriptor identity; entries die with the
// descriptor.
const FLOOR_GEOMETRY_CACHE = new WeakMap() // structure -> Map<levelCy, geometry>
const SLICE_CACHE = new WeakMap() // structure -> Map<'cx,cz,lowerCy', slice>
const LETHAL_VOID_CACHE = new WeakMap() // slice -> frozen lethal-void half
const STAIR_GUARD_CACHE = new WeakMap() // structure -> Map<levelCy, Set<edgeKey>>

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
  const cacheable = Object.isFrozen(structure)
  if (cacheable) {
    const cached = FLOOR_GEOMETRY_CACHE.get(structure)?.get(levelCy)
    if (cached) return cached
  }
  const geometry = computeLatticeFloorGeometry(structure, levelCy)
  if (cacheable) {
    let byLevel = FLOOR_GEOMETRY_CACHE.get(structure)
    if (!byLevel) {
      byLevel = new Map()
      FLOOR_GEOMETRY_CACHE.set(structure, byLevel)
    }
    byLevel.set(levelCy, geometry)
  }
  return geometry
}

function computeLatticeFloorGeometry(structure, levelCy) {
  const chamberCells = new Set()
  const edgeCells = new Set()
  const stairSafeCells = new Set()
  for (const anchor of structure.anchors) {
    if (anchor.levelCy !== levelCy) continue
    const bounds = latticeChamberBounds(anchor)
    for (let gz = bounds.z0; gz <= bounds.z1; gz++) {
      for (let gx = bounds.x0; gx <= bounds.x1; gx++) {
        addGlobalCell(
          chamberCells,
          structure.globalBounds,
          gx,
          gz
        )
      }
    }
  }
  for (const edge of structure.edges) {
    // The arterial spine walks two cells wide: the route hierarchy the road-
    // network research asks for (arterial skeleton first, minor spans off it)
    // becomes something the player can read underfoot instead of a hidden
    // role tag. Minor bridges stay one cell — the exposed-catwalk register.
    const widen = edge.role === 'spine'
    const sameFloor = widen
      ? edge.cells.filter((cell) => cell.cy === levelCy)
      : null
    for (const cell of edge.cells) {
      if (cell.cy !== levelCy) continue
      edgeCells.add(latticeHorizontalCellKey(cell.gx, cell.gz))
      if (!widen) continue
      const alongX = sameFloor.some((other) =>
        other.gz === cell.gz && Math.abs(other.gx - cell.gx) === 1
      )
      addGlobalCell(
        edgeCells,
        structure.globalBounds,
        alongX ? cell.gx : cell.gx + 1,
        alongX ? cell.gz + 1 : cell.gz
      )
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

  let byKey = SLICE_CACHE.get(structure)
  if (!byKey) {
    byKey = new Map()
    SLICE_CACHE.set(structure, byKey)
  }
  const sliceKey = `${cx},${cz},${lowerCy}`
  const cached = byKey.get(sliceKey)
  if (cached) return cached

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
  const slice = deepFreeze({
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
  byKey.set(sliceKey, slice)
  return slice
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
      // The office fabric's elected roles die with the fabric: a lattice deck
      // is never a named room, and stale role bytes would leak into dressing
      // and debug reads that trust "roles only ride CELL_ROOM".
      data.spaceRole[cIdx(lx, lz)] = SPACE_ROLE_NONE
      // The band's bottom floor is STREET LEVEL: the slab below it is intact
      // (no lower slice, no lethal half), so unretained cells there are real
      // walkable ground under the catwalk canopy, not a fenced fake void.
      data.cellKind[cIdx(lx, lz)] = geometry.chamberCells.has(key) ||
        geometry.stairSafeCells.has(key)
        ? CELL_ATRIUM
        : geometry.edgeCells.has(key)
          ? CELL_BRIDGE
          : data.cy === structure.baseCy ? CELL_OPEN : CELL_VOID
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

// The cell on the far side of a chamber-perimeter edge from the anchor.
function perimeterOutsideCell(anchor, edge) {
  if (edge.axis === 'v') {
    return { gx: edge.gx < anchor.gx ? edge.gx - 1 : edge.gx, gz: edge.gz }
  }
  return { gx: edge.gx, gz: edge.gz < anchor.gz ? edge.gz - 1 : edge.gz }
}

// The stair's far wall at the lower ramp and back wall above its landing are
// safety boundaries, even when a large platform's perimeter crosses them.
// A halo is retained floor, not permission to walk through those boundaries.
function latticeStairGuardEdges(structure, levelCy) {
  const cached = STAIR_GUARD_CACHE.get(structure)?.get(levelCy)
  if (cached) return cached
  const guards = new Set()
  for (const link of structure.verticalLinks) {
    const lower = levelCy === link.lowerCy
    if (!lower && levelCy !== link.lowerCy + 1) continue
    const stair = link.stair
    const alongX = stair.dir === 1 || stair.dir === 3
    const gx = (cell) => link.cx * CHUNK + cell.lx
    const gz = (cell) => link.cz * CHUNK + cell.lz
    for (const cell of lower ? [stair.landing, ...stair.run] : stair.run) {
      if (alongX) {
        guards.add(`h:${gx(cell)},${gz(cell)}`)
        guards.add(`h:${gx(cell)},${gz(cell) + 1}`)
      } else {
        guards.add(`v:${gx(cell)},${gz(cell)}`)
        guards.add(`v:${gx(cell) + 1},${gz(cell)}`)
      }
    }
    const [a, b] = lower ? [stair.run.at(-1), stair.exit] : [stair.landing, stair.run[0]]
    guards.add(alongX
      ? `v:${Math.max(gx(a), gx(b))},${gz(a)}`
      : `h:${gx(a)},${Math.max(gz(a), gz(b))}`)
  }
  if (Object.isFrozen(structure)) {
    let byLevel = STAIR_GUARD_CACHE.get(structure)
    if (!byLevel) {
      byLevel = new Map()
      STAIR_GUARD_CACHE.set(structure, byLevel)
    }
    byLevel.set(levelCy, guards)
  }
  return guards
}

// Open the full width of each incident deck and stair halo at the platform
// edge. A broad junction landing therefore joins narrow branches and the wide
// arterial spine without turning its decorative cue rails into a barrier.
export function latticeChamberApproaches(structure, anchor) {
  const approaches = new Set()
  const geometry = latticeFloorGeometry(structure, anchor.levelCy)
  const guards = latticeStairGuardEdges(structure, anchor.levelCy)
  for (const side of latticeChamberPerimeter(anchor)) {
    for (const edge of side) {
      if (guards.has(`${edge.axis}:${edge.gx},${edge.gz}`)) continue
      const outside = perimeterOutsideCell(anchor, edge)
      const key = latticeHorizontalCellKey(outside.gx, outside.gz)
      if (geometry.edgeCells.has(key) || geometry.stairSafeCells.has(key)) {
        approaches.add(`${edge.axis}:${edge.gx},${edge.gz}`)
      }
    }
  }
  return approaches
}

export function latticeChamberPerimeter(anchor) {
  const { x0, z0, x1, z1 } = latticeChamberBounds(anchor)
  return [
    Array.from({ length: x1 - x0 + 1 }, (_, offset) => ({
      axis: 'h', gx: x0 + offset, gz: z0,
    })),
    Array.from({ length: z1 - z0 + 1 }, (_, offset) => ({
      axis: 'v', gx: x1 + 1, gz: z0 + offset,
    })),
    Array.from({ length: x1 - x0 + 1 }, (_, offset) => ({
      axis: 'h', gx: x0 + offset, gz: z1 + 1,
    })),
    Array.from({ length: z1 - z0 + 1 }, (_, offset) => ({
      axis: 'v', gx: x0, gz: z0 + offset,
    })),
  ]
}

// Rails remain the chamber cue source even when a retained stair halo surrounds
// an anchor. Only canonical bridge/stair approach cells stay open; no plain-wall
// room perimeter is introduced.
function stampChamberCueRails(data, structure) {
  const chunkGx = data.cx * CHUNK
  const chunkGz = data.cz * CHUNK
  const guards = latticeStairGuardEdges(structure, data.cy)
  for (const anchor of structure.anchors) {
    if (anchor.levelCy !== data.cy) continue
    const approaches = latticeChamberApproaches(structure, anchor)
    const perimeter = latticeChamberPerimeter(anchor)
    for (const side of perimeter) {
      for (const edge of side) {
        const key = `${edge.axis}:${edge.gx},${edge.gz}`
        if (approaches.has(key) || guards.has(key)) continue
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
  const cached = LETHAL_VOID_CACHE.get(slice)
  if (cached) return cached
  const half = computeLethalVoidHalf(structure, slice, profile, cx, cz)
  if (half) LETHAL_VOID_CACHE.set(slice, half)
  return half
}

function computeLethalVoidHalf(structure, slice, profile, cx, cz) {
  const anchors = structure.anchors.filter(
    (anchor) => anchor.levelCy === slice.levelCy
  )
  if (anchors.length === 0) return null
  const chunkGx = cx * CHUNK
  const chunkGz = cz * CHUNK
  return lethalVoidHalfFromSlice(structure, slice, (lx, lz) => {
    const nearest = latticeNearestAnchor(anchors, chunkGx + lx, chunkGz + lz)
    const exposureM = latticeEffectiveExposureM(nearest, profile)
    return Math.round((slice.levelCy * LAYER_H - exposureM) * 1000)
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
  // Street level needs no drop guards — every cell has ground. Rails fence
  // retained decks from lethal void only on the elevated floors.
  const elevated = data.cy > structure.baseCy
  if (elevated) stampRetainedBoundaryRails(data, geometry)

  data.structure = structure
  data.structureUp = data.cy < structure.topCy
    ? latticeStructureSlice(structure, data.cx, data.cz, data.cy, profile)
    : null
  data.structureDown = data.cy > structure.baseCy
    ? latticeStructureSlice(structure, data.cx, data.cz, data.cy - 1, profile)
    : null
  stampStructureVerticalLinks(data, structure)
  // Graph/chamber raster identity remains canonical when a stair halo overlaps
  // an owned bridge cell. The stair descriptor still owns holes, ramps, and
  // guards; CELL_STAIR/CELL_LOBBY remains only on halo cells outside the graph.
  restoreCanonicalGraphCellKinds(data, geometry)
  if (elevated) stampRetainedBoundaryRails(data, geometry)
  stampChamberCueRails(data, structure)
  data.lethalVoidUp = lethalVoidHalf(
    structure,
    data.structureUp,
    profile,
    data.cx,
    data.cz
  )
  data.lethalVoidDown = lethalVoidHalf(
    structure,
    data.structureDown,
    profile,
    data.cx,
    data.cz
  )
  return true
}
