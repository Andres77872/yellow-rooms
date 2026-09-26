#!/usr/bin/env node

// World-grid lighting and sight-culling evidence (engine-improvement chapter
// 12 §4.1, §4.4; chapter 07 evidence records). Headless CPU measurements only:
// it prewarms the same streaming box the game builds at spawn, bakes the
// wall-aware light lists + cell-graph bounce, and then floods sight from a few
// eye positions. It reports bake cost, list/visibility statistics, how the
// wall-aware gameplay light differs from the legacy radius sum, and how many
// resident chunks the flood would submit. It does NOT measure GPU time or
// frames — use the F2 perf/light tools ("copy timings") in a browser for that.
//
//   node scripts/benchmark-light-grid.mjs [--family office|all] [--seed text] [--json]

import { performance } from 'node:perf_hooks'
import * as THREE from 'three'

import { ChunkManager } from '../src/world/ChunkManager.js'
import { createGeometries, disposeGeometries } from '../src/render/geometries.js'
import { hashStr } from '../src/world/core/hash.js'
import { MAP_FAMILY_ORDER, worldConfigForFamilyOrOffice } from '../src/world/mapFamily.js'
import {
  LIGHT_RANGE,
  SPAWN_WORLD,
  STALKER_AMBIENT,
  WORLD_GEN_VERSION,
  layerY,
} from '../src/world/constants.js'
import { GRID_SCHEMA_VERSION } from '../src/world/lightGrid/gridSpec.js'

function parseArgs(argv) {
  const out = { family: 'office', seed: 'engine-improvement', json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--family') out.family = argv[++i]
    else if (a === '--seed') out.seed = argv[++i]
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') {
      console.log('usage: benchmark-light-grid.mjs [--family office|all] [--seed text] [--json]')
      process.exit(0)
    }
  }
  return out
}

// Deterministic sample points (no Math.random: reports must be reproducible).
function* samplePoints(count, radius) {
  let s = 0x9e3779b9
  const next = () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0
    return s / 4294967296
  }
  for (let i = 0; i < count; i++) {
    yield [SPAWN_WORLD + (next() - 0.5) * 2 * radius, SPAWN_WORLD + (next() - 0.5) * 2 * radius]
  }
}

function legacyLightAt(cm, wx, wz, cy) {
  const lamps = cm.collectLampsNear(wx, wz, [], cy, LIGHT_RANGE)
  let acc = STALKER_AMBIENT
  const wy = layerY(cy)
  for (const v of lamps) {
    const d = v.cy !== cy ? Math.hypot(v.x - wx, v.y - wy, v.z - wz) : Math.hypot(v.x - wx, v.z - wz)
    if (d < LIGHT_RANGE) acc += (1 - d / LIGHT_RANGE) ** 3
  }
  return Math.min(1, acc)
}

function measure(family, seedText) {
  const materials = new Proxy({}, { get: () => new THREE.MeshBasicMaterial() })
  const geom = createGeometries()
  const cm = new ChunkManager(new THREE.Scene(), hashStr(`${seedText}#1`), materials, geom)
  cm.config = worldConfigForFamilyOrOffice(family).config
  const grid = cm.lightGrid
  const flush = grid.flush.bind(grid)
  let bakeMs = 0
  grid.flush = () => {
    const t = performance.now()
    const n = flush()
    bakeMs += performance.now() - t
    return n
  }
  const t0 = performance.now()
  cm.prewarm(SPAWN_WORLD, SPAWN_WORLD, 0)
  const prewarmMs = performance.now() - t0
  const resident = cm.chunks.size

  // Gameplay light: wall-aware grid vs the legacy radius sum.
  let samples = 0
  let darker = 0
  let brighter = 0
  let sumAbs = 0
  for (const [x, z] of samplePoints(2000, 60)) {
    const g = grid.lightAt(x, z, 0)
    if (g === null) continue
    const l = legacyLightAt(cm, x, z, 0)
    samples++
    sumAbs += Math.abs(g - l)
    if (g < l - 0.05) darker++
    if (g > l + 0.01) brighter++
  }

  // Sight culling from a few open eye positions around spawn.
  cm.enableSightCulling(true)
  const sight = []
  for (const [ox, oz] of [[0, 0], [9, 0], [0, 9], [-9, -6], [15, 12], [-12, 15]]) {
    const x = SPAWN_WORLD + ox
    const z = SPAWN_WORLD + oz
    if (cm.isBlocked(x, z, 0)) continue
    cm.sightCulling.invalidate()
    cm._updateSight(x, z, 0)
    const chunks = [...cm.chunks.values()]
    sight.push({
      eye: [x, z],
      drawn: chunks.filter((c) => c.group.visible).length,
      sameFloorDrawn: chunks.filter((c) => c.cy === 0 && c.group.visible).length,
      sameFloor: chunks.filter((c) => c.cy === 0).length,
      floodMs: +cm.sightCulling.stats.ms.toFixed(3),
    })
  }

  const report = {
    family,
    seed: seedText,
    versions: { generator: WORLD_GEN_VERSION, grid: GRID_SCHEMA_VERSION, three: THREE.REVISION },
    resident,
    prewarmMs: +prewarmMs.toFixed(1),
    grid: {
      bakeMs: +bakeMs.toFixed(1),
      bakeMsPerChunk: +(bakeMs / Math.max(1, resident)).toFixed(3),
      ...grid.stats,
    },
    gameplayLight: {
      samples,
      meanAbsDelta: +(sumAbs / Math.max(1, samples)).toFixed(4),
      darkerThanLegacy: darker,
      brighterThanLegacy: brighter,
    },
    sight,
  }
  cm.reset()
  disposeGeometries(geom)
  return report
}

const args = parseArgs(process.argv.slice(2))
const families = args.family === 'all' ? MAP_FAMILY_ORDER : [args.family]
const reports = families.map((f) => measure(f, args.seed))
if (args.json) {
  console.log(JSON.stringify(reports, null, 2))
} else {
  for (const r of reports) {
    const drawn = r.sight.map((s) => `${s.drawn}/${r.resident}`).join(' ')
    const flood = Math.max(...r.sight.map((s) => s.floodMs))
    console.log(
      `${r.family.padEnd(8)} resident ${r.resident}  prewarm ${r.prewarmMs} ms  ` +
        `bake ${r.grid.bakeMs} ms (${r.grid.bakeMsPerChunk} ms/chunk)  ` +
        `pairs clear/sampled/blocked ${r.grid.clearPairs}/${r.grid.sampledPairs}/${r.grid.blockedPairs}`
    )
    console.log(
      `${''.padEnd(8)} gameplay light: ${r.gameplayLight.darkerThanLegacy}/${r.gameplayLight.samples} darker ` +
        `(wall leaks removed), ${r.gameplayLight.brighterThanLegacy} brighter, ` +
        `mean |delta| ${r.gameplayLight.meanAbsDelta}`
    )
    console.log(`${''.padEnd(8)} sight culling drawn/resident: ${drawn}  (flood <= ${flood} ms)`)
  }
}
