import { BULB, FINITE_CTX_FUNHOUSE, FUNHOUSE_LIES, buildFunhouseTile } from '../../world/families/funhouse/tile.js'

// 12 Funhouse (docs/liminal_maps/12-funhouse.md): the kind lab's wrapper.
// The kind body is src/world/families/funhouse/tile.js (spec §3.3, §10),
// the funhouse family's tile program: a seeded grammar that composes each
// pavilion from a catalogue of parts. The finite ctx shows one procedural
// sample, pavilion 0 of the seed's chain, sealed at the midway's east end
// (its map changed with the grammar: scripts/kinds-digest.mjs --check lists
// funhouse as changed).
//
// BULB is 0xffb060, the family record's lampTint (registry.drift reads the
// tint constants of this file and of the tile program).
export { BULB, FUNHOUSE_LIES }

export default {
  id: 'funhouse',
  label: 'funhouse',
  family: 'tower',
  floors: 2,
  palette: 'funhouseNeon',
  build: (map, seed) => buildFunhouseTile(map, seed, FINITE_CTX_FUNHOUSE),
}
