import { LEGACY_RECORDS } from './legacy.js'
import stairwell from './stairwell/record.js'
import nightlot from './nightlot/record.js'
import showroom from './showroom/record.js'
import poolrooms from './poolrooms/record.js'
import babel from './babel/record.js'
import suburb from './suburb/record.js'
import terminal from './terminal/record.js'
import theater from './theater/record.js'
import playplace from './playplace/record.js'
import train from './train/record.js'
import house from './house/record.js'
import funhouse from './funhouse/record.js'

// Registration list: every family record, keyed by id. Data only (spec §4.4):
// this module imports the records and nothing else, so config.js may import
// it for LIMINAL_PROFILES without a cycle.
//
// Key order is MAP_FAMILY_ORDER order: the legacy 5 (office, sewer, tower,
// lattice, hotel), then the 12 liminal families in LIMINAL_FAMILY_IDS order.
// familiesWith() relies on it.
export const FAMILY_RECORDS = Object.freeze({
  ...LEGACY_RECORDS,
  [stairwell.id]: stairwell,
  [nightlot.id]: nightlot,
  [showroom.id]: showroom,
  [poolrooms.id]: poolrooms,
  [babel.id]: babel,
  [suburb.id]: suburb,
  [terminal.id]: terminal,
  [theater.id]: theater,
  [playplace.id]: playplace,
  [train.id]: train,
  [house.id]: house,
  [funhouse.id]: funhouse,
})

const LIMINAL_RECORDS = Object.values(FAMILY_RECORDS).filter((r) => r.group === 'liminal')

// The liminal activation profiles, in LIMINAL_FAMILY_IDS order. Each record
// owns its `profile` ({enabled}); the release flip edits the record. Legacy
// profiles stay literal in config.js. liminalProfiles() returns fresh mutable
// copies, for configs that are later edited in place (DEFAULT_WORLD_CONFIG).
export const LIMINAL_PROFILES = Object.freeze(Object.fromEntries(
  LIMINAL_RECORDS.map((r) => [r.id, Object.freeze({ enabled: r.profile.enabled })])
))

export function liminalProfiles() {
  return Object.fromEntries(LIMINAL_RECORDS.map((r) => [r.id, { enabled: r.profile.enabled }]))
}
