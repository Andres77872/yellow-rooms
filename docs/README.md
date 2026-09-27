# Documentation

Last verified on 2026-09-26 against `WORLD_GEN_VERSION = 26` and the current
editor/rendering sources.

## Current reference

- [Engine improvement research](engine-improvement/README.md) — September 2026
  source audit and primary-source research for semi-realistic materials,
  illumination, modeling, renderer choices, performance requirements, and a
  staged refactor plan. Includes [reference projects and examples](engine-improvement/08-reference-projects.md)
  for games, rendering, animation, and content workflows. The revised plan
  (chapter 12) is implemented; see the
  [implementation record](engine-improvement/13-implementation-record.md) and
  [shadows, quality tiers and visual style](engine-improvement/14-shadows-quality-style.md).
- [Model and engine review](model-engine-review.md) — September 2026 model
  polish, loading/rendering/runtime fixes, comparison metrics, visual QA tools,
  the 2026-09-22 engine architecture/runtime review, and the 2026-09-22
  audio, lighting and anime art-direction pass (with A/B measurements).
- [World Generation Architecture](worldgen-architecture.md) — map families,
  v26 family skeletons and the per-family structure catalog (39 procedural
  small / medium / large volumes), room and structure layers, cache/runtime
  behavior, audits, and current follow-ups.
- [Lighting & Rendering Pipeline](lighting-pipeline.md) — deferred passes,
  render-target lifetimes, lamp-field behavior, graphics/detail tiers,
  frame-wide instrumentation, and render-scene benchmark scope.
- [Map Editor](map-editor.md) — editor routes, the reworked shell (tabs,
  tool rail, command palette, tooltips on every control, shortcut sheet), the
  structure catalog browser (find / stamp every family's types), document
  semantics, tools,
  multilevel structure review (section view, audits, drift, protection),
  authored structure templates, explore/debug mode, simulations and the
  liminal report, the kind lab, the 2026-09-26 structure review findings, and
  the version-1 `.yrmap` binary layout.
- [Furniture asset pipeline](furniture-pipeline.md) — Blender → GLB build for
  the collision-real furniture kinds and the box-builder fallback contract.
- [Enemy asset pipeline](enemy-pipeline.md) — Blender → GLB build for the
  Stalker, Pursuer, and Husk figures: analytic skinning, authored clips, the
  AI-driven animator, and the capsule-fallback contract.

## Versioned design history

- [Map-generation research](map-generation-research.md) — the v7–v14 planning
  and expressive-range research. Its current-status note identifies which
  follow-ups shipped later.
- [Liminal-horror spatial and systems review](liminal-horror-design.md) — the
  research basis, v14 direction, and historical v18 MVP boundary, followed by
  current v24 status annotations and the 2026-09-26 research updates (liminal
  properties, horror layout rules, metrics measured per family, the lighting
  lab, prototype map kinds, ranked generator recommendations, and the v26
  structure catalog with its verticality rules and measured family
  distinctness).
- [Interior architecture and dressing review](design-review.md) — the v14–v15
  implementation record, with a source-path and feature-status map for v24.

Source code and tests are authoritative when a historical section describes an
older release. The current generator version lives in
`src/world/constants.js`; active profile defaults and release evidence live in
`src/world/config.js`.
