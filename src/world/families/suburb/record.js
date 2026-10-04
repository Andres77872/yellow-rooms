import { MAP_FAMILY_SUBURB } from '../ids.js'
import { MAP_FAMILY_HOTEL } from '../../mapTypes.js'

// Registry record for the suburb family (spec §4.1 schema, §4.3 values).
// Identity data only: this file may import ../ids.js and ../../mapTypes.js
// and nothing else. `profile.enabled` stays false until the release phase.
//
// audio (§4.3, §9.4): the suburb's own rows, built only from the existing
// one-shot kinds. Outside at 3 AM (doc §8 "exterior acoustic class: no
// reverb"): a short dry tail, a distant-highway rumble, a light wind bed and
// cool night air, a faint fridge hum instead of tube hum, the odd creak of a
// house settling for the one-shot; a far, quiet PA.
export default Object.freeze({
  id: MAP_FAMILY_SUBURB,
  base: MAP_FAMILY_HOTEL,
  dressing: 'office',
  displayName: 'SUBURB',
  note: 'sleeping streets · identical houses · one light on',
  group: 'liminal',
  paletteId: 'suburbNight',
  step: Object.freeze({}),
  propPacks: Object.freeze(['suburb', 'street']),
  lampTint: 0xffc27a, // TINT_STREET (src/world/families/suburb/tile.js, re-exported by the editor kind)
  audio: Object.freeze({
    space: Object.freeze({
      decay: 0.35,
      wet: 0.04,
      tone: 2600,
      damp: 0.6,
      hum: 0.12,
      oneShot: 'creak',
      interval: Object.freeze([9, 24]),
      bed: Object.freeze({
        rumble: 0.04,
        rumbleLP: 110,
        air: 0.03,
        airF: 950,
        wind: 0.025,
        water: 0,
      }),
      pad: Object.freeze({
        freqs: Object.freeze([87.31, 130.81, 196]),
        gain: 0.01,
        lp: 380,
      }),
    }),
    pa: Object.freeze({
      level: 0.55,
      lp: 2200,
      send: 0.18,
    }),
  }),
  threats: null,
  massFastPath: true,
  profile: Object.freeze({ enabled: false }),
  traits: Object.freeze({
    buildingMatrices: false,
    multiStorey: true,
    outdoor: true,
    structures: 'stairs',
    lethal: false,
    floorPockets: false,
  }),
})
