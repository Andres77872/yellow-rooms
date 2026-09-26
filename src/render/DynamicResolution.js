// Dynamic resolution controller (engine-improvement P24; chapter 04 "sustained
// frame-time-based adjustment with hysteresis and a cooldown").
//
// Pure: no three.js, no clock, no DOM. The engine feeds one sample per frame
// and applies the scale it gets back; the controller never touches the
// renderer. `scale` is a fraction of NATIVE backing resolution per axis,
// bounded by
//   ceiling  the preset's render scale in native terms (the player's quality
//            choice; see drsCeiling), and
//   floor    max(0.6, 540 / nativeLines): never below ~540 physical lines
//            and never below 60% per axis (36% of the pixels — past that the
//            upscale blur costs more than the frame rate buys),
// and always a multiple of 0.05 so render targets reallocate rarely and the
// debug readout stays meaningful.
//
// Engine contract:
//   - "native" is the backing store AFTER every clamp (DPR limit and the 4K
//     pixel budget): nativeLines = innerHeight * computeEffectivePixelRatio(
//     ..., renderScale = 1), and the applied ratio is that native ratio times
//     `scale`. Feeding the pre-clamp renderScale instead would make whole
//     steps no-ops wherever the budget clamp binds. The ceiling is in the
//     same native terms: drsCeiling(fixed preset ratio, native ratio).
//   - gpu mode: pass `ms = null` on frames without a timer result (query not
//     ready, GPU_DISJOINT_EXT); never substitute the rAF interval — a 16.7 ms
//     vsync interval reads as 1.0T and walks an idle GPU down to the floor.
//
// Two measurement modes, chosen per sample:
//   gpu  (default) `ms` is GPU frame time from the timer query. Headroom is
//        visible, so the controller climbs whenever p90 is comfortably low.
//        Pass `intervalMs` (the rAF interval) too: it arms the CPU-bound
//        guard — when frames are slow but the GPU is idle, resolution is not
//        the problem and lowering it would only blur the image.
//   raf  (gpu: false) `ms` is the rAF interval (no timer query: Firefox, most
//        mobile). Vsync hides headroom, so up-steps are PROBES: +0.05, watch
//        2 s for missed frames, revert on > 3%.
//
// Stability rules (T = 1000 / min(displayHz, targetFps)):
//   - ignored: samples > 250 ms, paused, hitch-flagged (streaming spikes the
//     engine already knows are CPU), and the 1 s after reset() or after the
//     first sample ever (boot frames: shader compiles, texture uploads);
//   - panic: 3 consecutive samples > 1.4T -> scale *= max(sqrt(0.8T/m3), 0.9).
//     Since m3 > 1.4T the sqrt term is < 0.76, so a panic is a bounded 10%
//     step; it may bypass the 5 s gate but not fire twice within 1 s, so a
//     real overload walks down ~10%/s while one unflagged transient costs a
//     single step;
//   - decrease: every 16 valid samples, p90 of the last 32 > 0.9T (gpu) or
//     > 1.05T (raf) -> scale *= clamp(sqrt(0.85T/p90), 0.85, 0.97);
//     any decrease during a raf probe reverts to the probe's starting scale
//     instead — that scale was just measured to hold;
//   - increase: tension <= 0.6 and >= upBlock since the last change;
//     gpu: p90 of the last 180 samples < 0.72T; raf: a probe (see above).
//     A +0.05 step grows pixel cost <= 17% at the floor, so 0.72T lands below
//     the 0.9T decrease line: hysteresis by construction;
//   - back-off: every up-step is on probation for 60 s (or its upBlock + 4 s,
//     if longer). A decrease of any kind inside it — panic, steady or probe
//     revert — fails the step and doubles upBlock (5 s gpu / 10 s raf, up to
//     60 s). The plan's literal "within 4 s" can never catch a steady
//     decrease (the 5 s gate comes first), and even "upBlock + 4 s" lets any
//     periodic load
//     whose heavy phase lands later than that cycle every ~5 s forever (a
//     0.5 s spike every 10.5 s: 43 changes per 300 s); a 60 s probation
//     bounds every period to ~2 changes per minute and only follows loads
//     that change more slowly than that. Relaxation is judged after the
//     fact: a run of up-steps that has gone a full probation without any
//     decrease halves upBlock (again every further 60 s);
//   - at most one change per 5 s in steady state (panic and probe reverts
//     excepted), every sample ring cleared on a change so decisions only see
//     frames rendered at the current scale;
//   - starved: a decrease was due and over budget (panic, or p90 over the
//     limit), not CPU-bound, but the scale already sits at the floor. The
//     engine's in-session preset guard reads this, never "scale == floor":
//     where the native line count is at or below ~568 the floor IS the
//     ceiling, and an idle GPU there would otherwise read as pinned. Set and
//     cleared at each due decision; cleared by any change, reset or
//     configure.

export const DRS_STEP = 0.05
export const DRS_MIN_SCALE = 0.6
export const DRS_MIN_LINES = 540
export const DRS_MAX_SAMPLE_MS = 250
export const DRS_IGNORE_AFTER_RESET_MS = 1000
export const DRS_RING = 32
export const DRS_BLOCK = 16
export const DRS_UP_WINDOW = 180
export const DRS_STEADY_GATE_MS = 5000
export const DRS_PANIC_GATE_MS = 1000
export const DRS_UP_BLOCK_GPU_MS = 5000
export const DRS_UP_BLOCK_RAF_MS = 10000
export const DRS_UP_BLOCK_MAX_MS = 60000
export const DRS_PROBE_MS = 2000
export const DRS_PROBE_MISS_RATIO = 0.03
export const DRS_BACKOFF_WINDOW_MS = 4000
export const DRS_PROBATION_MS = 60000
export const DRS_TENSION_BLOCK = 0.6

const EPS = 1e-9
// Integer grid arithmetic (x * 20) so 0.6, 0.75 ... come out as the exact
// doubles a literal would give: the engine compares scales for equality.
const GRID = Math.round(1 / DRS_STEP)
const quantise = (x) => Math.round(x * GRID) / GRID
const quantiseUp = (x) => Math.ceil(x * GRID - EPS) / GRID
const finite = (v) => typeof v === 'number' && Number.isFinite(v)

// The ceiling for a preset's render scale, as a fraction of native: the ratio
// the fixed path renders that preset at (computeEffectivePixelRatio with its
// render scale) over the native ratio, rounded UP onto the grid (DRS at its
// ceiling never renders below the fixed path) and at most 1. Where the 4K
// pixel budget binds, a preset scale below 1 is a no-op on the fixed path
// (the budget clamp comes last); the ceiling follows, so turning DRS on
// never lowers the at-ceiling resolution.
export function drsCeiling(fixedRatio, nativeRatio) {
  if (!finite(fixedRatio) || !finite(nativeRatio) || fixedRatio <= 0 || nativeRatio <= 0) return 1
  return Math.min(1, quantiseUp(fixedRatio / nativeRatio))
}

// Same nearest-rank definition as PassTimer.percentile, over the first n
// entries of a ring (order irrelevant), sorted in a reused scratch buffer.
function ringPercentile(ring, n, p, scratch) {
  if (!n) return null
  const view = scratch.subarray(0, n)
  view.set(ring.subarray(0, n))
  view.sort()
  return view[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))]
}

class Ring {
  constructor(size) {
    this.data = new Float64Array(size)
    this.n = 0
    this.head = 0
  }
  push(v) {
    this.data[this.head] = v
    this.head = (this.head + 1) % this.data.length
    if (this.n < this.data.length) this.n++
  }
  // i = 0 is the newest sample.
  recent(i) {
    const len = this.data.length
    return this.data[(this.head - 1 - i + len * 2) % len]
  }
  clear() {
    this.n = 0
    this.head = 0
  }
}

export class DynamicResolution {
  constructor({ ceiling = 1, nativeLines = 1080, targetFps = 60, displayHz = 60 } = {}) {
    this._ceiling = 1
    this._nativeLines = 1080
    this._targetFps = 60
    this._displayHz = 60
    this._ring = new Ring(DRS_RING)
    this._upRing = new Ring(DRS_UP_WINDOW)
    this._intervals = new Ring(DRS_RING)
    this._scratch = new Float64Array(DRS_UP_WINDOW)
    this._mode = 'gpu'
    this._now = 0
    this._block = 0
    this._streak = 0
    this._lastChangeAt = -Infinity
    this._resetAt = -Infinity // -Infinity until reset() or the first sample
    this._ignoreUntil = -Infinity
    this._backoff = 1
    this._upAt = null // the latest up-step still on trial
    this._upWindowMs = 0 // a decrease sooner than this after _upAt fails it
    this._holdSince = null // start of the current decrease-free run of up-steps
    this._probe = null // raf mode: { from, startAt, samples, misses }
    this._starved = false
    this.dropped = 0
    this.changes = 0
    this._setParams({ ceiling, nativeLines, targetFps, displayHz })
    this._scale = this._ceiling
  }

  get scale() {
    return this._scale
  }

  get ceiling() {
    return this._ceiling
  }

  get floor() {
    const f = quantiseUp(Math.max(DRS_MIN_SCALE, DRS_MIN_LINES / this._nativeLines))
    return Math.min(f, this._ceiling)
  }

  // Frame budget in ms: the display rate caps what a target can mean (a
  // 60 fps target on a 50 Hz panel is a 20 ms budget).
  get budgetMs() {
    return 1000 / Math.min(this._displayHz, this._targetFps)
  }

  get upBlockMs() {
    return Math.min(DRS_UP_BLOCK_MAX_MS, this._baseUpBlockMs() * this._backoff)
  }

  get mode() {
    return this._mode
  }

  get probing() {
    return this._probe !== null
  }

  // Over budget with nowhere left to go (see "starved" above).
  get starved() {
    return this._starved
  }

  // True when the rAF interval is over budget while the GPU is mostly idle
  // (gpu mode with intervalMs only): decreases are suppressed.
  get cpuBound() {
    if (this._mode !== 'gpu' || this._intervals.n < DRS_BLOCK || !this._ring.n) return false
    const T = this.budgetMs
    const interval = ringPercentile(this._intervals.data, this._intervals.n, 0.9, this._scratch)
    const gpu = ringPercentile(this._ring.data, this._ring.n, 0.9, this._scratch)
    return interval > T && gpu < 0.7 * T
  }

  _baseUpBlockMs() {
    return this._mode === 'gpu' ? DRS_UP_BLOCK_GPU_MS : DRS_UP_BLOCK_RAF_MS
  }

  // Per mode, so doubling stops exactly at 60 s and one halving is visible
  // (a shared cap of 60/5 would leave raf mode at 60 s after a halving).
  _maxBackoff() {
    return DRS_UP_BLOCK_MAX_MS / this._baseUpBlockMs()
  }

  _setParams({ ceiling, nativeLines, targetFps, displayHz }) {
    if (finite(ceiling) && ceiling > 0) this._ceiling = ceiling
    if (finite(nativeLines) && nativeLines > 0) this._nativeLines = nativeLines
    if (finite(targetFps) && targetFps > 0) this._targetFps = targetFps
    if (finite(displayHz) && displayHz > 0) this._displayHz = displayHz
  }

  _clamp(x) {
    return Math.min(this._ceiling, Math.max(this.floor, x))
  }

  // Update any subset of the parameters (preset change -> ceiling, resize or
  // monitor move -> nativeLines/displayHz). The scale is only clamped into
  // the new bounds: a raised ceiling is reached by normal up-steps (or by
  // reset(now, { toCeiling: true })).
  // Returns the new scale when the clamp changed it, else null.
  configure(opts = {}) {
    this._setParams(opts)
    // A new floor or budget: the old verdict no longer applies.
    this._starved = false
    const next = this._clamp(this._scale)
    if (Math.abs(next - this._scale) < EPS) return null
    this._scale = next
    this._probe = null // its starting scale may be outside the new bounds
    return next
  }

  // Drop every sample and ignore the next second (level load, unpause, a
  // preset change: the first frames after those are not representative).
  // `toCeiling` jumps straight to the ceiling — use it when the player just
  // raised the quality and expects to see it; DRS walks back down if needed.
  // Nothing is judged across the discontinuity: the pending up-step trial is
  // dropped (neither failed nor held), the back-off level is kept.
  reset(now, { toCeiling = false } = {}) {
    if (finite(now)) this._now = now
    this._clearSamples()
    this._probe = null
    this._upAt = null
    this._holdSince = null
    this._starved = false
    this._resetAt = this._now
    this._ignoreUntil = this._now + DRS_IGNORE_AFTER_RESET_MS
    if (toCeiling) this._scale = this._ceiling
    return this._scale
  }

  _clearSamples() {
    this._ring.clear()
    this._upRing.clear()
    this._intervals.clear()
    this._block = 0
    this._streak = 0
  }

  // Feed one frame. Returns the new scale when it changed, else null.
  sample(ms, { now, gpu = true, paused = false, hitch = false, tension = 0, intervalMs } = {}) {
    const dt = finite(intervalMs) ? intervalMs : finite(ms) ? ms : 0
    this._now = finite(now) ? now : this._now + dt
    now = this._now

    // Boot frames are as unrepresentative as post-reset ones: the first call
    // opens the same ignore window, unless reset() already did. Up-steps
    // also wait upBlock from here.
    if (this._resetAt === -Infinity) {
      this._resetAt = now
      this._ignoreUntil = now + DRS_IGNORE_AFTER_RESET_MS
    }

    const mode = gpu ? 'gpu' : 'raf'
    if (mode !== this._mode) {
      // GPU ms and rAF intervals are different quantities: never mix them.
      this._mode = mode
      this._clearSamples()
      this._probe = null
      this._upAt = null
      this._holdSince = null
      this._starved = false
      this._backoff = Math.min(this._backoff, this._maxBackoff())
    }

    if (paused || hitch || !finite(ms) || ms < 0 || ms > DRS_MAX_SAMPLE_MS || now < this._ignoreUntil) {
      this.dropped++
      return null
    }

    const T = this.budgetMs
    this._ring.push(ms)
    this._upRing.push(ms)
    if (mode === 'gpu' && finite(intervalMs) && intervalMs >= 0 && intervalMs <= DRS_MAX_SAMPLE_MS) {
      this._intervals.push(intervalMs)
    }
    this._block++
    this._streak = ms > 1.4 * T ? this._streak + 1 : 0
    if (this._probe) {
      this._probe.samples++
      if (ms > 1.5 * T) this._probe.misses++
    }

    const next = this._decide(now, T, mode, tension)
    return next === null ? null : this._apply(next, now)
  }

  _decide(now, T, mode, tension) {
    const scale = this._scale
    const blockDue = this._block >= DRS_BLOCK
    if (blockDue) this._block = 0
    const panicDue = this._streak >= 3 && now - this._lastChangeAt >= DRS_PANIC_GATE_MS
    const steadyDue = blockDue && now - this._lastChangeAt >= DRS_STEADY_GATE_MS

    // Relaxation, judged on evidence (valid samples only): the up-steps since
    // the last decrease have held for a full probation.
    if (this._holdSince !== null && now - this._holdSince >= DRS_PROBATION_MS) {
      this._backoff = Math.max(1, this._backoff / 2)
      this._holdSince = now
    }

    // Decreases first: a frame over budget outranks everything else. The
    // CPU-bound guard is only evaluated when a decrease is actually due.
    if (panicDue || steadyDue) {
      let target = null
      if (panicDue) {
        const a = this._ring.recent(0)
        const b = this._ring.recent(1)
        const c = this._ring.recent(2)
        const median3 = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))
        target = scale * Math.max(Math.sqrt((0.8 * T) / median3), 0.9)
      } else {
        const p90 = ringPercentile(this._ring.data, this._ring.n, 0.9, this._scratch)
        const limit = mode === 'gpu' ? 0.9 * T : 1.05 * T
        if (p90 > limit) target = scale * Math.min(0.97, Math.max(0.85, Math.sqrt((0.85 * T) / p90)))
      }
      const over = target !== null && !this.cpuBound
      const atFloor = scale <= this.floor + EPS
      this._starved = over && atFloor
      if (over && !atFloor) {
        // The probe is the only thing that changed: undo it rather than cut
        // below a scale that was just measured to hold.
        if (this._probe && this._probe.from < scale) return this._probe.from
        return this._down(target)
      }
    }

    // raf probe verdict: > 3% missed frames in the 2 s after the up-step.
    if (this._probe && now - this._probe.startAt >= DRS_PROBE_MS) {
      const { from, samples, misses } = this._probe
      this._probe = null
      if (samples > 0 && misses > DRS_PROBE_MISS_RATIO * samples && from < scale) return from
    }

    if (tension > DRS_TENSION_BLOCK || scale >= this._ceiling - EPS || this._probe) return null
    const since = now - Math.max(this._lastChangeAt, this._resetAt)
    if (since < this.upBlockMs) return null
    if (mode === 'gpu') {
      if (this._upRing.n < DRS_UP_WINDOW) return null
      const p90 = ringPercentile(this._upRing.data, this._upRing.n, 0.9, this._scratch)
      return p90 < 0.72 * T ? scale + DRS_STEP : null
    }
    // raf: probe only from a healthy baseline (not while already missing).
    if (this._ring.n < DRS_BLOCK) return null
    const p90 = ringPercentile(this._ring.data, this._ring.n, 0.9, this._scratch)
    if (p90 > 1.05 * T) return null
    this._probe = { from: scale, startAt: now, samples: 0, misses: 0 }
    return scale + DRS_STEP
  }

  // Nearest grid point, but always at least one full step down (a 3% cut
  // would otherwise round back to the current scale).
  _down(x) {
    return Math.min(quantise(x), quantise(this._scale - DRS_STEP))
  }

  _apply(target, now) {
    const next = this._clamp(quantise(target))
    if (Math.abs(next - this._scale) < EPS) {
      this._probe = null
      return null
    }
    if (next > this._scale) {
      // upBlockMs here is still the wait that led to this step.
      this._upAt = now
      this._upWindowMs = Math.max(DRS_PROBATION_MS, this.upBlockMs + DRS_BACKOFF_WINDOW_MS)
      if (this._holdSince === null) this._holdSince = now
    } else {
      this._probe = null
      if (this._upAt !== null && now - this._upAt < this._upWindowMs) {
        this._backoff = Math.min(this._maxBackoff(), this._backoff * 2)
      }
      this._upAt = null
      this._holdSince = null
    }
    this._lastChangeAt = now
    this._scale = next
    this._starved = false
    this.changes++
    // Only frames rendered at the new scale may drive the next decision. The
    // interval ring survives: CPU-boundness does not depend on resolution.
    this._ring.clear()
    this._upRing.clear()
    this._block = 0
    this._streak = 0
    return next
  }
}
