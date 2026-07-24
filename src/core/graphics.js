import { IS_TOUCH } from './device.js'
import {
  AO_SAMPLES,
  AO_SAMPLES_MAX,
  SHADOW_STEPS,
  SHADOW_MAX,
  SHADOW_LAMPS_MAX,
  VOL_STEPS,
  VOL_LIGHT_MAX,
  VOL_LIGHTS_MAX,
} from '../world/constants.js'
import { RENDER_DETAIL_PROFILE_NAMES } from '../world/renderDetail.js'

// Runtime graphics quality: presets + per-feature tiers, resolved into the
// numbers DeferredRenderer consumes. Shaders compile once against the *_MAX
// ceilings in world/constants.js; every knob here is a uniform (loop trip
// count), a pass on/off, or a resolution scale — so switching quality is
// instant, with no shader rebuild and no pipeline reconstruction.
//
// The 'high' shader tiers are defined FROM the legacy constants (AO_SAMPLES
// etc.), so deferred shading stays bit-identical to the pre-settings build.
// World-detail LOD is a separate, explicit knob: it reduces only distant mesh
// batches at fog-coupled boundaries; Ultra preserves silhouettes at every ring.

export const PRESET_ORDER = ['low', 'medium', 'high', 'ultra']
export const TIER_ORDER = ['off', 'low', 'high', 'ultra']
export const WORLD_DETAIL_ORDER = RENDER_DETAIL_PROFILE_NAMES

// Per-feature tiers. 'off' skips the pass entirely (the renderer substitutes
// the pass's identity value — white for AO/shadow masks, black for shafts).
export const AO_TIERS = Object.freeze({
  off: { enabled: false, samples: 8 },
  low: { enabled: true, samples: 8 },
  high: { enabled: true, samples: AO_SAMPLES },
  ultra: { enabled: true, samples: AO_SAMPLES_MAX },
})

export const SHADOW_TIERS = Object.freeze({
  off: { enabled: false, steps: 12, lamps: 4 },
  low: { enabled: true, steps: 12, lamps: 4 },
  high: { enabled: true, steps: SHADOW_STEPS, lamps: SHADOW_MAX },
  ultra: { enabled: true, steps: 28, lamps: SHADOW_LAMPS_MAX },
})

export const VOL_TIERS = Object.freeze({
  off: { enabled: false, steps: 16, lights: 6 },
  low: { enabled: true, steps: 16, lights: 6 },
  high: { enabled: true, steps: VOL_STEPS, lights: VOL_LIGHT_MAX },
  ultra: { enabled: true, steps: 44, lights: VOL_LIGHTS_MAX },
})

// Preset -> the individual advanced settings it pins. Selecting a preset
// copies these into the Settings store (so the advanced controls show the
// truth); editing any advanced control afterwards flips the preset to
// 'custom' without touching the others.
export const GRAPHICS_PRESETS = Object.freeze({
  low: { renderScale: 0.75, worldDetail: 'low', aoQuality: 'off', shadowQuality: 'low', volQuality: 'off', bloom: true, fxaa: true },
  medium: { renderScale: 1, worldDetail: 'medium', aoQuality: 'low', shadowQuality: 'low', volQuality: 'low', bloom: true, fxaa: true },
  high: { renderScale: 1, worldDetail: 'high', aoQuality: 'high', shadowQuality: 'high', volQuality: 'high', bloom: true, fxaa: true },
  ultra: { renderScale: 1, worldDetail: 'ultra', aoQuality: 'ultra', shadowQuality: 'ultra', volQuality: 'ultra', bloom: true, fxaa: true },
})

// The keys a preset owns (everything above). Engine uses this both to apply a
// preset and to know which setting edits should flip the preset to 'custom'.
export const GRAPHICS_KEYS = Object.freeze(Object.keys(GRAPHICS_PRESETS.high))

// Phones: the old device tier ran 8 AO samples / 12 shadow steps / 16 vol
// steps, which is exactly the 'medium' preset (DPR is clamped separately by
// device.js MAX_DPR). Desktop 'high' matches the old desktop build.
export const DEFAULT_PRESET = IS_TOUCH ? 'medium' : 'high'

// Resolve the stored settings into the flat quality object the renderer
// consumes. `settings` is anything with a .get(key) (the Settings store).
export function resolveGraphics(settings) {
  const tier = (table, key, fallback) => table[settings.get(key)] ?? table[fallback]
  return {
    renderScale: settings.get('renderScale') ?? 1,
    worldDetail: WORLD_DETAIL_ORDER.includes(settings.get('worldDetail'))
      ? settings.get('worldDetail')
      : 'high',
    ao: tier(AO_TIERS, 'aoQuality', 'high'),
    shadow: tier(SHADOW_TIERS, 'shadowQuality', 'high'),
    vol: tier(VOL_TIERS, 'volQuality', 'high'),
    bloom: settings.get('bloom') !== false,
    fxaa: settings.get('fxaa') !== false,
  }
}
