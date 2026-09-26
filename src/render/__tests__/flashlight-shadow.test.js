import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { FlashlightShadow } from '../FlashlightShadow.js'

// The torch map's re-render skip (chapter 14 P15): a still emitter over an
// unchanged caster set reuses last frame's map, and nothing else does.
function fakeRenderer() {
  return {
    autoClear: true,
    setRenderTarget: vi.fn(),
    render: vi.fn(),
    getClearAlpha: () => 1,
    getClearColor: (c) => c,
    setClearColor: vi.fn(),
  }
}

describe('FlashlightShadow.update skip', () => {
  it('reuses the map only for the same scene, revision and pose', () => {
    const fs = new FlashlightShadow(256)
    const r = fakeRenderer()
    const cam = new THREE.PerspectiveCamera()
    cam.updateMatrixWorld(true)
    const world = new THREE.Scene()
    fs.update(r, world, cam, 7)
    fs.update(r, world, cam, 7)
    expect(fs.stats).toEqual({ renders: 1, skips: 1 })
    // Another scene (the debug light room) with the same revision re-renders.
    fs.update(r, new THREE.Scene(), cam, 7)
    expect(fs.stats.renders).toBe(2)
    // A new caster revision, then invalidate() (context restore) re-render.
    fs.update(r, world, cam, 8)
    fs.invalidate()
    fs.update(r, world, cam, 8)
    expect(fs.stats.renders).toBe(4)
    // No revision (an enemy near the beam) never skips.
    fs.update(r, world, cam, null)
    fs.update(r, world, cam, null)
    expect(fs.stats.renders).toBe(6)
    fs.dispose()
  })
})
