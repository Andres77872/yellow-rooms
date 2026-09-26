import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { bakeFurnitureGeometry } from '../furnitureModels.js'
import {
  ENEMY_MODEL_FILES,
  createEnemyModelLibrary,
  loadEnemyModels,
  disposeEnemyModels,
  upgradeEnemyModels,
} from '../enemyModels.js'
import { Husk } from '../../entities/Husk.js'
import { Stalker } from '../../entities/Stalker.js'
import { Pursuer } from '../../entities/Pursuer.js'

// The Blender pipeline (scripts/blender/build_enemies.py) exports one GLB per
// entity. These tests lock the export contract the runtime relies on: origin
// at the footprint centre on the floor (entities stand at meshYOffset 0), Y-up,
// front facing +z (the rotation.y=0 direction), and every primitive
// materialized (its baseColorFactor becomes the baked per-vertex part tint in
// the entityModel G-buffer lane).

const MODELS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../public/models/enemies'
)

// Design budgets (mirror the MODELS audit table in build_enemies.py).
const EXPECTED = {
  stalker: { w: 0.9, d: 0.9, h: 2.45 },
  pursuer: { w: 1.3, d: 1.5, h: 1.35 },
  husk: { w: 0.8, d: 0.8, h: 1.9 },
}

const TOL = 0.1

function glbJson(file) {
  const buf = readFileSync(path.join(MODELS_DIR, file))
  expect(buf.readUInt32LE(0)).toBe(0x46546c67) // 'glTF' magic
  const jsonLen = buf.readUInt32LE(12)
  return JSON.parse(buf.toString('utf8', 20, 20 + jsonLen))
}

function positionBounds(json) {
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  for (const mesh of json.meshes) {
    for (const prim of mesh.primitives) {
      const acc = json.accessors[prim.attributes.POSITION]
      for (let i = 0; i < 3; i++) {
        mn[i] = Math.min(mn[i], acc.min[i])
        mx[i] = Math.max(mx[i], acc.max[i])
      }
    }
  }
  return { mn, mx }
}

describe('enemy GLB exports (Blender pipeline contract)', () => {
  it('exports exactly one GLB per entity kind', () => {
    const keys = Object.keys(ENEMY_MODEL_FILES)
    expect(keys).toEqual(['stalker', 'pursuer', 'husk'])
    for (const key of keys) {
      const json = glbJson(`${ENEMY_MODEL_FILES[key]}.glb`)
      expect(json.meshes.length).toBeGreaterThan(0)
      // Every primitive needs a material: its baseColorFactor becomes the
      // baked per-vertex part color in the G-buffer lane.
      for (const mesh of json.meshes) {
        for (const prim of mesh.primitives) {
          expect(prim.material).toBeTypeOf('number')
        }
      }
      expect(json.cameras ?? []).toHaveLength(0)
      expect(json.extensionsRequired ?? []).toHaveLength(0)
      expect(json.textures ?? []).toHaveLength(0)
      let triangles = 0
      for (const mesh of json.meshes) {
        for (const primitive of mesh.primitives) {
          expect(primitive.attributes.TEXCOORD_0).toBeUndefined()
          // Painted vertex shading multiplier (scripts/blender/yr_shading.py).
          expect(json.accessors[primitive.attributes.COLOR_0])
            .toMatchObject({ componentType: 5121, normalized: true, type: 'VEC4' })
          triangles += json.accessors[primitive.indices].count / 3
        }
      }
      // Budgets mirror build_enemies.py: joint rings for the bending knees and
      // elbows, and the skin + clips roughly double the static bytes.
      expect(triangles).toBeLessThanOrEqual(3200)
      expect(readFileSync(path.join(MODELS_DIR, `${ENEMY_MODEL_FILES[key]}.glb`)).length).toBeLessThan(150_000)
    }
  })

  it.each(Object.entries(ENEMY_MODEL_FILES))(
    '%s stays on the floor and inside its design budget',
    (key, file) => {
      const { mn, mx } = positionBounds(glbJson(`${file}.glb`))
      const budget = EXPECTED[key]
      expect(mn[1]).toBeGreaterThanOrEqual(-0.005) // origin sits ON the floor
      expect(mx[0] - mn[0]).toBeLessThanOrEqual(budget.w + TOL)
      expect(mx[2] - mn[2]).toBeLessThanOrEqual(budget.d + TOL)
      expect(mx[1]).toBeLessThanOrEqual(budget.h + TOL)
      expect(Math.abs((mn[0] + mx[0]) / 2)).toBeLessThanOrEqual(0.15) // centred
    }
  )

  it.each(Object.entries(ENEMY_MODEL_FILES))(
    '%s faces +z (entity rotation.y=0 facing)',
    (key, file) => {
      const { mn, mx } = positionBounds(glbJson(`${file}.glb`))
      // Facial features / snout / feet sit on the +z half; the back is short.
      expect(mx[2]).toBeGreaterThan(Math.abs(mn[2]))
    }
  )

  it('library starts empty so entities keep the capsule fallback', () => {
    const lib = createEnemyModelLibrary()
    expect(lib.loaded).toBe(false)
    expect(lib.geometries.size).toBe(0)
  })

  it('loads a real exported GLB into one tinted geometry per entity', async () => {
    for (const file of Object.values(ENEMY_MODEL_FILES)) {
      const buf = readFileSync(path.join(MODELS_DIR, `${file}.glb`))
      const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      const scene = await new Promise((resolve, reject) => {
        new GLTFLoader().parse(arrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
      })
      const geo = bakeFurnitureGeometry(scene)
      expect(geo).not.toBeNull()
      expect(geo.boundingBox.min.y).toBeGreaterThanOrEqual(-0.005)
      expect(geo.attributes.uv).toBeUndefined()
      expect(geo.groups).toHaveLength(0) // one draw call through the shared material
      // Per-part tints survive the bake as distinct vertex-color runs.
      const distinct = new Set()
      for (let i = 0; i < geo.attributes.color.count; i++) {
        distinct.add(
          `${geo.attributes.color.getX(i).toFixed(3)},` +
            `${geo.attributes.color.getY(i).toFixed(3)},` +
            `${geo.attributes.color.getZ(i).toFixed(3)}`
        )
      }
      expect(distinct.size).toBeGreaterThanOrEqual(2)
      geo.dispose()
    }
  })
})

describe('upgradeEnemyModels', () => {
  it('swaps entity geometry/material and resets scale + feet offset', () => {
    const husk = new Husk({ add() {} }, { husk: undefined }, { husk: undefined }, {})
    expect(husk.meshYOffset).toBeGreaterThan(0) // capsule: origin-centred
    const geo = new THREE.BoxGeometry(1, 1, 1)
    const material = { stub: true }
    husk.upgradeModel(geo, material)
    expect(husk.mesh.geometry).toBe(geo)
    expect(husk.mesh.material).toBe(material)
    expect(husk.mesh.scale.x).toBe(1)
    expect(husk.mesh.scale.y).toBe(1)
    expect(husk.meshYOffset).toBe(0) // GLB origin sits on the floor
    geo.dispose()
  })

  it.each([Husk, Stalker, Pursuer])('places a frozen %s at its feet in the upgrade frame', (Entity) => {
    const entity = new Entity({ add() {} }, {}, {}, {})
    entity.active = true
    entity.frozen = true
    entity.pos.set(7, 3.6, -2)
    entity.mesh.position.set(7, 3.6 + entity.meshYOffset, -2)
    entity.mesh.rotation.y = 0.72
    entity.mesh.visible = true
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    entity.upgradeModel(geometry, {})
    expect(entity.mesh.position.equals(entity.pos)).toBe(true)
    expect(entity.mesh.rotation.y).toBe(0.72)
    expect(entity.mesh.visible).toBe(true)
    expect(entity.active).toBe(true)
    geometry.dispose()
  })

  it('upgrades only entities with a loaded geometry', () => {
    const lib = createEnemyModelLibrary()
    const geo = new THREE.BoxGeometry(1, 1, 1)
    lib.geometries.set('stalker', geo)
    lib.loaded = true
    const stalker = { upgradeModel: vi.fn() }
    const pursuer = { upgradeModel: vi.fn() }
    upgradeEnemyModels(lib, { stalker, pursuer }, { stub: true })
    expect(stalker.upgradeModel).toHaveBeenCalledWith(geo, { stub: true })
    expect(pursuer.upgradeModel).not.toHaveBeenCalled() // no GLB -> capsule
    geo.dispose()
  })

  it('is a no-op when nothing loaded or the material is missing', () => {
    const lib = createEnemyModelLibrary()
    const stalker = { upgradeModel: vi.fn() }
    upgradeEnemyModels(lib, { stalker }, { stub: true })
    lib.loaded = true
    lib.geometries.set('stalker', new THREE.BoxGeometry(1, 1, 1))
    upgradeEnemyModels(lib, { stalker }, null)
    expect(stalker.upgradeModel).not.toHaveBeenCalled()
  })
})

function sourceAsset() {
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const material = new THREE.MeshStandardMaterial({ color: 0x776644 })
  const scene = new THREE.Group()
  scene.add(new THREE.Mesh(geometry, material))
  return { scene, geometry, material }
}

describe('enemy model loading lifecycle', () => {
  it('shares in-flight work and releases source resources after baking', async () => {
    const library = createEnemyModelLibrary()
    const assets = []
    const loader = { loadAsync: vi.fn(async () => {
      const asset = sourceAsset()
      vi.spyOn(asset.geometry, 'dispose')
      vi.spyOn(asset.material, 'dispose')
      assets.push(asset)
      return asset
    }) }
    const first = loadEnemyModels(library, { loader, baseUrl: '/models' })
    expect(loadEnemyModels(library, { loader })).toBe(first)
    await first
    expect(loader.loadAsync).toHaveBeenCalledTimes(3)
    expect(loader.loadAsync).toHaveBeenCalledWith('/models/stalker.glb')
    expect(library.loaded).toBe(true)
    expect(library.failed).toBe(false)
    expect(library.geometries.size).toBe(3)
    await loadEnemyModels(library, { loader })
    expect(loader.loadAsync).toHaveBeenCalledTimes(3) // resident assets are reused
    for (const asset of assets) {
      expect(asset.geometry.dispose).toHaveBeenCalledOnce()
      expect(asset.material.dispose).toHaveBeenCalledOnce()
      expect([...library.geometries.values()]).not.toContain(asset.geometry)
    }
    disposeEnemyModels(library)
  })

  it('discards delayed results after disposal without reviving the library', async () => {
    const library = createEnemyModelLibrary()
    const pending = []
    const loader = { loadAsync: () => new Promise((resolve) => pending.push(resolve)) }
    const loading = loadEnemyModels(library, { loader })
    disposeEnemyModels(library)
    const assets = pending.map((resolve) => {
      const asset = sourceAsset()
      vi.spyOn(asset.geometry, 'dispose')
      vi.spyOn(asset.material, 'dispose')
      resolve(asset)
      return asset
    })
    await loading
    expect(library.geometries.size).toBe(0)
    expect(library.loaded).toBe(false)
    expect(library.failed).toBe(false)
    for (const asset of assets) {
      expect(asset.geometry.dispose).toHaveBeenCalledOnce()
      expect(asset.material.dispose).toHaveBeenCalledOnce()
    }
  })

  it('an old load cannot overwrite a new library generation', async () => {
    const library = createEnemyModelLibrary()
    const pending = []
    const first = loadEnemyModels(library, {
      loader: { loadAsync: () => new Promise((resolve) => pending.push(resolve)) },
    })
    disposeEnemyModels(library)
    await loadEnemyModels(library, { loader: { loadAsync: async () => sourceAsset() } })
    const current = [...library.geometries.values()]
    for (const resolve of pending) resolve(sourceAsset())
    await first
    expect([...library.geometries.values()]).toEqual(current)
    expect(library.loaded).toBe(true)
    disposeEnemyModels(library)
  })

  it('keeps successful enemies when another file fails', async () => {
    const library = createEnemyModelLibrary()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await loadEnemyModels(library, { loader: { loadAsync: async (url) => {
        if (url.endsWith('pursuer.glb')) throw new Error('missing asset')
        return sourceAsset()
      } } })
      expect([...library.geometries.keys()]).toEqual(['stalker', 'husk'])
      expect(library.loaded).toBe(true)
      expect(library.failed).toBe(false)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
      disposeEnemyModels(library)
    }
  })

  it('resolves to the capsule fallback when every scene is malformed', async () => {
    const library = createEnemyModelLibrary()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(loadEnemyModels(library, {
        loader: { loadAsync: async () => ({ scene: {} }) },
      })).resolves.toBe(library)
      expect(library.loaded).toBe(false)
      expect(library.failed).toBe(true)
      expect(library.geometries.size).toBe(0)
    } finally {
      warn.mockRestore()
      disposeEnemyModels(library)
    }
  })
})
