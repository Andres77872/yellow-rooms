import { stairChunk } from './geometry.js'

// The train structure planner (spec §7.2, §12.10). The family's only
// cross-storey structures are its stair descriptors: the enclosed stair
// cores of every tile (a station's 1–3 behind its platform, a plain tile's
// 1–2 service stairs), storey 0 → 1, stamped through kit.stairwell by the
// bake at the skeleton's pure positions (geometry.js). There are no catalog
// volumes, so structuresInTile is empty and structureAt null;
// verticalOpeningAt (the streaming hint) is true on the chunks holding a
// core at storey 0.
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
    return stairChunk(worldSeed >>> 0, cx, cz, lowerCy)
  },
})
