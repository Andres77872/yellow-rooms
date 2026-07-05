import {
  ZONE_OFFICE,
  ZONE_PILLARS,
  ZONE_WAREHOUSE,
  WORLD_GEN_VERSION,
} from './constants.js'

// Single tuning surface: every generation knob lives here, so designers edit one
// file. Generators read values via the `config` passed in ctx — they never
// import a magic number. Truly structural values (CELL, CHUNK, WALL_H, load
// radii) stay in constants.js. (This module imports only constants → no cycles.)
export const DEFAULT_WORLD_CONFIG = {
  version: WORLD_GEN_VERSION,

  // Zone selection: low-frequency value-noise field, bucketed into bands. A
  // larger `scale` => lower frequency => bigger, more coherent regions, so the
  // player stays in one style longer. Bands are ordered closed->medium->open
  // (office < pillars < warehouse), so the middle PILLARS band naturally buffers
  // office<->warehouse transitions: style changes read as a gradient.
  // Band maxes are EMPIRICAL QUANTILES of the value-noise field at chunk
  // resolution (the smoothed bilinear noise concentrates mass around 0.5, so
  // equal-width bands do NOT give equal area). 0.465 / 0.655 are the measured
  // 45th / 75th percentiles => ~45% office, ~30% pillars, ~25% warehouse.
  region: { scale: 4.5, salt: 0x5a5a },
  zoneBands: [
    { id: ZONE_OFFICE, max: 0.465 },
    { id: ZONE_PILLARS, max: 0.655 },
    { id: ZONE_WAREHOUSE, max: 1.01 },
  ],

  // Border reconciliation — zone-aware so the world reads as a continuation, not
  // a lattice of walled boxes. Per-zone OPENNESS (>=1 = open) drives the seam:
  //   both open   -> seam left open (halls merge); warehouse<->warehouse may get
  //                  a short wall STUB landmark.
  //   one open    -> a wide transition MOUTH (rooms open into the hall).
  //   both walled -> office partition with doorways snapped to a GLOBAL lattice
  //                  (doorSpacing), so openings line up across seams for miles.
  border: {
    saltV: 0x1357, // vertical-seam stream
    saltH: 0x9bd7, // horizontal-seam stream
    openness: {
      [ZONE_OFFICE]: 0, // walled (rooms + partitions)
      [ZONE_PILLARS]: 1, // open (column hall)
      [ZONE_WAREHOUSE]: 1, // open (big liminal space)
    },
    doorSpacing: 5, // fallback for older configs without office.corridors
    doorPhaseSalt: 0x33a7, // fallback phase salt for older configs
    officeMinDoors: 2, // guarantee at least this many doors on an office seam
    mouthWidth: [3, 5], // office<->open: contiguous transition-mouth width (cells)
    mouthSalt: 0x5e2d,
    stubChance: 0.3, // warehouse<->warehouse: chance of a short wall stub landmark
    stubLen: [1, 2], // stub length (cells)
    stubSalt: 0x71b9,
  },

  // Per-zone interior tunables.
  office: {
    roomMin: 3,
    roomMax: 7,
    braid: 0.35,
    // Global corridor guide lines. Office doorways and post-BSP corridor
    // carving both read this field, so routes continue across chunk borders.
    corridors: { spacing: 5, phaseSalt: 0x33a7, mouthSnap: 2 },
  },
  pillars: { spacing: 2, phase: 0 },
  warehouse: {
    colChance: 0.012,
    // Sparse straight partitions generated from global edge coordinates. Runs
    // can cross chunk seams without neighbour communication.
    fragments: { salt: 0x8f37, chance: 0.16, lineSpacing: 4, anchorStep: 9, runLen: [3, 7] },
  },

  // Fluorescent ceiling lamps on a GLOBAL module grid (seam-continuous).
  // `phase` offsets the accepted grid per zone: pillars columns sit on every
  // even global coordinate (pillars.spacing 2, phase 0), which covers the whole
  // phase-0 step-4 lamp grid — phase 1 puts pillars lamps on odd coordinates,
  // between the columns, so pillar halls actually get light.
  lamps: {
    step: 4,
    salt: 0x6c61,
    deadChance: 0.18,
    phase: {
      [ZONE_OFFICE]: 0,
      [ZONE_PILLARS]: 1,
      [ZONE_WAREHOUSE]: 0,
    },
    chance: {
      [ZONE_OFFICE]: 0.7,
      [ZONE_PILLARS]: 0.85,
      [ZONE_WAREHOUSE]: 0.5,
    },
  },

  // Exit / spawn clearing radius (cells).
  exit: { clearRadius: 1 },
}
