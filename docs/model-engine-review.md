# Model and engine review — 2026-09-04

The review covered all 23 furniture assets and three enemy assets, their Blender
sources and fallback geometry, the deferred pipeline, asset loading, streaming,
input, audio, and engine lifecycle. World generation remains version 24; emitted
topology and collision footprints retain their existing contracts.

## Models

All 26 GLBs and both editable Blender scenes were rebuilt. Small hardware no
longer receives expensive multi-segment bevels or unnecessary UV seams. Visible
silhouettes retain curved surfaces and smooth bevel shading.

- Furniture: real recessed sink/toilet/tub interiors, correctly tapered plant
  pots and oriented leaves, exposed drawer fronts, connected furniture supports,
  and separated faces on cabinet tops, bookcases and whiteboards to remove
  coplanar flicker. Basin and whiteboard fixes also cover the procedural fallback.
- Enemies: connected shoulders/elbows, tapered body forms, distinct hands,
  a connected Pursuer hunch/jaw, and a concave Husk face. Husk turning follows
  the shortest arc smoothly at different frame rates. Model upgrades position
  the feet immediately, even while the simulation is frozen.
- Runtime bake: strips unused UVs and packs linear colors into normalized
  16-bit channels, preserving dark enemy tints. Authored vertex colors, mirrored
  transforms and mixed indexed/non-indexed primitives are handled correctly.
- Loading: deduplicates concurrent requests, bounds furniture loading to four
  workers, releases discarded source resources, and rejects late results after
  disposal. Missing assets retain per-kind fallback geometry.

## Engine and rendering

- The G-buffer is cleared once; opaque fullscreen passes overwrite their targets
  without redundant automatic clears. Pass exceptions restore clear state,
  scene background and GPU timing query state.
- Shader teardown releases all 13 post-process materials. Texture caches are
  scoped to each renderer and retained until its final material owner leaves.
- Instanced normals use inverse-transpose rotation/scale. Collapsed viewport
  sizes remain valid 1×1 targets. The vignette uses a defined ascending
  `smoothstep` ramp for consistency across GPU drivers.
- Engine disposal now releases resident chunk buffers, input and window
  listeners, UI nodes, pointer captures, and audio sources. All 11 persistent
  audio sources stop without closing Three's shared AudioContext.
- Graphics settings apply once at initialization instead of eight times. Normal
  resident chunks skip unnecessary structure-ownership validation during unload
  checks; the regression fixture drops those validations from 243 to zero.
- Void death ends remaining physics/AI work immediately. Returning to the title
  screen from upstairs resets visibility and lighting. Pointer-lock fallback
  errors reach the recovery UI.

## Measurements

Baseline is the repository HEAD before this review. Model bytes are the complete
uncompressed GLB files; runtime bytes include geometry attributes and indices.

| Measurement | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Furniture GLB bytes (23 models) | 2,220,492 | 503,288 | 77.3% |
| Enemy GLB bytes (3 models) | 297,064 | 178,268 | 40.0% |
| Furniture runtime geometry bytes | 2,837,124 | 504,516 | 82.2% |
| Office scene potential triangles | 5,255,336 | 2,752,696 | 47.6% |

The scene comparison uses `family=office`, seed `render-benchmark`, profile
`high`, and the GLB model path. Both versions retain 277 resident chunks,
2,581 effective mesh batches and 90,734 effective instances. Counts apply the
existing ancestor/detail visibility gates, before camera-frustum or occlusion
culling. They are **not GPU timings or FPS measurements**. CPU wall-clock
results varied with concurrent tests and asset builds; no CPU speedup is claimed.

## Reproduce and inspect

```sh
npm test
npm run lint
npm run build
npm run audit:world -- --family all
npm run benchmark:render-scene -- --family office --profile high --models glb
npm run dev
```

Open `/scripts/model-gallery.html` on the local dev server to inspect every
model or choose a close-up, with studio lighting and the actual deferred game
pipeline. It is excluded from the production build. The Blender builders also
produce contact sheets at `/tmp/yr_furniture_preview.png` and
`/tmp/yr_enemies_preview.png`.

Final verification: **889 tests passed across 77 suites**; lint, production
build and whitespace checks passed. Verification includes asset footprint/height/topology budgets, downward ray
checks for recessed basins, async loader disposal races, entity grounding and
turning, audio/input teardown, render-state restoration, and world-family
determinism. The complete five-family audit passes. Browser checks covered the
26-model gallery in both lighting modes and hotel game startup with no captured
shader errors or runtime warnings. The production build retains its existing
large shared Three.js chunk warning.
