import { button, buttonRow, readout, section, slider, textBlock, toggle } from '../../debug/widgets.js'
import { structureFamily } from '../../world/structures/contract.js'
import {
  measureStructureLevel,
  structureCoverage,
  structureKey,
  structureLevels,
  summarizeStructure,
} from '../structureReview.js'
import { commandById, runCommand } from './keymap.js'
import { h, keyedRender, listRow, placeholderRow, sectionOpts } from './dom.js'
import { familyColor, familyLabel } from './legend.js'

// The editor's multilevel structure panels (Structures tab). Structures are
// found in the canonical planners (not in generated chunks), loaded as
// COMPLETE volumes (every participant chunk on every storey, plus optional
// context), and reviewed storey by storey: what the descriptor promises each
// floor is next to what the document actually holds, with the audit's
// findings pinned to the floor they occur on.
//
// Controls are created once; lists are rebuilt only when their content
// signature changes, so explore-mode streaming refreshes never interrupt a
// slider drag or a click.

const SOURCE_LABEL = {
  document: ['doc', 'In the document (baked or imported chunks).'],
  authored: ['auth', 'Authored in this document with the Create tab.'],
  scan: ['scan', 'Found by the atlas scan in the generator’s planners (not in the document yet).'],
  world: ['world', 'Seen in the explored world.'],
}

export function issueList(app, issues, { max = 80 } = {}) {
  const list = h('div', { class: 'edt-list edt-issues', role: 'listbox', 'aria-label': 'Issues' })
  issues.slice(0, max).forEach((issue, i) => {
    const where = Number.isFinite(issue.cy) ? `cy${issue.cy} ` : ''
    const text = `${issue.severity === 'error' ? '✖' : '⚠'} ${where}${issue.text}`
    const locatable = Number.isFinite(issue.gx)
    list.appendChild(listRow({
      className: `edt-sev-${issue.severity}`, text, key: i,
      tip: { title: issue.severity === 'error' ? 'Error' : 'Warning', text: `${where}${issue.text}${locatable ? ` — click or Enter: jump to ${issue.gx},${issue.gz}` : ''}` },
      onPick: locatable ? () => app.locateIssue(issue) : null,
    }))
  })
  if (issues.length > max) list.appendChild(placeholderRow(`+${issues.length - max} more`))
  return list
}

function badgeFor(app, structure) {
  const coverage = structureCoverage(app.source, structure)
  if (coverage.complete) return { text: 'loaded', cls: 'edt-badge-ok', tip: 'Every chunk of the volume is in the source.' }
  if (coverage.present) return { text: `${coverage.present}/${coverage.expected}`, cls: 'edt-badge-warn', tip: `Only ${coverage.present} of ${coverage.expected} volume chunks are present — load the volume to complete it.` }
  return { text: '—', cls: 'edt-badge-dim', tip: 'Not in the document. Select it and “Load volume”.' }
}

function levelStrip(app, s, review, list) {
  const levels = structureLevels(s)
  const issuesByFloor = new Map()
  for (const issue of review?.result?.issues ?? []) {
    if (!Number.isFinite(issue.cy)) continue
    issuesByFloor.set(issue.cy, (issuesByFloor.get(issue.cy) ?? 0) + 1)
  }
  const floorComp = new Map((review?.result?.floors ?? []).map((f) => [f.cy, f.components]))
  for (const level of [...levels].reverse()) {
    const m = measureStructureLevel(app.source, s, level.cy)
    const tip = [
      `walkable ${m.walkable} · lamps ${m.lampsLit}/${m.lamps} lit · furniture ${m.furniture}`,
      `slices: ${m.hasDown ? 'down' : '—'} / ${m.hasUp ? 'up' : '—'}`,
      ...level.notes,
      m.lethalInvalid ? `INVALID lethal half cells: ${m.lethalInvalid}` : '',
      'Click or Enter: show this floor.',
    ].filter(Boolean).join(' · ')
    const row = listRow({
      className: `edt-level${m.chunks === 0 ? ' edt-dim' : ''}`, key: level.cy, selected: level.cy === app.floor,
      tip: { title: `cy ${level.cy} · ${level.role || 'storey'} (storey ${level.offset + 1}/${levels.length})`, text: tip },
      onPick: () => app.setFloor(level.cy),
    })
    const stats = []
    if (m.chunks < m.expected) stats.push(m.chunks ? `${m.chunks}/${m.expected} chunks loaded` : 'not loaded')
    else {
      if (m.floorHoles) stats.push(`floor open ${m.floorHoles}`)
      if (m.ceilHoles) stats.push(`ceiling open ${m.ceilHoles}`)
      if (m.bridge) stats.push(`deck ${m.bridge}`)
      if (m.rails) stats.push(`rails ${m.rails}`)
      if (m.windows) stats.push(`windows ${m.windows}`)
      if (m.lethal) stats.push(`lethal ${m.lethal}`)
      if (m.lethalInvalid) stats.push(`BAD lethal ${m.lethalInvalid}`)
      if (m.stairsUp || m.stairsDown) stats.push(`stairs ${m.stairsUp}↑ ${m.stairsDown}↓`)
    }
    row.append(
      h('span', { class: 'edt-level-cy', text: `cy ${level.cy}` }),
      h('span', { class: 'edt-level-role', text: level.notes.length ? `${level.role} · ${level.notes[0]}` : level.role }),
    )
    const bad = issuesByFloor.get(level.cy)
    if (bad) row.appendChild(h('span', { class: 'edt-level-bad', text: `✖${bad}` }))
    else if ((floorComp.get(level.cy) ?? 1) > 1 && review?.result?.policy === 'perFloor') {
      row.appendChild(h('span', { class: 'edt-level-bad', text: `${floorComp.get(level.cy)} comp` }))
    }
    row.appendChild(h('span', { class: 'edt-level-stats', text: stats.join('  ') || 'solid floor' }))
    list.appendChild(row)
  }
}

const cmdBtn = (app, id, label) => button({ label, tip: { cmd: id }, onClick: () => runCommand(commandById(id), app) })

export function buildStructurePanel(app) {
  const root = h('div', { class: 'edt-struct-panel' })
  const scan = app.structureScan

  // --- atlas scan ---
  const atlas = section('Atlas scan', sectionOpts('structures.atlas', 'Ask the generator’s planners which multilevel structures exist around the view — no chunks are generated.'))
  root.appendChild(atlas.el)
  const scanRadius = slider({
    label: 'scan radius', min: 2, max: 32, step: 1, value: scan.radius, fmt: 0,
    onInput: (v) => { scan.radius = v },
    tip: 'Chunks around the view centre to scan (radius 6 = 13×13 chunks). Large radii with many floors take longer.',
  })
  const scanFrom = slider({
    label: 'floors from', min: -16, max: 48, step: 1, value: scan.y0, fmt: 0,
    onInput: (v) => { scan.y0 = v },
    tip: 'Lowest storey (cy) of the scan box. Swapped automatically if above “floors to”.',
  })
  const scanTo = slider({
    label: 'floors to', min: -16, max: 64, step: 1, value: scan.y1, fmt: 0,
    onInput: (v) => { scan.y1 = v },
    tip: 'Highest storey (cy) of the scan box.',
  })
  const allFamilies = toggle({
    label: 'all families', value: scan.allFamilies,
    onChange: (v) => { scan.allFamilies = v },
    tip: 'Scan every family with multilevel structures, not just the world family (Map tab).',
  })
  atlas.body.append(scanRadius.el, scanFrom.el, scanTo.el, allFamilies.el)
  atlas.body.appendChild(buttonRow('', [
    cmdBtn(app, 'struct.scan', 'Scan around view'),
    cmdBtn(app, 'struct.clear', 'Clear'),
  ]).el)
  const summary = textBlock()
  summary.el.classList.add('edt-inspect', 'edt-selectable')
  atlas.body.appendChild(summary.el)

  // --- list ---
  const listSec = section('Structures', sectionOpts('structures.list', 'Document, authored and scanned structures. Click: select · double-click or Shift+Enter: focus.'))
  root.appendChild(listSec.el)
  const scanInfo = readout('found', { tip: 'Scanned structures and structures present in the current source.' })
  listSec.body.appendChild(scanInfo.el)
  const list = h('div', { class: 'edt-list edt-structs', role: 'listbox', 'aria-label': 'Structures' })
  listSec.body.appendChild(list)
  const renderListInto = keyedRender(list)

  // --- detail ---
  const detailSec = section('Selected structure', sectionOpts('structures.detail', 'Load, focus, audit and drift the selected structure; its storeys top to bottom.'))
  root.appendChild(detailSec.el)
  const empty = h('div', { class: 'edt-note', text: 'Select a structure in the list above (or scan the atlas first).' })
  const detail = h('div', { class: 'edt-struct-detail' })
  detailSec.body.append(empty, detail)
  const head = textBlock()
  head.el.classList.add('edt-selectable')
  detail.appendChild(head.el)
  const ring = slider({
    label: 'context ring', min: 0, max: 2, step: 1, value: app.structureLoad.ring, fmt: 0,
    onInput: (v) => { app.structureLoad.ring = v },
    tip: 'Extra chunks loaded around the volume on every storey (0 = the structure only).',
  })
  const replace = toggle({
    label: 'replace document', value: app.structureLoad.replace,
    onChange: (v) => { app.structureLoad.replace = v; app.panel.refresh() },
    tip: { title: 'Replace document', text: 'On: Load volume (and Bake view) clear the document first — undoable, asks first. Off: merge into the document.' },
  })
  detail.append(ring.el, replace.el)
  const loadBtn = cmdBtn(app, 'struct.load', 'Load volume')
  detail.appendChild(buttonRow('', [loadBtn, cmdBtn(app, 'struct.focus', 'Focus')]).el)
  detail.appendChild(buttonRow('', [cmdBtn(app, 'struct.audit', 'Audit'), cmdBtn(app, 'struct.drift', 'Drift vs generator')]).el)
  const auditBlock = textBlock()
  auditBlock.el.classList.add('edt-selectable')
  const auditIssues = h('div')
  const renderAuditIssues = keyedRender(auditIssues)
  const diffBlock = textBlock()
  diffBlock.el.classList.add('edt-selectable')
  const levelsHead = h('div', { class: 'edt-subhead', text: 'Storeys (top → bottom) · click to visit' })
  const levels = h('div', { class: 'edt-levels', role: 'listbox', 'aria-label': 'Storeys' })
  const renderLevels = keyedRender(levels)
  detail.append(auditBlock.el, auditIssues, diffBlock.el, levelsHead, levels)

  const renderList = () => {
    const entries = app.structureEntries()
    const src = app.source
    const stamp = src.isWorld ? src.stats.generated : app.revision
    const sig = `${app.selectedStructureKey}|${stamp}|${scan.allFamilies}|${app.readOnly}|${entries.map((e) => `${structureKey(e.structure)}:${e.source}`).join(',')}`
    renderListInto(sig, (el) => {
      for (const { structure: s, source } of entries) {
        const key = structureKey(s)
        const sum = summarizeStructure(s)
        const fam = structureFamily(s)
        const badge = badgeFor(app, s)
        const [srcShort, srcTip] = SOURCE_LABEL[source] ?? [source, source]
        const row = listRow({
          className: 'edt-struct-row', key, selected: key === app.selectedStructureKey,
          tip: { title: `#${s.id} · ${familyLabel(sum.family)} ${sum.variant}`, text: `${sum.lines.join(' · ')} · ${srcTip} Click: select · double-click / Shift+Enter: focus.` },
          onPick: () => app.selectStructure(key),
          onSecondary: () => app.focusStructure(key),
        })
        const swatch = h('span', { class: 'edt-swatch', 'aria-hidden': 'true' })
        swatch.style.background = familyColor(fam)
        const label = `${scan.allFamilies || app.readOnly ? `${familyLabel(sum.family)} · ` : ''}cy ${s.baseCy}–${s.topCy} (${sum.levels}) · ${sum.variant} · ${sum.footprint}`
        const size = sum.sizeClass
        const sizeTip = size === 'landmark'
          ? 'Family landmark planner (atrium, tower form, lattice district).'
          : size === 'authored' ? 'Authored in this document with the Create tab.'
            : `Catalog volume, ${size} size class (v26).`
        row.append(swatch,
          h('span', { class: `edt-badge edt-size edt-size-${size}`, text: size === 'landmark' ? 'L★' : size === 'authored' ? 'A' : size[0].toUpperCase(), tip: { title: `Size: ${size}`, text: sizeTip } }),
          h('span', { class: 'edt-struct-label', text: label }),
          h('span', { class: 'edt-badge edt-badge-src', text: srcShort, tip: { title: `Source: ${source}`, text: srcTip } }),
          h('span', { class: `edt-badge ${badge.cls}`, text: badge.text, tip: { title: 'Volume in the document', text: badge.tip } }))
        el.appendChild(row)
      }
      if (!entries.length) el.appendChild(placeholderRow('No structures yet — scan the atlas, or generate a map.'))
    })
  }

  const renderDetail = () => {
    const s = app.selectedStructure()
    empty.hidden = !!s
    detail.hidden = !s
    if (!s) return
    const key = structureKey(s)
    const sum = summarizeStructure(s)
    const coverage = structureCoverage(app.source, s)
    head.set([
      `#${s.id} · ${familyLabel(sum.family)} ${sum.variant}`,
      `cy ${s.baseCy}…${s.topCy} · ${sum.levels} storeys · ${sum.participants} chunks/floor`,
      `footprint ${sum.footprint} @ ${sum.bounds.x0},${sum.bounds.z0}`,
      ...sum.lines,
      `document: ${coverage.present}/${coverage.expected} volume chunks${coverage.complete ? ' ✓' : ''}`,
    ])
    ring.set(app.structureLoad.ring)
    replace.set(app.structureLoad.replace)
    loadBtn.el.textContent = coverage.complete ? 'Reload volume' : 'Load volume'

    const review = app.review.structure?.key === key ? app.review.structure : null
    if (review) {
      const r = review.result
      const stale = review.revision !== app.revision ? ' (stale)' : ''
      const status = r.ok ? 'OK ✓' : r.complete ? 'FAIL' : 'INCOMPLETE'
      const conn = r.policy === 'volume'
        ? `walk ${r.volume.components} comp`
        : `floors ${r.floors.filter((f) => f.components > 1).length ? 'split' : 'connected'}`
      auditBlock.set([
        `audit ${status}${stale}`,
        `${r.counts.chunks} chunks · ${r.counts.slabs} slabs · ${r.counts.slicePairs} slice pairs · ${r.counts.stairLinks} stair links`,
        `${conn} (${r.policy === 'volume' ? 'volume owns its stairs' : 'per-floor rule'}) · ${r.issues.length} issues`,
        r.lattice?.anchorCount ? `lattice anchors ${r.lattice.anchorCount} · cover ${r.lattice.floorCoverage} · cues ${r.lattice.minimumCombinedCueCells}` : '',
      ].filter(Boolean))
      auditBlock.el.classList.toggle('edt-ok', r.ok)
      auditBlock.el.classList.toggle('edt-bad', !r.ok)
    } else {
      auditBlock.set('Not audited yet.')
      auditBlock.el.classList.remove('edt-ok', 'edt-bad')
    }
    renderAuditIssues(review?.result ?? null, (el) => { if (review?.result.issues.length) el.appendChild(issueList(app, review.result.issues)) })
    const diff = app.review.diff?.key === key ? app.review.diff : null
    if (diff) {
      const d = diff.result
      diffBlock.set([
        `drift${diff.revision !== app.revision ? ' (stale)' : ''}: ${d.cells.length} cells in ${d.changedChunks}/${d.compared} chunks`,
        `${d.structural} structure-owned · ${d.descriptorDrift.length} descriptor changes`,
      ])
    } else diffBlock.set('')
    const src = app.source
    const stamp = src.isWorld ? src.stats.generated : app.revision
    renderLevels(`${key}|${app.floor}|${stamp}|${review ? review.revision : '-'}|${review?.result.issues.length}`, (el) => levelStrip(app, s, review, el))
  }

  const refresh = () => {
    allFamilies.set(scan.allFamilies)
    summary.set(scan.summary?.length
      ? scan.summary.map((r) => `${String(r.count).padStart(3)} × ${r.variant} · avg ${(r.levels / r.count).toFixed(1)} storeys · cy ${r.minCy}…${r.maxCy}`)
      : 'Not scanned yet.')
    scanRadius.set(scan.radius)
    scanFrom.set(scan.y0)
    scanTo.set(scan.y1)
    const found = scan.found?.length ?? 0
    const docCount = app.documentStructures().length
    const where = app.readOnly ? 'seen in world' : 'in document'
    scanInfo.set(scan.found ? `${found} scanned · ${docCount} ${where}` : `${docCount} ${where}`)
    renderList()
    renderDetail()
  }

  return { el: root, refresh }
}
