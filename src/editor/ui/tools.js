import { CELL } from '../../world/constants.js'
import {
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  PASSAGE_DOOR,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  SPACE_ROLE_NONE,
  WALL_PLAIN,
  WALL_RAIL,
  WALL_WINDOW,
} from '../../world/mapTypes.js'
import { PIECE_DIMS } from '../../world/rooms/furnish.js'
import { createRoom } from '../roomBuilder.js'

// Editor tools: pointer-mode strategy objects. Each gets the app and receives
// picked positions ({wx, wz, gx, gz, edge}) from the viewport; drawing an
// in-progress gesture happens in drawOverlay(ctx2d, view).

// Walk from the previous pointer sample to the current one in sub-cell steps
// so a fast drag paints a continuous stroke instead of scattered samples.
function strokePoints(view, prev, p, step = CELL * 0.45) {
  if (!prev) return [p]
  const dx = p.wx - prev.wx
  const dz = p.wz - prev.wz
  const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / step))
  const out = []
  for (let i = 1; i <= n; i++) {
    out.push(view.pickAt(prev.wx + (dx * i) / n, prev.wz + (dz * i) / n))
  }
  return out
}

// --- select / move ----------------------------------------------------------

export class SelectTool {
  constructor(app) {
    this.app = app
    this.id = 'select'
    this.status = 'click: select · drag: move object · R rotate · Del delete'
    this._drag = null
  }

  onDown(p) {
    const { app } = this
    const cy = app.floor
    // Exploring the generated world is read-only: selection inspects.
    if (app.readOnly) {
      app.inspectAt(p)
      return
    }
    if (app.map.furnitureAt(p.gx, cy, p.gz)) {
      app.select({ type: 'furniture', gx: p.gx, gz: p.gz, cy })
      this._drag = { from: { gx: p.gx, gz: p.gz }, moved: false }
      app.map.beginOp()
    } else if (app.map.lampAt(p.gx, cy, p.gz)) {
      app.select({ type: 'lamp', gx: p.gx, gz: p.gz, cy })
      this._drag = { from: { gx: p.gx, gz: p.gz }, moved: false, lamp: true }
      app.map.beginOp()
    } else {
      const room = app.map.roomAt(p.gx, cy, p.gz)
      app.select(room ? { type: 'room', id: room.id } : null)
    }
  }

  onMove(p, e) {
    if (!this._drag || !(e.buttons & 1)) return
    const { from } = this._drag
    if (p.gx === from.gx && p.gz === from.gz) return
    const { app } = this
    const cy = app.floor
    app.map.mutate(() => {
      if (this._drag.lamp) {
        const lamp = app.map.lampAt(from.gx, cy, from.gz)
        if (lamp && !app.map.lampAt(p.gx, cy, p.gz) && !app.guardCeiling(p.gx, cy, p.gz)) {
          app.map.setLamp(from.gx, cy, from.gz, null)
          app.map.setLamp(p.gx, cy, p.gz, lamp.rec.lit)
          from.gx = p.gx; from.gz = p.gz
          this._drag.moved = true
        }
      } else if (app.guardCell(p.gx, cy, p.gz, 'move furniture')) {
        // Refused (reason already shown in the status line).
      } else if (app.map.moveFurniture(from.gx, cy, from.gz, p.gx, p.gz)) {
        from.gx = p.gx; from.gz = p.gz
        this._drag.moved = true
      }
    })
    app.select({ ...app.selection, gx: from.gx, gz: from.gz })
  }

  onUp() {
    this.onCancel()
  }

  onCancel() {
    if (!this._drag) return
    const moved = this._drag.moved
    this._drag = null
    this.app.map.endOp()
    if (moved) this.app.onDocumentChanged()
  }
}

// --- wall pen ---------------------------------------------------------------

export const WALL_MODES = [
  { key: 'wall', label: 'wall', apply: [1, PASSAGE_WALL, WALL_PLAIN] },
  { key: 'door', label: 'door', apply: [0, PASSAGE_DOOR, WALL_PLAIN] },
  { key: 'wide', label: 'wide', apply: [0, PASSAGE_WIDE, WALL_PLAIN] },
  { key: 'window', label: 'window', apply: [1, PASSAGE_WALL, WALL_WINDOW] },
  { key: 'rail', label: 'rail', apply: [1, PASSAGE_WALL, WALL_RAIL] },
  { key: 'open', label: 'erase', apply: [0, PASSAGE_OPEN, WALL_PLAIN] },
]

export class WallTool {
  constructor(app) {
    this.app = app
    this.id = 'wall'
    this.edits = true
    this.mode = 0
    this.status = 'click an edge · or drag along grid lines to draw a run'
    this._down = false
  }

  _applyEdge(axis, gx, gz) {
    const [wall, passage, feature] = WALL_MODES[this.mode].apply
    const { app } = this
    if (app.guardEdge(axis, gx, gz, app.floor)) return
    if (axis === 'v') app.map.setWallV(gx, app.floor, gz, wall, passage, feature)
    else app.map.setWallH(gx, app.floor, gz, wall, passage, feature)
    this._placed = true
    app.invalidate()
  }

  // A drag follows the grid: pointer samples snap to the nearest grid VERTEX
  // and every vertex step lays the wall edge walked over, so the stroke is a
  // continuous run in the drag direction (never perpendicular tick marks).
  _vertexOf(p) {
    return { vx: Math.round(p.wx / CELL), vz: Math.round(p.wz / CELL) }
  }

  _walkTo(v) {
    let { vx, vz } = this._v
    while (vx !== v.vx || vz !== v.vz) {
      if (vx !== v.vx) {
        const sx = Math.sign(v.vx - vx)
        this._applyEdge('h', sx > 0 ? vx : vx - 1, vz)
        vx += sx
      } else {
        const sz = Math.sign(v.vz - vz)
        this._applyEdge('v', vx, sz > 0 ? vz : vz - 1)
        vz += sz
      }
    }
    this._v = { vx, vz }
  }

  onDown(p) {
    this._down = true
    this._placed = false
    this._clickEdge = p.edge
    this._v = this._vertexOf(p)
    this.app.map.beginOp()
  }

  onMove(p, e) {
    if (!this._down || !(e.buttons & 1)) return
    for (const q of strokePoints(this.app.view2d, this._prev ?? p, p)) this._walkTo(this._vertexOf(q))
    this._prev = p
  }

  onUp() {
    // A plain click (no vertex walked) toggles the edge under the cursor.
    if (this._down && !this._placed && this._clickEdge) {
      const { axis, gx, gz } = this._clickEdge
      this._applyEdge(axis, gx, gz)
    }
    this.onCancel()
  }

  onCancel() {
    if (!this._down) return
    this._down = false
    this._prev = null
    this._clickEdge = null
    this.app.map.endOp()
    this.app.onDocumentChanged()
  }

  drawOverlay(g, view) {
    const p = view.hover
    if (!p?.edge) return
    const s = view.view.scale
    g.strokeStyle = 'rgba(255,240,180,0.9)'
    g.lineWidth = Math.max(2, s * 0.2)
    g.beginPath()
    if (p.edge.axis === 'v') {
      const x = view.sx(p.edge.gx * CELL)
      g.moveTo(x, view.sy(p.edge.gz * CELL))
      g.lineTo(x, view.sy((p.edge.gz + 1) * CELL))
    } else {
      const y = view.sy(p.edge.gz * CELL)
      g.moveTo(view.sx(p.edge.gx * CELL), y)
      g.lineTo(view.sx((p.edge.gx + 1) * CELL), y)
    }
    g.stroke()
  }
}

// --- room area --------------------------------------------------------------

export class RoomTool {
  constructor(app) {
    this.app = app
    this.id = 'room'
    this.edits = true
    this.role = SPACE_ROLE_NONE
    this.withLamp = true
    this.status = 'drag an area, release to generate the room'
    this._start = null
    this._end = null
  }

  onDown(p) { this._start = { gx: p.gx, gz: p.gz }; this._end = this._start }
  onMove(p, e) { if (this._start && (e.buttons & 1)) this._end = { gx: p.gx, gz: p.gz } }
  onCancel() { this._start = this._end = null }

  onUp(p) {
    if (!this._start) return
    const a = this._start
    const b = { gx: p.gx, gz: p.gz }
    this._start = this._end = null
    const rect = {
      x0: Math.min(a.gx, b.gx), z0: Math.min(a.gz, b.gz),
      x1: Math.max(a.gx, b.gx), z1: Math.max(a.gz, b.gz),
    }
    if (this.app.guardRect(rect, this.app.floor)) return
    const room = createRoom(this.app.map, {
      cy: this.app.floor,
      ...rect,
      role: this.role,
      lamp: this.withLamp,
    })
    this.app.select({ type: 'room', id: room.id })
    this.app.onDocumentChanged()
  }

  drawOverlay(g, view) {
    if (!this._start) return
    const a = this._start, b = this._end
    const x0 = Math.min(a.gx, b.gx), x1 = Math.max(a.gx, b.gx)
    const z0 = Math.min(a.gz, b.gz), z1 = Math.max(a.gz, b.gz)
    const s = view.view.scale
    g.fillStyle = 'rgba(205,191,110,0.15)'
    g.strokeStyle = '#cdbf6e'
    g.lineWidth = 1.5
    const x = view.sx(x0 * CELL), y = view.sy(z0 * CELL)
    g.fillRect(x, y, (x1 - x0 + 1) * CELL * s, (z1 - z0 + 1) * CELL * s)
    g.strokeRect(x, y, (x1 - x0 + 1) * CELL * s, (z1 - z0 + 1) * CELL * s)
  }
}

// --- cell paint -------------------------------------------------------------

export const CELL_MODES = [
  { key: 'open', label: 'open', kind: CELL_OPEN },
  { key: 'corridor', label: 'corridor', kind: CELL_CORRIDOR },
  { key: 'lobby', label: 'lobby', kind: CELL_LOBBY },
]

export class CellTool {
  constructor(app) {
    this.app = app
    this.id = 'cell'
    this.edits = true
    this.mode = 1
    this.status = 'paint cell kinds (rooms come from the room tool)'
    this._down = false
  }

  _apply(p) {
    const kind = CELL_MODES[this.mode].kind
    if (this.app.guardCell(p.gx, this.app.floor, p.gz, 'paint')) return
    this.app.map.setCell(p.gx, this.app.floor, p.gz, {
      kind, ...(kind === CELL_OPEN ? { spaceId: 0, role: SPACE_ROLE_NONE } : {}),
    })
    this.app.invalidate()
  }

  onDown(p) { this._down = true; this._prev = p; this.app.map.beginOp(); this._apply(p) }

  onMove(p, e) {
    if (!this._down || !(e.buttons & 1)) return
    for (const q of strokePoints(this.app.view2d, this._prev, p)) this._apply(q)
    this._prev = p
  }

  onUp() { this.onCancel() }

  onCancel() {
    if (!this._down) return
    this._down = false
    this._prev = null
    this.app.map.endOp()
    this.app.onDocumentChanged()
  }
}

// --- object placer ----------------------------------------------------------

export class ObjectTool {
  constructor(app) {
    this.app = app
    this.id = 'object'
    this.edits = true
    this.kind = 1 // FURN_DESK
    this.facing = 0
    this.status = 'click a free cell to place · R turns the piece first'
    this.statusExtra = ''
  }

  onDown(p) {
    const { app } = this
    const cy = app.floor
    if (app.map.cellAt(p.gx, cy, p.gz).col) return
    if (app.guardCell(p.gx, cy, p.gz, 'place furniture')) return
    const [w0, d0] = PIECE_DIMS[this.kind] ?? [1, 1]
    const alongX = this.facing === 2 || this.facing === 3
    app.map.mutate(() => {
      app.map.addFurniture(p.gx, cy, p.gz, {
        kind: this.kind,
        x: (app.map.cellLocal(p.gx) + 0.5) * CELL,
        z: (app.map.cellLocal(p.gz) + 0.5) * CELL,
        w: alongX ? d0 : w0,
        d: alongX ? w0 : d0,
        facing: this.facing,
      })
    })
    app.select({ type: 'furniture', gx: p.gx, gz: p.gz, cy })
    app.onDocumentChanged()
  }

  // R (keymap `object.turn`): 90° steps through the DIR set.
  turn() {
    const CYCLE = { 0: 3, 3: 1, 1: 2, 2: 0 }
    this.facing = CYCLE[this.facing] ?? 0
  }
}

// --- lamp -------------------------------------------------------------------

export class LampTool {
  constructor(app) {
    this.app = app
    this.id = 'lamp'
    this.edits = true
    this.status = 'click cycles: none → lit → dead → none'
  }

  onDown(p) {
    const { app } = this
    const cy = app.floor
    const lamp = app.map.lampAt(p.gx, cy, p.gz)
    if (!lamp && app.guardCeiling(p.gx, cy, p.gz)) return
    app.map.mutate(() => {
      if (!lamp) app.map.setLamp(p.gx, cy, p.gz, true)
      else if (lamp.rec.lit) app.map.setLamp(p.gx, cy, p.gz, false)
      else app.map.setLamp(p.gx, cy, p.gz, null)
    })
    app.onDocumentChanged()
  }
}

// --- eraser -----------------------------------------------------------------

export class EraseTool {
  constructor(app) {
    this.app = app
    this.id = 'erase'
    this.edits = true
    this.status = 'drag: clears objects, labels and the cell’s edges'
    this._down = false
  }

  _apply(p) {
    const { app } = this
    const cy = app.floor
    app.map.removeFurniture(p.gx, cy, p.gz)
    if (app.map.lampAt(p.gx, cy, p.gz)) app.map.setLamp(p.gx, cy, p.gz, null)
    // Structure-owned cells and their guard edges survive the eraser while
    // protection is on; ordinary edges around them still clear.
    if (!app.guardCell(p.gx, cy, p.gz, 'erase')) {
      app.map.setCell(p.gx, cy, p.gz, { kind: CELL_OPEN, spaceId: 0, role: SPACE_ROLE_NONE, col: 0 })
    }
    const edges = [['v', p.gx, p.gz], ['v', p.gx + 1, p.gz], ['h', p.gx, p.gz], ['h', p.gx, p.gz + 1]]
    for (const [axis, gx, gz] of edges) {
      if (app.guardEdge(axis, gx, gz, cy)) continue
      if (axis === 'v') app.map.setWallV(gx, cy, gz, 0, PASSAGE_OPEN)
      else app.map.setWallH(gx, cy, gz, 0, PASSAGE_OPEN)
    }
    app.invalidate()
  }

  onDown(p) { this._down = true; this._prev = p; this.app.map.beginOp(); this._apply(p) }

  onMove(p, e) {
    if (!this._down || !(e.buttons & 1)) return
    for (const q of strokePoints(this.app.view2d, this._prev, p)) this._apply(q)
    this._prev = p
  }

  onUp() { this.onCancel() }

  onCancel() {
    if (!this._down) return
    this._down = false
    this._prev = null
    this.app.map.endOp()
    this.app.onDocumentChanged()
  }
}

// --- section cut --------------------------------------------------------------

// Click sets the vertical cross-section through the clicked row (cut along x)
// or column (cut along z). X swaps the axis through the hovered cell; F lets
// the cut follow the cursor while hovering.
export class SectionTool {
  constructor(app) {
    this.app = app
    this.id = 'section'
    this.status = 'click: cut here · X: swap axis · F: follow cursor'
  }

  onDown(p) {
    this.app.setSectionLine(p)
  }

  // X / F are keymap commands scoped to this tool (section.swap /
  // section.follow in ui/keymap.js).

  drawOverlay(g, view) {
    const p = view.hover
    if (!p) return
    const s = view.view.scale
    g.fillStyle = 'rgba(120,200,255,0.10)'
    if (this.app.section.axis === 'x') {
      g.fillRect(0, view.sy(p.gz * CELL), view._w, CELL * s)
    } else {
      g.fillRect(view.sx(p.gx * CELL), 0, CELL * s, view._h)
    }
  }
}

// --- probe (debugger) ---------------------------------------------------------

// Click a cell to run the simulation chosen in the panel: inspect (pin the
// cell in the inspector), walk-distance field, A→B path (two clicks, any
// floors) or isovist. Works on the document and on the live world.
export class ProbeTool {
  constructor(app) {
    this.app = app
    this.id = 'probe'
  }

  get status() {
    const mode = this.app.sim.probe
    if (mode === 'path') return this.app.sim.a && !this.app.sim.b ? 'path: click B (change floor first for a vertical route)' : 'path: click A'
    if (mode === 'distance') return 'click: walk-distance field from this cell'
    if (mode === 'isovist') return 'click: isovist (what is visible from this cell)'
    return 'click: pin this cell in the inspector'
  }

  onDown(p) {
    this.app.onProbe(p)
  }
}

// --- author (new structures) ----------------------------------------------------

// Place a structure template (see editor/templates.js). Rectangle templates
// are dragged; the stairwell is clicked at its first landing. The preview is
// the real plan: green with the structure's label when it would apply, red
// with the refusing contract otherwise.
export class AuthorTool {
  constructor(app) {
    this.app = app
    this.id = 'author'
    this.edits = true
    this._start = null
    this._end = null
    this._plan = null
    this._planKey = ''
  }

  get status() {
    const def = this.app.authorDef()
    return def.input === 'point'
      ? `click: place ${def.label} (first landing)`
      : `drag: footprint of ${def.label}`
  }

  _input(p) {
    const def = this.app.authorDef()
    if (def.input === 'point') return { gx: p.gx, gz: p.gz }
    const a = this._start ?? p
    const b = this._end ?? p
    return { x0: Math.min(a.gx, b.gx), z0: Math.min(a.gz, b.gz), x1: Math.max(a.gx, b.gx), z1: Math.max(a.gz, b.gz) }
  }

  _replan(p) {
    const input = this._input(p)
    const key = `${this.app.author.template}:${JSON.stringify(input)}:${this.app.floor}:${JSON.stringify(this.app.author.params)}:${this.app.revision}`
    if (key === this._planKey) return
    this._planKey = key
    this._plan = this.app.planAuthor(input)
  }

  onDown(p) {
    if (this.app.authorDef().input === 'point') {
      this._replan(p)
      this.app.applyAuthor(this._plan)
      this._planKey = ''
      return
    }
    this._start = { gx: p.gx, gz: p.gz }
    this._end = this._start
    this._replan(p)
  }

  onMove(p, e) {
    if (this._start && (e.buttons & 1)) {
      this._end = { gx: p.gx, gz: p.gz }
      this._replan(p)
    } else if (!this._start && this.app.authorDef().input === 'point') {
      this._replan(p)
    }
  }

  onUp(p) {
    if (!this._start) return
    this._end = { gx: p.gx, gz: p.gz }
    this._replan(p)
    const plan = this._plan
    this._start = this._end = null
    this._planKey = ''
    this._plan = null
    this.app.applyAuthor(plan)
  }

  onCancel() {
    this._start = this._end = null
    this._plan = null
    this._planKey = ''
  }

  drawOverlay(g, view) {
    const plan = this._plan
    if (!plan) return
    const s = view.view.scale
    const def = this.app.authorDef()
    const rect = plan.ok ? plan.bounds : def.input === 'point' ? null : this._input(view.hover ?? {})
    const ok = plan.ok
    g.lineWidth = 2
    g.strokeStyle = ok ? 'rgba(120,255,160,0.95)' : 'rgba(255,90,80,0.95)'
    g.fillStyle = ok ? 'rgba(120,255,160,0.12)' : 'rgba(255,90,80,0.12)'
    if (rect && Number.isFinite(rect.x0)) {
      const x = view.sx(rect.x0 * CELL)
      const y = view.sy(rect.z0 * CELL)
      const w = (rect.x1 - rect.x0 + 1) * CELL * s
      const h = (rect.z1 - rect.z0 + 1) * CELL * s
      g.fillRect(x, y, w, h)
      g.strokeRect(x, y, w, h)
    }
    // Footprints of the individual parts.
    if (ok) {
      g.setLineDash([4, 3])
      for (const part of plan.parts) {
        const b = part.type === 'atrium' ? part.descriptor.globalBounds
          : part.type === 'stairwell' ? part.plan.globalCore
            : part.type === 'wing' ? part.corridor : null
        if (!b) continue
        g.strokeRect(view.sx(b.x0 * CELL), view.sy(b.z0 * CELL), (b.x1 - b.x0 + 1) * CELL * s, (b.z1 - b.z0 + 1) * CELL * s)
      }
      g.setLineDash([])
    }
    const hv = view.hover
    if (hv) {
      const text = ok ? `${plan.label} · cy ${plan.baseCy}…${plan.topCy}` : plan.error
      g.font = '12px ui-monospace, monospace'
      const x = view.sx((hv.gx + 1) * CELL) + 8
      const y = view.sy(hv.gz * CELL) - 8
      g.fillStyle = 'rgba(13,13,9,0.85)'
      g.fillRect(x - 4, y - 13, g.measureText(text).width + 8, 18)
      g.fillStyle = ok ? '#9fffb8' : '#ff9a90'
      g.fillText(text, x, y)
    }
  }
}

export function createTools(app) {
  return [
    new SelectTool(app),
    new RoomTool(app),
    new WallTool(app),
    new CellTool(app),
    new ObjectTool(app),
    new LampTool(app),
    new EraseTool(app),
    new SectionTool(app),
    new ProbeTool(app),
    new AuthorTool(app),
  ]
}
