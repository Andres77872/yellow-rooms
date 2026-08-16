import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
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
// The deferred G-buffer pipeline consumes no glTF PBR data: at load time every
// primitive's material baseColorFactor is baked into a `color` vertex
// attribute and all primitives merge into ONE BufferGeometry per kind. The
// `furnitureModel` G-buffer material then shades albedo = vertexColor x
// per-instance tint, matching how the box path tinted each part.
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
// colors. Pure and loader-free (takes any Object3D subtree) so tests can feed
// hand-built meshes. Kept attributes: position, normal, uv, color — exactly
// what the instanced G-buffer vertex shader reads.
export function bakeFurnitureGeometry(root) {
  root.updateMatrixWorld(true)
  const parts = []
  root.traverse((node) => {
    if (!node.isMesh || !node.geometry?.attributes?.position) return
    const src = node.geometry
    const count = src.attributes.position.count
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', src.attributes.position.clone())
    if (src.attributes.normal) g.setAttribute('normal', src.attributes.normal.clone())
    if (src.attributes.uv) {
      g.setAttribute('uv', src.attributes.uv.clone())
    } else {
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2))
    }
    if (src.index) g.setIndex(src.index.clone())
    const color = node.material?.color
    const colors = new Float32Array(count * 3)
    const cr = color?.r ?? 1
    const cg = color?.g ?? 1
    const cb = color?.b ?? 1
    for (let i = 0; i < count; i++) {
      colors[i * 3] = cr
      colors[i * 3 + 1] = cg
      colors[i * 3 + 2] = cb
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    if (!src.attributes.normal) g.computeVertexNormals()
    g.applyMatrix4(node.matrixWorld)
    parts.push(g)
  })
  if (!parts.length) return null
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)
  if (parts.length > 1) for (const g of parts) g.dispose()
  if (!merged) return null
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  return merged
}

// Fetch and bake every kind's GLB. Resolves (never rejects): a missing or
// malformed model simply leaves that kind on the box-builder fallback.
export async function loadFurnitureModels(library, { loader, baseUrl } = {}) {
  const base = baseUrl ?? `${import.meta.env?.BASE_URL ?? '/'}models/furniture/`
  const gltf = loader ?? new GLTFLoader()
  const jobs = Object.entries(FURNITURE_MODEL_FILES).map(async ([kind, name]) => {
    try {
      const asset = await gltf.loadAsync(`${base}${name}.glb`)
      const geometry = bakeFurnitureGeometry(asset.scene)
      if (geometry) library.geometries.set(Number(kind), geometry)
    } catch (err) {
      console.warn(`[yellow-rooms] furniture model "${name}" failed to load; box fallback`, err)
    }
  })
  await Promise.all(jobs)
  library.loaded = library.geometries.size > 0
  library.failed = library.geometries.size === 0
  return library
}

export function disposeFurnitureModels(library) {
  for (const g of library.geometries.values()) g.dispose()
  library.geometries.clear()
  library.loaded = false
  library.failed = false
}
