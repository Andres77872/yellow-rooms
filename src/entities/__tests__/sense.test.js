import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { sightGate, findHiddenSpot } from '../sense.js'
import { STAIR_SIGHT_R, LAYER_H } from '../../world/constants.js'

// Floor-gated sensing truth table. The mock CM is wall-free (LOS always clear
// in 2D) so the FLOOR gate is what's under test; apertures are injected.
function makeCM(apertures = [], blocked = () => false) {
  const m = new Map()
  apertures.forEach((a, i) => m.set(String(i), a))
  return {
    wallVAt: () => false,
    wallHAt: () => false,
    columnAt: () => false,
    isBlocked: blocked,
    apertures: m,
  }
}

// A camera at `from` looking at `at` — the frustum genuinely contains targets
// ahead of it, so the gate's frustum stage behaves as in game.
function cameraAt(from, at) {
  const cam = new THREE.PerspectiveCamera(72, 16 / 9, 0.1, 200)
  cam.position.set(from.x, from.y, from.z)
  cam.lookAt(at.x, at.y, at.z)
  cam.updateMatrixWorld(true)
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert()
  return cam
}

const feet = (x, cy, z) => ({ x, y: cy * LAYER_H, z })

// A realistic two-chunk aperture registry for a ten-storey structure. Each
// slab is represented by two local descriptors (the same shape Chunk emits),
// so sight must join them at the x=42 chunk seam before evaluating the shaft.
function tallStack({
  baseCy = 0,
  topCy = 9,
  id = 'atrium:a',
  missingCy = null,
  mismatchedCy = null,
  regionFor = () => ({ minX: 0, maxX: 66, minZ: 3, maxZ: 9 }),
} = {}) {
  const apertures = []
  for (let lowerCy = baseCy; lowerCy < topCy; lowerCy++) {
    if (lowerCy === missingCy) continue
    const global = regionFor(lowerCy)
    for (const [sliceMinX, sliceMaxX] of [[0, 42], [42, 66]]) {
      const minX = Math.max(global.minX, sliceMinX)
      const maxX = Math.min(global.maxX, sliceMaxX)
      if (minX >= maxX) continue
      apertures.push({
        kind: 'multilevel',
        id: lowerCy === mismatchedCy ? 'atrium:other' : id,
        structureKind: 'bridged',
        baseCy,
        topCy,
        lowerCy,
        centerX: (minX + maxX) / 2,
        centerZ: (global.minZ + global.maxZ) / 2,
        minX,
        maxX,
        minZ: global.minZ,
        maxZ: global.maxZ,
        regions: [{ minX, maxX, minZ: global.minZ, maxZ: global.maxZ }],
      })
    }
  }
  return apertures
}

describe('sightGate floor gating', () => {
  const player = feet(0, 0, 0)

  it('same floor: visible with clear LOS in frustum', () => {
    const ent = feet(10, 0, 0)
    const cam = cameraAt({ x: 0, y: 1.7, z: 0 }, { x: 10, y: 1.6, z: 0 })
    expect(sightGate(makeCM(), cam, ent, 0, player, 0, 60)).toBe(true)
  })

  it('two floors apart: independent apertures cannot masquerade as a shaft', () => {
    const ent = feet(10, 2, 0)
    const cam = cameraAt({ x: 0, y: 1.7, z: 0 }, { x: 10, y: 2 * LAYER_H, z: 0 })
    const cm = makeCM([{ centerX: 5, centerZ: 0, lowerCy: 0 }, { centerX: 5, centerZ: 0, lowerCy: 1 }])
    expect(sightGate(cm, cam, ent, 2, player, 0, 60)).toBe(false)
  })

  it('sees bottom-to-top through a complete ten-level two-chunk shaft', () => {
    const low = feet(3, 0, 6)
    const high = feet(63, 9, 6)
    const cam = cameraAt(
      { x: low.x, y: low.y + 1.7, z: low.z },
      { x: high.x, y: high.y + 1.6, z: high.z }
    )
    expect(sightGate(makeCM(tallStack()), cam, high, 9, low, 0, 120)).toBe(true)
  })

  it('rejects a tall shaft with any missing intervening slab aperture', () => {
    const low = feet(3, 0, 6)
    const high = feet(63, 9, 6)
    const cam = cameraAt(
      { x: low.x, y: low.y + 1.7, z: low.z },
      { x: high.x, y: high.y + 1.6, z: high.z }
    )
    expect(
      sightGate(makeCM(tallStack({ missingCy: 4 })), cam, high, 9, low, 0, 120)
    ).toBe(false)
  })

  it('rejects aperture slices spliced from different structure ids', () => {
    const low = feet(3, 0, 6)
    const high = feet(63, 9, 6)
    const cam = cameraAt(
      { x: low.x, y: low.y + 1.7, z: low.z },
      { x: high.x, y: high.y + 1.6, z: high.z }
    )
    expect(
      sightGate(makeCM(tallStack({ mismatchedCy: 4 })), cam, high, 9, low, 0, 120)
    ).toBe(false)
  })

  it('rejects actors away from the tall opening', () => {
    const outside = feet(3, 0, -20)
    const high = feet(63, 9, 6)
    const cam = cameraAt(
      { x: outside.x, y: outside.y + 1.7, z: outside.z },
      { x: high.x, y: high.y + 1.6, z: high.z }
    )
    expect(sightGate(makeCM(tallStack()), cam, high, 9, outside, 0, 120)).toBe(false)
  })

  it('rejects a vertical sight ray beside the shaft even when both actors are nearby', () => {
    // z=-1 is only four world units from the aperture edge (inside the normal
    // proximity allowance), but the eye-to-eye ray never enters z=3..9. Every
    // intervening slab is therefore solid along the rendered sight line.
    const low = feet(3, 0, -1)
    const high = feet(3.2, 9, -1)
    const cam = cameraAt(
      { x: low.x, y: low.y + 1.7, z: low.z },
      { x: high.x, y: high.y + 1.6, z: high.z }
    )
    expect(STAIR_SIGHT_R).toBeGreaterThan(4)
    expect(sightGate(makeCM(tallStack()), cam, high, 9, low, 0, 120)).toBe(false)
  })

  it('rejects a complete id chain with no unobstructed vertical column', () => {
    const low = feet(3, 0, 0)
    const high = feet(63, 9, 0)
    const cam = cameraAt(
      { x: low.x, y: low.y + 1.7, z: low.z },
      { x: high.x, y: high.y + 1.6, z: high.z }
    )
    const alternating = tallStack({
      regionFor: (lowerCy) => lowerCy % 2 === 0
        ? { minX: 0, maxX: 66, minZ: -9, maxZ: -3 }
        : { minX: 0, maxX: 66, minZ: 3, maxZ: 9 },
    })
    expect(sightGate(makeCM(alternating), cam, high, 9, low, 0, 120)).toBe(false)
  })

  it('one floor apart: blind without an aperture, visible near a shared one', () => {
    const ent = feet(6, 1, 0)
    const cam = cameraAt({ x: 0, y: 1.7, z: 0 }, { x: 6, y: LAYER_H, z: 0 })
    // No aperture: the slab blocks.
    expect(sightGate(makeCM(), cam, ent, 1, player, 0, 60)).toBe(false)
    // Shared aperture between floors 0-1, both parties within STAIR_SIGHT_R:
    const near = makeCM([{ centerX: 3, centerZ: 0, lowerCy: 0 }])
    expect(sightGate(near, cam, ent, 1, player, 0, 60)).toBe(true)
    // Aperture of the WRONG slab (1-2) does not help:
    const wrong = makeCM([{ centerX: 3, centerZ: 0, lowerCy: 1 }])
    expect(sightGate(wrong, cam, ent, 1, player, 0, 60)).toBe(false)
    // Aperture too far from either party: blind.
    const far = makeCM([{ centerX: STAIR_SIGHT_R + 50, centerZ: 0, lowerCy: 0 }])
    expect(sightGate(far, cam, ent, 1, player, 0, 60)).toBe(false)
  })

  it('uses a multilevel room lobe instead of reducing the wide void to one point', () => {
    const ent = feet(20, 1, 0)
    const cam = cameraAt({ x: 0, y: 1.7, z: 0 }, { x: 20, y: LAYER_H, z: 0 })
    const room = makeCM([{
      centerX: 12,
      centerZ: 0,
      lowerCy: 0,
      regions: [{ minX: 0, maxX: 24, minZ: -3, maxZ: 3 }],
    }])
    // Both parties are inside the same open lobe although each is farther than
    // STAIR_SIGHT_R from the descriptor center.
    expect(sightGate(room, cam, ent, 1, player, 0, 60)).toBe(true)
  })

  it('mid-transit: a player on the connecting stair still observes the lower floor', () => {
    // Feet just past the handoff (hysteresis floor = 1) but standing on the
    // stair's lower-layer strip: the entity at the stair base is plainly on
    // screen and must read as observed (else it could despawn in full view).
    const playerMid = { x: 6, y: LAYER_H - 0.6, z: 0 } // mid-band, floor index 1
    const ent = feet(2, 0, 0)
    const cam = cameraAt({ x: 6, y: LAYER_H + 1.1, z: 0 }, { x: 2, y: 1.6, z: 0 })
    const cm = makeCM()
    // Their cell resolves to the stair's lower-layer strip:
    cm.stairAt = (gx, gz, cy) =>
      cy === 0 && gx === Math.floor(6 / 3) && gz === 0
        ? { part: 'run', baseCy: 0 }
        : null
    expect(sightGate(cm, cam, ent, 0, playerMid, 1, 60)).toBe(true)
    // Same geometry but the player is NOT over the strip: slab blocks (no aperture).
    cm.stairAt = () => null
    expect(sightGate(cm, cam, ent, 0, playerMid, 1, 60)).toBe(false)
  })

  it('3D distance gates before anything else', () => {
    const ent = feet(100, 0, 0)
    const cam = cameraAt({ x: 0, y: 1.7, z: 0 }, { x: 100, y: 1.6, z: 0 })
    expect(sightGate(makeCM(), cam, ent, 0, player, 0, 60)).toBe(false)
  })
})

describe('findHiddenSpot floor policy', () => {
  // Camera looking away so nothing is in frustum; deterministic rng.
  const cam = cameraAt({ x: 0, y: 1.7, z: 0 }, { x: -100, y: 1.7, z: 0 })
  const seq = (vals) => {
    let i = 0
    return () => vals[i++ % vals.length]
  }

  it("'same' policy always lands on the player's floor", () => {
    const cm = makeCM()
    for (let k = 0; k < 8; k++) {
      const s = findHiddenSpot(cm, cam, 0, 0, 3, 10, 20, {
        requireOffscreen: false,
        rng: seq([(0.13 * (k + 1)) % 1, 0.7, 0.3, 0.9]),
      })
      expect(s).not.toBeNull()
      expect(s.cy).toBe(3)
    }
  })

  it("'dread' policy sometimes lands one floor off", () => {
    const cm = makeCM()
    // rng: ang, dist, dreadRoll(<0.2 -> off-floor), sign
    const off = findHiddenSpot(cm, cam, 0, 0, 3, 10, 20, {
      floorPolicy: 'dread',
      requireOffscreen: false, // the floor policy is what's under test
      rng: seq([0.5, 0.5, 0.1, 0.9]),
    })
    expect(off.cy).toBe(2) // 0.1 < 0.2 dread; sign roll 0.9 >= 0.5 -> one floor DOWN
    const on = findHiddenSpot(cm, cam, 0, 0, 3, 10, 20, {
      floorPolicy: 'dread',
      requireOffscreen: false,
      rng: seq([0.5, 0.5, 0.9]),
    })
    expect(on.cy).toBe(3)
  })

  it('rejects blocked cells (fail-closed covers unloaded chunks and holes)', () => {
    const cm = makeCM([], () => true) // everything blocked
    expect(findHiddenSpot(cm, cam, 0, 0, 0, 10, 20, { rng: seq([0.1, 0.5]) })).toBeNull()
  })
})
