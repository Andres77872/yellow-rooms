import * as THREE from 'three'
import { hashStr } from '../world/core/hash.js'
import { surfaceStyle } from './surfaces.js'

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

// Seeded texture noise (engine-improvement S0). Every generator used to draw
// from Math.random(), so the same seed and view produced different pixels on
// each page load and no screenshot could be compared against another. The
// stream is now keyed by the surface slot and its palette spec: a family's
// carpet is identical on every boot, while two families (or the floor and
// ceiling of one family) still get independent speckle.
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let rand = mulberry32(1)

export function textureSeed(slot, spec) {
  return hashStr(`${slot}|${spec?.style ?? ''}|${spec?.base ?? ''}`)
}

function seedTextureNoise(slot, spec) {
  rand = mulberry32(textureSeed(slot, spec))
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

// Helper: seeded speckle (visual only, not gameplay; see seedTextureNoise).
function speckle(ctx, size, count, colors, min, max) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[(rand() * colors.length) | 0]
    const r = min + rand() * (max - min)
    ctx.globalAlpha = 0.25 + rand() * 0.5
    ctx.beginPath()
    ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

// Soft painted wear: feathered, slightly elongated blots (radial gradients,
// low alpha) instead of hard discs — at the new darker exposure the old
// crisp stains read as polka dots rather than traffic wear. Each blot is also
// drawn at its wrapped offsets, so one crossing the tile edge never leaves a
// seam in the repeat.
function softBlots(ctx, size, count, colors, min, max, alpha = 0.22) {
  for (let i = 0; i < count; i++) {
    const color = colors[(rand() * colors.length) | 0]
    const r = min + rand() * (max - min)
    const x = rand() * size
    const y = rand() * size
    const stretch = 1 + rand() * 0.8
    const angle = rand() * Math.PI
    ctx.globalAlpha = alpha * (0.5 + rand() * 0.5)
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const cx = x + ox
        const cy = y + oy
        if (cx + r * stretch < 0 || cx - r * stretch > size || cy + r * stretch < 0 || cy - r * stretch > size) continue
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(angle)
        ctx.scale(stretch, 1)
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r)
        g.addColorStop(0, color)
        g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(0, 0, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
    }
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
    const x = rand() * (s - 14)
    const y = rand() * (s - 6)
    if (rand() < 0.5) ctx.fillRect(x, y, 12, 2)
    else ctx.fillRect(x, y, 2, 12)
  }
  ctx.globalAlpha = 1
}

export function floorTexture(aniso, spec) {
  const s = 256
  const c = canvas(s)
  const ctx = c.getContext('2d')
  seedTextureNoise('floor', spec)
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

export function wallTexture(aniso, spec) {
  const s = 256
  const c = canvas(s)
  const ctx = c.getContext('2d')
  seedTextureNoise('wall', spec)
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
  seedTextureNoise('ceiling', spec)
  ctx.fillStyle = spec.base
  ctx.fillRect(0, 0, s, s)
  if (spec.style === 'vault') ceilingVault(ctx, s, spec)
  else if (spec.style === 'deck') ceilingDeck(ctx, s, spec)
  else ceilingTile(ctx, s, spec)
  return finish(c, 1, aniso)
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
  const size = src?.width ?? 0
  const ctx = src?.getContext?.('2d')
  if (!size || !ctx) return null
  const style = surfaceStyle(spec?.style)
  const px = ctx.getImageData(0, 0, size, size).data
  const n = size * size
  // Luminance in data-row order (row 0 = bottom = v 0).
  const lum = new Float32Array(n)
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size
    for (let x = 0; x < size; x++) {
      const i = (srcRow + x) * 4
      lum[y * size + x] = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255
    }
  }
  const wrap = (v) => (v + size) % size
  // Separable 3-tap blur twice: removes single-pixel speckle spikes that would
  // otherwise shimmer as normal-map noise.
  const tmp = new Float32Array(n)
  const blur = (from, to, dx, dy) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        to[y * size + x] =
          0.25 * from[wrap(y - dy) * size + wrap(x - dx)] +
          0.5 * from[y * size + x] +
          0.25 * from[wrap(y + dy) * size + wrap(x + dx)]
      }
    }
  }
  const h = new Float32Array(n)
  blur(lum, tmp, 1, 0)
  blur(tmp, h, 0, 1)
  blur(h, tmp, 1, 0)
  blur(tmp, h, 0, 1)
  // High-pass: the albedo also carries PAINTED low-frequency shading (the
  // wallpaper's top-light/floor-shade gradient, soft stain blots). Read as
  // height, those become per-tile slopes that tilt whole walls and stripe
  // the screen-space AO/contact passes with the tile repeat. Subtracting a
  // wide wrapped box blur keeps only local relief — seams, grout, mortar,
  // rivets, fibre speckle.
  const R = 12
  const wide = new Float32Array(n)
  // Sliding-window box sum along rows (dx) or columns (dy): O(1) per texel.
  const boxPass = (from, to, horizontal) => {
    const at = (line, i) => (horizontal ? line * size + wrap(i) : wrap(i) * size + line)
    for (let line = 0; line < size; line++) {
      let acc = 0
      for (let k = -R; k <= R; k++) acc += from[at(line, k)]
      for (let i = 0; i < size; i++) {
        to[at(line, i)] = acc / (2 * R + 1)
        acc += from[at(line, i + R + 1)] - from[at(line, i - R)]
      }
    }
  }
  boxPass(h, tmp, true)
  boxPass(tmp, wide, false)
  for (let i = 0; i < n; i++) h[i] -= wide[i]
  let lo = Infinity
  let hi = -Infinity
  let mean = 0
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, h[i])
    hi = Math.max(hi, h[i])
    mean += h[i]
  }
  mean /= n
  const span = Math.max(hi - lo, 1e-4)
  const data = new Uint8Array(n * 4)
  const k = style.normalStrength * 6
  const r0 = style.roughness
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      const dhdu = (h[y * size + wrap(x + 1)] - h[y * size + wrap(x - 1)]) * 0.5
      const dhdv = (h[wrap(y + 1) * size + x] - h[wrap(y - 1) * size + x]) * 0.5
      let nx = -dhdu * k
      let ny = -dhdv * k
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1)
      nx *= inv
      ny *= inv
      // Relative height: 0 in the deepest recess, 1 on the proudest face.
      const rel = (h[i] - lo) / span
      const below = Math.max(0, (mean - h[i]) / span) * 2
      const rough = r0 +
        style.lowRoughness * Math.min(1, below) +
        style.roughnessVar * (rel - 0.5) * 2 * -1
      const cavity = 1 - style.cavity * Math.min(1, below)
      const o = i * 4
      data[o] = Math.round((nx * 0.5 + 0.5) * 255)
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      data[o + 2] = Math.round(Math.min(1, Math.max(0.045, rough)) * 255)
      data[o + 3] = Math.round(Math.min(1, Math.max(0, cavity)) * 255)
    }
  }
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
