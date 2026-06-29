import * as THREE from 'three'
import {
  FOV,
  NEAR,
  FAR,
  FOG_COLOR,
  EYE_H,
  CHUNK,
  CELL,
  CHUNK_WORLD,
  PROXIMITY_SLOW_RADIUS,
  PROXIMITY_SLOW_MAX,
  STARE_LIMIT_BASE,
  STARE_SANITY_DRAIN,
  STARE_RECOVER,
  STALKER_AMBIENT,
} from '../world/constants.js'
import { createGBufferMaterials, disposeGBufferMaterials } from '../render/gbufferMaterials.js'
import { createGeometries, disposeGeometries } from '../render/geometries.js'
import { ChunkManager } from '../world/ChunkManager.js'
import { Controller } from '../player/Controller.js'
import { AudioBus } from '../audio/AudioBus.js'
import { Stalker } from '../entities/Stalker.js'
import { Pursuer } from '../entities/Pursuer.js'
import { mergeEnemy } from './enemyMerge.js'
import { DeferredRenderer } from '../render/DeferredRenderer.js'
import { LightField } from '../render/LightField.js'
import { GameState, Phase } from './GameState.js'
import { Settings } from './Settings.js'
import { DebugOverlay } from './DebugOverlay.js'
import { DebugMode } from '../debug/DebugMode.js'
import { UI } from '../ui/overlays.js'
import { Minimap } from '../ui/Minimap.js'
import { ExploredMap } from '../world/ExploredMap.js'
import { hashStr } from '../world/core/hash.js'
import { RNG } from '../world/core/rng.js'

const HUBC = (CHUNK / 2) | 0
const SPAWN = (HUBC + 0.5) * CELL
const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a))

export class Engine {
  constructor(app) {
    this.settings = new Settings()
    this.state = new GameState()

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
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
    this.explored = new ExploredMap(this.cm) // player-seen fog state for the minimap
    this.controller = new Controller(camera, renderer.domElement, this.state)
    this.controller.sensitivity = this.settings.get('sensitivity')
    this.controller.setBobEnabled(this.settings.get('bob'))
    this.controller.flashlight = null // handled in the lighting pass, not a real light

    this.audio = new AudioBus(camera)
    this.audio.setVolume(this.settings.get('volume'))
    this.stalker = new Stalker(scene, this.materials, this.geom, this.cm)
    this.pursuer = new Pursuer(scene, this.materials, this.geom, this.cm)

    this.deferred = new DeferredRenderer(renderer, scene, camera)
    this.deferred.setOutline(this.settings.get('outline'))
    this.lightField = new LightField(
      this.deferred.lamps.uLampPos,
      this.deferred.lamps.uLampCount
    )

    this.debug = new DebugOverlay(renderer)
    this.ui = new UI(this.settings)
    this._wireUI()

    this.minimap = new Minimap(this.ui.el.minimap)
    this.minimap.setVisible(this.settings.get('minimap'))
    // M toggles the minimap in-game and stays in sync with the pause checkbox.
    addEventListener('keydown', (e) => {
      if (e.code !== 'KeyM' || this.state.phase !== Phase.PLAYING) return
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return
      const v = !this.settings.get('minimap')
      this._applySetting('minimap', v)
      this.ui.el.map.checked = v
    })

    this.debugMode = new DebugMode(this) // inert until F2; visualizes gen/lighting/AI

    this.controller.onStep = (spd) => this.audio.footstep(spd)
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
    this.cm.update(SPAWN, SPAWN) // seed the title backdrop
    this._animate = this._animate.bind(this)
  }

  _wireUI() {
    this.ui.onStart = (seed) => this.startRun(seed)
    this.ui.onResume = () => this.resume()
    this.ui.onRestart = () => this.startRun(this.state.seedText)
    this.ui.onSetting = (k, v) => this._applySetting(k, v)
  }

  _applySetting(k, v) {
    this.settings.set(k, v)
    if (k === 'sensitivity') this.controller.sensitivity = v
    else if (k === 'volume') this.audio.setVolume(v)
    else if (k === 'bob') this.controller.setBobEnabled(v)
    else if (k === 'outline') this.deferred.setOutline(v)
    else if (k === 'minimap') this.minimap.setVisible(v)
  }

  start() {
    const urlSeed = new URLSearchParams(location.search).get('seed')
    if (urlSeed) this.ui.setSeedInput(urlSeed)
    this.ui.showTitle()
    requestAnimationFrame(this._animate)
  }

  startRun(seedText) {
    seedText = (seedText || '').trim() || Math.random().toString(36).slice(2, 8)
    this.state.seedText = seedText
    this.state.level = 1
    this.state.resetLevel()
    this.ui.setSeedInput(seedText)
    try {
      history.replaceState(null, '', `?seed=${encodeURIComponent(seedText)}`)
    } catch {
      /* ignore */
    }
    this._setupLevel()
    this.audio.start()
    this.state.phase = Phase.PLAYING
    this.ui.showHud()
    this.controller.lock()
  }

  resume() {
    this.state.phase = Phase.PLAYING
    this.ui.showHud()
    this.controller.lock()
  }

  _setupLevel() {
    const { state, cm } = this
    const lvl = state.level
    cm.setSeed(hashStr(`${state.seedText}#${lvl}`))

    // Exit: a reproducible spot several chunks from spawn.
    const r = RNG.fromString(`${state.seedText}#${lvl}#exit`)
    const dist = r.int(6, 11)
    const ang = r.next() * Math.PI * 2
    let ecx = Math.round(Math.cos(ang) * dist)
    let ecz = Math.round(Math.sin(ang) * dist)
    if (Math.abs(ecx) < 2 && Math.abs(ecz) < 2) ecx += 5
    const elx = r.int(3, CHUNK - 4)
    const elz = r.int(3, CHUNK - 4)
    cm.setExit(ecx, ecz, elx, elz)
    this.exitTarget.set(
      ecx * CHUNK_WORLD + (elx + 0.5) * CELL,
      1.35,
      ecz * CHUNK_WORLD + (elz + 0.5) * CELL
    )

    cm.reset()
    this.explored.reset() // fresh fog per level/seed (cm.seed/exit/clearings are set above)
    const yaw = Math.atan2(-(this.exitTarget.x - SPAWN), -(this.exitTarget.z - SPAWN))
    this.controller.teleport(SPAWN, SPAWN, yaw)
    this.stalker.reset(lvl, this.controller.pos)
    this.pursuer.reset(lvl, this.controller.pos)
    cm.update(SPAWN, SPAWN)
    this.lightField.reset()
  }

  _onLock(locked) {
    if (this.debugMode?.active) return // debug owns the cursor; don't auto-pause
    // Pause on pointer-lock loss during PLAYING *or* TRANSITION. Without the
    // TRANSITION case, losing the lock mid-transition (Esc / alt-tab) leaves the
    // next level in PLAYING with the pointer unlocked and mouse-look dead, with no
    // in-game way to re-lock. Pausing lets the Resume button re-lock via a gesture.
    if (!locked && (this.state.phase === Phase.PLAYING || this.state.phase === Phase.TRANSITION)) {
      this.state.phase = Phase.PAUSED
      this.ui.showPause()
    }
  }

  die(reason) {
    if (this.state.phase !== Phase.PLAYING) return
    this.state.phase = Phase.DEAD
    this.state.deathReason = reason
    this.audio.setTension(0)
    this.controller.unlock()
    this.ui.showDeath(reason)
  }

  _levelComplete() {
    if (this.state.phase !== Phase.PLAYING) return
    this.state.phase = Phase.TRANSITION
    this.audio.setTension(0)
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
    cm.update(controller.pos.x, controller.pos.z)
    // Track explored area ALWAYS (the toggle gates only drawing); skip while
    // debug mode parks/teleports the player so it can't pollute the real map.
    if (!this.debugMode.active) this.explored.update(controller.pos.x, controller.pos.z)
    this.lightField.update(dt, controller.pos.x, controller.pos.z, cm)
    this.deferred.lightUniforms.uFlashOn.value = state.flashlightOn ? 1 : 0

    // The flashlight freezes the entity, but only until the player has stared
    // too long (exposure past the level-scaled limit) — then the freeze fails.
    const stareLimit = this._stareLimit()
    const ctx = { flashlightOn: state.flashlightOn, canFreeze: state.exposure < stareLimit }
    const res = stalker.update(dt, controller.pos, this.camera, ctx)
    const res2 = this.pursuer.update(dt, controller.pos, this.camera, ctx)
    // Combine both threats: closest drives proximity-slow, either-seen stresses
    // sanity, tension is the max. Beam/stare stay Stalker-only (pass it first).
    const merged = mergeEnemy(res, res2)
    this._updateProximity(merged)
    this._updateStare(dt, res, stareLimit) // beam/exposure is the Stalker's alone
    audio.setTension(merged.tension)
    // Fluorescent hum follows the lights: silent in the dark, swelling as the
    // player nears a lit lamp. Remap lightAt's 0.1..1 to a clean 0..1.
    const lightHere = cm.lightAt(controller.pos.x, controller.pos.z)
    audio.setHumProximity(
      Math.min(1, Math.max(0, (lightHere - STALKER_AMBIENT) / (1 - STALKER_AMBIENT)))
    )
    this._updateSanity(dt, merged)
    this._updateFlicker(dt)
    audio.update(dt)
    this._updateExit()
    this.ui.updateHud(state, this.exitInfo)
    if (this.minimap.visible) {
      const e = cm.exit
      const exitRevealed =
        !!e && this.explored.isRevealed(e.cx * CHUNK + e.lx, e.cz * CHUNK + e.lz)
      this.minimap.update({ controller, exit: e, exitRevealed, store: this.explored })
    }
    this._applyFX()

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
    let f = 0.9 + Math.sin(this._time * 22) * 0.05
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
    this.materials.panel.uniforms.uIntensity.value = f
  }

  _updateExit() {
    const p = this.controller.pos
    const dx = this.exitTarget.x - p.x
    const dz = this.exitTarget.z - p.z
    const dist = Math.hypot(dx, dz)
    const fAng = Math.atan2(-Math.sin(this.controller.yaw), -Math.cos(this.controller.yaw))
    const eAng = Math.atan2(dx, dz)
    this.exitInfo = { dist, relAngle: norm(eAng - fAng) }
    if (dist < 1.8) this._levelComplete()
  }

  _applyFX() {
    const st = this.state
    const s = st.sanity
    // Stare charge (0..1): ramps the grade as the freeze nears failure.
    const e = Math.min(1, st.exposure / this._stareLimit())
    const g = this.deferred.grade
    g.vignette.value = 0.16 + (1 - s) * 0.5 + e * 0.12
    g.grain.value = 0.022 + (1 - s) * 0.5 + e * 0.18
    g.aberration.value = 0.0012 + (1 - s) * 0.007 + e * 0.006
    g.dead.value = st.deadAmount
  }

  _onResize() {
    this.camera.aspect = innerWidth / innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(innerWidth, innerHeight)
    this.deferred.setSize(innerWidth, innerHeight)
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
      this._updateCameraMatrices()
    } else if (p === Phase.TRANSITION) {
      this.deferred.grade.dead.value = THREE.MathUtils.lerp(
        this.deferred.grade.dead.value,
        0.55,
        dt * 2.5
      )
      this._transT -= dt
      this._updateCameraMatrices()
      if (this._transT <= 0) this._advance()
    } else {
      // TITLE / PAUSED: keep the world rendering behind the overlay.
      if (p === Phase.TITLE) {
        this._titleYaw += dt * 0.06
        this.camera.position.set(SPAWN, EYE_H, SPAWN)
        this.camera.rotation.set(0, this._titleYaw, 0, 'YXZ')
        this.cm.update(SPAWN, SPAWN)
        this.lightField.update(dt, SPAWN, SPAWN, this.cm)
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
