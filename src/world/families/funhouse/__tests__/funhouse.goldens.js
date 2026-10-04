// funhouse golden pins (spec §11.1 item 11, §13.2 step D). Every pavilion
// is composed by its own seeded skeleton (geometry.skeletonOf), so the
// coordinates follow seed 1's pavilions: the spawn chunk (pavilion 0's
// midway and lobby), pavilion 0's ride storey at the end of its unload
// walkway, stair A's and stair B's chunks (ground and ride), the midway's
// seam into pavilion 1 (at that seam's hashed row, 19 for seed 1), two
// footprint-solid chunks (off the row, above
// the band), the exit pavilion's unload walkway and its one-way gate cut
// (seed 1: pavilion 4, its stair A chunk), one chunk per anomaly class at the anomaly's cell
// (seed 1, the nearest pavilion of each: 9 'figure', 10 'panel', −12 'lamp',
// −8 'uphill', −7 'turned'), a black-light room (pavilion −3) and seed
// 0x5eed's west pavilion and exit walkway. repin-world.mjs --to <v> fills
// `digests`.
export default {
  coords: [
    { key: 'spawn-midway', seed: 1, cx: 0, cy: 0, cz: 0 },
    { key: 'ride-walkway', seed: 1, cx: 2, cy: 1, cz: 1 },
    { key: 'stair-a-ground', seed: 1, cx: 0, cy: 0, cz: 1 },
    { key: 'stair-b-ground', seed: 1, cx: 2, cy: 0, cz: 0 },
    { key: 'stair-b-ride', seed: 1, cx: 2, cy: 1, cz: 0 },
    { key: 'seam-vestibule', seed: 1, cx: 3, cy: 0, cz: 1 },
    { key: 'solid-off-row', seed: 1, cx: 0, cy: 0, cz: 2 },
    { key: 'solid-above-band', seed: 1, cx: 1, cy: 2, cz: 0 },
    { key: 'exit-walkway', seed: 1, cx: 12, cy: 1, cz: 0 },
    { key: 'exit-oneway-cut', seed: 1, cx: 14, cy: 1, cz: 0 },
    { key: 'lie-figure', seed: 1, cx: 28, cy: 0, cz: 1 },
    { key: 'lie-panel', seed: 1, cx: 32, cy: 0, cz: 1 },
    { key: 'lie-lamp', seed: 1, cx: -35, cy: 0, cz: 0 },
    { key: 'anomaly-uphill', seed: 1, cx: -23, cy: 0, cz: 1 },
    { key: 'anomaly-turned', seed: 1, cx: -21, cy: 1, cz: 0 },
    { key: 'blacklight-room', seed: 1, cx: -9, cy: 0, cz: 0 },
    { key: 'seed-5eed-west-pavilion', seed: 0x5eed, cx: -2, cy: 0, cz: 0 },
    { key: 'seed-5eed-exit-walkway', seed: 0x5eed, cx: 10, cy: 1, cz: 0 },
  ],
  digests: null,
}
