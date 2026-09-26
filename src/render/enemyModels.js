import * as THREE from 'three'
import { bakeFurnitureGeometry, bakeModelPart, mergeModelParts, disposeModelScene } from './furnitureModels.js'
import { EnemyAnimator } from './enemyAnimator.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'

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
//
// Rigged GLBs (skin + named clips) additionally keep a rig TEMPLATE: the
// glTF bone hierarchy with ONE merged SkinnedMesh (same baked colors and
// surfaces, plus skinIndex/skinWeight) bound to it, and the clips. Each
// entity gets its own clone (independent skeleton + EnemyAnimator) on the
// shared geometry; the static geometry (the bind pose) stays available for
// previews and the non-skinned fallback.
export const ENEMY_MODEL_FILES = Object.freeze({
  stalker: 'stalker',
  pursuer: 'pursuer',
  husk: 'husk',
})

// Shared registry held by the Engine. Starts empty: entities keep their
// procedural capsule silhouettes until the GLBs arrive (or after a failed
// load), so the game never waits on the network.
export function createEnemyModelLibrary() {
  return { geometries: new Map(), rigs: new Map(), loaded: false, failed: false, _revision: 0, _pending: null }
}

// Turn a loaded glTF into a rig template, or null when it carries no skin.
// Every primitive of an exported figure shares one skin and one bind space,
// so they merge into a single SkinnedMesh (one draw call) bound to that
// skeleton. The detached source primitives are released here; the returned
// root (bones + merged mesh) is owned by the template.
export function bakeEnemyRig(asset) {
  const skinned = []
  asset?.scene?.traverse?.((node) => {
    if (node.isSkinnedMesh && node.geometry?.attributes?.position && node.geometry.attributes.skinWeight) {
      skinned.push(node)
    }
  })
  if (!skinned.length) return null
  const first = skinned[0]
  const bones = first.skeleton?.bones ?? []
  const shared = skinned.every(
    (m) => m.parent === first.parent && m.skeleton?.bones.length === bones.length &&
      m.skeleton.bones.every((bone, i) => bone === bones[i])
  )
  if (!shared || !bones.length) return null
  const geometry = mergeModelParts(skinned.map((m) => bakeModelPart(m, { skin: true })))
  if (!geometry) return null
  const mesh = new THREE.SkinnedMesh(geometry, null)
  mesh.name = first.name
  mesh.position.copy(first.position)
  mesh.quaternion.copy(first.quaternion)
  mesh.scale.copy(first.scale)
  // Authored poses (a raised reach, a rearing crawl) leave the bind-pose
  // bounds; three entities cost nothing to skip culling for.
  mesh.frustumCulled = false
  first.parent.add(mesh)
  mesh.bind(first.skeleton, first.bindMatrix)
  const released = new THREE.Group()
  for (const m of skinned) {
    m.removeFromParent()
    released.add(m)
  }
  disposeModelScene(released)
  return { geometry, root: asset.scene, clips: asset.animations ?? [] }
}

// One independently posed copy of a rig for an entity: cloned bones, a
// SkinnedMesh on the SHARED geometry, and its own animator.
export function createEnemyRig(kind, rig, material) {
  const object = cloneSkinned(rig.root)
  object.traverse((node) => {
    if (node.isSkinnedMesh) {
      node.material = material
      node.frustumCulled = false
    }
  })
  return { object, animator: new EnemyAnimator(kind, object, rig.clips) }
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
      const rig = bakeEnemyRig(asset)
      const geometry = rig ? rig.geometry : bakeFurnitureGeometry(asset.scene)
      if (geometry) {
        library.geometries.get(key)?.dispose()
        library.geometries.set(key, geometry)
        library.rigs.delete(key)
        if (rig) {
          library.rigs.set(key, rig)
          asset = null // the template now owns the scene
        }
      }
    } catch (err) {
      if (revision === library._revision) {
        console.warn(`[yellow-rooms] enemy model "${name}" failed to load; capsule fallback`, err)
      }
    } finally {
      // Only the merged geometry (and a rig's bones) survive; release the
      // original primitives, materials and textures, including results
      // received after disposal.
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
// entityModel G-buffer material (white base, per-part vertex colors);
// `skinnedMaterial` (entityModelSkinned) enables the rigged, animated path
// for entities that support it — without it they get the static bind pose.
export function upgradeEnemyModels(library, entities, material, skinnedMaterial = null) {
  if (!library.loaded || !material) return
  for (const [key, entity] of Object.entries(entities)) {
    const rig = library.rigs?.get(key)
    if (rig && skinnedMaterial && typeof entity.upgradeRig === 'function') {
      const { object, animator } = createEnemyRig(key, rig, skinnedMaterial)
      entity.upgradeRig(object, animator)
      continue
    }
    const geometry = library.geometries.get(key)
    if (geometry) entity.upgradeModel(geometry, material)
  }
}

export function disposeEnemyModels(library) {
  library._revision++
  library._pending = null
  for (const g of library.geometries.values()) g.dispose()
  library.geometries.clear()
  library.rigs?.clear()
  library.loaded = false
  library.failed = false
}
