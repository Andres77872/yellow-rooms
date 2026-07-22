# World Generation Architecture

Verified on 2026-07-21 against world-gen version 24. This documents the current
module layout and runtime performance model; `design-review.md`,
`liminal-horror-design.md`, and `map-generation-research.md` preserve the
versioned design history.

## v24 — the multilayer lattice district

v24 is a lattice-only byte change (every family re-pins because the version
byte folds into every digest, but only lattice geometry moved). The district
grows from a 3×3-chunk, 3-floor, 25-anchor diorama to a **4×4-chunk city
block: five terraced floors and an 8×8 anchor grid at a uniform 7-cell pitch**
(every chunk hosts a 2×2 chamber quad at locals {3, 10}). Narrow one-cell
catwalks over lethal drops remain the family's register; the higher cycle
budget (`cycleRate: [0.12, 0.25]`) makes the deck network read as a looping
block rather than a bare tree.

- **Terraced floor field** (`structures/lattice.js`): each district band picks
  one of four terracing axes (x, z, diagonal, antidiagonal) and hash-draws
  `levels-1` distinct cut positions, so grid-adjacent anchors never differ by
  more than one floor — the invariant every single-flight stair depends on.
- **Accessibility is now a stamped guarantee, not a graph claim.** v23
  physically stranded areas in every district (hashed stair directions
  disconnected from catwalks, vertical-edge decks on the wrong floor, halo
  pockets sealed behind chamber cue rails). v24 fixes the geometry: a vertical
  tree edge owns the lower anchor's cell plus the FULL upper-floor catwalk
  from the upper anchor to directly above that cell, and its stair runs from
  the lower anchor straight toward the upper anchor — directly under that
  catwalk, so the stair top always opens onto its own edge's deck. Chamber
  perimeter rails open wherever a stair halo touches them. The MST is
  conflict-resolved: when two stairs would demand the same chunk slot
  (same column, identical-or-adjacent lower floors), the heavier vertical
  candidate is excluded and Kruskal reruns — a bounded deterministic loop.
  Every adjacent floor pair is bridged by at least one stair (as many as the
  tree needs, not a fixed two).
- **Street level**: the band's bottom floor is real walkable ground
  (`CELL_OPEN`, no boundary rails) — the slab under it is intact, so the old
  fenced `CELL_VOID` plain was fake void the collision model already treated
  as floor. One-storey falls from the first catwalk layer land on the street
  (exposure ≥ 5 m); higher falls still cross their death plane.
- **Audited reachability**: the family audit gained a `reachability`
  dimension — a flood fill over the rasterized district (cells, thin walls,
  stair links, mirroring `pathfind.js`) demanding ONE component, zero
  stranded cells, and every floor populated (`lattice:unreachable-cells`).
  `__tests__/lattice-reachability.test.js` pins the same walk over the audit
  seeds end to end.

## Hotel family (additive at world-gen 23)

The fifth map family, `hotel` (`MAP_FAMILY_HOTEL`), is the second
office-fabric family: an endless residence — guest corridors, bedrooms,
bathrooms, a kitchen and living/dining rooms per district — on the exact
office pipeline. At its v23 introduction it was additive to that release:
pre-hotel family geometry did not move, and the hotel's own byte stream gained
the `HOTEL_GOLDEN` / `HOTEL_GOLDEN_DIGEST` table in `generate.test.js`. The v24
version-byte change subsequently re-pinned hotel alongside every other family.

- **Structure**: `pipeline.js` routes hotel through the office branch (stair
  slabs + canonical multilevel volumes, which read as hotel atria/light
  wells), and `structures/contract.js` `structureAt` resolves the office
  multilevel planner for it. The descriptors carry no `family` field, so all
  ownership/validation flows through the established office adapter. No
  lethal void: `requiresVoidSafety` stays tower/lattice-only. Zones are
  deliberately not re-mixed: pillar halls, warehouse courts and the
  forced-office spawn neighbourhood still elect as landmarks, and only
  `ZONE_OFFICE` fabric furnishes residentially — the "endless residence" is
  residence fabric threaded through office-scale landmarks, not a rezoned
  world.
- **Residential room roles** (`mapTypes.js` `SPACE_ROLE_BEDROOM` /
  `BATHROOM` / `KITCHEN` / `LIVING` / `DINING` / `LAUNDRY`, ids 10–15):
  the household vocabulary, with room types in `rooms/catalog.js` under the
  same anchor/whitelist/grammar contract — a bedroom HAS its bed, a bathroom
  its toilet + vanity, a kitchen its counter run + stove + fridge, a living
  room its sofa + TV wall, a dining room its table island, a laundry its
  washers. The hotel election catalog makes bedrooms the dominant named room
  (quota 5) with bathrooms threaded between (3), one of each communal room,
  linen storage, and a lobby lounge; the institutional roles
  (meeting/break/copy/server/archive/library/office) are not electable.
- **Residential furniture** (`FURN_BED`…`FURN_WASHER`, kinds 12–23): twelve
  new collision-real pieces — bed, nightstand, wardrobe, toilet, vanity sink,
  bathtub, kitchen counter, stove, fridge, TV console, armchair, washer —
  with model builders in `objects/furniture/` and dims in `constants.js`.
  The landmark fixtures (bed, bathroom porcelain, kitchen appliances, the TV
  wall, washers) join `ROLE_MARKER_KINDS`, so they never leak into ordinary
  rooms of any family; nightstand, wardrobe and armchair deliberately stay
  ordinary-theme eligible (they furnish the hotel's unmarked guest rooms).
- **Family-scoped ordinary themes** (`FAMILY_ORDINARY_THEMES` /
  `ordinaryThemesFor`): unmarked hotel rooms draw residential themes
  (sitting nook, guest wardrobe corner, parlor, stash) instead of the office
  set — no desks or whiteboards behind a hotel door. Families without an
  entry keep the office themes byte-for-byte.
- **Ambience**: a `FAMILY_PALETTES.hotel` entry (burgundy carpet, rose-cream
  wallpaper, warm tile ceiling, tungsten lamp cast, wine-dark fog) reusing
  the existing carpet/wallpaper/tile texture styles; `ROLE_LIGHT` and
  `ROLE_BAND` registers for the six residential roles (bedside amber,
  porcelain-cold bathrooms, bright kitchen task light...); debug-map role
  labels/colors in `debug/mapInspect.js`. `AudioBus` also selects a hotel
  acoustic-space profile; all five families have their own reverb/texture
  settings.
- **Selection**: `MAP_FAMILY_ORDER` appends `hotel` (code 4 — established
  codes never re-number), so the title-screen selector, `?family=hotel`, and
  the world-map tool pick it up automatically. The profile carries no knobs
  beyond `enabled`, like Office.
- Contracts are pinned in `rooms.test.js` (`hotel rooms`: election
  separation + bedroom dominance, residential furnishing whitelists, plan
  cache isolation; the quota-fill and role-byte corpora include hotel) and
  the `generate.test.js` hotel golden block.
- At introduction, release evidence in `scripts/audit-worldgen.mjs` audited all four
  non-office families — the hotel row is a forced 32-seed corpus of 3x3x3
  layered patches (a lone office-fabric chunk is not internally connected),
  registered through the office adapter namespace exactly like runtime and
  pinned by `HOTEL_RELEASE_EVIDENCE` (`first-emission`, zero-sentinel
  previous digests, `maximumHeight: null`). The current v24 evidence records
  the v23 hotel digests as its nonzero predecessors. `benchmark:map-families`
  is hotel-aware as well.

## v23 — rooms everywhere, consistent composition

The room layer now covers every map family, and the named-room mix is
guaranteed instead of merely budgeted.

- **Quota backstop** (`rooms/election.js`): after the windowed election
  walk, a dice-free second pass fills any remaining catalog quotas in the
  same deterministic shuffle order, under the same band/wall-free
  constraints. In the v22 corpus office copy rooms under-filled in 19% of
  districts and storage in 16%; now every quota fills in every district of
  the 81-district corpus, at a named-room share of 0.23 (was 0.22).
- **Lattice rooms**: the lattice catalog elects a small infrastructure-only
  mix (server / archive / storage) for the office shell around and beyond
  the structure, and the pipeline furniture pass is now unconditional
  (`pipeline.js` L5.5 — the zone gate moved into `furniture.js`). The shell
  furnishes like any other office floor; lattice decks carry no `CELL_ROOM`
  and stay bare by design.
- **Sewer chamber rooms** (`zones/sewer.js` + `SEWER_CHAMBER_CATALOG` in
  `rooms/catalog.js`): prescribed chamber rects graduate to `CELL_ROOM` with
  a synthetic district-stable space id and a salted per-chamber role roll
  (large chambers lean server, small lean storage; racks/cabinets only).
  Pockets stay `CELL_LOBBY`; unelected chambers stay bare — no office props
  underground. Sewer lamps are descriptor-cadenced, so the relabel does not
  move lighting. The family catalog itself stays empty: sewers have no
  district plan to elect over.
- **Role-byte invariant**: `SPACE_ROLE_*` only rides `CELL_ROOM`. Every
  chunk-time relabel site now clears stale role bytes — the multilevel
  stamp's footprint+ring carve, the lattice raster reset, border-threshold
  slabs (`ZoneGenerator.mark`), and stair halos. A 9×9×3 corpus across all
  five families went from 62 stale cells to 0 (pinned in `rooms.test.js`).
- **Debug map room labels** (`debug/WorldMapTool.js`,
  `debug/mapInspect.js`): role cells cluster by space id (4-connected,
  seam-crossing) and the world-map tool paints the room type at each
  cluster centroid; `room labels` toggle, on by default.
- **Furniture-aware sewer audit** (`scripts/audit-worldgen.mjs`): the
  release fixture's traversable-module contract accepts
  `COLUMN_FURNITURE`-occupied modules — chamber furniture never severs the
  walk graph (build-time component guard, pinned by the sewer no-sever
  corpus in `rooms.test.js`), so only structural columns seal a module. The
  v22 column-free contract predated chamber furnishing.
- Contracts are pinned by the extended `rooms.test.js` (per-family quota
  fill, role-byte invariant, sewer chamber graduation/furnishing/no-sever,
  lattice shell) and `debug/__tests__/mapInspect.test.js` (label clusters).
  Release evidence was re-pinned as v23 (golden tables in
  `generate.test.js`, evidence digests in `config.js`, corpus digests via
  `scripts/audit-worldgen.mjs`).

## v22 — the room catalog

Rooms became a first-class layer: `src/world/rooms/` now owns everything that
makes a carved space read as a NAMED room, and both the room mix and the room
shapes are procedural.

- **Room catalog** (`rooms/catalog.js`): the single declarative source of
  truth. Room types (anchor piece, strict whitelist, furnishing grammar as an
  op program) are shared; per-map-family catalogs decide which types exist in
  that family, their per-district quotas, and the size-banded election
  windows. Office districts elect the full institutional mix — v22 adds
  **library** (shelf runs + a reading island), **private office** (guaranteed
  desk), and **lounge** (sofas + plants) to the six v21 roles. Tower floors
  elect an infrastructure mix (server/storage-heavy, observation lounges, no
  break/copy/library) **and now run the furniture pass** (`pipeline.js`
  L5.5 gates on office OR tower), so tower rooms stopped being sterile.
  Sewer and lattice declared explicitly empty catalogs in v22. The public
  research basis is summarized in `liminal-horror-design.md`.
- **Catalog-driven election** (`rooms/election.js`, moved out of
  `officePlan.js`): the same composition-budgeted, anchor-capacity-gated
  election as v21, but the quotas and windows come from the selected family's
  catalog (`config.mapFamily.selected`); the plan cache signature includes the
  family so two families never share a district plan.
- **Grammar interpreter** (`rooms/furnish.js`, moved out of `furniture.js`):
  role grammars are data (`row` / `conference` / `workstations` / `accent`
  ops) instead of a hardcoded switch. `furniture.js` remains the thin
  per-chunk placement entry (candidate cells, margins, the per-piece
  connectivity guard). Piece-kind constants live in the catalog and are
  re-exported from `furniture.js` for the existing import surface.
- **Procedural room shapes** (`rooms/shapes.js`): after BSP fixes room
  sizes, a corner-exchange pass donates corner rectangles between adjacent
  leaves — the donor becomes an L-room, the receiver grows an alcove. Purely
  a relabeling (no holes possible); the existing fragment/merge/absorb
  passes keep any outcome valid, and the candidate scorer prunes ugly ones.
  ~40% of rooms in the default corpus are now non-rectangular, and internal
  seam-slice pattern variety rose across the whole continuity corpus
  (`continuity.test.js` pins). Knobs: `office.roomShapeChance`,
  `office.roomShapeMaxCut`.
- **Iterative plan generation** (`officePlan.js`): the base candidate pool
  (`office.planCandidates`) still competes on score, but a hard-constraint
  violation no longer fails the district outright — the planner keeps
  drawing salted candidates up to `office.planCandidateLimit` (default 12)
  until a plan satisfies every hard constraint (valid rooms, all stairs and
  multilevel approaches routed), the same finite-retry discipline the sewer
  family uses per chunk. Generation fails only if the whole budget is dry.
- Contracts are pinned by `rooms.test.js` (catalog integrity, per-family
  election separation, shape share, seed-sweep hard-constraint validation,
  tower furnishing) and the extended `roomRoles.test.js` (9-role anchor
  guarantee + whitelists). Release evidence was re-pinned as v22 (golden
  tables in `generate.test.js`, evidence digests in `config.js`, corpus
  digests via `scripts/audit-worldgen.mjs`).

## v21 — coherent room grammar

Rooms are now guaranteed to read as one place: the role a room advertises
architecturally (wainscot band, lighting register) is always backed by the
furniture inside it, and every room draws from exactly one furnishing grammar.

- **Role election** (`zones/officePlan.js` `assignSpaceRoles`) runs AFTER
  circulation, doors, and every lobby promotion settle, so a role can no
  longer go stale on a space that later becomes circulation (v20 left painted
  role bands on ~1% of promoted lobbies). Election is composition-budgeted per
  district — a deterministic shuffle of the final rooms draws from role quotas
  (one break room, one server room, up to two meeting rooms, a few
  copy/archive/storage) instead of independent per-room lotteries. Every
  candidate room must prove it can host its role's anchor furniture:
  `roomFurnishMetrics` mirrors the furnishing layer's candidate contract
  per chunk slice (margin, doorway approaches, the exact lamp-grid cells the
  lamp pass will claim, and cells bordering reserved stair/structure lobbies,
  whose perimeters the stamps may later open as wide mouths).
- **Anchor-first furnishing** (`furniture.js`): each role grammar places its
  signature piece unconditionally before any chance-gated extras — a copy room
  HAS a copier, an archive HAS its shelf rows, a meeting room HAS the table
  and whiteboard — and draws every other piece from a strict per-role
  whitelist (server rooms are racks-only; the meeting fallback to desks is
  gone). In a v20 corpus ~20% of role-room slices missed their anchor; v21
  measures zero across 4,225 chunks.
- **Ordinary-room themes**: unmarked rooms elect ONE theme — bare (25%),
  huddle, workroom, lounge, or stash — keyed on the district-stable space id,
  never on slice-local coordinates, so a room split across a chunk seam makes
  the same call in every slice (v20 furnished 12% of seam-crossing rooms on
  one side only). Each theme owns a strict piece set; the role-marker kinds
  (copier, rack, bookshelf, cooler) never appear in unmarked rooms, so those
  pieces are reliable landmarks.
- **Per-piece connectivity guard**: `addPiece` verifies the chunk's
  column-aware component count at placement time and refuses a severing piece
  (the grammar walks to the next candidate cell). This replaces the v15
  place-then-rollback pass, which could silently strip a whole room's
  furniture when an early piece completed a cut.
- Invariants are pinned by `roomRoles.test.js` (`room coherence`): anchor
  guarantee, role whitelists, one-theme-per-room, no role bands on promoted
  circulation. Release evidence was re-pinned as v21 (golden tables in
  `generate.test.js`, evidence digests in `config.js`, corpus digests via
  `scripts/audit-worldgen.mjs`).

## v20 — per-family identity rework

Each family gained its own art direction and a generation pass grounded in the
research summarized by `liminal-horror-design.md`:

- **Family palettes** (`world/familyPalette.js`): one palette per family drives
  the procedural surface textures (`render/textures.js` — carpet/wallpaper/tile
  for Office, concrete/brick/vault for Sewer, tile/panel for Tower, deck/steel
  for Lattice), the material colors (`render/gbufferMaterials.js`
  `applyFamilyMaterials`), and the deferred lighting environment
  (`DeferredRenderer.applyPalette`: fog, hemispheric ambient, rim, lamp cast,
  post grade). Engine applies it at boot and on family change; the Office
  palette is the unchanged baseline. Render-side only — not part of the
  pinned digests.
- **Sewer generation v2** (`zones/sewer.js`): the cell-filling comb is gone.
  A full-span trunk gallery, prescribed 3×3/2×2 chambers (connected before
  carving, Pittman's seeded-rooms rule), 3–5 variable dead-end service
  branches with a per-branch right-turn coin, and BFS mouth connectors for
  every open seam cell are carved out of solid column-sealed mass. Both
  root-seeded stair strips become manhole rooms (strip + halo lobby), with
  `manholeUp`/`manholeDown` labels on the actual riser cells. Sewer lamps use
  an infrastructure cadence (`lamps.js` `placeSewerLights`): tight on the
  trunk, sparse on branches, one guaranteed live tube per chamber anchor.
  Exit placement raster-validates sewer host chunks (`core/exitPlacement.js`)
  so the clearing always opens into the network.
- **Family dressing** (`objects/dressing/`): Sewer and Lattice replace the
  office layer (`sewer.js`: wall pipes, vault ribs, gutter + grates, valve
  stations, riser hazard bands + lit way-out markers; `lattice.js`: rail
  posts, kick plates with hazard paint near the deep-exposure pier, deck seam
  strips, one accent-lit landmark bollard per pier). Tower keeps the office
  layer plus deck seams and per-floor accent markers at stair landings
  (`tower.js`). Office role rooms get painted wainscot bands (`ROLE_BAND`)
  and role-driven lamp registers (`lampCharacter.js` `ROLE_LIGHT`).
- **Structure tweaks**: the Lattice arterial spine stamps two cells wide
  (`latticeStamp.js`), lattice decks get per-segment under-slung beams with
  heavier steel on the spine (`mesh.js`), and the Tower bottom hall gets an
  inset colonnade on a 3-cell bay (`multilevelStamp.js`).

The generation-byte changes (sewer layout/lamps, lattice spine, tower
colonnade, version field) were re-pinned as v20 release evidence: golden
tables in `generate.test.js`, evidence digests in `config.js`, regenerated
via the audit corpus.

## Layers

The generation stack has five layers, each with a directory:

```
src/world/
  core/          hash, rng, noise — deterministic primitives, no world types
  zones/         per-chunk 2D fabric: election + interior generators
  rooms/         the room layer: catalog, role election, shapes, furnishing
  structures/    multi-floor canonical descriptors: planners, stamps, contract
  (root)         pipeline orchestration, ChunkData, runtime streaming/meshing
```

### rooms/ — named rooms (v22, all families v23)

- `catalog.js` — piece kinds, room types (anchor / whitelist / grammar), the
  per-family catalogs (quotas + election bands), the sewer chamber catalog,
  ordinary themes. The single tuning surface for room mixes.
- `election.js` — plan-time role election over a finished office district
  plan, budgeted by the selected family's catalog, with the v23 quota-fill
  backstop pass; consumed by `zones/officePlan.js`.
- `furnish.js` — the grammar interpreter that lands collision-real furniture
  at chunk build; consumed by `furniture.js` (the per-chunk placement entry).
- `shapes.js` — the BSP corner-exchange pass that makes room shapes
  procedural (L-rooms, alcoves).

### zones/ — the 2D fabric

- `regions.js` — per-chunk zone election. A domain-warped noise field binned by
  `config.zoneBands`, overlaid by one immutable landmark footprint per 6×6-chunk
  macro district (pillar halls, warehouse courts), and a forced-office spawn
  neighbourhood. Pure function of `(cx, cz, seed, config)`.
- `officePlan.js`, `pillars.js`, `warehouse.js`, `sewer.js` — interior
  generators behind the `ZONES` registry (`index.js` / `ZoneGenerator.js`).
- `warehouseFragments.js` — warehouse wall fragments (renamed from
  `warehouseStructure.js`; it never was a "structure" in the descriptor sense).

### structures/ — canonical multi-floor descriptors

Every structure family follows one recovery scheme: split the chunk grid into
K-chunk districts, hash a per-district vertical phase, snap any floor to its
band base, and rebuild an immutable frozen descriptor from any participant
chunk — never from generated ChunkData.

- `districtBand.js` — the shared machinery (district coordinates, vertical
  band phase/base/index, `plannerHash`, participant polygon enumeration,
  `MAX_STRUCTURE_TOP_CY`, `STRUCTURE_VERTICAL_PERIOD`). Previously copied
  three times across the planners; the hash streams are unchanged.
- `multilevel.js` — office-family planner + the slice engine
  (`multilevelStructureSlice`, `chunkMultilevelRooms`), config normalization.
- `tower.js` — tower planner (adjacent pair, three floors, skybridge).
- `lattice.js` — lattice planner (4×4-chunk district, 8×8 anchors terraced
  over five floors, conflict-resolved Kruskal backbone + cycles, one stair
  per vertical edge) and its strict descriptor validator
  (`analyzeLatticeDescriptor`).
- `multilevelStamp.js`, `latticeStamp.js`, `stairStamp.js` — project
  descriptors into ChunkData rasters. All family stamps now share one entry
  contract: the pipeline resolves the descriptor via `structureAt` and passes
  it in (`stampMultilevelRooms(data, structure)`,
  `stampTowerStructure(data, structure)`,
  `stampLatticeStructure(data, structure, profile)`).
- `lethalVoid.js` — the shared lethal-void slab-half carrier
  (`lethalVoidHalfFromSlice`); tower supplies a flat death plane, lattice a
  per-cell exposure-derived one.
- `slab.js`, `stairCells.js` — stair slab contracts and per-cell stair
  descriptors.
- `contract.js` — the single structure boundary (merger of the former
  `structureContracts.js` + `structureAdapters.js`): family dispatch
  (`structureAt`, `structureOwnershipAt`), kind constants, per-family policy
  adapters, slice/ownership validation, lethal-void validation, and the
  fail-closed runtime entry `validatedRuntimeStructure`.

Sewer is deliberately the non-descriptor family: it is a per-chunk zone
generator with its own candidate-retry validation in the pipeline and audit.

### ChunkData carrier fields

The descriptor carriers on `ChunkData` are family-neutral: `data.structure`
(the frozen descriptor), `data.structureUp` / `data.structureDown` (the slab
half slices), `data.lethalVoidUp` / `data.lethalVoidDown`. They were renamed
from `multilevelStructure`/`multilevelUp`/`multilevelDown`, which had grown to
carry tower and lattice descriptors too. **Audit snapshot keys keep the
historical `multilevel*` names** — those digests are pinned release evidence
in `config.js` and must not drift on an internal rename
(`scripts/audit-worldgen.mjs`).

## Performance model

Chunk builds are synchronous on the main thread, amortized at
`MAX_BUILDS_PER_FRAME` (4) by `ChunkManager.update`; `prewarm()` drains the
whole queue behind the title overlay. On top of that, streaming re-validates
every loaded structure chunk each frame (`_discoverStructureRequests` →
`validatedRuntimeStructure`).

That per-frame path is why every pure planner layer is cached. All caches key
on frozen-object identity (WeakMap) or on the full deterministic input, so
they cannot change output — only cost:

| cache | where | keyed by |
|---|---|---|
| resolved family profile | `mapFamily.resolveMapFamily` | raw profile identity → frozen normalized profile |
| office/multilevel descriptor | `multilevel.js` `STRUCTURE_CACHE` | normalized config + `(seed, district, baseCy)` |
| lattice descriptor | `lattice.js` `STRUCTURE_CACHE` | `(seed, district, baseCy, cycleRate)` — canonical profiles pin every other planner input; nulls cached too |
| lattice descriptor analysis | `lattice.js` `ANALYSIS_CACHE` | descriptor identity × profile identity |
| lattice floor geometry | `latticeStamp.js` | descriptor identity × levelCy |
| lattice slices | `latticeStamp.js` `SLICE_CACHE` | descriptor identity × `(cx, cz, lowerCy)` — a floor's `structureUp` and the floor above's `structureDown` are the same frozen object |
| lattice lethal-void halves | `latticeStamp.js` | slice identity |
| runtime validation verdict | `contract.js` `RUNTIME_VALIDATION_CACHE` | descriptor identity × config identity × `(seed, cy)` |

Use the checked-in benchmark for current measurements:

```bash
npm run benchmark:map-families -- --family lattice
```

It reports generation percentiles, descriptor size, observed Node heap delta,
and functional streaming queue/build/resident counts. Results depend on the
host and workload. Without explicit `--budget-*` arguments the command is
report-only and is not a performance acceptance gate. The remaining cold path
is the first lattice descriptor plus analysis for a district band; caching
amortizes subsequent slices but does not establish a universal frame-time
bound.

Known retained cost: a lattice-owned chunk still runs the ordinary L1–L3 zone
pipeline (usually the office interior planner) before the structure stamp
replaces its cell and edge rasters. Skipping that work is **not** byte-neutral:
the stamp resets `cols`, `spaceId`, `spaceRole`, `cellKind`, walls, passages,
features, and furniture, while other generated state remains part of the
pinned output contract. Removing the pre-stamp work therefore requires a
versioned release-evidence refresh, not an unversioned refactor.

## Fixed defects

- `mesh.js` bridge-beam emission assumed office/tower slices
  (`bridgeAxis`/`bridgeLine`). Lattice slices carry `bridgeCells` without
  those fields, producing NaN instance transforms that poisoned the shared
  wall batch's bounding sphere (culling breakage). The block is now guarded on
  `bridgeAxis`/`bridgeLine` presence.
- Lattice aperture re-validation in `Chunk.js` compared slices with double
  `JSON.stringify` per chunk build; the slice cache makes recomputation return
  the stamped object itself, so an identity check now short-circuits it.

## Follow-ups worth considering

- Retire the legacy office structure kinds `'bridged'`/`'openVoid'`
  (planner-written, aliased to `officeMultilevel` in `contract.js`, branched
  on in `audit.js`) in favour of one kind + a `variant` field — touches pinned
  audit vocabulary, so pair it with a release-evidence refresh.
- Move the lattice aperture-region derivation (`Chunk.js`) into the lattice
  adapter in `contract.js` so the adapter abstraction isn't inverted for one
  family.
- The office multilevel cold path would benefit from the same focused profiling
  lattice received; record host and workload before publishing numbers.
- Chunk generation/meshing could move to a worker if build spikes ever matter
  again; the pipeline is already THREE-free and pure.
