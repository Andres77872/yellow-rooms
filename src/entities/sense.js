import * as THREE from 'three'
import { hasLineOfSight } from '../player/collision.js'

// Shared entity sensing + spawn-placement helpers, factored out of the Stalker so
// every enemy uses ONE copy of the "can the player see me?" gate and the
// off-screen relocation sampler. Module-level scratch (allocated once) keeps the
// per-frame path allocation-free.

export const EYE_Y = 1.6 // entity eye height used for frustum / spawn sampling

const _proj = new THREE.Matrix4()
const _frustum = new THREE.Frustum()
const _v = new THREE.Vector3()

// Is world point `p` (a Vector3) inside the camera frustum? Rebuilds the frustum
// from the live view-projection each call (the camera moves every frame).
export function inFrustum(camera, p) {
  _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  _frustum.setFromProjectionMatrix(_proj)
  return _frustum.containsPoint(p)
}

// Can the player see the entity at (ex,ez)? Cheap-first gate: distance ->
// frustum -> line of sight (the LOS-baked frustum/raycast also blocks the beam
// through walls). Mirrors the Stalker's original inline visibility test.
export function sightGate(cm, camera, ex, ez, px, pz, sightDist, eyeY = EYE_Y) {
  const dx = px - ex
  const dz = pz - ez
  if (dx * dx + dz * dz >= sightDist * sightDist) return false
  _v.set(ex, eyeY, ez)
  if (!inFrustum(camera, _v)) return false
  return hasLineOfSight(cm, px, pz, ex, ez)
}

// Sample an off-frustum, non-blocked spot in the annulus [minR,maxR] around the
// player — the generalized Stalker `_findHidden` (teleport) / Pursuer relocate.
// `rng` is injectable (default Math.random) so callers/tests can be deterministic.
// `record`, when given, is filled with every {x,z,ok} candidate for debug overlays.
// Returns { x, z } or null.
export function findHiddenSpot(cm, camera, px, pz, minR, maxR, opts = {}) {
  const rng = opts.rng || Math.random
  const eyeY = opts.eyeY ?? EYE_Y
  const samples = opts.samples ?? 28
  const requireOffscreen = opts.requireOffscreen !== false
  const record = opts.record || null
  if (record) record.length = 0
  let chosen = null
  for (let i = 0; i < samples; i++) {
    const ang = rng() * Math.PI * 2
    const dist = minR + rng() * (maxR - minR)
    const x = px + Math.cos(ang) * dist
    const z = pz + Math.sin(ang) * dist
    const solid = cm.isBlocked(x, z) // inside a column (thin walls have ~no area)
    let inFr = false
    if (!solid && requireOffscreen) {
      _v.set(x, eyeY, z)
      inFr = inFrustum(camera, _v)
    }
    const ok = !solid && !inFr
    if (record) record.push({ x, z, ok })
    if (ok && !chosen) {
      chosen = { x, z }
      if (!record) return chosen // fast path when not capturing candidates
    }
  }
  return chosen
}
