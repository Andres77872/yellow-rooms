import { MAP_FAMILY_BABEL } from '../ids.js'
import { MAP_FAMILY_HOTEL } from '../../mapTypes.js'

// Registry record for the babel family (spec §4.1 schema, §4.3 values).
// Identity data only: this file may import ../ids.js and ../../mapTypes.js
// and nothing else. `profile.enabled` stays false until the release phase.
//
// audio (Phase B): the library's own rows, built only from the existing
// one-shot kinds. A quiet, book-damped room (high damp, dull tone, a low
// lamp hum) whose shafts carry sound between storeys as long, faint tails
// (a longer decay than any hotel corridor); the shelves creak now and then.
// The PA is far and muffled, as if heard from another storey.
export default Object.freeze({
  id: MAP_FAMILY_BABEL,
  base: MAP_FAMILY_HOTEL,
  dressing: 'office',
  displayName: 'LIBRARY',
  note: 'hexagonal reading rooms · shafts of shelves · one crimson room',
  group: 'liminal',
  paletteId: 'babelLibrary',
  step: Object.freeze({}),
  propPacks: Object.freeze(['babel']),
  lampTint: null, // untinted: CRIMSON (families/babel/geometry.js) is the Crimson Hexagon only
  audio: Object.freeze({
    space: Object.freeze({
      decay: 1.9,
      wet: 0.2,
      tone: 1700,
      damp: 0.9,
      hum: 0.35,
      oneShot: 'creak',
      interval: Object.freeze([22, 48]),
      bed: Object.freeze({
        rumble: 0.04,
        rumbleLP: 140,
        air: 0.03,
        airF: 620,
        wind: 0,
        water: 0,
      }),
      pad: Object.freeze({
        freqs: Object.freeze([87.31, 130.81, 196]),
        gain: 0.014,
        lp: 380,
      }),
    }),
    pa: Object.freeze({
      level: 0.7,
      lp: 2200,
      send: 0.7,
    }),
  }),
  threats: null,
  massFastPath: true,
  profile: Object.freeze({ enabled: false }),
  traits: Object.freeze({
    buildingMatrices: false,
    multiStorey: true,
    outdoor: false,
    structures: 'stairs+catalog',
    lethal: false,
    floorPockets: false,
  }),
})
