# 01 — three-gpu-pathtracer: what it is

Researched on 2026-09-28. The source was the GitHub `main` branch at commit
`8de7270`, where PR #713 ("webgpu-pathtracer") was merged as `897f9dd` that
same day. The npm release examined is `three-gpu-pathtracer@0.0.24`, published
2026-02-21. Line references like `src/core/WebGLPathTracer.js:105` point into
that checkout. `README@0.0.24` means the README shipped in the npm tarball.

> **Update, same day:** npm `0.0.25` (published 2026-09-28 12:24 UTC) ships
> `src/webgpu` and exports `three-gpu-pathtracer/webgpu`. Its peers are three
> `>=0.185.0`, three-mesh-bvh `>=0.9.15` and xatlas-web `^0.1.0`. The
> "Published on npm: No" cell below describes 0.0.24. See
> [09](09-webgpu-integration.md).

## 1. One-paragraph summary

three-gpu-pathtracer is Garrett Johnson's MIT-licensed progressive path tracer
for three.js. It is built on his `three-mesh-bvh` library. It takes an ordinary
three.js scene of `MeshStandardMaterial`/`MeshPhysicalMaterial` meshes, three.js
lights and an environment map. It flattens that scene into one BVH on the GPU
and accumulates physically based, unbiased-ish Monte Carlo samples, one
sample per pixel per call, until the image converges. It is an interactive
**offline/reference renderer** for product viewers, archviz stills, and
material and lighting verification. It is not a per-frame game renderer. Every
camera or scene change restarts accumulation, and a clean frame takes hundreds
to thousands of samples.

## 2. Two implementations, and which one you actually get

| | WebGL backend | WebGPU backend |
| --- | --- | --- |
| Entry point | `import { WebGLPathTracer } from 'three-gpu-pathtracer'` | `import { WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu'` |
| Renderer | `THREE.WebGLRenderer` (WebGL2) | `THREE.WebGPURenderer` + TSL (`three/webgpu`) |
| Technique | One monolithic GLSL fragment shader (`PhysicalPathTracingMaterial`) drawn over tiles | WGSL compute: **wavefront** (default) or **megakernel** |
| Published on npm | **Yes**: 0.0.24 is WebGL-only (`src/webgpu` absent from the tarball) | **No**: `main` only, still versioned 0.0.24, "Unreleased" in the CHANGELOG |
| Status on `main` | **Deprecated**: the constructor warns "This class has been deprecated and will be removed in a future release" (`src/core/WebGLPathTracer.js:105`, `CHANGELOG.md:14-15`) | Primary; the README is now WebGPU-first (`README.md:11`) |
| three.js peer | `>=0.180.0` (0.0.24) | `>=0.185.0` (`package.json` on `main`) |
| three-mesh-bvh peer | `>=0.7.4` (0.0.24) | `>=0.9.15` |
| Fog volumes | Yes (`FogVolumeMaterial`) | Not ported (`volumeKernel = null // later`, `src/webgpu/WaveFrontPathTracer.js:98-99`) |
| Denoiser | `DenoiseMaterial` (colour-only bilateral, "glslSmartDeNoise") | `OIDNDenoiser` (Intel Open Image Denoise UNet via `oidn-web`) |
| Upscaler | none (`renderScale` + clamped bilinear) | `FSRUpscaler` (FSR1 EASU+RCAS via `@pmndrs/upscaler`) |
| Instanced meshes | **Not supported**: "Instanced geometry and interleaved buffers are not supported" (`README@0.0.24:581`) | Supported through a two-level BVH (`PathtracerBVHComputeData`) |

Yellow Rooms targets WebGL2 today (`src/render/capabilities.js`,
`src/render/DeferredRenderer.js`). So the **usable-today** artefact is the
deprecated WebGL tracer from npm 0.0.24. The **strategic** artefact is the
WebGPU tracer, which the game could use only through a second
`WebGPURenderer` (for example in the editor) or after a WebGPU migration.
[07-experiments.md](07-experiments.md) measures both facts.

## 3. Architecture at a glance

### WebGL (npm 0.0.24)

```
WebGLPathTracer                       orchestration: raster fallback, low-res preview, fade-in
 ├─ PathTracingSceneGenerator         scene -> one merged world-space geometry + MeshBVH (SAH, 1 tri/leaf)
 │    └─ StaticGeometryGenerator      per-mesh BakedGeometry + MeshDiff (skinning/morphs on the CPU)
 ├─ PathTracingRenderer (x2)          full-res tiled target + low-res preview; RGBA32F accumulation
 │    └─ PhysicalPathTracingMaterial  ONE fragment shader = the whole path tracer
 │         ├─ three-mesh-bvh GLSL     bvhIntersectFirstHit over 4 data textures
 │         ├─ MaterialsTexture        47 RGBA32F texels per material
 │         ├─ AttributesTextureArray  normal/tangent/uv/color layers
 │         ├─ RenderTarget2DArray     every map resized into a 1024^2 RGBA8 array layer
 │         ├─ LightsInfoUniformStruct 6 texels per light (+ IES array)
 │         └─ Equirect CDF tables     inverted-CDF importance sampling of the environment
 └─ ClampedInterpolationMaterial      tone-map per texel, THEN bilinear upscale to canvas
```

### WebGPU (`main`)

```
WebGPUPathTracer                      same UX layer: fade, low-res, maxSamples, denoise, upscale
 ├─ PathtracerBVHComputeData          per-geometry MeshBVH (CPU, SAH) + top-level BVH (three-mesh-bvh/webgpu)
 ├─ AtlasTexture                      skyline-packed RGBA8 atlas pages (<= 4096^2)
 ├─ WaveFrontPathTracer (default)     persistent path slots, append queues, indirect dispatch:
 │    Logic -> Material -> QueueLengthToDispatch -> TraceRay -> TraceShadowRay
 ├─ MegaKernelPathTracer              one thread = one full path, tiled by frameBudget
 ├─ GltfCompliantMaterial             EON diffuse + GGX (VNDF) + sheen + clearcoat + transmission + Turquin LUT
 ├─ OIDNDenoiser                      oidn-web UNet on the shared GPUDevice (raster albedo/normal AOVs)
 └─ FSRUpscaler                       @pmndrs/upscaler, spatial FSR1 path only
```

[02-webgl-backend.md](02-webgl-backend.md) and
[03-webgpu-backend.md](03-webgpu-backend.md) cover each box in detail.

## 4. Feature inventory

Supported in the shared feature set, unless a backend is named:

- **Materials:** `MeshStandardMaterial` and `MeshPhysicalMaterial` only.
  Covered properties are base colour/map, vertex colours,
  metalness/roughness (+maps, glTF ORM channels), emissive (+map, intensity),
  tangent-space normal maps, transmission, IOR, thin-wall and Beer–Lambert
  attenuation, clearcoat (+normal map), sheen (Charlie), iridescence (thin
  film), specular colour/intensity, opacity/alphaMap/alphaTest, side, per-map
  UV transforms, and a `matte` holdout flag. WebGPU adds EON diffuse roughness,
  anisotropy, dispersion and Turquin multi-scatter compensation.
- **Not read:** `aoMap`, `lightMap`, `bumpMap`, `displacementMap`, custom
  `ShaderMaterial`s. The WebGL backend also skips anisotropy and dispersion.
- **Lights:** `RectAreaLight` (rect, or circular through `ShapedAreaLight`),
  `SpotLight`/`PhysicalSpotLight` (disc radius + IES profile), `PointLight`,
  `DirectionalLight`, equirect HDR environments (importance sampled), and a
  separate background with rotation/blur. Hemisphere and ambient lights are
  ignored.
- **Cameras:** perspective, `PhysicalCamera` (thin-lens DoF, bokeh blades,
  anamorphic), `EquirectCamera` (360° panoramas). WebGPU also supports
  `ArrayCamera`, and any object exposing `getCameraRayFn()` can define custom
  ray generation.
- **Sampling:** next-event estimation with the power-heuristic MIS for area
  lights and the environment, Russian roulette, and a "filter glossy"
  regularisation. Sequences are stratified/Sobol/PCG with blue-noise
  Cranley–Patterson rotation.
- **Volumes (WebGL):** homogeneous, isotropic fog inside closed meshes
  (`FogVolumeMaterial`).
- **Utilities:** `BlueNoiseGenerator` (Ulichney void-and-cluster), ray-traced
  `AmbientOcclusionMaterial`, `BlurredEnvMapGenerator`,
  `CubeToEquirectGenerator`, procedural/gradient equirect textures,
  `PrecisionDetector`/`CompatibilityDetector`, and a (broken) xatlas
  `UVUnwrapper`.

## 5. Verbatim gotchas

From `README@0.0.24:575-582` (WebGL):

> - The project requires use of WebGL2.
> - All textures must use the same wrap and interpolation flags.
> - SpotLights, DirectionalLights, and PointLights are only supported with MIS.
> - Only MeshStandardMaterial and MeshPhysicalMaterial are supported.
> - Instanced geometry and interleaved buffers are not supported.
> - Emissive materials are supported but do not take advantage of MIS.

From `README.md:108-114` (`main`, WebGPU):

> - The project requires WebGPU.
> - SpotLights, DirectionalLights, and PointLights are only supported with MIS.
> - Only MeshStandardMaterial and MeshPhysicalMaterial are supported.
> - Emissive materials are supported but do not take advantage of MIS.
> - "Upscaling" does not currently work with a transparent background.

Neither README says in so many words that the library is "not for games".
That conclusion comes from the code: one tile per call, accumulation reset on
every change, whole-scene re-flattening, and monolithic recompiles. See
[02 §2](02-webgl-backend.md#2-progressive-accumulation) and
[03 §7](03-webgpu-backend.md#7-performance-memory-and-real-time-viability).

## 6. Licence and provenance

- `LICENSE`: "MIT License, Copyright (c) 2021 Garrett Johnson". This is
  compatible with any use in Yellow Rooms.
- `src/materials/fullscreen/DenoiseMaterial.js:50-62` embeds BrutPitt's
  glslSmartDeNoise under BSD-2-Clause. Keep that header if the file is ever
  vendored.
- `three-mesh-bvh` (same author) is also MIT.

## 7. Why it matters to this project, in one table

| Yellow Rooms already has… | …and the path tracer offers |
| --- | --- |
| A GGX + Lambert physical look with Filament/glTF conventions (`shaders/brdf.js`) | The same material model integrated **without approximation**: a ground truth |
| A stock-three A/B reference (`debug/PbrReference.js`) that compares BRDFs but not transport | A transport reference: multi-bounce GI, area-light soft shadows, occlusion |
| Hand-tuned cell-graph GI (3 Jacobi iterations, fixed ambient-cube weights, `LightGrid._solveGI`) | Monte Carlo irradiance to **fit and regression-test** those weights |
| An analytic flashlight cone (`smoothstep(cosOuter, cosInner)`, `shaders/lighting.js:894`) | IES/photometric beam profiles (`PhysicalSpotLight.iesMap`) |
| Lambert diffuse on rough carpet, concrete and ceiling tile | EON energy-preserving Oren–Nayar, portable to GLSL |
| IGN and 4×4 interleaved noise in every stochastic pass | Void-and-cluster blue noise (measured in [07](07-experiments.md)) |
| A browser bilinear stretch when `renderScale < 1` | FSR1 (EASU + RCAS) and a "tone-map before upsample" filter |
| Deterministic capture/replay (`debug/capture.js`) | A way to render the *same* capture as a converged reference still |

[05-feature-fit.md](05-feature-fit.md) evaluates each row, and
[06-proposals.md](06-proposals.md) turns the useful ones into designs.
