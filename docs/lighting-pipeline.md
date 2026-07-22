# Lighting & Rendering Pipeline

Verified on 2026-07-21 against the current renderer, shaders, graphics settings,
debug tools, and light-field implementation.

The game renders through a custom deferred toon pipeline (`src/render/DeferredRenderer.js`).
There are **no real three.js lights**: lamps are shaded from a uniform field, the
flashlight is an analytic cone, and every effect is a fullscreen pass over a
G-buffer. Per-pass GLSL lives in `src/render/shaders/`; the renderer module owns
render targets, uniforms and per-frame orchestration only.

## Frame anatomy

```
G-buffer (albedo+matID, viewNormal, depth)
  ├─ SSAO          half-res hemisphere kernel + bilateral blur      [tier: off/low/high/ultra]
  ├─ Shadow mask   half-res screen-space march to N nearest lamps   [tier: off/low/high/ultra]
  │                + bilateral blur (contribution-weighted, exact)
  ├─ Lighting      hemispheric ambient + ≤72 cel-banded lamps
  │                + flashlight cone + rim + analytic exp² fog
  ├─ Volumetrics   half-res in-scatter raymarch (lamps + flashlight) [tier: off/low/high/ultra]
  ├─ Bloom         selective by matID (emissive only), separable blur [toggle]
  ├─ Composite     lit + shafts·intensity + bloom·intensity
  ├─ Outline       depth/normal Sobel ink, fog-faded                 [toggle]
  ├─ Grade         tone map → tint → posterize → vignette/grain → sRGB
  └─ FXAA          final LDR pass to screen                          [toggle]
```

Debug channel viewer (`shaders/debugView.js`, F2 → LIGHT tab): modes 1–10 blit
albedo / matID / normal / depth / AO / lit / vol / bloom / composite / **shadow
mask** straight to screen.

## The lamp field

`LightField` (12 Hz refresh) collects the nearest lit lamps from
`ChunkManager.collectLampsNear` (floor-filtered, stair-spill aware), sorts by
true 3D distance to the eye, and uploads up to `LIGHT_MAX` (72) world positions.
Per fixture, `uLampChar` packs an rgb colour-temperature tint plus a flicker
weight in `.a` (`lampCharacter.js` — per-tube breathing, rare bad strobing tubes,
room-role tints).

Per frame, `DeferredRenderer._updateFrame`:

1. inverts the projection once (every pass copies it),
2. transforms lamp positions to view space on the CPU (shaders skip a mat4 mul
   per lamp per pixel),
3. **folds the query-edge set fade into `uLampChar.w`** (`raw flicker ×
   1-smoothstep(QUERY_R-FADE_BAND, QUERY_R, cameraDist)`). The fade only depends
   on the lamp's camera distance, so computing it per-lamp-per-frame on the CPU
   replaces the old per-pixel computation in the lighting shader — and the
   shadow + volumetric passes now see exactly the same faded weight, so a lamp
   leaving the candidate set fades its pool, its shadow and its shaft together.

Raw flicker lives in `lamps.lampFlickerRaw` (written by `LightField`, or by the
debug `LightRoom`); `.w` is always recombined from it, which keeps the fold
idempotent while the sim is frozen.

## Runtime graphics quality (`core/graphics.js`)

Shaders compile **once** against compile-time ceilings
(`AO_SAMPLES_MAX`/`SHADOW_STEPS_MAX`/`SHADOW_LAMPS_MAX`/`VOL_STEPS_MAX`/`VOL_LIGHTS_MAX`
in `world/constants.js`); the live tier drives `uniform int` trip counts that
break out early — the same pattern as the `uLampCount` loop. Switching quality
is therefore instant: no shader rebuild, no pipeline reconstruction.

- **Presets** `low / medium / high / ultra` pin the advanced keys
  (`renderScale`, `aoQuality`, `shadowQuality`, `volQuality`, `bloom`, `fxaa`).
  Editing any advanced control flips the stored preset to `custom`.
- **`high` is defined from the legacy constants**, so the default desktop
  experience is unchanged (locked by `core/__tests__/graphics.test.js`).
  Touch defaults to `medium`, which matches the old mobile device tier.
- **Render scale** (0.5–1.0) multiplies the DPR-clamped pixel ratio; every RT
  resizes through the existing `setSize` path.
- A disabled pass is skipped and its output cleared to its identity value
  (white for AO/shadow masks, black for shafts/bloom) every frame, so
  downstream shaders never special-case it. With FXAA off, grade renders
  straight to screen.
- The AO kernel radii use a radical-inverse (van der Corput) sequence so any
  prefix of the max-size kernel is stratified — the low tier reads 8 of 24
  samples and still covers the hemisphere.

`Settings` coerces every graphics key on load and set (enum whitelists, numeric
clamps), so a hostile/stale localStorage blob can never push an out-of-range
loop count at a shader.

## Debug tooling (F2 → LIGHT tab)

- **Channel strip** now includes the blurred lamp **shadow mask** (mode 10).
- **pipeline section**: live `active lamps N / 72` readout, the current
  shadow/volumetric budgets, per-pass isolation toggles (ssao / shadow /
  volumetric / bloom / fxaa — ephemeral; any settings change re-stamps them),
  and **GPU pass timings** via `EXT_disjoint_timer_query_webgl2`
  (`render/PassTimer.js`, EMA per pass, "n/a" where the extension is missing).
  Timing switches off automatically when the panel closes.
- **light room**: isolated scene + orbit camera with a controllable lamp grid
  writing straight into the deferred uniforms.

## Cheap-depth reconstruction

`viewZAt()` in `shaders/common.js` exploits the symmetric-perspective inverse
structure (`viewZ = -1 / (ndcZ·ip[2][3] + ip[3][3])`) — two MADs and a divide
instead of a full mat4 unproject. The bilateral blurs tap it 25× per pixel and
the shadow/volumetric marches dozens of times, so this is one of the hottest
expressions in the pipeline. `viewPosFromDepth` stays a full unproject where a
position is actually needed.

## Coupled-constant contracts

`FOG_DENSITY / FAR / LOAD_RADIUS / LAMP_QUERY_R / LAMP_FADE_BAND` are one
system: fog must dominate before geometry streams or lamp sets churn
(`world/__tests__/render-coupling.test.js`). The cubic lamp attenuation window
(`lampAtt` in `shaders/common.js`) is mirrored CPU-side by
`ChunkManager.lightAt` for the AI's light sense — change both together.
