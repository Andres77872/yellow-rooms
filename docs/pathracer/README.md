# Path tracer research: three-gpu-pathtracer × Yellow Rooms

Research date: 2026-09-28. Subject: [gkjohnson/three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer)
at `main` `8de7270`, where the WebGPU backend (PR #713) merged that day, and
npm `0.0.24`. Target: this repository's three r185 WebGL2 deferred renderer
and `WORLD_GEN_VERSION` 27.

## The question

Can any of three-gpu-pathtracer's technology or features be brought into
Yellow Rooms to improve the engine? Which ones are useful, and how would
they fit?

## Short answer

**Not as a renderer. Yes as an instrument, and as a source of portable
techniques.**

- **The tracer is not a game renderer.** Every camera move restarts
  accumulation, and a clean image needs hundreds of samples. The WebGL
  backend, the only one on npm, is already deprecated upstream. The WebGPU
  backend needs `WebGPURenderer` and is not released. Nothing here should
  run in the game's frame loop.
- **It is an excellent ground truth for an engine that is full of
  hand-tuned lighting approximations.** The strongest measured finding comes
  from a deterministic Monte Carlo reference built on the tracer's BVH
  library (three-mesh-bvh) over the game's **real generated chunks**. The
  shipped cell-graph GI has specific, fixable biases (see below).
- **Four techniques in the tracer port cheaply to the raster engine:**
  - a photometric (IES-style) **flashlight beam profile**;
  - **EON** energy-preserving rough diffuse;
  - **FSR1** upscaling for dynamic resolution;
  - pinned **blue noise** for unfiltered dither, with honest, measured
    expectations.

## Key measured findings

| # | Finding | Evidence |
| --- | --- | --- |
| 1 | The WebGL tracer installs cleanly next to three 0.185.0. It costs **61 kB gzip**, plus 16 kB for three-mesh-bvh. It warns about two r185 deprecations. | [E1](07-experiments.md#1-e1--packaging-compatibility-and-bundle-cost) |
| 2 | Blue noise does **not** lower noise after the engine's 5×5 resolve: 4×4 interleaved 0.0179 vs blue noise 0.0196 RMS. It does remove structure: spectral peak/mean is **157 vs 8,702 for IGN**. Use it only where noise is unfiltered. | [E2](07-experiments.md#2-e2--blue-noise-versus-the-engines-screen-noise) |
| 3 | Real office chunks, built by the game's own generator and mesher, path trace headlessly with **no GPU** (SwiftShader) once instances are expanded. | [E3](07-experiments.md#3-e3--path-tracing-real-yellow-rooms-chunks) |
| 4 | The shipped cell-graph GI is **single-bounce by construction**. Its ceiling term is identically 0, so **up-facing indirect light is about 70% too dark**. The floor's radiosity is sampled at mid-height instead of on the floor, which inflates it under fixtures. More Jacobi iterations do not help. A cross-validated refit with the same cost cuts the error substantially. | [E4](07-experiments.md#4-e4--monte-carlo-reference-for-the-cell-graph-gi) |

## Recommendations, ranked

| Rank | Proposal | Kind | Why |
| --- | --- | --- | --- |
| 1 | [P1b GI reference report + fix](06-proposals.md#p1b--gi-reference-report-and-ambient-cube-refit) | Dev tool → shipped lighting fix | Measured bias, deterministic, Node-only, cheap |
| 2 | [P2 Photometric flashlight beam](06-proposals.md#p2--photometric-flashlight-beam-profile) | Shader port | The torch is the player's main instrument; costs one fetch |
| 3 | [P1 Path-traced reference view](06-proposals.md#p1--path-traced-reference-mode-f2--editor) | Lazy dev tool | Calibrates every lighting constant against ground truth |
| 4 | [P3 EON diffuse](06-proposals.md#p3--eon-diffuse-for-rough-surfaces) | Shader port | Carpets and ceiling tiles at grazing angles; free G-buffer channel |
| 5 | [P4 FSR1 upscale](06-proposals.md#p4--fsr1-easu--rcas-upscale-for-renderscale--1) | Post port | Sharper image exactly where DRS drops resolution |
| 6 | [P5 Targeted blue noise](06-proposals.md#p5--blue-noise-where-it-actually-helps) | Small port | Cosmetic; removes the IGN pattern from unfiltered dither |
| — | [P6 bakes](06-proposals.md#p6--offline-bakes-ao--irradiance-where-determinism-allows), [P8 photo mode](06-proposals.md#p8--photo-mode-deferred) | Deferred | Wait for WebGPU on npm and for P1b's residual error |

Explicitly **not** recommended: real-time or low-spp path tracing, runtime
per-chunk bakes, and replacing the grid DDA with BVH ray queries in
gameplay. See the [non-goals](08-roadmap-and-risks.md#3-non-goals).

## Reading order

| Chapter | Content |
| --- | --- |
| [01 — Library overview](01-library-overview.md) | What it is, the two backends, the release situation, feature inventory, verbatim gotchas, licence |
| [02 — WebGL backend](02-webgl-backend.md) | Scene flattening and BVH, accumulation, data packing, BSDF, lights and MIS, sampling, fog, utilities, platform history |
| [03 — WebGPU backend](03-webgpu-backend.md) | Wavefront vs megakernel, EON/GGX/Turquin materials, Sobol and blue dither, OIDN, FSR1, memory, and real-time viability |
| [04 — Engine baseline](04-engine-baseline.md) | Constraints, each deferred pass mapped to its path-traced counterpart, existing verification tooling, noise inventory |
| [05 — Feature fit](05-feature-fit.md) | Every feature scored: PORT / TOOL / DEFER / REJECT |
| [06 — Proposals](06-proposals.md) | P1–P9 designs with touch points, costs, tests and acceptance criteria |
| [07 — Experiments](07-experiments.md) | E1–E4 methods and results |
| [07a — Experiment sources](07a-experiment-sources.md) | Verbatim scripts so every number can be reproduced |
| [08 — Roadmap and risks](08-roadmap-and-risks.md) | Staged plan, risk register, non-goals, open questions |

## Provenance and conventions

- **Line references.** Upstream references such as
  `src/core/WebGLPathTracer.js:105` point into the upstream checkout at
  `8de7270`. `README@0.0.24` means the README inside the npm tarball.
  Engine references are relative to this repository's `src/`.
- **Interpretation.** Statements marked "interpretation" are analysis.
  Everything else was read in source or measured.
- **Timings.** Experiment timings come from a GPU-less container (SwiftShader
  and Node). They show feasibility and relative cost, not player frame
  time.
- **No functional change.** This folder changes no game code.
  `WORLD_GEN_VERSION`, world pins and captures are unaffected.
