// Canvas painters for the family-aware layers of the world debug map. Each
// painter takes a small `view` handle built by makeView and reads only
// ChunkData / canonical descriptors — never engine.cm — so LIVE and EXPLORE
// render identically from whatever data source the tool resolves.
import { CELL, CHUNK, CHUNK_WORLD } from '../world/constants.js'
import { CELL_ATRIUM, CELL_BRIDGE } from '../world/mapTypes.js'
import { auditLethalVoidHalf } from '../world/familyAudit.js'
import { structureFamily, structureKind } from '../world/structureContracts.js'
import { TOWER_STRUCTURE_KIND } from '../world/tower.js'
import { LATTICE_STRUCTURE_KIND } from '../world/lattice.js'
import {
  LATTICE_EDGE_COLORS,
  SPACE_ROLE_PALETTE,
  STRUCTURE_FAMILY_COLORS,
  ZONE_TINT,
  spaceIdColor,
} from './mapInspect.js'

export function makeView(tool) {
  return {
    ctx: tool.ctx,
    scale: tool.view.scale,
    floor: tool.floor,
    sx: (wx) => tool._sx(wx),
    sy: (wz) => tool._sy(wz),
  }
}

// The lethal halves are validated ONCE per chunk per frame: the per-cell
// adapter path (lethalVoidCellAt) re-validates the whole descriptor on every
// call, far too hot for a cell loop. A half that fails validation is itself a
// bug — its cells paint orange instead of disappearing.
function lethalHalves(d) {
  const halves = []
  for (const dir of ['down', 'up']) {
    const half = dir === 'down' ? d.lethalVoidDown : d.lethalVoidUp
    if (!half || !Array.isArray(half.cells)) continue
    halves.push({ dir, half, ok: auditLethalVoidHalf(d, dir).length === 0 })
  }
  return halves
}

function chunkParticipant(d, ccx, ccz) {
  const structure = d.multilevelStructure
  if (!structure?.hasRoom) return null
  const participates = Array.isArray(structure.participants) &&
    structure.participants.some((p) => p.cx === ccx && p.cz === ccz)
  return participates ? structure : null
}

// One merged pass over a chunk's cells: the selected fill mode underneath,
// then holes/bridges/atria, then the lethal-void layer on top.
export function paintCellOverlays(view, d, ccx, ccz, { fillMode = 'zones', lethal = true } = {}) {
  const { ctx, scale, sx, sy } = view
  const ox = ccx * CHUNK_WORLD
  const oz = ccz * CHUNK_WORLD
  const cellPx = CELL * scale

  if (fillMode === 'zones') {
    ctx.fillStyle = ZONE_TINT[d.zone] || 'rgba(120,110,60,.05)'
    ctx.fillRect(sx(ox), sy(oz), CHUNK_WORLD * scale, CHUNK_WORLD * scale)
  } else if (fillMode === 'owner') {
    const structure = chunkParticipant(d, ccx, ccz)
    if (structure) {
      ctx.globalAlpha = 0.12
      ctx.fillStyle = STRUCTURE_FAMILY_COLORS[structureFamily(structure)] ?? '#d8b24a'
      ctx.fillRect(sx(ox), sy(oz), CHUNK_WORLD * scale, CHUNK_WORLD * scale)
      ctx.globalAlpha = 1
    }
  }

  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const x = sx(ox + lx * CELL)
      const y = sy(oz + lz * CELL)
      const i = lz * CHUNK + lx
      if (fillMode === 'spaceId' && d.spaceId[i]) {
        ctx.fillStyle = spaceIdColor(d.spaceId[i])
        ctx.fillRect(x, y, cellPx, cellPx)
      } else if (fillMode === 'role' && SPACE_ROLE_PALETTE[d.spaceRole[i]]) {
        ctx.globalAlpha = 0.25
        ctx.fillStyle = SPACE_ROLE_PALETTE[d.spaceRole[i]]
        ctx.fillRect(x, y, cellPx, cellPx)
        ctx.globalAlpha = 1
      }

      // Current-floor surface: void cells stay dark; retained decks are
      // highlighted so a malformed/floating bridge is obvious; atrium halls
      // get a faint warm wash so tall rooms read against plain floor.
      if (d.hasFloorHole(lx, lz)) {
        ctx.fillStyle = 'rgba(4,4,3,.72)'
        ctx.fillRect(x, y, cellPx, cellPx)
      } else if (d.cellKind[i] === CELL_BRIDGE) {
        ctx.fillStyle = 'rgba(120,210,190,.28)'
        ctx.fillRect(x, y, cellPx, cellPx)
      } else if (d.cellKind[i] === CELL_ATRIUM) {
        ctx.fillStyle = 'rgba(216,178,74,.10)'
        ctx.fillRect(x, y, cellPx, cellPx)
      }
    }
  }

  if (!lethal) return
  for (const { dir, half, ok } of lethalHalves(d)) {
    for (const cell of half.cells) {
      const x = sx(ox + cell.lx * CELL)
      const y = sy(oz + cell.lz * CELL)
      if (!ok) {
        // Broken half: scream, whatever its direction.
        ctx.fillStyle = 'rgba(255,140,0,.45)'
        ctx.fillRect(x, y, cellPx, cellPx)
      } else if (dir === 'down') {
        // Step here on this floor and you fall to the death plane.
        ctx.fillStyle = 'rgba(220,40,40,.40)'
        ctx.fillRect(x, y, cellPx, cellPx)
        ctx.strokeStyle = 'rgba(220,40,40,.8)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x, y + cellPx)
        ctx.lineTo(x + cellPx, y)
        ctx.stroke()
      } else {
        // Lethal shaft opens in this ceiling (falls arrive from above).
        ctx.strokeStyle = 'rgba(220,40,40,.55)'
        ctx.lineWidth = 1
        ctx.setLineDash([2, 2])
        ctx.strokeRect(x + 0.5, y + 0.5, cellPx - 1, cellPx - 1)
        ctx.setLineDash([])
      }
    }
  }
}

// Sewer module graph: solid tree edges, dashed loop closures, a square on the
// trunk root. Modules live on chunk-local cells; edges are index pairs.
export function paintSewerGraph(view, d, ccx, ccz) {
  const desc = d.sewerDescriptor
  if (!desc?.modules?.length) return
  const { ctx, sx, sy } = view
  const ox = ccx * CHUNK_WORLD
  const oz = ccz * CHUNK_WORLD
  const px = (m) => sx(ox + (m.lx + 0.5) * CELL)
  const pz = (m) => sy(oz + (m.lz + 0.5) * CELL)

  const strokeEdges = (edges, dashed) => {
    if (!edges?.length) return
    ctx.strokeStyle = 'rgba(127,191,143,.75)'
    ctx.lineWidth = 1
    ctx.setLineDash(dashed ? [3, 3] : [])
    ctx.beginPath()
    for (const { a, b } of edges) {
      const ma = desc.modules[a]
      const mb = desc.modules[b]
      if (!ma || !mb) continue
      ctx.moveTo(px(ma), pz(ma))
      ctx.lineTo(px(mb), pz(mb))
    }
    ctx.stroke()
    ctx.setLineDash([])
  }
  strokeEdges(desc.treeEdges, false)
  strokeEdges(desc.loopEdges, true)

  if (desc.trunkRoot) {
    ctx.fillStyle = 'rgba(127,191,143,.9)'
    const x = sx(ox + (desc.trunkRoot.lx + 0.5) * CELL)
    const y = sy(oz + (desc.trunkRoot.lz + 0.5) * CELL)
    ctx.fillRect(x - 2, y - 2, 4, 4)
  }
}

function paintTowerStructure(view, structure) {
  const { ctx, floor, scale, sx, sy } = view
  const color = STRUCTURE_FAMILY_COLORS.tower
  const deck = structure.decks?.[0]
  if (deck?.globalCells?.length) {
    ctx.globalAlpha = deck.levelCy === floor ? 0.5 : 0.18
    ctx.fillStyle = color
    for (const cell of deck.globalCells) {
      ctx.fillRect(sx(cell.gx * CELL), sy(cell.gz * CELL), CELL * scale, CELL * scale)
    }
    ctx.globalAlpha = 1
  }
  for (const socket of structure.landmarkSockets ?? []) {
    if (socket.cy !== floor) continue
    ctx.fillStyle = color
    ctx.font = '9px ui-monospace, monospace'
    ctx.fillText(
      (socket.kind?.[0] ?? '?').toUpperCase(),
      sx((socket.gx + 0.2) * CELL),
      sy((socket.gz + 0.85) * CELL)
    )
  }
}

function paintLatticeStructure(view, structure) {
  const { ctx, floor, scale, sx, sy } = view
  const anchorById = new Map((structure.anchors ?? []).map((a) => [a.id, a]))

  for (const edge of structure.edges ?? []) {
    const a = anchorById.get(edge.a)
    const b = anchorById.get(edge.b)
    if (!a || !b) continue
    const onFloor = a.levelCy === floor || b.levelCy === floor
    ctx.strokeStyle = LATTICE_EDGE_COLORS[edge.role] ?? '#c884e0'
    ctx.globalAlpha = onFloor ? 0.9 : 0.3
    ctx.lineWidth = edge.role === 'backbone' ? 1.6 : 1
    ctx.setLineDash(edge.role === 'vertical' ? [3, 3] : [])
    ctx.beginPath()
    ctx.moveTo(sx((a.gx + 0.5) * CELL), sy((a.gz + 0.5) * CELL))
    ctx.lineTo(sx((b.gx + 0.5) * CELL), sy((b.gz + 0.5) * CELL))
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1

  const r = Math.max(2, Math.min(5, scale * 0.9))
  for (const anchor of structure.anchors ?? []) {
    const x = sx((anchor.gx + 0.5) * CELL)
    const y = sy((anchor.gz + 0.5) * CELL)
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    if (anchor.levelCy === floor) {
      ctx.fillStyle = STRUCTURE_FAMILY_COLORS.lattice
      ctx.fill()
    } else {
      ctx.strokeStyle = STRUCTURE_FAMILY_COLORS.lattice
      ctx.lineWidth = 1
      ctx.stroke()
    }
    // Authored non-default exposure: this anchor's cells fall further before
    // the death plane — ring it in warning red.
    if (anchor.exposureM != null) {
      ctx.beginPath()
      ctx.arc(x, y, r + 2, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,90,74,.9)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }
}

function paintBounds(view, structure, pinned) {
  const bounds = structure.globalBounds
  if (!Number.isInteger(bounds?.x0)) return
  const { ctx, scale, sx, sy } = view
  const color = STRUCTURE_FAMILY_COLORS[structureFamily(structure)] ?? '#d8b24a'
  const x = sx(bounds.x0 * CELL)
  const y = sy(bounds.z0 * CELL)
  const w = (bounds.x1 - bounds.x0 + 1) * CELL * scale
  const h = (bounds.z1 - bounds.z0 + 1) * CELL * scale
  ctx.strokeStyle = color
  ctx.lineWidth = pinned ? 2.5 : 1
  ctx.strokeRect(x, y, w, h)
  if (scale > 3) {
    ctx.fillStyle = color
    ctx.font = '10px ui-monospace, monospace'
    ctx.fillText(`#${structure.id} ${structure.kind}`, x + 3, y - 3)
  }
}

// Family dispatch over the deduped visible structures. Office multilevel keeps
// its existing cell-level rendering (void/bridge overlays) — only tall
// non-office families add descriptor glyphs on top of the bounds outline.
export function paintStructures(view, structures, pinned = null) {
  for (const structure of structures) {
    const kind = structureKind(structure)
    if (kind === TOWER_STRUCTURE_KIND) paintTowerStructure(view, structure)
    else if (kind === LATTICE_STRUCTURE_KIND) paintLatticeStructure(view, structure)
    paintBounds(view, structure, pinned?.id === structure.id)
  }
}
