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
  PROXIMITY_SLOW_RADIUS,
  PROXIMITY_SLOW_MAX,
  STARE_LIMIT_BASE,
  STARE_SANITY_DRAIN,
  STARE_RECOVER,
  STALKER_AMBIENT,
  PANEL_GLOW,
  worldToCell,
} from '../world/constants.js'
import { applyFamilyMaterials, createGBufferMaterials, disposeGBufferMaterials } from '../render/gbufferMaterials.js'
import { createGeometries, disposeGeometries } from '../render/geometries.js'
import { ChunkManager } from '../world/ChunkManager.js'
import { Controller } from '../player/Controller.js'
import { AudioBus } from '../audio/AudioBus.js'
import { Stalker } from '../entities/Stalker.js'
import { Pursuer } from '../entities/Pursuer.js'
import { Husk } from '../entities/Husk.js'
import { mergeEnemy } from './enemyMerge.js'
import { DeferredRenderer } from '../render/DeferredRenderer.js'
import { LightField } from '../render/LightField.js'
import { GameState, Phase } from './GameState.js'
import { Settings } from './Settings.js'
import { GRAPHICS_KEYS, GRAPHICS_PRESETS, resolveGraphics } from './graphics.js'
import { IS_TOUCH, MAX_DPR, enterImmersive } from './device.js'
import { DebugOverlay } from './DebugOverlay.js'
import { DebugMode } from '../debug/DebugMode.js'
import { UI } from '../ui/overlays.js'
import { TouchControls } from '../ui/TouchControls.js'
import { Minimap } from '../ui/Minimap.js'
import { ExploredMap } from '../world/ExploredMap.js'
import { hashStr } from '../world/core/hash.js'
import { worldConfigForFamilyOrOffice } from '../world/mapFamily.js'
import { MAP_FAMILY_OFFICE } from '../world/mapTypes.js'
import { createExitPlacement, evaluateExit } from './exitPlacement.js'

// Make color management explicit (it defaults to true in three r0.185). With it
// on, `new THREE.Color(hex)` already converts the sRGB hex into the linear
// working space, so the renderer's color helpers must decode exactly ONCE — see
// linVec (DeferredRenderer) / lin (gbufferMaterials) / _setColors (LightTool).
THREE.ColorManagement.enabled = true

const SPAWN = SPAWN_WORLD

export class Engine {
  constructor(app) {
    this.settings = new Settings()
    this.state = new GameState()
    this.touch = IS_TOUCH

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    })
    renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_DPR))
    renderer.setSize(innerWidth, innerHeight)
    renderer.toneMapping = THREE.NoToneMapping
    renderer.setClearColor(FOG_COLOR, 1)
    app.appendChild(renderer.domElement)
    this.renderer = renderer

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

    this.cm = new ChunkManager(scene, hashStr('lobby'), this.materials, this.geom)
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

    this.deferred = new DeferredRenderer(renderer, scene, camera)
    this.lightField = new LightField(this.deferred.lamps)
    // Materials/lighting were built with the Office defaults; retarget them to
    // the URL-selected family before the title prewarm renders its backdrop.
    this._applyFamilyVisuals(this.state.mapFamily)

    this.debug = new DebugOverlay(renderer)
    this.ui = new UI(this.settings)
    this._wireUI()

    this.touchControls = null
    if (this.touch) {
      this.touchControls = new TouchControls(this.ui.el.hud, {
        onMove: (x, z, sprint) => this.controller.setMove(x, z, sprint),
        onLook: (dx, dy) => this.controller.lookDelta(dx, dy),
        onFlashlight: () => this.controller.toggleFlashlight(),
        onPause: () => this.pause(),
      })
      // Mobile app-switch / tab-hide: pointer lock never fires here, so pause
      // off visibility instead.
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.pause()
      })
      // Landscape enforcement: where orientation.lock isn't granted (iOS), a
      // blocking "rotate device" overlay + pause is the fallback.
      this._portraitMq = matchMedia('(orientation: portrait)')
      this._portraitMq.addEventListener('change', () => this._checkOrientation())
      this._checkOrientation()
    }

    this.minimap = new Minimap(this.ui.el.minimap)
    // Every consumer of a setting exists by now, so push the stored values in
    // one pass instead of scattering `settings.get` calls through construction.
    this._applyAllSettings()

    // M toggles the minimap in-game and stays in sync with the pause checkbox.
    addEventListener('keydown', (e) => {
      if (e.code !== 'KeyM' || this.state.phase !== Phase.PLAYING) return
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return
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
      addEventListener('keyup', (e) => {
        if (e.code !== 'Escape' || this.state.phase !== Phase.PAUSED) return
        if (this.debugMode?.active) return
        if (performance.now() - (this._pauseT ?? 0) < 400) return
        this.resume()
      })
      // Re-lock fallback: Chrome refuses requestPointerLock for ~1s after an
      // Esc-initiated unlock, so an early Esc-resume can leave the game PLAYING
      // with the mouse free (dead look, and lock loss can't re-trigger pause
      // because there is no lock to lose). Any click re-captures the pointer.
      addEventListener('click', () => {
        if (this.state.phase !== Phase.PLAYING || this.controller.isLocked) return
        if (this.debugMode?.active) return
        this.controller.lock()
      })
    }

    this.debugMode = new DebugMode(this) // inert until F2; visualizes gen/lighting/AI

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

    this._last = performance.now()
    this._time = 0
    this._dipT = 4 + Math.random() * 6
    this._dipActive = 0
    this._titleYaw = 0
    this._transT = 0
    this.exitTarget = new THREE.Vector3()
    this.exitInfo = null

    addEventListener('resize', () => this._onResize())
    this.cm.prewarm(SPAWN, SPAWN) // full title backdrop on first paint
    this._animate = this._animate.bind(this)
  }

  _surfaceUnderPlayer() {
    const c = this.controller
    return this.cm.surfaceAt(worldToCell(c.pos.x), worldToCell(c.pos.z), c.floor)
  }

  _wireUI() {
    this.ui.onStart = (seed, family) => this.startRun(seed, family)
    this.ui.onResume = () => this.resume()
    this.ui.onRestart = () => {
      if (this.state.phase === Phase.DEAD && this.state.deathReason === 'void') {
        return this.retryCurrentLevel()
      }
      return this.startRun(this.state.seedText)
    }
    this.ui.onQuit = () => this.quitToTitle()
    this.ui.onSetting = (k, v) => this._applySetting(k, v)
    this.ui.onResetSettings = () => {
      this.settings.reset()
      this._applyAllSettings()
      this.ui.refreshSettings()
    }
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
  }

  _applyAllSettings() {
    for (const k of Object.keys(this.settings.data)) this._runSetting(k, this.settings.get(k))
  }

  // Retarget every family-driven visual to `family` in place: surface
  // textures + trim/leaf/panel colors (shared material set), and the deferred
  // pipeline's fog/ambient/rim/lamp-cast/grade palette. Chunk meshes keep
  // their material references, so already-built chunks pick the swap up on
  // the next frame; level setup rebuilds them anyway.
  _applyFamilyVisuals(family) {
    const pal = applyFamilyMaterials(this.materials, this.renderer, family)
    this.deferred.applyPalette(pal)
    this.renderer.setClearColor(pal.fog, 1)
  }

  _runSetting(k, v) {
    if (k === 'sensitivity') this.controller.sensitivity = v
    else if (k === 'invertY') this.controller.invertY = v
    else if (k === 'invertX') this.controller.invertX = v
    else if (k === 'volume') this.audio.setVolume(v)
    else if (k === 'bob') this.controller.setBobEnabled(v)
    else if (k === 'cameraFx') this.controller.setCameraFxEnabled(v)
    else if (k === 'noise') this._noiseMode = v
    else if (k === 'outline') this.deferred.setOutline(v)
    else if (k === 'minimap') this.minimap.setVisible(v)
    else if (k === 'preset') {
      // A named preset pins every advanced graphics key; 'custom' pins nothing
      // (the stored advanced values already ARE the truth).
      if (v !== 'custom') {
        for (const [gk, gv] of Object.entries(GRAPHICS_PRESETS[v])) this.settings.set(gk, gv)
      }
      this._applyGraphics()
    } else if (GRAPHICS_KEYS.includes(k)) this._applyGraphics()
  }

  // Re-resolve the stored graphics settings and push them into the renderer:
  // backing-store scale (render scale x DPR clamp) + the deferred pipeline's
  // pass enables / loop trip counts. Cheap enough to run per changed key —
  // same-size setSize calls early-return inside three.
  _applyGraphics() {
    const q = resolveGraphics(this.settings)
    this._renderScale = q.renderScale
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_DPR) * q.renderScale)
    this.deferred.setSize()
    this.deferred.applyQuality(q)
  }

  start() {
    const urlSeed = new URLSearchParams(location.search).get('seed')
    if (urlSeed) this.ui.setSeedInput(urlSeed)
    this.ui.setFamilyInput(this.state.mapFamily)
    this.ui.showTitle()
    requestAnimationFrame(this._animate)
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
    // Fullscreen + audio unlock must both start synchronously inside this tap.
    if (this.touch) enterImmersive()
    this.audio.start()
    this.state.phase = Phase.PLAYING
    this.ui.showHud()
    if (!this.touch) this.controller.lock()
    this._checkOrientation()
  }

  resume() {
    if (this.touch) enterImmersive()
    this.state.phase = Phase.PLAYING
    this.ui.showHud()
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
    this.stalker.reset(lvl, this.controller.pos)
    this.pursuer.reset(lvl, this.controller.pos)
    this.husk.reset(lvl, this.controller.pos)
    // Synchronous prewarm behind the title/transition overlay: the whole load
    // ring exists before the player can look, instead of visibly assembling
    // in the first ~0.7s of play.
    cm.prewarm(SPAWN, SPAWN)
    this.lightField.reset()
    // resetLevel() clears flashlightOn without the toggle callback firing.
    this.touchControls?.setFlashlight(state.flashlightOn)
  }

  _onLock(locked) {
    if (this.touch) return // touch mode never locks; pause is the on-screen button
    if (this.debugMode?.active) return // debug owns the cursor; don't auto-pause
    // Pause on pointer-lock loss during PLAYING *or* TRANSITION. Without the
    // TRANSITION case, losing the lock mid-transition (Esc / alt-tab) leaves the
    // next level in PLAYING with the pointer unlocked and mouse-look dead, with no
    // in-game way to re-lock. Pausing lets the Resume button re-lock via a gesture.
    if (!locked && (this.state.phase === Phase.PLAYING || this.state.phase === Phase.TRANSITION)) {
      this._pauseT = performance.now()
      this.state.phase = Phase.PAUSED
      this.ui.showPause(this.state)
    }
  }

  pause() {
    if (this.state.phase !== Phase.PLAYING && this.state.phase !== Phase.TRANSITION) return
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
    this.audio.setTension(0)
    this.controller.unlock()
    // The TITLE backdrop writes position/rotation each frame but never fov —
    // quitting mid-sprint must not leave it rendering at the kicked FOV.
    this.controller.resetCameraFx()
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
    this.deferred.grade.dead.value = 0
    state.phase = Phase.PLAYING
    this.ui.showHud()
    if (!this.touch) this.controller.lock()
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
    this.deferred.grade.dead.value = 0
    this.state.phase = Phase.PLAYING
    this.ui.showHud()
  }

  _updateCameraMatrices() {
    this.camera.updateMatrixWorld(true)
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert()
  }

  _tick(dt) {
    const { controller, cm, stalker, state, audio } = this
    const steps = 5
    for (let i = 0; i < steps; i++) controller.step(dt / steps, cm)
    controller.applyFrame(dt)
    this._updateCameraMatrices()
    cm.update(controller.pos.x, controller.pos.z, controller.floor)
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
    const stareLimit = this._stareLimit()
    const ctx = {
      flashlightOn: state.flashlightOn,
      canFreeze: state.exposure < stareLimit,
      playerCy: controller.floor,
    }
    const res = stalker.update(dt, controller.pos, this.camera, ctx)
    const res2 = this.pursuer.update(dt, controller.pos, this.camera, ctx)
    const res3 = this.husk.update(dt, controller.pos, this.camera, ctx)
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
    this._updateProximity(merged)
    this._updateStare(dt, res, stareLimit) // beam/exposure is the Stalker's alone
    audio.setTension(merged.tension)
    // Fluorescent hum follows the lights: silent in the dark, swelling as the
    // player nears a lit lamp. Remap lightAt's 0.1..1 to a clean 0..1.
    const lightHere = cm.lightAt(controller.pos.x, controller.pos.z, controller.floor)
    audio.setHumProximity(
      Math.min(1, Math.max(0, (lightHere - STALKER_AMBIENT) / (1 - STALKER_AMBIENT)))
    )
    this._updateSanity(dt, merged)
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
    this._applyFX(merged.tension)

    const inv = this.debugMode.active && this.debugMode.invincible
    if (merged.caught && !inv) this.die('caught')
    else if (state.sanity <= 0 && !inv) this.die('lost')
  }

  _updateSanity(dt, res) {
    const s = this.state
    if (res.seen) s.sanity -= dt * 0.15
    else if (res.tension > 0.45) s.sanity -= dt * 0.05
    else s.sanity = Math.min(1, s.sanity + dt * 0.07)
    s.sanity = Math.max(0, s.sanity)
  }

  // Seconds the player may hold the flashlight on the entity before the freeze
  // fails; shrinks with the level (floor 1s) so higher levels punish staring.
  _stareLimit() {
    return Math.max(1.0, STARE_LIMIT_BASE - this.state.level * 0.12)
  }

  // Closer enemy => slower player. Drives controller.speedMul, consumed by
  // Controller.step on the next frame (a one-frame lag is imperceptible).
  _updateProximity(res) {
    let mul = 1
    // res.dist is the closest of either enemy; dormant ones report Infinity, so
    // no active-gate is needed (the Pursuer's proximity now counts too).
    if (res.dist < PROXIMITY_SLOW_RADIUS) {
      const t = (PROXIMITY_SLOW_RADIUS - res.dist) / PROXIMITY_SLOW_RADIUS // 0..1
      mul = 1 - Math.min(1, Math.max(0, t)) * PROXIMITY_SLOW_MAX
    }
    this.controller.speedMul = mul
  }

  // Flashlight "stare" backlash: beaming the entity charges exposure; past the
  // limit the freeze has already failed (see stalker ctx.canFreeze) and the
  // player's sanity crashes.
  _updateStare(dt, res, stareLimit) {
    const s = this.state
    if (res.inBeam) s.exposure += dt
    else s.exposure = Math.max(0, s.exposure - STARE_RECOVER * dt)
    if (s.exposure > stareLimit) s.sanity = Math.max(0, s.sanity - STARE_SANITY_DRAIN * dt)
    s.stareCharge = Math.min(1, s.exposure / stareLimit)
  }

  _updateFlicker(dt) {
    // Fluorescent hum: a gentle slow ripple + a faint faster buzz; `f` is the tube's
    // own emissive brightness (feeds the panel albedo + selective bloom).
    let f = 0.92 + Math.sin(this._time * 18) * 0.05 + Math.sin(this._time * 43) * 0.02
    this._dipT -= dt
    if (this._dipT <= 0) {
      this._dipActive = 0.12
      this._dipT = 4 + Math.random() * 9
      this.audio.flickerDrop()
    }
    if (this._dipActive > 0) {
      this._dipActive -= dt
      f *= 0.4
    }
    // PANEL_GLOW pushes the tube emissive into HDR (>1) so the tone map rolls
    // the core toward white and the selective bloom halos it — the fixture
    // reads as a light SOURCE instead of blending into the lit ceiling.
    this.materials.panel.uniforms.uIntensity.value = f * PANEL_GLOW
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
    const st = this.state
    const s = st.sanity
    // Stare charge (0..1): ramps the grade as the freeze nears failure.
    const e = Math.min(1, st.exposure / this._stareLimit())
    const g = this.deferred.grade
    g.vignette.value = 0.16 + (1 - s) * 0.5 + e * 0.12
    // NOISE setting: 'always' keeps the constant grain floor, 'danger' fades a
    // slightly stronger floor in with enemy tension (a calm frame is clean),
    // 'off' silences grain entirely — the sanity/stare terms included, so the
    // toggle is a real accessibility escape, not just a floor removal.
    const grainFloor = this._noiseMode === 'always' ? 0.022 : 0.03 * tension
    g.grain.value = this._noiseMode === 'off' ? 0 : grainFloor + (1 - s) * 0.5 + e * 0.18
    g.aberration.value = 0.0012 + (1 - s) * 0.007 + e * 0.006
    g.dead.value = st.deadAmount
  }

  _onResize() {
    this.camera.aspect = innerWidth / innerHeight
    this.camera.updateProjectionMatrix()
    // Re-apply the clamped pixel ratio (x the graphics render scale): browser
    // zoom / moving the window between a HiDPI and a standard monitor changes
    // devicePixelRatio, and a resize event fires for zoom. Without this the
    // buffers stay at the construction-time ratio.
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_DPR) * (this._renderScale ?? 1))
    this.renderer.setSize(innerWidth, innerHeight)
    this.deferred.setSize()
    this.debugMode.resize(innerWidth, innerHeight)
    this.minimap.resize()
  }

  _animate() {
    requestAnimationFrame(this._animate)
    const now = performance.now()
    const dt = Math.min((now - this._last) / 1000, 0.05)
    this._last = now
    this._time += dt
    const p = this.state.phase

    this.debugMode.update(dt)
    const frozen = this.debugMode.active && this.debugMode.freeze

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
        dt * 2.5
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

    this.debugMode.preRender()
    try {
      this.deferred.render(this._time)
    } finally {
      this.debugMode.postRender()
    }
    this.debug.update(dt, { chunks: this.cm.loadedCount })
  }

  dispose() {
    this.debugMode.dispose()
    disposeGBufferMaterials(this.materials)
    disposeGeometries(this.geom)
    this.deferred.dispose()
    this.renderer.dispose()
  }
}
