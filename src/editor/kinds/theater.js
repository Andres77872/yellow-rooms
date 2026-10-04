import { BULB, FINITE_CTX_THEATER, MIRROR, WORK, buildTheaterTile } from '../../world/families/theater/tile.js'

// 11 — The Empty Theater (docs/liminal_maps/11-empty-theater.md): the kind
// lab's wrapper. The kind body is src/world/families/theater/tile.js (spec
// §3.3, §10), the theater family's tile program; with the finite ctx it draws
// a procedural sample theatre of the seed (geometry.finiteScheme: the same
// grammar the world rolls per tile, always five storeys) on 3×3 chunks.
//
// The tints live in layout.js (re-exported by tile.js): BULB 0xffe2b4 (the
// ghost light), WORK 0xa8bcff (backstage work lights, the family record's
// lampTint) and MIRROR 0xffd8a4 (dressing-room mirror bulbs).
export { BULB, MIRROR, WORK }

export default {
  id: 'theater',
  label: 'empty theater',
  family: 'hotel',
  floors: 5,
  palette: 'theaterDamask',
  build: (map, seed) => buildTheaterTile(map, seed, FINITE_CTX_THEATER),
}
