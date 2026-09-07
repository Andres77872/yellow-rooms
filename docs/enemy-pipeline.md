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
- saves the editable source scene to `assets-src/enemies.blend` and a
  contact-sheet render to `/tmp/yr_enemies_preview.png`.

The palette is authored in the script (linear-converted from sRGB hexes) and
carries the entity signature tints from `render/gbufferMaterials.js`: Stalker
near-black ink with a blank pale oval head and hands, Pursuer dark blood-red
with pinpoint pale eyes, Husk pale ash with a hollow dark face.

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
- no cameras/lights/required extensions in the GLBs.
