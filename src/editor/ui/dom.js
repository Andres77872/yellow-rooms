import { applyTip } from '../../debug/widgets.js'
import { icon } from './icons.js'

// Small DOM helpers for the editor shell.

export function h(tag, props = null, ...children) {
  const e = document.createElement(tag)
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue
      if (k === 'class') e.className = v
      else if (k === 'text') e.textContent = v
      else if (k === 'tip') applyTip(e, v)
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v)
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v)
      else if (k === 'dataset') Object.assign(e.dataset, v)
      else e.setAttribute(k, v === true ? '' : String(v))
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return e
}

// A button with an inline-SVG icon. `label` is the accessible name (and the
// visible text when `showLabel`); `cmd` binds the tooltip (and the shortcut
// chip) to a keymap command.
export function iconButton({ icon: name, label, tip, cmd, onClick, showLabel = false, className = '' }) {
  const b = h('button', { class: `edt-ibtn ${showLabel ? 'edt-ibtn-text' : ''} ${className}`.trim(), type: 'button' })
  b.appendChild(icon(name))
  if (showLabel) b.appendChild(h('span', { class: 'edt-ibtn-label', text: label }))
  else b.setAttribute('aria-label', label)
  if (cmd) b.dataset.cmd = cmd
  applyTip(b, tip)
  b.addEventListener('click', (e) => {
    e.preventDefault()
    if (b.getAttribute('aria-disabled') === 'true') return
    onClick?.(e)
  })
  return b
}

export function setDisabled(el, reason) {
  if (reason) {
    el.setAttribute('aria-disabled', 'true')
    el.dataset.disabledReason = reason
  } else {
    el.removeAttribute('aria-disabled')
    delete el.dataset.disabledReason
  }
}

export function setPressed(el, on) {
  el.setAttribute('aria-pressed', String(!!on))
  el.classList.toggle('edt-on', !!on)
}

// Rebuild a list container only when its content signature changes, so a
// refresh (explore streams one every 20 frames) never replaces the element
// under the pointer or drops focus.
export function keyedRender(container) {
  let last = {} // unique: the first render always builds
  return (signature, build) => {
    if (signature === last) return false
    last = signature
    const hadFocus = container.contains(document.activeElement)
    const focusKey = hadFocus ? document.activeElement?.dataset?.key : null
    container.textContent = ''
    build(container)
    if (focusKey) container.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus()
    return true
  }
}

// A focusable list row (Enter activates, Shift+Enter = secondary action).
// role 'option' (inside a role=listbox container) by default; role 'button'
// for rows that sit next to their own controls in a role=list (a listbox
// option cannot contain a button).
export function listRow({ className = '', text, tip, key, selected = false, onPick, onSecondary, role = 'option' }) {
  const r = h('div', {
    class: `edt-list-row ${className}`.trim(),
    role,
    tabindex: onPick ? 0 : -1,
    [role === 'option' ? 'aria-selected' : 'aria-pressed']: String(!!selected),
    tip,
  })
  if (key !== undefined) r.dataset.key = String(key)
  if (selected) r.classList.add('edt-on')
  if (text !== undefined) r.textContent = text
  if (onPick) {
    r.classList.add('edt-clickable')
    r.addEventListener('click', (e) => onPick(e))
    r.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      if (e.shiftKey && onSecondary) onSecondary(e)
      else onPick(e)
    })
  }
  if (onSecondary) r.addEventListener('dblclick', (e) => onSecondary(e))
  return r
}

// A non-interactive row inside a listbox ("+N more", empty state): an
// option that is disabled, so the listbox only ever holds options.
export function placeholderRow(text) {
  return h('div', { class: 'edt-list-row edt-dim', role: 'option', 'aria-disabled': 'true', 'aria-selected': 'false', text })
}

// --- UI preferences (never document state) -----------------------------------

const PREFS_KEY = 'yr-editor-ui-v1'
let prefsCache = null

export function loadPrefs() {
  if (prefsCache) return prefsCache
  try {
    prefsCache = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}
  } catch {
    prefsCache = {}
  }
  if (typeof prefsCache !== 'object') prefsCache = {}
  prefsCache.collapsed ??= {}
  return prefsCache
}

export function savePrefs(patch) {
  const p = loadPrefs()
  Object.assign(p, patch)
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    // Private mode / quota — preferences are a convenience only.
  }
}

// section() options that persist the collapsed state under `id`.
export function sectionOpts(id, tip, defaultCollapsed = false) {
  const p = loadPrefs()
  return {
    tip,
    collapsed: p.collapsed[id] ?? defaultCollapsed,
    onToggle: (collapsed) => {
      p.collapsed[id] = collapsed
      savePrefs({ collapsed: p.collapsed })
    },
  }
}
