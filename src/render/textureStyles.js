import { WALL_H } from '../world/constants.js'
import { mixHex, shadeHex } from '../world/surfaceSet.js'
import { choose, cracks, rand, range, softBlots, speckle, wallGradient, woodGrain, wrapped } from './texturePaint.js'

// Variant surface styles (world surface sets, world/surfaceSet.js).
//
// The families' canonical surfaces (textures.js) stay the clean painted
// fields of the anime-backrooms direction; these are the finishes a real
// building accumulates room by room — patterned and modular carpet, vinyl
// tile, wood, terrazzo, mosaic, wainscots, glazed tile, block, formwork,
// sheet metal. They stay tone-on-tone and soft-edged so the cel shading and
// the camcorder pass still read them as painted backgrounds, but they carry
// enough pattern to tell one room from the next at a glance.
//
// Painters draw in the 256-unit design space (texturePaint.js). Floors and
// ceilings tile in both axes (one repeat per 3 m cell); walls tile across
// (one repeat per 3 m of wall) and span EXACTLY the floor-to-ceiling height
// down the canvas (v = height / WALL_H), so a chair rail painted at 0.95 m
// lands at 0.95 m on every wall, sill and header. Canvas y = 0 is the
// ceiling line.

// Canvas row of a height above the floor on a wall texture.
const wallY = (s, h) => s * (1 - h / WALL_H)

// ---------------------------------------------------------------------------
// Floors

function carpetPattern(ctx, s, spec) {
  speckle(ctx, s, 1100, spec.flecks, 0.5, 1.2)
  const n = spec.scale ?? 6
  const cell = s / n
  ctx.globalAlpha = 0.55
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const cx = (i + 0.5) * cell
      const cy = (j + 0.5) * cell
      switch (spec.pattern) {
        case 'dots':
          ctx.fillStyle = (i + j) % 2 ? spec.motif : spec.accent
          ctx.beginPath()
          ctx.arc(cx, cy, cell * 0.12, 0, Math.PI * 2)
          ctx.fill()
          break
        case 'grid':
          ctx.fillStyle = spec.motif
          ctx.fillRect(i * cell, j * cell, cell, cell * 0.06)
          ctx.fillRect(i * cell, j * cell, cell * 0.06, cell)
          if ((i + j) % 3 === 0) {
            ctx.fillStyle = spec.accent
            ctx.fillRect(cx - cell * 0.08, cy - cell * 0.08, cell * 0.16, cell * 0.16)
          }
          break
        case 'squares':
          ctx.strokeStyle = spec.motif
          ctx.lineWidth = cell * 0.07
          ctx.strokeRect(cx - cell * 0.28, cy - cell * 0.28, cell * 0.56, cell * 0.56)
          ctx.fillStyle = spec.accent
          ctx.fillRect(cx - cell * 0.06, cy - cell * 0.06, cell * 0.12, cell * 0.12)
          break
        case 'confetti':
          break
        default: {
          // diamond lattice with a small accent pip
          ctx.fillStyle = spec.motif
          ctx.beginPath()
          ctx.moveTo(cx, cy - cell * 0.42)
          ctx.lineTo(cx + cell * 0.42, cy)
          ctx.lineTo(cx, cy + cell * 0.42)
          ctx.lineTo(cx - cell * 0.42, cy)
          ctx.closePath()
          ctx.fill()
          ctx.fillStyle = spec.base
          ctx.beginPath()
          ctx.moveTo(cx, cy - cell * 0.3)
          ctx.lineTo(cx + cell * 0.3, cy)
          ctx.lineTo(cx, cy + cell * 0.3)
          ctx.lineTo(cx - cell * 0.3, cy)
          ctx.closePath()
          ctx.fill()
          ctx.fillStyle = spec.accent
          ctx.fillRect(cx - cell * 0.07, cy - cell * 0.07, cell * 0.14, cell * 0.14)
        }
      }
    }
  }
  if (spec.pattern === 'confetti') {
    // 90s commercial confetti: small irregular flecks in two accents.
    for (let k = 0; k < 260; k++) {
      ctx.fillStyle = rand() < 0.5 ? spec.motif : spec.accent
      ctx.globalAlpha = 0.45 + rand() * 0.35
      const x = rand() * s
      const y = rand() * s
      const w = 1.5 + rand() * 4
      const a = rand() * Math.PI
      wrapped(s, x, y, w, (ox, oy) => {
        ctx.save()
        ctx.translate(x + ox, y + oy)
        ctx.rotate(a)
        ctx.fillRect(-w / 2, -0.9, w, 1.8)
        ctx.restore()
      })
    }
  }
  ctx.globalAlpha = 1
  softBlots(ctx, s, 4, [shadeHex(spec.base, 0.85)], 16, 36, 0.16)
}

// Modular carpet tiles laid quarter-turned: alternate tiles catch the light
// differently because their pile runs the other way.
function carpetTile(ctx, s, spec) {
  const n = spec.tiles ?? 6
  const t = s / n
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const turned = (i + j) % 2 === 1
      ctx.fillStyle = shadeHex(spec.base, turned ? 1.06 : 0.97)
      ctx.fillRect(i * t, j * t, t, t)
      ctx.fillStyle = shadeHex(spec.base, turned ? 0.9 : 1.1)
      ctx.globalAlpha = 0.18
      for (let k = 0; k < 26; k++) {
        const u = rand() * t
        const v = rand() * t
        if (turned) ctx.fillRect(i * t + u, j * t + v, 0.8, 4 + rand() * 6)
        else ctx.fillRect(i * t + u, j * t + v, 4 + rand() * 6, 0.8)
      }
      ctx.globalAlpha = 1
    }
  }
  speckle(ctx, s, 700, spec.flecks, 0.5, 1.1)
  ctx.strokeStyle = shadeHex(spec.base, 0.78)
  ctx.globalAlpha = 0.5
  ctx.lineWidth = 1
  for (let i = 0; i <= n; i++) {
    ctx.beginPath()
    ctx.moveTo(i * t, 0)
    ctx.lineTo(i * t, s)
    ctx.moveTo(0, i * t)
    ctx.lineTo(s, i * t)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

// Vinyl composition tile: 30 cm squares, each its own marbled mottle.
function vct(ctx, s, spec) {
  const n = spec.tiles ?? 10
  const t = s / n
  const colors = spec.colors
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let c
      if (spec.layout === 'checker') c = colors[(i + j) % 2]
      else if (spec.layout === 'border') c = i === 0 || j === 0 ? colors[2] : colors[0]
      else c = rand() < 0.16 ? colors[2] : rand() < 0.5 ? colors[0] : colors[1]
      ctx.fillStyle = shadeHex(c, 0.97 + rand() * 0.06)
      ctx.fillRect(i * t, j * t, t, t)
      // directional marbling streaks
      const vertical = rand() < 0.5
      for (let k = 0; k < 7; k++) {
        ctx.fillStyle = choose(spec.speckle)
        ctx.globalAlpha = 0.18 + rand() * 0.2
        const u = rand() * t
        const v = rand() * t
        if (vertical) ctx.fillRect(i * t + u, j * t + v * 0.5, 0.9, t * (0.2 + rand() * 0.4))
        else ctx.fillRect(i * t + u * 0.5, j * t + v, t * (0.2 + rand() * 0.4), 0.9)
      }
      ctx.globalAlpha = 1
    }
  }
  speckle(ctx, s, 900, spec.speckle, 0.4, 1)
  ctx.strokeStyle = spec.seam
  ctx.lineWidth = 1.2
  ctx.globalAlpha = 0.75
  for (let i = 0; i <= n; i++) {
    ctx.beginPath()
    ctx.moveTo(i * t, 0)
    ctx.lineTo(i * t, s)
    ctx.moveTo(0, i * t)
    ctx.lineTo(s, i * t)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  softBlots(ctx, s, 5, [shadeHex(colors[0], 0.85)], 14, 34, 0.16)
}

function checker(ctx, s, spec) {
  const n = spec.tiles ?? 8
  const t = s / n
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = shadeHex((i + j) % 2 ? spec.b : spec.a, 0.96 + rand() * 0.07)
      ctx.fillRect(i * t, j * t, t, t)
    }
  }
  speckle(ctx, s, 500, [shadeHex(spec.a, 0.85), shadeHex(spec.b, 1.2)], 0.4, 1)
  ctx.strokeStyle = spec.seam
  ctx.globalAlpha = 0.4
  ctx.lineWidth = 1
  for (let i = 0; i <= n; i++) {
    ctx.beginPath()
    ctx.moveTo(i * t, 0)
    ctx.lineTo(i * t, s)
    ctx.moveTo(0, i * t)
    ctx.lineTo(s, i * t)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  softBlots(ctx, s, 6, [shadeHex(spec.a, 0.8)], 12, 30, 0.18)
}

// Wood block in herringbone (2:1 blocks on a period-4 lattice: residue
// (i - j) mod 4 of 0 starts a horizontal block, 3 a vertical one) or basket
// weave.
function parquet(ctx, s, spec) {
  const blocks = []
  if (spec.layout === 'basket') {
    const sq = s / 4
    const strip = sq / 4
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const alongX = (i + j) % 2 === 0
        for (let k = 0; k < 4; k++) {
          if (alongX) blocks.push([i * sq, j * sq + k * strip, sq, strip, true])
          else blocks.push([i * sq + k * strip, j * sq, strip, sq, false])
        }
      }
    }
  } else {
    const w = s / 16
    // One period of the lattice; blocks crossing the edge wrap.
    for (let j = 0; j < 16; j++) {
      for (let i = 0; i < 16; i++) {
        const r = (((i - j) % 4) + 4) % 4
        if (r === 0) blocks.push([i * w, j * w, 2 * w, w, true])
        else if (r === 3) blocks.push([i * w, j * w, w, 2 * w, false])
      }
    }
  }
  for (const [x, y, w, h, alongX] of blocks) {
    const tone = choose(spec.woods)
    const grain = shadeHex(tone, 0.72)
    wrapped(s, x + w / 2, y + h / 2, Math.max(w, h) / 2, (ox, oy) => {
      ctx.fillStyle = tone
      ctx.fillRect(x + ox, y + oy, w, h)
      woodGrain(ctx, x + ox, y + oy, w, h, grain, alongX, 0.6)
      ctx.strokeStyle = spec.seam
      ctx.globalAlpha = 0.7
      ctx.lineWidth = 0.9
      ctx.strokeRect(x + ox + 0.4, y + oy + 0.4, w - 0.8, h - 0.8)
      ctx.globalAlpha = 1
    })
  }
  softBlots(ctx, s, 4, [shadeHex(spec.woods[0], 0.8)], 18, 40, 0.14)
}

// Strip boards with staggered butt joints.
function planks(ctx, s, spec) {
  const rows = spec.boards ?? 14
  const h = s / rows
  for (let r = 0; r < rows; r++) {
    // Board lengths summing to exactly one repeat, so the row tiles.
    const lens = []
    let total = 0
    while (total < s) {
      const len = s * (0.35 + rand() * 0.55)
      lens.push(len)
      total += len
    }
    let x = -rand() * s * 0.6
    for (const raw of lens) {
      const len = (raw * s) / total
      const tone = shadeHex(choose(spec.woods), 0.96 + rand() * 0.08)
      const x0 = x
      wrapped(s, x0 + len / 2, 0, len / 2, (ox) => {
        ctx.fillStyle = tone
        ctx.fillRect(x0 + ox, r * h, len, h)
        woodGrain(ctx, x0 + ox, r * h, len, h, shadeHex(tone, 0.7), true, 1)
        ctx.fillStyle = spec.seam
        ctx.globalAlpha = 0.8
        ctx.fillRect(x0 + ox, r * h, 1, h)
        ctx.globalAlpha = 1
      }, false)
      x += len
    }
    ctx.fillStyle = spec.seam
    ctx.globalAlpha = 0.7
    ctx.fillRect(0, r * h, s, 0.9)
    ctx.globalAlpha = 1
  }
  softBlots(ctx, s, 5, [shadeHex(spec.woods[0], 0.78)], 16, 38, 0.15)
}

function terrazzo(ctx, s, spec) {
  speckle(ctx, s, 600, [shadeHex(spec.base, 0.92), shadeHex(spec.base, 1.06)], 0.4, 1)
  for (let k = 0; k < 1500; k++) {
    const x = rand() * s
    const y = rand() * s
    const r = 0.5 + rand() * rand() * 3.2
    ctx.fillStyle = choose(spec.chips)
    ctx.globalAlpha = 0.6 + rand() * 0.4
    const sides = 4 + ((rand() * 3) | 0)
    const a0 = rand() * 6.28
    wrapped(s, x, y, r, (ox, oy) => {
      ctx.beginPath()
      for (let v = 0; v < sides; v++) {
        const a = a0 + (v / sides) * 6.28
        const rr = r * (0.6 + rand() * 0.5)
        ctx.lineTo(x + ox + Math.cos(a) * rr, y + oy + Math.sin(a) * rr)
      }
      ctx.closePath()
      ctx.fill()
    })
  }
  ctx.globalAlpha = 1
  // Divider strips between poured bays.
  ctx.strokeStyle = spec.seam
  ctx.lineWidth = 1.6
  ctx.globalAlpha = 0.85
  const bays = spec.bays ?? 1
  for (let i = 0; i <= bays; i++) {
    const p = (i / bays) * s
    ctx.beginPath()
    ctx.moveTo(p, 0)
    ctx.lineTo(p, s)
    ctx.moveTo(0, p)
    ctx.lineTo(s, p)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  softBlots(ctx, s, 4, [shadeHex(spec.base, 0.86)], 18, 40, 0.14)
}

function mosaic(ctx, s, spec) {
  ctx.fillStyle = spec.grout
  ctx.fillRect(0, 0, s, s)
  const pickColor = () => (rand() < spec.accentRate ? spec.colors[3] : spec.colors[(rand() * 3) | 0])
  if (spec.shape === 'hex') {
    const cols = 16
    const rows = 18
    const w = s / cols
    const h = s / rows
    const r = w * 0.56
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const cx = (i + (j % 2) * 0.5) * w
        const cy = (j + 0.5) * h
        ctx.fillStyle = pickColor()
        wrapped(s, cx, cy, r, (ox, oy) => {
          ctx.beginPath()
          for (let v = 0; v < 6; v++) {
            const a = Math.PI / 6 + (v * Math.PI) / 3
            ctx.lineTo(cx + ox + Math.cos(a) * r * 0.9, cy + oy + Math.sin(a) * r * 0.82)
          }
          ctx.closePath()
          ctx.fill()
        })
      }
    }
  } else {
    const n = 16
    const t = s / n
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = pickColor()
        ctx.fillRect(i * t + 0.9, j * t + 0.9, t - 1.8, t - 1.8)
      }
    }
  }
  softBlots(ctx, s, 6, [shadeHex(spec.grout, 0.8)], 12, 30, 0.18)
}

function polished(ctx, s, spec) {
  softBlots(ctx, s, 12, spec.stains, 18, 48, 0.25)
  speckle(ctx, s, 500, spec.flecks, 0.4, 1.3)
  // trowel sheen arcs
  ctx.strokeStyle = shadeHex(spec.base, 1.12)
  ctx.lineWidth = 6
  for (let k = 0; k < 10; k++) {
    ctx.globalAlpha = 0.05
    ctx.beginPath()
    ctx.arc(rand() * s, rand() * s, 20 + rand() * 50, rand() * 6, rand() * 6 + 1.2)
    ctx.stroke()
  }
  ctx.globalAlpha = 0.7
  ctx.strokeStyle = spec.joint
  ctx.lineWidth = 1.6
  ctx.strokeRect(0, 0, s, s)
  ctx.globalAlpha = 1
  cracks(ctx, s, 2, spec.joint, 0.3, 50)
}

// Bar grating over a dark void: bearing bars one way, cross rods the other.
function grate(ctx, s, spec) {
  ctx.fillStyle = spec.hole
  ctx.fillRect(0, 0, s, s)
  const n = spec.bars ?? 16
  const p = s / n
  ctx.fillStyle = spec.base
  for (let i = 0; i < n; i++) ctx.fillRect(i * p, 0, p * 0.32, s)
  ctx.fillStyle = shadeHex(spec.base, 0.85)
  for (let j = 0; j < n / 2; j++) ctx.fillRect(0, j * p * 2, s, p * 0.22)
  ctx.fillStyle = shadeHex(spec.base, 1.2)
  ctx.globalAlpha = 0.5
  for (let i = 0; i < n; i++) ctx.fillRect(i * p, 0, 0.8, s)
  ctx.globalAlpha = 1
  ctx.strokeStyle = spec.seam
  ctx.lineWidth = 4
  ctx.strokeRect(0, 0, s, s)
}

// Tread plate: rows of raised lugs in alternating orientation, each with a
// light leading edge and a shadowed trailing one.
function diamond(ctx, s, spec) {
  speckle(ctx, s, 400, spec.flecks, 0.5, 1.3)
  const n = 12
  const p = s / n
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const cx = (i + 0.5) * p
      const cy = (j + 0.5) * p
      const a = (i + j) % 2 ? Math.PI / 4 : -Math.PI / 4
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(a)
      ctx.fillStyle = shadeHex(spec.base, 0.7)
      ctx.fillRect(-p * 0.36 + 0.8, -p * 0.08 + 0.8, p * 0.72, p * 0.16)
      ctx.fillStyle = shadeHex(spec.base, 1.22)
      ctx.fillRect(-p * 0.36, -p * 0.08, p * 0.72, p * 0.16)
      ctx.restore()
    }
  }
  softBlots(ctx, s, 6, [spec.rust, shadeHex(spec.base, 0.8)], 10, 30, 0.2)
  ctx.strokeStyle = spec.seam
  ctx.lineWidth = 3
  ctx.strokeRect(0, 0, s, s)
}

// ---------------------------------------------------------------------------
// Walls

function plainPaper(ctx, s, spec, y0 = 0, y1 = s) {
  ctx.globalAlpha = 0.05
  ctx.fillStyle = spec.seam ?? shadeHex(spec.base, 0.6)
  for (let x = 0; x < s; x += 32) ctx.fillRect(x, y0, 1, y1 - y0)
  ctx.globalAlpha = 1
}

function stripe(ctx, s, spec) {
  const p = spec.period ?? 32
  const w = p * (spec.duty ?? 0.3)
  ctx.fillStyle = spec.stripe
  for (let x = 0; x < s; x += p) ctx.fillRect(x, 0, w, s)
  ctx.fillStyle = spec.stripe2
  ctx.globalAlpha = 0.35
  for (let x = 0; x < s; x += p) {
    ctx.fillRect(x + w + 2, 0, 1, s)
    if (p >= 32) ctx.fillRect(x + p - 3, 0, 1, s)
  }
  ctx.globalAlpha = 1
  wallGradient(ctx, s, spec)
  speckle(ctx, s, 80, spec.flecks, 0.5, 1.5)
}

// One damask medallion. Read from across a room it must stay an ogee
// silhouette: the body is a faint fill (the far-field shape), and the inner
// ornament avoids axis-aligned strokes, which used to alias into a grid of
// plus signs once mipmapped down.
function damaskMotif(ctx, cx, cy, w, h) {
  const ogee = () => {
    ctx.beginPath()
    ctx.moveTo(cx, cy - h * 0.5)
    ctx.bezierCurveTo(cx + w * 0.45, cy - h * 0.3, cx + w * 0.1, cy, cx + w * 0.42, cy)
    ctx.bezierCurveTo(cx + w * 0.1, cy, cx + w * 0.45, cy + h * 0.3, cx, cy + h * 0.5)
    ctx.bezierCurveTo(cx - w * 0.45, cy + h * 0.3, cx - w * 0.1, cy, cx - w * 0.42, cy)
    ctx.bezierCurveTo(cx - w * 0.1, cy, cx - w * 0.45, cy - h * 0.3, cx, cy - h * 0.5)
    ctx.closePath()
  }
  ogee()
  ctx.save()
  ctx.globalAlpha *= 0.32
  ctx.fill()
  ctx.restore()
  ctx.lineWidth = 1.6
  ctx.stroke()
  const leaf = (x, y, rx, ry, angle) => {
    ctx.beginPath()
    ctx.ellipse(x, y, rx, ry, angle, 0, Math.PI * 2)
    ctx.fill()
  }
  // Central rosette: six round petals turned off the axes, and a boss.
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + (k * Math.PI) / 3
    leaf(cx + Math.cos(a) * w * 0.085, cy + Math.sin(a) * w * 0.085, w * 0.055, w * 0.04, a)
  }
  leaf(cx, cy, w * 0.045, w * 0.045, 0)
  // Paired leaves splaying from the stem above and below the rosette.
  for (const sy of [-1, 1]) {
    for (const sx of [-1, 1]) leaf(cx + sx * w * 0.07, cy + sy * h * 0.27, w * 0.035, h * 0.075, sx * sy * -0.65)
    leaf(cx, cy + sy * h * 0.39, w * 0.022, h * 0.045, 0)
  }
}

function damask(ctx, s, spec) {
  const n = spec.repeat ?? 4
  const w = s / n
  const h = w * 1.5
  ctx.fillStyle = spec.motif
  ctx.strokeStyle = spec.motif
  for (let row = -1; row * h < s + h; row++) {
    for (let i = 0; i <= n; i++) {
      const cx = i * w + (row % 2 ? w / 2 : 0)
      const cy = row * h + h / 2
      damaskMotif(ctx, cx, cy, w, h)
      if (cx + w / 2 > s) damaskMotif(ctx, cx - s, cy, w, h)
    }
  }
  wallGradient(ctx, s, spec)
  speckle(ctx, s, 70, spec.flecks, 0.5, 1.4)
}

function wainscot(ctx, s, spec) {
  const rail = wallY(s, spec.railH ?? 0.95)
  plainPaper(ctx, s, spec, 0, rail)
  ctx.fillStyle = spec.lower
  ctx.fillRect(0, rail, s, s - rail)
  if (spec.lowerStyle === 'beadboard') {
    for (let x = 0; x < s; x += 12) {
      ctx.fillStyle = spec.seam
      ctx.globalAlpha = 0.6
      ctx.fillRect(x, rail, 1.2, s - rail)
      ctx.fillStyle = shadeHex(spec.lower, 1.15)
      ctx.globalAlpha = 0.4
      ctx.fillRect(x + 1.2, rail, 0.8, s - rail)
    }
    ctx.globalAlpha = 1
    woodGrain(ctx, 0, rail, s, s - rail, shadeHex(spec.lower, 0.85), false, 0.4)
  } else {
    // raised panels: shadow on the lower/right edge, light on the upper/left
    const panels = 3
    const pw = s / panels
    const top = rail + 9
    const bottom = s - 14
    for (let i = 0; i < panels; i++) {
      const x0 = i * pw + 9
      const x1 = (i + 1) * pw - 9
      ctx.fillStyle = shadeHex(spec.lower, 0.82)
      ctx.fillRect(x0, top, x1 - x0, bottom - top)
      ctx.fillStyle = shadeHex(spec.lower, 1.04)
      ctx.fillRect(x0 + 2, top + 2, x1 - x0 - 4, bottom - top - 4)
      ctx.fillStyle = shadeHex(spec.lower, 1.18)
      ctx.fillRect(x0, top, x1 - x0, 1.2)
      ctx.fillRect(x0, top, 1.2, bottom - top)
    }
    woodGrain(ctx, 0, rail, s, s - rail, shadeHex(spec.lower, 0.86), false, 0.3)
  }
  // chair rail
  ctx.fillStyle = spec.rail
  ctx.fillRect(0, rail - 3, s, 6)
  ctx.fillStyle = shadeHex(spec.rail, 1.3)
  ctx.fillRect(0, rail - 3, s, 1.2)
  ctx.fillStyle = shadeHex(spec.rail, 0.6)
  ctx.fillRect(0, rail + 3, s, 1)
  wallGradient(ctx, s, spec)
  speckle(ctx, s, 60, spec.flecks, 0.5, 1.4)
}

function tileField(ctx, s, y0, y1, tile, grout, cols, rowH, bond = false, cap = null) {
  ctx.fillStyle = grout
  ctx.fillRect(0, y0, s, y1 - y0)
  const w = s / cols
  let row = 0
  for (let y = y1; y > y0; y -= rowH, row++) {
    const off = bond && row % 2 ? w / 2 : 0
    for (let i = -1; i <= cols; i++) {
      const x = i * w + off
      const top = Math.max(y0, y - rowH + 0.8)
      ctx.fillStyle = shadeHex(tile, 0.97 + rand() * 0.06)
      ctx.fillRect(x + 0.8, top, w - 1.6, y - 0.8 - top)
      // glaze highlight along the top edge
      ctx.fillStyle = shadeHex(tile, 1.12)
      ctx.globalAlpha = 0.5
      ctx.fillRect(x + 1.2, top + 0.3, w - 2.4, 0.8)
      ctx.globalAlpha = 1
    }
  }
  if (cap) {
    ctx.fillStyle = cap
    ctx.fillRect(0, y0 - 2, s, 5)
    ctx.fillStyle = shadeHex(cap, 1.3)
    ctx.fillRect(0, y0 - 2, s, 1)
  }
}

function tileWainscot(ctx, s, spec) {
  const top = wallY(s, spec.height ?? 1.4)
  plainPaper(ctx, s, spec, 0, top)
  tileField(ctx, s, top, s, spec.tile, spec.grout, 20, 12, false, spec.cap)
  wallGradient(ctx, s, spec)
  speckle(ctx, s, 50, spec.flecks, 0.5, 1.2)
  softBlots(ctx, s, 3, [shadeHex(spec.grout, 0.9)], 10, 22, 0.12)
}

function subway(ctx, s, spec) {
  tileField(ctx, s, 0, s, spec.tile, spec.grout, 16, 8, true)
  // a coloured band at shoulder height, the metro way
  const y = wallY(s, 1.5)
  ctx.fillStyle = spec.band
  ctx.globalAlpha = 0.9
  ctx.fillRect(0, y - 8, s, 7.2)
  ctx.globalAlpha = 1
  wallGradient(ctx, s, spec)
  speckle(ctx, s, 40, spec.flecks, 0.5, 1.2)
}

function plaster(ctx, s, spec, wall = true) {
  softBlots(ctx, s, 26, spec.mottle, 10, 34, 0.2)
  speckle(ctx, s, 120, spec.flecks, 0.4, 1.1)
  cracks(ctx, s, 2, spec.crack, 0.28, 46)
  if (wall) wallGradient(ctx, s, spec)
}

// Painted concrete block: 37.5 x 20 cm faces in running bond.
function cmu(ctx, s, spec) {
  const cols = 8
  const w = s / cols
  const h = 16
  ctx.fillStyle = spec.mortar
  ctx.fillRect(0, 0, s, s)
  let row = 0
  for (let y = s; y > 0; y -= h, row++) {
    const off = row % 2 ? w / 2 : 0
    for (let i = -1; i <= cols; i++) {
      ctx.fillStyle = shadeHex(spec.base, 0.97 + rand() * 0.06)
      ctx.fillRect(i * w + off + 1.2, Math.max(0, y - h + 1.2), w - 2.4, Math.min(h, y) - 2.4)
    }
  }
  speckle(ctx, s, 700, spec.flecks, 0.4, 1.2)
  wallGradient(ctx, s, spec)
}

function woodPanel(ctx, s, spec) {
  const n = spec.boards ?? 10
  const w = s / n
  for (let i = 0; i < n; i++) {
    const tone = shadeHex(choose(spec.woods), 0.97 + rand() * 0.06)
    ctx.fillStyle = tone
    ctx.fillRect(i * w, 0, w, s)
    woodGrain(ctx, i * w, 0, w, s, shadeHex(tone, 0.72), false, 0.9)
    ctx.fillStyle = spec.seam
    ctx.globalAlpha = 0.85
    ctx.fillRect(i * w, 0, 1.4, s)
    ctx.globalAlpha = 1
  }
  wallGradient(ctx, s, spec)
}

// Board-formed concrete panels with form-tie holes and leaching streaks.
function formwork(ctx, s, spec) {
  softBlots(ctx, s, 10, spec.stains, 16, 40, 0.24)
  speckle(ctx, s, 500, spec.flecks, 0.4, 1.3)
  ctx.strokeStyle = spec.seam
  ctx.lineWidth = 1.4
  ctx.globalAlpha = 0.7
  ctx.beginPath()
  ctx.moveTo(0, s / 2)
  ctx.lineTo(s, s / 2)
  ctx.moveTo(s / 2, 0)
  ctx.lineTo(s / 2, s)
  ctx.stroke()
  ctx.strokeRect(0, 0, s, s)
  ctx.globalAlpha = 1
  for (const x of [s / 4, (3 * s) / 4]) {
    for (const y of [s / 4, (3 * s) / 4]) {
      ctx.fillStyle = spec.tie
      ctx.beginPath()
      ctx.arc(x, y, 2.6, 0, Math.PI * 2)
      ctx.fill()
      // rust/leach streak under the tie hole
      const g = ctx.createLinearGradient(0, y, 0, y + 40)
      g.addColorStop(0, 'rgba(70,52,36,0.28)')
      g.addColorStop(1, 'rgba(70,52,36,0)')
      ctx.fillStyle = g
      ctx.fillRect(x - 1.5, y, 3, 40)
    }
  }
  wallGradient(ctx, s, spec)
}

function corrugated(ctx, s, spec, wall = true) {
  const p = spec.pitch ?? 12
  for (let x = 0; x < s; x += p) {
    const g = ctx.createLinearGradient(x, 0, x + p, 0)
    g.addColorStop(0, spec.dark)
    g.addColorStop(0.35, shadeHex(spec.base, 1.15))
    g.addColorStop(0.65, spec.base)
    g.addColorStop(1, spec.dark)
    ctx.fillStyle = g
    ctx.fillRect(x, 0, p, s)
  }
  // rust runs from fasteners
  for (let k = 0; k < 6; k++) {
    const x = rand() * s
    const y = rand() * s * 0.5
    const len = 30 + rand() * 90
    const g = ctx.createLinearGradient(0, y, 0, y + len)
    g.addColorStop(0, mixHex(choose(spec.rust), spec.base, 0.2))
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.globalAlpha = 0.35
    ctx.fillStyle = g
    ctx.fillRect(x, y, 2 + rand() * 3, len)
  }
  ctx.globalAlpha = 1
  if (wall) wallGradient(ctx, s, spec)
}

// ---------------------------------------------------------------------------
// Ceilings

// Mineral-fibre acoustic tile on a T-bar grid, fissured face.
function acoustic(ctx, s, spec) {
  speckle(ctx, s, 900, spec.flecks, 0.4, 1)
  ctx.strokeStyle = shadeHex(spec.base, 0.8)
  ctx.lineWidth = 0.8
  for (let k = 0; k < 340; k++) {
    ctx.globalAlpha = 0.18 + rand() * 0.2
    const x = rand() * s
    const y = rand() * s
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.quadraticCurveTo(x + range(-4, 4), y + range(-4, 4), x + range(-7, 7), y + range(-7, 7))
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  const n = spec.tiles ?? 4
  const t = s / n
  ctx.strokeStyle = spec.line
  ctx.lineWidth = 3
  for (let i = 0; i <= n; i++) {
    ctx.beginPath()
    ctx.moveTo(i * t, 0)
    ctx.lineTo(i * t, s)
    ctx.moveTo(0, i * t)
    ctx.lineTo(s, i * t)
    ctx.stroke()
  }
}

function slats(ctx, s, spec) {
  const n = spec.slats ?? 16
  const p = s / n
  for (let i = 0; i < n; i++) {
    const tone = choose(spec.woods)
    ctx.fillStyle = tone
    ctx.fillRect(0, i * p + p * 0.18, s, p * 0.64)
    woodGrain(ctx, 0, i * p + p * 0.18, s, p * 0.64, shadeHex(tone, 0.75), true, 0.6)
  }
}

// Exposed concrete waffle slab: 2 x 2 coffers per cell.
function exposed(ctx, s, spec) {
  speckle(ctx, s, 400, spec.flecks, 0.4, 1.2)
  const n = 2
  const t = s / n
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i * t
      const y = j * t
      ctx.fillStyle = shadeHex(spec.base, 0.78)
      ctx.fillRect(x + 16, y + 16, t - 32, t - 32)
      ctx.fillStyle = shadeHex(spec.base, 0.7)
      ctx.fillRect(x + 26, y + 26, t - 52, t - 52)
      ctx.fillStyle = shadeHex(spec.base, 1.1)
      ctx.globalAlpha = 0.6
      ctx.fillRect(x + 16, y + 16, t - 32, 2)
      ctx.globalAlpha = 1
    }
  }
  ctx.strokeStyle = spec.seam
  ctx.lineWidth = 1.2
  ctx.globalAlpha = 0.5
  ctx.strokeRect(0, 0, s, s)
  ctx.globalAlpha = 1
  softBlots(ctx, s, 6, [shadeHex(spec.base, 0.82)], 14, 34, 0.2)
}

export const FLOOR_STYLES = Object.freeze({
  carpetPattern, carpetTile, vct, checker, parquet, planks, terrazzo, mosaic, polished, grate, diamond,
})

export const WALL_STYLES = Object.freeze({
  stripe, damask, wainscot, tileWainscot, subway, plaster, cmu, woodPanel, formwork, corrugated,
})

export const CEILING_STYLES = Object.freeze({
  acoustic,
  plaster: (ctx, s, spec) => plaster(ctx, s, spec, false),
  slats,
  exposed,
  corrugated: (ctx, s, spec) => corrugated(ctx, s, spec, false),
})
