import { CHUNK, cIdx, hIdx, vIdx } from '../../constants.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_VOID,
  COLUMN_MONUMENTAL,
  PASSAGE_DOOR,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  SPACE_ROLE_NONE,
  WALL_RAIL,
  WALL_WINDOW,
} from '../../mapTypes.js'
import { stampStructureVerticalLinks } from '../stairStamp.js'
import {
  CELL_CLASS_BRIDGE,
  CELL_CLASS_COLUMN,
  CELL_CLASS_RING,
  CELL_CLASS_SOLID,
  CELL_CLASS_VOID,
  catalogStructureSlice,
  coreDoor,
  inRect,
  isCatalogStructure,
  levelRaster,
} from './engine.js'

// Project one storey of a catalog structure into its participant chunk. Runs
// at the pipeline's structure stage (after zone topology and generic stairs,
// before lamps, furniture and the exit/spawn clearings):
//
//   1. carve footprint + ring open (monotone) and open the owned chunk seams
//      the carve spans, exactly like the office atrium stamp;
//   2. label cells (ring/gallery LOBBY, ground hall ATRIUM, VOID, BRIDGE) and
//      raise piers;
//   3. guard every walkable/void edge (rail, or glazing when the structure
//      asks for it; decks always get rails) — protected against later carves;
//   4. attach the descriptor and both slab slices;
//   5. stamp the structure's own flights (the canonical stair primitive);
//   6. enclose the core, if requested, with one door per storey;
//   7. make sure the ring reaches the chunk's walkable floor (sewer rock can
//      surround a footprint completely; carve the shortest approach).

const walkableClass = (c) => c === CELL_CLASS_RING || c === CELL_CLASS_SOLID || c === CELL_CLASS_BRIDGE

export function stampCatalogStructure(data, structure) {
  if (!isCatalogStructure(structure)) return false
  const k = data.cy - structure.baseCy
  if (k < 0 || k >= structure.levels.length) return false
  if (!structure.participants.some((p) => p.cx === data.cx && p.cz === data.cz)) return false

  const raster = levelRaster(structure, k)
  const { box } = raster
  const ox = data.cx * CHUNK
  const oz = data.cz * CHUNK
  const lx0 = Math.max(0, box.x0 - ox)
  const lz0 = Math.max(0, box.z0 - oz)
  const lx1 = Math.min(CHUNK - 1, box.x1 - ox)
  const lz1 = Math.min(CHUNK - 1, box.z1 - oz)
  const cls = (lx, lz) => raster.at(ox + lx, oz + lz)

  // 1. carve + owned seams inside the carve box.
  data.carveRect(lx0, lz0, lx1, lz1)
  for (let l = 0; l < CHUNK; l++) {
    if (inRect(box, ox - 1, oz + l) && inRect(box, ox, oz + l)) data.setProtectedV(0, l, 0, PASSAGE_WIDE)
    if (inRect(box, ox + l, oz - 1) && inRect(box, ox + l, oz)) data.setProtectedH(l, 0, 0, PASSAGE_WIDE)
  }

  // 2. cell kinds, ownership, piers.
  for (let lz = lz0; lz <= lz1; lz++) {
    for (let lx = lx0; lx <= lx1; lx++) {
      const i = cIdx(lx, lz)
      const c = cls(lx, lz)
      data.spaceRole[i] = SPACE_ROLE_NONE
      if (c === CELL_CLASS_RING) {
        data.cellKind[i] = CELL_LOBBY
        continue
      }
      data.spaceId[i] = structure.id
      if (c === CELL_CLASS_COLUMN) {
        data.cellKind[i] = k === 0 ? CELL_ATRIUM : CELL_LOBBY
        data.setCol(lx, lz, COLUMN_MONUMENTAL)
      } else if (c === CELL_CLASS_VOID) {
        data.cellKind[i] = CELL_VOID
      } else if (c === CELL_CLASS_BRIDGE) {
        data.cellKind[i] = CELL_BRIDGE
      } else {
        data.cellKind[i] = k === 0 ? CELL_ATRIUM : CELL_LOBBY
      }
    }
  }

  // 3. guards on every walkable/void edge of this storey.
  if (k > 0) {
    const glazing = structure.glazing === 'window' ? WALL_WINDOW : WALL_RAIL
    for (let lz = lz0; lz <= lz1; lz++) {
      for (let lx = lx0; lx <= lx1; lx++) {
        if (cls(lx, lz) !== CELL_CLASS_VOID) continue
        const guard = (nx, nz) => {
          const n = raster.at(ox + nx, oz + nz)
          if (!walkableClass(n) && n !== CELL_CLASS_COLUMN) return null
          return n === CELL_CLASS_BRIDGE ? WALL_RAIL : glazing
        }
        // Chunk-local lines only; seams never carry a void boundary.
        let f
        if (lx >= 1 && (f = guard(lx - 1, lz))) data.setProtectedV(lx, lz, 1, PASSAGE_WALL, f)
        if (lx + 1 <= CHUNK - 1 && (f = guard(lx + 1, lz))) data.setProtectedV(lx + 1, lz, 1, PASSAGE_WALL, f)
        if (lz >= 1 && (f = guard(lx, lz - 1))) data.setProtectedH(lx, lz, 1, PASSAGE_WALL, f)
        if (lz + 1 <= CHUNK - 1 && (f = guard(lx, lz + 1))) data.setProtectedH(lx, lz + 1, 1, PASSAGE_WALL, f)
      }
    }
  }

  // 4. descriptor + slab halves.
  const up = catalogStructureSlice(structure, data.cx, data.cz, data.cy)
  const down = catalogStructureSlice(structure, data.cx, data.cz, data.cy - 1)
  data.structure = structure
  data.structureUp = up.hasRoom ? up : null
  data.structureDown = down.hasRoom ? down : null

  // 5. the structure's own flights (halo carve first, guards second).
  stampStructureVerticalLinks(data, structure)

  // 6. core enclosure: plain walls round the core rect, one door per storey.
  const core = structure.core
  if (core?.enclosed) {
    const r = core.rect
    if (Math.floor(r.x0 / CHUNK) === data.cx && Math.floor(r.z0 / CHUNK) === data.cz) {
      const x0 = r.x0 - ox
      const z0 = r.z0 - oz
      const x1 = r.x1 - ox
      const z1 = r.z1 - oz
      for (let z = z0; z <= z1; z++) {
        data.setProtectedV(x0, z, 1, PASSAGE_WALL)
        data.setProtectedV(x1 + 1, z, 1, PASSAGE_WALL)
      }
      for (let x = x0; x <= x1; x++) {
        data.setProtectedH(x, z0, 1, PASSAGE_WALL)
        data.setProtectedH(x, z1 + 1, 1, PASSAGE_WALL)
      }
      const door = coreDoor(core)
      if (door.axis === 'h') data.setProtectedH(door.gx - ox, door.line - oz, 0, PASSAGE_DOOR)
      else data.setProtectedV(door.line - ox, door.gz - oz, 0, PASSAGE_DOOR)
    }
  }

  // 7. approach.
  ensureApproach(data, structure, raster)
  return true
}

// ---- approach -----------------------------------------------------------------

function stripRuns(data) {
  const out = new Set()
  for (const s of [data.stairUp, data.stairDown]) {
    if (!s) continue
    for (const c of s.run) out.add(cIdx(c.lx, c.lz))
  }
  return out
}

function stripCells(data) {
  const out = new Set()
  for (const s of [data.stairUp, data.stairDown]) {
    if (!s) continue
    for (const c of [s.landing, ...s.run, s.exit]) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) out.add(`${c.lx + dx},${c.lz + dz}`)
      }
    }
  }
  return out
}

const DX = [0, 1, 0, -1]
const DZ = [-1, 0, 1, 0]

function edgeOpen(data, ax, az, bx, bz) {
  if (bx !== ax) {
    const line = Math.max(ax, bx)
    return line >= 1 && line <= CHUNK - 1 && !data.wallV[vIdx(line, az)]
  }
  const line = Math.max(az, bz)
  return line >= 1 && line <= CHUNK - 1 && !data.wallH[hIdx(ax, line)]
}

// If the ring's walkable component (chunk-local, walls respected) touches no
// walkable cell outside the carve, open the shortest 4-connected corridor
// from the ring to the nearest walkable outside cell. Deterministic BFS
// order; never crosses stair strips/halos or owned border line 0.
function ensureApproach(data, structure, raster) {
  const { box } = raster
  const ox = data.cx * CHUNK
  const oz = data.cz * CHUNK
  const runs = stripRuns(data)
  const inCarve = (lx, lz) => inRect(box, ox + lx, oz + lz)
  const walkable = (lx, lz) => {
    const i = cIdx(lx, lz)
    return data.cols[i] === 0 && !data.hasFloorHole(lx, lz) && !runs.has(i)
  }
  const seen = new Uint8Array(CHUNK * CHUNK)
  const queue = []
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      if (raster.at(ox + lx, oz + lz) === CELL_CLASS_RING && walkable(lx, lz)) {
        seen[cIdx(lx, lz)] = 1
        queue.push(lx, lz)
      }
    }
  }
  if (!queue.length) return
  for (let q = 0; q < queue.length; q += 2) {
    const lx = queue[q]
    const lz = queue[q + 1]
    if (!inCarve(lx, lz)) return // already joined to the chunk's fabric
    for (let d = 0; d < 4; d++) {
      const nx = lx + DX[d]
      const nz = lz + DZ[d]
      if (nx < 0 || nz < 0 || nx >= CHUNK || nz >= CHUNK) continue
      const i = cIdx(nx, nz)
      if (seen[i] || !walkable(nx, nz) || !edgeOpen(data, lx, lz, nx, nz)) continue
      seen[i] = 1
      queue.push(nx, nz)
    }
  }
  // No fabric reached: BFS through anything outside the carve (ignoring
  // walls and rock) to the nearest walkable cell outside it.
  const blocked = stripCells(data)
  const prev = new Int16Array(CHUNK * CHUNK).fill(-1)
  const visited = new Uint8Array(CHUNK * CHUNK)
  const frontier = []
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      if (raster.at(ox + lx, oz + lz) === CELL_CLASS_RING && walkable(lx, lz)) {
        visited[cIdx(lx, lz)] = 1
        frontier.push(cIdx(lx, lz))
      }
    }
  }
  let goal = -1
  for (let q = 0; q < frontier.length && goal < 0; q++) {
    const i = frontier[q]
    const lx = i % CHUNK
    const lz = (i / CHUNK) | 0
    for (let d = 0; d < 4; d++) {
      const nx = lx + DX[d]
      const nz = lz + DZ[d]
      if (nx < 0 || nz < 0 || nx >= CHUNK || nz >= CHUNK) continue
      const j = cIdx(nx, nz)
      if (visited[j] || inCarve(nx, nz) || blocked.has(`${nx},${nz}`)) continue
      visited[j] = 1
      prev[j] = i
      if (walkable(nx, nz)) {
        goal = j
        break
      }
      frontier.push(j)
    }
  }
  if (goal < 0) return
  for (let j = goal; prev[j] >= 0; j = prev[j]) {
    const i = prev[j]
    const ax = i % CHUNK
    const az = (i / CHUNK) | 0
    const bx = j % CHUNK
    const bz = (j / CHUNK) | 0
    data.setCol(bx, bz, 0)
    if (j !== goal && !inCarve(bx, bz)) {
      data.cellKind[cIdx(bx, bz)] = CELL_CORRIDOR
      data.spaceRole[cIdx(bx, bz)] = SPACE_ROLE_NONE
    }
    if (bx !== ax) {
      const line = Math.max(ax, bx)
      if (!data._protV.has(vIdx(line, az))) data.setV(line, az, 0, PASSAGE_OPEN)
    } else {
      const line = Math.max(az, bz)
      if (!data._protH.has(hIdx(ax, line))) data.setH(ax, line, 0, PASSAGE_OPEN)
    }
  }
}
