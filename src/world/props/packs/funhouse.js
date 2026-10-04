// Funhouse pack (map 12, funhouse). Pure data, no imports: the record format
// is documented in ../index.js. Boxes and proxies follow the Blender models
// (scripts/blender/packs/funhouse.py, whose occ_* markers are these proxies).

export const PROP_CCTV = 78
export const PROP_BALL_TRACK = 79

// The Blender palette colours (linear, like FURN_TINT).
const PHOSPHOR = [0.5, 0.78, 0.7]
const FUN_RED = [0.72, 0.035, 0.03]
const FUN_YELLOW = [0.92, 0.6, 0.04]
const FUN_BLUE = [0.03, 0.14, 0.62]

export default {
  pack: 'funhouse',
  kinds: [
    {
      id: PROP_CCTV,
      key: 'PROP_CCTV',
      kind: 'cctv',
      name: 'CCTV monitor desk',
      cls: 'B',
      dims: [0.8, 0.55],
      height: 1.4,
      boxes: [
        [0, 0.74, 0, 0.8, 0.03, 0.55, 'laminate'], // desk top
        [-0.3875, 0.3625, 0, 0.025, 0.725, 0.53, 'cabinetPaint'], // end panel
        [0.21, 0.3625, -0.01, 0.38, 0.725, 0.53, 'copierBody'], // drawer pedestal
        [-0.07, 0.975, -0.075, 0.44, 0.44, 0.38, 'rackFace'], // VCR + 14" monitor
        [-0.07, 1.04, 0.122, 0.33, 0.25, 0.004, PHOSPHOR], // split screen
        [-0.09, 1.292, -0.04, 0.27, 0.2, 0.22, 'rackFace'], // 9" spot monitor
      ],
      proxies: [
        [-0.4, 0.4, -0.275, 0.275, 0, 0.755],
        [-0.29, 0.15, -0.27, 0.12, 0.755, 1.395],
      ],
    },
    {
      id: PROP_BALL_TRACK,
      key: 'PROP_BALL_TRACK',
      kind: 'ball_track',
      name: 'ball track',
      cls: 'B',
      dims: [1.0, 0.6],
      height: 1.2,
      boxes: [
        [0, 0.52, 0, 1.0, 0.04, 0.6, 'woodMid'], // table top
        [0, 0.25, 0, 0.94, 0.5, 0.54, FUN_BLUE], // panelled table body, legs on the floor
        [0, 0.855, -0.245, 0.92, 0.63, 0.09, FUN_YELLOW], // run board + cheeks
        [0, 1.165, -0.18, 0.93, 0.03, 0.21, 'woodMid'], // crossbar
        [-0.02, 0.97, -0.165, 0.7, 0.03, 0.07, FUN_RED], // ramps (two of five, level)
        [-0.06, 0.76, -0.165, 0.7, 0.03, 0.07, FUN_BLUE],
      ],
      proxies: [
        [-0.5, 0.5, -0.3, 0.3, 0, 0.54],
        [-0.46, 0.46, -0.29, -0.07, 0.54, 1.18],
      ],
    },
  ],
  // The yr_* materials this pack introduces: [roughness, metalness].
  surfaces: {
    yr_cctvScreen: [0.1, 0],
    yr_cctvImage: [0.1, 0],
    yr_recRed: [0.3, 0],
    yr_funRed: [0.4, 0],
    yr_funYellow: [0.45, 0],
    yr_funBlue: [0.4, 0],
  },
}
