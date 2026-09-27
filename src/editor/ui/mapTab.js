import { button, buttonRow, readout, section, slider, textBlock, toggle } from '../../debug/widgets.js'
import { roomRoleLabel } from '../../debug/mapInspect.js'
import { MAP_FAMILY_ORDER } from '../../world/mapFamily.js'
import { WORLD_GEN_VERSION } from '../../world/constants.js'
import { commandById, runCommand } from './keymap.js'
import { issueList } from './structurePanel.js'
import { row, selectInput, textInput } from './options.js'
import { h, keyedRender, listRow, placeholderRow, sectionOpts } from './dom.js'
import { familyHint, familyLabel } from './legend.js'

// Map tab: the document file, exploring the generated world, procedural
// start, whole-document review and the rooms list.

const cmdBtn = (app, id, label, extra = {}) => button({ label, tip: { cmd: id }, onClick: () => runCommand(commandById(id), app), ...extra })

export function buildMapTab(app) {
  const root = h('div', { class: 'edt-tabbody' })

  // --- document ---
  const doc = section('Document', sectionOpts('map.document', 'The document being edited: its size, seed and file actions.'))
  root.appendChild(doc.el)
  const info = readout('contents', { tip: 'Chunks (one per floor per 16×16 cells), rooms and the map family of the document.' })
  const seedInfo = readout('generated from', { tip: 'The world seed the document’s generated chunks came from (drift compares against it).' })
  const verInfo = readout('worldgen', { tip: 'Generator version stored in the document vs the current one. A mismatch makes drift report differences everywhere.' })
  doc.body.append(info.el, seedInfo.el, verInfo.el)
  doc.body.appendChild(buttonRow('', [
    cmdBtn(app, 'file.new', 'New…'),
    cmdBtn(app, 'file.import', 'Import…'),
    cmdBtn(app, 'file.export', 'Export'),
  ]).el)
  doc.body.appendChild(h('div', { class: 'edt-note', text: 'Tip: drop a .yrmap file on the viewport to import it. The document autosaves in this browser.' }))

  // --- explore ---
  const exp = section('Explore the generated world', sectionOpts('map.explore', 'Browse the generator’s infinite world read-only (the world debugger), then bake what you see into the document.'))
  root.appendChild(exp.el)
  const worldInfo = textBlock()
  worldInfo.el.classList.add('edt-selectable')
  exp.body.appendChild(worldInfo.el)
  const exploreBtn = button({ label: 'Explore world (E)', tip: { cmd: 'mode.explore' }, onClick: () => runCommand(commandById('mode.explore'), app) })
  const bakeBtn = cmdBtn(app, 'world.bakeView', 'Bake view → document')
  const refresh3d = cmdBtn(app, 'world.refresh3d', 'Refresh 3D window')
  // Shown while exploring once the seed / family below no longer match the
  // explored world (editing them alone does not reload it).
  const reopenBtn = cmdBtn(app, 'world.reopen', 'Explore new seed / family', { className: 'edt-primary' })
  exp.body.appendChild(buttonRow('', [reopenBtn]).el)
  exp.body.appendChild(buttonRow('', [exploreBtn, bakeBtn]).el)
  exp.body.appendChild(buttonRow('', [refresh3d]).el)
  const replace = toggle({
    label: 'replace document on bake / load', value: app.structureLoad.replace,
    onChange: (v) => { app.structureLoad.replace = v; app.panel.refresh() },
    tip: { title: 'Replace document', text: 'On: “Bake view” and “Load volume” clear the document first (undoable; you are asked to confirm). Off: they merge into it.' },
  })
  exp.body.appendChild(replace.el)

  // --- world / procedural start ---
  const world = section('World seed & procedural start', sectionOpts('map.world', 'The world seed and family shared by Generate, Explore and the structure atlas scan.'))
  root.appendChild(world.el)
  const seedInput = textInput(app.world.seedText, (v) => { app.world.seedText = v.trim() || 'lobby'; app.panel.refresh() }, {
    label: 'World seed',
    tip: { title: 'World seed', text: 'Any text, or #<number> for an exact 32-bit seed. Used by Generate, Explore (E) and the atlas scan. Empty = “lobby”.' },
  })
  world.body.appendChild(row('world seed', seedInput))
  const familySelect = selectInput(
    MAP_FAMILY_ORDER.map((f) => ({ value: f, label: familyLabel(f) })), app.world.family,
    (v) => { app.world.family = v; app.panel.refresh() },
    { label: 'Map family', tip: { title: 'Map family', text: 'Which generator family to use. Each family has its own layout rules and structures.' } },
  )
  world.body.appendChild(row('family', familySelect))
  const familyNote = h('div', { class: 'edt-note' })
  world.body.appendChild(familyNote)
  const bakeRadius = slider({
    label: 'radius', min: 1, max: 4, step: 1, value: app.world.radius, fmt: 0,
    onInput: (v) => { app.world.radius = v },
    tip: 'Chunk radius around the view centre: 1 = 3×3 chunks, 4 = 9×9.',
  })
  const bakeBase = slider({
    label: 'base floor', min: -8, max: 32, step: 1, value: app.world.baseFloor, fmt: 0,
    onInput: (v) => { app.world.baseFloor = v },
    tip: 'Lowest storey (cy) to generate.',
  })
  const bakeFloors = slider({
    label: 'floors', min: 1, max: 8, step: 1, value: app.world.floors, fmt: 0,
    onInput: (v) => { app.world.floors = v },
    tip: 'How many storeys to generate upward from the base floor.',
  })
  world.body.append(bakeRadius.el, bakeBase.el, bakeFloors.el)
  const genBtn = cmdBtn(app, 'world.generate', 'Generate into document')
  world.body.appendChild(buttonRow('', [genBtn]).el)
  const clipWarn = textBlock()
  clipWarn.el.classList.add('edt-warn')
  world.body.appendChild(clipWarn.el)

  // --- review ---
  const review = section('Review · whole document', sectionOpts('map.review', 'Structural audit and generator drift over every chunk of the document.'))
  root.appendChild(review.el)
  const auto = toggle({
    label: 'auto re-audit', value: app.review.auto,
    onChange: (v) => { app.review.auto = v },
    tip: 'Re-run the selected structure’s audit (and a document audit once run) shortly after every edit.',
  })
  review.body.appendChild(auto.el)
  review.body.appendChild(buttonRow('', [
    cmdBtn(app, 'review.audit', 'Audit'),
    cmdBtn(app, 'review.drift', 'Drift'),
    cmdBtn(app, 'review.clear', 'Clear'),
  ]).el)
  const reviewInfo = textBlock()
  reviewInfo.el.classList.add('edt-selectable')
  review.body.appendChild(reviewInfo.el)
  const reviewIssues = h('div')
  review.body.appendChild(reviewIssues)
  const renderIssues = keyedRender(reviewIssues)

  // --- rooms ---
  const rooms = section('Rooms', sectionOpts('map.rooms', 'Every room in the document; click one to select and centre it.'))
  root.appendChild(rooms.el)
  const roomsFilter = toggle({ label: 'current floor only', value: true, onChange: () => renderRooms(),
    tip: 'List only the rooms on the floor shown in the plan.' })
  rooms.body.appendChild(roomsFilter.el)
  const roomsList = h('div', { class: 'edt-list', role: 'listbox', 'aria-label': 'Rooms' })
  rooms.body.appendChild(roomsList)
  const roomsRender = keyedRender(roomsList)

  const renderRooms = () => {
    const all = roomsFilter.get() ? app.map.rooms.filter((r) => r.cy === app.floor) : app.map.rooms
    const selId = app.selection?.type === 'room' ? app.selection.id : null
    const sig = `${app.revision}|${app.floor}|${roomsFilter.get()}|${selId}|${all.length}`
    roomsRender(sig, (list) => {
      for (const r of all.slice(0, 400)) {
        const label = roomRoleLabel(r.role) ?? 'ordinary'
        const size = `${r.x1 - r.x0 + 1}×${r.z1 - r.z0 + 1}`
        list.appendChild(listRow({
          text: `#${r.id} ${label} ${size} @${r.x0},${r.z0} f${r.cy}${r.baked ? ' (baked)' : ''}`,
          key: r.id, selected: r.id === selId,
          tip: { title: `Room #${r.id} · ${label}`, text: `${size} cells at ${r.x0},${r.z0} on cy ${r.cy}${r.baked ? ' (from the generator)' : ''}. Click or Enter: select and centre it.` },
          onPick: () => app.focusRoom(r),
        }))
      }
      if (all.length > 400) list.appendChild(placeholderRow(`+${all.length - 400} more (turn on “current floor only”)`))
      if (!all.length) list.appendChild(placeholderRow('No rooms on this floor — drag one with the Room tool (2).'))
    })
  }

  const renderReview = () => {
    const r = app.review.doc
    const d = app.review.diff && !app.review.diff.key ? app.review.diff : null
    const lines = []
    if (r) {
      const res = r.result
      lines.push(`audit ${res.structural ? 'structure OK' : 'STRUCTURE FAIL'}${r.revision !== app.revision ? ' (stale)' : ''}`)
      lines.push(`${res.chunks} chunks · ${res.counts?.slabs ?? 0} slabs · ${res.counts?.stairLinks ?? 0} stair links · ${res.issues.length} issues`)
      const split = (res.floors ?? []).filter((f) => f.components > 1)
      if (split.length) lines.push(`planar pockets on cy ${split.map((f) => f.cy).join(',')}`)
    }
    if (d) {
      lines.push(`drift${d.revision !== app.revision ? ' (stale)' : ''}: ${d.result.cells.length} cells in ${d.result.changedChunks}/${d.result.compared} chunks · ${d.result.structural} structure-owned`)
    }
    reviewInfo.set(lines.length ? lines : 'Not run yet — Audit checks slabs, stairs and pockets; Drift compares with the generator.')
    renderIssues(r ? r.result : null, (el) => { if (r?.result.issues.length) el.appendChild(issueList(app, r.result.issues)) })
  }

  const refresh = () => {
    const explore = app.mode === 'explore'
    info.set(`${app.map.chunks.size} chunks · ${app.map.rooms.length} rooms · ${app.map.meta.family}`)
    seedInfo.set(app.map.chunks.size ? `seed ${app.map.meta.seed >>> 0}` : '—')
    const v = app.map.meta.worldGenVersion
    verInfo.set(v === undefined ? `v${WORLD_GEN_VERSION}` : v === WORLD_GEN_VERSION ? `v${v} (current)` : `v${v} ≠ current v${WORLD_GEN_VERSION}`)

    const w = app.explorer
    if (explore && w) {
      const st = w.stats
      worldInfo.set([
        `EXPLORING ${w.meta.name} · seed ${w.seed >>> 0}`,
        `cached ${w.chunks.size} chunks · pending ${w.pending}`,
        `generated ${st.generated} · avg ${(st.generated ? st.totalMs / st.generated : 0).toFixed(1)} ms · max ${st.maxMs.toFixed(1)} ms${st.maxKey ? ` (${st.maxKey})` : ''}`,
        st.errors ? `generation errors: ${st.errors}` : 'read-only · “Bake view” copies it into the document to edit',
      ])
    } else {
      worldInfo.set([
        `Editing the document (${app.map.chunks.size} chunks).`,
        w ? `Explorer kept: ${w.meta.name} (${w.chunks.size} cached)` : `Explore opens the world of seed “${app.world.seedText}” · ${familyLabel(app.world.family)}.`,
      ])
    }
    exploreBtn.el.textContent = explore ? 'Back to document (E)' : 'Explore world (E)'
    const stale = explore && w && !w.sameWorld(app.world.seedText, app.world.family)
    reopenBtn.el.parentElement.style.display = stale ? '' : 'none'
    replace.set(app.structureLoad.replace)
    if (document.activeElement !== seedInput) seedInput.value = app.world.seedText
    if (document.activeElement !== familySelect) familySelect.value = app.world.family
    familyNote.textContent = stale
      ? `${familyHint(app.world.family)} — not loaded yet: press “Explore new seed / family” above.`
      : familyHint(app.world.family)
    bakeRadius.set(app.world.radius)
    bakeBase.set(app.world.baseFloor)
    bakeFloors.set(app.world.floors)
    const clipped = app.clippedStructures()
    clipWarn.set(clipped.length
      ? clipped.map(({ structure, coverage }) =>
        `⚠ #${structure.id} clipped ${coverage.present}/${coverage.expected} — load its volume (Structures tab)`)
      : '')
    auto.set(app.review.auto)
    for (const el of [review.el, rooms.el]) el.classList.toggle('edt-muted', explore)
    renderReview()
    renderRooms()
  }
  return { el: root, refresh }
}
