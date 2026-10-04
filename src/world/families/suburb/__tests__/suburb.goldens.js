// suburb golden pins (spec §11.1 item 11, §13.2 step D). The coordinates
// cover, for seed 1: the spawn chunk (the spawn tile's spine), tile (0,0)'s
// first two-storey house (its stair at storey 0, its attic at storey 1), a
// footprint-solid attic-storey chunk, the west x seam's street crossing, a
// cul-de-sac bulb, the south and north collector crossings, the anchor
// house's ground floor and attic (the exit), and one tile per anomaly class
// ('door' (-2,-1) at the doorless house, 'upstairs' (2,-1) attic, 'nine'
// (3,-1) on its numbered chunk row); for seed 0x5eed the spawn, the exit
// attic and an 'upstairs' attic. The tiles are composed by the street
// grammar (geometry.suburbPlan), so these coordinates follow its plans.
// repin-world.mjs --to <v> fills `digests` (null until R-release pins them).
export default {
  coords: [
    { key: 'spawn-1', seed: 1, cx: 1, cy: 0, cz: 0 },
    { key: 'house-stair-1', seed: 1, cx: 1, cy: 0, cz: 1 },
    { key: 'house-attic-1', seed: 1, cx: 1, cy: 1, cz: 1 },
    { key: 'solid-attic-storey-1', seed: 1, cx: 0, cy: 1, cz: 0 },
    { key: 'seam-port-west-1', seed: 1, cx: 0, cy: 0, cz: 1 },
    { key: 'bulb-1', seed: 1, cx: 0, cy: 0, cz: 2 },
    { key: 'collector-south-1', seed: 1, cx: 1, cy: 0, cz: 2 },
    { key: 'collector-north-1', seed: 1, cx: 2, cy: 0, cz: 0 },
    { key: 'exit-house-ground-1', seed: 1, cx: -8, cy: 0, cz: 4 },
    { key: 'exit-attic-1', seed: 1, cx: -8, cy: 1, cz: 4 },
    { key: 'anomaly-door-1', seed: 1, cx: -10, cy: 0, cz: -2 },
    { key: 'anomaly-upstairs-attic-1', seed: 1, cx: 12, cy: 1, cz: -1 },
    { key: 'anomaly-nine-1', seed: 1, cx: 15, cy: 0, cz: -1 },
    { key: 'spawn-5eed', seed: 0x5eed, cx: 1, cy: 0, cz: 0 },
    { key: 'exit-attic-5eed', seed: 0x5eed, cx: 12, cy: 1, cz: -2 },
    { key: 'anomaly-upstairs-attic-5eed', seed: 0x5eed, cx: 12, cy: 1, cz: 5 },
  ],
  digests: null,
}
