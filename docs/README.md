# Documentation

Last verified on 2026-07-21 against `WORLD_GEN_VERSION = 24` and the current
editor/rendering sources.

## Current reference

- [World Generation Architecture](worldgen-architecture.md) — map families,
  room and structure layers, cache/runtime behavior, audits, and current
  follow-ups.
- [Lighting & Rendering Pipeline](lighting-pipeline.md) — deferred passes,
  lamp-field behavior, graphics tiers, and light debugging.
- [Map Editor](map-editor.md) — editor routes, document semantics, tools, and
  the version-1 `.yrmap` binary layout.

## Versioned design history

- [Map-generation research](map-generation-research.md) — the v7–v14 planning
  and expressive-range research. Its current-status note identifies which
  follow-ups shipped later.
- [Liminal-horror spatial and systems review](liminal-horror-design.md) — the
  research basis, v14 direction, and historical v18 MVP boundary, followed by
  current v24 status annotations.
- [Interior architecture and dressing review](design-review.md) — the v14–v15
  implementation record, with a source-path and feature-status map for v24.

Source code and tests are authoritative when a historical section describes an
older release. The current generator version lives in
`src/world/constants.js`; active profile defaults and release evidence live in
`src/world/config.js`.
