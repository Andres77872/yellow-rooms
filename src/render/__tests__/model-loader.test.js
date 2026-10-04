import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  FURNITURE_MODEL_FILES,
  createFurnitureModelLibrary,
  disposeFurnitureModels,
  loadFurnitureModels,
  loadModelPack,
  loadPropModels,
} from '../furnitureModels.js'
import { PROP_KINDS, PROP_MODEL_FILES, PROP_CART, PROP_DOORSTOP } from '../../world/props/index.js'

// The generalised model loader: furniture and every prop pack bake into ONE
// library (geometries keyed by kind id), deduplicated per (library, pack).
// Offline: a fake loader stands in for GLTFLoader (no fetch in vitest).

const FURN_COUNT = Object.keys(FURNITURE_MODEL_FILES).length
const PROP_COUNT = PROP_KINDS.length

function boxScene() {
  return { scene: new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()) }
}

function fakeLoader(fail = () => false) {
  const urls = []
  let active = 0
  const loader = {
    peak: 0,
    urls,
    loadAsync: vi.fn(async (url) => {
      urls.push(url)
      active++
      loader.peak = Math.max(loader.peak, active)
      await Promise.resolve()
      active--
      if (fail(url)) throw new Error(`404 ${url}`)
      return boxScene()
    }),
  }
  return loader
}

describe('loadPropModels', () => {
  it('fetches every registry kind from models/<pack>/<stem>.glb into the shared library', async () => {
    const library = createFurnitureModelLibrary()
    const loader = fakeLoader()
    await expect(loadPropModels(library, { loader, baseUrl: '/m/' })).resolves.toBe(library)
    const expected = PROP_KINDS.map((k) => `/m/${k.pack}/${k.kind}.glb`)
    expect([...loader.urls].sort()).toEqual([...expected].sort())
    expect(library.geometries.size).toBe(PROP_COUNT)
    for (const k of PROP_KINDS) expect(library.geometries.has(k.id), k.key).toBe(true)
    expect(library.loaded).toBe(true)
    expect(loader.peak).toBeLessThanOrEqual(4)
    disposeFurnitureModels(library)
  })

  it('warns once per unbuilt pack and leaves its kinds on the box fallback', async () => {
    const library = createFurnitureModelLibrary()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loader = fakeLoader((url) => url.includes('/street/') || url.endsWith('/doorstop.glb'))
    try {
      await expect(loadPropModels(library, { loader, baseUrl: '/m/' })).resolves.toBe(library)
      const street = Object.keys(PROP_MODEL_FILES.street).length
      expect(library.geometries.size).toBe(PROP_COUNT - street - 1)
      expect(library.geometries.has(PROP_CART)).toBe(false)
      expect(library.geometries.has(PROP_DOORSTOP)).toBe(false)
      expect(warn).toHaveBeenCalledTimes(2) // street + stairwell, not one per file
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/"street": 4\/4/)
    } finally {
      warn.mockRestore()
      disposeFurnitureModels(library)
    }
  })

  it('loads only the requested packs and skips unknown names', async () => {
    const library = createFurnitureModelLibrary()
    const loader = fakeLoader()
    await loadPropModels(library, { packs: ['pool', 'nope'], loader, baseUrl: '/m/' })
    expect(loader.urls.every((u) => u.startsWith('/m/pool/'))).toBe(true)
    expect(library.geometries.size).toBe(Object.keys(PROP_MODEL_FILES.pool).length)
    disposeFurnitureModels(library)
  })

  it('deduplicates per pack: a finished or pending pack is never refetched', async () => {
    const library = createFurnitureModelLibrary()
    const loader = fakeLoader()
    const first = loadModelPack(library, { pack: 'x', files: { 200: 'a', 201: 'b' }, baseUrl: '/x/', loader })
    expect(loadModelPack(library, { pack: 'x', files: { 200: 'a' }, baseUrl: '/x/', loader })).toBe(first)
    await first
    await loadModelPack(library, { pack: 'x', files: { 200: 'a' }, baseUrl: '/x/', loader })
    expect(loader.loadAsync).toHaveBeenCalledTimes(2)
    // Another pack on the same library still loads.
    await loadModelPack(library, { pack: 'y', files: { 202: 'c' }, baseUrl: '/y/', loader })
    expect(loader.loadAsync).toHaveBeenCalledTimes(3)
    expect([...library.geometries.keys()].sort()).toEqual([200, 201, 202])
    disposeFurnitureModels(library)
  })
})

describe('furniture and props in one library', () => {
  it('keeps loadFurnitureModels independent of prop packs loaded first', async () => {
    const library = createFurnitureModelLibrary()
    const loader = fakeLoader()
    await loadPropModels(library, { loader, baseUrl: '/m/' })
    expect(library.loaded).toBe(true)
    // A prop-loaded library must not short-circuit the furniture pack.
    await loadFurnitureModels(library, { loader, baseUrl: '/f/' })
    expect(loader.urls.filter((u) => u.startsWith('/f/')).length).toBe(FURN_COUNT)
    expect(library.geometries.size).toBe(FURN_COUNT + PROP_COUNT)
    disposeFurnitureModels(library)
  })

  it('reloads every pack after dispose and drops in-flight results', async () => {
    const library = createFurnitureModelLibrary()
    const loader = fakeLoader()
    const furniture = loadFurnitureModels(library, { loader, baseUrl: '/f/' })
    const props = loadPropModels(library, { loader, baseUrl: '/m/' })
    disposeFurnitureModels(library)
    await Promise.all([furniture, props])
    expect(library.geometries.size).toBe(0)
    expect(library.loaded).toBe(false)
    await loadFurnitureModels(library, { loader, baseUrl: '/f/' })
    await loadPropModels(library, { loader, baseUrl: '/m/' })
    expect(library.geometries.size).toBe(FURN_COUNT + PROP_COUNT)
    disposeFurnitureModels(library)
  })
})
