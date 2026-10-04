// Street pack: the shared street kit's props (maps 02 night lot, 03 suburb,
// 09 showroom). Pure data, no imports: the record format is documented in
// ../index.js. Models: scripts/blender/packs/street.py -> public/models/street/.
// The boxes follow the models' masses (the editor shows them until the GLBs
// load); the proxies are fitted to the GLBs by the prop-models IoU harness and
// mirrored as occ_A/occ_B markers in street.py.

export const PROP_CART = 28
export const PROP_WHEELIE_BIN = 29
export const PROP_DUMPSTER = 30
export const PROP_BENCH = 31

const CART_MESH = [0.08, 0.085, 0.09] // the basket's wire field reads as a dark screen
const GRIP_RED = [0.6, 0.12, 0.1]
const BIN_GREEN = [0.18, 0.36, 0.22]
const BIN_LID = [0.14, 0.28, 0.17]
const DUMPSTER_GREEN = [0.13, 0.27, 0.2]

export default {
  pack: 'street',
  kinds: [
    {
      id: PROP_CART,
      key: 'PROP_CART',
      kind: 'cart',
      name: 'shopping cart',
      cls: 'B',
      dims: [0.6, 1.0],
      height: 1.05,
      boxes: [
        [0, 0.73, 0.035, 0.54, 0.42, 0.84, CART_MESH], // basket
        [0, 1.0, -0.465, 0.58, 0.04, 0.04, GRIP_RED], // push handle
        [-0.255, 0.56, -0.44, 0.025, 0.86, 0.03, 'chrome'], // uprights
        [0.255, 0.56, -0.44, 0.025, 0.86, 0.03, 'chrome'],
        [0, 0.15, 0, 0.44, 0.025, 0.8, 'legMetal'], // base rails + tray
        [0, 0.055, -0.02, 0.5, 0.11, 0.8, 'slotDark'], // casters
      ],
      proxies: [
        [-0.285, 0.285, -0.39, 0.42, 0.52, 0.94], // basket shell
        [-0.29, 0.29, -0.485, -0.445, 0.98, 1.02], // push handle
      ],
    },
    {
      id: PROP_WHEELIE_BIN,
      key: 'PROP_WHEELIE_BIN',
      kind: 'wheelie_bin',
      name: 'wheelie bin',
      cls: 'B',
      dims: [0.6, 0.75],
      height: 1.07,
      boxes: [
        [0, 0.505, 0.025, 0.54, 0.91, 0.58, BIN_GREEN], // tapered body
        [0, 0.99, 0.022, 0.6, 0.05, 0.665, BIN_LID], // lid
        [0, 0.945, -0.352, 0.48, 0.035, 0.035, BIN_GREEN], // push bar
        [0, 0.1, -0.265, 0.56, 0.2, 0.2, 'slotDark'], // wheels + axle
      ],
      proxies: [
        [-0.3, 0.3, -0.29, 0.315, 0.02, 1.03],
      ],
    },
    {
      id: PROP_DUMPSTER,
      key: 'PROP_DUMPSTER',
      kind: 'dumpster',
      name: 'dumpster',
      cls: 'B',
      dims: [1.9, 1.1],
      height: 1.3,
      boxes: [
        [0, 0.685, -0.03, 1.68, 1.03, 0.92, DUMPSTER_GREEN], // body
        [0, 1.2, -0.01, 1.7, 0.06, 1.06, 'keyDark'], // plastic lids
        [0, 0.82, -0.03, 1.86, 0.15, 0.84, DUMPSTER_GREEN], // fork pockets
        [0, 0.08, -0.08, 1.5, 0.16, 0.66, 'slotDark'], // casters
      ],
      proxies: [
        [-0.93, 0.93, -0.52, 0.44, 0.17, 1.22],
      ],
    },
    {
      id: PROP_BENCH,
      key: 'PROP_BENCH',
      kind: 'bench',
      name: 'park bench',
      cls: 'B',
      dims: [1.8, 0.65],
      height: 0.85,
      boxes: [
        [0, 0.442, 0.02, 1.8, 0.036, 0.54, 'woodMid'], // seat slats
        [0, 0.67, -0.25, 1.8, 0.4, 0.03, 'woodMid'], // back slats
        [0, 0.375, 0.282, 1.66, 0.095, 0.016, 'keyDark'], // front apron
        [-0.835, 0.2125, 0.0, 0.05, 0.425, 0.56, 'keyDark'], // cast ends (legs + seat arm)
        [0.835, 0.2125, 0.0, 0.05, 0.425, 0.56, 'keyDark'],
      ],
      proxies: [
        [-0.9, 0.9, -0.28, 0.3, 0.325, 0.46], // seat band
        [-0.9, 0.9, -0.31, -0.23, 0.36, 0.87], // back
      ],
    },
  ],
  // Materials street.py introduces: [roughness, metalness].
  surfaces: {
    yr_cartMesh: [0.7, 0],
    yr_cartGrip: [0.55, 0],
    yr_binGreen: [0.62, 0],
    yr_binLid: [0.58, 0],
    yr_dumpsterGreen: [0.55, 0],
  },
}
