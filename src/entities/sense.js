import * as THREE from 'three'
import { hasLineOfSight } from '../player/collision.js'
import { STAIR_SIGHT_R, WALL_H, layerY, worldToCell } from '../world/constants.js'

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

const RECT_EPSILON = 1e-6

function multilevelRegion(ap, region) {
  const minX = region.minX ?? ap.minX ?? ap.centerX
  const maxX = region.maxX ?? ap.maxX ?? ap.centerX
  const minZ = region.minZ ?? ap.minZ ?? ap.centerZ
  const maxZ = region.maxZ ?? ap.maxZ ?? ap.centerZ
  if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) return null
  if (maxX - minX <= RECT_EPSILON || maxZ - minZ <= RECT_EPSILON) return null
  return { minX, maxX, minZ, maxZ }
}

function rectContains(outer, inner) {
  return outer.minX <= inner.minX + RECT_EPSILON &&
    outer.maxX >= inner.maxX - RECT_EPSILON &&
    outer.minZ <= inner.minZ + RECT_EPSILON &&
    outer.maxZ >= inner.maxZ - RECT_EPSILON
}

// Chunk apertures describe only their local slice of a room. Rejoin collinear,
// touching slices before looking for a vertical sight column; otherwise actors
// standing in opposite participant chunks would appear slab-separated even
// though the opening is physically continuous across their shared seam.
function mergeMultilevelRegions(regions) {
  const merged = []
  for (const region of regions) {
    if (merged.some((other) => rectContains(other, region))) continue
    for (let i = merged.length - 1; i >= 0; i--) {
      if (rectContains(region, merged[i])) merged.splice(i, 1)
    }
    merged.push(region)
  }

  let changed = true
  while (changed) {
    changed = false
    outer: for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        const a = merged[i]
        const b = merged[j]
        const sameZ = Math.abs(a.minZ - b.minZ) <= RECT_EPSILON &&
          Math.abs(a.maxZ - b.maxZ) <= RECT_EPSILON
        const sameX = Math.abs(a.minX - b.minX) <= RECT_EPSILON &&
          Math.abs(a.maxX - b.maxX) <= RECT_EPSILON
        const xTouches = a.minX <= b.maxX + RECT_EPSILON &&
          b.minX <= a.maxX + RECT_EPSILON
        const zTouches = a.minZ <= b.maxZ + RECT_EPSILON &&
          b.minZ <= a.maxZ + RECT_EPSILON
        if (!((sameZ && xTouches) || (sameX && zTouches))) continue
        merged[i] = {
          minX: Math.min(a.minX, b.minX),
          maxX: Math.max(a.maxX, b.maxX),
          minZ: Math.min(a.minZ, b.minZ),
          maxZ: Math.max(a.maxZ, b.maxZ),
        }
        merged.splice(j, 1)
        changed = true
        break outer
      }
    }
  }
  return merged
}

function distanceToRegion2(x, z, region) {
  const dx = x - Math.max(region.minX, Math.min(region.maxX, x))
  const dz = z - Math.max(region.minZ, Math.min(region.maxZ, z))
  return dx * dx + dz * dz
}

const regionContains = (region, x, z) =>
  x >= region.minX - RECT_EPSILON &&
  x <= region.maxX + RECT_EPSILON &&
  z >= region.minZ - RECT_EPSILON &&
  z <= region.maxZ + RECT_EPSILON

const levelContains = (regions, point) =>
  regions.some((region) => regionContains(region, point.x, point.z))

function rayAtY(low, high, y) {
  const dy = high.y - low.y
  if (!Number.isFinite(dy) || Math.abs(dy) <= RECT_EPSILON) return null
  const t = (y - low.y) / dy
  if (t < -RECT_EPSILON || t > 1 + RECT_EPSILON) return null
  return {
    x: low.x + (high.x - low.x) * t,
    z: low.z + (high.z - low.z) * t,
  }
}

// Tall-room sight follows the actual straight eye-to-eye ray. Every intervening
// slab must expose that ray at BOTH faces of its thickness through a region
// belonging to one canonical structure. This rejects mixed ids, unloaded
// slices, bridge occlusion, and the easy false-positive where both actors stand
// vertically aligned beside the shaft but merely happen to be near a window.
function multilevelApertureSight(cm, a, acy, b, bcy) {
  if (!cm.apertures) return false
  const lower = Math.min(acy, bcy)
  const upper = Math.max(acy, bcy)
  const low = acy < bcy ? a : b
  const high = acy < bcy ? b : a
  const structures = new Map()

  for (const ap of cm.apertures.values()) {
    if (ap.kind !== 'multilevel' || ap.id === undefined || ap.id === null) continue
    const key = `${typeof ap.id}:${String(ap.id)}`
    let structure = structures.get(key)
    if (!structure) {
      structure = {
        baseCy: ap.baseCy,
        topCy: ap.topCy,
        kind: ap.structureKind,
        invalid: false,
        levels: new Map(),
      }
      structures.set(key, structure)
    }
    if (
      !Number.isInteger(ap.baseCy) ||
      !Number.isInteger(ap.topCy) ||
      !Number.isInteger(ap.lowerCy) ||
      ap.topCy <= ap.baseCy ||
      ap.lowerCy < ap.baseCy ||
      ap.lowerCy >= ap.topCy ||
      structure.baseCy !== ap.baseCy ||
      structure.topCy !== ap.topCy ||
      structure.kind !== ap.structureKind
    ) {
      structure.invalid = true
      continue
    }
    if (ap.lowerCy < lower || ap.lowerCy >= upper) continue
    const regions = structure.levels.get(ap.lowerCy) || []
    const rawRegions = ap.regions?.length ? ap.regions : [ap]
    for (const rawRegion of rawRegions) {
      const region = multilevelRegion(ap, rawRegion)
      if (region) regions.push(region)
    }
    structure.levels.set(ap.lowerCy, regions)
  }

  for (const structure of structures.values()) {
    if (
      structure.invalid ||
      lower < structure.baseCy ||
      upper > structure.topCy
    ) continue
    const levels = new Map()
    let complete = true
    for (let slabCy = lower; slabCy < upper; slabCy++) {
      const level = mergeMultilevelRegions(structure.levels.get(slabCy) || [])
      if (level.length === 0) {
        complete = false
        break
      }
      levels.set(slabCy, level)
      const ceilingPoint = rayAtY(low, high, layerY(slabCy) + WALL_H)
      const floorPoint = rayAtY(low, high, layerY(slabCy + 1))
      if (
        !ceilingPoint ||
        !floorPoint ||
        !levelContains(level, ceilingPoint) ||
        !levelContains(level, floorPoint)
      ) {
        complete = false
        break
      }
    }
    if (!complete) continue

    const lowTarget = rayAtY(low, high, layerY(lower) + WALL_H)
    const highTarget = rayAtY(low, high, layerY(upper))
    const lowLevel = levels.get(lower)
    const highLevel = levels.get(upper - 1)
    if (!lowTarget || !highTarget || !lowLevel || !highLevel) continue
    const r2 = STAIR_SIGHT_R * STAIR_SIGHT_R
    if (
      Math.min(...lowLevel.map((region) => distanceToRegion2(low.x, low.z, region))) > r2 ||
      Math.min(...highLevel.map((region) => distanceToRegion2(high.x, high.z, region))) > r2
    ) continue
    if (!hasLineOfSight(cm, low.x, low.z, lowTarget.x, lowTarget.z, lower)) continue
    if (!hasLineOfSight(cm, high.x, high.z, highTarget.x, highTarget.z, upper)) continue
    return true
  }
  return false
}

// Can the player see the entity? Cheap-first gate: 3D distance -> floor gate ->
// frustum -> line of sight. Same floor keeps the classic 2D DDA; one floor of
// separation resolves through the stairwell-aperture rule; taller separation
// is visible only through a complete, aligned multilevel-structure shaft.
//   ent/player: {x, y, z} with y = FEET height; entCy/playerCy: floor indices.
export function sightGate(cm, camera, ent, entCy, player, playerCy, sightDist) {
  const dx = player.x - ent.x
  const dy = (player.y || 0) - (ent.y || 0)
  const dz = player.z - ent.z
  if (dx * dx + dy * dy + dz * dz >= sightDist * sightDist) return false
  const dcy = Math.abs(playerCy - entCy)
  _v.set(ent.x, (ent.y || 0) + EYE_Y_REL, ent.z)
  if (!inFrustum(camera, _v)) return false
  if (dcy === 0) return hasLineOfSight(cm, player.x, player.z, ent.x, ent.z, entCy)
  if (dcy >= 2) {
    return multilevelApertureSight(
      cm,
      { x: ent.x, y: (ent.y || 0) + EYE_Y_REL, z: ent.z },
      entCy,
      {
        x: player.x,
        y: Number.isFinite(camera.position?.y)
          ? camera.position.y
          : (player.y || 0) + EYE_Y_REL,
        z: player.z,
      },
      playerCy
    )
  }
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
