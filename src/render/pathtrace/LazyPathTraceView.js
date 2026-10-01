import { Phase } from '../../core/GameState.js'
import { isEditableFocused } from '../../core/input.js'
import { PATH_TRACER_MODES } from '../../core/Settings.js'
import { webgpuAvailability } from './webgpuSupport.js'

const loadViewer = () => import('./PathTraceView.js')
const loadRealtimeModule = () => import('./PathTraceRealtime.js')

// P while playing: open/close the viewer, or flip realtime lighting between
// path-traced and raster. Nothing else in the game uses the key.
export const PATH_TRACE_KEY = 'KeyP'
// Realtime status labels stay up this long.
const REALTIME_LABEL_MS = 4000

// Resolves after the browser has presented at least one more frame.
const nextPaint = () =>
  new Promise((resolve) => {
    const raf = globalThis.requestAnimationFrame
    if (!raf) return resolve()
    raf(() => raf(() => resolve()))
  })

// Boot-graph shell for the experimental WebGPU path tracer, in the style of
// core/LazyDebugMode.js. The mode comes from the pathTracer setting, which
// is 'off' by default; three/webgpu, three-gpu-pathtracer and three-mesh-bvh
// load only once a player picked another mode AND it is needed.
//
// viewer (PathTraceView.js)
//   open()   P: the world freezes at once (active), a label shows progress,
//            the module loads, WebGPU initialises, the proxy scene is built.
//   render() the view draws instead of the deferred frame once it is live.
//   close()  P again, or leaving PLAYING (pause, death, quit) closes it; the
//            WebGPU context stays warm for the next open.
// realtime (PathTraceRealtime.js)
//   The first PLAYING frame loads it; from then on DeferredRenderer runs its
//   blend after the lighting pass and afterRender() drives the tracer each
//   frame. The game never freezes. P flips path-traced <-> raster lighting.
// Any failure (no adapter, device loss, a kernel error) drops back to the
// raster renderer and names the reason in a label. The viewer retries on the
// next P; realtime retries on the next P or mode change (never per frame).
export class LazyPathTraceView {
  constructor(engine, { load = loadViewer, loadRealtime = loadRealtimeModule, availability = null } = {}) {
    this.engine = engine
    this._load = load
    this._loadRealtime = loadRealtime
    this.availability = availability ?? webgpuAvailability({ touch: !!engine.touch })
    this.mode = 'off'
    this.error = ''
    this._view = null
    this._viewLoading = null
    this._wanted = false
    this._live = false
    this._token = 0
    this._rt = null
    this._rtLoading = null
    this._rtBroken = false
    this._label = null
    this._labelTimer = null
    this._disposed = false

    this._onKeyDown = this._onKeyDown.bind(this)
    globalThis.addEventListener?.('keydown', this._onKeyDown)
  }

  get enabled() {
    return this.mode !== 'off'
  }

  // Viewer only: true from the key press on, so gameplay freezes while
  // WebGPU starts. Realtime never freezes the game.
  get active() {
    return this._wanted
  }

  get live() {
    return this._live
  }

  // The realtime driver once it runs (tests, F2 readouts).
  get realtime() {
    return this._rt
  }

  setMode(mode) {
    const next = PATH_TRACER_MODES.includes(mode) ? mode : 'off'
    if (next === this.mode) return
    this.close()
    this._disposeView()
    this._disposeRealtime()
    this._rtBroken = false
    this.error = ''
    this._setLabel(null)
    this.mode = next
  }

  // Returns whether anything changed (the key is only consumed then).
  toggle() {
    if (this.mode === 'realtime') return this._toggleRealtime()
    if (!this._wanted) return this.open()
    this.close()
    return true
  }

  open() {
    if (this._disposed || this._wanted || this.mode !== 'viewer' || !this.availability.ok) return false
    const e = this.engine
    if (e.state?.phase !== Phase.PLAYING || e.debugMode?.active) return false
    this._wanted = true
    this.error = ''
    const token = ++this._token
    this._setLabel('PATH TRACER · STARTING WEBGPU …')
    const current = () => token === this._token && this._wanted
    this._ensureView()
      .then(async (view) => {
        if (!current()) return
        // setScene builds every BVH synchronously: let the label paint first.
        this._setLabel('PATH TRACER · BUILDING SCENE …')
        await nextPaint()
        if (!current() || this._view !== view) return
        view.open()
        this._live = true
      })
      .catch((err) => {
        if (token === this._token) this._fail(err)
      })
    return true
  }

  close() {
    this._token++
    this._wanted = false
    if (this._live) this._view?.close()
    this._live = false
    if (!this.error && this.mode !== 'realtime') this._setLabel(null)
  }

  // Called every engine frame with the current phase.
  update(phase) {
    if (this._wanted && phase !== Phase.PLAYING) this.close()
  }

  // Viewer: draws one tracer step; false while the view is not live (the
  // Engine then renders its own frame).
  render(now) {
    if (!this._live || !this._view) return false
    this._view.render(now)
    const s = this._view.stats
    const spp = this._view.samples
    this._setLabel(
      `PATH TRACED · WEBGPU (EXPERIMENTAL) · ${spp} SPP` +
        (s ? ` · ${s.lights} LIGHTS` : '') +
        ' · P TO RETURN'
    )
    return true
  }

  // Realtime: after the deferred frame (whose lighting the blend already
  // replaced), drive the tracer for this camera. Loads on the first PLAYING
  // frame.
  afterRender(now, phase) {
    if (this.mode !== 'realtime' || this._disposed || !this.availability.ok) return
    if (phase !== Phase.PLAYING) {
      this._rt?.idle()
      return
    }
    if (this._rt) {
      this._rt.afterRender(now)
      return
    }
    if (!this._rtLoading && !this._rtBroken) this._startRealtime()
  }

  resize(w, h) {
    this._view?.resize(w, h)
  }

  _startRealtime() {
    this._setLabel('PATH-TRACED LIGHTING · STARTING WEBGPU …')
    const loading = Promise.resolve()
      .then(() => this._loadRealtime())
      .then(async ({ PathTraceRealtime }) => {
        const rt = new PathTraceRealtime(this.engine)
        try {
          await rt.init()
        } catch (err) {
          rt.dispose()
          throw err
        }
        if (this._disposed || this.mode !== 'realtime' || this._rtLoading !== loading) {
          rt.dispose()
          return
        }
        rt.onLost = (message) => this._failRealtime(new Error(message))
        this._rt = rt
        this._setLabel('PATH-TRACED LIGHTING (REALTIME, EXPERIMENTAL) · P: RASTER A/B', REALTIME_LABEL_MS)
      })
      .catch((err) => {
        if (this._rtLoading === loading) this._failRealtime(err)
      })
      .finally(() => {
        if (this._rtLoading === loading) this._rtLoading = null
      })
    this._rtLoading = loading
  }

  _toggleRealtime() {
    if (!this.availability.ok || this.engine.state?.phase !== Phase.PLAYING) return false
    if (this._rtBroken) {
      // A failed start retries on an explicit P, never on its own.
      this._rtBroken = false
      this.error = ''
      return true
    }
    if (!this._rt) return false
    const on = !this._rt.enabled
    this._rt.setEnabled(on)
    this._setLabel(on ? 'PATH-TRACED LIGHTING · ON' : 'RASTER LIGHTING · PATH TRACER OFF', REALTIME_LABEL_MS)
    return true
  }

  _failRealtime(err) {
    const message = err?.message ?? String(err)
    this._disposeRealtime()
    if (this._disposed || this.mode !== 'realtime') return
    this._rtBroken = true
    this.error = message
    console.error('Experimental realtime path tracer failed', err)
    this._setLabel(`PATH TRACER UNAVAILABLE · ${message.toUpperCase()}`, REALTIME_LABEL_MS)
  }

  _disposeRealtime() {
    this._rtLoading = null
    const rt = this._rt
    this._rt = null
    rt?.dispose()
  }

  _onKeyDown(event) {
    if (event.code !== PATH_TRACE_KEY || event.repeat || this.mode === 'off') return
    if (isEditableFocused()) return
    if (this.toggle()) event.preventDefault?.()
  }

  _ensureView() {
    if (this._view) return Promise.resolve(this._view)
    if (!this._viewLoading) {
      const loading = Promise.resolve()
        .then(() => this._load())
        .then(async ({ PathTraceView }) => {
          const view = new PathTraceView(this.engine)
          try {
            await view.init()
          } catch (err) {
            view.dispose()
            throw err
          }
          if (this._disposed || this.mode !== 'viewer') {
            view.dispose()
            throw new Error('disabled')
          }
          view.onLost = (message) => this._fail(new Error(message))
          this._view = view
          return view
        })
        .finally(() => {
          if (this._viewLoading === loading) this._viewLoading = null
        })
      this._viewLoading = loading
    }
    return this._viewLoading
  }

  _fail(err) {
    const message = err?.message ?? String(err)
    this.close()
    this._disposeView()
    // Switching the option off mid-load is not an error worth showing.
    if (this._disposed || this.mode !== 'viewer') return
    this.error = message
    console.error('Experimental WebGPU path tracer failed', err)
    this._setLabel(`PATH TRACER UNAVAILABLE · ${message.toUpperCase()}`, 4000)
  }

  _disposeView() {
    const view = this._view
    this._view = null
    this._live = false
    view?.dispose()
  }

  _setLabel(text, clearAfterMs = 0) {
    clearTimeout(this._labelTimer)
    this._labelTimer = null
    if (!text) {
      this._label?.remove()
      this._label = null
      return
    }
    const doc = globalThis.document
    if (!doc?.createElement) return
    if (!this._label) {
      const el = doc.createElement('div')
      el.dataset.pathTracerLabel = ''
      Object.assign(el.style, {
        position: 'fixed',
        top: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: '21',
        padding: '4px 10px',
        font: '600 11px/1.4 ui-monospace, monospace',
        letterSpacing: '.18em',
        color: '#f4e9c8',
        background: 'rgba(23,18,10,.62)',
        border: '1px solid rgba(232,207,122,.28)',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      })
      doc.body.appendChild(el)
      this._label = el
    }
    if (this._label.textContent !== text) this._label.textContent = text
    if (clearAfterMs > 0) {
      this._labelTimer = setTimeout(() => {
        this.error = ''
        if (!this._wanted) this._setLabel(null)
      }, clearAfterMs)
    }
  }

  dispose() {
    if (this._disposed) return
    this._disposed = true
    globalThis.removeEventListener?.('keydown', this._onKeyDown)
    this.close()
    this._disposeView()
    this._disposeRealtime()
    this.error = ''
    this._setLabel(null)
  }
}
