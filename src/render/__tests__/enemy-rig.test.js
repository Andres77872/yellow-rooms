import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  ENEMY_MODEL_FILES,
  bakeEnemyRig,
  createEnemyRig,
  createEnemyModelLibrary,
  upgradeEnemyModels,
} from '../enemyModels.js'
import {
  ENEMY_CLIPS,
  STALKER_REACH_FAR,
  STALKER_REACH_NEAR,
  STALKER_RUN_OFF,
  STALKER_RUN_ON,
  huskPose,
  pursuerPose,
  stalkerPose,
} from '../enemyAnimator.js'
import { Husk } from '../../entities/Husk.js'
import { Stalker } from '../../entities/Stalker.js'
import { Pursuer } from '../../entities/Pursuer.js'

// The rig half of the enemy pipeline: build_enemies.py skins each figure to
// its own armature and exports named in-place clips; the runtime clones one
// rig per entity and blends those clips from the AI state
// (render/enemyAnimator.js). These tests lock both sides of that contract.

const MODELS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../public/models/enemies'
)

function readGlb(key) {
  const buf = readFileSync(path.join(MODELS_DIR, `${ENEMY_MODEL_FILES[key]}.glb`))
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen))
  const bin = buf.subarray(20 + jsonLen + 8)
  return { buf, json, bin }
}

async function loadAsset(key) {
  const { buf } = readGlb(key)
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Promise((resolve, reject) => new GLTFLoader().parse(arrayBuffer, '', resolve, reject))
}

async function loadRig(key) {
  const rig = bakeEnemyRig(await loadAsset(key))
  expect(rig).not.toBeNull()
  return rig
}

const KEYS = Object.keys(ENEMY_MODEL_FILES)

function worldPos(root, name) {
  root.updateMatrixWorld(true)
  return root.getObjectByName(name).getWorldPosition(new THREE.Vector3())
}

function boneQuats(root) {
  const out = []
  root.traverse((node) => {
    if (node.isBone) out.push(node.quaternion.toArray().map((v) => +v.toFixed(6)))
  })
  return out
}

describe('rigged enemy GLB contract', () => {
  it.each(KEYS)('%s ships one skin, skinned primitives and exactly the runtime clips', (key) => {
    const { json, bin } = readGlb(key)
    expect(json.skins).toHaveLength(1)
    const joints = new Set(json.skins[0].joints)
    expect(joints.size).toBeGreaterThanOrEqual(18)
    for (const mesh of json.meshes) {
      for (const prim of mesh.primitives) {
        expect(prim.attributes.JOINTS_0).toBeTypeOf('number')
        const weights = json.accessors[prim.attributes.WEIGHTS_0]
        // Unit-sum normalized bytes (yr_shading.compact_glb _quantize_weights).
        expect(weights).toMatchObject({ componentType: 5121, normalized: true, type: 'VEC4' })
        const view = json.bufferViews[weights.bufferView]
        const bytes = bin.subarray(view.byteOffset, view.byteOffset + weights.count * 4)
        for (let i = 0; i < weights.count; i++) {
          expect(bytes[i * 4] + bytes[i * 4 + 1] + bytes[i * 4 + 2] + bytes[i * 4 + 3]).toBe(255)
        }
      }
    }
    // Clip names are the runtime's table, nothing more, nothing less.
    const names = json.animations.map((a) => a.name).sort()
    expect(names).toEqual(Object.keys(ENEMY_CLIPS[key]).sort())
    for (const anim of json.animations) {
      for (const channel of anim.channels) {
        expect(joints.has(channel.target.node)).toBe(true) // in-place: never the root object
        expect(['rotation', 'translation']).toContain(channel.target.path)
        const out = json.accessors[anim.samplers[channel.sampler].output]
        if (channel.target.path === 'rotation') {
          expect(out).toMatchObject({ componentType: 5122, normalized: true, type: 'VEC4' })
        }
      }
    }
  })

  it.each(KEYS)('%s bakes into one skinned draw bound to its skeleton', async (key) => {
    const rig = await loadRig(key)
    const meshes = []
    rig.root.traverse((node) => node.isSkinnedMesh && meshes.push(node))
    expect(meshes).toHaveLength(1)
    const [mesh] = meshes
    expect(mesh.geometry).toBe(rig.geometry)
    expect(rig.geometry.groups).toHaveLength(0)
    for (const attr of ['position', 'normal', 'color', 'surface', 'skinIndex', 'skinWeight']) {
      expect(rig.geometry.attributes[attr]).toBeDefined()
    }
    // Bind pose = the static contract: origin on the floor.
    expect(rig.geometry.boundingBox.min.y).toBeGreaterThanOrEqual(-0.005)
    expect(mesh.skeleton.bones.length).toBe(readGlb(key).json.skins[0].joints.length)
    expect(rig.clips.map((c) => c.name).sort()).toEqual(Object.keys(ENEMY_CLIPS[key]).sort())
  })
})

describe('enemy rig instances', () => {
  it('clones independent skeletons on shared geometry', async () => {
    const rig = await loadRig('pursuer')
    const material = new THREE.MeshBasicMaterial()
    const a = createEnemyRig('pursuer', rig, material)
    const b = createEnemyRig('pursuer', rig, material)
    let meshA
    let meshB
    a.object.traverse((n) => n.isSkinnedMesh && (meshA = n))
    b.object.traverse((n) => n.isSkinnedMesh && (meshB = n))
    expect(meshA.geometry).toBe(meshB.geometry)
    expect(meshA.material).toBe(material)
    expect(meshA.skeleton.bones[0]).not.toBe(meshB.skeleton.bones[0])
    const rest = worldPos(b.object, 'hand_L')
    a.animator.update(0.2, { base: 'crawl', speed: 3 })
    expect(worldPos(b.object, 'hand_L').distanceTo(rest)).toBe(0) // b untouched
    a.animator.dispose()
    b.animator.dispose()
    material.dispose()
  })

  it('starts on idle and keeps base weights summing to one through a crossfade', async () => {
    const { animator } = createEnemyRig('stalker', await loadRig('stalker'), null)
    expect(animator.clipNames.sort()).toEqual(['idle', 'reach', 'run', 'walk'])
    expect(animator.weightOf('idle')).toBe(1)
    for (let i = 0; i < 6; i++) {
      animator.update(1 / 30, { base: 'walk', speed: 2 })
      const sum = ['idle', 'walk', 'run'].reduce((s, n) => s + animator.weightOf(n), 0)
      expect(sum).toBeCloseTo(1, 5)
    }
    expect(animator.weightOf('walk')).toBeGreaterThan(animator.weightOf('idle'))
    for (let i = 0; i < 60; i++) animator.update(1 / 30, { base: 'walk', speed: 2 })
    expect(animator.weightOf('walk')).toBeCloseTo(1, 3)
    animator.dispose()
  })

  it('walk and run share one gait phase, advancing with ground speed', async () => {
    const { animator } = createEnemyRig('stalker', await loadRig('stalker'), null)
    const walk = animator.layers.get('walk')
    const run = animator.layers.get('run')
    animator.update(0.25, { base: 'walk', speed: ENEMY_CLIPS.stalker.walk.stride }) // 1 loop/s
    expect(animator.gait).toBeCloseTo(0.25, 5)
    animator.update(0.1, { base: 'run', speed: 4 })
    expect(walk.time / walk.duration).toBeCloseTo(run.time / run.duration, 5)
    const before = animator.gait
    animator.update(0.1, { base: 'run', speed: ENEMY_CLIPS.stalker.run.stride * 2 }) // 2 loops/s
    expect(animator.gait - before).toBeCloseTo(0.2, 5)
    animator.dispose()
  })

  it('a held (beam-pinned) stalker freezes into a statue', async () => {
    const { object, animator } = createEnemyRig('stalker', await loadRig('stalker'), null)
    for (let i = 0; i < 20; i++) animator.update(1 / 30, { base: 'walk', speed: 2 })
    for (let i = 0; i < 30; i++) animator.update(1 / 30, { base: 'walk', speed: 2, hold: true })
    const frozen = boneQuats(object)
    for (let i = 0; i < 30; i++) animator.update(1 / 30, { base: 'idle', speed: 0, hold: true })
    expect(boneQuats(object)).toEqual(frozen)
    for (let i = 0; i < 10; i++) animator.update(1 / 30, { base: 'walk', speed: 2 })
    expect(boneQuats(object)).not.toEqual(frozen) // released: moves again
    animator.dispose()
  })

  it('the reach overlay is additive over the rest pose: 0 = base, 1 = arms raised forward', async () => {
    const rig = await loadRig('stalker')
    const a = createEnemyRig('stalker', rig, null)
    const b = createEnemyRig('stalker', rig, null)
    a.animator.update(0.5, { base: 'idle', overlays: { reach: 0 } })
    b.animator.update(0.5, { base: 'idle' })
    expect(boneQuats(a.object)).toEqual(boneQuats(b.object))
    const hangingZ = worldPos(a.object, 'fingers_L').z
    for (let i = 0; i < 60; i++) a.animator.update(1 / 30, { base: 'idle', overlays: { reach: 1 } })
    expect(a.animator.weightOf('reach')).toBeGreaterThan(0.99)
    expect(worldPos(a.object, 'fingers_L').z - hangingZ).toBeGreaterThan(0.4) // reaching toward +z (front)
    a.animator.dispose()
    b.animator.dispose()
  })

  it('drive() measures ground speed and ignores teleports', async () => {
    const { object, animator } = createEnemyRig('pursuer', await loadRig('pursuer'), null)
    const entity = { mesh: object, pos: new THREE.Vector3(), stateLabel: 'chasing' }
    object.visible = true
    for (let i = 0; i < 30; i++) {
      entity.pos.x += 3 / 30
      animator.drive(1 / 30, entity, new THREE.Vector3(10, 0, 0))
    }
    expect(animator.speed).toBeCloseTo(3, 1)
    expect(animator.base).toBe('crawl')
    entity.pos.x += 20 // relocation
    animator.drive(1 / 30, entity, null)
    expect(animator.speed).toBeLessThan(0.5)
    object.visible = false
    const gait = animator.gait
    entity.pos.x += 1
    animator.drive(1 / 30, entity, null) // invisible: no work
    expect(animator.gait).toBe(gait)
    animator.dispose()
  })
})

describe('clip policies', () => {
  it('stalker walks, runs with hysteresis, and idles when still', () => {
    expect(stalkerPose({ label: 'hunting', speed: 0, dist: 20 }).base).toBe('idle')
    expect(stalkerPose({ label: 'chasing', speed: 2, dist: 20 }).base).toBe('walk')
    const up = stalkerPose({ label: 'chasing', speed: STALKER_RUN_ON + 0.1, dist: 20 })
    expect(up).toMatchObject({ base: 'run', running: true })
    const between = (STALKER_RUN_ON + STALKER_RUN_OFF) / 2
    expect(stalkerPose({ label: 'chasing', speed: between, dist: 20, running: true }).base).toBe('run')
    expect(stalkerPose({ label: 'chasing', speed: between, dist: 20, running: false }).base).toBe('walk')
  })

  it('stalker holds while the beam pins it and raises its arms as it closes in', () => {
    expect(stalkerPose({ label: 'frozen', speed: 0, dist: 5 }).hold).toBe(true)
    expect(stalkerPose({ label: 'chasing', speed: 4, dist: 5 }).hold).toBe(false)
    expect(stalkerPose({ label: 'chasing', speed: 4, dist: STALKER_REACH_FAR + 1 }).overlays.reach).toBe(0)
    expect(stalkerPose({ label: 'chasing', speed: 4, dist: STALKER_REACH_NEAR }).overlays.reach).toBe(1)
    const mid = stalkerPose({ label: 'chasing', speed: 4, dist: (STALKER_REACH_FAR + STALKER_REACH_NEAR) / 2 })
    expect(mid.overlays.reach).toBeGreaterThan(0)
    expect(mid.overlays.reach).toBeLessThan(1)
  })

  it('pursuer skitters whenever it moves; husk cowers when cornered', () => {
    expect(pursuerPose({ speed: 0 }).base).toBe('idle')
    expect(pursuerPose({ speed: 2.9 }).base).toBe('crawl')
    expect(huskPose({ label: 'watching' }).base).toBe('idle')
    expect(huskPose({ label: 'cornered' }).base).toBe('cornered')
  })
})

describe('entity rig upgrade', () => {
  it.each([Stalker, Pursuer, Husk])('%s swaps its capsule for the rig in place', (Entity) => {
    const scene = new THREE.Scene()
    const entity = new Entity(scene, {}, {}, {})
    const capsule = entity.mesh
    entity.pos.set(4, 3.6, -1)
    capsule.rotation.y = 1.1
    capsule.visible = true
    const object = new THREE.Group()
    const animator = { drive: vi.fn(), dispose: vi.fn() }
    entity.upgradeRig(object, animator)
    expect(capsule.parent).toBeNull()
    expect(object.parent).toBe(scene)
    expect(entity.mesh).toBe(object)
    expect(object.position.equals(entity.pos)).toBe(true)
    expect(object.rotation.y).toBe(1.1)
    expect(object.visible).toBe(true)
    expect(entity.meshYOffset).toBe(0)
    entity.animate(0.016, { x: 0, y: 0, z: 0 })
    expect(animator.drive).toHaveBeenCalledWith(0.016, entity, { x: 0, y: 0, z: 0 })
    // A second upgrade releases the first animator.
    entity.upgradeRig(new THREE.Group(), { drive: vi.fn(), dispose: vi.fn() })
    expect(animator.dispose).toHaveBeenCalledOnce()
  })

  it('upgradeEnemyModels prefers the rig when the skinned material is supplied', () => {
    const lib = createEnemyModelLibrary()
    const geo = new THREE.BoxGeometry(1, 1, 1)
    const root = new THREE.Group()
    const bone = new THREE.Bone()
    bone.name = 'hips'
    root.add(bone)
    const skinned = new THREE.SkinnedMesh(geo, null)
    root.add(skinned)
    skinned.bind(new THREE.Skeleton([bone]))
    lib.geometries.set('husk', geo)
    lib.rigs.set('husk', { geometry: geo, root, clips: [] })
    lib.loaded = true
    const husk = { upgradeModel: vi.fn(), upgradeRig: vi.fn() }
    upgradeEnemyModels(lib, { husk }, { stub: 'static' })
    expect(husk.upgradeModel).toHaveBeenCalledWith(geo, { stub: 'static' }) // no skinned material
    const skinnedMaterial = { stub: 'skinned' }
    upgradeEnemyModels(lib, { husk }, { stub: 'static' }, skinnedMaterial)
    expect(husk.upgradeRig).toHaveBeenCalledOnce()
    const [object, animator] = husk.upgradeRig.mock.calls[0]
    let mesh
    object.traverse((n) => n.isSkinnedMesh && (mesh = n))
    expect(mesh.material).toBe(skinnedMaterial)
    expect(mesh.geometry).toBe(geo)
    animator.dispose()
    geo.dispose()
  })
})
