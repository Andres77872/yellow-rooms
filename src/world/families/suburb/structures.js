import { isUpstairsChunk } from './geometry.js'

// The suburb structure planner (spec §7.2, §12.6). The family's cross-storey
// structures are its stair descriptors only: every tile's 1-4 two-storey
// houses (placed by the tile's street grammar, geometry.suburbPlan) climb
// from storey 0 to their attic on storey 1 through a switchback core stamped
// by kit.stairwell. There are no catalog volumes, so structuresInTile is
// empty and structureAt null; verticalOpeningAt (the streaming hint) is true
// on the slab between storeys 0 and 1 of every chunk holding such a core
// (geometry.isUpstairsChunk). A house is not a planner structure: a catalog
// volume carves its footprint and a walkable ring open on every storey,
// which would erase the house's walls and its fenced lot, so the family's
// cross-storey invariant is the stair contract instead — every core's two
// flight halves pair across the slab (the layered audit's stair pairing),
// and the family suite proves every upstairs room reachable from the street.
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
    return lowerCy === 0 && isUpstairsChunk(worldSeed >>> 0, cx, cz)
  },
})
