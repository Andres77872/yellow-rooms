import * as THREE from 'three'
import { EYE_H, WORLD_GEN_VERSION, worldToCell } from '../world/constants.js'
import { groundHeightAt } from '../player/ground.js'
import { GRAPHICS_KEYS } from '../core/graphics.js'
import { GRID_SCHEMA_VERSION } from '../world/lightGrid/gridSpec.js'
import { SURFACE_SCHEMA_VERSION } from '../render/surfaces.js'
import { LOOK_SCHEMA_VERSION } from '../render/lookProfile.js'
import { RENDER_FEATURES } from '../render/renderFeatures.js'

// Deterministic capture/replay descriptor (engine-improvement R0, chapter 07
// "evidence record"). A capture names everything that decides the pixels of
// one frame — world identity (family, seed text, level, generator version),
// camera pose, simulation time, lighting schema versions, look profile,
// quality, render size and renderer revision — so a before/after comparison
// or a device report can be reproduced exactly. Procedural textures are
// seeded (textures.js) and grid flicker is a pure function of time, so a
// frozen replay is pixel-stable apart from GPU/driver differences.
//
// Console: __game.capture() -> JSON-able object; __game.applyCapture(obj)
// rebuilds the world if needed, places the camera and freezes time there.
//
// Schema 2 (chapter 14): enemies (placed and frozen on replay, so shadow
// captures include their capsules), the look's version, the landed render
// features, the resolved per-feature tiers and the GPU class, and the feet
// height (camera.y: on a stair ramp it is anywhere within ~2.8 m of the
// storey base). Schema 1 captures, and captures without camera.y, still
// load: their feet stand on the ground under the pose.

export const CAPTURE_SCHEMA = 2
const SUPPORTED_SCHEMAS = [1, 2]
const ENEMY_KINDS = ['stalker', 'pursuer', 'husk']

export function captureState(engine) {
  const c = engine.controller
  const cam = engine.camera
  const d = engine.deferred
  const r = engine.renderer
  const size = r.getSize?.(new THREE.Vector2()) ?? { x: 0, y: 0 }
  const quality = {}
  for (const k of GRAPHICS_KEYS) quality[k] = engine.settings.get(k)
  return {
    schema: CAPTURE_SCHEMA,
    versions: {
      generator: WORLD_GEN_VERSION,
      grid: GRID_SCHEMA_VERSION,
      surface: SURFACE_SCHEMA_VERSION,
      look: LOOK_SCHEMA_VERSION,
      three: THREE.REVISION,
    },
    world: {
      family: engine.state.mapFamily,
      seed: engine.state.seedText,
      level: engine.state.level,
    },
    camera: {
      pos: [c.pos.x, c.pos.z],
      y: c.pos.y,
      floor: c.floor,
      yaw: c.yaw,
      pitch: c.pitch,
      fov: cam.fov,
    },
    time: engine._time,
    flashlight: !!engine.state.flashlightOn,
    look: d.look?.id ?? null,
    lookVersion: d.look?.version ?? null,
    grid: !!d.gridActive,
    quality,
    preset: engine.settings.get('preset'),
    tiers: d.quality
      ? {
          shadow: d.quality.shadow?.tier ?? null,
          flash: d.quality.flash?.tier ?? null,
          ao: d.quality.ao?.tier ?? null,
          vol: d.quality.vol?.tier ?? null,
        }
      : null,
    variant: d.variant ?? null,
    features: [...RENDER_FEATURES],
    gpu: engine.gpu ? { cls: engine.gpu.cls, autoPreset: engine.gpu.autoPreset } : null,
    enemies: (engine.enemies ?? []).map((e, i) => ({
      kind: ENEMY_KINDS[i] ?? `enemy${i}`,
      pos: e.pos ? [e.pos.x, e.pos.y, e.pos.z] : null,
      yaw: e.mesh?.rotation?.y ?? 0,
      active: !!e.active,
      visible: !!e.mesh?.visible,
      model: e.modelState === 'glb' ? 'glb' : 'fallback',
    })),
    render: { width: size.x, height: size.y, pixelRatio: r.getPixelRatio?.() ?? 1 },
  }
}

// Replay a capture. `freeze` (default) stops the simulation and pins the
// clock so flicker, grain and sensor noise hold still between screenshots.
export function applyCapture(engine, desc, { freeze = true } = {}) {
  if (!desc || !SUPPORTED_SCHEMAS.includes(desc.schema)) throw new Error('unsupported capture schema')
  const { world, camera } = desc
  const state = engine.state
  const sameWorld =
    state.seedText === world.seed && state.mapFamily === world.family && state.level === world.level
  if (!sameWorld) {
    engine.startRun(world.seed, world.family)
    if (world.level > 1) {
      state.level = world.level
      state.resetLevel()
      engine._setupLevel()
    }
  }
  if (desc.look && engine.settings.get('look') !== desc.look) engine._applySetting('look', desc.look)
  const [x, z] = camera.pos
  engine.controller.teleport(x, z, camera.floor, camera.yaw)
  engine.controller.pitch = camera.pitch
  engine.cm.prewarm(x, z, camera.floor)
  // Teleport stands the body on the storey base; the frozen frame never runs
  // the controller's ground snap, so restore the captured feet height.
  const feetY = Number.isFinite(camera.y) ? camera.y : groundHeightAt(engine.cm, x, z, camera.floor)
  engine.controller.pos.y = feetY
  // The same stair-transit visibility live play had there (Engine._tick).
  const transit = engine.cm.stairAt?.(worldToCell(x), worldToCell(z), camera.floor) ?? null
  engine._transitStair = transit
  engine.cm.updateVisibility(camera.floor, transit)
  engine.camera.fov = camera.fov
  engine.camera.updateProjectionMatrix()
  engine.camera.position.set(x, feetY + EYE_H, z)
  engine.camera.rotation.set(camera.pitch, camera.yaw, 0, 'YXZ')
  engine._updateCameraMatrices()
  state.flashlightOn = !!desc.flashlight
  engine.deferred.lightUniforms.uFlashOn.value = state.flashlightOn ? 1 : 0
  engine._time = desc.time
  // Enemies (schema 2): placed and held still by the capture freeze. An
  // entry without a position only sets activity and visibility.
  if (Array.isArray(desc.enemies)) {
    desc.enemies.forEach((e, i) => {
      const enemy = engine.enemies?.[i]
      if (!enemy || !e) return
      enemy.active = !!e.active
      if (e.pos) enemy.pos?.set?.(e.pos[0], e.pos[1], e.pos[2])
      if (enemy.mesh) {
        if (e.pos) enemy.mesh.position.set(e.pos[0], e.pos[1] + (enemy.meshYOffset ?? 0), e.pos[2])
        enemy.mesh.rotation.y = e.yaw ?? 0
        enemy.mesh.visible = !!e.visible
      }
    })
  }
  // Nothing ticks while frozen, so the frame-loop derived state is rebuilt
  // here from the replayed pose, in _tick's order: the capsules always (a
  // capture without enemies must not keep the previous world's), then the
  // torch bounce light, which raycasts against them. The bounce filter is
  // cleared first: an active one would lerp towards the new hit point with
  // weight 0 at dt = 0 and keep the pre-replay position and colour.
  engine._updateOccluders?.()
  if (engine.torchBounce) engine.torchBounce.active = false
  engine._updateTorch?.(0)
  engine._refreshLamps()
  engine.deferred.resetAdaptation()
  engine.captureFrozen = !!freeze
  return desc
}
