import * as THREE from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { DEPTH_PX, FS_VERT, SAMPLER_PRECISION } from '../shaders/common.js'
import { SKY_NADIR_MULT, SKY_ZENITH_MULT } from '../../world/constants.js'

// WebGL half of the experimental realtime path tracer
// (docs/pathracer/10-realtime-integration.md). DeferredRenderer calls
// render() right after its lighting pass; everything downstream (exposure
// meter, shafts, bloom, composite, outline, grade, FXAA/tape) then runs on the
// path-traced lighting, so the game keeps its own look.
//
// The traced frames come from a SEPARATE WebGPU context (PathTraceRealtime)
// by GPU->CPU readback, one or two frames late. Each traced frame is tied to
// a snapshot of the G-buffer taken the frame it was dispatched (albedo +
// view distance at trace resolution) and to that frame's camera, so it can be
// reprojected onto any later frame exactly. Passes:
//
//   snapshot    (trace res) the G-buffer for a frame being dispatched:
//               albedo averaged over each trace pixel's footprint (the
//               tracer jitters its rays over the whole pixel, so its
//               radiance is a footprint average too) and the view distance
//               at the pixel centre.
//   demodulate  (trace res, once per new traced frame) radiance / snapshot
//               albedo: lighting without texture, which filters cleanly.
//   a-trous     (trace res) edge-aware wavelet filter, 5x5 B3 kernel at
//               growing strides, stopped at view-distance edges. Iterations
//               fall as the traced frame's sample count grows.
//   accumulate  (full res) world position from depth -> the traced frame's
//               camera -> depth-checked bilinear lookup of the filtered
//               lighting; blended with the reprojected history (rejected on
//               a distance mismatch). Output rgb + view distance (a < 0: none).
//   apply       (full res) remodulated by the full-res G-buffer albedo
//               (texture detail stays sharp), fogged like the lighting pass,
//               alpha-blended over litRT. Pixels without a value keep the
//               raster lighting: the sky, emissives (matID 1) and entities
//               (matID 2: the enemies are not in the traced scene).

export const SNAPSHOT_SLOTS = 3
// Relative view-distance mismatch beyond which a traced texel or a history
// sample belongs to another surface.
const REL_DEPTH = 0.04
// Floor for albedo demodulation (dark albedo would amplify noise).
const ALBEDO_FLOOR = 0.03
// History weight of a new traced frame: independent (the tracer reset since
// the last one) vs a continuation of the same accumulation (camera still:
// the new frame contains the old one's samples, so it dominates).
export const ALPHA_FRESH = 0.2
export const ALPHA_CONTINUED = 0.6
// A-trous iterations for a traced frame with few samples per pixel; one
// fewer at each of FILTER_SAMPLE_STEPS (noise falls as 1 / sqrt(spp)), so a
// still view sheds the filter as it accumulates and a converged one keeps
// every contact shadow sharp.
export const FILTER_ITERATIONS = 3
export const FILTER_SAMPLE_STEPS = [32, 128, 512]

const glslFloat = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`)

// A-trous iterations for a traced frame of `samples` samples per pixel.
export function filterIterations(samples) {
  let n = FILTER_ITERATIONS
  for (const step of FILTER_SAMPLE_STEPS) if (samples >= step) n--
  return Math.max(0, n)
}

const SNAPSHOT_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  out vec4 outColor;
  uniform sampler2D tDepth;
  uniform sampler2D tColor;
  uniform mat4 uProjInverse;
  uniform vec2 uTraceSize;
  ${DEPTH_PX}
  void main(){
    ivec2 fs = textureSize(tDepth, 0);
    vec2 t = floor(gl_FragCoord.xy);
    vec2 scale = vec2(fs) / uTraceSize;
    ivec2 px = clamp(ivec2((t + 0.5) * scale), ivec2(0), fs - 1);
    float d = texelFetch(tDepth, px, 0).x;
    vec4 c = texelFetch(tColor, px, 0);
    // Sky, emissives and entities never take traced light.
    if (d >= 1.0 || c.a > 0.5) { outColor = vec4(0.0, 0.0, 0.0, -1.0); return; }
    // The tracer's radiance averages its jittered rays over the whole trace
    // pixel, so demodulate by the albedo averaged over the same footprint
    // (a stratified 4 x 4 grid of G-buffer pixels). The centre texel alone
    // turns texture detail into speckle that never converges.
    vec3 sum = vec3(0.0);
    float n = 0.0;
    for (int j = 0; j < 4; j++) {
      for (int i = 0; i < 4; i++) {
        vec2 f = (vec2(float(i), float(j)) + 0.5) * 0.25;
        ivec2 q = clamp(ivec2((t + f) * scale), ivec2(0), fs - 1);
        if (texelFetch(tDepth, q, 0).x >= 1.0) continue;
        vec4 s = texelFetch(tColor, q, 0);
        if (s.a > 0.5) continue;
        sum += s.rgb;
        n += 1.0;
      }
    }
    outColor = vec4(n > 0.0 ? sum / n : c.rgb, length(viewPosPx(px, fs)));
  }
`

const DEMODULATE_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  out vec4 outColor;
  uniform sampler2D tTrace;
  uniform sampler2D tSnap;
  void main(){
    ivec2 t = ivec2(gl_FragCoord.xy);
    ivec2 ts = textureSize(tSnap, 0);
    vec4 s = texelFetch(tSnap, t, 0);
    if (s.a <= 0.0) { outColor = vec4(0.0, 0.0, 0.0, -1.0); return; }
    // Traced rows are stored top-down.
    vec3 rad = texelFetch(tTrace, ivec2(t.x, ts.y - 1 - t.y), 0).rgb;
    outColor = vec4(rad / max(s.rgb, vec3(${glslFloat(ALBEDO_FLOOR)})), s.a);
  }
`

const ATROUS_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  out vec4 outColor;
  uniform sampler2D tIn;
  uniform int uStep;
  void main(){
    ivec2 t = ivec2(gl_FragCoord.xy);
    ivec2 ts = textureSize(tIn, 0);
    vec4 c = texelFetch(tIn, t, 0);
    if (c.a <= 0.0) { outColor = c; return; }
    const float K[3] = float[3](0.375, 0.25, 0.0625);
    // Distance tolerance grows with the stride: a grazing floor changes
    // distance steadily across texels without being an edge.
    float tol = 0.02 * float(uStep);
    vec3 sum = vec3(0.0);
    float ws = 0.0;
    for (int j = -2; j <= 2; j++) {
      for (int i = -2; i <= 2; i++) {
        ivec2 q = t + ivec2(i, j) * uStep;
        if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, ts))) continue;
        vec4 s = texelFetch(tIn, q, 0);
        if (s.a <= 0.0) continue;
        float rel = abs(s.a - c.a) / c.a;
        float w = K[abs(i)] * K[abs(j)] * (1.0 - smoothstep(0.5 * tol, tol, rel));
        sum += s.rgb * w;
        ws += w;
      }
    }
    outColor = vec4(ws > 1e-5 ? sum / ws : c.rgb, c.a);
  }
`

const ACCUMULATE_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tDepth;
  uniform sampler2D tColor;
  uniform sampler2D tLight;
  uniform sampler2D tHist;
  uniform mat4 uProjInverse;
  uniform mat4 uCamToWorld;
  uniform vec3 uCamPosW;
  uniform mat4 uTraceViewProj;
  uniform vec3 uTraceCamPos;
  uniform float uHasTrace;
  uniform float uNewTrace;
  uniform mat4 uPrevViewProj;
  uniform vec3 uPrevCamPos;
  uniform float uHasHist;
  uniform float uAlpha;
  ${DEPTH_PX}

  bool project(mat4 viewProj, vec3 Pw, out vec2 uv){
    vec4 c = viewProj * vec4(Pw, 1.0);
    if (c.w <= 1e-4) return false;
    uv = c.xy / c.w * 0.5 + 0.5;
    return all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
  }

  // The filtered traced lighting at Pw: bilinear over the 2x2 trace texels
  // around its projection, each rejected when its distance says it saw
  // another surface (joint bilateral upsampling).
  bool traced(vec3 Pw, out vec3 irr){
    vec2 uv;
    if (uHasTrace < 0.5 || !project(uTraceViewProj, Pw, uv)) return false;
    ivec2 ts = textureSize(tLight, 0);
    float expect = length(Pw - uTraceCamPos);
    vec2 st = uv * vec2(ts) - 0.5;
    ivec2 b = ivec2(floor(st));
    vec2 f = st - vec2(b);
    vec3 sum = vec3(0.0);
    float ws = 0.0;
    for (int j = 0; j <= 1; j++) {
      for (int i = 0; i <= 1; i++) {
        ivec2 t = clamp(b + ivec2(i, j), ivec2(0), ts - 1);
        vec4 s = texelFetch(tLight, t, 0);
        if (s.a <= 0.0) continue;
        float rel = abs(s.a - expect) / expect;
        float wb = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
        float w = (wb + 1e-3) * (1.0 - smoothstep(0.5 * ${glslFloat(REL_DEPTH)}, ${glslFloat(REL_DEPTH)}, rel));
        sum += s.rgb * w;
        ws += w;
      }
    }
    if (ws < 1e-4) return false;
    irr = sum / ws;
    return true;
  }

  bool history(vec3 Pw, out vec3 irr){
    vec2 uv;
    if (uHasHist < 0.5 || !project(uPrevViewProj, Pw, uv)) return false;
    vec4 h = texture(tHist, uv);
    if (h.a <= 0.0) return false;
    float expect = length(Pw - uPrevCamPos);
    if (abs(h.a - expect) > ${glslFloat(REL_DEPTH)} * expect) return false;
    irr = h.rgb;
    return true;
  }

  void main(){
    ivec2 fs = textureSize(tDepth, 0);
    ivec2 px = ivec2(gl_FragCoord.xy);
    float d = texelFetch(tDepth, px, 0).x;
    vec4 c = texelFetch(tColor, px, 0);
    if (d >= 1.0 || c.a > 0.5) { outColor = vec4(0.0, 0.0, 0.0, -1.0); return; }
    vec3 Pw = (uCamToWorld * vec4(viewPosPx(px, fs), 1.0)).xyz;
    vec3 irrT = vec3(0.0);
    vec3 irrH = vec3(0.0);
    bool t = traced(Pw, irrT);
    bool h = history(Pw, irrH);
    vec3 irr;
    if (t && h) irr = mix(irrH, irrT, uNewTrace > 0.5 ? uAlpha : 0.0);
    else if (h) irr = irrH;
    else if (t) irr = irrT;
    else { outColor = vec4(0.0, 0.0, 0.0, -1.0); return; }
    outColor = vec4(irr, length(Pw - uCamPosW));
  }
`

const APPLY_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tDepth;
  uniform sampler2D tColor;
  uniform sampler2D tHist;
  uniform mat4 uProjInverse;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform vec3 uUpView;
  uniform float uMix;
  ${DEPTH_PX}
  // Same sky as the lighting pass (shaders/lighting.js skyColor).
  vec3 skyColor(vec3 dirView){
    float up = dot(dirView, uUpView);
    float b = mix(1.0, ${glslFloat(SKY_ZENITH_MULT)}, smoothstep(0.02, 0.5, up))
            * mix(1.0, ${glslFloat(SKY_NADIR_MULT)}, smoothstep(0.02, 0.55, -up));
    return uFogColor * b;
  }
  void main(){
    ivec2 fs = textureSize(tDepth, 0);
    ivec2 px = ivec2(gl_FragCoord.xy);
    vec4 h = texelFetch(tHist, px, 0);
    if (h.a < 0.0) discard;
    vec3 albedo = texelFetch(tColor, px, 0).rgb;
    vec3 P = viewPosPx(px, fs);
    float dist = length(P);
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    vec3 rad = h.rgb * albedo;
    outColor = vec4(mix(rad, skyColor(P / max(dist, 1e-4)), fog), uMix);
  }
`

function fsMaterial(fragmentShader, uniforms, extra = {}) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: FS_VERT,
    fragmentShader: SAMPLER_PRECISION + fragmentShader,
    depthTest: false,
    depthWrite: false,
    ...extra,
  })
}

const HIST_OPTS = {
  type: THREE.HalfFloatType,
  depthBuffer: false,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
}
const TRACE_RT_OPTS = {
  type: THREE.HalfFloatType,
  depthBuffer: false,
  minFilter: THREE.NearestFilter,
  magFilter: THREE.NearestFilter,
}

// Trace resolution for a deferred frame of w x h: `scale` of each axis,
// capped at `maxPixels`, width a multiple of 16 so an RGBA32F row is a whole
// number of 256-byte readback rows (no padding to strip).
export function traceSize(w, h, { scale = 0.5, maxPixels = 140_000 } = {}) {
  let s = scale
  if (w * h * s * s > maxPixels) s = Math.sqrt(maxPixels / (w * h))
  const width = Math.max(16, Math.round((w * s) / 16) * 16)
  const height = Math.max(8, Math.round((h * width) / w))
  return { width, height }
}

export class PathTraceBlend {
  constructor() {
    this.enabled = true
    this.mix = 1
    this.traceWidth = 0
    this.traceHeight = 0
    this.snapRTs = []
    this.slots = []
    this.filterRTs = null
    this.histRTs = null
    this._hist = 0
    this._reserved = -1
    this._captured = null
    this._current = -1
    this._pendingFilter = false
    this._iterations = FILTER_ITERATIONS
    this._viewProj = new THREE.Matrix4()
    this._camPos = new THREE.Vector3()
    this.traceTex = null
    this.stats = { accepted: 0, rejected: 0, filterIterations: 0 }

    this.snapUniforms = {
      tDepth: { value: null },
      tColor: { value: null },
      uProjInverse: { value: new THREE.Matrix4() },
      uTraceSize: { value: new THREE.Vector2(1, 1) },
    }
    this.demodUniforms = { tTrace: { value: null }, tSnap: { value: null } }
    this.atrousUniforms = { tIn: { value: null }, uStep: { value: 1 } }
    this.accumUniforms = {
      tDepth: { value: null },
      tColor: { value: null },
      tLight: { value: null },
      tHist: { value: null },
      uProjInverse: { value: new THREE.Matrix4() },
      uCamToWorld: { value: new THREE.Matrix4() },
      uCamPosW: { value: new THREE.Vector3() },
      uTraceViewProj: { value: new THREE.Matrix4() },
      uTraceCamPos: { value: new THREE.Vector3() },
      uHasTrace: { value: 0 },
      uNewTrace: { value: 0 },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uPrevCamPos: { value: new THREE.Vector3() },
      uHasHist: { value: 0 },
      uAlpha: { value: ALPHA_FRESH },
    }
    this.applyUniforms = {
      tDepth: { value: null },
      tColor: { value: null },
      tHist: { value: null },
      uProjInverse: { value: new THREE.Matrix4() },
      uFogColor: { value: new THREE.Color() },
      uFogDensity: { value: 0 },
      uUpView: { value: new THREE.Vector3(0, 1, 0) },
      uMix: { value: 1 },
    }
    this.snapQuad = new FullScreenQuad(fsMaterial(SNAPSHOT_FRAG, this.snapUniforms))
    this.demodQuad = new FullScreenQuad(fsMaterial(DEMODULATE_FRAG, this.demodUniforms))
    this.atrousQuad = new FullScreenQuad(fsMaterial(ATROUS_FRAG, this.atrousUniforms))
    this.accumQuad = new FullScreenQuad(fsMaterial(ACCUMULATE_FRAG, this.accumUniforms))
    // Straight alpha blend of rgb over the raster lighting; litRT's alpha is
    // left untouched.
    this.applyQuad = new FullScreenQuad(
      fsMaterial(APPLY_FRAG, this.applyUniforms, {
        transparent: true,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
      })
    )
  }

  // (Re)allocate the per-dispatch snapshots, filter targets and the
  // traced-frame texture. In-flight frames of the old size are refused.
  setTraceSize(width, height) {
    if (width === this.traceWidth && height === this.traceHeight) return false
    this.traceWidth = width
    this.traceHeight = height
    for (const rt of this.snapRTs) rt.dispose()
    this.filterRTs?.forEach((rt) => rt.dispose())
    this.snapRTs = []
    this.slots = []
    for (let i = 0; i < SNAPSHOT_SLOTS; i++) {
      this.snapRTs.push(new THREE.WebGLRenderTarget(width, height, TRACE_RT_OPTS))
      this.slots.push({ state: 'free', viewProj: new THREE.Matrix4(), camPos: new THREE.Vector3() })
    }
    this.filterRTs = [
      new THREE.WebGLRenderTarget(width, height, TRACE_RT_OPTS),
      new THREE.WebGLRenderTarget(width, height, TRACE_RT_OPTS),
    ]
    this.traceTex?.dispose()
    this.traceTex = new THREE.DataTexture(new Float32Array(width * height * 4), width, height, THREE.RGBAFormat, THREE.FloatType)
    this.traceTex.minFilter = THREE.NearestFilter
    this.traceTex.magFilter = THREE.NearestFilter
    this.traceTex.generateMipmaps = false
    this.traceTex.needsUpdate = true
    this._reserved = -1
    this._captured = null
    this._current = -1
    this._pendingFilter = false
    this.accumUniforms.uHasTrace.value = 0
    return true
  }

  // Ask for the next rendered frame's G-buffer to be snapshotted for a
  // dispatch. Returns the slot, or -1 when every slot is in flight.
  reserve() {
    if (this._reserved >= 0) return this._reserved
    const i = this.slots.findIndex((s) => s.state === 'free')
    if (i < 0) return -1
    this.slots[i].state = 'reserved'
    this._reserved = i
    return i
  }

  // The snapshot taken during the last render(), if any: { slot, viewProj,
  // camPos }. The caller dispatches the tracer for exactly that camera, or
  // cancels the slot.
  takeCaptured() {
    const c = this._captured
    this._captured = null
    return c
  }

  get inFlight() {
    return this.slots.filter((s) => s.state === 'pending').length
  }

  // A readback finished: `data` is the traced frame (RGBA32F, rows top-down)
  // for the snapshot in `slot`. `continued`: the tracer had not reset since
  // the previously accepted frame; `samples`: its samples per pixel.
  accept(slot, data, width, height, { continued = false, samples = 1 } = {}) {
    const s = this.slots[slot]
    const valid = s && s.state === 'pending' && width === this.traceWidth && height === this.traceHeight
    if (!valid || data.length < width * height * 4) {
      this.stats.rejected++
      if (s && s.state === 'pending') s.state = 'free'
      return false
    }
    if (this._current >= 0 && this._current !== slot) this.slots[this._current].state = 'free'
    s.state = 'current'
    this._current = slot
    this.traceTex.image.data = data.length === width * height * 4 ? data : data.subarray(0, width * height * 4)
    this.traceTex.needsUpdate = true
    this._iterations = filterIterations(samples)
    this._pendingFilter = true
    const u = this.accumUniforms
    u.uTraceViewProj.value.copy(s.viewProj)
    u.uTraceCamPos.value.copy(s.camPos)
    u.uAlpha.value = continued ? ALPHA_CONTINUED : ALPHA_FRESH
    this.stats.accepted++
    return true
  }

  cancel(slot) {
    const s = this.slots[slot]
    if (s && s.state !== 'current') s.state = 'free'
  }

  // Forget everything traced (new level, mode toggled).
  resetHistory() {
    this.accumUniforms.uHasHist.value = 0
    this.accumUniforms.uHasTrace.value = 0
    if (this._current >= 0) this.slots[this._current].state = 'free'
    this._current = -1
    this._pendingFilter = false
  }

  _ensureHistory(w, h) {
    if (this.histRTs && this.histRTs[0].width === w && this.histRTs[0].height === h) return
    this.histRTs?.forEach((rt) => rt.dispose())
    this.histRTs = [new THREE.WebGLRenderTarget(w, h, HIST_OPTS), new THREE.WebGLRenderTarget(w, h, HIST_OPTS)]
    this.accumUniforms.uHasHist.value = 0
  }

  // New traced frame -> demodulated, a-trous filtered lighting (trace res).
  _filter(r) {
    const [a, b] = this.filterRTs
    this.demodUniforms.tTrace.value = this.traceTex
    this.demodUniforms.tSnap.value = this.snapRTs[this._current].texture
    r.setRenderTarget(a)
    this.demodQuad.render(r)
    let src = a
    let dst = b
    for (let i = 0; i < this._iterations; i++) {
      this.atrousUniforms.tIn.value = src.texture
      this.atrousUniforms.uStep.value = 1 << i
      r.setRenderTarget(dst)
      this.atrousQuad.render(r)
      ;[src, dst] = [dst, src]
    }
    this.accumUniforms.tLight.value = src.texture
    this.accumUniforms.uHasTrace.value = 1
    this.accumUniforms.uNewTrace.value = 1
    this.stats.filterIterations = this._iterations
    this._pendingFilter = false
  }

  // DeferredRenderer hook: runs right after the lighting pass, with litRT
  // holding the raster lighting.
  render(deferred) {
    const r = deferred.renderer
    const w = deferred.gBuffer.width
    const h = deferred.gBuffer.height
    const cam = deferred.camera
    this._viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    this._camPos.setFromMatrixPosition(cam.matrixWorld)

    if (this.enabled && this.traceTex) {
      if (this._pendingFilter && this._current >= 0) this._filter(r)
      this._ensureHistory(w, h)
      const a = this.accumUniforms
      const out = this.histRTs[1 - this._hist]
      a.tDepth.value = deferred.depthTex
      a.tColor.value = deferred.gColor
      a.tHist.value = this.histRTs[this._hist].texture
      a.uProjInverse.value.copy(deferred._projInv)
      a.uCamToWorld.value.copy(cam.matrixWorld)
      a.uCamPosW.value.copy(this._camPos)
      r.setRenderTarget(out)
      this.accumQuad.render(r)
      a.uNewTrace.value = 0
      a.uHasHist.value = 1
      this._hist = 1 - this._hist

      const p = this.applyUniforms
      p.tDepth.value = deferred.depthTex
      p.tColor.value = deferred.gColor
      p.tHist.value = out.texture
      p.uProjInverse.value.copy(deferred._projInv)
      p.uFogColor.value.copy(deferred.lightUniforms.uFogColor.value)
      p.uFogDensity.value = deferred.lightUniforms.uFogDensity.value
      p.uUpView.value.copy(deferred.cameraUniforms.uUpView.value)
      p.uMix.value = this.mix
      r.setRenderTarget(deferred.litRT)
      this.applyQuad.render(r)
    } else {
      this.accumUniforms.uHasHist.value = 0
    }
    this.accumUniforms.uPrevViewProj.value.copy(this._viewProj)
    this.accumUniforms.uPrevCamPos.value.copy(this._camPos)

    // Only snapshot for a frame that will be dispatched: an unconsumed
    // capture from an earlier frame is released first.
    if (this._captured) {
      this.cancel(this._captured.slot)
      this._captured = null
    }
    if (this._reserved >= 0) {
      const slot = this._reserved
      this._reserved = -1
      const s = this.slots[slot]
      const su = this.snapUniforms
      su.tDepth.value = deferred.depthTex
      su.tColor.value = deferred.gColor
      su.uProjInverse.value.copy(deferred._projInv)
      su.uTraceSize.value.set(this.traceWidth, this.traceHeight)
      r.setRenderTarget(this.snapRTs[slot])
      this.snapQuad.render(r)
      s.viewProj.copy(this._viewProj)
      s.camPos.copy(this._camPos)
      s.state = 'pending'
      this._captured = { slot, viewProj: s.viewProj, camPos: s.camPos }
    }
  }

  dispose() {
    for (const rt of this.snapRTs) rt.dispose()
    this.filterRTs?.forEach((rt) => rt.dispose())
    this.histRTs?.forEach((rt) => rt.dispose())
    this.traceTex?.dispose()
    for (const q of [this.snapQuad, this.demodQuad, this.atrousQuad, this.accumQuad, this.applyQuad]) {
      q.material.dispose()
      q.dispose()
    }
  }
}
