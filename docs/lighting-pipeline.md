# Lighting & Rendering Pipeline

Verified on 2026-07-23 against the current renderer, shaders, graphics settings,
debug tools, and light-field implementation.

The game renders through a custom deferred toon pipeline (`src/render/DeferredRenderer.js`).
There are **no real three.js lights**: lamps are shaded from a uniform field, the
flashlight is an analytic cone, and every effect is a fullscreen pass over a
G-buffer. Per-pass GLSL lives in `src/render/shaders/`; the renderer module owns
render targets, uniforms and per-frame orchestration only.

## Frame anatomy

```
G-buffer (albedo+matID, viewNormal, depth)
  ├─ SSAO          half-res hemisphere kernel + bilateral blur      [tier: off/low/high/ultra]
  ├─ Shadow mask   half-res screen-space march to N nearest lamps   [tier: off/low/high/ultra]
  │                + bilateral blur (contribution-weighted, exact)
  ├─ Lighting      hemispheric ambient + ≤72 cel-banded lamps
  │                + flashlight cone + rim + analytic exp² fog
  ├─ Volumetrics   half-res in-scatter raymarch (lamps + flashlight) [tier: off/low/high/ultra]
  ├─ Bloom         selective by matID (emissive only), separable blur [toggle]
  ├─ Composite     lit + shafts·intensity + bloom·intensity
  ├─ Outline       depth/normal Sobel ink, fog-faded                 [toggle]
  ├─ Grade         tone map → tint → posterize → vignette/grain → sRGB
  └─ FXAA          final LDR pass to screen                          [toggle]
```

Debug channel viewer (`shaders/debugView.js`, F2 → LIGHT tab): modes 1–10 blit
albedo / matID / normal / depth / AO / lit / vol / bloom / composite / **shadow
mask** straight to screen.

## Render-target lifetime

Only the G-buffer has a depth attachment. Every fullscreen HDR, half-resolution,
and LDR target is created with `depthBuffer: false`, because those passes never
depth-test and sample the G-buffer depth texture instead.

The MRT uses mixed precision without changing its shader contract: `gColor`
stays `RGBA16F` because emissive panels deliberately exceed 1.0 and its alpha
stores material IDs 0/1/2, while normalized view normals use `RGBA8`. Sampled
normals are renormalized by their consumers; the UNORM8 direction error is below
0.38° and the attachment drops from eight to four bytes per render pixel. That
saves 7.91 MiB at 1080p (31.64 MiB at 4K), plus G-buffer write and normal-sample
bandwidth.

The raw AO target, raw shadow target, and bloom horizontal-blur target have
disjoint lifetimes. `_effectScratchRTs` pools them by both storage class and
resolution scale: AO and shadow alias one filtered `R8` mask target when their
scales match, while bloom keeps a separate `RGBA16F` HDR scratch target. Their
final blurred outputs remain distinct because lighting and debug consume them
concurrently; the AO and shadow finals are also filtered `R8` masks. This cuts
that attachment group from 11.87 MiB to 5.44 MiB at 1080p (47.46 MiB to
21.75 MiB at 4K), before driver-specific alignment.

After bloom and composite have consumed the lighting result, the outline writes
into `litRT`; the debug branch returns before that overwrite, so its lit channel
still shows the true lighting output. Resize and disposal iterate unique scratch
targets rather than the effect aliases.

## The lamp field

`LightField` (12 Hz refresh) collects the nearest lit lamps from
`ChunkManager.collectLampsNear` (floor-filtered, stair-spill aware), sorts by
true 3D distance to the eye, and uploads up to `LIGHT_MAX` (72) world positions.
Per fixture, source `uLampChar` stores the rgb colour-temperature tint and
`lampFlickerRaw` stores the live flicker. The renderer's derived visible
`uLampChar` packs that tint plus the final flicker/fade weight in `.a`
(`lampCharacter.js` — per-tube breathing, rare bad strobing tubes, room-role
tints).

Runtime calls supply the player's integer floor. The collector computes the
bounded XZ chunk-key range whose AABBs can intersect `LAMP_QUERY_R`, visits only
the bounded floor reach allowed by `LIGHT_RANGE`, and then applies the existing
exact circle, aperture, and continuous-structure spill checks. The
`pcy = null` compatibility path retains the historical resident-chunk scan; it
is not used by the runtime light-field or light-at queries.

The upload remains an immutable source set for the renderer. Per frame,
`DeferredRenderer._updateFrame`:

1. inverts the projection once (every pass copies it),
2. transforms each source position to view space and tests its influence sphere
   against the camera frustum. The sphere radius is the largest live range used
   by lighting, shadow, or volumetrics plus a small edge epsilon,
3. stably compacts survivors into a separate visible position/character/count
   uniform set, preserving the source nearest-first order for the shadow and
   volumetric head budgets, and
4. **folds the query-edge set fade into visible `uLampChar.w`** (`raw flicker ×
   1-smoothstep(QUERY_R-FADE_BAND, QUERY_R, cameraDist)`). The fade only depends
   on the lamp's camera distance, so computing it per-lamp-per-frame on the CPU
   replaces the old per-pixel computation in the lighting shader — and the
   shadow + volumetric passes now see exactly the same faded weight, so a lamp
   leaving the candidate set fades its pool, its shadow and its shaft together.

All lighting, shadow, and volumetric uniforms and their pass-skip decisions use
the derived visible count. The source arrays are never compacted or mutated by
the renderer, so an off-screen lamp reappears immediately on a camera turn.
Raw flicker lives in `lamps.lampFlickerRaw` (written by `LightField`, or by the
debug `LightRoom`); visible `.w` is always recombined from it, which keeps the
fold idempotent while the sim is frozen.

## Runtime graphics quality (`core/graphics.js`)

Shaders compile **once** against compile-time ceilings
(`AO_SAMPLES_MAX`/`SHADOW_STEPS_MAX`/`SHADOW_LAMPS_MAX`/`VOL_STEPS_MAX`/`VOL_LIGHTS_MAX`
in `world/constants.js`); the live tier drives `uniform int` trip counts that
break out early — the same pattern as the `uLampCount` loop. Switching quality
is therefore instant: no shader rebuild, no pipeline reconstruction.

- **Presets** `low / medium / high / ultra` pin the advanced keys
  (`renderScale`, `worldDetail`, `aoQuality`, `shadowQuality`, `volQuality`,
  `bloom`, `fxaa`). Editing any advanced control flips the stored preset to
  `custom`.
- **`high` retains the legacy desktop shader budgets** and `medium` retains the
  legacy touch shader budgets. This is a pass-budget statement, not a
  bit-identical full-frame claim: both presets now select an explicit distant
  world-detail policy.
- **Render scale** (0.5–1.0) multiplies the DPR-clamped pixel ratio; every RT
  resizes through the existing `setSize` path. `computeEffectivePixelRatio`
  additionally caps the complete backing store at 3840×2160 pixels. Smaller
  displays remain exact, while Retina/5K windows cannot multiply all deferred
  attachments past the 4K-equivalent fill/memory budget.
- A disabled pass is skipped and its output cleared to its identity value
  (white for AO/shadow masks, black for shafts/bloom) every frame, so
  downstream shaders never special-case it. With FXAA off, grade renders
  straight to screen.
- The AO kernel radii use a radical-inverse (van der Corput) sequence so any
  prefix of the max-size kernel is stratified — the low tier reads 8 of 24
  samples and still covers the hemisphere.

`Settings` coerces every graphics key on load and set (enum whitelists, numeric
clamps), so a hostile/stale localStorage blob can never push an out-of-range
loop count at a shader.

### World geometry detail

`worldDetail` classifies chunks by horizontal Chebyshev ring around the player's
current chunk. It changes only child-batch visibility; it does not unload the
chunk, hide its group, or weaken the complete-height visibility contract for a
tall structure.

| Profile | Full detail | Reduced detail | Shell detail |
| --- | --- | --- | --- |
| `low` | rings 0–1 | rings 2–3 | ring 4+ |
| `medium` | rings 0–2 | ring 3 | ring 4+ |
| `high` | rings 0–2 | ring 3 | ring 4+ |
| `ultra` | rings 0–3 | ring 4+ | never |

Reduced detail hides ornamental frames, props, and dead lamp panels; Lattice
retains its rail-bearing frame batch at this level. Shell detail additionally
hides door leaves and furniture. Floors, ceilings, walls, emissive signs, live
lamp panels, and the exit anomaly remain visible at every level. Ultra retains
silhouette batches at every distance, but still removes small decoration beyond
ring 3.

`ChunkManager` reclassifies residents only after a horizontal chunk transition,
profile change, or family change, and classifies new chunks as they mount.
`render-coupling.test.js` locks the profile boundaries to the analytic fog:
default decoration reduction starts only after fog dominates, and silhouette
removal starts only where fog is effectively opaque.

### Low-activity cadence

The title and pause phases continue receiving RAF callbacks, camera/flicker
updates, and immediate input every display refresh, but submit the full deferred
pipeline on a deadline capped at 30 FPS. This halves menu GPU work on 60 Hz
displays and removes 75–79% on 120–144 Hz displays. Gameplay, transitions,
death effects, the F2 toolbox, and the backquote performance overlay bypass the
cap. Resize and settings changes invalidate the deadline so the next RAF always
draws, and skipped callbacks deliberately retain the previous completed
`renderer.info` aggregate.

## Debug tooling (F2 → LIGHT tab)

`LazyDebugMode` keeps the complete toolbox, world map, and editor dependencies
out of the initial module graph. The first F2 press dynamically imports it;
the facade preserves resize/render hooks and retries a failed load on a later
press.

- **Frame-wide renderer counters**: Three's per-`render()` information reset is
  disabled, and `Engine` resets `renderer.info` once immediately before the
  first draw of each engine frame. PerfTool samples the completed previous
  frame before that reset; the lightweight overlay samples the completed
  current frame afterward. Draw calls and triangles therefore cover the whole
  multipass frame instead of only its last fullscreen pass.
- **Channel strip** now includes the blurred lamp **shadow mask** (mode 10).
- **pipeline section**: live `visible / loaded lamps` readout, the current
  shadow/volumetric budgets, per-pass isolation toggles (ssao / shadow /
  volumetric / bloom / fxaa — ephemeral; any settings change re-stamps them),
  and **GPU pass timings** via `EXT_disjoint_timer_query_webgl2`
  (`render/PassTimer.js`, EMA per pass, "n/a" where the extension is missing).
  Timing switches off automatically when the panel closes.
- **light room**: isolated scene + orbit camera with a controllable lamp grid
  writing straight into the deferred uniforms.

## Cheap-depth reconstruction

`viewZAt()` in `shaders/common.js` exploits the symmetric-perspective inverse
structure (`viewZ = -1 / (ndcZ·ip[2][3] + ip[3][3])`) — two MADs and a divide
instead of a full mat4 unproject. The bilateral blurs tap it 25× per pixel, the
shadow/volumetric marches use it dozens of times, and each SSAO kernel tap now
uses it because only sampled view Z participates in the occlusion test.
`viewPosFromDepth` remains at the SSAO center and wherever a complete position
is actually needed.

## Coupled-constant contracts

`FOG_DENSITY / FAR / LOAD_RADIUS / LAMP_QUERY_R / LAMP_FADE_BAND` and the
render-detail profiles are one system: fog must dominate before geometry
streams, child detail changes, or lamp sets churn
(`world/__tests__/render-coupling.test.js`). The cubic lamp attenuation window
(`lampAtt` in `shaders/common.js`) is mirrored CPU-side by
`ChunkManager.lightAt` for the AI's light sense — change both together.

## Render-scene benchmark

```bash
npm run benchmark:render-scene -- --family office --profile high
```

This headless probe reports Node CPU prewarm time, loaded/effectively visible
chunks, detail-level distribution, potential mesh batches/instances/triangles
by semantic material, and static-matrix state. Its effective counts apply
Three ancestor/child visibility only. They exclude camera-frustum and occlusion
culling, rasterized work, GPU timings, browser frame time, and any production
performance guarantee.

Without `--budget-*` arguments the JSON is report-only. Explicit ceilings make
the command fail when exceeded; CPU timing remains host-sensitive even when a
budget is supplied. Use browser profiling and the F2 GPU pass timers for actual
frame and GPU evidence.
