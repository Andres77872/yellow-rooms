import {
  ZONE_OFFICE,
  ZONE_PILLARS,
  ZONE_SEWER,
  ZONE_WAREHOUSE,
  WORLD_GEN_VERSION,
} from './constants.js'
import {
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
} from './mapTypes.js'

// Atomic active-family release evidence. These values are deliberately pinned
// rather than derived from the current constants so a later version/config/
// corpus change fails closed until every namespace is regenerated together.
export const SEWER_RELEASE_EVIDENCE = Object.freeze({
  family: MAP_FAMILY_SEWER,
  byteImpact: 'changed-output',
  previousVersion: 22,
  previousFamilyRepresentativeDigest: 'bca50434c1807e96c4726cb616a401d791a57262ce4fbcd12853726bbef02c94',
  previousFamilyCorpusDigest: 'afff7d034fd31f89c14f4489a8a1e1514f029c79e6f67986f1d5fc36e961a146',
  generatorVersion: 23,
  globalGoldenDigest: 'd48bd356362db676ec09ff973ab5c7d37cd4ac8d29a58e2317d22ced43cffe14',
  maximumHeightGoldenDigest: 'b2d74bc8f946b57963c229200170a39d94310679f5820a49ced8dcaed431c151',
  familyRepresentativeDigest: '30147892c1c8202df42606804d5a40515ed3f3bd3244dbd37cafd8ba7da71234',
  familyCorpusDigest: '93f0845509f5d44d30716e308a4fba2fcd9fda7f81bddf5f3f85efec29d5a01b',
  profileIdentity: 'sewer-forced-audit:loops-2:right-0.65:lamp-2-0.35',
  seedDerivation: 'hashStr("audit-sewer-N#1")',
  affectsMaximumHeight: false,
})

export const TOWER_RELEASE_EVIDENCE = Object.freeze({
  family: MAP_FAMILY_TOWER,
  byteImpact: 'changed-output',
  previousVersion: 22,
  previousFamilyRepresentativeDigest: '5c519c2b2c7fad91e3704b138ba480cfeb62bb8005519bc08e5d2fd0eaa02c30',
  previousFamilyCorpusDigest: 'ca6c3dadc821002428f33f7205a10a34679b8a8c95c8119ceecef0c4218261cc',
  generatorVersion: 23,
  globalGoldenDigest: 'd48bd356362db676ec09ff973ab5c7d37cd4ac8d29a58e2317d22ced43cffe14',
  maximumHeightGoldenDigest: 'b2d74bc8f946b57963c229200170a39d94310679f5820a49ced8dcaed431c151',
  familyRepresentativeDigest: 'a66afb4d7dc55f42e35b262cd50c6297ed621b58352e3f84c73c504ddc3533e3',
  familyCorpusDigest: '34d1e8737670af9090b8882f0f469f3828f6365a9f5e797da94b30f3e5ef9fb8',
  profileIdentity: 'tower-forced-audit:levels-3:participants-2:skybridge-1',
  seedDerivation: 'fixed-root-seeds(0x5a17,0x7157,0xc0ffee)',
  affectsMaximumHeight: true,
})

export const LATTICE_RELEASE_EVIDENCE = Object.freeze({
  family: MAP_FAMILY_LATTICE,
  byteImpact: 'changed-output',
  previousVersion: 22,
  previousFamilyRepresentativeDigest: '5329c9cb0be7489bd35e29036f5a5881391d9f72d0044b2e41b5f1eb4c7b641b',
  previousFamilyCorpusDigest: 'aa43bdadb2892f8450c6a4cf4ee2d461013f2e940220d0540f615bb6a0f41468',
  generatorVersion: 23,
  globalGoldenDigest: 'd48bd356362db676ec09ff973ab5c7d37cd4ac8d29a58e2317d22ced43cffe14',
  maximumHeightGoldenDigest: 'b2d74bc8f946b57963c229200170a39d94310679f5820a49ced8dcaed431c151',
  familyRepresentativeDigest: '1c75114c9a666e15c2d8963ab8762a0c394545d221ca67b46889201ad59e9604',
  familyCorpusDigest: '9afa537be75ec0e0569214748d508c1be2a53545955949485c9664c8cf099dc3',
  profileIdentity: 'lattice-forced-audit:levels-3:district-3:anchors-5:cycles-0.08-0.15:exposure-5-20:cues-8',
  seedDerivation: 'hashStr("audit-lattice-N#1"), N=0..2',
  affectsMaximumHeight: true,
})

// Hotel first emits at 23, so its previous-namespace digests are zero
// sentinels: there is no earlier hotel corpus to pin, only the fail-closed
// previous/candidate inequality to preserve.
export const HOTEL_RELEASE_EVIDENCE = Object.freeze({
  family: MAP_FAMILY_HOTEL,
  byteImpact: 'first-emission',
  previousVersion: 22,
  previousFamilyRepresentativeDigest: '0000000000000000000000000000000000000000000000000000000000000000',
  previousFamilyCorpusDigest: '0000000000000000000000000000000000000000000000000000000000000000',
  generatorVersion: 23,
  globalGoldenDigest: 'd48bd356362db676ec09ff973ab5c7d37cd4ac8d29a58e2317d22ced43cffe14',
  maximumHeightGoldenDigest: 'b2d74bc8f946b57963c229200170a39d94310679f5820a49ced8dcaed431c151',
  familyRepresentativeDigest: 'b17bd9eba5dc326ecdfee6a79c3a0601ae725abc51a7a6741ebdb7985a347a7a',
  familyCorpusDigest: 'a33e448b9d0a640423afd71c5e6951892f40888a5212f0d7c364480e2fb82d74',
  profileIdentity: 'hotel-forced-audit',
  seedDerivation: 'hashStr("audit-hotel-N#1")',
  affectsMaximumHeight: false,
})

// Primary designer-facing tuning surface. Generators read these values through
// the `config` passed in ctx; structural constants, deterministic salts, and
// scoring weights remain beside their implementations.
export const DEFAULT_WORLD_CONFIG = {
  version: WORLD_GEN_VERSION,

  // Family selection remains explicit. Sewer, Tower, and Lattice passed their
  // independent release gates while Office remains the default selection.
  mapFamily: {
    selected: MAP_FAMILY_OFFICE,
    profiles: {
      [MAP_FAMILY_OFFICE]: {
        enabled: true,
      },
      [MAP_FAMILY_SEWER]: {
        enabled: true,
        zoneBands: [{ id: ZONE_SEWER, max: 1.01 }],
        maxLoops: 2,
        rightTurnChance: 0.65,
        lampPhase: 2,
        lampChance: 0.35,
      },
      [MAP_FAMILY_TOWER]: {
        enabled: true,
        levels: 3,
        participants: 2,
        skybridgeLevelOffset: 1,
      },
      [MAP_FAMILY_LATTICE]: {
        enabled: true,
        districtChunks: 3,
        levels: 3,
        anchorsPerAxis: 5,
        cycleRate: [0.08, 0.15],
        defaultExposureM: 5,
        maxExposureM: 20,
        minimumCueCells: 8,
      },
      // Hotel: the residential fabric family (additive at world-gen 23).
      // Structurally it is the office pipeline (district plans, stairs,
      // atria); identity comes from the hotel room catalog (rooms/catalog.js)
      // and palette, so the profile carries no knobs beyond activation —
      // same contract as Office.
      [MAP_FAMILY_HOTEL]: {
        enabled: true,
      },
    },
  },

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
  // a lattice of walled boxes. Explicit pair modes override scalar openness for
  // adjacency-dependent seams. Other pairs retain the established fallback:
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
    pairModes: {
      [ZONE_OFFICE]: { [ZONE_SEWER]: 'mouth' },
      [ZONE_PILLARS]: { [ZONE_SEWER]: 'open' },
      [ZONE_WAREHOUSE]: { [ZONE_SEWER]: 'open' },
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
    // Iterative fallback (v22): when no base candidate satisfies the hard
    // plan constraints, further salted candidates are drawn up to this limit
    // before the district fails — same finite-retry discipline as the sewer
    // chunk candidates.
    planCandidateLimit: 12,
    // Procedural room shapes (v22): fraction of BSP leaves that exchange a
    // corner with a neighbour (L-rooms + alcoves), and the largest cut arm.
    roomShapeChance: 0.5,
    roomShapeMaxCut: 3,
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
