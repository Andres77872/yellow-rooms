# Map Editor (`/editor`)

Verified on 2026-07-21 against the current editor implementation and version-1
`.yrmap` codec.

A standalone map-creation tool with its own Vite entry (`editor.html` →
`src/editor/main.js`). Vite development and preview rewrite `/editor` to that
entry; a static host needs the equivalent rewrite, or users can open
`/editor.html` directly. It edits a finite document built from the same
`ChunkData` cells the game generates. The editor authors core cell, wall, room,
lamp, and furniture data; baked stairs and structures are preserved and
rendered but are not directly authorable.

## Research summary — what the editor builds on

The deep review of the codebase (worldgen, rooms, rendering, debug tooling)
established these load-bearing facts:

- **Generation is pure and headless.** `generateChunk(seed, cx, cy, cz,
  config) → ChunkData` (`src/world/generate.js`) never touches THREE or the
  DOM. A "start from procedural" map is just baking generated `ChunkData`
  instances into the document.
- **`ChunkData` is the universal map unit** (`src/world/ChunkData.js`):
  14×14 cells (`CHUNK=14`, `CELL=3` world units), ten per-cell/edge rasters
  (`wallV/H`, `passageV/H`, `wallFeatureV/H`, `cols`, `cellKind`, `spaceId`,
  `spaceRole`), plus record lists (`lamps`, `furniture`, `exit`) and
  descriptor carriers (`stairUp/Down`, `structure*`, `sewerDescriptor`,
  `lethalVoid*`). Walls live on cell edges; each chunk owns its West (`lx=0`)
  and North (`lz=0`) edge lines — the East/South lines belong to the
  neighbour. Floors stack at `cy` (`LAYER_H=3.6`).
- **Rooms are regions, not objects.** In the game a room is a planned `space`
  (rect + district-stable `spaceId` + `SPACE_ROLE_*`) whose cells carry
  `CELL_ROOM`; furniture is generated from the room's role by the grammar
  interpreter. Crucially, `furnishRoleRoom(ctx, space, candidates, role)` and
  `furnishOrdinaryRoom(ctx, space, candidates, family)`
  (`src/world/rooms/furnish.js`) are decoupled from the district
  planner — they need only a `ChunkData`, a space rect with a stable id,
  candidate cells and a role. The repo's own tests already invoke them with
  hand-built rooms; the editor does the same with a user-drawn rectangle.
  Election (`rooms/election.js`) is the only planner-bound stage and is
  replaced in the editor by the user's explicit role choice.
- **Meshing is reusable.** `buildChunkMeshes(data, geom, materials, ox, oy,
  oz)` (`src/world/mesh.js`) turns any `ChunkData` into meshes; it needs
  only the shared geometry set and a materials map keyed
  `{carpet, ceiling, wallpaper, panel, panelDead, doorFrame, doorLeaf, prop,
  signGlow, furniture, exit}`. The stock materials are deferred-pipeline
  G-buffer shaders; the editor's 3D preview substitutes standard lit
  materials under the same keys and adds conventional lights.
- **The debug layer is a template.** `WorldMapTool` (top-down canvas map with
  pan/zoom over live or freshly generated chunks), `mapInspect` (role/zone
  palettes, `spaceIdColor`, labels), `asciiMap` (headless renderer used by
  tests) and `widgets.js` (DOM-once panel kit) supply the editor's 2D view
  idioms, color language and UI toolkit.
- **The game runtime had no map serialization before the editor.** Runtime
  worlds are regenerated from `(seed, chunk coords, config)`; the editor codec
  therefore defines a separate finite-document format. Its canonical field
  ordering follows the same `ChunkData` state covered by `generate.test.js`.

## Document model

`EditorMap` (`src/editor/EditorMap.js`) is the single mutable document:

- `meta`: `{ name, family, seed, worldGenVersion }`.
- `chunks: Map<"cx,cy,cz" → ChunkData>` — real `ChunkData` instances.
  Chunks materialize lazily as fully-open fabric (no walls, `CELL_OPEN`)
  when an edit touches them. Untouched chunks do not exist in the document,
  and pristine materialized chunks are omitted from saves, so every file stays
  finite.
- `rooms: []` — first-class room records `{ id, cy, x0, z0, x1, z1 (global
  cell coords), role, salt, door, baked }`. A room is an authoring region:
  placing one stamps its cells (`CELL_ROOM` + `spaceId` + `spaceRole`), walls
  its perimeter, records a door, and runs the furnishing grammar. The resulting
  furniture records are ordinary editable objects. Regeneration replaces its
  furniture; deletion also clears its member cells, lamp, and non-shared
  perimeter edges.
- Global accessors mirror the game's seam rules: `wallVAt/setWallV(gx, cy,
  gz, …)` resolve the owning chunk of an edge line, cell accessors resolve
  `(floor(g/14), g mod 14)`; furniture moves re-home the record (and its
  `COLUMN_FURNITURE` byte) across chunk boundaries.
- Undo/redo: every operation snapshots the chunks it touches (typed-array
  clones — ~2 KB each) plus the room list; the stack is capped.

Procedural start: `bakeProcedural({ seedText, family, radius, floors })` runs
`generateChunk` over the requested box and replaces document chunk data at
those coordinates in one undoable operation. From then on the chunks are
ordinary editable data; generated rooms are also lifted into `rooms[]` records
(grouped by `spaceId`) so they can be regenerated or deleted like user rooms.

## Room generation from a selection

`src/editor/roomBuilder.js`:

1. The rect is stamped per chunk slice: interior cells get `CELL_ROOM`,
   the next authoring `spaceId`, and the chosen `spaceRole`; perimeter
   edges become walls (via global edge setters, honouring edge ownership);
   one south-edge door (`PASSAGE_DOOR`) is recorded by default. The wall tool
   can edit perimeter edges afterward.
2. Furnishing mirrors `placeFurniture` (`src/world/furniture.js`) minus
   the planner coupling: per chunk slice, build `space = { id, cells[{lx,lz,
   gx,gz}], x0, z0, x1, z1, area }` and candidates (free `CELL_ROOM` cells —
   no columns, lamps, slab holes or doorway approaches; the editor drops the
   2-cell chunk-border margin, which exists only for cross-seam dedup in
   infinite generation and would starve seam-adjacent rects), then call
   `furnishRoleRoom` / `furnishOrdinaryRoom` with the room's `salt` mixed
   into the space id. Placement inherits the per-piece connectivity guard,
   wall-hugging and anchor guarantees from the game's grammar.
3. The room record stores everything needed to regenerate deterministically;
   "reroll" just bumps `salt`.

Role choices come from `ROOM_TYPES` (`src/world/rooms/catalog.js`) plus the
ordinary-theme option; labels via `roomRoleLabel` (`debug/mapInspect.js`).

## Editor UI

- **2D viewport** (`MapView2D`): DPR-aware canvas with wheel-zoom at cursor
  and drag-pan (WorldMapTool idioms), drawing floor cells by kind/role,
  wall/feature edges, doors, columns, furniture footprints, lamps, stairs,
  holes, the chunk grid and the active floor `cy`. Hover/selection overlays
  ride on top.
- **Tools** (pointer-mode strategy objects): select/move (drag furniture or
  lamps to move them, `R` rotates furniture, `Delete` removes the selection),
  wall pen (a click applies the selected edge type; a drag snaps to grid
  vertices and lays a continuous run along the walked path — wall / door /
  wide / window / rail / erase modes), cell paint (open / corridor / lobby),
  room rect (choose role, then drag to generate), object placer (furniture kind
  palette), lamp placer (lit/dead cycling), and eraser. Drag strokes are
  interpolated between pointer samples and each stroke lands as a single undo
  step (`EditorMap.beginOp`/`endOp`).
- **Panel**: reuses the `widgets.js` builders (sections, segmented, sliders,
  readouts) under editor CSS. It has file actions (new empty, import, export),
  procedural-start controls, a floor stepper, tool options, a room list, and
  selection info.
- **3D preview** (`Preview3D`, toggle): plain `WebGLRenderer`, per-chunk
  `buildChunkMeshes` with standard materials, hemisphere + directional light,
  lamp panels, and an orbit camera (LightRoom idiom). Dirty chunks re-mesh on
  edit.

## `.yrmap` format

Binary, little-endian, varint-heavy, and optimized for sparse finite maps.
Layout (`src/editor/format/yrmap.js`):

```
"YRM1" magic · u8 container version · u8 codec (0 raw, 1 gzip) · payload
payload := meta · rooms · descriptor table · chunks
meta    := name str · family str · seed u32 · worldGenVersion varint ·
           nextRoomId varint
rooms   := count · { id varint · cy svarint · x0,z0 svarint · dx,dz varint ·
                     role u8 · salt varint · baked u8 · doorAxis u8 ·
                     [doorGx,doorGz svarint when doorAxis != 0] }
descs   := count · { json str }          // deduped stair/structure descriptors
chunk   := cx,cy,cz svarint · zone u8 ·
           rasters: wallV,wallH,passageV,passageH,featureV,featureH,
                    cols,cellKind,spaceRole → RLE8 · spaceId → RLE-varint ·
           lamps: count · {lx u8 · lz u8 · lit u8} ·
           furniture: count · {kind u8 · lx u8 · lz u8 · x,z,w,d f32 · facing u8} ·
           exit? {lx u8 · lz u8} ·
           descriptor refs: stairUp/Down, sewer, structure, structureUp/Down,
                            lethalVoidUp/Down → svarint index into descs (-1 none)
```

- RLE (runs of `(len varint, value)`) exploits the long solid/empty runs of
  tile layers; `spaceId` uses varint values (32-bit ids, few distinct per
  chunk). Gzip (via `CompressionStream`, feature-detected) wraps the payload
  when available.
- Descriptors (stairs, tall structures, sewer graphs) are JSON-encoded once
  in a dedup table and referenced by index. Equal descriptor JSON maps to one
  loaded object, restoring shared identity within the imported document.
- Import validates magic/version/lengths and fails closed with a message;
  `worldGenVersion` is carried so future migrations can detect old maps.

Export downloads `<name>.yrmap`; import accepts a file picker or drag+drop.
The editor also autosaves the document (debounced `.yrmap` bytes encoded as
base64, with gzip when supported) into `localStorage` and restores it on boot
as best-effort reload recovery; storage quota/private-mode failures do not
block explicit export. "New empty" clears the autosave. The format is the
intended future bridge for "play this map" support (a ChunkManager source that
consults the document before the generator).

## Out of scope (this iteration)

- Playing edited maps in the game runtime.
- Editing multi-floor structure descriptors (baked ones are preserved and
  rendered; stairs/structures are not authorable yet).
- The deferred-lighting look in the preview (standard-material approximation).
