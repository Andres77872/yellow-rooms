import { MAP_FAMILY_TRAIN } from '../ids.js'
import { MAP_FAMILY_TOWER } from '../../mapTypes.js'

// Registry record for the train family (spec §4.1 schema, §4.3 values).
// Identity data only: this file may import ../ids.js and ../../mapTypes.js
// and nothing else. `profile.enabled` stays false until the release phase.
//
// audio is the family's own {space, pa} (Phase B), in the FAMILY_SPACES
// (src/audio/AudioBus.js) and FAMILY_PA (src/audio/music/MusicPlayer.js) row
// shapes, built only from the existing one-shot kinds (drip, creak, wind).
export default Object.freeze({
  id: MAP_FAMILY_TRAIN,
  base: MAP_FAMILY_TOWER,
  dressing: 'office',
  displayName: 'TRAIN',
  note: 'stopped cars · platforms · an unlisted station',
  group: 'liminal',
  paletteId: 'metroTile',
  step: Object.freeze({}),
  propPacks: Object.freeze(['train']),
  lampTint: 0xe4fff0, // TRAIN_TINT in src/world/families/train/tile.js
  audio: Object.freeze({
    // The train's own rows (Phase B): tiled stations and steel cars ring
    // longer and brighter than the tower, under a heavy low rumble bed (the
    // rolling noise that never stops, doc §8), with a creak for the cars'
    // flex; the PA is the station announcer, louder and boxier.
    space: Object.freeze({
      decay: 1.7,
      wet: 0.22,
      tone: 2600,
      damp: 0.42,
      hum: 0.9,
      oneShot: 'creak',
      interval: Object.freeze([12, 28]),
      bed: Object.freeze({
        rumble: 0.13,
        rumbleLP: 150,
        air: 0.022,
        airF: 700,
        wind: 0.09,
        water: 0,
      }),
      pad: Object.freeze({
        freqs: Object.freeze([110, 164.81, 246.94]),
        gain: 0.012,
        lp: 640,
      }),
    }),
    pa: Object.freeze({
      level: 0.88,
      lp: 2100,
      send: 0.55,
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
