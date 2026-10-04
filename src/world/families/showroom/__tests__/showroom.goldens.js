// showroom golden pins (spec §11.1 item 11, §13.2 step D). The district is
// generated per tile by its grammar (geometry.districtPlan, layout.js), so
// the coordinates name what seed 1's plans put there: the spawn's route
// chunk (tile 0,0's stair A, chunk 0,1), the route's north z-seam passage
// (x 3..4 in chunk 0,0), the hall storey's stair A and stair B (chunk 0,0)
// chunks, the checkout bank at the x seam (port z 9..10, chunk 1,0), a
// warehouse chunk, the two footprint-solid storeys above and below, the exit
// tile's fire-exit chunk (tile 3,0; cell 16,22), the two anomaly classes
// (tile 4,2 'loop' — its stair A chunk carries the oUt plate; tile 4,1
// 'repeat'), a south seam passage (tile 0,−1) and a second seed (its spawn
// at stair A, chunk 1,1, and a far hall chunk).
// repin-world.mjs --to <v> fills `digests`.
export default {
  coords: [
    { key: 'spawn-route', seed: 1, cx: 0, cy: 0, cz: 1 },
    { key: 'route-north-seam', seed: 1, cx: 0, cy: 0, cz: 0 },
    { key: 'hall-stair-a', seed: 1, cx: 0, cy: -1, cz: 1 },
    { key: 'hall-stair-b', seed: 1, cx: 0, cy: -1, cz: 0 },
    { key: 'checkout-x-seam', seed: 1, cx: 1, cy: -1, cz: 0 },
    { key: 'warehouse', seed: 1, cx: 1, cy: -1, cz: 1 },
    { key: 'solid-above', seed: 1, cx: 0, cy: 1, cz: 0 },
    { key: 'solid-below', seed: 1, cx: 0, cy: -2, cz: 0 },
    { key: 'exit-fire-exit', seed: 1, cx: 7, cy: -1, cz: 1 },
    { key: 'anomaly-loop', seed: 1, cx: 8, cy: 0, cz: 5 },
    { key: 'anomaly-repeat', seed: 1, cx: 9, cy: 0, cz: 3 },
    { key: 'south-seam-passage', seed: 1, cx: 0, cy: 0, cz: -1 },
    { key: 'seed-5eed-spawn', seed: 0x5eed, cx: 1, cy: 0, cz: 1 },
    { key: 'seed-5eed-far-hall', seed: 0x5eed, cx: -13, cy: -1, cz: 9 },
  ],
  digests: null,
}
