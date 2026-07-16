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
  live/explore map with connectivity + seam validators; the `map click` control
  places the stalker or teleports the player), **light** (buffer channel viewer,
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

World-gen version 10 adds:

- canonical root-seeded two-floor atrium contracts with matching slab masks;
- wide lower halls, connected upper galleries, retained narrow bridge decks,
  protected bridge guards, and structural drop beams;
- observation windows generated only on gallery edges that look into their
  owning multilevel room, with movement and sight modeled independently;
- plan-aware atrium/bridge approaches reserved before office room allocation;
- arbitrary-mask slab fascia meshing, multilevel visibility/light apertures,
  void-aware navigation, minimaps, and layered integrity audits;

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
- `src/world/multilevel.js` — canonical atrium/bridge contracts and host election
- `src/world/multilevelStamp.js` — hall, void, gallery, window, rail, and bridge realization
- `src/world/audit.js` — 2D seam and canonical layered-connectivity validation
- `src/world/mapTypes.js` — semantic cell and passage vocabulary
- `src/world/pipeline.js` — pure public generation pipeline

Generation is covered by deterministic golden tests, macro-plan and seam
invariants, multi-chunk wall/navigation flood tests, region-distribution tests,
semantic-door checks, and lamp statistics.
