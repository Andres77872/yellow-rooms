// The tile bake cache and bake statistics (spec §6.6).
//
// One LRU per generator (one generator per family; a test's private
// generator gets its own LRU, so it can never alias a real family's bakes).
// An LRU holds max(32, ceil(121 / (w·d)) · (band ? 2 : 3)) bakes: enough for
// the ~11×11-chunk streaming ring at the player's storey and the bands (or
// storeys) next to it. Entries are frozen bake results; their chunk slices
// are never mutated (buildFamilyChunk clones the slice it hands out).

// §6.6 bake statistics, read by the harness and the debug overlay. The
// object's identity is fixed (families/familyChunk re-exports it); its
// fields are mutated in place.
//   count     bakes since load (fallbacks included)
//   ewmaMs    exponentially weighted mean bake time (α = 0.1)
//   maxMs     slowest bake
//   p95Ms     95th percentile over the last P95_WINDOW bakes
//   fallbacks bakes whose attempts all failed (all-solid tiles)
export const bakeStats = { count: 0, ewmaMs: 0, maxMs: 0, p95Ms: 0, fallbacks: 0 }

const P95_WINDOW = 256
const recent = []

export function recordBake(ms) {
  bakeStats.count++
  bakeStats.ewmaMs = bakeStats.count === 1 ? ms : bakeStats.ewmaMs * 0.9 + ms * 0.1
  if (ms > bakeStats.maxMs) bakeStats.maxMs = ms
  recent.push(ms)
  if (recent.length > P95_WINDOW) recent.shift()
  const sorted = [...recent].sort((a, b) => a - b)
  bakeStats.p95Ms = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
}

export function recordFallback() {
  bakeStats.fallbacks++
}

// Zero every statistic (tests).
export function resetBakeStats() {
  bakeStats.count = 0
  bakeStats.ewmaMs = 0
  bakeStats.maxMs = 0
  bakeStats.p95Ms = 0
  bakeStats.fallbacks = 0
  recent.length = 0
}

// The default capacity of a generator's LRU.
export function lruCapacityOf(tile) {
  const area = Math.max(1, (tile?.w ?? 1) * (tile?.d ?? 1))
  return Math.max(32, Math.ceil(121 / area) * (tile?.backend === 'band' ? 2 : 3))
}

class Lru {
  constructor(capacity) {
    this.capacity = capacity
    this.map = new Map()
  }

  has(key) {
    return this.map.has(key)
  }

  get(key) {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  set(key, value, capacity) {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > capacity) this.map.delete(this.map.keys().next().value)
  }
}

const lrus = new Map() // generator -> Lru
let capacityOverride = null

const lruOf = (gen) => {
  let lru = lrus.get(gen)
  if (!lru) lrus.set(gen, (lru = new Lru(lruCapacityOf(gen.tile))))
  return lru
}

export const tileCache = {
  // Peek without refreshing recency (the streaming gate).
  has(gen, key) {
    return lrus.get(gen)?.has(key) ?? false
  },
  get(gen, key) {
    return lrus.get(gen)?.get(key)
  },
  set(gen, key, bake) {
    const lru = lruOf(gen)
    lru.set(key, bake, capacityOverride ?? lru.capacity)
  },
  // Drop every cached bake of every generator.
  clear() {
    lrus.clear()
  },
  // Cached bakes of one generator (diagnostics).
  size(gen) {
    return lrus.get(gen)?.map.size ?? 0
  },
  capacity(gen) {
    return capacityOverride ?? lruCapacityOf(gen?.tile)
  },
  // Force every LRU's capacity (tests: the "LRU capacity 1" purity pass);
  // null restores the per-generator default. Shrinking evicts on next set.
  setCapacityOverride(n) {
    capacityOverride = n == null ? null : Math.max(1, n | 0)
  },
}
