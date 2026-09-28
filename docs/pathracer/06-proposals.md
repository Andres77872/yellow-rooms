# 06 — Integration proposals

These are designs for the features that scored PORT or TOOL in
[05](05-feature-fit.md). Each one lists its goal, design, touch points in this
repository, cost, risks, tests, and acceptance criteria. None of them changes
world generation, so `WORLD_GEN_VERSION` and the world-byte pins are
unaffected. P1b changes the *lighting* grid output. That is render-side, and
it is versioned by `GRID_SCHEMA_VERSION` and captures, not by world bytes.

| # | Proposal | Verdict | Value | Effort |
| --- | --- | --- | --- | --- |
| [P1](#p1--path-traced-reference-mode-f2--editor) | Path-traced reference mode (F2 / editor) | TOOL | H | M |
| [P1b](#p1b--gi-reference-report-and-ambient-cube-refit) | GI reference report + ambient-cube refit | TOOL → shipped fix | **H** | S–M |
| [P2](#p2--photometric-flashlight-beam-profile) | Photometric flashlight beam (+ fixture diffuser LUT) | PORT | H | S |
| [P3](#p3--eon-diffuse-for-rough-surfaces) | EON diffuse for rough surfaces | PORT | M | S |
| [P4](#p4--fsr1-easu--rcas-upscale-for-renderscale--1) | FSR1 upscale for `renderScale < 1` | PORT | M–H | M |
| [P5](#p5--blue-noise-where-it-actually-helps) | Blue noise where it actually helps | PORT | L–M | S |
| [P6](#p6--offline-bakes-ao--irradiance-where-determinism-allows) | Offline bakes (AO / irradiance) for authored content | DEFER | M | L |
| [P7](#p7--three-mesh-bvh-in-tooling-not-gameplay) | three-mesh-bvh in tooling, not gameplay | TOOL | M | S |
| [P8](#p8--photo-mode-deferred) | Path-traced photo mode | DEFER | M | M–L |
| [P9](#p9--small-items) | Small items (precision probe, stable noise) | PORT | L | S |

---

## P1 — Path-traced reference mode (F2 / editor)

**Goal.** Given a capture or the F2 light room, produce a converged,
physically based reference of the same view. Compare it with the deferred
renderer's HDR output **before the grade**, so that every hand-tuned lighting
constant can be checked against ground truth. That includes the fixture
diffuser, `LAMP_BOUNCE`, the GI weights, GTAO radius, `VOL_INTENSITY`, PCSS
light size and furniture form factors.

### Design

1. **Lazy module** `src/debug/PathReference.js`.
   - Dynamically imported from the F2 LIGHT tab, the same pattern as
     `core/LazyDebugMode.js`.
   - Dependencies: `three-gpu-pathtracer@0.0.24` (pinned exactly; the WebGL
     class is deprecated upstream) and `three-mesh-bvh@^0.9.15`. That is about
     61 kB + 16 kB gzip, measured in [07 E1](07-experiments.md#1-e1--packaging-compatibility-and-bundle-cost).
   - Never in the boot graph.
2. **Proxy scene builder.** This generalises `debug/PbrReference.js`:
   - Export its `mirrorMaterial` so the reference and the stock A/B share one
     mapping: `uColor` → `color`, `map`, `uRoughness`/`uMetalness`,
     `USE_PART_COLOR` → `vertexColors`, and matID 1 → emissive × `PANEL_GLOW`.
   - Collect resident chunks within **ring R of the camera chunk** (default 1,
     i.e. 3×3). Include the floors a visible structure or slab hole connects,
     using the same rules as `ChunkManager` visibility.
   - Expand every `InstancedMesh` into world-space geometry, folding
     `instanceColor` into vertex colour. Merge by material. The spike code in
     [07 E3](07-experiments.md#3-e3--path-tracing-real-yellow-rooms-chunks) is
     the starting point.
   - Respect the current `worldDetail` visibility, so the reference sees what
     the frame sees.
3. **Emitters that match the engine's fixture model.**
   - **Quick mode.** One `RectAreaLight` (1.7 × 1.0, facing down) per lit
     panel within the ring. Intensity is `LIGHT_INTENSITY × tint × flicker(t)`
     at the capture's `time` and `reduceFlicker` profile.
   - **Matched mode.** One downward `PhysicalSpotLight` per panel:
     - `angle = π/2` and `radius = PANEL_EQ_R`;
     - an `iesMap` generated from the active look's `uEmitFloor`/`uEmitPow`
       curve, so the reference emits with the same diffuser profile.

     This removes the "stock point lights have no downward diffuser profile"
     caveat that `PbrReference` documents.
   - **Flashlight.** A `PhysicalSpotLight` at `FLASH_HAND_OFFSET`, with the
     cone from `uFlashCosInner`/`uFlashCosOuter` (or the P2 profile) and
     `radius` equal to the PCSS light size.
   - **Radiometry notes.**
     - The engine windows every fixture at `LIGHT_RANGE`
       (`physicalAttenuation`); the tracer does not. Add a debug uniform that
       disables the window during A/B, or restrict metrics to pixels whose
       dominant fixtures lie within range. Report which one was used.
     - The GI ambient term, the hemisphere floor and exposure adaptation must
       be **off** in the engine image during A/B (the "direct only" /
       "indirect only" diagnostics already exist). Otherwise the comparison
       double-counts.
4. **Rendering.**
   - `WebGLPathTracer` renders to its own float target. Settings: `tiles`
     (2, 2), `bounces` 6, `renderScale` 0.5 while navigating and 1.0 when
     frozen, `stableNoise = true`, `minSamples` 1.
   - The deferred renderer keeps drawing; F2 composites the views.
   - **Views:** engine / reference / split / signed-difference false colour
     (reusing the `debugView` pass).
   - **Readouts:** spp and ms/sample, plus mean-luminance ratio per screen
     region (floor, walls, ceiling, via the G-buffer normal).
5. **Evidence.** "Copy reference" writes the capture JSON, spp, tracer
   settings, the emitter mode and region ratios. This follows the "copy
   timings" evidence-record convention.
6. **Headless variant (optional).** `scripts/reference-render.mjs` drives the
   same module in Playwright plus SwiftShader to emit HDR and PNG files from
   a capture file. [07 E3](07-experiments.md#3-e3--path-tracing-real-yellow-rooms-chunks)
   proves this works without a GPU: 16 office chunk-views converge in
   seconds to minutes. Playwright is **not** a project dependency today; keep
   it optional (for example `npx`), as the spike did.

### Phasing

1. Light room only: authored lamps, one scene, no streaming.
2. Captures (ring neighbourhoods).
3. Switch the backend to `WebGPUPathTracer` once it is on npm. It handles
   instancing natively and adds OIDN for clean stills.

### Risks

- **Upstream churn.** Pin the version, and keep all tracer calls inside
  `PathReference.js` so the WebGPU swap touches one file.
- **Compile time on ANGLE.** The shader is huge. Compile async, show
  progress, and never on boot.
- **VRAM.** Float targets plus BVH textures cost tens of MB. The module
  disposes everything when F2 closes.
- **Look mismatch.** Only the Semi-realistic and Neutral looks are
  comparable. The UI must say so when another look is active.

### Tests

Scene-builder unit tests in Node, without a GL context:

- instance-expansion triangle counts;
- `instanceColor` folding;
- the material mapping table;
- emitter count and intensity for a pinned capture;
- the IES profile generator matching `mix(uEmitFloor, 1, pow(y, uEmitPow))`
  within 1/255.

The render itself is GPU-dependent and stays out of Vitest, like the other
PassTimer evidence.

### Acceptance

- The light room renders a reference in under 60 s at 256 spp on a desktop
  GPU.
- Region luminance ratios appear in the evidence JSON.
- No new module in the initial game graph (`vite build` chunk report).

---

## P1b — GI reference report and ambient-cube refit

**Goal.** Measure the cell-graph GI (`LightGrid._solveGI`) against a
deterministic Monte Carlo ground truth over the *real* chunk geometry. Then
fix its measured biases. This is the most valuable result of the research
because it needs no browser, runs in the existing report and test culture,
and directly changes shipped lighting.

### What E4 measured

[07 E4](07-experiments.md#4-e4--monte-carlo-reference-for-the-cell-graph-gi)
has the full tables. The comparison uses a 512-path, 6-bounce reference over
real chunks, with the grid's own emitter model and albedos. There are four
datasets (office ×2, hotel, sewer), and the reference noise floor is 5%.

- **The ceiling term is identically zero.** The model has no second bounce,
  so up-facing indirect irradiance (what lights ceilings and upper walls) is
  **66–73% too dark** in every family.
- **The floor's direct irradiance is sampled at mid-height (1.6 m)**, not on
  the floor. Under a fixture, the inverse-square window inflates it by up to
  about 3.8×. This gives the down-face its 1.9–2.2 relative RMSE. The current
  weights partly compensate, so the cube is 45–65% brighter than true
  one-bounce light yet still 9–21% darker than multi-bounce light.
- **More Jacobi iterations do nothing.** 8 instead of 3 changes relative RMSE
  by less than 1%.
- **Cheap models, cross-validated leave-one-dataset-out.** Sampling the floor
  on the floor, adding a floor→ceiling bounce term (one multiply-add), and
  refitting the six weights cuts per-cell relative RMSE by **53–57% in every
  family**, including the held-out hotel and sewer:
  - office 1.31 → 0.58;
  - hotel 1.44 → 0.62;
  - sewer 1.52 → 0.71.

  Up-face correlation rises from 0.50–0.69 to 0.86–0.90.

### Design

1. **Report script.** Add `scripts/gi-reference.mjs` and
   `npm run report:gi`. It is the E4 script productionised:
   - `three-mesh-bvh` as a **devDependency** only;
   - a seed corpus per family;
   - seeded RNG;
   - JSON output (bias, correlation, relative RMSE per face class, fitted
     weights);
   - `--budget-*` options like the other benchmarks.
2. **Model fix** (E4's model C: same inputs, same O(cells) cost):
   1. **Sample the floor's direct irradiance on the floor.** In
      `_solveGI`, the floor emission term uses `_directCube` evaluated at the
      slab (y ≈ `layerY(cy)` + 2 cm) instead of mid-height. That is one extra
      pass over the cell's ≤ `LIST_MAX` list entries.
   2. **Second bounce for up-facing surfaces.** The up face of the ambient
      cube adds a weighted floor-radiosity term (`w·floor`), so the lit floor
      finally lights the ceiling.
   3. **Refit the ambient-cube weights** from the report, as named constants
      in `gridSpec.js` with a comment linking the report. E4's fit is
      side `0.642·near + 0.485·(ceil+floor) + 0.611·avgSide`,
      up `0.412·floor + 0.642·avgSide`, down `0.709·floor + 1.386·avgSide`.
      Treat these as a starting point; refit on the full corpus.
   4. Keep 3 iterations; E4 shows more do not help.
   5. **Apply a mean-preserving scale last,** so the fix changes *structure*
      (where bounce light lands) separately from overall GI level. The level
      stays an art-direction lever (`look.lampBounce` / GI sliders).
3. **Guard test.** `world/__tests__/gi-reference.test.js` runs the report on
   one pinned office seed with a small path count (for example 32 paths,
   centre chunk, fixed RNG), which makes it deterministic. It asserts:
   - correlation ≥ a floor;
   - per-face-class bias inside a band.

   It is slow-ish, so it belongs with the "intentionally audit thousands of
   chunks" suites that already raise `testTimeout`.

### Risks

- A brighter ceiling changes the look. Gate it behind the look profile's
  existing GI scale (`look.lampBounce` / GI sliders) and review it with the
  F2 A/B.
- The Classic look already paints a ceiling fill (`LAMP_BOUNCE`). Make sure
  the two do not add up twice in the looks that use both.

### Acceptance

- The report is committed with its numbers.
- On every held-out dataset:
  - up-face bias is within ±25% (E4: −7% to −24%, down from −66% to −73%);
  - overall relative RMSE is ≤ 0.75 (E4: 0.58–0.71, down from 1.26–1.52).
- The guard test is green.
- `benchmark:light-grid` shows no job-time regression beyond noise.

---

## P2 — Photometric flashlight beam profile

**Goal.** Replace the analytic smoothstep cone with a **photometric
profile**, the idea behind `PhysicalSpotLight.iesMap`. Real handheld torches
have:

- a hot centre spot;
- a dimmer spill;
- a dark gap;
- often a faint ring from the reflector.

That texture is iconic in horror games and is what a player "reads" when
sweeping a dark corridor.

### Today

- The lighting pass computes
  `cone = smoothstep(uFlashCosOuter, uFlashCosInner, dot(-Lf, uFlashDirV))`
  (`shaders/lighting.js:894`).
- The volumetric pass repeats the same line (`shaders/volumetric.js:152`).
- The constants are `FLASH_COS_INNER` 0.94 and `FLASH_COS_OUTER` 0.86
  (`world/constants.js:254-255`).
- On the CPU, the Stalker's in-beam test is `dot ≥ FLASH_COS_OUTER`
  (`entities/Stalker.js:157`).

### Design

1. `render/beamProfile.js` builds a **1D LUT**: 128 texels over
   `θ ∈ [0, θmax]`, stored R16F or RGBA8 (RGB for a slightly warm hot spot,
   A for intensity).
   - **Parametric:**
     - `hotAngle`, `hotGain`;
     - `spillAngle`, `spillLevel`;
     - `ringAngle`, `ringWidth`, `ringGain`;
     - `edgeSoftness`;
     - optional `batterySag(t)` as a scalar multiplier.
   - **Normalisation.** Scale the LUT so the **flux within `θ(FLASH_COS_OUTER)`
     equals today's cone flux**. Exposure, `survival.js` stare balance and
     auto-exposure therefore do not shift.
   - **Optional:** load an IES/LDT profile through three's `IESLoader`, which
     produces the same 180-sample layout the tracer uses. Only use profiles
     whose licence allows redistribution.
2. **Shaders.**
   - `float beam(float cosA)` samples the LUT at `acos(cosA)/θmax`, and a
     single GLSL helper in `shaders/common.js` serves both the lighting and
     volumetric passes. This keeps the "one textual call site" rule.
   - The shadow-map frustum (`FlashlightShadow.js:58`) keeps using the outer
     angle.
3. **CPU mirror.** `Stalker` in-beam and any stare logic sample the same LUT
   on the CPU, with a threshold such as "beam ≥ 0.1 × peak". That keeps
   gameplay equal to the visible beam, following the same principle as the
   `lightAt` / list mirroring.
4. **Look profiles.**
   - Semi-realistic: an LED-like tight hot spot.
   - Camcorder '96: an incandescent wide, soft spill.
   - Classic: the old smoothstep, expressed as a LUT, for rollback.
5. **Fixture diffuser too (small add-on).** The fixture emission curve
   `mix(uEmitFloor, 1, pow(L.y, uEmitPow))` is duplicated in
   `shaders/lighting.js`, `shaders/contact.js:203` and
   `shaders/volumetric.js:275`. Move it to one LUT or helper as well. That
   unlocks real troffer photometry, and P1's matched mode reuses the same
   data.

### Cost

One texture fetch per lit pixel in the flashlight branch and per torch step
in the volumetric march. The work is the same on every tier; tiers already
cap march steps.

### Tests

- LUT generator: monotone energy, normalisation to the old cone's flux
  (±1%), and a Classic LUT equal to the smoothstep within 1/255.
- A GLSL-vs-JS oracle test in the style of `cel-band.test.js`.
- The Stalker in-beam equivalence at the LUT threshold.

### Acceptance

- Same mean frame luminance on the flashlight capture view (±3%).
- A visible hot spot and spill in F2 captures.
- No pass-time change beyond noise in `PassTimer`.

---

## P3 — EON diffuse for rough surfaces

**Goal.** Carpet, acoustic ceiling tile, concrete and flat paint dominate
every frame, and the first-person camera sees floors at grazing angles.
Lambert ignores the back-scatter and flattening of rough diffusers. The
tracer's WebGPU backend uses **EON**, energy-preserving Oren–Nayar
([JCGT 14(1):6, 2025](https://jcgt.org/published/0014/01/06/), Listings 1–2,
as cited in `src/webgpu/nodes/eon.wgsl.js`). It is closed-form, has no lookup
table, and reduces exactly to Lambert at σ = 0.

### Design

1. **Diffuse roughness in the G-buffer.** `gMaterial.a` is written as a
   constant 1 today (`render/gbufferMaterials.js:282`), so store diffuse
   roughness there with no new attachment and no bandwidth change.
2. **Source values.** Add a per-surface `diffuseRoughness` beside
   `SURFACE_GLOSS` / surface specs (`render/surfaces.js`): carpet about 1.0,
   ceiling tile 0.8, plaster 0.5, painted trim 0.2, and furniture parts from
   their `surface` attribute.
3. **Shader.** In `shaders/brdf.js` `brdfDirect`, replace
   `albedo * (NoL / PI)` with `eonDiffuse(albedo, σ, N, V, L) * NoL`:
   - `A = 1/(1 + (½ − 2/(3π))σ)`;
   - `f_ss = (ρ/π)·A·(1 + σ·s/t)`, where `s = L·V − (N·V)(N·L)` and
     `t = max(N·V, N·L)` when `s > 0`, otherwise 1;
   - plus the `f_ms` multi-scatter term with its polynomial `E(μ)` fit.

   The ambient/GI term can optionally scale by `E(μo)` for energy
   consistency. Only `SHADING_PBR` variants change; Classic keeps its ramp.
4. **Cost.** About 20–30 ALU per shaded fixture in the unified loop, which
   runs over the ≤ 8 list entries on grid pixels. Adding a new `#define`
   variant is unnecessary if σ = 0 is exact Lambert.

### Validation

- P1 with a white-furnace light room: a uniformly lit white room, where EON
  must conserve energy and Lambert-at-σ = 0 must match the old image
  bit-for-bit up to rounding.
- A JS oracle test of the GLSL against the reference formula.
- Look review on the office and hotel captures.

### Acceptance

- σ = 0 is pixel-identical (±1/255) to the current output.
- The furnace test passes within 1%.
- Grazing-view carpet reads visibly softer in the capture A/B.

---

## P4 — FSR1 (EASU + RCAS) upscale for `renderScale < 1`

**Goal.** Low, medium and `auto` players render at 60–100% per axis
(`DynamicResolution` floors at `max(0.6, 540/lines)`), and today the browser
stretches the canvas bilinearly. FSR1 is the spatial upscaler the WebGPU
tracer ships through `@pmndrs/upscaler`. It is two fullscreen passes: EASU,
an edge-adaptive 12-tap upscale, then RCAS, a robust contrast-adaptive
sharpen. It ports directly to the engine's GLSL. AMD's FidelityFX FSR 1 is
MIT-licensed.

### Design

1. **Canvas and internal target.** Keep the **canvas at native backing
   resolution**. Render the whole deferred pipeline into internal targets at
   `scale`; `DeferredRenderer.setSize` already sizes every target from the
   drawing buffer. This also stops DRS steps from reallocating the canvas.
2. **Pass order.** FSR1 needs anti-aliased, perceptual input, and grain must
   be added at output resolution. The new order is:

   1. grade: tone, colour and lens, **without** sensor noise and dither, at
      internal resolution;
   2. FXAA at internal resolution;
   3. **EASU** to native resolution;
   4. **RCAS** (sharpness is a setting, default about 0.2 stops);
   5. grain, TPDF dither and posterise, or the Camcorder tape signal, at
      native resolution.

   The grade shader splits its noise and dither tail into a small native-res
   pass, or RCAS absorbs it.
3. **Identity.** At `scale == 1`, skip EASU (RCAS optional). The existing
   `_runOr` identity pattern applies.
4. **Tiers.** Enabled on every preset whose ceiling or DRS can go below 1.
   One extra RGBA8 native-size target, which can alias `gradeRT`'s old role.
5. **DRS contract.** `DynamicResolution` already works in native terms. The
   upscaler only changes *how* the lower resolution is presented, so its
   hysteresis stays valid.

### Cost

Two passes at output resolution. Measure them with `PassTimer`; this document
does not guess numbers. Memory is about 8 MB at 1080p for one extra LDR
target.

### Risks

- Pass reordering touches the grade, FXAA and tape-signal contracts. Captures
  of every look must be re-reviewed.
- RCAS can emphasise the dither. Apply grain after RCAS, as designed.

### Tests

- Pass-graph test (order, identity at scale 1).
- Size-bookkeeping tests extending the existing DRS tests.
- Context-restore re-creation.

### Acceptance

- At scale 0.6, edges in the office capture are visibly sharper than the
  bilinear stretch.
- No regression at scale 1 (bit-identical when RCAS is off).
- Pass time is reported in the F2 timers.

---

## P5 — Blue noise where it actually helps

**Evidence first.** [07 E2](07-experiments.md#2-e2--blue-noise-versus-the-engines-screen-noise)
shows that blue noise does **not** reduce the residual after the engine's
5×5 resolve compared with its current 4×4 interleaved pattern: 0.0196 vs
0.0179 RMS on flat regions, and 0.063 vs 0.064 across depth edges. The
engine's choice for GTAO, contact and volumetrics is already right. What blue
noise does remove is **structure**. IGN's spectrum has peaks 8,702× the mean,
and the 4×4 pattern's peaks are 24,672×; 64² blue noise is at 157×. That
structure is visible only where noise is **not** filtered.

### Design

1. `scripts/gen-blue-noise.mjs` runs `BlueNoiseGenerator` (deep-imported
   from three-gpu-pathtracer, or a 100-line vendored copy) with a **seeded**
   RNG and writes a 64×64 R8 texture, 4 KB, as a module or PNG. It is
   committed and pinned by hash in a test. Generation takes about 40 ms in
   Node, but it happens at build time, never at startup.
2. Swap `ign(gl_FragCoord.xy)` for a `blueNoise(gl_FragCoord.xy)` fetch
   **only** in the unfiltered consumers:
   - torch PCSS/Vogel rotation (`shaders/lighting.js:436`);
   - cel-band dither (`:584-590`);
   - grade posterise/TPDF dither (`shaders/grade.js:131`).

   Keep IGN or 4×4 elsewhere.
3. If the engine ever adds temporal accumulation (TAA, temporal GTAO), move
   to spatio-temporal blue noise then. That is a separate decision.

### Cost

One 4 KB texture and one texture binding per affected pass. The IGN ALU goes
away.

### Acceptance

A capture A/B at the low tier shows no diagonal IGN pattern in the torch
penumbra or the posterised gradients. Pass time is unchanged.

---

## P6 — Offline bakes (AO / irradiance) where determinism allows

**Status: DEFER.** Runtime bakes per streamed chunk are rejected
([05 §6](05-feature-fit.md#6-baking)). What could make sense later:

- **Per catalog structure or authored template.** Bake irradiance probes or
  indirect lightmaps offline with the WebGPU tracer and a custom
  `getCameraRayFn()` that maps texel to ray, plus OIDN. Key the bake by
  structure recipe, parameters and `WORLD_GEN_VERSION`, and ship the probes
  as data.
  - Blocker: the 39 catalog structures are *procedurally parameterised*, so
    each instance differs. Bakes would only cover authored editor structures
    (`world/structures/authored.js`) or recurring room templates.
- **Furniture AO.** The Blender pipeline already bakes cavity and contact
  darkening into `COLOR_0` (`scripts/blender/yr_shading.py`), so there is no
  gap.

**Revisit when:**

1. P1b is shipped and the GI report still shows a structured error the cell
   model cannot express; or
2. the engine gains WebGPU.

---

## P7 — three-mesh-bvh in tooling, not gameplay

- **Use it** as a devDependency for the P1b report, for editor picking
  against real GLB furniture meshes (the editor's `Preview3D`), and for
  audits that need mesh-exact rays, such as validating furniture proxy boxes
  against the actual GLB silhouettes.
- **Do not use it** for AI sight, audio occlusion or the torch hit. The grid
  DDA (`player/collision.js`) and `LightGrid.raycast` are exact for the
  thin-wall world, synchronous and deterministic. A BVH would need a rebuild
  per streamed chunk for no accuracy gain on walls.

---

## P8 — Photo mode (deferred)

A pause-menu "photograph" would progressively path-trace the local
neighbourhood, with `PhysicalCamera` depth of field and the look's grade, and
export a PNG. It fits the liminal "found photo" genre and the existing
*Liminal photo* look.

It is deferred because:

- WebGL compile time is large;
- the WebGL instance expansion is expensive;
- without OIDN a clean still needs many hundreds of spp.

It becomes attractive with P1 in place (same proxy builder) and the WebGPU
tracer with OIDN on npm. Mobile and integrated GPUs should never be offered
it.

---

## P9 — Small items

- **Precision probe.** Port the idea of `PrecisionDetector`: a 1×1 render
  that measures float mantissa and int widths, both plainly and inside
  structs, in both stages. Log the result in `render/capabilities.js` reports
  and captures, because the tracer's history (Adreno struct precision, Pixel 6
  `floatBitsToInt`) matches the precision classes the engine already guards
  against with `SAMPLER_PRECISION`.
- **Stable-noise replay.** The tracer's `stableNoise` resets the sampler on
  every reset. The engine's equivalent is to make sure every stochastic
  shader input is a pure function of `gl_FragCoord` and capture time. It
  already is (IGN, the 4×4 pattern, time-hashed flicker), so this is a
  contract to keep, not a change.
