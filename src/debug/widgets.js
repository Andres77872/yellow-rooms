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

const hex6 = (n) => '#' + (n & 0xffffff).toString(16).padStart(6, '0')
const parseHex = (s) => parseInt(s.slice(1), 16) | 0

// Collapsible section. Returns { el, body } — append controls to `body`.
export function section(title) {
  const root = el('div', 'dbg-section')
  const head = el('div', 'dbg-sec-head', root)
  head.textContent = title
  const body = el('div', 'dbg-sec-body', root)
  head.addEventListener('click', () => {
    body.style.display = body.style.display === 'none' ? '' : 'none'
    head.classList.toggle('dbg-collapsed')
  })
  return { el: root, body }
}

// Labeled range slider. fmt = decimal places shown. Returns { el, set, get }.
export function slider({ label, min, max, step = 0.01, value = 0, fmt = 2, onInput }) {
  const root = el('div', 'dbg-row')
  const lab = el('span', 'dbg-label', root)
  lab.textContent = label
  const input = el('input', 'dbg-range', root)
  input.type = 'range'
  input.min = min
  input.max = max
  input.step = step
  input.value = value
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
export function colorPicker({ label, value = 0xffffff, onInput }) {
  const root = el('div', 'dbg-row')
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
export function toggle({ label, value = false, onChange }) {
  const root = el('label', 'dbg-row dbg-toggle')
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
  }
}

// Plain button. Returns { el }.
export function button({ label, onClick }) {
  const b = el('button', 'dbg-btn')
  b.textContent = label
  b.addEventListener('click', (e) => {
    e.preventDefault()
    onClick?.()
  })
  return { el: b }
}

// A row of buttons; one is "active" at a time. Returns { el, set(i) }.
export function segmented({ labels, value = 0, onPick }) {
  const root = el('div', 'dbg-seg')
  const btns = labels.map((t, i) => {
    const b = el('button', 'dbg-seg-btn', root)
    b.textContent = t
    b.addEventListener('click', (e) => {
      e.preventDefault()
      set(i)
      onPick?.(i, t)
    })
    return b
  })
  const set = (i) => btns.forEach((b, j) => b.classList.toggle('dbg-seg-on', j === i))
  set(value)
  return { el: root, set }
}

// A "label  value" text row updated via set(). Returns { el, set }.
export function readout(label) {
  const root = el('div', 'dbg-read')
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
