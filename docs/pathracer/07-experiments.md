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

**Question.** How close is the shipped world-grid bounce (`LightGrid._solveGI`)
to the indirect light the same scene would really receive?

### What the shipped model computes

For every cell:

1. **Direct irradiance.** `_directCube` computes it on the six axis faces at
   the **cell centre, mid-height** (1.6 m), from the cell's light list. It
   uses a point emitter at `EMITTER_Y`, a `GI_EMIT_FLOOR` diffuser profile,
   the windowed `physicalAttenuation`, and the list's 6-bit visibility.
2. **Surface radiosity.** Each face term is multiplied by the family albedo.
   The result is the "emission" of the cell's walls, floor and ceiling.
3. **Relaxation.** Three Jacobi iterations relax the mean cell radiosity
   across open edges. A wall contributes its own reflection instead of the
   neighbour's.
4. **Ambient cube.** Built from those terms with fixed weights:
   - side faces `0.5·near + 0.25·(ceil + floor) + 0.1·avgSide`;
   - up `0.6·ceil + 0.4·avgSide`;
   - down `0.6·floor + 0.4·avgSide`.

   The GI shader reads this cube.

### Method

The analysis is pure Node with no GPU. Sources are in
[07a](07a-experiment-sources.md): `gi-reference.mjs` and `gi-fit.mjs`.

1. **Scenes.** 5×5 chunks on floor 0 around spawn are built with the game's
   `Chunk` (seed text `<seed>#1`, spawn clearing). The GI-relevant batches
   (floor `carpet`, `ceiling`, and `wallpaper`, which includes walls, columns
   and steps) are expanded and put into one `three-mesh-bvh` `MeshBVH`, about
   26–73k triangles. Furniture is excluded because the grid's lists ignore it
   too.
2. **Shipped grid.** A `LightGrid` is fed the same 25 `ChunkData` and
   flushed. A subclass copies `_solveGI` **verbatim**, only adding term
   capture, a configurable iteration count, and an optional variant that
   samples the floor's direct irradiance *on the floor* (2 cm above the slab)
   instead of at mid-height.
3. **Reference.** For each of the 194 central-chunk cells (column, pier and
   slab-hole cells skipped) and each of the six axis faces:
   - 512 cosine-distributed paths with up to 6 bounces;
   - Lambertian surfaces with the grid's default albedos (floor 0.4, walls
     and ceiling 0.5);
   - at every bounce, direct light is **summed over every lit lamp within
     `LIGHT_RANGE`**, using the grid's own emitter model but exact BVH
     visibility.

   The reference therefore differs from the grid only in transport and
   visibility, never in emitter physics. The RNG is seeded, so the result is
   deterministic.
4. **Noise floor.** The reference's own Monte Carlo error was estimated from
   two independent half-sample estimates: relative RMSE **0.050–0.052** in
   every dataset. Differences above that are model error.
5. **Metrics.** Per face class (side/up/down/all):
   - bias of mean prediction versus mean reference;
   - Pearson correlation over cells;
   - relative RMSE (RMSE ÷ mean reference, no rescaling).
6. **Refits** are **leave-one-dataset-out**: fitted by least squares on the
   other three datasets and scored on the held-out one.

Datasets:

| Dataset | Cells | Lamps (5×5) | BVH triangles | Monte Carlo time |
| --- | ---: | ---: | ---: | ---: |
| office / `review` | 194 | 472 | 25,880 | 142 s |
| office / `atlas` | 194 | 411 | 26,030 | 172 s |
| hotel / `review` | 196 | 580 | 32,892 | 189 s |
| sewer / `review` | 90 | 218 | 72,664 | 40 s |

Chunk generation and meshing took 0.4–1.2 s for 25 chunks, the BVH build
0.07–0.22 s, and two grid flushes 0.35–0.45 s.

### Results: shipped model vs the multi-bounce reference

| Dataset | Side bias | **Up bias** | Down bias | Corr (all) | relRMSE (all) |
| --- | ---: | ---: | ---: | ---: | ---: |
| office / review | −21% | **−71%** | +15% | 0.745 | 1.31 |
| office / atlas | −23% | **−73%** | +20% | 0.734 | 1.26 |
| hotel / review | −15% | **−69%** | +19% | 0.711 | 1.44 |
| sewer / review | −10% | **−66%** | +26% | 0.759 | 1.52 |

Controls:

- **8 Jacobi iterations instead of 3.** Relative RMSE changes by less than
  1% in every dataset, and correlation by at most 0.007. The diffusion is not
  where the error is.
- **Shipped vs a one-bounce-only reference.** The shipped cube is 45–65%
  *brighter* than true one-bounce light, yet 9–21% *darker* than multi-bounce
  light overall. It sits between the two because two errors partly cancel,
  as the next section explains.

### Diagnosis

1. **The ceiling term is identically 0.** Overhead fixtures never light a
   downward-facing ceiling directly, and the model has no second bounce. So
   the up-facing cube (the light that ceilings and upper walls *receive* from
   the lit floor) comes only from `0.4·avgSide`, and is **about 70% too
   dark** in every family.
2. **The floor's radiosity is sampled at the wrong height.** At mid-height
   the receiver is about 1.56 m below a fixture instead of about 3.16 m. The
   windowed inverse square, `1/(d² + 0.25)`, then overstates the floor's
   direct irradiance by up to about 3.8× directly under a lamp. That is the
   down-face's huge relative RMSE (1.9–2.2) from a few very wrong cells.
   Sampling on the floor alone raises the down-face correlation to
   **0.96–0.98** and cuts its relative RMSE to 0.51–0.64. With the shipped
   weights, though, the overall level then drops by about 55%: the weights
   had been compensating for the inflated floor.
3. **The remaining terms rank cells well.** Side-face correlation is
   0.70–0.79. The weights are simply not fitted.

### Results: cheap model fixes, cross-validated

Three candidate models were fitted, each with the **same inputs and cost** as
today:

- **A.** The shipped form with refit weights.
- **B.** A, with the floor sampled on the floor.
- **C.** B, plus a **floor-bounce term for up-facing faces**, so the ceiling
  sees the floor's radiosity: a second bounce at one multiply-add.

Held-out overall relative RMSE, with the shipped value for comparison:

| Held-out dataset | Shipped | A | B | **C** | C: corr | C: up bias | C: up corr |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| office / review | 1.31 | 0.64 | 0.61 | **0.58** | 0.877 | −16% | 0.894 |
| office / atlas | 1.26 | 0.64 | 0.64 | **0.59** | 0.850 | −24% | 0.899 |
| hotel / review | 1.44 | 0.66 | 0.65 | **0.62** | 0.817 | −7% | 0.861 |
| sewer / review | 1.52 | 0.75 | 0.76 | **0.71** | 0.886 | −7% | 0.896 |

Model C **cuts per-cell error by 53–57% in every family, including the
held-out hotel and sewer**. Up-face correlation rises from 0.50–0.69 to
0.86–0.90, and the up-face bias shrinks from about −70% to between −7% and
−24%.

Weights fitted on all four datasets (model C). Terms are the capture order
`near` (the side the face looks at), `vert = ceil + floor`, `avgSide`, and
`floor`:

| Face | Shipped | Fitted |
| --- | --- | --- |
| side | 0.5·near + 0.25·vert + 0.1·avgSide | **0.642**·near + **0.485**·vert + **0.611**·avgSide |
| up | 0.6·ceil + 0.4·avgSide | **0.412**·floor + **0.642**·avgSide (ceil weight → 0) |
| down | 0.6·floor + 0.4·avgSide | **0.709**·floor + **1.386**·avgSide |

The fitted weights sum to more than 1. That is expected: the inputs are
single-bounce radiosities, and the fit folds in the multi-bounce gain
(roughly `1/(1 − ρ)` for ρ ≈ 0.4–0.5).

### Reading and caveats

- The residual error (relative RMSE about 0.6 against a 0.05 noise floor)
  is what a one-point-per-cell, axis-cube model cannot express: light
  varying inside a 3 m cell, directional structure beyond six faces. Bigger
  gains would need a finer representation (per-face probes, or cells
  subdivided in y), which is a larger design change and not proposed here.
- **Scope.**
  - Floor 0 only; hole cells (stairs, atria, voids) skipped.
  - Grey default albedos: the renderer sets family albedos at runtime, and
    the fit is on luminance, so this is a scale question, not a structural
    one.
  - The lamp tint is quantised exactly as the grid does it.
  - Tower and lattice (multi-floor voids) are the next datasets to add;
    see [08 §4](08-roadmap-and-risks.md#4-open-questions).
- The fitted numbers are **evidence for P1b, not a patch**. The real change
  should come from the productionised `report:gi` over a larger seed corpus,
  with a mean-preserving final scale and a look review
  ([P1b](06-proposals.md#p1b--gi-reference-report-and-ambient-cube-refit)).
