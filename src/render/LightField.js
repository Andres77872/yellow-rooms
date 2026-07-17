import * as THREE from 'three'
import { LIGHT_MAX, EYE_H, layerY } from '../world/constants.js'
import { lampFlicker, lampTint } from '../world/lampCharacter.js'

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
//
// Each lamp also carries its fixture identity (lampCharacter.js): a static
// colour-temperature tint uploaded with the position, and a per-frame flicker
// multiplier recomputed from the UPLOADED world positions — so the shimmer
// stays smooth between the 12 Hz candidate refreshes and a fixture's cast
// light always agrees with its emissive panel (which mesh.js tints at build).
export class LightField {
  constructor(uniforms) {
    this.u = uniforms // the full makeLampUniforms() set
    this._cand = []
    this._t = 0
    this._time = 0
    this._tint = [0, 0, 0]
  }

  reset() {
    this.u.uLampCount.value = 0
    this._t = 0
  }

  update(dt, px, pz, pcy, cm) {
    this._time += dt
    this._t -= dt

    if (this._t <= 0) {
      this._t = 0.08 // refresh ~12 Hz; lamps are static, only the near set changes
      const py = layerY(pcy) + EYE_H
      const cand = cm.collectLampsNear(px, pz, this._cand, pcy)
      const d2 = (v) =>
        (v.x - px) * (v.x - px) + (v.y - py) * (v.y - py) + (v.z - pz) * (v.z - pz)
      cand.sort((a, b) => d2(a) - d2(b))
      const n = Math.min(cand.length, LIGHT_MAX)
      const pos = this.u.uLampPos.value
      const char = this.u.uLampChar.value
      for (let i = 0; i < n; i++) {
        const v = cand[i]
        pos[i].copy(v)
        lampTint(v.x, v.z, v.cy ?? 0, this._tint)
        char[i].set(this._tint[0], this._tint[1], this._tint[2], 1)
      }
      this.u.uLampCount.value = n
    }

    // Per-frame flicker: <= LIGHT_MAX hash+sin evaluations, no allocations.
    const n = this.u.uLampCount.value
    const pos = this.u.uLampPos.value
    const char = this.u.uLampChar.value
    for (let i = 0; i < n; i++) {
      const v = pos[i]
      char[i].w = lampFlicker(v.x, v.z, v.cy ?? 0, this._time)
    }
  }
}

export function makeLampUniforms() {
  // uLampPos = world-space (written by LightField); uLampViewPos = view-space,
  // filled on the CPU once per frame by DeferredRenderer so the lighting / shadow
  // / volumetric shaders read view-space lamps directly instead of doing a
  // mat4*vec4 per lamp per pixel in each pass. uLampChar packs the per-fixture
  // identity (rgb tint, a flicker) sharing the position arrays' indexing.
  const pos = new Array(LIGHT_MAX)
  const viewPos = new Array(LIGHT_MAX)
  const char = new Array(LIGHT_MAX)
  for (let i = 0; i < LIGHT_MAX; i++) {
    pos[i] = new THREE.Vector3()
    viewPos[i] = new THREE.Vector3()
    char[i] = new THREE.Vector4(1, 1, 1, 1)
  }
  return {
    uLampPos: { value: pos },
    uLampViewPos: { value: viewPos },
    uLampCount: { value: 0 },
    // Per-fixture identity packed as vec4(rgb = colour-temperature tint,
    // a = flicker) — one array, not two, keeps every pass well under the 224
    // vec4 fragment-uniform floor WebGL2 guarantees on weak GPUs.
    uLampChar: { value: char },
  }
}
