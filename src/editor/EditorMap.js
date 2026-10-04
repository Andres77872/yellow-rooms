import { CELL, CHUNK, WORLD_GEN_VERSION, ZONE_OFFICE, chunkKey3, cIdx, vIdx, hIdx } from '../world/constants.js'
import { ChunkData } from '../world/ChunkData.js'
import {
  CELL_OPEN,
  CELL_ROOM,
  COLUMN_FURNITURE,
  MAP_FAMILY_OFFICE,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  SPACE_CLASS_UNKNOWN,
  SPACE_ROLE_NONE,
  WALL_PLAIN,
} from '../world/mapTypes.js'
import { generateChunk } from '../world/generate.js'
import { worldConfigForFamilyOrOffice } from '../world/mapFamily.js'
import { hashStr } from '../world/core/hash.js'
import { cellRole } from '../world/surfaceSet.js'

// The editor's map document: a finite, mutable set of real ChunkData chunks
// plus first-class room records. Chunks materialize lazily as fully-open
// fabric when an edit first touches them; pristine chunks are never stored,
// so an empty map costs nothing and every document stays finite.
//
// All coordinates on this API are GLOBAL cell/edge coordinates (gx, gz) plus
// a floor index cy; the document resolves chunk ownership internally using
// the same seam rules as the game (a chunk owns its West lx=0 and North lz=0
// edge lines).

const RASTERS = [
  'wallV', 'wallH', 'passageV', 'passageH',
  'wallFeatureV', 'wallFeatureH', 'cols', 'cellKind', 'spaceId', 'spaceRole',
]

// Descriptor carriers preserved (but not authored) by the editor.
export const CHUNK_DESCRIPTORS = [
  'stairUp', 'stairDown', 'sewerDescriptor',
  'structure', 'structureUp', 'structureDown', 'lethalVoidUp', 'lethalVoidDown',
]

// A document chunk's seam ring (ChunkData.seam). The generator's ring reads
// the neighbours the generator would build, from its district plan; in a
// document the neighbours are whatever the author left there. So a document
// chunk reads the document's own West and North chunks on its storey
// instead: the same fields in the same format (zones/officePlan.js
// officeSeamRing), taken from their real cells. Its line-0 doorways and
// windows then classify from both sides, as they do in the game, and follow
// an edit of the cells across the line. The ring holds the document, never a
// generator config or plan. A neighbour of another family or world seed is
// not read: its cells name rooms by another family's rules and finish set,
// and in the game a ring never crosses a world. A hotel room number walks
// the document's cells past the chunk edge (plannedId, plannedClass), within
// the chunk's district, the way the game walks its plan; and a room a stamp
// partly cleared takes the role the rest of the room carries across the
// document's chunks of its district (plannedRole), as the game takes it from
// its plan (surfaceSet.js cellRole). The ring is rebuilt whenever the
// document changed since it was last read (EditorMap._revision), and on
// every read while an edit is still open. Every path a chunk enters a
// document goes through here: a bake, a catalog stamp's context fabric, a
// new open chunk, an undo or redo, a file load.
export function attachDocumentSeam(map, d) {
  let ring = null
  let revision = -1
  // The document chunk holding global cell (gx, gz) on d's storey, when it is
  // of d's world and district; else null (outside the plan's scope).
  const districtChunkAt = (gx, gz) => {
    const other = map.chunkAt(Math.floor(gx / CHUNK), d.cy, Math.floor(gz / CHUNK))
    return other && sameDistrict(d, other) ? other : null
  }
  const seam = {
    resolve() {
      if (map._op || revision !== map._revision) {
        ring = documentSeamRing(map, d)
        revision = map._op ? -1 : map._revision
      }
      return ring
    },
    plannedId(gx, gz) {
      const other = districtChunkAt(gx, gz)
      return other ? other.spaceId[cIdx(gx - other.cx * CHUNK, gz - other.cz * CHUNK)] : 0
    },
    plannedRole(gx, gz) {
      const other = districtChunkAt(gx, gz)
      const id = other ? other.spaceId[cIdx(gx - other.cx * CHUNK, gz - other.cz * CHUNK)] : 0
      return id ? documentRoomRole(map, d, id) : SPACE_ROLE_NONE
    },
    plannedClass(gx, gz) {
      const other = districtChunkAt(gx, gz)
      return other ? other.spaceClass[cIdx(gx - other.cx * CHUNK, gz - other.cz * CHUNK)] : SPACE_CLASS_UNKNOWN
    },
  }
  Object.defineProperty(d, 'seam', { value: seam, writable: true, enumerable: false, configurable: true })
  return d
}

// Chunks of one world (family and seed) — the only ones a ring reads — and
// of one district within it.
const sameWorld = (a, b) => a.mapFamily === b.mapFamily && (a.worldSeed >>> 0) === (b.worldSeed >>> 0)
const sameDistrict = (a, b) =>
  !!a.district && !!b.district && sameWorld(a, b) && a.district.dx === b.district.dx && a.district.dz === b.district.dz

// The role a room carries across the document's chunks of its district: the
// most common non-NONE role among its cells (ties to the lower byte, as
// surfaceSet.js reads one chunk). One table per district and storey, rebuilt
// when the document changed since it was built, and never kept while an
// edit is open.
function documentRoomRole(map, d, id) {
  if (map._roomRoles?.revision !== map._revision || map._op) map._roomRoles = { revision: map._op ? -1 : map._revision, tables: new Map() }
  const key = `${d.mapFamily}|${d.worldSeed >>> 0}|${d.cy}|${d.district.dx},${d.district.dz}`
  let table = map._roomRoles.tables.get(key)
  if (!table) {
    const counts = new Map()
    for (const c of map.chunks.values()) {
      if (c.cy !== d.cy || !sameDistrict(d, c)) continue
      for (let i = 0; i < CHUNK * CHUNK; i++) {
        const r = c.spaceRole[i]
        if (r === SPACE_ROLE_NONE || !c.spaceId[i]) continue
        let roles = counts.get(c.spaceId[i])
        if (!roles) counts.set(c.spaceId[i], (roles = new Map()))
        roles.set(r, (roles.get(r) ?? 0) + 1)
      }
    }
    table = new Map()
    for (const [space, roles] of counts) {
      let best = SPACE_ROLE_NONE
      let most = 0
      for (const [r, n] of roles) {
        if (n > most || (n === most && r < best)) {
          best = r
          most = n
        }
      }
      table.set(space, best)
    }
    map._roomRoles.tables.set(key, table)
  }
  return table.get(id) ?? SPACE_ROLE_NONE
}

// The planner fields of the document cells just across d's own West line
// (index z) and North line (CHUNK + x). A side is read only from a chunk the
// planner placed in a district: a hand-drawn chunk has no department to key
// a finish by, so its side stays unknown, as an unplanned neighbour is in
// the game; nor from a chunk of another world. No side is a district portal: the document holds the real far
// side of every line, so it is read even across a district line.
function documentSeamRing(map, d) {
  const ring = {
    id: new Uint32Array(2 * CHUNK),
    kind: new Uint8Array(2 * CHUNK),
    role: new Uint8Array(2 * CHUNK),
    cls: new Uint8Array(2 * CHUNK),
    hall: new Uint8Array(2 * CHUNK),
    west: null,
    north: null,
    portal: { w: false, n: false },
  }
  const fill = (n, base, cellOf) => {
    if (!n?.district || !d.district || !sameWorld(d, n)) return null
    for (let i = 0; i < CHUNK; i++) {
      const [x, z] = cellOf(i)
      const c = cIdx(x, z)
      const id = n.spaceId[c]
      ring.id[base + i] = id
      ring.kind[base + i] = n.cellKind[c]
      ring.role[base + i] = cellRole(n, x, z)
      ring.cls[base + i] = n.spaceClass[c]
      ring.hall[base + i] = id && n.structure?.id === id ? 1 : 0
    }
    return { dx: n.district.dx, dz: n.district.dz }
  }
  ring.west = fill(map.chunkAt(d.cx - 1, d.cy, d.cz), 0, (i) => [CHUNK - 1, i])
  ring.north = fill(map.chunkAt(d.cx, d.cy, d.cz - 1), CHUNK, (i) => [i, CHUNK - 1])
  return ring.west || ring.north ? ring : null
}

// Which chunks around a document chunk read it, by what they read, at their
// offsets (cx, cz). The East and South neighbours' rings read its last
// column and row. A hotel room number walks a room's run toward -x or -z
// (doorSchedule.js roomStart), so walks come in from the East (along its
// rows), from the South (up its columns), and from the South-East: that
// chunk's line-0 doors open into rooms of its West or North neighbour, and
// their walks run on up this chunk's last column or along its last row. A
// room a stamp partly cleared takes the role its other cells carry across
// the district (documentRoomRole), so every neighbour reads its roles.
const SEAM_READERS = Object.freeze({
  e: [[1, 0]],
  s: [[0, 1]],
  se: [[1, 1]],
  roles: [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]],
})
const SEAM_READER_OFFSETS = [...new Set(Object.values(SEAM_READERS).flat().map(String))].map((o) => o.split(',').map(Number))

// What each reader reads of chunk d, as one comparable string per reader
// (null when d is absent or has no district, which no reader reads). A
// ring cell is its planner fields, its role as the raw byte (what a role
// resolves from; an undo snapshot carries no ring to resolve with). A walk
// into the chunk is, per line, the space id at the edge and how far that id
// runs in.
function seamReads(d) {
  if (!d?.district) return null
  const head = `${d.mapFamily}|${d.worldSeed >>> 0}|${d.district.dx},${d.district.dz}|`
  const ringOf = (cellOf) => {
    let s = ''
    for (let i = 0; i < CHUNK; i++) {
      const [x, z] = cellOf(i)
      const c = cIdx(x, z)
      const id = d.spaceId[c]
      s += `${id},${d.cellKind[c]},${d.spaceRole[c]},${d.spaceClass[c]},${id && d.structure?.id === id ? 1 : 0};`
    }
    return s
  }
  const runOf = (cellOf) => {
    const id = d.spaceId[cIdx(...cellOf(0))]
    let n = 1
    while (n < CHUNK && d.spaceId[cIdx(...cellOf(n))] === id) n++
    return `${id}:${n};`
  }
  const runsOf = (cellOf) => {
    let s = ''
    for (let line = 0; line < CHUNK; line++) s += runOf((k) => cellOf(line, k))
    return s
  }
  let roles = ''
  for (let i = 0; i < CHUNK * CHUNK; i++) roles += `${d.spaceId[i]}:${d.spaceRole[i]};`
  return {
    e: head + ringOf((z) => [CHUNK - 1, z]) + runsOf((z, k) => [CHUNK - 1 - k, z]),
    s: head + ringOf((x) => [x, CHUNK - 1]) + runsOf((x, k) => [x, CHUNK - 1 - k]),
    se: head + runOf((k) => [CHUNK - 1, CHUNK - 1 - k]) + runOf((k) => [CHUNK - 1 - k, CHUNK - 1]),
    roles: head + roles,
  }
}

// The seam ring is never copied: a copy entering the document gets its own
// (attachDocumentSeam).
export function cloneChunkData(d) {
  const copy = new ChunkData(d.cx, d.cy, d.cz, d.zone, d.version, d.mapFamily)
  for (const f of RASTERS) copy[f].set(d[f])
  copy.lamps = d.lamps.map((l) => ({ ...l }))
  copy.furniture = d.furniture.map((f) => ({ ...f }))
  copy.exit = d.exit ? { ...d.exit } : null
  for (const f of CHUNK_DESCRIPTORS) copy[f] = d[f] // frozen/shared descriptors
  copy.repairs = { ...d.repairs }
  // Finish-schedule context (world/surfaceSet.js; the .yrmap finish section).
  if (d.spaceClass) copy.spaceClass.set(d.spaceClass)
  copy.district = d.district ? { ...d.district } : null
  copy.worldSeed = d.worldSeed ?? 0
  // Authored-kind extras (the .yrmap extras section).
  copy.levelLabel = d.levelLabel ?? null
  copy.authoredFeatures = !!d.authoredFeatures
  return copy
}

// A chunk that never diverged from freshly-constructed open fabric carries no
// information and is dropped from storage and saves.
export function isPristineChunk(d) {
  if (d.lamps.length || d.furniture.length || d.exit || d.levelLabel != null) return false
  for (const f of CHUNK_DESCRIPTORS) if (d[f]) return false
  for (let i = 0; i < CHUNK * CHUNK; i++) {
    if (d.wallV[i] || d.wallH[i]) return false
    if (d.passageV[i] !== PASSAGE_OPEN || d.passageH[i] !== PASSAGE_OPEN) return false
    if (d.wallFeatureV[i] !== WALL_PLAIN || d.wallFeatureH[i] !== WALL_PLAIN) return false
    if (d.cols[i] || d.spaceId[i] || d.spaceRole[i]) return false
    if (d.cellKind[i] !== CELL_OPEN) return false
  }
  return true
}

const UNDO_CAP = 64

// World seed from the author's seed text, as the game derives it (hashStr),
// except `#<uint32>` which names a numeric seed directly — how the editor
// continues a loaded document whose original seed text is not stored.
export function seedFromText(text) {
  const match = /^#(\d+)$/.exec(String(text ?? '').trim())
  return match ? Number(match[1]) >>> 0 : hashStr(String(text ?? ''))
}

export class EditorMap {
  constructor({ name = 'untitled', family = MAP_FAMILY_OFFICE, seed = 0, palette = null } = {}) {
    // `palette`: a render palette id (world/familyPalette.js MAP_PALETTES)
    // overriding the family's, or null. A render choice only: chunks keep
    // their family.
    this.meta = { name, family, seed: seed >>> 0, worldGenVersion: WORLD_GEN_VERSION, palette }
    this.chunks = new Map() // chunkKey3 -> ChunkData
    this.rooms = [] // {id, cy, x0, z0, x1, z1, role, salt, door}
    // Authored structures (editor/templates.js): {id, template, label,
    // baseCy, topCy, bounds, parts}. Their geometry lives in the chunks; the
    // record is what lists, focuses, audits and removes them.
    this.authored = []
    this.nextRoomId = 1
    this._dirty = new Set()
    this._undo = []
    this._redo = []
    this._op = null
    // Bumped by every change to the chunks; the seam rings rebuild on it.
    this._revision = 0
  }

  // --- chunk resolution -----------------------------------------------------

  chunkAt(cx, cy, cz) {
    return this.chunks.get(chunkKey3(cx, cy, cz)) ?? null
  }

  ensureChunk(cx, cy, cz) {
    const key = chunkKey3(cx, cy, cz)
    let d = this.chunks.get(key)
    if (!d) {
      d = attachDocumentSeam(this, new ChunkData(cx, cy, cz, ZONE_OFFICE, this.meta.worldGenVersion, this.meta.family))
      // A chunk drawn into a baked document is part of the same building:
      // its rooms take the finish schedule of the world the bake came from,
      // so a room drawn across a baked chunk keeps one finish.
      d.worldSeed = this.meta.seed
      this.chunks.set(key, d)
      this._revision++
      if (this._op && !this._op.snapshots.has(key)) this._op.snapshots.set(key, null)
    }
    return d
  }

  markDirty(cx, cy, cz) {
    this._dirty.add(chunkKey3(cx, cy, cz))
  }

  // A chunk's line-0 doorways read its West and North neighbours, and a hotel
  // room number can walk into any neighbour (attachDocumentSeam). When an
  // edit, undo or redo turns chunk (cx, cy, cz) from `before` into `after`,
  // re-mesh each neighbour whose reading of it changed.
  _markSeamReaders(cx, cy, cz, before, after) {
    const was = seamReads(before)
    const now = seamReads(after)
    for (const [reader, offsets] of Object.entries(SEAM_READERS)) {
      if (was?.[reader] === now?.[reader]) continue
      for (const [ox, oz] of offsets) this._markIfStored(cx + ox, cy, cz + oz)
    }
  }

  _markIfStored(cx, cy, cz) {
    const key = chunkKey3(cx, cy, cz)
    if (this.chunks.has(key)) this._dirty.add(key)
  }

  takeDirty() {
    const d = this._dirty
    this._dirty = new Set()
    return d
  }

  _touch(cx, cy, cz, create = true) {
    const key = chunkKey3(cx, cy, cz)
    const existing = this.chunks.get(key)
    if (this._op && !this._op.snapshots.has(key)) {
      this._op.snapshots.set(key, existing ? cloneChunkData(existing) : null)
    } else if (!this._op) {
      // Nothing records the chunk before an edit outside an op, so there is
      // nothing to compare: every neighbour that may read it re-meshes.
      for (const [ox, oz] of SEAM_READER_OFFSETS) this._markIfStored(cx + ox, cy, cz + oz)
    }
    this._revision++
    this._dirty.add(key)
    if (existing) return existing
    return create ? this.ensureChunk(cx, cy, cz) : null
  }

  // --- undo/redo ------------------------------------------------------------

  // One op = one undo step. Chunks touched between beginOp and endOp are
  // snapshotted once; the room list and meta are captured wholesale (they are
  // tiny) — a bake rewrites meta.seed/family, and undoing it must restore the
  // world the remaining chunks came from. Nesting is allowed — inner
  // begin/end pairs fold into the outer op, so a drag stroke or a compound
  // action lands as a single undo entry.
  beginOp() {
    if (!this._op) {
      this._op = {
        depth: 0,
        snapshots: new Map(),
        rooms: this.rooms.map((r) => ({ ...r, door: r.door ? { ...r.door } : null })),
        nextRoomId: this.nextRoomId,
        meta: { ...this.meta },
        authored: JSON.stringify(this.authored),
      }
    }
    this._op.depth++
  }

  endOp() {
    const op = this._op
    if (!op) return
    if (--op.depth > 0) return
    this._op = null
    // The op's edits landed after the chunks were touched.
    this._revision++
    for (const [key, snap] of op.snapshots) {
      const live = this.chunks.get(key) ?? null
      const d = live ?? snap
      if (d) this._markSeamReaders(d.cx, d.cy, d.cz, snap, live)
    }
    if (
      op.snapshots.size ||
      this._roomsChanged(op.rooms) ||
      op.nextRoomId !== this.nextRoomId ||
      op.meta.seed !== this.meta.seed ||
      op.meta.family !== this.meta.family ||
      op.meta.palette !== this.meta.palette ||
      op.authored !== JSON.stringify(this.authored)
    ) {
      this._undo.push(op)
      if (this._undo.length > UNDO_CAP) this._undo.shift()
      this._redo.length = 0
    }
  }

  // Wrap a user-level operation as one undo step.
  mutate(fn) {
    this.beginOp()
    try {
      return fn()
    } finally {
      this.endOp()
    }
  }

  _roomsChanged(before) {
    if (before.length !== this.rooms.length) return true
    return JSON.stringify(before) !== JSON.stringify(this.rooms)
  }

  _applyOp(op) {
    const inverse = {
      snapshots: new Map(),
      rooms: this.rooms.map((r) => ({ ...r, door: r.door ? { ...r.door } : null })),
      nextRoomId: this.nextRoomId,
      meta: { ...this.meta },
      authored: JSON.stringify(this.authored),
    }
    for (const [key, snap] of op.snapshots) {
      const current = this.chunks.get(key) ?? null
      inverse.snapshots.set(key, current ? cloneChunkData(current) : null)
      const restored = snap ? attachDocumentSeam(this, cloneChunkData(snap)) : null
      if (restored) this.chunks.set(key, restored)
      else this.chunks.delete(key)
      this._dirty.add(key)
      const d = restored ?? current
      if (d) this._markSeamReaders(d.cx, d.cy, d.cz, current, restored)
    }
    this._revision++
    this.rooms = op.rooms.map((r) => ({ ...r, door: r.door ? { ...r.door } : null }))
    this.nextRoomId = op.nextRoomId
    // The document name is not part of the undo history.
    if (op.meta) this.meta = { ...op.meta, name: this.meta.name }
    if (op.authored !== undefined) this.authored = JSON.parse(op.authored)
    return inverse
  }

  undo() {
    const op = this._undo.pop()
    if (!op) return false
    this._redo.push(this._applyOp(op))
    return true
  }

  redo() {
    const op = this._redo.pop()
    if (!op) return false
    this._undo.push(this._applyOp(op))
    return true
  }

  // --- global cell accessors ------------------------------------------------

  cellChunk(g) {
    return Math.floor(g / CHUNK)
  }

  cellLocal(g) {
    return g - Math.floor(g / CHUNK) * CHUNK
  }

  cellAt(gx, cy, gz) {
    const d = this.chunkAt(this.cellChunk(gx), cy, this.cellChunk(gz))
    if (!d) return { kind: CELL_OPEN, role: SPACE_ROLE_NONE, spaceId: 0, col: 0, chunk: null }
    const i = cIdx(this.cellLocal(gx), this.cellLocal(gz))
    return { kind: d.cellKind[i], role: d.spaceRole[i], spaceId: d.spaceId[i], col: d.cols[i], chunk: d }
  }

  setCell(gx, cy, gz, { kind, role, spaceId, col } = {}) {
    const d = this._touch(this.cellChunk(gx), cy, this.cellChunk(gz))
    const lx = this.cellLocal(gx)
    const lz = this.cellLocal(gz)
    const i = cIdx(lx, lz)
    if (kind !== undefined) d.cellKind[i] = kind
    if (role !== undefined) d.spaceRole[i] = role
    if (spaceId !== undefined) d.spaceId[i] = spaceId
    if (col !== undefined) d.setCol(lx, lz, col)
    return d
  }

  // --- global edge accessors ------------------------------------------------
  // Vertical edge: grid line gx (separating cells gx-1 | gx) at cell row gz.
  // Horizontal edge: grid line gz (separating rows gz-1 | gz) at cell col gx.
  // Owner: the chunk whose West/North line the edge lies on.

  wallVAt(gx, cy, gz) {
    const d = this.chunkAt(this.cellChunk(gx), cy, this.cellChunk(gz))
    if (!d) return { wall: 0, passage: PASSAGE_OPEN, feature: WALL_PLAIN }
    const i = vIdx(this.cellLocal(gx), this.cellLocal(gz))
    return { wall: d.wallV[i], passage: d.passageV[i], feature: d.wallFeatureV[i] }
  }

  wallHAt(gx, cy, gz) {
    const d = this.chunkAt(this.cellChunk(gx), cy, this.cellChunk(gz))
    if (!d) return { wall: 0, passage: PASSAGE_OPEN, feature: WALL_PLAIN }
    const i = hIdx(this.cellLocal(gx), this.cellLocal(gz))
    return { wall: d.wallH[i], passage: d.passageH[i], feature: d.wallFeatureH[i] }
  }

  setWallV(gx, cy, gz, wall, passage = wall ? PASSAGE_WALL : PASSAGE_OPEN, feature = WALL_PLAIN) {
    const d = this._touch(this.cellChunk(gx), cy, this.cellChunk(gz))
    d.setV(this.cellLocal(gx), this.cellLocal(gz), wall, passage, feature)
  }

  setWallH(gx, cy, gz, wall, passage = wall ? PASSAGE_WALL : PASSAGE_OPEN, feature = WALL_PLAIN) {
    const d = this._touch(this.cellChunk(gx), cy, this.cellChunk(gz))
    d.setH(this.cellLocal(gx), this.cellLocal(gz), wall, passage, feature)
  }

  // --- objects ---------------------------------------------------------------

  // Furniture records live on their owning chunk with chunk-local coords
  // (matching ChunkData.furniture). The editor addresses them by global cell.
  //
  // A cell may hold several records (a stacked cell): a showroom gondola is
  // four bookshelves back to back, a till two counters, and the world
  // furnisher can set a table on a counter or cooler cell. Each record keeps
  // its own centre and AABB; the cell carries one COLUMN_FURNITURE. The
  // editor treats a cell's records as one unit: select, move, rotate and
  // delete act on all of them.

  // Every record in the cell, in chunk order, as [{rec, chunk}] (empty when
  // the cell holds none).
  furnitureListAt(gx, cy, gz) {
    const d = this.chunkAt(this.cellChunk(gx), cy, this.cellChunk(gz))
    if (!d) return []
    const lx = this.cellLocal(gx)
    const lz = this.cellLocal(gz)
    const out = []
    for (const rec of d.furniture) if (rec.lx === lx && rec.lz === lz) out.push({ rec, chunk: d })
    return out
  }

  // The cell's FIRST record ({rec, chunk}) or null. Kept for callers that
  // only ask whether a cell is furnished or read a one-piece cell; on a
  // stacked cell the other records are only in furnitureListAt.
  furnitureAt(gx, cy, gz) {
    const d = this.chunkAt(this.cellChunk(gx), cy, this.cellChunk(gz))
    if (!d) return null
    const lx = this.cellLocal(gx)
    const lz = this.cellLocal(gz)
    const rec = d.furniture.find((f) => f.lx === lx && f.lz === lz)
    return rec ? { rec, chunk: d } : null
  }

  // Adds one more record to the cell (stacking onto any already there).
  addFurniture(gx, cy, gz, rec) {
    const d = this._touch(this.cellChunk(gx), cy, this.cellChunk(gz))
    const lx = this.cellLocal(gx)
    const lz = this.cellLocal(gz)
    const stored = { ...rec, lx, lz }
    d.furniture.push(stored)
    d.cols[cIdx(lx, lz)] = COLUMN_FURNITURE
    return stored
  }

  // Removes EVERY record in the cell and clears its furniture column: the
  // cell is free afterwards. True when anything was removed.
  removeFurniture(gx, cy, gz) {
    const found = this.furnitureAt(gx, cy, gz)
    if (!found) return false
    const { rec, chunk } = found
    this._touch(chunk.cx, cy, chunk.cz)
    const live = this.chunkAt(chunk.cx, cy, chunk.cz)
    live.furniture = live.furniture.filter((f) => f !== rec && (f.lx !== rec.lx || f.lz !== rec.lz))
    live.cols[cIdx(rec.lx, rec.lz)] = 0
    return true
  }

  // Move the cell's pieces — every record of a stacked cell — to another
  // cell (possibly in another chunk), each keeping its own centre offset
  // within the cell. Refused (null) when the source holds nothing or the
  // target cell is occupied; otherwise the stored records, in order. One
  // undo step (folds into an enclosing op).
  moveFurniture(fromGx, cy, fromGz, toGx, toGz) {
    const found = this.furnitureListAt(fromGx, cy, fromGz)
    if (!found.length) return null
    if (this.cellAt(toGx, cy, toGz).col) return null // occupied
    const lx = this.cellLocal(toGx)
    const lz = this.cellLocal(toGz)
    return this.mutate(() => {
      this.removeFurniture(fromGx, cy, fromGz)
      return found.map(({ rec }) => {
        const offX = rec.x - (rec.lx + 0.5) * CELL
        const offZ = rec.z - (rec.lz + 0.5) * CELL
        return this.addFurniture(toGx, cy, toGz, {
          ...rec,
          x: (lx + 0.5) * CELL + offX,
          z: (lz + 0.5) * CELL + offZ,
        })
      })
    })
  }

  lampAt(gx, cy, gz) {
    const d = this.chunkAt(this.cellChunk(gx), cy, this.cellChunk(gz))
    if (!d) return null
    const lx = this.cellLocal(gx)
    const lz = this.cellLocal(gz)
    const rec = d.lamps.find((l) => l.lx === lx && l.lz === lz)
    return rec ? { rec, chunk: d } : null
  }

  // lit: true/false toggles the tube; null removes the fixture. Stored as a
  // boolean to match generated lamps ({lx, lz, lit}). `tint` (0xRRGGBB,
  // multiplied into the lamp's light colour): undefined keeps the fixture's,
  // null removes it, a number sets it. An untinted lamp carries no `tint`
  // key, so its record (and the saved bytes) stay as before tints existed.
  setLamp(gx, cy, gz, lit, tint = undefined) {
    const d = this._touch(this.cellChunk(gx), cy, this.cellChunk(gz))
    const lx = this.cellLocal(gx)
    const lz = this.cellLocal(gz)
    const existing = d.lamps.find((l) => l.lx === lx && l.lz === lz)
    if (lit === null) {
      d.lamps = d.lamps.filter((l) => l !== existing)
      return
    }
    const rec = existing ?? { lx, lz, lit: !!lit }
    rec.lit = !!lit
    if (tint === null) delete rec.tint
    else if (tint !== undefined) rec.tint = tint >>> 0
    if (!existing) d.lamps.push(rec)
  }

  // --- rooms ----------------------------------------------------------------

  roomById(id) {
    return this.rooms.find((r) => r.id === id) ?? null
  }

  roomAt(gx, cy, gz) {
    return (
      this.rooms.find(
        (r) => r.cy === cy && gx >= r.x0 && gx <= r.x1 && gz >= r.z0 && gz <= r.z1
      ) ?? null
    )
  }

  // --- procedural start -----------------------------------------------------

  // Bake a procedurally generated box of chunks into the document. Chunks
  // become ordinary editable data; generated rooms are lifted into room
  // records (grouped by spaceId) so they can be regenerated or deleted.
  bakeProcedural({
    seedText = 'lobby',
    family = MAP_FAMILY_OFFICE,
    radius = 2,
    floors = [0],
    center = { cx: 0, cz: 0 },
  } = {}) {
    const coords = []
    for (const cy of floors) {
      for (let cz = center.cz - radius; cz <= center.cz + radius; cz++) {
        for (let cx = center.cx - radius; cx <= center.cx + radius; cx++) {
          coords.push({ cx, cy, cz })
        }
      }
    }
    return this.bakeChunks({ seed: seedFromText(seedText), family, coords })
  }

  // Replace the document chunks at `coords` with freshly generated ones as a
  // single undoable operation. Tall structures span many floors: callers that
  // bake a structure pass its complete participant volume so no slab half is
  // left without its partner.
  bakeChunks({ seed, family = this.meta.family, coords }) {
    const { family: resolved, config } = worldConfigForFamilyOrOffice(family)
    this.mutate(() => {
      // Inside the op, so undo restores the world the old chunks came from.
      // A baked world renders with its family's own palette: drop a kind's.
      this.meta.family = resolved
      this.meta.seed = seed >>> 0
      this.meta.palette = null
      const replaced = new Set()
      for (const { cx, cy, cz } of coords) {
        const key = chunkKey3(cx, cy, cz)
        if (replaced.has(key)) continue
        replaced.add(key)
        this._touch(cx, cy, cz, false)
        this.chunks.set(key, attachDocumentSeam(this, generateChunk(this.meta.seed, cx, cy, cz, config)))
        this._dirty.add(key)
      }
      this._dropRoomsIn(replaced)
      this._liftBakedRooms(new Set(coords.map((c) => c.cy)))
    })
    return { seed: this.meta.seed, config }
  }

  // Drop every chunk and room (one undoable step when called inside an op).
  clearAll() {
    for (const d of [...this.chunks.values()]) {
      this._touch(d.cx, d.cy, d.cz, false)
      this.chunks.delete(chunkKey3(d.cx, d.cy, d.cz))
    }
    this.rooms = []
    this.authored = []
  }

  // Room records whose cells were just overwritten by a bake no longer
  // describe the document; drop every room touching a replaced chunk.
  _dropRoomsIn(replacedKeys) {
    this.rooms = this.rooms.filter((r) => {
      for (let cz = this.cellChunk(r.z0); cz <= this.cellChunk(r.z1); cz++) {
        for (let cx = this.cellChunk(r.x0); cx <= this.cellChunk(r.x1); cx++) {
          if (replacedKeys.has(chunkKey3(cx, r.cy, cz))) return false
        }
      }
      return true
    })
  }

  // Group baked CELL_ROOM cells by (cy, spaceId) into room records. Baked
  // records are derived data: they are rebuilt from the rasters of every
  // chunk on the touched floors, while user-authored rooms (baked: false)
  // keep their records and their cells are never re-lifted as baked rooms.
  _liftBakedRooms(floors) {
    const floorSet = floors instanceof Set ? floors : new Set(floors)
    const authored = new Set(
      this.rooms.filter((r) => !r.baked).map((r) => `${r.cy}:${r.id}`)
    )
    this.rooms = this.rooms.filter((r) => !r.baked || !floorSet.has(r.cy))
    const found = new Map() // `${cy}:${id}` -> record
    for (const d of this.chunks.values()) {
      if (!floorSet.has(d.cy)) continue
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const i = cIdx(lx, lz)
          if (d.cellKind[i] !== CELL_ROOM || !d.spaceId[i]) continue
          const key = `${d.cy}:${d.spaceId[i]}`
          if (authored.has(key)) continue
          const gx = d.cx * CHUNK + lx
          const gz = d.cz * CHUNK + lz
          let r = found.get(key)
          if (!r) {
            r = {
              id: d.spaceId[i], cy: d.cy, x0: gx, z0: gz, x1: gx, z1: gz,
              role: d.spaceRole[i], salt: 0, door: null, baked: true,
            }
            found.set(key, r)
          }
          r.x0 = Math.min(r.x0, gx)
          r.z0 = Math.min(r.z0, gz)
          r.x1 = Math.max(r.x1, gx)
          r.z1 = Math.max(r.z1, gz)
        }
      }
    }
    for (const r of found.values()) this.rooms.push(r)
    this.rooms.sort((a, b) => a.cy - b.cy || a.z0 - b.z0 || a.x0 - b.x0)
  }

  // --- extents ---------------------------------------------------------------

  bounds() {
    if (!this.chunks.size) return null
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const d of this.chunks.values()) {
      x0 = Math.min(x0, d.cx); x1 = Math.max(x1, d.cx)
      z0 = Math.min(z0, d.cz); z1 = Math.max(z1, d.cz)
      y0 = Math.min(y0, d.cy); y1 = Math.max(y1, d.cy)
    }
    return { x0, z0, x1, z1, y0, y1 }
  }

  floors() {
    const set = new Set()
    for (const d of this.chunks.values()) set.add(d.cy)
    return [...set].sort((a, b) => a - b)
  }

  // Chunk count per stored floor, ascending.
  floorSummary() {
    const counts = new Map()
    for (const d of this.chunks.values()) counts.set(d.cy, (counts.get(d.cy) ?? 0) + 1)
    return [...counts].sort((a, b) => a[0] - b[0]).map(([cy, chunks]) => ({ cy, chunks }))
  }

  // Drop chunks that carry no information (post-erase cleanup).
  compact() {
    for (const [key, d] of this.chunks) {
      if (isPristineChunk(d)) {
        this.chunks.delete(key)
        this._revision++
      }
    }
  }
}
