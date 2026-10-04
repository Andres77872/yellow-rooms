// Frame-rate monitor, Settings 'fpsMonitor' (backtick cycles it, see Engine):
// 'fps' is a one-line counter, 'stats' adds the slowest frame and the
// renderer.info counters that catch draw-call creep and undisposed-resource
// leaks. It reads frames and never changes when or how the game draws.
//
// The rate counts frames that reached the screen over wall-clock time, so a
// frame limit, the 30 FPS menu cadence and a held pause frame all read as what
// is actually shown (the simulation dt is clamped at 50 ms and runs on every
// callback, so it can say neither).
const WINDOW_MS = 500

export class DebugOverlay {
  constructor(renderer, { touch = false } = {}) {
    this.renderer = renderer
    this.mode = 'off'
    this._t0 = null
    this._frames = 0
    this._lastDrawAt = null
    this._maxGap = 0
    this._fps = null
    this._avgMs = null
    this._maxMs = null
    this._extra = {}
    // Under the HUD's LEVEL chip (touch: under the pause button), above the
    // game UI but below the boot screen (z 40).
    const top = touch ? 70 : 48
    const left = touch ? 14 : 18
    const el = document.createElement('div')
    el.style.cssText = `position:fixed;top:max(${top}px, env(safe-area-inset-top));
      left:max(${left}px, env(safe-area-inset-left));z-index:35;
      font:11px/1.4 ui-monospace,monospace;letter-spacing:.06em;color:#f4e9c8;
      background:rgba(23,18,10,.72);padding:4px 8px;border:1px solid rgba(232,207,122,.28);
      white-space:pre;pointer-events:none;display:none;font-variant-numeric:tabular-nums`
    el.setAttribute('aria-hidden', 'true')
    document.body.appendChild(el)
    this.el = el
  }

  get visible() {
    return this.mode !== 'off'
  }

  dispose() {
    this.el.remove()
  }

  setMode(mode) {
    this.mode = mode
    this.el.style.display = this.visible ? 'block' : 'none'
    this._paint()
  }

  // Once per rAF callback; `drawn` says whether this one put a frame on screen.
  update(now, drawn, extra) {
    if (this._t0 === null) this._t0 = now
    if (drawn) {
      if (this._lastDrawAt !== null) this._maxGap = Math.max(this._maxGap, now - this._lastDrawAt)
      this._lastDrawAt = now
      this._frames++
      if (extra) this._extra = extra
    }
    const span = now - this._t0
    if (span < WINDOW_MS) return
    this._fps = Math.round((this._frames * 1000) / span)
    this._avgMs = this._frames ? span / this._frames : null
    this._maxMs = this._frames ? this._maxGap : null
    // A window with nothing drawn (a held pause frame) is not one slow frame:
    // the next draw starts a fresh gap.
    if (!this._frames) this._lastDrawAt = null
    this._t0 = now
    this._frames = 0
    this._maxGap = 0
    this._paint()
  }

  _paint() {
    if (!this.visible) return
    const fps = this._fps ?? '--'
    const ms = (v) => (v === null ? '--' : v.toFixed(1))
    if (this.mode === 'fps') {
      this.el.textContent = `${fps} FPS  ${ms(this._avgMs)} ms`
      return
    }
    const info = this.renderer.info
    this.el.textContent =
      `fps      ${fps}\n` +
      `frame    ${ms(this._avgMs)} ms\n` +
      `slowest  ${ms(this._maxMs)} ms\n` +
      `calls    ${info.render.calls}\n` +
      `tris     ${info.render.triangles.toLocaleString()}\n` +
      `geoms    ${info.memory.geometries}\n` +
      `textures ${info.memory.textures}\n` +
      `programs ${info.programs?.length ?? '-'}\n` +
      `chunks   ${this._extra.chunks ?? '-'}`
  }
}
