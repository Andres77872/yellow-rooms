import * as THREE from 'three'
import { hashStr } from '../world/core/hash.js'
import { DECAL_CELLS, DECAL_GRID, DECAL_KINDS, SAFETY_NOTICES, WAYFINDING, signPlateAt } from '../world/decalKinds.js'
import { baseFamilyOf } from '../world/families/registry.js'

// Per-world wall decal atlas (world/decalKinds.js): posters, notices,
// evacuation plans, calendars, memos, prints, clock dials, room signs,
// photographs. Every cell is painted procedurally from (family, world seed,
// cell), so each world hangs its own slogans, plans, months, stopped clocks
// and prints — the walls stop reading as the same building on every run.
//
// Signage is the exception: safety notices, room / level plates and
// wayfinding arrows carry FIXED meanings per cell (decalKinds.js), because
// the dressing chooses them by what a space is. A world varies only their
// house style — one sign typeface, plate colour and border for the whole
// building, as a real signage schedule would.
//
// A cell is painted in a logical space of its kind's aspect (longest side
// 256) and stretched into the square cell, so it maps undistorted onto a
// plate of that aspect. Painting needs a 2D canvas (browser only); the
// G-buffer material falls back to a flat neutral texel without it.

const LOGICAL = 256

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

// Painter context: the 2D context plus a seeded stream and helpers.
// `slot` is the cell's index within its kind and `offset` a per-world,
// per-kind roll: `unique` walks a list from that offset, so the cells of one
// kind never repeat an entry while the list lasts.
function painter(ctx, w, h, seed, slot = 0, offset = 0, house = null) {
  const r = mulberry32(seed)
  const p = {
    ctx,
    w,
    h,
    r,
    slot,
    house,
    range: (a, b) => a + r() * (b - a),
    pick: (list) => list[Math.floor(r() * list.length) % list.length],
    unique: (list) => list[(Math.floor(offset * list.length) + slot) % list.length],
    int: (a, b) => a + Math.floor(r() * (b - a + 1)),
    rect(x, y, rw, rh, color) {
      ctx.fillStyle = color
      ctx.fillRect(x, y, rw, rh)
    },
    text(str, x, y, size, color, { font = SANS, weight = 'bold', align = 'center', spacing = 0, maxW = 0 } = {}) {
      ctx.save()
      ctx.fillStyle = color
      ctx.textAlign = align
      ctx.textBaseline = 'middle'
      ctx.font = `${weight} ${size}px ${font}`
      if (spacing && 'letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`
      if (maxW) {
        const m = ctx.measureText(str).width
        if (m > maxW) {
          ctx.translate(x, y)
          ctx.scale(maxW / m, 1)
          ctx.fillText(str, 0, 0)
          ctx.restore()
          return
        }
      }
      ctx.fillText(str, x, y)
      ctx.restore()
    },
    // Typed body copy as grey bars: reads as text at any distance.
    lines(x, y, lw, count, pitch, color, thick = 2.2) {
      ctx.fillStyle = color
      for (let i = 0; i < count; i++) {
        const len = i === count - 1 ? lw * p.range(0.3, 0.7) : lw * p.range(0.82, 1)
        ctx.fillRect(x, y + i * pitch, len, thick)
      }
    },
  }
  return p
}

const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif'
const SERIF = 'Georgia, "Times New Roman", serif'
const MONO = '"Courier New", Courier, monospace'
const HAND = '"Comic Sans MS", "Marker Felt", "Segoe Print", cursive'

// --- Shared scenery -----------------------------------------------------------

const SKIES = [
  ['#1d2b53', '#7e2553', '#ff7b54', '#ffd56b'], // sunset
  ['#0b1d3a', '#24476b', '#7fa7c9', '#dbe8f2'], // cold dawn
  ['#26467a', '#4f86c6', '#a9cbe8', '#eaf3fa'], // clear day
  ['#2c1e3f', '#6b3d6e', '#d9826b', '#f3c58b'], // dusk haze
]

function scenery(p, x, y, w, h, kind = p.int(0, 3)) {
  const { ctx } = p
  const sky = p.pick(SKIES)
  const g = ctx.createLinearGradient(0, y, 0, y + h)
  sky.forEach((c, i) => g.addColorStop(i / (sky.length - 1), c))
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.fillStyle = g
  ctx.fillRect(x, y, w, h)
  // Sun / moon disc.
  ctx.globalAlpha = 0.85
  ctx.fillStyle = sky[3]
  ctx.beginPath()
  ctx.arc(x + w * p.range(0.2, 0.8), y + h * p.range(0.25, 0.5), h * p.range(0.06, 0.12), 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1
  const horizon = y + h * p.range(0.55, 0.72)
  if (kind === 0 || kind === 3) {
    // Mountain ridges, far to near.
    for (let layer = 0; layer < 3; layer++) {
      const t = layer / 2
      ctx.fillStyle = mixHex(sky[1], '#0a0a12', 0.35 + 0.45 * t)
      ctx.beginPath()
      ctx.moveTo(x, y + h)
      let yy = horizon - h * (0.25 - 0.08 * layer) * p.range(0.6, 1)
      for (let i = 0; i <= 12; i++) {
        yy += h * p.range(-0.08, 0.08)
        yy = Math.min(horizon + h * 0.08 * layer, Math.max(y + h * 0.2, yy))
        ctx.lineTo(x + (i / 12) * w, yy)
      }
      ctx.lineTo(x + w, y + h)
      ctx.fill()
    }
  } else if (kind === 1) {
    // Sea with a sun path and a lighthouse.
    const sea = ctx.createLinearGradient(0, horizon, 0, y + h)
    sea.addColorStop(0, mixHex(sky[1], '#000000', 0.2))
    sea.addColorStop(1, mixHex(sky[0], '#000000', 0.4))
    ctx.fillStyle = sea
    ctx.fillRect(x, horizon, w, y + h - horizon)
    ctx.fillStyle = sky[3]
    for (let i = 0; i < 14; i++) {
      ctx.globalAlpha = 0.25 + 0.4 * p.r()
      const yy = horizon + (i / 14) * (y + h - horizon)
      ctx.fillRect(x + w * 0.5 - (6 + i * 3) * p.range(0.5, 1), yy, (12 + i * 6) * p.range(0.5, 1), 1.5)
    }
    ctx.globalAlpha = 1
    ctx.fillStyle = '#111'
    const lx = x + w * p.range(0.1, 0.25)
    ctx.fillRect(lx, horizon - h * 0.22, w * 0.03, h * 0.22)
    ctx.fillRect(lx - w * 0.01, horizon - h * 0.25, w * 0.05, h * 0.03)
  } else {
    // Field and a lone road to the horizon.
    ctx.fillStyle = mixHex(sky[0], '#2d3b1d', 0.6)
    ctx.fillRect(x, horizon, w, y + h - horizon)
    ctx.fillStyle = mixHex(sky[2], '#555', 0.6)
    ctx.beginPath()
    ctx.moveTo(x + w * 0.49, horizon)
    ctx.lineTo(x + w * 0.51, horizon)
    ctx.lineTo(x + w * 0.75, y + h)
    ctx.lineTo(x + w * 0.25, y + h)
    ctx.fill()
    ctx.fillStyle = '#e8dca0'
    for (let i = 0; i < 6; i++) {
      const t = (i + 0.5) / 6
      ctx.fillRect(x + w * 0.5 - 0.6 - t, horizon + (y + h - horizon) * t * t, 1.2 + 2 * t, 3 + 8 * t)
    }
  }
  ctx.restore()
}

function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16)
  const pb = parseInt(b.slice(1), 16)
  const c = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t)
  return `rgb(${c(16)},${c(8)},${c(0)})`
}

// Aged paper: warm base, faint stains, yellowed edges.
function paper(p, base = '#f2efe4') {
  const { ctx, w, h } = p
  p.rect(0, 0, w, h, base)
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.75)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(1, 'rgba(120,96,40,0.22)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  for (let i = 0; i < 3; i++) {
    ctx.globalAlpha = 0.06 + 0.06 * p.r()
    ctx.fillStyle = '#8a6a2a'
    ctx.beginPath()
    ctx.arc(p.range(0, w), p.range(0, h), p.range(6, 30), 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

function tape(p, x, y, angle) {
  const { ctx } = p
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.fillStyle = 'rgba(230,220,180,0.75)'
  ctx.fillRect(-14, -5, 28, 10)
  ctx.restore()
}

// --- Painters --------------------------------------------------------------

const VIRTUES = [
  'PERSEVERANCE', 'TEAMWORK', 'EXCELLENCE', 'DEDICATION', 'VISION', 'INTEGRITY',
  'QUALITY', 'COMMITMENT', 'PATIENCE', 'OPPORTUNITY', 'LEADERSHIP', 'ATTITUDE',
]
const MOTTOS = [
  ['Every summit was reached', 'one ordinary step at a time.'],
  ['The view belongs to those', 'who keep walking.'],
  ['Small efforts, repeated daily,', 'become the work of a lifetime.'],
  ['Together we go further', 'than any of us alone.'],
  ['The way forward', 'is always through.'],
  ['Stay the course.', 'The horizon is closer than it looks.'],
  ['Do the work in front of you.', 'Then do it again.'],
]

function poster(p) {
  const { w, h } = p
  const frame = p.pick(['#0c0c0c', '#101626', '#1a1410'])
  p.rect(0, 0, w, h, frame)
  const m = w * 0.08
  scenery(p, m, m, w - 2 * m, h * 0.62)
  p.rect(m - 1, m - 1, w - 2 * m + 2, 1, '#9a8f70')
  p.text(p.unique(VIRTUES), w / 2, h * 0.76, 20, '#f1ead2', { font: SERIF, weight: 'normal', spacing: 3, maxW: w - 2 * m })
  const [a, b] = p.unique(MOTTOS)
  p.text(a, w / 2, h * 0.85, 9, '#c9c1a6', { font: SERIF, weight: 'normal', maxW: w - 2 * m })
  p.text(b, w / 2, h * 0.9, 9, '#c9c1a6', { font: SERIF, weight: 'normal', maxW: w - 2 * m })
}

// One notice per SAFETY_NOTICES id (decalKinds.js), in any world.
const SAFETY = {
  wetFloor: { band: '#f2c318', ink: '#111', head: 'CAUTION', body: ['WET FLOOR'], icon: 'warn' },
  washHands: { band: '#1f4fa0', ink: '#fff', head: 'NOTICE', body: ['EMPLOYEES MUST', 'WASH HANDS'], icon: 'none' },
  highVoltage: { band: '#c8201e', ink: '#fff', head: 'DANGER', body: ['HIGH VOLTAGE', 'KEEP OUT'], icon: 'bolt' },
  authorized: { band: '#1f4fa0', ink: '#fff', head: 'NOTICE', body: ['AUTHORIZED', 'PERSONNEL ONLY'], icon: 'none' },
  fireDoor: { band: '#1f4fa0', ink: '#fff', head: 'FIRE DOOR', body: ['KEEP SHUT'], icon: 'none' },
  doNotBlock: { band: '#f2c318', ink: '#111', head: 'WARNING', body: ['DO NOT', 'BLOCK CORRIDOR'], icon: 'warn' },
  confinedSpace: { band: '#c8201e', ink: '#fff', head: 'DANGER', body: ['CONFINED SPACE', 'PERMIT ONLY'], icon: 'warn' },
  fallHazard: { band: '#f2c318', ink: '#111', head: 'WARNING', body: ['FALL HAZARD', 'KEEP BACK'], icon: 'warn' },
}

function safety(p) {
  const { ctx, w, h, house } = p
  const s = SAFETY[SAFETY_NOTICES[p.slot]] ?? SAFETY.authorized
  p.rect(0, 0, w, h, house.notice)
  p.rect(4, 4, w - 8, h * 0.24, s.band)
  p.text(s.head, w / 2, 4 + h * 0.12, 26, s.ink, { font: house.font, maxW: w - 20 })
  const cy = h * 0.5
  const R = h * 0.15
  ctx.lineWidth = 7
  if (s.icon === 'warn' || s.icon === 'bolt') {
    ctx.fillStyle = '#f2c318'
    ctx.strokeStyle = '#111'
    ctx.beginPath()
    ctx.moveTo(w / 2, cy - R)
    ctx.lineTo(w / 2 + R * 1.1, cy + R * 0.8)
    ctx.lineTo(w / 2 - R * 1.1, cy + R * 0.8)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    p.text(s.icon === 'bolt' ? 'ϟ' : '!', w / 2, cy + R * 0.2, R * 1.1, '#111')
  } else if (s.icon === 'nosmoke') {
    ctx.strokeStyle = '#c8201e'
    p.rect(w / 2 - R * 0.8, cy - 4, R * 1.4, 8, '#333')
    p.rect(w / 2 + R * 0.6, cy - 4, R * 0.25, 8, '#e06a1e')
    ctx.beginPath()
    ctx.arc(w / 2, cy, R, 0, Math.PI * 2)
    ctx.moveTo(w / 2 - R * 0.7, cy - R * 0.7)
    ctx.lineTo(w / 2 + R * 0.7, cy + R * 0.7)
    ctx.stroke()
  } else if (s.icon === 'cross') {
    p.rect(w / 2 - R * 0.3, cy - R, R * 0.6, R * 2, '#1d7a3e')
    p.rect(w / 2 - R, cy - R * 0.3, R * 2, R * 0.6, '#1d7a3e')
  } else {
    p.lines(w * 0.15, cy - 16, w * 0.7, 4, 9, '#9a9a9a')
  }
  s.body.forEach((line, i) => p.text(line, w / 2, h * 0.76 + i * 22, 17, '#161616', { font: house.font, maxW: w - 24 }))
}

function evac(p) {
  const { ctx, w, h } = p
  p.rect(0, 0, w, h, '#f6f5ef')
  p.rect(0, 0, w, 26, '#b81d18')
  p.text(p.unique(['EVACUATION PLAN', 'IN CASE OF FIRE', 'EMERGENCY EXIT PLAN', 'FIRE ESCAPE ROUTE']), w / 2, 13, 15, '#fff', { maxW: w - 20 })
  // Floor plan: a corridor spine with rooms off it.
  const x0 = 14
  const y0 = 38
  const pw = w - 28
  const ph = h - 72
  ctx.strokeStyle = '#555'
  ctx.lineWidth = 2
  ctx.strokeRect(x0, y0, pw, ph)
  const spineY = y0 + ph * p.range(0.4, 0.6)
  p.rect(x0, spineY - 9, pw, 18, '#e3e1d6')
  ctx.lineWidth = 1.2
  for (const [top, bottom] of [[y0, spineY - 9], [spineY + 9, y0 + ph]]) {
    let x = x0
    while (x < x0 + pw - 10) {
      const rw = p.range(22, 46)
      ctx.strokeRect(x, top, Math.min(rw, x0 + pw - x), bottom - top)
      x += rw
    }
  }
  // Exit arrows along the corridor to both ends.
  ctx.fillStyle = '#1d8a44'
  const you = x0 + pw * p.range(0.3, 0.7)
  for (const dir of [-1, 1]) {
    for (let i = 1; i <= 3; i++) {
      const ax = you + dir * i * pw * 0.11
      ctx.beginPath()
      ctx.moveTo(ax + dir * 6, spineY)
      ctx.lineTo(ax - dir * 3, spineY - 5)
      ctx.lineTo(ax - dir * 3, spineY + 5)
      ctx.fill()
    }
    p.rect(dir < 0 ? x0 - 4 : x0 + pw - 6, spineY - 9, 10, 18, '#1d8a44')
  }
  ctx.fillStyle = '#d42020'
  ctx.beginPath()
  ctx.arc(you, spineY, 5, 0, Math.PI * 2)
  ctx.fill()
  p.text('YOU ARE HERE', you, spineY + 18, 8, '#d42020')
  p.lines(14, h - 26, w * 0.4, 2, 7, '#777', 1.6)
  p.rect(w - 70, h - 27, 8, 8, '#1d8a44')
  p.rect(w - 70, h - 16, 8, 8, '#d42020')
  p.lines(w - 58, h - 25, 44, 2, 11, '#777', 1.6)
}

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER']

function calendar(p) {
  const { ctx, w, h } = p
  p.rect(0, 0, w, h, '#f7f6f0')
  scenery(p, 8, 8, w - 16, h * 0.42)
  const month = p.int(0, 11)
  const year = p.int(1987, 1999)
  p.text(`${MONTHS[month]} ${year}`, w / 2, h * 0.5 + 6, 15, '#b81d18', { spacing: 1, maxW: w - 20 })
  const gx = 10
  const gy = h * 0.56
  const cw = (w - 20) / 7
  const ch = (h - gy - 8) / 6
  ;['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach((d, i) => p.text(d, gx + cw * (i + 0.5), gy + ch * 0.4, 9, i === 0 ? '#b81d18' : '#333'))
  const first = p.int(0, 6)
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month]
  const crossed = p.int(0, days)
  ctx.lineWidth = 1.6
  for (let d = 1; d <= days; d++) {
    const slot = first + d - 1
    const cx = gx + cw * ((slot % 7) + 0.5)
    const cy = gy + ch * (Math.floor(slot / 7) + 1.4)
    if (cy > h - 4) break
    p.text(String(d), cx, cy, 9, slot % 7 === 0 ? '#b81d18' : '#333', { weight: 'normal' })
    if (d <= crossed) {
      ctx.strokeStyle = 'rgba(190,30,30,0.8)'
      ctx.beginPath()
      ctx.moveTo(cx - 7, cy - 6)
      ctx.lineTo(cx + 7, cy + 6)
      ctx.moveTo(cx + 7, cy - 6)
      ctx.lineTo(cx - 7, cy + 6)
      ctx.stroke()
    }
  }
}

const MEMO_HEADS = [
  'MEMO', 'NOTICE', 'OUT OF ORDER', 'STAFF MEETING', 'PLEASE NOTE', 'REMINDER',
  'LOST & FOUND', 'SCHEDULE', 'EXTENSIONS', 'FIRE DRILL', 'NEW POLICY', 'ATTENTION ALL STAFF',
]

function memo(p) {
  const { w, h } = p
  paper(p, p.pick(['#f2efe4', '#f7f3dc', '#ece9e0', '#f3e9d2']))
  const head = p.unique(MEMO_HEADS)
  const typed = p.r() < 0.5
  p.text(head, w / 2, h * 0.1, typed ? 14 : 18, '#1a1a1a', { font: typed ? MONO : SANS, maxW: w - 24 })
  p.rect(14, h * 0.16, w - 28, 1.5, '#333')
  if (head === 'EXTENSIONS' || head === 'SCHEDULE') {
    // Table: label bars and number bars.
    for (let i = 0; i < 12; i++) {
      const y = h * 0.22 + i * h * 0.058
      p.lines(16, y, w * 0.45, 1, 0, '#555', 2)
      p.lines(w * 0.68, y, w * 0.18, 1, 0, '#555', 2)
      p.rect(14, y + h * 0.04, w - 28, 0.6, '#bbb')
    }
  } else {
    p.lines(16, h * 0.23, w - 32, p.int(5, 9), h * 0.045, '#5a5a5a')
    p.lines(16, h * 0.62, w - 32, p.int(2, 5), h * 0.045, '#5a5a5a')
    p.lines(w * 0.55, h * 0.88, w * 0.3, 1, 0, '#333', 2)
  }
  tape(p, w * 0.5, 4, p.range(-0.2, 0.2))
}

function art(p, family) {
  const { ctx, w, h } = p
  p.rect(0, 0, w, h, baseFamilyOf(family) === 'hotel' ? '#2a1d14' : '#1a1a1a')
  const mat = w * 0.07
  p.rect(mat, mat, w - 2 * mat, h - 2 * mat, '#efe9dc')
  const ix = mat * 2
  const iy = mat * 2
  const iw = w - 4 * mat
  const ih = h - 4 * mat
  ctx.save()
  ctx.beginPath()
  ctx.rect(ix, iy, iw, ih)
  ctx.clip()
  const style = p.unique([0, 1, 2, 3, 4])
  if (style === 0) {
    // Colour field: soft stacked rectangles.
    const cols = p.pick([['#8c3b2f', '#c46a3a', '#e8b46c'], ['#2f4f6a', '#6c8fa6', '#c9d6d8'], ['#5a3a5e', '#a65e6e', '#e3a99a']])
    p.rect(ix, iy, iw, ih, cols[0])
    ctx.globalAlpha = 0.85
    p.rect(ix + iw * 0.08, iy + ih * 0.1, iw * 0.84, ih * 0.38, cols[1])
    p.rect(ix + iw * 0.08, iy + ih * 0.56, iw * 0.84, ih * 0.32, cols[2])
    ctx.globalAlpha = 1
  } else if (style === 1) {
    // Memphis shapes.
    p.rect(ix, iy, iw, ih, p.pick(['#f1e7d6', '#e7eef0', '#f4e1e1']))
    for (let i = 0; i < 9; i++) {
      ctx.fillStyle = p.pick(['#e2574c', '#2fa4b5', '#f2c14e', '#2b2d42', '#9b5de5'])
      const x = ix + p.range(0, iw)
      const y = iy + p.range(0, ih)
      const s = p.range(8, 30)
      ctx.beginPath()
      if (i % 3 === 0) ctx.arc(x, y, s / 2, 0, Math.PI * 2)
      else if (i % 3 === 1) ctx.rect(x, y, s, s * 0.4)
      else {
        ctx.moveTo(x, y)
        ctx.lineTo(x + s, y + s * 0.2)
        ctx.lineTo(x + s * 0.3, y + s)
      }
      ctx.fill()
    }
  } else if (style === 2) {
    // Botanical study: stem, paired leaves, a Latin-looking caption.
    p.rect(ix, iy, iw, ih, '#efe6cf')
    ctx.strokeStyle = '#3f5a2e'
    ctx.fillStyle = '#5e7f45'
    ctx.lineWidth = 2
    const bx = ix + iw / 2
    ctx.beginPath()
    ctx.moveTo(bx, iy + ih * 0.88)
    ctx.quadraticCurveTo(bx + p.range(-20, 20), iy + ih * 0.5, bx + p.range(-8, 8), iy + ih * 0.12)
    ctx.stroke()
    for (let i = 0; i < 6; i++) {
      const t = 0.2 + i * 0.11
      const y = iy + ih * (0.88 - t * 0.85)
      for (const side of [-1, 1]) {
        ctx.save()
        ctx.translate(bx, y)
        ctx.rotate(side * (0.7 + 0.2 * p.r()))
        ctx.beginPath()
        ctx.ellipse(0, -10, 4.5, 11, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
    }
    p.text(p.pick(['Ficus elastica', 'Monstera deliciosa', 'Pteris cretica', 'Hedera helix']), bx, iy + ih * 0.95, 8, '#4a3a20', { font: SERIF, weight: 'italic' })
  } else {
    scenery(p, ix, iy, iw, ih)
  }
  ctx.restore()
}

function clock(p) {
  const { ctx, w, h } = p
  const cx = w / 2
  const cy = h / 2
  const R = w * 0.47
  p.rect(0, 0, w, h, '#2b2a27')
  ctx.fillStyle = p.pick(['#f4f0e2', '#f8f8f4', '#efe6cc'])
  ctx.beginPath()
  ctx.arc(cx, cy, R, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#222'
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2
    const major = i % 5 === 0
    ctx.lineWidth = major ? 4 : 1.5
    ctx.beginPath()
    ctx.moveTo(cx + Math.sin(a) * R * (major ? 0.8 : 0.88), cy - Math.cos(a) * R * (major ? 0.8 : 0.88))
    ctx.lineTo(cx + Math.sin(a) * R * 0.94, cy - Math.cos(a) * R * 0.94)
    ctx.stroke()
  }
  if (p.r() < 0.7) {
    for (let n = 1; n <= 12; n++) {
      const a = (n / 12) * Math.PI * 2
      p.text(String(n), cx + Math.sin(a) * R * 0.66, cy - Math.cos(a) * R * 0.66, 19, '#1b1b1b')
    }
  }
  p.text(p.pick(['QUARTZ', 'STANDARD', 'SIMPLEX', 'NATIONAL']), cx, cy + R * 0.32, 9, '#666', { spacing: 1 })
  // Stopped at a time of its own.
  const hour = p.range(0, 12)
  const minute = (hour % 1) * 60
  const hand = (angle, len, width, color) => {
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(cx - Math.sin(angle) * len * 0.15, cy + Math.cos(angle) * len * 0.15)
    ctx.lineTo(cx + Math.sin(angle) * len, cy - Math.cos(angle) * len)
    ctx.stroke()
  }
  hand((hour / 12) * Math.PI * 2, R * 0.5, 8, '#151515')
  hand((minute / 60) * Math.PI * 2, R * 0.78, 5, '#151515')
  hand(p.range(0, Math.PI * 2), R * 0.84, 1.8, '#c0261e')
  ctx.fillStyle = '#151515'
  ctx.beginPath()
  ctx.arc(cx, cy, 6, 0, Math.PI * 2)
  ctx.fill()
  // Domed glass sheen.
  const g = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R)
  g.addColorStop(0, 'rgba(255,255,255,0.22)')
  g.addColorStop(0.45, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(cx, cy, R, 0, Math.PI * 2)
  ctx.fill()
}

// Room / level / plant plate: the label fixed by the cell (decalKinds.js
// SIGN_PLATES), the plate in the world's house style. A numbered plate
// leaves a recessed field on its right for the raised numerals the dressing
// sets per room or storey.
function sign(p, family) {
  const { w, h, house } = p
  const plate = signPlateAt(DECAL_KINDS.sign[0] + p.slot, family)
  p.rect(0, 0, w, h, house.rim)
  p.rect(3, 3, w - 6, h - 6, house.plate)
  const label = plate?.text ?? ''
  if (plate?.numbered) {
    p.text(label, w * 0.28, h * 0.44, 30, house.ink, { font: house.font, spacing: 2, maxW: w * 0.5 })
    p.rect(w * 0.56, h * 0.18, w * 0.39, h * 0.64, house.field)
  } else {
    p.text(label, w / 2, h * 0.44, 30, house.ink, { font: house.font, spacing: 2, maxW: w - 30 })
  }
  // Braille strip.
  const x0 = plate?.numbered ? w * 0.28 - 50 : w / 2 - 50
  for (let i = 0; i < 14; i++) {
    if (p.r() < 0.45) continue
    p.rect(x0 + i * 7, h * 0.76, 3, 3, house.braille)
  }
}

const LIMINAL = [
  ['YOU HAVE BEEN', 'HERE BEFORE'],
  ['DO NOT TRUST', 'THE EXIT SIGNS'],
  ['THE HUM IS', 'LOUDER TODAY'],
  ['COUNT THE', 'DOORS AGAIN'],
  ['STAY IN', 'THE LIGHT'],
  ['IT WAS NOT', 'A HALLWAY'],
  ['WHO TURNED', 'THE WINDOWS OFF'],
  ['IF YOU READ THIS', 'KEEP WALKING'],
  ['THERE IS NO', 'FLOOR 0'],
  ['DON\'T LOOK', 'BEHIND YOU'],
]

function liminal(p) {
  const { ctx, w, h } = p
  paper(p, p.pick(['#efeadb', '#f4f1e6', '#e9e3cc']))
  const lines = p.unique(LIMINAL)
  const ink = p.pick(['#1b1b1b', '#2b2f6a', '#6a1c1c'])
  ctx.save()
  ctx.translate(w / 2, h / 2)
  ctx.rotate(p.range(-0.08, 0.08))
  lines.forEach((line, i) => p.text(line, 0, (i - 0.5) * 40, 25, ink, { font: HAND, maxW: w - 30 }))
  ctx.restore()
  // Scribbled underline and a smudge.
  ctx.strokeStyle = ink
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(w * 0.2, h * 0.7)
  for (let i = 1; i <= 8; i++) ctx.lineTo(w * (0.2 + i * 0.075), h * 0.7 + p.range(-3, 3))
  ctx.stroke()
  tape(p, w * 0.2, 6, -0.4)
  tape(p, w * 0.8, 6, 0.35)
}

function photo(p) {
  const { ctx, w, h } = p
  p.rect(0, 0, w, h, '#f1efe8')
  const m = w * 0.05
  const ix = m
  const iy = m
  const iw = w - 2 * m
  const ih = h - m - h * 0.16
  // A photograph of a place like this one: a one-point-perspective
  // corridor under a row of ceiling lights, warm and over-exposed.
  ctx.save()
  ctx.beginPath()
  ctx.rect(ix, iy, iw, ih)
  ctx.clip()
  const wall = p.pick(['#c9b56a', '#b8a26b', '#a9a07e', '#c2a98a'])
  p.rect(ix, iy, iw, ih, wall)
  const vx = ix + iw * p.range(0.4, 0.6)
  const vy = iy + ih * p.range(0.42, 0.52)
  const hw = iw * 0.09
  const hh = ih * 0.13
  ctx.fillStyle = mixHex(wall, '#ffffff', 0.25)
  ctx.beginPath()
  ctx.moveTo(ix, iy)
  ctx.lineTo(ix + iw, iy)
  ctx.lineTo(vx + hw, vy - hh)
  ctx.lineTo(vx - hw, vy - hh)
  ctx.fill()
  ctx.fillStyle = mixHex(wall, '#3a2e1a', 0.45)
  ctx.beginPath()
  ctx.moveTo(ix, iy + ih)
  ctx.lineTo(ix + iw, iy + ih)
  ctx.lineTo(vx + hw, vy + hh)
  ctx.lineTo(vx - hw, vy + hh)
  ctx.fill()
  ctx.fillStyle = mixHex(wall, '#000000', 0.12)
  ctx.beginPath()
  ctx.moveTo(ix + iw, iy)
  ctx.lineTo(ix + iw, iy + ih)
  ctx.lineTo(vx + hw, vy + hh)
  ctx.lineTo(vx + hw, vy - hh)
  ctx.fill()
  p.rect(vx - hw, vy - hh, hw * 2, hh * 2, mixHex(wall, '#000000', 0.55))
  ctx.fillStyle = '#fffbe6'
  for (let i = 0; i < 5; i++) {
    const t = Math.pow(0.62, i)
    const ly = vy - hh - (vy - hh - iy) * t * 0.8
    const lw = iw * 0.16 * t + 2
    ctx.fillRect(vx - lw / 2, ly, lw, 2 + 6 * t)
  }
  // Over-exposure bloom and grain.
  const g = ctx.createRadialGradient(vx, iy + ih * 0.2, 4, vx, iy + ih * 0.2, iw * 0.6)
  g.addColorStop(0, 'rgba(255,250,220,0.35)')
  g.addColorStop(1, 'rgba(255,250,220,0)')
  ctx.fillStyle = g
  ctx.fillRect(ix, iy, iw, ih)
  ctx.restore()
  // Camcorder-style date stamp.
  const yy = String(p.int(88, 99))
  const mm = String(p.int(1, 12)).padStart(2, '0')
  const dd = String(p.int(1, 28)).padStart(2, '0')
  p.text(`'${yy} ${mm} ${dd}`, ix + iw - 6, iy + ih - 10, 11, '#ff8a2a', { font: MONO, align: 'right' })
  p.lines(m + 4, h - h * 0.09, w * 0.4, 1, 0, '#6a6a8a', 2)
}

// Arrow plate: label and direction fixed by the cell (decalKinds.js
// WAYFINDING), dir -1 pointing to the viewer's left.
function wayfinding(p) {
  const { ctx, w, h, house } = p
  const { label, dir } = WAYFINDING[p.slot] ?? WAYFINDING[0]
  p.rect(0, 0, w, h, house.wayDark ? '#202226' : '#e9e6dc')
  const ink = house.wayDark ? '#f0eee6' : '#202226'
  const ax = dir < 0 ? h * 0.55 : w - h * 0.55
  const ay = h / 2
  ctx.fillStyle = label === 'EXIT' ? '#1d8a44' : ink
  ctx.beginPath()
  ctx.moveTo(ax + dir * h * 0.3, ay)
  ctx.lineTo(ax - dir * h * 0.05, ay - h * 0.28)
  ctx.lineTo(ax - dir * h * 0.05, ay - h * 0.1)
  ctx.lineTo(ax - dir * h * 0.32, ay - h * 0.1)
  ctx.lineTo(ax - dir * h * 0.32, ay + h * 0.1)
  ctx.lineTo(ax - dir * h * 0.05, ay + h * 0.1)
  ctx.lineTo(ax - dir * h * 0.05, ay + h * 0.28)
  ctx.fill()
  p.text(label, dir < 0 ? (w + h) / 2 : (w - h) / 2, ay, 34, ink, { font: house.font, spacing: 2, maxW: w - h * 1.4 })
}

function chart(p) {
  const { ctx, w, h } = p
  paper(p, '#f6f5f0')
  p.text(p.unique(['PRODUCTIVITY', 'Q3 TARGETS', 'ATTENDANCE', 'OUTPUT / WEEK', 'MORALE INDEX']), w / 2, 18, 14, '#222', { maxW: w - 20 })
  const x0 = 26
  const y0 = h - 22
  ctx.strokeStyle = '#333'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(x0, 34)
  ctx.lineTo(x0, y0)
  ctx.lineTo(w - 12, y0)
  ctx.stroke()
  const n = 7
  const bw = (w - x0 - 20) / n
  let v = p.range(0.6, 0.9)
  const colours = ['#2f5f9e', '#c0392b', '#2e8b57', '#d68910']
  const col = p.pick(colours)
  for (let i = 0; i < n; i++) {
    v = Math.max(0.08, Math.min(0.95, v + p.range(-0.22, 0.12)))
    const bh = v * (y0 - 40)
    p.rect(x0 + 4 + i * bw, y0 - bh, bw * 0.7, bh, col)
  }
  ctx.strokeStyle = '#c0261e'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x0 + 6, 46)
  ctx.lineTo(w - 18, y0 - 12)
  ctx.stroke()
  tape(p, 10, 8, -0.6)
}

const PAINTERS = { poster, safety, evac, calendar, memo, art, clock, sign, liminal, photo, wayfinding, chart }

// The building's signage schedule: one typeface, plate and notice stock for
// every sign of the world.
const SIGN_FONTS = [SANS, '"Arial Narrow", Arial, sans-serif', 'Verdana, Geneva, sans-serif', '"Trebuchet MS", sans-serif', '"Gill Sans", "Gill Sans MT", Calibri, sans-serif']

function houseStyle(family, seed) {
  const r = mulberry32(hashStr(`decal|${family}|${seed}|house`))
  const pick = (list) => list[Math.floor(r() * list.length) % list.length]
  const plate = pick(baseFamilyOf(family) === 'hotel' ? ['#3b2416', '#1f2a3a', '#2e2e2e'] : ['#1f3c6e', '#2e2e30', '#5a5a58', '#164a3c', '#6e1f1f'])
  return {
    font: pick(SIGN_FONTS),
    plate,
    field: mixHex(plate, '#000000', 0.28),
    rim: pick(baseFamilyOf(family) === 'hotel' ? ['#b08d57', '#9a9a92'] : ['#bdb9ad', '#9a9a92', '#d8d4c8']),
    ink: '#f2f0e8',
    braille: '#d8d4c8',
    notice: pick(['#f4f2ec', '#f6f4e8', '#eef0f0']),
    wayDark: r() < 0.6,
  }
}

// Paint the full atlas canvas for (family, seed). Returns the canvas.
export function paintDecalAtlas(family, seed, size = 1024) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  const cell = size / DECAL_GRID
  ctx.fillStyle = '#d8d4c8'
  ctx.fillRect(0, 0, size, size)
  const house = houseStyle(family, seed)
  for (const [kind, [first, count, aspect]] of Object.entries(DECAL_KINDS)) {
    const lw = aspect >= 1 ? LOGICAL : LOGICAL * aspect
    const lh = aspect >= 1 ? LOGICAL / aspect : LOGICAL
    for (let i = 0; i < count; i++) {
      const index = first + i
      const col = index % DECAL_GRID
      const row = Math.floor(index / DECAL_GRID)
      ctx.save()
      ctx.beginPath()
      ctx.rect(col * cell, row * cell, cell, cell)
      ctx.clip()
      ctx.translate(col * cell, row * cell)
      ctx.scale(cell / lw, cell / lh)
      const offset = hashStr(`decal|${family}|${seed}|${kind}`) / 4294967296
      const p = painter(ctx, lw, lh, hashStr(`decal|${family}|${seed}|${index}`), i, offset, house)
      PAINTERS[kind](p, family)
      ctx.restore()
    }
  }
  return c
}

// Linear average colour per cell (path-tracer proxies read one albedo per
// decal instance instead of sampling the atlas).
export function decalCellAverages(c) {
  const s = document.createElement('canvas')
  s.width = s.height = DECAL_GRID
  const ctx = s.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(c, 0, 0, DECAL_GRID, DECAL_GRID)
  const px = ctx.getImageData(0, 0, DECAL_GRID, DECAL_GRID).data
  const out = new Float32Array(DECAL_CELLS * 3)
  const lin = (v) => {
    const x = v / 255
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  for (let i = 0; i < DECAL_CELLS; i++) {
    out[i * 3] = lin(px[i * 4])
    out[i * 3 + 1] = lin(px[i * 4 + 1])
    out[i * 3 + 2] = lin(px[i * 4 + 2])
  }
  return out
}

export function buildDecalAtlas(family, seed, { size = 1024, aniso = 1 } = {}) {
  const c = paintDecalAtlas(family, seed, size)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = aniso
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return { texture: tex, averages: decalCellAverages(c), family, seed, size }
}

// Neutral 1x1 stand-in until (or unless) a world atlas is painted.
export function blankDecalTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([216, 212, 200, 255]), 1, 1)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}
