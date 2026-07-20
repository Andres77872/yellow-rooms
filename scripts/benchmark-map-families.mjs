#!/usr/bin/env node

import { performance } from 'node:perf_hooks'

import * as THREE from 'three'

import { ChunkManager } from '../src/world/ChunkManager.js'
import {
  CHUNK_WORLD,
  MAX_BUILDS_PER_FRAME,
  WORLD_GEN_VERSION,
} from '../src/world/constants.js'
import { DEFAULT_WORLD_CONFIG } from '../src/world/config.js'
import { hashStr } from '../src/world/core/hash.js'
import { worldConfigForFamily } from '../src/world/mapFamily.js'
import {
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
} from '../src/world/mapTypes.js'
import { buildChunk } from '../src/world/pipeline.js'
import { structureAt } from '../src/world/structures/contract.js'

const FAMILY_ORDER = Object.freeze([
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  MAP_FAMILY_LATTICE,
])
const DEFAULT_WARMUP_ITERATIONS = 4
const DEFAULT_SAMPLE_ITERATIONS = 32
const DESCRIPTOR_FIELDS = Object.freeze([
  'stairUp',
  'stairDown',
  'sewerDescriptor',
  'structure',
  'structureUp',
  'structureDown',
  'lethalVoidUp',
  'lethalVoidDown',
])

const BUDGET_DEFINITIONS = Object.freeze({
  '--budget-generation-p50-ms': {
    key: 'generationP50Ms',
    metric: (row) => row.generationTimeMs.p50,
  },
  '--budget-generation-p95-ms': {
    key: 'generationP95Ms',
    metric: (row) => row.generationTimeMs.p95,
  },
  '--budget-generation-p99-ms': {
    key: 'generationP99Ms',
    metric: (row) => row.generationTimeMs.p99,
  },
  '--budget-descriptor-p99-bytes': {
    key: 'descriptorP99Bytes',
    metric: (row) => row.descriptorSizeBytes.p99,
  },
  '--budget-node-heap-delta-bytes': {
    key: 'nodeHeapDeltaBytes',
    metric: (row) => Math.max(0, row.nodeHeap.deltaBytes),
  },
  '--budget-functional-queue-count': {
    key: 'functionalQueueCount',
    metric: (row) => row.functionalStreaming.queueCounts.peak,
  },
  '--budget-functional-build-count': {
    key: 'functionalBuildCount',
    metric: (row) => row.functionalStreaming.buildCounts.total,
  },
  '--budget-functional-resident-count': {
    key: 'functionalResidentCount',
    metric: (row) => row.functionalStreaming.residentCounts.afterDrain,
  },
})

const BUDGET_ALIASES = Object.freeze({
  '--budget-p50-ms': '--budget-generation-p50-ms',
  '--budget-p95-ms': '--budget-generation-p95-ms',
  '--budget-p99-ms': '--budget-generation-p99-ms',
  '--budget-descriptor-bytes': '--budget-descriptor-p99-bytes',
  '--budget-heap-delta-bytes': '--budget-node-heap-delta-bytes',
  '--budget-queue-count': '--budget-functional-queue-count',
  '--budget-build-count': '--budget-functional-build-count',
  '--budget-resident-count': '--budget-functional-resident-count',
})

function usage() {
  return `Usage: npm run benchmark:map-families -- [options]

Options:
  --family <office|sewer|tower|lattice|all>  Families to report (default: all)
  --warmup <positive integer>                Warmup builds per family (default: 4)
  --samples <positive integer>               Timed builds per family (default: 32)
  --budget-generation-p50-ms <number>        Optional generation p50 ceiling
  --budget-generation-p95-ms <number>        Optional generation p95 ceiling
  --budget-generation-p99-ms <number>        Optional generation p99 ceiling
  --budget-descriptor-p99-bytes <number>     Optional descriptor p99 ceiling
  --budget-node-heap-delta-bytes <number>    Optional observed heap-delta ceiling
  --budget-functional-queue-count <number>   Optional functional queue ceiling
  --budget-functional-build-count <number>   Optional functional build ceiling
  --budget-functional-resident-count <number> Optional functional resident ceiling
  --help                                      Show this message

Without an explicit --budget-* option this command is report-only and does not
turn measurements into a performance acceptance claim.`
}

function splitOption(argument) {
  const separator = argument.indexOf('=')
  if (separator < 0) return { name: argument, inlineValue: null }
  return {
    name: argument.slice(0, separator),
    inlineValue: argument.slice(separator + 1),
  }
}

function readOptionValue(args, index, inlineValue, name) {
  if (inlineValue !== null) {
    if (inlineValue.length === 0) throw new Error(`${name} requires a value`)
    return { value: inlineValue, nextIndex: index }
  }
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`)
  }
  return { value, nextIndex: index + 1 }
}

function positiveInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} requires a positive integer`)
  }
  return parsed
}

function nonNegativeNumber(value, name) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} requires a finite non-negative number`)
  }
  return parsed
}

function parseOptions(args) {
  const options = {
    families: FAMILY_ORDER,
    warmupIterations: DEFAULT_WARMUP_ITERATIONS,
    sampleIterations: DEFAULT_SAMPLE_ITERATIONS,
    budgets: new Map(),
    help: false,
  }

  for (let index = 0; index < args.length; index++) {
    const { name, inlineValue } = splitOption(args[index])
    if (name === '--help') {
      if (inlineValue !== null) throw new Error('--help does not accept a value')
      options.help = true
      continue
    }

    if (name === '--family') {
      const read = readOptionValue(args, index, inlineValue, name)
      index = read.nextIndex
      options.families = read.value === 'all'
        ? FAMILY_ORDER
        : FAMILY_ORDER.includes(read.value)
          ? Object.freeze([read.value])
          : null
      if (!options.families) {
        throw new Error('--family requires office, sewer, tower, lattice, or all')
      }
      continue
    }

    if (name === '--warmup' || name === '--samples') {
      const read = readOptionValue(args, index, inlineValue, name)
      index = read.nextIndex
      const parsed = positiveInteger(read.value, name)
      if (name === '--warmup') options.warmupIterations = parsed
      else options.sampleIterations = parsed
      continue
    }

    const canonicalBudget = BUDGET_ALIASES[name] ?? name
    const definition = BUDGET_DEFINITIONS[canonicalBudget]
    if (definition) {
      const read = readOptionValue(args, index, inlineValue, name)
      index = read.nextIndex
      const limit = nonNegativeNumber(read.value, name)
      if (options.budgets.has(canonicalBudget)) {
        throw new Error(`${canonicalBudget} was supplied more than once`)
      }
      options.budgets.set(canonicalBudget, { definition, limit })
      continue
    }

    throw new Error(`Unknown option: ${name}`)
  }

  return options
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits))
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return 0
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  return sorted[Math.min(index, sorted.length - 1)]
}

function distribution(values, digits = 3) {
  const sorted = [...values].sort((left, right) => left - right)
  return {
    min: round(sorted[0] ?? 0, digits),
    p50: round(quantile(sorted, 0.5), digits),
    p95: round(quantile(sorted, 0.95), digits),
    p99: round(quantile(sorted, 0.99), digits),
    max: round(sorted.at(-1) ?? 0, digits),
  }
}

function descriptorSizeBytes(data) {
  const descriptors = {}
  for (const field of DESCRIPTOR_FIELDS) {
    if (data[field] !== null && data[field] !== undefined) {
      descriptors[field] = data[field]
    }
  }
  if (Object.keys(descriptors).length === 0) return 0
  return Buffer.byteLength(JSON.stringify(descriptors), 'utf8')
}

function ordinaryCases(family) {
  const seed = hashStr(`benchmark-map-family-${family}#1`)
  const cases = []
  for (let cy = -1; cy <= 1; cy++) {
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++) cases.push({ seed, cx, cy, cz })
    }
  }
  return {
    seed,
    cases: Object.freeze(cases),
    origin: Object.freeze({ cx: 0, cy: 0, cz: 0 }),
  }
}

function fixtureSeeds(family) {
  if (family === MAP_FAMILY_TOWER) return [0x5a17, 0x7157, 0xc0ffee]
  return [
    hashStr('audit-lattice-0#1'),
    hashStr('audit-lattice-1#1'),
    hashStr('audit-lattice-2#1'),
  ]
}

function representativeStructure(family, config) {
  for (const seed of fixtureSeeds(family)) {
    for (let cy = -24; cy <= 24; cy++) {
      for (let cz = -4; cz <= 4; cz++) {
        for (let cx = -4; cx <= 4; cx++) {
          const structure = structureAt(seed, cx, cz, cy, config)
          if (structure?.family === family && structure.hasRoom === true) {
            return { seed, structure }
          }
        }
      }
    }
  }
  throw new Error(`No bounded ${family} benchmark fixture was found`)
}

function structureCases(family, config) {
  const { seed, structure } = representativeStructure(family, config)
  const cases = []
  for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
    for (const { cx, cz } of structure.participants) {
      cases.push({ seed, cx, cy, cz })
    }
  }
  const anchor = structure.anchor ?? structure.participants[0]
  return {
    seed,
    cases: Object.freeze(cases),
    origin: Object.freeze({
      cx: anchor.cx,
      cy: family === MAP_FAMILY_LATTICE
        ? structure.baseCy + 1
        : structure.baseCy,
      cz: anchor.cz,
    }),
  }
}

function familyContext(family) {
  const config = worldConfigForFamily(family, DEFAULT_WORLD_CONFIG)
  if (config.mapFamily.profiles[family].enabled !== true) {
    return { family, config, enabled: false }
  }
  const fixtures = family === MAP_FAMILY_TOWER || family === MAP_FAMILY_LATTICE
    ? structureCases(family, config)
    : ordinaryCases(family)
  return { family, config, enabled: true, ...fixtures }
}

function buildCase(context, index) {
  const sample = context.cases[index % context.cases.length]
  return buildChunk(
    sample.seed,
    sample.cx,
    sample.cy,
    sample.cz,
    context.config
  )
}

function measureGeneration(context, warmupIterations, sampleIterations) {
  const warmupStarted = performance.now()
  for (let index = 0; index < warmupIterations; index++) buildCase(context, index)
  const warmupElapsedMs = performance.now() - warmupStarted

  const heapUsedBefore = process.memoryUsage().heapUsed
  const retained = []
  const generationTimes = []
  const descriptorSizes = []
  for (let index = 0; index < sampleIterations; index++) {
    const started = performance.now()
    const data = buildCase(context, index + warmupIterations)
    generationTimes.push(performance.now() - started)
    retained.push(data)
    descriptorSizes.push(descriptorSizeBytes(data))
  }
  const heapUsedAfter = process.memoryUsage().heapUsed

  return {
    warmup: {
      iterations: warmupIterations,
      elapsedMs: round(warmupElapsedMs),
    },
    samples: sampleIterations,
    generationTimeMs: distribution(generationTimes),
    descriptorSizeBytes: {
      ...distribution(descriptorSizes, 0),
      descriptorsPresent: descriptorSizes.filter((size) => size > 0).length,
    },
    nodeHeap: {
      evidence: 'observed Node heap only; not browser resident-memory evidence',
      retainedGeneratedChunks: retained.length,
      beforeBytes: heapUsedBefore,
      afterBytes: heapUsedAfter,
      deltaBytes: heapUsedAfter - heapUsedBefore,
      deltaMiB: round((heapUsedAfter - heapUsedBefore) / (1024 * 1024)),
    },
  }
}

function measureFunctionalStreaming(context) {
  const scene = new THREE.Scene()
  const manager = new ChunkManager(scene, context.seed, null, null)
  manager.config = context.config
  let buildCount = 0
  let peakQueueCount = 0
  let peakResidentCount = 0

  // Exercise the real queue, canonical structure discovery, and residency
  // lifecycle while replacing only mesh construction with generated stand-ins.
  // These counts are functional evidence, never frame/render/memory proof.
  manager._buildNext = function () {
    peakQueueCount = Math.max(peakQueueCount, this.queue.length)
    const request = this.queue.shift()
    this.queued.delete(request.key)
    if (this.chunks.has(request.key)) return

    const data = buildChunk(
      this.seed,
      request.cx,
      request.cy,
      request.cz,
      this.config
    )
    const chunk = {
      cx: request.cx,
      cy: request.cy,
      cz: request.cz,
      data,
      structure: data.structure,
      apertures: [],
      lamps: [],
      group: { visible: true },
      dispose() {},
    }
    this.chunks.set(request.key, chunk)
    buildCount++
    this._enqueueStructureRequests(data.structure)
    this._applyVisibility(chunk)
    peakQueueCount = Math.max(peakQueueCount, this.queue.length)
    peakResidentCount = Math.max(peakResidentCount, this.chunks.size)
  }

  const px = (context.origin.cx + 0.5) * CHUNK_WORLD
  const pz = (context.origin.cz + 0.5) * CHUNK_WORLD
  manager.update(px, pz, context.origin.cy)
  const afterFirstUpdate = {
    queue: manager.queue.length,
    builds: buildCount,
    residents: manager.loadedCount,
  }
  while (manager.queue.length > 0) manager._buildNext()

  return {
    evidence: 'functional streaming only; no frame-time, rendering, memory, visibility-range, or unrestricted pathfinding claim',
    origin: context.origin,
    maxBuildsPerUpdate: MAX_BUILDS_PER_FRAME,
    queueCounts: {
      peak: peakQueueCount,
      afterFirstUpdate: afterFirstUpdate.queue,
      afterDrain: manager.queue.length,
    },
    buildCounts: {
      firstUpdate: afterFirstUpdate.builds,
      total: buildCount,
    },
    residentCounts: {
      afterFirstUpdate: afterFirstUpdate.residents,
      peak: peakResidentCount,
      afterDrain: manager.loadedCount,
    },
  }
}

function benchmarkFamily(family, options) {
  const context = familyContext(family)
  if (!context.enabled) {
    return {
      family,
      enabled: false,
      status: 'skipped-disabled-profile',
    }
  }
  return {
    family,
    enabled: true,
    status: 'measured',
    ...measureGeneration(
      context,
      options.warmupIterations,
      options.sampleIterations
    ),
    functionalStreaming: measureFunctionalStreaming(context),
  }
}

function evaluateBudgets(rows, budgets) {
  const thresholds = {}
  const violations = []
  for (const [option, { definition, limit }] of budgets) {
    thresholds[definition.key] = { option, limit }
    for (const row of rows) {
      if (row.status !== 'measured') continue
      const actual = definition.metric(row)
      if (actual <= limit) continue
      violations.push({
        family: row.family,
        budget: definition.key,
        option,
        limit,
        actual,
      })
    }
  }
  return { thresholds, violations }
}

function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const rows = options.families.map((family) => benchmarkFamily(family, options))
  const budgetResult = evaluateBudgets(rows, options.budgets)
  const budgetSupplied = options.budgets.size > 0
  const report = {
    schemaVersion: 1,
    mode: budgetSupplied ? 'budget-gated' : 'report-only',
    worldGenVersion: WORLD_GEN_VERSION,
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    evidenceLabels: {
      generation: 'headless buildChunk measurements; no rendering or frame-time claim',
      nodeHeap: 'observed Node heap delta; not browser resident-memory evidence',
      functionalStreaming: 'queue/build/resident counts prove bounded functional streaming only',
      excludedClaims: [
        'frame-time',
        'rendering throughput',
        'browser resident memory',
        'cross-canonical visibility',
        'extended pathfinding leashes',
        'production performance guarantee',
      ],
    },
    requestedFamilies: options.families,
    warmupIterationsPerFamily: options.warmupIterations,
    sampleIterationsPerFamily: options.sampleIterations,
    families: rows,
    budgets: {
      supplied: budgetSupplied,
      policy: budgetSupplied
        ? 'explicit ceilings supplied; any exceeded ceiling fails the command'
        : 'no ceilings supplied; measurements are report-only',
      thresholds: budgetResult.thresholds,
      violations: budgetResult.violations,
      ok: budgetResult.violations.length === 0,
    },
  }

  console.log(JSON.stringify(report, null, 2))
  if (budgetSupplied && budgetResult.violations.length > 0) process.exitCode = 1
}

try {
  main()
} catch (error) {
  console.error(`benchmark:map-families: ${error.message}`)
  process.exitCode = 1
}
