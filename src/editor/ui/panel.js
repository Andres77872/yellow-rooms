import { button, buttonRow, readout, section, segmented, slider, textBlock, toggle } from '../../debug/widgets.js'
import { roomRoleLabel } from '../../debug/mapInspect.js'
import { MAP_FAMILY_ORDER } from '../../world/mapFamily.js'
import { SPACE_ROLE_NONE } from '../../world/mapTypes.js'
import { CELL_MODES, WALL_MODES } from './tools.js'

// Left-hand control panel, built from the shared debug widget kit.

export const FURN_NAMES = {
  1: 'desk', 2: 'chair', 3: 'table', 4: 'cabinet', 5: 'copier', 6: 'cooler',
  7: 'plant', 8: 'rack', 9: 'sofa', 10: 'bookshelf', 11: 'whiteboard',
  12: 'bed', 13: 'nightstand', 14: 'wardrobe', 15: 'toilet', 16: 'sink',
  17: 'tub', 18: 'counter', 19: 'stove', 20: 'fridge', 21: 'tv',
  22: 'armchair', 23: 'washer',
}

const ROLE_OPTIONS = [
  { value: SPACE_ROLE_NONE, label: 'ordinary (theme roll)' },
  ...Array.from({ length: 15 }, (_, i) => i + 1)
    .filter((role) => roomRoleLabel(role))
    .map((role) => ({ value: role, label: roomRoleLabel(role) })),
]

function selectInput(options, value, onChange) {
  const sel = document.createElement('select')
  sel.className = 'edt-input'
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

function textInput(value, onChange) {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'edt-input'
  input.value = value
  input.addEventListener('change', () => onChange(input.value))
  return input
}

function row(label, control) {
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

export function buildPanel(app) {
  const root = document.createElement('div')
  root.className = 'edt-panel'
  const title = document.createElement('div')
  title.className = 'edt-title'
  title.innerHTML = 'THE YELLOW ROOMS <small>· map editor</small>'
  root.appendChild(title)

  // --- file ---
  const file = section('file')
  root.appendChild(file.el)
  const nameInput = textInput(app.map.meta.name, (v) => { app.map.meta.name = v || 'untitled' })
  file.body.appendChild(row('name', nameInput))
  const info = readout('document')
  file.body.appendChild(info.el)
  file.body.appendChild(buttonRow('', [
    button({ label: 'new empty', onClick: () => app.newMap() }),
    button({ label: 'export', onClick: () => app.exportMap() }),
    button({ label: 'import', onClick: () => app.importMap() }),
  ]).el)

  // --- procedural start ---
  const bake = section('procedural start')
  root.appendChild(bake.el)
  let bakeSeed = 'lobby'
  let bakeFamily = 'office'
  let bakeRadius = 1
  let bakeFloors = 1
  bake.body.appendChild(row('seed', textInput(bakeSeed, (v) => { bakeSeed = v || 'lobby' })))
  bake.body.appendChild(row('family', selectInput(
    MAP_FAMILY_ORDER.map((f) => ({ value: f, label: f })), bakeFamily,
    (v) => { bakeFamily = v }
  )))
  bake.body.appendChild(slider({
    label: 'radius', min: 1, max: 4, step: 1, value: bakeRadius, fmt: 0,
    onInput: (v) => { bakeRadius = v },
  }).el)
  bake.body.appendChild(slider({
    label: 'floors', min: 1, max: 3, step: 1, value: bakeFloors, fmt: 0,
    onInput: (v) => { bakeFloors = v },
  }).el)
  bake.body.appendChild(buttonRow('', [
    button({
      label: 'generate into map',
      onClick: () => app.bake({
        seedText: bakeSeed,
        family: bakeFamily,
        radius: bakeRadius,
        floors: Array.from({ length: bakeFloors }, (_, i) => i),
      }),
    }),
  ]).el)

  // --- view ---
  const view = section('view')
  root.appendChild(view.el)
  const floorRead = readout('floor')
  view.body.appendChild(buttonRow('floor', [
    button({ label: '−', onClick: () => app.setFloor(app.floor - 1) }),
    button({ label: '+', onClick: () => app.setFloor(app.floor + 1) }),
  ]).el)
  view.body.appendChild(floorRead.el)
  view.body.appendChild(toggle({
    label: 'cell grid', value: true, onChange: (v) => { app.view2d.showGrid = v; app.invalidate() },
  }).el)
  view.body.appendChild(toggle({
    label: 'room labels', value: true, onChange: (v) => { app.view2d.showLabels = v; app.invalidate() },
  }).el)
  const previewToggle = toggle({ label: '3D preview (Tab)', value: false, onChange: (v) => app.setPreview(v) })
  view.body.appendChild(previewToggle.el)
  view.body.appendChild(toggle({
    label: 'ceiling in 3D', value: true, onChange: (v) => app.preview?.setCeiling(v),
  }).el)

  // --- tools ---
  const toolsSec = section('tools')
  root.appendChild(toolsSec.el)
  const toolSeg = segmented({
    labels: app.tools.map((t) => t.id),
    value: 0,
    onPick: (i) => app.setTool(i),
  })
  toolsSec.body.appendChild(toolSeg.el)
  const toolOptions = document.createElement('div')
  toolsSec.body.appendChild(toolOptions)

  const toolPanels = {
    room: () => {
      const roomTool = app.tools.find((t) => t.id === 'room')
      const frag = document.createDocumentFragment()
      frag.appendChild(row('type', selectInput(ROLE_OPTIONS, roomTool.role, (v) => { roomTool.role = Number(v) })))
      frag.appendChild(toggle({
        label: 'centre lamp', value: roomTool.withLamp, onChange: (v) => { roomTool.withLamp = v },
      }).el)
      return frag
    },
    wall: () => {
      const wallTool = app.tools.find((t) => t.id === 'wall')
      return segmented({
        labels: WALL_MODES.map((m) => m.label),
        value: wallTool.mode,
        onPick: (i) => { wallTool.mode = i },
      }).el
    },
    cell: () => {
      const cellTool = app.tools.find((t) => t.id === 'cell')
      return segmented({
        labels: CELL_MODES.map((m) => m.label),
        value: cellTool.mode,
        onPick: (i) => { cellTool.mode = i },
      }).el
    },
    object: () => {
      const objectTool = app.tools.find((t) => t.id === 'object')
      return row('piece', selectInput(
        Object.entries(FURN_NAMES).map(([value, label]) => ({ value, label })),
        objectTool.kind,
        (v) => { objectTool.kind = Number(v) }
      ))
    },
  }

  const renderToolOptions = () => {
    toolOptions.textContent = ''
    const build = toolPanels[app.tool.id]
    if (build) toolOptions.appendChild(build())
  }

  // --- selection ---
  const selSec = section('selection')
  root.appendChild(selSec.el)
  const selInfo = textBlock()
  selSec.body.appendChild(selInfo.el)
  const selActions = document.createElement('div')
  selSec.body.appendChild(selActions)

  const renderSelActions = () => {
    selActions.textContent = ''
    const sel = app.selection
    if (!sel) return
    if (sel.type === 'furniture') {
      selActions.appendChild(buttonRow('', [
        button({ label: 'rotate (R)', onClick: () => app.rotateSelection() }),
        button({ label: 'delete', onClick: () => app.deleteSelection() }),
      ]).el)
    } else if (sel.type === 'lamp') {
      selActions.appendChild(buttonRow('', [
        button({ label: 'toggle lit', onClick: () => app.toggleSelectedLamp() }),
        button({ label: 'delete', onClick: () => app.deleteSelection() }),
      ]).el)
    } else if (sel.type === 'room') {
      const roomSel = row('type', selectInput(
        ROLE_OPTIONS, app.map.roomById(sel.id)?.role ?? 0,
        (v) => app.setRoomRole(sel.id, Number(v))
      ))
      selActions.appendChild(roomSel)
      selActions.appendChild(buttonRow('', [
        button({ label: 'reroll', onClick: () => app.rerollRoom(sel.id) }),
        button({ label: 'delete room', onClick: () => app.deleteSelection() }),
      ]).el)
    }
  }

  // --- rooms list ---
  const roomsSec = section('rooms')
  root.appendChild(roomsSec.el)
  const roomsList = document.createElement('div')
  roomsList.className = 'edt-list'
  roomsSec.body.appendChild(roomsList)

  const renderRooms = () => {
    roomsList.textContent = ''
    for (const r of app.map.rooms) {
      const div = document.createElement('div')
      div.className = 'edt-list-row'
      if (app.selection?.type === 'room' && app.selection.id === r.id) div.classList.add('edt-on')
      const label = roomRoleLabel(r.role) ?? 'ordinary'
      const size = `${r.x1 - r.x0 + 1}×${r.z1 - r.z0 + 1}`
      div.textContent = `#${r.id} ${label} ${size} @${r.x0},${r.z0} f${r.cy}${r.baked ? ' (baked)' : ''}`
      div.addEventListener('click', () => app.focusRoom(r))
      roomsList.appendChild(div)
    }
  }

  // --- help ---
  const help = section('shortcuts')
  root.appendChild(help.el)
  const helpText = textBlock()
  helpText.set([
    '1-7      switch tool',
    'Tab      3D preview',
    'R        rotate piece',
    'Del      delete selection',
    'Ctrl+Z/Y undo / redo',
    'PgUp/Dn  floor up / down',
    'RMB/MMB  pan · wheel zoom',
  ])
  help.body.appendChild(helpText.el)

  const refresh = () => {
    info.set(`${app.map.chunks.size} chunks · ${app.map.rooms.length} rooms · ${app.map.meta.family}`)
    floorRead.set(`cy ${app.floor}`)
    nameInput.value = app.map.meta.name
    toolSeg.set(app.tools.indexOf(app.tool))
    previewToggle.set(!!app.preview)
    renderToolOptions()
    selInfo.set(app.describeSelection())
    renderSelActions()
    renderRooms()
  }

  return { el: root, refresh }
}
