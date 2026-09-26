import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { resolveGltfSurface } from './surfaces.js'
import {
  FURN_DESK,
  FURN_CHAIR,
  FURN_TABLE,
  FURN_CABINET,
  FURN_COPIER,
  FURN_COOLER,
  FURN_PLANT,
  FURN_RACK,
  FURN_SOFA,
  FURN_BOOKSHELF,
  FURN_WHITEBOARD,
  FURN_BED,
  FURN_NIGHTSTAND,
  FURN_WARDROBE,
  FURN_TOILET,
  FURN_SINK,
  FURN_TUB,
  FURN_COUNTER,
  FURN_STOVE,
  FURN_FRIDGE,
  FURN_TV,
  FURN_ARMCHAIR,
  FURN_WASHER,
} from '../world/furniture.js'

// Blender-built furniture models (scripts/blender/build_furniture.py exports
// one GLB per kind into public/models/furniture/). Each GLB carries the whole
// multi-part model in the SAME local frame the box builders used: u = width
// (x), v = depth (front toward +z), y = up, origin at the footprint centre on
// the floor — so mesh.js can swap one instanced box batch for one instanced
// GLB batch per kind using the same placement record (x, z, facing).
//
// At load time every primitive's material baseColorFactor is baked into a
// `color` vertex attribute and its material identity into a `surface`
// attribute (perceptual roughness, metalness — resolved through the
// render/surfaces.js vocabulary, falling back to the exported glTF factors),
// then all primitives merge into ONE BufferGeometry per kind. The
// `furnitureModel` G-buffer material shades albedo = vertexColor x
// per-instance tint and writes the preserved surface into G-buffer v2, so a
// chrome leg, a porcelain basin and a fabric seat respond differently to the
// same fixture instead of sharing one stylised gloss.
export const FURNITURE_MODEL_FILES = Object.freeze({
  [FURN_DESK]: 'desk',
  [FURN_CHAIR]: 'chair',
  [FURN_TABLE]: 'table',
  [FURN_CABINET]: 'cabinet',
  [FURN_COPIER]: 'copier',
  [FURN_COOLER]: 'cooler',
  [FURN_PLANT]: 'plant',
  [FURN_RACK]: 'rack',
  [FURN_SOFA]: 'sofa',
  [FURN_BOOKSHELF]: 'bookshelf',
  [FURN_WHITEBOARD]: 'whiteboard',
  [FURN_BED]: 'bed',
  [FURN_NIGHTSTAND]: 'nightstand',
  [FURN_WARDROBE]: 'wardrobe',
  [FURN_TOILET]: 'toilet',
  [FURN_SINK]: 'sink',
  [FURN_TUB]: 'tub',
  [FURN_COUNTER]: 'counter',
  [FURN_STOVE]: 'stove',
  [FURN_FRIDGE]: 'fridge',
  [FURN_TV]: 'tv',
  [FURN_ARMCHAIR]: 'armchair',
  [FURN_WASHER]: 'washer',
})

// Shared registry passed down Engine -> ChunkManager -> Chunk -> mesh.js.
// Starts empty: chunks meshed before the GLBs arrive (or after a failed load)
// use the procedural box builders, so the game never waits on the network.
export function createFurnitureModelLibrary() {
  return { geometries: new Map(), loaded: false, failed: false }
}

// Bake one loaded glTF scene into a single geometry with per-vertex part
// colors and surfaces. Pure and loader-free (takes any Object3D subtree) so
// tests can feed hand-built meshes. UVs are unused by the flat G-buffer
// fragment shader. Normalized 16-bit colors preserve dark linear ink tones
// within 1/65535 while using half of the previous color-buffer storage; the
// surface pair is normalized 8-bit (1/255 roughness steps are invisible).
export function bakeFurnitureGeometry(root) {
  root.updateMatrixWorld(true)
  const parts = []
  root.traverse((node) => {
    if (!node.isMesh || !node.geometry?.attributes?.position) return
    const g = bakeModelPart(node)
    // Preserve triangle winding under mirrors.
    if (node.matrixWorld.determinant() < 0) {
      for (let i = 0; i < g.index.count; i += 3) {
        const first = g.index.array[i]
        g.index.array[i] = g.index.array[i + 2]
        g.index.array[i + 2] = first
      }
    }
    g.applyMatrix4(node.matrixWorld)
    parts.push(g)
  })
  return mergeModelParts(parts)
}

// One glTF primitive -> position, normal, index, baked part `color` and
// `surface` in the node's LOCAL space. `skin` also copies the skinIndex /
// skinWeight pair, so a rig's primitives (which share one skin and one bind
// space) merge into a single SkinnedMesh geometry (render/enemyModels.js).
export function bakeModelPart(node, { skin = false } = {}) {
  const src = node.geometry
  const count = src.attributes.position.count
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', src.attributes.position.clone())
  if (src.attributes.normal) g.setAttribute('normal', src.attributes.normal.clone())
  // Normalize mixed indexed/non-indexed inputs so merging never silently
  // drops an otherwise valid model.
  const indices = src.index
    ? Array.from(src.index.array)
    : Array.from({ length: count }, (_, i) => i)
  g.setIndex(indices)
  const color = node.material?.color
  const colors = new Uint16Array(count * 3)
  const vertexColors = node.material?.vertexColors ? src.attributes.color : null
  const cr = color?.r ?? 1
  const cg = color?.g ?? 1
  const cb = color?.b ?? 1
  for (let i = 0; i < count; i++) {
    colors[i * 3] = Math.round(65535 * THREE.MathUtils.clamp(cr * (vertexColors?.getX(i) ?? 1), 0, 1))
    colors[i * 3 + 1] = Math.round(65535 * THREE.MathUtils.clamp(cg * (vertexColors?.getY(i) ?? 1), 0, 1))
    colors[i * 3 + 2] = Math.round(65535 * THREE.MathUtils.clamp(cb * (vertexColors?.getZ(i) ?? 1), 0, 1))
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3, true))
  const surf = resolveGltfSurface(node.material)
  const surface = new Uint8Array(count * 2)
  const r8 = Math.round(THREE.MathUtils.clamp(surf.roughness, 0, 1) * 255)
  const m8 = Math.round(THREE.MathUtils.clamp(surf.metalness, 0, 1) * 255)
  for (let i = 0; i < count; i++) {
    surface[i * 2] = r8
    surface[i * 2 + 1] = m8
  }
  g.setAttribute('surface', new THREE.BufferAttribute(surface, 2, true))
  if (skin) {
    g.setAttribute('skinIndex', src.attributes.skinIndex.clone())
    g.setAttribute('skinWeight', src.attributes.skinWeight.clone())
  }
  if (!src.attributes.normal) g.computeVertexNormals()
  return g
}

// Merge baked parts into one geometry (consumes the parts) with bounds.
export function mergeModelParts(parts) {
  if (!parts.length) return null
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)
  if (parts.length > 1) for (const g of parts) g.dispose()
  if (!merged) return null
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  return merged
}

// The baked geometry owns copies. Release the loader's discarded GPU resources
// once, even when primitives share materials or textures. Also used by enemies.
export function disposeModelScene(root) {
  const geometries = new Set()
  const materials = new Set()
  const textures = new Set()
  root?.traverse?.((node) => {
    if (node.geometry) geometries.add(node.geometry)
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (!material) continue
      materials.add(material)
      for (const value of Object.values(material)) {
        if (value?.isTexture) textures.add(value)
      }
    }
  })
  for (const geometry of geometries) geometry.dispose?.()
  for (const material of materials) material.dispose?.()
  for (const texture of textures) texture.dispose()
}

const pendingLoads = new WeakMap()

// Fetch and bake every kind's GLB. Resolves (never rejects): a missing or
// malformed model simply leaves that kind on the box-builder fallback.
export function loadFurnitureModels(library, { loader, baseUrl } = {}) {
  if (pendingLoads.has(library)) return pendingLoads.get(library).promise
  if (library.loaded) return Promise.resolve(library)
  const base = baseUrl ?? `${import.meta.env?.BASE_URL ?? '/'}models/furniture/`
  const gltf = loader ?? new GLTFLoader()
  const state = { promise: null }
  const entries = Object.entries(FURNITURE_MODEL_FILES)
  let next = 0
  async function worker() {
    while (next < entries.length && pendingLoads.get(library) === state) {
      const [kind, name] = entries[next++]
      let asset
      try {
        asset = await gltf.loadAsync(`${base}${name}.glb`)
        if (pendingLoads.get(library) !== state) continue
        const geometry = bakeFurnitureGeometry(asset.scene)
        if (geometry) library.geometries.set(Number(kind), geometry)
      } catch (err) {
        if (pendingLoads.get(library) === state) {
          console.warn(`[yellow-rooms] furniture model "${name}" failed to load; box fallback`, err)
        }
      } finally {
        disposeModelScene(asset?.scene)
      }
    }
  }
  pendingLoads.set(library, state)
  // Four requests keep startup bandwidth and transient parser allocations
  // bounded instead of constructing all 23 glTF scenes simultaneously.
  state.promise = Promise.all(Array.from({ length: 4 }, worker)).then(() => {
    if (pendingLoads.get(library) === state) {
      pendingLoads.delete(library)
      library.loaded = library.geometries.size > 0
      library.failed = library.geometries.size === 0
    }
    return library
  })
  return state.promise
}

export function disposeFurnitureModels(library) {
  // In-flight loads may still finish, but cannot repopulate a disposed library.
  pendingLoads.delete(library)
  for (const g of library.geometries.values()) g.dispose()
  library.geometries.clear()
  library.loaded = false
  library.failed = false
}
