import { section, readout } from './widgets.js'

const SAMPLES = 120 // ~2s of frame times at 60fps
const PW = 300
const PH = 64
const MS_FULL = 50 // sparkline vertical scale: 0..50ms

// Renderer/perf tab: fps + frame-time sparkline + renderer.info counters, so
// the F2 panel no longer needs the backtick overlay for basic perf triage.
// update() runs only while this tab is shown (DebugMode gates per-tab
// updates), so the sparkline is "live while you watch it" — switch here when
// something hitches, not for historical capture.
export class PerfTool {
  constructor(engine) {
    this.engine = engine
    this._ms = new Float32Array(SAMPLES)
    this._head = 0
    this._filled = 0
    this._acc = 0
    this._frames = 0
    this._fps = 0

    const root = document.createElement('div')
    this.el = root
    const s = section('performance')
    root.appendChild(s.el)
    this._r = {
      fps: readout('fps'),
      ms: readout('frame ms'),
      calls: readout('draw calls'),
      tris: readout('triangles'),
      mem: readout('geom/tex/prog'),
      chunks: readout('chunks loaded'),
    }
    for (const k of Object.keys(this._r)) s.body.appendChild(this._r[k].el)

    const cv = document.createElement('canvas')
    cv.className = 'dbg-canvas'
    cv.style.cursor = 'default'
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = PW * dpr
    cv.height = PH * dpr
    cv.style.width = PW + 'px'
    cv.style.height = PH + 'px'
    this.ctx = cv.getContext('2d')
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    s.body.appendChild(cv)
  }

  update(dt) {
    this._ms[this._head] = dt * 1000
    this._head = (this._head + 1) % SAMPLES
    if (this._filled < SAMPLES) this._filled++

    this._acc += dt
    this._frames++
    if (this._acc >= 0.5) {
      this._fps = Math.round(this._frames / this._acc)
      this._acc = 0
      this._frames = 0
    }

    const info = this.engine.renderer.info
    const last = this._ms[(this._head - 1 + SAMPLES) % SAMPLES]
    this._r.fps.set(`${this._fps}`)
    this._r.ms.set(`${last.toFixed(1)} · avg ${this._avg().toFixed(1)}`)
    this._r.calls.set(`${info.render.calls}`)
    this._r.tris.set(info.render.triangles.toLocaleString())
    this._r.mem.set(
      `${info.memory.geometries} / ${info.memory.textures} / ${info.programs?.length ?? '-'}`
    )
    this._r.chunks.set(`${this.engine.cm.loadedCount}`)
    this._draw()
  }

  _avg() {
    let sum = 0
    for (let i = 0; i < this._filled; i++) sum += this._ms[i]
    return this._filled ? sum / this._filled : 0
  }

  _draw() {
    const ctx = this.ctx
    ctx.clearRect(0, 0, PW, PH)
    // 60fps / 30fps guide lines with labels.
    ctx.strokeStyle = 'rgba(94,80,26,.7)'
    ctx.fillStyle = 'rgba(233,225,163,.5)'
    ctx.font = '9px ui-monospace, monospace'
    ctx.lineWidth = 1
    for (const [ms, tag] of [
      [16.7, '60'],
      [33.3, '30'],
    ]) {
      const y = PH - (ms / MS_FULL) * PH
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(PW, y)
      ctx.stroke()
      ctx.fillText(tag, 3, y - 2)
    }
    // Frame-time polyline, oldest -> newest left -> right.
    ctx.strokeStyle = '#cdbf6e'
    ctx.beginPath()
    for (let i = 0; i < this._filled; i++) {
      const ms = this._ms[(this._head - this._filled + i + SAMPLES) % SAMPLES]
      const x = (i / (SAMPLES - 1)) * PW
      const y = PH - Math.min(1, ms / MS_FULL) * PH
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  onShow() {}

  dispose() {}
}
