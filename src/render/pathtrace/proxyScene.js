import * as THREE from 'three'
import { CELL, CHUNK_WORLD, LIGHT_RANGE } from '../../world/constants.js'
import { lampTint } from '../../world/lampCharacter.js'
import { mirrorMaterial } from '../../debug/PbrReference.js'
import { FLASH_HAND_OFFSET } from '../flashFrame.js'

// Proxy scene for the experimental WebGPU path tracer (PathTraceView.js,
// PathTraceRealtime.js).
//
// The tracer only understands MeshStandard/MeshPhysical materials and stock
// lights, and it writes into what it is given: setScene() hangs a BVH on
// every geometry and, with generateMissingAttributes, adds attributes to it.
// So nothing the deferred renderer draws is handed over. Resident chunks
// near the camera are mirrored instead, in one of two layouts:
//
//   instanced (viewer)  InstancedMesh batches stay instanced. The WebGPU
//                       backend's two-level BVH consumes instance matrices and
//                       instanceColor directly, so proxies share the chunks'
//                       instance attributes read-only and geometry is cloned
//                       once per source geometry. Cheap to build, but the
//                       tracer's top-level BVH then spans every instance:
//                       setScene costs ~65 us per instance (0.45 s for a
//                       6.4k-instance neighbourhood, docs/pathracer/10).
//   merged (realtime)   every chunk is baked once into one world-space mesh
//                       per material (instanceColor folded into vertex
//                       colour) and cached per chunk. A streaming rebuild
//                       then packs tens of objects instead of thousands and
//                       only chunks new to the cache are merged.
//
// Materials map through debug/PbrReference's mirrorMaterial, are kept for
// the builder's lifetime, and are re-synced from their G-buffer source on
// every build (a family switch retints the proxies in place).
//
// Emitters (docs/pathracer/07-experiments.md E3):
//   - every lit panel near the camera becomes a downward RectAreaLight with
//     the panel's 1.7 x 1.0 footprint, 1 cm BELOW the recessed panel mesh.
//     On the panel plane it would be coplanar with the mesh (double-counted
//     light, shadow-ray ties), so the lit-panel material becomes a dark,
//     non-emissive diffuser; area lights are invisible to camera rays, so
//     panel faces read dark in the traced image;
//   - radiance = lamp power / panel area, so the panel's on-axis intensity
//     equals the engine's point emitter (LIGHT_INTENSITY x look.lampPower)
//     and its cosine falloff stands in for the diffuser profile;
//   - the tracer picks NEE lights uniformly, so light count drives noise
//     (E3: 148 panels were ~2x noisier than 9). Only panels within
//     LIGHT_RANGE + one cell are kept, nearest first, capped at maxLights.
//     The engine windows every fixture to zero at LIGHT_RANGE, so the
//     dropped lamps contribute nothing to the raster frame either.

// Lit-panel footprint (render/geometries.js: PlaneGeometry(1.7, 1.0)).
export const PANEL_W = 1.7
export const PANEL_D = 1.0
export const PANEL_AREA = PANEL_W * PANEL_D
// Chunk lamp points hang at WALL_H - 0.5 (world/mesh.js); the recessed panel
// mesh sits at WALL_H - 0.02. The area light goes 1 cm below the mesh.
const LAMP_POINT_DROP = 0.5
const PANEL_MESH_DROP = 0.02
const PANEL_LIGHT_CLEARANCE = 0.01
export const PANEL_LIGHT_LIFT = LAMP_POINT_DROP - PANEL_MESH_DROP - PANEL_LIGHT_CLEARANCE

export const DEFAULT_LIGHT_RADIUS = LIGHT_RANGE + CELL
export const DEFAULT_MAX_LIGHTS = 64
// Geometry reach: every surface the kept lamps can light, plus a margin so
// corridors do not end in a void within the first bounce.
export const DEFAULT_GEOMETRY_RADIUS = DEFAULT_LIGHT_RADIUS + 2 * CELL
// Merged chunk proxies unused for this many builds are released.
const CHUNK_CACHE_BUILDS = 3

// Flashlight disc radius for the tracer's spot light (m). A hand torch lens.
const FLASH_RADIUS = 0.02

const white = new THREE.Color(1, 1, 1)
const _pos = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _v = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _inst = new THREE.Matrix4()
const _nm = new THREE.Matrix3()
const _c = new THREE.Color()
const _tint = [1, 1, 1]

// Horizontal distance from (x, z) to a chunk's footprint (0 inside it).
function chunkDistance(chunk, x, z) {
  const minX = chunk.cx * CHUNK_WORLD
  const minZ = chunk.cz * CHUNK_WORLD
  const dx = Math.max(minX - x, 0, x - (minX + CHUNK_WORLD))
  const dz = Math.max(minZ - z, 0, z - (minZ + CHUNK_WORLD))
  return Math.hypot(dx, dz)
}

const hasApertures = (c) => (c?.apertures?.length ?? 0) > 0

// Chunks the traced view needs, within `radius` horizontally: the camera's
// floor, plus a neighbouring floor's chunk only where an opening joins it to
// the camera floor (Chunk.apertures are holes in a chunk's CEILING: stairs,
// atria, multilevel voids). Everywhere else the slabs seal a floor, so the
// other floors' geometry could never be hit and only costs build time.
export function selectChunks(chunks, x, z, floor, radius = DEFAULT_GEOMETRY_RADIUS) {
  const list = [...chunks]
  const at = new Map()
  for (const c of list) at.set(`${c.cx},${c.cy ?? 0},${c.cz}`, c)
  const out = []
  for (const c of list) {
    const cy = c.cy ?? 0
    if (Math.abs(cy - floor) > 1) continue
    if (cy === floor + 1 && !hasApertures(at.get(`${c.cx},${floor},${c.cz}`))) continue
    if (cy === floor - 1 && !hasApertures(c)) continue
    if (chunkDistance(c, x, z) > radius) continue
    out.push(c)
  }
  return out
}

// Candidate lamps without the ChunkManager's cross-floor policy: the
// camera's floor only (a lamp on another floor is behind a slab unless an
// aperture says otherwise, and only collectLampsNear knows that).
export function floorLamps(chunks, floor) {
  const out = []
  for (const c of chunks) for (const lamp of c.lamps ?? []) if ((lamp.cy ?? floor) === floor) out.push(lamp)
  return out
}

// Of `candidates`, the lamps within `radius` (3D) of `origin`, nearest
// first, at most `max`. Returns { kept, culled }.
export function selectLamps(candidates, origin, radius = DEFAULT_LIGHT_RADIUS, max = DEFAULT_MAX_LIGHTS) {
  const near = []
  for (const lamp of candidates) {
    const d = lamp.distanceTo(origin)
    if (d <= radius) near.push({ lamp, d })
  }
  near.sort((a, b) => a.d - b.d)
  const kept = near.slice(0, max).map((e) => e.lamp)
  return { kept, culled: candidates.length - kept.length }
}

// True when `node` and every ancestor below `root` is visible. The chunk
// group itself is skipped: its flag is the sight-culling result for the
// current eye, not whether the geometry exists (culled rooms still bounce).
function visibleBelow(node, root) {
  for (let n = node; n && n !== root; n = n.parent) if (!n.visible) return false
  return true
}

function triangleCount(geometry) {
  const n = geometry.index ? geometry.index.count : (geometry.attributes.position?.count ?? 0)
  return Math.floor(n / 3)
}

// The torch as a physical spot: the engine's smoothstep(cosOuter, cosInner)
// cone mapped onto three's angle / penumbra, 1/d^2 out to the torch range.
export function flashlightSpot({ color, intensity, range, cosInner, cosOuter }) {
  const outer = Math.acos(cosOuter)
  const inner = Math.acos(cosInner)
  const spot = new THREE.SpotLight(color, intensity, range, outer, 1 - inner / outer, 2)
  spot.radius = FLASH_RADIUS
  return spot
}

// Hand-offset origin, the camera's forward axis (the views re-aim it when
// the player looks around).
export function aimFlashlight(spot, camera) {
  camera.updateMatrixWorld()
  spot.position.set(...FLASH_HAND_OFFSET).applyMatrix4(camera.matrixWorld)
  camera.getWorldDirection(_dir)
  spot.target.position.copy(spot.position).addScaledVector(_dir, 10)
  spot.updateMatrixWorld()
  spot.target.updateMatrixWorld()
  return spot
}

// Re-read a G-buffer material's live uniforms into its proxy.
function syncMaterial(proxy, src) {
  const u = src.uniforms ?? {}
  if ((u.uMatID?.value ?? 0) === 1) {
    proxy.emissive?.copy(u.uColor?.value ?? white)
    return
  }
  if (u.uColor) proxy.color.copy(u.uColor.value)
  proxy.map = u.map?.value ?? null
  proxy.roughness = u.uRoughness?.value ?? 0.6
  proxy.metalness = u.uMetalness?.value ?? 0
}

// Signature of what a chunk's merged proxy was built from: detail tier and
// the furniture batch both swap child meshes in place.
function chunkSignature(chunk) {
  return `${chunk.renderDetail ?? ''}|${chunk.furnitureModelCount ?? 0}|${chunk.group.children.length}`
}

// True when `node` sits in one of the `skip` subtrees below `root`.
function inSkipped(node, root, skip) {
  if (!skip?.size) return false
  for (let n = node; n && n !== root; n = n.parent) if (skip.has(n)) return true
  return false
}

// Bake one chunk into world-space meshes, one per proxy material.
// instanceColor (and the part colour of USE_PART_COLOR materials) is folded
// into a vertex colour, so every merged proxy material uses vertexColors.
// Subtrees in `skip` are left out.
export function mergeChunk(root, materialFor, skip = null) {
  root.updateWorldMatrix(true, true)
  const buckets = new Map()
  let instances = 0
  root.traverse((node) => {
    if (!node.isMesh || node.isSkinnedMesh || !visibleBelow(node, root) || inSkipped(node, root, skip)) return
    const g = node.geometry
    const pos = g.attributes.position
    const count = node.isInstancedMesh ? node.count : 1
    if (!pos || count === 0) return
    const mats = Array.isArray(node.material) ? node.material : null
    const ranges = mats
      ? g.groups.map((gr) => ({ start: gr.start, count: gr.count, material: mats[gr.materialIndex] }))
      : [{ start: 0, count: g.index ? g.index.count : pos.count, material: node.material }]
    for (const range of ranges) {
      if (!range.material || range.count === 0) continue
      const proxy = materialFor(range.material)
      let b = buckets.get(proxy)
      if (!b) buckets.set(proxy, (b = { verts: 0, indices: 0, items: [] }))
      b.items.push({ node, g, range, count, partColor: !!range.material.defines?.USE_PART_COLOR })
      b.verts += pos.count * count
      b.indices += range.count * count
    }
    instances += count
  })

  const meshes = []
  let triangles = 0
  for (const [material, b] of buckets) {
    const position = new Float32Array(b.verts * 3)
    const normal = new Float32Array(b.verts * 3)
    const uv = new Float32Array(b.verts * 2)
    const color = new Float32Array(b.verts * 3)
    const index = new Uint32Array(b.indices)
    let vo = 0
    let io = 0
    for (const { node, g, range, count, partColor } of b.items) {
      const pos = g.attributes.position
      const nrm = g.attributes.normal
      const tex = g.attributes.uv
      const vcol = partColor ? g.attributes.color : null
      const idx = g.index
      for (let i = 0; i < count; i++) {
        if (node.isInstancedMesh) {
          node.getMatrixAt(i, _inst)
          _m.multiplyMatrices(node.matrixWorld, _inst)
          if (node.instanceColor) node.getColorAt(i, _c)
          else _c.copy(white)
        } else {
          _m.copy(node.matrixWorld)
          _c.copy(white)
        }
        _nm.getNormalMatrix(_m)
        const base = vo
        for (let k = 0; k < pos.count; k++, vo++) {
          _v.fromBufferAttribute(pos, k).applyMatrix4(_m)
          position[vo * 3] = _v.x
          position[vo * 3 + 1] = _v.y
          position[vo * 3 + 2] = _v.z
          if (nrm) {
            _v.fromBufferAttribute(nrm, k).applyMatrix3(_nm).normalize()
            normal[vo * 3] = _v.x
            normal[vo * 3 + 1] = _v.y
            normal[vo * 3 + 2] = _v.z
          }
          if (tex) {
            uv[vo * 2] = tex.getX(k)
            uv[vo * 2 + 1] = tex.getY(k)
          }
          const r = vcol ? vcol.getX(k) : 1
          const gg = vcol ? vcol.getY(k) : 1
          const bb = vcol ? vcol.getZ(k) : 1
          color[vo * 3] = _c.r * r
          color[vo * 3 + 1] = _c.g * gg
          color[vo * 3 + 2] = _c.b * bb
        }
        for (let k = range.start, end = range.start + range.count; k < end; k++) {
          index[io++] = base + (idx ? idx.getX(k) : k)
        }
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    geometry.setAttribute('color', new THREE.BufferAttribute(color, 3))
    // Proxies carry no normal maps: a zero tangent stops the tracer's
    // setScene from running computeTangents() over every merged chunk.
    geometry.setAttribute('tangent', new THREE.BufferAttribute(new Float32Array(b.verts * 4), 4))
    geometry.setIndex(new THREE.BufferAttribute(index, 1))
    const mesh = new THREE.Mesh(geometry, material)
    mesh.matrixAutoUpdate = false
    mesh.frustumCulled = false
    meshes.push(mesh)
    triangles += b.indices / 3
  }
  return { meshes, triangles, instances }
}

// Chunk render parts (Chunk.renderParts) the realtime tracer leaves out:
// trims, props, signs and dead panels hug walls and ceilings, change the
// lighting of a room very little, and are ~36% of a chunk's triangles, which
// setScene repacks on every streaming rebuild. Their pixels take the traced
// lighting of the surface right behind them. Furniture stays: desks and
// shelves really do shadow the floor.
export const REALTIME_SKIPPED_PARTS = ['frames', 'props', 'signs', 'deadPanels']

function skippedParts(chunk, names) {
  if (!names?.length || !chunk.renderParts) return null
  const out = new Set()
  for (const name of names) if (chunk.renderParts[name]) out.add(chunk.renderParts[name])
  return out
}

export class ProxySceneBuilder {
  constructor({ merged = false, skipParts = [] } = {}) {
    this.merged = merged
    this.skipParts = skipParts
    // Source geometry -> private clone (and, after the first setScene, its
    // BVH). Weak so furniture-model upgrades let old sources go.
    this._geometries = new WeakMap()
    this._clones = new Set()
    // G-buffer material -> proxy, for the builder's lifetime.
    this._materials = new Map()
    // Chunk -> merged proxy { signature, meshes, triangles, instances, used }.
    this._chunks = new Map()
    this._lights = []
    this._builds = 0
    this._panelMaterial = null
  }

  _geometry(src) {
    let g = this._geometries.get(src)
    if (!g) {
      g = src.clone()
      this._geometries.set(src, g)
      this._clones.add(g)
    }
    return g
  }

  _material(src) {
    if (Array.isArray(src)) return src.map((m) => this._material(m))
    let m = this._materials.get(src)
    if (m) return m
    if (src === this._panelMaterial) {
      // Lit panels: the RectAreaLight below each one is the emitter (see the
      // header). A dark diffuser keeps the recess visible without emitting.
      m = new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.4 })
    } else {
      m = mirrorMaterial(src)
    }
    m.side = src.side ?? THREE.FrontSide
    // Merged proxies carry instance/part colour in a vertex colour.
    if (this.merged) m.vertexColors = true
    this._materials.set(src, m)
    return m
  }

  // Rebuild the proxy scene. Materials and geometry (clones, merged chunks)
  // are cached; the previous lights are released.
  //
  //   chunks         resident Chunk objects ({ cx, cy, cz, group, lamps })
  //   camera         the player camera (world matrix current)
  //   floor          the camera's layer index
  //   center         where geometry is gathered around (default: the camera)
  //   lamps          candidate lit lamps, normally ChunkManager.collectLampsNear
  //                  (the engine's own cross-floor spill policy); defaults to
  //                  the selected chunks' lamps on `floor`
  //   panelMaterial  the shared lit-panel G-buffer material
  //   lampColor      linear THREE.Color of the family's lamp (uLampColor)
  //   lampPower      engine lamp intensity (uLampIntensity)
  //   flashlight     null, or { color, intensity, range, cosInner, cosOuter }
  build({
    chunks,
    camera,
    floor = 0,
    center = null,
    lamps = null,
    panelMaterial = null,
    lampColor = new THREE.Color(1, 1, 1),
    lampPower = 1,
    flashlight = null,
    geometryRadius = DEFAULT_GEOMETRY_RADIUS,
    lightRadius = DEFAULT_LIGHT_RADIUS,
    maxLights = DEFAULT_MAX_LIGHTS,
  }) {
    this._disposeLights()
    this._panelMaterial = panelMaterial
    this._builds++
    const scene = new THREE.Scene()
    const stats = {
      chunks: 0,
      meshes: 0,
      instances: 0,
      triangles: 0,
      lights: 0,
      culledLights: 0,
      flashlight: false,
      mergedChunks: 0,
    }

    camera.updateMatrixWorld()
    _pos.copy(center ?? _v.setFromMatrixPosition(camera.matrixWorld))
    const selected = selectChunks(chunks, _pos.x, _pos.z, floor, geometryRadius)
    stats.chunks = selected.length

    if (this.merged) this._addMerged(scene, selected, stats)
    else this._addInstanced(scene, selected, stats)
    // The lit-panel proxy is a fixed dark diffuser: never re-synced from its
    // (emissive) source.
    for (const [src, proxy] of this._materials) if (src !== panelMaterial) syncMaterial(proxy, src)

    const lit = this.setLights(scene, { camera, floor, lamps, chunks: selected, lampColor, lampPower, lightRadius, maxLights })
    stats.lights = lit.lights
    stats.culledLights = lit.culled

    let spot = null
    if (flashlight) {
      spot = flashlightSpot(flashlight)
      aimFlashlight(spot, camera)
      scene.add(spot, spot.target)
      this._lights.push(spot)
      stats.flashlight = true
    }

    scene.updateMatrixWorld(true)
    return { scene, stats, flashlight: spot }
  }

  _addInstanced(scene, selected, stats) {
    for (const chunk of selected) {
      const root = chunk.group
      root.updateWorldMatrix(true, true)
      root.traverse((node) => {
        if (!node.isMesh || node.isSkinnedMesh || !visibleBelow(node, root)) return
        const geometry = this._geometry(node.geometry)
        const material = this._material(node.material)
        let proxy
        if (node.isInstancedMesh) {
          if (node.count === 0) return
          proxy = new THREE.InstancedMesh(geometry, material, node.count)
          // Read-only share: the tracer reads matrices/colours at setScene.
          proxy.instanceMatrix = node.instanceMatrix
          if (node.instanceColor) proxy.instanceColor = node.instanceColor
          stats.instances += node.count
          stats.triangles += triangleCount(geometry) * node.count
        } else {
          proxy = new THREE.Mesh(geometry, material)
          stats.triangles += triangleCount(geometry)
        }
        proxy.matrixAutoUpdate = false
        proxy.matrix.copy(node.matrixWorld)
        proxy.matrixWorld.copy(node.matrixWorld)
        proxy.frustumCulled = false
        scene.add(proxy)
        stats.meshes++
      })
    }
  }

  _addMerged(scene, selected, stats) {
    const materialFor = (src) => this._material(src)
    for (const chunk of selected) {
      const signature = chunkSignature(chunk)
      let entry = this._chunks.get(chunk)
      if (!entry || entry.signature !== signature) {
        if (entry) this._releaseChunk(entry)
        entry = { signature, ...mergeChunk(chunk.group, materialFor, skippedParts(chunk, this.skipParts)) }
        this._chunks.set(chunk, entry)
        stats.mergedChunks++
      }
      entry.used = this._builds
      for (const mesh of entry.meshes) scene.add(mesh)
      stats.meshes += entry.meshes.length
      stats.instances += entry.instances
      stats.triangles += entry.triangles
    }
    for (const [chunk, entry] of this._chunks) {
      if (this._builds - entry.used >= CHUNK_CACHE_BUILDS) {
        this._releaseChunk(entry)
        this._chunks.delete(chunk)
      }
    }
  }

  // Spread the cost of the chunks a coming rebuild will select (merged mode):
  // merge at most one uncached chunk, then build bottom-level BVHs for
  // merged meshes that lack one (`buildBVH(geometry)`), until `budgetMs` is
  // spent. setScene reuses a geometry's existing boundsTree, so the rebuild
  // itself is left with only the top-level BVH and packing. Returns whether
  // work remains.
  prewarm(chunks, { x, z, floor = 0, radius = DEFAULT_GEOMETRY_RADIUS, budgetMs = 4, buildBVH, now = () => performance.now() }) {
    if (!this.merged) return false
    const t0 = now()
    const materialFor = (src) => this._material(src)
    let merged = false
    for (const chunk of selectChunks(chunks, x, z, floor, radius)) {
      const signature = chunkSignature(chunk)
      let entry = this._chunks.get(chunk)
      if (entry && entry.signature === signature) {
        entry.used = Math.max(entry.used ?? 0, this._builds)
      } else if (!merged) {
        if (entry) this._releaseChunk(entry)
        entry = { signature, used: this._builds, ...mergeChunk(chunk.group, materialFor, skippedParts(chunk, this.skipParts)) }
        this._chunks.set(chunk, entry)
        merged = true
      } else {
        return true
      }
      for (const mesh of entry.meshes) {
        if (mesh.geometry.boundsTree) continue
        if (now() - t0 >= budgetMs) return true
        buildBVH?.(mesh.geometry)
      }
    }
    return false
  }

  // Replace the panel lights in `scene` (the flashlight is left alone).
  // Cheap: the tracer only re-packs its light buffer (updateLights()).
  setLights(scene, { camera, floor = 0, lamps = null, chunks = [], lampColor, lampPower, lightRadius = DEFAULT_LIGHT_RADIUS, maxLights = DEFAULT_MAX_LIGHTS }) {
    for (let i = this._lights.length - 1; i >= 0; i--) {
      const l = this._lights[i]
      if (!l.isRectAreaLight) continue
      l.removeFromParent()
      l.dispose()
      this._lights.splice(i, 1)
    }
    camera.updateMatrixWorld()
    const eye = _v.setFromMatrixPosition(camera.matrixWorld)
    const candidates = lamps ?? floorLamps(chunks, floor)
    const { kept, culled } = selectLamps(candidates, eye, lightRadius, maxLights)
    for (const lamp of kept) {
      lampTint(lamp.x, lamp.z, lamp.cy ?? floor, _tint, lamp.role ?? 0)
      const color = new THREE.Color(_tint[0], _tint[1], _tint[2]).multiply(lampColor)
      const light = new THREE.RectAreaLight(color, lampPower / PANEL_AREA, PANEL_W, PANEL_D)
      light.position.set(lamp.x, lamp.y + PANEL_LIGHT_LIFT, lamp.z)
      // -Z (the emitting side) straight down; width stays on X like the panel.
      light.rotation.set(-Math.PI / 2, 0, 0)
      light.updateMatrixWorld()
      scene.add(light)
      this._lights.push(light)
    }
    return { lights: kept.length, culled }
  }

  _releaseChunk(entry) {
    for (const mesh of entry.meshes) {
      mesh.removeFromParent()
      mesh.geometry.boundsTree = null
      mesh.geometry.dispose()
    }
  }

  _disposeLights() {
    for (const l of this._lights) {
      l.removeFromParent()
      l.dispose?.()
    }
    this._lights.length = 0
  }

  dispose() {
    this._disposeLights()
    for (const m of this._materials.values()) m.dispose()
    this._materials.clear()
    for (const entry of this._chunks.values()) this._releaseChunk(entry)
    this._chunks.clear()
    for (const g of this._clones) {
      g.boundsTree = null
      g.dispose()
    }
    this._clones.clear()
    this._geometries = new WeakMap()
  }
}
