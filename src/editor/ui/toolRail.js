import { TOOL_KEYS, TOOL_META, commandById, commandState, runCommand } from './keymap.js'
import { h, setDisabled, setPressed } from './dom.js'
import { icon } from './icons.js'

// Vertical tool rail: one icon button per tool with its digit, grouped
// (edit 1–7 · analyze 8–9 · create 0), plus the protect-structures lock.
// Arrow keys move between tools (roving tabindex).

export function buildToolRail(app) {
  const rail = h('nav', { class: 'edt-rail', 'aria-label': 'Tools' })
  const bar = h('div', { class: 'edt-rail-tools', role: 'toolbar', 'aria-orientation': 'vertical', 'aria-label': 'Tools', dataset: { tipSide: 'right' } })
  rail.appendChild(bar)
  const buttons = []
  let group = null
  app.tools.forEach((tool, i) => {
    const meta = TOOL_META.find((m) => m.id === tool.id) ?? { label: tool.id, icon: 'dot', group: 'edit' }
    if (group && meta.group !== group) bar.appendChild(h('div', { class: 'edt-rail-sep', role: 'separator' }))
    group = meta.group
    const b = h('button', {
      class: 'edt-rail-btn', type: 'button', 'aria-label': `${meta.label} (${TOOL_KEYS[i]})`,
      dataset: { cmd: `tool.${tool.id}`, tipSide: 'right' }, tabindex: i === 0 ? 0 : -1,
    }, icon(meta.icon, { size: 20 }), h('span', { class: 'edt-rail-key', 'aria-hidden': 'true', text: TOOL_KEYS[i] }))
    b.addEventListener('click', () => runCommand(commandById(`tool.${tool.id}`), app))
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
      if (!d) return
      e.preventDefault()
      const next = buttons[(buttons.indexOf(b) + d + buttons.length) % buttons.length]
      next.focus()
    })
    bar.appendChild(b)
    buttons.push(b)
  })

  const bottom = h('div', { class: 'edt-rail-bottom', dataset: { tipSide: 'right' } })
  const lock = h('button', { class: 'edt-rail-btn edt-rail-lock', type: 'button', 'aria-label': 'Protect structures', dataset: { cmd: 'edit.protect', tipSide: 'right' } })
  const lockIcon = h('span', { class: 'edt-rail-lock-icon' })
  lock.appendChild(lockIcon)
  lock.addEventListener('click', () => runCommand(commandById('edit.protect'), app))
  bottom.appendChild(lock)
  rail.appendChild(bottom)

  let lockState = null
  const refresh = () => {
    app.tools.forEach((tool, i) => {
      const b = buttons[i]
      const on = app.tool === tool
      setPressed(b, on)
      b.tabIndex = on ? 0 : -1
      const st = commandState(commandById(`tool.${tool.id}`), app)
      setDisabled(b, st.enabled ? null : st.reason)
    })
    if (lockState !== app.protect) {
      lockState = app.protect
      lockIcon.textContent = ''
      lockIcon.appendChild(icon(app.protect ? 'lock' : 'unlock', { size: 20 }))
      setPressed(lock, app.protect)
    }
  }
  return { el: rail, refresh }
}
