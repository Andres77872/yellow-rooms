// stairwell golden pins (spec §11.1 item 11, §13.2 step D). The coordinates
// cover, per seed: the spawn landing (shaft A, storey 0), the exit landing
// (shaft B, storey G), the band −1 transfer at storey −3 (a rung-corridor chunk
// between A and B), a long rung (east x-seam / south z-seam port chunk), a
// solid chunk. Coordinates follow the procedural layout of district (0,0).
// repin-world.mjs --to <v> fills `digests` (null until R-release pins them).
export default {
  coords: [
    { key: 'spawn-1', seed: 1, cx: 2, cy: 0, cz: 1 },
    { key: 'exit-1', seed: 1, cx: 0, cy: -38, cz: 1 },
    { key: 'transfer-1', seed: 1, cx: 1, cy: -3, cz: 1 },
    { key: 'long-east-1', seed: 1, cx: 3, cy: 0, cz: 3 },
    { key: 'long-south-1', seed: 1, cx: 0, cy: 2, cz: 3 },
    { key: 'solid-1', seed: 1, cx: 1, cy: -1, cz: 1 },
    { key: 'spawn-5eed', seed: 0x5eed, cx: 3, cy: 0, cz: 1 },
    { key: 'exit-5eed', seed: 0x5eed, cx: 1, cy: -28, cz: 3 },
    { key: 'transfer-5eed', seed: 0x5eed, cx: 2, cy: -3, cz: 2 },
    { key: 'long-south-5eed', seed: 0x5eed, cx: 3, cy: 2, cz: 3 },
    { key: 'solid-5eed', seed: 0x5eed, cx: 2, cy: 0, cz: 1 },
  ],
  digests: null,
}
