import * as THREE from 'three/webgpu'
import { WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu'
import { MeshBVH, SAH } from 'three-mesh-bvh'
import {
  DEFAULT_LIGHT_RADIUS,
  ProxySceneBuilder,
  REALTIME_SKIPPED_PARTS,
  aimFlashlight,
  selectChunks,
} from './proxyScene.js'
import { PathTraceBlend, traceSize } from './pathTraceBlend.js'
import { GEOMETRY_RADIUS, REBUILD_DISTANCE, needsRebuild, worldKey } from './realtimePolicy.js'
import { createTracerRenderer, disposeRenderer, disposeTracer } from './webgpuContext.js'

// Experimental REALTIME path tracing (settings: ADVANCED > EXPERIMENTAL >
// PATH TRACER = REALTIME, off by default). The game keeps running; the
// path tracer replaces the deferred renderer's lighting term every frame.
// docs/pathracer/10-realtime-integration.md has the research behind every
// choice here. Lazy-loaded through LazyPathTraceView, never at boot.
//
// Per engine frame (Engine._animate):
//   1. DeferredRenderer.render(): after the lighting pass, PathTraceBlend
//      reprojects the newest traced frame (and its own history) into litRT,
//      and snapshots the G-buffer if a dispatch slot was reserved.
//   2. afterRender() (here): stream the proxy scene, sync camera, lights and
//      torch, run an adaptive number of tracer steps, and read the output
//      back for the frame just snapshotted. The readback lands a frame or
//      two later and is accepted by the blend with the camera it was traced
//      from, so the latency never misplaces light.
//
// The tracer resets on every camera move, so a moving view gets ~1-3 fresh
// samples per frame at trace resolution; the blend's reprojected history
// averages them, and a still camera converges (the tracer keeps
// accumulating and the blend follows it).

// Short paths: the first bounces carry nearly all indirect light in these
// low-albedo rooms, and path length is what one frame's steps must cover.
const MAX_BOUNCES = 3
// A still camera stops accumulating here (converged; the GPU goes quiet).
const MAX_SAMPLES = 512
// Pool cap (see PathTraceView): every trace pixel gets a path slot.
const FRAME_BUDGET = 1 << 20
// renderSample() calls per frame: each advances every path one segment, so
// MIN covers a camera ray plus the bounces; the rest is adaptive.
const MIN_STEPS = MAX_BOUNCES + 2
const MAX_STEPS = 16
const TARGET_FRAME_MS = 18
// Readbacks in flight (each holds a G-buffer snapshot slot).
const MAX_IN_FLIGHT = 2
// Lights follow the eye every LIGHT_REFRESH metres (geometry streaming is in
// realtimePolicy.js).
const LIGHT_REFRESH_DISTANCE = 2
// Per-frame budget for merging and BVH-building the chunks the next rebuild
// will need (ProxySceneBuilder.prewarm), and how far ahead that looks.
const PREWARM_BUDGET_MS = 3
const PREWARM_RADIUS = GEOMETRY_RADIUS + REBUILD_DISTANCE
// The same bottom-level BVH the tracer's setScene would build itself.
const buildBVH = (geometry) => {
  geometry.boundsTree = new MeshBVH(geometry, { strategy: SAH, targetLeafSize: 5 })
}

const _eye = new THREE.Vector3()

export class PathTraceRealtime {
  constructor(engine) {
    this.engine = engine
    this.blend = new PathTraceBlend()
    this.builder = new ProxySceneBuilder({ merged: true, skipParts: REALTIME_SKIPPED_PARTS })
    this.renderer = null
    this.tracer = null
    this.camera = new THREE.PerspectiveCamera()
    this.scene = null
    this.adapterInfo = null
    this.onLost = null
    this.steps = MIN_STEPS
    this.stats = {
      rebuilds: 0,
      lastRebuildMs: 0,
      lights: 0,
      triangles: 0,
      meshes: 0,
      traceWidth: 0,
      traceHeight: 0,
    }
    this._spot = null
    this._flashOn = null
    this._center = new THREE.Vector3(Infinity, 0, Infinity)
    this._lightCenter = new THREE.Vector3(Infinity, 0, Infinity)
    this._floor = null
    this._key = ''
    this._chunks = []
    this._lastBuildAt = -Infinity
    this._lampPower = -1
    this._lampColor = new THREE.Color(-1, -1, -1)
    this._lastCamera = new THREE.Matrix4()
    this._lastAspect = 0
    this._resetSinceReadback = true
    this._lastFrameAt = 0
    this._disposed = false
  }

  async init() {
    const { renderer, info } = await createTracerRenderer({ onLost: (message) => this._lose(message) })
    this.adapterInfo = info
    this.renderer = renderer
    // The canvas is never shown: the output is read back into WebGL. The
    // tracer still blits into it every call, sized to the trace resolution.
    const tracer = new WebGPUPathTracer(renderer)
    tracer.maxBounces = MAX_BOUNCES
    tracer.maxSamples = MAX_SAMPLES
    tracer.frameBudget = FRAME_BUDGET
    // No low-res preview, delay or fade: every frame is read as it is.
    tracer.dynamicLowRes = false
    tracer.renderDelay = 0
    tracer.minSamples = 0
    tracer.fadeDuration = 0
    // Fresh noise after every reset, so the blend's temporal history
    // averages independent samples instead of one frozen pattern.
    tracer.stableNoise = false
    // A few samples per pixel cannot average out fireflies; clamp indirect
    // radiance harder than the default (10), trading a little energy.
    tracer.clampIndirect = 3
    tracer.renderScale = 1
    this.tracer = tracer
    this.engine.deferred.setPathTraceHook(this.blend)
  }

  get enabled() {
    return this.blend.enabled
  }

  // Raster <-> path-traced lighting (the P key's A/B). Off also stops
  // tracing; back on starts from a clean history.
  setEnabled(on) {
    if (this.blend.enabled === !!on) return
    this.blend.enabled = !!on
    this.blend.resetHistory()
    this._resetSinceReadback = true
  }

  // A frame that is not traced (not PLAYING, raster A/B, not ready) must
  // still release the snapshot its render took, or the slot stays pending.
  idle() {
    const captured = this.blend.takeCaptured()
    if (captured) this.blend.cancel(captured.slot)
  }

  afterRender(now = performance.now()) {
    if (this._disposed || !this.tracer || !this.blend.enabled) {
      this.idle()
      return
    }
    const d = this.engine.deferred
    const size = traceSize(d.gBuffer.width, d.gBuffer.height)
    if (this.blend.setTraceSize(size.width, size.height)) {
      this.renderer.setSize(size.width, size.height, false)
      this._resetSinceReadback = true
    }
    this.stats.traceWidth = size.width
    this.stats.traceHeight = size.height

    const captured = this.blend.takeCaptured()
    const rebuilt = this._stream(now)
    if (this._syncCamera()) {
      if (this._spot) aimFlashlight(this._spot, this.engine.camera)
      if (this._flashOn) this.tracer.updateLights()
      this.tracer.updateCamera()
      this._resetSinceReadback = true
    }
    this._syncFlashlight()

    const steps = this._stepsFor(now)
    for (let i = 0; i < steps; i++) this.tracer.renderSample()
    if (captured) this._readback(captured.slot, size)
    if (this.blend.inFlight < MAX_IN_FLIGHT) this.blend.reserve()
    if (!rebuilt) {
      this.builder.prewarm(this.engine.cm.chunks.values(), {
        x: _eye.x,
        z: _eye.z,
        floor: this._floor,
        radius: PREWARM_RADIUS,
        budgetMs: PREWARM_BUDGET_MS,
        buildBVH,
      })
    }
  }

  _stream(now) {
    const e = this.engine
    const floor = e.controller?.floor ?? 0
    _eye.setFromMatrixPosition(e.camera.matrixWorld)
    const key = worldKey(e.state)
    const chunks = [...e.cm.chunks.values()]
    const hasScene = !!this.scene
    const selected = hasScene ? selectChunks(chunks, this._center.x, this._center.z, this._floor, GEOMETRY_RADIUS) : null
    const sameChunks =
      !!selected && selected.length === this._chunks.length && selected.every((c, i) => c === this._chunks[i])
    if (
      needsRebuild({
        hasScene,
        key,
        sceneKey: this._key,
        floor,
        sceneFloor: this._floor,
        eye: _eye,
        center: this._center,
        sameChunks,
        now,
        lastBuildAt: this._lastBuildAt,
      })
    ) {
      this._rebuild(chunks, floor, key, now)
      return true
    }
    const lu = e.deferred.lightUniforms
    const lampChanged = lu.uLampIntensity.value !== this._lampPower || !lu.uLampColor.value.equals(this._lampColor)
    if (lampChanged || _eye.distanceTo(this._lightCenter) > LIGHT_REFRESH_DISTANCE) {
      const lit = this.builder.setLights(this.scene, { ...this._lightOptions(floor), chunks: this._chunks })
      this.stats.lights = lit.lights
      this.tracer.updateLights()
      this._lightCenter.copy(_eye)
      this._resetSinceReadback = true
    }
    return false
  }

  _lightOptions(floor) {
    const e = this.engine
    const lu = e.deferred.lightUniforms
    this._lampPower = lu.uLampIntensity.value
    this._lampColor.copy(lu.uLampColor.value)
    return {
      camera: e.camera,
      floor,
      // The engine's own cross-floor spill policy picks the candidates.
      lamps: e.cm.collectLampsNear?.(_eye.x, _eye.z, [], floor, DEFAULT_LIGHT_RADIUS) ?? null,
      lampColor: lu.uLampColor.value,
      lampPower: lu.uLampIntensity.value,
    }
  }

  _rebuild(chunks, floor, key, now) {
    const e = this.engine
    const t0 = performance.now()
    const lu = e.deferred.lightUniforms
    const { scene, stats, flashlight } = this.builder.build({
      chunks,
      camera: e.camera,
      floor,
      center: _eye,
      geometryRadius: GEOMETRY_RADIUS,
      panelMaterial: e.materials.panel,
      flashlight: {
        color: lu.uFlashColor.value,
        intensity: lu.uFlashIntensity.value,
        range: lu.uFlashRange.value,
        cosInner: lu.uFlashCosInner.value,
        cosOuter: lu.uFlashCosOuter.value,
      },
      ...this._lightOptions(floor),
    })
    // The torch stays in the scene; visibility is how it switches (the
    // tracer only collects visible lights, so an off torch costs nothing).
    flashlight.visible = !!e.state.flashlightOn
    this._flashOn = flashlight.visible
    this._spot = flashlight
    this._syncCamera(true)
    const t1 = performance.now()
    this.tracer.setScene(scene, this.camera)
    this.stats.buildMs = t1 - t0
    this.stats.setSceneMs = performance.now() - t1
    this.scene = scene
    if (key !== this._key) this.blend.resetHistory()
    this._key = key
    this._floor = floor
    this._center.copy(_eye)
    this._lightCenter.copy(_eye)
    this._chunks = selectChunks(chunks, _eye.x, _eye.z, floor, GEOMETRY_RADIUS)
    this._lastBuildAt = now
    this._resetSinceReadback = true
    const s = this.stats
    s.rebuilds++
    s.lastRebuildMs = performance.now() - t0
    s.lights = stats.lights
    s.triangles = stats.triangles
    s.meshes = stats.meshes
    s.mergedChunks = stats.mergedChunks
  }

  _syncFlashlight() {
    const on = !!this.engine.state.flashlightOn
    if (!this._spot || on === this._flashOn) return
    this._spot.visible = on
    this._flashOn = on
    if (on) aimFlashlight(this._spot, this.engine.camera)
    this.tracer.updateLights()
    this._resetSinceReadback = true
  }

  // Copy the player camera into the tracer's own camera (the tracer switches
  // the camera it is given to WebGPU clip space). Returns whether it moved.
  _syncCamera(force = false) {
    const src = this.engine.camera
    src.updateMatrixWorld()
    if (!force && src.aspect === this._lastAspect && this._lastCamera.equals(src.matrixWorld)) return false
    this._lastCamera.copy(src.matrixWorld)
    this._lastAspect = src.aspect
    const cam = this.camera
    cam.fov = src.fov
    cam.aspect = src.aspect
    cam.near = src.near
    cam.far = src.far
    src.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
    return true
  }

  // Additive increase while frames arrive on cadence, multiplicative
  // decrease when the GPU backlog stretches them; never below MIN_STEPS.
  _stepsFor(now) {
    const interval = now - this._lastFrameAt
    this._lastFrameAt = now
    if (interval > 0 && interval < 250) {
      if (interval > TARGET_FRAME_MS) this.steps = Math.max(MIN_STEPS, Math.floor(this.steps * 0.75))
      else this.steps = Math.min(MAX_STEPS, this.steps + 1)
    }
    return this.steps
  }

  _readback(slot, { width, height }) {
    const continued = !this._resetSinceReadback
    this._resetSinceReadback = false
    const target = this.tracer.target
    this.renderer.backend
      .copyTextureToBuffer(target, 0, 0, width, height, 0)
      .then((data) => {
        if (this._disposed) return
        this.blend.accept(slot, data, width, height, { continued })
      })
      .catch(() => {
        if (!this._disposed) this.blend.cancel(slot)
      })
  }

  _lose(message) {
    if (this._disposed || this._lost) return
    this._lost = message
    this.onLost?.(message)
  }

  dispose() {
    if (this._disposed) return
    this._disposed = true
    const d = this.engine.deferred
    if (d?.pathTraceHook === this.blend) d.setPathTraceHook(null)
    this.blend.dispose()
    disposeTracer(this.tracer)
    this.tracer = null
    this.builder.dispose()
    disposeRenderer(this.renderer)
    this.renderer = null
  }
}
