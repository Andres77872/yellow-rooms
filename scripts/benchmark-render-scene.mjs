#!/usr/bin/env node

import { performance } from 'node:perf_hooks'

import * as THREE from 'three'

import { createExitPlacement } from '../src/core/exitPlacement.js'
import { WORLD_DETAIL_ORDER } from '../src/core/graphics.js'
import { createGeometries, disposeGeometries } from '../src/render/geometries.js'
import { ChunkManager } from '../src/world/ChunkManager.js'
import { WORLD_GEN_VERSION, SPAWN_WORLD } from '../src/world/constants.js'
import { hashStr } from '../src/world/core/hash.js'
import {
  MAP_FAMILY_ORDER,
  worldConfigForFamily,
} from '../src/world/mapFamily.js'
import { RENDER_DETAIL_LEVELS } from '../src/world/renderDetail.js'

const DEFAULT_FAMILY = 'office'
const DEFAULT_SEED_TEXT = 'render-benchmark'
const DEFAULT_PROFILE = 'high'

const MATERIAL_SEMANTICS = Object.freeze([
  'carpet',
  'ceiling',
  'wallpaper',
  'panel',
  'panelDead',
  'exit',
  'doorFrame',
  'doorLeaf',
  'prop',
  'signGlow',
  'furniture',
])

const BUDGET_DEFINITIONS = Object.freeze({
  '--budget-loaded-chunks': {
    key: 'loadedChunks',
    metric: (report) => report.world.loadedChunks,
  },
  '--budget-visible-chunks': {
    key: 'visibleChunks',
    metric: (report) => report.world.effectivelyVisibleChunks,
  },
  '--budget-mesh-batches': {
    key: 'effectiveVisibleMeshBatches',
    metric: (report) =>
      report.submissionPotential.effectiveVisible.meshBatches,
  },
  '--budget-instances': {
    key: 'effectiveVisibleInstances',
    metric: (report) =>
      report.submissionPotential.effectiveVisible.instances,
  },
  '--budget-triangles': {
    key: 'effectiveVisibleTriangles',
    metric: (report) =>
      report.submissionPotential.effectiveVisible.triangles,
  },
  '--budget-matrix-auto-update-objects': {
    key: 'matrixAutoUpdateObjects',
    metric: (report) =>
      report.matrixUpdateState.residentChunkObjects.matrixAutoUpdateEnabled,
  },
  '--budget-matrix-world-auto-update-objects': {
    key: 'matrixWorldAutoUpdateObjects',
    metric: (report) =>
      report.matrixUpdateState.residentChunkObjects.matrixWorldAutoUpdateEnabled,
  },
  '--budget-prewarm-ms': {
    key: 'prewarmElapsedMs',
    metric: (report) => report.prewarm.elapsedMs,
  },
})

function usage() {
  return `Usage: npm run benchmark:render-scene -- [options]

Options:
  --family <${MAP_FAMILY_ORDER.join('|')}>  Map family (default: ${DEFAULT_FAMILY})
  --seed <text>                         Game seed text (default: ${DEFAULT_SEED_TEXT})
  --profile <${WORLD_DETAIL_ORDER.join('|')}>    World-detail profile (default: ${DEFAULT_PROFILE})
  --budget-loaded-chunks <number>       Optional resident-chunk ceiling
  --budget-visible-chunks <number>      Optional visibility-gated chunk ceiling
  --budget-mesh-batches <number>        Optional effective batch ceiling
  --budget-instances <number>           Optional effective instance ceiling
  --budget-triangles <number>           Optional effective triangle ceiling
  --budget-matrix-auto-update-objects <number>
                                        Optional local-matrix update ceiling
  --budget-matrix-world-auto-update-objects <number>
                                        Optional world-matrix update ceiling
  --budget-prewarm-ms <number>          Optional, environment-sensitive CPU ceiling
  --help                                Show this message

The script writes one JSON document to stdout. Without explicit --budget-*
options it is report-only. Counts describe headless CPU-side submission
potential after scene visibility gates; they are not GPU timings, camera
frustum results, or browser frame-time evidence.`
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

function nonNegativeNumber(value, name) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} requires a finite non-negative number`)
  }
  return parsed
}

function parseOptions(args) {
  const options = {
    family: DEFAULT_FAMILY,
    seedText: DEFAULT_SEED_TEXT,
    profile: DEFAULT_PROFILE,
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

    if (name === '--family' || name === '--seed' || name === '--profile') {
      const read = readOptionValue(args, index, inlineValue, name)
      index = read.nextIndex
      if (name === '--family') {
        const family = read.value.trim().toLowerCase()
        if (!MAP_FAMILY_ORDER.includes(family)) {
          throw new Error(`--family requires ${MAP_FAMILY_ORDER.join(', ')}`)
        }
        options.family = family
      } else if (name === '--profile') {
        const profile = read.value.trim().toLowerCase()
        if (!WORLD_DETAIL_ORDER.includes(profile)) {
          throw new Error(`--profile requires ${WORLD_DETAIL_ORDER.join(', ')}`)
        }
        options.profile = profile
      } else {
        if (read.value.length === 0) throw new Error('--seed requires text')
        options.seedText = read.value
      }
      continue
    }

    const definition = BUDGET_DEFINITIONS[name]
    if (definition) {
      const read = readOptionValue(args, index, inlineValue, name)
      index = read.nextIndex
      if (options.budgets.has(name)) {
        throw new Error(`${name} was supplied more than once`)
      }
      options.budgets.set(name, {
        definition,
        limit: nonNegativeNumber(read.value, name),
      })
      continue
    }

    throw new Error(`Unknown option: ${name}`)
  }

  return options
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits))
}

function createBenchmarkMaterials() {
  const materials = {}
  for (let index = 0; index < MATERIAL_SEMANTICS.length; index++) {
    const semantic = MATERIAL_SEMANTICS[index]
    // These materials are never compiled or submitted to a WebGL renderer.
    // Distinct identities let the scene walk attribute every mesh batch to
    // its game semantic without importing canvas-backed production textures.
    const color = new THREE.Color().setHSL(
      index / MATERIAL_SEMANTICS.length,
      0.5,
      0.5
    )
    const material = new THREE.MeshBasicMaterial({ color })
    material.name = `benchmark:${semantic}`
    material.userData.benchmarkSemantic = semantic
    materials[semantic] = material
  }
  return materials
}

function disposeMaterials(materials) {
  for (const material of Object.values(materials)) material.dispose()
}

function materialSemantic(material) {
  return material?.userData?.benchmarkSemantic ?? material?.name ?? 'unknown'
}

function geometryElementCount(geometry) {
  const fullCount = geometry.index?.count ?? geometry.attributes.position?.count ?? 0
  const drawCount = geometry.drawRange?.count
  return Number.isFinite(drawCount)
    ? Math.max(0, Math.min(fullCount, drawCount))
    : fullCount
}

function addSemanticTriangles(target, semantic, triangles) {
  target[semantic] = (target[semantic] ?? 0) + triangles
}

function meshSubmission(object) {
  const instanceCount = object.isInstancedMesh ? object.count : 1
  const materials = Array.isArray(object.material)
    ? object.material
    : [object.material]
  const groups = object.geometry.groups
  const totalElements = geometryElementCount(object.geometry)
  const rows = []

  if (materials.length > 1 && groups.length > 0) {
    for (const group of groups) {
      const material = materials[group.materialIndex]
      const elements = Math.max(
        0,
        Math.min(group.count, totalElements - group.start)
      )
      rows.push({
        semantic: materialSemantic(material),
        triangles: Math.floor(elements / 3) * instanceCount,
      })
    }
  } else {
    rows.push({
      semantic: materialSemantic(materials[0]),
      triangles: Math.floor(totalElements / 3) * instanceCount,
    })
  }

  return {
    meshBatches: rows.length,
    instances: instanceCount * rows.length,
    triangles: rows.reduce((sum, row) => sum + row.triangles, 0),
    rows,
  }
}

function effectivelyVisible(object, boundary) {
  for (let current = object; current; current = current.parent) {
    if (current.visible === false) return false
    if (current === boundary) return true
  }
  return false
}

function blankSubmissionCounts() {
  return {
    meshBatches: 0,
    instances: 0,
    triangles: 0,
    trianglesBySemanticMaterial: Object.fromEntries(
      MATERIAL_SEMANTICS.map((semantic) => [semantic, 0])
    ),
  }
}

function appendSubmission(target, object) {
  const row = meshSubmission(object)
  target.meshBatches += row.meshBatches
  target.instances += row.instances
  target.triangles += row.triangles
  for (const semanticRow of row.rows) {
    addSemanticTriangles(
      target.trianglesBySemanticMaterial,
      semanticRow.semantic,
      semanticRow.triangles
    )
  }
}

function collectSubmissionPotential(manager) {
  const resident = blankSubmissionCounts()
  const effectiveVisible = blankSubmissionCounts()
  manager.root.traverse((object) => {
    if (!object.isMesh) return
    appendSubmission(resident, object)
    if (effectivelyVisible(object, manager.root)) {
      appendSubmission(effectiveVisible, object)
    }
  })
  return { resident, effectiveVisible }
}

function blankMatrixCounts() {
  return {
    objects: 0,
    matrixAutoUpdateEnabled: 0,
    matrixAutoUpdateDisabled: 0,
    matrixWorldAutoUpdateEnabled: 0,
    matrixWorldAutoUpdateDisabled: 0,
    fullyFrozen: 0,
    matrixWorldNeedsUpdate: 0,
  }
}

function appendMatrixState(target, object) {
  target.objects++
  if (object.matrixAutoUpdate) target.matrixAutoUpdateEnabled++
  else target.matrixAutoUpdateDisabled++
  if (object.matrixWorldAutoUpdate) target.matrixWorldAutoUpdateEnabled++
  else target.matrixWorldAutoUpdateDisabled++
  if (!object.matrixAutoUpdate && !object.matrixWorldAutoUpdate) {
    target.fullyFrozen++
  }
  if (object.matrixWorldNeedsUpdate) target.matrixWorldNeedsUpdate++
}

function collectMatrixUpdateState(manager) {
  const residentChunkObjects = blankMatrixCounts()
  const effectiveVisibleChunkObjects = blankMatrixCounts()

  for (const chunk of manager.chunks.values()) {
    chunk.group.traverse((object) => {
      appendMatrixState(residentChunkObjects, object)
      if (effectivelyVisible(object, manager.root)) {
        appendMatrixState(effectiveVisibleChunkObjects, object)
      }
    })
  }

  return {
    scope: 'chunk groups and their descendants; ChunkManager root excluded',
    residentChunkObjects,
    effectiveVisibleChunkObjects,
    allResidentChunkObjectsFullyFrozen:
      residentChunkObjects.objects === residentChunkObjects.fullyFrozen,
  }
}

function countVisibleChunks(manager) {
  let visible = 0
  for (const chunk of manager.chunks.values()) {
    if (effectivelyVisible(chunk.group, manager.root)) visible++
  }
  return visible
}

function blankDetailLevelCounts() {
  return {
    full: 0,
    reduced: 0,
    shell: 0,
    unknown: 0,
  }
}

function appendDetailLevel(target, level) {
  if (RENDER_DETAIL_LEVELS.includes(level)) target[level]++
  else target.unknown++
}

function collectRenderDetailLevels(manager) {
  const resident = blankDetailLevelCounts()
  const effectiveVisible = blankDetailLevelCounts()
  for (const chunk of manager.chunks.values()) {
    appendDetailLevel(resident, chunk.renderDetail)
    if (effectivelyVisible(chunk.group, manager.root)) {
      appendDetailLevel(effectiveVisible, chunk.renderDetail)
    }
  }
  return { resident, effectiveVisible }
}

function reductionPercent(resident, effectiveVisible) {
  if (resident === 0) return 0
  return round((1 - effectiveVisible / resident) * 100, 2)
}

function addSubmissionReductions(submissionPotential) {
  const { resident, effectiveVisible } = submissionPotential
  submissionPotential.effectiveVsResidentReductionPercent = {
    meshBatches: reductionPercent(
      resident.meshBatches,
      effectiveVisible.meshBatches
    ),
    instances: reductionPercent(
      resident.instances,
      effectiveVisible.instances
    ),
    triangles: reductionPercent(
      resident.triangles,
      effectiveVisible.triangles
    ),
  }
  return submissionPotential
}

function applyDetailProfile(manager, profile) {
  if (typeof manager.setRenderDetailProfile !== 'function') {
    return {
      requested: profile,
      applied: false,
      reason: 'ChunkManager.setRenderDetailProfile is unavailable',
    }
  }
  manager.setRenderDetailProfile(profile)
  return {
    requested: profile,
    applied: true,
    method: 'ChunkManager.setRenderDetailProfile',
  }
}

function evaluateBudgets(report, budgets) {
  const thresholds = {}
  const violations = []
  for (const [option, { definition, limit }] of budgets) {
    const actual = definition.metric(report)
    thresholds[definition.key] = { option, limit }
    if (actual <= limit) continue
    violations.push({
      budget: definition.key,
      option,
      limit,
      actual,
    })
  }
  return { thresholds, violations }
}

function benchmarkScene(options) {
  const scene = new THREE.Scene()
  const materials = createBenchmarkMaterials()
  const geometries = createGeometries()
  const worldSeed = hashStr(`${options.seedText}#1`)
  const manager = new ChunkManager(scene, worldSeed, materials, geometries)
  manager.config = worldConfigForFamily(options.family)
  const exit = createExitPlacement(
    options.seedText,
    1,
    worldSeed,
    manager.config
  )
  manager.setExit(exit.cx, exit.cy, exit.cz, exit.lx, exit.lz)

  try {
    const detailProfile = applyDetailProfile(manager, options.profile)
    manager.updateVisibility(0, null)
    const started = performance.now()
    manager.prewarm(SPAWN_WORLD, SPAWN_WORLD, 0)
    const elapsedMs = performance.now() - started

    const report = {
      schemaVersion: 1,
      mode: options.budgets.size > 0 ? 'budget-gated' : 'report-only',
      evidence: {
        label: 'headless CPU-side scene submission potential',
        submissionScope:
          'ChunkManager.root chunk meshes only; entities and other scene-root meshes excluded',
        visibilityScope:
          'Three ancestor/child visibility gates after spawn prewarm; no camera frustum or occlusion culling',
        timingScope:
          'Node wall-clock generation plus CPU meshing/prewarm; not GPU timing or browser frame time',
        countDefinitions: {
          meshBatches:
            'one potential draw per visible Mesh material group',
          instances:
            'one copy per regular Mesh or InstancedMesh.count copies per material group',
          triangles:
            'indexed/non-indexed geometry primitives multiplied by instance copies before frustum and occlusion culling',
        },
        excludedClaims: [
          'GPU timing',
          'browser frame time',
          'rasterized triangle count',
          'camera-frustum visibility',
          'occlusion-culling visibility',
          'production performance guarantee',
        ],
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        threeRevision: THREE.REVISION,
      },
      worldGenVersion: WORLD_GEN_VERSION,
      input: {
        family: options.family,
        seedText: options.seedText,
        seedDerivation: 'hashStr(`${seedText}#1`)',
        worldSeed,
        profile: options.profile,
        spawn: { x: SPAWN_WORLD, cy: 0, z: SPAWN_WORLD },
        exit: {
          cx: exit.cx,
          cy: exit.cy,
          cz: exit.cz,
          lx: exit.lx,
          lz: exit.lz,
        },
      },
      detailProfile,
      prewarm: {
        elapsedMs: round(elapsedMs),
        evidence: 'Node CPU wall-clock only; environment-sensitive',
      },
      world: {
        loadedChunks: manager.loadedCount,
        effectivelyVisibleChunks: countVisibleChunks(manager),
        queuedChunksAfterPrewarm: manager.queue.length,
        renderDetailLevels: collectRenderDetailLevels(manager),
      },
      submissionPotential: addSubmissionReductions(
        collectSubmissionPotential(manager)
      ),
      matrixUpdateState: collectMatrixUpdateState(manager),
    }

    const result = evaluateBudgets(report, options.budgets)
    report.budgets = {
      supplied: options.budgets.size > 0,
      policy: options.budgets.size > 0
        ? 'explicit ceilings supplied; any exceeded ceiling fails the command'
        : 'no ceilings supplied; measurements are report-only',
      thresholds: result.thresholds,
      violations: result.violations,
      ok: result.violations.length === 0,
    }
    return report
  } finally {
    manager.reset()
    disposeGeometries(geometries)
    disposeMaterials(materials)
  }
}

function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  const report = benchmarkScene(options)
  console.log(JSON.stringify(report, null, 2))
  if (report.budgets.supplied && !report.budgets.ok) process.exitCode = 1
}

try {
  main()
} catch (error) {
  console.error(`benchmark:render-scene: ${error.message}`)
  process.exitCode = 1
}
