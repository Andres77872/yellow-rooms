// Boot loading screen. Its markup and critical CSS live inline in index.html
// so the screen paints before a byte of the bundle has arrived; this module
// takes it over once main.js runs and walks it through the real boot stages.
//
// Everything that moves is a transform/opacity animation: browsers run those
// on the compositor, so the tube keeps creeping and the glint keeps sweeping
// while the Engine constructor, the title prewarm and the first shader link
// hold the main thread for a second or more. Text updates cannot paint during
// such a block, which is why main.js waits for `painted()` after every stage.

// `floor` is where a stage's progress starts, `ceil` where its creep stops
// (the tube approaches it without ever claiming the stage finished), `creepMs`
// how long that approach takes. Indices continue the HTML's 01 (fetch).
export const BOOT_STAGES = Object.freeze({
  renderer: Object.freeze({ step: 2, label: 'WAKING THE RENDERER', floor: 0.32, ceil: 0.6, creepMs: 5000 }),
  lights: Object.freeze({ step: 3, label: 'WARMING THE TUBES', floor: 0.62, ceil: 0.82, creepMs: 4000 }),
  furnish: Object.freeze({ step: 4, label: 'FURNISHING THE ROOMS', floor: 0.85, ceil: 0.97, creepMs: 3000 }),
})
export const BOOT_STEP_COUNT = 4
export const BOOT_DONE_LABEL = 'THE HUM IS STEADY'

// The tube fills to the end, then the screen fades off the live world.
const FILL_MS = 320
const FADE_MS = 700

// Run `fn` once the current DOM state has been presented: the first frame
// commits it, the second callback starts after that frame was drawn. A hidden
// tab fires no animation frames, so it runs on a timer there; with no
// rendering loop at all (headless tests) it runs synchronously.
export function afterPaint(fn) {
  const raf = globalThis.requestAnimationFrame
  if (typeof raf !== 'function') {
    fn()
    return
  }
  if (globalThis.document?.hidden) {
    setTimeout(fn, 0)
    return
  }
  raf(() => raf(() => fn()))
}

export const painted = () => new Promise((resolve) => afterPaint(resolve))

// Resolves with the promise's value, or with `undefined` after `ms`.
export function settleWithin(promise, ms) {
  let timer
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms)
    }),
  ])
}

// scaleX of a computed `transform` ('none', 'matrix(a, …)', 'matrix3d(a, …)').
export function readScaleX(transform) {
  const m = /^matrix(?:3d)?\(\s*([-\d.e+]+)/.exec(transform ?? '')
  const v = m ? Number(m[1]) : 0
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0
}

const pad2 = (n) => String(n).padStart(2, '0')

export class BootLoader {
  // `root` is index.html's #boot; a page without it (the editor, tests) gets
  // a loader whose every method is a no-op.
  constructor(root) {
    this.root = root ?? null
    const $ = (sel) => this.root?.querySelector(sel) ?? null
    this.fill = $('.fill')
    this.tube = $('.tube')
    this.label = $('.boot-label')
    this.step = $('.boot-step')
    this._anim = null
    this._done = false
    this._reduced = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    // From here on, failures are main.js's to report (the fatal panel); the
    // inline fallback only covers a bundle that never ran.
    if (this.root?.dataset) this.root.dataset.live = '1'
  }

  _progress() {
    if (!this.fill) return 0
    try {
      return readScaleX(getComputedStyle(this.fill).transform)
    } catch {
      return 0
    }
  }

  // Move the tube from wherever it is now: a short catch-up to `to`, then
  // (when `creepTo` is given) a long ease towards it that keeps running on
  // the compositor while the stage's work blocks the main thread.
  _drive(to, { creepTo = to, creepMs = 0, catchUpMs = FILL_MS } = {}) {
    const fill = this.fill
    if (!fill) return
    const from = Math.max(this._progress(), 0)
    to = Math.max(from, to)
    creepTo = Math.max(to, creepTo)
    this._anim?.cancel?.()
    this._anim = null
    // The inline CSS creep has done its job; the animations below own the tube.
    fill.style.animation = 'none'
    fill.style.transform = `scaleX(${creepTo})`
    if (this._reduced || typeof fill.animate !== 'function') return
    const total = catchUpMs + creepMs
    const frames = [{ transform: `scaleX(${from})`, easing: 'cubic-bezier(.2,.7,.3,1)' }]
    if (creepMs > 0 && creepTo > to) {
      frames.push({ transform: `scaleX(${to})`, offset: catchUpMs / total, easing: 'cubic-bezier(.08,.55,.25,1)' })
    }
    frames.push({ transform: `scaleX(${creepTo})` })
    this._anim = fill.animate(frames, { duration: total, fill: 'forwards' })
  }

  _setText(label, step) {
    if (this.label) this.label.textContent = label
    if (this.step) this.step.textContent = `${pad2(step)}/${pad2(BOOT_STEP_COUNT)}`
  }

  // Enter a named stage (BOOT_STAGES). Stages only move forward.
  stage(name) {
    const s = BOOT_STAGES[name]
    if (!s || !this.root || this._done) return
    this._setText(s.label, s.step)
    this.tube?.setAttribute('aria-valuenow', String(Math.round(s.floor * 100)))
    this._drive(s.floor, { creepTo: s.ceil, creepMs: s.creepMs })
  }

  // Fill the tube, let it bloom, then fade the screen off the live world.
  // `onReveal` runs as the fade starts (the title's arrival plays under it);
  // resolves once the element is gone.
  finish(onReveal) {
    if (!this.root || this._done) {
      onReveal?.()
      return Promise.resolve()
    }
    this._done = true
    this._setText(BOOT_DONE_LABEL, BOOT_STEP_COUNT)
    this.tube?.setAttribute('aria-valuenow', '100')
    this.root.setAttribute('aria-busy', 'false')
    this._drive(1)
    this.root.classList.add('lit')
    const fill = this._reduced ? 0 : FILL_MS
    const fade = this._reduced ? 0 : FADE_MS
    return new Promise((resolve) => {
      setTimeout(() => {
        onReveal?.()
        this.root.classList.add('out')
        setTimeout(() => {
          this.remove()
          resolve()
        }, fade)
      }, fill)
    })
  }

  remove() {
    this._done = true
    this._anim?.cancel?.()
    this._anim = null
    this.root?.remove?.()
  }
}
