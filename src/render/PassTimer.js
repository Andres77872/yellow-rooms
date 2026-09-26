// Per-pass GPU timing via EXT_disjoint_timer_query_webgl2 (debug only —
// enabled from the LightTool). Each instrumented pass runs inside a
// TIME_ELAPSED query; results resolve a few frames later, so a small frame
// queue is polled and folded into an EMA per pass name. Where the extension is
// missing (Firefox, many mobile GPUs) `supported` is false and every call is a
// no-op — the LightTool shows "n/a" instead of numbers.
//
// Besides the EMA readout, every resolved sample also lands in a bounded
// per-pass ring (engine-improvement R0/E6): stats() reports p50/p95/p99 over
// the retained window and export() serializes it with the discarded-sample
// counts, so a capture can say how many GPU samples were disjoint or dropped
// instead of silently treating missing timing as zero.
export const PASS_TIMER_WINDOW = 240

export function percentile(sorted, p) {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[i]
}

export class PassTimer {
  constructor(gl, window = PASS_TIMER_WINDOW) {
    this.gl = gl
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
    this.supported = !!this.ext
    this._frames = [] // FIFO of per-frame query lists [{name, q}]
    this._cur = null
    this.results = new Map() // pass name -> EMA milliseconds
    this.window = Math.max(8, window | 0)
    this._samples = new Map() // pass name -> { data: Float64Array ring, n, head }
    this.disjointFrames = 0 // whole frames discarded because the GPU timer was disjoint
    this.droppedFrames = 0 // frames discarded by backpressure before resolving
    this.resolvedFrames = 0
  }

  _record(name, ms) {
    let ring = this._samples.get(name)
    if (!ring) {
      ring = { data: new Float64Array(this.window), n: 0, head: 0 }
      this._samples.set(name, ring)
    }
    ring.data[ring.head] = ms
    ring.head = (ring.head + 1) % this.window
    ring.n = Math.min(ring.n + 1, this.window)
  }

  // Percentiles over the retained window for one pass ('frame' = the summed
  // instrumented passes of each resolved frame). null when nothing resolved.
  stats(name) {
    const ring = this._samples.get(name)
    if (!ring || !ring.n) return null
    const sorted = Array.from(ring.data.subarray(0, ring.n)).sort((a, b) => a - b)
    let sum = 0
    for (const v of sorted) sum += v
    return {
      count: ring.n,
      mean: sum / ring.n,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted[sorted.length - 1],
    }
  }

  export() {
    const passes = {}
    for (const name of this._samples.keys()) passes[name] = this.stats(name)
    return {
      supported: this.supported,
      window: this.window,
      resolvedFrames: this.resolvedFrames,
      disjointFrames: this.disjointFrames,
      droppedFrames: this.droppedFrames,
      passes,
    }
  }

  // A restored GL context comes back with every extension disabled and
  // every query object dead: re-enable the timer extension (the enums of the
  // old object stay valid) and forget the stale queries, which would never
  // resolve (deleting them only raises errors on the new context).
  restore() {
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2')
    this.supported = !!this.ext
    this._frames.length = 0
    this._cur = null
  }

  resetSamples() {
    this._samples.clear()
    this.disjointFrames = 0
    this.droppedFrames = 0
    this.resolvedFrames = 0
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
      let total = 0
      for (const { name, q } of frame) {
        if (!disjoint) {
          const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6
          const prev = this.results.get(name)
          this.results.set(name, prev === undefined ? ms : prev * 0.9 + ms * 0.1)
          this._record(name, ms)
          total += ms
        }
        gl.deleteQuery(q)
      }
      if (disjoint) this.disjointFrames++
      else {
        this._record('frame', total)
        this.resolvedFrames++
      }
      this._frames.shift()
    }
    // Backpressure: if the driver stalls results, don't grow unbounded.
    while (this._frames.length > 8) {
      for (const { q } of this._frames.shift()) gl.deleteQuery(q)
      this.droppedFrames++
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
    this._samples.clear()
  }
}

// Lightweight always-on GPU frame timer (chapter 14 P24): ONE TIME_ELAPSED
// query around the whole frame, resolved a few frames late, for the dynamic
// resolution controller. Queries cannot nest, so the renderer runs it only
// while the per-pass debug timer is off. Without the extension `supported`
// is false and the caller falls back to rAF intervals.
export class FrameGpuTimer {
  constructor(gl) {
    this.gl = gl
    this.ext = gl?.getExtension?.('EXT_disjoint_timer_query_webgl2') ?? null
    this.supported = !!this.ext
    this._pending = []
    this._active = null
  }

  begin() {
    if (!this.supported || this._active) return
    this._active = this.gl.createQuery()
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this._active)
  }

  end() {
    if (!this._active) return
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
    this._pending.push(this._active)
    this._active = null
  }

  // Newest resolved GPU frame time in ms, or null when nothing (valid)
  // resolved since the last poll — never a substitute value.
  poll() {
    if (!this.supported) return null
    const gl = this.gl
    let out = null
    while (this._pending.length) {
      const q = this._pending[0]
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT)
      const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6
      gl.deleteQuery(q)
      this._pending.shift()
      out = disjoint ? null : ms
    }
    while (this._pending.length > 8) gl.deleteQuery(this._pending.shift())
    return out
  }

  // Context restore: see PassTimer.restore. Without it every later query
  // fails and poll() returns null for good, freezing dynamic resolution.
  restore() {
    this.ext = this.gl?.getExtension?.('EXT_disjoint_timer_query_webgl2') ?? null
    this.supported = !!this.ext
    this._pending.length = 0
    this._active = null
  }

  dispose() {
    if (!this.supported) return
    if (this._active) {
      try {
        this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
      } catch {
        /* no active query */
      }
      this.gl.deleteQuery(this._active)
      this._active = null
    }
    for (const q of this._pending) this.gl.deleteQuery(q)
    this._pending.length = 0
  }
}
