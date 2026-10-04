import { FINITE_CTX_TRAIN, STATIONS, TRAIN_TINT } from '../../world/families/train/tile.js'
import { buildTrainKind } from '../../world/families/train/kind.js'

// 07 — The Endless Train (docs/liminal_maps/07-endless-train.md, §13 step
// 1): the kind lab's wrapper. The kind body is
// src/world/families/train/kind.js, the train family's parts catalogue; the
// finite ctx reproduces this kind's map byte for byte (seven cars and two
// cabs, one station: scripts/kinds-digest.mjs --check). The world does not
// repeat this map: its grammar (src/world/families/train/world.js) composes
// every tile from these parts around a pure skeleton of its own.
//
// TRAIN_TINT is the family record's lampTint (registry.drift reads this
// file's and tile.js's tint constants). STATIONS is the station-name table
// (kind-train.test.js checks its glyphs).
export { STATIONS, TRAIN_TINT }

export default {
  id: 'train',
  label: 'endless train',
  family: 'tower',
  floors: 2,
  palette: 'metroTile',
  build: (map, seed) => buildTrainKind(map, seed, FINITE_CTX_TRAIN),
}
