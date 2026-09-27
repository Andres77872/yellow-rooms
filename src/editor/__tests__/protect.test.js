import { describe, expect, it } from 'vitest'
import { CHUNK } from '../../world/constants.js'
import { hashStr } from '../../world/core/hash.js'
import { worldConfigForFamilyOrOffice } from '../../world/mapFamily.js'
import { CELL_BRIDGE, WALL_RAIL } from '../../world/mapTypes.js'
import { EditorMap } from '../EditorMap.js'
import {
  protectedCeilingReason,
  protectedCellReason,
  protectedEdgeReason,
  protectedRectReason,
} from '../protect.js'
import { discoverStructures, structureChunkCoords } from '../structureReview.js'
import { geometryFogDensity, previewChunkVisible } from '../ui/Preview3D.js'

function bridgedOffice() {
  const { config } = worldConfigForFamilyOrOffice('office')
  const seed = hashStr('a')
  const s = discoverStructures(seed, config, { x0: -6, x1: 6, z0: -6, z1: 6, y0: -2, y1: 20 })
    .filter((c) => c.kind === 'bridged')
    .sort((a, b) => (a.topCy - a.baseCy) - (b.topCy - b.baseCy))[0]
  const map = new EditorMap()
  map.bakeChunks({ seed, family: 'office', coords: structureChunkCoords(s, 1) })
  return { map, s }
}

describe('structure protection', () => {
  const { map, s } = bridgedOffice()
  const deck = s.decks[0]
  const cy = deck.levelCy
  const b = s.globalBounds
  const axisX = s.bridgeAxis === 'x'
  const mid = deck.globalCells[Math.floor(deck.globalCells.length / 2)]

  it('guards structure-owned cells and leaves ordinary fabric editable', () => {
    expect(map.cellAt(mid.gx, cy, mid.gz).kind).toBe(CELL_BRIDGE)
    expect(protectedCellReason(map, mid.gx, cy, mid.gz)).toBe('bridge deck')
    // The void beside the deck is an open slab.
    const voidCell = axisX ? { gx: mid.gx, gz: mid.gz + 1 } : { gx: mid.gx + 1, gz: mid.gz }
    expect(protectedCellReason(map, voidCell.gx, cy, voidCell.gz)).toBe('slab opening')
    // The atrium hall at the base.
    expect(protectedCellReason(map, b.x0, s.baseCy, b.z0)).toBe('atrium hall')
    // Well outside the volume: plain fabric.
    const far = { gx: s.participants[0].cx * CHUNK - 10, gz: s.participants[0].cz * CHUNK - 10 }
    expect(protectedCellReason(map, far.gx, s.baseCy, far.gz)).toBeNull()
    // The hall's ceiling is open; lamps cannot hang there.
    expect(protectedCeilingReason(map, b.x0, s.baseCy, b.z0)).toBe('open ceiling')
  })

  it('guards rails, deck edges and the rim of an opening', () => {
    // Longitudinal edge between two deck cells.
    const along = axisX
      ? protectedEdgeReason(map, 'v', mid.gx, mid.gz, cy)
      : protectedEdgeReason(map, 'h', mid.gx, mid.gz, cy)
    expect(along).toBe('bridge deck')
    // Flank of the deck: a guard rail over the drop.
    const flank = axisX
      ? { axis: 'h', gx: mid.gx, gz: mid.gz }
      : { axis: 'v', gx: mid.gx, gz: mid.gz }
    const e = flank.axis === 'v' ? map.wallVAt(flank.gx, cy, flank.gz) : map.wallHAt(flank.gx, cy, flank.gz)
    expect(e.feature).toBe(WALL_RAIL)
    expect(protectedEdgeReason(map, flank.axis, flank.gx, flank.gz, cy)).toBe('guard rail')
  })

  it('refuses a room rectangle overlapping the volume', () => {
    const hit = protectedRectReason(map, { x0: b.x0 - 2, z0: b.z0 - 2, x1: b.x0 + 1, z1: b.z0 + 1 }, s.baseCy)
    expect(hit?.reason).toBe('atrium hall')
  })
})

describe('3D preview helpers', () => {
  it('clips storeys for the cutaway modes', () => {
    expect([2, 3, 4].map((cy) => previewChunkVisible('all', cy, 3))).toEqual([true, true, true])
    expect([2, 3, 4].map((cy) => previewChunkVisible('below', cy, 3))).toEqual([true, true, false])
    expect([2, 3, 4].map((cy) => previewChunkVisible('floor', cy, 3))).toEqual([false, true, false])
  })

  it('keeps the historical haze at a 60-unit orbit and thins it further out', () => {
    expect(geometryFogDensity(60)).toBeCloseTo(0.008, 6)
    expect(geometryFogDensity(200)).toBeLessThan(0.003)
    expect(geometryFogDensity(5)).toBe(0.012)
  })
})
