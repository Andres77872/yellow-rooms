# Design review — interior architecture and dressing layer

Scope: a review of the shipped v14 world against the spatial principles in
`liminal-horror-design.md`, plus the improvement set implemented in this pass
(trimwork v2, interior dressing, wayfinding props). This document records what
changed, why, and what remains open; it does not revisit the macro planner.

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

### Doors, frames, windows — redesigned (`trimwork.js`)

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

### Interior dressing (`props.js`, new)

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

## Still open (unchanged roadmap)

- Semantic room roles, repetition-with-mutation at room scope, the intensity
  director, and vertical acoustic cues remain as roadmaped in
  `liminal-horror-design.md`.
- The structure families (service mezzanine, compression-release suite,
  twin-void atrium, repetition-anomaly wing) remain reserved-semantic-node
  work; the dressing layer is intentionally *not* that integration.
- Props currently have no acoustic or event-socket role; signage could later
  feed the director's cue sockets (a flickering exit sign as a fake-out).

## Validation

- `npm test` — 331 passing, including new `props.test.js` (placement rules,
  determinism, collision-safety invariants) and the rewritten
  `trimwork.test.js` (architrave profile, leaf styles, glazing variants,
  opening-clearance contract).
- `npm run lint`, `npm run build`, `npm run audit:world` — clean; world-gen
  bytes are untouched (mesh-layer only, no `WORLD_GEN_VERSION` bump).
