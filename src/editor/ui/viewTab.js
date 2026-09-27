import { button, buttonRow, readout, section, segmented, toggle } from '../../debug/widgets.js'
import { PREVIEW_CLIP_MODES, PREVIEW_GEOMETRY } from './Preview3D.js'
import { LOOK_ORDER, LOOK_PROFILES } from '../../render/lookProfile.js'
import { FILL_MODES, LAYER_META, commandById, runCommand } from './keymap.js'
import { h, keyedRender, sectionOpts } from './dom.js'
import { LAYER_LEGEND, fillLegend, legendEl } from './legend.js'

// View tab: floors, plan layers (each with its colour legend), fill modes,
// the section cut and the 3D preview settings.

const MAX_FLOOR_BUTTONS = 160
const CLIP_TIPS = {
  all: 'Show every storey of the document in 3D.',
  below: 'Show the current floor and everything below it (cutaway from above).',
  floor: 'Show only the current floor.',
}

export function buildViewTab(app) {
  const root = h('div', { class: 'edt-tabbody' })
  const run = (id) => runCommand(commandById(id), app)

  // --- floors ---
  const floorSec = section('Floors', sectionOpts('view.floors', 'Which storey (cy) the plan shows. View only: never changes the document.'))
  root.appendChild(floorSec.el)
  floorSec.body.appendChild(buttonRow('floor', [
    button({ label: '▼ down', tip: { cmd: 'view.floorDown' }, onClick: () => run('view.floorDown') }),
    button({ label: '▲ up', tip: { cmd: 'view.floorUp' }, onClick: () => run('view.floorUp') }),
  ]).el)
  const floorRead = readout('showing', { tip: 'The current floor and the range of floors stored in the document.' })
  floorSec.body.appendChild(floorRead.el)
  const floorStrip = h('div', { class: 'dbg-seg edt-floors', role: 'group', 'aria-label': 'Floors' })
  floorSec.body.appendChild(floorStrip)
  const renderFloors = keyedRender(floorStrip)

  // --- layers ---
  const layerSec = section('Plan layers', sectionOpts('view.layers', 'Overlays drawn on the plan; each shows its colours.'))
  root.appendChild(layerSec.el)
  const layerToggles = LAYER_META.map((l) => {
    const t = toggle({
      label: l.label.toLowerCase(), value: app.layers[l.id],
      onChange: (v) => { app.layers[l.id] = v; app.invalidate() },
      tip: { title: `Layer: ${l.label}`, text: l.hint },
    })
    const wrap = h('div', { class: 'edt-layer' }, t.el, legendEl(LAYER_LEGEND[l.id] ?? [], { className: 'edt-legend-inline' }))
    layerSec.body.appendChild(wrap)
    return [l.id, t]
  })

  // --- fill ---
  const fillSec = section('Fill mode', sectionOpts('view.fill', 'How plan cells are coloured (debug views of the generator’s decisions).'))
  root.appendChild(fillSec.el)
  const fillSeg = segmented({
    labels: FILL_MODES.map((m) => m.label), value: 0, ariaLabel: 'Fill mode',
    tips: FILL_MODES.map((m) => ({ title: `Fill: ${m.title}`, text: m.hint })),
    onPick: (i) => { app.fillMode = FILL_MODES[i].id; app.invalidate(); app.panel.refresh() },
  })
  fillSec.body.appendChild(fillSeg.el)
  const fillLegendBox = h('div', { class: 'edt-fill-legend' })
  fillSec.body.appendChild(fillLegendBox)
  const renderFillLegend = keyedRender(fillLegendBox)

  // --- section ---
  const secSec = section('Section cut', sectionOpts('view.section', 'A vertical slice through every storey along one row or column of cells.'))
  root.appendChild(secSec.el)
  const sectionToggle = toggle({ label: 'section view', value: app.section.on, onChange: (v) => app.setSectionOpen(v), tip: { cmd: 'view.section' } })
  secSec.body.appendChild(sectionToggle.el)
  const sectionAxis = segmented({
    labels: ['cut along x', 'cut along z'], value: app.section.axis === 'x' ? 0 : 1, ariaLabel: 'Section axis',
    tips: [
      { title: 'Cut along x', text: 'The section runs east–west through one row of cells. (X swaps, with the Section tool.)' },
      { title: 'Cut along z', text: 'The section runs north–south through one column of cells. (X swaps, with the Section tool.)' },
    ],
    onPick: (i) => app.setSectionAxis(i === 0 ? 'x' : 'z'),
  })
  secSec.body.appendChild(sectionAxis.el)
  const followToggle = toggle({ label: 'follow cursor', value: app.section.follow, onChange: (v) => app.setSectionFollow(v), tip: { cmd: 'section.follow' } })
  secSec.body.appendChild(followToggle.el)
  secSec.body.appendChild(h('div', { class: 'edt-note', text: 'Place the cut with the Section tool (8): click the plan. X and F work while that tool is active.' }))

  // --- 3D ---
  const p3 = section('3D preview', sectionOpts('view.preview', 'Orbitable 3D view of the document (or a window of the explored world).'))
  root.appendChild(p3.el)
  const previewToggle = toggle({ label: '3D preview', value: !!app.preview, onChange: (v) => app.setPreview(v), tip: { cmd: 'view.preview3d' } })
  p3.body.appendChild(previewToggle.el)
  const ceilingToggle = toggle({ label: 'ceilings in 3D', value: app.previewCeiling !== false, onChange: (v) => app.setPreviewCeiling(v), tip: { cmd: 'view.ceiling3d' } })
  p3.body.appendChild(ceilingToggle.el)
  const clipSeg = segmented({
    labels: PREVIEW_CLIP_MODES.map((m) => m.label),
    value: PREVIEW_CLIP_MODES.findIndex((m) => m.id === app.previewClip), ariaLabel: '3D floors',
    tips: PREVIEW_CLIP_MODES.map((m) => ({ title: `3D floors: ${m.label}`, text: CLIP_TIPS[m.id] ?? '' })),
    onPick: (i) => app.setPreviewClip(PREVIEW_CLIP_MODES[i].id),
  })
  const clipRow = h('div', { class: 'dbg-row' }, h('span', { class: 'dbg-label', text: '3D floors' }), clipSeg.el)
  p3.body.appendChild(clipRow)
  const previewModes = [PREVIEW_GEOMETRY, ...LOOK_ORDER]
  const lookSeg = segmented({
    labels: ['geometry', ...LOOK_ORDER.map((id) => LOOK_PROFILES[id].label.toLowerCase())],
    value: 0, ariaLabel: '3D look',
    tips: [
      { title: 'Look: geometry', text: 'Fast flat-shaded geometry preview.' },
      ...LOOK_ORDER.map((id) => ({ title: `Look: ${LOOK_PROFILES[id].label}`, text: 'The game’s production deferred renderer with this look profile (slower).' })),
    ],
    onPick: (i) => app.setPreviewMode(previewModes[i]),
  })
  p3.body.appendChild(h('div', { class: 'dbg-row' }, h('span', { class: 'dbg-label', text: 'look' }), lookSeg.el))
  p3.body.appendChild(buttonRow('', [
    button({ label: 'Reset 3D view', tip: { cmd: 'view.reset3d' }, onClick: () => run('view.reset3d') }),
    button({ label: 'Refresh 3D window', tip: { cmd: 'world.refresh3d' }, onClick: () => run('world.refresh3d') }),
  ]).el)
  const p3Note = h('div', { class: 'edt-note' })
  p3.body.appendChild(p3Note)

  // --- keyboard (WCAG 2.1.4: character-key shortcuts can be limited) ---
  const kb = section('Keyboard', sectionOpts('view.keyboard', 'How keyboard shortcuts behave in the editor.', true))
  root.appendChild(kb.el)
  const singleKeys = toggle({
    label: 'single-key shortcuts anywhere', value: app.ui?.singleKeysAnywhere !== false,
    onChange: (v) => app.ui?.setSingleKeysAnywhere(v),
    tip: { title: 'Single-key shortcuts anywhere', text: 'On: 1–0, R, E, V, F, X, ?, = and - work wherever focus is (outside text fields). Off: they only work while the plan or the tool rail has focus (click the plan first), so speech input or stray keys never trigger them. Ctrl/⌘ shortcuts are not affected.' },
  })
  kb.body.appendChild(singleKeys.el)
  kb.body.appendChild(button({ label: 'All shortcuts (?)', tip: { cmd: 'ui.help' }, onClick: () => run('ui.help') }).el)

  const refresh = () => {
    const floors = app.map.floors()
    floorRead.set(app.readOnly
      ? `cy ${app.floor} · infinite world`
      : `cy ${app.floor}${floors.length ? ` · stored ${floors[0]}…${floors.at(-1)}` : ''}`)
    const summary = app.readOnly
      ? Array.from({ length: 9 }, (_, i) => ({ cy: app.floor + 4 - i, chunks: 1 }))
      : app.map.floorSummary()
    const s = app.selectedStructure()
    renderFloors(`${app.readOnly}|${app.floor}|${app.revision}|${s ? `${s.baseCy}:${s.topCy}` : ''}`, (strip) => {
      const counts = new Map(summary.map((f) => [f.cy, f.chunks]))
      if (!counts.has(app.floor)) counts.set(app.floor, 0)
      const sorted = [...counts.keys()].sort((a, b) => b - a)
      for (const cy of sorted.slice(0, MAX_FLOOR_BUTTONS)) {
        const inStruct = s && cy >= s.baseCy && cy <= s.topCy
        const n = counts.get(cy)
        const b = h('button', {
          class: `dbg-seg-btn edt-floor-btn${cy === app.floor ? ' dbg-seg-on' : ''}${inStruct ? ' edt-in-struct' : ''}${n ? '' : ' edt-dim'}`,
          type: 'button', text: String(cy), 'aria-pressed': String(cy === app.floor),
          tip: { title: `Floor cy ${cy}`, text: `${app.readOnly ? 'Generated on demand.' : `${n} chunk${n === 1 ? '' : 's'} stored.`}${inStruct ? ' Inside the selected structure’s band (blue edge).' : ''} Click to show it.` },
        })
        b.addEventListener('click', (e) => { e.preventDefault(); app.setFloor(cy) })
        strip.appendChild(b)
      }
      if (sorted.length > MAX_FLOOR_BUTTONS) {
        strip.appendChild(h('span', { class: 'edt-more', text: `+${sorted.length - MAX_FLOOR_BUTTONS} more (use PgUp / PgDn)` }))
      }
    })
    for (const [key, t] of layerToggles) t.set(app.layers[key])
    fillSeg.set(Math.max(0, FILL_MODES.findIndex((m) => m.id === app.fillMode)))
    renderFillLegend(app.fillMode, (el) => {
      el.appendChild(legendEl(fillLegend(app.fillMode)))
      if (app.fillMode === 'gen' && !app.readOnly) el.appendChild(h('div', { class: 'edt-note', text: 'Generation times exist only while exploring (E).' }))
    })
    sectionToggle.set(app.section.on)
    sectionAxis.set(app.section.axis === 'x' ? 0 : 1)
    followToggle.set(app.section.follow)
    previewToggle.set(!!app.preview)
    ceilingToggle.set(app.previewCeiling !== false)
    singleKeys.set(app.ui?.singleKeysAnywhere !== false)
    clipSeg.set(PREVIEW_CLIP_MODES.findIndex((m) => m.id === app.previewClip))
    lookSeg.set(Math.max(0, previewModes.indexOf(app.previewMode ?? PREVIEW_GEOMETRY)))
    p3Note.textContent = app.preview
      ? 'Drag: orbit · right/middle drag: pan · wheel: zoom · Home: reset view.'
      : 'Settings apply when the preview opens (Tab or the 3D button above the plan).'
  }
  return { el: root, refresh }
}
