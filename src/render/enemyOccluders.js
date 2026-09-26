// Enemy capsule occluder tables (engine-improvement P7). THREE-free: plain
// arrays in, plain numbers out, so the tables and the packing can be tested
// headless and fed straight into the lighting pass's uniform arrays.
//
// The deferred lighting pass shadows the grid fixtures and the flashlight by
// analytic capsules (segment + radius, soft cone/cap occlusion) and adds
// capsule AO. Each enemy gets up to CAPSULES_PER_ENEMY_MAX capsules fitted to
// the mesh it actually shows.
//
// BUDGETS. A fitted set only works whole: its capsules split the figure
// between them, so a prefix of one (what the shader's min(uCapN,
// uCapsulesPerEnemy) keeps on a 1-capsule tier) is a floating torso with no
// legs or a lopsided half. Every GLB kind therefore also has a dedicated
// `single` capsule, fitted on its own from the floor up (grounding AO under
// the body, the whole front silhouette for the flashlight), and capsuleSet
// hands it out whenever the tier's capsulesPerEnemy cannot afford the full
// set. The fallback silhouette is one capsule and fits every budget.
//
// STACKING. The lighting pass multiplies per capsule (`vis *= 1 - K*occ`,
// `ao *= 1 - occ`), so where two capsules of one body overlap, their shadow
// penumbrae and AO darken twice. The sets are fitted to barely overlap (at
// most ~5% of a figure's vertices sit inside two capsules; the vitest caps it
// at 10%) rather than nesting a torso inside a limb blob.
//
// SPACE CONTRACT. Every table is in `enemy.mesh` LOCAL space — the object the
// entity positions, turns and scales — so `enemy.mesh.matrixWorld` alone
// takes it to world space (yaw, the fallback's non-uniform scale and its
// meshYOffset all included). What `enemy.mesh` is depends on the model state:
//   glb       Blender GLB (render/enemyModels.js + entities/body.js). The rig
//             path makes `mesh` the cloned glTF scene root (bones + one
//             SkinnedMesh on an identity node); the static path keeps the
//             capsule Mesh with the baked rig geometry (raw POSITION). Both
//             have scale 1 and meshYOffset 0, and they coincide because the
//             skinned mesh node is identity and every joint's rest transform
//             times its inverse bind matrix is identity (the vitest locks
//             both). Local space = glTF scene space: origin at the footprint
//             centre ON the floor, +y up, the face towards +z (the facing
//             _faceMesh turns toward the player), +x the figure's left.
//   fallback  the procedural THREE.CapsuleGeometry silhouette
//             (render/geometries.js) the entity spawns with and keeps until
//             its GLB loads, or for good after a failed load: origin-centred,
//             lifted by meshYOffset and scaled non-uniformly by the entity.
//
// FIT. GLB sets are fitted to the bind (rest) pose of the shipped GLBs and
// keep >= 94% of each figure's vertices within r + 3 cm, with the radii grown
// until the idle loop — the pose actually on screen while an entity stands
// (render/enemyAnimator.js never shows the bind pose) — holds >= 0.87 at
// every phase (64-phase minimum: Stalker .88, Pursuer .92, Husk .88). Other
// clips, measured the same way (min / mean): Pursuer crawl .90 / .91; Stalker
// walk .65 / .73 and run .47 / .50 (the stride and the reaching arms leave a
// static table); Husk cornered .65 / .66 (arms raised over the face). Only
// bone-attached capsules could follow those.
//
// Pursuer: a spider-limbed crawler whose four legs arch up to knees at
// ~1.1 m and back down to the floor 0.5 m out. Three capsules cannot trace
// eight thin limb segments, so they bound them as soft blobs instead: one
// across the head, fore body and front leg pair, one per hind leg (which also
// takes the rear body). Blob-sized radii (0.38-0.54 m) are the price of the
// 90% vertex rule; its shadow and AO are a soft mass, not a spider.
//
// Packed record (two vec4 uniforms per capsule), world space:
//   [ax, ay, az, r,  bx, by, bz, owner]
// `owner` tags whose body a capsule belongs to (e.g. the enemy slot), so the
// shader can skip a body's own capsules where that matters (self-shadowing,
// the player's capsule vs the flashlight held in front of it).

export const CAPSULES_PER_ENEMY_MAX = 3
export const CAPSULE_RECORD = 8 // floats per packed capsule

const capsule = (a, b, r) => Object.freeze({ a: Object.freeze(a), b: Object.freeze(b), r })
const table = (...caps) => Object.freeze(caps)

// The tightest capsule around a CapsuleGeometry(radius, height) that the
// entity scales by `scale` (horizontal sx = sz, vertical sy), given that
// transformCapsules scales the radius by the HORIZONTAL factor only. A
// y-stretched mesh (sy > sx: the Stalker) has prolate caps that poke out of a
// sphere of radius r*sx by r*(sy - sx); lengthening the local segment by
// r*(1 - sx/sy) makes the world capsule's tip meet the mesh tip exactly,
// and the prolate cap then lies inside the end sphere everywhere. A squashed
// mesh (sy <= sx: Pursuer, Husk) has oblate caps that already sit inside the
// end sphere, so the segment stays the cylinder. Either way the fallback
// capsule encloses the whole fallback mesh.
function fallbackCapsule(radius, height, [sx, sy]) {
  const half = height / 2 + radius * Math.max(0, 1 - sx / sy)
  return table(capsule([0, -half, 0], [0, half, 0], radius))
}

// Fallback inputs mirror render/geometries.js (CapsuleGeometry radius,
// middle-section height) and each entity constructor's mesh.scale (x = z, y).
export const ENEMY_CAPSULES = Object.freeze({
  // GLB 0.65 x 2.27 x 0.45 m: thin legs, a narrow chest with arms hanging at
  // x = +-0.3 (the torso capsule takes them), the head pushed forward.
  stalker: Object.freeze({
    glb: table(
      capsule([0, 0.92, 0.15], [0, 1.49, 0.15], 0.345), // chest + hanging arms
      capsule([0, 0.09, 0.08], [0, 0.49, 0.03], 0.14), // both legs
      capsule([0, 1.93, 0.18], [0, 2.17, 0.26], 0.095) // neck + head
    ),
    single: table(capsule([0, 0.32, 0.12], [0, 1.9, 0.22], 0.32)), // feet to crown
    fallback: fallbackCapsule(0.42, 1.5, [1, 1.28]),
  }),
  // GLB 1.32 x 1.25 x 1.56 m: a low spine tube (tail to head) and four limbs.
  pursuer: Object.freeze({
    glb: table(
      capsule([-0.26, 0.55, 0.47], [0.26, 0.55, 0.47], 0.54), // head, fore body, front legs
      capsule([0.37, 0.4, -0.53], [0.3, 0.85, -0.35], 0.38), // left hind leg + rear body
      capsule([-0.37, 0.4, -0.53], [-0.3, 0.85, -0.35], 0.38) // right hind leg + rear body
    ),
    single: table(capsule([0, 0.7, -0.2], [0, 0.7, 0.4], 0.55)), // the whole crouch, knees to feet
    fallback: fallbackCapsule(0.6, 1.2, [1.2, 1]),
  }),
  // GLB 0.45 x 1.79 x 0.50 m: a small hunched figure, head bowed forward.
  husk: Object.freeze({
    glb: table(
      capsule([0, 0.84, 0.145], [0, 1.34, 0.135], 0.22), // chest + arms
      capsule([0, 0.08, 0.065], [0, 0.76, 0.095], 0.115), // both legs
      capsule([0, 1.455, 0.29], [0, 1.65, 0.29], 0.125) // bowed head
    ),
    single: table(capsule([0, 0.25, 0.1], [0, 1.45, 0.22], 0.22)), // feet to brow
    fallback: fallbackCapsule(0.38, 1.2, [0.9, 0.85]),
  }),
})

// Optional player body, relative to the player's FEET (not a mesh: the
// engine offsets it by the controller position). The top stays below EYE_H
// so the camera never sits inside it. PLAYER_CAPSULES is the ready-made
// one-capsule table for transformCapsules (no per-frame array literal).
export const PLAYER_CAPSULE = capsule([0, 0.1, 0], [0, 1.45, 0], 0.22)
export const PLAYER_CAPSULES = table(PLAYER_CAPSULE)

const EMPTY = table()

// The capsules to pack for one enemy:
//   modelState  'glb' once the entity swapped in its Blender model (the rig
//               or the static bake); anything else = the capsule fallback.
//   perEnemy    the tier's capsulesPerEnemy (graphics.js SHADOW_TIERS). A
//               budget below the full GLB set gets that kind's `single`
//               capsule, never a truncated set; < 1 gets none.
// The result never holds more than perEnemy capsules, so the shader's
// min(uCapN, uCapsulesPerEnemy) keeps all of it. An unknown kind yields no
// capsules rather than throwing mid-frame. Returns a frozen shared table.
export function capsuleSet(kind, modelState, perEnemy = CAPSULES_PER_ENEMY_MAX) {
  const set = ENEMY_CAPSULES[kind]
  if (!set || !(perEnemy >= 1)) return EMPTY
  if (modelState !== 'glb') return set.fallback
  return perEnemy >= set.glb.length ? set.glb : set.single
}

// Transform a table by a column-major 4x4 (Matrix4.elements, or the Matrix4
// itself) and pack up to CAPSULES_PER_ENEMY_MAX records into `out` at float
// index `offset`. The radius scales by the larger HORIZONTAL basis length:
// enemies only ever turn about y, and the vertical stretch is already baked
// into the fallback segment (fallbackCapsule). A typed `out` is never
// overrun — the count written says how many fit. Allocation-free.
export function transformCapsules(caps, m, out, offset = 0, owner = 0) {
  const e = m.elements ?? m
  const scale = Math.max(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[8], e[9], e[10]))
  const room = ArrayBuffer.isView(out) ? Math.floor((out.length - offset) / CAPSULE_RECORD) : Infinity
  const n = Math.max(0, Math.min(caps.length, CAPSULES_PER_ENEMY_MAX, room))
  for (let i = 0; i < n; i++) {
    const { a, b, r } = caps[i]
    const o = offset + i * CAPSULE_RECORD
    out[o] = e[0] * a[0] + e[4] * a[1] + e[8] * a[2] + e[12]
    out[o + 1] = e[1] * a[0] + e[5] * a[1] + e[9] * a[2] + e[13]
    out[o + 2] = e[2] * a[0] + e[6] * a[1] + e[10] * a[2] + e[14]
    out[o + 3] = r * scale
    out[o + 4] = e[0] * b[0] + e[4] * b[1] + e[8] * b[2] + e[12]
    out[o + 5] = e[1] * b[0] + e[5] * b[1] + e[9] * b[2] + e[13]
    out[o + 6] = e[2] * b[0] + e[6] * b[1] + e[10] * b[2] + e[14]
    out[o + 7] = owner
  }
  return n
}

// Default capsuleBound target: shared scratch, overwritten by the next call
// that omits `target` (copy it out, or pass your own, to keep a result).
const BOUND_SCRATCH = [0, 0, 0, 0]

// Bounding sphere [cx, cy, cz, R] of `count` packed records at `offset`, for
// the per-body early-out (a pixel outside every sphere's reach skips that
// body's capsules). Centre = the box around the endpoint spheres; R = the
// farthest endpoint distance + its radius, which bounds each capsule because
// a capsule is the convex sweep of its two end spheres. count 0 -> all zero.
// Runs every frame per body: scalars only, no allocation.
export function capsuleBound(out, offset, count, target = BOUND_SCRATCH) {
  if (!(count > 0)) {
    target[0] = target[1] = target[2] = target[3] = 0
    return target
  }
  let x0 = Infinity
  let y0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  let z1 = -Infinity
  for (let i = 0; i < count; i++) {
    const o = offset + i * CAPSULE_RECORD
    const r = out[o + 3]
    for (let p = o; p <= o + 4; p += 4) {
      x0 = Math.min(x0, out[p] - r)
      y0 = Math.min(y0, out[p + 1] - r)
      z0 = Math.min(z0, out[p + 2] - r)
      x1 = Math.max(x1, out[p] + r)
      y1 = Math.max(y1, out[p + 1] + r)
      z1 = Math.max(z1, out[p + 2] + r)
    }
  }
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const cz = (z0 + z1) / 2
  let R = 0
  for (let i = 0; i < count; i++) {
    const o = offset + i * CAPSULE_RECORD
    const r = out[o + 3]
    R = Math.max(
      R,
      Math.hypot(out[o] - cx, out[o + 1] - cy, out[o + 2] - cz) + r,
      Math.hypot(out[o + 4] - cx, out[o + 5] - cy, out[o + 6] - cz) + r
    )
  }
  target[0] = cx
  target[1] = cy
  target[2] = cz
  target[3] = R
  return target
}
