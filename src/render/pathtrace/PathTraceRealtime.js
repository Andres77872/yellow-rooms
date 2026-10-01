import { PathTraceBlend, traceSize } from './pathTraceBlend.js'
import { DEFAULT_LIGHT_RADIUS, flashPose, flashlightParams, panelLights, selectChunks } from './proxyScene.js'
import { GEOMETRY_RADIUS, REBUILD_DISTANCE, needsRebuild, worldKey } from './realtimePolicy.js'
import { SceneMirror } from './sceneMirror.js'

// Experimental REALTIME path tracing (settings: ADVANCED > EXPERIMENTAL >
// PATH TRACER = REALTIME, off by default). The game keeps running; the
// path tracer replaces the deferred renderer's lighting term.
// docs/pathracer/10-realtime-integration.md has the research behind every
// choice here. Lazy-loaded through LazyPathTraceView, never at boot.
//
// The tracer runs in a WORKER (tracerWorker.js -> tracerHost.js) with its
// own WebGPU device. This page side never blocks on it:
//   - scene: resident chunks cross as plain records (sceneMirror.js); the
//     worker bakes them, builds BVHs and runs setScene, the 60-800 ms of
//     synchronous work that used to freeze the game on every rebuild;
//   - frames: per engine frame,
//       1. DeferredRenderer.render(): after the lighting pass,
//          PathTraceBlend reprojects the newest traced frame (and its own
//          history) into litRT, and snapshots the G-buffer if a slot was
//          reserved;
//       2. afterRender() (here): stream the scene, then dispatch a trace
//          job for the frame just snapshotted: its camera, torch pose and a
//          sample count. The worker traces and reads back; the frame lands
//          a few engine frames later and is accepted by the blend with the
//          camera it was traced from, so the latency never misplaces light.
//
// The worker uses the megakernel backend: one sample for every trace pixel
// costs ~1.5-2 ms on the reference GPU (tracerHost.js), so a moving camera
// gets 1-4 fresh samples per frame. A still camera keeps accumulating, and
// once MAX_SAMPLES are in and nothing changed, tracing stops (the GPU goes
// quiet and the blend holds the converged image).

const MAX_BOUNCES = 3
const MAX_SAMPLES = 512
// Samples per trace job, adapted to the frame interval: additive increase
// after a run of frames on budget, decrease on the first frame over it.
export const MIN_JOB_SAMPLES = 1
export const MAX_JOB_SAMPLES = 4
const GROW_AFTER_FRAMES = 8
// Over-budget slack on the frame interval before the job shrinks.
const BUDGET_SLACK = 1.08
// Trace jobs in flight (each holds a G-buffer snapshot slot).
const MAX_IN_FLIGHT = 2
// Lights follow the eye every LIGHT_REFRESH metres (geometry streaming is in
// realtimePolicy.js).
const LIGHT_REFRESH_DISTANCE = 2
// Chunks within this reach are sent to the worker ahead of the rebuild that
// will need them, one per frame, so it can merge and BVH them in advance.
const PREWARM_RADIUS = GEOMETRY_RADIUS + REBUILD_DISTANCE
const INIT_TIMEOUT_MS = 20_000

const createTracerWorker = () =>
  new Worker(new URL('./tracerWorker.js', import.meta.url), { type: 'module', name: 'path-tracer' })

const _eye = { x: 0, y: 0, z: 0 }

export class PathTraceRealtime {
  constructor(engine, { createWorker = createTracerWorker } = {}) {
    this.engine = engine
    this.blend = new PathTraceBlend()
    this.mirror = new SceneMirror((msg, transfer) => this._post(msg, transfer))
    this.worker = null
    this.adapterInfo = null
    this.backend = ''
    this.onLost = null
    this.samples = MIN_JOB_SAMPLES
    this.stats = {
      rebuilds: 0,
      buildMs: 0,
      setSceneMs: 0,
      lights: 0,
      triangles: 0,
      meshes: 0,
      traceWidth: 0,
      traceHeight: 0,
      jobs: 0,
      frames: 0,
      skipped: 0,
      latencyMs: 0,
      samples: 0,
      converged: false,
    }
    this._createWorker = createWorker
    this._ready = null
    this._initTimer = null
    this._center = { x: Infinity, z: Infinity }
    this._lightCenter = { x: Infinity, z: Infinity }
    this._floor = null
    this._key = ''
    this._chunks = []
    this._sceneId = 0
    this._lastBuildAt = -Infinity
    this._lampPower = -1
    this._lampColor = [-1, -1, -1]
    this._lights = []
    this._flashOn = null
    this._lastCamera = null
    // Bumped by anything that restarts the tracer's accumulation; a frame
    // traced at the current serial with MAX_SAMPLES in is final.
    this._serial = 0
    this._final = { serial: -1, samples: 0 }
    this._lastFrameAt = 0
    this._onBudget = 0
    this._lost = null
    this._disposed = false
  }

  async init() {
    const worker = this._createWorker()
    this.worker = worker
    worker.onmessage = (event) => this._onMessage(event.data)
    worker.onerror = (event) => {
      event?.preventDefault?.()
      this._lose(event?.message || 'Path tracer worker failed')
    }
    worker.onmessageerror = () => this._lose('Path tracer worker message failed')
    const ready = new Promise((resolve, reject) => {
      this._ready = { resolve, reject }
      this._initTimer = setTimeout(() => reject(new Error('WebGPU start timed out')), INIT_TIMEOUT_MS)
    })
    this._post({ type: 'init', settings: { maxBounces: MAX_BOUNCES, maxSamples: MAX_SAMPLES, megakernel: true } })
    try {
      const msg = await ready
      this.adapterInfo = msg.info ?? null
      this.backend = msg.backend ?? ''
    } finally {
      clearTimeout(this._initTimer)
      this._ready = null
    }
    if (this._disposed) return
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
    this._serial++
  }

  // A frame that is not traced (not PLAYING, raster A/B, not ready) must
  // still release the snapshot its render took, or the slot stays pending.
  idle() {
    const captured = this.blend.takeCaptured()
    if (captured) this.blend.cancel(captured.slot)
  }

  get converged() {
    return this._final.serial === this._serial && this._final.samples >= MAX_SAMPLES
  }

  afterRender(now = performance.now()) {
    if (this._disposed || !this.worker || !this.blend.enabled || this._lost) {
      this.idle()
      return
    }
    const e = this.engine
    const d = e.deferred
    const size = traceSize(d.gBuffer.width, d.gBuffer.height)
    if (this.blend.setTraceSize(size.width, size.height)) this._serial++
    this.stats.traceWidth = size.width
    this.stats.traceHeight = size.height

    const captured = this.blend.takeCaptured()
    e.camera.updateMatrixWorld()
    const m = e.camera.matrixWorld.elements
    _eye.x = m[12]
    _eye.y = m[13]
    _eye.z = m[14]
    const rebuilt = this._stream(now)
    this._syncFlashlight()
    if (this._cameraMoved()) this._serial++

    const samples = this._samplesFor(now)
    if (captured) {
      if (this.converged) this.blend.cancel(captured.slot)
      else this._dispatch(captured.slot, samples, size)
    }
    this.stats.converged = this.converged
    if (!this.converged && this.blend.inFlight < MAX_IN_FLIGHT) this.blend.reserve()
    if (!rebuilt) this._prewarm()
  }

  _dispatch(slot, samples, { width, height }) {
    const cam = this.engine.camera
    this._post({
      type: 'trace',
      slot,
      serial: this._serial,
      camera: { m: Array.from(cam.matrixWorld.elements), fov: cam.fov, aspect: cam.aspect, near: cam.near, far: cam.far },
      samples,
      flash: this._flashOn ? flashPose(cam) : null,
      width,
      height,
    })
    this.stats.jobs++
  }

  _cameraMoved() {
    const cam = this.engine.camera
    const m = cam.matrixWorld.elements
    const last = this._lastCamera
    if (last && last.fov === cam.fov && last.aspect === cam.aspect && last.m.every((v, i) => v === m[i])) return false
    this._lastCamera = { m: Array.from(m), fov: cam.fov, aspect: cam.aspect }
    return true
  }

  // Samples for the next job. A job's GPU cost lands on the frame interval,
  // which must stay inside the engine's own frame budget (the frame limit,
  // at most 60 fps): one sample less on the first frame over it, one more
  // after a run of frames inside it.
  _samplesFor(now) {
    const interval = now - this._lastFrameAt
    this._lastFrameAt = now
    if (interval > 0 && interval < 250) {
      const fps = Math.min(60, this.engine._drsTargetFps?.() ?? 60)
      if (interval > (1000 / fps) * BUDGET_SLACK) {
        this.samples = Math.max(MIN_JOB_SAMPLES, this.samples - 1)
        this._onBudget = 0
      } else if (++this._onBudget >= GROW_AFTER_FRAMES) {
        this.samples = Math.min(MAX_JOB_SAMPLES, this.samples + 1)
        this._onBudget = 0
      }
    }
    this.stats.samplesPerJob = this.samples
    return this.samples
  }

  _stream(now) {
    const e = this.engine
    const floor = e.controller?.floor ?? 0
    const key = worldKey(e.state)
    const chunks = [...e.cm.chunks.values()]
    const hasScene = this._sceneId > 0
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
    const c = lu.uLampColor.value
    const lampChanged =
      lu.uLampIntensity.value !== this._lampPower ||
      c.r !== this._lampColor[0] ||
      c.g !== this._lampColor[1] ||
      c.b !== this._lampColor[2]
    if (lampChanged || Math.hypot(_eye.x - this._lightCenter.x, _eye.z - this._lightCenter.z) > LIGHT_REFRESH_DISTANCE) {
      this._lights = this._panelLights(floor, this._chunks)
      this._post({ type: 'lights', lights: this._lights, flashlight: this._flashlight() })
      this._lightCenter.x = _eye.x
      this._lightCenter.z = _eye.z
      this._serial++
    }
    return false
  }

  _panelLights(floor, chunks) {
    const e = this.engine
    const lu = e.deferred.lightUniforms
    this._lampPower = lu.uLampIntensity.value
    const c = lu.uLampColor.value
    this._lampColor = [c.r, c.g, c.b]
    const { lights } = panelLights({
      eye: _eye,
      floor,
      chunks,
      // The engine's own cross-floor spill policy picks the candidates.
      lamps: e.cm.collectLampsNear?.(_eye.x, _eye.z, [], floor, DEFAULT_LIGHT_RADIUS) ?? null,
      lampColor: c,
      lampPower: lu.uLampIntensity.value,
    })
    this.stats.lights = lights.length
    return lights
  }

  _flashlight() {
    const e = this.engine
    const lu = e.deferred.lightUniforms
    this._flashOn = !!e.state.flashlightOn
    return {
      ...flashlightParams({
        color: lu.uFlashColor.value,
        intensity: lu.uFlashIntensity.value,
        range: lu.uFlashRange.value,
        cosInner: lu.uFlashCosInner.value,
        cosOuter: lu.uFlashCosOuter.value,
      }),
      on: this._flashOn,
    }
  }

  _rebuild(chunks, floor, key, now) {
    const t0 = performance.now()
    const selected = selectChunks(chunks, _eye.x, _eye.z, floor, GEOMETRY_RADIUS)
    const keys = this.mirror.sceneChunks(selected)
    // After the chunks: they register the materials the sync describes.
    this.mirror.syncMaterials(this.engine.materials.panel)
    this._lights = this._panelLights(floor, selected)
    this._post({ type: 'scene', id: ++this._sceneId, chunks: keys, lights: this._lights, flashlight: this._flashlight() })
    if (key !== this._key) this.blend.resetHistory()
    this._key = key
    this._floor = floor
    this._center.x = this._lightCenter.x = _eye.x
    this._center.z = this._lightCenter.z = _eye.z
    this._chunks = selected
    this._lastBuildAt = now
    this._serial++
    this.stats.rebuilds++
    this.stats.exportMs = performance.now() - t0
  }

  _syncFlashlight() {
    const on = !!this.engine.state.flashlightOn
    if (this._sceneId === 0 || on === this._flashOn) return
    this._post({ type: 'lights', lights: this._lights, flashlight: this._flashlight() })
    this._serial++
  }

  // Send one chunk the next rebuild will select, if the worker lacks it.
  _prewarm() {
    const chunks = selectChunks(this.engine.cm.chunks.values(), _eye.x, _eye.z, this._floor ?? 0, PREWARM_RADIUS)
    for (const chunk of chunks) {
      if (this.mirror.holds(chunk)) continue
      this.mirror.ensureChunk(chunk)
      return
    }
  }

  _onMessage(msg) {
    if (this._disposed) return
    switch (msg.type) {
      case 'ready':
        this._ready?.resolve(msg)
        break
      case 'frame': {
        this.stats.frames++
        this.stats.latencyMs = msg.ms
        this.stats.samples = msg.samples
        if (msg.serial >= this._final.serial) this._final = { serial: msg.serial, samples: msg.samples }
        this.blend.accept(msg.slot, msg.data, msg.width, msg.height, { continued: msg.continued, samples: msg.samples })
        break
      }
      case 'skipped':
        this.stats.skipped++
        this.blend.cancel(msg.slot)
        break
      case 'scene': {
        const s = this.stats
        s.buildMs = msg.buildMs
        s.setSceneMs = msg.setSceneMs
        s.triangles = msg.triangles
        s.meshes = msg.meshes
        break
      }
      case 'error':
        if (this._ready) this._ready.reject(new Error(msg.message))
        else this._lose(msg.message)
        break
    }
  }

  _post(msg, transfer = []) {
    if (this._disposed || !this.worker) return
    this.worker.postMessage(msg, transfer)
  }

  _lose(message) {
    if (this._disposed || this._lost) return
    this._lost = message
    if (this._ready) this._ready.reject(new Error(message))
    else this.onLost?.(message)
  }

  dispose() {
    if (this._disposed) return
    this._post({ type: 'dispose' })
    this._disposed = true
    clearTimeout(this._initTimer)
    const d = this.engine.deferred
    if (d?.pathTraceHook === this.blend) d.setPathTraceHook(null)
    this.blend.dispose()
    // Terminating the worker releases its WebGPU device with it.
    this.worker?.terminate()
    this.worker = null
  }
}
