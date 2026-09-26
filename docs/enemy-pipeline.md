# Enemy asset pipeline (Blender → GLB)

The three entity figures (`Stalker`, `Pursuer`, `Husk` in `src/entities/`) are
modelled in Blender and shipped as skinned, animated glTF binaries, one file
per entity, under `public/models/enemies/<name>.glb`. They replace the
procedural capsule silhouettes in `src/render/geometries.js`, which remain the
fallback while the GLBs load or if a fetch fails.

## Rebuilding the models

```sh
npm run build:enemies
```

runs `scripts/blender/build_enemies.py` in background Blender (tested with
5.2). The script:

- builds each figure in the entity local frame (u = width/x, v = front toward
  +z at `rotation.y = 0`, y = up, origin at the footprint centre on the floor),
  audits every model against its design budget (footprint, height, feet on the
  floor), and exports one GLB per entity;
- skins each figure to its own armature (see *Rig*) and exports its named
  clips (see *Clips*);
- saves the editable source scene (rigs, actions stashed on NLA tracks) to
  `assets-src/enemies.blend` and a Cycles contact-sheet render of the rest
  poses to `/tmp/yr_enemies_preview.png` (`YR_SKIP_PREVIEW=1` skips it while
  iterating);
- bakes the same painted `COLOR_0` shading as the furniture
  (`scripts/blender/yr_shading.py`, see `docs/furniture-pipeline.md`) with a
  shorter occlusion reach for thin limbs, culls faces sunk inside other parts
  of the same bone (never soles: a lifted foot shows them), rejects degenerate
  triangles and bad skin weights, and fails if a figure exceeds 3,200
  triangles or 150,000 bytes, or if the exported clip names differ from the
  authored ones.

The palette is authored in the script (linear-converted from sRGB hexes) and
carries the entity signature tints from `render/gbufferMaterials.js`: Stalker
near-black ink with a blank pale oval head and hands, Pursuer dark blood-red
with pinpoint pale eyes, Husk pale ash with a hollow dark face. Three accent
keys support the new detail without competing with those reads: `shirtGrey`
(the Stalker's dim shirt V/collar/cuffs), `bloodRidge` (Pursuer ribs,
vertebrae, joints) and `toothPale` (Pursuer teeth, dimmer than its eyes). The
eyes stay at a 1.0 shading multiplier.

## The figures

The figures are continuous smooth-shaded forms built from a small organic
toolkit — superellipse section lofts (torsos), parallel-transport tapered
limb sweeps, deformable egg skulls, surface-hugging plates and oriented
spikes — instead of primitive stacks:

- **Stalker** (~2.27 u): tailored black suit with pinched waist, hem, lapels,
  a dim shirt V, tie and button; a forward hunch that carries an elongated
  pale neck and a blank egg head (faint brow/cheekbone relief, no features)
  ahead of the shoulders; slightly-too-long arms with shirt cuffs and
  long-fingered pale hands reaching the knees; dress shoes the trouser hems
  sink into.
- **Pursuer** (~1.25 u tall, 1.32 × 1.56 footprint): a starved crawler — long
  low body with a ribcage keel, rib ridges and a raked vertebra ridge running
  onto the skull; four spider limbs whose elbows/knees rear up above the back
  with bone spurs; three-clawed hands/feet; a skull slung low with a hinged
  jaw wider than the head, ragged tooth rows and pinpoint pale eyes in dark
  sockets.
- **Husk** (~1.8 u): emaciated ash figure, shoulders hiked around a bowed
  hood whose open front sinks into a dark void; chevron rib ridges, sternum,
  collarbones and spine bumps; thin tapered limbs with pressed-through
  kneecaps and bony elbows; long dangling hands.

The limbs that bend hardest (Stalker knees, Pursuer elbows and knees) carry
extra sweep rings either side of the joint so a bend keeps its volume.

| Figure | Bones | GLB bytes static → rigged | Triangles static → rigged |
| --- | ---: | ---: | ---: |
| stalker | 21 | 62,464 → 115,492 | 2,708 → 2,914 |
| pursuer | 18 | 75,836 → 120,180 | 2,847 → 3,096 |
| husk | 21 | 60,104 → 101,608 | 2,569 → 2,672 |

## Rig

`RIGS` in the script defines each armature in the game frame (head, tail,
parent; roll 0). Limb bones run along the same axes the limb sweeps trace.
The humanoids share one naming scheme (`hips`, `spine`, `chest`, `neck`,
`head`, `shoulder_L/R`, `upperarm_*`, `forearm_*`, `hand_*`, `fingers_*`,
`thigh_*`, `shin_*`, `foot_*`); the Pursuer's root is its mid `spine`, with a
backward `pelvis`, a `jaw` hinged under the skull, and `upperarm/forearm/hand`
+ `thigh/shin/foot` per side. `_L` is +u.

**Weights are analytic, not heat-diffused.** Automatic weights are unreliable
on these figures' many overlapping loose parts (fingers, teeth, spikes,
plates). Instead every part is built inside a `bind(...)` block naming the
bones it may follow, and each vertex is weighted by an inverse-quartic
falloff from those bone segments, measured at an **anchor**:

- limbs and lofts anchor on their sweep axis (ring / section centre), so a
  limb is rigid between joints, splits exactly 50/50 at a joint, and the
  `blend` radius sets how far the bend spreads;
- trim that sits on a torso (lapels, tie, ribs, spine ridges) anchors on the
  torso axis at the same height, so it rides the loft exactly;
- knobs (eggs, spikes) anchor at their centre/base and move rigidly.

A bone can be limited to anchors below a height: the Stalker's jacket skirt
also follows the thighs (with anchors spread toward each leg), so a long
stride swings the hem instead of pushing the trouser leg through it. Every
vertex ends with 1–4 influences summing to 1 (`audit_skin`).

## Clips

`CLIPS` lists each figure's clips as pose functions of the loop phase
`t ∈ [0, 1]`, in game-frame degrees about u/y/v (the sign reference is in
`_pose_local`). They are keyed every 2 frames at 30 fps into actions stashed
on NLA tracks and sampled by the exporter at 15 Hz. All clips animate in
place: the AI owns the root.

| Figure | Clip | Loop | Used when |
| --- | --- | ---: | --- |
| stalker | `idle` | 4 s | standing (breath, slow head tilt, curling fingers) |
| stalker | `walk` | 1.1 s | moving below the run threshold (stiff stride, level cocked head) |
| stalker | `run` | 1 s | fast in the dark (pitched forward, arms pinned back, flight phase) |
| stalker | `reach` | 2 s | **additive** overlay: arms rise toward the player as it closes in |
| pursuer | `idle` | 3.2 s | holding (heave, owl-slow head roll, jaw snaps, tapping claws) |
| pursuer | `crawl` | 1 s | moving (diagonal skitter, snaking body, chattering jaw) |
| husk | `idle` | 5 s | watching (sway, shallow breath, dangling arms, twitching fingers) |
| husk | `cornered` | 1.4 s | the player lingers close (cowering, forearms up, trembling) |

Gaits plant their feet: each leg sweeps back at constant speed through a
stance phase (walk 60 %, run 36 % with a flight phase, crawl 62 %), the hips
drop to keep the planted foot on the floor, and the Pursuer's limbs yaw about
their roots so planted claws stay at floor height. The quick gaits are
authored over 1 s only to get 15 samples per stride; playback speed comes from
the runtime.

## Export and compaction

Rigged figures export with `export_skins`, `export_animations`
(`ACTIONS` mode, only this armature's NLA tracks) and forced 2-frame
sampling. `yr_shading.compact_glb` then:

- repacks `WEIGHTS_0` from float to normalized `UNSIGNED_BYTE` with
  largest-remainder rounding, so every vertex still sums to exactly 255;
- drops animation channels that hold their node's rest value for the whole
  clip (the exporter keeps them; three.js restores unbound properties to
  rest anyway) and stores rotation keys as normalized `SHORT` quaternions
  (core glTF 2.0);
- shares identical keyframe-time accessors, strips the `stalker.` style
  action prefix from clip names, and repacks every surviving accessor into its
  own tightly packed buffer view.

## Runtime path

`src/render/enemyModels.js` loads the GLBs at engine boot. For a rigged GLB,
`bakeEnemyRig` merges the figure's primitives into ONE `SkinnedMesh` (the
furniture bake's per-vertex part `color` and `surface`, plus `skinIndex` /
`skinWeight`) bound to the glTF skeleton, and keeps that bone hierarchy and
the clips as a **rig template**. The same merged geometry, in its bind pose,
also serves the static path (the gallery, the non-skinned fallback).

The Engine calls `upgradeEnemyModels(library, entities, entityModel,
entityModelSkinned)`. For each rigged entity, `createEnemyRig` clones the
template (`SkeletonUtils.clone`: an independent skeleton on the shared
geometry) and builds an `EnemyAnimator`; `upgradeRig` (`src/entities/body.js`)
replaces the capsule object in the scene graph with the rig, keeping its
position, facing and visibility, and drops the capsule's origin-centring
offset (`meshYOffset 0`). Entities keep driving `entity.mesh` exactly as
before.

Rendering: `entityModelSkinned` is the matID-2 `entityModel` G-buffer
material with `USE_SKINNING`. Its RawShaderMaterial vertex shader does
linear-blend skinning from the uniforms three binds for every `SkinnedMesh`
(`bindMatrix`, `bindMatrixInverse`, `boneTexture`). The flashlight shadow
pass renders through a `MeshDepthMaterial` override, which skins on its own,
so the torch shadow follows the pose. Rigged meshes skip frustum culling:
authored poses leave the bind-pose bounds, and there are only three.

Animation (`src/render/enemyAnimator.js`): after the AI update, the Engine
calls `enemy.animate(dt, playerPos)`. The animator measures the entity's
ground speed (ignoring relocations), reads its `stateLabel` and distance to
the player, and asks a pure per-kind policy for a pose:

- **Stalker:** idle when still, `walk` / `run` by speed (hysteresis 2.7 ↔
  3.3 u/s), `reach` weighted in from 7 u to 2.5 u, and **hold** while the
  flashlight pins it (`frozen`). Hold eases playback to zero in ~0.1 s,
  freezing clip time, gait and even the crossfade, so it stands exactly as it
  was caught.
- **Pursuer:** `crawl` whenever it moves, else `idle`.
- **Husk:** `cornered` while the player crowds it, else `idle`.

The animator drives action time itself. Base clips crossfade by weights that
always sum to 1 (no sag toward the bind pose). Every gait shares one phase
that advances at `speed / stride` loops per second (`ENEMY_CLIPS` strides,
measured from the rig: walk 1.41 m, run 3.0 m, crawl 0.76 m per loop), so
feet plant and walk ↔ run blends stay in step. It is clamped so a creeping
entity still steps and a sprinting one slides slightly rather than blurring.
Overlays are converted to additive against the REST pose, so weight 0 is the
base pose exactly. An invisible entity costs nothing.

Until the library loads (or if a GLB is missing), entities keep the capsule
silhouette and their flat per-entity materials; a GLB without a skin takes
the static `upgradeModel` path. All paths share the placement contract, so
nothing shifts when the swap happens.

`scripts/model-gallery.html` (served by `npm run dev`) shows every model; its
*Enemy clip* selector plays any clip at its authored cadence under studio or
game lighting.

## Invariants

Enforced by `src/render/__tests__/enemy-models.test.js` and
`src/render/__tests__/enemy-rig.test.js`:

- one GLB per entity (`stalker`, `pursuer`, `husk`), every primitive
  materialized; geometry origin on the floor (`minY ≈ 0`), front facing +z,
  footprint and height inside the design budgets mirrored from
  `build_enemies.py`;
- no cameras/lights/required extensions/UVs/textures; every primitive carries
  a normalized `UNSIGNED_BYTE` VEC4 `COLOR_0`; ≤ 3,200 triangles and
  < 150,000 bytes per figure;
- exactly one skin; `JOINTS_0` and unit-sum normalized-byte `WEIGHTS_0` on
  every primitive; clip names equal the runtime `ENEMY_CLIPS` table; channels
  target joints only (in place), rotations as normalized `SHORT`;
- the rig bakes to one skinned draw; clones pose independently; base weights
  sum to 1 through crossfades; walk/run share the gait phase; a held rig does
  not move; the reach overlay at weight 0 reproduces the base pose and at
  weight 1 raises the hands forward; the entity swap keeps placement.
