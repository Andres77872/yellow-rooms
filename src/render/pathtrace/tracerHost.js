import * as THREE from 'three/webgpu'
import { WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu'
import { MeshBVH, SAH } from 'three-mesh-bvh'
import { mergeChunkRecord } from './chunkMerge.js'
import { createTracerRenderer, disposeRenderer, disposeTracer } from './webgpuContext.js'

// The realtime path tracer's worker side (tracerWorker.js is the entry;
// PathTraceRealtime.js the page side; docs/pathracer/10 the research).
//
// Everything expensive lives here, off the game's main thread: baking
// chunk records into world-space meshes (chunkMerge.js), their bottom-level
// BVHs, the top-level BVH and packing every vertex (0.6-0.8 s for the first
// scene, 100-200 ms per streaming rebuild), and the GPU readback. The page
// keeps rendering and reprojecting the last traced frame while any of that
// runs. Only the first scene goes through setScene(); streaming rebuilds
// swap into the compiled kernel (swapScene), since a recompile would stall
// the page's own WebGL frames on the shared GPU.
//
// The tracer uses three-gpu-pathtracer's MEGAKERNEL backend: one dispatch
// runs whole paths, so each renderSample() is one sample for every pixel
// (frameBudget covers the trace resolution). Measured on the reference
// GPU at 400 x 346 with 3 bounces: ~1.5-2 ms per sample, against ~12 ms
// for the default wavefront backend, which advances every path one segment
// per call and needs maxBounces + 2 calls before every pixel has a sample.
//
// Messages in (the page posts them in order):
//   init       { settings }                    create the device and tracer
//   geometry   { id, position, normal, uv, color, colorSize, index }
//   dropGeometry { id }
//   texture    { id, data, width, height, wrapS, wrapT, colorSpace }
//   materials  { list: [{ id, kind, ... }] }   (sceneMirror.js)
//   chunk      { key, items }                  merged in the background
//   dropChunk  { key }
//   scene      { id, chunks, lights, flashlight }
//   lights     { lights, flashlight }
//   trace      { slot, serial, camera, samples, flash, width, height }
//   dispose
// Messages out:
//   ready      { info, backend }
//   scene      { id, buildMs, setSceneMs, triangles, meshes, lights }
//   frame      { slot, serial, data, width, height, continued, samples, ms }
//   skipped    { slot }                        no scene yet, or a failed readback
//   error      { message }                     fatal: the page falls back to raster

// Albedo cap for an emissive G-buffer material traced as a plain diffuser.
const EMISSIVE_ALBEDO_MAX = 0.8
// Background merging and BVH building yields after about this long, so trace
// jobs queued behind it wait little.
const BACKGROUND_SLICE_MS = 6
// The same bottom-level BVH the tracer's setScene would build itself.
const buildBVH = (geometry) => {
  geometry.boundsTree = new MeshBVH(geometry, { strategy: SAH, targetLeafSize: 5 })
}

const near = (a, b) => {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false
  return true
}

// Swap `scene` into a tracer that already traces one of ours through
// `camera`, without recompiling its kernel. Returns false when it cannot
// (the tracer still holds the placeholder scene and camera its constructor
// set, or lacks the internals below), and the caller uses setScene().
//
// setScene() builds a new PathtracerBVHComputeData and re-binds the backend
// to it (setBVHData, setCamera), so the megakernel recompiles: a new compute
// pipeline plus fresh storage buffers, created on the GPU process ahead of
// the page's WebGL work. Every streaming rebuild stalled the game's frame by
// 75-150 ms that way. The data object is built to be updated in place (its
// storage, structs and fns are proxies), so: re-run update() on it, move the
// freshly packed buffers into the storage nodes the kernel was compiled
// against (three re-binds a storage node whose attribute changed) and keep
// the structs those nodes are typed with, so a later recompile still sees
// one consistent graph. The texture atlas resizes in place too. A different
// vertex layout or texture count changes the kernel's code (struct members,
// the fixed-length textureInfo array): that keeps the new graph and
// recompiles, as setScene() would.
export function swapScene(tracer, scene, camera) {
  const data = tracer._bvhData
  const backend = tracer._pathTracer
  if (
    !tracer.scene ||
    tracer.camera !== camera ||
    !data?.storage ||
    !data.structs ||
    !data.textureAtlas ||
    typeof backend?.setBVHData !== 'function'
  ) {
    return false
  }
  scene.updateMatrixWorld(true)
  const storage = {}
  for (const key in data.storage) storage[key] = data.storage[key].proxyNode
  const structs = {}
  for (const key in data.structs) structs[key] = data.structs[key].proxyNode
  const layout = Object.entries(data.attributes).join()
  const textureCount = data.textureAtlas.textureInfo.length
  data.objects = [scene]
  data.update()
  data.textureAtlas.setTextures(tracer._renderer, data.textures)
  tracer.scene = scene
  if (Object.entries(data.attributes).join() === layout && data.textureAtlas.textureInfo.length === textureCount) {
    for (const key in storage) {
      const node = storage[key]
      const fresh = data.storage[key].proxyNode
      if (!node || !fresh || node === fresh) continue
      node.value = fresh.value
      data.storage[key] = node
    }
    for (const key in structs) if (structs[key]) data.structs[key] = structs[key]
  } else {
    backend.setBVHData(data)
  }
  tracer.updateEnvironment()
  tracer.updateLights()
  return true
}

export class TracerHost {
  constructor(post, { createRenderer = createTracerRenderer, Tracer = WebGPUPathTracer, now = () => performance.now() } = {}) {
    this._post = post
    this._createRenderer = createRenderer
    this._Tracer = Tracer
    this._now = now
    this.renderer = null
    this.tracer = null
    this.backend = ''
    this.maxSamples = 0
    this.geometries = new Map()
    this.textures = new Map()
    this.materials = new Map()
    // key -> { record, meshes, triangles }
    this.chunks = new Map()
    this.scene = null
    this.camera = new THREE.PerspectiveCamera()
    this.spot = null
    this._rects = []
    this._pending = new Set()
    this._bvhQueue = []
    this._bgTimer = null
    this._queue = []
    this._cam = null
    this._flash = null
    this._size = [0, 0]
    // Every tracer reset bumps _resets; a job is a continuation when none
    // happened since the previous job.
    this._resets = 0
    this._jobResets = -1
    this._samples = 0
    this._failed = false
    this._disposed = false
  }

  handle(msg) {
    if (this._disposed || this._failed) return
    try {
      if (msg.type === 'init') return this._init(msg)
      if (msg.type === 'dispose') return this.dispose()
      if (!this.tracer) {
        this._queue.push(msg)
        return
      }
      this._dispatch(msg)
    } catch (err) {
      this._fail(err)
    }
  }

  async _init({ settings = {} }) {
    try {
      const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : undefined
      const { renderer, info } = await this._createRenderer({ onLost: (message) => this._fail(message), canvas })
      if (this._disposed) {
        disposeRenderer(renderer)
        return
      }
      this.renderer = renderer
      const tracer = new this._Tracer(renderer)
      // The switch rebuilds the backend with its own defaults, so it comes
      // before every setting below.
      if (settings.megakernel !== false && typeof tracer.useMegakernel === 'function') {
        tracer.useMegakernel(true)
        this.backend = 'megakernel'
      } else {
        this.backend = 'wavefront'
      }
      tracer.maxBounces = settings.maxBounces ?? 3
      tracer.maxSamples = this.maxSamples = settings.maxSamples ?? 512
      tracer.frameBudget = settings.frameBudget ?? 1 << 20
      // Driven by trace jobs at the page's trace resolution; the 1 x 1
      // canvas only receives the tracer's (unused) presentation blit.
      tracer.synchronizeRenderSize = false
      tracer.renderScale = 1
      // No low-res preview, delay or fade: every frame is read as it is.
      tracer.dynamicLowRes = false
      tracer.renderDelay = 0
      tracer.minSamples = 0
      tracer.fadeDuration = 0
      // Fresh noise after every reset, so the page's temporal history
      // averages independent samples instead of one frozen pattern.
      tracer.stableNoise = false
      // A few samples per pixel cannot average out fireflies; clamp indirect
      // radiance harder than the default (10), trading a little energy.
      tracer.clampIndirect = settings.clampIndirect ?? 3
      this.tracer = tracer
      this._post({ type: 'ready', info, backend: this.backend })
      const queued = this._queue
      this._queue = []
      for (const msg of queued) this._dispatch(msg)
    } catch (err) {
      this._fail(err)
    }
  }

  _dispatch(msg) {
    switch (msg.type) {
      case 'geometry':
        this.geometries.set(msg.id, msg)
        break
      case 'dropGeometry':
        this.geometries.delete(msg.id)
        break
      case 'texture':
        this._setTexture(msg)
        break
      case 'materials':
        for (const desc of msg.list) this._setMaterial(desc)
        break
      case 'chunk':
        this._dropChunk(msg.key)
        this.chunks.set(msg.key, { record: msg, meshes: null, triangles: 0 })
        this._pending.add(msg.key)
        this._kick()
        break
      case 'dropChunk':
        this._dropChunk(msg.key)
        break
      case 'scene':
        this._buildScene(msg)
        break
      case 'lights':
        if (this.scene) {
          this._setLights(this.scene, msg.lights, msg.flashlight)
          this.tracer.updateLights()
          this._reset()
        }
        break
      case 'trace':
        this._trace(msg)
        break
    }
  }

  _setTexture(msg) {
    this.textures.get(msg.id)?.dispose()
    const t = new THREE.DataTexture(msg.data, msg.width, msg.height, THREE.RGBAFormat, THREE.UnsignedByteType)
    t.wrapS = msg.wrapS
    t.wrapT = msg.wrapT
    t.colorSpace = msg.colorSpace
    t.flipY = false
    t.magFilter = THREE.LinearFilter
    t.minFilter = THREE.LinearFilter
    t.generateMipmaps = false
    t.needsUpdate = true
    this.textures.set(msg.id, t)
  }

  // Merged proxies always take vertex colour (instance and part colour are
  // folded into it, chunkMerge.js). A chunk can arrive before its
  // materials' first sync: it gets a placeholder that the sync fills in.
  _material(id) {
    let m = this.materials.get(id)
    if (!m) {
      m = new THREE.MeshStandardMaterial({ vertexColors: true })
      this.materials.set(id, m)
    }
    return m
  }

  _setMaterial(desc) {
    const m = this._material(desc.id)
    m.side = desc.side ?? THREE.FrontSide
    m.map = null
    m.emissiveIntensity = 1
    m.emissive.setRGB(0, 0, 0)
    m.metalness = 0
    if (desc.kind === 'panel') {
      // Lit panels: the area light under each one is the emitter. A dark
      // diffuser keeps the recess visible without emitting.
      m.color.setHex(0x202020)
      m.roughness = 0.4
    } else if (desc.kind === 'emissive') {
      // Signs and the exit are beacons, not lamps: the raster frame keeps
      // them out of the light field (and keeps their own pixels), so they
      // only reflect here. Small emitters found by bounce rays alone would
      // also sparkle at a few samples per pixel.
      m.color.setRGB(...desc.emissive.map((c) => Math.min(c, EMISSIVE_ALBEDO_MAX)))
      m.roughness = 0.6
    } else {
      m.color.setRGB(...desc.color)
      m.roughness = desc.roughness
      m.metalness = desc.metalness
      m.map = desc.map != null ? (this.textures.get(desc.map) ?? null) : null
    }
    m.needsUpdate = true
  }

  _mergeChunk(key) {
    const c = this.chunks.get(key)
    if (!c || c.meshes) return
    this._pending.delete(key)
    let triangles = 0
    c.meshes = mergeChunkRecord(c.record, this.geometries).map((p) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(p.position, 3))
      g.setAttribute('normal', new THREE.BufferAttribute(p.normal, 3))
      g.setAttribute('uv', new THREE.BufferAttribute(p.uv, 2))
      g.setAttribute('color', new THREE.BufferAttribute(p.color, 3))
      // Proxies carry no normal maps: a zero tangent stops setScene from
      // running computeTangents() over every merged chunk.
      g.setAttribute('tangent', new THREE.BufferAttribute(new Float32Array((p.position.length / 3) * 4), 4))
      g.setIndex(new THREE.BufferAttribute(p.index, 1))
      const mesh = new THREE.Mesh(g, this._material(p.material))
      mesh.matrixAutoUpdate = false
      mesh.frustumCulled = false
      triangles += p.triangles
      this._bvhQueue.push(g)
      return mesh
    })
    c.triangles = triangles
    c.record = null
  }

  _dropChunk(key) {
    const c = this.chunks.get(key)
    if (!c) return
    this.chunks.delete(key)
    this._pending.delete(key)
    for (const mesh of c.meshes ?? []) {
      mesh.removeFromParent()
      mesh.geometry.boundsTree = null
      mesh.geometry.dispose()
    }
  }

  _kick() {
    if (this._bgTimer !== null || this._disposed) return
    if (!this._pending.size && !this._bvhQueue.length) return
    this._bgTimer = setTimeout(() => {
      this._bgTimer = null
      try {
        this._background()
      } catch (err) {
        this._fail(err)
      }
    }, 0)
  }

  // Merge pending chunks and build their BVHs a slice at a time, so a scene
  // build later only has the top-level BVH and packing left.
  _background() {
    const t0 = this._now()
    while (this._now() - t0 < BACKGROUND_SLICE_MS) {
      const g = this._bvhQueue.shift()
      if (g) {
        if (!g.boundsTree && g.index) buildBVH(g)
        continue
      }
      const key = this._pending.values().next().value
      if (key === undefined) break
      this._mergeChunk(key)
    }
    this._kick()
  }

  _setLights(scene, lights, flashlight) {
    for (const l of this._rects) {
      l.removeFromParent()
      l.dispose()
    }
    this._rects = (lights ?? []).map((d) => {
      const light = new THREE.RectAreaLight(new THREE.Color(...d.color), d.intensity, d.width, d.height)
      light.position.fromArray(d.position)
      // -Z (the emitting side) straight down; width stays on X like the panel.
      light.rotation.set(-Math.PI / 2, 0, 0)
      light.updateMatrixWorld()
      scene.add(light)
      return light
    })
    if (flashlight) {
      const p = flashlight
      if (!this.spot) this.spot = new THREE.SpotLight()
      const s = this.spot
      s.color.setRGB(...p.color)
      s.intensity = p.intensity
      s.distance = p.distance
      s.angle = p.angle
      s.penumbra = p.penumbra
      s.decay = p.decay
      s.radius = p.radius
      // The torch stays in the scene; visibility switches it (the tracer
      // only collects visible lights, so an off torch costs nothing).
      s.visible = !!p.on
      if (s.parent !== scene) scene.add(s, s.target)
      if (this._flash) this._aim(this._flash)
    } else if (this.spot) {
      this.spot.visible = false
    }
  }

  _aim({ position, target }) {
    const s = this.spot
    s.position.fromArray(position)
    s.target.position.fromArray(target)
    s.updateMatrixWorld()
    s.target.updateMatrixWorld()
  }

  _buildScene({ id, chunks, lights, flashlight }) {
    const t0 = this._now()
    const scene = new THREE.Scene()
    let triangles = 0
    let meshes = 0
    for (const key of chunks) {
      this._mergeChunk(key)
      const c = this.chunks.get(key)
      for (const mesh of c?.meshes ?? []) {
        // setScene() builds missing BVHs itself; swapScene() relies on them.
        if (!mesh.geometry.boundsTree) buildBVH(mesh.geometry)
        scene.add(mesh)
        meshes++
      }
      triangles += c?.triangles ?? 0
    }
    const t1 = this._now()
    if (meshes === 0) {
      // A run that has not streamed any chunk yet: nothing to trace (and an
      // empty scene would hand the tracer a vertex layout without uvs).
      this.scene = null
    } else {
      if (this.spot) this.spot.removeFromParent()
      this._setLights(scene, lights, flashlight)
      scene.updateMatrixWorld(true)
      if (!swapScene(this.tracer, scene, this.camera)) this.tracer.setScene(scene, this.camera)
      this.scene = scene
    }
    this._reset()
    // BVHs this build needed are no longer background work.
    this._bvhQueue = this._bvhQueue.filter((g) => !g.boundsTree)
    this._post({
      type: 'scene',
      id,
      buildMs: t1 - t0,
      setSceneMs: this._now() - t1,
      triangles,
      meshes,
      lights: this._rects.length,
    })
  }

  _reset() {
    this._resets++
    this._samples = 0
  }

  // One traced frame: apply the job's size, camera and torch pose (each
  // change restarts accumulation), add `samples` samples, read back.
  _trace({ slot, serial, camera, samples, flash, width, height }) {
    const tracer = this.tracer
    if (!this.scene) {
      this._post({ type: 'skipped', slot })
      return
    }
    const t0 = this._now()
    if (width !== this._size[0] || height !== this._size[1]) {
      this._size = [width, height]
      tracer.setSize(width, height)
      tracer.reset()
      this._reset()
    }
    const cam = camera
    if (!this._cam || !near(this._cam.m, cam.m) || this._cam.fov !== cam.fov || this._cam.aspect !== cam.aspect) {
      this._cam = cam
      const c = this.camera
      c.fov = cam.fov
      c.aspect = cam.aspect
      c.near = cam.near
      c.far = cam.far
      c.matrixWorld.fromArray(cam.m)
      c.matrixWorld.decompose(c.position, c.quaternion, c.scale)
      c.updateProjectionMatrix()
      c.updateMatrixWorld(true)
      tracer.updateCamera()
      this._reset()
    }
    if (flash && this.spot?.visible && !(this._flash && near(this._flash.position, flash.position) && near(this._flash.target, flash.target))) {
      this._flash = flash
      this._aim(flash)
      tracer.updateLights()
      this._reset()
    }
    const continued = this._jobResets === this._resets
    this._jobResets = this._resets
    // The wavefront fallback advances paths one segment per call: a sample
    // takes maxBounces + 2 calls before every pixel has one.
    const perSample = this.backend === 'wavefront' ? tracer.maxBounces + 2 : 1
    for (let i = 0, n = samples * perSample; i < n; i++) tracer.renderSample()
    this._samples = Math.min(this.maxSamples || Infinity, this._samples + samples)
    const total = this._samples
    this.renderer.backend
      .copyTextureToBuffer(tracer.target, 0, 0, width, height, 0)
      .then((data) => {
        if (this._disposed) return
        this._post(
          { type: 'frame', slot, serial, data, width, height, continued, samples: total, ms: this._now() - t0 },
          [data.buffer]
        )
      })
      .catch(() => {
        if (!this._disposed) this._post({ type: 'skipped', slot })
      })
  }

  _fail(err) {
    if (this._failed || this._disposed) return
    this._failed = true
    const message = typeof err === 'string' ? err : (err?.message ?? String(err))
    this._post({ type: 'error', message })
  }

  dispose() {
    if (this._disposed) return
    this._disposed = true
    clearTimeout(this._bgTimer)
    disposeTracer(this.tracer)
    this.tracer = null
    disposeRenderer(this.renderer)
    this.renderer = null
  }
}
