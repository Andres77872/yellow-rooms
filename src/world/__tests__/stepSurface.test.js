import { describe, expect, it } from 'vitest'
import {
  SURFACE_CARPET,
  SURFACE_CONCRETE,
  SURFACE_DECK,
  SURFACE_TILE,
  resolveStepSurface,
} from '../stepSurface.js'
import { FAMILY_PALETTES } from '../familyPalette.js'
import {
  CELL_BRIDGE,
  CELL_CORRIDOR,
  CELL_ROOM,
  CELL_STAIR,
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_LIBRARY,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_SERVER,
} from '../mapTypes.js'

describe('resolveStepSurface', () => {
  it('maps each family base to its palette floor style', () => {
    expect(resolveStepSurface({ family: MAP_FAMILY_OFFICE })).toBe(SURFACE_CARPET)
    expect(resolveStepSurface({ family: MAP_FAMILY_HOTEL })).toBe(SURFACE_CARPET)
    expect(resolveStepSurface({ family: MAP_FAMILY_SEWER })).toBe(SURFACE_CONCRETE)
    expect(resolveStepSurface({ family: MAP_FAMILY_TOWER })).toBe(SURFACE_TILE)
    expect(resolveStepSurface({ family: MAP_FAMILY_LATTICE })).toBe(SURFACE_DECK)
  })

  it('falls back to the office base for unknown/missing family', () => {
    expect(resolveStepSurface({})).toBe(SURFACE_CARPET)
    expect(resolveStepSurface({ family: 'not-a-family' })).toBe(SURFACE_CARPET)
    expect(resolveStepSurface()).toBe(SURFACE_CARPET)
  })

  it('keeps the surface vocabulary in lockstep with the palette styles', () => {
    const known = new Set([SURFACE_CARPET, SURFACE_CONCRETE, SURFACE_TILE, SURFACE_DECK])
    for (const pal of Object.values(FAMILY_PALETTES)) {
      expect(known.has(pal.floor.style)).toBe(true)
    }
  })

  it('bares stair treads only under carpet families', () => {
    expect(
      resolveStepSurface({ family: MAP_FAMILY_OFFICE, cellKind: CELL_STAIR })
    ).toBe(SURFACE_CONCRETE)
    expect(
      resolveStepSurface({ family: MAP_FAMILY_HOTEL, cellKind: CELL_STAIR })
    ).toBe(SURFACE_CONCRETE)
    expect(
      resolveStepSurface({ family: MAP_FAMILY_TOWER, cellKind: CELL_STAIR })
    ).toBe(SURFACE_TILE)
    expect(
      resolveStepSurface({ family: MAP_FAMILY_LATTICE, cellKind: CELL_STAIR })
    ).toBe(SURFACE_DECK)
  })

  it('makes every bridge a metal deck', () => {
    for (const family of [MAP_FAMILY_OFFICE, MAP_FAMILY_TOWER, MAP_FAMILY_LATTICE]) {
      expect(resolveStepSurface({ family, cellKind: CELL_BRIDGE })).toBe(SURFACE_DECK)
    }
  })

  it('hard-floors wet/service rooms even in carpet families', () => {
    for (const spaceRole of [
      SPACE_ROLE_BATHROOM,
      SPACE_ROLE_KITCHEN,
      SPACE_ROLE_LAUNDRY,
      SPACE_ROLE_BREAK,
    ]) {
      expect(
        resolveStepSurface({ family: MAP_FAMILY_HOTEL, cellKind: CELL_ROOM, spaceRole })
      ).toBe(SURFACE_TILE)
    }
    expect(
      resolveStepSurface({
        family: MAP_FAMILY_OFFICE,
        cellKind: CELL_ROOM,
        spaceRole: SPACE_ROLE_SERVER,
      })
    ).toBe(SURFACE_DECK)
  })

  it('leaves ordinary roles on the family base', () => {
    for (const spaceRole of [SPACE_ROLE_MEETING, SPACE_ROLE_LIBRARY]) {
      expect(
        resolveStepSurface({ family: MAP_FAMILY_OFFICE, cellKind: CELL_ROOM, spaceRole })
      ).toBe(SURFACE_CARPET)
    }
    expect(
      resolveStepSurface({ family: MAP_FAMILY_OFFICE, cellKind: CELL_CORRIDOR })
    ).toBe(SURFACE_CARPET)
  })

  it('lets cell semantics beat role overrides (stairs in a tiled wing stay hard)', () => {
    expect(
      resolveStepSurface({
        family: MAP_FAMILY_OFFICE,
        cellKind: CELL_STAIR,
        spaceRole: SPACE_ROLE_BATHROOM,
      })
    ).toBe(SURFACE_CONCRETE)
  })
})
