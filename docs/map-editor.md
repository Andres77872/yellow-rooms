# Map Editor (`/editor`)

Verified on 2026-09-26 against the current editor implementation (world-gen
v26) and the version-1 `.yrmap` codec.

A standalone map-creation tool with its own Vite entry (`editor.html` →
`src/editor/main.js`). Vite development and preview rewrite `/editor` to that
entry; a static host needs the equivalent rewrite, or users can open
`/editor.html` directly. It edits a finite document built from the same
`ChunkData` cells the game generates. The editor authors core cell, wall, room,
lamp, and furniture data, and **new multilevel structures** from templates
built on the canonical contracts ([Authoring structures](#authoring-structures)).
Baked stairs and canonical multilevel structures are preserved, rendered and
**reviewed as complete volumes** ([Multilevel structures](#multilevel-structures)),
but canonical descriptors are not editable.

It is also a **world debugger**: explore mode browses the infinite generated
world of any family and seed read-only, with a structure atlas, an inspector,
debug fills, audits and simulations ([Explore and debug](#explore-and-debug),
[Simulations and the liminal report](#simulations-and-the-liminal-report)),
and a kind lab builds prototype map kinds ([Kind lab](#kind-lab)). The
**structure catalog browser** lists every structure type each map family
generates and finds or stamps any of them
([Structure catalog browser](#structure-catalog-browser)).

**Where things are:** open `/editor` (e.g. `http://localhost:5173/editor`
under `npm run dev`). The right-hand inspector has tabs **Map · View ·
Structures · Create · Simulate · Inspect**; the structure catalog is the top
of **Structures**; `E` switches to explore (debugger) mode; `Ctrl/⌘+K` finds
any action by name and `?` opens the shortcut sheet and a quick start.

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

Procedural start: `bakeProcedural({ seedText, family, radius, floors, center })`
runs `generateChunk` over the requested box; `bakeChunks({ seed, family,
coords })` is the general form (the structure loader passes a complete volume).
Both replace document chunk data at those coordinates in one undoable
operation. From then on the chunks are ordinary editable data. Generated rooms
are lifted into `rooms[]` records (grouped by `(cy, spaceId)`) so they can be
regenerated or deleted like user rooms; baked records are derived data and are
rebuilt for the touched floors on every bake, so re-baking never duplicates
them. Rooms whose cells a bake overwrote are dropped, and user-authored rooms
are never re-lifted as baked records. `seedFromText` hashes seed text like the
game and also accepts `#<uint32>` — how the editor continues a loaded
document, whose original seed text is not stored.

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

- **Plan viewport** (`MapView2D`): DPR-aware canvas with wheel-zoom at cursor
  and drag-pan (WorldMapTool idioms). It draws in passes because the document
  is layered: cell fills by kind/role for every visible chunk, then a faint
  **ghost of the floor below** (the storey seen through slab openings and the
  one a stair lands on), then the current floor's columns, furniture, lamps,
  walls, features and doors, then the multilevel overlays — dashed **ceiling
  openings** (where this storey's ceiling is open), **stair arrows** (yellow
  climbs to `cy+1`, teal arrives from `cy-1`), **structure outlines** (loaded
  structures with the family glyphs from `debug/familyOverlays.js`; scanned but
  unloaded ones dashed; the selected one labelled with its storey role), red
  **lethal voids**, drift cells, audit markers and the section cut line. Every
  layer toggles in the view section. Slab-opening and lethal queries go
  through `holeMasks.js`, a per-chunk mask cached on descriptor identity
  (Lattice hole queries re-validate the lethal half per call, ~1.3 µs each).
- **Section view** (`SectionView`, `V`): a vertical cross-section docked under
  the plan, cutting along a grid row (x) or column (z) through every stored
  floor. Horizontally it shares the plan's scale and centre (an x cut is
  column-aligned with the plan above); vertically storeys fill the dock and the
  header reports the vertical exaggeration. It draws room tints, floor slabs
  (absent over openings, red over lethal drops with a tick at the death plane),
  walls crossing the cut at real heights (full wall, window sill/head, guard
  rail, door lintel), walls along the cut as a backdrop, columns, furniture,
  ceiling lamps, stair flights as ramps (or hatched wells when crossed), and
  the selected structure's volume. Click a cell to visit its floor; RMB pans;
  wheel zooms; drag the top edge to resize. The section tool sets the cut,
  `X` swaps the axis through the hovered cell and `F` makes the cut follow the
  cursor.
- **Tools** (pointer-mode strategy objects, keys `1`–`9`, `0`): select/move
  (drag furniture or lamps, `R` rotates furniture, `Delete` removes the
  selection; in explore mode it pins the inspector), wall pen (click applies
  the selected edge type; drag snaps to grid vertices and lays a continuous
  run — wall / door / wide / window / rail / erase), cell paint (open /
  corridor / lobby), room rect (choose role, then drag), object placer, lamp
  placer (lit/dead cycling), eraser, section cut, probe (inspect / distance /
  path / isovist) and author (structure templates). Drag strokes are
  interpolated between pointer samples and land as one undo step. Editing
  tools refuse in explore mode.
- **Structure protection** (`protect.js`, on by default): generated multilevel
  geometry is only valid as a whole, so the tools skip what the descriptors
  own and say why in the status line — slab openings and lethal drops, stair
  strips, bridge decks, atrium halls and voids (cells); guard rails, structure
  windows and every edge bounding those cells (edges); open ceilings (lamps);
  and room rectangles overlapping any of them. Turn it off to edit anyway —
  the live audit then shows what broke.
- **Shell** (`src/editor/ui/panel.js`, reworked 2026-09-26): an **app bar**
  (document name, Document/Explore switch, undo/redo with disabled state,
  new/import/export, the generator-version badge — amber when the document was
  made by an older generator — a *Search actions…* button for the palette,
  help, and the side-panel toggle); a **tool rail** on the left (inline-SVG
  icons with their digit, grouped edit 1–7 · analyse 8–9 · create 0,
  arrow-key navigation, the protection lock at the bottom; editing tools grey
  out while exploring); a **tool bar** over the plan with the active tool's
  options, its hint and the view controls (floor stepper, section, 3D, fit,
  zoom); the **inspector** on the right with tabs — Map (file, world seed and
  family, procedural start, explore), View (floor strip, layers with colour
  legends, section and 3D options), Structures (catalog browser, atlas scan,
  structure list, review of the selected volume), Create (templates, authored
  list, kind lab), Simulate (probes, liminal report, lighting lab) and Inspect
  (inspector and document review) — plus a selection card above the tabs; and
  a **status bar** (mode, floor, hover readout that can be selected and
  copied, the latest notice coloured by severity with a 40-entry history,
  zoom, autosave state). Sections collapse with keyboard support; the active
  tab, collapsed sections and panel visibility persist in `localStorage`
  (`yr-editor-ui-v1`). Below 980 px the inspector becomes a drawer.
- **Tooltips** (`ui/tooltip.js`): every control carries a rich tooltip — a
  title, what it does and any side effect (undoable or not, read-only while
  exploring, “replaces the document”), shortcut chips and, when disabled, why.
  They show after ~350 ms on hover or at once on keyboard focus, stay while
  the pointer moves onto them, close on Escape, and are wired with
  `aria-describedby`. Report columns and fill modes explain their metric;
  layers and fills have colour legends. `ui-tooltips.test.js` scans every
  control builder in `src/editor/ui` for a tooltip.
- **One keymap** (`ui/keymap.js`) drives the key handler, the help sheet
  (`?`/`F1`, with a 5-step quick start, mouse gestures and the colour legend),
  tooltip shortcut chips and the **command palette** (`Ctrl/⌘+K`: fuzzy search
  over tools, tabs, layers, file actions, explore, simulations, structure
  actions, templates, prototype kinds and families; it also understands
  `floor 3` and `12,40[,cy]`). Keys: 1–9/0 tools · Ctrl/⌘+Z, Ctrl/⌘+Shift+Z or
  Ctrl/⌘+Y undo/redo · Del/Backspace delete · R rotate (the Furniture tool
  turns the next piece) · X/F swap axis/follow cursor (Section tool only) ·
  F fit document · Home fit/reset 3D · = + − zoom · PgUp/PgDn floor · V
  section · E explore · Tab 3D (after clicking the plan) · Escape cancel ·
  Ctrl/⌘+S export · Ctrl/⌘+O import. Single-key shortcuts can be limited to
  the plan and tool rail (View → Keyboard; WCAG 2.1.4).
- **Safety:** New, Import (button, Ctrl/⌘+O or drag-and-drop) and Bake view /
  Load volume with *replace document* on ask for confirmation in a small
  accessible dialog; tooltips say which actions are undoable.
- **3D preview** (`Preview3D`, `Tab`): plain `WebGLRenderer`, per-chunk
  `buildChunkMeshes` with standard materials, hemisphere + directional light,
  lamp panels, and an orbit camera (LightRoom idiom). Dirty chunks re-mesh on
  edit. **Floor clipping** shows all storeys, storeys up to the current one, or
  the current one only; the cutaways lift the lid of the cut storey (its
  ceiling and troffers, via the mesher's semantic parts). The selected
  structure's volume is outlined and framed; changing floor keeps the orbit
  and only moves the pivot. Geometry-mode haze scales with orbit distance so a
  framed Lattice district is not lost in fog. Its look selector can instead
  render any look profile through the production deferred renderer at the
  `high` quality tier, with a `LightGrid` baked from the edited chunks,
  furniture proxy shadows (ring masks cross chunk seams, since the editor
  places pieces anywhere) and the look's panel glow and troffer face (see
  engine-improvement chapters 13 and 14).

## Multilevel structures

Canonical tall structures are global descriptors spanning several chunks and
several floors — Office/Hotel atria (2 chunks × 4–15 storeys, bridged or open
shaft), Tower skybridges (2 chunks × 3 storeys with lethal voids and their own
stairs) and Lattice districts (4×4 chunks × 5 storeys, 64 anchors). A
`ChunkData` holds one floor of one chunk plus the two slab slices bounding it,
so the editor always reasons about the **complete volume**, participants ×
`[baseCy..topCy]`. The DOM-free half lives in `src/editor/structureReview.js`;
the panel is `ui/structurePanel.js`.

- **Discovery**: `discoverStructures(seed, config, box)` asks the planners
  (`structureAt`), never generated chunks, around the view centre for a floor
  range. Structures already carried by document chunks are listed too; each
  row shows band, variant, footprint and a badge — `loaded`, `n/m` (clipped)
  or `—`.
- **Loading**: *load volume* bakes every participant chunk on every storey,
  plus an optional context ring (0–2 chunks), as one undoable step, replacing
  the document or adding to it. A plain procedural bake that cuts through a
  volume is reported as clipped (panel warning, document audit warning) and
  can be completed in place. *Focus* frames the plan, moves into the band,
  cuts a section along the structure's long axis and frames the 3D preview.
- **Storey strip**: one row per storey, top to bottom — the descriptor's
  promise (atrium hall / gallery / + bridge with its deck line / overlook;
  ground court / skybridge / upper gallery with stairs and sockets; street /
  deck levels with anchors and spans) next to what the document holds (floor
  and ceiling openings, deck cells, rails, windows, lethal cells, stairs;
  lamps, furniture and walkable cells in the tooltip) and the audit findings
  on that floor. Click a row to visit the storey.
- **Audit** (`auditStructure`): the shared `auditLayeredPatch` over the volume
  (stair halves and links, slab-opening agreement, structure slices, lethal
  halves, stray features, missing slices, closed bridge seams, family
  adapters) plus coverage and the family's connectivity rule. Office/Hotel
  atria own no stairs — their floors reach the world through ordinary slab
  stairs anywhere in the district — so each storey must be one planar
  component; Tower and Lattice volumes own their vertical links, so the whole
  volume must be one walk component (`walkComponents` mirrors the layered
  audit's graph and keeps a representative cell for every stranded pocket).
  Every finding is located: clicking it switches floor, centres the plan,
  moves the section cut there and flashes the cell. The selected structure's
  audit stays live — it re-runs ~0.5 s after each edit, on selection and
  after a reload or import. A context ring never counts toward connectivity:
  a finite box is only a sample of the infinite world.
- **Drift** (`diffAgainstGenerated`): regenerates the volume's chunks from the
  document's seed and family and lists every changed cell (rasters, lamps,
  furniture at the codec's float32 precision) and descriptor, flagging edits
  to structure-owned cells. A fresh bake — or a reloaded one — has zero drift.
- **Document review**: *audit document* runs the layered audit over every
  stored chunk, reports clipped volumes, and lists planar pockets per floor as
  warnings (they may join through stairs outside the document).
- **Headless**: `npm run review:structures` applies the same review to
  discovered volumes of every family over many seeds (`--family`, `--seeds`,
  `--per-seed`, `--floors y0:y1`, `--tallest`, `-v`) and exits non-zero on any
  failure.

### Review findings (2026-09-26)

Generation (world-gen v25), measured with the tools above:

- `npm run review:structures -- --seeds 10 --per-seed 2 --tallest --floors -4:40`:
  80 complete volumes, 0 failures — 20 Office (the tallest shaft in each
  window: 15 storeys between cy −12 and cy 50; 12 bridged, 8 open), 20 Hotel,
  20 Tower (9 nave, 8 split court, 3 overlook court) and 20 Lattice (80 slices,
  64 anchors, 4–5 stair links each). The default run (shortest volumes:
  4-storey atria, 5-storey open shafts) audits 32 volumes, also 0 failures.
  Every descriptor, slab, slice, lethal-half and seam contract held, and every
  volume met its family's connectivity rule.
- Office/Hotel volumes audited inside a one-chunk context ring report two
  walk components. Each storey is still planar-connected, and a two-chunk
  ring joins them: the split is the finite box cutting the district's
  ordinary stairs, not a stranded area. Connectivity is therefore judged on
  the core volume with the per-family rule above.
- Hotel reuses the Office vertical planner with the same salts, so for the
  same seed its atria have the same ids, bands and footprints as Office's.
  This is the documented contract (`structureAt` resolves the office planner
  for hotel); worth knowing when comparing families on one seed.

Editor defects fixed alongside the rework:

- Re-baking duplicated baked room records, and a bake lifted user-drawn rooms
  on the baked floors as extra baked records.
- A procedural bake silently clipped tall volumes (orphan slab halves with no
  indication); it now reports them and they can be completed.
- The floor stepper refit the 3D camera on every floor change; the geometry
  preview's fixed fog hid anything framed beyond ~150 units.
- Structure-owned cells and edges were freely editable (furniture in slab
  openings, lamps in open ceilings, rooms stamped over atria, walls across
  bridge decks).
- Plan redraws evaluated every slab-opening query live; Lattice chunks paid a
  lethal-half validation per cell per frame.

## Explore and debug

`E` (or the source switch) turns the editor into a read-only debugger over the
infinite world of the panel's seed and family (`src/editor/worldSource.js`).
`WorldSource` answers the document's read API — `chunkAt`, `cellAt`,
`wallVAt/wallHAt`, `furnitureAt`, `lampAt`, `meta` — so the plan, section,
3D preview, inspector, audits and simulations run unchanged on it.

- **Streaming:** `chunkAt` never blocks; a miss queues the chunk and the frame
  loop generates queued chunks nearest the view first within ~9 ms per frame
  (LRU cache of 2400 chunks). Views wider than ~520 chunks draw only what is
  cached. Consumers that need a complete region (audits, simulations, the 3D
  window, baking) call `prepare(box)`. Generation time per chunk is recorded
  (the `gen ms` fill and the world stats show averages and the slowest chunk);
  a chunk whose generation throws is reported instead of retried.
- **Structure atlas:** the structures section scans a window of up to 65×65
  chunks and any floor range, for the world's family or every family (Sewer
  included since v26), and summarises counts, average height and bands per
  variant and size class. Bands span ≥ 3 storeys, so the scan samples every third floor. In
  explore mode double-click focuses a structure in its own world (switching
  family/seed when needed); *load volume* copies it into the document.
- **Debug fills:** kind (default), zone election, space identity, semantic
  role, structure ownership (participant tint plus slice/stair tags per
  chunk) and generation time.
- **Inspector** (`src/editor/inspect.js`): pin a cell (probe → inspect, or
  select in explore mode) to see its chunk (zone, family, version, repairs,
  generation time), rasters (kind, space, role, column), all four edges,
  floor/ceiling state and the cause of any opening (stair, slice id, lethal
  plane), stair cells, lamp/furniture/exit, and every descriptor on the chunk
  with lethal halves re-validated. *Log chunk* prints the descriptors as plain
  JSON and exposes them as `window.__editorInspect`.
- **Bake view → document** copies the viewed chunks (floor ±1, at most 9×9)
  into the document for editing, reporting any tall volume it clips.
- The 3D preview in explore mode meshes a 5×5-chunk × 5-floor window around
  the view (*refresh 3D window* re-centres it).

## Structure catalog browser

Top of the **Structures** tab (`ui/catalogPanel.js`, logic in
`src/editor/catalogLab.js`). Pick a family and a size class (all · landmark ·
small · medium · large) to list every structure type that family generates:
its landmark planners (office/hotel atria, tower naves and courts, the
lattice district) and its v26 procedural catalog volumes (see
[World Generation Architecture — v26](worldgen-architecture.md#v26--family-skeletons-and-the-structure-catalog)).
Each row shows a size badge, the name, the storey range, the chunk
footprint, a one-line description and — in its tooltip — the real-world
reference, plus how many the last atlas scan met. The summary line shows the
family's placement budget.

- **Find** searches the Map-tab seed's world of that family outward from the
  view (rings of chunks, ±12 storeys, planner lookups only — nothing is
  generated) and flies the explorer to the nearest instance: explore mode,
  the structure selected, framed, a section through it.
- **Stamp** (document mode) builds that exact recipe at the view centre,
  starting on the current floor, as one undoable step. Missing chunks get the
  family's real fabric (generated without structures; a chunk that would
  carry a Tower/Lattice landmark stays blank), generic stair halves on the
  reserved slabs are removed exactly as the generator reserves them, and the
  volume stamps with its own flights, rails and core. The stamped descriptor
  is a normal catalog volume: the structure list, section, 3D outline,
  audit (`auditStructure`, whole-volume policy) and `.yrmap` round trip all
  treat it like a generated one. A chunk-storey that already holds a
  structure refuses the stamp.
- The command palette (`Ctrl/⌘+K`) lists *Find nearest …* for every
  family's types, so typing “stepwell” or “portman” jumps straight to one. `catalogLab.test.js` stamps and audits every
  family; a sweep of all 39 types × 4 variants audits clean.

## Simulations and the liminal report

`src/editor/simulate.js` runs on either source (the explorer prepares a box
around the probe first; `world radius` and `floors ±` size it):

- **Walk graph:** the layered audit's graph (tested equal): walkable cells,
  owner-resolved thin walls, matched stairs as the only vertical edges
  (cost 3 cells).
- **Distance** (probe): Dial's shortest-walk field from a cell — heat overlay
  under the walls, dead ends, the farthest cell (an exit candidate),
  unreachable cells and per-floor reach.
- **Path A→B** (probe, two clicks, any floors): the shortest route, drawn per
  floor with its stair transitions.
- **Isovist** (probe): what is visible from a cell at eye height using the
  game's own line-of-sight DDA (windows and rails see-through, piers at true
  size, furniture below eye height): polygon, area, deepest and mean
  sightline, compactness.
- **Light (floor):** lit-lamp reach with that sight rule and a smooth falloff;
  darkness overlay and dark share, lit/dead fixtures.
- **Liminal report:** per floor — loops, dead-end, decision and articulation
  spaces, Hillier a/b/c/d shares, ICD, integration and intelligibility on a
  space graph of named rooms plus circulation decomposed into convex
  rectangles; darkness and its Moran's I; sightline median/p90, isovist area
  and compactness from deterministic samples; room-layout and chunk-layout
  repetition. Definitions and sources are in
  [the liminal research update](liminal-horror-design.md#research-update-2026-09-26-liminality-horror-layout-and-new-map-kinds).
- **Lighting lab** (`src/editor/lighting.js`): *relight circuits/zones*
  re-assigns the floor's lamp failures by room/row circuit or 7×7-cell breaker
  zone with the same number of dead fixtures (undoable), and reports darkness
  and Moran's I before and after.
- **Corpus:** `npm run report:liminal` runs the report over seeds of every
  family and every kind-lab prototype and prints median (p10–p90) per metric
  (`--seeds`, `--radius`, `--family`, `--prototypes`, `--json`).

## Authoring structures

The author tool (`0`) places templates from `src/editor/templates.js`: drag a
footprint (or click a point) and the preview is the real plan — green with the
structure's label, red with the refusing contract. Applying is one undoable
operation recorded in `map.authored`; the structures list shows authored
structures (magenta outlines in the plan) with focus, audit and remove.

Multilevel parts come from `src/world/structures/authored.js`, pure builders
that reuse the canonical stamps, so meshing, collision, holes, lighting,
pathfinding and the layered audit treat them like generated geometry:

- **Light well / bridged atrium:** the Office/Hotel multilevel contract at any
  rectangle — atrium hall at the base, windowed galleries, rail overlook on an
  open shaft's top, railed decks every N storeys. The ring must stay inside
  the owning chunks (a one-cell margin from every chunk border), a bridged
  atrium's short side must lie within one chunk (deck rails would otherwise
  land on a neighbour's owned line), a base chunk may carry no other windows or
  rails, and no chunk may already hold a multilevel structure or a stair
  crossing the ring. Authored volumes carry only slab slices, never
  `data.structure` (they are not planner output).
- **Endless stairwell:** a switchback core — one canonical stair flight per
  slab, alternating between two parallel rows, the whole 6×4-cell core carved
  as a stair hall on every floor and optionally enclosed with the same door on
  every floor. The core must sit strictly inside one chunk whose floors hold no
  other stair.
- **Split-level overlook:** a two-storey hall with a stair beside it, visible
  from the hall floor, up to the gallery (the core never touches the hall's
  ring).
- **Twin-void atrium:** two shafts either side of a chunk seam (a chunk holds
  one slab slice per direction), separated by a 2-cell occupied spine.
- **Repetition-anomaly wing:** identical rooms along a 2-cell corridor (the
  first room of each side is furnished by the grammar, its siblings are exact
  copies), exactly one mutated — dark, empty, a column where the lamp was, or
  an extra door into the next room; never the first or last room.
- **Compression-release suite:** two low 3×3 rooms in series releasing into a
  tall open hall.

Removing an authored structure withdraws its slices/stairs and returns the
cells to open floor (undo restores the original fabric).

## Kind lab

*generate kind* builds a whole prototype map into the document from a seed
(`src/editor/prototypes.js`): transit underpass (Exit 8), parking deck, dead
mall, hospital ward and school at night. Each is compiled by a small floor-plan
compiler (walkable cells, explicit room walls and doors; every other cell of
the touched chunks is column-sealed mass, the sewer family's convention — it
shows as posts from above in the 3D cutaway, hidden behind walls at eye
level) plus authored atria and stairwells, and every kind passes the layered
audit with each floor and the whole volume one walkable component (tested,
byte-deterministic per seed). The research behind the kinds and their
measured metrics are in
[the liminal research update](liminal-horror-design.md#research-update-2026-09-26-liminality-horror-layout-and-new-map-kinds).

## `.yrmap` format

Binary, little-endian, varint-heavy, and optimized for sparse finite maps.
Layout (`src/editor/format/yrmap.js`):

```
"YRM1" magic · u8 container version · u8 codec (0 raw, 1 gzip) · payload
payload := meta · rooms · descriptor table · chunks · [authored]
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
authored := count · { json str }         // optional trailing section
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
- `authored` (authored structure records) is an optional trailing section:
  readers that predate it stop after the chunks, and files without it load
  with no authored structures, so the container version is unchanged.

Export downloads `<name>.yrmap`; import accepts a file picker or drag+drop.
The editor also autosaves the document (debounced `.yrmap` bytes encoded as
base64, with gzip when supported) into `localStorage` and restores it on boot
as best-effort reload recovery; storage quota/private-mode failures do not
block explicit export. "New empty" clears the autosave. The format is the
intended future bridge for "play this map" support (a ChunkManager source that
consults the document before the generator).

## Out of scope (this iteration)

- Playing edited maps in the game runtime.
- Editing canonical structure descriptors: canonical structures are loaded,
  reviewed, audited and protected, but their slices, decks and lethal halves
  are not editable (slab openings derive from descriptors, so a raster edit can
  never open or close one). New volumes are authored from templates instead.
- Promoting kind-lab prototypes or lighting-lab strategies into the
  generator: that changes pinned world bytes and needs a versioned
  release-evidence refresh.
