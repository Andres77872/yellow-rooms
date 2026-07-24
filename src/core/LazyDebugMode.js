const loadDebugMode = () => import('../debug/DebugMode.js')

// Small production-shell for the developer tools. Keeping the dynamic import
// here prevents DebugMode (and its world-map/editor dependencies) from joining
// the game's initial module graph, while Engine can keep calling the same
// synchronous hooks every frame.
export class LazyDebugMode {
  constructor(engine, load = loadDebugMode) {
    this.engine = engine
    this._load = load
    this._mode = null
    this._loading = null
    this._disposed = false
    this._pendingToggle = false
    this._size = null

    this._onKeyDown = this._onKeyDown.bind(this)
    addEventListener('keydown', this._onKeyDown)
  }

  get active() {
    return this._mode?.active ?? false
  }

  get freeze() {
    return this._mode?.freeze ?? false
  }

  get invincible() {
    return this._mode?.invincible ?? false
  }

  // These stay synchronous and allocation-free while the tools are unloaded.
  update(dt) {
    this._mode?.update(dt)
  }

  preRender() {
    this._mode?.preRender()
  }

  postRender() {
    this._mode?.postRender()
  }

  resize(w, h) {
    this._size = [w, h]
    this._mode?.resize(w, h)
  }

  // WorldMapTool reaches these helpers back through engine.debugMode. Engine
  // intentionally keeps the facade identity after loading, so public tool API
  // calls must forward just like the per-frame lifecycle hooks.
  placeStalker(wx, wz, cy) {
    return this._mode?.placeStalker(wx, wz, cy)
  }

  teleportPlayer(wx, wz, cy) {
    return this._mode?.teleportPlayer(wx, wz, cy)
  }

  _onKeyDown(event) {
    if (event.code !== 'F2' || this._disposed) return
    event.preventDefault()

    // Match DebugMode.toggle() even when a slow network lets multiple F2
    // presses arrive before the module resolves: an even number cancels out.
    this._pendingToggle = !this._pendingToggle
    this._ensureLoaded()
  }

  _ensureLoaded() {
    if (this._mode || this._loading || this._disposed) return

    const loading = Promise.resolve()
      .then(() => this._load())
      .then(({ DebugMode }) => {
        if (this._disposed) return
        if (typeof DebugMode !== 'function') {
          throw new TypeError('DebugMode module did not export DebugMode')
        }

        const mode = new DebugMode(this.engine)
        if (this._disposed) {
          mode.dispose()
          return
        }

        this._mode = mode
        removeEventListener('keydown', this._onKeyDown)
        if (this._size) mode.resize(...this._size)

        const shouldToggle = this._pendingToggle
        this._pendingToggle = false
        if (shouldToggle) mode.toggle()
      })
      .catch((error) => {
        if (this._disposed) return
        // Keep the bootstrap listener installed so a transient chunk-load
        // failure can be retried with F2 instead of permanently disabling tools.
        this._pendingToggle = false
        console.error('Failed to load debug tools', error)
      })
      .finally(() => {
        if (this._loading === loading) this._loading = null
      })

    this._loading = loading
  }

  dispose() {
    if (this._disposed) return
    this._disposed = true
    this._pendingToggle = false
    removeEventListener('keydown', this._onKeyDown)
    this._mode?.dispose()
    this._mode = null
  }
}
