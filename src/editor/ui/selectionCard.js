import { button, textBlock } from '../../debug/widgets.js'
import { ROLE_OPTIONS, row, selectInput } from './options.js'
import { commandById, runCommand } from './keymap.js'
import { h } from './dom.js'
import { icon } from './icons.js'

// Context card above the inspector tabs: what is selected and what can be
// done with it. Controls are rebuilt only when the selection's identity
// changes, so an open <select> survives refreshes.

export function buildSelectionCard(app) {
  const card = h('section', { class: 'edt-card', 'aria-label': 'Selection', hidden: true })
  const head = h('div', { class: 'edt-card-head' })
  const titleText = h('span', { text: 'Selection' })
  head.append(icon('select'), titleText)
  const clear = h('button', { class: 'edt-ibtn edt-card-close', type: 'button', 'aria-label': 'Clear selection', dataset: { cmd: 'ui.escape' },
    tip: { title: 'Clear selection', text: 'Deselect (Esc).', keys: 'Escape' } }, icon('close'))
  clear.addEventListener('click', () => app.select(null))
  head.appendChild(clear)
  const info = textBlock()
  info.el.classList.add('edt-selectable')
  const actions = h('div', { class: 'edt-card-actions' })
  card.append(head, info.el, actions)

  let builtFor = null
  let roomSel = null
  let rotateBtn = null

  const build = (sel) => {
    actions.textContent = ''
    roomSel = null
    rotateBtn = null
    if (!sel) return
    const del = button({ label: sel.type === 'room' ? 'Delete room' : 'Delete', tip: { cmd: 'edit.delete' },
      className: 'edt-danger-ghost', onClick: () => runCommand(commandById('edit.delete'), app) })
    if (sel.type === 'furniture') {
      rotateBtn = button({ label: 'Rotate 90°', tip: { title: 'Rotate piece' }, onClick: () => app.rotateSelection() })
      actions.append(rotateBtn.el, del.el)
    } else if (sel.type === 'lamp') {
      actions.append(button({ label: 'Toggle lit / dead', onClick: () => app.toggleSelectedLamp(),
        tip: { title: 'Toggle lamp', text: 'Switch the selected lamp between lit and dead. Undoable.' } }).el, del.el)
    } else if (sel.type === 'room') {
      roomSel = selectInput(ROLE_OPTIONS, app.map.roomById(sel.id)?.role ?? 0, (v) => app.setRoomRole(sel.id, Number(v)),
        { label: 'Room type', tip: { title: 'Room type', text: 'Change the room’s role; it is refurnished for the new role. Undoable.' } })
      actions.append(row('type', roomSel))
      actions.append(h('div', { class: 'dbg-row' },
        button({ label: 'Reroll', onClick: () => app.rerollRoom(sel.id),
          tip: { title: 'Reroll room', text: 'Regenerate the room’s furniture and layout with a new salt. Undoable.' } }).el,
        del.el))
    }
  }

  const refresh = () => {
    const sel = app.readOnly ? null : app.selection
    card.hidden = !sel
    const id = sel ? `${sel.type}:${sel.id ?? `${sel.gx},${sel.gz},${sel.cy}`}` : null
    if (id !== builtFor) {
      builtFor = id
      build(sel)
    }
    if (!sel) return
    titleText.textContent = sel.type === 'furniture' ? 'Selected piece' : sel.type === 'lamp' ? 'Selected lamp' : 'Selected room'
    info.set(app.describeSelection())
    if (roomSel && document.activeElement !== roomSel) roomSel.value = String(app.map.roomById(sel.id)?.role ?? 0)
    if (rotateBtn) {
      // R turns the piece-to-place while the Furniture tool is active.
      const objectTool = app.tool.id === 'object'
      rotateBtn.el.dataset.tip = objectTool
        ? 'Turns the selected piece 90°. Undoable. (The R key currently turns the Furniture tool’s next piece instead.)'
        : 'Turns the selected piece 90°. Undoable.'
      if (objectTool) delete rotateBtn.el.dataset.tipKeys
      else rotateBtn.el.dataset.tipKeys = 'R'
    }
  }
  return { el: card, refresh }
}
