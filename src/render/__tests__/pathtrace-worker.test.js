import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../textures.js', () => ({
  floorTexture: (anisotropy) => Object.assign(new THREE.Texture(), { anisotropy }),
  wallTexture: (anisotropy) => Object.assign(new THREE.Texture(), { anisotropy }),
  ceilingTexture: (anisotropy) => Object.assign(new THREE.Texture(), { anisotropy }),
  surfaceDetailTexture: (albedo) => Object.assign(new THREE.Texture(), { anisotropy: albedo.anisotropy }),
}))
// The tracer's source uses extensionless imports only a bundler resolves;
// TracerHost takes the tracer class injected anyway.
vi.mock('three-gpu-pathtracer/webgpu', () => ({ WebGPUPathTracer: class {} }))

import { mergeChunkRecord } from '../pathtrace/chunkMerge.js'
import {
  CHUNK_KEEP_BUILDS,
  SceneMirror,
  chunkItems,
  materialDescription,
  packAttribute,
  texturePixels,
} from '../pathtrace/sceneMirror.js'
import { TracerHost, swapScene } from '../pathtrace/tracerHost.js'
import { createGBufferMaterials } from '../gbufferMaterials.js'
import { createGeometries } from '../geometries.js'
import { Chunk } from '../../world/Chunk.js'
import { worldConfigForFamily } from '../../world/mapFamily.js'
import { hashStr } from '../../world/core/hash.js'
import { CHUNK_WORLD, HUB_CELL, LAYER_H, PANEL_GLOW, WALL_H } from '../../world/constants.js'

// The realtime path tracer's worker protocol (docs/pathracer/10): chunks
// exported on the page (sceneMirror.js), baked in the worker
// (chunkMerge.js), and the worker's tracer host (tracerHost.js) driven with
// a fake WebGPU tracer. The GPU itself is verified in the browser.

const materials = createGBufferMaterials({ capabilities: { getMaxAnisotropy: () => 4 } })
const geom = createGeometries()
const { config } = worldConfigForFamily('office')
const clear = [{ cx: 0, cy: 0, cz: 0, lx: HUB_CELL, lz: HUB_CELL, r: 1 }]
const chunk = new Chunk(0, 0, 0, hashStr('review#1'), materials, geom, null, config, clear, null)
const neighbour = new Chunk(1, 0, 0, hashStr('review#1'), materials, geom, null, config, null, null)

// Every message SceneMirror posts, plus the worker-side geometry table.
function recorder() {
  const messages = []
  const post = vi.fn((msg, transfer) => messages.push({ msg, transfer }))
  const of = (type) => messages.filter((m) => m.msg.type === type).map((m) => m.msg)
  const geometries = () => new Map(of('geometry').map((g) => [g.id, g]))
  return { messages, post, of, geometries }
}

// Triangles the chunk draws (visible, non-skinned meshes, every instance).
function drawnTriangles(root) {
  let tris = 0
  root.traverse((n) => {
    if (!n.isMesh || n.isSkinnedMesh) return
    for (let p = n; p && p !== root; p = p.parent) if (!p.visible) return
    const g = n.geometry
    const count = n.isInstancedMesh ? n.count : 1
    const total = g.index ? g.index.count : g.attributes.position.count
    const ranges = Array.isArray(n.material) ? g.groups.map((gr) => Math.min(gr.count, total - gr.start)) : [total]
    for (const r of ranges) tris += Math.floor(r / 3) * count
  })
  return tris
}

describe('chunk records and the worker merge', () => {
  it('bakes a real chunk into world space, one mesh per material, every triangle kept', () => {
    const rec = recorder()
    const mirror = new SceneMirror(rec.post)
    mirror.sceneChunks([chunk])
    const [record] = rec.of('chunk')
    const parts = mergeChunkRecord(record, rec.geometries())
    const ids = new Set(record.items.flatMap((it) => it.ranges.map((r) => r.material)))
    expect(parts.length).toBe(ids.size)
    let tris = 0
    for (const p of parts) {
      tris += p.triangles
      expect(p.position.length / 3).toBe(p.normal.length / 3)
      expect(p.uv.length / 2).toBe(p.position.length / 3)
      expect(p.color.length).toBe(p.position.length)
      let max = 0
      for (const i of p.index) max = Math.max(max, i)
      expect(max).toBeLessThan(p.position.length / 3)
      // World space: inside the chunk's footprint (plus trim overhang).
      for (let i = 0; i < p.position.length; i += 3) {
        expect(p.position[i]).toBeGreaterThan(-1)
        expect(p.position[i]).toBeLessThan(CHUNK_WORLD + 1)
      }
    }
    // Nothing is skipped any more: trims, props and signs are traced too,
    // so their pixels never show the surface behind them.
    expect(tris).toBe(drawnTriangles(chunk.group))
  })

  it('folds the lit panels\' instance tint into vertex colour', () => {
    const rec = recorder()
    const mirror = new SceneMirror(rec.post)
    mirror.sceneChunks([chunk])
    const panelId = mirror._materials.get(materials.panel)
    const part = mergeChunkRecord(rec.of('chunk')[0], rec.geometries()).find((p) => p.material === panelId)
    let tinted = false
    for (let i = 0; i < part.color.length && !tinted; i++) tinted = part.color[i] !== 1
    expect(tinted).toBe(true)
  })

  it('flips the winding of a mirrored instance and transforms its normals', () => {
    const geometries = new Map([
      [1, { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), uv: null, color: null, index: new Uint32Array([0, 1, 2]) }],
    ])
    const mirrorX = new THREE.Matrix4().makeScale(-1, 1, 1)
    const shift = new THREE.Matrix4().makeTranslation(5, 0, 0)
    const record = {
      items: [
        {
          geometry: 1,
          matrix: Float32Array.from(shift.elements),
          count: 2,
          instanceMatrices: Float32Array.from([...new THREE.Matrix4().elements, ...mirrorX.elements]),
          instanceColors: Float32Array.from([1, 0, 0, 0, 1, 0]),
          ranges: [{ start: 0, count: 3, material: 7, partColor: false }],
        },
      ],
    }
    const [p] = mergeChunkRecord(record, geometries)
    expect(p.material).toBe(7)
    expect(Array.from(p.index)).toEqual([0, 1, 2, 3, 5, 4])
    expect(Array.from(p.position.slice(9, 12))).toEqual([5, 0, 0])
    expect(p.position[12]).toBe(4) // x = 5 - 1
    expect(Array.from(p.normal.slice(9, 12)).map((v) => v + 0)).toEqual([0, 0, 1])
    expect(Array.from(p.color.slice(0, 3))).toEqual([1, 0, 0])
    expect(Array.from(p.color.slice(9, 12))).toEqual([0, 1, 0])
  })

  it('box-projects world UVs like the G-buffer for world-UV surfaces', () => {
    // One quad facing +X on layer 1 (a wall), one facing +Y (a floor).
    const geometries = new Map([
      [
        1,
        {
          position: new Float32Array([0, 0, 0, 0, 0, -3, 0, WALL_H, -3, 0, 0, 0, 6, 0, 0, 0, 0, 3]),
          normal: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
          uv: new Float32Array(12),
          color: null,
          index: new Uint32Array([0, 1, 2]),
        },
      ],
    ])
    const uvs = (p) => Array.from(p.uv).map((v) => +v.toFixed(5) + 0)
    const lift = new THREE.Matrix4().makeTranslation(0, LAYER_H, 0)
    const record = {
      items: [
        {
          geometry: 1,
          matrix: Float32Array.from(lift.elements),
          count: 1,
          instanceMatrices: null,
          instanceColors: null,
          ranges: [{ start: 0, count: 3, material: 1, partColor: false, worldUV: true }],
        },
      ],
    }
    const [wall] = mergeChunkRecord(record, geometries)
    // +X face: u = -z / CELL, v = height above the layer / WALL_H.
    expect(uvs(wall)).toEqual([0, 0, 1, 0, 1, 1])
    geometries.get(1).index = new Uint32Array([3, 4, 5])
    const [floor] = mergeChunkRecord(record, geometries)
    // +Y face: u = x / CELL, v = -z / CELL.
    expect(uvs(floor)).toEqual([0, 0, 2, 0, 0, -1])
  })

  it('copies only the vertex span each material range indexes', () => {
    const position = new Float32Array(6 * 3)
    const geometries = new Map([[1, { position, normal: null, uv: null, color: null, index: new Uint32Array([0, 1, 2, 3, 4, 5]) }]])
    const record = {
      items: [
        {
          geometry: 1,
          matrix: Float32Array.from(new THREE.Matrix4().elements),
          count: 1,
          instanceMatrices: null,
          instanceColors: null,
          ranges: [
            { start: 0, count: 3, material: 1, partColor: false },
            { start: 3, count: 3, material: 2, partColor: false },
          ],
        },
      ],
    }
    const parts = mergeChunkRecord(record, geometries)
    expect(parts.map((p) => p.position.length / 3)).toEqual([3, 3])
    expect(parts.map((p) => Array.from(p.index))).toEqual([
      [0, 1, 2],
      [0, 1, 2],
    ])
  })

  it('packs interleaved and integer attributes into plain floats', () => {
    const ib = new THREE.InterleavedBuffer(new Float32Array([1, 2, 3, 9, 4, 5, 6, 9]), 4)
    expect(Array.from(packAttribute(new THREE.InterleavedBufferAttribute(ib, 3, 0), 3))).toEqual([1, 2, 3, 4, 5, 6])
    const uv = new THREE.BufferAttribute(new Uint16Array([0, 65535]), 2, true)
    expect(Array.from(packAttribute(uv, 2))).toEqual([0, 1])
  })
})

describe('SceneMirror (page side)', () => {
  it('sends each source geometry once and shares it between chunks', () => {
    const rec = recorder()
    const mirror = new SceneMirror(rec.post)
    mirror.sceneChunks([chunk, neighbour])
    const sent = rec.of('geometry').map((g) => g.id)
    expect(new Set(sent).size).toBe(sent.length)
    const used = new Set(rec.of('chunk').flatMap((c) => c.items.map((it) => it.geometry)))
    expect(used).toEqual(new Set(sent))
    // Typed arrays travel as transfers, never copies of the game's buffers.
    const g = rec.messages.find((m) => m.msg.type === 'geometry')
    expect(g.transfer).toContain(g.msg.position.buffer)
    expect(g.msg.position.buffer).not.toBe(chunk.group.children[0]?.geometry?.attributes.position.array.buffer)
  })

  it('keeps a chunk across builds, re-sends it when its signature changes', () => {
    const rec = recorder()
    const mirror = new SceneMirror(rec.post)
    const [a] = mirror.sceneChunks([chunk])
    const [b] = mirror.sceneChunks([chunk])
    expect(b).toBe(a)
    expect(rec.of('chunk')).toHaveLength(1)
    expect(mirror.holds(chunk)).toBe(true)
    const detail = chunk.renderDetail
    chunk.renderDetail = 'changed'
    try {
      expect(mirror.holds(chunk)).toBe(false)
      const [c] = mirror.sceneChunks([chunk])
      expect(c).not.toBe(a)
      expect(rec.of('dropChunk').map((m) => m.key)).toEqual([a])
    } finally {
      chunk.renderDetail = detail
    }
  })

  it(`releases chunks unused for ${CHUNK_KEEP_BUILDS} builds and the geometry only they used`, () => {
    const rec = recorder()
    const mirror = new SceneMirror(rec.post)
    mirror.sceneChunks([chunk, neighbour])
    for (let i = 0; i < CHUNK_KEEP_BUILDS; i++) mirror.sceneChunks([chunk])
    expect(rec.of('dropChunk')).toHaveLength(1)
    const kept = new Set(rec.of('chunk')[0].items.map((it) => it.geometry))
    const dropped = rec.of('dropGeometry').map((m) => m.id)
    for (const id of dropped) expect(kept.has(id)).toBe(false)
    expect(mirror.residentChunks).toBe(1)
  })

  it('describes materials from their live uniforms; the lit panel never emits', () => {
    const textureId = vi.fn(() => 42)
    const panel = materialDescription(materials.panel, { id: 1, panelMaterial: materials.panel, textureId })
    expect(panel).toMatchObject({ id: 1, kind: 'panel' })
    const d2 = materialDescription(materials.signGlow, { id: 2, panelMaterial: materials.panel, textureId })
    expect(d2).toMatchObject({ kind: 'emissive', emissiveIntensity: PANEL_GLOW })
    const wall = materials.wallpaper
    const d = materialDescription(wall, { id: 3, panelMaterial: materials.panel, textureId })
    expect(d.kind).toBe('standard')
    expect(d.color).toEqual(wall.uniforms.uColor.value.toArray())
    expect(d.map).toBe(wall.uniforms.map.value ? 42 : null)
  })

  it('reads texture pixels bottom-up and re-sends a texture only when its version moves', () => {
    const data = new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2])
    const tex = new THREE.DataTexture(data, 1, 2)
    expect(Array.from(texturePixels(tex).data)).toEqual([1, 1, 1, 1, 2, 2, 2, 2])
    tex.flipY = true
    expect(Array.from(texturePixels(tex).data)).toEqual([2, 2, 2, 2, 1, 1, 1, 1])
    tex.flipY = false

    const rec = recorder()
    const mirror = new SceneMirror(rec.post)
    const mat = new THREE.RawShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, map: { value: tex }, uMatID: { value: 0 } },
    })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), mat)
    const group = new THREE.Group().add(mesh)
    const fake = { cx: 0, cy: 0, cz: 0, group }
    mirror.sceneChunks([fake])
    mirror.syncMaterials(null)
    mirror.syncMaterials(null)
    expect(rec.of('texture')).toHaveLength(1)
    tex.needsUpdate = true
    mirror.syncMaterials(null)
    expect(rec.of('texture')).toHaveLength(2)
    const [list] = rec.of('materials').slice(-1)
    expect(list.list[0].map).toBe(rec.of('texture')[0].id)
  })
})

// A stand-in for three-gpu-pathtracer's WebGPUPathTracer: records calls.
class FakeTracer {
  constructor(renderer) {
    this.renderer = renderer
    this.calls = []
    this.maxBounces = 15
    this.target = { isTexture: true }
  }
  useMegakernel(on) {
    this.calls.push(['useMegakernel', on])
    this.maxBounces = 15
  }
  setScene(scene, camera) {
    this.calls.push(['setScene'])
    this.scene = scene
    this.camera = camera
  }
  setSize(w, h) {
    this.calls.push(['setSize', w, h])
  }
  reset() {}
  updateCamera() {
    this.calls.push(['updateCamera'])
  }
  updateLights() {
    this.calls.push(['updateLights'])
  }
  renderSample() {
    this.calls.push(['renderSample'])
  }
  count(name) {
    return this.calls.filter((c) => c[0] === name).length
  }
}

function makeHost({ fail = null, megakernel = true } = {}) {
  const posted = []
  const renderer = {
    backend: { copyTextureToBuffer: vi.fn(async (_t, _x, _y, w, h) => new Float32Array(w * h * 4)) },
    dispose: vi.fn(),
  }
  const createRenderer = vi.fn(async () => {
    if (fail) throw fail
    return { renderer, info: { vendor: 'test' } }
  })
  class Tracer extends FakeTracer {}
  if (!megakernel) Tracer.prototype.useMegakernel = undefined
  let tracer = null
  const host = new TracerHost((msg, transfer) => posted.push({ msg, transfer }), {
    createRenderer,
    Tracer: class extends Tracer {
      constructor(r) {
        super(r)
        tracer = this
      }
    },
  })
  const of = (type) => posted.filter((p) => p.msg.type === type).map((p) => p.msg)
  return { host, posted, of, renderer, createRenderer, tracer: () => tracer }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const camera = (x = 0) => ({ m: new THREE.Matrix4().makeTranslation(x, 1.6, 0).elements, fov: 72, aspect: 1.5, near: 0.1, far: 180 })
const panelLight = { color: [1, 1, 1], intensity: 2, width: 1.7, height: 1, position: [0, 2.5, 0] }
const flashlight = { color: [1, 1, 1], intensity: 3, distance: 10, angle: 0.5, penumbra: 0.2, decay: 2, radius: 0.02, on: true }

// Mirror the real chunk into a host, the way the page does.
function feed(host) {
  const rec = recorder()
  const mirror = new SceneMirror((msg) => host.handle(msg))
  const keys = mirror.sceneChunks([chunk])
  mirror.syncMaterials(materials.panel)
  return { rec, keys }
}

describe('TracerHost (worker side)', () => {
  it('starts the megakernel backend, then applies the realtime settings', async () => {
    const h = makeHost()
    h.host.handle({ type: 'init', settings: { maxBounces: 3, maxSamples: 512 } })
    await flush()
    const [ready] = h.of('ready')
    expect(ready).toMatchObject({ backend: 'megakernel', info: { vendor: 'test' } })
    const t = h.tracer()
    // The backend switch resets its own settings, so it must come first.
    expect(t.calls[0]).toEqual(['useMegakernel', true])
    expect(t.maxBounces).toBe(3)
    expect(t.maxSamples).toBe(512)
    expect(t.synchronizeRenderSize).toBe(false)
    expect(t.stableNoise).toBe(false)
    expect(t.dynamicLowRes).toBe(false)
  })

  it('queues messages that arrive before the device is ready', async () => {
    const h = makeHost()
    h.host.handle({ type: 'init', settings: {} })
    const { keys } = feed(h.host)
    h.host.handle({ type: 'scene', id: 1, chunks: keys, lights: [panelLight], flashlight: null })
    expect(h.of('scene')).toHaveLength(0)
    await flush()
    expect(h.of('scene')).toHaveLength(1)
  })

  it('builds the scene from merged chunks, panel area lights and the torch', async () => {
    const h = makeHost()
    h.host.handle({ type: 'init', settings: {} })
    await flush()
    const { keys } = feed(h.host)
    h.host.handle({ type: 'scene', id: 7, chunks: keys, lights: [panelLight, panelLight], flashlight })
    const scene = h.tracer().scene
    const meshes = scene.children.filter((o) => o.isMesh)
    expect(meshes.length).toBeGreaterThan(0)
    for (const m of meshes) {
      expect(m.material.vertexColors).toBe(true)
      expect(m.geometry.attributes.tangent).toBeDefined()
    }
    expect(scene.children.filter((o) => o.isRectAreaLight)).toHaveLength(2)
    const spot = scene.children.find((o) => o.isSpotLight)
    expect(spot.visible).toBe(true)
    const [msg] = h.of('scene')
    expect(msg).toMatchObject({ id: 7, meshes: meshes.length, lights: 2 })
    expect(msg.triangles).toBe(drawnTriangles(chunk.group))
    // The lit panel's proxy is the dark diffuser, never an emitter.
    const panel = h.host.materials.get([...h.host.materials.keys()].find((id) => h.host.materials.get(id).color.getHex() === 0x202020))
    expect(panel.emissive.getHex()).toBe(0)
  })

  it('skips a job without a scene and accumulates while the camera holds still', async () => {
    const h = makeHost()
    h.host.handle({ type: 'init', settings: { maxSamples: 6 } })
    await flush()
    h.host.handle({ type: 'trace', slot: 0, serial: 1, camera: camera(), samples: 2, flash: null, width: 32, height: 16 })
    expect(h.of('skipped')).toEqual([{ type: 'skipped', slot: 0 }])
    const { keys } = feed(h.host)
    h.host.handle({ type: 'scene', id: 1, chunks: keys, lights: [panelLight], flashlight: null })
    const t = h.tracer()
    const job = (slot, cam, samples = 2) =>
      h.host.handle({ type: 'trace', slot, serial: 1, camera: cam, samples, flash: null, width: 32, height: 16 })
    job(1, camera())
    job(2, camera())
    job(0, camera())
    job(1, camera(1))
    await flush()
    const frames = h.of('frame')
    expect(frames.map((f) => f.slot)).toEqual([1, 2, 0, 1])
    expect(frames.map((f) => f.continued)).toEqual([false, true, true, false])
    // Capped at maxSamples; a camera move starts over.
    expect(frames.map((f) => f.samples)).toEqual([2, 4, 6, 2])
    expect(frames[0].data).toHaveLength(32 * 16 * 4)
    expect(t.count('renderSample')).toBe(8)
    expect(t.count('updateCamera')).toBe(2)
    expect(t.calls.filter((c) => c[0] === 'setSize')).toEqual([['setSize', 32, 16]])
  })

  it('re-aims the torch only when its pose moves, and reports the reset', async () => {
    const h = makeHost()
    h.host.handle({ type: 'init', settings: {} })
    await flush()
    const { keys } = feed(h.host)
    h.host.handle({ type: 'scene', id: 1, chunks: keys, lights: [], flashlight })
    const t = h.tracer()
    const pose = { position: [0, 1.4, 0], target: [0, 1.4, -10] }
    const job = (slot, flash) =>
      h.host.handle({ type: 'trace', slot, serial: 1, camera: camera(), samples: 1, flash, width: 16, height: 8 })
    job(0, pose)
    job(1, pose)
    job(2, { ...pose, target: [1, 1.4, -10] })
    await flush()
    expect(t.count('updateLights')).toBe(2)
    expect(h.of('frame').map((f) => f.continued)).toEqual([false, true, false])
    expect(t.scene.children.find((o) => o.isSpotLight).target.position.toArray()).toEqual([1, 1.4, -10])
  })

  it('runs maxBounces + 2 wavefront steps per sample without the megakernel', async () => {
    const h = makeHost({ megakernel: false })
    h.host.handle({ type: 'init', settings: { maxBounces: 3 } })
    await flush()
    expect(h.of('ready')[0].backend).toBe('wavefront')
    const { keys } = feed(h.host)
    h.host.handle({ type: 'scene', id: 1, chunks: keys, lights: [], flashlight: null })
    h.host.handle({ type: 'trace', slot: 0, serial: 1, camera: camera(), samples: 2, flash: null, width: 16, height: 8 })
    expect(h.tracer().count('renderSample')).toBe(10)
  })

  it('merges chunks in the background before the scene asks for them', async () => {
    const h = makeHost()
    h.host.handle({ type: 'init', settings: {} })
    await flush()
    const { keys } = feed(h.host)
    expect(h.host.chunks.get(keys[0]).meshes).toBeNull()
    for (let i = 0; i < 50 && h.host._pending.size; i++) await flush()
    expect(h.host.chunks.get(keys[0]).meshes.length).toBeGreaterThan(0)
    h.host.handle({ type: 'dropChunk', key: keys[0] })
    expect(h.host.chunks.has(keys[0])).toBe(false)
  })

  it('reports a failed start and ignores everything after it', async () => {
    const h = makeHost({ fail: new Error('No WebGPU adapter') })
    h.host.handle({ type: 'init', settings: {} })
    await flush()
    expect(h.of('error')).toEqual([{ type: 'error', message: 'No WebGPU adapter' }])
    h.host.handle({ type: 'trace', slot: 0, serial: 1, camera: camera(), samples: 1, flash: null, width: 16, height: 8 })
    expect(h.posted).toHaveLength(1)
  })

  it('traces nothing for a scene without chunks, and keeps the tracer as it was', async () => {
    const h = makeHost()
    h.host.handle({ type: 'init', settings: {} })
    await flush()
    h.host.handle({ type: 'scene', id: 1, chunks: [], lights: [panelLight], flashlight: null })
    expect(h.tracer().count('setScene')).toBe(0)
    expect(h.of('scene')[0]).toMatchObject({ id: 1, meshes: 0, triangles: 0 })
    h.host.handle({ type: 'trace', slot: 0, serial: 1, camera: camera(), samples: 1, flash: null, width: 16, height: 8 })
    expect(h.of('skipped')).toEqual([{ type: 'skipped', slot: 0 }])
  })

  it('swaps later scenes into the compiled kernel instead of calling setScene', async () => {
    const h = makeHost()
    h.host.handle({ type: 'init', settings: {} })
    await flush()
    const { keys } = feed(h.host)
    h.host.handle({ type: 'scene', id: 1, chunks: keys, lights: [panelLight], flashlight: null })
    const t = h.tracer()
    expect(t.count('setScene')).toBe(1)
    Object.assign(t, internals())
    t.updateEnvironment = () => t.calls.push(['updateEnvironment'])
    h.host.handle({ type: 'scene', id: 2, chunks: keys, lights: [panelLight], flashlight: null })
    expect(t.count('setScene')).toBe(1)
    expect(t._bvhData.objects).toEqual([h.host.scene])
    expect(t.scene).toBe(h.host.scene)
    expect(t._pathTracer.setBVHData).not.toHaveBeenCalled()
    for (const m of h.host.scene.children.filter((o) => o.isMesh)) expect(m.geometry.boundsTree).toBeTruthy()
  })
})

// three-mesh-bvh's NodeProxyObject: reading a member returns a stable proxy
// whose proxyNode is the member's current node; assigning stores the node.
function proxyObject(init = {}) {
  const proxies = {}
  return new Proxy(
    { ...init },
    {
      get(target, key) {
        proxies[key] ??= {
          get proxyNode() {
            return target[key] ?? null
          },
        }
        return proxies[key]
      },
      set(target, key, value) {
        target[key] = value
        return true
      },
    }
  )
}

// The PathtracerBVHComputeData / backend internals swapScene works through.
// update() builds fresh storage nodes and structs, like the library's.
function internals({ textureCount = 2 } = {}) {
  let builds = 0
  const data = {
    attributes: { position: 'vec4f', normal: 'vec4f', uv: 'vec4f' },
    storage: proxyObject(),
    structs: proxyObject(),
    textureAtlas: { textureInfo: new Array(textureCount).fill(0), setTextures: vi.fn() },
    textures: [],
    objects: [],
    nextAttributes: null,
    nextTextureCount: null,
    update() {
      builds++
      this.storage.attributes = { value: `attributes#${builds}` }
      this.storage.nodes = { value: `nodes#${builds}` }
      this.structs.attributes = { name: `struct#${builds}` }
      if (this.nextAttributes) this.attributes = this.nextAttributes
      if (this.nextTextureCount) this.textureAtlas.textureInfo = new Array(this.nextTextureCount).fill(0)
    },
  }
  data.update()
  return { _bvhData: data, _pathTracer: { setBVHData: vi.fn() }, _renderer: { isRenderer: true } }
}

function swapTracer(opts) {
  const cam = new THREE.PerspectiveCamera()
  const calls = []
  const tracer = {
    ...internals(opts),
    scene: new THREE.Scene(),
    camera: cam,
    updateEnvironment: () => calls.push('updateEnvironment'),
    updateLights: () => calls.push('updateLights'),
  }
  return { tracer, cam, calls }
}

describe('swapScene (worker side)', () => {
  it('declines a tracer still on its constructor placeholder, or without the internals', () => {
    const { tracer, cam } = swapTracer()
    expect(swapScene(tracer, new THREE.Scene(), new THREE.PerspectiveCamera())).toBe(false)
    expect(swapScene({ scene: new THREE.Scene(), camera: cam }, new THREE.Scene(), cam)).toBe(false)
    expect(swapScene({ ...tracer, scene: null }, new THREE.Scene(), cam)).toBe(false)
  })

  it('moves the new buffers into the nodes the kernel was compiled against', () => {
    const { tracer, cam, calls } = swapTracer()
    const data = tracer._bvhData
    const nodes = data.storage.attributes.proxyNode
    const struct = data.structs.attributes.proxyNode
    const scene = new THREE.Scene()
    expect(swapScene(tracer, scene, cam)).toBe(true)
    // Same node objects (the compiled bindings), now holding the new data.
    expect(data.storage.attributes.proxyNode).toBe(nodes)
    expect(nodes.value).toBe('attributes#2')
    expect(data.storage.nodes.proxyNode.value).toBe('nodes#2')
    // The struct those nodes are typed with stays, for any later recompile.
    expect(data.structs.attributes.proxyNode).toBe(struct)
    expect(data.objects).toEqual([scene])
    expect(data.textureAtlas.setTextures).toHaveBeenCalledWith(tracer._renderer, data.textures)
    expect(tracer.scene).toBe(scene)
    expect(tracer._pathTracer.setBVHData).not.toHaveBeenCalled()
    expect(calls).toEqual(['updateEnvironment', 'updateLights'])
  })

  it('recompiles on the new graph when the vertex layout or texture count changes', () => {
    for (const change of [
      (d) => (d.nextAttributes = { position: 'vec4f', normal: 'vec4f' }),
      (d) => (d.nextTextureCount = 3),
    ]) {
      const { tracer, cam } = swapTracer()
      const data = tracer._bvhData
      const nodes = data.storage.attributes.proxyNode
      change(data)
      expect(swapScene(tracer, new THREE.Scene(), cam)).toBe(true)
      expect(tracer._pathTracer.setBVHData).toHaveBeenCalledWith(data)
      expect(data.storage.attributes.proxyNode).not.toBe(nodes)
      expect(data.storage.attributes.proxyNode.value).toBe('attributes#2')
      expect(data.structs.attributes.proxyNode.name).toBe('struct#2')
    }
  })
})

describe('chunk item export', () => {
  it('names every visible draw with its world matrix and instance data', () => {
    const geometryIds = new Map()
    const { items, transfer } = chunkItems(
      chunk.group,
      (g) => geometryIds.get(g) ?? geometryIds.set(g, geometryIds.size + 1).get(g),
      () => 1
    )
    expect(items.length).toBeGreaterThan(3)
    for (const it of items) {
      expect(it.matrix).toHaveLength(16)
      if (it.instanceMatrices) expect(it.instanceMatrices).toHaveLength(it.count * 16)
      if (it.instanceColors) expect(it.instanceColors).toHaveLength(it.count * 3)
    }
    expect(transfer.length).toBeGreaterThan(0)
  })
})
