import {
  MAP_FAMILY_STAIRWELL,
  MAP_FAMILY_NIGHTLOT,
  MAP_FAMILY_SHOWROOM,
  MAP_FAMILY_POOLROOMS,
  MAP_FAMILY_BABEL,
  MAP_FAMILY_SUBURB,
  MAP_FAMILY_TERMINAL,
  MAP_FAMILY_THEATER,
  MAP_FAMILY_PLAYPLACE,
  MAP_FAMILY_TRAIN,
  MAP_FAMILY_HOUSE,
  MAP_FAMILY_FUNHOUSE,
} from './ids.js'
import stairwell from './stairwell/structures.js'
import nightlot from './nightlot/structures.js'
import showroom from './showroom/structures.js'
import poolrooms from './poolrooms/structures.js'
import babel from './babel/structures.js'
import suburb from './suburb/structures.js'
import terminal from './terminal/structures.js'
import theater from './theater/structures.js'
import playplace from './playplace/structures.js'
import train from './train/structures.js'
import house from './house/structures.js'
import funhouse from './funhouse/structures.js'

// Registration list of the liminal structure planners (spec §3.1, §7.2).
//
// Planner-chain module (§7.5): contract.js imports it, so it may import only
// families/ids.js, the 12 <id>/structures.js and the shared allowlist —
// never generators.js, hooks.js, records.js, registry.js, the tile canvas or
// anything that reaches ChunkData or generate.js.
const PLANNERS = Object.freeze({
  [MAP_FAMILY_STAIRWELL]: stairwell,
  [MAP_FAMILY_NIGHTLOT]: nightlot,
  [MAP_FAMILY_SHOWROOM]: showroom,
  [MAP_FAMILY_POOLROOMS]: poolrooms,
  [MAP_FAMILY_BABEL]: babel,
  [MAP_FAMILY_SUBURB]: suburb,
  [MAP_FAMILY_TERMINAL]: terminal,
  [MAP_FAMILY_THEATER]: theater,
  [MAP_FAMILY_PLAYPLACE]: playplace,
  [MAP_FAMILY_TRAIN]: train,
  [MAP_FAMILY_HOUSE]: house,
  [MAP_FAMILY_FUNHOUSE]: funhouse,
})

// The family's planner ({ structuresInTile, structureAt, verticalOpeningAt }),
// or null for the legacy 5 and unknown ids (including inherited Object keys).
export function familyPlanner(id) {
  return typeof id === 'string' && Object.hasOwn(PLANNERS, id) ? PLANNERS[id] : null
}
