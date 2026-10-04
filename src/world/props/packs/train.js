// Train pack (map 07, endless train). Pure data, no imports: the record
// format is documented in ../index.js.

export const PROP_METRO_BENCH = 70
export const PROP_SEAT_PAIR = 71
export const PROP_TICKET_GATE = 72

// Box-fallback colours: the Blender palette of scripts/blender/packs/train.py.
const SHELL = [0.6, 0.59, 0.55]
const LINE_GREEN = [0.05, 0.3, 0.15]
const MOQUETTE = [0.1, 0.17, 0.36]
const PRIORITY = [0.62, 0.22, 0.06]
const FLAP_RED = [0.8, 0.2, 0.06]
// The GLB reader target is keep_bright; boxes have no such pass, so lift it.
const READER_LIT = [0.4, 0.68, 1]

export default {
  pack: 'train',
  // Materials scripts/blender/packs/train.py introduces: [roughness, metalness].
  surfaces: {
    yr_trainShell: [0.45, 0], // moulded GRP seat shells, gate top furniture
    yr_lineGreen: [0.45, 0], // the line's livery band
    yr_moquette: [0.95, 0], // seat cloth
    yr_moquettePriority: [0.95, 0], // priority seat cloth
    yr_gateFlap: [0.4, 0], // closed paddle
    yr_readerBlue: [0.25, 0], // card target glow
    yr_stopRed: [0.25, 0], // no-entry lamp
  },
  kinds: [
    {
      id: PROP_METRO_BENCH,
      key: 'PROP_METRO_BENCH',
      kind: 'metro_bench',
      name: 'metro bench',
      cls: 'B',
      dims: [2.1, 0.55],
      height: 0.9,
      // In-car longitudinal bench: heater plinth, three seats (the +u one is
      // the priority seat), shell backrest to the window line.
      boxes: [
        [0, 0.205, -0.01, 2.06, 0.41, 0.5, 'applianceSteel'], // plinth + deck
        [-0.345, 0.445, 0.02, 1.33, 0.075, 0.47, MOQUETTE], // seats
        [0.69, 0.445, 0.02, 0.64, 0.075, 0.47, PRIORITY], // priority seat
        [0, 0.65, -0.25, 2.06, 0.5, 0.05, SHELL], // backrest shell
        [-0.345, 0.645, -0.2, 1.33, 0.33, 0.07, MOQUETTE], // back pads
        [0.69, 0.645, -0.2, 0.62, 0.33, 0.07, PRIORITY],
      ],
      proxies: [
        [-1.05, 1.05, -0.26, 0.23, 0, 0.48],
        [-1.03, 1.03, -0.28, -0.17, 0.48, 0.9],
      ],
    },
    {
      id: PROP_SEAT_PAIR,
      key: 'PROP_SEAT_PAIR',
      kind: 'seat_pair',
      name: 'transverse seat pair',
      cls: 'B',
      dims: [1.0, 0.75],
      height: 1.1,
      // The GLB back rakes 8 degrees; the boxes stand it upright.
      boxes: [
        [0, 0.195, -0.05, 0.92, 0.39, 0.5, 'applianceSteel'], // heater plinth
        [0, 0.395, 0, 0.98, 0.035, 0.66, SHELL], // seat deck
        [0, 0.455, 0.03, 0.95, 0.08, 0.58, MOQUETTE], // seat pads
        [0, 0.75, -0.31, 0.98, 0.7, 0.07, SHELL], // shell back
        [0, 0.74, -0.25, 0.92, 0.6, 0.06, MOQUETTE], // back pads
        [0, 0.95, -0.215, 0.76, 0.14, 0.02, 'paperWhite'], // headrest covers
      ],
      proxies: [
        [-0.49, 0.5, -0.29, 0.3, 0, 0.49],
        [-0.49, 0.49, -0.36, -0.2, 0.49, 1.1],
      ],
    },
    {
      id: PROP_TICKET_GATE,
      key: 'PROP_TICKET_GATE',
      kind: 'ticket_gate',
      name: 'ticket gate',
      cls: 'B',
      dims: [0.3, 1.5],
      height: 1.05,
      // Cabinet off-centre toward -u so the closed paddle can reach out of
      // the +u flank inside the footprint allowance.
      boxes: [
        [-0.035, 0.035, 0, 0.19, 0.07, 1.4, 'slotDark'], // toe-kick plinth
        [-0.035, 0.47, 0, 0.23, 0.82, 1.44, 'applianceSteel'], // body
        [-0.035, 0.9, 0, 0.238, 0.06, 1.448, LINE_GREEN], // livery band
        [-0.035, 0.9575, 0, 0.23, 0.065, 1.44, 'keyDark'], // top
        [-0.035, 1.01, 0.5, 0.19, 0.05, 0.18, READER_LIT], // card reader
        [0.18, 0.7, 0, 0.2, 0.4, 0.03, FLAP_RED], // closed paddle
      ],
      proxies: [
        [-0.16, 0.08, -0.73, 0.73, 0, 1.02],
        [0.08, 0.28, -0.02, 0.02, 0.5, 0.9],
      ],
    },
  ],
}
