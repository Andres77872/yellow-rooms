import { describe, expect, it } from 'vitest'
import { solidChunk, isSolidMassChunk } from '../solidChunk.js'
import { DEFAULT_WORLD_CONFIG } from '../../config.js'
import { WORLD_GEN_VERSION } from '../../constants.js'
import { COLUMN_STANDARD } from '../../mapTypes.js'
import { forcedFamilyConfig } from '../../families/forced.js'
import { familyGenerator } from '../../families/generators.js'

// §6.7 step 1 / §9.6a: the whole-chunk solid mass a liminal family returns
// for a 'solid' footprint or an out-of-range tile key.
describe('tiles/solidChunk', () => {
  it('is all-standard mass with worldSeed and version set', () => {
    const data = solidChunk(-5, 3, -2, 7, DEFAULT_WORLD_CONFIG, 'stairwell')
    expect([data.cx, data.cy, data.cz]).toEqual([3, -2, 7])
    expect(data.worldSeed).toBe(-5 >>> 0)
    expect(data.version).toBe(WORLD_GEN_VERSION)
    expect(data.mapFamily).toBe('stairwell')
    expect(data.cols.every((c) => c === COLUMN_STANDARD)).toBe(true)
    expect(isSolidMassChunk(data)).toBe(true)
  })

  it('takes the explicit district (tile key {tx, tz}) when given', () => {
    const data = solidChunk(1, 9, 0, -9, DEFAULT_WORLD_CONFIG, 'babel', { district: { dx: 2, dz: -3 } })
    expect(data.district).toEqual({ dx: 2, dz: -3 })
  })

  it('derives the district from the family TILE when there is no tile key', () => {
    const tile = { w: 4, d: 4 }
    expect(solidChunk(1, 0, 0, 0, DEFAULT_WORLD_CONFIG, 'stairwell', { tile }).district).toEqual({ dx: 0, dz: 0 })
    expect(solidChunk(1, 7, 99, -1, DEFAULT_WORLD_CONFIG, 'stairwell', { tile }).district).toEqual({ dx: 1, dz: -1 })
    expect(solidChunk(1, -4, 0, -5, DEFAULT_WORLD_CONFIG, 'stairwell', { tile }).district).toEqual({ dx: -1, dz: -2 })
    expect(solidChunk(1, 5, 0, 5, DEFAULT_WORLD_CONFIG, 'x', { tile: { w: 2, d: 3 } }).district).toEqual({ dx: 2, dz: 1 })
    // An explicit district wins over the derived one.
    expect(solidChunk(1, 7, 0, 7, DEFAULT_WORLD_CONFIG, 'x', { tile, district: { dx: 9, dz: 9 } }).district)
      .toEqual({ dx: 9, dz: 9 })
  })

  it('works with every liminal generator TILE and the forced config version', () => {
    for (const id of ['stairwell', 'nightlot', 'house']) {
      const gen = familyGenerator(id)
      const config = forcedFamilyConfig(id)
      const data = solidChunk(42, -1, 0, -1, config, id, { tile: gen.tile })
      expect(data.version).toBe(config.version)
      expect(data.district).toEqual({ dx: Math.floor(-1 / gen.tile.w), dz: Math.floor(-1 / gen.tile.d) })
    }
  })

  it('leaves district null with neither a district nor a usable tile', () => {
    expect(solidChunk(1, 3, 0, 3, DEFAULT_WORLD_CONFIG, 'x').district).toBeNull()
    expect(solidChunk(1, 3, 0, 3, DEFAULT_WORLD_CONFIG, 'x', { tile: { w: 0, d: 4 } }).district).toBeNull()
  })

  it('isSolidMassChunk rejects any walkable column or carried record', () => {
    const open = solidChunk(1, 0, 0, 0, DEFAULT_WORLD_CONFIG, 'x')
    open.cols[17] = 0
    expect(isSolidMassChunk(open)).toBe(false)
    const lamp = solidChunk(1, 0, 0, 0, DEFAULT_WORLD_CONFIG, 'x')
    lamp.lamps.push({ lx: 1, lz: 1 })
    expect(isSolidMassChunk(lamp)).toBe(false)
    expect(isSolidMassChunk(null)).toBe(false)
  })
})
