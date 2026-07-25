import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { DeferredRenderer } from '../DeferredRenderer.js'
import { LightField, makeLampUniforms } from '../LightField.js'
import { LIGHT_MAX, LAMP_QUERY_R, LAMP_FADE_BAND, EYE_H, layerY } from '../../world/constants.js'

// The set-edge fade exists so lamps entering/leaving the uploaded set ramp to
// zero instead of snapping a whole floor pool on and off mid-walk.
//
// It used to be anchored to LAMP_QUERY_R, which is only the boundary while the
// candidate list FITS. On the office lamp grid a 60u query circle holds ~92 lit
// fixtures for LIGHT_MAX=72 slots, so the real boundary was the 72nd-nearest
// lamp (~53u) — inside the nominal [48,60] band, leaving lamps popping out at
// ~60% weight. LightField now publishes where the set actually ends and the
// renderer fades against that.

function makeRenderer(width = 320, height = 180, pixelRatio = 1) {
  return {
    setClearColor: vi.fn(),
    setRenderTarget: vi.fn(),
    render: vi.fn(),
    getPixelRatio: () => pixelRatio,
    getSize: (out) => out.set(width, height),
  }
}

function makeDeferred() {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 200)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return new DeferredRenderer(makeRenderer(), new THREE.Scene(), camera)
}

// Weight the renderer should derive for a lamp `dist` from the camera when the
// uploaded set ends at `cutoff` — the contract this file locks.
function expectedWeight(dist, cutoff, raw = 1) {
  const band = Math.min(LAMP_FADE_BAND, cutoff * 0.25)
  const t = Math.min(1, Math.max(0, (dist - (cutoff - band)) / band))
  return raw * (1 - t * t * (3 - 2 * t))
}

// A ChunkManager stub returning lamps at fixed eye distances along +x.
function makeCM(distances) {
  return {
    collectLampsNear(px, pz, out) {
      out.length = 0
      for (const d of distances) out.push({ x: px + d, y: layerY(0) + EYE_H, z: pz, cy: 0 })
      return out
    },
  }
}

describe('LightField publishes where the uploaded set ends', () => {
  it('reports the full query radius while the candidate list fits', () => {
    const u = makeLampUniforms()
    const field = new LightField(u)
    const distances = Array.from({ length: LIGHT_MAX - 10 }, (_, i) => i + 1)
    field.update(1, 0, 0, 0, makeCM(distances))

    expect(u.uLampCount.value).toBe(distances.length)
    expect(u.cutoffR).toBe(LAMP_QUERY_R)
  })

  it('reports the LIGHT_MAX-th nearest distance once the cap binds', () => {
    const u = makeLampUniforms()
    const field = new LightField(u)
    // 92 candidates inside 60u — the measured office density (0.0081 lit
    // lamps/u² over a 60u circle) against 72 slots.
    const distances = Array.from({ length: 92 }, (_, i) => (i + 1) * 0.5)
    field.update(1, 0, 0, 0, makeCM(distances))

    expect(u.uLampCount.value).toBe(LIGHT_MAX)
    expect(u.cutoffR).toBeCloseTo(distances[LIGHT_MAX - 1], 6)
    // The whole point: the real edge is well inside the nominal fade window.
    expect(u.cutoffR).toBeLessThan(LAMP_QUERY_R - LAMP_FADE_BAND)
  })

  it('ranks by eye distance regardless of candidate order', () => {
    const u = makeLampUniforms()
    const field = new LightField(u)
    const distances = [40, 5, 22, 11]
    field.update(1, 0, 0, 0, makeCM(distances))

    const uploaded = u.uLampPos.value.slice(0, 4).map((v) => v.x)
    expect(uploaded).toEqual([5, 11, 22, 40])
  })

  it('reset() restores the full radius and a steady flicker floor', () => {
    const u = makeLampUniforms()
    const field = new LightField(u)
    field.update(1, 0, 0, 0, makeCM(Array.from({ length: 92 }, (_, i) => (i + 1) * 0.5)))
    expect(u.cutoffR).toBeLessThan(LAMP_QUERY_R)

    field.reset()
    expect(u.uLampCount.value).toBe(0)
    expect(u.cutoffR).toBe(LAMP_QUERY_R)
    expect([...u.lampFlickerRaw].every((v) => v === 1)).toBe(true)
  })
})

describe('DeferredRenderer fades against the published set edge', () => {
  const place = (deferred, dist, raw = 1) => {
    deferred.lamps.uLampPos.value[0].set(0, 0, -dist)
    deferred.lamps.uLampChar.value[0].set(1, 1, 1, 1)
    deferred.lamps.lampFlickerRaw[0] = raw
    deferred.lamps.uLampCount.value = 1
  }
  const weight = (deferred) => deferred.visibleLamps.uLampChar.value[0].w

  it('keeps the historical [48,60] ramp when the cap is not binding', () => {
    const deferred = makeDeferred()
    place(deferred, 54)
    deferred._updateFrame()
    expect(weight(deferred)).toBeCloseTo(expectedWeight(54, LAMP_QUERY_R), 6)
    expect(weight(deferred)).toBeCloseTo(0.5, 6)
    deferred.dispose()
  })

  it('takes a lamp at the real cutoff to zero instead of ~60% weight', () => {
    const deferred = makeDeferred()
    // A hard-binding cap: the set ends at 24u, far inside the old anchor.
    deferred.lamps.cutoffR = 24
    place(deferred, 24)
    deferred._updateFrame()
    expect(deferred.visibleLamps.uLampCount.value).toBe(1)
    expect(weight(deferred)).toBeCloseTo(0, 6)

    // Anchored at LAMP_QUERY_R (the old behaviour) this lamp was at full
    // weight, so it vanished in one step when the candidate set churned.
    expect(expectedWeight(24, LAMP_QUERY_R)).toBe(1)
    deferred.dispose()
  })

  it('ramps smoothly across the band ahead of the cutoff', () => {
    const deferred = makeDeferred()
    const cutoff = 40 // band = min(12, 10) = 10 -> ramp over [30, 40]
    deferred.lamps.cutoffR = cutoff
    let prev = Infinity
    for (const dist of [28, 32, 35, 38, 40, 44]) {
      place(deferred, dist)
      deferred._updateFrame()
      const w = weight(deferred)
      expect(w).toBeCloseTo(expectedWeight(dist, cutoff), 6)
      expect(w).toBeLessThanOrEqual(prev)
      prev = w
    }
    expect(prev).toBeCloseTo(0, 6)
    deferred.dispose()
  })

  it('caps the band at a quarter of a tight cutoff so it dims only its own edge', () => {
    const deferred = makeDeferred()
    deferred.lamps.cutoffR = 16 // band = 4, not the full LAMP_FADE_BAND of 12
    place(deferred, 11) // 5u inside the cutoff -> outside the band entirely
    deferred._updateFrame()
    expect(weight(deferred)).toBe(1)
    deferred.dispose()
  })

  it('does not fade an authored set (LightRoom sets cutoffR = Infinity)', () => {
    const deferred = makeDeferred()
    deferred.lamps.cutoffR = Infinity
    place(deferred, 150) // past every finite anchor
    deferred._updateFrame()
    expect(deferred.visibleLamps.uLampCount.value).toBe(1)
    expect(weight(deferred)).toBe(1)
    deferred.dispose()
  })

  it('still multiplies the fade into the raw per-fixture flicker', () => {
    const deferred = makeDeferred()
    deferred.lamps.cutoffR = 40
    place(deferred, 35, 0.4)
    deferred._updateFrame()
    expect(weight(deferred)).toBeCloseTo(expectedWeight(35, 40, 0.4), 6)
    deferred.dispose()
  })
})
