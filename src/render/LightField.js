import * as THREE from 'three'
import { LIGHT_MAX, EYE_H, layerY } from '../world/constants.js'
import { lampFlicker, lampTint } from '../world/lampCharacter.js'

// Feeds the deferred lighting pass: each refresh it gathers the nearest lit
// lamps to the player and writes their world positions into the source lamp
// array. DeferredRenderer derives a compact, frustum-visible uniform set from
// this source every frame. Unlike the old forward LightPool (capped at 8 real
// PointLights), this shades up to LIGHT_MAX lamps in one pass.
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
        lampTint(v.x, v.z, v.cy ?? 0, this._tint, v.role ?? 0)
        char[i].set(this._tint[0], this._tint[1], this._tint[2], char[i].w)
      }
      this.u.uLampCount.value = n
    }

    // Per-frame flicker: <= LIGHT_MAX hash+sin evaluations, no allocations.
    // Written to the RAW side-array, not source uLampChar.w:
    // DeferredRenderer._updateFrame recombines raw * query-edge fade into the
    // derived visible character array every frame (it owns the fade and
    // frustum because only it knows the camera). Keeping the source pristine
    // makes the fold idempotent while the sim is frozen.
    const n = this.u.uLampCount.value
    const pos = this.u.uLampPos.value
    const raw = this.u.lampFlickerRaw
    for (let i = 0; i < n; i++) {
      const v = pos[i]
      raw[i] = lampFlicker(v.x, v.z, v.cy ?? 0, this._time)
    }
  }
}

export function makeLampUniforms() {
  // Source set, written only by LightField / LightRoom. DeferredRenderer never
  // compacts or folds per-frame state back into it, because an off-screen lamp
  // must remain available to reappear immediately when the camera turns.
  const pos = new Array(LIGHT_MAX)
  const char = new Array(LIGHT_MAX)
  // Derived renderer-local set. Positions are view-space and character alpha
  // contains raw flicker × query-edge fade. Stable compaction preserves the
  // source nearest-first order used by shadow and volumetric budgets.
  const visibleViewPos = new Array(LIGHT_MAX)
  const visibleChar = new Array(LIGHT_MAX)
  for (let i = 0; i < LIGHT_MAX; i++) {
    pos[i] = new THREE.Vector3()
    char[i] = new THREE.Vector4(1, 1, 1, 1)
    visibleViewPos[i] = new THREE.Vector3()
    visibleChar[i] = new THREE.Vector4(1, 1, 1, 1)
  }
  return {
    uLampPos: { value: pos },
    uLampCount: { value: 0 },
    // Per-fixture source identity. RGB is colour-temperature tint; alpha is
    // kept intact as source metadata while the derived set receives the live
    // flicker/fade weight.
    uLampChar: { value: char },
    // Raw per-fixture flicker written by LightField (or LightRoom). NOT a
    // uniform: DeferredRenderer._updateFrame multiplies it by the query-edge
    // set fade (a per-lamp camera-distance term) into visible.uLampChar.w each
    // frame, so all three passes see one consistent weight.
    lampFlickerRaw: new Float32Array(LIGHT_MAX).fill(1),
    visible: {
      uLampViewPos: { value: visibleViewPos },
      uLampCount: { value: 0 },
      // One vec4 array instead of separate tint/weight arrays keeps every pass
      // below the 224 fragment-uniform-vector floor guaranteed by WebGL2.
      uLampChar: { value: visibleChar },
    },
  }
}
