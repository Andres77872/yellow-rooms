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
  listeners, UI nodes, pointer captures, and audio sources. All persistent
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

# Engine architecture and runtime review — 2026-09-22

A follow-up pass over the engine core, render pipeline, streaming layer,
player/AI, audio and UI. World generation stays at version 24; generated
topology, collision footprints and seeds are unchanged.

## Architecture

- **Survival rules are a pure module.** Sanity drain/recovery, flashlight stare
  exposure, proximity slow-down and the screen grade targets moved from
  `Engine` into `src/core/survival.js`, with unit tests. `Engine` decides when
  they run and where the results go.
- **One presentation reset.** Every level entry and quit-to-title goes through
  `Engine._resetPresentation()` (flashlight cone off, grade from the reset
  `GameState`) and `Engine._refreshLamps()` (lamp set for the current
  viewpoint). Before, four hand-written resets had drifted apart.
- **Sight and walkability are separate line tests.** `hasLineOfSight` (sight
  opacity: windows and rails are transparent, low furniture doesn't occlude)
  and `hasWalkableLine` / `hasWalkableCorridor` (collision walls plus the same
  cell rule A* uses) share one grid DDA in `player/collision.js`.
  `cellBlocked` now lives there too, so the walk test and A* can't diverge.
- **Smaller shared pieces:** `src/core/input.js` (the focused-form-control
  guard for global hotkeys), `Settings.setMany` (a preset is saved with one
  write), a single enemy list on `Engine`, and lamp colour/wrap uniforms shared
  between passes. Ranges stay per pass on purpose.
- **Build:** migrated to `build.rolldownOptions` and split Three.js into its
  own vendor chunk, so it stays cached across app deploys. The large-chunk
  warning now flags only app-code growth.

## Fixes

- **AI:** Enemies no longer beeline into rails, observation windows or furniture
  they can see across; they route around instead.
  - A failed path search waits for the repath throttle instead of running every
    frame.
  - The Pursuer's stall detector requests one fresh route instead of one per
    frame.
  - A despawning Stalker forgets its previous pursuit episode.
  - The Stalker's catch distance is measured after it moves.
- **Rendering:**
  - Each lamp's flicker now uses its own floor. Every lamp above or below floor
    0 used to flicker as if it were on floor 0.
  - Restoring a lost GL context re-clears the identity targets of skipped
    passes. On low presets the scene used to stay near-black.
  - The first frame after a level advance renders from the spawn with lamps
    gathered.
  - Shadow-mask weights include each lamp's tint luminance.
- **Streaming and memory:**
  - A furniture model swap is disposed on unload. Previously its instance
    buffers leaked.
  - The GLB furniture upgrade re-meshes nearest chunks first within the
    per-frame build budget, instead of all residents in one callback.
  - The minimap's explored-chunk store keeps full chunk data only near the
    player and regenerates far chunks on demand.
- **Audio:**
  - The AudioContext resumes on every resume, retry and restart gesture, which
    fixes silence after an iOS interruption.
  - While the context is suspended, new one-shots are skipped and heartbeats
    count against the voice budget.
  - A volume change during the start fade-in is no longer lost.
  - The title screen after quitting is silent.
- **UI and input:**
  - The title backdrop after quitting no longer keeps the low-sanity grade or
    shows frozen enemies.
  - NOISE=OFF now applies outside gameplay too.
  - The settings panel re-syncs after the boot preset expansion.
  - Tab-hide and window blur pause the game on desktop too.
  - Holding F, M or backtick no longer auto-repeats, and those keys are ignored
    while a text field has focus.
  - Clicking a menu button no longer requests pointer lock twice.
  - The render-scale slider applies when released instead of reallocating all
    targets on every drag step.
  - Head-bob and transition fades no longer depend on the frame rate.
- **Debug tools:**
  - Closing F2 or leaving the light room re-gathers the world's lamps.
  - The light room restores the intensity and range it overrode.
  - LightTool resets colours to the active family's palette instead of Office.

Verification: **919 tests passed across 80 suites**, and lint, the production
build and the five-family world audit passed. A browser session on the dev
server checked title, run start, level advance, quit-to-title and the F2 light
room: 17 programs linked with no GL errors and no console errors.

# Audio, lighting and art-direction pass — 2026-09-22

Goals: quieter, less noisy SFX and a richer ambience; less over-bright
lighting; a semi-realistic anime look; polished Blender models. World
generation stays at version 24.

## Audio (`src/audio/AudioBus.js`)

- **Noise colour.** Every noise layer and one-shot now uses seamless pink
  noise (−3 dB/oct) instead of white. The flashlight tick is the only white
  transient left. Noise loops crossfade their seam: the old correlated brown
  bed clicked once per 3 s loop.
- **Fluorescent hum.** Sine mains harmonics, a lowpassed triangle "ballast"
  edge and a faint pink fizz replace the full-band 120 Hz sawtooth and the
  Q6 white fizz. Hum scales per family (tungsten hotel lamps hum less).
  Flicker sags dip to 40% instead of 16%.
- **Ambience.** A stereo room tone (two decorrelated pink loops of different
  lengths) feeds per-family bands: HVAC rumble, a breathing air band, tower
  and lattice wind, sewer water. A quiet three-voice pad sits under it: open
  fifths for the office, hotel and tower, a close cluster for the sewer, a
  tritone for the lattice. It thins as tension rises. Families crossfade over
  1.2 s.
- **Reverb.** The impulse response has a 12 ms pre-delay, sparse early
  reflections and a tail whose lowpass closes over time (per-family `damp`).
  The old flat white tail was pure hiss.
- **Master.** A −6 dB shelf above 6.5 kHz. The limiter moved to −2 dB / 20:1.
  A DynamicsCompressorNode applies automatic makeup gain, so the old −6 dB
  threshold raised every quiet layer by ~3 dB. The calm sub drone dropped
  from 0.12 to 0.015 of full scale; it now swells only with tension. The
  voice budget went from 24 to 20.
- **Footsteps.** Band-limited pink recipes per surface, alternating a hair
  left and right, with a random buffer offset so steps never repeat a grain.

Offline A/B render of both buses (OfflineAudioContext, 48 kHz, A-weighted RMS
after 2 s, master volume 0.9):

| Scenario | Before dBA | After dBA | Peak before | Peak after |
| --- | ---: | ---: | ---: | ---: |
| Office ambience under a lamp | −37.4 | −44.1 | −9.0 dBFS | −17.6 dBFS |
| Carpet footsteps (solo) | −55.0 | −58.8 | −29.5 | −29.5 |
| Tile footsteps (solo) | −55.1 | −60.0 | −25.3 | −31.3 |
| Full tension + heartbeat | −28.4 | −35.3 | +2.7 (limiting) | −3.3 |
| Death stinger (caught) | −37.9 | −43.7 | −8.1 | −9.1 |

The sub band (<100 Hz) of the calm ambience fell from −19.7 to −31.5 dBFS.
Hiss, measured as energy above 4 kHz through a 4th-order high-pass, fell
from −66.5 to −77.7 dB, both calm and at full tension. Stingers now stand
~10 dB clear of the bed instead of ~1 dB.

## Lighting and look

See [Lighting & Rendering Pipeline — Art direction](lighting-pipeline.md#art-direction-semi-realistic-anime)
for the full account and measurements. In brief:
- **Lighting model:** a painted ramp, a terminator band, a gloss highlight
  carried in the normal alpha, and a one-bounce fill.
- **Brightness:** lower lamp and volumetric intensity, per-family exposure,
  and an ACES-fit filmic grade with split toning.
- **Post:** two-scale bloom, colour-traced soft outlines, darker ink
  entities, and softer carpet wear.

On the office spawn view, mean frame luminance fell from 0.71 to 0.54 and
clipped pixels from 30.8% to 1.9%.

## Models

All 26 GLBs and both `.blend` sources were rebuilt. See
[Furniture pipeline](furniture-pipeline.md) and
[Enemy pipeline](enemy-pipeline.md) for details.
- **Painted vertex shading.** A new shared module,
  `scripts/blender/yr_shading.py`, bakes a gentle COLOR_0 multiplier. It
  combines a floor gradient, cavity and contact darkening
  (0.74–1.0, the floor counted at half weight because SSAO already grounds
  objects), a warm catch-light on convex top edges and a cool shadow tint.
  COLOR_0 is repacked as normalized `UNSIGNED_BYTE` VEC4 (4 bytes/vertex).
  The runtime bake multiplies it with the part colour.
- **Furniture:**
  - soft seat and back cushions on the sofa and armchair;
  - a draped blanket and pillows on the bed;
  - a contoured office chair with armrests;
  - arching snake-plant blades;
  - a bookshelf with books of varied heights, leaning and stacked;
  - seams, handles and raised panels on doors and appliances;
  - continuous porcelain shapes for the toilet, tub and sink.
- **Enemies:**
  - the Stalker is a hunched figure in a tailored suit, with an over-long
    neck and knee-length fingers;
  - the Pursuer's round blob became a gaunt spider-limbed crawler with a
    spine ridge, bone spurs and a gaping toothed jaw;
  - the Husk has a bowed void-faced hood, rib ridges and bony joints.

| | Triangles before → after | GLB bytes before → after |
| --- | ---: | ---: |
| Furniture (23) | 17,416 → 18,598 | 503,288 → 621,548 |
| Stalker | 1,584 → 2,708 | 48,644 → 62,464 |
| Pursuer | 2,916 → 2,847 | 80,372 → 75,836 |
| Husk | 1,486 → 2,569 | 49,252 → 60,104 |

All models stay inside the existing budgets (furniture < 650,000 bytes and
< 20,000 triangles; each enemy ≤ 3,000 triangles and < 90,000 bytes).
