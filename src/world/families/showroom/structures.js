import { DOWN, isStairChunk } from './geometry.js'

// The showroom structure planner (spec §7.2, §12.3). The family's only
// cross-storey structures are its stair descriptors: stairs A and B, two
// enclosed switchback cores per district from the hall storey (cy −1) to the
// route (cy 0), stamped through kit.stairwell where the district's macro plan
// (geometry.districtPlan) puts them — in two of the tile's four chunks. There
// are no catalog volumes, so structuresInTile is empty and structureAt null;
// verticalOpeningAt (the streaming hint) is true on the cores' chunks at the
// hall storey, which hold the flights up.
//
// Planner-chain module (§7.5): it imports only its own geometry.js.
const EMPTY = Object.freeze([])
const HALL_CY = DOWN - 1

export default Object.freeze({
  stub: false,
  structuresInTile() {
    return EMPTY
  },
  structureAt() {
    return null
  },
  verticalOpeningAt(worldSeed, cx, cz, lowerCy) {
    return lowerCy === HALL_CY && isStairChunk(worldSeed, cx, cz)
  },
})
