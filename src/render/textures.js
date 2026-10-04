import * as THREE from 'three'
import { surfaceStyle } from './surfaces.js'
import { DESIGN, canvas, rand, seedTextureNoise, softBlots, speckle, textureSeed, wallGradient } from './texturePaint.js'
import { CEILING_STYLES, FLOOR_STYLES, WALL_STYLES } from './textureStyles.js'

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

// Painting kit (seeded noise, speckle, blots, wall gradient) is shared with
// the variant styles: texturePaint.js.
export { textureSeed }

function finish(c, repeat, aniso) {
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.repeat.set(repeat, repeat)
  tex.anisotropy = aniso
  tex.needsUpdate = true
  return tex
}

// ---------------------------------------------------------------------------
// Floors. UVs are 1 repeat per cell (3 m), so the 256px canvas spans one cell.

// Warm carpet: a mostly-flat painted field with sparse soft flecks.
function floorCarpet(ctx, s, spec) {
  speckle(ctx, s, 900, spec.flecks, 0.5, 1.3)
  softBlots(ctx, s, 5, spec.stains, 14, 34)
}

// Poured concrete walkway: broad damp blotches, a few hairline cracks, and a
// shallow perimeter darkening so slabs read as individually poured bays.
function floorConcrete(ctx, s, spec) {
  speckle(ctx, s, 350, spec.flecks, 0.6, 1.6)
  softBlots(ctx, s, 8, spec.stains, 14, 38, 0.3)
  ctx.strokeStyle = spec.stains[0]
  ctx.globalAlpha = 0.35
  ctx.lineWidth = 1
  for (let i = 0; i < 3; i++) {
    ctx.beginPath()
    let x = rand() * s
    let y = rand() * s
    ctx.moveTo(x, y)
    for (let k = 0; k < 4; k++) {
      x += (rand() - 0.5) * 70
      y += 20 + rand() * 40
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
  const n = spec.tiles ?? 2
  for (let i = 1; i < n; i++) {
    ctx.moveTo((s * i) / n, 0)
    ctx.lineTo((s * i) / n, s)
    ctx.moveTo(0, (s * i) / n)
    ctx.lineTo(s, (s * i) / n)
  }
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
    const x = rand() * (s - 14)
    const y = rand() * (s - 6)
    if (rand() < 0.5) ctx.fillRect(x, y, 12, 2)
    else ctx.fillRect(x, y, 2, 12)
  }
  ctx.globalAlpha = 1
}

function paintFloor(ctx, s, spec) {
  const variant = FLOOR_STYLES[spec.style]
  if (variant) return variant(ctx, s, spec)
  if (spec.style === 'concrete') floorConcrete(ctx, s, spec)
  else if (spec.style === 'tile') floorTile(ctx, s, spec)
  else if (spec.style === 'deck') floorDeck(ctx, s, spec)
  else floorCarpet(ctx, s, spec)
}

export function floorTexture(aniso, spec, size = DESIGN) {
  return finish(paintSurfaceCanvas('floor', spec, size), 1, aniso)
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
      ctx.fillStyle = spec.variants[(rand() * spec.variants.length) | 0]
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

function paintWall(ctx, s, spec) {
  const variant = WALL_STYLES[spec.style]
  if (variant) return variant(ctx, s, spec)
  if (spec.style === 'brick') wallBrick(ctx, s, spec)
  else if (spec.style === 'panel') wallPanel(ctx, s, spec)
  else if (spec.style === 'steel') wallSteel(ctx, s, spec)
  else wallWallpaper(ctx, s, spec)
}

export function wallTexture(aniso, spec, size = DESIGN) {
  return finish(paintSurfaceCanvas('wall', spec, size), 1, aniso)
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

function paintCeiling(ctx, s, spec) {
  const variant = CEILING_STYLES[spec.style]
  if (variant) return variant(ctx, s, spec)
  if (spec.style === 'vault') ceilingVault(ctx, s, spec)
  else if (spec.style === 'deck') ceilingDeck(ctx, s, spec)
  else ceilingTile(ctx, s, spec)
}

export function ceilingTexture(aniso, spec, size = DESIGN) {
  return finish(paintSurfaceCanvas('ceiling', spec, size), 1, aniso)
}

const PAINTERS = { floor: paintFloor, wall: paintWall, ceiling: paintCeiling }

// Paint one surface recipe (a familyPalette spec or a world surface-set
// layer) onto a fresh `size`^2 canvas. Painters work in the 256-unit design
// space, so a 512 canvas is the same pattern at twice the texel density.
export function paintSurfaceCanvas(slot, spec, size = DESIGN) {
  const c = canvas(size)
  const ctx = c.getContext('2d')
  seedTextureNoise(slot, spec)
  if (size !== DESIGN) ctx.scale(size / DESIGN, size / DESIGN)
  ctx.fillStyle = spec.base
  ctx.fillRect(0, 0, DESIGN, DESIGN)
  PAINTERS[slot](ctx, DESIGN, spec)
  return c
}

// ---------------------------------------------------------------------------
// Surface detail maps (engine-improvement S4 / G-buffer v2).
//
// One linear RGBA8 texture per architectural surface, derived from the same
// seeded albedo canvas so relief always lines up with the painted detail:
//   R,G  tangent-space normal xy (z is reconstructed; the vector's mip-level
//        shortening feeds the shader's Toksvig specular anti-aliasing)
//   B    perceptual roughness
//   A    material cavity occlusion (1 = open surface)
// The height field is the albedo's blurred luminance — grout, mortar, seams
// and rivet shadows are painted darker, so they read as recessed. Tileable:
// every neighbourhood lookup wraps, matching RepeatWrapping on the albedo.
// Rows are written bottom-up so texel (0,0) matches the flipY canvas albedo.
export function surfaceDetailTexture(albedo, spec) {
  const src = albedo?.image
  const data = surfaceDetailData(src, spec)
  if (!data) return null
  const size = src.width
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.NoColorSpace
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = albedo.anisotropy ?? 1
  tex.needsUpdate = true
  return tex
}

// The detail texels of one painted surface canvas (RGBA8, rows bottom-up).
// Kernel radii and the height-to-slope gain scale with the canvas size, so a
// 512 canvas yields the same physical relief as the 256 design.
export function surfaceDetailData(src, spec, pixels = null) {
  const size = src?.width ?? 0
  const ctx = src?.getContext?.('2d')
  if (!size || !ctx) return null
  const style = surfaceStyle(spec?.style)
  const px = pixels ?? ctx.getImageData(0, 0, size, size).data
  const n = size * size
  const scale = size / DESIGN
  // Luminance in data-row order (row 0 = bottom = v 0).
  const lum = new Float32Array(n)
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size
    for (let x = 0; x < size; x++) {
      const i = (srcRow + x) * 4
      lum[y * size + x] = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255
    }
  }
  // Wrapped neighbour tables: the inner loops index through these instead of
  // calling a modulo closure per texel (the detail pass dominated the cost
  // of painting a world's surface set).
  const step = Math.max(1, Math.round(scale))
  const prev = new Int32Array(size)
  const next = new Int32Array(size)
  const prev1 = new Int32Array(size)
  const next1 = new Int32Array(size)
  for (let i = 0; i < size; i++) {
    prev[i] = (i - step + size) % size
    next[i] = (i + step) % size
    prev1[i] = (i - 1 + size) % size
    next1[i] = (i + 1) % size
  }
  // Separable 3-tap blur twice: removes single-pixel speckle spikes that would
  // otherwise shimmer as normal-map noise.
  const tmp = new Float32Array(n)
  const blurX = (from, to) => {
    for (let y = 0; y < size; y++) {
      const r = y * size
      for (let x = 0; x < size; x++) to[r + x] = 0.25 * from[r + prev[x]] + 0.5 * from[r + x] + 0.25 * from[r + next[x]]
    }
  }
  const blurY = (from, to) => {
    for (let y = 0; y < size; y++) {
      const r = y * size
      const rp = prev[y] * size
      const rn = next[y] * size
      for (let x = 0; x < size; x++) to[r + x] = 0.25 * from[rp + x] + 0.5 * from[r + x] + 0.25 * from[rn + x]
    }
  }
  const h = new Float32Array(n)
  blurX(lum, tmp)
  blurY(tmp, h)
  blurX(h, tmp)
  blurY(tmp, h)
  // High-pass: the albedo also carries PAINTED low-frequency shading (the
  // wallpaper's top-light/floor-shade gradient, soft stain blots). Read as
  // height, those become per-tile slopes that tilt whole walls and stripe
  // the screen-space AO/contact passes with the tile repeat. Subtracting a
  // wide wrapped box blur keeps only local relief — seams, grout, mortar,
  // rivets, fibre speckle.
  const R = Math.round(12 * scale)
  const wide = new Float32Array(n)
  const norm = 1 / (2 * R + 1)
  // Sliding-window box sums (rows, then columns): O(1) per texel.
  for (let y = 0; y < size; y++) {
    const r = y * size
    let acc = 0
    for (let k = -R; k <= R; k++) acc += h[r + ((k + size) % size)]
    for (let x = 0; x < size; x++) {
      tmp[r + x] = acc * norm
      acc += h[r + ((x + R + 1) % size)] - h[r + ((x - R + size) % size)]
    }
  }
  for (let x = 0; x < size; x++) {
    let acc = 0
    for (let k = -R; k <= R; k++) acc += tmp[((k + size) % size) * size + x]
    for (let y = 0; y < size; y++) {
      wide[y * size + x] = acc * norm
      acc += tmp[((y + R + 1) % size) * size + x] - tmp[((y - R + size) % size) * size + x]
    }
  }
  let lo = Infinity
  let hi = -Infinity
  let mean = 0
  for (let i = 0; i < n; i++) {
    const v = h[i] - wide[i]
    h[i] = v
    if (v < lo) lo = v
    if (v > hi) hi = v
    mean += v
  }
  mean /= n
  const span = Math.max(hi - lo, 1e-4)
  const data = new Uint8Array(n * 4)
  const k = style.normalStrength * 6 * scale
  const r0 = style.roughness
  const invSpan = 1 / span
  for (let y = 0; y < size; y++) {
    const r = y * size
    const rp = prev1[y] * size
    const rn = next1[y] * size
    for (let x = 0; x < size; x++) {
      const i = r + x
      const dhdu = (h[r + next1[x]] - h[r + prev1[x]]) * 0.5
      const dhdv = (h[rn + x] - h[rp + x]) * 0.5
      let nx = -dhdu * k
      let ny = -dhdv * k
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1)
      nx *= inv
      ny *= inv
      // Relative height: 0 in the deepest recess, 1 on the proudest face.
      const rel = (h[i] - lo) * invSpan
      const below = Math.min(1, Math.max(0, (mean - h[i]) * invSpan) * 2)
      const rough = r0 + style.lowRoughness * below - style.roughnessVar * (rel - 0.5) * 2
      const cavity = 1 - style.cavity * below
      const o = i * 4
      data[o] = (nx * 0.5 + 0.5) * 255 + 0.5
      data[o + 1] = (ny * 0.5 + 0.5) * 255 + 0.5
      data[o + 2] = Math.min(1, Math.max(0.045, rough)) * 255 + 0.5
      data[o + 3] = Math.min(1, Math.max(0, cavity)) * 255 + 0.5
    }
  }
  return data
}
