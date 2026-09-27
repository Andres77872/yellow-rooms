import { h } from './dom.js'
import { icon } from './icons.js'

// Accessible modal overlays: the confirmation dialog, the command palette
// and the help sheet share one backdrop/focus-trap implementation.

let openCount = 0
export const isModalOpen = () => openCount > 0

const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])'

export function openOverlay({ labelledBy, className = '', build, onClose, closeOnBackdrop = true }) {
  const restore = document.activeElement
  const backdrop = h('div', { class: `edt-overlay ${className}`.trim() })
  const dialog = h('div', { class: 'edt-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelledBy })
  backdrop.appendChild(dialog)
  let closed = false
  const close = (result) => {
    if (closed) return
    closed = true
    openCount--
    backdrop.remove()
    document.removeEventListener('keydown', onKey, true)
    if (restore && typeof restore.focus === 'function' && document.contains(restore)) restore.focus()
    onClose?.(result)
  }
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(false)
      return
    }
    if (e.key === 'Tab') {
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null)
      if (!items.length) return
      const first = items[0]
      const last = items.at(-1)
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  }
  document.addEventListener('keydown', onKey, true)
  if (closeOnBackdrop) backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(false) })
  openCount++
  // Attach first so build() can focus its controls synchronously (keys typed
  // right after the shortcut must land in the dialog).
  document.body.appendChild(backdrop)
  build(dialog, close)
  return { close, dialog, backdrop }
}

let uid = 0

// Small confirmation dialog. Enter confirms, Esc cancels. Resolves true/false.
export function confirmDialog({ title, body, confirmLabel = 'Continue', cancelLabel = 'Cancel', danger = true, note = '' }) {
  return new Promise((resolve) => {
    const id = `edt-confirm-${++uid}`
    openOverlay({
      labelledBy: id,
      className: 'edt-confirm',
      onClose: (v) => resolve(!!v),
      build: (dialog, close) => {
        dialog.setAttribute('role', 'alertdialog')
        dialog.setAttribute('aria-describedby', `${id}-body`)
        dialog.append(
          h('div', { class: 'edt-dialog-head' }, icon(danger ? 'warn' : 'info', { size: 18 }), h('h2', { id, text: title })),
          h('p', { id: `${id}-body`, class: 'edt-dialog-body', text: body }),
          note ? h('p', { class: 'edt-dialog-note', text: note }) : null,
        )
        const cancel = h('button', { class: 'dbg-btn', type: 'button', text: cancelLabel, onClick: () => close(false),
          tip: { title: cancelLabel, text: 'Close without changing anything.', keys: 'Escape' } })
        const ok = h('button', { class: `dbg-btn ${danger ? 'edt-danger' : 'edt-primary'}`, type: 'button', text: confirmLabel, onClick: () => close(true),
          tip: { title: confirmLabel, text: body, keys: 'Enter' } })
        dialog.appendChild(h('div', { class: 'edt-dialog-actions' }, cancel, ok))
        dialog.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && document.activeElement !== cancel) {
            e.preventDefault()
            close(true)
          }
        })
        ok.focus()
      },
    })
  })
}
