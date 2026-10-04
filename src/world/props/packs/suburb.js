// Suburb pack (map 03, sleeping suburb). Pure data, no imports: the record
// format is documented in ../index.js. GLBs: scripts/blender/packs/suburb.py
// (its PROXIES table repeats the proxies below).

export const PROP_MAILBOX = 50
export const PROP_KIDS_BIKE = 51
export const PROP_GNOME = 52
export const PROP_DOGHOUSE = 53

// The Blender palette's colours, so the box fallback matches the models.
const MAILBOX_BLUE = [0.22, 0.3, 0.42]
const FLAG_RED = [0.78, 0.1, 0.05]
const BIKE_TEAL = [0.06, 0.42, 0.46]
const HAT_RED = [0.72, 0.09, 0.06]
const COAT_BLUE = [0.12, 0.24, 0.55]
const SKIN = [0.86, 0.6, 0.47]
const STONE = [0.5, 0.49, 0.46]
const KENNEL_RED = [0.42, 0.12, 0.08]
const SHINGLE = [0.17, 0.18, 0.2]
const DOOR_DARK = [0.06, 0.05, 0.05]

export default {
  pack: 'suburb',
  kinds: [
    {
      id: PROP_MAILBOX,
      key: 'PROP_MAILBOX',
      kind: 'mailbox',
      name: 'mailbox on post',
      cls: 'B',
      dims: [0.35, 0.55],
      height: 1.2,
      boxes: [
        [0, 0.444, -0.06, 0.09, 0.888, 0.09, 'woodMid'], // post
        [0, 0.904, -0.01, 0.16, 0.032, 0.46, 'woodMid'], // support board
        [0, 1.0, 0, 0.2, 0.16, 0.48, MAILBOX_BLUE], // box, straight sides
        [0, 1.105, 0, 0.14, 0.07, 0.48, MAILBOX_BLUE], // box, rounded top
        [0.12, 1.07, -0.13, 0.012, 0.19, 0.026, FLAG_RED], // flag arm, raised
        [0.12, 1.145, -0.075, 0.012, 0.09, 0.13, FLAG_RED], // flag blade
      ],
      proxies: [
        [-0.1, 0.1, -0.24, 0.252, 0.9, 1.14],
        [-0.045, 0.045, -0.105, -0.015, 0, 0.9],
      ],
    },
    {
      id: PROP_KIDS_BIKE,
      key: 'PROP_KIDS_BIKE',
      kind: 'kids_bike',
      name: "kid's bike",
      cls: 'B',
      dims: [0.45, 1.2],
      height: 0.75,
      boxes: [
        [0, 0.2, -0.37, 0.052, 0.4, 0.4, 'keyDark'], // rear wheel
        [0, 0.2, 0.37, 0.052, 0.4, 0.4, 'keyDark'], // front wheel
        [0, 0.5, 0.04, 0.035, 0.04, 0.52, BIKE_TEAL], // top tube
        [0, 0.43, 0.3, 0.04, 0.5, 0.04, BIKE_TEAL], // fork, head tube, stem
        [0, 0.57, -0.215, 0.11, 0.06, 0.2, 'keyDark'], // saddle
        [0, 0.685, 0.14, 0.44, 0.035, 0.05, 'keyDark'], // handlebar and grips
      ],
      // A frame: two boxes cover about half of its silhouette at any size
      // (top IoU 0.55, side 0.46 against the GLB); these follow the wheel
      // line and the handlebar, where the shadow actually falls.
      proxies: [
        [-0.035, 0.05, -0.57, 0.57, 0, 0.6],
        [-0.22, 0.22, 0.1, 0.13, 0.64, 0.71],
      ],
    },
    {
      id: PROP_GNOME,
      key: 'PROP_GNOME',
      kind: 'gnome',
      name: 'garden gnome',
      cls: 'B',
      dims: [0.3, 0.3],
      height: 0.45,
      boxes: [
        [0, 0.025, 0, 0.24, 0.05, 0.24, STONE], // plinth
        [0, 0.165, 0.005, 0.19, 0.23, 0.18, COAT_BLUE], // coat
        [0, 0.318, 0.004, 0.11, 0.1, 0.11, SKIN], // head
        [0, 0.24, 0.058, 0.09, 0.13, 0.05, 'porcelain'], // beard
        [0, 0.36, 0.004, 0.124, 0.06, 0.124, HAT_RED], // hat
        [0, 0.41, 0.02, 0.06, 0.05, 0.06, HAT_RED], // hat tip
      ],
      proxies: [
        [-0.12, 0.12, -0.1, 0.12, 0, 0.3],
        [-0.06, 0.06, -0.06, 0.04, 0.3, 0.41],
      ],
    },
    {
      id: PROP_DOGHOUSE,
      key: 'PROP_DOGHOUSE',
      kind: 'doghouse',
      name: 'doghouse',
      cls: 'B',
      dims: [0.9, 1.1],
      height: 1.0,
      boxes: [
        [0, 0.3, -0.005, 0.74, 0.6, 0.91, KENNEL_RED], // walls on their skids
        [0, 0.3, 0.459, 0.4, 0.48, 0.018, 'paperWhite'], // door surround
        [0, 0.28, 0.47, 0.32, 0.4, 0.004, DOOR_DARK], // doorway
        // Gable roof as stepped slabs.
        [0, 0.645, 0, 0.94, 0.09, 1.1, SHINGLE],
        [0, 0.77, 0, 0.64, 0.16, 1.1, SHINGLE],
        [0, 0.9, 0, 0.3, 0.1, 1.12, SHINGLE],
      ],
      proxies: [
        [-0.44, 0.44, -0.55, 0.55, 0.56, 0.94],
        [-0.38, 0.38, -0.46, 0.45, 0.05, 0.6],
      ],
    },
  ],
  // Runtime surfaces ([roughness, metalness]) of the Blender materials this
  // pack introduces; the rest reuse furniture keys.
  surfaces: {
    yr_mailboxSteel: [0.5, 0.35],
    yr_mailFlag: [0.5, 0],
    yr_bikeTeal: [0.38, 0.3],
    yr_bikePlastic: [0.5, 0],
    yr_gnomeRed: [0.38, 0],
    yr_gnomeBlue: [0.42, 0],
    yr_gnomeSkin: [0.45, 0],
    yr_gnomeStone: [0.92, 0],
    yr_kennelRed: [0.82, 0],
    yr_roofShingle: [0.92, 0],
  },
}
