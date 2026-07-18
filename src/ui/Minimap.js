import { CELL, CHUNK, FOV, COL_HALF, chunkKey3 } from '../world/constants.js'
import { STAIR_DX, STAIR_DZ } from '../world/slab.js'
import { CELL_BRIDGE, WALL_RAIL, WALL_WINDOW } from '../world/mapTypes.js'

// Player-explored HUD minimap — a small circular "locator" disc, north-up and
// player-centric, that draws ONLY the fog-of-war cells the player has seen (fed
// by ExploredMap). Pure 2D canvas; reuses the drawing idioms proven in the
// debug WorldMapTool (DPR setup, world->screen, batched wall stroke, lamp arcs,
// exit diamond, FOV-wedge math) but with the game's warm palette and a soft
// scope vignette instead of debug lines. Visibility is the AND of the `minimap`
// setting (this.visible / the .mapwrap .hidden class) and the HUD being shown
// (#hud.hidden handles every non-PLAYING phase).

// Single source of truth for the disc's CSS pixel size — overlays.js reads
// this for the .mapwrap bezel + canvas markup so they can never drift.
export const MINIMAP_SIZE = 150
const SIZE = MINIMAP_SIZE
const SCALE = 4.0 // px per world unit (~±6 cells visible, near MAP_REVEAL_R)

// Mirrors the #ui design tokens in overlays.js (a canvas can't read CSS custom
// properties per frame without a getComputedStyle round-trip).
const C = {
  fog: 'rgba(13,11,6,.92)', // opaque warm-dark unexplored base
  seen: 'rgba(244,233,200,.07)', // --paper at low alpha
  bridge: 'rgba(159,208,192,.22)',
  wall: '#8a7a3f', // --gold-dim
  window: '#9fd0c0',
  rail: '#c0a95a',
  column: '#5c5128',
  lamp: '#e8cf7a', // --gold
  lampGlow: 'rgba(232,207,122,.9)',
  player: '#e8cf7a', // --gold
  playerGlow: 'rgba(232,207,122,.85)',
  cone: 'rgba(232,207,122,.16)',
  exit: '#9fd0c0', // --mint
  exitGlow: 'rgba(159,208,192,.9)',
  rim: 'rgba(8,7,4,.7)',
  tick: 'rgba(244,233,200,.65)',
}

// Canvas animation (the exit pulse) honours the same reduced-motion signal the
// CSS uses; checked once — a live change just needs a reload.
const REDUCED_MOTION =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export class Minimap {
  constructor(canvas) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.visible = false
    this.resize()
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.dpr = dpr
    this.canvas.width = SIZE * dpr
    this.canvas.height = SIZE * dpr
    this.canvas.style.width = SIZE + 'px'
    this.canvas.style.height = SIZE + 'px'
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  setVisible(v) {
    this.visible = v
    // Toggle the circular bezel wrapper (.mapwrap) so the device hides cleanly.
    this.canvas.parentElement?.classList.toggle('hidden', !v)
  }

  // North-up, player-centric: world +x -> screen right, world +z -> screen down
  // (same basis as WorldMapTool, so its cone/exit math carries over unchanged).
  _sx(wx, px) {
    return SIZE / 2 + (wx - px) * SCALE
  }
  _sy(wz, pz) {
    return SIZE / 2 + (wz - pz) * SCALE
  }

  // v8: `floor` filters everything to the player's current layer — each floor
  // has its own fog (ExploredMap keys per cy), stairs get ▲/▼ glyphs, and a
  // floor indicator sits in the disc. Changing floors just swaps which masks
  // are read; the old floor's map is preserved for the way back.
  update({ controller, exit, exitRevealed, store, floor = 0 }) {
    if (!this.visible) return
    const ctx = this.ctx
    const px = controller.pos.x
    const pz = controller.pos.z
    ctx.clearRect(0, 0, SIZE, SIZE)

    // Opaque warm-dark base so unexplored area reads as solid fog (and the lit
    // 3D scene behind the disc doesn't bleed through the translucent wrapper).
    ctx.fillStyle = C.fog
    ctx.fillRect(0, 0, SIZE, SIZE)

    // Cell window covering the disc (+1 margin), centred on the player cell.
    const cR = Math.ceil(SIZE / 2 / SCALE / CELL) + 1
    const pgx = Math.floor(px / CELL)
    const pgz = Math.floor(pz / CELL)
    const gx0 = pgx - cR
    const gx1 = pgx + cR
    const gz0 = pgz - cR
    const gz1 = pgz + cR

    // 1) Revealed floor tiles — explored reads as warm cream, unknown stays fog.
    const tile = CELL * SCALE + 1
    ctx.fillStyle = C.seen
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (!store.isRevealed(gx, gz, floor)) continue
        if (store.floorHoleAt?.(gx, gz, floor)) continue
        ctx.fillRect(this._sx(gx * CELL, px), this._sy(gz * CELL, pz), tile, tile)
      }
    }
    // Retained bridge decks read distinctly against the unfilled atrium void.
    ctx.fillStyle = C.bridge
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (!store.isRevealed(gx, gz, floor)) continue
        if (store.cellKindAt?.(gx, gz, floor) !== CELL_BRIDGE) continue
        ctx.fillRect(this._sx(gx * CELL, px), this._sy(gz * CELL, pz), tile, tile)
      }
    }

    // 2) Walls — only the edges of revealed cells, batched into one stroke.
    ctx.strokeStyle = C.wall
    ctx.lineWidth = 1.2
    ctx.lineCap = 'round'
    ctx.beginPath()
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (!store.isRevealed(gx, gz, floor)) continue
        const xL = this._sx(gx * CELL, px)
        const xR = this._sx((gx + 1) * CELL, px)
        const yT = this._sy(gz * CELL, pz)
        const yB = this._sy((gz + 1) * CELL, pz)
        if (store.wallVAt(gx, gz, floor)) {
          ctx.moveTo(xL, yT)
          ctx.lineTo(xL, yB)
        }
        if (store.wallVAt(gx + 1, gz, floor)) {
          ctx.moveTo(xR, yT)
          ctx.lineTo(xR, yB)
        }
        if (store.wallHAt(gx, gz, floor)) {
          ctx.moveTo(xL, yT)
          ctx.lineTo(xR, yT)
        }
        if (store.wallHAt(gx, gz + 1, floor)) {
          ctx.moveTo(xL, yB)
          ctx.lineTo(xR, yB)
        }
      }
    }
    ctx.stroke()

    // Observation windows and bridge rails are still physical walls, but a
    // second colored pass prevents the map from presenting them as opaque
    // ordinary partitions.
    const drawFeatures = (wanted, color) => {
      ctx.strokeStyle = color
      ctx.lineWidth = wanted === WALL_WINDOW ? 1.8 : 1.4
      ctx.beginPath()
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          if (!store.isRevealed(gx, gz, floor)) continue
          const xL = this._sx(gx * CELL, px)
          const xR = this._sx((gx + 1) * CELL, px)
          const yT = this._sy(gz * CELL, pz)
          const yB = this._sy((gz + 1) * CELL, pz)
          if (store.wallFeatureVAt?.(gx, gz, floor) === wanted) {
            ctx.moveTo(xL, yT); ctx.lineTo(xL, yB)
          }
          if (store.wallFeatureVAt?.(gx + 1, gz, floor) === wanted) {
            ctx.moveTo(xR, yT); ctx.lineTo(xR, yB)
          }
          if (store.wallFeatureHAt?.(gx, gz, floor) === wanted) {
            ctx.moveTo(xL, yT); ctx.lineTo(xR, yT)
          }
          if (store.wallFeatureHAt?.(gx, gz + 1, floor) === wanted) {
            ctx.moveTo(xL, yB); ctx.lineTo(xR, yB)
          }
        }
      }
      ctx.stroke()
    }
    drawFeatures(WALL_WINDOW, C.window)
    drawFeatures(WALL_RAIL, C.rail)

    // 3) Columns (revealed cells only).
    ctx.fillStyle = C.column
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (!store.isRevealed(gx, gz, floor)) continue
        if (!store.columnAt(gx, gz, floor)) continue
        const half = store.columnHalfAt?.(gx, gz, floor) || COL_HALF
        const csz = Math.max(2, half * 2 * SCALE)
        const x = this._sx((gx + 0.5) * CELL, px)
        const y = this._sy((gz + 0.5) * CELL, pz)
        ctx.fillRect(x - csz / 2, y - csz / 2, csz, csz)
      }
    }

    // 4) Stair glyphs on revealed cells: ▲ gold at an up-stair's landing,
    // ▼ mint at a down-stair's exit — discovered stairwells are the primary
    // wayfinding anchors of an infinite layered map.
    this._drawStairs(store, floor, px, pz, gx0, gx1, gz0, gz1)

    // 5) Lit lamps in revealed cells — faint warm glow (the fluorescent motif).
    this._drawLamps(store, floor, px, pz, gx0, gx1, gz0, gz1)

    // 6) Exit — only once its cell has actually been discovered, and only on
    // its own floor.
    if (exitRevealed && exit && (exit.cy ?? 0) === floor) this._drawExit(exit, px, pz)

    // 7) Player wedge + dot at the disc centre.
    this._drawPlayer(controller.yaw)

    // 8) Scope vignette + N tick + floor indicator.
    this._drawFrame(floor)
  }

  _drawStairs(store, floor, px, pz, gx0, gx1, gz0, gz1) {
    const ctx = this.ctx
    ctx.save()
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (!store.isRevealed(gx, gz, floor)) continue
        const s = store.stairAt(gx, gz, floor)
        if (!s) continue
        // One glyph per stair: at the landing (up) / at the exit cell (down).
        const up = s.part === 'landing'
        if (!up && s.part !== 'exit') continue
        const x = this._sx((gx + 0.5) * CELL, px)
        const y = this._sy((gz + 0.5) * CELL, pz)
        // Chevron points along the walking direction: ascent for ▲ (gold),
        // toward the hole for ▼ (mint, i.e. against the ascent direction).
        const dx = STAIR_DX[s.dir] * (up ? 1 : -1)
        const dz = STAIR_DZ[s.dir] * (up ? 1 : -1)
        const r = 4
        ctx.fillStyle = up ? C.lamp : C.exit
        ctx.shadowColor = up ? C.lampGlow : C.exitGlow
        ctx.shadowBlur = 3
        ctx.beginPath()
        ctx.moveTo(x + dx * r, y + dz * r) // tip
        ctx.lineTo(x - dz * r * 0.8 - dx * r * 0.6, y + dx * r * 0.8 - dz * r * 0.6)
        ctx.lineTo(x + dz * r * 0.8 - dx * r * 0.6, y - dx * r * 0.8 - dz * r * 0.6)
        ctx.closePath()
        ctx.fill()
      }
    }
    ctx.restore()
  }

  _drawLamps(store, floor, px, pz, gx0, gx1, gz0, gz1) {
    const ctx = this.ctx
    const c0x = Math.floor(gx0 / CHUNK)
    const c1x = Math.floor(gx1 / CHUNK)
    const c0z = Math.floor(gz0 / CHUNK)
    const c1z = Math.floor(gz1 / CHUNK)
    ctx.save()
    ctx.fillStyle = C.lamp
    ctx.shadowColor = C.lampGlow
    ctx.shadowBlur = 4
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const e = store.chunks.get(chunkKey3(cx, floor, cz))
        if (!e || !e.data) continue
        for (const l of e.data.lamps) {
          if (!l.lit) continue
          const gx = cx * CHUNK + l.lx
          const gz = cz * CHUNK + l.lz
          if (!store.isRevealed(gx, gz, floor)) continue
          const x = this._sx((l.lx + 0.5) * CELL + cx * CHUNK * CELL, px)
          const y = this._sy((l.lz + 0.5) * CELL + cz * CHUNK * CELL, pz)
          ctx.beginPath()
          ctx.arc(x, y, 1.4, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
    ctx.restore()
  }

  _drawExit(exit, px, pz) {
    const ctx = this.ctx
    const wx = exit.cx * CHUNK * CELL + (exit.lx + 0.5) * CELL
    const wz = exit.cz * CHUNK * CELL + (exit.lz + 0.5) * CELL
    const x = this._sx(wx, px)
    const y = this._sy(wz, pz)
    // Mint diamond with a slow breathing pulse (static under reduced motion).
    const t = REDUCED_MOTION ? 1 : 0.72 + 0.28 * Math.sin(performance.now() / 320)
    const r = 4 + t * 1.5
    ctx.save()
    ctx.globalAlpha = 0.6 + 0.4 * t
    ctx.fillStyle = C.exit
    ctx.shadowColor = C.exitGlow
    ctx.shadowBlur = 4 + 4 * t
    ctx.beginPath()
    ctx.moveTo(x, y - r)
    ctx.lineTo(x + r, y)
    ctx.lineTo(x, y + r)
    ctx.lineTo(x - r, y)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  _drawPlayer(yaw) {
    const ctx = this.ctx
    const c = SIZE / 2
    const ang = Math.atan2(-Math.cos(yaw), -Math.sin(yaw)) // matches _sx/_sy basis
    const half = (FOV * Math.PI) / 180 / 2
    const len = 16
    ctx.fillStyle = C.cone
    ctx.beginPath()
    ctx.moveTo(c, c)
    ctx.arc(c, c, len, ang - half, ang + half)
    ctx.closePath()
    ctx.fill()
    ctx.save()
    ctx.shadowColor = C.playerGlow
    ctx.shadowBlur = 6
    ctx.fillStyle = C.player
    ctx.beginPath()
    ctx.arc(c, c, 3, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  _drawFrame(floor = 0) {
    const ctx = this.ctx
    const c = SIZE / 2
    // Soft scope falloff toward the rim.
    const g = ctx.createRadialGradient(c, c, SIZE * 0.28, c, c, c)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, C.rim)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, SIZE, SIZE)
    // North tick.
    ctx.fillStyle = C.tick
    ctx.font = '9px ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText('N', c, 5)
    ctx.strokeStyle = 'rgba(244,233,200,.45)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(c, 14)
    ctx.lineTo(c, 19)
    ctx.stroke()
    // Floor indicator: F0 ground, F2 above, B1 below (basement).
    ctx.fillStyle = C.tick
    ctx.textBaseline = 'bottom'
    ctx.fillText(floor >= 0 ? `F${floor}` : `B${-floor}`, c, SIZE - 5)
  }
}
