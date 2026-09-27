// Delegated tooltip layer for the in-game debug panel (F2). Controls built by
// widgets.js carry their help as data attributes (applyTip: data-tip,
// data-tip-title, data-tip-keys); this module renders ONE shared tooltip for
// every anchor inside `root`.
//
// - hover: shown after `delay` ms; keyboard focus: shown immediately
// - hidden on pointerdown, scroll, Escape, focus/pointer leaving the anchor
// - the focused/hovered control gets aria-describedby -> the tooltip
// - placed to the LEFT of the panel (never covers the controls); falls back to
//   below/above the anchor on narrow viewports, always clamped on screen
// - while visible, a rAF loop re-places it and hides it once the anchor is
//   detached or no longer rendered (tab switch, section collapse, panel close)
//
// All listeners are on `root` except the window pointerdown/keydown/scroll
// ones, which exist only while a tooltip is visible — so with the panel
// closed (display:none, no hover/focus possible) nothing here touches
// gameplay input or pointer lock.

export const TOOLTIP_ID = 'dbg-tip'
const ANCHOR = '[data-tip],[data-tip-title]'
const GAP = 8
const MARGIN = 8

export const TOOLTIP_CSS = `
#dbg-tip{ position:fixed; left:0; top:0; z-index:61; max-width:260px; pointer-events:none;
  font:11px/1.45 ui-monospace,"Courier New",monospace; color:#f4ecc0;
  background:rgba(12,11,6,.97); border:1px solid #8a7628; border-radius:3px;
  padding:5px 7px; box-shadow:0 4px 14px rgba(0,0,0,.55); display:none; }
#dbg-tip .tt{ color:#f8f1a8; font-weight:700; letter-spacing:.08em; margin-bottom:2px; }
#dbg-tip .tx{ color:#e8e0b8; white-space:normal; }
#dbg-tip .tk{ margin-top:4px; display:flex; flex-wrap:wrap; gap:3px; }
#dbg-tip kbd{ font:inherit; font-size:10px; color:#15130a; background:#cdbf6e; border-radius:2px;
  padding:0 4px; }
`

export function installDebugTooltip(root, { delay = 350, doc = document } = {}) {
  const win = doc.defaultView ?? globalThis
  const tip = doc.createElement('div')
  tip.id = TOOLTIP_ID
  tip.setAttribute('role', 'tooltip')
  const title = doc.createElement('div')
  title.className = 'tt'
  const text = doc.createElement('div')
  text.className = 'tx'
  const keys = doc.createElement('div')
  keys.className = 'tk'
  tip.append(title, text, keys)
  doc.body.appendChild(tip)

  let anchor = null // element whose tip is shown
  let described = null // element carrying our aria-describedby
  let prevDescribed = null // its previous aria-describedby (restored on hide)
  let pending = null // anchor waiting on the hover delay
  let timer = 0
  let raf = 0

  const anchorOf = (node) => {
    const a = node?.closest?.(ANCHOR)
    return a && root.contains(a) ? a : null
  }

  const cancel = () => {
    if (timer) win.clearTimeout(timer)
    timer = 0
    pending = null
  }

  const visible = (a) => a.isConnected && a.getClientRects().length > 0

  const place = () => {
    const r = anchor.getBoundingClientRect()
    const pr = root.getBoundingClientRect()
    const vw = win.innerWidth
    const vh = win.innerHeight
    const w = tip.offsetWidth
    const h = tip.offsetHeight
    let x = pr.left - GAP - w
    let y = r.top + r.height / 2 - h / 2
    if (x < MARGIN) {
      // Not enough room beside the panel: below the anchor, else above.
      x = r.left
      y = r.bottom + GAP
      if (y + h > vh - MARGIN) y = r.top - GAP - h
    }
    x = Math.max(MARGIN, Math.min(x, vw - MARGIN - w))
    y = Math.max(MARGIN, Math.min(y, vh - MARGIN - h))
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  }

  const tick = () => {
    raf = 0
    if (!anchor) return
    if (!visible(anchor)) {
      hide()
      return
    }
    place()
    raf = win.requestAnimationFrame(tick)
  }

  const onWinPointerDown = () => hide()
  const onWinScroll = () => hide()
  const onWinKey = (e) => {
    if (e.key === 'Escape') hide()
  }

  function show(a, target) {
    cancel()
    if (!visible(a)) return
    const body = a.dataset.tip ?? ''
    const head = a.dataset.tipTitle ?? ''
    if (!body && !head) return
    if (anchor) hide()
    anchor = a
    title.textContent = head
    title.style.display = head ? '' : 'none'
    text.textContent = body
    text.style.display = body ? '' : 'none'
    keys.replaceChildren()
    const k = a.dataset.tipKeys
    if (k) {
      for (const key of k.split(' ').filter(Boolean)) {
        const kbd = doc.createElement('kbd')
        kbd.textContent = key
        keys.appendChild(kbd)
      }
    }
    keys.style.display = k ? '' : 'none'
    // Describe the actual control (the input inside a slider/toggle row when
    // it is the focus/hover target), else the anchor itself.
    described = target && a.contains(target) && target.matches?.('input,button,select,textarea') ? target : a
    prevDescribed = described.getAttribute('aria-describedby')
    described.setAttribute('aria-describedby', TOOLTIP_ID)
    tip.style.display = 'block'
    place()
    win.addEventListener('pointerdown', onWinPointerDown, true)
    win.addEventListener('scroll', onWinScroll, true)
    win.addEventListener('keydown', onWinKey, true)
    raf = win.requestAnimationFrame(tick)
  }

  function hide() {
    cancel()
    if (raf) win.cancelAnimationFrame(raf)
    raf = 0
    if (described) {
      if (prevDescribed) described.setAttribute('aria-describedby', prevDescribed)
      else described.removeAttribute('aria-describedby')
    }
    described = null
    prevDescribed = null
    anchor = null
    tip.style.display = 'none'
    win.removeEventListener('pointerdown', onWinPointerDown, true)
    win.removeEventListener('scroll', onWinScroll, true)
    win.removeEventListener('keydown', onWinKey, true)
  }

  const onOver = (e) => {
    if (e.pointerType === 'touch') return
    const a = anchorOf(e.target)
    if (a === anchor || a === pending) return
    if (anchor && !anchor.contains(doc.activeElement)) hide()
    cancel()
    if (!a) return
    pending = a
    const target = e.target
    timer = win.setTimeout(() => show(a, target), delay)
  }
  const onOut = (e) => {
    const next = e.relatedTarget
    if (pending && !(next && pending.contains(next))) cancel()
    if (anchor && !(next && anchor.contains(next)) && !anchor.contains(doc.activeElement)) hide()
  }
  const onFocusIn = (e) => {
    // Only keyboard focus shows instantly; a mouse click also focuses the
    // control but is covered by the hover path (and pointerdown hides).
    let keyboard = true
    try {
      keyboard = e.target.matches(':focus-visible')
    } catch {
      /* selector unsupported: treat as keyboard */
    }
    if (!keyboard) return
    const a = anchorOf(e.target)
    if (a) show(a, e.target)
  }
  const onFocusOut = (e) => {
    if (anchor && !(e.relatedTarget && anchor.contains(e.relatedTarget))) hide()
  }
  const onRootScroll = () => hide()
  // A press inside the panel also cancels a hover still waiting on its delay
  // (the window listener only exists while a tooltip is visible).
  const onRootPointerDown = () => hide()

  root.addEventListener('pointerdown', onRootPointerDown)
  root.addEventListener('pointerover', onOver)
  root.addEventListener('pointerout', onOut)
  root.addEventListener('focusin', onFocusIn)
  root.addEventListener('focusout', onFocusOut)
  root.addEventListener('scroll', onRootScroll)

  return {
    el: tip,
    hide,
    get anchor() {
      return anchor
    },
    dispose() {
      hide()
      root.removeEventListener('pointerdown', onRootPointerDown)
      root.removeEventListener('pointerover', onOver)
      root.removeEventListener('pointerout', onOut)
      root.removeEventListener('focusin', onFocusIn)
      root.removeEventListener('focusout', onFocusOut)
      root.removeEventListener('scroll', onRootScroll)
      tip.remove()
    },
  }
}
