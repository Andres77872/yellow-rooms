import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNELS, CHANNEL_TIPS, LIGHT_DEBUG, LIGHT_DEBUG_TIPS, LIGHT_TIPS } from '../LightTool.js'
import { AI_PARAM_TIPS } from '../AiTool.js'
import { installDebugTooltip, TOOLTIP_ID } from '../debugTooltip.js'

// vitest runs without a DOM, so tooltip coverage is checked statically (as in
// src/editor/__tests__/ui-tooltips.test.js): every interactive widget-builder
// call in the in-game debug tools must pass a `tip` (segmented: `tips`), and
// the label-keyed tip tables must cover every helper-bound control.

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOOL_FILES = ['AiTool.js', 'LightTool.js', 'PerfTool.js', 'WorldMapTool.js', 'DebugMode.js']
const source = (f) => readFileSync(join(DIR, f), 'utf8')

// Arguments of every call `name(` in `text` (balanced parentheses, strings
// and template literals skipped), excluding definitions and imports.
function callArgs(text, name) {
  const out = []
  const re = new RegExp(`(^|[^\\w.$])${name}\\(`, 'g')
  let m
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length
    const before = text.slice(Math.max(0, m.index - 12), m.index + m[1].length)
    if (/function\s*$/.test(before)) continue
    let depth = 1
    let i = start
    let quote = null
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i]
      if (quote) {
        if (ch === '\\') i++
        else if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch
      else if (ch === '(') depth++
      else if (ch === ')') depth--
    }
    const line = text.slice(0, m.index).split('\n').length
    out.push({ args: text.slice(start, i - 1), line })
  }
  return out
}

// Same idea for method calls `this.name(`.
function methodArgs(text, name) {
  return callArgs(text.replaceAll(`this.${name}(`, ` ${name}(`), name).filter(
    ({ args }) => !/^\s*sec\s*,\s*label\b/.test(args) // the binder's own signature
  )
}

const TIP = /\btips?\s*:/
// Builders a file actually imports from the widget kit (DebugMode has its
// own `toggle()` method, which is not a widget).
const imported = (text) =>
  new Set(/import \{([^}]*)\} from '\.\/widgets\.js'/.exec(text)?.[1].split(',').map((n) => n.trim()) ?? [])
const BUILDERS = ['button', 'toggle', 'slider', 'colorPicker']

describe('debug tool tooltips', () => {
  it('passes a tip to every button / toggle / slider / colorPicker', () => {
    let total = 0
    for (const f of TOOL_FILES) {
      const text = source(f)
      for (const name of BUILDERS.filter((n) => imported(text).has(n))) {
        for (const { args, line } of callArgs(text, name)) {
          total++
          expect(TIP.test(args), `${f}:${line} ${name}(${args.slice(0, 80)}…)`).toBe(true)
        }
      }
    }
    expect(total).toBeGreaterThan(40)
  })

  it('passes one tip per option to every segmented control', () => {
    let total = 0
    for (const f of TOOL_FILES) {
      if (!imported(source(f)).has('segmented')) continue
      for (const { args, line } of callArgs(source(f), 'segmented')) {
        total++
        expect(/\btips\s*:/.test(args), `${f}:${line} segmented(${args.slice(0, 80)}…)`).toBe(true)
      }
    }
    expect(total).toBe(7)
    expect(CHANNEL_TIPS).toHaveLength(CHANNELS.length)
    expect(LIGHT_DEBUG_TIPS).toHaveLength(LIGHT_DEBUG.length)
  })

  it('covers every LightTool uniform binder label', () => {
    const text = source('LightTool.js')
    const labels = []
    for (const binder of ['_f', '_fMulti', '_fVec', '_c']) {
      for (const { args, line } of methodArgs(text, binder)) {
        const label = /^\s*\w+\s*,\s*'([^']+)'/.exec(args)?.[1]
        expect(label, `LightTool.js:${line} ${binder}(${args.slice(0, 60)}…)`).toBeTruthy()
        labels.push(label)
      }
    }
    expect(labels.length).toBeGreaterThan(50)
    expect(new Set(labels).size).toBe(labels.length) // label-keyed: must be unique
    for (const label of labels) expect(LIGHT_TIPS[label], label).toBeTruthy()
    expect(Object.keys(LIGHT_TIPS).sort()).toEqual([...labels].sort()) // no stale entries
  })

  it('covers every AiTool param scrub', () => {
    const keys = callArgs(source('AiTool.js'), 'add').map(({ args }) => /^\s*'(\w+)'/.exec(args)?.[1])
    expect(keys.length).toBe(9)
    for (const key of keys) expect(AI_PARAM_TIPS[key], key).toBeTruthy()
  })

  it('tips the hand-built controls (tabs, collapse, seed input, map canvas)', () => {
    const dbg = source('DebugMode.js')
    expect(dbg).toMatch(/applyTip\(b, TAB_TIPS\[t\]\)/)
    expect(dbg).toMatch(/applyTip\(head\.querySelector\('#dbg-collapse'\)/)
    expect(dbg).not.toMatch(/title="/) // native titles would double the tooltip
    for (const t of ['world', 'light', 'ai', 'perf']) expect(dbg).toMatch(new RegExp(`\\b${t}: \\{ title:`))
    const map = source('WorldMapTool.js')
    expect(map).toMatch(/applyTip\(this\._seedInput,/)
    expect(map).toMatch(/applyTip\(canvas,/)
  })
})

// --- Tooltip layer on a minimal fake DOM -------------------------------------

class FakeEl {
  constructor(doc, tag) {
    this.doc = doc
    this.tagName = tag.toUpperCase()
    this.children = []
    this.parent = null
    this.dataset = {}
    this.attrs = {}
    this.style = {}
    this.listeners = {}
    this.textContent = ''
    this.offsetWidth = 120
    this.offsetHeight = 30
    this.rect = { left: 500, top: 100, width: 100, height: 20 }
    this.focusVisible = false
  }
  appendChild(c) {
    c.parent = this
    this.children.push(c)
    return c
  }
  append(...cs) {
    for (const c of cs) this.appendChild(c)
  }
  replaceChildren() {
    this.children = []
  }
  remove() {
    if (!this.parent) return
    this.parent.children = this.parent.children.filter((c) => c !== this)
    this.parent = null
  }
  get isConnected() {
    let n = this
    while (n.parent) n = n.parent
    return n === this.doc.body
  }
  contains(n) {
    for (; n; n = n.parent) if (n === this) return true
    return false
  }
  matches(sel) {
    if (sel === ':focus-visible') return this.focusVisible
    if (sel === '[data-tip],[data-tip-title]') return this.dataset.tip !== undefined || this.dataset.tipTitle !== undefined
    return sel.split(',').includes(this.tagName.toLowerCase())
  }
  closest(sel) {
    for (let n = this; n; n = n.parent) if (n.matches(sel)) return n
    return null
  }
  getClientRects() {
    for (let n = this; n; n = n.parent) if (n.style.display === 'none') return []
    return [this.rect]
  }
  getBoundingClientRect() {
    const r = this.rect
    return { ...r, right: r.left + r.width, bottom: r.top + r.height }
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v)
  }
  getAttribute(k) {
    return this.attrs[k] ?? null
  }
  removeAttribute(k) {
    delete this.attrs[k]
  }
  addEventListener(type, fn) {
    ;(this.listeners[type] ??= new Set()).add(fn)
  }
  removeEventListener(type, fn) {
    this.listeners[type]?.delete(fn)
  }
  fire(type, props = {}) {
    const e = { type, target: this, ...props }
    for (let n = this; n; n = n.parent) for (const fn of n.listeners[type] ?? []) fn(e)
  }
}

function fakeDom() {
  const frames = []
  const winListeners = {}
  const win = {
    innerWidth: 1280,
    innerHeight: 720,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    requestAnimationFrame: (fn) => frames.push(fn),
    cancelAnimationFrame: () => {},
    addEventListener: (t, fn) => (winListeners[t] ??= new Set()).add(fn),
    removeEventListener: (t, fn) => winListeners[t]?.delete(fn),
    fire: (t, e = {}) => [...(winListeners[t] ?? [])].forEach((fn) => fn({ type: t, ...e })),
    listenerCount: () => Object.values(winListeners).reduce((n, s) => n + s.size, 0),
  }
  const doc = { defaultView: win, activeElement: null }
  doc.createElement = (tag) => new FakeEl(doc, tag)
  doc.body = new FakeEl(doc, 'body')
  const flush = () => frames.splice(0).forEach((fn) => fn())
  return { doc, win, flush }
}

describe('installDebugTooltip', () => {
  let dom, root, row, input, btn, tt
  beforeEach(() => {
    vi.useFakeTimers()
    dom = fakeDom()
    root = dom.doc.createElement('div')
    root.rect = { left: 900, top: 8, width: 348, height: 600 }
    dom.doc.body.appendChild(root)
    row = root.appendChild(dom.doc.createElement('div'))
    row.dataset.tip = 'Lamp falloff radius.'
    input = row.appendChild(dom.doc.createElement('input'))
    btn = root.appendChild(dom.doc.createElement('button'))
    btn.dataset.tipTitle = 'Collapse'
    btn.dataset.tip = 'Minimize.'
    btn.dataset.tipKeys = 'F2 F3'
    tt = installDebugTooltip(root, { doc: dom.doc })
  })
  afterEach(() => {
    tt.dispose()
    vi.useRealTimers()
  })

  const tipEl = () => dom.doc.body.children.find((c) => c.attrs.role === 'tooltip')

  it('shows after the hover delay, with title, text and keys', () => {
    btn.fire('pointerover', { pointerType: 'mouse' })
    expect(tipEl().style.display).not.toBe('block')
    vi.advanceTimersByTime(349)
    expect(tt.anchor).toBe(null)
    vi.advanceTimersByTime(2)
    expect(tt.anchor).toBe(btn)
    expect(tipEl().style.display).toBe('block')
    const [title, text, keys] = tipEl().children
    expect(title.textContent).toBe('Collapse')
    expect(text.textContent).toBe('Minimize.')
    expect(keys.children.map((k) => k.textContent)).toEqual(['F2', 'F3'])
    expect(btn.getAttribute('aria-describedby')).toBe(TOOLTIP_ID)
    // Placed left of the panel, clamped inside the viewport.
    const [, x, y] = /translate\((-?\d+)px, (-?\d+)px\)/.exec(tipEl().style.transform).map(Number)
    expect(x + 120).toBeLessThanOrEqual(900)
    expect(x).toBeGreaterThanOrEqual(8)
    expect(y).toBeGreaterThanOrEqual(8)
  })

  it('shows immediately on keyboard focus and describes the focused input', () => {
    input.focusVisible = true
    input.fire('focusin')
    expect(tt.anchor).toBe(row)
    expect(input.getAttribute('aria-describedby')).toBe(TOOLTIP_ID)
    input.fire('focusout', { relatedTarget: null })
    expect(tt.anchor).toBe(null)
    expect(input.getAttribute('aria-describedby')).toBe(null)
  })

  it('ignores mouse (non focus-visible) focus', () => {
    input.fire('focusin')
    expect(tt.anchor).toBe(null)
  })

  it('hides on pointerdown, Escape and scroll and drops window listeners', () => {
    input.focusVisible = true
    for (const close of [
      () => dom.win.fire('pointerdown'),
      () => dom.win.fire('keydown', { key: 'Escape' }),
      () => dom.win.fire('scroll'),
      () => root.fire('scroll'),
    ]) {
      input.fire('focusin')
      expect(tt.anchor).toBe(row)
      expect(dom.win.listenerCount()).toBeGreaterThan(0)
      close()
      expect(tt.anchor).toBe(null)
      expect(dom.win.listenerCount()).toBe(0)
    }
  })

  it('cancels a pending hover when the control is pressed', () => {
    btn.fire('pointerover', { pointerType: 'mouse' })
    btn.fire('pointerdown')
    vi.advanceTimersByTime(1000)
    expect(tt.anchor).toBe(null)
  })

  it('cancels a pending hover when the pointer leaves', () => {
    btn.fire('pointerover', { pointerType: 'mouse' })
    btn.fire('pointerout', { relatedTarget: root })
    vi.advanceTimersByTime(1000)
    expect(tt.anchor).toBe(null)
  })

  it('hides once its anchor is detached or no longer rendered', () => {
    input.focusVisible = true
    input.fire('focusin')
    dom.flush()
    expect(tt.anchor).toBe(row)
    root.style.display = 'none' // tab switch / panel close
    dom.flush()
    expect(tt.anchor).toBe(null)
    root.style.display = ''
    btn.fire('pointerover', { pointerType: 'mouse' })
    vi.advanceTimersByTime(400)
    expect(tt.anchor).toBe(btn)
    btn.remove()
    dom.flush()
    expect(tt.anchor).toBe(null)
    expect(tipEl().style.display).toBe('none')
  })

  it('removes its element on dispose', () => {
    tt.dispose()
    expect(tipEl()).toBeUndefined()
  })
})
