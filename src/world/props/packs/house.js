// House pack (map 05, house larger inside). Pure data, no imports: the record
// format is documented in ../index.js. Boxes trace the Blender models
// (scripts/blender/packs/house.py); proxies mirror its PROXIES table.

export const PROP_HALL_CLOCK = 74
export const PROP_RADIO = 75

// The pack's colours as box tints (same values as house.py's palette).
const MAHOGANY = [0.27, 0.13, 0.075]
const DIAL_GLOW = [1.0, 0.66, 0.3]

export default {
  pack: 'house',
  // valveBrass restates the stairwell pack's entry verbatim, so the house
  // models keep their brass surface without depending on that pack.
  surfaces: {
    yr_mahogany: [0.5, 0], // polished case wood
    yr_valveBrass: [0.32, 0.85],
    yr_dialGlow: [0.3, 0], // lit radio dial glass
  },
  kinds: [
    {
      id: PROP_HALL_CLOCK,
      key: 'PROP_HALL_CLOCK',
      kind: 'hall_clock',
      name: 'hall clock',
      cls: 'B',
      dims: [0.55, 0.35],
      height: 2.05,
      boxes: [
        [0, 0.235, -0.005, 0.53, 0.47, 0.33, MAHOGANY], // plinth
        [0, 0.955, -0.02, 0.43, 0.97, 0.27, MAHOGANY], // trunk
        [0, 1.03, 0.135, 0.19, 0.58, 0.01, 'slotDark'], // pendulum window
        [0, 1.675, -0.01, 0.51, 0.41, 0.31, MAHOGANY], // hood
        [0, 1.675, 0.152, 0.3, 0.3, 0.014, 'paperWhite'], // dial
        [0, 1.94, -0.005, 0.55, 0.12, 0.35, MAHOGANY], // cornice and bonnet
      ],
      proxies: [
        [-0.26, 0.26, -0.175, 0.16, 0, 1.47],
        [-0.27, 0.27, -0.175, 0.175, 1.47, 2.0],
      ],
    },
    {
      id: PROP_RADIO,
      key: 'PROP_RADIO',
      kind: 'radio',
      name: 'radio on side table',
      cls: 'B',
      dims: [0.55, 0.4],
      height: 0.95,
      boxes: [
        [0, 0.3, -0.005, 0.5, 0.6, 0.35, MAHOGANY], // cupboard on its legs
        [0, 0.615, 0, 0.55, 0.03, 0.4, MAHOGANY], // top
        [0, 0.78, 0.005, 0.34, 0.25, 0.21, 'woodMid'], // radio cabinet
        [0, 0.92, 0.005, 0.22, 0.03, 0.21, 'woodMid'], // its rounded head
        [0, 0.83, 0.112, 0.23, 0.15, 0.006, 'rug'], // grille cloth
        [0, 0.706, 0.115, 0.07, 0.07, 0.008, DIAL_GLOW], // lit dial
      ],
      proxies: [
        [-0.275, 0.275, -0.2, 0.2, 0, 0.635],
        [-0.19, 0.19, -0.11, 0.135, 0.635, 0.94],
      ],
    },
  ],
}
