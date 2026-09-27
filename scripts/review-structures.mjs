#!/usr/bin/env node

// Headless multilevel structure review — the editor's structure section run
// over many seeds. For every family with canonical tall structures it
// discovers descriptors in the planners, bakes each COMPLETE volume
// (participants × [baseCy..topCy]) into an editor document, and applies the
// same audit the editor shows: the shared layered audit (stairs, slab halves,
// structure slices, lethal voids, bridge seams, family adapters) plus the
// family's connectivity rule (per floor for Office/Hotel atria, whole volume
// for Tower/Lattice, which own their stairs).
//
//   npm run review:structures
//   npm run review:structures -- --family lattice --seeds 8 --per-seed 3
//   npm run review:structures -- --seed lobby --radius 8 --floors -4:24
//   npm run review:structures -- --family office --tallest --seeds 12
//   npm run review:structures -- --size small,medium,large --per-seed 3
//   npm run review:structures -- --type stepwell,grandAtrium --seeds 8
//
// v26: every family (sewer included) also has catalog volumes; by default
// each seed reviews the landmark AND one volume per catalog size class, so
// every class is audited on every run.
//
// Exits non-zero when any complete volume fails, so it can gate a release.

import { hashStr } from '../src/world/core/hash.js'
import { worldConfigForFamilyOrOffice } from '../src/world/mapFamily.js'
import { EditorMap } from '../src/editor/EditorMap.js'
import {
  auditStructure,
  discoverStructures,
  structureChunkCoords,
  summarizeStructure,
} from '../src/editor/structureReview.js'

const FAMILIES = ['office', 'hotel', 'sewer', 'tower', 'lattice']
const SIZE_OF = (s) => s.sizeClass ?? 'landmark'

function parseArgs(argv) {
  const opts = { families: FAMILIES, seeds: null, seedCount: 4, perSeed: 1, radius: 6, y0: -2, y1: 20, tallest: false, verbose: false, sizes: ['landmark', 'small', 'medium', 'large'], types: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--family') opts.families = next().split(',')
    else if (arg === '--seed') opts.seeds = next().split(',')
    else if (arg === '--seeds') opts.seedCount = Number(next())
    else if (arg === '--per-seed') opts.perSeed = Number(next())
    else if (arg === '--radius') opts.radius = Number(next())
    else if (arg === '--floors') {
      const [a, b] = next().split(':').map(Number)
      opts.y0 = a
      opts.y1 = b
    } else if (arg === '--tallest') opts.tallest = true
    else if (arg === '--size') opts.sizes = next().split(',')
    else if (arg === '--type') opts.types = next().split(',')
    else if (arg === '--verbose' || arg === '-v') opts.verbose = true
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: review-structures [--family a,b] [--seed s1,s2 | --seeds N] [--per-seed N per size] [--size landmark,small,medium,large] [--type t1,t2] [--radius R] [--floors y0:y1] [--tallest] [-v]')
      process.exit(0)
    } else {
      console.error(`unknown argument ${arg}`)
      process.exit(2)
    }
  }
  opts.seeds ??= Array.from({ length: opts.seedCount }, (_, i) => `review-${i}`)
  return opts
}

const opts = parseArgs(process.argv.slice(2))
let failures = 0
const rows = []

for (const family of opts.families) {
  const { family: resolved, config } = worldConfigForFamilyOrOffice(family)
  for (const seedText of opts.seeds) {
    const seed = hashStr(seedText)
    const found = discoverStructures(seed, config, {
      x0: -opts.radius, x1: opts.radius, z0: -opts.radius, z1: opts.radius, y0: opts.y0, y1: opts.y1,
    })
    // Shortest volumes first by default (cheapest; they include the minimum
    // band); --tallest reviews the deepest stacks instead.
    const height = (s) => s.topCy - s.baseCy
    const order = (a, b) => (opts.tallest ? height(b) - height(a) : height(a) - height(b)) || a.id - b.id
    const eligible = found.filter((s) => !opts.types || opts.types.includes(s.type))
    // Per size class (landmark + catalog small/medium/large), perSeed each.
    const picked = opts.sizes.flatMap((size) =>
      eligible.filter((s) => SIZE_OF(s) === size).sort(order).slice(0, opts.perSeed))
    if (!picked.length) {
      rows.push({ family: resolved, seed: seedText, id: '—', note: 'no structure in window' })
      continue
    }
    for (const structure of picked) {
      const t0 = performance.now()
      const map = new EditorMap()
      map.bakeChunks({ seed, family: resolved, coords: structureChunkCoords(structure, 0) })
      const bakeMs = performance.now() - t0
      const t1 = performance.now()
      const review = auditStructure(map, structure)
      const auditMs = performance.now() - t1
      const sum = summarizeStructure(structure)
      if (!review.ok) failures++
      rows.push({
        family: resolved,
        seed: seedText,
        id: structure.id,
        variant: `${sum.variant} (${SIZE_OF(structure)})`,
        band: `cy${structure.baseCy}..${structure.topCy}`,
        chunks: review.counts.chunks,
        links: review.counts.stairLinks,
        slices: review.counts.slicePairs,
        lethal: review.counts.lethalPairs,
        walk: review.policy === 'volume'
          ? `${review.volume.components} comp`
          : `floors ${review.floors.filter((f) => f.components > 1).length ? 'SPLIT' : 'ok'}`,
        status: review.ok ? 'ok' : 'FAIL',
        issues: review.issues,
        ms: `${bakeMs.toFixed(0)}+${auditMs.toFixed(0)}`,
      })
    }
  }
}

const header = ['family', 'seed', 'id', 'variant', 'band', 'chunks', 'links', 'slices', 'lethal', 'walk', 'status', 'bake+audit ms']
const table = rows.map((r) => r.note
  ? [r.family, r.seed, r.id, r.note, '', '', '', '', '', '', '', '']
  : [r.family, r.seed, String(r.id), r.variant, r.band, String(r.chunks), String(r.links), String(r.slices), String(r.lethal), r.walk, r.status, r.ms])
const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)))
const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ')
console.log(line(header))
console.log(widths.map((w) => '-'.repeat(w)).join('  '))
for (const row of table) console.log(line(row))

for (const r of rows) {
  if (!r.issues?.length || (r.status === 'ok' && !opts.verbose)) continue
  console.log(`\n${r.family} ${r.seed} #${r.id}:`)
  for (const issue of r.issues.slice(0, 20)) {
    const where = Number.isFinite(issue.gx) ? ` @ ${issue.gx},${issue.gz} cy${issue.cy}` : ''
    console.log(`  ${issue.severity} ${issue.code}: ${issue.text}${where}`)
  }
}

const audited = rows.filter((r) => !r.note).length
console.log(`\n${audited} structure volumes audited · ${failures} failed`)
process.exit(failures ? 1 : 0)
