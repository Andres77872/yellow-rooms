import { CELL, CHUNK, WORLD_GEN_VERSION, ZONE_OFFICE, chunkKey3, cIdx, vIdx, hIdx } from '../world/constants.js'
import { ChunkData } from '../world/ChunkData.js'
import {
  CELL_OPEN,
  CELL_ROOM,
  COLUMN_FURNITURE,
  MAP_FAMILY_OFFICE,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  SPACE_ROLE_NONE,
  WALL_PLAIN,
} from '../world/mapTypes.js'
import { generateChunk } from '../world/generate.js'
import { worldConfigForFamilyOrOffice } from '../world/mapFamily.js'
import { hashStr } from '../world/core/hash.js'

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

export function cloneChunkData(d) {
  const copy = new ChunkData(d.cx, d.cy, d.cz, d.zone, d.version, d.mapFamily)
  for (const f of RASTERS) copy[f].set(d[f])
  copy.lamps = d.lamps.map((l) => ({ ...l }))
  copy.furniture = d.furniture.map((f) => ({ ...f }))
  copy.exit = d.exit ? { ...d.exit } : null
  for (const f of CHUNK_DESCRIPTORS) copy[f] = d[f] // frozen/shared descriptors
  copy.repairs = { ...d.repairs }
  return copy
}

// A chunk that never diverged from freshly-constructed open fabric carries no
// information and is dropped from storage and saves.
export function isPristineChunk(d) {
  if (d.lamps.length || d.furniture.length || d.exit) return false
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

export class EditorMap {
  constructor({ name = 'untitled', family = MAP_FAMILY_OFFICE, seed = 0 } = {}) {
    this.meta = { name, family, seed: seed >>> 0, worldGenVersion: WORLD_GEN_VERSION }
    this.chunks = new Map() // chunkKey3 -> ChunkData
    this.rooms = [] // {id, cy, x0, z0, x1, z1, role, salt, door}
    this.nextRoomId = 1
    this._dirty = new Set()
    this._undo = []
    this._redo = []
    this._op = null
  }

  // --- chunk resolution -----------------------------------------------------

  chunkAt(cx, cy, cz) {
    return this.chunks.get(chunkKey3(cx, cy, cz)) ?? null
  }

  ensureChunk(cx, cy, cz) {
    const key = chunkKey3(cx, cy, cz)
    let d = this.chunks.get(key)
    if (!d) {
      d = new ChunkData(cx, cy, cz, ZONE_OFFICE, this.meta.worldGenVersion, this.meta.family)
      this.chunks.set(key, d)
      if (this._op && !this._op.snapshots.has(key)) this._op.snapshots.set(key, null)
    }
    return d
  }

  markDirty(cx, cy, cz) {
    this._dirty.add(chunkKey3(cx, cy, cz))
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
    }
    this._dirty.add(key)
    if (existing) return existing
    return create ? this.ensureChunk(cx, cy, cz) : null
  }

  // --- undo/redo ------------------------------------------------------------

  // One op = one undo step. Chunks touched between beginOp and endOp are
  // snapshotted once; the room list/meta are captured wholesale (they are
  // tiny). Nesting is allowed — inner begin/end pairs fold into the outer op,
  // so a drag stroke or a compound action lands as a single undo entry.
  beginOp() {
    if (!this._op) {
      this._op = {
        depth: 0,
        snapshots: new Map(),
        rooms: this.rooms.map((r) => ({ ...r, door: r.door ? { ...r.door } : null })),
        nextRoomId: this.nextRoomId,
      }
    }
    this._op.depth++
  }

  endOp() {
    const op = this._op
    if (!op) return
    if (--op.depth > 0) return
    this._op = null
    if (op.snapshots.size || this._roomsChanged(op.rooms) || op.nextRoomId !== this.nextRoomId) {
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
    }
    for (const [key, snap] of op.snapshots) {
      const current = this.chunks.get(key) ?? null
      inverse.snapshots.set(key, current ? cloneChunkData(current) : null)
      if (snap) this.chunks.set(key, cloneChunkData(snap))
      else this.chunks.delete(key)
      this._dirty.add(key)
    }
    this.rooms = op.rooms.map((r) => ({ ...r, door: r.door ? { ...r.door } : null }))
    this.nextRoomId = op.nextRoomId
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
  furnitureAt(gx, cy, gz) {
    const d = this.chunkAt(this.cellChunk(gx), cy, this.cellChunk(gz))
    if (!d) return null
    const lx = this.cellLocal(gx)
    const lz = this.cellLocal(gz)
    const rec = d.furniture.find((f) => f.lx === lx && f.lz === lz)
    return rec ? { rec, chunk: d } : null
  }

  addFurniture(gx, cy, gz, rec) {
    const d = this._touch(this.cellChunk(gx), cy, this.cellChunk(gz))
    const lx = this.cellLocal(gx)
    const lz = this.cellLocal(gz)
    const stored = { ...rec, lx, lz }
    d.furniture.push(stored)
    d.cols[cIdx(lx, lz)] = COLUMN_FURNITURE
    return stored
  }

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

  // Move a piece to another cell (possibly in another chunk); the precise
  // centre offset within the cell is preserved.
  moveFurniture(fromGx, cy, fromGz, toGx, toGz) {
    const found = this.furnitureAt(fromGx, cy, fromGz)
    if (!found) return null
    if (this.cellAt(toGx, cy, toGz).col) return null // occupied
    const { rec } = found
    const offX = rec.x - (rec.lx + 0.5) * CELL
    const offZ = rec.z - (rec.lz + 0.5) * CELL
    this.removeFurniture(fromGx, cy, fromGz)
    const lx = this.cellLocal(toGx)
    const lz = this.cellLocal(toGz)
    return this.addFurniture(toGx, cy, toGz, {
      ...rec,
      x: (lx + 0.5) * CELL + offX,
      z: (lz + 0.5) * CELL + offZ,
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
  // boolean to match generated lamps ({lx, lz, lit}).
  setLamp(gx, cy, gz, lit) {
    const d = this._touch(this.cellChunk(gx), cy, this.cellChunk(gz))
    const lx = this.cellLocal(gx)
    const lz = this.cellLocal(gz)
    const existing = d.lamps.find((l) => l.lx === lx && l.lz === lz)
    if (lit === null) {
      d.lamps = d.lamps.filter((l) => l !== existing)
    } else if (existing) {
      existing.lit = !!lit
    } else {
      d.lamps.push({ lx, lz, lit: !!lit })
    }
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
  bakeProcedural({ seedText = 'lobby', family = MAP_FAMILY_OFFICE, radius = 2, floors = [0] } = {}) {
    const { family: resolved, config } = worldConfigForFamilyOrOffice(family)
    const seed = hashStr(seedText)
    this.meta.family = resolved
    this.meta.seed = seed
    this.mutate(() => {
      for (const cy of floors) {
        for (let cz = -radius; cz <= radius; cz++) {
          for (let cx = -radius; cx <= radius; cx++) {
            this._touch(cx, cy, cz, false)
            const d = generateChunk(seed, cx, cy, cz, config)
            this.chunks.set(chunkKey3(cx, cy, cz), d)
            this._dirty.add(chunkKey3(cx, cy, cz))
          }
        }
      }
      this._liftBakedRooms(floors)
    })
    return { seed, config }
  }

  // Group baked CELL_ROOM cells by (cy, spaceId) into room records.
  _liftBakedRooms(floors) {
    const found = new Map() // `${cy}:${id}` -> record
    for (const d of this.chunks.values()) {
      if (!floors.includes(d.cy)) continue
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const i = cIdx(lx, lz)
          if (d.cellKind[i] !== CELL_ROOM || !d.spaceId[i]) continue
          const gx = d.cx * CHUNK + lx
          const gz = d.cz * CHUNK + lz
          const key = `${d.cy}:${d.spaceId[i]}`
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

  // Drop chunks that carry no information (post-erase cleanup).
  compact() {
    for (const [key, d] of this.chunks) {
      if (isPristineChunk(d)) this.chunks.delete(key)
    }
  }
}
