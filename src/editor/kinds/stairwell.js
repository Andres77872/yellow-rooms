import { FINITE_CTX_STAIRWELL, buildStairwellTile } from '../../world/families/stairwell/tile.js'

// 04 Endless Stairwell (docs/liminal_maps/04-endless-stairwell.md, §13 step
// 1): two enclosed switchback shafts, 16 storeys each, a few chunks apart,
// fire-door fragments in runs, three transfer corridors, lying level plates.
//
// The kind body lives in the world (src/world/families/stairwell/tile.js,
// spec §10): the editor runs it with the finite ctx (row 0, 16 storeys, the
// kind's own rungs and numbering) and shows a procedural sample: the fragment
// floors off each landing are grown from the same parts grammar the world
// uses (src/world/families/stairwell/fragments.js), so the digest follows the
// grammar, not a fixed drawing. The world bakes whole district storeys from
// that grammar as the endless family.

const FLOORS = 16

export default {
  id: 'stairwell',
  label: 'endless stairwell',
  family: 'tower',
  floors: FLOORS,
  palette: 'stairwellConcrete',
  floorPockets: true,
  build: (map, seed) => buildStairwellTile(map, seed, FINITE_CTX_STAIRWELL),
}
