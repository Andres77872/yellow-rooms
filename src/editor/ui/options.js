import { applyTip } from '../../debug/widgets.js'
import { roomRoleLabel } from '../../debug/mapInspect.js'
import { SPACE_ROLE_NONE } from '../../world/mapTypes.js'

// Shared panel controls.

export const FURN_NAMES = {
  1: 'desk', 2: 'chair', 3: 'table', 4: 'cabinet', 5: 'copier', 6: 'cooler',
  7: 'plant', 8: 'rack', 9: 'sofa', 10: 'bookshelf', 11: 'whiteboard',
  12: 'bed', 13: 'nightstand', 14: 'wardrobe', 15: 'toilet', 16: 'sink',
  17: 'tub', 18: 'counter', 19: 'stove', 20: 'fridge', 21: 'tv',
  22: 'armchair', 23: 'washer',
}

export const ROLE_OPTIONS = [
  { value: SPACE_ROLE_NONE, label: 'ordinary (theme roll)' },
  ...Array.from({ length: 15 }, (_, i) => i + 1)
    .filter((role) => roomRoleLabel(role))
    .map((role) => ({ value: role, label: roomRoleLabel(role) })),
]

// opts (optional): { tip, label } — tooltip and accessible name.
export function selectInput(options, value, onChange, opts) {
  const sel = document.createElement('select')
  sel.className = 'edt-input'
  applyTip(sel, opts?.tip)
  if (opts?.label) sel.setAttribute('aria-label', opts.label)
  for (const o of options) {
    const opt = document.createElement('option')
    opt.value = String(o.value)
    opt.textContent = o.label
    sel.appendChild(opt)
  }
  sel.value = String(value)
  sel.addEventListener('change', () => onChange(sel.value))
  return sel
}

// A text input that commits on change. opts: { tip, label, placeholder }.
export function textInput(value, onChange, opts) {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'edt-input'
  input.value = value
  input.spellcheck = false
  applyTip(input, opts?.tip)
  if (opts?.label) input.setAttribute('aria-label', opts.label)
  if (opts?.placeholder) input.placeholder = opts.placeholder
  input.addEventListener('change', () => onChange(input.value))
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur() })
  return input
}

export function row(label, control) {
  const root = document.createElement('div')
  root.className = 'dbg-row'
  if (label) {
    const lab = document.createElement('span')
    lab.className = 'dbg-label'
    lab.textContent = label
    root.appendChild(lab)
  }
  root.appendChild(control)
  return root
}
