import { MAP_FAMILY_FUNHOUSE } from '../ids.js'
import { MAP_FAMILY_TOWER } from '../../mapTypes.js'

// Registry record for the funhouse family (spec §4.1 schema, §4.3 values).
// Identity data only: this file may import ../ids.js and ../../mapTypes.js
// and nothing else. `profile.enabled` stays false until the release phase.
//
// audio (spec §4.3, §9.4): the funhouse's own rows, built only from the
// existing one-shot kinds. A bright, close room (the mirror maze is
// acoustically bright: short decay, high tone, little damping), the ride's
// motors as a low rumble, plywood creaks for its one-shot, a slow
// calliope-like F-major pad, and a forward PA for the Barker.
export default Object.freeze({
  id: MAP_FAMILY_FUNHOUSE,
  base: MAP_FAMILY_TOWER,
  dressing: 'office',
  displayName: 'FUNHOUSE',
  note: 'lying mirrors (painted) · the ride · the unload walk',
  group: 'liminal',
  paletteId: 'funhouseNeon',
  step: Object.freeze({}),
  propPacks: Object.freeze(['funhouse', 'playplace']),
  lampTint: 0xffb060, // BULB (src/world/families/funhouse/tile.js, re-exported by the editor kind)
  audio: Object.freeze({
    space: Object.freeze({
      decay: 1.8,
      wet: 0.24,
      tone: 5200,
      damp: 0.25,
      hum: 0.55,
      oneShot: 'creak',
      interval: Object.freeze([9, 24]),
      bed: Object.freeze({
        rumble: 0.06,
        rumbleLP: 140,
        air: 0.014,
        airF: 1800,
        wind: 0.02,
        water: 0,
      }),
      pad: Object.freeze({
        freqs: Object.freeze([174.61, 220, 261.63]),
        gain: 0.016,
        lp: 1200,
      }),
    }),
    pa: Object.freeze({
      level: 0.9,
      lp: 3400,
      send: 0.8,
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
