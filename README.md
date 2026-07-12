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

## World generation

The world is generated reproducibly from a text seed. The headless generation
pipeline produces thin-wall `ChunkData`; rendering, collision, AI, minimap, and
debug tools all consume that same topology.

World-gen version 9 adds:

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
- `src/world/audit.js` — 2D seam and canonical layered-connectivity validation
- `src/world/mapTypes.js` — semantic cell and passage vocabulary
- `src/world/pipeline.js` — pure public generation pipeline

Generation is covered by deterministic golden tests, macro-plan and seam
invariants, multi-chunk wall/navigation flood tests, region-distribution tests,
semantic-door checks, and lamp statistics.
