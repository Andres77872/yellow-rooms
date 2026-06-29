// Deterministic, seam-safe value noise + fractal helpers. Everything is sampled
// by GLOBAL coordinate, so a continuous field gives both neighbouring chunks the
// same value at a shared boundary (lattice points are exactly equal) — seamless
// by construction. Used for: zone selection (chunk resolution) and decay /
// moisture / stain masks (global-cell resolution). NEVER for discrete gameplay
// decisions (gates, lit/dead) — those use the integer hash directly.

import { hash2f } from './hash.js'

const smooth = (t) => t * t * (3 - 2 * t)
const lerp = (a, b, t) => a + (b - a) * t

// Hermite-smoothed bilinear value noise in [0, 1).
export function valueNoise2D(x, y, seed = 0) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const xf = x - x0
  const yf = y - y0
  const u = smooth(xf)
  const v = smooth(yf)
  const a = hash2f(seed, x0, y0)
  const b = hash2f(seed, x0 + 1, y0)
  const c = hash2f(seed, x0, y0 + 1)
  const d = hash2f(seed, x0 + 1, y0 + 1)
  return lerp(lerp(a, b, u), lerp(c, d, u), v)
}

// Fractional Brownian motion: sum of octaves, normalised to [0, 1).
export function fbm2D(x, y, { octaves = 4, lacunarity = 2, gain = 0.5, seed = 0 } = {}) {
  let amp = 0.5
  let freq = 1
  let sum = 0
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2D(x * freq, y * freq, (seed + o * 0x9e37) | 0)
    norm += amp
    amp *= gain
    freq *= lacunarity
  }
  return sum / norm
}

// Domain-warped fBm: fbm(p + fbm(p)). Marbled/eroded look for decay masks.
export function domainWarp2D(x, y, { amp = 1, seed = 0, ...rest } = {}) {
  const wx = fbm2D(x, y, { ...rest, seed: (seed ^ 0x1b56c4f) | 0 })
  const wy = fbm2D(x, y, { ...rest, seed: (seed ^ 0x7e9a13d) | 0 })
  return fbm2D(x + amp * wx, y + amp * wy, { ...rest, seed })
}
