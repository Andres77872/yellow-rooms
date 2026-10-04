import { FINITE_CTX_POOLROOMS, POOL_TINT, buildPoolroomsTile } from '../../world/families/poolrooms/tile.js'

// 01 Poolrooms (docs/liminal_maps/01-poolrooms.md): the kind lab's wrapper.
// The kind body is the poolrooms family's tile program
// (src/world/families/poolrooms/tile.js, spec §3.3, §10), a grammar: each kind
// seed draws ONE procedurally generated sample tile (3×3 chunks, basin / deck
// / gallery) — which pools, where, how big, and the chambers, channels,
// modules and mouths round them all come from the seed — with no seam ports
// and a natatio vault always present so the sample keeps its three storeys.
//
// POOL_TINT is the family record's lampTint; registry.drift reads it from
// the family's tile.js, so this wrapper restates no literal.
export { POOL_TINT }

export default {
  id: 'poolrooms',
  label: 'poolrooms',
  family: 'tower',
  floors: 3,
  palette: 'poolTile',
  build: (map, seed) => buildPoolroomsTile(map, seed, FINITE_CTX_POOLROOMS),
}
