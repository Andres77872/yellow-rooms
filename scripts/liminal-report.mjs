#!/usr/bin/env node

// Liminal-metrics corpus: the editor's per-floor liminal report run over many
// seeds of every family (and the prototype map kinds), summarised as median
// and p10–p90 per metric. The expressive-range numbers behind the research
// recommendations in docs/liminal-horror-design.md.
//
//   npm run report:liminal
//   npm run report:liminal -- --seeds 12 --radius 2 --family office,hotel
//   npm run report:liminal -- --json out.json
//
// Report-only: there are no pass/fail thresholds here.

import { writeFileSync } from 'node:fs'
import { WorldSource } from '../src/editor/worldSource.js'
import { liminalReport } from '../src/editor/simulate.js'
import { EditorMap } from '../src/editor/EditorMap.js'
import { PROTOTYPE_KINDS, generatePrototype } from '../src/editor/prototypes.js'

const FAMILIES = ['office', 'hotel', 'sewer', 'tower', 'lattice']

function parseArgs(argv) {
  const opts = { families: FAMILIES, prototypes: PROTOTYPE_KINDS.map((k) => k.id), seeds: 8, radius: 2, floor: 0, json: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--family') opts.families = next().split(',').filter(Boolean)
    else if (a === '--prototypes') opts.prototypes = next().split(',').filter(Boolean)
    else if (a === '--no-prototypes') opts.prototypes = []
    else if (a === '--seeds') opts.seeds = Number(next())
    else if (a === '--radius') opts.radius = Number(next())
    else if (a === '--floor') opts.floor = Number(next())
    else if (a === '--json') opts.json = next()
    else {
      console.error(`unknown argument ${a}`)
      process.exit(2)
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))

const METRICS = [
  ['walkable', (f) => f.walkable, 0],
  ['loops/100 spaces', (f) => (f.spaces ? (100 * f.loops) / f.spaces : 0), 1],
  ['dead-end share', (f) => (f.spaces ? f.deadEndSpaces / f.spaces : 0), 2],
  ['ring share (c+d)', (f) => f.hillier.c + f.hillier.d, 2],
  ['ICD', (f) => f.icd, 2],
  ['intelligibility', (f) => f.intelligibility, 2],
  ['darkness', (f) => f.darkness, 2],
  ["dark Moran's I", (f) => f.darkClustering, 2],
  ['sightline median', (f) => f.sightMedian, 1],
  ['sightline p90', (f) => f.sightP90, 1],
  ['isovist median', (f) => f.isovistMedian, 0],
  ['compactness', (f) => f.compactnessMedian, 2],
  ['room repetition', (f) => f.roomRepetition, 2],
  ['chunk repetition', (f) => f.repetition, 2],
]

const q = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))] : NaN

function summarize(floors) {
  const out = {}
  for (const [name, get] of METRICS) {
    const v = floors.map(get).filter(Number.isFinite).sort((a, b) => a - b)
    out[name] = { p10: q(v, 0.1), median: q(v, 0.5), p90: q(v, 0.9) }
  }
  return out
}

const rows = []

for (const family of opts.families) {
  const floors = []
  const t0 = performance.now()
  for (let i = 0; i < opts.seeds; i++) {
    const world = new WorldSource({ seedText: `liminal-${i}`, family })
    // Sample away from the forced-office spawn neighbourhood.
    const cx = 6 + (i % 3) * 5
    const cz = -4 - Math.floor(i / 3) * 5
    const r = opts.radius
    const box = { x0: cx - r, x1: cx + r, z0: cz - r, z1: cz + r, y0: opts.floor, y1: opts.floor }
    world.prepare(box)
    floors.push(...liminalReport(world, box, { samples: 24, rays: 96 }).floors)
  }
  rows.push({ kind: family, samples: floors.length, ms: performance.now() - t0, summary: summarize(floors) })
}

for (const id of opts.prototypes) {
  const floors = []
  const t0 = performance.now()
  for (let i = 0; i < opts.seeds; i++) {
    const map = new EditorMap()
    const res = generatePrototype(map, id, { seed: `liminal-${i}` })
    const b = map.bounds()
    const report = liminalReport(map, { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0: b.y0, y1: b.y1 }, { samples: 24, rays: 96 })
    floors.push(...report.floors)
    if (!res.ok) console.error(`${id} seed ${i}: ${res.error}`)
  }
  rows.push({ kind: `proto:${id}`, samples: floors.length, ms: performance.now() - t0, summary: summarize(floors) })
}

// One table per metric group, kinds as rows: "median (p10–p90)".
const fmt = (s, digits) => `${s.median.toFixed(digits)} (${s.p10.toFixed(digits)}–${s.p90.toFixed(digits)})`
const header = ['kind', 'n', ...METRICS.map(([n]) => n)]
const table = rows.map((r) => [r.kind, String(r.samples), ...METRICS.map(([n, , d]) => fmt(r.summary[n], d))])
const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)))
const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join(' | ')
console.log(line(header))
console.log(widths.map((w) => '-'.repeat(w)).join('-|-'))
for (const row of table) console.log(line(row))
console.log(`\n${rows.reduce((n, r) => n + r.samples, 0)} floor samples · ${opts.seeds} seeds per kind · ${(2 * opts.radius + 1) ** 2} chunks per world sample`)

if (opts.json) {
  writeFileSync(opts.json, JSON.stringify({ opts, rows }, null, 2))
  console.log(`wrote ${opts.json}`)
}
