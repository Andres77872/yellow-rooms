import * as THREE from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { FS_VERT, SAMPLER_PRECISION, glslFloat } from './shaders/common.js'

// Clamped automatic exposure (engine-improvement chapter 12 §4.6) and camera
// automation (chapter 14 P21).
//
// Real cameras and eyes adapt between a dark office and a fluorescent
// corridor; a fixed per-family exposure cannot. This meters the lit HDR image
// on the GPU — no read-back — and adapts an exposure value the grade pass
// samples:
//   1. meter   two 64x64 halves side by side, both centre-weighted over tLit
//              (void excluded). Left: (log2 luminance x w, w). Emissive
//              pixels (the tubes) weigh uMeterEmissive, with their log2
//              luminance clamped a few stops above the key, so a tube in
//              view dims a camera-look frame without blacking it out.
//              Right: (log2 R/G x wc, log2 B/G x wc, wc) for auto white
//              balance, wc weighting what is actually lit. Carrying sum(wc)
//              makes the chroma a true average: dividing by sum(w) scaled
//              the correction with scene brightness;
//   2. reduce  128x64 -> 32x16 -> 8x4 -> 2x1 by 4x4 box averages (four
//              bilinear taps; no block straddles the two halves);
//   3. adapt   ping-pong 2x1:
//              texel 0 = (exposure, velocity, target, avg log2 lum):
//                exposure = key / exp2(avg log lum), clamped to the family
//                exposure +- the look's EV range so horror darkness stays
//                dark. omega = 0 keeps the legacy first-order approach with
//                separate brighten/darken speeds; omega > 0 runs a damped
//                spring in log2 space (the camcorder's visible hunting, well
//                under the 3 Hz flash limit), sub-stepped to <= 1/60 s;
//              texel 1 = (white-balance gains rgb, 1): toward
//                2^(-strength * avg log chroma), renormalised to unit
//                luminance, first-order at <= 0.8/s so a flickering tube
//                cannot make it oscillate. The correction fades out as the
//                metered lit fraction drops through AWB_GATE, so dark rooms
//                read uncorrected.
// WebGL 2 has no compute; a log-average via bilinear reductions avoids the
// float blending a histogram scatter would need (EXT_float_blend).

const METER_SIZE = 64 // per half

// Lit-fraction range over which auto white balance fades in (see ADAPT_FRAG).
export const AWB_GATE = [0.05, 0.3]

const METER_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tLit;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 uStep; // quarter of a meter texel in source uv
  uniform float uMeterEmissive;
  uniform float uEmissiveCap;  // log2 luminance cap for emissive pixels
  uniform float uKey;          // scene-linear luminance the key maps to at the family exposure
  void main(){
    vec2 o[4] = vec2[](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0), vec2(1.0, 1.0));
    // Left half meters luminance, right half white-balance chroma; both
    // cover the whole frame.
    bool awb = gl_FragCoord.x >= ${METER_SIZE}.0;
    vec2 mUv = vec2(fract(vUv.x * 2.0), vUv.y);
    vec4 sum = vec4(0.0);
    for (int i = 0; i < 4; i++) {
      vec2 uv = mUv + o[i] * uStep;
      float d = texture(tDepth, uv).x;
      float cls = texture(tColor, uv).a;
      bool emissive = cls > 0.5 && cls < 1.5;
      if (d >= 1.0 || (emissive && uMeterEmissive <= 0.0)) continue;
      vec3 c = max(texture(tLit, uv).rgb, vec3(1e-5));
      float lum = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
      // Centre-weighted: the corner of a dark room matters less than what
      // the player is looking at.
      vec2 q = (uv - 0.5) * 2.0;
      float w = mix(0.25, 1.0, exp(-dot(q, q) * 1.6));
      float lg = log2(lum);
      if (emissive) { w *= uMeterEmissive; lg = min(lg, uEmissiveCap); }
      // Chroma for white balance, weighted toward what is actually lit.
      float wc = w * lum / (lum + uKey);
      sum += awb ? vec4(log2(c.r / c.g) * wc, log2(c.b / c.g) * wc, wc, 0.0) : vec4(lg * w, w, 0.0, 0.0);
    }
    outColor = sum;
  }
`

const REDUCE_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tIn;
  uniform vec2 uTexel; // source texel size
  void main(){
    // Four bilinear taps centred between 2x2 source texels cover a 4x4 block.
    // Averaged (not summed): only the ratio sum(log*w)/sum(w) matters and a
    // running sum of 4096 texels would overflow half floats.
    vec4 s = vec4(0.0);
    s += texture(tIn, vUv + uTexel * vec2(-1.0, -1.0));
    s += texture(tIn, vUv + uTexel * vec2(1.0, -1.0));
    s += texture(tIn, vUv + uTexel * vec2(-1.0, 1.0));
    s += texture(tIn, vUv + uTexel * vec2(1.0, 1.0));
    outColor = s * 0.25;
  }
`

const ADAPT_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tMeter;
  uniform sampler2D tPrev;
  uniform float uDt;
  uniform float uKey;
  uniform float uBase;      // family exposure (the fixed look's value)
  uniform float uMinEv;
  uniform float uMaxEv;
  uniform float uBias;      // EV offset
  uniform float uSpeedUp;   // brightening (entering darkness) rate, 1/s
  uniform float uSpeedDown; // darkening (entering light) rate, 1/s
  uniform float uOmega;     // spring angular frequency (0 = first-order)
  uniform float uDamping;   // spring damping ratio
  uniform float uAwbStrength;
  uniform float uAwbSpeed;
  uniform float uReset;
  void main(){
    vec4 m = texelFetch(tMeter, ivec2(0, 0), 0); // (avg log2 lum x w, w)
    vec4 c = texelFetch(tMeter, ivec2(1, 0), 0); // (log2 R/G x wc, log2 B/G x wc, wc)
    int tx = int(gl_FragCoord.x);
    vec4 prev = texelFetch(tPrev, ivec2(tx, 0), 0);
    bool reset = uReset > 0.5;
    if (tx == 1) {
      // Auto white balance gains (texel 1).
      vec3 target = vec3(1.0);
      if (uAwbStrength > 0.0 && c.z > 1e-6) {
        vec2 lc = c.xy / c.z; // brightness-weighted avg log2(R/G), log2(B/G)
        // Explicit darkness gate: c.z / m.y is the mean lit fraction
        // lum / (lum + scene key), which depends only on how far the scene
        // sits below the family key (0.5 at EV 0, 0.15 at +2.5 EV). A
        // camera's AWB has no signal in the dark, so dim rooms keep their
        // dusk-blue cast while every normally lit room gets the same
        // correction.
        lc *= smoothstep(${glslFloat(AWB_GATE[0])}, ${glslFloat(AWB_GATE[1])}, c.z / max(m.y, 1e-6));
        target = vec3(exp2(-uAwbStrength * lc.x), 1.0, exp2(-uAwbStrength * lc.y));
        target /= dot(target, vec3(0.2126, 0.7152, 0.0722));
      }
      vec3 g = (reset || prev.a <= 0.0) ? target : prev.rgb + (target - prev.rgb) * (1.0 - exp(-uDt * uAwbSpeed));
      outColor = vec4(g, 1.0);
      return;
    }
    float avgLog = m.y > 1e-4 ? m.x / m.y : -2.5;
    float target = uKey / exp2(avgLog);
    target = clamp(target, uBase * exp2(uMinEv), uBase * exp2(uMaxEv)) * exp2(uBias);
    float e = prev.r;
    float v = prev.g;
    if (reset || e <= 0.0) {
      e = target;
      v = 0.0;
    } else if (uOmega <= 0.0) {
      float speed = target > e ? uSpeedUp : uSpeedDown;
      e = e + (target - e) * (1.0 - exp(-uDt * speed));
      v = 0.0;
    } else {
      // Semi-implicit damped spring on log2 exposure, sub-stepped. The EV
      // range is a hard stop like a camera's gain limit: the spring hunts
      // inside it, and velocity pointing out of it is dropped, so its
      // overshoot never lifts the darkness the clamp protects.
      float le = log2(e);
      float lt = log2(target);
      float lo = log2(uBase) + uMinEv + uBias;
      float hi = log2(uBase) + uMaxEv + uBias;
      int n = int(ceil(uDt * 60.0));
      float h = uDt / float(max(n, 1));
      for (int i = 0; i < 16; i++) {
        if (i >= n) break;
        v += (uOmega * uOmega * (lt - le) - 2.0 * uDamping * uOmega * v) * h;
        le += v * h;
        if (le > hi) { le = hi; v = min(v, 0.0); }
        if (le < lo) { le = lo; v = max(v, 0.0); }
      }
      e = exp2(le);
    }
    outColor = vec4(e, v, target, avgLog);
  }
`

function fsMaterial(fragmentShader, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: FS_VERT,
    fragmentShader: SAMPLER_PRECISION + fragmentShader,
    depthTest: false,
    depthWrite: false,
  })
}

const RT = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }
const RT1 = { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }

export class AutoExposure {
  constructor({ tLit, tColor, tDepth }) {
    this.meterRT = new THREE.WebGLRenderTarget(2 * METER_SIZE, METER_SIZE, RT)
    this.reduceRTs = [16, 4, 1].map((n) => new THREE.WebGLRenderTarget(2 * n, n, RT))
    this.adaptRTs = [new THREE.WebGLRenderTarget(2, 1, RT1), new THREE.WebGLRenderTarget(2, 1, RT1)]
    this._ping = 0
    this.meterUniforms = {
      tLit: { value: tLit },
      tColor: { value: tColor },
      tDepth: { value: tDepth },
      uStep: { value: new THREE.Vector2(0.25 / METER_SIZE, 0.25 / METER_SIZE) },
      uMeterEmissive: { value: 0 },
      uEmissiveCap: { value: 4 },
      uKey: { value: 0.18 },
    }
    this.meterQuad = new FullScreenQuad(fsMaterial(METER_FRAG, this.meterUniforms))
    this.reduceUniforms = { tIn: { value: null }, uTexel: { value: new THREE.Vector2() } }
    this.reduceQuad = new FullScreenQuad(fsMaterial(REDUCE_FRAG, this.reduceUniforms))
    this.adaptUniforms = {
      tMeter: { value: this.reduceRTs[2].texture },
      tPrev: { value: this.adaptRTs[1].texture },
      uDt: { value: 0 },
      uKey: { value: 0.18 },
      uBase: { value: 1 },
      uMinEv: { value: -1 },
      uMaxEv: { value: 1 },
      uBias: { value: 0 },
      uSpeedUp: { value: 2 },
      uSpeedDown: { value: 1 },
      uOmega: { value: 0 },
      uDamping: { value: 1 },
      uAwbStrength: { value: 0 },
      uAwbSpeed: { value: 0 },
      uReset: { value: 1 },
    }
    this.adaptQuad = new FullScreenQuad(fsMaterial(ADAPT_FRAG, this.adaptUniforms))
  }

  // 2x1 texture: texel 0 = (exposure, velocity, target, avg log2 lum),
  // texel 1 = (white-balance gains, 1).
  get texture() {
    return this.adaptRTs[this._ping].texture
  }

  // The next update snaps straight to the metered target (level entry,
  // family switch, context restore) instead of easing from a stale value.
  reset() {
    this.adaptUniforms.uReset.value = 1
  }

  configure(exposure, base) {
    const u = this.adaptUniforms
    u.uKey.value = exposure.key
    u.uBase.value = base
    u.uMinEv.value = exposure.minEv
    u.uMaxEv.value = exposure.maxEv
    u.uBias.value = exposure.bias ?? 0
    u.uSpeedUp.value = exposure.speedUp
    u.uSpeedDown.value = exposure.speedDown
    u.uOmega.value = exposure.omega ?? 0
    u.uDamping.value = exposure.damping ?? 1
    u.uAwbStrength.value = exposure.awbStrength ?? 0
    u.uAwbSpeed.value = Math.min(exposure.awbSpeed ?? 0, 0.8)
    const mu = this.meterUniforms
    mu.uMeterEmissive.value = exposure.meterEmissive ?? 0
    // tLit is unexposed, so the chroma weight compares it with the luminance
    // the key maps to at the family exposure (not the exposed key itself,
    // which made the weighting depend on the family).
    const sceneKey = exposure.key / Math.max(base, 1e-4)
    mu.uKey.value = sceneKey
    // Emissive log2 luminance is capped six stops above that luminance.
    mu.uEmissiveCap.value = Math.log2(sceneKey) + 6
  }

  update(renderer, dt) {
    renderer.setRenderTarget(this.meterRT)
    this.meterQuad.render(renderer)
    let src = this.meterRT
    for (const rt of this.reduceRTs) {
      this.reduceUniforms.tIn.value = src.texture
      this.reduceUniforms.uTexel.value.set(1 / src.width, 1 / src.height)
      renderer.setRenderTarget(rt)
      this.reduceQuad.render(renderer)
      src = rt
    }
    const next = 1 - this._ping
    this.adaptUniforms.tPrev.value = this.adaptRTs[this._ping].texture
    this.adaptUniforms.uDt.value = Math.min(Math.max(dt, 0), 0.25)
    renderer.setRenderTarget(this.adaptRTs[next])
    this.adaptQuad.render(renderer)
    this.adaptUniforms.uReset.value = 0
    this._ping = next
  }

  get materials() {
    return [this.meterQuad.material, this.reduceQuad.material, this.adaptQuad.material]
  }

  dispose() {
    this.meterRT.dispose()
    for (const rt of this.reduceRTs) rt.dispose()
    for (const rt of this.adaptRTs) rt.dispose()
    for (const m of this.materials) m.dispose()
    this.meterQuad.dispose()
  }
}
