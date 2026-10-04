import { MAP_FAMILY_SHOWROOM } from '../ids.js'
import { MAP_FAMILY_TOWER } from '../../mapTypes.js'

// Registry record for the showroom family (spec §4.1 schema, §4.3 values).
// Identity data only: this file may import ../ids.js and ../../mapTypes.js
// and nothing else. `profile.enabled` stays false until the release phase.
//
// audio (§4.3, §9.4): the showroom's own rows, built only from the existing
// one-shot kinds. A day-lit superstore (doc §8 "sound"): a short, dry,
// bright room (soft furnishings everywhere), a strong HVAC hum, a brighter
// major muzak pad, rack creaks for the one-shot (the warehouse at night),
// and a loud, dry PA for the announcements.
export default Object.freeze({
  id: MAP_FAMILY_SHOWROOM,
  base: MAP_FAMILY_TOWER,
  dressing: 'office',
  displayName: 'SHOWROOM',
  note: 'furnished vignettes · a way out that loops · checkout below',
  group: 'liminal',
  paletteId: 'showroomWhite',
  step: Object.freeze({}),
  propPacks: Object.freeze(['showroom', 'street']),
  lampTint: 0xffd6a0, // WARM (src/world/families/showroom/tile.js, re-exported by the editor kind)
  audio: Object.freeze({
    space: Object.freeze({
      decay: 0.9,
      wet: 0.1,
      tone: 4600,
      damp: 0.62,
      hum: 0.95,
      oneShot: 'creak',
      interval: Object.freeze([22, 48]),
      bed: Object.freeze({
        rumble: 0.045,
        rumbleLP: 180,
        air: 0.028,
        airF: 1700,
        wind: 0,
        water: 0,
      }),
      pad: Object.freeze({
        freqs: Object.freeze([261.63, 329.63, 392]),
        gain: 0.016,
        lp: 1500,
      }),
    }),
    pa: Object.freeze({
      level: 0.95,
      lp: 3600,
      send: 0.4,
    }),
  }),
  threats: null,
  massFastPath: true,
  profile: Object.freeze({ enabled: false }),
  traits: Object.freeze({
    buildingMatrices: false,
    multiStorey: true,
    outdoor: false,
    structures: 'stairs',
    lethal: false,
    floorPockets: false,
  }),
})
