// On-screen renderer.info readout. Toggle with the backtick (`) key. Catches
// draw-call creep and undisposed-resource leaks immediately during dev.
export class DebugOverlay {
  constructor(renderer) {
    this.renderer = renderer
    this.visible = false
    this._acc = 0
    this._frames = 0
    this._fps = 0
    const el = document.createElement('div')
    el.style.cssText = `position:fixed;top:8px;left:8px;z-index:50;
      font:11px/1.4 ui-monospace,monospace;color:#e8e0a0;
      background:rgba(0,0,0,.55);padding:6px 8px;border:1px solid #5e501a;
      white-space:pre;pointer-events:none;display:none;border-radius:3px`
    document.body.appendChild(el)
    this.el = el
    addEventListener('keydown', (e) => {
      if (e.code === 'Backquote') this.toggle()
    })
  }

  toggle() {
    this.visible = !this.visible
    this.el.style.display = this.visible ? 'block' : 'none'
  }

  update(dt, extra = {}) {
    this._acc += dt
    this._frames++
    if (this._acc >= 0.5) {
      this._fps = Math.round(this._frames / this._acc)
      this._acc = 0
      this._frames = 0
    }
    if (!this.visible) return
    const info = this.renderer.info
    this.el.textContent =
      `fps      ${this._fps}\n` +
      `calls    ${info.render.calls}\n` +
      `tris     ${info.render.triangles.toLocaleString()}\n` +
      `geoms    ${info.memory.geometries}\n` +
      `textures ${info.memory.textures}\n` +
      `programs ${info.programs?.length ?? '-'}\n` +
      `chunks   ${extra.chunks ?? '-'}`
  }
}
