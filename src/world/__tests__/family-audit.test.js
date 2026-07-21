import { describe, expect, it } from 'vitest'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { CHUNK, WORLD_GEN_VERSION, cIdx } from '../constants.js'
import { worldConfigForFamily } from '../mapFamily.js'
import {
  CELL_BRIDGE,
  CELL_VOID,
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  WALL_PLAIN,
  WALL_RAIL,
} from '../mapTypes.js'
import { buildChunk } from '../pipeline.js'
import { structureAt } from '../structures/contract.js'

const FAMILY_AUDIT_MODULE = '../familyAudit.js'
const NEXT_VERSION = WORLD_GEN_VERSION + 1
const OFFICE_SHARE_FLOOR = 0.75
const REQUIRED_ROWS = ['office', 'sewer', 'tower', 'lattice', 'hotel']
const SEWER_MODULE_KINDS = Object.freeze([
  't',
  'lBend',
  'dryStretch',
  'chamberSmall',
  'chamberLarge',
  'manholeUp',
  'manholeDown',
])
const DEFERRED_SEWER_MODULE_KINDS = Object.freeze([
  'uBend',
  'cross',
  'floodedStretch',
  'ventShaft',
])
const TOWER_STRUCTURE_KIND = 'towerSkybridge'
const LATTICE_STRUCTURE_KIND = 'latticeDistrict'
const LATTICE_FLOORS = Object.freeze([0, 1, 2, 3, 4])
const LATTICE_AUDIT_DIMENSIONS = Object.freeze([
  'polygon',
  'anchors',
  'backbone',
  'cycles',
  'orientations',
  'allFloors',
  'stamping',
  'exposure',
  'boundaryCues',
  'plainWalls',
  'guards',
  'reachability',
  'lethalVoid',
])
const TOWER_LANDMARK_KINDS = Object.freeze([
  'signage',
  'clock',
  'litAccent',
  'door',
  'fixture',
])
const ENABLED_PROFILES = Object.freeze([
  { family: 'office', enabled: true },
  { family: 'tower', enabled: true },
])

// Foundation audit coverage intentionally exercises only the shared canonical
// structure core. It is not a complete or activatable tower emitter fixture;
// tower-specific decks, approaches, guards, sockets, and safety arrive later.
function sharedCoreTowerDescriptor(overrides = {}) {
  const participants = overrides.participants ?? [
    { cx: 0, cz: 0 },
    { cx: 1, cz: 0 },
  ]
  return {
    id: 401,
    family: 'tower',
    kind: 'towerSkybridge',
    district: { x: 0, z: 0, size: 2 },
    baseCy: 0,
    topCy: 2,
    levelCount: 3,
    hasRoom: true,
    anchor: { ...participants[0] },
    globalBounds: { x0: 2, z0: 3, x1: 25, z1: 10 },
    verticalLinks: [],
    decks: [],
    landmarkSockets: [],
    ...overrides,
    participants,
  }
}

function participantStructure(descriptor, participant, overrides = {}) {
  return {
    ...participant,
    family: descriptor.family,
    kind: descriptor.kind,
    id: descriptor.id,
    descriptor,
    ...overrides,
  }
}

function sharedCoreTowerFixture() {
  const descriptor = sharedCoreTowerDescriptor()
  return {
    descriptors: [descriptor],
    participantStructures: descriptor.participants.map((participant) =>
      participantStructure(descriptor, participant)
    ),
  }
}

function emittedKinds() {
  return [
    {
      family: 'office',
      kind: 'officeMultilevel',
      fixtures: [],
    },
    {
      family: 'tower',
      kind: 'towerSkybridge',
      // Reusing existing cells, rails, and apertures is deliberately not
      // registration evidence (R12-S03).
      reusedVocabulary: ['CELL_BRIDGE', 'WALL_RAIL', 'multilevel'],
      fixtures: [sharedCoreTowerFixture()],
    },
  ]
}

function sewerDescriptor() {
  return {
    family: 'sewer',
    id: 701,
    bounds: { x0: 0, z0: 0, x1: 13, z1: 13 },
    trunkRoot: { lx: 1, lz: 6 },
    modules: [
      { kind: 'dryStretch', lx: 1, lz: 6, dir: 'east' },
      { kind: 't', lx: 3, lz: 6, dir: 'east' },
      { kind: 'lBend', lx: 5, lz: 6, dir: 'south' },
      { kind: 'chamberSmall', lx: 5, lz: 8, dir: 'south' },
      { kind: 'chamberLarge', lx: 8, lz: 8, dir: 'east' },
      { kind: 'manholeUp', lx: 9, lz: 8, dir: 'east' },
      { kind: 'manholeDown', lx: 11, lz: 8, dir: 'east' },
    ],
    treeEdges: [
      { a: 0, b: 1 },
      { a: 1, b: 2 },
      { a: 2, b: 3 },
      { a: 3, b: 4 },
      { a: 4, b: 5 },
      { a: 5, b: 6 },
    ],
    loopEdges: [{ a: 1, b: 4 }],
    eligibleNonTreeLinks: 4,
  }
}

function sewerFixture() {
  const descriptor = sewerDescriptor()
  return {
    descriptors: [descriptor],
    sewerStructures: [
      {
        family: 'sewer',
        kind: 'sewer',
        id: descriptor.id,
        descriptor,
        profile: {
          forcedProfile: true,
          zoneBands: [{ id: 3, max: 1.01 }],
          maxLoops: 2,
          rightTurnChance: 0.65,
        },
        // This is independent raster evidence. A self-consistent descriptor
        // must not hide a disconnected generated sewer (design.md:345).
        raster: {
          traversableModules: descriptor.modules.map((_, index) => index),
          links: [...descriptor.treeEdges, ...descriptor.loopEdges].map((edge) => ({
            ...edge,
          })),
        },
        lighting: {
          eligibleLocations: [
            { lx: 2, lz: 6 },
            { lx: 6, lz: 8 },
            { lx: 10, lz: 8 },
          ],
          litLocations: [{ lx: 6, lz: 8 }],
        },
        seams: {
          office: 'mouth',
          openHall: 'open',
        },
        risers: {
          up: true,
          down: true,
        },
        // Report-only aggregate: generation uses the configured 0.65 policy,
        // but finite-corpus observed frequency is not an MVP audit gate.
        observedRightTurnRate: 0.4,
      },
    ],
  }
}

function sewerEmittedKinds(fixtures = [sewerFixture()]) {
  return [
    {
      family: 'office',
      kind: 'officeMultilevel',
      fixtures: [],
    },
    {
      family: 'sewer',
      kind: 'sewer',
      fixtures,
    },
  ]
}

function sewerProfiles() {
  return REQUIRED_ROWS.map((family) => ({
    family,
    enabled: family === 'office' || family === 'sewer',
  }))
}

function towerLandmarkSockets() {
  return [
    {
      slot: 'anchorFloor',
      kind: 'signage',
      gx: 5,
      gz: 4,
      cy: 0,
      axis: 'x',
      side: -1,
      salt: 1101,
    },
    {
      slot: 'anchorFloor',
      kind: 'clock',
      gx: 6,
      gz: 4,
      cy: 1,
      axis: 'x',
      side: -1,
      salt: 1102,
    },
    {
      slot: 'anchorFloor',
      kind: 'litAccent',
      gx: 7,
      gz: 4,
      cy: 2,
      axis: 'x',
      side: -1,
      salt: 1103,
    },
    {
      slot: 'bridgeApproach',
      kind: 'door',
      gx: 13,
      gz: 7,
      cy: 1,
      axis: 'x',
      side: -1,
      salt: 1104,
    },
    {
      slot: 'bridgeApproach',
      kind: 'fixture',
      gx: 18,
      gz: 7,
      cy: 1,
      axis: 'x',
      side: 1,
      salt: 1105,
    },
  ]
}

function towerDescriptor(overrides = {}) {
  const participants = overrides.participants ?? [
    { cx: 0, cz: 0 },
    { cx: 1, cz: 0 },
  ]
  const id = overrides.id ?? 0x7042
  const deckCells = Array.from({ length: 6 }, (_, index) => ({
    gx: 13 + index,
    gz: 7,
  }))
  return sharedCoreTowerDescriptor({
    id,
    participants,
    bridgeAxis: 'x',
    verticalLinks: [
      {
        lowerCy: 0,
        cx: 0,
        cz: 0,
        stair: {
          dir: 1,
          landing: { lx: 4, lz: 5 },
          run: [{ lx: 5, lz: 5 }, { lx: 6, lz: 5 }],
          exit: { lx: 7, lz: 5 },
        },
      },
      {
        lowerCy: 1,
        cx: 1,
        cz: 0,
        stair: {
          dir: 3,
          landing: { lx: 10, lz: 8 },
          run: [{ lx: 9, lz: 8 }, { lx: 8, lz: 8 }],
          exit: { lx: 7, lz: 8 },
        },
      },
    ],
    decks: [{
      levelCy: 1,
      lowerCy: 0,
      globalBridgeLine: 7,
      globalBounds: { x0: 13, z0: 7, x1: 18, z1: 7 },
      globalCells: deckCells,
    }],
    landmarkSockets: towerLandmarkSockets(),
    ...overrides,
  })
}

function towerFixture() {
  const descriptor = towerDescriptor()
  const deck = descriptor.decks[0]
  const half = {
    id: descriptor.id,
    family: 'tower',
    lowerCy: 0,
    cells: [{ lx: 8, lz: 8, deathYmm: -7200 }],
  }
  return {
    descriptors: [descriptor],
    participantStructures: descriptor.participants.map((participant) =>
      participantStructure(descriptor, participant)
    ),
    stamping: {
      descriptorId: descriptor.id,
      floorSlices: descriptor.participants.flatMap((participant) =>
        [0, 1, 2].map((cy) => ({
          ...participant,
          cy,
          surface: 'enclosedTower',
        }))
      ),
      skybridge: {
        surface: 'skybridgeDeck',
        id: descriptor.id,
        levelCy: deck.levelCy,
        deckCells: structuredClone(deck.globalCells),
        approaches: [
          {
            ...descriptor.participants[0],
            id: descriptor.id,
            levelCy: deck.levelCy,
            gx: deck.globalBounds.x0,
            gz: deck.globalBridgeLine,
            socketSalt: 1104,
          },
          {
            ...descriptor.participants[1],
            id: descriptor.id,
            levelCy: deck.levelCy,
            gx: deck.globalBounds.x1,
            gz: deck.globalBridgeLine,
            socketSalt: 1105,
          },
        ],
        guards: [
          { side: 'north', continuous: true },
          { side: 'south', continuous: true },
        ],
      },
      lethalVoid: {
        lethalVoidUp: structuredClone(half),
        lethalVoidDown: structuredClone(half),
        plane: {
          id: half.id,
          family: half.family,
          deathYmm: half.cells[0].deathYmm,
        },
      },
    },
  }
}

function towerVoidSafety(profileIdentity = 'tower-fixture-v1') {
  const half = {
    id: 0x7042,
    family: 'tower',
    lowerCy: 0,
    cells: [{ lx: 8, lz: 8, deathYmm: -7200 }],
  }
  const baseline = {
    version: NEXT_VERSION,
    seedText: 'tower-audit-safety',
    level: 4,
    mapFamily: 'tower',
    profileIdentity,
    initialDigest: `tower-audit-safety:v${NEXT_VERSION}`,
  }
  return {
    hardVoidDeath: {
      ok: true,
      deathReason: 'void',
      callbackCount: 1,
      plane: { id: half.id, family: half.family, deathYmm: half.cells[0].deathYmm },
      halves: {
        lethalVoidUp: structuredClone(half),
        lethalVoidDown: structuredClone(half),
      },
      ownership: { id: half.id, family: half.family, lowerCy: half.lowerCy },
    },
    deterministicReset: {
      ok: true,
      before: structuredClone(baseline),
      after: structuredClone(baseline),
    },
  }
}

function towerEmittedKinds(fixtures = [towerFixture()]) {
  return [
    {
      family: 'office',
      kind: 'officeMultilevel',
      fixtures: [],
    },
    {
      family: 'tower',
      kind: TOWER_STRUCTURE_KIND,
      socketKinds: [...TOWER_LANDMARK_KINDS],
      reusedVocabulary: ['CELL_BRIDGE', 'WALL_RAIL', 'multilevel'],
      fixtures,
    },
  ]
}

function towerProfiles() {
  return REQUIRED_ROWS.map((family) => ({
    family,
    enabled: family === 'office' || family === 'tower',
  }))
}

const LATTICE_AUDIT_SEED = 0x1a771ce

function forcedLatticeConfig() {
  const base = structuredClone(DEFAULT_WORLD_CONFIG)
  base.mapFamily.profiles[MAP_FAMILY_LATTICE].enabled = true
  return worldConfigForFamily(MAP_FAMILY_LATTICE, base)
}

function findLatticeDescriptor(seed, config) {
  for (let cy = -24; cy <= 24; cy++) {
    for (let cz = -4; cz <= 4; cz++) {
      for (let cx = -4; cx <= 4; cx++) {
        const descriptor = structureAt(seed, cx, cz, cy, config)
        if (
          descriptor?.family === MAP_FAMILY_LATTICE &&
          descriptor.kind === LATTICE_STRUCTURE_KIND &&
          descriptor.hasRoom === true
        ) return descriptor
      }
    }
  }
  throw new Error(`forced Lattice audit seed ${seed} has no bounded fixture`)
}

function latticeFixture(seed = LATTICE_AUDIT_SEED) {
  const config = forcedLatticeConfig()
  const descriptor = findLatticeDescriptor(seed, config)
  const chunks = new Map()
  for (let cy = descriptor.baseCy; cy <= descriptor.topCy; cy++) {
    for (const participant of descriptor.participants) {
      const data = buildChunk(seed, participant.cx, cy, participant.cz, config)
      chunks.set(`${participant.cx},${cy},${participant.cz}`, data)
    }
  }
  return { seed, config, chunks }
}

function latticeDescriptorFromFixture(fixture) {
  return fixture.chunks.values().next().value?.structure ?? null
}

function replaceLatticeDescriptor(fixture, damage) {
  const descriptor = structuredClone(latticeDescriptorFromFixture(fixture))
  damage(descriptor)
  for (const data of fixture.chunks.values()) data.structure = descriptor
  return descriptor
}

function latticeChunkAt(fixture, cx, cy, cz) {
  return fixture.chunks.get(`${cx},${cy},${cz}`) ?? null
}

function latticeEdgeState(fixture, edge, cy) {
  if (edge.axis === 'v') {
    const cx = Math.floor(edge.gx / CHUNK)
    const cz = Math.floor(edge.gz / CHUNK)
    const data = latticeChunkAt(fixture, cx, cy, cz)
    return data && {
      data,
      wall: data.vAt(edge.gx - cx * CHUNK, edge.gz - cz * CHUNK),
      passage: data.passageVAt(edge.gx - cx * CHUNK, edge.gz - cz * CHUNK),
      feature: data.wallFeatureVAt(edge.gx - cx * CHUNK, edge.gz - cz * CHUNK),
    }
  }
  const cx = Math.floor(edge.gx / CHUNK)
  const cz = Math.floor(edge.gz / CHUNK)
  const data = latticeChunkAt(fixture, cx, cy, cz)
  return data && {
    data,
    wall: data.hAt(edge.gx - cx * CHUNK, edge.gz - cz * CHUNK),
    passage: data.passageHAt(edge.gx - cx * CHUNK, edge.gz - cz * CHUNK),
    feature: data.wallFeatureHAt(edge.gx - cx * CHUNK, edge.gz - cz * CHUNK),
  }
}

function setLatticeEdge(fixture, edge, cy, wall, passage, feature) {
  const state = latticeEdgeState(fixture, edge, cy)
  if (!state) throw new Error('Lattice test edge falls outside generated fixture')
  if (edge.axis === 'v') {
    state.data.setV(
      edge.gx - state.data.cx * CHUNK,
      edge.gz - state.data.cz * CHUNK,
      wall,
      passage,
      feature
    )
  } else {
    state.data.setH(
      edge.gx - state.data.cx * CHUNK,
      edge.gz - state.data.cz * CHUNK,
      wall,
      passage,
      feature
    )
  }
}

function chamberPerimeter(anchor) {
  return [
    ...Array.from({ length: 3 }, (_, offset) => ({
      axis: 'h', gx: anchor.gx - 1 + offset, gz: anchor.gz - 1,
    })),
    ...Array.from({ length: 3 }, (_, offset) => ({
      axis: 'v', gx: anchor.gx + 2, gz: anchor.gz - 1 + offset,
    })),
    ...Array.from({ length: 3 }, (_, offset) => ({
      axis: 'h', gx: anchor.gx - 1 + offset, gz: anchor.gz + 2,
    })),
    ...Array.from({ length: 3 }, (_, offset) => ({
      axis: 'v', gx: anchor.gx - 1, gz: anchor.gz - 1 + offset,
    })),
  ]
}

function damageLatticeCueRails(fixture, retainedRails) {
  const descriptor = latticeDescriptorFromFixture(fixture)
  const anchor = descriptor.anchors.find((candidate) =>
    chamberPerimeter(candidate).filter((edge) =>
      latticeEdgeState(fixture, edge, candidate.levelCy)?.feature === WALL_RAIL
    ).length > retainedRails
  )
  const railEdges = chamberPerimeter(anchor).filter((edge) =>
    latticeEdgeState(fixture, edge, anchor.levelCy)?.feature === WALL_RAIL
  )
  for (const edge of railEdges.slice(retainedRails)) {
    setLatticeEdge(fixture, edge, anchor.levelCy, 0, PASSAGE_WIDE, WALL_PLAIN)
  }
}

function damageLatticePlainSides(fixture) {
  const descriptor = latticeDescriptorFromFixture(fixture)
  const anchor = descriptor.anchors[0]
  const sides = [
    chamberPerimeter(anchor).slice(0, 3),
    chamberPerimeter(anchor).slice(3, 6),
    chamberPerimeter(anchor).slice(6, 9),
  ]
  for (const edge of sides.flat()) {
    setLatticeEdge(fixture, edge, anchor.levelCy, 1, PASSAGE_WALL, WALL_PLAIN)
  }
}

function damageLatticeGuard(fixture) {
  const descriptor = latticeDescriptorFromFixture(fixture)
  for (const edge of descriptor.edges) {
    for (const cell of edge.cells) {
      const data = latticeChunkAt(
        fixture,
        Math.floor(cell.gx / CHUNK),
        cell.cy,
        Math.floor(cell.gz / CHUNK)
      )
      if (!data) continue
      const lx = cell.gx - data.cx * CHUNK
      const lz = cell.gz - data.cz * CHUNK
      if (data.cellKind[cIdx(lx, lz)] !== CELL_BRIDGE) continue
      for (const boundary of [
        { axis: 'v', gx: cell.gx, gz: cell.gz },
        { axis: 'v', gx: cell.gx + 1, gz: cell.gz },
        { axis: 'h', gx: cell.gx, gz: cell.gz },
        { axis: 'h', gx: cell.gx, gz: cell.gz + 1 },
      ]) {
        const state = latticeEdgeState(fixture, boundary, cell.cy)
        if (state?.wall === 1 && state.feature === WALL_RAIL) {
          setLatticeEdge(fixture, boundary, cell.cy, 0, PASSAGE_WIDE, WALL_PLAIN)
          return
        }
      }
    }
  }
  throw new Error('generated Lattice fixture has no guarded bridge boundary')
}

function damageLatticeApproach(fixture) {
  const descriptor = latticeDescriptorFromFixture(fixture)
  for (const anchor of descriptor.anchors) {
    const open = chamberPerimeter(anchor).find((edge) => {
      const state = latticeEdgeState(fixture, edge, anchor.levelCy)
      return state?.wall === 0 && state.passage !== PASSAGE_WALL
    })
    if (!open) continue
    setLatticeEdge(fixture, open, anchor.levelCy, 1, PASSAGE_WALL, WALL_RAIL)
    return
  }
  throw new Error('generated Lattice fixture has no open chamber approach')
}

function damageLatticeDeathPlane(fixture) {
  for (const data of fixture.chunks.values()) {
    const upper = latticeChunkAt(fixture, data.cx, data.cy + 1, data.cz)
    if (!data.lethalVoidUp || !upper?.lethalVoidDown) continue
    const up = structuredClone(data.lethalVoidUp)
    const down = structuredClone(upper.lethalVoidDown)
    up.cells[0].deathYmm += 1000
    down.cells[0].deathYmm += 1000
    data.lethalVoidUp = up
    upper.lethalVoidDown = down
    return
  }
  throw new Error('generated Lattice fixture has no matched lethal pair')
}

function latticeVoidSafety(fixture, profileIdentity = 'lattice-forced-audit-v17') {
  const descriptor = latticeDescriptorFromFixture(fixture)
  let lower = null
  let upper = null
  for (const data of fixture.chunks.values()) {
    const candidate = latticeChunkAt(fixture, data.cx, data.cy + 1, data.cz)
    if (data.lethalVoidUp && candidate?.lethalVoidDown) {
      lower = data
      upper = candidate
      break
    }
  }
  if (!lower || !upper) throw new Error('generated Lattice fixture has no lethal pair')
  const half = lower.lethalVoidUp
  const baseline = {
    version: WORLD_GEN_VERSION,
    seedText: 'lattice-audit-safety',
    level: 5,
    mapFamily: 'lattice',
    profileIdentity,
    initialDigest: `lattice-audit-safety:v${WORLD_GEN_VERSION}`,
  }
  return {
    hardVoidDeath: {
      ok: true,
      deathReason: 'void',
      callbackCount: 1,
      plane: {
        id: half.id,
        family: half.family,
        deathYmm: half.cells[0].deathYmm,
      },
      halves: {
        lethalVoidUp: structuredClone(half),
        lethalVoidDown: structuredClone(upper.lethalVoidDown),
      },
      ownership: {
        id: descriptor.id,
        family: descriptor.family,
        lowerCy: half.lowerCy,
      },
    },
    deterministicReset: {
      ok: true,
      before: structuredClone(baseline),
      after: structuredClone(baseline),
    },
  }
}

function latticeEmittedKinds(fixtures = [latticeFixture()]) {
  return [
    {
      family: 'office',
      kind: 'officeMultilevel',
      fixtures: [],
    },
    {
      family: 'lattice',
      kind: LATTICE_STRUCTURE_KIND,
      auditDimensions: [...LATTICE_AUDIT_DIMENSIONS],
      reusedVocabulary: ['CELL_BRIDGE', 'CELL_VOID', 'WALL_RAIL', 'multilevel'],
      fixtures,
    },
  ]
}

function latticeProfiles() {
  return REQUIRED_ROWS.map((family) => ({
    family,
    enabled: family === 'office',
  }))
}

function hotelEmittedKinds() {
  return [
    {
      family: 'office',
      kind: 'officeMultilevel',
      fixtures: [],
    },
    {
      family: 'hotel',
      kind: 'officeMultilevel',
      fixtures: [],
    },
  ]
}

function hotelProfiles() {
  return REQUIRED_ROWS.map((family) => ({
    family,
    enabled: family === 'office' || family === 'hotel',
  }))
}

function hotelFamilyRows() {
  const rows = familyRows()
  const hotel = rows.find((row) => row.family === 'hotel')
  Object.assign(hotel, {
    enabled: true,
    forcedProfile: true,
    profileIdentity: 'hotel-forced-audit',
    pins: { family: true, maximumHeight: null },
    corpus: {
      seeds: 4,
      chunks: 108,
      officeChunks: 0,
      determinism: true,
      layered: true,
    },
  })
  return rows
}

function familyRows() {
  return [
    {
      family: 'office',
      enabled: true,
      forcedProfile: false,
      generatorVersion: NEXT_VERSION,
      seedDerivation: 'hashStr("audit-N#1")',
      pins: { global: true, maximumHeight: true },
      corpus: {
        seeds: 8,
        chunks: 80,
        officeChunks: 64,
        officeShare: 0.8,
        continuity: true,
        layered: true,
      },
    },
    {
      family: 'sewer',
      enabled: false,
      forcedProfile: true,
      generatorVersion: NEXT_VERSION,
      profileIdentity: 'sewer-disabled',
      seedDerivation: 'hashStr("audit-sewer-N#1")',
      pins: { family: false, maximumHeight: null },
      corpus: { seeds: 0, chunks: 0, determinism: true, layered: true },
    },
    {
      family: 'tower',
      enabled: true,
      forcedProfile: true,
      generatorVersion: NEXT_VERSION,
      profileIdentity: 'tower-fixture-v1',
      seedDerivation: 'hashStr("audit-tower-N#1")',
      pins: { family: true, maximumHeight: true },
      corpus: {
        seeds: 4,
        chunks: 200,
        officeChunks: 0,
        determinism: true,
        layered: true,
        familyMetrics: {},
      },
    },
    {
      family: 'lattice',
      enabled: false,
      forcedProfile: true,
      generatorVersion: NEXT_VERSION,
      profileIdentity: 'lattice-disabled',
      seedDerivation: 'hashStr("audit-lattice-N#1")',
      pins: { family: false, maximumHeight: null },
      corpus: { seeds: 0, chunks: 0, determinism: true, layered: true },
    },
    {
      family: 'hotel',
      enabled: false,
      forcedProfile: true,
      generatorVersion: NEXT_VERSION,
      profileIdentity: 'hotel-disabled',
      seedDerivation: 'hashStr("audit-hotel-N#1")',
      pins: { family: false, maximumHeight: null },
      corpus: { seeds: 0, chunks: 0, determinism: true, layered: true },
    },
  ]
}

function sewerFamilyRows() {
  const rows = familyRows()
  const sewer = rows.find((row) => row.family === 'sewer')
  Object.assign(sewer, {
    enabled: true,
    forcedProfile: true,
    profileIdentity: 'sewer-fixture-v1',
    seedDerivation: 'hashStr("audit-sewer-N#1")',
    pins: { family: true, maximumHeight: null },
    corpus: {
      seeds: 4,
      chunks: 200,
      officeChunks: 0,
      determinism: true,
      layered: true,
      familyMetrics: {
        moduleCoverage: [...SEWER_MODULE_KINDS],
        deferredModules: 0,
        unreachableModules: 0,
        loops: { inserted: 1, budget: 2, eligibleNonTreeLinks: 4 },
        lights: { eligible: 3, lit: 1, unlit: 2 },
        seams: { office: 'mouth', openHall: 'open' },
        descriptorFailures: 0,
        observedRightTurnRate: 0.4,
      },
    },
  })

  const tower = rows.find((row) => row.family === 'tower')
  Object.assign(tower, {
    enabled: false,
    profileIdentity: 'tower-disabled',
    pins: { family: false, maximumHeight: null },
    corpus: { seeds: 0, chunks: 0, determinism: true, layered: true },
  })

  return rows
}

function towerFamilyRows() {
  const rows = familyRows()
  const tower = rows.find((row) => row.family === 'tower')
  tower.corpus.familyMetrics = {
    participantCardinality: 2,
    floorCount: 3,
    deckCount: 1,
    approaches: { expected: 2, matched: 2 },
    connectedFloors: 3,
    socketKinds: [...TOWER_LANDMARK_KINDS],
    socketCoverage: { anchorFloors: [0, 1, 2], bridgeApproaches: 2 },
    guardFailures: 0,
    descriptorFailures: 0,
    enclosedTowerSlices: 6,
    skybridgeDecks: 1,
    voidSafety: towerVoidSafety(tower.profileIdentity),
  }
  return rows
}

function latticeFamilyRows(fixture = latticeFixture()) {
  const rows = familyRows()
  const profileIdentity = 'lattice-forced-audit-v17'
  const tower = rows.find((row) => row.family === 'tower')
  Object.assign(tower, {
    enabled: false,
    profileIdentity: 'tower-disabled-in-lattice-fixture',
    pins: { family: false, maximumHeight: null },
    corpus: { seeds: 0, chunks: 0, determinism: true, layered: true },
  })

  const lattice = rows.find((row) => row.family === 'lattice')
  Object.assign(lattice, {
    enabled: false,
    forcedProfile: true,
    profileIdentity,
    generatorVersion: WORLD_GEN_VERSION,
    seedDerivation: 'fixed-root-seed(0x1a771ce)',
    pins: { family: false, maximumHeight: false },
    corpus: {
      seeds: 1,
      chunks: fixture.chunks.size,
      officeChunks: 0,
      determinism: true,
      layered: true,
      familyMetrics: {
        // Geometry metrics are deliberately omitted here. The Lattice kind
        // adapter must derive them from canonical ChunkData and raster evidence
        // rather than trusting caller-authored row DTOs.
        voidSafety: latticeVoidSafety(fixture, profileIdentity),
      },
    },
  })
  return rows
}

async function plannedFamilyAudit() {
  let api
  try {
    api = await import(/* @vite-ignore */ FAMILY_AUDIT_MODULE)
  } catch (cause) {
    throw new Error(
      `task-1.3 RED: planned module ${FAMILY_AUDIT_MODULE} is not implemented`,
      { cause }
    )
  }

  expect(
    api.FAMILY_AUDIT_ADAPTERS,
    'explicit family/kind adapter registry is not implemented'
  ).toBeTypeOf('object')
  expect(
    api.auditFamilyCompleteness,
    'family row and activation completeness evaluator is not implemented'
  ).toBeTypeOf('function')
  return api
}

async function runAudit({
  profiles = ENABLED_PROFILES,
  emissions = emittedKinds(),
  rows = familyRows(),
  adapterOmission = null,
  adapterOverride = null,
} = {}) {
  const api = await plannedFamilyAudit()
  const adapters = adapterOverride ?? (adapterOmission
    ? adaptersWithout(
        api.FAMILY_AUDIT_ADAPTERS,
        adapterOmission.scope,
        adapterOmission.key
      )
    : api.FAMILY_AUDIT_ADAPTERS)
  return api.auditFamilyCompleteness(profiles, emissions, {
    adapters,
    familyRows: rows,
    officeShareFloor: OFFICE_SHARE_FLOOR,
  })
}

async function runSewerAudit({
  profiles = sewerProfiles(),
  fixtures = [sewerFixture()],
  rows = sewerFamilyRows(),
  adapterOmission = null,
} = {}) {
  return runAudit({
    profiles,
    emissions: sewerEmittedKinds(fixtures),
    rows,
    adapterOmission,
  })
}

async function runTowerAudit({
  profiles = towerProfiles(),
  fixtures = [towerFixture()],
  rows = towerFamilyRows(),
  adapterOmission = null,
  adapterOverride = null,
} = {}) {
  return runAudit({
    profiles,
    emissions: towerEmittedKinds(fixtures),
    rows,
    adapterOmission,
    adapterOverride,
  })
}

async function runLatticeAudit({
  profiles = latticeProfiles(),
  fixtures = null,
  rows = null,
  adapterOmission = null,
  adapterOverride = null,
} = {}) {
  const canonicalFixtures = fixtures ?? [latticeFixture()]
  const canonicalRows = rows ?? latticeFamilyRows(canonicalFixtures[0])
  return runAudit({
    profiles,
    emissions: latticeEmittedKinds(canonicalFixtures),
    rows: canonicalRows,
    adapterOmission,
    adapterOverride,
  })
}

async function runHotelAudit({
  profiles = hotelProfiles(),
  rows = hotelFamilyRows(),
  adapterOmission = null,
} = {}) {
  return runAudit({
    profiles,
    emissions: hotelEmittedKinds(),
    rows,
    adapterOmission,
  })
}

function rowFor(report, family) {
  return report.familyRows.find((row) => row.family === family)
}

function expectOfficeIndependent(report, baseline) {
  expect(rowFor(report, 'office')).toMatchObject({
    family: 'office',
    pins: baseline.pins,
    corpus: baseline.corpus,
    verdict: { ok: true, reasons: [] },
  })
}

function expectOnlyFamilyFailure(report, family, reason) {
  expect(report.ok).toBe(false)
  for (const row of report.familyRows) {
    expect(row.verdict).toEqual(
      row.family === family
        ? { ok: false, reasons: [reason] }
        : { ok: true, reasons: [] }
    )
  }
}

function adaptersWithout(source, scope, key) {
  const adapters = {
    families: { ...source.families },
    kinds: { ...source.kinds },
  }
  delete adapters[scope][key]
  return adapters
}

async function plannedRollbackValidator(redReason) {
  const api = await plannedFamilyAudit()
  expect(
    api.validateRollbackEvidence,
    `${redReason}: rollback evidence validator is not implemented`
  ).toBeTypeOf('function')
  return api.validateRollbackEvidence
}

function familyRollbackEvidence() {
  const knownPassing = {
    version: 17,
    digest: 'tower-byte-stream-v17',
    selectedFamily: 'tower',
    enabledFamilies: ['office', 'tower'],
    emittedFamilies: ['office', 'tower'],
    pins: {
      global: { version: 17, digest: 'global-byte-stream-v17' },
      family: { family: 'tower', version: 17, digest: 'tower-byte-stream-v17' },
      maximumHeight: { version: 17, digest: 'maximum-height-v17' },
    },
    corpus: {
      version: 17,
      profileIdentity: 'tower-forced-audit-v17',
      seedDerivation: 'fixed-root-seeds-v17',
    },
    contracts: {
      auditSchema: 'family-rows-v17',
    },
  }
  return {
    scope: 'family',
    family: 'tower',
    current: { version: 18, digest: 'tower-byte-stream-v18' },
    knownPassing,
    restored: structuredClone(knownPassing),
  }
}

function foundationRollbackEvidence() {
  const knownPassing = {
    version: 15,
    digest: 'office-byte-stream-v15',
    selectedFamily: 'office',
    enabledFamilies: ['office'],
    emittedFamilies: ['office'],
    pins: {
      global: { version: 15, digest: 'global-byte-stream-v15' },
      family: null,
      maximumHeight: { version: 15, digest: 'maximum-height-v15' },
    },
    corpus: {
      version: 15,
      profileIdentity: 'office-default-v15',
      seedDerivation: 'hashStr(seedText#level)',
    },
    contracts: {
      pairEnumeration: 'office-exact-two-participant',
      auditSchema: 'office-family-rows-v15',
    },
  }
  return {
    scope: 'foundation',
    family: 'office',
    current: { version: WORLD_GEN_VERSION, digest: 'all-family-byte-stream-v18' },
    knownPassing,
    restored: structuredClone(knownPassing),
  }
}

describe('explicit family audit registration (R12-S01..S03, R32-S01..S02; D06/D10)', () => {
  it('accepts registered family and kind adapters even when raster vocabulary is reused', async () => {
    const api = await plannedFamilyAudit()
    const report = await runAudit()

    expect(report.ok).toBe(true)
    expect(report.reasons).toEqual([])
    expect(Object.isFrozen(api.FAMILY_AUDIT_ADAPTERS)).toBe(true)
    expect(Object.isFrozen(api.FAMILY_AUDIT_ADAPTERS.families)).toBe(true)
    expect(Object.isFrozen(api.FAMILY_AUDIT_ADAPTERS.kinds)).toBe(true)
    expect(report.familyRows.map((row) => row.family)).toEqual(REQUIRED_ROWS)
    for (const row of report.familyRows) {
      expect(row.verdict).toEqual({ ok: true, reasons: [] })
    }
  })

  it.each([
    {
      label: 'family adapter',
      scope: 'families',
      key: 'tower',
      reason: 'missing-family-adapter',
    },
    {
      label: 'descriptor-kind adapter despite reused vocabulary',
      scope: 'kinds',
      key: 'towerSkybridge',
      reason: 'missing-kind-adapter',
    },
  ])(
    'rejects a missing $label without damaging office evidence',
    async ({ scope, key, reason }) => {
      const rows = familyRows()
      const office = structuredClone(rows[0])
      const report = await runAudit({
        rows,
        adapterOmission: { scope, key },
      })

      expectOnlyFamilyFailure(report, 'tower', reason)
      expectOfficeIndependent(report, office)
    }
  )
})

describe('positive and negative descriptor evidence (R13-S01..S05, R14-S04; D06/D10)', () => {
  it('accepts shared-core tower evidence without treating it as an activatable tower emitter', async () => {
    const report = await runAudit()

    expect(rowFor(report, 'tower').verdict).toEqual({ ok: true, reasons: [] })
  })

  it.each([
    {
      label: 'orphan descriptor',
      reason: 'tower:orphan-descriptor',
      damage(fixture) {
        fixture.participantStructures = []
      },
    },
    {
      label: 'family-mismatched descriptor participant',
      reason: 'tower:family-mismatch',
      damage(fixture) {
        fixture.participantStructures[1].family = 'lattice'
      },
    },
    {
      label: 'canonical-id-mismatched descriptor participant',
      reason: 'tower:canonical-id-mismatch',
      damage(fixture) {
        fixture.participantStructures[1].id += 1
      },
    },
    {
      label: 'invalid tower cardinality with every declared participant present',
      reason: 'tower:participant-cardinality',
      damage(fixture) {
        const descriptor = fixture.descriptors[0]
        const participant = { cx: 2, cz: 0 }
        descriptor.participants.push(participant)
        fixture.participantStructures.push(
          participantStructure(descriptor, participant)
        )
      },
    },
    {
      label: 'missing declared participant',
      reason: 'tower:missing-participant',
      damage(fixture) {
        fixture.participantStructures.pop()
      },
    },
  ])('isolates $label to its family row', async ({ damage, reason }) => {
    const rows = familyRows()
    const office = structuredClone(rows[0])
    const emissions = emittedKinds()
    damage(emissions[1].fixtures[0])

    const report = await runAudit({ rows, emissions })

    expectOnlyFamilyFailure(report, 'tower', reason)
    expectOfficeIndependent(report, office)
  })
})

describe('independent corpus rows and activation evidence (R14-S01..S04, R32-S01..S03; D10/D11)', () => {
  it('keeps forced-family chunks out of the office-share denominator', async () => {
    const rows = familyRows()
    const office = rows[0]
    office.corpus.officeChunks = 60
    office.corpus.chunks = 80
    office.corpus.officeShare = OFFICE_SHARE_FLOOR
    const sewer = rows.find((row) => row.family === 'sewer')
    sewer.corpus.seeds = 4
    sewer.corpus.chunks = 1000
    sewer.corpus.officeChunks = 0

    const report = await runAudit({ rows })

    expect(report.ok).toBe(true)
    expect(rowFor(report, 'office').corpus.officeShare).toBe(OFFICE_SHARE_FLOOR)
    expect(rowFor(report, 'sewer').forcedProfile).toBe(true)
    expect(rowFor(report, 'sewer').corpus.chunks).toBe(1000)
  })

  it('reports an absent enabled-family row while preserving the office row and pins', async () => {
    const rows = familyRows()
    const office = structuredClone(rows[0])
    const report = await runAudit({
      rows: rows.filter((row) => row.family !== 'tower'),
    })

    expect(report.ok).toBe(false)
    expect(report.reasons).toEqual(['missing-family-row:tower'])
    expectOfficeIndependent(report, office)
  })

  it.each([
    { pin: 'family', reason: 'missing-family-pin' },
    { pin: 'maximumHeight', reason: 'missing-maximum-height' },
  ])(
    'isolates an absent tower $pin pin from office pins',
    async ({ pin, reason }) => {
      const rows = familyRows()
      const office = structuredClone(rows[0])
      const tower = rows.find((row) => row.family === 'tower')
      delete tower.pins[pin]

      const report = await runAudit({ rows })

      expectOnlyFamilyFailure(report, 'tower', reason)
      expectOfficeIndependent(report, office)
    }
  )

  it('keeps an office-share regression visible when every family fixture passes', async () => {
    const rows = familyRows()
    rows[0].corpus.officeShare = OFFICE_SHARE_FLOOR - 0.01

    const report = await runAudit({ rows })

    expectOnlyFamilyFailure(report, 'office', 'office-share-below-floor')
    expect(rowFor(report, 'tower').verdict).toEqual({ ok: true, reasons: [] })
  })
})

describe('sewer adapter and bounded fixture evidence (R12-S01..S03, R13-S01..S06, R24-S01; D07/D10)', () => {
  it('accepts one forced, dry, connected fixture covering exactly the seven MVP module kinds', async () => {
    const fixture = sewerFixture()
    const structure = fixture.sewerStructures[0]
    const report = await runSewerAudit({ fixtures: [fixture] })

    expect(report.ok).toBe(true)
    expect(structure.profile).toMatchObject({
      forcedProfile: true,
      zoneBands: [{ id: 3, max: 1.01 }],
      maxLoops: 2,
      rightTurnChance: 0.65,
    })
    expect(structure.descriptor.modules.map((module) => module.kind).sort()).toEqual(
      [...SEWER_MODULE_KINDS].sort()
    )
    expect(structure.descriptor.modules.every((module) =>
      !DEFERRED_SEWER_MODULE_KINDS.includes(module.kind)
    )).toBe(true)
    expect(rowFor(report, 'sewer')).toMatchObject({
      forcedProfile: true,
      pins: { family: true, maximumHeight: null },
      corpus: {
        familyMetrics: {
          moduleCoverage: SEWER_MODULE_KINDS,
          deferredModules: 0,
          unreachableModules: 0,
          loops: { inserted: 1, budget: 2, eligibleNonTreeLinks: 4 },
          lights: { eligible: 3, lit: 1, unlit: 2 },
          seams: { office: 'mouth', openHall: 'open' },
          descriptorFailures: 0,
          observedRightTurnRate: 0.4,
        },
      },
      verdict: { ok: true, reasons: [] },
    })
  })

  it.each([
    {
      label: 'sewer family adapter',
      scope: 'families',
      key: 'sewer',
      reason: 'missing-family-adapter',
    },
    {
      label: 'sewer descriptor-kind adapter',
      scope: 'kinds',
      key: 'sewer',
      reason: 'missing-kind-adapter',
    },
  ])(
    'requires an explicit $label without damaging office evidence',
    async ({ scope, key, reason }) => {
      const rows = sewerFamilyRows()
      const office = structuredClone(rows[0])
      const report = await runSewerAudit({
        rows,
        adapterOmission: { scope, key },
      })

      expectOnlyFamilyFailure(report, 'sewer', reason)
      expectOfficeIndependent(report, office)
    }
  )

  it.each([
    {
      label: 'orphaned canonical sewer descriptor',
      reason: 'sewer:orphan-descriptor',
      damage(fixture) {
        fixture.sewerStructures = []
      },
    },
    {
      label: 'family-mismatched canonical sewer descriptor',
      reason: 'sewer:family-mismatch',
      damage(fixture) {
        fixture.descriptors[0].family = 'office'
      },
    },
    {
      label: 'disconnected raster despite a connected descriptor',
      reason: 'sewer:unreachable-module',
      damage(fixture) {
        const links = fixture.sewerStructures[0].raster.links
        fixture.sewerStructures[0].raster.links = links.filter(
          ({ a, b }) => !(a === 5 && b === 6)
        )
      },
    },
    {
      label: 'out-of-range one-based graph endpoint',
      reason: 'sewer:unreachable-module',
      damage(fixture) {
        fixture.descriptors[0].treeEdges.at(-1).b =
          fixture.descriptors[0].modules.length
      },
    },
    {
      label: 'non-cardinal public module direction',
      reason: 'sewer:unreachable-module',
      damage(fixture) {
        fixture.descriptors[0].modules[0].dir = 1
      },
    },
    {
      label: 'deferred flooded module',
      reason: 'sewer:deferred-module',
      damage(fixture) {
        fixture.descriptors[0].modules[2].kind = 'floodedStretch'
      },
    },
    {
      label: 'explicit wet traversal output',
      reason: 'sewer:wet-output',
      damage(fixture) {
        fixture.descriptors[0].waterDepth = 1
      },
    },
    {
      label: 'loop count above the finite profile budget',
      reason: 'sewer:loop-budget',
      damage(fixture) {
        fixture.descriptors[0].loopEdges.push(
          { a: 0, b: 3 },
          { a: 2, b: 5 }
        )
      },
    },
    {
      label: 'non-sparse eligible lighting',
      reason: 'sewer:non-sparse-lighting',
      damage(fixture) {
        const lighting = fixture.sewerStructures[0].lighting
        lighting.litLocations = structuredClone(lighting.eligibleLocations)
      },
    },
    {
      label: 'missing open-hall seam evidence',
      reason: 'sewer:missing-seam',
      damage(fixture) {
        delete fixture.sewerStructures[0].seams.openHall
      },
    },
    {
      label: 'canonical-id-mismatched generated structure',
      reason: 'sewer:canonical-id-mismatch',
      damage(fixture) {
        fixture.sewerStructures[0].id += 1
      },
    },
    {
      label: 'missing matched manhole riser evidence',
      reason: 'sewer:unreachable-module',
      damage(fixture) {
        delete fixture.sewerStructures[0].risers
      },
    },
  ])('isolates $label to the sewer row', async ({ damage, reason }) => {
    const rows = sewerFamilyRows()
    const office = structuredClone(rows[0])
    const fixture = sewerFixture()
    damage(fixture)

    const report = await runSewerAudit({ fixtures: [fixture], rows })

    expectOnlyFamilyFailure(report, 'sewer', reason)
    expectOfficeIndependent(report, office)
  })
})

describe('forced sewer corpus isolation and release evidence (R14-S01..S03, R24-S01..S03; D10/D11)', () => {
  it('audits forced Sewer geometry while keeping the release profile explicitly disabled', async () => {
    const profiles = sewerProfiles()
    profiles.find((profile) => profile.family === 'sewer').enabled = false
    const rows = sewerFamilyRows()
    const sewer = rows.find((row) => row.family === 'sewer')
    sewer.enabled = false
    sewer.pins.family = false
    sewer.corpus.status = 'forced-audit-release-profile-disabled'

    const report = await runSewerAudit({ profiles, rows })

    expect(report.ok).toBe(true)
    expect(rowFor(report, 'sewer')).toMatchObject({
      enabled: false,
      forcedProfile: true,
      pins: { family: false, maximumHeight: null },
      corpus: {
        status: 'forced-audit-release-profile-disabled',
        familyMetrics: expect.any(Object),
      },
      verdict: { ok: true, reasons: [] },
    })

    const malformed = sewerFixture()
    malformed.sewerStructures[0].raster.links =
      malformed.sewerStructures[0].raster.links.filter(
        ({ a, b }) => !(a === 5 && b === 6)
      )
    const failed = await runSewerAudit({
      profiles,
      rows,
      fixtures: [malformed],
    })
    expectOnlyFamilyFailure(failed, 'sewer', 'sewer:unreachable-module')
    expect(rowFor(failed, 'sewer').enabled).toBe(false)
  })

  it('keeps a dominant forced sewer corpus outside the office-share denominator', async () => {
    const rows = sewerFamilyRows()
    const office = rows.find((row) => row.family === 'office')
    const sewer = rows.find((row) => row.family === 'sewer')
    office.corpus.officeChunks = 60
    office.corpus.chunks = 80
    office.corpus.officeShare = OFFICE_SHARE_FLOOR
    sewer.corpus.chunks = 1000

    const blendedShare = office.corpus.officeChunks /
      (office.corpus.chunks + sewer.corpus.chunks)
    expect(blendedShare).toBeLessThan(OFFICE_SHARE_FLOOR)

    const report = await runSewerAudit({ rows })

    expect(report.ok).toBe(true)
    expect(rowFor(report, 'office').corpus.officeShare).toBe(OFFICE_SHARE_FLOOR)
    expect(rowFor(report, 'sewer')).toMatchObject({
      forcedProfile: true,
      pins: { family: true, maximumHeight: null },
      corpus: { chunks: 1000, officeChunks: 0 },
      verdict: { ok: true, reasons: [] },
    })
  })

  it('rejects an enabled sewer row that is not marked as a forced profile', async () => {
    const rows = sewerFamilyRows()
    const office = structuredClone(rows[0])
    rows.find((row) => row.family === 'sewer').forcedProfile = false

    const report = await runSewerAudit({ rows })

    expectOnlyFamilyFailure(report, 'sewer', 'forced-profile-required')
    expectOfficeIndependent(report, office)
  })

  it('reports an absent enabled sewer row without replacing the office row', async () => {
    const rows = sewerFamilyRows()
    const office = structuredClone(rows[0])
    const report = await runSewerAudit({
      rows: rows.filter((row) => row.family !== 'sewer'),
    })

    expect(report.ok).toBe(false)
    expect(report.reasons).toEqual(['missing-family-row:sewer'])
    expectOfficeIndependent(report, office)
  })

  it('isolates a missing sewer family pin while requiring no maximum-height pin', async () => {
    const rows = sewerFamilyRows()
    const office = structuredClone(rows[0])
    const sewer = rows.find((row) => row.family === 'sewer')
    expect(sewer.pins.maximumHeight).toBeNull()
    delete sewer.pins.family

    const report = await runSewerAudit({ rows })

    expectOnlyFamilyFailure(report, 'sewer', 'missing-family-pin')
    expectOfficeIndependent(report, office)
  })

  it('requires sewer-specific family metrics in the independent corpus row', async () => {
    const rows = sewerFamilyRows()
    const office = structuredClone(rows[0])
    delete rows.find((row) => row.family === 'sewer').corpus.familyMetrics

    const report = await runSewerAudit({ rows })

    expectOnlyFamilyFailure(report, 'sewer', 'missing-family-metrics')
    expectOfficeIndependent(report, office)
  })

  it('rejects missing seam evidence from the independent Sewer metrics', async () => {
    const rows = sewerFamilyRows()
    const office = structuredClone(rows[0])
    delete rows.find((row) => row.family === 'sewer')
      .corpus.familyMetrics.seams.openHall

    const report = await runSewerAudit({ rows })

    expectOnlyFamilyFailure(report, 'sewer', 'sewer:missing-seam')
    expectOfficeIndependent(report, office)
  })

  it('keeps observed right-turn frequency report-only while retaining the 0.65 generator policy', async () => {
    const fixture = sewerFixture()
    const structure = fixture.sewerStructures[0]
    structure.observedRightTurnRate = 0.2
    const rows = sewerFamilyRows()
    rows.find((row) => row.family === 'sewer')
      .corpus.familyMetrics.observedRightTurnRate = 0.2

    const report = await runSewerAudit({ fixtures: [fixture], rows })

    expect(structure.profile.rightTurnChance).toBe(0.65)
    expect(structure.observedRightTurnRate).not.toBe(0.65)
    expect(rowFor(report, 'sewer').verdict).toEqual({ ok: true, reasons: [] })
  })

  it('does not require deferred sensory systems for a passing sewer row', async () => {
    const fixture = sewerFixture()
    fixture.sewerStructures[0].optionalSystems = {
      water: false,
      wading: false,
      floodOrWading: false,
      absoluteDarkness: false,
      carriedFlameInventory: false,
      positionalPropagation: false,
      perSourceOcclusion: false,
      perFamilyFog: false,
    }

    const report = await runSewerAudit({ fixtures: [fixture] })

    expect(rowFor(report, 'sewer').verdict).toEqual({ ok: true, reasons: [] })
  })
})

describe('tower and authored-landmark registration (R12-S01..S03, R27-S03; D06/D10)', () => {
  it('accepts one bounded Tower fixture with enclosed floors, one distinct skybridge deck, and mixed authored sockets', async () => {
    const fixture = towerFixture()
    const descriptor = fixture.descriptors[0]
    const stamping = fixture.stamping
    const report = await runTowerAudit({ fixtures: [fixture] })

    expect(report.ok).toBe(true)
    expect(stamping.floorSlices).toHaveLength(6)
    expect(stamping.floorSlices.every(({ surface }) => surface === 'enclosedTower'))
      .toBe(true)
    expect(stamping.skybridge).toMatchObject({
      surface: 'skybridgeDeck',
      id: descriptor.id,
      levelCy: 1,
    })
    expect(stamping.skybridge.surface).not.toBe(stamping.floorSlices[0].surface)
    expect(new Set(descriptor.landmarkSockets.map(({ kind }) => kind)))
      .toEqual(new Set(TOWER_LANDMARK_KINDS))
    expect(rowFor(report, 'tower').verdict).toEqual({ ok: true, reasons: [] })
  })

  it('requires explicit registration for the Tower structure kind and all authored landmark socket kinds', async () => {
    const api = await plannedFamilyAudit()
    const towerFamily = api.FAMILY_AUDIT_ADAPTERS.families.tower
    const towerAdapter = api.FAMILY_AUDIT_ADAPTERS.kinds[TOWER_STRUCTURE_KIND]
    const report = await runTowerAudit()

    expect(towerFamily.kinds).toContain(TOWER_STRUCTURE_KIND)
    expect(
      towerAdapter.socketKinds,
      'R12/R27 reused bridge/rail vocabulary cannot register authored Tower landmarks'
    ).toEqual(TOWER_LANDMARK_KINDS)
    expect(towerAdapter).toMatchObject({
      family: 'tower',
      kind: TOWER_STRUCTURE_KIND,
      socketKinds: TOWER_LANDMARK_KINDS,
    })
    expect(Object.isFrozen(towerAdapter)).toBe(true)
    expect(report.ok).toBe(true)
    expect(rowFor(report, 'tower').verdict).toEqual({ ok: true, reasons: [] })
  })

  it('isolates an omitted authored-landmark kind registry to the Tower row', async () => {
    const api = await plannedFamilyAudit()
    const towerAdapter = api.FAMILY_AUDIT_ADAPTERS.kinds[TOWER_STRUCTURE_KIND]
    const adapters = {
      families: api.FAMILY_AUDIT_ADAPTERS.families,
      kinds: {
        ...api.FAMILY_AUDIT_ADAPTERS.kinds,
        [TOWER_STRUCTURE_KIND]: Object.freeze({
          ...towerAdapter,
          socketKinds: [],
        }),
      },
    }
    const rows = towerFamilyRows()
    const office = structuredClone(rows[0])
    const report = await runTowerAudit({
      rows,
      adapterOverride: adapters,
    })

    expectOnlyFamilyFailure(report, 'tower', 'missing-kind-adapter')
    expectOfficeIndependent(report, office)
  })
})

describe('tower negative fixtures stay isolated (R13-S01..S07, R14-S04, R27-S02..S04; D06/D08/D10)', () => {
  it.each([
    {
      label: 'orphaned canonical Tower descriptor',
      reason: 'tower:orphan-descriptor',
      damage(fixture) {
        fixture.participantStructures = []
      },
    },
    {
      label: 'family-mismatched Tower participant',
      reason: 'tower:family-mismatch',
      damage(fixture) {
        fixture.participantStructures[1].family = 'lattice'
      },
    },
    {
      label: 'third canonical participant',
      reason: 'tower:participant-cardinality',
      damage(fixture) {
        const descriptor = fixture.descriptors[0]
        const participant = { cx: 2, cz: 0 }
        descriptor.participants.push(participant)
        fixture.participantStructures.push(
          participantStructure(descriptor, participant)
        )
      },
    },
    {
      label: 'missing declared participant',
      reason: 'tower:missing-participant',
      damage(fixture) {
        fixture.participantStructures.pop()
      },
    },
    {
      label: 'discontinuous skybridge guard',
      reason: 'tower:invalid-guard',
      damage(fixture) {
        fixture.stamping.skybridge.guards[0].continuous = false
      },
    },
    {
      label: 'non-canonical skybridge deck descriptor',
      reason: 'tower:invalid-deck',
      damage(fixture) {
        fixture.descriptors[0].decks[0].globalCells.pop()
      },
    },
    {
      label: 'canonical-id-mismatched skybridge approach',
      reason: 'tower:invalid-approach',
      damage(fixture) {
        fixture.stamping.skybridge.approaches[1].id++
      },
    },
    {
      label: 'disconnected top floor descriptor',
      reason: 'tower:floor-connectivity',
      damage(fixture) {
        fixture.descriptors[0].verticalLinks.pop()
      },
    },
    {
      label: 'uncovered second skybridge approach',
      reason: 'tower:missing-landmark-socket',
      damage(fixture) {
        const descriptor = fixture.descriptors[0]
        descriptor.landmarkSockets = descriptor.landmarkSockets.filter(
          ({ slot, side }) => slot !== 'bridgeApproach' || side !== 1
        )
      },
    },
    {
      label: 'procedural decoration without authored sockets',
      reason: 'tower:missing-landmark-socket',
      damage(fixture) {
        fixture.descriptors[0].landmarkSockets = []
        fixture.stamping.proceduralDecoration = true
      },
    },
    {
      label: 'malformed authored socket orientation',
      reason: 'tower:missing-landmark-socket',
      damage(fixture) {
        fixture.descriptors[0].landmarkSockets[0].side = 0
      },
    },
    {
      label: 'bridge surface substituted for an enclosed tower floor',
      reason: 'tower:structure-identity',
      damage(fixture) {
        fixture.stamping.floorSlices[0].surface = 'skybridgeDeck'
      },
    },
    {
      label: 'cross-district network metadata',
      reason: 'tower:cross-district-network',
      damage(fixture) {
        fixture.descriptors[0].networkEdges = [{ from: 0x7042, to: 0x7043 }]
      },
    },
  ])('reports $label only in the Tower row', async ({ damage, reason }) => {
    const rows = towerFamilyRows()
    const office = structuredClone(rows[0])
    const fixture = towerFixture()
    damage(fixture)

    const report = await runTowerAudit({ fixtures: [fixture], rows })

    expectOnlyFamilyFailure(report, 'tower', reason)
    expectOfficeIndependent(report, office)
  })
})

describe('independent Tower row and canonical safety evidence (R14-S01/R14-S04, R27-S01..S04; D08/D10)', () => {
  it('reports the complete bounded Tower metric set without entering the Office denominator', async () => {
    const rows = towerFamilyRows()
    const office = rows.find((row) => row.family === 'office')
    const tower = rows.find((row) => row.family === 'tower')
    office.corpus.officeChunks = 60
    office.corpus.chunks = 80
    office.corpus.officeShare = OFFICE_SHARE_FLOOR
    tower.corpus.chunks = 1000

    const report = await runTowerAudit({ rows })
    const api = await plannedFamilyAudit()
    const canonicalSafetyVerdict = api.validateVoidSafetyEligibility({
      family: 'tower',
      enabled: true,
      corpus: { profileIdentity: tower.profileIdentity },
      voidSafety: tower.corpus.familyMetrics.voidSafety,
    })

    expect(canonicalSafetyVerdict).toEqual({ ok: true, reasons: [] })
    expect(report.ok).toBe(true)
    expect(rowFor(report, 'office').corpus.officeShare).toBe(OFFICE_SHARE_FLOOR)
    expect(rowFor(report, 'tower')).toMatchObject({
      forcedProfile: true,
      pins: { family: true, maximumHeight: true },
      corpus: {
        chunks: 1000,
        officeChunks: 0,
        familyMetrics: {
          participantCardinality: 2,
          floorCount: 3,
          deckCount: 1,
          approaches: { expected: 2, matched: 2 },
          connectedFloors: 3,
          socketKinds: TOWER_LANDMARK_KINDS,
          socketCoverage: { anchorFloors: [0, 1, 2], bridgeApproaches: 2 },
          guardFailures: 0,
          descriptorFailures: 0,
          enclosedTowerSlices: 6,
          skybridgeDecks: 1,
          voidSafety: expect.any(Object),
        },
      },
      verdict: { ok: true, reasons: [] },
    })
  })

  it('requires the Tower-specific family metrics without masking passing Office and Sewer rows', async () => {
    const rows = towerFamilyRows()
    const office = structuredClone(rows[0])
    delete rows.find((row) => row.family === 'tower').corpus.familyMetrics

    const report = await runTowerAudit({ rows })

    expectOnlyFamilyFailure(report, 'tower', 'missing-family-metrics')
    expectOfficeIndependent(report, office)
  })

  it.each([
    {
      label: 'hard void-death proof',
      reason: 'missing-hard-void-death-evidence',
      damage(voidSafety) {
        delete voidSafety.hardVoidDeath
      },
    },
    {
      label: 'deterministic reset proof',
      reason: 'missing-deterministic-reset-evidence',
      damage(voidSafety) {
        delete voidSafety.deterministicReset
      },
    },
    {
      label: 'matched lethal-half parity',
      reason: 'void-plane-mismatch',
      damage(voidSafety) {
        voidSafety.hardVoidDeath.halves.lethalVoidDown.cells[0].deathYmm--
      },
    },
    {
      label: 'canonical lethal ownership',
      reason: 'void-ownership-mismatch',
      damage(voidSafety) {
        voidSafety.hardVoidDeath.ownership.id++
      },
    },
    {
      label: 'same-profile reset baseline',
      reason: 'reset-baseline-mismatch',
      damage(voidSafety) {
        voidSafety.deterministicReset.after.profileIdentity = 'tower-drifted-profile'
      },
    },
  ])(
    'reuses the Foundation safety validator when Tower lacks $label',
    async ({ damage, reason }) => {
      const rows = towerFamilyRows()
      const office = structuredClone(rows[0])
      const tower = rows.find((row) => row.family === 'tower')
      const metrics = tower.corpus.familyMetrics
      damage(metrics.voidSafety)
      const api = await plannedFamilyAudit()
      const canonicalSafetyVerdict = api.validateVoidSafetyEligibility({
        family: 'tower',
        enabled: true,
        corpus: { profileIdentity: tower.profileIdentity },
        voidSafety: metrics.voidSafety,
      })

      expect(canonicalSafetyVerdict).toEqual({ ok: false, reasons: [reason] })

      const report = await runTowerAudit({ rows })

      expect(rowFor(report, 'tower').verdict).toEqual(canonicalSafetyVerdict)
      expect(report.ok).toBe(false)
      for (const row of report.familyRows) {
        if (row.family !== 'tower') {
          expect(row.verdict).toEqual({ ok: true, reasons: [] })
        }
      }
      expectOfficeIndependent(report, office)
    }
  )
})

describe('Lattice audit registration and bounded stamp evidence (task 5.2 RED)', () => {
  it('requires one explicit Lattice kind adapter for every reused-vocabulary audit dimension', async () => {
    const api = await plannedFamilyAudit()
    const familyAdapter = api.FAMILY_AUDIT_ADAPTERS.families.lattice
    const kindAdapter = api.FAMILY_AUDIT_ADAPTERS.kinds[LATTICE_STRUCTURE_KIND]
    const report = await runLatticeAudit()

    expect(familyAdapter.kinds).toContain(LATTICE_STRUCTURE_KIND)
    expect(
      kindAdapter.auditDimensions,
      'R12-S03: CELL_BRIDGE/WALL_RAIL/multilevel reuse is not Lattice audit registration'
    ).toEqual(LATTICE_AUDIT_DIMENSIONS)
    expect(kindAdapter).toMatchObject({
      family: 'lattice',
      kind: LATTICE_STRUCTURE_KIND,
      auditDimensions: LATTICE_AUDIT_DIMENSIONS,
    })
    expect(Object.isFrozen(kindAdapter)).toBe(true)
    expect(report.ok).toBe(true)
  })

  it.each([
    { scope: 'families', key: 'lattice', reason: 'missing-family-adapter' },
    { scope: 'kinds', key: LATTICE_STRUCTURE_KIND, reason: 'missing-kind-adapter' },
  ])(
    'isolates a missing Lattice $scope registration without masking another row',
    async ({ scope, key, reason }) => {
      const rows = latticeFamilyRows()
      const office = structuredClone(rows[0])
      const report = await runLatticeAudit({
        rows,
        adapterOmission: { scope, key },
      })

      expectOnlyFamilyFailure(report, 'lattice', reason)
      expectOfficeIndependent(report, office)
    }
  )

  it('rejects a generic kind adapter that omits Lattice-specific dimensions', async () => {
    const api = await plannedFamilyAudit()
    const adapter = api.FAMILY_AUDIT_ADAPTERS.kinds[LATTICE_STRUCTURE_KIND]
    const adapters = {
      families: api.FAMILY_AUDIT_ADAPTERS.families,
      kinds: {
        ...api.FAMILY_AUDIT_ADAPTERS.kinds,
        [LATTICE_STRUCTURE_KIND]: Object.freeze({
          ...adapter,
          auditDimensions: [],
        }),
      },
    }
    const rows = latticeFamilyRows()
    const office = structuredClone(rows[0])
    const report = await runLatticeAudit({ rows, adapterOverride: adapters })

    expectOnlyFamilyFailure(report, 'lattice', 'missing-kind-adapter')
    expectOfficeIndependent(report, office)
  })

  it('accepts one open 4×4×5 stamp with 64 chambers, horizontal bridges, and full vertical connector coverage', async () => {
    const fixture = latticeFixture()
    const descriptor = latticeDescriptorFromFixture(fixture)
    const report = await runLatticeAudit({
      fixtures: [fixture],
      rows: latticeFamilyRows(fixture),
    })
    const anchorById = new Map(descriptor.anchors.map((anchor) => [anchor.id, anchor]))
    const cycles = descriptor.edges.filter(({ role }) => role === 'cycle')

    expect(descriptor.participants).toHaveLength(16)
    expect(descriptor.anchors).toHaveLength(64)
    expect(fixture.chunks.size).toBe(80)
    expect([...fixture.chunks.values()].every((data) =>
      data.mapFamily === MAP_FAMILY_LATTICE &&
      data.structure?.id === descriptor.id
    )).toBe(true)
    // One stair per vertical tree edge, sorted by (lowerCy, cz, cx), with every
    // adjacent floor boundary of the five-level band bridged at least once.
    expect(descriptor.verticalLinks.map(({ lowerCy }) => lowerCy)).toEqual([
      descriptor.baseCy,
      descriptor.baseCy + 1,
      descriptor.baseCy + 2,
      descriptor.baseCy + 3,
    ])
    expect(descriptor.edges.some(({ role }) => role !== 'vertical')).toBe(true)
    expect(descriptor.edges.filter(({ role }) => role === 'vertical'))
      .toHaveLength(descriptor.verticalLinks.length)
    // Conciliation correction: a cycle is eligible only when both canonical
    // endpoints are on the same floor. Cross-floor links always use `vertical`.
    expect(cycles).toHaveLength(3)
    expect(cycles.every(({ a, b }) =>
      anchorById.get(a).levelCy === anchorById.get(b).levelCy
    )).toBe(true)
    for (const forbidden of [
      'candidateLinks',
      'stamping',
      'anchorContexts',
      'participantStructures',
    ]) expect(descriptor).not.toHaveProperty(forbidden)
    expect(report.ok).toBe(true)
  })

  it('resolves omitted chamber exposure to 5 m while accepting an explicit 20 m maximum', async () => {
    const fixture = latticeFixture()
    const descriptor = latticeDescriptorFromFixture(fixture)
    const defaultAnchor = descriptor.anchors.find((anchor) => anchor.exposureM === undefined)
    const maximumAnchor = descriptor.anchors.find((anchor) => anchor.exposureM === 20)
    const report = await runLatticeAudit({
      fixtures: [fixture],
      rows: latticeFamilyRows(fixture),
    })
    const metrics = rowFor(report, 'lattice').corpus.familyMetrics

    expect(defaultAnchor).not.toHaveProperty('exposureM')
    expect(maximumAnchor.exposureM).toBe(20)
    expect(metrics.exposure).toMatchObject({
      defaultM: 5,
      maximumM: 20,
      observedMaximumM: 20,
      invalidAnchors: 0,
    })
    expect(report.ok).toBe(true)
  })
})

describe('Lattice malformed fixtures fail only the Lattice row (task 5.2 RED)', () => {
  it.each([
    {
      label: 'orphaned canonical descriptor',
      reason: 'lattice:orphan-descriptor',
      damage(fixture) {
        for (const data of fixture.chunks.values()) data.structure = null
      },
    },
    {
      label: 'family-mismatched participant',
      reason: 'lattice:family-mismatch',
      damage(fixture) {
        fixture.chunks.values().next().value.mapFamily = 'tower'
      },
    },
    {
      label: 'missing sixteenth participant',
      reason: 'lattice:missing-participant',
      damage(fixture) {
        const descriptor = latticeDescriptorFromFixture(fixture)
        const participant = descriptor.participants.at(-1)
        for (let cy = descriptor.baseCy; cy <= descriptor.topCy; cy++) {
          fixture.chunks.delete(`${participant.cx},${cy},${participant.cz}`)
        }
      },
    },
    {
      label: 'oversized five-chunk district',
      reason: 'lattice:bounded-4x4x5',
      damage(fixture) {
        replaceLatticeDescriptor(fixture, (descriptor) => {
          descriptor.district.size = 5
        })
      },
    },
    {
      label: 'disconnected MST backbone',
      reason: 'lattice:disconnected-backbone',
      damage(fixture) {
        replaceLatticeDescriptor(fixture, (descriptor) => {
          const index = descriptor.edges.findIndex(({ role }) => role === 'backbone')
          descriptor.edges.splice(index, 1)
        })
      },
    },
    {
      label: 'missing vertical stair connectors',
      reason: 'lattice:missing-vertical-link',
      damage(fixture) {
        replaceLatticeDescriptor(fixture, (descriptor) => {
          descriptor.verticalLinks = []
        })
      },
    },
    {
      label: 'cycle reinsertion below twelve percent',
      reason: 'lattice:cycle-rate',
      damage(fixture) {
        replaceLatticeDescriptor(fixture, (descriptor) => {
          descriptor.edges = descriptor.edges.filter(({ role }) => role !== 'cycle')
        })
      },
    },
    {
      label: 'exposure above twenty metres',
      reason: 'lattice:exposure-range',
      damage(fixture) {
        replaceLatticeDescriptor(fixture, (descriptor) => {
          descriptor.anchors.at(-1).exposureM = 21
        })
      },
    },
    {
      label: 'non-canonical six-metre default exposure',
      reason: 'lattice:exposure-range',
      damage(fixture) {
        damageLatticeDeathPlane(fixture)
      },
    },
    {
      label: 'rail-only cue count that omits bridge seams',
      reason: 'lattice:cue-sources',
      damage(fixture) {
        damageLatticeCueRails(fixture, 0)
      },
    },
    {
      label: 'seven combined chamber and bridge cue cells',
      reason: 'lattice:cue-count',
      damage(fixture) {
        damageLatticeCueRails(fixture, 1)
      },
    },
    {
      label: 'chamber enclosed by three plain-wall sides',
      reason: 'lattice:plain-wall-sides',
      damage(fixture) {
        damageLatticePlainSides(fixture)
      },
    },
    {
      label: 'discontinuous bridge guard',
      reason: 'lattice:invalid-guard',
      damage(fixture) {
        damageLatticeGuard(fixture)
      },
    },
    {
      label: 'canonical-id-mismatched bridge approach',
      reason: 'lattice:invalid-approach',
      damage(fixture) {
        damageLatticeApproach(fixture)
      },
    },
    {
      label: 'enclosed-room identity substituted for a pier chamber',
      reason: 'lattice:enclosed-room-identity',
      damage(fixture) {
        replaceLatticeDescriptor(fixture, (descriptor) => {
          descriptor.enclosedRooms = [{ anchorId: descriptor.anchors[0].id }]
        })
      },
    },
    {
      label: 'missing upper-floor stamp evidence',
      reason: 'lattice:missing-floor-audit',
      damage(fixture) {
        const descriptor = latticeDescriptorFromFixture(fixture)
        for (const participant of descriptor.participants) {
          fixture.chunks.delete(`${participant.cx},${descriptor.topCy},${participant.cz}`)
        }
      },
    },
    {
      label: 'bridge raster list drifting from the descriptor',
      reason: 'lattice:stamp-mismatch',
      damage(fixture) {
        const descriptor = latticeDescriptorFromFixture(fixture)
        const anchors = new Set(descriptor.anchors.map(({ gx, gz, levelCy }) =>
          `${gx},${gz},${levelCy}`
        ))
        const cell = descriptor.edges.flatMap(({ cells }) => cells).find((candidate) =>
          !anchors.has(`${candidate.gx},${candidate.gz},${candidate.cy}`)
        )
        const data = latticeChunkAt(
          fixture,
          Math.floor(cell.gx / CHUNK),
          cell.cy,
          Math.floor(cell.gz / CHUNK)
        )
        data.cellKind[cIdx(
          cell.gx - data.cx * CHUNK,
          cell.gz - data.cz * CHUNK
        )] = CELL_VOID
      },
    },
    {
      label: 'multi-district network metadata',
      reason: 'lattice:cross-district-network',
      damage(fixture) {
        replaceLatticeDescriptor(fixture, (descriptor) => {
          descriptor.linkedStructureIds = [descriptor.id + 1]
        })
      },
    },
  ])('reports $label without masking Office/Sewer/Tower', async ({ damage, reason }) => {
    const fixture = latticeFixture()
    const rows = latticeFamilyRows(fixture)
    const office = structuredClone(rows[0])
    damage(fixture)

    const report = await runLatticeAudit({ fixtures: [fixture], rows })

    expectOnlyFamilyFailure(report, 'lattice', reason)
    expectOfficeIndependent(report, office)
  })
})

describe('independent all-floor Lattice row and Foundation safety consumption (task 5.2 RED)', () => {
  it('reports every bounded Lattice metric without entering the Office denominator', async () => {
    const fixture = latticeFixture()
    const rows = latticeFamilyRows(fixture)
    const office = rows.find((row) => row.family === 'office')
    const lattice = rows.find((row) => row.family === 'lattice')
    office.corpus.officeChunks = 60
    office.corpus.chunks = 80
    office.corpus.officeShare = OFFICE_SHARE_FLOOR

    const report = await runLatticeAudit({ fixtures: [fixture], rows })
    const api = await plannedFamilyAudit()
    const canonicalSafetyVerdict = api.validateVoidSafetyEligibility({
      family: 'lattice',
      enabled: true,
      corpus: { profileIdentity: lattice.profileIdentity },
      voidSafety: lattice.corpus.familyMetrics.voidSafety,
    })

    expect(canonicalSafetyVerdict).toEqual({ ok: true, reasons: [] })
    expect(report.ok).toBe(true)
    expect(rowFor(report, 'office').corpus.officeShare).toBe(OFFICE_SHARE_FLOOR)
    expect(rowFor(report, 'lattice')).toMatchObject({
      enabled: false,
      forcedProfile: true,
      generatorVersion: WORLD_GEN_VERSION,
      pins: { family: false, maximumHeight: false },
      corpus: {
        chunks: 80,
        officeChunks: 0,
        familyMetrics: {
          participantCardinality: 16,
          districtFootprint: { x: 4, z: 4 },
          districtCount: 1,
          floorCoverage: LATTICE_FLOORS,
          anchorCount: 64,
          backbone: { edgeCount: 63, connected: true, acyclic: true, minimum: true },
          cycles: { inserted: 3, eligibleNonBackboneLinks: 21, rate: 3 / 21 },
          orientations: { horizontal: true, vertical: true },
          verticalConnections: { boundaries: 4, covered: 4, stairs: 4 },
          stamping: {
            floorSlices: 80,
            chamberContexts: 64,
            bridgeSegmentsMatchDescriptor: true,
            enclosedRoomSlices: 0,
          },
          reachability: {
            components: 1,
            walkableCells: expect.any(Number),
            strandedCells: 0,
            floorsPopulated: 5,
            expectedFloors: 5,
          },
          exposure: {
            defaultM: 5,
            maximumM: 20,
            observedMaximumM: 20,
            invalidAnchors: 0,
          },
          cues: {
            minimumRequired: 8,
            minimumCombined: expect.any(Number),
            railPerimeterCells: expect.any(Number),
            bridgeSeamCells: expect.any(Number),
          },
          plainWallSideFailures: 0,
          guardFailures: 0,
          approachFailures: 0,
          descriptorFailures: 0,
          voidSafety: expect.any(Object),
        },
      },
      verdict: { ok: true, reasons: [] },
    })
    expect(
      rowFor(report, 'lattice').corpus.familyMetrics.reachability.walkableCells
    ).toBeGreaterThan(0)
  })

  it('requires Lattice-specific metrics even when generic family metadata is complete', async () => {
    const fixture = latticeFixture()
    const rows = latticeFamilyRows(fixture)
    const office = structuredClone(rows[0])
    delete rows.find((row) => row.family === 'lattice').corpus.familyMetrics

    const report = await runLatticeAudit({ fixtures: [fixture], rows })

    expectOnlyFamilyFailure(report, 'lattice', 'missing-family-metrics')
    expectOfficeIndependent(report, office)
  })

  it('rejects production evidence that contains only four of the five Lattice floors', async () => {
    const fixture = latticeFixture()
    const rows = latticeFamilyRows(fixture)
    const office = structuredClone(rows[0])
    const descriptor = latticeDescriptorFromFixture(fixture)
    for (const participant of descriptor.participants) {
      fixture.chunks.delete(`${participant.cx},${descriptor.topCy},${participant.cz}`)
    }

    const report = await runLatticeAudit({ fixtures: [fixture], rows })

    expectOnlyFamilyFailure(report, 'lattice', 'lattice:missing-floor-audit')
    expectOfficeIndependent(report, office)
  })

  it.each([
    {
      label: 'hard void-death proof',
      reason: 'missing-hard-void-death-evidence',
      damage(voidSafety) {
        delete voidSafety.hardVoidDeath
      },
    },
    {
      label: 'deterministic reset proof',
      reason: 'missing-deterministic-reset-evidence',
      damage(voidSafety) {
        delete voidSafety.deterministicReset
      },
    },
    {
      label: 'matched lethal-half parity',
      reason: 'void-plane-mismatch',
      damage(voidSafety) {
        voidSafety.hardVoidDeath.halves.lethalVoidDown.cells[0].deathYmm--
      },
    },
    {
      label: 'canonical lethal ownership',
      reason: 'void-ownership-mismatch',
      damage(voidSafety) {
        voidSafety.hardVoidDeath.ownership.id++
      },
    },
    {
      label: 'same-profile reset baseline',
      reason: 'reset-baseline-mismatch',
      damage(voidSafety) {
        voidSafety.deterministicReset.after.profileIdentity = 'lattice-drifted-profile'
      },
    },
  ])(
    'uses the exact Foundation verdict when Lattice lacks $label',
    async ({ damage, reason }) => {
      const fixture = latticeFixture()
      const rows = latticeFamilyRows(fixture)
      const office = structuredClone(rows[0])
      const lattice = rows.find((row) => row.family === 'lattice')
      const metrics = lattice.corpus.familyMetrics
      damage(metrics.voidSafety)
      const api = await plannedFamilyAudit()
      const canonicalSafetyVerdict = api.validateVoidSafetyEligibility({
        family: 'lattice',
        enabled: true,
        corpus: { profileIdentity: lattice.profileIdentity },
        voidSafety: metrics.voidSafety,
      })

      expect(canonicalSafetyVerdict).toEqual({ ok: false, reasons: [reason] })

      const report = await runLatticeAudit({ fixtures: [fixture], rows })

      expect(rowFor(report, 'lattice').verdict).toEqual(canonicalSafetyVerdict)
      expect(report.ok).toBe(false)
      for (const row of report.familyRows) {
        if (row.family !== 'lattice') {
          expect(row.verdict).toEqual({ ok: true, reasons: [] })
        }
      }
      expectOfficeIndependent(report, office)
    }
  )
})

describe('hotel office-fabric registration and chunk evidence (D06/D10)', () => {
  it('registers hotel through the office kind adapter without a parallel namespace', async () => {
    const api = await plannedFamilyAudit()
    const hotelFamily = api.FAMILY_AUDIT_ADAPTERS.families.hotel
    const officeKind = api.FAMILY_AUDIT_ADAPTERS.kinds.officeMultilevel
    const report = await runHotelAudit()

    expect(hotelFamily).toMatchObject({
      family: 'hotel',
      kinds: ['officeMultilevel'],
    })
    expect(Object.isFrozen(hotelFamily)).toBe(true)
    expect(officeKind.family).toBe('office')
    expect(report.ok).toBe(true)
    expect(rowFor(report, 'hotel').verdict).toEqual({ ok: true, reasons: [] })
  })

  it('isolates a missing hotel family adapter without damaging office evidence', async () => {
    const rows = hotelFamilyRows()
    const office = structuredClone(rows[0])
    const report = await runHotelAudit({
      rows,
      adapterOmission: { scope: 'families', key: 'hotel' },
    })

    expectOnlyFamilyFailure(report, 'hotel', 'missing-family-adapter')
    expectOfficeIndependent(report, office)
  })

  it('does not extend the office-fabric alias to any other family row', async () => {
    const rows = sewerFamilyRows()
    const office = structuredClone(rows[0])
    const report = await runAudit({
      profiles: sewerProfiles(),
      emissions: [
        { family: 'office', kind: 'officeMultilevel', fixtures: [] },
        { family: 'sewer', kind: 'officeMultilevel', fixtures: [] },
      ],
      rows,
    })

    expectOnlyFamilyFailure(report, 'sewer', 'missing-kind-adapter')
    expectOfficeIndependent(report, office)
  })

  it('audits generated hotel chunks through the office adapter registration', async () => {
    const api = await plannedFamilyAudit()
    const config = worldConfigForFamily(MAP_FAMILY_HOTEL)
    const chunks = new Map()
    for (const [cx, cy, cz] of [[-3, -15, -1], [-2, -15, -1], [0, 0, 0]]) {
      chunks.set(`${cx},${cy},${cz}`, buildChunk(12345, cx, cy, cz, config))
    }

    const report = api.auditChunkFamilyRegistrations(chunks)
    const structured = chunks.get('-3,-15,-1')

    expect(structured.mapFamily).toBe('hotel')
    expect(structured.structure).not.toHaveProperty('family')
    expect(report).toMatchObject({
      ok: true,
      familyCounts: { hotel: 3 },
      kindCounts: { officeMultilevel: 2 },
      failures: [],
    })
  })

  it('fails closed when another family claims a family-less office descriptor', async () => {
    const api = await plannedFamilyAudit()
    const config = worldConfigForFamily(MAP_FAMILY_HOTEL)
    const hotelChunk = buildChunk(12345, -3, -15, -1, config)

    const report = api.auditChunkFamilyRegistrations([
      { mapFamily: 'tower', structure: hotelChunk.structure },
    ])

    expect(report.ok).toBe(false)
    expect(report.failures).toEqual([
      { family: 'tower', kind: 'officeMultilevel', reason: 'missing-kind-adapter' },
    ])
  })
})

describe('cross-family rollback evidence (task 6.1 RED)', () => {
  it('[R34-S03][D10] retains every active emitter row after an unrelated family rollback', async () => {
    const rows = familyRows().filter((row) => row.family !== 'sewer')
    const office = structuredClone(rows.find((row) => row.family === 'office'))

    const report = await runAudit({ rows })

    expect(report.ok).toBe(true)
    expect(report.reasons).toEqual([])
    expect(rowFor(report, 'sewer')).toBeUndefined()
    expect(rowFor(report, 'tower')).toMatchObject({
      enabled: true,
      verdict: { ok: true, reasons: [] },
    })
    expectOfficeIndependent(report, office)

    const missingActiveRow = await runAudit({
      rows: rows.filter((row) => row.family !== 'tower'),
    })
    expect(missingActiveRow.ok).toBe(false)
    expect(missingActiveRow.reasons).toEqual(['missing-family-row:tower'])
    expectOfficeIndependent(missingActiveRow, office)
  })

  it('[R34-S04][D10] removes only the rolled-back family descriptor and row when shared bytes permit', async () => {
    const rows = familyRows()
    const emissions = emittedKinds()
    const office = structuredClone(rows.find((row) => row.family === 'office'))
    const officeEmission = structuredClone(
      emissions.find((emission) => emission.family === 'office')
    )

    const report = await runAudit({
      profiles: [
        { family: 'office', enabled: true },
        { family: 'tower', enabled: false },
      ],
      emissions: emissions.filter((emission) => emission.family !== 'tower'),
      rows: rows.filter((row) => row.family !== 'tower'),
    })

    expect(report.ok).toBe(true)
    expect(report.reasons).toEqual([])
    expect(rowFor(report, 'tower')).toBeUndefined()
    expectOfficeIndependent(report, office)
    expect(emissions.find((emission) => emission.family === 'office'))
      .toEqual(officeEmission)
  })

  it('[R07-S01][D11] accepts restoration only when version, bytes, pins, and corpus match a known passing revision', async () => {
    const validateRollbackEvidence = await plannedRollbackValidator(
      'known-version-restoration'
    )
    const evidence = familyRollbackEvidence()

    expect(validateRollbackEvidence(evidence)).toEqual({ ok: true, reasons: [] })

    const unknownRevision = structuredClone(evidence)
    unknownRevision.restored.version = evidence.current.version
    expect(validateRollbackEvidence(unknownRevision)).toEqual({
      ok: false,
      reasons: ['unknown-rollback-revision'],
    })
  })

  it('[R35-S01][D10/D11] accepts a complete Foundation rollback as one known passing contract set', async () => {
    const validateRollbackEvidence = await plannedRollbackValidator(
      'complete-foundation-rollback'
    )

    expect(validateRollbackEvidence(foundationRollbackEvidence()))
      .toEqual({ ok: true, reasons: [] })
  })

  it('[R35-S02][D10/D11] rejects a partial Foundation rollback that leaves a family emitter without audit support', async () => {
    const validateRollbackEvidence = await plannedRollbackValidator(
      'partial-foundation-rollback'
    )
    const evidence = foundationRollbackEvidence()
    evidence.restored.emittedFamilies.push('tower')
    delete evidence.restored.contracts.auditSchema

    expect(validateRollbackEvidence(evidence)).toEqual({
      ok: false,
      reasons: ['partial-foundation-rollback'],
    })
  })
})
