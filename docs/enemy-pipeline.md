# Enemy asset pipeline (Blender → GLB)

The three entity figures (`Stalker`, `Pursuer`, `Husk` in `src/entities/`) are
modelled in Blender and shipped as glTF binaries, one file per entity, under
`public/models/enemies/<name>.glb`. They replace the procedural capsule
silhouettes in `src/render/geometries.js`, which remain the fallback while the
GLBs load or if a fetch fails.

## Rebuilding the models

```sh
npm run build:enemies
```

runs `scripts/blender/build_enemies.py` in background Blender. The script:

- builds each figure in the entity local frame (u = width/x, v = front toward
  +z at `rotation.y = 0`, y = up, origin at the footprint centre on the floor),
  audits every model against its design budget (footprint, height, feet on the
  floor), and exports one GLB per entity;
- saves the editable source scene to `assets-src/enemies.blend` and a Cycles
  contact-sheet render to `/tmp/yr_enemies_preview.png` (`YR_SKIP_PREVIEW=1`
  skips it while iterating);
- bakes the same painted `COLOR_0` shading as the furniture
  (`scripts/blender/yr_shading.py`, see `docs/furniture-pipeline.md`) with a
  shorter occlusion reach for thin limbs, culls faces sunk inside other parts,
  rejects degenerate triangles, and fails if a figure exceeds 3,000 triangles
  or 90,000 bytes.

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
  long-fingered pale hands reaching the knees; dress shoes.
- **Pursuer** (~1.25 u tall, 1.32 × 1.56 footprint): a starved crawler — long
  low body with a ribcage keel, rib ridges and a raked vertebra ridge running
  onto the skull; four spider limbs whose elbows/knees rear up above the back
  with bone spurs; three-clawed hands/feet; a skull slung low with a gaping
  jaw wider than the head, ragged tooth rows and pinpoint pale eyes in dark
  sockets.
- **Husk** (~1.8 u): emaciated ash figure, shoulders hiked around a bowed
  hood whose open front sinks into a dark void; chevron rib ridges, sternum,
  collarbones and spine bumps; thin tapered limbs with pressed-through
  kneecaps and bony elbows; long dangling hands.

| Figure | GLB bytes before → after | Triangles before → after |
| --- | ---: | ---: |
| stalker | 48,644 → 62,464 | 1,584 → 2,708 |
| pursuer | 80,372 → 75,836 | 2,916 → 2,847 |
| husk | 49,252 → 60,104 | 1,486 → 2,569 |

## Runtime path

`src/render/enemyModels.js` loads the GLBs at engine boot and bakes each
figure through the same `bakeFurnitureGeometry` path as the furniture models:
every primitive's material `baseColorFactor` becomes a `color` vertex
attribute and all primitives merge into one geometry per entity. The Engine
then calls each entity's `upgradeModel(geometry, material)`, which swaps the
capsule mesh for the model, switches to the shared `entityModel` G-buffer
material (matID 2, `USE_PART_COLOR`; albedo = vertex color), resets the mesh
scale to 1, and drops the capsule's origin-centring offset (`meshYOffset 0`,
since GLB origins already sit on the floor).

Until the library loads (or if a GLB is missing), entities keep the capsule
silhouette and their flat per-entity materials — the two paths share the
placement contract, so nothing shifts when the swap happens.

## Invariants (enforced by `src/render/__tests__/enemy-models.test.js`)

- one GLB per entity (`stalker`, `pursuer`, `husk`), every primitive
  materialized;
- geometry origin on the floor (`minY ≈ 0`), front facing +z, footprint and
  height inside the design budgets mirrored from `build_enemies.py`;
- no cameras/lights/required extensions in the GLBs;
- every primitive carries a normalized `UNSIGNED_BYTE` VEC4 `COLOR_0`
  (painted shading), no UVs/textures, ≤ 3,000 triangles and < 90,000 bytes
  per figure.
