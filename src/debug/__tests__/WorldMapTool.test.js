import { describe, expect, it } from 'vitest'
import {
  formatMultilevelAudit,
  formatMultilevelStructure,
  multilevelAuditBox,
  structureAtCell,
} from '../WorldMapTool.js'

const structure = Object.freeze({
  id: 173,
  hasRoom: true,
  kind: 'bridged',
  baseCy: -12,
  topCy: -3,
  levelCount: 10,
  bridgeLevels: [-11, -9, -7, -5, -3],
  participants: [
    { cx: -5, cz: 2 },
    { cx: -4, cz: 2 },
  ],
  globalBounds: { x0: -69, z0: 31, x1: -48, z1: 36 },
})

describe('WorldMapTool multilevel diagnostics', () => {
  it('audits a selected ten-level structure from canonical base through top', () => {
    expect(multilevelAuditBox(structure, -2, 2, -1, 1, -7)).toEqual({
      x0: -5,
      y0: -12,
      z0: -1,
      nx: 8,
      ny: 10,
      nz: 4,
    })
  })

  it('keeps the neighboring-three-floor audit when no structure is selected', () => {
    expect(multilevelAuditBox(null, -2, 2, -1, 1, 6)).toEqual({
      x0: -2,
      y0: 5,
      z0: -1,
      nx: 5,
      ny: 3,
      nz: 3,
    })
  })

  it('selects only a footprint cell on one of the structure floors', () => {
    expect(structureAtCell([structure], -60, 33, -7)).toBe(structure)
    expect(structureAtCell([structure], -70, 33, -7)).toBeNull()
    expect(structureAtCell([structure], -60, 33, -2)).toBeNull()
  })

  it('shows identity, kind, full height, bridge levels, and audit counters', () => {
    expect(formatMultilevelStructure([structure], structure, 'cursor')).toBe(
      'visible 1 · cursor #173 bridged · cy -12…-3 · 10 levels · bridges -11,-9,-7,-5,-3'
    )
    expect(formatMultilevelAudit({
      multilevelStructures: 1,
      multilevelPairs: 18,
      multilevelSlices: 36,
      mismatchedMultilevelDescriptors: 0,
      invalidMultilevelRooms: 0,
      invalidMultilevelStructures: 0,
      orphanedMultilevelHalves: 0,
      strayWallFeatures: 0,
      missingMultilevelSlices: 0,
      closedBridgeSeams: 0,
    })).toBe(
      'struct 1 · pairs 18 · slices 36 · mismatch 0 · bad room/struct 0/0 · orphan 0 · stray 0 · missing 0 · seams 0'
    )
  })
})
