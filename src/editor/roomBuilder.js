// Room authoring (stamp, furnish, regenerate, remove) lives in
// world/tiles/roomOps.js, so the world's tile programs and the editor share
// one implementation (no runtime module imports src/editor).
export * from '../world/tiles/roomOps.js'
