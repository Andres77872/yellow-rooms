import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  FURNITURE_MODEL_FILES,
  bakeFurnitureGeometry,
  createFurnitureModelLibrary,
  loadFurnitureModels,
  disposeFurnitureModels,
  disposeModelScene,
} from '../furnitureModels.js'
import {
  CHAIR_W,
  DESK_D,
  DESK_W,
  TABLE_D,
  TABLE_W,
} from '../../world/constants.js'
import { PIECE_DIMS } from '../../world/rooms/furnish.js'
import { FURN_BED, FURN_CHAIR, FURN_DESK, FURN_TABLE } from '../../world/furniture.js'
import { buildChunkMeshes } from '../../world/mesh.js'
import { Chunk } from '../../world/Chunk.js'
import { ChunkData } from '../../world/ChunkData.js'
import { DEFAULT_WORLD_CONFIG } from '../../world/config.js'
import { createGeometries } from '../geometries.js'

// The Blender pipeline (scripts/blender/build_furniture.py) exports one GLB
// per furniture kind. These tests lock the export contract the runtime loader
// and the collision system rely on: origin at the footprint centre on the
// floor, Y-up, and horizontal extents inside the collision AABB (rooms/
// furnish.js sweeps a 2D box from these dims — geometry must not protrude).

const MODELS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../public/models/furniture'
)

// furnish.js bypasses PIECE_DIMS for the conference/workstation kinds.
const EXPECTED_DIMS = {
  ...PIECE_DIMS,
  [FURN_TABLE]: [TABLE_W, TABLE_D],
  [FURN_CHAIR]: [CHAIR_W, CHAIR_W],
  [FURN_DESK]: [DESK_W, DESK_D],
}

// Height budgets per kind (mirrors the audit table in build_furniture.py).
const EXPECTED_HEIGHT = {
  [FURN_DESK]: 1.36,
  [FURN_CHAIR]: 0.98,
  [FURN_TABLE]: 0.8,
  [FURN_BED]: 1.32,
}

const TOL_XZ = 0.15 // rim/cornice/tray overhangs the box builders already had
const TOL_CENTER = 0.12 // asymmetric accents (cooler cup tube, sink towel bar)
const TOL_H = 0.06

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

async function readModel(name) {
  const buffer = readFileSync(path.join(MODELS_DIR, `${name}.glb`))
  return new GLTFLoader().parseAsync(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), ''
  )
}

describe('furniture GLB exports (Blender pipeline contract)', () => {
  it('exports exactly one GLB per furniture kind', () => {
    const kinds = Object.keys(FURNITURE_MODEL_FILES)
    expect(kinds.length).toBe(23)
    for (const kind of kinds) {
      const json = glbJson(`${FURNITURE_MODEL_FILES[kind]}.glb`)
      expect(json.meshes.length).toBeGreaterThan(0)
      // Every primitive needs a material: its baseColorFactor becomes the
      // baked per-vertex part color in the G-buffer lane.
      for (const mesh of json.meshes) {
        for (const prim of mesh.primitives) {
          expect(prim.material).toBeTypeOf('number')
          expect(prim.attributes.TEXCOORD_0).toBeUndefined()
          // Painted vertex shading (yr_shading.py): a compact normalized
          // UNSIGNED_BYTE multiplier the bake folds into the part color.
          const color = json.accessors[prim.attributes.COLOR_0]
          expect(color).toMatchObject({ componentType: 5121, normalized: true, type: 'VEC4' })
        }
      }
      expect(json.cameras ?? []).toHaveLength(0)
      expect(json.extensionsRequired ?? []).toHaveLength(0)
    }
  })

  it('keeps the painted COLOR_0 multiplier gentle (the game adds SSAO on top)', async () => {
    for (const name of Object.values(FURNITURE_MODEL_FILES)) {
      const { scene } = await readModel(name)
      let lo = Infinity, sum = 0, count = 0
      scene.traverse((node) => {
        const color = node.isMesh ? node.geometry.attributes.color : null
        if (!color) return
        expect(node.material.vertexColors, name).toBe(true)
        for (let i = 0; i < color.count; i++) {
          const v = (color.getX(i) + color.getY(i) + color.getZ(i)) / 3
          lo = Math.min(lo, v)
          sum += v
          count++
        }
      })
      expect(count, name).toBeGreaterThan(0)
      expect(lo, name).toBeGreaterThanOrEqual(0.6) // never crushes toward black
      expect(sum / count, name).toBeGreaterThan(0.72)
      disposeModelScene(scene)
    }
  })

  it('keeps the full set within transfer and triangle budgets', () => {
    let bytes = 0, triangles = 0
    for (const name of Object.values(FURNITURE_MODEL_FILES)) {
      bytes += readFileSync(path.join(MODELS_DIR, `${name}.glb`)).byteLength
      const json = glbJson(`${name}.glb`)
      for (const mesh of json.meshes) {
        for (const primitive of mesh.primitives) triangles += json.accessors[primitive.indices].count / 3
      }
    }
    expect(bytes).toBeLessThan(650_000)
    expect(triangles).toBeLessThan(20_000)
  })

  it('exports usable normals and nondegenerate, correctly wound triangles for every kind', async () => {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const normal = new THREE.Vector3()
    for (const name of Object.values(FURNITURE_MODEL_FILES)) {
      const { scene } = await readModel(name)
      const geometry = bakeFurnitureGeometry(scene)
      const positions = geometry.attributes.position
      const normals = geometry.attributes.normal
      for (let i = 0; i < positions.count; i++) {
        expect(Number.isFinite(positions.getX(i) + positions.getY(i) + positions.getZ(i))).toBe(true)
        expect(normal.fromBufferAttribute(normals, i).length()).toBeCloseTo(1, 4)
      }
      for (let i = 0; i < geometry.index.count; i += 3) {
        const ia = geometry.index.getX(i)
        a.fromBufferAttribute(positions, ia)
        b.fromBufferAttribute(positions, geometry.index.getX(i + 1)).sub(a)
        c.fromBufferAttribute(positions, geometry.index.getX(i + 2)).sub(a)
        b.cross(c)
        expect(b.lengthSq(), name).toBeGreaterThan(1e-16)
        expect(b.normalize().dot(normal.fromBufferAttribute(normals, ia)), name).toBeGreaterThan(-0.001)
      }
      geometry.dispose()
      disposeModelScene(scene)
    }
  })

  it.each([
    ['tub', 0, 0, 0.2],
    ['sink', 0, 0.02, 0.83],
    ['toilet', 0, 0.06, 0.4],
  ])('%s has a recessed basin opening instead of a solid cap', async (name, x, z, maxHeight) => {
    const { scene } = await readModel(name)
    scene.updateMatrixWorld(true)
    const ray = new THREE.Raycaster(new THREE.Vector3(x, 3, z), new THREE.Vector3(0, -1, 0))
    const intersections = ray.intersectObject(scene, true)
    expect(intersections.length).toBeGreaterThan(0)
    expect(intersections[0].point.y).toBeLessThan(maxHeight)
    disposeModelScene(scene)
  })

  it.each(Object.entries(FURNITURE_MODEL_FILES))(
    'kind %s stays on the floor and inside its collision footprint',
    (kind, file) => {
      const { mn, mx } = positionBounds(glbJson(`${file}.glb`))
      const [w, d] = EXPECTED_DIMS[kind]
      expect(mn[1]).toBeGreaterThanOrEqual(-0.005) // origin sits ON the floor
      expect(mx[0] - mn[0]).toBeLessThanOrEqual(w + TOL_XZ)
      expect(mx[2] - mn[2]).toBeLessThanOrEqual(d + TOL_XZ)
      expect(Math.abs((mn[0] + mx[0]) / 2)).toBeLessThanOrEqual(TOL_CENTER)
      expect(Math.abs((mn[2] + mx[2]) / 2)).toBeLessThanOrEqual(TOL_CENTER)
      const budget = EXPECTED_HEIGHT[kind] ?? 2.1
      expect(mx[1]).toBeLessThanOrEqual(budget + TOL_H)
      expect(mx[1]).toBeGreaterThan(0.5) // every piece reads as furniture
    }
  )
})

describe('bakeFurnitureGeometry', () => {
  function coloredBox(color, x, y, z, size = 1) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size, size, size),
      new THREE.MeshStandardMaterial({ color })
    )
    mesh.position.set(x, y, z)
    return mesh
  }

  it('merges primitives and bakes material colors into vertex colors', () => {
    const root = new THREE.Group()
    root.add(coloredBox(0xff0000, 0, 0, 0))
    root.add(coloredBox(0x00ff00, 2, 0, 0))
    const geo = bakeFurnitureGeometry(root)
    expect(geo).not.toBeNull()
    expect(geo.attributes.position.count).toBe(48) // two indexed boxes
    expect(geo.attributes.color).toBeDefined()
    expect(geo.attributes.normal).toBeDefined()
    expect(geo.attributes.uv).toBeUndefined()
    expect(geo.attributes.color.array).toBeInstanceOf(Uint16Array)
    expect(geo.attributes.color.normalized).toBe(true)
    // First box red, second green — in bake order.
    expect(geo.attributes.color.getX(0)).toBeCloseTo(1, 5)
    expect(geo.attributes.color.getY(0)).toBeCloseTo(0, 5)
    expect(geo.attributes.color.getY(24)).toBeCloseTo(1, 5)
    // World transforms baked: merged bounds span both boxes.
    expect(geo.boundingBox.min.x).toBeCloseTo(-0.5, 5)
    expect(geo.boundingBox.max.x).toBeCloseTo(2.5, 5)
  })

  it('defaults to white when a mesh has no material color', () => {
    const root = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    mesh.material = {}
    root.add(mesh)
    const geo = bakeFurnitureGeometry(root)
    expect(geo.attributes.color.getX(0)).toBe(1)
    expect(geo.attributes.color.getY(0)).toBe(1)
    expect(geo.attributes.color.getZ(0)).toBe(1)
  })

  it('returns null for an empty subtree', () => {
    expect(bakeFurnitureGeometry(new THREE.Group())).toBeNull()
  })

  it('preserves authored vertex colors and merges mixed triangle indexing', () => {
    const root = new THREE.Group()
    const mesh = coloredBox(0xffffff, 0, 0, 0)
    mesh.material.color.setRGB(0.5, 0.25, 1)
    mesh.material.vertexColors = true
    const colors = new Float32Array(mesh.geometry.attributes.position.count * 3).fill(0.5)
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    root.add(mesh)
    const unindexed = coloredBox(0xffffff, 2, 0, 0)
    unindexed.geometry = unindexed.geometry.toNonIndexed()
    root.add(unindexed)
    const geometry = bakeFurnitureGeometry(root)
    expect(geometry.index.count).toBe(72)
    expect(geometry.attributes.color.getX(0)).toBeCloseTo(0.25, 2)
    expect(geometry.attributes.color.getY(0)).toBeCloseTo(0.125, 2)
    expect(geometry.attributes.color.getZ(0)).toBeCloseTo(0.5, 2)
    expect(geometry.boundingBox.max.x).toBeCloseTo(2.5)
  })

  it('preserves near-black linear palette channels without clipping them to zero', () => {
    const mesh = coloredBox(0xffffff, 0, 0, 0)
    mesh.material.color.setRGB(0.0009, 0.00212, 0.00304)
    const geometry = bakeFurnitureGeometry(mesh)
    expect(geometry.attributes.color.getX(0)).toBeCloseTo(0.0009, 4)
    expect(geometry.attributes.color.getY(0)).toBeCloseTo(0.00212, 4)
    expect(geometry.attributes.color.getZ(0)).toBeCloseTo(0.00304, 4)
  })

  it.each([true, false])('keeps mirrored front faces aligned with normals (authored normals: %s)', (authoredNormals) => {
    const mesh = coloredBox(0xffffff, 0, 0, 0)
    mesh.scale.x = -1
    if (!authoredNormals) mesh.geometry.deleteAttribute('normal')
    const geometry = bakeFurnitureGeometry(mesh)
    const position = geometry.attributes.position
    const normal = geometry.attributes.normal
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const n = new THREE.Vector3()
    for (let i = 0; i < geometry.index.count; i += 3) {
      const ia = geometry.index.getX(i)
      a.fromBufferAttribute(position, ia)
      b.fromBufferAttribute(position, geometry.index.getX(i + 1))
      c.fromBufferAttribute(position, geometry.index.getX(i + 2))
      n.fromBufferAttribute(normal, ia)
      expect(b.sub(a).cross(c.sub(a)).normalize().dot(n)).toBeGreaterThan(0.99)
    }
  })

  it('loads a real exported GLB through GLTFLoader into one tinted geometry', async () => {
    const buf = readFileSync(path.join(MODELS_DIR, 'desk.glb'))
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const scene = await new Promise((resolve, reject) => {
      new GLTFLoader().parse(arrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
    })
    expect(scene).not.toBeNull()
    const geo = bakeFurnitureGeometry(scene)
    expect(geo).not.toBeNull()
    // Several part tints survive the bake as distinct vertex-color runs.
    const distinct = new Set()
    for (let i = 0; i < geo.attributes.color.count; i++) {
      distinct.add(
        `${geo.attributes.color.getX(i).toFixed(3)},` +
          `${geo.attributes.color.getY(i).toFixed(3)},` +
          `${geo.attributes.color.getZ(i).toFixed(3)}`
      )
    }
    expect(distinct.size).toBeGreaterThan(4)
    expect(geo.boundingBox.min.y).toBeGreaterThanOrEqual(-0.005)
    expect(geo.boundingBox.max.x - geo.boundingBox.min.x).toBeCloseTo(DESK_W, 2)
    expect(geo.boundingBox.max.z - geo.boundingBox.min.z).toBeCloseTo(DESK_D, 2)
  })

  it('library starts empty so chunks fall back to box builders', () => {
    const lib = createFurnitureModelLibrary()
    expect(lib.loaded).toBe(false)
    expect(lib.geometries.size).toBe(0)
  })
})

describe('furniture model loading lifecycle', () => {
  it('keeps malformed and missing kinds on fallback while loading the rest', async () => {
    const library = createFurnitureModelLibrary()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loader = { loadAsync: async (url) => {
      if (url.endsWith('/desk.glb')) return { scene: {} }
      if (url.endsWith('/chair.glb')) throw new Error('missing asset')
      return { scene: new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()) }
    } }
    try {
      await expect(loadFurnitureModels(library, { loader })).resolves.toBe(library)
      expect(library.geometries.size).toBe(21)
      expect(library.geometries.has(FURN_DESK)).toBe(false)
      expect(library.geometries.has(FURN_CHAIR)).toBe(false)
      expect(library.loaded).toBe(true)
      expect(library.failed).toBe(false)
      expect(warning).toHaveBeenCalledTimes(2)
    } finally {
      warning.mockRestore()
      disposeFurnitureModels(library)
    }
  })

  it('disposes shared source geometry, materials and textures exactly once', () => {
    const root = new THREE.Group()
    const geometry = new THREE.BoxGeometry()
    const texture = new THREE.Texture()
    const material = new THREE.MeshStandardMaterial({ map: texture, roughnessMap: texture })
    root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, [material]))
    const geometryDispose = vi.spyOn(geometry, 'dispose')
    const materialDispose = vi.spyOn(material, 'dispose')
    const textureDispose = vi.spyOn(texture, 'dispose')
    disposeModelScene(root)
    expect(geometryDispose).toHaveBeenCalledTimes(1)
    expect(materialDispose).toHaveBeenCalledTimes(1)
    expect(textureDispose).toHaveBeenCalledTimes(1)
  })

  it('deduplicates loading, bounds concurrency, and releases loaded source scenes', async () => {
    const library = createFurnitureModelLibrary()
    let active = 0, peak = 0
    const disposal = []
    const loader = { loadAsync: vi.fn(async () => {
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      active--
      const scene = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
      disposal.push(vi.spyOn(scene.geometry, 'dispose'))
      return { scene }
    }) }
    const first = loadFurnitureModels(library, { loader })
    expect(loadFurnitureModels(library, { loader })).toBe(first)
    await first
    expect(peak).toBe(4)
    expect(library.geometries.size).toBe(23)
    expect(library.loaded).toBe(true)
    expect(loader.loadAsync).toHaveBeenCalledTimes(23)
    for (const dispose of disposal) expect(dispose).toHaveBeenCalledTimes(1)
    await loadFurnitureModels(library, { loader })
    expect(loader.loadAsync).toHaveBeenCalledTimes(23)
    disposeFurnitureModels(library)
  })

  it('does not resurrect a disposed library when queued requests finish', async () => {
    const library = createFurnitureModelLibrary()
    const completions = []
    const scenes = []
    const loader = { loadAsync: vi.fn(() => new Promise((resolve) => {
      const scene = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
      scenes.push(vi.spyOn(scene.geometry, 'dispose'))
      completions.push(() => resolve({ scene }))
    })) }
    const pending = loadFurnitureModels(library, { loader })
    disposeFurnitureModels(library)
    for (const complete of completions) complete()
    await pending
    expect(loader.loadAsync).toHaveBeenCalledTimes(4)
    expect(library.geometries.size).toBe(0)
    expect(library.loaded).toBe(false)
    expect(library.failed).toBe(false)
    for (const dispose of scenes) expect(dispose).toHaveBeenCalledTimes(1)
  })
})

// --- mesh.js integration: which batch the chunk builds -----------------------

function stubMaterials() {
  const m = new THREE.MeshBasicMaterial()
  return {
    carpet: m,
    ceiling: m,
    wallpaper: m,
    doorFrame: m,
    doorLeaf: m,
    prop: m,
    signGlow: m,
    furniture: m,
    furnitureModel: m,
    panel: m,
    panelDead: m,
    exit: m,
  }
}

function deskChairData() {
  const data = new ChunkData(0, 0, 0, 0)
  data.furniture.push(
    { kind: FURN_DESK, lx: 4, lz: 4, x: 8.4, z: 8.4, w: DESK_W, d: DESK_D, facing: 0 },
    { kind: FURN_DESK, lx: 6, lz: 6, x: 12.6, z: 12.6, w: DESK_D, d: DESK_W, facing: 2 },
    { kind: FURN_CHAIR, lx: 5, lz: 5, x: 10.5, z: 10.5, w: CHAIR_W, d: CHAIR_W, facing: 1 }
  )
  return data
}

function stubLibrary() {
  const lib = createFurnitureModelLibrary()
  lib.geometries.set(FURN_DESK, new THREE.BoxGeometry(1, 1, 1))
  lib.geometries.set(FURN_CHAIR, new THREE.BoxGeometry(1, 1, 1))
  lib.loaded = true
  return lib
}

describe('chunk furniture batching (GLB path)', () => {
  it('builds one InstancedMesh per kind with placement transforms', () => {
    const data = deskChairData()
    const geom = createGeometries()
    const lib = stubLibrary()
    const mesh = buildChunkMeshes(data, geom, stubMaterials(), 0, 0, 0, lib)
    const node = mesh.parts.furniture
    expect(node.isGroup).toBe(true)
    expect(node.children).toHaveLength(2)
    for (const child of node.children) {
      expect(child.isInstancedMesh).toBe(true)
      expect(child.instanceColor).not.toBeNull() // material declares the define
    }
    const desks = node.children.find((c) => c.count === 2)
    const chairs = node.children.find((c) => c.count === 1)
    expect(desks.geometry).toBe(lib.geometries.get(FURN_DESK))
    expect(chairs.geometry).toBe(lib.geometries.get(FURN_CHAIR))

    const m = new THREE.Matrix4()
    const p = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    desks.getMatrixAt(1, m)
    m.decompose(p, q, s)
    expect(p.x).toBeCloseTo(12.6, 5)
    expect(p.y).toBeCloseTo(0, 5) // GLB origin already sits on the floor
    expect(p.z).toBeCloseTo(12.6, 5)
    // facing 2 = rotY(+pi/2), matching the box builders' local frame.
    const expected = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 2
    )
    expect(Math.abs(q.dot(expected))).toBeCloseTo(1, 5)
    mesh.dispose()
  })

  it('keeps the box-builder batch when the library is empty or material-less', () => {
    const geom = createGeometries()
    const noModels = buildChunkMeshes(deskChairData(), geom, stubMaterials(), 0, 0, 0, null)
    expect(noModels.parts.furniture.children).toHaveLength(1)
    expect(noModels.parts.furniture.children[0].geometry).toBe(geom.wallUnit)
    noModels.dispose()

    const noMaterial = { ...stubMaterials() }
    delete noMaterial.furnitureModel
    const mesh = buildChunkMeshes(deskChairData(), geom, noMaterial, 0, 0, 0, stubLibrary())
    expect(mesh.parts.furniture.children).toHaveLength(1)
    expect(mesh.parts.furniture.children[0].geometry).toBe(geom.wallUnit)
    mesh.dispose()
  })

  it('refreshFurniture swaps a resident chunk between box and GLB batches', () => {
    const geom = createGeometries()
    const chunk = new Chunk(0, 0, 0, 4242, stubMaterials(), geom, null, DEFAULT_WORLD_CONFIG, null, null)
    chunk.data.furniture.push(
      { kind: FURN_DESK, lx: 4, lz: 4, x: 8.4, z: 8.4, w: DESK_W, d: DESK_D, facing: 0 }
    )
    chunk.refreshFurniture(null) // null library -> box builder batch
    const boxed = chunk.renderParts.furniture
    expect(boxed.children).toHaveLength(1)
    expect(boxed.children[0].geometry).toBe(geom.wallUnit)

    const lib = stubLibrary()
    chunk.refreshFurniture(lib)
    const glb = chunk.renderParts.furniture
    expect(glb).not.toBe(boxed)
    expect(glb.children.length).toBeGreaterThan(0)
    // Batches are GLB kinds the library covers; kinds the stub library lacks
    // keep a shared wallUnit box batch (per-kind fallback).
    for (const c of glb.children) {
      const isGlb = [...lib.geometries.values()].includes(c.geometry)
      expect(isGlb || c.geometry === geom.wallUnit).toBe(true)
    }
    expect(glb.children.some((c) => c.geometry === lib.geometries.get(FURN_DESK))).toBe(true)
    expect(chunk.group.children.includes(boxed)).toBe(false) // old node detached
    expect(chunk.group.children.includes(glb)).toBe(true)
    // Swap-in respects the mount() transform freeze contract.
    expect(glb.matrixWorldAutoUpdate).toBe(false)
    chunk.dispose()
  })

  it('disposes the upgraded furniture batch (not only the build-time one) on unload', () => {
    const geom = createGeometries()
    const chunk = new Chunk(0, 0, 0, 4242, stubMaterials(), geom, null, DEFAULT_WORLD_CONFIG, null, null)
    chunk.data.furniture.push(
      { kind: FURN_DESK, lx: 4, lz: 4, x: 8.4, z: 8.4, w: DESK_W, d: DESK_D, facing: 0 }
    )
    chunk.refreshFurniture(null)
    const boxed = chunk.renderParts.furniture
    chunk.refreshFurniture(stubLibrary())
    const glb = chunk.renderParts.furniture
    const disposed = new Set()
    for (const part of [boxed, glb]) {
      for (const c of part.children) c.addEventListener('dispose', () => disposed.add(c))
    }

    chunk.dispose()

    for (const c of glb.children) expect(disposed.has(c)).toBe(true)
    // The already-released first generation is not disposed a second time.
    for (const c of boxed.children) expect(disposed.has(c)).toBe(false)
  })
})
