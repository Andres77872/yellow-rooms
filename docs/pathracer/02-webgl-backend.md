# 02 — WebGL backend deep dive (`WebGLPathTracer`)

This covers the GLSL implementation. It is the one published on npm as
0.0.24, and it is deprecated on `main` (`src/core/WebGLPathTracer.js:105`). It
matters to Yellow Rooms because it is the only variant that runs on the
game's current `WebGLRenderer`. Each section ends with a **Yellow Rooms note**.
Where this document interprets the code rather than restating it, it says
"interpretation".

## 1. Scene flattening and the BVH

**Mesh collection.** `StaticGeometryGenerator` collects every *visible* mesh
(`traverseVisible`, `src/core/utils/StaticGeometryGenerator.js:16`) and sorts
the meshes by uuid so their order is stable (`:138-144`).

**Per-mesh baking.** Each mesh owns a `BakedGeometry` (`src/core/utils/BakedGeometry.js:39-56`).

- It is re-baked only when `MeshDiff` reports a change. `MeshDiff` checks:
  - `matrixWorld`;
  - geometry uuid plus attribute/index *version numbers*, not contents;
  - a skeleton hash (`bufferToHash` over the bone texture);
  - the primitive count

  (`src/core/utils/MeshDiff.js:4-49, 80-93`).
- Baking runs **on the CPU in JavaScript**. It applies morph targets,
  skinning and world transforms, and flips triangle winding for mirrored
  matrices (`src/core/utils/convertToStaticGeometry.js:223-340`).
- `setCommonAttributes` fills in any missing index, normals, uvs, tangents
  or colours (`src/core/utils/GeometryPreparationUtils.js:65-127`).

**Merging.** The baked meshes are merged into **one** world-space geometry by
a modified `mergeGeometries` that updates changed ranges in place
(`src/core/utils/mergeGeometries.js:99-231`). A per-vertex `materialIndex`
attribute is added: Uint8 when there are 255 or fewer materials, Uint16
otherwise (`GeometryPreparationUtils.js:3-62`).

**Change classes.** The generator reports one of three results
(`StaticGeometryGenerator.js:6-8, 288-290`):

| Result | Trigger | BVH action |
| --- | --- | --- |
| `GEOMETRY_REBUILT` | Mesh count changed or attributes became incompatible | `new MeshBVH(geometry, { strategy: SAH, maxLeafTris: 1, indirect: true })` (`src/core/PathTracingSceneGenerator.js:215-233`) |
| `GEOMETRY_ADJUSTED` | Vertex data changed | `bvh.refit()` (`:235-239`) |
| `NO_CHANGE` | Nothing | Nothing |

**Async builds.** `setBVHWorker(new ParallelMeshBVHWorker())` together with
`setSceneAsync()` moves the SAH build to workers (`WebGLPathTracer.js:161-199`).

**GPU upload.** three-mesh-bvh's `MeshBVHUniformStruct` packs the scene into
four data textures (`three-mesh-bvh/src/webgl/MeshBVHUniformStruct.js`):

- positions;
- indices;
- node bounds (two RGBA32F texels per node);
- node contents.

Every update repacks all four; there is no partial upload.

**GPU traversal.** The shader traverses with `bvhIntersectFirstHit` using a
60-entry stack. The struct is flattened into macro arguments because "on some
mobile GPUS (such as Adreno) numbers are afforded less precision specifically
when in a struct" (`three-mesh-bvh/src/webgl/glsl/bvh_struct_definitions.glsl.js:1-3`).

**Things observed in the code** (not reproduced as bugs here):

- **`InstancedMesh` is not expanded.** It passes `isMesh`, so it is collected
  as a single mesh and its instance matrices are ignored. `README@0.0.24:581`
  says so. The spike in [07 §3](07-experiments.md#3-e3--path-tracing-real-yellow-rooms-chunks)
  had to expand every instance by hand.
- **Morph weights are not diffed.** `morphTargetInfluences` is not part of
  `MeshDiff`, so animating only morph weights does not trigger a re-bake.
- **The any-hit shader is stale.** `src/shader/bvh/ray_any_hit_function.glsl.js`
  is exported but never included, and it no longer matches the three-mesh-bvh
  0.9.15 `intersectsBVHNodeBounds` signature.

> **Yellow Rooms note.** Every world batch in `src/world/mesh.js` is an
> `InstancedMesh`: walls and columns are `wallUnit` boxes, and so are frames,
> leaves, props, signs, lit and dead panels, and furniture. Feeding a chunk to
> this backend therefore needs an instance-expansion step. That step is simple
> (it is part of the spike) but produces many triangles; see
> [07 §3](07-experiments.md#3-e3--path-tracing-real-yellow-rooms-chunks). The
> MeshDiff/BakedGeometry/merge pattern is a good template for any editor tool
> that must keep a world-space static mesh in sync with a scene graph.
> For runtime ray queries, use `three-mesh-bvh` directly rather than this
> package (see [05](05-feature-fit.md)).

## 2. Progressive accumulation

**Rendering loop.**

- `renderSample()` renders **one tile**. With the default `tiles = (3, 3)`
  (`src/core/PathTracingRenderer.js:210`), one sample per pixel takes nine
  calls. The render task is a generator that `yield`s after every tile
  (`:139`).
- There is no "N samples per frame" option. To render more samples, call
  `renderSample()` more often.

**Running mean.** Accumulation is a hardware blend with
`opacity = 1 / (samples + 1)` into an RGBA32F target
(`PathTracingRenderer.js:30-36`). Without `EXT_float_blend`, or with a
transparent background, a manual `BlendMaterial` ping-pong is used instead
(`WebGLPathTracer.js:10-14, 420`).

**Reset.**

- Reset is explicit. `updateCamera`, `updateMaterials`, `updateLights`,
  `updateEnvironment` and `setScene` all zero the accumulation. Nothing is
  detected automatically.
- `setScene` "must be called again when the camera object changes, the
  geometry in the scene changes, or new materials are assigned. While only
  changed data is updated it is still a relatively expensive function"
  (`README@0.0.24:256-258`).

**What the viewer sees before convergence.**

- Until `minSamples` (default 5) have accumulated, and after `renderDelay`
  (default 100 ms), the tracer shows a raster fallback. This is
  `rasterizeSceneCallback`, or a 1 spp low-res trace when `dynamicLowRes` is
  on.
- The traced image then fades in over `fadeDuration` (500 ms)
  (`WebGLPathTracer.js:131-142, 388-489`).

**Upscaling.** `ClampedInterpolationMaterial` upscales `renderScale`-sized
results to the canvas with a manual bilinear filter. It tone-maps each texel
*before* interpolating, "to prevent unexpected high values during texture
stretching" (`src/materials/fullscreen/ClampedInterpolationMaterial.js:61-104`).

**Other knobs.**

| Knob | Effect | Source |
| --- | --- | --- |
| `bounces` | Default 10 | `PhysicalPathTracingMaterial.js:77` |
| `transmissiveBounces` | Default 10; a separate budget for transmissive, alpha and fog-boundary hits | `:78`, `:464`, `:513-519` |
| `filterGlossyFactor` | Biased roughness regularisation that trades caustics for fewer fireflies | `:260-270`, `:488-499` |
| Russian roulette | From bounce 3. Survival probability is the square root of the throughput-luminance ratio, and the boost is clamped to at most 20 (biased) | `:531-552` |
| `stableNoise` | Resets the seed and the stratified shuffles on reset, so restarts are reproducible | `PathTracingRenderer.js:373-379` |
| NaN/Inf guard | Kills the path | `:555-560` |

> **Yellow Rooms note.** Three of these UX ideas transfer directly to an
> editor or F2 "reference" view:
>
> - raster until N samples, then fade in;
> - `renderScale`;
> - `stableNoise`, which matches the engine's determinism culture.
>
> **Tone-map before upsampling** is also worth taking separately.
> `DynamicResolution` lowers the backing resolution, and the browser then
> stretches the *graded* canvas. The grade already tone-maps before the
> stretch, so this is not a bug today. It becomes relevant if an in-engine
> upscale pass is added ([06 P4](06-proposals.md#p4--fsr1-easu--rcas-upscale-for-renderscale--1)).

## 3. Scene data packed into textures

**Materials.** Each material takes 47 RGBA32F texels
(`MATERIAL_PIXELS = 47`, `src/uniforms/MaterialsTexture.js:5`):

- 15 texels of scalar/colour/map-index data;
- 32 texels of UV transforms (16 maps, 2 texels each).

Map references are float layer indices, where −1 means no map. Integer
bit-casting is avoided because "on some devices (Google Pixel 6) the
floatBitsToInt function does not work correctly" (`:144-146`). The texture is
re-uploaded only when a `bufferToHash` of its contents changes (`:436-445`).

**Vertex attributes.** `AttributesTextureArray` stores an RGBA32F
`DataArrayTexture` with layers for normal, tangent, uv and colour. Shaders
fetch it with barycentric interpolation. `uv2` is baked but never uploaded.

**Textures.** Every map is redrawn into one layer of an RGBA8 array texture
of `textureSize` (default 1024²) with linear filtering, repeat wrap and **no
mipmaps** (`src/uniforms/RenderTarget2DArray.js:38-47`). Textures are
de-duplicated by `source.uuid:colorSpace`. The README warns that "All textures
must use the same wrap and interpolation flags."

**Lights.** Each light takes 6 RGBA32F texels. IES profiles live in a
360×180 half-float array. There is **no hard light cap**
(`src/uniforms/LightsInfoUniformStruct.js`).

**Environment.** The equirect map is converted to half float on the CPU, and
luminance-weighted marginal and conditional CDFs are built. Both are then
**inverted into lookup textures**, so the GPU importance-samples the
environment with two linear fetches and no binary search
(`src/uniforms/EquirectHdrInfoUniform.js:181-301`,
`src/shader/sampling/equirect_sampling_functions.glsl.js:49-67`).

> **Yellow Rooms note.** The engine already uses the same "data in float
> textures" style:
>
> - the lamp set is a `LIGHT_MAX × 2` RGBA32F texture (`shaders/lampData.js`);
> - the world grid is six typed-array textures (`world/lightGrid/gridSpec.js`).
>
> Nothing needs to be copied here. What matters is a constraint: procedural
> `CanvasTexture`s (`render/textures.js`) would all be resized into 1024²
> RGBA8 layers, and all must share wrap/filter flags. Both conditions hold for
> the family surface textures.

## 4. Shading model (BSDF)

**Diffuse.** A Burley-style diffuse with retro-reflection, weighted by
`(1 − F)(1 − transmission)(1 − metalness)` (`src/shader/bsdf/bsdf_functions.glsl.js:15-35`).
Sampling is cosine-weighted.

**Specular.**

- GGX with Heitz VNDF sampling and height-correlated Smith G2
  (`src/shader/bsdf/ggx_functions.glsl.js:12-70`).
- F0 is `mix(0.04·specularColor·specularIntensity, baseColor, metalness)`.
- Roughness uses the glTF convention `alpha = roughness²`
  (`get_surface_record_function.glsl.js:298-299`).

**Other lobes.**

- Clearcoat: fixed IOR 1.5, with its own normal and roughness.
- Sheen: Charlie D + G with albedo scaling.
- Iridescence: Belcour–Barla thin film.

**Transmission** is explicitly approximate: "TODO: This is just using a basic
cosine-weighted specular distribution with an incorrect PDF value at the
moment" (`bsdf_functions.glsl.js:136-137`).

**Lobe selection** uses a 4-entry CDF over the diffuse, specular,
transmission and clearcoat weights (`:242-265`, `:359-447`). The returned pdf
is the full mixture pdf.

**Not read:** `aoMap`, `lightMap`, `bumpMap`, `displacementMap`, anisotropy,
dispersion, per-material `envMap`, and all non-Standard/Physical materials.

> **Yellow Rooms note.** The engine's physical look (`SHADING_PBR` in
> `shaders/lighting.js`, helpers in `shaders/brdf.js`) uses GGX,
> height-correlated Smith visibility, Schlick Fresnel, F0 0.04 and
> `alpha = r²`. These are the **same conventions** as the tracer's specular
> lobe, which makes it a meaningful ground truth.
>
> The two diffuse models are **not** identical: the engine uses Lambert and
> the tracer uses Burley with retro-reflection. A calibration therefore
> expects small differences at grazing angles on rough surfaces.
>
> The Classic cel look (`LIT_RAMP`, terminator band, outline) cannot be
> referenced at all. It is a stylisation, not a transport approximation. Only
> the Semi-realistic and Neutral looks should be compared.

## 5. Lights, next-event estimation and MIS

**Light types.**

- `RectAreaLight` (optionally circular through `ShapedAreaLight`).
- `SpotLight` and `PhysicalSpotLight` (`radius` gives a disc source, `iesMap`
  gives a photometric profile).
- `PointLight` and `DirectionalLight`.

(`src/core/utils/sceneUpdateUtils.js:72-92`)

**Area-light visibility.** Area lights are one-sided, and they are **not
visible to camera rays**; "AreaLights no longer render the light surface"
(CHANGELOG 0.0.17).

**Next-event estimation (NEE).**

- Each bounce takes one sample, of either a light or the environment.
- The light is chosen **uniformly at random**:
  `uint l = uint( ruv.x * float( lightCount ) );`
  (`src/shader/sampling/light_sampling_functions.glsl.js:165-167`).
- NEE exists only under `FEATURE_MIS`, so point, spot and directional lights
  need MIS enabled.

**MIS weighting.** Area lights and the environment use the power heuristic
on both the NEE side and the BSDF-hit side. Delta lights get weight 1.

**Emissive meshes** are found only when BSDF sampling happens to hit them:
"Emissive materials are supported but do not take advantage of MIS."

**Per-bounce cost.** Every bounce loops over **all** area lights to test for
BSDF-ray hits (`PhysicalPathTracingMaterial.js:352-374`). The cost is therefore
O(lights) per bounce, and variance grows with light count because selection
is uniform.

**IES profiles.** The shader lookup is 1D: angle from the spot axis only
(`light_sampling_functions.glsl.js:26-33`). This matches three r185's
`IESLoader`, which produces a 180×1 texture.

> **Yellow Rooms note.** This section decides how fixtures map into the
> tracer.
>
> - **Fixture count.** An office floor carries about 0.0081 lit fixtures per
>   unit² (`docs/lighting-pipeline.md`). That is over 100 panels within a
>   3×3-chunk neighbourhood.
> - **Uniform selection is the weak point.** Every bounce spends its single
>   NEE sample on a random panel, most of which are far away or behind walls.
>   The engine's own per-cell ranked light lists (`LightGrid._buildList`,
>   `LIST_MAX` entries) are exactly the light-culling structure the tracer
>   lacks. [06 P1](06-proposals.md#p1--path-traced-reference-mode-f2--editor)
>   recommends tracing only a small neighbourhood.
> - **The diffuser profile.** The engine's fixtures emit with a profile:
>   `mix(uEmitFloor, 1, pow(L.y, uEmitPow))` in `shadeFixture`. A plain
>   `RectAreaLight` is Lambertian. To match, the closest tracer primitive is a
>   **downward `PhysicalSpotLight` with `radius` equal to the panel's
>   equivalent radius and a generated IES profile** that encodes that curve.
>   A rect light remains fine for a quick look.
> - **The flashlight** maps naturally onto `PhysicalSpotLight`, and its
>   `iesMap` idea is proposal
>   [06 P2](06-proposals.md#p2--photometric-flashlight-beam-profile).

## 6. Random numbers and sampling

**Generator choice.** `RANDOM_TYPE` selects the generator: 2 is stratified
(the default), 1 is Sobol, 0 is PCG (`PhysicalPathTracingMaterial.js:53-56, 156-186`).
Each `rand(k)` names an "effect" dimension, so dimensions stay stable across
paths.

**Stratified (the default).**

- `StratifiedSampler` keeps `strata^d` ids for d = 4 and reshuffles them with
  Fisher–Yates once they are exhausted (`src/uniforms/stratified/StratifiedSampler.js`).
- All pixels share the same point per sample. They are decorrelated by a
  **per-pixel blue-noise Cranley–Patterson rotation**
  (`src/shader/rand/stratified.glsl.js:11-48`).

**Sobol.**

- A 256² Sobol table is generated on the GPU and Owen-scrambled following
  Burley 2020 (`src/shader/rand/sobol.glsl.js`, `src/utils/SobolNumberMapGenerator.js`).
- It is disabled by default: "Using the sobol functions seems to break the
  the compiler on MacOS" (`PhysicalPathTracingMaterial.js:175-176`).

**Blue noise.**

- `BlueNoiseGenerator` is Ulichney's **void-and-cluster** algorithm in pure
  JS with no three.js dependency
  (`src/textures/blueNoise/BlueNoiseGenerator.js:20-111`). It uses a toroidal
  Gaussian energy with σ = 1.5.
- Its RNG is `this.random = Math.random` (`:8`) and can be replaced, so a
  seeded generator makes it deterministic. [07 E2](07-experiments.md#2-e2--blue-noise-versus-the-engines-screen-noise)
  confirms this.
- Multi-channel textures are independent 2D sets, not jointly optimised or
  spatio-temporal.

> **Yellow Rooms note.** The engine's stochastic passes use:
>
> - Jimenez's interleaved gradient noise (IGN), in `shaders/common.js:43`;
> - a 4×4 interleaved pattern (GTAO, contact and volumetrics), which
>   `shaders/occResolve.js` integrates exactly over one period.
>
> [07 E2](07-experiments.md#2-e2--blue-noise-versus-the-engines-screen-noise)
> measured that **blue noise does not lower the residual after the engine's
> 5×5 resolve**, even across depth edges. What it removes is the **structured
> spectral peaks** of IGN and the 4×4 pattern. It therefore helps only where
> noise stays visible unfiltered, and in any future temporal accumulation
> ([06 P5](06-proposals.md#p5--blue-noise-where-it-actually-helps)).

## 7. Volumetrics

**Defining a volume.** `FogVolumeMaterial` extends `MeshStandardMaterial`
with `density`. A closed mesh bounds a homogeneous medium
(`src/materials/surface/FogVolumeMaterial.js:9-16`).

**Entering the medium.** At path start, the tracer casts backwards up to 30
times to detect whether the camera is already inside a volume
(`src/shader/bvh/inside_fog_volume_function.glsl.js`). Crossing a boundary
swaps the current medium without consuming a bounce.

**Free-flight sampling.** Distances are sampled as
`t = −ln(u)/density` (`src/shader/bsdf/fog_functions.glsl.js:3-7`, "Ray
Tracing: The Next Week" constant-density media).

**Scattering is isotropic**, with `color` acting as the single-scatter albedo.

- NEE works from inside the medium.
- Shadow rays inside fog are blocked *stochastically*, which gives a binary
  transmittance estimate.
- There is one medium per path, with no heterogeneity and no anisotropic
  phase function.

The README warns that fog "can dramatically impact render time"
(`README@0.0.24:519-520`).

> **Yellow Rooms note.** The engine's fog is analytic exp² fog in the
> lighting pass, plus a half-res ray-marched in-scatter for fixture and torch
> shafts (`shaders/volumetric.js`, `VOL_INTENSITY`). The tracer's fog is a
> **ground truth for the shaft brightness**. That brightness was hand-lowered
> from 0.75 to 0.3 after an HDR probe found the in-scatter "adding +0.3 to
> +0.7 linear across the whole frame" (`docs/lighting-pipeline.md`,
> Brightness). A fog-box reference render of one corridor would replace that
> eyeballing with a number. The fog *code* is not reusable in raster.

## 8. Utilities

| Utility | What it is | Yellow Rooms relevance |
| --- | --- | --- |
| `AmbientOcclusionMaterial` (`src/materials/surface/AmbientOcclusionMaterial.js`) | A raster material that shoots `SAMPLES` (10) cosine rays per fragment against a world BVH and outputs visibility within `radius` | **High as a template.** Change the vertex stage to rasterise in UV space and it becomes an AO/visibility **baker**. A ground truth for GTAO is also possible. |
| `BlueNoiseGenerator` | Void-and-cluster, pure JS, injectable RNG | **Medium.** Offline generation of a pinned dither texture ([06 P5](06-proposals.md#p5--blue-noise-where-it-actually-helps)). |
| `PhysicalCamera` | Thin lens: `bokehSize = focalLength / fStop`, N-blade aperture, anamorphic | Low. A photo-mode flourish at most. |
| `EquirectCamera` | 360° equirect ray generation | Medium for tooling: path-traced HDR probes from inside a room |
| `DenoiseMaterial` | BrutPitt glslSmartDeNoise: a **colour-only** circular Gaussian bilateral filter (`:83-125`) | Low. The engine's depth/normal-guided resolve is already better. |
| `BlurredEnvMapGenerator`, `CubeToEquirectGenerator` | PMREM blur → equirect → **synchronous** readback | Low (the game has no sky or IBL) |
| `ProceduralEquirectTexture`, `GradientEquirectTexture` | CPU-generated equirects | Low |
| `PrecisionDetector` / `CompatibilityDetector` | Render 1×1 probes that measure float mantissa and int widths, both plainly and **inside structs**, in both shader stages | **Low–medium.** A mobile guard next to `render/capabilities.js`. |
| `QuiltPathTracingRenderer` | Looking Glass multi-view | None |
| `UVUnwrapper` | xatlas-web wrapper. **Broken**: undefined `AddMeshStatus`/`mesh`, removed `addAttribute` (`src/utils/UVUnwrapper.js:44-95`) | Do not use. Call xatlas-web directly if lightmap UVs are ever needed. |
| `bufferToHash` | Java-style rolling hash for change detection | Trivial |

## 9. Platform history worth knowing

The CHANGELOG records a long tail of driver problems:

- black renders on M1 Safari (0.0.5);
- a Pixel 6 `floatBitsToInt` bug (0.0.4);
- a Windows compile failure when arrays were passed to functions (0.0.12);
- Sobol disabled after macOS compiler crashes (0.0.17);
- "Rendering not working at all on iOS devices due to lacking support for
  linearly interpolated Float32 textures" (0.0.17), which is why the
  environment tables are half float.

Since 0.0.23 the material "is compiled asynchronously to avoid blocking the
browser", and any define toggle (MIS, DoF, fog, background, camera type) is a
full recompile.

> **Yellow Rooms note.** The engine's own portability rules match these
> scars: `SAMPLER_PRECISION` highp samplers, IGN instead of `fract(sin())`,
> and a single textual call site per occlusion function to limit ANGLE compile
> time. The tracer's shader is far larger than any engine pass. [07 E3](07-experiments.md#3-e3--path-tracing-real-yellow-rooms-chunks)
> measures what that costs. Treat it as **desktop, opt-in, off the critical
> path**, and never part of boot.
