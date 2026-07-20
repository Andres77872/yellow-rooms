import * as THREE from 'three'

// All surface albedo is generated procedurally on a <canvas> — zero asset
// files. Anime-backrooms art direction: CLEAN flat fields with sparse, soft
// detail (a painted background, not a photo texture). The noise/speckle is
// deliberately sparse and low-contrast; heavy speckle reads as photographic
// grime and fights the cel shading. Mood comes from light + the post grade,
// never neon paint.
//
// Every generator takes a palette spec (world/familyPalette.js) so each map
// family renders its own surface language: office carpet/wallpaper/tile,
// sewer concrete/brick/vault, tower tile/panel, lattice deck/steel.

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

// Soft painted top-light / floor-shade vertical gradient (background-art
// shading, not grime) shared by every wall style.
function wallGradient(ctx, s, spec) {
  const g = ctx.createLinearGradient(0, 0, 0, s)
  g.addColorStop(0, spec.topLight ?? 'rgba(255,255,255,0.10)')
  g.addColorStop(0.6, 'rgba(0,0,0,0)')
  g.addColorStop(1, spec.floorShade ?? 'rgba(0,0,0,0.22)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, s, s)
}

// ---------------------------------------------------------------------------
// Floors. UVs are 1 repeat per cell (3 m), so the 256px canvas spans one cell.

// Warm carpet: a mostly-flat painted field with sparse soft flecks.
function floorCarpet(ctx, s, spec) {
  speckle(ctx, s, 900, spec.flecks, 0.5, 1.3)
  speckle(ctx, s, 7, spec.stains, 6, 15)
}

// Poured concrete walkway: broad damp blotches, a few hairline cracks, and a
// shallow perimeter darkening so slabs read as individually poured bays.
function floorConcrete(ctx, s, spec) {
  speckle(ctx, s, 350, spec.flecks, 0.6, 1.6)
  speckle(ctx, s, 10, spec.stains, 8, 22)
  ctx.strokeStyle = spec.stains[0]
  ctx.globalAlpha = 0.35
  ctx.lineWidth = 1
  for (let i = 0; i < 3; i++) {
    ctx.beginPath()
    let x = Math.random() * s
    let y = Math.random() * s
    ctx.moveTo(x, y)
    for (let k = 0; k < 4; k++) {
      x += (Math.random() - 0.5) * 70
      y += 20 + Math.random() * 40
      ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 0.25
  ctx.strokeStyle = spec.stains[spec.stains.length - 1]
  ctx.lineWidth = 6
  ctx.strokeRect(1, 1, s - 2, s - 2)
  ctx.globalAlpha = 1
}

// Large pale tiles: 2×2 per cell (1.5 m tiles) with crisp grout lines — the
// drawn-line look, matching the ink outlines.
function floorTile(ctx, s, spec) {
  speckle(ctx, s, 260, spec.flecks, 0.5, 1.2)
  ctx.strokeStyle = spec.grout ?? spec.line
  ctx.lineWidth = 3
  ctx.strokeRect(0, 0, s, s)
  ctx.beginPath()
  ctx.moveTo(s / 2, 0)
  ctx.lineTo(s / 2, s)
  ctx.moveTo(0, s / 2)
  ctx.lineTo(s, s / 2)
  ctx.stroke()
}

// Steel deck plate: panel seams on two edges plus sparse short tread dashes.
function floorDeck(ctx, s, spec) {
  speckle(ctx, s, 220, spec.flecks, 0.5, 1.2)
  ctx.strokeStyle = spec.seam
  ctx.lineWidth = 4
  ctx.strokeRect(0, 0, s, s)
  ctx.globalAlpha = 0.55
  ctx.fillStyle = spec.seam
  for (let i = 0; i < 46; i++) {
    const x = Math.random() * (s - 14)
    const y = Math.random() * (s - 6)
    if (Math.random() < 0.5) ctx.fillRect(x, y, 12, 2)
    else ctx.fillRect(x, y, 2, 12)
  }
  ctx.globalAlpha = 1
}

export function floorTexture(aniso, spec) {
  const s = 256
  const c = canvas(s)
  const ctx = c.getContext('2d')
  ctx.fillStyle = spec.base
  ctx.fillRect(0, 0, s, s)
  if (spec.style === 'concrete') floorConcrete(ctx, s, spec)
  else if (spec.style === 'tile') floorTile(ctx, s, spec)
  else if (spec.style === 'deck') floorDeck(ctx, s, spec)
  else floorCarpet(ctx, s, spec)
  return finish(c, 1, aniso)
}

// ---------------------------------------------------------------------------
// Walls. Each wall segment is one unit box (≤ 3 m wide, 3.2 m tall), so the
// canvas spans one segment.

// Cream wallpaper: faint vertical seams over a clean field.
function wallWallpaper(ctx, s, spec) {
  ctx.globalAlpha = 0.05
  ctx.fillStyle = spec.seam
  for (let x = 0; x < s; x += 32) ctx.fillRect(x, 0, 1, s)
  ctx.globalAlpha = 1
  wallGradient(ctx, s, spec)
  speckle(ctx, s, 70, spec.flecks, 0.5, 1.6)
}

// Aged brick courses: running bond with painted mortar joints and a damp tide
// band low on the wall — the sewer gallery read.
function wallBrick(ctx, s, spec) {
  const rows = 10
  const rh = s / rows
  const bw = s / 4
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * (bw / 2)
    for (let b = -1; b < 5; b++) {
      const x = b * bw + off
      ctx.fillStyle = spec.variants[(Math.random() * spec.variants.length) | 0]
      ctx.fillRect(x + 1.5, r * rh + 1.5, bw - 3, rh - 3)
    }
  }
  ctx.strokeStyle = spec.mortar
  ctx.lineWidth = 3
  ctx.globalAlpha = 0.9
  for (let r = 0; r <= rows; r++) {
    ctx.beginPath()
    ctx.moveTo(0, r * rh)
    ctx.lineTo(s, r * rh)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  // damp tide band rising from the floor line
  const tide = ctx.createLinearGradient(0, s * 0.55, 0, s)
  tide.addColorStop(0, 'rgba(0,0,0,0)')
  tide.addColorStop(1, spec.tide)
  ctx.fillStyle = tide
  ctx.fillRect(0, 0, s, s)
  wallGradient(ctx, s, spec)
}

// Smooth interior panels: crisp horizontal joint lines at thirds.
function wallPanel(ctx, s, spec) {
  ctx.globalAlpha = 0.35
  ctx.strokeStyle = spec.seam
  ctx.lineWidth = 2
  for (const t of [1 / 3, 2 / 3]) {
    ctx.beginPath()
    ctx.moveTo(0, s * t)
    ctx.lineTo(s, s * t)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  wallGradient(ctx, s, spec)
  speckle(ctx, s, 50, spec.flecks, 0.5, 1.4)
}

// Riveted steel plate: panel border seams and rivet dots down both edges.
function wallSteel(ctx, s, spec) {
  ctx.strokeStyle = spec.seam
  ctx.lineWidth = 4
  ctx.strokeRect(0, 0, s, s)
  ctx.globalAlpha = 0.4
  ctx.beginPath()
  ctx.moveTo(0, s / 2)
  ctx.lineTo(s, s / 2)
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.fillStyle = spec.rivet
  for (const x of [10, s - 10]) {
    for (let y = 14; y < s; y += 30) {
      ctx.beginPath()
      ctx.arc(x, y, 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  wallGradient(ctx, s, spec)
  speckle(ctx, s, 60, spec.flecks, 0.5, 1.4)
}

export function wallTexture(aniso, spec) {
  const s = 256
  const c = canvas(s)
  const ctx = c.getContext('2d')
  ctx.fillStyle = spec.base
  ctx.fillRect(0, 0, s, s)
  if (spec.style === 'brick') wallBrick(ctx, s, spec)
  else if (spec.style === 'panel') wallPanel(ctx, s, spec)
  else if (spec.style === 'steel') wallSteel(ctx, s, spec)
  else wallWallpaper(ctx, s, spec)
  return finish(c, 1, aniso)
}

// ---------------------------------------------------------------------------
// Ceilings.

// Drop-ceiling acoustic tile: clean field with a graphic T-bar grid.
function ceilingTile(ctx, s, spec) {
  speckle(ctx, s, 450, spec.flecks, 0.5, 1.2)
  ctx.strokeStyle = spec.line
  ctx.lineWidth = 4
  ctx.strokeRect(0, 0, s, s)
  ctx.beginPath()
  ctx.moveTo(s / 2, 0)
  ctx.lineTo(s / 2, s)
  ctx.moveTo(0, s / 2)
  ctx.lineTo(s, s / 2)
  ctx.stroke()
}

// Board-formed concrete: parallel shutter-board lines in one direction only —
// the cast-in-place underside of a masonry gallery.
function ceilingVault(ctx, s, spec) {
  speckle(ctx, s, 320, spec.flecks, 0.5, 1.3)
  ctx.strokeStyle = spec.line
  ctx.globalAlpha = 0.5
  ctx.lineWidth = 2
  for (let x = 0; x <= s; x += 32) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, s)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

// Ribbed deck underside: broad dark bands — corrugated structure overhead.
function ceilingDeck(ctx, s, spec) {
  speckle(ctx, s, 200, spec.flecks, 0.5, 1.2)
  ctx.fillStyle = spec.seam
  ctx.globalAlpha = 0.45
  for (let x = 8; x < s; x += 42) ctx.fillRect(x, 0, 10, s)
  ctx.globalAlpha = 1
}

export function ceilingTexture(aniso, spec) {
  const s = 256
  const c = canvas(s)
  const ctx = c.getContext('2d')
  ctx.fillStyle = spec.base
  ctx.fillRect(0, 0, s, s)
  if (spec.style === 'vault') ceilingVault(ctx, s, spec)
  else if (spec.style === 'deck') ceilingDeck(ctx, s, spec)
  else ceilingTile(ctx, s, spec)
  return finish(c, 1, aniso)
}
