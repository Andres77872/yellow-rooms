#!/usr/bin/env node

// Are the map families different MAPS, or one map in different colours?
// Samples n×n-chunk patches of every family over many seeds and floors,
// extracts layout-only signatures (src/world/familySignature.js — no palette,
// furniture art or role names), and reports:
//   - leave-one-out nearest-centroid accuracy (can the layout alone tell the
//     family?) and the confusion matrix;
//   - pairwise centroid distance in pooled-sd units (RMS effect size) with
//     the three features that separate each pair most;
//   - same-seed skeleton overlap (wall Jaccard, seam agreement, shared seam
//     openings) — literally the same plan at the same coordinates.
//
//   npm run report:families
//   npm run report:families -- --seeds 12 --patch 3 --json out.json

import { writeFileSync } from 'node:fs'
import { generateChunk } from '../src/world/generate.js'
import { worldConfigForFamilyOrOffice } from '../src/world/mapFamily.js'
import { hashStr } from '../src/world/core/hash.js'
import {
  SIGNATURE_FEATURES,
  familyDistinctness,
  patchSignature,
  skeletonOverlap,
} from '../src/world/familySignature.js'

const FAMILIES = ['office', 'hotel', 'sewer', 'tower', 'lattice']
const opts = { seeds: 8, patch: 3, floors: [0, 1, 2], json: null }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--seeds') opts.seeds = Number(argv[++i])
  else if (a === '--patch') opts.patch = Number(argv[++i])
  else if (a === '--floors') opts.floors = argv[++i].split(',').map(Number)
  else if (a === '--json') opts.json = argv[++i]
  else {
    console.error(`unknown argument ${a}`)
    process.exit(2)
  }
}

const sources = Object.fromEntries(FAMILIES.map((f) => {
  const { config } = worldConfigForFamilyOrOffice(f)
  const cache = new Map()
  return [f, (seed) => (cx, cy, cz) => {
    const key = `${seed},${cx},${cy},${cz}`
    let d = cache.get(key)
    if (!d) cache.set(key, (d = generateChunk(seed, cx, cy, cz, config)))
    return d
  }]
}))

const samples = Object.fromEntries(FAMILIES.map((f) => [f, []]))
const overlaps = {}
const t0 = performance.now()
for (let i = 0; i < opts.seeds; i++) {
  const seed = hashStr(`families-${i}`)
  // Two windows per seed: the spawn neighbourhood and one well away from it.
  for (const [cx0, cz0] of [[-1, -1], [5 + 4 * (i % 3), -7 - 3 * (i % 2)]]) {
    for (const cy of opts.floors) {
      const at = Object.fromEntries(FAMILIES.map((f) => [f, sources[f](seed)]))
      for (const f of FAMILIES) samples[f].push(patchSignature(at[f], cx0, cz0, opts.patch, cy))
      for (let a = 0; a < FAMILIES.length; a++) {
        for (let b = a + 1; b < FAMILIES.length; b++) {
          const key = `${FAMILIES[a]}~${FAMILIES[b]}`
          const o = skeletonOverlap(at[FAMILIES[a]], at[FAMILIES[b]], cx0, cz0, opts.patch, cy)
          const acc = (overlaps[key] ??= { wallJaccard: 0, seamAgreement: 0, seamOpeningsShared: 0, seamKappa: 0, n: 0 })
          acc.wallJaccard += o.wallJaccard
          acc.seamAgreement += o.seamAgreement
          acc.seamOpeningsShared += o.seamOpeningsShared
          acc.seamKappa += o.seamKappa
          acc.n++
        }
      }
    }
  }
}
for (const o of Object.values(overlaps)) {
  o.wallJaccard /= o.n
  o.seamAgreement /= o.n
  o.seamOpeningsShared /= o.n
  o.seamKappa /= o.n
}

const report = familyDistinctness(samples)
const pct = (x) => `${(100 * x).toFixed(0)}%`
console.log(`family distinctness — ${opts.seeds} seeds × 2 windows × ${opts.floors.length} floors, ${opts.patch}×${opts.patch}-chunk patches (${((performance.now() - t0) / 1000).toFixed(1)} s)\n`)
console.log(`nearest-centroid accuracy (layout only): ${pct(report.accuracy)}`)
console.log('confusion (row = true family):')
const fams = Object.keys(report.confusion)
console.log(`  ${''.padEnd(8)} ${fams.map((f) => f.padStart(8)).join('')}`)
for (const f of fams) console.log(`  ${f.padEnd(8)} ${fams.map((g) => String(report.confusion[f][g]).padStart(8)).join('')}`)
console.log('\npairwise                effect   same walls  seam kappa  shared seam openings   separated most by')
for (const [key, p] of Object.entries(report.pairwise)) {
  const o = overlaps[key]
  console.log(`  ${key.padEnd(18)} ${p.rms.toFixed(2).padStart(7)}   ${pct(o.wallJaccard).padStart(9)}  ${o.seamKappa.toFixed(2).padStart(10)}  ${pct(o.seamOpeningsShared).padStart(19)}   ${p.top.join(', ')}`)
}
console.log('\nfeature means:')
console.log(`  ${'feature'.padEnd(16)} ${fams.map((f) => f.padStart(9)).join('')}`)
for (const feat of SIGNATURE_FEATURES) {
  console.log(`  ${feat.padEnd(16)} ${fams.map((f) => report.means[f][feat].toFixed(3).padStart(9)).join('')}`)
}
if (opts.json) {
  writeFileSync(opts.json, JSON.stringify({ opts, report, overlaps }, null, 2))
  console.log(`\nwrote ${opts.json}`)
}
