import * as THREE from 'three'
import { LIGHT_MAX, LAMP_QUERY_R, EYE_H, layerY } from '../world/constants.js'
import { FLICKER_SAFE, lampFlicker, lampTint } from '../world/lampCharacter.js'

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
    this._d2 = new Float64Array(128) // candidate eye-distances², grown on demand
    this._order = [] // candidate indices, sorted by _d2
    this._t = 0
    this._time = 0
    this._tint = [0, 0, 0]
    // Floor index per uploaded slot. uLampPos holds plain Vector3s, so the
    // candidates' `cy` tag does not survive the copy; the per-frame flicker
    // must hash the same (x, z, cy) as the tint and the emissive panel.
    this._cy = new Int32Array(LIGHT_MAX)
    // Bad-tube strobe rate/depth (lampCharacter FLICKER_SAFE / FLICKER_FULL),
    // set by Engine from the reduceFlicker setting. Must match the GPU twin's
    // uBadStrobe (DeferredRenderer.setFlickerProfile).
    this.flicker = FLICKER_SAFE
  }

  reset() {
    this.u.uLampCount.value = 0
    this.u.cutoffR = LAMP_QUERY_R
    this.u.lampFlickerRaw.fill(1)
    this._t = 0
  }

  update(dt, px, pz, pcy, cm) {
    this._time += dt
    this._t -= dt

    if (this._t <= 0) {
      this._t = 0.08 // refresh ~12 Hz; lamps are static, only the near set changes
      const py = layerY(pcy) + EYE_H
      const cand = cm.collectLampsNear(px, pz, this._cand, pcy)
      // Rank by eye distance. The distance is derived ONCE per candidate into a
      // side buffer and an index array is sorted, instead of re-deriving two
      // 3-component distances inside every comparison (~2·N·log2 N of them).
      const total = cand.length
      if (this._d2.length < total) this._d2 = new Float64Array(total * 2)
      const d2 = this._d2
      const order = this._order
      order.length = total
      for (let i = 0; i < total; i++) {
        const v = cand[i]
        const dx = v.x - px
        const dy = v.y - py
        const dz = v.z - pz
        d2[i] = dx * dx + dy * dy + dz * dz
        order[i] = i
      }
      order.sort((a, b) => d2[a] - d2[b])
      const n = Math.min(total, LIGHT_MAX)
      const pos = this.u.uLampPos.value
      const char = this.u.uLampChar.value
      for (let i = 0; i < n; i++) {
        const v = cand[order[i]]
        pos[i].copy(v)
        this._cy[i] = v.cy ?? 0
        lampTint(v.x, v.z, v.cy ?? 0, this._tint, v.role ?? 0)
        char[i].set(this._tint[0], this._tint[1], this._tint[2], char[i].w)
      }
      this.u.uLampCount.value = n
      // Publish where the uploaded set ACTUALLY ends so the renderer's edge fade
      // has something real to ramp against. LAMP_QUERY_R is only the boundary
      // while the candidate list fits; on the office lamp grid a 60u circle
      // holds ~92 lit fixtures for LIGHT_MAX=72 slots, so the true boundary is
      // the LIGHT_MAX-th nearest lamp (~53u) — well inside the fade band, which
      // used to leave lamps popping out at ~60% weight instead of 0.
      this.u.cutoffR = total > LIGHT_MAX ? Math.sqrt(d2[order[LIGHT_MAX - 1]]) : LAMP_QUERY_R
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
    const cy = this._cy
    const profile = this.flicker
    for (let i = 0; i < n; i++) {
      const v = pos[i]
      raw[i] = lampFlicker(v.x, v.z, cy[i], this._time, profile)
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
    // Radius at which the uploaded set ends, written by whoever fills the source
    // (LightField publishes the LIGHT_MAX-th nearest distance when the cap binds;
    // LightRoom sets Infinity because its lamps are authored, not queried). NOT a
    // uniform: DeferredRenderer._updateFrame anchors the edge fade to it.
    cutoffR: LAMP_QUERY_R,
    visible: {
      uLampViewPos: { value: visibleViewPos },
      uLampCount: { value: 0 },
      // One vec4 array instead of separate tint/weight arrays keeps every pass
      // below the 224 fragment-uniform-vector floor guaranteed by WebGL2.
      uLampChar: { value: visibleChar },
    },
  }
}
