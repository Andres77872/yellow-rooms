import * as THREE from 'three/webgpu'
import { WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu'
import { DEFAULT_LIGHT_RADIUS, ProxySceneBuilder, aimFlashlight } from './proxyScene.js'
import { createTracerRenderer, disposeRenderer, disposeTracer } from './webgpuContext.js'

// Experimental path-traced view (settings: ADVANCED > EXPERIMENTAL, off by
// default). Loaded only through LazyPathTraceView, never at boot.
//
// three-gpu-pathtracer 0.0.25's WebGPUPathTracer needs WebGPURenderer and
// compute shaders, so it runs in its OWN WebGPU context on a second canvas
// laid over the WebGL2 one. The deferred renderer is not migrated: nothing
// is shared between the two contexts except the CPU-side scene proxies
// (proxyScene.js). While the view is open the Engine freezes the world and
// skips the deferred frame; mouse look still turns the camera, and every
// turn restarts accumulation.
//
// Output is the tracer's own ACES tone map at the deferred frame's base
// exposure: comparable brightness, not the engine's grade or look.

// Accumulation stops here; the image is converged well before on a desktop
// GPU and the GPU should go quiet after that.
const MAX_SAMPLES = 2048
const MAX_BOUNCES = 6
// How often the sample counter is read back (it is an async GPU readback).
const COUNT_INTERVAL_MS = 500
// The wavefront backend advances every live path by ONE segment per
// renderSample(), over at most frameBudget path slots (default 250k; the
// tracer caps its pool at 128 MB of path records, ~600k). A 1080p sample
// therefore takes (pixels / slots) x path length calls. Ask for the pool
// cap, then issue as many calls per frame as keep the display cadence:
// while the view is open the world is frozen and the GPU is the tracer's.
const FRAME_BUDGET = 1 << 20
const MAX_STEPS_PER_FRAME = 24
const TARGET_FRAME_MS = 1000 / 50

export class PathTraceView {
  constructor(engine) {
    this.engine = engine
    this.builder = new ProxySceneBuilder()
    this.renderer = null
    this.tracer = null
    this.camera = new THREE.PerspectiveCamera()
    this.stats = null
    this.samples = 0
    this.samplesPerSecond = 0
    this.adapterInfo = null
    this.onLost = null
    this._flashlight = null
    this._lastCamera = new THREE.Matrix4()
    this._lastAspect = 0
    this._counting = false
    this._nextCountAt = 0
    this.steps = 1
    this._lastFrameAt = 0
    this._disposed = false
  }

  async init() {
    const { renderer, info } = await createTracerRenderer({ onLost: (message) => this._lose(message) })
    this.adapterInfo = info
    this.renderer = renderer
    renderer.setSize(innerWidth, innerHeight)
    renderer.toneMapping = THREE.ACESFilmicToneMapping

    const el = renderer.domElement
    el.dataset.pathTracer = ''
    Object.assign(el.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '1',
      display: 'none',
      pointerEvents: 'none',
    })
    // Directly above the WebGL canvas, below the #ui layer (z-index 20).
    const glCanvas = this.engine.renderer?.domElement
    if (glCanvas?.after) glCanvas.after(el)
    else document.body.appendChild(el)

    const tracer = new WebGPUPathTracer(renderer)
    tracer.maxBounces = MAX_BOUNCES
    tracer.maxSamples = MAX_SAMPLES
    tracer.frameBudget = FRAME_BUDGET
    tracer.minSamples = 1
    tracer.renderDelay = 0
    tracer.fadeDuration = 250
    tracer.lowResScale = 0.25
    tracer.stableNoise = true
    this.tracer = tracer
  }

  // Snapshot the world around the player and start accumulating.
  open() {
    const e = this.engine
    const lu = e.deferred.lightUniforms
    this._syncCamera(true)
    const flashlight = e.state.flashlightOn
      ? {
          color: lu.uFlashColor.value,
          intensity: lu.uFlashIntensity.value,
          range: lu.uFlashRange.value,
          cosInner: lu.uFlashCosInner.value,
          cosOuter: lu.uFlashCosOuter.value,
        }
      : null
    const floor = e.controller?.floor ?? 0
    const eye = new THREE.Vector3().setFromMatrixPosition(e.camera.matrixWorld)
    const { scene, stats, flashlight: spot } = this.builder.build({
      chunks: e.cm.chunks.values(),
      camera: e.camera,
      floor,
      // The engine's own cross-floor spill policy picks the candidates.
      lamps: e.cm.collectLampsNear?.(eye.x, eye.z, [], floor, DEFAULT_LIGHT_RADIUS) ?? null,
      panelMaterial: e.materials.panel,
      lampColor: lu.uLampColor.value,
      lampPower: lu.uLampIntensity.value,
      flashlight,
    })
    this.stats = stats
    this._flashlight = spot
    this.renderer.toneMappingExposure = e.deferred.gradeUniforms?.exposure?.value ?? 1
    this.tracer.pause = false
    this.tracer.setScene(scene, this.camera)
    this.samples = 0
    this.samplesPerSecond = 0
    this.steps = 1
    this._lastFrameAt = 0
    this.renderer.domElement.style.display = 'block'
  }

  close() {
    if (this.tracer) this.tracer.pause = true
    if (this.renderer) this.renderer.domElement.style.display = 'none'
    this._flashlight = null
  }

  // Tracer steps for one engine frame (see FRAME_BUDGET).
  render(now = performance.now()) {
    if (this._disposed || !this.tracer) return
    if (this._syncCamera(false)) {
      if (this._flashlight) {
        aimFlashlight(this._flashlight, this.engine.camera)
        this.tracer.updateLights()
      }
      this.tracer.updateCamera()
      this.samples = 0
    }
    const steps = this._stepsFor(now)
    for (let i = 0; i < steps; i++) this.tracer.renderSample()
    if (!this._counting && now >= this._nextCountAt) this._count(now)
  }

  // Additive increase while frames arrive on cadence, multiplicative decrease
  // when the GPU backlog stretches them; a camera turn stays responsive.
  _stepsFor(now) {
    const interval = now - this._lastFrameAt
    this._lastFrameAt = now
    if (interval > 0 && interval < 250) {
      if (interval > TARGET_FRAME_MS) this.steps = Math.max(1, Math.floor(this.steps * 0.7))
      else this.steps = Math.min(MAX_STEPS_PER_FRAME, this.steps + 1)
    }
    return this.steps
  }

  resize(w, h) {
    this.renderer?.setSize(w, h)
  }

  // Copy the player camera into the tracer's own camera. The tracer switches
  // the camera it is given to WebGPU clip space, so it must never touch the
  // WebGL camera itself. Returns whether the view changed.
  _syncCamera(force) {
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

  _count(now) {
    this._counting = true
    this._nextCountAt = now + COUNT_INTERVAL_MS
    this.tracer
      .getSampleCountsAsync()
      .then((counts) => {
        if (this._disposed) return
        this.samples = counts?.min ?? 0
        this.samplesPerSecond = counts?.samplesPerSecond ?? 0
      })
      .catch(() => {})
      .finally(() => {
        this._counting = false
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
    disposeTracer(this.tracer)
    this.tracer = null
    this.builder.dispose()
    disposeRenderer(this.renderer)
    this.renderer = null
  }
}
