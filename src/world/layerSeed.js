import { hash2i } from './core/hash.js'

// Keep the per-floor seed derivation available to pure cross-layer contracts
// without importing the generation pipeline. Layer zero intentionally remains
// the root seed so its 2D geography is backwards-compatible.
export const SALT_LAYER = 0x4c59

export const layerSeed = (seed, cy) =>
  cy === 0 ? seed >>> 0 : hash2i((seed ^ SALT_LAYER) | 0, cy, 0)
