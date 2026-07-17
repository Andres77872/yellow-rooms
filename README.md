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

World-gen version 11 adds tall architectural landmarks:

- one canonical root-seeded structure per horizontal district and vertical
  band, with a 22x6-cell footprint that necessarily crosses exactly two
  adjacent chunks and a deterministic height of 4–10 floors;
- two structure kinds: **bridged** atria retain long, guarded decks on
  alternating upper floors, while **openVoid** shafts leave every intermediate
  slab open and contain no bridge or bridge rail;
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
  guard, and descriptor across the complete 4–10-floor volume.

It retains the earlier hierarchical generation system:

- deterministic stacked floors with shared slab contracts and walkable stairs;
- plan-aware office stair lobbies reserved before rooms and routed into the
  district circulation graph;
- column-stable stair-layout transforms that add variety without allowing the
  up/down stamps on one floor to overlap;
- normalized stair tuning, exact layered integrity audits, and stale-safe 3D
  streaming/navigation queues;
- domain-warped macro regions with guaranteed pillars transitions between office
  and warehouse styles;
- portal-first 3x3-chunk office districts with routed circulation, room
  allocation, explicit doors/wide passages, and plan-level validation;
- semantic cell, space, and passage metadata instead of raster-inferred doors;
- global structural warehouse bays and deterministic connectivity repair;
- independently keyed fixture/dead-lamp rolls and circulation-aware lighting;
- deterministic plan caching with defensive public snapshots.

The design rationale, primary research sources, tradeoffs, and staged follow-ups
are documented in [docs/map-generation-research.md](docs/map-generation-research.md).

## Main generation modules

- `src/world/regions.js` — coherent style regions and transition buffering
- `src/world/zones/officePlan.js` — district contracts, circulation, rooms,
  scoring, validation, and chunk compilation
- `src/world/border.js` — canonical shared-edge ownership
- `src/world/topology.js` — wall and column-aware safety repair for open zones
- `src/world/slab.js` — canonical vertical contracts and fallback stair election
- `src/world/stairStamp.js` — lobby, aperture, guard-wall, and stair realization
- `src/world/multilevel.js` — canonical two-chunk, 4–10-floor structure planning
- `src/world/multilevelStamp.js` — halls, stacked voids, galleries, windows, rails, and bridges
- `src/world/audit.js` — 2D seam and canonical layered-connectivity validation
- `src/world/mapTypes.js` — semantic cell and passage vocabulary
- `src/world/pipeline.js` — pure public generation pipeline

Generation is covered by deterministic golden tests, macro-plan and seam
invariants, multi-chunk wall/navigation flood tests, region-distribution tests,
semantic-door checks, and lamp statistics.
