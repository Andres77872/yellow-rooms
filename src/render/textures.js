import * as THREE from 'three'

// All surface albedo is generated procedurally on a <canvas> — zero asset
// files. Backrooms art direction: desaturated beige/tan in isolation; the
// mono-yellow comes from warm light + the post grade, never neon paint.

function canvas(size = 256) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  return c
}

function finish(c, repeat, aniso) {
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.repeat.set(repeat, repeat)
  tex.anisotropy = aniso
  tex.needsUpdate = true
  return tex
}

// Helper: deterministic-ish speckle using Math.random (visual only, not gameplay).
function speckle(ctx, size, count, colors, min, max) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[(Math.random() * colors.length) | 0]
    const r = min + Math.random() * (max - min)
    ctx.globalAlpha = 0.25 + Math.random() * 0.5
    ctx.beginPath()
    ctx.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

// Damp, stained, flecked Berber carpet.
export function carpetTexture(aniso) {
  const s = 256
  const c = canvas(s)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#cbb86e'
  ctx.fillRect(0, 0, s, s)
  // fine flecks
  speckle(ctx, s, 2400, ['#bcaa62', '#dccb84', '#a7984f', '#8c8244'], 0.5, 1.3)
  // soft damp stains (subtle, not black blobs)
  speckle(ctx, s, 10, ['#a89a55', '#9c8d4c', '#b3a35a'], 6, 15)
  return finish(c, 1, aniso)
}

// Mono-yellow wallpaper with faint vertical seams + grime toward the bottom.
export function wallpaperTexture(aniso) {
  const s = 256
  const c = canvas(s)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#d4cfa5'
  ctx.fillRect(0, 0, s, s)
  // vertical wallpaper strips
  ctx.globalAlpha = 0.06
  for (let x = 0; x < s; x += 32) {
    ctx.fillStyle = '#8b853c'
    ctx.fillRect(x, 0, 1, s)
  }
  ctx.globalAlpha = 1
  // subtle highlight band near the top, grime near the floor
  const grime = ctx.createLinearGradient(0, 0, 0, s)
  grime.addColorStop(0, 'rgba(248,241,168,0.18)')
  grime.addColorStop(0.6, 'rgba(0,0,0,0)')
  grime.addColorStop(1, 'rgba(120,110,50,0.32)')
  ctx.fillStyle = grime
  ctx.fillRect(0, 0, s, s)
  speckle(ctx, s, 200, ['#8b853c', '#bdb578'], 0.5, 1.6)
  return finish(c, 1, aniso)
}

// Drop-ceiling acoustic tile with a T-bar grid.
export function ceilingTexture(aniso) {
  const s = 256
  const c = canvas(s)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#cfcca2'
  ctx.fillRect(0, 0, s, s)
  speckle(ctx, s, 1400, ['#c2bf95', '#d7d3a2', '#b6b288'], 0.5, 1.2)
  // T-bar grid
  ctx.strokeStyle = '#9c9a78'
  ctx.lineWidth = 4
  ctx.strokeRect(0, 0, s, s)
  ctx.beginPath()
  ctx.moveTo(s / 2, 0)
  ctx.lineTo(s / 2, s)
  ctx.moveTo(0, s / 2)
  ctx.lineTo(s, s / 2)
  ctx.stroke()
  return finish(c, 1, aniso)
}
