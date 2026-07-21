import { EditorMap } from './EditorMap.js'
import { decodeMapFile, encodeMapFile } from './format/yrmap.js'
import { regenerateRoom, removeRoom } from './roomBuilder.js'
import { MapView2D } from './ui/MapView2D.js'
import { Preview3D } from './ui/Preview3D.js'
import { buildPanel, FURN_NAMES } from './ui/panel.js'
import { injectEditorStyle } from './ui/style.js'
import { createTools } from './ui/tools.js'
import { roomRoleLabel } from '../debug/mapInspect.js'
import { CELL, CHUNK_WORLD } from '../world/constants.js'

const KIND_LABEL = ['open', 'room', 'corridor', 'lobby', 'stair', 'atrium', 'void', 'bridge']
const FACING_LABEL = ['+z', '−z', '+x', '−x']
const AUTOSAVE_KEY = 'yr-editor-autosave-v1'

// The editor application: owns the document, viewport(s), panel, tools,
// selection and file I/O. Everything mutates through EditorMap.mutate so the
// whole session is undoable.
export class EditorApp {
  constructor(root) {
    injectEditorStyle()
    this.map = new EditorMap()
    this.floor = 0
    this.selection = null
    this.preview = null
    this._needsDraw = true

    this.viewportEl = document.createElement('div')
    this.viewportEl.className = 'edt-viewport'
    this.tools = createTools(this)
    this.tool = this.tools[0]
    this.view2d = new MapView2D(this, this.viewportEl)
    this.panel = buildPanel(this)
    root.appendChild(this.panel.el)
    root.appendChild(this.viewportEl)

    this.statusEl = document.createElement('div')
    this.statusEl.className = 'edt-status'
    this.viewportEl.appendChild(this.statusEl)
    this.helpEl = document.createElement('div')
    this.helpEl.className = 'edt-help'
    this.viewportEl.appendChild(this.helpEl)

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

    this._bindKeys()
    this._bindDrop()
    this.panel.refresh()
    this._restoreAutosave()
    requestAnimationFrame(this._frame)
  }

  // --- frame loop -----------------------------------------------------------

  _frame = () => {
    if (this.preview) {
      const dirty = this.map.takeDirty()
      if (dirty.size) this.preview.sync(dirty)
      this.preview.render()
    } else if (this._needsDraw) {
      this._needsDraw = false
      this.view2d.draw()
    }
    this._updateStatus()
    requestAnimationFrame(this._frame)
  }

  invalidate() {
    this._needsDraw = true
  }

  onDocumentChanged() {
    this.invalidate()
    this.panel.refresh()
    this._scheduleAutosave()
  }

  // --- autosave (page reloads must never lose work) --------------------------

  _scheduleAutosave() {
    clearTimeout(this._autosaveTimer)
    this._autosaveTimer = setTimeout(() => this._autosave(), 800)
  }

  async _autosave() {
    try {
      const bytes = await encodeMapFile(this.map)
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      }
      localStorage.setItem(AUTOSAVE_KEY, btoa(bin))
    } catch {
      // Storage quota / private mode — the explicit export path still works.
    }
  }

  async _restoreAutosave() {
    try {
      const b64 = localStorage.getItem(AUTOSAVE_KEY)
      if (!b64) return
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const map = await decodeMapFile(bytes)
      this.map = map
      this.floor = map.floors()[0] ?? 0
      const b = map.bounds()
      if (b) {
        this.view2d.centerOn(
          ((b.x0 + b.x1 + 1) / 2) * CHUNK_WORLD,
          ((b.z0 + b.z1 + 1) / 2) * CHUNK_WORLD
        )
      }
      this.invalidate()
      this.panel.refresh()
    } catch {
      // Corrupt/old autosave — start fresh rather than blocking boot.
    }
  }

  _updateStatus() {
    const h = this.view2d.hover
    let text = `tool: ${this.tool.id}`
    if (h && !this.preview) {
      const c = this.map.cellAt(h.gx, this.floor, h.gz)
      const bits = [`cell ${h.gx},${h.gz}`, `f${this.floor}`, KIND_LABEL[c.kind] ?? '?']
      if (c.role) bits.push(roomRoleLabel(c.role))
      const room = this.map.roomAt(h.gx, this.floor, h.gz)
      if (room) bits.push(`room #${room.id}`)
      text = `${bits.join(' · ')}\n${this.tool.status ?? ''}`
    } else if (this.preview) {
      text = 'drag: orbit · RMB: pan · wheel: zoom'
    }
    if (this.statusEl.textContent !== text) this.statusEl.textContent = text
  }

  // --- tools & selection ----------------------------------------------------

  setTool(i) {
    this.tool = this.tools[i] ?? this.tools[0]
    this.panel.refresh()
    this.invalidate()
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

  setFloor(cy) {
    this.floor = cy
    if (this.preview) this.preview.fit()
    this.onDocumentChanged()
  }

  // --- document lifecycle ---------------------------------------------------

  newMap() {
    this.map = new EditorMap()
    this.floor = 0
    this.select(null)
    try { localStorage.removeItem(AUTOSAVE_KEY) } catch { /* ignore */ }
    this.preview?.sync(null)
    this.onDocumentChanged()
  }

  bake(opts) {
    this.map.bakeProcedural(opts)
    this.floor = 0
    this.select(null)
    this.view2d.centerOn(CHUNK_WORLD / 2, CHUNK_WORLD / 2)
    this.map.takeDirty()
    this.preview?.sync(null)
    this.preview?.fit()
    this.onDocumentChanged()
  }

  setPreview(on) {
    if (on && !this.preview) {
      this.view2d.canvas.style.display = 'none'
      this.preview = new Preview3D(this, this.viewportEl)
      this.map.takeDirty()
      this.preview.sync(null)
      this.preview.fit()
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
      const map = await decodeMapFile(await file.arrayBuffer())
      this.map = map
      this.floor = map.floors()[0] ?? 0
      this.select(null)
      const b = map.bounds()
      if (b) {
        this.view2d.centerOn(
          ((b.x0 + b.x1 + 1) / 2) * CHUNK_WORLD,
          ((b.z0 + b.z1 + 1) / 2) * CHUNK_WORLD
        )
      }
      this.map.takeDirty()
      this.preview?.sync(null)
      this.preview?.fit()
      this.onDocumentChanged()
    } catch (err) {
      this.statusEl.textContent = `import failed: ${err.message}`
      console.error(err)
    }
  }

  // --- input ----------------------------------------------------------------

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      const t = e.target
      if (t && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey ? this.map.redo() : this.map.undo()) this.onDocumentChanged()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        if (this.map.redo()) this.onDocumentChanged()
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        this.setPreview(!this.preview)
        return
      }
      if (e.key >= '1' && e.key <= String(this.tools.length)) {
        this.setTool(Number(e.key) - 1)
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        this.deleteSelection()
        return
      }
      if (e.key === 'PageUp') { e.preventDefault(); this.setFloor(this.floor + 1); return }
      if (e.key === 'PageDown') { e.preventDefault(); this.setFloor(this.floor - 1); return }
      if (e.key === 'Escape') { this.select(null); return }
      if (this.tool.onKey?.(e)) { this.panel.refresh(); return }
      if (e.key === 'r' || e.key === 'R') this.rotateSelection()
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
      if (f?.name.endsWith('.yrmap')) this._loadFile(f)
    })
  }
}
