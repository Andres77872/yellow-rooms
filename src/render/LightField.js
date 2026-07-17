import * as THREE from 'three'
import { LIGHT_MAX, EYE_H, layerY } from '../world/constants.js'

// Feeds the deferred lighting pass: each refresh it gathers the nearest lit
// lamps to the player and writes their world positions into the shared uniform
// array the lighting shader loops over. Unlike the old forward LightPool (capped
// at 8 real PointLights), this shades up to LIGHT_MAX lamps in one pass.
//
// Candidates are FLOOR-FILTERED by ChunkManager (same-floor lamps, cy±1 lamps
// near stairs, and physically reachable lamps inside one tall structure), and the
// nearest-N sort uses true 3D distance to the eye, so off-floor spill lamps
// (>= 3.6u of dy) naturally rank behind same-floor lamps for the shadow-march
// and volumetric budgets, which take the head of this array.
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

  update(dt, px, pz, pcy, cm) {
    this._t -= dt
    if (this._t > 0) return
    this._t = 0.08 // refresh ~12 Hz; lamps are static, only the near set changes

    const py = layerY(pcy) + EYE_H
    const cand = cm.collectLampsNear(px, pz, this._cand, pcy)
    const d2 = (v) =>
      (v.x - px) * (v.x - px) + (v.y - py) * (v.y - py) + (v.z - pz) * (v.z - pz)
    cand.sort((a, b) => d2(a) - d2(b))
    const n = Math.min(cand.length, LIGHT_MAX)
    for (let i = 0; i < n; i++) this.posU.value[i].copy(cand[i])
    this.countU.value = n
  }
}

export function makeLampUniforms() {
  // uLampPos = world-space (written by LightField); uLampViewPos = view-space,
  // filled on the CPU once per frame by DeferredRenderer so the lighting / shadow
  // / volumetric shaders read view-space lamps directly instead of doing a
  // mat4*vec4 per lamp per pixel in each pass.
  const pos = new Array(LIGHT_MAX)
  const viewPos = new Array(LIGHT_MAX)
  for (let i = 0; i < LIGHT_MAX; i++) {
    pos[i] = new THREE.Vector3()
    viewPos[i] = new THREE.Vector3()
  }
  return { uLampPos: { value: pos }, uLampViewPos: { value: viewPos }, uLampCount: { value: 0 } }
}
