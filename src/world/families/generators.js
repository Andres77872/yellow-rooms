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
import stairwell from './stairwell/generator.js'
import nightlot from './nightlot/generator.js'
import showroom from './showroom/generator.js'
import poolrooms from './poolrooms/generator.js'
import babel from './babel/generator.js'
import suburb from './suburb/generator.js'
import terminal from './terminal/generator.js'
import theater from './theater/generator.js'
import playplace from './playplace/generator.js'
import train from './train/generator.js'
import house from './house/generator.js'
import funhouse from './funhouse/generator.js'

// Registration list of the liminal tile generators (spec §3.1, §6.5).
// buildChunk branches on familyGenerator(profile.family): null for the legacy
// 5, so legacy builds never take the new path (I1).
const GENERATORS = Object.freeze({
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

// The family's generator, or null for the legacy 5 and unknown ids.
export function familyGenerator(id) {
  return typeof id === 'string' && Object.hasOwn(GENERATORS, id) ? GENERATORS[id] : null
}
