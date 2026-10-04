import { MAP_FAMILY_HOUSE } from '../ids.js'
import { MAP_FAMILY_HOTEL } from '../../mapTypes.js'

// Registry record for the house family (spec §4.1 schema, §4.3 values).
// Identity data only: this file may import ../ids.js and ../../mapTypes.js
// and nothing else. `profile.enabled` stays false until the release phase.
//
// audio (§4.3, §9.4): the house's own rows, built only from the existing
// one-shot kinds. Doc §8: a domestic interior under 2.4 m ceilings — a short,
// dry, dark room tone (carpet and curtains swallow the tail), the low hum of
// a fridge somewhere behind a wall, the house settling (creaks) at long,
// irregular intervals; the PA is a radio in another room: thin, muffled,
// mostly dry.
export default Object.freeze({
  id: MAP_FAMILY_HOUSE,
  base: MAP_FAMILY_HOTEL,
  dressing: 'office',
  displayName: 'HOUSE',
  note: 'rooms behind rooms · the same hallway · a great hall',
  group: 'liminal',
  paletteId: 'houseFaded',
  step: Object.freeze({}),
  propPacks: Object.freeze(['house']),
  lampTint: 0xffd2a0, // WARM (src/world/families/house/tile.js, re-exported by the editor kind)
  audio: Object.freeze({
    space: Object.freeze({
      decay: 0.45,
      wet: 0.05,
      tone: 1600,
      damp: 0.92,
      hum: 0.35,
      oneShot: 'creak',
      interval: Object.freeze([20, 48]),
      bed: Object.freeze({
        rumble: 0.06,
        rumbleLP: 120,
        air: 0.012,
        airF: 380,
        wind: 0,
        water: 0,
      }),
      pad: Object.freeze({
        freqs: Object.freeze([87.31, 130.81, 207.65]),
        gain: 0.014,
        lp: 380,
      }),
    }),
    pa: Object.freeze({
      level: 0.7,
      lp: 2400,
      send: 0.2,
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
