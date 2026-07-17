import * as THREE from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { QUALITY } from '../core/device.js'
import { makeToonGradient } from './gradientRamp.js'
import { makeLampUniforms } from './LightField.js'
import { FS_VERT } from './shaders/common.js'
import { LIGHTING_FRAG } from './shaders/lighting.js'
import { SHADOW_FRAG, SHADOW_BLUR_FRAG } from './shaders/shadow.js'
import { AO_FRAG, AO_BLUR_FRAG } from './shaders/ssao.js'
import { VOL_FRAG } from './shaders/volumetric.js'
import { BLOOM_PREFILTER_FRAG, BLOOM_BLUR_FRAG } from './shaders/bloom.js'
import { COMPOSITE_FRAG } from './shaders/composite.js'
import { OUTLINE_FRAG } from './shaders/outline.js'
import { GRADE_FRAG } from './shaders/grade.js'
import { FXAA_FRAG } from './shaders/fxaa.js'
import { DEBUG_VIEW_FRAG } from './shaders/debugView.js'
import {
  FAR,
  FOG_COLOR,
  FOG_DENSITY,
  PANEL_COLOR,
  LIGHT_RANGE,
  LIGHT_INTENSITY,
  AMBIENT_SKY,
  AMBIENT_GROUND,
  LAMP_WRAP,
  RIM_STRENGTH,
  RIM_COLOR,
  ENTITY_RIM,
  FLASH_COLOR,
  FLASH_RANGE,
  FLASH_INTENSITY,
  FLASH_COS_INNER,
  FLASH_COS_OUTER,
  SHADOW_THICKNESS,
  SHADOW_STRENGTH,
  SHADOW_SCALE,
  AO_SCALE,
  AO_RADIUS,
  AO_BIAS,
  AO_INTENSITY,
  VOL_SCALE,
  VOL_MAXDIST,
  VOL_DENSITY,
  VOL_PHASE_G,
  VOL_INTENSITY,
  BLOOM_SCALE,
  BLOOM_SPREAD,
  BLOOM_INTENSITY,
  GRADE_LEVELS,
  GRADE_TINT,
  GRADE_SAT,
  CEL_BANDS,
  CEL_FLOOR,
  OUTLINE_INK,
  OUTLINE_THICKNESS,
  OUTLINE_DEPTH_THRESH,
  OUTLINE_NORMAL_THRESH,
  OUTLINE_FADE_NEAR,
  OUTLINE_FADE_FAR,
} from '../world/constants.js'

// Deferred toon renderer. Stage A: render the scene into a G-buffer (MRT:
// albedo+matID, viewNormal) + depth, then a fullscreen lighting pass produces a
// linear HDR buffer, and an output pass converts to sRGB on screen. Later stages
// add the many-lamp lighting, shadows, AO, volumetrics, bloom, outline & grade.
//
// The per-pass GLSL lives in ./shaders/*; this module owns the render targets,
// uniforms and per-frame orchestration only.

// Shared render-target option preset for the half-res HDR effect buffers
// (SSAO / volumetrics / bloom) — bilinear so they upsample smoothly.
const HALF_RT_OPTS = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }

// Linear THREE.Color from an sRGB hex. With THREE.ColorManagement.enabled (set in
// Engine), the Color constructor already decodes sRGB -> linear working space, so
// this must NOT call convertSRGBToLinear() again (that double-decode darkened and
// over-saturated every solid color).
const linVec = (hex) => new THREE.Color(hex)

function aoKernel(n) {
  const k = []
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random())
    v.normalize()
    let s = i / n
    s = 0.1 + 0.9 * s * s // cluster samples near the origin
    v.multiplyScalar(s)
    k.push(v)
  }
  return k
}

function fsMaterial(fragmentShader, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: FS_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
  })
}

export class DeferredRenderer {
  constructor(renderer, scene, camera) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    renderer.setClearColor(0x000000, 1)

    // Shared per-frame state: the projection inverse (computed once, copied into
    // every pass instead of re-inverted) and lamp positions in view space.
    this._projInv = new THREE.Matrix4()
    this._clearScratch = new THREE.Color()

    const { dw, dh } = this._dims()
    // Cel ramp + lamp field are shared by the shadow and lighting passes, so
    // build them before either. CEL_BANDS bands + a tiny warm floor so grazing
    // walls keep a dim step instead of snapping to black; ambient fills the rest.
    this.ramp = makeToonGradient(CEL_BANDS, CEL_FLOOR)
    this.lamps = makeLampUniforms() // { uLampPos[LIGHT_MAX], uLampCount }, driven by LightField
    this._initGBuffer(dw, dh)
    this._initSSAO(dw, dh)
    this._initShadow(dw, dh)
    this._initLighting()
    this._initVolumetrics(dw, dh)
    this._initBloom(dw, dh)
    this._initComposite(dw, dh)
    this._initOutline(dw, dh)
    this._initGrade(dw, dh)
    this._initFXAA(dw, dh)
    this._initDebug()

    this.outlineEnabled = true
  }

  // Half-res (or any scale) dimensions with a >=1 clamp, shared by the
  // constructor and setSize() so the two can't drift.
  _halfRes(dw, dh, scale) {
    return { w: Math.max(1, Math.floor(dw * scale)), h: Math.max(1, Math.floor(dh * scale)) }
  }

  // --- stage init ----------------------------------------------------------

  _initGBuffer(dw, dh) {
    // G-buffer: 2 color targets (albedo+matID, viewNormal) + depth texture.
    const depthTexture = new THREE.DepthTexture(dw, dh)
    depthTexture.type = THREE.UnsignedIntType
    this.gBuffer = new THREE.WebGLRenderTarget(dw, dh, {
      count: 2,
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture,
    })
    this.gColor = this.gBuffer.textures[0]
    this.gNormal = this.gBuffer.textures[1]
    this.depthTex = depthTexture
  }

  _initSSAO(dw, dh) {
    const { w: aw, h: ah } = this._halfRes(dw, dh, AO_SCALE)
    this.aoRT = new THREE.WebGLRenderTarget(aw, ah, HALF_RT_OPTS)
    this.aoBlurRT = new THREE.WebGLRenderTarget(aw, ah, HALF_RT_OPTS)
    this.aoUniforms = {
      tNormal: { value: this.gNormal },
      tDepth: { value: this.depthTex },
      uProj: { value: new THREE.Matrix4() },
      uProjInverse: { value: new THREE.Matrix4() },
      uResolution: { value: new THREE.Vector2(dw, dh) },
      // Kernel size must match the AO_SAMPLES #define in ssao.js (uniform array).
      uKernel: { value: aoKernel(QUALITY.aoSamples) },
      uRadius: { value: AO_RADIUS },
      uBias: { value: AO_BIAS },
      uIntensity: { value: AO_INTENSITY },
    }
    this.aoQuad = new FullScreenQuad(fsMaterial(AO_FRAG, this.aoUniforms))
    this.aoBlurUniforms = {
      tAO: { value: this.aoRT.texture },
      tDepth: { value: this.depthTex },
      uProjInverse: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2(1 / aw, 1 / ah) },
      uDepthSigma: { value: 0.5 },
    }
    this.aoBlurQuad = new FullScreenQuad(fsMaterial(AO_BLUR_FRAG, this.aoBlurUniforms))
  }

  _initShadow(dw, dh) {
    // Half-res screen-space lamp shadow mask + depth-aware bilateral blur.
    const { w: sw, h: sh } = this._halfRes(dw, dh, SHADOW_SCALE)
    this.shadowRT = new THREE.WebGLRenderTarget(sw, sh, HALF_RT_OPTS)
    this.shadowBlurRT = new THREE.WebGLRenderTarget(sw, sh, HALF_RT_OPTS)
    this.shadowUniforms = {
      tNormal: { value: this.gNormal },
      tDepth: { value: this.depthTex },
      tRamp: { value: this.ramp },
      uProj: { value: new THREE.Matrix4() },
      uProjInverse: { value: new THREE.Matrix4() },
      uShadowThickness: { value: SHADOW_THICKNESS },
      uLampViewPos: this.lamps.uLampViewPos,
      uLampCount: this.lamps.uLampCount,
      uLampChar: this.lamps.uLampChar,
      uLampRange: { value: LIGHT_RANGE },
      uLampWrap: { value: LAMP_WRAP },
    }
    this.shadowQuad = new FullScreenQuad(fsMaterial(SHADOW_FRAG, this.shadowUniforms))
    this.shadowBlurUniforms = {
      tShadow: { value: this.shadowRT.texture },
      tDepth: { value: this.depthTex },
      uProjInverse: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2(1 / sw, 1 / sh) },
      uDepthSigma: { value: 0.5 },
    }
    this.shadowBlurQuad = new FullScreenQuad(fsMaterial(SHADOW_BLUR_FRAG, this.shadowBlurUniforms))
  }

  _initLighting() {
    const { dw, dh } = this._dims()
    // Linear HDR lit buffer.
    this.litRT = new THREE.WebGLRenderTarget(dw, dh, { type: THREE.HalfFloatType })

    this.lightUniforms = {
      tColor: { value: this.gColor },
      tNormal: { value: this.gNormal },
      tDepth: { value: this.depthTex },
      tRamp: { value: this.ramp },
      tAO: { value: this.aoBlurRT.texture },
      tShadow: { value: this.shadowBlurRT.texture },
      uProjInverse: { value: new THREE.Matrix4() },
      uShadowStrength: { value: SHADOW_STRENGTH },
      uUpView: { value: new THREE.Vector3(0, 1, 0) },
      uLampViewPos: this.lamps.uLampViewPos,
      uLampCount: this.lamps.uLampCount,
      uLampChar: this.lamps.uLampChar,
      uLampColor: { value: linVec(PANEL_COLOR) },
      uLampIntensity: { value: LIGHT_INTENSITY },
      uLampFlicker: { value: 1 }, // Engine._updateFlicker dips this with the fluorescent hum
      uLampRange: { value: LIGHT_RANGE },
      uAmbSky: { value: linVec(AMBIENT_SKY) },
      uAmbGround: { value: linVec(AMBIENT_GROUND) },
      uLampWrap: { value: LAMP_WRAP },
      uRim: { value: RIM_STRENGTH },
      uRimColor: { value: linVec(RIM_COLOR) },
      uEntityRim: { value: linVec(ENTITY_RIM) },
      uFlashOn: { value: 0 },
      uFlashColor: { value: linVec(FLASH_COLOR) },
      uFlashRange: { value: FLASH_RANGE },
      uFlashIntensity: { value: FLASH_INTENSITY },
      uFlashCosInner: { value: FLASH_COS_INNER },
      uFlashCosOuter: { value: FLASH_COS_OUTER },
      uFogColor: { value: linVec(FOG_COLOR) },
      uFogDensity: { value: FOG_DENSITY },
    }
    this.lightQuad = new FullScreenQuad(fsMaterial(LIGHTING_FRAG, this.lightUniforms))
  }

  _initVolumetrics(dw, dh) {
    const { w: vw, h: vh } = this._halfRes(dw, dh, VOL_SCALE)
    this.volRT = new THREE.WebGLRenderTarget(vw, vh, HALF_RT_OPTS)
    this.volUniforms = {
      tDepth: { value: this.depthTex },
      uProj: { value: new THREE.Matrix4() },
      uProjInverse: { value: new THREE.Matrix4() },
      uLampViewPos: this.lamps.uLampViewPos,
      uLampCount: this.lamps.uLampCount,
      uLampChar: this.lamps.uLampChar,
      uLampColor: { value: linVec(PANEL_COLOR) },
      // Share the lit pass's lamp-intensity + flicker value-objects so shafts
      // track lamp brightness (incl. LightTool edits + the Engine flicker dip).
      uLampIntensity: this.lightUniforms.uLampIntensity,
      uLampFlicker: this.lightUniforms.uLampFlicker,
      uLampRange: { value: LIGHT_RANGE },
      uDensity: { value: VOL_DENSITY },
      uMaxDist: { value: VOL_MAXDIST },
      uPhaseG: { value: VOL_PHASE_G },
      // Shared with the lit pass so the shafts sink into the same haze (and
      // track live LightTool fog edits).
      uFogDensity: this.lightUniforms.uFogDensity,
      // Share the flashlight value-objects with the lighting pass so the cone
      // stays in sync (incl. LightTool edits + the per-frame on/off toggle).
      uFlashOn: this.lightUniforms.uFlashOn,
      uFlashColor: this.lightUniforms.uFlashColor,
      uFlashRange: this.lightUniforms.uFlashRange,
      uFlashIntensity: this.lightUniforms.uFlashIntensity,
      uFlashCosInner: this.lightUniforms.uFlashCosInner,
      uFlashCosOuter: this.lightUniforms.uFlashCosOuter,
    }
    this.volQuad = new FullScreenQuad(fsMaterial(VOL_FRAG, this.volUniforms))
  }

  _initBloom(dw, dh) {
    const { w: bw, h: bh } = this._halfRes(dw, dh, BLOOM_SCALE)
    this.bloomPreRT = new THREE.WebGLRenderTarget(bw, bh, HALF_RT_OPTS)
    this.bloomTmpRT = new THREE.WebGLRenderTarget(bw, bh, HALF_RT_OPTS)
    this.bloomRT = new THREE.WebGLRenderTarget(bw, bh, HALF_RT_OPTS)
    this.bloomPreUniforms = {
      tLit: { value: this.litRT.texture },
      tColor: { value: this.gColor },
      tDepth: { value: this.depthTex },
    }
    this.bloomPreQuad = new FullScreenQuad(fsMaterial(BLOOM_PREFILTER_FRAG, this.bloomPreUniforms))
    this.bloomBlurUniforms = {
      tInput: { value: null },
      uDir: { value: new THREE.Vector2() },
    }
    this.bloomBlurQuad = new FullScreenQuad(fsMaterial(BLOOM_BLUR_FRAG, this.bloomBlurUniforms))
    this._bloomTexel = new THREE.Vector2(1 / bw, 1 / bh)
  }

  _initComposite(dw, dh) {
    // Composite (lit + volumetrics + bloom) -> linear sceneRT.
    this.sceneRT = new THREE.WebGLRenderTarget(dw, dh, { type: THREE.HalfFloatType })
    this.compositeUniforms = {
      tInput: { value: this.litRT.texture },
      tVol: { value: this.volRT.texture },
      tBloom: { value: this.bloomRT.texture },
      uVolIntensity: { value: VOL_INTENSITY },
      uBloomIntensity: { value: BLOOM_INTENSITY },
    }
    this.compositeQuad = new FullScreenQuad(fsMaterial(COMPOSITE_FRAG, this.compositeUniforms))
  }

  _initOutline(dw, dh) {
    this.outlineRT = new THREE.WebGLRenderTarget(dw, dh, { type: THREE.HalfFloatType })
    this.outlineUniforms = {
      tDiffuse: { value: this.sceneRT.texture },
      tColor: { value: this.gColor },
      tNormal: { value: this.gNormal },
      tDepth: { value: this.depthTex },
      uProjInverse: { value: new THREE.Matrix4() },
      uDepthScale: { value: 1 / FAR },
      // Shared value-object with the lighting pass so the ink's fog fade tracks
      // live fog-density edits (LightTool) exactly like the surfaces do.
      uFogDensity: this.lightUniforms.uFogDensity,
      uTexel: { value: new THREE.Vector2(1 / dw, 1 / dh) },
      uThickness: { value: OUTLINE_THICKNESS },
      uDepthThresh: { value: OUTLINE_DEPTH_THRESH },
      uNormalThresh: { value: OUTLINE_NORMAL_THRESH },
      uFadeNear: { value: OUTLINE_FADE_NEAR },
      uFadeFar: { value: OUTLINE_FADE_FAR },
      uInk: { value: linVec(OUTLINE_INK) },
    }
    this.outlineQuad = new FullScreenQuad(fsMaterial(OUTLINE_FRAG, this.outlineUniforms))
  }

  _initGrade(dw, dh) {
    this.gradeRT = new THREE.WebGLRenderTarget(dw, dh) // LDR sRGB for FXAA input
    this.gradeUniforms = {
      tDiffuse: { value: this.outlineRT.texture },
      time: { value: 0 },
      levels: { value: GRADE_LEVELS },
      exposure: { value: 1 }, // pre-tonemap exposure
      sat: { value: GRADE_SAT }, // post-tonemap saturation (anime pop)
      tint: { value: new THREE.Vector3(GRADE_TINT[0], GRADE_TINT[1], GRADE_TINT[2]) },
      vignette: { value: 0.18 },
      grain: { value: 0.025 },
      aberration: { value: 0.0015 },
      dead: { value: 0 },
    }
    this.gradeQuad = new FullScreenQuad(fsMaterial(GRADE_FRAG, this.gradeUniforms))
    this.grade = this.gradeUniforms // Engine._applyFX drives these
  }

  _initFXAA(dw, dh) {
    this.fxaaUniforms = {
      tDiffuse: { value: this.gradeRT.texture },
      uTexel: { value: new THREE.Vector2(1 / dw, 1 / dh) },
    }
    this.fxaaQuad = new FullScreenQuad(fsMaterial(FXAA_FRAG, this.fxaaUniforms))
  }

  _initDebug() {
    // Debug channel viewer (dev only). Binds the RT textures once; they survive
    // setSize (the RT keeps the same texture object), so no resize plumbing.
    this.debugView = 0
    this.debugViewUniforms = {
      uMode: { value: 0 },
      tColor: { value: this.gColor },
      tNormal: { value: this.gNormal },
      tDepth: { value: this.depthTex },
      tAO: { value: this.aoBlurRT.texture },
      tLit: { value: this.litRT.texture },
      tVol: { value: this.volRT.texture },
      tBloom: { value: this.bloomRT.texture },
      tScene: { value: this.sceneRT.texture },
      uProjInverse: { value: new THREE.Matrix4() },
      uDepthScale: { value: 1 / FAR },
    }
    this.debugQuad = new FullScreenQuad(fsMaterial(DEBUG_VIEW_FRAG, this.debugViewUniforms))
  }

  // 0 disables; 1..9 blit a pipeline channel to screen (see DEBUG_VIEW_FRAG).
  setDebugView(mode) {
    this.debugView = mode | 0
  }

  _dims() {
    const pr = this.renderer.getPixelRatio()
    const size = this.renderer.getSize(new THREE.Vector2())
    return { dw: Math.floor(size.x * pr), dh: Math.floor(size.y * pr) }
  }

  setOutline(on) {
    this.outlineEnabled = on
  }

  // No args: dimensions come from the renderer (size * pixelRatio) via _dims(),
  // which Engine updates (setSize + setPixelRatio) before calling this.
  setSize() {
    const { dw, dh } = this._dims()
    this.gBuffer.setSize(dw, dh)
    this.litRT.setSize(dw, dh)
    const ao = this._halfRes(dw, dh, AO_SCALE)
    this.aoRT.setSize(ao.w, ao.h)
    this.aoBlurRT.setSize(ao.w, ao.h)
    this.aoUniforms.uResolution.value.set(dw, dh)
    this.aoBlurUniforms.uTexel.value.set(1 / ao.w, 1 / ao.h)
    const sh = this._halfRes(dw, dh, SHADOW_SCALE)
    this.shadowRT.setSize(sh.w, sh.h)
    this.shadowBlurRT.setSize(sh.w, sh.h)
    this.shadowBlurUniforms.uTexel.value.set(1 / sh.w, 1 / sh.h)
    const vol = this._halfRes(dw, dh, VOL_SCALE)
    this.volRT.setSize(vol.w, vol.h)
    const b = this._halfRes(dw, dh, BLOOM_SCALE)
    this.bloomPreRT.setSize(b.w, b.h)
    this.bloomTmpRT.setSize(b.w, b.h)
    this.bloomRT.setSize(b.w, b.h)
    this._bloomTexel.set(1 / b.w, 1 / b.h)
    this.sceneRT.setSize(dw, dh)
    this.outlineRT.setSize(dw, dh)
    this.gradeRT.setSize(dw, dh)
    this.outlineUniforms.uTexel.value.set(1 / dw, 1 / dh)
    this.fxaaUniforms.uTexel.value.set(1 / dw, 1 / dh)
  }

  // --- per-frame stages ----------------------------------------------------

  // Per-frame shared work done once, before the passes: invert the projection
  // (each pass then copies it) and transform the active lamps to view space on the
  // CPU (so the lighting / shadow / volumetric shaders skip a mat4*vec4 per lamp
  // per pixel). Must run every frame — the view matrix changes as the camera moves.
  _updateFrame() {
    const cam = this.camera
    this._projInv.copy(cam.projectionMatrix).invert()
    const view = cam.matrixWorldInverse
    const world = this.lamps.uLampPos.value
    const viewPos = this.lamps.uLampViewPos.value
    const n = this.lamps.uLampCount.value
    for (let i = 0; i < n; i++) viewPos[i].copy(world[i]).applyMatrix4(view)
  }

  _renderGBuffer() {
    const r = this.renderer
    const { scene, camera } = this
    const prevBg = scene.background
    scene.background = null
    r.setRenderTarget(this.gBuffer)
    r.render(scene, camera)
    scene.background = prevBg
  }

  _renderSSAO() {
    const r = this.renderer
    const cam = this.camera
    const au = this.aoUniforms
    au.uProj.value.copy(cam.projectionMatrix)
    au.uProjInverse.value.copy(this._projInv)
    r.setRenderTarget(this.aoRT)
    this.aoQuad.render(r)
    this.aoBlurUniforms.uProjInverse.value.copy(this._projInv)
    r.setRenderTarget(this.aoBlurRT)
    this.aoBlurQuad.render(r)
  }

  _renderLighting() {
    const r = this.renderer
    const cam = this.camera
    const lu = this.lightUniforms
    lu.uProjInverse.value.copy(this._projInv)
    lu.uUpView.value.set(0, 1, 0).transformDirection(cam.matrixWorldInverse)
    r.setRenderTarget(this.litRT)
    this.lightQuad.render(r)
  }

  // Half-res screen-space lamp shadow mask -> shadowRT, then bilateral blur -> shadowBlurRT.
  _renderShadow() {
    const r = this.renderer
    const cam = this.camera
    const su = this.shadowUniforms
    su.uProj.value.copy(cam.projectionMatrix)
    su.uProjInverse.value.copy(this._projInv)
    r.setRenderTarget(this.shadowRT)
    this.shadowQuad.render(r)
    this.shadowBlurUniforms.uProjInverse.value.copy(this._projInv)
    r.setRenderTarget(this.shadowBlurRT)
    this.shadowBlurQuad.render(r)
  }

  _renderVolumetrics() {
    const r = this.renderer
    const cam = this.camera
    const vu = this.volUniforms
    vu.uProj.value.copy(cam.projectionMatrix)
    vu.uProjInverse.value.copy(this._projInv)
    r.setRenderTarget(this.volRT)
    this.volQuad.render(r)
  }

  _renderBloom() {
    const r = this.renderer
    r.setRenderTarget(this.bloomPreRT)
    this.bloomPreQuad.render(r)
    const bb = this.bloomBlurUniforms
    bb.tInput.value = this.bloomPreRT.texture
    bb.uDir.value.set(this._bloomTexel.x * BLOOM_SPREAD, 0)
    r.setRenderTarget(this.bloomTmpRT)
    this.bloomBlurQuad.render(r)
    bb.tInput.value = this.bloomTmpRT.texture
    bb.uDir.value.set(0, this._bloomTexel.y * BLOOM_SPREAD)
    r.setRenderTarget(this.bloomRT)
    this.bloomBlurQuad.render(r)
  }

  _composite() {
    this.renderer.setRenderTarget(this.sceneRT)
    this.compositeQuad.render(this.renderer)
  }

  _renderDebug() {
    const r = this.renderer
    const du = this.debugViewUniforms
    du.uMode.value = this.debugView
    du.uProjInverse.value.copy(this._projInv) // matches the G-buffer camera
    du.uDepthScale.value = 1 / this.camera.far
    r.setRenderTarget(null)
    this.debugQuad.render(r)
  }

  // Ink outline (off the G-buffer), optional. Returns the texture to grade.
  _renderOutline() {
    if (!this.outlineEnabled) return this.sceneRT.texture
    const ou = this.outlineUniforms
    ou.tDiffuse.value = this.sceneRT.texture
    ou.uProjInverse.value.copy(this._projInv) // live camera, matches the G-buffer
    ou.uDepthScale.value = 1 / this.camera.far
    this.renderer.setRenderTarget(this.outlineRT)
    this.outlineQuad.render(this.renderer)
    return this.outlineRT.texture
  }

  _renderGrade(time, graded) {
    this.gradeUniforms.tDiffuse.value = graded
    this.gradeUniforms.time.value = time
    this.renderer.setRenderTarget(this.gradeRT)
    this.gradeQuad.render(this.renderer)
  }

  _renderFXAA() {
    this.renderer.setRenderTarget(null)
    this.fxaaQuad.render(this.renderer)
  }

  // Fill a target with a flat color without running its shader — used when a
  // pass is skipped because nothing could contribute (see render()).
  _clearRT(rt, hex) {
    const r = this.renderer
    const prevColor = r.getClearColor(this._clearScratch)
    const prevAlpha = r.getClearAlpha()
    r.setRenderTarget(rt)
    r.setClearColor(hex, 1)
    r.clear(true, false, false)
    r.setClearColor(prevColor, prevAlpha)
  }

  render(time) {
    // 1. G-buffer  2. SSAO  3. shadow mask  4. lighting  5. volumetrics  6. bloom  7. composite
    this._updateFrame() // proj-inverse (once) + CPU lamp world->view
    this._renderGBuffer()
    this._renderSSAO()
    // Skip raymarch passes whose result is provably constant: with no lamps
    // loaded the shadow mask is 1 everywhere and (flashlight off) the shafts
    // are black — dark zones get both passes for the price of a clear.
    const lampsLoaded = this.lamps.uLampCount.value > 0
    const flashOn = this.lightUniforms.uFlashOn.value > 0.5
    if (lampsLoaded) this._renderShadow()
    else this._clearRT(this.shadowBlurRT, 0xffffff)
    this._renderLighting()
    if (lampsLoaded || flashOn) this._renderVolumetrics()
    else this._clearRT(this.volRT, 0x000000)
    this._renderBloom()
    this._composite()

    // Debug: blit a single pipeline channel to screen, skip grade/FXAA.
    if (this.debugView) {
      this._renderDebug()
      return
    }

    // 7. outline (optional)  8. grade -> sRGB  9. FXAA -> screen
    const graded = this._renderOutline()
    this._renderGrade(time, graded)
    this._renderFXAA()
  }

  dispose() {
    this.gBuffer.dispose()
    this.litRT.dispose()
    this.aoRT.dispose()
    this.aoBlurRT.dispose()
    this.shadowRT.dispose()
    this.shadowBlurRT.dispose()
    this.volRT.dispose()
    this.bloomPreRT.dispose()
    this.bloomTmpRT.dispose()
    this.bloomRT.dispose()
    this.sceneRT.dispose()
    this.outlineRT.dispose()
    this.gradeRT.dispose()
    this.ramp.dispose()
    this.lightQuad.dispose()
    this.aoQuad.dispose()
    this.aoBlurQuad.dispose()
    this.shadowQuad.dispose()
    this.shadowBlurQuad.dispose()
    this.volQuad.dispose()
    this.bloomPreQuad.dispose()
    this.bloomBlurQuad.dispose()
    this.compositeQuad.dispose()
    this.outlineQuad.dispose()
    this.gradeQuad.dispose()
    this.fxaaQuad.dispose()
    this.debugQuad.dispose()
  }
}
