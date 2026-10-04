// terminal golden pins (spec §11.1 item 11, §13.2 step D), for the tile
// grammar (geometry.layoutOf): tile 0's check-in hall (spawn), a cross-bridged
// spine atrium on departures (seed 1: tile 3, both participants) and its
// mezzanine gallery, tile 1's baggage hall and a holdroom of its first pier,
// the exit tile's arrivals door (seed 1: tile −3), a footprint-solid
// mezzanine chunk (row 0), a checkpoint bay's serpentine (tile −1), the two
// anomaly classes at their pier's service-stair top (tile −4 'board', tile −2
// 'dead'), a one-pier tile's stair chunk (tile −3), a three-pier tile's third
// stair chunk (tile −5), and seed 0x5eed's exit (tile 3) and checkpoint bay
// (tile −3). repin-world.mjs --to <v> fills `digests`.
export default {
  coords: [
    { key: 'spawn-landside', seed: 1, cx: 0, cy: 0, cz: 1 },
    { key: 'atrium-dep-west', seed: 1, cx: 12, cy: 0, cz: 1 },
    { key: 'atrium-dep-east', seed: 1, cx: 13, cy: 0, cz: 2 },
    { key: 'atrium-mezzanine', seed: 1, cx: 12, cy: 1, cz: 1 },
    { key: 'baggage-hall', seed: 1, cx: 5, cy: -1, cz: 1 },
    { key: 'pier-holdroom', seed: 1, cx: 4, cy: 0, cz: 3 },
    { key: 'exit-arrivals', seed: 1, cx: -11, cy: -1, cz: 1 },
    { key: 'solid-mezzanine-edge', seed: 1, cx: 0, cy: 1, cz: 0 },
    { key: 'checkpoint-bay', seed: 1, cx: -2, cy: 0, cz: 1 },
    { key: 'anomaly-board', seed: 1, cx: -14, cy: 0, cz: 0 },
    { key: 'anomaly-dead', seed: 1, cx: -6, cy: 0, cz: 3 },
    { key: 'one-pier-tile', seed: 1, cx: -10, cy: 0, cz: 3 },
    { key: 'three-pier-tile', seed: 1, cx: -20, cy: 0, cz: 3 },
    { key: 'seed-5eed-exit', seed: 0x5eed, cx: 14, cy: -1, cz: 2 },
    { key: 'seed-5eed-checkpoint', seed: 0x5eed, cx: -9, cy: 0, cz: 1 },
  ],
  digests: null,
}
