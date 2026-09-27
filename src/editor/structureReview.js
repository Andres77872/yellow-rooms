import { describeCatalogStructure, isCatalogStructure } from '../world/structures/catalog/engine.js'
import { CHUNK, cIdx } from '../world/constants.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_VOID,
  COLUMN_FURNITURE,
  WALL_RAIL,
  WALL_WINDOW,
} from '../world/mapTypes.js'
import { auditLayeredPatch } from '../world/audit.js'
import { generateChunk } from '../world/generate.js'
import { worldConfigForFamilyOrOffice } from '../world/mapFamily.js'
import {
  STRUCTURE_KIND_LATTICE,
  STRUCTURE_KIND_OFFICE,
  STRUCTURE_KIND_TOWER,
  structureAt,
  structureFamily,
  structureKind,
} from '../world/structures/contract.js'
import { cellWalkable, holeMasks } from './holeMasks.js'
import { graphComponents, walkGraph } from './simulate.js'

// Structure review: the DOM-free half of the editor's multilevel structure
// section. Canonical tall structures (Office/Hotel atria, Tower skybridges,
// Lattice districts) are global descriptors spanning several chunks AND
// several floors; ChunkData only ever holds one floor of one chunk plus the
// two slab slices bounding it. Every helper here therefore reasons about the
// complete volume — participants × [baseCy..topCy] — and reports partial
// volumes as such instead of mistaking a clipped bake for a broken world.

export const structureKey = (s) => `${s.id}:${s.baseCy}:${s.topCy}`

// --- volume geometry ---------------------------------------------------------

// Chunk-space box of the volume, optionally grown by `ring` context chunks
// on every horizontal side. Vertical extent is always the exact band: slab
// halves outside it belong to other contracts.
export function structureChunkBox(s, ring = 0) {
  const xs = s.participants.map((p) => p.cx)
  const zs = s.participants.map((p) => p.cz)
  return {
    x0: Math.min(...xs) - ring,
    x1: Math.max(...xs) + ring,
    z0: Math.min(...zs) - ring,
    z1: Math.max(...zs) + ring,
    y0: s.baseCy,
    y1: s.topCy,
  }
}

// Floor-major chunk coordinates. Ring 0 is exactly the participant set (the
// canonical volume); a ring adds the surrounding context chunks.
export function structureChunkCoords(s, ring = 0) {
  const out = []
  const box = structureChunkBox(s, ring)
  const participant = new Set(s.participants.map((p) => `${p.cx},${p.cz}`))
  for (let cy = box.y0; cy <= box.y1; cy++) {
    for (let cz = box.z0; cz <= box.z1; cz++) {
      for (let cx = box.x0; cx <= box.x1; cx++) {
        if (ring === 0 && !participant.has(`${cx},${cz}`)) continue
        out.push({ cx, cy, cz })
      }
    }
  }
  return out
}

export function structureCoverage(map, s) {
  const expected = structureChunkCoords(s, 0)
  const missing = []
  const foreign = []
  for (const c of expected) {
    const d = map.chunkAt(c.cx, c.cy, c.cz)
    if (!d) missing.push(c)
    // Authored volumes never claim data.structure (they are not planner
    // output); presence of their chunks is their whole coverage.
    else if (!s.authored && (!d.structure || structureKey(d.structure) !== structureKey(s))) foreign.push(c)
  }
  return {
    expected: expected.length,
    present: expected.length - missing.length,
    complete: missing.length === 0 && foreign.length === 0,
    missing,
    foreign,
  }
}

// --- discovery ----------------------------------------------------------------

// Canonical descriptors intersecting a chunk box, straight from the planners
// (never from generated ChunkData), deduped and ordered by band then id.
export function discoverStructures(seed, config, { x0, x1, z0, z1, y0, y1 }) {
  const found = new Map()
  for (let cy = y0; cy <= y1; cy++) {
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const s = structureAt(seed, cx, cz, cy, config)
        if (s?.hasRoom === true) found.set(structureKey(s), s)
      }
    }
  }
  return [...found.values()].sort((a, b) => a.baseCy - b.baseCy || a.id - b.id)
}

// Descriptors already carried by document chunks (baked or imported).
export function documentStructures(map) {
  const found = new Map()
  for (const d of map.chunks.values()) {
    const s = d.structure
    if (s?.hasRoom === true && Array.isArray(s.participants)) {
      const key = structureKey(s)
      if (!found.has(key)) found.set(key, s)
    }
  }
  return [...found.values()].sort((a, b) => a.baseCy - b.baseCy || a.id - b.id)
}

// Structures a document only partially holds: a bake box that clips a tall
// volume leaves orphan slab halves until the whole volume is loaded.
export function clippedStructures(map) {
  return documentStructures(map)
    .map((structure) => ({ structure, coverage: structureCoverage(map, structure) }))
    .filter(({ coverage }) => !coverage.complete)
}

// --- anatomy --------------------------------------------------------------------

export function structureVariant(s) {
  if (s.authored) return s.label ?? s.template
  if (isCatalogStructure(s)) return s.label ?? s.type
  const kind = structureKind(s)
  if (kind === STRUCTURE_KIND_TOWER) return s.architecture?.form ?? 'tower'
  if (kind === STRUCTURE_KIND_LATTICE) return 'lattice'
  return s.kind === 'openVoid' ? 'open shaft' : 'bridged atrium'
}

export function summarizeStructure(s) {
  const b = s.globalBounds
  const lines = []
  const kind = s.authored ? 'authored' : structureKind(s)
  if (s.authored) {
    lines.push(`authored ${s.template} · ${s.parts.map((p) => p.type).join(' + ')}`)
  } else if (isCatalogStructure(s)) {
    lines.push(...describeCatalogStructure(s).slice(1))
  } else if (kind === STRUCTURE_KIND_OFFICE) {
    lines.push(`axis ${s.bridgeAxis} · span ${s.longSpan}×${s.shortSpan}`)
    lines.push(`bridges ${s.bridgeLevels?.length ? s.bridgeLevels.join(',') : 'none'}`)
  } else if (kind === STRUCTURE_KIND_TOWER) {
    lines.push(`axis ${s.bridgeAxis} · bay ${s.architecture?.columnBay ?? '?'} · deck cy${s.decks?.[0]?.levelCy ?? '?'}`)
    lines.push(`stairs ${s.verticalLinks?.length ?? 0} · sockets ${s.landmarkSockets?.length ?? 0}`)
  } else if (kind === STRUCTURE_KIND_LATTICE) {
    const roles = {}
    for (const e of s.edges ?? []) roles[e.role] = (roles[e.role] ?? 0) + 1
    lines.push(`anchors ${s.anchors?.length ?? 0} · stairs ${s.verticalLinks?.length ?? 0}`)
    lines.push(Object.entries(roles).map(([r, n]) => `${r} ${n}`).join(' · '))
  }
  return {
    key: structureKey(s),
    id: s.id,
    family: s.authored ? 'authored' : structureFamily(s),
    kind,
    sizeClass: s.sizeClass ?? (s.authored ? 'authored' : 'landmark'),
    type: s.type ?? null,
    variant: structureVariant(s),
    baseCy: s.baseCy,
    topCy: s.topCy,
    levels: s.topCy - s.baseCy + 1,
    participants: s.participants.length,
    footprint: b ? `${b.x1 - b.x0 + 1}×${b.z1 - b.z0 + 1}` : '?',
    bounds: b,
    lines,
  }
}

// One row per storey from the descriptor alone: what the planner promised
// this floor is. measureStructureLevel reports what the document holds.
export function structureLevels(s) {
  const levels = []
  for (let cy = s.baseCy; cy <= s.topCy; cy++) {
    levels.push({ cy, offset: cy - s.baseCy, role: '', notes: [] })
  }
  const at = (cy) => levels[cy - s.baseCy] ?? null
  if (s.authored) {
    for (const L of levels) L.role = s.template
    for (const part of s.parts ?? []) {
      if (part.type === 'atrium') {
        const d = part.descriptor
        for (let cy = d.baseCy; cy <= d.topCy; cy++) {
          const L = at(cy)
          if (!L) continue
          L.role = cy === d.baseCy ? 'atrium hall' : d.kind === 'openVoid' && cy === d.topCy ? 'overlook' : 'gallery'
          const deck = d.decks.find((k) => k.levelCy === cy)
          if (deck) L.notes.push(`deck ${d.bridgeAxis === 'x' ? 'gz' : 'gx'}=${deck.globalBridgeLine}`)
        }
      } else if (part.type === 'stairwell') {
        for (const f of part.plan.flights) {
          at(f.lowerCy)?.notes.push('flight ↑')
          at(f.lowerCy + 1)?.notes.push('flight ↓')
        }
        for (let cy = part.plan.baseCy; cy <= part.plan.topCy; cy++) if (at(cy) && at(cy).role === s.template) at(cy).role = 'stair core'
      } else {
        const L = at(part.cy ?? s.baseCy)
        if (L) L.notes.push(part.type === 'wing' ? `wing · anomaly ${part.anomaly} @ room ${part.anomalyIndex + 1}` : `${part.rooms.length} rooms`)
      }
    }
    return levels
  }
  if (isCatalogStructure(s)) {
    for (const L of levels) {
      const level = s.levels[L.offset]
      const voids = level.voids.reduce((n, r) => n + (r.x1 - r.x0 + 1) * (r.z1 - r.z0 + 1), 0)
      const decks = level.bridges.length
      L.role = L.offset === 0
        ? (s.columns.length ? 'pier hall' : 'ground hall')
        : voids === 0 ? 'floor' : decks ? `gallery + ${decks} deck${decks > 1 ? 's' : ''}` : 'gallery'
      if (voids) L.notes.push(`${voids} void cells`)
      if (s.deviation?.levelCy === L.cy) L.notes.push(`deviation: ${s.deviation.kind}`)
    }
    if (s.core) for (const L of levels) L.notes.push(`${s.core.enclosed ? 'enclosed' : 'open'} core`)
    for (const link of s.verticalLinks ?? []) {
      at(link.lowerCy)?.notes.push(`stair ↑ ${link.cx},${link.cz}`)
    }
    return levels
  }
  const kind = structureKind(s)
  if (kind === STRUCTURE_KIND_OFFICE) {
    for (const L of levels) L.role = L.cy === s.baseCy ? 'atrium hall' : 'gallery'
    if (s.kind === 'openVoid' && at(s.topCy)) at(s.topCy).role = 'overlook'
    const lineAxis = s.bridgeAxis === 'x' ? 'gz' : 'gx'
    for (const deck of s.decks ?? []) {
      const L = at(deck.levelCy)
      if (!L) continue
      L.role += ' + bridge'
      L.notes.push(`deck ${lineAxis}=${deck.globalBridgeLine}`)
    }
  } else if (kind === STRUCTURE_KIND_TOWER) {
    const roles = ['ground court', 'skybridge', 'upper gallery']
    for (const L of levels) L.role = roles[L.offset] ?? 'level'
    for (const link of s.verticalLinks ?? []) {
      at(link.lowerCy)?.notes.push(`stair ↑ in ${link.cx},${link.cz}`)
      at(link.lowerCy + 1)?.notes.push(`stair ↓ from cy${link.lowerCy}`)
    }
    for (const socket of s.landmarkSockets ?? []) {
      at(socket.cy)?.notes.push(`${socket.kind} @${socket.gx},${socket.gz}`)
    }
  } else if (kind === STRUCTURE_KIND_LATTICE) {
    const anchorById = new Map((s.anchors ?? []).map((a) => [a.id, a]))
    for (const L of levels) {
      L.role = L.offset === 0 ? 'street' : `deck ${L.offset}`
      const anchors = (s.anchors ?? []).filter((a) => a.levelCy === L.cy)
      L.notes.push(`${anchors.length} anchors`)
      const exposed = anchors.filter((a) => a.exposureM != null).length
      if (exposed) L.notes.push(`${exposed} exposed`)
      const roles = {}
      for (const e of s.edges ?? []) {
        const a = anchorById.get(e.a)
        const b = anchorById.get(e.b)
        if (a?.levelCy === L.cy && b?.levelCy === L.cy) roles[e.role] = (roles[e.role] ?? 0) + 1
      }
      const spans = Object.entries(roles).map(([r, n]) => `${r} ${n}`).join(' ')
      if (spans) L.notes.push(spans)
    }
    for (const link of s.verticalLinks ?? []) {
      at(link.lowerCy)?.notes.push(`stair ↑ ${link.cx},${link.cz}`)
    }
  }
  return levels
}

// What the document actually holds on one storey of the volume.
export function measureStructureLevel(map, s, cy) {
  const stats = {
    cy, chunks: 0, expected: s.participants.length,
    floorHoles: 0, ceilHoles: 0, bridge: 0, atrium: 0, void: 0,
    rails: 0, windows: 0, lethal: 0, lethalInvalid: 0,
    stairsUp: 0, stairsDown: 0, lamps: 0, lampsLit: 0, furniture: 0,
    walkable: 0, hasDown: false, hasUp: false,
  }
  for (const p of s.participants) {
    const d = map.chunkAt(p.cx, cy, p.cz)
    if (!d) continue
    stats.chunks++
    const m = holeMasks(d)
    stats.floorHoles += m.floorCount
    stats.ceilHoles += m.ceilCount
    for (let i = 0; i < CHUNK * CHUNK; i++) {
      const kind = d.cellKind[i]
      if (kind === CELL_BRIDGE) stats.bridge++
      else if (kind === CELL_ATRIUM) stats.atrium++
      else if (kind === CELL_VOID) stats.void++
      if (d.wallFeatureV[i] === WALL_RAIL && d.wallV[i]) stats.rails++
      if (d.wallFeatureH[i] === WALL_RAIL && d.wallH[i]) stats.rails++
      if (d.wallFeatureV[i] === WALL_WINDOW && d.wallV[i]) stats.windows++
      if (d.wallFeatureH[i] === WALL_WINDOW && d.wallH[i]) stats.windows++
      if (m.lethal[i] === 1) stats.lethal++
      else if (m.lethal[i] === 2) stats.lethalInvalid++
    }
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) if (cellWalkable(d, lx, lz)) stats.walkable++
    }
    if (d.stairUp) stats.stairsUp++
    if (d.stairDown) stats.stairsDown++
    stats.lamps += d.lamps.length
    stats.lampsLit += d.lamps.filter((l) => l.lit).length
    stats.furniture += d.furniture.length
    if (d.structureDown) stats.hasDown = true
    if (d.structureUp) stats.hasUp = true
  }
  return stats
}

// --- connectivity -----------------------------------------------------------------

// Walk graph over a source inside a chunk box (simulate.js walkGraph, the
// layered audit's own graph: walkable cells, owner-resolved thin walls, a
// missing chunk blocks, matched stairs as the only vertical edge). Components
// keep a representative cell so the UI can jump to a stranded pocket.
// `vertical: false` restricts the walk to planar steps.
export function walkComponents(map, box, { vertical = true } = {}) {
  const graph = walkGraph(map, box, { vertical })
  return { walkable: graph.nodes.size, components: graphComponents(graph) }
}

// Which connectivity each family actually promises inside its own volume.
// Office/Hotel atria carry no stairs of their own — their floors join the
// world through ordinary slab stairs anywhere in the district — so only each
// storey's planar walk is a real invariant. Tower and Lattice volumes own
// their vertical links, so the whole volume must be one component.
export function connectivityPolicy(s) {
  if (s.authored) return s.parts?.some((p) => p.type === 'stairwell') ? 'volume' : 'perFloor'
  // Catalog volumes (v26) carry a flight on every slab: one walk.
  if (isCatalogStructure(s)) return 'volume'
  const kind = structureKind(s)
  return kind === STRUCTURE_KIND_TOWER || kind === STRUCTURE_KIND_LATTICE ? 'volume' : 'perFloor'
}

// --- audit ------------------------------------------------------------------------

const locateChunk = (cx, cy, cz) => ({ cx, cy, cz, gx: cx * CHUNK + 7, gz: cz * CHUNK + 7 })

function flattenAuditDetails(details, s = null) {
  const issues = []
  const push = (code, text, loc, severity = 'error') => issues.push({ severity, code, text, ...loc })
  for (const e of details.mismatchedDescriptors ?? []) {
    push('stair-mismatch', `stair halves disagree over slab ${e.cy}→${e.cy + 1}`, locateChunk(e.cx, e.cy, e.cz))
  }
  for (const e of details.holeMismatches ?? []) {
    push(
      'hole-mismatch',
      `slab ${e.cy}→${e.cy + 1}: ceiling ${e.ceiling ? 'open' : 'solid'} below, floor ${e.floor ? 'open' : 'solid'} above`,
      { cx: e.cx, cy: e.cy, cz: e.cz, lx: e.lx, lz: e.lz, gx: e.cx * CHUNK + e.lx, gz: e.cz * CHUNK + e.lz }
    )
  }
  for (const e of details.orphanedHalves ?? []) {
    push('stair-orphan', `orphan stair half (${e.half})`, locateChunk(e.cx, e.cy, e.cz))
  }
  for (const e of details.invalidCanonicalLinks ?? []) {
    push('stair-link', `stair link: ${e.reasons.join(', ')}`, locateChunk(e.cx, e.cy, e.cz))
  }
  for (const e of details.mismatchedMultilevelDescriptors ?? []) {
    push('slice-mismatch', `structure slices disagree over slab ${e.cy}→${e.cy + 1}`, locateChunk(e.cx, e.cy, e.cz))
  }
  for (const e of details.orphanedMultilevelHalves ?? []) {
    push('slice-orphan', `orphan structure slice (${e.half})`, locateChunk(e.cx, e.cy, e.cz))
  }
  for (const e of details.invalidMultilevelRooms ?? []) {
    push('slice-raster', `#${e.id}: ${e.reasons.join(', ')}`, locateChunk(e.cx, e.cy, e.cz))
  }
  for (const e of details.mismatchedLethalVoidDescriptors ?? []) {
    push('lethal-mismatch', `lethal void: ${e.reasons.join(', ')}`, locateChunk(e.cx, e.cy, e.cz))
  }
  for (const e of details.orphanedLethalVoidHalves ?? []) {
    push('lethal-orphan', `orphan lethal half (${e.half})`, locateChunk(e.cx, e.cy, e.cz))
  }
  for (const e of details.strayWallFeatures ?? []) {
    push('stray-feature', `${e.count} window/rail edges outside any structure surface`, locateChunk(e.cx, e.cy, e.cz), 'warn')
  }
  // The group roll-up repeats reasons that also arrive as located entries
  // (missing slices, closed seams); keep only what nothing else reports.
  const LOCATED_ROLLUP = new Set(['missing loaded participant slice', 'closed bridge seam'])
  for (const e of details.invalidMultilevelStructures ?? []) {
    const reasons = e.reasons.filter((r) => !LOCATED_ROLLUP.has(r))
    if (!reasons.length) continue
    const b = s?.id === e.id ? s.globalBounds : null
    const loc = b
      ? { cy: s.baseCy, gx: Math.floor((b.x0 + b.x1) / 2), gz: Math.floor((b.z0 + b.z1) / 2) }
      : {}
    push('structure', `#${e.id}: ${reasons.join(', ')}`, loc)
  }
  for (const e of details.missingMultilevelSlices ?? []) {
    push('slice-missing', `#${e.id}: missing slice over slab ${e.cy}→${e.cy + 1}`, locateChunk(e.cx, e.cy, e.cz))
  }
  for (const e of details.closedBridgeSeams ?? []) {
    const loc = e.axis === 'v'
      ? { cy: e.levelCy, gx: e.line, gz: e.cell }
      : { cy: e.levelCy, gx: e.cell, gz: e.line }
    push('bridge-seam', `#${e.id}: bridge deck walled at its chunk seam`, loc)
  }
  for (const e of details.familyAuditFailures ?? []) {
    push('family', `${e.family ?? '—'}:${e.kind ?? '—'} ${e.reason}`, {})
  }
  return issues
}

const STRUCTURAL_COUNTERS = [
  'mismatchedDescriptors', 'holeMismatches', 'orphanedHalves', 'invalidCanonicalLinks',
  'mismatchedMultilevelDescriptors', 'orphanedMultilevelHalves', 'invalidMultilevelRooms',
  'mismatchedLethalVoidDescriptors', 'orphanedLethalVoidHalves', 'strayWallFeatures',
  'invalidMultilevelStructures', 'missingMultilevelSlices', 'closedBridgeSeams',
  'familyAdapterFailures', 'kindAdapterFailures', 'familyDescriptorFailures',
]

function structuralOk(audit) {
  return STRUCTURAL_COUNTERS.every((k) => !audit[k])
}

// Review one structure as the object it is: the full participant volume
// (plus an optional context ring), the shared layered audit for every
// descriptor/raster/slab contract, and the family's own connectivity rule.
export function auditStructure(map, s, { ring = 0 } = {}) {
  const coverage = structureCoverage(map, s)
  const box = structureChunkBox(s, ring)
  const audit = auditLayeredPatch(
    (cx, cy, cz) => map.chunkAt(cx, cy, cz),
    box.x0, box.y0, box.z0,
    box.x1 - box.x0 + 1, box.y1 - box.y0 + 1, box.z1 - box.z0 + 1
  )
  const issues = flattenAuditDetails(audit.details, s)
  for (const c of coverage.missing) {
    issues.unshift({ severity: 'error', code: 'volume-missing', text: `volume chunk ${c.cx},${c.cy},${c.cz} not in document`, ...locateChunk(c.cx, c.cy, c.cz) })
  }
  for (const c of coverage.foreign) {
    issues.unshift({ severity: 'error', code: 'volume-foreign', text: `chunk ${c.cx},${c.cy},${c.cz} carries another descriptor`, ...locateChunk(c.cx, c.cy, c.cz) })
  }

  const policy = connectivityPolicy(s)
  // Connectivity is judged on the canonical volume only: context ring chunks
  // join the world through routes outside any finite box.
  const coreBox = structureChunkBox(s, 0)
  const volume = walkComponents(map, coreBox)
  const floors = []
  for (let cy = s.baseCy; cy <= s.topCy; cy++) {
    const planar = walkComponents(map, { ...coreBox, y0: cy, y1: cy }, { vertical: false })
    floors.push({ cy, walkable: planar.walkable, components: planar.components })
  }
  let connected
  if (policy === 'volume') {
    connected = volume.components.length <= 1
    for (const comp of volume.components.slice(1)) {
      issues.push({
        severity: 'error', code: 'stranded',
        text: `stranded pocket: ${comp.size} cells on cy ${comp.floors.join(',')}`,
        cy: comp.sample.cy, gx: comp.sample.gx, gz: comp.sample.gz,
      })
    }
  } else {
    connected = floors.every((f) => f.components.length <= 1)
    for (const f of floors) {
      for (const comp of f.components.slice(1)) {
        issues.push({
          severity: 'error', code: 'stranded',
          text: `cy ${f.cy}: ${comp.size}-cell pocket cut off from the floor`,
          cy: comp.sample.cy, gx: comp.sample.gx, gz: comp.sample.gz,
        })
      }
    }
  }

  const structural = structuralOk(audit)
  return {
    ok: coverage.complete && structural && connected,
    complete: coverage.complete,
    structural,
    connected,
    policy,
    ring,
    box,
    coverage,
    volume: { walkable: volume.walkable, components: volume.components.length },
    floors: floors.map((f) => ({ cy: f.cy, walkable: f.walkable, components: f.components.length })),
    counts: {
      chunks: audit.chunks,
      slabs: audit.slabs,
      stairLinks: audit.canonicalLinks,
      slicePairs: audit.multilevelPairs,
      lethalPairs: audit.lethalVoidPairs,
    },
    lattice: audit.familyAudit?.latticeMetrics ?? null,
    issues,
  }
}

// Whole-document layered audit (every stored floor), for maps that mix
// structures, stairs and hand edits. Connectivity is reported per floor only:
// a finite document is a sample of an infinite world.
export function auditDocument(map) {
  const b = map.bounds()
  if (!b) return { ok: true, issues: [], chunks: 0, floors: [] }
  const box = { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0: b.y0, y1: b.y1 }
  const audit = auditLayeredPatch(
    (cx, cy, cz) => map.chunkAt(cx, cy, cz),
    box.x0, box.y0, box.z0,
    box.x1 - box.x0 + 1, box.y1 - box.y0 + 1, box.z1 - box.z0 + 1
  )
  const issues = flattenAuditDetails(audit.details)
  for (const { structure, coverage } of clippedStructures(map)) {
    issues.unshift({
      severity: 'warn', code: 'structure-clipped',
      text: `#${structure.id} clipped: ${coverage.present}/${coverage.expected} volume chunks`,
      cy: structure.baseCy,
      gx: Math.floor((structure.globalBounds.x0 + structure.globalBounds.x1) / 2),
      gz: Math.floor((structure.globalBounds.z0 + structure.globalBounds.z1) / 2),
    })
  }
  const floors = []
  for (const cy of map.floors()) {
    const planar = walkComponents(map, { ...box, y0: cy, y1: cy }, { vertical: false })
    floors.push({ cy, walkable: planar.walkable, components: planar.components.length })
    for (const comp of planar.components.slice(1)) {
      issues.push({
        severity: 'warn', code: 'floor-pocket',
        text: `cy ${cy}: ${comp.size}-cell pocket (planar; may join via stairs)`,
        cy, gx: comp.sample.gx, gz: comp.sample.gz,
      })
    }
  }
  return {
    ok: structuralOk(audit) && issues.every((i) => i.severity !== 'error'),
    structural: structuralOk(audit),
    chunks: audit.chunks,
    floors,
    counts: { slabs: audit.slabs, stairLinks: audit.canonicalLinks, slicePairs: audit.multilevelPairs },
    issues,
  }
}

// --- drift against the generator ----------------------------------------------------

const DIFF_RASTERS = [
  ['cellKind', 'cell'], ['spaceRole', 'cell'], ['spaceId', 'cell'], ['cols', 'cell'],
  ['wallV', 'edge'], ['passageV', 'edge'], ['wallFeatureV', 'edge'],
  ['wallH', 'edge'], ['passageH', 'edge'], ['wallFeatureH', 'edge'],
]
const DESCRIPTOR_FIELDS = [
  'stairUp', 'stairDown', 'structure', 'structureUp', 'structureDown',
  'lethalVoidUp', 'lethalVoidDown', 'sewerDescriptor',
]

// Records compare at the precision the document can hold: .yrmap stores
// furniture centres/extents as float32, so a reloaded map must not read as
// drifted from float64 generator output. Lamps keep only {lx, lz, lit}.
const f32 = (v) => Math.fround(v)
const lampKey = (l) => `${l.lx},${l.lz},${l.lit ? 1 : 0}`
const furnitureKey = (f) =>
  `${f.kind},${f.lx},${f.lz},${f32(f.x)},${f32(f.z)},${f32(f.w)},${f32(f.d)},${f.facing}`

// Regenerate each listed chunk from the document's seed/family and compare.
// Structure-owned cells (slab openings, bridges, rails) that drifted are
// flagged separately: those are the edits that can break a tall volume.
export function diffAgainstGenerated(map, coords, { seed = map.meta.seed, config = null } = {}) {
  const cfg = config ?? worldConfigForFamilyOrOffice(map.meta.family).config
  const cells = []
  let compared = 0
  let changedChunks = 0
  let structural = 0
  const descriptorDrift = []
  for (const { cx, cy, cz } of coords) {
    const d = map.chunkAt(cx, cy, cz)
    if (!d) continue
    compared++
    const g = generateChunk(seed, cx, cy, cz, cfg)
    const touched = new Map() // cell index -> Set(field)
    const note = (i, field) => {
      let set = touched.get(i)
      if (!set) touched.set(i, (set = new Set()))
      set.add(field)
    }
    for (const [field] of DIFF_RASTERS) {
      const a = d[field]
      const b = g[field]
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) note(i, field)
    }
    const lamps = (x) => new Map(x.lamps.map((l) => [cIdx(l.lx, l.lz), lampKey(l)]))
    const la = lamps(d)
    const lb = lamps(g)
    for (const i of new Set([...la.keys(), ...lb.keys()])) if (la.get(i) !== lb.get(i)) note(i, 'lamp')
    const furn = (x) => new Map(x.furniture.map((f) => [cIdx(f.lx, f.lz), furnitureKey(f)]))
    const fa = furn(d)
    const fb = furn(g)
    for (const i of new Set([...fa.keys(), ...fb.keys()])) if (fa.get(i) !== fb.get(i)) note(i, 'furniture')
    for (const field of DESCRIPTOR_FIELDS) {
      if (JSON.stringify(d[field] ?? null) !== JSON.stringify(g[field] ?? null)) {
        descriptorDrift.push({ cx, cy, cz, field })
      }
    }
    if (touched.size) changedChunks++
    const m = holeMasks(d)
    for (const [i, fields] of touched) {
      const lx = i % CHUNK
      const lz = Math.floor(i / CHUNK)
      const owned = m.floor[i] || m.ceil[i] || m.stair[i] ||
        d.cellKind[i] === CELL_BRIDGE || g.cellKind[i] === CELL_BRIDGE ||
        fields.has('wallFeatureV') || fields.has('wallFeatureH') ||
        (fields.has('cols') && d.cols[i] !== COLUMN_FURNITURE && g.cols[i] !== COLUMN_FURNITURE)
      if (owned) structural++
      cells.push({
        cx, cy, cz, lx, lz,
        gx: cx * CHUNK + lx, gz: cz * CHUNK + lz,
        fields: [...fields], structural: !!owned,
      })
    }
  }
  return { compared, changedChunks, cells, structural, descriptorDrift }
}
