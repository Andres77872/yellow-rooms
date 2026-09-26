import * as THREE from 'three'
import { FLASH_COS_OUTER, FLASH_RANGE } from '../world/constants.js'
import { FLASH_HAND_OFFSET, FLASH_NEAR } from './flashFrame.js'

export { FLASH_HAND_OFFSET, FLASH_NEAR }

// Shadowed flashlight (engine-improvement R3 / chapter 12 §4.3, chapter 14
// P2/P15).
//
// The torch used to be an analytic cone at the exact eye position: every
// surface the camera sees is then also directly visible to the light, so it
// could never cast a visible shadow — furniture legs, door jambs and the
// Stalker stood in an unshadowed disc. The emitter now sits in the hand, a
// little right of and below the eye, and renders one spot shadow map per
// frame while the beam is on. Casters are the real scene (walls outside the
// camera view, furniture, enemies) through a depth-only override material,
// sampled with hardware depth comparison in the lighting and volumetric
// passes.
//
// Bias lives in WORLD units in the shaders (normal offset + receiver-plane
// depth gradient sized in texels at the receiver's distance), so this class
// exports the frame the shaders need: fromView (player view -> flashlight
// camera) and params (tan half-fov, 1/size, near, far). The near plane sits
// at 0.2 m — the emitter is always >= 0.3 m from any wall — which buys 2.5x
// depth precision over the old 0.08.
//
// Casters stay FRONT faces: second-depth (back-face) casters were rejected
// because every GLB is an open mesh (a closure audit found boundary edges in
// all enemy and furniture models) and back faces would drop open shells.
//
// PCSS (the ultra filter) needs the blockers' depth through a plain sampler,
// which a comparison-mode depth texture cannot provide: with `pcss` the
// target gains an R16F colour attachment that the depth material fills with
// 1 - window depth (0 = no caster, the clear value).
//
// The hand offset (flashFrame.js) stays shorter than the player's collision
// clearance, so the emitter can never end up behind a wall.

const BIAS = new THREE.Matrix4().set(
  0.5, 0, 0, 0.5,
  0, 0.5, 0, 0.5,
  0, 0, 0.5, 0.5,
  0, 0, 0, 1
)

// Skip thresholds for re-rendering an unchanged map (P15d).
const SKIP_POS = 0.001 // m
const SKIP_DIR = Math.cos(THREE.MathUtils.degToRad(0.02))

export class FlashlightShadow {
  constructor(size = 1024) {
    this.size = 0
    this.pcss = false
    this.target = null
    this.depth = null
    // Cone half-angle plus a margin so the filter kernel never samples
    // outside the map inside the beam.
    const fov = THREE.MathUtils.radToDeg(Math.acos(FLASH_COS_OUTER)) * 2 + 8
    this.camera = new THREE.PerspectiveCamera(fov, 1, FLASH_NEAR, FLASH_RANGE)
    this.material = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking })
    this.material.colorWrite = false
    this.posView = new THREE.Vector3(...FLASH_HAND_OFFSET)
    this.dirView = new THREE.Vector3(0, 0, -1)
    this.viewToShadow = new THREE.Matrix4()
    this.fromView = new THREE.Matrix4()
    this.params = new THREE.Vector4(Math.tan(THREE.MathUtils.degToRad(fov) / 2), 1 / size, FLASH_NEAR, FLASH_RANGE)
    this.texel = new THREE.Vector2(1 / size, 1 / size)
    this._posW = new THREE.Vector3()
    this._dirW = new THREE.Vector3()
    this._up = new THREE.Vector3()
    this._aim = new THREE.Vector3()
    this._lastPos = new THREE.Vector3(Infinity, 0, 0)
    this._lastDir = new THREE.Vector3()
    this._lastRevision = null
    this._clear = new THREE.Color()
    this.stats = { renders: 0, skips: 0 }
    this.setSize(size)
  }

  // (Re)allocate the map. `pcss` adds the blocker-depth colour attachment.
  setSize(size, pcss = this.pcss) {
    size = Math.max(64, size | 0)
    if (size === this.size && !!pcss === this.pcss) return
    this.target?.dispose()
    this.depth?.dispose()
    this.size = size
    this.pcss = !!pcss
    const depth = new THREE.DepthTexture(size, size)
    depth.type = THREE.UnsignedIntType
    depth.compareFunction = THREE.LessEqualCompare
    depth.minFilter = THREE.LinearFilter
    depth.magFilter = THREE.LinearFilter
    this.depth = depth
    // Without PCSS colour is never written (colorWrite false): a single-byte
    // attachment is the cheapest complete framebuffer.
    this.target = new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RedFormat,
      type: this.pcss ? THREE.HalfFloatType : THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      depthTexture: depth,
    })
    this.material.colorWrite = this.pcss
    this.texel.set(1 / size, 1 / size)
    this.params.y = 1 / size
    this._lastRevision = null
  }

  get blockerTexture() {
    return this.pcss ? this.target.texture : null
  }

  // Place the emitter from the player camera and render the caster depth.
  // `scene` is rendered with a depth-only override; frustum culling uses the
  // flashlight's own frustum, so walls behind the player's view still cast.
  // `revision` names the caster set (streamed chunks, GLB swaps, moving
  // enemies in the frustum): when it and the emitter pose are unchanged the
  // previous map is still exact and the render is skipped.
  update(renderer, scene, viewCamera, revision = null) {
    const cam = this.camera
    this._posW.copy(this.posView).applyMatrix4(viewCamera.matrixWorld)
    this._dirW.copy(this.dirView).transformDirection(viewCamera.matrixWorld)
    this._up.set(0, 1, 0).transformDirection(viewCamera.matrixWorld)
    // The view -> shadow matrices depend on the PLAYER camera even when the
    // map itself is reused, so refresh them every frame.
    const still =
      revision !== null &&
      revision === this._lastRevision &&
      this._posW.distanceToSquared(this._lastPos) < SKIP_POS * SKIP_POS &&
      this._dirW.dot(this._lastDir) > SKIP_DIR
    if (!still) {
      cam.position.copy(this._posW)
      cam.up.copy(this._up)
      cam.lookAt(this._aim.copy(this._posW).add(this._dirW))
      cam.updateMatrixWorld(true)
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert()
      const prevOverride = scene.overrideMaterial
      const prevBackground = scene.background
      const prevAutoClear = renderer.autoClear
      const prevAlpha = renderer.getClearAlpha?.() ?? 1
      renderer.getClearColor?.(this._clear)
      scene.overrideMaterial = this.material
      scene.background = null
      try {
        renderer.autoClear = true
        // PCSS reads 1 - depth from colour: clear to 0 = "no blocker".
        if (this.pcss) renderer.setClearColor?.(0x000000, 0)
        renderer.setRenderTarget(this.target)
        renderer.render(scene, cam)
      } finally {
        if (this.pcss) renderer.setClearColor?.(this._clear, prevAlpha)
        scene.overrideMaterial = prevOverride
        scene.background = prevBackground
        renderer.autoClear = prevAutoClear
      }
      this._lastPos.copy(this._posW)
      this._lastDir.copy(this._dirW)
      this._lastRevision = revision
      this.stats.renders++
    } else {
      this.stats.skips++
    }
    // view space of the player camera -> flashlight camera / shadow texture
    this.fromView.copy(cam.matrixWorldInverse).multiply(viewCamera.matrixWorld)
    this.viewToShadow.copy(BIAS).multiply(cam.projectionMatrix).multiply(this.fromView)
    return !still
  }

  // Force the next update to re-render (context restore, resize).
  invalidate() {
    this._lastRevision = null
  }

  dispose() {
    this.target?.dispose()
    this.depth?.dispose()
    this.material.dispose()
    this.target = null
    this.depth = null
  }
}
