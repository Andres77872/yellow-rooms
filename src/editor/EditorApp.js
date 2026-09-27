import { EditorMap, seedFromText } from './EditorMap.js'
import { decodeMapFile, encodeMapFile } from './format/yrmap.js'
import { regenerateRoom, removeRoom } from './roomBuilder.js'
import { MapView2D } from './ui/MapView2D.js'
import { SectionView } from './ui/SectionView.js'
import { Preview3D } from './ui/Preview3D.js'
import { buildPanel } from './ui/panel.js'
import { FURN_NAMES } from './ui/options.js'
import { chordOf, commandForChord, isSingleCharChord, isTextField, runCommand } from './ui/keymap.js'
import { injectEditorStyle } from './ui/style.js'
import { createTools } from './ui/tools.js'
import { describeCell, roomRoleLabel } from '../debug/mapInspect.js'
import { CELL, CHUNK, CHUNK_WORLD, cIdx } from '../world/constants.js'
import { MAP_FAMILY_ORDER, worldConfigForFamilyOrOffice } from '../world/mapFamily.js'
import { WorldSource } from './worldSource.js'
import { chunkDescriptors, inspectCell } from './inspect.js'
import { distanceField, isovist, lightField, liminalReport, shortestPath } from './simulate.js'
import { relightByCircuits } from './lighting.js'
import { generatePrototype } from './prototypes.js'
import {
  DEFAULT_TEMPLATE_PARAMS,
  TEMPLATE_DEFS,
  applyTemplate,
  authoredView,
  planTemplate,
  removeAuthored,
} from './templates.js'
import { STAIR_DOWN_EXIT, STAIR_DOWN_RUN, STAIR_UP_LANDING, STAIR_UP_RUN, holeMasks } from './holeMasks.js'
import {
  protectedCeilingReason,
  protectedCellReason,
  protectedEdgeReason,
  protectedRectReason,
} from './protect.js'
import {
  auditDocument,
  auditStructure,
  clippedStructures,
  diffAgainstGenerated,
  discoverStructures,
  documentStructures,
  structureChunkBox,
  structureChunkCoords,
  structureCoverage,
  structureKey,
  structureLevels,
  structureVariant,
} from './structureReview.js'
import { findNearestInWorld, stampRecipeIntoDocument } from './catalogLab.js'

const FACING_LABEL = ['+z', '−z', '+x', '−x']
const AUTOSAVE_KEY = 'yr-editor-autosave-v1'
const NOTICE_MS = 3200
const REAUDIT_MS = 450

// The editor application: owns the document, viewport(s), panel, tools,
// selection and file I/O. Everything mutates through EditorMap.mutate so the
// whole session is undoable.
//
// The document is layered — one ChunkData per floor — and canonical tall
// structures span many of those floors, so the app also owns the multilevel
// review state: the selected structure, scan results from the planners, the
// section cut, and the latest audit/drift results (re-audited automatically
// after edits so a broken slab contract shows up where it was made).
export class EditorApp {
  constructor(root) {
    injectEditorStyle()
    this.map = new EditorMap()
    this.revision = 0
    this.floor = 0
    this.selection = null
    this.preview = null
    this.previewClip = 'all'
    this._needsDraw = true
    this.protect = true
    this.notice = null
    this.noticeLog = []
    this.autosaveState = { state: 'idle', at: 0 }
    this.previewCeiling = true
    this.flash = null
    this.world = { seedText: 'lobby', family: 'office', radius: 1, baseFloor: 0, floors: 1 }
    this.layers = {
      grid: true, labels: true, ghost: true, ceiling: true, stairs: true,
      structures: true, lethal: true, issues: true, diff: true, sim: true,
    }
    // Source mode: 'document' edits the finite map; 'explore' browses the
    // infinite generated world of any family/seed read-only (the debugger).
    this.mode = 'document'
    this.explorer = null
    this.fillMode = 'kind'
    this.inspect = null
    this.sim = {
      probe: 'inspect', radius: 3, floors: 2,
      distance: null, path: null, a: null, b: null, isovist: null, light: null, report: null,
    }
    this.section = { on: false, axis: 'x', line: 7, follow: false, height: 0.36 }
    this.structureScan = { radius: 6, y0: -2, y1: 24, found: null, allFamilies: false, summary: null }
    this.structureLoad = { ring: 1, replace: true }
    this.author = { template: 'atrium', params: { ...DEFAULT_TEMPLATE_PARAMS } }
    this.selectedStructureKey = null
    this.review = { auto: true, structure: null, doc: null, diff: null }

    this.viewportEl = document.createElement('div')
    this.viewportEl.className = 'edt-viewport'
    this.planEl = document.createElement('div')
    this.planEl.className = 'edt-plan'
    this.viewportEl.appendChild(this.planEl)
    this.tools = createTools(this)
    this.tool = this.tools[0]
    this.view2d = new MapView2D(this, this.planEl)
    this.sectionView = new SectionView(this, this.viewportEl)
    // Focusable (keyboard users reach its description and the controls inside
    // it). Tab toggles 3D only after the author clicked the plan
    // (_planPointerFocus); a keyboard Tab onto it keeps moving focus, and Esc
    // hands Tab back to focus navigation.
    this.viewportEl.tabIndex = 0
    this._planPointerFocus = false
    this.viewportEl.addEventListener('focusout', (e) => {
      if (e.target === this.viewportEl) this._planPointerFocus = false
    })
    this.panel = buildPanel(this)
    root.appendChild(this.panel.el)

    this._fileInput = document.createElement('input')
    this._fileInput.type = 'file'
    this._fileInput.accept = '.yrmap'
    this._fileInput.style.display = 'none'
    root.appendChild(this._fileInput)
    this._fileInput.addEventListener('change', () => {
      const f = this._fileInput.files?.[0]
      if (f) this._loadFile(f)
      this._fileInput.value = ''
    })

    this._applySectionLayout()
    this._bindKeys()
    this._bindDrop()
    this.panel.refresh()
    this._restoreAutosave()
    requestAnimationFrame(this._frame)
  }

  // The source every view, inspector, audit and simulation reads.
  get source() {
    return this.mode === 'explore' && this.explorer ? this.explorer : this.map
  }

  get readOnly() {
    return this.mode === 'explore'
  }

  // --- frame loop -----------------------------------------------------------

  _frame = () => {
    const now = performance.now()
    if (this.flash && now - this.flash.at < 1700) this._needsDraw = true
    if (this.mode === 'explore' && this.explorer?.pending) {
      const v = this.view2d.view
      const focus = { cx: Math.floor(v.cx / CHUNK_WORLD), cz: Math.floor(v.cz / CHUNK_WORLD), cy: this.floor }
      if (this.explorer.pump(9, focus)) this._needsDraw = true
      this._streamTick = (this._streamTick ?? 0) + 1
      // Refresh the panel's world stats while streaming and once it drains.
      if (this._streamTick % 20 === 0 || !this.explorer.pending) this.panel.refresh()
    }
    if (this.preview) {
      const dirty = this.map.takeDirty()
      if (dirty.size && !this.readOnly) this.preview.sync(dirty)
      this.preview.render()
    }
    if (this._needsDraw) {
      this._needsDraw = false
      if (!this.preview) this.view2d.draw()
      if (this.section.on) this.sectionView.draw()
    }
    this._updateStatus()
    requestAnimationFrame(this._frame)
  }

  invalidate() {
    this._needsDraw = true
  }

  onDocumentChanged() {
    this.revision++
    this.invalidate()
    this.panel.refresh()
    this._scheduleAutosave()
    this._scheduleReaudit()
  }

  _documentReplaced() {
    this.revision++
    this.review = { ...this.review, structure: null, doc: null, diff: null }
  }

  // level: 'info' | 'ok' | 'warn' | 'error'; inferred from the text when
  // omitted so the ~30 existing call sites get sensible colours.
  notify(text, level) {
    level ??= /\b(failed|error|crash)/i.test(text) ? 'error'
      : /(refused|cannot|read-only|not |unavailable|nothing|stale|clipped|⚠)/i.test(text) ? 'warn' : 'info'
    this.notice = { text, level, at: performance.now() }
    this.noticeLog.push({ text, level, time: Date.now() })
    if (this.noticeLog.length > 40) this.noticeLog.shift()
  }

  // Point the shared seed field at `seed`, keeping the author's text when it
  // already names that world.
  _keepWorldSeed(seed) {
    if (seedFromText(this.world.seedText) !== seed >>> 0) this.world.seedText = `#${seed >>> 0}`
  }

  // --- autosave (page reloads must never lose work) --------------------------

  _scheduleAutosave() {
    clearTimeout(this._autosaveTimer)
    this._autosaveTimer = setTimeout(() => this._autosave(), 800)
  }

  async _autosave() {
    this.autosaveState = { state: 'saving', at: Date.now() }
    try {
      const bytes = await encodeMapFile(this.map)
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      }
      localStorage.setItem(AUTOSAVE_KEY, btoa(bin))
      this.autosaveState = { state: 'saved', at: Date.now() }
    } catch {
      // Storage quota / private mode — the explicit export path still works.
      this.autosaveState = { state: 'failed', at: Date.now() }
    }
  }

  async _restoreAutosave() {
    // Decoding is async: an edit or new document made meanwhile wins.
    const bootMap = this.map
    const bootRevision = this.revision
    try {
      const b64 = localStorage.getItem(AUTOSAVE_KEY)
      if (!b64) return
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const map = await decodeMapFile(bytes)
      if (this.map !== bootMap || this.revision !== bootRevision) return
      this._adoptMap(map)
    } catch {
      // Corrupt/old autosave — start fresh rather than blocking boot.
    }
  }

  _adoptMap(map) {
    this.map = map
    this._documentReplaced()
    this.floor = map.floors()[0] ?? 0
    this.world.family = map.meta.family
    // Continue the document's own world: scans and bakes use its exact seed.
    if (map.chunks.size && map.meta.seed) this._keepWorldSeed(map.meta.seed)
    this.select(null)
    const b = map.bounds()
    if (b) {
      this.view2d.centerOn(
        ((b.x0 + b.x1 + 1) / 2) * CHUNK_WORLD,
        ((b.z0 + b.z1 + 1) / 2) * CHUNK_WORLD
      )
    }
    const structures = this.documentStructures()
    this.selectedStructureKey = structures.length ? structureKey(structures[0]) : null
    this.map.takeDirty()
    this.preview?.sync(null)
    this.preview?.fit()
    this.preview?.setHighlight(this.selectedStructure())
    this.invalidate()
    this.panel.refresh()
    this._scheduleReaudit()
  }

  // --- status line ------------------------------------------------------------

  _describeHover(h) {
    const cy = this.floor
    const bits = [`cell ${h.gx},${h.gz}`, `cy ${cy}`]
    const src = this.source
    const d = src.chunkAt(Math.floor(h.gx / CHUNK), cy, Math.floor(h.gz / CHUNK))
    if (!d) {
      bits.push('empty')
      return bits
    }
    const lx = h.gx - d.cx * CHUNK
    const lz = h.gz - d.cz * CHUNK
    bits.push(describeCell(d, lx, lz))
    const i = cIdx(lx, lz)
    const m = holeMasks(d)
    if (m.floor[i]) bits.push('floor open')
    if (m.ceil[i]) bits.push('ceiling open')
    if (m.stair[i] & (STAIR_UP_LANDING | STAIR_UP_RUN)) bits.push('stair ↑')
    if (m.stair[i] & (STAIR_DOWN_RUN | STAIR_DOWN_EXIT)) bits.push('stair ↓')
    const room = src.roomAt(h.gx, cy, h.gz)
    if (room) bits.push(`room #${room.id}`)
    const role = this.selectedLevelRole(cy)
    if (role) bits.push(`storey: ${role}`)
    const dist = this.sim.distance?.dist?.get(`${h.gx},${h.gz},${cy}`)
    if (dist !== undefined) bits.push(`walk ${dist} cells`)
    const lit = this.sim.light?.cy === cy ? this.sim.light.level.get(`${h.gx},${h.gz},${cy}`) : undefined
    if (this.sim.light?.cy === cy) bits.push(`light ${(lit ?? 0).toFixed(2)}`)
    if (this.protect && !this.readOnly) {
      const reason = protectedCellReason(this.map, h.gx, cy, h.gz)
      if (reason) bits.push(`locked (${reason})`)
    }
    return bits
  }

  _updateStatus() {
    const h = this.view2d.hover
    const n = this.notice && performance.now() - this.notice.at < NOTICE_MS ? this.notice : null
    let hover
    if (this.preview) hover = '3D · drag: orbit · right-drag: pan · wheel: zoom · Home: reset view'
    else if (h) hover = this._describeHover(h).join(' · ')
    else hover = this.readOnly ? `exploring ${this.explorer.meta.name} (read-only)` : 'hover the plan for cell details'
    const a = this.autosaveState
    const t = a.at ? new Date(a.at) : null
    const hhmm = t ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : ''
    const save = this.readOnly ? 'read-only'
      : a.state === 'saving' ? 'saving…'
        : a.state === 'saved' ? `autosaved ${hhmm}`
          : a.state === 'failed' ? 'autosave failed — export!' : 'autosave on'
    this.ui?.status.update({
      mode: this.readOnly ? 'EXPLORE' : 'DOCUMENT',
      floor: `cy ${this.floor}`,
      hover,
      notice: n,
      prompt: this.preview ? '' : (this.tool?.status ?? ''),
      zoom: this.preview ? '3D' : `zoom ${this.view2d.view.scale.toFixed(1)}×`,
      save,
    })
  }

  // --- structure protection (tools call these before writing) ----------------

  guardCell(gx, cy, gz, action = 'edit') {
    if (!this.protect) return null
    const reason = protectedCellReason(this.map, gx, cy, gz)
    if (reason) this.notify(`${action} refused: ${reason} at ${gx},${gz} (protect structures is on)`)
    return reason
  }

  guardCeiling(gx, cy, gz) {
    if (!this.protect) return null
    const reason = protectedCeilingReason(this.map, gx, cy, gz)
    if (reason) this.notify(`lamp refused: ${reason} at ${gx},${gz}`)
    return reason
  }

  guardEdge(axis, gx, gz, cy) {
    if (!this.protect) return null
    const reason = protectedEdgeReason(this.map, axis, gx, gz, cy)
    if (reason) this.notify(`edge refused: ${reason} (protect structures is on)`)
    return reason
  }

  guardRect(rect, cy) {
    if (!this.protect) return null
    const hit = protectedRectReason(this.map, rect, cy)
    if (hit) this.notify(`room refused: ${hit.reason} at ${hit.gx},${hit.gz}`)
    return hit
  }

  // --- tools & selection ----------------------------------------------------

  setTool(i) {
    const next = this.tools[i] ?? this.tools[0]
    // End the old tool's gesture first: a drag left open would keep an
    // EditorMap op open and fold every later edit into it (undo breaks).
    if (next !== this.tool) this.tool?.onCancel?.()
    this.tool = next
    this.panel.refresh()
    this.invalidate()
  }

  setToolById(id) {
    const i = this.tools.findIndex((t) => t.id === id)
    if (i >= 0) this.setTool(i)
  }

  // Escape: end the gesture in progress and clear the selection.
  escape() {
    this._planPointerFocus = false
    this.tool?.onCancel?.()
    this.ui?.status.closePopover?.()
    if (this.selection) this.select(null)
    else this.invalidate()
  }

  // --- undo (read-only peeks at EditorMap's stacks for button state) --------

  canUndo() {
    return !this.readOnly && (this.map._undo?.length ?? 0) > 0
  }

  canRedo() {
    return !this.readOnly && (this.map._redo?.length ?? 0) > 0
  }

  undo() {
    if (this.readOnly) return this.notify('undo: switch back to the document first (E)', 'warn')
    this.tool?.onCancel?.()
    if (this.map.undo()) this.onDocumentChanged()
    else this.notify('nothing to undo', 'warn')
  }

  redo() {
    if (this.readOnly) return this.notify('redo: switch back to the document first (E)', 'warn')
    if (this.map.redo()) this.onDocumentChanged()
    else this.notify('nothing to redo', 'warn')
  }

  turnObjectFacing() {
    const t = this.tools.find((x) => x.id === 'object')
    t?.turn()
    this.panel.refresh()
    this.invalidate()
  }

  // --- view helpers (keymap: F / Home / = / -) --------------------------------

  fitDocument() {
    if (this.preview) return this.resetPreviewView()
    const s = this.readOnly ? this.selectedStructure() : null
    if (s) {
      const b = s.globalBounds
      this.view2d.fitCells(b.x0, b.z0, b.x1, b.z1)
      return
    }
    const b = this.readOnly ? null : this.map.bounds()
    if (!b) {
      this.notify(this.readOnly ? 'fit: the explored world is infinite — select a structure to frame it' : 'fit: the document is empty', 'warn')
      return
    }
    this.view2d.fitCells(b.x0 * CHUNK, b.z0 * CHUNK, (b.x1 + 1) * CHUNK - 1, (b.z1 + 1) * CHUNK - 1)
  }

  zoomBy(factor) {
    if (this.preview) return
    const v = this.view2d
    v.zoomAt(v._w / 2, v._h / 2, -Math.log(factor) / 0.0015)
  }

  resetPreviewView() {
    if (!this.preview) return
    const s = this.selectedStructure()
    if (s) this.preview.frameStructure(s)
    else this.preview.fit()
  }

  setPreviewCeiling(on) {
    this.previewCeiling = !!on
    this.preview?.setCeiling(this.previewCeiling)
    this.panel.refresh()
  }

  select(sel) {
    this.selection = sel
    this.panel.refresh()
    this.invalidate()
  }

  describeSelection() {
    const sel = this.selection
    if (!sel) return '(nothing selected)'
    if (sel.type === 'furniture') {
      const found = this.map.furnitureAt(sel.gx, sel.cy, sel.gz)
      if (!found) return '(gone)'
      const { rec } = found
      return [
        `${FURN_NAMES[rec.kind] ?? rec.kind} @ ${sel.gx},${sel.gz} f${sel.cy}`,
        `facing ${FACING_LABEL[rec.facing]} · ${rec.w.toFixed(2)}×${rec.d.toFixed(2)}u`,
      ]
    }
    if (sel.type === 'lamp') {
      const found = this.map.lampAt(sel.gx, sel.cy, sel.gz)
      if (!found) return '(gone)'
      return [`lamp @ ${sel.gx},${sel.gz} f${sel.cy}`, found.rec.lit ? 'lit' : 'dead']
    }
    if (sel.type === 'room') {
      const r = this.map.roomById(sel.id)
      if (!r) return '(gone)'
      return [
        `room #${r.id} · ${roomRoleLabel(r.role) ?? 'ordinary'}`,
        `${r.x1 - r.x0 + 1}×${r.z1 - r.z0 + 1} @ ${r.x0},${r.z0} f${r.cy}`,
        `salt ${r.salt}${r.baked ? ' · baked' : ''}`,
      ]
    }
    return '(nothing selected)'
  }

  deleteSelection() {
    const sel = this.selection
    if (!sel) return
    if (sel.type === 'furniture') {
      this.map.mutate(() => this.map.removeFurniture(sel.gx, sel.cy, sel.gz))
    } else if (sel.type === 'lamp') {
      this.map.mutate(() => this.map.setLamp(sel.gx, sel.cy, sel.gz, null))
    } else if (sel.type === 'room') {
      const room = this.map.roomById(sel.id)
      if (room) removeRoom(this.map, room)
    }
    this.select(null)
    this.onDocumentChanged()
  }

  rotateSelection() {
    const sel = this.selection
    if (sel?.type !== 'furniture') return
    const found = this.map.furnitureAt(sel.gx, sel.cy, sel.gz)
    if (!found) return
    this.map.mutate(() => {
      const live = this.map.furnitureAt(sel.gx, sel.cy, sel.gz)
      const rec = live.rec
      const CYCLE = { 0: 3, 3: 1, 1: 2, 2: 0 } // 90° steps through the DIR set
      rec.facing = CYCLE[rec.facing] ?? 0
      const w = rec.w
      rec.w = rec.d
      rec.d = w
      // Recentre within the cell — a rotated wall-hug offset would poke
      // through the wall, so rotation snaps the piece to the cell centre.
      rec.x = (rec.lx + 0.5) * CELL
      rec.z = (rec.lz + 0.5) * CELL
    })
    this.onDocumentChanged()
  }

  toggleSelectedLamp() {
    const sel = this.selection
    if (sel?.type !== 'lamp') return
    const found = this.map.lampAt(sel.gx, sel.cy, sel.gz)
    if (!found) return
    this.map.mutate(() => this.map.setLamp(sel.gx, sel.cy, sel.gz, !found.rec.lit))
    this.onDocumentChanged()
  }

  setRoomRole(id, role) {
    const room = this.map.roomById(id)
    if (!room) return
    this.map.mutate(() => {
      room.role = role
      for (let gz = room.z0; gz <= room.z1; gz++) {
        for (let gx = room.x0; gx <= room.x1; gx++) {
          const c = this.map.cellAt(gx, room.cy, gz)
          if (c.spaceId === room.id) this.map.setCell(gx, room.cy, gz, { role })
        }
      }
      regenerateRoom(this.map, room)
    })
    this.onDocumentChanged()
  }

  rerollRoom(id) {
    const room = this.map.roomById(id)
    if (!room) return
    regenerateRoom(this.map, room, { salt: room.salt + 1 })
    this.onDocumentChanged()
  }

  focusRoom(room) {
    this.setFloor(room.cy)
    this.select({ type: 'room', id: room.id })
    this.view2d.centerOn(((room.x0 + room.x1 + 1) / 2) * CELL, ((room.z0 + room.z1 + 1) / 2) * CELL)
  }

  // Floor navigation is view state: it never dirties the document.
  setFloor(cy) {
    if (!Number.isInteger(cy)) return
    this.floor = cy
    this.preview?.onFloorChanged()
    this.panel.refresh()
    this.invalidate()
  }

  jumpToCell(gx, gz, cy, { center = true } = {}) {
    if (!Number.isFinite(gx) || !Number.isFinite(gz)) return
    if (Number.isInteger(cy) && cy !== this.floor) this.setFloor(cy)
    if (center) this.view2d.centerOn((gx + 0.5) * CELL, (gz + 0.5) * CELL)
    if (this.preview && center) {
      this.preview.orbit.tx = (gx + 0.5) * CELL
      this.preview.orbit.tz = (gz + 0.5) * CELL
    }
    this.flash = { gx, gz, cy: this.floor, at: performance.now() }
    this.invalidate()
  }

  locateIssue(issue) {
    if (this.section.on) this.section.line = this.section.axis === 'x' ? issue.gz : issue.gx
    this.jumpToCell(issue.gx, issue.gz, Number.isInteger(issue.cy) ? issue.cy : this.floor)
  }

  // --- section view -----------------------------------------------------------

  _applySectionLayout() {
    const on = this.section.on
    const pct = `${Math.round(this.section.height * 1000) / 10}%`
    this.planEl.style.bottom = on ? pct : '0'
    this.sectionView.root.style.height = pct
    const now = String(Math.round(this.section.height * 100))
    this.sectionView.handle.setAttribute('aria-valuenow', now)
    this.sectionView.handle.setAttribute('aria-valuetext', `${now}% of the viewport`)
    this.sectionView.setVisible(on)
    this.view2d.resize()
    this.preview?.resize()
  }

  setSectionOpen(on) {
    this.section.on = !!on
    this._applySectionLayout()
    this.panel.refresh()
    this.invalidate()
  }

  setSectionHeight(frac) {
    this.section.height = frac
    this._applySectionLayout()
  }

  setSectionAxis(axis, through = null) {
    if (axis === this.section.axis) return
    const v = this.view2d.view
    this.section.axis = axis
    if (through) this.section.line = axis === 'x' ? through.gz : through.gx
    else this.section.line = axis === 'x' ? Math.floor(v.cz / CELL) : Math.floor(v.cx / CELL)
    this.panel.refresh()
    this.invalidate()
  }

  swapSectionAxis(through = this.view2d.hover) {
    this.setSectionAxis(this.section.axis === 'x' ? 'z' : 'x', through)
    if (!this.section.on) this.setSectionOpen(true)
  }

  setSectionLine(p) {
    this.section.line = this.section.axis === 'x' ? p.gz : p.gx
    if (!this.section.on) this.setSectionOpen(true)
    this.invalidate()
  }

  setSectionFollow(on) {
    this.section.follow = !!on
    this.notify(`section ${on ? 'follows the cursor' : 'fixed'}`)
    this.invalidate()
  }

  onPlanHover(h) {
    if (h && this.section.on && this.section.follow) {
      this.section.line = this.section.axis === 'x' ? h.gz : h.gx
    }
  }

  // --- structures ---------------------------------------------------------------

  // Structures carried by the current source's chunks: the document's baked
  // or imported volumes, or everything the explorer has generated so far.
  documentStructures() {
    const src = this.source
    const stamp = src.isWorld ? src.stats.generated : this.revision
    const c = this._docStructs
    if (c && c.src === src && c.stamp === stamp) return c.list
    const list = documentStructures(src)
    this._docStructs = { src, stamp, list }
    return list
  }

  clippedStructures() {
    if (this.readOnly) return []
    const c = this._clipped
    if (c && c.map === this.map && c.revision === this.revision) return c.list
    const list = clippedStructures(this.map)
    this._clipped = { map: this.map, revision: this.revision, list }
    return list
  }

  // Source structures first (they are what the author edits or is looking
  // at), then scan hits from the planners; one entry per canonical key.
  structureEntries() {
    const src = this.source
    const out = new Map()
    for (const s of this.documentStructures()) {
      out.set(structureKey(s), {
        structure: s,
        seed: src.meta.seed,
        family: src.meta.family,
        source: src.isWorld ? 'world' : 'document',
      })
    }
    if (!src.isWorld) {
      for (const view of this.authoredViews()) {
        out.set(structureKey(view), { structure: view, seed: src.meta.seed, family: src.meta.family, source: 'authored' })
      }
    }
    for (const entry of this.structureScan.found ?? []) {
      const key = structureKey(entry.structure)
      if (!out.has(key)) out.set(key, { ...entry, source: 'scan' })
    }
    return [...out.values()].sort((a, b) =>
      a.structure.baseCy - b.structure.baseCy || a.structure.id - b.structure.id)
  }

  _structureEntry(key) {
    return this.structureEntries().find((e) => structureKey(e.structure) === key) ?? null
  }

  // Hot path (plan, section gutter, status line): memoized on everything the
  // lookup reads.
  selectedStructure() {
    const key = this.selectedStructureKey
    if (!key) return null
    const src = this.source
    const stamp = src.isWorld ? src.stats.generated : this.revision
    const c = this._selCache
    if (c && c.key === key && c.src === src && c.stamp === stamp && c.found === this.structureScan.found) {
      return c.value
    }
    const value = this._structureEntry(key)?.structure ?? null
    this._selCache = { key, src, stamp, found: this.structureScan.found, value }
    return value
  }

  selectedLevelRole(cy) {
    const s = this.selectedStructure()
    if (!s || cy < s.baseCy || cy > s.topCy) return null
    const key = structureKey(s)
    if (this._levelCache?.key !== key) this._levelCache = { key, levels: structureLevels(s) }
    return this._levelCache.levels[cy - s.baseCy]?.role ?? null
  }

  selectStructure(key) {
    this.selectedStructureKey = key
    this.preview?.setHighlight(this.selectedStructure())
    this.panel.refresh()
    this.invalidate()
    this._scheduleReaudit()
  }

  // The structure atlas: every canonical structure the planners place in a
  // chunk window around the view, for the world's family or for every family
  // with tall structures. Bands span >= 3 storeys, so sampling every third
  // floor cannot miss one.
  scanStructures() {
    const seed = seedFromText(this.world.seedText)
    // v26: every family has structures (Sewer's are catalog volumes).
    const families = this.structureScan.allFamilies ? [...MAP_FAMILY_ORDER] : [this.world.family]
    const r = this.structureScan.radius
    const ccx = Math.floor(this.view2d.view.cx / CHUNK_WORLD)
    const ccz = Math.floor(this.view2d.view.cz / CHUNK_WORLD)
    const y0 = Math.min(this.structureScan.y0, this.structureScan.y1)
    const y1 = Math.max(this.structureScan.y0, this.structureScan.y1)
    const t0 = performance.now()
    const found = []
    const summary = new Map()
    for (const f of families) {
      const { family, config } = worldConfigForFamilyOrOffice(f)
      const list = discoverStructures(seed, config, {
        x0: ccx - r, x1: ccx + r, z0: ccz - r, z1: ccz + r, y0, y1,
      })
      for (const structure of list) {
        found.push({ structure, seed, family })
        const variant = `${family} ${structureVariant(structure)}${structure.sizeClass ? ` (${structure.sizeClass})` : ''}`
        const row = summary.get(variant) ?? { variant, count: 0, levels: 0, minCy: Infinity, maxCy: -Infinity }
        row.count++
        row.levels += structure.topCy - structure.baseCy + 1
        row.minCy = Math.min(row.minCy, structure.baseCy)
        row.maxCy = Math.max(row.maxCy, structure.topCy)
        summary.set(variant, row)
      }
    }
    this.structureScan.found = found
    this.structureScan.summary = [...summary.values()].sort((a, b) => b.count - a.count)
    this.notify(`atlas: ${found.length} structures (${families.join(', ')}) in ${(2 * r + 1) ** 2} chunks × cy ${y0}…${y1} (${Math.round(performance.now() - t0)} ms)`)
    if (!this.selectedStructure() && found.length) this.selectedStructureKey = structureKey(found[0].structure)
    this.panel.refresh()
    this.invalidate()
  }

  // --- structure catalog (v26) ---------------------------------------------------

  // Fly the explorer to the nearest real instance of a catalog entry in the
  // world of the Map tab seed (entry.family), from the view centre and floor.
  findCatalogType(entry) {
    const seedText = this.mode === 'explore' && this.explorer?.meta.family === entry.family
      ? `#${this.explorer.seed >>> 0}`
      : this.world.seedText
    const from = {
      cx: Math.floor(this.view2d.view.cx / CHUNK_WORLD),
      cz: Math.floor(this.view2d.view.cz / CHUNK_WORLD),
      cy: this.floor,
    }
    const t0 = performance.now()
    const hit = findNearestInWorld(entry, seedText, from)
    if (!hit) {
      this.notify(`no ${entry.label} within 16 chunks and ±12 storeys of the view`, 'warn')
      return
    }
    const key = structureKey(hit.structure)
    const found = (this.structureScan.found ?? []).filter((f) => structureKey(f.structure) !== key)
    this.structureScan.found = [...found, { structure: hit.structure, seed: hit.seed, family: hit.family }]
    this.world.family = hit.family
    this._keepWorldSeed(hit.seed)
    this._openWorld(`#${hit.seed >>> 0}`, hit.family)
    if (this.mode !== 'explore') this.enterExplore()
    this.selectedStructureKey = key
    this.focusStructure(key)
    const s = hit.structure
    this.notify(`${entry.label}: #${s.id} at chunk ${s.participants[0].cx},${s.participants[0].cz} · cy ${s.baseCy}…${s.topCy} (${Math.round(performance.now() - t0)} ms)`, 'ok')
  }

  // Build one exact catalog recipe into the document at the view centre,
  // starting on the current floor (undoable).
  stampCatalogType(entry) {
    if (this.readOnly) {
      this.notify('exploring is read-only — press E to return to the document', 'warn')
      return
    }
    if (!this.map.chunks.size) {
      this.map.meta.family = entry.family
      this.world.family = entry.family
    }
    const cx0 = Math.floor(this.view2d.view.cx / CHUNK_WORLD)
    const cz0 = Math.floor(this.view2d.view.cz / CHUNK_WORLD)
    this._stampVariant = (this._stampVariant ?? 0) + 1
    const result = stampRecipeIntoDocument(this.map, entry.family, entry.type, {
      cx0, cz0, baseCy: this.floor, variant: this._stampVariant,
    })
    if (!result.ok) {
      this.notify(`stamp ${entry.label}: ${result.error}`, 'warn')
      return
    }
    const s = result.structure
    this.onDocumentChanged()
    this.selectedStructureKey = structureKey(s)
    this.focusStructure(this.selectedStructureKey)
    this.notify(`stamped ${entry.label} #${s.id}: ${s.participants.length} chunks × ${s.levelCount} storeys — undo with Ctrl/⌘+Z`, 'ok')
    if (this.review.auto) this.auditSelectedStructure()
  }

  clearStructureScan() {
    this.structureScan.found = null
    if (!this.selectedStructure()) this.selectedStructureKey = null
    this.panel.refresh()
    this.invalidate()
  }

  // Load a structure as a COMPLETE volume — every participant chunk on every
  // storey of its band, plus the context ring — in one undoable step, so no
  // slab half is ever left without its partner.
  async loadStructure(key) {
    const entry = this._structureEntry(key)
    if (!entry) return
    const { structure: s, seed, family } = entry
    const coords = structureChunkCoords(s, this.structureLoad.ring)
    this.notify(`generating #${s.id}: ${coords.length} chunks…`)
    this._updateStatus()
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
    const t0 = performance.now()
    this.map.mutate(() => {
      if (this.structureLoad.replace) this.map.clearAll()
      this.map.bakeChunks({ seed, family, coords })
    })
    this.world.family = this.map.meta.family
    this._keepWorldSeed(seed)
    this.notify(`loaded #${s.id}: ${coords.length} chunks in ${Math.round(performance.now() - t0)} ms`)
    this.selectedStructureKey = key
    if (this.mode === 'explore') this.mode = 'document'
    this.map.takeDirty()
    this.preview?.sync(null)
    this.onDocumentChanged()
    this.focusStructure(key)
    if (this.review.auto) this.auditSelectedStructure()
  }

  // Frame the plan on the structure, move into its band, cut a section
  // along its long axis through the centre and frame the 3D preview.
  focusStructure(key) {
    this.selectedStructureKey = key
    if (this.mode === 'explore') {
      const entry = this._structureEntry(key)
      if (entry && (entry.seed !== this.explorer.seed || entry.family !== this.explorer.meta.family)) {
        this._openWorld(`#${entry.seed >>> 0}`, entry.family)
        this.world.family = entry.family
      }
    }
    const s = this.selectedStructure()
    if (!s) return
    const b = s.globalBounds
    if (this.floor < s.baseCy || this.floor > s.topCy) this.floor = s.baseCy
    this.view2d.fitCells(b.x0, b.z0, b.x1, b.z1)
    const axis = s.bridgeAxis === 'z' ? 'z' : 'x'
    this.section.axis = axis
    this.section.line = axis === 'x' ? Math.floor((b.z0 + b.z1) / 2) : Math.floor((b.x0 + b.x1) / 2)
    if (!this.section.on) {
      this.section.on = true
      this._applySectionLayout()
    }
    this.preview?.setHighlight(s)
    this.preview?.frameStructure(s)
    this.preview?.onFloorChanged()
    this.panel.refresh()
    this.invalidate()
  }

  // --- review -------------------------------------------------------------------

  auditSelectedStructure() {
    const s = this.selectedStructure()
    if (!s) return
    const t0 = performance.now()
    const src = this.source
    if (src.isWorld) src.prepare(structureChunkBox(s, 0))
    const result = auditStructure(src, s)
    this.review.structure = { key: structureKey(s), result, revision: this.revision }
    this.notify(`audit #${s.id}: ${result.ok ? 'OK' : `${result.issues.length} issues`} (${Math.round(performance.now() - t0)} ms)`)
    this.panel.refresh()
    this.invalidate()
  }

  auditWholeDocument() {
    const t0 = performance.now()
    const result = auditDocument(this.map)
    this.review.doc = { result, revision: this.revision }
    this.notify(`document audit: ${result.issues.length} issues (${Math.round(performance.now() - t0)} ms)`)
    this.panel.refresh()
    this.invalidate()
  }

  diffSelectedStructure() {
    const s = this.selectedStructure()
    if (!s) return
    if (this.readOnly) {
      this.notify('drift compares a document to the generator; the explorer IS the generator')
      return
    }
    const coords = structureChunkCoords(s, this.structureLoad.ring)
    const t0 = performance.now()
    const result = diffAgainstGenerated(this.map, coords)
    this.review.diff = { key: structureKey(s), result, revision: this.revision }
    this.notify(`drift #${s.id}: ${result.cells.length} cells (${Math.round(performance.now() - t0)} ms)`)
    this.panel.refresh()
    this.invalidate()
  }

  diffWholeDocument() {
    const coords = [...this.map.chunks.values()].map((d) => ({ cx: d.cx, cy: d.cy, cz: d.cz }))
    const t0 = performance.now()
    const result = diffAgainstGenerated(this.map, coords)
    this.review.diff = { key: null, result, revision: this.revision }
    this.notify(`drift: ${result.cells.length} cells in ${result.changedChunks} chunks (${Math.round(performance.now() - t0)} ms)`)
    this.panel.refresh()
    this.invalidate()
  }

  clearReview() {
    this.review = { ...this.review, structure: null, doc: null, diff: null }
    this.panel.refresh()
    this.invalidate()
  }

  reviewIssues() {
    const out = []
    const rs = this.review.structure
    if (rs && rs.key === this.selectedStructureKey) out.push(...rs.result.issues)
    if (this.review.doc) out.push(...this.review.doc.result.issues)
    return out
  }

  // Audits are cheap next to generation, so the selected structure's review
  // stays live whenever its whole volume is in the document: after edits,
  // on selection and after a reload or import — a broken slab contract is
  // flagged on the floor where it was made. A document audit, once run, is
  // kept current too. Drift regenerates chunks, so it only goes stale.
  _scheduleReaudit() {
    if (!this.review.auto) return
    clearTimeout(this._reauditTimer)
    this._reauditTimer = setTimeout(() => {
      const s = this.selectedStructure()
      let changed = false
      if (s && structureCoverage(this.map, s).complete) {
        this.review.structure = {
          key: structureKey(s),
          result: auditStructure(this.map, s),
          revision: this.revision,
        }
        changed = true
      }
      if (this.review.doc) {
        this.review.doc = { result: auditDocument(this.map), revision: this.revision }
        changed = true
      }
      if (!changed) return
      this.panel.refresh()
      this.invalidate()
    }, REAUDIT_MS)
  }

  // --- authoring new structures ------------------------------------------------

  authorDef() {
    return TEMPLATE_DEFS.find((t) => t.id === this.author.template) ?? TEMPLATE_DEFS[0]
  }

  setAuthorTemplate(id) {
    this.author.template = id
    this.setTool(this.tools.findIndex((t) => t.id === 'author'))
  }

  planAuthor(input) {
    return planTemplate(this.map, this.author.template, input, this.floor, this.author.params)
  }

  applyAuthor(plan) {
    if (this.readOnly) return
    if (!plan?.ok) {
      this.notify(`cannot place: ${plan?.error ?? 'nothing planned'}`)
      return
    }
    const t0 = performance.now()
    const rec = applyTemplate(this.map, plan)
    this.notify(`created ${rec.label} (#${rec.id}) in ${Math.round(performance.now() - t0)} ms`)
    this.selectedStructureKey = `${rec.id}:${rec.baseCy}:${rec.topCy}`
    this.onDocumentChanged()
  }

  authoredViews() {
    const c = this._authoredCache
    if (c && c.map === this.map && c.revision === this.revision) return c.list
    const list = this.map.authored.map(authoredView)
    this._authoredCache = { map: this.map, revision: this.revision, list }
    return list
  }

  removeAuthoredById(id) {
    const rec = this.map.authored.find((r) => r.id === id)
    if (!rec) return
    removeAuthored(this.map, rec)
    if (this.selectedStructureKey?.startsWith(`${id}:`)) this.selectedStructureKey = null
    this.notify(`removed ${rec.label}`)
    this.onDocumentChanged()
  }

  // --- kind lab & lighting lab ---------------------------------------------------

  // Build a prototype map kind (editor/prototypes.js) into the document.
  generateKind(kindId, seedText) {
    if (this.mode === 'explore') this.mode = 'document'
    const t0 = performance.now()
    const res = generatePrototype(this.map, kindId, { seed: seedText })
    if (!res.ok) {
      this.notify(`kind lab: ${res.error}`)
      return
    }
    this.world.family = this.map.meta.family
    this.floor = res.spawn?.cy ?? 0
    this.selectedStructureKey = null
    const b = this.map.bounds()
    if (b) this.view2d.fitCells(b.x0 * CHUNK, b.z0 * CHUNK, (b.x1 + 1) * CHUNK - 1, (b.z1 + 1) * CHUNK - 1)
    this.map.takeDirty()
    this.preview?.sync(null)
    this.preview?.fit()
    this.lab = { kind: res.label, notes: res.notes ?? [], spawn: res.spawn ?? null }
    this.notify(`kind lab: ${res.label} (${Math.round(performance.now() - t0)} ms)${res.notes?.length ? ` · ${res.notes.join(' · ')}` : ''}`)
    this.onDocumentChanged()
    if (res.spawn) this.jumpToCell(res.spawn.gx, res.spawn.gz, res.spawn.cy, { center: false })
  }

  // Re-assign this floor's lamp failures by circuit or breaker zone.
  relight(grain) {
    if (this.readOnly) {
      this.notify('the lighting lab edits the document — bake the view first')
      return
    }
    const r = relightByCircuits(this.map, this.floor, { seed: (this.revision % 997) + 1, grain })
    if (!r) return
    this.sim.relight = { grain, ...r, cy: this.floor }
    this.sim.light = null
    this.notify(`relight (${grain}): dark ${(r.before.darkness * 100).toFixed(0)}%→${(r.after.darkness * 100).toFixed(0)}% · Moran ${r.before.clustering.toFixed(2)}→${r.after.clustering.toFixed(2)} · same ${r.budget} dead fixtures`)
    this.onDocumentChanged()
  }

  // --- explore mode (world debugger) -----------------------------------------

  _openWorld(seedText, family) {
    if (!this.explorer || !this.explorer.sameWorld(seedText, family)) {
      this.explorer = new WorldSource({ seedText, family })
      this.sim = { ...this.sim, distance: null, path: null, a: null, b: null, isovist: null, light: null, report: null }
      this.inspect = null
    }
  }

  // Browse the infinite world of the panel's seed/family, read-only. The
  // plan streams chunks as the view moves; every overlay, the section, the
  // inspector, audits and simulations read it like a document.
  enterExplore() {
    this._openWorld(this.world.seedText, this.world.family)
    const wasExplore = this.mode === 'explore'
    this.mode = 'explore'
    this.select(null)
    if (!wasExplore) this.notify(`exploring ${this.explorer.meta.name} (read-only) — E returns to the document`)
    this._previewWindow = null
    this.preview?.sync(null)
    this.preview?.fit()
    this.panel.refresh()
    this.invalidate()
  }

  exitExplore() {
    if (this.mode !== 'explore') return
    this.mode = 'document'
    this._previewWindow = null
    this.preview?.sync(null)
    this.preview?.fit()
    this.panel.refresh()
    this.invalidate()
  }

  toggleExplore() {
    if (this.mode === 'explore') this.exitExplore()
    else this.enterExplore()
  }

  // Chunk box under the plan view, clamped to at most (2r+1)² chunks.
  viewChunkBox(maxR = 4, y0 = this.floor, y1 = this.floor) {
    const v = this.view2d
    const c0x = Math.floor(v.wx(0) / CHUNK_WORLD)
    const c1x = Math.floor(v.wx(v._w) / CHUNK_WORLD)
    const c0z = Math.floor(v.wz(0) / CHUNK_WORLD)
    const c1z = Math.floor(v.wz(v._h) / CHUNK_WORLD)
    const ccx = Math.floor(v.view.cx / CHUNK_WORLD)
    const ccz = Math.floor(v.view.cz / CHUNK_WORLD)
    return {
      x0: Math.max(c0x, ccx - maxR), x1: Math.min(c1x, ccx + maxR),
      z0: Math.max(c0z, ccz - maxR), z1: Math.min(c1z, ccz + maxR),
      y0, y1,
    }
  }

  // Copy what the explorer shows (view box, current floor ±1) into the
  // document as ordinary editable chunks, then switch to editing.
  bakeViewToDocument() {
    if (!this.explorer) return
    const box = this.viewChunkBox(4, this.floor - 1, this.floor + 1)
    const coords = []
    for (let cy = box.y0; cy <= box.y1; cy++) {
      for (let cz = box.z0; cz <= box.z1; cz++) {
        for (let cx = box.x0; cx <= box.x1; cx++) coords.push({ cx, cy, cz })
      }
    }
    const t0 = performance.now()
    this.map.mutate(() => {
      if (this.structureLoad.replace) this.map.clearAll()
      this.map.bakeChunks({ seed: this.explorer.seed, family: this.explorer.meta.family, coords })
    })
    this._keepWorldSeed(this.explorer.seed)
    this.world.family = this.explorer.meta.family
    this.mode = 'document'
    this.map.takeDirty()
    this._previewWindow = null
    this.preview?.sync(null)
    this.onDocumentChanged()
    const clipped = this.clippedStructures().length
    this.notify(`baked ${coords.length} chunks into the document in ${Math.round(performance.now() - t0)} ms${clipped ? ` · ${clipped} structure volume(s) clipped` : ''}`)
  }

  // The chunk set the 3D preview meshes: the whole document, or in explore
  // mode a (2r+1)² × 5-floor window around the view, generated on demand.
  previewSource() {
    if (!this.readOnly) return this.map
    if (!this._previewWindow) {
      const v = this.view2d.view
      const cx = Math.floor(v.cx / CHUNK_WORLD)
      const cz = Math.floor(v.cz / CHUNK_WORLD)
      const box = { x0: cx - 2, x1: cx + 2, z0: cz - 2, z1: cz + 2, y0: this.floor - 2, y1: this.floor + 2 }
      this.explorer.prepare(box)
      const chunks = new Map()
      for (let cy = box.y0; cy <= box.y1; cy++) {
        for (let z = box.z0; z <= box.z1; z++) {
          for (let x = box.x0; x <= box.x1; x++) {
            const d = this.explorer.peek(x, cy, z)
            if (d) chunks.set(`${x},${cy},${z}`, d)
          }
        }
      }
      const meta = this.explorer.meta
      this._previewWindow = { chunks, meta, bounds: () => box, floors: () => [] }
    }
    return this._previewWindow
  }

  refreshPreviewWindow() {
    this._previewWindow = null
    this.preview?.sync(null)
    this.preview?.fit()
  }

  // --- inspector ----------------------------------------------------------------

  inspectAt(p, cy = this.floor) {
    this.inspect = { gx: p.gx, gz: p.gz, cy }
    this.panel.refresh()
    this.invalidate()
  }

  inspection() {
    if (!this.inspect) return null
    const { gx, gz, cy } = this.inspect
    return inspectCell(this.source, gx, cy, gz)
  }

  logInspectedChunk() {
    const info = this.inspection()
    if (!info?.chunk) return
    const payload = chunkDescriptors(info.chunk)
    window.__editorInspect = { cell: info, chunk: info.chunk, descriptors: payload }
    console.log('[editor] inspected chunk', payload, info.chunk)
    this.notify('chunk logged to the console (window.__editorInspect)')
  }

  // --- simulations ----------------------------------------------------------------

  // Box a simulation runs in: the whole document (its floors near `cy`), or
  // an explorer window around `center` generated first.
  simBox(center, cy = this.floor) {
    const floors = this.sim.floors
    if (!this.readOnly) {
      const b = this.map.bounds()
      if (!b) return null
      return { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0: Math.max(b.y0, cy - floors), y1: Math.min(b.y1, cy + floors) }
    }
    const r = this.sim.radius
    const cx = Math.floor(center.gx / CHUNK)
    const cz = Math.floor(center.gz / CHUNK)
    const box = { x0: cx - r, x1: cx + r, z0: cz - r, z1: cz + r, y0: cy - floors, y1: cy + floors }
    this.explorer.prepare(box)
    return box
  }

  _simDone(label, t0) {
    this.notify(`${label} (${Math.round(performance.now() - t0)} ms)`)
    this.panel.refresh()
    this.invalidate()
  }

  runDistance(p) {
    const t0 = performance.now()
    const start = { gx: p.gx, gz: p.gz, cy: this.floor }
    const box = this.simBox(start)
    if (!box) return
    const field = distanceField(this.source, box, start)
    if (!field.ok) {
      this.notify(`distance: ${field.reason}`)
      return
    }
    field.start = start
    field.box = box
    this.sim.distance = field
    this._simDone(`walk field: ${field.reachable} cells reachable, farthest ${field.max} cells (${(field.max * 3).toFixed(0)} m), ${field.deadEnds.length} dead ends`, t0)
  }

  runPathPoint(p) {
    const pt = { gx: p.gx, gz: p.gz, cy: this.floor }
    if (!this.sim.a || this.sim.b) {
      this.sim.a = pt
      this.sim.b = null
      this.sim.path = null
      this.notify('path: A set — click B (any floor)')
      this.panel.refresh()
      this.invalidate()
      return
    }
    this.sim.b = pt
    const t0 = performance.now()
    const a = this.sim.a
    const floors = { y0: Math.min(a.cy, pt.cy) - 1, y1: Math.max(a.cy, pt.cy) + 1 }
    let box
    if (this.readOnly) {
      const r = this.sim.radius
      const x0 = Math.floor(Math.min(a.gx, pt.gx) / CHUNK) - r
      const x1 = Math.floor(Math.max(a.gx, pt.gx) / CHUNK) + r
      const z0 = Math.floor(Math.min(a.gz, pt.gz) / CHUNK) - r
      const z1 = Math.floor(Math.max(a.gz, pt.gz) / CHUNK) + r
      box = { x0, x1, z0, z1, ...floors }
      this.explorer.prepare(box)
    } else {
      const b = this.map.bounds()
      if (!b) return
      box = { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0: Math.max(b.y0, floors.y0), y1: Math.min(b.y1, floors.y1) }
    }
    const route = shortestPath(this.source, box, a, pt)
    this.sim.path = route
    this._simDone(route.ok
      ? `path: ${route.path.length} cells, ${route.cost} walk cost, ${route.flights} flights`
      : `path: ${route.reason}`, t0)
  }

  runIsovist(p) {
    const t0 = performance.now()
    if (this.readOnly) {
      const cx = Math.floor(p.gx / CHUNK)
      const cz = Math.floor(p.gz / CHUNK)
      this.explorer.prepare({ x0: cx - 3, x1: cx + 3, z0: cz - 3, z1: cz + 3, y0: this.floor, y1: this.floor })
    }
    const iso = isovist(this.source, this.floor, p.gx, p.gz, { rays: 240, range: 36 })
    this.sim.isovist = iso
    this._simDone(`isovist: area ${iso.area.toFixed(0)} cells, deepest sightline ${iso.maxDepth.toFixed(1)} cells (${(iso.maxDepth * 3).toFixed(0)} m), mean ${iso.meanDepth.toFixed(1)}`, t0)
  }

  runLight() {
    const t0 = performance.now()
    const box = this.readOnly ? this.viewChunkBox(4) : this._documentFloorBox()
    if (!box) return
    if (this.readOnly) this.explorer.prepare(box)
    const light = lightField(this.source, box, this.floor)
    light.box = box
    this.sim.light = light
    this._simDone(`light: ${(light.darkness * 100).toFixed(0)}% of walkable cells dark · ${light.litLamps} lit / ${light.deadLamps} dead lamps`, t0)
  }

  runReport() {
    const t0 = performance.now()
    let box
    if (this.readOnly) {
      box = this.viewChunkBox(3, this.floor, this.floor)
      this.explorer.prepare(box)
    } else {
      const b = this.map.bounds()
      if (!b) return
      box = { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0: b.y0, y1: b.y1 }
    }
    this.sim.report = liminalReport(this.source, box)
    this._simDone(`liminal report: ${this.sim.report.floors.length} floor(s)`, t0)
  }

  _documentFloorBox() {
    const b = this.map.bounds()
    if (!b) return null
    return { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0: this.floor, y1: this.floor }
  }

  clearSim() {
    this.sim = { ...this.sim, distance: null, path: null, a: null, b: null, isovist: null, light: null, report: null }
    this.panel.refresh()
    this.invalidate()
  }

  onProbe(p) {
    const mode = this.sim.probe
    if (mode === 'distance') this.runDistance(p)
    else if (mode === 'path') this.runPathPoint(p)
    else if (mode === 'isovist') this.runIsovist(p)
    else this.inspectAt(p)
  }

  // --- document lifecycle ---------------------------------------------------

  newMap() {
    this.map = new EditorMap()
    this._documentReplaced()
    this.floor = 0
    this.selectedStructureKey = null
    this.select(null)
    try { localStorage.removeItem(AUTOSAVE_KEY) } catch { /* ignore */ }
    this.preview?.sync(null)
    this.preview?.setHighlight(null)
    this.onDocumentChanged()
  }

  bakeWorld() {
    const { seedText, family, radius, baseFloor, floors } = this.world
    const center = {
      cx: Math.floor(this.view2d.view.cx / CHUNK_WORLD),
      cz: Math.floor(this.view2d.view.cz / CHUNK_WORLD),
    }
    this.bake({
      seedText,
      family,
      radius,
      center,
      floors: Array.from({ length: floors }, (_, i) => baseFloor + i),
    })
  }

  bake(opts) {
    const t0 = performance.now()
    this.map.bakeProcedural(opts)
    this.world.family = this.map.meta.family
    this.floor = opts.floors?.[0] ?? 0
    this.select(null)
    const c = opts.center ?? { cx: 0, cz: 0 }
    this.view2d.centerOn((c.cx + 0.5) * CHUNK_WORLD, (c.cz + 0.5) * CHUNK_WORLD)
    this.map.takeDirty()
    this.preview?.sync(null)
    this.preview?.fit()
    this.onDocumentChanged()
    const clipped = this.clippedStructures().length
    this.notify(`generated in ${Math.round(performance.now() - t0)} ms${clipped ? ` · ${clipped} structure volume(s) clipped — load them from the structures section` : ''}`)
  }

  // 3D preview look: 'geometry' or a look profile id (see Preview3D).
  setPreviewMode(mode) {
    this.previewMode = mode
    this.preview?.setMode(mode)
  }

  setPreviewClip(clip) {
    this.previewClip = clip
    this.preview?.setClip(clip)
    this.panel.refresh()
  }

  setPreview(on) {
    if (on && !this.preview) {
      this.view2d.canvas.style.display = 'none'
      this.preview = new Preview3D(this, this.planEl)
      this.map.takeDirty()
      if (this.previewMode) this.preview.setMode(this.previewMode)
      if (!this.previewCeiling) this.preview.setCeiling(false)
      this.preview.sync(null)
      this.preview.fit()
      const s = this.selectedStructure()
      if (s) {
        this.preview.setHighlight(s)
        this.preview.frameStructure(s)
      }
    } else if (!on && this.preview) {
      this.preview.dispose()
      this.preview = null
      this.view2d.canvas.style.display = ''
      this.invalidate()
    }
    this.panel.refresh()
  }

  async exportMap() {
    const bytes = await encodeMapFile(this.map)
    const name = (this.map.meta.name || 'untitled').replace(/[^\w.-]+/g, '_')
    const blob = new Blob([bytes], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}.yrmap`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  importMap() {
    this._fileInput.click()
  }

  async _loadFile(file) {
    try {
      this._adoptMap(await decodeMapFile(await file.arrayBuffer()))
      this._scheduleAutosave()
    } catch (err) {
      this.notify(`import failed: ${err.message}`)
      console.error(err)
    }
  }

  // --- input ----------------------------------------------------------------

  // One dispatcher over the keymap registry (ui/keymap.js): the same table
  // feeds the help sheet, the tooltips' shortcut chips and the palette.
  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (this.ui?.modalOpen()) return
      const chord = chordOf(e)
      if (!chord) return
      const cmd = commandForChord(chord, this)
      if (!cmd) return
      const t = e.target
      const inField = isTextField(t)
      if (inField && !cmd.fieldSafe) return
      if (inField && cmd.id === 'ui.escape') {
        t.blur()
        return
      }
      // Arrow / Home / End keys belong to a focused slider or select.
      if (t?.tagName === 'INPUT' && t.type === 'range' && /^(Arrow|Home$|End$|Page)/.test(e.key)) return
      if (cmd.idleFocus) {
        const a = document.activeElement
        const idle = (a === this.viewportEl && this._planPointerFocus) || (a?.tagName === 'CANVAS' && this.viewportEl.contains(a))
        if (!idle) return
      }
      // WCAG 2.1.4: single-character shortcuts can be limited to the plan /
      // tool rail (View tab → “single-key shortcuts anywhere”).
      if (isSingleCharChord(chord) && this.ui?.singleKeysAnywhere === false) {
        const a = document.activeElement
        const onPlan = !!a && (a === this.viewportEl || this.viewportEl.contains(a) || !!a.closest?.('.edt-rail'))
        if (!onPlan) return
      }
      // Buttons keep their own Enter / Space; everything else is ours.
      e.preventDefault()
      runCommand(cmd, this)
    })
    window.addEventListener('resize', () => {
      this.view2d.resize()
      this.preview?.resize()
    })
  }

  _bindDrop() {
    this.viewportEl.addEventListener('dragover', (e) => e.preventDefault())
    this.viewportEl.addEventListener('drop', (e) => {
      e.preventDefault()
      const f = e.dataTransfer?.files?.[0]
      if (f?.name.endsWith('.yrmap')) {
        if (this.ui?.confirmImportFile) this.ui.confirmImportFile(f)
        else this._loadFile(f)
      } else if (f) this.notify(`import: ${f.name} is not a .yrmap file`, 'warn')
    })
  }
}
