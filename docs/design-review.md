# Design review — interior architecture and dressing layer

Document status: this is the historical v14–v15 implementation review, verified
against the v24 tree on 2026-07-21. It records what changed in those releases;
current source locations and later feature status are called out where the
original modules were subsequently split or removed. For the current generator
layout, see [World Generation Architecture](worldgen-architecture.md).

Scope: a review of the shipped v14 world against the spatial principles in
[Liminal-horror spatial and systems review](liminal-horror-design.md), plus the
improvement set implemented in that pass (trimwork v2, interior dressing,
wayfinding props). It does not revisit the macro planner.

## Review of the current state

What already works:

- **The macro contract is sound.** Office fabric as continuous background,
  bounded landmark pockets, coherent pier signatures, and a separately scored
  architecture audit match the evidence about boundaries, scale transitions,
  and occlusion. Nothing in this pass touches it.
- **The threshold language is explicit.** `PASSAGE_DOOR` / `PASSAGE_WIDE`
  metadata means rendering never has to guess why an edge is open — the right
  foundation for dressing openings honestly.
- **Fixtures have identity.** Per-lamp tint/flicker/strobe gives the ceiling
  field a pulse; the world does not feel machine-perfect overhead.

Gaps this pass addresses:

1. **Bare elevations.** Walls were single flat slabs from floor to ceiling.
   Real interiors carry a baseboard line and a ceiling line; without them the
   eye gets no scale reference and every wall reads as a raw partition, which
   flattens the "infinite office" uncanny-register into "unfinished level".
2. **One-note joinery.** Every door casing was the same three boards; every
   leaf the same two panels; every window the same cross. Repetition is the
   genre's friend, but *identical* repetition reads as asset-stamping, not as
   an uncanny building. The design doc calls for controlled mutation of
   high-salience properties; joinery is the cheapest place to get it.
3. **Naked structure.** Freestanding posts and monumental piers were extruded
   boxes meeting floor and ceiling with no base or capital — the single most
   "game-asset" silhouette in the frame, worst exactly in the landmark halls
   where the eye lingers.
4. **No wayfinding layer.** The research is explicit that landmarks belong at
   decisions and that visible circulation calms disorientation. The world had
   lamps and the exit anomaly, but no signage, thresholds, or floor-material
   cues marking transitions — the player learns nothing from the floor they
   stand on.
5. **Empty walls and ceilings.** Rooms had no occupation trace: no clocks,
   boards, extinguisher cabinets, vents, radiators. Liminal space needs the
   *suggestion* of use stripped of people — that is the genre's core image.

## Implemented improvements

All of it is deterministic (global-coordinate hashes), purely visual, and
collision-free by construction: the collision raster and navigation graph
never learn about the dressing layer. Trim batches into the existing casing
InstancedMesh; props and signs each add one instanced draw per chunk.

### Doors, frames, windows — redesigned (`src/world/objects/joinery/`)

- **Door casing v2**: jamb + lintel casing now dressed with a wider, shallower
  back-band per jamb, proud corner blocks at the head corners, the existing
  plinths and cap ledge. Depths are staggered (band < jamb < plinth < cap <
  corner) so each layer catches its own cel step and ink line — the drawn
  architrave read. The hard contract is unchanged: nothing intrudes into the
  passage opening (locked by test).
- **Leaf styles**: a dedicated hash slice (`style`, independent of tint and
  swing) selects two-panel (default), three-panel (mid rail molding), or
  louvered (slatted upper half — the utility-closet read). Every leaf also
  gets a metal kick plate. The rare dark-stained "wrong door" beat is kept.
- **Window treatments**: apron board under the stool, and a per-window tone
  selecting the four-pane cross, a single vertical bar, or venetian blinds —
  slatted occlusion against the atrium void is the genre's signature gallery
  detail.

### Interior dressing (`src/world/objects/dressing/`)

- **Baseboards + crown molding** on every full-height wall edge (never on low
  bridge rails). One box straddles the wall plane, dressing both faces.
- **Column bases and capitals** on every freestanding post and monumental
  pier, sized to the shaft — piers finally read as structure.
- **Threshold strips** under every door and wide mouth: a brass floor line
  marking the transition, the floor-level cue the research asks for.
- **Exit signs** on a deterministic subset of doorways, both faces, emissive
  green (blooms; casts no light — a beacon, not a lamp).
- **Hanging blade signs** in corridors and lobbies: a double-faced amber panel
  on a ceiling hanger, bottom edge above door-head height.
- **Ceiling vents**: sparse dark grilles, never over lamps, signs, columns,
  stair runs, or slab holes.
- **Wall props** by adjacent cell kind: clocks and notice boards in rooms and
  lobbies, extinguisher cabinets in corridors — all shallower than the door
  casings the game already ships.
- **Radiators** under every gallery window, both faces.

### Design rationale

- **Legibility without minimap dependence.** Thresholds, exit signs, and blade
  signs put wayfinding *in the world* at decisions, per the landmark research.
- **Controlled mutation.** Door/window variety comes from independent hash
  streams, so mutation never correlates with tint, swing, or placement — the
  corpus stays coherent while no two joinery runs are identical. Critical
  progress never depends on noticing a variant.
- **Occlusion stays honest.** Blinds partially occlude gallery windows the way
  the design doc's occlusion profile wants, without touching sight/collision
  bytes; nothing visual ever fakes a blocker.
- **Pacing.** Exit signs are deliberately sparse (35% of doors) and blade
  signs sparser (12% of circulation cells): beacons are meaningful because
  they are rare, and they never light the room (no light-field entries).

## Status at the end of the first pass

- Semantic room roles and room-scope mutation were still roadmap work at this
  point. Roles shipped in the v15 second pass below and were generalized into
  catalogs/grammars in v21–v23. District-level repetition anomalies remain
  open.
- Service mezzanine, compression-release, twin-void, and repetition-anomaly
  structures were still future reserved-semantic-node work. Tower and lattice
  structure families shipped later; those four specific concepts remain open.
- Props currently have no acoustic or event-socket role; signage could later
  feed the director's cue sockets (a flickering exit sign as a fake-out).

## Second pass — furniture and semantic room roles (v15)

The first pass dressed walls and ceilings; the world still had no occupation
trace at floor level, because anything the player can bump into must exist in
the collision model, not just the renderer. This pass makes furniture real
and gives office rooms semantic identities.

### Collision-real furniture (`src/world/furniture.js`, `src/world/objects/furniture/`)

- **Two-representation contract.** Every piece occupies one cell in the cols
  raster as `COLUMN_FURNITURE`, so enemy pathfinding, minimaps, audits,
  spawn placement and the navigation validator all treat it as blocked —
  exactly like a structural column. The player instead sweeps the piece's
  precise AABB (`ChunkData.furniture`), so a desk collides as a desk (you can
  squeeze behind it) while enemies route around the cell — the same
  cell-granular asymmetry columns already use. Eye-height sight lines pass
  over the low pieces (`columnHalfAt` returns 0 for furniture).
- **Placement** is per-chunk deterministic, office rooms only, with a 2-cell
  border margin (no cross-seam overlap), never on doorway approaches, lamps,
  columns, or slab holes. A connectivity safeguard compares the chunk's
  column-aware component count before/after and rolls back any piece that
  would sever its room — office chunks skip topology repair, so this local
  check replaces it. A quarter of ordinary rooms stay bare: emptiness is
  pacing, and incomplete chair sets read as abandonment, not scatter.
- **Models** keep the anime flat-shape language: desks with leg panels,
  modesty panels, drawer stacks, monitors and keyboards; upholstered chairs;
  conference tables on panel legs; two-door cabinets; copiers with scanner
  lids and output slots; water coolers with blue bottles; potted plants with
  crossed leaf slabs; server racks with vent slots and status LEDs. All parts
  batch into one instanced draw per chunk with per-part tints.

### Semantic room roles (now `src/world/rooms/` + dressing)

- Roles are assigned at district-plan time from each space's stable id and
  size (large rooms: meeting / server / break; mid rooms: copy / archive /
  storage / break; small rooms: rare storage or copy closets), compiled into
  `ChunkData.spaceRole` beside `spaceId`. Topology is untouched — roles steer
  dressing only, which is what keeps the validated plan contracts intact.
- Role-driven composition: meeting rooms get conference islands, break rooms
  always get the water cooler plus a table set, copy rooms stack copiers,
  archives line up cabinets, server rooms fill with racks, storage rooms mix
  cabinets and clutter. Wall props follow: break rooms always pin notice
  boards, server rooms get caution plates instead of homely clutter, meeting
  rooms get more boards.
- The grammar is deliberately sparse and size-gated, so named rooms work as
  landmarks at decisions (per the wayfinding research) rather than as uniform
  wallpaper: a rack row or a cooler is a memory anchor in a sea of offices.

### Current status after the v15 pass

- Role-driven lamp tint and wall bands shipped in v20. Catalog-driven election,
  anchor/whitelist grammars, procedural room shapes, quota backstops, and
  family-specific room vocabularies shipped in v21–v23. Room-local acoustics,
  role-driven door types, and event sockets remain open.
- Special-role adjacency damping (for example, preventing two server rooms
  from sharing a wall) is still unimplemented; composition is controlled by
  family quotas and election windows instead.
- The ambient cue director has a deterministic calm-gated first slice, and the
  audio bus has family-wide acoustics. Descriptor-authored director sockets
  and room-local acoustic propagation remain roadmap work.

## Validation recorded for v15

- At the time, `npm test` reported 351 passing, including `props.test.js` (placement rules,
  determinism, collision-safety invariants), `furniture.test.js` (placement
  contract, precise-AABB collision, model bounds), `roomRoles.test.js`
  (role determinism, distribution, composition), and the rewritten
  `trimwork.test.js` (architrave profile, leaf styles, glazing variants,
  opening-clearance contract).
- `npm run lint`, `npm run build`, and `npm run audit:world` were clean for that
  release. Generation
  moved to `WORLD_GEN_VERSION` 15 (furniture blockers + role grid); golden
  digests re-pinned with furniture records and roles folded in.

Those numbers are a release record, not the current test count. Use the
commands in the repository README for current verification.
