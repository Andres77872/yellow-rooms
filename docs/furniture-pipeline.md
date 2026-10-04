# Furniture asset pipeline (Blender → GLB)

The collision-real furniture pieces (the 23 `FURN_*` kinds in
`src/world/rooms/catalog.js`) are modelled in Blender and shipped as glTF
binaries, one file per kind, under `public/models/furniture/<name>.glb`.
The same driver builds the twelve prop packs of the liminal kind-lab maps
(`public/models/<pack>/`, see [Prop packs](#prop-packs)).

## Rebuilding the models

```sh
npm run build:pack -- furniture     # the generic pack driver
npm run build:furniture             # legacy entry point, same files
```

Both run `scripts/blender/build_pack.py` in background Blender
(`build_furniture.py` is a thin shim that maps its old positional arguments
`-- <glbOutDir> <blendOut> <previewPng>` onto the driver's flags). The models
themselves live in the pack spec module `scripts/blender/packs/furniture.py`
and are built from the shared primitive kit `scripts/blender/yr_kit.py`. The
build:

- parses dimensions from `src/world/constants.js` and the part palette from
  `src/world/objects/furniture/palette.js` — those stay the single source of
  truth, re-running re-syncs the models;
- builds each piece in the furniture local frame (u = width/x, v = depth
  front, y = up, origin at the footprint centre on the floor), audits every
  model against its collision footprint (class B contract below), exports one
  GLB per kind and writes `public/models/furniture/manifest.json`;
- renders a contact sheet to `/tmp/yr_furniture_preview.png` (skip it with
  `YR_SKIP_PREVIEW=1` or `--no-preview` while iterating);
- gives millimeter-scale details a single chamfer or a sharp edge, retains
  two bevel segments for upholstered silhouettes, and uses weighted normals
  to keep large faces flat without outlining every bevel strip;
- omits UVs (these models use material colors);
- bakes a painted per-vertex shading pass into `COLOR_0`, culls faces nobody
  can see, audits degenerate triangles, and fails the build if the set leaves
  its 20,000-triangle / 650,000-byte budget (see below).

A failed audit exits Blender with status 1, so npm and CI see it.

### The source `.blend` is opt-in

Blender never writes a `.blend` byte-identically (two identical runs differ),
so a rebuild no longer touches `assets-src/`. Pass `--blend PATH` (or the
second positional argument of `build_furniture.py`), or set `YR_SAVE_BLEND=1`
to save `assets-src/furniture.blend`; collision and proxy markers are kept in
that scene. `build_enemies.py` follows the same rule (`YR_SAVE_BLEND=1` →
`assets-src/enemies.blend`). Blender's `.blend1` backups and the scripts'
`__pycache__/` are git-ignored; the scripts set `sys.dont_write_bytecode`.
Two leftovers remain. `assets-src/furniture.blend1` is still tracked by git,
because the ignore rule does not untrack it. The tracked `assets-src/*.blend`
files are stale: a rebuild no longer rewrites them, so they predate the
current GLBs until someone saves them again (`YR_SAVE_BLEND=1`, or a blend
path pointing at them).

### Determinism

Two builds with the same Blender and the same sources are byte-identical
(GLBs and manifest); `git diff --exit-code public/models` after a rebuild is
the regression check. That rests on three rules:

- `yr_kit.sphere()` builds the UV sphere from explicit vertex/face lists:
  Blender 5.2's `primitive_uv_sphere_add` (and `bmesh.ops.create_uvsphere`)
  return a different face/loop order run to run, which reordered the GLB
  index buffer;
- `compact_glb()` writes every bufferView as `buffer, byteLength,
  byteOffset` — the exporter's own key order and a frozen contract (changing
  it rewrites every GLB's JSON with no content change);
- randomness goes through `yr_kit.lcg()`, never `random`.

Verified on Blender 5.2.2 (glTF I/O 5.2.40): the WP0 rebuild left 21 of the
23 furniture GLBs byte-identical to the previous commit; `desk.glb` and
`washer.glb` changed in their BIN chunk only (the sphere fix; same JSON,
same 41,344 / 27,656 bytes) and the three enemy GLBs in JSON key order only.
Totals stay 18,598 triangles / 621,548 bytes.

## Pack builder (`build_pack.py`)

```sh
blender --background --factory-startup --python scripts/blender/build_pack.py -- \
  <pack> [--out DIR] [--blend PATH] [--preview PATH] [--no-preview] [--no-budget]
```

One pack per Blender process (materials are named `yr_<key>`; a second pack
redefining a key would export `yr_<key>.001`, which the runtime's by-name
surface lookup misses). The default output is `public/models/<pack>/`. The
spec module format (`scripts/blender/packs/<pack>.py`: `NODE_PREFIX`,
`PALETTE`, `KEEP_BRIGHT`, `BUDGET`, `MODELS`) and the class audits are
documented at the top of `build_pack.py`. Classes: **B** prop (≤ 2.1 m,
half-extents < 1.2 m, centred), **C** large prop (`col_*` boxes inside its
claimed cells), **D** edge kit (origin at the edge midpoint, may hang below
the floor via `floor_z`), **E** fixture (at least one `socket_*`). Builders
place markers with `yr_kit.marker()`: `col_<n>` collision boxes, `occ_A` /
`occ_B` shadow proxies, `socket_<type>_<n>` points exported as glTF node
extras.

### `floor_z`

`yr_shading.paint()`, `cull_hidden()` and its buried-face test take
`floor_z` (default 0, the floor contract): the virtual floor plane and the
gradient base. A kit that extends below its origin (a pool ladder, a sunk
stringer) passes its lowest z instead of lifting the mesh and lowering it
again. `floor_z=None` turns the floor rules off: paint() drops the virtual
floor and starts the gradient at the mesh's lowest z, and cull_hidden() no
longer removes faces for lying on or under a floor. build_pack always
passes a number (the spec's `floor_z`, default 0).

### `manifest.json` (schema 1)

Written next to the GLBs, deterministic (fixed key order, kinds in spec
order, floats rounded to 4 decimals, trailing newline):

- `generator`: Blender `version_string`, build hash, glTF exporter version
  and the script (`build_pack.py`);
- `budget` / `totals`: the pack budget and the sums over its kinds;
- per kind: `kind`, `kindKey` (`FURN_DESK`, `PROP_X`), `file`, `class`,
  `collision` {w, d} (furniture: `rooms/furnish.js` `PIECE_DIMS`, plus the
  desk/chair/table sizes furnish.js places directly), `overhang` (the audited
  allowance past it), `heightBudget`, `floorZ`, `footprintCells`, `anchor`,
  per-kind `budget`, `bounds` (glTF = game frame, from the POSITION
  accessors), `tris`, `bytes`, `materials` (as exported), `sockets`,
  `colliders` (from `col_*`, or the collision footprint up to the height
  budget), `proxies` (from `occ_*`: furniture ports `proxies.js`
  `FURNITURE_PROXIES`), and the file's `sha256`.

`src/render/__tests__/pack-manifest.test.js` checks every built pack
(`src/render/__tests__/packManifest.js` `listPacks()`): the file set, sha256
and byte length, triangles and bounds recomputed from each GLB, budgets, the
class contracts and the painted `COLOR_0` rules. The furniture tests read
their kind list, counts and budget from the furniture manifest, and
`furniture-proxies.test.js` checks the manifest's proxies against
`proxies.js` (±5 mm) and its collision against the placement footprint.

## Painted vertex shading (`COLOR_0`)

`scripts/blender/yr_shading.py` (shared with the enemy pipeline) fakes the
anime-background painting pass per vertex instead of with textures:

- a soft vertical gradient (≈0.84 at the floor → 1.0 near the top of each
  piece);
- gentle cavity/contact occlusion from a deterministic 48-ray hemisphere
  (`mathutils` BVH, 0.3 m reach, plus a half-weight virtual floor), remapped
  to 0.74–1.0 — the game's SSAO does the heavy lifting, the bake only paints
  form;
- a faint catch-light on convex top edges (bevel strips, cushion shoulders),
  a slightly cool tint in shadow and slightly warm on the catch-light;
- the final multiplier is clamped to ≥ 0.64 (never toward black); status
  LEDs stay at 1.0.

Values are keyed per (vertex, corner normal), so the attribute never splits
extra vertices. Every material is `Base Color = ColorAttribute × part color`
(Mix/Multiply), which the glTF exporter writes as `baseColorFactor` +
`COLOR_0`; the source `.blend` and the contact sheet show the same shading.
After export, `compact_glb()` repacks `COLOR_0` from the exporter's float
VEC3 to normalized `UNSIGNED_BYTE` VEC4 (4 B/vertex) and rewrites JSON floats
as their shortest exact float32 literals. At load, GLTFLoader enables
`material.vertexColors` and `bakeFurnitureGeometry` multiplies the two, so the
palette in `palette.js` stays the single colour source.

Paper-thin surface details (labels, notes, screens, key fields, whiteboard
strokes, seams) are single-quad `decal()`s, and `cull_hidden()` deletes faces
on the floor or sunk inside another part (book bottoms, leg tops) after the
occlusion bake — both keep the vertex count, and so the byte budget, down.

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

## Invariants (enforced by `src/render/__tests__/furniture-models.test.js` and `pack-manifest.test.js`)

- one GLB per `FURN_*` kind, every primitive materialized (its base color
  becomes the baked part tint);
- geometry origin on the floor (`minY ≈ 0`), footprint inside the collision
  AABB + overhang tolerance, so the 2D AABB sweep in `player/collision.js`
  never clips through visible geometry;
- no cameras/lights/required extensions or unused UVs in the GLBs;
- every primitive carries a normalized `UNSIGNED_BYTE` VEC4 `COLOR_0`, and the
  painted multiplier stays gentle (min ≥ 0.6, mean > 0.72 per model);
- finite positions, unit normals, nondegenerate triangles and consistent
  winding for every exported model;
- downward raycasts see recessed interiors in the sink, toilet and tub,
  preventing solid slabs or support pedestals from accidentally filling them;
- the complete furniture set stays below 650,000 bytes and 20,000 triangles;
- `manifest.json` describes the GLBs as built (sha256, bytes, triangles,
  bounds) and lists exactly the files in the directory;
- loader concurrency, deduplication, source disposal and disposal during loading.

## Prop packs

The twelve liminal kind-lab maps ([Map Editor — Kind lab](map-editor.md#kind-lab))
place props that the 23 furniture kinds do not cover. The same driver builds
them with the same painted `COLOR_0` look, one pack per map: 39 kinds, all
class B.

**Layout and build.** Each pack ships as `public/models/<pack>/<stem>.glb`
plus a schema-1 `manifest.json`. The manifest's top level is `schema`,
`pack`, `generator`, `budget` and `totals`, and its `kinds[]` entries carry
the fields listed above. The spec module `scripts/blender/packs/<pack>.py`
sets `NODE_PREFIX = "<pack>_"` and `kind_key = "PROP_X"`, and its dims and
height equal the registry's. Its palette keys are named `yr_<key>`, any
variation goes through `yr_kit.lcg()`, and its sockets are markers only:
nothing consumes them yet. To build a pack, run
`npm run build:pack -- <pack> [--out DIR] [--blend PATH] [--preview PATH] [--no-preview] [--no-budget]`.
The default contact sheet goes to `/tmp/yr_<pack>_preview.png`.

| pack | ids | kinds (file stems) | tris / budget | bytes / budget |
| --- | --- | --- | ---: | ---: |
| stairwell | 24–25 | standpipe, doorstop | 894 / 2,500 | 34,360 / 100,000 |
| street | 28–31 | cart, wheelie_bin, dumpster, bench | 3,914 / 20,000 | 115,916 / 650,000 |
| showroom | 36–37 | bag_bin, flatpack | 1,494 / 20,000 | 56,184 / 650,000 |
| pool | 40–45 | starting_block, lifeguard_chair, lounger, kickboard, lost_bin, bandai | 3,102 / 4,800 | 118,964 / 190,000 |
| babel | 48–49 | corner_shelf, lectern | 1,822 / 20,000 | 83,932 / 650,000 |
| suburb | 50–53 | mailbox, kids_bike, gnome, doghouse | 2,348 / 7,500 | 90,376 / 300,000 |
| terminal | 56–58 | gate_podium, beam_seat, fids | 3,122 / 20,000 | 106,364 / 650,000 |
| theater | 60–63 | ghost_light, prompt_desk, seat_row, road_case | 5,977 / 20,000 | 197,856 / 650,000 |
| playplace | 64–68 | child_table, child_chair, arcade, punch_bag, mascot | 3,708 / 7,600 | 114,708 / 305,000 |
| train | 70–72 | metro_bench, seat_pair, ticket_gate | 2,738 / 20,000 | 82,820 / 650,000 |
| house | 74–75 | hall_clock, radio | 2,115 / 20,000 | 72,360 / 650,000 |
| funhouse | 78–79 | cctv, ball_track | 3,093 / 3,500 | 110,368 / 130,000 |

Every manifest records Blender 5.2.2 LTS and glTF exporter 5.2.40. Each
pack's budget is its spec's `BUDGET`. Seven packs keep the furniture-sized
20,000 / 650,000, and five set a tighter one.

**Registry** (`src/world/props/index.js`). It imports the pack data modules
in pack order and exports these tables:

- `PROP_PACKS`, `PROP_KINDS` and `PROP_BY_ID`;
- `PROP_DIMS` (`{ id: [w, d] }`), `PROP_HEIGHTS` and `PROP_NAMES`;
- `PROP_PROXIES` (frozen boxes in the `proxies.js` record shape);
- `PROP_MODEL_FILES` (`{ pack: { id: stem } }`).

It also re-exports every `PROP_*` id. The ids (24–79) share the furniture
record's u8 `kind` space and are disjoint from every `FURN_*`. They stay out
of `world/furniture.js`, `FURNITURE_MODEL_FILES`, `FURNITURE_PROXIES` and
the 23-kind budgets. No furnishing grammar names them, so props are placed
only explicitly, by editor kinds or the object tool. The registry is wired
in at four points:

- `rooms/furnish.js` `PIECE_DIMS` spreads `PROP_DIMS`;
- `objects/furniture/index.js` adds a box builder for every prop kind;
- `objects/furniture/proxies.js` `furnitureProxyBoxes` falls back to
  `PROP_PROXIES`;
- the editor's `FURN_NAMES` spreads `PROP_NAMES`.

**Pack data modules** (`src/world/props/packs/<pack>.js`). These are plain
data with no imports, so the registry, `proxies.js` and `surfaces.js` can
read them without an import cycle. A kind is
`{ id, key, kind: <file stem>, name, cls: 'B', dims: [w, d], height, boxes, proxies }`,
with its front toward +v, half-extents below 1.2 m and a height of at most
2.1 m.

- `boxes` is the fallback drawn until the GLB loads, or instead of it:
  `[u, yCentre, v, sizeU, sizeY, sizeV, tint]`, where the tint is a
  `FURN_TINT` key or a linear `[r, g, b]`. A fallback has 2–6 boxes and
  stands on the floor like its model.
- `proxies` holds 1–2 lamp-shadow boxes, `[u0, u1, v0, v1, y0, y1, t?]`,
  under the `proxies.js` contract. They match the model's `occ_*` markers.
- An optional pack-level `surfaces: { yr_<key>: [roughness, metalness] }`
  lists the material names the pack introduces. `render/surfaces.js`
  `mergePackSurfaces` merges every pack into `GLTF_SURFACES`, so a pack
  never edits `surfaces.js`. Some entries are rejected: a malformed one, one
  that redefines a base name with other values, or one that disagrees with
  another pack. Each rejected entry keeps the earlier definition and is
  reported in `GLTF_SURFACE_CONFLICTS`, which the tests require to be empty.

**Loading** (`render/furnitureModels.js`). `loadModelPack(library, { pack,
files, baseUrl, loader, warn })` is the shared loader. It runs four requests
at a time, deduplicates per (library, pack), never rejects, and puts every
pack's geometries in one `library.geometries` Map keyed by kind id. The
furniture and prop ids are disjoint, so `mesh.js` and `ChunkManager` stay
pack-agnostic. `loadFurnitureModels` keeps its signature and still warns
per failed model. `loadPropModels(library, { packs, loader, baseUrl })` loads
`PROP_MODEL_FILES` pack by pack from `models/<pack>/`. A pack whose GLBs are
missing warns once and keeps its kinds on the box fallback, and the load
stops if the library is disposed part-way through. Only the editor's 3D
preview calls it. `src/core/Engine.js` loads the furniture GLBs only, so a
prop placed in the game would render as its boxes; no world grammar places
one.

**Tests that guard the packs.**

- `src/render/__tests__/pack-manifest.test.js` checks every built pack,
  furniture included (see [`manifest.json`](#manifestjson-schema-1)).
- `src/render/__tests__/prop-models.test.js` runs per registry pack with
  `REQUIRE_PROP_MODELS = true`, so a pack without a manifest fails. It
  checks:
  - the manifest lists exactly the registry kinds, with `collision` equal to
    `dims` and `heightBudget` equal to `height`;
  - each GLB sits on the floor, inside its footprint + 0.15 m, centred
    within 0.12 m, with its top at most 0.06 m above `height`. It carries a
    normalized `COLOR_0` and no UVs or required extensions;
  - the painted multiplier has a minimum of at least 0.6 and a mean above
    0.72;
  - the proxies match the GLB silhouette at every facing, with top IoU at
    least 0.8 and side IoU at least 0.7. `PROP_KIDS_BIKE` is the one
    exception: two boxes cannot hold an open frame on thin wheels, so it has
    a justified per-kind floor of top 0.53 / side 0.45. The test also fails
    if a floor is no longer needed;
  - the box fallback's front IoU is at least 0.4;
  - the pack surfaces merge without conflicts;
  - in chunk meshing, props draw through the box fallback, a loaded GLB
    swaps in, and the light grid gets the registry proxies.
- `src/world/__tests__/prop-registry.test.js` checks the ids against the spec
  table in pack order. It requires unique u8 kinds disjoint from `FURN_*`
  that stay out of `furniture.js` and every grammar. It also checks the
  per-kind data and the runtime wiring above.
- `src/render/__tests__/model-loader.test.js` covers `loadPropModels`: URLs,
  the once-per-pack warning, pack selection, deduplication, and one library
  shared with furniture across dispose.
- `src/editor/__tests__/floorPlan.test.js` requires `MIRROR_UNSAFE` to list
  every prop whose proxies or manifest bounds sit off its axis. `mirror()`
  refuses those props.

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

## September 2026 art pass (painted shading + model polish)

Every model gained the painted `COLOR_0` pass, plus targeted polish kept to
structural edges: separate sagging/puffed seat and back cushions and rolled
arms on the sofa/armchair (with a throw pillow and an arm throw), a draped
blanket that rolls over the mattress edge and hangs down the sides/foot,
pinched pillows and a turned-down sheet on the bed, a contoured office chair
with a curved back, armrests, spine bar and twin-wheel casters, arching
twisting snake-plant blades in a lipped pot, a monitor with a thin bezel and
a cable into a desk grommet, an articulated desk lamp, varied/leaning/stacked
books with a two-step cornice, marker tray with capped markers, raised door
panels and mouldings, appliance handles on standoffs and door seams, fridge
notes, one-piece porcelain lathes for the toilet (raised lid, seat ring), a
rounded-rectangle tub with a sloped backrest, gooseneck taps and a towel
folded over its rail.

| Measure | Before | After |
| --- | ---: | ---: |
| GLB transfer bytes (23 kinds) | 503,288 | 621,548 |
| Triangles | 17,416 | 18,598 |
| Exported vertices | 13,334 | 14,490 |

The byte growth is the `COLOR_0` attribute (4 B/vertex) plus the added
detail; JSON float shortening, decals and hidden-face culling pay for most
of the new geometry. Both totals stay inside the unchanged budgets.
