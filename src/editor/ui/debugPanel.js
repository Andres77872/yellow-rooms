import { button, buttonRow, section, segmented, slider, textBlock } from '../../debug/widgets.js'
import { PROBES, commandById, runCommand } from './keymap.js'
import { h, keyedRender, sectionOpts } from './dom.js'

// Debugger panels: the Simulate tab (probes, simulations, the lighting lab
// and the per-floor liminal report) and the Inspect tab (the pinned cell /
// chunk inspector).

const pct = (x) => `${Math.round(x * 100)}%`

const REPORT_COLUMNS = [
  { id: 'cy', title: 'Floor (cy)', text: 'The storey. Click a row to show that floor.', val: (f) => f.cy, fmt: (v) => v },
  { id: 'walk', title: 'Walkable cells', text: 'Cells a player can stand on.', val: (f) => f.walkable, fmt: (v) => v },
  { id: 'loops', title: 'Loops', text: 'Independent cycles in the space graph. More loops = more ways around; 0 = a tree of dead ends.', val: (f) => f.loops, fmt: (v) => v },
  { id: 'dead', title: 'Dead ends', text: 'Dead-end spaces: spaces with a single connection.', val: (f) => f.deadEndSpaces, fmt: (v) => v },
  { id: 'ring', title: 'Ring share', text: 'Hillier c+d: share of spaces that lie on a loop (can be walked around).', val: (f) => f.hillier.c + f.hillier.d, fmt: pct },
  { id: 'icd', title: 'ICD', text: 'Interconnection density: mean number of choices at each decision space.', val: (f) => f.icd, fmt: (v) => v.toFixed(1) },
  { id: 'intel', title: 'Intelligibility', text: 'R² between local connectivity and global integration. High = the layout reads from where you stand; low = disorienting.', val: (f) => f.intelligibility, fmt: (v) => v.toFixed(2) },
  { id: 'dark', title: 'Darkness', text: 'Share of walkable cells below the light threshold.', val: (f) => f.darkness, fmt: pct },
  { id: 'clus', title: 'Dark clustering (Moran’s I)', text: '+1 = dark cells gather in pools, 0 = random, negative = dispersed.', val: (f) => f.darkClustering, fmt: (v) => v.toFixed(2) },
  { id: 'sight', title: 'Sightline median', text: 'Median isovist depth in cells — how far you typically see (1 cell = 3 m).', val: (f) => f.sightMedian, fmt: (v) => v.toFixed(1) },
  { id: 'p90', title: 'Sightline p90', text: '90th-percentile isovist depth in cells — the long views.', val: (f) => f.sightP90, fmt: (v) => v.toFixed(1) },
  { id: 'rep', title: 'Repetition', text: 'Share of rooms whose layout repeats another room.', val: (f) => f.roomRepetition, fmt: pct },
]

const cmdBtn = (app, id, label) => button({ label, tip: { cmd: id }, onClick: () => runCommand(commandById(id), app) })

export function buildInspectorPanel(app) {
  const root = h('div', { class: 'edt-tabbody' })
  const sec = section('Pinned cell', sectionOpts('inspect.pinned', 'Everything about the pinned cell and its chunk. Pin with Probe → inspect (9), or click while exploring.'))
  root.appendChild(sec.el)
  const info = textBlock()
  info.el.classList.add('edt-inspect', 'edt-selectable', 'edt-inspect-tall')
  sec.body.appendChild(info.el)
  sec.body.appendChild(buttonRow('', [
    cmdBtn(app, 'inspect.log', 'Log chunk (console)'),
    cmdBtn(app, 'inspect.unpin', 'Unpin'),
    button({ label: 'Pin with probe', tip: { cmd: 'probe.inspect' }, onClick: () => runCommand(commandById('probe.inspect'), app) }),
  ]).el)
  const refresh = () => {
    const insp = app.inspection()
    info.set(insp ? insp.lines : 'Nothing pinned. Choose Probe → inspect (9) and click a cell — or click with Select while exploring.')
  }
  return { el: root, refresh }
}

export function buildSimPanel(app) {
  const root = h('div', { class: 'edt-tabbody' })

  const probeSec = section('Probe', sectionOpts('sim.probe', 'What a click with the Probe tool (9) does.'))
  root.appendChild(probeSec.el)
  const probeSeg = segmented({
    labels: PROBES.map((p) => p.label), value: 0, ariaLabel: 'Probe',
    tips: PROBES.map((p) => ({ title: `Probe: ${p.label}`, text: `${p.hint} Selects the Probe tool (9).` })),
    onPick: (i) => {
      app.sim.probe = PROBES[i].id
      app.setToolById('probe')
    },
  })
  probeSec.body.appendChild(probeSeg.el)
  const radius = slider({
    label: 'world radius', min: 1, max: 6, step: 1, value: app.sim.radius, fmt: 0,
    onInput: (v) => { app.sim.radius = v },
    tip: 'Explore mode only: chunks generated around the probe for distance / path (the document is used whole).',
  })
  const floors = slider({
    label: 'floors ±', min: 0, max: 4, step: 1, value: app.sim.floors, fmt: 0,
    onInput: (v) => { app.sim.floors = v },
    tip: 'Storeys above and below the current floor that the walk field may use (via stairs).',
  })
  probeSec.body.append(radius.el, floors.el)

  const runSec = section('Simulations', sectionOpts('sim.runs', 'Light and liminal metrics over the document (or a window of the explored world).'))
  root.appendChild(runSec.el)
  runSec.body.appendChild(buttonRow('', [
    cmdBtn(app, 'sim.light', 'Light (floor)'),
    cmdBtn(app, 'sim.report', 'Liminal report'),
    cmdBtn(app, 'sim.clear', 'Clear'),
  ]).el)
  const results = textBlock()
  results.el.classList.add('edt-inspect', 'edt-selectable')
  runSec.body.appendChild(results.el)

  const reportSec = section('Liminal report', sectionOpts('sim.report', 'Per-floor metrics. Hover a column header for its meaning; click a header to sort; click a row to visit the floor.'))
  root.appendChild(reportSec.el)
  const report = h('div', { class: 'edt-report' })
  reportSec.body.appendChild(report)
  const renderReportInto = keyedRender(report)
  let sort = { col: 'cy', dir: -1 }

  const labSec = section('Lighting lab · modifies document', sectionOpts('sim.lab', 'Re-assigns this floor’s dead lamps by circuit or breaker zone, keeping the same dead budget. Changes the document (undoable).'))
  root.appendChild(labSec.el)
  labSec.body.appendChild(buttonRow('relight', [
    cmdBtn(app, 'sim.relightCircuits', 'by circuits'),
    cmdBtn(app, 'sim.relightZones', 'by zones'),
  ]).el)

  const renderReport = () => {
    const r = app.sim.report
    renderReportInto(r ? `${app.floor}|${sort.col}|${sort.dir}|${r.floors.length}|${reportId(r)}` : null, (el) => {
      if (!r) {
        el.appendChild(h('div', { class: 'edt-note', text: 'Run “Liminal report” to fill this table.' }))
        return
      }
      const table = h('table', { class: 'edt-report-table' })
      const tr = h('tr')
      for (const c of REPORT_COLUMNS) {
        const th = h('th', { scope: 'col', 'aria-sort': sort.col === c.id ? (sort.dir > 0 ? 'ascending' : 'descending') : null },
          h('button', { class: 'edt-th-btn', type: 'button', text: c.id + (sort.col === c.id ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''),
            tip: { title: c.title, text: `${c.text} Click to sort.` },
            onClick: () => { sort = { col: c.id, dir: sort.col === c.id ? -sort.dir : -1 }; renderReport() } }))
        tr.appendChild(th)
      }
      table.appendChild(h('thead', null, tr))
      const body = h('tbody')
      const col = REPORT_COLUMNS.find((c) => c.id === sort.col) ?? REPORT_COLUMNS[0]
      const rows = [...r.floors].sort((a, b) => (col.val(a) - col.val(b)) * sort.dir)
      for (const f of rows) {
        const tipTitle = `cy ${f.cy}: ${f.chunks} chunks, ${f.walkable} walkable cells`
        const tipText = [
          `open-plan ${pct(f.openShare)} · circulation ${pct(f.circulationShare)}`,
          `spaces ${f.spaces} · decision ${f.decisionSpaces} (ICD ${f.icd.toFixed(2)}) · dead-end ${f.deadEndSpaces} · loops ${f.loops} · articulation ${f.articulationSpaces} · components ${f.components}`,
          `Hillier a ${pct(f.hillier.a)} b ${pct(f.hillier.b)} c ${pct(f.hillier.c)} d ${pct(f.hillier.d)} · integration ${f.meanIntegration.toFixed(2)} · intelligibility R² ${f.intelligibility.toFixed(2)}`,
          `darkness ${pct(f.darkness)} (${f.litLamps} lit / ${f.deadLamps} dead) · Moran’s I ${f.darkClustering.toFixed(2)}`,
          `sightline median ${f.sightMedian.toFixed(1)} / p90 ${f.sightP90.toFixed(1)} · isovist median ${f.isovistMedian.toFixed(0)} cells² · compactness ${f.compactnessMedian.toFixed(2)}`,
          `repeated rooms ${pct(f.roomRepetition)} of ${f.rooms} · repeated chunks ${pct(f.repetition)}`,
          'Click the row, or Enter / Space on the floor number: show this floor.',
        ].join(' · ')
        // Hover anywhere on the row for the metrics; the floor cell is a real
        // button (keyboard + screen readers) carrying the same tooltip.
        const row = h('tr', { class: f.cy === app.floor ? 'edt-on' : null, tip: { title: tipTitle, text: tipText } })
        REPORT_COLUMNS.forEach((c, i) => {
          const text = String(c.fmt(c.val(f)))
          row.appendChild(i === 0
            ? h('td', null, h('button', { class: 'edt-row-btn', type: 'button', text, 'aria-label': `Show floor cy ${f.cy}`,
              'aria-current': f.cy === app.floor ? 'true' : null, tip: { title: tipTitle, text: tipText } }))
            : h('td', { text }))
        })
        row.addEventListener('click', () => app.setFloor(f.cy))
        body.appendChild(row)
      }
      table.appendChild(body)
      el.appendChild(table)
    })
  }

  const refresh = () => {
    probeSeg.set(Math.max(0, PROBES.findIndex((p) => p.id === app.sim.probe)))
    radius.set(app.sim.radius)
    floors.set(app.sim.floors)
    const lines = []
    const d = app.sim.distance
    if (d?.ok) {
      lines.push(`walk field from ${d.start.gx},${d.start.gz} cy${d.start.cy}`)
      lines.push(`  reachable ${d.reachable} · unreachable ${d.unreachable} · dead ends ${d.deadEnds.length}`)
      lines.push(`  farthest ${d.max} cells (${d.max * 3} m) at ${d.farthest.gx},${d.farthest.gz} cy${d.farthest.cy}`)
      lines.push(`  per floor ${d.perFloor.map((f) => `cy${f.cy}:${f.reachable}`).join(' ')}`)
    }
    const p = app.sim.path
    if (p) lines.push(p.ok ? `path ${p.path.length} cells · cost ${p.cost} · ${p.flights} flights` : `path: ${p.reason}`)
    const iso = app.sim.isovist
    if (iso) lines.push(`isovist cy${iso.origin.cy}: area ${iso.area.toFixed(0)} · deepest ${iso.maxDepth.toFixed(1)} · mean ${iso.meanDepth.toFixed(1)} cells`)
    const l = app.sim.light
    if (l) lines.push(`light cy${l.cy}: dark ${pct(l.darkness)} of ${l.walkable} cells · lamps ${l.litLamps} lit / ${l.deadLamps} dead`)
    const rl = app.sim.relight
    if (rl) {
      lines.push(`relight cy${rl.cy} by ${rl.grain}: ${rl.failed}/${rl.circuits} banks failed, ${rl.budget} dead fixtures kept`)
      lines.push(`  darkness ${pct(rl.before.darkness)} → ${pct(rl.after.darkness)} · Moran's I ${rl.before.clustering.toFixed(2)} → ${rl.after.clustering.toFixed(2)} (undo restores)`)
    }
    results.set(lines.length ? lines : 'No results yet. Probe tool (9): click the plan to run the selected probe.')
    renderReport()
  }
  return { el: root, refresh }
}

// Stable identity for a report object (a new run is a new object).
const ids = new WeakMap()
let nextId = 1
function reportId(r) {
  if (!ids.has(r)) ids.set(r, nextId++)
  return ids.get(r)
}
