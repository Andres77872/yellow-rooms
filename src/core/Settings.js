import {
  AUTO_FALLBACK_PRESET,
  DEFAULT_PRESET,
  GRAPHICS_PRESETS,
  PRESET_CHOICES,
  TIER_ORDER,
  WORLD_DETAIL_ORDER,
} from './graphics.js'
import { DEFAULT_LOOK, LOOK_ORDER } from '../render/lookProfile.js'

const KEY = 'yellowrooms.settings'

// Look sensitivity is stored in radians of rotation per pixel of raw pointer
// travel. The UI never shows that number — it exposes a multiplier of
// SENS_DEFAULT (×0.25 … ×3.00), which is the only form a player can reason about.
export const SENS_DEFAULT = 0.0022
export const SENS_MIN = SENS_DEFAULT * 0.25
export const SENS_MAX = SENS_DEFAULT * 3

// Film-grain noise: 'danger' fades it in with enemy tension (a calm frame is
// clean), 'always' keeps the constant floor of the classic look, 'off' kills it.
export const NOISE_MODES = ['off', 'danger', 'always']

// EXPERIMENTAL path tracer (render/pathtrace, three-gpu-pathtracer on
// WebGPU): 'viewer' lets P open a frozen, converging path-traced view of the
// frame; 'realtime' replaces the deferred lighting with path-traced lighting
// while the game runs (P flips back to raster for an A/B).
export const PATH_TRACER_MODES = ['off', 'viewer', 'realtime']

// Frame-rate limit for live play (Engine._frameLimitDue): 'off' draws on
// every display refresh, 'half' on every second one (evenly paced on any
// refresh rate), a number caps the average rate. Not a graphics key: no
// preset changes it, and it never changes what a frame looks like.
export const FRAME_LIMITS = ['off', 'half', 30, 60, 90, 120, 144]

export const DEFAULTS = {
  sensitivity: SENS_DEFAULT,
  invertY: false,
  invertX: false,
  bob: true,
  cameraFx: true,
  noise: 'danger',
  // Visual style (render/lookProfile.js): the semi-realistic physical look,
  // the liminal-photo and camcorder looks, the classic stylised anime look,
  // or the neutral reference.
  look: DEFAULT_LOOK,
  // Camera motion blur is opt-in (motion sickness); only looks that ask for
  // it (camcorder) blur even when on.
  motionBlur: false,
  // Dynamic resolution: always on for the 'auto' preset, opt-in otherwise
  // (see dynamicResEnabled).
  dynamicRes: false,
  outline: true,
  volume: 0.9,
  minimap: true,
  // Photosensitivity: caps the bad-tube strobe (<= 2 steps/s, < 10% swing)
  // and softens the global tube hum and dead-tube dip, keeping every lamp
  // flicker under the WCAG 2.3.1 flash limits (world/lampCharacter.js). ON by
  // default — the full ~9 Hz strobe is an opt-in, never a surprise.
  reduceFlicker: true,
  // EXPERIMENTAL, OFF by default (PATH_TRACER_MODES). Not a graphics key: no
  // preset turns it on, and while off nothing WebGPU is ever loaded.
  pathTracer: 'off',
  // Uncapped by default (FRAME_LIMITS): a high-refresh display otherwise
  // gets exactly the frame rate it had before the setting existed.
  frameLimit: 'off',
  // Graphics: the preset plus the advanced keys it pins (core/graphics.js).
  // Fresh installs are 'auto' (classified per device at boot); the advanced
  // defaults are the pre-classification fallback EXPANDED, so the advanced
  // controls show real values, not blanks.
  preset: DEFAULT_PRESET,
  ...GRAPHICS_PRESETS[AUTO_FALLBACK_PRESET],
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const bool = (v, d) => (typeof v === 'boolean' ? v : d)
const num = (lo, hi) => (v, d) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d)
const oneOf = (list) => (v, d) => (list.includes(v) ? v : d)

// Every key is coerced on both load and set. A stale or hand-edited blob must
// not be able to produce sensitivity:0 (look silently dead) or volume:NaN (which
// poisons the whole WebAudio gain graph) with no in-game way back — and a bad
// graphics blob must never push an out-of-range loop count at a shader.
const COERCE = {
  sensitivity: num(SENS_MIN, SENS_MAX),
  volume: num(0, 1),
  invertY: bool,
  invertX: bool,
  bob: bool,
  cameraFx: bool,
  noise: oneOf(NOISE_MODES),
  look: oneOf(LOOK_ORDER),
  motionBlur: bool,
  dynamicRes: bool,
  outline: bool,
  minimap: bool,
  reduceFlicker: bool,
  pathTracer: oneOf(PATH_TRACER_MODES),
  frameLimit: oneOf(FRAME_LIMITS),
  preset: oneOf(PRESET_CHOICES),
  renderScale: num(0.5, 1),
  worldDetail: oneOf(WORLD_DETAIL_ORDER),
  aoQuality: oneOf(TIER_ORDER),
  shadowQuality: oneOf(TIER_ORDER),
  flashShadowQuality: oneOf(TIER_ORDER),
  volQuality: oneOf(TIER_ORDER),
  bloom: bool,
  fxaa: bool,
}

// Whether dynamic resolution runs: always under 'auto' (the auto path relies
// on it), never under 'cinematic', the DYNAMIC RESOLUTION toggle otherwise.
// The engine and the settings panel share this one rule, so the checkbox
// shows what actually runs.
export function dynamicResEnabled(settings) {
  const preset = settings.get('preset')
  return preset !== 'cinematic' && (preset === 'auto' || !!settings.get('dynamicRes'))
}

// localStorage-backed settings (best-effort; tolerates private mode).
export class Settings {
  constructor() {
    this.data = { ...DEFAULTS }
    let stored = null
    try {
      stored = JSON.parse(localStorage.getItem(KEY) || 'null')
    } catch {
      stored = null
    }
    if (stored && typeof stored === 'object') {
      for (const k of Object.keys(DEFAULTS)) {
        if (k in stored) this.data[k] = COERCE[k](stored[k], DEFAULTS[k])
      }
      // v1 blobs are the ones without flashShadowQuality: every v2 save
      // writes the whole store, that key included.
      if (!('flashShadowQuality' in stored)) {
        // v1 had one shadow tier for both the world and the torch: the
        // flashlight setting starts where the player's shadow tier was.
        if ('shadowQuality' in stored) {
          this.data.flashShadowQuality = COERCE.flashShadowQuality(stored.shadowQuality, DEFAULTS.flashShadowQuality)
        }
        // The v1 boot applied, and so saved, its device default preset
        // ('high' on desktop, 'medium' on touch: AUTO_FALLBACK_PRESET) on
        // every start, so a stored v1 preset equal to it was stamped, not
        // chosen. It becomes 'auto' (GPU class, benchmark, dynamic
        // resolution). 'custom' and every other preset were real choices and
        // stay. A player who really picked the default cannot be told apart;
        // on a GPU that runs it, 'auto' resolves to that same preset, and
        // picking it again saves a v2 blob that is never migrated again.
        if (this.data.preset === AUTO_FALLBACK_PRESET) this.data.preset = 'auto'
      }
      // The first experimental build stored a boolean (webgpuPathTracer):
      // an opt-in becomes the viewer it switched on.
      if (!('pathTracer' in stored) && stored.webgpuPathTracer === true) this.data.pathTracer = 'viewer'
    }
    // Fresh = nothing stored yet: the engine may classify the device and
    // choose the 'auto' preset's concrete tiers.
    this.fresh = !stored || typeof stored !== 'object'
  }

  get(k) {
    return this.data[k]
  }

  // Returns the value actually stored — callers should apply *that*, not their
  // input, so a bad value can never reach the controller/audio graph.
  set(k, v) {
    const coerce = COERCE[k]
    this.data[k] = coerce ? coerce(v, DEFAULTS[k]) : v
    this._save()
    return this.data[k]
  }

  // Coerce and store several keys with ONE persistence write (a graphics
  // preset pins seven keys at once).
  setMany(values) {
    for (const [k, v] of Object.entries(values)) {
      const coerce = COERCE[k]
      this.data[k] = coerce ? coerce(v, DEFAULTS[k]) : v
    }
    this._save()
  }

  reset() {
    this.data = { ...DEFAULTS }
    this._save()
  }

  _save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data))
    } catch {
      /* ignore */
    }
  }
}
