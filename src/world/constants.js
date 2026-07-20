// Shared world + gameplay constants. One source of truth so generation,
// rendering, collision and the entity AI all agree on the grid.

// --- Grid ---
export const CELL = 3 // world units per cell (square)
export const CHUNK = 14 // cells per chunk side
export const CHUNK_WORLD = CELL * CHUNK // world units per chunk side (42)

// Spawn hub: the centre cell of chunk (0,0,0) and its world coordinate.
// Engine, streaming, and debug tools previously each re-derived these.
export const HUB_CELL = (CHUNK / 2) | 0
export const SPAWN_WORLD = (HUB_CELL + 0.5) * CELL

export const WALL_H = 3.2 // low drop-ceiling height (claustrophobic)

// --- Layers (v8: floors stacked along Y) ---
// The world is a stack of unbounded floors; chunk keys are (cx, cy, cz). The
// slab between layer cy and cy+1 is SLAB_T thick and owned by the LOWER layer
// (the same lower-coordinate convention border contracts use). Floor surface
// of layer cy sits at cy*LAYER_H; its ceiling at cy*LAYER_H + WALL_H.
export const SLAB_T = 0.4 // slab thickness between floors
export const LAYER_H = WALL_H + SLAB_T // 3.6 — floor-to-floor height

// (Interior layout is the thin-wall edge model — see ChunkData.js / zones/. The
// zone ids and tunables live in config.js + the ZONE_* constants below.)

// --- Streaming ---
export const LOAD_RADIUS = 4 // chunks loaded around the player (Chebyshev)
export const UNLOAD_RADIUS = 5 // hysteresis: dispose only beyond this
// Ordinary vertical streaming stays small: stairs expose only cy±1 before a
// floor handoff re-centres the load box. A discovered tall-structure contract
// selectively requests and retains its complete base..top stack instead.
// UNLOAD_RADIUS_Y 2 means oscillating on a staircase never rebuilds.
export const LOAD_RADIUS_Y = 1 // layers loaded above/below the player
export const UNLOAD_RADIUS_Y = 2 // vertical hysteresis
export const MAX_BUILDS_PER_FRAME = 4 // amortise generation across frames (27-chunk rows with 3 layers)

// --- Minimap (player-explored fog-of-war) ---
// Reveal radius (in cells) around the player for the HUD minimap. Cells within
// this radius AND with line-of-sight become permanently "seen". Kept small (the
// warm fog hides distant geometry anyway) and far inside LOAD_RADIUS so the
// line-of-sight walk never needs an unloaded chunk. See ui/Minimap + ExploredMap.
export const MAP_REVEAL_R = 6

// --- Player ---
export const PLAYER_R = 0.5 // collision half-extent (AABB) in world units
export const EYE_H = 1.7
export const WALK_SPEED = 5.2
export const SPRINT_SPEED = 8.6
export const ACCEL = 60
// Vertical movement (v8). The player is glued to groundHeightAt while grounded
// (stairs are an analytic ramp, so walking them is pure snap-follow: the ramp
// rises ~0.05u per physics substep, far under GROUND_SNAP); gravity only runs
// as a safety net when the ground drops away faster than GROUND_SNAP.
export const GROUND_SNAP = 0.5 // max snap-to-ground per substep (doubles as climb rate)
export const GRAVITY = 22
export const MAX_FALL_SPEED = 30
// Floor handoff hysteresis: the controller's floor index flips when |feetY -
// floor*LAYER_H| exceeds this. At 2.8 the flip happens mid-ramp, 1.33u along
// the ramp axis from the one stamped edge the two layers' rasters disagree on
// — minus the 0.58 box reach that leaves a 0.75u margin (locked by test).
export const FLOOR_SWITCH_Y = 2.8

// --- Camera / fog ---
export const FOV = 72
// 0.1 (not 0.05) doubles usable depth precision; the closest a wall face can
// get to the eye is ~0.34u (PLAYER_R 0.5 - WALL_COL_HALF 0.08 - head-bob), so
// nothing ever near-clips.
export const NEAR = 0.1
// Far plane sized to the fog horizon, not past it: with FOG_DENSITY 0.014 the
// exp^2 haze is ~98.6% opaque at 180u, and chunks are guaranteed loaded to
// ~147u (LOAD_RADIUS 4 x 42u minus in-chunk position), so nothing pops inside
// the visible range. The old 240/0.024 pair went opaque by ~90u — two thirds
// of the drawn world was invisible mud and the long liminal sight-lines never
// read.
export const FAR = 180
export const FOG_DENSITY = 0.014
// Warm amber haze at the HORIZON. The lighting shader turns this into a
// vertical sky gradient for the void and for the per-pixel fog target (see
// SKY_ZENITH_MULT / SKY_NADIR_MULT), so distant rooms melt into a dreamy amber
// band instead of a flat curtain.
// DELIBERATELY DARK (a deep amber, not a midtone): fog mixing toward a midtone
// pulled shadows up AND lamp pools down into the same mustard — the whole
// frame read as one foggy wash. A dark fog target makes distance RECEDE, so
// lamp pools and silhouettes keep their contrast and the haze reads as depth,
// not as glare. (FOG_DENSITY itself is locked by render-coupling.test.js.)
export const FOG_COLOR = 0x6e5522
// Void/sky vertical gradient, as brightness multipliers on FOG_COLOR:
// looking up fades toward a dark warm void, looking down toward a dim floor
// haze. Keeps unloaded holes from glaring flat amber into dark zones and gives
// the horizon an anime-background glow.
export const SKY_ZENITH_MULT = 0.24
export const SKY_NADIR_MULT = 0.52

// --- Lighting / panels ---
export const PANEL_COLOR = 0xffe6a0

// --- Lamps (ceiling fixtures) ---
// Lamp placement tunables (grid step, per-zone present-chance, dead fraction)
// live in config.js `lamps{}` and are consumed by src/world/lamps.js. Lit lamps
// gapped + sometimes dead, so the world has genuinely unlit zones, and drive the
// deferred light field below.

// --- Deferred lighting (G-buffer pipeline) ---
// Lighting is computed in a fullscreen pass, so we can shade MANY lamps at once
// (not the old 8-light forward cap). LightField uploads the nearest lamps each
// frame; the lighting shader loops them with cel-banded attenuation.
export const LIGHT_MAX = 72 // max lamps shaded per frame (uniform-array cap; loop breaks at the live count)
// Lamp reach + falloff shape the POOLS. The lamp grid is 12u; with the old
// 13u range and quadratic falloff every surface sat inside 3-6 lamp ranges and
// the summed light saturated into one shapeless wash (the "light so dense it
// looks like fog" failure). Range 11 + the shared CUBIC window (lampAtt in
// shaders/common.js, mirrored by ChunkManager.lightAt) makes each fixture cast
// a distinct pool that dies before the next lamp: light has shape again.
// Intensity is re-anchored up so the pool CENTERS stay bright — contrast comes
// from the falloff, not from dimming the world.
export const LIGHT_RANGE = 11 // lamp reach (world units) before windowed to 0
export const LIGHT_INTENSITY = 3.0 // per-lamp warm contribution (linear, pre-grade)
// Lamp candidate radius. Must reach far enough that a lamp's floor pool
// (LIGHT_RANGE) can only appear/disappear where the fog already dominates:
// QUERY_R + LIGHT_RANGE = 73u sits past the 50%-fog distance (~59u at density
// 0.014). The old 30u horizon made pools snap on/off 17-43u away in nearly
// clear air — the single most visible "draw distance" artifact. The last
// LAMP_FADE_BAND units of the radius fade each lamp's contribution to zero in
// the shader, so set-membership changes are invisible rather than a pop.
export const LAMP_QUERY_R = 60
export const LAMP_FADE_BAND = 12
// Cross-floor lamp policy. Lamps are shadowless, so an unfiltered lamp on
// another floor would shine straight through the slab (LIGHT_RANGE 11 >>
// LAYER_H 3.6). The pool is therefore floor-FILTERED: same-floor lamps always
// count; cy±1 lamps count only within LIGHT_SPILL_R of a stair aperture (so
// light visibly spills down stairwells — a beacon, and physically plausible);
// farther floors count only through one continuous tall structure and within
// physical range. A lamp beyond LIGHT_RANGE of an opening could not reach
// through it anyway, so spill radius = LIGHT_RANGE loses nothing.
export const LIGHT_SPILL_R = LIGHT_RANGE
// Ordinary off-floor chunks render only within this Chebyshev ring of a stair
// aperture (plus the stair-footprint override). A discovered tall structure
// renders its complete participating stack. See ChunkManager visibility.
export const APERTURE_VIS_CHUNKS = 1

// Cel ramp for the per-lamp N·L banding (see render/gradientRamp.js). CEL_BANDS
// hard steps on the lit side; CEL_FLOOR keeps a tiny warm step on grazing walls.
// 4 bands (not 6) so the toon terminator reads as deliberate anime shading
// instead of a near-smooth gradient.
export const CEL_BANDS = 4
export const CEL_FLOOR = 0.08
// How much SSAO modulates DIRECT lamp light (0 = none/physical, 1 = full). The
// ambient term always gets full AO; this is a deliberate non-physical contact-
// darkening lever for the direct term.
export const LAMP_AO_MIX = 0.5

// Ambient floor + rim (linear). Keeps lamp-less zones readable, never black.
// SKY lights up-facing surfaces (floors); GROUND lights down-facing (ceilings).
// COOL slate-violet, not warm: the classic anime/cel palette puts warm gold in
// the light and cool blue-violet in the shadow. With every other term warm
// (albedo, lamps, fog, grade) a warm ambient collapsed the frame into
// monochrome olive; the cool fill gives unlit zones their own hue so lamp
// pools read as *light* against them. GRADE_TINT keeps blue >= 0.9 so this
// survives the grade.
export const AMBIENT_SKY = 0x2e3348 // hemi up tint (lights up-facing floors)
export const AMBIENT_GROUND = 0x262236 // hemi down tint (lights down-facing ceilings)
export const RIM_STRENGTH = 0.22 // anime fresnel edge light
export const RIM_POW = 3.0 // fresnel falloff exponent for the rim term
export const RIM_MIX = 0.5 // rim contribution scale (uRimColor * rim * RIM_MIX)
// Rim light decoupled from the warm lamp color: a pale COOL edge light is the
// classic anime treatment and is the one cool accent that survives the warm
// grade. Entities get their own stepped slate-blue rim (see lighting.js) so a
// silhouette down a long corridor reads as a *presence*, not a smudge.
// Barely-cool pale rim: at grazing angles the fresnel term hits whole
// floor/ceiling planes, so a strongly blue rim reads as a grey wash over the
// amber world — keep the coolness a hint, not a hue.
export const RIM_COLOR = 0xdcd8e4
export const ENTITY_RIM = 0x8fa3c8
// Wrapped diffuse (half-Lambert) factor for the per-lamp N·L. >0 wraps a lamp's
// light around onto grazing / under-facing surfaces (ceilings, wall undersides)
// so floor/roof/walls read consistently lit. The range window still keeps
// lamp-less zones dark. 0 = pure Lambert (old look); ~0.3 = gentle wrap.
export const LAMP_WRAP = 0.3

// Per-lamp character (lampCharacter.js). The old lighting flickered EVERY lamp
// in the world in lockstep off one global uniform — a screen-wide pulse no real
// building makes. Each fixture now gets a deterministic identity from its world
// position: a slow individual breathing ripple (small amplitude — fluorescent
// tubes look steady), a subtle colour-temperature drift (aged tubes run
// greener/pinker), and a rare BAD tube that strobes erratically and burns dim.
// The identity is shared by the emissive panel mesh (instanceColor) and the
// cast-light uniforms, so a fixture's glow and its pool never disagree.
export const LAMP_FLICKER_AMP = 0.07 // ± breathing amplitude on healthy tubes
export const LAMP_BAD_CHANCE = 0.07 // fraction of lit tubes that strobe
export const LAMP_BAD_LO = 0.2 // strobe floor (bad tube nearly dies at the bottom)
export const LAMP_BAD_RATE = 9 // stepped-buzz rate (Hz-ish) for bad tubes
export const LAMP_TINT_VAR = 0.045 // per-channel colour-temperature drift (subtle)

// Flashlight (analytic cone in the lighting pass)
export const FLASH_RANGE = 26
export const FLASH_INTENSITY = 2.2
export const FLASH_COS_INNER = 0.94
export const FLASH_COS_OUTER = 0.86
export const FLASH_COLOR = 0xfff0c4 // warm white flashlight tint

// Distance beyond which an entity may despawn/teleport even inside the view
// frustum: the exp^2 fog is >96% opaque here (see render-coupling.test.js), so
// the removal is invisible. Inside this range entities NEVER vanish while the
// player has them in frustum with line of sight — with the thinner fog and the
// persistent entity ink outline, a watched despawn/relocate reads as a pop.
export const ENTITY_VANISH_DIST = 130

// --- Stalker AI / difficulty ------------------------------------------
// The entity reads the local light level (ChunkManager.lightAt) every frame:
// it sprints in the dark and crawls under lamps, and the flashlight beam (a
// stronger, dynamic light) freezes it outright. Holding that beam too long
// breaks the freeze and crashes the player's sanity. Getting close drags the
// player's own speed down. Most of these scale further with the level in
// Stalker.reset(), so difficulty escalates on top of these baselines.
export const STALKER_AMBIENT = 0.1 // light floor for lightAt() (never pure-dark)
export const STALKER_DARK_SPEED = 1.55 // chase-speed mult in full darkness (level scales up)
export const STALKER_LIGHT_SPEED = 0.45 // chase-speed mult in full lamp light
// Proximity drag on the player (feature: closer enemy => slower player)
export const PROXIMITY_SLOW_RADIUS = 6.0 // within this many world units the player slows
export const PROXIMITY_SLOW_MAX = 0.55 // up to 55% slower at point-blank
// Flashlight "stare" backlash (feature: look too long => player affected)
export const STARE_LIMIT_BASE = 2.4 // seconds of holding the beam before the freeze fails (shrinks with level)
export const STARE_SANITY_DRAIN = 0.55 // extra sanity loss per second once past the limit
export const STARE_RECOVER = 0.7 // exposure decay per second when not beaming the entity

// --- Pursuer AI -------------------------------------------------------
// A relentless second entity: always active, never despawns, immune to the
// flashlight. It pathfinds toward the player at a CONSTANT speed below the
// player's walk, so you can open distance but never lose it. If it falls more
// than PURSUER_LEASH behind, it relocates into an off-screen band around the
// player (never on top of you) so it never drops off the leash. Speed scales
// gently with the level; the leash/band stay well inside LOAD_RADIUS so the
// pathfinder always has loaded walls to route through.
export const PURSUER_SPEED_MULT = 0.55 // base chase speed as a fraction of WALK_SPEED (≈2.86 u/s)
export const PURSUER_SPEED_PER_LEVEL = 0.03 // gentle per-level speed-up
export const PURSUER_SPEED_CAP = 0.9 // hard cap (× WALK_SPEED) — always slower than a walking player
export const PURSUER_LEASH = 100 // world units (~100 m): beyond this it relocates
export const PURSUER_BAND_MIN = 45 // relocate annulus inner radius (never closer than this)
export const PURSUER_BAND_MAX = 85 // relocate annulus outer radius (well inside the leash)
export const PURSUER_CATCH = 1.4 // catch distance (slightly wider than the Stalker)
export const PURSUER_SIGHT = 60 // distance gate for the `seen`/tension amp (matches Stalker)
export const PURSUER_REPATH = 0.5 // seconds between path recomputes (throttle)
export const PURSUER_RELOCATE_CD = 1.5 // min seconds between relocations (anti-thrash)
export const PURSUER_SPAWN_GRACE = 2.0 // seconds before it first appears at level start
export const PURSUER_STUCK_REPATH = 0.4 // seconds of ~zero progress before forcing a repath
export const PURSUER_STUCK_RELOCATE = 2.0 // seconds of ~zero progress before a relocate (cooldown-gated)
export const PURSUER_PATH_LEASH = 34 // pathfinder search leash in CELLS (~102 u, covers the full leash)

// --- Stairs / 3D navigation (v8) -------------------------------------
// A stair is a straight run: 1 cell wide x 3 walkable cells on the lower layer
// (flat landing + 2 ascending run cells, rise LAYER_H over 2*CELL ≈ 31°), with
// the exit cell on the upper layer past the ramp top. See world/slab.js.
export const STAIR_STEPS = 12 // rendered step boxes per run (0.3 rise each)
export const STAIR_RUN = 3 // Manhattan cells landing->exit (the A* stair-edge length)
export const STAIR_LAYER_COST = 2 // extra A* cost per floor change (prefer same-floor routes)
export const PATH_VLEASH = 2 // max |dcy| a single A* search attempts
export const CROSS_FLOOR_NODE_MULT = 2 // A* node-budget multiplier when floors differ
export const ENEMY_STAIR_SPEED = 0.8 // enemy speed multiplier on ramps (player keeps a small edge)
// Stairwell sight aperture: parties one floor apart can only see each other
// when BOTH are within this radius of the same stair hole (with per-floor LOS
// to it) — "it's coming up the stairs" reads, nothing leaks through slabs.
export const STAIR_SIGHT_R = 6

// Screen-space lamp shadows (raymarch the depth buffer toward the nearest lamps).
// Full-height pillars cast lateral floor shadows from overhead-but-offset lamps,
// which a top-down map can't capture — so we trace the G-buffer depth instead.
export const SHADOW_STEPS = 20 // raymarch steps per shadowed lamp (more = less noise)
export const SHADOW_MAX = 6 // shade at most the N nearest lamps (sorted nearest-first)
export const SHADOW_THICKNESS = 0.7 // view-space occluder thickness window
export const SHADOW_STRENGTH = 0.92
export const SHADOW_BIAS = 0.04 // view-space near acceptance bias for the depth march (leak vs acne)
export const SHADOW_MAX_DARK = 0.85 // darkest the contact-hardening march returns on a hit
export const SHADOW_SCALE = 0.5 // screen-space shadow mask computed at half res, then bilateral-blurred + upsampled

// Effect resolution scales / step counts (perf knobs)
export const AO_SCALE = 0.5 // SSAO at half res
export const AO_SAMPLES = 16 // hemisphere kernel size
export const AO_RADIUS = 0.8 // view-space sample radius
export const AO_BIAS = 0.025
export const AO_INTENSITY = 1.3 // contrast of the occlusion (crisp corner shading reads as drawn shadow shapes)
export const VOL_SCALE = 0.5 // volumetrics at half res
export const VOL_STEPS = 32 // raymarch steps (more = smoother shafts)
export const VOL_LIGHT_MAX = 8 // nearest lamps that in-scatter (caps occlusion cost)
export const VOL_MAXDIST = 46 // clamp march distance (world units)
// Volumetrics are ACCENT god-rays, not an atmosphere pass. The old
// density/intensity (0.05 / 0.7) with a near-isotropic phase filled the whole
// frame with a soft amber veil — the single biggest "light looks like fog"
// contributor. Low density + a strongly forward phase means the shafts only
// read when looking roughly toward a lamp (a deliberate anime beam), and the
// air stays clear everywhere else.
export const VOL_DENSITY = 0.022 // in-scatter coefficient
export const VOL_PHASE_G = 0.62 // Henyey-Greenstein anisotropy (0 = isotropic; higher = tighter forward beams)
export const VOL_INTENSITY = 0.4 // composite strength of the shafts
export const VOL_OCC_NEAR = 0.05 // volumetric visToLight near acceptance (shaft cutoff vs leak)
export const VOL_OCC_FAR = 4.0 // volumetric visToLight far thickness window

// Emissive bloom (selective by matID; fluorescents + exit glow)
export const BLOOM_SCALE = 0.5 // bloom buffers at half res
export const BLOOM_SPREAD = 3.0 // blur step in texels (wider = softer glow)
export const BLOOM_INTENSITY = 1.0
// HDR boost on the lit tubes' emissive (× the flicker level). Pushes the panel
// core past 1.0 so the tone map rolls it toward white and the selective bloom
// halos it — fixtures read as SOURCES (the anime fluorescent glow), where at
// ~0.9 they used to vanish into an equally-bright ceiling.
export const PANEL_GLOW = 1.7

// Posterize cel bands in the grade (higher = smoother gradients)
export const GRADE_LEVELS = 8.0
// Warm look-tint applied in the grade (linear). Blue at 0.9 keeps the amber
// mood but stops crushing the cool half of the palette — the slate-violet
// ambient, rim light, mint exit glow and violet sanity tones are exactly the
// anime color contrast the old 0.78 was flattening to olive.
export const GRADE_TINT = [1.04, 1.0, 0.9]
// Post-tonemap saturation (1 = neutral). A gentle push toward the clean,
// saturated anime palette; done AFTER tone mapping so it never fights the
// hue-preserving rolloff.
export const GRADE_SAT = 1.18

// Ink outline (Sobel off the G-buffer). Static tunables (LightTool edits live).
// The ink now also fades with the SAME exp^2 fog transmittance as the surfaces
// (outline.js shares the lighting pass's fog-density uniform), so lines die
// exactly when the surface melts into haze — no more ghost-wireframe X-ray at
// distance. The near/far smoothstep below is only a wide safety envelope.
// DEPTH_THRESH is in normalized-depth units (viewZ/FAR): rescaled 0.009->0.012
// when FAR went 240->180 so the same world-space depth step trips an edge.
export const OUTLINE_INK = 0x140e03
export const OUTLINE_THICKNESS = 1.8
export const OUTLINE_DEPTH_THRESH = 0.012
export const OUTLINE_NORMAL_THRESH = 0.3
export const OUTLINE_FADE_NEAR = 0.1
export const OUTLINE_FADE_FAR = 0.95

// --- Thin-wall model (refactor) ---------------------------------------
// World-gen version: bump whenever the algorithm changes the bytes a seed
// produces. Guards the golden determinism test. v19 expands the office
// furniture library (sofa, bookshelf, whiteboard) and its role placement;
// v18 was the first release-eligible bounded Lattice stream; v17 introduced
// the release-eligible bounded Tower/skybridge stream, and v16 introduced
// the release-eligible bounded Sewer stream while preserving Office
// geometry. v15 added the collision-real furniture layer.
export const WORLD_GEN_VERSION = 19

// Interior archetypes. The room-dominant macro planner bounds the two open
// styles; the registry in zones/index.js maps ids to their chunk compilers.
export const ZONE_OFFICE = 0 // district-planned circulation, rooms, and explicit doors
export const ZONE_PILLARS = 1 // bounded hypostyle hall, seamless bay lattice
export const ZONE_WAREHOUSE = 2 // bounded inner court, sparse wall fragments
export const ZONE_SEWER = 3 // release-enabled bounded dry sewer family

// Thin-wall geometry / collision tuning.
export const THICK = 0.16 // visual wall slab thickness (world units)
export const WALL_COL_HALF = 0.08 // collision half-thickness of a wall line
export const COL_HALF = 0.4 // freestanding column half-width
export const MONUMENTAL_COL_HALF = 1.1 // landmark pier half-width (2.2u square)
export const MAX_COL_HALF = MONUMENTAL_COL_HALF
// Lintel/transom band above a doorway. 0.8 (not 0.5) drops the clear opening
// to DOOR_H = 2.4 — a real door height under the 3.2 ceiling instead of a
// near-square gate — and the deeper band reads as a designed transom.
export const HEADER_H = 0.8 // doorway lintel header height

// Decorative door frames + open leaves (mesh-only — selected by explicit
// PASSAGE_DOOR metadata in mesh.js). A single-cell doorway gets a casing: two
// jamb posts + a lintel filling
// the wall above the DOOR_H (= WALL_H - HEADER_H) opening, standing FRAME_DEPTH
// proud of the THICK wall. A deterministic DOOR_LEAF_FRACTION of doorways also
// show the door itself: a PAIR of leaves, each half the framed opening (so the
// closed pair would fill it exactly — realistic ~1.36u doors, not a 2.7u
// gate), swung flat against the flanking wall with one leaf on EACH face, so
// the doorway reads as a door from both rooms. DOOR_SALT keys the per-door
// hash so each doorway looks identical across chunk reloads.
export const FRAME_W = 0.14 // jamb casing width along the wall (world units)
export const FRAME_DEPTH = 0.22 // how proud the casing stands from the wall face (> THICK)
// Door casing dressing (objects/joinery/): plinth blocks at the jamb feet
// and a head cap ledge above the opening give the frame a designed silhouette
// instead of
// three bare boards — bold flat shapes, which is what reads as "anime
// background art" under the cel ramp and ink outline.
export const DOOR_PLINTH_H = 0.16 // plinth block height at each jamb foot
export const DOOR_PLINTH_W = 0.2 // plinth width along the wall (> FRAME_W)
export const DOOR_CAP_H = 0.09 // head-cap ledge height, at the top of the opening
// Observation windows exist only on multi-level room galleries. They are
// open-pane apertures in the opaque deferred renderer: a collision-solid sill,
// lintel and trim communicate the barrier while the eye-height opening reveals
// the atrium. Bridge guards use a low parapet plus a contrasting cap.
export const WINDOW_SILL_H = 0.9
export const WINDOW_HEAD_Y = 2.55
export const WINDOW_TRIM_W = 0.12 // side/head casing width
// Glazing bars sit INSIDE the opening (slimmer and shallower than the casings)
// so they read as window joinery behind the wall face, not as more trim.
export const WINDOW_MULLION_W = 0.06
export const WINDOW_STOOL_H = 0.07 // projecting sill ledge
export const WINDOW_STOOL_DEPTH = 0.3 // deeper than the casing: a ledge you could touch
export const BRIDGE_GUARD_H = 1.05
export const BRIDGE_GUARD_CAP_H = 0.1
export const BRIDGE_BEAM_H = 0.45
export const BRIDGE_BEAM_W = 0.24
export const DOOR_LEAF_THICK = 0.06 // open door panel thickness
export const DOOR_LEAF_GAP = 0.04 // hinge-gap from the jamb edge to the swung-flat leaf (clears the plinth toe)
export const DOOR_LEAF_FRACTION = 0.5 // fraction of doorways that show the open door pair
export const DOOR_SALT = 0x0d00 | 0 // fixed hash salt for the per-door leaf/face choice
// Raised panel moldings dress each leaf's room-side face (the wall-side face
// is hidden against the wall) + a small knob plate at the leading edge. All
// proud of the leaf face; the whole assembly stays flat against the neighbour
// wall cell, so it never intrudes into the passage (collision reads the edge
// bytes). Sizes are fit to DOOR_H 2.4 x half-opening 1.36 leaves with balanced
// 0.24 rails top / middle / bottom.
export const DOOR_PANEL_PROUD = 0.015 // how far a raised panel stands off the leaf face
export const DOOR_PANEL_MARGIN = 0.16 // side margin from leaf edge to panel
export const DOOR_PANEL_TOP_Y = 1.72 // upper panel centre height
export const DOOR_PANEL_TOP_H = 0.88
export const DOOR_PANEL_BOT_Y = 0.64 // lower panel centre height
export const DOOR_PANEL_BOT_H = 0.8
export const DOOR_KNOB_Y = 1.02 // knob height off the floor
export const DOOR_KNOB_W = 0.07 // knob plate size along the leaf
export const DOOR_KNOB_H = 0.16 // knob plate height
// Per-door leaf tint (deterministic from the same doorway hash): most doors
// sit within a narrow painted-cream brightness band; a rare one comes out
// dark-stained — the liminal "something is off with this one" beat.
export const DOOR_TINT_VAR = 0.12 // ± brightness variation on ordinary leaves
export const DOOR_DARK_CHANCE = 0.05 // fraction of leaves that are stained dark
export const DOOR_DARK_TINT = 0.32 // brightness multiplier for a dark-stained leaf

// Door casing v2 (objects/joinery/): the bare jamb+lintel casing is dressed
// with a
// stepped back-band behind each jamb and a proud corner block at each head
// corner — the classic architrave silhouette that reads as drawn moulding
// under the ink outline. Depths stay staggered (band < jamb < plinth < cap <
// corner) so every layer catches its own cel step.
export const FRAME_BAND_W = 0.22 // back-band width along the wall
export const FRAME_BAND_DEPTH = 0.16 // shallower than the jamb casing
export const FRAME_CORNER = 0.24 // corner-block size (square)
export const FRAME_CORNER_DEPTH = 0.26 // proudest element of the assembly
// Leaf style variants, selected per door from a dedicated hash slice
// (doors.js `style`): two-panel (default), three-panel (adds a mid rail
// molding), or louvered (slatted upper half — the utility-closet read).
export const DOOR_PANEL_MID_Y = 1.16 // mid rail molding centre height
export const DOOR_PANEL_MID_H = 0.16
export const DOOR_LOUVER_COUNT = 5 // slats across the upper leaf half
export const DOOR_LOUVER_H = 0.06 // slat height (thickness reads as a step)
export const DOOR_LOUVER_LO = 1.34 // lowest slat centre
export const DOOR_LOUVER_HI = 2.16 // highest slat centre
export const DOOR_KICK_Y = 0.07 // kick-plate centre height
export const DOOR_KICK_H = 0.12 // metal kick plate at the leaf foot

// Window dressing v2 (objects/joinery/): an apron board under the stool, and
// three
// deterministic glazing treatments selected by a per-window tone: the classic
// four-pane cross, a single vertical bar, or venetian blinds (the liminal
// office cliché — slatted light against the atrium void).
export const WINDOW_APRON_H = 0.1 // apron board height under the stool
export const WINDOW_BLIND_SLATS = 6 // venetian slat count
export const WINDOW_BLIND_SLAT_H = 0.12 // slat height (slight overlap read)
export const WINDOW_BLIND_DEPTH = 0.03 // slat depth, inside the aperture
export const WINDOW_BLIND_RAIL_H = 0.08 // head / bottom rail height

// Interior dressing + props (objects/dressing/). Purely visual, deterministic
// from global coordinates, and collision-safe by construction: everything either
// hugs existing walls/columns, lies flat on the floor, or hangs above head
// height, so the collision raster never has to learn about it.
// Baseboards + crown molding on every full-height wall edge turn the bare
// thin-wall slabs into designed interior elevations.
export const BASEBOARD_H = 0.14
export const BASEBOARD_PROUD = 0.03 // depth proud of each wall face
export const CROWN_H = 0.12
export const CROWN_PROUD = 0.04
// Floor threshold strips under doors and wide mouths: a flooring-material
// change that marks the transition line the way real buildings do.
export const THRESHOLD_H = 0.03
export const THRESHOLD_DEPTH = THICK + 0.1
// Column base + capital: freestanding posts and monumental piers get a plinth
// and a flared cap so they read as designed structure, not extruded boxes.
export const COL_BASE_H = 0.24
export const COL_BASE_WIDEN = 0.14 // extra half-width beyond the shaft
export const COL_CAP_H = 0.16
export const COL_CAP_WIDEN = 0.18
// Exit signs surface-mounted on the door header (both faces), on a
// deterministic subset of doorways — a sparse wayfinding beacon in the haze.
export const EXIT_SIGN_CHANCE = 0.35
export const EXIT_SIGN_W = 0.72
export const EXIT_SIGN_H = 0.24
export const EXIT_SIGN_T = 0.07
// Hanging blade signs in corridors/lobbies: a perpendicular double-faced
// panel on a ceiling hanger, bottom edge above door-head height.
export const BLADE_SIGN_CHANCE = 0.12
export const BLADE_SIGN_W = 1.1
export const BLADE_SIGN_H = 0.3
export const BLADE_SIGN_T = 0.05
export const BLADE_SIGN_Y = 2.45 // panel centre height
// Ceiling vents: dark grilles flush under the ceiling, sparse, never over
// lamps, signs, columns, stairs, or slab holes.
export const VENT_CHANCE = 0.12
export const VENT_W = 1.2
export const VENT_D = 0.8
export const VENT_H = 0.06
// Wall-mounted props, one roll per wall edge per face, by adjacent cell kind:
// clocks + notice boards in rooms/lobbies, extinguisher cabinets in corridors.
// All shallower than the door casings that already stand proud of the walls.
export const CLOCK_CHANCE = 0.06
export const CLOCK_SIZE = 0.34
export const CLOCK_Y = 2.05
export const BOARD_CHANCE = 0.08
export const BOARD_W = 1.3
export const BOARD_H = 0.85
export const BOARD_Y = 1.5
export const PROP_PLATE_T = 0.05 // flat wall plates (clock, board)
export const EXT_CHANCE = 0.06
export const EXT_W = 0.3
export const EXT_H = 0.55
export const EXT_T = 0.14
export const EXT_Y = 1.15
// Radiator under every gallery window: a panel with ribs below the stool.
export const RADIATOR_W = 1.6
export const RADIATOR_H = 0.55
export const RADIATOR_T = 0.12
export const RADIATOR_RIBS = 3
// Deterministic salts for the prop/sign/window hash streams.
export const PROP_SALT = 0x3d05 | 0
export const SIGN_SALT = 0x5ea1 | 0
export const VENT_SALT = 0x7e07 | 0
export const WINDOW_SALT = 0x71d0 | 0

// --- Furniture (furniture.js / objects/furniture/) --------------------
// Real, collision-solid office furniture placed into office rooms. Furniture
// cells enter the cols raster as COLUMN_FURNITURE, so navigation, minimaps,
// audits and enemy pathing treat them as blocked like any column; the player
// collides with the precise piece AABB (ChunkData.furniture), not the coarse
// cell. Placement is per-chunk deterministic from global coordinates, keeps a
// 2-cell margin off chunk borders (no cross-seam overlap), skips doorway
// approaches, and rolls back any piece that would split its room's remaining
// walk cells. Lamps and sight lines are unaffected: pieces stay below
// eye height except the cabinet, which still never blocks the collision DDA
// (it stands against a wall, so its cell edge occludes nothing new).
export const FURN_MARGIN = 2 // cells kept clear of each chunk border
export const FURN_SALT = 0x51de | 0
// Desk + chair workstation against a room wall.
export const DESK_W = 1.7
export const DESK_D = 0.85
export const DESK_H = 0.76
export const CHAIR_W = 0.55
export const CHAIR_H = 0.92 // seat + back top
export const CHAIR_SEAT_H = 0.45
// Conference table island for large rooms.
export const TABLE_W = 2.2
export const TABLE_D = 1.1
export const TABLE_H = 0.74
// Tall storage: the only piece that reaches toward eye height.
export const CABINET_W = 0.95
export const CABINET_D = 0.45
export const CABINET_H = 1.85
// Photocopier / water cooler / plant silhouettes.
export const COPIER_W = 0.85
export const COPIER_D = 0.7
export const COPIER_H = 1.05
export const COOLER_W = 0.42
export const COOLER_H = 1.35
export const PLANT_W = 0.5
export const PLANT_H = 1.15
// Server rack: the tallest piece, rows of them in SPACE_ROLE_SERVER rooms.
export const RACK_W = 0.9
export const RACK_D = 0.7
export const RACK_H = 1.9
// Lobby sofa: the break room's "people waited here" landmark.
export const SOFA_W = 1.6
export const SOFA_D = 0.75
export const SOFA_H = 0.9
// Bookshelf: tall archive shelving with book rows.
export const BOOKSHELF_W = 1.15
export const BOOKSHELF_D = 0.35
export const BOOKSHELF_H = 1.85
// Whiteboard: shallow wall-hugging meeting panel (WHITEBOARD_H is the panel
// height; the board floats between 0.7 and 1.8, clear of the baseboard).
export const WHITEBOARD_W = 1.8
export const WHITEBOARD_D = 0.1
export const WHITEBOARD_H = 1.1

// Helpers ---------------------------------------------------------------
export const idx = (lx, lz) => lz * CHUNK + lx
export const chunkKey = (cx, cz) => `${cx},${cz}` // 2D (per-layer internals: plans, audits)
export const chunkKey3 = (cx, cy, cz) => `${cx},${cy},${cz}` // streamed-chunk key
export const worldToChunk = (w) => Math.floor(w / CHUNK_WORLD)
export const worldToCell = (w) => Math.floor(w / CELL)
export const worldToLayer = (wy) => Math.floor(wy / LAYER_H) // layer containing a world height
export const layerY = (cy) => cy * LAYER_H // floor surface height of layer cy

// Floor-modulo that works for negative operands (global lattice phases).
export const fmod = (n, m) => ((n % m) + m) % m

// Edge-array indexing. Walls live on cell EDGES, stored per grid LINE:
//   wallV[vIdx(lx,z)] = vertical wall on the line at world x = lx*CELL,
//                       separating cell (lx-1,z) | (lx,z).  lx in [0..CHUNK-1].
//   wallH[hIdx(x,lz)] = horizontal wall on the line at world z = lz*CELL,
//                       separating cell (x,lz-1) | (x,lz).  lz in [0..CHUNK-1].
//   cols[cIdx(x,z)]   = freestanding column occupying cell (x,z).
// Each chunk OWNS its West line (lx=0) and North line (lz=0); the East/South
// borders are owned & drawn by the neighbour as its line 0 (no duplication).
export const vIdx = (lx, z) => z * CHUNK + lx
export const hIdx = (x, lz) => lz * CHUNK + x
export const cIdx = (x, z) => z * CHUNK + x
