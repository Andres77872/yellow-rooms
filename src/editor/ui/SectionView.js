import {
  BRIDGE_GUARD_H,
  CELL,
  CHUNK,
  DOOR_H,
  LAYER_H,
  SLAB_T,
  WALL_H,
  WINDOW_HEAD_Y,
  WINDOW_SILL_H,
  cIdx,
  layerY,
} from '../../world/constants.js'
import {
  CELL_OPEN,
  CELL_ROOM,
  COLUMN_FURNITURE,
  COLUMN_MONUMENTAL,
  PASSAGE_DOOR,
  WALL_RAIL,
  WALL_WINDOW,
} from '../../world/mapTypes.js'
import { STAIR_DX, STAIR_DZ } from '../../world/structures/slab.js'
import { structureFamily } from '../../world/structures/contract.js'
import { STRUCTURE_FAMILY_COLORS } from '../../debug/mapInspect.js'
import { holeMasks } from '../holeMasks.js'
import { KIND_FILL, roleFill } from './MapView2D.js'

// Vertical cross-section of the layered document: the one view in which a
// tall structure reads as the object it is. A cut runs along a grid row
// (axis 'x', fixed gz) or column (axis 'z', fixed gx) through every stored
// floor at true proportion — cells CELL wide, storeys LAYER_H tall with a
// SLAB_T slab — and shares the plan's horizontal zoom and centre, so an
// x-axis section sits directly under the plan columns it cuts.
//
// Drawn per storey: room tint, the floor slab (absent over openings, red
// over lethal drops, with a tick at the death plane), walls crossing the cut
// at their real heights (full wall, window sill/head, guard rail, door
// lintel), columns, furniture boxes, ceiling lamps, and stair flights as
// ramps between the two floors they join. The selected structure's volume
// is outlined across its band.

const GUTTER = 58
const PAD = 14

export class SectionView {
  constructor(app, container) {
    this.app = app
    this.root = document.createElement('div')
    this.root.className = 'edt-section'
    container.appendChild(this.root)

    this.handle = document.createElement('div')
    this.handle.className = 'edt-section-handle'
    this.handle.setAttribute('role', 'separator')
    this.handle.setAttribute('aria-orientation', 'horizontal')
    this.handle.setAttribute('aria-label', 'Resize the section dock')
    // A focusable separator needs a value (percent of the viewport height).
    this.handle.setAttribute('aria-valuemin', '15')
    this.handle.setAttribute('aria-valuemax', '80')
    this.handle.setAttribute('aria-valuenow', String(Math.round((app.section?.height ?? 0.36) * 100)))
    this.handle.tabIndex = 0
    this.handle.dataset.tipTitle = 'Resize the section dock'
    this.handle.dataset.tip = 'Drag up or down (or focus it and use ↑ / ↓).'
    this.root.appendChild(this.handle)

    this.head = document.createElement('div')
    this.head.className = 'edt-section-head'
    this.root.appendChild(this.head)
    this.title = document.createElement('span')
    this.head.appendChild(this.title)
    // Tooltips (and their shortcut chips) come from the keymap commands;
    // X / F only act as keys while the Section tool is active.
    const btn = (label, cmd, onClick) => {
      const b = document.createElement('button')
      b.className = 'dbg-btn edt-mini'
      b.type = 'button'
      b.textContent = label
      b.dataset.cmd = cmd
      b.addEventListener('click', (e) => { e.preventDefault(); onClick() })
      this.head.appendChild(b)
      return b
    }
    btn('swap axis', 'section.swap', () => app.swapSectionAxis())
    this.followBtn = btn('follow cursor', 'section.follow', () => app.setSectionFollow(!app.section.follow))
    btn('close', 'view.section', () => app.setSectionOpen(false))
    this.readout = document.createElement('span')
    this.readout.className = 'edt-section-read'
    this.head.appendChild(this.readout)

    this.canvas = document.createElement('canvas')
    this.root.appendChild(this.canvas)
    this.ctx = this.canvas.getContext('2d')
    this.hover = null // {g, cy}
    this._w = 0
    this._h = 0
    this._rows = null
    this._bind()
    new ResizeObserver(() => this.resize()).observe(this.root)
  }

  setVisible(on) {
    this.root.style.display = on ? '' : 'none'
    if (on) this.resize()
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect()
    this._w = Math.max(1, rect.width)
    this._h = Math.max(1, rect.height)
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    this.canvas.width = Math.round(this._w * dpr)
    this.canvas.height = Math.round(this._h * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.app.invalidate()
  }

  // --- transforms -----------------------------------------------------------

  get _scale() { return this.app.view2d.view.scale }
  get _center() {
    const v = this.app.view2d.view
    return this.app.section.axis === 'x' ? v.cx : v.cz
  }

  // Horizontally centred like the plan (not the gutter-shifted strip), so an
  // x-axis cut stays column-aligned with the plan above it.
  su(u) { return this._w / 2 + (u - this._center) * this._scale }
  us(px) { return this._center + (px - this._w / 2) / this._scale }
  sh(y) { return this._h - PAD - (y - this._rows.base) * this._rows.k }
  hs(py) { return this._rows.base + (this._h - PAD - py) / this._rows.k }

  // Floors on show: the document's stored range (always including the
  // current floor), widened to the selected structure's band plus one storey
  // either side, capped around the current floor.
  _floorRange() {
    const { app } = this
    // The live world has no stored floor list: show a window around the
    // current floor (chunks stream in as the cut asks for them).
    const floors = app.source.isWorld
      ? [app.floor - 3, app.floor + 3]
      : app.map.floors()
    let y0 = Math.min(app.floor, floors[0] ?? app.floor)
    let y1 = Math.max(app.floor, floors.at(-1) ?? app.floor)
    const s = app.selectedStructure()
    if (s) {
      y0 = Math.min(y0, s.baseCy - 1)
      y1 = Math.max(y1, s.topCy + 1)
    }
    const MAX = 32
    if (y1 - y0 + 1 > MAX) {
      y0 = Math.max(y0, app.floor - MAX / 2)
      y1 = y0 + MAX - 1
    }
    return { y0, y1 }
  }

  // Storeys always fill the dock height; horizontally the cut keeps the
  // plan's scale. The ratio is reported as the vertical exaggeration.
  _layout() {
    const { y0, y1 } = this._floorRange()
    const n = y1 - y0 + 1
    const k = Math.max(1, (this._h - PAD * 2) / (n * LAYER_H))
    this._rows = { y0, y1, base: layerY(y0) - SLAB_T, k }
  }

  _cellAt(g, cy) {
    const { axis, line } = this.app.section
    const gx = axis === 'x' ? g : line
    const gz = axis === 'x' ? line : g
    const d = this.app.source.chunkAt(Math.floor(gx / CHUNK), cy, Math.floor(gz / CHUNK))
    if (!d) return null
    const lx = gx - d.cx * CHUNK
    const lz = gz - d.cz * CHUNK
    return { d, lx, lz, i: cIdx(lx, lz), gx, gz }
  }

  // --- interaction ----------------------------------------------------------

  _bind() {
    const c = this.canvas
    c.addEventListener('contextmenu', (e) => e.preventDefault())
    let pan = null
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId)
      if (e.button !== 0) { pan = { x: e.clientX }; return }
      const h = this._pick(e)
      if (h) this.app.jumpToCell(h.gx, h.gz, h.cy, { center: false })
    })
    c.addEventListener('pointermove', (e) => {
      if (pan) {
        const v = this.app.view2d.view
        const du = (e.clientX - pan.x) / this._scale
        if (this.app.section.axis === 'x') v.cx -= du
        else v.cz -= du
        pan = { x: e.clientX }
      } else {
        this.hover = this._pick(e)
      }
      this.app.invalidate()
    })
    const end = () => { pan = null }
    c.addEventListener('pointerup', end)
    c.addEventListener('pointercancel', end)
    c.addEventListener('pointerleave', () => { this.hover = null; this.app.invalidate() })
    c.addEventListener('wheel', (e) => {
      e.preventDefault()
      const rect = c.getBoundingClientRect()
      const u = this.us(e.clientX - rect.left)
      const v = this.app.view2d.view
      v.scale = Math.min(48, Math.max(1.2, v.scale * Math.exp(-e.deltaY * 0.0015)))
      const after = this.us(e.clientX - rect.left)
      if (this.app.section.axis === 'x') v.cx += u - after
      else v.cz += u - after
      this.app.invalidate()
    }, { passive: false })

    this.handle.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowUp' ? 0.04 : e.key === 'ArrowDown' ? -0.04 : 0
      if (!d) return
      e.preventDefault()
      e.stopPropagation()
      this.app.setSectionHeight(Math.min(0.8, Math.max(0.15, this.app.section.height + d)))
    })

    // Drag the top edge to resize the dock.
    this.handle.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.handle.setPointerCapture(e.pointerId)
      const parent = this.root.parentElement.getBoundingClientRect()
      const move = (ev) => {
        const frac = (parent.bottom - ev.clientY) / parent.height
        this.app.setSectionHeight(Math.min(0.8, Math.max(0.15, frac)))
      }
      const up = () => {
        this.handle.removeEventListener('pointermove', move)
        this.handle.removeEventListener('pointerup', up)
      }
      this.handle.addEventListener('pointermove', move)
      this.handle.addEventListener('pointerup', up)
    })
  }

  _pick(e) {
    if (!this._rows) return null
    const rect = this.canvas.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    if (px < GUTTER) return null
    const g = Math.floor(this.us(px) / CELL)
    const cy = Math.floor((this.hs(py) + SLAB_T * 0.5) / LAYER_H)
    if (cy < this._rows.y0 || cy > this._rows.y1) return null
    const { axis, line } = this.app.section
    return { g, cy, gx: axis === 'x' ? g : line, gz: axis === 'x' ? line : g }
  }

  // --- drawing --------------------------------------------------------------

  draw() {
    const { app } = this
    const g = this.ctx
    const { axis } = app.section
    this._layout()
    const { y0, y1, k } = this._rows
    g.fillStyle = '#0b0b08'
    g.fillRect(0, 0, this._w, this._h)

    const g0 = Math.floor(this.us(GUTTER) / CELL) - 1
    const g1 = Math.ceil(this.us(this._w) / CELL) + 1
    const cellPx = CELL * this._scale

    // Current floor band.
    g.fillStyle = 'rgba(205,191,110,0.07)'
    g.fillRect(GUTTER, this.sh(layerY(app.floor) + WALL_H), this._w, (WALL_H) * k)

    for (let cy = y0; cy <= y1; cy++) {
      const yF = this.sh(layerY(cy))
      const yC = this.sh(layerY(cy) + WALL_H)
      for (let gg = g0; gg <= g1; gg++) {
        const c = this._cellAt(gg, cy)
        const x = this.su(gg * CELL)
        if (!c) {
          g.fillStyle = 'rgba(255,255,255,0.015)'
          g.fillRect(x, yC, cellPx + 0.5, yF - yC)
          continue
        }
        const { d, i } = c
        const m = holeMasks(d)
        const kind = d.cellKind[i]
        const tint = kind === CELL_ROOM ? roleFill(d.spaceRole[i], 0.18) ?? KIND_FILL[kind] : KIND_FILL[kind]
        if (kind !== CELL_OPEN && tint) {
          g.fillStyle = tint
          g.fillRect(x, yC, cellPx + 0.5, yF - yC)
        }
        // Floor slab under this storey (it is also the ceiling of the one below).
        const slabPx = Math.max(2, SLAB_T * k)
        if (!m.floor[i]) {
          g.fillStyle = '#6e6230'
          g.fillRect(x, yF, cellPx + 0.5, slabPx)
        } else if (m.lethal[i]) {
          g.fillStyle = m.lethal[i] === 1 ? 'rgba(220,40,40,0.55)' : 'rgba(255,140,0,0.6)'
          g.fillRect(x, yF, cellPx + 0.5, slabPx)
          const deathY = m.deathYmm[i] / 1000
          if (deathY >= this._rows.base && deathY < layerY(cy)) {
            const yd = this.sh(deathY)
            g.strokeStyle = 'rgba(220,40,40,0.8)'
            g.lineWidth = 1
            g.setLineDash([3, 3])
            g.beginPath()
            g.moveTo(x, yd); g.lineTo(x + cellPx, yd)
            g.stroke()
            g.setLineDash([])
          }
        }
        // Top of the range: close its ceiling where the slab above is solid.
        if (cy === y1 && !m.ceil[i]) {
          g.fillStyle = 'rgba(110,98,48,0.55)'
          g.fillRect(x, this.sh(layerY(cy + 1)), cellPx + 0.5, slabPx)
        }
        const col = d.cols[i]
        if (col && col !== COLUMN_FURNITURE) {
          const half = col === COLUMN_MONUMENTAL ? 1.1 : 0.4
          g.fillStyle = '#7d6f36'
          g.fillRect(this.su((gg + 0.5) * CELL - half), yC, half * 2 * this._scale, yF - yC)
        }
      }
      this._drawCrossingWalls(g, cy, g0, g1)
      this._drawRowObjects(g, cy, g0, g1)
      this._drawStairs(g, cy, g0, g1)
    }

    this._drawStructure(g)

    // Hover cell.
    if (this.hover) {
      const x = this.su(this.hover.g * CELL)
      g.strokeStyle = 'rgba(255,240,180,0.8)'
      g.lineWidth = 1
      g.strokeRect(x, this.sh(layerY(this.hover.cy) + WALL_H), cellPx, WALL_H * k)
    }
    // Plan hover column/row mirrored into the section.
    const ph = app.view2d.hover
    if (ph) {
      const u = axis === 'x' ? ph.gx : ph.gz
      const x = this.su(u * CELL)
      g.strokeStyle = 'rgba(255,240,180,0.25)'
      g.strokeRect(x, PAD / 2, cellPx, this._h - PAD)
    }

    this._drawGutter(g)
    this._updateHead()
  }

  _drawGutter(g) {
    const { app } = this
    const { y0, y1, k } = this._rows
    g.fillStyle = '#12100a'
    g.fillRect(0, 0, GUTTER, this._h)
    g.strokeStyle = 'rgba(94,80,26,0.55)'
    g.beginPath()
    g.moveTo(GUTTER + 0.5, 0); g.lineTo(GUTTER + 0.5, this._h)
    g.stroke()
    const rowPx = LAYER_H * k
    const step = rowPx < 12 ? Math.ceil(12 / rowPx) : 1
    g.font = '10px ui-monospace, monospace'
    for (let cy = y0; cy <= y1; cy++) {
      if ((cy - y0) % step && cy !== app.floor) continue
      const current = cy === app.floor
      const role = rowPx >= 28 ? app.selectedLevelRole(cy) : null
      const y = this.sh(layerY(cy) + WALL_H / 2) + (role ? -3 : 3)
      g.fillStyle = current ? '#ffe6a0' : '#8d7f42'
      g.fillText(`${current ? '▸' : ' '}cy ${cy}`, 4, y)
      if (role) {
        g.fillStyle = '#a3955a' // WCAG AA on the dock background
        g.fillText(role.slice(0, 9), 4, y + 11)
      }
    }
  }

  // Walls whose grid line crosses the cut, at their real heights.
  _drawCrossingWalls(g, cy, g0, g1) {
    const { axis, line } = this.app.section
    const map = this.app.source
    const base = layerY(cy)
    const lw = Math.max(1.5, this._scale * 0.14)
    for (let gg = g0; gg <= g1 + 1; gg++) {
      const e = axis === 'x' ? map.wallVAt(gg, cy, line) : map.wallHAt(line, cy, gg)
      const x = this.su(gg * CELL)
      if (e.wall) {
        g.lineWidth = lw
        if (e.feature === WALL_RAIL) {
          g.strokeStyle = '#e0a040'
          this._vline(g, x, base, base + BRIDGE_GUARD_H)
        } else if (e.feature === WALL_WINDOW) {
          g.strokeStyle = '#b8a85a'
          this._vline(g, x, base, base + WINDOW_SILL_H)
          this._vline(g, x, base + WINDOW_HEAD_Y, base + WALL_H)
          g.strokeStyle = 'rgba(143,208,192,0.7)'
          g.lineWidth = 1
          this._vline(g, x, base + WINDOW_SILL_H, base + WINDOW_HEAD_Y)
        } else {
          g.strokeStyle = '#b8a85a'
          this._vline(g, x, base, base + WALL_H)
        }
      } else if (e.passage === PASSAGE_DOOR) {
        g.strokeStyle = 'rgba(143,208,192,0.8)'
        g.lineWidth = lw
        this._vline(g, x, base + DOOR_H, base + WALL_H)
      }
      // Walls running along the cut (behind it) as a faint backdrop.
      if (gg <= g1) {
        const n = axis === 'x' ? map.wallHAt(gg, cy, line) : map.wallVAt(line, cy, gg)
        const s = axis === 'x' ? map.wallHAt(gg, cy, line + 1) : map.wallVAt(line + 1, cy, gg)
        const behind = (n.wall ? 1 : 0) + (s.wall ? 1 : 0)
        if (behind) {
          g.fillStyle = `rgba(184,168,90,${0.05 * behind})`
          const rail = n.feature === WALL_RAIL || s.feature === WALL_RAIL
          const top = rail && !(n.wall && n.feature !== WALL_RAIL) && !(s.wall && s.feature !== WALL_RAIL)
            ? base + BRIDGE_GUARD_H
            : base + WALL_H
          g.fillRect(x, this.sh(top), CELL * this._scale, (top - base) * this._rows.k)
        }
      }
    }
  }

  _vline(g, x, yA, yB) {
    g.beginPath()
    g.moveTo(x, this.sh(yA))
    g.lineTo(x, this.sh(yB))
    g.stroke()
  }

  // Furniture boxes, ceiling lamps and the exit on the cut row.
  _drawRowObjects(g, cy, g0, g1) {
    const { axis, line } = this.app.section
    const map = this.app.source
    const base = layerY(cy)
    const k = this._rows.k
    const c0 = Math.floor(g0 / CHUNK)
    const c1 = Math.floor(g1 / CHUNK)
    const lineChunk = Math.floor(line / CHUNK)
    const lineLocal = line - lineChunk * CHUNK
    for (let c = c0; c <= c1; c++) {
      const d = axis === 'x' ? map.chunkAt(c, cy, lineChunk) : map.chunkAt(lineChunk, cy, c)
      if (!d) continue
      const origin = c * CHUNK * CELL
      for (const f of d.furniture) {
        if ((axis === 'x' ? f.lz : f.lx) !== lineLocal) continue
        const center = origin + (axis === 'x' ? f.x : f.z)
        const extent = axis === 'x' ? f.w : f.d
        g.fillStyle = 'rgba(176,141,74,0.85)'
        g.fillRect(this.su(center - extent / 2), this.sh(base + 0.9), extent * this._scale, 0.9 * k)
      }
      for (const l of d.lamps) {
        if ((axis === 'x' ? l.lz : l.lx) !== lineLocal) continue
        const center = origin + ((axis === 'x' ? l.lx : l.lz) + 0.5) * CELL
        g.fillStyle = l.lit ? '#f8f1a8' : '#6b5a2a'
        g.fillRect(this.su(center - 0.6), this.sh(base + WALL_H), 1.2 * this._scale, Math.max(2, 0.12 * k))
      }
      if (d.exit && (axis === 'x' ? d.exit.lz : d.exit.lx) === lineLocal) {
        const center = origin + ((axis === 'x' ? d.exit.lx : d.exit.lz) + 0.5) * CELL
        g.strokeStyle = '#7fffa0'
        g.lineWidth = 2
        g.strokeRect(this.su(center - 0.8), this.sh(base + 2), 1.6 * this._scale, 2 * k)
      }
    }
  }

  // A flight joins this storey to the next: a ramp when it runs along the
  // cut, a hatched well when the cut crosses it.
  _drawStairs(g, cy, g0, g1) {
    const { axis, line } = this.app.section
    const map = this.app.source
    const c0 = Math.floor(g0 / CHUNK)
    const c1 = Math.floor(g1 / CHUNK)
    const lineChunk = Math.floor(line / CHUNK)
    for (let c = c0; c <= c1; c++) {
      const d = axis === 'x' ? map.chunkAt(c, cy, lineChunk) : map.chunkAt(lineChunk, cy, c)
      const stair = d?.stairUp
      if (!stair?.run?.length) continue
      const glob = (cell) => ({ gx: d.cx * CHUNK + cell.lx, gz: d.cz * CHUNK + cell.lz })
      const run = stair.run.map(glob)
      const dx = STAIR_DX[stair.dir] ?? 0
      const dz = STAIR_DZ[stair.dir] ?? 0
      const along = axis === 'x' ? dx !== 0 : dz !== 0
      const onCut = (p) => (axis === 'x' ? p.gz : p.gx) === line
      const yLow = layerY(cy)
      const yHigh = layerY(cy + 1)
      g.strokeStyle = '#f0e08a'
      g.lineWidth = Math.max(1.5, this._scale * 0.2)
      if (along && onCut(run[0])) {
        const u = (p) => (axis === 'x' ? p.gx : p.gz)
        const sign = axis === 'x' ? dx : dz
        const start = sign > 0 ? u(run[0]) * CELL : (u(run[0]) + 1) * CELL
        const end = sign > 0 ? (u(run.at(-1)) + 1) * CELL : u(run.at(-1)) * CELL
        g.beginPath()
        g.moveTo(this.su(start), this.sh(yLow))
        g.lineTo(this.su(end), this.sh(yHigh))
        g.stroke()
        // Treads.
        g.lineWidth = 1
        const steps = 8
        for (let n = 1; n < steps; n++) {
          const t = n / steps
          const x = this.su(start + (end - start) * t)
          g.beginPath()
          g.moveTo(x, this.sh(yLow + (yHigh - yLow) * t))
          g.lineTo(x, this.sh(yLow + (yHigh - yLow) * (t - 1 / steps)))
          g.stroke()
        }
      } else if (!along) {
        for (const p of run) {
          if (!onCut(p)) continue
          const u = axis === 'x' ? p.gx : p.gz
          const x = this.su(u * CELL)
          const w = CELL * this._scale
          const top = this.sh(yHigh)
          const h = this.sh(yLow) - top
          g.save()
          g.beginPath()
          g.rect(x, top, w, h)
          g.clip()
          g.lineWidth = 1
          for (let o = -h; o < w; o += 6) {
            g.beginPath()
            g.moveTo(x + o, top + h)
            g.lineTo(x + o + h, top)
            g.stroke()
          }
          g.restore()
        }
      }
    }
  }

  _drawStructure(g) {
    const s = this.app.selectedStructure()
    if (!s) return
    const { axis, line } = this.app.section
    const b = s.globalBounds
    const across = axis === 'x' ? [b.z0, b.z1] : [b.x0, b.x1]
    if (line < across[0] || line > across[1]) return
    const [u0, u1] = axis === 'x' ? [b.x0, b.x1] : [b.z0, b.z1]
    const color = STRUCTURE_FAMILY_COLORS[structureFamily(s)] ?? '#d8b24a'
    const x0 = this.su(u0 * CELL)
    const x1 = this.su((u1 + 1) * CELL)
    const yTop = this.sh(layerY(s.topCy) + WALL_H)
    const yBot = this.sh(layerY(s.baseCy))
    g.strokeStyle = color
    g.lineWidth = 1.5
    g.setLineDash([6, 4])
    g.strokeRect(x0, yTop, x1 - x0, yBot - yTop)
    g.setLineDash([])
    g.fillStyle = color
    g.font = '10px ui-monospace, monospace'
    g.fillText(`#${s.id}`, x0 + 3, yTop - 3)
  }

  _updateHead() {
    const { app } = this
    const { axis, line, follow } = app.section
    const exaggeration = this._rows ? this._rows.k / this._scale : 1
    const vx = Math.abs(exaggeration - 1) < 0.15 ? '' : ` · vertical ×${exaggeration.toFixed(1)}`
    const title = `SECTION ${axis === 'x' ? `along x · gz=${line}` : `along z · gx=${line}`}${vx}`
    if (this.title.textContent !== title) this.title.textContent = title
    this.followBtn.classList.toggle('edt-on', !!follow)
    this.followBtn.setAttribute('aria-pressed', String(!!follow))
    let text = ''
    const h = this.hover
    if (h) {
      const c = this._cellAt(h.g, h.cy)
      const bits = [`${h.gx},${h.gz}`, `cy ${h.cy}`]
      if (!c) bits.push('no chunk')
      else {
        const m = holeMasks(c.d)
        if (m.floor[c.i]) bits.push(m.lethal[c.i] ? `lethal (death ${(m.deathYmm[c.i] / 1000).toFixed(1)}m)` : 'floor open')
        if (m.ceil[c.i]) bits.push('ceiling open')
        const role = app.selectedLevelRole(h.cy)
        if (role) bits.push(role)
      }
      text = bits.join(' · ')
    }
    if (this.readout.textContent !== text) this.readout.textContent = text
  }
}
