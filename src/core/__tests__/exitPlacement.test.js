import { describe, expect, it } from 'vitest'
import {
  EXIT_FLOORS,
  EXIT_REACH,
  createExitPlacement,
  evaluateExit,
} from '../exitPlacement.js'
import { CHUNK, LAYER_H } from '../../world/constants.js'
import { DEFAULT_WORLD_CONFIG } from '../../world/config.js'
import { hashStr } from '../../world/core/hash.js'
import { generateChunk } from '../../world/generate.js'
import { chunkStairs, stairStrip } from '../../world/structures/slab.js'

const placement = (seedText, level) => {
  const worldSeed = hashStr(`${seedText}#${level}`)
  return createExitPlacement(seedText, level, worldSeed, DEFAULT_WORLD_CONFIG)
}

describe('cross-floor exit placement', () => {
  it('is deterministic and preserves the established seeded XZ chunks', () => {
    const cases = [
      ['alpha', 1, -3, -6],
      ['alpha', 2, -8, 6],
      ['lobby', 1, 5, -3],
      ['test', 7, -5, 9],
    ]
    for (const [seed, level, cx, cz] of cases) {
      const a = placement(seed, level)
      const b = placement(seed, level)
      expect(a).toEqual(b)
      expect([a.cx, a.cz]).toEqual([cx, cz])
    }
  })

  it('selects every objective on a non-zero floor within five layers', () => {
    const seen = new Set()
    for (let i = 0; i < 250; i++) {
      const exit = placement(`coverage-${i}`, (i % 10) + 1)
      expect(EXIT_FLOORS).toContain(exit.cy)
      expect(exit.cy).not.toBe(0)
      expect(exit.y).toBeCloseTo(exit.cy * LAYER_H + 1.35, 10)
      seen.add(exit.cy)
    }
    expect([...seen].sort((a, b) => a - b)).toEqual(EXIT_FLOORS)
  })

  it('keeps the exit cell walkable and clear of the selected floor stairs', () => {
    for (let i = 0; i < 60; i++) {
      const seedText = `walkable-${i}`
      const level = (i % 8) + 1
      const worldSeed = hashStr(`${seedText}#${level}`)
      const exit = createExitPlacement(seedText, level, worldSeed, DEFAULT_WORLD_CONFIG)
      const { up, down } = chunkStairs(
        worldSeed,
        exit.cx,
        exit.cz,
        exit.cy,
        DEFAULT_WORLD_CONFIG
      )
      const strips = [up, down]
        .filter((stair) => stair.hasStair)
        .flatMap((stair) => stairStrip(stair))

      expect(exit.lx).toBeGreaterThanOrEqual(3)
      expect(exit.lx).toBeLessThanOrEqual(CHUNK - 4)
      expect(exit.lz).toBeGreaterThanOrEqual(3)
      expect(exit.lz).toBeLessThanOrEqual(CHUNK - 4)
      for (const cell of strips) {
        const gap = Math.max(Math.abs(cell.lx - exit.lx), Math.abs(cell.lz - exit.lz))
        expect(gap).toBeGreaterThan(1)
      }

      const data = generateChunk(
        worldSeed,
        exit.cx,
        exit.cy,
        exit.cz,
        DEFAULT_WORLD_CONFIG,
        { lx: exit.lx, lz: exit.lz }
      )
      expect(data.exit).toEqual({ lx: exit.lx, lz: exit.lz })
      expect(data.hasFloorHole(exit.lx, exit.lz)).toBe(false)
    }
  })
})

describe('exit guidance and completion', () => {
  const target = { x: 12, z: -4 }

  it('reports signed floor guidance above and below the player', () => {
    const above = evaluateExit(target, 4, {
      pos: { x: 12, z: -4 },
      floor: 1,
      yaw: 0,
    })
    expect(above.info.floorDelta).toBe(3)
    expect(above.reached).toBe(false)

    const below = evaluateExit(target, -3, {
      pos: { x: 12, z: -4 },
      floor: 2,
      yaw: 0,
    })
    expect(below.info.floorDelta).toBe(-5)
    expect(below.reached).toBe(false)
  })

  it('requires both the objective floor and horizontal proximity', () => {
    const atExit = evaluateExit(target, -3, {
      pos: { x: 12, z: -4 },
      floor: -3,
      yaw: 0,
    })
    expect(atExit.info.dist).toBe(0)
    expect(atExit.reached).toBe(true)

    const tooFar = evaluateExit(target, -3, {
      pos: { x: 12 + EXIT_REACH, z: -4 },
      floor: -3,
      yaw: 0,
    })
    expect(tooFar.reached).toBe(false)
  })
})
