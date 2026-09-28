# 04 — Yellow Rooms rendering baseline, mapped against the path tracer

Before asking what to take from three-gpu-pathtracer, this chapter records
what the engine already does. It was verified against the sources on
2026-09-28, when `WORLD_GEN_VERSION` was 27 and the renderer was three r185.
Several path-tracing ideas already exist here in a rasterised or 2.5D form.

## 1. Constraints any adoption must respect

| Constraint | Where it is enforced | Consequence for path-tracing tech |
| --- | --- | --- |
| **WebGL2 only**, with a probed mixed-format MRT G-buffer | `render/capabilities.js` (`probeDeferredSupport`) | The WebGPU tracer needs a second context or a migration |
| **No three.js lights, no stock materials in the game path.** Every surface is a G-buffer `ShaderMaterial` | `render/gbufferMaterials.js`, `render/DeferredRenderer.js` | Any tracer input must be a **proxy scene** (the `debug/PbrReference.js` pattern) |
| **Instancing everywhere.** Walls, columns, frames, leaves, props, signs, panels and furniture are `InstancedMesh` batches | `world/mesh.js:119-704` | The WebGL tracer needs instance expansion; the WebGPU tracer does not |
| **Infinite streaming.** 277 resident chunks in the office benchmark, rebuilt as the player moves | `world/ChunkManager.js`, `docs/model-engine-review.md` | Whole-world BVHs are out; only local neighbourhoods are traceable |
| **Determinism.** Same seed gives the same bytes; captures are replayable, pixel-stable up to GPU/driver differences | `world/core/hash.js`, `debug/capture.js`, `docs/worldgen-architecture.md` | Stochastic bakes must be seeded and pinned, or kept out of emitted bytes |
| **Tier-driven cost.** Presets cap work (traces, taps, steps) via uniforms and shader variants | `core/graphics.js`, `render/renderFeatures.js` | New features must slot into tiers and have an identity/off state |
| **Mobile/touch tier and photosensitivity rules** | `core/device.js`, `reduceFlicker` in `docs/lighting-pipeline.md` | Anything flickering or heavy stays opt-in |
| **Look profiles.** Semi-realistic (default), Liminal photo, Camcorder '96, Classic, Neutral | `render/lookProfile.js` | Only the physical looks can be compared to a path-traced reference |

## 2. Frame anatomy, and each pass's counterpart in the tracer

The deferred frame (from `docs/lighting-pipeline.md`), with the concept in
three-gpu-pathtracer that computes the same quantity without approximation:

| Engine pass or system | What it approximates | Path-tracer counterpart (ground truth) |
| --- | --- | --- |
| **G-buffer v2**: albedo+matID, view normal+roughness, metal/AO/gloss, depth | Primary visibility and material | Camera ray + surface record (`get_surface_record_function`) |
| **World-grid light lists**: ≤ `LIST_MAX` ranked fixtures per cell with 6-bit visibility (`world/lightGrid/LightGrid.js` `_buildList`, `_visibility`) | *Which* lights matter at a point, and how visible they are | NEE light selection. The tracer picks uniformly among **all** lights, so the engine's ranked lists are *better* light culling than the tracer has. |
| **Per-pixel `gridTrace`** of the emitter footprint through doors, jambs, columns and slab holes (`shaders/grid.js`) | Soft wall shadows from area fixtures | Area-light NEE shadow rays against the BVH |
| **`LightGrid.segment` / `raycast`**: 2.5D Amanatides–Woo walk over edges, columns and proxy boxes (`LightGrid.js:766-955`) | Exact thin-wall visibility on the CPU | `bvhIntersectFirstHit`. The engine's version is cheaper and exact **for its topology**; the BVH is mesh-exact (GLB detail, enemies). |
| **Furniture box coverage + capsule soft shadows** (`shaders/lighting.js` `capsuleShadow`, `render/shadowMath.js` box form factors) | Occlusion by furniture and enemies | Shadow rays against actual meshes |
| **Flashlight shadow map** (PCF, Vogel, PCSS) | Spot-light visibility | `PhysicalSpotLight` NEE (disc radius gives the physically correct penumbra) |
| **Torch bounce VPL**: one CPU raycast per frame, hit coloured by family albedo, critically damped (`render/torchBounce.js`) | The flashlight's first indirect bounce | Path bounce 1 from the spot light |
| **Cell-graph GI**: direct irradiance per cell face, **3 Jacobi iterations** of mean cell radiosity across open edges, hand-weighted ambient cube (`LightGrid._solveGI`, `:1410-1553`) | Multi-bounce diffuse interreflection | Full multi-bounce path tracing. This is the engine approximation with the most hand-tuned constants. |
| **GTAO + bent normal**, half-res XeGTAO (`shaders/gtao.js`) | Ambient visibility and dominant unoccluded direction | Cosine-ray AO (`AmbientOcclusionMaterial`) and path tracing itself |
| **Contact march + joint-bilateral resolve** (`shaders/contact.js`, `shaders/occResolve.js`) | Small-scale shadowing the analytic systems miss | Shadow rays |
| **Physical BRDF**: GGX, height-correlated Smith, Schlick, Karis sphere/tube normalisation, representative-point rect specular (`shaders/brdf.js`) | Specular from panels | GGX with VNDF sampling + area-light MIS: the same model integrated exactly |
| **Lambert diffuse** | Diffuse | Burley (WebGL) / **EON** (WebGPU) diffuse |
| **Exp² fog + half-res shafts** (`shaders/volumetric.js`) | Participating media | `FogVolumeMaterial` free-flight (WebGL only) |
| **Auto-exposure + grade** (AgX / filmic / neutral / video knee) | Camera and display | Renderer tone mapping. The comparison must happen **before** the grade. |
| **Bloom, outline, motion blur, FXAA, tape signal** | Stylisation and post | None: out of scope for a reference |
| **Dynamic resolution**: `renderScale` × DPR with browser bilinear stretch (`render/DynamicResolution.js`, `core/device.js`) | Fill-rate scaling | `renderScale` + `ClampedInterpolationMaterial`; the WebGPU tracer adds `FSRUpscaler` (FSR1) |

## 3. Existing verification tooling a reference render would plug into

- **`debug/PbrReference.js`.** It mirrors light-room meshes to
  `MeshStandardMaterial` and adds stock `PointLight`s with the same power and
  window, graded by the same output pass. Its own header names the gap: "stock
  point lights have no downward diffuser profile or tube specular, and the
  ambient is a stock HemisphereLight rather than the grid bounce." A
  path-traced mirror would close exactly that gap. The *mesh mirroring* it
  already does is the first half of the tracer's input
  ([07 E3](07-experiments.md#3-e3--path-tracing-real-yellow-rooms-chunks)
  reuses the same mapping).
- **`debug/capture.js` (schema 2).** It records world identity, pose, time,
  look, tiers, lighting schema versions and three revision. A reference render
  keyed by a capture is reproducible by construction.
- **F2 → LIGHT tab.** It has a channel viewer (albedo, normal, depth, AO,
  lit, shadow mask, roughness, metalness, material AO), GPU pass timers
  (`render/PassTimer.js`), and "direct only" / "indirect only" lighting
  diagnostics. The last two are the exact channels a reference comparison
  needs.
- **Editor lighting lab** (`editor/lighting.js`, `editor/simulate.js`). It
  runs lamp-circuit relighting and darkness metrics on editor documents, all
  CPU and deterministic. A Monte Carlo irradiance reference fits this report
  style (`npm run report:*`).
- **Headless probes.** `npm run benchmark:render-scene` and
  `npm run benchmark:light-grid` show the project already accepts Node-side
  measurement scripts with explicit "not a GPU timing" disclaimers.

## 4. Noise and sampling in the engine today

| Pass | Noise source | Filter after it |
| --- | --- | --- |
| GTAO | Jimenez 4×4 slice rotation + step offset (`shaders/gtao.js`) | 5×5 joint bilateral over exactly one 4×4 period (`shaders/occResolve.js`) |
| Contact march | Same 4×4 period (`shaders/contact.js:172`) | Same resolve |
| Volumetric shafts | Same 4×4 period (`shaders/volumetric.js:208`) | Depth-aware blur and upsample |
| Lamp shadow march | IGN (`shaders/shadow.js:89`) | Blurred mask |
| Flashlight PCSS/Vogel rotation | IGN (`shaders/lighting.js:436`) | **None**: visible directly |
| Cel-band dither (Classic look) | IGN (`shaders/lighting.js:584-590`) | **None** |
| Grade posterise / TPDF dither | IGN (`shaders/grade.js:131`) | **None** |
| SSAO kernel (Classic) | Deterministic base-2/3 van der Corput + golden angle | Blur |

There is **no temporal accumulation** anywhere: no TAA, and no reprojection
of AO or shafts. Motion blur is the only reprojection
(`shaders/motionBlur.js`). This is why [07 E2](07-experiments.md#2-e2--blue-noise-versus-the-engines-screen-noise)
matters: blue noise's usual advantage shows up under temporal or unfiltered
use.

## 5. What this means for the rest of the research

1. The engine already has **better-than-the-tracer light culling** (ranked
   per-cell lists) and **exact 2.5D visibility**. Replacing them with BVH ray
   queries would be a regression in cost and determinism. Where the tracer
   helps is in *checking* them.
2. The biggest approximations with **hand-tuned constants** are:
   - the cell-graph GI (3 Jacobi iterations, ambient-cube weights 0.5 / 0.25 /
     0.1 and 0.6 / 0.4);
   - the fixture diffuser profile (`uEmitFloor`, `uEmitPow`);
   - `LAMP_BOUNCE`;
   - `VOL_INTENSITY`;
   - the torch VPL albedos.

   Every one of them can be fitted against a Monte Carlo reference.
3. The engine has **no** photometric beam profile, **no** rough-diffuse model
   beyond Lambert, and **no** in-engine upscaler. The tracer contains a
   directly portable solution for each.
4. Bakes (AO, lightmaps, probes) collide with streaming and determinism.
   They make sense only for **authored or catalogued** content, never per
   streamed chunk at runtime.

[05-feature-fit.md](05-feature-fit.md) scores every feature against these
points.
