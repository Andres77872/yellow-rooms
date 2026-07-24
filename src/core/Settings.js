import {
  DEFAULT_PRESET,
  GRAPHICS_PRESETS,
  PRESET_ORDER,
  TIER_ORDER,
  WORLD_DETAIL_ORDER,
} from './graphics.js'

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

export const DEFAULTS = {
  sensitivity: SENS_DEFAULT,
  invertY: false,
  invertX: false,
  bob: true,
  cameraFx: true,
  noise: 'danger',
  outline: true,
  volume: 0.9,
  minimap: true,
  // Graphics: the preset plus the advanced keys it pins (core/graphics.js).
  // Defaults are the device-tier preset EXPANDED, so a fresh install's
  // advanced controls show the preset's real values, not blanks.
  preset: DEFAULT_PRESET,
  ...GRAPHICS_PRESETS[DEFAULT_PRESET],
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
  outline: bool,
  minimap: bool,
  preset: oneOf([...PRESET_ORDER, 'custom']),
  renderScale: num(0.5, 1),
  worldDetail: oneOf(WORLD_DETAIL_ORDER),
  aoQuality: oneOf(TIER_ORDER),
  shadowQuality: oneOf(TIER_ORDER),
  volQuality: oneOf(TIER_ORDER),
  bloom: bool,
  fxaa: bool,
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
    }
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
