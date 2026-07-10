import * as THREE from 'three'

// All surface albedo is generated procedurally on a <canvas> — zero asset
// files. Anime-backrooms art direction: CLEAN flat fields with sparse, soft
// detail (a painted background, not a photo texture), hues kept warm-gold —
// never olive. The noise/speckle is deliberately sparse and low-contrast;
// heavy speckle reads as photographic grime and fights the cel shading. The
// mono-yellow mood comes from warm light + the post grade, never neon paint.

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

// Warm honey-gold carpet: a mostly-flat painted field with sparse soft flecks.
// Hue pulled off olive toward amber so lamp pools read gold, not green.
export function carpetTexture(aniso) {
  const s = 256
  const c = canvas(s)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#cfae5e'
  ctx.fillRect(0, 0, s, s)
  // fine flecks — sparse and tone-on-tone (clean anime field, not photo grain)
  speckle(ctx, s, 900, ['#c4a355', '#dcbd6f', '#b89a4e'], 0.5, 1.3)
  // soft damp stains (subtle, not black blobs)
  speckle(ctx, s, 7, ['#b3924a', '#c2a054'], 6, 15)
  return finish(c, 1, aniso)
}

// Warm cream wallpaper: a clean field with faint vertical seams and a soft
// painted top-light / floor-shade gradient (background-art shading, not grime).
export function wallpaperTexture(aniso) {
  const s = 256
  const c = canvas(s)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#e2d8a8'
  ctx.fillRect(0, 0, s, s)
  // vertical wallpaper strips
  ctx.globalAlpha = 0.05
  for (let x = 0; x < s; x += 32) {
    ctx.fillStyle = '#93803e'
    ctx.fillRect(x, 0, 1, s)
  }
  ctx.globalAlpha = 1
  // subtle highlight band near the top, soft shade near the floor
  const grime = ctx.createLinearGradient(0, 0, 0, s)
  grime.addColorStop(0, 'rgba(252,244,180,0.16)')
  grime.addColorStop(0.6, 'rgba(0,0,0,0)')
  grime.addColorStop(1, 'rgba(120,100,50,0.22)')
  ctx.fillStyle = grime
  ctx.fillRect(0, 0, s, s)
  speckle(ctx, s, 70, ['#a89550', '#cdbf7e'], 0.5, 1.6)
  return finish(c, 1, aniso)
}

// Drop-ceiling acoustic tile: clean warm off-white field with a graphic T-bar
// grid (crisp dark lines — the drawn-line look, matching the ink outlines).
export function ceilingTexture(aniso) {
  const s = 256
  const c = canvas(s)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#ddd8b4'
  ctx.fillRect(0, 0, s, s)
  speckle(ctx, s, 450, ['#d2cda6', '#e6e1bd'], 0.5, 1.2)
  // T-bar grid
  ctx.strokeStyle = '#8d8863'
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
