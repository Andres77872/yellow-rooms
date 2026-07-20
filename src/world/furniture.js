import {
  CELL,
  CHUNK,
  THICK,
  ZONE_OFFICE,
  FURN_MARGIN,
  FURN_SALT,
  DESK_W,
  DESK_D,
  CHAIR_W,
  TABLE_W,
  TABLE_D,
  CABINET_W,
  CABINET_D,
  COPIER_W,
  COPIER_D,
  COOLER_W,
  PLANT_W,
  RACK_W,
  RACK_D,
  SOFA_W,
  SOFA_D,
  BOOKSHELF_W,
  BOOKSHELF_D,
  WHITEBOARD_W,
  WHITEBOARD_D,
  cIdx,
} from './constants.js'
import { hash2i } from './core/hash.js'
import {
  CELL_ROOM,
  COLUMN_FURNITURE,
  PASSAGE_DOOR,
  PASSAGE_WIDE,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_COPY,
  SPACE_ROLE_ARCHIVE,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
} from './mapTypes.js'
import { countChunkComponents } from './topology.js'

// Furniture placement (v15) — collision-real office furniture, deterministic
// per chunk from global coordinates. Every occupied cell enters the cols
// raster as COLUMN_FURNITURE, so enemies, minimaps, audits and placement
// queries treat it as blocked; the player sweeps the precise piece AABB in
// ChunkData.furniture instead of the coarse cell.
//
// Placement contract:
//   - office rooms only (CELL_ROOM cells of a real space);
//   - a 2-cell margin off chunk borders, so two chunks can never stamp
//     overlapping pieces of the same cross-seam room;
//   - never on doorway/mouth approach cells, lamps, columns, or slab holes;
//   - rooms are furnished SPARSELY (empty rooms are a feature of the genre);
//   - after stamping, the chunk's column-aware component count must equal the
//     pre-furniture baseline — pieces that would sever a room roll back in
//     reverse deterministic order. Office chunks skip topology repair, so this
//     local guarantee replaces it.

export const FURN_DESK = 1
export const FURN_CHAIR = 2
export const FURN_TABLE = 3
export const FURN_CABINET = 4
export const FURN_COPIER = 5
export const FURN_COOLER = 6
export const FURN_PLANT = 7
export const FURN_RACK = 8
export const FURN_SOFA = 9
export const FURN_BOOKSHELF = 10
export const FURN_WHITEBOARD = 11

// facing: the direction the piece fronts toward, 0=+z 1=-z 2=+x 3=-x.
const DIR = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
]

const roll = (salt, gx, gz) => hash2i(salt | 0, gx, gz) / 4294967296

// The four grid edges of a cell, as {passage, wall} byte readers.
function cellEdges(data, x, z) {
  return [
    { wall: data.vAt(x, z), passage: data.passageVAt(x, z), dir: 3 }, // west
    { wall: x + 1 < CHUNK ? data.vAt(x + 1, z) : 1, passage: x + 1 < CHUNK ? data.passageVAt(x + 1, z) : 0, dir: 2 }, // east
    { wall: data.hAt(x, z), passage: data.passageHAt(x, z), dir: 1 }, // north
    { wall: z + 1 < CHUNK ? data.hAt(x, z + 1) : 1, passage: z + 1 < CHUNK ? data.passageHAt(x, z + 1) : 0, dir: 0 }, // south
  ]
}

function isFreeCandidate(data, lampCells, x, z) {
  if (x < FURN_MARGIN || x >= CHUNK - FURN_MARGIN) return false
  if (z < FURN_MARGIN || z >= CHUNK - FURN_MARGIN) return false
  if (data.cellKind[cIdx(x, z)] !== CELL_ROOM) return false
  if (data.colAt(x, z)) return false
  if (data.hasFloorHole(x, z) || data.hasCeilHole(x, z)) return false
  if (lampCells.has(`${x},${z}`)) return false
  for (const e of cellEdges(data, x, z)) {
    if (e.passage === PASSAGE_DOOR || e.passage === PASSAGE_WIDE) return false
  }
  return true
}

// Piece centre hugging the cell's wall on side `dir` (the direction the piece
// FRONTS toward is opposite: away from the wall, into the room).
function wallHugCentre(x, z, dirFromWall, depth) {
  const [dx, dz] = DIR[dirFromWall]
  const off = CELL / 2 - THICK / 2 - depth / 2 - 0.06
  return [(x + 0.5) * CELL - dx * off, (z + 0.5) * CELL - dz * off]
}

function addPiece(data, out, kind, x, z, facing, w, d, px, pz) {
  data.setCol(x, z, COLUMN_FURNITURE)
  const rec = { kind, lx: x, lz: z, x: px, z: pz, w, d, facing }
  data.furniture.push(rec)
  out.push(rec)
}

// Conference island: a table near the room's centre of mass, chairs facing it
// from the four adjacent cells. Each chair is rolled separately — an
// incomplete set (or a bare table) is exactly the abandoned-office read.
// Big rooms may elect a second table.
function furnishConference(data, space, candidates, added) {
  const key = [...candidates].sort((a, b) => a.gz - b.gz || a.gx - b.gx)
  const cx = (space.x0 + space.x1) / 2
  const cz = (space.z0 + space.z1) / 2
  const anchors = [...key].sort(
    (a, b) =>
      Math.abs(a.gx - cx) + Math.abs(a.gz - cz) - (Math.abs(b.gx - cx) + Math.abs(b.gz - cz))
  )
  const maxTables = space.area >= 26 && roll(FURN_SALT ^ 0x7a17, space.x0, space.z0) < 0.5 ? 2 : 1
  const used = new Set()
  let tables = 0
  for (const a of anchors) {
    if (tables >= maxTables) break
    if (used.has(`${a.gx},${a.gz}`)) continue
    if (roll(FURN_SALT ^ 0x7ab1, a.gx, a.gz) >= 0.8) continue
    const chairCells = []
    for (let dir = 0; dir < 4; dir++) {
      const [dx, dz] = DIR[dir]
      const n = { lx: a.lx + dx, lz: a.lz + dz, gx: a.gx + dx, gz: a.gz + dz }
      if (used.has(`${n.gx},${n.gz}`)) continue
      if (!candidates.some((c) => c.gx === n.gx && c.gz === n.gz)) continue
      // Sparse, independent chair rolls — no two tables seat the same set.
      if (roll(FURN_SALT ^ 0xc4a1, n.gx, n.gz) >= 0.55) continue
      // The chair fronts the table: the opposite of the direction it sits in.
      chairCells.push({ ...n, facing: dir ^ 1 })
    }
    addPiece(
      data, added, FURN_TABLE, a.lx, a.lz, 0,
      TABLE_W, TABLE_D, (a.lx + 0.5) * CELL, (a.lz + 0.5) * CELL
    )
    used.add(`${a.gx},${a.gz}`)
    tables++
    for (const ch of chairCells.slice(0, 4)) {
      const [dx, dz] = DIR[ch.facing]
      // Hug the boundary toward the table, facing it.
      const px = (ch.lx + 0.5) * CELL + dx * (CELL / 2 - CHAIR_W / 2 - 0.12)
      const pz = (ch.lz + 0.5) * CELL + dz * (CELL / 2 - CHAIR_W / 2 - 0.12)
      addPiece(data, added, FURN_CHAIR, ch.lx, ch.lz, ch.facing, CHAIR_W, CHAIR_W, px, pz)
      used.add(`${ch.gx},${ch.gz}`)
    }
  }
  return tables
}

// Workstations: desk hugging a wall, chair in front, up to two per room.
function furnishWorkstations(data, space, candidates, added) {
  const wallCells = []
  for (const c of candidates) {
    const edges = cellEdges(data, c.lx, c.lz)
    for (const e of edges) {
      if (e.wall !== 1) continue
      // The desk backs onto this wall and fronts the opposite way; the chair
      // sits in the neighbour cell the desk fronts toward.
      const front = e.dir ^ 1
      const [dx, dz] = DIR[front]
      const chair = candidates.find((o) => o.lx === c.lx + dx && o.lz === c.lz + dz)
      if (!chair) continue
      wallCells.push({ desk: c, chair, wallDir: e.dir, front })
      break
    }
  }
  wallCells.sort((a, b) => a.desk.gz - b.desk.gz || a.desk.gx - b.desk.gx)
  const maxDesks = space.area >= 12 ? 2 : 1
  const used = new Set()
  const usedDesks = []
  let placed = 0
  for (const w of wallCells) {
    if (placed >= maxDesks) break
    if (used.has(`${w.desk.gx},${w.desk.gz}`) || used.has(`${w.chair.gx},${w.chair.gz}`)) continue
    if (roll(FURN_SALT ^ 0xde5c, w.desk.gx, w.desk.gz) >= 0.68) continue
    // Keep workstations apart: no shared cells, no adjacent desk cells.
    if (usedDesks.some((o) => Math.abs(o.gx - w.desk.gx) + Math.abs(o.gz - w.desk.gz) < 3)) continue
    const [dx, dz] = DIR[w.front]
    const [dpx, dpz] = wallHugCentre(w.desk.lx, w.desk.lz, w.front, DESK_D)
    const alongX = dx !== 0
    addPiece(
      data, added, FURN_DESK, w.desk.lx, w.desk.lz, w.front,
      alongX ? DESK_D : DESK_W, alongX ? DESK_W : DESK_D, dpx, dpz
    )
    // Chair hugs the boundary toward the desk, facing it (toward the wall).
    const cpx = (w.chair.lx + 0.5) * CELL - dx * (CELL / 2 - CHAIR_W / 2 - 0.12)
    const cpz = (w.chair.lz + 0.5) * CELL - dz * (CELL / 2 - CHAIR_W / 2 - 0.12)
    addPiece(data, added, FURN_CHAIR, w.chair.lx, w.chair.lz, w.wallDir, CHAIR_W, CHAIR_W, cpx, cpz)
    used.add(`${w.desk.gx},${w.desk.gz}`)
    used.add(`${w.chair.gx},${w.chair.gz}`)
    usedDesks.push(w.desk)
    placed++
  }
  return placed
}

// Storage/utility pieces: cabinet, copier, water cooler, plant — sparse,
// wall-hugging, hash-selected so room grammar varies without a room-type tax.
const PIECE_DIMS = {
  [FURN_CABINET]: [CABINET_W, CABINET_D],
  [FURN_COPIER]: [COPIER_W, COPIER_D],
  [FURN_COOLER]: [COOLER_W, COOLER_W],
  [FURN_PLANT]: [PLANT_W, PLANT_W],
  [FURN_RACK]: [RACK_W, RACK_D],
  [FURN_SOFA]: [SOFA_W, SOFA_D],
  [FURN_BOOKSHELF]: [BOOKSHELF_W, BOOKSHELF_D],
  [FURN_WHITEBOARD]: [WHITEBOARD_W, WHITEBOARD_D],
}

// Wall-hugging placement of one piece kind across candidate wall cells.
function furnishRow(data, candidates, added, kind, maxPieces, chance, salt) {
  const wallCells = candidates
    .filter((c) => cellEdges(data, c.lx, c.lz).some((e) => e.wall === 1))
    .sort((a, b) => a.gz - b.gz || a.gx - b.gx)
  const usedCells = new Set(added.map((f) => `${f.lx},${f.lz}`))
  let placed = 0
  for (const c of wallCells) {
    if (placed >= maxPieces) break
    if (usedCells.has(`${c.lx},${c.lz}`)) continue
    if (roll(salt, c.gx, c.gz) >= chance) continue
    const edge = cellEdges(data, c.lx, c.lz).find((e) => e.wall === 1)
    const front = edge.dir ^ 1 // pieces back onto the wall, front into the room
    const [dx] = DIR[front]
    const alongX = dx !== 0
    const [w, d] = PIECE_DIMS[kind]
    const [px, pz] = wallHugCentre(c.lx, c.lz, front, d)
    addPiece(
      data, added, kind, c.lx, c.lz, front,
      alongX ? d : w, alongX ? w : d, px, pz
    )
    usedCells.add(`${c.lx},${c.lz}`)
    placed++
  }
  return placed
}

function furnishStorage(data, space, candidates, added) {
  const wallCells = candidates
    .filter((c) => cellEdges(data, c.lx, c.lz).some((e) => e.wall === 1))
    .sort((a, b) => a.gz - b.gz || a.gx - b.gx)
  const maxPieces = space.area >= 10 ? 2 : 1
  let placed = 0
  const usedCells = new Set(added.map((f) => `${f.lx},${f.lz}`))
  for (const c of wallCells) {
    if (placed >= maxPieces) break
    if (usedCells.has(`${c.lx},${c.lz}`)) continue
    const h = roll(FURN_SALT ^ 0x5709, c.gx, c.gz)
    if (h >= 0.3) continue
    const kind =
      h < 0.07 ? FURN_CABINET : h < 0.13 ? FURN_COPIER : h < 0.19 ? FURN_COOLER : FURN_PLANT
    const edge = cellEdges(data, c.lx, c.lz).find((e) => e.wall === 1)
    const front = edge.dir ^ 1 // pieces back onto the wall, front into the room
    const [dx] = DIR[front]
    const alongX = dx !== 0
    const [w, d] = PIECE_DIMS[kind]
    const [px, pz] = wallHugCentre(c.lx, c.lz, front, d)
    addPiece(
      data, added, kind, c.lx, c.lz, front,
      alongX ? d : w, alongX ? w : d, px, pz
    )
    usedCells.add(`${c.lx},${c.lz}`)
    placed++
  }
  return placed
}

// Break room: the water cooler is mandatory, then a sofa against a wall, a
// small table set and a cabinet or plant — the one place the office admits
// people were here.
function furnishBreak(data, space, candidates, added) {
  furnishRow(data, candidates, added, FURN_COOLER, 1, 1, FURN_SALT ^ 0xb3e9)
  furnishRow(data, candidates, added, FURN_SOFA, 1, 0.7, FURN_SALT ^ 0x50fa)
  if (space.area >= 8) furnishConference(data, space, candidates, added)
  furnishStorage(data, space, candidates, added)
}

// Role-driven composition (v15): the district plan's SPACE_ROLE_* elects the
// room's furnishing grammar directly; ordinary rooms keep the generic
// conference/workstation/storage mix above.
function furnishSpecial(data, space, candidates, added, role) {
  switch (role) {
    case SPACE_ROLE_MEETING: {
      const n0 = added.length
      furnishConference(data, space, candidates, added)
      if (added.length === n0) furnishWorkstations(data, space, candidates, added)
      // The whiteboard is the meeting room's wall landmark.
      furnishRow(data, candidates, added, FURN_WHITEBOARD, 1, 0.8, FURN_SALT ^ 0x9b1d)
      return
    }
    case SPACE_ROLE_BREAK:
      furnishBreak(data, space, candidates, added)
      return
    case SPACE_ROLE_COPY:
      furnishRow(data, candidates, added, FURN_COPIER, 3, 0.55, FURN_SALT ^ 0xc09c)
      furnishRow(data, candidates, added, FURN_CABINET, 1, 0.4, FURN_SALT ^ 0xc0b1)
      return
    case SPACE_ROLE_ARCHIVE:
      // Book rows with an occasional cabinet — the shelf wall is the read.
      furnishRow(data, candidates, added, FURN_BOOKSHELF, 4, 0.6, FURN_SALT ^ 0xb00c)
      furnishRow(data, candidates, added, FURN_CABINET, 1, 0.5, FURN_SALT ^ 0xa2c4)
      return
    case SPACE_ROLE_SERVER:
      furnishRow(data, candidates, added, FURN_RACK, 5, 0.6, FURN_SALT ^ 0x5e22)
      return
    case SPACE_ROLE_STORAGE:
      furnishRow(data, candidates, added, FURN_CABINET, 2, 0.55, FURN_SALT ^ 0x570a)
      furnishStorage(data, space, candidates, added)
      return
    default:
      return
  }
}

export function placeFurniture(data, ctx) {
  const { zone, config } = ctx
  if (zone !== ZONE_OFFICE || config.furniture?.enabled === false) return 0
  const baseline = countChunkComponents(data, true)
  const lampCells = new Set(data.lamps.map((l) => `${l.lx},${l.lz}`))

  // Group room cells by space id (chunk-local slice of the district plan).
  const spaces = new Map()
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      if (data.cellKind[cIdx(x, z)] !== CELL_ROOM) continue
      const id = data.spaceId[cIdx(x, z)]
      if (!id) continue
      if (!spaces.has(id)) spaces.set(id, { id, cells: [], x0: x, z0: z, x1: x, z1: z, area: 0 })
      const s = spaces.get(id)
      s.cells.push({ lx: x, lz: z, gx: data.cx * CHUNK + x, gz: data.cz * CHUNK + z })
      s.x0 = Math.min(s.x0, x)
      s.z0 = Math.min(s.z0, z)
      s.x1 = Math.max(s.x1, x)
      s.z1 = Math.max(s.z1, z)
      s.area++
    }
  }

  const added = []
  for (const space of [...spaces.values()].sort((a, b) => a.id - b.id)) {
    const candidates = space.cells.filter((c) => isFreeCandidate(data, lampCells, c.lx, c.lz))
    if (candidates.length < 3) continue
    const gx0 = data.cx * CHUNK + space.x0
    const gz0 = data.cz * CHUNK + space.z0
    const role = data.spaceRole[cIdx(space.cells[0].lx, space.cells[0].lz)]
    const before = added.length
    if (role) {
      // Special-role rooms are always furnished: the role IS the furnishing.
      furnishSpecial(data, space, candidates, added, role)
    } else {
      // Ordinary rooms: sparse furnishing — a quarter stay bare, emptiness is
      // pacing.
      if (roll(FURN_SALT ^ 0xe3e7, gx0, gz0) >= 0.25) {
        const w = space.x1 - space.x0 + 1
        const h = space.z1 - space.z0 + 1
        if (space.area >= 20 && w >= 4 && h >= 4) {
          if (furnishConference(data, space, candidates, added) === 0) {
            furnishWorkstations(data, space, candidates, added)
          }
        } else if (space.area >= 6) {
          furnishWorkstations(data, space, candidates, added)
        }
        furnishStorage(data, space, candidates, added)
      }
    }

    // Connectivity safeguard: if this space's pieces severed the chunk's
    // column-aware walk graph, roll them back newest-first until restored.
    while (added.length > before && countChunkComponents(data, true) > baseline) {
      const rec = added.pop()
      data.setCol(rec.lx, rec.lz, 0) // also drops the record from data.furniture
    }
  }
  return added.length
}
