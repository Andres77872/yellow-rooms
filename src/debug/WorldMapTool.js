import {
  CELL,
  CHUNK,
  CHUNK_WORLD,
  ZONE_OFFICE,
  ZONE_PILLARS,
  ZONE_WAREHOUSE,
  COL_HALF,
  LIGHT_RANGE,
  FOV,
  chunkKey,
  worldToCell,
} from '../world/constants.js'
import { generateChunk } from '../world/generate.js'
import { hashStr } from '../world/core/hash.js'
import { floodReachable } from '../world/connectivity.js'
import { auditPatch } from '../world/audit.js'
import { section, slider, toggle, button, segmented, readout, buttonRow } from './widgets.js'

const LOGW = 322
const LOGH = 322
const HUBC = (CHUNK / 2) | 0
const SPAWN = (HUBC + 0.5) * CELL

const ZONE_NAME = { [ZONE_OFFICE]: 'office', [ZONE_PILLARS]: 'pillars', [ZONE_WAREHOUSE]: 'warehouse' }
const ZONE_TINT = {
  [ZONE_OFFICE]: 'rgba(150,90,40,.10)',
  [ZONE_PILLARS]: 'rgba(70,120,140,.09)',
  [ZONE_WAREHOUSE]: 'rgba(120,110,60,.06)',
}

// World-gen top-down map for the thin-wall model. Draws wall edges, columns,
// border doorways, lamps (lit/dead), the exit and live entities. LIVE reads
// loaded chunks; EXPLORE regenerates any region for an arbitrary seed
// (generation is a pure function of (seed, cx, cz)). A flood-fill validator
// (shared with the tests) proves traversability.
export class WorldMapTool {
  constructor(engine, dbg) {
    this.engine = engine
    this.dbg = dbg
    this.source = 0 // 0 = LIVE, 1 = EXPLORE
    this.view = { cx: SPAWN, cz: SPAWN, scale: 2.4 }
    this.validate = false
    this.seams = false // seam-openness / continuity overlay
    this.previewSeed = engine.cm.seed
    this.level = engine.state.level
    this._gen = new Map() // explore cache: `${seed}:cx,cz` -> ChunkData
    this._hover = null // {wx,wz}
    this._build()
  }

  _build() {
    const root = document.createElement('div')
    this.el = root

    // --- Controls -------------------------------------------------------
    const ctl = section('map')
    root.appendChild(ctl.el)
    this._src = segmented({
      labels: ['LIVE', 'EXPLORE'],
      value: 0,
      onPick: (i) => {
        this.source = i
        this._seedRow.el.style.display = i === 1 ? '' : 'none'
      },
    })
    ctl.body.appendChild(this._src.el)

    // Seed preview row (EXPLORE only)
    const seedWrap = document.createElement('div')
    seedWrap.className = 'dbg-row'
    const seedLab = document.createElement('span')
    seedLab.className = 'dbg-label'
    seedLab.textContent = 'seed'
    this._seedInput = document.createElement('input')
    this._seedInput.type = 'text'
    this._seedInput.className = 'dbg-text'
    this._seedInput.value = this.engine.state.seedText || 'lobby'
    this._seedInput.addEventListener('change', () => this._applySeed())
    seedWrap.appendChild(seedLab)
    seedWrap.appendChild(this._seedInput)
    const seedBtns = buttonRow('', [
      button({ label: 'apply', onClick: () => this._applySeed() }),
      button({ label: 'use current', onClick: () => this._useCurrentSeed() }),
    ])
    this._seedRow = { el: document.createElement('div') }
    this._seedRow.el.appendChild(seedWrap)
    this._seedRow.el.appendChild(seedBtns.el)
    this._seedRow.el.style.display = 'none'
    ctl.body.appendChild(this._seedRow.el)

    ctl.body.appendChild(
      slider({
        label: 'zoom',
        min: 0.6,
        max: 14,
        step: 0.1,
        value: this.view.scale,
        fmt: 1,
        onInput: (v) => (this.view.scale = v),
      }).el
    )
    this._zoom = ctl.body.lastChild
    ctl.body.appendChild(
      toggle({ label: 'validate connectivity', value: false, onChange: (v) => (this.validate = v) }).el
    )
    ctl.body.appendChild(
      toggle({ label: 'seam continuity', value: false, onChange: (v) => (this.seams = v) }).el
    )
    ctl.body.appendChild(
      buttonRow('', [
        button({ label: 'recenter player', onClick: () => this._recenter() }),
        button({ label: 'spawn', onClick: () => ((this.view.cx = SPAWN), (this.view.cz = SPAWN)) }),
      ]).el
    )

    // --- Canvas ---------------------------------------------------------
    const canvas = document.createElement('canvas')
    canvas.className = 'dbg-canvas'
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = LOGW * dpr
    canvas.height = LOGH * dpr
    canvas.style.width = LOGW + 'px'
    canvas.style.height = LOGH + 'px'
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    root.appendChild(canvas)
    this._bindCanvas()

    // --- Stats ----------------------------------------------------------
    const stats = section('stats')
    root.appendChild(stats.el)
    this._stat = {
      chunks: readout('chunks'),
      lamps: readout('lamps'),
      zones: readout('zones'),
      conn: readout('connectivity'),
      cont: readout('continuity'),
      seed: readout('seed'),
      cursor: readout('cursor'),
    }
    for (const k of Object.keys(this._stat)) stats.body.appendChild(this._stat[k].el)
  }

  _applySeed() {
    const text = (this._seedInput.value || '').trim() || 'lobby'
    this.previewSeed = hashStr(`${text}#${this.level}`)
    this._gen.clear()
  }

  _useCurrentSeed() {
    this.previewSeed = this.engine.cm.seed
    this.level = this.engine.state.level
    this._seedInput.value = this.engine.state.seedText || 'lobby'
    this._gen.clear()
  }

  _recenter() {
    const p = this.engine.controller.pos
    this.view.cx = p.x
    this.view.cz = p.z
  }

  _bindCanvas() {
    const c = this.canvas
    let dragging = false
    let lx = 0
    let lz = 0
    c.addEventListener('mousedown', (e) => {
      dragging = true
      lx = e.clientX
      lz = e.clientY
    })
    window.addEventListener('mouseup', () => (dragging = false))
    c.addEventListener('mousemove', (e) => {
      const r = c.getBoundingClientRect()
      const w = this._screenToWorld(e.clientX - r.left, e.clientY - r.top)
      this._hover = w
      if (dragging) {
        this.view.cx -= (e.clientX - lx) / this.view.scale
        this.view.cz -= (e.clientY - lz) / this.view.scale
        lx = e.clientX
        lz = e.clientY
      }
    })
    c.addEventListener('wheel', (e) => {
      e.preventDefault()
      const r = c.getBoundingClientRect()
      const before = this._screenToWorld(e.clientX - r.left, e.clientY - r.top)
      const f = Math.exp(-e.deltaY * 0.0015)
      this.view.scale = Math.max(0.6, Math.min(14, this.view.scale * f))
      const after = this._screenToWorld(e.clientX - r.left, e.clientY - r.top)
      this.view.cx += before.wx - after.wx
      this.view.cz += before.wz - after.wz
      this._zoom && this._zoom.querySelector('input') && (this._zoom.querySelector('input').value = this.view.scale)
    })
    c.addEventListener('dblclick', () => this._recenter())
    c.addEventListener('click', (e) => {
      if (!this.dbg.aiPlace) return
      const r = c.getBoundingClientRect()
      const w = this._screenToWorld(e.clientX - r.left, e.clientY - r.top)
      this.engine.debugMode.placeStalker(w.wx, w.wz)
    })
  }

  _screenToWorld(sx, sy) {
    return {
      wx: this.view.cx + (sx - LOGW / 2) / this.view.scale,
      wz: this.view.cz + (sy - LOGH / 2) / this.view.scale,
    }
  }

  _sx(wx) {
    return LOGW / 2 + (wx - this.view.cx) * this.view.scale
  }
  _sy(wz) {
    return LOGH / 2 + (wz - this.view.cz) * this.view.scale
  }

  // Returns the ChunkData for a chunk, or null if unknown (LIVE & unloaded).
  _chunkData(cx, cz) {
    if (this.source === 0) {
      return this.engine.cm.chunks.get(chunkKey(cx, cz))?.data ?? null
    }
    const key = `${this.previewSeed}:${cx},${cz}`
    let g = this._gen.get(key)
    if (!g) {
      g = generateChunk(this.previewSeed, cx, cz)
      this._gen.set(key, g)
    }
    return g
  }

  // Global thin-wall queries over whatever chunks are available (unknown -> wall).
  _wallV(gx, gz) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = this._chunkData(cx, cz)
    if (!d) return true
    return d.vAt(gx - cx * CHUNK, gz - cz * CHUNK) === 1
  }
  _wallH(gx, gz) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = this._chunkData(cx, cz)
    if (!d) return true
    return d.hAt(gx - cx * CHUNK, gz - cz * CHUNK) === 1
  }

  onShow() {}

  update() {
    const ctx = this.ctx
    const { cx, cz, scale } = this.view
    const halfW = LOGW / 2 / scale
    const halfH = LOGH / 2 / scale
    const c0x = Math.floor((cx - halfW) / CHUNK_WORLD) - 1
    const c1x = Math.floor((cx + halfW) / CHUNK_WORLD) + 1
    const c0z = Math.floor((cz - halfH) / CHUNK_WORLD) - 1
    const c1z = Math.floor((cz + halfH) / CHUNK_WORLD) + 1

    ctx.fillStyle = '#0d0d09'
    ctx.fillRect(0, 0, LOGW, LOGH)

    let reached = null
    let openCount = 0
    let sealed = 0
    if (this.validate) {
      const r = this._flood(c0x, c1x, c0z, c1z)
      reached = r.reached
      openCount = r.open
      sealed = r.sealed
    }

    let litN = 0
    let deadN = 0
    const zoneN = { [ZONE_OFFICE]: 0, [ZONE_PILLARS]: 0, [ZONE_WAREHOUSE]: 0 }
    let knownChunks = 0
    const wallW = Math.max(1, scale * 0.12)

    for (let ccz = c0z; ccz <= c1z; ccz++) {
      for (let ccx = c0x; ccx <= c1x; ccx++) {
        const d = this._chunkData(ccx, ccz)
        if (!d) continue
        knownChunks++
        if (zoneN[d.zone] !== undefined) zoneN[d.zone]++
        const ox = ccx * CHUNK_WORLD
        const oz = ccz * CHUNK_WORLD

        // Zone tint.
        ctx.fillStyle = ZONE_TINT[d.zone] || 'rgba(120,110,60,.05)'
        ctx.fillRect(this._sx(ox), this._sy(oz), CHUNK_WORLD * scale, CHUNK_WORLD * scale)

        // Sealed-pocket overlay (cells unreached by the validator).
        if (reached) {
          for (let lz = 0; lz < CHUNK; lz++) {
            for (let lx = 0; lx < CHUNK; lx++) {
              const gx = ccx * CHUNK + lx
              const gz = ccz * CHUNK + lz
              if (!reached.has(gx + ',' + gz)) {
                ctx.fillStyle = 'rgba(208,80,208,.5)'
                ctx.fillRect(this._sx(ox + lx * CELL), this._sy(oz + lz * CELL), CELL * scale, CELL * scale)
              }
            }
          }
        }

        // Wall edges (this chunk owns lines 0..CHUNK-1).
        ctx.strokeStyle = '#b8a85a'
        ctx.lineWidth = wallW
        ctx.beginPath()
        for (let z = 0; z < CHUNK; z++) {
          for (let lx = 0; lx < CHUNK; lx++) {
            if (d.vAt(lx, z) === 1) {
              const x = this._sx(ox + lx * CELL)
              ctx.moveTo(x, this._sy(oz + z * CELL))
              ctx.lineTo(x, this._sy(oz + (z + 1) * CELL))
            }
          }
        }
        for (let lz = 0; lz < CHUNK; lz++) {
          for (let x = 0; x < CHUNK; x++) {
            if (d.hAt(x, lz) === 1) {
              const y = this._sy(oz + lz * CELL)
              ctx.moveTo(this._sx(ox + x * CELL), y)
              ctx.lineTo(this._sx(ox + (x + 1) * CELL), y)
            }
          }
        }
        ctx.stroke()

        // Columns.
        ctx.fillStyle = '#6e6230'
        const csz = Math.max(1.5, COL_HALF * 2 * scale)
        for (let z = 0; z < CHUNK; z++) {
          for (let x = 0; x < CHUNK; x++) {
            if (d.colAt(x, z) === 1) {
              const wx = ox + (x + 0.5) * CELL
              const wz = oz + (z + 0.5) * CELL
              ctx.fillRect(this._sx(wx) - csz / 2, this._sy(wz) - csz / 2, csz, csz)
            }
          }
        }

        // Lamps.
        for (const l of d.lamps) {
          const wx = ox + (l.lx + 0.5) * CELL
          const wz = oz + (l.lz + 0.5) * CELL
          l.lit ? litN++ : deadN++
          this._lamp(wx, wz, l.lit)
        }

        // Border doorways on the owned West/North lines (gaps in a walled border).
        ctx.fillStyle = '#8fd0c0'
        this._borderDoors(d, ox, oz)
      }
    }

    // Chunk grid lines.
    ctx.strokeStyle = 'rgba(94,80,26,.5)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let ccx = c0x; ccx <= c1x + 1; ccx++) {
      const x = this._sx(ccx * CHUNK_WORLD)
      ctx.moveTo(x, 0)
      ctx.lineTo(x, LOGH)
    }
    for (let ccz = c0z; ccz <= c1z + 1; ccz++) {
      const y = this._sy(ccz * CHUNK_WORLD)
      ctx.moveTo(0, y)
      ctx.lineTo(LOGW, y)
    }
    ctx.stroke()

    // Seam-continuity overlay: color every chunk boundary by openness so the
    // "isolated boxes" problem is visible at a glance (green = open/merged,
    // red = wall, with the wide transition mouths reading as long green runs).
    let cont = null
    if (this.seams) cont = this._drawSeams(c0x, c1x, c0z, c1z)

    this._drawExit()
    this._drawEntities()
    this._drawHud()

    // Stats.
    const cm = this.engine.cm
    this._stat.chunks.set(`${cm.chunks.size} loaded / ${knownChunks} drawn`)
    this._stat.lamps.set(`${litN} lit  ${deadN} dead`)
    this._stat.zones.set(
      `off ${zoneN[ZONE_OFFICE]} · pil ${zoneN[ZONE_PILLARS]} · whs ${zoneN[ZONE_WAREHOUSE]}`
    )
    this._stat.conn.set(this.validate ? `${reached.size}/${openCount} open · ${sealed} sealed` : 'off')
    this._stat.cont.set(
      cont ? `score ${cont.score.toFixed(2)} · ${cont.sealed} sealed · align ${cont.alignment.toFixed(2)}` : 'off'
    )
    this._stat.seed.set(`${this.source === 1 ? 'explore' : 'live'} 0x${(this.previewSeed >>> 0).toString(16)}`)
    this._stat.cursor.set(this._hover ? `${this._hover.wx.toFixed(1)}, ${this._hover.wz.toFixed(1)}` : '—')
  }

  // Mark doorway gaps on a chunk's owned West (lx=0) and North (lz=0) borders,
  // but only when that border is otherwise walled (skip fully-open halls).
  _borderDoors(d, ox, oz) {
    let westWalled = false
    let northWalled = false
    for (let z = 0; z < CHUNK; z++) if (d.vAt(0, z) === 1) westWalled = true
    for (let x = 0; x < CHUNK; x++) if (d.hAt(x, 0) === 1) northWalled = true
    if (westWalled) {
      for (let z = 0; z < CHUNK; z++) {
        if (d.vAt(0, z) === 0) this._door(ox, oz + (z + 0.5) * CELL)
      }
    }
    if (northWalled) {
      for (let x = 0; x < CHUNK; x++) {
        if (d.hAt(x, 0) === 0) this._door(ox + (x + 0.5) * CELL, oz)
      }
    }
  }

  _door(wx, wz) {
    const s = 3
    this.ctx.fillRect(this._sx(wx) - s / 2, this._sy(wz) - s / 2, s, s)
  }

  // Color every chunk boundary by openness (red = wall, green = open) so seam
  // continuity is legible: open halls read as solid green, office partitions as
  // red flecked with green doors, transition mouths as long green runs. Each
  // chunk owns its West (lx=0) and North (lz=0) lines, which ARE the shared
  // seams. Returns the auditPatch score over the visible region for the HUD.
  _drawSeams(c0x, c1x, c0z, c1z) {
    const ctx = this.ctx
    ctx.lineWidth = Math.max(2, this.view.scale * 0.4)
    for (const want of [0, 1]) {
      // walls first, open doors on top so doorways/mouths pop
      ctx.strokeStyle = want ? 'rgba(120,230,140,.9)' : 'rgba(225,80,70,.8)'
      ctx.beginPath()
      for (let ccz = c0z; ccz <= c1z; ccz++) {
        for (let ccx = c0x; ccx <= c1x; ccx++) {
          const d = this._chunkData(ccx, ccz)
          if (!d) continue
          const ox = ccx * CHUNK_WORLD
          const oz = ccz * CHUNK_WORLD
          const x = this._sx(ox)
          for (let z = 0; z < CHUNK; z++) {
            if ((d.vAt(0, z) === 0 ? 1 : 0) !== want) continue
            ctx.moveTo(x, this._sy(oz + z * CELL))
            ctx.lineTo(x, this._sy(oz + (z + 1) * CELL))
          }
          const y = this._sy(oz)
          for (let xx = 0; xx < CHUNK; xx++) {
            if ((d.hAt(xx, 0) === 0 ? 1 : 0) !== want) continue
            ctx.moveTo(this._sx(ox + xx * CELL), y)
            ctx.lineTo(this._sx(ox + (xx + 1) * CELL), y)
          }
        }
      }
      ctx.stroke()
    }
    return auditPatch(
      (cx, cz) => this._chunkData(cx, cz),
      c0x,
      c0z,
      c1x - c0x + 1,
      c1z - c0z + 1,
      this.engine.cm.config
    )
  }

  _lamp(wx, wz, lit) {
    const ctx = this.ctx
    const x = this._sx(wx)
    const y = this._sy(wz)
    ctx.beginPath()
    ctx.arc(x, y, 2.2, 0, Math.PI * 2)
    if (lit) {
      ctx.fillStyle = '#f8f1a8'
      ctx.fill()
    } else {
      ctx.strokeStyle = '#6b5a2a'
      ctx.stroke()
    }
  }

  _drawExit() {
    const ex = this.engine.cm.exit
    if (!ex) return
    const wx = ex.cx * CHUNK_WORLD + (ex.lx + 0.5) * CELL
    const wz = ex.cz * CHUNK_WORLD + (ex.lz + 0.5) * CELL
    const x = this._sx(wx)
    const y = this._sy(wz)
    const ctx = this.ctx
    ctx.fillStyle = '#7fffa0'
    ctx.beginPath()
    ctx.moveTo(x, y - 5)
    ctx.lineTo(x + 5, y)
    ctx.lineTo(x, y + 5)
    ctx.lineTo(x - 5, y)
    ctx.closePath()
    ctx.fill()
  }

  _drawEntities() {
    const ctx = this.ctx
    const p = this.engine.controller.pos
    const yaw = this.engine.controller.yaw
    const px = this._sx(p.x)
    const pz = this._sy(p.z)

    const ang = Math.atan2(-Math.cos(yaw), -Math.sin(yaw))
    const half = (FOV * Math.PI) / 180 / 2
    const len = 9 * this.view.scale
    ctx.fillStyle = 'rgba(248,241,168,.18)'
    ctx.beginPath()
    ctx.moveTo(px, pz)
    ctx.arc(px, pz, len, ang - half, ang + half)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#f8f1a8'
    ctx.beginPath()
    ctx.arc(px, pz, 3, 0, Math.PI * 2)
    ctx.fill()

    const s = this.engine.stalker
    if (!this.dbg.aiOverlay || (!s.active && !s.alwaysVisible)) return
    const sx = this._sx(s.pos.x)
    const sz = this._sy(s.pos.z)

    ctx.strokeStyle = 'rgba(255,120,80,.4)'
    ctx.setLineDash([4, 4])
    for (const r of [s.minRange, s.maxRange]) {
      ctx.beginPath()
      ctx.arc(px, pz, r * this.view.scale, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.setLineDash([])

    for (const c of s._lastCandidates) {
      ctx.fillStyle = c.ok ? 'rgba(120,255,120,.7)' : 'rgba(255,80,80,.5)'
      ctx.beginPath()
      ctx.arc(this._sx(c.x), this._sy(c.z), 1.6, 0, Math.PI * 2)
      ctx.fill()
    }
    if (s._lastTarget) {
      ctx.strokeStyle = '#7fff7f'
      ctx.beginPath()
      ctx.arc(this._sx(s._lastTarget.x), this._sy(s._lastTarget.z), 4, 0, Math.PI * 2)
      ctx.stroke()
    }

    const seen = this.dbg.aiSeen
    ctx.strokeStyle = seen ? '#7fff7f' : 'rgba(255,90,74,.7)'
    ctx.setLineDash(seen ? [] : [3, 3])
    ctx.beginPath()
    ctx.moveTo(px, pz)
    ctx.lineTo(sx, sz)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.fillStyle = '#ff5a4a'
    ctx.fillRect(sx - 3, sz - 3, 6, 6)
  }

  _drawHud() {
    const ctx = this.ctx
    ctx.fillStyle = 'rgba(233,225,163,.7)'
    ctx.font = '10px ui-monospace, monospace'
    ctx.fillText('N↑', 6, 14)
    const px10 = 10 * this.view.scale
    ctx.strokeStyle = 'rgba(233,225,163,.7)'
    ctx.beginPath()
    ctx.moveTo(LOGW - 10 - px10, LOGH - 10)
    ctx.lineTo(LOGW - 10, LOGH - 10)
    ctx.stroke()
    ctx.fillText('10m', LOGW - 10 - px10, LOGH - 14)
  }

  // Flood OPEN cells (thin-wall adjacency) from the player's cell across the
  // visible region; reports sealed pockets. Reuses the shared floodReachable.
  _flood(c0x, c1x, c0z, c1z) {
    const minGx = c0x * CHUNK
    const maxGx = (c1x + 1) * CHUNK - 1
    const minGz = c0z * CHUNK
    const maxGz = (c1z + 1) * CHUNK - 1
    const W = maxGx - minGx + 1
    const H = maxGz - minGz + 1
    const canPass = (ax, az, bx, bz) => {
      const gxa = minGx + ax
      const gza = minGz + az
      if (bx === ax + 1) return !this._wallV(gxa + 1, gza)
      if (bx === ax - 1) return !this._wallV(gxa, gza)
      if (bz === az + 1) return !this._wallH(gxa, gza + 1)
      return !this._wallH(gxa, gza)
    }
    const p = this.engine.controller.pos
    let sx = worldToCell(p.x) - minGx
    let sz = worldToCell(p.z) - minGz
    if (sx < 0 || sx >= W || sz < 0 || sz >= H) {
      sx = (W / 2) | 0
      sz = (H / 2) | 0
    }
    const seen = floodReachable(sx, sz, W, H, canPass)
    const reached = new Set()
    let open = 0
    let sealed = 0
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        const gx = minGx + x
        const gz = minGz + z
        if (!this._chunkData(Math.floor(gx / CHUNK), Math.floor(gz / CHUNK))) continue
        open++
        if (seen[z * W + x]) reached.add(gx + ',' + gz)
        else if (x > 0 && x < W - 1 && z > 0 && z < H - 1) sealed++
      }
    }
    return { reached, open, sealed }
  }

  dispose() {
    this._gen.clear()
  }
}
