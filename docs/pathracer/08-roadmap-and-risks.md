# 08 — Roadmap, risks and non-goals

## 1. Staged roadmap

Each stage ships on its own and leaves the game shippable. Stages 1–3 need no
new *runtime* dependency.

| Stage | Contents | Depends on | Exit criteria |
| --- | --- | --- | --- |
| **0. Evidence** | This folder; E1–E4 reproducible from the appendix of [07](07-experiments.md) | — | Done (this change) |
| **1. GI truth** | [P1b](06-proposals.md#p1b--gi-reference-report-and-ambient-cube-refit): `npm run report:gi` (three-mesh-bvh as a devDependency), floor-irradiance-on-the-floor fix, floor→ceiling bounce term, refit ambient-cube weights, mean-preserving scale, guard test | — | Every held-out dataset: up-face bias within ±25% and overall relative RMSE ≤ 0.75 (E4 reached 0.58–0.71, from 1.26–1.52); `benchmark:light-grid` unchanged within noise; look review of every family in F2 |
| **2. Torch and surfaces** | [P2](06-proposals.md#p2--photometric-flashlight-beam-profile) beam LUT (+ shared fixture diffuser helper); [P3](06-proposals.md#p3--eon-diffuse-for-rough-surfaces) EON diffuse (σ in `gMaterial.a`) | — (P1 helps validate but is not required) | Flux-normalised beam (±3% mean luminance); σ = 0 pixel-identical; Stalker in-beam parity test |
| **3. Presentation** | [P4](06-proposals.md#p4--fsr1-easu--rcas-upscale-for-renderscale--1) FSR1 upscale; [P5](06-proposals.md#p5--blue-noise-where-it-actually-helps) pinned blue noise in unfiltered consumers | — | Sharper edges at DRS floor, identity at scale 1, pass times in F2 |
| **4. Reference view** | [P1](06-proposals.md#p1--path-traced-reference-mode-f2--editor) lazy `PathReference.js` on `WebGLPathTracer@0.0.24`: light room first, then captures; matched emitters; evidence JSON | Stage 1 makes it immediately useful (verifies the GI fix on screen) | Light room reference < 60 s @ 256 spp on a desktop GPU; no module in the boot graph |
| **5. WebGPU swap** | Move P1 to `WebGPUPathTracer` + OIDN when it is on npm; revisit [P6](06-proposals.md#p6--offline-bakes-ao--irradiance-where-determinism-allows) bakes and [P8](06-proposals.md#p8--photo-mode-deferred) photo mode | Upstream npm release; a WebGPU context in the editor or F2 | Same evidence JSON produced by both backends on the light room |

Stages 1–3 are independent of each other and can be done in any order.
Stage 1 is first because it is measured, cheap, and fixes a shipped bias.

> **Update (2026-09-28, after 0.0.25).** The upstream dependency of stage 5
> is met: the WebGPU tracer is on npm. Stages 4 and 5 were merged. The
> reference *viewer* now runs on `WebGPUPathTracer@0.0.25` as an
> experimental option, off by default, and the WebGL tracer is never used.
> Stage 4's exit criterion ("no module in the boot graph") holds for the
> tracer, three/webgpu and three-mesh-bvh. The boot bundle grows 6.2 kB
> gzip, mostly three core classes that the lazy chunks share
> ([09 §7](09-webgpu-integration.md#7-bundle-cost)). Stage 4's comparison
> tooling and evidence JSON remain open.

## 2. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| **Upstream deprecation.** `WebGLPathTracer` is deprecated on `main` and "will be removed" | Certain | P1 stage 4 needs a backend swap later | Pin `0.0.24` exactly; keep every tracer call inside one module; stage 5 plans the swap |
| **WebGPU tracer API still moving** (released as 0.0.25 on 2026-09-28; e.g. the `maxTransparentBounces` doc/code mismatch, `dispose()` throwing before `setScene`) | High | Breakage on a bump | Pinned `0.0.25` exactly; every tracer call is inside `render/pathtrace/PathTraceView.js`; the feature is experimental and off by default |
| **Wavefront throughput** (one path segment per `renderSample()`, 250k slots by default) | Certain | 1 call per frame gave ≈ 2 spp/s at 1.8 MP | `frameBudget` at the pool cap plus adaptive calls per frame: ≈ 19–22 spp/s ([09 §5](09-webgpu-integration.md#5-throughput-the-wavefront-step-problem)) |
| **Deprecation noise on r185** (`THREE.Clock`, `maxLeafTris`) turns into breakage on r186+ | Medium | Reference view stops compiling after a three bump | The reference view is dev-only; a three bump runs it once as part of the upgrade checklist |
| **Huge shader compile on ANGLE/D3D** | High on Windows | Multi-second hitch when opening the reference | Async compile (built in since 0.0.23); never on boot; progress UI |
| **Proxy-scene fidelity.** Custom G-buffer shading (detail maps, part colours, family textures, emissive signs) does not map 1:1 onto `MeshStandardMaterial` | Certain | Reference differs for reasons that are not transport | Share one `mirrorMaterial` with `PbrReference`; compare only Semi-realistic/Neutral; name every known difference in the evidence JSON |
| **Radiometric mismatch.** Windowed attenuation, diffuser profile, exposure, GI ambient double counting | Certain unless handled | Misleading A/B | Matched-emitter mode, debug window-off uniform, direct-only/indirect-only engine channels (exist) |
| **GI fix changes the look** (brighter ceilings, re-weighted walls) | Certain (it is the point) | Art-direction regression risk | Gate by the look's existing GI scale; capture A/B per family; keep old weights as a named rollback constant |
| **Determinism.** Any stochastic bake or noise texture generated at runtime | Low if followed | Capture replays diverge | Seeded generation, committed outputs pinned by hash, nothing stochastic in world bytes |
| **Bundle growth** | Low | Slower first load | Lazy chunks only; reference view off the boot path; blue noise is 4 KB |
| **Mobile.** Precision, float filtering, memory (see the tracer's CHANGELOG history) | Medium | Crashes on phones if exposed | Never offer the reference view or photo mode on the touch tier; P9 precision probe |
| **Performance regressions from P2–P4** | Low–medium | Frame time on weak GPUs | Each proposal has a PassTimer acceptance criterion; FSR1 exists to *save* time on those GPUs |

## 3. Non-goals

These were considered and rejected for this game (reasons in
[05](05-feature-fit.md)):

- Real-time path tracing, low-spp + denoise, ReSTIR, or any per-frame
  tracer use in gameplay, **as a default or supported renderer**. An
  experimental, opt-in REALTIME mode now exists
  ([10](10-realtime-integration.md)). It confirms the reasons for this
  non-goal: noise and lag in motion, streaming hitches, and GPU cost.
- Runtime lightmap or probe bakes per streamed chunk.
- Replacing the grid DDA / `LightGrid.raycast` with BVH ray queries for AI,
  audio or the torch.
- Environment-map importance sampling, sky/IBL tooling, sheen, iridescence,
  dispersion, clearcoat.
- The tracer's `DenoiseMaterial` and its `UVUnwrapper` (weaker than what
  exists, and broken, respectively).

## 4. Open questions

1. **GI scale versus art direction.** After P1b makes the bounce physically
   plausible, should `look.lampBounce` or the GI sliders stay at 1, or does
   the art direction prefer the darker ceilings the model produced by
   accident? The report provides the physical anchor. The look decides.
2. **Cross-floor GI.** E4 covered single-floor cells (hole cells excluded).
   The same method extends to atria and stair shafts (`FLAG_CEIL_HOLE` /
   `FLAG_FLOOR_HOLE` cells) by building multi-floor neighbourhoods. That is
   worth doing before tuning tower and lattice.
3. **Photometric data.** Real flashlight and troffer IES files would be
   ideal for P2. Check licences before committing any measured profile;
   parametric profiles need none.
4. **Temporal accumulation.** If the engine ever adds TAA or temporal AO,
   revisit spatio-temporal blue noise (P5 note) and FSR2-class temporal
   upscaling (the `@pmndrs/upscaler` temporal path is WebGPU-only today).
