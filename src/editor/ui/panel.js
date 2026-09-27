import { PROTOTYPE_KINDS } from '../prototypes.js'
import { TABS, commandById, formatChord, runCommand } from './keymap.js'
import { buildAppBar } from './appBar.js'
import { buildToolRail } from './toolRail.js'
import { buildToolBar } from './toolBar.js'
import { buildStatusBar } from './statusBar.js'
import { buildSelectionCard } from './selectionCard.js'
import { buildMapTab } from './mapTab.js'
import { buildViewTab } from './viewTab.js'
import { buildStructurePanel } from './structurePanel.js'
import { buildCatalogPanel } from './catalogPanel.js'
import { buildAuthorPanel } from './authorPanel.js'
import { buildInspectorPanel, buildSimPanel } from './debugPanel.js'
import { installTooltips, isMac } from './tooltip.js'
import { confirmDialog, isModalOpen } from './overlay.js'
import { openPalette } from './palette.js'
import { openHelp } from './help.js'
import { h, loadPrefs, savePrefs } from './dom.js'
import { icon } from './icons.js'

export { FURN_NAMES } from './options.js'

// The editor shell. Layout:
//
//   ┌ app bar ─────────────────────────────────────────────────────────────┐
//   │ rail │ tool options + view controls              │ selection card    │
//   │ 1–0  ├───────────────────────────────────────────┤ tabs: Map · View  │
//   │      │ plan / 3D viewport  (+ section dock)       │ Structures ·      │
//   │ lock │                                            │ Create · Simulate │
//   │      │                                            │ · Inspect         │
//   └ status bar ──────────────────────────────────────────────────────────┘
//
// buildPanel keeps the old `{ el, refresh }` contract (app.panel), so every
// `app.panel.refresh()` call site is unchanged; refresh updates the chrome
// and only the ACTIVE tab (a hidden tab refreshes when it is shown).

export function buildPanel(app) {
  const prefs = loadPrefs()
  const ui = {
    activeTab: TABS.some((t) => t.id === prefs.tab) ? prefs.tab : 'map',
    // Narrow screens start with the drawer closed (it overlays the plan).
    inspectorHidden: prefs.inspectorHidden ?? (typeof innerWidth === 'number' && innerWidth < 980),
    lab: { kind: PROTOTYPE_KINDS[0]?.id, seed: 'lobby' },
    // WCAG 2.1.4: off = single-character shortcuts only while the plan or the
    // tool rail has focus.
    singleKeysAnywhere: prefs.singleKeysAnywhere !== false,
    modalOpen: isModalOpen,
  }
  app.ui = ui

  const root = h('div', { class: 'edt-shell' })
  const appBar = buildAppBar(app)
  const rail = buildToolRail(app)
  const toolBar = buildToolBar(app)
  const status = buildStatusBar(app)
  const selCard = buildSelectionCard(app)

  const center = h('main', { class: 'edt-center', 'aria-label': 'Viewport' })
  center.append(toolBar.el, app.viewportEl)
  app.viewportEl.setAttribute('role', 'region')
  app.viewportEl.setAttribute('aria-label', 'Plan viewport')
  // Described for keyboard / screen-reader users; no hover tooltip (it would
  // pop over the plan constantly). Shortcut names come from the registry.
  const vpHelp = h('div', { id: 'edt-viewport-help', class: 'edt-visually-hidden', text: viewportHelpText() })
  center.appendChild(vpHelp)
  app.viewportEl.setAttribute('aria-describedby', 'edt-viewport-help')
  // Clicking the plan gives it focus and arms Tab = 3D; a keyboard Tab onto
  // the viewport keeps moving focus (no trap), and Esc disarms it again.
  app.viewportEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest?.('.edt-welcome, .edt-section-head, .edt-section-handle')) return
    app._planPointerFocus = true
    if (document.activeElement !== app.viewportEl) app.viewportEl.focus({ preventScroll: true })
  })

  // --- inspector with tabs -----------------------------------------------------
  const inspector = h('aside', { class: 'edt-inspector', 'aria-label': 'Inspector' })
  const tablist = h('div', { class: 'edt-tabs', role: 'tablist', 'aria-label': 'Inspector panels' })
  const panels = h('div', { class: 'edt-tabpanels' })
  inspector.append(selCard.el, tablist, panels)

  const catalogSlot = h('div', { class: 'edt-slot', role: 'region', dataset: { slot: 'structure-catalog' }, 'aria-label': 'Structure catalog' })
  ui.structureCatalogSlot = catalogSlot
  const structures = buildStructurePanel(app)
  const catalog = buildCatalogPanel(app)
  catalogSlot.appendChild(catalog.el)
  const structuresTab = {
    el: h('div', { class: 'edt-tabbody' }, catalogSlot, structures.el),
    refresh: () => {
      catalog.refresh()
      structures.refresh()
    },
  }

  const tabImpl = {
    map: buildMapTab(app),
    view: buildViewTab(app),
    structures: structuresTab,
    create: buildAuthorPanel(app),
    simulate: buildSimPanel(app),
    inspect: buildInspectorPanel(app),
  }
  const tabButtons = {}
  const tabPanels = {}
  for (const t of TABS) {
    const b = h('button', {
      class: 'edt-tab', type: 'button', role: 'tab', id: `edt-tab-${t.id}`, 'aria-controls': `edt-panel-${t.id}`,
      dataset: { cmd: `tab.${t.id}` },
    }, icon(t.icon, { size: 15 }), h('span', { text: t.label }))
    b.addEventListener('click', () => ui.showTab(t.id))
    b.addEventListener('keydown', (e) => {
      const i = TABS.findIndex((x) => x.id === t.id)
      let j = null
      if (e.key === 'ArrowRight') j = (i + 1) % TABS.length
      else if (e.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length
      else if (e.key === 'Home') j = 0
      else if (e.key === 'End') j = TABS.length - 1
      if (j === null) return
      e.preventDefault()
      e.stopPropagation()
      ui.showTab(TABS[j].id)
      tabButtons[TABS[j].id].focus()
    })
    tablist.appendChild(b)
    tabButtons[t.id] = b
    const p = h('div', { class: 'edt-tabpanel', role: 'tabpanel', id: `edt-panel-${t.id}`, 'aria-labelledby': `edt-tab-${t.id}`, tabindex: -1 })
    p.appendChild(tabImpl[t.id].el)
    panels.appendChild(p)
    tabPanels[t.id] = p
  }

  const paintTabs = () => {
    for (const t of TABS) {
      const on = t.id === ui.activeTab
      tabButtons[t.id].setAttribute('aria-selected', String(on))
      tabButtons[t.id].tabIndex = on ? 0 : -1
      tabButtons[t.id].classList.toggle('edt-on', on)
      tabPanels[t.id].hidden = !on
    }
  }

  ui.showTab = (id) => {
    if (!tabImpl[id]) return
    ui.activeTab = id
    savePrefs({ tab: id })
    if (ui.inspectorHidden) ui.toggleInspector(true)
    paintTabs()
    tabImpl[id].refresh()
  }
  const applyInspector = () => {
    root.classList.toggle('edt-inspector-hidden', ui.inspectorHidden)
    requestAnimationFrame(() => {
      app.view2d.resize()
      app.preview?.resize()
    })
  }
  ui.setSingleKeysAnywhere = (on) => {
    ui.singleKeysAnywhere = !!on
    savePrefs({ singleKeysAnywhere: ui.singleKeysAnywhere })
    app.notify(on ? 'single-key shortcuts work anywhere outside text fields' : 'single-key shortcuts only while the plan or tool rail has focus', 'info')
    app.panel?.refresh()
  }
  ui.toggleInspector = (show = ui.inspectorHidden) => {
    ui.inspectorHidden = !show
    savePrefs({ inspectorHidden: ui.inspectorHidden })
    applyInspector()
    appBar.refresh()
  }

  // --- overlays and confirmations ------------------------------------------------
  ui.openPalette = () => { if (!isModalOpen()) openPalette(app) }
  ui.openHelp = () => { if (!isModalOpen()) openHelp() }
  const hasContent = () => app.map.chunks.size > 0 || app.map.authored?.length > 0
  ui.confirmNew = async () => {
    if (hasContent() && !(await confirmDialog({
      title: 'Start a new empty document?',
      body: `“${app.map.meta.name}” (${app.map.chunks.size} chunks) will be replaced by an empty document.`,
      note: 'This cannot be undone: the undo history and the browser autosave are cleared. Export first (Ctrl/⌘+S) to keep a copy.',
      confirmLabel: 'Discard and start new',
    }))) return
    app.newMap()
    app.notify('new empty document', 'info')
  }
  const confirmReplaceByFile = async () => !hasContent() || confirmDialog({
    title: 'Import and replace the document?',
    body: `Importing a .yrmap replaces “${app.map.meta.name}” (${app.map.chunks.size} chunks).`,
    note: 'This cannot be undone: the undo history is cleared. Export first (Ctrl/⌘+S) to keep a copy.',
    confirmLabel: 'Choose file…',
  })
  ui.confirmImport = async () => {
    if (await confirmReplaceByFile()) app.importMap()
  }
  ui.confirmImportFile = async (file) => {
    if (!hasContent() || await confirmDialog({
      title: `Import ${file.name}?`,
      body: `It replaces “${app.map.meta.name}” (${app.map.chunks.size} chunks).`,
      note: 'This cannot be undone: the undo history is cleared.',
      confirmLabel: 'Import',
    })) app._loadFile(file)
  }
  const confirmReplace = (what) => !app.structureLoad.replace || !hasContent() || confirmDialog({
    title: `${what} and replace the document?`,
    body: `“replace document” is on, so the current document (${app.map.chunks.size} chunks) is cleared first.`,
    note: 'Undoable with Ctrl/⌘+Z. Turn off “replace document” (Map → Explore, or the Structures tab) to merge instead.',
    confirmLabel: 'Replace document',
  })
  ui.confirmBakeView = async () => {
    if (await confirmReplace('Bake the explored view')) app.bakeViewToDocument()
  }
  ui.confirmLoadStructure = async (key) => {
    if (!key) return
    if (await confirmReplace('Load this structure volume')) app.loadStructure(key)
  }
  ui.generateKind = (kindId) => {
    ui.lab.kind = kindId
    app.generateKind(kindId, ui.lab.seed)
  }

  // --- welcome card --------------------------------------------------------------
  const welcome = h('div', { class: 'edt-welcome', role: 'dialog', 'aria-labelledby': 'edt-welcome-title', hidden: true })
  const startBtn = (iconName, label, tip, onClick) => {
    const b = h('button', { class: 'edt-welcome-btn', type: 'button', tip }, icon(iconName, { size: 20 }), h('span', { text: label }))
    b.addEventListener('click', onClick)
    return b
  }
  let welcomeDismissed = !!prefs.welcomeDismissed
  const dismissBtn = h('button', { class: 'edt-ibtn edt-welcome-close', type: 'button', 'aria-label': 'Close the welcome card',
    tip: { title: 'Close', text: 'Hide this card. It returns when the document is empty, unless you tick “don’t show again”.' } }, icon('close'))
  const never = h('input', { type: 'checkbox', id: 'edt-welcome-never' })
  welcome.append(
    dismissBtn,
    h('h2', { id: 'edt-welcome-title', text: 'Start a map' }),
    h('p', { text: 'The document is empty. Pick a starting point — everything is undoable except New and Import.' }),
    h('div', { class: 'edt-welcome-grid' },
      startBtn('play', 'Generate from seed', { title: 'Generate from seed', text: 'Bakes a 3×3-chunk area of the world seed and family (Map tab) into the document.' },
        () => { runCommand(commandById('world.generate'), app); ui.showTab('map') }),
      startBtn('globe', 'Explore the world (E)', { cmd: 'mode.explore' }, () => runCommand(commandById('mode.explore'), app)),
      startBtn('import', 'Open a .yrmap…', { cmd: 'file.import' }, () => app.importMap()),
      startBtn('author', 'Try a prototype kind', { title: 'Prototype kinds', text: 'Open the Create tab’s kind lab (underpass, parking deck, dead mall…).' },
        () => ui.showTab('create')),
      startBtn('keyboard', 'Shortcuts & help (?)', { cmd: 'ui.help' }, () => ui.openHelp()),
    ),
    h('label', { class: 'edt-welcome-never', tip: 'Never show this card again in this browser.' }, never, ' Don’t show again'),
  )
  dismissBtn.addEventListener('click', () => {
    welcomeDismissed = true
    if (never.checked) savePrefs({ welcomeDismissed: true })
    welcome.hidden = true
  })
  app.viewportEl.appendChild(welcome)

  root.append(appBar.el, rail.el, center, inspector, status.el)
  ui.status = status
  ui.tooltips = installTooltips(root, app)

  paintTabs()
  applyInspector()

  const refresh = () => {
    appBar.refresh()
    rail.refresh()
    toolBar.refresh()
    selCard.refresh()
    tabImpl[ui.activeTab].refresh()
    welcome.hidden = welcomeDismissed || app.mode !== 'document' || app.map.chunks.size > 0 || !!app.preview
    ui.tooltips.update()
  }

  return { el: root, refresh }
}

// The viewport's screen-reader description, with key names taken from the
// keymap registry so it cannot drift from the handler.
export function viewportHelpText() {
  const k = (id) => (commandById(id)?.keys ?? []).map((c) => formatChord(c, { mac: isMac() })).join(' / ')
  return 'Plan of the current floor. Left drag uses the active tool, right or middle drag pans, wheel zooms. '
    + `After clicking the plan, ${k('view.preview3d')} toggles 3D; Shift+Tab or ${k('ui.escape')} gives Tab back to moving between controls. `
    + `${k('view.fit')} fits the document (with the Section tool it toggles “follow cursor”), ${k('view.floorUp')} / ${k('view.floorDown')} change floor. `
    + `Press ${k('ui.help')} for all shortcuts.`
}
