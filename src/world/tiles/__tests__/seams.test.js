import { describe, expect, it, vi } from 'vitest'
import { CHUNK, ZONE_OFFICE, cIdx } from '../../constants.js'
import { ChunkData } from '../../ChunkData.js'
import { generateChunk } from '../../generate.js'
import { CELL_CORRIDOR, CELL_ROOM, COLUMN_STANDARD, PASSAGE_WALL, WALL_WINDOW } from '../../mapTypes.js'
import { familyGenerator } from '../../families/generators.js'
import { forcedFamilyConfig } from '../../families/forced.js'
import { FloorPlan } from '../floorPlan.js'
import { remassStampRing as kitRemass } from '../kit.js'
import { isMassCell, massLeakAudit, openOwnedSeam, portsAtOf, remassStampRing, seamPorts } from '../seams.js'
import { solidChunk } from '../solidChunk.js'
import { BORDER_DEPTH } from '../massMask.js'
import { TileCanvas } from '../TileCanvas.js'
import { cloneChunkData } from '../cloneChunk.js'
import { STUB_WORLD_ID } from '../../families/__tests__/stubWorld.js'

// STUB_WORLD_ID runs the §12.0 stub program in this file, whatever its real
// family has become (families/__tests__/stubWorld.js).
vi.mock('../../families/generators.js', (orig) =>
  import('../../families/__tests__/stubWorld.js').then((m) => m.mockGenerators(orig)))
vi.mock('../../families/planners.js', (orig) =>
  import('../../families/__tests__/stubWorld.js').then((m) => m.mockPlanners(orig)))

// The seam and perimeter contract (spec §6.8): ports per side, the owned
// seam opener, the ring re-mass (moved here from kit.js) and the mass leak
// audit over hand-built and stub-world windows.

const STUB = STUB_WORLD_ID
const stubGen = familyGenerator(STUB)
const stubConfig = forcedFamilyConfig(STUB)

const open = (cx, cy, cz, family = STUB) => new ChunkData(cx, cy, cz, ZONE_OFFICE, 28, family)
const mapOf = (...chunks) => {
  const m = new Map(chunks.map((d) => [`${d.cx},${d.cy},${d.cz}`, d]))
  return (cx, cy, cz) => m.get(`${cx},${cy},${cz}`) ?? null
}
const box = (x0, x1, z0 = 0, z1 = 0, y0 = 0, y1 = 0) => ({ x0, x1, z0, z1, y0, y1 })

describe('ports', () => {
  const gen = {
    ports: (seed, k, side, cy) => [{ a0: k.tx * 100 + k.tz * 10 + (side === 'west' ? 1 : 2), a1: cy + seed }],
  }

  it('seamPorts: west/north own, east/south are the neighbour tile\'s west/north', () => {
    const k = { tx: 3, tz: -2, band: 9 }
    expect(seamPorts(gen, 5, k, 'west', 1)).toEqual([{ a0: 281, a1: 6 }])
    expect(seamPorts(gen, 5, k, 'north', 1)).toEqual([{ a0: 282, a1: 6 }])
    expect(seamPorts(gen, 5, k, 'east', 1)).toEqual([{ a0: 381, a1: 6 }])
    expect(seamPorts(gen, 5, k, 'south', 1)).toEqual([{ a0: 292, a1: 6 }])
    expect(() => seamPorts(gen, 5, k, 'up', 1)).toThrow(/unknown side/)
  })

  it('portsAtOf: memoised, frozen, GLOBAL storey', () => {
    const at = portsAtOf(gen, 0, { tx: 0, tz: 0, band: 0 })
    const a = at('east', -2)
    expect(a).toEqual([{ a0: 101, a1: -2 }])
    expect(at('east', -2)).toBe(a)
    expect(Object.isFrozen(a)).toBe(true)
    expect(Object.isFrozen(a[0])).toBe(true)
  })

  it('the stub geometry declares 6..7 on storey 0 only', () => {
    expect(seamPorts(stubGen, 1, { tx: 4, tz: 4 }, 'south', 0)).toEqual([{ a0: 6, a1: 7 }])
    expect(seamPorts(stubGen, 1, { tx: 4, tz: 4 }, 'west', 1)).toEqual([])
  })
})

describe('openOwnedSeam', () => {
  it('opens the owned west/north line at walkable port cells only, at the GLOBAL storey', () => {
    const origin = { cx: 3, cy: 2, cz: -1 }
    const canvas = new TileCanvas({ family: STUB, origin })
    const plan = new FloorPlan({ x0: 0, z0: 0, x1: CHUNK - 1, z1: CHUNK - 1 })
    plan.rect({ x0: 0, z0: 5, x1: 6, z1: 8 }, CELL_CORRIDOR, 1) // reaches the west line at rows 5..8
    plan.rect({ x0: 5, z0: 0, x1: 8, z1: 6 }, CELL_CORRIDOR, 1) // reaches the north line at cols 5..8
    plan.compile(canvas, 0)
    expect(canvas.wallVAt(0, 0, 6).wall).toBe(1)
    expect(canvas.wallHAt(6, 0, 0).wall).toBe(1)
    const calls = []
    const ctx = {
      origin,
      notes: [],
      portsAt: (side, cy) => {
        calls.push([side, cy])
        return side === 'west' ? [{ a0: 6, a1: 7 }, { a0: 2, a1: 2 }] : [{ a0: 5, a1: 8 }]
      },
    }
    expect(openOwnedSeam(canvas, ctx, 0, 'west')).toBe(2)
    expect(openOwnedSeam(canvas, ctx, 0, 'north')).toBe(4)
    expect(calls).toEqual([['west', 2], ['north', 2]])
    expect(canvas.wallVAt(0, 0, 6).wall).toBe(0)
    expect(canvas.wallVAt(0, 0, 7).wall).toBe(0)
    expect(canvas.wallVAt(0, 0, 5).wall).toBe(1) // not a port
    expect(canvas.wallVAt(0, 0, 2).wall).toBe(0) // mass–mass line: never walled
    expect(ctx.notes).toEqual(['seam:port-blocked west 2 2']) // mass behind the port
    for (let x = 5; x <= 8; x++) expect(canvas.wallHAt(x, 0, 0).wall).toBe(0)
    expect(() => openOwnedSeam(canvas, ctx, 0, 'east')).toThrow(/west' or 'north/)
  })

  it('remassStampRing is one implementation, re-exported by kit.js', () => {
    expect(kitRemass).toBe(remassStampRing)
  })
})

describe('massLeakAudit', () => {
  it('an open chunk against a solid neighbour leaks on every row; owned walls seal it', () => {
    const a = open(0, 0, 0)
    const s = solidChunk(1, 1, 0, 0, stubConfig, STUB)
    let r = massLeakAudit(mapOf(a, s), box(0, 1))
    expect(r.leaks).toBe(CHUNK)
    expect(r.sealedMass).toBe(false)
    expect(r.details.leaks[0]).toMatchObject({ gx: CHUNK - 1, gz: 0, cy: 0, axis: 'v' })
    // The line belongs to the solid chunk (its West line): walls there seal.
    const sealed = cloneChunkData(s)
    for (let z = 0; z < CHUNK; z++) sealed.setV(0, z, 1, PASSAGE_WALL)
    r = massLeakAudit(mapOf(a, sealed), box(0, 1))
    expect(r.leaks).toBe(0)
    expect(r.sealedMass).toBe(true)
    expect(r.massEdges).toBe(CHUNK)
    // Rule 1: the kept chunk's east column as mass seals too.
    const b = open(0, 0, 0)
    for (let z = 0; z < CHUNK; z++) b.setCol(CHUNK - 1, z, COLUMN_STANDARD)
    for (let z = 0; z < CHUNK; z++) b.setV(CHUNK - 1, z, 1, PASSAGE_WALL)
    for (let z = 0; z < CHUNK; z++) b.setH(CHUNK - 1, z, 0)
    r = massLeakAudit(mapOf(b, s), box(0, 1))
    expect(r.leaks).toBe(0)
  })

  it('south/north boundaries and storeys are scanned; absent chunks are skipped', () => {
    const a = open(0, 0, 0)
    const s = solidChunk(1, 0, 0, 1, stubConfig, STUB)
    expect(massLeakAudit(mapOf(a, s), box(0, 0, 0, 1)).leaks).toBe(CHUNK)
    expect(massLeakAudit(mapOf(a), box(-1, 1, -1, 1)).leaks).toBe(0)
    const up = open(0, 1, 0)
    const solidUp = solidChunk(1, 1, 1, 0, stubConfig, STUB)
    expect(massLeakAudit(mapOf(a, s, up, solidUp), box(0, 1, 0, 1, 0, 1)).leaks).toBe(2 * CHUNK)
  })

  it('a free-standing pillar is not mass; a two-cell blob is', () => {
    const a = open(0, 0, 0)
    a.setCol(5, 5, COLUMN_STANDARD)
    expect(isMassCell(a, 5, 5)).toBe(true)
    expect(massLeakAudit(mapOf(a), box(0, 0)).leaks).toBe(0)
    a.setCol(6, 5, COLUMN_STANDARD)
    expect(massLeakAudit(mapOf(a), box(0, 0)).leaks).toBe(6)
    // A pillar on a room cell is never mass.
    const b = open(0, 0, 0)
    b.setCol(5, 5, COLUMN_STANDARD)
    b.setCol(6, 5, COLUMN_STANDARD)
    b.cellKind[cIdx(5, 5)] = CELL_ROOM
    b.cellKind[cIdx(6, 5)] = CELL_ROOM
    expect(isMassCell(b, 5, 5)).toBe(false)
    expect(massLeakAudit(mapOf(b), box(0, 0)).leaks).toBe(0)
  })

  it('see-through features on a boundary with a whole-solid chunk are counted', () => {
    const s = solidChunk(1, 0, 0, 0, stubConfig, STUB)
    const a = open(1, 0, 0)
    for (let z = 0; z < CHUNK; z++) a.setV(0, z, 1, PASSAGE_WALL, z < 3 ? WALL_WINDOW : undefined)
    const r = massLeakAudit(mapOf(s, a), box(0, 1))
    expect(r.leaks).toBe(0)
    expect(r.seeThroughToSolid).toBe(3)
  })

  it('glass looking through fewer than BORDER_DEPTH mass cells into a whole-solid chunk is counted (seeThroughThinMass)', () => {
    // West: solid chunk 0, then `mass` columns of mass in chunk 1 behind a
    // window line at lx = mass (z < 3 glazed, the rest plain walls).
    const westCase = (mass, plainAt = -1) => {
      const s = solidChunk(1, 0, 0, 0, stubConfig, STUB)
      const a = open(1, 0, 0)
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < mass; x++) a.setCol(x, z, COLUMN_STANDARD)
        a.setV(mass, z, 1, PASSAGE_WALL, z < 3 ? WALL_WINDOW : undefined)
        if (plainAt >= 0) a.setV(plainAt, z, 1, PASSAGE_WALL)
      }
      return massLeakAudit(mapOf(s, a), box(0, 1))
    }
    let r = westCase(2)
    expect(r.leaks).toBe(0)
    expect(r.seeThroughToSolid).toBe(0)
    expect(r.seeThroughThinMass).toBe(3)
    expect(r.details.seeThroughThinMass[0]).toEqual({ gx: CHUNK + 2, gz: 0, cy: 0, axis: 'v', look: 'west', mass: 2 })
    expect(r.solidChunks).toBe(1)
    expect(westCase(1).seeThroughThinMass).toBe(3)
    expect(westCase(BORDER_DEPTH - 1).seeThroughThinMass).toBe(3)
    // BORDER_DEPTH rows of mass keep their posts: not counted.
    expect(westCase(BORDER_DEPTH).seeThroughThinMass).toBe(0)
    // A plain wall inside the mass band ends the line of sight.
    expect(westCase(2, 1).seeThroughThinMass).toBe(0)
    // East: the line runs the other way; a south-facing pane is the H axis.
    const s = solidChunk(1, 2, 0, 0, stubConfig, STUB)
    const b = open(1, 0, 0)
    for (let z = 0; z < CHUNK; z++) {
      b.setCol(CHUNK - 1, z, COLUMN_STANDARD)
      b.setV(CHUNK - 1, z, 1, PASSAGE_WALL, z === 4 ? WALL_WINDOW : undefined)
    }
    r = massLeakAudit(mapOf(b, s), box(1, 2))
    expect(r.details.seeThroughThinMass).toEqual([{ gx: 2 * CHUNK - 1, gz: 4, cy: 0, axis: 'v', look: 'east', mass: 1 }])
    const n = solidChunk(1, 1, 0, 1, stubConfig, STUB)
    const c = open(1, 0, 0)
    for (let x = 0; x < CHUNK; x++) {
      for (const z of [CHUNK - 2, CHUNK - 1]) c.setCol(x, z, COLUMN_STANDARD)
      c.setH(x, CHUNK - 2, 1, PASSAGE_WALL, x === 7 ? WALL_WINDOW : undefined)
    }
    r = massLeakAudit(mapOf(c, n), box(1, 1, 0, 1))
    expect(r.details.seeThroughThinMass).toEqual([{ gx: CHUNK + 7, gz: CHUNK - 2, cy: 0, axis: 'h', look: 'south', mass: 2 }])
  })

  it('stub world: clean over a window crossing tiles and solid storeys', () => {
    const at = (cx, cy, cz) => generateChunk(3, cx, cy, cz, stubConfig)
    const r = massLeakAudit(at, box(-2, 2, -2, 2, -1, 1), { gen: stubGen, worldSeed: 3 })
    expect(r).toMatchObject({ leaks: 0, seals: 0, portViolations: 0, seeThroughToSolid: 0, seeThroughThinMass: 0, sealedMass: true })
    expect(r.massEdges).toBeGreaterThan(0)
    expect(r.solidChunks).toBeGreaterThan(0)
  })

  it('stub world: a walled port is a seal; a massed port cell is a port violation', () => {
    const a = generateChunk(3, 0, 0, 0, stubConfig)
    const b = cloneChunkData(generateChunk(3, 1, 0, 0, stubConfig))
    const opts = { gen: stubGen, worldSeed: 3 }
    expect(massLeakAudit(mapOf(a, b), box(0, 1), opts).seals).toBe(0)
    b.setV(0, 6, 1, PASSAGE_WALL)
    let r = massLeakAudit(mapOf(a, b), box(0, 1), opts)
    expect(r.seals).toBe(1)
    expect(r.details.seals).toEqual([{ gx: CHUNK, gz: 6, cy: 0, side: 'west' }])
    // Without the generator the port checks are off.
    expect(massLeakAudit(mapOf(a, b), box(0, 1)).seals).toBe(0)
    const c = cloneChunkData(generateChunk(3, 1, 0, 0, stubConfig))
    c.setCol(0, 7, COLUMN_STANDARD)
    c.cellKind[cIdx(0, 7)] = 0
    c.spaceId[cIdx(0, 7)] = 0
    r = massLeakAudit(mapOf(a, c), box(0, 1), opts)
    expect(r.portViolations).toBe(1)
    expect(r.details.portViolations[0]).toMatchObject({ gx: CHUNK, gz: 7, side: 'west', walkable: [true, false] })
  })
})
