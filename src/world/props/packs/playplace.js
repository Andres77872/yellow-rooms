// Playplace pack (map 10, playplace). Pure data, no imports: the record
// format is documented in ../index.js.

export const PROP_CHILD_TABLE = 64
export const PROP_CHILD_CHAIR = 65
export const PROP_ARCADE = 66
export const PROP_PUNCH_BAG = 67
export const PROP_MASCOT = 68

// Tints match the Blender palette (scripts/blender/packs/playplace.py), so the
// box fallback the editor shows before the GLBs load reads like the model.
const PLAY_RED = [0.6, 0.045, 0.035]
const PLAY_BLUE = [0.03, 0.13, 0.52]
const PLAY_YELLOW = [0.86, 0.56, 0.03]
const PLAY_GREEN = [0.05, 0.34, 0.07]
const ARCADE_BODY = [0.07, 0.04, 0.17]
const ARCADE_SCREEN = [0.12, 0.42, 0.78]
const ARCADE_GLOW = [0.98, 0.72, 0.22]
const MASCOT_FUR = [0.42, 0.17, 0.05]
const MASCOT_CREAM = [0.82, 0.62, 0.36]

export default {
  pack: 'playplace',
  // Blender materials this pack introduces: [roughness, metalness].
  surfaces: {
    yr_playRed: [0.45, 0], // moulded primary-colour plastic
    yr_playBlue: [0.45, 0],
    yr_playYellow: [0.45, 0],
    yr_playGreen: [0.45, 0],
    yr_arcadeBody: [0.55, 0], // cabinet laminate
    yr_arcadeScreen: [0.1, 0], // lit CRT glass
    yr_arcadeGlow: [0.25, 0], // marquee, sprites, coin slots
    yr_mascotFur: [0.6, 0], // painted fibreglass
    yr_mascotCream: [0.6, 0],
  },
  kinds: [
    {
      id: PROP_CHILD_TABLE,
      key: 'PROP_CHILD_TABLE',
      kind: 'child_table',
      name: 'child table',
      cls: 'B',
      dims: [1.2, 0.8],
      height: 0.55,
      boxes: [
        [0, 0.51, 0, 1.2, 0.08, 0.8, PLAY_YELLOW], // rounded top
        [0, 0.4375, 0, 1.1, 0.075, 0.7, PLAY_RED], // apron
        [-0.49, 0.2, 0, 0.09, 0.4, 0.67, PLAY_BLUE], // leg pairs
        [0.49, 0.2, 0, 0.09, 0.4, 0.67, PLAY_BLUE],
        [0, 0.075, 0, 0.98, 0.03, 0.58, PLAY_BLUE], // bin shelf
        [0, 0.19, 0, 0.9, 0.2, 0.5, PLAY_GREEN], // storage bins
      ],
      proxies: [
        [-0.6, 0.6, -0.4, 0.4, 0.4, 0.55],
        [-0.53, 0.53, -0.34, 0.34, 0.06, 0.3],
      ],
    },
    {
      id: PROP_CHILD_CHAIR,
      key: 'PROP_CHILD_CHAIR',
      kind: 'child_chair',
      name: 'child chair',
      cls: 'B',
      dims: [0.38, 0.38],
      height: 0.6,
      boxes: [
        [0, 0.3, -0.1675, 0.36, 0.6, 0.045, PLAY_RED], // panel back, floor to top
        [0, 0.29, 0.02, 0.38, 0.055, 0.34, PLAY_RED], // seat
        [-0.15, 0.135, 0.145, 0.044, 0.27, 0.044, PLAY_RED], // front legs
        [0.15, 0.135, 0.145, 0.044, 0.27, 0.044, PLAY_RED],
      ],
      proxies: [
        [-0.18, 0.18, -0.19, -0.145, 0, 0.6],
        [-0.19, 0.19, -0.19, 0.19, 0.265, 0.315],
      ],
    },
    {
      id: PROP_ARCADE,
      key: 'PROP_ARCADE',
      kind: 'arcade',
      name: 'arcade cabinet',
      cls: 'B',
      dims: [0.75, 0.85],
      height: 1.85,
      boxes: [
        [0, 0.495, -0.1125, 0.75, 0.99, 0.625, ARCADE_BODY], // lower cabinet
        [0, 1.415, -0.1775, 0.75, 0.85, 0.495, ARCADE_BODY], // upper cabinet
        [0, 1.7, 0.15, 0.75, 0.28, 0.16, ARCADE_BODY], // marquee hood
        [0, 1.25, 0.09, 0.5, 0.42, 0.02, ARCADE_SCREEN], // screen
        [0, 1.7, 0.235, 0.62, 0.2, 0.01, ARCADE_GLOW], // marquee
        [0, 0.93, 0.29, 0.69, 0.11, 0.27, PLAY_BLUE], // control panel
      ],
      proxies: [
        [-0.375, 0.375, -0.425, 0.21, 0, 1.84],
        [-0.345, 0.345, 0.21, 0.425, 0.875, 0.985],
      ],
    },
    {
      id: PROP_PUNCH_BAG,
      key: 'PROP_PUNCH_BAG',
      kind: 'punch_bag',
      name: 'foam punch bag',
      cls: 'B',
      dims: [0.8, 0.8],
      height: 1.6,
      boxes: [
        [0, 0.09, 0, 0.77, 0.18, 0.77, PLAY_YELLOW], // weighted base
        [0, 0.265, 0, 0.38, 0.19, 0.38, PLAY_RED], // foam column, banded
        [0, 0.62, 0, 0.4, 0.52, 0.4, PLAY_BLUE],
        [0, 0.95, 0, 0.41, 0.14, 0.41, PLAY_YELLOW],
        [0, 1.22, 0, 0.4, 0.4, 0.4, PLAY_BLUE],
        [0, 1.51, 0, 0.36, 0.18, 0.36, PLAY_RED],
      ],
      proxies: [
        [-0.2, 0.2, -0.2, 0.2, 0.17, 1.6],
        [-0.385, 0.385, -0.385, 0.385, 0, 0.19],
      ],
    },
    {
      id: PROP_MASCOT,
      key: 'PROP_MASCOT',
      kind: 'mascot',
      name: 'mascot statue',
      cls: 'B',
      dims: [0.8, 0.7],
      height: 1.9,
      boxes: [
        [0, 0.12, 0, 0.8, 0.24, 0.7, PLAY_BLUE], // plinth
        [0, 0.65, 0, 0.5, 0.82, 0.42, MASCOT_FUR], // legs + body
        [0, 0.68, 0.2, 0.3, 0.4, 0.04, MASCOT_CREAM], // belly
        [0, 1.3, 0.02, 0.48, 0.48, 0.44, MASCOT_FUR], // head
        [-0.34, 1.16, 0.03, 0.14, 0.48, 0.14, MASCOT_FUR], // waving arm
        [0.06, 1.66, 0, 0.14, 0.24, 0.14, PLAY_YELLOW], // party hat
      ],
      proxies: [
        [-0.25, 0.24, -0.18, 0.21, 0.24, 1.57],
        [-0.4, 0.4, -0.35, 0.35, 0, 0.24],
      ],
    },
  ],
}
