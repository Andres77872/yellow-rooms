// Theater pack (map 11, empty theater). Pure data, no imports: the record
// format is documented in ../index.js.

export const PROP_GHOST_LIGHT = 60
export const PROP_PROMPT_DESK = 61
export const PROP_SEAT_ROW = 62
export const PROP_ROAD_CASE = 63

// Box-fallback colours: the Blender palette of scripts/blender/packs/theater.py.
// The GLB bulb and cue lamps are keep_bright; boxes have no such pass, so the
// lit parts are lifted here.
const BULB = [1, 0.85, 0.6]
const CUE_RED = [1, 0.2, 0.14]
const PLUSH = [0.19, 0.012, 0.018]
const CASE_BLACK = [0.045, 0.045, 0.05]

export default {
  pack: 'theater',
  // Materials scripts/blender/packs/theater.py introduces: [roughness, metalness].
  surfaces: {
    yr_ghostBulb: [0.3, 0], // bare tungsten bulb, desk-light strip
    yr_cueRed: [0.3, 0], // cue-light standby lenses
    yr_seatPlush: [0.92, 0], // red stalls velvet
    yr_caseBlack: [0.55, 0], // flight-case laminate
  },
  kinds: [
    {
      id: PROP_GHOST_LIGHT,
      key: 'PROP_GHOST_LIGHT',
      kind: 'ghost_light',
      name: 'ghost light',
      cls: 'B',
      dims: [0.5, 0.5],
      height: 1.9,
      boxes: [
        [0, 0.065, 0, 0.42, 0.13, 0.42, 'keyDark'], // base plate on casters
        [0, 0.246, 0, 0.4, 0.232, 0.4, 'legMetal'], // counterweight crib
        [0, 0.706, 0, 0.048, 0.688, 0.048, 'keyDark'], // lower pole
        [0, 1.34, 0, 0.038, 0.58, 0.038, 'chrome'], // upper pole
        [0, 1.665, 0, 0.048, 0.08, 0.048, 'tvBlack'], // lampholder
        [0, 1.78, 0, 0.12, 0.15, 0.12, BULB], // bare bulb
      ],
      // The crib from the caster yokes up, then the pole and cage column
      // (wider on +u, where the flex runs down).
      proxies: [
        [-0.205, 0.205, -0.205, 0.205, 0.08, 0.363],
        [-0.024, 0.036, -0.024, 0.024, 0.363, 1.88],
      ],
    },
    {
      id: PROP_PROMPT_DESK,
      key: 'PROP_PROMPT_DESK',
      kind: 'prompt_desk',
      name: 'prompt desk',
      cls: 'B',
      dims: [1.1, 0.6],
      height: 1.25,
      boxes: [
        [0, 0.5025, -0.045, 1.06, 1.005, 0.49, 'keyDark'], // carcass
        [0, 1.015, 0.03, 1.1, 0.04, 0.54, 'woodMid'], // writing top
        [0.06, 1.041, 0.06, 0.46, 0.012, 0.3, 'paperWhite'], // open script
        [0, 1.125, -0.22, 1.1, 0.25, 0.14, 'keyDark'], // upstand
        [0, 1.235, -0.125, 1.0, 0.024, 0.09, 'keyDark'], // desk-light hood
        [0, 1.18, -0.142, 0.86, 0.03, 0.012, CUE_RED], // standby lamps
      ],
      proxies: [
        [-0.55, 0.55, -0.29, 0.2, 0, 1.04],
        [-0.55, 0.55, -0.29, 0.3, 1.04, 1.25],
      ],
    },
    {
      id: PROP_SEAT_ROW,
      key: 'PROP_SEAT_ROW',
      kind: 'seat_row',
      name: '3-seat theatre row',
      cls: 'B',
      dims: [2.0, 0.75],
      height: 0.95,
      boxes: [
        [-0.955, 0.335, -0.055, 0.05, 0.67, 0.57, 'keyDark'], // aisle standards
        [0.955, 0.335, -0.055, 0.05, 0.67, 0.57, 'keyDark'],
        [0, 0.455, 0, 1.84, 0.11, 0.44, PLUSH], // seats (down)
        [0, 0.5, -0.33, 1.94, 0.9, 0.05, 'woodDark'], // back shells
        [0, 0.67, -0.27, 1.84, 0.5, 0.07, PLUSH], // back pads
      ],
      proxies: [
        [-1.0, 1.0, -0.35, 0.24, 0, 0.66],
        [-0.96, 0.96, -0.4, -0.22, 0.66, 0.95],
      ],
    },
    {
      id: PROP_ROAD_CASE,
      key: 'PROP_ROAD_CASE',
      kind: 'road_case',
      name: 'road case',
      cls: 'B',
      dims: [1.2, 0.6],
      height: 1.0,
      boxes: [
        [0, 0.05, 0, 1.0, 0.1, 0.42, 'slotDark'], // casters
        [0, 0.5475, 0, 1.18, 0.875, 0.58, CASE_BLACK], // case
        [0, 0.84, 0, 1.19, 0.022, 0.59, 'applianceSteel'], // lid seam
        [-0.58, 0.55, 0.28, 0.024, 0.86, 0.024, 'applianceSteel'], // front angle
        [0.58, 0.55, 0.28, 0.024, 0.86, 0.024, 'applianceSteel'],
        [-0.24, 0.6, 0.292, 0.3, 0.12, 0.004, 'paperWhite'], // stencil plate
      ],
      proxies: [
        [-0.6, 0.6, -0.3, 0.3, 0.1, 1.0],
        [-0.6, 0.6, -0.3, 0.3, 0, 0.1],
      ],
    },
  ],
}
