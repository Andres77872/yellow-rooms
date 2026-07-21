import {
  CELL,
  CHUNK,
  THICK,
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
  BED_W,
  BED_D,
  NIGHTSTAND_W,
  WARDROBE_W,
  WARDROBE_D,
  TOILET_W,
  TOILET_D,
  SINK_W,
  SINK_D,
  TUB_W,
  TUB_D,
  COUNTER_W,
  COUNTER_D,
  STOVE_W,
  STOVE_D,
  FRIDGE_W,
  FRIDGE_D,
  TV_W,
  TV_D,
  ARMCHAIR_W,
  WASHER_W,
} from '../constants.js'
import { hash2i } from '../core/hash.js'
import { COLUMN_FURNITURE } from '../mapTypes.js'
import { countChunkComponents } from '../topology.js'
import {
  FURN_DESK,
  FURN_CHAIR,
  FURN_TABLE,
  FURN_CABINET,
  FURN_COPIER,
  FURN_COOLER,
  FURN_PLANT,
  FURN_RACK,
  FURN_SOFA,
  FURN_BOOKSHELF,
  FURN_WHITEBOARD,
  FURN_BED,
  FURN_NIGHTSTAND,
  FURN_WARDROBE,
  FURN_TOILET,
  FURN_SINK,
  FURN_TUB,
  FURN_COUNTER,
  FURN_STOVE,
  FURN_FRIDGE,
  FURN_TV,
  FURN_ARMCHAIR,
  FURN_WASHER,
  ORDINARY_BARE_CHANCE,
  ordinaryThemesFor,
  roomTypeFor,
} from './catalog.js'

// Furnishing grammars (v23) — the interpreter half of the room catalog.
// rooms/catalog.js declares WHAT a room type contains (anchor, whitelist, op
// program); this module knows HOW each op lands pieces: wall-hugging runs,
// conference islands, desk workstations, per-room accents. Placement stays
// anchor-first (the first `min` placements of a row are unconditional) and
// whitelist-strict by construction, because every piece comes from the
// type's own grammar.
//
// Every roll keys on either global cell coordinates or the district-stable
// space id, so two chunk slices of one seam-crossing room always make the
// same dice calls. The SIZE gates are the exception: they read the chunk
// slice (space.area is the slice's cell count), so a seam-crossing room
// applies minArea/maxTables/maxDesks per slice — a big room may grow a
// reading island in its large slice only.

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
export function cellEdges(data, x, z) {
  return [
    { wall: data.vAt(x, z), passage: data.passageVAt(x, z), dir: 3 }, // west
    { wall: x + 1 < CHUNK ? data.vAt(x + 1, z) : 1, passage: x + 1 < CHUNK ? data.passageVAt(x + 1, z) : 0, dir: 2 }, // east
    { wall: data.hAt(x, z), passage: data.passageHAt(x, z), dir: 1 }, // north
    { wall: z + 1 < CHUNK ? data.hAt(x, z + 1) : 1, passage: z + 1 < CHUNK ? data.passageHAt(x, z + 1) : 0, dir: 0 }, // south
  ]
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
  // Slice-local size gate: space.area counts THIS chunk slice's cells, so a
  // seam-crossing room may seat two tables in one slice and one in the other.
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
  // Slice-local size gate: the desk budget reads THIS chunk slice's area.
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

// Piece footprints (unrotated), exported for editor-side manual placement.
export const PIECE_DIMS = {
  [FURN_DESK]: [DESK_W, DESK_D],
  [FURN_CABINET]: [CABINET_W, CABINET_D],
  [FURN_COPIER]: [COPIER_W, COPIER_D],
  [FURN_COOLER]: [COOLER_W, COOLER_W],
  [FURN_PLANT]: [PLANT_W, PLANT_W],
  [FURN_RACK]: [RACK_W, RACK_D],
  [FURN_SOFA]: [SOFA_W, SOFA_D],
  [FURN_BOOKSHELF]: [BOOKSHELF_W, BOOKSHELF_D],
  [FURN_WHITEBOARD]: [WHITEBOARD_W, WHITEBOARD_D],
  [FURN_BED]: [BED_W, BED_D],
  [FURN_NIGHTSTAND]: [NIGHTSTAND_W, NIGHTSTAND_W],
  [FURN_WARDROBE]: [WARDROBE_W, WARDROBE_D],
  [FURN_TOILET]: [TOILET_W, TOILET_D],
  [FURN_SINK]: [SINK_W, SINK_D],
  [FURN_TUB]: [TUB_W, TUB_D],
  [FURN_COUNTER]: [COUNTER_W, COUNTER_D],
  [FURN_STOVE]: [STOVE_W, STOVE_D],
  [FURN_FRIDGE]: [FRIDGE_W, FRIDGE_D],
  [FURN_TV]: [TV_W, TV_D],
  [FURN_ARMCHAIR]: [ARMCHAIR_W, ARMCHAIR_W],
  [FURN_WASHER]: [WASHER_W, WASHER_W],
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

// Run one catalog grammar (an ordered op program) against a room slice.
function runGrammar(ctx, space, candidates, grammar) {
  for (const op of grammar) {
    switch (op.op) {
      case 'row':
        furnishRow(ctx, space, candidates, op.kind, {
          min: op.min,
          max: op.max,
          chance: op.chance,
          salt: FURN_SALT ^ op.salt,
        })
        break
      case 'conference':
        // Slice-local size gate: minArea compares against THIS chunk slice's
        // area — a seam-crossing room grows its island only in slices that
        // pass the gate themselves.
        if (!op.minArea || space.area >= op.minArea) {
          furnishConference(ctx, space, candidates)
        }
        break
      case 'workstations': {
        const placed = furnishWorkstations(ctx, space, candidates)
        // `ensure` backs the anchor guarantee: when no desk+chair pairing
        // fits the slice, a lone wall desk still marks the room as an office.
        if (!placed && op.ensure) {
          furnishRow(ctx, space, candidates, FURN_DESK, {
            min: 1,
            max: 1,
            chance: 1,
            salt: FURN_SALT ^ op.ensure.salt,
          })
        }
        break
      }
      case 'accent': {
        // ONE accent piece, elected per room — not one lottery per kind.
        const which = spaceRoll(FURN_SALT ^ 0xacce, space) < 0.5 ? 0 : 1
        furnishRow(ctx, space, candidates, op.kinds[which], {
          min: 0,
          max: 1,
          chance: op.chance,
          salt: FURN_SALT ^ op.salt,
        })
        break
      }
      default:
        throw new Error(`unknown furnishing grammar op: ${op.op}`)
    }
  }
}

// Role rooms are always furnished: the role IS the furnishing.
export function furnishRoleRoom(ctx, space, candidates, role) {
  const type = roomTypeFor(role)
  if (!type) return
  runGrammar(ctx, space, candidates, type.grammar)
}

// Ordinary rooms elect ONE coherent theme from their space id — a quarter stay
// bare (emptiness is pacing), the rest read as a workroom, a huddle space, a
// lounge corner, or an unlabelled stash. Each theme owns a strict piece set;
// the role-marker kinds (copier, rack, bookshelf, cooler...) never appear
// here. The theme SET is a family decision (catalog FAMILY_ORDINARY_THEMES):
// hotel ordinary rooms draw residential themes, everyone else keeps the
// office set byte-for-byte.
export function furnishOrdinaryRoom(ctx, space, candidates, family) {
  if (spaceRoll(FURN_SALT ^ 0xe3e7, space) < ORDINARY_BARE_CHANCE) return // bare
  // Theme election reads ONLY the space id — never slice-local size — so both
  // chunk slices of a seam-crossing room land in the same theme; the slice's
  // geometry then only scales how much of the theme fits.
  const t = spaceRoll(FURN_SALT ^ 0x7e3a, space)
  for (const theme of ordinaryThemesFor(family)) {
    if (t < theme.window) {
      runGrammar(ctx, space, candidates, theme.grammar)
      return
    }
  }
}
