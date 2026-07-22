# Map-generation research and implementation direction

Document status: this is the historical v7–v14 implementation record and
research direction, verified against the world-gen v24 tree on 2026-07-21.
Present-tense statements inside versioned sections describe those releases;
later-status notes identify what subsequently shipped. See
[World Generation Architecture](worldgen-architecture.md) for the current
layout and contracts.

## World-gen v14: room-dominant fabric and bounded landmark courts

v14 fixes the principal expressive-range failure left by the earlier coherent
region field: pillar and warehouse chunks could merge into kilometre-scale open
components even though every topology and seam audit passed. The generator now
treats portal-planned office rooms as its continuous fabric and open archetypes
as finite landmark pockets inside 6x6-chunk macro districts. Ordinary pockets
span 1-2 chunks on each axis; a 30% hero roll expands an elected footprint to
3-4 chunks. A seed-selected checkerboard parity prevents any elected pockets,
ordinary or hero, from being cardinal neighbours. Every pocket retains an
office margin, and the spawn's 3x3 chunk neighbourhood is always office. Under
the shipped profile, the resulting bounds are two chunks on either ordinary
open axis, four on a hero axis, and sixteen chunks in any connected non-office
component.

Warehouse pockets are courts with a pillar perimeter instead of raw warehouse
meeting an office threshold. Pillar halls now use wide bays and a deterministic
per-landmark signature: monumental grid, two-row processional axis, one broken
center bay, or court colonnade. Real 2.2-unit pier width is shared by meshing,
swept collision, placement, LOS/path smoothing, explored and debug maps, while
navigation continues to conservatively block the owning cell. The signature is
recoverable across chunk seams, but its processional axis is not yet aligned to
the office-authored entrance mouth.

The retained bridge-less multilevel shaft now culminates in two low guard rails
on its top axial gallery. This creates a deliberate downward exposure point
without changing the canonical void masks, slab ownership, streaming, or route
graph. A seeded ambient-cue director adds the first pacing-system slice: fake-out
sounds require calm recovery, yield to real vertical threat audio, and can
abstain rather than paying off every scheduled opportunity.

The patch audit now emits a separate architecture verdict beside its unchanged
seam score: office/open share, longest open run, largest open component, and the
normalized configured component cap. Regression tests exercise spawn density,
landmark non-adjacency, and the structural component bound across sampled seed
corpora. `npm run audit:world` makes the larger expressive-range corpus and its
worst seed IDs reproducible. The broader evidence review, structure backlog,
intensity-director direction, and validation gates live in
[liminal-horror-design.md](liminal-horror-design.md).

## World-gen v13: phased landmark bases and a floor-64 ceiling

v13 keeps v12's 4–15-storey geometry and 17-floor cadence, but no longer pins
every horizontal district's landmark bases to global multiples of 17. A new
independent, root-seeded base stream elects one phase per XZ district. Valid
bases are `phase + k * 17`, so different landmarks can meet floor 0 as a bottom
hall, an upper gallery, or no structure at all. The phase is constant through
the district's vertical bands, preserving two clear floors between maximum
15-storey stacks and allowing any participant slice—including negative
floors—to recover the same descriptor without generation-order state.

Landmark descriptors are accepted only when their inclusive `topCy` is at most
64. A candidate that would cross floor 64 is rejected whole rather than
truncated, preserving its height, slab, bridge, and audit contracts. This is a
multilevel-landmark ceiling, not a world boundary: ordinary chunks, stairs, and
streaming remain unbounded on the vertical `cy` axis (world-space Y). World Z
remains the horizontal north/south axis.

## World-gen v12: 15-storey landmarks

v12 extends the v11 atrium/open-void contract without changing its reviewed
two-chunk footprint, inward-facing windows, bridge cadence, or perimeter
ownership. The shipped profile now chooses structures from 4 through 15
storeys and uses a 17-floor vertical period. A maximum-height structure spans
`baseCy` through `baseCy + 14`, leaving two clear floors before the next band;
ordinary world floors remain vertically unbounded.

Configuration normalization accepts 3 through 15 levels and requires a custom
vertical period of at least `maxLevels + 1`; the default is deliberately 17.
At maximum height, a bridged atrium has seven decks at offsets 1, 3, 5, 7, 9,
11, and 13, while `openVoid` retains the same full-height shaft with no decks,
rails, beams, or seam fascia. Ground support, streaming, full-shaft sight,
minimap rendering, and layered audits all consume the complete 15-storey
extent. Because the expanded range and default period intentionally alter
seeded layouts, deterministic output is repinned at `WORLD_GEN_VERSION = 12`.

## World-gen v11: tall two-chunk voids, overlooks, and bridges

v11 replaces v10's isolated two-floor, one-chunk atrium with a building-scale
structure. The shipped profile creates one deterministic structure in each 4x4
horizontal district and 12-floor vertical band. Each footprint is 22x6 cells:
the 22-cell axis is longer than a 14-cell chunk and therefore crosses exactly
one chunk seam. Its height is chosen deterministically from 4 through 10 floors.

### Research translated into generation rules

- [Infinigen Indoors (CVPR 2024)](https://openaccess.thecvf.com/content/CVPR2024/papers/Raistrick_Infinigen_Indoors_Photorealistic_Indoor_Scenes_using_Procedural_Generation_CVPR_2024_paper.pdf)
  generates multi-room, multi-floor buildings from a room-adjacency graph and
  evaluates such constraints as accessibility, narrow passages, room shape,
  and staircase occupancy. Its broader arrangement system separates
  declarative spatial constraints from the solver that realizes them. The
  relevant lesson here is to elect one global structure and reserve its
  circulation/clearance before local room generation, rather than asking two
  independently generated chunks to agree after the fact.
- Hölscher et al., [*Up the down staircase: Wayfinding strategies in multi-level
  buildings*](https://www.sciencedirect.com/science/article/abs/pii/S0272494406000582),
  found that experienced participants preferred a floor-first strategy and that
  it was associated with better wayfinding performance; their architectural
  analysis also identified staircase design as an important obstacle. The
  paper's review discusses visual access and mutual intervisibility as ways to
  rely on immediately visible information instead of memory alone. v11 uses a
  tall, aligned vista as an unmistakable vertical landmark while keeping actual
  routes and bridge approaches explicit.

Those papers do not prescribe this exact atrium design. The two-chunk footprint,
alternating decks, window language, and liminal proportions are project design
decisions informed by their constraint-first and wayfinding observations.

### Canonical structure contract

- **Global election and recovery.** The root seed, district, and vertical band
  elect one immutable descriptor: identity, `bridged`/`openVoid` kind,
  base/top floors, axis, two participant chunks, global bounds, and every deck.
  `multilevelContract` returns it at the canonical anchor, while
  `multilevelStructureAt` lets either participant and any included floor recover
  the same object. The floor-zero spawn chunk is excluded from structures whose
  vertical range crosses floor zero.
- **One long seam-crossing footprint.** The long dimension is normalized to be
  greater than one chunk and less than two full chunks, with an exterior gallery
  ring. The generator owns bounds and bridge lines in global cell coordinates;
  per-chunk slices are merely projections. This makes seam openings, masks,
  beams, windows, and bridge continuation derivable without generation order.
- **Structure before stairs and rooms.** Every slab intersected by a structure
  suppresses stair placement. Office plans reserve the bottom hall, every
  upper gallery ring, current bridge deck, and axial approaches before rooms are
  allocated, so local partitions cannot consume the landmark or its entrances.
- **Separated stable random streams.** Height, kind, axis/position, participant
  pair, and alternating bridge line have independent salts. Changing bridge
  frequency therefore does not silently move or resize structures.

### Physical and visual semantics

- **Bottom hall.** The base floor is solid and walkable while its ceiling opens
  across the footprint. It has no observation windows and no rails. Looking up
  reveals the aligned void through every higher slab instead of a false pane or
  one-floor cap.
- **Bridged atrium.** Long one-cell decks cross the complete 22-cell span on
  alternating upper levels (at least two decks). Successive decks alternate
  between the two center lines. Each is retained in both the floor and ceiling
  masks, has real collision and navigation surface, opens cleanly through the
  participant seam, carries low guards on both void-facing flanks, and receives
  two continuous structural beams. Non-deck levels remain completely open.
- **Bridge-less open void.** `openVoid` removes every intermediate slab cell in
  the footprint. It emits no bridge cells, bridge rails, or support beams; this
  gives the generator a quieter shaft/courtyard landmark instead of making
  every tall volume read as the same crossing puzzle.
- **Windows beside the void.** On every upper floor, every actual perimeter wall
  between the gallery and owning void becomes an observation window. Bridge
  endpoints are open approaches rather than fake windows, and bridge flanks are
  rails. Windows/rails remain movement-blocking but sight-permitting. Ordinary
  walls and the bottom hall cannot acquire these features.
- **Exact holes and fascia.** Each slab slice carries explicit local void and
  bridge cell sets. Floor and ceiling masks match, while fascia is emitted only
  at true solid/void boundaries; the chunk seam is not capped and the two lobes
  beside a bridge retain their exact outlines.

### Streaming, consumers, and validation

- Ordinary streaming still loads only nearby vertical floors. Discovering a
  tall structure queues both participant chunks from base through top, retains
  that stack while its vertical range is relevant, and renders the whole shaft
  instead of clipping the view at `cy +/- 1`. Light spill is accepted only near
  the shared footprint, avoiding chunk-wide illumination leaks.
- Void cells remain invalid for placement and planar A*. Bridge cells stay
  walkable. Ground resolution can fall through the aligned slab holes of a
  complete ten-floor structure to the actual bottom surface. Ceiling fixtures
  are excluded from open cells, and the minimap/debug map distinguish void,
  bridge, window, and rail.
- The layered audit validates matching halves and holes for every slab, exact
  upper windows/rails, the window-free bottom, consistent global descriptors,
  complete participant slices, and open bridge seams. The World debug tool
  reports the visible/current structure ID, kind, base/top, floor count, and
  bridge levels; selecting one expands the audit from the old fixed three-floor
  sample to its complete 4–10-floor span and both participant chunks.

### Liminal-design intent

The structure is simultaneously coherent and uncanny: one repeated global
skeleton makes the building believable, while seed-selected height, orientation,
bridge cadence, and the possibility of a bridge-less void prevent it from
becoming a recognizable prefab. Full-height sightlines reveal floors that are
not immediately reachable, windows turn circulation into layered observation,
and the empty bottom hall exaggerates scale. This supplies a memorable landmark
without resolving the surrounding office/warehouse maze into an ordinary,
fully legible building.

## World-gen v9: plan-aware vertical architecture

v9 keeps v8's shared slab ownership and analytic straight-run stairs, but makes
the vertical structure part of the architectural plan instead of a late raster
exception:

- Every office district enumerates its up/down slab contracts before circulation
  and room allocation. Each stair halo is a `CELL_LOBBY`, its accessible mouth
  is a mandatory circulation endpoint, and rooms cannot consume the reserved
  footprint.
- One deterministic square symmetry is selected per XZ chunk column and applied
  to both alternating parity families. This varies stair orientation and band
  placement between columns while preserving the proof that adjacent slab
  stamps never share cells or owned edge lines.
- Stair tuning is normalized at the contract boundary. Invalid chances, salts,
  or district sizes can no longer silently disable the fallback; the district
  size is kept within the streamed reach guarantee.
- The layered audit validates descriptor pairing, ceiling/floor apertures,
  canonical landing-to-exit links, and connectivity using the same graph as
  navigation. The World debug view exposes these counters for the selected
  floor and its neighbouring slabs.
- Streaming drops obsolete queued chunks after XZ/floor changes, and cross-floor
  pathfinding uses the loaded stair portals rather than assuming a stair lies in
  the direct start/target rectangle.

This is an intentional generation change: seeded default layouts are repinned at
`WORLD_GEN_VERSION = 9`; v8 byte compatibility is not retained.

## World-gen v8 baseline: the layered world (stacked floors + stairs)

v8 turns the single-story world into an unbounded stack of floors, connected by
walkable straight-run stairs generated as part of the map — no level
transitions. The design follows the stacked-discrete-floors lineage (Dwarf
Fortress z-levels, Build-engine TROR) rather than voxels or prefab welding:

- **3D chunk keys.** Chunks are `(cx, cy, cz)`; each floor keeps the full v7
  thin-wall `ChunkData` model. Streaming loads `LOAD_RADIUS_Y = 1` floors
  above/below the player (hysteresis 2, so stair oscillation never rebuilds).
- **Per-layer seeds, identity at layer 0.** `layerSeed(seed, cy)` feeds every
  2D stage (regions, borders, office plans, warehouse structure, lamps) with a
  decorrelated stream per floor — each floor has its own zone geography — with
  zero internal signature changes, and layer 0 stays byte-compatible with v7
  except where stairs land.
- **Slab contracts** (`slab.js`). The slab between layers cy and cy+1 is ONE
  shared object keyed by the LOWER layer — the vertical analogue of the border
  contracts. `slabContract(rootSeed, cx, cz, cy)` decides whether/where a
  stairwell pierces that slab; both layers derive it independently and realize
  matching halves. Existence = hash gate (`stairs.chance`) OR a deterministic
  fallback electing one chunk per `districtChunks²` block per slab — every
  floor has an up- and a down-stair within bounded radius (no stranded floors,
  by construction; locked by a 12×12×5 flood test).
- **The parity scheme.** Even slabs place E/W strips in rows 3-5; odd slabs
  N/S strips in rows 7-10, all inside cells [3..10]². Stamped edges therefore
  never touch owned border lines, neighbour seams, or transition mouths — and
  the up-/down-stamps realized in one layer have disjoint cell AND edge sets
  for every hash value. Conflict-free with no cross-contract recursion.
- **The halo stamp** (`stairStamp.js`, pipeline stage L4.5). Connectivity-safe
  by construction: monotone-carve an open halo pocket around the strip (the
  proven clearing mechanics — anything the guard walls would cut re-routes
  through the halo), then wall the strip boundary, leaving the mouth open.
  Office district plans stay unmutated pre-slice; repairs stay zero. Stamped
  edges are PROTECTED so later exit/spawn clearings can never re-open a guard
  wall. Lamps skip ceiling-hole cells.
- **The dual-raster guarantee.** Stair-shaft guard walls are duplicated into
  BOTH adjacent floors' rasters; the only disagreeing edges are the entry edge
  (open below / back-walled above) and the exit edge (far-end-walled below /
  open above). Collision therefore runs against ONE floor's walls at a time —
  the player's `FLOOR_SWITCH_Y` handoff (and the AI path-follower's mirror of
  it) flips rasters mid-ramp, 0.75u clear of either disagreeing edge.
- **Movement.** The ramp is analytic (`player/ground.js`): flat landing, then
  linear rise over the two run cells, flush with the upper floor. The player
  snaps to ground (gravity is a teleport-safety net only); enemies follow the
  same surface in `followPath`, with stair edges (`landing ↔ exit`, cost
  `STAIR_RUN + STAIR_LAYER_COST`) as the ONLY vertical moves in the A* graph.
  A mid-ramp repath seeds the search from both stair ends.
- **Light and sight.** Lamps are floor-tagged and the pool is floor-FILTERED
  (assignment, not shadowing — lamps are shadowless): same-floor lamps always;
  cy±1 lamps only within `LIGHT_SPILL_R` of a stair aperture (light spills
  down stairwells); cy±2 never. Sight is floor-gated the same way: one floor
  of separation is visible only through a shared stairwell aperture
  (`STAIR_SIGHT_R`); two floors are always blind. Rendering gates other
  floors' chunks to aperture neighbourhoods (plus a full-floor override while
  the player is inside a stair footprint).
- **Map.** The explored map and minimap key per floor; stairs draw as ▲/▼
  glyphs and the disc shows an F0/B1 floor indicator. Each seeded level places
  the exit on a random non-zero layer within ±5 of the floor-0 spawn, displaced
  off stair strips and floor voids deterministically. The trigger requires an
  exact floor match.

Follow-ups deferred by v8 were plan-integrated stair lobbies, coordinated parity
variation, and exits on non-zero floors. All three are now implemented.

## Decision

Keep the deterministic thin-wall `ChunkData` model, global-coordinate ownership,
streaming, collision, and meshing. Replace independent per-chunk layout decisions
with a deterministic **hierarchical macro-plan** in which circulation is designed
before rooms. Do not use Wave Function Collapse (WFC) as the top-level generator.

The recommended order is:

```text
seed + macro coordinate
  -> shared edge/portal contracts
  -> district/archetype profile
  -> semantic space/adjacency graph
  -> primary and secondary circulation
  -> constrained room allocation
  -> explicit doors and wide passages
  -> validation and deterministic repair
  -> slice requested ChunkData
  -> room-aware lights, columns, and anomalies
```

The default v7 plan is a 3x3-chunk macro-plan: 42x42 cells, or 126x126 world
units; `districtChunks` controls other sizes. The default is large enough to
express a spine, branches, rooms, open halls, and transitions, while only a
small number of plans need to be cached around the player.

## Implemented in world-gen v7

World-gen v7 implements the core hierarchy and correctness guarantees from this
direction:

- **Coherent regions:** a deterministic domain-warped field produces broad zone
  regions, and a buffered transition rule inserts pillars cells to prevent
  direct office-to-warehouse edges.
- **Portal-first office planning:** canonical macro-edge contracts are derived
  before circulation. The default 3x3-chunk plan routes their portals through
  shared hubs and branches, allocates rooms afterward, scores a bounded candidate
  set, and emits exact chunk slices from a cached defensive snapshot.
- **Explicit semantics:** every office cell retains a space ID and a room,
  corridor, or lobby role. Every edge retains an explicit wall, interior-open,
  door, or wide-passage kind; adjacency passage kinds are checked against the
  finalized raster rather than inferred later from gaps.
- **Plan-scope validation:** connectivity and internal seam repairs happen on the
  authoritative office plan before scoring and slicing. Metrics cover circulation
  coverage, wall fraction, room geometry and final graph depth, portal misses,
  unsupported doors, seam density, and repair counts. Thin residual fragments
  become connected lobbies, over-deep branches extend circulation structurally,
  and office chunks are not mutated by a post-slice topology pass.
- **Topology and detail fixes:** open zones validate both thin-wall connectivity
  and column-aware navigation. Lamps use feature-keyed global coordinates,
  independent fixture/failure streams, zone phases, and explicit office
  circulation roles. Warehouse wall fragments and structural columns are keyed
  in global coordinates so they continue across seams; transition mouths clear
  obstructing walls and columns, with deterministic topology repair as a safety
  net. Exit/spawn clearings preserve cross-space openings as wide thresholds,
  and a final semantic pass prevents unsupported door frames.
- **Verification:** over 100 tests cover determinism,
  region buffering, edge contracts, direct portal-to-circulation routing, exact
  plan slicing, semantic/raster agreement, seam continuity, topology across seed
  corpora and streamed patches, warehouse structure, and lamp independence and
  coverage. Patch audits also expose openness, mouth/portal coverage, internal
  plan variety, and a combined continuity score.

## Historical v7 follow-ups and their current status

- **Semantic room roles:** named roles shipped in v15 and were generalized into
  family catalogs, quotas, furnishing grammars, and procedural room shapes in
  v21–v23. A full program graph with required adjacency, privacy, and landmark
  roles remains open.
- **Cross-zone portal-first integration:** make office-to-open transition mouths
  inputs to the office macro-plan. They remain explicit wide, lobby-marked
  boundary adapters incorporated after plan slicing; landmark entrance
  alignment remains open.
- **Finer spatial scale:** evaluate a finer planning raster or smaller room bounds
  after profiling the collision, meshing, navigation, and instance-count impact.
  The current generator retains the existing cell scale.
- **Expressive-range and visibility tooling:** automate large-seed histograms,
  diversity plots, sightline distributions, and visibility-graph measures so
  perceptual variety and enclosure are measured alongside topology. Current
  audits added family corpora, office/special-space share, open-run/component
  bounds, layered connectivity, and family-specific evidence; sightline and
  visibility-graph distributions remain future work.

## Pre-v7 diagnosis (historical baseline)

The shortcomings below motivated v7; they are retained as design context and do
not all describe the current implementation.

The pre-v7 generator had strong low-level guarantees but weak architectural
hierarchy:

- Zone selection produced coherent noise regions, but assigned one style to an
  entire 42-unit chunk. Transitions therefore follow the chunk grid.
- Office BSP was solved independently inside each 14x14 chunk. Its spanning tree
  guaranteed reachability, but it had no building-scale program or circulation.
- Global guide rows and columns were carved after BSP. This made routes line up,
  but also created a dense, uniform Manhattan lattice that ignored room intent.
- Every shared chunk border had an opening. This prevented isolation, but produced
  uniformly high permeability instead of meaningful entrances, wings, and ends.
- A missing wall meant room interior, corridor, door, or wide opening.
  `collectDoorways()` had to infer semantics from geometry and could decorate a gap
  that was not intended to be a door.
- Lamps and columns followed chunk-zone rules rather than the function and geometry
  of individual spaces.
- Scale was coarse: `CELL=3` and `office.roomMin=3` made the smallest nominal
  office span nine world units. v7 fixed the topology first; finer scale remains
  staged follow-up work.

## Research target: richer plan representation

In v7, planning lived in `zones/officePlan.js`, with shared contracts in
`border.js`, region selection then in `regions.js`, and semantic types in
`mapTypes.js`. In the current tree those files are
`src/world/zones/officePlan.js`, `src/world/border.js`,
`src/world/zones/regions.js`, and `src/world/mapTypes.js`; room catalogs,
election, furnishing, and shapes were later extracted under `src/world/rooms/`.
The package split below remains an unimplemented extraction sketch, not the
current source tree.

Add a pure planning layer, separate from `ChunkData` compilation:

```text
src/world/planning/
  coordinates.js
  edgeContracts.js
  programGrammar.js
  circulation.js
  roomGrowth.js
  scoring.js
  validatePlan.js
  compileChunk.js
```

A macro-plan should retain semantic information until compilation:

```js
{
  mx, mz,
  archetype,
  portals,       // shared boundary contracts
  spaceId,       // semantic space per cell
  spaces,        // type, target area/aspect, privacy/circulation role
  adjacency,     // required door/open/near relationships
  wallV, wallH,
  passageV, passageH // interior-open, door, wide-open, threshold
}
```

Collision can continue to consume binary wall arrays. Rendering should consume
explicit passage kinds rather than guessing doors from one-cell gaps.

## Generation details and future extensions

v7 implemented shared edge contracts, circulation-before-rooms, BSP-backed
bounded candidates, and feature-keyed random streams. Current v24 also has
catalog-driven role election, procedural room-shape mutation, and declarative
furnishing grammars. It does not have the standalone semantic program graph or
visibility optimizer sketched below.

### 1. Shared portal contracts

v7 generalizes `vBorder()` and `hBorder()` into macro-edge contracts keyed by
seed, the lower macro coordinate, and axis. A contract describes portal position,
width, and passage type. Both adjacent plans can
derive the identical contract without communication or generation-order coupling.

This applies the useful part of Wang tiling: matching edge labels assemble
continuous, non-periodic geometry efficiently. It does not require selecting the
entire layout from a finite tile set.

### 2. Semantic program graph

v7 labels rooms, corridors, and lobbies before chunk compilation. Later
releases added named room roles and family catalogs, but not a general program
graph. Such a graph could add office clusters, service rooms, storage bays,
open halls, column halls, transition lobbies, and landmark/anomaly rooms. Graph
edges would distinguish required doors, wide openings, and desired proximity.

Weighted grammar rules should vary graph shape while retaining a recognizable
circulation hierarchy. District profiles can change grammar weights and scoring
targets instead of invoking unrelated chunk-local algorithms.

### 3. Circulation before rooms

v7 routes portal contracts through selected hubs and branches, then allocates
residual cells to rooms. Future profiles can add alternate spines and loop
distributions. Keep union-find or a
spanning tree as a final connectivity repair, not as the architecture itself.

### 4. Constrained room growth and bounded search

Current procedural room shapes can promote adjacent BSP leaves into compact
non-rectangular rooms, but they are not seeded from a general program graph or
required adjacency weights. A future program-aware generator could grow
rectangular areas first, allow compact L-shapes only for remaining gaps, and
reject deep concavity, thin necks, and extreme aspect ratios. It could generate
a small deterministic candidate set (for example 8–16 plans) and keep the
lowest-cost valid plan.

Hard constraints should include portal realization, required graph adjacency,
reachability, corridor width, and doors that fit a shared wall. Useful soft costs
include target area/aspect, concavity, wall/corner count, route length and turns,
narrow passages, dead-end/loop density, and distance to primary circulation.

The current implementation uses BSP fragments inside every candidate. A future
constrained-growth planner could use BSP as a fast initialization. A
large simulated-annealing solver should not run synchronously during streaming;
best-of-N constructive candidates have a predictable budget.

### 5. Stable random streams and detail placement

Use stage- and feature-keyed randomness rather than one sequential RNG stream:

```js
random(seed, macroX, macroZ, FEATURE_ROOM_SEED, roomId)
random(seed, globalX, globalZ, FEATURE_LAMP, 0)
```

Adding a decoration decision must not reshuffle room topology. Existing integer
hashes can implement this without a new dependency.

Place corridor lights along corridor centerlines, room lights from room bounds,
and structural columns on plan-level structural bays. Minimum-distance/blue-noise
sampling is appropriate for anomalies, damage, and clutter, but not for structural
columns or regular ceiling fixtures. Generate such samples in a macro-plan plus a
halo so streamed chunks remain order-independent.

## Why WFC is not the top-level solution

The original WFC algorithm preserves local example patterns. It does not, by
itself, create a semantic room graph, circulation hierarchy, global reachability,
or stable infinite chunk boundaries. Its author also documents contradictory
states and NP-hard satisfiability. The project has no curated exemplar/tile set
that would justify accepting those costs.

WFC can still be useful inside a finite, already constrained macro-plan for
secondary motifs such as damaged ceiling patches, warehouse shelving, or wall
details. Portals, circulation, and connectivity must be fixed first.

## Validation and expressive-range metrics

Current automated coverage includes request-order determinism, shared portal
contracts, explicit passage semantics, connectivity, room geometry,
family-release evidence, and architecture share/open-run/component bounds.
Sightline and visibility-graph distributions and a universal generation-time
budget remain proposals. The checklist therefore intentionally combines
implemented invariants with future expressive-range measurements:

- macro-plan and chunk bytes are identical regardless of request order;
- adjacent macro-plans realize identical portal contracts;
- every required semantic adjacency has the requested passage type;
- doors are explicit and never inferred from arbitrary open edges;
- every walkable space is reachable and no one-cell pockets remain;
- room area, aspect, and usable-width constraints hold; compactness below the
  configured target incurs a soft score penalty;
- corridor width, turns, branches, dead ends, loops, and route lengths remain in
  configured distributions;
- columns never obstruct passages or principal circulation; lamps cover
  circulation deliberately and never overlap columns;
- macro-plan generation and cache behavior stay within a measured time budget.

Across hundreds of seeds, record histograms rather than checking only minima:
room areas/aspects, corridor coverage, graph degree, cycle density, sightline
length, zone share, landmark spacing, and score-term distributions. Expressive
range plots reveal repetition, parameter insensitivity, and missing map families.

For perceptual coherence, build a coarse visibility graph on sampled patches and
track visible-neighborhood size, clustering coefficient, and mean visual path
length. These distinguish monotonous open grids from spaces with intentional
junctions, landmarks, enclosure, and useful long views.

## Tradeoffs

| Technique | Recommended use | Main tradeoff |
| --- | --- | --- |
| Hierarchical program + constrained growth | Primary generator | More metadata and designer-authored rules |
| Best-of-N scoring | Runtime quality control | Several candidate plans per macroblock |
| Wang-style edge contracts | Seam-safe macro assembly | Contract vocabulary must be complete |
| WFC | Finite detail/motif patches | Contradictions; only local semantics |
| Poisson disk / blue noise | Anomalies and clutter | Requires macro halo for stream determinism |
| Full simulated annealing | Offline reference/tuning only | Slow and variable runtime |
| Finer planning grid | Later scale improvement | More instances and broader collision/path changes |

## Primary sources

- Lopes et al., *A Constrained Growth Method for Procedural Floor Plan
  Generation*: https://publications.tno.nl/publication/104066/Yar9HQ/lopes-2010-constrained.pdf
- Merrell, Schkufza, and Koltun, *Computer-Generated Residential Building
  Layouts*: https://vladlen.info/papers/architecture.pdf
- Raistrick et al., *Infinigen Indoors: Photorealistic Indoor Scenes using
  Procedural Generation*: https://openaccess.thecvf.com/content/CVPR2024/papers/Raistrick_Infinigen_Indoors_Photorealistic_Indoor_Scenes_using_Procedural_Generation_CVPR_2024_paper.pdf
- Gumin, original *WaveFunctionCollapse* implementation and algorithm notes:
  https://github.com/mxgmn/WaveFunctionCollapse
- Cohen et al., *Wang Tiles for Image and Texture Generation*:
  https://graphics.uni-konstanz.de/publikationen/Cohen2003WangTilesImage/index.html
- Bridson, *Fast Poisson Disk Sampling in Arbitrary Dimensions*:
  https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph07-poissondisk.pdf
- Salmon et al., *Parallel Random Numbers: As Easy as 1,2,3* / Random123:
  https://random123.com/
- Turner et al., *From Isovists to Visibility Graphs*:
  https://discovery.ucl.ac.uk/id/eprint/160/
- Smith and Whitehead, *Analyzing the Expressive Range of a Level Generator*:
  https://www.pcgworkshop.com/archive/smith2010analyzing.pdf
