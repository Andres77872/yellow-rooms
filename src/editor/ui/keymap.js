// The editor's single source of truth for commands and keyboard shortcuts.
// The key handler (EditorApp._bindKeys), the help overlay, the tooltips'
// shortcut chips and the command palette all read COMMANDS — a shortcut is
// declared once, here. DOM-free so node tests can check it.
//
// A command: { id, group, label, hint, keys?, when?, enabled?, checked?,
// run, icon?, undo?, fieldSafe?, idleFocus?, palette? }
//   keys      chords as produced by chordOf ('Mod+Shift+Z', 'PageUp', '?')
//   when      scope string (see scopeActive); commands sharing a chord must
//             have mutually exclusive scopes ('tool:section' / '!tool:section')
//   enabled   (app) => true | 'reason it is unavailable'
//   checked   (app) => boolean, for toggles and the active tool / tab
//   undo      'undoable' | 'not undoable' | 'view only', shown in tooltips
//   fieldSafe the chord also fires while typing in a text field
//   idleFocus the chord only fires while the viewport has focus from a
//             click on the plan (Tab keeps moving focus between controls
//             otherwise, including after a keyboard Tab onto the viewport)

export const TOOL_META = Object.freeze([
  { id: 'select', label: 'Select / move', icon: 'select', group: 'edit',
    hint: 'Click a room, piece or lamp to select it; drag a piece or lamp to move it. In explore mode a click pins the cell in the Inspect tab.' },
  { id: 'room', label: 'Room', icon: 'room', group: 'edit',
    hint: 'Drag a rectangle; on release a furnished room is generated there (type and centre lamp are in the tool bar). Undoable.' },
  { id: 'wall', label: 'Wall pen', icon: 'wall', group: 'edit',
    hint: 'Click a cell edge, or drag along grid lines, to draw wall / door / wide opening / window / rail — or erase edges. Undoable.' },
  { id: 'cell', label: 'Cell paint', icon: 'cell', group: 'edit',
    hint: 'Paint cell kinds (open, corridor, lobby). Rooms come from the Room tool. Undoable.' },
  { id: 'object', label: 'Furniture', icon: 'object', group: 'edit',
    hint: 'Click a free cell to place the chosen piece. R turns the piece before you place it. Undoable.' },
  { id: 'lamp', label: 'Lamp', icon: 'lamp', group: 'edit',
    hint: 'Click a ceiling cell to cycle: none → lit → dead → none. Undoable.' },
  { id: 'erase', label: 'Eraser', icon: 'erase', group: 'edit',
    hint: 'Drag to clear furniture, lamps, room labels and the cell’s edges. Undoable.' },
  { id: 'section', label: 'Section cut', icon: 'section', group: 'analyze',
    hint: 'Click to place the vertical section cut. With this tool: X swaps the cut axis, F makes the cut follow the cursor.' },
  { id: 'probe', label: 'Probe', icon: 'probe', group: 'analyze',
    hint: 'Click to run the probe chosen in the tool bar: inspect a cell, walk-distance field, A→B path or isovist. Read-only; works while exploring.' },
  { id: 'author', label: 'Author structure', icon: 'author', group: 'create',
    hint: 'Drag (or click, for the stairwell) to place the template chosen in the Create tab. Green = it fits; red = refused, with the reason. Undoable.' },
])

export const TOOL_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']

export const TABS = Object.freeze([
  { id: 'map', label: 'Map', icon: 'map', hint: 'Document file, procedural start, explore the generated world, document review and the rooms list.' },
  { id: 'view', label: 'View', icon: 'eye', hint: 'Floors, plan layers with colour legends, fill modes, section cut and 3D preview settings.' },
  { id: 'structures', label: 'Structures', icon: 'building', hint: 'Multilevel structure atlas: scan the generator, load complete volumes, audit and drift per storey.' },
  { id: 'create', label: 'Create', icon: 'author', hint: 'Author structure templates and generate prototype map kinds.' },
  { id: 'simulate', label: 'Simulate', icon: 'pulse', hint: 'Probes, light and the liminal metrics report; lighting lab.' },
  { id: 'inspect', label: 'Inspect', icon: 'info', hint: 'The pinned cell / chunk inspector.' },
])

export const PROBES = Object.freeze([
  { id: 'inspect', label: 'inspect', hint: 'Click pins the cell: its chunk, descriptors and flags appear in the Inspect tab.' },
  { id: 'distance', label: 'distance', hint: 'Click floods a walk-distance field from the cell (across stairs, within the floors ± range).' },
  { id: 'path', label: 'path A→B', hint: 'Two clicks: A then B (change floor between them for a vertical route). Shows the shortest walk.' },
  { id: 'isovist', label: 'isovist', hint: 'Click shows everything visible from the cell on this floor (area, deepest and mean sightline).' },
])

export const FILL_MODES = Object.freeze([
  { id: 'kind', label: 'kind', title: 'Cell kind', hint: 'Plain plan colours by cell kind (room, corridor, lobby, stair, atrium, void, bridge).' },
  { id: 'zone', label: 'zone', title: 'Zone', hint: 'Tints each chunk by the zone the generator elected (office, pillars, warehouse, sewer).' },
  { id: 'space', label: 'space', title: 'Space id', hint: 'One colour per space id — shows how the generator partitioned rooms and halls.' },
  { id: 'role', label: 'role', title: 'Room role', hint: 'Colours cells by semantic room role (meeting, break, archive…).' },
  { id: 'owner', label: 'owner', title: 'Structure owner', hint: 'Tints chunks that take part in a multilevel structure and tags slab slices / stair links.' },
  { id: 'gen', label: 'gen ms', title: 'Generation time', hint: 'Per-chunk generation cost as a heat map (explore mode only: the document has no timings).' },
])

// --- scopes ---------------------------------------------------------------

export const SCOPE_LABEL = {
  'tool:section': 'Section tool',
  '!tool:section': 'not with the Section tool',
  'tool:object': 'Furniture tool',
  '!tool:object': 'not with the Furniture tool',
  preview: '3D preview',
  '!preview': 'plan view',
}

export function scopeActive(when, app) {
  if (!when) return true
  const neg = when.startsWith('!')
  const w = neg ? when.slice(1) : when
  let on
  if (w.startsWith('tool:')) on = app.tool?.id === w.slice(5)
  else if (w === 'preview') on = !!app.preview
  else if (w === 'explore') on = app.mode === 'explore'
  else on = true
  return neg ? !on : on
}

// --- chords ---------------------------------------------------------------

const KEY_ALIASES = { ' ': 'Space', Esc: 'Escape', Del: 'Delete', Spacebar: 'Space' }

// KeyboardEvent-like -> canonical chord. Letters are upper-cased and keep
// Shift only together with Mod / Alt (Shift+V is still V, as before the
// registry; Caps Lock too); other printable keys already carry Shift in
// e.key ('?', '+').
export function chordOf(e) {
  let key = KEY_ALIASES[e.key] ?? e.key
  if (!key) return ''
  const parts = []
  const mod = e.ctrlKey || e.metaKey
  if (mod) parts.push('Mod')
  if (e.altKey) parts.push('Alt')
  const letter = key.length === 1 && /[a-z]/i.test(key)
  if (letter) key = key.toUpperCase()
  const named = key.length > 1
  if (e.shiftKey && ((letter && (mod || e.altKey)) || named)) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

// A chord that is one printable character with no Ctrl / ⌘ / Alt (WCAG 2.1.4
// “character key shortcuts”): 'R', '1', '?', '=' — not 'Mod+Z', 'PageUp', 'F1'.
export function isSingleCharChord(chord) {
  return typeof chord === 'string' && chord.length === 1
}

// Elements where typed characters belong to the control, not to shortcuts:
// text-like inputs, selects, textareas and contenteditable. Checkboxes,
// radios, ranges, buttons and colour pickers are not fields.
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'number', 'email', 'url', 'tel', 'password', 'date', 'time', 'datetime-local', 'month', 'week'])
export function isTextField(t) {
  if (!t || typeof t.tagName !== 'string') return false
  if (t.tagName === 'INPUT') return TEXT_INPUT_TYPES.has((t.type || 'text').toLowerCase())
  return t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || !!t.isContentEditable
}

const KEY_LABEL = {
  Delete: 'Del', Backspace: '⌫', PageUp: 'PgUp', PageDown: 'PgDn', Escape: 'Esc',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space',
}

export function formatChord(chord, { mac = false } = {}) {
  if (chord === '+') return '+'
  const out = chord.split('+').map((p) => {
    if (p === 'Mod') return mac ? '⌘' : 'Ctrl'
    if (p === 'Shift') return mac ? '⇧' : 'Shift'
    if (p === 'Alt') return mac ? '⌥' : 'Alt'
    return KEY_LABEL[p] ?? p
  })
  return mac ? out.join('') : out.join('+')
}

// --- the registry ------------------------------------------------------------

const READ_ONLY = 'Read-only while exploring — switch back to the document (E)'
const needDoc = (app) => (app.readOnly ? READ_ONLY : true)
const needSelection = (type) => (app) => {
  if (app.readOnly) return 'Read-only while exploring'
  if (!app.selection) return 'Select something first (tool 1)'
  if (type && app.selection.type !== type) return `Select a ${type} first`
  return true
}
export const PLAN_ONLY = 'Plan only — in 3D use the mouse wheel'
const planOnly = (app) => (app.preview ? PLAN_ONLY : true)
const needStructure = (app) => (app.selectedStructure?.() ? true : 'Select a structure in the Structures tab first')

const LAYERS = [
  ['grid', 'Cell grid', 'Thin lines between cells (visible when zoomed in).'],
  ['labels', 'Room labels', 'Room id and role written in each room.'],
  ['ghost', 'Floor below (ghost)', 'A faint blue ghost of the storey below — what a slab opening or stair looks down on.'],
  ['ceiling', 'Ceiling openings', 'Dashed violet outline where the ceiling above is open.'],
  ['stairs', 'Stair arrows', 'Yellow ↑ arrows climb to the floor above; teal ↓ arrows descend.'],
  ['structures', 'Structure outlines', 'Outlines of multilevel structures, coloured by family; the selected one is highlighted.'],
  ['lethal', 'Lethal voids', 'Red = open drop; orange = invalid half cell (a contract bug).'],
  ['issues', 'Audit markers', 'Numbered red (error) / orange (warning) pins from the latest audit.'],
  ['diff', 'Drift cells', 'Magenta cells differ from what the generator produces for this seed.'],
  ['sim', 'Simulation overlays', 'Walk-distance heat, A→B path (green), isovist (cyan), light field and dark cells.'],
]
export const LAYER_META = Object.freeze(LAYERS.map(([id, label, hint]) => ({ id, label, hint })))

function buildCommands() {
  const c = []
  const add = (cmd) => c.push(cmd)

  // Help & navigation
  add({ id: 'ui.palette', group: 'Help', label: 'Command palette', icon: 'search', keys: ['Mod+K'], fieldSafe: true,
    hint: 'Search and run any editor action by name.', run: (app) => app.ui?.openPalette() })
  add({ id: 'ui.help', group: 'Help', label: 'Keyboard shortcuts & help', icon: 'help', keys: ['?', 'F1'],
    hint: 'Every shortcut, mouse gesture, the plan colour legend and a quick start.', run: (app) => app.ui?.openHelp() })
  add({ id: 'ui.escape', group: 'Edit', label: 'Cancel / deselect', keys: ['Escape'], fieldSafe: true,
    hint: 'Cancels the gesture in progress; otherwise clears the selection. Closes open popovers and dialogs.',
    run: (app) => app.escape?.() })
  add({ id: 'ui.inspector', group: 'Help', label: 'Show / hide the side panel', icon: 'panel',
    hint: 'Collapses the inspector on the right to give the viewport more room.', run: (app) => app.ui?.toggleInspector() })
  for (const t of TABS) {
    add({ id: `tab.${t.id}`, group: 'Panels', label: `${t.label} tab`, icon: t.icon, hint: t.hint,
      checked: (app) => app.ui?.activeTab === t.id, run: (app) => app.ui?.showTab(t.id) })
  }

  // File
  add({ id: 'file.new', group: 'File', label: 'New empty document', icon: 'file', undo: 'not undoable',
    hint: 'Replaces the document with an empty one and clears the undo history and autosave. Asks first.',
    run: (app) => app.ui?.confirmNew() })
  add({ id: 'file.import', group: 'File', label: 'Import .yrmap…', icon: 'import', keys: ['Mod+O'], fieldSafe: true, undo: 'not undoable',
    hint: 'Opens a .yrmap file and replaces the document (undo history is cleared). You can also drop a file on the viewport.',
    run: (app) => app.ui?.confirmImport() })
  add({ id: 'file.export', group: 'File', label: 'Export .yrmap', icon: 'export', keys: ['Mod+S'], fieldSafe: true,
    hint: 'Downloads the document as <name>.yrmap. The document also autosaves in this browser.',
    run: (app) => app.exportMap() })

  // Edit
  add({ id: 'edit.undo', group: 'Edit', label: 'Undo', icon: 'undo', keys: ['Mod+Z'],
    hint: 'Undo the last document change.', enabled: (app) => (app.readOnly ? READ_ONLY : app.canUndo?.() ? true : 'Nothing to undo'),
    run: (app) => app.undo() })
  add({ id: 'edit.redo', group: 'Edit', label: 'Redo', icon: 'redo', keys: ['Mod+Shift+Z', 'Mod+Y'],
    hint: 'Redo the last undone change.', enabled: (app) => (app.readOnly ? READ_ONLY : app.canRedo?.() ? true : 'Nothing to redo'),
    run: (app) => app.redo() })
  add({ id: 'edit.delete', group: 'Edit', label: 'Delete selection', icon: 'trash', keys: ['Delete', 'Backspace'], undo: 'undoable',
    hint: 'Deletes the selected piece, lamp or room.', enabled: needSelection(null), run: (app) => app.deleteSelection() })
  add({ id: 'edit.rotate', group: 'Edit', label: 'Rotate selected piece', icon: 'rotate', keys: ['R'], when: '!tool:object', undo: 'undoable',
    hint: 'Turns the selected furniture piece 90°. (With the Furniture tool active, R turns the piece about to be placed instead.)',
    enabled: needSelection('furniture'), run: (app) => app.rotateSelection() })
  add({ id: 'object.turn', group: 'Edit', label: 'Turn the piece to place', icon: 'rotate', keys: ['R'], when: 'tool:object',
    hint: 'Furniture tool: turns the next piece 90° before you place it.', run: (app) => app.turnObjectFacing() })
  add({ id: 'edit.protect', group: 'Edit', label: 'Protect structures', icon: 'lock',
    hint: 'While on, edit tools skip slab openings, stairs, bridges, atria and guard rails so structure contracts stay intact.',
    checked: (app) => !!app.protect, run: (app) => { app.protect = !app.protect; app.panel.refresh() } })

  // Tools
  TOOL_META.forEach((t, i) => {
    add({ id: `tool.${t.id}`, group: 'Tools', label: `${t.label} tool`, icon: t.icon, keys: [TOOL_KEYS[i]], hint: t.hint,
      checked: (app) => app.tool?.id === t.id,
      enabled: (app) => (app.readOnly && app.tools?.find((x) => x.id === t.id)?.edits
        ? 'Read-only while exploring — bake the view into the document to edit' : true),
      run: (app) => app.setToolById(t.id) })
  })

  // View
  add({ id: 'view.preview3d', group: 'View', label: '3D preview', icon: 'cube', keys: ['Tab'], idleFocus: true,
    hint: 'Swap the plan for an orbitable 3D preview (drag: orbit · right-drag: pan · wheel: zoom). Tab toggles it after you click the plan (Shift+Tab or Esc hands Tab back to focus navigation); elsewhere Tab moves between controls.',
    checked: (app) => !!app.preview, run: (app) => app.setPreview(!app.preview) })
  add({ id: 'view.section', group: 'View', label: 'Section view', icon: 'section', keys: ['V'],
    hint: 'Open or close the vertical section dock under the plan.',
    checked: (app) => !!app.section?.on, run: (app) => app.setSectionOpen(!app.section.on) })
  add({ id: 'section.swap', group: 'View', label: 'Swap section axis', icon: 'swap', keys: ['X'], when: 'tool:section',
    hint: 'Cut along the other axis, through the hovered cell. The key works with the Section tool (8).',
    run: (app) => app.swapSectionAxis() })
  add({ id: 'section.follow', group: 'View', label: 'Section follows cursor', icon: 'crosshair', keys: ['F'], when: 'tool:section',
    hint: 'The cut line tracks the cursor while you hover the plan. The key works with the Section tool (8).',
    checked: (app) => !!app.section?.follow, run: (app) => app.setSectionFollow(!app.section.follow) })
  add({ id: 'view.fit', group: 'View', label: 'Fit document in view', icon: 'fit', keys: ['F'], when: '!tool:section',
    hint: 'Zoom the plan to show every chunk of the document (or the selected structure while exploring).',
    run: (app) => app.fitDocument() })
  add({ id: 'view.fitHome', group: 'View', label: 'Fit plan (Home)', icon: 'fit', keys: ['Home'], when: '!preview', palette: false,
    hint: 'Zoom the plan to the whole document.', run: (app) => app.fitDocument() })
  add({ id: 'view.reset3d', group: 'View', label: 'Reset 3D view', icon: 'home', keys: ['Home'], when: 'preview',
    hint: 'Re-frame the 3D preview on the document (or the selected structure).', run: (app) => app.resetPreviewView() })
  add({ id: 'view.zoomIn', group: 'View', label: 'Zoom in', icon: 'zoomIn', keys: ['=', '+'],
    hint: 'Zoom the plan in around its centre (the wheel zooms at the cursor).', enabled: planOnly, run: (app) => app.zoomBy(1.25) })
  add({ id: 'view.zoomOut', group: 'View', label: 'Zoom out', icon: 'zoomOut', keys: ['-'],
    hint: 'Zoom the plan out around its centre.', enabled: planOnly, run: (app) => app.zoomBy(0.8) })
  add({ id: 'view.floorUp', group: 'View', label: 'Floor up', icon: 'up', keys: ['PageUp'],
    hint: 'Show the storey above (cy + 1). View only — never changes the document.', run: (app) => app.setFloor(app.floor + 1) })
  add({ id: 'view.floorDown', group: 'View', label: 'Floor down', icon: 'down', keys: ['PageDown'],
    hint: 'Show the storey below (cy − 1). View only.', run: (app) => app.setFloor(app.floor - 1) })
  add({ id: 'view.ceiling3d', group: 'View', label: 'Ceilings in 3D', icon: 'cube',
    hint: 'Show ceilings and light troffers in the 3D preview (turn off to look into rooms from above).',
    checked: (app) => app.previewCeiling !== false, run: (app) => app.setPreviewCeiling(app.previewCeiling === false) })
  for (const l of LAYER_META) {
    add({ id: `layer.${l.id}`, group: 'Layers', label: `Layer: ${l.label}`, icon: 'layers', hint: l.hint,
      checked: (app) => !!app.layers?.[l.id],
      run: (app) => { app.layers[l.id] = !app.layers[l.id]; app.invalidate(); app.panel.refresh() } })
  }
  for (const f of FILL_MODES) {
    add({ id: `fill.${f.id}`, group: 'Layers', label: `Fill: ${f.title}`, icon: 'palette', hint: f.hint,
      checked: (app) => app.fillMode === f.id,
      run: (app) => { app.fillMode = f.id; app.invalidate(); app.panel.refresh() } })
  }

  // Explore / world
  add({ id: 'mode.explore', group: 'World', label: 'Explore world / back to document', icon: 'globe', keys: ['E'],
    hint: 'Browse the infinite generated world of the world seed + family, read-only (the world debugger). E again returns to the document.',
    checked: (app) => app.mode === 'explore', run: (app) => app.toggleExplore() })
  add({ id: 'world.reopen', group: 'World', label: 'Explore the new seed / family', icon: 'refresh',
    hint: 'While exploring: re-open the explorer on the world seed and family now set in the Map tab (the old world is dropped).',
    enabled: (app) => (app.mode !== 'explore' ? 'Only while exploring (E)'
      : app.explorer?.sameWorld?.(app.world.seedText, app.world.family) ? 'Already exploring this seed and family' : true),
    run: (app) => app.enterExplore() })
  add({ id: 'world.generate', group: 'World', label: 'Generate into document', icon: 'play', undo: 'undoable',
    hint: 'Bakes generated chunks (world seed, family, radius, floors) around the view centre into the document, over what is there.',
    enabled: needDoc, run: (app) => app.bakeWorld() })
  add({ id: 'world.bakeView', group: 'World', label: 'Bake explored view → document', icon: 'download', undo: 'undoable',
    hint: 'Copies the explored view (current floor ± 1) into the document and switches to editing. Replaces the document when “replace document” is on (asks first).',
    enabled: (app) => (app.mode === 'explore' ? true : 'Only while exploring (E)'), run: (app) => app.ui?.confirmBakeView() })
  add({ id: 'world.refresh3d', group: 'World', label: 'Refresh 3D window', icon: 'refresh',
    hint: 'Re-centres the explorer’s 3D window (5×5 chunks × 5 floors) on the current view.',
    enabled: (app) => (app.mode !== 'explore' ? 'Only while exploring (E)' : app.preview ? true : 'Open the 3D preview first (Tab)'),
    run: (app) => app.refreshPreviewWindow() })

  // Structures
  add({ id: 'struct.scan', group: 'Structures', label: 'Scan structure atlas around view', icon: 'scan',
    hint: 'Asks the generator’s planners which multilevel structures lie in the scan box around the view (no chunks generated).',
    run: (app) => app.scanStructures() })
  add({ id: 'struct.clear', group: 'Structures', label: 'Clear atlas scan', icon: 'close',
    hint: 'Forget the scan results (document structures stay listed).', run: (app) => app.clearStructureScan() })
  add({ id: 'struct.load', group: 'Structures', label: 'Load selected structure volume', icon: 'download', undo: 'undoable',
    hint: 'Generates every chunk of the structure’s band (plus the context ring) into the document in one undo step. Replaces the document when “replace document” is on (asks first).',
    enabled: needStructure, run: (app) => app.ui?.confirmLoadStructure(app.selectedStructureKey) })
  add({ id: 'struct.focus', group: 'Structures', label: 'Focus selected structure', icon: 'fit',
    hint: 'Frame the plan on the structure, move into its band, cut a section through it and frame the 3D view.',
    enabled: needStructure, run: (app) => app.focusStructure(app.selectedStructureKey) })
  add({ id: 'struct.audit', group: 'Structures', label: 'Audit selected structure', icon: 'check',
    hint: 'Checks slab contracts, stair links and reachability storey by storey.', enabled: needStructure,
    run: (app) => app.auditSelectedStructure() })
  add({ id: 'struct.drift', group: 'Structures', label: 'Drift of selected structure vs generator', icon: 'diff',
    hint: 'Regenerates the structure’s chunks and lists every cell the document differs in.',
    enabled: (app) => (app.readOnly ? 'The explorer IS the generator — drift needs a document' : needStructure(app)),
    run: (app) => app.diffSelectedStructure() })

  // Review
  add({ id: 'review.audit', group: 'Review', label: 'Audit whole document', icon: 'check',
    hint: 'Structural audit of every chunk: slabs, stair links, planar pockets.', enabled: needDoc,
    run: (app) => app.auditWholeDocument() })
  add({ id: 'review.drift', group: 'Review', label: 'Drift of whole document vs generator', icon: 'diff',
    hint: 'Regenerates every document chunk from its seed and marks the cells that differ (magenta).', enabled: needDoc,
    run: (app) => app.diffWholeDocument() })
  add({ id: 'review.clear', group: 'Review', label: 'Clear audit & drift results', icon: 'close',
    hint: 'Removes audit markers and drift cells.', run: (app) => app.clearReview() })

  // Simulate
  for (const p of PROBES) {
    add({ id: `probe.${p.id}`, group: 'Simulate', label: `Probe: ${p.label}`, icon: 'probe', hint: `${p.hint} Selects the Probe tool.`,
      checked: (app) => app.tool?.id === 'probe' && app.sim?.probe === p.id,
      run: (app) => { app.sim.probe = p.id; app.setToolById('probe') } })
  }
  add({ id: 'sim.light', group: 'Simulate', label: 'Light simulation (this floor)', icon: 'lamp',
    hint: 'Computes the light field of the current floor and marks dark cells.', run: (app) => app.runLight() })
  add({ id: 'sim.report', group: 'Simulate', label: 'Liminal report', icon: 'table',
    hint: 'Per-floor metrics table: loops, dead ends, ring share, ICD, intelligibility, darkness, clustering, sightlines, repetition.',
    run: (app) => app.runReport() })
  add({ id: 'sim.clear', group: 'Simulate', label: 'Clear simulations', icon: 'close',
    hint: 'Removes every simulation overlay and the report.', run: (app) => app.clearSim() })
  add({ id: 'sim.relightCircuits', group: 'Simulate', label: 'Relight by circuits', icon: 'lamp', undo: 'undoable',
    hint: 'MODIFIES THE DOCUMENT: re-assigns this floor’s dead lamps by lighting circuit (same dead budget). Undoable.',
    enabled: needDoc, run: (app) => app.relight('circuit') })
  add({ id: 'sim.relightZones', group: 'Simulate', label: 'Relight by breaker zones', icon: 'lamp', undo: 'undoable',
    hint: 'MODIFIES THE DOCUMENT: re-assigns this floor’s dead lamps by breaker zone (same dead budget). Undoable.',
    enabled: needDoc, run: (app) => app.relight('zone') })

  // Inspect
  add({ id: 'inspect.log', group: 'Inspect', label: 'Log inspected chunk to console', icon: 'terminal',
    hint: 'Prints the pinned cell’s chunk and descriptors to the console and stores them in window.__editorInspect.',
    enabled: (app) => (app.inspect ? true : 'Pin a cell first (Probe → inspect)'), run: (app) => app.logInspectedChunk() })
  add({ id: 'inspect.unpin', group: 'Inspect', label: 'Unpin inspected cell', icon: 'close',
    hint: 'Clears the inspector pin.', enabled: (app) => (app.inspect ? true : 'Nothing pinned'),
    run: (app) => { app.inspect = null; app.panel.refresh(); app.invalidate() } })

  for (const cmd of c) {
    if (cmd.palette === undefined) cmd.palette = true
    Object.freeze(cmd)
  }
  return Object.freeze(c)
}

export const COMMANDS = buildCommands()
const BY_ID = new Map(COMMANDS.map((cmd) => [cmd.id, cmd]))

export const commandById = (id) => BY_ID.get(id) ?? null

// The command a chord runs in the app's current state (scope-aware).
export function commandForChord(chord, app, commands = COMMANDS) {
  for (const cmd of commands) {
    if (!cmd.keys?.includes(chord)) continue
    if (!scopeActive(cmd.when, app)) continue
    return cmd
  }
  return null
}

// true when runnable, else the reason string.
export function commandState(cmd, app) {
  const enabled = cmd.enabled ? cmd.enabled(app) : true
  return {
    enabled: enabled === true,
    reason: enabled === true ? '' : String(enabled || 'Unavailable'),
    checked: cmd.checked ? !!cmd.checked(app) : null,
  }
}

export function runCommand(cmd, app) {
  if (!cmd) return false
  const st = commandState(cmd, app)
  if (!st.enabled) {
    app.notify?.(`${cmd.label}: ${st.reason}`, 'warn')
    return false
  }
  cmd.run(app)
  return true
}

// Rows for the help overlay: every command with a shortcut, grouped.
export function helpRows(commands = COMMANDS) {
  const groups = new Map()
  for (const cmd of commands) {
    if (!cmd.keys?.length) continue
    const list = groups.get(cmd.group) ?? []
    list.push({ id: cmd.id, keys: cmd.keys, label: cmd.label, scope: cmd.when ? SCOPE_LABEL[cmd.when] ?? cmd.when : '' })
    groups.set(cmd.group, list)
  }
  return [...groups.entries()].map(([group, rows]) => ({ group, rows }))
}

// Mouse gestures, for the help overlay.
export const GESTURES = Object.freeze([
  { where: 'Plan', rows: [
    ['Left drag / click', 'use the active tool'],
    ['Right or middle drag', 'pan'],
    ['Wheel', 'zoom at the cursor'],
    ['Drop a .yrmap file', 'import it (replaces the document; asks first)'],
  ] },
  { where: 'Section dock', rows: [
    ['Click', 'jump to that cell and floor'],
    ['Right or middle drag', 'pan along the cut'],
    ['Wheel', 'zoom (shared with the plan)'],
    ['Drag the top edge', 'resize the dock'],
  ] },
  { where: '3D preview', rows: [
    ['Left drag', 'orbit'],
    ['Right or middle drag', 'pan'],
    ['Wheel', 'zoom'],
    ['Home', 'reset the view'],
  ] },
])

export const QUICK_START = Object.freeze([
  'Map tab → World: pick a seed and family, then “Generate into document” — or press E to explore the infinite world read-only.',
  'Pick a tool from the left rail (keys 1–9, 0). Room (2) drags out furnished rooms; Wall (3) draws walls, doors and windows.',
  'Change floors with PgUp / PgDn or the floor stepper; V opens a vertical section, Tab a 3D preview.',
  'Structures tab: scan the atlas, load a complete multilevel volume, then audit it storey by storey.',
  'Ctrl/⌘+Z undoes, Ctrl/⌘+S exports a .yrmap, Ctrl/⌘+K finds any action by name.',
])

// --- fuzzy search ----------------------------------------------------------------

// Subsequence match with bonuses for word starts and runs; -1 = no match.
export function fuzzyScore(query, text) {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()
  const direct = t.indexOf(q)
  if (direct >= 0) return 1000 - direct + (direct === 0 || /[\s:/(.·-]/.test(t[direct - 1]) ? 200 : 0)
  let score = 0
  let ti = 0
  let run = 0
  for (const ch of q) {
    if (ch === ' ') continue
    const at = t.indexOf(ch, ti)
    if (at < 0) return -1
    const wordStart = at === 0 || /[\s:/(.·-]/.test(t[at - 1])
    run = at === ti ? run + 1 : 0
    score += 10 + (wordStart ? 15 : 0) + run * 5 - Math.min(9, at - ti)
    ti = at + 1
  }
  return score
}

export function fuzzyRank(query, items, textOf = (x) => x) {
  if (!query.trim()) return items.slice()
  return items
    .map((item, i) => ({ item, i, s: fuzzyScore(query, textOf(item)) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.item)
}

// Palette entries from the registry (dynamic ones — floors, cells,
// templates, kinds, structures — are added by the palette UI).
export function paletteCommands(commands = COMMANDS) {
  return commands.filter((cmd) => cmd.palette !== false)
}
