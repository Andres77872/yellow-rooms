import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../textures.js', () => ({
  floorTexture: (anisotropy) => Object.assign(new THREE.Texture(), { anisotropy }),
  wallTexture: (anisotropy) => Object.assign(new THREE.Texture(), { anisotropy }),
  ceilingTexture: (anisotropy) => Object.assign(new THREE.Texture(), { anisotropy }),
  surfaceDetailTexture: (albedo) => Object.assign(new THREE.Texture(), { anisotropy: albedo.anisotropy }),
}))

import { createGBufferMaterials } from '../gbufferMaterials.js'
import { createGeometries } from '../geometries.js'
import {
  DEFAULT_LIGHT_RADIUS,
  PANEL_AREA,
  PANEL_D,
  PANEL_W,
  ProxySceneBuilder,
  aimFlashlight,
  flashlightSpot,
  floorLamps,
  selectChunks,
  selectLamps,
} from '../pathtrace/proxyScene.js'
import { FLASH_HAND_OFFSET } from '../flashFrame.js'
import { Chunk } from '../../world/Chunk.js'
import { worldConfigForFamily } from '../../world/mapFamily.js'
import { hashStr } from '../../world/core/hash.js'
import {
  CHUNK_WORLD,
  EYE_H,
  FLASH_COS_INNER,
  FLASH_COS_OUTER,
  HUB_CELL,
  SPAWN_WORLD,
  WALL_H,
} from '../../world/constants.js'

// The experimental WebGPU path tracer's proxy scene (render/pathtrace): the
// game's real generated office chunks around spawn, mirrored for the tracer
// without touching anything the deferred renderer draws.

const materials = createGBufferMaterials({ capabilities: { getMaxAnisotropy: () => 4 } })
const geom = createGeometries()
const { config } = worldConfigForFamily('office')
const seed = hashStr('review#1')
const chunks = []
for (let cz = -1; cz <= 1; cz++) {
  for (let cx = -1; cx <= 1; cx++) {
    const clear = cx === 0 && cz === 0 ? [{ cx: 0, cy: 0, cz: 0, lx: HUB_CELL, lz: HUB_CELL, r: 1 }] : null
    chunks.push(new Chunk(cx, 0, cz, seed, materials, geom, null, config, clear, null))
  }
}

function spawnCamera(yaw = 0.6) {
  const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.1, 180)
  camera.position.set(SPAWN_WORLD, EYE_H, SPAWN_WORLD)
  camera.rotation.set(0, yaw, 0, 'YXZ')
  camera.updateMatrixWorld()
  return camera
}

function build(builder = new ProxySceneBuilder(), over = {}) {
  const out = builder.build({
    chunks,
    camera: spawnCamera(),
    floor: 0,
    panelMaterial: materials.panel,
    lampColor: new THREE.Color(1, 0.9, 0.7),
    lampPower: 1.15,
    ...over,
  })
  return { builder, ...out }
}

const meshes = (scene) => scene.children.filter((o) => o.isMesh)
const rectLights = (scene) => scene.children.filter((o) => o.isRectAreaLight)

describe('chunk and lamp selection', () => {
  it('keeps the camera floor within the radius, and other floors only through an opening', () => {
    const fake = (cx, cy, cz, apertures = []) => ({ cx, cy, cz, apertures })
    const stair = [{ kind: 'stair' }]
    const all = [
      fake(0, 0, 0, stair), // camera floor, hole in its ceiling
      fake(1, 0, 0), // camera floor, sealed
      fake(5, 0, 0), // too far
      fake(0, 1, 0), // above the hole: kept
      fake(1, 1, 0), // above a sealed ceiling: dropped
      fake(0, 2, 0), // two floors up: dropped
      fake(0, -1, 0), // below, sealed: dropped
      fake(1, -1, 0, stair), // below, its ceiling opens into the camera floor: kept
    ]
    const picked = selectChunks(all, 10, 10, 0, CHUNK_WORLD)
    expect(picked).toEqual([all[0], all[1], all[3], all[7]])
  })

  it('keeps the nearest lamps within the radius, capped, and counts the rest', () => {
    const lamps = [8, 2, 30, 5, 1].map((x) => new THREE.Vector3(x, 0, 0))
    const { kept, culled } = selectLamps(lamps, new THREE.Vector3(), 10, 3)
    expect(kept.map((v) => v.x)).toEqual([1, 2, 5])
    expect(culled).toBe(2)
  })

  it('without the ChunkManager policy, only lamps on the camera floor are candidates', () => {
    const lamp = (x, cy) => Object.assign(new THREE.Vector3(x, 0, 0), { cy })
    const a = lamp(1, 0)
    const b = lamp(2, 1)
    const c = lamp(3, 0)
    expect(floorLamps([{ lamps: [a, b] }, { lamps: [c] }], 0)).toEqual([a, c])
    expect(floorLamps([{ lamps: [a, b] }], 1)).toEqual([b])
  })
})

describe('ProxySceneBuilder on real office chunks', () => {
  it('mirrors every visible part as stock materials and keeps batches instanced', () => {
    const { scene, stats, builder } = build()
    // Spawn sits mid-chunk: the default reach (lamp reach + two cells) takes
    // the hub chunk and its +X and +Z neighbours, not the whole 3x3 ring.
    expect(stats.chunks).toBe(3)
    expect(selectChunks(chunks, SPAWN_WORLD, SPAWN_WORLD, 0).map((c) => [c.cx, c.cz])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
    ])
    expect(stats.meshes).toBe(meshes(scene).length)
    expect(stats.instances).toBeGreaterThan(1000)
    expect(stats.triangles).toBeGreaterThan(10000)
    for (const m of meshes(scene)) {
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      for (const mat of mats) expect(mat.isMeshStandardMaterial).toBe(true)
    }
    // Two-level BVH on the WebGPU backend: instances stay instances and
    // share the chunk's matrices/colours read-only.
    const sourceInstanced = []
    for (const c of chunks) c.group.traverse((o) => o.isInstancedMesh && o.count > 0 && sourceInstanced.push(o))
    const proxyMatrices = new Set(meshes(scene).filter((m) => m.isInstancedMesh).map((m) => m.instanceMatrix))
    expect(proxyMatrices.size).toBeGreaterThan(0)
    for (const attr of proxyMatrices) {
      expect(sourceInstanced.some((o) => o.instanceMatrix === attr)).toBe(true)
    }
    builder.dispose()
  })

  it('never hands the tracer a geometry the game renders, and caches clones across builds', () => {
    const sources = new Set()
    for (const c of chunks) c.group.traverse((o) => o.isMesh && sources.add(o.geometry))
    const builder = new ProxySceneBuilder()
    const first = build(builder)
    const firstGeoms = new Set(meshes(first.scene).map((m) => m.geometry))
    for (const g of firstGeoms) expect(sources.has(g)).toBe(false)
    const second = build(builder)
    for (const m of meshes(second.scene)) expect(firstGeoms.has(m.geometry)).toBe(true)
    // Sources stay exactly as the deferred renderer built them.
    for (const g of sources) expect(g.boundsTree).toBeUndefined()
    builder.dispose()
  })

  it('ignores the chunk sight-culling flag but respects hidden detail parts', () => {
    const c = chunks[4]
    const builder = new ProxySceneBuilder()
    const base = build(builder).stats
    const wasVisible = c.group.visible
    c.group.visible = false
    expect(build(builder).stats.meshes).toBe(base.meshes)
    c.group.visible = wasVisible
    const part = c.group.children.find((o) => o.isMesh)
    part.visible = false
    expect(build(builder).stats.meshes).toBe(base.meshes - 1)
    part.visible = true
    builder.dispose()
  })

  it('turns lit panels into downward rect lights 1 cm below the panel mesh', () => {
    const { scene, stats, builder } = build()
    const lights = rectLights(scene)
    expect(lights.length).toBe(stats.lights)
    expect(lights.length).toBeGreaterThan(0)
    const cam = spawnCamera()
    const dir = new THREE.Vector3()
    for (const l of lights) {
      // Panel mesh plane is WALL_H - 0.02 on floor 0.
      expect(l.position.y).toBeCloseTo(WALL_H - 0.03, 6)
      expect(l.width).toBe(PANEL_W)
      expect(l.height).toBe(PANEL_D)
      // Same on-axis intensity as the engine's point emitter.
      expect(l.intensity).toBeCloseTo(1.15 / PANEL_AREA, 6)
      l.getWorldDirection(dir)
      // Object3D.getWorldDirection reports +Z; a light emits along -Z.
      expect(dir.y).toBeCloseTo(1, 6)
      expect(l.position.distanceTo(cam.position)).toBeLessThanOrEqual(DEFAULT_LIGHT_RADIUS + 0.6)
    }
    builder.dispose()
  })

  it('makes the lit panel a dark non-emissive diffuser (no coplanar emitter)', () => {
    const { scene, builder } = build()
    const panelProxies = []
    for (const c of chunks) {
      c.group.traverse((o) => {
        if (o.material !== materials.panel) return
        const proxy = meshes(scene).find((m) => m.instanceMatrix === o.instanceMatrix)
        if (proxy) panelProxies.push(proxy)
      })
    }
    expect(panelProxies.length).toBeGreaterThan(0)
    for (const p of panelProxies) {
      expect(p.material.emissiveIntensity * p.material.emissive.getHex()).toBe(0)
    }
    builder.dispose()
  })

  it('caps the light count', () => {
    const { stats, builder } = build(undefined, { maxLights: 3 })
    expect(stats.lights).toBe(3)
    expect(stats.culledLights).toBeGreaterThan(0)
    builder.dispose()
  })

  it('takes the caller\'s lamp candidates (the ChunkManager spill policy) over its own', () => {
    const eye = spawnCamera().position
    const only = [...chunks[4].lamps].sort((a, b) => a.distanceTo(eye) - b.distanceTo(eye)).slice(0, 2)
    const { scene, stats, builder } = build(undefined, { lamps: only })
    expect(stats.lights).toBe(2)
    expect(rectLights(scene).map((l) => [l.position.x, l.position.z])).toEqual(
      expect.arrayContaining(only.map((v) => [v.x, v.z]))
    )
    builder.dispose()
  })

  it('adds the flashlight as a spot from the hand, along the view axis', () => {
    const flashlight = {
      color: new THREE.Color(1, 0.95, 0.8),
      intensity: 1.5,
      range: 26,
      cosInner: FLASH_COS_INNER,
      cosOuter: FLASH_COS_OUTER,
    }
    const { scene, stats, flashlight: spot, builder } = build(undefined, { flashlight })
    expect(stats.flashlight).toBe(true)
    expect(scene.children).toContain(spot)
    expect(Math.cos(spot.angle)).toBeCloseTo(FLASH_COS_OUTER, 6)
    expect(Math.cos(spot.angle * (1 - spot.penumbra))).toBeCloseTo(FLASH_COS_INNER, 6)
    expect(spot.distance).toBe(26)
    expect(spot.decay).toBe(2)
    const cam = spawnCamera()
    const hand = new THREE.Vector3(...FLASH_HAND_OFFSET).applyMatrix4(cam.matrixWorld)
    expect(spot.position.distanceTo(hand)).toBeLessThan(1e-6)
    const aim = spot.target.position.clone().sub(spot.position).normalize()
    const fwd = cam.getWorldDirection(new THREE.Vector3())
    expect(aim.dot(fwd)).toBeCloseTo(1, 6)
    builder.dispose()
  })

  it('re-aims the flashlight when the camera turns', () => {
    const spot = flashlightSpot({ color: new THREE.Color(), intensity: 1, range: 10, cosInner: 0.94, cosOuter: 0.86 })
    const cam = spawnCamera(0)
    aimFlashlight(spot, cam)
    const a = spot.target.position.clone().sub(spot.position).normalize()
    cam.rotation.y = Math.PI / 2
    aimFlashlight(spot, cam)
    const b = spot.target.position.clone().sub(spot.position).normalize()
    expect(a.dot(b)).toBeCloseTo(0, 6)
  })
})
