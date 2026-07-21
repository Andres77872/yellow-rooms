// Per-pass GPU timing via EXT_disjoint_timer_query_webgl2 (debug only —
// enabled from the LightTool). Each instrumented pass runs inside a
// TIME_ELAPSED query; results resolve a few frames later, so a small frame
// queue is polled and folded into an EMA per pass name. Where the extension is
// missing (Firefox, many mobile GPUs) `supported` is false and every call is a
// no-op — the LightTool shows "n/a" instead of numbers.
export class PassTimer {
  constructor(gl) {
    this.gl = gl
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
    this.supported = !!this.ext
    this._frames = [] // FIFO of per-frame query lists [{name, q}]
    this._cur = null
    this.results = new Map() // pass name -> EMA milliseconds
  }

  frameStart() {
    if (this.supported) this._cur = []
  }

  begin(name) {
    if (!this._cur) return
    const gl = this.gl
    const q = gl.createQuery()
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q)
    this._cur.push({ name, q })
  }

  end() {
    if (!this._cur) return
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
  }

  frameEnd() {
    if (!this._cur) return
    if (this._cur.length) this._frames.push(this._cur)
    this._cur = null
    this._poll()
  }

  _poll() {
    const gl = this.gl
    // Resolve whole frames oldest-first; a frame is ready when its LAST query
    // is (queries complete in submission order).
    while (this._frames.length) {
      const frame = this._frames[0]
      const last = frame[frame.length - 1]
      if (!gl.getQueryParameter(last.q, gl.QUERY_RESULT_AVAILABLE)) break
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT)
      for (const { name, q } of frame) {
        if (!disjoint) {
          const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6
          const prev = this.results.get(name)
          this.results.set(name, prev === undefined ? ms : prev * 0.9 + ms * 0.1)
        }
        gl.deleteQuery(q)
      }
      this._frames.shift()
    }
    // Backpressure: if the driver stalls results, don't grow unbounded.
    while (this._frames.length > 8) {
      for (const { q } of this._frames.shift()) gl.deleteQuery(q)
    }
  }

  dispose() {
    const gl = this.gl
    if (this._cur) {
      // A dangling active query would poison the next beginQuery.
      try {
        gl.endQuery(this.ext.TIME_ELAPSED_EXT)
      } catch {
        /* no active query */
      }
      for (const { q } of this._cur) gl.deleteQuery(q)
      this._cur = null
    }
    for (const frame of this._frames) for (const { q } of frame) gl.deleteQuery(q)
    this._frames.length = 0
    this.results.clear()
  }
}
