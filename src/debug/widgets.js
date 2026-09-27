// Tiny DOM widget kit for the debug panel. Each builder creates its DOM once and
// returns the element plus small handles (`set`/`get`) so per-frame updates only
// mutate text/value nodes — never innerHTML. Styling comes from the CSS injected
// by DebugMode (classes prefixed `dbg-`); these match the game's yellow theme.

const el = (tag, cls, parent) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (parent) parent.appendChild(e)
  return e
}

// Optional tooltip metadata (used by the map editor's tooltip layer; the
// game's debug tools pass none, so nothing changes for them). `tip` is a
// string (the description) or { title, text, keys, cmd, side }. It is stored
// as data attributes, never as a native `title`, so the rich tooltip is the
// only one shown.
export function applyTip(e, tip) {
  if (!tip || !e) return e
  if (typeof tip === 'string') {
    e.dataset.tip = tip
    return e
  }
  if (tip.cmd) e.dataset.cmd = tip.cmd
  if (tip.title) e.dataset.tipTitle = tip.title
  if (tip.text) e.dataset.tip = tip.text
  if (tip.keys) e.dataset.tipKeys = [].concat(tip.keys).join(' ')
  if (tip.side) e.dataset.tipSide = tip.side
  return e
}

const hex6 = (n) => '#' + (n & 0xffffff).toString(16).padStart(6, '0')
const parseHex = (s) => parseInt(s.slice(1), 16) | 0

// Collapsible section. Returns { el, body, head, setCollapsed } — append
// controls to `body`. Optional `opts` (editor): { tip, collapsed, onToggle }
// makes the header keyboard operable (role=button, aria-expanded, Enter /
// Space) and reports every toggle so the caller can persist it.
export function section(title, opts) {
  const root = el('div', 'dbg-section')
  const head = el('div', 'dbg-sec-head', root)
  head.textContent = title
  const body = el('div', 'dbg-sec-body', root)
  const setCollapsed = (collapsed) => {
    body.style.display = collapsed ? 'none' : ''
    head.classList.toggle('dbg-collapsed', !!collapsed)
    if (opts) head.setAttribute('aria-expanded', String(!collapsed))
  }
  const flip = () => {
    const collapsed = body.style.display !== 'none'
    setCollapsed(collapsed)
    opts?.onToggle?.(collapsed)
  }
  head.addEventListener('click', flip)
  if (opts) {
    head.setAttribute('role', 'button')
    head.tabIndex = 0
    head.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      flip()
    })
    applyTip(head, opts.tip)
    setCollapsed(!!opts.collapsed)
  }
  return { el: root, body, head, setCollapsed }
}

// Labeled range slider. fmt = decimal places shown. Returns { el, set, get }.
export function slider({ label, min, max, step = 0.01, value = 0, fmt = 2, onInput, tip }) {
  const root = el('div', 'dbg-row')
  applyTip(root, tip)
  const lab = el('span', 'dbg-label', root)
  lab.textContent = label
  const input = el('input', 'dbg-range', root)
  input.type = 'range'
  input.min = min
  input.max = max
  input.step = step
  input.value = value
  if (tip) input.setAttribute('aria-label', label)
  const val = el('span', 'dbg-val', root)
  const show = (v) => (val.textContent = Number(v).toFixed(fmt))
  show(value)
  input.addEventListener('input', () => {
    const v = parseFloat(input.value)
    show(v)
    onInput?.(v)
  })
  return {
    el: root,
    set: (v) => {
      input.value = v
      show(v)
    },
    get: () => parseFloat(input.value),
  }
}

// Native color picker bound to an integer hex. Returns { el, set }.
export function colorPicker({ label, value = 0xffffff, onInput, tip }) {
  const root = el('div', 'dbg-row')
  applyTip(root, tip)
  const lab = el('span', 'dbg-label', root)
  lab.textContent = label
  const input = el('input', 'dbg-color', root)
  input.type = 'color'
  input.value = hex6(value)
  const code = el('code', 'dbg-val', root)
  code.textContent = hex6(value)
  input.addEventListener('input', () => {
    code.textContent = input.value
    onInput?.(parseHex(input.value))
  })
  return {
    el: root,
    set: (v) => {
      input.value = hex6(v)
      code.textContent = hex6(v)
    },
  }
}

// Checkbox toggle. Returns { el, set, get }.
export function toggle({ label, value = false, onChange, tip }) {
  const root = el('label', 'dbg-row dbg-toggle')
  applyTip(root, tip)
  const input = el('input', null, root)
  input.type = 'checkbox'
  input.checked = !!value
  const lab = el('span', 'dbg-label', root)
  lab.textContent = label
  input.addEventListener('change', () => onChange?.(input.checked))
  return {
    el: root,
    set: (v) => (input.checked = !!v),
    get: () => input.checked,
    input,
  }
}

// Plain button. Returns { el }. Optional (editor): `tip`, extra `className`.
export function button({ label, onClick, tip, className }) {
  const b = el('button', 'dbg-btn')
  if (className) b.className += ` ${className}`
  b.textContent = label
  applyTip(b, tip)
  b.addEventListener('click', (e) => {
    e.preventDefault()
    onClick?.()
  })
  return { el: b }
}

// A row of buttons; one is "active" at a time. Returns { el, set(i), buttons }.
// Optional (editor): `tips` (one per button), `tip` (the whole group) and
// `ariaLabel`; with tips the buttons also carry aria-pressed.
export function segmented({ labels, value = 0, onPick, tips, tip, ariaLabel }) {
  const root = el('div', 'dbg-seg')
  applyTip(root, tip)
  if (ariaLabel) {
    root.setAttribute('role', 'group')
    root.setAttribute('aria-label', ariaLabel)
  }
  const btns = labels.map((t, i) => {
    const b = el('button', 'dbg-seg-btn', root)
    b.textContent = t
    applyTip(b, tips?.[i])
    b.addEventListener('click', (e) => {
      e.preventDefault()
      set(i)
      onPick?.(i, t)
    })
    return b
  })
  const set = (i) => btns.forEach((b, j) => {
    b.classList.toggle('dbg-seg-on', j === i)
    if (tips) b.setAttribute('aria-pressed', String(j === i))
  })
  set(value)
  return { el: root, set, buttons: btns }
}

// A "label  value" text row updated via set(). Returns { el, set }.
export function readout(label, opts) {
  const root = el('div', 'dbg-read')
  applyTip(root, opts?.tip)
  const lab = el('span', 'dbg-read-k', root)
  lab.textContent = label
  const v = document.createTextNode('')
  const val = el('span', 'dbg-read-v', root)
  val.appendChild(v)
  let last
  return {
    el: root,
    set: (text) => {
      if (text !== last) {
        v.nodeValue = text
        last = text
      }
    },
  }
}

// Preformatted multi-line text block (e.g. audit failure lists). set() takes
// an array of lines (or a string) and diffs like readout. Returns { el, set }.
export function textBlock() {
  const root = el('div', 'dbg-block')
  let last
  return {
    el: root,
    set: (lines) => {
      const text = Array.isArray(lines) ? lines.join('\n') : (lines ?? '')
      if (text !== last) {
        root.textContent = text
        last = text
      }
    },
  }
}

// A label + buttons row (e.g. level stepper). Returns { el }.
export function buttonRow(label, buttons) {
  const root = el('div', 'dbg-row')
  if (label) {
    const lab = el('span', 'dbg-label', root)
    lab.textContent = label
  }
  for (const b of buttons) root.appendChild(b.el)
  return { el: root }
}
