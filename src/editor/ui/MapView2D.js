import { CELL, CHUNK, CHUNK_WORLD, cIdx } from '../../world/constants.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  CELL_ROOM,
  CELL_STAIR,
  CELL_VOID,
  COLUMN_FURNITURE,
  COLUMN_MONUMENTAL,
  PASSAGE_DOOR,
  PASSAGE_WIDE,
  WALL_RAIL,
  WALL_WINDOW,
} from '../../world/mapTypes.js'
import { SPACE_ROLE_PALETTE, roomRoleLabel } from '../../debug/mapInspect.js'

// Top-down editing viewport. Same drawing idioms as the F2 WorldMapTool
// (DPR-aware canvas, world-centred view, batched strokes), but reading the
// EditorMap document instead of streamed/generated chunks.

const KIND_FILL = {
  [CELL_OPEN]: '#171410',
  [CELL_ROOM]: 'rgba(150,90,40,0.22)',
  [CELL_CORRIDOR]: 'rgba(255,255,255,0.035)',
  [CELL_LOBBY]: 'rgba(160,130,60,0.13)',
  [CELL_STAIR]: 'rgba(216,178,74,0.30)',
  [CELL_ATRIUM]: 'rgba(80,120,160,0.18)',
  [CELL_VOID]: 'rgba(10,10,16,0.85)',
  [CELL_BRIDGE]: 'rgba(200,160,80,0.30)',
}

const roleFill = (role) => {
  const hex = SPACE_ROLE_PALETTE[role]
  if (!hex) return null
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.26)`
}

export class MapView2D {
  constructor(app, container) {
    this.app = app
    this.canvas = document.createElement('canvas')
    container.appendChild(this.canvas)
    this.ctx = this.canvas.getContext('2d')
    this.view = { cx: CHUNK_WORLD / 2, cz: CHUNK_WORLD / 2, scale: 8 }
    this.hover = null // {wx, wz, gx, gz}
    this.showGrid = true
    this.showLabels = true
    this._pan = null
    this._w = 0
    this._h = 0
    this._bind()
    new ResizeObserver(() => this.resize()).observe(container)
    this.resize()
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect()
    this._w = Math.max(1, rect.width)
    this._h = Math.max(1, rect.height)
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    this.canvas.width = Math.round(this._w * dpr)
    this.canvas.height = Math.round(this._h * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.app.invalidate()
  }

  // --- transforms -----------------------------------------------------------

  sx(wx) { return this._w / 2 + (wx - this.view.cx) * this.view.scale }
  sy(wz) { return this._h / 2 + (wz - this.view.cz) * this.view.scale }
  wx(px) { return this.view.cx + (px - this._w / 2) / this.view.scale }
  wz(py) { return this.view.cz + (py - this._h / 2) / this.view.scale }

  centerOn(wx, wz) {
    this.view.cx = wx
    this.view.cz = wz
    this.app.invalidate()
  }

  // Pointer event -> world/cell/edge pick.
  pick(e) {
    const rect = this.canvas.getBoundingClientRect()
    return this.pickAt(this.wx(e.clientX - rect.left), this.wz(e.clientY - rect.top))
  }

  // World position -> cell/edge pick (used directly for stroke interpolation).
  pickAt(wx, wz) {
    const gx = Math.floor(wx / CELL)
    const gz = Math.floor(wz / CELL)
    // Nearest edge of the hovered cell within a threshold.
    const fx = wx / CELL - gx
    const fz = wz / CELL - gz
    const t = 0.3
    let edge = null
    const dW = fx, dE = 1 - fx, dN = fz, dS = 1 - fz
    const min = Math.min(dW, dE, dN, dS)
    if (min < t) {
      if (min === dW) edge = { axis: 'v', gx, gz }
      else if (min === dE) edge = { axis: 'v', gx: gx + 1, gz }
      else if (min === dN) edge = { axis: 'h', gx, gz }
      else edge = { axis: 'h', gx, gz: gz + 1 }
    }
    return { wx, wz, gx, gz, edge }
  }

  _bind() {
    const c = this.canvas
    c.addEventListener('contextmenu', (e) => e.preventDefault())
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId)
      if (e.button === 1 || e.button === 2) {
        this._pan = { x: e.clientX, y: e.clientY }
      } else if (e.button === 0) {
        this.app.tool?.onDown?.(this.pick(e), e)
      }
      this.app.invalidate()
    })
    c.addEventListener('pointermove', (e) => {
      if (this._pan) {
        this.view.cx -= (e.clientX - this._pan.x) / this.view.scale
        this.view.cz -= (e.clientY - this._pan.y) / this.view.scale
        this._pan = { x: e.clientX, y: e.clientY }
      } else {
        this.hover = this.pick(e)
        this.app.tool?.onMove?.(this.hover, e)
      }
      this.app.invalidate()
    })
    const up = (e) => {
      if (this._pan) this._pan = null
      else if (e.button === 0) this.app.tool?.onUp?.(this.pick(e), e)
      this.app.invalidate()
    }
    c.addEventListener('pointerup', up)
    c.addEventListener('pointercancel', () => {
      this._pan = null
      this.app.tool?.onCancel?.()
    })
    c.addEventListener('wheel', (e) => {
      e.preventDefault()
      const rect = c.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const before = [this.wx(px), this.wz(py)]
      this.view.scale = Math.min(48, Math.max(1.2, this.view.scale * Math.exp(-e.deltaY * 0.0015)))
      this.view.cx += before[0] - this.wx(px)
      this.view.cz += before[1] - this.wz(py)
      this.app.invalidate()
    }, { passive: false })
  }

  // --- drawing --------------------------------------------------------------

  draw() {
    const g = this.ctx
    const { app } = this
    const map = app.map
    const cy = app.floor
    const s = this.view.scale
    g.fillStyle = '#0d0d09'
    g.fillRect(0, 0, this._w, this._h)

    const wx0 = this.wx(0), wx1 = this.wx(this._w)
    const wz0 = this.wz(0), wz1 = this.wz(this._h)
    const c0x = Math.floor(wx0 / CHUNK_WORLD), c1x = Math.floor(wx1 / CHUNK_WORLD)
    const c0z = Math.floor(wz0 / CHUNK_WORLD), c1z = Math.floor(wz1 / CHUNK_WORLD)

    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const d = map.chunkAt(cx, cy, cz)
        if (d) this._drawChunk(g, d)
      }
    }

    this._drawChunkGrid(g, c0x, c1x, c0z, c1z)
    this._drawRooms(g, map, cy)
    app.tool?.drawOverlay?.(g, this)
    this._drawSelection(g)
    if (this.hover && s > 3) {
      g.strokeStyle = 'rgba(255,240,180,0.5)'
      g.lineWidth = 1
      g.strokeRect(this.sx(this.hover.gx * CELL), this.sy(this.hover.gz * CELL), CELL * s, CELL * s)
    }
  }

  _drawChunk(g, d) {
    const s = this.view.scale
    const ox = d.cx * CHUNK_WORLD
    const oz = d.cz * CHUNK_WORLD
    // Cell fills.
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const i = cIdx(lx, lz)
        const x = this.sx(ox + lx * CELL)
        const y = this.sy(oz + lz * CELL)
        const w = CELL * s + 0.5
        g.fillStyle = KIND_FILL[CELL_OPEN]
        g.fillRect(x, y, w, w)
        const kind = d.cellKind[i]
        if (kind !== CELL_OPEN) {
          const fill = (kind === CELL_ROOM && roleFill(d.spaceRole[i])) || KIND_FILL[kind]
          if (fill) { g.fillStyle = fill; g.fillRect(x, y, w, w) }
        }
        if (d.hasFloorHole(lx, lz)) {
          g.fillStyle = 'rgba(4,4,8,0.65)'
          g.fillRect(x, y, w, w)
        }
      }
    }
    // Columns + furniture.
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const col = d.cols[cIdx(lx, lz)]
        if (!col || col === COLUMN_FURNITURE) continue
        const half = col === COLUMN_MONUMENTAL ? 1.1 : 0.4
        const x = this.sx(ox + (lx + 0.5) * CELL - half)
        const y = this.sy(oz + (lz + 0.5) * CELL - half)
        g.fillStyle = '#6e6230'
        g.fillRect(x, y, half * 2 * s, half * 2 * s)
      }
    }
    for (const f of d.furniture) {
      const x = this.sx(ox + f.x - f.w / 2)
      const y = this.sy(oz + f.z - f.d / 2)
      g.fillStyle = 'rgba(176,141,74,0.85)'
      g.fillRect(x, y, f.w * s, f.d * s)
      g.strokeStyle = '#d8b24a'
      g.lineWidth = 1
      g.strokeRect(x, y, f.w * s, f.d * s)
    }
    // Lamps.
    for (const l of d.lamps) {
      const x = this.sx(ox + (l.lx + 0.5) * CELL)
      const y = this.sy(oz + (l.lz + 0.5) * CELL)
      g.beginPath()
      g.arc(x, y, Math.max(2, s * 0.5), 0, Math.PI * 2)
      if (l.lit) { g.fillStyle = '#f8f1a8'; g.fill() }
      else { g.strokeStyle = '#6b5a2a'; g.lineWidth = 1.5; g.stroke() }
    }
    // Exit.
    if (d.exit) {
      const x = this.sx(ox + (d.exit.lx + 0.5) * CELL)
      const y = this.sy(oz + (d.exit.lz + 0.5) * CELL)
      const r = Math.max(3, s * 0.9)
      g.strokeStyle = '#7fffa0'
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y)
      g.closePath()
      g.stroke()
    }
    // Walls (batched), then features and door markers.
    g.strokeStyle = '#b8a85a'
    g.lineWidth = Math.max(1, s * 0.12)
    g.beginPath()
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        if (d.vAt(lx, lz) === 1) {
          const x = this.sx(ox + lx * CELL)
          g.moveTo(x, this.sy(oz + lz * CELL))
          g.lineTo(x, this.sy(oz + (lz + 1) * CELL))
        }
        if (d.hAt(lx, lz) === 1) {
          const y = this.sy(oz + lz * CELL)
          g.moveTo(this.sx(ox + lx * CELL), y)
          g.lineTo(this.sx(ox + (lx + 1) * CELL), y)
        }
      }
    }
    g.stroke()
    this._featureStrokes(g, d, ox, oz)
    this._doorMarkers(g, d, ox, oz)
  }

  _featureStrokes(g, d, ox, oz) {
    const s = this.view.scale
    const paint = (feature, color) => {
      g.strokeStyle = color
      g.lineWidth = Math.max(1.5, s * 0.2)
      g.beginPath()
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          if (d.wallFeatureVAt(lx, lz) === feature && d.vAt(lx, lz) === 1) {
            const x = this.sx(ox + lx * CELL)
            g.moveTo(x, this.sy(oz + (lz + 0.2) * CELL))
            g.lineTo(x, this.sy(oz + (lz + 0.8) * CELL))
          }
          if (d.wallFeatureHAt(lx, lz) === feature && d.hAt(lx, lz) === 1) {
            const y = this.sy(oz + lz * CELL)
            g.moveTo(this.sx(ox + (lx + 0.2) * CELL), y)
            g.lineTo(this.sx(ox + (lx + 0.8) * CELL), y)
          }
        }
      }
      g.stroke()
    }
    paint(WALL_WINDOW, '#8fd0c0')
    paint(WALL_RAIL, '#d0aa58')
  }

  _doorMarkers(g, d, ox, oz) {
    const s = this.view.scale
    g.lineWidth = Math.max(2, s * 0.3)
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const pv = d.passageVAt(lx, lz)
        if (pv === PASSAGE_DOOR || pv === PASSAGE_WIDE) {
          g.strokeStyle = pv === PASSAGE_DOOR ? '#8fd0c0' : 'rgba(143,208,192,0.4)'
          const x = this.sx(ox + lx * CELL)
          g.beginPath()
          g.moveTo(x, this.sy(oz + (lz + 0.15) * CELL))
          g.lineTo(x, this.sy(oz + (lz + 0.85) * CELL))
          g.stroke()
        }
        const ph = d.passageHAt(lx, lz)
        if (ph === PASSAGE_DOOR || ph === PASSAGE_WIDE) {
          g.strokeStyle = ph === PASSAGE_DOOR ? '#8fd0c0' : 'rgba(143,208,192,0.4)'
          const y = this.sy(oz + lz * CELL)
          g.beginPath()
          g.moveTo(this.sx(ox + (lx + 0.15) * CELL), y)
          g.lineTo(this.sx(ox + (lx + 0.85) * CELL), y)
          g.stroke()
        }
      }
    }
  }

  _drawChunkGrid(g, c0x, c1x, c0z, c1z) {
    const s = this.view.scale
    if (this.showGrid && s > 6) {
      g.strokeStyle = 'rgba(94,80,26,0.22)'
      g.lineWidth = 1
      g.beginPath()
      const gx0 = Math.floor(this.wx(0) / CELL), gx1 = Math.ceil(this.wx(this._w) / CELL)
      const gz0 = Math.floor(this.wz(0) / CELL), gz1 = Math.ceil(this.wz(this._h) / CELL)
      for (let gx = gx0; gx <= gx1; gx++) {
        g.moveTo(this.sx(gx * CELL), 0); g.lineTo(this.sx(gx * CELL), this._h)
      }
      for (let gz = gz0; gz <= gz1; gz++) {
        g.moveTo(0, this.sy(gz * CELL)); g.lineTo(this._w, this.sy(gz * CELL))
      }
      g.stroke()
    }
    g.strokeStyle = 'rgba(94,80,26,0.55)'
    g.lineWidth = 1
    g.beginPath()
    for (let cx = c0x; cx <= c1x + 1; cx++) {
      g.moveTo(this.sx(cx * CHUNK_WORLD), 0); g.lineTo(this.sx(cx * CHUNK_WORLD), this._h)
    }
    for (let cz = c0z; cz <= c1z + 1; cz++) {
      g.moveTo(0, this.sy(cz * CHUNK_WORLD)); g.lineTo(this._w, this.sy(cz * CHUNK_WORLD))
    }
    g.stroke()
  }

  _drawRooms(g, map, cy) {
    const s = this.view.scale
    for (const r of map.rooms) {
      if (r.cy !== cy) continue
      const x = this.sx(r.x0 * CELL)
      const y = this.sy(r.z0 * CELL)
      const w = (r.x1 - r.x0 + 1) * CELL * s
      const h = (r.z1 - r.z0 + 1) * CELL * s
      const selected = this.app.selection?.type === 'room' && this.app.selection.id === r.id
      g.strokeStyle = selected ? '#ffe6a0' : 'rgba(205,191,110,0.5)'
      g.lineWidth = selected ? 2 : 1
      g.setLineDash(r.baked ? [4, 3] : [])
      g.strokeRect(x, y, w, h)
      g.setLineDash([])
      if (this.showLabels && s > 4) {
        const label = roomRoleLabel(r.role) ?? 'room'
        g.fillStyle = selected ? '#ffe6a0' : 'rgba(205,191,110,0.75)'
        g.font = `${Math.max(9, Math.min(13, s * 1.4))}px ui-monospace, monospace`
        g.textAlign = 'center'
        g.fillText(label, x + w / 2, y + h / 2 + 3)
        g.textAlign = 'left'
      }
    }
  }

  _drawSelection(g) {
    const sel = this.app.selection
    if (!sel || sel.type === 'room') return
    const s = this.view.scale
    const x = this.sx(sel.gx * CELL)
    const y = this.sy(sel.gz * CELL)
    g.strokeStyle = '#9fd0c0'
    g.lineWidth = 2
    g.strokeRect(x, y, CELL * s, CELL * s)
  }
}
