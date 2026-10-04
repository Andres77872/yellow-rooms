import { CELL, CHUNK } from '../constants.js'
import {
  CELL_CORRIDOR,
  CELL_OPEN,
  CELL_ROOM,
  COLUMN_STANDARD,
  PASSAGE_DOOR,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  SPACE_ROLE_NONE,
  WALL_PLAIN,
  WALL_RAIL,
  WALL_WINDOW,
} from '../mapTypes.js'
import { hash3i } from '../core/hash.js'
import { PIECE_DIMS } from '../rooms/furnish.js'
import {
  PROP_BY_ID,
  PROP_CCTV,
  PROP_CORNER_SHELF,
  PROP_LIFEGUARD_CHAIR,
  PROP_MAILBOX,
  PROP_MASCOT,
  PROP_METRO_BENCH,
  PROP_STANDPIPE,
  PROP_TICKET_GATE,
} from '../props/index.js'

// The kind lab's floor-plan compiler (editor/prototypes.js and every kind
// under editor/kinds/), moved here from editor/kinds/floorPlan.js (which
// re-exports it) so the world's tile programs share the one implementation.
// A plan is a set of open cells, explicit edges, lamps,
// columns and pieces on one storey; `compile` writes it into a document as
// column-sealed fabric. The constants a kind needs are re-exported below, so
// a kind imports its whole vocabulary from this module.

export { CELL, CHUNK } from '../constants.js'
export {
  CELL_OPEN,
  CELL_ROOM,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_STAIR,
  CELL_ATRIUM,
  CELL_VOID,
  CELL_BRIDGE,
  PASSAGE_WALL,
  PASSAGE_OPEN,
  PASSAGE_DOOR,
  PASSAGE_WIDE,
  WALL_PLAIN,
  WALL_WINDOW,
  WALL_RAIL,
  COLUMN_NONE,
  COLUMN_STANDARD,
  COLUMN_MONUMENTAL,
  COLUMN_FURNITURE,
  SPACE_ROLE_NONE,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_COPY,
  SPACE_ROLE_ARCHIVE,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
  SPACE_ROLE_LIBRARY,
  SPACE_ROLE_OFFICE,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_BEDROOM,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LIVING,
  SPACE_ROLE_DINING,
  SPACE_ROLE_LAUNDRY,
} from '../mapTypes.js'
export { STAIR_N, STAIR_E, STAIR_S, STAIR_W, STAIR_DX, STAIR_DZ } from '../structures/slab.js'

export const FACING = { S: 0, N: 1, E: 2, W: 3 } // piece fronts: +z, −z, +x, −x
export const WALL_TO_FRONT = { N: FACING.S, S: FACING.N, W: FACING.E, E: FACING.W }
export const THICK = 0.16

// A kind's deterministic dice: r(a, b) is a uint32 from (seed, salt, a, b).
export const rng = (seed, salt) => (a, b = 0) => hash3i((seed ^ salt) | 0, a | 0, b | 0, 0x51) >>> 0

// Mirror tables: a reflection across x swaps the E/W fronts and walls,
// across z the N/S ones.
const MIRROR_FACING = {
  x: { [FACING.S]: FACING.S, [FACING.N]: FACING.N, [FACING.E]: FACING.W, [FACING.W]: FACING.E },
  z: { [FACING.S]: FACING.N, [FACING.N]: FACING.S, [FACING.E]: FACING.E, [FACING.W]: FACING.W },
}
const MIRROR_WALL = { x: { E: 'W', W: 'E' }, z: { N: 'S', S: 'N' } }
// Chiral pieces, whose reflection is a different facing rather than the
// flipped front. The corner shelf anchors in its back-left corner (S in the
// NW corner of its cell, E in SW, N in SE, W in NE: objects/furniture/
// frame.js) and is symmetric about its diagonal, so a reflection moves it to
// the mirrored corner: across x NW<->NE, SW<->SE; across z NW<->SW, NE<->SE.
const MIRROR_FACING_BY_KIND = {
  [PROP_CORNER_SHELF]: {
    x: { [FACING.S]: FACING.W, [FACING.W]: FACING.S, [FACING.E]: FACING.N, [FACING.N]: FACING.E },
    z: { [FACING.S]: FACING.E, [FACING.E]: FACING.S, [FACING.N]: FACING.W, [FACING.W]: FACING.N },
  },
}
// Pieces whose model is left-right asymmetric: flipping the front (or turning
// a chiral piece to another corner) cannot reflect them, so the copy would
// show the original turned round rather than its mirror image. The set holds
// the props whose shadow proxies sit off the model's axis (the standpipe's
// riser and hose cabinet, the ticket gate's cabinet and flap, the CCTV desk's
// end panel, pedestal and monitor stack), those whose fallback boxes keep
// a one-sided signature part (the metro bench's priority seat, the mascot's
// waving paw, the mailbox's raised flag) and those whose one-sided part is
// model-only (the lifeguard chair's ring buoy, hung on its right board:
// scripts/blender/packs/pool.py). mirror() refuses them; a kind places such
// a piece's reflected twin by hand.
export const MIRROR_UNSAFE = new Set([
  PROP_STANDPIPE,
  PROP_TICKET_GATE,
  PROP_CCTV,
  PROP_METRO_BENCH,
  PROP_MASCOT,
  PROP_MAILBOX,
  PROP_LIFEGUARD_CHAIR,
])

const ZERO = Object.freeze({ cx: 0, cy: 0, cz: 0 })

// A level plate prints up to four seven-segment glyphs (world/objects/
// dressing/notices.js); anything else would render blank.
const LABEL_GLYPHS = /^[0-9\-bACEFHLPUdrnoty ]{0,4}$/

// The chunk owning edge (axis, gx, gz) on storey cy: the one whose West
// (v) or North (h) line it lies on — the cell's own chunk either way.
const edgeOwner = (map, gx, cy, gz) => map.chunkAt(map.cellChunk(gx), cy, map.cellChunk(gz))

// --- floor plan compiler ------------------------------------------------------

export class FloorPlan {
  constructor(region) {
    this.region = region // global cells {x0, z0, x1, z1}
    this.cells = new Map() // 'gx,gz' -> {kind, spaceId, role}
    this.edges = new Map() // 'v|h:gx,gz' -> {wall, passage, feature}
    this.lamps = []
    this.pieces = []
    this.cols = []
  }

  open(gx, gz, kind = CELL_CORRIDOR, spaceId = 0, role = SPACE_ROLE_NONE) {
    this.cells.set(`${gx},${gz}`, { kind, spaceId, role })
  }

  rect(r, kind = CELL_CORRIDOR, spaceId = 0, role = SPACE_ROLE_NONE) {
    for (let gz = r.z0; gz <= r.z1; gz++) for (let gx = r.x0; gx <= r.x1; gx++) this.open(gx, gz, kind, spaceId, role)
  }

  has(gx, gz) {
    return this.cells.has(`${gx},${gz}`)
  }

  // `feature` (WALL_WINDOW / WALL_RAIL) only sticks on a walled edge, as in
  // ChunkData.setV/H; compile marks its chunk authoredFeatures for the audit.
  edge(axis, gx, gz, wall, passage, feature = WALL_PLAIN) {
    this.edges.set(`${axis}:${gx},${gz}`, { wall, passage, feature })
  }

  // A glazed wall (a window you can see through but not cross).
  window(axis, gx, gz) {
    this.edge(axis, gx, gz, 1, PASSAGE_WALL, WALL_WINDOW)
  }

  // A guard rail: walled for collision, open to the eye.
  rail(axis, gx, gz) {
    this.edge(axis, gx, gz, 1, PASSAGE_WALL, WALL_RAIL)
  }

  // A walled room with one or more openings: `doors` are {axis, gx, gz,
  // passage?} edges on its perimeter.
  room(r, { spaceId, role = SPACE_ROLE_NONE, doors = [], lamp = null }) {
    this.rect(r, CELL_ROOM, spaceId, role)
    for (let gz = r.z0; gz <= r.z1; gz++) {
      this.edge('v', r.x0, gz, 1, PASSAGE_WALL)
      this.edge('v', r.x1 + 1, gz, 1, PASSAGE_WALL)
    }
    for (let gx = r.x0; gx <= r.x1; gx++) {
      this.edge('h', gx, r.z0, 1, PASSAGE_WALL)
      this.edge('h', gx, r.z1 + 1, 1, PASSAGE_WALL)
    }
    for (const d of doors) this.edge(d.axis, d.gx, d.gz, 0, d.passage ?? PASSAGE_DOOR)
    if (lamp !== null) this.lamp(Math.floor((r.x0 + r.x1) / 2), Math.floor((r.z0 + r.z1) / 2), lamp)
  }

  // `tint` (0xRRGGBB) multiplies the lamp's light colour; null = untinted.
  lamp(gx, gz, lit = true, tint = null) {
    this.lamps.push({ gx, gz, lit, tint })
  }

  column(gx, gz) {
    this.cols.push({ gx, gz })
  }

  // A piece centred in its cell, or hugging the named wall (N/S/E/W) with
  // its front facing away from it.
  piece(gx, gz, kind, { wall = null, facing = FACING.S } = {}) {
    const front = wall ? WALL_TO_FRONT[wall] : facing
    this.pieces.push({ gx, gz, kind, front, wall })
  }

  // Copy everything inside `from` (cells, explicit edges with their
  // features, lamps, columns, pieces) to its reflection across grid line
  // `line`: axis 'x' sends cell gx to 2*line-1-gx and V-line gx to
  // 2*line-gx (axis 'z' likewise for rows and H-lines). Pieces flip their
  // front and hugged wall (chiral kinds turn to their mirrored corner,
  // MIRROR_FACING_BY_KIND); non-zero spaceIds shift by `spaceOffset` so a
  // mirrored room stays its own room. Everything is read before anything is
  // written, so `from` may straddle the line. A MIRROR_UNSAFE piece inside
  // `from` throws before anything is written. Returns the cells written.
  mirror({ axis, line, from, spaceOffset = 0 }) {
    if (axis !== 'x' && axis !== 'z') throw new Error(`FloorPlan.mirror: axis must be 'x' or 'z', got ${axis}`)
    const mx = axis === 'x'
    const cellX = (gx) => (mx ? 2 * line - 1 - gx : gx)
    const cellZ = (gz) => (mx ? gz : 2 * line - 1 - gz)
    const inside = (gx, gz) => gx >= from.x0 && gx <= from.x1 && gz >= from.z0 && gz <= from.z1
    const space = (id) => (id ? id + spaceOffset : 0)

    const cells = []
    for (const [key, c] of this.cells) {
      const [gx, gz] = key.split(',').map(Number)
      if (inside(gx, gz)) cells.push([cellX(gx), cellZ(gz), c])
    }
    const edges = []
    for (const [key, e] of this.edges) {
      const [ax, rest] = key.split(':')
      const [gx, gz] = rest.split(',').map(Number)
      // An edge belongs to `from` when it bounds one of its cells: V-lines
      // x0..x1+1 on rows z0..z1, H-lines z0..z1+1 on columns x0..x1.
      const v = ax === 'v'
      const inX = gx >= from.x0 && gx <= from.x1 + (v ? 1 : 0)
      const inZ = gz >= from.z0 && gz <= from.z1 + (v ? 0 : 1)
      if (!inX || !inZ) continue
      // Along the mirrored axis a V-line (x) or H-line (z) reflects as a
      // line, 2*line-g; the other orientation's coordinate there is a cell.
      if (mx) edges.push([ax, v ? 2 * line - gx : cellX(gx), gz, e])
      else edges.push([ax, gx, v ? cellZ(gz) : 2 * line - gz, e])
    }
    const lamps = this.lamps.filter((l) => inside(l.gx, l.gz))
    const cols = this.cols.filter((c) => inside(c.gx, c.gz))
    const pieces = this.pieces.filter((p) => inside(p.gx, p.gz))
    const odd = pieces.find((p) => MIRROR_UNSAFE.has(p.kind))
    if (odd) {
      const { key, name } = PROP_BY_ID[odd.kind]
      throw new Error(
        `FloorPlan.mirror: ${key} (${name}, kind ${odd.kind}) at ${odd.gx},${odd.gz} is left-right asymmetric; ` +
          'flipping its facing would not reflect it, so place its mirrored twin by hand'
      )
    }

    for (const [gx, gz, c] of cells) this.open(gx, gz, c.kind, space(c.spaceId), c.role)
    for (const [ax, gx, gz, e] of edges) this.edge(ax, gx, gz, e.wall, e.passage, e.feature)
    for (const l of lamps) this.lamp(cellX(l.gx), cellZ(l.gz), l.lit, l.tint)
    for (const c of cols) this.column(cellX(c.gx), cellZ(c.gz))
    for (const p of pieces) {
      this.pieces.push({
        gx: cellX(p.gx),
        gz: cellZ(p.gz),
        kind: p.kind,
        front: (MIRROR_FACING_BY_KIND[p.kind] ?? MIRROR_FACING)[axis][p.front],
        wall: p.wall ? (MIRROR_WALL[axis][p.wall] ?? p.wall) : p.wall,
      })
    }
    return cells.length
  }

  // Every cell of every chunk the region touches is written (unused cells
  // become mass), and an edge is written only where it borders the plan, so
  // compiling never materializes a stray neighbour chunk.
  compile(map, cy) {
    const x0 = Math.floor(this.region.x0 / CHUNK) * CHUNK
    const z0 = Math.floor(this.region.z0 / CHUNK) * CHUNK
    const x1 = (Math.floor(this.region.x1 / CHUNK) + 1) * CHUNK - 1
    const z1 = (Math.floor(this.region.z1 / CHUNK) + 1) * CHUNK - 1
    // Integer-indexed views of the plan over the compiled area grown by one
    // cell (every has() the edge pass asks), read once from the string-keyed
    // maps: a key counts only in its canonical `${gx},${gz}` spelling, so
    // each lookup answers exactly what the map lookup would.
    const ix0 = x0 - 1
    const iz0 = z0 - 1
    const iw = x1 - x0 + 3
    const ih = z1 - z0 + 3
    const at = (gx, gz) => (gz - iz0) * iw + (gx - ix0)
    const present = new Uint8Array(iw * ih)
    const cellOf = new Array(iw * ih)
    for (const [key, c] of this.cells) {
      const comma = key.indexOf(',')
      const gx = Number(key.slice(0, comma))
      const gz = Number(key.slice(comma + 1))
      if (!Number.isInteger(gx) || !Number.isInteger(gz) || gx < ix0 || gx >= ix0 + iw || gz < iz0 || gz >= iz0 + ih) continue
      if (`${gx},${gz}` !== key) continue
      present[at(gx, gz)] = 1
      cellOf[at(gx, gz)] = c
    }
    const edgeOf = [new Map(), new Map()] // [v, h]: at(gx, gz) -> explicit edge
    for (const [key, e] of this.edges) {
      const colon = key.indexOf(':')
      const axis = key.slice(0, colon)
      if (axis !== 'v' && axis !== 'h') continue
      const comma = key.indexOf(',', colon)
      const gx = Number(key.slice(colon + 1, comma))
      const gz = Number(key.slice(comma + 1))
      if (!Number.isInteger(gx) || !Number.isInteger(gz) || gx < ix0 || gx >= ix0 + iw || gz < iz0 || gz >= iz0 + ih) continue
      if (`${axis}:${gx},${gz}` !== key) continue
      edgeOf[axis === 'v' ? 0 : 1].set(at(gx, gz), e)
    }
    const has = (gx, gz) => present[at(gx, gz)] === 1
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const c = cellOf[at(gx, gz)]
        if (c) map.setCell(gx, cy, gz, { kind: c.kind, spaceId: c.spaceId, role: c.role, col: 0 })
        else map.setCell(gx, cy, gz, { kind: CELL_OPEN, spaceId: 0, role: SPACE_ROLE_NONE, col: COLUMN_STANDARD })
      }
    }
    const setEdge = (axis, gx, gz, a, b) => {
      const explicit = edgeOf[axis === 'v' ? 0 : 1].get(at(gx, gz))
      let wall
      let passage
      let feature = WALL_PLAIN
      if (!a && !b) {
        // Inside the mass: clear only lines this region's chunks own.
        const owner = axis === 'v' ? gx <= x1 : gz <= z1
        if (!owner) return
        ;[wall, passage] = [0, PASSAGE_OPEN]
      } else if (explicit) ({ wall, passage, feature } = explicit)
      else if (a && b) [wall, passage] = [0, PASSAGE_OPEN]
      else [wall, passage] = [1, PASSAGE_WALL]
      if (axis === 'v') map.setWallV(gx, cy, gz, wall, passage, feature)
      else map.setWallH(gx, cy, gz, wall, passage, feature)
      // A placed window or rail is deliberate: the audit's stray-feature rule
      // skips its chunk (world/audit.js strayWallFeatures).
      if (wall && feature !== WALL_PLAIN) edgeOwner(map, gx, cy, gz).authoredFeatures = true
    }
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1 + 1; gx++) setEdge('v', gx, gz, has(gx - 1, gz), has(gx, gz))
    }
    for (let gz = z0; gz <= z1 + 1; gz++) {
      for (let gx = x0; gx <= x1; gx++) setEdge('h', gx, gz, has(gx, gz - 1), has(gx, gz))
    }
    for (const { gx, gz } of this.cols) map.setCell(gx, cy, gz, { col: COLUMN_STANDARD })
    for (const { gx, gz, lit, tint } of this.lamps) map.setLamp(gx, cy, gz, lit, tint)
    for (const p of this.pieces) addPiece(map, cy, p)
  }
}

export function addPiece(map, cy, { gx, gz, kind, front, wall }) {
  if (map.cellAt(gx, cy, gz).col) return
  const [w0, d0] = PIECE_DIMS[kind] ?? [1, 1]
  const alongX = front === FACING.E || front === FACING.W
  const w = alongX ? d0 : w0
  const d = alongX ? w0 : d0
  let x = (map.cellLocal(gx) + 0.5) * CELL
  let z = (map.cellLocal(gz) + 0.5) * CELL
  if (wall) {
    const depth = alongX ? w : d
    const off = CELL / 2 - THICK / 2 - depth / 2 - 0.06
    if (wall === 'N') z -= off
    if (wall === 'S') z += off
    if (wall === 'W') x -= off
    if (wall === 'E') x += off
  }
  map.addFurniture(gx, cy, gz, { kind, x, z, w, d, facing: front })
}

// --- after-stamp touch-ups ----------------------------------------------------

// Write a window or rail on edge (axis 'v' | 'h', gx, gz) of storey cy after
// the stamps ran (compile would overwrite them): wall 1, PASSAGE_WALL and the
// feature, with the owning chunk marked authoredFeatures.
export function featureEdge(map, axis, gx, cy, gz, feature) {
  if (axis === 'v') map.setWallV(gx, cy, gz, 1, PASSAGE_WALL, feature)
  else map.setWallH(gx, cy, gz, 1, PASSAGE_WALL, feature)
  if (feature !== WALL_PLAIN) edgeOwner(map, gx, cy, gz).authoredFeatures = true
}

// Name storey cy on its level plates (≤ 4 seven-segment glyphs; null
// restores the storey number) on every existing chunk of that storey, or
// only chunk column (cx, cz). Returns the chunks labelled.
export function labelFloor(map, cy, label, { cx = null, cz = null } = {}) {
  if (label !== null && (typeof label !== 'string' || !LABEL_GLYPHS.test(label))) {
    throw new Error(`labelFloor: ${JSON.stringify(label)} is not ≤ 4 plate glyphs (0-9 - b A C E F H L P U d r n o t y, space)`)
  }
  // A tile canvas keys its chunks at GLOBAL coordinates and takes local ones
  // (map.origin, tiles/TileCanvas.js); a document has no origin (ZERO).
  const o = map.origin ?? ZERO
  const targets = [...map.chunks.values()].filter(
    (d) => d.cy === cy + o.cy && (cx === null || d.cx === cx + o.cx) && (cz === null || d.cz === cz + o.cz)
  )
  // _touch snapshots each chunk for undo before the label lands on it.
  for (const d of targets) map._touch(d.cx - o.cx, cy, d.cz - o.cz).levelLabel = label
  return targets.length
}
