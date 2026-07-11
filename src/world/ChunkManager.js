import * as THREE from 'three'
import {
  CHUNK,
  CHUNK_WORLD,
  CELL,
  COL_HALF,
  LOAD_RADIUS,
  UNLOAD_RADIUS,
  LOAD_RADIUS_Y,
  UNLOAD_RADIUS_Y,
  APERTURE_VIS_CHUNKS,
  LIGHT_SPILL_R,
  MAX_BUILDS_PER_FRAME,
  LAMP_QUERY_R,
  LIGHT_RANGE,
  STALKER_AMBIENT,
  chunkKey3,
  cIdx,
  layerY,
  worldToChunk,
  worldToCell,
} from './constants.js'
import { DEFAULT_WORLD_CONFIG } from './config.js'
import { slabContract } from './slab.js'
import { Chunk } from './Chunk.js'

const HUB = (CHUNK / 2) | 0

export class ChunkManager {
  constructor(scene, seed, materials, geom) {
    this.root = new THREE.Group()
    scene.add(this.root)
    this.seed = seed
    this.materials = materials
    this.geom = geom
    this.chunks = new Map() // chunkKey3 -> Chunk
    this.queue = [] // pending keys
    this.queued = new Set()
    this.exit = null // {cx, cy, cz, lx, lz}
    this.config = DEFAULT_WORLD_CONFIG
    // Forced-open clearings applied at generation. The spawn cell (chunk 0,0
    // layer 0 hub) is always cleared so the player never spawns boxed in.
    this.clearings = [{ cx: 0, cy: 0, cz: 0, lx: HUB, lz: HUB, r: 1 }]
    // Stair apertures of loaded chunks: "cx,cz,lowerCy" -> {cx, cz, centerX,
    // centerZ, lowerCy}. Feeds the cross-floor lamp spill filter and the
    // aperture-gated visibility.
    this.apertures = new Map()
    // Last visibility inputs (re-applied to newly built chunks).
    this._visCy = 0
    this._visStair = null
  }

  setSeed(seed) {
    this.seed = seed
  }

  setExit(cx, cy, cz, lx, lz) {
    this.exit = { cx, cy, cz, lx, lz }
  }

  // Replace the forced-open clearing list (each {cx,cy,cz,lx,lz,r?}). Keeps the
  // spawn clearing unless the caller overrides it.
  setClearings(list) {
    this.clearings = list
  }

  reset() {
    for (const c of this.chunks.values()) c.dispose()
    this.chunks.clear()
    this.apertures.clear()
    this.queue.length = 0
    this.queued.clear()
    // Visibility inputs must not survive a level reset: every reset() caller
    // respawns on floor 0, and prewarm gates each fresh chunk against these.
    // A stale _visCy from dying on another floor would hide chunks of the
    // spawn floor (void holes with invisible-but-solid walls) until the next
    // floor change.
    this._visCy = 0
    this._visStair = null
  }

  // Per-frame streaming around the player. `pcy` is the player's floor index;
  // layers within LOAD_RADIUS_Y stream alongside the XZ ring.
  update(px, pz, pcy = 0) {
    const pcx = worldToChunk(px)
    const pcz = worldToChunk(pz)

    // Queue missing chunks within the load box (nearest first; the player's
    // own floor first — off-floor chunks only jump the penalty queue when a
    // stair aperture connects them to the player's floor, because those are
    // the only ones that can be SEEN through the slab).
    for (let dcy = -LOAD_RADIUS_Y; dcy <= LOAD_RADIUS_Y; dcy++) {
      const cy = pcy + dcy
      for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
        for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
          const cx = pcx + dx
          const cz = pcz + dz
          const key = chunkKey3(cx, cy, cz)
          if (this.chunks.has(key) || this.queued.has(key)) continue
          let d = Math.max(Math.abs(dx), Math.abs(dz))
          if (dcy !== 0) {
            const connected = slabContract(
              this.seed,
              cx,
              cz,
              Math.min(cy, pcy),
              this.config
            ).hasStair
            if (!connected) d += 2
          }
          this.queue.push({ cx, cy, cz, key, d })
          this.queued.add(key)
        }
      }
    }
    this.queue.sort((a, b) => a.d - b.d)

    // Build a few per frame.
    for (let i = 0; i < MAX_BUILDS_PER_FRAME && this.queue.length; i++) this._buildNext()

    // Unload beyond the hysteresis radii.
    let aperturesChanged = false
    for (const [key, c] of this.chunks) {
      if (
        Math.abs(c.cx - pcx) > UNLOAD_RADIUS ||
        Math.abs(c.cz - pcz) > UNLOAD_RADIUS ||
        Math.abs(c.cy - pcy) > UNLOAD_RADIUS_Y
      ) {
        for (const a of c.apertures) {
          this.apertures.delete(`${c.cx},${c.cz},${a.lowerCy}`)
          aperturesChanged = true
        }
        c.dispose()
        this.chunks.delete(key)
      }
    }
    // The aperture registry feeds the cross-floor gating: a stairwell leaving
    // the registry can strand off-floor chunks visible (or a ring stale), so
    // re-gate. (Additions re-gate in _buildNext.)
    if (aperturesChanged) this.updateVisibility(this._visCy, this._visStair)
  }

  _buildNext() {
    const { cx, cy, cz, key } = this.queue.shift()
    this.queued.delete(key)
    if (this.chunks.has(key)) return
    const exitCell =
      this.exit && this.exit.cx === cx && this.exit.cy === cy && this.exit.cz === cz
        ? { lx: this.exit.lx, lz: this.exit.lz }
        : null
    const clearings = this.clearings.filter(
      (c) => c.cx === cx && (c.cy ?? 0) === cy && c.cz === cz
    )
    const chunk = new Chunk(
      cx,
      cy,
      cz,
      this.seed,
      this.materials,
      this.geom,
      exitCell,
      this.config,
      clearings.length ? clearings : null
    )
    this.root.add(chunk.group)
    this.chunks.set(key, chunk)
    for (const a of chunk.apertures) {
      this.apertures.set(`${cx},${cz},${a.lowerCy}`, { cx, cz, ...a })
    }
    this._applyVisibility(chunk)
    // A NEW aperture can make already-loaded off-floor neighbours visible
    // (they were gated before this stairwell streamed in) — re-gate them.
    if (chunk.apertures.length) this.updateVisibility(this._visCy, this._visStair)
  }

  // Build EVERYTHING the streaming radius wants, synchronously. Called behind
  // the title / level-transition overlays so the world never visibly assembles
  // in front of the player (MAX_BUILDS_PER_FRAME only amortises steady-state
  // walking; a fresh level otherwise streams ~240 chunks over ~1s of gameplay).
  prewarm(px, pz, pcy = 0) {
    this.update(px, pz, pcy)
    while (this.queue.length) this._buildNext()
  }

  // --- Cross-floor visibility (v8) ---
  // Floors are mutually invisible except through stair apertures, so chunks on
  // other floors render only when they could actually be seen: within a small
  // ring of an aperture column connecting to the player's floor — plus the
  // whole adjacent floor while the player is inside a stair footprint (the
  // handoff flips mid-ramp; by the time the eye crosses the slab plane the far
  // floor is already drawn). Everything else keeps rendering cost flat.
  updateVisibility(pcy, transitStair = null) {
    this._visCy = pcy
    this._visStair = transitStair
    for (const c of this.chunks.values()) this._applyVisibility(c)
  }

  _applyVisibility(c) {
    c.group.visible = this._chunkVisible(c)
  }

  _chunkVisible(c) {
    const pcy = this._visCy
    if (c.cy === pcy) return true
    const st = this._visStair
    if (st && (c.cy === st.baseCy || c.cy === st.baseCy + 1)) return true
    if (Math.abs(c.cy - pcy) !== 1) return false
    const lowerCy = Math.min(c.cy, pcy)
    for (const a of this.apertures.values()) {
      if (a.lowerCy !== lowerCy) continue
      if (
        Math.abs(a.cx - c.cx) <= APERTURE_VIS_CHUNKS &&
        Math.abs(a.cz - c.cz) <= APERTURE_VIS_CHUNKS
      ) {
        return true
      }
    }
    return false
  }

  // --- Queries (thin-wall model) ---
  // Walls live on cell edges; a chunk owns its West/North lines and all interior
  // lines (the East/South borders belong to the neighbours). Global line/cell
  // coords resolve to the owning chunk by floor-division. Unloaded -> open.

  _chunkAt(gx, gz, cy) {
    return this.chunks.get(
      chunkKey3(Math.floor(gx / CHUNK), cy, Math.floor(gz / CHUNK))
    )
  }

  wallVAt(gx, gz, cy = 0) {
    const c = this._chunkAt(gx, gz, cy)
    if (!c) return false
    return c.data.vAt(gx - c.cx * CHUNK, gz - c.cz * CHUNK) === 1
  }

  wallHAt(gx, gz, cy = 0) {
    const c = this._chunkAt(gx, gz, cy)
    if (!c) return false
    return c.data.hAt(gx - c.cx * CHUNK, gz - c.cz * CHUNK) === 1
  }

  columnAt(gx, gz, cy = 0) {
    const c = this._chunkAt(gx, gz, cy)
    if (!c) return false
    return c.data.colAt(gx - c.cx * CHUNK, gz - c.cz * CHUNK) === 1
  }

  // Canonical stair descriptor for a cell, or null (see Chunk.buildStairCells).
  stairAt(gx, gz, cy = 0) {
    const c = this._chunkAt(gx, gz, cy)
    if (!c) return null
    return c.stairCells.get(cIdx(gx - c.cx * CHUNK, gz - c.cz * CHUNK)) || null
  }

  // Is this floor slab holed at the cell (no ground on layer cy — the walk
  // surface there is the ramp on cy-1)?
  floorHoleAt(gx, gz, cy = 0) {
    const c = this._chunkAt(gx, gz, cy)
    if (!c) return false
    return c.data.hasFloorHole(gx - c.cx * CHUNK, gz - c.cz * CHUNK)
  }

  // May anything spawn/stand at this world point on layer cy? Unlike the wall
  // queries (unloaded -> open, collision no-ops), placement must FAIL CLOSED:
  // an unloaded chunk is blocked, as are floor holes, stair ramps (an entity
  // placed on a run cell at flat floor height would hover inside the flight)
  // and column interiors — the same walkability rule the pathfinder uses.
  isBlocked(wx, wz, cy = 0) {
    const gx = worldToCell(wx)
    const gz = worldToCell(wz)
    const c = this._chunkAt(gx, gz, cy)
    if (!c) return true
    const lx = gx - c.cx * CHUNK
    const lz = gz - c.cz * CHUNK
    if (c.data.hasFloorHole(lx, lz)) return true
    const s = c.stairCells.get(cIdx(lx, lz))
    if (s && s.part === 'run') return true
    if (!c.data.colAt(lx, lz)) return false
    const ccx = (gx + 0.5) * CELL
    const ccz = (gz + 0.5) * CELL
    return Math.abs(wx - ccx) < COL_HALF && Math.abs(wz - ccz) < COL_HALF
  }

  // Cell centre at the FLOOR height of layer cy.
  cellCenter(gx, gz, cy, target) {
    return target.set((gx + 0.5) * CELL, layerY(cy), (gz + 0.5) * CELL)
  }

  // Lit-lamp world positions within LAMP_QUERY_R of (px,pz). Reuses `out`
  // (cleared in place) to avoid per-refresh allocation.
  //
  // `pcy` (null = legacy unfiltered) applies the v8 cross-floor policy: lamps
  // on the player's floor always qualify; lamps exactly one floor away qualify
  // only within LIGHT_SPILL_R of a stair aperture between the two floors (the
  // slab physically blocks everything else — lamps are shadowless, so this
  // assignment filter is what stops light bleeding through floors); lamps two
  // or more floors away never qualify.
  collectLampsNear(px, pz, out, pcy = null) {
    out.length = 0
    const r2 = LAMP_QUERY_R * LAMP_QUERY_R
    for (const c of this.chunks.values()) {
      const lamps = c.lamps
      if (!lamps || !lamps.length) continue
      if (pcy !== null && Math.abs(c.cy - pcy) > 1) continue
      // Chunk-AABB prune: skip chunks whose nearest edge is beyond the query
      // radius. Exact for any radius; still culls most of the loaded chunks'
      // lamp arrays each call (called per-frame by lightAt + AI).
      const minX = c.cx * CHUNK_WORLD
      const minZ = c.cz * CHUNK_WORLD
      const ndx = px < minX ? minX - px : px > minX + CHUNK_WORLD ? px - (minX + CHUNK_WORLD) : 0
      const ndz = pz < minZ ? minZ - pz : pz > minZ + CHUNK_WORLD ? pz - (minZ + CHUNK_WORLD) : 0
      if (ndx * ndx + ndz * ndz > r2) continue
      const offFloor = pcy !== null && c.cy !== pcy
      for (let i = 0; i < lamps.length; i++) {
        const v = lamps[i]
        const dx = v.x - px
        const dz = v.z - pz
        if (dx * dx + dz * dz > r2) continue
        if (offFloor && !this._lampSpills(v, Math.min(v.cy, pcy))) continue
        out.push(v)
      }
    }
    return out
  }

  // Does an off-floor lamp sit close enough to a stair aperture between the
  // two floors to spill through it? (A lamp beyond LIGHT_RANGE of the hole
  // couldn't reach through it anyway, so LIGHT_SPILL_R = LIGHT_RANGE is exact.)
  _lampSpills(v, lowerCy) {
    const r2 = LIGHT_SPILL_R * LIGHT_SPILL_R
    for (const a of this.apertures.values()) {
      if (a.lowerCy !== lowerCy) continue
      const dx = v.x - a.centerX
      const dz = v.z - a.centerZ
      if (dx * dx + dz * dz <= r2) return true
    }
    return false
  }

  // Scalar light level (0..1) at a world XZ point on layer `cy`, summed from
  // nearby LIT lamps with the same windowed falloff the lighting shader uses
  // (the cubic lampAtt window in render/shaders/common.js). Used by the entity
  // AI to move faster in the dark and crawl under lamps — kept curve-identical
  // for same-floor lamps so the AI's light sense tracks the pools the player
  // actually sees; spill lamps from adjacent floors use true 3D distance (the
  // pool at the bottom of a stairwell is dimmer, as rendered). Uses a private
  // scratch so it never clobbers the LightField's candidate buffer.
  lightAt(wx, wz, cy = null) {
    const lamps = this.collectLampsNear(wx, wz, (this._litScratch ||= []), cy)
    let acc = STALKER_AMBIENT
    const wy = cy === null ? null : layerY(cy)
    for (let i = 0; i < lamps.length; i++) {
      const v = lamps[i]
      let d
      if (wy !== null && v.cy !== cy) {
        d = Math.hypot(v.x - wx, v.y - wy, v.z - wz)
      } else {
        d = Math.hypot(v.x - wx, v.z - wz)
      }
      if (d >= LIGHT_RANGE) continue
      const f = 1 - d / LIGHT_RANGE
      acc += f * f * f
    }
    return acc < 1 ? acc : 1
  }

  // The exit's world position, if its chunk is currently loaded.
  exitWorld() {
    if (!this.exit) return null
    const c = this.chunks.get(chunkKey3(this.exit.cx, this.exit.cy, this.exit.cz))
    return c?.exitWorld || null
  }

  get loadedCount() {
    return this.chunks.size
  }
}
