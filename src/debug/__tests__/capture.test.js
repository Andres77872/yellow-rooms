import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { CAPTURE_SCHEMA, applyCapture, captureState } from '../capture.js'
import { CELL, EYE_H, WORLD_GEN_VERSION, layerY } from '../../world/constants.js'
import { SHADOW_SET, SHADOW_SET_TIME, runShadowSet } from '../shadowSet.js'
import { GRAPHICS_KEYS } from '../../core/graphics.js'
import { TorchBounce } from '../../render/torchBounce.js'

function fakeEngine() {
  const camera = new THREE.PerspectiveCamera(72, 1.5, 0.1, 180)
  const settings = new Map([['look', 'semiRealistic'], ...GRAPHICS_KEYS.map((k) => [k, `v-${k}`])])
  return {
    _time: 12.5,
    camera,
    captureFrozen: false,
    settings: { get: (k) => settings.get(k) },
    state: { mapFamily: 'office', seedText: 'abc', level: 2, flashlightOn: true, resetLevel: vi.fn() },
    controller: { pos: new THREE.Vector3(10, 0, 20), floor: 1, yaw: 0.5, pitch: -0.2, teleport: vi.fn() },
    deferred: {
      look: { id: 'semiRealistic' },
      gridActive: true,
      lightUniforms: { uFlashOn: { value: 0 } },
      resetAdaptation: vi.fn(),
    },
    renderer: { getSize: (v) => v.set(800, 600), getPixelRatio: () => 2 },
    cm: { prewarm: vi.fn(), updateVisibility: vi.fn(), stairAt: vi.fn(() => null) },
    startRun: vi.fn(),
    _setupLevel: vi.fn(),
    _applySetting: vi.fn((k, v) => settings.set(k, v)),
    _setFlickerProfile: vi.fn(),
    _updateCameraMatrices: vi.fn(),
    _refreshLamps: vi.fn(),
  }
}

describe('deterministic capture descriptor', () => {
  it('records world identity, pose, time, look, quality and versions', () => {
    const c = captureState(fakeEngine())
    expect(c.schema).toBe(CAPTURE_SCHEMA)
    expect(c.versions.generator).toBe(WORLD_GEN_VERSION)
    expect(c.versions.three).toBe(THREE.REVISION)
    expect(c.world).toEqual({ family: 'office', seed: 'abc', level: 2 })
    expect(c.camera).toEqual({ pos: [10, 20], y: 0, floor: 1, yaw: 0.5, pitch: -0.2, fov: 72 })
    expect(c.time).toBe(12.5)
    expect(c.look).toBe('semiRealistic')
    expect(Object.keys(c.quality)).toEqual(GRAPHICS_KEYS)
    expect(c.render).toEqual({ width: 800, height: 600, pixelRatio: 2 })
    expect(JSON.parse(JSON.stringify(c))).toEqual(c)
  })

  it('replays into the same world without rebuilding it and freezes time', () => {
    const e = fakeEngine()
    const desc = captureState(e)
    desc.camera.pos = [30, 40]
    desc.camera.y = layerY(1)
    desc.look = 'classic'
    applyCapture(e, desc)
    expect(e.startRun).not.toHaveBeenCalled()
    expect(e._applySetting).toHaveBeenCalledWith('look', 'classic')
    expect(e.controller.teleport).toHaveBeenCalledWith(30, 40, 1, 0.5)
    expect(e.cm.prewarm).toHaveBeenCalledWith(30, 40, 1)
    expect(e.camera.position.toArray()).toEqual([30, layerY(1) + EYE_H, 40])
    expect(e.deferred.lightUniforms.uFlashOn.value).toBe(1)
    expect(e._time).toBe(12.5)
    expect(e.captureFrozen).toBe(true)
  })

  // The flicker profile decides a bad tube's brightness at the pinned time,
  // so it travels with the capture — but replay applies it at runtime only,
  // never through _applySetting (which would persist over the player's
  // photosensitivity choice).
  it('records the flicker profile and replays it without persisting it', () => {
    const e = fakeEngine()
    const desc = captureState(e)
    expect(desc.reduceFlicker).toBe(true) // unset store: the safe default
    desc.reduceFlicker = false
    applyCapture(e, desc)
    expect(e._setFlickerProfile).toHaveBeenCalledWith(false)
    expect(e._applySetting).not.toHaveBeenCalledWith('reduceFlicker', expect.anything())
    const old = captureState(fakeEngine())
    delete old.reduceFlicker // predates the field: keep the current profile
    const e2 = fakeEngine()
    applyCapture(e2, old)
    expect(e2._setFlickerProfile).not.toHaveBeenCalled()
  })

  it('rebuilds the world when seed, family or level differ', () => {
    const e = fakeEngine()
    const desc = captureState(e)
    desc.world = { family: 'sewer', seed: 'other', level: 3 }
    applyCapture(e, desc, { freeze: false })
    expect(e.startRun).toHaveBeenCalledWith('other', 'sewer')
    expect(e.state.level).toBe(3)
    expect(e._setupLevel).toHaveBeenCalled()
    expect(e.captureFrozen).toBe(false)
    expect(() => applyCapture(e, { schema: 99 })).toThrow(/schema/)
  })

  it('schema 2 records enemies, features and tiers, and replays the enemies frozen', () => {
    const e = fakeEngine()
    const enemy = () => ({
      active: true,
      pos: new THREE.Vector3(3, 0, 4),
      meshYOffset: 0,
      mesh: { visible: true, position: new THREE.Vector3(), rotation: { y: 0.7 } },
      modelState: 'glb',
    })
    e.enemies = [enemy(), enemy(), { ...enemy(), active: false, modelState: undefined }]
    e.deferred.quality = { shadow: { tier: 'high' }, flash: { tier: 'ultra' }, ao: { tier: 'high' }, vol: { tier: 'low' } }
    e.gpu = { cls: 'discrete', autoPreset: 'high' }
    e._updateOccluders = vi.fn()
    const c = captureState(e)
    expect(c.schema).toBe(2)
    expect(c.enemies).toHaveLength(3)
    expect(c.enemies[0]).toEqual({ kind: 'stalker', pos: [3, 0, 4], yaw: 0.7, active: true, visible: true, model: 'glb' })
    expect(c.enemies[2].model).toBe('fallback')
    expect(c.tiers).toEqual({ shadow: 'high', flash: 'ultra', ao: 'high', vol: 'low' })
    expect(c.features).toContain('furnitureShadows')
    c.enemies[0].pos = [9, 0, 9]
    c.enemies[0].yaw = -1
    applyCapture(e, c)
    expect(e.enemies[0].pos.toArray()).toEqual([9, 0, 9])
    expect(e.enemies[0].mesh.rotation.y).toBe(-1)
    expect(e._updateOccluders).toHaveBeenCalled()
    // Schema 1 captures (no enemies) still load.
    const old = { ...captureState(e), schema: 1 }
    delete old.enemies
    expect(() => applyCapture(e, old)).not.toThrow()
  })
})

describe('capture replay rebuilds the frame-loop state', () => {
  it('restores the feet height on a stair ramp and the stair-transit visibility', () => {
    const e = fakeEngine()
    // Climbing from floor 0: 2.7 m up the ramp, before the floor handoff.
    e.controller.pos.set(10, 2.7, 20)
    e.controller.floor = 0
    const stair = { part: 'run', baseCy: 0 }
    e.cm.stairAt = vi.fn(() => stair)
    const desc = captureState(e)
    expect(desc.camera.y).toBe(2.7)
    e.controller.pos.set(0, 0, 0)
    applyCapture(e, desc)
    expect(e.controller.pos.y).toBe(2.7)
    expect(e.camera.position.y).toBeCloseTo(2.7 + EYE_H, 9)
    expect(e.cm.stairAt).toHaveBeenCalledWith(Math.floor(10 / CELL), Math.floor(20 / CELL), 0)
    expect(e._transitStair).toBe(stair)
    expect(e.cm.updateVisibility).toHaveBeenLastCalledWith(0, stair)
  })

  it('without a stored height the feet stand on the ground under the pose', () => {
    const e = fakeEngine()
    const desc = { ...captureState(e), schema: 1 }
    delete desc.camera.y
    applyCapture(e, desc)
    expect(e.camera.position.y).toBe(layerY(1) + EYE_H)
  })

  it('always refreshes the capsules, then re-places the torch bounce from the new pose', () => {
    const e = fakeEngine()
    const order = []
    e._updateOccluders = vi.fn(() => order.push('occluders'))
    e.torchBounce = new TorchBounce()
    e.torchBounce.active = true
    e._updateTorch = vi.fn((dt) => order.push(['torch', dt, e.torchBounce.active]))
    // No enemies in the capture (schema 1, runShadowSet): the previous
    // world's capsules must still be cleared.
    const desc = captureState(e)
    delete desc.enemies
    applyCapture(e, desc)
    // The bounce filter is cleared first, or dt = 0 would keep the old hit.
    expect(order).toEqual(['occluders', ['torch', 0, false]])
  })

  it('meters again once a pending lighting build commits', async () => {
    const e = fakeEngine()
    let land
    e.deferred.whenLightingReady = vi.fn(() => new Promise((r) => (land = r)))
    applyCapture(e, captureState(e))
    expect(e.deferred.resetAdaptation).toHaveBeenCalledTimes(1)
    land()
    await Promise.resolve()
    expect(e.deferred.resetAdaptation).toHaveBeenCalledTimes(2)
  })

  it('an enemy entry without a position still parks the enemy', () => {
    const e = fakeEngine()
    const mesh = { visible: true, position: new THREE.Vector3(1, 2, 3), rotation: { y: 0 } }
    e.enemies = [{ active: true, pos: new THREE.Vector3(1, 2, 3), mesh }]
    applyCapture(e, { ...captureState(e), enemies: [{ pos: null, active: false, visible: false }] })
    expect(e.enemies[0].active).toBe(false)
    expect(mesh.visible).toBe(false)
    expect(mesh.position.toArray()).toEqual([1, 2, 3])
  })
})

describe('shadow evidence set', () => {
  it('replays every pose on the ground with no enemies and no inherited feet height', async () => {
    const e = fakeEngine()
    e.controller.pos.set(10, 2.7, 20) // the base capture is taken on a stair
    e.enemies = [{}, {}, {}]
    const descs = []
    e.capture = () => captureState(e)
    e.applyCapture = (d) => descs.push(d)
    e.resumeFromCapture = vi.fn()
    e.renderer.info = { reset: vi.fn(), render: { calls: 0 } }
    const probe = (pts) => pts.map(() => ({ occluded: false, rgb: [0, 0, 0], lum: 0 }))
    Object.assign(e.deferred, { setTiming: () => false, render: vi.fn(), setLightDebug: vi.fn(), probe })
    await runShadowSet(e, { frames: 1 })
    expect(descs).toHaveLength(SHADOW_SET.length)
    for (const d of descs) {
      expect(d.camera.y).toBeUndefined()
      expect(d.time).toBe(SHADOW_SET_TIME) // the flicker phase is pinned, not the live clock
      expect(d.enemies).toEqual([
        { pos: null, active: false, visible: false },
        { pos: null, active: false, visible: false },
        { pos: null, active: false, visible: false },
      ])
    }
  })
})
