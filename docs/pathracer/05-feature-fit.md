# 05 — Feature fit: what to take, adapt, use as a tool, or leave

Every feature in [01](01-library-overview.md)–[03](03-webgpu-backend.md) is
scored here against the engine constraints in
[04 §1](04-engine-baseline.md#1-constraints-any-adoption-must-respect).

## Verdict legend

| Verdict | Meaning |
| --- | --- |
| **PORT** | Reimplement the algorithm in the engine's own GLSL or JS. No new runtime dependency. |
| **TOOL** | Use the library (or three-mesh-bvh) only in dev, editor or report tooling. It is lazy-loaded and never in the game's boot path or emitted world bytes. |
| **DEFER** | Worth it only after a prerequisite: WebGPU in the engine, an npm release, temporal accumulation, or a measured need. |
| **REJECT** | Does not fit this game, or the engine already does better. |

- **Value** (H/M/L) is the expected improvement to the game or to the team's
  ability to tune it.
- **Effort** (S/M/L) is roughly ≤ 2 days / ≤ 2 weeks / more.
- **Risk** covers determinism, portability, performance and maintenance.

## 1. Renderers and architecture

| Feature | Verdict | Value | Effort | Risk | Reasoning |
| --- | --- | --- | --- | --- | --- |
| `WebGLPathTracer` as the **game renderer** (any tier) | REJECT | — | — | — | Accumulation resets on every camera move, one tile per call, whole-scene re-flattening, and monolithic recompiles ([02 §2](02-webgl-backend.md#2-progressive-accumulation)). The game streams, moves constantly and uses a stylised grade. |
| `WebGLPathTracer` as a **dev reference view** (F2 light room, capture replay) | **TOOL** → [P1](06-proposals.md#p1--path-traced-reference-mode-f2--editor) | H | M | M | It runs on the current `WebGLRenderer`. The spike converged real chunks in headless SwiftShader ([07 E3](07-experiments.md#3-e3--path-tracing-real-yellow-rooms-chunks)). About 61 kB gzip, lazy-loaded like `LazyDebugMode`. Risk: deprecated upstream, so pin 0.0.24. |
| `WebGPUPathTracer` as a dev reference | DEFER → P1 phase 3 | H | M | M | Not on npm yet. Needs a second (WebGPU) context. Handles `InstancedMesh` natively and has OIDN for clean stills. |
| Real-time low-spp path tracing + denoise | REJECT | — | L | H | Not viable on either backend ([03 §7](03-webgpu-backend.md#7-performance-memory-and-real-time-viability)). Needs ReSTIR-class light sampling for 100+ fixtures, a temporal denoiser and motion vectors, and would fight the look profiles. |
| Wavefront / megakernel compute design | DEFER | L | L | M | Relevant only if the engine moves to WebGPU **and** gains a large GPU ray workload. |
| Progressive UX: raster until N samples, fade in, `renderScale`, `stableNoise` | **PORT** into P1 | M | S | L | Cheap patterns that make a reference view pleasant and reproducible. |
| MeshDiff / BakedGeometry scene sync | TOOL (pattern) | L | S | L | Keeps a reference proxy scene in sync with streamed chunks. The spike's rebuild-on-demand is simpler and enough. |

## 2. Transport ground truth (the main value)

| Feature | Verdict | Value | Effort | Risk | Reasoning |
| --- | --- | --- | --- | --- | --- |
| Monte Carlo **GI reference** for the cell-graph bounce (three-mesh-bvh CPU rays over real chunk meshes) | **TOOL** → [P1b](06-proposals.md#p1b--gi-reference-report-and-ambient-cube-refit) | **H** | S–M | L | Deterministic, Node-only, fits the `report:*` culture. [07 E4](07-experiments.md#4-e4--monte-carlo-reference-for-the-cell-graph-gi) measured the shipped ambient cube against it and found real, fixable biases. |
| Area-light soft shadows vs `gridTrace` / furniture boxes / capsules | TOOL (in P1) | M | S | L | Once P1 exists this is only a view. It validates `shadowMath.js` form factors and trace caps per tier. |
| `FogVolumeMaterial` in-scatter reference | TOOL (in P1, WebGL only) | M | S | L | Replaces the eyeballed `VOL_INTENSITY` 0.75 → 0.3 change with a measured target. WebGPU has no fog yet. |
| `AmbientOcclusionMaterial` ray-traced AO | TOOL | M | S | L | GTAO ground truth (radius and falloff tuning). Also a UV-space baker template if bakes ever happen. |
| Stock-three `PbrReference` (exists) | keep | — | — | — | Still the fastest BRDF A/B check. P1 extends it; it does not replace it. |

## 3. Shading and light models portable to the raster engine

| Feature | Verdict | Value | Effort | Risk | Reasoning |
| --- | --- | --- | --- | --- | --- |
| **Photometric beam profile** (the `PhysicalSpotLight.iesMap` idea) for the flashlight | **PORT** → [P2](06-proposals.md#p2--photometric-flashlight-beam-profile) | H | S | L | The torch is the player's main tool and main horror instrument. Today it is a `smoothstep(cosOuter, cosInner)` cone (`shaders/lighting.js:894`). A 1D profile texture gives a hot spot, spill ring and dark rings. Cost is one texture fetch per pixel. |
| IES-style **diffuser profile for fixtures** | PORT (small) in P2 | M | S | L | Today it is `mix(uEmitFloor, 1, pow(L.y, uEmitPow))`, repeated in lighting, contact and volumetrics. A shared 1D LUT unifies it and allows real troffer curves. |
| **EON diffuse** (energy-preserving Oren–Nayar, WebGPU `eon.wgsl.js`) | **PORT** → [P3](06-proposals.md#p3--eon-diffuse-for-rough-surfaces) | M | S | L | Carpet, acoustic tile and concrete are the dominant rough surfaces. Lambert is too flat at grazing view, which the first-person camera sees constantly. Closed form, no LUT, Lambert at roughness 0. |
| Burley diffuse (WebGL tracer) | REJECT | — | — | — | Not energy-preserving. EON supersedes it. |
| Turquin multi-scatter GGX compensation | DEFER | L | S | L | Matters for rough metals, which are rare (props and knobs). Re-evaluate if P1 shows dark rough metal. |
| Area-light MIS / uniform rect sampling | REJECT for raster | — | — | — | Raster needs closed-form area lighting (the existing representative-point or LTC), not sampling. Revisit LTC only if P1 shows the panel reflections on glossy floors are the wrong shape. |
| GGX VNDF sampling | REJECT (N/A) | — | — | — | Useful only for stochastic reflections, which the engine does not have. |
| Charlie sheen, iridescence, dispersion, clearcoat | REJECT | L | — | — | No content needs them. Upholstery sheen is a possible far-future nicety. |

## 4. Sampling and noise

| Feature | Verdict | Value | Effort | Risk | Reasoning |
| --- | --- | --- | --- | --- | --- |
| `BlueNoiseGenerator` void-and-cluster, **pre-baked** and pinned | **PORT** (targeted) → [P5](06-proposals.md#p5--blue-noise-where-it-actually-helps) | L–M | S | L | [07 E2](07-experiments.md#2-e2--blue-noise-versus-the-engines-screen-noise): **no residual reduction** after the engine's 5×5 resolve, but it removes IGN's strong spectral peaks (peak/mean 157 vs 8,702). Use it only in unfiltered consumers: torch PCSS rotation, cel dither, grade dither. |
| Spatio-temporal blue noise + temporal accumulation | DEFER | M | M–L | M | Blue noise pays off fully under temporal accumulation, which the engine does not have. It belongs with a future TAA or temporal AO decision, not before. |
| Owen-scrambled Sobol, stratified sampler | REJECT (engine) / TOOL | L | — | — | The engine's AO kernel is already deterministic low-discrepancy (van der Corput + golden angle). Useful only in the E4-style Monte Carlo tools. |

## 5. Post, upscaling and denoising

| Feature | Verdict | Value | Effort | Risk | Reasoning |
| --- | --- | --- | --- | --- | --- |
| **FSR1 (EASU + RCAS)** from the WebGPU `FSRUpscaler` path | **PORT** → [P4](06-proposals.md#p4--fsr1-easu--rcas-upscale-for-renderscale--1) | M–H | M | L–M | `DynamicResolution` can drop to 0.6 per axis (36% of pixels), and the browser then stretches bilinearly. Two GLSL fullscreen passes after the grade give visibly sharper edges on the `auto`, medium and low tiers. Must interact correctly with FXAA, the tape signal and the dither. |
| Tone-map-before-upsample (`ClampedInterpolationMaterial`) | PORT (principle, in P4) | L | S | L | Already true implicitly (the grade runs before the stretch). Keep it true when adding P4. |
| `DenoiseMaterial` (colour-only bilateral) | REJECT | — | — | — | The engine's joint-bilateral resolve already uses depth and normals. |
| **OIDN** (`OIDNDenoiser`) | DEFER → [P6](06-proposals.md#p6--offline-bakes-ao--irradiance-where-determinism-allows)/[P8](06-proposals.md#p8--photo-mode-deferred) | M | M | M | For stills and bakes only, and only on WebGPU. About 1.8 MB of weights. |

## 6. Baking

| Feature | Verdict | Value | Effort | Risk | Reasoning |
| --- | --- | --- | --- | --- | --- |
| Runtime lightmap or probe bake per streamed chunk | REJECT | — | L | H | Hundreds of chunks stream in and out, and world bytes must be deterministic. The engine's cell GI already *is* a runtime bake, and it is cheap. |
| Offline or first-run bake per **authored template / catalog structure** | DEFER → P6 | M | L | M | Possible for the 39 catalog structures and editor-authored rooms, but they are procedurally parameterised. Fix the cheap GI biases (P1b) first and bake only if a gap remains. |
| xatlas `UVUnwrapper` | REJECT | — | — | — | Broken upstream (undefined identifiers). Call xatlas-web directly if a bake ever needs UVs. |
| Skyline `AtlasTexture` packer | DEFER | L | S | L | Renderer-agnostic JS. Only useful once something is baked. |

## 7. Queries, tooling and portability

| Feature | Verdict | Value | Effort | Risk | Reasoning |
| --- | --- | --- | --- | --- | --- |
| three-mesh-bvh CPU raycasts for **gameplay** (AI sight, audio occlusion, torch hit) | REJECT | — | — | — | `player/collision.js` grid DDA and `LightGrid.raycast` (2.5D Amanatides–Woo) are exact for the thin-wall topology, synchronous, allocation-free and deterministic. A mesh BVH would be slower and would need rebuilding per streamed chunk. |
| three-mesh-bvh for **tools** (E4 report, editor picking against GLB furniture, audits) | **TOOL** | M | S | L | About 16 kB gzip (MIT, same author). Mesh-exact where the grid is an abstraction. It is exactly how E4 works. |
| `PrecisionDetector`-style probe (float and int precision in and out of structs) | PORT (small) → [P9](06-proposals.md#p9--small-items) | L | S | L | Complements `render/capabilities.js` on mobile. Log it in captures and evidence records. |
| `PhysicalCamera` DoF / bokeh | REJECT (gameplay) / DEFER (P8) | L | — | — | Not a first-person horror tool, but fits a photo mode. |
| `EquirectCamera` panoramas | TOOL (optional) | L | S | L | Art review of atria and structures as 360° references. |
| Environment importance sampling, blurred env maps | REJECT | — | — | — | Interior game with no sky or IBL. |

## 8. Top of the list

Ordered by value ÷ (effort × risk):

1. **P1b — GI reference report + ambient-cube refit** (TOOL). Measured,
   deterministic, and changes shipped lighting quality directly.
2. **P2 — Photometric flashlight beam** (PORT). One texture fetch, big
   atmosphere win.
3. **P1 — Path-traced reference view** (TOOL). A calibration instrument for
   every lighting constant.
4. **P3 — EON diffuse** (PORT). Small shader change, validated by P1.
5. **P4 — FSR1 upscale** (PORT). Helps exactly the players on weak GPUs.
6. **P5 — Targeted blue noise** (PORT). Small and cosmetic, with honest,
   measured expectations.
