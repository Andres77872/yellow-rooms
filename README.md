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
(deterministic from global coordinates):

- redesigned joinery: stepped architrave door casings with back-bands, corner
  blocks, plinths and caps; two-panel / three-panel / louvered door leaves
  with kick plates; gallery windows with aprons and cross, single-bar, or
  venetian-blind glazing;
- interior dressing: baseboards and crown molding on every full-height wall,
  stepped bases and capitals on every post and monumental pier, brass
  threshold strips under doors and wide mouths, and ribbed radiators with
  feet and inlet pipes under the windows;
- wayfinding and occupation props: housed emissive exit signs over a subset
  of doors, hanging amber blade signs with frame rails in corridors and
  lobbies, slatted ceiling vents, wall clocks with hands, framed notice
  boards with pinned papers, and glazed corridor extinguisher cabinets.

World-gen version 15 adds collision-real furniture and semantic room roles:

- desks, chairs, conference tables, cabinets, copiers, water coolers, plants,
  and server racks occupy cells as `COLUMN_FURNITURE` navigation blockers;
  enemies, minimaps and audits treat them as blocked while the player sweeps
  each piece's precise AABB, and placement is verified to never sever a room;
- district plans elect per-space roles (meeting / break / copy / archive /
  server / storage) from each room's stable id and size, compiled into
  `ChunkData.spaceRole`; roles drive furniture composition and wall props —
  break rooms always get the water cooler and a pinned notice board, server
  rooms get rack rows and caution plates — while a quarter of ordinary rooms
  stay deliberately bare.

### Map-family profiles (world-gen version 18)

Version 18 keeps **office** as the selected default and release-enables the
bounded **sewer**, **tower**, and **lattice** profiles behind explicit opt-in.
Selection and activation are separate: selecting one profile does not enable,
disable, or otherwise change another profile. Missing selection uses office;
unknown, disabled, or incomplete explicit selections fail before family
geometry or descriptors are emitted.

Use the canonical config helper instead of hand-assembling a profile. It
returns a mutable clone, selects only the requested family, and preserves every
unrelated enable flag:

```js
import { worldConfigForFamily } from './src/world/mapFamily.js'

const sewerConfig = worldConfigForFamily('sewer')
const towerConfig = worldConfigForFamily('tower')
const latticeConfig = worldConfigForFamily('lattice')
```

Pass the selected config to the headless generator or assign it as the runtime
world config before starting a level. The helper does **not** bypass a disabled
profile or its release gate.

#### Family audit commands

The office row is mandatory in every invocation and alone owns the unchanged
`0.75` office-share floor. A forced non-office row evaluates its own geometry,
descriptors, pins, corpus, and verdict without entering the office denominator.
Currently enabled emitters are always audited; `--family` additionally forces
the named row even when its release profile is disabled.

```bash
npm run audit:world -- --family sewer
npm run audit:world -- --family tower
npm run audit:world -- --family lattice
npm run audit:world -- --family all
```

Use the final command for the complete release view. The JSON output must keep
independent `office`, `sewer`, `tower`, and `lattice` entries in `familyRows`,
and both `familyVerdict.ok` and the top-level `verdict.ok` must be `true`.

#### Versioning and atomic activation

An inert configuration or code path that cannot change emitted bytes does not
require a version bump. A family's first byte-emitting activation, or any
change to an enabled family's emitted bytes, requires all of the following in
one release change:

1. a higher `WORLD_GEN_VERSION`;
2. regenerated global pins and every relevant maximum-height pin;
3. matching family representative/corpus pins and corpus metadata, including
   profile identity and seed derivation;
4. the explicit family/kind audit adapters and independent family row; and
5. for tower or lattice, passing hard void-death and deterministic-reset
   evidence. Sewer does not depend on that exposed-void safety gate.

Missing or stale evidence blocks activation. One released world-gen version
identifies one pinned byte stream: never publish different bytes under an
already released version number.

#### Independent rollback

Rollback is a release/configuration action, not a runtime family substitution.
Create the candidate config with the canonical helper; it disables only the
named non-office family, preserves unrelated passing families, and returns to
office only when the rolled-back family was selected:

```js
import { rollbackMapFamily } from './src/world/mapFamily.js'

const candidateConfig = rollbackMapFamily('tower', currentConfig)
```

If that family emitted released bytes, the config change is only half of the
rollback. Restore the exact prior byte stream together with its prior version,
global/family/relevant maximum-height pins, corpus metadata, and audit contract,
then validate it against a trusted known-passing release record:

```js
import { validateRollbackEvidence } from './src/world/familyAudit.js'

const rollback = validateRollbackEvidence({
  scope: 'family',
  family: 'tower',
  current,
  restored,
  knownPassing,
})
if (!rollback.ok) throw new Error(rollback.reasons.join(', '))
```

`knownPassing` provenance belongs to the release workflow; synthetic fixtures
are not release pins. Do not remove a family row while its emitter remains
enabled. A shared-foundation rollback must restore one complete known-passing
office profile, pair-enumeration behavior, audit schema, byte stream, version,
and pin set—partial foundation rollback is invalid. Tower and lattice are
independent emitters but retain their shared hard-void safety prerequisite.

These audits prove deterministic release contracts, not frame-time, resident
memory, rendering, or unrestricted pathfinding performance. No performance
guarantee is implied without a separately supplied measurable budget and
matching evidence.

Canonical contract trace: specification `R05-R07`, `R14`, `R20`, and
`R33-R34` in [Version and Pin Policy](.dev/sdd/changes/liminal-map-families-core/spec.md#version-and-pin-policy),
[Audit and Corpus Contracts](.dev/sdd/changes/liminal-map-families-core/spec.md#audit-and-corpus-contracts),
[Hard Void Death and Deterministic Reset](.dev/sdd/changes/liminal-map-families-core/spec.md#hard-void-death-and-deterministic-reset),
and [Family-independent Activation, Rollout, and Rollback](.dev/sdd/changes/liminal-map-families-core/spec.md#family-independent-activation-rollout-and-rollback);
design decisions `D01`, `D10`, and `D11` in the
[technical design](.dev/sdd/changes/liminal-map-families-core/design.md#architecture-decisions).

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
- `src/world/objects/` — organized section for all object definitions:
  `joinery/` (door casings + leaves, window trim), `dressing/` (baseboards,
  wall props, signs, vents), `furniture/` (collision-real piece models);
  consumed by `src/world/mesh.js`
- `src/world/furniture.js` — collision-real furniture placement (models live
  in `src/world/objects/furniture/`)

Generation is covered by deterministic golden tests, macro-plan and seam
invariants, multi-chunk wall/navigation flood tests, region-distribution tests,
semantic-door checks, and lamp statistics. `npm run audit:world` also runs the
reproducible large seed corpus and prints its worst seeds as JSON.
