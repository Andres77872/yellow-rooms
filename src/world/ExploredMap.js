import {
  CELL,
  CHUNK,
  MAP_REVEAL_R,
  COL_HALF,
  MONUMENTAL_COL_HALF,
  UNLOAD_RADIUS,
  UNLOAD_RADIUS_Y,
  cIdx,
  chunkKey3,
  worldToCell,
} from './constants.js'
import { hasLineOfSight } from '../player/collision.js'
import { generateChunk } from './generate.js'
import { buildStairCells } from './structures/stairCells.js'
import { COLUMN_FURNITURE, COLUMN_MONUMENTAL, wallFeatureSeesThrough } from './mapTypes.js'

// Player-explored fog-of-war state for the HUD minimap. Pure data/logic (no
// THREE), so it stays unit-testable like ChunkData / collision.
//
// The live world streams chunks in and DISPOSES them beyond the unload radii,
// so it can't be the source of truth for places behind the player. ChunkData is
// immutable + deterministic after generation, so we retain a REFERENCE to each
// explored chunk's data (zero-copy, survives unload) plus a per-chunk reveal
// mask — the only mutable state we own. A cell becomes "seen" once it is within
// MAP_REVEAL_R of the player AND has line-of-sight to the player (true fog of
// war: you don't see through walls). The reveal pass only recomputes when the
// player crosses into a new cell, so standing still costs nothing.
//
// v8: everything is keyed per FLOOR (cx, cy, cz). Each floor keeps its own
// reveal mask, so climbing a stair swaps the minimap to that floor's fog and
// the old floor's map is preserved for the player's return.
//
// Memory: the 196-byte reveal mask is kept for the whole level, but the full
// ChunkData (+ stair descriptors) is only pinned near the player. Far entries
// drop it and re-hydrate on demand — otherwise a long walk through an infinite
// level would keep every explored chunk's typed arrays alive, including the
// ones ChunkManager already unloaded.
const KEEP_DATA_CHUNKS = UNLOAD_RADIUS + 1
const KEEP_DATA_FLOORS = UNLOAD_RADIUS_Y + 1

export class ExploredMap {
  constructor(cm) {
    this.cm = cm
    this.chunks = new Map() // chunkKey3 -> { data, cells: stair descriptors, revealed }
    this.lastCX = null
    this.lastCZ = null
    this.lastCY = null
    this._pinCX = null // chunk the data-retention window was last centred on
    this._pinCZ = null
    this._pinCY = null
  }

  // Drop all fog (called per level/seed change so nothing leaks between runs).
  reset() {
    this.chunks.clear()
    this.lastCX = null
    this.lastCZ = null
    this.lastCY = null
    this._pinCX = null
    this._pinCZ = null
    this._pinCY = null
  }

  // Reveal pass: mark cells in a disc around the player that have line of sight
  // on the player's floor. No-op until the player crosses a cell boundary or
  // changes floors.
  update(px, pz, pcy = 0) {
    const gx = worldToCell(px)
    const gz = worldToCell(pz)
    if (gx === this.lastCX && gz === this.lastCZ && pcy === this.lastCY) return
    this.lastCX = gx
    this.lastCZ = gz
    this.lastCY = pcy
    this._releaseFarData(Math.floor(gx / CHUNK), pcy, Math.floor(gz / CHUNK))

    this._mark(gx, gz, pcy) // own cell (LOS would pass anyway; cheap guard)
    const R = MAP_REVEAL_R
    const R2 = R * R
    for (let cz = gz - R; cz <= gz + R; cz++) {
      for (let cx = gx - R; cx <= gx + R; cx++) {
        const ddx = cx - gx
        const ddz = cz - gz
        if (ddx * ddx + ddz * ddz > R2) continue // circular reveal
        if (cx === gx && cz === gz) continue
        const wxc = (cx + 0.5) * CELL
        const wzc = (cz + 0.5) * CELL
        if (hasLineOfSight(this.cm, px, pz, wxc, wzc, pcy)) this._mark(cx, cz, pcy)
      }
    }
  }

  // --- Renderer queries (mirror ChunkManager's global thin-wall lookups over
  //     the stored data, so the minimap never special-cases chunk seams) ---

  isRevealed(gx, gz, cy = 0) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const e = this.chunks.get(chunkKey3(cx, cy, cz))
    if (!e) return false
    return e.revealed[cIdx(gx - cx * CHUNK, gz - cz * CHUNK)] === 1
  }

  // Stored ChunkData for a chunk (lazily filled for unloaded-but-explored
  // neighbours queried by the wall lookups). Returns null only if generation
  // somehow yields nothing.
  dataAt(cx, cy, cz) {
    return this._entry(cx, cy, cz).data || null
  }

  wallVAt(gx, gz, cy = 0) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = this.dataAt(cx, cy, cz)
    if (!d) return false
    return d.vAt(gx - cx * CHUNK, gz - cz * CHUNK) === 1
  }

  wallHAt(gx, gz, cy = 0) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = this.dataAt(cx, cy, cz)
    if (!d) return false
    return d.hAt(gx - cx * CHUNK, gz - cz * CHUNK) === 1
  }

  wallFeatureVAt(gx, gz, cy = 0) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = this.dataAt(cx, cy, cz)
    return d ? d.wallFeatureVAt(gx - cx * CHUNK, gz - cz * CHUNK) : 0
  }

  wallFeatureHAt(gx, gz, cy = 0) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = this.dataAt(cx, cy, cz)
    return d ? d.wallFeatureHAt(gx - cx * CHUNK, gz - cz * CHUNK) : 0
  }

  opaqueVAt(gx, gz, cy = 0) {
    return this.wallVAt(gx, gz, cy) && !wallFeatureSeesThrough(this.wallFeatureVAt(gx, gz, cy))
  }

  opaqueHAt(gx, gz, cy = 0) {
    return this.wallHAt(gx, gz, cy) && !wallFeatureSeesThrough(this.wallFeatureHAt(gx, gz, cy))
  }

  floorHoleAt(gx, gz, cy = 0) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = this.dataAt(cx, cy, cz)
    return !!d?.hasFloorHole(gx - cx * CHUNK, gz - cz * CHUNK)
  }

  cellKindAt(gx, gz, cy = 0) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = this.dataAt(cx, cy, cz)
    return d ? d.cellKind[cIdx(gx - cx * CHUNK, gz - cz * CHUNK)] : 0
  }

  columnAt(gx, gz, cy = 0) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = this.dataAt(cx, cy, cz)
    if (!d) return false
    return d.colAt(gx - cx * CHUNK, gz - cz * CHUNK) > 0
  }

  columnHalfAt(gx, gz, cy = 0) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = this.dataAt(cx, cy, cz)
    if (!d) return 0
    const kind = d.colAt(gx - cx * CHUNK, gz - cz * CHUNK)
    if (!kind) return 0
    // Furniture never blocks the fog-reveal DDA (see ChunkManager.columnHalfAt).
    if (kind === COLUMN_FURNITURE) return 0
    return kind === COLUMN_MONUMENTAL ? MONUMENTAL_COL_HALF : COL_HALF
  }

  // Canonical stair descriptor mirror (for the minimap's stair glyphs).
  stairAt(gx, gz, cy = 0) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const e = this._entry(cx, cy, cz)
    if (!e.cells) return null
    return e.cells.get(cIdx(gx - cx * CHUNK, gz - cz * CHUNK)) || null
  }

  // --- internals ---

  _mark(gx, gz, cy) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    this._entry(cx, cy, cz).revealed[cIdx(gx - cx * CHUNK, gz - cz * CHUNK)] = 1
  }

  _entry(cx, cy, cz) {
    const key = chunkKey3(cx, cy, cz)
    let e = this.chunks.get(key)
    if (!e) {
      e = { cx, cy, cz, hydrated: false, data: null, cells: null, revealed: new Uint8Array(CHUNK * CHUNK) }
      this.chunks.set(key, e)
    }
    if (!e.hydrated) {
      e.data = this._dataFor(cx, cy, cz)
      e.cells = e.data ? buildStairCells(e.data, cx, cy, cz) : null
      e.hydrated = true
    }
    return e
  }

  // Unpin ChunkData outside the retention window once per chunk/floor change.
  // Reveal masks are never dropped; a later query re-hydrates deterministically.
  _releaseFarData(pcx, pcy, pcz) {
    if (pcx === this._pinCX && pcz === this._pinCZ && pcy === this._pinCY) return
    this._pinCX = pcx
    this._pinCZ = pcz
    this._pinCY = pcy
    for (const e of this.chunks.values()) {
      if (!e.hydrated) continue
      const far =
        Math.max(Math.abs(e.cx - pcx), Math.abs(e.cz - pcz)) > KEEP_DATA_CHUNKS ||
        Math.abs(e.cy - pcy) > KEEP_DATA_FLOORS
      if (!far) continue
      e.data = null
      e.cells = null
      e.hydrated = false
    }
  }

  // The exact ChunkData the player walked through: prefer the live (loaded)
  // ref — cells are marked while their chunk is loaded near the player — and
  // fall back to regeneration for the rare unloaded-neighbour query. The
  // fallback MUST pass the same exit/clearing args ChunkManager built with, or
  // the spawn/exit chunks would diverge from the geometry that actually exists.
  _dataFor(cx, cy, cz) {
    const cm = this.cm
    const live = cm.chunks.get(chunkKey3(cx, cy, cz))?.data
    if (live) return live
    return generateChunk(
      cm.seed,
      cx,
      cy,
      cz,
      cm.config,
      this._exitCellFor(cx, cy, cz),
      this._clearingsFor(cx, cy, cz)
    )
  }

  _exitCellFor(cx, cy, cz) {
    const ex = this.cm.exit
    return ex && ex.cx === cx && (ex.cy ?? 0) === cy && ex.cz === cz
      ? { lx: ex.lx, lz: ex.lz }
      : null
  }

  _clearingsFor(cx, cy, cz) {
    const list = (this.cm.clearings || []).filter(
      (c) => c.cx === cx && (c.cy ?? 0) === cy && c.cz === cz
    )
    return list.length ? list : null
  }
}
