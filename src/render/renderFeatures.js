// Render features that have landed (engine-improvement chapter 14), and which
// look-profile fields each one consumes.
//
// The look schema v2 grew many levers at once. A lever whose value differs
// between looks is only meaningful once the feature reading it exists:
// LOOK_FIELD_FEATURE names that feature, and look-profile.test.js asserts it
// is in RENDER_FEATURES, so a look can never quietly depend on a consumer
// that is not there (the plan's "feature-gated values" rule). Captures record
// the set, so an evidence record names exactly which features produced it.
export const RENDER_FEATURES = Object.freeze(
  new Set([
    'emitterSource', // P5: fixtures shade/shadow from the look's emitter height
    'gridTraceV2', // P5: footprint penumbra, storey-clamped lintels, jambs, square columns
    'unifiedLightLoop', // P6: one visibility path, one call site per occlusion function
    'capsulesV2', // P7: fitted capsules, cone/cap soft shadows, capsule AO
    'furnitureShadows', // P8/P9: proxy boxes in the grid, exact panel coverage
    'creaseAO', // P10: grid crease occlusion on every tier
    'gtao', // P11: GTAO + bent normals + joint bilateral resolve
    'contactV2', // P12: residual contact with hit ownership and per-light channels
    'indirectOcclusion', // P13: AO on indirect only, multi-bounce, specular occlusion, box AO
    'shaftsV1', // P14: quadratic steps, near-field torch, traced shafts, depth-aware upsample
    'torchFilter', // P2/P15: world-unit bias, Vogel PCF, PCSS, update skipping
    'torchBounce', // P16: CPU-raycast bounce light
    'crossFloor', // P17: slab-hole footprint + two-storey traces
    'emission', // P19: diffuser profile, troffer face, rectangle specular, GI emission
    'ambientTint', // P3: look shadow colour (luminance kept)
    'gradeV2', // P20: camera-model grade + bloom tail
    'exposureV2', // P21: emissive metering, spring adaptation, auto white balance
    'signal', // P25: camcorder tape signal
    'motionBlur', // P26: camera motion blur
  ])
)

// Look-profile field path -> the feature that consumes it.
export const LOOK_FIELD_FEATURE = Object.freeze({
  lampPower: 'emitterSource',
  'lights.sourceDrop': 'emitterSource',
  'lights.ceilingLift': 'emitterSource',
  'lights.emitFloor': 'emission',
  'lights.emitPow': 'emission',
  'lights.panelGlow': 'emission',
  'lights.panelPattern': 'emission',
  'lights.torchTint': 'torchFilter',
  'shadow.contact': 'contactV2',
  'shadow.contactLength': 'contactV2',
  'shadow.furniture': 'furnitureShadows',
  'shadow.furnitureAO': 'indirectOcclusion',
  'shadow.capsule': 'capsulesV2',
  'shadow.capsuleAO': 'capsulesV2',
  'shadow.capsuleMinVis': 'capsulesV2',
  'shadow.selfShadow': 'capsulesV2',
  'shadow.playerBody': 'capsulesV2',
  'shadow.creaseAO': 'creaseAO',
  'shadow.penumbraScale': 'gridTraceV2',
  'shadow.torchSize': 'torchFilter',
  'shadow.multiBounce': 'indirectOcclusion',
  'shadow.specOcclusion': 'indirectOcclusion',
  'shadow.bentNormal': 'gtao',
  'shadow.ambientTint': 'ambientTint',
  'shadow.ambientTintK': 'ambientTint',
  'shadow.occlusionPath': 'gtao',
  lampAO: 'indirectOcclusion',
  'camera.tintStage': 'gradeV2',
  'camera.whiteBalance': 'gradeV2',
  'camera.satAbs': 'gradeV2',
  'camera.highlightDesat': 'gradeV2',
  'camera.knee': 'gradeV2',
  'camera.whiteClip': 'gradeV2',
  'camera.toe': 'gradeV2',
  'camera.blackLevel': 'gradeV2',
  'camera.liftColor': 'gradeV2',
  'camera.splitShadow': 'gradeV2',
  'camera.splitHigh': 'gradeV2',
  'camera.lensK1': 'gradeV2',
  'camera.lensK2': 'gradeV2',
  'camera.caK': 'gradeV2',
  'camera.vignetteBase': 'gradeV2',
  'camera.bloomTail': 'gradeV2',
  'camera.bloomClamp': 'gradeV2',
  'camera.halation': 'gradeV2',
  'exposure.meterEmissive': 'exposureV2',
  'exposure.damping': 'exposureV2',
  'exposure.omega': 'exposureV2',
  'exposure.awbStrength': 'exposureV2',
  'exposure.awbSpeed': 'exposureV2',
  'signal.enabled': 'signal',
  'signal.lumaLines': 'signal',
  'signal.chromaLines': 'signal',
  'signal.chromaDelay': 'signal',
  'signal.sharpen': 'signal',
  'signal.tapeNoise': 'signal',
  'signal.headSwitch': 'signal',
  'signal.dropouts': 'signal',
  'signal.ccdSmear': 'signal',
  'signal.native': 'signal',
  'motion.blur': 'motionBlur',
  'motion.rollingShutter': 'motionBlur',
})
