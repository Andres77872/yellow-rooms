// house golden pins (spec §11.1 item 11, §13.2 step D), for the grown
// (procedural) house. Seed 1: the shell tile (0,0) (front yard, its ground
// wing, the first floor over it, the main stair core in chunk (0,0), nothing
// over the shell chunk), tile (1,0)'s footprint-solid first-floor chunk, a
// rooms tile (0,-1) ground and top, a plain loop (tile -1,-1), the exit
// tile's (2,2) Great Hall in chunk (6,5) (floor, void storey, top gallery),
// the anomaly classes (tile 0,-2 'copy' upstairs; tile 2,-2 'red' hallway;
// tile -1,2 'loop' missingDoor). Seed 0x5eed: the yard and the exit hall
// (tile 3,2, chunk 10,5).
// repin-world.mjs --to <v> fills `digests`.
export default {
  coords: [
    { key: 'spawn-yard', seed: 1, cx: 0, cy: 0, cz: 1 },
    { key: 'shell-tile-ground', seed: 1, cx: 1, cy: 0, cz: 1 },
    { key: 'shell-tile-upstairs', seed: 1, cx: 2, cy: 1, cz: 1 },
    { key: 'stair-core-upstairs', seed: 1, cx: 0, cy: 1, cz: 0 },
    { key: 'solid-over-shell', seed: 1, cx: 0, cy: 1, cz: 1 },
    { key: 'solid-upper-chunk', seed: 1, cx: 3, cy: 1, cz: 0 },
    { key: 'rooms-ground', seed: 1, cx: 0, cy: 0, cz: -2 },
    { key: 'rooms-top', seed: 1, cx: 1, cy: 2, cz: -1 },
    { key: 'loop-plain', seed: 1, cx: -1, cy: 0, cz: -2 },
    { key: 'exit-hall-floor', seed: 1, cx: 6, cy: 0, cz: 5 },
    { key: 'exit-hall-void', seed: 1, cx: 6, cy: 1, cz: 5 },
    { key: 'exit-hall-gallery', seed: 1, cx: 6, cy: 2, cz: 5 },
    { key: 'anomaly-copy', seed: 1, cx: 1, cy: 1, cz: -4 },
    { key: 'anomaly-red', seed: 1, cx: 7, cy: 0, cz: -3 },
    { key: 'anomaly-loop-missing-door', seed: 1, cx: -2, cy: 0, cz: 5 },
    { key: 'seed-5eed-spawn-yard', seed: 0x5eed, cx: 0, cy: 0, cz: 1 },
    { key: 'seed-5eed-exit-hall', seed: 0x5eed, cx: 10, cy: 0, cz: 5 },
  ],
  digests: null,
}
