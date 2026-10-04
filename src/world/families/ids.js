// The 12 liminal map-family ids. This module has no imports on purpose: the
// registry, the records and the generation framework all read the ids from
// here, and mapTypes.js keeps only the 5 legacy building families.
//
// LIMINAL_FAMILY_IDS is append-only. Its order is the order these families
// take after the legacy 5 in MAP_FAMILY_ORDER, so it fixes their codes
// (stairwell = 5 ... funhouse = 16). Never reorder or remove an entry.
export const MAP_FAMILY_STAIRWELL = 'stairwell'
export const MAP_FAMILY_NIGHTLOT = 'nightlot'
export const MAP_FAMILY_SHOWROOM = 'showroom'
export const MAP_FAMILY_POOLROOMS = 'poolrooms'
export const MAP_FAMILY_BABEL = 'babel'
export const MAP_FAMILY_SUBURB = 'suburb'
export const MAP_FAMILY_TERMINAL = 'terminal'
export const MAP_FAMILY_THEATER = 'theater'
export const MAP_FAMILY_PLAYPLACE = 'playplace'
export const MAP_FAMILY_TRAIN = 'train'
export const MAP_FAMILY_HOUSE = 'house'
export const MAP_FAMILY_FUNHOUSE = 'funhouse'

export const LIMINAL_FAMILY_IDS = Object.freeze([
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
])
