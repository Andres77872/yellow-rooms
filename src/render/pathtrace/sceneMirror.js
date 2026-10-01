import { PANEL_GLOW } from '../../world/constants.js'

// Main-thread half of the realtime tracer's scene mirror. The tracer runs in
// a worker (tracerWorker.js), so nothing three.js draws can be handed over:
// chunks, materials and textures cross as plain, transferable records and
// the worker rebuilds its own proxies (chunkMerge.js, tracerHost.js).
//
// Exporting is cheap on purpose: a chunk costs a walk over ~15 nodes and a
// copy of their instance matrices/colours; each source geometry crosses once
// and is shared by every chunk that draws it. The expensive work (baking
// world-space meshes, BVHs, setScene's packing) all happens in the worker.
//
// SceneMirror is the authority on what the worker holds: it assigns ids,
// reference-counts geometries per resident chunk, and tells the worker to
// drop what nothing references any more.

// Merged chunks unused for this many scene builds are released.
export const CHUNK_KEEP_BUILDS = 3

// True when `node` and every ancestor below `root` is visible. The chunk
// group itself is skipped: its flag is the sight-culling result for the
// current eye, not whether the geometry exists (culled rooms still bounce).
function visibleBelow(node, root) {
  for (let n = node; n && n !== root; n = n.parent) if (!n.visible) return false
  return true
}

// Signature of what a chunk's record was built from: the detail tier and the
// furniture batch both swap child meshes in place.
export function chunkSignature(chunk) {
  return `${chunk.renderDetail ?? ''}|${chunk.furnitureModelCount ?? 0}|${chunk.group.children.length}`
}

// A geometry attribute as a tightly packed Float32Array of `itemSize`
// components (interleaved, normalised or integer sources are converted).
export function packAttribute(attr, itemSize) {
  if (!attr) return null
  const n = attr.count
  const plain =
    !attr.isInterleavedBufferAttribute && attr.array instanceof Float32Array && attr.itemSize === itemSize && !attr.normalized
  if (plain) return attr.array.slice(0, n * itemSize)
  const out = new Float32Array(n * itemSize)
  const get = [attr.getX, attr.getY, attr.getZ, attr.getW]
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < itemSize; c++) out[i * itemSize + c] = c < attr.itemSize ? get[c].call(attr, i) : 1
  }
  return out
}

// The worker's copy of a source geometry. Returns [message, transfer].
export function geometryMessage(id, geometry) {
  const a = geometry.attributes
  const position = packAttribute(a.position, 3)
  const normal = packAttribute(a.normal, 3)
  const uv = packAttribute(a.uv, 2)
  const color = packAttribute(a.color, 3)
  const index = geometry.index ? Uint32Array.from(geometry.index.array.subarray(0, geometry.index.count)) : null
  const msg = { type: 'geometry', id, position, normal, uv, color, colorSize: 3, index }
  const transfer = [position, normal, uv, color, index].filter(Boolean).map((t) => t.buffer)
  return [msg, transfer]
}

// Walk a chunk group into a record of draw items (see chunkMerge.js).
// `geometryId(geometry)` and `materialId(material)` name the sources.
export function chunkItems(root, geometryId, materialId) {
  root.updateWorldMatrix(true, true)
  const items = []
  const transfer = []
  const geometries = new Set()
  root.traverse((node) => {
    if (!node.isMesh || node.isSkinnedMesh || !visibleBelow(node, root)) return
    const g = node.geometry
    const pos = g.attributes.position
    const count = node.isInstancedMesh ? node.count : 1
    if (!pos || count === 0) return
    const mats = Array.isArray(node.material) ? node.material : null
    const total = g.index ? g.index.count : pos.count
    const ranges = (mats ? g.groups.map((gr) => ({ ...gr, material: mats[gr.materialIndex] })) : [{ start: 0, count: total, material: node.material }])
      .filter((r) => r.material && r.count > 0)
      .map((r) => ({
        start: r.start,
        count: Math.min(r.count, total - r.start),
        material: materialId(r.material),
        partColor: !!r.material.defines?.USE_PART_COLOR,
        // Surface textures are box-projected in world space (chunkMerge.js).
        worldUV: r.material.defines?.USE_WORLD_UV !== undefined,
      }))
    if (!ranges.length) return
    let instanceMatrices = null
    let instanceColors = null
    if (node.isInstancedMesh) {
      instanceMatrices = node.instanceMatrix.array.slice(0, count * 16)
      transfer.push(instanceMatrices.buffer)
      if (node.instanceColor) {
        instanceColors = Float32Array.from(node.instanceColor.array.subarray(0, count * 3))
        transfer.push(instanceColors.buffer)
      }
    }
    geometries.add(g)
    items.push({
      geometry: geometryId(g),
      matrix: Float32Array.from(node.matrixWorld.elements),
      count,
      instanceMatrices,
      instanceColors,
      ranges,
    })
  })
  return { items, transfer, geometries }
}

const rgb = (c) => (c ? [c.r, c.g, c.b] : [1, 1, 1])

// Proxy description of a G-buffer material, re-read from its live uniforms
// (a family switch retints them in place). The lit panel is never an
// emitter: the area light under it is (proxyScene.js header).
export function materialDescription(src, { id, panelMaterial, textureId }) {
  const u = src.uniforms ?? {}
  const side = src.side ?? 0
  if (src === panelMaterial) return { id, kind: 'panel', side }
  if ((u.uMatID?.value ?? 0) === 1) {
    return { id, kind: 'emissive', emissive: rgb(u.uColor?.value), emissiveIntensity: PANEL_GLOW, side }
  }
  const map = u.map?.value ?? null
  return {
    id,
    kind: 'standard',
    color: rgb(u.uColor?.value),
    roughness: u.uRoughness?.value ?? 0.6,
    metalness: u.uMetalness?.value ?? 0,
    map: map ? textureId(map) : null,
    side,
  }
}

// RGBA8 pixels of a texture, rows bottom-up (v = 0 first), so the worker's
// DataTexture needs no flip. Returns null when the source cannot be read.
export function texturePixels(texture) {
  const img = texture.image
  if (!img) return null
  const w = img.width
  const h = img.height
  if (!(w > 0 && h > 0)) return null
  let src
  if (img.data) {
    if (!(img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray) || img.data.length < w * h * 4) return null
    src = img.data
  } else {
    const Canvas = globalThis.OffscreenCanvas
    if (!Canvas) return null
    const ctx = new Canvas(w, h).getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0)
    src = ctx.getImageData(0, 0, w, h).data
  }
  // Source row 0 lands at v = 0 unless flipY turns it over (an image's rows
  // are top-down, and flipY, its default, puts the top row at v = 1).
  const flip = !!texture.flipY
  const out = new Uint8Array(w * h * 4)
  const row = w * 4
  for (let y = 0; y < h; y++) {
    const from = (flip ? h - 1 - y : y) * row
    out.set(src.subarray(from, from + row), y * row)
  }
  return { data: out, width: w, height: h }
}

export function textureMessage(id, texture) {
  const px = texturePixels(texture)
  if (!px) return null
  // No repeat/offset: the G-buffer shader samples its map with raw UVs.
  const msg = {
    type: 'texture',
    id,
    data: px.data,
    width: px.width,
    height: px.height,
    wrapS: texture.wrapS,
    wrapT: texture.wrapT,
    colorSpace: texture.colorSpace,
  }
  return [msg, [px.data.buffer]]
}

export class SceneMirror {
  // post(message, transfer): delivers to the tracer worker.
  constructor(post) {
    this._post = post
    this._nextId = 1
    this._geometryIds = new WeakMap()
    // geometry id -> number of resident chunks drawing it
    this._geometryRefs = new Map()
    // material -> id; texture -> { id, version }
    this._materials = new Map()
    this._textures = new Map()
    // chunk -> { key, signature, geometries: [ids], used }
    this._chunks = new Map()
    this._builds = 0
    this.stats = { chunksSent: 0, geometriesSent: 0, texturesSent: 0 }
  }

  get residentChunks() {
    return this._chunks.size
  }

  _geometryId(g) {
    let id = this._geometryIds.get(g)
    if (!id) this._geometryIds.set(g, (id = this._nextId++))
    return id
  }

  _materialId(m) {
    let id = this._materials.get(m)
    if (!id) this._materials.set(m, (id = this._nextId++))
    return id
  }

  // Whether the worker holds the current version of `chunk`.
  holds(chunk) {
    const entry = this._chunks.get(chunk)
    return !!entry && entry.signature === chunkSignature(chunk)
  }

  // Send `chunk` unless the worker already holds this version of it.
  // Returns its key.
  ensureChunk(chunk) {
    const signature = chunkSignature(chunk)
    let entry = this._chunks.get(chunk)
    if (entry && entry.signature === signature) {
      entry.used = Math.max(entry.used, this._builds)
      return entry.key
    }
    if (entry) this._release(chunk, entry)
    const { items, transfer, geometries } = chunkItems(
      chunk.group,
      (g) => this._geometryId(g),
      (m) => this._materialId(m)
    )
    const ids = []
    for (const g of geometries) {
      const id = this._geometryId(g)
      ids.push(id)
      const refs = this._geometryRefs.get(id) ?? 0
      if (refs === 0) {
        const [msg, t] = geometryMessage(id, g)
        this._post(msg, t)
        this.stats.geometriesSent++
      }
      this._geometryRefs.set(id, refs + 1)
    }
    const key = this._nextId++
    entry = { key, signature, geometries: ids, used: this._builds }
    this._chunks.set(chunk, entry)
    this._post({ type: 'chunk', key, items }, transfer)
    this.stats.chunksSent++
    return key
  }

  // The current material table (and any texture the worker lacks or holds an
  // old version of). Sent before every scene build.
  syncMaterials(panelMaterial) {
    const textureId = (t) => {
      let e = this._textures.get(t)
      if (e && e.version === t.version) return e.id
      const id = e?.id ?? this._nextId++
      const sent = textureMessage(id, t)
      if (!sent) return null
      this._post(...sent)
      this.stats.texturesSent++
      this._textures.set(t, (e = { id, version: t.version }))
      return id
    }
    const list = []
    for (const [m, id] of this._materials) list.push(materialDescription(m, { id, panelMaterial, textureId }))
    this._post({ type: 'materials', list }, [])
  }

  // One scene build: the keys of `chunks` (sending what is missing), after
  // which chunks unused for CHUNK_KEEP_BUILDS builds are released.
  sceneChunks(chunks) {
    this._builds++
    const keys = chunks.map((c) => this.ensureChunk(c))
    for (const [chunk, entry] of this._chunks) {
      if (this._builds - entry.used >= CHUNK_KEEP_BUILDS) this._release(chunk, entry)
    }
    return keys
  }

  _release(chunk, entry) {
    this._chunks.delete(chunk)
    this._post({ type: 'dropChunk', key: entry.key }, [])
    for (const id of entry.geometries) {
      const refs = (this._geometryRefs.get(id) ?? 1) - 1
      if (refs > 0) {
        this._geometryRefs.set(id, refs)
      } else {
        this._geometryRefs.delete(id)
        this._post({ type: 'dropGeometry', id }, [])
      }
    }
  }
}
