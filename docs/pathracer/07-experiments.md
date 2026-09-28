# 07 — Experiments

All experiments ran on 2026-09-28 in the project's cloud container: Linux, no
GPU, Node 22, and Chromium 1194 headless with ANGLE→SwiftShader (a CPU
Vulkan). They were run against this repository at the commit that adds this
folder (three r185, `WORLD_GEN_VERSION` 27).

Scripts lived in a scratch workspace outside the repo, so they did not change
`package.json`. Their full sources are in the appendix, so every number here
can be reproduced.

> **Not GPU timings.** SwiftShader times measure a CPU rasteriser. They show
> feasibility and *relative* cost, not frame time on player hardware. This
> follows the same disclaimer convention as `npm run benchmark:render-scene`.

| # | Question | Result in one line |
| --- | --- | --- |
| E1 | Does the library install cleanly next to three r185, and what does it cost to ship? | Yes. `WebGLPathTracer` is about 61 kB gzip and three-mesh-bvh about 16 kB (three external). Two deprecation warnings on r185. |
| E2 | Would the tracer's blue noise reduce the engine's screen-space noise? | **No** under the engine's 5×5 resolve. **Yes** for pattern structure: spectral peaks fall 55× vs IGN. |
| E3 | Can real Yellow Rooms chunks be path traced, and at what cost? | Yes, headless and without a GPU. See the numbers below. |
| E4 | How accurate is the shipped cell-graph GI against Monte Carlo ground truth? | Biased in specific, fixable ways. See the numbers below. |

---

## 1. E1 — Packaging, compatibility and bundle cost

**Method.**

- `npm view` for published versions.
- `npm install three@0.185.0 three-gpu-pathtracer@0.0.24 three-mesh-bvh@0.9.15`
  in an empty package.
- `esbuild --bundle --minify --format=esm --external:three --external:xatlas-web`
  of an entry that imports the named symbols, then `gzip -9`.

**Results.**

| Item | Value |
| --- | --- |
| Latest npm `three-gpu-pathtracer` | 0.0.24 (published 2026-02-21), WebGL-only: the tarball has **no `src/webgpu`** |
| Peer deps in 0.0.24 | `three >=0.180.0`, `three-mesh-bvh >=0.7.4`, `xatlas-web ^0.1.0` (optional in practice) |
| Peer deps on GitHub `main` | `three >=0.185.0`, `three-mesh-bvh >=0.9.15` |
| Install next to three 0.185.0 | Clean: no peer conflicts |
| `import { WebGLPathTracer }`, minified | 214,000 B, **60,985 B gzip** |
| `import { MeshBVH, acceleratedRaycast, computeBoundsTree }` from three-mesh-bvh | 49,474 B, **16,269 B gzip** |
| `BlueNoiseTexture` from the package root | Not exported. Deep import `three-gpu-pathtracer/src/textures/blueNoise/BlueNoiseGenerator.js` instead |
| Runtime warnings on r185 (from E3) | `THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.` and `MeshBVH: "maxLeafTris" option has been deprecated. Use "targetLeafSize", instead.` |

**Reading.** The WebGL tracer is shippable as a **lazy chunk** at about 77 kB
gzip with three-mesh-bvh. That is a fraction of the three vendor chunk
(about 610 kB minified per `vite.config.ts`). The two deprecation warnings
mean 0.0.24 is already slightly behind r185. Pin it, and expect the WebGL path
to disappear upstream ([01 §2](01-library-overview.md#2-two-implementations-and-which-one-you-actually-get)).

---

## 2. E2 — Blue noise versus the engine's screen noise

**Question.** The engine's stochastic passes use:

- Jimenez **IGN** (`shaders/common.js:43`);
- a **4×4 interleaved** pattern (`shaders/gtao.js`, which the 5×5
  `occResolve` integrates over exactly one period).

Would the tracer's void-and-cluster blue noise do better?

**Method.** This is pure Node over a 256² tile.

- **Fields.** Seeded white noise, the engine's IGN evaluated in fp32 at pixel
  centres exactly as the GLSL does, the engine's 4×4 pattern, and
  `BlueNoiseGenerator` tiles at 32², 64² and 128², each with a seeded
  mulberry32 injected as `generator.random`.
- **Metrics.**
  - Kolmogorov–Smirnov distance to U(0,1).
  - Share of spectral energy below 0.125 cycles/px.
  - Spectral peak/mean, where a large value means a visible, structured
    pattern.
  - RMS residual of a flat signal after 3×3 and 5×5 box filters (proxies for
    the engine's resolve).
  - RMS residual after an **edge-cut** 5×5 footprint. Straight edges at 8
    orientations and 4 offsets reject taps, the way the joint bilateral does
    at depth discontinuities.

**Results.**

| Noise | Distinct values | KS | Low-freq energy | Peak/mean | RMS 3×3 | RMS 5×5 | RMS 5×5 edge-cut |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| white | 63,461 | 0.0042 | 4.76% | 11 | 0.0964 | 0.0579 | 0.0993 |
| **IGN** (engine) | 64,356 | 0.0004 | 0.34% | **8,702** | 0.0377 | 0.0208 | **0.0619** |
| **4×4 interleaved** (engine) | 16 | 0.0312 | 0.00% | **24,672** | 0.0388 | **0.0179** | 0.0636 |
| blue noise 32² | 1,024 | 0.0005 | 0.00% | 453 | 0.0430 | 0.0203 | — |
| **blue noise 64²** | 4,096 | 0.0001 | 0.00% | **157** | 0.0429 | 0.0196 | 0.0631 |
| blue noise 128² | 16,384 | 0.0000 | 0.00% | 54 | 0.0434 | 0.0199 | — |

Generation cost in Node, which is O(N²) in the pixel count:

| Size | Time |
| --- | ---: |
| 16² | 6 ms |
| 32² | 5 ms |
| 64² | 40 ms |
| 128² | **1,061 ms** |

A seeded generator is bit-for-bit deterministic (verified at 32²).

**Reading.**

1. **Blue noise does not buy lower noise after the engine's resolve.** The
   4×4 pattern is designed to cancel over the 5×5 footprint and wins on flat
   regions (0.0179). At edges all three structured sources are equal within
   about 3%.
2. **Blue noise removes structure.** IGN's and the 4×4 pattern's energy sits
   in a few spectral spikes, which read as diagonal hatching or a grid when
   the noise is visible. 64² blue noise has 55× lower peak/mean than IGN.
   That only matters where noise is **not** filtered: torch PCSS rotation,
   cel dither, grade dither. Hence the narrow scope of
   [P5](06-proposals.md#p5--blue-noise-where-it-actually-helps).
3. **Generate offline.** 128² already costs about 1 s of JS, and startup
   generation would also make the pattern depend on `Math.random` unless it
   is seeded.

---

## 3. E3 — Path tracing real Yellow Rooms chunks

**Question.** Can the WebGL tracer (npm 0.0.24) render the game's real,
generated geometry, and what does it take?

**Method.** A tiny Vite page, whose source is in the appendix:

1. It imports the game's own `Chunk`, `createGBufferMaterials`,
   `createGeometries`, `worldConfigForFamily` and `hashStr` from `src/`, with
   three aliased to the repo's copy.
2. It builds office chunks around spawn with seed text `review` (level 1),
   including the spawn clearing, exactly as `ChunkManager` does.
3. It mirrors materials with `debug/PbrReference.js`'s mapping and
   **expands every `InstancedMesh`** into world-space geometry, folding
   `instanceColor` into vertex colour. Geometry is merged per material.
4. Every lit panel becomes a downward `RectAreaLight` (1.7 × 1.0).
5. It runs `WebGLPathTracer` with tiles (1, 1), `bounces` 4 and
   `textureSize` 256².
6. It reads back the linear HDR accumulation at checkpoints and computes
   the relative RMSE of luminance against the final image.

**Results.** Pending: this section is completed from the run logs.

---

## 4. E4 — Monte Carlo reference for the cell-graph GI

**Results.** Pending: this section is completed from the run logs.
