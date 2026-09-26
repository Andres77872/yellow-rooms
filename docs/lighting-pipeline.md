# Lighting & Rendering Pipeline

Verified on 2026-07-24 against the current renderer, shaders, graphics settings,
debug tools, and light-field implementation. The semi-realistic anime look pass
(lighting model, two-scale bloom, colour-traced ink, filmic grade) was added on
2026-09-22 — see [Art direction](#art-direction-semi-realistic-anime).
**Updated 2026-09-26** for the engine-improvement implementation (world-grid
lighting, cell-graph bounce, G-buffer v2 PBR surfaces, look profiles,
auto-exposure, shadowed flashlight, capsule shadows, grid culling). The full
record, evidence and open items are in
[engine-improvement/13-implementation-record.md](engine-improvement/13-implementation-record.md);
this page keeps the pipeline reference current. **Updated again 2026-09-26** for
the shadow, occlusion, tier and look rework (occlusion v2, emitter-source
fixtures, furniture and capsule shadows, flashlight PCSS, shafts v1, quality
tiers v2, look schema v2): see
[engine-improvement/14-shadows-quality-style.md](engine-improvement/14-shadows-quality-style.md).

The game renders through a custom deferred pipeline (`src/render/DeferredRenderer.js`).
There are **no three.js lights**. Ceiling fixtures are shaded from the
world-grid light lists (`src/world/lightGrid/`), or from the nearest-lamp set
where no grid data exists. The flashlight is an analytic spot with its own
shadow map, and every effect is a fullscreen pass over the G-buffer. Per-pass
GLSL lives in `src/render/shaders/`; the renderer module owns render targets,
uniforms and per-frame orchestration only. The **look profile**
(`src/render/lookProfile.js`: Semi-realistic by default, Liminal photo,
Camcorder '96, Classic, Neutral) selects the shading model, the shadow
character, the camera model and every stylisation lever.

## Frame anatomy

```
G-buffer v2 (albedo+matID, viewNormal+roughness, metal/materialAO/gloss, depth)
  ├─ Flashlight    spot map from the hand, world-unit bias; Vogel PCF or PCSS
  │                (R16F blocker attachment); skipped when nothing moved [flash tier]
  ├─ GTAO          half-res XeGTAO slices + bent normal               [AO tier]
  ├─ Contact       half-res residual march: per-light channels for list
  │                entries 0/1 + aggregate; hits owned by the analytic
  │                systems (walls, jambs, columns, proxies, capsules) ignored
  ├─ Resolve       one MRT joint-bilateral pass for both (5x5, noise period)
  ├─ Lighting      unified loop: grid entries (emitter-source, parallelogram
  │                footprint trace through doors/jambs/columns, cross-floor
  │                slab holes), furniture box coverage, capsule groups, the
  │                raycast bounce VPL, the torch; crease/box/capsule AO,
  │                multi-bounce, specular occlusion, bent-normal GI; exp² fog
  ├─ Exposure      emissive-aware meter -> 2x1 spring adapt + AWB
  ├─ Volumetrics   half-res shafts: quadratic steps, near-field torch march,
  │                traced doorway shafts, capsule haze cuts; depth-aware blur
  ├─ Bloom         tight + wide + tail (1/16), emissive clamp        [toggle]
  ├─ Composite     depth-aware shaft upsample, bloom, halation
  ├─ Outline       colour-traced ink (Classic look only)
  ├─ Motion blur   reprojection, opt-in / Camcorder                  [medium+]
  ├─ Grade         lens + CA, scene-linear WB, exposure, tone mapper (AgX /
  │                filmic / Neutral / video knee), sensor noise, white clip,
  │                toe, split, pedestal, vignette
  └─ FXAA | tape signal (Camcorder: YIQ bandwidths, noise, head switching)
```

The Classic look keeps the v1 occlusion path (hemisphere SSAO + a 1.8 m
screen-space contact mask) in place of GTAO/contact/resolve.

**Identity clears and context loss.** A skipped pass leaves its target at the
identity value, and array identities must have alpha 1: three premultiplies the
clear colour by alpha, so the occlusion-v2 contact identity is (1, 1, 1, 1).
On `webglcontextrestored` the renderer re-creates the flashlight depth
attachment and invalidates the torch-map skip, forces a whole grid-texture
upload, and re-requests the GPU timer extension (the engine then re-reads
whether dynamic resolution is GPU-timed and restarts the auto benchmark
window).

**Sampler precision.** GLSL ES 3.00 predeclares `sampler2D` as lowp, and ANGLE
honours it: depth read through an undeclared sampler arrives at half precision
(steps of 2⁻¹¹), which banded AO and every reconstructed world position. Every
fullscreen pass prepends `SAMPLER_PRECISION` (`shaders/common.js`) to declare
`highp` samplers.

Debug channel viewer (`shaders/debugView.js`, F2 → LIGHT tab): modes 1–13 blit
albedo / matID / normal / depth / AO / lit / vol / bloom / composite / shadow
mask / **roughness / metalness / material AO** straight to screen. Lighting
diagnostics (list size, grid coverage, direct only, indirect only, traced
fixtures) are written by the lighting pass itself and viewed through 'lit'.

## Render-target lifetime

Only the G-buffer has a depth attachment. Every fullscreen HDR, half-resolution,
and LDR target is created with `depthBuffer: false`, because those passes never
depth-test and sample the G-buffer depth texture instead.

The MRT uses mixed precision without changing its shader contract: `gColor`
stays `RGBA16F` because emissive panels deliberately exceed 1.0 and its alpha
stores material IDs 0/1/2, while normalized view normals use `RGBA8`.
G-buffer v2 adds a third `RGBA8` attachment (`gMaterial`: metalness, material
AO, legacy gloss) and moves perceptual roughness into the normal alpha — 4
more bytes per pixel; `render/capabilities.js` probes this exact layout for
framebuffer completeness at boot. Sampled
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

Since the engine-improvement implementation the lamp field is the **fallback**
light source: grid pixels shade from their cell's baked light list, and only
pixels without grid data (the debug light room, the streaming edge, a
vertically aliased floor slot) use the set below. The compacted visible set
now travels as one `LIGHT_MAX × 2` RGBA32F data texture (`shaders/lampData.js`)
instead of two uniform arrays, which freed 144 fragment uniform vectors in each
lamp pass.

`LightField` (12 Hz refresh) collects the nearest lit lamps from
`ChunkManager.collectLampsNear` (floor-filtered, stair-spill aware), ranks them
by true 3D distance to the eye, and uploads up to `LIGHT_MAX` (72) world
positions. Distances are derived once per candidate into a side buffer and an
index array is sorted, rather than re-derived inside every comparison.
Per fixture, source `uLampChar` stores the rgb colour-temperature tint and
`lampFlickerRaw` stores the live flicker. The renderer's derived visible
`uLampChar` packs that tint plus the final flicker/fade weight in `.a`
(`lampCharacter.js` — per-tube breathing, rare bad strobing tubes, room-role
tints).

`LightField` also publishes `cutoffR`: **where the uploaded set actually ends**.
`LAMP_QUERY_R` is only the boundary while the candidate list fits in
`LIGHT_MAX`. It usually does not — the office lamp grid carries ~0.0081 lit
fixtures/u², so a 60u query circle holds ~92 candidates for 72 slots and the
real edge is the 72nd-nearest lamp at ~53u. `cutoffR` is that distance when the
cap binds and `LAMP_QUERY_R` otherwise; `LightRoom` sets `Infinity` because its
lamps are authored rather than queried.

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
4. **folds the set-edge fade into visible `uLampChar.w`** (`raw flicker ×
   1-smoothstep(cutoffR-band, cutoffR, cameraDist)`, where `band` is
   `min(LAMP_FADE_BAND, cutoffR/4)` so a tight cutoff dims only its own edge).
   The fade only depends on the lamp's camera distance, so computing it
   per-lamp-per-frame on the CPU replaces the old per-pixel computation in the
   lighting shader — and the shadow + volumetric passes now see exactly the same
   faded weight, so a lamp leaving the candidate set fades its pool, its shadow
   and its shaft together.

   The anchor is `LightField.cutoffR`, **not** `LAMP_QUERY_R`. Anchoring to the
   query radius assumed the candidate list always fits in `LIGHT_MAX`; where it
   does not, the real edge lies inside the nominal band and lamps stepped out at
   partial weight (~60% at office density) instead of fading to zero.
   `render/__tests__/lamp-fade.test.js` locks both halves of this contract.

All lighting, shadow, and volumetric uniforms and their pass-skip decisions use
the derived visible count. The source arrays are never compacted or mutated by
the renderer, so an off-screen lamp reappears immediately on a camera turn.
Raw flicker lives in `lamps.lampFlickerRaw` (written by `LightField`, or by the
debug `LightRoom`); visible `.w` is always recombined from it, which keeps the
fold idempotent while the sim is frozen.

## Runtime graphics quality (`core/graphics.js`)

> **Tiers v2 (2026-09-26).** Presets are `low / medium / high / ultra /
> cinematic`, plus `auto` (GPU class, then a benchmark on the first real
> frames, persisted per GPU hash). Each feature has five tiers (off → ultra):
> world shadows, flashlight shadows, AO, light shafts. Tiers cap *work*
> (traces, capsules, taps, steps), never light: every list entry always
> shades. Structural choices (occlusion path, furniture, PCSS, bent normals,
> haze) are shader variants keyed by `_variantKey()` and swapped after a
> background `compileAsync`; everything else stays a uniform. Dynamic
> resolution runs on `auto` (opt-in otherwise). The generated tier tables live
> in [chapter 14 §4](engine-improvement/14-shadows-quality-style.md#4-quality-tiers).
> The text below describes the v1 mechanism, which still holds for the
> uniform-driven trip counts.

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
- A disabled pass is skipped and its output filled with its identity value
  (white for AO/shadow masks, black for shafts/bloom), so downstream shaders
  never special-case it. The fill happens **once**, not every frame: `_runOr`
  keeps the identity bookkeeping next to the skip decision, and the cache is
  invalidated when the pass renders again or `setSize` reallocates storage.
  With FXAA off, grade renders straight to screen.
- The AO kernel is low-discrepancy and **deterministic in all three dimensions**:
  base-2 van der Corput elevation, golden-angle azimuth, base-3 van der Corput
  radius (a different base, so radius cannot correlate with elevation). Any
  prefix of the max-size kernel is therefore stratified — the low tier reads 8
  of 24 samples and still covers the hemisphere. Previously only the radii used
  the sequence while directions came from `Math.random()`, so a prefix was not
  actually guaranteed to cover the hemisphere and AO differed per page load.

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
- **pipeline section**: live `visible / loaded lamps @ cutoff` readout (a cutoff
  below `LAMP_QUERY_R` means the `LIGHT_MAX` cap is binding and the edge fade has
  moved inward with it), the current
  shadow/volumetric budgets, per-pass isolation toggles (ssao / shadow /
  volumetric / bloom / fxaa — ephemeral; any settings change re-stamps them),
  and **GPU pass timings** via `EXT_disjoint_timer_query_webgl2`
  (`render/PassTimer.js`, EMA per pass, "n/a" where the extension is missing).
  Timing switches off automatically when the panel closes.
- **light room**: isolated scene + orbit camera with a controllable lamp grid
  writing straight into the deferred uniforms (world-grid lighting is
  suspended while it draws). **standard PBR reference (A/B)** swaps in a stock
  `MeshStandardMaterial` mirror of the room, lit by point lights at the same
  power and window and graded by the same output pass (`debug/PbrReference.js`).
- **engine: look + grid**: look-profile selector; toggles for world-grid
  lighting, sight culling and the flashlight shadow map; lighting diagnostics;
  GI and ambient-floor sliders; live bake/culling/exposure readouts; **copy
  capture** (deterministic replay descriptor, `debug/capture.js`) and **copy
  timings** (capture + capabilities + PassTimer percentiles) for evidence
  records.

## Cheap projection helpers

All three exploit the same symmetric-perspective structure, and all three live in
`shaders/common.js` so no pass can drift from the others.

- `viewZAt()` — `viewZ = -1 / (ndcZ·ip[2][3] + ip[3][3])`: two MADs and a divide
  instead of a full mat4 unproject. The bilateral blurs tap it 25× per pixel, the
  shadow/volumetric marches use it dozens of times, each SSAO kernel tap uses it
  because only sampled view Z participates in the occlusion test, and the outline
  Sobel uses it for all four neighbour taps.
- `projectView()` (`VIEW_PROJ`) — the forward twin. The projection's
  off-diagonals are zero and its w-row is `(0,0,-1,0)`, so clip xy is a per-axis
  scale and clip w is just `-z`: two multiplies and a divide instead of a mat4
  multiply. Returns false at/behind the eye; **viewport bounds stay the caller's
  job** because the passes disagree on whether the `[0,1]` edges are inclusive.
  The shadow march runs it up to `uSteps × uMaxLamps` times per pixel and the
  volumetric occlusion taps up to `uSteps × uMaxLights × 2` times.
- `viewPosFromDepth` remains where a complete position is genuinely needed — the
  SSAO centre, and the outline centre, where one unproject now serves both the
  Sobel reference depth and the radial fog distance.

## Analytic cel band

`band()` (`CEL_BAND` in `shaders/common.js`) quantises N·L in ALU. It used to be
a dependent texture read into the `CEL_BANDS`-texel nearest LUT from
`gradientRamp.js`, executed **once per lamp per pixel** — up to 72× in the
lighting loop and 72× in the shadow loop, the two hottest loops in the renderer.
Nearest sampling of a clamp-to-edge LUT picks texel
`min(floor(x·bands), bands-1)`, whose value is `floor + (1-floor)·i/(bands-1)`,
so the closed form is exact to within the texture's own 8-bit rounding (≤ 1/510).

`render/gradientRamp.js` is retained as the authored definition of the ramp and
serves as the oracle for `render/__tests__/cel-band.test.js`, which transpiles
the emitted GLSL and holds it to the LUT. No ramp texture is bound, resized or
disposed by the pipeline.

## Coupled-constant contracts

`FOG_DENSITY / FAR / LOAD_RADIUS / LAMP_QUERY_R / LAMP_FADE_BAND` and the
render-detail profiles are one system: fog must dominate before geometry
streams, child detail changes, or lamp sets churn
(`world/__tests__/render-coupling.test.js`). The cubic lamp attenuation window
(`lampAtt` in `shaders/common.js`) is mirrored CPU-side by
`ChunkManager.lightAt` for the AI's light sense — change both together.

`collectLampsNear` takes a query radius, defaulting to the light field's
`LAMP_QUERY_R`. `lightAt` passes `LIGHT_RANGE` instead: it runs every tick (the
Engine's fluorescent hum and the Stalker's light sense) and every lamp past
`LIGHT_RANGE` is discarded by the cubic window anyway, while the off-floor branch
measures 3D distance, which is ≥ the horizontal distance the circle tests. The
narrow circle is therefore a strict superset of what can contribute — same
results, an order of magnitude fewer chunk-key lookups and lamp tests
(`world/__tests__/light-filter.test.js` locks the equivalence).

The volumetric march gates each lamp on `VOL_CONTRIB_EPS` before paying for its
screen-space occlusion taps. The cubic window means only ~48% of a lamp's
in-range volume carries more than 1% of peak, so this skips roughly half the taps
in the pipeline's most expensive inner loop.

## Render-scene benchmark

```bash
npm run benchmark:render-scene -- --family office --profile high
npm run benchmark:render-scene -- --family office --profile high --models glb
```

This headless probe reports Node CPU prewarm time, loaded/effectively visible
chunks, detail-level distribution, potential mesh batches/instances/triangles
by semantic material, and static-matrix state. Its effective counts apply
Three ancestor/child visibility only. They exclude camera-frustum and occlusion
culling, rasterized work, GPU timings, browser frame time, and any production
performance guarantee.

The default `--models procedural` preserves the historical fallback scene.
`--models glb` loads and bakes all 23 checked-in furniture models before
prewarming, using the same instanced model geometry as gameplay. The
`modelLibrary` block reports that separate load/bake time and geometry buffer
bytes; prewarm time excludes loading. This mode is necessary when evaluating
model topology changes.

The September 2026 lifecycle pass disables automatic clears after the G-buffer:
every subsequent opaque fullscreen triangle overwrites its complete target.
Renderer clear state, scene background and timing queries are restored even
when a pass throws. Teardown releases all 13 fullscreen shader materials as
well as targets and shared fullscreen geometry. Family texture caches belong
to their renderer and stay alive until its last G-buffer material set leaves.
Instanced normals use the inverse-transpose rotation/scale transform so
nonuniform scale preserves lighting on curved and beveled surfaces.

Without `--budget-*` arguments the JSON is report-only. Explicit ceilings make
the command fail when exceeded; CPU timing remains host-sensitive even when a
budget is supplied. Use browser profiling and the F2 GPU pass timers for actual
frame and GPU evidence.

## Measured GPU cost

A/B via the F2 pass timers (office, seed `review`, spawn, `high` preset, 44
visible lamps, min of 5 × 100-frame rounds — the min rejects scheduler stalls
that make the EMA swing up to 16× on *untouched* passes):

| pass | before | after |
| --- | --- | --- |
| volumetric | 0.852 ms | **0.624 ms** (−27%) |
| lighting | 0.146 ms | 0.139 ms |
| shadow | 0.136 ms | 0.134 ms |
| ssao | 0.131 ms | 0.138 ms |
| outline | 0.028 ms | 0.028 ms |

Only the volumetric gate lands outside the ~±5% noise floor (`gbuffer`, which
nothing in this pass touched, moved 2%). The analytic cel band and the cheap
forward projection are strictly fewer instructions and one fewer sampler
binding, but on a desktop GPU a fully-cached 4-texel LUT fetch is close to free,
so they do not show a measurable win at this lamp count — expect more from them
on tile-based mobile GPUs (the `medium`/touch preset) and at higher lamp counts.
**Re-measure on the target device before treating either as a budget saving.**

## Art direction: semi-realistic anime

> This section describes the **Classic** look profile, the pre-2026-09-26
> default kept as a named rollback. The Semi-realistic and Neutral profiles use
> the physical model summarised in
> [engine-improvement/13](engine-improvement/13-implementation-record.md#s1-look-profiles-r1).

Reference points: Makoto Shinkai / Kyoto Animation background painting and
the Genshin Impact / Honkai: Star Rail toon pipelines. The rules this pass
applies: environments are painted (smooth gradients, a soft but defined
terminator), characters are cel; shadows are hue-shifted cool rather than
darkened; fully saturated colour is a small share of the frame; light sources
glow into the air around them; line art is thin and colour-traced; nothing
reads as dead black except ink.

### Lighting model (`shaders/lighting.js`)

- **Painted ramp.** World surfaces shade with `surfaceRamp()`
  (`shaders/common.js` `LIT_RAMP`): a smoothstep ramp from `CEL_FLOOR` to 1
  carrying only `CEL_HARD` (0.3) of the old banded ramp. The shadow pass
  weights its visibility mask with the same function. Entities keep the fully
  stepped rim.
- **Terminator band.** A bell over the wrapped N·L, peaking just inside the
  terminator, adds the lamp colour pushed toward full saturation
  (`terminatorColor()` in `DeferredRenderer.js`: squared and renormalised) at
  `TERMINATOR_STRENGTH`. Warm tubes paint an amber edge, cold tubes a mint one.
- **Gloss highlight.** The G-buffer normal target's alpha, previously a
  constant 1, carries per-material gloss (`SURFACE_GLOSS` in
  `gbufferMaterials.js`, chosen by palette surface style: carpet 0, tile 0.55,
  deck 0.38; props, trim, furniture and entities 0.2–0.45). Each lamp adds a
  soft-thresholded Blinn lobe (`SPEC_POWER`, `SPEC_STRENGTH`) — the painted
  light streaks on anime corridor floors. The lobe has its own cubic window at
  `SPEC_REACH` (1.8) × the lamp range, because a glossy floor mirrors a panel
  far beyond the pool it casts. A Schlick-style grazing boost (0.4 → 1) favours
  the low angles a first-person camera sees floors at. `_updateFrame` culls
  lamps against that longer reach, so a lamp just above the view still
  reflects in the floor. `ChunkManager.lightAt` still mirrors only the
  diffuse window. The flashlight adds its own lobe back at the eye. The gloss
  costs no bandwidth: the alpha was already stored.
- **One-bounce fill.** A non-directional share (`LAMP_BOUNCE`) of every
  nearby lamp's irradiance, tinted by the family's `floor.base`, ignores the
  shadow mask and takes AO. The floor pool lights the ceiling and wall
  undersides, which also removed the dirty halo ceilings had around fixtures.
- **Downward fixtures.** The half-Lambert wrap is scaled by the hemisphere
  term (30% on ceilings, full on floors), and ceilings take only a quarter of
  the shadow mask. The only occluder a ceiling point's march can find is the
  fixture's own housing at a grazing angle.
- **Entities.** Most of the stepped rim's `CEL_FLOOR` is subtracted. At the
  full floor it washed the whole body slate-blue. Now the ink figures stay
  ink-dark with a cool edge. An albedo-proportional fill (`ENTITY_FILL`)
  keeps pale parts readable between pools: the Husk's ash, the Stalker's
  blank head and hands, the Pursuer's eyes. Ink albedo (~0.01) gains
  nothing from it.

### Brightness

`LIGHT_INTENSITY` 3.0 → 1.15, `VOL_INTENSITY` 0.75 → 0.3, `FLASH_INTENSITY`
2.2 → 1.5, and a per-family `exposure` (palette key, default
`GRADE_EXPOSURE`). An HDR probe of the composite on the office spawn view
showed the in-scatter alone adding +0.3 to +0.7 linear across the whole frame.
That was more than the lamps on shadowed walls, and it caused most of the
milky over-bright veil. Luminance of the graded frame, measured on fixed
views (seed `review`, spawn, 1280×720):

| View | Mean before | Mean after | Clipped px before | after |
| --- | ---: | ---: | ---: | ---: |
| office, spawn | 0.71 | 0.54 | 30.8% | 1.9% |
| office, turned | 0.60 | 0.45 | 21.1% | 0.4% |
| hotel, spawn | 0.56 | 0.40 | 25.1% | 3.0% |
| tower, spawn | 0.76 | 0.55 | 31.4% | 0.0% |
| office, flashlight | 0.60 | 0.44 | 18.0% | 1.5% |

### Post

- **Bloom** prefilters emissives in full plus lit surfaces' soft-kneed excess
  over `BLOOM_THRESHOLD` at `BLOOM_SURFACE`. The tight half-res blur
  (`BLOOM_SPREAD`) is then re-blurred at quarter res (`BLOOM_WIDE_SPREAD`)
  into `bloomWideRT`. Composite adds both. When bloom is disabled, both
  targets hold the black identity.
- **Outline** colour-traces world lines. The ink is the albedo darkened and
  pushed ~40% more saturated, blended with the flat ink by `OUTLINE_INK_TINT`
  and drawn at `OUTLINE_OPACITY`. Thresholds are soft smoothsteps, so lines
  anti-alias. Entities keep full flat ink at any distance.
- **Grade.** The Narkowicz ACES fit, applied mostly to luminance
  (hue-preserving), blends toward the per-channel curve as values climb, so
  hot cores roll off to warm white. The old Khronos PBR Neutral map was linear
  to ~0.76, so every lamp pool on a light wall flattened to cream. After tint
  and saturation (`GRADE_SAT` 1.34 → 1.12, and lower per family): split
  toning (`GRADE_SHADOW_TINT` / `GRADE_HIGHLIGHT_TINT`) and a small cool lift
  of the darkest values (`GRADE_LIFT`). The posterize went from 14 to 48
  levels, a faint quantisation hidden by the dither. The calm-frame chromatic
  aberration dropped from 0.0026 to 0.0008. Fringing is now a sanity/stare
  symptom.
- **Textures.** Carpet and concrete wear are feathered, wrapped radial blots
  (`softBlots` in `textures.js`) rather than hard discs.

All new terms have F2 → LIGHT sliders (terminator, bounce, spec strength and
power, bloom wide, threshold and surface, ink tint and opacity, shadow lift).
Measured cost on the office spawn view (1687×578, 44 visible lamps, F2 pass
timers): lighting 0.048 ms, all four bloom blurs plus prefilter 0.025 ms. The
G-buffer pass (1.9 ms) still dominates.
