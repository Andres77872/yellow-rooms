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

  // A domain-warped field characterizes finite macro landmarks; the nested
  // room-dominance contract decides their bounded placement inside the
  // continuous office fabric.
  region: {
    scale: 11,
    salt: 0x5a5a,
    warpAmp: 1.15,
    octaves: 3,
    lacunarity: 2,
    gain: 0.35,
    bufferTransitions: true,
    // The office plan is the world's continuous "background architecture".
    // Open styles are finite landmark pockets inside 6x6-chunk districts,
    // never another unbounded terrain biome. Ordinary halls span only 1-2
    // chunks; rare hero courts may span 3-4. A one-chunk district margin and a
    // thinned checkerboard election prevent cardinally adjacent landmarks and
    // hard-cap even the exceptional volumes.
    roomDominance: {
      enabled: true,
      districtChunks: 6,
      marginChunks: 1,
      minSpanChunks: 1,
      maxSpanChunks: 2,
      heroMinSpanChunks: 3,
      heroMaxSpanChunks: 4,
      heroChance: 0.3,
      chance: 0.8,
      minOfficeShare: 0.75,
      spawnOfficeRadius: 1,
      salt: 0x4c41,
      spanSalt: 0x5350,
      heroSalt: 0x4845,
      signatureSalt: 0x5347,
      positionSalt: 0x504f,
      shapeSalt: 0x5348,
    },
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
  pillars: {
    // Landmark halls use a much wider structural bay than the old dense
    // every-other-cell lattice. Shipped macro landmarks choose a coherent
    // monumental-grid, processional-aisle, broken-bay, or court-colonnade
    // signature. `monumentalChance` remains the fallback for forced/custom
    // pillar-only profiles that have no macro descriptor.
    spacing: 4,
    phase: 0,
    monumentalChance: 0.78,
    monumentalSalt: 0x5049,
  },
  warehouse: {
    columns: { spacing: 6, chance: 0.45, salt: 0x2c91, phaseSalt: 0x19e3 },
    // Sparse straight partitions generated from global edge coordinates. Runs
    // can cross chunk seams without neighbour communication.
    fragments: { salt: 0x8f37, chance: 0.16, lineSpacing: 4, anchorStep: 9, runLen: [3, 7] },
  },

  // Fluorescent ceiling lamps on a GLOBAL module grid (seam-continuous).
  // `phase` offsets the accepted grid per zone. The pillar bay lattice and
  // phase-0 step-4 lamp grid share coordinates, so phase 1 puts pillar-hall
  // fixtures between supports rather than inside them.
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

  // Tall atria / shafts (v13). One canonical structure is elected per 4x4 XZ
  // district and 17-floor vertical band, with a deterministic district-specific
  // base phase instead of every landmark starting on floor 0. Its 22x6-cell
  // footprint crosses one chunk seam, and its inclusive height varies from 4
  // to 15 storeys; landmark top floors are capped at cy 64. Bridged
  // variants retain long decks on alternating levels; openVoid variants keep
  // every intermediate slab open. The structure plan has priority over stair
  // placement, so all consumers derive one conflict-free vertical volume.
  multilevel: {
    enabled: true,
    districtChunks: 4,
    longSpan: 22,
    shortSpan: 6,
    minLevels: 4,
    maxLevels: 15,
    verticalPeriod: 17,
    maxTopCy: 64,
    bridgeChance: 0.68,
    salt: 0x6d75,
    baseSalt: 0xba5e,
    posSalt: 0xb71d,
    fallbackSalt: 0xfa17,
    heightSalt: 0x71e7,
    kindSalt: 0xb21d,
    deckSalt: 0xd3c5,
  },

  // Interior furniture (v15): collision-real office pieces placed into room
  // cells after the lamp pass. Placement is deterministic per chunk, keeps a
  // border margin, skips doorway approaches and lamp cells, furnishes only a
  // fraction of rooms (emptiness is pacing), and rolls back any piece that
  // would sever its room's walk graph.
  furniture: {
    enabled: true,
  },

  // Exit / spawn clearing radius (cells).
  exit: { clearRadius: 1 },
}
