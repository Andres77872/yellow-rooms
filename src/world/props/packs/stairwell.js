// Stairwell pack (map 04, endless stairwell). Pure data, no imports: the
// record format is documented in ../index.js. Boxes and proxies follow the
// Blender models (scripts/blender/packs/stairwell.py, whose occ_* markers are
// these proxies); the wall-mounted parts reach v -0.205, the wall face of a
// piece hugged 0.06 m off it.

export const PROP_STANDPIPE = 24
export const PROP_DOORSTOP = 25

// The Blender palette colours (linear, like FURN_TINT).
const HOSE_RED = [0.5, 0.05, 0.035]
const VALVE_BRASS = [0.62, 0.45, 0.2]
const RUBBER = [0.3, 0.16, 0.08]

export default {
  pack: 'stairwell',
  kinds: [
    {
      id: PROP_STANDPIPE,
      key: 'PROP_STANDPIPE',
      kind: 'standpipe',
      name: 'standpipe hose cabinet',
      cls: 'B',
      dims: [0.8, 0.3],
      height: 2.05,
      boxes: [
        [-0.3, 0.985, -0.135, 0.114, 1.97, 0.114, HOSE_RED], // riser
        [-0.3, 1.0, -0.07, 0.075, 0.11, 0.11, VALVE_BRASS], // landing valve
        [0.12, 1.2, -0.075, 0.56, 0.8, 0.26, HOSE_RED], // cabinet
        [0.12, 1.2, 0.058, 0.47, 0.71, 0.006, 'slotDark'], // open front
        [0.12, 1.215, 0.064, 0.36, 0.36, 0.012, 'paperWhite'], // hose coil
        [0.12, 1.715, -0.197, 0.36, 0.09, 0.016, 'paperWhite'], // FIRE HOSE sign
      ],
      proxies: [
        [-0.16, 0.4, -0.205, 0.055, 0.8, 1.6],
        [-0.36, -0.24, -0.205, -0.075, 0, 2.03],
      ],
    },
    {
      id: PROP_DOORSTOP,
      key: 'PROP_DOORSTOP',
      kind: 'doorstop',
      name: 'rubber door wedge',
      cls: 'B',
      dims: [0.12, 0.2],
      height: 0.05,
      boxes: [
        [0, 0.006, 0, 0.12, 0.012, 0.2, RUBBER], // toe to heel
        [0, 0.022, -0.03, 0.12, 0.02, 0.14, RUBBER], // slope
        [0, 0.041, -0.065, 0.12, 0.018, 0.07, RUBBER], // heel
      ],
      proxies: [
        [-0.06, 0.06, -0.1, 0.1, 0, 0.02],
        [-0.06, 0.06, -0.1, 0, 0, 0.05],
      ],
    },
  ],
  // The yr_* materials this pack introduces: [roughness, metalness].
  surfaces: {
    yr_hoseRed: [0.42, 0],
    yr_valveBrass: [0.32, 0.85],
    yr_wedgeRubber: [0.9, 0],
  },
}
