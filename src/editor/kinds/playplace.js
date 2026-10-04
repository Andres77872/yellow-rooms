import {
  FINITE_CTX_PLAYPLACE,
  PLAY_THEMES,
  RED_PIT_TINT,
  buildPlayplaceTile,
} from '../../world/families/playplace/tile.js'

// 10 Playplace (docs/liminal_maps/10-playplace.md): the kind lab's wrapper.
// The kind body is src/world/families/playplace/tile.js (spec §3.3, §10),
// the playplace family's tile program; in the kind lab it draws one
// procedural sample module of the family's grammar (geometry.js kindLayout:
// the seed picks the halls, crawl block, corridors and rooms; always one
// three-storey hall, no seams).
//
// The hall themes' tints (PLAY_THEMES) and RED_PIT_TINT (0xff8c80) live in
// tile.js; the family record's lampTint stays null (no single dominant tint).
export { PLAY_THEMES, RED_PIT_TINT }

export default {
  id: 'playplace',
  label: 'playplace',
  family: 'office',
  floors: 3,
  palette: 'playCarpet',
  build: (map, seed) => buildPlayplaceTile(map, seed, FINITE_CTX_PLAYPLACE),
}
