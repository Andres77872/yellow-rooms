import { isShaftChunk } from './geometry.js'

// The stairwell structure planner (spec §7.2, §12.1). The family's only
// cross-storey structures are its stair descriptors: two enclosed switchback
// shafts per district, stamped storey by storey through kit.stairwell with
// global flight parity, unbounded in Y. There are no catalog volumes, so
// structuresInTile is empty and structureAt null; verticalOpeningAt (the
// streaming hint) is true on every shaft chunk, which holds a flight up on
// every storey.
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
  verticalOpeningAt(worldSeed, cx, cz) {
    return isShaftChunk(worldSeed >>> 0, cx, cz)
  },
})
