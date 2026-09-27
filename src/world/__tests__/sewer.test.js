import { isCatalogStructure } from '../structures/catalog/engine.js'
import { describe, expect, it } from 'vitest'
import { CHUNK } from '../constants.js'
import * as sewer from '../zones/sewer.js'
import { ChunkData } from '../ChunkData.js'
import { RNG } from '../core/rng.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { PASSAGE_OPEN, PASSAGE_WALL } from '../mapTypes.js'
import { placeLights } from '../lamps.js'
import { countChunkComponents } from '../topology.js'
import { buildChunk } from '../pipeline.js'

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

let corpusPromise = null

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
    'generate(data, ctx) must expose the canonical SewerDescriptor'
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

function expectOpenStep(data, a, b) {
  expect(Math.abs(a.lx - b.lx) + Math.abs(a.lz - b.lz)).toBe(1)
  expect(a.lx === b.lx
    ? data.hAt(a.lx, Math.max(a.lz, b.lz))
    : data.vAt(Math.max(a.lx, b.lx), a.lz)).toBe(0)
}

function expectBuiltArchitecture(data) {
  const descriptor = data.sewerDescriptor
  const gallery = descriptor.structures.find(({ kind }) => kind === 'interceptorGallery')
  const collector = descriptor.structures.find(({ kind }) => kind === 'collector')
  const bypass = descriptor.structures.find(({ kind }) => kind === 'bulkheadBypass')

  if (descriptor.layout === 'interceptor') {
    expect(gallery).toBeDefined()
    const { bounds } = gallery
    const width = bounds.x1 - bounds.x0 + 1
    const depth = bounds.z1 - bounds.z0 + 1
    expect(Math.min(width, depth)).toBe(2)
    expect(Math.max(width, depth)).toBeGreaterThanOrEqual(4)
    // A gallery is one open volume; its wall grid cannot remain a row of
    // little rooms while the descriptor merely announces a larger chamber.
    for (let z = bounds.z0; z <= bounds.z1; z++) {
      for (let x = bounds.x0; x <= bounds.x1; x++) {
        expect(data.hasFloorHole(x, z)).toBe(false)
        if (x < bounds.x1) expect(data.vAt(x + 1, z)).toBe(0)
        if (z < bounds.z1) expect(data.hAt(x, z + 1)).toBe(0)
      }
    }
  } else if (descriptor.layout === 'confluence') {
    expect(collector).toBeDefined()
    expect(collector.cells).toHaveLength(CHUNK)
    const horizontal = collector.cells[0].lz === collector.cells.at(-1).lz
    expect(horizontal
      ? [collector.cells[0].lx, collector.cells.at(-1).lx]
      : [collector.cells[0].lz, collector.cells.at(-1).lz]).toEqual([0, CHUNK - 1])
    expect(descriptor.modules.slice(0, descriptor.trunkCount))
      .toContainEqual(expect.objectContaining(collector.junction))
    for (const cell of collector.cells) {
      expect(data.colAt(cell.lx, cell.lz)).toBe(0)
      expect(data.hasFloorHole(cell.lx, cell.lz)).toBe(false)
    }
    for (let i = 1; i < collector.cells.length; i++) {
      expectOpenStep(data, collector.cells[i - 1], collector.cells[i])
    }
  } else {
    expect(descriptor.layout).toBe('bypass')
    expect(bypass).toBeDefined()
    expect(bypass.cells.length).toBeGreaterThanOrEqual(8)
    expect(descriptor.loopEdges).toContainEqual(bypass.loopEdge)
    for (let z = bypass.core.z0; z <= bypass.core.z1; z++) {
      for (let x = bypass.core.x0; x <= bypass.core.x1; x++) {
        expect(data.colAt(x, z), 'the bypass surrounds solid mass').not.toBe(0)
      }
    }
    for (let i = 0; i < bypass.cells.length; i++) {
      const cell = bypass.cells[i]
      expect(data.colAt(cell.lx, cell.lz)).toBe(0)
      expect(data.hasFloorHole(cell.lx, cell.lz)).toBe(false)
      expectOpenStep(data, cell, bypass.cells[(i + 1) % bypass.cells.length])
    }
  }
}

describe('sewer architectural grammars', () => {
  it('builds different gallery, confluence, and bulkhead-bypass geometry across seeds', async () => {
    const layouts = new Set()
    for (const { data, descriptor } of await fixedCorpus()) {
      layouts.add(descriptor.layout)
      expectBuiltArchitecture(data)
    }
    expect([...layouts].sort()).toEqual([...sewer.SEWER_LAYOUTS].sort())
  })

  it('keeps structural routes and every usable floor connected after stairs, furnishing, and spawn carving', () => {
    const { config } = sewerConfig()
    const layouts = new Set()
    for (let seed = 0; seed < 96; seed++) {
      const origin = seed % 4 === 0
      const coords = origin ? [0, 0, 0] : [seed % 9 - 4, seed % 5 - 2, seed % 11 - 5]
      const clearings = origin ? [{ lx: CHUNK / 2, lz: CHUNK / 2, r: 1 }] : null
      const data = buildChunk(seed, ...coords, config, null, clearings)
      layouts.add(data.sewerDescriptor.layout)
      // v26: a catalog volume (drop shaft, cistern, stepwell…) may overlay the
      // module plan; its own contract keeps the chunk one component.
      if (isCatalogStructure(data.structure)) {
        expect(countChunkComponents(data, true), `seed ${seed} catalog chunk`).toBe(1)
        expect(data.repairs).toEqual({ connectivity: 0, navigation: 0, columns: 0 })
        continue
      }
      expectBuiltArchitecture(data)
      for (const edge of data.sewerDescriptor.loopEdges) {
        expectOpenStep(data, data.sewerDescriptor.modules[edge.a], data.sewerDescriptor.modules[edge.b])
      }
      const reachable = reachableCells(data, data.sewerDescriptor.trunkRoot)
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          if (data.colAt(x, z) || data.hasFloorHole(x, z)) continue
          expect(reachable.has(`${x},${z}`), `seed ${seed}, usable floor ${x},${z}`).toBe(true)
        }
      }
      expect(data.repairs).toEqual({ connectivity: 0, navigation: 0, columns: 0 })
    }
    expect([...layouts].sort()).toEqual([...sewer.SEWER_LAYOUTS].sort())
  })

  it('respects a zero loop budget without emitting a false bypass', () => {
    const { config } = sewerConfig()
    config.mapFamily.profiles.sewer.maxLoops = 0
    for (let seed = 0; seed < 36; seed++) {
      const data = buildChunk(seed, 2, 0, -3, config)
      expect(data.sewerDescriptor.loopEdges).toEqual([])
      expect(data.sewerDescriptor.layout).not.toBe('bypass')
      if (!isCatalogStructure(data.structure)) expectBuiltArchitecture(data)
      expect(countChunkComponents(data, true)).toBe(1)
    }
  })

  it('preserves open seam mouths and reciprocal risers between different neighboring grammars', () => {
    const { config } = sewerConfig()
    const neighbors = new Set()
    for (let seed = 0; seed < 24; seed++) {
      const cx = seed % 5 - 2
      const cy = seed % 3 - 1
      const cz = seed % 7 - 3
      const center = buildChunk(seed, cx, cy, cz, config)
      const east = buildChunk(seed, cx + 1, cy, cz, config)
      const south = buildChunk(seed, cx, cy, cz + 1, config)
      const above = buildChunk(seed, cx, cy + 1, cz, config)
      expect(center.stairUp).toEqual(above.stairDown)
      for (const neighbor of [east, south]) {
        neighbors.add([center.sewerDescriptor.layout, neighbor.sewerDescriptor.layout].sort().join('/'))
      }
      for (let cell = 0; cell < CHUNK; cell++) {
        if (!east.vAt(0, cell)) {
          expect(center.colAt(CHUNK - 1, cell)).toBe(0)
          expect(east.colAt(0, cell)).toBe(0)
        }
        if (!south.hAt(cell, 0)) {
          expect(center.colAt(cell, CHUNK - 1)).toBe(0)
          expect(south.colAt(cell, 0)).toBe(0)
        }
      }
    }
    expect(neighbors.has('bypass/confluence')).toBe(true)
    expect(neighbors.has('bypass/interceptor')).toBe(true)
    expect(neighbors.has('confluence/interceptor')).toBe(true)
  })
})
