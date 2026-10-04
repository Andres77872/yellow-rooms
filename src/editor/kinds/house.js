import { FINITE_CTX_HOUSE, HOUSE_LAYOUT, RED, WARM, buildHouseTile } from '../../world/families/house/tile.js'

// 05 House Larger Inside (docs/liminal_maps/05-house-larger-inside.md): the
// kind lab's wrapper. The kind body moved to src/world/families/house/tile.js
// (spec §3.3, §10), the house family's tile program; the finite ctx
// reproduces this kind's map byte for byte (scripts/kinds-digest.mjs --check).
//
// WARM is 0xffd2a0, the family record's lampTint (registry.drift reads this
// file's and tile.js's tint constants); RED is P.T.'s red hallway.
export { HOUSE_LAYOUT, RED, WARM }

export default {
  id: 'house',
  label: 'house larger inside',
  family: 'hotel',
  floors: 3,
  palette: 'houseFaded',
  build: (map, seed) => buildHouseTile(map, seed, FINITE_CTX_HOUSE),
}
