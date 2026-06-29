import * as THREE from 'three'
import { LIGHT_MAX } from '../world/constants.js'

// Feeds the deferred lighting pass: each refresh it gathers the nearest lit
// lamps to the player and writes their world positions into the shared uniform
// array the lighting shader loops over. Unlike the old forward LightPool (capped
// at 8 real PointLights), this shades up to LIGHT_MAX lamps in one pass.
export class LightField {
  constructor(posUniform, countUniform) {
    this.posU = posUniform // { value: Vector3[LIGHT_MAX] }
    this.countU = countUniform // { value: int }
    this._cand = []
    this._t = 0
  }

  reset() {
    this.countU.value = 0
    this._t = 0
  }

  update(dt, px, pz, cm) {
    this._t -= dt
    if (this._t > 0) return
    this._t = 0.08 // refresh ~12 Hz; lamps are static, only the near set changes

    const cand = cm.collectLampsNear(px, pz, this._cand)
    cand.sort(
      (a, b) =>
        (a.x - px) * (a.x - px) + (a.z - pz) * (a.z - pz) -
        ((b.x - px) * (b.x - px) + (b.z - pz) * (b.z - pz))
    )
    const n = Math.min(cand.length, LIGHT_MAX)
    for (let i = 0; i < n; i++) this.posU.value[i].copy(cand[i])
    this.countU.value = n
  }
}

export function makeLampUniforms() {
  const pos = new Array(LIGHT_MAX)
  for (let i = 0; i < LIGHT_MAX; i++) pos[i] = new THREE.Vector3()
  return { uLampPos: { value: pos }, uLampCount: { value: 0 } }
}
