// Golden tables, moved verbatim from generate.test.js (spec §13.1). Pinned at
// PINNED_VERSION; scripts/repin-world.mjs rewrites this file (key order
// preserved) when WORLD_GEN_VERSION changes. Never edit the digests by hand.

export const PINNED_VERSION = 28

// Re-pinned whenever WORLD_GEN_VERSION changes. Coordinates cover all three
// zones AND multiple layers; the digest includes semantic passages, spaces,
// repair metadata, plan-aware stairs, furniture records, and representative
// v13 structures. The final twelve entries pin bottom/middle/top in both
// chunks of deterministic maximum-height bridged and open-void structures.
export const GOLDEN = {
  '0,0,0': '1abfe1cf',
  '3,0,-2': 'f69a5cb4',
  '12,0,12': 'c34418a7',
  '-10,0,10': '8a3ce719',
  '0,1,0': '0f7daced',
  '3,-1,-2': '3a1e19fc',
  '12,2,12': '0cc11b3c',
  '3,-2,-12': '800daf8b',
  '3,-1,-12': '5aea4eef',
  '1,0,-2': '77affb6e',
  '2,1,-2': '329355ba',
  '1,7,-2': '51548e39',
  '-1,0,2': '0b2f6277',
  '-1,3,3': 'b4a4daaa',
  '-7,9,-8': 'bde7d5af',
  '-3,-15,-1': 'cfbd66cf',
  '-2,-15,-1': '34ff2ef2',
  '-3,-8,-1': '2c0485e1',
  '-2,-8,-1': 'b10c938c',
  '-3,-1,-1': '6436003d',
  '-2,-1,-1': '56375f7f',
  '-10,0,8': 'df83b885',
  '-10,0,9': 'ff13ae72',
  '-10,7,8': '39724f70',
  '-10,7,9': '8342bb68',
  '-10,14,8': 'f19d2152',
  '-10,14,9': '42fb9529',
}

export const MAX_HEIGHT_GOLDEN = {
  bridged: ['-3,-15,-1', '-2,-15,-1', '-3,-8,-1', '-2,-8,-1', '-3,-1,-1', '-2,-1,-1'],
  openVoid: ['-10,0,8', '-10,0,9', '-10,7,8', '-10,7,9', '-10,14,8', '-10,14,9'],
}

export const SEWER_GOLDEN = Object.freeze([
  { key: '24151,2,-1,-3', seed: 24151, cx: 2, cy: -1, cz: -3, digest: '560a6d16' },
  { key: '24151,2,0,-3', seed: 24151, cx: 2, cy: 0, cz: -3, digest: 'e353e199' },
  { key: '24151,2,1,-3', seed: 24151, cx: 2, cy: 1, cz: -3, digest: 'a5f61915' },
  { key: 'audit-0:4084550820,-3,0,-4', seed: 4084550820, cx: -3, cy: 0, cz: -4, digest: '337768c7' },
  { key: 'audit-15:3752583958,-2,0,-1', seed: 3752583958, cx: -2, cy: 0, cz: -1, digest: '83ec8cf0' },
  { key: 'audit-31:3566893867,0,0,-2', seed: 3566893867, cx: 0, cy: 0, cz: -2, digest: '1cd89c80' },
])

export const SEWER_GOLDEN_DIGEST = '68a6455eb4406db3d110390f42ec54c8a542efd4cc40c78e53249dc893985447'

export const TOWER_GOLDEN = Object.freeze([
  { key: '23063,-4,-22,-3', seed: 23063, cx: -4, cy: -22, cz: -3, digest: '745d6bfb' },
  { key: '23063,-4,-22,-2', seed: 23063, cx: -4, cy: -22, cz: -2, digest: '69b1fcc5' },
  { key: '23063,-4,-21,-3', seed: 23063, cx: -4, cy: -21, cz: -3, digest: '7adc338e' },
  { key: '23063,-4,-21,-2', seed: 23063, cx: -4, cy: -21, cz: -2, digest: '0925f6a1' },
  { key: '23063,-4,-20,-3', seed: 23063, cx: -4, cy: -20, cz: -3, digest: 'e9d9e922' },
  { key: '23063,-4,-20,-2', seed: 23063, cx: -4, cy: -20, cz: -2, digest: 'd110bafa' },
])

export const TOWER_GOLDEN_DIGEST = '69555093b65e5a05d3877c59f6c10006807712e0a021ead04eda1cca4edb5950'

export const LATTICE_GOLDEN = Object.freeze([
  { key: '2387080720,0,-21,-4', seed: 2387080720, cx: 0, cy: -21, cz: -4, digest: '79d2740e' },
  { key: '2387080720,1,-21,-4', seed: 2387080720, cx: 1, cy: -21, cz: -4, digest: 'c06eb043' },
  { key: '2387080720,2,-21,-4', seed: 2387080720, cx: 2, cy: -21, cz: -4, digest: 'f8a12064' },
  { key: '2387080720,3,-21,-4', seed: 2387080720, cx: 3, cy: -21, cz: -4, digest: 'ea1e554a' },
  { key: '2387080720,0,-21,-3', seed: 2387080720, cx: 0, cy: -21, cz: -3, digest: '7bd10c41' },
  { key: '2387080720,1,-21,-3', seed: 2387080720, cx: 1, cy: -21, cz: -3, digest: '36c0cb4f' },
  { key: '2387080720,2,-21,-3', seed: 2387080720, cx: 2, cy: -21, cz: -3, digest: '81542ddb' },
  { key: '2387080720,3,-21,-3', seed: 2387080720, cx: 3, cy: -21, cz: -3, digest: '6243ae04' },
  { key: '2387080720,0,-21,-2', seed: 2387080720, cx: 0, cy: -21, cz: -2, digest: '72c1199b' },
  { key: '2387080720,1,-21,-2', seed: 2387080720, cx: 1, cy: -21, cz: -2, digest: '06988960' },
  { key: '2387080720,2,-21,-2', seed: 2387080720, cx: 2, cy: -21, cz: -2, digest: '4bed637d' },
  { key: '2387080720,3,-21,-2', seed: 2387080720, cx: 3, cy: -21, cz: -2, digest: '51c2f50f' },
  { key: '2387080720,0,-21,-1', seed: 2387080720, cx: 0, cy: -21, cz: -1, digest: '789bc8ad' },
  { key: '2387080720,1,-21,-1', seed: 2387080720, cx: 1, cy: -21, cz: -1, digest: '6489cca8' },
  { key: '2387080720,2,-21,-1', seed: 2387080720, cx: 2, cy: -21, cz: -1, digest: 'a54366fe' },
  { key: '2387080720,3,-21,-1', seed: 2387080720, cx: 3, cy: -21, cz: -1, digest: 'ea21e21b' },
  { key: '2387080720,0,-20,-4', seed: 2387080720, cx: 0, cy: -20, cz: -4, digest: 'cd110fc1' },
  { key: '2387080720,1,-20,-4', seed: 2387080720, cx: 1, cy: -20, cz: -4, digest: '4699dac4' },
  { key: '2387080720,2,-20,-4', seed: 2387080720, cx: 2, cy: -20, cz: -4, digest: '7306d278' },
  { key: '2387080720,3,-20,-4', seed: 2387080720, cx: 3, cy: -20, cz: -4, digest: '3f2b2ceb' },
  { key: '2387080720,0,-20,-3', seed: 2387080720, cx: 0, cy: -20, cz: -3, digest: '37ae173a' },
  { key: '2387080720,1,-20,-3', seed: 2387080720, cx: 1, cy: -20, cz: -3, digest: '5cadf903' },
  { key: '2387080720,2,-20,-3', seed: 2387080720, cx: 2, cy: -20, cz: -3, digest: 'e8364a62' },
  { key: '2387080720,3,-20,-3', seed: 2387080720, cx: 3, cy: -20, cz: -3, digest: '1876dbea' },
  { key: '2387080720,0,-20,-2', seed: 2387080720, cx: 0, cy: -20, cz: -2, digest: '4e88af92' },
  { key: '2387080720,1,-20,-2', seed: 2387080720, cx: 1, cy: -20, cz: -2, digest: 'ae9f1de3' },
  { key: '2387080720,2,-20,-2', seed: 2387080720, cx: 2, cy: -20, cz: -2, digest: 'f8fc2b14' },
  { key: '2387080720,3,-20,-2', seed: 2387080720, cx: 3, cy: -20, cz: -2, digest: '1e83e909' },
  { key: '2387080720,0,-20,-1', seed: 2387080720, cx: 0, cy: -20, cz: -1, digest: '160920e8' },
  { key: '2387080720,1,-20,-1', seed: 2387080720, cx: 1, cy: -20, cz: -1, digest: '2ca3e30a' },
  { key: '2387080720,2,-20,-1', seed: 2387080720, cx: 2, cy: -20, cz: -1, digest: 'ccb1b71f' },
  { key: '2387080720,3,-20,-1', seed: 2387080720, cx: 3, cy: -20, cz: -1, digest: '82d54649' },
  { key: '2387080720,0,-19,-4', seed: 2387080720, cx: 0, cy: -19, cz: -4, digest: 'e26f9bee' },
  { key: '2387080720,1,-19,-4', seed: 2387080720, cx: 1, cy: -19, cz: -4, digest: '326eeb9c' },
  { key: '2387080720,2,-19,-4', seed: 2387080720, cx: 2, cy: -19, cz: -4, digest: 'b5f6dc92' },
  { key: '2387080720,3,-19,-4', seed: 2387080720, cx: 3, cy: -19, cz: -4, digest: 'd5a53611' },
  { key: '2387080720,0,-19,-3', seed: 2387080720, cx: 0, cy: -19, cz: -3, digest: '5d867917' },
  { key: '2387080720,1,-19,-3', seed: 2387080720, cx: 1, cy: -19, cz: -3, digest: 'f600d963' },
  { key: '2387080720,2,-19,-3', seed: 2387080720, cx: 2, cy: -19, cz: -3, digest: '91d07dec' },
  { key: '2387080720,3,-19,-3', seed: 2387080720, cx: 3, cy: -19, cz: -3, digest: '0babc6c3' },
  { key: '2387080720,0,-19,-2', seed: 2387080720, cx: 0, cy: -19, cz: -2, digest: '21095d04' },
  { key: '2387080720,1,-19,-2', seed: 2387080720, cx: 1, cy: -19, cz: -2, digest: '1cd26939' },
  { key: '2387080720,2,-19,-2', seed: 2387080720, cx: 2, cy: -19, cz: -2, digest: 'e92ead6a' },
  { key: '2387080720,3,-19,-2', seed: 2387080720, cx: 3, cy: -19, cz: -2, digest: '15e5f837' },
  { key: '2387080720,0,-19,-1', seed: 2387080720, cx: 0, cy: -19, cz: -1, digest: 'bf3ca547' },
  { key: '2387080720,1,-19,-1', seed: 2387080720, cx: 1, cy: -19, cz: -1, digest: '3e5593a5' },
  { key: '2387080720,2,-19,-1', seed: 2387080720, cx: 2, cy: -19, cz: -1, digest: '75d2f058' },
  { key: '2387080720,3,-19,-1', seed: 2387080720, cx: 3, cy: -19, cz: -1, digest: '4ed8bef9' },
  { key: '2387080720,0,-18,-4', seed: 2387080720, cx: 0, cy: -18, cz: -4, digest: '5a513043' },
  { key: '2387080720,1,-18,-4', seed: 2387080720, cx: 1, cy: -18, cz: -4, digest: '0aa8823f' },
  { key: '2387080720,2,-18,-4', seed: 2387080720, cx: 2, cy: -18, cz: -4, digest: 'a2645481' },
  { key: '2387080720,3,-18,-4', seed: 2387080720, cx: 3, cy: -18, cz: -4, digest: '6030b57e' },
  { key: '2387080720,0,-18,-3', seed: 2387080720, cx: 0, cy: -18, cz: -3, digest: '43d647f6' },
  { key: '2387080720,1,-18,-3', seed: 2387080720, cx: 1, cy: -18, cz: -3, digest: 'e5198c70' },
  { key: '2387080720,2,-18,-3', seed: 2387080720, cx: 2, cy: -18, cz: -3, digest: '8d9aab05' },
  { key: '2387080720,3,-18,-3', seed: 2387080720, cx: 3, cy: -18, cz: -3, digest: '262b1459' },
  { key: '2387080720,0,-18,-2', seed: 2387080720, cx: 0, cy: -18, cz: -2, digest: 'c6cee01e' },
  { key: '2387080720,1,-18,-2', seed: 2387080720, cx: 1, cy: -18, cz: -2, digest: '4acc3ac2' },
  { key: '2387080720,2,-18,-2', seed: 2387080720, cx: 2, cy: -18, cz: -2, digest: '9b18e6c6' },
  { key: '2387080720,3,-18,-2', seed: 2387080720, cx: 3, cy: -18, cz: -2, digest: '6e4590ab' },
  { key: '2387080720,0,-18,-1', seed: 2387080720, cx: 0, cy: -18, cz: -1, digest: '9fcf2151' },
  { key: '2387080720,1,-18,-1', seed: 2387080720, cx: 1, cy: -18, cz: -1, digest: 'bfbfaee9' },
  { key: '2387080720,2,-18,-1', seed: 2387080720, cx: 2, cy: -18, cz: -1, digest: 'd413e85b' },
  { key: '2387080720,3,-18,-1', seed: 2387080720, cx: 3, cy: -18, cz: -1, digest: 'e9173e1e' },
  { key: '2387080720,0,-17,-4', seed: 2387080720, cx: 0, cy: -17, cz: -4, digest: 'e1dee49c' },
  { key: '2387080720,1,-17,-4', seed: 2387080720, cx: 1, cy: -17, cz: -4, digest: '11dccf91' },
  { key: '2387080720,2,-17,-4', seed: 2387080720, cx: 2, cy: -17, cz: -4, digest: '48a45280' },
  { key: '2387080720,3,-17,-4', seed: 2387080720, cx: 3, cy: -17, cz: -4, digest: '68131f7d' },
  { key: '2387080720,0,-17,-3', seed: 2387080720, cx: 0, cy: -17, cz: -3, digest: '3a4044d1' },
  { key: '2387080720,1,-17,-3', seed: 2387080720, cx: 1, cy: -17, cz: -3, digest: '418079a5' },
  { key: '2387080720,2,-17,-3', seed: 2387080720, cx: 2, cy: -17, cz: -3, digest: '81fd9ed0' },
  { key: '2387080720,3,-17,-3', seed: 2387080720, cx: 3, cy: -17, cz: -3, digest: '9590012d' },
  { key: '2387080720,0,-17,-2', seed: 2387080720, cx: 0, cy: -17, cz: -2, digest: '17cfc670' },
  { key: '2387080720,1,-17,-2', seed: 2387080720, cx: 1, cy: -17, cz: -2, digest: '20cd45ea' },
  { key: '2387080720,2,-17,-2', seed: 2387080720, cx: 2, cy: -17, cz: -2, digest: '948ae93d' },
  { key: '2387080720,3,-17,-2', seed: 2387080720, cx: 3, cy: -17, cz: -2, digest: 'e0f34e34' },
  { key: '2387080720,0,-17,-1', seed: 2387080720, cx: 0, cy: -17, cz: -1, digest: 'd017ba28' },
  { key: '2387080720,1,-17,-1', seed: 2387080720, cx: 1, cy: -17, cz: -1, digest: 'ef5e85c4' },
  { key: '2387080720,2,-17,-1', seed: 2387080720, cx: 2, cy: -17, cz: -1, digest: '1b1f3c80' },
  { key: '2387080720,3,-17,-1', seed: 2387080720, cx: 3, cy: -17, cz: -1, digest: '16cda019' },
])

export const LATTICE_GOLDEN_DIGEST = '44b221dbc17d009993a106c9046c5faad2661303795a85ba1cbfcc4122e13266'

// Hotel: representative residential-fabric block — 2x2 chunks over two
// floors at the spawn neighbourhood (guest fabric, stairs, door joinery,
// residential furnishing), pinned exactly like the other family goldens.
export const HOTEL_GOLDEN = Object.freeze([
  { key: '777,-1,0,-1', seed: 777, cx: -1, cy: 0, cz: -1, digest: '37475046' },
  { key: '777,0,0,-1', seed: 777, cx: 0, cy: 0, cz: -1, digest: 'ed43a06c' },
  { key: '777,-1,0,0', seed: 777, cx: -1, cy: 0, cz: 0, digest: '8cdc37b0' },
  { key: '777,0,0,0', seed: 777, cx: 0, cy: 0, cz: 0, digest: 'b2581bb6' },
  { key: '777,-1,1,-1', seed: 777, cx: -1, cy: 1, cz: -1, digest: '5ea25a45' },
  { key: '777,0,1,-1', seed: 777, cx: 0, cy: 1, cz: -1, digest: '383d6aa2' },
  { key: '777,-1,1,0', seed: 777, cx: -1, cy: 1, cz: 0, digest: 'af7c3570' },
  { key: '777,0,1,0', seed: 777, cx: 0, cy: 1, cz: 0, digest: '71f2824b' },
])

export const HOTEL_GOLDEN_DIGEST = 'a4e2cf5f62892c3b2b0e742a48eea94dd8639e5d549248f644b3411ec778a9a6'

export const OFFICE_PAIR_DESCRIPTOR_GOLDEN = {
  id: 1394823709,
  kind: 'bridged',
  district: { x: -1, z: -1, size: 4 },
  bandIndex: -1,
  baseCy: -15,
  bottomCy: -15,
  topCy: -1,
  levelCount: 15,
  height: 15,
  bridgeAxis: 'x',
  longSpan: 22,
  shortSpan: 6,
  anchor: { cx: -3, cz: -1 },
  participants: [
    { cx: -3, cz: -1 },
    { cx: -2, cz: -1 },
  ],
  participantChunks: [
    { cx: -3, cz: -1 },
    { cx: -2, cz: -1 },
  ],
  bounds: { x0: -40, z0: -7, x1: -19, z1: -2 },
  globalBounds: { x0: -40, z0: -7, x1: -19, z1: -2 },
  centerLines: [-5, -4],
  bridgeLevels: [-14, -12, -10, -8, -6, -4, -2],
  decks: [
    [-14, -15, -5],
    [-12, -13, -4],
    [-10, -11, -5],
    [-8, -9, -4],
    [-6, -7, -5],
    [-4, -5, -4],
    [-2, -3, -5],
  ],
}
