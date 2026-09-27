import { button, section, segmented, textBlock } from '../../debug/widgets.js'
import { MAP_FAMILY_ORDER } from '../../world/mapFamily.js'
import { FAMILY_CATALOG_PROFILES } from '../../world/config.js'
import { familyCatalog } from '../catalogLab.js'
import { h, keyedRender, placeholderRow, sectionOpts } from './dom.js'
import { familyColor, familyLabel } from './legend.js'

// Structure catalog browser (Structures tab, top). One place to see every
// structure type a map family can generate — its landmark planners and its
// v26 procedural small / medium / large volumes — with what each one is,
// where it comes from, how often the last atlas scan met it, and two
// actions: Find (fly the explorer to the nearest real instance in the
// world of the Map tab's seed) and Stamp (build that exact recipe into the
// document at the view centre, undoable).

const SIZES = ['all', 'landmark', 'small', 'medium', 'large']
const SIZE_TIPS = {
  all: 'Every structure type of the family.',
  landmark: 'The family’s original landmark planners (atria, tower forms, lattice districts) — one per district and vertical band.',
  small: 'Small catalog volumes: one chunk (a light well, a stair core, a mezzanine).',
  medium: 'Medium catalog volumes: two chunks (a court, a cistern, a nave).',
  large: 'Large catalog volumes: a 2×2-chunk block (a grand atrium, a stepwell, an abyss).',
}
const SIZE_BADGE = { landmark: 'L★', small: 'S', medium: 'M', large: 'L' }

export function buildCatalogPanel(app) {
  const state = app.catalogBrowser ?? (app.catalogBrowser = { family: null, size: 'all' })
  const root = h('div', { class: 'edt-catalog' })
  const sec = section('Structure catalog', sectionOpts('structures.catalog',
    'Every structure type each map family generates (v26): landmarks plus procedural small / medium / large volumes. Find one in the world, or stamp it into the document.'))
  root.appendChild(sec.el)

  const families = MAP_FAMILY_ORDER
  const familyPick = segmented({
    labels: families.map(familyLabel),
    value: 0,
    ariaLabel: 'Catalog family',
    tips: families.map((f) => `Show the ${familyLabel(f)} catalog (${familyCatalog(f).length} types).`),
    onPick: (i) => {
      state.family = families[i]
      render()
    },
  })
  const sizePick = segmented({
    labels: SIZES.map((s) => s[0].toUpperCase() + s.slice(1)),
    value: SIZES.indexOf(state.size),
    ariaLabel: 'Size class',
    tips: SIZES.map((s) => SIZE_TIPS[s]),
    onPick: (i) => {
      state.size = SIZES[i]
      render()
    },
  })
  const summary = textBlock()
  summary.el.classList.add('edt-inspect', 'edt-selectable')
  const list = h('div', { class: 'edt-list edt-catalog-list', role: 'list', 'aria-label': 'Structure types' })
  const renderList = keyedRender(list)
  sec.body.append(familyPick.el, sizePick.el, summary.el, list)

  const currentFamily = () => state.family ?? app.source?.meta?.family ?? app.world.family ?? 'office'

  const render = () => {
    const family = currentFamily()
    familyPick.set(Math.max(0, families.indexOf(family)))
    sizePick.set(SIZES.indexOf(state.size))
    const entries = familyCatalog(family)
    const shown = entries.filter((e) => state.size === 'all' || e.sizeClass === state.size)
    const found = (app.structureScan.found ?? []).filter((f) => f.family === family)
    const counts = new Map(entries.map((e) => [e.type, found.filter((f) => e.match(f.structure)).length]))
    const cfg = FAMILY_CATALOG_PROFILES[family]
    const bySize = Object.fromEntries(['landmark', 'small', 'medium', 'large'].map((s) => [s, entries.filter((e) => e.sizeClass === s).length]))
    summary.set([
      `${familyLabel(family)}: ${entries.length} structure types`,
      `landmark ${bySize.landmark} · small ${bySize.small} · medium ${bySize.medium} · large ${bySize.large}`,
      cfg ? `placement: ${cfg.attempts} tries per 4×4 district every ${cfg.period} storeys, ≤ ${cfg.maxChunksPerFloor} structure chunks per storey` : '',
      found.length ? `last atlas scan: ${found.length} ${family} structures` : 'scan the atlas (below) to count instances around the view',
    ].filter(Boolean))
    const docMode = !app.readOnly
    const docFamily = app.map.meta.family
    const signature = `${family}|${state.size}|${found.length}|${docMode}|${docFamily}|${app.map.chunks.size > 0}`
    renderList(signature, (el) => {
      if (!shown.length) {
        el.appendChild(placeholderRow('no types in this size class'))
        return
      }
      for (const entry of shown) {
        const count = counts.get(entry.type) ?? 0
        const levels = entry.levels[0] === entry.levels[1] ? `${entry.levels[0]}` : `${entry.levels[0]}–${entry.levels[1]}`
        const chunks = entry.chunks.map(([w, d]) => `${w}×${d}`).join('/')
        const row = h('div', { class: 'edt-catalog-row', role: 'listitem', dataset: { key: `${family}:${entry.type}` } })
        const badge = h('span', {
          class: `edt-badge edt-size edt-size-${entry.sizeClass}`,
          text: SIZE_BADGE[entry.sizeClass],
          tip: SIZE_TIPS[entry.sizeClass],
        })
        const swatch = h('span', { class: 'edt-swatch', style: { background: familyColor(family) } })
        const name = h('div', { class: 'edt-catalog-name' },
          h('div', { class: 'edt-catalog-title', text: entry.label }),
          h('div', { class: 'edt-catalog-meta', text: `${levels} storeys · ${chunks} chunks${count ? ` · ${count} in scan` : ''}` }),
          h('div', { class: 'edt-catalog-about', text: entry.about }))
        name.dataset.tipTitle = entry.label
        name.dataset.tip = `${entry.about} Reference: ${entry.reference}.`
        const find = button({
          label: 'Find',
          tip: { title: `Find the nearest ${entry.label}`, text: `Searches the ${familyLabel(family)} world of the Map tab seed outward from the view (±12 storeys) and flies the explorer to the closest instance. Read-only.` },
          onClick: () => app.findCatalogType(entry),
        })
        const actions = h('div', { class: 'edt-catalog-actions' }, find.el)
        if (!entry.landmark) {
          const wrongFamily = app.map.chunks.size > 0 && docFamily !== family
          const reason = !docMode ? 'Exploring is read-only — press E to return to the document.'
            : wrongFamily ? `The document is a ${familyLabel(docFamily)} map; stamp ${familyLabel(docFamily)} types (or start a new document).` : null
          const stamp = button({
            label: 'Stamp',
            tip: { title: `Stamp a ${entry.label} into the document`, text: reason ?? 'Builds this exact recipe at the view centre, starting on the current floor, with its own stairs, rails and core. Undoable (Ctrl/⌘+Z); fails if a chunk-storey already holds a structure.' },
            onClick: () => { if (!reason) app.stampCatalogType(entry) },
          })
          if (reason) {
            stamp.el.setAttribute('aria-disabled', 'true')
            stamp.el.classList.add('edt-disabled')
          }
          actions.appendChild(stamp.el)
        }
        row.append(badge, swatch, name, actions)
        el.appendChild(row)
      }
    })
  }

  return { el: root, refresh: render }
}
