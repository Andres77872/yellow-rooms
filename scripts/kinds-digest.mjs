#!/usr/bin/env node
// Editor-kind identity digests (spec invariant I10).
//
// Generates every PROTOTYPE_KINDS entry over five fixed seeds and pins the
// serialized .yrmap bytes as a sha256 16-hex prefix plus length. The bytes
// are version-normalised: meta.worldGenVersion and every chunk.version are
// set to 28 before serializeMap, so the WORLD_GEN_VERSION bump does not move
// a kind digest while any real byte drift still does.
//
//   node scripts/kinds-digest.mjs           print the digests JSON
//   node scripts/kinds-digest.mjs --write   write the fixture
//   node scripts/kinds-digest.mjs --check   compare with the fixture (exit 1 on drift)
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { EditorMap } from '../src/editor/EditorMap.js'
import { serializeMap } from '../src/editor/format/yrmap.js'
import { PROTOTYPE_KINDS, generatePrototype } from '../src/editor/prototypes.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const KINDS_FIXTURE_PATH = resolve(ROOT, 'src/editor/__tests__/fixtures/kinds-pre.json')
export const KIND_SEEDS = Object.freeze(['proto', 'lobby', 'same', 'liminal-0', 'liminal-3'])
export const KIND_DIGEST_VERSION = 28

export function kindDigest(kindId, seed) {
  const map = new EditorMap()
  const res = generatePrototype(map, kindId, { seed })
  map.meta.worldGenVersion = KIND_DIGEST_VERSION
  for (const chunk of map.chunks.values()) chunk.version = KIND_DIGEST_VERSION
  const bytes = serializeMap(map)
  return {
    ok: res.ok ?? null,
    sha: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    len: bytes.length,
  }
}

export function computeKindDigests() {
  const out = {}
  for (const kind of PROTOTYPE_KINDS) {
    for (const seed of KIND_SEEDS) out[`${kind.id}:${seed}`] = kindDigest(kind.id, seed)
  }
  return out
}

// Rows that differ between two digest tables (missing rows included).
export function diffKindDigests(expected, actual) {
  const rows = []
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) {
      rows.push({ key, expected: expected[key] ?? null, actual: actual[key] ?? null })
    }
  }
  return rows
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  const digests = computeKindDigests()
  const text = `${JSON.stringify(digests, null, 1)}\n`
  if (process.argv.includes('--write')) {
    mkdirSync(dirname(KINDS_FIXTURE_PATH), { recursive: true })
    writeFileSync(KINDS_FIXTURE_PATH, text)
    console.log(`wrote ${Object.keys(digests).length} kind digests to ${KINDS_FIXTURE_PATH}`)
  } else if (process.argv.includes('--check')) {
    const rows = diffKindDigests(JSON.parse(readFileSync(KINDS_FIXTURE_PATH, 'utf8')), digests)
    if (rows.length === 0) {
      console.log(`kinds-digest: ${Object.keys(digests).length} digests identical`)
    } else {
      console.error(`kinds-digest: ${rows.length} digest(s) drifted`)
      for (const row of rows) {
        console.error(`  ${row.key}: ${JSON.stringify(row.expected)} -> ${JSON.stringify(row.actual)}`)
      }
      process.exitCode = 1
    }
  } else {
    process.stdout.write(text)
  }
}
