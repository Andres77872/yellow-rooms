import { FINITE_CTX_SHOWROOM, SHOWROOM_MUTATIONS, WARM, buildShowroomTile } from '../../world/families/showroom/tile.js'

// 09 Infinite Showroom (docs/liminal_maps/09-infinite-showroom.md): the kind
// lab's wrapper. The kind body moved to src/world/families/showroom/tile.js
// (spec §3.3, §10), the showroom family's tile program; the finite ctx
// (checkout bank at the west side, no seams) reproduces this kind's map byte
// for byte (scripts/kinds-digest.mjs --check).
//
// WARM is 0xffd6a0, the family record's lampTint (registry.drift reads this
// file's and tile.js's tint constants).
export { SHOWROOM_MUTATIONS, WARM }

export default {
  id: 'showroom',
  label: 'infinite showroom',
  family: 'tower',
  floors: 2,
  palette: 'showroomWhite',
  build: (map, seed) => buildShowroomTile(map, seed, FINITE_CTX_SHOWROOM),
}
