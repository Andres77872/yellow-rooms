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
import { STAIR_DX, STAIR_DZ } from '../../world/structures/slab.js'
import { structureFamily } from '../../world/structures/contract.js'
import {
  SPACE_ROLE_PALETTE,
  STRUCTURE_FAMILY_COLORS,
  ZONE_TINT,
  roomRoleLabel,
  spaceIdColor,
} from '../../debug/mapInspect.js'
import { paintStructures } from '../../debug/familyOverlays.js'
import { holeMasks } from '../holeMasks.js'
import { structureKey } from '../structureReview.js'
import { DARK_LEVEL, nodeKey } from '../simulate.js'

// Top-down editing viewport. Same drawing idioms as the F2 WorldMapTool
// (DPR-aware canvas, world-centred view, batched strokes), but reading the
// EditorMap document instead of streamed/generated chunks.
//
// The document is layered (one ChunkData per floor), so the plan is drawn in
// passes: every visible chunk's cell fills first, then a faint ghost of the
// floor BELOW (the storey you would see through a slab opening and the one a
// stair lands on), then the current floor's objects and walls, and finally
// the multilevel overlays — ceiling openings above, stair arrows, structure
// outlines, lethal voids, drift and audit markers and the section cut line.

export const KIND_FILL = {
  [CELL_OPEN]: '#171410',
  [CELL_ROOM]: 'rgba(150,90,40,0.22)',
  [CELL_CORRIDOR]: 'rgba(255,255,255,0.035)',
  [CELL_LOBBY]: 'rgba(160,130,60,0.13)',
  [CELL_STAIR]: 'rgba(216,178,74,0.30)',
  [CELL_ATRIUM]: 'rgba(80,120,160,0.18)',
  [CELL_VOID]: 'rgba(10,10,16,0.85)',
  [CELL_BRIDGE]: 'rgba(120,210,190,0.30)',
}

export const roleFill = (role, alpha = 0.26) => {
  const hex = SPACE_ROLE_PALETTE[role]
  if (!hex) return null
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

// Cool-to-hot ramp for scalar fields (distance, generation time).
export function heat(t) {
  const x = Math.max(0, Math.min(1, t))
  const r = Math.round(40 + 215 * Math.min(1, x * 1.6))
  const g = Math.round(60 + 170 * Math.max(0, Math.min(1, (x - 0.2) * 1.4)))
  const b = Math.round(160 * (1 - x) + 30)
  return `rgb(${r},${g},${b})`
}

// Explore mode generates chunks on demand; past this many visible chunks the
// plan only draws what is cached (zoom in to stream more).
const MAX_STREAM_CHUNKS = 520

const STAIR_UP_COLOR = '#f0e08a'
const STAIR_DOWN_COLOR = '#8fd0c0'
const SECTION_COLOR = 'rgba(120,200,255,0.85)'

export class MapView2D {
  constructor(app, container) {
    this.app = app
    this.canvas = document.createElement('canvas')
    container.appendChild(this.canvas)
    this.ctx = this.canvas.getContext('2d')
    this.view = { cx: CHUNK_WORLD / 2, cz: CHUNK_WORLD / 2, scale: 8 }
    this.hover = null // {wx, wz, gx, gz}
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

  // Frame a global cell rectangle with a small margin.
  fitCells(x0, z0, x1, z1) {
    const w = (x1 - x0 + 1) * CELL
    const h = (z1 - z0 + 1) * CELL
    this.view.cx = (x0 * CELL + (x1 + 1) * CELL) / 2
    this.view.cz = (z0 * CELL + (z1 + 1) * CELL) / 2
    const scale = Math.min(this._w / (w * 1.25), this._h / (h * 1.25))
    this.view.scale = Math.min(48, Math.max(1.2, scale))
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
        if (this.app.readOnly && this.app.tool?.edits) {
          this._blocked = true
          this.app.notify('explore mode is read-only — "bake view" copies it into the document to edit')
        } else {
          this._blocked = false
          this.app.tool?.onDown?.(this.pick(e), e)
        }
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
        this.app.onPlanHover?.(this.hover)
        if (!this._blocked) this.app.tool?.onMove?.(this.hover, e)
      }
      this.app.invalidate()
    })
    c.addEventListener('pointerleave', () => {
      this.hover = null
      this.app.invalidate()
    })
    const up = (e) => {
      if (this._pan) this._pan = null
      else if (e.button === 0 && !this._blocked) this.app.tool?.onUp?.(this.pick(e), e)
      this._blocked = false
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
      this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY)
    }, { passive: false })
  }

  zoomAt(px, py, deltaY) {
    const before = [this.wx(px), this.wz(py)]
    this.view.scale = Math.min(48, Math.max(1.2, this.view.scale * Math.exp(-deltaY * 0.0015)))
    this.view.cx += before[0] - this.wx(px)
    this.view.cz += before[1] - this.wz(py)
    this.app.invalidate()
  }

  // --- drawing --------------------------------------------------------------

  _visibleChunks() {
    const c0x = Math.floor(this.wx(0) / CHUNK_WORLD), c1x = Math.floor(this.wx(this._w) / CHUNK_WORLD)
    const c0z = Math.floor(this.wz(0) / CHUNK_WORLD), c1z = Math.floor(this.wz(this._h) / CHUNK_WORLD)
    return { c0x, c1x, c0z, c1z }
  }

  // Chunks of one floor in the view. For the live world a miss queues
  // generation (`stream`) unless the view is too wide; the ghost floor only
  // ever reads what is already cached.
  _chunksOn(cy, box, { stream = true } = {}) {
    const out = []
    const source = this.app.source
    const count = (box.c1x - box.c0x + 1) * (box.c1z - box.c0z + 1)
    const canStream = stream && (!source.isWorld || count <= MAX_STREAM_CHUNKS)
    this._missing = 0
    for (let cz = box.c0z; cz <= box.c1z; cz++) {
      for (let cx = box.c0x; cx <= box.c1x; cx++) {
        const d = canStream || !source.isWorld ? source.chunkAt(cx, cy, cz) : source.peek(cx, cy, cz)
        if (d) out.push(d)
        else if (source.isWorld) this._missing++
      }
    }
    return out
  }

  draw() {
    const g = this.ctx
    const { app } = this
    const layers = app.layers
    const cy = app.floor
    const s = this.view.scale
    g.fillStyle = '#0d0d09'
    g.fillRect(0, 0, this._w, this._h)

    const box = this._visibleChunks()
    const below = layers.ghost ? this._chunksOn(cy - 1, box, { stream: false }) : []
    const current = this._chunksOn(cy, box)
    const missing = this._missing

    if (app.source.isWorld) this._drawPending(g, box)
    for (const d of current) this._drawFills(g, d)
    if (app.fillMode !== 'kind') for (const d of current) this._drawFillMode(g, d)
    if (layers.sim) this._drawSimFields(g)
    if (below.length) this._drawGhost(g, below)
    for (const d of current) this._drawContents(g, d)
    if (layers.ceiling) for (const d of current) this._drawCeilingOpenings(g, d)
    if (layers.lethal) for (const d of current) this._drawLethal(g, d)
    if (layers.stairs) for (const d of current) this._drawStairs(g, d)

    this._drawChunkGrid(g, box)
    if (layers.structures) this._drawStructures(g)
    this._drawRooms(g, app.source, cy)
    if (layers.diff) this._drawDiff(g)
    if (layers.sim) this._drawSim(g)
    if (layers.issues) this._drawIssues(g)
    if (app.section.on) this._drawSectionLine(g)
    app.tool?.drawOverlay?.(g, this)
    this._drawSelection(g)
    this._drawInspectPin(g)
    this._drawFlash(g)
    if (app.source.isWorld && missing) {
      const wide = (box.c1x - box.c0x + 1) * (box.c1z - box.c0z + 1) > MAX_STREAM_CHUNKS
      g.fillStyle = 'rgba(13,13,9,0.8)'
      g.fillRect(this._w - 250, 8, 242, 20)
      g.fillStyle = '#8fd0ff'
      g.font = '11px ui-monospace, monospace'
      g.fillText(wide ? `zoom in to stream (${missing} chunks not cached)` : `generating… ${missing} chunks`, this._w - 244, 22)
    }
    if (this.hover && s > 3) {
      g.strokeStyle = 'rgba(255,240,180,0.5)'
      g.lineWidth = 1
      g.strokeRect(this.sx(this.hover.gx * CELL), this.sy(this.hover.gz * CELL), CELL * s, CELL * s)
    }
  }

  _cellRect(d, lx, lz) {
    const s = this.view.scale
    return [this.sx(d.cx * CHUNK_WORLD + lx * CELL), this.sy(d.cz * CHUNK_WORLD + lz * CELL), CELL * s + 0.5]
  }

  _drawFills(g, d) {
    const m = holeMasks(d)
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const i = cIdx(lx, lz)
        const [x, y, w] = this._cellRect(d, lx, lz)
        g.fillStyle = KIND_FILL[CELL_OPEN]
        g.fillRect(x, y, w, w)
        const kind = d.cellKind[i]
        if (kind !== CELL_OPEN) {
          const fill = (kind === CELL_ROOM && roleFill(d.spaceRole[i])) || KIND_FILL[kind]
          if (fill) { g.fillStyle = fill; g.fillRect(x, y, w, w) }
        }
        if (m.floor[i]) {
          g.fillStyle = 'rgba(4,4,8,0.72)'
          g.fillRect(x, y, w, w)
        }
      }
    }
  }

  // Hatched placeholders for world chunks still being generated.
  _drawPending(g, box) {
    const s = this.view.scale
    g.fillStyle = '#12110c'
    for (let cz = box.c0z; cz <= box.c1z; cz++) {
      for (let cx = box.c0x; cx <= box.c1x; cx++) {
        if (this.app.source.peek(cx, this.app.floor, cz)) continue
        g.fillRect(this.sx(cx * CHUNK_WORLD), this.sy(cz * CHUNK_WORLD), CHUNK_WORLD * s, CHUNK_WORLD * s)
      }
    }
  }

  // Debug fill modes over the kind fills: zone election, space identity,
  // semantic role, structure ownership, or per-chunk generation cost.
  _drawFillMode(g, d) {
    const mode = this.app.fillMode
    const s = this.view.scale
    const ox = this.sx(d.cx * CHUNK_WORLD)
    const oz = this.sy(d.cz * CHUNK_WORLD)
    if (mode === 'zone') {
      g.fillStyle = (ZONE_TINT[d.zone] ?? 'rgba(120,110,60,.1)').replace(/[\d.]+\)$/, '0.35)')
      g.fillRect(ox, oz, CHUNK_WORLD * s, CHUNK_WORLD * s)
      return
    }
    if (mode === 'gen') {
      const ms = this.app.source.genMs?.get(`${d.cx},${d.cy},${d.cz}`)
      if (ms === undefined) return
      g.globalAlpha = 0.45
      g.fillStyle = heat(ms / 20)
      g.fillRect(ox, oz, CHUNK_WORLD * s, CHUNK_WORLD * s)
      g.globalAlpha = 1
      if (s > 2.5) {
        g.fillStyle = '#fff'
        g.font = '10px ui-monospace, monospace'
        g.fillText(`${ms.toFixed(1)} ms`, ox + 4, oz + 12)
      }
      return
    }
    if (mode === 'owner') {
      const st = d.structure
      const participant = st?.hasRoom && st.participants?.some((p) => p.cx === d.cx && p.cz === d.cz)
      if (participant) {
        g.globalAlpha = 0.18
        g.fillStyle = STRUCTURE_FAMILY_COLORS[structureFamily(st)] ?? '#d8b24a'
        g.fillRect(ox, oz, CHUNK_WORLD * s, CHUNK_WORLD * s)
        g.globalAlpha = 1
      }
      if (d.structureUp || d.structureDown || d.stairUp || d.stairDown) {
        g.fillStyle = '#cfe8ff'
        g.font = '10px ui-monospace, monospace'
        const tags = [
          d.structureDown ? '↓slice' : '', d.structureUp ? '↑slice' : '',
          d.stairDown ? '↓stair' : '', d.stairUp ? '↑stair' : '',
        ].filter(Boolean).join(' ')
        if (s > 2.5) g.fillText(tags, ox + 4, oz + 12)
      }
      return
    }
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const i = cIdx(lx, lz)
        let fill = null
        if (mode === 'space' && d.spaceId[i]) fill = spaceIdColor(d.spaceId[i]).replace(/\.28\)$/, '.55)')
        else if (mode === 'role') fill = roleFill(d.spaceRole[i], 0.6)
        if (!fill) continue
        const [x, y, w] = this._cellRect(d, lx, lz)
        g.fillStyle = fill
        g.fillRect(x, y, w, w)
      }
    }
  }

  // Simulation fields (light, walk distance) drawn under the walls so the
  // plan stays legible.
  _drawSimFields(g) {
    const sim = this.app.sim
    const cy = this.app.floor
    const s = this.view.scale
    const cellPx = CELL * s + 0.5
    const cell = (gx, gz) => [this.sx(gx * CELL), this.sy(gz * CELL)]

    const light = sim.light?.cy === cy ? sim.light : null
    if (light) {
      const [x0, z0] = [light.box.x0 * CHUNK, light.box.z0 * CHUNK]
      const [x1, z1] = [(light.box.x1 + 1) * CHUNK, (light.box.z1 + 1) * CHUNK]
      for (let gz = z0; gz < z1; gz++) {
        for (let gx = x0; gx < x1; gx++) {
          const v = light.level.get(nodeKey(gx, gz, cy)) ?? 0
          const [x, y] = cell(gx, gz)
          if (v < DARK_LEVEL) {
            g.fillStyle = 'rgba(0,0,0,0.62)'
          } else {
            g.fillStyle = `rgba(255,236,150,${Math.min(0.35, v * 0.28)})`
          }
          g.fillRect(x, y, cellPx, cellPx)
        }
      }
    }

    const field = sim.distance
    if (field?.ok) {
      g.globalAlpha = 0.5
      for (const [k, d] of field.dist) {
        const n = field.graph.nodes.get(k)
        if (n.cy !== cy) continue
        const [x, y] = cell(n.gx, n.gz)
        g.fillStyle = heat(d / Math.max(1, field.max))
        g.fillRect(x, y, cellPx, cellPx)
      }
      g.globalAlpha = 1
    }
  }

  // Simulation marks (dead ends, start/farthest, isovist, path) on top.
  _drawSim(g) {
    const sim = this.app.sim
    const cy = this.app.floor
    const s = this.view.scale
    const center = (gx, gz) => [this.sx((gx + 0.5) * CELL), this.sy((gz + 0.5) * CELL)]
    const field = sim.distance
    if (field?.ok) {
      g.fillStyle = '#ff5a4a'
      for (const n of field.deadEnds) {
        if (n.cy !== cy) continue
        const [x, y] = center(n.gx, n.gz)
        g.fillRect(x - 2, y - 2, 4, 4)
      }
      const mark = (n, color, label) => {
        if (!n || n.cy !== cy) return
        const [x, y] = center(n.gx, n.gz)
        g.strokeStyle = color
        g.lineWidth = 2
        g.beginPath()
        g.arc(x, y, Math.max(5, s), 0, Math.PI * 2)
        g.stroke()
        g.fillStyle = color
        g.font = '11px ui-monospace, monospace'
        g.fillText(label, x + 8, y - 6)
      }
      mark(field.start, '#ffffff', 'start')
      mark(field.farthest, '#ff9a5a', `farthest ${field.max}`)
    }

    const iso = sim.isovist?.origin.cy === cy ? sim.isovist : null
    if (iso) {
      g.fillStyle = 'rgba(120,220,255,0.16)'
      g.strokeStyle = 'rgba(120,220,255,0.85)'
      g.lineWidth = 1.2
      g.beginPath()
      iso.points.forEach((p, i) => (i ? g.lineTo(this.sx(p.x), this.sy(p.z)) : g.moveTo(this.sx(p.x), this.sy(p.z))))
      g.closePath()
      g.fill()
      g.stroke()
      const [x, y] = center(iso.origin.gx, iso.origin.gz)
      g.fillStyle = '#78dcff'
      g.beginPath()
      g.arc(x, y, 4, 0, Math.PI * 2)
      g.fill()
    }

    const route = sim.path?.ok ? sim.path.path : null
    if (route) {
      g.strokeStyle = '#7fffa0'
      g.lineWidth = Math.max(2, s * 0.25)
      g.beginPath()
      let drawing = false
      for (let i = 0; i < route.length; i++) {
        const n = route[i]
        if (n.cy !== cy) { drawing = false; continue }
        const [x, y] = center(n.gx, n.gz)
        if (drawing) g.lineTo(x, y)
        else g.moveTo(x, y)
        drawing = true
        const next = route[i + 1]
        if (next && next.cy !== cy) {
          g.fillStyle = '#7fffa0'
          g.font = '11px ui-monospace, monospace'
          g.fillText(next.cy > cy ? `↑ cy${next.cy}` : `↓ cy${next.cy}`, x + 6, y - 6)
        }
      }
      g.stroke()
    }
    for (const [p, label] of [[sim.a, 'A'], [sim.b, 'B']]) {
      if (!p || p.cy !== cy) continue
      const [x, y] = center(p.gx, p.gz)
      g.fillStyle = '#7fffa0'
      g.font = 'bold 12px ui-monospace, monospace'
      g.fillText(label, x - 4, y + 4)
    }
  }

  _drawInspectPin(g) {
    const pin = this.app.inspect
    if (!pin || pin.cy !== this.app.floor) return
    const s = this.view.scale
    g.strokeStyle = '#ff7ae0'
    g.lineWidth = 2
    g.setLineDash([4, 3])
    g.strokeRect(this.sx(pin.gx * CELL) - 1, this.sy(pin.gz * CELL) - 1, CELL * s + 2, CELL * s + 2)
    g.setLineDash([])
  }

  // The storey below, in a cool translucent ink: its walls and its lamps.
  // Seen through slab openings (atria, stair wells) it shows exactly where a
  // fall or a stair lands; elsewhere it is the alignment guide for stacking.
  _drawGhost(g, chunks) {
    const s = this.view.scale
    g.save()
    g.strokeStyle = 'rgba(120,170,220,0.32)'
    g.lineWidth = Math.max(1, s * 0.08)
    g.beginPath()
    for (const d of chunks) {
      const ox = d.cx * CHUNK_WORLD
      const oz = d.cz * CHUNK_WORLD
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
    }
    g.stroke()
    g.restore()
  }

  _drawContents(g, d) {
    const s = this.view.scale
    const ox = d.cx * CHUNK_WORLD
    const oz = d.cz * CHUNK_WORLD
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
    paint(WALL_RAIL, '#e0a040')
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

  // Where THIS storey's ceiling is open (the shaft continues upward, a stair
  // climbs through): dashed cell outlines.
  _drawCeilingOpenings(g, d) {
    const m = holeMasks(d)
    if (!m.ceilCount) return
    const s = this.view.scale
    g.save()
    g.strokeStyle = 'rgba(200,190,255,0.55)'
    g.lineWidth = 1
    g.setLineDash([Math.max(2, s * 0.3), Math.max(2, s * 0.3)])
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        if (!m.ceil[cIdx(lx, lz)]) continue
        const [x, y, w] = this._cellRect(d, lx, lz)
        g.strokeRect(x + 1.5, y + 1.5, w - 3.5, w - 3.5)
      }
    }
    g.restore()
  }

  _drawLethal(g, d) {
    const m = holeMasks(d)
    if (!m.lethalCount) return
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const flag = m.lethal[cIdx(lx, lz)]
        if (!flag) continue
        const [x, y, w] = this._cellRect(d, lx, lz)
        g.fillStyle = flag === 1 ? 'rgba(220,40,40,0.32)' : 'rgba(255,140,0,0.45)'
        g.fillRect(x, y, w, w)
        g.strokeStyle = 'rgba(220,40,40,0.75)'
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(x, y + w)
        g.lineTo(x + w, y)
        g.stroke()
      }
    }
  }

  // Stair arrows: yellow climbs from this floor's landing through the run to
  // the exit above; teal arrives on this floor from the storey below.
  _drawStairs(g, d) {
    const s = this.view.scale
    const cell = (c) => [
      this.sx(d.cx * CHUNK_WORLD + (c.lx + 0.5) * CELL),
      this.sy(d.cz * CHUNK_WORLD + (c.lz + 0.5) * CELL),
    ]
    const arrow = (stair, color, label) => {
      if (!stair?.landing || !stair.exit) return
      const [x0, y0] = cell(stair.landing)
      const [x1, y1] = cell(stair.exit)
      g.strokeStyle = color
      g.fillStyle = color
      g.lineWidth = Math.max(1.5, s * 0.18)
      g.beginPath()
      g.moveTo(x0, y0)
      g.lineTo(x1, y1)
      g.stroke()
      const dx = STAIR_DX[stair.dir] ?? 0
      const dz = STAIR_DZ[stair.dir] ?? 0
      const head = Math.max(4, s * 0.8)
      g.beginPath()
      g.moveTo(x1 + dx * head * 0.4, y1 + dz * head * 0.4)
      g.lineTo(x1 - dx * head + dz * head * 0.6, y1 - dz * head + dx * head * 0.6)
      g.lineTo(x1 - dx * head - dz * head * 0.6, y1 - dz * head - dx * head * 0.6)
      g.closePath()
      g.fill()
      if (s > 5) {
        g.font = `${Math.max(9, Math.min(12, s))}px ui-monospace, monospace`
        g.fillText(label, x0 + 4, y0 - 4)
      }
    }
    arrow(d.stairUp, STAIR_UP_COLOR, `↑ cy${d.cy + 1}`)
    arrow(d.stairDown, STAIR_DOWN_COLOR, `↓ cy${d.cy - 1}`)
  }

  _drawChunkGrid(g, box) {
    const s = this.view.scale
    if (this.app.layers.grid && s > 6) {
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
    for (let cx = box.c0x; cx <= box.c1x + 1; cx++) {
      g.moveTo(this.sx(cx * CHUNK_WORLD), 0); g.lineTo(this.sx(cx * CHUNK_WORLD), this._h)
    }
    for (let cz = box.c0z; cz <= box.c1z + 1; cz++) {
      g.moveTo(0, this.sy(cz * CHUNK_WORLD)); g.lineTo(this._w, this.sy(cz * CHUNK_WORLD))
    }
    g.stroke()
  }

  // Loaded structures spanning this floor get the family glyphs (tower deck
  // and sockets, lattice anchors and edges) plus their outline; scanned but
  // unloaded ones are dashed footprints so the author sees where the next
  // volume sits. The selected structure is emphasised with its storey role.
  _drawStructures(g) {
    const { app } = this
    const floor = app.floor
    const selectedKey = app.selectedStructureKey
    const view = {
      ctx: g,
      scale: this.view.scale,
      floor,
      sx: (wx) => this.sx(wx),
      sy: (wz) => this.sy(wz),
    }
    const loaded = app.documentStructures().filter((st) => floor >= st.baseCy && floor <= st.topCy)
    const selected = app.selectedStructure()
    paintStructures(view, loaded, selected && loaded.includes(selected) ? selected : null)

    // Authored structures (document mode): magenta outlines with their label.
    if (!app.readOnly) {
      g.save()
      g.font = '11px ui-monospace, monospace'
      for (const view of app.authoredViews()) {
        if (floor < view.baseCy || floor > view.topCy) continue
        const b = view.globalBounds
        const on = structureKey(view) === selectedKey
        g.strokeStyle = on ? '#ff9ae0' : 'rgba(255,140,220,0.7)'
        g.lineWidth = on ? 2.5 : 1.2
        g.setLineDash(on ? [] : [6, 3])
        const x = this.sx(b.x0 * CELL)
        const y = this.sy(b.z0 * CELL)
        g.strokeRect(x, y, (b.x1 - b.x0 + 1) * CELL * this.view.scale, (b.z1 - b.z0 + 1) * CELL * this.view.scale)
        if (this.view.scale > 2.5) {
          g.fillStyle = '#ff9ae0'
          g.fillText(`✎ ${view.label}`, x + 3, y - 4)
        }
      }
      g.restore()
    }

    const loadedKeys = new Set(loaded.map(structureKey))
    g.save()
    g.setLineDash([5, 4])
    for (const entry of app.structureScan?.found ?? []) {
      const st = entry.structure
      if (loadedKeys.has(structureKey(st)) || floor < st.baseCy || floor > st.topCy) continue
      const b = st.globalBounds
      const color = STRUCTURE_FAMILY_COLORS[structureFamily(st)] ?? '#d8b24a'
      g.strokeStyle = color
      g.globalAlpha = structureKey(st) === selectedKey ? 0.95 : 0.45
      g.lineWidth = structureKey(st) === selectedKey ? 2 : 1
      g.strokeRect(this.sx(b.x0 * CELL), this.sy(b.z0 * CELL),
        (b.x1 - b.x0 + 1) * CELL * this.view.scale, (b.z1 - b.z0 + 1) * CELL * this.view.scale)
    }
    g.restore()

    if (selected && floor >= selected.baseCy && floor <= selected.topCy) {
      const b = selected.globalBounds
      const role = app.selectedLevelRole(floor)
      const x = this.sx(b.x0 * CELL)
      const y = this.sy((b.z1 + 1) * CELL)
      g.fillStyle = STRUCTURE_FAMILY_COLORS[structureFamily(selected)] ?? '#d8b24a'
      g.font = '11px ui-monospace, monospace'
      g.fillText(`cy ${floor} · ${role} (${floor - selected.baseCy + 1}/${selected.topCy - selected.baseCy + 1})`, x + 3, y + 13)
    }
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
      if (this.app.layers.labels && s > 4) {
        const label = roomRoleLabel(r.role) ?? 'room'
        g.fillStyle = selected ? '#ffe6a0' : 'rgba(205,191,110,0.75)'
        g.font = `${Math.max(9, Math.min(13, s * 1.4))}px ui-monospace, monospace`
        g.textAlign = 'center'
        g.fillText(label, x + w / 2, y + h / 2 + 3)
        g.textAlign = 'left'
      }
    }
  }

  _drawDiff(g) {
    const cells = this.app.review?.diff?.cells
    if (!cells?.length) return
    const s = this.view.scale
    g.lineWidth = Math.max(1, s * 0.12)
    for (const c of cells) {
      if (c.cy !== this.app.floor) continue
      g.strokeStyle = c.structural ? 'rgba(255,80,140,0.95)' : 'rgba(220,120,255,0.8)'
      g.strokeRect(this.sx(c.gx * CELL) + 1, this.sy(c.gz * CELL) + 1, CELL * s - 2, CELL * s - 2)
    }
  }

  _drawIssues(g) {
    const issues = this.app.reviewIssues()
    if (!issues.length) return
    const s = this.view.scale
    const r = Math.max(4, Math.min(9, s * 0.9))
    g.font = `bold ${Math.round(r * 1.4)}px ui-monospace, monospace`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (const issue of issues) {
      if (issue.cy !== this.app.floor || !Number.isFinite(issue.gx)) continue
      const x = this.sx((issue.gx + 0.5) * CELL)
      const y = this.sy((issue.gz + 0.5) * CELL)
      g.fillStyle = issue.severity === 'error' ? 'rgba(230,50,40,0.9)' : 'rgba(240,160,40,0.9)'
      g.beginPath()
      g.arc(x, y, r, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = '#140c08'
      g.fillText('!', x, y + 0.5)
    }
    g.textAlign = 'left'
    g.textBaseline = 'alphabetic'
  }

  _drawSectionLine(g) {
    const { axis, line } = this.app.section
    g.save()
    g.strokeStyle = SECTION_COLOR
    g.lineWidth = 1.5
    g.setLineDash([8, 5])
    g.beginPath()
    if (axis === 'x') {
      const y0 = this.sy(line * CELL)
      const y1 = this.sy((line + 1) * CELL)
      g.moveTo(0, y0); g.lineTo(this._w, y0)
      g.moveTo(0, y1); g.lineTo(this._w, y1)
    } else {
      const x0 = this.sx(line * CELL)
      const x1 = this.sx((line + 1) * CELL)
      g.moveTo(x0, 0); g.lineTo(x0, this._h)
      g.moveTo(x1, 0); g.lineTo(x1, this._h)
    }
    g.stroke()
    g.restore()
    g.fillStyle = SECTION_COLOR
    g.font = '11px ui-monospace, monospace'
    if (axis === 'x') g.fillText(`section gz=${line}`, 6, this.sy(line * CELL) - 4)
    else g.fillText(`section gx=${line}`, this.sx((line + 1) * CELL) + 4, 14)
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

  // Located-issue / section-click beacon: a fading ring for ~1.6 s.
  _drawFlash(g) {
    const f = this.app.flash
    if (!f || f.cy !== this.app.floor) return
    const t = (performance.now() - f.at) / 1600
    if (t >= 1) return
    const s = this.view.scale
    const x = this.sx((f.gx + 0.5) * CELL)
    const y = this.sy((f.gz + 0.5) * CELL)
    g.strokeStyle = `rgba(255,240,160,${1 - t})`
    g.lineWidth = 2.5
    g.beginPath()
    g.arc(x, y, Math.max(8, s * 1.2) + t * 18, 0, Math.PI * 2)
    g.stroke()
  }
}
