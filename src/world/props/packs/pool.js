// Pool pack (map 01, poolrooms; the bandai seat is the sentō's). Pure data,
// no imports: the record format is documented in ../index.js.

export const PROP_STARTING_BLOCK = 40
export const PROP_LIFEGUARD_CHAIR = 41
export const PROP_LOUNGER = 42
export const PROP_KICKBOARD = 43
export const PROP_LOST_BIN = 44
export const PROP_BANDAI = 45

// Tints match the Blender palette (scripts/blender/packs/pool.py), so the box
// fallback the editor shows before the GLBs load reads like the model.
const TILE = [0.78, 0.86, 0.86]
const GRIP = [0.1, 0.2, 0.3]
const FOAM_BLUE = [0.08, 0.3, 0.68]
const FOAM_YELLOW = [0.9, 0.66, 0.08]
const CRATE_BLUE = [0.1, 0.26, 0.55]

export default {
  pack: 'pool',
  // Blender materials this pack introduces: [roughness, metalness].
  surfaces: {
    yr_poolTile: [0.2, 0], // glazed ceramic
    yr_tileGrout: [0.85, 0],
    yr_poolGrip: [0.9, 0], // non-slip pads and treads
    yr_rescueRed: [0.6, 0],
    yr_floatBlue: [0.9, 0], // closed-cell foam
    yr_floatYellow: [0.9, 0],
    yr_crateBlue: [0.55, 0], // moulded plastic
    yr_tatami: [0.92, 0],
  },
  kinds: [
    {
      id: PROP_STARTING_BLOCK,
      key: 'PROP_STARTING_BLOCK',
      kind: 'starting_block',
      name: 'starting block',
      cls: 'B',
      dims: [0.5, 0.75],
      height: 0.75,
      boxes: [
        [0, 0.31, -0.125, 0.48, 0.62, 0.48, TILE], // tiled plinth
        [0, 0.65, 0, 0.5, 0.05, 0.76, 'applianceWhite'], // platform (raked in the model)
        [0, 0.68, 0, 0.44, 0.012, 0.66, GRIP], // grip pad
        [0, 0.72, -0.31, 0.4, 0.08, 0.04, GRIP], // track-start wedge
        [0, 0.5, 0.3, 0.4, 0.026, 0.026, 'chrome'], // backstroke grip
      ],
      proxies: [
        [-0.25, 0.25, -0.35, 0.11, 0, 0.72],
        [-0.25, 0.25, -0.38, 0.38, 0.6, 0.64],
      ],
    },
    {
      id: PROP_LIFEGUARD_CHAIR,
      key: 'PROP_LIFEGUARD_CHAIR',
      kind: 'lifeguard_chair',
      name: 'lifeguard chair',
      cls: 'B',
      dims: [0.9, 1.1],
      height: 2.05,
      boxes: [
        [-0.42, 0.7, 0, 0.05, 1.4, 1.1, 'applianceWhite'], // side boards (stepped front edge in the model)
        [0.42, 0.7, 0, 0.05, 1.4, 1.1, 'applianceWhite'],
        [0, 0.7, -0.53, 0.8, 1.36, 0.03, 'applianceWhite'], // closed back board (the ring buoy is model-only)
        [0, 0.78, 0.3, 0.8, 0.035, 0.4, GRIP], // the tread stair, as one step
        [0, 1.43, -0.21, 0.8, 0.06, 0.62, 'woodMid'], // seat
        [0, 1.76, -0.5, 0.72, 0.36, 0.035, 'woodMid'], // backrest
      ],
      proxies: [
        [-0.445, 0.445, -0.55, 0.55, 0, 1.46], // boards, stair and seat
        [-0.38, 0.38, -0.54, -0.44, 1.42, 1.86], // backrest
      ],
    },
    {
      id: PROP_LOUNGER,
      key: 'PROP_LOUNGER',
      kind: 'lounger',
      name: 'pool lounger',
      cls: 'B',
      dims: [0.7, 1.95],
      height: 0.45,
      boxes: [
        [0, 0.24, 0, 0.68, 0.1, 1.92, 'applianceWhite'], // frame
        [0, 0.288, 0.275, 0.6, 0.024, 1.32, 'applianceWhite'], // slatted bed
        [0, 0.37, -0.68, 0.6, 0.05, 0.56, 'applianceWhite'], // raised backrest (raked in the model)
        [0, 0.1, 0.86, 0.64, 0.2, 0.07, 'applianceWhite'], // foot legs
        [0, 0.07, -0.82, 0.64, 0.14, 0.14, 'keyDark'], // head wheels
        [0.02, 0.318, 0.6, 0.44, 0.036, 0.3, 'towel'], // folded towel
      ],
      proxies: [
        [-0.33, 0.33, -0.96, 0.97, 0.19, 0.29],
        [-0.32, 0.32, -0.87, -0.53, 0.22, 0.42],
      ],
    },
    {
      id: PROP_KICKBOARD,
      key: 'PROP_KICKBOARD',
      kind: 'kickboard',
      name: 'kickboard',
      cls: 'B',
      dims: [0.3, 0.45],
      height: 0.03,
      boxes: [
        [0, 0.0055, 0, 0.3, 0.011, 0.45, FOAM_YELLOW], // laminated foam
        [0, 0.0205, 0, 0.29, 0.019, 0.44, FOAM_BLUE],
        [-0.07, 0.0305, 0.13, 0.05, 0.002, 0.09, FOAM_YELLOW], // grip patches
        [0.07, 0.0305, 0.13, 0.05, 0.002, 0.09, FOAM_YELLOW],
      ],
      proxies: [
        [-0.15, 0.15, -0.225, 0.225, 0, 0.03],
      ],
    },
    {
      id: PROP_LOST_BIN,
      key: 'PROP_LOST_BIN',
      kind: 'lost_bin',
      name: 'lost-property bin',
      cls: 'B',
      dims: [0.6, 0.45],
      height: 0.85,
      boxes: [
        [0, 0.41, 0, 0.58, 0.82, 0.43, CRATE_BLUE], // tapered bin
        [0, 0.82, 0, 0.6, 0.04, 0.45, CRATE_BLUE], // rolled rim
        [-0.08, 0.8, -0.03, 0.34, 0.1, 0.3, 'towel'], // leftovers
        [0.16, 0.82, 0.04, 0.18, 0.05, 0.18, FOAM_YELLOW],
        [0, 0.5, 0.222, 0.3, 0.16, 0.01, 'paperWhite'], // label card
      ],
      proxies: [
        [-0.3, 0.3, -0.225, 0.225, 0, 0.87],
      ],
    },
    {
      id: PROP_BANDAI,
      key: 'PROP_BANDAI',
      kind: 'bandai',
      name: 'bandai attendant seat',
      cls: 'B',
      dims: [1.2, 0.9],
      height: 1.6,
      boxes: [
        [0, 0.375, 0, 1.18, 0.75, 0.88, 'woodMid'], // raised base
        [-0.08, 0.81, -0.12, 0.46, 0.07, 0.46, 'fabric'], // cushion on the tatami
        [0, 0.985, 0.4, 1.2, 0.43, 0.1, 'woodDark'], // front counter and ledge
        [-0.565, 0.97, -0.02, 0.04, 0.4, 0.8, 'woodMid'], // side walls
        [0.565, 0.97, -0.02, 0.04, 0.4, 0.8, 'woodMid'],
        [-0.39, 1.45, -0.375, 0.36, 0.26, 0.025, 'woodDark'], // price board
      ],
      proxies: [
        [-0.6, 0.6, -0.44, 0.43, 0, 1.14],
        [-0.6, 0.6, 0.15, 0.46, 1.1, 1.2],
      ],
    },
  ],
}
