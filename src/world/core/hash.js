// 32-bit hashing primitives. JS has no 64-bit integers, so every mix uses
// Math.imul (32-bit two's-complement multiply) and normalises with `>>> 0`
// (uint32). Results are platform-stable (no Math.sin/float hashing), so the
// infinite world is reproducible across machines and in headless tests.

// Murmur3 fmix32 finalizer (good avalanche).
export function fmix32(h) {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

// Coordinate decorrelation primes (large, odd) + golden-ratio mixer.
const PX = 198491317
const PY = 6542989
const PZ = 1597334677
const MIX = 0x9e3779b1 | 0

// Hash a seed + 2D integer coordinate -> uint32.
export function hash2i(seed, x, y) {
  let h = Math.imul((seed ^ Math.imul(x | 0, PX)) | 0, MIX)
  h = (h ^ Math.imul(y | 0, PY)) | 0
  return fmix32(h)
}

// Hash a seed + 3D integer coordinate -> uint32.
export function hash3i(seed, x, y, z) {
  let h = Math.imul((seed ^ Math.imul(x | 0, PX)) | 0, MIX)
  h = Math.imul((h ^ Math.imul(y | 0, PY)) | 0, MIX)
  h = (h ^ Math.imul(z | 0, PZ)) | 0
  return fmix32(h)
}

// Float variants in [0, 1).
export const hash2f = (seed, x, y) => hash2i(seed, x, y) / 4294967296
export const hash3f = (seed, x, y, z) => hash3i(seed, x, y, z) / 4294967296

// String -> uint32 root seed. Bit-identical to the legacy xmur3 (its accumulate
// loop + a single finalizer pass), so the same seed TEXT keeps mapping to the
// same root integer across the refactor.
export function hashStr(str) {
  let h = (1779033703 ^ str.length) >>> 0
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}
