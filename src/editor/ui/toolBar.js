import { segmented, toggle } from '../../debug/widgets.js'
import { PROBES, TOOL_KEYS, TOOL_META, commandById, runCommand } from './keymap.js'
import { CELL_MODES, WALL_MODES } from './tools.js'
import { TEMPLATE_DEFS } from '../templates.js'
import { FURN_NAMES, ROLE_OPTIONS, row, selectInput } from './options.js'
import { h, iconButton, setDisabled, setPressed } from './dom.js'
import { icon } from './icons.js'

// Contextual tool bar above the viewport: the active tool's name, its
// options (built once per tool, values updated in place so an open <select>
// or a drag is never interrupted) and the view controls.

const WALL_TIPS = {
  wall: 'Solid wall on the clicked edge.',
  door: 'A doorway in the edge (walkable, drawn teal).',
  wide: 'A wide opening: walkable, no door leaf.',
  window: 'A wall with a window (blocks walking, not sight).',
  rail: 'A guard rail: see-through, blocks walking (atrium edges).',
  open: 'Erase the edge: no wall, fully open.',
}
const CELL_TIPS = {
  open: 'Plain open floor.',
  corridor: 'Corridor cells (circulation).',
  lobby: 'Lobby cells (large open halls).',
}
const FACING = ['+z', '−z', '+x', '−x'] // ChunkData facing index (DIR order)

export function buildToolBar(app) {
  const bar = h('div', { class: 'edt-toolbar', role: 'region', 'aria-label': 'Tool options and view controls' })
  const title = h('div', { class: 'edt-tb-title' })
  const opts = h('div', { class: 'edt-tb-opts' })
  const hint = h('div', { class: 'edt-tb-hint' })
  const view = h('div', { class: 'edt-tb-view', role: 'group', 'aria-label': 'View' })
  bar.append(title, opts, hint, view)

  const tool = (id) => app.tools.find((t) => t.id === id)
  const panels = {}
  const updaters = {}

  panels.room = () => {
    const t = tool('room')
    const sel = selectInput(ROLE_OPTIONS, t.role, (v) => { t.role = Number(v) },
      { tip: { title: 'Room type', text: 'The role of rooms you drag out: ordinary rolls a theme; others furnish it as that role.' }, label: 'Room type' })
    const lamp = toggle({ label: 'centre lamp', value: t.withLamp, onChange: (v) => { t.withLamp = v },
      tip: 'Also place a lit lamp at the centre of each new room.' })
    updaters.room = () => {
      if (document.activeElement !== sel) sel.value = String(t.role)
      lamp.set(t.withLamp)
    }
    return [row('type', sel), lamp.el]
  }
  panels.wall = () => {
    const t = tool('wall')
    const seg = segmented({ labels: WALL_MODES.map((m) => m.label), value: t.mode, onPick: (i) => { t.mode = i },
      tips: WALL_MODES.map((m) => ({ title: `Edge: ${m.label}`, text: WALL_TIPS[m.key] ?? '' })), ariaLabel: 'Edge type' })
    updaters.wall = () => seg.set(t.mode)
    return [seg.el]
  }
  panels.cell = () => {
    const t = tool('cell')
    const seg = segmented({ labels: CELL_MODES.map((m) => m.label), value: t.mode, onPick: (i) => { t.mode = i },
      tips: CELL_MODES.map((m) => ({ title: `Cell kind: ${m.label}`, text: CELL_TIPS[m.key] ?? '' })), ariaLabel: 'Cell kind' })
    updaters.cell = () => seg.set(t.mode)
    return [seg.el]
  }
  panels.object = () => {
    const t = tool('object')
    const sel = selectInput(Object.entries(FURN_NAMES).map(([value, label]) => ({ value, label })), t.kind,
      (v) => { t.kind = Number(v) }, { tip: { title: 'Furniture piece', text: 'The piece the next click places.' }, label: 'Furniture piece' })
    const facing = h('span', { class: 'edt-chip', tip: { title: 'Facing of the next piece', text: 'Press R (or the turn button) to rotate it 90° before placing.', keys: 'R' } })
    const turn = iconButton({ icon: 'rotate', label: 'Turn piece', cmd: 'object.turn', onClick: () => runCommand(commandById('object.turn'), app) })
    updaters.object = () => {
      if (document.activeElement !== sel) sel.value = String(t.kind)
      facing.textContent = `facing ${FACING[t.facing] ?? t.facing}`
    }
    return [row('piece', sel), facing, turn]
  }
  panels.section = () => {
    const axis = segmented({ labels: ['cut along x', 'cut along z'], value: app.section.axis === 'x' ? 0 : 1,
      onPick: (i) => app.setSectionAxis(i === 0 ? 'x' : 'z'), ariaLabel: 'Section axis',
      tips: [
        { title: 'Cut along x', text: 'The section runs east–west through one row of cells.', keys: 'X' },
        { title: 'Cut along z', text: 'The section runs north–south through one column of cells.', keys: 'X' },
      ] })
    const follow = iconButton({ icon: 'crosshair', label: 'Follow cursor', showLabel: true, cmd: 'section.follow',
      onClick: () => runCommand(commandById('section.follow'), app) })
    updaters.section = () => {
      axis.set(app.section.axis === 'x' ? 0 : 1)
      setPressed(follow, app.section.follow)
    }
    return [axis.el, follow]
  }
  panels.probe = () => {
    const seg = segmented({ labels: PROBES.map((p) => p.label), value: 0, ariaLabel: 'Probe',
      onPick: (i) => { app.sim.probe = PROBES[i].id; app.panel.refresh() },
      tips: PROBES.map((p) => ({ title: `Probe: ${p.label}`, text: p.hint })) })
    const sims = iconButton({ icon: 'pulse', label: 'Simulate tab', showLabel: true,
      tip: { title: 'Simulation settings', text: 'Open the Simulate tab: world radius, floors ±, light, liminal report and results.' },
      onClick: () => app.ui.showTab('simulate') })
    updaters.probe = () => seg.set(Math.max(0, PROBES.findIndex((p) => p.id === app.sim.probe)))
    return [seg.el, sims]
  }
  panels.author = () => {
    const sel = selectInput(TEMPLATE_DEFS.map((t) => ({ value: t.id, label: t.label })), app.author.template,
      (v) => app.setAuthorTemplate(v), { tip: { title: 'Structure template', text: 'What the Author tool places. Its parameters are in the Create tab.' }, label: 'Structure template' })
    const params = iconButton({ icon: 'author', label: 'Parameters', showLabel: true,
      tip: { title: 'Template parameters', text: 'Open the Create tab: storeys, deck spacing, stair direction, anomaly…' },
      onClick: () => app.ui.showTab('create') })
    updaters.author = () => { if (document.activeElement !== sel) sel.value = app.author.template }
    return [row('template', sel), params]
  }

  const built = {}
  let shownFor = null
  const renderOpts = () => {
    const id = app.tool.id
    if (shownFor !== id) {
      shownFor = id
      opts.textContent = ''
      if (panels[id]) {
        built[id] ??= panels[id]()
        opts.append(...built[id])
      }
      const i = app.tools.indexOf(app.tool)
      const meta = TOOL_META.find((m) => m.id === id) ?? { label: id, icon: 'dot' }
      title.textContent = ''
      title.append(icon(meta.icon, { size: 16 }), h('span', { text: meta.label }), h('kbd', { text: TOOL_KEYS[i] ?? '' }))
      title.dataset.cmd = `tool.${id}`
    }
    updaters[id]?.()
    const status = app.tool.status ?? ''
    if (hint.textContent !== status) {
      hint.textContent = status
      hint.dataset.tip = status
    }
  }

  // --- view controls --------------------------------------------------------
  const run = (id) => runCommand(commandById(id), app)
  const floorDown = iconButton({ icon: 'down', label: 'Floor down', cmd: 'view.floorDown', onClick: () => run('view.floorDown') })
  const floorLabel = h('button', { class: 'edt-floor-label', type: 'button',
    tip: { title: 'Current floor (cy)', text: 'Storey shown in the plan. Click to pick a floor in the View tab; PgUp / PgDn step.' },
    onClick: () => app.ui.showTab('view') })
  const floorUp = iconButton({ icon: 'up', label: 'Floor up', cmd: 'view.floorUp', onClick: () => run('view.floorUp') })
  const sectionBtn = iconButton({ icon: 'section', label: 'Section', showLabel: true, cmd: 'view.section', onClick: () => run('view.section') })
  const previewBtn = iconButton({ icon: 'cube', label: '3D', showLabel: true, cmd: 'view.preview3d', onClick: () => run('view.preview3d') })
  const fitBtn = iconButton({ icon: 'fit', label: 'Fit', cmd: 'view.fit', onClick: () => run(app.preview ? 'view.reset3d' : 'view.fit') })
  const zoomOut = iconButton({ icon: 'zoomOut', label: 'Zoom out', cmd: 'view.zoomOut', onClick: () => run('view.zoomOut') })
  const zoomIn = iconButton({ icon: 'zoomIn', label: 'Zoom in', cmd: 'view.zoomIn', onClick: () => run('view.zoomIn') })
  view.append(
    h('div', { class: 'edt-stepper', role: 'group', 'aria-label': 'Floor' }, floorDown, floorLabel, floorUp),
    sectionBtn, previewBtn, fitBtn, zoomOut, zoomIn,
  )

  const refresh = () => {
    renderOpts()
    floorLabel.textContent = `cy ${app.floor}`
    setPressed(sectionBtn, app.section.on)
    setPressed(previewBtn, !!app.preview)
    fitBtn.dataset.cmd = app.preview ? 'view.reset3d' : 'view.fit'
    fitBtn.setAttribute('aria-label', app.preview ? 'Reset 3D view' : 'Fit document')
    const zoomReason = app.preview ? 'Plan only — in 3D use the mouse wheel' : null
    setDisabled(zoomIn, zoomReason)
    setDisabled(zoomOut, zoomReason)
  }
  return { el: bar, refresh }
}
