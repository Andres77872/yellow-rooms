import { commandState, formatChord, fuzzyRank, paletteCommands, runCommand } from './keymap.js'
import { TEMPLATE_DEFS } from '../templates.js'
import { PROTOTYPE_KINDS } from '../prototypes.js'
import { structureKey, summarizeStructure } from '../structureReview.js'
import { MAP_FAMILY_ORDER } from '../../world/mapFamily.js'
import { familyCatalog } from '../catalogLab.js'
import { h } from './dom.js'
import { icon } from './icons.js'
import { openOverlay } from './overlay.js'
import { isMac } from './tooltip.js'
import { familyLabel } from './legend.js'

// Ctrl/⌘+K command palette: fuzzy search over every registered command plus
// dynamic entries (go to floor / cell, templates, prototype kinds, families,
// structures). Arrow keys move, Enter runs, Esc closes.

const MAX = 60
// Without a query, lead with the everyday groups.
const GROUP_ORDER = ['Tools', 'File', 'Edit', 'View', 'World', 'Structures', 'Structure catalog', 'Simulate', 'Review', 'Create', 'Layers', 'Inspect', 'Panels', 'Help']
const groupRank = (g) => {
  const i = GROUP_ORDER.indexOf(g)
  return i < 0 ? GROUP_ORDER.length : i
}

function dynamicItems(app, query) {
  const out = []
  const q = query.trim()
  const floor = /^(?:cy|floor|f)?\s*(-?\d+)$/i.exec(q)
  if (floor) {
    const cy = Number(floor[1])
    out.push({ id: `goto.floor.${cy}`, group: 'Go to', label: `Go to floor cy ${cy}`, icon: 'up', pinned: true,
      hint: 'Show that storey (view only).', run: () => app.setFloor(cy) })
  }
  const cell = /^(?:g|cell)?\s*(-?\d+)\s*[, ]\s*(-?\d+)(?:\s*[, ]\s*(-?\d+))?$/i.exec(q)
  if (cell) {
    const [gx, gz] = [Number(cell[1]), Number(cell[2])]
    const cy = cell[3] !== undefined ? Number(cell[3]) : app.floor
    out.push({ id: `goto.cell`, group: 'Go to', label: `Go to cell ${gx},${gz} on cy ${cy}`, icon: 'crosshair', pinned: true,
      hint: 'Centre the plan on the cell and flash it.', run: () => app.jumpToCell(gx, gz, cy) })
  }
  for (const t of TEMPLATE_DEFS) {
    out.push({ id: `template.${t.id}`, group: 'Create', label: `Author template: ${t.label}`, icon: 'author',
      hint: 'Selects the template and the Author tool (0); then drag on the plan.',
      enabled: app.readOnly ? 'Read-only while exploring' : true,
      run: () => { app.setAuthorTemplate(t.id); app.ui?.showTab('create') } })
  }
  for (const k of PROTOTYPE_KINDS) {
    out.push({ id: `kind.${k.id}`, group: 'Create', label: `Generate prototype kind: ${k.label}`, icon: 'play',
      hint: `Replaces the document with a ${k.floors}-floor ${k.label} (kind-lab seed). Undoable.`,
      run: () => app.ui?.generateKind(k.id) })
  }
  for (const f of MAP_FAMILY_ORDER) {
    out.push({ id: `family.${f}`, group: 'World', label: `World family: ${familyLabel(f)}`, icon: 'globe',
      hint: 'Sets the world family used by generate, explore and the atlas scan.',
      checked: app.world.family === f,
      run: () => { app.world.family = f; if (app.mode === 'explore') app.enterExplore(); app.panel.refresh() } })
  }
  // v26 structure catalog: find the nearest instance of any family's type.
  for (const f of MAP_FAMILY_ORDER) {
    for (const entry of familyCatalog(f)) {
      out.push({ id: `catalog.find.${f}.${entry.type}`, group: 'Structure catalog', label: `Find nearest ${familyLabel(f)} ${entry.label} (${entry.sizeClass})`,
        icon: 'building', hint: `${entry.about} Flies the explorer to the closest instance (read-only).`,
        run: () => { app.findCatalogType(entry); app.ui?.showTab('structures') } })
    }
  }
  const entries = app.structureEntries?.() ?? []
  for (const { structure: s, source } of entries.slice(0, 200)) {
    const sum = summarizeStructure(s)
    const key = structureKey(s)
    out.push({ id: `structure.${key}`, group: 'Structures', label: `Structure #${s.id} · ${sum.family} ${sum.variant} · cy ${s.baseCy}–${s.topCy}`,
      icon: 'building', hint: `Focus it (${source}).`, run: () => { app.selectStructure(key); app.focusStructure(key); app.ui?.showTab('structures') } })
  }
  return out
}

export function openPalette(app) {
  const mac = isMac()
  const listId = 'edt-palette-list'
  let items = []
  let active = 0
  let input
  let list
  let handle = null
  const allItems = () => [
    ...paletteCommands().map((cmd) => ({ cmd, id: cmd.id, group: cmd.group, label: cmd.label, hint: cmd.hint, icon: cmd.icon, keys: cmd.keys })),
    ...dynamicItems(app, input?.value ?? ''),
  ]
  const stateOf = (item) => {
    if (item.cmd) return commandState(item.cmd, app)
    const en = item.enabled === undefined ? true : item.enabled
    return { enabled: en === true, reason: en === true ? '' : en, checked: item.checked ?? null }
  }
  const run = (item) => {
    if (!item) return
    const st = stateOf(item)
    if (!st.enabled) {
      app.notify?.(`${item.label}: ${st.reason}`, 'warn')
      return
    }
    handle.close(true)
    // Run after the overlay is gone so focus and key handling are normal.
    requestAnimationFrame(() => (item.cmd ? runCommand(item.cmd, app) : item.run()))
  }
  const render = () => {
    const q = input.value
    const pool = allItems()
    const pinned = pool.filter((x) => x.pinned)
    const rest = pool.filter((x) => !x.pinned)
    const ranked = q.trim()
      ? fuzzyRank(q, rest, (x) => `${x.label} ${x.group}`)
      : rest.map((x, i) => ({ x, i })).sort((a, b) => groupRank(a.x.group) - groupRank(b.x.group) || a.i - b.i).map((r) => r.x)
    items = [...pinned, ...ranked].slice(0, MAX)
    active = Math.min(active, Math.max(0, items.length - 1))
    list.textContent = ''
    items.forEach((item, i) => {
      const st = stateOf(item)
      const row = h('div', {
        class: `edt-pal-row${i === active ? ' edt-active' : ''}${st.enabled ? '' : ' edt-disabled'}`,
        role: 'option', id: `edt-pal-${i}`, 'aria-selected': String(i === active),
        'aria-disabled': st.enabled ? null : 'true',
      })
      row.appendChild(icon(item.icon ?? 'dot'))
      const main = h('div', { class: 'edt-pal-main' },
        h('div', { class: 'edt-pal-label' }, item.label,
          st.checked ? h('span', { class: 'edt-pal-check', text: ' ✓ on' }) : null),
        h('div', { class: 'edt-pal-hint', text: st.enabled ? item.hint ?? '' : `Unavailable: ${st.reason}` }))
      row.appendChild(main)
      row.appendChild(h('span', { class: 'edt-pal-group', text: item.group }))
      if (item.keys?.length) {
        const chips = h('span', { class: 'edt-pal-keys' })
        for (const k of item.keys) chips.appendChild(h('kbd', { text: formatChord(k, { mac }) }))
        row.appendChild(chips)
      }
      row.addEventListener('pointermove', () => {
        if (active === i) return
        active = i
        paint()
      })
      row.addEventListener('click', () => run(item))
      list.appendChild(row)
    })
    if (!items.length) list.appendChild(h('div', { class: 'edt-pal-empty', text: 'No matching action. Try “floor 3”, “12,40”, a tool or a tab name.' }))
    paint()
  }
  const paint = () => {
    ;[...list.children].forEach((row, i) => {
      if (!row.id) return
      const on = i === active
      row.classList.toggle('edt-active', on)
      row.setAttribute('aria-selected', String(on))
      if (on) row.scrollIntoView({ block: 'nearest' })
    })
    if (items.length) input.setAttribute('aria-activedescendant', `edt-pal-${active}`)
    else input.removeAttribute('aria-activedescendant')
  }

  handle = openOverlay({
    labelledBy: 'edt-pal-title',
    className: 'edt-palette',
    build: (dialog) => {
      dialog.appendChild(h('h2', { id: 'edt-pal-title', class: 'edt-visually-hidden', text: 'Command palette' }))
      const bar = h('div', { class: 'edt-pal-bar' }, icon('search', { size: 18 }))
      input = h('input', {
        class: 'edt-pal-input', type: 'text', placeholder: 'Type an action, a tab, “floor 3” or “12,40”…',
        role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId, 'aria-autocomplete': 'list',
        autocomplete: 'off', spellcheck: 'false',
      })
      bar.appendChild(input)
      bar.appendChild(h('kbd', { class: 'edt-pal-esc', text: 'Esc' }))
      list = h('div', { class: 'edt-pal-list', id: listId, role: 'listbox', 'aria-label': 'Actions' })
      dialog.append(bar, list,
        h('div', { class: 'edt-pal-foot', text: '↑↓ move · Enter run · Esc close · greyed actions show why they are unavailable' }))
      input.addEventListener('input', () => { active = 0; render() })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); paint() }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paint() }
        else if (e.key === 'PageDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 8); paint() }
        else if (e.key === 'PageUp') { e.preventDefault(); active = Math.max(0, active - 8); paint() }
        else if (e.key === 'Enter') { e.preventDefault(); run(items[active]) }
      })
      render()
      input.focus()
    },
  })
  return handle
}
