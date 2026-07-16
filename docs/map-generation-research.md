# Map-generation research and implementation direction

## World-gen v10: multilevel rooms, observation windows, and bridges

v10 adds a second kind of vertical architecture without weakening v9's stair,
plan, or streaming guarantees. A multilevel room is an explicit two-floor
volume: a wide lower hall, an open slab above it, a connected overlook on the
upper floor, and one long one-cell bridge retained through the void.

- **Canonical ownership.** `multilevelContract(rootSeed,cx,cz,baseCy)` is keyed
  by an even lower floor. Either participating layer derives the same room ID,
  footprint, void cells, and bridge cells independently. A sparse chance plus
  one eligible fallback host per 4x4 district makes rooms discoverable while
  keeping them exceptional.
- **Architectural eligibility.** A contract requires the same non-transition
  zone on both floors, rejects the spawn column, and rejects every stair slab
  touching either layer. The footprint stays within one chunk with a complete
  one-cell gallery ring, so no streaming seam can bisect a void or window run.
- **Plan-first circulation.** Office plans reserve the lower hall and the upper
  ring/bridge before room allocation. Both opposite bridge banks are mandatory
  circulation endpoints; BSP rooms cannot consume the bridge approach.
- **Matched physical slab.** Every footprint cell except the bridge is both a
  lower-ceiling hole and an upper-floor hole. The bridge is a real retained
  slab, not a decorative mesh. Two longitudinal drop beams support its long
  span, and protected low guards cover every deck-to-void edge.
- **Windows only into the volume.** Collision walls and passage semantics stay
  unchanged. A separate wall-feature raster marks observation windows only on
  upper-gallery-to-void edges and rails only on bridge-to-void edges. Both block
  movement/pathfinding but permit sight. Ordinary partitions can never acquire
  a window feature. The deferred renderer uses an open pane framed by an opaque
  sill, lintel, and jambs; true blended glass would require a separate forward
  transparency pass and is intentionally outside the structural change.
- **Arbitrary-hole meshing.** Slab fascia is emitted for each solid/void cell
  boundary rather than for one bounding rectangle. This preserves the two void
  lobes and the complete exposed edge of the retained bridge.
- **Shared consumers.** Void cells fail placement and A*, guarded debug drops
  fall to the real lower floor, bridge decks stay walkable, ceiling-hole lamps
  are rejected, and room bounds participate in adjacent-floor rendering,
  lighting, and entity sight. The minimap leaves void cells unfilled and marks
  bridges/windows/rails explicitly.
- **Validation.** The layered audit pairs descriptors and every slab cell,
  validates room identity, bridge deck retention, approaches, guards, windows,
  columns, and the window-only ownership rule, then floods only real walkable
  surfaces. Forced/default multi-seed corpora, mutation tests, exact mesh-area
  tests, collision-vs-sight tests, and connected 3D patch tests cover the full
  contract.

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

## Staged follow-ups (not included in v7)

- **Semantic room roles:** extend generic rooms into a program graph with service,
  storage, office-cluster, open-hall, landmark, and privacy roles, then use those
  requirements to drive constrained room growth and adjacency scoring.
- **Cross-zone portal-first integration:** make office-to-open transition mouths
  inputs to the office macro-plan. v7 represents them explicitly as wide,
  lobby-marked boundary adapters, but incorporates them after plan slicing.
- **Finer spatial scale:** evaluate a finer planning raster or smaller room bounds
  after profiling the collision, meshing, navigation, and instance-count impact.
- **Expressive-range and visibility tooling:** automate large-seed histograms,
  diversity plots, sightline distributions, and visibility-graph measures so
  perceptual variety and enclosure are measured alongside topology.

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

v7 keeps its current planning implementation in `zones/officePlan.js`, with
shared contracts in `border.js`, region selection in `regions.js`, and semantic
types in `mapTypes.js`. The package split below is a future extraction sketch
for richer program-grammar work; it is not the current source tree.

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

v7 implements shared edge contracts, circulation-before-rooms, BSP-backed
bounded candidates, and feature-keyed random streams. The program grammar,
seeded constrained room growth, and richer visibility optimization below remain
research targets.

### 1. Shared portal contracts

v7 generalizes `vBorder()` and `hBorder()` into macro-edge contracts keyed by
seed, the lower macro coordinate, and axis. A contract describes portal position,
width, and passage type. Both adjacent plans can
derive the identical contract without communication or generation-order coupling.

This applies the useful part of Wang tiling: matching edge labels assemble
continuous, non-periodic geometry efficiently. It does not require selecting the
entire layout from a finite tile set.

### 2. Semantic program graph

v7 labels rooms, corridors, and lobbies before chunk compilation. A future
program graph can add office clusters, service rooms, storage bays, open halls,
column halls, transition lobbies, and landmark/anomaly rooms. Graph edges must
distinguish required doors, wide openings, and desired proximity.

Weighted grammar rules should vary graph shape while retaining a recognizable
circulation hierarchy. District profiles can change grammar weights and scoring
targets instead of invoking unrelated chunk-local algorithms.

### 3. Circulation before rooms

v7 routes portal contracts through selected hubs and branches, then allocates
residual cells to rooms. Future profiles can add alternate spines and loop
distributions. Keep union-find or a
spanning tree as a final connectivity repair, not as the architecture itself.

### 4. Constrained room growth and bounded search

Future program-aware generation can place room seeds using target size and
adjacency weights. Grow rectangular areas first, allow compact L-shapes only for
remaining gaps, and reject deep concavity, thin necks, and extreme aspect ratios.
Generate a small deterministic candidate set (for example 8-16 plans) and keep
the lowest-cost valid plan.

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

The validation checklist combines implemented invariants with the expressive
range measurements that should be added next:

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
