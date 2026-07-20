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

// Furniture placement (v21) — collision-real office furniture, deterministic
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
//   - the chunk's column-aware component count must equal the pre-furniture
//     baseline at every step — each piece is verified at placement time and a
//     severing piece is refused (the grammar walks to the next cell). Office
//     chunks skip topology repair, so this local guarantee replaces it.
//
// Coherence contract (v21): every room furnishes from ONE grammar. Role rooms
// (the district plan's SPACE_ROLE_*) always receive their anchor pieces — a
// copy room HAS a copier, a meeting room HAS its table — and draw every other
// piece from the role's own whitelist. Ordinary rooms elect a theme (workroom,
// huddle, lounge, stash, or bare) from their district-stable space id, so a
// room split across a chunk seam makes the same call in every slice and the
// role-marker kinds (copier, rack, bookshelf, cooler) never leak into rooms
// that don't own the matching role.

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

// Room-level rolls key on the space's district-stable id, not on slice
// coordinates: both chunk slices of a seam-crossing room draw the same theme,
// the same bare/furnished verdict, the same accent kind.
const spaceRoll = (salt, space, k = 0) =>
  hash2i((salt | 0) ^ 0x2f0a, space.id | 0, k | 0) / 4294967296

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

// Commit one piece only if the chunk's column-aware walk graph survives it.
// The per-piece check (a single CHUNK² flood fill) replaces the old
// place-then-rollback pass: a piece that would sever its room is simply
// refused and the grammar walks on to the next candidate cell, so an anchor
// lands wherever ANY non-severing cell exists.
function addPiece(ctx, kind, x, z, facing, w, d, px, pz) {
  const { data, added, baseline } = ctx
  data.setCol(x, z, COLUMN_FURNITURE)
  if (countChunkComponents(data, true) > baseline) {
    data.setCol(x, z, 0)
    return false
  }
  const rec = { kind, lx: x, lz: z, x: px, z: pz, w, d, facing }
  data.furniture.push(rec)
  added.push(rec)
  return true
}

// Conference island: a table near the room's centre of mass, chairs facing it
// from the four adjacent cells. The FIRST table is the room's anchor and is
// never chance-gated; each chair is rolled separately — an incomplete set is
// exactly the abandoned-office read. Big rooms may elect a second table.
function furnishConference(ctx, space, candidates) {
  const key = [...candidates].sort((a, b) => a.gz - b.gz || a.gx - b.gx)
  const cx = (space.x0 + space.x1) / 2
  const cz = (space.z0 + space.z1) / 2
  const anchors = [...key].sort(
    (a, b) =>
      Math.abs(a.gx - cx) + Math.abs(a.gz - cz) - (Math.abs(b.gx - cx) + Math.abs(b.gz - cz))
  )
  const maxTables = space.area >= 26 && spaceRoll(FURN_SALT ^ 0x7a17, space) < 0.5 ? 2 : 1
  const used = new Set()
  let tables = 0
  for (const a of anchors) {
    if (tables >= maxTables) break
    if (used.has(`${a.gx},${a.gz}`)) continue
    if (tables >= 1 && roll(FURN_SALT ^ 0x7ab1, a.gx, a.gz) >= 0.8) continue
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
    if (!addPiece(
      ctx, FURN_TABLE, a.lx, a.lz, 0,
      TABLE_W, TABLE_D, (a.lx + 0.5) * CELL, (a.lz + 0.5) * CELL
    )) continue // severing anchor cell — the next-nearest anchor hosts it
    used.add(`${a.gx},${a.gz}`)
    tables++
    for (const ch of chairCells.slice(0, 4)) {
      const [dx, dz] = DIR[ch.facing]
      // Hug the boundary toward the table, facing it.
      const px = (ch.lx + 0.5) * CELL + dx * (CELL / 2 - CHAIR_W / 2 - 0.12)
      const pz = (ch.lz + 0.5) * CELL + dz * (CELL / 2 - CHAIR_W / 2 - 0.12)
      if (addPiece(ctx, FURN_CHAIR, ch.lx, ch.lz, ch.facing, CHAIR_W, CHAIR_W, px, pz)) {
        used.add(`${ch.gx},${ch.gz}`)
      }
    }
  }
  return tables
}

// Workstations: desk hugging a wall, chair in front, up to two per room. The
// first pairing is placed unconditionally — a workroom theme means desks, not
// a coin flip — later ones stay chance-gated.
function furnishWorkstations(ctx, space, candidates) {
  const { data } = ctx
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
    if (placed >= 1 && roll(FURN_SALT ^ 0xde5c, w.desk.gx, w.desk.gz) >= 0.68) continue
    // Keep workstations apart: no shared cells, no adjacent desk cells.
    if (usedDesks.some((o) => Math.abs(o.gx - w.desk.gx) + Math.abs(o.gz - w.desk.gz) < 3)) continue
    const [dx, dz] = DIR[w.front]
    const [dpx, dpz] = wallHugCentre(w.desk.lx, w.desk.lz, w.front, DESK_D)
    const alongX = dx !== 0
    if (!addPiece(
      ctx, FURN_DESK, w.desk.lx, w.desk.lz, w.front,
      alongX ? DESK_D : DESK_W, alongX ? DESK_W : DESK_D, dpx, dpz
    )) continue // severing desk cell — the next wall pairing hosts the station
    // Chair hugs the boundary toward the desk, facing it (toward the wall). A
    // desk whose chair is refused stays — an abandoned desk is a normal read.
    const cpx = (w.chair.lx + 0.5) * CELL - dx * (CELL / 2 - CHAIR_W / 2 - 0.12)
    const cpz = (w.chair.lz + 0.5) * CELL - dz * (CELL / 2 - CHAIR_W / 2 - 0.12)
    addPiece(ctx, FURN_CHAIR, w.chair.lx, w.chair.lz, w.wallDir, CHAIR_W, CHAIR_W, cpx, cpz)
    used.add(`${w.desk.gx},${w.desk.gz}`)
    used.add(`${w.chair.gx},${w.chair.gz}`)
    usedDesks.push(w.desk)
    placed++
  }
  return placed
}

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

// Wall-hugging run of one piece kind. The first `min` placements are the
// room's anchor furniture and are unconditional — a copy room WILL hold its
// copier; pieces beyond `min` are chance-gated per cell. The scan starts at a
// space-stable offset so where the anchor lands varies between rooms without
// diverging between two slices of the same room.
function furnishRow(ctx, space, candidates, kind, opts) {
  const { data } = ctx
  const { min = 0, max = 1, chance = 0.5, salt } = opts
  const wallCells = candidates
    .filter((c) => cellEdges(data, c.lx, c.lz).some((e) => e.wall === 1))
    .sort((a, b) => a.gz - b.gz || a.gx - b.gx)
  if (!wallCells.length) return 0
  const usedCells = new Set(ctx.added.map((f) => `${f.lx},${f.lz}`))
  const start = hash2i((salt ^ 0x51a7) | 0, space.id | 0, wallCells.length) % wallCells.length
  let placed = 0
  for (let n = 0; n < wallCells.length && placed < max; n++) {
    const c = wallCells[(start + n) % wallCells.length]
    if (usedCells.has(`${c.lx},${c.lz}`)) continue
    if (placed >= min && roll(salt, c.gx, c.gz) >= chance) continue
    const edge = cellEdges(data, c.lx, c.lz).find((e) => e.wall === 1)
    const front = edge.dir ^ 1 // pieces back onto the wall, front into the room
    const [dx] = DIR[front]
    const alongX = dx !== 0
    const [w, d] = PIECE_DIMS[kind]
    const [px, pz] = wallHugCentre(c.lx, c.lz, front, d)
    if (!addPiece(
      ctx, kind, c.lx, c.lz, front,
      alongX ? d : w, alongX ? w : d, px, pz
    )) continue // severing cell — the run continues along the wall
    usedCells.add(`${c.lx},${c.lz}`)
    placed++
  }
  return placed
}

// Break room: the water cooler and a sofa are the anchors, then a table set
// for bigger rooms and ONE accent piece (cabinet or plant, elected per room) —
// the one place the office admits people were here.
function furnishBreak(ctx, space, candidates) {
  furnishRow(ctx, space, candidates, FURN_COOLER, { min: 1, max: 1, chance: 1, salt: FURN_SALT ^ 0xb3e9 })
  furnishRow(ctx, space, candidates, FURN_SOFA, { min: 1, max: 1, chance: 1, salt: FURN_SALT ^ 0x50fa })
  if (space.area >= 8) furnishConference(ctx, space, candidates)
  const accent = spaceRoll(FURN_SALT ^ 0xacce, space) < 0.5 ? FURN_CABINET : FURN_PLANT
  furnishRow(ctx, space, candidates, accent, { max: 1, chance: 0.55, salt: FURN_SALT ^ 0x5709 })
}

// Role-driven composition: the district plan's SPACE_ROLE_* elects the room's
// furnishing grammar directly. Each grammar is anchor-first (the role's
// signature piece always lands) and whitelist-strict (no piece outside the
// role's set), so the wainscot band, the lighting register, and the furniture
// always tell the same story.
function furnishSpecial(ctx, space, candidates, role) {
  switch (role) {
    case SPACE_ROLE_MEETING:
      // The table is the anchor; the whiteboard is the wall landmark.
      furnishConference(ctx, space, candidates)
      furnishRow(ctx, space, candidates, FURN_WHITEBOARD, { min: 1, max: 1, chance: 1, salt: FURN_SALT ^ 0x9b1d })
      return
    case SPACE_ROLE_BREAK:
      furnishBreak(ctx, space, candidates)
      return
    case SPACE_ROLE_COPY:
      furnishRow(ctx, space, candidates, FURN_COPIER, { min: 1, max: 3, chance: 0.5, salt: FURN_SALT ^ 0xc09c })
      furnishRow(ctx, space, candidates, FURN_CABINET, { max: 1, chance: 0.4, salt: FURN_SALT ^ 0xc0b1 })
      return
    case SPACE_ROLE_ARCHIVE:
      // Book rows with an occasional cabinet — the shelf wall is the read.
      furnishRow(ctx, space, candidates, FURN_BOOKSHELF, { min: 2, max: 4, chance: 0.6, salt: FURN_SALT ^ 0xb00c })
      furnishRow(ctx, space, candidates, FURN_CABINET, { max: 1, chance: 0.5, salt: FURN_SALT ^ 0xa2c4 })
      return
    case SPACE_ROLE_SERVER:
      furnishRow(ctx, space, candidates, FURN_RACK, { min: 2, max: 5, chance: 0.6, salt: FURN_SALT ^ 0x5e22 })
      return
    case SPACE_ROLE_STORAGE:
      furnishRow(ctx, space, candidates, FURN_CABINET, { min: 1, max: 3, chance: 0.5, salt: FURN_SALT ^ 0x570a })
      return
    default:
      return
  }
}

// Ordinary rooms elect ONE coherent theme from their space id — a quarter stay
// bare (emptiness is pacing), the rest read as a workroom, a huddle space, a
// lounge corner, or an unlabelled stash. Each theme owns a strict piece set;
// the role-marker kinds (copier, rack, bookshelf, cooler) never appear here.
function furnishOrdinary(ctx, space, candidates) {
  if (spaceRoll(FURN_SALT ^ 0xe3e7, space) < 0.25) return // bare
  // Theme election reads ONLY the space id — never slice-local size — so both
  // chunk slices of a seam-crossing room land in the same theme; the slice's
  // geometry then only scales how much of the theme fits.
  const t = spaceRoll(FURN_SALT ^ 0x7e3a, space)
  if (t < 0.2) {
    // Huddle space: a conference island, sometimes a whiteboard.
    furnishConference(ctx, space, candidates)
    furnishRow(ctx, space, candidates, FURN_WHITEBOARD, { max: 1, chance: 0.3, salt: FURN_SALT ^ 0x9b1e })
    return
  }
  if (t < 0.6) {
    // Workroom: desk workstations, a filing cabinet, maybe a plant.
    furnishWorkstations(ctx, space, candidates)
    furnishRow(ctx, space, candidates, FURN_CABINET, { max: 1, chance: 0.35, salt: FURN_SALT ^ 0xf17e })
    furnishRow(ctx, space, candidates, FURN_PLANT, { max: 1, chance: 0.25, salt: FURN_SALT ^ 0x9147 })
    return
  }
  if (t < 0.8) {
    // Lounge corner: a sofa and something green.
    furnishRow(ctx, space, candidates, FURN_SOFA, { min: 1, max: 1, chance: 1, salt: FURN_SALT ^ 0x50fb })
    furnishRow(ctx, space, candidates, FURN_PLANT, { max: 1, chance: 0.6, salt: FURN_SALT ^ 0x9148 })
    return
  }
  // Stash: unlabelled storage — cabinets only.
  furnishRow(ctx, space, candidates, FURN_CABINET, { min: 1, max: 2, chance: 0.4, salt: FURN_SALT ^ 0x570b })
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

  const ctx2 = { data, added: [], baseline }
  for (const space of [...spaces.values()].sort((a, b) => a.id - b.id)) {
    const candidates = space.cells.filter((c) => isFreeCandidate(data, lampCells, c.lx, c.lz))
    if (candidates.length < 3) continue
    const role = data.spaceRole[cIdx(space.cells[0].lx, space.cells[0].lz)]
    if (role) {
      // Special-role rooms are always furnished: the role IS the furnishing.
      furnishSpecial(ctx2, space, candidates, role)
    } else {
      furnishOrdinary(ctx2, space, candidates)
    }
  }
  return ctx2.added.length
}
