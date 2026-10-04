// train golden pins (spec §11.1 item 11, §13.2 step D). The coordinates
// cover the procedural tile grammar (geometry.js skeleton): the spawn car
// (tile 0, car 0), the exit closet (exitAnchor, storey 1), a station stair
// core on both storeys (its lower chunk also holds seed 1's tile-0 dark car,
// its upper chunk the concourse), a tile-seam gangway and the sealed upper
// seam above it (tile 1's concourse), a plain tile's cars and service core,
// its upper works, an island platform (tile 4) and every anomaly class
// (wrongSide, a lying plate and a blackout car in one chunk, a drifting
// station name). Coordinates follow the grammar: re-derive them if the
// skeleton changes. repin-world.mjs --to <v> fills `digests` (null until
// R-release pins them).
export default {
  coords: [
    { key: 'spawn-car-1', seed: 1, cx: 0, cy: 0, cz: 0 },
    { key: 'exit-1', seed: 1, cx: 17, cy: 1, cz: 0 },
    { key: 'core-lower-dark-car-1', seed: 1, cx: 1, cy: 0, cz: 0 },
    { key: 'core-upper-concourse-1', seed: 1, cx: 1, cy: 1, cz: 0 },
    { key: 'seam-gangway-1', seed: 1, cx: 4, cy: 0, cz: 0 },
    { key: 'seam-sealed-upper-1', seed: 1, cx: 4, cy: 1, cz: 0 },
    { key: 'plain-tile-1', seed: 1, cx: 9, cy: 0, cz: 0 },
    { key: 'service-core-1', seed: 1, cx: 9, cy: 1, cz: 0 },
    { key: 'upper-works-1', seed: 1, cx: 10, cy: 1, cz: 0 },
    { key: 'island-platform-1', seed: 1, cx: 18, cy: 0, cz: 0 },
    { key: 'wrongSide-1', seed: 1, cx: -12, cy: 0, cz: 0 },
    { key: 'carNumbers-blackout-1', seed: 1, cx: -10, cy: 0, cz: 0 },
    { key: 'stationName-777', seed: 777, cx: 26, cy: 1, cz: 0 },
    { key: 'spawn-5eed', seed: 0x5eed, cx: 0, cy: 0, cz: 0 },
    { key: 'exit-5eed', seed: 0x5eed, cx: 17, cy: 1, cz: 0 },
  ],
  digests: null,
}
