import { CELL, CHUNK, FOV, COL_HALF, chunkKey } from '../world/constants.js'

// Player-explored HUD minimap — a small circular "locator" disc, north-up and
// player-centric, that draws ONLY the fog-of-war cells the player has seen (fed
// by ExploredMap). Pure 2D canvas; reuses the drawing idioms proven in the
// debug WorldMapTool (DPR setup, world->screen, batched wall stroke, lamp arcs,
// exit diamond, FOV-wedge math) but with the game's warm palette and a soft
// scope vignette instead of debug lines. Visibility is the AND of the `minimap`
// setting (this.visible / the .mapwrap .hidden class) and the HUD being shown
// (#hud.hidden handles every non-PLAYING phase).
const SIZE = 150 // CSS px (matches the .mapwrap bezel)
const SCALE = 4.0 // px per world unit (~±6 cells visible, near MAP_REVEAL_R)

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

  update({ controller, exit, exitRevealed, store }) {
    if (!this.visible) return
    const ctx = this.ctx
    const px = controller.pos.x
    const pz = controller.pos.z
    ctx.clearRect(0, 0, SIZE, SIZE)

    // Opaque warm-dark base so unexplored area reads as solid fog (and the lit
    // 3D scene behind the disc doesn't bleed through the translucent wrapper).
    ctx.fillStyle = 'rgba(11,11,7,.92)'
    ctx.fillRect(0, 0, SIZE, SIZE)

    // Cell window covering the disc (+1 margin), centred on the player cell.
    const cR = Math.ceil(SIZE / 2 / SCALE / CELL) + 1
    const pgx = Math.floor(px / CELL)
    const pgz = Math.floor(pz / CELL)
    const gx0 = pgx - cR
    const gx1 = pgx + cR
    const gz0 = pgz - cR
    const gz1 = pgz + cR

    // 1) Revealed floor tiles — explored reads as dim-warm, unknown stays black.
    const tile = CELL * SCALE + 1
    ctx.fillStyle = 'rgba(120,110,60,.06)'
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (!store.isRevealed(gx, gz)) continue
        ctx.fillRect(this._sx(gx * CELL, px), this._sy(gz * CELL, pz), tile, tile)
      }
    }

    // 2) Walls — only the edges of revealed cells, batched into one stroke.
    ctx.strokeStyle = '#b8a85a'
    ctx.lineWidth = 1.4
    ctx.lineCap = 'round'
    ctx.beginPath()
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (!store.isRevealed(gx, gz)) continue
        const xL = this._sx(gx * CELL, px)
        const xR = this._sx((gx + 1) * CELL, px)
        const yT = this._sy(gz * CELL, pz)
        const yB = this._sy((gz + 1) * CELL, pz)
        if (store.wallVAt(gx, gz)) {
          ctx.moveTo(xL, yT)
          ctx.lineTo(xL, yB)
        }
        if (store.wallVAt(gx + 1, gz)) {
          ctx.moveTo(xR, yT)
          ctx.lineTo(xR, yB)
        }
        if (store.wallHAt(gx, gz)) {
          ctx.moveTo(xL, yT)
          ctx.lineTo(xR, yT)
        }
        if (store.wallHAt(gx, gz + 1)) {
          ctx.moveTo(xL, yB)
          ctx.lineTo(xR, yB)
        }
      }
    }
    ctx.stroke()

    // 3) Columns (revealed cells only).
    ctx.fillStyle = '#6e6230'
    const csz = Math.max(2, COL_HALF * 2 * SCALE)
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (!store.isRevealed(gx, gz)) continue
        if (!store.columnAt(gx, gz)) continue
        const x = this._sx((gx + 0.5) * CELL, px)
        const y = this._sy((gz + 0.5) * CELL, pz)
        ctx.fillRect(x - csz / 2, y - csz / 2, csz, csz)
      }
    }

    // 4) Lit lamps in revealed cells — faint warm glow (the fluorescent motif).
    this._drawLamps(store, px, pz, gx0, gx1, gz0, gz1)

    // 5) Exit — only once its cell has actually been discovered.
    if (exitRevealed && exit) this._drawExit(exit, px, pz)

    // 6) Player wedge + dot at the disc centre.
    this._drawPlayer(controller.yaw)

    // 7) Scope vignette + N tick.
    this._drawFrame()
  }

  _drawLamps(store, px, pz, gx0, gx1, gz0, gz1) {
    const ctx = this.ctx
    const c0x = Math.floor(gx0 / CHUNK)
    const c1x = Math.floor(gx1 / CHUNK)
    const c0z = Math.floor(gz0 / CHUNK)
    const c1z = Math.floor(gz1 / CHUNK)
    ctx.save()
    ctx.fillStyle = '#f8f1a8'
    ctx.shadowColor = 'rgba(248,241,168,.9)'
    ctx.shadowBlur = 4
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const e = store.chunks.get(chunkKey(cx, cz))
        if (!e || !e.data) continue
        for (const l of e.data.lamps) {
          if (!l.lit) continue
          const gx = cx * CHUNK + l.lx
          const gz = cz * CHUNK + l.lz
          if (!store.isRevealed(gx, gz)) continue
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
    ctx.save()
    ctx.fillStyle = '#7fffa0'
    ctx.shadowColor = 'rgba(127,255,160,.9)'
    ctx.shadowBlur = 6
    ctx.beginPath()
    ctx.moveTo(x, y - 5)
    ctx.lineTo(x + 5, y)
    ctx.lineTo(x, y + 5)
    ctx.lineTo(x - 5, y)
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
    ctx.fillStyle = 'rgba(248,241,168,.18)'
    ctx.beginPath()
    ctx.moveTo(c, c)
    ctx.arc(c, c, len, ang - half, ang + half)
    ctx.closePath()
    ctx.fill()
    ctx.save()
    ctx.shadowColor = 'rgba(248,241,168,.85)'
    ctx.shadowBlur = 6
    ctx.fillStyle = '#f8f1a8'
    ctx.beginPath()
    ctx.arc(c, c, 3, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  _drawFrame() {
    const ctx = this.ctx
    const c = SIZE / 2
    // Soft scope falloff toward the rim.
    const g = ctx.createRadialGradient(c, c, SIZE * 0.28, c, c, c)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, 'rgba(8,8,5,.7)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, SIZE, SIZE)
    // North tick.
    ctx.fillStyle = 'rgba(233,225,163,.7)'
    ctx.font = '9px ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText('N', c, 5)
    ctx.strokeStyle = 'rgba(233,225,163,.5)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(c, 14)
    ctx.lineTo(c, 19)
    ctx.stroke()
  }
}
