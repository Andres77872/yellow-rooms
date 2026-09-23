import { describe, expect, it } from 'vitest'
import { LightField, makeLampUniforms } from '../LightField.js'
import { lampFlicker } from '../../world/lampCharacter.js'
import { layerY } from '../../world/constants.js'

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
})
