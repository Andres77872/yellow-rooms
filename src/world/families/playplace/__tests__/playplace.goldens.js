// playplace golden pins (spec §11.1 item 11, §13.2 step D). Every module is
// drawn by the grammar (geometry.js), so the pins name what seed 1 (and
// 0x5eed) happen to draw there: the spawn's ball-pit hall (module 0,0 is one
// 2-storey pitHall in chunk 1,0, so its top deck is solid), a 3-storey
// frame's top deck (module −2,−1), the 6×6-ish fortress (module −1,−1), a
// 2-storey frame (module 1,−1), a food court (module 0,−1), the anchor
// module's exit pod (module 2,1), and the three anomaly classes (module 0,−2
// 'redPit' on its pitHall, −2,−2 'mascot' moved to its pit hall's deck,
// −1,−2 'arcade' cabinets turned). repin-world.mjs --to <v> fills `digests`.
export default {
  coords: [
    { key: 'spawn-pit-hall', seed: 1, cx: 1, cy: 0, cz: 0 },
    { key: 'pit-hall-deck', seed: 1, cx: 1, cy: 1, cz: 0 },
    { key: 'solid-top', seed: 1, cx: 0, cy: 2, cz: 0 },
    { key: 'frame-top-deck', seed: 1, cx: -4, cy: 2, cz: -1 },
    { key: 'fortress-top-deck', seed: 1, cx: -2, cy: 2, cz: -2 },
    { key: 'frame-floor', seed: 1, cx: 2, cy: 0, cz: -2 },
    { key: 'food-court', seed: 1, cx: 0, cy: 0, cz: -2 },
    { key: 'exit-pod', seed: 1, cx: 4, cy: 1, cz: 2 },
    { key: 'anomaly-red-pit', seed: 1, cx: 0, cy: 0, cz: -3 },
    { key: 'anomaly-mascot-deck', seed: 1, cx: -4, cy: 1, cz: -3 },
    { key: 'anomaly-arcade', seed: 1, cx: -1, cy: 0, cz: -3 },
    { key: 'seed-5eed-fortress', seed: 0x5eed, cx: 1, cy: 0, cz: 0 },
    { key: 'seed-5eed-exit-pod', seed: 0x5eed, cx: 7, cy: 1, cz: 6 },
  ],
  digests: null,
}
