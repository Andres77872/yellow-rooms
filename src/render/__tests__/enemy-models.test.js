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
  upgradeEnemyModels,
} from '../enemyModels.js'
import { Husk } from '../../entities/Husk.js'

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
