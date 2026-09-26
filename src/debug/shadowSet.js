import { CAPTURE_SCHEMA } from './capture.js'

// Replayable shadow evidence set (engine-improvement chapter 14 P1).
//
// A fixed list of poses in the Office seed the chapter-14 work was measured
// on, each with world-space probe points. `runShadowSet(engine)` replays
// every pose (frozen capture), renders a few frames, reads the probes back as
// floats (DeferredRenderer.probe: HDR lit value, occlusion and contact
// channels) and records the GPU pass timings, draw calls, preset, tiers,
// look and device class. The JSON it returns is the evidence record format
// of chapter 07; comparisons between builds, tiers or devices use RATIOS
// between probes (pool profile, under-furniture vs open floor, wall bands),
// because absolute values depend on the device.
//
// Console: await __game.runShadowSet()  (or F2 -> engine -> "run shadow set").

export const SHADOW_SET_SEED = 'engine-improvement'

// pos: [x, z] eye position (floor 0 unless given), yaw/pitch in radians.
export const SHADOW_SET = Object.freeze([
  {
    id: 'office_pool_profile',
    note: 'floor under the lit panel at (13.5, 55.5) and outward: pool centre and half-max radius (see `direct`)',
    camera: { pos: [16.5, 57.5], yaw: Math.atan2(3, 2), pitch: -0.75 },
    probes: [
      [13.5, 0.02, 55.5],
      [13.5, 0.02, 56.5],
      [13.5, 0.02, 57.5],
      [12.5, 0.02, 55.5],
      [11.5, 0.02, 55.5],
      [13.5, 0.02, 54.5],
    ],
  },
  {
    id: 'office_hall',
    note: 'lit office hall with a pier: crease AO at the pier foot, wall scallops',
    camera: { pos: [13.5, 49.5], yaw: -Math.PI / 2, pitch: 0.05 },
    probes: [
      [18.0, 0.02, 49.5],
      [21.0, 0.02, 49.5],
      [24.0, 1.8, 51.0],
      [24.0, 2.9, 51.0],
    ],
  },
  {
    id: 'office_cabinets',
    note: 'free-standing cabinets against a wall: furniture shadows and box AO',
    camera: { pos: [16.5, 12.5], yaw: Math.PI, pitch: -0.35 },
    probes: [
      [16.5, 0.02, 18.0],
      [15.0, 0.02, 18.0],
      [18.0, 0.02, 18.0],
      [16.5, 0.02, 15.0],
    ],
  },
  {
    id: 'office_dark_room',
    note: 'unlit room: GI + dusk-blue ambient floor, readability',
    camera: { pos: [22.5, 22.5], yaw: 0, pitch: -0.2 },
    probes: [
      [22.5, 0.02, 19.5],
      [22.5, 1.5, 17.0],
    ],
  },
  {
    id: 'office_torch',
    note: 'flashlight on at a wall: world-unit bias, filter, bounce light',
    camera: { pos: [13.5, 49.5], yaw: -Math.PI / 2, pitch: -0.1 },
    flashlight: true,
    probes: [
      [16.0, 0.02, 49.5],
      [18.0, 1.0, 49.5],
      [19.0, 0.02, 49.5],
    ],
  },
])

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// The set's clock: fixture hum and the bad-tube strobe are functions of
// time, so a set run at the live clock would measure a different flicker
// phase every run. Pinned, two runs of one build agree to the last digit.
export const SHADOW_SET_TIME = 6

export async function runShadowSet(engine, { frames = 30, time = SHADOW_SET_TIME } = {}) {
  const d = engine.deferred
  const timed = d.setTiming(true)
  const base = engine.capture()
  const poses = []
  for (const pose of SHADOW_SET) {
    const desc = {
      ...base,
      schema: CAPTURE_SCHEMA,
      time,
      world: { family: 'office', seed: SHADOW_SET_SEED, level: 1 },
      // No feet height: the pose stands on the ground under it, never at the
      // height the base capture happened to be taken at.
      camera: { ...base.camera, pos: pose.camera.pos, y: undefined, floor: pose.camera.floor ?? 0, yaw: pose.camera.yaw, pitch: pose.camera.pitch },
      flashlight: !!pose.flashlight,
      // Every enemy out of the scene, so a set run mid-game in this seed
      // measures the same capsule-free frame as one run from the title.
      enemies: (engine.enemies ?? []).map(() => ({ pos: null, active: false, visible: false })),
    }
    engine.applyCapture(desc)
    // A look/tier change in the base capture commits with its lighting build.
    await d.whenLightingReady?.()
    d.resetAdaptation?.()
    d.timer?.resetSamples()
    for (let i = 0; i < frames; i++) {
      d.render(engine._time + i * 0.001)
      await wait(2)
    }
    // Draw calls of one frame (renderer.info accumulates across passes).
    engine.renderer.info.reset()
    d.render(engine._time)
    const calls = engine.renderer.info.render.calls
    const pts = pose.probes.map((w) => ({ world: w }))
    // Direct fixture light alone (lighting debug 3): the pool profile
    // without bounce and ambient.
    d.setLightDebug(3)
    const direct = d.probe(pts, { source: 'lit' })
    d.setLightDebug(0)
    const lit = d.probe(pts, { source: 'lit' })
    const occ = d.probe(pts, { source: 'occ' })
    const contact = d.probe(pts, { source: 'contact' })
    poses.push({
      id: pose.id,
      note: pose.note,
      probes: pose.probes.map((w, i) => ({
        world: w,
        visible: !lit[i].occluded,
        lit: lit[i].rgb.map((v) => +v.toFixed(5)),
        lum: +lit[i].lum.toFixed(5),
        direct: +direct[i].lum.toFixed(5),
        ao: +occ[i].rgb[0].toFixed(4),
        contact: contact[i].rgb.map((v) => +v.toFixed(4)),
      })),
      timings: timed ? d.timer.export() : null,
      calls,
    })
  }
  d.setTiming(false)
  engine.resumeFromCapture()
  return {
    kind: 'shadow-set',
    capture: engine.capture(),
    gpu: engine.gpu ? { cls: engine.gpu.cls, key: engine.gpu.key, autoPreset: engine.gpu.autoPreset } : null,
    capabilities: engine.capabilities ? { maxTextureSize: engine.capabilities.maxTextureSize, parallelCompile: !!engine.capabilities.parallelCompile } : null,
    poses,
  }
}
