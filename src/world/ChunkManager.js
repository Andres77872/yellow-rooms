import * as THREE from 'three'
import {
  CHUNK,
  CELL,
  COL_HALF,
  LOAD_RADIUS,
  UNLOAD_RADIUS,
  MAX_BUILDS_PER_FRAME,
  LAMP_QUERY_R,
  LIGHT_RANGE,
  STALKER_AMBIENT,
  chunkKey,
  worldToChunk,
  worldToCell,
} from './constants.js'
import { DEFAULT_WORLD_CONFIG } from './config.js'
import { Chunk } from './Chunk.js'

const HUB = (CHUNK / 2) | 0

export class ChunkManager {
  constructor(scene, seed, materials, geom) {
    this.root = new THREE.Group()
    scene.add(this.root)
    this.seed = seed
    this.materials = materials
    this.geom = geom
    this.chunks = new Map() // key -> Chunk
    this.queue = [] // pending keys
    this.queued = new Set()
    this.exit = null // {cx, cz, lx, lz}
    this.config = DEFAULT_WORLD_CONFIG
    // Forced-open clearings applied at generation. The spawn cell (chunk 0,0
    // hub) is always cleared so the player never spawns boxed in by a wall.
    this.clearings = [{ cx: 0, cz: 0, lx: HUB, lz: HUB, r: 1 }]
  }

  setSeed(seed) {
    this.seed = seed
  }

  setExit(cx, cz, lx, lz) {
    this.exit = { cx, cz, lx, lz }
  }

  // Replace the forced-open clearing list (each {cx,cz,lx,lz,r?}). Keeps the
  // spawn clearing unless the caller overrides it.
  setClearings(list) {
    this.clearings = list
  }

  reset() {
    for (const c of this.chunks.values()) c.dispose()
    this.chunks.clear()
    this.queue.length = 0
    this.queued.clear()
  }

  // Per-frame streaming around the player.
  update(px, pz) {
    const pcx = worldToChunk(px)
    const pcz = worldToChunk(pz)

    // Queue missing chunks within the load radius (nearest first).
    for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
      for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
        const cx = pcx + dx
        const cz = pcz + dz
        const key = chunkKey(cx, cz)
        if (this.chunks.has(key) || this.queued.has(key)) continue
        this.queue.push({ cx, cz, key, d: Math.max(Math.abs(dx), Math.abs(dz)) })
        this.queued.add(key)
      }
    }
    this.queue.sort((a, b) => a.d - b.d)

    // Build a few per frame.
    for (let i = 0; i < MAX_BUILDS_PER_FRAME && this.queue.length; i++) {
      const { cx, cz, key } = this.queue.shift()
      this.queued.delete(key)
      if (this.chunks.has(key)) continue
      const exitCell =
        this.exit && this.exit.cx === cx && this.exit.cz === cz
          ? { lx: this.exit.lx, lz: this.exit.lz }
          : null
      const clearings = this.clearings.filter((c) => c.cx === cx && c.cz === cz)
      const chunk = new Chunk(
        cx,
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
    }

    // Unload beyond the hysteresis radius.
    for (const [key, c] of this.chunks) {
      if (
        Math.abs(c.cx - pcx) > UNLOAD_RADIUS ||
        Math.abs(c.cz - pcz) > UNLOAD_RADIUS
      ) {
        c.dispose()
        this.chunks.delete(key)
      }
    }
  }

  // --- Queries (thin-wall model) ---
  // Walls live on cell edges; a chunk owns its West/North lines and all interior
  // lines (the East/South borders belong to the neighbours). Global line/cell
  // coords resolve to the owning chunk by floor-division. Unloaded -> open.

  wallVAt(gx, gz) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const c = this.chunks.get(chunkKey(cx, cz))
    if (!c) return false
    return c.data.vAt(gx - cx * CHUNK, gz - cz * CHUNK) === 1
  }

  wallHAt(gx, gz) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const c = this.chunks.get(chunkKey(cx, cz))
    if (!c) return false
    return c.data.hAt(gx - cx * CHUNK, gz - cz * CHUNK) === 1
  }

  columnAt(gx, gz) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const c = this.chunks.get(chunkKey(cx, cz))
    if (!c) return false
    return c.data.colAt(gx - cx * CHUNK, gz - cz * CHUNK) === 1
  }

  // Is the world point inside a freestanding column box? Used by AI spawn
  // rejection (a point is essentially never "inside" a zero-width wall).
  isBlocked(wx, wz) {
    const gx = worldToCell(wx)
    const gz = worldToCell(wz)
    if (!this.columnAt(gx, gz)) return false
    const ccx = (gx + 0.5) * CELL
    const ccz = (gz + 0.5) * CELL
    return Math.abs(wx - ccx) < COL_HALF && Math.abs(wz - ccz) < COL_HALF
  }

  cellCenter(gx, gz, target) {
    return target.set((gx + 0.5) * CELL, 0, (gz + 0.5) * CELL)
  }

  // Lit-lamp world positions within LAMP_QUERY_R of (px,pz). Reuses `out`
  // (cleared in place) to avoid per-refresh allocation.
  collectLampsNear(px, pz, out) {
    out.length = 0
    const r2 = LAMP_QUERY_R * LAMP_QUERY_R
    for (const c of this.chunks.values()) {
      const lamps = c.lamps
      if (!lamps) continue
      for (let i = 0; i < lamps.length; i++) {
        const v = lamps[i]
        const dx = v.x - px
        const dz = v.z - pz
        if (dx * dx + dz * dz <= r2) out.push(v)
      }
    }
    return out
  }

  // Scalar light level (0..1) at a world XZ point, summed from nearby LIT
  // lamps with the same windowed falloff the lighting shader uses
  // ((1-d/range)^2). Used by the entity AI to move faster in the dark and
  // crawl under lamps. Uses a private scratch so it never clobbers the
  // LightField's candidate buffer.
  lightAt(wx, wz) {
    const lamps = this.collectLampsNear(wx, wz, (this._litScratch ||= []))
    let acc = STALKER_AMBIENT
    for (let i = 0; i < lamps.length; i++) {
      const v = lamps[i]
      const d = Math.hypot(v.x - wx, v.z - wz)
      if (d >= LIGHT_RANGE) continue
      const f = 1 - d / LIGHT_RANGE
      acc += f * f
    }
    return acc < 1 ? acc : 1
  }

  // The exit's world position, if its chunk is currently loaded.
  exitWorld() {
    if (!this.exit) return null
    const c = this.chunks.get(chunkKey(this.exit.cx, this.exit.cz))
    return c?.exitWorld || null
  }

  get loadedCount() {
    return this.chunks.size
  }
}
