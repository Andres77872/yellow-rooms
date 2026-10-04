// poolrooms golden pins (spec §11.1 item 11, §13.2 step D). The tiles are
// grammar-generated, so these coordinates were read off the planner for the
// pinned seeds (geometry.js tileVolumes / exitAnchor / stairCore, grammar.js
// spawnCells and ropeSites). Seed 1, tile (0,0): natatio on chunks (1,1),
// (2,1), pit on (0,2), the stair core up to the gallery in chunk (0,0),
// spawn on deck chunk (1,1); exit tile (0,2), anchor chunk (2,−1,7); tile
// (2,1) 'deep' (pit chunks (8,4),(8,5)); tile (3,1) 'rope' on the deck mouth
// at global cell (142,54); tile (2,2) 'rope' at (92,86). Seed 0x5eed:
// tile (0,0) lap hall on chunks (0..1,0..1); tile (−1,0) lap hall on
// (−2..−1,0..1). repin-world.mjs --to <v> fills `digests`.
export default {
  coords: [
    { key: 'spawn-deck', seed: 1, cx: 1, cy: 0, cz: 1 },
    { key: 'gallery', seed: 1, cx: 2, cy: 1, cz: 1 },
    { key: 'gallery-stair-core', seed: 1, cx: 0, cy: 1, cz: 0 },
    { key: 'basin-pit', seed: 1, cx: 0, cy: -1, cz: 2 },
    { key: 'deck-chambers', seed: 1, cx: 0, cy: 0, cz: 0 },
    { key: 'basin-service', seed: 1, cx: 2, cy: -1, cz: 2 },
    { key: 'exit-pit-floor', seed: 1, cx: 2, cy: -1, cz: 7 },
    { key: 'anomaly-deep-pit', seed: 1, cx: 8, cy: -1, cz: 4 },
    { key: 'anomaly-rope-deck', seed: 1, cx: 10, cy: 0, cz: 3 },
    { key: 'anomaly-rope-deck-2', seed: 1, cx: 6, cy: 0, cz: 6 },
    { key: 'seed-5eed-lap', seed: 0x5eed, cx: 0, cy: 0, cz: 0 },
    { key: 'seed-5eed-west-tile', seed: 0x5eed, cx: -2, cy: 0, cz: 1 },
  ],
  digests: null,
}
