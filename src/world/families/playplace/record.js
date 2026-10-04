import { MAP_FAMILY_PLAYPLACE } from '../ids.js'
import { MAP_FAMILY_OFFICE } from '../../mapTypes.js'

// Registry record for the playplace family (spec §4.1 schema, §4.3 values).
// Identity data only: this file may import ../ids.js and ../../mapTypes.js
// and nothing else. `profile.enabled` stays false until the release phase.
//
// audio (§4.3, §9.4): the playplace's own rows, built only from the existing
// one-shot kinds. Padded halls are the doc's `dead` acoustic class (§8:
// almost no reverb, short falloff, poor localisation): a very short, dark,
// dry tail and heavy damping; a ventilation hum and a low rumble bed; the
// knock of plastic tubes as the one-shot (creak); a slow, cheerful major
// triad for the party song played slow; the PA close and dry.
//
// lampTint stays null (§4.3): the halls are tinted per theme (PLAY_THEMES in
// src/world/families/playplace/tile.js: jungle, space, ocean), so no single
// tint dominates.
export default Object.freeze({
  id: MAP_FAMILY_PLAYPLACE,
  base: MAP_FAMILY_OFFICE,
  dressing: 'office',
  displayName: 'PLAYPLACE',
  note: 'soft play · tube grids · nobody collecting',
  group: 'liminal',
  paletteId: 'playCarpet',
  step: Object.freeze({}),
  propPacks: Object.freeze(['playplace', 'street']),
  lampTint: null, // per-hall theme tints (PLAY_THEMES, families/playplace/tile.js); no single dominant one
  audio: Object.freeze({
    space: Object.freeze({
      decay: 0.25,
      wet: 0.02,
      tone: 1800,
      damp: 0.92,
      hum: 0.7,
      oneShot: 'creak',
      interval: Object.freeze([9, 24]),
      bed: Object.freeze({
        rumble: 0.08,
        rumbleLP: 180,
        air: 0.05,
        airF: 900,
        wind: 0,
        water: 0,
      }),
      pad: Object.freeze({
        freqs: Object.freeze([130.81, 164.81, 196]),
        gain: 0.014,
        lp: 700,
      }),
    }),
    pa: Object.freeze({
      level: 0.9,
      lp: 2800,
      send: 0.15,
    }),
  }),
  threats: null,
  massFastPath: true,
  profile: Object.freeze({ enabled: false }),
  traits: Object.freeze({
    buildingMatrices: false,
    multiStorey: true,
    outdoor: false,
    structures: 'catalog',
    lethal: false,
    floorPockets: false,
  }),
})
