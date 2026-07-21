// Pure (DOM-free) inspection helpers for the world debug map: structure
// selection/audit-box math, panel formatters, and the family palettes. Keeping
// them out of WorldMapTool.js lets vitest cover every string and color rule
// without a canvas.
import { CHUNK, ZONE_OFFICE, ZONE_PILLARS, ZONE_SEWER, ZONE_WAREHOUSE } from '../world/constants.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  CELL_ROOM,
  CELL_STAIR,
  CELL_VOID,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  SPACE_ROLE_ARCHIVE,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_COPY,
  SPACE_ROLE_LIBRARY,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_NONE,
  SPACE_ROLE_OFFICE,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
} from '../world/mapTypes.js'
import { structureKind } from '../world/structures/contract.js'
import { structureAdapterFor } from '../world/structures/contract.js'
import { worldConfigForFamilyOrOffice } from '../world/mapFamily.js'
import { TOWER_STRUCTURE_KIND } from '../world/structures/tower.js'
import { LATTICE_STRUCTURE_KIND } from '../world/structures/lattice.js'

export const validStructureBounds = (bounds) =>
  Number.isInteger(bounds?.x0) &&
  Number.isInteger(bounds?.z0) &&
  Number.isInteger(bounds?.x1) &&
  Number.isInteger(bounds?.z1) &&
  bounds.x0 <= bounds.x1 &&
  bounds.z0 <= bounds.z1

// Build the layered-audit box from the structure selected in the map. A tall
// volume is audited as one object: all of its floors and both participant
// chunks are included even when the current viewport clips an edge. Without a
// selection the historical current-floor +/-1 stair audit remains useful.
export function multilevelAuditBox(structure, c0x, c1x, c0z, c1z, floor) {
  let x0 = c0x
  let x1 = c1x
  let z0 = c0z
  let z1 = c1z
  let y0 = floor - 1
  let y1 = floor + 1

  if (
    structure?.hasRoom &&
    Number.isInteger(structure.baseCy) &&
    Number.isInteger(structure.topCy) &&
    structure.baseCy <= structure.topCy
  ) {
    y0 = structure.baseCy
    y1 = structure.topCy
    const participants = Array.isArray(structure.participants)
      ? structure.participants
      : []
    if (participants.length > 0) {
      for (const participant of participants) {
        if (!Number.isInteger(participant?.cx) || !Number.isInteger(participant?.cz)) continue
        x0 = Math.min(x0, participant.cx)
        x1 = Math.max(x1, participant.cx)
        z0 = Math.min(z0, participant.cz)
        z1 = Math.max(z1, participant.cz)
      }
    } else if (validStructureBounds(structure.globalBounds)) {
      x0 = Math.min(x0, Math.floor(structure.globalBounds.x0 / CHUNK))
      x1 = Math.max(x1, Math.floor(structure.globalBounds.x1 / CHUNK))
      z0 = Math.min(z0, Math.floor(structure.globalBounds.z0 / CHUNK))
      z1 = Math.max(z1, Math.floor(structure.globalBounds.z1 / CHUNK))
    }
  }

  return {
    x0,
    y0,
    z0,
    nx: x1 - x0 + 1,
    ny: y1 - y0 + 1,
    nz: z1 - z0 + 1,
  }
}

export function structureAtCell(structures, gx, gz, floor) {
  if (!Number.isInteger(gx) || !Number.isInteger(gz) || !Number.isInteger(floor)) return null
  for (const structure of structures) {
    const bounds = structure?.globalBounds
    if (
      structure?.hasRoom &&
      validStructureBounds(bounds) &&
      floor >= structure.baseCy &&
      floor <= structure.topCy &&
      gx >= bounds.x0 &&
      gx <= bounds.x1 &&
      gz >= bounds.z0 &&
      gz <= bounds.z1
    ) return structure
  }
  return null
}

export function formatMultilevelStructure(structures, selected, source = 'visible') {
  if (structures.length === 0) return 'visible 0 · current —'
  const structure = selected ?? structures[0]
  const levels = Number.isInteger(structure.levelCount)
    ? structure.levelCount
    : structure.topCy - structure.baseCy + 1
  const bridges = structure.bridgeLevels?.length
    ? structure.bridgeLevels.join(',')
    : 'none'
  return `visible ${structures.length} · ${source} #${structure.id} ${structure.kind} · cy ${structure.baseCy}…${structure.topCy} · ${levels} levels · bridges ${bridges}`
}

export function formatMultilevelAudit(audit) {
  if (!audit) return 'off'
  return `struct ${audit.multilevelStructures ?? 0} · pairs ${audit.multilevelPairs ?? 0} · slices ${audit.multilevelSlices ?? 0} · mismatch ${audit.mismatchedMultilevelDescriptors ?? 0} · bad room/struct ${audit.invalidMultilevelRooms ?? 0}/${audit.invalidMultilevelStructures ?? 0} · orphan ${audit.orphanedMultilevelHalves ?? 0} · stray ${audit.strayWallFeatures ?? 0} · missing ${audit.missingMultilevelSlices ?? 0} · seams ${audit.closedBridgeSeams ?? 0}`
}

// --- Family palettes -------------------------------------------------------

export const ZONE_TINT = {
  [ZONE_OFFICE]: 'rgba(150,90,40,.10)',
  [ZONE_PILLARS]: 'rgba(70,120,140,.09)',
  [ZONE_WAREHOUSE]: 'rgba(120,110,60,.06)',
  [ZONE_SEWER]: 'rgba(70,140,90,.10)',
}

export const STRUCTURE_FAMILY_COLORS = {
  [MAP_FAMILY_OFFICE]: '#d8b24a',
  [MAP_FAMILY_SEWER]: '#7fbf8f',
  [MAP_FAMILY_TOWER]: '#7fd0e8',
  [MAP_FAMILY_LATTICE]: '#c884e0',
}

export const SPACE_ROLE_PALETTE = {
  [SPACE_ROLE_MEETING]: '#7fbfff',
  [SPACE_ROLE_BREAK]: '#7fff9f',
  [SPACE_ROLE_COPY]: '#ffd27f',
  [SPACE_ROLE_ARCHIVE]: '#d0aa58',
  [SPACE_ROLE_SERVER]: '#ff7f7f',
  [SPACE_ROLE_STORAGE]: '#b09fff',
  [SPACE_ROLE_LIBRARY]: '#8fbf6f',
  [SPACE_ROLE_OFFICE]: '#9fb8d0',
  [SPACE_ROLE_LOUNGE]: '#e09fb8',
}

// Deterministic hashed hue per spaceId (Knuth multiplicative hash) — stable
// across frames, floors, and LIVE/EXPLORE so a space keeps its color.
export function spaceIdColor(id) {
  return `hsla(${((id * 2654435761) >>> 0) % 360}, 65%, 55%, .28)`
}

export const LATTICE_EDGE_COLORS = {
  backbone: '#8fd0c0',
  spine: '#f0e08a',
  cycle: '#d0aa58',
  vertical: '#c884e0',
}

// --- Family formatters -----------------------------------------------------

// EXPLORE-mode config for the family segmented control. Unknown/disabled
// selections fall back to office exactly like the app-side ?family= boundary.
export function exploreConfigForFamily(family) {
  return worldConfigForFamilyOrOffice(family).config
}

// Family-aware replacement for the multilevel readout: office keeps the
// historical string; tower/lattice surface their own descriptor anatomy.
export function formatStructureDetail(structures, selected, source = 'visible') {
  if (structures.length === 0) return 'visible 0 · current —'
  const structure = selected ?? structures[0]
  const kind = structureKind(structure)
  if (kind === TOWER_STRUCTURE_KIND) {
    const deck = structure.decks?.[0]
    return `visible ${structures.length} · ${source} #${structure.id} ${structure.kind} · cy ${structure.baseCy}…${structure.topCy} · deck cy${deck?.levelCy ?? '—'} ${deck?.globalCells?.length ?? 0}c axis ${structure.bridgeAxis ?? '—'} · sockets ${structure.landmarkSockets?.length ?? 0} · vlinks ${structure.verticalLinks?.length ?? 0}`
  }
  if (kind === LATTICE_STRUCTURE_KIND) {
    const roles = { backbone: 0, spine: 0, cycle: 0, vertical: 0 }
    for (const edge of structure.edges ?? []) {
      if (roles[edge.role] !== undefined) roles[edge.role]++
    }
    return `visible ${structures.length} · ${source} #${structure.id} ${structure.kind} · cy ${structure.baseCy}…${structure.topCy} · anchors ${structure.anchors?.length ?? 0} · edges bb${roles.backbone} sp${roles.spine} cy${roles.cycle} vt${roles.vertical}`
  }
  return formatMultilevelStructure(structures, selected, source)
}

const countGroup = (label, counts) => {
  const parts = Object.entries(counts ?? {})
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key} ${count}`)
  return parts.length ? `${label} ${parts.join(' · ')}` : null
}

export function formatFamilyCounts(familyAudit) {
  if (!familyAudit) return 'off'
  const groups = [
    countGroup('fam', familyAudit.familyCounts),
    countGroup('kind', familyAudit.kindCounts),
    countGroup('lm', familyAudit.landmarkKindCounts),
  ].filter(Boolean)
  return groups.length ? groups.join(' | ') : 'none'
}

export function formatFamilyFailureSummary(audit) {
  if (!audit) return 'off'
  const reasons = audit.details?.familyAuditFailures?.length ?? 0
  return `adapters ${audit.familyAdapterFailures ?? 0} fam / ${audit.kindAdapterFailures ?? 0} kind · desc ${audit.familyDescriptorFailures ?? 0} · reasons ${reasons}`
}

export function formatLatticeMetrics(metrics) {
  if (!metrics || !Number.isInteger(metrics.anchorCount)) return '—'
  return `anchors ${metrics.anchorCount} · cover ${metrics.floorCoverage} · hbridges ${metrics.horizontalBridges} · vlinks ${metrics.verticalConnectors} · exp ${metrics.defaultExposureM}/${metrics.maximumExposureM}m · cues ${metrics.minimumCombinedCueCells} · rooms ${metrics.enclosedRoomSlices}`
}

// Failure list for the collapsible panel block. Input arrives deduped and
// sorted from auditChunkFamilyRegistrations; keep it verbatim, capped.
export function listFamilyFailures(details, max = 10) {
  const failures = details?.familyAuditFailures ?? []
  const lines = failures
    .slice(0, max)
    .map(({ family, kind, reason }) => `${family ?? '—'}:${kind ?? '—'} ${reason}`)
  if (failures.length > max) lines.push(`+${failures.length - max} more`)
  return lines
}

const CELL_KIND_LABEL = {
  [CELL_OPEN]: 'open',
  [CELL_ROOM]: 'room',
  [CELL_CORRIDOR]: 'corridor',
  [CELL_LOBBY]: 'lobby',
  [CELL_STAIR]: 'stair',
  [CELL_ATRIUM]: 'atrium',
  [CELL_VOID]: 'void',
  [CELL_BRIDGE]: 'bridge',
}

const SPACE_ROLE_LABEL = {
  [SPACE_ROLE_NONE]: null,
  [SPACE_ROLE_MEETING]: 'meeting',
  [SPACE_ROLE_BREAK]: 'break',
  [SPACE_ROLE_COPY]: 'copy',
  [SPACE_ROLE_ARCHIVE]: 'archive',
  [SPACE_ROLE_SERVER]: 'server',
  [SPACE_ROLE_STORAGE]: 'storage',
  [SPACE_ROLE_LIBRARY]: 'library',
  [SPACE_ROLE_OFFICE]: 'office',
  [SPACE_ROLE_LOUNGE]: 'lounge',
}

// Public accessor for the role vocabulary (label painters, tests).
export const roomRoleLabel = (role) => SPACE_ROLE_LABEL[role] ?? null

// One label per visible named room. Cells carrying a SPACE_ROLE_* byte are
// grouped by space id, then split into 4-connected clusters: a room crossing
// a chunk seam labels ONCE (its cells share the id and touch), while two
// disjoint rooms that happen to share an id (space ids are only
// district-unique) label separately. The anchor is the cluster's average
// global cell coordinate. Input: [{data}] — ChunkData-bearing entries, as
// drawn by the caller (any source, LIVE or EXPLORE).
export function collectRoomLabels(entries) {
  const bySpace = new Map() // spaceId -> Map<'gx,gz', {gx, gz, role}>
  for (const { data } of entries) {
    if (!data) continue
    const baseGX = data.cx * CHUNK
    const baseGZ = data.cz * CHUNK
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const role = data.spaceRole[lz * CHUNK + lx]
        if (!role) continue
        const id = data.spaceId[lz * CHUNK + lx]
        let cells = bySpace.get(id)
        if (!cells) bySpace.set(id, (cells = new Map()))
        cells.set(`${baseGX + lx},${baseGZ + lz}`, { gx: baseGX + lx, gz: baseGZ + lz, role })
      }
    }
  }
  const labels = []
  for (const cells of bySpace.values()) {
    const unseen = new Set(cells.keys())
    while (unseen.size) {
      const queue = [unseen.values().next().value]
      unseen.delete(queue[0])
      const cluster = []
      let role = 0
      while (queue.length) {
        const cell = cells.get(queue.pop())
        cluster.push(cell)
        role = cell.role
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nk = `${cell.gx + dx},${cell.gz + dz}`
          if (unseen.delete(nk)) queue.push(nk)
        }
      }
      labels.push({
        gx: cluster.reduce((sum, c) => sum + c.gx, 0) / cluster.length,
        gz: cluster.reduce((sum, c) => sum + c.gz, 0) / cluster.length,
        role,
        cells: cluster.length,
      })
    }
  }
  return labels
}

// One-line cursor description of a hovered cell: semantic kind, space
// ownership, and — through the validated adapter path only — the death plane
// depth when the cell drops into a lethal void.
export function describeCell(data, lx, lz) {
  if (!data || lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK) return ''
  const i = lz * CHUNK + lx
  const parts = [CELL_KIND_LABEL[data.cellKind[i]] ?? `kind ${data.cellKind[i]}`]
  const space = data.spaceId[i]
  if (space) {
    const role = SPACE_ROLE_LABEL[data.spaceRole[i]]
    parts.push(`space ${space}${role ? ` ${role}` : ''}`)
  }
  const structure = data.structure
  if (structure?.hasRoom) {
    parts.push(`#${structure.id}`)
    const adapter = structureAdapterFor(structure)
    const hardVoid = adapter?.hardVoidAt(data, lx, lz)
    if (Number.isInteger(hardVoid?.deathYmm)) {
      parts.push(`deathY ${(hardVoid.deathYmm / 1000).toFixed(1)}m`)
    }
  }
  return parts.join(' · ')
}
