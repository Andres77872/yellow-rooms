# 03 — WebGPU backend deep dive (`WebGPUPathTracer`)

The WebGPU backend landed on `main` through PR #713 (merge `897f9dd`,
2026-09-28). It is **not on npm yet**: the published 0.0.24 tarball has no
`src/webgpu`, and `CHANGELOG.md:7-15` lists it as "Unreleased". It needs
`THREE.WebGPURenderer` and TSL, so the game's current `WebGLRenderer` cannot
drive it.

This chapter matters to Yellow Rooms in two situations:

- as a tool that runs in its **own** WebGPU context (editor, bake, reference);
- as a guide for a future WebGPU migration.

Paths are relative to the upstream checkout. "Interpretation" marks analysis
that goes beyond the code.

## 1. API and requirements

```js
import * as THREE from 'three/webgpu'
import { WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu'

const renderer = new THREE.WebGPURenderer()
await renderer.init()                    // renderSample() is a no-op until initialised
const pathTracer = new WebGPUPathTracer(renderer)
pathTracer.setScene(scene, camera)       // synchronous CPU BVH build
function frame() { requestAnimationFrame(frame); pathTracer.renderSample() }
```

(`README.md:57-82`; the init guard is at `src/webgpu/WebGPUPathTracer.js:977-981`)

- **After a change,** call the matching `updateMaterials`, `updateTransforms`,
  `updateCamera`, `updateEnvironment` or `updateLights`. Each one also resets
  accumulation (`src/webgpu/API.md:254-261`). Geometry changes need a full
  `setScene` (`API.md:604-606`).
- **Main options:**

  | Option | Default | Source |
  | --- | --- | --- |
  | `maxBounces` | 15 | `PathTracerBackend.js:10` |
  | `frameBudget` (path slots per call) | 250000 | `:14` |
  | `maxSamples` (0 = unlimited; the denoiser needs a value above 0) | 0 | `:19` |
  | `filterGlossyFactor`, `clampDirect`, `clampIndirect`, `multipleImportanceSampling` | — | `WebGPUPathTracer.js:561-565` |
  | `renderScale`, `dynamicLowRes`, `lowResScale`, `fadeDuration`, `renderDelay`, `minSamples`, `stableNoise` | — | `:485-559` |

- **Doc/code mismatch.** `maxTransparentBounces` is documented as defaulting
  to 5 (`API.md:287`), but the backend initialises it to 15
  (`PathTracerBackend.js:15`).
- **Extension hooks:**
  - `setMaterial(PathtracingMaterial)` for a custom BSDF;
  - `setRandom` for a custom sampler;
  - any camera exposing `getCameraRayFn()` returning a WGSL
    `getCameraRay(uv, res, ray) -> bool` for custom ray generation (`:767-814`).

  The side-effect imports in `src/webgpu/index.js:8-11` install that function
  on `PhysicalCamera`, `EquirectCamera` and `ArrayCamera`.
- **Debug views:** `renderDebugBounds`, `renderTextureAtlas` and
  `renderSampleDensity` (`:1130-1264`).

**Compared with the WebGL backend:**

- `tiles` became a resolution-independent `frameBudget`.
- The 1024² texture array became an automatic skyline atlas.
- The async BVH worker is gone, so BVH builds now block the main thread.
- The `samples` getter became the async `getSampleCountsAsync()`, because the
  wavefront design gives different pixels different sample counts.
- Denoise and upscale hooks were added.
- **Fog volumes were dropped for now** (`PathtracerBVHComputeData.js:594-636`
  is commented out).

## 2. BVH and scene data

- **Bottom level.** One `MeshBVH` per geometry, built on the CPU with SAH and
  `targetLeafSize: 5`. Skinned meshes use `SkinnedMeshBVH`
  (`WebGPUPathTracer.js:659-697`).
- **Top level.** `PathtracerBVHComputeData` extends three-mesh-bvh's
  `BVHComputeData` (from `three-mesh-bvh/webgpu`), which builds the
  top-level BVH over objects. That is why **`InstancedMesh` and `BatchedMesh`
  work here** (`nodes/PathtracerBVHComputeData.js:894-935`).
  - `updateTransforms()` only refits the top level.
  - Traversal is one WGSL stack loop, 60 entries deep.
- **Hit handling.** The first-hit query applies side culling, opacity and
  alpha test inside the traversal (`:166-389`), so cut-out fences and grates
  are free.
- **Vertex data.** Attributes are stored as `vec4f` each: position, normal,
  tangent, colour and uv0–uv7 (`:28-79`).
- **Materials.** 276 floats (1104 B) each, with bit-packed map descriptors
  (atlas index, UV channel, wrap, filter) and 17 UV transforms
  (`nodes/structs.wgsl.js:27-160`).
- **Texture atlas.** `AtlasTexture` uses skyline bottom-left packing
  (Jylänki / stb_rect_pack) into RGBA8 pages of up to 4096², sampled with
  manual bilinear filtering and **no mipmaps** (`AtlasTexture.js:11-258`,
  `nodes/utils.wgsl.js:303-365`). Any change to the texture set repacks the
  whole atlas.

> **Yellow Rooms note.** Two-level instancing is the decisive difference for
> this game. The world is almost entirely `InstancedMesh` batches, so the
> WebGPU tracer could consume `Chunk.group` subtrees **nearly as-is**, with
> only material proxies swapped. The WebGL tracer needs every instance
> expanded, as the [spike](07-experiments.md#3-e3--path-tracing-real-yellow-rooms-chunks)
> does.

## 3. Megakernel versus wavefront

### Megakernel

`compute/PathTracerMegaKernel.js` runs one thread per pixel for the whole
path. The loop at `:160-451` does, per bounce:

1. trace;
2. area-light forward hit;
3. stochastic alpha;
4. emission;
5. one-sample NEE with an inline shadow ray;
6. BSDF sample;
7. Russian roulette from bounce 3;
8. environment on a miss;
9. running-mean blend.

The frame is tiled into squares of at most `frameBudget` pixels
(`MegaKernelPathTracer.js:175-265`).

### Wavefront (the default)

The wavefront backend is the default (`WebGPUPathTracer.js:472`); its
docstring says it "is faster on most scenes" (`:419-420`). Its state lives in
three kinds of buffer:

- **Path-slot pool.** A persistent pool of 224-byte `RayData` records
  (`compute/wavefront/structs.js:29-89`). Its size is
  `min(128 MB / record, pixels, frameBudget)`, about 599k slots
  (interpretation from the std430 layout).
- **Trace queues.** Two append-only queues, one for bounce rays and one for
  shadow rays, each with an atomic length.
- **Pixel queue.** A round-robin ring of pixels that currently have no slot.

Each `renderSample()` advances every live path **by one segment** through
these kernels (`WaveFrontPathTracer.js:428-508`):

1. **LogicKernel** (touches no BVH data):
   - resolve the previous shadow ray;
   - add emission and apply the staged scatter;
   - test forward hits against every area light (skipped on the camera
     segment, `LogicKernel.js:150-156`);
   - pick one NEE light **uniformly** (`:188-196`, with a TODO to
     importance-sample it);
   - finish terminated paths into the output.
2. **MaterialKernel**:
   - dead slots pull a new pixel and spawn a camera ray;
   - live slots build the surface record, handle alpha, dispersion and
     volume attenuation, sample the BSDF, apply Russian roulette, enqueue
     the bounce ray, and evaluate the BSDF for the chosen light to enqueue a
     shadow ray.
3. **QueueLengthToDispatchKernel**: a 1-thread kernel that turns queue
   lengths into indirect-dispatch arguments.
4. **TraceRayKernel** and **TraceShadowRayKernel**: pure traversal. Shadow
   rays use closest-hit, because "no dedicated any-hit traversal exists yet".

*Interpretation.* The wavefront design separates the branchy material code
from coherent traversal, launches no idle lanes for finished paths, and keeps
the pool full through path regeneration. It does **not** sort by material, so
shading divergence remains inside MaterialKernel.

**Sampling.** No variance-driven adaptive sampling exists. Per-pixel counts
(2 flag bits and 30 count bits in an `r32uint`) diverge only because paths
have different lengths. `TallySampleCountsKernel` reduces them to
min/max/total for the fade-in and denoise gates.

**Memory at defaults** (interpretation): the slot and queue buffers take
about 112 MB, and 1080p per-pixel targets about 83 MB. That is roughly 195 MB
before BVH, geometry and atlas.

## 4. Materials

`GltfCompliantMaterial` layers lobes in this order: clearcoat → sheen →
transmission → specular (metal, dielectric, iridescence) → diffuse. Each layer
attenuates the energy that reaches the layers below it
(`materials/GltfCompliantMaterial.js:53-256`). Every sampled direction is
re-evaluated with the shared mixture pdf, so NEE and BSDF sampling always
agree.

### EON (energy-preserving Oren–Nayar) diffuse

`nodes/eon.wgsl.js` implements the energy-preserving Oren–Nayar model from
[JCGT 14(1):6 (2025)](https://jcgt.org/published/0014/01/06/). It is the
default diffuse term.

- **Single scatter:** Fujii's improved Oren–Nayar,
  `f_ss = (ρ/π)·A·(1 + σ·s/t)`, where:
  - `A = 1 / (1 + (½ − 2/(3π))·σ)`;
  - `s = V·L − (N·V)(N·L)`;
  - `t = max(NdotV, NdotL)` when `s > 0`, otherwise 1.
- **Multiple scatter:** restores the energy that single-scatter Oren–Nayar
  loses at high roughness:
  - `f_ms = (ρ_ms/π) · (1 − E(μo)) · (1 − E(μi)) / (1 − Ē)`;
  - `ρ_ms = ρ²·Ē / (1 − ρ·(1 − Ē))`;
  - `E(μ)` is a polynomial fit.
- **Input:** roughness comes from `material.diffuseRoughness`. At 0 the model
  reduces to Lambert (`eon.wgsl.js:64-68`).

It is small, closed-form and free of lookup tables. [06 P3](06-proposals.md#p3--eon-diffuse-for-rough-surfaces)
proposes porting it to the engine's GLSL.

### GGX

- Heitz 2017 visible-normal (VNDF) sampling.
- Anisotropic alpha.
- Height-correlated Smith visibility.
- Cycles/Iray-style shading-normal fixes (`nodes/ggx.wgsl.js`,
  `nodes/material.wgsl.js:26-129`).

### Turquin multi-scatter compensation

A 32×32×31 `rgba16float` LUT baked by a compute kernel at init
(`TurquinTexture.js`). It is applied to clearcoat, glass and specular. The
"Fix mobile support" commit (`0a3ab53`) moved it from `r32float` to
`rgba16float`, described as "the one float format that is both storable and
filterable everywhere".

### Also present

- Charlie sheen (no sampling lobe).
- Belcour–Barla iridescence.
- Hero-wavelength dispersion.
- Cycles-style direct/indirect contribution clamps (`clampDirect`,
  `clampIndirect`).

### What the material packer expects

The packer reads Standard/Physical fields directly: `m.color.r` (`:639`),
roughness defaulting to 0 (`:647`). A `ShaderMaterial` would throw, and a
toon material would render as glossy plastic. Proxies are mandatory.

## 5. Random numbers

The sampler contract is `rngInit(pixel, pathIndex, bounce)` and
`rand1..4(effect)`, with Sobol as the fallback (`nodes/random.wgsl.js`).

| Generator | Method | Source |
| --- | --- | --- |
| PCG | `pcg4d` hash. The `effect` argument is ignored. | `rand/pcg.wgsl.js` |
| Sobol | 4D direction tables, 65,536 points, **Burley 2020 hash-based Owen scrambling** with a Laine–Karras nested uniform shuffle of the index | `rand/sobol.wgsl.js` |
| Blue dither (**default**, `WebGPUPathTracer.js:572`) | Sobol with pixel = 0, Cranley–Patterson-shifted by one value from a 64² blue-noise texture | `rand/bluedither.wgsl.js` |

The blue-dither comment mentions a golden-ratio rotation per dimension, but
the code adds the same `.r` value to all dimensions.

*Interpretation.* The wavefront backend re-initialises the RNG per kernel
with the same key, and PCG ignores the effect index. With PCG, the NEE light
choice therefore equals the camera jitter's first draw. This does not affect
the default blue-dither mode.

## 6. Lights and environment

- **Light types.** Rect/circle area lights, spot lights (disc and IES
  profile), point lights and directional lights, packed by the shared
  `LightsInfoUniformStruct` into a storage buffer. IES profiles go into a
  half-float atlas (`LightsInfoNode.js`).
- **NEE.** One light or the environment is chosen uniformly per bounce
  (`LogicKernel.js:190-223`).
- **Area lights.**
  - A uniform point on the shape is sampled, with pdf `d²/(A·cosθ)`,
    one-sided.
  - They are MIS-weighted together with the environment.
  - Forward hits test **every** area light on every segment.
- **Point and directional lights** are delta lights.
- **Emissive meshes** are found only by BSDF sampling.
- **Environment.** Marginal/conditional CDF importance sampling with
  rotation and intensity (`EquirectHdrInfoNode.js`). It is skipped entirely at
  intensity 0 (`952c99e`). A separate blurred background is available
  (`EquirectBackgroundInfo.js`).

## 7. Performance, memory and real-time viability

Documented or visible costs:

- Every camera move resets accumulation and shows the low-res preview.
- Each call advances paths by one segment, so one full sample at 1 spp needs
  about "average path length" calls.
- The slot pool (about 599k) is smaller than a 1080p frame.
- A full-resolution output copy runs every iteration, working around missing
  `rgba32float` read_write support (TODO at `WaveFrontPathTracer.js:436-441`).
- Sample-count readback runs every frame while fading.
- `setScene` is synchronous, and any texture-set change repacks the whole
  atlas.

*Interpretation.* Real-time low-spp path tracing for the game is **not
viable on this code**, even on high-end GPUs. It would need:

- a per-frame dispatch model;
- motion vectors;
- a temporal denoiser (SVGF/ReBLUR class, not a single-frame UNet);
- light importance sampling (ReSTIR class) for the 100+ fixtures.

A photoreal image would also fight the game's look profiles. That is a
research program, not an integration.

## 8. Denoising: `OIDNDenoiser`

**Library.** It wraps **oidn-web**, which is injected by the app so the
package stays optional. The UNet weights are loaded onto three's own
`GPUDevice` (`denoise/OIDNDenoiser.js:7-21, 329-357`).

**Inputs.**

- **Colour:** the tracer's linear HDR `rgba32float` output.
- **Albedo and normal AOVs:** *rasterised* by `WebGPURenderer` with an MRT
  and 4× MSAA, not path traced (`:281-326`).

**Execution.**

- `unet.tileExecute` runs progressively over several frames.
- It fires only once `maxSamples > 0` and the least-sampled pixel has
  reached that count, never in low-res mode (`WebGPUPathTracer.js:1054-1095`).
- Any reset aborts it.
- A colour-only model is available (`useAuxiliaryBuffers: false`).

**Weights.** The example ships `rt_hdr_alb_nrm.tza` and `rt_hdr.tza`, about
**1.8 MB each**.

**Cost** (from oidn-web 0.4.0's own benchmark, external data): one 512² tile
takes about 30–38 ms on an Apple GPU. *Interpretation:* about 250–300 ms of
GPU time for 1080p, spread over frames.

> **Yellow Rooms note.** OIDN is a **bake/stills** tool: it cleans a 64–256
> spp reference or photo-mode still in well under a second. Its public
> `denoise(color, albedo, normal)` accepts arbitrary textures on a WebGPU
> device, so a lightmap or probe bake could use it with its own AOVs. A
> WebGL2 game cannot call this class, but it could call oidn-web through a
> CPU round-trip. Not for per-frame use.

## 9. Upscaling: `FSRUpscaler`

- **What it wraps.** An injected `Upscaler` from `@pmndrs/upscaler@0.2.0`,
  always on its **spatial** path: "the temporal paths need motion vectors the
  path tracer does not produce" (`upscale/FSRUpscaler.js:83-91`).
- **The spatial path.** Per that package, it is **FSR1: EASU → RCAS** as raw
  WGSL compute passes. The package notes that "EASU expects perceptual input"
  (*interpretation:* feeding it linear HDR, as the tracer does, can ring on
  highlights).
- **Where it runs.** After the denoiser and before the tone-mapped blit.
- **Known limitation:** "'Upscaling' does not currently work with a
  transparent background" (`README.md:114`).

> **Yellow Rooms note.** The package is WebGPU-only. FSR1 itself is two
> fullscreen passes whose reference is public, so it is directly portable to
> the engine's GLSL. The engine already has the ideal insertion point: after
> the grade, which is already perceptual, and before FXAA or the tape signal.
> See [06 P4](06-proposals.md#p4--fsr1-easu--rcas-upscale-for-renderscale--1).

## 10. Could the WebGPU tracer serve the game?

| Use | Verdict | Why |
| --- | --- | --- |
| (a) Editor / F2 **reference render** of a chunk neighbourhood | **Good fit** once the game or editor can open a WebGPU context beside WebGL | Instancing works, OIDN gives clean stills, about 200 MB of VRAM, synchronous `setScene` |
| (b) **Bake** irradiance probes or lightmaps | Feasible offline or once per room template, not per streamed chunk | Custom `getCameraRayFn` or `ArrayCamera` probes. The texel's own direct light is not NEE-shaded on the camera segment (`LogicKernel.js:156`), which suits a baked-indirect plus real-time-direct split. Streaming and determinism argue against runtime bakes; see [06 P6](06-proposals.md#p6--offline-bakes-ao--irradiance-where-determinism-allows). |
| (c) Real-time low spp + denoise | **No** | See §7 |
| (d) Wavefront queries for AI sight or audio | **No** | At least a frame of async latency. The engine's 2.5D grid ray walk (`LightGrid.raycast`) and CPU grid DDA (`player/collision.js`) are exact for thin-wall topology and synchronous. |
