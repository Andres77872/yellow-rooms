import * as THREE from 'three'
import {
  FOV,
  NEAR,
  FAR,
  FOG_COLOR,
  EYE_H,
  CHUNK,
  CELL,
  SPAWN_WORLD,
  STALKER_AMBIENT,
  PANEL_GLOW,
  CAPSULE_MAX,
  CAPSULE_ENEMIES_MAX,
  FLASH_RANGE,
  worldToCell,
} from '../world/constants.js'
import { applyFamilyMaterials, createGBufferMaterials, disposeGBufferMaterials } from '../render/gbufferMaterials.js'
import { createGeometries, disposeGeometries } from '../render/geometries.js'
import {
  createFurnitureModelLibrary,
  disposeFurnitureModels,
  loadFurnitureModels,
} from '../render/furnitureModels.js'
import {
  createEnemyModelLibrary,
  disposeEnemyModels,
  loadEnemyModels,
  upgradeEnemyModels,
} from '../render/enemyModels.js'
import { ChunkManager } from '../world/ChunkManager.js'
import { Controller } from '../player/Controller.js'
import { AudioBus } from '../audio/AudioBus.js'
import { Stalker } from '../entities/Stalker.js'
import { Pursuer } from '../entities/Pursuer.js'
import { Husk } from '../entities/Husk.js'
import { mergeEnemy } from './enemyMerge.js'
import { DeferredRenderer } from '../render/DeferredRenderer.js'
import { DeferredUnsupportedError, probeDeferredSupport } from '../render/capabilities.js'
import { LightField } from '../render/LightField.js'
import { FLICKER_SAFE, flickerProfile, tubeHum } from '../world/lampCharacter.js'
import { TorchBounce } from '../render/torchBounce.js'
import { DynamicResolution, drsCeiling } from '../render/DynamicResolution.js'
import { PLAYER_CAPSULE, capsuleBound, capsuleSet, transformCapsules } from '../render/enemyOccluders.js'
import { GameState, Phase } from './GameState.js'
import { Settings, dynamicResEnabled } from './Settings.js'
import {
  AUTO_FALLBACK_PRESET,
  GRAPHICS_KEYS,
  GRAPHICS_PRESETS,
  concretePreset,
  resolveGraphics,
} from './graphics.js'
import {
  BENCH_MAX_SAMPLE_MS,
  BENCH_VERSION,
  PRESET_COST_WEIGHT,
  choosePreset,
  classifyRenderer,
  defaultPresetForClass,
  guardScore,
  loadGpuProfile,
  readRendererString,
  rendererKeyHash,
  saveGpuProfile,
  summarizeBenchmark,
  toScore,
  viewportMegapixels,
} from '../render/gpuProfile.js'
import {
  IS_TOUCH,
  MAX_DPR,
  computeEffectivePixelRatio,
  enterImmersive,
} from './device.js'
import { DebugOverlay } from './DebugOverlay.js'
import { applyCapture, captureState } from '../debug/capture.js'
import { isEditableFocused } from './input.js'
import { LazyDebugMode } from './LazyDebugMode.js'
import { LazyPathTraceView } from '../render/pathtrace/LazyPathTraceView.js'
import { UI } from '../ui/overlays.js'
import { afterPaint } from '../ui/bootLoader.js'
import { TouchControls } from '../ui/TouchControls.js'
import { Minimap } from '../ui/Minimap.js'
import { ExploredMap } from '../world/ExploredMap.js'
import { hashStr } from '../world/core/hash.js'
import { worldConfigForFamilyOrOffice } from '../world/mapFamily.js'
import { MAP_FAMILY_OFFICE } from '../world/mapTypes.js'
import { createExitPlacement, evaluateExit } from './exitPlacement.js'
import {
  proximitySpeedMul,
  stareLimit,
  survivalGrade,
  updateSanity,
  updateStare,
} from './survival.js'

// Make color management explicit (it defaults to true in three r0.185). With it
// on, `new THREE.Color(hex)` already converts the sRGB hex into the linear
// working space, so the renderer's color helpers must decode exactly ONCE — see
// linVec (DeferredRenderer) / lin (gbufferMaterials) / _setColors (LightTool).
THREE.ColorManagement.enabled = true

const SPAWN = SPAWN_WORLD
// Menus keep their animated world backdrop, but a complete deferred frame is
// wasteful at 60–144 Hz while no gameplay is advancing. RAF itself stays live
// for immediate Start/Resume input; only canvas submissions are capped.
const IDLE_RENDER_INTERVAL_MS = 1000 / 30
// A pause screen stops drawing once this long has passed since it opened,
// or since anything it shows last changed (a setting, a resize, a lighting
// build landing): the world behind the dimmed, blurred card is frozen, and
// only the tube hum and the grain would still move.
const PAUSE_SETTLE_MS = 3000
// A frame-limit deadline counts as reached this early (at most 4 ms, a
// quarter of the interval): rAF callbacks land with jitter, and a render
// that waited for the next callback would lose a whole refresh.
const FRAME_LIMIT_SLACK = 0.25
const FRAME_LIMIT_SLACK_MAX_MS = 4
// The GPU timer reports a frame a few frames after it was submitted: after the
// backing size changes, this many results still belong to the old size.
const BENCH_SKIP_AFTER_RESIZE = 4
// Clean rAF intervals behind one display refresh estimate (see
// _trackDisplayRate), and the run of rendering callbacks after which an idle
// screen skips one due render so a clean interval exists at all.
const DISPLAY_RATE_SAMPLES = 30
const DISPLAY_PROBE_STREAK = 3
// Loading-card subtitles for the UI-driven level entries (_loadRun).
const LOAD_ENTER = 'entering the rooms…'
const LOAD_AGAIN = 'reassembling the rooms…'

export class Engine {
  constructor(app) {
    this._disposed = false
    this._eventBindings = []
    this.settings = new Settings()
    this.state = new GameState()
    this.touch = IS_TOUCH
    this._fx = { vignette: 0, grain: 0, aberration: 0 } // reused survivalGrade output

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      // Every pass that depth-tests renders into the G-buffer's own depth
      // texture; the canvas only ever receives fullscreen triangles. Its
      // default depth renderbuffer was ~4 B/px of dead memory (~8 MiB at
      // 1080p, ~32 MiB at 4K; engine-improvement §4.7).
      depth: false,
    })
    // Program-link validation (getProgramInfoLog + a synchronous status read)
    // stalls the first use of every material. Keep it for development builds,
    // where a broken shader must shout, and drop it in production.
    if (renderer.debug) renderer.debug.checkShaderErrors = !!import.meta.env?.DEV
    // A device that cannot allocate the G-buffer used to render black instead
    // of reaching the fatal panel (main.js). Fail loudly and early.
    const caps = probeDeferredSupport(renderer)
    this.capabilities = caps
    if (!caps.ok) {
      renderer.dispose?.()
      throw new DeferredUnsupportedError(caps)
    }
    // This engine owns a multipass deferred pipeline. Three.js normally clears
    // renderer.info before every renderer.render() call, which would leave the
    // overlays reporting only the final fullscreen pass instead of the frame.
    // Reset explicitly once per engine frame so every pass accumulates.
    renderer.info.autoReset = false
    this.renderer = renderer
    // The 'auto' graphics preset: GPU class first (discrete/Apple -> high,
    // integrated/mobile -> medium, software -> low), refined by a stored
    // per-device benchmark. Classified BEFORE any preset is applied, so an
    // integrated GPU never boots into the heavier 'high'. The renderer string
    // never leaves the machine; only its hash is stored.
    this.gpu = this._classifyGpu(renderer)
    this._renderScale = 1
    this._applyPixelRatio()
    renderer.setSize(innerWidth, innerHeight)
    renderer.toneMapping = THREE.NoToneMapping
    renderer.setClearColor(FOG_COLOR, 1)
    app.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    // No three.js fog/background: the deferred pass nulls the background during
    // the G-buffer render and applies fog analytically in the lighting shader
    // (uFogColor/uFogDensity). The custom RawShaderMaterials ignore scene.fog.
    this.scene = scene

    const camera = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, NEAR, FAR)
    camera.rotation.order = 'YXZ'
    scene.add(camera) // keeps the audio listener (camera child) in the graph
    this.camera = camera

    // Lighting is fully deferred now (computed in the lighting pass), so there
    // are NO real scene lights — the flashlight is an analytic cone and the
    // lamps are shaded from a uniform field. (See DeferredRenderer / LightField.)
    this.materials = createGBufferMaterials(renderer)
    this.geom = createGeometries()

    // Blender-built furniture models load in the background; chunks mesh with
    // the procedural box builders until the library is ready, then every
    // resident chunk swaps its furniture batch in place (no world rebuild).
    this.furnitureModels = createFurnitureModelLibrary()
    // Enemy GLBs ride the same background-load path; entities upgrade from
    // capsule silhouettes when the library resolves below.
    this.enemyModels = createEnemyModelLibrary()
    this.cm = new ChunkManager(scene, hashStr('lobby'), this.materials, this.geom, this.furnitureModels)
    // Same-floor occlusion culling over the thin-wall grid: chunks no sight
    // line from the eye can reach are not submitted at all.
    this.cm.enableSightCulling(true)
    // Apply the ?family= selection before anything reads cm.config — the title
    // backdrop prewarm below must already render the requested family's world.
    // Unknown/disabled values fall back to Office rather than crash the boot.
    let urlFamily = ''
    try {
      urlFamily = (new URLSearchParams(location.search).get('family') ?? '')
        .trim()
        .toLowerCase()
    } catch {
      /* headless test env without location */
    }
    const urlFam = worldConfigForFamilyOrOffice(urlFamily || MAP_FAMILY_OFFICE)
    this.cm.config = urlFam.config
    this.state.mapFamily = urlFam.family
    this.explored = new ExploredMap(this.cm) // player-seen fog state for the minimap
    this.controller = new Controller(camera, renderer.domElement, this.state)
    // Floor handoff re-gates cross-floor chunk visibility the same frame.
    this._transitStair = null
    this.controller.onFloorChange = (f) => this.cm.updateVisibility(f, this._transitStair)
    this.controller.onVoidDeath = () => this.die('void')
    this.controller.flashlight = null // handled in the lighting pass, not a real light

    this.audio = new AudioBus(camera)
    this.stalker = new Stalker(scene, this.materials, this.geom, this.cm)
    this.pursuer = new Pursuer(scene, this.materials, this.geom, this.cm)
    this.husk = new Husk(scene, this.materials, this.geom, this.cm)
    this.enemies = [this.stalker, this.pursuer, this.husk]

    this.deferred = new DeferredRenderer(renderer, scene, camera)
    // World-grid lighting: the ChunkManager's headless light lists and
    // cell-graph bounce become the renderer's GPU light source.
    this.deferred.bindLightGrid(this.cm.lightGrid)
    this.lightField = new LightField(this.deferred.lamps)
    // Tube-flicker profile (reduceFlicker setting): safe until
    // _applyAllSettings pushes the stored choice (_setFlickerProfile).
    this._flicker = FLICKER_SAFE
    // Enemy capsules for the analytic soft shadows and capsule AO (packed
    // for DeferredRenderer.setOccluders; reused every tick).
    this._caps = new Float32Array(CAPSULE_MAX * 8)
    this._capCounts = new Int32Array(CAPSULE_ENEMIES_MAX)
    this._capBounds = new Float32Array(CAPSULE_ENEMIES_MAX * 4)
    this._enemyCapCount = 0
    this._bound4 = [0, 0, 0, 0]
    this._playerM = new Float32Array(16)
    // The flashlight's bounce light, placed by a grid raycast each frame.
    this.torchBounce = new TorchBounce()
    // Materials/lighting were built with the Office defaults; retarget them to
    // the URL-selected family before the title prewarm renders its backdrop.
    this._applyFamilyVisuals(this.state.mapFamily)

    // Kick the furniture GLB fetch; resident chunks swap box batches for the
    // Blender models when it resolves (each load failure keeps the fallback).
    const furniture = loadFurnitureModels(this.furnitureModels).then((lib) => {
      if (this._disposed) disposeFurnitureModels(lib)
      else if (lib.loaded) {
        this.cm.upgradeFurnitureModels(lib)
        return this._precompile()
      }
    })

    // Same upgrade path for the entities: capsule silhouettes until the
    // Blender enemy GLBs arrive, then swap geometry + material in place.
    const enemies = loadEnemyModels(this.enemyModels).then((lib) => {
      if (this._disposed) disposeEnemyModels(lib)
      else if (lib.loaded) {
        upgradeEnemyModels(
          lib,
          { stalker: this.stalker, pursuer: this.pursuer, husk: this.husk },
          this.materials.entityModel,
          this.materials.entityModelSkinned
        )
        return this._precompile()
      }
    })
    // Boot milestones for the loading screen (main.js): both model libraries
    // settled (loaded or failed, their programs linked), and the first
    // deferred frame drawn (_animate).
    this._assetsSettled = Promise.allSettled([furniture, enemies])
    this._firstFrame = new Promise((resolve) => {
      this._onFirstFrame = resolve
    })

    this.debug = new DebugOverlay(renderer)
    this.ui = new UI(this.settings)
    this.ui.setAutoPreset?.(this.gpu.autoPreset)
    this._wireUI()

    this.touchControls = null
    if (this.touch) {
      this.touchControls = new TouchControls(this.ui.el.hud, {
        onMove: (x, z, sprint) => this.controller.setMove(x, z, sprint),
        onLook: (dx, dy) => this.controller.lookDelta(dx, dy),
        onFlashlight: () => this.controller.toggleFlashlight(),
        onPause: () => this.pause(),
      })
      // Landscape enforcement: where orientation.lock isn't granted (iOS), a
      // blocking "rotate device" overlay + pause is the fallback.
      this._portraitMq = matchMedia('(orientation: portrait)')
      this._listen(this._portraitMq, 'change', () => this._checkOrientation())
      this._checkOrientation()
    }

    // App-switch / tab-hide pauses on every tier. Touch never holds a pointer
    // lock to lose, and a desktop player whose re-lock was refused is PLAYING
    // with a free cursor — alt-tabbing then would leave the run unattended.
    // (visibilitychange bubbles from document to window.)
    this._listen(globalThis, 'visibilitychange', () => {
      if (globalThis.document?.hidden) this.pause()
    })
    // (Like lock loss, blur is exempt while F2 owns the cursor — clicking into
    // devtools must not drop a menu under the debug panel.)
    if (!this.touch) {
      this._listen(globalThis, 'blur', () => {
        if (!this.debugMode?.active) this.pause()
      })
    }

    this.minimap = new Minimap(this.ui.el.minimap)
    // Experimental WebGPU path tracer (setting pathTracer: off by default,
    // viewer or realtime). An inert shell until a mode is picked and needed:
    // the tracer, three/webgpu and three-mesh-bvh stay out of the boot bundle.
    this.pathTrace = new LazyPathTraceView(this)
    this.ui.setPathTracerSupport?.(this.pathTrace.availability)
    // Every consumer of a setting exists by now, so push the stored values in
    // one pass instead of scattering `settings.get` calls through construction.
    // The panel was populated before the preset expanded over stale stored
    // advanced keys, so re-read it; the title grade honours NOISE from boot.
    this._applyAllSettings()
    this.ui.refreshSettings()
    this._applyFX(0)

    // M toggles the minimap in-game and stays in sync with the pause checkbox.
    this._listen(globalThis, 'keydown', (e) => {
      if (e.code !== 'KeyM' || e.repeat || this.state.phase !== Phase.PLAYING) return
      if (isEditableFocused()) return
      this._applySetting('minimap', !this.settings.get('minimap'))
      this.ui.refreshSettings()
    })

    if (!this.touch) {
      // Esc closes the pause menu on desktop — and it MUST resume on keyup,
      // not keydown: Esc is the browser's pointer-lock exit gesture, so if the
      // key is still physically held when requestPointerLock engages, the
      // browser instantly exits the lock again and _onLock reopens the pause
      // menu (close -> open flicker). On keyup the key is released before the
      // re-lock, so the lock sticks. Opening works via pointer lock (the
      // browser swallows the Esc that exits the lock, then _onLock pauses).
      // The _pauseT guard covers engines that also deliver the unlocking Esc's
      // keyup — without it that same press would instantly re-resume.
      this._listen(globalThis, 'keyup', (e) => {
        if (e.code !== 'Escape' || this.state.phase !== Phase.PAUSED) return
        // Esc pressed to dismiss a focused pause-menu control (a settings
        // <select> dropdown, a slider blur) must not also resume the game —
        // the M key gate above follows the same rule.
        if (isEditableFocused()) return
        if (this.debugMode?.active) return
        if (performance.now() - (this._pauseT ?? 0) < 400) return
        this.resume()
      })
      // Re-lock fallback: Chrome refuses requestPointerLock for ~1s after an
      // Esc-initiated unlock, so an early Esc-resume can leave the game PLAYING
      // with the mouse free (dead look, and lock loss can't re-trigger pause
      // because there is no lock to lose). Any click re-captures the pointer.
      this._listen(globalThis, 'click', (e) => {
        if (this.state.phase !== Phase.PLAYING || this.controller.isLocked) return
        if (this.debugMode?.active) return
        // ENTER/RESUME/TRY AGAIN already requested the lock inside this same
        // click; the async grant hasn't landed yet, so a second request would
        // race it (some engines reject the duplicate -> spurious relock hint).
        if (e?.target?.closest?.('#ui')) return
        this.controller.lock()
      })
    }

    // The full developer toolbox is intentionally absent from the initial
    // bundle. This inert facade preserves the frame hooks and loads it on F2.
    this.debugMode = new LazyDebugMode(this)

    // Footsteps/landings sound like the floor they land on: family floor
    // style refined by cell semantics (stairs, bridges, wet rooms — see
    // ChunkManager.surfaceAt).
    this.controller.onStep = (spd) => this.audio.footstep(spd, this._surfaceUnderPlayer())
    this.controller.onLand = (impact) => this.audio.land(impact, this._surfaceUnderPlayer())
    // One shared toggle slot: audible click always (incl. battery death),
    // touch button state when touch controls exist.
    this.controller.onToggleFlashlight = (on) => {
      this.audio.flashlightClick(on)
      this.touchControls?.setFlashlight(on)
    }
    this.controller.onLockChange = (locked) => this._onLock(locked)
    this.controller.onLockError = () => this._onLockError()

    this._last = performance.now()
    this._time = 0
    this._dipT = 4 + Math.random() * 6
    this._dipActive = 0
    this._titleYaw = 0
    this._transT = 0
    this._idleRenderPhase = null
    this._nextIdleRenderAt = 0
    this._idleRenderInvalidated = true
    this._running = false
    this._raf = null
    this.exitTarget = new THREE.Vector3()
    this.exitInfo = null

    this._listen(globalThis, 'resize', () => this._onResize())
    // A restored context re-requests the timer extension (DeferredRenderer's
    // listener, registered first, already did): re-read whether frames are
    // GPU-timed, drop the samples of the dead context and restart the
    // benchmark window, so dynamic resolution never waits on null samples.
    if (typeof renderer.domElement?.addEventListener === 'function') {
      this._listen(renderer.domElement, 'webglcontextrestored', () => {
        if (!this._drs) return
        const gpu = !!this.deferred.frameTimer?.supported
        if (gpu !== this._drsGpu) {
          this._drsGpu = gpu
          // The budget follows the mode (_configureDynamicResolution): gpu
          // keeps 60 fps, raf the measured display rate.
          this._drs.configure({ displayHz: gpu ? 60 : (this._displayHz ?? 60) })
        }
        this._drs.reset(performance.now())
        this._bench = null
      })
    }
    // First paint needs only the fog-visible neighbourhood. The title loop's
    // first update immediately starts filling the normal box within the
    // streaming count/time budget.
    this.cm.prewarmTitleBackdrop(SPAWN, SPAWN)
    this._animate = this._animate.bind(this)
  }

  // Auto preset benchmark (chapter 14 P23), measured on real gameplay: the
  // first ~90 resolved GPU frames of a live run on the class default (after
  // a 2 s warm-up) become a score in ms per REFERENCE_MP at 'high';
  // choosePreset then picks the highest preset that fits 70% of the frame
  // budget within the class caps. Each frame is normalised by the backing
  // pixels it was actually rendered at: dynamic resolution leaves the
  // ceiling within a second on exactly the over-budget GPU the benchmark
  // exists to catch, so "only at full scale" never finished there (costs that
  // do not scale with pixels overstate the score slightly below the ceiling,
  // which errs towards the cheaper preset). Persisted per GPU (key = renderer
  // hash, never the string) so the next boot skips it; never overrides a
  // manual preset, never picks cinematic.
  _benchSample(ms, now) {
    const g = this.gpu
    const drs = this._drs
    if (!g || !drs || g.score !== null || g.benchDone || this.settings.get('preset') !== 'auto') return
    if (this.state.phase !== Phase.PLAYING || this.captureFrozen || !(ms > 0) || ms > BENCH_MAX_SAMPLE_MS) return
    const mp = this._backingMegapixels(drs.scale)
    if (!(mp > 0)) return
    const b = (this._bench ??= { startAt: now, samples: [], mp, skip: 0 })
    // A DRS step or a resize: the next few timer results were rendered at
    // the old size and would be divided by the wrong pixel count.
    if (Math.abs(mp - b.mp) > 1e-9) {
      b.mp = mp
      b.skip = BENCH_SKIP_AFTER_RESIZE
      return
    }
    if (b.skip > 0) {
      b.skip--
      return
    }
    if (now - b.startAt < 2000) return
    b.samples.push(ms / mp)
    if (b.samples.length < 90) return
    g.benchDone = true
    const { median } = summarizeBenchmark(b.samples, { maxMs: Infinity })
    const cur = g.autoPreset
    const mps = this._autoViewportMegapixels()
    // Measured at the current preset: normalise to 'high' by its cost weight.
    const at = toScore(median, 1)
    const score = at ? at / (PRESET_COST_WEIGHT[cur] ?? 1) : null
    const { preset } = choosePreset({ score, cls: g.cls, viewportMP: mps, deviceMemory: globalThis.navigator?.deviceMemory })
    g.score = score
    saveGpuProfile(globalThis.localStorage, { key: g.key, score, preset, cls: g.cls, benchVersion: BENCH_VERSION })
    if (preset !== cur) {
      g.autoPreset = preset
      this._runSetting('preset', 'auto')
      this.ui.setAutoPreset?.(preset)
    }
  }

  _classifyGpu(renderer) {
    let str = ''
    try {
      str = readRendererString(renderer.getContext?.())
    } catch {
      str = ''
    }
    const cls = classifyRenderer(str, { mobile: !!this.touch })
    const key = rendererKeyHash(str)
    let stored = null
    try {
      stored = loadGpuProfile(globalThis.localStorage, key)
    } catch {
      stored = null
    }
    // No renderer information at all: keep the pre-classification default.
    const byClass = str ? defaultPresetForClass(cls) : AUTO_FALLBACK_PRESET
    const score = stored?.score ?? null
    // The score is per REFERENCE_MP precisely so it can be re-applied: pick
    // the preset for THIS viewport (a first run in a 720p window must not
    // boot 'ultra' fullscreen at 4K, nor a 4K benchmark keep a 1080p screen
    // on 'medium'). The stored name only stands in when there is no score.
    let autoPreset = stored?.preset ?? byClass
    if (score !== null) {
      autoPreset = choosePreset({
        score,
        cls,
        viewportMP: this._autoViewportMegapixels(),
        deviceMemory: globalThis.navigator?.deviceMemory,
      }).preset
    }
    return { cls, key, rendererKnown: !!str, autoPreset, score }
  }

  // Link any program the scene now references before gameplay touches it.
  // Streaming reuses ~16 shared G-buffer materials, but the first GLB
  // furniture / enemy model draws used to compile synchronously mid-frame.
  // compileAsync polls KHR_parallel_shader_compile where available; failures
  // are non-fatal (the draw simply compiles on first use as before).
  _precompile() {
    const r = this.renderer
    if (this._disposed || typeof r.compileAsync !== 'function') return
    try {
      return r.compileAsync(this.scene, this.camera).catch(() => {})
    } catch {
      /* compile on first use */
    }
  }

  // Resolves once the first deferred frame has been drawn.
  whenFirstFrame() {
    return this._firstFrame
  }

  // Resolves once both model libraries have loaded (or failed) and the
  // programs their first draws need have linked.
  whenAssetsSettled() {
    return this._assetsSettled
  }

  // Deterministic capture/replay (debug/capture.js): describe the current
  // frame, or rebuild the world and camera from such a description and hold
  // it frozen for comparison screenshots. resumeFromCapture() lets the
  // simulation run again.
  capture() {
    return captureState(this)
  }

  applyCapture(desc, options) {
    return applyCapture(this, desc, options)
  }

  // Float probe readback of a pipeline target (DeferredRenderer.probe).
  probe(points, options) {
    return this.deferred.probe(points, options)
  }

  // Replay the chapter-14 shadow evidence set (debug/shadowSet.js).
  async runShadowSet(options) {
    const { runShadowSet } = await import('../debug/shadowSet.js')
    return runShadowSet(this, options)
  }

  // n samples along the world segment a -> b (penumbra profiles).
  probeLine(a, b, n = 16, options) {
    const pts = []
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0
      pts.push({ world: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] })
    }
    return this.deferred.probe(pts, options)
  }

  resumeFromCapture() {
    this.captureFrozen = false
    // A replay may have pinned the capture's flicker profile (runtime only);
    // live play goes back to the player's setting.
    this._setFlickerProfile(this.settings.get('reduceFlicker'))
  }

  _listen(target, type, listener) {
    target.addEventListener(type, listener)
    this._eventBindings.push([target, type, listener])
  }

  _surfaceUnderPlayer() {
    const c = this.controller
    return this.cm.surfaceAt(worldToCell(c.pos.x), worldToCell(c.pos.z), c.floor)
  }

  _wireUI() {
    this.ui.onStart = (seed, family) => this._loadRun(1, LOAD_ENTER, () => this.startRun(seed, family))
    this.ui.onResume = () => this.resume()
    this.ui.onRestart = () => {
      if (this.state.phase === Phase.DEAD && this.state.deathReason === 'void') {
        return this._loadRun(this.state.level, LOAD_AGAIN, () => this.retryCurrentLevel())
      }
      return this._loadRun(1, LOAD_AGAIN, () => this.startRun(this.state.seedText))
    }
    this.ui.onQuit = () => this.quitToTitle()
    this.ui.onSetting = (k, v) => this._applySetting(k, v)
    this.ui.onResetSettings = () => {
      this.settings.reset()
      this._applyAllSettings()
      this.ui.refreshSettings()
    }
    this.ui.onHudHide = () => this._onHudHide()
  }

  // Persist, then apply what the store actually kept — Settings clamps/coerces,
  // so `v` is the request and the return value is the truth.
  _applySetting(k, v) {
    // Hand-editing a preset-owned advanced control detaches the preset: the
    // stored preset flips to 'custom' so a later boot can't silently stamp the
    // preset's values back over the player's tuning. (Preset application goes
    // through _runSetting('preset', ...) and never lands here, so it can't
    // detach itself.)
    if (GRAPHICS_KEYS.includes(k) && this.settings.get('preset') !== 'custom') {
      this.settings.set('preset', 'custom')
    }
    this._runSetting(k, this.settings.set(k, v))
    this._invalidateIdleRender()
  }

  _applyAllSettings() {
    // Applying the preset resolves every advanced graphics key together.
    // Repeating that pass for its seven owned keys needlessly resizes the
    // backing canvas and revisits the complete deferred pipeline at boot/reset.
    for (const k of Object.keys(this.settings.data)) {
      if (!GRAPHICS_KEYS.includes(k)) this._runSetting(k, this.settings.get(k))
    }
  }

  // Retarget every family-driven visual to `family` in place: surface
  // textures + trim/leaf/panel colors (shared material set), and the deferred
  // pipeline's fog/ambient/rim/lamp-cast/grade palette. Chunk meshes keep
  // their material references, so already-built chunks pick the swap up on
  // the next frame; level setup rebuilds them anyway.
  _applyFamilyVisuals(family) {
    const pal = applyFamilyMaterials(this.materials, this.renderer, family)
    this.deferred.applyPalette(pal)
    this.torchBounce.setAlbedo(this.deferred.familyAlbedo())
    this.renderer.setClearColor(pal.fog, 1)
  }

  _runSetting(k, v) {
    if (k === 'sensitivity') this.controller.sensitivity = v
    else if (k === 'invertY') this.controller.invertY = v
    else if (k === 'invertX') this.controller.invertX = v
    else if (k === 'volume') this.audio.setVolume(v)
    else if (k === 'bob') this.controller.setBobEnabled(v)
    else if (k === 'cameraFx') {
      this.controller.setCameraFxEnabled(v)
      this.deferred.setCameraFx?.(v)
      this.deferred.setSignalAccess?.({ noise: this.settings.get('noise') !== 'off', fx: v })
    }
    else if (k === 'motionBlur') this.deferred.setMotionBlur?.(v)
    else if (k === 'noise') {
      this._noiseMode = v
      this.deferred.setSignalAccess?.({ noise: v !== 'off', fx: this.settings.get('cameraFx') !== false })
      // Outside PLAYING nothing else re-derives the grade (title/pause).
      if (this.state.phase !== Phase.PLAYING) this._applyFX(0)
    }
    else if (k === 'outline') this.deferred.setOutline(v)
    else if (k === 'look') this.deferred.setLook(v)
    else if (k === 'dynamicRes') {
      // Not preset-owned: only the resolution controller changes. Under
      // 'auto' (always on) and 'cinematic' (always off) the toggle changes
      // nothing, and must not snap a running controller back to its ceiling.
      if (dynamicResEnabled(this.settings) !== !!this._drs) {
        this._configureDynamicResolution({ renderScale: this._renderScale })
        this._applyPixelRatio()
        this.deferred.setSize()
      }
    }
    else if (k === 'minimap') this.minimap.setVisible(v)
    else if (k === 'reduceFlicker') this._setFlickerProfile(v)
    else if (k === 'pathTracer') this.pathTrace?.setMode(v)
    else if (k === 'frameLimit') {
      this._frameLimit = v
      this._nextFrameAt = null
      this._drs?.configure({ targetFps: this._drsTargetFps() })
    }
    else if (k === 'preset') {
      // A named preset pins every advanced graphics key; 'custom' pins nothing
      // (the stored advanced values already ARE the truth); 'auto' pins the
      // preset this device resolved to.
      const name = concretePreset(v, this.gpu?.autoPreset)
      if (name) this.settings.setMany(GRAPHICS_PRESETS[name])
      this._applyGraphics()
    } else if (GRAPHICS_KEYS.includes(k)) this._applyGraphics()
  }

  // Photosensitivity: one profile drives every tube-flicker source — the
  // global hum and dead-tube dip (_updateFlicker), the per-fixture cast light
  // on the CPU (LightField -> lampFlicker) and on the GPU (grid gFlicker via
  // the renderer's uBadStrobe). Not persisted here: capture replay pins a
  // capture's profile through this without touching the player's setting.
  _setFlickerProfile(reduce) {
    const profile = flickerProfile(reduce !== false)
    this._flicker = profile
    this.lightField.flicker = profile
    this.deferred.setFlickerProfile?.(profile)
  }

  // Re-resolve the stored graphics settings and push them into the renderer:
  // backing-store scale (render scale x DPR clamp x 4K pixel ceiling) + the
  // deferred pipeline's pass enables / loop trip counts. Cheap enough to run
  // per changed key — same-size setSize calls early-return inside three.
  _applyGraphics() {
    const q = resolveGraphics(this.settings, { maxTextureSize: this.capabilities?.maxTextureSize ?? 4096 })
    this._renderScale = q.renderScale
    this._configureDynamicResolution(q)
    this._applyPixelRatio()
    this.deferred.setSize()
    this.deferred.applyQuality(q)
    this.cm.setRenderDetailProfile(q.worldDetail)
    this._invalidateIdleRender()
  }

  // The menu entries into a level (ENTER, TRY AGAIN, RESTART). The level
  // build is synchronous (_setupLevel's prewarm, 1-2 s for ~300 chunks), and
  // run straight from the click it froze the pressed button with no sign of
  // life. Claim what needs the click's user activation now (fullscreen, the
  // audio unlock, pointer lock), cut to the loading card, and build once that
  // card has been presented; it fades out over the new level's first frames.
  _loadRun(level, sub, build) {
    if (this._loading || this._disposed) return
    if (this.touch) enterImmersive()
    this.audio.start()
    if (!this.touch) this.controller.lock()
    this._loading = true
    this.ui.showLoading?.(level, sub)
    afterPaint(() => {
      this._loading = false
      if (this._disposed) return
      try {
        build()
      } catch (err) {
        console.error('[yellow-rooms] level build failed:', err)
        this._restorePhaseUI()
        return
      }
      // Nobody is at the controls if the page lost focus during the build
      // (the blur/visibility pause had no live run to stop then).
      const away = globalThis.document?.hidden || (!this.touch && globalThis.document?.hasFocus?.() === false)
      if (this.state.phase === Phase.PLAYING && away) this.pause()
    })
  }

  // A failed _loadRun build leaves the phase it started from: put its panel back.
  _restorePhaseUI() {
    const p = this.state.phase
    if (p === Phase.TITLE) this.ui.showTitle()
    else if (p === Phase.DEAD) this.ui.showDeath(this.state.deathReason, this.state)
    else if (p === Phase.PAUSED) this.ui.showPause(this.state)
    if (!this.touch) this.controller.unlock()
  }

  start() {
    if (this._running || this._disposed) return
    this._running = true
    const urlSeed = new URLSearchParams(location.search).get('seed')
    if (urlSeed) this.ui.setSeedInput(urlSeed)
    this.ui.setFamilyInput(this.state.mapFamily)
    this.ui.showTitle()
    this._raf = requestAnimationFrame(this._animate)
  }

  startRun(seedText, family = this.state.mapFamily) {
    seedText = (seedText || '').trim() || Math.random().toString(36).slice(2, 8)
    this.state.seedText = seedText
    this.state.level = 1
    this.state.resetLevel()
    this.ui.setSeedInput(seedText)
    // Rebuild the world config only when the family actually changes: retry
    // and same-family restarts must keep the config object identity (void-
    // death baselines compare it), and Office runs stay byte-identical.
    const familyText = typeof family === 'string' ? family.trim().toLowerCase() : ''
    const fam = worldConfigForFamilyOrOffice(familyText || MAP_FAMILY_OFFICE)
    if (this.cm.config?.mapFamily?.selected !== fam.family) {
      this.cm.config = fam.config
      // Family changed: swap the whole visual identity (surfaces, lamp cast,
      // fog/ambient/grade) before _setupLevel rebuilds the chunk meshes.
      this._applyFamilyVisuals(fam.family)
    }
    this.state.mapFamily = fam.family
    this.ui.setFamilyInput(fam.family)
    try {
      // Preserve other params (e.g. the ?touch override) — only update the
      // seed and family. Office keeps default URLs clean (no family param).
      const q = new URLSearchParams(location.search)
      q.set('seed', seedText)
      if (fam.family === MAP_FAMILY_OFFICE) q.delete('family')
      else q.set('family', fam.family)
      history.replaceState(null, '', `?${q}`)
    } catch {
      /* ignore */
    }
    this._setupLevel()
    // Fullscreen + audio unlock must both start synchronously inside this tap
    // (a menu entry already claimed both in its click, _loadRun).
    if (this.touch) enterImmersive()
    this.audio.start()
    this.state.phase = Phase.PLAYING
    this.ui.showHud()
    // A lock granted to the menu click is kept: a second request would race it.
    if (!this.touch && !this.controller.isLocked) this.controller.lock()
    this._checkOrientation()
  }

  resume() {
    // RESTART from the pause menu is building the run behind its loading card.
    if (this._loading) return
    if (this.touch) enterImmersive()
    // The first frames after an unpause are not representative.
    this._resetDynamicResolution()
    // The pause may have interrupted a level TRANSITION (Esc mid-fade): resume
    // back INTO it so _transT keeps counting down and _advance() still runs —
    // forcing PLAYING here would strand the player at the old level's exit.
    const intoTransition = this._pausedFrom === Phase.TRANSITION
    this._pausedFrom = null
    this._setRelock(false) // a fresh lock attempt replaces the stale error state
    this.audio.start() // re-opens a context suspended while paused (iOS)
    this.state.phase = intoTransition ? Phase.TRANSITION : Phase.PLAYING
    if (intoTransition) this.ui.showTransition(this.state.level + 1)
    else this.ui.showHud()
    if (!this.touch) this.controller.lock()
    this._checkOrientation()
  }

  _setupLevel() {
    const { state, cm } = this
    const lvl = state.level
    state.mapFamily = cm.config.mapFamily?.selected ?? 'office'
    cm.setSeed(hashStr(`${state.seedText}#${lvl}`))
    // Seed re-paces the ambient fake-outs; the family retargets the reverb
    // space + texture one-shots (sewer drips, tower wind...).
    this.audio.resetLevel(cm.seed, state.mapFamily)

    // Exit: reproducible XZ several chunks away, on a random non-zero floor
    // within five layers of the floor-0 spawn.
    const exit = createExitPlacement(state.seedText, lvl, cm.seed, cm.config)
    cm.setExit(exit.cx, exit.cy, exit.cz, exit.lx, exit.lz)
    this.exitTarget.set(exit.x, exit.y, exit.z)

    cm.reset()
    // Belt-and-braces with cm.reset()'s visibility reset: the transit cache
    // must also drop, or the first tick's stairAt(spawn)===null comparison
    // would skip the re-gate after a mid-transit death.
    this._transitStair = null
    cm.updateVisibility(0, null)
    this.explored.reset() // fresh fog per level/seed (cm.seed/exit/clearings are set above)
    const yaw = Math.atan2(-(this.exitTarget.x - SPAWN), -(this.exitTarget.z - SPAWN))
    this.controller.teleport(SPAWN, SPAWN, 0, yaw)
    for (const enemy of this.enemies) enemy.reset(lvl, this.controller.pos)
    // Synchronous prewarm behind the title/transition overlay: the whole load
    // ring exists before the player can look, instead of visibly assembling
    // in the first ~0.7s of play.
    cm.prewarm(SPAWN, SPAWN)
    // Present the new level immediately: a level advance renders in the same
    // RAF callback, before any _tick() has moved the camera off the old exit or
    // gathered a lamp set, which drew one unlit frame from the wrong place.
    this.camera.position.set(SPAWN, EYE_H, SPAWN)
    this.camera.rotation.set(0, yaw, 0, 'YXZ')
    this._updateCameraMatrices()
    this._refreshLamps()
    this._resetPresentation()
    // Level load: the first frames (uploads, compiles) must not drive DRS.
    this._resetDynamicResolution()
    // resetLevel() clears flashlightOn without the toggle callback firing.
    this.touchControls?.setFlashlight(state.flashlightOn)
  }

  _onLock(locked) {
    if (this.touch) return // touch mode never locks; pause is the on-screen button
    if (this.debugMode?.active) return // debug owns the cursor; don't auto-pause
    if (locked) {
      // A successful (re-)lock cancels any pending recovery hint.
      this._setRelock(false)
      return
    }
    // Pause on pointer-lock loss during PLAYING *or* TRANSITION. Without the
    // TRANSITION case, losing the lock mid-transition (Esc / alt-tab) leaves the
    // next level in PLAYING with the pointer unlocked and mouse-look dead, with no
    // in-game way to re-lock. Pausing lets the Resume button re-lock via a gesture.
    this.pause()
  }

  // A rejected requestPointerLock (Chrome refuses re-locks for ~1.3s after an
  // Esc-initiated unlock) fires pointerlockerror — previously swallowed, which
  // left the game PLAYING with the cursor free and no hint. Flag the state so
  // the HUD tells the player to click (the click fallback below re-locks).
  _onLockError() {
    if (this.touch || this.debugMode?.active) return
    if (this.state.phase !== Phase.PLAYING) return
    this._setRelock(true)
  }

  _setRelock(on) {
    if (this._awaitingRelock === on) return
    this._awaitingRelock = on
    this.ui.setRelockVisible(on)
  }

  // The UI hides the hint DOM on any phase exit (_showOnly); re-sync the
  // engine flag so the next lock error isn't swallowed as "already on".
  _onHudHide() {
    this._awaitingRelock = false
  }

  pause() {
    if (this.state.phase !== Phase.PLAYING && this.state.phase !== Phase.TRANSITION) return
    this._pausedFrom = this.state.phase // resume() must restore TRANSITION, not force PLAYING
    this._pauseT = performance.now()
    this.state.phase = Phase.PAUSED
    this.ui.showPause(this.state)
    this.touchControls?.reset()
  }

  // Back to the title screen (the only way to change seed without a reload).
  // The TITLE branch of _animate already renders the world backdrop at spawn.
  quitToTitle() {
    if (this.state.phase !== Phase.PAUSED) return
    this.state.phase = Phase.TITLE
    this._pausedFrom = null
    this.audio.setTension(0)
    this.audio.silence() // the boot title is silent; so is the one after a run
    this.controller.unlock()
    // The TITLE backdrop writes position/rotation each frame but never fov —
    // quitting mid-sprint must not leave it rendering at the kicked FOV.
    this.controller.resetCameraFx()
    // The title camera returns to floor 0 even when the player quit upstairs.
    // Drop the previous stair/floor light and visibility inputs before the
    // backdrop streams, or its solid spawn floor can stay completely hidden.
    this._transitStair = null
    this.cm.updateVisibility(0, null)
    this.lightField.reset()
    // The backdrop must not keep the quit frame's low-sanity/stare grade
    // (heavy vignette, grain, aberration) or frozen enemies standing near the
    // spawn. Reset the run's survival state first so the grade re-derives the
    // calm baseline; startRun() resets all of it again anyway.
    this.state.resetLevel()
    this.controller.speedMul = 1
    for (const enemy of this.enemies) enemy.reset(this.state.level, this.controller.pos)
    this._resetPresentation()
    this.touchControls?.reset()
    this.ui.showTitle()
    this._checkOrientation()
  }

  // Touch-only: pause + blocker while portrait. Also re-checked after
  // start/resume so ENTER pressed while portrait can't leave the game running
  // unattended behind the blocker.
  _checkOrientation() {
    if (!this._portraitMq) return
    this.ui.setRotateVisible(this._portraitMq.matches)
    if (this._portraitMq.matches) this.pause()
  }

  die(reason) {
    if (this.state.phase !== Phase.PLAYING) return
    this.state.phase = Phase.DEAD
    this.state.deathReason = reason
    this.audio.setTension(0)
    this.audio.deathStinger(reason)
    this.controller.unlock()
    this.touchControls?.reset()
    this.ui.showDeath(reason, this.state)
  }

  retryCurrentLevel() {
    const { state } = this
    if (state.phase !== Phase.DEAD || state.deathReason !== 'void') return false

    // Keep the current seed/level/config object intact. _setupLevel() derives the
    // same world seed and reuses the selected normalized profile while clearing
    // ChunkManager, visibility, transit, entity, lighting, and Controller state.
    state.resetLevel()
    this._setupLevel()
    this.audio.start()
    state.phase = Phase.PLAYING
    this.ui.showHud()
    if (!this.touch && !this.controller.isLocked) this.controller.lock()
    this._checkOrientation()
    return true
  }

  _levelComplete() {
    if (this.state.phase !== Phase.PLAYING) return
    this.state.phase = Phase.TRANSITION
    this.audio.setTension(0)
    this.audio.exitStinger()
    this.touchControls?.reset()
    this.ui.showTransition(this.state.level + 1)
    this._transT = 2.6
  }

  _advance() {
    this.state.level++
    this.state.resetLevel()
    this._setupLevel()
    this.state.phase = Phase.PLAYING
    this.ui.showHud()
  }

  // Run-neutral screen state: no flashlight cone, no death static, and the
  // baseline grade derived from the (already reset) GameState. Shared by every
  // level entry and by quit-to-title so none of them can drift apart.
  _resetPresentation() {
    this.deferred.lightUniforms.uFlashOn.value = 0
    this.deferred.resetAdaptation()
    this._applyFX(0) // grade.dead follows state.deadAmount (0 after resetLevel)
    // Every caller has just reset the enemies. Nothing ticks on the title,
    // so without this their last capsules keep casting shadows, AO and haze
    // cuts where no enemy is drawn.
    this._updateOccluders()
  }

  // Replace the lamp set with the one for whatever the camera presents now
  // (the title backdrop at spawn, otherwise the player). Needed wherever the
  // source lamp uniforms were cleared or overwritten outside the frame loop
  // (level setup, the debug light room), or a paused/dead backdrop stays dark.
  _refreshLamps() {
    const c = this.controller
    const title = this.state.phase === Phase.TITLE
    this.lightField.reset()
    this.lightField.update(
      0,
      title ? SPAWN : c.pos.x,
      title ? SPAWN : c.pos.z,
      title ? 0 : c.floor,
      this.cm
    )
  }

  _updateCameraMatrices() {
    this.camera.updateMatrixWorld(true)
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert()
  }

  _tick(dt) {
    const { controller, cm, stalker, state, audio } = this
    const steps = 5
    for (let i = 0; i < steps; i++) {
      controller.step(dt / steps, cm)
      // An authored void can end play during any physics substep. Keep the
      // camera matrices valid, but stop gameplay immediately: later substeps and
      // enemy/audio/HUD updates must not mutate the just-frozen death state.
      if (state.phase !== Phase.PLAYING) {
        this._updateCameraMatrices()
        return
      }
    }
    controller.applyFrame(dt)
    this._updateCameraMatrices()
    // Streaming spikes are CPU work the resolution controller must not
    // mistake for GPU load.
    const streamT = performance.now()
    cm.update(controller.pos.x, controller.pos.z, controller.floor)
    if (performance.now() - streamT > 4) this._hitch = true
    // Cross-floor visibility: recompute when the player's stair-transit state
    // changes (entering/leaving a stair footprint flips the far floor fully
    // visible BEFORE the eye crosses the slab plane; floor changes re-gate via
    // onFloorChange). Cheap: one stairAt lookup per tick.
    const transit = cm.stairAt(
      Math.floor(controller.pos.x / CELL),
      Math.floor(controller.pos.z / CELL),
      controller.floor
    )
    if (transit !== this._transitStair) {
      this._transitStair = transit
      cm.updateVisibility(controller.floor, transit)
    }
    // Track explored area ALWAYS (the toggle gates only drawing); skip while
    // debug mode parks/teleports the player so it can't pollute the real map.
    if (!this.debugMode.active) {
      this.explored.update(controller.pos.x, controller.pos.z, controller.floor)
    }
    this.lightField.update(dt, controller.pos.x, controller.pos.z, controller.floor, cm)
    this.deferred.lightUniforms.uFlashOn.value = state.flashlightOn ? 1 : 0

    // The flashlight freezes the entity, but only until the player has stared
    // too long (exposure past the level-scaled limit) — then the freeze fails.
    const limit = this._stareLimit()
    const ctx = {
      flashlightOn: state.flashlightOn,
      canFreeze: state.exposure < limit,
      playerCy: controller.floor,
    }
    const res = stalker.update(dt, controller.pos, this.camera, ctx)
    const res2 = this.pursuer.update(dt, controller.pos, this.camera, ctx)
    const res3 = this.husk.update(dt, controller.pos, this.camera, ctx)
    // Rigged enemies pose from what their AI just did (speed, state, range).
    for (const enemy of this.enemies) enemy.animate?.(dt, controller.pos)
    this._updateOccluders()
    this._updateTorch(dt)
    // Combine all threats: closest drives proximity-slow, any-seen stresses
    // sanity, tension is the max. Beam/stare stay Stalker-only (pass it first).
    const merged = mergeEnemy(res, res2, res3)
    // A husk dying (touched / crowded out) snaps the lights: one flicker dip
    // synced with its dry thump — the room itself registers the death.
    if (res3.died) {
      this._dipActive = 0.18
      this.audio.flickerDrop()
      this.audio.entityThump(0.12, false)
    }
    // Slab-muffled footfalls (v8): a Pursuer closing in from ANOTHER floor is
    // invisible (the slab blocks sight), so it announces itself — heavy,
    // lowpassed thumps through the ceiling/floor, quickening as it nears.
    const realVerticalCue = this.pursuer.active &&
      this.pursuer.cy !== controller.floor &&
      res2.dist < 14
    if (realVerticalCue) {
      this._thumpT = (this._thumpT ?? 0) - dt
      if (this._thumpT <= 0) {
        this.audio.entityThump(0.05 + 0.04 * (1 - res2.dist / 14), true)
        this._thumpT = 0.55
      }
    } else {
      this._thumpT = 0
    }
    // Closer enemy => slower player; consumed by Controller.step next frame
    // (a one-frame lag is imperceptible).
    controller.speedMul = proximitySpeedMul(merged.dist)
    updateStare(state, dt, res.inBeam, limit) // beam/exposure is the Stalker's alone
    audio.setTension(merged.tension)
    // Fluorescent hum follows the lights: silent in the dark, swelling as the
    // player nears a lit lamp. Remap lightAt's 0.1..1 to a clean 0..1.
    const lightHere = cm.lightAt(controller.pos.x, controller.pos.z, controller.floor)
    audio.setHumProximity(
      Math.min(1, Math.max(0, (lightHere - STALKER_AMBIENT) / (1 - STALKER_AMBIENT)))
    )
    updateSanity(state, dt, merged)
    this._updateFlicker(dt)
    audio.update(dt, { seen: merged.seen, realVerticalCue })
    this._updateExit()
    this.ui.updateHud(state, this.exitInfo)
    if (this.minimap.visible) {
      const e = cm.exit
      const exitRevealed =
        !!e && this.explored.isRevealed(e.cx * CHUNK + e.lx, e.cz * CHUNK + e.lz, e.cy)
      this.minimap.update({
        controller,
        exit: e,
        exitRevealed,
        store: this.explored,
        floor: controller.floor,
      })
    }
    this._tension = merged.tension
    this._applyFX(merged.tension)

    const inv = this.debugMode.active && this.debugMode.invincible
    if (merged.caught && !inv) this.die('caught')
    else if (state.sanity <= 0 && !inv) this.die('lost')
  }

  // Visible enemies as capsules for the lighting pass's analytic soft
  // shadows and capsule AO (render/enemyOccluders.js): up to three capsules
  // per enemy fitted to the silhouette actually shown (GLB or the capsule
  // fallback), transformed by the mesh's own matrixWorld so yaw, fallback
  // scales and meshYOffset are all honoured. Group 3 is the optional player
  // body (look.shadow.playerBody), which never shadows its own torch.
  _updateOccluders() {
    const caps = this._caps
    const counts = this._capCounts
    const bounds = this._capBounds
    caps.fill(0)
    counts.fill(0)
    bounds.fill(0)
    const kinds = ['stalker', 'pursuer', 'husk']
    // One-capsule tiers get a set fitted as ONE capsule (floor to head),
    // never a truncated multi-capsule set (a lifted torso ungrounds a figure).
    const perEnemy = this.deferred.quality?.shadow?.capsulesPerEnemy ?? 3
    for (let g = 0; g < this.enemies.length && g < 3; g++) {
      const enemy = this.enemies[g]
      const mesh = enemy.mesh
      if (!enemy.active || !mesh?.visible || !mesh.matrixWorld?.elements) continue
      mesh.updateMatrixWorld?.()
      const table = capsuleSet(kinds[g], enemy.modelState ?? 'fallback', perEnemy)
      const n = transformCapsules(table, mesh.matrixWorld, caps, g * 3 * 8, g)
      counts[g] = n
      bounds.set(capsuleBound(caps, g * 3 * 8, n, this._bound4), g * 4)
    }
    this._enemyCapCount = 9
    if ((this.deferred.look?.shadow?.playerBody ?? 0) > 0 && this.state.phase === Phase.PLAYING) {
      const p = this.controller.pos
      const m = this._playerM
      m.fill(0)
      m[0] = m[5] = m[10] = m[15] = 1
      m[12] = p.x
      m[13] = p.y // controller.pos is the feet
      m[14] = p.z
      const n = transformCapsules([PLAYER_CAPSULE], m, caps, 9 * 8, 3)
      counts[3] = n
      bounds.set(capsuleBound(caps, 9 * 8, n, this._bound4), 12)
    }
    this.deferred.setOccluders(caps, counts, bounds)
  }

  // Flashlight bounce light + the shadow map's caster revision: a still
  // emitter over an unchanged world may reuse last frame's map, unless an
  // animated enemy is near enough to cast into the beam.
  _updateTorch(dt) {
    const on = !!this.state.flashlightOn
    const tb = this.torchBounce
    tb.update(dt, this.cm.lightGrid, this.camera, on, this._caps, this._enemyCapCount)
    this.deferred.setVpl(tb.active, tb.pos, tb.normal, tb.color)
    let near = false
    const p = this.controller.pos
    for (const e of this.enemies) {
      if (e.active && e.mesh?.visible && e.pos.distanceToSquared(p) < (FLASH_RANGE + 4) ** 2) near = true
    }
    this.deferred.casterRevision = near ? null : this.cm.meshRevision
  }

  // Seconds the player may hold the flashlight on the entity before the freeze
  // fails at the current level (see survival.js).
  _stareLimit() {
    return stareLimit(this.state.level)
  }

  _updateFlicker(dt) {
    // Fluorescent hum (lampCharacter.tubeHum): a gentle slow ripple + a faint
    // faster buzz; `f` is the tube's own emissive brightness (feeds the panel
    // albedo + selective bloom). The flicker profile (reduceFlicker setting)
    // scales the ripple and the dead-tube dip depth.
    this._dipT -= dt
    if (this._dipT <= 0) {
      this._dipActive = 0.12
      this._dipT = 4 + Math.random() * 9
      this.audio.flickerDrop()
    }
    const dipping = this._dipActive > 0
    if (dipping) this._dipActive -= dt
    const f = tubeHum(this._time, dipping, this._flicker)
    // PANEL_GLOW pushes the tube emissive into HDR (>1) so the tone map rolls
    // the core toward white and the selective bloom halos it — the fixture
    // reads as a light SOURCE instead of blending into the lit ceiling.
    const panel = this.materials.panel.uniforms
    panel.uIntensity.value = f * PANEL_GLOW * (this.deferred.panelGlow ?? 1)
    if (panel.uPanelPattern) panel.uPanelPattern.value = this.deferred.panelPattern ?? 0
    // Couple the CAST light to the hum so floors/walls actually dip with the tubes
    // (the signature backrooms flicker) — previously only the tube emissive moved.
    // Keep a floor so a dip darkens the room without snapping to black; the
    // volumetric shafts share this uniform and dip in lockstep.
    this.deferred.lightUniforms.uLampFlicker.value = 0.6 + 0.4 * f
  }

  _updateExit() {
    const exitFloor = this.cm.exit?.cy ?? 0
    const { info, reached } = evaluateExit(this.exitTarget, exitFloor, this.controller)
    this.exitInfo = info
    // Exact floor matching prevents completion through a ceiling/floor slab.
    if (reached) this._levelComplete()
  }

  _applyFX(tension = 0) {
    const g = this.deferred.grade
    const fx = survivalGrade(this.state, tension, this._noiseMode, this._stareLimit(), this._fx)
    g.vignette.value = fx.vignette
    g.grain.value = fx.grain
    g.aberration.value = fx.aberration
    g.dead.value = this.state.deadAmount
  }

  // Viewport inputs of the backing-store math; headless runs get 1080p.
  _viewport() {
    const w = globalThis.innerWidth
    const h = globalThis.innerHeight
    if (!(w > 0) || !(h > 0)) return { w: 1920, h: 1080, dpr: 1 }
    return { w, h, dpr: globalThis.devicePixelRatio }
  }

  // Native backing ratio: the DPR clamp and the 4K pixel budget, no scale.
  _nativeRatio() {
    const { w, h, dpr } = this._viewport()
    return computeEffectivePixelRatio(w, h, dpr, MAX_DPR, 1)
  }

  // DRS ceiling (a fraction of native) for a preset render scale.
  _drsCeiling(renderScale) {
    const { w, h, dpr } = this._viewport()
    return drsCeiling(computeEffectivePixelRatio(w, h, dpr, MAX_DPR, renderScale), this._nativeRatio())
  }

  // Backing megapixels at a DRS scale (what _applyPixelRatio renders).
  _backingMegapixels(scale) {
    const { w, h } = this._viewport()
    const r = this._nativeRatio() * scale
    return (w * h * r * r) / 1e6
  }

  // Backing megapixels per auto-pickable preset as 'auto' renders them: DRS
  // is always on there, so each preset runs at its native-terms ceiling.
  _autoViewportMegapixels() {
    const { w, h } = this._viewport()
    const native = this._nativeRatio()
    return viewportMegapixels(w, h, (p) => native * this._drsCeiling(GRAPHICS_PRESETS[p].renderScale))
  }

  // Backing-store scale = render scale x DPR clamp x 4K-equivalent pixel
  // ceiling. Every input can change at runtime (settings, zoom, monitor move).
  // With dynamic resolution the controller's scale multiplies the NATIVE
  // ratio (after both clamps), as its contract asks: fed through the render
  // scale argument it came before the budget clamp, and on a 1440p Retina
  // or 5K screen the first five down-steps changed no pixels at all.
  _applyPixelRatio() {
    const { w, h, dpr } = this._viewport()
    this.renderer.setPixelRatio(
      this._drs
        ? this._nativeRatio() * this._drs.scale
        : computeEffectivePixelRatio(w, h, dpr, MAX_DPR, this._renderScale)
    )
  }

  // Dynamic resolution (chapter 14 P24): on for the 'auto' preset or the
  // DYNAMIC RESOLUTION toggle, never for cinematic. The controller works on
  // the NATIVE backing store (after the DPR / pixel-budget clamps). A quality
  // change starts at the new ceiling; a resize (`resize`) keeps the measured
  // scale, clamped into the new bounds, and only drops the samples taken at
  // the old pixel count.
  _configureDynamicResolution(q, { resize = false } = {}) {
    if (!dynamicResEnabled(this.settings)) {
      this._drs = null
      this.deferred.setFrameTiming?.(false)
      return
    }
    const params = {
      ceiling: this._drsCeiling(q.renderScale),
      nativeLines: Math.round(this._viewport().h * this._nativeRatio()),
    }
    if (!this._drs) {
      this._drs = new DynamicResolution(params)
      this._drsGpu = !!this.deferred.setFrameTiming?.(true)
    }
    // Only raf mode reads the display rate: its samples are rAF intervals,
    // which a 30 Hz cap or a 50 Hz panel stretches. The GPU timer measures
    // GPU load directly, so gpu mode keeps the 60 fps budget the benchmark
    // chose presets against, and a low estimate can never lengthen it.
    this._drs.configure({
      ...params,
      displayHz: this._drsGpu ? undefined : this._displayHz,
      targetFps: this._drsTargetFps(),
    })
    this._drs.reset(performance.now(), { toCeiling: !resize })
    this._pinnedFor = 0
  }

  // The DRS target under a frame limit: a capped frame may use the whole
  // capped interval, and raf mode would otherwise read the cap's long
  // intervals as an overloaded GPU and walk the scale to the floor. Limits
  // at or above 60 fps keep the 60 fps budget the presets were chosen for.
  _drsTargetFps() {
    const lim = this._frameLimit
    const fps = lim === 'half' ? (this._displayHz ?? 60) / 2 : typeof lim === 'number' ? lim : Infinity
    return Math.min(60, fps)
  }

  // Level load and unpause (the DynamicResolution contract): drop the
  // samples and ignore the next second, keep the scale.
  _resetDynamicResolution() {
    this._drs?.reset(performance.now())
    this._pinnedFor = 0
  }

  // Display refresh estimate for the raf-mode frame budget. The controller
  // reads rAF intervals there, so a 30 Hz Low Power Mode cap or a 50 Hz panel
  // read as a GPU over a 60 Hz budget and walked it to the floor. Measured
  // only on the title and pause screens, and only on intervals that follow a
  // callback which submitted nothing: a rendered frame that costs more than a
  // refresh pushes the next callback out by a whole vsync, which on a slow
  // device made every interval ~33 ms and a 60 Hz panel read as 30 Hz. When
  // every callback renders (a 30 Hz cap, or a slow device), _shouldRender
  // skips one due render after DISPLAY_PROBE_STREAK in a row to make a clean
  // interval. A low percentile errs high, which is harmless: the budget is
  // 1000 / min(displayHz, 60), so a high reading leaves the 60 fps one.
  _trackDisplayRate(rafMs, phase, rendered) {
    const clean = this._renderStreak === 0
    this._renderStreak = rendered ? (this._renderStreak ?? 0) + 1 : 0
    if (phase !== Phase.TITLE && phase !== Phase.PAUSED) return
    if (!clean) return
    if (!(rafMs > 2 && rafMs < 100)) return // first frame, background tab
    const r = (this._rafIntervals ??= [])
    r.push(rafMs)
    if (r.length < DISPLAY_RATE_SAMPLES) return
    r.sort((a, b) => a - b)
    // Never below 30 Hz: a GPU too slow to keep even the capped title
    // frames inside two refreshes must not buy itself a longer budget.
    const hz = Math.max(30, Math.round(1000 / r[Math.floor(r.length / 4)]))
    r.length = 0
    if (Math.abs(hz - (this._displayHz ?? 60)) <= 2) return
    this._displayHz = hz
    if (this._drs && !this._drsGpu) {
      this._drs.configure({ displayHz: hz, targetFps: this._drsTargetFps() })
      this._pinnedFor = 0
    } else if (this._drs && this._frameLimit === 'half') {
      // The ½ REFRESH target is a fraction of the rate just measured.
      this._drs.configure({ targetFps: this._drsTargetFps() })
    }
  }

  // One controller sample per rendered frame; a new scale reallocates the
  // targets (at most one change per 5 s in steady state).
  _sampleDynamicResolution(now, intervalMs) {
    const drs = this._drs
    if (!drs) return
    const gpu = this._drsGpu
    const ms = gpu ? (this.deferred.pollFrameMs?.() ?? null) : intervalMs
    if (gpu) this._benchSample(ms, now)
    const next = drs.sample(ms, {
      now,
      gpu,
      paused: this.state.phase !== Phase.PLAYING || !!this.captureFrozen || !!this.pathTrace?.active,
      hitch: this._hitch,
      tension: this._tension ?? 0,
      intervalMs,
    })
    this._hitch = false
    if (next !== null) {
      this._applyPixelRatio()
      this.deferred.setSize()
    }
    // In-session guard (P23): 10 s of live play in which the controller was
    // over budget AT its floor (starved: not CPU-bound, nothing left to
    // lower) means the auto preset is too heavy — drop one preset, once per
    // session. Never "scale == floor": where the floor equals the ceiling
    // (phones in landscape) that held from the first frame on an idle GPU.
    // Only a GPU timer proves GPU load, so only a gpu-mode drop is kept for
    // this GPU, as a raised score (the next boot re-derives the drop at this
    // viewport, and a smaller one can earn the preset back); rAF intervals
    // cannot tell a slow GPU from a capped display, so a raf-mode drop lasts
    // this session only.
    const frozen = !!this.captureFrozen || !!(this.debugMode.active && this.debugMode.freeze) ||
      !!this.pathTrace?.active
    const starved = this.state.phase === Phase.PLAYING && !frozen && drs.starved
    this._pinnedFor = starved ? (this._pinnedFor ?? 0) + intervalMs : 0
    const g = this.gpu
    if (this._pinnedFor > 10000 && !this._guardDropped && g && this.settings.get('preset') === 'auto') {
      const order = ['low', 'medium', 'high', 'ultra']
      const i = order.indexOf(g.autoPreset)
      if (i > 0) {
        this._guardDropped = true
        const cur = g.autoPreset
        g.autoPreset = order[i - 1]
        if (gpu) {
          g.score = guardScore(g.score, cur, this._autoViewportMegapixels())
          saveGpuProfile(globalThis.localStorage, { key: g.key, score: g.score, preset: g.autoPreset, cls: g.cls, benchVersion: BENCH_VERSION })
        }
        this._runSetting('preset', 'auto')
        this.ui.setAutoPreset?.(g.autoPreset)
      }
    }
  }

  _onResize() {
    this.camera.aspect = innerWidth / innerHeight
    this.camera.updateProjectionMatrix()
    // The native line count (and with the pixel budget, the ceiling) moved:
    // re-bound the controller, keeping its measured scale.
    if (this._drs) this._configureDynamicResolution({ renderScale: this._renderScale }, { resize: true })
    // Re-apply the DPR, graphics scale, and backing-pixel ceiling: browser zoom
    // or moving the window between monitors can change every input here.
    this._applyPixelRatio()
    this.renderer.setSize(innerWidth, innerHeight)
    this.deferred.setSize()
    this.debugMode.resize(innerWidth, innerHeight)
    this.pathTrace?.resize(innerWidth, innerHeight)
    this.minimap.resize()
    this._invalidateIdleRender()
  }

  _invalidateIdleRender() {
    this._idleRenderInvalidated = true
  }

  // TITLE/PAUSED render on a deadline rather than a display-frame divisor, so
  // 90/120/144 Hz panels all converge on 30 canvas frames. Phase transitions,
  // resized buffers, changed settings, and active diagnostics draw immediately.
  // Missed intervals (background tabs) are skipped rather than replayed.
  // A settled PAUSED screen holds its last frame (PAUSE_SETTLE_MS); live
  // phases follow the frame limit (_frameLimitDue).
  _shouldRender(now, phase, frameTime = now) {
    const idle = phase === Phase.TITLE || phase === Phase.PAUSED
    if (!idle || this.debugMode.active || this.debug.visible) {
      this._idleRenderPhase = null
      this._idleRenderInvalidated = false
      // F2 debug mode keeps every frame (its tools time and step them).
      return idle || this.debugMode.active ? true : this._frameLimitDue(frameTime)
    }

    if (this._idleRenderInvalidated || this._idleRenderPhase !== phase) {
      this._idleRenderPhase = phase
      this._idleRenderInvalidated = false
      this._nextIdleRenderAt = now + IDLE_RENDER_INTERVAL_MS
      this._idleHoldAt = now + PAUSE_SETTLE_MS
      return true
    }

    if (phase === Phase.PAUSED) {
      // A lighting build still compiling will swap in: keep drawing until it
      // has, and for the settle time after, so exposure re-adapts on screen.
      if (this.deferred?.lightingPending) this._idleHoldAt = now + PAUSE_SETTLE_MS
      else if (now >= this._idleHoldAt) return false
    }

    if (now < this._nextIdleRenderAt) return false
    // Display-rate probe: a due render waits one callback when the last few
    // all rendered, so _trackDisplayRate sees a vsync spacing that no frame
    // stretched. The deadline is kept; the next callback draws.
    if ((this._renderStreak ?? 0) >= DISPLAY_PROBE_STREAK) return false
    const elapsedIntervals =
      Math.floor((now - this._nextIdleRenderAt) / IDLE_RENDER_INTERVAL_MS) + 1
    this._nextIdleRenderAt += elapsedIntervals * IDLE_RENDER_INTERVAL_MS
    return true
  }

  // Settings 'frameLimit' for PLAYING / DEAD / TRANSITION. The simulation
  // still ticks on every rAF callback; only the deferred submission waits.
  // 'half' draws on every second callback, evenly paced on any refresh rate.
  // A number draws on a deadline that advances by exactly its interval, so
  // the average rate is the limit (uneven on a refresh rate it does not
  // divide); a deadline missed by a whole interval restarts from now rather
  // than bursting to catch up.
  _frameLimitDue(now) {
    const lim = this._frameLimit
    if (lim === 'half') return (this._halfFrame = !this._halfFrame)
    if (typeof lim !== 'number' || !(lim > 0)) return true
    const interval = 1000 / lim
    const next = this._nextFrameAt ?? -Infinity
    if (now < next - Math.min(FRAME_LIMIT_SLACK_MAX_MS, interval * FRAME_LIMIT_SLACK)) return false
    const after = next + interval
    this._nextFrameAt = after > now ? after : now + interval
    return true
  }

  // `frameTime` is rAF's own timestamp (the frame's vsync-aligned start);
  // only the frame limit reads it, since performance.now() here wobbles
  // with whatever ran before the callback.
  _animate(frameTime) {
    if (this._disposed) return
    if (this._running) this._raf = requestAnimationFrame(this._animate)
    const now = performance.now()
    const rafMs = now - this._last
    const dt = Math.min(rafMs / 1000, 0.05)
    this._last = now
    // A replayed capture pins the clock so flicker/grain/noise hold still.
    if (!this.captureFrozen) this._time += dt
    const p = this.state.phase

    this.debugMode.update(dt)
    // The experimental path-traced view holds the world still from the key
    // press on (it can take seconds to start); mouse look keeps working.
    const tracing = !!this.pathTrace?.active
    const frozen = (this.debugMode.active && this.debugMode.freeze) || this.captureFrozen || tracing

    if (frozen) {
      this._updateCameraMatrices() // keep the player camera valid while paused
    } else if (p === Phase.PLAYING) {
      this._tick(dt)
    } else if (p === Phase.DEAD) {
      this.state.deadAmount = Math.min(1, this.state.deadAmount + dt * 1.4)
      this.deferred.grade.dead.value = this.state.deadAmount
      this._updateFlicker(dt) // the world behind the death static keeps humming
      this._updateCameraMatrices()
    } else if (p === Phase.TRANSITION) {
      this.deferred.grade.dead.value = THREE.MathUtils.lerp(
        this.deferred.grade.dead.value,
        0.55,
        1 - Math.exp(-2.5 * dt) // frame-rate independent fade
      )
      this._transT -= dt
      this._updateFlicker(dt)
      this._updateCameraMatrices()
      if (this._transT <= 0) this._advance()
    } else {
      // TITLE / PAUSED: keep the world rendering behind the overlay.
      if (p === Phase.TITLE) {
        this._titleYaw += dt * 0.06
        this.camera.position.set(SPAWN, EYE_H, SPAWN)
        this.camera.rotation.set(0, this._titleYaw, 0, 'YXZ')
        this.cm.update(SPAWN, SPAWN)
        this.lightField.update(dt, SPAWN, SPAWN, 0, this.cm)
      }
      this._updateFlicker(dt)
      this._updateCameraMatrices()
    }

    // Once live, the path tracer draws on its own WebGPU canvas every frame
    // and the deferred frame is not submitted at all (the GPU is the
    // tracer's). Leaving PLAYING closes it first.
    if (this.pathTrace) {
      this.pathTrace.update(p)
      if (this.pathTrace.render(now)) {
        // The first deferred frame back shares the GPU with a tracer that
        // just ran flat out: dynamic resolution must not read it as load.
        this._lastRenderAt = now
        this._hitch = true
        return
      }
    }

    // Keep RAF-time simulation/title animation current, but omit the expensive
    // deferred submission between idle deadlines. renderer.info deliberately
    // retains the previous completed frame on skipped callbacks.
    const render = this._shouldRender(now, p, Number.isFinite(frameTime) ? frameTime : now)
    this._trackDisplayRate(rafMs, p, render)
    if (!render) return

    // DebugMode.update() runs first so PerfTool can sample the last completed
    // frame. Start the new renderer-info interval immediately before its first
    // possible draw; DebugOverlay reads the finished aggregate below.
    this.renderer.info.reset()
    this.debugMode.preRender()
    try {
      this.deferred.render(this._time)
    } finally {
      this.debugMode.postRender()
    }
    if (this._onFirstFrame) {
      this._onFirstFrame()
      this._onFirstFrame = null
    }
    // Realtime path tracing (experimental): the frame above already blended
    // the newest traced lighting; now trace this camera for the next ones.
    this.pathTrace?.afterRender(now, p)
    this._sampleDynamicResolution(now, (now - (this._lastRenderAt ?? now)) || 16.7)
    this._lastRenderAt = now
    this.debug.update(dt, { chunks: this.cm.loadedCount })
  }

  dispose() {
    if (this._disposed) return
    this._disposed = true
    this._running = false
    if (this._raf != null) {
      globalThis.cancelAnimationFrame?.(this._raf)
      this._raf = null
    }
    for (const [target, type, listener] of this._eventBindings) {
      target.removeEventListener(type, listener)
    }
    this._eventBindings.length = 0
    this.debugMode.dispose()
    this.pathTrace?.dispose()
    this.debug.dispose()
    this.controller.dispose?.()
    this.touchControls?.dispose?.()
    this.ui.dispose?.()
    this.audio.dispose?.()
    // Per-chunk instance buffers belong to residents, not the shared geometry
    // library. Release residents before disposing the resources they reference.
    this.cm.reset()
    this.cm.root?.removeFromParent()
    this.camera.removeFromParent?.()
    disposeGBufferMaterials(this.materials)
    disposeGeometries(this.geom)
    disposeFurnitureModels(this.furnitureModels)
    for (const enemy of this.enemies) enemy.anim?.dispose()
    disposeEnemyModels(this.enemyModels)
    this.deferred.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove?.()
  }
}
