import { describe, expect, it } from 'vitest'
import { LightField, makeLampUniforms } from '../LightField.js'
import { FLICKER_FULL, isBadTube, lampFlicker } from '../../world/lampCharacter.js'
import { CELL, layerY } from '../../world/constants.js'

// Candidates carry their floor as a `cy` tag beside x/y/z. The uploaded
// uLampPos slots are plain Vector3s, so the floor must travel separately or
// every off-ground lamp would flicker with floor 0's fixture identity.
describe('LightField', () => {
  const lampsOn = (cy) => ({
    collectLampsNear(_px, _pz, out) {
      out.length = 0
      for (let i = 0; i < 4; i++) {
        out.push({ x: 3 + i * 7.3, y: layerY(cy) + 2.9, z: 5 + i * 3.1, cy, role: 0 })
      }
      return out
    },
  })

  it('flickers each uploaded lamp with its own floor identity', () => {
    const u = makeLampUniforms()
    const field = new LightField(u)
    const cy = 3
    field.update(0.5, 0, 0, cy, lampsOn(cy))

    expect(u.uLampCount.value).toBe(4)
    for (let i = 0; i < 4; i++) {
      const p = u.uLampPos.value[i]
      expect(u.lampFlickerRaw[i]).toBeCloseTo(lampFlicker(p.x, p.z, cy, 0.5), 6)
    }
  })

  // mesh.js tags each lit lamp with its wear-driven bad answer (lampIsBad);
  // the cast light must strobe exactly the tubes the panels show browned,
  // never re-roll the position lottery.
  it('strobes the tubes the candidates are tagged bad, not a re-roll', () => {
    const spots = []
    for (let g = 0; spots.length < 6; g++) {
      const x = (g * 5 + 0.5) * CELL
      const z = (g * 3 + 0.5) * CELL
      // Tags opposite to the lottery: only the tag can explain the result.
      spots.push({ x, y: 2.9, z, cy: 0, role: 0, bad: !isBadTube(x, z, 0) })
    }
    const cm = {
      collectLampsNear(_px, _pz, out) {
        out.length = 0
        out.push(...spots)
        return out
      },
    }
    const u = makeLampUniforms()
    const field = new LightField(u)
    field.flicker = FLICKER_FULL
    field.update(0.5, 0, 0, 0, cm)
    expect(u.uLampCount.value).toBe(spots.length)
    for (let i = 0; i < spots.length; i++) {
      const p = u.uLampPos.value[i]
      const v = spots.find((s) => s.x === p.x && s.z === p.z)
      expect(u.lampFlickerRaw[i]).toBeCloseTo(lampFlicker(p.x, p.z, 0, 0.5, FLICKER_FULL, v.bad), 6)
    }
  })
})
