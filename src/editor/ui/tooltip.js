import { commandById, commandState, formatChord } from './keymap.js'

// Rich tooltips for every editor control: a title, a one-line description,
// shortcut chips and the reason a control is unavailable. One delegated set
// of listeners on the editor root; any element carrying
//   data-cmd="edit.undo"            (title, hint, keys and state from the keymap)
//   data-tip="…" [data-tip-title] [data-tip-keys="Mod+Z R"] [data-tip-side]
//   or a plain title="…" attribute  (converted on first hover)
// gets one. Shows after ~350 ms on hover, on keyboard focus, hides on
// pointerdown / scroll / Escape, and is wired with aria-describedby on the
// focusable control. Hoverable (WCAG 1.4.13): moving onto the tooltip keeps it.

const SELECTOR = '[data-tip],[data-tip-title],[data-cmd],[title]'
const DELAY = 350
const WARM_MS = 800

export const isMac = () => typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || '')

export function installTooltips(root, app) {
  const tip = document.createElement('div')
  tip.className = 'edt-tooltip'
  tip.id = 'edt-tooltip'
  tip.setAttribute('role', 'tooltip')
  tip.hidden = true
  document.body.appendChild(tip)

  let target = null
  let described = null // the element carrying aria-describedby (the focusable control)
  let timer = 0
  let hideTimer = 0
  let lastHide = 0
  const mac = isMac()

  const content = (el) => {
    // Promote native titles so the browser never shows a second tooltip.
    if (el.hasAttribute('title')) {
      if (!el.dataset.tip) el.dataset.tip = el.getAttribute('title')
      el.removeAttribute('title')
    }
    const cmd = el.dataset.cmd ? commandById(el.dataset.cmd) : null
    let title = el.dataset.tipTitle || ''
    let text = el.dataset.tip || ''
    let keys = el.dataset.tipKeys ? el.dataset.tipKeys.split(' ') : []
    let note = ''
    let scope = ''
    if (cmd) {
      title ||= cmd.label
      text ||= cmd.hint
      if (!keys.length && cmd.keys) keys = cmd.keys
      const st = commandState(cmd, app)
      if (!st.enabled) note = `Unavailable: ${st.reason}`
      if (cmd.undo && !text.toLowerCase().includes(cmd.undo)) scope = cmd.undo === 'undoable' ? 'Undoable (Ctrl/⌘+Z)' : 'Not undoable'
    }
    if (el.dataset.disabledReason) note = `Unavailable: ${el.dataset.disabledReason}`
    if (!title && !text) return null
    return { title, text, keys, note, scope, when: cmd?.when }
  }

  const render = (c) => {
    tip.textContent = ''
    if (c.title) {
      const t = document.createElement('div')
      t.className = 'edt-tooltip-title'
      t.textContent = c.title
      if (c.keys.length) {
        const chips = document.createElement('span')
        chips.className = 'edt-tooltip-keys'
        for (const k of c.keys) {
          const kbd = document.createElement('kbd')
          kbd.textContent = formatChord(k, { mac })
          chips.appendChild(kbd)
        }
        t.appendChild(chips)
      }
      tip.appendChild(t)
    }
    if (c.text) {
      const d = document.createElement('div')
      d.className = 'edt-tooltip-text'
      d.textContent = c.text
      tip.appendChild(d)
    }
    if (!c.title && c.keys.length) {
      const d = document.createElement('div')
      d.className = 'edt-tooltip-text'
      d.textContent = `Shortcut: ${c.keys.map((k) => formatChord(k, { mac })).join(' / ')}`
      tip.appendChild(d)
    }
    if (c.scope) {
      const d = document.createElement('div')
      d.className = 'edt-tooltip-meta'
      d.textContent = c.scope
      tip.appendChild(d)
    }
    if (c.note) {
      const d = document.createElement('div')
      d.className = 'edt-tooltip-note'
      d.textContent = c.note
      tip.appendChild(d)
    }
  }

  const place = (el) => {
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    tip.style.left = '0px'
    tip.style.top = '0px'
    tip.style.maxWidth = `${Math.min(320, vw - 16)}px`
    const tw = tip.offsetWidth
    const th = tip.offsetHeight
    let x
    let y
    const side = el.dataset.tipSide || el.closest('[data-tip-side]')?.dataset.tipSide
    if (side === 'right') {
      x = r.right + 8
      y = r.top + r.height / 2 - th / 2
      if (x + tw > vw - 8) x = r.left - tw - 8
    } else {
      x = r.left + r.width / 2 - tw / 2
      y = r.bottom + 8
      if (y + th > vh - 8) y = r.top - th - 8
    }
    x = Math.max(8, Math.min(vw - tw - 8, x))
    y = Math.max(8, Math.min(vh - th - 8, y))
    tip.style.left = `${Math.round(x)}px`
    tip.style.top = `${Math.round(y)}px`
  }

  // Tips often sit on a wrapper (the <label> of a checkbox, the row of a
  // slider): describe the control inside it, which is what has focus.
  const FOCUSABLE = 'input, select, textarea, button, [tabindex]'
  const describedFor = (el) => {
    const a = document.activeElement
    if (a && a !== el && el.contains(a)) return a
    if (el.matches(FOCUSABLE)) return el
    return el.querySelector('input, select, textarea, button') ?? el
  }
  const unDescribe = () => {
    if (!described) return
    const prev = described.dataset.prevDescribedby
    if (prev) described.setAttribute('aria-describedby', prev)
    else described.removeAttribute('aria-describedby')
    delete described.dataset.prevDescribedby
    described = null
  }

  // An anchor that is removed or hidden (panel collapsed, list rebuilt)
  // never fires pointerout: watch it while the tooltip is up.
  let watch = 0
  const watchAnchor = () => {
    cancelAnimationFrame(watch)
    const tick = () => {
      if (tip.hidden || !target) return
      if (!target.isConnected || target.getClientRects().length === 0) {
        hide()
        return
      }
      watch = requestAnimationFrame(tick)
    }
    watch = requestAnimationFrame(tick)
  }

  const show = (el) => {
    const c = content(el)
    if (!c) return
    clearTimeout(hideTimer)
    render(c)
    tip.hidden = false
    place(el)
    target = el
    watchAnchor()
    const d = describedFor(el)
    if (d !== described) unDescribe()
    described = d
    const prev = d.getAttribute('aria-describedby')
    if (prev !== tip.id) {
      d.dataset.prevDescribedby = prev ?? ''
      d.setAttribute('aria-describedby', tip.id)
    }
  }

  const hide = () => {
    clearTimeout(timer)
    clearTimeout(hideTimer)
    timer = 0
    if (!tip.hidden) lastHide = performance.now()
    tip.hidden = true
    unDescribe()
    target = null
  }
  // WCAG 1.4.13: the tooltip stays while the pointer moves from the control
  // onto it (short grace period), and while the pointer is over it.
  const hideSoon = () => {
    clearTimeout(timer)
    clearTimeout(hideTimer)
    hideTimer = setTimeout(hide, 160)
  }
  tip.addEventListener('pointerenter', () => clearTimeout(hideTimer))
  tip.addEventListener('pointerleave', (e) => {
    if (target && e.relatedTarget instanceof Node && target.contains(e.relatedTarget)) return
    hideSoon()
  })

  const schedule = (el, delay) => {
    clearTimeout(timer)
    const warm = performance.now() - lastHide < WARM_MS || !tip.hidden
    timer = setTimeout(() => show(el), warm ? 0 : delay)
  }

  const findTarget = (node) => (node instanceof Element ? node.closest(SELECTOR) : null)

  const onOver = (e) => {
    if (e.pointerType === 'touch') return
    const el = findTarget(e.target)
    if (!el || !(root.contains(el) || el.closest('.edt-overlay'))) {
      // Moving onto anything without a tooltip (the plan, a gap) ends the
      // current one — its anchor may have been hidden without a pointerout.
      if (target && !tip.contains(e.target)) hideSoon()
      return
    }
    if (el === target) { clearTimeout(hideTimer); return }
    if (target) hide()
    schedule(el, DELAY)
  }
  const onOut = (e) => {
    const el = findTarget(e.target)
    if (!el) return
    if (el.contains(e.relatedTarget)) return
    if (tip.contains(e.relatedTarget)) return
    if (tip.hidden) hide()
    else hideSoon()
  }
  const onFocus = (e) => {
    const el = findTarget(e.target)
    if (!el) return
    // Keyboard focus only — a mouse click focusing a button should not pop one.
    let keyboard = true
    try { keyboard = e.target.matches(':focus-visible') } catch { /* old engines */ }
    if (!keyboard) return
    if (target && target !== el) hide()
    schedule(el, 150)
  }

  document.addEventListener('pointerover', onOver)
  document.addEventListener('pointerout', onOut)
  document.addEventListener('focusin', onFocus)
  document.addEventListener('focusout', () => hide())
  document.addEventListener('pointerdown', (e) => { if (!tip.contains(e.target)) hide() }, true)
  document.addEventListener('wheel', () => hide(), { passive: true, capture: true })
  document.addEventListener('scroll', () => hide(), true)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !tip.hidden) {
      hide()
      e.stopPropagation()
      e.preventDefault()
    }
  }, true)

  return {
    hide,
    get visible() { return !tip.hidden },
    // Refresh the visible tooltip after a state change (e.g. undo stack).
    update() { if (target && !tip.hidden) show(target) },
  }
}
