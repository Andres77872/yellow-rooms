// nightlot golden pins (spec §11.1 item 11, §13.2 step D). Seed 1: the spawn
// chunk (the refuge canopy of district 0,0); a lot stair head and the
// undercroft under it; an offices stair hall and its upper floor; a motel
// stair hall, its basement suite and its upper floor (walkway rooms); the
// footprint-solid upper storey over the spawn; an outparcel; a gas station; a
// big box's stock stair and the stock hall below; a kiosk on the lot and its
// service basement; a garage's stair tower on the ground deck, on B1 and on
// the roof deck; a strip mall's roof at its bulkhead; a chunk of each anomaly
// class; a field district; the exit district's plant room; an underpass on a
// district seam; the storey above the band and the one below it; plus seed
// 0x5eed's spawn and exit. Every coordinate is re-found from the blueprint and
// checked against its baked chunk (stairs, footprint, walkable spawn/exit).
// repin-world.mjs --to <v> fills `digests`.
export default {
  coords: [
    { key: 'spawn-refuge', seed: 1, cx: 3, cy: 0, cz: 2 },
    { key: 'lot-stair-head', seed: 1, cx: 1, cy: 0, cz: 0 },
    { key: 'lot-stair-under', seed: 1, cx: 1, cy: -1, cz: 0 },
    { key: 'offices-stair-hall', seed: 1, cx: 2, cy: 0, cz: 1 },
    { key: 'offices-upper-floor', seed: 1, cx: 2, cy: 1, cz: 1 },
    { key: 'motel-stair-hall', seed: 1, cx: -3, cy: 0, cz: -2 },
    { key: 'motel-basement-suite', seed: 1, cx: -3, cy: -1, cz: -2 },
    { key: 'motel-upper-floor', seed: 1, cx: -3, cy: 1, cz: -2 },
    { key: 'solid-above', seed: 1, cx: 3, cy: 1, cz: 2 },
    { key: 'outparcel', seed: 1, cx: 3, cy: 0, cz: 0 },
    { key: 'gas-station', seed: 1, cx: 5, cy: 0, cz: -2 },
    { key: 'bigbox-stock-stair', seed: 1, cx: 2, cy: 0, cz: 3 },
    { key: 'bigbox-stock-hall', seed: 1, cx: 2, cy: -1, cz: 3 },
    { key: 'kiosk-lot', seed: 1, cx: 6, cy: 0, cz: -2 },
    { key: 'kiosk-basement', seed: 1, cx: 6, cy: -1, cz: -2 },
    { key: 'garage-deck-core', seed: 1, cx: -1, cy: 0, cz: 6 },
    { key: 'garage-b1-core', seed: 1, cx: -1, cy: -1, cz: 6 },
    { key: 'garage-roof-core', seed: 1, cx: -1, cy: 1, cz: 6 },
    { key: 'strip-roof-bulkhead', seed: 1, cx: 1, cy: 1, cz: 2 },
    { key: 'anomaly-deja-vu', seed: 1, cx: 1, cy: 0, cz: -7 },
    { key: 'anomaly-burning-pole', seed: 1, cx: 9, cy: 0, cz: -3 },
    { key: 'anomaly-full-lot', seed: 1, cx: 9, cy: 0, cz: 5 },
    { key: 'anomaly-countdown', seed: 1, cx: -7, cy: 0, cz: 9 },
    { key: 'anomaly-odd-sodium', seed: 1, cx: 5, cy: 0, cz: 9 },
    { key: 'anomaly-dead-cluster', seed: 1, cx: -19, cy: 0, cz: 21 },
    { key: 'field-district', seed: 1, cx: -6, cy: 0, cz: 10 },
    { key: 'exit-plant-room', seed: 1, cx: 5, cy: -1, cz: -6 },
    { key: 'underpass', seed: 1, cx: 0, cy: -1, cz: 1 },
    { key: 'solid-top', seed: 1, cx: 0, cy: 2, cz: 0 },
    { key: 'solid-below', seed: 1, cx: 0, cy: -2, cz: 0 },
    { key: 'seed-5eed-spawn', seed: 0x5eed, cx: 1, cy: 0, cz: 2 },
    { key: 'seed-5eed-exit', seed: 0x5eed, cx: 11, cy: -1, cz: -5 },
  ],
  digests: null,
}
