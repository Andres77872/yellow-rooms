import { MAP_FAMILY_TERMINAL } from '../ids.js'
import { MAP_FAMILY_TOWER } from '../../mapTypes.js'

// Registry record for the terminal family (spec §4.1 schema, §4.3 values).
// Identity data only: this file may import ../ids.js and ../../mapTypes.js
// and nothing else. `profile.enabled` stays false until the release phase.
//
// audio (§4.3, §9.4): the terminal's own rows, built only from the existing
// one-shot kinds. Doc 08 §8: a 'hall' acoustic class, up to 3.5 s RT under
// the spine's high ceiling, so speech smears (a long wet tail, a dark tone);
// the hum of belts and air handling (a strong hum, a low rumble and an air
// bed, almost no wind); the structure settling as the one-shot; the PA loud,
// authoritative and unintelligible (low-passed, drowned in the reverb).
export default Object.freeze({
  id: MAP_FAMILY_TERMINAL,
  base: MAP_FAMILY_TOWER,
  dressing: 'office',
  displayName: 'TERMINAL',
  note: 'an endless concourse · dead piers · arrivals below',
  group: 'liminal',
  paletteId: 'terminalTerrazzo',
  step: Object.freeze({}),
  propPacks: Object.freeze(['terminal']),
  lampTint: 0xd4e2ff, // GATE_TINT (src/world/families/terminal/tile.js, re-exported by the editor kind)
  audio: Object.freeze({
    space: Object.freeze({
      decay: 3.5,
      wet: 0.32,
      tone: 2400,
      damp: 0.45,
      hum: 0.85,
      oneShot: 'creak',
      interval: Object.freeze([12, 30]),
      bed: Object.freeze({
        rumble: 0.06,
        rumbleLP: 140,
        air: 0.03,
        airF: 700,
        wind: 0.015,
        water: 0,
      }),
      pad: Object.freeze({
        freqs: Object.freeze([110, 164.81, 246.94]),
        gain: 0.012,
        lp: 640,
      }),
    }),
    pa: Object.freeze({
      level: 0.9,
      lp: 1800,
      send: 0.9,
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
