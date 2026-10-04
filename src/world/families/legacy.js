import {
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
} from '../mapTypes.js'

// Registry records for the 5 legacy building families. Every value here is
// COPIED from today's behaviour, never computed, so each registry lookup
// resolves to exactly what the legacy literal sites produce:
//   base = dressing = paletteId = id   (byFamily/dressingOf are identities)
//   note: FAMILY_NOTES in src/ui/titleMenu.js, verbatim
//   displayName: id.toUpperCase(), what overlays.js prints today
//   step {}, propPacks [], lampTint/audio/threats null, massFastPath false
// There is no `profile` field: config.js stays the source of the legacy
// activation profiles. registry.legacy.test.js pins all of this.
const EMPTY = Object.freeze([])
const NO_STEP = Object.freeze({})

function legacyRecord(id, displayName, note, lethal) {
  return Object.freeze({
    id,
    base: id,
    dressing: id,
    displayName,
    note,
    group: 'buildings',
    paletteId: id,
    step: NO_STEP,
    propPacks: EMPTY,
    lampTint: null,
    audio: null,
    threats: null,
    massFastPath: false,
    traits: Object.freeze({
      buildingMatrices: true,
      multiStorey: true,
      outdoor: false,
      structures: 'catalog',
      lethal,
      floorPockets: false,
    }),
  })
}

export const LEGACY_RECORDS = Object.freeze({
  [MAP_FAMILY_OFFICE]: legacyRecord(MAP_FAMILY_OFFICE, 'OFFICE', 'room districts · empty bullpens · tall atria', false),
  [MAP_FAMILY_SEWER]: legacyRecord(MAP_FAMILY_SEWER, 'SEWER', 'dry galleries · confluences · manhole stairs', false),
  [MAP_FAMILY_TOWER]: legacyRecord(MAP_FAMILY_TOWER, 'TOWER', 'broad galleries · service cores · skybridges', true),
  [MAP_FAMILY_LATTICE]: legacyRecord(MAP_FAMILY_LATTICE, 'LATTICE', 'service alleys · catwalks · transfer plazas', true),
  [MAP_FAMILY_HOTEL]: legacyRecord(MAP_FAMILY_HOTEL, 'HOTEL', 'guest-room wings · corridor loops · atria', false),
})
