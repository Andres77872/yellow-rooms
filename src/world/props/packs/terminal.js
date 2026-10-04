// Terminal pack (map 08, airport terminal). Pure data, no imports: the record
// format is documented in ../index.js.

export const PROP_GATE_PODIUM = 56
export const PROP_BEAM_SEAT = 57
export const PROP_FIDS = 58

// Box-fallback colours: the Blender palette of scripts/blender/packs/terminal.py.
const LIVERY_GREY = [0.56, 0.58, 0.6]
const AIRLINE_BLUE = [0.08, 0.2, 0.46]
const SEAT_BLUE = [0.17, 0.24, 0.34]
// The GLB board is keep_bright navy; boxes have no such pass, so lift it.
const BOARD_LIT = [0.14, 0.24, 0.5]

export default {
  pack: 'terminal',
  // Materials scripts/blender/packs/terminal.py introduces: [roughness, metalness].
  surfaces: {
    yr_gateShell: [0.4, 0], // livery lacquer (podium, totem)
    yr_airlineBlue: [0.42, 0], // brand band / logo panel
    yr_beamSeatShell: [0.48, 0], // moulded polypropylene seat
    yr_fidsScreen: [0.1, 0], // board glass
    yr_fidsBar: [0.25, 0], // board rows
    yr_fidsAmber: [0.25, 0], // board status column
  },
  kinds: [
    {
      id: PROP_GATE_PODIUM,
      key: 'PROP_GATE_PODIUM',
      kind: 'gate_podium',
      name: 'gate podium',
      cls: 'B',
      dims: [1.8, 0.8],
      height: 1.1,
      boxes: [
        [0, 0.4625, 0, 1.76, 0.925, 0.72, LIVERY_GREY], // body
        [0, 1.0025, 0.21, 1.81, 0.185, 0.37, 'counterTop'], // passenger ledge + cap
        [0, 0.9325, -0.165, 1.79, 0.035, 0.45, 'counterTop'], // agent work surface
        [-0.33, 0.7, 0.368, 0.7, 0.4, 0.016, 'screen'], // fascia screen
        [0, 0.3, 0.366, 1.42, 0.12, 0.012, AIRLINE_BLUE], // airline band
        [0.52, 1.115, 0.24, 0.2, 0.04, 0.17, 'keyDark'], // boarding-pass reader
      ],
      proxies: [
        [-0.9, 0.9, -0.39, 0.4, 0, 0.95],
        [-0.9, 0.9, 0.03, 0.4, 0.95, 1.1],
      ],
    },
    {
      id: PROP_BEAM_SEAT,
      key: 'PROP_BEAM_SEAT',
      kind: 'beam_seat',
      name: '3-seat beam seating',
      cls: 'B',
      dims: [1.95, 0.7],
      height: 0.85,
      boxes: [
        [0, 0.3375, -0.02, 1.86, 0.075, 0.09, 'chrome'], // beam
        [-0.62, 0.165, -0.02, 0.06, 0.33, 0.34, 'chrome'], // T-legs
        [0.62, 0.165, -0.02, 0.06, 0.33, 0.34, 'chrome'],
        [0, 0.43, 0.03, 1.86, 0.05, 0.48, SEAT_BLUE], // seat pans
        [0, 0.64, -0.245, 1.86, 0.4, 0.04, SEAT_BLUE], // backs
      ],
      // The solid arm plates fill the side silhouette between beam and pads,
      // so box A holds seats + arms and box B the backs.
      proxies: [
        [-0.95, 0.95, -0.215, 0.23, 0.32, 0.655],
        [-0.95, 0.95, -0.26, -0.2, 0.495, 0.83],
      ],
    },
    {
      id: PROP_FIDS,
      key: 'PROP_FIDS',
      kind: 'fids',
      name: 'departures screen stand',
      cls: 'B',
      dims: [1.3, 0.45],
      height: 2.05,
      boxes: [
        [0, 0.28, 0, 0.84, 0.56, 0.34, LIVERY_GREY], // ballast plinth
        [0, 0.58, 0, 0.6, 0.05, 0.1, 'keyDark'], // collar
        [0, 1.32, 0, 1.3, 1.44, 0.13, LIVERY_GREY], // housing
        [0, 1.985, 0.069, 1.2, 0.05, 0.008, AIRLINE_BLUE], // header strip
        [0, 1.625, 0.071, 1.16, 0.58, 0.012, BOARD_LIT], // upper board
        [0, 0.955, 0.071, 1.16, 0.58, 0.012, BOARD_LIT], // lower board
      ],
      proxies: [
        [-0.65, 0.65, -0.07, 0.07, 0.6, 2.04],
        [-0.42, 0.42, -0.17, 0.17, 0, 0.6],
      ],
    },
  ],
}
