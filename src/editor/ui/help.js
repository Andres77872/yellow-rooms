import { GESTURES, QUICK_START, formatChord, helpRows } from './keymap.js'
import { h } from './dom.js'
import { icon } from './icons.js'
import { openOverlay } from './overlay.js'
import { isMac } from './tooltip.js'
import { legendEl, planLegend } from './legend.js'

// “?” / F1 help sheet: quick start, every shortcut (generated from the keymap
// registry), mouse gestures and the plan colour legend.

export function openHelp() {
  const mac = isMac()
  return openOverlay({
    labelledBy: 'edt-help-title',
    className: 'edt-help',
    build: (dialog, close) => {
      const head = h('div', { class: 'edt-dialog-head' }, icon('keyboard', { size: 18 }),
        h('h2', { id: 'edt-help-title', text: 'Editor help & shortcuts' }))
      const closeBtn = h('button', { class: 'edt-ibtn edt-help-close', type: 'button', 'aria-label': 'Close help', tip: 'Close (Esc)', onClick: () => close(false) })
      closeBtn.appendChild(icon('close'))
      head.appendChild(closeBtn)
      dialog.appendChild(head)

      const cols = h('div', { class: 'edt-help-cols' })
      dialog.appendChild(cols)

      const start = h('section', { class: 'edt-help-col' }, h('h3', { text: 'Quick start' }))
      const ol = h('ol', { class: 'edt-help-steps' })
      for (const step of QUICK_START) ol.appendChild(h('li', { text: step }))
      start.appendChild(ol)
      start.appendChild(h('h3', { text: 'Mouse' }))
      for (const g of GESTURES) {
        start.appendChild(h('h4', { text: g.where }))
        const dl = h('dl', { class: 'edt-help-dl' })
        for (const [k, v] of g.rows) dl.append(h('dt', { text: k }), h('dd', { text: v }))
        start.appendChild(dl)
      }
      cols.appendChild(start)

      const keys = h('section', { class: 'edt-help-col' }, h('h3', { text: 'Keyboard' }))
      for (const { group, rows } of helpRows()) {
        keys.appendChild(h('h4', { text: group }))
        const table = h('table', { class: 'edt-help-keys' })
        for (const r of rows) {
          const kcell = h('td', { class: 'edt-help-kbd' })
          r.keys.forEach((k, i) => {
            if (i) kcell.appendChild(document.createTextNode(' '))
            kcell.appendChild(h('kbd', { text: formatChord(k, { mac }) }))
          })
          table.appendChild(h('tr', { dataset: { cmd: r.id } }, kcell,
            h('td', null, r.label, r.scope ? h('span', { class: 'edt-help-scope', text: ` — ${r.scope}` }) : null)))
        }
        keys.appendChild(table)
      }
      keys.appendChild(h('p', { class: 'edt-help-note', text: 'Shortcuts are ignored while typing in a text field or list box (except Ctrl/⌘+K, Ctrl/⌘+S, Ctrl/⌘+O and Esc); a focused slider keeps its arrow keys. Tab toggles 3D only after you click the plan — Shift+Tab or Esc gives Tab back to moving between controls. To limit single-key shortcuts (1–0, R, E, V…) to the plan and tool rail, turn off View → Keyboard → “single-key shortcuts anywhere”.' }))
      cols.appendChild(keys)

      const legend = h('section', { class: 'edt-help-col' }, h('h3', { text: 'Plan colours' }))
      for (const g of planLegend()) {
        legend.appendChild(h('h4', { text: g.title }))
        legend.appendChild(legendEl(g.items))
      }
      cols.appendChild(legend)
      closeBtn.focus()
    },
  })
}
