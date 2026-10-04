import { CHUNK, cIdx } from './constants.js'
import { fmix32, hash2i, hash3i } from './core/hash.js'
import { familyPalette } from './familyPalette.js'
import { baseFamilyOf, isLiminal } from './families/registry.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_STAIR,
  CELL_VOID,
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  SPACE_ROLE_ARCHIVE,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_BEDROOM,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_COPY,
  SPACE_ROLE_DINING,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_LIBRARY,
  SPACE_ROLE_LIVING,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_NONE,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
  SPACE_CLASS_CIRCULATION,
  SPACE_CLASS_ROOM,
  SPACE_CLASS_UNKNOWN,
} from './mapTypes.js'

// World surface sets: a building's finish schedule, procedural but coherent.
//
// A family used to paint every room of a world with ONE floor, ONE wall and
// ONE ceiling texture, so every office was the same yellow box. The first
// surface sets fixed that with per-room dice — each room hashed its floor,
// wall and ceiling separately — and the result read as a random patchwork:
// a corridor flipped finish at every lobby node, sewer tunnels re-rolled
// every 12 m, neighbouring offices of one department had unrelated carpets
// and bathrooms could come out carpeted.
//
// A real building is specified by a FINISH SCHEDULE: a short legend of
// finish codes reused across every room of a type, chosen top down. So is
// this one:
//   * the world draws a theme (the decade the building was last refitted)
//     and, per room CATEGORY, two coordinated PACKAGES — a floor, a wall and
//     a ceiling chosen together under material-register compatibility, hard
//     category rules (wet rooms washable, service rooms hard-wearing,
//     corridors calm underfoot) and the ceiling > wall > floor reflectance
//     order of real interiors;
//   * a space resolves ONE package (spaceAt / roomContext): corridors and
//     open halls per storey, rooms per district (the department), with rare
//     refitted floors and odd rooms as deliberate exceptions;
//   * finishes therefore change only where spaces meet, and the zone map
//     flags every floor change so the shader lays a transition strip there;
//   * wear is a smooth field across the world, so whole wings age together.
//
// Contract:
//   * layer 0 of every slot is the family's canonical palette surface
//     (familyPalette.js) unchanged, so the family still reads as itself, and
//     every consumer of the single base texture (path tracer proxies, editor,
//     light grid albedo) keeps seeing exactly what it saw before;
//   * the set is a pure function of (family, worldSeed), and a cell's
//     resolution a pure function of its ChunkData: the zone map built by the
//     chunk, the textures built by the renderer and the dressing all agree;
//   * a space's key is stable across chunk seams, so a room spanning a seam
//     keeps one finish.
//
// THREE-free (runs under Vitest with the rest of the generation graph).

export const SURFACE_SLOTS = Object.freeze(['floor', 'wall', 'ceiling'])
export const SURFACE_LAYER_COUNT = Object.freeze({ floor: 8, wall: 8, ceiling: 6 })
export const SURFACE_MAX_LAYERS = 8
// Zone map texels: one per cell plus a one-cell halo so wall faces on the
// chunk border can read the room on the neighbour's side.
export const ZONE_MAP_SIZE = CHUNK + 2

// Room categories a recipe can serve.
export const ZONE_WORK = 'work'
export const ZONE_WET = 'wet'
export const ZONE_SOFT = 'soft'
export const ZONE_SERVICE = 'service'
export const ZONE_CIRC = 'circ'
export const ZONE_HALL = 'hall'
const ALL = Object.freeze([ZONE_WORK, ZONE_WET, ZONE_SOFT, ZONE_SERVICE, ZONE_CIRC, ZONE_HALL])

const SALT_THEME = 0x5eaf00d
const SALT_ZONE = 0x7a11
const SALT_DECAY = 0xdec4

// ---------------------------------------------------------------------------
// Colour helpers (sRGB hex strings, the canvas painters' currency).

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

function rgbOf(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function hexOf(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

export function mixHex(a, b, t) {
  const x = rgbOf(a)
  const y = rgbOf(b)
  return hexOf(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t)
}

// Multiply brightness (k > 1 lightens, toward white past 255 it clips).
export function shadeHex(hex, k) {
  const [r, g, b] = rgbOf(hex)
  return hexOf(r * k, g * k, b * k)
}

export function hexLuma(hex) {
  const [r, g, b] = rgbOf(hex)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

function rgba(hex, a) {
  const [r, g, b] = rgbOf(hex)
  return `rgba(${r},${g},${b},${a})`
}

// Seeded PRNG (mulberry32) for recipe parameters.
function rngOf(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (r, list) => list[Math.floor(r() * list.length) % list.length]
const jitter = (r, hex, amount) => shadeHex(hex, 1 + (r() - 0.5) * 2 * amount)
// A few tone-on-tone flecks around a base colour.
const flecksOf = (hex, k = 0.06) => [shadeHex(hex, 1 - k), shadeHex(hex, 1 + k), shadeHex(hex, 1 - k * 1.6)]

// ---------------------------------------------------------------------------
// World themes. Each world draws one: the accent pair the variant recipes
// borrow for patterned carpet, stripes, wainscots and tile — the decade the
// building was last refurbished in. Neutral wood/tile tones ride alongside.

export const SURFACE_THEMES = Object.freeze([
  { id: 'mauve90s', accent: '#7f6b86', accent2: '#4f7f7a', wood: '#8a6a4a', tile: '#d9d6cc', dark: '#3c3640' },
  { id: 'institutional', accent: '#7f8f68', accent2: '#c2bf9a', wood: '#7d6447', tile: '#d4d6c4', dark: '#3e4436' },
  { id: 'clinic', accent: '#88a2b4', accent2: '#cfd8dc', wood: '#9a8466', tile: '#e2e6e4', dark: '#344250' },
  { id: 'earth70s', accent: '#a5683a', accent2: '#6f6230', wood: '#6e4a2c', tile: '#d8c9a4', dark: '#3b2c20' },
  { id: 'roseBeige', accent: '#b48b84', accent2: '#e0cdbd', wood: '#8f6748', tile: '#e4dccf', dark: '#4a3434' },
  { id: 'corporate', accent: '#6c7f98', accent2: '#9a9ea4', wood: '#7a6a58', tile: '#d6d8da', dark: '#2e3440' },
  { id: 'mint50s', accent: '#8fb5a0', accent2: '#e6c9c1', wood: '#a07a52', tile: '#ecebe2', dark: '#2f403a' },
])

// ---------------------------------------------------------------------------
// Recipe makers. Each returns the palette-spec shape textures.js /
// textureStyles.js paint from: `style` picks the painter, the rest are its
// colours and pattern parameters. `p` is the family palette, `t` the theme.

const wallLight = (base) => ({
  topLight: rgba(shadeHex(base, 1.12), 0.12),
  floorShade: rgba(shadeHex(base, 0.45), 0.22),
})

const FLOOR = {
  carpetPattern: (r, p, t) => {
    const base = pick(r, [shadeHex(t.dark, 1.25), mixHex(t.accent, t.dark, 0.55), mixHex(p.floor.base, t.accent, 0.5)])
    return {
      style: 'carpetPattern',
      base,
      motif: mixHex(base, pick(r, [t.accent2, t.accent, p.floor.base]), 0.45),
      accent: mixHex(base, pick(r, [t.accent2, shadeHex(t.accent, 1.35), mixHex(t.accent, t.wood, 0.5)]), 0.6),
      flecks: flecksOf(base, 0.08),
      pattern: pick(r, ['diamond', 'dots', 'grid', 'confetti', 'squares']),
      scale: pick(r, [4, 6, 8]),
    }
  },
  carpetTile: (r, p, t) => {
    const base = pick(r, [mixHex(t.accent, '#6c6c70', 0.5), '#6f7178', mixHex(t.dark, '#8a8a8a', 0.4), mixHex(p.floor.base, '#77746c', 0.6)])
    return { style: 'carpetTile', base, flecks: flecksOf(base, 0.07), tiles: pick(r, [5, 6]) }
  },
  vct: (r, p, t) => {
    const a = pick(r, [t.tile, '#cfc8b4', '#bdb8aa'])
    return {
      style: 'vct',
      colors: [a, shadeHex(a, 0.93), mixHex(a, t.accent2, 0.35)],
      speckle: [shadeHex(a, 0.7), shadeHex(a, 1.1), mixHex(a, t.dark, 0.5)],
      seam: shadeHex(a, 0.72),
      // No 'border' layout: it paints a border per 3 m cell, a grid across the room.
      layout: pick(r, ['random', 'random', 'checker']),
      tiles: 10,
    }
  },
  checker: (r, p, t) => {
    const light = pick(r, ['#e2ddd0', t.tile])
    const dark = pick(r, [t.dark, mixHex(t.accent, t.dark, 0.4), shadeHex(t.accent, 0.7)])
    return { style: 'checker', a: light, b: dark, seam: shadeHex(dark, 0.7), tiles: pick(r, [8, 10]) }
  },
  parquet: (r, p, t) => {
    const w = jitter(r, t.wood, 0.08)
    return {
      style: 'parquet',
      woods: [w, shadeHex(w, 0.86), shadeHex(w, 1.1), mixHex(w, '#a0784e', 0.3)],
      seam: shadeHex(w, 0.55),
      layout: pick(r, ['herringbone', 'basket']),
    }
  },
  planks: (r, p, t) => {
    const w = jitter(r, mixHex(t.wood, pick(r, ['#9a7650', '#5e4430', '#b08a5e']), 0.5), 0.06)
    return { style: 'planks', woods: [w, shadeHex(w, 0.88), shadeHex(w, 1.08), shadeHex(w, 0.94)], seam: shadeHex(w, 0.5), boards: pick(r, [12, 14, 16]) }
  },
  terrazzo: (r, p, t) => {
    const base = pick(r, [mixHex(t.tile, '#c8c2b4', 0.5), '#d0cbc0', mixHex(t.accent2, '#d6d2c8', 0.6)])
    return {
      style: 'terrazzo',
      base,
      chips: [shadeHex(base, 0.6), mixHex(base, t.accent, 0.5), shadeHex(base, 1.12), mixHex(base, t.dark, 0.6)],
      seam: mixHex(base, '#8a7a5a', 0.4),
      bays: pick(r, [1, 2]),
    }
  },
  mosaic: (r, p, t) => {
    const a = pick(r, ['#e6e4dc', t.tile])
    return {
      style: 'mosaic',
      colors: [a, shadeHex(a, 0.95), shadeHex(a, 0.9), mixHex(a, pick(r, [t.accent, t.accent2, '#3a3a3a']), 0.55)],
      grout: shadeHex(a, 0.66),
      shape: pick(r, ['hex', 'square']),
      accentRate: 0.03 + r() * 0.12,
    }
  },
  polished: (r) => {
    const base = pick(r, ['#8e8b84', '#a19c92', '#7c7a76'])
    return { style: 'polished', base, flecks: flecksOf(base, 0.08), stains: [shadeHex(base, 0.82), shadeHex(base, 0.88)], joint: shadeHex(base, 0.6) }
  },
  tile: (r, p, t) => {
    const base = pick(r, [t.tile, '#b9bcc4', '#cfcac0'])
    return { style: 'tile', base, grout: shadeHex(base, 0.68), flecks: flecksOf(base, 0.04), tiles: pick(r, [2, 4]) }
  },
  concreteWet: (r, p) => ({
    style: 'concrete',
    base: shadeHex(p.floor.base, 0.82 + r() * 0.08),
    flecks: (p.floor.flecks ?? flecksOf(p.floor.base)).map((c) => shadeHex(c, 0.85)),
    stains: (p.floor.stains ?? flecksOf(p.floor.base, 0.15)).map((c) => shadeHex(c, 0.75)),
  }),
  grate: (r) => {
    const base = pick(r, ['#4a4c50', '#53504a', '#3e4246'])
    return { style: 'grate', base, hole: '#141518', seam: shadeHex(base, 0.6), bars: pick(r, [12, 16]) }
  },
  diamond: (r) => {
    const base = pick(r, ['#5a5e64', '#666a70', '#4c5056'])
    return { style: 'diamond', base, seam: shadeHex(base, 0.6), flecks: flecksOf(base, 0.08), rust: '#6a4a30' }
  },
}

const WALL = {
  stripe: (r, p, t) => {
    const base = pick(r, [p.wall.base, mixHex(p.wall.base, t.accent2, 0.3)])
    return {
      style: 'stripe',
      base,
      stripe: mixHex(base, pick(r, [t.accent, p.wall.seam ?? t.dark, t.accent2]), 0.2 + r() * 0.15),
      stripe2: mixHex(base, '#ffffff', 0.25),
      period: pick(r, [16, 32, 64]),
      duty: 0.2 + r() * 0.3,
      flecks: flecksOf(base),
      ...wallLight(base),
    }
  },
  damask: (r, p, t) => {
    const base = pick(r, [p.wall.base, mixHex(p.wall.base, t.accent, 0.25), mixHex(t.accent2, p.wall.base, 0.5)])
    return {
      style: 'damask',
      base,
      motif: mixHex(base, pick(r, [t.accent, t.dark, '#ffffff']), 0.14 + r() * 0.08),
      flecks: flecksOf(base),
      repeat: pick(r, [4, 5]),
      ...wallLight(base),
    }
  },
  wainscot: (r, p, t) => {
    const upper = pick(r, [p.wall.base, mixHex(p.wall.base, t.accent2, 0.35)])
    const lower = pick(r, [t.wood, mixHex(t.accent, t.dark, 0.3), mixHex(upper, t.accent, 0.45), '#e6e2d6'])
    return {
      style: 'wainscot',
      base: upper,
      lower,
      rail: shadeHex(lower, 0.8),
      seam: shadeHex(lower, 0.62),
      lowerStyle: pick(r, ['panel', 'beadboard']),
      railH: 0.9 + r() * 0.15,
      flecks: flecksOf(upper),
      ...wallLight(upper),
    }
  },
  tileWainscot: (r, p, t) => {
    const upper = pick(r, [mixHex(p.wall.base, '#f0eee6', 0.5), t.accent2, '#e6e4dc'])
    const tile = pick(r, ['#ecebe4', t.tile, mixHex(t.accent, '#e6e6e0', 0.55)])
    return {
      style: 'tileWainscot',
      base: upper,
      tile,
      grout: shadeHex(tile, 0.7),
      cap: mixHex(tile, t.dark, 0.5),
      height: 1.25 + r() * 0.35,
      flecks: flecksOf(upper),
      ...wallLight(upper),
    }
  },
  subway: (r, p, t) => {
    const tile = pick(r, ['#e8e6dc', t.tile, mixHex(t.accent, '#dcdcd4', 0.6)])
    return { style: 'subway', base: tile, tile, grout: shadeHex(tile, 0.62), band: mixHex(tile, t.dark, 0.6), flecks: flecksOf(tile, 0.04), ...wallLight(tile) }
  },
  plaster: (r, p, t) => {
    const base = pick(r, ['#dedbd0', mixHex(p.wall.base, '#e6e2d6', 0.6), mixHex(t.accent2, '#e0ddd2', 0.5)])
    return { style: 'plaster', base, mottle: [shadeHex(base, 0.94), shadeHex(base, 1.04)], crack: shadeHex(base, 0.7), flecks: flecksOf(base, 0.04), ...wallLight(base) }
  },
  cmu: (r, p, t) => {
    const base = pick(r, ['#cfcabd', mixHex(t.accent2, '#c8c4b8', 0.5), '#b9bab4', mixHex(t.accent, '#c6c4bc', 0.65)])
    return { style: 'cmu', base, mortar: shadeHex(base, 0.8), flecks: flecksOf(base, 0.1), ...wallLight(base) }
  },
  woodPanel: (r, p, t) => {
    const w = jitter(r, mixHex(t.wood, '#7a5a3c', 0.3), 0.08)
    return { style: 'woodPanel', base: w, woods: [w, shadeHex(w, 0.9), shadeHex(w, 1.07)], seam: shadeHex(w, 0.55), boards: pick(r, [8, 10, 12]), ...wallLight(w) }
  },
  brickRed: (r, p) => {
    const base = mixHex(p.wall.base, '#7a4a3a', 0.35 + r() * 0.2)
    return {
      style: 'brick',
      base,
      mortar: shadeHex(p.wall.mortar ?? base, 0.95),
      variants: [base, shadeHex(base, 0.92), shadeHex(base, 1.06), mixHex(base, '#5a3a30', 0.3)],
      tide: p.wall.tide ?? 'rgba(30,40,30,0.3)',
      ...wallLight(base),
    }
  },
  formwork: (r) => {
    const base = pick(r, ['#9a978e', '#8c8a84', '#a4a096'])
    return { style: 'formwork', base, seam: shadeHex(base, 0.72), tie: shadeHex(base, 0.5), flecks: flecksOf(base, 0.07), stains: [shadeHex(base, 0.85), shadeHex(base, 0.9)], ...wallLight(base) }
  },
  corrugated: (r) => {
    const base = pick(r, ['#6a6e72', '#5f6a6a', '#76705e', '#5a6270'])
    return { style: 'corrugated', base, dark: shadeHex(base, 0.62), rust: ['#6a4a30', '#7a5a3a'], pitch: pick(r, [10, 12]), ...wallLight(base) }
  },
  panelTint: (r, p, t) => {
    const base = mixHex(p.wall.base, pick(r, [t.accent, t.accent2, t.wood]), 0.25 + r() * 0.15)
    return { style: 'panel', base, seam: shadeHex(base, 0.72), flecks: flecksOf(base, 0.04), ...wallLight(base) }
  },
}

const CEIL = {
  acoustic: (r, p) => {
    const base = jitter(r, mixHex(p.ceiling.base, '#e4e0d4', 0.4), 0.03)
    // 2 or 4 tiles per 3 m cell: the grid must land on the cell lines.
    return { style: 'acoustic', base, line: shadeHex(base, 0.66), flecks: flecksOf(base, 0.05), tiles: pick(r, [2, 4]) }
  },
  plasterCeil: (r, p) => {
    const base = jitter(r, mixHex(p.ceiling.base, '#e8e6de', 0.5), 0.03)
    return { style: 'plaster', base, mottle: [shadeHex(base, 0.95), shadeHex(base, 1.03)], crack: shadeHex(base, 0.76), flecks: flecksOf(base, 0.03) }
  },
  slats: (r, p, t) => {
    const w = jitter(r, mixHex(t.wood, '#a07a52', 0.4), 0.06)
    return { style: 'slats', base: shadeHex(w, 0.4), wood: w, woods: [w, shadeHex(w, 0.92), shadeHex(w, 1.06)], slats: pick(r, [12, 16]) }
  },
  exposed: (r) => {
    const base = pick(r, ['#8e8c86', '#7e7c78', '#9a968c'])
    return { style: 'exposed', base, seam: shadeHex(base, 0.65), flecks: flecksOf(base, 0.08) }
  },
  vaultDark: (r, p) => ({
    style: 'vault',
    base: shadeHex(p.ceiling.base, 0.82 + r() * 0.1),
    line: p.ceiling.line ?? shadeHex(p.ceiling.base, 0.7),
    flecks: (p.ceiling.flecks ?? flecksOf(p.ceiling.base)).map((c) => shadeHex(c, 0.85)),
  }),
  corrugatedCeil: (r, p) => {
    const base = shadeHex(p.ceiling.base, 1.1)
    return { style: 'corrugated', base, dark: shadeHex(base, 0.6), rust: ['#5a4030', '#6a4a30'], pitch: 12 }
  },
}

// ---------------------------------------------------------------------------
// Material registers: the "language" a finish belongs to. A package's floor,
// wall and ceiling must share at least one register, so a room never mixes
// a hotel's damask with a car park's formwork. Keyed per slot (a floor
// 'tile' and a ceiling 'tile' are different things).
const SOFT = 'soft' // hospitality / residential
const OFFICE = 'office' // commercial fit-out
const FORMAL = 'formal' // lobbies, halls, executive rooms
const WET = 'wet' // washable tile and render
const RAW = 'raw' // structure left bare: concrete, block, steel

const REGISTERS = {
  floor: {
    carpet: [OFFICE, SOFT], carpetPattern: [SOFT, FORMAL], carpetTile: [OFFICE], vct: [OFFICE, WET, RAW],
    checker: [WET, FORMAL], parquet: [SOFT, FORMAL], planks: [SOFT], terrazzo: [FORMAL, WET, OFFICE],
    mosaic: [WET, FORMAL], polished: [RAW, OFFICE], tile: [WET, OFFICE, FORMAL], concrete: [RAW, WET],
    grate: [RAW], diamond: [RAW], deck: [RAW],
  },
  wall: {
    wallpaper: [OFFICE, SOFT], stripe: [OFFICE, SOFT], damask: [SOFT, FORMAL], wainscot: [SOFT, FORMAL, OFFICE],
    tileWainscot: [WET], subway: [WET, RAW, FORMAL], plaster: [OFFICE, SOFT, FORMAL, WET, RAW], cmu: [RAW, WET],
    woodPanel: [SOFT, FORMAL], brick: [RAW, WET], formwork: [RAW], corrugated: [RAW], steel: [RAW], panel: [OFFICE, FORMAL],
  },
  ceiling: {
    acoustic: [OFFICE, RAW], tile: [OFFICE, WET, RAW], plaster: [SOFT, FORMAL, WET, OFFICE], slats: [SOFT, FORMAL],
    exposed: [RAW, OFFICE], vault: [RAW, WET], deck: [RAW], corrugated: [RAW],
  },
}

// Hard rules by room category (architectural practice, not taste): wet
// rooms are washable top to bottom, plant and storage rooms are hard-wearing,
// and corridor floors stay calm (no checker or mosaic underfoot for 100 m).
// A style outside the list can never serve the category, base layer included.
const ALLOWED = {
  [ZONE_WET]: {
    floor: ['tile', 'mosaic', 'checker', 'vct', 'terrazzo', 'concrete', 'polished'],
    wall: ['tileWainscot', 'subway', 'plaster', 'brick', 'cmu'],
    ceiling: ['plaster', 'tile', 'vault', 'exposed', 'deck', 'corrugated'],
  },
  [ZONE_SERVICE]: {
    floor: ['vct', 'polished', 'concrete', 'grate', 'diamond', 'deck', 'carpetTile', 'tile'],
    wall: ['cmu', 'plaster', 'panel', 'formwork', 'corrugated', 'steel', 'brick', 'subway'],
    ceiling: ['acoustic', 'exposed', 'tile', 'deck', 'vault', 'corrugated'],
  },
  [ZONE_CIRC]: {
    floor: ['carpet', 'carpetPattern', 'carpetTile', 'vct', 'terrazzo', 'polished', 'tile', 'concrete', 'grate', 'diamond', 'deck', 'planks'],
    wall: null,
    ceiling: null,
  },
}

// Within what is allowed, what a category usually gets: bathrooms are
// tiled more often than merely painted.
const PREFER = {
  [ZONE_WET]: { tileWainscot: 2.2, subway: 2, mosaic: 1.5, checker: 1.2, tile: 1.3 },
  [ZONE_SERVICE]: { vct: 1.4, polished: 1.3, cmu: 1.4, exposed: 1.3 },
}

const allowed = (category, slot, style) => {
  const list = ALLOWED[category]?.[slot]
  return !list || list.includes(style)
}

// How strongly a category prefers the family's canonical surface (layer 0)
// when it is allowed at all. Corridors are the family's identity — the
// endless yellow hallway — so they keep it most often.
const BASE_PREF = Object.freeze({
  [ZONE_CIRC]: 3,
  [ZONE_WORK]: 1.4,
  [ZONE_HALL]: 0.6,
  [ZONE_SOFT]: 0.8,
  [ZONE_SERVICE]: 0.5,
  [ZONE_WET]: 0.5,
})

// Catalogue entry: a recipe maker, the categories it may serve and its draw
// weight. Near-duplicates of a family's canonical surface are deliberately
// absent: a slightly different carpet next to the canonical one reads as a
// texture bug, not a design decision (wear already comes from the shader).
const e = (make, tags, weight = 1) => ({ make, tags: Object.freeze(tags), weight })
const W = ZONE_WORK, WT = ZONE_WET, S = ZONE_SOFT, SV = ZONE_SERVICE, C = ZONE_CIRC, H = ZONE_HALL

const CATALOGUE = {
  [MAP_FAMILY_OFFICE]: {
    floor: [
      e(FLOOR.carpetTile, [W, SV, C], 1.3), e(FLOOR.carpetPattern, [S, H, C], 0.9), e(FLOOR.vct, [SV, WT, C]),
      e(FLOOR.checker, [WT], 0.8), e(FLOOR.parquet, [S, H], 0.8), e(FLOOR.terrazzo, [H, C, WT], 0.8),
      e(FLOOR.mosaic, [WT], 0.9), e(FLOOR.polished, [SV], 0.6), e(FLOOR.planks, [S], 0.6),
    ],
    wall: [
      e(WALL.stripe, [W, S, C], 1.1), e(WALL.damask, [S, H], 0.8), e(WALL.wainscot, [S, H, W]),
      e(WALL.tileWainscot, [WT], 1.3), e(WALL.plaster, [SV, W, WT, C]), e(WALL.cmu, [SV], 0.7),
      e(WALL.woodPanel, [S, H], 0.6), e(WALL.panelTint, [W, C], 0.8),
    ],
    ceiling: [
      e(CEIL.acoustic, [W, C, SV], 1.2), e(CEIL.plasterCeil, [S, H, WT]), e(CEIL.slats, [H, S], 0.6),
      e(CEIL.exposed, [SV], 0.5),
    ],
  },
  [MAP_FAMILY_HOTEL]: {
    floor: [
      e(FLOOR.carpetPattern, [S, C, H], 1.6), e(FLOOR.planks, [S, H], 0.8), e(FLOOR.mosaic, [WT], 1.2),
      e(FLOOR.checker, [WT], 0.8), e(FLOOR.vct, [SV, WT], 0.8), e(FLOOR.terrazzo, [H, C], 0.9),
      e(FLOOR.parquet, [S, H], 0.8), e(FLOOR.polished, [SV], 0.4),
    ],
    wall: [
      e(WALL.damask, [S, H, C], 1.4), e(WALL.stripe, [S, C], 1.1), e(WALL.wainscot, [S, H, C], 1.1),
      e(WALL.tileWainscot, [WT], 1.2), e(WALL.subway, [WT, SV], 0.8), e(WALL.plaster, [SV, S, WT], 0.8),
      e(WALL.woodPanel, [S, H], 0.6), e(WALL.cmu, [SV], 0.4),
    ],
    ceiling: [
      e(CEIL.plasterCeil, [S, H, WT, C], 1.4), e(CEIL.acoustic, [SV, C, W], 0.9), e(CEIL.slats, [H, S], 0.6),
      e(CEIL.exposed, [SV], 0.3),
    ],
  },
  [MAP_FAMILY_TOWER]: {
    floor: [
      e(FLOOR.terrazzo, [H, C, W], 1.3), e(FLOOR.carpetTile, [W, S, SV], 1.4), e(FLOOR.polished, [SV, C, H]),
      e(FLOOR.vct, [SV, WT], 0.9), e(FLOOR.mosaic, [WT], 0.9), e(FLOOR.planks, [S], 0.6),
      e(FLOOR.carpetPattern, [S], 0.5),
    ],
    wall: [
      e(WALL.plaster, [W, C, S, WT], 1.2), e(WALL.formwork, [H, SV, C]), e(WALL.panelTint, [W, H, S]),
      e(WALL.cmu, [SV], 0.9), e(WALL.tileWainscot, [WT]), e(WALL.subway, [WT], 0.6), e(WALL.woodPanel, [H, S], 0.7),
      e(WALL.stripe, [W], 0.4),
    ],
    ceiling: [
      e(CEIL.acoustic, [W, C, SV], 1.3), e(CEIL.exposed, [H, SV, C], 1.1), e(CEIL.plasterCeil, [S, WT, H]),
      e(CEIL.slats, [H, S], 0.6),
    ],
  },
  [MAP_FAMILY_SEWER]: {
    floor: [
      e(FLOOR.tile, [H, C, W, WT], 0.9), e(FLOOR.mosaic, [H, WT], 0.7), e(FLOOR.grate, [SV, C], 0.8),
      e(FLOOR.polished, [H, W], 0.5), e(FLOOR.diamond, [SV, W], 0.6),
    ],
    wall: [
      e(WALL.brickRed, [W, H, S], 0.9), e(WALL.subway, [H, C, W, WT], 1.2), e(WALL.formwork, [SV, C, W, H]),
      e(WALL.cmu, [SV, W], 0.8), e(WALL.tileWainscot, [H, W, WT], 0.7),
    ],
    ceiling: [e(CEIL.exposed, [H, SV, C, W]), e(CEIL.plasterCeil, [H, W], 0.5)],
  },
  [MAP_FAMILY_LATTICE]: {
    floor: [
      e(FLOOR.diamond, [W, C, SV, H], 1.3), e(FLOOR.grate, [C, SV, H], 1.2), e(FLOOR.polished, [SV, W, S], 0.8),
      e(FLOOR.concreteWet, [SV, WT, W], 0.8), e(FLOOR.vct, [W, S, WT], 0.6),
    ],
    wall: [
      e(WALL.corrugated, [W, C, H, SV], 1.3), e(WALL.cmu, [SV, W, S, WT], 0.9), e(WALL.formwork, [H, C, SV], 0.9),
      e(WALL.subway, [WT], 0.6), e(WALL.plaster, [S, W], 0.5),
    ],
    ceiling: [e(CEIL.exposed, [H, SV, W, C]), e(CEIL.corrugatedCeil, [C, SV, W, H], 0.9)],
  },
}

// Package draw order: the categories most of the building is made of claim
// the layer budget first; siblings come after every primary.
const PACKAGE_ORDER = Object.freeze([ZONE_CIRC, ZONE_WORK, ZONE_WET, ZONE_SERVICE, ZONE_SOFT, ZONE_HALL])
// How often a world simply keeps the family's canonical corridor.
const CANONICAL_CORRIDOR = 0.6

// Rough base luminance of a recipe (its dominant colour), for the
// reflectance order real interiors follow: ceiling > wall > floor.
export function recipeLuma(spec) {
  const c = spec.base ?? spec.colors?.[0] ?? spec.woods?.[0] ?? spec.tile
  if (c) return hexLuma(c)
  if (spec.a && spec.b) return (hexLuma(spec.a) + hexLuma(spec.b)) / 2
  return 0.5
}

function lrvPenalty(f, w, c, base) {
  const lf = recipeLuma(f)
  const lw = recipeLuma(w)
  const lc = recipeLuma(c)
  // Dark families (sewer, lattice) start out of order; only ask a package to
  // be no worse than the family's own surfaces.
  const slackWall = Math.max(0, recipeLuma(base.floor) - recipeLuma(base.wall) + 0.06)
  const slackCeil = Math.max(0, recipeLuma(base.wall) - recipeLuma(base.ceiling) + 0.02)
  return Math.max(0, lf - lw + 0.06 - slackWall) * 1.5 + Math.max(0, lw - lc + 0.02 - slackCeil)
}

const sharesRegister = (a, b) => a.some((r) => b.includes(r))
const intersect = (a, b) => a.filter((r) => b.includes(r))

const surfaceSetCache = new Map()

// Liminal families paint one mono catalogue: every layer is layer 0, the
// family palette's own surface (spec §5.1). Frozen; CATALOGUE is not touched.
const MONO = Object.freeze({ floor: Object.freeze([]), wall: Object.freeze([]), ceiling: Object.freeze([]) })

// The world's finish schedule. Pure in (family, worldSeed) and memoised:
// chunks, dressing and the renderer may all ask, any number of times.
//
// Returns { family, seed, theme, floor[], wall[], ceiling[], packages } where
// the slot arrays are the painted LAYERS (layer 0 = the family's canonical
// surface) and `packages[category]` is [primary, sibling]: coordinated
// { floor, wall, ceiling } layer triples. Rooms never pick slots on their
// own; they pick a package.
export function worldSurfaceSet(family, worldSeed = 0) {
  const catalogue = CATALOGUE[family] ?? (isLiminal(family) ? MONO : null)
  const fam = catalogue ? family : MAP_FAMILY_OFFICE
  const famCatalogue = catalogue ?? CATALOGUE[fam]
  const key = `${fam}|${worldSeed >>> 0}`
  const cached = surfaceSetCache.get(key)
  if (cached) return cached
  const pal = familyPalette(fam)
  const seed = (worldSeed >>> 0) ^ fmix32(SALT_THEME)
  const theme = SURFACE_THEMES[hash2i(seed, 1, 7) % SURFACE_THEMES.length]
  const r = rngOf(hash3i(seed, 0x9ac4, 0x51, 0x77))

  const layers = {}
  const made = {} // slot -> Map(entry -> layer index)
  const baseEntry = {}
  for (const slot of SURFACE_SLOTS) {
    layers[slot] = [baseRecipe(pal, slot)]
    made[slot] = new Map()
    baseEntry[slot] = { base: true, style: pal[slot].style, weight: 1 }
  }
  // Each catalogue entry paints at most one layer per world (identical entry
  // = identical finish). Its style is known only once made, so make lazily.
  const specOf = new Map()
  const spec = (slot, entry) => {
    if (entry.base) return layers[slot][0]
    let s = specOf.get(entry)
    if (!s) {
      s = entry.make(rngOf(hash3i(seed, SURFACE_SLOTS.indexOf(slot), famCatalogue[slot].indexOf(entry), 0x3d)), pal, theme)
      specOf.set(entry, s)
    }
    return s
  }
  const style = (slot, entry) => (entry.base ? pal[slot].style : spec(slot, entry).style)
  const registersOf = (slot, entry) => REGISTERS[slot][style(slot, entry)] ?? [RAW]

  const candidates = (slot, category) => {
    const out = []
    if (allowed(category, slot, pal[slot].style)) out.push({ entry: baseEntry[slot], weight: BASE_PREF[category] ?? 1 })
    for (const entry of famCatalogue[slot]) {
      if (!entry.tags.includes(category)) continue
      if (!allowed(category, slot, style(slot, entry))) continue
      out.push({ entry, weight: entry.weight * (PREFER[category]?.[style(slot, entry)] ?? 1) })
    }
    return out
  }
  const weighted = (list) => {
    let total = 0
    for (const it of list) total += it.weight
    let roll = r() * total
    for (const it of list) {
      roll -= it.weight
      if (roll < 0) return it.entry
    }
    return list[list.length - 1]?.entry ?? null
  }
  // Layer index of an entry, painting it if the slot still has room; a full
  // slot reuses the closest existing layer that may serve the category.
  const layerFor = (slot, entry, category, registers) => {
    if (entry.base) return 0
    const known = made[slot].get(entry)
    if (known !== undefined) return known
    if (layers[slot].length < SURFACE_LAYER_COUNT[slot]) {
      const index = layers[slot].length
      layers[slot].push(Object.freeze({ ...spec(slot, entry), tags: entry.tags, layer: index }))
      made[slot].set(entry, index)
      return index
    }
    let best = 0
    for (let i = 1; i < layers[slot].length; i++) {
      const l = layers[slot][i]
      if (!l.tags.includes(category) || !allowed(category, slot, l.style)) continue
      if (!sharesRegister(REGISTERS[slot][l.style] ?? [RAW], registers)) continue
      best = i
      break
    }
    return best
  }

  // One coordinated package for a category: floor first, then a wall that
  // shares its material language, then a ceiling that shares both, keeping
  // the most reflectance-plausible of a few draws. `keep` pins slots of a
  // primary when drawing its sibling.
  const drawPackage = (category, keep = null) => {
    let best = null
    for (let attempt = 0; attempt < 10; attempt++) {
      const pick = {}
      let regs = null
      let ok = true
      for (const slot of SURFACE_SLOTS) {
        if (keep?.[slot]) {
          pick[slot] = keep[slot]
        } else {
          const list = candidates(slot, category).filter((it) => !regs || sharesRegister(registersOf(slot, it.entry), regs))
          pick[slot] = weighted(list)
        }
        if (!pick[slot]) {
          ok = false
          break
        }
        const rs = registersOf(slot, pick[slot])
        regs = regs ? intersect(regs, rs) : rs
        if (!regs.length) {
          ok = false
          break
        }
      }
      if (!ok) continue
      const penalty = lrvPenalty(spec('floor', pick.floor), spec('wall', pick.wall), spec('ceiling', pick.ceiling), pal)
      if (!best || penalty < best.penalty - 1e-9) best = { pick, regs, penalty }
      if (penalty === 0) break
    }
    if (!best) return null
    const out = {}
    for (const slot of SURFACE_SLOTS) out[slot] = { entry: best.pick[slot], regs: best.regs }
    return out
  }
  const realise = (category, drawn) => {
    const pkg = {}
    for (const slot of SURFACE_SLOTS) pkg[slot] = layerFor(slot, drawn[slot].entry, category, drawn[slot].regs)
    return Object.freeze(pkg)
  }

  const primaries = {}
  const packages = {}
  for (const category of PACKAGE_ORDER) {
    let drawn = null
    if (category === ZONE_CIRC && r() < CANONICAL_CORRIDOR) {
      drawn = { floor: { entry: baseEntry.floor }, wall: { entry: baseEntry.wall }, ceiling: { entry: baseEntry.ceiling } }
    }
    drawn ??= drawPackage(category)
    primaries[category] = drawn
    packages[category] = [drawn ? realise(category, drawn) : Object.freeze({ floor: 0, wall: 0, ceiling: 0 })]
  }
  // Siblings: the same scheme with ONE element changed (a different wall on
  // the same floor, or a different floor under the same walls), so a second
  // department reads as a variation, not another building. Ceilings stay.
  for (const category of PACKAGE_ORDER) {
    const primary = primaries[category]
    let sibling = null
    if (primary) {
      const changeWall = r() < 0.5
      const keep = { ceiling: primary.ceiling.entry, [changeWall ? 'floor' : 'wall']: primary[changeWall ? 'floor' : 'wall'].entry }
      for (let tries = 0; tries < 2 && !sibling; tries++) {
        const drawn = drawPackage(category, tries ? { ceiling: primary.ceiling.entry } : keep)
        if (drawn && (drawn.floor.entry !== primary.floor.entry || drawn.wall.entry !== primary.wall.entry)) sibling = realise(category, drawn)
      }
    }
    packages[category].push(sibling ?? packages[category][0])
    Object.freeze(packages[category])
  }

  const set = Object.freeze({
    family: fam,
    seed: worldSeed >>> 0,
    theme: theme.id,
    floor: Object.freeze(layers.floor),
    wall: Object.freeze(layers.wall),
    ceiling: Object.freeze(layers.ceiling),
    packages: Object.freeze(packages),
  })
  surfaceSetCache.set(key, set)
  if (surfaceSetCache.size > 16) surfaceSetCache.delete(surfaceSetCache.keys().next().value)
  return set
}

function baseRecipe(pal, slot) {
  return Object.freeze({ ...pal[slot], tags: ALL, base: pal[slot].base, layer: 0 })
}

// ---------------------------------------------------------------------------
// Room context: who a cell belongs to, top down.
//
//   world     theme + package list (worldSurfaceSet)
//   storey    corridors and open halls: ONE circulation finish per storey,
//             with an occasional refitted storey (stairs are the threshold)
//   district  the planner district is the department: every room of a
//             category in it shares one package — typical floors repeat it
//             storey after storey, with an occasional refitted floor
//   room      a rare odd room takes the category's other package
//
// Wet and service rooms are world-wide standards (one bathroom tile per
// building). Structures (atria, tower decks, lattice frames, catalogue
// volumes) are landmarks with one finish top to bottom.

export const SPACE_CIRC = 'circ'
export const SPACE_ROOM = 'room'
export const SPACE_HALL = 'hall'

const REFIT_STOREY = 0.15 // corridors / open halls of a storey refitted
const REFIT_DISTRICT = 0.1 // one department floor refitted
const DISTRICT_SIBLING = 0.35 // departments on the sibling package
const ODD_ROOM = 0.05 // single rooms that break their department's scheme
const STRUCTURE_SIBLING = 0.3

const SALT_REFIT = 0x7ef1
const SALT_DEPT = 0xde97
const SALT_ODD = 0x0dd5
const SALT_FIELD = 0xf1e1d

const unit = (h) => h / 4294967296

// Category of a ROOM from its role; a role-less room takes the family's
// ordinary room (a hotel's unnamed rooms are guest rooms, not offices).
export function roomCategory(family, role) {
  switch (role) {
    case SPACE_ROLE_BATHROOM:
    case SPACE_ROLE_KITCHEN:
    case SPACE_ROLE_LAUNDRY:
    case SPACE_ROLE_BREAK:
      return ZONE_WET
    case SPACE_ROLE_BEDROOM:
    case SPACE_ROLE_LIVING:
    case SPACE_ROLE_LOUNGE:
    case SPACE_ROLE_LIBRARY:
    case SPACE_ROLE_DINING:
    case SPACE_ROLE_MEETING:
      return ZONE_SOFT
    case SPACE_ROLE_SERVER:
    case SPACE_ROLE_STORAGE:
    case SPACE_ROLE_COPY:
    case SPACE_ROLE_ARCHIVE:
      return ZONE_SERVICE
    default:
      return baseFamilyOf(family) === MAP_FAMILY_HOTEL ? ZONE_SOFT : ZONE_WORK
  }
}

// Legacy per-cell category (kind + role), kept for callers that only have a
// cell: circulation kinds are corridors, halls are halls, rooms by role.
export function zoneCategory(kind, role, family = MAP_FAMILY_OFFICE) {
  if (kind === CELL_CORRIDOR || kind === CELL_LOBBY || kind === CELL_STAIR) return ZONE_CIRC
  if (kind === CELL_ATRIUM || kind === CELL_VOID || kind === CELL_BRIDGE) return ZONE_HALL
  return roomCategory(family, role)
}

// Is this cell's space circulation? The planner's own class wins (it stays
// right when a later stamp relabels a room cell as lobby); without a planner,
// the cell kind decides.
function isCirculation(cls, kind, role) {
  if (cls === SPACE_CLASS_CIRCULATION) return true
  if (cls === SPACE_CLASS_ROOM) return false
  return (kind === CELL_CORRIDOR || kind === CELL_LOBBY || kind === CELL_STAIR) && !role
}

// Department key of a chunk: the planner district when there is one, else
// a fixed 3x3-chunk block (sewer chambers, editor maps).
export function districtKeyOf(data) {
  const d = data.district
  if (d) return hash2i(SALT_DEPT, d.dx, d.dz)
  return hash3i(SALT_DEPT, Math.floor(data.cx / 3), Math.floor(data.cz / 3), 0x5e)
}
const plannedDistrictKey = (d) => hash2i(SALT_DEPT, d.dx, d.dz)

// Does this planned cell belong to a landmark (a structure, or a tall volume
// resolved as one)? Mirrors the hall test of spaceOf.
const isHallCell = (data, id, kind) =>
  !!id && (data.structure?.id === id || kind === CELL_ATRIUM || kind === CELL_VOID || kind === CELL_BRIDGE)

// The role cell (lx, lz) speaks for. A structure halo, a catalogue ring or
// approach and a stair halo clear the role byte of the room strip they
// relabel as lobby / corridor, yet the planner's id and class still give that
// strip to the same ROOM — and a room a later stamp relabelled stays a room:
// one finish, one sign, one privacy rule. So a role-less ROOM-class cell
// takes its room's role: the district plan's (data.seam), while the plan
// still gives the cell to that space; without a plan (editor documents), the
// role most of the room's own cells in this chunk carry. Every other cell
// keeps its own byte.
export function cellRole(data, lx, lz) {
  const i = cIdx(lx, lz)
  const role = data.spaceRole[i]
  if (role !== SPACE_ROLE_NONE) return role
  const id = data.spaceId[i]
  if (!id || data.spaceClass?.[i] !== SPACE_CLASS_ROOM || isHallCell(data, id, data.cellKind[i])) return role
  const seam = data.seam
  if (typeof seam?.plannedRole === 'function') {
    const gx = data.cx * CHUNK + lx
    const gz = data.cz * CHUNK + lz
    return seam.plannedId(gx, gz) === id ? seam.plannedRole(gx, gz) : role
  }
  return chunkRoleOf(data, id)
}

// Most common role among the chunk's cells of space `id` (NONE when none has
// one; ties go to the lower role byte, so the answer is scan-order free).
// Recomputed per call, never memoised on the data: editor documents edit
// ChunkData in place, and one chunk's scan is cheap next to the resolve
// (only role-less room cells of a chunk without its plan get here).
function chunkRoleOf(data, id) {
  const counts = new Map()
  for (let i = 0; i < CHUNK * CHUNK; i++) {
    const r = data.spaceRole[i]
    if (r !== SPACE_ROLE_NONE && data.spaceId[i] === id) counts.set(r, (counts.get(r) ?? 0) + 1)
  }
  let best = SPACE_ROLE_NONE
  let most = 0
  for (const [r, n] of counts) {
    if (n > most || (n === most && r < best)) {
      best = r
      most = n
    }
  }
  return best
}

// Who owns cell (lx, lz): { cls, category, key } — `key` is a stable uint32
// for the space (the same room across a chunk seam keeps it), `cls` one of
// SPACE_CIRC / SPACE_ROOM / SPACE_HALL.
export function spaceAt(data, lx, lz) {
  return cellSpace(data, lx, lz, cellRole(data, lx, lz))
}

function cellSpace(data, lx, lz, role) {
  const i = cIdx(lx, lz)
  const id = data.spaceId[i]
  const landmark = !!id && data.structure?.id === id
  return spaceOf(data, id, data.cellKind[i], data.spaceClass?.[i] ?? SPACE_CLASS_UNKNOWN, role, data.cx, data.cz, landmark)
}

// The owner of one cell from its raw planner fields: an in-chunk cell, or a
// seam-ring cell of the chunk at (cx, cz) next door. `landmark`: the cell
// belongs to a structure.
function spaceOf(data, id, kind, cls, role, cx, cz, landmark) {
  const cy = data.cy | 0
  if (id && (landmark || kind === CELL_ATRIUM || kind === CELL_VOID || kind === CELL_BRIDGE)) {
    // A tall volume is one landmark top to bottom: no storey in its key.
    return { cls: SPACE_HALL, category: ZONE_HALL, key: hash2i(SALT_ZONE, id, 0x7a11) }
  }
  if (!id) {
    // Unplanned fabric: sewer galleries, pillar and warehouse halls. They are
    // open to everything around them, so one finish per storey and family —
    // never a patchwork of blocks.
    return { cls: SPACE_CIRC, category: ZONE_CIRC, key: hash3i(SALT_ZONE, data.zone | 0, cy, 0x0fab) }
  }
  if (isCirculation(cls, kind, role)) return { cls: SPACE_CIRC, category: ZONE_CIRC, key: hash2i(SALT_ZONE, id, cy) }
  // Sewer chamber ids are per-chunk plan ids without the chunk in them.
  const key = data.mapFamily === MAP_FAMILY_SEWER ? hash3i(SALT_ZONE ^ id, cx, cz, cy) : hash2i(SALT_ZONE, id, cy)
  return { cls: SPACE_ROOM, category: roomCategory(data.mapFamily, role), key }
}

// Package (0 primary, 1 sibling) for a space, following the hierarchy above.
function packageIndex(set, data, space, district) {
  const s = set.seed
  const cy = data.cy | 0
  if (space.cls === SPACE_CIRC) return unit(hash3i(s ^ SALT_REFIT, cy, 0x51, 1)) < REFIT_STOREY ? 1 : 0
  if (space.cls === SPACE_HALL) return unit(hash2i(s ^ SALT_REFIT, space.key, 2)) < STRUCTURE_SIBLING ? 1 : 0
  const category = space.category
  if (category === ZONE_WET || category === ZONE_SERVICE) return 0
  const catSalt = PACKAGE_ORDER.indexOf(category) + 1
  let index = unit(hash3i(s ^ SALT_DEPT, district, catSalt, 3)) < DISTRICT_SIBLING ? 1 : 0
  if (unit(hash3i(s ^ SALT_REFIT, district, cy, 4)) < REFIT_DISTRICT) index ^= 1
  if (unit(hash2i(s ^ SALT_ODD, space.key, catSalt)) < ODD_ROOM) index ^= 1
  return index
}

// Smooth wear field over the world: value noise on a ~150 m lattice with
// storeys correlated in threes, so whole wings and floors age together.
function valueNoise(s, x, z, y) {
  const x0 = Math.floor(x), z0 = Math.floor(z), y0 = Math.floor(y)
  const fx = x - x0, fz = z - z0, fy = y - y0
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz), sy = fy * fy * (3 - 2 * fy)
  let v = 0
  for (let k = 0; k < 2; k++) {
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const w = (i ? sx : 1 - sx) * (j ? sz : 1 - sz) * (k ? sy : 1 - sy)
        v += w * unit(hash3i(s, x0 + i, z0 + j, y0 + k))
      }
    }
  }
  return v
}

const FIELD_CELLS = 50
const DECAY_BIAS = Object.freeze({ [ZONE_WET]: 0.07, [ZONE_SERVICE]: 0.09, [ZONE_HALL]: -0.05 })

// Wear 0..1 at a global cell. Most of a world is lightly lived-in; a few
// wings are derelict. Rooms add a small offset of their own (one neglected
// office); corridors follow the field alone, so they never step.
export function decayAt(set, gx, gz, cy, space = null) {
  const s = (set.seed ^ SALT_FIELD) | 0
  const v = 0.7 * valueNoise(s, gx / FIELD_CELLS, gz / FIELD_CELLS, cy / 3) + 0.3 * valueNoise(s ^ 0x55, gx / 17, gz / 17, cy)
  let d = clamp01((v - 0.32) / 0.5) ** 1.6
  if (space?.cls === SPACE_ROOM) d += (unit(hash2i(SALT_DECAY, space.key, 3)) - 0.5) * 0.24
  d += DECAY_BIAS[space?.category] ?? 0
  return clamp01(d)
}

// Everything the dressing, joinery and glass need to agree with the floor:
// one resolver, used by the zone map too, so geometry never reads the
// streamed halo bytes.
export function roomContext(data, lx, lz, set = worldSurfaceSet(data.mapFamily, data.worldSeed)) {
  const gx = data.cx * CHUNK + lx
  const gz = data.cz * CHUNK + lz
  // The room's role, not the stamp-cleared byte (cellRole): door signs,
  // privacy and notices read `role` and must name the room the floor does.
  const role = cellRole(data, lx, lz)
  return contextOf(set, data, cellSpace(data, lx, lz, role), data.cellKind[cIdx(lx, lz)], role, districtKeyOf(data), gx, gz)
}

function contextOf(set, data, space, kind, role, district, gx, gz) {
  const index = packageIndex(set, data, space, district)
  const pkg = set.packages[space.category][index]
  return {
    ...space,
    kind,
    role,
    district,
    package: index,
    floor: pkg.floor,
    wall: pkg.wall,
    ceiling: pkg.ceiling,
    decay: decayAt(set, gx, gz, data.cy | 0, space),
  }
}

// The context of the cell just across this chunk's own West line (axis 'v',
// row `cell`) or North line (axis 'h', column `cell`), from the planner's
// seam ring (ChunkData.seam) — what the neighbour resolves for that cell
// from its own plan — or null when the neighbour is not planned (other
// zones, sewer fabric, another district — see seamPortal). A doorway or
// window on line 0 then reads both of its sides without loading the
// neighbour.
// Is the side across this chunk's own West ('v') / North ('h') line another
// planned district's edge? Openings there are the district portals: routed
// corridor endpoints on both sides.
export function seamPortal(data, axis) {
  const portal = data.seam?.resolve()?.portal
  return !!portal && (axis === 'v' ? portal.w : portal.n)
}

export function seamContext(data, axis, cell, set = worldSurfaceSet(data.mapFamily, data.worldSeed)) {
  const west = axis === 'v'
  const ring = data.seam?.resolve()
  const district = west ? ring?.west : ring?.north
  if (!district) return null
  const k = (west ? 0 : CHUNK) + cell
  const cx = west ? data.cx - 1 : data.cx
  const cz = west ? data.cz : data.cz - 1
  const space = spaceOf(data, ring.id[k], ring.kind[k], ring.cls[k], ring.role[k], cx, cz, ring.hall[k] === 1)
  const gx = west ? data.cx * CHUNK - 1 : data.cx * CHUNK + cell
  const gz = west ? data.cz * CHUNK + cell : data.cz * CHUNK - 1
  return contextOf(set, data, space, ring.kind[k], ring.role[k], plannedDistrictKey(district), gx, gz)
}

// Kept for callers that already hold a key and category (tests, tools): a
// department-less resolution of one space.
export function zoneSurface(set, zoneKey, category) {
  const index = unit(hash2i(set.seed ^ SALT_ODD, zoneKey, 9)) < DISTRICT_SIBLING ? 1 : 0
  const pkg = set.packages[category]?.[index] ?? set.packages[ZONE_WORK][0]
  return { ...pkg, decay: Math.round(decayAt(set, 0, 0, 0, { cls: SPACE_ROOM, key: zoneKey, category }) * 127) }
}

// Cells holding a ceiling fixture (lit or dead): the shader never drops a
// missing-tile void into one, where the troffer would float over a hole.
const lampMasks = new WeakMap()
function lampMask(data) {
  let mask = lampMasks.get(data)
  if (!mask) {
    mask = new Uint8Array(CHUNK * CHUNK)
    for (const l of data.lamps ?? []) mask[cIdx(l.lx, l.lz)] = 1
    lampMasks.set(data, mask)
  }
  return mask
}

function writeZone(out, set, data, lx, lz, tx, tz, memo, floors) {
  const i = cIdx(lx, lz)
  const space = spaceAt(data, lx, lz)
  // Most cells of a chunk share a handful of spaces: resolve each package once.
  let pkg = memo.get(space.key)
  if (!pkg) {
    pkg = set.packages[space.category][packageIndex(set, data, space, districtKeyOf(data))]
    memo.set(space.key, pkg)
  }
  const o = (tz * ZONE_MAP_SIZE + tx) * 4
  out[o] = pkg.floor
  out[o + 1] = pkg.wall
  out[o + 2] = pkg.ceiling
  const decay = decayAt(set, data.cx * CHUNK + lx, data.cz * CHUNK + lz, data.cy | 0, space)
  // Low 7 bits wear, high bit "fixture in this cell".
  out[o + 3] = Math.round(decay * 127) | (lampMask(data)[i] ? 128 : 0)
  floors[tz * ZONE_MAP_SIZE + tx] = data.cellKind[i] === CELL_VOID ? 255 : pkg.floor
}

// Floor-change edge flags in the floor byte's high bits: where a floor finish
// meets a different one across a cell edge (a door, an open passage), the
// shader lays a metal transition strip on the line — the way real floors
// change, and only there. Bits 3..6: west, east, north, south.
export const ZONE_EDGE_W = 8
export const ZONE_EDGE_E = 16
export const ZONE_EDGE_N = 32
export const ZONE_EDGE_S = 64
export const ZONE_LAYER_MASK = 7

// The chunk's zone map: ZONE_MAP_SIZE^2 RGBA bytes, texel (lx+1, lz+1) =
// (floor layer | edge flags, wall layer, ceiling layer, wear | fixture bit).
// The one-cell halo reads `neighbour(dx, dz)` (the ChunkData of the
// same-floor chunk at that offset, or null when not loaded yet), else
// repeats the nearest own cell so a border wall never samples garbage;
// ChunkManager refreshes the halo when the neighbour streams in.
export function buildSurfaceZoneMap(data, set, neighbour = null, out = new Uint8Array(ZONE_MAP_SIZE * ZONE_MAP_SIZE * 4)) {
  const memo = new Map()
  const floors = new Uint8Array(ZONE_MAP_SIZE * ZONE_MAP_SIZE)
  for (let tz = 0; tz < ZONE_MAP_SIZE; tz++) {
    for (let tx = 0; tx < ZONE_MAP_SIZE; tx++) {
      const lx = tx - 1
      const lz = tz - 1
      const dx = lx < 0 ? -1 : lx >= CHUNK ? 1 : 0
      const dz = lz < 0 ? -1 : lz >= CHUNK ? 1 : 0
      if (!dx && !dz) {
        writeZone(out, set, data, lx, lz, tx, tz, memo, floors)
        continue
      }
      const other = neighbour?.(dx, dz)
      if (other) writeZone(out, set, other, lx - dx * CHUNK, lz - dz * CHUNK, tx, tz, new Map(), floors)
      else writeZone(out, set, data, Math.min(CHUNK - 1, Math.max(0, lx)), Math.min(CHUNK - 1, Math.max(0, lz)), tx, tz, memo, floors)
    }
  }
  for (let tz = 1; tz <= CHUNK; tz++) {
    for (let tx = 1; tx <= CHUNK; tx++) {
      const t = tz * ZONE_MAP_SIZE + tx
      const f = floors[t]
      if (f === 255) continue
      const differs = (n) => floors[n] !== 255 && floors[n] !== f
      let flags = 0
      if (differs(t - 1)) flags |= ZONE_EDGE_W
      if (differs(t + 1)) flags |= ZONE_EDGE_E
      if (differs(t - ZONE_MAP_SIZE)) flags |= ZONE_EDGE_N
      if (differs(t + ZONE_MAP_SIZE)) flags |= ZONE_EDGE_S
      out[t * 4] = f | flags
    }
  }
  return out
}

// Kept for tools: the zone key of a cell (see spaceAt).
export function zoneKeyAt(data, lx, lz) {
  return spaceAt(data, lx, lz).key
}
