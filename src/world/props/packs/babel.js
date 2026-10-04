// Babel pack (map 06, library of Babel). Pure data, no imports: the record
// format is documented in ../index.js.

export const PROP_CORNER_SHELF = 48
export const PROP_LECTERN = 49

export default {
  pack: 'babel',
  kinds: [
    {
      // The 45-degree face runs along u + v = 0.2, from (+u, -v) to (-u, +v),
      // between two 0.2 m returns on the u = +0.575 and v = +0.575 edges: the
      // piece anchors in its back-left (-u, -v) corner and its books look
      // toward (+u, +v) at facing S (scripts/blender/packs/babel.py). The
      // fallback steps the diagonal in three runs, a band of spines on each
      // step front.
      id: PROP_CORNER_SHELF,
      key: 'PROP_CORNER_SHELF',
      kind: 'corner_shelf',
      name: 'slanted corner shelf',
      cls: 'B',
      dims: [1.15, 1.15],
      height: 1.85,
      boxes: [
        [0, 0.925, -0.4225, 1.15, 1.85, 0.305, 'shelfWood'],
        [-0.15, 0.925, -0.095, 0.85, 1.85, 0.35, 'shelfWood'],
        [-0.3575, 0.925, 0.3175, 0.435, 1.85, 0.475, 'shelfWood'],
        [0.425, 0.92, -0.26, 0.3, 1.6, 0.02, 'bookRed'], // spines
        [0.0675, 0.92, 0.09, 0.415, 1.6, 0.02, 'bookBlue'],
        [-0.2575, 0.92, 0.565, 0.235, 1.6, 0.02, 'bookTan'],
      ],
      // Two steps fitted to the cut square (top IoU ~0.86; one triangle-only
      // pair would stay under 0.82). Mirrored as occ_A / occ_B in the pack.
      proxies: [
        [-0.575, 0.55, -0.575, 0, 0, 1.85],
        [-0.575, 0, -0.575, 0.55, 0, 1.85],
      ],
    },
    {
      id: PROP_LECTERN,
      key: 'PROP_LECTERN',
      kind: 'lectern',
      name: 'reading lectern',
      cls: 'B',
      dims: [0.6, 0.5],
      height: 1.2,
      boxes: [
        [0, 0.035, 0, 0.46, 0.07, 0.38, 'woodDark'], // plinth
        [0, 0.495, 0, 0.36, 0.85, 0.28, 'shelfWood'], // panelled pedestal
        [0, 0.94, 0, 0.44, 0.04, 0.36, 'woodDark'], // cap
        [0, 1.06, 0, 0.6, 0.2, 0.5, 'woodMid'], // slanted desk (squared off)
        [0, 1.175, 0.03, 0.45, 0.03, 0.31, 'paperWhite'], // open book
      ],
      // Pedestal and desk; mirrored as occ_A / occ_B in the pack.
      proxies: [
        [-0.18, 0.18, -0.15, 0.15, 0, 0.96],
        [-0.3, 0.3, -0.25, 0.25, 0.96, 1.2],
      ],
    },
  ],
}
