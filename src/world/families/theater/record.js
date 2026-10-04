import { MAP_FAMILY_THEATER } from '../ids.js'
import { MAP_FAMILY_HOTEL } from '../../mapTypes.js'

// Registry record for the theater family (spec §4.1 schema, §4.3 values).
// Identity data only: this file may import ../ids.js and ../../mapTypes.js
// and nothing else. `profile.enabled` stays false until the release phase.
//
// audio (§4.3, §9.4): the theater's own rows, from the existing one-shot
// kinds only. Doc 11 §7-§8: the house is a long, dark, reverberant hall
// (opera RT 1.3-1.8 s) that carries every footstep; the fly tower creaks and
// its ropes tap; backstage is dry and close. So: a long dark tail with a
// strong send, a low hum (the ghost light's single bulb), sparse creaks, a
// low air bed and a minor pad; the PA sits far back in the house.
export default Object.freeze({
  id: MAP_FAMILY_THEATER,
  base: MAP_FAMILY_HOTEL,
  dressing: 'office',
  displayName: 'THEATER',
  note: 'empty stalls · backstage that never ends · the trap room',
  group: 'liminal',
  paletteId: 'theaterDamask',
  step: Object.freeze({}),
  propPacks: Object.freeze(['theater']),
  lampTint: 0xa8bcff, // WORK (src/world/families/theater/tile.js, re-exported by the editor kind)
  audio: Object.freeze({
    space: Object.freeze({
      decay: 1.7,
      wet: 0.24,
      tone: 1700,
      damp: 0.6,
      hum: 0.3,
      oneShot: 'creak',
      interval: Object.freeze([11, 28]),
      bed: Object.freeze({
        rumble: 0.06,
        rumbleLP: 150,
        air: 0.016,
        airF: 620,
        wind: 0,
        water: 0,
      }),
      pad: Object.freeze({
        freqs: Object.freeze([110, 130.81, 164.81]),
        gain: 0.011,
        lp: 380,
      }),
    }),
    pa: Object.freeze({
      level: 0.8,
      lp: 2600,
      send: 0.75,
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
