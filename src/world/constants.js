// Shared world + gameplay constants. One source of truth so generation,
// rendering, collision and the entity AI all agree on the grid.

// --- Grid ---
export const CELL = 3 // world units per cell (square)
export const CHUNK = 14 // cells per chunk side
export const CHUNK_WORLD = CELL * CHUNK // world units per chunk side (42)

export const WALL_H = 3.2 // low drop-ceiling height (claustrophobic)

// (Interior layout is the thin-wall edge model — see ChunkData.js / zones/. The
// zone ids and tunables live in config.js + the ZONE_* constants below.)

// --- Streaming ---
export const LOAD_RADIUS = 4 // chunks loaded around the player (Chebyshev)
export const UNLOAD_RADIUS = 5 // hysteresis: dispose only beyond this
export const MAX_BUILDS_PER_FRAME = 2 // amortise generation across frames

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

// --- Camera / fog ---
export const FOV = 72
export const NEAR = 0.05
export const FAR = 240
export const FOG_DENSITY = 0.024
export const FOG_COLOR = 0xc9b873 // warm yellow haze

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
export const LIGHT_MAX = 48 // max lamps shaded per frame (uniform-array cap)
export const LIGHT_RANGE = 13 // lamp reach (world units) before windowed to 0
export const LIGHT_INTENSITY = 1.7 // per-lamp warm contribution (linear, pre-grade)
export const LAMP_QUERY_R = 30 // only consider lamps within this radius as candidates

// Ambient floor + rim (linear). Keeps lamp-less zones dark-but-warm, never black.
// SKY lights up-facing surfaces (floors); GROUND lights down-facing (ceilings).
export const AMBIENT_SKY = 0x4f4628 // hemi up tint (dim warm)
export const AMBIENT_GROUND = 0x3c3622 // hemi down tint (lifted so ceilings read with the floor)
export const RIM_STRENGTH = 0.18 // anime fresnel edge light
// Wrapped diffuse (half-Lambert) factor for the per-lamp N·L. >0 wraps a lamp's
// light around onto grazing / under-facing surfaces (ceilings, wall undersides)
// so floor/roof/walls read consistently lit. The range window still keeps
// lamp-less zones dark. 0 = pure Lambert (old look); ~0.3 = gentle wrap.
export const LAMP_WRAP = 0.3

// Flashlight (analytic cone in the lighting pass)
export const FLASH_RANGE = 26
export const FLASH_INTENSITY = 2.2
export const FLASH_COS_INNER = 0.94
export const FLASH_COS_OUTER = 0.86

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

// Screen-space lamp shadows (raymarch the depth buffer toward the nearest lamps).
// Full-height pillars cast lateral floor shadows from overhead-but-offset lamps,
// which a top-down map can't capture — so we trace the G-buffer depth instead.
export const SHADOW_STEPS = 20 // raymarch steps per shadowed lamp (more = less noise)
export const SHADOW_MAX = 6 // shade at most the N nearest lamps (sorted nearest-first)
export const SHADOW_THICKNESS = 0.7 // view-space occluder thickness window
export const SHADOW_STRENGTH = 0.92

// Effect resolution scales / step counts (perf knobs)
export const AO_SCALE = 0.5 // SSAO at half res
export const AO_SAMPLES = 16 // hemisphere kernel size
export const AO_RADIUS = 0.8 // view-space sample radius
export const AO_BIAS = 0.025
export const AO_INTENSITY = 1.15 // contrast of the occlusion
export const VOL_SCALE = 0.5 // volumetrics at half res
export const VOL_STEPS = 32 // raymarch steps (more = smoother shafts)
export const VOL_LIGHT_MAX = 8 // nearest lamps that in-scatter (caps occlusion cost)
export const VOL_MAXDIST = 46 // clamp march distance (world units)
export const VOL_DENSITY = 0.05 // in-scatter coefficient
export const VOL_PHASE_G = 0.45 // Henyey-Greenstein anisotropy (0 = isotropic; higher = tighter forward beams)
export const VOL_INTENSITY = 0.7 // composite strength of the shafts

// Emissive bloom (selective by matID; fluorescents + exit glow)
export const BLOOM_SCALE = 0.5 // bloom buffers at half res
export const BLOOM_SPREAD = 2.5 // blur step in texels (wider = softer glow)
export const BLOOM_INTENSITY = 0.8

// Posterize cel bands in the grade (higher = smoother gradients)
export const GRADE_LEVELS = 8.0

// --- Thin-wall model (refactor) ---------------------------------------
// World-gen version: bump whenever the algorithm changes the bytes a seed
// produces. Guards the golden determinism test.
export const WORLD_GEN_VERSION = 4

// Interior zones, selected by the low-frequency region field. The registry in
// zones/index.js maps these ids to generator modules.
export const ZONE_OFFICE = 0 // BSP rooms + thin walls + doorways
export const ZONE_PILLARS = 1 // open hall, seamless global column lattice
export const ZONE_WAREHOUSE = 2 // big open space, sparse long wall runs

// Thin-wall geometry / collision tuning.
export const THICK = 0.16 // visual wall slab thickness (world units)
export const WALL_COL_HALF = 0.08 // collision half-thickness of a wall line
export const COL_HALF = 0.4 // freestanding column half-width
export const HEADER_H = 0.5 // doorway lintel header height (stage F)

// Decorative door frames + open leaves (mesh-only — derived from the wall gaps
// in mesh.js, so they touch no generation bytes and need no WORLD_GEN_VERSION
// bump). A single-cell doorway gets a casing: two jamb posts + a lintel filling
// the wall above the DOOR_H (= WALL_H - HEADER_H) opening, standing FRAME_DEPTH
// proud of the THICK wall. A deterministic DOOR_LEAF_FRACTION of doorways also
// show an open door leaf laid flat against the wall (it never blocks the
// passage). DOOR_SALT keys the per-door hash so each doorway looks identical
// across chunk reloads.
export const FRAME_W = 0.14 // jamb casing width along the wall (world units)
export const FRAME_DEPTH = 0.22 // how proud the casing stands from the wall face (> THICK)
export const DOOR_LEAF_THICK = 0.06 // open door panel thickness
export const DOOR_LEAF_FRACTION = 0.5 // fraction of doorways that show an open leaf
export const DOOR_SALT = 0x0d00 | 0 // fixed hash salt for the per-door leaf/hinge choice

// Helpers ---------------------------------------------------------------
export const idx = (lx, lz) => lz * CHUNK + lx
export const chunkKey = (cx, cz) => `${cx},${cz}`
export const worldToChunk = (w) => Math.floor(w / CHUNK_WORLD)
export const worldToCell = (w) => Math.floor(w / CELL)

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
