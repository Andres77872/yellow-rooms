import { CHUNK, cIdx, hIdx, vIdx } from '../../constants.js'
import { CELL_BRIDGE, CELL_VOID } from '../../mapTypes.js'
import {
  CELL_CLASS_BRIDGE,
  CELL_CLASS_RING,
  CELL_CLASS_SOLID,
  analyzeCatalogDescriptor,
  catalogStructureSlice,
  isCatalogKind,
  isCatalogStructure,
  levelRaster,
} from './engine.js'

// Post-stamp oracle for catalog volumes (the counterpart of audit.js's office
// atrium oracle). Slices must equal the canonical projection of the chunk's
// descriptor; the stamped raster must hold exactly the descriptor's openings
// (holes on void cells only), label voids/decks, and guard every
// walkable/void edge on chunk-local lines.

const walkable = (c) => c === CELL_CLASS_RING || c === CELL_CLASS_SOLID || c === CELL_CLASS_BRIDGE

export function catalogDescriptorErrors(structure) {
  if (!isCatalogStructure(structure)) return ['catalog:not-catalog']
  return analyzeCatalogDescriptor(structure).reasons.map((r) => `catalog:${r}`)
}

// `role`: 'up' — the slice is data.structureUp (this storey is the lower one);
// 'down' — data.structureDown (this storey holds the openings).
export function catalogSliceErrors(data, slice, role) {
  const reasons = []
  if (!isCatalogKind(slice?.kind)) return ['catalog:slice-kind']
  const structure = data.structure
  if (!isCatalogStructure(structure) || structure.id !== slice.id) return ['catalog:slice-owner']
  const expected = catalogStructureSlice(structure, data.cx, data.cz, slice.lowerCy)
  if (slice !== expected && JSON.stringify(slice) !== JSON.stringify(expected)) reasons.push('catalog:slice-projection')
  if (role === 'up' && slice.lowerCy !== data.cy) reasons.push('catalog:slice-level')
  if (role === 'down' && slice.lowerCy !== data.cy - 1) reasons.push('catalog:slice-level')

  const k = slice.levelCy - structure.baseCy
  const raster = levelRaster(structure, k)
  const ox = data.cx * CHUNK
  const oz = data.cz * CHUNK
  const voids = new Set(slice.voidCells.map((c) => cIdx(c.lx, c.lz)))
  const stairRuns = new Set()
  for (const s of [data.stairUp, data.stairDown]) {
    for (const c of s?.run ?? []) stairRuns.add(cIdx(c.lx, c.lz))
  }
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const i = cIdx(lx, lz)
      const hole = role === 'up' ? data.hasCeilHole(lx, lz) : data.hasFloorHole(lx, lz)
      if (voids.has(i) !== hole && !stairRuns.has(i)) {
        reasons.push('catalog:hole-mask')
        lz = CHUNK
        break
      }
    }
  }
  if (role === 'down') {
    for (const c of slice.voidCells) {
      if (data.cellKind[cIdx(c.lx, c.lz)] !== CELL_VOID) reasons.push('catalog:void-kind')
      if (data.spaceId[cIdx(c.lx, c.lz)] !== structure.id) reasons.push('catalog:void-owner')
    }
    for (const c of slice.bridgeCells) {
      if (data.cellKind[cIdx(c.lx, c.lz)] !== CELL_BRIDGE) reasons.push('catalog:deck-kind')
    }
    // Guards: every chunk-local edge between a void cell and a walkable cell.
    for (const c of slice.voidCells) {
      const gx = ox + c.lx
      const gz = oz + c.lz
      const sides = [
        [c.lx >= 1, raster.at(gx - 1, gz), () => data.wallV[vIdx(c.lx, c.lz)]],
        [c.lx + 1 <= CHUNK - 1, raster.at(gx + 1, gz), () => data.wallV[vIdx(c.lx + 1, c.lz)]],
        [c.lz >= 1, raster.at(gx, gz - 1), () => data.wallH[hIdx(c.lx, c.lz)]],
        [c.lz + 1 <= CHUNK - 1, raster.at(gx, gz + 1), () => data.wallH[hIdx(c.lx, c.lz + 1)]],
      ]
      for (const [inChunk, cls, wall] of sides) {
        if (inChunk && walkable(cls) && !wall()) {
          reasons.push('catalog:unguarded-void')
          break
        }
      }
    }
  }
  return [...new Set(reasons)]
}

export function catalogPairErrors(lower, upper, roomUp, roomDown) {
  return [...new Set([
    ...catalogSliceErrors(lower, roomUp, 'up'),
    ...catalogSliceErrors(upper, roomDown, 'down'),
  ])]
}
