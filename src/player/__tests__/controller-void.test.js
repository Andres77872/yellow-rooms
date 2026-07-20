import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { Controller } from '../Controller.js'
import { CELL, layerY } from '../../world/constants.js'

const POSITION = CELL / 2
const START_CY = 4
const STEP_DT = 1 / 60
const STEP_LIMIT = 240

function makeController() {
  const state = {
    phase: 'PLAYING',
    stamina: 1,
    battery: 1,
    flashlightOn: false,
  }
  return new Controller(new THREE.PerspectiveCamera(), {}, state)
}

function makeChunkManager({ hardVoidAt = () => null, floorHoleAt = () => false } = {}) {
  return {
    hardVoidAt,
    floorHoleAt,
    stairAt: () => null,
    wallVAt: () => false,
    wallHAt: () => false,
    columnAt: () => false,
  }
}

function stepUntilCalls(controller, cm, callback, count) {
  for (let i = 0; i < STEP_LIMIT && callback.mock.calls.length < count; i++) {
    controller.step(STEP_DT, cm)
  }
}

function lethalPlane(family, id) {
  const deathY = layerY(START_CY - 1) - 0.5
  return {
    id,
    family,
    deathYmm: Math.round(deathY * 1000),
  }
}

describe('Controller authored lethal voids', () => {
  beforeEach(() => {
    vi.stubGlobal('addEventListener', () => {})
    vi.stubGlobal('document', {
      addEventListener: () => {},
      pointerLockElement: null,
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('preserves ordinary office fall-through to lower support without hard death', () => {
    const hardVoidAt = vi.fn(() => null)
    const cm = makeChunkManager({
      hardVoidAt,
      floorHoleAt: (_gx, _gz, floor) => floor >= 1,
    })
    const controller = makeController()
    controller.onVoidDeath = vi.fn()
    controller.teleport(POSITION, POSITION, START_CY)

    for (let i = 0; i < STEP_LIMIT; i++) controller.step(STEP_DT, cm)

    expect(controller.onVoidDeath).not.toHaveBeenCalled()
    expect(controller.pos.y).toBe(layerY(0))
    expect(controller.floor).toBe(0)
    expect(controller.grounded).toBe(true)
  })

  it('preserves an ordinary airborne landing outside authored hazards', () => {
    const cm = makeChunkManager()
    const controller = makeController()
    controller.onVoidDeath = vi.fn()
    controller.teleport(POSITION, POSITION, START_CY)
    controller.pos.y += 2
    controller.grounded = false

    for (let i = 0; i < STEP_LIMIT; i++) controller.step(STEP_DT, cm)

    expect(controller.onVoidDeath).not.toHaveBeenCalled()
    expect(controller.pos.y).toBe(layerY(START_CY))
    expect(controller.floor).toBe(START_CY)
    expect(controller.grounded).toBe(true)
  })

  it.each([
    ['tower', 0x7100],
    ['lattice', 0x1a771ce],
  ])('latches a validated %s plane across unload and floor handoff, then emits once', (family, id) => {
    const plane = lethalPlane(family, id)
    const hardVoidAt = vi.fn()
      .mockReturnValueOnce(plane)
      .mockReturnValue(null)
    const floorHoleAt = vi.fn((_gx, _gz, floor) => floor >= 1)
    const cm = makeChunkManager({ hardVoidAt, floorHoleAt })
    const controller = makeController()
    controller.onFloorChange = vi.fn()
    controller.onVoidDeath = vi.fn()
    controller.teleport(POSITION, POSITION, START_CY)

    stepUntilCalls(controller, cm, controller.onVoidDeath, 1)

    expect(controller.onVoidDeath).toHaveBeenCalledTimes(1)
    expect(controller.onVoidDeath).toHaveBeenCalledWith({ id, family })
    expect(hardVoidAt).toHaveBeenNthCalledWith(1, 0, 0, START_CY)
    expect(hardVoidAt).toHaveBeenCalledTimes(1)
    expect(controller.onFloorChange).toHaveBeenCalledWith(START_CY - 1)
    expect(floorHoleAt).not.toHaveBeenCalled()
    expect(controller.pos.y).toBeGreaterThan(layerY(0))
    expect(controller.grounded).toBe(false)

    for (let i = 0; i < 60; i++) controller.step(STEP_DT, cm)
    expect(controller.onVoidDeath).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['missing death plane', { id: 7, family: 'tower' }],
    ['non-integer death plane', { id: 7, family: 'tower', deathYmm: 10.5 }],
    ['invalid identity', { id: -1, family: 'tower', deathYmm: 10_300 }],
    ['Office family', { id: 7, family: 'office', deathYmm: 10_300 }],
    ['Sewer family', { id: 7, family: 'sewer', deathYmm: 10_300 }],
    ['extra runtime field', {
      id: 7,
      family: 'lattice',
      deathYmm: 10_300,
      lowerCy: START_CY - 1,
    }],
  ])('keeps ordinary numeric rescue for a malformed %s result', (_name, result) => {
    const cm = makeChunkManager({
      hardVoidAt: () => result,
      floorHoleAt: (_gx, _gz, floor) => floor >= 1,
    })
    const controller = makeController()
    controller.onVoidDeath = vi.fn()
    controller.teleport(POSITION, POSITION, START_CY)

    for (let i = 0; i < STEP_LIMIT; i++) controller.step(STEP_DT, cm)

    expect(controller.onVoidDeath).not.toHaveBeenCalled()
    expect(controller.pos.y).toBe(layerY(0))
    expect(controller.floor).toBe(0)
    expect(controller.grounded).toBe(true)
  })

  it('clears the latched plane and one-shot guard when level setup teleports the player', () => {
    let plane = lethalPlane('tower', 0x7100)
    const cm = makeChunkManager({
      hardVoidAt: () => plane,
      floorHoleAt: (_gx, _gz, floor) => floor >= 1,
    })
    const controller = makeController()
    controller.onVoidDeath = vi.fn()

    controller.teleport(POSITION, POSITION, START_CY)
    stepUntilCalls(controller, cm, controller.onVoidDeath, 1)
    expect(controller.onVoidDeath).toHaveBeenNthCalledWith(1, {
      id: plane.id,
      family: plane.family,
    })

    plane = lethalPlane('lattice', 0x1a771ce)
    controller.teleport(POSITION, POSITION, START_CY)
    stepUntilCalls(controller, cm, controller.onVoidDeath, 2)

    expect(controller.onVoidDeath).toHaveBeenCalledTimes(2)
    expect(controller.onVoidDeath).toHaveBeenNthCalledWith(2, {
      id: plane.id,
      family: plane.family,
    })
  })
})
