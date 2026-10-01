import { IS_TOUCH } from './device.js'
import {
  AO_SAMPLES,
  AO_SAMPLES_MAX,
  CAPSULE_MAX,
  CONTACT_STEPS_MAX,
  FLASH_BLOCKER_TAPS_MAX,
  FLASH_TAPS_MAX,
  FURN_CELLS_MAX,
  FURN_LIGHTS_MAX,
  GTAO_SLICES_MAX,
  GTAO_STEPS_MAX,
  SHADOW_STEPS,
  SHADOW_MAX,
  SHADOW_LAMPS_MAX,
  SHADOW_STEPS_MAX,
  VOL_LIGHTS_MAX,
  VOL_NEAR_STEPS_MAX,
  VOL_STEPS_MAX,
} from '../world/constants.js'
import { RENDER_DETAIL_PROFILE_NAMES } from '../world/renderDetail.js'

// Runtime graphics quality v2 (engine-improvement chapter 14): presets +
// per-feature tiers, resolved into the numbers DeferredRenderer consumes.
//
// Two kinds of knob:
//   * uniform knobs (loop trip counts, caps, radii) switch instantly — the
//     shaders compile against the *_MAX ceilings in world/constants.js;
//   * VARIANT knobs (furniture boxes, the flashlight filter, bent normals,
//     shaft haze...) select a shader build. They change from menus and, on
//     the auto preset, from the benchmark and the in-session guard mid-game,
//     so the renderer never links one on the main thread: the lighting build
//     links in the background and swaps in when ready, and every other
//     fullscreen build is precompiled after the first frame.
//
// Invariants (quality-tiers.test.js):
//   * Tiers remove shadow/occlusion DETAIL, never light energy: every light
//     list entry always shades, and work past a cap falls back to baked,
//     wall-aware visibility. GI, bloom, auto-exposure, the grade, fog, the
//     flashlight cone and shaft and the analytic crease/capsule AO exist on
//     every tier, so the mood is identical from low to ultra.
//   * Gameplay is untouched: no tier changes LightGrid.lightAt, the baked
//     lists, sight culling or enemy perception.
//   * The LOOK chooses strengths, sizes and colours; a tier never changes an
//     art-directed penumbra size or shadow colour.
// World-detail LOD is a separate, explicit knob: it reduces only distant mesh
// batches at fog-coupled boundaries; Ultra preserves silhouettes at every ring.

export const PRESET_ORDER = ['low', 'medium', 'high', 'ultra', 'cinematic']
// 'auto' resolves per device (render/gpuProfile.js); 'custom' pins nothing.
export const PRESET_CHOICES = ['auto', ...PRESET_ORDER, 'custom']
export const TIER_ORDER = ['off', 'low', 'medium', 'high', 'ultra']
export const WORLD_DETAIL_ORDER = RENDER_DETAIL_PROFILE_NAMES
export const tierRank = (t) => Math.max(0, TIER_ORDER.indexOf(t))

// --- World shadows (`shadowQuality`; the UI labels 'off' as MINIMAL) --------
// traced          partial list entries traced per pixel through the grid
//                 (candidates counted in list order, cross-floor ones
//                 included; constant across a cell)
// subRays         emitter sub-segments per trace (ultra: 2)
// crossFloor      trace fixtures one floor away through their slab hole
// furn*           furniture proxy boxes: lights / cell cap / boxes per cell
// capsule*        enemy capsule shadows: lights x capsules per enemy
// contact*        residual screen-space contact: steps / per-light channels /
//                 extra weaker lamps folded into the aggregate channel
// vplOcclusion    flashlight bounce light occluded by walls + capsules
// steps / lamps   the Classic look's legacy full contact march
// 'off' keeps baked wall visibility and one capsule: removing them would
// leak light through walls or unground the enemies.
export const SHADOW_TIERS = Object.freeze({
  off: Object.freeze({
    enabled: false, traced: 0, subRays: 1, crossFloor: false,
    furnLights: 0, furnCells: 0, furnBoxes: 0,
    capsuleLights: 1, capsulesPerEnemy: 1,
    contactSteps: 8, contactChannels: 0, contactExtra: 0,
    vplOcclusion: false, steps: 12, lamps: 4,
  }),
  low: Object.freeze({
    enabled: true, traced: 2, subRays: 1, crossFloor: false,
    furnLights: 1, furnCells: 4, furnBoxes: 1,
    capsuleLights: 2, capsulesPerEnemy: 1,
    contactSteps: 8, contactChannels: 1, contactExtra: 0,
    vplOcclusion: false, steps: 12, lamps: 4,
  }),
  medium: Object.freeze({
    enabled: true, traced: 4, subRays: 1, crossFloor: false,
    furnLights: 2, furnCells: 6, furnBoxes: 2,
    capsuleLights: 4, capsulesPerEnemy: 3,
    contactSteps: 12, contactChannels: 2, contactExtra: 0,
    vplOcclusion: false, steps: 16, lamps: 4,
  }),
  high: Object.freeze({
    enabled: true, traced: 8, subRays: 1, crossFloor: true,
    furnLights: 3, furnCells: 8, furnBoxes: 2,
    capsuleLights: 4, capsulesPerEnemy: 3,
    contactSteps: 16, contactChannels: 2, contactExtra: 2,
    vplOcclusion: true, steps: SHADOW_STEPS, lamps: SHADOW_MAX,
  }),
  ultra: Object.freeze({
    enabled: true, traced: 8, subRays: 2, crossFloor: true,
    furnLights: 4, furnCells: 12, furnBoxes: 2,
    capsuleLights: 8, capsulesPerEnemy: 3,
    contactSteps: 24, contactChannels: 2, contactExtra: 4,
    vplOcclusion: true, steps: 28, lamps: SHADOW_LAMPS_MAX,
  }),
})

// --- Flashlight shadows (`flashShadowQuality`) -------------------------------
// filter 0 = 3x3 hardware PCF, 1 = world-sized Vogel PCF, 2 = PCSS (variant).
// volEvery: the beam's in-scatter samples the map every n-th step.
export const FLASH_TIERS = Object.freeze({
  off: Object.freeze({ enabled: false, size: 512, filter: 0, taps: 9, blockerTaps: 0, volEvery: 2 }),
  low: Object.freeze({ enabled: true, size: 512, filter: 0, taps: 9, blockerTaps: 0, volEvery: 2 }),
  medium: Object.freeze({ enabled: true, size: 512, filter: 1, taps: 6, blockerTaps: 0, volEvery: 1 }),
  high: Object.freeze({ enabled: true, size: 1024, filter: 1, taps: 12, blockerTaps: 0, volEvery: 1 }),
  ultra: Object.freeze({ enabled: true, size: 2048, filter: 2, taps: 16, blockerTaps: 8, volEvery: 1 }),
})

// --- Ambient occlusion (`aoQuality`) ----------------------------------------
// These tiers control screen-space AO only; the analytic crease, box and
// capsule AO run on every tier. `samples` is the Classic look's legacy SSAO.
// boxAOCells: furniture box-AO reach: 1 = the receiver's own cell, 9 = own
//   cell + ring 1 (ring 2 is always beyond box-AO range, >= 2.74 m away).
// giStencil: GI specular uses the 2x2 wall-aware stencil (else own cell).
export const AO_TIERS = Object.freeze({
  off: Object.freeze({
    enabled: false, slices: 1, steps: 4, radius: 0.8, bent: false,
    boxAOCells: 1, giStencil: false, capsuleDir: false, samples: 8,
  }),
  low: Object.freeze({
    enabled: true, slices: 1, steps: 4, radius: 0.6, bent: false,
    boxAOCells: 1, giStencil: false, capsuleDir: false, samples: 8,
  }),
  medium: Object.freeze({
    enabled: true, slices: 2, steps: 4, radius: 0.8, bent: false,
    boxAOCells: 9, giStencil: true, capsuleDir: false, samples: 12,
  }),
  high: Object.freeze({
    enabled: true, slices: 2, steps: 6, radius: 0.8, bent: true,
    boxAOCells: 9, giStencil: true, capsuleDir: false, samples: AO_SAMPLES,
  }),
  ultra: Object.freeze({
    enabled: true, slices: 3, steps: 6, radius: 1.0, bent: true,
    boxAOCells: 9, giStencil: true, capsuleDir: true, samples: AO_SAMPLES_MAX,
  }),
})

// --- Light shafts (`volQuality`) --------------------------------------------
// steps are quadratic-spaced; nearSteps march the flashlight's first 8 m;
// trace* select traced (doorway-shaped) fixture shafts on sparse steps.
export const VOL_TIERS = Object.freeze({
  off: Object.freeze({
    enabled: false, steps: 16, lights: 4, nearSteps: 0,
    traceLights: 0, traceEvery: 2, traceDist: 0, blur: false, haze: false,
  }),
  low: Object.freeze({
    enabled: true, steps: 16, lights: 4, nearSteps: 0,
    traceLights: 0, traceEvery: 2, traceDist: 0, blur: false, haze: false,
  }),
  medium: Object.freeze({
    enabled: true, steps: 24, lights: 6, nearSteps: 8,
    traceLights: 0, traceEvery: 2, traceDist: 0, blur: false, haze: false,
  }),
  high: Object.freeze({
    enabled: true, steps: 32, lights: 8, nearSteps: 12,
    traceLights: 1, traceEvery: 2, traceDist: 12, blur: true, haze: false,
  }),
  ultra: Object.freeze({
    enabled: true, steps: 44, lights: 12, nearSteps: 16,
    traceLights: 2, traceEvery: 2, traceDist: 20, blur: true, haze: true,
  }),
})

// Cinematic (manual only): ultra tiers plus the costs no realtime tier pays.
// The shafts keep ultra's trace on every 2nd step (engine-improvement
// chapter 15): tracing every step cost up to 0.8 ms at 3440x1440 for at
// most 2/255 in the final image. Traced shafts still reach the whole march.
const CINEMATIC = Object.freeze({
  flash: { taps: 24, blockerTaps: 16 },
  vol: { steps: 48, traceDist: 1000 },
})

// Preset -> the individual advanced settings it pins. Selecting a preset
// copies these into the Settings store (so the advanced controls show the
// truth); editing any advanced control afterwards flips the preset to
// 'custom' without touching the others.
export const GRAPHICS_PRESETS = Object.freeze({
  low: Object.freeze({
    renderScale: 0.75, worldDetail: 'low', aoQuality: 'off', shadowQuality: 'low',
    flashShadowQuality: 'low', volQuality: 'off', bloom: true, fxaa: true,
  }),
  medium: Object.freeze({
    renderScale: 1, worldDetail: 'medium', aoQuality: 'low', shadowQuality: 'medium',
    flashShadowQuality: 'medium', volQuality: 'low', bloom: true, fxaa: true,
  }),
  high: Object.freeze({
    renderScale: 1, worldDetail: 'high', aoQuality: 'high', shadowQuality: 'high',
    flashShadowQuality: 'high', volQuality: 'high', bloom: true, fxaa: true,
  }),
  ultra: Object.freeze({
    renderScale: 1, worldDetail: 'ultra', aoQuality: 'ultra', shadowQuality: 'ultra',
    flashShadowQuality: 'ultra', volQuality: 'ultra', bloom: true, fxaa: true,
  }),
  cinematic: Object.freeze({
    renderScale: 1, worldDetail: 'ultra', aoQuality: 'ultra', shadowQuality: 'ultra',
    flashShadowQuality: 'ultra', volQuality: 'ultra', bloom: true, fxaa: true,
  }),
})

// The keys a preset owns (everything above). Engine uses this both to apply a
// preset and to know which setting edits should flip the preset to 'custom'.
export const GRAPHICS_KEYS = Object.freeze(Object.keys(GRAPHICS_PRESETS.high))

// The preset 'auto' stands for until the device is classified: phones ran
// the 'medium' tuning, desktops the 'high' one (DPR is clamped separately by
// device.js MAX_DPR).
export const AUTO_FALLBACK_PRESET = IS_TOUCH ? 'medium' : 'high'
// Fresh installs pick their preset per device (gpuProfile.js).
export const DEFAULT_PRESET = 'auto'

// Concrete preset name for a stored preset value ('auto' -> the device's
// resolved preset, falling back until the device has been classified).
export function concretePreset(preset, autoPreset = null) {
  if (preset === 'auto') return GRAPHICS_PRESETS[autoPreset] ? autoPreset : AUTO_FALLBACK_PRESET
  return GRAPHICS_PRESETS[preset] ? preset : null
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0))

// Resolve the stored settings into the flat quality object the renderer
// consumes. `settings` is anything with a .get(key) (the Settings store).
// Every count is clamped to its shader ceiling here, so a hostile blob can
// never overrun a uniform array or a loop bound.
export function resolveGraphics(settings, { maxTextureSize = 4096 } = {}) {
  const tierName = (table, key, fallback) => (table[settings.get(key)] ? settings.get(key) : fallback)
  const aoTier = tierName(AO_TIERS, 'aoQuality', 'high')
  const shadowTier = tierName(SHADOW_TIERS, 'shadowQuality', 'high')
  const flashTier = tierName(FLASH_TIERS, 'flashShadowQuality', shadowTier)
  const volTier = tierName(VOL_TIERS, 'volQuality', 'high')
  const cinematic = settings.get('preset') === 'cinematic'

  const s = SHADOW_TIERS[shadowTier]
  const shadow = {
    ...s,
    tier: shadowTier,
    traced: clampInt(s.traced, 0, 8),
    subRays: clampInt(s.subRays, 1, 2),
    furnLights: clampInt(s.furnLights, 0, FURN_LIGHTS_MAX),
    furnCells: clampInt(s.furnCells, 0, FURN_CELLS_MAX),
    furnBoxes: clampInt(s.furnBoxes, 0, 2),
    capsuleLights: clampInt(s.capsuleLights, 1, 8),
    capsulesPerEnemy: clampInt(s.capsulesPerEnemy, 1, 3),
    contactSteps: clampInt(s.contactSteps, 1, CONTACT_STEPS_MAX),
    contactChannels: clampInt(s.contactChannels, 0, 2),
    contactExtra: clampInt(s.contactExtra, 0, 6),
    steps: clampInt(s.steps, 1, SHADOW_STEPS_MAX),
    lamps: clampInt(s.lamps, 1, SHADOW_LAMPS_MAX),
  }

  const f = { ...FLASH_TIERS[flashTier], ...(cinematic && flashTier === 'ultra' ? CINEMATIC.flash : null) }
  const flash = {
    ...f,
    tier: flashTier,
    // The map never exceeds what the GPU can allocate (capabilities.js).
    size: Math.min(f.size, Math.max(256, maxTextureSize | 0)),
    taps: clampInt(f.taps, 1, FLASH_TAPS_MAX),
    blockerTaps: clampInt(f.blockerTaps, 0, FLASH_BLOCKER_TAPS_MAX),
  }

  const a = AO_TIERS[aoTier]
  const ao = {
    ...a,
    tier: aoTier,
    slices: clampInt(a.slices, 1, GTAO_SLICES_MAX),
    steps: clampInt(a.steps, 1, GTAO_STEPS_MAX),
    samples: clampInt(a.samples, 1, AO_SAMPLES_MAX),
    boxAOCells: clampInt(a.boxAOCells, 1, FURN_CELLS_MAX),
  }

  const v = { ...VOL_TIERS[volTier], ...(cinematic && volTier === 'ultra' ? CINEMATIC.vol : null) }
  const vol = {
    ...v,
    tier: volTier,
    steps: clampInt(v.steps, 1, VOL_STEPS_MAX),
    lights: clampInt(v.lights, 1, VOL_LIGHTS_MAX),
    nearSteps: clampInt(v.nearSteps, 0, VOL_NEAR_STEPS_MAX),
    traceLights: clampInt(v.traceLights, 0, 2),
    traceEvery: clampInt(v.traceEvery, 1, 4),
  }

  const bloom = settings.get('bloom') !== false
  return {
    renderScale: settings.get('renderScale') ?? 1,
    worldDetail: WORLD_DETAIL_ORDER.includes(settings.get('worldDetail'))
      ? settings.get('worldDetail')
      : 'high',
    cinematic,
    ao,
    shadow,
    flash,
    vol,
    bloom,
    // The eighth-res bloom tail rides the light-shaft tier: both are the
    // "atmosphere" post, and low/medium fold its weight into the wide veil.
    bloomTail: bloom && tierRank(volTier) >= tierRank('high'),
    fxaa: settings.get('fxaa') !== false,
    capsuleMax: CAPSULE_MAX,
  }
}
