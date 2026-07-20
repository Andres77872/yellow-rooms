#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { buildChunk } from '../src/world/pipeline.js'
import {
  DEFAULT_WORLD_CONFIG as CONFIG,
  LATTICE_RELEASE_EVIDENCE,
  SEWER_RELEASE_EVIDENCE,
  TOWER_RELEASE_EVIDENCE,
} from '../src/world/config.js'
import {
  CHUNK,
  WORLD_GEN_VERSION,
  ZONE_OFFICE,
  ZONE_PILLARS,
  ZONE_SEWER,
  ZONE_WAREHOUSE,
} from '../src/world/constants.js'
import { hashStr } from '../src/world/core/hash.js'
import { ASCII_LEGEND, renderAsciiPatch } from '../src/world/asciiMap.js'
import { regionLandmark, roomDominanceConfig, selectZone } from '../src/world/zones/regions.js'
import { auditLayeredPatch } from '../src/world/audit.js'
import { borderPairMode } from '../src/world/border.js'
import {
  auditFamilyCompleteness,
  FAMILY_AUDIT_ADAPTERS,
  LATTICE_AUDIT_DIMENSIONS,
  validateActivationEvidence,
} from '../src/world/familyAudit.js'
import { worldConfigForFamily } from '../src/world/mapFamily.js'
import { structureAt } from '../src/world/structures/contract.js'
import { structureAdapterFor } from '../src/world/structures/contract.js'
import { LATTICE_STRUCTURE_KIND } from '../src/world/structures/lattice.js'
import { TOWER_LANDMARK_SOCKET_KINDS } from '../src/world/structures/tower.js'
import {
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  SEWER_DIRECTIONS,
  SEWER_MODULE_KINDS,
} from '../src/world/mapTypes.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  CELL_ROOM,
  CELL_STAIR,
  CELL_VOID,
} from '../src/world/mapTypes.js'

const readPositiveInt = (name, fallback) => {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} requires a positive integer`)
  }
  return value
}

const readFamilySelection = () => {
  const index = process.argv.indexOf('--family')
  if (index < 0) return []
  const family = process.argv[index + 1]
  if (family === 'all') {
    return [MAP_FAMILY_SEWER, MAP_FAMILY_TOWER, MAP_FAMILY_LATTICE]
  }
  if ([MAP_FAMILY_SEWER, MAP_FAMILY_TOWER, MAP_FAMILY_LATTICE].includes(family)) {
    return [family]
  }
  if (family === MAP_FAMILY_OFFICE) return []
  throw new Error('--family requires office, sewer, tower, lattice, or all')
}

const seedCount = readPositiveInt('--seeds', 10000)
const radius = readPositiveInt('--radius', 4)
const wideSeeds = readPositiveInt('--wide-seeds', 32)
const wideRadius = readPositiveInt('--wide-radius', 80)
const level = readPositiveInt('--level', 1)
const explicitlyRequestedFamilies = readFamilySelection()
const requestedFamilies = [
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  MAP_FAMILY_LATTICE,
].filter((family) =>
  explicitlyRequestedFamilies.includes(family) ||
  CONFIG.mapFamily.profiles[family].enabled === true
)
// --render: print an ASCII floor map instead of running the audit corpus.
//   node scripts/audit-worldgen.mjs --render --family lattice \
//     --render-seed lobby --cy 0 --at 0,0 --span 3
// Seed derivation matches Engine.startRun (hashStr(`${text}#${level}`)) so a
// rendered map reproduces the in-game world for ?seed=<text>. Exits before any
// scan/corpus work so the default JSON output contract stays untouched.
if (process.argv.includes('--render')) {
  const readString = (name, fallback) => {
    const index = process.argv.indexOf(name)
    return index < 0 ? fallback : process.argv[index + 1]
  }
  const readInt = (name, fallback) => {
    const index = process.argv.indexOf(name)
    if (index < 0) return fallback
    const value = Number(process.argv[index + 1])
    if (!Number.isSafeInteger(value)) throw new Error(`${name} requires an integer`)
    return value
  }
  const family = readString('--family', MAP_FAMILY_OFFICE)
  const renderable = [MAP_FAMILY_OFFICE, MAP_FAMILY_SEWER, MAP_FAMILY_TOWER, MAP_FAMILY_LATTICE]
  if (!renderable.includes(family)) {
    throw new Error('--render requires a single family: office, sewer, tower, or lattice')
  }
  const config = family === MAP_FAMILY_OFFICE ? CONFIG : worldConfigForFamily(family, CONFIG)
  const seedText = readString('--render-seed', 'lobby')
  const seed = hashStr(`${seedText}#${level}`)
  const cy = readInt('--cy', 0)
  const [atX, atZ] = readString('--at', '0,0').split(',').map(Number)
  if (!Number.isSafeInteger(atX) || !Number.isSafeInteger(atZ)) {
    throw new Error('--at requires cx,cz integers')
  }
  const span = readPositiveInt('--span', 3)
  const rendered = new Map()
  const dataAt = (cx, ccy, cz) => {
    const key = `${cx},${ccy},${cz}`
    if (!rendered.has(key)) rendered.set(key, buildChunk(seed, cx, ccy, cz, config))
    return rendered.get(key)
  }
  console.log(
    `family ${family} · seed "${seedText}" #${level} · cy ${cy} · ` +
    `${span}x${span} chunks at (${atX},${atZ})`
  )
  console.log()
  console.log(renderAsciiPatch(dataAt, atX, cy, atZ, span, span))
  console.log()
  console.log(ASCII_LEGEND)
  process.exit(0)
}

const dominance = roomDominanceConfig(CONFIG)
const maxSpan = Math.max(dominance.maxSpanChunks, dominance.heroMaxSpanChunks)

const zoneLabel = {
  [ZONE_OFFICE]: 'office',
  [ZONE_PILLARS]: 'pillars',
  [ZONE_WAREHOUSE]: 'warehouse',
}
const zoneGlyph = {
  [ZONE_OFFICE]: 'O',
  [ZONE_PILLARS]: 'P',
  [ZONE_WAREHOUSE]: 'W',
}
const cellLabel = {
  [CELL_OPEN]: 'open',
  [CELL_ROOM]: 'room',
  [CELL_CORRIDOR]: 'corridor',
  [CELL_LOBBY]: 'lobby',
  [CELL_STAIR]: 'stair',
  [CELL_ATRIUM]: 'atrium',
  [CELL_VOID]: 'void',
  [CELL_BRIDGE]: 'bridge',
}

const worldSeed = (index) => hashStr(`audit-${index}#${level}`)

const sewerWorldSeed = (index) => hashStr(`audit-sewer-${index}#${level}`)
const sewerCellKey = (lx, lz) => `${lx},${lz}`
const sewerEdgeOrder = (left, right) => left.a - right.a || left.b - right.b
const SEWER_PIN_FIELDS = Object.freeze([
  'wallV',
  'wallH',
  'passageV',
  'passageH',
  'wallFeatureV',
  'wallFeatureH',
  'cols',
  'cellKind',
  'spaceId',
  'spaceRole',
])

function sewerPinSnapshot(data) {
  return {
    version: data.version,
    cx: data.cx,
    cy: data.cy,
    cz: data.cz,
    mapFamily: data.mapFamily,
    zone: data.zone,
    ...Object.fromEntries(
      SEWER_PIN_FIELDS.map((field) => [field, Array.from(data[field])])
    ),
    repairs: data.repairs,
    lamps: data.lamps,
    furniture: data.furniture,
    exit: data.exit,
    stairUp: data.stairUp,
    stairDown: data.stairDown,
    sewerDescriptor: data.sewerDescriptor,
    // Snapshot keys keep their historical names: these digests are pinned
    // release evidence, and the carrier-field rename must not rewrite them.
    multilevelStructure: data.structure,
    multilevelUp: data.structureUp,
    multilevelDown: data.structureDown,
  }
}

const sewerCorpusDigest = (snapshots) => createHash('sha256')
  .update(JSON.stringify(snapshots))
  .digest('hex')

const TOWER_AUDIT_SEEDS = Object.freeze([0x5a17, 0x7157, 0xc0ffee])
const TOWER_PIN_FIELDS = Object.freeze([
  'wallV',
  'wallH',
  'passageV',
  'passageH',
  'wallFeatureV',
  'wallFeatureH',
  'cols',
  'cellKind',
  'spaceId',
  'spaceRole',
])

function towerPinSnapshot(data) {
  return {
    version: data.version,
    cx: data.cx,
    cy: data.cy,
    cz: data.cz,
    mapFamily: data.mapFamily,
    zone: data.zone,
    ...Object.fromEntries(
      TOWER_PIN_FIELDS.map((field) => [field, Array.from(data[field])])
    ),
    lamps: data.lamps,
    stairUp: data.stairUp,
    stairDown: data.stairDown,
    // Snapshot keys keep their historical names: these digests are pinned
    // release evidence, and the carrier-field rename must not rewrite them.
    multilevelStructure: data.structure,
    multilevelUp: data.structureUp,
    multilevelDown: data.structureDown,
    lethalVoidUp: data.lethalVoidUp,
    lethalVoidDown: data.lethalVoidDown,
  }
}

const towerCorpusDigest = (snapshots) => createHash('sha256')
  .update(JSON.stringify(snapshots))
  .digest('hex')

const LATTICE_AUDIT_SEEDS = Object.freeze([
  hashStr(`audit-lattice-0#${level}`),
  hashStr(`audit-lattice-1#${level}`),
  hashStr(`audit-lattice-2#${level}`),
])
const LATTICE_PIN_FIELDS = TOWER_PIN_FIELDS

function latticePinSnapshot(data) {
  return {
    version: data.version,
    cx: data.cx,
    cy: data.cy,
    cz: data.cz,
    mapFamily: data.mapFamily,
    zone: data.zone,
    ...Object.fromEntries(
      LATTICE_PIN_FIELDS.map((field) => [field, Array.from(data[field])])
    ),
    lamps: data.lamps,
    stairUp: data.stairUp,
    stairDown: data.stairDown,
    // Snapshot keys keep their historical names: these digests are pinned
    // release evidence, and the carrier-field rename must not rewrite them.
    multilevelStructure: data.structure,
    multilevelUp: data.structureUp,
    multilevelDown: data.structureDown,
    lethalVoidUp: data.lethalVoidUp,
    lethalVoidDown: data.lethalVoidDown,
  }
}

const latticeCorpusDigest = (snapshots) => createHash('sha256')
  .update(JSON.stringify(snapshots))
  .digest('hex')

function forcedSewerAuditConfig() {
  const config = worldConfigForFamily(MAP_FAMILY_SEWER, CONFIG)
  const releaseProfileEnabled = config.mapFamily.profiles.sewer.enabled === true
  // The audit row remains forced-profile isolated even after release activation;
  // this assignment also keeps rollback audits able to inspect disabled bytes.
  config.mapFamily.profiles.sewer.enabled = true
  return { config, releaseProfileEnabled }
}

function physicalSewerLinks(data, descriptor) {
  const indexByCell = new Map(
    descriptor.modules.map((module, index) => [
      sewerCellKey(module.lx, module.lz),
      index,
    ])
  )
  const links = []
  const add = (a, b) => {
    if (b === undefined) return
    links.push(a < b ? { a, b } : { a: b, b: a })
  }

  for (let index = 0; index < descriptor.modules.length; index++) {
    const module = descriptor.modules[index]
    if (module.lx + 1 < CHUNK && data.vAt(module.lx + 1, module.lz) === 0) {
      add(index, indexByCell.get(sewerCellKey(module.lx + 1, module.lz)))
    }
    if (module.lz + 1 < CHUNK && data.hAt(module.lx, module.lz + 1) === 0) {
      add(index, indexByCell.get(sewerCellKey(module.lx, module.lz + 1)))
    }
  }

  links.sort(sewerEdgeOrder)
  return links.filter((edge, index) =>
    index === 0 || sewerEdgeOrder(links[index - 1], edge) !== 0
  )
}

function reachableSewerModules(raster, rootIndex) {
  const allowed = new Set(raster.traversableModules)
  const adjacency = Array.from({ length: allowed.size }, () => [])
  for (const { a, b } of raster.links) {
    if (!adjacency[a] || !adjacency[b]) continue
    adjacency[a].push(b)
    adjacency[b].push(a)
  }
  const seen = new Set()
  if (!allowed.has(rootIndex)) return seen
  const queue = [rootIndex]
  seen.add(rootIndex)
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const next of adjacency[queue[cursor]]) {
      if (!allowed.has(next) || seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

function observedSewerRightTurn(descriptor) {
  const heading = descriptor.modules[0]?.dir
  const headingIndex = SEWER_DIRECTIONS.indexOf(heading)
  if (headingIndex < 0) return null
  const branch = descriptor.modules.find((module) => module.dir !== heading)?.dir
  if (!branch) return null
  const right = SEWER_DIRECTIONS[(headingIndex + 1) % SEWER_DIRECTIONS.length]
  return branch === right
}

function sewerSeamEvidence(config) {
  const office = borderPairMode(ZONE_SEWER, ZONE_OFFICE, config)
  const pillars = borderPairMode(ZONE_SEWER, ZONE_PILLARS, config)
  const warehouse = borderPairMode(ZONE_SEWER, ZONE_WAREHOUSE, config)
  return {
    office,
    openHall: pillars === 'open' && warehouse === 'open' ? 'open' : 'invalid',
  }
}

function makeSewerFixture(data, lower, upper, profile, seams) {
  // Only the canonical ChunkData field is consumed. Return wrappers or aliases
  // are intentionally invisible to release auditing.
  const descriptor = data.sewerDescriptor
  const raster = {
    traversableModules: descriptor.modules
      .map((module, index) => ({ module, index }))
      .filter(({ module }) => data.colAt(module.lx, module.lz) === 0)
      .map(({ index }) => index),
    links: physicalSewerLinks(data, descriptor),
  }
  const observedRightTurnRate = observedSewerRightTurn(descriptor)
  return {
    descriptors: [descriptor],
    sewerStructures: [{
      family: data.mapFamily,
      kind: MAP_FAMILY_SEWER,
      id: descriptor.id,
      descriptor,
      profile: {
        forcedProfile: true,
        zoneBands: structuredClone(profile.zoneBands),
        maxLoops: profile.maxLoops,
        rightTurnChance: profile.rightTurnChance,
      },
      raster,
      lighting: {
        eligibleLocations: descriptor.modules.map(({ lx, lz }) => ({ lx, lz })),
        litLocations: data.lamps
          .filter((lamp) => lamp.lit)
          .map(({ lx, lz }) => ({ lx, lz })),
      },
      risers: {
        up: !!data.stairUp && isDeepStrictEqual(data.stairUp, upper.stairDown),
        down: !!data.stairDown && isDeepStrictEqual(data.stairDown, lower.stairUp),
      },
      seams,
      observedRightTurnRate: observedRightTurnRate === null
        ? 0
        : Number(observedRightTurnRate),
    }],
  }
}

function runForcedSewerCorpus() {
  const { config, releaseProfileEnabled } = forcedSewerAuditConfig()
  const profile = config.mapFamily.profiles.sewer
  const seams = sewerSeamEvidence(config)
  const corpusSeeds = Math.min(seedCount, 32)
  const fixtures = []
  const pinSnapshots = []
  let deterministic = true
  let layered = true

  for (let index = 0; index < corpusSeeds; index++) {
    const seed = sewerWorldSeed(index)
    const cx = (index % 7) - 3
    const cz = ((index * 5) % 9) - 4
    const lower = buildChunk(seed, cx, -1, cz, config)
    const data = buildChunk(seed, cx, 0, cz, config)
    const upper = buildChunk(seed, cx, 1, cz, config)
    deterministic &&= isDeepStrictEqual(
      data,
      buildChunk(seed, cx, 0, cz, config)
    )

    const chunks = new Map([
      [`${cx},-1,${cz}`, lower],
      [`${cx},0,${cz}`, data],
      [`${cx},1,${cz}`, upper],
    ])
    layered &&= auditLayeredPatch(
      (x, y, z) => chunks.get(`${x},${y},${z}`) ?? null,
      cx,
      -1,
      cz,
      1,
      3,
      1
    ).ok
    fixtures.push(makeSewerFixture(data, lower, upper, profile, seams))
    pinSnapshots.push(sewerPinSnapshot(data))
  }

  const moduleCoverage = new Set()
  let deferredModules = 0
  let unreachableModules = 0
  let insertedLoops = 0
  let loopBudget = 0
  let eligibleNonTreeLinks = 0
  let eligibleLights = 0
  let litLights = 0
  let descriptorFailures = 0
  let rightTurns = 0
  let turnSamples = 0
  const adapter = FAMILY_AUDIT_ADAPTERS.kinds.sewer

  for (const fixture of fixtures) {
    const structure = fixture.sewerStructures[0]
    const descriptor = structure.descriptor
    for (const module of descriptor.modules) {
      moduleCoverage.add(module.kind)
      if (!SEWER_MODULE_KINDS.includes(module.kind)) deferredModules++
    }
    const rootIndex = descriptor.modules.findIndex((module) =>
      module.lx === descriptor.trunkRoot.lx && module.lz === descriptor.trunkRoot.lz
    )
    const reachable = reachableSewerModules(structure.raster, rootIndex)
    unreachableModules += descriptor.modules.length - reachable.size
    insertedLoops += descriptor.loopEdges.length
    loopBudget += structure.profile.maxLoops
    eligibleNonTreeLinks += descriptor.eligibleNonTreeLinks
    eligibleLights += structure.lighting.eligibleLocations.length
    litLights += structure.lighting.litLocations.length
    descriptorFailures += adapter.auditFixture(fixture).length
    rightTurns += structure.observedRightTurnRate
    turnSamples++
  }

  const familyMetrics = {
    moduleCoverage: SEWER_MODULE_KINDS.filter((kind) => moduleCoverage.has(kind)),
    deferredModules,
    unreachableModules,
    loops: {
      inserted: insertedLoops,
      budget: loopBudget,
      eligibleNonTreeLinks,
    },
    lights: {
      eligible: eligibleLights,
      lit: litLights,
      unlit: eligibleLights - litLights,
    },
    seams,
    descriptorFailures,
    observedRightTurnRate: turnSamples > 0 ? rightTurns / turnSamples : 0,
  }
  const profileIdentity = [
    'sewer-forced-audit',
    `loops-${profile.maxLoops}`,
    `right-${profile.rightTurnChance}`,
    `lamp-${profile.lampPhase}-${profile.lampChance}`,
  ].join(':')
  const seedDerivation = `hashStr("audit-sewer-N#${level}")`
  const familyPin = sewerCorpusDigest(pinSnapshots)
  const activationVerdict = validateActivationEvidence({
    family: MAP_FAMILY_SEWER,
    enabled: releaseProfileEnabled,
    byteImpact: SEWER_RELEASE_EVIDENCE.byteImpact,
    affectsMaximumHeight: SEWER_RELEASE_EVIDENCE.affectsMaximumHeight,
    previous: {
      version: SEWER_RELEASE_EVIDENCE.previousVersion,
      digest: SEWER_RELEASE_EVIDENCE.previousFamilyCorpusDigest,
    },
    candidate: {
      version: WORLD_GEN_VERSION,
      digest: familyPin,
    },
    pins: {
      global: {
        version: SEWER_RELEASE_EVIDENCE.generatorVersion,
        digest: SEWER_RELEASE_EVIDENCE.globalGoldenDigest,
      },
      family: {
        family: MAP_FAMILY_SEWER,
        version: SEWER_RELEASE_EVIDENCE.generatorVersion,
        digest: SEWER_RELEASE_EVIDENCE.familyCorpusDigest,
      },
      maximumHeight: null,
    },
    corpus: {
      version: SEWER_RELEASE_EVIDENCE.generatorVersion,
      profileIdentity,
      seedDerivation,
    },
  })
  const releaseEvidenceFresh = releaseProfileEnabled &&
    WORLD_GEN_VERSION === SEWER_RELEASE_EVIDENCE.generatorVersion &&
    SEWER_RELEASE_EVIDENCE.generatorVersion ===
      SEWER_RELEASE_EVIDENCE.previousVersion + 1 &&
    SEWER_RELEASE_EVIDENCE.affectsMaximumHeight === false &&
    profileIdentity === SEWER_RELEASE_EVIDENCE.profileIdentity &&
    seedDerivation === SEWER_RELEASE_EVIDENCE.seedDerivation &&
    activationVerdict.ok

  return {
    releaseProfileEnabled,
    fixtures,
    row: {
      family: MAP_FAMILY_SEWER,
      enabled: releaseProfileEnabled,
      forcedProfile: true,
      generatorVersion: WORLD_GEN_VERSION,
      profileIdentity,
      seedDerivation,
      pins: { family: releaseEvidenceFresh, maximumHeight: null },
      corpus: {
        seeds: corpusSeeds,
        chunks: fixtures.length,
        officeChunks: 0,
        determinism: deterministic,
        layered,
        familyMetrics,
        pin: { algorithm: 'sha256', digest: familyPin },
        status: releaseEvidenceFresh
          ? 'release-profile-enabled'
          : releaseProfileEnabled
            ? 'release-evidence-stale'
            : 'forced-audit-release-profile-disabled',
      },
    },
  }
}

function forcedTowerAuditConfig() {
  const base = structuredClone(CONFIG)
  const releaseProfileEnabled = base.mapFamily.profiles.tower.enabled === true
  // The audit row remains forced-profile isolated after release activation;
  // this assignment also keeps rollback audits able to inspect disabled bytes.
  base.mapFamily.profiles.tower.enabled = true
  return {
    config: worldConfigForFamily(MAP_FAMILY_TOWER, base),
    releaseProfileEnabled,
  }
}

function findTowerAuditDescriptor(seed, config) {
  for (let cy = -24; cy <= 24; cy++) {
    for (let cz = -4; cz <= 4; cz++) {
      for (let cx = -4; cx <= 4; cx++) {
        const descriptor = structureAt(seed, cx, cz, cy, config)
        if (descriptor?.family === MAP_FAMILY_TOWER && descriptor.hasRoom === true) {
          return descriptor
        }
      }
    }
  }
  throw new Error(`forced Tower audit seed ${seed} has no bounded fixture`)
}

function towerFixtureChunks(seed, descriptor, config) {
  const chunks = new Map()
  for (let cy = descriptor.baseCy; cy <= descriptor.topCy; cy++) {
    for (const participant of descriptor.participants) {
      const data = buildChunk(seed, participant.cx, cy, participant.cz, config)
      chunks.set(`${participant.cx},${cy},${participant.cz}`, data)
    }
  }
  return chunks
}

function towerFixture(descriptor, chunks) {
  return {
    descriptors: [descriptor],
    participantStructures: descriptor.participants.map((participant) => ({
      ...participant,
      family: descriptor.family,
      kind: descriptor.kind,
      id: descriptor.id,
      baseCy: descriptor.baseCy,
      topCy: descriptor.topCy,
      descriptor,
    })),
    chunks: [...chunks.values()],
  }
}

function towerLayeredAudit(descriptor, chunks) {
  const xs = descriptor.participants.map(({ cx }) => cx)
  const zs = descriptor.participants.map(({ cz }) => cz)
  const x0 = Math.min(...xs)
  const z0 = Math.min(...zs)
  return auditLayeredPatch(
    (cx, cy, cz) => chunks.get(`${cx},${cy},${cz}`) ?? null,
    x0,
    descriptor.baseCy,
    z0,
    Math.max(...xs) - x0 + 1,
    descriptor.levelCount,
    Math.max(...zs) - z0 + 1
  )
}

function towerEnclosedSlices(descriptor, chunks) {
  let slices = 0
  for (const data of chunks.values()) {
    const x0 = Math.max(descriptor.globalBounds.x0, data.cx * CHUNK)
    const z0 = Math.max(descriptor.globalBounds.z0, data.cz * CHUNK)
    const x1 = Math.min(descriptor.globalBounds.x1, (data.cx + 1) * CHUNK - 1)
    const z1 = Math.min(descriptor.globalBounds.z1, (data.cz + 1) * CHUNK - 1)
    let enclosed = false
    for (let gz = z0; gz <= z1 && !enclosed; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const lx = gx - data.cx * CHUNK
        const lz = gz - data.cz * CHUNK
        const index = lz * CHUNK + lx
        if (
          data.cellKind[index] === CELL_LOBBY &&
          data.spaceId[index] === descriptor.id &&
          !data.hasFloorHole(lx, lz)
        ) {
          enclosed = true
          break
        }
      }
    }
    if (enclosed) slices++
  }
  return slices
}

function towerApproachMatches(descriptor, chunks) {
  const deck = descriptor.decks[0]
  return descriptor.participants.filter((participant) => {
    const data = chunks.get(`${participant.cx},${deck.levelCy},${participant.cz}`)
    return data?.structureDown?.id === descriptor.id &&
      data.structureDown.kind === descriptor.kind &&
      data.structureDown.levelCy === deck.levelCy
  }).length
}

function towerConnectedFloors(descriptor, chunks) {
  const matched = descriptor.verticalLinks.filter((link) => {
    const lower = chunks.get(`${link.cx},${link.lowerCy},${link.cz}`)
    const upper = chunks.get(`${link.cx},${link.lowerCy + 1},${link.cz}`)
    return isDeepStrictEqual(lower?.stairUp, link.stair) &&
      isDeepStrictEqual(upper?.stairDown, link.stair)
  }).length
  return matched === 2 ? 3 : matched + 1
}

function towerVoidSafety(fixtures, profileIdentity, initialDigest, deterministic) {
  for (const { descriptor, chunks, seed } of fixtures) {
    for (let lowerCy = descriptor.baseCy; lowerCy < descriptor.topCy; lowerCy++) {
      for (const participant of descriptor.participants) {
        const lower = chunks.get(`${participant.cx},${lowerCy},${participant.cz}`)
        const upper = chunks.get(`${participant.cx},${lowerCy + 1},${participant.cz}`)
        const up = lower?.lethalVoidUp
        const down = upper?.lethalVoidDown
        if (!up || !down || !isDeepStrictEqual(up, down) || up.cells.length === 0) continue
        const cell = up.cells[0]
        const plane = structureAdapterFor(descriptor)?.hardVoidAt(
          upper,
          cell.lx,
          cell.lz
        )
        const baseline = {
          version: WORLD_GEN_VERSION,
          seedText: `fixed-root-${seed >>> 0}`,
          level,
          mapFamily: MAP_FAMILY_TOWER,
          profileIdentity,
          initialDigest,
        }
        return {
          hardVoidDeath: {
            ok: plane !== null,
            deathReason: 'void',
            callbackCount: 1,
            plane,
            halves: {
              lethalVoidUp: structuredClone(up),
              lethalVoidDown: structuredClone(down),
            },
            ownership: {
              id: descriptor.id,
              family: descriptor.family,
              lowerCy,
            },
          },
          deterministicReset: {
            ok: deterministic,
            before: structuredClone(baseline),
            after: structuredClone(baseline),
          },
        }
      }
    }
  }
  return {
    hardVoidDeath: null,
    deterministicReset: null,
  }
}

function runForcedTowerCorpus() {
  const { config, releaseProfileEnabled } = forcedTowerAuditConfig()
  const profile = config.mapFamily.profiles.tower
  const corpusSeeds = Math.min(seedCount, TOWER_AUDIT_SEEDS.length)
  const generated = []
  const fixtures = []
  const pinSnapshots = []
  let deterministic = true
  let layered = true

  for (const seed of TOWER_AUDIT_SEEDS.slice(0, corpusSeeds)) {
    const descriptor = findTowerAuditDescriptor(seed, config)
    const chunks = towerFixtureChunks(seed, descriptor, config)
    for (const data of chunks.values()) {
      const repeated = buildChunk(seed, data.cx, data.cy, data.cz, config)
      deterministic &&= isDeepStrictEqual(data, repeated)
      pinSnapshots.push(towerPinSnapshot(data))
    }
    layered &&= towerLayeredAudit(descriptor, chunks).ok
    generated.push({ seed, descriptor, chunks })
    fixtures.push(towerFixture(descriptor, chunks))
  }

  const adapter = FAMILY_AUDIT_ADAPTERS.kinds.towerSkybridge
  const fixtureReasons = fixtures.map((fixture) => adapter.auditFixture(fixture))
  const descriptorFailures = fixtureReasons.reduce((sum, reasons) => sum + reasons.length, 0)
  const guardFailures = fixtureReasons.reduce(
    (sum, reasons) => sum + reasons.filter((reason) => reason === 'tower:invalid-guard').length,
    0
  )
  const socketKinds = new Set()
  const anchorFloors = new Set()
  let minimumApproachSockets = 2
  let minimumMatchedApproaches = 2
  let minimumConnectedFloors = 3
  let minimumEnclosedSlices = 6
  let minimumDecks = 1
  for (const { descriptor, chunks } of generated) {
    for (const socket of descriptor.landmarkSockets) {
      socketKinds.add(socket.kind)
      if (socket.slot === 'anchorFloor') anchorFloors.add(socket.cy - descriptor.baseCy)
    }
    const approachSockets = new Set(descriptor.landmarkSockets
      .filter((socket) => socket.slot === 'bridgeApproach')
      .map((socket) => `${Math.floor(socket.gx / CHUNK)},${Math.floor(socket.gz / CHUNK)}`))
    minimumApproachSockets = Math.min(minimumApproachSockets, approachSockets.size)
    minimumMatchedApproaches = Math.min(
      minimumMatchedApproaches,
      towerApproachMatches(descriptor, chunks)
    )
    minimumConnectedFloors = Math.min(
      minimumConnectedFloors,
      towerConnectedFloors(descriptor, chunks)
    )
    minimumEnclosedSlices = Math.min(
      minimumEnclosedSlices,
      towerEnclosedSlices(descriptor, chunks)
    )
    minimumDecks = Math.min(minimumDecks, descriptor.decks.length)
  }

  const profileIdentity = [
    'tower-forced-audit',
    `levels-${profile.levels}`,
    `participants-${profile.participants}`,
    `skybridge-${profile.skybridgeLevelOffset}`,
  ].join(':')
  const seedDerivation = 'fixed-root-seeds(0x5a17,0x7157,0xc0ffee)'
  const familyPin = towerCorpusDigest(pinSnapshots)
  const voidSafety = towerVoidSafety(
    generated,
    profileIdentity,
    familyPin,
    deterministic
  )
  const activationVerdict = validateActivationEvidence({
    family: MAP_FAMILY_TOWER,
    enabled: releaseProfileEnabled,
    byteImpact: TOWER_RELEASE_EVIDENCE.byteImpact,
    affectsMaximumHeight: TOWER_RELEASE_EVIDENCE.affectsMaximumHeight,
    previous: {
      version: TOWER_RELEASE_EVIDENCE.previousVersion,
      digest: TOWER_RELEASE_EVIDENCE.previousFamilyCorpusDigest,
    },
    candidate: {
      version: WORLD_GEN_VERSION,
      digest: familyPin,
    },
    pins: {
      global: {
        version: TOWER_RELEASE_EVIDENCE.generatorVersion,
        digest: TOWER_RELEASE_EVIDENCE.globalGoldenDigest,
      },
      family: {
        family: MAP_FAMILY_TOWER,
        version: TOWER_RELEASE_EVIDENCE.generatorVersion,
        digest: TOWER_RELEASE_EVIDENCE.familyCorpusDigest,
      },
      maximumHeight: {
        version: TOWER_RELEASE_EVIDENCE.generatorVersion,
        digest: TOWER_RELEASE_EVIDENCE.maximumHeightGoldenDigest,
      },
    },
    corpus: {
      version: TOWER_RELEASE_EVIDENCE.generatorVersion,
      profileIdentity,
      seedDerivation,
    },
    voidSafety,
  })
  const releaseEvidenceFresh = releaseProfileEnabled &&
    WORLD_GEN_VERSION === TOWER_RELEASE_EVIDENCE.generatorVersion &&
    TOWER_RELEASE_EVIDENCE.generatorVersion ===
      TOWER_RELEASE_EVIDENCE.previousVersion + 1 &&
    TOWER_RELEASE_EVIDENCE.affectsMaximumHeight === true &&
    profileIdentity === TOWER_RELEASE_EVIDENCE.profileIdentity &&
    seedDerivation === TOWER_RELEASE_EVIDENCE.seedDerivation &&
    activationVerdict.ok
  const familyMetrics = {
    participantCardinality: generated.every(({ descriptor }) =>
      descriptor.participants.length === 2
    ) ? 2 : 0,
    floorCount: generated.every(({ descriptor }) => descriptor.levelCount === 3) ? 3 : 0,
    deckCount: minimumDecks,
    approaches: { expected: 2, matched: minimumMatchedApproaches },
    connectedFloors: minimumConnectedFloors,
    socketKinds: TOWER_LANDMARK_SOCKET_KINDS.filter((kind) => socketKinds.has(kind)),
    socketCoverage: {
      anchorFloors: [0, 1, 2].filter((floor) => anchorFloors.has(floor)),
      bridgeApproaches: minimumApproachSockets,
    },
    guardFailures,
    descriptorFailures,
    enclosedTowerSlices: minimumEnclosedSlices,
    skybridgeDecks: minimumDecks,
    // The canonical Foundation validator consumes exact generated halves and
    // deterministic-baseline evidence. This is not a Tower-only safety flag.
    voidSafety,
  }

  return {
    releaseProfileEnabled,
    fixtures,
    row: {
      family: MAP_FAMILY_TOWER,
      enabled: releaseProfileEnabled,
      forcedProfile: true,
      generatorVersion: WORLD_GEN_VERSION,
      profileIdentity,
      seedDerivation,
      pins: {
        family: releaseEvidenceFresh,
        maximumHeight: releaseEvidenceFresh,
      },
      corpus: {
        seeds: corpusSeeds,
        chunks: generated.reduce((sum, item) => sum + item.chunks.size, 0),
        officeChunks: 0,
        determinism: deterministic,
        layered,
        familyMetrics,
        pin: {
          algorithm: 'sha256',
          digest: familyPin,
          releasePinned: releaseEvidenceFresh,
        },
        status: releaseEvidenceFresh
          ? 'release-profile-enabled'
          : releaseProfileEnabled
            ? 'release-evidence-stale'
          : 'forced-audit-release-profile-disabled',
      },
    },
  }
}

function forcedLatticeAuditConfig() {
  const base = structuredClone(CONFIG)
  const releaseProfileEnabled = base.mapFamily.profiles.lattice.enabled === true
  // The audit row remains forced-profile isolated after release activation;
  // this assignment also keeps rollback audits able to inspect disabled bytes.
  base.mapFamily.profiles.lattice.enabled = true
  return {
    config: worldConfigForFamily(MAP_FAMILY_LATTICE, base),
    releaseProfileEnabled,
  }
}

function findLatticeAuditDescriptor(seed, config) {
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

function latticeFixtureChunks(seed, descriptor, config) {
  const chunks = new Map()
  for (let cy = descriptor.baseCy; cy <= descriptor.topCy; cy++) {
    for (const participant of descriptor.participants) {
      const data = buildChunk(seed, participant.cx, cy, participant.cz, config)
      chunks.set(`${participant.cx},${cy},${participant.cz}`, data)
    }
  }
  return chunks
}

function latticeLayeredAudit(descriptor, chunks) {
  const xs = descriptor.participants.map(({ cx }) => cx)
  const zs = descriptor.participants.map(({ cz }) => cz)
  const x0 = Math.min(...xs)
  const z0 = Math.min(...zs)
  return auditLayeredPatch(
    (cx, cy, cz) => chunks.get(`${cx},${cy},${cz}`) ?? null,
    x0,
    descriptor.baseCy,
    z0,
    Math.max(...xs) - x0 + 1,
    descriptor.levelCount,
    Math.max(...zs) - z0 + 1
  )
}

function latticeVoidSafety(generated, profileIdentity, initialDigest, deterministic) {
  for (const { descriptor, chunks, index } of generated) {
    for (const data of chunks.values()) {
      const upper = chunks.get(`${data.cx},${data.cy + 1},${data.cz}`)
      const up = data.lethalVoidUp
      const down = upper?.lethalVoidDown
      if (!up || !down || !isDeepStrictEqual(up, down) || up.cells.length === 0) continue
      const cell = up.cells[0]
      const plane = structureAdapterFor(descriptor)?.hardVoidAt(
        upper,
        cell.lx,
        cell.lz
      )
      const baseline = {
        version: WORLD_GEN_VERSION,
        seedText: `audit-lattice-${index}`,
        level,
        mapFamily: MAP_FAMILY_LATTICE,
        profileIdentity,
        initialDigest,
      }
      return {
        hardVoidDeath: {
          ok: plane !== null,
          deathReason: 'void',
          callbackCount: 1,
          plane,
          halves: {
            lethalVoidUp: structuredClone(up),
            lethalVoidDown: structuredClone(down),
          },
          ownership: {
            id: descriptor.id,
            family: descriptor.family,
            lowerCy: data.cy,
          },
        },
        deterministicReset: {
          ok: deterministic,
          before: structuredClone(baseline),
          after: structuredClone(baseline),
        },
      }
    }
  }
  return {
    hardVoidDeath: null,
    deterministicReset: null,
  }
}

function runForcedLatticeCorpus() {
  const { config, releaseProfileEnabled } = forcedLatticeAuditConfig()
  const profile = config.mapFamily.profiles.lattice
  const corpusSeeds = Math.min(seedCount, LATTICE_AUDIT_SEEDS.length)
  const generated = []
  const fixtures = []
  const pinSnapshots = []
  let deterministic = true
  let layered = true

  for (let index = 0; index < corpusSeeds; index++) {
    const seed = LATTICE_AUDIT_SEEDS[index]
    const descriptor = findLatticeAuditDescriptor(seed, config)
    const chunks = latticeFixtureChunks(seed, descriptor, config)
    for (const data of chunks.values()) {
      const repeated = buildChunk(seed, data.cx, data.cy, data.cz, config)
      deterministic &&= isDeepStrictEqual(data, repeated)
      pinSnapshots.push(latticePinSnapshot(data))
    }
    layered &&= latticeLayeredAudit(descriptor, chunks).ok
    generated.push({ index, seed, descriptor, chunks })
    fixtures.push({ chunks })
  }

  const profileIdentity = [
    'lattice-forced-audit',
    `levels-${profile.levels}`,
    `district-${profile.districtChunks}`,
    `anchors-${profile.anchorsPerAxis}`,
    `cycles-${profile.cycleRate.join('-')}`,
    `exposure-${profile.defaultExposureM}-${profile.maxExposureM}`,
    `cues-${profile.minimumCueCells}`,
  ].join(':')
  const seedDerivation = `hashStr("audit-lattice-N#${level}"), N=0..2`
  const familyPin = latticeCorpusDigest(pinSnapshots)
  const voidSafety = latticeVoidSafety(
    generated,
    profileIdentity,
    familyPin,
    deterministic
  )
  const activationVerdict = validateActivationEvidence({
    family: MAP_FAMILY_LATTICE,
    enabled: releaseProfileEnabled,
    byteImpact: LATTICE_RELEASE_EVIDENCE.byteImpact,
    affectsMaximumHeight: LATTICE_RELEASE_EVIDENCE.affectsMaximumHeight,
    previous: {
      version: LATTICE_RELEASE_EVIDENCE.previousVersion,
      digest: LATTICE_RELEASE_EVIDENCE.previousFamilyCorpusDigest,
    },
    candidate: {
      version: WORLD_GEN_VERSION,
      digest: familyPin,
    },
    pins: {
      global: {
        version: LATTICE_RELEASE_EVIDENCE.generatorVersion,
        digest: LATTICE_RELEASE_EVIDENCE.globalGoldenDigest,
      },
      family: {
        family: MAP_FAMILY_LATTICE,
        version: LATTICE_RELEASE_EVIDENCE.generatorVersion,
        digest: LATTICE_RELEASE_EVIDENCE.familyCorpusDigest,
      },
      maximumHeight: {
        version: LATTICE_RELEASE_EVIDENCE.generatorVersion,
        digest: LATTICE_RELEASE_EVIDENCE.maximumHeightGoldenDigest,
      },
    },
    corpus: {
      version: LATTICE_RELEASE_EVIDENCE.generatorVersion,
      profileIdentity,
      seedDerivation,
    },
    voidSafety,
  })
  const releaseEvidenceFresh = releaseProfileEnabled &&
    WORLD_GEN_VERSION === LATTICE_RELEASE_EVIDENCE.generatorVersion &&
    LATTICE_RELEASE_EVIDENCE.generatorVersion ===
      LATTICE_RELEASE_EVIDENCE.previousVersion + 1 &&
    LATTICE_RELEASE_EVIDENCE.affectsMaximumHeight === true &&
    profileIdentity === LATTICE_RELEASE_EVIDENCE.profileIdentity &&
    seedDerivation === LATTICE_RELEASE_EVIDENCE.seedDerivation &&
    activationVerdict.ok

  return {
    fixtures,
    row: {
      family: MAP_FAMILY_LATTICE,
      enabled: releaseProfileEnabled,
      forcedProfile: true,
      generatorVersion: WORLD_GEN_VERSION,
      profileIdentity,
      seedDerivation,
      pins: {
        family: releaseEvidenceFresh,
        maximumHeight: releaseEvidenceFresh,
      },
      corpus: {
        seeds: corpusSeeds,
        chunks: generated.reduce((sum, item) => sum + item.chunks.size, 0),
        officeChunks: 0,
        determinism: deterministic,
        layered,
        // The kind adapter derives every geometric metric from these generated
        // chunks. The row supplies only Foundation-owned safety evidence.
        familyMetrics: { voidSafety },
        pin: {
          algorithm: 'sha256',
          digest: familyPin,
          releasePinned: releaseEvidenceFresh,
        },
        status: releaseEvidenceFresh
          ? 'release-profile-enabled'
          : releaseProfileEnabled
            ? 'release-evidence-stale'
            : 'forced-audit-release-profile-disabled',
      },
    },
  }
}

function scanZones(seed, sampleRadius) {
  const size = sampleRadius * 2 + 1
  const zones = new Uint8Array(size * size)
  const counts = { office: 0, pillars: 0, warehouse: 0 }
  let spawnOffice = true
  for (let z = -sampleRadius; z <= sampleRadius; z++) {
    for (let x = -sampleRadius; x <= sampleRadius; x++) {
      const zone = selectZone(x, z, seed, CONFIG)
      zones[(z + sampleRadius) * size + x + sampleRadius] = zone
      counts[zoneLabel[zone]]++
      if (Math.abs(x) <= dominance.spawnOfficeRadius &&
          Math.abs(z) <= dominance.spawnOfficeRadius && zone !== ZONE_OFFICE) {
        spawnOffice = false
      }
    }
  }

  let maxOpenRun = 0
  for (let z = 0; z < size; z++) {
    let run = 0
    for (let x = 0; x < size; x++) {
      run = zones[z * size + x] === ZONE_OFFICE ? 0 : run + 1
      maxOpenRun = Math.max(maxOpenRun, run)
    }
  }
  for (let x = 0; x < size; x++) {
    let run = 0
    for (let z = 0; z < size; z++) {
      run = zones[z * size + x] === ZONE_OFFICE ? 0 : run + 1
      maxOpenRun = Math.max(maxOpenRun, run)
    }
  }

  const seen = new Uint8Array(zones.length)
  let largestOpenComponent = 0
  for (let start = 0; start < zones.length; start++) {
    if (zones[start] === ZONE_OFFICE || seen[start]) continue
    const stack = [start]
    seen[start] = 1
    let component = 0
    while (stack.length > 0) {
      const current = stack.pop()
      component++
      const x = current % size
      const z = Math.floor(current / size)
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + dx
        const nz = z + dz
        if (nx < 0 || nx >= size || nz < 0 || nz >= size) continue
        const next = nz * size + nx
        if (zones[next] === ZONE_OFFICE || seen[next]) continue
        seen[next] = 1
        stack.push(next)
      }
    }
    largestOpenComponent = Math.max(largestOpenComponent, component)
  }

  return { size, zones, counts, spawnOffice, maxOpenRun, largestOpenComponent }
}

const quantile = (sorted, p) => sorted[Math.floor((sorted.length - 1) * p)]
const spawnSamples = []
let worstOffice = null
let worstWarehouse = null
let worstComponent = null
let worstRun = null
let allSpawnOffice = true
const totals = { office: 0, pillars: 0, warehouse: 0 }

for (let index = 0; index < seedCount; index++) {
  const seed = worldSeed(index)
  const scan = scanZones(seed, radius)
  const sample = {
    index,
    seedText: `audit-${index}`,
    seed,
    ...scan,
  }
  spawnSamples.push(sample)
  for (const key of Object.keys(totals)) totals[key] += scan.counts[key]
  allSpawnOffice &&= scan.spawnOffice
  if (!worstOffice || scan.counts.office < worstOffice.counts.office) worstOffice = sample
  if (!worstWarehouse || scan.counts.warehouse > worstWarehouse.counts.warehouse) worstWarehouse = sample
  if (!worstComponent || scan.largestOpenComponent > worstComponent.largestOpenComponent) {
    worstComponent = sample
  }
  if (!worstRun || scan.maxOpenRun > worstRun.maxOpenRun) worstRun = sample
}

let wideMaxComponent = null
let wideMaxRun = null
let wideMinOfficeShare = null
for (let index = 0; index < wideSeeds; index++) {
  const scan = scanZones(worldSeed(index), wideRadius)
  const chunks = scan.size * scan.size
  const officeShare = scan.counts.office / chunks
  if (!wideMaxComponent || scan.largestOpenComponent > wideMaxComponent.value) {
    wideMaxComponent = { seedText: `audit-${index}`, value: scan.largestOpenComponent }
  }
  if (!wideMaxRun || scan.maxOpenRun > wideMaxRun.value) {
    wideMaxRun = { seedText: `audit-${index}`, value: scan.maxOpenRun }
  }
  if (!wideMinOfficeShare || officeShare < wideMinOfficeShare.value) {
    wideMinOfficeShare = { seedText: `audit-${index}`, value: officeShare }
  }
}

const districtRadius = Math.ceil(wideRadius / dominance.districtChunks) + 1
const landmarks = {
  districts: 0,
  active: 0,
  ordinary: 0,
  hero: 0,
  warehouseCourt: 0,
  adjacentViolations: 0,
  spanViolations: 0,
  signatures: {
    monumentalGrid: 0,
    processionalAisle: 0,
    brokenBay: 0,
    courtColonnade: 0,
  },
}
for (let index = 0; index < wideSeeds; index++) {
  const seed = worldSeed(index)
  for (let dz = -districtRadius; dz <= districtRadius; dz++) {
    for (let dx = -districtRadius; dx <= districtRadius; dx++) {
      landmarks.districts++
      const landmark = regionLandmark(seed, dx, dz, CONFIG)
      if (!landmark.active) continue
      landmarks.active++
      landmarks[landmark.hero ? 'hero' : 'ordinary']++
      landmarks.signatures[landmark.pierPattern]++
      if (landmark.kind === 'warehouseCourt') landmarks.warehouseCourt++
      const min = landmark.hero ? dominance.heroMinSpanChunks : dominance.minSpanChunks
      const max = landmark.hero ? dominance.heroMaxSpanChunks : dominance.maxSpanChunks
      if (landmark.width < min || landmark.width > max ||
          landmark.height < min || landmark.height > max) {
        landmarks.spanViolations++
      }
      if (regionLandmark(seed, dx + 1, dz, CONFIG).active ||
          regionLandmark(seed, dx, dz + 1, CONFIG).active) {
        landmarks.adjacentViolations++
      }
    }
  }
}

const cellCounts = {}
for (const name of Object.values(cellLabel)) cellCounts[name] = 0
const officeLayerChunks = new Map()
for (let cz = -radius; cz <= radius; cz++) {
  for (let cx = -radius; cx <= radius; cx++) {
    const data = buildChunk(worstOffice.seed, cx, 0, cz, CONFIG)
    officeLayerChunks.set(`${cx},0,${cz}`, data)
    for (const kind of data.cellKind) cellCounts[cellLabel[kind]]++
  }
}
const officeLayeredAudit = auditLayeredPatch(
  (cx, cy, cz) => officeLayerChunks.get(`${cx},${cy},${cz}`) ?? null,
  -radius,
  0,
  -radius,
  radius * 2 + 1,
  1,
  radius * 2 + 1
)
const sampledCells = Object.values(cellCounts).reduce((sum, count) => sum + count, 0)
const cellShares = Object.fromEntries(
  Object.entries(cellCounts).map(([key, count]) => [key, count / sampledCells])
)
const officeCounts = spawnSamples.map((sample) => sample.counts.office).sort((a, b) => a - b)
const totalChunks = Object.values(totals).reduce((sum, count) => sum + count, 0)
const majorityFloor = Math.floor((worstOffice.size * worstOffice.size) / 2) + 1
const verdict = {
  spawnReservation: allSpawnOffice,
  spawnRoomMajority: worstOffice.counts.office >= majorityFloor,
  boundedCorpusRuns: worstRun.maxOpenRun <= maxSpan,
  boundedCorpusComponents: worstComponent.largestOpenComponent <= maxSpan * maxSpan,
  boundedWideRuns: wideMaxRun.value <= maxSpan,
  boundedWideComponents: wideMaxComponent.value <= maxSpan * maxSpan,
  wideRoomDominance: wideMinOfficeShare.value >= dominance.minOfficeShare,
  nonAdjacentLandmarks: landmarks.adjacentViolations === 0,
  validLandmarkSpans: landmarks.spanViolations === 0,
  landmarkSignatureCoverage: Object.values(landmarks.signatures)
    .every((count) => count > 0),
}
verdict.ok = Object.values(verdict).every(Boolean)

const enabledProfiles = [
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  MAP_FAMILY_LATTICE,
].map((family) => ({
  family,
  enabled: CONFIG.mapFamily.profiles[family].enabled,
}))
const officeShare = totals.office / totalChunks
const sewerEvidence = requestedFamilies.includes(MAP_FAMILY_SEWER)
  ? runForcedSewerCorpus()
  : null
const towerEvidence = requestedFamilies.includes(MAP_FAMILY_TOWER)
  ? runForcedTowerCorpus()
  : null
const latticeEvidence = requestedFamilies.includes(MAP_FAMILY_LATTICE)
  ? runForcedLatticeCorpus()
  : null
const disabledFamilyRow = (family) => ({
  family,
  enabled: CONFIG.mapFamily.profiles[family].enabled,
  forcedProfile: true,
  generatorVersion: WORLD_GEN_VERSION,
  profileIdentity: `${family}-disabled`,
  seedDerivation: `hashStr("audit-${family}-N#${level}")`,
  pins: { family: false, maximumHeight: null },
  corpus: {
    seeds: 0,
    chunks: 0,
    officeChunks: 0,
    determinism: null,
    layered: null,
    familyMetrics: {},
    status: 'profile-disabled-no-geometry-evidence',
  },
})
const familyRows = [
  {
    family: MAP_FAMILY_OFFICE,
    enabled: true,
    forcedProfile: false,
    generatorVersion: WORLD_GEN_VERSION,
    seedDerivation: `hashStr("audit-N#${level}")`,
    pins: { global: true, maximumHeight: true },
    corpus: {
      seeds: seedCount,
      chunks: totalChunks,
      officeChunks: totals.office,
      officeShare,
      continuity: verdict.ok,
      layered: officeLayeredAudit.ok,
    },
  },
  ...requestedFamilies.map((family) =>
    family === MAP_FAMILY_SEWER && sewerEvidence
      ? sewerEvidence.row
      : family === MAP_FAMILY_TOWER && towerEvidence
        ? towerEvidence.row
        : family === MAP_FAMILY_LATTICE && latticeEvidence
          ? latticeEvidence.row
      : disabledFamilyRow(family)
  ),
]
const emittedKinds = [
  { family: MAP_FAMILY_OFFICE, kind: 'officeMultilevel', fixtures: [] },
]
if (sewerEvidence) {
  emittedKinds.push({
    family: MAP_FAMILY_SEWER,
    kind: MAP_FAMILY_SEWER,
    fixtures: sewerEvidence.fixtures,
  })
}
if (towerEvidence) {
  emittedKinds.push({
    family: MAP_FAMILY_TOWER,
    kind: 'towerSkybridge',
    socketKinds: [...TOWER_LANDMARK_SOCKET_KINDS],
    fixtures: towerEvidence.fixtures,
  })
}
if (latticeEvidence) {
  emittedKinds.push({
    family: MAP_FAMILY_LATTICE,
    kind: LATTICE_STRUCTURE_KIND,
    auditDimensions: [...LATTICE_AUDIT_DIMENSIONS],
    fixtures: latticeEvidence.fixtures,
  })
}
const familyReport = auditFamilyCompleteness(
  enabledProfiles,
  emittedKinds,
  {
    adapters: FAMILY_AUDIT_ADAPTERS,
    familyRows,
    officeShareFloor: dominance.minOfficeShare,
  }
)
verdict.familyRows = familyReport.ok
verdict.ok = Object.entries(verdict)
  .filter(([key]) => key !== 'ok')
  .every(([, value]) => value === true)

const compactSample = (sample) => ({
  seedText: sample.seedText,
  worldSeed: sample.seed,
  counts: sample.counts,
  largestOpenComponent: sample.largestOpenComponent,
  maxOpenRun: sample.maxOpenRun,
})
const zoneMap = []
for (let z = 0; z < worstOffice.size; z++) {
  let row = ''
  for (let x = 0; x < worstOffice.size; x++) {
    row += zoneGlyph[worstOffice.zones[z * worstOffice.size + x]]
  }
  zoneMap.push(row)
}

const report = {
  generatorVersion: WORLD_GEN_VERSION,
  seedDerivation: `hashStr("audit-N#${level}")`,
  profile: {
    seeds: seedCount,
    spawnWindow: `${worstOffice.size}x${worstOffice.size}`,
    wideSeeds,
    wideWindow: `${wideRadius * 2 + 1}x${wideRadius * 2 + 1}`,
    ordinarySpanChunks: [dominance.minSpanChunks, dominance.maxSpanChunks],
    heroSpanChunks: [dominance.heroMinSpanChunks, dominance.heroMaxSpanChunks],
    minimumLargePatchOfficeShare: dominance.minOfficeShare,
  },
  spawnCorpus: {
    zoneShares: Object.fromEntries(
      Object.entries(totals).map(([key, count]) => [key, count / totalChunks])
    ),
    officeChunks: {
      minimum: officeCounts[0],
      p01: quantile(officeCounts, 0.01),
      median: quantile(officeCounts, 0.5),
      p99: quantile(officeCounts, 0.99),
      maximum: officeCounts.at(-1),
    },
    worstOffice: compactSample(worstOffice),
    worstWarehouse: compactSample(worstWarehouse),
    worstOpenComponent: compactSample(worstComponent),
    worstOpenRun: compactSample(worstRun),
  },
  wideProbe: {
    maximumOpenComponent: wideMaxComponent,
    maximumOpenRun: wideMaxRun,
    minimumOfficeShare: wideMinOfficeShare,
  },
  landmarks: {
    ...landmarks,
    activeShare: landmarks.active / landmarks.districts,
    heroShareOfActive: landmarks.hero / landmarks.active,
  },
  worstOfficeExactCells: {
    seedText: worstOffice.seedText,
    shares: cellShares,
    zoneMap,
  },
  familyRows: familyReport.familyRows,
  familyVerdict: {
    ok: familyReport.ok,
    reasons: familyReport.reasons,
  },
  verdict,
}

console.log(JSON.stringify(report, null, 2))
if (!verdict.ok) process.exitCode = 1
