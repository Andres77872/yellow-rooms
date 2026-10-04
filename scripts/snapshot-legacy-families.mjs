#!/usr/bin/env node
// Legacy-family identity snapshot (spec §11.3, invariant I3).
//
// Captures, for each of the five legacy families (office, sewer, tower,
// lattice, hotel), every value a registry-driven lookup will later resolve:
// palette, surface sets, footstep classes, door vocabulary and kits, sign
// plates, leaf finish, room catalogs, audio rows, interior dressing on fixed
// chunks, decal-atlas painting, door function/schedule, debug colours,
// adapter key orders, void-safety policy, family configs, exit placements,
// spawn constants and streaming priority. Values are folded to sha256
// prefixes (small scalars are kept verbatim) so a diff names the drifting
// lookup without dumping megabytes.
//
//   node scripts/snapshot-legacy-families.mjs           print the snapshot JSON
//   node scripts/snapshot-legacy-families.mjs --write   write the fixture
//   node scripts/snapshot-legacy-families.mjs --check   compare with the fixture
//
// The fixture lives at src/world/__tests__/fixtures/legacy-families.snapshot.json
// and was captured BEFORE the family-registry refactor. Tests import
// computeLegacySnapshot() and compare it with the fixture (registry.legacy).
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { FAMILY_SPACES, AudioBus } from '../src/audio/AudioBus.js'
import { FAMILY_PA, MusicPlayer } from '../src/audio/music/MusicPlayer.js'
import { createExitPlacement, EXIT_FLOORS, EXIT_REACH } from '../src/core/exitPlacement.js'
import { STRUCTURE_FAMILY_COLORS, exploreConfigForFamily } from '../src/debug/mapInspect.js'
import { LEAF_FINISH } from '../src/render/gbufferMaterials.js'
import { paintDecalAtlas } from '../src/render/decalAtlas.js'
import { familyNote, TITLE_HTML } from '../src/ui/titleMenu.js'
import { ChunkManager, prioritizeRequest } from '../src/world/ChunkManager.js'
import { DEFAULT_WORLD_CONFIG } from '../src/world/config.js'
import {
  CELL,
  CHUNK,
  CHUNK_WORLD,
  EYE_H,
  HUB_CELL,
  SPAWN_WORLD,
  WORLD_GEN_VERSION,
} from '../src/world/constants.js'
import { hashStr } from '../src/world/core/hash.js'
import {
  DECAL_KINDS,
  SIGN_PLATES,
  signCell,
  signCellFor,
  signIdFor,
  signPlateAt,
  signPlates,
} from '../src/world/decalKinds.js'
import { edgeContext } from '../src/world/doorFunction.js'
import { collectDoorways } from '../src/world/doors.js'
import { doorSchedule, scheduleDoor } from '../src/world/doorSchedule.js'
import { FAMILY_AUDIT_ADAPTERS } from '../src/world/familyAudit.js'
import { familyPalette } from '../src/world/familyPalette.js'
import { generateChunk } from '../src/world/generate.js'
import {
  requiresVoidSafety,
  resolveMapFamily,
  worldConfigForFamily,
  worldConfigForFamilyOrOffice,
} from '../src/world/mapFamily.js'
import {
  CELL_BRIDGE,
  CELL_OPEN,
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  PASSAGE_DOOR,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_NONE,
} from '../src/world/mapTypes.js'
import { collectInteriorDressing } from '../src/world/objects/dressing/index.js'
import { DOOR_VOCAB, doorKit, doorType, doorTypes } from '../src/world/objects/joinery/doorKit.js'
import { ordinaryThemesFor, roomCatalogFor } from '../src/world/rooms/catalog.js'
import { resolveStepSurface } from '../src/world/stepSurface.js'
import { CATALOG_KINDS } from '../src/world/structures/catalog/engine.js'
import {
  CATALOG_STRUCTURE_ADAPTERS,
  STRUCTURE_ADAPTERS,
} from '../src/world/structures/contract.js'
import { roomCategory, worldSurfaceSet, zoneCategory } from '../src/world/surfaceSet.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const LEGACY_SNAPSHOT_PATH = resolve(
  ROOT,
  'src/world/__tests__/fixtures/legacy-families.snapshot.json'
)

// Literal on purpose: the snapshot must not depend on MAP_FAMILY_ORDER,
// which grows when the liminal families are appended.
export const SNAPSHOT_FAMILIES = Object.freeze([
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_HOTEL,
])

// Canonical, JSON-safe projection: insertion-ordered keys, typed arrays,
// Maps/Sets, functions (by name), undefined and non-finite numbers all get
// explicit tags so two different values never serialise alike.
function canon(value, stack = []) {
  if (value === undefined) return { $u: 1 }
  if (value === null) return null
  const type = typeof value
  if (type === 'number') {
    if (Object.is(value, -0)) return { $n: '-0' }
    return Number.isFinite(value) ? value : { $n: String(value) }
  }
  if (type === 'string' || type === 'boolean') return value
  if (type === 'bigint') return { $b: String(value) }
  if (type === 'function') return { $f: value.name || 'anonymous' }
  if (type === 'symbol') return { $y: String(value.description) }
  if (stack.includes(value)) return { $cycle: stack.indexOf(value) }
  const next = [...stack, value]
  if (ArrayBuffer.isView(value)) return { $t: value.constructor.name, v: Array.from(value, (x) => canon(x)) }
  if (Array.isArray(value)) return value.map((item) => canon(item, next))
  if (value instanceof Map) return { $m: [...value].map(([k, v]) => [canon(k, next), canon(v, next)]) }
  if (value instanceof Set) return { $s: [...value].map((v) => canon(v, next)) }
  const out = {}
  for (const key of Object.keys(value)) out[key] = canon(value[key], next)
  return out
}

const sha = (value) => createHash('sha256')
  .update(JSON.stringify(canon(value)))
  .digest('hex')
  .slice(0, 16)

const range = (n) => Array.from({ length: n }, (_, i) => i)
const CELL_KINDS = range(8) // CELL_OPEN..CELL_BRIDGE
const SPACE_ROLES = range(16) // SPACE_ROLE_NONE..SPACE_ROLE_LAUNDRY
const DOOR_FNS = ['egress', 'wet', 'service', 'guest', 'room', 'internal']
const DRESSING_SEED = 0x5eed
const DRESSING_COORDS = Object.freeze([
  [0, 0, 0],
  [1, 0, -1],
  [-2, 1, 3],
])
const SURFACE_SEEDS = Object.freeze([0, 1, 12345])
const EXIT_SEEDS = Object.freeze(range(10).map((i) => `legacy-exit-${i}`))
const PRIORITY_SEED = 0x51ab
const PRIORITY_REQUESTS = Object.freeze([
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0], [2, 1, -1], [-1, -1, 2],
  [3, 0, 3], [-2, 2, 0], [1, 1, 1], [-3, -1, -3], [4, 0, -2], [0, 1, 4],
])

// Title option of one family, cut out of the rendered title markup.
function titleOptionHtml(family) {
  const match = TITLE_HTML.match(new RegExp(`<option value="${family}"[^>]*>[^<]*</option>`))
  return match ? match[0] : null
}

function adapterSummary(adapter) {
  return {
    family: adapter?.family ?? null,
    kind: adapter?.kind ?? null,
    kinds: Array.isArray(adapter?.kinds) ? [...adapter.kinds] : null,
    keys: adapter && typeof adapter === 'object' ? Object.keys(adapter) : null,
  }
}

// Adapter tables are append-only: the legacy keys keep their order and the
// liminal ones are added after them. Record the legacy subsequence only.
function legacyAdapterOrders() {
  // Liminal families only ever add '<id>Catalog' kinds, so every non-catalog
  // kind and the five legacy catalog kinds form the legacy subsequence.
  const legacyCatalogKinds = new Set(SNAPSHOT_FAMILIES.map((f) => CATALOG_KINDS[f]))
  const isLegacyStructureKind = (k) =>
    legacyCatalogKinds.has(k) || !k.endsWith('Catalog')
  const pick = (table, keep) => Object.keys(table).filter(keep)
  const familyKeys = pick(FAMILY_AUDIT_ADAPTERS.families, (k) => SNAPSHOT_FAMILIES.includes(k))
  const kindKeys = pick(FAMILY_AUDIT_ADAPTERS.kinds, isLegacyStructureKind)
  const structureKeys = pick(STRUCTURE_ADAPTERS, isLegacyStructureKind)
  const catalogStructureKeys = pick(CATALOG_STRUCTURE_ADAPTERS, isLegacyStructureKind)
  const catalogKindKeys = pick(CATALOG_KINDS, (k) => SNAPSHOT_FAMILIES.includes(k))
  return {
    familyAudit: {
      families: familyKeys,
      familiesDetail: sha(familyKeys.map((k) => adapterSummary(FAMILY_AUDIT_ADAPTERS.families[k]))),
      kinds: kindKeys,
      kindsDetail: sha(kindKeys.map((k) => adapterSummary(FAMILY_AUDIT_ADAPTERS.kinds[k]))),
    },
    structureAdapters: structureKeys,
    structureAdaptersDetail: sha(structureKeys.map((k) => adapterSummary(STRUCTURE_ADAPTERS[k]))),
    catalogStructureAdapters: catalogStructureKeys,
    catalogKinds: catalogKindKeys.map((k) => [k, CATALOG_KINDS[k]]),
  }
}

// Recording 2D context: every property write and method call is logged, so
// the hash pins the decal atlas painting (plate colours, rims, art mats and
// the hotel branches) without a real canvas.
function recordingCanvas(log) {
  const gradient = () => ({ addColorStop: (...args) => log.push(['stop', ...args]) })
  const target = {
    createLinearGradient: (...args) => { log.push(['lin', ...args]); return gradient() },
    createRadialGradient: (...args) => { log.push(['rad', ...args]); return gradient() },
    measureText: (text) => { log.push(['measure', text]); return { width: String(text).length * 7 } },
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  }
  const ctx = new Proxy(target, {
    get(obj, key) {
      if (key in obj) return obj[key]
      if (typeof key !== 'string') return undefined
      return (...args) => log.push([key, ...args.map((a) => (a && typeof a === 'object' ? '[obj]' : a))])
    },
    set(obj, key, value) {
      log.push(['=', key, value && typeof value === 'object' ? '[obj]' : value])
      return true
    },
  })
  return { width: 0, height: 0, getContext: () => ctx }
}

function decalAtlasTrace(family) {
  const log = []
  const hadDocument = Object.hasOwn(globalThis, 'document')
  const previous = globalThis.document
  globalThis.document = { createElement: () => recordingCanvas(log) }
  try {
    paintDecalAtlas(family, 12345, 64)
  } finally {
    if (hadDocument) globalThis.document = previous
    else delete globalThis.document
  }
  return { calls: log.length, sha: sha(log) }
}

function dressingFor(family, config) {
  return DRESSING_COORDS.map(([cx, cy, cz]) => {
    const data = generateChunk(DRESSING_SEED, cx, cy, cz, config)
    const dressing = collectInteriorDressing(data)
    const doorways = collectDoorways(data, 0.5)
    const edges = []
    const schedules = []
    for (let line = 0; line < CHUNK; line++) {
      for (let cell = 0; cell < CHUNK; cell++) {
        if (data.passageVAt(line, cell) === PASSAGE_DOOR) {
          const e = edgeContext(data, 'v', line, cell)
          edges.push(['v', line, cell, e.fn, e.roomSide, e.partial, e.portal, e.room?.role ?? null])
          schedules.push(scheduleDoor(data, 'v', line, cell))
        }
        if (data.passageHAt(cell, line) === PASSAGE_DOOR) {
          const e = edgeContext(data, 'h', line, cell)
          edges.push(['h', line, cell, e.fn, e.roomSide, e.partial, e.portal, e.room?.role ?? null])
          schedules.push(scheduleDoor(data, 'h', line, cell))
        }
      }
    }
    return {
      at: [cx, cy, cz],
      mapFamily: data.mapFamily,
      dressing: {
        trim: sha(dressing.trim),
        props: sha(dressing.props),
        signs: sha(dressing.signs),
        decals: sha(dressing.decals),
        counts: [
          dressing.trim?.length ?? null,
          dressing.props?.length ?? null,
          dressing.signs?.length ?? null,
          dressing.decals?.length ?? null,
        ],
      },
      doorways: { count: doorways.length, sha: sha(doorways) },
      doorKits: sha(doorways.map((d) => doorKit(data.mapFamily, d))),
      doorFunction: { count: edges.length, sha: sha(edges) },
      doorSchedule: sha(schedules),
    }
  })
}

function doorVocabFor(family) {
  const types = doorTypes(family)
  const probes = []
  for (const fn of DOOR_FNS) {
    for (const role of [SPACE_ROLE_NONE, SPACE_ROLE_LAUNDRY]) {
      const door = { fn, role }
      probes.push([fn, role, doorType(family, door), sha(doorKit(family, door))])
    }
  }
  const schedules = range(8).map((key) => doorSchedule(12345, family, key * 977))
  const scheduledKits = schedules.map((schedule) =>
    DOOR_FNS.map((fn) => doorKit(family, { fn, role: 0, schedule }))
  )
  return {
    vocab: sha(DOOR_VOCAB[family] ?? null),
    types,
    probes: sha(probes),
    schedules: sha(schedules),
    scheduledKits: sha(scheduledKits),
  }
}

function signPlatesFor(family) {
  const [first, count] = DECAL_KINDS.sign
  const plates = signPlates(family)
  return {
    table: sha(SIGN_PLATES[family] ?? null),
    resolved: sha(plates),
    cells: sha(plates.map((p) => signCell(p.id, family))),
    atCells: sha(range(count + 2).map((i) => signPlateAt(first - 1 + i, family))),
    byRole: sha(SPACE_ROLES.map((role) => [signIdFor(role, family), signCellFor(role, family)])),
  }
}

function stepSurfaceFor(family) {
  const out = []
  for (const cellKind of CELL_KINDS) {
    for (const spaceRole of SPACE_ROLES) out.push(resolveStepSurface({ family, cellKind, spaceRole }))
  }
  return {
    grid: sha(out),
    open: resolveStepSurface({ family, cellKind: CELL_OPEN }),
    bridge: resolveStepSurface({ family, cellKind: CELL_BRIDGE }),
  }
}

function audioFor(family) {
  const space = Object.getOwnPropertyDescriptor(AudioBus.prototype, '_space')?.get
  const pa = Object.getOwnPropertyDescriptor(MusicPlayer.prototype, '_pa')?.get
  return {
    spaceRow: sha(FAMILY_SPACES[family] ?? null),
    paRow: sha(FAMILY_PA[family] ?? null),
    space: space ? sha(space.call({ family })) : null,
    pa: pa ? sha(pa.call({ family })) : null,
  }
}

// A config split into its profile-free body and the legacy profiles: the
// liminal profiles appended later must not move either hash.
// config.version is WORLD_GEN_VERSION, which repin bumps (28 -> 29): fold the
// live version back to the pinned 28 (key order kept by the spread) so the
// pre-refactor baseline survives the bump, like kinds-digest does.
export const SNAPSHOT_CONFIG_VERSION = 28

export function legacyConfigView(config) {
  const pinned = config.version === WORLD_GEN_VERSION ? { ...config, version: SNAPSHOT_CONFIG_VERSION } : config
  const { mapFamily, ...rest } = pinned
  const { profiles, ...selection } = mapFamily
  return {
    body: sha({ ...rest, mapFamily: selection }),
    profiles: sha(Object.fromEntries(SNAPSHOT_FAMILIES.map((f) => [f, profiles[f]]))),
  }
}

function configFor(family) {
  const config = worldConfigForFamily(family)
  const view = legacyConfigView(config)
  const orOffice = worldConfigForFamilyOrOffice(family)
  return {
    config: view.body,
    profiles: view.profiles,
    ownProfile: canon(config.mapFamily.profiles[family]),
    resolved: sha(resolveMapFamily(config)),
    orOffice: { family: orOffice.family, fellBack: orOffice.fellBack, config: legacyConfigView(orOffice.config) },
    explore: legacyConfigView(exploreConfigForFamily(family)),
    roomCatalog: sha(roomCatalogFor(config)),
    ordinaryThemes: sha(ordinaryThemesFor(family)),
  }
}

function exitPlacementsFor(family) {
  const config = worldConfigForFamily(family)
  return EXIT_SEEDS.map((seedText) => {
    const level = 1
    const exit = createExitPlacement(seedText, level, hashStr(`${seedText}#${level}`), config)
    return [exit.cx, exit.cy, exit.cz, exit.lx, exit.lz]
  })
}

function priorityFor(family) {
  const config = worldConfigForFamily(family)
  return PRIORITY_REQUESTS.map(([cx, cy, cz]) => {
    const r = prioritizeRequest({ cx, cy, cz, key: `${cx},${cy},${cz}` }, PRIORITY_SEED, config, 0, 0, 0)
    return [cx, cy, cz, r.d, r.floorPriority, r.xzTie]
  })
}

function spawnConstants() {
  const cm = new ChunkManager({ add() {} }, 1, null, null)
  return {
    SPAWN_WORLD,
    HUB_CELL,
    CELL,
    CHUNK,
    CHUNK_WORLD,
    EYE_H,
    EXIT_FLOORS: [...EXIT_FLOORS],
    EXIT_REACH,
    clearRadius: DEFAULT_WORLD_CONFIG.exit?.clearRadius ?? null,
    clearings: canon(cm.clearings),
  }
}

export function computeLegacySnapshot() {
  const families = {}
  for (const family of SNAPSHOT_FAMILIES) {
    const config = worldConfigForFamily(family)
    families[family] = {
      note: familyNote(family),
      titleOption: titleOptionHtml(family),
      requiresVoidSafety: requiresVoidSafety(family),
      palette: sha(familyPalette(family)),
      surfaceSets: Object.fromEntries(
        SURFACE_SEEDS.map((seed) => [seed, sha(worldSurfaceSet(family, seed))])
      ),
      roomCategory: sha(SPACE_ROLES.map((role) => roomCategory(family, role))),
      zoneCategory: sha(CELL_KINDS.map((kind) => SPACE_ROLES.map((role) => zoneCategory(kind, role, family)))),
      step: stepSurfaceFor(family),
      doors: doorVocabFor(family),
      signPlates: signPlatesFor(family),
      leafFinish: canon(LEAF_FINISH[family] ?? LEAF_FINISH.default),
      audio: audioFor(family),
      mapInspectColor: STRUCTURE_FAMILY_COLORS[family] ?? null,
      decalAtlas: decalAtlasTrace(family),
      config: configFor(family),
      chunks: dressingFor(family, config),
      exitPlacements: exitPlacementsFor(family),
      priority: sha(priorityFor(family)),
    }
  }
  // Round-trip through JSON so the value equals the parsed fixture under
  // toEqual (Object.is would tell a live -0 from the stored 0).
  return JSON.parse(JSON.stringify({
    schema: 1,
    families,
    adapters: legacyAdapterOrders(),
    spawn: spawnConstants(),
  }))
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  const snapshot = computeLegacySnapshot()
  const text = `${JSON.stringify(snapshot, null, 1)}\n`
  if (process.argv.includes('--write')) {
    mkdirSync(dirname(LEGACY_SNAPSHOT_PATH), { recursive: true })
    writeFileSync(LEGACY_SNAPSHOT_PATH, text)
    console.log(`wrote ${LEGACY_SNAPSHOT_PATH}`)
  } else if (process.argv.includes('--check')) {
    const pinned = readFileSync(LEGACY_SNAPSHOT_PATH, 'utf8')
    if (pinned === text) {
      console.log('legacy-families snapshot: identical')
    } else {
      const before = JSON.parse(pinned)
      const diffs = []
      const walk = (a, b, path) => {
        if (JSON.stringify(a) === JSON.stringify(b)) return
        if (a && b && typeof a === 'object' && typeof b === 'object') {
          for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], `${path}.${key}`)
        } else diffs.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`)
      }
      walk(before, snapshot, '$')
      console.error(`legacy-families snapshot: ${diffs.length} difference(s)`)
      for (const line of diffs) console.error(`  ${line}`)
      process.exitCode = 1
    }
  } else {
    process.stdout.write(text)
  }
}
