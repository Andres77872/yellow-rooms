import { chunkKey3 } from '../world/constants.js'
import { generateChunk } from '../world/generate.js'
import { worldConfigForFamilyOrOffice } from '../world/mapFamily.js'
import { EditorMap, seedFromText } from './EditorMap.js'

// A read-only view of the INFINITE generated world for one family and seed:
// the editor's explore/debug source. It answers the same read API as the
// EditorMap document (chunkAt, cellAt, wallVAt/wallHAt, furnitureAt, lampAt,
// floors, meta), so the plan, section, inspector, audits and simulations run
// unchanged on either source.
//
// chunkAt never blocks: a miss queues the chunk and returns null, and
// pump(budgetMs) generates queued chunks in view order within a frame budget.
// Consumers that need a complete region (audits, simulations, baking) call
// prepare(box) first, which generates synchronously. Generated ChunkData is
// immutable here (edits happen only after baking into a document) and kept
// in an LRU cache.

const CACHE_LIMIT = 2400

export class WorldSource {
  constructor({ seedText = 'lobby', family = 'office' } = {}) {
    const { family: resolved, config } = worldConfigForFamilyOrOffice(family)
    this.isWorld = true
    this.seedText = seedText
    this.seed = seedFromText(seedText)
    this.config = config
    this.meta = { name: `${resolved} · ${seedText}`, family: resolved, seed: this.seed }
    this.rooms = []
    this.chunks = new Map() // LRU: chunkKey3 -> ChunkData
    this.genMs = new Map() // chunkKey3 -> generation time (ms)
    this._queue = new Map() // chunkKey3 -> {cx, cy, cz}
    this.stats = { generated: 0, totalMs: 0, maxMs: 0, maxKey: null, errors: 0 }
    this.errors = new Map() // chunkKey3 -> message (generation threw)
  }

  sameWorld(seedText, family) {
    return seedFromText(seedText) === this.seed &&
      worldConfigForFamilyOrOffice(family).family === this.meta.family
  }

  // --- chunk access ------------------------------------------------------------

  peek(cx, cy, cz) {
    return this.chunks.get(chunkKey3(cx, cy, cz)) ?? null
  }

  chunkAt(cx, cy, cz) {
    const key = chunkKey3(cx, cy, cz)
    const hit = this.chunks.get(key)
    if (hit) return hit
    if (!this.errors.has(key) && !this._queue.has(key)) this._queue.set(key, { cx, cy, cz })
    return null
  }

  require(cx, cy, cz) {
    const key = chunkKey3(cx, cy, cz)
    const hit = this.chunks.get(key)
    if (hit) {
      // Refresh LRU position.
      this.chunks.delete(key)
      this.chunks.set(key, hit)
      return hit
    }
    if (this.errors.has(key)) return null
    this._queue.delete(key)
    const t0 = performance.now()
    let d
    try {
      d = generateChunk(this.seed, cx, cy, cz, this.config)
    } catch (err) {
      this.errors.set(key, String(err?.message ?? err))
      this.stats.errors++
      return null
    }
    const ms = performance.now() - t0
    this.chunks.set(key, d)
    this.genMs.set(key, ms)
    this.stats.generated++
    this.stats.totalMs += ms
    if (ms > this.stats.maxMs) {
      this.stats.maxMs = ms
      this.stats.maxKey = key
    }
    while (this.chunks.size > CACHE_LIMIT) {
      const oldest = this.chunks.keys().next().value
      this.chunks.delete(oldest)
      this.genMs.delete(oldest)
    }
    return d
  }

  // Generate every chunk of a box now (audits, simulations, bakes).
  prepare(box) {
    for (let cy = box.y0; cy <= box.y1; cy++) {
      for (let cz = box.z0; cz <= box.z1; cz++) {
        for (let cx = box.x0; cx <= box.x1; cx++) this.require(cx, cy, cz)
      }
    }
  }

  get pending() {
    return this._queue.size
  }

  // Drain queued chunks, nearest to `focus` first, within a time budget.
  // Returns how many were generated.
  pump(budgetMs = 10, focus = null) {
    if (!this._queue.size) return 0
    const entries = [...this._queue.values()]
    if (focus) {
      const d = (c) => (c.cy === focus.cy ? 0 : 1000) + Math.abs(c.cx - focus.cx) + Math.abs(c.cz - focus.cz)
      entries.sort((a, b) => d(a) - d(b))
    }
    const t0 = performance.now()
    let n = 0
    for (const c of entries) {
      this.require(c.cx, c.cy, c.cz)
      n++
      if (performance.now() - t0 >= budgetMs) break
    }
    // Requests far from the view go stale; drop them rather than grind.
    if (this._queue.size > 1500) this._queue.clear()
    return n
  }

  // --- document-compatible surface --------------------------------------------

  // An infinite world has no stored floor list; the explorer shows a window
  // around the current floor instead.
  floors() {
    return []
  }

  bounds() {
    return null
  }
}

// Cell/edge/object accessors are the document's own (they only read through
// chunkAt and rooms), so both sources resolve seams identically.
for (const name of ['cellChunk', 'cellLocal', 'cellAt', 'wallVAt', 'wallHAt', 'furnitureAt', 'lampAt', 'roomAt']) {
  WorldSource.prototype[name] = EditorMap.prototype[name]
}

export const chunkBoxAround = (cx, cz, r, y0, y1) => ({
  x0: cx - r, x1: cx + r, z0: cz - r, z1: cz + r, y0, y1,
})
