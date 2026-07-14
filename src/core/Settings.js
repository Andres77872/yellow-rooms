const KEY = 'yellowrooms.settings'

// Look sensitivity is stored in radians of rotation per pixel of raw pointer
// travel. The UI never shows that number — it exposes a multiplier of
// SENS_DEFAULT (×0.25 … ×3.00), which is the only form a player can reason about.
export const SENS_DEFAULT = 0.0022
export const SENS_MIN = SENS_DEFAULT * 0.25
export const SENS_MAX = SENS_DEFAULT * 3

export const DEFAULTS = {
  sensitivity: SENS_DEFAULT,
  invertY: false,
  invertX: false,
  bob: true,
  outline: true,
  volume: 0.9,
  minimap: true,
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const bool = (v, d) => (typeof v === 'boolean' ? v : d)
const num = (lo, hi) => (v, d) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d)

// Every key is coerced on both load and set. A stale or hand-edited blob must
// not be able to produce sensitivity:0 (look silently dead) or volume:NaN (which
// poisons the whole WebAudio gain graph) with no in-game way back.
const COERCE = {
  sensitivity: num(SENS_MIN, SENS_MAX),
  volume: num(0, 1),
  invertY: bool,
  invertX: bool,
  bob: bool,
  outline: bool,
  minimap: bool,
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
