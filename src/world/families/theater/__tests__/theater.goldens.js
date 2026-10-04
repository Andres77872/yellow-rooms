// theater golden pins (spec §11.1 item 11, §13.2 step D), for the procedural
// theatres (every tile its own building, geometry.schemeOf). Seed 1, tile
// (0,0) is a proscenium house on chunks (0..1, 0..1), five storeys, two band
// stairwells (chunks (2,0) and (1,2)). The coordinates cover the spawn
// stalls, the stage with the ghost light, a band stairwell on the basement
// and the ground floor, the trap room, the dress circle and the loft, a
// footprint-solid chunk over the band, the out-of-range storey, the west and
// north seams, the exit tile's trap room, the four anomaly classes (seed 1:
// tile −4,−6 'upstage', −3,−6 'turned', −2,−6 'plates', 4,−6 'missing') and
// one theatre of each house class. repin-world.mjs --to <v> fills `digests`.
export default {
  coords: [
    { key: 'spawn-stalls', seed: 1, cx: 1, cy: 0, cz: 1 },
    { key: 'stage-ghost-light', seed: 1, cx: 1, cy: 0, cz: 0 },
    { key: 'band-stairwell-basement', seed: 1, cx: 2, cy: -1, cz: 0 },
    { key: 'band-stairwell-ground', seed: 1, cx: 1, cy: 0, cz: 2 },
    { key: 'trap-room', seed: 1, cx: 1, cy: -1, cz: 0 },
    { key: 'dress-circle', seed: 1, cx: 0, cy: 1, cz: 0 },
    { key: 'fly-loft', seed: 1, cx: 1, cy: 3, cz: 0 },
    { key: 'solid-over-band', seed: 1, cx: 2, cy: 2, cz: 2 },
    { key: 'solid-out-of-range', seed: 1, cx: 0, cy: 4, cz: 0 },
    { key: 'west-seam-band', seed: 1, cx: -1, cy: 0, cz: 1 },
    { key: 'north-seam-band', seed: 1, cx: 1, cy: 0, cz: -1 },
    { key: 'exit-trap-room', seed: 1, cx: -4, cy: -1, cz: 0 },
    { key: 'anomaly-upstage', seed: 1, cx: -11, cy: 0, cz: -18 },
    { key: 'anomaly-turned', seed: 1, cx: -8, cy: 0, cz: -18 },
    { key: 'anomaly-plates', seed: 1, cx: -6, cy: 1, cz: -17 },
    { key: 'anomaly-missing', seed: 1, cx: 12, cy: 0, cz: -18 },
    { key: 'seed-5eed-exit-trap-room', seed: 0x5eed, cx: 1, cy: -1, cz: -6 },
    { key: 'seed-5eed-band', seed: 0x5eed, cx: 0, cy: 0, cz: 0 },
    { key: 'class-opera-open-galleries', seed: 1, cx: -12, cy: 1, cz: -11 },
    { key: 'class-proscenium-boxes', seed: 1, cx: -8, cy: 1, cz: -11 },
    { key: 'class-small-no-circle', seed: 1, cx: 6, cy: 0, cz: -12 },
    { key: 'class-small-one-circle-top', seed: 1, cx: 0, cy: 1, cz: -4 },
  ],
  digests: null,
}
