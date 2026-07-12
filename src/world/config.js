import {
  ZONE_OFFICE,
  ZONE_PILLARS,
  ZONE_WAREHOUSE,
  WORLD_GEN_VERSION,
} from './constants.js'

// Primary designer-facing tuning surface. Generators read these values through
// the `config` passed in ctx; structural constants, deterministic salts, and
// scoring weights remain beside their implementations.
export const DEFAULT_WORLD_CONFIG = {
  version: WORLD_GEN_VERSION,

  // Domain-warped macro regions keep each style coherent across several chunks.
  // Warehouse cells touching a raw office sample become pillars, making the
  // middle style a guaranteed transition rather than a statistical hope.
  region: {
    scale: 11,
    salt: 0x5a5a,
    warpAmp: 1.15,
    octaves: 3,
    lacunarity: 2,
    gain: 0.35,
    bufferTransitions: true,
  },
  zoneBands: [
    { id: ZONE_OFFICE, max: 0.48 },
    { id: ZONE_PILLARS, max: 0.62 },
    { id: ZONE_WAREHOUSE, max: 1.01 },
  ],

  // Border reconciliation — zone-aware so the world reads as a continuation, not
  // a lattice of walled boxes. Per-zone OPENNESS (>=1 = open) drives the seam:
  //   both open   -> seam left open (halls merge); warehouse<->warehouse may get
  //                  a short wall STUB landmark.
  //   one open    -> a wide transition MOUTH (rooms open into the hall).
  //   both walled -> an internal district-plan slice or a sparse canonical
  //                  portal at a district boundary.
  border: {
    saltV: 0x1357, // vertical-seam stream
    saltH: 0x9bd7, // horizontal-seam stream
    openness: {
      [ZONE_OFFICE]: 0, // walled (rooms + partitions)
      [ZONE_PILLARS]: 1, // open (column hall)
      [ZONE_WAREHOUSE]: 1, // open (big liminal space)
    },
    mouthWidth: [3, 5], // office<->open: contiguous transition-mouth width (cells)
    thresholdDepth: 2, // cells opened behind seam doors/mouths so transitions read as rooms, not slots
    mouthSalt: 0x5e2d,
    stubChance: 0.3, // warehouse<->warehouse: chance of a short wall stub landmark
    stubLen: [1, 2], // stub length (cells)
    stubSalt: 0x71b9,
  },

  // Per-zone interior tunables.
  office: {
    roomMin: 3,
    roomMax: 8,
    minRoomArea: 6,
    minRoomWidth: 2,
    maxRoomAspect: 3,
    targetRoomCompactness: 0.5,
    braid: 0.2,
    districtChunks: 3,
    planCandidates: 4,
    targetWallFraction: 0.2,
    // Reserved corridor spines are planned before rooms across the configured
    // district (3x3 by default). Multiple cheap candidates are scored for useful
    // coverage and structural wall density.
    corridors: {
      hubRadius: 1,
      maxRoomDepth: 3,
      maxSeamRatio: 1.25,
      targetCoverage: 0.16,
    },
    portals: {
      jitter: 3,
      minSpacing: 5,
      salt: 0x25d7,
    },
  },
  pillars: { spacing: 2, phase: 0 },
  warehouse: {
    columns: { spacing: 6, chance: 0.45, salt: 0x2c91, phaseSalt: 0x19e3 },
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
    deadSalt: 0x47d3,
    deadChance: 0.18,
    corridorStep: 4,
    corridorSalt: 0x2f61,
    corridorChance: 1,
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

  // Stairs through the slab between adjacent layers (v8). A slab contract —
  // pure function of (ROOT seed, cx, cz, lower cy) — tells both layers whether
  // and where a straight-run stairwell pierces the slab. `chance` gates most
  // stairs; the fallback elects exactly one chunk per districtChunks² block per
  // slab so every floor ALWAYS has an up- and a down-stair within Chebyshev
  // 2*districtChunks-1 chunks (no stranded floors). Tests may set
  // `enabled: false` to generate plans without vertical reservations.
  stairs: {
    enabled: true,
    chance: 0.3,
    districtChunks: 4,
    salt: 0x51ab, // existence gate stream
    posSalt: 0x9d2f, // position/orientation stream
    // One transform is selected per XZ chunk column and reused by every slab
    // in that column. This varies the parity families without allowing the up
    // and down stamps realized on one floor to overlap.
    layoutSalt: 0x34d1,
    fallbackSalt: 0xfa11, // fallback-chunk election stream
  },

  // Two-floor atria ("deep rooms"). Eligible even-numbered slabs retain a
  // wide open volume with a one-cell bridge deck on the upper floor. A sparse
  // hash gate plus one eligible fallback host per 4x4 district keeps the
  // feature discoverable without turning every floor into holes. Contracts
  // reject layer-zone changes, transition halls, stairs on either room layer,
  // and the layer-0 spawn chunk before any geometry is stamped.
  multilevel: {
    enabled: true,
    chance: 0.04,
    districtChunks: 4,
    longSpan: 8,
    shortSpan: 6,
    salt: 0x6d75,
    posSalt: 0xb71d,
    fallbackSalt: 0xfa17,
  },

  // Exit / spawn clearing radius (cells).
  exit: { clearRadius: 1 },
}
