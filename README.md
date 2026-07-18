# Yellow Rooms

A deterministic, infinitely streamed first-person liminal-space game built with
Three.js and Vite.

## Run locally

```bash
npm install
npm run dev
```

Useful verification commands:

```bash
npm test
npm run audit:world
npm run lint
npm run build
```

## Debug tools

- `F2` — debug panel with four tabs (`1`-`4` to switch): **world** (top-down
  live/explore map with connectivity + seam validators, full-height multilevel
  structure/audit readouts, and the `map click` control to place the stalker or
  teleport the player), **light** (buffer channel viewer,
  live uniform tuning with one-click `copy values`, and an isolated light room),
  **ai** (Stalker + Pursuer inspectors, live params, 3D gizmos), and **perf**
  (fps, frame-time sparkline, draw calls, memory).
- `F3` — freeze/unfreeze the sim while the panel is open.
- `` ` `` (backtick) — lightweight fps / draw-call overlay, no panel needed.
- `?touch=1` / `?touch=0` — force the touch or desktop UI tier.

## World generation

The world is generated reproducibly from a text seed. The headless generation
pipeline produces thin-wall `ChunkData`; rendering, collision, AI, minimap, and
debug tools all consume that same topology.

World-gen version 14 makes the room network the dominant world fabric while
retaining the tall architectural landmarks:

- under the shipped profile, elected special pockets are usually 1-2 chunks on
  each axis; a rare hero subset expands to 3-4 chunks, and only hero pockets
  sampled as warehouse become courts. Office margins and non-adjacent election
  cap ordinary connected non-office footprints at four chunks and hero
  footprints at sixteen instead of allowing them to merge for kilometres;
- the spawn's 3x3 chunk neighbourhood is always office and the deterministic
  spawn regression requires at least 57 of its surrounding 81 chunks to remain
  office;
- warehouse interiors are wrapped by colonnades, and pillar halls use wide bays
  with coherent monumental-grid, processional-axis, broken-bay, and court
  signatures. Genuine 2.2-unit piers keep their size in rendering, collision,
  AI sight/path smoothing, placement, and maps;
- expressive-range diagnostics now produce a separate architectural verdict
  from room share, longest open run, and largest open component, beside the
  existing connectivity and seam score.

The retained tall-landmark system provides:

- one canonical root-seeded structure per horizontal district and vertical
  band, using a default 17-floor vertical period and a deterministic
  district-specific base phase, so landmarks do not all begin on the player's
  current layer; the 22x6-cell footprint necessarily crosses exactly two
  adjacent chunks and height is chosen deterministically from 4–15 storeys;
- landmark top floors are capped inclusively at floor 64 (`cy = 64`); ordinary
  generated floors, stairs, and streaming remain unbounded above and below;
- two structure kinds: **bridged** atria retain long, guarded decks on
  alternating upper floors, while **openVoid** shafts leave every intermediate
  slab open and contain no bridge; their top gallery terminates in a guarded
  axial overlook down the complete shaft;
- matching floor/ceiling masks, seam-continuous bridge decks and support beams,
  connected galleries, and plan-aware approaches reserved before office room
  allocation;
- observation windows on every real upper perimeter wall beside the owning
  void, with rails only on bridge flanks; the bottom hall has a solid floor and
  deliberately has no windows or rails, preserving an uninterrupted view up;
- structure-aware rendering, light spill, grounding, and streaming: ordinary
  vertical loading stays local, but a visible structure keeps both chunks and
  its complete base-to-top stack available for the long vertical vista;
- arbitrary-mask slab fascia meshing, void-aware navigation/minimaps, and
  layered audits that validate every structure slice, bridge seam, window,
  guard, and descriptor across the complete 4–15-storey volume.

It retains the earlier hierarchical generation system:

- deterministic stacked floors with shared slab contracts and walkable stairs;
- plan-aware office stair lobbies reserved before rooms and routed into the
  district circulation graph;
- column-stable stair-layout transforms that add variety without allowing the
  up/down stamps on one floor to overlap;
- normalized stair tuning, exact layered integrity audits, and stale-safe 3D
  streaming/navigation queues;
- a domain-warped field that characterizes bounded landmark courts as pillar or
  warehouse spaces without replacing the continuous office-room fabric;
- portal-first 3x3-chunk office districts with routed circulation, room
  allocation, explicit doors/wide passages, and plan-level validation;
- semantic cell, space, and passage metadata instead of raster-inferred doors;
- global structural warehouse bays and deterministic connectivity repair;
- independently keyed fixture/dead-lamp rolls and circulation-aware lighting;
- deterministic plan caching with defensive public snapshots.

Ambient horror pacing also has a deterministic first director slice: distant
fake-out sounds wait for a recovery period, never compete with visible/nearby
threat or a real cross-floor footfall, and sometimes abstain entirely. The same
level seed reproduces the same cue opportunities without affecting generation.

The interior architecture layer dresses the generated topology for rendering
(deterministic from global coordinates, purely visual, collision-free):

- redesigned joinery: stepped architrave door casings with back-bands, corner
  blocks, plinths and caps; two-panel / three-panel / louvered door leaves
  with kick plates; gallery windows with aprons and cross, single-bar, or
  venetian-blind glazing;
- interior dressing: baseboards and crown molding on every full-height wall,
  bases and capitals on every post and monumental pier, brass threshold strips
  under doors and wide mouths, and ribbed radiators under the windows;
- wayfinding and occupation props: emissive exit signs over a subset of doors,
  hanging amber blade signs in corridors and lobbies, ceiling vents, wall
  clocks, notice boards, and corridor extinguisher cabinets.

The generation rationale and history are documented in
[docs/map-generation-research.md](docs/map-generation-research.md). The deeper
liminal-horror research review, structure roadmap, dynamics, and validation
gates are in [docs/liminal-horror-design.md](docs/liminal-horror-design.md),
and the interior-architecture review for the dressing layer is in
[docs/design-review.md](docs/design-review.md).

## Main generation modules

- `src/world/regions.js` — room-dominant macro fabric and bounded landmark election
- `src/world/zones/officePlan.js` — district contracts, circulation, rooms,
  scoring, validation, and chunk compilation
- `src/world/border.js` — canonical shared-edge ownership
- `src/world/topology.js` — wall and column-aware safety repair for open zones
- `src/world/slab.js` — canonical vertical contracts and fallback stair election
- `src/world/stairStamp.js` — lobby, aperture, guard-wall, and stair realization
- `src/world/multilevel.js` — canonical two-chunk, 4–15-storey structure planning
- `src/world/multilevelStamp.js` — halls, stacked voids, galleries, windows, rails, and bridges
- `src/world/audit.js` — 2D seam and canonical layered-connectivity validation
- `src/world/mapTypes.js` — semantic cell and passage vocabulary
- `src/world/pipeline.js` — pure public generation pipeline
- `src/world/trimwork.js` / `src/world/props.js` — joinery and interior
  dressing builders consumed by `src/world/mesh.js`

Generation is covered by deterministic golden tests, macro-plan and seam
invariants, multi-chunk wall/navigation flood tests, region-distribution tests,
semantic-door checks, and lamp statistics. `npm run audit:world` also runs the
reproducible large seed corpus and prints its worst seeds as JSON.
