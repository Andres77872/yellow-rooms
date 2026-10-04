import { stairChunkAt } from './geometry.js'

// The funhouse structure planner (spec §7.2, §12.12). The family's only
// cross-storey structures are its stair descriptors: two enclosed stair
// cores per pavilion (stair A: maze ↔ unload walkway, stair B: maze ↔ load
// walkway), placed by the pavilion's skeleton (geometry.skeletonOf, pure in
// the seed and the pavilion) and stamped through kit.stairwell. There are
// no catalog volumes, so structuresInTile is empty and structureAt null;
// verticalOpeningAt (the streaming hint) is true on the two stair chunks of
// every pavilion over the storey-0 slab.
//
// Planner-chain module (§7.5): it imports only its own geometry.js.
const EMPTY = Object.freeze([])

export default Object.freeze({
  stub: false,
  structuresInTile() {
    return EMPTY
  },
  structureAt() {
    return null
  },
  verticalOpeningAt(worldSeed, cx, cz, lowerCy) {
    return stairChunkAt(worldSeed, cx, cz, lowerCy)
  },
})
