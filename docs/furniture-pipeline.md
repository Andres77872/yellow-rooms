# Furniture asset pipeline (Blender → GLB)

The collision-real furniture pieces (the 23 `FURN_*` kinds in
`src/world/rooms/catalog.js`) are modelled in Blender and shipped as glTF
binaries, one file per kind, under `public/models/furniture/<name>.glb`.

## Rebuilding the models

```sh
npm run build:furniture
```

runs `scripts/blender/build_furniture.py` in background Blender. The script:

- parses dimensions from `src/world/constants.js` and the part palette from
  `src/world/objects/furniture/palette.js` — those stay the single source of
  truth, re-running re-syncs the models;
- builds each piece in the furniture local frame (u = width/x, v = depth
  front, y = up, origin at the footprint centre on the floor), audits every
  model against its collision footprint, exports one GLB per kind;
- saves the editable source scene to `assets-src/furniture.blend` and a
  contact-sheet render to `/tmp/yr_furniture_preview.png`.

## Runtime path

`src/render/furnitureModels.js` loads the GLBs at engine boot, bakes each
primitive's material `baseColorFactor` into a `color` vertex attribute, and
merges every kind into a single geometry. `src/world/mesh.js`
(`buildFurniturePart`) instances those geometries per kind with the placement
record's `x/z/facing` — the GLB path renders through the `furnitureModel`
G-buffer material (albedo = vertex color × per-instance tint) in the same
deferred lane as everything else.

Until the library loads (or if a GLB is missing), chunks use the procedural
unit-box builders in `src/world/objects/furniture/` — the two paths share the
placement contract, so nothing pops or shifts when the swap happens
(`Chunk.refreshFurniture`, driven by `ChunkManager.upgradeFurnitureModels`).

## Invariants (enforced by `src/render/__tests__/furniture-models.test.js`)

- one GLB per `FURN_*` kind, every primitive materialized (its base color
  becomes the baked part tint);
- geometry origin on the floor (`minY ≈ 0`), footprint inside the collision
  AABB + overhang tolerance, so the 2D AABB sweep in `player/collision.js`
  never clips through visible geometry;
- no cameras/lights/required extensions in the GLBs.
