import { BASEMENT_CY, DECK_CY, UP_CY, coresAtChunk, isKioskChunk } from './geometry.js'

// The nightlot structure planner (spec §7.2, §12.2). Every cross-storey
// structure of the night lot is a stair descriptor (stairwellPlan cores
// stamped by the tile program through kit.stairwell), each from the
// undercroft (cy −1) up to the lot (cy 0) — the kiosk-with-basement module's
// core, the strip malls' stair halls, the lots' stair heads — or on up to the
// upper storey (cy 1): the garage's enclosed stair tower and open ramp flight
// (B1 → ground deck → roof deck), the frontage blocks' stair halls (basement
// suite → ground floor → upper floor). There are no catalog volumes, so
// structuresInTile is empty and structureAt null; verticalOpeningAt (the
// streaming hint) is true over every chunk whose storey `lowerCy` holds a
// flight up.
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
    if (lowerCy === BASEMENT_CY) return isKioskChunk(worldSeed >>> 0, cx, cz) || coresAtChunk(worldSeed >>> 0, cx, cz).length > 0
    if (lowerCy === DECK_CY) return coresAtChunk(worldSeed >>> 0, cx, cz).some((c) => c.topCy >= UP_CY)
    return false
  },
})
