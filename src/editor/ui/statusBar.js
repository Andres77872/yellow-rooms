import { h } from './dom.js'
import { icon } from './icons.js'
import { commandById, formatChord } from './keymap.js'
import { isMac } from './tooltip.js'

// Bottom status bar: mode, floor, the hover readout (selectable text), the
// latest notice coloured by severity with a history popover, zoom and the
// autosave state. Written every frame by EditorApp._updateStatus through
// update(), which only touches nodes whose text changed.

const set = (node, text) => {
  if (node.textContent !== text) node.textContent = text
}

export function buildStatusBar(app) {
  const bar = h('footer', { class: 'edt-statusbar', role: 'contentinfo' })
  const mode = h('span', { class: 'edt-sb-mode', tip: { title: 'Source', text: 'DOCUMENT: editing the finite map. EXPLORE: browsing the generated world read-only (E toggles).' } })
  const floor = h('span', { class: 'edt-sb-field', tip: { title: 'Floor', text: 'The storey shown (cy). PgUp / PgDn change it.' } })
  const hover = h('span', { class: 'edt-sb-hover', tip: { title: 'Under the cursor', text: 'Cell coordinates, kind, openings, stairs, room, storey role, walk distance, light and protection of the hovered cell. Select the text to copy it.' } })
  // The visible notice is not a live region; two fixed live regions (polite
  // and assertive) announce it, because screen readers only honour the role
  // a live region had when it was created.
  const notice = h('span', { class: 'edt-sb-notice' })
  const livePolite = h('span', { class: 'edt-visually-hidden', role: 'status', 'aria-live': 'polite' })
  const liveAlert = h('span', { class: 'edt-visually-hidden', role: 'alert', 'aria-live': 'assertive' })
  const historyBtn = h('button', { class: 'edt-ibtn edt-sb-history', type: 'button', 'aria-label': 'Notice history', 'aria-expanded': 'false',
    tip: { title: 'Notice history', text: 'The last 40 messages (refusals, results, errors) with their time.' } }, icon('history'))
  const keys = (id) => (commandById(id)?.keys ?? []).map((c) => formatChord(c, { mac: isMac() })).join(' / ')
  const zoom = h('span', { class: 'edt-sb-field', tip: { title: 'Plan zoom',
    text: `Pixels per metre in the plan. Wheel zooms at the cursor; ${keys('view.fit')} fits the document (not with the Section tool, where it toggles “follow cursor”); ${keys('view.zoomIn')} / ${keys('view.zoomOut')} zoom.` } })
  const save = h('span', { class: 'edt-sb-field edt-sb-save', tip: { title: 'Autosave', text: 'The document is saved to this browser shortly after every change (restored on reload). Export (Ctrl/⌘+S) for a file.' } })
  bar.append(mode, floor, hover, notice, historyBtn, zoom, save, livePolite, liveAlert)

  const pop = h('div', { class: 'edt-popover edt-history', role: 'dialog', 'aria-label': 'Notice history', hidden: true })
  document.body.appendChild(pop)
  const closePop = () => {
    pop.hidden = true
    historyBtn.setAttribute('aria-expanded', 'false')
  }
  historyBtn.addEventListener('click', (e) => {
    e.preventDefault()
    if (!pop.hidden) return closePop()
    pop.textContent = ''
    pop.appendChild(h('div', { class: 'edt-popover-head', text: 'Notices (newest first)' }))
    const list = h('div', { class: 'edt-history-list' })
    const items = [...(app.noticeLog ?? [])].reverse()
    if (!items.length) list.appendChild(h('div', { class: 'edt-history-row', text: 'No notices yet.' }))
    for (const n of items) {
      const t = new Date(n.time)
      const stamp = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`
      list.appendChild(h('div', { class: `edt-history-row edt-sev-${n.level}` }, h('span', { class: 'edt-history-time', text: stamp }), n.text))
    }
    pop.appendChild(list)
    pop.hidden = false
    historyBtn.setAttribute('aria-expanded', 'true')
    const r = historyBtn.getBoundingClientRect()
    pop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`
    pop.style.bottom = `${window.innerHeight - r.top + 6}px`
  })
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !historyBtn.contains(e.target)) closePop()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) {
      closePop()
      historyBtn.focus()
      e.stopPropagation()
    }
  }, true)

  let lastLevel = ''
  let lastAnnounced = null
  // s: { mode, floor, hover, notice: {text, level, at} | null, prompt, zoom, save }
  // `prompt` is the active tool's guidance ("path: click B…"); it fills the
  // notice slot when there is no notice and the tool bar hint is hidden
  // (narrow screens), so the prompt never disappears.
  const narrow = typeof matchMedia === 'function' ? matchMedia('(max-width: 980px)') : null
  const update = (s) => {
    set(mode, s.mode)
    mode.classList.toggle('edt-sb-explore', s.mode !== 'DOCUMENT')
    set(floor, s.floor)
    set(hover, s.hover)
    const showPrompt = !s.notice && s.prompt && narrow?.matches
    const text = s.notice?.text ?? (showPrompt ? s.prompt : '')
    set(notice, text)
    const level = s.notice?.level ?? (showPrompt ? 'prompt' : '')
    if (level !== lastLevel) {
      notice.className = `edt-sb-notice${level ? ` edt-sev-${level}` : ''}`
      lastLevel = level
    }
    if (text && notice.dataset.tip !== text) notice.dataset.tip = text
    if (s.notice && s.notice !== lastAnnounced) {
      lastAnnounced = s.notice
      const region = s.notice.level === 'error' ? liveAlert : livePolite
      const other = region === liveAlert ? livePolite : liveAlert
      other.textContent = ''
      region.textContent = s.notice.text
    }
    set(zoom, s.zoom)
    set(save, s.save)
  }
  return { el: bar, update, closePopover: closePop, get popoverOpen() { return !pop.hidden } }
}
