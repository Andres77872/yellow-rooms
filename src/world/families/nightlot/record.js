import { MAP_FAMILY_NIGHTLOT } from '../ids.js'
import { MAP_FAMILY_LATTICE } from '../../mapTypes.js'

// Registry record for the nightlot family (spec §4.1 schema, §4.3 values).
// Identity data only: this file may import ../ids.js and ../../mapTypes.js
// and nothing else. `profile.enabled` stays false until the release phase.
//
// audio (§4.3, §9.4): the night lot's own rows, built only from the existing
// one-shot kinds. The doc's `exterior` acoustic class (§8): next to no reverb
// (a short, dry, dark tail: open air, nothing to reflect from), a steady wind
// bed with a distant-highway rumble instead of a room tone, a faint sodium
// buzz for the hum, wind gusts for the one-shot, a low open fifth for the
// pad; the PA is far off and barely wet.
export default Object.freeze({
  id: MAP_FAMILY_NIGHTLOT,
  base: MAP_FAMILY_LATTICE,
  dressing: 'none',
  displayName: 'NIGHT LOT',
  note: 'lamp islands · dead circuits · a lit kiosk somewhere',
  group: 'liminal',
  paletteId: 'nightLot',
  step: Object.freeze({}),
  propPacks: Object.freeze(['street']),
  lampTint: 0xffb050, // SODIUM (src/world/families/nightlot/tile.js, re-exported by the editor kind)
  audio: Object.freeze({
    space: Object.freeze({
      decay: 0.6,
      wet: 0.04,
      tone: 1600,
      damp: 0.7,
      hum: 0.25,
      oneShot: 'wind',
      interval: Object.freeze([9, 26]),
      bed: Object.freeze({
        rumble: 0.07,
        rumbleLP: 120,
        air: 0.026,
        airF: 700,
        wind: 0.07,
        water: 0,
      }),
      pad: Object.freeze({
        freqs: Object.freeze([73.42, 110, 164.81]),
        gain: 0.01,
        lp: 420,
      }),
    }),
    pa: Object.freeze({
      level: 0.4,
      lp: 1400,
      send: 0.25,
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
