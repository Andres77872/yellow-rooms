import {
  SUBURB_MODELS,
  TINT_STREET,
  buildSuburbPrototype,
  houseCell,
  suburbLayout,
  suburbModelSharing,
  suburbStreetGraph,
} from '../../world/families/suburb/prototype.js'

// Sleeping suburb (docs/liminal_maps/03-sleeping-suburb.md): the kind lab's
// wrapper. The kind body lives in src/world/families/suburb/prototype.js,
// the finite prototype the suburb family keeps as its parts catalogue (house
// models, room stamping, twin furnishing, tints); the world's tiles are
// composed by the family's own street grammar (geometry.js suburbPlan,
// tile.js), never by repeating this map. The kind's map is byte-identical
// to the original prototype's (scripts/kinds-digest.mjs --check).
//
// TINT_STREET is 0xffc27a, the family record's lampTint (registry.drift reads
// this file's and tile.js's tint constants).
export { SUBURB_MODELS, TINT_STREET, houseCell, suburbLayout, suburbModelSharing, suburbStreetGraph }

export default {
  id: 'suburb',
  label: 'sleeping suburb',
  family: 'hotel',
  floors: 1,
  palette: 'suburbNight',
  build: (map, seed) => buildSuburbPrototype(map, seed),
}
