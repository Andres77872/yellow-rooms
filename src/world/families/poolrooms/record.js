import { MAP_FAMILY_POOLROOMS } from '../ids.js'
import { MAP_FAMILY_TOWER } from '../../mapTypes.js'

// Registry record for the poolrooms family (spec §4.1 schema, §4.3 values).
// Identity data only: this file may import ../ids.js and ../../mapTypes.js
// and nothing else. `profile.enabled` stays false until the release phase.
//
// audio (§4.3, §9.4): the poolrooms' own rows, built only from the existing
// one-shot kinds. A tiled hall (doc §8 "tiled-hall", 4–8 s decay scaled to
// the engine's room model): a long, bright, wet tail; a constant gutter
// water bed and a low pump drone instead of wind; drips for the one-shot;
// the PA swims in the reverb.
export default Object.freeze({
  id: MAP_FAMILY_POOLROOMS,
  base: MAP_FAMILY_TOWER,
  dressing: 'office',
  displayName: 'POOLROOMS',
  note: 'tiled chambers · drained basins · a glass gallery',
  group: 'liminal',
  paletteId: 'poolTile',
  step: Object.freeze({}),
  propPacks: Object.freeze(['pool']),
  lampTint: 0xa8f0ff, // POOL_TINT (src/world/families/poolrooms/tile.js, re-exported by the editor kind)
  audio: Object.freeze({
    space: Object.freeze({
      decay: 3.2,
      wet: 0.3,
      tone: 4200,
      damp: 0.35,
      hum: 0.45,
      oneShot: 'drip',
      interval: Object.freeze([5, 14]),
      bed: Object.freeze({
        rumble: 0.05,
        rumbleLP: 160,
        air: 0.02,
        airF: 1400,
        wind: 0,
        water: 0.035,
      }),
      pad: Object.freeze({
        freqs: Object.freeze([146.83, 220, 329.63]),
        gain: 0.012,
        lp: 900,
      }),
    }),
    pa: Object.freeze({
      level: 0.85,
      lp: 3000,
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
    structures: 'stairs+catalog',
    lethal: false,
    floorPockets: false,
  }),
})
