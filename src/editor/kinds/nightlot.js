import { FINITE_CTX_NIGHTLOT, MERCURY, SODIUM, buildNightLotTile } from '../../world/families/nightlot/tile.js'

// 02 Night Lot (docs/liminal_maps/02-night-lot.md): the kind lab's wrapper.
// The kind body is the nightlot family's tile program
// (src/world/families/nightlot/tile.js, spec §3.3, §10), a grammar: each kind
// seed draws ONE procedurally generated district (4×4 chunks) — the seed's
// exit district, so the sample holds the kiosk and its basement exit — with
// its roads, lots, buildings, garage, booths and anomaly all from the seed,
// over the family's three storeys (the undercroft, the lot, the upper storey
// of roof decks and upper floors), its seams closed. The upper storey is a
// set of separate buildings, each reached by its own stair (floorPockets).
//
// SODIUM (0xffb050) is the family record's lampTint; MERCURY (0xd8f0ff) the
// cold retrofit (registry.drift reads the tint constants of tile.js).
export { MERCURY, SODIUM }

export default {
  id: 'nightlot',
  label: 'night parking lot',
  family: 'lattice',
  floors: 3,
  palette: 'nightLot',
  floorPockets: true,
  build: (map, seed) => buildNightLotTile(map, seed, FINITE_CTX_NIGHTLOT),
}
