import * as THREE from 'three'
import { hasLineOfSight } from '../player/collision.js'
import { STAIR_SIGHT_R, layerY, worldToCell } from '../world/constants.js'

// Shared entity sensing + spawn-placement helpers, factored out of the Stalker so
// every enemy uses ONE copy of the "can the player see me?" gate and the
// off-screen relocation sampler. Module-level scratch (allocated once) keeps the
// per-frame path allocation-free.

export const EYE_Y_REL = 1.6 // entity eye height ABOVE ITS FEET (v8: pos.y = feet)

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

// Sight across one floor of separation: the slab blocks everything EXCEPT the
// stairwell aperture — both parties must stand within STAIR_SIGHT_R of the same
// stair hole with clear per-floor line of sight to it ("it's coming up the
// stairs at you" reads; nothing ever leaks through solid slab).
function apertureSight(cm, ax, az, acy, bx, bz, bcy) {
  if (!cm.apertures) return false
  const lower = Math.min(acy, bcy)
  const r2 = STAIR_SIGHT_R * STAIR_SIGHT_R
  for (const ap of cm.apertures.values()) {
    if (ap.lowerCy !== lower) continue
    for (const region of ap.regions || [ap]) {
      const minX = region.minX ?? ap.centerX
      const maxX = region.maxX ?? ap.centerX
      const minZ = region.minZ ?? ap.centerZ
      const maxZ = region.maxZ ?? ap.centerZ
      const adx = ax - Math.max(minX, Math.min(maxX, ax))
      const adz = az - Math.max(minZ, Math.min(maxZ, az))
      const bdx = bx - Math.max(minX, Math.min(maxX, bx))
      const bdz = bz - Math.max(minZ, Math.min(maxZ, bz))
      if (adx * adx + adz * adz > r2 || bdx * bdx + bdz * bdz > r2) continue
      const targetX = (minX + maxX) / 2
      const targetZ = (minZ + maxZ) / 2
      if (!hasLineOfSight(cm, ax, az, targetX, targetZ, acy)) continue
      if (!hasLineOfSight(cm, bx, bz, targetX, targetZ, bcy)) continue
      return true
    }
  }
  return false
}

// Can the player see the entity? Cheap-first gate: 3D distance -> floor gate ->
// frustum -> line of sight. Same floor keeps the classic 2D DDA; one floor of
// separation resolves through the stairwell-aperture rule; two or more floors
// are always blind (the world is solid slab between them).
//   ent/player: {x, y, z} with y = FEET height; entCy/playerCy: floor indices.
export function sightGate(cm, camera, ent, entCy, player, playerCy, sightDist) {
  const dx = player.x - ent.x
  const dy = (player.y || 0) - (ent.y || 0)
  const dz = player.z - ent.z
  if (dx * dx + dy * dy + dz * dz >= sightDist * sightDist) return false
  const dcy = Math.abs(playerCy - entCy)
  if (dcy >= 2) return false
  _v.set(ent.x, (ent.y || 0) + EYE_Y_REL, ent.z)
  if (!inFrustum(camera, _v)) return false
  if (dcy === 0) return hasLineOfSight(cm, player.x, player.z, ent.x, ent.z, entCy)
  // Mid-transit: the hysteresis floor index flips past mid-ramp, so a party
  // standing on the CONNECTING stair's lower-layer strip is physically still
  // in the lower floor's sight-space even though its index says "upper". Treat
  // that case as same-floor on the lower layer — otherwise an entity plainly
  // on screen at the stair base would read "unobserved" and could despawn or
  // relocate in full view.
  const lower = Math.min(entCy, playerCy)
  const upperParty = entCy > playerCy ? ent : player
  const s = cm.stairAt?.(worldToCell(upperParty.x), worldToCell(upperParty.z), lower)
  if (s && (s.part === 'landing' || s.part === 'run')) {
    if (hasLineOfSight(cm, player.x, player.z, ent.x, ent.z, lower)) return true
  }
  return apertureSight(cm, ent.x, ent.z, entCy, player.x, player.z, playerCy)
}

// Sample an off-frustum, non-blocked spot around the player — the generalized
// Stalker `_findHidden` (teleport) / Pursuer relocate. XZ annulus [minR,maxR];
// the floor policy picks the layer per sample:
//   'same'  — always the player's floor (the Pursuer's relentless ground truth)
//   'dread' — mostly the player's floor, sometimes one floor up/down (footsteps
//             overhead, silhouettes down stairwells — the Stalker's instrument)
// `rng` is injectable (default Math.random) so callers/tests are deterministic.
// `record`, when given, is filled with every {x,z,cy,ok} candidate for debug
// overlays. Returns { x, z, cy } or null. cm.isBlocked fails closed (unloaded
// chunks, floor holes, columns), so a candidate can never land in the void.
export function findHiddenSpot(cm, camera, px, pz, pcy, minR, maxR, opts = {}) {
  const rng = opts.rng || Math.random
  const samples = opts.samples ?? 28
  const requireOffscreen = opts.requireOffscreen !== false
  const floorPolicy = opts.floorPolicy ?? 'same'
  const dreadChance = opts.dreadChance ?? 0.2
  const record = opts.record || null
  if (record) record.length = 0
  let chosen = null
  for (let i = 0; i < samples; i++) {
    const ang = rng() * Math.PI * 2
    const dist = minR + rng() * (maxR - minR)
    const x = px + Math.cos(ang) * dist
    const z = pz + Math.sin(ang) * dist
    let cy = pcy
    if (floorPolicy === 'dread' && rng() < dreadChance) cy += rng() < 0.5 ? 1 : -1
    const solid = cm.isBlocked(x, z, cy)
    let inFr = false
    if (!solid && requireOffscreen) {
      _v.set(x, layerY(cy) + EYE_Y_REL, z)
      inFr = inFrustum(camera, _v)
    }
    const ok = !solid && !inFr
    if (record) record.push({ x, z, cy, ok })
    if (ok && !chosen) {
      chosen = { x, z, cy }
      if (!record) return chosen // fast path when not capturing candidates
    }
  }
  return chosen
}
