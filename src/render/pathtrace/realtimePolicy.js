import { DEFAULT_GEOMETRY_RADIUS } from './proxyScene.js'

// Streaming policy of the realtime path tracer (PathTraceRealtime.js), kept
// free of the WebGPU imports so it can be tested in Node.
//
// Geometry is gathered around a centre with REBUILD_DISTANCE of margin and
// rebuilt when the eye strays that far, or when the floor, the level or the
// resident chunk set changes. A rebuild costs a synchronous setScene
// (top-level BVH + packing, ~60-80 ms for a 240k-triangle neighbourhood on
// the measuring machine, docs/pathracer/10 §6), so streamed-in chunks alone
// rebuild at most every MIN_REBUILD_INTERVAL_MS.
export const REBUILD_DISTANCE = 12
export const GEOMETRY_RADIUS = DEFAULT_GEOMETRY_RADIUS + REBUILD_DISTANCE
export const MIN_REBUILD_INTERVAL_MS = 1000

export function worldKey(state) {
  return `${state?.seed ?? ''}|${state?.level ?? ''}|${state?.mapFamily ?? ''}`
}

export function needsRebuild({ hasScene, key, sceneKey, floor, sceneFloor, eye, center, sameChunks, now, lastBuildAt }) {
  if (!hasScene || key !== sceneKey || floor !== sceneFloor) return true
  if (Math.hypot(eye.x - center.x, eye.z - center.z) > REBUILD_DISTANCE) return true
  return !sameChunks && now - lastBuildAt >= MIN_REBUILD_INTERVAL_MS
}
