import {
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
} from './mapTypes.js'
import { deepFreeze } from './mapFamily.js'

// Per-family art direction. One family is active per world (config.mapFamily
// .selected), so these palettes drive whole-world material, lamp, and grade
// swaps — the render layer reads them at family-apply time, never per frame.
//
// Anime-backrooms rules carried over from textures.js: clean flat fields,
// sparse tone-on-tone detail, mood from light + grade rather than paint.
//
// These six keys (fog, ambientSky, ambientGround, rim, gradeTint, gradeSat)
// OVERRIDE their constants.js namesakes at family-apply time — see
// DeferredRenderer.applyFamily. constants.js holds the office defaults for the
// pre-family boot path; this file is what you actually see. Change both.
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
    gradeSat: 1.34,
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
    gradeSat: 1.05,
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
    gradeSat: 1.22,
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
    gradeSat: 1.24,
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
    gradeSat: 1.16,
  },
})

// Always returns a palette; unknown/absent family falls back to Office so the
// render layer can never crash on an unexpected selection.
export function familyPalette(family) {
  return FAMILY_PALETTES[family] ?? FAMILY_PALETTES[MAP_FAMILY_OFFICE]
}
