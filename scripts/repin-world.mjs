#!/usr/bin/env node
// Re-pin helper for WORLD_GEN_VERSION changes (spec §13.2).
//
//   node scripts/repin-world.mjs [--verify]
//       Rebuild every golden and check digestChunk(d, {version: PINNED_VERSION})
//       against its pin; compare `audit-worldgen --print-pins` with
//       releaseEvidence.js; check every filled <id>.goldens.js.
//   node scripts/repin-world.mjs --check-neutral [--from 28]
//       Step A: refold the goldens at --from (default 28) and run
//       `audit-worldgen --print-pins --as-version <from>`; both must equal the
//       v<from> evidence (the current values while the evidence is still at
//       <from>, the previous* digests once it has been re-pinned). Any
//       mismatch aborts and lists the rows and coordinates.
//   node scripts/repin-world.mjs --to <v> [--from 28] [--dry-run]
//       Requires WORLD_GEN_VERSION === v. A: check-neutral. B: rewrite
//       support/goldens.js (key order preserved, PINNED_VERSION = v). D: fill
//       each families/<id>/__tests__/<id>.goldens.js. C: rewrite
//       releaseEvidence.js (legacy rows changed-output, liminal rows
//       first-emission). E: --verify and the activation-evidence audit rows.
//       Running it twice produces no diff. --dry-run reports, writes nothing.
//   node scripts/repin-world.mjs --kinds
//       kinds-digest --check.
//
// Files are rewritten in place: only digest literals, version numbers and
// the generated LIMINAL_RELEASE_EVIDENCE block change, so comments and key
// order survive and a second run is byte-identical.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DEFAULT_WORLD_CONFIG as CFG } from '../src/world/config.js'
import { WORLD_GEN_VERSION } from '../src/world/constants.js'
import { worldConfigForFamily } from '../src/world/mapFamily.js'
import { buildChunk } from '../src/world/pipeline.js'
import { digestChunk } from '../src/world/__tests__/support/chunkDigest.js'
import * as G from '../src/world/__tests__/support/goldens.js'
import * as E from '../src/world/releaseEvidence.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = fileURLToPath(import.meta.url)
const GOLDENS_PATH = resolve(ROOT, 'src/world/__tests__/support/goldens.js')
const EVIDENCE_PATH = resolve(ROOT, 'src/world/releaseEvidence.js')
const FAMILIES_DIR = resolve(ROOT, 'src/world/families')
const AUDIT_SCRIPT = resolve(ROOT, 'scripts/audit-worldgen.mjs')
const KINDS_SCRIPT = resolve(ROOT, 'scripts/kinds-digest.mjs')
const ZERO_DIGEST = '0'.repeat(64)
const GLOBAL_SEED = 12345

// The legacy family goldens and their evidence, in goldens.js order.
const LEGACY = Object.freeze([
  { family: 'sewer', table: 'SEWER_GOLDEN', digest: 'SEWER_GOLDEN_DIGEST', evidence: 'SEWER_RELEASE_EVIDENCE' },
  { family: 'tower', table: 'TOWER_GOLDEN', digest: 'TOWER_GOLDEN_DIGEST', evidence: 'TOWER_RELEASE_EVIDENCE' },
  { family: 'lattice', table: 'LATTICE_GOLDEN', digest: 'LATTICE_GOLDEN_DIGEST', evidence: 'LATTICE_RELEASE_EVIDENCE' },
  { family: 'hotel', table: 'HOTEL_GOLDEN', digest: 'HOTEL_GOLDEN_DIGEST', evidence: 'HOTEL_RELEASE_EVIDENCE' },
])

// --- arguments ---------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const intArg = (name, fallback) => {
  const index = argv.indexOf(name)
  if (index < 0) return fallback
  const value = Number(argv[index + 1])
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} requires a positive integer`)
  return value
}

// --- digests -----------------------------------------------------------------

const sha256Json = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// Same projection as generate.test.js officePairDescriptorPin.
function officePairDescriptorPin(structure) {
  return {
    id: structure.id,
    kind: structure.kind,
    district: structure.district,
    bandIndex: structure.bandIndex,
    baseCy: structure.baseCy,
    bottomCy: structure.bottomCy,
    topCy: structure.topCy,
    levelCount: structure.levelCount,
    height: structure.height,
    bridgeAxis: structure.bridgeAxis,
    longSpan: structure.longSpan,
    shortSpan: structure.shortSpan,
    anchor: structure.anchor,
    participants: structure.participants,
    participantChunks: structure.participantChunks,
    bounds: structure.bounds,
    globalBounds: structure.globalBounds,
    centerLines: structure.centerLines,
    bridgeLevels: structure.bridgeLevels,
    decks: structure.decks.map((deck) => [
      deck.levelCy,
      deck.lowerCy,
      deck.globalBridgeLine,
    ]),
  }
}

// Every legacy golden folded at `version`. Coordinates come from goldens.js;
// only the digests depend on the build.
function computeLegacyGoldens(version) {
  const fold = { version }
  const global = {}
  for (const key of Object.keys(G.GOLDEN)) {
    const [cx, cy, cz] = key.split(',').map(Number)
    global[key] = digestChunk(buildChunk(GLOBAL_SEED, cx, cy, cz, CFG), fold)
  }
  const maxHeight = {}
  for (const keys of Object.values(G.MAX_HEIGHT_GOLDEN)) {
    for (const key of keys) maxHeight[key] = global[key]
  }
  const families = {}
  for (const { family, table } of LEGACY) {
    const config = worldConfigForFamily(family)
    families[family] = Object.fromEntries(G[table].map((fixture) => [
      fixture.key,
      digestChunk(buildChunk(fixture.seed, fixture.cx, fixture.cy, fixture.cz, config), fold),
    ]))
  }
  const [px, py, pz] = [-3, -15, -1]
  const officePair = officePairDescriptorPin(buildChunk(GLOBAL_SEED, px, py, pz, CFG).structure)
  return {
    global,
    maxHeight,
    families,
    officePair,
    globalDigest: sha256Json(global),
    maxHeightDigest: sha256Json(maxHeight),
    familyDigests: Object.fromEntries(
      Object.entries(families).map(([family, digests]) => [family, sha256Json(digests)])
    ),
  }
}

// --- liminal goldens manifests ---------------------------------------------

function liminalManifestPaths() {
  if (!existsSync(FAMILIES_DIR)) return []
  const out = []
  for (const entry of readdirSync(FAMILIES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = resolve(FAMILIES_DIR, entry.name, '__tests__', `${entry.name}.goldens.js`)
    if (existsSync(path)) out.push({ family: entry.name, path })
  }
  return out.sort((a, b) => a.family.localeCompare(b.family))
}

async function loadManifest(path) {
  const mod = await import(`${pathToFileURL(path).href}?t=${Date.now()}`)
  const manifest = mod.default ?? mod.GOLDENS
  if (!manifest || !Array.isArray(manifest.coords)) {
    throw new Error(`${relative(ROOT, path)}: expected a default export { coords: [...], digests }`)
  }
  return manifest
}

// A coordinate is { key?, seed, cx, cy, cz } or [seed, cx, cy, cz].
function coordOf(entry) {
  const [seed, cx, cy, cz] = Array.isArray(entry)
    ? entry
    : [entry.seed, entry.cx, entry.cy, entry.cz]
  const key = (!Array.isArray(entry) && entry.key) || `${seed},${cx},${cy},${cz}`
  return { key, seed, cx, cy, cz }
}

let forcedFamilyConfigFn = null
async function forcedConfig(family) {
  if (!forcedFamilyConfigFn) {
    const path = resolve(FAMILIES_DIR, 'forced.js')
    if (!existsSync(path)) throw new Error('src/world/families/forced.js is missing (forcedFamilyConfig)')
    forcedFamilyConfigFn = (await import(pathToFileURL(path).href)).forcedFamilyConfig
  }
  return forcedFamilyConfigFn(family)
}

async function liminalDigests(manifest, family, version) {
  const config = await forcedConfig(family)
  const out = {}
  for (const entry of manifest.coords) {
    const { key, seed, cx, cy, cz } = coordOf(entry)
    out[key] = digestChunk(buildChunk(seed, cx, cy, cz, config), { version })
  }
  return out
}

const filled = (digests) => digests != null && Object.values(digests).every((d) => typeof d === 'string')

// --- print-pins ----------------------------------------------------------------

function printPins(asVersion = null) {
  const args = [AUDIT_SCRIPT, '--print-pins']
  if (asVersion !== null) args.push('--as-version', String(asVersion))
  const res = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
  if (res.status !== 0) {
    throw new Error(`audit-worldgen --print-pins failed (${res.status}):\n${res.stderr}`)
  }
  return JSON.parse(res.stdout)
}

const EVIDENCE_FIELDS = Object.freeze({
  representative: 'familyRepresentativeDigest',
  corpus: 'familyCorpusDigest',
  global: 'globalGoldenDigest',
  maxHeight: 'maximumHeightGoldenDigest',
})

function evidenceRows() {
  const rows = {}
  for (const { family, evidence } of LEGACY) rows[family] = E[evidence]
  for (const [family, row] of Object.entries(E.LIMINAL_RELEASE_EVIDENCE ?? {})) rows[family] = row
  return rows
}

// --- modes ---------------------------------------------------------------------

async function verify() {
  const failures = []
  const fail = (line) => failures.push(line)
  if (G.PINNED_VERSION !== WORLD_GEN_VERSION) {
    fail(`PINNED_VERSION ${G.PINNED_VERSION} !== WORLD_GEN_VERSION ${WORLD_GEN_VERSION}`)
  }

  const built = computeLegacyGoldens(G.PINNED_VERSION)
  for (const [key, digest] of Object.entries(built.global)) {
    if (G.GOLDEN[key] !== digest) fail(`GOLDEN ${key}: pinned ${G.GOLDEN[key]} built ${digest}`)
  }
  for (const { family, table, digest } of LEGACY) {
    for (const fixture of G[table]) {
      const actual = built.families[family][fixture.key]
      if (fixture.digest !== actual) fail(`${table} ${fixture.key}: pinned ${fixture.digest} built ${actual}`)
    }
    if (G[digest] !== built.familyDigests[family]) fail(`${digest}: pinned ${G[digest]} built ${built.familyDigests[family]}`)
  }
  if (!isDeepStrictEqual(built.officePair, G.OFFICE_PAIR_DESCRIPTOR_GOLDEN)) {
    fail('OFFICE_PAIR_DESCRIPTOR_GOLDEN differs from the built -3,-15,-1 descriptor')
  }

  const pins = printPins()
  const evidence = evidenceRows()
  for (const [family, row] of Object.entries(evidence)) {
    const printed = pins.rows?.[family]
    if (row.generatorVersion !== WORLD_GEN_VERSION) {
      fail(`${family} evidence generatorVersion ${row.generatorVersion} !== WORLD_GEN_VERSION ${WORLD_GEN_VERSION}`)
    }
    if (!printed) {
      fail(`${family}: no --print-pins row`)
      continue
    }
    for (const [pin, field] of Object.entries(EVIDENCE_FIELDS)) {
      if (printed[pin] !== row[field]) fail(`${family}.${field}: evidence ${row[field]} print-pins ${printed[pin]}`)
    }
  }
  for (const family of Object.keys(pins.rows ?? {})) {
    if (!evidence[family]) fail(`${family}: --print-pins row without release evidence`)
  }

  const manifests = []
  for (const { family, path } of liminalManifestPaths()) {
    const manifest = await loadManifest(path)
    if (!filled(manifest.digests)) {
      manifests.push(`${family}: unfilled (skipped)`)
      continue
    }
    const actual = await liminalDigests(manifest, family, G.PINNED_VERSION)
    for (const [key, digest] of Object.entries(actual)) {
      if (manifest.digests[key] !== digest) fail(`${family}.goldens ${key}: pinned ${manifest.digests[key]} built ${digest}`)
    }
    manifests.push(`${family}: ${Object.keys(actual).length} pinned`)
  }

  return {
    ok: failures.length === 0,
    worldGenVersion: WORLD_GEN_VERSION,
    pinnedVersion: G.PINNED_VERSION,
    goldens: Object.keys(built.global).length +
      LEGACY.reduce((sum, { table }) => sum + G[table].length, 0),
    evidenceRows: Object.keys(evidence),
    manifests,
    failures,
  }
}

// Step A. The goldens refolded at `from` and the corpus pins serialised at
// `from` must equal the v<from> evidence.
async function checkNeutral(from) {
  const failures = []
  const fail = (line) => failures.push(line)
  const refolded = computeLegacyGoldens(from)

  if (G.PINNED_VERSION === from) {
    for (const [key, digest] of Object.entries(refolded.global)) {
      if (G.GOLDEN[key] !== digest) fail(`GOLDEN ${key}: v${from} ${G.GOLDEN[key]} refolded ${digest}`)
    }
    for (const { family, table } of LEGACY) {
      for (const fixture of G[table]) {
        const actual = refolded.families[family][fixture.key]
        if (fixture.digest !== actual) fail(`${table} ${fixture.key}: v${from} ${fixture.digest} refolded ${actual}`)
      }
    }
    if (!isDeepStrictEqual(refolded.officePair, G.OFFICE_PAIR_DESCRIPTOR_GOLDEN)) {
      fail('OFFICE_PAIR_DESCRIPTOR_GOLDEN differs from the built -3,-15,-1 descriptor')
    }
  }

  const pins = printPins(from)
  const references = {}
  for (const { family, evidence } of LEGACY) {
    const row = E[evidence]
    if (row.generatorVersion === from) {
      references[family] = {
        representative: row.familyRepresentativeDigest,
        corpus: row.familyCorpusDigest,
        global: row.globalGoldenDigest,
        maxHeight: row.maximumHeightGoldenDigest,
      }
    } else if (row.previousVersion === from) {
      // Already re-pinned: only the previous* digests survive at v<from>.
      references[family] = {
        representative: row.previousFamilyRepresentativeDigest,
        corpus: row.previousFamilyCorpusDigest,
        global: null,
        maxHeight: null,
      }
    } else {
      fail(`${family}: evidence holds no v${from} digests (generator ${row.generatorVersion}, previous ${row.previousVersion})`)
    }
  }

  for (const [family, ref] of Object.entries(references)) {
    const inProcess = {
      representative: refolded.familyDigests[family],
      global: refolded.globalDigest,
      maxHeight: refolded.maxHeightDigest,
    }
    const printed = pins.rows?.[family] ?? {}
    for (const [pin, expected] of Object.entries(ref)) {
      if (expected === null) continue
      if (printed[pin] !== expected) fail(`${family}.${pin} (print-pins --as-version ${from}): v${from} ${expected} got ${printed[pin]}`)
      if (pin in inProcess && inProcess[pin] !== expected) {
        fail(`${family}.${pin} (refolded goldens): v${from} ${expected} got ${inProcess[pin]}`)
      }
    }
  }

  return {
    ok: failures.length === 0,
    from,
    worldGenVersion: WORLD_GEN_VERSION,
    pinnedVersion: G.PINNED_VERSION,
    checked: Object.fromEntries(Object.entries(references).map(([family, ref]) => [
      family,
      Object.keys(ref).filter((pin) => ref[pin] !== null),
    ])),
    failures,
  }
}

// --- in-place rewriting ------------------------------------------------------

const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
const isIdent = (key) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
const isPrimitive = (v) => v === null || typeof v !== 'object'

// Key-order-preserving literal writer: objects/arrays of primitives stay on
// one line (up to 100 columns), anything nested opens one line per element.
function lit(value, indent = '') {
  if (value === null) return 'null'
  if (typeof value === 'string') return quote(value)
  if (typeof value !== 'object') return String(value)
  const inner = `${indent}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    if (value.every(isPrimitive)) {
      const line = `[${value.map((v) => lit(v)).join(', ')}]`
      if (line.length + indent.length <= 100) return line
    }
    return `[\n${value.map((v) => `${inner}${lit(v, inner)},\n`).join('')}${indent}]`
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  const key = (k) => (isIdent(k) ? k : quote(k))
  if (entries.every(([, v]) => isPrimitive(v))) {
    const line = `{ ${entries.map(([k, v]) => `${key(k)}: ${lit(v)}`).join(', ')} }`
    if (line.length + indent.length <= 100) return line
  }
  return `{\n${entries.map(([k, v]) => `${inner}${key(k)}: ${lit(v, inner)},\n`).join('')}${indent}}`
}

function replaceOnce(text, pattern, replacement, what) {
  const matches = text.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))
  if (!matches || matches.length !== 1) {
    throw new Error(`rewrite: expected exactly one ${what}, found ${matches?.length ?? 0}`)
  }
  return text.replace(pattern, replacement)
}

// [start, end) of `export const NAME = ...` up to the first line that
// closes it at column 0.
function blockRange(text, name) {
  const start = text.indexOf(`export const ${name} = `)
  if (start < 0) throw new Error(`rewrite: ${name} not found`)
  const close = /\n[}\]][)]?\n/g
  close.lastIndex = start
  const match = close.exec(text)
  if (!match) throw new Error(`rewrite: ${name} has no closing line`)
  return [start, match.index + match[0].length]
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function rewriteGoldens(text, built, version) {
  let out = replaceOnce(text, /^export const PINNED_VERSION = \d+$/m, `export const PINNED_VERSION = ${version}`, 'PINNED_VERSION')
  {
    const [start, end] = blockRange(out, 'GOLDEN')
    let block = out.slice(start, end)
    for (const [key, digest] of Object.entries(built.global)) {
      block = replaceOnce(block, new RegExp(`^(  '${escapeRe(key)}': ')[0-9a-f]{8}(',)$`, 'm'), `$1${digest}$2`, `GOLDEN '${key}'`)
    }
    out = out.slice(0, start) + block + out.slice(end)
  }
  for (const { family, table, digest } of LEGACY) {
    const [start, end] = blockRange(out, table)
    let block = out.slice(start, end)
    for (const [key, value] of Object.entries(built.families[family])) {
      block = replaceOnce(block, new RegExp(`^(  \\{ key: '${escapeRe(key)}',.*digest: ')[0-9a-f]{8}(' \\},)$`, 'm'), `$1${value}$2`, `${table} '${key}'`)
    }
    out = out.slice(0, start) + block + out.slice(end)
    out = replaceOnce(out, new RegExp(`^(export const ${digest} = ')[0-9a-f]{64}(')$`, 'm'), `$1${built.familyDigests[family]}$2`, digest)
  }
  if (!isDeepStrictEqual(built.officePair, G.OFFICE_PAIR_DESCRIPTOR_GOLDEN)) {
    const [start, end] = blockRange(out, 'OFFICE_PAIR_DESCRIPTOR_GOLDEN')
    out = `${out.slice(0, start)}export const OFFICE_PAIR_DESCRIPTOR_GOLDEN = ${lit(built.officePair)}\n${out.slice(end)}`
  }
  return out
}

function setField(block, field, value, what) {
  return replaceOnce(block, new RegExp(`^(  ${field}: ).*(,)$`, 'm'), `$1${lit(value)}$2`, `${what}.${field}`)
}

const LIMINAL_HEADER = 'export const LIMINAL_RELEASE_EVIDENCE = '

function liminalEvidenceBlock(rows) {
  const families = Object.keys(rows)
  if (families.length === 0) return `${LIMINAL_HEADER}Object.freeze({})\n`
  const body = families.map((family) => {
    const fields = Object.entries(rows[family])
      .map(([k, v]) => `    ${k}: ${lit(v, '    ')},\n`).join('')
    return `  ${isIdent(family) ? family : quote(family)}: Object.freeze({\n${fields}  }),\n`
  }).join('')
  return `${LIMINAL_HEADER}Object.freeze({\n${body}})\n`
}

function rewriteEvidence(text, pins, version, liminalRepresentatives) {
  let out = text
  for (const { family, evidence } of LEGACY) {
    const old = E[evidence]
    const printed = pins.rows?.[family]
    if (!printed) throw new Error(`rewrite: no --print-pins row for ${family}`)
    const [start, end] = blockRange(out, evidence)
    let block = out.slice(start, end)
    if (old.generatorVersion !== version) {
      // First re-pin to `version`: the current digests become previous*.
      block = setField(block, 'byteImpact', 'changed-output', evidence)
      block = setField(block, 'previousVersion', old.generatorVersion, evidence)
      block = setField(block, 'previousFamilyRepresentativeDigest', old.familyRepresentativeDigest, evidence)
      block = setField(block, 'previousFamilyCorpusDigest', old.familyCorpusDigest, evidence)
      block = setField(block, 'generatorVersion', version, evidence)
    }
    for (const [pin, field] of Object.entries(EVIDENCE_FIELDS)) {
      block = setField(block, field, printed[pin], evidence)
    }
    out = out.slice(0, start) + block + out.slice(end)
  }

  // Liminal rows: every --print-pins row that is not a legacy family.
  const legacyIds = new Set(LEGACY.map(({ family }) => family))
  const rows = {}
  for (const [family, printed] of Object.entries(pins.rows ?? {})) {
    if (legacyIds.has(family)) continue
    const previous = E.LIMINAL_RELEASE_EVIDENCE?.[family]
    // Contract for a liminal print-pins row (R-release): `representative` is
    // either omitted/null (derived here) or exactly what step D derives:
    // sha256(JSON.stringify({ [key]: digestChunk(buildChunk(seed, cx, cy, cz,
    // forcedFamilyConfig(id)), { version }) })) over <id>.goldens.js coords in
    // manifest order, key = entry.key || `${seed},${cx},${cy},${cz}` (the same
    // shape as the legacy representative). A mismatch aborts before any write.
    const representative = printed.representative ?? liminalRepresentatives[family]
    if (liminalRepresentatives[family] && representative !== liminalRepresentatives[family]) {
      throw new Error(`${family}: print-pins representative ${representative} != goldens manifest ${liminalRepresentatives[family]}`)
    }
    const firstEmission = !previous || previous.generatorVersion === version
    rows[family] = {
      family,
      byteImpact: firstEmission ? 'first-emission' : 'changed-output',
      previousVersion: firstEmission ? (previous?.previousVersion ?? version - 1) : previous.generatorVersion,
      previousFamilyRepresentativeDigest: firstEmission
        ? (previous?.previousFamilyRepresentativeDigest ?? ZERO_DIGEST)
        : previous.familyRepresentativeDigest,
      previousFamilyCorpusDigest: firstEmission
        ? (previous?.previousFamilyCorpusDigest ?? ZERO_DIGEST)
        : previous.familyCorpusDigest,
      generatorVersion: version,
      globalGoldenDigest: printed.global,
      maximumHeightGoldenDigest: printed.maxHeight,
      familyRepresentativeDigest: representative,
      familyCorpusDigest: printed.corpus,
      profileIdentity: previous?.profileIdentity ?? `${family}-forced-audit`,
      seedDerivation: previous?.seedDerivation ?? `hashStr("audit-${family}-N#1")`,
      affectsMaximumHeight: previous?.affectsMaximumHeight ?? false,
    }
  }
  const start = out.indexOf(LIMINAL_HEADER)
  const block = liminalEvidenceBlock(rows)
  if (start < 0) {
    out = `${out.replace(/\n*$/, '\n')}\n${block}`
  } else {
    // The empty block is one line; a filled one closes at column 0.
    const lineEnd = out.indexOf('\n', start) + 1
    const end = out.slice(start, lineEnd).trimEnd().endsWith('({})')
      ? lineEnd
      : blockRange(out, 'LIMINAL_RELEASE_EVIDENCE')[1]
    out = out.slice(0, start) + block + out.slice(end)
  }
  return { text: out, liminal: Object.keys(rows) }
}

// Leading comment lines survive; the manifest object is rewritten with its
// own key order and the new digests.
function rewriteManifest(text, manifest, digests) {
  const header = []
  for (const line of text.split('\n')) {
    if (line.startsWith('//')) header.push(line)
    else break
  }
  const next = { ...manifest, digests }
  return `${header.length ? `${header.join('\n')}\n` : ''}export default Object.freeze(${lit(next)})\n`
}

function runChild(args) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 << 20 })
}

// Step E, second half: the audit's own validateActivationEvidence verdicts.
// --seeds 32 keeps the 32-seed family corpora identical to the full run.
function activationAudit() {
  const res = runChild([AUDIT_SCRIPT, '--seeds', '32', '--wide-seeds', '1', '--wide-radius', '8', '--family', 'all'])
  let report
  try {
    report = JSON.parse(res.stdout)
  } catch {
    return { ok: false, failures: [`audit-worldgen failed (${res.status}): ${res.stderr.slice(0, 2000)}`] }
  }
  const failures = []
  if (report.familyVerdict?.ok !== true) failures.push(`familyVerdict: ${JSON.stringify(report.familyVerdict?.reasons)}`)
  for (const row of report.familyRows ?? []) {
    if (row.family === 'office') continue
    if (row.pins?.family !== true) failures.push(`${row.family}: pins.family ${row.pins?.family} (${row.corpus?.status})`)
    if (row.pins?.maximumHeight === false) failures.push(`${row.family}: pins.maximumHeight false`)
  }
  return { ok: failures.length === 0, rows: (report.familyRows ?? []).map((r) => r.family), failures }
}

async function repinTo(version, from, dryRun) {
  if (WORLD_GEN_VERSION !== version) {
    throw new Error(`--to ${version} requires WORLD_GEN_VERSION === ${version} (constants.js has ${WORLD_GEN_VERSION})`)
  }
  const summary = { to: version, from, dryRun, steps: {} }

  // A. value neutrality at v<from>.
  const neutral = await checkNeutral(from)
  summary.steps.A = neutral
  if (!neutral.ok) return { ...summary, ok: false, aborted: 'A' }

  // B. goldens.js at the new version.
  const built = computeLegacyGoldens(version)
  const goldensText = readFileSync(GOLDENS_PATH, 'utf8')
  const nextGoldens = rewriteGoldens(goldensText, built, version)

  // D. liminal goldens manifests (their representative digests feed C).
  const manifests = []
  const liminalRepresentatives = {}
  for (const { family, path } of liminalManifestPaths()) {
    const manifest = await loadManifest(path)
    if (manifest.coords.length === 0) {
      manifests.push({ family, path, skipped: 'no coords' })
      continue
    }
    const digests = await liminalDigests(manifest, family, version)
    liminalRepresentatives[family] = sha256Json(digests)
    const text = readFileSync(path, 'utf8')
    manifests.push({ family, path, text, next: rewriteManifest(text, manifest, digests) })
  }

  // C. releaseEvidence.js from the current pins.
  const pins = printPins()
  for (const { family } of LEGACY) {
    if (pins.rows?.[family]?.representative !== built.familyDigests[family]) {
      return { ...summary, ok: false, aborted: 'C', failures: [`${family}: print-pins representative disagrees with the rebuilt goldens`] }
    }
  }
  const evidenceText = readFileSync(EVIDENCE_PATH, 'utf8')
  const evidence = rewriteEvidence(evidenceText, pins, version, liminalRepresentatives)

  const writes = [
    { path: GOLDENS_PATH, text: goldensText, next: nextGoldens },
    { path: EVIDENCE_PATH, text: evidenceText, next: evidence.text },
    ...manifests.filter((m) => m.next !== undefined),
  ]
  summary.steps.B = { changed: nextGoldens !== goldensText }
  summary.steps.C = { changed: evidence.text !== evidenceText, liminalRows: evidence.liminal }
  summary.steps.D = manifests.map(({ family, skipped, text, next }) => ({
    family,
    ...(skipped ? { skipped } : { changed: next !== text }),
  }))
  summary.changedFiles = writes.filter((w) => w.next !== w.text).map((w) => relative(ROOT, w.path))
  if (dryRun) return { ...summary, ok: true }
  for (const w of writes) if (w.next !== w.text) writeFileSync(w.path, w.next)

  // E. fresh-process verify plus the audit's activation verdicts.
  const verifyRun = runChild([SCRIPT, '--verify'])
  summary.steps.E = {
    verify: { ok: verifyRun.status === 0, output: verifyRun.stdout.trim() || verifyRun.stderr.trim() },
    activation: activationAudit(),
  }
  const ok = summary.steps.E.verify.ok && summary.steps.E.activation.ok
  return { ...summary, ok }
}

// --- main ----------------------------------------------------------------------

async function main() {
  let result
  if (flag('--kinds')) {
    const res = runChild([KINDS_SCRIPT, '--check'])
    process.stdout.write(res.stdout)
    process.stderr.write(res.stderr)
    process.exitCode = res.status ?? 1
    return
  }
  const from = intArg('--from', 28)
  if (flag('--to')) {
    result = await repinTo(intArg('--to', null), from, flag('--dry-run'))
  } else if (flag('--check-neutral')) {
    result = await checkNeutral(from)
  } else {
    result = await verify()
  }
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

await main()
