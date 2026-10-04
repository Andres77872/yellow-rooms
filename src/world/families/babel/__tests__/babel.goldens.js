// babel golden pins (spec §11.1 item 11, §13.2 step D). The coordinates
// cover, per seed: the spawn stair hall (block 0,0, storey 0), the Crimson
// Hexagon's chunk (exit block, exit storey), and for seed 1 the chunk of the
// first globe of one room of each anomaly class (dark / empty / crimson,
// the nearest to spawn), a noShaft block-band (level 1), the band-boundary
// flight of block (0,0) above its band (the stairUp half on storey 4, the
// stairDown half on storey 5) and the seam between blocks (0,0) and (1,0).
// Recomputed for the procedural layout grammar (proc-babel).
// repin-world.mjs --to <v> fills `digests` (null until R-release pins them).
export default {
  coords: [
    { key: 'spawn-1', seed: 1, cx: 0, cy: 0, cz: 0 },
    { key: 'exit-1', seed: 1, cx: 7, cy: -4, cz: -2 },
    { key: 'anomaly-dark-1', seed: 1, cx: 0, cy: 4, cz: 0 },
    { key: 'anomaly-empty-1', seed: 1, cx: 0, cy: 8, cz: 0 },
    { key: 'anomaly-crimson-1', seed: 1, cx: 0, cy: 2, cz: 0 },
    { key: 'no-shaft-1', seed: 1, cx: -4, cy: -2, cz: 4 },
    { key: 'boundary-up-1', seed: 1, cx: 1, cy: 4, cz: 0 },
    { key: 'boundary-down-1', seed: 1, cx: 1, cy: 5, cz: 0 },
    { key: 'seam-east-1', seed: 1, cx: 2, cy: 0, cz: 1 },
    { key: 'spawn-5eed', seed: 0x5eed, cx: 0, cy: 0, cz: 0 },
    { key: 'exit-5eed', seed: 0x5eed, cx: -1, cy: -3, cz: 4 },
  ],
  digests: null,
}
