// Per-chunk slab-opening masks and walkability live in world/tiles/
// holeMasks.js, so the world's reachability proofs and the editor share one
// implementation (and one mask cache).
export * from '../world/tiles/holeMasks.js'
