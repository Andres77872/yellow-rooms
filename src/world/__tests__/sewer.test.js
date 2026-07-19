import { describe, expect, it } from 'vitest'
import { CHUNK } from '../constants.js'
import { ChunkData } from '../ChunkData.js'
import { RNG } from '../core/rng.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { PASSAGE_OPEN, PASSAGE_WALL } from '../mapTypes.js'
import { placeLights } from '../lamps.js'
import { countChunkComponents } from '../topology.js'

const SEWER_MODULE_PATH = '../zones/sewer.js'

const ALLOWED_MODULE_KINDS = Object.freeze([
  't',
  'lBend',
  'dryStretch',
  'chamberSmall',
  'chamberLarge',
  'manholeUp',
  'manholeDown',
])

const DEFERRED_MODULE_KINDS = Object.freeze([
  'uBend',
  'cross',
  'floodedStretch',
  'ventShaft',
])

const FIXED_FIXTURES = Object.freeze([
  0, 1, 2, 3, 4, 5, 6, 7,
  11, 13, 17, 19, 23, 29, 31, 37,
  41, 43, 47, 53, 59, 61, 67, 71,
  73, 79, 83, 89, 97, 101, 103, 107,
  0xbeef, 0xc0ffee, 0x5e57, 0x6c61,
].map((seed, index) => Object.freeze({
  seed,
  cx: (index % 7) - 3,
  cz: ((index * 5) % 9) - 4,
})))

let sewerModulePromise = null
let corpusPromise = null

async function plannedSewerModule() {
  if (!sewerModulePromise) {
    sewerModulePromise = import(/* @vite-ignore */ SEWER_MODULE_PATH)
      .catch((cause) => {
        throw new Error(
          'planned sewer behavior is missing: src/world/zones/sewer.js has not been implemented',
          { cause }
        )
      })
  }

  const sewer = await sewerModulePromise
  expect(
    sewer.generate,
    'planned sewer behavior is missing: the zone module must export generate(data, ctx)'
  ).toBeTypeOf('function')
  return sewer
}

function sewerConfig() {
  const config = worldConfigForFamily('sewer')
  const profile = config.mapFamily.profiles.sewer
  expect(profile.enabled, 'the accepted Sewer gate must keep its release profile enabled').toBe(true)
  expect(profile.zoneBands).toHaveLength(1)
  return { config, profile, zone: profile.zoneBands[0].id }
}

function borderFixture() {
  const line = () => {
    const walls = new Uint8Array(CHUNK).fill(1)
    walls[Math.floor(CHUNK / 2)] = 0
    walls[Math.floor(CHUNK / 2) - 1] = 0
    return walls
  }
  return { wW: line(), wN: line(), wE: line(), wS: line() }
}

function installOwnedBorders(data, borders) {
  for (let i = 0; i < CHUNK; i++) {
    data.setPassageV(0, i, borders.wW[i] ? PASSAGE_WALL : PASSAGE_OPEN)
    data.setPassageH(i, 0, borders.wN[i] ? PASSAGE_WALL : PASSAGE_OPEN)
  }
}

function resultDescriptor(result, data) {
  const candidates = [
    data.sewerDescriptor,
    result?.sewerDescriptor,
    result?.descriptor,
    result,
  ]
  return candidates.find((candidate) =>
    candidate && candidate.family === 'sewer' && Array.isArray(candidate.modules)
  ) ?? null
}

async function compileFixture(fixture, { traceProfileRead = null } = {}) {
  const sewer = await plannedSewerModule()
  const { config, profile, zone } = sewerConfig()
  const mapFamilyProfile = traceProfileRead
    ? new Proxy({ family: 'sewer', ...profile }, {
        get(target, property, receiver) {
          if (property === 'rightTurnChance') traceProfileRead()
          return Reflect.get(target, property, receiver)
        },
      })
    : { family: 'sewer', ...profile }
  const { seed, cx, cz } = fixture
  const cy = 0
  const borders = borderFixture()
  const data = new ChunkData(cx, cy, cz, zone, config.version, 'sewer')
  installOwnedBorders(data, borders)

  const result = await sewer.generate(data, {
    seed,
    rootSeed: seed >>> 0,
    layerSeed: seed,
    cx,
    cy,
    cz,
    zone,
    rng: RNG.fromHash(seed, cx, cz),
    config,
    mapFamilyProfile,
    borders,
    borderZones: { w: zone, n: zone, e: zone, s: zone },
  })

  placeLights(data, { seed, cx, cz, zone, config })
  const descriptor = resultDescriptor(result, data)
  expect(
    descriptor,
    'planned sewer behavior is missing: generate(data, ctx) must expose the canonical SewerDescriptor'
  ).not.toBeNull()

  return { config, profile, zone, data, descriptor }
}

async function fixedCorpus() {
  if (!corpusPromise) {
    corpusPromise = Promise.all(FIXED_FIXTURES.map(compileFixture))
  }
  return corpusPromise
}

function boundedCell(cell) {
  return Number.isInteger(cell?.lx) &&
    Number.isInteger(cell?.lz) &&
    cell.lx >= 0 && cell.lx < CHUNK &&
    cell.lz >= 0 && cell.lz < CHUNK
}

function validEdge(edge, moduleCount) {
  return Number.isInteger(edge?.a) &&
    Number.isInteger(edge?.b) &&
    edge.a >= 0 && edge.a < moduleCount &&
    edge.b >= 0 && edge.b < moduleCount &&
    edge.a !== edge.b
}

function treeAnalysis(descriptor) {
  const moduleCount = descriptor.modules.length
  const adjacency = Array.from({ length: moduleCount }, () => [])
  const parent = Array.from({ length: moduleCount }, (_, index) => index)
  const find = (node) => {
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]]
      node = parent[node]
    }
    return node
  }
  let invalidEdges = 0
  let cycle = false

  for (const edge of descriptor.treeEdges ?? []) {
    if (!validEdge(edge, moduleCount)) {
      invalidEdges++
      continue
    }
    adjacency[edge.a].push(edge.b)
    adjacency[edge.b].push(edge.a)
    const a = find(edge.a)
    const b = find(edge.b)
    if (a === b) cycle = true
    else parent[a] = b
  }

  const rootIndex = descriptor.modules.findIndex((module) =>
    module.lx === descriptor.trunkRoot?.lx && module.lz === descriptor.trunkRoot?.lz
  )
  const seen = new Set()
  if (rootIndex >= 0) {
    const queue = [rootIndex]
    seen.add(rootIndex)
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const next of adjacency[queue[cursor]]) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
  }

  return { cycle, invalidEdges, rootIndex, seen }
}

function carriesWetData(value) {
  if (!value || typeof value !== 'object') return false
  for (const [key, child] of Object.entries(value)) {
    if (/^(water|waterDepth|wet|wading)$/i.test(key)) return true
    if (carriesWetData(child)) return true
  }
  return false
}

function descriptorContractReasons(descriptor, profile, diagnostics = {}) {
  const reasons = []
  const allowed = new Set(ALLOWED_MODULE_KINDS)
  const moduleCount = descriptor.modules?.length ?? 0
  for (const module of descriptor.modules ?? []) {
    if (!allowed.has(module.kind)) reasons.push(`forbidden-module:${module.kind}`)
  }
  if (carriesWetData(descriptor)) reasons.push('wet-output')

  const tree = treeAnalysis(descriptor)
  if (tree.rootIndex < 0) reasons.push('missing-trunk-root')
  if (tree.invalidEdges > 0) reasons.push('invalid-tree-edge')
  if (tree.cycle) reasons.push('cyclic-tree')
  if ((descriptor.treeEdges?.length ?? 0) !== Math.max(0, moduleCount - 1)) {
    reasons.push('tree-edge-count')
  }
  if (tree.seen.size !== moduleCount) reasons.push('tree-not-spanning')

  const loopEdges = descriptor.loopEdges ?? []
  if (loopEdges.some((edge) => !validEdge(edge, moduleCount))) {
    reasons.push('invalid-loop-edge')
  }
  if (!Number.isInteger(profile.maxLoops) || loopEdges.length > profile.maxLoops) {
    reasons.push('loop-budget')
  }
  if (
    !Number.isInteger(descriptor.eligibleNonTreeLinks) ||
    profile.maxLoops >= descriptor.eligibleNonTreeLinks ||
    loopEdges.length >= descriptor.eligibleNonTreeLinks
  ) {
    reasons.push('eligible-loop-bound')
  }

  // R23-S04: finite observed percentages are report-only diagnostics. They are
  // deliberately not compared with the configured generator-side probability.
  if (
    diagnostics.observedRightTurnRate !== undefined &&
    !Number.isFinite(diagnostics.observedRightTurnRate)
  ) {
    reasons.push('invalid-turn-diagnostic')
  }

  return [...new Set(reasons)]
}

function reachableCells(data, start) {
  if (!boundedCell(start) || data.colAt(start.lx, start.lz) || data.hasFloorHole(start.lx, start.lz)) {
    return new Set()
  }
  const key = (x, z) => `${x},${z}`
  const queue = [[start.lx, start.lz]]
  const seen = new Set([key(start.lx, start.lz)])
  const visit = (x, z, wall) => {
    if (wall || x < 0 || x >= CHUNK || z < 0 || z >= CHUNK) return
    if (data.colAt(x, z) || data.hasFloorHole(x, z)) return
    const cellKey = key(x, z)
    if (seen.has(cellKey)) return
    seen.add(cellKey)
    queue.push([x, z])
  }

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [x, z] = queue[cursor]
    visit(x - 1, z, data.vAt(x, z))
    visit(x + 1, z, x === CHUNK - 1 ? 1 : data.vAt(x + 1, z))
    visit(x, z - 1, data.hAt(x, z))
    visit(x, z + 1, z === CHUNK - 1 ? 1 : data.hAt(x, z + 1))
  }
  return seen
}

function generatedSnapshot({ data, descriptor }) {
  return {
    descriptor,
    wallV: Array.from(data.wallV),
    wallH: Array.from(data.wallH),
    passageV: Array.from(data.passageV),
    passageH: Array.from(data.passageH),
    cols: Array.from(data.cols),
    cellKind: Array.from(data.cellKind),
    lamps: data.lamps,
  }
}

describe('bounded dry sewer vocabulary', () => {
  it('[R21-S01][D03][D05] exposes one bounded canonical sewer zone descriptor', async () => {
    const sewer = await plannedSewerModule()
    const fixture = await compileFixture(FIXED_FIXTURES[0])
    const { descriptor, profile, zone } = fixture

    expect(sewer.id).toBe(zone)
    expect(profile.enabled).toBe(true)
    expect(descriptor).toMatchObject({
      family: 'sewer',
      bounds: expect.objectContaining({
        x0: expect.any(Number),
        z0: expect.any(Number),
        x1: expect.any(Number),
        z1: expect.any(Number),
      }),
      trunkRoot: expect.objectContaining({ lx: expect.any(Number), lz: expect.any(Number) }),
      modules: expect.any(Array),
      treeEdges: expect.any(Array),
      loopEdges: expect.any(Array),
      eligibleNonTreeLinks: expect.any(Number),
    })
    expect(descriptor.modules.length).toBeGreaterThan(0)
    expect(descriptor.modules.every(boundedCell)).toBe(true)
    expect(descriptor.bounds.x0).toBeGreaterThanOrEqual(0)
    expect(descriptor.bounds.z0).toBeGreaterThanOrEqual(0)
    expect(descriptor.bounds.x1).toBeLessThan(CHUNK)
    expect(descriptor.bounds.z1).toBeLessThan(CHUNK)
  })

  it('[R21-S02][D05] covers exactly the seven required module kinds across fixed seeds', async () => {
    const corpus = await fixedCorpus()
    const observed = new Set()
    for (const { descriptor, profile } of corpus) {
      for (const module of descriptor.modules) observed.add(module.kind)
      expect(descriptorContractReasons(descriptor, profile)).toEqual([])
    }

    expect([...observed].sort()).toEqual([...ALLOWED_MODULE_KINDS].sort())
  })

  it.each(DEFERRED_MODULE_KINDS)(
    '[R21-S03][D05] rejects deferred module kind %s',
    async (kind) => {
      const [{ descriptor, profile }] = await fixedCorpus()
      const malformed = structuredClone(descriptor)
      malformed.modules.push({ kind, lx: 0, lz: 0, dir: 0 })

      expect(descriptorContractReasons(malformed, profile)).toContain(`forbidden-module:${kind}`)
    }
  )

  it('[R21-S03..S04][D05] rejects wet data while a dry fixture needs no water or wading fields', async () => {
    const [{ descriptor, profile }] = await fixedCorpus()
    expect(descriptorContractReasons(descriptor, profile)).toEqual([])

    const wet = structuredClone(descriptor)
    wet.waterDepth = 1
    expect(descriptorContractReasons(wet, profile)).toContain('wet-output')
  })
})

describe('trunk-first connected sewer topology', () => {
  it('[R22-S01][D03][D05] keeps every module reachable in the authoritative raster', async () => {
    for (const { data, descriptor } of await fixedCorpus()) {
      const reachable = reachableCells(data, descriptor.trunkRoot)
      expect(countChunkComponents(data, true)).toBe(1)
      expect(data.repairs).toEqual({ connectivity: 0, navigation: 0, columns: 0 })
      for (const module of descriptor.modules) {
        expect(reachable.has(`${module.lx},${module.lz}`)).toBe(true)
      }
    }
  })

  it('[R22-S02][D05] identifies a disconnected chamber as a non-spanning trunk tree', async () => {
    const corpus = await fixedCorpus()
    const source = corpus.find(({ descriptor }) => descriptor.treeEdges.length > 0)
    expect(source).toBeDefined()
    const malformed = structuredClone(source.descriptor)
    malformed.treeEdges.pop()

    expect(descriptorContractReasons(malformed, source.profile)).toContain('tree-not-spanning')
  })

  it('[R22-S03][D05] builds the spanning trunk before inserting only bounded loops', async () => {
    let insertedLoops = 0
    for (const { descriptor, profile } of await fixedCorpus()) {
      const tree = treeAnalysis(descriptor)
      expect(tree.rootIndex).toBeGreaterThanOrEqual(0)
      expect(tree.invalidEdges).toBe(0)
      expect(tree.cycle).toBe(false)
      expect(tree.seen.size).toBe(descriptor.modules.length)
      expect(descriptor.treeEdges).toHaveLength(descriptor.modules.length - 1)
      expect(descriptor.loopEdges.length).toBeLessThanOrEqual(profile.maxLoops)
      expect(profile.maxLoops).toBeLessThan(descriptor.eligibleNonTreeLinks)
      expect(descriptor.loopEdges.length).toBeLessThan(descriptor.eligibleNonTreeLinks)
      insertedLoops += descriptor.loopEdges.length
    }
    expect(insertedLoops, 'the fixed corpus must exercise post-trunk loop insertion').toBeGreaterThan(0)
  })

  it('[R22-S04][D05] does not accept cyclic fragments as a replacement for trunk connectivity', async () => {
    const corpus = await fixedCorpus()
    const source = corpus.find(({ descriptor }) => descriptor.treeEdges.length >= 2)
    expect(source).toBeDefined()
    const malformed = structuredClone(source.descriptor)
    malformed.loopEdges = malformed.treeEdges.slice(0, 2)
    malformed.treeEdges = []

    const reasons = descriptorContractReasons(malformed, source.profile)
    expect(reasons).toContain('tree-not-spanning')
    expect(reasons).toContain('tree-edge-count')
  })
})

describe('deterministic sewer content, lighting, and turn policy', () => {
  it('[R23-S01][D03][D05] reproduces chambers, risers, raster bytes, and lights', async () => {
    for (const fixture of FIXED_FIXTURES.slice(0, 12)) {
      const first = await compileFixture(fixture)
      const second = await compileFixture(fixture)
      const content = (descriptor, kinds) => descriptor.modules.filter((module) => kinds.has(module.kind))
      const chamberKinds = new Set(['chamberSmall', 'chamberLarge'])
      const riserKinds = new Set(['manholeUp', 'manholeDown'])

      expect(content(second.descriptor, chamberKinds)).toEqual(content(first.descriptor, chamberKinds))
      expect(content(second.descriptor, riserKinds)).toEqual(content(first.descriptor, riserKinds))
      expect(generatedSnapshot(second)).toEqual(generatedSnapshot(first))
    }
  })

  it('[R23-S02][D03] keeps eligible sewer lighting deterministic and sparse', async () => {
    const corpus = await fixedCorpus()
    let eligibleLocations = 0
    let fixtures = 0
    let litLocations = 0

    for (const { data, descriptor, profile } of corpus) {
      expect(profile.lampPhase).toBe(2)
      expect(profile.lampChance).toBe(0.35)
      const reachable = reachableCells(data, descriptor.trunkRoot)
      eligibleLocations += reachable.size
      fixtures += data.lamps.length
      for (const lamp of data.lamps) {
        expect(reachable.has(`${lamp.lx},${lamp.lz}`)).toBe(true)
        if (lamp.lit) litLocations++
      }
    }

    expect(eligibleLocations).toBeGreaterThan(1)
    expect(fixtures).toBeGreaterThan(0)
    expect(fixtures).toBeLessThan(eligibleLocations)
    expect(litLocations).toBeGreaterThan(0)
    expect(litLocations).toBeLessThan(eligibleLocations)
  })

  it('[R23-S03][D03] consumes the configured 0.65 right-turn behavior from the family profile', async () => {
    const { profile } = sewerConfig()
    expect(profile.rightTurnChance).toBe(0.65)

    let reads = 0
    for (const fixture of FIXED_FIXTURES.slice(0, 12)) {
      await compileFixture(fixture, { traceProfileRead: () => reads++ })
      if (reads > 0) break
    }
    expect(
      reads,
      'the sewer planner must consume mapFamilyProfile.rightTurnChance rather than hard-code a corpus percentage'
    ).toBeGreaterThan(0)
  })

  it('[R23-S04][D03] treats observed turn percentage as diagnostic, not release gating', async () => {
    const [{ descriptor, profile }] = await fixedCorpus()
    const baseline = descriptorContractReasons(descriptor, profile)

    expect(baseline).toEqual([])
    expect(descriptorContractReasons(descriptor, profile, { observedRightTurnRate: 0 })).toEqual(baseline)
    expect(descriptorContractReasons(descriptor, profile, { observedRightTurnRate: 1 })).toEqual(baseline)
  })
})
