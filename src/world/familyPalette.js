import {
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
// Each family keeps ONE dominant hue register so its screenshots are
// recognizable at a glance:
//   office  — warm honey gold (the established look, byte-for-byte baseline)
//   sewer   — damp green-grey masonry under cold tubes
//   tower   — cool dusk glass-and-tile, blue void light
//   lattice — dark riveted steel under sodium cage lamps

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
    panel: 0xffe6a0,
    panelDead: 0x5c563a,
    fog: 0x6e5522,
    ambientSky: 0x2e3348,
    ambientGround: 0x262236,
    rim: 0xdcd8e4,
    gradeTint: [1.04, 1.0, 0.9],
    gradeSat: 1.18,
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
    panel: 0xd8f0dc,
    panelDead: 0x3a3f38,
    fog: 0x131a14,
    ambientSky: 0x1d241e,
    ambientGround: 0x131711,
    rim: 0xa8c0aa,
    gradeTint: [0.94, 1.03, 0.95],
    gradeSat: 0.92,
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
    panel: 0xeaf2ff,
    panelDead: 0x474c58,
    fog: 0x232a38,
    ambientSky: 0x39445c,
    ambientGround: 0x232838,
    rim: 0xccd6ee,
    gradeTint: [0.97, 1.0, 1.08],
    gradeSat: 1.06,
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
    panel: 0xffc985,
    panelDead: 0x2e3033,
    fog: 0x101318,
    ambientSky: 0x232833,
    ambientGround: 0x15171c,
    rim: 0x8f9ab0,
    gradeTint: [1.02, 0.99, 0.94],
    gradeSat: 1.0,
  },
})

// Always returns a palette; unknown/absent family falls back to Office so the
// render layer can never crash on an unexpected selection.
export function familyPalette(family) {
  return FAMILY_PALETTES[family] ?? FAMILY_PALETTES[MAP_FAMILY_OFFICE]
}
