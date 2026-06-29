const KEY = 'yellowrooms.settings'

const DEFAULTS = {
  sensitivity: 0.0022,
  bob: true,
  outline: true,
  volume: 0.9,
  minimap: true,
}

// localStorage-backed settings (best-effort; tolerates private mode).
export class Settings {
  constructor() {
    let stored = {}
    try {
      stored = JSON.parse(localStorage.getItem(KEY) || '{}')
    } catch {
      stored = {}
    }
    this.data = { ...DEFAULTS, ...stored }
  }
  get(k) {
    return this.data[k]
  }
  set(k, v) {
    this.data[k] = v
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data))
    } catch {
      /* ignore */
    }
  }
}
