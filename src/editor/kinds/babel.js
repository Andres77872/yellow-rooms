import { BABEL_LATTICE, FINITE_CTX_BABEL, buildBabelTile } from '../../world/families/babel/tile.js'

// Library of Babel (docs/liminal_maps/06-library-of-babel.md): the kind lab's
// wrapper. The kind body moved to src/world/families/babel/tile.js (spec
// §3.3, §10), the babel family's tile program; the finite ctx reproduces this
// kind's map byte for byte (scripts/kinds-digest.mjs --check). The Crimson
// Hexagon's lamp colour is CRIMSON = 0xff3030 (geometry.js); the family
// record's lampTint stays null (the library's light is untinted).
export { BABEL_LATTICE }

export default {
  id: 'babel',
  label: 'library of Babel',
  family: 'hotel',
  floors: 5,
  palette: 'babelLibrary',
  build: (map, seed) => buildBabelTile(map, seed, FINITE_CTX_BABEL),
}
