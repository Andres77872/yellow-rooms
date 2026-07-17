import {
  CELL,
  CHUNK,
  CHUNK_WORLD,
  ZONE_OFFICE,
  ZONE_PILLARS,
  ZONE_WAREHOUSE,
  COL_HALF,
  FOV,
  chunkKey3,
  worldToCell,
} from '../world/constants.js'
import { generateChunk } from '../world/generate.js'
import { hashStr } from '../world/core/hash.js'
import { floodReachable } from '../world/connectivity.js'
import { auditLayeredPatch, auditPatch } from '../world/audit.js'
import { section, slider, toggle, button, segmented, readout, buttonRow } from './widgets.js'
import { CELL_BRIDGE, WALL_RAIL, WALL_WINDOW } from '../world/mapTypes.js'

const LOGW = 322
const LOGH = 322
const HUBC = (CHUNK / 2) | 0
const SPAWN = (HUBC + 0.5) * CELL

const validStructureBounds = (bounds) =>
  Number.isInteger(bounds?.x0) &&
  Number.isInteger(bounds?.z0) &&
  Number.isInteger(bounds?.x1) &&
  Number.isInteger(bounds?.z1) &&
  bounds.x0 <= bounds.x1 &&
  bounds.z0 <= bounds.z1

// Build the layered-audit box from the structure selected in the map. A tall
// volume is audited as one object: all of its floors and both participant
// chunks are included even when the current viewport clips an edge. Without a
// selection the historical current-floor +/-1 stair audit remains useful.
export function multilevelAuditBox(structure, c0x, c1x, c0z, c1z, floor) {
  let x0 = c0x
  let x1 = c1x
  let z0 = c0z
  let z1 = c1z
  let y0 = floor - 1
  let y1 = floor + 1

  if (
    structure?.hasRoom &&
    Number.isInteger(structure.baseCy) &&
    Number.isInteger(structure.topCy) &&
    structure.baseCy <= structure.topCy
  ) {
    y0 = structure.baseCy
    y1 = structure.topCy
    const participants = Array.isArray(structure.participants)
      ? structure.participants
      : []
    if (participants.length > 0) {
      for (const participant of participants) {
        if (!Number.isInteger(participant?.cx) || !Number.isInteger(participant?.cz)) continue
        x0 = Math.min(x0, participant.cx)
        x1 = Math.max(x1, participant.cx)
        z0 = Math.min(z0, participant.cz)
        z1 = Math.max(z1, participant.cz)
      }
    } else if (validStructureBounds(structure.globalBounds)) {
      x0 = Math.min(x0, Math.floor(structure.globalBounds.x0 / CHUNK))
      x1 = Math.max(x1, Math.floor(structure.globalBounds.x1 / CHUNK))
      z0 = Math.min(z0, Math.floor(structure.globalBounds.z0 / CHUNK))
      z1 = Math.max(z1, Math.floor(structure.globalBounds.z1 / CHUNK))
    }
  }

  return {
    x0,
    y0,
    z0,
    nx: x1 - x0 + 1,
    ny: y1 - y0 + 1,
    nz: z1 - z0 + 1,
  }
}

export function structureAtCell(structures, gx, gz, floor) {
  if (!Number.isInteger(gx) || !Number.isInteger(gz) || !Number.isInteger(floor)) return null
  for (const structure of structures) {
    const bounds = structure?.globalBounds
    if (
      structure?.hasRoom &&
      validStructureBounds(bounds) &&
      floor >= structure.baseCy &&
      floor <= structure.topCy &&
      gx >= bounds.x0 &&
      gx <= bounds.x1 &&
      gz >= bounds.z0 &&
      gz <= bounds.z1
    ) return structure
  }
  return null
}

export function formatMultilevelStructure(structures, selected, source = 'visible') {
  if (structures.length === 0) return 'visible 0 · current —'
  const structure = selected ?? structures[0]
  const levels = Number.isInteger(structure.levelCount)
    ? structure.levelCount
    : structure.topCy - structure.baseCy + 1
  const bridges = structure.bridgeLevels?.length
    ? structure.bridgeLevels.join(',')
    : 'none'
  return `visible ${structures.length} · ${source} #${structure.id} ${structure.kind} · cy ${structure.baseCy}…${structure.topCy} · ${levels} levels · bridges ${bridges}`
}

export function formatMultilevelAudit(audit) {
  if (!audit) return 'off'
  return `struct ${audit.multilevelStructures ?? 0} · pairs ${audit.multilevelPairs ?? 0} · slices ${audit.multilevelSlices ?? 0} · mismatch ${audit.mismatchedMultilevelDescriptors ?? 0} · bad room/struct ${audit.invalidMultilevelRooms ?? 0}/${audit.invalidMultilevelStructures ?? 0} · orphan ${audit.orphanedMultilevelHalves ?? 0} · stray ${audit.strayWallFeatures ?? 0} · missing ${audit.missingMultilevelSlices ?? 0} · seams ${audit.closedBridgeSeams ?? 0}`
}

const ZONE_TINT = {
  [ZONE_OFFICE]: 'rgba(150,90,40,.10)',
  [ZONE_PILLARS]: 'rgba(70,120,140,.09)',
  [ZONE_WAREHOUSE]: 'rgba(120,110,60,.06)',
}

// World-gen top-down map for the thin-wall model, one floor (v11 layer) at a
// time. Draws wall edges, columns, border openings, lamps (lit/dead), stair
// glyphs, the exit and live entities. LIVE reads loaded chunks; EXPLORE
// regenerates any floor for an arbitrary seed (generation is a pure function
// of (seed, cx, cy, cz)). A flood-fill validator (shared with the tests)
// proves per-floor traversability.
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
    this.floor = 0 // cy of the drawn layer
    this.followFloor = true // track engine.controller.floor each update
    this._gen = new Map() // explore cache: `${seed}:cx,cy,cz` -> ChunkData
    this._integrityCache = { key: '', value: null }
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

    // Floor stepper (v8 layered world). Stepping detaches from the player;
    // the follow toggle re-attaches.
    this._floorRead = readout('floor')
    ctl.body.appendChild(
      buttonRow('floor', [
        button({ label: '−', onClick: () => this._stepFloor(-1) }),
        button({ label: '+', onClick: () => this._stepFloor(1) }),
      ]).el
    )
    ctl.body.appendChild(this._floorRead.el)
    this._follow = toggle({
      label: 'follow player floor',
      value: this.followFloor,
      onChange: (v) => (this.followFloor = v),
    })
    ctl.body.appendChild(this._follow.el)

    // Map-click behavior shared with DebugMode: nothing, place the stalker,
    // or teleport the player (all guarded by cm.isBlocked at the target).
    const clickRow = document.createElement('div')
    clickRow.className = 'dbg-row'
    const clickLab = document.createElement('span')
    clickLab.className = 'dbg-label'
    clickLab.textContent = 'map click'
    clickRow.appendChild(clickLab)
    const CLICK_MODES = ['off', 'stalker', 'player']
    this._clickMode = segmented({
      labels: CLICK_MODES,
      value: 0,
      onPick: (i) => (this.dbg.mapClickMode = CLICK_MODES[i]),
    })
    clickRow.appendChild(this._clickMode.el)
    ctl.body.appendChild(clickRow)

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
      integrity: readout('3d integrity'),
      multilevel: readout('multilevel'),
      multilevelAudit: readout('multilevel audit'),
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

  _stepFloor(d) {
    this.followFloor = false
    this._follow.set(false)
    this.floor += d
  }

  _bindCanvas() {
    const c = this.canvas
    let dragId = null
    let lx = 0
    let lz = 0
    let moved = 0 // px travelled this drag — suppresses the click after a pan
    c.addEventListener('pointerdown', (e) => {
      if (dragId !== null) return
      dragId = e.pointerId
      try {
        c.setPointerCapture(dragId)
      } catch {
        /* pointer already released */
      }
      lx = e.clientX
      lz = e.clientY
      moved = 0
    })
    const end = (e) => {
      if (e.pointerId === dragId) dragId = null
    }
    c.addEventListener('pointerup', end)
    c.addEventListener('pointercancel', end)
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect()
      const w = this._screenToWorld(e.clientX - r.left, e.clientY - r.top)
      this._hover = w
      if (e.pointerId !== dragId) return
      moved += Math.abs(e.clientX - lx) + Math.abs(e.clientY - lz)
      this.view.cx -= (e.clientX - lx) / this.view.scale
      this.view.cz -= (e.clientY - lz) / this.view.scale
      lx = e.clientX
      lz = e.clientY
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
      const zin = this._zoom && this._zoom.querySelector('input')
      if (zin) zin.value = this.view.scale
    })
    c.addEventListener('dblclick', () => this._recenter())
    c.addEventListener('click', (e) => {
      if (moved > 4) return // that gesture was a pan, not a click
      const mode = this.dbg.mapClickMode
      if (mode === 'off') return
      const r = c.getBoundingClientRect()
      const w = this._screenToWorld(e.clientX - r.left, e.clientY - r.top)
      if (mode === 'stalker') this.engine.debugMode.placeStalker(w.wx, w.wz, this.floor)
      else this.engine.debugMode.teleportPlayer(w.wx, w.wz, this.floor)
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

  // Returns the ChunkData for a chunk on the drawn floor, or null if unknown
  // (LIVE & unloaded).
  _chunkData(cx, cz) {
    return this._chunkDataAt(cx, this.floor, cz)
  }

  _chunkDataAt(cx, cy, cz) {
    if (this.source === 0) {
      return this.engine.cm.chunks.get(chunkKey3(cx, cy, cz))?.data ?? null
    }
    const key = `${this.previewSeed}:${chunkKey3(cx, cy, cz)}`
    let g = this._gen.get(key)
    if (!g) {
      g = generateChunk(this.previewSeed, cx, cy, cz)
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
  // Is this cell unavailable as an ordinary planar navigation node? Upper
  // atrium voids are floor holes; lower atrium halls intentionally remain
  // walkable even though their ceiling is open.
  // Mirrors pathfind's cellBlocked stair term with the tool's own data access
  // (EXPLORE mode has no ChunkManager to query).
  _stairBlocked(gx, gz) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = this._chunkData(cx, cz)
    if (!d) return false
    const lx = gx - cx * CHUNK
    const lz = gz - cz * CHUNK
    const stairRun = !!d.stairUp?.run?.some((cell) => cell.lx === lx && cell.lz === lz)
    return d.hasFloorHole(lx, lz) || stairRun
  }

  onShow() {}

  update() {
    if (this.followFloor) this.floor = this.engine.controller.floor
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
    const structuresByKey = new Map()
    let knownChunks = 0
    const wallW = Math.max(1, scale * 0.12)

    for (let ccz = c0z; ccz <= c1z; ccz++) {
      for (let ccx = c0x; ccx <= c1x; ccx++) {
        const d = this._chunkData(ccx, ccz)
        if (!d) continue
        knownChunks++
        const structure = d.multilevelStructure
        if (structure?.hasRoom) {
          structuresByKey.set(
            `${structure.id}:${structure.baseCy}:${structure.topCy}`,
            structure
          )
        }
        if (zoneN[d.zone] !== undefined) zoneN[d.zone]++
        const ox = ccx * CHUNK_WORLD
        const oz = ccz * CHUNK_WORLD

        // Zone tint.
        ctx.fillStyle = ZONE_TINT[d.zone] || 'rgba(120,110,60,.05)'
        ctx.fillRect(this._sx(ox), this._sy(oz), CHUNK_WORLD * scale, CHUNK_WORLD * scale)

        // Actual current-floor surface: void cells remain dark; the retained
        // narrow bridge is highlighted so a malformed/floating deck is obvious.
        for (let lz = 0; lz < CHUNK; lz++) {
          for (let lx = 0; lx < CHUNK; lx++) {
            if (d.hasFloorHole(lx, lz)) {
              ctx.fillStyle = 'rgba(4,4,3,.72)'
              ctx.fillRect(this._sx(ox + lx * CELL), this._sy(oz + lz * CELL), CELL * scale, CELL * scale)
            } else if (d.cellKind[lz * CHUNK + lx] === CELL_BRIDGE) {
              ctx.fillStyle = 'rgba(120,210,190,.28)'
              ctx.fillRect(this._sx(ox + lx * CELL), this._sy(oz + lz * CELL), CELL * scale, CELL * scale)
            }
          }
        }

        // Sealed-pocket overlay (cells unreached by the validator; stair
        // run/hole cells are non-nodes and get the hatch glyph instead).
        if (reached) {
          for (let lz = 0; lz < CHUNK; lz++) {
            for (let lx = 0; lx < CHUNK; lx++) {
              const stairRun = !!d.stairUp?.run?.some((cell) => cell.lx === lx && cell.lz === lz)
              if (d.hasFloorHole(lx, lz) || stairRun) continue
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

        const featureStroke = (wanted, color) => {
          ctx.strokeStyle = color
          ctx.lineWidth = Math.max(1.5, wallW * 1.4)
          ctx.beginPath()
          for (let z = 0; z < CHUNK; z++) {
            for (let line = 0; line < CHUNK; line++) {
              if (d.wallFeatureVAt(line, z) === wanted) {
                const x = this._sx(ox + line * CELL)
                ctx.moveTo(x, this._sy(oz + z * CELL))
                ctx.lineTo(x, this._sy(oz + (z + 1) * CELL))
              }
              if (d.wallFeatureHAt(z, line) === wanted) {
                const y = this._sy(oz + line * CELL)
                ctx.moveTo(this._sx(ox + z * CELL), y)
                ctx.lineTo(this._sx(ox + (z + 1) * CELL), y)
              }
            }
          }
          ctx.stroke()
        }
        featureStroke(WALL_WINDOW, '#8fd0c0')
        featureStroke(WALL_RAIL, '#d0aa58')

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

        // Stair glyphs (this floor's stairUp landing/run, stairDown hole/exit).
        this._drawStairs(d, ox, oz)

        // Lamps.
        for (const l of d.lamps) {
          const wx = ox + (l.lx + 0.5) * CELL
          const wz = oz + (l.lz + 0.5) * CELL
          if (l.lit) litN++; else deadN++
          this._lamp(wx, wz, l.lit)
        }

        // Border openings on the owned West/North lines.
        ctx.fillStyle = '#8fd0c0'
        this._borderOpenings(d, ox, oz)
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

    const visibleStructures = [...structuresByKey.values()]
    let selectedStructure = null
    let selectedSource = 'visible'
    if (this._hover) {
      selectedStructure = structureAtCell(
        visibleStructures,
        worldToCell(this._hover.wx),
        worldToCell(this._hover.wz),
        this.floor
      )
      if (selectedStructure) selectedSource = 'cursor'
    }
    const controller = this.engine.controller
    if (!selectedStructure && controller.floor === this.floor) {
      selectedStructure = structureAtCell(
        visibleStructures,
        worldToCell(controller.pos.x),
        worldToCell(controller.pos.z),
        this.floor
      )
      if (selectedStructure) selectedSource = 'player'
    }
    if (!selectedStructure) {
      selectedStructure = structureAtCell(
        visibleStructures,
        worldToCell(this.view.cx),
        worldToCell(this.view.cz),
        this.floor
      )
      if (selectedStructure) selectedSource = 'center'
    }
    if (!selectedStructure && visibleStructures.length > 0) {
      selectedStructure = visibleStructures[0]
    }

    let integrity = null
    if (this.validate) {
      const auditBox = multilevelAuditBox(
        selectedStructure,
        c0x,
        c1x,
        c0z,
        c1z,
        this.floor
      )
      // The audit builds a full 3D graph. Cache it while the viewed chunk box,
      // selected structure, seed/source, and live resident count stay
      // unchanged; drawing still runs every frame without rebuilding thousands
      // of graph nodes. Selecting a multilevel volume expands Y to its complete
      // canonical base..top span (up to ten floors).
      const integrityKey = [
        this.source,
        this.source === 0 ? this.engine.cm.seed : this.previewSeed,
        selectedStructure?.id ?? '-',
        auditBox.x0,
        auditBox.y0,
        auditBox.z0,
        auditBox.nx,
        auditBox.ny,
        auditBox.nz,
        this.source === 0 ? this.engine.cm.loadedCount : 0,
      ].join(':')
      if (this._integrityCache.key !== integrityKey) {
        this._integrityCache = {
          key: integrityKey,
          value: auditLayeredPatch(
            (cx, cy, cz) => this._chunkDataAt(cx, cy, cz),
            auditBox.x0,
            auditBox.y0,
            auditBox.z0,
            auditBox.nx,
            auditBox.ny,
            auditBox.nz
          ),
        }
      }
      integrity = this._integrityCache.value
    }

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
    this._floorRead.set(`cy ${this.floor}`)
    this._stat.conn.set(
      this.validate ? `cy ${this.floor} · ${reached.size}/${openCount} open · ${sealed} sealed` : 'off'
    )
    this._stat.integrity.set(
      integrity
        ? `${integrity.ok ? 'ok' : 'FAIL'} · desc ${integrity.mismatchedDescriptors} · holes ${integrity.holeMismatches} · orphan ${integrity.orphanedHalves} · bad links ${integrity.invalidCanonicalLinks}/${integrity.canonicalLinks} · comp ${integrity.components}`
        : 'off'
    )
    this._stat.multilevel.set(
      formatMultilevelStructure(
        visibleStructures,
        selectedStructure,
        selectedSource
      )
    )
    this._stat.multilevelAudit.set(formatMultilevelAudit(integrity))
    this._stat.cont.set(
      cont ? `score ${cont.score.toFixed(2)} · ${cont.sealed} unsafe · plan variety ${cont.planVariety.toFixed(2)}` : 'off'
    )
    this._stat.seed.set(`${this.source === 1 ? 'explore' : 'live'} 0x${(this.previewSeed >>> 0).toString(16)}`)
    this._stat.cursor.set(this._hover ? `${this._hover.wx.toFixed(1)}, ${this._hover.wz.toFixed(1)}` : '—')
  }

  // Mark openings on a chunk's owned West (lx=0) and North (lz=0) borders,
  // but only when that border is otherwise walled (skip fully-open halls).
  _borderOpenings(d, ox, oz) {
    let westWalled = false
    let northWalled = false
    for (let z = 0; z < CHUNK; z++) if (d.vAt(0, z) === 1) westWalled = true
    for (let x = 0; x < CHUNK; x++) if (d.hAt(x, 0) === 1) northWalled = true
    if (westWalled) {
      for (let z = 0; z < CHUNK; z++) {
        if (d.vAt(0, z) === 0) this._opening(ox, oz + (z + 0.5) * CELL)
      }
    }
    if (northWalled) {
      for (let x = 0; x < CHUNK; x++) {
        if (d.hAt(x, 0) === 0) this._opening(ox + (x + 0.5) * CELL, oz)
      }
    }
  }

  _opening(wx, wz) {
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
      // Draw walls first and openings on top so portals and mouths pop.
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

  // Stair glyphs for one chunk of the drawn floor. The up-stair contributes
  // its landing (gold up-triangle pointing along the ascent) and run cells;
  // the down-stair its exit (hollow triangle pointing back down the flight)
  // and hole cells. Run/hole cells get a subtle hatch — the slab is open
  // there and they are not walkable on this floor.
  _drawStairs(d, ox, oz) {
    if (!d.stairUp && !d.stairDown) return
    const ctx = this.ctx
    const w = CELL * this.view.scale
    ctx.strokeStyle = 'rgba(216,178,74,.35)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const s of [d.stairUp, d.stairDown]) {
      if (!s) continue
      for (const c of s.run) {
        const x = this._sx(ox + c.lx * CELL)
        const y = this._sy(oz + c.lz * CELL)
        ctx.moveTo(x, y + w)
        ctx.lineTo(x + w, y)
        ctx.moveTo(x, y + w * 0.5)
        ctx.lineTo(x + w * 0.5, y)
        ctx.moveTo(x + w * 0.5, y + w)
        ctx.lineTo(x + w, y + w * 0.5)
      }
    }
    ctx.stroke()
    if (d.stairUp) this._stairTri(ox, oz, d.stairUp.landing, d.stairUp.dir, false)
    if (d.stairDown) this._stairTri(ox, oz, d.stairDown.exit, d.stairDown.dir, true)
  }

  // Triangle in `cell` pointing along the ascent dir (0=N,1=E,2=S,3=W).
  // `down` flips it (a down-stair exit points back down the flight) and
  // hollows it so up/down read apart at a glance.
  _stairTri(ox, oz, cell, dir, down) {
    const ctx = this.ctx
    const x = this._sx(ox + (cell.lx + 0.5) * CELL)
    const y = this._sy(oz + (cell.lz + 0.5) * CELL)
    const r = Math.max(2.5, Math.min(6, CELL * this.view.scale * 0.35))
    const ang = [-Math.PI / 2, 0, Math.PI / 2, Math.PI][dir] + (down ? Math.PI : 0)
    const spread = Math.PI * 0.78
    ctx.beginPath()
    ctx.moveTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r)
    ctx.lineTo(x + Math.cos(ang + spread) * r, y + Math.sin(ang + spread) * r)
    ctx.lineTo(x + Math.cos(ang - spread) * r, y + Math.sin(ang - spread) * r)
    ctx.closePath()
    if (down) {
      ctx.strokeStyle = '#d8b24a'
      ctx.lineWidth = 1.2
      ctx.stroke()
    } else {
      ctx.fillStyle = '#d8b24a'
      ctx.fill()
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
    if (ex.cy !== this.floor) ctx.globalAlpha = 0.35 // exit lives on another floor
    ctx.fillStyle = '#7fffa0'
    ctx.beginPath()
    ctx.moveTo(x, y - 5)
    ctx.lineTo(x + 5, y)
    ctx.lineTo(x, y + 5)
    ctx.lineTo(x - 5, y)
    ctx.closePath()
    ctx.fill()
    ctx.globalAlpha = 1
  }

  _drawEntities() {
    const ctx = this.ctx
    const ctrl = this.engine.controller
    const p = ctrl.pos
    const yaw = ctrl.yaw
    const px = this._sx(p.x)
    const pz = this._sy(p.z)

    // Player wedge + dot, dimmed when the map shows a different floor.
    if (ctrl.floor !== this.floor) ctx.globalAlpha = 0.35
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
    ctx.globalAlpha = 1

    if (!this.dbg.aiOverlay) return

    // Stalker: solid square on this floor (with the full spawn-band debug),
    // hollow + floor-delta tag when it is above/below the drawn layer.
    const s = this.engine.stalker
    if (s.active || s.alwaysVisible) {
      const sx = this._sx(s.pos.x)
      const sz = this._sy(s.pos.z)
      if (s.cy === this.floor) {
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
      } else {
        ctx.strokeStyle = 'rgba(255,90,74,.65)'
        ctx.lineWidth = 1.2
        ctx.strokeRect(sx - 3, sz - 3, 6, 6)
        this._floorTag(sx, sz, s.cy - this.floor, 'rgba(255,90,74,.85)')
      }
    }

    // Pursuer: diamond in its dark blood-red; hollow + tag when off-floor.
    const u = this.engine.pursuer
    if (u && u.active) {
      const ux = this._sx(u.pos.x)
      const uz = this._sy(u.pos.z)
      ctx.beginPath()
      ctx.moveTo(ux, uz - 4)
      ctx.lineTo(ux + 4, uz)
      ctx.lineTo(ux, uz + 4)
      ctx.lineTo(ux - 4, uz)
      ctx.closePath()
      if (u.cy === this.floor) {
        ctx.fillStyle = '#c04038'
        ctx.fill()
      } else {
        ctx.strokeStyle = 'rgba(192,64,56,.7)'
        ctx.lineWidth = 1.2
        ctx.stroke()
        this._floorTag(ux, uz, u.cy - this.floor, 'rgba(192,64,56,.85)')
      }
    }
  }

  // Small `↑n`/`↓n` tag beside an off-floor entity marker.
  _floorTag(x, y, delta, color) {
    const ctx = this.ctx
    ctx.fillStyle = color
    ctx.font = '10px ui-monospace, monospace'
    ctx.fillText(`${delta > 0 ? '↑' : '↓'}${Math.abs(delta)}`, x + 5, y - 4)
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

  // Flood OPEN cells (thin-wall adjacency) of the drawn floor from the
  // player's cell across the visible region; reports sealed pockets. Stair
  // run/hole cells are not walkable graph nodes (pathfind's cellBlocked rule),
  // so the flood never enters them. Reuses the shared floodReachable.
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
      if (this._stairBlocked(minGx + bx, minGz + bz)) return false
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
    // The seed itself must be a walkable, KNOWN cell of the drawn floor: the
    // player may be mid-ramp (their cell is stair-blocked here), or the tool
    // may be viewing another floor — else the whole patch reads as sealed.
    const seedBad = (x, z) =>
      this._stairBlocked(minGx + x, minGz + z) ||
      !this._chunkData(Math.floor((minGx + x) / CHUNK), Math.floor((minGz + z) / CHUNK))
    if (seedBad(sx, sz)) {
      search: for (let ring = 1; ring < Math.max(W, H); ring++) {
        for (let oz = -ring; oz <= ring; oz++) {
          for (let ox = -ring; ox <= ring; ox++) {
            if (Math.max(Math.abs(ox), Math.abs(oz)) !== ring) continue
            const nx = sx + ox
            const nz = sz + oz
            if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue
            if (seedBad(nx, nz)) continue
            sx = nx
            sz = nz
            break search
          }
        }
      }
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
        if (this._stairBlocked(gx, gz)) continue // ramp/hole: not an open cell
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
