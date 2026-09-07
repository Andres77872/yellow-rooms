import { bakeFurnitureGeometry, disposeModelScene } from './furnitureModels.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

// Blender-built enemy models (scripts/blender/build_enemies.py exports one GLB
// per entity into public/models/enemies/). Each GLB carries the whole figure
// in the entity local frame: front faces +z (the rotation.y=0 facing), origin
// at the footprint centre ON THE FLOOR — so an entity swaps its capsule
// silhouette mesh for the model with no placement math changes (meshYOffset 0).
//
// The bake is the furniture one: every primitive's material baseColorFactor
// becomes a `color` vertex attribute and all primitives merge into ONE
// BufferGeometry per entity. The shared `entityModel` G-buffer material
// (matID 2, USE_PART_COLOR) shades albedo = vertexColor, preserving the old
// capsule signature tints (Stalker ink, Pursuer blood-red, Husk ash) with
// per-part accents (pale oval head, pinpoint eyes, hollow void face).
export const ENEMY_MODEL_FILES = Object.freeze({
  stalker: 'stalker',
  pursuer: 'pursuer',
  husk: 'husk',
})

// Shared registry held by the Engine. Starts empty: entities keep their
// procedural capsule silhouettes until the GLBs arrive (or after a failed
// load), so the game never waits on the network.
export function createEnemyModelLibrary() {
  return { geometries: new Map(), loaded: false, failed: false, _revision: 0, _pending: null }
}

// Fetch and bake every entity's GLB. Resolves (never rejects): a missing or
// malformed model simply leaves that entity on the capsule fallback.
export function loadEnemyModels(library, { loader, baseUrl } = {}) {
  if (library._pending) return library._pending
  if (library.loaded) return Promise.resolve(library)
  const url = baseUrl ?? `${import.meta.env?.BASE_URL ?? '/'}models/enemies/`
  const base = url.endsWith('/') ? url : `${url}/`
  const gltf = loader ?? new GLTFLoader()
  const revision = library._revision
  const jobs = Object.entries(ENEMY_MODEL_FILES).map(async ([key, name]) => {
    let asset
    try {
      asset = await gltf.loadAsync(`${base}${name}.glb`)
      // A stopped engine can still have fetches in flight. Never repopulate a
      // disposed library (or replace a subsequent load) with stale results.
      if (revision !== library._revision) return
      const geometry = bakeFurnitureGeometry(asset.scene)
      if (geometry) {
        library.geometries.get(key)?.dispose()
        library.geometries.set(key, geometry)
      }
    } catch (err) {
      if (revision === library._revision) {
        console.warn(`[yellow-rooms] enemy model "${name}" failed to load; capsule fallback`, err)
      }
    } finally {
      // Only the merged geometry survives; release the original primitives,
      // materials and textures, including results received after disposal.
      if (asset?.scene) disposeModelScene(asset.scene)
    }
  })
  library._pending = Promise.all(jobs).then(() => {
    if (revision === library._revision) {
      library.loaded = library.geometries.size > 0
      library.failed = library.geometries.size === 0
      library._pending = null
    }
    return library
  })
  return library._pending
}

// Swap each entity's silhouette for its loaded model (skips whatever failed
// to load — that entity keeps its capsule). `material` is the shared
// entityModel G-buffer material (white base, per-part vertex colors).
export function upgradeEnemyModels(library, entities, material) {
  if (!library.loaded || !material) return
  for (const [key, entity] of Object.entries(entities)) {
    const geometry = library.geometries.get(key)
    if (geometry) entity.upgradeModel(geometry, material)
  }
}

export function disposeEnemyModels(library) {
  library._revision++
  library._pending = null
  for (const g of library.geometries.values()) g.dispose()
  library.geometries.clear()
  library.loaded = false
  library.failed = false
}
