import { hashStr } from '../world/core/hash.js'

// Shared canvas-painting kit for the procedural surface textures
// (textures.js: the families' canonical surfaces; textureStyles.js: the
// per-world variant styles). Everything draws in a 256-unit DESIGN space —
// callers scale the context to the real canvas size — so one painter serves
// every texture resolution with the same physical pattern scale.

export const DESIGN = 256

export function canvas(size = DESIGN) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  return c
}

// Seeded texture noise (engine-improvement S0). Every generator used to draw
// from Math.random(), so the same seed and view produced different pixels on
// each page load and no screenshot could be compared against another. The
// stream is keyed by the surface slot and its palette spec: a family's
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

let stream = mulberry32(1)

export const rand = () => stream()

export function textureSeed(slot, spec) {
  return hashStr(`${slot}|${spec?.style ?? ''}|${spec?.base ?? ''}`)
}

// Variant recipes also carry their world layer/colour set, so two layers of
// one style never share a noise stream.
export function seedTextureNoise(slot, spec) {
  const extra = spec?.layer ? `|${spec.layer}|${spec.motif ?? spec.lower ?? spec.tile ?? spec.colors?.[0] ?? ''}` : ''
  stream = mulberry32(extra ? hashStr(`${slot}|${spec?.style ?? ''}|${spec?.base ?? ''}${extra}`) : textureSeed(slot, spec))
}

export const range = (a, b) => a + rand() * (b - a)
export const choose = (list) => list[(rand() * list.length) | 0]

// Helper: seeded speckle (visual only, not gameplay; see seedTextureNoise).
export function speckle(ctx, size, count, colors, min, max) {
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
export function softBlots(ctx, size, count, colors, min, max, alpha = 0.22) {
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
export function wallGradient(ctx, s, spec) {
  const g = ctx.createLinearGradient(0, 0, 0, s)
  g.addColorStop(0, spec.topLight ?? 'rgba(255,255,255,0.10)')
  g.addColorStop(0.6, 'rgba(0,0,0,0)')
  g.addColorStop(1, spec.floorShade ?? 'rgba(0,0,0,0.22)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, s, s)
}

// Run `draw(ox, oy)` at every wrapped copy of a shape whose bounding box
// [x - r, x + r] x [y - r, y + r] crosses the tile edge, so tiled patterns
// stay seamless. `wrapY` false for walls (v spans exactly one wall height).
export function wrapped(s, x, y, r, draw, wrapY = true) {
  const xs = [0]
  const ys = [0]
  if (x - r < 0) xs.push(s)
  if (x + r > s) xs.push(-s)
  if (wrapY && y - r < 0) ys.push(s)
  if (wrapY && y + r > s) ys.push(-s)
  for (const ox of xs) for (const oy of ys) draw(ox, oy)
}

// Wavy wood-grain strokes inside a rectangle, along its long axis.
export function woodGrain(ctx, x, y, w, h, color, alongX, density = 1) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.strokeStyle = color
  ctx.lineWidth = 0.6
  const across = alongX ? h : w
  const along = alongX ? w : h
  const lines = Math.max(2, Math.round(across * 0.55 * density))
  for (let i = 0; i < lines; i++) {
    const off = (i + rand()) * (across / lines)
    const amp = 0.4 + rand() * 1.4
    const freq = 0.04 + rand() * 0.08
    const phase = rand() * 6.28
    ctx.globalAlpha = 0.12 + rand() * 0.22
    ctx.beginPath()
    for (let t = 0; t <= along; t += 3) {
      const d = off + Math.sin(t * freq + phase) * amp
      if (alongX) ctx.lineTo(x + t, y + d)
      else ctx.lineTo(x + d, y + t)
    }
    ctx.stroke()
  }
  // An occasional knot.
  if (rand() < 0.18) {
    const kx = x + w * (0.2 + rand() * 0.6)
    const ky = y + h * (0.2 + rand() * 0.6)
    ctx.globalAlpha = 0.35
    ctx.beginPath()
    ctx.ellipse(kx, ky, alongX ? 2.2 : 1.2, alongX ? 1.2 : 2.2, 0, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
  ctx.globalAlpha = 1
}

// Short random hairline cracks.
export function cracks(ctx, s, count, color, alpha = 0.3, reach = 60) {
  ctx.strokeStyle = color
  ctx.lineWidth = 0.8
  for (let i = 0; i < count; i++) {
    ctx.globalAlpha = alpha * (0.5 + rand() * 0.5)
    let x = rand() * s
    let y = rand() * s
    ctx.beginPath()
    ctx.moveTo(x, y)
    const steps = 3 + ((rand() * 4) | 0)
    const dir = rand() * Math.PI * 2
    for (let k = 0; k < steps; k++) {
      const a = dir + (rand() - 0.5) * 1.6
      const len = reach * (0.2 + rand() * 0.4)
      x += Math.cos(a) * len
      y += Math.sin(a) * len
      ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}
