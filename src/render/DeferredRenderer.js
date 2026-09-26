import * as THREE from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { makeLampUniforms } from './LightField.js'
import { FrameGpuTimer, PassTimer } from './PassTimer.js'
import { FS_VERT, SAMPLER_PRECISION } from './shaders/common.js'
import { lightingFrag } from './shaders/lighting.js'
import { SHADOW_FRAG, SHADOW_BLUR_FRAG } from './shaders/shadow.js'
import { AO_FRAG, AO_BLUR_FRAG } from './shaders/ssao.js'
import { GTAO_FRAG } from './shaders/gtao.js'
import { CONTACT_FRAG } from './shaders/contact.js'
import { OCC_RESOLVE_FRAG } from './shaders/occResolve.js'
import { VOL_BLUR_FRAG, volFrag } from './shaders/volumetric.js'
import { BLOOM_PREFILTER_FRAG, BLOOM_BLUR_FRAG } from './shaders/bloom.js'
import { COMPOSITE_FRAG } from './shaders/composite.js'
import { OUTLINE_FRAG } from './shaders/outline.js'
import { GRADE_FRAG } from './shaders/grade.js'
import { FXAA_FRAG } from './shaders/fxaa.js'
import { DEBUG_VIEW_FRAG } from './shaders/debugView.js'
import { PROBE_FRAG, PROBE_MAX } from './shaders/probe.js'
import { SIGNAL_FRAG, SMEAR_FRAG } from './shaders/signal.js'
import { MOTION_BLUR_FRAG } from './shaders/motionBlur.js'
import { createLampDataTexture, packLampData } from './shaders/lampData.js'
import { AutoExposure } from './AutoExposure.js'
import { FlashlightShadow } from './FlashlightShadow.js'
import { GridLightTextures, createPlaceholderGridTextures } from './GridLightTextures.js'
import {
  AMBIENT_FAMILY,
  ATT_PHYSICAL,
  DEFAULT_LOOK,
  OCCLUSION_V2,
  SHADING_PBR,
  TONE_AGX,
  TONE_NEUTRAL,
  TONE_VIDEO,
  resolveLook,
} from './lookProfile.js'
import {
  FAR,
  FOG_COLOR,
  FOG_DENSITY,
  PANEL_COLOR,
  LIGHT_RANGE,
  LIGHT_INTENSITY,
  LAMP_QUERY_R,
  LAMP_FADE_BAND,
  AO_SAMPLES,
  AO_SAMPLES_MAX,
  SHADOW_STEPS,
  SHADOW_STEPS_MAX,
  SHADOW_MAX,
  SHADOW_LAMPS_MAX,
  VOL_STEPS,
  VOL_STEPS_MAX,
  VOL_LIGHT_MAX,
  VOL_LIGHTS_MAX,
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
  BLOOM_WIDE_SPREAD,
  BLOOM_WIDE_INTENSITY,
  BLOOM_THRESHOLD,
  BLOOM_KNEE,
  BLOOM_SURFACE,
  CEL_HARD,
  GRADE_LEVELS,
  GRADE_TINT,
  GRADE_SAT,
  GRADE_EXPOSURE,
  GRADE_SHADOW_TINT,
  GRADE_HIGHLIGHT_TINT,
  GRADE_LIFT,
  GRADE_TIME_WRAP,
  TERMINATOR_STRENGTH,
  LAMP_AO_MIX,
  LAMP_BOUNCE,
  SPEC_POWER,
  SPEC_STRENGTH,
  SPEC_REACH,
  OUTLINE_INK,
  OUTLINE_INK_TINT,
  OUTLINE_OPACITY,
  OUTLINE_THICKNESS,
  OUTLINE_DEPTH_THRESH,
  OUTLINE_NORMAL_THRESH,
  OUTLINE_FADE_NEAR,
  OUTLINE_FADE_FAR,
  CAPSULE_MAX,
  CAPSULE_ENEMIES_MAX,
  WALL_H,
} from '../world/constants.js'

// Deferred renderer. Stage A renders the scene into G-buffer v2 (MRT:
// albedo+matID, viewNormal+roughness, metalness/materialAO/gloss) + depth;
// fullscreen passes then light, shade and grade it:
//   gbuffer -> [flashlight shadow] -> ssao -> contact shadow -> lighting ->
//   [exposure meter] -> volumetric -> bloom -> composite -> outline ->
//   grade -> fxaa
// Lighting reads the world-grid light lists (world/lightGrid) when a grid is
// bound, the legacy nearest-lamp set otherwise; the active LOOK PROFILE
// (lookProfile.js) selects the shading model and every stylised lever.
//
// The per-pass GLSL lives in ./shaders/*; this module owns the render targets,
// uniforms and per-frame orchestration only.

// Fullscreen passes never depth-test, so only the G-buffer owns a depth
// attachment. Keeping the option in shared presets prevents newly-added post
// targets from silently allocating/clearing an unused depth renderbuffer.
const HDR_RT_OPTS = { type: THREE.HalfFloatType, depthBuffer: false }
// Shared preset for scaled HDR effect buffers (volumetrics / bloom) — bilinear
// so they upsample smoothly.
const HALF_RT_OPTS = {
  ...HDR_RT_OPTS,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
}
// AO and shadow are scalar visibility masks. R8 preserves their [0,1] contract
// while using one byte/texel instead of RGBA16F's eight; WebGL2 supports linear
// filtering and color rendering for this format.
const MASK_RT_OPTS = {
  format: THREE.RedFormat,
  type: THREE.UnsignedByteType,
  depthBuffer: false,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
}
const SCRATCH_RT_OPTS = { hdr: HALF_RT_OPTS, mask: MASK_RT_OPTS }
const LDR_RT_OPTS = { depthBuffer: false }
// Keep influence spheres touching a frustum plane despite floating-point
// normalization/projection noise. This is deliberately tiny relative to the
// game's 11u lamp range: it prevents edge shimmer without retaining a useful
// off-screen band.
const LAMP_FRUSTUM_EPSILON = 0.05
const TONE_MAPPER_INDEX = { filmic: 0, [TONE_AGX]: 1, [TONE_NEUTRAL]: 2, [TONE_VIDEO]: 3 }
const lum3 = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b

// Linear THREE.Color from an sRGB hex. With THREE.ColorManagement.enabled (set in
// Engine), the Color constructor already decodes sRGB -> linear working space, so
// this must NOT call convertSRGBToLinear() again (that double-decode darkened and
// over-saturated every solid color).
const linVec = (hex) => new THREE.Color(hex)

// The lamp colour pushed toward full saturation for the anime terminator band:
// square it (widens the channel spread) and renormalise to a peak of 1, so a
// warm-white tube paints an amber edge and a cold tube a mint one.
export function terminatorColor(lampLinear, out = new THREE.Color()) {
  out.setRGB(lampLinear.r ** 2, lampLinear.g ** 2, lampLinear.b ** 2)
  const peak = Math.max(out.r, out.g, out.b, 1e-4)
  return out.multiplyScalar(1 / peak)
}

// Radical inverse (van der Corput): any PREFIX of the sequence covers [0,1)
// uniformly, which is what lets one max-size kernel serve every quality tier —
// the low tier reads the first 8 samples and still gets a stratified spread
// instead of the tight cluster a sorted ramp would give it.
function radicalInverse(i, base) {
  let r = 0
  let f = 1 / base
  for (let v = i; v > 0; v = Math.floor(v / base)) {
    r += (v % base) * f
    f /= base
  }
  return r
}

// Golden angle: successive azimuths never repeat and any prefix is spread
// evenly around the circle.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

// Normal-oriented hemisphere kernel. ALL THREE dimensions are low-discrepancy
// and deterministic: base-2 van der Corput for the polar term, golden angle for
// the azimuth, base-3 van der Corput for the radius (a different base so the
// radius can't correlate with the elevation).
function aoKernel(n) {
  const k = []
  for (let i = 0; i < n; i++) {
    const z = radicalInverse(i + 1, 2) // (0,1): never a degenerate grazing sample
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    const phi = (i + 1) * GOLDEN_ANGLE
    const v = new THREE.Vector3(r * Math.cos(phi), r * Math.sin(phi), z)
    const s = radicalInverse(i + 1, 3)
    v.multiplyScalar(0.1 + 0.9 * s * s) // cluster samples near the origin
    k.push(v)
  }
  return k
}

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
    this._lampFrustum = new THREE.Frustum()
    this._lampSphere = new THREE.Sphere()
    this._lampViewScratch = new THREE.Vector3()
    // Raw AO, raw shadow, and bloom's horizontal-blur output have disjoint
    // lifetimes. Pool compatible intermediates first by storage class, then by
    // resolution scale: scalar masks can alias each other, but never HDR bloom.
    this._effectScratchRTs = new Map()
    // Render target -> the identity color it currently holds, so a pass that
    // stays skipped is not re-cleared every frame (see _clearRT).
    this._identityRT = new Map()
    // A lost-then-restored GL context recreates every target zero-filled while
    // this cache still claims they hold their identity values: with AO or
    // shadows disabled, ambient x AO (and lamp x shadow) would read 0 and the
    // scene would stay near-black until the next resize or settings change.
    // Adapted exposure is GPU state too: re-meter from scratch.
    // The flashlight map comes back empty (a still emitter would otherwise
    // keep skipping onto it, a black beam) and its depth attachment needs a
    // GL object before any sampler2DShadow sees it; the grid textures must
    // re-upload whole, not just this frame's dirty rows; and the timer
    // extension is disabled on the new context until it is requested again.
    this._onContextRestored = () => {
      this._identityRT.clear()
      this.exposure?.reset()
      this._flashTargetReady = false
      this.flashShadow?.invalidate()
      this.grid?.restore()
      this.frameTimer?.restore()
      if (this.timer) {
        this.timer.restore()
        this.timingEnabled = this.timingEnabled && this.timer.supported
      }
    }
    renderer.domElement?.addEventListener?.('webglcontextrestored', this._onContextRestored)

    const { dw, dh } = this._dims()
    // The lamp field is shared by the shadow, lighting and volumetric passes,
    // so build it before any of them. The compacted visible set rides a data
    // texture (shaders/lampData.js), not uniform arrays.
    this.lamps = makeLampUniforms() // source world-space set, driven by LightField / LightRoom
    this.visibleLamps = this.lamps.visible // compact renderer-local view-space set
    this.lampData = createLampDataTexture()
    this._initShared()
    this._initGBuffer(dw, dh)
    this._initSSAO(dw, dh)
    this._initShadow(dw, dh)
    this._initLighting()
    this._initOcclusionV2(dw, dh)
    this._initVolumetrics(dw, dh)
    this._initBloom(dw, dh)
    this._initComposite(dw, dh)
    this._initOutline(dw, dh)
    this._initGrade(dw, dh)
    this._initFXAA(dw, dh)
    this._initCamera(dw, dh)
    this._initDebug()
    this.exposure = new AutoExposure({
      tLit: this.litRT.texture,
      tColor: this.gColor,
      tDepth: this.depthTex,
    })

    this.outlineEnabled = true // user setting (Settings 'outline')
    // Pass enables (runtime quality; see applyQuality). A disabled pass is
    // skipped and its output cleared to the identity value each frame, so the
    // downstream shaders never special-case it.
    this.aoEnabled = true
    this.shadowEnabled = true
    this.volEnabled = true
    this.bloomEnabled = true
    this.fxaaEnabled = true
    this.flashShadowEnabled = true
    // World-grid lighting: `grid` is the bound GPU mirror; gridEnabled is the
    // debug/rollback toggle; gridSuspended is set while a non-world scene (the
    // debug light room) is being drawn.
    this.grid = null
    this.gridEnabled = true
    this.gridSuspended = false
    this._lastTime = null
    // Debug A/B: when set, the frame is a stock-material forward render of
    // this scene, graded by the same output pass (debug/PbrReference.js).
    this.referenceScene = null
    this.refRT = null

    // Optional per-pass GPU timing (debug; see setTiming / PassTimer).
    this.timer = null
    this.timingEnabled = false

    this.setLook(DEFAULT_LOOK)
  }

  // Uniform value-objects shared by several passes: the world-grid samplers,
  // the flashlight frame and its shadow map, camera matrices.
  _initShared() {
    this._gridPlaceholder = createPlaceholderGridTextures()
    const ph = this._gridPlaceholder
    this.gridUniforms = {
      tGridList: { value: ph.list },
      tGridEdge: { value: ph.edge },
      tGridLamp: { value: ph.lamp },
      tGridGI: { value: ph.gi },
      tGridOcc: { value: ph.occ },
      uTime: { value: 0 },
      uGridOn: { value: 0 },
      // Look: fixture source height (floor-local) and soft-shadow size,
      // shared by every pass that shades or shadows fixtures.
      uSourceY: { value: WALL_H - 0.5 },
      uPenumbraScale: { value: 1 },
    }
    this.flashShadow = new FlashlightShadow(1024)
    // The PCSS build reads blocker depth through a plain sampler2D. Outside
    // PCSS there is no blocker target, and binding the comparison-mode depth
    // texture there would fail every draw of a PCSS build still on screen
    // (sampler/format mismatch), so the unit holds this 1x1 "no blocker".
    this._flashDepthNone = new THREE.DataTexture(new Uint8Array(1), 1, 1, THREE.RedFormat, THREE.UnsignedByteType)
    this._flashDepthNone.needsUpdate = true
    this.flashUniforms = {
      uFlashPosV: { value: this.flashShadow.posView },
      uFlashDirV: { value: this.flashShadow.dirView },
      uFlashShadowOn: { value: 0 },
      tFlashShadow: { value: this.flashShadow.depth },
      uFlashShadowMatrix: { value: this.flashShadow.viewToShadow },
      uFlashFromView: { value: this.flashShadow.fromView },
      uFlashParams: { value: this.flashShadow.params },
    }
    this.cameraUniforms = {
      uCamToWorld: { value: new THREE.Matrix4() },
      uWorldToCam: { value: new THREE.Matrix4() },
      uCamPosW: { value: new THREE.Vector3() },
      uUpView: { value: new THREE.Vector3(0, 1, 0) },
    }
    // Resolved quality knobs the passes read (applyQuality overwrites).
    this.quality = null
    // `variant` is the key of the lighting build that is DRAWING (pass
    // selection and occlusion inputs follow it); `_variantKey_` names the
    // requested one. They differ only while a new build links (_applyVariants).
    this._variantKey_ = null
    this.variant = null
    this._lightGen = 0
    this._pendingLightMat = null
    this._lightWaiters = []
    // A look whose lighting build is still linking (setLook).
    this._wantLook = null
    this._frames = 0
    this._fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this._flashColor = linVec(FLASH_COLOR)
    this._scratchColor = new THREE.Color()
    this.panelGlow = 1
    // GTAO + per-light contact channels (occlusion v2) are wired: the
    // physically based looks select OCC_V2.
    this.occV2Ready = true
    // Flashlight caster-set revision (Engine): unchanged revision + a still
    // emitter lets the map skip its re-render.
    this.casterRevision = null
    this._capGroups = 0
  }

  // Push a resolved quality object (core/graphics.js resolveGraphics) into the
  // pipeline: pass enables + uniform loop trip counts. Clamped to the shader
  // compile-time ceilings so a bad settings blob can't overrun a uniform array.
  //
  // Uniform knobs switch instantly; the VARIANT knobs (furniture boxes, the
  // flashlight filter, bent normals) select a lighting-shader build, rebuilt
  // only when its key changes (_applyVariants).
  applyQuality(q) {
    this.quality = q
    const lu = this.lightUniforms
    this.aoEnabled = !!q.ao.enabled
    this.aoUniforms.uSamples.value = Math.min(q.ao.samples | 0, AO_SAMPLES_MAX)
    lu.uAORadius.value = q.ao.radius ?? 0.8
    lu.uBoxAOCells.value = q.ao.boxAOCells ?? 1
    lu.uGIStencil.value = q.ao.giStencil === false ? 0 : 1
    const sh = q.shadow
    this.shadowEnabled = !!sh.enabled
    this.shadowUniforms.uSteps.value = Math.min(sh.steps | 0, SHADOW_STEPS_MAX)
    this.shadowUniforms.uMaxLamps.value = Math.min(sh.lamps | 0, SHADOW_LAMPS_MAX)
    lu.uMaxTraced.value = sh.traced ?? 8
    lu.uTraceSubRays.value = sh.subRays ?? 1
    lu.uCrossFloor.value = sh.crossFloor ? 1 : 0
    lu.uFurnLights.value = sh.furnLights ?? 0
    lu.uFurnCellsMax.value = sh.furnCells ?? 0
    lu.uFurnBoxes.value = sh.furnBoxes ?? 0
    lu.uCapsuleLights.value = sh.capsuleLights ?? 2
    lu.uCapsulesPerEnemy.value = sh.capsulesPerEnemy ?? 1
    lu.uContactChannels.value = sh.contactChannels ?? 0
    lu.uVplOccl.value = sh.vplOcclusion ? 1 : 0
    this.gtaoUniforms.uSlices.value = q.ao.slices ?? 2
    this.gtaoUniforms.uSteps.value = q.ao.steps ?? 6
    this.contactUniforms.uSteps.value = sh.contactSteps ?? 16
    this.contactUniforms.uExtra.value = sh.contactExtra ?? 0
    this.contactUniforms.uLegacyLamps.value = sh.lamps ?? 6
    this.volEnabled = !!q.vol.enabled
    const vu = this.volUniforms
    vu.uSteps.value = Math.min(q.vol.steps | 0, VOL_STEPS_MAX)
    vu.uMaxLights.value = Math.min(q.vol.lights | 0, VOL_LIGHTS_MAX)
    vu.uNearSteps.value = q.vol.nearSteps ?? 0
    vu.uTraceLights.value = q.vol.traceLights ?? 0
    vu.uTraceEvery.value = Math.max(1, q.vol.traceEvery ?? 2)
    vu.uTraceDist.value = q.vol.traceDist ?? 0
    this.volBlur = !!q.vol.blur
    this.bloomEnabled = !!q.bloom
    this.bloomTail = !!q.bloomTail
    this.fxaaEnabled = !!q.fxaa
    // Flashlight shadows have their own tier (v1 followed the world tier):
    // off disables the map, the tier picks its size and filter.
    const fl = q.flash ?? { enabled: sh.enabled, size: 1024, filter: 0, taps: 9, blockerTaps: 0 }
    this.flashShadowEnabled = !!fl.enabled
    // The blocker target stays while a PCSS build is still drawing (it only
    // leaves once a non-PCSS build lands, _commitVariant): dropping it at
    // once would leave the outgoing build's blocker search empty and the
    // torch unshadowed for the whole link window.
    if (this.flashShadowEnabled) {
      this._setFlashTarget(fl.size, this._variantKey().flashFilter === 2 || this.variant?.flashFilter === 2)
    }
    lu.uFlashTaps.value = fl.taps ?? 9
    lu.uFlashBlockerTaps.value = fl.blockerTaps ?? 0
    vu.uFlashEvery.value = Math.max(1, fl.volEvery ?? 1)
    this._applyVariants()
    this._applyBloomLook()
  }

  // Shader-variant key for the active look x quality. Only these select a
  // different lighting build; everything else is a uniform.
  _variantKey(look = this._wantLook ?? this.look) {
    const q = this.quality
    const pbr = look.shading === SHADING_PBR
    const analytic = this._analyticTorch(look)
    return {
      pbr,
      physicalAtt: look.attenuation === ATT_PHYSICAL,
      occV2: this.occV2Ready && look.shadow.occlusionPath === OCCLUSION_V2,
      furn: pbr && (q?.shadow.furnLights ?? 0) > 0 && look.shadow.furniture > 0,
      flashFilter: this.flashShadowEnabled && !analytic ? (q?.flash?.filter ?? 0) : 0,
      flashAnalytic: analytic,
      bent: !!q?.ao.bent && look.shadow.bentNormal > 0,
    }
  }

  // Analytic flashlight shadows (P18): walls, proxies and capsules traced
  // from the hand, no shadow map. A tier flag (q.flash.analytic) or the F2
  // toggle selects it; no tier enables it until low-end devices measure it
  // cheaper than the 512 map (chapter 14).
  _analyticTorch(look = this._wantLook ?? this.look) {
    const q = this.quality
    return !!(this.flashShadowEnabled && look?.shading === SHADING_PBR && (q?.flash?.analytic || this.analyticTorchDebug))
  }

  setAnalyticTorch(on) {
    this.analyticTorchDebug = !!on
    this._applyVariants()
  }

  // Rebuild the lighting shader when its variant key changed. After the
  // first frame the new build links in the background (compileAsync over a
  // throwaway mesh: a scene-level precompile never sees fullscreen quads)
  // and swaps in once ready, so a menu change never stalls or renders a
  // black frame.
  //
  // Until then the OLD build keeps drawing with its own state: `variant`
  // (the pass set), the occlusion inputs and a look waiting on the build
  // all commit together with the material (_commitVariant), so no frame
  // pairs a build with another build's inputs or look uniforms. Every
  // request supersedes whatever is in flight: a superseded build is
  // disposed when its compile settles (disposing it mid-poll would throw
  // inside three's readiness check) and never swaps in, whatever order the
  // compiles finish in.
  _applyVariants() {
    const look = this._wantLook ?? this.look
    if (!this.lightQuad || !look) return
    this._applyVolVariant()
    const key = this._variantKey(look)
    const id = JSON.stringify(key)
    const changed = id !== this._variantKey_
    if (changed) {
      this._variantKey_ = id
      const gen = ++this._lightGen
      this._pendingLightMat = null
      const frag = lightingFrag(key)
      if (this.lightQuad.material.fragmentShader !== SAMPLER_PRECISION + frag) {
        const m = fsMaterial(frag, this.lightUniforms)
        const r = this.renderer
        if (this._frames > 0 && typeof r.compileAsync === 'function') {
          this._pendingLightMat = m
          const settle = () => {
            if (this._disposed || gen !== this._lightGen) {
              m.dispose()
              return
            }
            this._pendingLightMat = null
            this._installLighting(m)
            this._commitVariant(key)
          }
          const scene = new THREE.Scene()
          scene.add(new THREE.Mesh(this.lightQuad._mesh.geometry, m))
          Promise.resolve()
            .then(() => r.compileAsync(scene, this._fsCamera))
            .then(settle, settle)
        } else {
          this._installLighting(m)
        }
      }
    }
    // Nothing in flight: the drawing build already matches the request.
    if (!this._pendingLightMat && (changed || this._wantLook)) this._commitVariant(key)
  }

  _installLighting(m) {
    const old = this.lightQuad.material
    this.lightQuad.material = m
    if (old !== m) old.dispose()
  }

  // The drawing lighting build is now `key`'s: switch the pass set and the
  // occlusion inputs to it, and commit a look that waited for it.
  _commitVariant(key) {
    this.variant = key
    // Occlusion inputs follow the path: v2 resolve outputs, or the legacy
    // SSAO + contact-mask blurs (Classic).
    const lu = this.lightUniforms
    lu.tOcc.value = key.occV2 ? this.occRT.textures[0] : this.aoBlurRT.texture
    lu.tContact.value = key.occV2 ? this.occRT.textures[1] : this.shadowBlurRT.texture
    this.debugViewUniforms.tAO.value = lu.tOcc.value
    this.debugViewUniforms.tShadow.value = lu.tContact.value
    // The flashlight map carries the blocker target exactly while a PCSS
    // build draws (a look can leave or enter PCSS through the analytic torch).
    if (this.flashShadowEnabled) this._setFlashTarget(this.flashShadow.size, key.flashFilter === 2)
    const look = this._wantLook
    if (look) {
      this._wantLook = null
      this._commitLook(look)
    }
    if (!this._pendingLightMat) this._resolveLightWaiters()
  }

  _resolveLightWaiters() {
    const waiters = this._lightWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  // Resolves once the requested lighting build (and a look switch waiting on
  // it) is the one drawing. Capture tooling awaits it after a look or
  // quality change so it never records the outgoing build.
  whenLightingReady() {
    if (!this._pendingLightMat || this._disposed) return Promise.resolve()
    return new Promise((resolve) => this._lightWaiters.push(resolve))
  }

  // Volumetric haze (ultra) is a separate shaft build. Both builds are kept
  // (and precompiled after the first frame, _precompileFullscreen), so the
  // auto preset's promotion or the in-session guard's demotion swaps
  // programs mid-game without linking one.
  _applyVolVariant() {
    const haze = !!this.quality?.vol?.haze
    this.volQuad.material = this._volMats[haze ? 1 : 0]
  }

  // (Re)allocate the flashlight map and rebind its textures. Outside PCSS
  // tFlashDepth holds the 1x1 'no blocker' texture, never the comparison-mode
  // depth texture.
  _setFlashTarget(size, pcss) {
    const before = this.flashShadow.target
    this.flashShadow.setSize(size, pcss)
    this.flashUniforms.tFlashShadow.value = this.flashShadow.depth
    this.lightUniforms.tFlashDepth.value = this.flashShadow.blockerTexture ?? this._flashDepthNone
    if (this.flashShadow.target !== before) this._flashTargetReady = false
  }

  // A sampler2DShadow must always see a real depth texture: a render target's
  // depth attachment has no GL object until the target is first bound, and an
  // empty unit fails every draw with a sampler/format mismatch even while the
  // torch (and the branch sampling it) is off.
  _ensureFlashTarget() {
    if (this._flashTargetReady) return
    this.renderer.initRenderTarget?.(this.flashShadow.target)
    this._flashTargetReady = true
  }

  // --- Look profile ------------------------------------------------------

  // Select the look (lookProfile.js): shading model + attenuation (a lighting
  // shader variant) and every stylised lever, then re-derive the grade from
  // the active family palette. Safe to call at any time; no targets change.
  //
  // A look that needs a different lighting build commits (uniforms, grade,
  // exposure reset) only when that build swaps in: the outgoing build keeps
  // rendering its own look meanwhile, never the new look's lamp powers or
  // occlusion inputs. `look` stays the committed look until then.
  setLook(id) {
    const look = resolveLook(id)
    this._wantLook = look
    this._applyVariants()
    return look
  }

  _commitLook(look) {
    this.look = look
    const physical = look.attenuation === ATT_PHYSICAL
    const lu = this.lightUniforms
    const gu = this.gridUniforms
    const sh = look.shadow
    // Fixture source: the visible emitter in the physically based looks,
    // the legacy virtual point in Classic (every fixture pass shares it).
    gu.uSourceY.value = WALL_H - look.lights.sourceDrop
    gu.uPenumbraScale.value = sh.penumbraScale
    lu.uEmitFloor.value = look.lights.emitFloor
    lu.uEmitPow.value = look.lights.emitPow
    lu.uCeilingLift.value = look.lights.ceilingLift
    lu.uShadowStrength.value = SHADOW_STRENGTH * sh.contact
    this.shadowUniforms.uMaxDist.value = sh.contactLength
    lu.uFurnK.value = sh.furniture
    lu.uBoxAOK.value = sh.furnitureAO
    lu.uCapsuleK.value = sh.capsule
    lu.uCapsuleAOK.value = sh.capsuleAO
    lu.uCapsuleMinVis.value = sh.capsuleMinVis
    lu.uSelfShadow.value = sh.selfShadow
    lu.uCreaseK.value = sh.creaseAO
    lu.uTorchSize.value = sh.torchSize
    lu.uMultiBounce.value = sh.multiBounce
    lu.uSpecOcc.value = sh.specOcclusion
    lu.uBentK.value = sh.bentNormal
    const tt = look.lights.torchTint
    lu.uFlashColor.value.copy(this._flashColor).multiply(this._scratchColor.setRGB(tt[0], tt[1], tt[2]))
    // Emissive tube brightness (Engine._updateFlicker multiplies it in) and
    // the troffer face (the panel material's uniform, via panelPattern).
    this.panelGlow = look.lights.panelGlow
    this.panelPattern = look.lights.panelPattern
    lu.uLampIntensity.value = LIGHT_INTENSITY * look.lampPower
    lu.uCelHard.value = look.celHard
    lu.uTermStrength.value = TERMINATOR_STRENGTH * look.terminator
    lu.uRim.value = RIM_STRENGTH * look.rim
    lu.uRimLitGate.value = look.rimLitGate
    lu.uEntityRimK.value = look.entityRim
    lu.uEntityFill.value = look.entityFill
    lu.uBounce.value = LAMP_BOUNCE * look.lampBounce
    lu.uGI.value = look.gi
    lu.uHemi.value = look.hemiAmbient
    lu.uSpecK.value = look.specular
    lu.uLampAO.value = LAMP_AO_MIX * look.lampAO
    lu.uFlashIntensity.value = FLASH_INTENSITY * look.flashPower
    this.volUniforms.uFlashPhys.value = physical ? 1 : 0
    this.volUniforms.uVolEmit.value = look.shading === SHADING_PBR ? 1 : 0
    lu.uFlashBounce.value = look.flashBounce
    this.compositeUniforms.uVolIntensity.value = VOL_INTENSITY * look.volumetric
    this._applyBloomLook()
    const g = this.gradeUniforms
    g.levels.value = look.posterize > 0 ? look.posterize : 0
    g.toneMapper.value = TONE_MAPPER_INDEX[look.toneMapper] ?? 0
    g.autoExposure.value = look.exposure.auto ? 1 : 0
    g.grainK.value = look.grain
    this._applyGradeLook()
    this._applyAmbient()
    this._applySignalLook() // also the NOISE-gated sensor noise
    this.exposure.reset()
  }

  // Bloom levels for look x quality: the tail runs on high/ultra; lower tiers
  // fold its weight into the wide veil so the glare's energy stays put.
  _applyBloomLook() {
    const look = this.look
    if (!look) return
    const cu = this.compositeUniforms
    const cam = look.camera
    const tail = cam.bloomTail
    cu.uBloomIntensity.value = BLOOM_INTENSITY * look.bloom
    cu.uBloomWide.value = BLOOM_WIDE_INTENSITY * (look.bloomWide + (this.bloomTail ? 0 : tail))
    cu.uBloomTail.value = this.bloomTail ? BLOOM_WIDE_INTENSITY * tail : 0
    const h = cam.halation
    cu.uHalation.value.set(h[0], h[1], h[2], h[3])
    this.bloomPreUniforms.uClamp.value = cam.bloomClamp
  }

  // Family dusk ambient x the look's shadow colour. 'family' keeps the
  // palette's hemisphere (the art direction: a family is recognised by its
  // shadow colour); an override re-hues it with the luminance preserved.
  _applyAmbient() {
    const pal = this.palette
    const lu = this.lightUniforms
    const sky = lu.uAmbSky.value.copy(linVec(pal?.ambientSky ?? AMBIENT_SKY))
    const ground = lu.uAmbGround.value.copy(linVec(pal?.ambientGround ?? AMBIENT_GROUND))
    const tint = this.look?.shadow.ambientTint ?? AMBIENT_FAMILY
    if (tint === AMBIENT_FAMILY) return
    const o = this._scratchColor.setRGB(tint[0], tint[1], tint[2])
    const k = this.look.shadow.ambientTintK
    for (const c of [sky, ground]) {
      const target = o.clone().multiplyScalar(lum3(c) / Math.max(lum3(o), 1e-6))
      c.lerp(target, k)
    }
  }

  // Family palette x look -> grade uniforms. The look scales each stylised
  // stage's deviation from neutral, so a family's identity survives in the
  // semi-realistic look at a fraction of its classic strength.
  _applyGradeLook() {
    const pal = this.palette
    const look = this.look
    const g = this.gradeUniforms
    const toward = (v, k) => 1 + (v - 1) * k
    const cam = look.camera
    const sat = pal?.gradeSat ?? GRADE_SAT
    const tint = pal?.gradeTint ?? GRADE_TINT
    const base = (pal?.exposure ?? GRADE_EXPOSURE) * 2 ** (look.exposure.bias ?? 0)
    g.sat.value = toward(sat, look.saturation) * cam.satAbs
    const t = [toward(tint[0], look.tint), toward(tint[1], look.tint), toward(tint[2], look.tint)]
    const wb = cam.whiteBalance
    // tintStage 'scene': the family tint joins the white balance before the
    // tone map, so saturated tubes clip toward white instead of tinted;
    // 'post' keeps the legacy post-tone-map multiply (Classic).
    if (cam.tintStage === 'scene') {
      g.wb.value.set(wb[0] * t[0], wb[1] * t[1], wb[2] * t[2])
      g.tint.value.set(1, 1, 1)
    } else {
      g.wb.value.set(wb[0], wb[1], wb[2])
      g.tint.value.set(t[0], t[1], t[2])
    }
    g.shadowTint.value.set(...cam.splitShadow.map((v) => toward(v, look.splitTone)))
    g.highTint.value.set(...cam.splitHigh.map((v) => toward(v, look.splitTone)))
    g.lift.value = GRADE_LIFT * look.lift
    g.liftColor.value.set(cam.liftColor[0], cam.liftColor[1], cam.liftColor[2])
    g.hiDesat.value = cam.highlightDesat
    g.knee.value = cam.knee
    g.whiteClip.value = cam.whiteClip
    g.toe.value = cam.toe
    g.blackLevel.value = cam.blackLevel
    g.vigBase.value = cam.vignetteBase
    // CAMERA FX off (accessibility) removes the lens distortion and CA.
    const fx = this.cameraFx === false ? 0 : 1
    g.lensK1.value = cam.lensK1 * fx
    g.lensK2.value = cam.lensK2 * fx
    g.caK.value = cam.caK * fx
    g.exposure.value = base
    g.exposureRef.value = base
    this.exposure?.configure(look.exposure, pal?.exposure ?? GRADE_EXPOSURE)
  }

  // Settings 'cameraFx': the look's lens distortion and CA follow it.
  setCameraFx(on) {
    this.cameraFx = !!on
    if (this.look) this._applyGradeLook()
  }

  // Toggle per-pass GPU timing (LightTool). Returns whether timing is actually
  // running — false when EXT_disjoint_timer_query_webgl2 is unavailable.
  setTiming(on) {
    if (on && !this.timer) this.timer = new PassTimer(this.renderer.getContext())
    this.timingEnabled = !!on && !!this.timer?.supported
    if (!on && this.timer) {
      this.timer.dispose()
      this.timer = null
    }
    return this.timingEnabled
  }

  // Always-on whole-frame GPU timing for dynamic resolution (P24). Returns
  // whether GPU timing is available (else the caller uses rAF intervals).
  setFrameTiming(on) {
    if (on && !this.frameTimer) this.frameTimer = new FrameGpuTimer(this.renderer.getContext?.())
    if (!on && this.frameTimer) {
      this.frameTimer.dispose()
      this.frameTimer = null
    }
    return !!this.frameTimer?.supported
  }

  // Newest resolved GPU frame time (ms) or null (see FrameGpuTimer.poll).
  pollFrameMs() {
    return this.timingEnabled ? null : (this.frameTimer?.poll() ?? null)
  }

  // Run one pass inside a GPU timer query when timing is on.
  _pass(name, fn) {
    if (!this.timingEnabled) return fn()
    this.timer.begin(name)
    try {
      return fn()
    } finally {
      this.timer.end()
    }
  }

  // Retarget the lighting environment to a map-family palette
  // (world/familyPalette.js): fog, hemispheric ambient, rim ink, lamp cast
  // color, and the post grade. One family is active per world, so this runs
  // at family-apply time (boot / startRun), never per frame.
  applyPalette(pal) {
    this.palette = pal // the active family's defaults (debug LightTool resets to these)
    this.lightUniforms.uFogColor.value = linVec(pal.fog)
    this._applyAmbient()
    this.lightUniforms.uRimColor.value = linVec(pal.rim)
    this.lightUniforms.uLampColor.value = linVec(pal.panel) // shared with volumetrics
    terminatorColor(this.lightUniforms.uLampColor.value, this.lightUniforms.uTermColor.value)
    // One-bounce fill takes the floor's reflectance colour: the yellow rooms
    // glow yellow, the hotel's burgundy carpet warms its walls.
    this.lightUniforms.uBounceColor.value = linVec(pal.floor?.base ?? 0x808080)
    this._applyGradeLook()
    this.exposure.reset()
    this._syncGridAlbedo()
  }

  // The cell-graph GI bounces light off the family's surfaces: hand the grid
  // their linear albedos (it re-solves bounce only when they change).
  _syncGridAlbedo() {
    const grid = this.grid?.grid
    if (!grid || !this.palette) return
    grid.setAlbedo(this.familyAlbedo())
  }

  // The active family's surface albedos (linear rgb triples): the GI solve
  // and the flashlight bounce light colour their light with them.
  familyAlbedo() {
    const pal = this.palette
    const rgb = (hex, fallback) => {
      const c = linVec(hex ?? fallback)
      return [c.r, c.g, c.b]
    }
    return {
      floor: rgb(pal?.floor?.base, 0x808080),
      wall: rgb(pal?.wall?.base, 0x909090),
      ceiling: rgb(pal?.ceiling?.base, 0x909090),
    }
  }

  // Level entry / respawn / family switch: adapted exposure snaps to the new
  // view instead of easing from the previous scene.
  resetAdaptation() {
    this.exposure.reset()
  }

  // --- World-grid lighting -------------------------------------------------

  // Bind (or with null, unbind) a headless LightGrid. The grid's typed arrays
  // become GPU textures; every lighting consumer switches to its lists.
  bindLightGrid(grid) {
    if (this.grid?.grid === grid) return
    this.grid?.dispose()
    this.grid = grid ? new GridLightTextures(grid) : null
    const tex = this.grid?.textures ?? this._gridPlaceholder
    const u = this.gridUniforms
    u.tGridList.value = tex.list
    u.tGridEdge.value = tex.edge
    u.tGridLamp.value = tex.lamp
    u.tGridGI.value = tex.gi
    u.tGridOcc.value = tex.occ
    this._syncGridAlbedo()
  }

  setGridEnabled(on) {
    this.gridEnabled = !!on
  }

  get gridActive() {
    return !!this.grid && this.gridEnabled && !this.gridSuspended
  }

  // Capsule occluders (enemies + the optional player body), world space, in
  // up to CAPSULE_ENEMIES_MAX groups of <= 3 capsules:
  //   caps    flat [ax, ay, az, r, bx, by, bz, owner] per capsule; group g's
  //           capsules start at index g * 3
  //   counts  capsules per group (0 = group absent)
  //   bounds  flat [cx, cy, cz, R] bounding sphere per group
  // Group CAPSULE_ENEMIES_MAX - 1 is reserved for the player body, which
  // never shadows its own flashlight.
  setOccluders(caps, counts, bounds) {
    const u = this.lightUniforms
    let groups = 0
    for (let g = 0; g < CAPSULE_ENEMIES_MAX; g++) {
      const n = Math.max(0, Math.min(3, counts?.[g] | 0))
      u.uCapN.value[g] = n
      const bw = n > 0 ? bounds[g * 4 + 3] : 0
      u.uCapBound.value[g].set(bounds?.[g * 4] ?? 0, bounds?.[g * 4 + 1] ?? 0, bounds?.[g * 4 + 2] ?? 0, bw)
      for (let j = 0; j < n; j++) {
        const i = g * 3 + j
        if (i >= CAPSULE_MAX) break
        const o = i * 8
        u.uCapA.value[i].set(caps[o], caps[o + 1], caps[o + 2], caps[o + 3])
        u.uCapB.value[i].set(caps[o + 4], caps[o + 5], caps[o + 6], caps[o + 7])
      }
      if (n > 0) groups = g + 1
    }
    this._capGroups = groups
  }

  // The flashlight's bounce light (Engine raycasts the beam through the
  // grid): world position, the hit surface normal, and the radiance colour
  // (hit albedo x torch colour x falloff).
  setVpl(on, pos, normal, color) {
    const u = this.lightUniforms
    u.uVplOn.value = on ? 1 : 0
    if (!on) return
    u.uVplPosW.value.copy(pos)
    u.uVplN.value.copy(normal)
    const fc = u.uFlashColor.value
    u.uVplColor.value.set(color.x * fc.r, color.y * fc.g, color.z * fc.b)
  }

  // Half-res (or any scale) dimensions with a >=1 clamp, shared by the
  // constructor and setSize() so the two can't drift.
  _halfRes(dw, dh, scale) {
    return { w: Math.max(1, Math.floor(dw * scale)), h: Math.max(1, Math.floor(dh * scale)) }
  }

  _effectScratch(dw, dh, scale, storage) {
    let scaledPool = this._effectScratchRTs.get(storage)
    if (!scaledPool) {
      scaledPool = new Map()
      this._effectScratchRTs.set(storage, scaledPool)
    }
    let rt = scaledPool.get(scale)
    if (!rt) {
      const { w, h } = this._halfRes(dw, dh, scale)
      rt = new THREE.WebGLRenderTarget(w, h, SCRATCH_RT_OPTS[storage])
      scaledPool.set(scale, rt)
    }
    return rt
  }

  // --- stage init ----------------------------------------------------------

  _initGBuffer(dw, dh) {
    // G-buffer v2 (ADR-001 §3): HDR albedo+matID, compact view normal +
    // perceptual roughness, and a material target (metalness, material AO,
    // legacy gloss). gColor must remain RGBA16F: emissive panels exceed 1.0
    // and matID uses 0/1/2. RGBA8 normals: <0.38° worst-case direction error,
    // and the lighting pass renormalizes. 4 extra bytes/pixel over v1.
    const depthTexture = new THREE.DepthTexture(dw, dh)
    depthTexture.type = THREE.UnsignedIntType
    this.gBuffer = new THREE.WebGLRenderTarget(dw, dh, {
      count: 3,
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      depthTexture,
    })
    this.gColor = this.gBuffer.textures[0]
    this.gNormal = this.gBuffer.textures[1]
    this.gMaterial = this.gBuffer.textures[2]
    // Three allocates MRT attachments from each texture's own descriptor, so
    // changing this before the first render produces a mixed RGBA16F + RGBA8
    // framebuffer (capabilities.js probes exactly this layout at boot).
    this.gNormal.type = THREE.UnsignedByteType
    this.gMaterial.type = THREE.UnsignedByteType
    this.depthTex = depthTexture
  }

  _initSSAO(dw, dh) {
    const { w: aw, h: ah } = this._halfRes(dw, dh, AO_SCALE)
    this.aoRT = this._effectScratch(dw, dh, AO_SCALE, 'mask')
    this.aoBlurRT = new THREE.WebGLRenderTarget(aw, ah, MASK_RT_OPTS)
    this.aoUniforms = {
      tNormal: { value: this.gNormal },
      tDepth: { value: this.depthTex },
      uProj: { value: new THREE.Matrix4() },
      uProjInverse: { value: new THREE.Matrix4() },
      // Kernel array is sized to the AO_MAX ceiling baked into ssao.js; the
      // live tier reads the first uSamples entries (prefix-stratified kernel).
      uKernel: { value: aoKernel(AO_SAMPLES_MAX) },
      uSamples: { value: AO_SAMPLES },
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
    this.shadowRT = this._effectScratch(dw, dh, SHADOW_SCALE, 'mask')
    this.shadowBlurRT = new THREE.WebGLRenderTarget(sw, sh, MASK_RT_OPTS)
    this.shadowUniforms = {
      tNormal: { value: this.gNormal },
      tDepth: { value: this.depthTex },
      tLampData: { value: this.lampData },
      uProj: { value: new THREE.Matrix4() },
      uProjInverse: { value: new THREE.Matrix4() },
      uCamToWorld: this.cameraUniforms.uCamToWorld,
      uWorldToCam: this.cameraUniforms.uWorldToCam,
      uUpView: this.cameraUniforms.uUpView,
      uShadowThickness: { value: SHADOW_THICKNESS },
      uLampCount: this.visibleLamps.uLampCount,
      uLampRange: { value: LIGHT_RANGE },
      uLampWrap: { value: LAMP_WRAP },
      uSteps: { value: SHADOW_STEPS },
      uMaxLamps: { value: SHADOW_MAX },
      uMaxDist: { value: 1.8 },
      ...this.gridUniforms,
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

  // Occlusion v2 (chapter 14 P11/P12): half-res GTAO + residual contact,
  // denoised together by one MRT resolve. The Classic look keeps the legacy
  // SSAO + contact targets above (its rollback contract).
  _initOcclusionV2(dw, dh) {
    const { w, h } = this._halfRes(dw, dh, AO_SCALE)
    const opts = {
      depthBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    }
    this.aoRawRT = new THREE.WebGLRenderTarget(w, h, opts)
    this.contactRawRT = new THREE.WebGLRenderTarget(w, h, opts)
    this.occRT = new THREE.WebGLRenderTarget(w, h, { ...opts, count: 2 })
    const cu = this.cameraUniforms
    const lu = this.lightUniforms
    this.gtaoUniforms = {
      tDepth: { value: this.depthTex },
      uProjInverse: { value: new THREE.Matrix4() },
      uSlices: { value: 2 },
      uSteps: { value: 6 },
      uRadius: lu.uAORadius,
      uProjScale: { value: 1 },
      uScale: { value: AO_SCALE },
      uPower: { value: 1.2 },
    }
    this.gtaoQuad = new FullScreenQuad(fsMaterial(GTAO_FRAG, this.gtaoUniforms))
    this.contactUniforms = {
      tNormal: { value: this.gNormal },
      tDepth: { value: this.depthTex },
      tLampData: { value: this.lampData },
      uProj: { value: new THREE.Matrix4() },
      uProjInverse: { value: new THREE.Matrix4() },
      uCamToWorld: cu.uCamToWorld,
      uWorldToCam: cu.uWorldToCam,
      uUpView: cu.uUpView,
      uLampCount: this.visibleLamps.uLampCount,
      uLampRange: this.shadowUniforms.uLampRange,
      uSteps: { value: 16 },
      uChannels: lu.uContactChannels,
      uExtra: { value: 2 },
      uLegacyLamps: { value: 6 },
      // Shared with the legacy pass: the look's contact length.
      uMaxDist: this.shadowUniforms.uMaxDist,
      uScale: { value: AO_SCALE },
      uStridePx: { value: 2 },
      uEmitFloor: lu.uEmitFloor,
      uEmitPow: lu.uEmitPow,
      uCapGroups: lu.uCapGroups,
      uCapN: lu.uCapN,
      uCapA: lu.uCapA,
      uCapB: lu.uCapB,
      uCapBound: lu.uCapBound,
      ...this.gridUniforms,
    }
    this.contactQuad = new FullScreenQuad(fsMaterial(CONTACT_FRAG, this.contactUniforms))
    this.occResolveUniforms = {
      tAORaw: { value: this.aoRawRT.texture },
      tContactRaw: { value: this.contactRawRT.texture },
      tDepth: { value: this.depthTex },
      uProjInverse: { value: new THREE.Matrix4() },
      uScale: { value: AO_SCALE },
    }
    this.occResolveQuad = new FullScreenQuad(fsMaterial(OCC_RESOLVE_FRAG, this.occResolveUniforms))
  }

  _initLighting() {
    const { dw, dh } = this._dims()
    // Linear HDR lit buffer.
    this.litRT = new THREE.WebGLRenderTarget(dw, dh, HDR_RT_OPTS)
    const v4 = (n) => Array.from({ length: n }, () => new THREE.Vector4())

    this.lightUniforms = {
      tColor: { value: this.gColor },
      tNormal: { value: this.gNormal },
      tMaterial: { value: this.gMaterial },
      tDepth: { value: this.depthTex },
      // Screen-space occlusion inputs: the legacy SSAO + contact mask
      // targets, or (occlusion v2) the resolved GTAO / contact channels.
      tOcc: { value: this.aoBlurRT.texture },
      tContact: { value: this.shadowBlurRT.texture },
      tLampData: { value: this.lampData },
      uProjInverse: { value: new THREE.Matrix4() },
      ...this.cameraUniforms,
      uShadowStrength: { value: SHADOW_STRENGTH },
      uLampCount: this.visibleLamps.uLampCount,
      uLampColor: { value: linVec(PANEL_COLOR) },
      uLampIntensity: { value: LIGHT_INTENSITY },
      uLampFlicker: { value: 1 }, // Engine._updateFlicker dips this with the fluorescent hum
      uLampRange: { value: LIGHT_RANGE },
      uAmbSky: { value: linVec(AMBIENT_SKY) },
      uAmbGround: { value: linVec(AMBIENT_GROUND) },
      uHemi: { value: 1 },
      // Same value-object as the shadow pass: the mask must stay weighted by
      // the wrap the lit pass shades with (LightTool edits reach both).
      uLampWrap: this.shadowUniforms.uLampWrap,
      uCelHard: { value: CEL_HARD },
      uRim: { value: RIM_STRENGTH },
      uRimLitGate: { value: 0 },
      uRimColor: { value: linVec(RIM_COLOR) },
      uEntityRim: { value: linVec(ENTITY_RIM) },
      uEntityRimK: { value: 1 },
      uEntityFill: { value: 1 },
      uTermColor: { value: terminatorColor(linVec(PANEL_COLOR)) },
      uTermStrength: { value: TERMINATOR_STRENGTH },
      uBounceColor: { value: linVec(0xcfae5e) }, // office carpet until applyPalette
      uBounce: { value: LAMP_BOUNCE },
      uSpecPower: { value: SPEC_POWER },
      uSpecStrength: { value: SPEC_STRENGTH },
      uSpecK: { value: 1 },
      uLampAO: { value: LAMP_AO_MIX },
      uGI: { value: 0 },
      uGIStencil: { value: 1 },
      uCeilingLift: { value: 0 },
      uEmitFloor: { value: 0.25 },
      uEmitPow: { value: 1 },
      // Occlusion caps (quality tier) and strengths (look).
      uMaxTraced: { value: 8 },
      uTraceSubRays: { value: 1 },
      uCrossFloor: { value: 0 },
      uFurnLights: { value: 0 },
      uFurnCellsMax: { value: 0 },
      uFurnBoxes: { value: 0 },
      uFurnK: { value: 0 },
      uBoxAOK: { value: 0 },
      uBoxAOCells: { value: 1 },
      uCapsuleLights: { value: 2 },
      uCapsulesPerEnemy: { value: 1 },
      uCapsuleK: { value: 0.88 },
      uCapsuleAOK: { value: 0 },
      uCapsuleMinVis: { value: 1 },
      uSelfShadow: { value: 0 },
      uCreaseK: { value: 0 },
      uAORadius: { value: 0.8 },
      uMultiBounce: { value: 0 },
      uSpecOcc: { value: 0 },
      uBentK: { value: 0 },
      uContactChannels: { value: 0 },
      uOccScale: { value: AO_SCALE },
      uFlashOn: { value: 0 },
      uFlashColor: { value: linVec(FLASH_COLOR) },
      uFlashRange: { value: FLASH_RANGE },
      uFlashIntensity: { value: FLASH_INTENSITY },
      uFlashCosInner: { value: FLASH_COS_INNER },
      uFlashCosOuter: { value: FLASH_COS_OUTER },
      uFlashBounce: { value: 0 },
      uTorchSize: { value: 0.02 },
      uFlashTaps: { value: 9 },
      uFlashBlockerTaps: { value: 0 },
      // Read only by the PCSS build: its blocker target, else "no blocker"
      // (never the comparison-mode depth texture; see _flashDepthNone).
      tFlashDepth: { value: this._flashDepthNone },
      ...this.flashUniforms,
      uVplOn: { value: 0 },
      uVplPosW: { value: new THREE.Vector3() },
      uVplN: { value: new THREE.Vector3(0, 1, 0) },
      uVplColor: { value: new THREE.Vector3() },
      uVplOccl: { value: 0 },
      uCapGroups: { value: 0 },
      uCapN: { value: new Int32Array(CAPSULE_ENEMIES_MAX) },
      uCapA: { value: v4(CAPSULE_MAX) },
      uCapB: { value: v4(CAPSULE_MAX) },
      uCapBound: { value: v4(CAPSULE_ENEMIES_MAX) },
      uFogColor: { value: linVec(FOG_COLOR) },
      uFogDensity: { value: FOG_DENSITY },
      uLightDebug: { value: 0 },
      ...this.gridUniforms,
    }
    this.lightQuad = new FullScreenQuad(fsMaterial(lightingFrag(), this.lightUniforms))
  }

  _initVolumetrics(dw, dh) {
    const { w: vw, h: vh } = this._halfRes(dw, dh, VOL_SCALE)
    this.volRT = new THREE.WebGLRenderTarget(vw, vh, HALF_RT_OPTS)
    // Blur intermediate: same storage class and scale as bloom's horizontal
    // pass, and the two never overlap in the frame, so they share one target.
    this.volBlurTmpRT = this._effectScratch(dw, dh, VOL_SCALE, 'hdr')
    const L = this.lightUniforms
    this.volUniforms = {
      tDepth: { value: this.depthTex },
      tLampData: { value: this.lampData },
      uProj: { value: new THREE.Matrix4() },
      uProjInverse: { value: new THREE.Matrix4() },
      uCamToWorld: this.cameraUniforms.uCamToWorld,
      uUpView: this.cameraUniforms.uUpView,
      uLampCount: this.visibleLamps.uLampCount,
      // Share the lit pass's lamp color + flicker value-objects so shafts
      // track the lamps (family palette, LightTool edits, flicker dip). The
      // shaft intensities stay in their own objects: the physical look scales
      // the lit pass's fixture power, which must not multiply the in-scatter.
      uLampColor: L.uLampColor,
      uLampIntensity: { value: LIGHT_INTENSITY },
      uLampFlicker: L.uLampFlicker,
      uLampRange: { value: LIGHT_RANGE },
      uSteps: { value: VOL_STEPS },
      uNearSteps: { value: 12 },
      uMaxLights: { value: VOL_LIGHT_MAX },
      uTraceLights: { value: 0 },
      uTraceEvery: { value: 2 },
      uTraceDist: { value: 0 },
      uFlashEvery: { value: 1 },
      uScale: { value: VOL_SCALE },
      uDensity: { value: VOL_DENSITY },
      uMaxDist: { value: VOL_MAXDIST },
      uPhaseG: { value: VOL_PHASE_G },
      // Shared with the lit pass so the shafts sink into the same haze (and
      // track live LightTool fog edits).
      uFogDensity: L.uFogDensity,
      uVolEmit: { value: 0 },
      uEmitFloor: L.uEmitFloor,
      uEmitPow: L.uEmitPow,
      uFlashOn: L.uFlashOn,
      uFlashColor: L.uFlashColor,
      uFlashRange: L.uFlashRange,
      uFlashIntensity: { value: FLASH_INTENSITY },
      uFlashCosInner: L.uFlashCosInner,
      uFlashCosOuter: L.uFlashCosOuter,
      uFlashPhys: { value: 0 },
      uCapGroups: L.uCapGroups,
      uCapN: L.uCapN,
      uCapA: L.uCapA,
      uCapB: L.uCapB,
      uCapBound: L.uCapBound,
      ...this.flashUniforms,
      ...this.gridUniforms,
    }
    // [plain, haze] shaft builds; _applyVolVariant picks one per tier.
    this._volMats = [
      fsMaterial(volFrag({ haze: false }), this.volUniforms),
      fsMaterial(volFrag({ haze: true }), this.volUniforms),
    ]
    this.volQuad = new FullScreenQuad(this._volMats[0])
    this.volBlurUniforms = {
      tVol: { value: this.volRT.texture },
      uDir: { value: new THREE.Vector2(1, 0) },
    }
    this.volBlurQuad = new FullScreenQuad(fsMaterial(VOL_BLUR_FRAG, this.volBlurUniforms))
    this.volBlur = false
  }

  _initBloom(dw, dh) {
    const { w: bw, h: bh } = this._halfRes(dw, dh, BLOOM_SCALE)
    this.bloomPreRT = new THREE.WebGLRenderTarget(bw, bh, HALF_RT_OPTS)
    this.bloomTmpRT = this._effectScratch(dw, dh, BLOOM_SCALE, 'hdr')
    this.bloomRT = new THREE.WebGLRenderTarget(bw, bh, HALF_RT_OPTS)
    // Wide veil: the tight halo re-blurred at half the bloom scale. Its
    // horizontal intermediate is pooled like the tight one (disjoint lifetime).
    const { w: ww, h: wh } = this._halfRes(dw, dh, BLOOM_SCALE * 0.5)
    this.bloomWideTmpRT = this._effectScratch(dw, dh, BLOOM_SCALE * 0.5, 'hdr')
    this.bloomWideRT = new THREE.WebGLRenderTarget(ww, wh, HALF_RT_OPTS)
    this._bloomWideTexel = new THREE.Vector2(1 / ww, 1 / wh)
    // Tail (chapter 14 P20): the veil re-blurred at an eighth of the bloom
    // scale, high/ultra only — the long soft glare a camera lens adds.
    const { w: tw, h: th } = this._halfRes(dw, dh, BLOOM_SCALE / 8)
    this.bloomTailTmpRT = this._effectScratch(dw, dh, BLOOM_SCALE / 8, 'hdr')
    this.bloomTailRT = new THREE.WebGLRenderTarget(tw, th, HALF_RT_OPTS)
    this._bloomTailTexel = new THREE.Vector2(1 / tw, 1 / th)
    this.bloomTail = false
    this.bloomPreUniforms = {
      tLit: { value: this.litRT.texture },
      tColor: { value: this.gColor },
      tDepth: { value: this.depthTex },
      uThreshold: { value: BLOOM_THRESHOLD },
      uKnee: { value: BLOOM_KNEE },
      uSurface: { value: BLOOM_SURFACE },
      uClamp: { value: 0 },
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
    this.sceneRT = new THREE.WebGLRenderTarget(dw, dh, HDR_RT_OPTS)
    this.compositeUniforms = {
      tInput: { value: this.litRT.texture },
      tVol: { value: this.volRT.texture },
      tBloom: { value: this.bloomRT.texture },
      tBloomWide: { value: this.bloomWideRT.texture },
      tBloomTail: { value: this.bloomTailRT.texture },
      tDepth: { value: this.depthTex },
      uProjInverse: { value: new THREE.Matrix4() },
      uVolScale: { value: VOL_SCALE },
      uVolIntensity: { value: VOL_INTENSITY },
      uBloomIntensity: { value: BLOOM_INTENSITY },
      uBloomWide: { value: BLOOM_WIDE_INTENSITY },
      uBloomTail: { value: 0 },
      uHalation: { value: new THREE.Vector4(1, 1, 1, 0) },
    }
    this.compositeQuad = new FullScreenQuad(fsMaterial(COMPOSITE_FRAG, this.compositeUniforms))
  }

  _initOutline(dw, dh) {
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
      uInkTint: { value: OUTLINE_INK_TINT },
      uInkOpacity: { value: OUTLINE_OPACITY },
    }
    this.outlineQuad = new FullScreenQuad(fsMaterial(OUTLINE_FRAG, this.outlineUniforms))
  }

  _initGrade(dw, dh) {
    this.gradeRT = new THREE.WebGLRenderTarget(dw, dh, LDR_RT_OPTS) // LDR sRGB for FXAA input
    this.gradeUniforms = {
      // Outline reuses litRT after bloom/composite have consumed the lit image.
      tDiffuse: { value: this.litRT.texture },
      tExposure: { value: null },
      time: { value: 0 },
      levels: { value: GRADE_LEVELS },
      exposure: { value: GRADE_EXPOSURE }, // pre-tonemap exposure (per family), fixed looks
      exposureRef: { value: GRADE_EXPOSURE },
      autoExposure: { value: 0 },
      toneMapper: { value: 0 },
      sensorNoise: { value: 0 },
      sat: { value: GRADE_SAT }, // post-tonemap saturation
      tint: { value: new THREE.Vector3(GRADE_TINT[0], GRADE_TINT[1], GRADE_TINT[2]) },
      wb: { value: new THREE.Vector3(1, 1, 1) },
      shadowTint: { value: new THREE.Vector3(...GRADE_SHADOW_TINT) },
      highTint: { value: new THREE.Vector3(...GRADE_HIGHLIGHT_TINT) },
      lift: { value: GRADE_LIFT },
      liftColor: { value: new THREE.Vector3(0.6, 0.7, 1.0) },
      // Camera model (chapter 14 P20); identity values reproduce v1.
      hiDesat: { value: 0 },
      knee: { value: 0.8 },
      whiteClip: { value: 1 },
      toe: { value: 0 },
      blackLevel: { value: 0 },
      vigBase: { value: 0 },
      lensK1: { value: 0 },
      lensK2: { value: 0 },
      caK: { value: 0 },
      vignette: { value: 0.18 },
      grain: { value: 0.025 },
      grainK: { value: 1 },
      aberration: { value: 0.0008 },
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

  // Camera stretch passes (chapter 14 P25/P26): the camcorder tape signal
  // (replaces FXAA when its look asks for it) and camera motion blur.
  _initCamera(dw) {
    this.smearRT = new THREE.WebGLRenderTarget(Math.max(1, Math.floor(dw / 4)), 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    })
    this.smearUniforms = { tBloomPre: { value: this.bloomPreRT.texture } }
    this.smearQuad = new FullScreenQuad(fsMaterial(SMEAR_FRAG, this.smearUniforms))
    const { dh } = this._dims()
    this.signalUniforms = {
      tDiffuse: { value: this.gradeRT.texture },
      tSmear: { value: this.smearRT.texture },
      uTexel: { value: new THREE.Vector2(1 / dw, 1 / dh) },
      uAspect: { value: dw / dh },
      uNative: { value: 540 },
      uLumaLines: { value: 330 },
      uChromaLines: { value: 45 },
      uChromaDelay: { value: 2 },
      uSharpen: { value: 0 },
      uTapeNoise: { value: 0 },
      uHeadSwitch: { value: 0 },
      uCcdSmear: { value: 0 },
      uTime: { value: 0 },
      uFrame: { value: 0 },
      uDropout: { value: new THREE.Vector4() },
    }
    this.signalQuad = new FullScreenQuad(fsMaterial(SIGNAL_FRAG, this.signalUniforms))
    this.signalActive = false
    this.signalAccess = { noise: true, fx: true }
    this._dropoutNext = 0
    this.motionUniforms = {
      tScene: { value: this.sceneRT.texture },
      tDepth: { value: this.depthTex },
      uProjInverse: { value: new THREE.Matrix4() },
      uCamToWorld: this.cameraUniforms.uCamToWorld,
      uPrevViewProj: { value: new THREE.Matrix4() },
      uBlur: { value: 0 },
    }
    this.motionQuad = new FullScreenQuad(fsMaterial(MOTION_BLUR_FRAG, this.motionUniforms))
    this.motionBlurEnabled = false // user setting (Settings 'motionBlur')
    this._prevViewProj = new THREE.Matrix4()
    this._prevCamPos = new THREE.Vector3(Infinity, 0, 0)
    this._prevCamDir = new THREE.Vector3()
    this._camDir = new THREE.Vector3()
    this._viewProj = new THREE.Matrix4()
  }

  // Accessibility gates for the camera noise: NOISE 'off' removes the look's
  // animated sensor noise (grade) and the tape signal's noise, dropouts and
  // head switching; CAMERA FX off removes head switching and dropouts.
  setSignalAccess({ noise = true, fx = true } = {}) {
    this.signalAccess = { noise, fx }
    if (this.look) this._applySignalLook()
  }

  setMotionBlur(on) {
    this.motionBlurEnabled = !!on
  }

  get motionBlurActive() {
    const tierOk = this.quality ? this.quality.shadow.tier !== 'low' && this.quality.shadow.tier !== 'off' : true
    return this.motionBlurEnabled && this.cameraFx !== false && (this.look?.motion.blur ?? 0) > 0 && tierOk
  }

  _applySignalLook() {
    const sig = this.look.signal
    const su = this.signalUniforms
    const { noise, fx } = this.signalAccess
    this.gradeUniforms.sensorNoise.value = noise ? this.look.sensorNoise : 0
    this.signalActive = !!sig.enabled
    su.uNative.value = sig.native
    su.uLumaLines.value = sig.lumaLines
    su.uChromaLines.value = sig.chromaLines
    su.uChromaDelay.value = sig.chromaDelay
    su.uSharpen.value = sig.sharpen
    su.uTapeNoise.value = noise ? sig.tapeNoise : 0
    su.uHeadSwitch.value = noise && fx ? sig.headSwitch : 0
    su.uCcdSmear.value = sig.ccdSmear
    this._dropoutRate = noise && fx ? sig.dropouts : 0
  }

  _renderSignal(time) {
    const r = this.renderer
    r.setRenderTarget(this.smearRT)
    this.smearQuad.render(r)
    const su = this.signalUniforms
    su.uTime.value = time % GRADE_TIME_WRAP
    su.uFrame.value = (su.uFrame.value + 1) % 4096
    // Dropouts: Poisson at <= 0.1/s, one frame each.
    const d = su.uDropout.value
    d.w = 0
    if (this._dropoutRate > 0 && time >= this._dropoutNext) {
      if (this._dropoutNext > 0) d.set(Math.random() * 0.8, Math.random(), 0.02 + Math.random() * 0.05, 1)
      this._dropoutNext = time + -Math.log(1 - Math.random()) / Math.min(this._dropoutRate, 0.1)
    }
    r.setRenderTarget(null)
    this.signalQuad.render(r)
  }

  // Camera motion blur in HDR: sceneRT -> litRT (dead after composite,
  // except in a lit-probe frame, which skips this pass).
  _renderMotionBlur() {
    const mu = this.motionUniforms
    mu.uProjInverse.value.copy(this._projInv)
    mu.uPrevViewProj.value.copy(this._prevViewProj)
    mu.uBlur.value = this.look.motion.blur
    this.renderer.setRenderTarget(this.litRT)
    this.motionQuad.render(this.renderer)
    return this.litRT.texture
  }

  // History for the reprojection: a teleport, respawn or snap turn resets it
  // (no smear frame after a discontinuity).
  _updateMotionHistory() {
    const cam = this.camera
    this._viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    const pos = this._lampViewScratch.setFromMatrixPosition(cam.matrixWorld)
    cam.getWorldDirection?.(this._camDir)
    const jump = pos.distanceTo(this._prevCamPos) > 1.5 || this._camDir.dot(this._prevCamDir) < 0.5
    this._motionValid = !jump
    this._prevCamPos.copy(pos)
    this._prevCamDir.copy(this._camDir)
  }

  _initDebug() {
    // Debug channel viewer (dev only). Binds the RT textures once; they survive
    // setSize (the RT keeps the same texture object), so no resize plumbing.
    this.debugView = 0
    this.debugViewUniforms = {
      uMode: { value: 0 },
      tColor: { value: this.gColor },
      tNormal: { value: this.gNormal },
      tMaterial: { value: this.gMaterial },
      tDepth: { value: this.depthTex },
      tAO: { value: this.aoBlurRT.texture },
      tLit: { value: this.litRT.texture },
      tVol: { value: this.volRT.texture },
      tBloom: { value: this.bloomRT.texture },
      tScene: { value: this.sceneRT.texture },
      tShadow: { value: this.shadowBlurRT.texture },
      uProjInverse: { value: new THREE.Matrix4() },
      uDepthScale: { value: 1 / FAR },
    }
    this.debugQuad = new FullScreenQuad(fsMaterial(DEBUG_VIEW_FRAG, this.debugViewUniforms))
  }

  // --- Evidence probes (chapter 14 P1) ------------------------------------
  // Read float values of a pipeline target at up to PROBE_MAX points after
  // rendering one frame. points: [{ px: [x, y] }] in full-resolution pixels
  // (y up, gl_FragCoord convention) or [{ world: [x, y, z] }], projected with
  // the live camera and flagged `occluded` when the depth buffer lies more
  // than 2 cm in front of them. source: 'lit' | 'occ' | 'contact' | 'vol' |
  // 'scene'. Stalls the GPU: debug and capture tooling only.
  probe(points, { source = 'lit', time } = {}) {
    const r = this.renderer
    if (typeof r.readRenderTargetPixels !== 'function') return []
    if (!this._probeRT) {
      this._probeRT = new THREE.WebGLRenderTarget(PROBE_MAX, 2, {
        type: THREE.FloatType,
        depthBuffer: false,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
      })
      this._probeUniforms = {
        tSrc: { value: null },
        tDepth: { value: this.depthTex },
        uProjInverse: { value: new THREE.Matrix4() },
        uPx: { value: Array.from({ length: PROBE_MAX }, () => new THREE.Vector2()) },
        uSrcScale: { value: 1 },
        uCount: { value: 0 },
      }
      this._probeQuad = new FullScreenQuad(fsMaterial(PROBE_FRAG, this._probeUniforms))
      this._probeBuf = new Float32Array(PROBE_MAX * 2 * 4)
    }
    const W = this.gBuffer.width
    const H = this.gBuffer.height
    const cam = this.camera
    const v = new THREE.Vector3()
    const pts = points.slice(0, PROBE_MAX).map((p) => {
      if (p.px) return { px: [p.px[0], p.px[1]], viewZ: null }
      v.set(p.world[0], p.world[1], p.world[2]).applyMatrix4(cam.matrixWorldInverse)
      const viewZ = v.z
      v.applyMatrix4(cam.projectionMatrix)
      return { px: [(v.x * 0.5 + 0.5) * W, (v.y * 0.5 + 0.5) * H], viewZ, behind: viewZ >= 0 }
    })
    // Unknown sources read litRT, so they count as 'lit' for the frame guards.
    const read = ['occ', 'contact', 'vol', 'scene'].includes(source) ? source : 'lit'
    this._probeRequest = { pts, source: read }
    this.render(time ?? this._lastTime ?? 0)
    const src = {
      lit: [this.litRT.texture, 1],
      occ: [this.lightUniforms.tOcc.value, this.lightUniforms.uOccScale.value],
      contact: [this.lightUniforms.tContact.value, this.lightUniforms.uOccScale.value],
      vol: [this.volRT.texture, VOL_SCALE],
      scene: [this.sceneRT.texture, 1],
    }[read]
    // The frame just rendered left every target valid: the post passes that
    // reuse litRT (the Classic outline, camera motion blur) skip a lit-probe
    // frame (_litProbe).
    const pu = this._probeUniforms
    pu.tSrc.value = src[0]
    pu.uSrcScale.value = src[1]
    pu.uProjInverse.value.copy(this._projInv)
    pu.uCount.value = pts.length
    pts.forEach((p, i) => pu.uPx.value[i].set(p.px[0], p.px[1]))
    r.setRenderTarget(this._probeRT)
    this._probeQuad.render(r)
    r.readRenderTargetPixels(this._probeRT, 0, 0, PROBE_MAX, 2, this._probeBuf)
    r.setRenderTarget(null)
    this._probeRequest = null
    const b = this._probeBuf
    return pts.map((p, i) => {
      const o = i * 4
      const q = (PROBE_MAX + i) * 4
      const rgb = [b[o], b[o + 1], b[o + 2]]
      return {
        px: p.px,
        rgb,
        a: b[o + 3],
        lum: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2],
        view: [b[q], b[q + 1], b[q + 2]],
        depth: b[q + 3],
        occluded: p.viewZ !== null ? p.behind || b[q + 2] > p.viewZ + 0.02 : false,
      }
    })
  }

  // 0 disables; 1..13 blit a pipeline channel to screen (see DEBUG_VIEW_FRAG).
  setDebugView(mode) {
    this.debugView = mode | 0
  }

  // Lighting diagnostics written by the lighting pass itself (see
  // lighting.js uLightDebug); view them through the 'lit' channel.
  setLightDebug(mode) {
    this.lightUniforms.uLightDebug.value = mode | 0
  }

  _dims() {
    const pr = this.renderer.getPixelRatio()
    const size = this.renderer.getSize(new THREE.Vector2())
    return { dw: Math.max(1, Math.floor(size.x * pr)), dh: Math.max(1, Math.floor(size.y * pr)) }
  }

  // User setting; the active look can also switch the ink off.
  setOutline(on) {
    this.outlineEnabled = on
  }

  get outlineActive() {
    return this.outlineEnabled && this.look.outline !== false
  }

  // No args: dimensions come from the renderer (size * pixelRatio) via _dims(),
  // which Engine updates (setSize + setPixelRatio) before calling this.
  setSize() {
    const { dw, dh } = this._dims()
    // Every target below reallocates its storage, so nothing retains an
    // identity fill across the resize.
    this._identityRT.clear()
    this.gBuffer.setSize(dw, dh)
    this.litRT.setSize(dw, dh)
    for (const scaledPool of this._effectScratchRTs.values()) {
      for (const [scale, rt] of scaledPool) {
        const scratch = this._halfRes(dw, dh, scale)
        rt.setSize(scratch.w, scratch.h)
      }
    }
    const ao = this._halfRes(dw, dh, AO_SCALE)
    this.aoBlurRT.setSize(ao.w, ao.h)
    this.aoRawRT.setSize(ao.w, ao.h)
    this.contactRawRT.setSize(ao.w, ao.h)
    this.occRT.setSize(ao.w, ao.h)
    this.aoBlurUniforms.uTexel.value.set(1 / ao.w, 1 / ao.h)
    const sh = this._halfRes(dw, dh, SHADOW_SCALE)
    this.shadowBlurRT.setSize(sh.w, sh.h)
    this.shadowBlurUniforms.uTexel.value.set(1 / sh.w, 1 / sh.h)
    const vol = this._halfRes(dw, dh, VOL_SCALE)
    this.volRT.setSize(vol.w, vol.h)
    const b = this._halfRes(dw, dh, BLOOM_SCALE)
    this.bloomPreRT.setSize(b.w, b.h)
    this.bloomRT.setSize(b.w, b.h)
    this._bloomTexel.set(1 / b.w, 1 / b.h)
    const bw = this._halfRes(dw, dh, BLOOM_SCALE * 0.5)
    this.bloomWideRT.setSize(bw.w, bw.h)
    this._bloomWideTexel.set(1 / bw.w, 1 / bw.h)
    const bt = this._halfRes(dw, dh, BLOOM_SCALE / 8)
    this.bloomTailRT.setSize(bt.w, bt.h)
    this._bloomTailTexel.set(1 / bt.w, 1 / bt.h)
    this.sceneRT.setSize(dw, dh)
    this.gradeRT.setSize(dw, dh)
    this.outlineUniforms.uTexel.value.set(1 / dw, 1 / dh)
    this.fxaaUniforms.uTexel.value.set(1 / dw, 1 / dh)
    this.signalUniforms.uTexel.value.set(1 / dw, 1 / dh)
    this.signalUniforms.uAspect.value = dw / dh
    this.smearRT.setSize(Math.max(1, Math.floor(dw / 4)), 1)
  }

  // --- per-frame stages ----------------------------------------------------

  // Per-frame shared work done once, before the passes: invert the projection,
  // frustum-cull source lamp influence spheres, and compact the survivors into
  // renderer-local view-space arrays (mirrored into tLampData). All passes
  // consume that one derived set.
  //
  // Compaction is stable (source order is nearest-first), and never mutates the
  // source arrays, so shadow/volumetric head budgets keep their meaning and a
  // culled lamp can reappear immediately when the camera turns. Derived
  // uLampChar.w folds raw flicker × set-edge fade; computing it here gives all
  // passes exactly the same faded weight. Must run every frame because both the
  // view transform and frustum change with the camera.
  _updateFrame() {
    const cam = this.camera
    this._projInv.copy(cam.projectionMatrix).invert()
    const view = cam.matrixWorldInverse
    const source = this.lamps
    const visible = this.visibleLamps
    const world = source.uLampPos.value
    const sourceChar = source.uLampChar.value
    const viewPos = visible.uLampViewPos.value
    const visibleChar = visible.uLampChar.value
    const raw = source.lampFlickerRaw
    const n = Math.min(source.uLampCount.value, world.length)
    // Fade against where the uploaded set ACTUALLY ends (LightField.cutoffR),
    // not against LAMP_QUERY_R. Infinity (LightRoom's authored set) yields no
    // fade at all.
    const cutoff = source.cutoffR ?? LAMP_QUERY_R
    const fadeBand = Math.min(LAMP_FADE_BAND, cutoff * 0.25)
    const fade0 = cutoff - fadeBand
    // Cull against the maximum pass range so no pass loses an influence that
    // can reach the viewport (the lit pass reaches SPEC_REACH x its range for
    // glossy highlights).
    this._lampSphere.radius =
      Math.max(
        0,
        this.lightUniforms.uLampRange.value * SPEC_REACH,
        this.shadowUniforms.uLampRange.value,
        this.volUniforms.uLampRange.value,
      ) + LAMP_FRUSTUM_EPSILON
    this._lampFrustum.setFromProjectionMatrix(cam.projectionMatrix)
    let visibleCount = 0
    for (let i = 0; i < n; i++) {
      const v = this._lampViewScratch.copy(world[i]).applyMatrix4(view)
      this._lampSphere.center.copy(v)
      if (!this._lampFrustum.intersectsSphere(this._lampSphere)) continue
      viewPos[visibleCount].copy(v)
      // 1 - smoothstep(fade0, cutoff, cameraDist): lamps ramp to zero over the
      // last fadeBand units before the set's real edge, so LightField set churn
      // is invisible (see render-coupling.test.js).
      let t = (v.length() - fade0) / fadeBand
      t = t < 0 ? 0 : t > 1 ? 1 : t
      visibleChar[visibleCount]
        .copy(sourceChar[i])
        .setComponent(3, raw[i] * (1 - t * t * (3 - 2 * t)))
      visibleCount++
    }
    visible.uLampCount.value = visibleCount
    packLampData(this.lampData, viewPos, visibleChar, visibleCount)

    const cu = this.cameraUniforms
    cu.uCamToWorld.value.copy(cam.matrixWorld)
    cu.uWorldToCam.value.copy(view)
    cu.uCamPosW.value.setFromMatrixPosition(cam.matrixWorld)

    cu.uUpView.value.set(0, 1, 0).transformDirection(view)

    const gridOn = this.gridActive
    this.gridUniforms.uGridOn.value = gridOn ? 1 : 0
    if (gridOn) this.grid.sync()
    // Capsules shade grid and legacy pixels alike (v1: grid only).
    this.lightUniforms.uCapGroups.value = this._capGroups
  }

  _renderGBuffer() {
    const r = this.renderer
    const { scene, camera } = this
    const prevBg = scene.background
    scene.background = null
    r.setRenderTarget(this.gBuffer)
    try {
      r.render(scene, camera)
    } finally {
      scene.background = prevBg
    }
  }

  // Flashlight spot shadow map (only while the torch is on).
  _renderFlashShadow() {
    this.flashShadow.update(this.renderer, this.scene, this.camera, this.casterRevision)
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
    const lu = this.lightUniforms
    lu.uProjInverse.value.copy(this._projInv)
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

  // --- occlusion v2 passes ---------------------------------------------------
  _renderGTAO() {
    const r = this.renderer
    const gu = this.gtaoUniforms
    gu.uProjInverse.value.copy(this._projInv)
    gu.uProjScale.value = 0.5 * this.gBuffer.height * this.camera.projectionMatrix.elements[5]
    r.setRenderTarget(this.aoRawRT)
    this.gtaoQuad.render(r)
  }

  _renderContact() {
    const r = this.renderer
    const cu = this.contactUniforms
    cu.uProj.value.copy(this.camera.projectionMatrix)
    cu.uProjInverse.value.copy(this._projInv)
    r.setRenderTarget(this.contactRawRT)
    this.contactQuad.render(r)
  }

  _renderOccResolve() {
    const r = this.renderer
    this.occResolveUniforms.uProjInverse.value.copy(this._projInv)
    r.setRenderTarget(this.occRT)
    this.occResolveQuad.render(r)
  }

  _renderExposure(dt) {
    this.exposure.update(this.renderer, dt)
    this.gradeUniforms.tExposure.value = this.exposure.texture
  }

  _renderVolumetrics() {
    const r = this.renderer
    const cam = this.camera
    const vu = this.volUniforms
    vu.uProj.value.copy(cam.projectionMatrix)
    vu.uProjInverse.value.copy(this._projInv)
    r.setRenderTarget(this.volRT)
    this.volQuad.render(r)
    if (!this.volBlur) return
    // Depth-aware separable blur (high/ultra) through the shared scratch.
    const bu = this.volBlurUniforms
    bu.tVol.value = this.volRT.texture
    bu.uDir.value.set(1, 0)
    r.setRenderTarget(this.volBlurTmpRT)
    this.volBlurQuad.render(r)
    bu.tVol.value = this.volBlurTmpRT.texture
    bu.uDir.value.set(0, 1)
    r.setRenderTarget(this.volRT)
    this.volBlurQuad.render(r)
  }

  _renderBloomPrefilter() {
    this.renderer.setRenderTarget(this.bloomPreRT)
    this.bloomPreQuad.render(this.renderer)
  }

  _renderBloom() {
    const r = this.renderer
    this._renderBloomPrefilter()
    const bb = this.bloomBlurUniforms
    bb.tInput.value = this.bloomPreRT.texture
    bb.uDir.value.set(this._bloomTexel.x * BLOOM_SPREAD, 0)
    r.setRenderTarget(this.bloomTmpRT)
    this.bloomBlurQuad.render(r)
    bb.tInput.value = this.bloomTmpRT.texture
    bb.uDir.value.set(0, this._bloomTexel.y * BLOOM_SPREAD)
    r.setRenderTarget(this.bloomRT)
    this.bloomBlurQuad.render(r)
    // Wide veil: blur the finished tight halo again at half its resolution.
    // Separable Gaussians compose, so this is a far wider kernel for the price
    // of two quarter-res passes.
    bb.tInput.value = this.bloomRT.texture
    bb.uDir.value.set(this._bloomWideTexel.x * BLOOM_WIDE_SPREAD, 0)
    r.setRenderTarget(this.bloomWideTmpRT)
    this.bloomBlurQuad.render(r)
    bb.tInput.value = this.bloomWideTmpRT.texture
    bb.uDir.value.set(0, this._bloomWideTexel.y * BLOOM_WIDE_SPREAD)
    r.setRenderTarget(this.bloomWideRT)
    this.bloomBlurQuad.render(r)
    if (!this.bloomTail) return
    bb.tInput.value = this.bloomWideRT.texture
    bb.uDir.value.set(this._bloomTailTexel.x * BLOOM_WIDE_SPREAD, 0)
    r.setRenderTarget(this.bloomTailTmpRT)
    this.bloomBlurQuad.render(r)
    bb.tInput.value = this.bloomTailTmpRT.texture
    bb.uDir.value.set(0, this._bloomTailTexel.y * BLOOM_WIDE_SPREAD)
    r.setRenderTarget(this.bloomTailRT)
    this.bloomBlurQuad.render(r)
  }

  _composite() {
    this.compositeUniforms.uProjInverse.value.copy(this._projInv)
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

  // A probe frame that reads litRT back (debug only): every post pass that
  // writes litRT after composite (outline, motion blur) skips it.
  get _litProbe() {
    return this._probeRequest?.source === 'lit'
  }

  // Ink outline (off the G-buffer), optional. Returns the texture to grade.
  _renderOutline() {
    if (!this.outlineActive) return this.sceneRT.texture
    if (this._litProbe) return this.sceneRT.texture
    const ou = this.outlineUniforms
    ou.tDiffuse.value = this.sceneRT.texture
    ou.uProjInverse.value.copy(this._projInv) // live camera, matches the G-buffer
    ou.uDepthScale.value = 1 / this.camera.far
    // litRT is dead after bloom + composite. Debug returns before this pass, so
    // its tLit channel still observes the real lighting output.
    this.renderer.setRenderTarget(this.litRT)
    this.outlineQuad.render(this.renderer)
    return this.litRT.texture
  }

  // Grade to `target` — gradeRT when FXAA follows, or straight to screen
  // (null) when FXAA is off and grade is the last pass.
  _renderGrade(time, graded, target) {
    this.gradeUniforms.tDiffuse.value = graded
    // Wrap the grain/static clock (see GRADE_TIME_WRAP): the grade hashes
    // `uv * 1280 + time`, and past an hour the float ULP swamps the noise.
    this.gradeUniforms.time.value = time % GRADE_TIME_WRAP
    this.renderer.setRenderTarget(target)
    this.gradeQuad.render(this.renderer)
  }

  _renderFXAA() {
    this.renderer.setRenderTarget(null)
    this.fxaaQuad.render(this.renderer)
  }

  // Fill a target with a flat color without running its shader — used when a
  // pass is skipped because nothing could contribute (see render()).
  //
  // A skipped pass stays skipped for many frames at a time (a disabled quality
  // tier, an unlit corridor), and the identity value never changes, so re-clearing
  // every frame is pure waste. `_identityRT` remembers the value a target already
  // holds; _runOr drops the entry when the pass actually renders, and setSize()
  // drops all of them because the storage is reallocated.
  // `value` is an sRGB hex (alpha 1), or a LINEAR [r, g, b, a] array for
  // identities the hex path cannot express (it decodes sRGB): the occlusion
  // v2 targets clear to (1, .5, .5, 1) / (1, 1, 1, 1). Alpha must be 1: the
  // renderer premultiplies the clear colour by it, so (1, 1, 1, 0) would land
  // as black. (All-ones contact reads 1 whatever its cell hash.)
  _clearRT(rt, value) {
    const key = Array.isArray(value) ? value.join(',') : value
    if (this._identityRT.get(rt) === key) return
    const r = this.renderer
    const prevColor = r.getClearColor(this._clearScratch)
    const prevAlpha = r.getClearAlpha()
    r.setRenderTarget(rt)
    if (Array.isArray(value)) r.setClearColor(new THREE.Color().setRGB(value[0], value[1], value[2]), value[3])
    else r.setClearColor(value, 1)
    r.clear(true, false, false)
    r.setClearColor(prevColor, prevAlpha)
    this._identityRT.set(rt, key)
  }

  // Run a skippable pass, or fill its output with the identity value the
  // downstream shaders expect. Either way `rt`'s cached state stays truthful, so
  // a pass that stays skipped for many frames is only cleared once.
  _runOr(run, name, method, rt, identityHex) {
    if (!run) return this._clearRT(rt, identityHex)
    this._pass(name, () => method.call(this))
    this._identityRT.delete(rt)
  }

  render(time) {
    const autoClear = this.renderer.autoClear
    const frameTimer = !this.timingEnabled && this.frameTimer?.supported ? this.frameTimer : null
    frameTimer?.begin()
    try {
      // Only the geometry pass needs a clear. Every post pass covers its
      // complete viewport with an opaque fullscreen triangle; clearing those
      // attachments first repeats bandwidth work up to thirteen times/frame.
      this.renderer.autoClear = true
      this._renderFrame(time)
    } finally {
      this.renderer.autoClear = autoClear
      frameTimer?.end()
      if (this.timingEnabled) this.timer.frameEnd()
    }
    if (!this._precompiled) this._precompileFullscreen()
  }

  // Every fullscreen quad except the lighting and shaft passes (which swap
  // materials; see _applyVariants / _applyVolVariant).
  _fixedQuads() {
    return [
      this.aoQuad, this.aoBlurQuad, this.shadowQuad, this.shadowBlurQuad,
      this.gtaoQuad, this.contactQuad, this.occResolveQuad, this.volBlurQuad,
      this.smearQuad, this.signalQuad, this.motionQuad,
      this.bloomPreQuad, this.bloomBlurQuad,
      this.compositeQuad, this.outlineQuad, this.gradeQuad, this.fxaaQuad, this.debugQuad,
    ]
  }

  // After the first frame, link in the background every fullscreen program
  // the current look and tier do not draw yet: the other occlusion path,
  // the camcorder and outline passes, both shaft builds. A later look or
  // tier switch (menus, the auto preset's benchmark, the in-session guard)
  // then finds them linked instead of compiling on the main thread. The
  // lighting build has its own background swap and is not duplicated here.
  _precompileFullscreen() {
    this._precompiled = true
    const r = this.renderer
    if (typeof r.compileAsync !== 'function') return
    const scene = new THREE.Scene()
    const geometry = this.lightQuad._mesh.geometry
    for (const m of [...this._fixedQuads().map((q) => q.material), ...this._volMats]) {
      scene.add(new THREE.Mesh(geometry, m))
    }
    const done = () => {
      this._precompiling = null
    }
    this._precompiling = Promise.resolve()
      .then(() => r.compileAsync(scene, this._fsCamera))
      .then(done, done)
  }

  // Stock MeshStandardMaterial reference (debug light room): forward render
  // into an HDR target, then the SAME grade/FXAA the deferred image gets, at
  // the exposure the deferred frame last adapted to.
  _renderReferenceFrame(time) {
    const r = this.renderer
    const w = this.gBuffer.width
    const h = this.gBuffer.height
    if (!this.refRT) {
      this.refRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true })
    } else if (this.refRT.width !== w || this.refRT.height !== h) {
      this.refRT.setSize(w, h)
    }
    r.autoClear = true
    r.setRenderTarget(this.refRT)
    r.render(this.referenceScene, this.camera)
    r.autoClear = false
    if (this.fxaaEnabled) {
      this._renderGrade(time, this.refRT.texture, this.gradeRT)
      this._renderFXAA()
    } else {
      this._renderGrade(time, this.refRT.texture, null)
    }
  }

  _renderFrame(time) {
    this._frames++
    if (this.timingEnabled) this.timer.frameStart()
    if (this.referenceScene) {
      this._renderReferenceFrame(time)
      return
    }
    const dt = this._lastTime === null ? 0 : Math.max(0, time - this._lastTime)
    this._lastTime = time
    this._ensureFlashTarget()
    this.gridUniforms.uTime.value = time % GRADE_TIME_WRAP
    this._updateFrame() // proj-inverse + stable visible lamp compaction / char.w fold
    this._pass('gbuffer', () => this._renderGBuffer())
    const flashOn = this.lightUniforms.uFlashOn.value > 0.5
    const flashShadow = flashOn && this.flashShadowEnabled && !this.variant?.flashAnalytic
    if (flashShadow) this._pass('flashShadow', () => this._renderFlashShadow())
    this.flashUniforms.uFlashShadowOn.value = flashShadow ? 1 : 0
    this.renderer.autoClear = false
    // A pass can be skipped for two reasons: its quality tier disables it, or
    // its result is provably constant this frame (no lamps -> shadow mask is 1
    // everywhere; no lamps and no flashlight -> shafts are black). Either way
    // the output RT is cleared to the pass's identity value, so downstream
    // shaders read a neutral mask instead of stale frames.
    const lampsLoaded = this.visibleLamps.uLampCount.value > 0 || this.gridActive
    if (this.variant?.occV2) {
      // GTAO + residual contact, denoised together (identity when a tier is
      // off: the resolve always runs so its outputs stay consistent).
      this._runOr(this.aoEnabled, 'gtao', this._renderGTAO, this.aoRawRT, [1, 0.5, 0.5, 1])
      this._runOr(
        this.shadowEnabled && lampsLoaded && this.lightUniforms.uContactChannels.value + this.contactUniforms.uExtra.value > 0,
        'contact', this._renderContact, this.contactRawRT, [1, 1, 1, 1]
      )
      this._pass('occResolve', () => this._renderOccResolve())
    } else {
      this._runOr(this.aoEnabled, 'ssao', this._renderSSAO, this.aoBlurRT, 0xffffff)
      this._runOr(
        this.shadowEnabled && lampsLoaded, 'shadow', this._renderShadow, this.shadowBlurRT, 0xffffff
      )
    }
    this._pass('lighting', () => this._renderLighting())
    if (this.gradeUniforms.autoExposure.value > 0.5) this._pass('exposure', () => this._renderExposure(dt))
    this._runOr(
      this.volEnabled && (lampsLoaded || flashOn), 'volumetric', this._renderVolumetrics,
      this.volRT, 0x000000
    )
    this._runOr(this.bloomEnabled, 'bloom', this._renderBloom, this.bloomRT, 0x000000)
    // The wide veil and the tail are written by the same pass; keep their
    // identities in step.
    if (this.bloomEnabled) this._identityRT.delete(this.bloomWideRT)
    else this._clearRT(this.bloomWideRT, 0x000000)
    if (this.bloomEnabled && this.bloomTail) this._identityRT.delete(this.bloomTailRT)
    else this._clearRT(this.bloomTailRT, 0x000000)
    // The camcorder's CCD smear reads the prefilter too. It is a sensor
    // effect, not bloom: with bloom off the prefilter still runs for it,
    // else the target holds its identity (never the last bloomed frame).
    if (this.bloomEnabled) this._identityRT.delete(this.bloomPreRT)
    else if (this.signalActive && this.signalUniforms.uCcdSmear.value > 0) {
      this._pass('bloomPre', () => this._renderBloomPrefilter())
      this._identityRT.delete(this.bloomPreRT)
    } else this._clearRT(this.bloomPreRT, 0x000000)
    this._pass('composite', () => this._composite())

    // Debug: blit a single pipeline channel to screen, skip grade/FXAA.
    if (this.debugView) {
      this._renderDebug()
      return
    }

    // outline (optional) | motion blur (optional) -> grade -> sRGB -> FXAA
    // or the camcorder signal -> screen (or grade straight to screen when
    // neither follows).
    this._updateMotionHistory()
    let graded = this._pass('outline', () => this._renderOutline())
    // Motion blur writes litRT too; its history above still advances.
    if (graded === this.sceneRT.texture && this.motionBlurActive && this._motionValid && !this._litProbe) {
      graded = this._pass('motionBlur', () => this._renderMotionBlur())
    }
    this._prevViewProj.copy(this._viewProj)
    if (this.signalActive) {
      this._pass('grade', () => this._renderGrade(time, graded, this.gradeRT))
      this._pass('signal', () => this._renderSignal(time))
    } else if (this.fxaaEnabled) {
      this._pass('grade', () => this._renderGrade(time, graded, this.gradeRT))
      this._pass('fxaa', () => this._renderFXAA())
    } else {
      this._pass('grade', () => this._renderGrade(time, graded, null))
    }
  }

  dispose() {
    if (this._disposed) return
    this._disposed = true
    if (this.timer) this.timer.dispose()
    this.timer = null
    this.timingEnabled = false
    this.frameTimer?.dispose()
    this.frameTimer = null
    this.gBuffer.dispose()
    this.litRT.dispose()
    for (const scaledPool of this._effectScratchRTs.values()) {
      for (const rt of scaledPool.values()) rt.dispose()
    }
    this._effectScratchRTs.clear()
    this.aoBlurRT.dispose()
    this.shadowBlurRT.dispose()
    this.aoRawRT.dispose()
    this.contactRawRT.dispose()
    this.occRT.dispose()
    this.volRT.dispose()
    this.bloomPreRT.dispose()
    this.bloomRT.dispose()
    this.bloomWideRT.dispose()
    this.bloomTailRT.dispose()
    this.smearRT.dispose()
    this.sceneRT.dispose()
    this.gradeRT.dispose()
    // FullScreenQuad.dispose() only releases its shared triangle geometry;
    // shader materials have separate ownership and must also be released.
    // Materials three is still polling for readiness are released once the
    // poll settles (disposing them mid-poll throws inside three): an
    // in-flight lighting build disposes itself (_disposed), and the
    // precompiled set waits for its compile.
    this.lightQuad.material.dispose()
    const fixed = [...this._fixedQuads().map((q) => q.material), ...this._volMats]
    const release = () => {
      for (const m of fixed) m.dispose()
    }
    if (this._precompiling) this._precompiling.then(release)
    else release()
    this.lightQuad.dispose()
    this._lightGen++
    this._pendingLightMat = null
    this._resolveLightWaiters()
    this._flashDepthNone.dispose()
    this.exposure.dispose()
    this.flashShadow.dispose()
    this.grid?.dispose()
    this.grid = null
    for (const tex of Object.values(this._gridPlaceholder)) tex.dispose()
    this.lampData.dispose()
    this.refRT?.dispose()
    this._probeRT?.dispose()
    this._probeQuad?.material.dispose()
    this._identityRT.clear()
    this.renderer.domElement?.removeEventListener?.('webglcontextrestored', this._onContextRestored)
  }
}
