import { CELL, CHUNK, WORLD_GEN_VERSION, ZONE_OFFICE, chunkKey3, cIdx, hIdx, vIdx } from '../constants.js'
import { ChunkData } from '../ChunkData.js'
import {
  CELL_OPEN,
  COLUMN_FURNITURE,
  COLUMN_STANDARD,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  SPACE_ROLE_NONE,
  WALL_PLAIN,
} from '../mapTypes.js'
import { CHUNK_DESCRIPTORS } from './cloneChunk.js'

// The document a family's tile program (its kind body) draws into when the
// world bakes a tile: the editor document's drawing API (editor/EditorMap.js)
// without undo, seam rings or dirty sets, at an ORIGIN.
//
// Coordinates on this API are kind-LOCAL, exactly as a kind sees a document:
// local chunk (cx, cy, cz) is global (cx + origin.cx, cy + origin.cy,
// cz + origin.cz), local cell gx is global gx + origin.cx·CHUNK. The chunks
// themselves carry GLOBAL coordinates and are keyed by them, so the baked
// slices drop straight into the world. With origin 0 and keep-all, a kind
// builds the same chunks here as on an EditorMap (canvas-parity test).
//
// `keep(gcx, gcy, gcz)` (GLOBAL chunk coordinates) says which chunks the bake
// keeps; every other chunk is scratch: written normally, dropped at export.
// A kept chunk nothing wrote (no setCell, setWall*, setLamp, furniture or
// kit stamp: e.g. one created only by _touch) exports as solid mass, never as
// default open fabric (cols 0). In a written kept chunk, every cell no
// setCell, furniture op or kit stamp covered is filled from that same solid
// chunk at export (its walls, lamps and records stay): a chunk reached only
// by a wall line (FloorPlan.compile writes the east/south line its neighbour
// owns) exports as mass behind the wall, not as open fabric.

const ZERO = Object.freeze({ cx: 0, cy: 0, cz: 0 })

// Solid mass, as tiles/solidChunk.js builds it for the world: every column
// standard, cells open, walls and passages at their defaults, nothing else.
// The canvas uses it until the bake passes the world's own (`solidChunk`).
export function massChunk(gcx, gcy, gcz, { version = WORLD_GEN_VERSION, family, worldSeed = 0, district = null } = {}) {
  const d = new ChunkData(gcx, gcy, gcz, ZONE_OFFICE, version, family)
  d.cols.fill(COLUMN_STANDARD)
  d.worldSeed = worldSeed >>> 0
  d.district = district ? { ...district } : null
  return d
}

// editor/EditorMap.js isPristineChunk (compact drops such chunks).
function isPristineChunk(d) {
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

export class TileCanvas {
  // family: the chunks' mapFamily (the liminal id); base: the table parent,
  // which is what a kind reads as meta.family (furnishing grammar), as the
  // editor kind runs under its base family. `solidChunk(gcx, gcy, gcz)`
  // builds an untouched kept chunk (default: massChunk).
  constructor({
    family,
    base = family,
    version = WORLD_GEN_VERSION,
    worldSeed = 0,
    origin = ZERO,
    keep = () => true,
    district = null,
    name = '',
    solidChunk = null,
  } = {}) {
    this.family = family
    this.base = base
    this.version = version
    this.worldSeed = worldSeed >>> 0
    this.origin = Object.freeze({ cx: origin.cx ?? 0, cy: origin.cy ?? 0, cz: origin.cz ?? 0 })
    this.keep = keep
    this.district = district ? { ...district } : null
    this.meta = { family: base, seed: this.worldSeed, worldGenVersion: version, name }
    this.chunks = new Map() // chunkKey3(GLOBAL) -> ChunkData
    this.rooms = []
    this.nextRoomId = 1
    this.stats = { scratchWalkableWrites: 0, chunksCreated: 0, untouchedKept: 0, massFilledCells: 0 }
    this._written = new Set() // chunkKey3(GLOBAL) of chunks a write reached
    this._stamped = new Set() // chunkKey3(GLOBAL) of chunks a kit stamp wrote whole
    this._covered = new Map() // chunkKey3(GLOBAL) -> Uint8Array: cells a cell write set
    this._kept = new Map() // chunkKey3(GLOBAL) -> keep() result (memo)
    this._solid = solidChunk
  }

  // No undo: an op is just the call.
  mutate(fn) {
    return fn()
  }

  // --- chunk resolution -----------------------------------------------------

  _key(cx, cy, cz) {
    const o = this.origin
    return chunkKey3(cx + o.cx, cy + o.cy, cz + o.cz)
  }

  _keptGlobal(gcx, gcy, gcz) {
    const key = chunkKey3(gcx, gcy, gcz)
    let kept = this._kept.get(key)
    if (kept === undefined) this._kept.set(key, (kept = !!this.keep(gcx, gcy, gcz)))
    return kept
  }

  isKeptLocal(cx, cy, cz) {
    const o = this.origin
    return this._keptGlobal(cx + o.cx, cy + o.cy, cz + o.cz)
  }

  chunkAt(cx, cy, cz) {
    return this.chunks.get(this._key(cx, cy, cz)) ?? null
  }

  ensureChunk(cx, cy, cz) {
    const key = this._key(cx, cy, cz)
    let d = this.chunks.get(key)
    if (!d) {
      const o = this.origin
      d = new ChunkData(cx + o.cx, cy + o.cy, cz + o.cz, ZONE_OFFICE, this.version, this.family)
      d.worldSeed = this.worldSeed
      if (this.district) d.district = { ...this.district }
      this.chunks.set(key, d)
      this.stats.chunksCreated++
    }
    return d
  }

  _touch(cx, cy, cz, create = true) {
    const existing = this.chunkAt(cx, cy, cz)
    if (existing) return existing
    return create ? this.ensureChunk(cx, cy, cz) : null
  }

  // The chunk at GLOBAL chunk coordinates (the kit stamps at true coordinates).
  globalChunk(gcx, gcy, gcz, create = true) {
    const o = this.origin
    return this._touch(gcx - o.cx, gcy - o.cy, gcz - o.cz, create)
  }

  // A kit stamp wrote chunk `d` directly: every cell of it is authored.
  markWritten(d) {
    const key = chunkKey3(d.cx, d.cy, d.cz)
    this._written.add(key)
    this._stamped.add(key)
  }

  // An edge or record write: the chunk is not untouched, no cell is covered.
  _markEdge(d) {
    this._written.add(chunkKey3(d.cx, d.cy, d.cz))
  }

  // A cell write: chunk-local cell (lx, lz) of `d` is authored.
  _markCell(d, lx, lz) {
    const key = chunkKey3(d.cx, d.cy, d.cz)
    this._written.add(key)
    let cover = this._covered.get(key)
    if (!cover) this._covered.set(key, (cover = new Uint8Array(CHUNK * CHUNK)))
    cover[cIdx(lx, lz)] = 1
  }

  // --- global cell accessors (kind-local cells) ------------------------------

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
    const cx = this.cellChunk(gx)
    const cz = this.cellChunk(gz)
    const d = this._touch(cx, cy, cz)
    const lx = this.cellLocal(gx)
    const lz = this.cellLocal(gz)
    const i = cIdx(lx, lz)
    if (kind !== undefined) d.cellKind[i] = kind
    if (role !== undefined) d.spaceRole[i] = role
    if (spaceId !== undefined) d.spaceId[i] = spaceId
    if (col !== undefined) d.setCol(lx, lz, col)
    this._markCell(d, lx, lz)
    if (d.cols[i] === 0 && !this.isKeptLocal(cx, cy, cz)) this.stats.scratchWalkableWrites++
    return d
  }

  // --- global edge accessors (kind-local lines) -------------------------------
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
    this._markEdge(d)
  }

  setWallH(gx, cy, gz, wall, passage = wall ? PASSAGE_WALL : PASSAGE_OPEN, feature = WALL_PLAIN) {
    const d = this._touch(this.cellChunk(gx), cy, this.cellChunk(gz))
    d.setH(this.cellLocal(gx), this.cellLocal(gz), wall, passage, feature)
    this._markEdge(d)
  }

  // --- objects ---------------------------------------------------------------
  // As EditorMap: records live on their owning chunk with chunk-local coords;
  // a cell may hold several (a stacked cell) under one COLUMN_FURNITURE.

  furnitureListAt(gx, cy, gz) {
    const d = this.chunkAt(this.cellChunk(gx), cy, this.cellChunk(gz))
    if (!d) return []
    const lx = this.cellLocal(gx)
    const lz = this.cellLocal(gz)
    const out = []
    for (const rec of d.furniture) if (rec.lx === lx && rec.lz === lz) out.push({ rec, chunk: d })
    return out
  }

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
    this._markCell(d, lx, lz)
    return stored
  }

  removeFurniture(gx, cy, gz) {
    const found = this.furnitureAt(gx, cy, gz)
    if (!found) return false
    const { rec, chunk } = found
    chunk.furniture = chunk.furniture.filter((f) => f !== rec && (f.lx !== rec.lx || f.lz !== rec.lz))
    chunk.cols[cIdx(rec.lx, rec.lz)] = 0
    this._markCell(chunk, rec.lx, rec.lz)
    return true
  }

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

  // lit: true/false toggles the tube; null removes the fixture. `tint`:
  // undefined keeps the fixture's, null removes it, a number sets it.
  setLamp(gx, cy, gz, lit, tint = undefined) {
    const d = this._touch(this.cellChunk(gx), cy, this.cellChunk(gz))
    const lx = this.cellLocal(gx)
    const lz = this.cellLocal(gz)
    this._markEdge(d)
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

  // --- extents ---------------------------------------------------------------

  // LOCAL chunk bounds of the kept chunks, or null.
  bounds() {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity
    const o = this.origin
    for (const d of this.chunks.values()) {
      if (!this._keptGlobal(d.cx, d.cy, d.cz)) continue
      const cx = d.cx - o.cx
      const cy = d.cy - o.cy
      const cz = d.cz - o.cz
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx)
      z0 = Math.min(z0, cz); z1 = Math.max(z1, cz)
      y0 = Math.min(y0, cy); y1 = Math.max(y1, cy)
    }
    return x0 === Infinity ? null : { x0, z0, x1, z1, y0, y1 }
  }

  // Drop chunks that carry no information (roomOps.removeRoom's cleanup).
  compact() {
    for (const [key, d] of this.chunks) if (isPristineChunk(d)) this.chunks.delete(key)
  }

  // --- export ------------------------------------------------------------------

  _solidAt(gcx, gcy, gcz) {
    return this._solid
      ? this._solid(gcx, gcy, gcz)
      : massChunk(gcx, gcy, gcz, { version: this.version, family: this.family, worldSeed: this.worldSeed, district: this.district })
  }

  // The kept chunks, keyed by chunkKey3(GLOBAL); scratch chunks are dropped
  // and an untouched kept chunk is exported as solid mass (stats.untouchedKept).
  // A written kept chunk no stamp covered whole gets its uncovered cells
  // filled IN PLACE from the solid chunk (stats.massFilledCells), so no cell
  // nothing authored leaves as default open fabric (cols 0).
  exportChunks() {
    const out = new Map()
    let untouched = 0
    let filled = 0
    for (const [key, d] of this.chunks) {
      if (!this._keptGlobal(d.cx, d.cy, d.cz)) continue
      if (!this._written.has(key)) {
        untouched++
        out.set(key, this._solidAt(d.cx, d.cy, d.cz))
        continue
      }
      if (!this._stamped.has(key)) {
        const cover = this._covered.get(key)
        let solid = null
        for (let i = 0; i < CHUNK * CHUNK; i++) {
          if (cover?.[i]) continue
          solid ??= this._solidAt(d.cx, d.cy, d.cz)
          d.cols[i] = solid.cols[i]
          d.cellKind[i] = solid.cellKind[i]
          d.spaceId[i] = solid.spaceId[i]
          d.spaceRole[i] = solid.spaceRole[i]
          d.spaceClass[i] = solid.spaceClass[i]
          filled++
        }
      }
      out.set(key, d)
    }
    this.stats.untouchedKept = untouched
    this.stats.massFilledCells = filled
    return out
  }
}
