import { button, buttonRow, section, segmented, slider, textBlock, toggle } from '../../debug/widgets.js'
import { STAIR_E, STAIR_N, STAIR_S, STAIR_W } from '../../world/structures/slab.js'
import { ANOMALIES, TEMPLATE_DEFS } from '../templates.js'
import { PROTOTYPE_KINDS } from '../prototypes.js'
import { commandById, runCommand } from './keymap.js'
import { ROLE_OPTIONS, row, selectInput, textInput } from './options.js'
import { h, keyedRender, listRow, sectionOpts } from './dom.js'

// Create tab: choose a structure template and its parameters, then drag (or
// click) with the Author tool; the document's authored structures; and the
// kind lab, which builds whole prototype maps.

const DIRS = [
  { id: STAIR_E, label: 'E', tip: 'The first flight climbs toward +x (east).' },
  { id: STAIR_W, label: 'W', tip: 'The first flight climbs toward −x (west).' },
  { id: STAIR_S, label: 'S', tip: 'The first flight climbs toward +z (south).' },
  { id: STAIR_N, label: 'N', tip: 'The first flight climbs toward −z (north).' },
]

const NOTES = {
  atrium: 'Office/Hotel atrium contract at your rectangle: open hall at the base, windowed galleries above, rail overlook on top.',
  bridgedAtrium: 'As the light well, with railed decks across it every N storeys (alternating centre lines).',
  stairwell: 'Switchback stair core, one flight per floor, optionally enclosed with the same door on every floor — the endless stair.',
  splitLevel: 'Two-storey hall with a stair beside it, visible from the floor, up to the gallery (exposure, then access).',
  twinVoid: 'Two shafts either side of a chunk seam, separated by an occupied 2-cell spine.',
  anomalyWing: 'Identical rooms along a corridor; exactly one differs (dark / empty / pillar / extra door).',
  compression: 'Two low 3×3 rooms in series releasing into a tall open hall.',
}

const ANOMALY_TIPS = {
  random: 'Pick the anomaly from the salt.',
  dark: 'The odd room has dead lights.',
  empty: 'The odd room has no furniture.',
  pillar: 'The odd room has a pillar in the middle.',
  extraDoor: 'The odd room has a second door.',
}
const ANOMALY_LABELS = { extraDoor: 'extra door' }

export function buildAuthorPanel(app) {
  const root = h('div', { class: 'edt-tabbody' })
  const p = app.author.params

  // --- template ---
  const sec = section('Structure template', sectionOpts('create.template', 'Pick a template and its parameters, then place it with the Author tool (0).'))
  root.appendChild(sec.el)
  const tpl = selectInput(TEMPLATE_DEFS.map((t) => ({ value: t.id, label: t.label })), app.author.template,
    (v) => app.setAuthorTemplate(v),
    { label: 'Template', tip: { title: 'Template', text: 'The structure the Author tool places. Choosing one also selects the Author tool (0).' } })
  sec.body.appendChild(row('template', tpl))
  const note = textBlock()
  note.el.classList.add('edt-inspect', 'edt-selectable')
  sec.body.appendChild(note.el)
  const levels = slider({ label: 'storeys', min: 2, max: 15, step: 1, value: p.levels, fmt: 0, onInput: (v) => { p.levels = v },
    tip: 'How many storeys the structure spans, starting at the current floor.' })
  const bridgeEvery = slider({ label: 'deck every', min: 1, max: 3, step: 1, value: p.bridgeEvery, fmt: 0, onInput: (v) => { p.bridgeEvery = v },
    tip: 'Bridged atrium: a railed deck crosses the void every N storeys.' })
  const dir = segmented({ labels: DIRS.map((d) => `flight ${d.label}`), value: 0, onPick: (i) => { p.dir = DIRS[i].id },
    tips: DIRS.map((d) => ({ title: `First flight ${d.label}`, text: d.tip })), ariaLabel: 'Stair direction' })
  const enclosed = toggle({ label: 'enclosed core', value: p.enclosed, onChange: (v) => { p.enclosed = v },
    tip: 'Stairwell: wall the core in, with the same door on every floor.' })
  const role = row('room role', selectInput(ROLE_OPTIONS, p.role, (v) => { p.role = Number(v) },
    { label: 'Room role', tip: { title: 'Room role', text: 'Role of the generated rooms (anomaly wing and compression suite).' } }))
  const anomaly = segmented({ labels: ANOMALIES.map((a) => ANOMALY_LABELS[a] ?? a), value: 0, onPick: (i) => { p.anomaly = ANOMALIES[i] },
    tips: ANOMALIES.map((a) => ({ title: `Anomaly: ${ANOMALY_LABELS[a] ?? a}`, text: ANOMALY_TIPS[a] ?? '' })), ariaLabel: 'Anomaly' })
  const reroll = button({
    label: 'Reroll anomaly salt',
    tip: 'Pick a different odd room / random anomaly for the next placement.',
    onClick: () => { p.salt = (p.salt + 1) | 0; app.notify(`anomaly salt ${p.salt}`) },
  })
  sec.body.append(levels.el, bridgeEvery.el, dir.el, enclosed.el, role, anomaly.el, reroll.el)
  const useTool = button({ label: 'Place with the Author tool (0)', tip: { cmd: 'tool.author' }, onClick: () => runCommand(commandById('tool.author'), app) })
  sec.body.appendChild(buttonRow('', [useTool]).el)

  // --- authored list ---
  const listSec = section('Authored structures', sectionOpts('create.authored', 'Structures you placed in this document. Click: select · double-click / Shift+Enter: focus.'))
  root.appendChild(listSec.el)
  const list = h('div', { class: 'edt-list', role: 'list', 'aria-label': 'Authored structures' })
  listSec.body.appendChild(list)
  const renderList = keyedRender(list)

  // --- kind lab ---
  const labSec = section('Kind lab · prototype maps', sectionOpts('create.kinds', 'Build a whole prototype map kind into the document (replaces it; undoable).'))
  root.appendChild(labSec.el)
  const lab = app.ui.lab
  const kindSel = selectInput(
    PROTOTYPE_KINDS.map((k) => ({ value: k.id, label: `${k.label} · ${k.floors} fl` })), lab.kind,
    (v) => { lab.kind = v },
    { label: 'Prototype kind', tip: { title: 'Prototype kind', text: 'A hand-built map archetype (underpass, parking deck, dead mall…).' } })
  labSec.body.appendChild(row('kind', kindSel))
  const seedBox = textInput(lab.seed, (v) => { lab.seed = v.trim() || 'lobby' }, {
    label: 'Kind seed',
    tip: { title: 'Kind seed', text: 'Seed for the prototype only — independent of the world seed in the Map tab.' },
  })
  labSec.body.appendChild(row('kind seed', seedBox))
  labSec.body.appendChild(buttonRow('', [button({
    label: 'Generate kind', onClick: () => app.ui.generateKind(lab.kind),
    tip: { title: 'Generate kind', text: 'Replaces the document with the prototype map. Undoable (Ctrl/⌘+Z).' },
  })]).el)
  const labInfo = textBlock()
  labInfo.el.classList.add('edt-inspect', 'edt-selectable')
  labSec.body.appendChild(labInfo.el)

  const show = (el, on) => { el.style.display = on ? '' : 'none' }

  const refresh = () => {
    labInfo.set(app.lab ? [app.lab.kind, ...app.lab.notes] : '')
    const id = app.author.template
    if (document.activeElement !== tpl) tpl.value = id
    note.set(NOTES[id] ?? '')
    const multi = TEMPLATE_DEFS.find((t) => t.id === id)?.multilevel
    show(levels.el, multi && id !== 'splitLevel')
    show(bridgeEvery.el, id === 'bridgedAtrium')
    show(dir.el, id === 'stairwell')
    show(enclosed.el, id === 'stairwell')
    show(role, id === 'anomalyWing' || id === 'compression')
    show(anomaly.el, id === 'anomalyWing')
    show(reroll.el, id === 'anomalyWing')
    dir.set(Math.max(0, DIRS.findIndex((d) => d.id === p.dir)))
    anomaly.set(Math.max(0, ANOMALIES.indexOf(p.anomaly)))
    levels.set(p.levels)
    bridgeEvery.set(p.bridgeEvery)
    enclosed.set(p.enclosed)
    if (document.activeElement !== kindSel) kindSel.value = lab.kind
    if (document.activeElement !== seedBox) seedBox.value = lab.seed

    const sig = `${app.revision}|${app.selectedStructureKey}|${app.map.authored.map((r) => r.id).join(',')}`
    renderList(sig, (el) => {
      for (const rec of app.map.authored) {
        const key = `${rec.id}:${rec.baseCy}:${rec.topCy}`
        const item = h('div', { class: 'edt-struct-item', role: 'listitem' })
        const r = listRow({
          role: 'button', className: 'edt-struct-row', key, selected: key === app.selectedStructureKey,
          tip: { title: `${rec.label} (#${rec.id})`, text: `cy ${rec.baseCy}–${rec.topCy}. Click: select · double-click / Shift+Enter: focus.` },
          onPick: () => app.selectStructure(key),
          onSecondary: () => app.focusStructure(key),
        })
        r.appendChild(h('span', { class: 'edt-struct-label', text: `${rec.label} · cy ${rec.baseCy}–${rec.topCy}` }))
        const del = h('button', { class: 'dbg-btn edt-mini edt-danger-ghost', type: 'button', text: 'Remove',
          tip: { title: 'Remove structure', text: `Deletes ${rec.label} from the document. Undoable (Ctrl/⌘+Z).` } })
        del.addEventListener('click', (e) => { e.stopPropagation(); app.removeAuthoredById(rec.id) })
        item.append(r, del)
        el.appendChild(item)
      }
      if (!app.map.authored.length) el.appendChild(h('div', { class: 'edt-list-row edt-dim', role: 'listitem', text: 'No authored structures yet — pick a template and drag on the plan.' }))
    })
  }
  return { el: root, refresh }
}
