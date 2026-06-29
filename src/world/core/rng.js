// Small deterministic PRNG stream. The step is splitmix32 (full period, no
// skipped values) kept BIT-IDENTICAL to the previous implementation, so seeded
// draw *sequences* are unchanged across the refactor — only seed DERIVATION
// moved to the modern coordinate hash.

import { hash3i, hashStr } from './hash.js'

export class RNG {
  constructor(seed) {
    this._s = seed | 0
  }
  // float in [0, 1)
  next() {
    this._s = (this._s + 0x9e3779b9) | 0
    let t = this._s ^ (this._s >>> 16)
    t = Math.imul(t, 0x21f0aaad)
    t ^= t >>> 15
    t = Math.imul(t, 0x735a2d97)
    t ^= t >>> 15
    return (t >>> 0) / 4294967296
  }
  range(min, max) {
    return min + (max - min) * this.next()
  }
  int(min, max) {
    // inclusive integer range
    return min + Math.floor(this.next() * (max - min + 1))
  }
  chance(p) {
    return this.next() < p
  }
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)]
  }
  // Deterministic in-place Fisher-Yates shuffle.
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i)
      const t = arr[i]
      arr[i] = arr[j]
      arr[j] = t
    }
    return arr
  }
  static fromHash(seed, x, y, salt = 0) {
    return new RNG(hash3i(seed, x, y, salt))
  }
  static fromString(str) {
    return new RNG(hashStr(str))
  }
}
