// Showroom pack (map 09, infinite showroom). Pure data, no imports: the
// record format is documented in ../index.js.

export const PROP_BAG_BIN = 36
export const PROP_FLATPACK = 37

const BAG_YELLOW = [0.95, 0.68, 0.04]
const BIN_GREY = [0.2, 0.22, 0.25]
const CARDBOARD = [0.74, 0.57, 0.35]

export default {
  pack: 'showroom',
  // Materials scripts/blender/packs/showroom.py introduces: [roughness, metalness].
  surfaces: {
    yr_bagYellow: [0.5, 0], // carrier-bag polythene
    yr_returnBin: [0.6, 0], // moulded tub
    yr_flatpackCard: [0.88, 0], // corrugated board
  },
  kinds: [
    {
      id: PROP_BAG_BIN,
      key: 'PROP_BAG_BIN',
      kind: 'bag_bin',
      name: 'yellow bag bin',
      cls: 'B',
      dims: [0.7, 0.5],
      height: 0.9,
      boxes: [
        [0, 0.06, 0, 0.52, 0.12, 0.34, 'keyDark'], // casters
        [0, 0.39, 0, 0.62, 0.54, 0.42, BIN_GREY], // tapered tub
        [0, 0.685, 0, 0.7, 0.04, 0.5, BIN_GREY], // rim
        [0, 0.75, 0, 0.64, 0.14, 0.44, BAG_YELLOW], // bag heap
        [-0.02, 0.84, -0.04, 0.36, 0.06, 0.26, BAG_YELLOW], // crown of the heap
        [0.02, 0.69, 0.22, 0.28, 0.1, 0.16, BAG_YELLOW], // bag slumped over the rim
      ],
      // Tub (lifted off the caster gap) + the heap above the rim.
      proxies: [
        [-0.35, 0.35, -0.25, 0.25, 0.1, 0.71],
        [-0.32, 0.32, -0.23, 0.23, 0.71, 0.83],
      ],
    },
    {
      id: PROP_FLATPACK,
      key: 'PROP_FLATPACK',
      kind: 'flatpack',
      name: 'flat-pack box stack',
      cls: 'B',
      dims: [1.2, 0.8],
      height: 0.6,
      boxes: [
        [0, 0.072, 0, 1.2, 0.144, 0.8, 'shelfWood'], // pallet
        [0, 0.204, 0, 1.16, 0.12, 0.76, 'bookTan'], // bottom box
        [0.005, 0.309, 0, 1.1, 0.09, 0.75, CARDBOARD], // side-by-side pair
        [-0.02, 0.409, 0.01, 1.1, 0.11, 0.72, CARDBOARD], // top of the strapped unit
        [-0.08, 0.5015, -0.06, 0.92, 0.075, 0.52, 'bookTan'], // loose box
        [0.02, 0.569, -0.02, 0.56, 0.06, 0.42, CARDBOARD], // small loose box
      ],
      // Pallet + strapped unit, then the loose boxes on top.
      proxies: [
        [-0.6, 0.6, -0.4, 0.4, 0, 0.464],
        [-0.54, 0.48, -0.32, 0.3, 0.464, 0.6],
      ],
    },
  ],
}
