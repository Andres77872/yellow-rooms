import {
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
} from './mapTypes.js'
import { deepFreeze } from './mapFamily.js'
import { paletteIdOf } from './families/registry.js'

// Per-family art direction. One family is active per world (config.mapFamily
// .selected), so these palettes drive whole-world material, lamp, and grade
// swaps — the render layer reads them at family-apply time, never per frame.
//
// Anime-backrooms rules carried over from textures.js: clean flat fields,
// sparse tone-on-tone detail, mood from light + grade rather than paint.
//
// These seven keys (fog, ambientSky, ambientGround, rim, gradeTint, gradeSat,
// exposure) OVERRIDE their constants.js namesakes (GRADE_EXPOSURE for
// exposure) at family-apply time — see DeferredRenderer.applyPalette.
// constants.js holds the office defaults for the pre-family boot path; this
// file is what you actually see. Change both. `floor.base` also tints the
// renderer's one-bounce lamp fill, and each surface `style` picks its gloss
// (gbufferMaterials.js SURFACE_GLOSS).
//
// Exposure is per family because the families' surface albedos differ by
// more than a stop: tower's white tile needs less than the sewer's wet brick.
//
// A family is recognisable in one screenshot because of its SHADOW colour, not
// its lamp colour — four of the five ship a warm-white fixture. Tune ambientSky
// first; treat gradeTint/gradeSat as the last 10%.
//   office  — warm honey gold under a dusk-blue shadow side
//   sewer   — damp green-grey masonry under cold tubes
//   tower   — cool dusk glass-and-tile, blue void light
//   lattice — dark riveted steel under sodium cage lamps
//   hotel   — faded burgundy-and-rose residence under tired tungsten

export const FAMILY_PALETTES = deepFreeze({
  [MAP_FAMILY_OFFICE]: {
    floor: {
      style: 'carpet',
      base: '#cfae5e',
      flecks: ['#c4a355', '#dcbd6f', '#b89a4e'],
      stains: ['#b3924a', '#c2a054'],
    },
    wall: {
      style: 'wallpaper',
      base: '#e2d8a8',
      seam: '#93803e',
      flecks: ['#a89550', '#cdbf7e'],
      topLight: 'rgba(252,244,180,0.16)',
      floorShade: 'rgba(120,100,50,0.22)',
    },
    ceiling: {
      style: 'tile',
      base: '#ddd8b4',
      line: '#8d8863',
      flecks: ['#d2cda6', '#e6e1bd'],
    },
    trim: 0xd8d4c4,
    leaf: 0xbfb49a,
    panel: 0xfff1c8,
    panelDead: 0x5c563a,
    fog: 0x7d5f26,
    ambientSky: 0x38456e,
    ambientGround: 0x2a2740,
    rim: 0xcfe0ff,
    gradeTint: [1.06, 1.0, 0.88],
    gradeSat: 1.12,
    exposure: 0.66,
  },

  [MAP_FAMILY_SEWER]: {
    floor: {
      style: 'concrete',
      base: '#5c5f53',
      flecks: ['#54574b', '#65685b'],
      stains: ['#42463c', '#4d5044', '#383d33'],
    },
    wall: {
      style: 'brick',
      base: '#726d5d',
      mortar: '#4e4a3f',
      variants: ['#6b6656', '#787362', '#6f6a58', '#767159'],
      tide: 'rgba(38,48,38,0.34)',
      topLight: 'rgba(210,220,190,0.05)',
      floorShade: 'rgba(20,28,20,0.30)',
    },
    ceiling: {
      style: 'vault',
      base: '#565a4e',
      line: '#3d4137',
      flecks: ['#4e5246', '#5e6255'],
    },
    trim: 0x6a6d60,
    leaf: 0x5d5f54,
    panel: 0xe6fff4,
    panelDead: 0x3a3f38,
    fog: 0x16221a,
    ambientSky: 0x1c2c3a,
    ambientGround: 0x101a18,
    rim: 0xa8dce8,
    gradeTint: [0.92, 1.02, 1.0],
    gradeSat: 1.0,
    exposure: 1.3,
  },

  [MAP_FAMILY_TOWER]: {
    floor: {
      style: 'tile',
      base: '#b9bcc4',
      grout: '#83868f',
      flecks: ['#b1b4bd', '#c2c5cd'],
    },
    wall: {
      style: 'panel',
      base: '#d6d8de',
      seam: '#9a9da6',
      flecks: ['#ccced6', '#e0e2e8'],
      topLight: 'rgba(238,242,252,0.14)',
      floorShade: 'rgba(52,58,74,0.20)',
    },
    ceiling: {
      style: 'tile',
      base: '#cfd2da',
      line: '#8c8f9a',
      flecks: ['#c7cad2', '#d8dbe3'],
    },
    trim: 0xc2c6d0,
    leaf: 0x9aa0ac,
    panel: 0xf4f9ff,
    panelDead: 0x474c58,
    fog: 0x2e3a52,
    ambientSky: 0x4a5c86,
    ambientGround: 0x272d44,
    rim: 0xdce8ff,
    gradeTint: [0.98, 1.0, 1.1],
    gradeSat: 1.06,
    exposure: 0.6,
  },

  [MAP_FAMILY_HOTEL]: {
    floor: {
      style: 'carpet',
      base: '#6e3038',
      flecks: ['#632a32', '#7a3a42', '#582630'],
      stains: ['#4e2229', '#5c2a31'],
    },
    wall: {
      style: 'wallpaper',
      base: '#d9c4ae',
      seam: '#7d5a4a',
      flecks: ['#a3806a', '#c4a98e'],
      topLight: 'rgba(255,236,200,0.14)',
      floorShade: 'rgba(90,52,44,0.26)',
    },
    ceiling: {
      style: 'tile',
      base: '#d8cdb8',
      line: '#8a7c66',
      flecks: ['#cec3ac', '#e2d7c2'],
    },
    trim: 0xc9b598,
    leaf: 0x6b4034,
    panel: 0xffe0a8,
    panelDead: 0x4c3a30,
    fog: 0x4a2830,
    ambientSky: 0x3c3050,
    ambientGround: 0x282030,
    rim: 0xe0d4f0,
    gradeTint: [1.06, 0.98, 0.95],
    gradeSat: 1.1,
    exposure: 0.72,
  },

  [MAP_FAMILY_LATTICE]: {
    floor: {
      style: 'deck',
      base: '#43474f',
      seam: '#2b2e34',
      flecks: ['#3d4148', '#4b4f58'],
    },
    wall: {
      style: 'steel',
      base: '#4c515a',
      seam: '#33373e',
      rivet: '#282b31',
      flecks: ['#454a52', '#545962'],
      topLight: 'rgba(200,210,230,0.06)',
      floorShade: 'rgba(10,12,16,0.30)',
    },
    ceiling: {
      style: 'deck',
      base: '#383c43',
      seam: '#24272d',
      flecks: ['#33373e', '#3e424a'],
    },
    trim: 0x565b64,
    leaf: 0x4e525a,
    panel: 0xffd79a,
    panelDead: 0x2e3033,
    fog: 0x141a22,
    ambientSky: 0x2a3550,
    ambientGround: 0x181c28,
    rim: 0xa8bcdc,
    gradeTint: [1.03, 0.99, 0.97],
    gradeSat: 1.06,
    exposure: 0.9,
  },
})

// Look palettes for the authored liminal maps (editor kinds, map.meta.palette).
// Same shape as a family palette and painted only with the existing surface
// painters (render/textures.js, render/textureStyles.js), so the renderer
// needs no new code. A palette is a render choice only: the map's chunks keep
// their real mapFamily, which audits, dressing and doors still read.
//   stairwellConcrete — painted floor, painted block, cool tubes
//   nightLot          — asphalt-dark ground and walls under sodium, deep fog
//   showroomWhite     — bright polished white retail
//   poolTile          — mosaic and subway tile, cyan fog, cool white
//   babelLibrary      — warm parquet and wood panelling, dim amber
//   suburbNight       — domestic boards and paper under a blue night grade
//   terminalTerrazzo  — terrazzo and glassy panels, cool dusk
//   theaterDamask     — burgundy damask, red patterned carpet, tungsten
//   playCarpet        — loud confetti carpet, striped walls, bright
//   metroTile         — metro subway tile, fluorescent green-white
//   houseFaded        — faded stripe paper, worn carpet, warm and dim
//   funhouseNeon      — black-and-white checker, saturated stripes
export const MAP_PALETTES = deepFreeze({
  stairwellConcrete: {
    floor: {
      style: 'polished',
      base: '#7f8582',
      flecks: ['#757b78', '#8a908d', '#6b706e'],
      stains: ['#6c716f', '#747a77'],
      joint: '#4e5351',
    },
    wall: {
      style: 'cmu',
      base: '#c4c7c2',
      mortar: '#9fa29d',
      flecks: ['#b5b8b3', '#d0d3ce', '#a8aba6'],
      topLight: 'rgba(230,238,246,0.12)',
      floorShade: 'rgba(40,46,52,0.24)',
    },
    ceiling: {
      style: 'plaster',
      base: '#b9bcb8',
      mottle: ['#b0b3af', '#c0c3bf'],
      crack: '#8c8f8b',
      flecks: ['#b2b5b1', '#c2c5c1'],
    },
    trim: 0x8e9496,
    leaf: 0x7a2a26,
    panel: 0xecf6ff,
    panelDead: 0x40454c,
    fog: 0x262c34,
    ambientSky: 0x445470,
    ambientGround: 0x22262e,
    rim: 0xd4e2f4,
    gradeTint: [0.97, 1.0, 1.06],
    gradeSat: 0.96,
    exposure: 0.7,
  },

  nightLot: {
    floor: {
      style: 'concrete',
      base: '#646669',
      flecks: ['#2b2d31', '#3c3e42', '#46484c'],
      stains: ['#26282b', '#2c2e31', '#1f2124'],
    },
    wall: {
      style: 'formwork',
      base: '#4a4c4f',
      seam: '#36383b',
      tie: '#252629',
      flecks: ['#434548', '#525457', '#3c3e41'],
      stains: ['#3f4144', '#444649'],
      topLight: 'rgba(200,190,170,0.05)',
      floorShade: 'rgba(8,10,14,0.32)',
    },
    ceiling: {
      style: 'deck',
      base: '#2e3034',
      seam: '#1e2023',
      flecks: ['#292b2f', '#34363a'],
    },
    trim: 0x4c4f54,
    leaf: 0x3e4248,
    panel: 0xffb45e,
    panelDead: 0x2a2620,
    fog: 0x161b26,
    ambientSky: 0x7a8abc,
    ambientGround: 0x262a36,
    rim: 0x9cb0d4,
    gradeTint: [1.04, 0.98, 0.94],
    gradeSat: 1.02,
    exposure: 0.95,
  },

  showroomWhite: {
    floor: {
      style: 'polished',
      base: '#d6d4ce',
      flecks: ['#cdcbc5', '#dedcd6', '#c4c2bc'],
      stains: ['#c8c6c0', '#cfcdc7'],
      joint: '#a3a19c',
    },
    wall: {
      style: 'panel',
      base: '#eceae5',
      seam: '#b8b6b0',
      flecks: ['#e3e1dc', '#f2f0eb'],
      topLight: 'rgba(255,255,255,0.14)',
      floorShade: 'rgba(80,80,86,0.16)',
    },
    ceiling: {
      style: 'acoustic',
      base: '#eae9e4',
      line: '#b4b3ae',
      flecks: ['#e0dfda', '#f0efea', '#d6d5d0'],
      tiles: 4,
    },
    trim: 0xe4e4e0,
    leaf: 0xd8d6d0,
    panel: 0xf8fbff,
    panelDead: 0x5a5c60,
    fog: 0x6e7278,
    ambientSky: 0x6a7490,
    ambientGround: 0x3a3c48,
    rim: 0xeef2ff,
    gradeTint: [1.0, 1.0, 1.03],
    gradeSat: 0.98,
    exposure: 0.54,
  },

  poolTile: {
    floor: {
      style: 'mosaic',
      base: '#dfeae9',
      colors: ['#e4eeee', '#d6e4e4', '#cadbdc', '#5fa9b8'],
      grout: '#97aaab',
      shape: 'square',
      accentRate: 0.06,
      flecks: ['#d4e0df', '#e8f2f1'],
    },
    wall: {
      style: 'subway',
      base: '#e6eeec',
      tile: '#e6eeec',
      grout: '#9aacab',
      band: '#4f9aaa',
      flecks: ['#dbe5e3', '#eef5f3'],
      topLight: 'rgba(236,250,255,0.14)',
      floorShade: 'rgba(40,70,80,0.20)',
    },
    ceiling: {
      style: 'tile',
      base: '#e2ebea',
      line: '#9fb2b3',
      flecks: ['#d9e3e2', '#e9f1f0'],
    },
    trim: 0xd4e2e2,
    leaf: 0x9fb8bc,
    panel: 0xf0fbff,
    panelDead: 0x46585c,
    fog: 0x1e4a54,
    ambientSky: 0x4a7a8c,
    ambientGround: 0x203c46,
    rim: 0xd2f4ff,
    gradeTint: [0.94, 1.02, 1.08],
    gradeSat: 1.04,
    exposure: 0.55,
  },

  babelLibrary: {
    floor: {
      style: 'parquet',
      base: '#7a5634',
      woods: ['#7a5634', '#6a4a2c', '#86603a', '#7e5a36'],
      seam: '#43301c',
      layout: 'herringbone',
      flecks: ['#704f30', '#84603a'],
    },
    wall: {
      style: 'woodPanel',
      base: '#6e4c2e',
      woods: ['#6e4c2e', '#634429', '#765232'],
      seam: '#3c2a19',
      boards: 10,
      flecks: ['#654629', '#775434'],
      topLight: 'rgba(255,220,160,0.08)',
      floorShade: 'rgba(40,24,12,0.30)',
    },
    ceiling: {
      style: 'plaster',
      base: '#c6b28e',
      mottle: ['#bca986', '#cfbb96'],
      crack: '#94835f',
      flecks: ['#bfab88', '#cdb994'],
    },
    trim: 0x8a6a46,
    leaf: 0x5a3c24,
    panel: 0xffc878,
    panelDead: 0x4a3a28,
    fog: 0x34220f,
    ambientSky: 0x3a3048,
    ambientGround: 0x241a1c,
    rim: 0xf0d8b0,
    gradeTint: [1.08, 0.99, 0.86],
    gradeSat: 1.08,
    exposure: 1.3,
  },

  suburbNight: {
    floor: {
      style: 'planks',
      base: '#8a6c4c',
      woods: ['#8a6c4c', '#7a5f42', '#957554', '#826548'],
      seam: '#4a3a28',
      boards: 14,
      flecks: ['#806446', '#937352'],
    },
    wall: {
      style: 'stripe',
      base: '#d4cdb8',
      stripe: '#c4bca4',
      stripe2: '#e6e1d2',
      period: 32,
      duty: 0.3,
      flecks: ['#c8c1ac', '#ddd6c2', '#bdb6a1'],
      topLight: 'rgba(230,236,255,0.10)',
      floorShade: 'rgba(40,44,64,0.24)',
    },
    ceiling: {
      style: 'plaster',
      base: '#d6d2c6',
      mottle: ['#cdc9bd', '#dedacf'],
      crack: '#a29e93',
      flecks: ['#cfcbbf', '#dcd8cc'],
    },
    trim: 0xe0dccf,
    leaf: 0xd2ccbc,
    panel: 0xffe4bc,
    panelDead: 0x48443c,
    fog: 0x121a2e,
    ambientSky: 0x2c3c6a,
    ambientGround: 0x181e30,
    rim: 0xb8ccf4,
    gradeTint: [0.9, 0.97, 1.12],
    gradeSat: 0.92,
    exposure: 0.74,
  },

  terminalTerrazzo: {
    floor: {
      style: 'terrazzo',
      base: '#c9c6bd',
      chips: ['#79766f', '#8a96a4', '#dedbd2', '#4f545c'],
      seam: '#9a8f78',
      bays: 2,
      flecks: ['#bfbcb3', '#d3d0c7'],
    },
    wall: {
      style: 'panel',
      base: '#cfd4dc',
      seam: '#949aa6',
      flecks: ['#c6cbd3', '#d8dde5'],
      topLight: 'rgba(236,242,255,0.14)',
      floorShade: 'rgba(46,54,72,0.20)',
    },
    ceiling: {
      style: 'tile',
      base: '#d4d8de',
      line: '#8e94a0',
      flecks: ['#cbcfd5', '#dde1e7'],
    },
    trim: 0xbfc5d0,
    leaf: 0x8e96a4,
    panel: 0xf2f8ff,
    panelDead: 0x454b58,
    fog: 0x2a3552,
    ambientSky: 0x506494,
    ambientGround: 0x262c46,
    rim: 0xdce8ff,
    gradeTint: [0.97, 1.0, 1.1],
    gradeSat: 1.04,
    exposure: 0.58,
  },

  theaterDamask: {
    floor: {
      style: 'carpetPattern',
      base: '#6e1c24',
      motif: '#86303a',
      accent: '#a6763a',
      pattern: 'diamond',
      scale: 6,
      flecks: ['#64181f', '#7a242c', '#58141b'],
    },
    wall: {
      style: 'damask',
      base: '#6a2430',
      motif: '#88404a',
      repeat: 4,
      flecks: ['#60202b', '#742a36', '#561c26'],
      topLight: 'rgba(255,214,170,0.08)',
      floorShade: 'rgba(30,8,10,0.32)',
    },
    ceiling: {
      style: 'plaster',
      base: '#4a3430',
      mottle: ['#42302c', '#523a35'],
      crack: '#2e201d',
      flecks: ['#46312d', '#4e3733'],
    },
    trim: 0xb08a52,
    leaf: 0x4a1a1e,
    panel: 0xffc88a,
    panelDead: 0x4a3028,
    fog: 0x2a0e12,
    ambientSky: 0x3a2440,
    ambientGround: 0x22121a,
    rim: 0xf4d0b8,
    gradeTint: [1.1, 0.96, 0.9],
    gradeSat: 1.14,
    exposure: 1.25,
  },

  playCarpet: {
    floor: {
      style: 'carpetPattern',
      base: '#25346a',
      motif: '#d9a62c',
      accent: '#d4486e',
      pattern: 'confetti',
      scale: 6,
      flecks: ['#20305f', '#2d3e78', '#3a8a8c'],
    },
    wall: {
      style: 'stripe',
      base: '#f0d68a',
      stripe: '#e88a4c',
      stripe2: '#fff4dc',
      period: 64,
      duty: 0.35,
      flecks: ['#e6cc80', '#f6de96'],
      topLight: 'rgba(255,250,230,0.14)',
      floorShade: 'rgba(110,70,40,0.20)',
    },
    ceiling: {
      style: 'acoustic',
      base: '#e8e4d6',
      line: '#aaa594',
      flecks: ['#dedacc', '#eeeadc', '#d4d0c2'],
      tiles: 4,
    },
    trim: 0xe85a4a,
    leaf: 0x3a8acc,
    panel: 0xfff4dc,
    panelDead: 0x5c5440,
    fog: 0x6a5634,
    ambientSky: 0x5a5c8a,
    ambientGround: 0x34304a,
    rim: 0xfff0e0,
    gradeTint: [1.04, 1.0, 0.94],
    gradeSat: 1.22,
    exposure: 0.7,
  },

  metroTile: {
    floor: {
      style: 'tile',
      base: '#a4a69c',
      grout: '#6e7068',
      tiles: 4,
      flecks: ['#9b9d93', '#adafa5'],
    },
    wall: {
      style: 'subway',
      base: '#e4e9da',
      tile: '#e4e9da',
      grout: '#97a092',
      band: '#2f6a4a',
      flecks: ['#dae0cf', '#ecf0e3'],
      topLight: 'rgba(236,255,236,0.12)',
      floorShade: 'rgba(30,50,40,0.22)',
    },
    ceiling: {
      style: 'plaster',
      base: '#d4dacb',
      mottle: ['#cbd1c2', '#dce2d3'],
      crack: '#9aa092',
      flecks: ['#cfd5c6', '#d9dfd0'],
    },
    trim: 0xc8cfc0,
    leaf: 0x5f7a66,
    panel: 0xeaffea,
    panelDead: 0x3e4a40,
    fog: 0x1c2a22,
    ambientSky: 0x3e5a54,
    ambientGround: 0x1e2a26,
    rim: 0xd6f4e0,
    gradeTint: [0.95, 1.05, 0.97],
    gradeSat: 0.98,
    exposure: 0.6,
  },

  houseFaded: {
    floor: {
      style: 'carpet',
      base: '#8a7b64',
      flecks: ['#82735c', '#93846c', '#786a54'],
      stains: ['#6f624e', '#7b6d57'],
    },
    wall: {
      style: 'stripe',
      base: '#cfc2a2',
      stripe: '#c2b292',
      stripe2: '#ded3b8',
      period: 16,
      duty: 0.4,
      flecks: ['#c4b797', '#d8cbac', '#b8ab8b'],
      topLight: 'rgba(255,236,200,0.10)',
      floorShade: 'rgba(80,60,40,0.28)',
    },
    ceiling: {
      style: 'plaster',
      base: '#d2c9b4',
      mottle: ['#c8bfaa', '#dbd2bd'],
      crack: '#9c937e',
      flecks: ['#cbc2ad', '#d8cfba'],
    },
    trim: 0xd6ccb4,
    leaf: 0x8a6a4a,
    panel: 0xffd8a0,
    panelDead: 0x4c4232,
    fog: 0x3a2c1a,
    ambientSky: 0x3c3448,
    ambientGround: 0x282024,
    rim: 0xeedcc0,
    gradeTint: [1.08, 1.0, 0.86],
    gradeSat: 0.9,
    exposure: 0.78,
  },

  funhouseNeon: {
    floor: {
      style: 'checker',
      base: '#e8e4d8',
      a: '#e8e4d8',
      b: '#1c1c24',
      seam: '#141418',
      tiles: 8,
      flecks: ['#dedad0', '#26262e'],
    },
    wall: {
      style: 'stripe',
      base: '#c42a72',
      stripe: '#3446c8',
      stripe2: '#f2e24a',
      period: 64,
      duty: 0.5,
      flecks: ['#b8266a', '#cc3278'],
      topLight: 'rgba(255,230,255,0.12)',
      floorShade: 'rgba(30,10,40,0.30)',
    },
    ceiling: {
      style: 'plaster',
      base: '#3a2c4a',
      mottle: ['#342842', '#423252'],
      crack: '#241a30',
      flecks: ['#362946', '#3f304f'],
    },
    trim: 0xf2e24a,
    leaf: 0x2ab8a8,
    panel: 0xf2e8ff,
    panelDead: 0x3a3048,
    fog: 0x261236,
    ambientSky: 0x5a3a8c,
    ambientGround: 0x2a1838,
    rim: 0xf0d8ff,
    gradeTint: [1.04, 0.96, 1.08],
    gradeSat: 1.26,
    exposure: 0.85,
  },
})

// Kind palettes in kind order (editor/prototypes.js PROTOTYPE_KINDS).
export const MAP_PALETTE_IDS = Object.freeze(Object.keys(MAP_PALETTES))

// Always returns a palette: a family id, then a map look palette id, then the
// registry's palette alias of a liminal family (§5.1); anything
// else falls back to Office so the render layer can never crash on an
// unexpected selection.
export function familyPalette(family) {
  return FAMILY_PALETTES[family] ?? MAP_PALETTES[family] ?? MAP_PALETTES[paletteIdOf(family)] ?? FAMILY_PALETTES[MAP_FAMILY_OFFICE]
}
