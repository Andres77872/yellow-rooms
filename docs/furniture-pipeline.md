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
  contact-sheet render to `/tmp/yr_furniture_preview.png`;
- gives millimeter-scale details a single chamfer or a sharp edge, retains
  two bevel segments for upholstered silhouettes, and uses weighted normals
  to keep large faces flat without outlining every bevel strip;
- omits UVs (these models use material colors), and preserves existing
  `.blend1` artist backups when saving the rebuilt source.

## Runtime path

`src/render/furnitureModels.js` loads the GLBs at engine boot, bakes each
primitive's material `baseColorFactor` into a `color` vertex attribute, and
merges every kind into a single geometry. The bake stores normalized 16-bit
linear RGB colors (maximum error 1/65535, preserving near-black enemy colors
that share this helper), and retains only position, normal and color attributes.
Authored vertex colors multiply the material palette; mirrored transforms
keep correctly wound front faces. `src/world/mesh.js`
(`buildFurniturePart`) instances those geometries per kind with the placement
record's `x/z/facing` — the GLB path renders through the `furnitureModel`
G-buffer material (albedo = vertex color × per-instance tint) in the same
deferred lane as everything else.

Until the library loads (or if a GLB is missing), chunks use the procedural
unit-box builders in `src/world/objects/furniture/` — the two paths share the
placement contract, so the placement origin stays fixed when model detail swaps in
(`Chunk.refreshFurniture`, driven by `ChunkManager.upgradeFurnitureModels`).

The loader limits concurrent GLTF requests to four, deduplicates repeat loads,
releases source geometries/materials/textures after baking, and discards late
results after disposal. A failed kind keeps its procedural fallback.

## Invariants (enforced by `src/render/__tests__/furniture-models.test.js`)

- one GLB per `FURN_*` kind, every primitive materialized (its base color
  becomes the baked part tint);
- geometry origin on the floor (`minY ≈ 0`), footprint inside the collision
  AABB + overhang tolerance, so the 2D AABB sweep in `player/collision.js`
  never clips through visible geometry;
- no cameras/lights/required extensions or unused UVs in the GLBs;
- finite positions, unit normals, nondegenerate triangles and consistent
  winding for every exported model;
- downward raycasts see recessed interiors in the sink, toilet and tub,
  preventing solid slabs or support pedestals from accidentally filling them;
- the complete furniture set stays below 650,000 bytes and 20,000 triangles;
- loader concurrency, deduplication, source disposal and disposal during loading.

## September 2026 model review

All 23 models were rebuilt and visually reviewed in Blender. Basin interiors
now have real depth; the plant has tapered, folded blades rooted in its soil
and a correctly tapered pot. Desk drawers sit proud of their case, support
legs join their furniture bodies, and overlapping cabinet/bookshelf tops and
whiteboard frame corners no longer have coplanar faces. The procedural basin
and whiteboard builders retain the same fixes during loading.

The measured asset set changed as follows (one copy of each kind):

| Measure | Before | After |
| --- | ---: | ---: |
| GLB transfer bytes | 2,220,492 | 503,288 |
| Exported vertices | 59,589 | 13,334 |
| Triangles | 35,868 | 17,416 |
| Baked vertex attribute bytes | 2,621,916 | 400,020 |
| Index bytes | 215,208 | 104,496 |

Transfer size fell 77.3%, triangles 51.4%, and baked geometry buffer storage
(including indices) 82.2%. These are asset/storage reductions, not an FPS claim.


| Model | GLB bytes before → after | Triangles before → after |
| --- | ---: | ---: |
| armchair | 64,364 → 20,696 | 932 → 804 |
| bed | 94,816 → 19,956 | 1,296 → 848 |
| bookshelf | 482,232 → 47,948 | 6,804 → 1,108 |
| cabinet | 72,096 → 9,692 | 972 → 332 |
| chair | 126,348 → 32,004 | 3,216 → 1,504 |
| cooler | 66,004 → 26,708 | 1,368 → 904 |
| copier | 86,716 → 14,780 | 1,188 → 516 |
| counter | 64,680 → 9,220 | 864 → 352 |
| desk | 144,980 → 34,260 | 2,424 → 1,176 |
| fridge | 44,028 → 10,364 | 612 → 356 |
| nightstand | 54,248 → 16,388 | 1,060 → 500 |
| plant | 67,092 → 21,820 | 1,032 → 472 |
| rack | 187,396 → 24,400 | 2,592 → 1,056 |
| sink | 90,132 → 27,088 | 1,832 → 1,012 |
| sofa | 71,016 → 21,516 | 1,040 → 1,040 |
| stove | 81,240 → 37,404 | 1,220 → 868 |
| table | 61,472 → 20,872 | 1,028 → 644 |
| toilet | 51,524 → 23,092 | 1,292 → 812 |
| tub | 29,500 → 20,280 | 412 → 892 |
| tv | 85,388 → 16,160 | 1,744 → 688 |
| wardrobe | 52,488 → 10,788 | 720 → 336 |
| washer | 51,428 → 22,388 | 960 → 640 |
| whiteboard | 91,304 → 15,464 | 1,260 → 556 |
