import { CEL_HARD, GRADE_HIGHLIGHT_TINT, GRADE_LEVELS, GRADE_SHADOW_TINT } from '../world/constants.js'

// Look profiles (engine-improvement R1 / chapter 12 S1, schema v2 in
// chapter 14).
//
// The illustrative anime treatment (cel ramp, painted terminator, fresnel
// rim, ink outline, posterize, strong split-tone) used to be always on and
// entangled with the lighting maths. A look profile makes every one of those
// levers explicit and independently bypassable, separate from the quality
// presets: quality decides how much work a pass does, the look decides what
// the image is supposed to be. Profiles are versioned data so captures and
// evidence records (chapter 07) can name exactly which look produced them.
//
//   semiRealistic  the default "lived-in horror": GGX materials, emitter-
//                  source fixtures, exact furniture/enemy shadows, crease AO,
//                  AgX, clamped auto-exposure, camera-like sensor noise
//   liminalPhoto   "soft snapshot": wide penumbrae, lifted blacks and
//                  ceiling, warm-grey shadows, slow set-and-forget exposure
//   camcorder      "crushed CCD": hard torch shadows, toe crush into a milky
//                  pedestal, video knee, hunting exposure + white balance
//   classic        the pre-refactor stylised look, kept as a named rollback
//                  (toon ramp, cubic pools, outlines, filmic + posterize)
//   neutral        a reference: physical shading with an ungraded Khronos
//                  PBR Neutral output, for material/exposure comparisons
//
// Schema v2 groups the levers the shadow/style work added:
//   lights  fixture source height, diffuser profile, ceiling lift, panel face
//   shadow  strengths/sizes of every occlusion term + the shadow colour
//   camera  scene-linear white balance, knee/toe/pedestal, lens, bloom tail
//   signal  camcorder tape pass (stretch), motion  camera motion blur
// Tiers never change these values and looks never change tap counts.
//
// The SHADOW COLOUR is art direction: every family is recognised by its
// dusk-blue hemisphere ambient (world/familyPalette.js). Looks keep it
// ('family') unless they explicitly override `shadow.ambientTint`, which
// re-hues the ambient in the lighting pass with its luminance preserved —
// never a post split-tone fighting the blue ambient.

export const LOOK_SCHEMA_VERSION = 2

export const LOOK_CLASSIC = 'classic'
export const LOOK_SEMI_REALISTIC = 'semiRealistic'
export const LOOK_NEUTRAL = 'neutral'
export const LOOK_LIMINAL = 'liminalPhoto'
export const LOOK_CAMCORDER = 'camcorder'
export const LOOK_ORDER = Object.freeze([
  LOOK_SEMI_REALISTIC,
  LOOK_LIMINAL,
  LOOK_CAMCORDER,
  LOOK_CLASSIC,
  LOOK_NEUTRAL,
])
export const DEFAULT_LOOK = LOOK_SEMI_REALISTIC

export const SHADING_TOON = 'toon'
export const SHADING_PBR = 'pbr'
export const ATT_CUBIC = 'cubic'
export const ATT_PHYSICAL = 'physical'
export const TONE_FILMIC = 'filmic' // the custom hue-preserving Narkowicz fit
export const TONE_AGX = 'agx'
export const TONE_NEUTRAL = 'neutral'
export const TONE_VIDEO = 'video' // camcorder knee + hard clip
export const TONE_MAPPERS = Object.freeze([TONE_FILMIC, TONE_AGX, TONE_NEUTRAL, TONE_VIDEO])
export const OCCLUSION_LEGACY = 'legacy' // SSAO + 1.8 m contact march (Classic rollback)
export const OCCLUSION_V2 = 'v2' // GTAO + residual contact + analytic occluders
export const AMBIENT_FAMILY = 'family'

const IDENTITY3 = [1, 1, 1]
const BLUE_LIFT = [0.6, 0.7, 1.0] // the dusk-blue shadow lift (grade.js legacy constant)

function freezeDeep(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') freezeDeep(v)
  return Object.freeze(o)
}

// Shared "off" blocks for looks that do not use a stretch feature.
const SIGNAL_OFF = {
  enabled: false,
  lumaLines: 330,
  chromaLines: 45,
  chromaDelay: 2,
  sharpen: 0,
  tapeNoise: 0,
  headSwitch: 0,
  dropouts: 0,
  ccdSmear: 0,
  native: 540,
}
const MOTION_OFF = { blur: 0, rollingShutter: 0 }

export const LOOK_PROFILES = freezeDeep({
  [LOOK_CLASSIC]: {
    id: LOOK_CLASSIC,
    label: 'Classic',
    version: 2,
    shading: SHADING_TOON,
    attenuation: ATT_CUBIC,
    lampPower: 1, // x LIGHT_INTENSITY
    flashPower: 1, // x FLASH_INTENSITY
    volumetric: 1, // x VOL_INTENSITY (shaft strength in the composite)
    celHard: CEL_HARD, // share of the banded ramp in the painted ramp
    terminator: 1, // x TERMINATOR_STRENGTH
    rim: 1, // x RIM_STRENGTH
    rimLitGate: 0, // 1 = rim scales with local illumination (no glow in darkness)
    entityRim: 1,
    entityFill: 1,
    lampBounce: 1, // legacy unshadowed floor-tinted fill (x LAMP_BOUNCE)
    gi: 0, // cell-graph GI strength
    hemiAmbient: 1, // x family hemisphere ambient
    specular: 1,
    lampAO: 1, // x LAMP_AO_MIX (screen AO on DIRECT light; 0 in the v2 looks)
    outline: true,
    toneMapper: TONE_FILMIC,
    posterize: GRADE_LEVELS, // 0 = explicit bypass (never a division)
    saturation: 1, // x family gradeSat deviation from 1
    tint: 1, // x family gradeTint deviation from 1
    splitTone: 1,
    lift: 1,
    exposure: {
      auto: false,
      key: 0.16,
      minEv: -1,
      maxEv: 1,
      speedUp: 2.2,
      speedDown: 0.9,
      bias: 0,
      meterEmissive: 0, // weight of emissive pixels in the meter (0 = skipped)
      damping: 1, // spring damping ratio (with omega > 0)
      omega: 0, // 0 = the legacy first-order adaptation
      awbStrength: 0, // auto white balance (camera looks)
      awbSpeed: 0,
    },
    bloom: 1,
    bloomWide: 1,
    grain: 1, // x survival-driven grain
    sensorNoise: 0, // exposure-scaled noise (found-footage camera)
    flashBounce: 0,
    lights: {
      sourceDrop: 0.5, // light point below the ceiling (the legacy virtual point)
      emitFloor: 0.25, // diffuser output at grazing (1 straight down)
      emitPow: 1,
      ceilingLift: 0, // GI boost on down-facing surfaces (ceiling tiles)
      panelGlow: 1, // x PANEL_GLOW on the emissive tube
      panelPattern: 0, // procedural troffer face (frame, lens, tubes)
      torchTint: IDENTITY3,
    },
    shadow: {
      contact: 1, // x SHADOW_STRENGTH
      contactLength: 1.8, // screen-space contact march (m)
      furniture: 0, // analytic furniture box shadows
      furnitureAO: 0,
      capsule: 0.88, // enemy capsule shadow strength (legacy 0.12 floor)
      capsuleAO: 0,
      capsuleMinVis: 1,
      selfShadow: 0, // enemy parts shadow each other
      playerBody: 0, // player capsule casts under the fixtures
      creaseAO: 0, // grid architectural crease occlusion
      penumbraScale: 1, // x fixture panel size for every soft shadow
      torchSize: 0.02, // flashlight emitter size (m)
      multiBounce: 0,
      specOcclusion: 0,
      bentNormal: 0,
      ambientTint: AMBIENT_FAMILY,
      ambientTintK: 1,
      occlusionPath: OCCLUSION_LEGACY,
    },
    camera: {
      tintStage: 'post', // family tint after the tone map (legacy)
      whiteBalance: IDENTITY3, // scene-linear, before the tone map
      satAbs: 1,
      highlightDesat: 0,
      knee: 0.8,
      whiteClip: 1,
      toe: 0,
      blackLevel: 0, // display pedestal (milky blacks)
      liftColor: BLUE_LIFT,
      splitShadow: GRADE_SHADOW_TINT,
      splitHigh: GRADE_HIGHLIGHT_TINT,
      lensK1: 0,
      lensK2: 0,
      caK: 0,
      vignetteBase: 0, // optical falloff (the survival vignette is separate)
      bloomTail: 0,
      // Emissive bloom input clamp in HDR units (0 = off). The panel's flat
      // face sits near PANEL_GLOW x panelGlow and its tube bands ~1.3x that,
      // so a clamp just above the flat level flattens the bands and the
      // glare keeps the panel's rectangle; above ~1.36x it never engages.
      bloomClamp: 0,
      halation: [1, 1, 1, 0], // rgb tint + strength on the wide/tail levels
    },
    signal: SIGNAL_OFF,
    motion: MOTION_OFF,
  },
  [LOOK_SEMI_REALISTIC]: {
    id: LOOK_SEMI_REALISTIC,
    label: 'Semi-realistic',
    version: 2,
    shading: SHADING_PBR,
    attenuation: ATT_PHYSICAL,
    // Physical fixtures: I / (d^2 + 0.25) with a Lambert /pi, shaded from the
    // visible emitter 0.46 m above the legacy point: 15x the legacy pool
    // intensity keeps a pool centre where the classic look had it.
    lampPower: 15,
    flashPower: 28,
    volumetric: 0.55,
    celHard: 0,
    terminator: 0,
    rim: 0.2,
    rimLitGate: 1,
    entityRim: 0.45,
    entityFill: 0.55,
    lampBounce: 0,
    gi: 1,
    // The family's dusk ambient stays as a readability floor: unlit rooms
    // are dark, never black (doors, stairs and enemies must stay legible).
    hemiAmbient: 0.65,
    specular: 1,
    lampAO: 0,
    outline: false,
    toneMapper: TONE_AGX,
    posterize: 0,
    saturation: 0.55,
    tint: 0.6,
    splitTone: 0.4,
    lift: 0.25,
    exposure: {
      auto: true,
      key: 0.18,
      minEv: -0.8,
      maxEv: 1.7,
      speedUp: 2.4,
      speedDown: 0.85,
      bias: 0,
      meterEmissive: 0.1,
      damping: 1,
      omega: 0,
      awbStrength: 0,
      awbSpeed: 0,
    },
    bloom: 0.6,
    bloomWide: 0.35,
    grain: 0.6,
    sensorNoise: 0.7,
    flashBounce: 1,
    lights: {
      sourceDrop: 0.04,
      emitFloor: 0.06,
      emitPow: 1,
      ceilingLift: 0.25,
      panelGlow: 2.5,
      panelPattern: 1,
      torchTint: IDENTITY3,
    },
    shadow: {
      contact: 1,
      contactLength: 0.5,
      furniture: 1,
      furnitureAO: 1,
      capsule: 1,
      capsuleAO: 1,
      capsuleMinVis: 0.3,
      selfShadow: 1,
      playerBody: 0,
      creaseAO: 1,
      penumbraScale: 1,
      torchSize: 0.04,
      multiBounce: 1,
      specOcclusion: 1,
      bentNormal: 1,
      ambientTint: AMBIENT_FAMILY,
      ambientTintK: 1,
      occlusionPath: OCCLUSION_V2,
    },
    camera: {
      tintStage: 'scene', // tubes clip toward white instead of tinted
      whiteBalance: IDENTITY3,
      satAbs: 1,
      highlightDesat: 0.5,
      knee: 0.8,
      whiteClip: 1,
      toe: 0,
      blackLevel: 0,
      liftColor: BLUE_LIFT,
      splitShadow: GRADE_SHADOW_TINT, // the cool split that matches the dusk ambient
      splitHigh: GRADE_HIGHLIGHT_TINT,
      lensK1: 0.01,
      lensK2: 0,
      caK: 0.02,
      vignetteBase: 0.1,
      bloomTail: 0.15,
      bloomClamp: 5.0, // 1.18 x the 2.5 panelGlow flat level
      halation: [1, 1, 1, 0],
    },
    signal: SIGNAL_OFF,
    motion: MOTION_OFF,
  },
  [LOOK_LIMINAL]: {
    id: LOOK_LIMINAL,
    label: 'Liminal photo',
    version: 2,
    shading: SHADING_PBR,
    attenuation: ATT_PHYSICAL,
    lampPower: 15,
    flashPower: 26,
    volumetric: 0.4,
    celHard: 0,
    terminator: 0,
    rim: 0.1,
    rimLitGate: 1,
    entityRim: 0.3,
    entityFill: 0.5,
    lampBounce: 0,
    gi: 1,
    hemiAmbient: 0.8,
    specular: 0.9,
    lampAO: 0,
    outline: false,
    toneMapper: TONE_AGX,
    posterize: 0,
    saturation: 0.3,
    tint: 0.4,
    splitTone: 0,
    lift: 0.2,
    exposure: {
      auto: true,
      key: 0.2,
      minEv: -0.5,
      maxEv: 1.0,
      speedUp: 0.4,
      speedDown: 0.6,
      bias: 0,
      meterEmissive: 0.3,
      damping: 1,
      omega: 0,
      awbStrength: 0,
      awbSpeed: 0,
    },
    bloom: 0.5,
    bloomWide: 0.6,
    grain: 0.35,
    sensorNoise: 0.3,
    flashBounce: 1,
    lights: {
      sourceDrop: 0.04,
      emitFloor: 0.12,
      emitPow: 1,
      ceilingLift: 0.8,
      panelGlow: 3,
      panelPattern: 1,
      torchTint: [1, 0.93, 0.8],
    },
    shadow: {
      contact: 0.6,
      contactLength: 0.5,
      furniture: 0.7,
      furnitureAO: 0.6,
      capsule: 0.8,
      capsuleAO: 0.7,
      capsuleMinVis: 0.45,
      selfShadow: 1,
      playerBody: 0,
      creaseAO: 0.6,
      penumbraScale: 1.35,
      torchSize: 0.05,
      multiBounce: 1,
      specOcclusion: 1,
      bentNormal: 1,
      // The one look that departs from the dusk-blue rule: warm-grey
      // shadows, luminance kept (chapter 14 decision 3).
      ambientTint: [0.95, 0.93, 0.88],
      ambientTintK: 0.7,
      occlusionPath: OCCLUSION_V2,
    },
    camera: {
      tintStage: 'scene',
      whiteBalance: [1.0, 1.05, 0.82],
      satAbs: 0.85,
      highlightDesat: 0.6,
      knee: 0.85,
      whiteClip: 0.98,
      toe: 0,
      blackLevel: 0.02,
      liftColor: [1.0, 0.98, 0.92],
      splitShadow: IDENTITY3,
      splitHigh: IDENTITY3,
      lensK1: 0.02,
      lensK2: 0,
      caK: 0.02,
      vignetteBase: 0.1,
      bloomTail: 0.3,
      bloomClamp: 5.6, // 1.1 x the 3.0 panelGlow flat level
      halation: [1.1, 0.95, 0.85, 0.12],
    },
    signal: SIGNAL_OFF,
    motion: MOTION_OFF,
  },
  [LOOK_CAMCORDER]: {
    id: LOOK_CAMCORDER,
    label: "Camcorder '96",
    version: 2,
    shading: SHADING_PBR,
    attenuation: ATT_PHYSICAL,
    lampPower: 15,
    flashPower: 24,
    volumetric: 0.3,
    celHard: 0,
    terminator: 0,
    rim: 0,
    rimLitGate: 1,
    entityRim: 0.2,
    entityFill: 0.35,
    lampBounce: 0,
    gi: 1,
    hemiAmbient: 0.45,
    specular: 0.85,
    lampAO: 0,
    outline: false,
    toneMapper: TONE_VIDEO,
    posterize: 0,
    saturation: 0,
    tint: 0.3,
    splitTone: 0,
    lift: 0,
    exposure: {
      auto: true,
      key: 0.15,
      minEv: -2.0,
      maxEv: 2.5,
      speedUp: 1.4,
      speedDown: 3.2,
      bias: 0,
      meterEmissive: 0.8,
      damping: 0.55,
      omega: 4, // ~0.64 Hz hunting, far under the 3 Hz flash limit
      // Full strength in every normally lit room. The look was first tuned
      // while a normalisation bug scaled 0.5 down to about 0.25 at EV 0.
      awbStrength: 0.3,
      awbSpeed: 0.4,
    },
    bloom: 0.6,
    bloomWide: 0.9,
    grain: 0.2,
    sensorNoise: 1.4,
    flashBounce: 1,
    lights: {
      sourceDrop: 0.04,
      emitFloor: 0.05,
      emitPow: 1.2,
      ceilingLift: 0.15,
      panelGlow: 3.5,
      panelPattern: 1,
      torchTint: [1, 0.8, 0.58], // incandescent
    },
    shadow: {
      contact: 1,
      contactLength: 0.5,
      furniture: 1,
      furnitureAO: 1,
      capsule: 1,
      capsuleAO: 1,
      capsuleMinVis: 0.15,
      selfShadow: 1,
      playerBody: 0,
      creaseAO: 1,
      penumbraScale: 1,
      torchSize: 0.02,
      multiBounce: 1,
      specOcclusion: 1,
      bentNormal: 1,
      ambientTint: AMBIENT_FAMILY,
      ambientTintK: 1,
      occlusionPath: OCCLUSION_V2,
    },
    camera: {
      tintStage: 'scene',
      whiteBalance: [1.08, 1.0, 0.8],
      satAbs: 0.78,
      highlightDesat: 0.9,
      knee: 0.78,
      whiteClip: 0.97,
      toe: 0.08,
      blackLevel: 0.05,
      liftColor: [1.0, 0.98, 0.9],
      splitShadow: IDENTITY3,
      splitHigh: IDENTITY3,
      lensK1: 0.04,
      lensK2: 0,
      caK: 0.06,
      vignetteBase: 0.28,
      bloomTail: 0.35,
      bloomClamp: 6.0, // ~1.0 x the 3.5 panelGlow flat level: a flat slab
      halation: [1, 1, 1, 0],
    },
    signal: {
      enabled: true,
      lumaLines: 330,
      chromaLines: 45,
      chromaDelay: 2,
      sharpen: 0.45,
      tapeNoise: 0.35,
      headSwitch: 0.6,
      dropouts: 0.1,
      ccdSmear: 0.05,
      native: 540,
    },
    motion: { blur: 0.6, rollingShutter: 0 },
  },
  [LOOK_NEUTRAL]: {
    id: LOOK_NEUTRAL,
    label: 'Neutral reference',
    version: 2,
    shading: SHADING_PBR,
    attenuation: ATT_PHYSICAL,
    lampPower: 15,
    flashPower: 28,
    volumetric: 0.4,
    celHard: 0,
    terminator: 0,
    rim: 0,
    rimLitGate: 1,
    entityRim: 0.3,
    entityFill: 0.4,
    lampBounce: 0,
    gi: 1,
    hemiAmbient: 0.5,
    specular: 1,
    lampAO: 0,
    outline: false,
    toneMapper: TONE_NEUTRAL,
    posterize: 0,
    saturation: 0,
    tint: 0,
    splitTone: 0,
    lift: 0,
    exposure: {
      auto: false,
      key: 0.2,
      minEv: 0,
      maxEv: 0,
      speedUp: 2,
      speedDown: 1,
      bias: 0.6,
      meterEmissive: 0,
      damping: 1,
      omega: 0,
      awbStrength: 0,
      awbSpeed: 0,
    },
    bloom: 0.5,
    bloomWide: 0,
    grain: 0,
    sensorNoise: 0,
    flashBounce: 1,
    lights: {
      sourceDrop: 0.04,
      emitFloor: 0.03,
      emitPow: 1,
      ceilingLift: 0,
      panelGlow: 1,
      panelPattern: 1,
      torchTint: IDENTITY3,
    },
    shadow: {
      contact: 1,
      contactLength: 0.5,
      furniture: 1,
      furnitureAO: 1,
      capsule: 1,
      capsuleAO: 1,
      capsuleMinVis: 0,
      selfShadow: 1,
      playerBody: 0,
      creaseAO: 1,
      penumbraScale: 1,
      torchSize: 0.04,
      multiBounce: 1,
      specOcclusion: 1,
      bentNormal: 1,
      ambientTint: AMBIENT_FAMILY,
      ambientTintK: 1,
      occlusionPath: OCCLUSION_V2,
    },
    camera: {
      tintStage: 'scene',
      whiteBalance: IDENTITY3,
      satAbs: 1,
      highlightDesat: 0,
      knee: 0.8,
      whiteClip: 1,
      toe: 0,
      blackLevel: 0,
      liftColor: BLUE_LIFT,
      splitShadow: IDENTITY3,
      splitHigh: IDENTITY3,
      lensK1: 0,
      lensK2: 0,
      caK: 0,
      vignetteBase: 0,
      bloomTail: 0,
      bloomClamp: 0,
      halation: [1, 1, 1, 0],
    },
    signal: SIGNAL_OFF,
    motion: MOTION_OFF,
  },
})

export function resolveLook(id) {
  return LOOK_PROFILES[id] ?? LOOK_PROFILES[DEFAULT_LOOK]
}

export const isLookId = (id) => Object.hasOwn(LOOK_PROFILES, id)
