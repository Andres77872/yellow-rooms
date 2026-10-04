import { MAP_FAMILY_STAIRWELL } from '../ids.js'
import { MAP_FAMILY_TOWER } from '../../mapTypes.js'

// Registry record for the stairwell family (spec §4.1 schema, §4.3 values).
// Identity data only: this file may import ../ids.js and ../../mapTypes.js
// and nothing else. `profile.enabled` stays false until the release phase.
//
// audio (§4.3, §9.4) is the family's own: the "well" of doc §8, a long,
// bright, metallic decay (sound carries the height of the shaft), little
// floor rumble, a thin draught up the well, a low open-fifth pad, and a
// distant door creak as the texture one-shot (fire doors are the loudest
// regular sound in the map). The PA sits far down the well (more send,
// darker). Only the existing one-shot kinds are used.
export default Object.freeze({
  id: MAP_FAMILY_STAIRWELL,
  base: MAP_FAMILY_TOWER,
  dressing: 'office',
  displayName: 'STAIRWELL',
  note: 'endless switchbacks · landing fragments · lying floor numbers',
  group: 'liminal',
  paletteId: 'stairwellConcrete',
  step: Object.freeze({
    polished: 'concrete',
  }),
  propPacks: Object.freeze(['stairwell', 'street', 'showroom']),
  lampTint: null, // untinted (§4.3): src/editor/kinds/stairwell.js has no tint constant
  audio: Object.freeze({
    space: Object.freeze({
      decay: 2.6,
      wet: 0.27,
      tone: 2800,
      damp: 0.35,
      hum: 0.45,
      oneShot: 'creak',
      interval: Object.freeze([16, 40]),
      bed: Object.freeze({
        rumble: 0.045,
        rumbleLP: 180,
        air: 0.022,
        airF: 1100,
        wind: 0.04,
        water: 0,
      }),
      pad: Object.freeze({
        freqs: Object.freeze([98, 146.83, 220]),
        gain: 0.011,
        lp: 620,
      }),
    }),
    pa: Object.freeze({
      level: 0.6,
      lp: 1900,
      send: 0.85,
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
    floorPockets: true,
  }),
})
